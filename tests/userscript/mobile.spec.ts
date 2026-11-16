import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const script = readFileSync("userscripts/hdu-p51.user.js", "utf8");
const origin = "https://hdu.huitu.zhishulib.com";
const date = new Date(Date.now() + 8 * 3600000 + 86400000).toISOString().slice(0, 10);
async function mocked(context: BrowserContext) {
  const state = {
    writes: [] as URLSearchParams[],
    requests: [] as string[],
    status: 200,
    response: { CODE: "ok", DATA: { result: "success" } } as object,
    success: true,
    occupied: false,
    unknownDate: false,
    numericDates: false,
    realSample: false,
    serverDate: "",
    session: true,
    conflict: false,
    delayWrite: 0,
    delayCatalog: 0,
    cookieUsed: false,
  };
  await context.addCookies([
    {
      name: "mock_session",
      value: "synthetic-only",
      domain: "hdu.huitu.zhishulib.com",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await context.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    expect(url.origin).toBe(origin);
    if (req.isNavigationRequest())
      return route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'><title>Mock official page</title><p>本地接口模拟</p>",
      });
    state.requests.push(url.pathname);
    const headers = await req.allHeaders();
    state.cookieUsed ||= headers.cookie?.includes("mock_session=synthetic-only") || false;
    const form = new URLSearchParams(req.postData() || "");
    const json = (body: object, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { Date: state.serverDate || new Date().toUTCString() },
        body: JSON.stringify(body),
      });
    if (url.pathname === "/User/Center/baseInfo") {
      expect(url.searchParams.has("LAB_JSON")).toBe(false);
      return json({
        CODE: "ok",
        DATA: { is_login: state.session, uid: "9876543210", user_info: { name: "DoNotDisplay" } },
      });
    }
    if (url.pathname === "/Space/Category/list")
      return json({
        content: {
          defaultItems: [
            {
              name: "自习室",
              link: "/Seat/Index/searchSeats?space_category[category_id]=3&space_category[content_id]=93",
            },
          ],
        },
      });
    if (url.pathname === "/Seat/Index/searchSeats" && req.method() === "GET")
      return json({
        data: {
          range: {
            advance_date: state.unknownDate
              ? 0
              : state.realSample
                ? 1794758400
                : state.numericDates
                  ? Date.parse(`${date}T00:00:00+08:00`) / 1000
                  : date,
            max_date: state.unknownDate
              ? 2
              : state.realSample
                ? 1795017600
                : state.numericDates
                  ? Date.parse(`${date}T00:00:00+08:00`) / 1000 + 86400
                  : new Date(Date.parse(`${date}T00:00:00+08:00`) + 8 * 3600000 + 86400000)
                      .toISOString()
                      .slice(0, 10),
            minBeginTime: 7,
            maxEndTime: 22,
            min_duration: 1,
            max_duration: 15,
            max_num: 4,
          },
          space_category: { category_id: "3", content_id: "93" },
        },
      });
    if (url.pathname === "/Seat/Index/searchSeats" && req.method() === "POST") {
      if (state.delayCatalog) await new Promise((resolve) => setTimeout(resolve, state.delayCatalog));
      expect(form.get("duration")).toBe("3600");
      expect(form.get("num")).toBe("1");
      return json({
        allContent: {
          children: [
            {},
            {},
            {
              children: {
                children: [
                  {
                    roomName: "宋韵云图（四楼）",
                    seatMap: {
                      info: { id: 4 },
                      POIs: [
                        { title: "162", id: "id162", state: state.occupied ? "1" : "0" },
                        { title: "157", id: "id157", state: "0" },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        },
      });
    }
    if (url.pathname === "/Seat/Index/bookSeats") {
      const source = `post&/Seat/Index/bookSeats?LAB_JSON=1&api_time${form.get("api_time")}&beginTime${form.get("beginTime")}&duration3600&is_recommend0&seatBookers[0]9876543210&seats[0]${form.get("seats[0]")}`;
      expect(headers["api-token"]).toBe(
        Buffer.from(createHash("md5").update(source).digest("hex")).toString("base64"),
      );
      expect(form.get("duration")).toBe("3600");
      state.writes.push(form);
      if (state.delayWrite) await new Promise((resolve) => setTimeout(resolve, state.delayWrite));
      return json(state.response, state.status);
    }
    if (url.pathname === "/Seat/Index/myBookingList") {
      const written = state.writes[0];
      const booked =
        written && state.success
          ? [
              {
                status: 0,
                time: Number(written.get("beginTime")),
                duration: 3600,
                seatNum: written.get("seats[0]") === "id157" ? "157" : "162",
                roomName: "宋韵云图（四楼）",
              },
            ]
          : state.conflict
            ? [{ status: 0, time: Date.parse(`${date}T07:00:00+08:00`) / 1000, duration: 3600 }]
            : [];
      return json({ content: { defaultItems: booked } });
    }
    throw new Error(`Unexpected endpoint: ${url.pathname}`);
  });
  return state;
}
async function load(page: Page) {
  await page.goto("about:blank");
  await page.goto(`${origin}/#!/Space/Category/list`);
  await page.addScriptTag({ content: script });
  await page.getByRole("button", { name: "P5.2 预约测试", exact: true }).tap();
}
async function prepare(page: Page) {
  await page.getByRole("button", { name: "查询开放日期", exact: true }).tap();
  await expect(page.getByLabel("使用日期", { exact: true })).toHaveValue(date);
  await page.getByRole("button", { name: "准备预约", exact: true }).tap();
  await expect(page.locator("#details")).toBeEnabled();
}
async function confirm(page: Page) {
  await page.locator("#details").check();
  await page.locator("#rules").check();
  await page.getByRole("button", { name: "确认提交一次预约", exact: true }).tap();
}

test("installable header, touch layout, read-only session, dates and mapping", async ({
  page,
  context,
}, info) => {
  expect(script.startsWith("// ==UserScript==")).toBeTruthy();
  expect(script).not.toMatch(/document\.cookie|GM_xmlhttpRequest|@require/);
  const state = await mocked(context);
  await load(page);
  expect(state.requests).toHaveLength(0);
  await page.getByRole("button", { name: "检查登录状态", exact: true }).tap();
  await expect(page.locator("#status")).toContainText("登录有效");
  await prepare(page);
  expect(state.cookieUsed).toBeTruthy();
  expect(state.writes).toHaveLength(0);
  await expect(page.locator("#seats")).toContainText("id162");
  await expect(page.locator("#seats")).toContainText("id157");
  await expect(page.locator("#submit")).toBeDisabled();
  const size = await page.locator("#hdu-p51-panel").evaluate((host) => {
    const section = host.shadowRoot!.querySelector("section")!;
    return {
      width: section.getBoundingClientRect().width,
      scroll: section.scrollWidth,
      client: section.clientWidth,
    };
  });
  expect(size.width).toBeLessThanOrEqual(412 - 16);
  expect(size.scroll).toBeLessThanOrEqual(size.client);
  await page.getByRole("button", { name: "查看运行日志", exact: true }).tap();
  expect(await page.getByLabel("脱敏运行日志").inputValue()).not.toMatch(
    /9876543210|DoNotDisplay|synthetic-only/,
  );
  await page.screenshot({ path: `artifacts/p51/${info.project.name}.png` });
});
test("one explicit confirmation sends one signed same-origin write and verifies exact record", async ({
  page,
  context,
}) => {
  const state = await mocked(context);
  await load(page);
  await prepare(page);
  await page.locator("#details").check();
  await page.locator("#rules").check();
  await page.locator("#submit").evaluate((button: HTMLButtonElement) => button.click());
  expect(state.writes).toHaveLength(0);
  await confirm(page);
  await expect(page.locator("#status")).toContainText("预约成功");
  expect(state.writes).toHaveLength(1);
  await expect(page.locator("#submit")).toBeDisabled();
  await load(page);
  await page.getByRole("button", { name: "查看预约结果", exact: true }).tap();
  await expect(page.locator("#status")).toContainText("预约成功");
  expect(state.writes).toHaveLength(1);
});
test("HTTP404 means UNKNOWN, reload and changing seat cannot replay", async ({ page, context }) => {
  const state = await mocked(context);
  state.status = 404;
  state.success = false;
  await load(page);
  await prepare(page);
  await confirm(page);
  await expect(page.locator("#status")).toContainText("结果待确认");
  await load(page);
  await page.getByRole("button", { name: "查询开放日期", exact: true }).tap();
  await expect(page.getByLabel("使用日期", { exact: true })).toHaveValue(date);
  await page.getByLabel("测试座位", { exact: true }).selectOption("157");
  await page.getByRole("button", { name: "准备预约", exact: true }).tap();
  await expect(page.locator("#status")).toContainText("已使用");
  expect(state.writes).toHaveLength(1);
});
test("numeric date fields reported as actual types and block writes", async ({ page, context }) => {
  const state = await mocked(context);
  state.unknownDate = true;
  await load(page);
  await page.getByRole("button", { name: "查询开放日期", exact: true }).tap();
  await expect(page.locator("#status")).toContainText("日期字段格式尚不支持");
  await page.getByRole("button", { name: "查看运行日志", exact: true }).tap();
  expect(await page.getByLabel("脱敏运行日志").inputValue()).toContain('"type": "number"');
  expect(state.writes).toHaveLength(0);
});
test("occupied seat and changed selection require a fresh preview", async ({ page, context }) => {
  const state = await mocked(context);
  await load(page);
  await prepare(page);
  await page.getByLabel("测试座位", { exact: true }).selectOption("157");
  await expect(page.locator("#submit")).toBeDisabled();
  await expect(page.locator("#details")).not.toBeChecked();
  await page.getByLabel("测试座位", { exact: true }).selectOption("162");
  state.occupied = true;
  await page.getByRole("button", { name: "准备预约", exact: true }).tap();
  await expect(page.locator("#status")).toContainText("不可预约");
  expect(state.writes).toHaveLength(0);
});
test("stop during read prevents preparation; stop in flight remains UNKNOWN without a second request", async ({
  page,
  context,
}) => {
  const state = await mocked(context);
  await load(page);
  await prepare(page);
  state.delayWrite = 700;
  await confirm(page);
  await expect.poll(() => state.writes.length).toBe(1);
  const reads = state.requests.length;
  await page.getByRole("button", { name: "停止当前任务", exact: true }).tap();
  await expect(page.locator("#status")).toContainText("结果待确认");
  expect(state.requests).toHaveLength(reads);
  expect(state.writes).toHaveLength(1);
});
test("IndexedDB claim is atomic across two tabs", async ({ page, context }) => {
  const state = await mocked(context);
  state.success = false;
  state.delayWrite = 300;
  const second = await context.newPage();
  await load(page);
  await load(second);
  await prepare(page);
  await prepare(second);
  await Promise.all([confirm(page), confirm(second)]);
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(page.locator("#submit")).toBeDisabled();
  await expect(second.locator("#submit")).toBeDisabled();
  await second.close();
  expect(state.writes).toHaveLength(1);
});
test("login invalid and rate limit safely stop", async ({ page, context }) => {
  const state = await mocked(context);
  state.session = false;
  await load(page);
  await page.getByRole("button", { name: "检查登录状态", exact: true }).tap();
  await expect(page.locator("#status")).toContainText("登录已失效");
  expect(state.writes).toHaveLength(0);
  state.session = true;
  await prepare(page);
  state.status = 429;
  state.success = false;
  await confirm(page);
  await expect(page.locator("#status")).toContainText("已停止");
  expect(state.writes).toHaveLength(1);
});

test("closing and reopening the browser preserves UNKNOWN write intent", async ({ browserName }) => {
  const { firefox, chromium } = await import("@playwright/test");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const profile = await mkdtemp(join(tmpdir(), "hdu-p51-mock-"));
  const browser = browserName === "firefox" ? firefox : chromium;
  let context = await browser.launchPersistentContext(profile, {
    headless: true,
    hasTouch: true,
    viewport: { width: 412, height: 915 },
  });
  try {
    const first = await mocked(context);
    first.status = 404;
    first.success = false;
    const page = await context.newPage();
    await load(page);
    await prepare(page);
    await confirm(page);
    await expect(page.locator("#status")).toContainText("结果待确认");
    expect(first.writes).toHaveLength(1);
    await context.close();
    context = await browser.launchPersistentContext(profile, {
      headless: true,
      hasTouch: true,
      viewport: { width: 412, height: 915 },
    });
    const second = await mocked(context);
    const again = await context.newPage();
    await load(again);
    await again.getByRole("button", { name: "查询开放日期", exact: true }).tap();
    await expect(again.getByLabel("使用日期", { exact: true })).toHaveValue(date);
    await again.getByRole("button", { name: "准备预约", exact: true }).tap();
    await expect(again.locator("#status")).toContainText("已使用");
    expect(second.writes).toHaveLength(0);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test("P5.2 real timestamp sample lists Nov16-18, then readonly seat query never books", async ({
  page,
  context,
}) => {
  const state = await mocked(context);
  state.realSample = true;
  state.serverDate = "Sun, 15 Nov 2026 22:00:00 GMT";
  // Freeze wall time only; network/performance clocks continue normally.
  await page.clock.setFixedTime(new Date("2026-11-16T06:00:00+08:00"));
  await load(page);
  await page.getByRole("button", { name: "查询开放日期", exact: true }).tap();
  await expect(page.getByLabel("使用日期", { exact: true })).toHaveValue("2026-11-16");
  expect(await page.locator("#date option").allTextContents()).toEqual([
    "2026-11-16",
    "2026-11-17",
    "2026-11-18",
  ]);
  await page.getByLabel("使用日期", { exact: true }).selectOption("2026-11-18");
  await page.getByLabel("开始时间", { exact: true }).selectOption("8");
  await page.getByRole("button", { name: "查询四楼162/157", exact: true }).tap();
  await expect(page.locator("#seats")).toContainText("id162");
  await expect(page.locator("#seats")).toContainText("id157");
  await expect(page.locator("#submit")).toBeDisabled();
  expect(state.writes).toHaveLength(0);
  expect(state.requests).not.toContain("/Seat/Index/bookSeats");
});

test("P5.2 runtime numeric boundaries allow readonly mapping without confirming a booking", async ({
  page,
  context,
}) => {
  const state = await mocked(context);
  state.numericDates = true;
  await load(page);
  await page.getByRole("button", { name: "查询开放日期", exact: true }).tap();
  await expect(page.getByLabel("使用日期", { exact: true })).toHaveValue(date);
  expect(await page.locator("#date option").count()).toBe(1);
  await page.getByRole("button", { name: "查询四楼162/157", exact: true }).tap();
  await expect(page.locator("#seats")).toContainText("id162");
  await expect(page.locator("#seats")).toContainText("id157");
  expect(state.writes).toHaveLength(0);
});
