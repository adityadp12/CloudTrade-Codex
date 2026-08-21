const $ = (selector) => document.querySelector(selector);
const state = {
  register: false,
  me: null,
  terminals: [],
  jobs: [],
  plans: [],
  selectedJob: null,
  selectedTerminal: null,
  supervisor: null,
  logs: [],
};
let pollTimer;
let supervisorTimer;

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data =
    response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
  return data;
}
const money = (value) =>
  new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(value);
const setAuthenticated = (active) => {
  $("#authView").hidden = active;
  $("#appView").hidden = !active;
  $("#userBar").hidden = !active;
};

async function bootstrap() {
  try {
    state.me = await api("/api/me");
    setAuthenticated(true);
    $("#userName").textContent = state.me.user.display_name;
    await refresh();
  } catch {
    setAuthenticated(false);
  }
}

async function refresh() {
  const [terminals, jobs, plans] = await Promise.all([
    api("/api/terminals"),
    api("/api/jobs"),
    api("/api/plans"),
  ]);
  state.terminals = terminals.terminals;
  state.jobs = jobs.jobs;
  state.plans = plans.plans;
  const active = state.jobs.find(
    (job) => job.status === "running" || job.status === "queued",
  );
  if (active) state.selectedJob = active.id;
  if (state.selectedJob)
    state.logs = (await api(`/api/jobs/${state.selectedJob}/logs`)).logs;
  render();
  clearTimeout(pollTimer);
  if (active) pollTimer = setTimeout(refresh, 1500);
}

function terminalCards(items) {
  if (!items.length)
    return `<div class="terminal"><h3>Belum ada terminal</h3><p class="muted">Generate akun MT5 pertama untuk menjalankan workflow core.</p></div>`;
  return items
    .map(
      (t) =>
        `<article class="terminal clickable" onclick="openSupervisor('${t.id}')"><div class="terminal-top"><span class="eyebrow">${t.terminal_key.slice(0, 14)}</span><span class="state ${t.runtime_state}">${t.runtime_state}</span></div><h3>${t.name}</h3><div class="muted">${t.broker_company}</div><dl><div><dt>Server</dt><dd>${t.broker_server}</dd></div><div><dt>Login</dt><dd>${t.broker_login_masked}</dd></div><div><dt>Stage</dt><dd>${t.provisioning_stage ?? "-"}</dd></div><div><dt>Telemetry</dt><dd>${t.telemetry_connected ? "Connected" : "Waiting"}</dd></div></dl><div class="terminal-actions"><button onclick="event.stopPropagation();terminalAction('${t.id}','restart')">Restart</button><button onclick="event.stopPropagation();terminalAction('${t.id}','repair')">Repair</button><button onclick="event.stopPropagation();terminalAction('${t.id}','stop')">Stop</button></div></article>`,
    )
    .join("");
}

const usd = (value) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(Number(value ?? 0));
const number = (value, digits = 2) =>
  Number(value ?? 0).toLocaleString("en-US", { maximumFractionDigits: digits });
const dateTime = (value) =>
  value ? new Date(value).toLocaleString("id-ID") : "-";

function activatePage(name) {
  document
    .querySelectorAll(".nav-item")
    .forEach((item) =>
      item.classList.toggle("active", item.dataset.view === name),
    );
  document.querySelectorAll(".app-page").forEach((page) => {
    page.hidden = page.dataset.page !== name;
  });
}

function renderSupervisor() {
  const data = state.supervisor;
  if (!data) return;
  const t = data.terminal;
  const m = data.telemetry || {};
  const positions = Array.isArray(m.currentPositions) ? m.currentPositions : [];
  $("#supervisorTitle").textContent = t.name;
  $("#supervisorMeta").textContent =
    `${t.broker_company} · ${t.broker_server} · ${t.broker_login_masked}`;
  $("#supervisorStatus").innerHTML =
    `<b>${m.connected ? "MT5 connected" : "MT5 disconnected"}</b><span>Algo trading: ${m.autoTradingEnabled ? "aktif" : "nonaktif"}</span><span>Symbol: ${m.symbol || "-"}</span><span>Update: ${dateTime(t.received_at)}</span>`;
  $("#supervisorMetrics").innerHTML = [
    ["Balance", usd(m.balance)],
    ["Equity", usd(m.equity)],
    ["Floating P/L", usd(m.floatingPnl)],
    ["Free margin", usd(m.freeMargin)],
    ["Margin level", `${number(m.marginLevel)}%`],
    ["Spread", `${number(m.spreadPoints, 1)} pts`],
    ["Posisi", m.openPositions ?? 0],
    ["Pending", m.pendingOrders ?? 0],
  ]
    .map(
      ([label, value]) =>
        `<div class="stat"><span>${label}</span><b>${value}</b></div>`,
    )
    .join("");
  $("#positionsBody").innerHTML = positions.length
    ? positions
        .map(
          (p) =>
            `<tr><td>${p.symbol ?? "-"}</td><td>${p.side ?? p.type ?? "-"}</td><td>${number(p.volume ?? p.lots)}</td><td>${number(p.openPrice ?? p.priceOpen, 5)}</td><td>${usd(p.profit)}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="5" class="muted">Tidak ada posisi terbuka.</td></tr>`;
  $("#historyBody").innerHTML =
    data.history
      .slice(0, 100)
      .map(
        (x) =>
          `<tr><td>${dateTime(x.receivedAt)}</td><td>${usd(x.equity)}</td><td>${usd(x.floatingPnl)}</td><td>${number(x.marginLevel)}%</td></tr>`,
      )
      .join("") ||
    `<tr><td colspan="4" class="muted">Belum ada histori telemetry.</td></tr>`;
  $("#executionsBody").innerHTML =
    data.executions
      .map(
        (x) =>
          `<tr><td>${dateTime(x.executedAt || x.receivedAt)}</td><td>${x.symbol ?? "-"}</td><td>${x.side ?? x.dealType ?? "-"}</td><td>${number(x.volume ?? x.lots)}</td><td>${usd(x.profit)}</td><td>${x.dealTicket ?? "-"}</td></tr>`,
      )
      .join("") ||
    `<tr><td colspan="6" class="muted">Belum ada histori eksekusi.</td></tr>`;
  const localAlerts = [];
  if (!m.connected)
    localAlerts.push({
      severity: "critical",
      message: "Terminal tidak terhubung ke telemetry.",
    });
  if (m.connected && !m.autoTradingEnabled)
    localAlerts.push({
      severity: "warning",
      message: "Algo Trading belum aktif.",
    });
  if (Number(m.marginLevel) > 0 && Number(m.marginLevel) < 150)
    localAlerts.push({
      severity: "critical",
      message: "Margin level di bawah 150%.",
    });
  const alerts = [...localAlerts, ...data.alerts];
  $("#riskAlerts").innerHTML = alerts.length
    ? alerts
        .map(
          (a) =>
            `<div class="log-line ${a.severity}"><span>${dateTime(a.created_at)}</span><span class="stage">${a.severity}</span><span class="message">${a.message}</span></div>`,
        )
        .join("")
    : `<span class="muted">Tidak ada alert risiko.</span>`;
  $("#maxLossUsd").value = Number(data.control.max_loss_usd ?? 0);
  $("#controlSummary").textContent =
    `Baseline ${usd(data.control.baseline_equity)} · Equity terakhir ${usd(data.control.last_equity)} · Trading ${data.control.stop_trading ? "dihentikan" : "diizinkan"}`;
}

async function loadSupervisor(silent = false) {
  if (!state.selectedTerminal) return;
  try {
    state.supervisor = await api(
      `/api/terminals/${state.selectedTerminal}/supervisor`,
    );
    renderSupervisor();
  } catch (error) {
    if (!silent)
      $("#supervisorStatus").textContent = `Gagal memuat: ${error.message}`;
  }
  clearTimeout(supervisorTimer);
  if (state.selectedTerminal)
    supervisorTimer = setTimeout(() => loadSupervisor(true), 2000);
}

window.openSupervisor = async (id) => {
  state.selectedTerminal = id;
  state.supervisor = null;
  activatePage("supervisor");
  $("#supervisorStatus").textContent = "Mengambil telemetry terminal…";
  await loadSupervisor();
};

async function terminalControl(action) {
  if (!state.selectedTerminal) return;
  try {
    await api(`/api/terminals/${state.selectedTerminal}/control`, {
      method: "POST",
      body: JSON.stringify({
        action,
        maxLossUsd: Number($("#maxLossUsd").value || 0),
      }),
    });
    await loadSupervisor();
  } catch (error) {
    $("#controlSummary").textContent = `Kontrol gagal: ${error.message}`;
  }
}

function render() {
  const plan = state.me.subscription;
  $("#planSummary").textContent =
    `Paket ${plan?.name ?? "-"} - ${state.terminals.length}/${plan?.terminal_limit ?? 0} terminal`;
  const running = state.terminals.filter(
    (x) => x.runtime_state === "running",
  ).length;
  const failed = state.terminals.filter(
    (x) => x.runtime_state === "failed",
  ).length;
  $("#stats").innerHTML = [
    ["Total terminal", state.terminals.length],
    ["Running", running],
    ["Perlu perhatian", failed],
    ["Retensi", `${plan?.telemetry_retention_days ?? 0} hari`],
  ]
    .map((x) => `<div class="stat"><span>${x[0]}</span><b>${x[1]}</b></div>`)
    .join("");
  $("#terminalGrid").innerHTML = terminalCards(state.terminals);
  $("#dashboardTerminals").innerHTML = terminalCards(
    state.terminals.slice(0, 2),
  );
  $("#jobs").innerHTML = state.jobs.length
    ? state.jobs
        .slice(0, 15)
        .map(
          (j) =>
            `<div class="job ${j.id === state.selectedJob ? "active" : ""}" onclick="selectJob('${j.id}')"><div><b>${j.action}</b><div class="muted">${new Date(j.created_at).toLocaleString("id-ID")}</div></div><code>${j.stage}</code><span class="state ${j.status}">${j.status}</span>${j.error_message ? `<div class="job-error">${j.error_message.split("\n")[0]}</div>` : ""}</div>`,
        )
        .join("")
    : `<p class="muted">Belum ada aktivitas.</p>`;
  $("#coreLogPanel").hidden = !state.selectedJob;
  $("#liveIndicator").hidden = !state.jobs.some(
    (j) =>
      j.id === state.selectedJob &&
      (j.status === "running" || j.status === "queued"),
  );
  $("#coreLogs").innerHTML = state.logs.length
    ? state.logs
        .map(
          (line) =>
            `<div class="log-line ${line.level}"><span>${new Date(line.created_at).toLocaleTimeString("id-ID")}</span><span class="stage">${line.stage}</span><span class="message">${line.message}</span></div>`,
        )
        .join("")
    : `<span class="muted">Menunggu worker mengambil job…</span>`;
  $("#coreLogs").scrollTop = $("#coreLogs").scrollHeight;
  $("#planCards").innerHTML = state.plans
    .map(
      (item) =>
        `<article class="terminal"><div class="eyebrow">${item.code}</div><h3>${item.name}</h3><div class="plan-price">${money(item.price_monthly)}<small>/bulan</small></div><p class="muted">${item.terminal_limit} terminal - retensi ${item.telemetry_retention_days} hari</p></article>`,
    )
    .join("");
}

window.selectJob = async (id) => {
  state.selectedJob = id;
  state.logs = (await api(`/api/jobs/${id}/logs`)).logs;
  render();
};
function setLoading(active, text = "Menjalankan workflow core…") {
  $("#loadingText").textContent = text;
  $("#loadingOverlay").hidden = !active;
}
window.terminalAction = async (id, action) => {
  setLoading(
    true,
    action === "repair"
      ? "Memulai audit & repair core…"
      : `Menjalankan ${action}…`,
  );
  try {
    const result = await api(`/api/terminals/${id}/actions`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    state.selectedJob = result.job.id;
    document.querySelector('[data-view="activity"]').click();
    await refresh();
  } finally {
    setLoading(false);
  }
};
$("#switchAuth").onclick = () => {
  state.register = !state.register;
  $("#nameLabel").hidden = !state.register;
  $("#authTitle").textContent = state.register
    ? "Buat akun CloudTrade"
    : "Masuk ke dashboard";
  $("#switchAuth").textContent = state.register
    ? "Sudah punya akun? Masuk"
    : "Belum punya akun? Daftar";
};
$("#authForm").onsubmit = async (event) => {
  event.preventDefault();
  $("#authMessage").textContent = "";
  try {
    const body = {
      email: $("#email").value,
      password: $("#password").value,
      ...(state.register ? { displayName: $("#displayName").value } : {}),
    };
    await api(state.register ? "/api/auth/register" : "/api/auth/login", {
      method: "POST",
      body: JSON.stringify(body),
    });
    await bootstrap();
  } catch (error) {
    $("#authMessage").textContent = error.message;
  }
};
$("#logout").onclick = async () => {
  await api("/api/auth/logout", { method: "POST" });
  location.reload();
};
document
  .querySelectorAll(".open-terminal")
  .forEach(
    (button) => (button.onclick = () => $("#terminalDialog").showModal()),
  );
document.querySelectorAll(".nav-item").forEach(
  (button) =>
    (button.onclick = () => {
      state.selectedTerminal = null;
      clearTimeout(supervisorTimer);
      activatePage(button.dataset.view);
    }),
);
$("#backToTerminals").onclick = () => {
  state.selectedTerminal = null;
  clearTimeout(supervisorTimer);
  activatePage("terminals");
};
$("#saveRisk").onclick = () => terminalControl("save-limit");
$("#closeAllRisk").onclick = () => terminalControl("close-all");
$("#stopRisk").onclick = () => terminalControl("stop");
$("#resumeRisk").onclick = () => terminalControl("resume");
$("#refresh").onclick = refresh;
$("#terminalForm").onsubmit = async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.currentTarget));
  $("#terminalMessage").textContent = "";
  setLoading(true, "Membuat terminal dan memulai core prompt…");
  try {
    const result = await api("/api/terminals", {
      method: "POST",
      body: JSON.stringify(body),
    });
    state.selectedJob = result.job?.id ?? null;
    event.currentTarget.reset();
    $("#terminalDialog").close();
    document.querySelector('[data-view="activity"]').click();
    await refresh();
  } catch (error) {
    $("#terminalMessage").textContent = error.message;
  } finally {
    setLoading(false);
  }
};
bootstrap();
