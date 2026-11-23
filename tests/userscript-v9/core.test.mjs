import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { BOOK_PATH, bookSeatRequest, signedRequest } from "../../src/userscript/core.js";
import { resolve162 } from "../../src/userscript/p53/policy.js";
import { mapBody } from "../userscript-p53/fixtures.mjs";
import { dailyTask } from "../../src/userscript/p60/policy.js";
import { DAY, SEAT, classify, diagnostic, makeTask, matchesRecord } from "../../src/userscript/v9/policy.js";
import { limitUntil, submitPrepared } from "../../src/userscript/v9/network.js";

const open = Date.parse("2026-11-22T20:00:00+08:00");
const task = makeTask("scheduled", open - 60000);
const sec = (date) => Date.parse(`${date}+08:00`) / 1000;

test("162 resolves uniquely in official seatMap and agrees with the fixed production target", () => {
  const map = mapBody();
  assert.deepEqual(resolve162(map), {
    floorId: SEAT.floorId,
    room: SEAT.room,
    number: SEAT.seat,
    id: SEAT.seatId,
  });
  assert.deepEqual([SEAT.floorId, SEAT.seat, SEAT.seatId], [1558, "162", "62726"]);
  const floor = map.allContent.children[2].children.children[0];
  floor.seatMap.POIs.unshift({ title: "161", id: "162", state: 0 });
  assert.equal(resolve162(map).id, "62726");
  floor.seatMap.POIs.push({ title: "162", id: "999" });
  assert.throws(() => resolve162(map), /MAPPING_INVALID/);
});

test("P6 +2 date policy, adjustable millisecond offset and Shanghai month/year rollover", () => {
  for (const now of [open, open - DAY, Date.parse("2026-12-31T19:59:00+08:00")]) {
    const mobile = dailyTask(now);
    const t = makeTask("scheduled", now, 8, 22, 800);
    assert.deepEqual(
      [t.begin, t.duration, t.date, t.open],
      [mobile.begin, mobile.duration, mobile.date, mobile.open],
    );
    assert.equal(t.planned - t.open, 800);
  }
  assert.equal(task.planned, open + 1200);
  assert.equal(task.begin, sec("2026-11-24T09:00:00"));
  assert.equal(task.duration, 46800);
  assert.equal(makeTask("now", open - 1).date, "2026-11-23");
  assert.equal(makeTask("now", open).date, task.date);
  assert.equal(makeTask("scheduled", open, 7, 22, 2000).duration, 54000);
  for (const args of [
    [9, 9],
    [10, 9],
    [8.5, 19],
    [6, 22],
    [8, 23],
    [9, 22, 799],
    [9, 22, 2001],
  ])
    assert.throws(() => makeTask("scheduled", open, ...args));
});

test("shipped mobile golden vectors match both token and entire encoded form", () => {
  const vectors = JSON.parse(readFileSync("tests/fixtures/p53-signatures.json", "utf8"));
  for (const v of vectors) {
    const args = [v.seatId, v.uid, v.beginTime, v.apiTime, v.duration];
    const r = bookSeatRequest(...args);
    assert.equal(r.token, v.token);
    assert.equal(r.form.toString(), signedRequest(...args).form.toString());
    assert.deepEqual(Object.fromEntries(r.form), {
      beginTime: String(v.beginTime),
      duration: String(v.duration),
      is_recommend: "0",
      api_time: String(v.apiTime),
      "seats[0]": v.seatId,
      "seatBookers[0]": v.uid,
    });
  }
  assert.throws(() => signedRequest("62726", "111", task.begin, open / 1000, 46800), /INVALID_DURATION/);
});

test("every supported whole-hour range matches the upstream base64(lowercase MD5 hex) contract", () => {
  for (let start = 7; start < 22; start++)
    for (let end = start + 1; end <= 22; end++) {
      const t = makeTask("scheduled", open, start, end);
      const r = bookSeatRequest(SEAT.seatId, "111", t.begin, open / 1000, t.duration);
      assert.equal(r.form.get("duration"), String(3600 * (end - start)));
      const pairs = [...r.form].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => k + v);
      const bytes = createHash("md5")
        .update(["post", BOOK_PATH, ...pairs].join("&"))
        .digest("hex");
      assert.equal(r.token, Buffer.from(bytes, "ascii").toString("base64"));
    }
});

test("verification requires an active exact slot and ignores cancelled, malformed and neighboring records", () => {
  const row = {
    status: 0,
    time: String(task.begin),
    duration: task.duration,
    roomName: SEAT.room,
    seatNum: "162",
  };
  assert.ok(matchesRecord(row, task));
  for (const changes of [
    { status: 3 },
    { status: "?" },
    { time: task.begin + 3600 },
    { duration: 3600 },
    { seatNum: "161" },
    { seatId: "162" },
    { floorId: 42 },
    { roomName: "其他自习室" },
  ]) {
    assert.equal(matchesRecord({ ...row, ...changes }, task), false);
  }
  assert.equal(
    [null, {}, row].some((r) => matchesRecord(r, task)),
    true,
  );
});

const responses = [
  [200, { CODE: "ok", DATA: { result: "success" } }, "SERVER_SUCCESS"],
  [200, { CODE: "ok", MESSAGE: "提交成功" }, "RESPONSE_UNKNOWN"],
  [200, { CODE: "ok", DATA: { result: "fail", msg: "登记失败" } }, "BUSINESS_REJECTED"],
  [200, { CODE: "ParamError", DATA: { msg: "未到预约时间" }, MESSAGE: "座位不可用" }, "NOT_OPEN"],
  [200, { CODE: "ParamError", MESSAGE: "超出可预约座位时间范围" }, "NOT_OPEN"],
  [200, { CODE: "ParamError", MESSAGE: "开始结束时间范围参数无效" }, "BUSINESS_REJECTED"],
  [200, { CODE: "ParamError", MESSAGE: "座位不可用" }, "SEAT_UNAVAILABLE"],
  [200, { CODE: "ParamError", MESSAGE: "已有预约，请勿重复预约！" }, "EXISTING"],
  [429, null, "LIMITED"],
  [200, { CODE: "LIMITED" }, "LIMITED"],
  [200, { CODE: "1", DATA: { msg: "请求过于频繁，请10分钟后再试" } }, "LIMITED"],
  [401, null, "AUTH_REQUIRED"],
  [200, { ui_type: "com.Redirect" }, "AUTH_REQUIRED"],
  [200, { DATA: { is_login: false } }, "AUTH_REQUIRED"],
  [404, { CODE: "NotFound" }, "HTTP_404"],
  [503, { CODE: "ok", DATA: { result: "success" } }, "HTTP_UNCERTAIN"],
  [200, null, "RESPONSE_UNKNOWN"],
];
for (const [status, body, expected] of responses) {
  test(`HTTP ${status} / ${JSON.stringify(body)} → ${expected}`, () =>
    assert.equal(classify(status, body), expected));
}

test("respect Retry-After and measured ten-minute ban; ten seconds is not an unban", () => {
  assert.equal(limitUntil(null, open), open + 600000);
  assert.equal(limitUntil("15", open), open + 600000);
  assert.equal(limitUntil("901", open), open + 901000);
  assert.equal(limitUntil(new Date(open + 1200000).toUTCString(), open), open + 1200000);
});

test("only whitelisted shapes reach exports, including when restoring a poisoned optional log", () => {
  const unsafe = "PRIVATE_STUDENT_SECRET";
  const r = diagnostic({
    uid: unsafe,
    header: unsafe,
    msg: unsafe,
    start: unsafe,
    responseAt: unsafe,
    date: unsafe,
    reason: unsafe,
    state: "__proto__",
    result: "constructor",
    businessCode: unsafe,
    businessResult: unsafe,
    verification: unsafe,
    dispatchAt: "2026-11-22T20:00:01.200+08:00",
  });
  assert.ok(!JSON.stringify(r).includes(unsafe));
  assert.equal(r.businessCode, "OTHER");
  assert.match(r.dispatchAt, /01.200/);
});

test("dispatch timestamp is taken after the synchronous intent, immediately at fetch hand-off", async (t) => {
  const report = {};
  let clock = open + 1200;
  t.mock.method(Date, "now", () => clock);
  const call = t.mock.method(globalThis, "fetch", (url, options) => {
    assert.equal(url, `https://hdu.huitu.zhishulib.com${BOOK_PATH}`);
    assert.equal(options.method, "POST");
    assert.equal(clock, open + 1440);
    return Promise.resolve(new Response(JSON.stringify({ CODE: "ok", DATA: { result: "success" } })));
  });
  const result = await submitPrepared(task, "111", report, {
    beforeSend: () => {
      clock += 240;
    },
    onDispatch: () => {
      clock += 300;
    },
  });
  assert.equal(result.result, "SERVER_SUCCESS");
  assert.equal(call.mock.callCount(), 1);
  assert.equal(report.sends, 1);
  assert.equal(Date.parse(report.dispatchAt), open + 1440);
  assert.equal(report.delayFrom20Ms, 1440);
});

test("30s deadline yields TIMEOUT, one hand-off, no fallback POST", async (t) => {
  let expire;
  const nativeTimer = setTimeout;
  t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => {
    if (ms === 30000) {
      expire = fn;
      return 0;
    }
    return nativeTimer(fn, ms, ...args);
  });
  const call = t.mock.method(
    globalThis,
    "fetch",
    (_, init) =>
      new Promise((_, reject) =>
        init.signal.addEventListener("abort", () => reject(new Error("abort")), { once: true }),
      ),
  );
  const report = {};
  const request = submitPrepared(task, "111", report, { beforeSend() {}, onDispatch() {} });
  expire();
  assert.equal((await request).result, "TIMEOUT");
  assert.equal(report.sends, 1);
  assert.equal(call.mock.callCount(), 1);
});

test("install file metadata begins at byte zero and legacy installers retain published hashes", () => {
  const src = readFileSync("userscripts/HDU_iPad_V9_Lite.user.js", "utf8");
  assert.ok(src.startsWith("// ==UserScript==\n"));
  assert.doesNotMatch(src, /@require|GM_xmlhttpRequest|document\.cookie|XMLHttpRequest\.prototype|lockSeats/);
  const hashes = readFileSync("userscripts/SHA256SUMS", "utf8").trim().split("\n");
  for (const line of hashes) {
    const [sum, file] = line.split(/ +/);
    assert.equal(
      createHash("sha256")
        .update(readFileSync(`userscripts/${file}`))
        .digest("hex"),
      sum,
    );
  }
  assert.ok(
    hashes.some((line) =>
      line.startsWith("35806dfd7ab9633dc44c4fd83b9d047d493211827191c295708e3aae9064539b"),
    ),
  );
});
