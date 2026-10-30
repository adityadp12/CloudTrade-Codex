import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

for (const [name, newline] of [
  ["Windows CRLF", "\r\n"],
  ["LF", "\n"],
]) {
  test(
    `tenant MCP is disabled in ${name} INI without altering other settings`,
    { skip: process.platform !== "win32" },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tradecloud mt5 "));
      const file = join(directory, "assistant.ini");
      const original = [
        "[MCP.MetaTrader]",
        "Enable=1",
        "Key=unchanged-fixture",
        "[MCP.MetaEditor]",
        "Enable=1",
        "[MCP.Custom]",
        "Enable1=1",
        "",
      ].join(newline);
      try {
        await writeFile(file, Buffer.from("\ufeff" + original, "utf16le"));
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            ". $env:CT_CONFIG_HELPER; Disable-TenantMcp $env:CT_CONFIG_FIXTURE",
          ],
          {
            windowsHide: true,
            env: {
              ...process.env,
              CT_CONFIG_HELPER: resolve("scripts/mt5-config.ps1"),
              CT_CONFIG_FIXTURE: file,
            },
          },
        );
        const actual = (await readFile(file)).toString("utf16le");
        assert.equal(
          actual,
          "\ufeff" + original.replaceAll("Enable=1", "Enable=0"),
        );
    } finally {
      assert.equal(resolve(directory, ".."), resolve(tmpdir()));
      await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
