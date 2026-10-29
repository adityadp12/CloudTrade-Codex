export const CALENDAR_SOURCE =
  "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
export function normalizeCalendar(rows) {
  if (!Array.isArray(rows)) throw new Error("invalid_calendar_feed");
  return rows
    .slice(0, 1000)
    .filter(
      (row) =>
        typeof row.title === "string" &&
        /^[A-Z]{3}$/.test(row.country) &&
        Number.isFinite(Date.parse(row.date)),
    )
    .map((row) => ({
      title: row.title.slice(0, 200),
      currency: row.country,
      time: new Date(row.date).toISOString(),
      impact: ["High", "Medium", "Low", "Holiday"].includes(row.impact)
        ? row.impact
        : "Unknown",
      forecast: String(row.forecast ?? "").slice(0, 80),
      previous: String(row.previous ?? "").slice(0, 80),
      actual: row.actual == null ? null : String(row.actual).slice(0, 80),
    }))
    .sort((a, b) => a.time.localeCompare(b.time));
}
export function createCalendarService(fetcher = fetch) {
  let cached,
    pending,
    retryAfter = 0;
  return async function economicCalendar() {
    if (cached && Date.now() < retryAfter) return cached;
    if (pending) return pending;
    pending = (async () => {
      try {
        const response = await fetcher(CALENDAR_SOURCE, {
          signal: AbortSignal.timeout(7000),
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error("calendar_provider_unavailable");
        const events = normalizeCalendar(await response.json());
        if (!events.length) throw new Error("empty_calendar_feed");
        const now = Date.now();
        const current = events.some(
          (event) => Math.abs(Date.parse(event.time) - now) < 7 * 86400_000,
        );
        cached = {
          status: current ? "ready" : "stale",
          source: "Forex Factory / Fair Economy",
          sourceUrl: CALENDAR_SOURCE,
          fetchedAt: new Date().toISOString(),
          events,
          error: current ? null : "calendar_outdated",
        };
        retryAfter = now + 15 * 60_000;
      } catch {
        cached = {
          ...(cached || {
            events: [],
            source: "Forex Factory / Fair Economy",
            sourceUrl: CALENDAR_SOURCE,
            fetchedAt: null,
          }),
          status: cached?.events?.length ? "stale" : "unavailable",
          error: "calendar_provider_unavailable",
        };
        retryAfter = Date.now() + 60_000;
      } finally {
        pending = null;
      }
      return cached;
    })();
    return pending;
  };
}
