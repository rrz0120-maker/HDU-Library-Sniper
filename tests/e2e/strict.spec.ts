import { expect, test } from "@playwright/test";

test("fixed task controls, stop, daily gate and narrow layout", async ({ page }) => {
  let state = "WAITING";
  let starts = 0;
  const status = () => ({
    enabled: true,
    writesAllowed: false,
    validated: false,
    daily: false,
    targetDate: "2026-11-16",
    tasks: starts
      ? [
          {
            date: "2026-11-16",
            state,
            message: state === "FAILED" ? "自动抢座已停止，请手动选择其他座位。" : "等待北京时间 20:00",
            attempts: [],
            updatedAt: Date.now() / 1000,
          },
        ]
      : [],
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: { authenticated: true, refreshing: false } });
    if (path === "/api/strict/start") {
      starts++;
      return route.fulfill({ json: status() });
    }
    if (path === "/api/strict/stop") {
      state = "STOPPED";
      return route.fulfill({ json: status() });
    }
    if (path === "/api/strict/status") return route.fulfill({ json: status() });
    if (path === "/api/strict/check-login") return route.fulfill({ json: { valid: true, clockSane: true } });
    return route.fulfill({ json: { events: [], bookings: [] } });
  });
  await page.goto("/plans");
  await expect(page.getByRole("heading", { name: "宋韵云图（四楼）" })).toBeVisible();
  await expect(page.getByRole("button", { name: "启用每日自动预约" })).toBeDisabled();
  await page.getByRole("button", { name: "一键开始抢座" }).click();
  await expect(page.getByText("等待 20:00", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消待命 / 停止任务" }).click();
  await expect(page.getByText("已停止，等待手动接管", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "检查登录状态" }).click();
  await expect(page.getByText("登录有效，时钟检查通过")).toBeVisible();
  state = "FAILED";
  await expect(page.getByText("自动抢座已停止，请手动选择其他座位。")).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole("link", { name: "打开官方预约页面" })).toHaveAttribute(
    "href",
    "https://hdu.huitu.zhishulib.com",
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
