import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { signedRequest, TestError } from "../../src/userscript/core.js";
import { CrossModeCoordinator } from "../../src/userscript/p71/coordinator.js";
import { P71_RECORD_PATH, scheduledTask } from "../../src/userscript/p71/policy.js";
import { IpadBookingEngine } from "../../src/userscript/p70/engine.js";
import { P73_VERSION, PerformanceScheduledEngine } from "../../src/userscript/p73/engine.js";

let origFetch;
before(() => {
  origFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TestError("REAL_NETWORK_FORBIDDEN");
  };
});
after(() => {
  globalThis.fetch = origFetch;
});

class MemStore {
  constructor(task) {
    this.task = task;
    this.rows = new Map();
    this.spentKeys = new Set();
    this.stopFlag = false;
    this.activeFlag = false;
    this.account = null;
    this.noteWrites = 0;
  }
  bind(a) {
    this.account = a;
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
  spent(k) {
    return this.spentKeys.has(k);
  }
  async get(k) {
    return this.rows.has(k) ? structuredClone(this.rows.get(k)) : null;
  }
  async list(a = this.account) {
    return [...this.rows.values()].filter((r) => r.key.startsWith(`${a}:`)).map((r) => structuredClone(r));
  }
  async pendingUnknown(a = this.account, ex = null) {
    return (await this.list(a)).find((r) => r.key !== ex && r.attempts === 1 && !["SUCCESS", "FAILED"].includes(r.state)) || null;
  }
  async reserve(row) {
    if (await this.pendingUnknown(this.account, row.key)) throw new TestError("PREVIOUS_UNKNOWN");
    const ex = await this.get(row.key);
    if (ex || this.stopFlag || this.spentKeys.has(row.key)) return { won: false, value: ex };
    this.rows.set(row.key, structuredClone(row));
    this.activeFlag = true;
    return { won: true, value: structuredClone(row) };
  }
  async claim(k, owner, at) {
    const old = this.rows.get(k);
    if (!old || old.owner !== owner || old.state !== "WAITING" || old.attempts !== 0 || this.stopFlag || this.spentKeys.has(k))
      return { won: false, value: old ? structuredClone(old) : null };
    const next = { ...old, state: "UNKNOWN", reason: "WRITE_INTENT_PERSISTED", attempts: 1, intentAt: at };
    this.rows.set(k, structuredClone(next));
    this.spentKeys.add(k);
    return { won: true, value: structuredClone(next) };
  }
  async finish(k, owner, patch) {
    const old = this.rows.get(k);
    if (!old || old.owner !== owner) return old ? structuredClone(old) : null;
    const terminal =
      old.state === "SUCCESS" ||
      (old.state === "FAILED" && !(patch.state === "SUCCESS" && patch.recordVerified === true));
    const next = terminal ? { ...old } : { ...old, ...patch };
    next.timings = { ...(old.timings || {}), ...(patch.timings || {}) };
    this.rows.set(k, structuredClone(next));
    return structuredClone(next);
  }
  async stop(k, reason = "USER_STOPPED") {
    const old = this.rows.get(k);
    if (!old || ["SUCCESS", "FAILED"].includes(old.state)) return old ? structuredClone(old) : null;
    const next = { ...old, state: old.attempts ? "UNKNOWN" : "STOPPED", reason };
    this.rows.set(k, structuredClone(next));
    return structuredClone(next);
  }
  async takeVerification(k, now) {
    const old = this.rows.get(k);
    if (!old || old.state === "SUCCESS" || old.attempts !== 1 || (old.verifications || 0) >= 3) return false;
    if (now - (old.lastVerification || 0) < 2000) return false;
    old.verifications = (old.verifications || 0) + 1;
    old.lastVerification = now;
    return true;
  }
  async note(k, diag, logs) {
    this.noteWrites++;
    const old = this.rows.get(k);
    if (!old) return null;
    old.timings = { ...(old.timings || {}), ...(diag || {}) };
    for (const [f, v] of Object.entries(diag || {})) old[f] = v;
    if (logs) old.logs = logs.slice(-60);
    return structuredClone(old);
  }
}

function makeEnv({
  day = "2026-11-21",
  startHour = 8,
  endHour = 22,
  wallInit = Date.parse("2026-11-21T19:57:00+08:00"),
  staticCache = { roomQueryEntry: null, mappingEntry: null },
} = {}) {
  const open = Date.parse(`${day}T20:00:00+08:00`);
  let wall = wallInit;
  let mono = 10000;
  let visible = true;
  const task = scheduledTask(wall, startHour, endHour);
  const store = new MemStore(task);
  const normalStore = new MemStore(task);
  const coordinator = new CrossModeCoordinator();

  const io = {
    writes: 0,
    searchPostCount: 0,
    openingReads: 0,
    recalibrations: 0,
    openAt: open,
    lastForm: null,
    lastToken: null,
    failSearchPostLimited: false,
    bookResponse: { CODE: "ok", DATA: { result: "success" } },
    bookError: null,
    recordExists: true,
    records: [],
    now: () => wall,
    clockValid: () => true,
    async request(path, options = {}) {
      const sample = {
        status: 200,
        date: new Date(Math.floor(wall / 1000) * 1000).toUTCString(),
        age: "0",
        sentMono: mono - 20,
        receivedMono: mono,
        receivedWall: wall,
        timing: { responseAt: new Date(wall + 20).toISOString(), dispatchToHeadersMs: 20 },
      };
      if (options.write) {
        io.writes++;
        io.lastForm = options.form;
        io.lastToken = options.token;
        options.onDispatch?.(new Date(wall).toISOString());
        if (io.bookError) throw new TestError(io.bookError);
        const timing = { dispatchToHeadersMs: 20, bodyDecodeMs: 1, businessResultAt: new Date(wall + 21).toISOString(), totalRequestMs: 21 };
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
        return { body: { CODE: "ok", DATA: { is_login: true, uid: "9876543210", name: "SECRET_USER" } } };
      }
      if (path === "/Space/Category/list?LAB_JSON=1") {
        options.onHeaders?.(sample);
        return { body: { content: { defaultItems: [{ name: "自习室", link: "/Seat/Index/searchSeats?room=1" }] } } };
      }
      if (path.startsWith("/Seat/Index/searchSeats?") && !options.form) {
        if (wall >= open) io.openingReads++;
        options.onHeaders?.(sample);
        const isOpen = wall >= io.openAt;
        const adv = Date.parse(`${day}T00:00:00+08:00`) / 1000;
        const maxDate = isOpen
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
        io.searchPostCount++;
        options.onHeaders?.(sample);
        if (io.failSearchPostLimited) {
          return { body: { CODE: "ParamError", MESSAGE: "请求过于频繁，请稍后再试" } };
        }
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

  const engine = new PerformanceScheduledEngine(io, store, () => {}, {
    task,
    wall: () => wall,
    mono: () => mono,
    visible: () => visible,
    staticCache,
    coordinator,
  });
  const normalEngine = new IpadBookingEngine(io, normalStore, () => {}, {
    wall: () => wall,
    mono: () => mono,
    visible: () => visible,
    coordinator,
  });
  coordinator.attachScheduled(engine, store);
  coordinator.attachNormal(normalEngine, normalStore);

  async function stepTo(targetWall) {
    while (wall < targetWall) {
      const step = targetWall - wall <= 1500 ? 20 : 250;
      const d = Math.min(step, targetWall - wall);
      wall += d;
      mono += d;
      await engine.tick();
    }
  }

  return {
    task,
    io,
    store,
    normalStore,
    engine,
    normalEngine,
    stepTo,
    setWall(w) {
      const d = w - wall;
      wall = w;
      mono += d;
    },
    setVisible(v) {
      visible = v;
    },
  };
}

test("1 & 3 & 5 & 6: full 19:57 prepare -> 19:59:15 recalibrate -> 20:00 open confirm -> fastSign single POST -> verified SUCCESS", async () => {
  const env = makeEnv({ startHour: 8, endHour: 22, wallInit: Date.parse("2026-11-21T19:57:00+08:00") });
  await env.engine.prepare({ arm: true, confirmed: true, authorizedDay: "2026-11-21" });
  assert.equal(env.engine.state, "WAITING");
  assert.ok(env.engine.signTemplate);

  await env.stepTo(env.task.open + 500);
  await env.engine.diagWrites;

  assert.equal(env.io.recalibrations, 1);
  assert.equal(env.io.openingReads, 1);
  assert.equal(env.io.writes, 1);
  assert.equal(env.engine.state, "SUCCESS");

  // Verify fastSign matches core.js signedRequest byte-for-byte
  const apiTime = Number(env.io.lastForm.get("api_time"));
  const expected = signedRequest("62726", "9876543210", env.task.begin, apiTime, 50400);
  assert.equal(env.io.lastToken, expected.token);
  assert.equal(env.io.lastForm.toString(), expected.form.toString());

  const diag = (await env.engine.diagnosticExport()).current;
  assert.equal(diag.version, P73_VERSION);
  assert.equal(diag.recordVerified, true);
  assert.equal(diag.attempts, 1);
  assert.ok(diag.recalibratedAt);
  assert.ok(diag.openConfirmedAt);
  assert.ok(diag.firstDispatchAt);
  assert.ok(diag.firstRecordVerifiedAt);
  assert.ok(diag.deferredDiagWrites >= 2, "hot path should defer non-critical diag writes");
  assert.ok(diag.openCheckMs != null && diag.signLocalMs != null && diag.claimWriteMs != null);
  assert.doesNotMatch(JSON.stringify(diag), /9876543210|SECRET_USER/);
});

test("2: 11/20 real LIMITED regression — rehearsal caches static mapping so 19:57 formal prepare skips POST searchSeats; cold-start LIMITED halts safely", async () => {
  // With prior rehearsal at 19:51 -> 19:57 formal prepare skips POST searchSeats (0 extra POSTs!)
  {
    const env = makeEnv({ startHour: 9, endHour: 22, wallInit: Date.parse("2026-11-21T19:51:42+08:00") });
    await env.engine.prepare({ arm: false });
    assert.equal(env.io.searchPostCount, 1);
    env.setWall(Date.parse("2026-11-21T19:57:00+08:00"));
    env.io.failSearchPostLimited = true; // even if POST searchSeats would return LIMITED, cache avoids calling it!
    await env.engine.prepare({ arm: true, confirmed: true, authorizedDay: "2026-11-21" });
    assert.equal(env.engine.state, "WAITING");
    assert.equal(env.io.searchPostCount, 1);
    assert.equal((await env.engine.diagnosticExport()).current.cacheHit.seatMappingHit, true);
  }
  // Cold start at 19:57 hitting HTTP 200 business LIMITED -> safe stop, 0 writes
  {
    const env = makeEnv({ startHour: 9, endHour: 22, wallInit: Date.parse("2026-11-21T19:57:00+08:00") });
    env.io.failSearchPostLimited = true;
    await env.engine.prepare({ arm: true, confirmed: true, authorizedDay: "2026-11-21" });
    const diag = (await env.engine.diagnosticExport()).current;
    assert.equal(diag.state, "STOPPED");
    assert.equal(diag.reason, "LIMITED");
    assert.equal(diag.httpStatus, 200);
    assert.equal(diag.stoppedEndpoint, "/Seat/Index/searchSeats");
    assert.equal(env.io.writes, 0);
  }
});

test("4 & 7: custom duration, delayed open confirmation, NOT_OPEN terminal protection, 404/TIMEOUT UNKNOWN", async () => {
  // Delayed open + custom 9:00-22:00 (46800s)
  {
    const env = makeEnv({ startHour: 9, endHour: 22, wallInit: Date.parse("2026-11-21T19:59:30+08:00") });
    env.io.openAt = env.task.open + 1200;
    await env.engine.prepare({ arm: true, confirmed: true, authorizedDay: "2026-11-21" });
    await env.stepTo(env.task.open + 1600);
    assert.equal(env.io.openingReads, 2);
    assert.equal(env.io.writes, 1);
    assert.equal(env.io.lastForm.get("duration"), "46800");
    assert.equal(env.engine.state, "SUCCESS");
  }
  // NOT_OPEN -> FAILED survives stop()
  {
    const env = makeEnv({ wallInit: Date.parse("2026-11-21T19:59:30+08:00") });
    env.io.recordExists = false;
    env.io.bookResponse = { CODE: "ParamError", MESSAGE: "未到开放时间" };
    await env.engine.prepare({ arm: true, confirmed: true, authorizedDay: "2026-11-21" });
    await env.stepTo(env.task.open + 500);
    assert.equal(env.engine.state, "FAILED");
    await env.engine.stop("USER_STOPPED");
    assert.equal(env.engine.state, "FAILED");
  }
  // 404 & TIMEOUT -> UNKNOWN, 1 write
  for (const code of ["HTTP_404", "TIMEOUT"]) {
    const env = makeEnv({ wallInit: Date.parse("2026-11-21T19:59:30+08:00") });
    env.io.bookError = code;
    await env.engine.prepare({ arm: true, confirmed: true, authorizedDay: "2026-11-21" });
    await env.stepTo(env.task.open + 500);
    assert.equal(env.io.writes, 1);
    assert.equal(env.engine.state, "UNKNOWN");
  }
});

test("8 & 9: Safari suspension stops with 0 writes; cross-mode mutual exclusion blocks conflicts both ways", async () => {
  // Safari timer stall
  {
    const env = makeEnv({ wallInit: Date.parse("2026-11-21T19:59:30+08:00") });
    await env.engine.prepare({ arm: true, confirmed: true, authorizedDay: "2026-11-21" });
    env.setWall(Date.parse("2026-11-21T19:59:34+08:00")); // 4s stall
    await env.engine.tick();
    assert.equal(env.engine.reason, "SAFARI_TIMER_SUSPENDED");
    assert.equal(env.io.writes, 0);
  }
  // Cross-mode exclusion: P7.3 WAITING blocks P7.0 normal mode
  {
    const env = makeEnv({ wallInit: Date.parse("2026-11-21T19:57:00+08:00") });
    await env.engine.prepare({ arm: true, confirmed: true, authorizedDay: "2026-11-21" });
    assert.equal(env.engine.state, "WAITING");
    await assert.rejects(
      () =>
        env.normalEngine.prepare({
          date: "2026-11-21",
          hour: 21,
          floorId: 1558,
          room: "宋韵云图（四楼）",
          seatId: "62726",
          seatNumber: "162",
        }),
      /CROSS_MODE_ACTIVE_TASK/,
    );
    assert.equal(env.io.writes, 0);
  }
});

test("10: built hdu-p73-ipad-performance.user.js integrity, zero forbidden patterns, and no fixed-delay bypass", async () => {
  const code = await readFile("userscripts/hdu-p73-ipad-performance.user.js", "utf8");
  assert.ok(code.startsWith("// ==UserScript=="));
  assert.match(code, /@version\s+7\.3\.0/);
  assert.match(code, /@inject-into\s+page/);
  assert.match(code, /PerformanceScheduledEngine/);
  assert.match(code, /CrossModeCoordinator/);
  assert.doesNotMatch(code, /MockFixedDelayEngine|REAL_TRANSPORT_FORBIDDEN/);
  assert.doesNotMatch(code, /@require|GM_xmlhttpRequest|document\.cookie|lockSeats|cancelBooking|signIn/);
  assert.doesNotMatch(code, /hdu-p53-formal-booking|hdu-p60-daily-booking|P52_RECEIPT_REQUIRED/);
});
