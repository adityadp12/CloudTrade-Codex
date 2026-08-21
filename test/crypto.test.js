import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
process.env.JWT_SECRET = "test-jwt-secret-with-at-least-32-characters";
process.env.CREDENTIALS_MASTER_KEY = "11".repeat(32);

const { encryptSecret, decryptSecret, newTelemetryToken, tokenHash } = await import("../src/crypto.js");

test("terminal credentials encrypt and decrypt without plaintext leakage", () => {
  const input = { login: "123456", password: "secret", server: "Broker-Demo" };
  const encrypted = encryptSecret(input);
  assert.ok(!encrypted.includes(input.password));
  assert.deepEqual(decryptSecret(encrypted), input);
});

test("telemetry credentials are unique and hashable", () => {
  const first = newTelemetryToken(), second = newTelemetryToken();
  assert.equal(first.length, 64);
  assert.notEqual(first, second);
  assert.equal(tokenHash(first).length, 64);
});
