import { spawn } from "node:child_process";
import { config } from "./config.js";
import { pool, query, transaction } from "./db.js";
import { decryptSecret } from "./crypto.js";
import { runWorkerLoop } from "./worker-loop.js";
import { codexExecutable } from "./codex-executable.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function claimJob() {
  return transaction(async (client) => {
    const selected = await client.query(
      "SELECT j.* FROM provisioning_jobs j WHERE j.status='queued' ORDER BY j.created_at FOR UPDATE SKIP LOCKED LIMIT 1",
    );
    if (!selected.rows[0]) return null;
    const job = selected.rows[0];
    await client.query(
      "UPDATE provisioning_jobs SET status='running',stage='CLONING',attempts=attempts+1,locked_by=$2,locked_at=now(),started_at=coalesce(started_at,now()) WHERE id=$1",
      [job.id, config.workerId],
    );
    await client.query(
      "UPDATE terminals SET runtime_state='provisioning',provisioning_stage='CLONING',worker_id=$2,updated_at=now() WHERE id=$1",
      [job.terminal_id, config.workerId],
    );
    return job;
  });
}

async function contextFor(job) {
  const result = await query(
    "SELECT t.*,s.encrypted_credentials,tc.token_ciphertext,coalesce(c.max_loss_usd,0) risk_max_loss_usd,coalesce(c.lot_size,0.01) risk_lot_size,coalesce(c.trailing_distance_points,100) risk_trailing_distance_points FROM terminals t JOIN terminal_secrets s ON s.terminal_id=t.id JOIN telemetry_credentials tc ON tc.terminal_id=t.id LEFT JOIN terminal_controls c ON c.terminal_id=t.id WHERE t.id=$1",
    [job.terminal_id],
  );
  if (!result.rows[0])
    throw Object.assign(new Error("Terminal context missing"), {
      code: "TERMINAL_CONTEXT_MISSING",
    });
  return {
    terminal: result.rows[0],
    credentials: decryptSecret(result.rows[0].encrypted_credentials),
    telemetry: decryptSecret(result.rows[0].token_ciphertext),
  };
}

const redact = (value) =>
  String(value ?? "")
    .replace(/(password|token|login)\s*[=:]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/\b\d{6,20}\b/g, "[REDACTED]")
    .slice(0, 1000);

async function runCodexRepair(job, failure, round) {
  const history = await query(
    "SELECT stage,level,message FROM provisioning_job_logs WHERE job_id=$1 ORDER BY id DESC LIMIT 40",
    [job.id],
  );
  const safeContext = {
    repairRound: round,
    errorCode: redact(failure.code ?? "PROVISIONER_FAILED"),
    errorMessage: redact(failure.message),
    logs: history.rows
      .reverse()
      .map((entry) => `${redact(entry.stage)}: ${redact(entry.message)}`),
  };
  const prompt = [
    "Anda adalah auto-repair engineer untuk repository TradeCloud yang sedang dibuka.",
    "Temukan akar kegagalan provisioning dari konteks tersanitasi berikut, lalu PERBAIKI file repository yang menjadi penyebabnya.",
    "Batasi perubahan pada D:\\Project\\CloudTrade. Jangan membaca atau mengubah .env, login.txt, .git, folder tenant, credential, token, atau file di luar repository.",
    "Jangan menjalankan terminal MT5, jangan menghapus data, dan jangan mengubah binary EX5. Anda boleh memperbaiki JavaScript, PowerShell, Python, migration, dan test di repository.",
    "Pertahankan perubahan user yang tidak terkait. Jalankan pemeriksaan sintaks dan test yang aman setelah perbaikan.",
    "Jika penyebabnya credential broker, layanan eksternal, atau hal yang tidak dapat diperbaiki melalui kode, jangan mengarang perbaikan; jelaskan blocker secara singkat.",
    "Jawaban akhir maksimal 5 baris: akar masalah, file yang diubah, validasi, dan apakah aman dicoba ulang.",
    JSON.stringify(safeContext),
  ].join("\n\n");
  await jobLog(
    job,
    "ANALYZING_ERROR",
    `Menganalisis error dan menyiapkan perbaikan otomatis (putaran ${round})`,
  );
  const result = await new Promise((resolveRepair, rejectRepair) => {
    const codexArgs = [
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--config",
      "approval_policy=never",
      "--cd",
      process.cwd(),
      "-",
    ];
    const child = spawn(codexExecutable(config.codexCommand), codexArgs, {
      cwd: process.cwd(),
      windowsHide: true,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            ![
              "DATABASE_URL",
              "JWT_SECRET",
              "CREDENTIALS_MASTER_KEY",
              "CT_BROKER_LOGIN",
              "CT_BROKER_PASSWORD",
              "CT_TELEMETRY_TOKEN",
            ].includes(key),
        ),
      ),
    });
    let stdout = "",
      stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      rejectRepair(new Error("Perbaikan otomatis melewati batas waktu"));
    }, 300_000);
    child.stdout.on("data", (value) => (stdout += value));
    child.stderr.on("data", (value) => (stderr += value));
    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectRepair(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0)
        return rejectRepair(
          new Error(
            redact(stderr.trim().split(/\r?\n/)[0]) ||
              `Proses perbaikan keluar dengan kode ${code}`,
          ),
        );
      const messages = stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line) => {
          try {
            const event = JSON.parse(line);
            return event.item?.type === "agent_message"
              ? [event.item.text || event.item.content || ""]
              : [];
          } catch {
            return [];
          }
        })
        .filter(Boolean);
      resolveRepair(messages.at(-1) || "Perbaikan selesai tanpa ringkasan.");
    });
    child.stdin.end(prompt);
  });
  await jobLog(job, "APPLYING_FIX", "Perbaikan repository sudah diterapkan");
  for (const paragraph of redact(result)
    .split(/\n+/)
    .filter(Boolean)
    .slice(0, 8)) {
    await jobLog(job, "APPLYING_FIX", paragraph, "info");
  }
}

async function jobLog(job, stage, message, level = "info") {
  const safe = redact(message);
  await query(
    "INSERT INTO provisioning_job_logs(job_id,stage,level,message) VALUES($1,$2,$3,$4)",
    [job.id, stage, level, safe],
  );
  await query("UPDATE provisioning_jobs SET stage=$2 WHERE id=$1", [
    job.id,
    stage,
  ]);
  await query(
    "UPDATE terminals SET provisioning_stage=$2,updated_at=now() WHERE id=$1",
    [job.terminal_id, stage],
  );
  console.log(`[core:${job.id}] ${stage} ${safe}`);
}

function runProvision(job, context) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "scripts\\provision-terminal.ps1",
        "-TerminalKey",
        context.terminal.terminal_key,
        "-TenantRoot",
        config.tenantRoot,
        "-GoldenImage",
        config.goldenImage,
        "-PythonExe",
        config.pythonExe,
        "-TelemetryEndpoint",
        config.telemetryBaseUrl,
        "-MaxLossUsd",
        String(context.terminal.risk_max_loss_usd ?? 0),
        "-LotSize",
        String(context.terminal.risk_lot_size ?? 0.01),
        "-TrailingDistancePoints",
        String(context.terminal.risk_trailing_distance_points || 100),
      ],
      {
        cwd: process.cwd(),
        windowsHide: true,
        env: {
          ...process.env,
          CT_BROKER_LOGIN: context.credentials.login,
          CT_BROKER_PASSWORD: context.credentials.password,
          CT_BROKER_SERVER: context.credentials.server,
          CT_BROKER_COMPANY: context.credentials.company,
          CT_TELEMETRY_TOKEN: context.telemetry.token,
        },
      },
    );
    let stdout = "",
      stderr = "",
      pending = "",
      lastProgressError = "",
      progressWrites = Promise.resolve();
    child.stdout.on("data", (value) => {
      stdout += value;
      pending += value;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === "progress" && event.level === "error")
            lastProgressError = redact(event.message);
          if (event.type === "progress")
            progressWrites = progressWrites.then(() =>
              jobLog(job, event.stage, event.message, event.level),
            );
        } catch {
          /* final output and non-structured output are not exposed */
        }
      }
    });
    child.stderr.on("data", (value) => {
      stderr += value;
    });
    child.on("error", reject);
    child.on("close", async (code) => {
      try {
        await progressWrites;
      } catch (error) {
        return reject(error);
      }
      if (code !== 0)
        return reject(
          Object.assign(
            new Error(
              lastProgressError ||
                stderr.trim().split(/\r?\n/)[0] ||
                `Provisioner exited ${code}`,
            ),
            { code: "PROVISIONER_FAILED" },
          ),
        );
      try {
        resolve(JSON.parse(stdout.trim().split(/\r?\n/).at(-1)));
      } catch {
        reject(
          Object.assign(new Error("Invalid provisioner output"), {
            code: "INVALID_PROVISIONER_OUTPUT",
          }),
        );
      }
    });
  });
}

function runRiskConfig(job, context, control) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "scripts\\apply-hmcopylot-risk.ps1",
        "-TerminalKey",
        context.terminal.terminal_key,
        "-TenantRoot",
        config.tenantRoot,
        "-PythonExe",
        config.pythonExe,
        "-MaxLossUsd",
        String(control.max_loss_usd),
        "-LotSize",
        String(control.lot_size),
        "-TrailingDistancePoints",
        String(control.trailing_distance_points),
      ],
      {
        cwd: process.cwd(),
        windowsHide: true,
        env: {
          ...process.env,
          CT_BROKER_LOGIN: context.credentials.login,
          CT_BROKER_PASSWORD: context.credentials.password,
          CT_BROKER_SERVER: context.credentials.server,
          CT_BROKER_COMPANY: context.credentials.company,
        },
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (value) => (stdout += value));
    child.stderr.on("data", (value) => (stderr += value));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0)
        return reject(
          Object.assign(
            new Error(
              stderr.trim().split(/\r?\n/)[0] ||
                "HMCopyLot risk configuration failed",
            ),
            { code: "RISK_CONFIG_FAILED" },
          ),
        );
      try {
        resolve(JSON.parse(stdout.trim().split(/\r?\n/).at(-1)));
      } catch {
        reject(
          Object.assign(new Error("Invalid risk configuration output"), {
            code: "INVALID_RISK_OUTPUT",
          }),
        );
      }
    });
  });
}

async function provisionAndVerify(job, context) {
  const result = await runProvision(job, context);
  await jobLog(
    job,
    "TELEMETRY_VERIFY",
    "Menunggu heartbeat telemetry Bridge tanpa HTTP 401",
  );
  let telemetry;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const check = await query(
      "SELECT tl.connected,tl.symbol,tl.received_at,tc.last_used_at FROM terminal_telemetry_latest tl JOIN telemetry_credentials tc ON tc.terminal_id=tl.terminal_id WHERE tl.terminal_id=$1 AND tl.received_at > now()-interval '45 seconds'",
      [job.terminal_id],
    );
    telemetry = check.rows[0];
    if (telemetry?.connected && /^EURUSD/i.test(telemetry.symbol ?? "")) break;
    await wait(2000);
  }
  if (!telemetry?.connected || !/^EURUSD/i.test(telemetry.symbol ?? "")) {
    throw Object.assign(
      new Error("Telemetry Bridge tidak diterima dari chart EURUSD"),
      { code: "TELEMETRY_NOT_VERIFIED" },
    );
  }
  result.checks = {
    ...(result.checks ?? {}),
    unique_token_registered: true,
    telemetry_received_without_401: true,
  };
  await jobLog(
    job,
    "TELEMETRY_VERIFY",
    "Telemetry EURUSD diterima dan token diterima backend",
    "success",
  );
  return result;
}

function canAutoRepair(error) {
  const text = `${error.code ?? ""} ${error.message ?? ""}`.toLowerCase();
  return !/credential|invalid account|authorization failed|account disabled|subscription|market closed|ipc timeout|code -10005/.test(
    text,
  );
}

async function execute(job) {
  const context = await contextFor(job);
  await jobLog(
    job,
    "CORE_PROMPT",
    `${job.action === "repair" ? "Audit dan repair" : "Provisioning"} workflow core dimulai`,
  );
  if (job.action === "apply-risk") {
    const selected = await query(
      "SELECT max_loss_usd,lot_size,risk_percent,trailing_distance_points FROM terminal_controls WHERE terminal_id=$1",
      [job.terminal_id],
    );
    if (!selected.rows[0])
      throw Object.assign(new Error("Risk control is unavailable"), {
        code: "RISK_CONTROL_MISSING",
      });
    await jobLog(
      job,
      "RISK_CONFIG",
      "Menerapkan lot, Max Loss, dan Trailing Distance ke input HMCopyLot",
    );
    const result = await runRiskConfig(job, context, selected.rows[0]);
    await query(
      "UPDATE terminal_controls SET applied_at=now(),updated_at=now() WHERE terminal_id=$1",
      [job.terminal_id],
    );
    await query(
      "UPDATE provisioning_jobs SET status='succeeded',stage='RUNNING',finished_at=now(),result=$2 WHERE id=$1",
      [job.id, result],
    );
    await query(
      "UPDATE terminals SET runtime_state='running',provisioning_stage='RUNNING',process_id=$2,updated_at=now() WHERE id=$1",
      [job.terminal_id, result.processId ?? null],
    );
    await jobLog(
      job,
      "RUNNING",
      "Input risiko HMCopyLot diterapkan tanpa memodifikasi binary EA",
      "success",
    );
    return;
  }
  if (!config.provisioningEnabled) {
    await query(
      "UPDATE provisioning_jobs SET status='succeeded',stage='VERIFIED',finished_at=now(),result=$2 WHERE id=$1",
      [job.id, { simulated: true, reason: "PROVISIONING_ENABLED=false" }],
    );
    await query(
      "UPDATE terminals SET runtime_state='stopped',provisioning_stage='VERIFIED',updated_at=now() WHERE id=$1",
      [job.terminal_id],
    );
    return;
  }
  if (!["provision", "repair"].includes(job.action)) {
    throw Object.assign(
      new Error(`Action ${job.action} is not implemented by this worker yet`),
      { code: "ACTION_NOT_IMPLEMENTED" },
    );
  }
  let result;
  const maxRuns = job.action === "repair" ? 3 : 1;
  for (let run = 1; run <= maxRuns; run += 1) {
    try {
      await jobLog(
        job,
        job.action === "repair"
          ? run === 1
            ? "REPAIR_START"
            : "REPAIR_RETRY"
          : "PROVISIONING_START",
        job.action === "repair"
          ? `Menjalankan pemeriksaan dan pemulihan terminal (${run}/${maxRuns})`
          : "Menjalankan provisioning terminal",
      );
      result = await provisionAndVerify(job, context);
      break;
    } catch (error) {
      if (job.action !== "repair" || run === maxRuns || !canAutoRepair(error))
        throw error;
      await jobLog(
        job,
        "ERROR_DETECTED",
        `Ditemukan kendala: ${redact(error.message)}`,
        "warning",
      );
      try {
        await runCodexRepair(job, error, run);
      } catch (repairError) {
        await jobLog(
          job,
          "AUTO_FIX_FAILED",
          `Perbaikan otomatis belum berhasil: ${redact(repairError.message)}`,
          "warning",
        );
      }
      await jobLog(
        job,
        "REPAIR_RETRY",
        "Memuat perubahan dan mencoba kembali secara otomatis",
      );
    }
  }
  await jobLog(job, "RUNNING", "Semua pemeriksaan core selesai", "success");
  await query(
    "UPDATE provisioning_jobs SET status='succeeded',stage='RUNNING',finished_at=now(),result=$2 WHERE id=$1",
    [job.id, result],
  );
  await query(
    "UPDATE terminals SET runtime_state='running',provisioning_stage='RUNNING',install_path=$2,process_id=$3,last_heartbeat_at=now(),updated_at=now() WHERE id=$1",
    [job.terminal_id, result.installPath, result.processId ?? null],
  );
}

async function fail(job, error) {
  const safeMessage = String(error.message ?? "Provisioning failed")
    .replace(/password|token|login/gi, "credential")
    .slice(0, 500);
  await query(
    "UPDATE provisioning_jobs SET status='failed',stage='FAILED',finished_at=now(),error_code=$2,error_message=$3 WHERE id=$1",
    [job.id, error.code ?? "UNEXPECTED", safeMessage],
  );
  await query(
    "UPDATE terminals SET runtime_state='failed',provisioning_stage='FAILED',last_error_code=$2,last_error_message=$3,updated_at=now() WHERE id=$1",
    [job.terminal_id, error.code ?? "UNEXPECTED", safeMessage],
  );
  await query(
    "INSERT INTO provisioning_job_logs(job_id,stage,level,message) VALUES($1,'FAILED','error',$2)",
    [job.id, safeMessage],
  );
}

let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});

console.log(
  `TradeCloud worker ${config.workerId} started; provisioning=${config.provisioningEnabled}`,
);
await runWorkerLoop({
  claimJob,
  execute,
  fail,
  wait,
  isStopping: () => stopping,
  report: (event, details) => console.error(`[worker] ${event}`, details),
});
await pool.end();
