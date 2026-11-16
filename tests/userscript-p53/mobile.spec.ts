import { test, expect, firefox, chromium, type BrowserContext, type Page } from "@playwright/test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
const script = readFileSync("userscripts/hdu-p53-2000-single.user.js", "utf8");
const oldScript = readFileSync("userscripts/hdu-p51.user.js", "utf8");
const origin = "https://hdu.huitu.zhishulib.com";
const OPEN = Date.parse("2026-11-17T20:00:00+08:00");
const BEGIN = Date.parse("2026-11-19T08:00:00+08:00") / 1000;
const account = createHash("sha256").update("HDU-P5.1:9876543210").digest("hex");
const key = `${account}:2026-11-19:08:00-22:00`;
const history = {
  key: account,
  attempts: 1,
  state: "SUCCESS",
  recordVerified: true,
  mapping: {
    floorId: 1558,
    room: "宋韵云图（四楼）",
    seats: [
      { number: "162", id: "62726", free: true },
      { number: "157", id: "62721", free: true },
    ],
  },
  selection: { date: "2026-11-17", hour: 10, hours: 1, seat: "157" },
  logs: [{ code: "HISTORY_MUST_SURVIVE" }],
};
async function mock(context: BrowserContext) {
  const state = {
    writes: [] as URLSearchParams[],
    requests: [] as string[],
    record: true,
    conflict: false,
    session: true,
    status: 200,
    response: { CODE: "ok", DATA: { result: "success" } } as object,
    seatId: "62726",
    timeout: false,
    delay: false,
    sentCookie: false,
    recordDelay: false,
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
        body: "<!doctype html><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>P5.3 Mock</title><p>官网接口模拟</p>",
      });
    state.requests.push(url.pathname);
    const headers = await req.allHeaders();
    state.sentCookie ||= headers.cookie?.includes("mock_session=synthetic-only") || false;
    const serverTime = await req
      .frame()
      .page()
      .evaluate(() => Date.now());
    const json = (body: object, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { Date: new Date(serverTime).toUTCString() },
        body: JSON.stringify(body),
      });
    if (url.pathname === "/User/Center/baseInfo")
      return json({ DATA: { is_login: state.session, uid: "9876543210", name: "SECRET_NAME" } });
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
            advance_date: 1794844800,
            max_date: 1795017600,
            minBeginTime: 7,
            maxEndTime: 22,
            min_duration: 1,
            max_duration: 15,
            max_num: 4,
          },
          space_category: { category_id: "3", content_id: "93" },
        },
      });
    const form = new URLSearchParams(req.postData() || "");
    if (url.pathname === "/Seat/Index/searchSeats") {
      expect(Number(form.get("beginTime"))).toBeLessThan(Date.parse("2026-11-19T00:00:00+08:00") / 1000);
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
                    seatMap: { info: { id: 1558 }, POIs: [{ title: "162", id: state.seatId, state: "1" }] },
                  },
                ],
              },
            },
          ],
        },
      });
    }
    if (url.pathname === "/Seat/Index/bookSeats") {
      expect(serverTime).toBeGreaterThanOrEqual(OPEN);
      expect(form.get("duration")).toBe("50400");
      expect(form.get("beginTime")).toBe(String(BEGIN));
      expect(form.get("seats[0]")).toBe("62726");
      expect(form.get("is_recommend")).toBe("0");
      expect(form.has("seats[1]")).toBe(false);
      const source = `post&/Seat/Index/bookSeats?LAB_JSON=1&api_time${form.get("api_time")}&beginTime${BEGIN}&duration50400&is_recommend0&seatBookers[0]9876543210&seats[0]62726`;
      expect(headers["api-token"]).toBe(
        Buffer.from(createHash("md5").update(source).digest("hex")).toString("base64"),
      );
      state.writes.push(form);
      // A durable intent must already exist when the real fetch is invoked.
      const row = await formalRow(req.frame().page());
      expect(row?.attempts).toBe(1);
      if (state.timeout || state.delay) return; // Route stays unresolved; AbortController is exercised.
      return json(state.response, state.status);
    }
    if (url.pathname === "/Seat/Index/myBookingList") {
      if (state.recordDelay && state.writes.length) return;
      return json({
        content: {
          defaultItems:
            (state.writes.length && state.record) || state.conflict
              ? [{ status: 0, time: BEGIN, duration: 50400, seatNum: "162", roomName: "宋韵云图（四楼）" }]
              : [],
        },
      });
    }
    throw new Error(`Forbidden endpoint: ${url.pathname}`);
  });
  return state;
}
async function seed(page: Page) {
  await page.evaluate(async (row) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open("hdu-p51-single-write", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("attempts", { keyPath: "key" });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction("attempts", "readwrite");
      tx.objectStore("attempts").put(row);
      tx.oncomplete = () => resolve();
    });
    db.close();
  }, history);
}
async function dbRow(page: Page, database: string, store: string, id: string) {
  return page.evaluate(
    async ({ database, store, id }) => {
      const db = await new Promise<IDBDatabase>((resolve) => {
        const r = indexedDB.open(database);
        r.onsuccess = () => resolve(r.result);
      });
      const value = await new Promise<Record<string, unknown> | null>((resolve) => {
        const r = db.transaction(store, "readonly").objectStore(store).get(id);
        r.onsuccess = () => resolve(r.result || null);
      });
      db.close();
      return value;
    },
    { database, store, id },
  );
}
const formalRow = (p: Page) => dbRow(p, "hdu-p53-formal-booking", "tasks", key);
const host = (p: Page) => p.locator("#hdu-p53-host");
async function load(page: Page, withHistory = true) {
  await page.clock.install({ time: OPEN - 31000 });
  await page.clock.pauseAt(OPEN - 30000);
  await page.goto(`${origin}/#!/Space/Category/list`);
  if (withHistory) await seed(page);
  await page.addScriptTag({ content: script });
}
async function expand(page: Page) {
  await host(page).getByRole("button", { name: "P5.3 · 162", exact: true }).tap();
}
async function arm(page: Page) {
  await host(page).locator("#arm").check();
  await host(page).getByRole("button", { name: "准备抢座", exact: true }).tap();
  await expect(host(page).locator("#state")).toContainText("已授权待命");
}
async function release(page: Page) {
  await page.clock.runFor(30400);
}

test("read-only install: collapsed, touch layout, same-origin session, old-slot mapping, unchanged history", async ({
  page,
  context,
}, info) => {
  const state = await mock(context);
  await load(page);
  expect(script).toMatch(/^\/\/ ==UserScript==/);
  expect(script).not.toMatch(/@require|document\.cookie|GM_xmlhttpRequest|lockSeats|cancelBooking/);
  await expect(host(page).locator("#panel")).toBeHidden();
  await expand(page);
  await expect(host(page).locator("#arm")).not.toBeChecked();
  await host(page).getByRole("button", { name: "准备抢座", exact: true }).tap();
  await expect(host(page).locator("#state")).toContainText("只读演练通过");
  expect(state.writes).toHaveLength(0);
  expect(state.sentCookie).toBe(true);
  await expect(host(page).locator("#checks")).toContainText("162 → 62726");
  expect(await dbRow(page, "hdu-p51-single-write", "attempts", account)).toEqual(history);
  expect(await formalRow(page)).toBeNull();
  const dimensions = await host(page)
    .locator("#panel")
    .evaluate((e) => ({ scroll: e.scrollWidth, client: e.clientWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client);
  expect(await host(page).textContent()).not.toMatch(/9876543210|SECRET_NAME|synthetic-only/);
  await page.screenshot({ path: `artifacts/p53/${info.project.name}-readonly.png` });
  await release(page);
  expect(state.writes).toHaveLength(0);
});
test("20:00 gates, durable intent, 14h signature, official record verification, double tap", async ({
  page,
  context,
}) => {
  const state = await mock(context);
  await load(page);
  await expand(page);
  await arm(page);
  await page.clock.runFor(29000);
  expect(state.writes).toHaveLength(0);
  await page.clock.runFor(1000);
  expect(state.writes).toHaveLength(0);
  await page.clock.runFor(400);
  await expect(host(page).locator("#state")).toContainText("SUCCESS");
  expect(state.writes).toHaveLength(1);
  await page.clock.runFor(1000);
  expect(state.writes).toHaveLength(1);
  const row = await formalRow(page);
  expect(row?.state).toBe("SUCCESS");
  expect(row?.attempts).toBe(1);
  expect(await dbRow(page, "hdu-p51-single-write", "attempts", account)).toEqual(history);
  const afterMap = state.requests.indexOf("/Seat/Index/bookSeats");
  expect(state.requests[afterMap - 1]).toBe("/Seat/Index/myBookingList");
});
for (const [name, status, response, result] of [
  ["404", 404, {}, "UNKNOWN"],
  [
    "occupied",
    200,
    { CODE: "ParamError", MESSAGE: "选择的座位无法预约，可能座位不可用或已经被其他人锁定或占用" },
    "FAILED",
  ],
  ["date not open", 200, { CODE: "ParamError", MESSAGE: "超出可预约座位时间范围" }, "FAILED"],
  ["rate limited", 429, {}, "FAILED"],
] as const)
  test(`${name}: at most one POST, no fallback and no repeat after refresh`, async ({ page, context }) => {
    const state = await mock(context);
    state.status = status;
    state.response = response;
    state.record = false;
    await load(page);
    await expand(page);
    await arm(page);
    await release(page);
    await expect.poll(() => state.writes.length).toBe(1);
    await expect(host(page).locator("#state")).toContainText(result);
    expect(state.writes).toHaveLength(1);
    // UNKNOWN is also shown while fetch is still pending. Wait for the response
    // and its single automatic read before checking reload recovery.
    if (status !== 429)
      await expect
        .poll(async () => ((await formalRow(page))?.timings as { verificationMs?: number })?.verificationMs)
        .toBeDefined();
    else await expect.poll(async () => (await formalRow(page))?.state).toBe("FAILED");
    await page.reload();
    await page.addScriptTag({ content: script });
    await expand(page);
    await host(page).getByRole("button", { name: "查看结果", exact: true }).tap();
    await expect(host(page).locator("#state")).toContainText(result);
    await page.clock.runFor(1000);
    expect(state.writes).toHaveLength(1);
  });
test("actual transport timeout: UNKNOWN and only one POST", async ({ page, context }) => {
  const state = await mock(context);
  state.timeout = true;
  state.record = false;
  await load(page);
  await expand(page);
  await arm(page);
  await release(page);
  await expect.poll(() => state.writes.length).toBe(1);
  await page.clock.runFor(30001);
  await expect(host(page).locator("#state")).toContainText("UNKNOWN");
  await expect(host(page).locator("#logs")).toContainText("TIMEOUT");
  expect(state.writes).toHaveLength(1);
});
test("success response with delayed record remains UNKNOWN, manual read can confirm", async ({
  page,
  context,
}) => {
  const state = await mock(context);
  state.record = false;
  await load(page);
  await expand(page);
  await arm(page);
  await release(page);
  await expect(host(page).locator("#logs")).toContainText("SERVER_SUCCESS");
  await expect.poll(async () => (await formalRow(page))?.verifications).toBe(1);
  await page.clock.runFor(3000);
  state.record = true;
  await host(page).getByRole("button", { name: "查看结果", exact: true }).tap();
  await expect(host(page).locator("#state")).toContainText("SUCCESS");
  expect(state.writes).toHaveLength(1);
});
for (const cause of ["conflict", "mapping", "no history", "auth"])
  test(`${cause}: fail closed with zero writes`, async ({ page, context }) => {
    const state = await mock(context);
    if (cause === "conflict") state.conflict = true;
    if (cause === "mapping") state.seatId = "wrong";
    if (cause === "auth") state.session = false;
    await load(page, cause !== "no history");
    await expand(page);
    await host(page).locator("#arm").check();
    await host(page).getByRole("button", { name: "准备抢座", exact: true }).tap();
    await expect(host(page).locator("#state")).toContainText("已停止");
    await release(page);
    expect(state.writes).toHaveLength(0);
  });
test("two tabs reserve concurrently: one formal task and at most one POST", async ({ page, context }) => {
  const state = await mock(context);
  await load(page);
  const other = await context.newPage();
  await load(other, false);
  await expand(page);
  await expand(other);
  await host(page).locator("#arm").check();
  await host(other).locator("#arm").check();
  await Promise.all([host(page).locator("#prepare").tap(), host(other).locator("#prepare").tap()]);
  await expect.poll(async () => (await formalRow(page))?.state).toBe("WAITING");
  await Promise.all([release(page), release(other)]);
  await expect.poll(() => state.writes.length).toBe(1);
  expect((await formalRow(page))?.attempts).toBe(1);
});
test("stop in another tab before release prevents all writes", async ({ page, context }) => {
  const state = await mock(context);
  await load(page);
  await expand(page);
  await arm(page);
  const other = await context.newPage();
  await load(other, false);
  await expand(other);
  await host(other).getByRole("button", { name: "停止自动任务", exact: true }).tap();
  await release(page);
  await release(other);
  expect(state.writes).toHaveLength(0);
  await expect(host(page).locator("#state")).toContainText("已停止");
});
test("stop during POST: aborted transport, durable UNKNOWN, no cancellation endpoint", async ({
  page,
  context,
}) => {
  const state = await mock(context);
  state.delay = true;
  state.record = false;
  await load(page);
  await expand(page);
  await arm(page);
  await release(page);
  await expect.poll(() => state.writes.length).toBe(1);
  await host(page).getByRole("button", { name: "停止自动任务", exact: true }).tap();
  await expect(host(page).locator("#state")).toContainText("UNKNOWN");
  await page.clock.runFor(31000);
  expect(state.writes).toHaveLength(1);
  expect((await formalRow(page))?.attempts).toBe(1);
});
test("visibility suspension and return never resume; reload retains STOPPED", async ({ page, context }) => {
  const state = await mock(context);
  await load(page);
  await expand(page);
  await arm(page);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(host(page).locator("#state")).toContainText("已停止");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await release(page);
  expect(state.writes).toHaveLength(0);
  await page.reload();
  await page.addScriptTag({ content: script });
  await expand(page);
  await host(page).locator("#review").tap();
  await expect(host(page).locator("#state")).toContainText("已停止");
});
test("P5.2 simultaneously installed cannot submit with spent receipt; history preserved", async ({
  page,
  context,
}) => {
  const state = await mock(context);
  await load(page);
  await page.addScriptTag({ content: oldScript });
  const old = page.locator("#hdu-p51-panel");
  await old.locator("#toggle").tap();
  await old.locator("#dates").tap();
  await expect(old.locator("#date")).not.toHaveValue("");
  await old.locator("#prepare").tap();
  await expect(old.locator("#status")).toContainText("一次测试额度");
  await expect(old.locator("#submit")).toBeDisabled();
  await old.locator("#toggle").tap();
  await expand(page);
  await arm(page);
  await release(page);
  await expect(host(page).locator("#state")).toContainText("SUCCESS");
  expect(state.writes).toHaveLength(1);
  expect(await dbRow(page, "hdu-p51-single-write", "attempts", account)).toEqual(history);
});

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructured fixtures even when none are used.
test("persistent browser profile survives full close/reopen with UNKNOWN budget and P5.2 history", async ({}, info) => {
  const directory = mkdtempSync(join(tmpdir(), "hdu-p53-profile-"));
  const type = info.project.use.browserName === "firefox" ? firefox : chromium;
  let context: BrowserContext | undefined;
  try {
    context = await type.launchPersistentContext(directory, {
      headless: true,
      viewport: { width: 412, height: 915 },
      hasTouch: true,
    });
    let state = await mock(context);
    state.status = 404;
    state.record = false;
    let page = await context.newPage();
    await load(page);
    await expand(page);
    await arm(page);
    await release(page);
    await expect.poll(() => state.writes.length).toBe(1);
    await expect
      .poll(async () => ((await formalRow(page))?.timings as { verificationMs?: number })?.verificationMs)
      .toBeDefined();
    await context.close();
    context = await type.launchPersistentContext(directory, {
      headless: true,
      viewport: { width: 412, height: 915 },
      hasTouch: true,
    });
    state = await mock(context);
    state.record = false;
    page = await context.newPage();
    await load(page, false);
    await expand(page);
    await host(page).locator("#review").tap();
    await expect(host(page).locator("#state")).toContainText("UNKNOWN");
    expect((await formalRow(page))?.attempts).toBe(1);
    expect(await dbRow(page, "hdu-p51-single-write", "attempts", account)).toEqual(history);
    await host(page).locator("#arm").check();
    await host(page).locator("#prepare").tap();
    // Firefox also delivers pagehide on full close: its stop tombstone is an
    // additional valid reason to reject rearming; neither path spends again.
    await expect(host(page).locator("#explain")).toContainText(/已存在正式任务|已停止/);
    await release(page);
    expect(state.writes).toHaveLength(0);
  } finally {
    await context?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
