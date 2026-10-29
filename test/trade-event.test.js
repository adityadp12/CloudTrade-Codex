import test from "node:test";
import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:1/test";
process.env.JWT_SECRET ??= "test-jwt-secret-with-at-least-32-characters";
process.env.CREDENTIALS_MASTER_KEY ??= "11".repeat(32);

const { normalizeTradeEventTime } = await import("../src/server.js");

test("trade event time prefers the MT5 epoch timestamp", () => {
  assert.equal(
    normalizeTradeEventTime({
      executedAtEpoch: 1788408000,
      executedAt: "2026.09.03 12:00:00",
    }),
    "2026-09-03T04:00:00.000Z",
  );
});

test("trade event time accepts ISO timestamps and rejects invalid input", () => {
  assert.equal(
    normalizeTradeEventTime({ executedAt: "2026-09-03T12:00:00+07:00" }),
    "2026-09-03T05:00:00.000Z",
  );
  assert.equal(normalizeTradeEventTime({ executedAt: "invalid" }), null);
});
