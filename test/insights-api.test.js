import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { registerInsightsRoutes } from "../src/insights-routes.js";

function fixture() {
  const app = express();
  app.use(express.json());
  let marketCalls = 0;
  registerInsightsRoutes(app, {
    config: {},
    requireAuth(req, res, next) {
      if (!req.get("x-test-user"))
        return res.status(401).json({ error: "authentication_required" });
      req.user = { id: req.get("x-test-user") };
      next();
    },
    query: async (sql, params) => {
      if (sql.includes("FROM terminals"))
        return {
          rows:
            params[1] === "owner" && params[0] === "terminal"
              ? [{ id: "terminal", payload: { currency: "USD" } }]
              : [],
        };
      return {
        rows: [
          {
            payload: {
              dealType: 0,
              entryType: 1,
              profit: 10,
              commission: -1,
              dealTicket: "deal",
            },
            executed_at: "2026-10-29T12:00:00Z",
          },
        ],
      };
    },
    calendar: async () => ({ status: "unavailable", events: [] }),
    market: async () => {
      marketCalls++;
      return {
        status: "unavailable",
        reason: "terminal_not_running",
        symbols: [],
      };
    },
    ai: {
      start() {
        throw new Error("Must not run AI without prices");
      },
      get: () => ({ status: "idle" }),
    },
  });
  return { app, marketCalls: () => marketCalls };
}
test("insights require authentication and enforce terminal ownership before reading market data", async () => {
  const { app, marketCalls } = fixture();
  await request(app).get("/api/economic-calendar").expect(401);
  for (const endpoint of ["market", "pnl-calendar", "market-ai"]) {
    await request(app)
      .get(`/api/terminals/terminal/${endpoint}`)
      .set("x-test-user", "other")
      .expect(404);
  }
  await request(app)
    .post("/api/terminals/terminal/market-ai")
    .set("x-test-user", "other")
    .expect(404);
  assert.equal(marketCalls(), 0);
});
test("offline market data is an explicit state and AI refuses missing prices", async () => {
  const { app } = fixture();
  const response = await request(app)
    .get("/api/terminals/terminal/market")
    .set("x-test-user", "owner")
    .expect(200);
  assert.equal(response.body.reason, "terminal_not_running");
  await request(app)
    .post("/api/terminals/terminal/market-ai")
    .set("x-test-user", "owner")
    .expect(409);
});
test("calendar range validation and net PNL API are correct", async () => {
  const { app } = fixture();
  for (const query of [
    "month=2026-13",
    "month=2026-10&timeZone=invalid",
    "month[]=2026-10",
    "timeZone[]=UTC",
  ]) {
    await request(app)
      .get(`/api/terminals/terminal/pnl-calendar?${query}`)
      .set("x-test-user", "owner")
      .expect(400);
  }
  const response = await request(app)
    .get("/api/terminals/terminal/pnl-calendar?month=2026-10")
    .set("x-test-user", "owner")
    .expect(200);
  assert.equal(response.body.total, 9);
  assert.equal(response.body.currency, "USD");
  await request(app)
    .get("/api/terminals/terminal/market?symbols=../../secret")
    .set("x-test-user", "owner")
    .expect(400);
  await request(app)
    .get("/api/terminals/terminal/market?symbols[]=XAUUSD")
    .set("x-test-user", "owner")
    .expect(400);
});
