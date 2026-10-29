const finite = (value) => typeof value === "number" && Number.isFinite(value);
const mean = (values) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

export function analyzeTimeframe(input) {
  const candles = Array.isArray(input)
    ? input
        .filter(
          (bar) =>
            [
              bar.time,
              bar.open,
              bar.high,
              bar.low,
              bar.close,
              bar.tickVolume,
              bar.realVolume,
            ].every(finite) &&
            bar.close > 0 &&
            bar.high >= Math.max(bar.open, bar.close) &&
            bar.low <= Math.min(bar.open, bar.close) &&
            bar.tickVolume >= 0 &&
            bar.realVolume >= 0,
        )
        .sort((a, b) => a.time - b.time)
    : [];
  if (
    candles.length < 30 ||
    new Set(candles.map((bar) => bar.time)).size !== candles.length
  )
    return {
      direction: "WAIT",
      reason: "insufficient_candles",
      count: candles.length,
    };
  const last = candles.at(-1),
    prior = candles.slice(-21, -1);
  const volumeType = candles.slice(-21).every((bar) => bar.realVolume > 0)
    ? "real"
    : "tick";
  const volumeKey = volumeType === "real" ? "realVolume" : "tickVolume";
  const baseline = mean(prior.map((bar) => bar[volumeKey]));
  const relativeVolume = baseline > 0 ? last[volumeKey] / baseline : null;
  const fast = mean(candles.slice(-10).map((bar) => bar.close));
  const slow = mean(candles.slice(-30).map((bar) => bar.close));
  const atr = mean(
    candles.slice(-14).map((bar, index) => {
      const previous = candles[candles.length - 15 + index];
      return Math.max(
        bar.high - bar.low,
        Math.abs(bar.high - previous.close),
        Math.abs(bar.low - previous.close),
      );
    }),
  );
  const trending = atr > 0 && Math.abs(fast - slow) >= atr * 0.2;
  const direction =
    trending && last.close > fast && fast > slow
      ? "BUY"
      : trending && last.close < fast && fast < slow
        ? "SELL"
        : "WAIT";
  return {
    direction,
    count: candles.length,
    close: last.close,
    closedBarTime: last.time,
    fast,
    slow,
    atr,
    relativeVolume,
    volume: last[volumeKey],
    volumeType,
    support: Math.min(...prior.map((bar) => bar.low)),
    resistance: Math.max(...prior.map((bar) => bar.high)),
    reason:
      direction === "WAIT"
        ? "mixed_price_structure"
        : "aligned_moving_averages",
  };
}

export function analyzeSymbol(snapshot, now = Date.now()) {
  const frames = Object.fromEntries(
    ["M5", "M15", "H1", "H4"].map((name) => [
      name,
      analyzeTimeframe(snapshot.frames?.[name]),
    ]),
  );
  const tickAge = finite(snapshot.tick?.time)
    ? Math.max(0, now / 1000 - snapshot.tick.time)
    : Infinity;
  const fresh = tickAge <= 180 && snapshot.tick.time <= now / 1000 + 60;
  const entry = frames.M15,
    trend = frames.H1;
  const candlesFresh = [entry, trend].every(
    (frame, index) =>
      finite(frame.closedBarTime) &&
      frame.closedBarTime <= now / 1000 &&
      now / 1000 - frame.closedBarTime <= (index ? 3600 : 900) * 3,
  );
  const hasVolume =
    entry.relativeVolume !== null && finite(entry.relativeVolume);
  const supported = hasVolume && entry.relativeVolume >= 1;
  const candidate =
    trend.direction !== "WAIT" &&
    trend.direction === entry.direction &&
    (frames.H4.direction === "WAIT" || frames.H4.direction === trend.direction);
  const reason = !fresh
    ? "stale_quote"
    : !hasVolume
      ? "missing_volume"
      : !candlesFresh
        ? "stale_candles"
        : !candidate
          ? "timeframes_disagree"
          : !supported
            ? "weak_volume"
            : "price_volume_alignment";
  const direction =
    fresh && candlesFresh && candidate && supported ? trend.direction : "WAIT";
  const book = (snapshot.book || []).filter(
    (level) => finite(level.price) && finite(level.volume) && level.volume > 0,
  );
  const bidVolume = book
    .filter((level) => level.side === "bid")
    .reduce((sum, level) => sum + level.volume, 0);
  const askVolume = book
    .filter((level) => level.side === "ask")
    .reduce((sum, level) => sum + level.volume, 0);
  return {
    symbol: snapshot.symbol,
    direction,
    reason,
    frames,
    tick: snapshot.tick || null,
    fresh,
    tickAgeSeconds: Number.isFinite(tickAge) ? Math.round(tickAge) : null,
    invalidation:
      direction === "BUY"
        ? entry.support
        : direction === "SELL"
          ? entry.resistance
          : null,
    book: {
      available: book.length > 0,
      levels: book.slice(0, 40),
      bidVolume,
      askVolume,
      imbalance:
        bidVolume + askVolume > 0
          ? (bidVolume - askVolume) / (bidVolume + askVolume)
          : null,
    },
    source: "MT5 broker feed",
    method: "price_volume_rules_v1",
  };
}

export function summarizePnl(events, month, timeZone = "Asia/Jakarta") {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("invalid_month");
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const dateKey = (date) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(date).map((part) => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const days = new Map(),
    seen = new Set();
  const value = (number) =>
    Number.isFinite(Number(number)) ? Number(number) : 0;
  let total = 0,
    closedDeals = 0,
    wins = 0;
  for (const event of events) {
    if (event.dealTicket && seen.has(String(event.dealTicket))) continue;
    if (event.dealTicket) seen.add(String(event.dealTicket));
    if (![0, 1].includes(Number(event.dealType))) continue;
    const date = new Date(event.executedAt);
    if (!Number.isFinite(date.getTime())) continue;
    const key = dateKey(date);
    if (!key.startsWith(`${month}-`)) continue;
    const net =
      value(event.profit) +
      value(event.commission) +
      value(event.swap) +
      value(event.fee);
    const closing = [1, 2, 3].includes(Number(event.entryType));
    const day = days.get(key) || {
      date: key,
      net: 0,
      gross: 0,
      commission: 0,
      swap: 0,
      fee: 0,
      closedDeals: 0,
      wins: 0,
      executions: [],
    };
    day.net += net;
    day.gross += value(event.profit);
    day.commission += value(event.commission);
    day.swap += value(event.swap);
    day.fee += value(event.fee);
    if (closing) {
      day.closedDeals++;
      closedDeals++;
      if (net > 0) {
        day.wins++;
        wins++;
      }
    }
    day.executions.push({
      dealTicket: event.dealTicket,
      symbol: event.symbol,
      side: event.side,
      executedAt: date.toISOString(),
      entryType: event.entryType,
      volume: event.volume,
      net,
    });
    days.set(key, day);
    total += net;
  }
  return {
    month,
    timeZone,
    total,
    closedDeals,
    wins,
    winRate: closedDeals ? (wins / closedDeals) * 100 : null,
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}
