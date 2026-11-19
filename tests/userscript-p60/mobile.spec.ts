import { test, expect, firefox, chromium } from "@playwright/test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  account,
  history,
  script,
  mock,
  load,
  expand,
  arm,
  release,
  host,
  dbRow,
  formalRow,
} from "./harness";

test("collapsed defaults, same-origin readonly, 360–480px layout and clipboard fallback", async ({
  page,
  context,
}) => {
  const state = await mock(context);
  await load(page);
  await expect(host(page).locator("#panel")).toBeHidden();
  await expect(host(page).locator("#toggle")).toHaveText("162 · 待启动");
  await expand(page);
  await expect(host(page).locator("#authorize")).not.toBeChecked();
  await host(page).locator("#start").tap();
  await expect(host(page).locator("#state")).toHaveText("只读检查通过");
  expect(state.writes).toHaveLength(0);
  expect(state.sentCookie).toBe(true);
  for (const width of [360, 412, 480]) {
    await page.setViewportSize({ width, height: 850 });
    expect(
      await host(page)
        .locator("#panel")
        .evaluate((e) => e.scrollWidth <= e.clientWidth),
    ).toBe(true);
  }
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }),
  );
  await host(page).locator("summary").tap();
  await host(page).locator("#copy").tap();
  await expect(host(page).locator("#logText")).toBeVisible();
  const exported = await host(page).locator("#logText").inputValue();
  expect(JSON.parse(exported).current.date).toBe("2026-11-20");
  expect(exported).not.toMatch(/9876543210|SECRET_NAME|mock_session|synthetic-only|Api-Token/);
  expect(await dbRow(page, "hdu-p51-single-write", "attempts", account)).toEqual(history);
});
test("collapsed feedback: countdown, submitting, accepted before record, local 404/host removal never restarts", async ({
  page,
  context,
}) => {
  const state = await mock(context);
  state.recordDelay = true;
  await load(page);
  await expand(page);
  await arm(page);
  await host(page).locator("#toggle").tap();
  await page.clock.runFor(29000);
  await expect(host(page).locator("#toggle")).toHaveText("162 · 00:01");
  expect(state.writes).toHaveLength(0);
  await page.clock.runFor(1000);
  expect(state.writes).toHaveLength(0);
  await page.clock.runFor(400);
  await expect(host(page).locator("#toggle")).toHaveText("162 · 已受理，正在核验");
  await expect(host(page).locator("#toggle")).toHaveAttribute("data-tone", "active");
  await expect.poll(() => state.releaseRecords.length).toBe(1);
  const pending = await formalRow(page);
  expect(pending?.state).toBe("UNKNOWN");
  expect(pending?.attempts).toBe(1);
  expect(pending?.firstServerSuccessAt).toBeTruthy();
  expect(pending?.firstRecordVerifiedAt).toBeUndefined();
  await page.evaluate(() => {
    document.body.innerHTML = "<h1>404 · 官网局部错误</h1>";
    document.getElementById("hdu-p60-host")?.remove();
  });
  await expect(host(page).locator("#toggle")).toHaveText("162 · 已受理，正在核验");
  expect(state.writes).toHaveLength(1);
  await state.releaseRecords[0]();
  await expect(host(page).locator("#toggle")).toHaveText("162 · 已成功");
  await expect(host(page).locator("#toggle")).toHaveAttribute("data-tone", "success");
  await expect(host(page).locator("#panel")).toBeHidden();
  expect((await formalRow(page))?.recordVerified).toBe(true);
});
test("first events stay immutable on later reviews; clipboard JSON has measured UI diagnostics", async ({
  page,
  context,
}) => {
  const state = await mock(context);
  await load(page);
  await expand(page);
  await arm(page);
  await release(page);
  await expect(host(page).locator("#toggle")).toHaveText("162 · 已成功");
  const first = await formalRow(page);
  for (const field of [
    "prepareStartedAt",
    "armedAt",
    "scheduledAt",
    "firstDispatchAt",
    "firstResponseAt",
    "firstBusinessResultAt",
    "firstServerSuccessAt",
    "firstRecordVerifiedAt",
  ])
    expect(first?.[field], field).toBeTruthy();
  expect(first?.responseCode).toBe("SERVER_SUCCESS");
  await page.clock.fastForward(7200000);
  await host(page).locator("#review").tap();
  await expect.poll(async () => (await formalRow(page))?.lastReviewedAt).toBeTruthy();
  const reviewed = await formalRow(page);
  for (const field of Object.keys(first || {}).filter((k) => k.startsWith("first") || k.endsWith("Ms")))
    expect(reviewed?.[field]).toEqual(first?.[field]);
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (s: string) => {
          Reflect.set(window, "p60Copied", s);
        },
      },
    }),
  );
  await host(page).locator("summary").tap();
  await host(page).locator("#copy").tap();
  await expect(host(page).locator("#logStatus")).toContainText("已复制");
  const data = JSON.parse(await page.evaluate(() => Reflect.get(window, "p60Copied")));
  expect(data.current.firstRecordVerifiedAt).toBe(first?.firstRecordVerifiedAt);
  expect(data.current.uiFeedback.ACCEPTED.domUpdateMs).toBeGreaterThanOrEqual(0);
  expect(data.current.uiFeedback.SUCCESS.stateUpdatedAt).toBeTruthy();
  expect(data.recent).toHaveLength(1);
  expect(state.writes).toHaveLength(1);
});
for (const [name, status, response, result, tone] of [
  ["404", 404, {}, "结果待确认", "unknown"],
  ["unavailable", 200, { CODE: "ParamError", MESSAGE: "座位不可用" }, "失败 · 手动接管", "failed"],
  ["not open", 200, { CODE: "ParamError", MESSAGE: "未到开放时间" }, "失败 · 手动接管", "failed"],
  ["limited", 429, {}, "失败 · 手动接管", "failed"],
  ["accepted but records absent", 200, { CODE: "ok", DATA: { result: "success" } }, "结果待确认", "unknown"],
] as const)
  test(`${name}: immediate safe outcome, one write and refresh cannot rearm`, async ({ page, context }) => {
    const state = await mock(context);
    state.status = status;
    state.response = response;
    state.record = false;
    await load(page);
    await expand(page);
    await arm(page);
    await release(page);
    await expect.poll(() => state.writes.length).toBe(1);
    await expect(host(page).locator("#toggle")).toHaveText(result);
    await expect(host(page).locator("#toggle")).toHaveAttribute("data-tone", tone);
    if (status !== 429) await expect.poll(async () => (await formalRow(page))?.verificationMs).toBeDefined();
    await page.reload();
    await page.addScriptTag({ content: script });
    await expand(page);
    await host(page).locator("#review").tap();
    await expect(host(page).locator("#toggle")).toHaveText(result);
    if (name === "not open") {
      await host(page).locator("#stop").tap();
      await expect(host(page).locator("#toggle")).toHaveText(result);
      expect((await formalRow(page))?.state).toBe("FAILED");
    }
    expect(state.writes).toHaveLength(1);
  });
test("delayed opening requires a fresh positive range after a one-second read interval", async ({
  page,
  context,
}) => {
  const state = await mock(context);
  state.openDelayMs = 1000;
  await load(page);
  await expand(page);
  await arm(page);
  await page.clock.runFor(30000);
  expect(state.openingReads).toHaveLength(0);
  await page.clock.runFor(400);
  await expect(host(page).locator("#reason")).toContainText("馆方尚未列出目标日期");
  expect(state.writes).toHaveLength(0);
  expect((await formalRow(page))?.attempts).toBe(0);
  await page.clock.runFor(1100);
  await expect(host(page).locator("#toggle")).toHaveText("162 · 已成功");
  expect(state.openingReads).toHaveLength(2);
  expect(state.openingReads[1] - state.openingReads[0]).toBeGreaterThanOrEqual(1000);
  expect(state.writes).toHaveLength(1);
  expect((await formalRow(page))?.openConfirmedAt).toBeTruthy();
});

for (const status of [200, 404]) {
  test(`closed date or opening query ${status}: bounded reads and zero booking`, async ({
    page,
    context,
  }) => {
    const state = await mock(context);
    state.openDelayMs = 60000;
    state.openReadStatus = status;
    await load(page);
    await expand(page);
    await arm(page);
    await release(page);
    if (status === 200) {
      await expect(host(page).locator("#reason")).toContainText("馆方尚未列出目标日期");
      await page.clock.runFor(1200);
    }
    await expect(host(page).locator("#toggle")).toHaveText("已停止");
    await page.clock.runFor(12000);
    expect(state.openingReads).toHaveLength(status === 200 ? 2 : 1);
    expect(state.writes).toHaveLength(0);
    expect((await formalRow(page))?.attempts).toBe(0);
    await expect(host(page).locator("#manual")).toBeVisible();
    expect(
      await host(page)
        .locator("#manual")
        .evaluate((link) => link.dispatchEvent(new MouseEvent("click", { cancelable: true }))),
    ).toBe(true);
  });
}

test("recover a real P6.0 NOT_OPEN ledger after explicit successful absence review", async ({
  page,
  context,
}) => {
  const state = await mock(context);
  state.record = false;
  state.response = { CODE: "ParamError", MESSAGE: "未到开放时间" };
  await load(page, true, readFileSync("userscripts/hdu-p60-lite.user.js", "utf8"));
  await expand(page);
  await arm(page);
  await release(page);
  await expect(host(page).locator("#toggle")).toHaveText("失败 · 手动接管");
  await host(page).locator("#stop").tap();
  await expect.poll(async () => (await formalRow(page))?.state).toBe("UNKNOWN");
  const old = await formalRow(page);
  expect(old?.reason).toBe("USER_STOPPED");
  await page.reload();
  await page.addScriptTag({ content: script });
  await expand(page);
  await page.clock.runFor(2100);
  state.recordsStatus = 404;
  await host(page).locator("#review").tap();
  await expect(host(page).locator("#reason")).toContainText("READ_CHECK_LIMIT_OR_ERROR");
  expect((await formalRow(page))?.state).toBe("UNKNOWN");
  state.recordsStatus = 200;
  await page.clock.runFor(2100);
  await host(page).locator("#review").tap();
  await expect(host(page).locator("#toggle")).toHaveText("失败 · 手动接管");
  const recovered = await formalRow(page);
  expect(recovered).toMatchObject({
    state: "FAILED",
    reason: "NOT_OPEN",
    attempts: 1,
    verifications: 3,
    firstDispatchAt: old?.firstDispatchAt,
    firstBusinessResultAt: old?.firstBusinessResultAt,
  });
  expect(state.writes).toHaveLength(1);
});
test("timeout and stop in-flight retain UNKNOWN; no cancellation or second write", async ({
  page,
  context,
}) => {
  const state = await mock(context);
  state.timeout = true;
  state.record = false;
  await load(page);
  await expand(page);
  await arm(page);
  await host(page).locator("#toggle").tap();
  await release(page);
  await expect(host(page).locator("#toggle")).toHaveText("162 · 提交中");
  await expect.poll(() => state.writes.length).toBe(1);
  await page.clock.runFor(30001);
  await expect(host(page).locator("#toggle")).toHaveText("结果待确认");
  await host(page).locator("#toggle").tap();
  await host(page).locator("#stop").tap();
  await expect(host(page).locator("#toggle")).toHaveText("结果待确认");
  expect((await formalRow(page))?.attempts).toBe(1);
  expect(state.writes).toHaveLength(1);
});
for (const cause of ["auth", "mapping", "rules", "clock", "conflict", "history"])
  test(`${cause}: preflight failure submits zero`, async ({ page, context }) => {
    const state = await mock(context);
    if (cause === "auth") state.session = false;
    if (cause === "mapping") state.seatId = "wrong";
    if (cause === "rules") state.badRange = true;
    if (cause === "clock") state.badClock = true;
    if (cause === "conflict") state.conflict = true;
    await load(page, cause !== "history");
    await expand(page);
    await host(page).locator("#authorize").check();
    await host(page).locator("#start").tap();
    await expect(host(page).locator("#toggle")).toHaveText("已停止");
    await release(page);
    expect(state.writes).toHaveLength(0);
  });
test("new day clears checked consent; two legal days have independent budgets", async ({ page, context }) => {
  const state = await mock(context);
  await load(page);
  await expand(page);
  await arm(page);
  await release(page);
  await expect(host(page).locator("#toggle")).toHaveText("162 · 已成功");
  await page.clock.fastForward(86400000 - 30400);
  await expect(host(page).locator("#authorize")).not.toBeChecked();
  await expect(host(page).locator("#target")).toContainText("2026-11-19 → 预约 2026-11-21");
  expect(state.writes).toHaveLength(1);
  await arm(page);
  await release(page);
  await expect(host(page).locator("#toggle")).toHaveText("162 · 已成功");
  expect(state.writes).toHaveLength(2);
  expect(state.writes[0].get("beginTime")).not.toBe(state.writes[1].get("beginTime"));
  expect((await formalRow(page))?.attempts).toBe(1);
  expect(
    (await dbRow(page, "hdu-p60-daily-booking", "tasks", `${account}:2026-11-21:08:00-22:00`))?.attempts,
  ).toBe(1);
});
test("checked but unstarted consent does not survive midnight; no catch-up writes", async ({
  page,
  context,
}) => {
  const state = await mock(context);
  await load(page);
  await expand(page);
  await host(page).locator("#authorize").check();
  await page.clock.fastForward(86400000);
  await expect(host(page).locator("#authorize")).not.toBeChecked();
  await release(page);
  expect(state.writes).toHaveLength(0);
  await expect(host(page).locator("#toggle")).toHaveText("今日窗口已结束");
  await host(page).locator("#authorize").check();
  await host(page).locator("#start").tap();
  await expect(host(page).locator("#toggle")).toHaveText("今日窗口已结束");
  expect(state.writes).toHaveLength(0);
});
test("same-account two tabs compete atomically; duplicate start never queues another write", async ({
  page,
  context,
}) => {
  const state = await mock(context);
  await load(page);
  const other = await context.newPage();
  await load(other, false);
  await expand(page);
  await expand(other);
  await host(page).locator("#authorize").check();
  await host(other).locator("#authorize").check();
  await Promise.all([host(page).locator("#start").tap(), host(other).locator("#start").tap()]);
  await expect.poll(async () => (await formalRow(page))?.state).toBe("WAITING");
  await Promise.all([release(page), release(other)]);
  await expect.poll(() => state.writes.length).toBe(1);
  expect((await formalRow(page))?.attempts).toBe(1);
});
test("stop from a fresh tab without login prevents the other tab's authorized write", async ({
  page,
  context,
}) => {
  const state = await mock(context);
  await load(page);
  await expand(page);
  await arm(page);
  const other = await context.newPage();
  await load(other, false);
  await expand(other);
  const count = state.requests.length;
  await host(other).locator("#stop").tap();
  await release(page);
  expect(state.writes).toHaveLength(0);
  expect(state.requests).toHaveLength(count);
  await expect(host(page).locator("#toggle")).toHaveText("已停止");
});
test("UNKNOWN cannot be bypassed next day; explicit readonly review can confirm the old task", async ({
  page,
  context,
}) => {
  const state = await mock(context);
  state.record = false;
  await load(page);
  await expand(page);
  await arm(page);
  await release(page);
  await expect.poll(async () => (await formalRow(page))?.verificationMs).toBeDefined();
  await expect(host(page).locator("#toggle")).toHaveText("结果待确认");
  await page.clock.fastForward(86400000 - 30400);
  await host(page).locator("#authorize").check();
  await host(page).locator("#start").tap();
  await expect(host(page).locator("#reason")).toContainText("往日未决");
  expect(state.writes).toHaveLength(1);
  await host(page).locator("summary").tap();
  await expect(host(page).locator("#recent option")).toHaveCount(2);
  await host(page).locator("#recent").selectOption("2026-11-18");
  state.record = true;
  await host(page).locator("#review").tap();
  await expect(host(page).locator("#toggle")).toContainText("11-20 · 162 · 已成功");
  expect((await formalRow(page))?.state).toBe("SUCCESS");
  expect(state.writes).toHaveLength(1);
});
test("P5.3 success and fixed stop marker do not poison future dates; old databases untouched", async ({
  page,
  context,
}) => {
  const state = await mock(context);
  await load(page);
  const old = {
    key: `${account}:2026-11-19:08:00-22:00`,
    owner: "p53-owner",
    attempts: 1,
    state: "SUCCESS",
    recordVerified: true,
  };
  await page.evaluate(async (row) => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open("hdu-p53-formal-booking", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("tasks", { keyPath: "key" });
      r.onsuccess = () => resolve(r.result);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction("tasks", "readwrite");
      tx.objectStore("tasks").put(row);
      tx.oncomplete = () => resolve();
    });
    db.close();
    localStorage.setItem("hdu-p53:2026-11-19:08:00-22:00:stop", "1");
  }, old);
  await page.addScriptTag({ content: readFileSync("userscripts/hdu-p53-2000-single.user.js", "utf8") });
  await expand(page);
  await arm(page);
  await release(page);
  await expect(host(page).locator("#toggle")).toHaveText("162 · 已成功");
  expect(await dbRow(page, "hdu-p53-formal-booking", "tasks", old.key)).toEqual(old);
  expect(await dbRow(page, "hdu-p51-single-write", "attempts", account)).toEqual(history);
  expect(state.writes).toHaveLength(1);
});
test("legacy P5.3 UNKNOWN blocks new writes without modifying the old record", async ({ page, context }) => {
  const state = await mock(context);
  await load(page);
  const old = { key: `${account}:2026-11-19:08:00-22:00`, attempts: 1, state: "UNKNOWN" };
  await page.evaluate(async (row) => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open("hdu-p53-formal-booking", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("tasks", { keyPath: "key" });
      r.onsuccess = () => resolve(r.result);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction("tasks", "readwrite");
      tx.objectStore("tasks").put(row);
      tx.oncomplete = () => resolve();
    });
    db.close();
  }, old);
  await expand(page);
  await host(page).locator("#authorize").check();
  await host(page).locator("#start").tap();
  await expect(host(page).locator("#reason")).toContainText("P5.3仍有未决");
  await release(page);
  expect(state.writes).toHaveLength(0);
  expect(await dbRow(page, "hdu-p53-formal-booking", "tasks", old.key)).toEqual(old);
});
test("stop differs from collapse and survives reload; background never resumes", async ({
  page,
  context,
}) => {
  const state = await mock(context);
  await load(page);
  await expand(page);
  await arm(page);
  await host(page).locator("#stop").tap();
  await expect(host(page).locator("#toggle")).toHaveText("已停止");
  await release(page);
  expect(state.writes).toHaveLength(0);
  await page.reload();
  await page.addScriptTag({ content: script });
  await expand(page);
  await host(page).locator("#review").tap();
  await expect(host(page).locator("#toggle")).toHaveText("已停止");
  await page.clock.fastForward(86400000 - 30400);
  await arm(page);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await release(page);
  expect(state.writes).toHaveLength(0);
  await expect(host(page).locator("#toggle")).toHaveText("已停止");
});
// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture argument.
test("full browser restart preserves UNKNOWN intent and first response time", async ({}, info) => {
  const dir = mkdtempSync(join(tmpdir(), "hdu-p60-profile-"));
  const type = info.project.use.browserName === "firefox" ? firefox : chromium;
  let context = await type.launchPersistentContext(dir, {
    headless: true,
    viewport: { width: 412, height: 915 },
    hasTouch: true,
  });
  try {
    let state = await mock(context);
    state.status = 404;
    state.record = false;
    let page = await context.newPage();
    await load(page);
    await expand(page);
    await arm(page);
    await release(page);
    await expect.poll(async () => (await formalRow(page))?.verificationMs).toBeDefined();
    const first = await formalRow(page);
    await context.close();
    context = await type.launchPersistentContext(dir, {
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
    await expect(host(page).locator("#toggle")).toHaveText("结果待确认");
    expect((await formalRow(page))?.attempts).toBe(1);
    expect((await formalRow(page))?.firstResponseAt).toBe(first?.firstResponseAt);
    await release(page);
    expect(state.writes).toHaveLength(0);
  } finally {
    await context.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test.describe("non-Shanghai device timezone", () => {
  test.use({ timezoneId: "America/Los_Angeles" });
  test("local device date cannot shift Shanghai target", async ({ page, context }) => {
    const state = await mock(context);
    await load(page);
    await expand(page);
    await expect(host(page).locator("#target")).toContainText("2026-11-18 → 预约 2026-11-20");
    await arm(page);
    await release(page);
    await expect(host(page).locator("#toggle")).toHaveText("162 · 已成功");
    expect(state.writes).toHaveLength(1);
  });
});
