import test from "node:test";
import assert from "node:assert/strict";
import { codexExecutable } from "../src/codex-executable.js";
test("Windows repair launches the native Codex binary without cmd quoting", () => {
  const binary = codexExecutable(
    "C:\\Program Files\\npm\\codex.cmd",
    "win32",
    () => true,
  );
  assert.match(binary, /^C:\\Program Files\\npm\\node_modules\\/);
  assert.ok(binary.endsWith("\\bin\\codex.exe"));
  assert.equal(codexExecutable("codex", "linux"), "codex");
  assert.equal(
    codexExecutable("D:\\tools\\codex.exe", "win32"),
    "D:\\tools\\codex.exe",
  );
  assert.throws(
    () => codexExecutable("C:\\npm\\codex.cmd", "win32", () => false),
    { code: "CODEX_BINARY_MISSING" },
  );
});
