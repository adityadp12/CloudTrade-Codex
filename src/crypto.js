import crypto from "node:crypto";
import { config } from "./config.js";

export function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", config.credentialKey, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}

export function decryptSecret(value) {
  const data = Buffer.from(value, "base64url");
  const decipher = crypto.createDecipheriv("aes-256-gcm", config.credentialKey, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8"));
}

export const newTelemetryToken = () => crypto.randomBytes(32).toString("hex");
export const tokenHash = (token) => crypto.createHash("sha256").update(token).digest("hex");
