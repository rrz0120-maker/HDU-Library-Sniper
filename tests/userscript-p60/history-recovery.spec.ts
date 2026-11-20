import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { account, arm, dbRow, expand, formalRow, host, load, mock, release, script } from "./harness";

const oldScript = readFileSync("userscripts/hdu-p60-lite.user.js", "utf8");
const p61 = readFileSync("userscripts/hdu-p61-open-confirm.user.js", "utf8");
const nextMorning = Date.parse("2026-11-20T09:04:19+08:00");
const oldKey = `${account}:2026-11-21:08:00-22:00`;
const legacy = (page: Page) => dbRow(page, "hdu-p60-daily-booking", "tasks", oldKey);

async function advanceTo(page: Page, at: number) {
  await page.clock.fastForward(at - (await page.evaluate(() => Date.now())));
}

async function install(page: Page, source: string) {
  await page.reload();
  await page.addScriptTag({ content: source });
  await expand(page);
}

async function selectHistory(page: Page) {
  await host(page).locator("#start").tap();
  await expect(host(page).locator("#reason")).toContainText("往日未决");
  await host(page).locator("summary").tap();
  await host(page).locator("#recent").selectOption("2026-11-19");
}

async function createExhaustedHistory(
  page: Page,
  includePreviousSuccess: boolean,
  state: Awaited<ReturnType<typeof mock>>,
) {
  const at = Date.parse(`2026-11-${includePreviousSuccess ? "18" : "19"}T19:59:30+08:00`);
  await load(page, true, oldScript, at);
  await expand(page);
  if (includePreviousSuccess) {
    await arm(page);
    await release(page);
    await expect(host(page).locator("#toggle")).toHaveText("162 · 已成功");
    await advanceTo(page, Date.parse("2026-11-19T19:59:30+08:00"));
  }
  state.record = false;
  state.response = { CODE: "ParamError", MESSAGE: "未到开放时间" };
  await arm(page);
  await release(page);
  await expect(host(page).locator("#toggle")).toHaveText("失败 · 手动接管");
  await expect
    .poll(() => legacy(page))
    .toMatchObject({ state: "FAILED", reason: "NOT_OPEN", verifications: 1 });
  await host(page).locator("#stop").tap();
  await expect.poll(() => legacy(page)).toMatchObject({ state: "UNKNOWN", reason: "USER_STOPPED" });
  for (const count of [2, 3]) {
    const previousReview = (await legacy(page))?.lastReviewedAt;
    await page.clock.runFor(2100);
    await host(page).locator("#review").tap();
    await expect.poll(async () => (await legacy(page))?.verifications).toBe(count);
    await expect.poll(async () => (await legacy(page))?.lastReviewedAt).not.toBe(previousReview);
  }
  const old = await legacy(page);
  expect(old).toMatchObject({
    attempts: 1,
    state: "UNKNOWN",
    reason: "USER_STOPPED",
    responseCode: "NOT_OPEN",
    verifications: 3,
    uiFeedback: {
      FAILED: { stateUpdatedAt: expect.any(String) },
      UNKNOWN: { stateUpdatedAt: expect.any(String) },
    },
  });
  await advanceTo(page, nextMorning);
  return old!;
}

test("A–E/G: reproduce exhausted P6.0 ledger in P6.1, recover in P6.1.1 and book only once next day", async ({
  page,
  context,
}) => {
  const state = await mock(context);
  const old = await createExhaustedHistory(page, true, state);
  const priorSuccess = await formalRow(page);
  const recordReads = () => state.requests.filter((path) => path.endsWith("/myBookingList")).length;
  await install(page, p61);
  await selectHistory(page);
  const before = recordReads();
  await host(page).locator("#review").tap();
  await expect(host(page).locator("#reason")).toContainText("READ_CHECK_LIMIT_OR_ERROR");
  expect(recordReads()).toBe(before);
  expect((await legacy(page))?.state).toBe("UNKNOWN");
  await install(page, p61);
  await host(page).locator("#start").tap();
  await expect(host(page).locator("#reason")).toContainText("往日未决");
  expect(state.writes).toHaveLength(2);

  await install(page, script);
  await selectHistory(page);
  const other = await context.newPage();
  await load(other, false, script, nextMorning);
  await expand(other);
  await selectHistory(other);
  await Promise.all([host(page).locator("#review").tap(), host(other).locator("#review").tap()]);
  await expect
    .poll(() => legacy(page))
    .toMatchObject({
      state: "FAILED",
      reason: "NOT_OPEN",
      attempts: 1,
      verifications: 3,
      lastVerification: old.lastVerification,
      historyRecoveryChecks: 1,
      verificationResult: "VERIFICATION_RECORD_ABSENT",
      reconciledAt: expect.any(String),
      firstDispatchAt: old.firstDispatchAt,
      firstBusinessResultAt: old.firstBusinessResultAt,
    });
  expect(recordReads() - before).toBe(1);
  for (const tab of [page, other, page]) await host(tab).locator("#stop").tap();
  expect((await legacy(page))?.state).toBe("FAILED");
  await other.close();
  await install(page, script);
  await host(page).locator("#start").tap();
  await expect(host(page).locator("#reason")).toContainText("只读检查通过");
  expect(await dbRow(page, "hdu-p60-daily-booking", "tasks", `${account}:2026-11-22:08:00-22:00`)).toBeNull();
  expect(state.writes).toHaveLength(2);

  await advanceTo(page, Date.parse("2026-11-20T19:59:30+08:00"));
  state.record = true;
  state.response = { CODE: "ok", DATA: { result: "success" } };
  await arm(page);
  await page.clock.runFor(30000);
  expect(state.writes).toHaveLength(2);
  await page.clock.runFor(400);
  await expect(host(page).locator("#toggle")).toHaveText("162 · 已成功");
  await host(page).locator("#stop").tap();
  await host(page).locator("#stop").tap();
  await expect(host(page).locator("#toggle")).toHaveText("162 · 已成功");
  expect(state.writes).toHaveLength(3);
  expect(
    await dbRow(page, "hdu-p60-daily-booking", "tasks", `${account}:2026-11-22:08:00-22:00`),
  ).toMatchObject({ state: "SUCCESS", attempts: 1, recordVerified: true });
  expect(await formalRow(page)).toEqual(priorSuccess);
  expect((await legacy(page))?.state).toBe("FAILED");
});

test("F: official recovery query failure retains UNKNOWN and records the separate read budget", async ({
  page,
  context,
}) => {
  const state = await mock(context);
  const old = await createExhaustedHistory(page, false, state);
  state.recordsStatus = 404;
  await install(page, script);
  await selectHistory(page);
  await host(page).locator("#review").tap();
  await expect(host(page).locator("#reason")).toContainText("官方记录读取失败");
  await expect
    .poll(() => legacy(page))
    .toMatchObject({
      state: "UNKNOWN",
      attempts: 1,
      verifications: 3,
      lastVerification: old.lastVerification,
      historyRecoveryChecks: 1,
      verificationResult: "VERIFICATION_READ_ERROR",
      verificationErrorCode: "HTTP_404",
    });
  state.recordsStatus = 200;
  await host(page).locator("#review").tap();
  await expect(host(page).locator("#reason")).toContainText("补充核验已使用");
  expect((await legacy(page))?.state).toBe("UNKNOWN");
  expect(state.writes).toHaveLength(1);
});
