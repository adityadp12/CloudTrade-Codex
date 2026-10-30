import test from "node:test";
import assert from "node:assert/strict";
import { runWorkerLoop } from "../src/worker-loop.js";

test("worker survives unavailable database and processes the queued job after recovery", async () => {
  let claims = 0,
    stopped = false;
  const waits = [],
    reports = [],
    executed = [];
  await runWorkerLoop({
    claimJob: async () => {
      claims++;
      if (claims <= 2)
        throw Object.assign(new Error("private connection details"), {
          code: "57P03",
        });
      return { id: "queued" };
    },
    execute: async (job) => {
      executed.push(job.id);
      stopped = true;
    },
    fail: async () => {
      throw new Error("No job should fail before it is claimed");
    },
    wait: async (delay) => waits.push(delay),
    isStopping: () => stopped,
    report: (event, details) => reports.push({ event, details }),
  });
  assert.deepEqual(executed, ["queued"]);
  assert.deepEqual(waits, [3000, 6000]);
  assert.equal(reports.length, 2);
  assert.ok(!JSON.stringify(reports).includes("private connection details"));
});
test("worker continues after a failed job and caps queue retry delay", async () => {
  let calls = 0,
    stopped = false;
  const failed = [],
    waits = [],
    reported = [];
  await runWorkerLoop({
    claimJob: async () => {
      calls++;
      if (calls <= 8) throw new Error("offline");
      return { id: String(calls) };
    },
    execute: async (job) => {
      if (job.id === "9") throw new Error("broker failure");
      stopped = true;
    },
    fail: async (job) => {
      failed.push(job.id);
      throw Object.assign(new Error("offline"), { code: "ECONNRESET" });
    },
    wait: async (delay) => waits.push(delay),
    isStopping: () => stopped,
    report: (event, details) => reported.push({ event, details }),
  });
  assert.deepEqual(failed, ["9"]);
  assert.equal(Math.max(...waits), 30_000);
  assert.equal(reported.at(-1).event, "failure_not_persisted");
});
test("worker idles without busy polling and exits when stopped", async () => {
  let stopped = false;
  await runWorkerLoop({
    claimJob: async () => null,
    execute: async () => assert.fail(),
    fail: async () => assert.fail(),
    wait: async (delay) => {
      assert.equal(delay, 1500);
      stopped = true;
    },
    isStopping: () => stopped,
    report: () => assert.fail(),
  });
});
