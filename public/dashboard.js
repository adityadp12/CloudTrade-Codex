import { applyLanguage, getLanguage } from "./i18n.js";

applyLanguage();
const $ = (selector) => document.querySelector(selector);
const path = location.pathname;
const bi = (english, indonesian) =>
  getLanguage() === "id" ? indonesian : english;
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>'"]/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[
        char
      ],
  );
const number = (value) => Number(value || 0);
const usd = (value) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(number(value));
const dt = (value) =>
  value
    ? new Date(value).toLocaleString(getLanguage() === "id" ? "id-ID" : "en-US")
    : bi("Not available", "Belum ada");
const relative = (value) => {
  if (!value) return "belum pernah";
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(value)) / 1000),
  );
  if (seconds < 60) return `${seconds} ${bi("seconds ago", "detik lalu")}`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} ${bi("minutes ago", "menit lalu")}`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} ${bi("hours ago", "jam lalu")}`;
  return `${Math.floor(seconds / 86400)} ${bi("days ago", "hari lalu")}`;
};

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    cache: "no-store",
    ...options,
  });
  const body =
    response.status === 204 ? null : await response.json().catch(() => ({}));
  if (response.status === 401) {
    location.href = "/login";
    throw new Error("Sesi berakhir");
  }
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

let me;
let terminals = [];
let jobs = [];
let plans = [];
let activityTimer;
let liveTimer;
let liveRefreshInFlight = false;

function stateLabel(state) {
  return (
    {
      running: "Running",
      stopped: "Stopped",
      failed: "Failed",
      degraded: "Degraded",
      provisioning: "Provisioning",
      queued: "Queued",
    }[state] ||
    state ||
    "Unknown"
  );
}

const repairStages = [
  "REPAIR_START",
  "VALIDATING",
  "CLONING",
  "AUTHENTICATING",
  "CONFIGURING_BRIDGE",
  "CONFIGURING_XAUUSD",
  "TELEMETRY_VERIFY",
  "RUNNING",
];
function progressFor(job) {
  if (["succeeded", "failed"].includes(job.status)) return 100;
  const special = {
    ANALYZING_ERROR: 48,
    APPLYING_FIX: 58,
    REPAIR_RETRY: 18,
    ERROR_DETECTED: 44,
  };
  if (special[job.stage]) return special[job.stage];
  const index = repairStages.indexOf(job.stage);
  return index < 0 ? 8 : Math.round(((index + 1) / repairStages.length) * 92);
}
function stageLabel(stage) {
  const labels = {
    en: {
      QUEUED: "Waiting in queue",
      REPAIR_START: "Inspecting terminal",
      PROVISIONING_START: "Starting provisioning",
      VALIDATING: "Validating configuration",
      CLONING: "Preparing terminal runtime",
      AUTHENTICATING: "Connecting broker account",
      CONFIGURING_BRIDGE: "Configuring telemetry bridge",
      CONFIGURING_XAUUSD: "Configuring trading EA",
      TELEMETRY_VERIFY: "Verifying telemetry",
      ERROR_DETECTED: "Issue detected",
      ANALYZING_ERROR: "Analyzing the cause",
      APPLYING_FIX: "Applying automatic repair",
      REPAIR_RETRY: "Trying again",
      RUNNING: "Terminal is active again",
      FAILED: "Recovery was unsuccessful",
    },
    id: {
      QUEUED: "Menunggu antrean",
      REPAIR_START: "Memeriksa terminal",
      PROVISIONING_START: "Memulai provisioning",
      VALIDATING: "Memvalidasi konfigurasi",
      CLONING: "Menyiapkan runtime terminal",
      AUTHENTICATING: "Menghubungkan akun broker",
      CONFIGURING_BRIDGE: "Mengatur telemetry bridge",
      CONFIGURING_XAUUSD: "Mengatur EA trading",
      TELEMETRY_VERIFY: "Memverifikasi telemetry",
      ERROR_DETECTED: "Kendala terdeteksi",
      ANALYZING_ERROR: "Menganalisis penyebab",
      APPLYING_FIX: "Menerapkan perbaikan otomatis",
      REPAIR_RETRY: "Mencoba kembali",
      RUNNING: "Terminal kembali aktif",
      FAILED: "Pemulihan belum berhasil",
    },
  };
  return labels[getLanguage()]?.[stage] || stage;
}

function terminalCard(terminal) {
  const telemetry = terminal.telemetry || {};
  const positions = Array.isArray(telemetry.currentPositions)
    ? telemetry.currentPositions
    : [];
  const floating = number(telemetry.floatingPnl);
  return `<article class="terminal terminal-card clickable" data-terminal="${esc(terminal.id)}">
    <div class="terminal-top">
      <div class="terminal-identity"><span class="status-dot ${terminal.telemetry_connected ? "online" : "offline"}"></span><span class="eyebrow">${esc(terminal.terminal_key.slice(0, 14))}</span></div>
      <span class="state ${esc(terminal.runtime_state)}">${esc(stateLabel(terminal.runtime_state))}</span>
    </div>
    <h3>${esc(terminal.name)}</h3>
    <p class="terminal-broker">${esc(terminal.broker_company)} · ${esc(terminal.broker_server)}</p>
    <div class="terminal-kpis">
      <div><span>Equity</span><b>${usd(telemetry.equity)}</b></div>
      <div><span>Floating</span><b class="${floating >= 0 ? "good" : "bad"}">${usd(floating)}</b></div>
      <div><span>${bi("Positions", "Posisi")}</span><b>${positions.length}</b></div>
    </div>
    <div class="terminal-foot"><span>Telemetry ${esc(relative(terminal.telemetry_received_at))}</span><span>${esc(terminal.broker_login_masked)}</span></div>
    <div class="terminal-actions">
      <button data-action="restart" data-id="${esc(terminal.id)}">Restart</button>
      <button data-action="repair" data-id="${esc(terminal.id)}">Repair</button>
      <button data-action="stop" data-id="${esc(terminal.id)}">Stop</button>
      <button class="danger" data-action="delete" data-id="${esc(terminal.id)}" data-name="${esc(terminal.name)}">${bi("Delete", "Hapus")}</button>
    </div>
  </article>`;
}

function header(title, subtitle, eyebrow) {
  $("#pageTitle").textContent = title;
  $("#pageSubtitle").textContent = subtitle;
  $("#pageEyebrow").textContent = eyebrow;
}

function dashboardView() {
  const online = terminals.filter((terminal) => terminal.telemetry_connected);
  const allPositions = online.flatMap((terminal) =>
    Array.isArray(terminal.telemetry?.currentPositions)
      ? terminal.telemetry.currentPositions
      : [],
  );
  const balance = online.reduce(
    (sum, terminal) => sum + number(terminal.telemetry?.balance),
    0,
  );
  const equity = online.reduce(
    (sum, terminal) => sum + number(terminal.telemetry?.equity),
    0,
  );
  const floating = online.reduce(
    (sum, terminal) => sum + number(terminal.telemetry?.floatingPnl),
    0,
  );
  const exposure = new Map();
  for (const position of allPositions) {
    const key = `${position.symbol || "Unknown"} ${position.side || ""}`.trim();
    const current = exposure.get(key) || { lot: 0, pnl: 0, count: 0 };
    current.lot += number(position.volume);
    current.pnl += number(position.profit);
    current.count += 1;
    exposure.set(key, current);
  }
  const failed = terminals.filter((terminal) =>
    ["failed", "degraded"].includes(terminal.runtime_state),
  ).length;
  const algoOff = online.filter(
    (terminal) => !terminal.telemetry?.autoTradingEnabled,
  ).length;
  const limit = number(me.subscription?.terminal_limit);
  const utilization = limit
    ? Math.min(100, (terminals.length / limit) * 100)
    : 0;
  const recentJobs = jobs.slice(0, 5);

  $("#stats").innerHTML = `
    <div class="stat highlight"><span>Total equity</span><b>${usd(equity)}</b><small>${online.length} terminal live</small></div>
    <div class="stat"><span>Total balance</span><b>${usd(balance)}</b><small>Gabungan akun online</small></div>
    <div class="stat"><span>Floating P/L</span><b class="${floating >= 0 ? "good" : "bad"}">${usd(floating)}</b><small>${allPositions.length} posisi terbuka</small></div>
    <div class="stat"><span>${bi("System health", "Kesehatan sistem")}</span><b>${failed ? `${failed} ${bi("need attention", "perlu dicek")}` : bi("All clear", "Semua aman")}</b><small>${algoOff} ${bi("algos disabled", "algo nonaktif")}</small></div>`;

  return `<section class="dashboard-hero">
      <div><span class="eyebrow">PORTFOLIO OVERVIEW</span><h2>${online.length ? bi("Trading workspace is active", "Trading workspace aktif") : bi("Connect your first terminal", "Hubungkan terminal pertama Anda")}</h2><p>${online.length} ${bi("of", "dari")} ${terminals.length} ${bi("terminals are sending real-time telemetry.", "terminal mengirim telemetry secara realtime.")}</p></div>
      <div class="capacity"><div><span>${bi("Plan capacity", "Kapasitas paket")} ${esc(me.subscription?.name || "-")}</span><b>${terminals.length}/${limit || 0}</b></div><progress class="progress" max="100" value="${utilization}">${utilization}%</progress><small>${bi("Valid until", "Berlaku sampai")} ${dt(me.subscription?.current_period_end)}</small></div>
    </section>
    <div class="dashboard-grid section">
      <section class="panel exposure-panel"><div class="section-head"><div><span class="eyebrow">MARKET EXPOSURE</span><h2>Exposure aktif</h2></div><span class="soft-badge">${allPositions.length} posisi</span></div>
        <div class="exposure-list">${
          [...exposure]
            .sort((a, b) => Math.abs(b[1].pnl) - Math.abs(a[1].pnl))
            .map(
              ([key, value]) =>
                `<div class="exposure-row"><div><b>${esc(key)}</b><span>${value.count} posisi · ${value.lot.toFixed(2)} lot</span></div><strong class="${value.pnl >= 0 ? "good" : "bad"}">${usd(value.pnl)}</strong></div>`,
            )
            .join("") ||
          `<div class="empty-state"><b>${bi("No exposure", "Tidak ada exposure")}</b><span>${bi("Open positions will appear here.", "Posisi terbuka akan muncul di sini.")}</span></div>`
        }</div>
      </section>
      <section class="panel health-panel"><div class="section-head"><div><span class="eyebrow">SYSTEM HEALTH</span><h2>Risk monitor</h2></div><span class="health-score ${failed ? "bad" : "good"}">${failed ? "Perhatian" : "Sehat"}</span></div>
        <div class="health-list"><div><span>Terminal online</span><b>${online.length}/${terminals.length}</b></div><div><span>Offline</span><b>${terminals.length - online.length}</b></div><div><span>Algo nonaktif</span><b>${algoOff}</b></div><div><span>Failed / degraded</span><b>${failed}</b></div></div>
      </section>
    </div>
    <section class="section dashboard-section"><div class="section-head"><div><span class="eyebrow">TERMINALS</span><h2>${bi("Terminal portfolio", "Portfolio terminal")}</h2></div><a class="text-link" href="/terminals">${bi("View all", "Lihat semua")} →</a></div><div class="terminal-grid">${terminals.map(terminalCard).join("") || `<div class="empty-state"><b>${bi("No terminals yet", "Belum ada terminal")}</b><span>${bi("Generate a terminal to connect an MT5 account.", "Klik Generate terminal untuk menghubungkan akun MT5.")}</span></div>`}</div></section>
    <section class="section dashboard-section"><div class="section-head"><div><span class="eyebrow">RECENT ACTIVITY</span><h2>${bi("Recent activity", "Aktivitas terbaru")}</h2></div><a class="text-link" href="/activity">${bi("Open activity", "Buka log")} →</a></div><div class="activity-list">${
      recentJobs
        .map(
          (job) =>
            `<div class="activity-row"><span class="activity-icon ${esc(job.status)}">${job.status === "succeeded" ? "✓" : job.status === "failed" ? "!" : "↻"}</span><div><b>${esc(stateLabel(job.action))}</b><span>${esc(job.stage)} · ${esc(relative(job.created_at))}</span></div><span class="state ${esc(job.status)}">${esc(stateLabel(job.status))}</span></div>`,
        )
        .join("") ||
      `<div class="empty-state"><span>${bi("No provisioning activity yet.", "Belum ada aktivitas provisioning.")}</span></div>`
    }</div></section>`;
}

function render() {
  document.querySelector(`.nav-item[href='${path}']`)?.classList.add("active");
  $("#newTerminal").hidden = path === "/activity" || path === "/plans";
  if (path === "/dashboard") {
    header(
      "Dashboard",
      bi(
        "Monitor your portfolio, risk, and terminal health in one view.",
        "Pantau portfolio, risiko, dan kesehatan terminal dalam satu tampilan.",
      ),
      "CONTROL CENTER",
    );
    $("#pageBody").innerHTML = dashboardView();
  } else {
    const online = terminals.filter(
      (terminal) => terminal.telemetry_connected,
    ).length;
    $("#stats").innerHTML = [
      ["Terminal", terminals.length],
      [
        "Running",
        terminals.filter((t) => t.runtime_state === "running").length,
      ],
      ["Telemetry live", online],
      [bi("Plan", "Paket"), me.subscription?.name || "-"],
    ]
      .map(
        ([label, value]) =>
          `<div class="stat"><span>${esc(label)}</span><b>${esc(value)}</b></div>`,
      )
      .join("");
    if (path === "/terminals") {
      header(
        bi("MT5 Terminals", "Terminal MT5"),
        bi(
          "Every instance and credential is isolated.",
          "Setiap instance dan credential terisolasi.",
        ),
        "INSTANCES",
      );
      $("#pageBody").innerHTML =
        `<div class="terminal-grid">${terminals.map(terminalCard).join("") || `<div class="empty-state">${bi("No terminals yet.", "Belum ada terminal.")}</div>`}</div>`;
    }
    if (path === "/activity") {
      header(
        bi("Terminal progress", "Progress terminal"),
        bi(
          "Monitor provisioning and automated recovery in real time.",
          "Pantau provisioning dan pemulihan otomatis secara realtime.",
        ),
        "AUTOMATION",
      );
      $("#pageBody").innerHTML =
        jobs
          .map(
            (job) =>
              `<article class="progress-job ${esc(job.status)}"><div class="progress-job-head"><div class="progress-title">${job.status === "running" || job.status === "queued" ? '<span class="mini-spinner"></span>' : `<span class="progress-result ${esc(job.status)}">${job.status === "succeeded" ? "✓" : "!"}</span>`}<div><b>${job.action === "repair" ? "Pemulihan terminal" : `Proses ${esc(job.action)}`}</b><span>${esc(stageLabel(job.stage))}</span></div></div><span class="state ${esc(job.status)}">${esc(stateLabel(job.status))}</span></div><progress class="job-progress" max="100" value="${progressFor(job)}"></progress><div class="progress-meta"><span>${progressFor(job)}%</span><span>${dt(job.created_at)}</span></div>${job.error_message ? `<p class="progress-error">${esc(job.error_message)}</p>` : ""}</article>`,
          )
          .join("") || `<div class="empty-state">${bi("No activity yet.", "Belum ada aktivitas.")}</div>`;
    }
    if (path === "/plans") {
      header(
        bi("Plans", "Paket"),
        bi(
          "Terminal capacity and telemetry retention.",
          "Kapasitas terminal dan retensi telemetry.",
        ),
        "SUBSCRIPTION",
      );
      $("#pageBody").innerHTML =
        `<div class="terminal-grid">${plans.map((plan) => `<article class="terminal"><div class="eyebrow">${esc(plan.code)}</div><h3>${esc(plan.name)}</h3><div class="plan-price">${new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(plan.price_monthly)}/${bi("month", "bulan")}</div><p>${number(plan.terminal_limit)} terminal · ${bi("retention", "retensi")} ${number(plan.telemetry_retention_days)} ${bi("days", "hari")}</p></article>`).join("")}</div>`;
    }
  }
  bindInteractions();
}

function bindInteractions() {
  document.querySelectorAll("[data-terminal]").forEach((element) => {
    element.onclick = () =>
      (location.href = `/terminal/${element.dataset.terminal}`);
  });
  document.querySelectorAll("[data-action]").forEach((button) => {
    button.onclick = async (event) => {
      event.stopPropagation();
      if (
        button.dataset.action === "delete" &&
        !confirm(bi(`Permanently delete terminal "${button.dataset.name}"?`, `Hapus terminal "${button.dataset.name}" secara permanen?`))
      )
        return;
      $("#loadingOverlay").hidden = false;
      try {
        if (button.dataset.action === "delete")
          await api(`/api/terminals/${button.dataset.id}`, {
            method: "DELETE",
          });
        else
          await api(`/api/terminals/${button.dataset.id}/actions`, {
            method: "POST",
            body: JSON.stringify({ action: button.dataset.action }),
          });
        location.href =
          button.dataset.action === "delete" ? "/terminals" : "/activity";
      } catch (error) {
        alert(`Operasi gagal: ${error.message}`);
        $("#loadingOverlay").hidden = true;
      }
    };
  });
}

async function init() {
  try {
    [me, { terminals }, { jobs }, { plans }] = await Promise.all([
      api("/api/me"),
      api("/api/terminals"),
      api("/api/jobs"),
      api("/api/plans"),
    ]);
    $("#userName").textContent = me.user.display_name;
    render();
    if (path === "/activity") refreshActivity();
    else if (path === "/dashboard" || path === "/terminals") refreshLiveData();
  } catch (error) {
    $("#pageBody").innerHTML =
      `<div class="empty-state bad">Gagal memuat dashboard: ${esc(error.message)}</div>`;
  }
}

async function refreshLiveData() {
  clearTimeout(liveTimer);
  if (liveRefreshInFlight) {
    liveTimer = setTimeout(refreshLiveData, 2500);
    return;
  }
  liveRefreshInFlight = true;
  try {
    ({ terminals } = await api(`/api/terminals?live=${Date.now()}`));
    render();
  } catch (error) {
    console.error("Live dashboard refresh failed", error);
  } finally {
    liveRefreshInFlight = false;
    liveTimer = setTimeout(refreshLiveData, document.hidden ? 10000 : 2500);
  }
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && (path === "/dashboard" || path === "/terminals"))
    refreshLiveData();
});

async function refreshActivity() {
  clearTimeout(activityTimer);
  try {
    ({ jobs } = await api("/api/jobs"));
    render();
  } catch (error) {
    $("#pageSubtitle").textContent =
      `Koneksi terputus: ${error.message}. Mencoba kembali…`;
  } finally {
    activityTimer = setTimeout(refreshActivity, 4000);
  }
}

$("#logout").onclick = async () => {
  await api("/api/auth/logout", { method: "POST" });
  location.href = "/";
};
$("#newTerminal").onclick = () => $("#terminalDialog").showModal();
$("#terminalForm").onsubmit = async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  $("#loadingOverlay").hidden = false;
  try {
    await api("/api/terminals", {
      method: "POST",
      body: JSON.stringify(
        Object.fromEntries(new FormData(event.currentTarget)),
      ),
    });
    location.href = "/activity";
  } catch (error) {
    $("#terminalMessage").textContent = error.message;
    $("#loadingOverlay").hidden = true;
  }
};
init();
