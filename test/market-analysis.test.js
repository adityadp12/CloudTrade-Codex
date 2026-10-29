import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSymbol, summarizePnl } from "../src/market-analysis.js";
import {
  createCalendarService,
  normalizeCalendar,
} from "../src/economic-calendar.js";
import { validateAiResult } from "../src/market-ai.js";

const now = Date.parse("2026-10-29T10:00:00Z");
export function snapshot(direction = 1) {
  const frames = Object.fromEntries(
    [
      ["M5", 300],
      ["M15", 900],
      ["H1", 3600],
      ["H4", 14400],
    ].map(([name, seconds]) => [
      name,
      Array.from({ length: 80 }, (_, index) => ({
        time: now / 1000 - (80 - index) * seconds,
        open: 2000 + direction * index,
        close: 2000 + direction * (index + 0.8),
        high: 2001.5 + direction * index,
        low: 1998.5 + direction * index,
        tickVolume: index === 79 ? 180 : 100,
        realVolume: 0,
      })),
    ]),
  );
  return {
    symbol: "XAUUSD",
    tick: { time: now / 1000 - 2, bid: 2080, ask: 2080.3 },
    frames,
    book: [],
  };
}
test("direction requires aligned closed-candle price trends and relative volume", () => {
  const buy = analyzeSymbol(snapshot(), now);
  assert.equal(buy.direction, "BUY");
  assert.equal(buy.frames.M15.volumeType, "tick");
  assert.equal(buy.frames.M15.relativeVolume, 1.8);
  assert.equal(buy.book.available, false);
  assert.equal(analyzeSymbol(snapshot(-1), now).direction, "SELL");
  const weak = snapshot();
  weak.frames.M15.at(-1).tickVolume = 50;
  assert.equal(analyzeSymbol(weak, now).direction, "WAIT");
  const mixed = snapshot();
  mixed.frames.H1 = snapshot(-1).frames.H1;
  assert.equal(analyzeSymbol(mixed, now).direction, "WAIT");
});
test("missing, stale, future and malformed market data cannot produce a directional signal", () => {
  assert.equal(analyzeSymbol({ symbol: "XAUUSD" }, now).direction, "WAIT");
  assert.equal(analyzeSymbol(snapshot(), now + 600_000).direction, "WAIT");
  const old = snapshot();
  old.frames.M15.forEach((bar) => {
    bar.time -= 86400;
  });
  assert.equal(analyzeSymbol(old, now).reason, "stale_candles");
  const future = snapshot();
  future.tick.time += 3600;
  assert.equal(analyzeSymbol(future, now).direction, "WAIT");
  const bad = snapshot();
  bad.frames.H1.forEach((bar) => {
    bar.close = NaN;
  });
  assert.equal(analyzeSymbol(bad, now).direction, "WAIT");
  const noVolume = snapshot();
  noVolume.frames.M15.forEach((bar) => {
    bar.tickVolume = 0;
  });
  assert.equal(analyzeSymbol(noVolume, now).reason, "missing_volume");
});
test("real volume is used only when consistently available; DOM remains broker-labelled", () => {
  const input = snapshot();
  input.frames.M15.forEach((bar) => {
    bar.realVolume = bar.tickVolume * 2;
  });
  input.book = [
    { side: "bid", price: 2080, volume: 30 },
    { side: "ask", price: 2081, volume: 10 },
  ];
  const output = analyzeSymbol(input, now);
  assert.equal(output.frames.M15.volumeType, "real");
  assert.equal(output.book.imbalance, 0.5);
});
test("PNL includes opening costs, closing costs and fees; excludes cash transfers and duplicates", () => {
  const base = {
    dealType: 0,
    executedAt: "2026-10-01T18:00:00Z",
    symbol: "XAUUSD",
  };
  const events = [
    { ...base, dealTicket: "1", entryType: 0, profit: 0, commission: -2 },
    {
      ...base,
      dealTicket: "2",
      entryType: 1,
      profit: 100,
      commission: -2,
      swap: -1,
      fee: -3,
    },
    { ...base, dealTicket: "2", entryType: 1, profit: 100 },
    { ...base, dealTicket: "3", dealType: 2, profit: 1000 },
    {
      ...base,
      dealTicket: "4",
      executedAt: "2026-09-30T18:00:00Z",
      entryType: 1,
      profit: -10,
    },
  ];
  const pnl = summarizePnl(events, "2026-10", "Asia/Jakarta");
  assert.equal(pnl.total, 82);
  assert.equal(pnl.closedDeals, 2);
  assert.equal(pnl.winRate, 50);
  assert.equal(pnl.days[0].date, "2026-10-01");
  assert.equal(pnl.days[1].date, "2026-10-02");
  assert.equal(summarizePnl(events, "2026-10", "UTC").total, 92);
  assert.equal(summarizePnl([], "2026-10").winRate, null);
  assert.throws(() => summarizePnl([], "2026-13"));
});
test("economic provider normalizes timezone and leaves missing actual values absent", async () => {
  const rows = [
    {
      title: "CPI",
      country: "USD",
      date: "2026-10-29T08:30:00-04:00",
      impact: "High",
      forecast: "2.5%",
      previous: "2.4%",
    },
  ];
  assert.equal(normalizeCalendar(rows)[0].time, "2026-10-29T12:30:00.000Z");
  assert.equal(normalizeCalendar(rows)[0].actual, null);
  let calls = 0;
  const service = createCalendarService(async () => {
    calls++;
    return { ok: true, json: async () => rows };
  });
  await Promise.all([service(), service()]);
  await service();
  assert.equal(calls, 1);
  const unavailable = createCalendarService(async () => {
    throw new Error("offline");
  });
  assert.equal((await unavailable()).status, "unavailable");
  assert.deepEqual((await unavailable()).events, []);
});
test("AI output cannot invent symbols, omit symbols or override a WAIT guard", () => {
  const input = {
    symbols: [{ symbol: "XAUUSD", fresh: false, direction: "WAIT" }],
  };
  const result = {
    summary: "Test",
    symbols: [
      {
        symbol: "XAUUSD",
        direction: "BUY",
        reason: "Test",
        invalidation: "Test",
        newsContext: "No data",
      },
    ],
  };
  assert.equal(validateAiResult(result, input).symbols[0].direction, "WAIT");
  assert.throws(() => validateAiResult({ ...result, symbols: [] }, input));
  assert.throws(() =>
    validateAiResult(
      { ...result, symbols: [{ ...result.symbols[0], symbol: "UNKNOWN" }] },
      input,
    ),
  );
});
