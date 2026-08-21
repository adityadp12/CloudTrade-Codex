const $ = (s) => document.querySelector(s),
  id = location.pathname.split("/").pop(),
  entryNames = ["IN", "OUT", "INOUT", "OUT BY"];
let data,
  metric = "equity",
  zoom = 1,
  page = 1,
  sort = { key: "executedAt", direction: "desc" },
  timer,
  alertCount = 0,
  riskDraftDirty = false;
const api = async (p, o = {}) => {
    const r = await fetch(p, {
      headers: { "Content-Type": "application/json" },
      ...o,
    });
    const d = await r.json().catch(() => ({}));
    if (r.status === 401) location.href = "/login";
    if (!r.ok) throw Error(d.error || `HTTP ${r.status}`);
    return d;
  },
  num = (n) => Number(n || 0),
  usd = (n) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(num(n)),
  pct = (n) => `${num(n).toFixed(2)}%`,
  dt = (x) => (x ? new Date(x).toLocaleString("id-ID") : "-"),
  dur = (ms) => {
    let s = Math.max(0, Math.floor(ms / 1000)),
      d = Math.floor(s / 86400),
      h = Math.floor((s % 86400) / 3600),
      m = Math.floor((s % 3600) / 60);
    return d ? `${d}h ${h}j` : h ? `${h}j ${m}m` : `${m}m`;
  },
  net = (x) => num(x.profit) + num(x.commission) + num(x.swap),
  side = (x) => x.side || (num(x.dealType) === 1 ? "SELL" : "BUY"),
  card = (a, b, c = "") =>
    `<div class="stat"><span>${a}</span><b class="${c}">${b}</b></div>`;
function risk() {
  const t = data.telemetry || {},
    h = [...data.history].reverse(),
    start = num(h[0]?.equity || t.equity),
    peak = Math.max(0, ...h.map((x) => num(x.equity))),
    daily = Math.max(0, ((start - num(t.equity)) / Math.max(start, 1)) * 100),
    peakDd = Math.max(0, ((peak - num(t.equity)) / Math.max(peak, 1)) * 100),
    floating =
      (Math.max(0, -num(t.floatingPnl)) / Math.max(num(t.balance), 1)) * 100,
    alerts = [];
  if (!t.connected) alerts.push(["critical", "TERMINAL_DISCONNECTED"]);
  if (!t.autoTradingEnabled) alerts.push(["warning", "AUTO_TRADING_DISABLED"]);
  if (daily >= 3) alerts.push(["critical", "DAILY_DRAWDOWN"]);
  if (peakDd >= 7) alerts.push(["critical", "PEAK_DRAWDOWN"]);
  if (floating >= 2) alerts.push(["critical", "FLOATING_LOSS"]);
  if (num(t.marginLevel) > 0 && num(t.marginLevel) < 500)
    alerts.push(["critical", "LOW_MARGIN"]);
  if (num(t.openPositions) > 3) alerts.push(["warning", "TOO_MANY_POSITIONS"]);
  if (num(t.spreadPoints) > 100) alerts.push(["warning", "HIGH_SPREAD"]);
  const hour = Number(
      new Date().toLocaleString("en-US", {
        timeZone: "Asia/Jakarta",
        hour: "numeric",
        hour12: false,
      }),
    ),
    session =
      hour >= 7 && hour < 14
        ? "ASIA"
        : hour >= 14 && hour < 20
          ? "EUROPE"
          : hour >= 20 || hour < 1
            ? "USA"
            : "OFF_HOURS",
    blocked = alerts.some((x) => x[0] === "critical");
  return {
    daily,
    peakDd,
    floating,
    alerts,
    session,
    state: blocked ? "BLOCKED" : alerts.length ? "REDUCED" : "NORMAL",
    allow: !blocked,
    multiplier: blocked
      ? 0
      : session === "EUROPE"
        ? 1
        : session === "OFF_HOURS"
          ? 0.25
          : 0.5,
  };
}
function draw(canvas, rows, keys, colors) {
  const dpr = devicePixelRatio || 1,
    w = canvas.clientWidth || 700,
    h = canvas.clientHeight || 280;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const c = canvas.getContext("2d");
  c.scale(dpr, dpr);
  c.clearRect(0, 0, w, h);
  const values = rows.flatMap((x) => keys.map((k) => num(x[k])));
  if (rows.length < 2 || w < 80 || h < 80) return false;
  const min = Math.min(...values),
    max = Math.max(...values),
    span = max - min || 1;
  c.strokeStyle = "#213545";
  for (let i = 0; i < 5; i++) {
    const y = 20 + (i * (h - 40)) / 4;
    c.beginPath();
    c.moveTo(45, y);
    c.lineTo(w - 10, y);
    c.stroke();
  }
  keys.forEach((k, j) => {
    c.strokeStyle = colors[j];
    c.lineWidth = 2;
    c.beginPath();
    rows.forEach((x, i) => {
      const px = 45 + (i * (w - 60)) / (rows.length - 1),
        py = h - 20 - ((num(x[k]) - min) / span) * (h - 40);
      i ? c.lineTo(px, py) : c.moveTo(px, py);
    });
    c.stroke();
  });
  return true;
}
function filteredExecutions() {
  let a = data.executions.map((x) => ({ ...x, side: side(x), net: net(x) }));
  const sym = $("#filterSymbol").value,
    sd = $("#filterSide").value,
    res = $("#filterResult").value,
    en = $("#filterEntry").value,
    q = $("#filterSearch").value.toLowerCase();
  a = a.filter(
    (x) =>
      (!sym || x.symbol === sym) &&
      (!sd || x.side === sd) &&
      (!res || (res === "profit" ? x.net >= 0 : x.net < 0)) &&
      (!en || String(x.entryType) === en) &&
      (!q || `${x.dealTicket} ${x.comment}`.toLowerCase().includes(q)),
  );
  return a.sort((a, b) => {
    let x = a[sort.key] ?? "",
      y = b[sort.key] ?? "";
    if (sort.key === "executedAt") {
      x = Date.parse(x);
      y = Date.parse(y);
    }
    return (x > y ? 1 : x < y ? -1 : 0) * (sort.direction === "asc" ? 1 : -1);
  });
}
function renderExec() {
  const all = filteredExecutions(),
    pages = Math.max(1, Math.ceil(all.length / 50));
  page = Math.min(page, pages);
  const rows = all.slice((page - 1) * 50, page * 50);
  $("#executions").innerHTML =
    rows
      .map(
        (x) =>
          `<tr><td>${dt(x.executedAt || x.receivedAt)}</td><td>${dur(num(x.durationMs))}</td><td>${x.symbol || "-"}</td><td>${x.side}</td><td>${entryNames[num(x.entryType)] || "-"}</td><td>${x.dealTicket || "-"}</td><td>${num(x.volume).toFixed(2)}</td><td>${num(x.price).toFixed(5)}</td><td>${usd(x.profit)}</td><td>${usd(x.commission)}</td><td>${usd(x.swap)}</td><td>${usd(x.net)}</td><td>${x.magic || "-"}</td><td>${x.comment || "-"}</td></tr>`,
      )
      .join("") || '<tr><td colspan="14">Belum ada eksekusi.</td></tr>';
  $("#pageInfo").textContent = `${page} / ${pages} · ${all.length} data`;
  $("#prevPage").disabled = page <= 1;
  $("#nextPage").disabled = page >= pages;
}
function render() {
  const t = data.terminal,
    m = data.telemetry || {},
    r = risk(),
    pos = m.currentPositions || [],
    closed = data.executions.filter((x) =>
      [1, 2, 3].includes(num(x.entryType)),
    ),
    wins = closed.filter((x) => net(x) > 0),
    grossWin = wins.reduce((a, x) => a + net(x), 0),
    grossLoss = Math.abs(
      closed.filter((x) => net(x) < 0).reduce((a, x) => a + net(x), 0),
    ),
    total = closed.reduce((a, x) => a + net(x), 0);
  $("#title").textContent = t.name;
  $("#meta").textContent =
    `${t.broker_company} · ${t.broker_server} · ${t.broker_login_masked}`;
  $("#status").innerHTML =
    `<b>${m.connected ? "Realtime connected" : "Disconnected"}</b><span>Telemetry ${dt(t.received_at)}</span><span>MT5 ${m.connected ? "connected" : "offline"}</span><span>Algo ${m.autoTradingEnabled ? "ON" : "OFF"}</span><span>Bridge v${m.bridgeVersion || "-"}</span>`;
  $("#metrics").innerHTML = [
    card("Balance", usd(m.balance)),
    card("Equity", usd(m.equity)),
    card(
      "Floating P/L",
      usd(m.floatingPnl),
      num(m.floatingPnl) >= 0 ? "good" : "bad",
    ),
    card("Margin level", pct(m.marginLevel)),
    card("Free margin", usd(m.freeMargin)),
    card("Posisi", m.openPositions || 0),
    card("Pending", m.pendingOrders || 0),
    card("Spread", `${num(m.spreadPoints)} pt`),
    card("Session", r.session),
    card("Risk", r.state),
    card("Lot multiplier", `${r.multiplier}×`),
  ].join("");
  $("#risk").innerHTML = [
    card("Status risiko", r.state),
    card("Entry baru", r.allow ? "Diizinkan" : "Diblokir"),
    card("Daily drawdown", `${pct(r.daily)} / 3%`),
    card("Peak drawdown", `${pct(r.peakDd)} / 7%`),
    card("Floating loss", `${pct(r.floating)} / 2%`),
    card("Margin", `${pct(m.marginLevel)} / min 500%`),
    card("Posisi", `${m.openPositions || 0} / max 3`),
    card("Spread", `${num(m.spreadPoints)} / max 100 pt`),
  ].join("");
  $("#riskAlerts").innerHTML =
    r.alerts
      .map((x) => `<div class="risk-alert"><b>${x[1]}</b> · ${x[0]}</div>`)
      .join("") || '<p class="muted">Tidak ada risiko aktif.</p>';
  $("#resume").innerHTML = [
    card("Closed trades", closed.length),
    card("Win rate", pct((wins.length / (closed.length || 1)) * 100)),
    card("Net P/L", usd(total)),
    card("Profit factor", grossLoss ? (grossWin / grossLoss).toFixed(2) : "—"),
    card("Floating", usd(m.floatingPnl)),
    card("Open positions", m.openPositions || 0),
  ].join("");
  $("#positions").innerHTML =
    pos
      .map(
        (p) =>
          `<tr><td>${dur(Date.now() - num(p.openedAtEpoch) * 1000)}</td><td>${p.symbol}</td><td>${p.side}</td><td>${p.ticket}</td><td>${num(p.volume).toFixed(2)}</td><td>${num(p.openPrice).toFixed(5)}</td><td>${num(p.currentPrice).toFixed(5)}</td><td>${num(p.sl).toFixed(5)}</td><td>${num(p.tp).toFixed(5)}</td><td>${usd(p.profit)}</td><td>${p.magic || "-"}</td><td>${p.comment || "-"}</td></tr>`,
      )
      .join("") || '<tr><td colspan="12">Tidak ada posisi terbuka.</td></tr>';
  $("#positionTotal").textContent =
    `${pos.length} posisi · ${usd(pos.reduce((a, x) => a + num(x.profit), 0))}`;
  if (!riskDraftDirty) {
    $("#maxLoss").value = num(data.control.max_loss_usd);
    $("#riskPercent").value = num(data.control.risk_percent || 10);
    $("#riskFormula").textContent =
      `Spread live ${num(m.spreadPoints).toFixed(1)} × 200 / risiko ${num(data.control.risk_percent || 10).toFixed(1)}% = Trailing Distance ${num(data.control.trailing_distance_points)} point. EA ${data.control.applied_at ? "sudah diterapkan" : "menunggu penerapan"}.`;
  }
  $("#controlStatus").textContent =
    `Baseline ${usd(data.control.baseline_equity)} · loss ${usd(Math.max(0, num(data.control.baseline_equity) - num(data.control.last_equity)))} · ${data.control.stop_trading ? "STOPPED" : "RUNNING"}`;
  const metrics = {
    equity: "Equity",
    balance: "Balance",
    floatingPnl: "Floating P/L",
    marginLevel: "Margin level",
    spreadPoints: "Spread",
  };
  $("#metricButtons").innerHTML = Object.entries(metrics)
    .map(
      ([k, v]) =>
        `<button data-metric="${k}" class="${k === metric ? "active" : ""}">${v}</button>`,
    )
    .join("");
  let hist = [...data.history].reverse();
  const hours = $("#range").value;
  if (hours !== "custom")
    hist = hist.filter(
      (x) => Date.parse(x.receivedAt) >= Date.now() - num(hours) * 3600000,
    );
  else if ($("#sinceDate").value)
    hist = hist.filter(
      (x) => Date.parse(x.receivedAt) >= Date.parse($("#sinceDate").value),
    );
  hist = hist.slice(-Math.max(2, Math.floor(hist.length / zoom)));
  const hasChart = draw($("#mainChart"), hist, [metric], ["#50d890"]);
  draw($("#equityChart"), hist, ["equity", "balance"], ["#50d890", "#55b9ff"]);
  $("#chartEmpty").hidden = Boolean(hasChart);
  $("#chartEmpty").textContent = hist.length
    ? "Minimal dua titik diperlukan untuk menggambar grafik."
    : "Belum ada telemetry pada rentang waktu ini.";
  const eq = hist.map((x) => num(x.equity));
  $("#periodStats").innerHTML = [
    card("Data point", hist.length),
    card("Equity awal", usd(eq[0])),
    card("Equity akhir", usd(eq.at(-1))),
    card("Tertinggi", usd(Math.max(0, ...eq))),
    card("Terendah", usd(eq.length ? Math.min(...eq) : 0)),
    card("Perubahan", usd(num(eq.at(-1)) - num(eq[0]))),
  ].join("");
  const symbols = [
    ...new Set(data.executions.map((x) => x.symbol).filter(Boolean)),
  ];
  $("#filterSymbol").innerHTML =
    '<option value="">Semua symbol</option>' +
    symbols.map((x) => `<option>${x}</option>`).join("");
  renderExec();
  const alerts = [
    ...data.alerts,
    ...r.alerts.map((x) => ({ severity: x[0], code: x[1], message: x[1] })),
  ];
  $("#alerts").innerHTML =
    alerts
      .map(
        (a) =>
          `<div class="risk-alert"><b>${a.code}</b><div>${a.message}</div><small>${dt(a.created_at)}</small></div>`,
      )
      .join("") || '<p class="muted">Tidak ada notifikasi.</p>';
  $("#storage").innerHTML = [
    card("Telemetry rows", data.history.length),
    card("Execution rows", data.executions.length),
    card("Alert rows", data.alerts.length),
    card("Retensi", "Sesuai paket"),
  ].join("");
}
async function load() {
  const next = await api(`/api/terminals/${id}/supervisor`);
  if (
    alertCount &&
    next.alerts.length > alertCount &&
    $("#soundAlerts").checked
  ) {
    const audio = new AudioContext();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.frequency.value = 440;
    gain.gain.value = 0.04;
    oscillator.start();
    oscillator.stop(audio.currentTime + 0.15);
  }
  alertCount = next.alerts.length;
  data = next;
  render();
  clearTimeout(timer);
  timer = setTimeout(load, 2000);
}
async function control(action) {
  await api(`/api/terminals/${id}/control`, {
    method: "POST",
    body: JSON.stringify({
      action,
      maxLossUsd: num($("#maxLoss").value),
      riskPercent: num($("#riskPercent").value || 10),
    }),
  });
  if (action === "save-limit") riskDraftDirty = false;
  await load();
}
$("#saveLimit").onclick = () => control("save-limit");
function updateRiskDraft() {
  riskDraftDirty = true;
  if (!data) return;
  const spread = Math.max(0.1, num(data.telemetry?.spreadPoints));
  const riskPercent = Math.min(
    100,
    Math.max(0.1, num($("#riskPercent").value || 10)),
  );
  const distance = Math.max(
    Math.ceil(spread * 2),
    Math.ceil((spread * 200) / riskPercent),
  );
  $("#riskFormula").textContent =
    `Preview: spread live ${spread.toFixed(1)} × 200 / risiko ${riskPercent.toFixed(1)}% = Trailing Distance ${distance} point. Klik Simpan untuk menerapkan.`;
}
$("#riskPercent").oninput = updateRiskDraft;
$("#maxLoss").oninput = updateRiskDraft;
$("#closeAll").onclick = () =>
  confirm("Tutup semua posisi terminal ini?") && control("close-all");
$("#stopTrade").onclick = () => control("stop");
$("#resumeTrade").onclick = () => control("resume");
$("#range").onchange = () => {
  $("#sinceDate").hidden = $("#applyDate").hidden =
    $("#range").value !== "custom";
  render();
};
$("#applyDate").onclick = render;
$("#refresh").onclick = load;
$("#resetZoom").onclick = () => {
  zoom = 1;
  render();
};
$("#mainChart").onwheel = (e) => {
  e.preventDefault();
  zoom = Math.min(20, Math.max(1, zoom * (e.deltaY < 0 ? 1.5 : 0.75)));
  render();
};
$("#metricButtons").onclick = (e) => {
  if (e.target.dataset.metric) {
    metric = e.target.dataset.metric;
    render();
  }
};
for (const x of ["filterSymbol", "filterSide", "filterResult", "filterEntry"])
  $(`#${x}`).onchange = () => {
    page = 1;
    renderExec();
  };
$("#filterSearch").oninput = () => {
  page = 1;
  renderExec();
};
$("#executionHead").onclick = (e) => {
  if (!e.target.dataset.sort) return;
  const k = e.target.dataset.sort;
  sort =
    sort.key === k
      ? { key: k, direction: sort.direction === "asc" ? "desc" : "asc" }
      : { key: k, direction: "asc" };
  renderExec();
};
$("#prevPage").onclick = () => {
  page--;
  renderExec();
};
$("#nextPage").onclick = () => {
  page++;
  renderExec();
};
$("#exportCsv").onclick = () => {
  const rows = filteredExecutions(),
    csv = [
      "executedAt,symbol,side,entry,deal,volume,price,profit,commission,swap,net,magic,comment",
      ...rows.map((x) =>
        [
          x.executedAt,
          x.symbol,
          x.side,
          x.entryType,
          x.dealTicket,
          x.volume,
          x.price,
          x.profit,
          x.commission,
          x.swap,
          x.net,
          x.magic,
          JSON.stringify(x.comment || ""),
        ].join(","),
      ),
    ].join("\n"),
    a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `cloudtrade-${id}.csv`;
  a.click();
};
api("/api/terminals").then((x) => {
  $("#terminalSelect").innerHTML = x.terminals
    .map(
      (t) =>
        `<option value="${t.id}" ${t.id === id ? "selected" : ""}>${t.name}</option>`,
    )
    .join("");
});
$("#terminalSelect").onchange = (e) =>
  (location.href = `/terminal/${e.target.value}`);
load().catch((e) => {
  $("#status").textContent = e.message;
});
