import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:1/test";
process.env.JWT_SECRET ??= "test-jwt-secret-with-at-least-32-characters";
process.env.CREDENTIALS_MASTER_KEY ??= "11".repeat(32);

const { default: app } = await import("../src/server.js");

test("responses include browser security headers without framework disclosure", async () => {
  const response = await request(app).get("/").expect(200);
  assert.match(response.headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-powered-by"], undefined);
});

test("UUID route parameters are rejected before reaching the database", async () => {
  const response = await request(app)
    .get("/api/terminals/not-a-uuid/supervisor")
    .expect(400);
  assert.equal(response.body.error, "invalid_id");
});

test("cross-origin authenticated mutations are rejected", async () => {
  const response = await request(app)
    .post("/api/auth/logout")
    .set("Cookie", "cloudtrade_session=fake")
    .set("Origin", "https://attacker.example")
    .set("Host", "cloudtrade.local")
    .expect(403);
  assert.equal(response.body.error, "invalid_origin");
});
