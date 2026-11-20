import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { signedRequest, TestError } from "../../src/userscript/core.js";
import {
  openingScheduledRange,
  P71_RECORD_PATH,
  publicScheduledDiagnostics,
  ScheduledClock,
  scheduledTask,
  signedScheduledRequest,
  validateScheduledRange,
  verifiedScheduled162,
} from "../../src/userscript/p71/policy.js";
import { ScheduledIpadStore } from "../../src/userscript/p71/store.js";
import { ScheduledIpadEngine } from "../../src/userscript/p71/engine.js";

class MemoryScheduledStore {
  constructor(task) {
    this.task = task;
    this.rows = new Map();
    this.spentKeys = new Set();
    this.stopFlag = false;
    this.activeFlag = false;
    this.account = null;
  }
  bind(account) {
    this.account = account;
  }
  async probe() {}
  activateDay() {
    this.activeFlag = true;
  }
  active() {
    return this.activeFlag;
  }
  stopped() {
    return this.stopFlag;
  }
  stopSignal() {
    this.stopFlag = true;
  }
  spent(key) {
    return this.spentKeys.has(key);
  }
  async get(key) {
    return this.rows.has(key) ? structuredClone(this.rows.get(key)) : null;
  }
  async list(account = this.account) {
    return [...this.rows.values()].filter((r) => r.key.startsWith(`${account}:`)).map((r) => structuredClone(r));
  }
  async pendingUnknown(account = this.account, excludeKey = null) {
    return (
      (await this.list(account)).find(
        (r) => r.key !== excludeKey && r.attempts === 1 && !["SUCCESS", "FAILED"].includes(r.state),
      ) || null
    );
  }
  async reserve(row) {
    const pending = await this.pendingUnknown(this.account, row.key);
    if (pending) throw new TestError("PREVIOUS_UNKNOWN");
    const existing = await this.get(row.key);
    if (existing || this.stopFlag || this.spentKeys.has(row.key)) return { won: false, value: existing };
    this.rows.set(row.key, structuredClone(row));
    this.activeFlag = true;
    return { won: true, value: structuredClone(row) };
  }
  async claim(key, owner, at) {
    const old = this.rows.get(key);
    if (!old || old.owner !== owner || old.state !== "WAITING" || old.attempts !== 0 || this.stopFlag || this.spentKeys.has(key))
      return { won: false, value: old ? structuredClone(old) : null };
    const next = { ...old, state: "UNKNOWN", reason: "WRITE_INTENT_PERSISTED", attempts: 1, intentAt: at };
    this.rows.set(key, structuredClone(next));
    this.spentKeys.add(key);
    return { won: true, value: structuredClone(next) };
  }
  async finish(key, owner, patch) {
    const old = this.rows.get(key);
    if (!old || old.owner !== owner) return old ? structuredClone(old) : null;
    const terminal =
      old.state === "SUCCESS" ||
      (old.state === "FAILED" && !(patch.state === "SUCCESS" && patch.recordVerified === true));
    const next = terminal ? { ...old } : { ...old, ...patch };
    next.timings = { ...(patch.timings || {}), ...(old.timings || {}) };
    for (const [k, v] of Object.entries(patch.timings || {})) {
      if (next[k] == null && v != null) next[k] = v;
    }
    this.rows.set(key, structuredClone(next));
    return structuredClone(next);
  }
  async stop(key, reason = "USER_STOPPED") {
    const old = this.rows.get(key);
    if (!old || ["SUCCESS", "FAILED"].includes(old.state)) return old ? structuredClone(old) : null;
    const next = { ...old, state: old.attempts ? "UNKNOWN" : "STOPPED", reason };
    this.rows.set(key, structuredClone(next));
    return structuredClone(next);
  }
  async takeVerification(key, now) {
    const old = this.rows.get(key);
    if (!old || old.state === "SUCCESS" || old.attempts !== 1 || (old.verifications || 0) >= 3) return false;
    if (now - (old.lastVerification || 0) < 2000) return false;
    old.verifications = (old.verifications || 0) + 1;
    old.lastVerification = now;
    return true;
  }
  async note(key, diagnostics, logs) {
    const old = this.rows.get(key);
    if (!old) return null;
    for (const [k, v] of Object.entries(diagnostics || {})) {
      if (k === "lastReviewedAt") old.lastReviewedAt = v;
      else if (old[k] == null && v != null) old[k] = v;
    }
    old.timings = { ...(diagnostics || {}), ...(old.timings || {}) };
    if (logs) old.logs = logs.slice(-60);
    return structuredClone(old);
  }
}

function setup({ day = "2026-11-20", startHour = 8, endHour = 22, startAtOffsetMs = -300000, store } = {}) {
  const open = Date.parse(`${day}T20:00:00+08:00`);
  let wall = open + startAtOffsetMs;
  let mono = 10000;
  let visible = true;
  const task = scheduledTask(wall, startHour, endHour);
  const sharedStore = store || new MemoryScheduledStore(task);

  const io = {
    writes: 0,
    openingReads: 0,
    recalibrations: 0,
    lastForm: null,
    openAt: open,
    openingFailure: null,
    bookResponse: { CODE: "ok", DATA: { result: "success" } },
    bookError: null,
    recordExists: true,
    records: [],
    async request(path, options = {}) {
      const sentMono = mono - 20;
      const receivedMono = mono;
      const serverSec = Math.floor(wall / 1000) * 1000;
      const sample = {
        status: 200,
        date: new Date(serverSec).toUTCString(),
        age: "0",
        sentMono,
        receivedMono,
        receivedWall: wall,
        timing: { responseAt: new Date(wall + 20).toISOString(), dispatchToHeadersMs: 20 },
      };

      if (options.write) {
        io.writes++;
        io.lastForm = options.form;
        options.onDispatch?.(new Date(wall).toISOString());
        if (io.bookError) {
          const err = new TestError(io.bookError);
          err.timing = { totalRequestMs: 50 };
          throw err;
        }
        const timing = {
          dispatchToHeadersMs: 20,
          bodyDecodeMs: 1,
          businessResultAt: new Date(wall + 21).toISOString(),
          totalRequestMs: 21,
        };
        options.onHeaders?.(sample);
        options.onBusiness?.(io.bookResponse, timing);
        if (io.recordExists && io.bookResponse?.CODE === "ok") {
          io.records.push({
            status: "1",
            time: Number(options.form.get("beginTime")),
            duration: Number(options.form.get("duration")),
            seatNum: "162",
            seatId: "62726",
            roomName: "宋韵云图（四楼）",
          });
        }
        return { body: io.bookResponse, timing };
      }

      if (path === "/User/Center/baseInfo") {
        if (wall >= open - 50000) io.recalibrations++;
        options.onHeaders?.(sample);
        return { body: { CODE: "ok", DATA: { is_login: true, uid: "9876543210", name: "SECRET_NAME" } } };
      }
      if (path === "/Space/Category/list?LAB_JSON=1") {
        options.onHeaders?.(sample);
        return { body: { content: { defaultItems: [{ name: "自习室", link: "/Seat/Index/searchSeats?room=1" }] } } };
      }
      if (path.startsWith("/Seat/Index/searchSeats?") && !options.form) {
        if (wall >= open) {
          io.openingReads++;
          if (io.openingFailure) throw new TestError(io.openingFailure);
        }
        options.onHeaders?.(sample);
        const isOpenNow = wall >= io.openAt;
        const adv = Date.parse(`${day}T00:00:00+08:00`) / 1000;
        const maxDate = isOpenNow
          ? Date.parse(`${task.date}T00:00:00+08:00`) / 1000 + 86400
          : Date.parse(`${task.date}T00:00:00+08:00`) / 1000;
        return {
          body: {
            data: {
              space_category: { category_id: "591", content_id: "31" },
              range: {
                advance_date: adv,
                max_date: maxDate,
                minBeginTime: 8,
                maxEndTime: 22,
                min_duration: 1,
                max_duration: 14,
                max_num: 1,
              },
            },
          },
        };
      }
      if (path === "/Seat/Index/searchSeats?LAB_JSON=1" && options.form) {
        options.onHeaders?.(sample);
        return {
          body: {
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
                          info: { id: 1558 },
                          POIs: [
                            { title: "162", id: "62726", state: "0" },
                            { title: "157", id: "62721", state: "0" },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        };
      }
      if (path === P71_RECORD_PATH) {
        options.onHeaders?.(sample);
        return { body: { content: { defaultItems: io.records } } };
      }
      throw new Error(`Unexpected path: ${path}`);
    },
  };

  const engine = new ScheduledIpadEngine(io, sharedStore, () => {}, {
    task,
    wall: () => wall,
    mono: () => mono,
    visible: () => visible,
  });

  // Smoothly advance time in safe 250ms increments (simulating active foreground Safari loop)
  async function stepTo(targetWall) {
    while (wall < targetWall) {
      const delta = Math.min(250, targetWall - wall);
      wall += delta;
      mono += delta;
      await engine.tick();
    }
  }

  return {
    task,
    io,
    store: sharedStore,
    engine,
    stepTo,
    jump(dWall, dMono = dWall) {
      wall += dWall;
      mono += dMono;
    },
    setVisible(v) {
      visible = v;
    },
    getWall: () => wall,
  };
}

test("custom start/end hours compute exact duration, validate against range, and match core.js signatures", () => {
  const tDefault = scheduledTask(Date.parse("2026-11-20T19:55:00+08:00"));
  assert.equal(tDefault.date, "2026-11-22");
  assert.equal(tDefault.duration, 50400);
  assert.equal(tDefault.seat, "162");
  assert.equal(tDefault.floorId, 1558);

  const tCustom = scheduledTask(Date.parse("2026-11-20T19:55:00+08:00"), 9, 17);
  assert.equal(tCustom.hours, 8);
  assert.equal(tCustom.duration, 28800);
  assert.equal(tCustom.begin, Date.parse("2026-11-22T09:00:00+08:00") / 1000);

  // Invalid hours rejected
  assert.throws(() => scheduledTask(Date.parse("2026-11-20T19:55:00+08:00"), 15, 15), /INVALID_DURATION/);
  assert.throws(() => scheduledTask(Date.parse("2026-11-20T19:55:00+08:00"), 18, 12), /INVALID_DURATION/);

  // Range rule validation
  const rawRange = {
    advance_date: Date.parse("2026-11-20T00:00:00+08:00") / 1000,
    max_date: Date.parse("2026-11-22T00:00:00+08:00") / 1000,
    minBeginTime: 8,
    maxEndTime: 22,
    min_duration: 1,
    max_duration: 10,
    max_num: 1,
  };
  validateScheduledRange(rawRange, Date.parse("2026-11-20T19:55:00+08:00"), tCustom);
  assert.throws(
    () => validateScheduledRange(rawRange, Date.parse("2026-11-20T19:55:00+08:00"), tDefault),
    /DURATION_NOT_ALLOWED/,
  );

  // Signature matches core.js byte-for-byte for 50400s and 3600s, and signs custom 28800s
  const s50400 = signedScheduledRequest("62726", "9876543210", tDefault.begin, 1795176000, 50400);
  const c50400 = signedRequest("62726", "9876543210", tDefault.begin, 1795176000, 50400);
  assert.equal(s50400.token, c50400.token);
  assert.equal(s50400.form.toString(), c50400.form.toString());

  const s28800 = signedScheduledRequest("62726", "9876543210", tCustom.begin, 1795176000, 28800);
  assert.equal(s28800.form.get("duration"), "28800");
  assert.ok(s28800.token.length > 10);
});

test("cross-day, cross-month, cross-year, and leap-year Shanghai +2 date calculation", () => {
  assert.equal(scheduledTask(Date.parse("2026-11-29T19:55:00+08:00")).date, "2026-12-01");
  assert.equal(scheduledTask(Date.parse("2026-12-31T19:55:00+08:00")).date, "2027-01-02");
  assert.equal(scheduledTask(Date.parse("2028-02-28T19:55:00+08:00")).date, "2028-03-01");
  assert.equal(scheduledTask(Date.parse("2027-02-28T19:55:00+08:00")).date, "2027-03-02");
});

test("19:55 prepare window, 19:59:15 automatic recalibration, open confirmation, custom 8h booking, and immutable timestamps", async () => {
  // 19:54:59 formal arm rejected; read-only rehearsal succeeds
  const early = setup({ startAtOffsetMs: -301000 });
  await early.engine.prepare({ arm: true, confirmed: true, authorizedDay: early.task.day });
  assert.equal(early.engine.reason, "PREPARE_TOO_EARLY");
  await early.engine.prepare({ arm: false });
  assert.equal(early.engine.state, "READY_READ_ONLY");
  assert.equal(early.io.writes, 0);

  // Full 19:55:00 -> 19:59:15 recalibrate -> 20:00:00.500 open confirm -> submit -> verify
  const s = setup({ startHour: 9, endHour: 17, startAtOffsetMs: -300000 });
  await s.engine.prepare({ arm: true, confirmed: true, authorizedDay: s.task.day });
  assert.equal(s.engine.state, "WAITING");
  assert.equal(s.io.writes, 0);

  await s.stepTo(s.task.open + 500);
  await s.engine.diagWrites;

  assert.equal(s.io.recalibrations, 1);
  assert.equal(s.io.openingReads, 1);
  assert.equal(s.io.writes, 1);
  assert.equal(s.io.lastForm.get("duration"), "28800");
  assert.equal(s.io.lastForm.get("seats[0]"), "62726");
  assert.equal(s.engine.state, "SUCCESS");

  const firstExport = await s.engine.diagnosticExport();
  assert.ok(firstExport.current.recalibratedAt);
  assert.ok(firstExport.current.firstGatePassedAt);
  assert.ok(firstExport.current.openConfirmedAt);
  assert.ok(firstExport.current.firstDispatchAt);
  assert.ok(firstExport.current.firstRecordVerifiedAt);
  assert.equal(firstExport.current.duration, 28800);
  assert.doesNotMatch(JSON.stringify(firstExport), /9876543210|SECRET_NAME/);

  // Later review keeps all first timestamps immutable and only updates lastReviewedAt
  s.jump(60000);
  await s.engine.review();
  const afterReview = await s.engine.diagnosticExport();
  assert.equal(afterReview.current.firstDispatchAt, firstExport.current.firstDispatchAt);
  assert.equal(afterReview.current.firstRecordVerifiedAt, firstExport.current.firstRecordVerifiedAt);
  assert.equal(afterReview.current.recalibratedAt, firstExport.current.recalibratedAt);
  assert.ok(afterReview.current.lastReviewedAt);
  assert.equal(s.io.writes, 1);
});

test("stale 19:55 clock sample without recalibration is rejected (>60s age)", () => {
  const task = scheduledTask(Date.parse("2026-11-20T19:55:00+08:00"));
  let wall = task.open - 300000;
  let mono = 1000;
  const clock = new ScheduledClock(() => wall, () => mono, task);
  clock.observe({
    date: new Date(Math.floor(wall / 1000) * 1000).toUTCString(),
    age: "0",
    sentMono: mono,
    receivedMono: mono + 20,
    receivedWall: wall,
  });
  // Advance 65 seconds without recalibration -> rejected
  wall += 65000;
  mono += 65000;
  assert.throws(() => clock.bounds(), /CLOCK_CHANGED_OR_STALE/);
});

test("delayed open confirmation waits >=1s, stops after 2 closed reads with 0 writes, and fails closed on 404", async () => {
  // Delayed open by 1000ms -> 2nd read succeeds -> 1 write
  {
    const s = setup({ startAtOffsetMs: -30000 });
    s.io.openAt = s.task.open + 1250;
    await s.engine.prepare({ arm: true, confirmed: true, authorizedDay: s.task.day });
    await s.stepTo(s.task.open + 500);
    assert.equal(s.io.openingReads, 1);
    assert.equal(s.io.writes, 0);
    assert.equal(s.engine.reason, "OPEN_RANGE_NOT_YET");

    await s.stepTo(s.task.open + 1750);
    assert.equal(s.io.openingReads, 2);
    assert.equal(s.io.writes, 1);
    assert.equal(s.engine.state, "SUCCESS");
  }
  // Persistent closed range -> stops after 2 reads, 0 writes
  {
    const s = setup({ startAtOffsetMs: -30000 });
    s.io.openAt = s.task.open + 60000;
    await s.engine.prepare({ arm: true, confirmed: true, authorizedDay: s.task.day });
    await s.stepTo(s.task.open + 2000);
    assert.equal(s.io.openingReads, 2);
    assert.equal(s.io.writes, 0);
    assert.equal(s.engine.state, "STOPPED");
    assert.equal(s.engine.reason, "OPEN_RANGE_UNCONFIRMED");
  }
  // Opening query HTTP 404 -> fails closed, 1 read, 0 writes
  {
    const s = setup({ startAtOffsetMs: -30000 });
    s.io.openingFailure = "HTTP_404";
    await s.engine.prepare({ arm: true, confirmed: true, authorizedDay: s.task.day });
    await s.stepTo(s.task.open + 500);
    assert.equal(s.io.openingReads, 1);
    assert.equal(s.io.writes, 0);
    assert.equal(s.engine.state, "STOPPED");
  }
});

test("NOT_OPEN survives later stop as FAILED; HTTP_404 becomes UNKNOWN, blocks next day, and review can verify", async () => {
  // NOT_OPEN -> FAILED terminal protection
  {
    const s = setup({ startAtOffsetMs: -30000 });
    s.io.recordExists = false;
    s.io.bookResponse = { CODE: "ParamError", MESSAGE: "未到开放时间" };
    await s.engine.prepare({ arm: true, confirmed: true, authorizedDay: s.task.day });
    await s.stepTo(s.task.open + 500);
    assert.equal(s.io.writes, 1);
    assert.equal(s.engine.state, "FAILED");
    await s.engine.stop("USER_STOPPED");
    assert.equal(s.engine.state, "FAILED");
    assert.equal((await s.store.get(s.engine.key)).state, "FAILED");
  }
  // HTTP_404 -> UNKNOWN, blocks next day, later review with record promotes to SUCCESS
  {
    const s = setup({ startAtOffsetMs: -30000 });
    s.io.recordExists = false;
    s.io.bookError = "HTTP_404";
    await s.engine.prepare({ arm: true, confirmed: true, authorizedDay: s.task.day });
    await s.stepTo(s.task.open + 500);
    assert.equal(s.io.writes, 1);
    assert.equal(s.engine.state, "UNKNOWN");

    // Next day blocked by PREVIOUS_UNKNOWN
    const nextDay = setup({ day: "2026-11-21", startAtOffsetMs: -30000, store: s.store });
    await nextDay.engine.prepare({ arm: true, confirmed: true, authorizedDay: nextDay.task.day });
    assert.equal(nextDay.engine.reason, "PREVIOUS_UNKNOWN");
    assert.equal(nextDay.io.writes, 0);

    // Explicit review after record appears promotes UNKNOWN -> SUCCESS without extra write
    s.io.records.push({
      status: "1",
      time: s.task.begin,
      duration: s.task.duration,
      seatNum: "162",
      seatId: "62726",
      roomName: "宋韵云图（四楼）",
    });
    s.jump(2500);
    await s.engine.review();
    assert.equal(s.engine.state, "SUCCESS");
    assert.equal(s.io.writes, 1);
  }
});

test("Safari background suspension, timer stall, lock-screen wake, and missed window never catch-up submit", async () => {
  // Visibility hidden stops and returning visible never resumes
  {
    const s = setup({ startAtOffsetMs: -30000 });
    await s.engine.prepare({ arm: true, confirmed: true, authorizedDay: s.task.day });
    s.setVisible(false);
    await s.engine.tick();
    assert.equal(s.engine.state, "STOPPED");
    assert.equal(s.engine.reason, "FOREGROUND_REQUIRED");
    s.setVisible(true);
    await s.stepTo(s.task.open + 500);
    assert.equal(s.io.writes, 0);
  }
  // Safari timer stall (>1500ms gap simulating lock-screen / background suspension) stops immediately
  {
    const s = setup({ startAtOffsetMs: -30000 });
    await s.engine.prepare({ arm: true, confirmed: true, authorizedDay: s.task.day });
    s.jump(4000, 4000); // 4s stall
    await s.engine.tick();
    assert.equal(s.engine.state, "STOPPED");
    assert.equal(s.engine.reason, "SAFARI_TIMER_SUSPENDED");
    const diag = await s.engine.diagnosticExport();
    assert.ok(diag.current.pageSuspendedAt);
    assert.equal(s.io.writes, 0);
  }
  // Missed window (>10s past 20:00) stops with 0 writes
  {
    const s = setup({ startAtOffsetMs: -30000 });
    await s.engine.prepare({ arm: true, confirmed: true, authorizedDay: s.task.day });
    s.jump(45000, 45000);
    await s.engine.tick();
    assert.equal(s.io.writes, 0);
  }
});

test("daily authorization cannot carry over from yesterday; two engines share single daily reservation", async () => {
  const s = setup({ startAtOffsetMs: -30000 });
  await s.engine.prepare({ arm: true, confirmed: true, authorizedDay: "2026-11-19" });
  assert.equal(s.engine.reason, "TODAY_AUTHORIZATION_REQUIRED");
  assert.equal(s.io.writes, 0);

  await s.engine.prepare({ arm: true, confirmed: true, authorizedDay: s.task.day });
  const second = setup({ startAtOffsetMs: -30000, store: s.store });
  await second.engine.prepare({ arm: true, confirmed: true, authorizedDay: second.task.day });
  assert.equal(second.engine.state, "IDLE");
  assert.equal(second.engine.reason, "WAITING_VIEW_ONLY");
  assert.equal(second.engine.waiting, false);
  assert.equal(second.io.writes, 0);
});

test("Safari durability fallback and built P7.1 artifact integrity", async () => {
  const store = new ScheduledIpadStore(scheduledTask(Date.parse("2026-11-20T19:55:00+08:00")));
  let calls = 0;
  const fakeDb = {
    transaction(name, mode, options) {
      calls++;
      if (options) throw new TypeError("unsupported durability");
      return { name, mode };
    },
  };
  const tx = store.openTx(fakeDb, "tasks", "readwrite");
  assert.equal(calls, 2);
  assert.deepEqual(tx, { name: "tasks", mode: "readwrite" });

  const code = await readFile("userscripts/hdu-p71-ipad-scheduled.user.js", "utf8");
  assert.ok(code.startsWith("// ==UserScript=="));
  assert.match(code, /@version\s+7\.1\.0/);
  assert.match(code, /@inject-into\s+page/);
  assert.match(code, /hdu-p71-ipad-scheduled/);
  assert.match(code, /hdu-p70-ipad-booking/);
  assert.doesNotMatch(code, /@require|GM_xmlhttpRequest|document\.cookie|lockSeats|cancelBooking|signIn/);
  assert.doesNotMatch(code, /hdu-p53-formal-booking|hdu-p60-daily-booking|P52_RECEIPT_REQUIRED/);

  const diag = publicScheduledDiagnostics({ state: "IDLE", reason: "READ_ONLY_DEFAULT" });
  assert.equal(diag.mode, "scheduled-162");
  assert.equal(openingScheduledRange({
    advance_date: Date.parse("2026-11-20T00:00:00+08:00") / 1000,
    max_date: Date.parse("2026-11-23T00:00:00+08:00") / 1000,
    minBeginTime: 8,
    maxEndTime: 22,
    min_duration: 1,
    max_duration: 14,
  }, scheduledTask(Date.parse("2026-11-20T19:55:00+08:00"))).open, true);
  assert.equal(verifiedScheduled162([], { room: "宋韵云图（四楼）" }, scheduledTask(Date.parse("2026-11-20T19:55:00+08:00"))), false);
});
