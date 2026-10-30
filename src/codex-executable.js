import path from "node:path";
import { existsSync } from "node:fs";

export function codexExecutable(
  command,
  platform = process.platform,
  exists = existsSync,
) {
  if (platform !== "win32" || !/\.(cmd|ps1)$/i.test(command)) return command;
  const binary = path.win32.join(
    path.win32.dirname(command),
    "node_modules",
    "@openai",
    "codex",
    "node_modules",
    "@openai",
    "codex-win32-x64",
    "vendor",
    "x86_64-pc-windows-msvc",
    "bin",
    "codex.exe",
  );
  if (!exists(binary))
    throw Object.assign(new Error("Native Codex executable is unavailable"), {
      code: "CODEX_BINARY_MISSING",
    });
  return binary;
}
