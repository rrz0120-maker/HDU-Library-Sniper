import assert from "node:assert/strict";
import test from "node:test";
import { diagnostic, classify, beijing, initialReport, makeTask } from "../../src/userscript/v10/policy.js";
import { archive, clearHistory, history } from "../../src/userscript/v10/guard.js";
import { networkTiming } from "../../src/userscript/v10/network.js";
import { classify as baseline } from "../../src/userscript/v9/policy.js";

test("V9 classifies generic account refusal as seat unavailable; V10 requires seat evidence", () => {
  const body = { CODE: "ParamError", MESSAGE: "该账户无法预约" };
  assert.equal(baseline(200, body), "SEAT_UNAVAILABLE");
  assert.equal(classify(200, body), "BUSINESS_REJECTED");
});
test("HTTP ambiguity cannot confirm occupancy or success, and a known ban still stops writes", () => {
  const occupied = { CODE: "ParamError", MESSAGE: "座位不可用" };
  assert.equal(baseline(404, occupied), "SEAT_UNAVAILABLE");
  assert.equal(classify(404, occupied), "HTTP_404");
  assert.equal(classify(404, { CODE: "LIMITED" }), "LIMITED");
  assert.equal(classify(400, { CODE: "ok", DATA: { result: "success" } }), "HTTP_UNCERTAIN");
  assert.equal(classify(200, { CODE: "Unrecognized", MESSAGE: "unexpected" }), "RESPONSE_UNKNOWN");
});
test("resource stages need a single attributed entry; missing timestamps remain null", (t) => {
  const sample = {
    initiatorType: "fetch",
    startTime: 10,
    requestStart: 18,
    responseStart: 41,
    responseEnd: 45,
  };
  const entries = t.mock.method(performance, "getEntriesByName", () => [sample]);
  assert.deepEqual(networkTiming(10, 1000, 42), {
    requestStartAt: beijing(1008),
    responseWaitMs: 23,
    responseDownloadMs: 4,
  });
  entries.mock.mockImplementation(() => [sample, sample]);
  assert.deepEqual(networkTiming(10, 1000, 42), {});
  entries.mock.mockImplementation(() => [{ ...sample, responseStart: 0, responseEnd: 0 }]);
  assert.equal(networkTiming(10, 1000, 42).responseWaitMs, null);
  assert.equal(networkTiming(10, 1000, 42).responseDownloadMs, null);
});
test("30 runs, independent update and delete, no raw receipt text on disk", () => {
  const store = {};
  Object.defineProperties(store, {
    getItem: { value: (k) => store[k] ?? null },
    setItem: {
      value: (k, v) => {
        store[k] = v;
      },
    },
    removeItem: { value: (k) => delete store[k] },
  });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
  try {
    const ids = [];
    const task = makeTask("scheduled", 0);
    for (let i = 0; i < 32; i++) {
      const r = initialReport(task);
      ids.push(r.runId);
      Object.assign(r, {
        prepareStartedAt: beijing(1000 + i),
        state: "failed",
        result: "NOT_OPEN",
        failureMessage: "私人信息 未到开放时间",
      });
      archive(r);
    }
    const rows = history();
    assert.deepEqual(
      rows.map((r) => r.runId),
      ids.slice(2).reverse(),
    );
    assert.ok(!JSON.stringify(store).includes("私人信息"));
    assert.equal(rows[0].failureMessage, "未到开放时间");
    archive({ ...rows[10], verification: "absent" });
    assert.equal(history().length, 30);
    store["hdu-v9:guard-test"] = "pending";
    clearHistory();
    assert.deepEqual(history(), []);
    assert.equal(store["hdu-v9:guard-test"], "pending");
  } finally {
    delete globalThis.localStorage;
  }
});
test("previous match and latest absence/error remain independently inspectable", () => {
  const r = {
    result: "TIMEOUT",
    state: "verified",
    verifiedAt: beijing(100),
    recordVerified: true,
    verification: "error",
    sends: 1,
  };
  assert.deepEqual(
    [diagnostic(r).accepted, diagnostic(r).recordVerified, diagnostic(r).failureReason],
    [null, true, "TIMEOUT"],
  );
  assert.equal(diagnostic({ ...r, verification: "absent" }).recordVerified, false);
});

test("deadline stays active after headers; incomplete 200 body remains unconfirmed", async (t) => {
  const { submitPrepared } = await import("../../src/userscript/v10/network.js");
  const task = makeTask("scheduled", Date.now());
  let expire;
  t.mock.method(globalThis, "setTimeout", (fn, ms) => {
    assert.equal(ms, 30000);
    expire = fn;
    return 0;
  });
  const fetchCall = t.mock.method(globalThis, "fetch", async (_, init) => ({
    status: 200,
    headers: new Headers(),
    json: () =>
      new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        queueMicrotask(expire);
      }),
  }));
  const r = initialReport(task);
  const receipt = await submitPrepared(task, "111", r, { beforeSend() {}, onDispatch() {} });
  assert.equal(receipt.result, "TIMEOUT");
  assert.ok(r.responseAt && r.dispatchAt);
  assert.deepEqual([r.httpStatus, r.businessAt, r.sends, fetchCall.mock.callCount()], [200, null, 1, 1]);
});

test("a tab holding an earlier pending snapshot cannot erase a newer official match on review login failure", async () => {
  const { Booking } = await import("../../src/userscript/v10/engine.js");
  const store = {};
  Object.defineProperties(store, {
    getItem: { value: (k) => store[k] ?? null },
    setItem: {
      value: (k, v) => {
        store[k] = v;
      },
    },
    removeItem: { value: (k) => delete store[k] },
  });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
  try {
    const tab = new Booking(() => {}, false);
    const r = initialReport(makeTask("scheduled", Date.now()));
    Object.assign(r, { state: "unknown", result: "PENDING", sends: 1 });
    tab.report = r;
    archive({
      ...r,
      state: "verified",
      result: "SERVER_SUCCESS",
      verification: "matched",
      recordVerified: true,
      verifiedAt: beijing(Date.now()),
    });
    tab.withAccount = async () => {
      throw Object.assign(new Error(), { code: "AUTH_REQUIRED" });
    };
    await tab.review();
    assert.equal(tab.report.verification, "auth");
    assert.equal(history()[0].state, "verified");
  } finally {
    delete globalThis.localStorage;
  }
});
