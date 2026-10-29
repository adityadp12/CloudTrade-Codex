export function initInsights(id, { api, bi, esc, getLanguage }) {
  const $ = (selector) => document.querySelector(selector);
  let market,
    calendar,
    pnl,
    ai,
    selectedDate = null;
  const inflight = new Set();
  const number = (value, digits = 2) =>
    Number.isFinite(value)
      ? new Intl.NumberFormat(getLanguage() === "id" ? "id-ID" : "en-US", {
          maximumFractionDigits: digits,
        }).format(value)
      : "—";
  const time = (value, timeZone = "Asia/Jakarta") =>
    value && Number.isFinite(Date.parse(value))
      ? new Date(value).toLocaleString(
          getLanguage() === "id" ? "id-ID" : "en-US",
          { timeZone, dateStyle: "medium", timeStyle: "short" },
        )
      : "—";
  const text = (selector, en, ind) => {
    $(selector).textContent = bi(en, ind);
  };
  const symbolQuery = () =>
    $("#marketSymbol").value
      ? `?symbols=${encodeURIComponent($("#marketSymbol").value)}`
      : "";
  const reason = (key) =>
    ({
      terminal_not_running: bi(
        "The terminal is offline. Start it to read broker prices and volume.",
        "Terminal sedang offline. Nyalakan terminal untuk membaca harga dan volume broker.",
      ),
      terminal_process_mismatch: bi(
        "The terminal process must be refreshed before reading data.",
        "Proses terminal perlu diperbarui sebelum data dapat dibaca.",
      ),
      broker_disconnected: bi(
        "The terminal is disconnected from the broker.",
        "Terminal tidak terhubung ke broker.",
      ),
      market_reader_unavailable: bi(
        "Market data is not available. Check the terminal connection and MT5 reader.",
        "Data pasar belum tersedia. Periksa koneksi terminal dan pembaca MT5.",
      ),
      market_reader_busy: bi(
        "Market data is busy. Retrying shortly.",
        "Pembaca data sedang sibuk. Akan dicoba kembali.",
      ),
      stale_quote: bi(
        "Quotes are stale or the market is closed.",
        "Harga sudah lama atau pasar sedang tutup.",
      ),
      stale_candles: bi(
        "Closed-candle history has not caught up with the current quote.",
        "Histori candle yang sudah tutup belum mengikuti harga terbaru.",
      ),
      missing_volume: bi(
        "Not enough closed candles or volume data.",
        "Candle yang sudah tutup atau data volume belum cukup.",
      ),
      timeframes_disagree: bi(
        "M15, H1 and H4 do not confirm one direction.",
        "M15, H1 dan H4 belum mendukung satu arah.",
      ),
      weak_volume: bi(
        "The price trend is not supported by above-average volume.",
        "Tren harga belum didukung volume di atas rata-rata.",
      ),
      price_volume_alignment: bi(
        "M15/H1 price trends align, with supporting relative volume.",
        "Tren harga M15/H1 selaras dengan dukungan volume relatif.",
      ),
      fresh_market_data_required: bi(
        "Fresh prices and enough closed candles are required before asking AI.",
        "Harga terbaru dan candle yang cukup diperlukan sebelum meminta analisis AI.",
      ),
      ai_unavailable: bi(
        "AI is temporarily unavailable. Indicator analysis remains available; try again later.",
        "AI sementara tidak tersedia. Analisis indikator tetap tersedia; coba lagi nanti.",
      ),
      ai_busy: bi(
        "AI is processing another request. Try again shortly.",
        "AI sedang memproses permintaan lain. Coba sebentar lagi.",
      ),
    })[key] ||
    bi(
      "Data is temporarily unavailable. Try refreshing.",
      "Data sementara belum tersedia. Coba muat ulang.",
    );

  text("#insightsTitle", "Market & performance", "Pasar & kinerja");
  text("#refreshInsights", "Refresh insights", "Muat ulang analisis");
  text("#tabMarket", "Price & volume", "Harga & volume");
  text("#tabEconomic", "Economic calendar", "Kalender ekonomi");
  text("#tabPnl", "PNL calendar", "Kalender PNL");
  text("#marketSymbolLabel", "Symbol", "Simbol");
  text("#runMarketAi", "Ask AI", "Minta analisis AI");
  text("#economicCurrencyLabel", "Currency", "Mata uang");
  text("#economicImpactLabel", "Impact", "Dampak");
  text("#pnlMonthLabel", "Month", "Bulan");
  text("#pnlTimezoneLabel", "Time zone", "Zona waktu");
  $("#marketSymbol option").textContent = bi(
    "Chart symbols",
    "Simbol pada chart",
  );
  $("#economicCurrency option").textContent = bi(
    "All currencies",
    "Semua mata uang",
  );
  const impactLabels = [
    bi("All impact levels", "Semua tingkat dampak"),
    bi("High", "Tinggi"),
    bi("Medium", "Sedang"),
    bi("Low", "Rendah"),
    bi("Holiday", "Libur"),
  ];
  [...$("#economicImpact").options].forEach((option, index) => {
    option.textContent = impactLabels[index];
  });
  text(
    "#marketMethod",
    "Indicator bias uses closed M15/H1 candles, H4 confirmation and relative volume. AI commentary runs on request. Tick volume is broker quote activity; DOM is broker depth, not global order flow. No automatic orders.",
    "Arah indikator memakai candle M15/H1 yang sudah tutup, konfirmasi H4 dan volume relatif. Ulasan AI berjalan saat diminta. Tick volume adalah aktivitas harga broker; DOM adalah kedalaman broker, bukan seluruh antrean pasar. Tidak ada order otomatis.",
  );
  text(
    "#pnlCoverage",
    "Net PNL includes recorded trading profit, commission, swap and fees, including opening costs. Deposits/withdrawals and floating PNL are excluded. Counts refer to closing deals, not grouped positions. Only deals received by TradeCloud are included.",
    "PNL bersih mencakup profit trading, komisi, swap dan biaya yang tercatat, termasuk biaya pembukaan. Deposit/penarikan dan floating PNL tidak dihitung. Jumlah penutupan dihitung per deal, bukan gabungan posisi. Hanya histori yang diterima TradeCloud yang tercakup.",
  );
  $("#economicHead").innerHTML =
    `<tr>${[bi("Time (WIB)", "Waktu (WIB)"), bi("Currency", "Mata uang"), bi("Event", "Peristiwa"), bi("Impact", "Dampak"), "Actual", "Forecast", "Previous"].map((label) => `<th>${label}</th>`).join("")}</tr>`;
  const dateParts = Object.fromEntries(
    new Intl.DateTimeFormat("en", {
      timeZone: "Asia/Jakarta",
      year: "numeric",
      month: "2-digit",
    })
      .formatToParts(new Date())
      .map((part) => [part.type, part.value]),
  );
  $("#pnlMonth").value = `${dateParts.year}-${dateParts.month}`;

  function activate(tab) {
    document.querySelectorAll("[data-insight-tab]").forEach((button) => {
      const active = button.dataset.insightTab === tab;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
      $(`#panel${button.dataset.insightTab}`).hidden = !active;
    });
  }
  document
    .querySelectorAll("[data-insight-tab]")
    .forEach((button, index, buttons) => {
      button.onclick = () => activate(button.dataset.insightTab);
      button.onkeydown = (event) => {
        const step =
          event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (!step) return;
        event.preventDefault();
        const next = buttons[(index + step + buttons.length) % buttons.length];
        next.focus();
        activate(next.dataset.insightTab);
      };
    });

  function renderMarket() {
    const ready = market?.status === "ready" && market.symbols?.length;
    $("#marketStatus").textContent = ready
      ? `${bi("Broker feed", "Feed broker")} · ${time(market.capturedAt)} WIB`
      : reason(market?.reason);
    $("#runMarketAi").disabled =
      !market?.symbols?.some(
        (symbol) =>
          symbol.fresh &&
          symbol.frames.M15.count >= 30 &&
          symbol.frames.H1.count >= 30,
      ) || ai?.status === "running";
    $("#marketCards").innerHTML = (market?.symbols || [])
      .map((symbol) => {
        const frame = symbol.frames.M15,
          levels = symbol.book.levels || [];
        return `<article class="market-card"><div class="section-head"><h3>${esc(symbol.symbol)}</h3><span class="signal signal-${symbol.direction.toLowerCase()}">${symbol.direction}</span></div><p>${esc(reason(symbol.reason))}</p><div class="stats">${[
          [
            "Bid / Ask",
            `${number(symbol.tick?.bid, 5)} / ${number(symbol.tick?.ask, 5)}`,
          ],
          [
            bi("M15 relative volume", "Volume relatif M15"),
            frame.relativeVolume == null
              ? "—"
              : `${number(frame.relativeVolume)}×`,
          ],
          [
            bi("Volume type", "Jenis volume"),
            frame.volumeType === "real"
              ? bi("Real trade volume", "Volume transaksi riil")
              : frame.volumeType === "tick"
                ? "Tick volume"
                : "—",
          ],
          [
            bi("Invalidation level", "Level pembatalan"),
            number(symbol.invalidation, 5),
          ],
        ]
          .map(
            ([label, value]) =>
              `<div class="stat"><span>${label}</span><b>${value}</b></div>`,
          )
          .join("")}</div><div class="timeframe-strip">${Object.entries(
          symbol.frames,
        )
          .map(
            ([label, data]) =>
              `<span>${label} <b class="signal-${data.direction.toLowerCase()}">${data.direction}</b></span>`,
          )
          .join(
            "",
          )}</div><p class="muted">${bi("Last quote", "Harga terakhir")}: ${time(symbol.tick?.time ? new Date(symbol.tick.time * 1000).toISOString() : null)} WIB</p><details><summary>${bi("Broker depth of market", "Antrean pasar broker")} · ${symbol.book.available ? `${levels.length} ${bi("levels", "level")}` : bi("Not supplied", "Tidak tersedia")}</summary>${symbol.book.available ? `<p>Bid ${number(symbol.book.bidVolume)} · Ask ${number(symbol.book.askVolume)} · ${bi("Imbalance", "Ketimpangan")} ${number(symbol.book.imbalance * 100)}%</p><div class="table-wrap"><table><thead><tr><th>Side</th><th>${bi("Price", "Harga")}</th><th>Volume</th></tr></thead><tbody>${levels.map((level) => `<tr><td>${esc(level.side)}</td><td>${number(level.price, 5)}</td><td>${number(level.volume)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">${bi("This broker/symbol has not supplied usable depth. No order-book signal is inferred.", "Broker/simbol ini tidak memberikan data kedalaman yang dapat dipakai. Tidak ada sinyal antrean yang disimpulkan.")}</p>`}</details></article>`;
      })
      .join("");
  }
  function renderAi() {
    if (!ai || ai.status === "idle") return;
    if (ai.status === "running") {
      $("#marketAi").textContent = bi(
        "AI is analyzing the market snapshot…",
        "AI sedang menganalisis snapshot pasar…",
      );
      return;
    }
    if (ai.status !== "ready") {
      $("#marketAi").textContent = reason(ai.error);
      return;
    }
    $("#marketAi").innerHTML =
      `<h3>${bi("AI commentary", "Ulasan AI")}</h3><p class="muted">${bi("Snapshot", "Waktu data")}: ${time(ai.snapshotAt)} WIB ${ai.stale ? `· ${bi("Outdated — request a new analysis", "Sudah lama — minta analisis baru")}` : ""}</p><p>${esc(ai.result.summary)}</p>${ai.result.symbols.map((symbol) => `<article><h4>${esc(symbol.symbol)} · <span class="signal-${symbol.direction.toLowerCase()}">${symbol.direction}</span></h4><p>${esc(symbol.reason)}</p><p><b>${bi("Invalidation", "Pembatalan")}:</b> ${esc(symbol.invalidation)}</p><p>${esc(symbol.newsContext)}</p></article>`).join("")}`;
  }
  function renderEconomic() {
    const currency = $("#economicCurrency").value,
      impact = $("#economicImpact").value;
    const events = (calendar?.events || []).filter(
      (event) =>
        (!currency || event.currency === currency) &&
        (!impact || event.impact === impact),
    );
    $("#economicStatus").textContent =
      calendar?.status === "ready"
        ? bi(
            "This week's releases · times in WIB. “—” means no value supplied.",
            "Rilis minggu ini · waktu WIB. “—” berarti nilai tidak disediakan.",
          )
        : bi(
            "The calendar is unavailable or outdated. Do not treat it as confirmation that there is no news.",
            "Kalender belum tersedia atau sudah lama. Ini bukan konfirmasi bahwa tidak ada berita.",
          );
    $("#economicRows").innerHTML =
      events
        .map(
          (event) =>
            `<tr class="${Date.parse(event.time) < Date.now() ? "event-past" : ""}"><td>${esc(time(event.time))}</td><td>${esc(event.currency)}</td><td>${esc(event.title)}</td><td><span class="impact impact-${event.impact.toLowerCase()}">${esc(event.impact)}</span></td><td>${esc(event.actual ?? "—")}</td><td>${esc(event.forecast || "—")}</td><td>${esc(event.previous || "—")}</td></tr>`,
        )
        .join("") ||
      `<tr><td colspan="7">${bi("No events for the selected filters.", "Tidak ada peristiwa untuk filter ini.")}</td></tr>`;
    $("#economicSource").textContent =
      `${bi("Source", "Sumber")}: ${calendar?.source || "Forex Factory / Fair Economy"} · ${bi("Last fetched", "Terakhir diambil")}: ${time(calendar?.fetchedAt)} WIB. ${bi("A weekly schedule, not a guaranteed live actual-value feed.", "Jadwal mingguan, bukan jaminan feed nilai aktual secara langsung.")}`;
  }
  const money = (value) =>
    `${number(value)}${pnl?.currency ? ` ${esc(pnl.currency)}` : ` ${bi("(account currency)", "(mata uang akun)")}`}`;
  function renderDay(date) {
    selectedDate = date;
    document
      .querySelectorAll(".pnl-day")
      .forEach((button) =>
        button.setAttribute(
          "aria-pressed",
          String(button.dataset.date === date),
        ),
      );
    const day = pnl?.days.find((item) => item.date === date);
    $("#pnlDayDetails").innerHTML =
      `<h3>${esc(date)}</h3>${day ? `<p>${bi("Net PNL", "PNL bersih")}: <b class="${day.net >= 0 ? "good" : "bad"}">${money(day.net)}</b> · Gross ${money(day.gross)} · ${bi("Commission", "Komisi")} ${money(day.commission)} · Swap ${money(day.swap)} · ${bi("Fees", "Biaya")} ${money(day.fee)}</p><div class="table-wrap"><table><thead><tr>${[bi("Time", "Waktu"), bi("Symbol", "Simbol"), "Side", "Deal", "Entry", "Net"].map((label) => `<th>${label}</th>`).join("")}</tr></thead><tbody>${day.executions.map((deal) => `<tr><td>${esc(time(deal.executedAt, pnl.timeZone))}</td><td>${esc(deal.symbol || "—")}</td><td>${esc(deal.side || "—")}</td><td>${esc(deal.dealTicket || "—")}</td><td>${esc(["IN", "OUT", "INOUT", "OUT BY"][Number(deal.entryType)] || "—")}</td><td>${money(deal.net)}</td></tr>`).join("")}</tbody></table></div>` : `<p>${bi("No recorded trading activity on this day.", "Tidak ada aktivitas trading tercatat pada tanggal ini.")}</p>`}`;
  }
  function renderPnl() {
    $("#pnlStatus").textContent =
      `${pnl.month} · ${pnl.timeZone} · ${bi("Recorded deals only", "Hanya transaksi tercatat")}`;
    $("#pnlSummary").innerHTML = [
      [bi("Net PNL", "PNL bersih"), money(pnl.total)],
      [bi("Closing deals", "Deal penutupan"), number(pnl.closedDeals)],
      [
        bi("Win rate / closing deals", "Win rate / deal penutupan"),
        pnl.winRate == null ? "—" : `${number(pnl.winRate)}%`,
      ],
    ]
      .map(
        ([label, value]) =>
          `<div class="stat"><span>${label}</span><b>${value}</b></div>`,
      )
      .join("");
    const [year, month] = pnl.month.split("-").map(Number),
      first = new Date(Date.UTC(year, month - 1, 1)),
      count = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const dayMap = new Map(pnl.days.map((day) => [day.date, day]));
    const weekdays =
      getLanguage() === "id"
        ? ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"]
        : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    $("#pnlCalendar").innerHTML =
      weekdays.map((day) => `<div class="pnl-weekday">${day}</div>`).join("") +
      '<div class="pnl-spacer"></div>'.repeat(first.getUTCDay()) +
      Array.from({ length: count }, (_, index) => {
        const date = `${pnl.month}-${String(index + 1).padStart(2, "0")}`,
          day = dayMap.get(date);
        return `<button type="button" class="pnl-day ${day ? (day.net > 0 ? "pnl-profit" : day.net < 0 ? "pnl-loss" : "pnl-flat") : ""}" data-date="${date}" aria-pressed="false" aria-label="${date}: ${day ? esc(number(day.net)) : bi("No recorded deals", "Tidak ada deal tercatat")}"><span>${index + 1}</span><b>${day ? number(day.net) : "—"}</b><small>${day ? `${day.closedDeals} ${bi("closed", "ditutup")}` : ""}</small></button>`;
      }).join("");
    $("#pnlCalendar")
      .querySelectorAll("[data-date]")
      .forEach((button) => {
        button.onclick = () => renderDay(button.dataset.date);
      });
    if (!selectedDate?.startsWith(pnl.month))
      selectedDate = pnl.days.at(-1)?.date || `${pnl.month}-01`;
    renderDay(selectedDate);
  }

  async function load(kind) {
    if (inflight.has(kind)) return;
    inflight.add(kind);
    const requestedSelection =
      kind === "Pnl"
        ? `${$("#pnlMonth").value}:${$("#pnlTimezone").value}`
        : kind === "Market"
          ? $("#marketSymbol").value
          : null;
    try {
      if (kind === "Market") {
        const next = await api(`/api/terminals/${id}/market${symbolQuery()}`);
        if (requestedSelection !== $("#marketSymbol").value) return;
        market = next;
        const selected = $("#marketSymbol").value;
        const symbols = [
          ...new Set([
            ...(market.availableSymbols || []),
            ...(market.symbols || []).map((symbol) => symbol.symbol),
            ...(selected ? [selected] : []),
          ]),
        ];
        $("#marketSymbol").innerHTML =
          `<option value="">${bi("Chart symbols", "Simbol pada chart")}</option>${symbols.map((symbol) => `<option value="${esc(symbol)}" ${symbol === selected ? "selected" : ""}>${esc(symbol)}</option>`).join("")}`;
        renderMarket();
      } else if (kind === "Economic") {
        calendar = await api("/api/economic-calendar");
        const selected = $("#economicCurrency").value;
        $("#economicCurrency").innerHTML =
          `<option value="">${bi("All currencies", "Semua mata uang")}</option>${[
            ...new Set(calendar.events.map((event) => event.currency)),
          ]
            .sort()
            .map(
              (currency) =>
                `<option ${currency === selected ? "selected" : ""}>${esc(currency)}</option>`,
            )
            .join("")}`;
        renderEconomic();
      } else {
        const month = $("#pnlMonth").value,
          timeZone = $("#pnlTimezone").value;
        if (!month) {
          text("#pnlStatus", "Choose a month.", "Pilih bulan.");
          return;
        }
        const next = await api(
          `/api/terminals/${id}/pnl-calendar?${new URLSearchParams({ month, timeZone })}`,
        );
        if (
          month !== $("#pnlMonth").value ||
          timeZone !== $("#pnlTimezone").value
        )
          return;
        pnl = next;
        renderPnl();
      }
    } catch (error) {
      if (error.silent) return;
      $(
        `#${kind === "Market" ? "market" : kind === "Economic" ? "economic" : "pnl"}Status`,
      ).textContent =
        `${bi("Unable to refresh", "Gagal memperbarui")}: ${reason(error.message)} ${bi("Previously displayed data may be outdated.", "Data yang masih ditampilkan mungkin sudah lama.")}`;
      if (kind === "Market") {
        $("#runMarketAi").disabled = true;
        $("#marketCards").innerHTML = "";
      }
      if (kind === "Pnl") {
        $("#pnlSummary").innerHTML =
          $("#pnlCalendar").innerHTML =
          $("#pnlDayDetails").innerHTML =
            "";
      }
    } finally {
      inflight.delete(kind);
      if (
        (kind === "Pnl" &&
          requestedSelection !==
            `${$("#pnlMonth").value}:${$("#pnlTimezone").value}`) ||
        (kind === "Market" && requestedSelection !== $("#marketSymbol").value)
      )
        queueMicrotask(() => load(kind));
    }
  }
  let aiTimer;
  async function pollAi() {
    try {
      ai = await api(`/api/terminals/${id}/market-ai`);
      renderAi();
      renderMarket();
    } catch (error) {
      if (!error.silent) $("#marketAi").textContent = reason(error.message);
    } finally {
      if (ai?.status === "running") aiTimer = setTimeout(pollAi, 3000);
    }
  }
  $("#runMarketAi").onclick = async () => {
    clearTimeout(aiTimer);
    $("#runMarketAi").disabled = true;
    try {
      ai = await api(`/api/terminals/${id}/market-ai${symbolQuery()}`, {
        method: "POST",
        body: JSON.stringify({ language: getLanguage() }),
      });
      renderAi();
      if (ai.status === "running") aiTimer = setTimeout(pollAi, 3000);
    } catch (error) {
      if (!error.silent) $("#marketAi").textContent = reason(error.message);
    } finally {
      renderMarket();
    }
  };
  $("#marketSymbol").onchange = () => load("Market");
  $("#economicCurrency").onchange = $("#economicImpact").onchange =
    renderEconomic;
  $("#pnlMonth").onchange = $("#pnlTimezone").onchange = () => {
    selectedDate = null;
    load("Pnl");
  };
  $("#refreshInsights").onclick = () =>
    Promise.allSettled(["Market", "Economic", "Pnl"].map(load));
  void Promise.allSettled(["Market", "Economic", "Pnl"].map(load));
  const refreshTimer = setInterval(() => {
    if (!document.hidden) {
      load("Market");
      load("Pnl");
      renderAi();
    }
  }, 60_000);
  const calendarTimer = setInterval(() => {
    if (!document.hidden) load("Economic");
  }, 15 * 60_000);
  window.addEventListener(
    "pagehide",
    () => {
      clearInterval(refreshTimer);
      clearInterval(calendarTimer);
      clearTimeout(aiTimer);
    },
    { once: true },
  );
}
