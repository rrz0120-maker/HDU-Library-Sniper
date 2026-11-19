import { expect, type BrowserContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
export const script = readFileSync("userscripts/hdu-p61-open-confirm.user.js", "utf8");
export const origin = "https://hdu.huitu.zhishulib.com";
export const OPEN = Date.parse("2026-11-18T20:00:00+08:00");
export const BEGIN = Date.parse("2026-11-20T08:00:00+08:00") / 1000;
export const account = createHash("sha256").update("HDU-P5.1:9876543210").digest("hex");
export const key = `${account}:2026-11-20:08:00-22:00`;
export const history = {
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
export async function mock(context: BrowserContext) {
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
    releaseRecords: [] as Array<() => Promise<void>>,
    badRange: false,
    badClock: false,
    openDelayMs: 0,
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
        body: "<!doctype html><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>P6 Mock</title><p>官网接口模拟</p>",
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
        headers: { Date: new Date(serverTime + (state.badClock ? 15000 : 0)).toUTCString() },
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
            advance_date: Date.parse(`${day(serverTime)}T00:00:00+08:00`) / 1000,
            max_date:
              Date.parse(`${day(serverTime)}T00:00:00+08:00`) / 1000 +
              (serverTime >= Date.parse(`${day(serverTime)}T20:00:00+08:00`) + state.openDelayMs ? 3 : 2) * 86400,
            minBeginTime: 7,
            maxEndTime: 22,
            min_duration: 1,
            max_duration: state.badRange ? 1 : 15,
            max_num: 4,
          },
          space_category: { category_id: "3", content_id: "93" },
        },
      });
    const form = new URLSearchParams(req.postData() || "");
    if (url.pathname === "/Seat/Index/searchSeats") {
      expect(Number(form.get("beginTime"))).toBeLessThan(
        Date.parse(`${day(serverTime + 2 * 86400000)}T00:00:00+08:00`) / 1000,
      );
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
      expect(serverTime).toBeGreaterThanOrEqual(Date.parse(`${day(serverTime)}T20:00:00+08:00`));
      expect(form.get("duration")).toBe("50400");
      expect(form.get("beginTime")).toBe(
        String(Date.parse(`${day(serverTime + 2 * 86400000)}T08:00:00+08:00`) / 1000),
      );
      expect(form.get("seats[0]")).toBe("62726");
      expect(form.get("is_recommend")).toBe("0");
      expect(form.has("seats[1]")).toBe(false);
      const source = `post&/Seat/Index/bookSeats?LAB_JSON=1&api_time${form.get("api_time")}&beginTime${form.get("beginTime")}&duration50400&is_recommend0&seatBookers[0]9876543210&seats[0]62726`;
      expect(headers["api-token"]).toBe(
        Buffer.from(createHash("md5").update(source).digest("hex")).toString("base64"),
      );
      state.writes.push(form);
      // A durable intent must already exist when the real fetch is invoked.
      const row = await dbRow(
        req.frame().page(),
        "hdu-p60-daily-booking",
        "tasks",
        `${account}:${day(Number(form.get("beginTime")) * 1000)}:08:00-22:00`,
      );
      expect(row?.attempts).toBe(1);
      if (state.timeout || state.delay) return; // Route stays unresolved; AbortController is exercised.
      return json(state.response, state.status);
    }
    if (url.pathname === "/Seat/Index/myBookingList") {
      const send = () =>
        json({
          content: {
            defaultItems: state.conflict
              ? [{ status: 0, time: BEGIN, duration: 50400, seatNum: "162", roomName: "宋韵云图（四楼）" }]
              : state.record
                ? state.writes.map((f) => ({
                    status: 0,
                    time: Number(f.get("beginTime")),
                    duration: 50400,
                    seatNum: "162",
                    roomName: "宋韵云图（四楼）",
                  }))
                : [],
          },
        });
      if (state.recordDelay && state.writes.length) {
        state.releaseRecords.push(send);
        return;
      }
      return send();
    }
    throw new Error(`Forbidden endpoint: ${url.pathname}`);
  });
  return state;
}
export async function seed(page: Page) {
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
export async function dbRow(page: Page, database: string, store: string, id: string) {
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
export const formalRow = (p: Page) => dbRow(p, "hdu-p60-daily-booking", "tasks", key);
export const host = (p: Page) => p.locator("#hdu-p60-host");
export async function load(page: Page, withHistory = true) {
  await page.clock.install({ time: OPEN - 31000 });
  await page.clock.pauseAt(OPEN - 30000);
  await page.goto(`${origin}/#!/Space/Category/list`);
  if (withHistory) await seed(page);
  await page.addScriptTag({ content: script });
}
export async function expand(page: Page) {
  await host(page)
    .getByRole("button", { name: /162 · 待启动|今日窗口已结束/ })
    .tap();
}
export async function arm(page: Page) {
  await host(page).locator("#authorize").check();
  await host(page).getByRole("button", { name: "启动今日抢座", exact: true }).tap();
  await expect(host(page).locator("#state")).toContainText("162 · 待命");
}
export async function release(page: Page) {
  await page.clock.runFor(30400);
}

export function day(ms: number) {
  return new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
}
