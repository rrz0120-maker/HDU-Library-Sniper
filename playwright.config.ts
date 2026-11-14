import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  timeout: 30_000,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "bun run dev --host 127.0.0.1",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 5"] } },
    {
      name: "ipad-portrait",
      testMatch: /strict.spec.ts/,
      use: { ...devices["iPad (gen 7)"], browserName: "webkit" },
    },
    {
      name: "ipad-landscape",
      testMatch: /strict.spec.ts/,
      use: { ...devices["iPad (gen 7) landscape"], browserName: "webkit" },
    },
  ],
});
