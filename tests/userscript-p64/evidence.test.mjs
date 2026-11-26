import test from "node:test";
import assert from "node:assert/strict";
import {
  publicDiagnostics,
  restoredReport,
  dailyTask,
  receiptMissing,
} from "../../src/userscript/p60/policy.js";
import { DailyStore } from "../../src/userscript/p60/store.js";
import { archive, readHistory } from "../../src/userscript/p60/history.js";

const task = dailyTask(Date.parse("2026-11-25T19:59:00+08:00"));
test("P6.3 classification and version survive restore without reinterpretation", () => {
  const original = {
    version: "6.3.0",
    date: task.date,
    startHour: 8,
    endHour: 22,
    offsetMs: 1350,
    state: "FAILED",
    reason: "NOT_OPEN",
    failureMessage: "超出可预约座位时间范围",
    attempts: 1,
  };
  const snapshot = JSON.stringify(original);
  const restored = restoredReport(original);
  assert.equal(restored.version, "6.3.0");
  assert.equal(restored.classifierVersion, null);
  assert.equal(restored.reason, "NOT_OPEN");
  assert.equal(restored.failureMessage, original.failureMessage);
  assert.equal(restored.missingFields.businessCode, "LEGACY_NOT_RECORDED");
  assert.equal(restored.recordVerified, null);
  assert.equal(JSON.stringify(original), snapshot);
});
test("missing, filtered and malformed fields have different reasons and never leak raw text", () => {
  const secret = "PRIVATE_COOKIE_TOKEN_NAME";
  for (const [body, bad, expected] of [
    [{}, false, "ABSENT"],
    [{ CODE: secret, DATA: { result: secret, msg: secret } }, false, "REDACTED"],
    [null, true, "INVALID_RESPONSE"],
  ]) {
    const missing = receiptMissing(body, bad);
    assert.equal(missing.businessCode, expected);
    const result = publicDiagnostics({
      version: "6.4.0",
      classifierVersion: "p64.1",
      businessCode: body?.CODE,
      businessResult: body?.DATA?.result,
      failureMessage: body?.DATA?.msg,
      missingFields: missing,
      task,
    });
    assert.equal(result.missingFields.businessCode, expected);
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.equal(result.classifierVersion, "p64.1");
  }
  assert.equal(publicDiagnostics({ version: "6.4.0" }).missingFields.httpStatus, "NOT_OBSERVED");
});
test("P6.4 history never writes or truncates P6.3 evidence; pending intent survives", async (t) => {
  const legacy = JSON.stringify([{ version: "6.3.0", runId: "old", reason: "NOT_OPEN" }]);
  const data = new Map([["hdu-p63:history", legacy]]);
  const storage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  const oldLocks = navigator.locks;
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request: async (_key, fn) => fn() },
  });
  t.after(() => {
    delete globalThis.localStorage;
    if (oldLocks) Object.defineProperty(navigator, "locks", { configurable: true, value: oldLocks });
    else delete navigator.locks;
  });
  const store = new DailyStore("account", storage);
  store.intent(task, task.planned, "pending");
  for (let i = 0; i < 32; i++)
    await archive({ runId: String(i), version: "6.4.0", state: "FAILED", reason: "BUSINESS_REJECTED" });
  assert.equal(data.get("hdu-p63:history"), legacy);
  assert.equal(JSON.parse(data.get("hdu-p64:history")).length, 30);
  assert.equal(readHistory(storage).length, 31);
  assert.equal(store.conflict(task).state, "UNKNOWN");
  assert.equal(store.conflict(task).classifierVersion, "p64.1");
});
