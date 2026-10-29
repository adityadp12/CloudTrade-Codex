import { summarizePnl } from "./market-analysis.js";
import { createCalendarService } from "./economic-calendar.js";
import { createMarketService } from "./market-data.js";

export function registerInsightsRoutes(
  app,
  {
    query,
    requireAuth,
    config,
    calendar = createCalendarService(),
    market = createMarketService(config),
    ai,
  },
) {
  const defaultSymbols = (terminal) =>
    [
      ...new Set(
        (terminal.configuration?.charts || [])
          .map((chart) => chart.symbol)
          .filter(Boolean),
      ),
    ].slice(0, 12);
  const owned = async (req, res) => {
    const result = await query(
      "SELECT t.id,t.install_path,t.process_id,t.configuration,t.terminal_key,tl.payload FROM terminals t LEFT JOIN terminal_telemetry_latest tl ON tl.terminal_id=t.id WHERE t.id=$1 AND t.user_id=$2",
      [req.params.id, req.user.id],
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: "terminal_not_found" });
      return null;
    }
    return result.rows[0];
  };
  const selection = (req) => {
    if (Object.keys(req.query).some((key) => key !== "symbols")) return null;
    if (req.query.symbols == null || req.query.symbols === "") return [];
    if (typeof req.query.symbols !== "string") return null;
    const symbols = [...new Set(req.query.symbols.split(","))];
    return symbols.length <= 12 &&
      symbols.every((value) => /^[a-zA-Z0-9_.#\-+]{1,40}$/.test(value))
      ? symbols
      : null;
  };
  app.get("/api/economic-calendar", requireAuth, async (_req, res) =>
    res.json(await calendar()),
  );
  app.get("/api/terminals/:id/market", requireAuth, async (req, res) => {
    const symbols = selection(req);
    if (!symbols) return res.status(400).json({ error: "invalid_symbols" });
    const terminal = await owned(req, res);
    if (!terminal) return;
    const defaults = defaultSymbols(terminal);
    res.json(await market(terminal, symbols.length ? symbols : defaults));
  });
  app.get("/api/terminals/:id/pnl-calendar", requireAuth, async (req, res) => {
    if (
      Object.keys(req.query).some((key) => !["month", "timeZone"].includes(key))
    )
      return res.status(400).json({ error: "invalid_calendar_range" });
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const timeZone = req.query.timeZone || "Asia/Jakarta";
    if (
      typeof month !== "string" ||
      !/^(20\d{2})-(0[1-9]|1[0-2])$/.test(month) ||
      typeof timeZone !== "string"
    )
      return res.status(400).json({ error: "invalid_calendar_range" });
    try {
      new Intl.DateTimeFormat("en", { timeZone });
    } catch {
      return res.status(400).json({ error: "invalid_timezone" });
    }
    const terminal = await owned(req, res);
    if (!terminal) return;
    const result = await query(
      "SELECT payload,executed_at,received_at FROM terminal_trade_events WHERE terminal_id=$1 AND coalesce(executed_at,received_at) >= ($2::date - interval '1 day') AND coalesce(executed_at,received_at) < ($2::date + interval '1 month 1 day') ORDER BY coalesce(executed_at,received_at)",
      [req.params.id, `${month}-01`],
    );
    const events = result.rows.map((row) => ({
      ...row.payload,
      executedAt: row.executed_at || row.payload.executedAt || row.received_at,
    }));
    res.json({
      ...summarizePnl(events, month, timeZone),
      currency:
        terminal.payload?.currency || terminal.payload?.accountCurrency || null,
      source: "TradeCloud recorded MT5 deals",
      coverage: "recorded_deals_only",
    });
  });
  app.post("/api/terminals/:id/market-ai", requireAuth, async (req, res) => {
    if (!ai) return res.status(503).json({ error: "ai_unavailable" });
    const symbols = selection(req);
    if (!symbols) return res.status(400).json({ error: "invalid_symbols" });
    const terminal = await owned(req, res);
    if (!terminal) return;
    const [snapshot, events] = await Promise.all([
      market(terminal, symbols.length ? symbols : defaultSymbols(terminal)),
      calendar(),
    ]);
    if (
      !snapshot.symbols?.some(
        (symbol) =>
          symbol.fresh &&
          symbol.frames.M15.count >= 30 &&
          symbol.frames.H1.count >= 30,
      )
    )
      return res.status(409).json({ error: "fresh_market_data_required" });
    res
      .status(202)
      .json(
        ai.start(
          terminal.id,
          snapshot,
          events,
          req.body?.language === "id" ? "id" : "en",
        ),
      );
  });
  app.get("/api/terminals/:id/market-ai", requireAuth, async (req, res) => {
    if (!(await owned(req, res))) return;
    res.json(ai?.get(req.params.id) || { status: "idle" });
  });
}
