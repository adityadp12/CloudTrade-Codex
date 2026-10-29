import { test, expect } from "@playwright/test";
import { analyzeSymbol } from "../src/market-analysis.js";

const terminalId = "970eb0d8-02ae-4784-94dc-f15709710196";
function marketFixture() {
  const time = Math.floor(Date.now() / 1000);
  const frames = Object.fromEntries(
    [
      ["M5", 300],
      ["M15", 900],
      ["H1", 3600],
      ["H4", 14400],
    ].map(([key, seconds]) => [
      key,
      Array.from({ length: 80 }, (_, i) => ({
        time: time - (80 - i) * seconds,
        open: 2000 + i,
        close: 2000.8 + i,
        high: 2001.5 + i,
        low: 1999 + i,
        tickVolume: i === 79 ? 200 : 100,
        realVolume: 0,
      })),
    ]),
  );
  return {
    status: "ready",
    capturedAt: new Date().toISOString(),
    availableSymbols: ["XAUUSD", "EURUSD"],
    symbols: [
      analyzeSymbol({
        symbol: "XAUUSD",
        frames,
        tick: { time, bid: 2080, ask: 2080.2 },
        book: [],
      }),
    ],
  };
}
async function fixtures(page, { offline = false, failures = false } = {}) {
  const errors = [],
    unexpected = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  let aiAsked = false;
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const send = (body, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path === "/api/terminals")
      return send({ terminals: [{ id: terminalId, name: "Browser Test" }] });
    if (path.endsWith("/supervisor"))
      return send({
        terminal: {
          name: "Browser Test",
          broker_company: "Test",
          broker_server: "Test",
          broker_login_masked: "***1234",
        },
        telemetry: { equity: 1000, balance: 1000, freeMargin: 900, marginLevel: 500, floatingPnl: 0, spreadPoints: 8 },
        control: {},
        history: [],
        executions: [],
        alerts: [],
      });
    if (failures && path.endsWith("/pnl-calendar"))
      return send({ error: "temporary_failure" }, 503);
    if (path.endsWith("/market"))
      return send(
        offline
          ? {
              status: "unavailable",
              reason: "terminal_not_running",
              symbols: [],
            }
          : marketFixture(),
      );
    if (path === "/api/economic-calendar")
      return send({
        status: offline ? "unavailable" : "ready",
        source: "Test provider",
        fetchedAt: new Date().toISOString(),
        events: offline
          ? []
          : [
              {
                title: "USD CPI <script>invalid</script>",
                currency: "USD",
                time: new Date().toISOString(),
                impact: "High",
                forecast: "2.5%",
                previous: "2.4%",
                actual: null,
              },
              {
                title: "EUR update",
                currency: "EUR",
                time: new Date().toISOString(),
                impact: "Low",
                forecast: "",
                previous: "",
                actual: null,
              },
            ],
      });
    if (path.endsWith("/pnl-calendar")) {
      const month = url.searchParams.get("month"),
        date = `${month}-03`;
      return send({
        month,
        timeZone: url.searchParams.get("timeZone"),
        currency: "USD",
        total: 94,
        closedDeals: 1,
        winRate: 100,
        days: [
          {
            date,
            net: 94,
            gross: 100,
            commission: -4,
            swap: -2,
            fee: 0,
            closedDeals: 1,
            wins: 1,
            executions: [
              {
                dealTicket: "123",
                symbol: "XAUUSD",
                side: "BUY",
                executedAt: `${date}T12:00:00Z`,
                entryType: 1,
                net: 94,
              },
            ],
          },
        ],
      });
    }
    if (path.endsWith("/market-ai")) {
      if (request.method() === "POST") {
        aiAsked = true;
        return send({ status: "running" }, 202);
      }
      return send(
        aiAsked
          ? {
              status: "ready",
              snapshotAt: new Date().toISOString(),
              result: {
                summary: "The trend has supporting volume.",
                symbols: [
                  {
                    symbol: "XAUUSD",
                    direction: "BUY",
                    reason: "M15/H1 aligned.",
                    invalidation: "Below support.",
                    newsContext: "Watch scheduled news.",
                  },
                ],
              },
            }
          : { status: "idle" },
      );
    }
    unexpected.push(path);
    return send({ error: "unexpected_api" }, 404);
  });
  return { errors, unexpected };
}

test("market, AI, economic filters and daily PNL work without script errors", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const { errors, unexpected } = await fixtures(page);
  await page.goto(`/terminal/${terminalId}`);
  await expect(page.locator("#maxLoss")).not.toBeVisible();
  await page.getByText("Account risk controls", { exact: true }).click();
  await expect(page.locator("#maxLoss")).toBeVisible();
  await page.getByText("Account risk controls", { exact: true }).click();
  await page.locator("#historyDetails > summary").click();
  await expect(page.locator("#mainChart")).toBeVisible();
  await page.locator("#historyDetails > summary").click();
  await expect(page.locator("#marketCards")).toContainText("BUY");
  await expect(page.locator("#marketCards")).toContainText("Tick volume");
  await expect(page.locator("#marketCards")).toContainText("Not supplied");
  await page.getByRole("button", { name: "Ask AI", exact: true }).click();
  await expect(page.locator("#marketAi")).toContainText("AI commentary", {
    timeout: 12000,
  });
  await page
    .getByRole("tab", { name: "Economic calendar", exact: true })
    .click();
  await expect(page.locator("#economicRows tr")).toHaveCount(2);
  await page.locator("#economicCurrency").selectOption("USD");
  await expect(page.locator("#economicRows tr")).toHaveCount(1);
  await expect(page.locator("#economicRows")).toContainText(
    "<script>invalid</script>",
  );
  await expect(page.locator("#economicRows script")).toHaveCount(0);
  await page.getByRole("tab", { name: "PNL calendar", exact: true }).click();
  await expect(page.locator("#pnlSummary")).toContainText("94 USD");
  await page.locator("#pnlMonth").fill("2026-02");
  await expect(page.locator(".pnl-day")).toHaveCount(28);
  await page.locator('[data-date="2026-02-03"]').click();
  await expect(page.locator("#pnlDayDetails")).toContainText("XAUUSD");
  await page.locator("#pnlTimezone").selectOption("UTC");
  await expect(page.locator("#pnlStatus")).toContainText("UTC");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflow).toBe(false);
  await page.screenshot({ path: test.info().outputPath("terminal-compact.png"), fullPage: true, animations: "disabled" });
  expect(errors).toEqual([]);
  expect(unexpected).toEqual([]);
});

test("offline data is explicit, AI is disabled, and Indonesian navigation works", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("cloudtrade_language", "id"),
  );
  const { errors } = await fixtures(page, { offline: true });
  await page.goto(`/terminal/${terminalId}`);
  await expect(page.locator("#marketStatus")).toContainText(
    "Terminal sedang offline",
  );
  await expect(page.locator("#runMarketAi")).toBeDisabled();
  await page
    .getByRole("tab", { name: "Kalender ekonomi", exact: true })
    .click();
  await expect(page.locator("#economicStatus")).toContainText(
    "bukan konfirmasi",
  );
  await page.getByRole("tab", { name: "Kalender PNL", exact: true }).click();
  await expect(page.locator("#pnlCalendar")).toBeVisible();
  expect(errors).toEqual([]);
});

test("PNL errors show a retry state without repeatedly requesting the failing endpoint", async ({
  page,
}) => {
  let calls = 0;
  await fixtures(page, { failures: true });
  page.on("request", (request) => {
    if (request.url().includes("/pnl-calendar")) calls++;
  });
  await page.goto(`/terminal/${terminalId}`);
  await page.getByRole("tab", { name: "PNL calendar", exact: true }).click();
  await expect(page.locator("#pnlStatus")).toContainText("Unable to refresh");
  await page.waitForTimeout(600);
  expect(calls).toBe(1);
  await expect(page.locator("#pnlCalendar")).toBeEmpty();
});
