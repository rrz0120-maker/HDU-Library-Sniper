import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/userscript",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  reporter: [["list"], ["json", { outputFile: "artifacts/p51/browser-results.json" }]],
  use: {
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    hasTouch: true,
    userAgent: "Mozilla/5.0 (Android 14; Mobile; rv:153.0) Gecko/153.0 Firefox/153.0",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "firefox-android-viewport", use: { browserName: "firefox" } },
    { name: "chromium-mobile-viewport", use: { browserName: "chromium", isMobile: true } },
  ],
});
