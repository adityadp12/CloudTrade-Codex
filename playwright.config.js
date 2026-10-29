import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./browser-tests",
  fullyParallel: false,
  use: {
    baseURL: "http://127.0.0.1:18191",
    channel: "chrome",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command: "node browser-tests/server.mjs",
    url: "http://127.0.0.1:18191",
    reuseExistingServer: false,
  },
});
