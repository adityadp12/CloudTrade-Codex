import crypto from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import express from "express";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { config } from "./config.js";
import { query, transaction } from "./db.js";
import { encryptSecret, newTelemetryToken, tokenHash } from "./crypto.js";
import { issueSession, requireAuth } from "./auth.js";

const app = express();
const runFile = promisify(execFile);
app.disable("x-powered-by");
// Caddy runs on this host and connects through the server's fixed LAN address.
// Trust only that hop so req.ip and secure cookies cannot be spoofed by clients.
app.set("trust proxy", (ip) =>
  ["127.0.0.1", "::1", "::ffff:127.0.0.1", "192.168.0.130", "::ffff:192.168.0.130"].includes(ip),
);
app.use((_req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  });
  next();
});
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  next();
});
app.param("id", (req, res, next, value) =>
  z.string().uuid().safeParse(value).success
    ? next()
    : res.status(400).json({ error: "invalid_id" }),
);
const rateBuckets = new Map();
function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.ip}:${req.path}`;
    const bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.set("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ error: "too_many_requests" });
    }
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of rateBuckets)
    if (value.resetAt <= now) rateBuckets.delete(key);
}, 60_000).unref();
const requireSameOrigin = (req, res, next) => {
  if (!req.cookies.cloudtrade_session) return next();
  const origin = req.get("origin");
  if (!origin) return next();
  try {
    if (new URL(origin).host === req.get("host")) return next();
  } catch {}
  return res.status(403).json({ error: "invalid_origin" });
};
app.use("/api/auth", rateLimit({ windowMs: 15 * 60_000, max: 20 }));
app.use("/api/v1", rateLimit({ windowMs: 60_000, max: 180 }));
app.use("/api", (req, res, next) =>
  ["POST", "PUT", "PATCH", "DELETE"].includes(req.method)
    ? requireSameOrigin(req, res, next)
    : next(),
);
app.use(express.static(path.resolve("public")));
app.get(["/login", "/register"], (_req, res) =>
  res.sendFile(path.resolve("public/login.html")),
);
app.get(["/dashboard", "/terminals", "/activity", "/plans"], (_req, res) =>
  res.sendFile(path.resolve("public/dashboard.html")),
);
app.get("/terminal/:id", (_req, res) =>
  res.sendFile(path.resolve("public/terminal.html")),
);

app.get("/health", async (_req, res) => {
  await query("SELECT 1");
  res.json({ ok: true, service: "tradecloud-api" });
});

async function telemetryIdentity(req) {
  const token = String(req.header("x-telemetry-token") ?? "");
  if (token.length < 32) return null;
  const result = await query(
    "SELECT tc.terminal_id,t.terminal_key FROM telemetry_credentials tc JOIN terminals t ON t.id=tc.terminal_id WHERE tc.token_hash=$1 AND tc.revoked_at IS NULL",
    [tokenHash(token)],
  );
  return result.rows[0] ?? null;
}

app.post("/api/v1/telemetry", async (req, res) => {
  const token = String(req.header("x-telemetry-token") ?? "");
  if (token.length < 32) return res.status(401).json({ error: "unauthorized" });
  const credential = await query(
    "SELECT terminal_id FROM telemetry_credentials WHERE token_hash=$1 AND revoked_at IS NULL",
    [tokenHash(token)],
  );
  if (!credential.rows[0])
    return res.status(401).json({ error: "unauthorized" });
  const payload = z
    .object({
      terminalId: z.string().regex(/^ct-[a-f0-9-]{36}$/),
      connected: z.boolean(),
      symbol: z.string().max(40).optional(),
      equity: z.number().finite().min(0).max(1e12).optional(),
      marginLevel: z.number().finite().min(0).max(1e9).optional(),
      autoTradingEnabled: z.boolean().optional(),
    })
    .passthrough()
    .safeParse(req.body);
  if (!payload.success)
    return res.status(400).json({ error: "invalid_telemetry" });
  req.body = payload.data;
  const terminal = await query(
    "SELECT terminal_key FROM terminals WHERE id=$1",
    [credential.rows[0].terminal_id],
  );
  if (
    !terminal.rows[0] ||
    req.body.terminalId !== terminal.rows[0].terminal_key
  )
    return res.status(403).json({ error: "terminal_identity_mismatch" });
  await transaction(async (client) => {
    await client.query(
      "INSERT INTO terminal_telemetry_latest(terminal_id,payload,connected,symbol,received_at) VALUES($1,$2,$3,$4,now()) ON CONFLICT(terminal_id) DO UPDATE SET payload=excluded.payload,connected=excluded.connected,symbol=excluded.symbol,received_at=now()",
      [
        credential.rows[0].terminal_id,
        req.body,
        Boolean(req.body.connected),
        req.body.symbol ?? null,
      ],
    );
    await client.query(
      "INSERT INTO terminal_telemetry_history(terminal_id,payload) VALUES($1,$2)",
      [credential.rows[0].terminal_id, req.body],
    );
    await client.query(
      "INSERT INTO terminal_controls(terminal_id,baseline_equity,last_equity) VALUES($1,$2,$2) ON CONFLICT(terminal_id) DO UPDATE SET last_equity=$2,updated_at=now()",
      [credential.rows[0].terminal_id, Number(req.body.equity ?? 0)],
    );
    await client.query(
      "UPDATE telemetry_credentials SET last_used_at=now() WHERE terminal_id=$1",
      [credential.rows[0].terminal_id],
    );
    await client.query(
      "UPDATE terminals SET last_heartbeat_at=now(),runtime_state=CASE WHEN $2 THEN 'running' ELSE 'degraded' END,updated_at=now() WHERE id=$1",
      [credential.rows[0].terminal_id, Boolean(req.body.connected)],
    );
    const alerts = [];
    if (!req.body.connected)
      alerts.push([
        "critical",
        "TERMINAL_DISCONNECTED",
        "Terminal MT5 tidak terhubung.",
      ]);
    if (req.body.connected && !req.body.autoTradingEnabled)
      alerts.push([
        "warning",
        "AUTO_TRADING_DISABLED",
        "Algo Trading pada MT5 belum aktif.",
      ]);
    if (Number(req.body.marginLevel) > 0 && Number(req.body.marginLevel) < 150)
      alerts.push([
        "critical",
        "LOW_MARGIN",
        "Margin level terminal berada di bawah 150%.",
      ]);
    for (const [severity, code, message] of alerts) {
      await client.query(
        "INSERT INTO terminal_alerts(terminal_id,severity,code,message) SELECT $1,$2,$3,$4 WHERE NOT EXISTS (SELECT 1 FROM terminal_alerts WHERE terminal_id=$1 AND code=$3 AND created_at>now()-interval '5 minutes')",
        [credential.rows[0].terminal_id, severity, code, message],
      );
    }
    await client.query(
      "UPDATE terminal_controls SET stop_trading=true,close_all_generation=close_all_generation+1,reason='MAX_LOSS_REACHED',updated_at=now() WHERE terminal_id=$1 AND max_loss_usd>0 AND baseline_equity-last_equity>=max_loss_usd AND stop_trading=false",
      [credential.rows[0].terminal_id],
    );
  });
  res.json({ ok: true });
});

app.post("/api/v1/trade-event", async (req, res) => {
  const identity = await telemetryIdentity(req);
  if (!identity) return res.status(401).json({ error: "unauthorized" });
  const payload = z
    .object({
      terminalId: z.string().regex(/^ct-[a-f0-9-]{36}$/),
      dealTicket: z.union([z.string(), z.number()]).transform(String),
      executedAt: z.string().datetime({ offset: true }).optional(),
    })
    .passthrough()
    .safeParse(req.body);
  if (!payload.success)
    return res.status(400).json({ error: "invalid_trade_event" });
  req.body = payload.data;
  if (req.body.terminalId !== identity.terminal_key)
    return res.status(403).json({ error: "terminal_identity_mismatch" });
  const ticket = String(req.body.dealTicket ?? "");
  if (!ticket) return res.status(400).json({ error: "invalid_trade_event" });
  const result = await query(
    "INSERT INTO terminal_trade_events(terminal_id,deal_ticket,payload,executed_at) VALUES($1,$2,$3,$4) ON CONFLICT(terminal_id,deal_ticket) DO NOTHING RETURNING id",
    [identity.terminal_id, ticket, req.body, req.body.executedAt ?? null],
  );
  res.json({ accepted: true, inserted: Boolean(result.rows[0]) });
});

app.get("/api/v1/control", async (req, res) => {
  const identity = await telemetryIdentity(req);
  if (!identity) return res.status(401).json({ error: "unauthorized" });
  if (req.query.terminalId !== identity.terminal_key)
    return res.status(403).json({ error: "terminal_identity_mismatch" });
  const result = await query(
    "SELECT max_loss_usd,lot_size,baseline_equity,last_equity,stop_trading,close_all_generation,risk_percent,trailing_distance_points,applied_at,reason,updated_at FROM terminal_controls WHERE terminal_id=$1",
    [identity.terminal_id],
  );
  const value = result.rows[0] ?? {};
  res.json({
    maxLossUsd: Number(value.max_loss_usd ?? 0),
    lotSize: Number(value.lot_size ?? 0.01),
    baselineEquity: Number(value.baseline_equity ?? 0),
    currentLossUsd: Math.max(
      0,
      Number(value.baseline_equity ?? 0) - Number(value.last_equity ?? 0),
    ),
    stopTrading: Boolean(value.stop_trading),
    closeAllGeneration: Number(value.close_all_generation ?? 0),
    riskPercent: Number(value.risk_percent ?? 10),
    trailingDistancePoints: Number(value.trailing_distance_points ?? 0),
    reason: value.reason ?? "",
    updatedAt: value.updated_at ?? null,
  });
});

app.post("/api/auth/register", async (req, res) => {
  const parsed = z
    .object({
      email: z.string().email(),
      password: z.string().min(8).max(128),
      displayName: z.string().trim().min(2).max(80),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
  try {
    const user = await transaction(async (client) => {
      const passwordHash = await bcrypt.hash(parsed.data.password, 12);
      const inserted = await client.query(
        "INSERT INTO users(email,password_hash,display_name) VALUES(lower($1),$2,$3) RETURNING id,email,display_name,role",
        [parsed.data.email, passwordHash, parsed.data.displayName],
      );
      const plan = await client.query(
        "SELECT id FROM plans WHERE code='starter'",
      );
      if (!plan.rows[0]) {
        const error = new Error("Required Starter plan is unavailable");
        error.code = "SYSTEM_PLAN_MISSING";
        throw error;
      }
      await client.query(
        "INSERT INTO subscriptions(user_id,plan_id,status,current_period_end) VALUES($1,$2,'trialing',now()+interval '14 days')",
        [inserted.rows[0].id, plan.rows[0].id],
      );
      return inserted.rows[0];
    });
    res.cookie("cloudtrade_session", issueSession(user), {
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure,
      maxAge: 7 * 86400000,
    });
    res.status(201).json({ user });
  } catch (error) {
    if (error.code === "23505")
      return res.status(409).json({ error: "email_exists" });
    if (error.code === "SYSTEM_PLAN_MISSING") {
      console.error(error.message);
      return res.status(503).json({ error: "service_unavailable" });
    }
    throw error;
  }
});

app.post("/api/auth/login", async (req, res) => {
  const parsed = z
    .object({ email: z.string().email(), password: z.string().min(1).max(128) })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
  const result = await query(
    "SELECT id,email,display_name,role,status,password_hash FROM users WHERE email=lower($1)",
    [parsed.data.email],
  );
  const user = result.rows[0];
  const fallbackHash =
    "$2b$12$Jq9wX3bV2pQx1xPgH/Q78uQG0KDaAFbfZfGw/6g6BcQvpE7TJVrjK";
  const passwordMatches = await bcrypt.compare(
    parsed.data.password,
    user?.password_hash ?? fallbackHash,
  );
  if (!user || user.status !== "active" || !passwordMatches)
    return res.status(401).json({ error: "invalid_credentials" });
  res.cookie("cloudtrade_session", issueSession(user), {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    maxAge: 7 * 86400000,
  });
  delete user.password_hash;
  res.json({ user });
});

app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie("cloudtrade_session", {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
  });
  res.status(204).end();
});

app.get("/api/me", requireAuth, async (req, res) => {
  const subscription = await query(
    "SELECT s.status,s.current_period_end,p.code,p.name,p.terminal_limit,p.telemetry_retention_days FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=$1 AND s.status IN ('trialing','active','past_due') ORDER BY s.created_at DESC LIMIT 1",
    [req.user.id],
  );
  res.json({ user: req.user, subscription: subscription.rows[0] ?? null });
});

app.get("/api/plans", async (_req, res) => {
  const result = await query(
    "SELECT code,name,price_monthly,terminal_limit,telemetry_retention_days,features FROM plans WHERE active=true ORDER BY terminal_limit",
  );
  res.json({ plans: result.rows });
});

app.get("/api/terminals", requireAuth, async (req, res) => {
  const result = await query(
    "SELECT t.id,t.name,t.terminal_key,t.broker_company,t.broker_server,t.broker_login_masked,t.worker_id,t.desired_state,t.runtime_state,t.provisioning_stage,t.process_id,t.last_heartbeat_at,t.last_error_code,t.last_error_message,t.configuration,t.created_at,(coalesce(tl.connected,false) AND tl.received_at>now()-interval '30 seconds') AS telemetry_connected,tl.symbol AS telemetry_symbol,tl.received_at AS telemetry_received_at,tl.payload AS telemetry FROM terminals t LEFT JOIN terminal_telemetry_latest tl ON tl.terminal_id=t.id WHERE t.user_id=$1 ORDER BY t.created_at DESC",
    [req.user.id],
  );
  res.json({ terminals: result.rows });
});

app.post("/api/terminals", requireAuth, async (req, res) => {
  const parsed = z
    .object({
      name: z.string().trim().min(2).max(80),
      company: z.string().trim().min(2).max(120),
      server: z.string().trim().min(2).max(120),
      login: z.string().regex(/^\d{4,20}$/),
      password: z.string().min(4).max(200),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input" });
  const limits = await query(
    "SELECT p.terminal_limit FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=$1 AND s.status IN ('trialing','active') LIMIT 1",
    [req.user.id],
  );
  if (!limits.rows[0])
    return res.status(402).json({ error: "subscription_required" });
  const count = await query(
    "SELECT count(*)::int AS count FROM terminals WHERE user_id=$1",
    [req.user.id],
  );
  if (count.rows[0].count >= limits.rows[0].terminal_limit)
    return res.status(409).json({ error: "terminal_limit_reached" });
  const telemetryToken = newTelemetryToken();
  const terminal = await transaction(async (client) => {
    const key = `ct-${crypto.randomUUID()}`;
    const configuration = {
      charts: [
        { symbol: "EURUSD", timeframe: "H1", ea: "Mt5CodexBridge" },
        { symbol: "XAUUSD", timeframe: "M5", ea: "HMCopyLot" },
      ],
    };
    const inserted = await client.query(
      "INSERT INTO terminals(user_id,name,terminal_key,broker_company,broker_server,broker_login_masked,desired_state,runtime_state,configuration) VALUES($1,$2,$3,$4,$5,$6,'running','queued',$7) RETURNING *",
      [
        req.user.id,
        parsed.data.name,
        key,
        parsed.data.company,
        parsed.data.server,
        `***${parsed.data.login.slice(-4)}`,
        configuration,
      ],
    );
    await client.query(
      "INSERT INTO terminal_secrets(terminal_id,encrypted_credentials) VALUES($1,$2)",
      [
        inserted.rows[0].id,
        encryptSecret({
          login: parsed.data.login,
          password: parsed.data.password,
          server: parsed.data.server,
          company: parsed.data.company,
        }),
      ],
    );
    await client.query(
      "INSERT INTO telemetry_credentials(terminal_id,token_hash,token_ciphertext) VALUES($1,$2,$3)",
      [
        inserted.rows[0].id,
        tokenHash(telemetryToken),
        encryptSecret({ token: telemetryToken }),
      ],
    );
    const job = await client.query(
      "INSERT INTO provisioning_jobs(terminal_id,requested_by,action) VALUES($1,$2,'provision') RETURNING *",
      [inserted.rows[0].id, req.user.id],
    );
    await client.query(
      "INSERT INTO audit_logs(user_id,terminal_id,event_type,ip_address) VALUES($1,$2,'terminal.created',$3)",
      [req.user.id, inserted.rows[0].id, req.ip],
    );
    return { terminal: inserted.rows[0], job: job.rows[0] };
  });
  res.status(201).json(terminal);
});

app.get("/api/jobs", requireAuth, async (req, res) => {
  const result = await query(
    "SELECT j.id,j.terminal_id,j.action,j.status,j.stage,j.attempts,j.error_code,j.error_message,j.result,j.created_at,j.started_at,j.finished_at FROM provisioning_jobs j JOIN terminals t ON t.id=j.terminal_id WHERE t.user_id=$1 ORDER BY j.created_at DESC LIMIT 50",
    [req.user.id],
  );
  res.json({ jobs: result.rows });
});

app.get("/api/jobs/:id/logs", requireAuth, async (req, res) => {
  const result = await query(
    "SELECT l.id,l.stage,l.level,l.message,l.created_at FROM provisioning_job_logs l JOIN provisioning_jobs j ON j.id=l.job_id JOIN terminals t ON t.id=j.terminal_id WHERE l.job_id=$1 AND t.user_id=$2 ORDER BY l.id",
    [req.params.id, req.user.id],
  );
  res.json({ logs: result.rows });
});

app.get("/api/terminals/:id/supervisor", requireAuth, async (req, res) => {
  const historyLimit = Math.min(
    1000,
    Math.max(
      100,
      Number.parseInt(String(req.query.historyLimit ?? "600"), 10) || 600,
    ),
  );
  const owned = await query(
    "SELECT t.id,t.name,t.terminal_key,t.broker_company,t.broker_server,t.broker_login_masked,t.runtime_state,t.last_heartbeat_at,tl.payload,tl.received_at FROM terminals t LEFT JOIN terminal_telemetry_latest tl ON tl.terminal_id=t.id WHERE t.id=$1 AND t.user_id=$2",
    [req.params.id, req.user.id],
  );
  if (!owned.rows[0])
    return res.status(404).json({ error: "terminal_not_found" });
  const [history, executions, alerts, control] = await Promise.all([
    query(
      "SELECT payload,received_at FROM terminal_telemetry_history WHERE terminal_id=$1 AND received_at>now()-interval '30 days' ORDER BY received_at DESC LIMIT $2",
      [req.params.id, historyLimit],
    ),
    query(
      "SELECT payload,executed_at,received_at FROM terminal_trade_events WHERE terminal_id=$1 ORDER BY coalesce(executed_at,received_at) DESC LIMIT 1000",
      [req.params.id],
    ),
    query(
      "SELECT severity,code,message,created_at FROM terminal_alerts WHERE terminal_id=$1 ORDER BY created_at DESC LIMIT 100",
      [req.params.id],
    ),
    query(
      "SELECT max_loss_usd,lot_size,baseline_equity,last_equity,stop_trading,close_all_generation,risk_percent,trailing_distance_points,applied_at,reason,updated_at FROM terminal_controls WHERE terminal_id=$1",
      [req.params.id],
    ),
  ]);
  res.json({
    terminal: owned.rows[0],
    telemetry: owned.rows[0].payload,
    history: history.rows.map((x) => ({
      ...x.payload,
      receivedAt: x.received_at,
    })),
    executions: executions.rows.map((x) => ({
      ...x.payload,
      receivedAt: x.received_at,
    })),
    alerts: alerts.rows,
    control: control.rows[0] ?? {
      max_loss_usd: 0,
      lot_size: 0.01,
      risk_percent: 10,
      trailing_distance_points: 0,
      stop_trading: false,
      close_all_generation: 0,
    },
  });
});

app.post("/api/terminals/:id/control", requireAuth, async (req, res) => {
  const parsed = z
    .object({
      action: z.enum(["save-limit", "close-all", "stop", "resume"]),
      maxLossUsd: z.number().nonnegative().optional(),
      lotSize: z.number().min(0.01).max(100).multipleOf(0.01).optional(),
      riskPercent: z.number().positive().max(100).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: "invalid_control" });
  const owned = await query(
    "SELECT t.id,coalesce((tl.payload->>'equity')::numeric,0) equity,coalesce((tl.payload->>'spreadPoints')::numeric,0) spread FROM terminals t LEFT JOIN terminal_telemetry_latest tl ON tl.terminal_id=t.id WHERE t.id=$1 AND t.user_id=$2",
    [req.params.id, req.user.id],
  );
  if (!owned.rows[0])
    return res.status(404).json({ error: "terminal_not_found" });
  await query(
    "INSERT INTO terminal_controls(terminal_id,baseline_equity,last_equity) VALUES($1,$2,$2) ON CONFLICT(terminal_id) DO NOTHING",
    [req.params.id, owned.rows[0].equity],
  );
  const action = parsed.data.action;
  if (action === "save-limit") {
    const riskPercent = parsed.data.riskPercent ?? 10;
    const spread = Math.max(0.1, Number(owned.rows[0].spread ?? 0));
    const trailingDistance = Math.min(
      100000,
      Math.max(Math.ceil(spread * 2), Math.ceil((spread * 200) / riskPercent)),
    );
    await query(
      "UPDATE terminal_controls SET max_loss_usd=$2,risk_percent=$3,trailing_distance_points=$4,baseline_equity=$5,last_equity=$5,lot_size=$6,reason='',applied_at=null,updated_at=now() WHERE terminal_id=$1",
      [
        req.params.id,
        parsed.data.maxLossUsd ?? 0,
        riskPercent,
        trailingDistance,
        owned.rows[0].equity,
        parsed.data.lotSize ?? 0.01,
      ],
    );
    await query(
      "INSERT INTO provisioning_jobs(terminal_id,requested_by,action) VALUES($1,$2,'apply-risk')",
      [req.params.id, req.user.id],
    );
  }
  if (action === "close-all")
    await query(
      "UPDATE terminal_controls SET close_all_generation=close_all_generation+1,reason='MANUAL_CLOSE_ALL',updated_at=now() WHERE terminal_id=$1",
      [req.params.id],
    );
  if (action === "stop")
    await query(
      "UPDATE terminal_controls SET stop_trading=true,reason='MANUAL_STOP',updated_at=now() WHERE terminal_id=$1",
      [req.params.id],
    );
  if (action === "resume")
    await query(
      "UPDATE terminal_controls SET stop_trading=false,baseline_equity=$2,last_equity=$2,reason='MANUAL_RESUME',updated_at=now() WHERE terminal_id=$1",
      [req.params.id, owned.rows[0].equity],
    );
  const result = await query(
    "SELECT * FROM terminal_controls WHERE terminal_id=$1",
    [req.params.id],
  );
  res.json({ ok: true, control: result.rows[0] });
});

app.post("/api/terminals/:id/actions", requireAuth, async (req, res) => {
  const parsed = z
    .object({
      action: z.enum(["start", "stop", "restart", "repair", "rotate-token"]),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_action" });
  const owned = await query(
    "SELECT id FROM terminals WHERE id=$1 AND user_id=$2",
    [req.params.id, req.user.id],
  );
  if (!owned.rows[0])
    return res.status(404).json({ error: "terminal_not_found" });
  const job = await query(
    "INSERT INTO provisioning_jobs(terminal_id,requested_by,action) VALUES($1,$2,$3) RETURNING *",
    [req.params.id, req.user.id, parsed.data.action],
  );
  res.status(202).json({ job: job.rows[0] });
});

app.delete("/api/terminals/:id", requireAuth, async (req, res) => {
  const owned = await query(
    "SELECT id,name,terminal_key,install_path FROM terminals WHERE id=$1 AND user_id=$2",
    [req.params.id, req.user.id],
  );
  const terminal = owned.rows[0];
  if (!terminal) return res.status(404).json({ error: "terminal_not_found" });
  try {
    const { stdout } = await runFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "scripts\\delete-terminal.ps1",
        "-TerminalKey",
        terminal.terminal_key,
        "-TenantRoot",
        config.tenantRoot,
      ],
      { cwd: process.cwd(), windowsHide: true, timeout: 30000 },
    );
    const cleanup = JSON.parse(stdout.trim() || "{}");
    await transaction(async (client) => {
      await client.query(
        "INSERT INTO audit_logs(user_id,terminal_id,event_type,ip_address,metadata) VALUES($1,$2,'terminal.deleted',$3,$4)",
        [
          req.user.id,
          terminal.id,
          req.ip,
          { name: terminal.name, terminalKey: terminal.terminal_key, cleanup },
        ],
      );
      await client.query("DELETE FROM terminals WHERE id=$1 AND user_id=$2", [
        terminal.id,
        req.user.id,
      ]);
    });
    res.json({ ok: true, deletedTerminalId: terminal.id, cleanup });
  } catch (error) {
    console.error("terminal deletion failed", error);
    res.status(500).json({ error: "terminal_delete_failed" });
  }
});

app.use((error, _req, res, _next) => {
  if (error?.type === "entity.parse.failed")
    return res.status(400).json({ error: "invalid_json" });
  console.error(error);
  res.status(500).json({ error: "internal_error" });
});

if (process.env.NODE_ENV !== "test")
  app.listen(config.port, config.host, () =>
    console.log(
      `TradeCloud API listening on http://${config.host}:${config.port}`,
    ),
  );
export default app;
