import path from "node:path";
import { spawn } from "node:child_process";
import { analyzeSymbol } from "./market-analysis.js";

export function createMarketService(config, spawnProcess = spawn) {
  const cache = new Map();
  let active = 0;
  return async function marketData(terminal, symbols = []) {
    const key = `${terminal.id}:${symbols.join(",")}`;
    const previous = cache.get(key);
    if (previous && previous.expires > Date.now()) return previous.promise;
    if (active >= 2)
      return {
        status: "unavailable",
        reason: "market_reader_busy",
        symbols: [],
      };
    const promise = (async () => {
      active++;
      try {
        if (!terminal.install_path || !terminal.process_id)
          return {
            status: "unavailable",
            reason: "terminal_not_running",
            symbols: [],
          };
        const terminalPath = path.resolve(terminal.install_path);
        const relative = path.relative(
          path.resolve(config.tenantRoot),
          terminalPath,
        );
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
          return {
            status: "unavailable",
            reason: "invalid_terminal_path",
            symbols: [],
          };
        const snapshot = await new Promise((resolve, reject) => {
          const child = spawnProcess(
            config.pythonExe,
            [path.resolve("scripts/market-snapshot.py")],
            { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
          );
          let output = "";
          const timer = setTimeout(() => {
            child.kill();
            reject(new Error("market_timeout"));
          }, 12_000);
          child.stdout.on("data", (chunk) => {
            output += chunk;
            if (output.length > 2_000_000) child.kill();
          });
          child.stderr.resume();
          child.stdin.on("error", () => {});
          child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once("close", () => {
            clearTimeout(timer);
            try {
              resolve(JSON.parse(output));
            } catch {
              reject(new Error("invalid_market_response"));
            }
          });
          child.stdin.end(
            JSON.stringify({
              terminalExe: path.join(terminalPath, "terminal64.exe"),
              processId: terminal.process_id,
              symbols,
            }),
          );
        });
        return {
          status: snapshot.status === "ready" ? "ready" : "unavailable",
          reason: snapshot.reason || null,
          capturedAt: new Date().toISOString(),
          availableSymbols: Array.isArray(snapshot.availableSymbols)
            ? snapshot.availableSymbols
            : [],
          symbols: Array.isArray(snapshot.symbols)
            ? snapshot.symbols.map((symbol) => analyzeSymbol(symbol))
            : [],
        };
      } catch {
        return {
          status: "unavailable",
          reason: "market_reader_unavailable",
          symbols: [],
        };
      } finally {
        active--;
      }
    })();
    if (cache.size >= 200) cache.delete(cache.keys().next().value);
    cache.set(key, { promise, expires: Date.now() + 30_000 });
    return promise;
  };
}
