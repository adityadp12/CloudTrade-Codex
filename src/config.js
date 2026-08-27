import "dotenv/config";
import path from "node:path";

for (const key of ["DATABASE_URL", "JWT_SECRET", "CREDENTIALS_MASTER_KEY"]) {
  if (!process.env[key])
    throw new Error(`Missing required environment variable: ${key}`);
}
if (process.env.JWT_SECRET.length < 32)
  throw new Error("JWT_SECRET must contain at least 32 characters");
if (!/^[a-f0-9]{64}$/i.test(process.env.CREDENTIALS_MASTER_KEY))
  throw new Error("CREDENTIALS_MASTER_KEY must be 64 hexadecimal characters");

export const config = {
  port: Number(process.env.PORT ?? 8090),
  host: process.env.HOST ?? "0.0.0.0",
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
  credentialKey: Buffer.from(process.env.CREDENTIALS_MASTER_KEY, "hex"),
  cookieSecure: process.env.COOKIE_SECURE === "true",
  provisioningEnabled: process.env.PROVISIONING_ENABLED === "true",
  workerId: process.env.WORKER_ID ?? "rdp-worker-01",
  tenantRoot: path.resolve(process.env.TENANT_ROOT ?? "D:\\SaaS\\tenants"),
  goldenImage: path.resolve(
    process.env.MT5_GOLDEN_IMAGE ?? "D:\\Project\\CloudTrade\\HM",
  ),
  pythonExe:
    process.env.PYTHON_EXE ?? "D:\\tools\\python-3.13-embed\\python.exe",
  telemetryBaseUrl: process.env.TELEMETRY_BASE_URL ?? "http://127.0.0.1:8787",
  codexCommand:
    process.env.CODEX_COMMAND ??
    path.join(process.env.APPDATA ?? "", "npm", "codex.cmd"),
};
