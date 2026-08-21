const $ = (s) => document.querySelector(s),
  path = location.pathname;
async function api(p, o = {}) {
  const r = await fetch(p, {
    headers: { "Content-Type": "application/json", ...(o.headers || {}) },
    ...o,
  });
  const d = r.status === 204 ? null : await r.json().catch(() => ({}));
  if (r.status === 401) {
    location.href = "/login";
    throw Error("unauthorized");
  }
  if (!r.ok) throw Error(d.error || `HTTP ${r.status}`);
  return d;
}
const usd = (n) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(Number(n || 0)),
  dt = (x) => (x ? new Date(x).toLocaleString("id-ID") : "-");
let me,
  terminals = [],
  jobs = [],
  plans = [];
const card = (t) =>
  `<article class="terminal clickable" onclick="location.href='/terminal/${t.id}'"><div class="terminal-top"><span class="eyebrow">${t.terminal_key.slice(0, 14)}</span><span class="state ${t.runtime_state}">${t.runtime_state}</span></div><h3>${t.name}</h3><div class="muted">${t.broker_company}</div><dl><div><dt>Server</dt><dd>${t.broker_server}</dd></div><div><dt>Login</dt><dd>${t.broker_login_masked}</dd></div><div><dt>Symbol</dt><dd>${t.telemetry_symbol || "-"}</dd></div><div><dt>Telemetry</dt><dd>${t.telemetry_connected ? "Live" : "Waiting"}</dd></div></dl><div class="terminal-actions"><button data-action="restart" data-id="${t.id}">Restart</button><button data-action="repair" data-id="${t.id}">Repair</button><button data-action="stop" data-id="${t.id}">Stop</button><button class="danger" data-action="delete" data-id="${t.id}" data-name="${t.name}">Hapus</button></div></article>`;
function header(title, sub, eye) {
  $("#pageTitle").textContent = title;
  $("#pageSubtitle").textContent = sub;
  $("#pageEyebrow").textContent = eye;
}
function render() {
  const active = document.querySelector(`.nav-item[href='${path}']`);
  active?.classList.add("active");
  const running = terminals.filter((t) => t.runtime_state === "running").length,
    online = terminals.filter((t) => t.telemetry_connected).length;
  $("#stats").innerHTML = [
    ["Terminal", terminals.length],
    ["Running", running],
    ["Telemetry live", online],
    ["Paket", me.subscription?.name || "-"],
  ]
    .map((x) => `<div class="stat"><span>${x[0]}</span><b>${x[1]}</b></div>`)
    .join("");
  if (path === "/dashboard") {
    header(
      "Dashboard",
      `${terminals.length}/${me.subscription?.terminal_limit || 0} terminal digunakan`,
      "CONTROL CENTER",
    );
    const exposure = new Map();
    for (const t of terminals)
      for (const p of t.telemetry?.currentPositions || []) {
        const k = `${p.symbol} ${p.side}`,
          v = exposure.get(k) || { lot: 0, pnl: 0 };
        v.lot += Number(p.volume || 0);
        v.pnl += Number(p.profit || 0);
        exposure.set(k, v);
      }
    $("#pageBody").innerHTML =
      `<h2>Portfolio terminal</h2><div class="terminal-grid">${terminals.map(card).join("") || '<p class="muted">Belum ada terminal.</p>'}</div><div class="two-col section"><div><h2>Exposure aktif</h2>${[...exposure].map(([k, v]) => `<p><b>${k}</b> · ${v.lot.toFixed(2)} lot · ${usd(v.pnl)}</p>`).join("") || '<p class="muted">Tidak ada exposure.</p>'}</div><div><h2>Risk monitor</h2><p>Offline: <b>${terminals.length - online}</b></p><p>Algo nonaktif: <b>${terminals.filter((t) => t.telemetry && !t.telemetry.autoTradingEnabled).length}</b></p></div></div>`;
  }
  if (path === "/terminals") {
    header(
      "Terminal MT5",
      "Setiap instance dan credential terisolasi.",
      "INSTANCES",
    );
    $("#pageBody").innerHTML =
      `<div class="terminal-grid">${terminals.map(card).join("") || '<p class="muted">Belum ada terminal.</p>'}</div>`;
  }
  if (path === "/activity") {
    header(
      "Provisioning",
      "Log workflow core dan status repair terminal.",
      "AUTOMATION",
    );
    $("#newTerminal").hidden = true;
    $("#pageBody").innerHTML =
      jobs
        .map(
          (j) =>
            `<article class="job"><div><b>${j.action}</b><div class="muted">${dt(j.created_at)}</div></div><code>${j.stage}</code><span class="state ${j.status}">${j.status}</span><details><summary>Log Codex</summary><div class="core-logs" data-logs="${j.id}">Klik untuk memuat log…</div></details></article>`,
        )
        .join("") || '<p class="muted">Belum ada aktivitas.</p>';
  }
  if (path === "/plans") {
    header(
      "Paket",
      "Kapasitas terminal dan retensi telemetry.",
      "SUBSCRIPTION",
    );
    $("#newTerminal").hidden = true;
    $("#pageBody").innerHTML =
      `<div class="terminal-grid">${plans.map((p) => `<article class="terminal"><div class="eyebrow">${p.code}</div><h3>${p.name}</h3><b>${new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(p.price_monthly)}/bulan</b><p>${p.terminal_limit} terminal · retensi ${p.telemetry_retention_days} hari</p></article>`).join("")}</div>`;
  }
  document.querySelectorAll("[data-action]").forEach(
    (b) =>
      (b.onclick = async (e) => {
        e.stopPropagation();
        if (b.dataset.action === "delete") {
          const accepted = confirm(
            `Hapus terminal "${b.dataset.name}" secara permanen?\n\nProses MT5, folder clone, credential, telemetry, histori, alert, dan log provisioning akan dihapus seluruhnya.`,
          );
          if (!accepted) return;
          $("#loadingOverlay").hidden = false;
          try {
            await api(`/api/terminals/${b.dataset.id}`, { method: "DELETE" });
            location.reload();
          } catch (error) {
            alert(`Gagal menghapus terminal: ${error.message}`);
            $("#loadingOverlay").hidden = true;
          }
          return;
        }
        $("#loadingOverlay").hidden = false;
        try {
          await api(`/api/terminals/${b.dataset.id}/actions`, {
            method: "POST",
            body: JSON.stringify({ action: b.dataset.action }),
          });
          location.href = "/activity";
        } finally {
          $("#loadingOverlay").hidden = true;
        }
      }),
  );
  document.querySelectorAll("details").forEach(
    (d) =>
      (d.ontoggle = async () => {
        if (!d.open) return;
        const el = d.querySelector("[data-logs]"),
          x = await api(`/api/jobs/${el.dataset.logs}/logs`);
        el.innerHTML = x.logs
          .map(
            (l) =>
              `<div class="log-line ${l.level}"><span>${dt(l.created_at)}</span><span class="stage">${l.stage}</span><span>${l.message}</span></div>`,
          )
          .join("");
      }),
  );
}
async function init() {
  [me, { terminals }, { jobs }, { plans }] = await Promise.all([
    api("/api/me"),
    api("/api/terminals"),
    api("/api/jobs"),
    api("/api/plans"),
  ]);
  $("#userName").textContent = me.user.display_name;
  render();
}
$("#logout").onclick = async () => {
  await api("/api/auth/logout", { method: "POST" });
  location.href = "/";
};
$("#newTerminal").onclick = () => $("#terminalDialog").showModal();
$("#terminalForm").onsubmit = async (e) => {
  if (e.submitter?.value === "cancel") return;
  e.preventDefault();
  $("#loadingOverlay").hidden = false;
  try {
    await api("/api/terminals", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData(e.currentTarget))),
    });
    location.href = "/activity";
  } catch (x) {
    $("#terminalMessage").textContent = x.message;
    $("#loadingOverlay").hidden = true;
  }
};
init();
