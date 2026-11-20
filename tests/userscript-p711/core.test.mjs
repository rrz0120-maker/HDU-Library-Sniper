import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { TestError } from "../../src/userscript/core.js";
import { CrossModeCoordinator } from "../../src/userscript/p71/coordinator.js";
import { P71_RECORD_PATH, P71_STATIC_CACHE_TTL_MS, scheduledTask } from "../../src/userscript/p71/policy.js";
import { ScheduledIpadEngine } from "../../src/userscript/p71/engine.js";
import { IpadBookingEngine } from "../../src/userscript/p70/engine.js";

class MemScheduledStore {
  constructor(task) {
    this.task = task;
    this.rows = new Map();
    this.spentKeys = new Set();
    this.stopFlag = false;
    this.activeFlag = false;
    this.account = null;
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
  async pendingUnknown(a = this.account, excludeKey = null) {
    return (
      (await this.list(a)).find(
        (r) => r.key !== excludeKey && r.attempts === 1 && !["SUCCESS", "FAILED"].includes(r.state),
      ) || null
    );
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
    const old = this.rows.get(k);
    if (!old) return null;
    old.timings = { ...(old.timings || {}), ...(diag || {}) };
    for (const [f, v] of Object.entries(diag || {})) old[f] = v;
    if (logs) old.logs = logs.slice(-60);
    return structuredClone(old);
  }
}

class MemNormalStore {
  constructor() {
    this.rows = new Map();
    this.spentKeys = new Set();
    this.account = null;
    this.prefix = "hdu-p70:";
  }
  bind(a) {
    this.account = a;
  }
  async probe() {}
  async get(k) {
    return this.rows.has(k) ? structuredClone(this.rows.get(k)) : null;
  }
  async list(a = this.account) {
    return [...this.rows.values()].filter((r) => r.key.startsWith(`${a}:`)).map((r) => structuredClone(r));
  }
  async pendingUnknown(a = this.account) {
    return (await this.list(a)).find((r) => r.attempts === 1 && !["SUCCESS", "FAILED"].includes(r.state)) || null;
  }
  spent(k) {
    return this.spentKeys.has(k);
  }
  stopSignal() {}
  async claim(intent) {
    if (await this.pendingUnknown(this.account)) throw new TestError("PREVIOUS_UNKNOWN");
    if (this.rows.has(intent.key) || this.spentKeys.has(intent.key)) return { won: false, value: this.rows.get(intent.key) };
    const saved = structuredClone({ ...intent, attempts: 1, verifications: 0 });
    this.rows.set(intent.key, saved);
    this.spentKeys.add(intent.key);
    return { won: true, value: structuredClone(saved) };
  }
  async finish(k, ticket, patch) {
    const old = this.rows.get(k);
    if (!old || old.ticket !== ticket) return old ? structuredClone(old) : null;
    const next = { ...old, ...patch, timings: { ...(old.timings || {}), ...(patch.timings || {}) } };
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
  async noteReview() {}
}

function makeEnv({
  day = "2026-11-20",
  startHour = 9,
  endHour = 22,
  wallInit = Date.parse("2026-11-20T19:51:42+08:00"),
  staticCache = { roomQueryEntry: null, mappingEntry: null },
  coordinator = new CrossModeCoordinator(),
} = {}) {
  const open = Date.parse(`${day}T20:00:00+08:00`);
  let wall = wallInit;
  let mono = 10000;
  let visible = true;
  const task = scheduledTask(wall, startHour, endHour);
  const store = new MemScheduledStore(task);
  const normalStore = new MemNormalStore();

  const io = {
    uid: "9876543210",
    categoryId: "591",
    contentId: "31",
    writes: 0,
    searchPostCount: 0,
    categoryListCount: 0,
    failSearchPostWith200Limited: false,
    openAt: open,
    bookResponse: { CODE: "ok", DATA: { result: "success" } },
    bookError: null,
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
        options.onDispatch?.(new Date(wall).toISOString());
        if (io.bookError) throw new TestError(io.bookError);
        const timing = { dispatchToHeadersMs: 20, bodyDecodeMs: 1, businessResultAt: new Date(wall + 21).toISOString(), totalRequestMs: 21 };
        options.onHeaders?.(sample);
        options.onBusiness?.(io.bookResponse, timing);
        if (io.bookResponse?.CODE === "ok") {
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
        options.onHeaders?.(sample);
        return { body: { CODE: "ok", DATA: { is_login: true, uid: io.uid, name: "SECRET_NAME" } } };
      }
      if (path === "/Space/Category/list?LAB_JSON=1") {
        io.categoryListCount++;
        options.onHeaders?.(sample);
        return { body: { content: { defaultItems: [{ name: "自习室", link: "/Seat/Index/searchSeats?room=1" }] } } };
      }
      if (path.startsWith("/Seat/Index/searchSeats?") && !options.form) {
        options.onHeaders?.(sample);
        const isOpenNow = wall >= io.openAt;
        const adv = Date.parse(`${day}T00:00:00+08:00`) / 1000;
        const maxDate = isOpenNow
          ? Date.parse(`${task.date}T00:00:00+08:00`) / 1000 + 86400
          : Date.parse(`${task.date}T00:00:00+08:00`) / 1000;
        return {
          body: {
            data: {
              space_category: { category_id: io.categoryId, content_id: io.contentId },
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
        if (io.failSearchPostWith200Limited) {
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

  const engine = new ScheduledIpadEngine(io, store, () => {}, {
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
      const d = Math.min(250, targetWall - wall);
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
    staticCache,
    coordinator,
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

// Scenario A: Real-world 2026-11-20 regression fixture (searchSeats returns HTTP 200 business LIMITED during formal preflight)
test("A: 2026-11-20 regression fixture — HTTP 200 business LIMITED on searchSeats halts safely with 0 writes and rich diagnostics", async () => {
  const env = makeEnv({ wallInit: Date.parse("2026-11-20T19:55:30+08:00") });
  env.io.failSearchPostWith200Limited = true;
  await env.engine.prepare({ arm: true, confirmed: true, authorizedDay: "2026-11-20" });
  const diag = (await env.engine.diagnosticExport()).current;

  assert.equal(diag.state, "STOPPED");
  assert.equal(diag.reason, "LIMITED");
  assert.equal(diag.attempts, 0);
  assert.equal(diag.armedAt, null);
  assert.equal(diag.firstDispatchAt, null);
  assert.equal(diag.httpStatus, 200);
  assert.equal(diag.stoppedEndpoint, "/Seat/Index/searchSeats");
  assert.equal(diag.normalizedBusinessCode, "LIMITED");
  assert.equal(diag.preparationStage, "SEAT_MAPPING");
  assert.equal(env.io.writes, 0);
  assert.doesNotMatch(JSON.stringify(diag), /9876543210|SECRET_NAME/);
});

// Scenario B: Duplicate clicks / duplicate rehearsal / mode switch produce zero redundant network requests
test("B: duplicate rehearsal clicks and busy/armed re-clicks are blocked with duplicateActionBlocked > 0", async () => {
  const env = makeEnv({ wallInit: Date.parse("2026-11-20T19:51:42+08:00") });
  await env.engine.prepare({ arm: false });
  assert.equal(env.engine.state, "READY_READ_ONLY");
  const countAfterFirst = env.io.searchPostCount;
  assert.equal(countAfterFirst, 1);

  // Rapid duplicate rehearsal clicks within 30s -> blocked, 0 extra requests
  await env.engine.prepare({ arm: false });
  await env.engine.prepare({ arm: false });
  assert.equal(env.io.searchPostCount, 1);

  const diag = (await env.engine.diagnosticExport()).current;
  assert.equal(diag.duplicateActionBlocked, 2);
  assert.equal(diag.requestCountByEndpoint["POST /Seat/Index/searchSeats"], 1);
});

// Scenario C: Static cache reuse (19:51 -> 19:55 skips Category/list & POST searchSeats) AND all invalidation cases
test("C: static cache reuses verified mapping from 19:51 rehearsal at 19:55, and invalidates on expiry/account/target/category change", async () => {
  const sharedCache = { roomQueryEntry: null, mappingEntry: null };
  const env = makeEnv({ wallInit: Date.parse("2026-11-20T19:51:42+08:00"), staticCache: sharedCache });

  // 19:51:42 rehearsal populates cache (1 Category/list + 1 POST searchSeats)
  await env.engine.prepare({ arm: false });
  assert.equal(env.io.categoryListCount, 1);
  assert.equal(env.io.searchPostCount, 1);

  // 19:55:30 formal preflight reuses verified static cache -> ZERO extra Category/list or POST searchSeats!
  env.setWall(Date.parse("2026-11-20T19:55:30+08:00"));
  await env.engine.prepare({ arm: true, confirmed: true, authorizedDay: "2026-11-20" });
  assert.equal(env.engine.state, "WAITING");
  assert.equal(env.io.categoryListCount, 1);
  assert.equal(env.io.searchPostCount, 1);
  const diagHit = (await env.engine.diagnosticExport()).current;
  assert.equal(diagHit.cacheHit.roomQueryHit, true);
  assert.equal(diagHit.cacheHit.seatMappingHit, true);
  assert.equal(diagHit.cacheHit.valid, true);
  assert.equal(diagHit.cacheHit.reason, "VALID");

  // Invalidation 1: Expired (>15 min)
  const envExpired = makeEnv({
    wallInit: Date.parse("2026-11-20T19:51:42+08:00") + P71_STATIC_CACHE_TTL_MS + 5000,
    staticCache: structuredClone(sharedCache),
  });
  await envExpired.engine.prepare({ arm: false });
  assert.equal(envExpired.io.searchPostCount, 1);
  assert.equal((await envExpired.engine.diagnosticExport()).current.cacheHit.reason, "EXPIRED");

  // Invalidation 2: Account changed
  const envAcct = makeEnv({
    wallInit: Date.parse("2026-11-20T19:55:30+08:00"),
    staticCache: structuredClone(sharedCache),
  });
  envAcct.io.uid = "1111111111";
  await envAcct.engine.prepare({ arm: false });
  assert.equal(envAcct.io.searchPostCount, 1);
  assert.equal((await envAcct.engine.diagnosticExport()).current.cacheHit.reason, "ACCOUNT_CHANGED");

  // Invalidation 3: Category changed
  const envCat = makeEnv({
    wallInit: Date.parse("2026-11-20T19:55:30+08:00"),
    staticCache: structuredClone(sharedCache),
  });
  envCat.io.categoryId = "999";
  await envCat.engine.prepare({ arm: false });
  assert.equal(envCat.io.searchPostCount, 1);
  assert.equal((await envCat.engine.diagnosticExport()).current.cacheHit.reason, "CATEGORY_CHANGED");

  // Invalidation 4: Target day changed
  const envDay = makeEnv({
    day: "2026-11-21",
    wallInit: Date.parse("2026-11-21T19:55:30+08:00"),
    staticCache: structuredClone(sharedCache),
  });
  await envDay.engine.prepare({ arm: false });
  assert.equal(envDay.io.searchPostCount, 1);
});

// Scenario D: Cross-mode mutual exclusion in BOTH directions (normal <-> scheduled)
test("D: cross-mode mutual exclusion blocks scheduled when normal has UNKNOWN/active, and blocks normal when scheduled is WAITING/UNKNOWN", async () => {
  // Direction 1: Normal mode has UNKNOWN -> Scheduled mode blocked with CROSS_MODE_UNKNOWN
  {
    const env = makeEnv({ wallInit: Date.parse("2026-11-20T19:55:30+08:00") });
    await env.normalEngine.checkLogin();
    const acct = env.normalEngine.identity.account;
    env.normalStore.rows.set(`${acct}:2026-11-20:10:00-1h:1558:62726`, {
      key: `${acct}:2026-11-20:10:00-1h:1558:62726`,
      attempts: 1,
      state: "UNKNOWN",
      reason: "TIMEOUT",
    });
    await env.engine.prepare({ arm: true, confirmed: true, authorizedDay: "2026-11-20" });
    assert.equal(env.engine.state, "STOPPED");
    assert.equal(env.engine.reason, "CROSS_MODE_UNKNOWN");
    const diag = (await env.engine.diagnosticExport()).current;
    assert.deepEqual(diag.crossModeConflict, { blockedByMode: "normal-p70", code: "CROSS_MODE_UNKNOWN" });
    assert.equal(env.io.writes, 0);
  }

  // Direction 2: Scheduled mode is WAITING -> Normal mode prepare blocked with CROSS_MODE_ACTIVE_TASK
  {
    const env = makeEnv({ wallInit: Date.parse("2026-11-20T19:55:30+08:00") });
    await env.engine.prepare({ arm: true, confirmed: true, authorizedDay: "2026-11-20" });
    assert.equal(env.engine.state, "WAITING");
    await assert.rejects(
      () =>
        env.normalEngine.prepare({
          date: "2026-11-20",
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

// Scenario E: Full end-to-end flow with cache hit -> 19:59:15 recalibrate -> 20:00 open confirm -> 1 POST -> verified SUCCESS
test("E: full 19:51 rehearsal -> 19:55 formal preflight (cache hit) -> 19:59:15 recalibrate -> 20:00 open confirm -> single POST -> SUCCESS", async () => {
  const env = makeEnv({ wallInit: Date.parse("2026-11-20T19:51:42+08:00") });
  await env.engine.prepare({ arm: false });
  assert.equal(env.io.searchPostCount, 1);

  env.setWall(Date.parse("2026-11-20T19:55:30+08:00"));
  await env.engine.prepare({ arm: true, confirmed: true, authorizedDay: "2026-11-20" });
  assert.equal(env.engine.state, "WAITING");
  assert.equal(env.io.searchPostCount, 1); // Zero redundant POST searchSeats!

  await env.stepTo(env.task.open + 500);
  await env.engine.diagWrites;

  assert.equal(env.io.writes, 1);
  assert.equal(env.engine.state, "SUCCESS");
  const diag = (await env.engine.diagnosticExport()).current;
  assert.equal(diag.recordVerified, true);
  assert.equal(diag.attempts, 1);
  assert.ok(diag.recalibratedAt);
  assert.ok(diag.firstGatePassedAt);
  assert.ok(diag.openConfirmedAt);
  assert.ok(diag.firstDispatchAt);
  assert.ok(diag.firstRecordVerifiedAt);
  assert.equal(diag.requestCountByEndpoint["POST /Seat/Index/bookSeats"], 1);
  assert.equal(diag.requestCountByEndpoint["POST /Seat/Index/searchSeats"], 1);
});

// Scenario F: 404, NETWORK_ERROR, and Safari suspension produce zero extra writes
test("F: 404, NETWORK_ERROR, and Safari suspension never produce extra booking writes", async () => {
  for (const errCode of ["HTTP_404", "NETWORK_ERROR"]) {
    const env = makeEnv({ wallInit: Date.parse("2026-11-20T19:59:30+08:00") });
    env.io.bookError = errCode;
    await env.engine.prepare({ arm: true, confirmed: true, authorizedDay: "2026-11-20" });
    await env.stepTo(env.task.open + 500);
    assert.equal(env.io.writes, 1);
    assert.equal(env.engine.state, "UNKNOWN");
  }
  // Safari suspension before 20:00 -> 0 writes
  const envSusp = makeEnv({ wallInit: Date.parse("2026-11-20T19:59:30+08:00") });
  await envSusp.engine.prepare({ arm: true, confirmed: true, authorizedDay: "2026-11-20" });
  envSusp.setWall(Date.parse("2026-11-20T19:59:35+08:00")); // 5s stall
  await envSusp.engine.tick();
  assert.equal(envSusp.engine.reason, "SAFARI_TIMER_SUSPENDED");
  assert.equal(envSusp.io.writes, 0);
});

// Artifact integrity check
test("G: built P7.1.1 artifact has valid header, @inject-into page, CrossModeCoordinator, and zero forbidden patterns", async () => {
  const code = await readFile("userscripts/hdu-p711-ipad-scheduled.user.js", "utf8");
  assert.ok(code.startsWith("// ==UserScript=="));
  assert.match(code, /@version\s+7\.1\.1/);
  assert.match(code, /@inject-into\s+page/);
  assert.match(code, /CrossModeCoordinator/);
  assert.match(code, /validateStaticCacheEntry/);
  assert.match(code, /requestCountByEndpoint/);
  assert.doesNotMatch(code, /@require|GM_xmlhttpRequest|document\.cookie|lockSeats|cancelBooking|signIn/);
  assert.doesNotMatch(code, /hdu-p53-formal-booking|hdu-p60-daily-booking|P52_RECEIPT_REQUIRED/);
});
