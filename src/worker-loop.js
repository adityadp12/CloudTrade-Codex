// Keep the consumer alive across database startup/restarts without treating a
// failed queue read as a failed broker provisioning operation.
export async function runWorkerLoop({
  claimJob,
  execute,
  fail,
  wait,
  isStopping,
  report,
}) {
  let claimFailures = 0;
  while (!isStopping()) {
    let job;
    try {
      job = await claimJob();
      claimFailures = 0;
    } catch (error) {
      claimFailures++;
      report("queue_unavailable", { code: error.code || "QUEUE_ERROR" });
      await wait(Math.min(30_000, 1500 * 2 ** Math.min(claimFailures, 5)));
      continue;
    }
    if (!job) {
      await wait(1500);
      continue;
    }
    try {
      await execute(job);
    } catch (error) {
      try {
        await fail(job, error);
      } catch (reportError) {
        report("failure_not_persisted", {
          jobId: job.id,
          code: reportError.code || "DATABASE_ERROR",
        });
      }
    }
  }
}
