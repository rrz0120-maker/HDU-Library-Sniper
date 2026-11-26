import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { signedRequest } from "../../src/userscript/core.js";
import { resolve162, verified162 } from "../../src/userscript/p53/policy.js";
import { mapBody } from "../userscript-p53/fixtures.mjs";
import {
  bookingResult,
  dailyTask,
  nextCheckMs,
  preparationRange,
  publicDiagnostics,
  restoredReport,
  validateDailyTask,
} from "../../src/userscript/p60/policy.js";
import { DailyStore, recall, remember } from "../../src/userscript/p60/store.js";

const OPEN = Date.parse("2026-11-22T20:00:00+08:00");
const task = dailyTask(OPEN - 60000);
const range = () => ({
  advance_date: "2026-11-22",
  max_date: "2026-11-24",
  minBeginTime: 7,
  maxEndTime: 22,
  min_duration: 1,
  max_duration: 15,
  max_num: 4,
});

class Storage {
  constructor() {
    this.data = new Map();
  }
  getItem(k) {
    return this.data.get(k) ?? null;
  }
  setItem(k, v) {
    this.data.set(k, v);
  }
}
test("P6.0, P6.1.1 and P6.2 produce identical signatures and ordered six-field forms", async () => {
  const historical = [];
  for (const ref of [
    "d144d479c6daeef61314ffe6e72beaf436560291",
    "4313031b6c5059003314de482207ba539e1b06ca",
  ]) {
    const source = execFileSync("git", ["show", `${ref}:src/userscript/core.js`]);
    historical.push(await import(`data:text/javascript;base64,${source.toString("base64")}`));
  }
  const vectors = JSON.parse(readFileSync("tests/fixtures/p53-signatures.json"));
  for (const v of vectors) {
    const args = [v.seatId, v.uid, v.beginTime, v.apiTime, v.duration];
    const actual = signedRequest(...args);
    assert.equal(actual.token, v.token);
    for (const old of historical) {
      assert.equal(old.signedRequest(...args).token, actual.token);
      assert.equal(old.signedRequest(...args).form.toString(), actual.form.toString());
    }
    assert.deepEqual(
      [...actual.form.keys()],
      ["beginTime", "duration", "is_recommend", "api_time", "seats[0]", "seatBookers[0]"],
    );
  }
});
test("all 120 supported time ranges match independently sorted upstream signing contract", () => {
  for (let startHour = 7; startHour < 22; startHour++) {
    for (let endHour = startHour + 1; endHour <= 22; endHour++) {
      const t = dailyTask(OPEN, { startHour, endHour });
      const r = signedRequest(t.seatId, "111", t.begin, OPEN / 1000, t.duration);
      const pairs = [...r.form].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => k + v);
      const src = ["post", "/Seat/Index/bookSeats?LAB_JSON=1", ...pairs].join("&");
      assert.equal(r.token, Buffer.from(createHash("md5").update(src).digest("hex")).toString("base64"));
      assert.equal(r.form.get("duration"), String((endHour - startHour) * 3600));
    }
  }
});
test("default time and custom offset honor Shanghai dates across year boundaries", () => {
  assert.equal(task.duration, 50400);
  assert.equal(task.planned, OPEN + 1350);
  assert.equal(task.begin, Date.parse("2026-11-24T08:00:00+08:00") / 1000);
  const t = dailyTask(Date.parse("2026-12-31T19:59:00+08:00"), { startHour: 9, endHour: 22, offsetMs: 800 });
  assert.equal(t.date, "2027-01-02");
  assert.equal(t.duration, 46800);
  validateDailyTask(t);
  for (const opts of [
    { startHour: 6 },
    { endHour: 23 },
    { startHour: 22 },
    { offsetMs: 799 },
    { offsetMs: 2001 },
    { startHour: 8.5 },
  ])
    assert.throws(() => dailyTask(OPEN, opts));
  assert.throws(() => validateDailyTask({ ...t, seatId: "162" }));
});
test("preflight range accepts first excluded date, validates full duration and never asserts opening", () => {
  preparationRange(range(), task);
  assert.throws(() => preparationRange({ ...range(), max_duration: 13 }, task), /TIME_NOT_ALLOWED/);
  preparationRange({ ...range(), max_duration: 13 }, dailyTask(OPEN, { startHour: 9 }));
  assert.throws(() => preparationRange({ ...range(), max_date: "2026-11-23" }, task), /DATE_RULE_MISMATCH/);
});
test("local checks become finer at 5s and 1.5s with no network clock requirement", () => {
  assert.equal(nextCheckMs(60000), 1000);
  assert.equal(nextCheckMs(5000), 100);
  assert.equal(nextCheckMs(1500), 20);
  assert.equal(nextCheckMs(1), 1);
  assert.equal(nextCheckMs(-500), 0);
});
test("official 162 resolver supplies 62726, never the printed number", () => {
  assert.equal(resolve162(mapBody()).id, task.seatId);
  assert.equal(task.seatId, "62726");
  assert.equal(task.floorId, 1558);
});
test("official record verifier accepts exact active slot, rejects a different duration, seat or status", () => {
  const record = {
    status: 0,
    time: task.begin,
    duration: 50400,
    roomName: task.room,
    seatNum: "162",
    seatId: "62726",
  };
  assert.ok(verified162([record], { room: task.room }, task));
  for (const changes of [
    { status: 3 },
    { duration: 46800 },
    { seatNum: "161" },
    { seatId: "162" },
    { roomName: "其他房间" },
  ])
    assert.equal(verified162([{ ...record, ...changes }], { room: task.room }, task), false);
});

for (const [status, body, expected] of [
  [200, { CODE: "ok", DATA: { result: "success" } }, "SERVER_SUCCESS"],
  [200, { CODE: "ParamError", DATA: { msg: "未到开放时间" }, MESSAGE: "其他" }, "NOT_OPEN"],
  [200, { CODE: "ParamError", MESSAGE: "超出可预约座位时间范围" }, "TIME_RANGE_INVALID"],
  [200, { CODE: "ParamError", MESSAGE: "时间范围参数无效" }, "BUSINESS_REJECTED"],
  [200, { CODE: "ParamError", MESSAGE: "座位不可用" }, "SEAT_UNAVAILABLE"],
  [200, { CODE: "ParamError", MESSAGE: "已有预约，请勿重复预约！" }, "EXISTING"],
  [200, { CODE: "1", MESSAGE: "请求过于频繁，请10分钟后再试" }, "LIMITED"],
  [429, null, "LIMITED"],
  [200, { CODE: "LIMITED" }, "LIMITED"],
  [401, null, "AUTH_REQUIRED"],
  [200, { ui_type: "com.Redirect" }, "AUTH_REQUIRED"],
  [404, { CODE: "NotFound" }, "HTTP_404"],
  [500, { CODE: "ok", DATA: { result: "success" } }, "HTTP_ERROR"],
  [200, { CODE: "ok", MESSAGE: "提交成功" }, "RESPONSE_UNKNOWN"],
  [200, { CODE: "ok", DATA: { result: "fail" } }, "BUSINESS_REJECTED"],
])
  test(`HTTP ${status} / ${expected} / ${JSON.stringify(body)}`, () =>
    assert.equal(bookingResult(body, status), expected));

test("minimal intent survives reload, records unknown count at crash gap, releases after explicit refusal", () => {
  const storage = new Storage();
  const store = new DailyStore("account", storage);
  assert.equal(storage.data.size, 0);
  const undo = store.intent(task, OPEN + 1350);
  const reloaded = new DailyStore("account", storage);
  assert.equal(reloaded.conflict(task).attempts, null);
  assert.equal(reloaded.conflict(dailyTask(OPEN, { startHour: 9 })).state, "UNKNOWN");
  undo();
  assert.equal(new DailyStore("account", storage).conflict(task), undefined);
  store.intent(task, OPEN + 1350);
  store.receipt({
    task,
    state: "FAILED",
    reason: "NOT_OPEN",
    attempts: 1,
    dispatchAt: new Date(OPEN + 1350).toISOString(),
  });
  assert.equal(new DailyStore("account", storage).conflict(task), undefined);
  assert.equal(store.data.nextWrite, OPEN + 11350);
});

test("optional log errors do not affect intent storage and corrupted intent cannot be ignored", (t) => {
  globalThis.localStorage = new Storage();
  globalThis.sessionStorage = {
    getItem() {
      throw Error();
    },
    setItem() {
      throw Error();
    },
  };
  t.after(() => {
    delete globalThis.localStorage;
    delete globalThis.sessionStorage;
  });
  assert.equal(remember({ task }), false);
  assert.equal(recall(), null);
  const store = new DailyStore("x");
  store.intent(task, OPEN);
  assert.equal(store.conflict(task).state, "UNKNOWN");
  localStorage.setItem("x", "bad");
  assert.throws(() => new DailyStore("x"), /INTENT_STORAGE_ERROR/);
});

test("export allowlist strips raw messages, identity, arbitrary codes and values, including restored logs", () => {
  const secret = "PRIVATE_UID_TOKEN";
  const dirty = {
    task,
    uid: secret,
    raw: secret,
    businessCode: secret,
    businessResult: secret,
    reason: secret,
    state: secret,
    dispatchAt: secret,
    attempts: secret,
    accepted: true,
  };
  const clean = publicDiagnostics(dirty);
  assert.ok(!JSON.stringify(clean).includes(secret));
  assert.equal(clean.businessCode, "OTHER");
  const restore = restoredReport({
    ...clean,
    date: task.date,
    startHour: 8,
    endHour: 22,
    offsetMs: 1350,
    uid: secret,
  });
  assert.ok(!JSON.stringify(restore).includes(secret));
});

test("installed P6.2 has no opening proof or iPad implementation dependency; legacy installers keep exact hashes", () => {
  const src = readFileSync("userscripts/HDU_Android_P6.2_Lite.user.js", "utf8");
  assert.ok(src.startsWith("// ==UserScript=="));
  assert.doesNotMatch(
    src,
    /OPEN_RANGE_|openProofGeneration|openingChecks|nextOpeningCheckMono|p70|p71|p73|v9\/|GM_xmlhttpRequest|document\.cookie/,
  );
  for (const file of ["hdu-p60-lite.user.js", "hdu-p611-history-recovery.user.js"]) {
    const original = execFileSync("git", ["show", `4313031:userscripts/${file}`]);
    assert.deepEqual(readFileSync(`userscripts/${file}`), original);
  }
});
