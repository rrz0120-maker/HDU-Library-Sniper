import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { TestError } from "../../src/userscript/core.js";
import {
  P70_DURATION,
  P70_RECORD_PATH,
  publicIpadDiagnostics,
  resolveRoomsAndSeats,
  safeRandomId,
  slotBeginTime,
  slotSummary,
  validateSlotSelection,
  verifiedSlot,
} from "../../src/userscript/p70/policy.js";
import { IpadStore } from "../../src/userscript/p70/store.js";
import { IpadBookingEngine } from "../../src/userscript/p70/engine.js";

class MemoryStore {
  constructor({ failProbe = false } = {}) {
    this.rows = new Map();
    this.spentKeys = new Set();
    this.account = null;
    this.failProbe = failProbe;
    this.legacyTouched = false;
    this.prefix = "hdu-p70:";
  }
  bind(account) {
    this.account = account;
  }
  async probe() {
    if (this.failProbe) {
      const err = new TestError("STORAGE_UNAVAILABLE");
      throw err;
    }
  }
  async get(key) {
    return this.rows.has(key) ? structuredClone(this.rows.get(key)) : null;
  }
  async list(account = this.account) {
    return [...this.rows.values()]
      .filter((r) => r.key.startsWith(`${account}:`))
      .map((r) => structuredClone(r));
  }
  async pendingUnknown(account = this.account) {
    return (await this.list(account)).find((r) => r.attempts === 1 && !["SUCCESS", "FAILED"].includes(r.state)) || null;
  }
  spent(key) {
    return this.spentKeys.has(key);
  }
  stopSignal() {}
  async claim(intent) {
    const pending = await this.pendingUnknown(this.account);
    if (pending) {
      const err = new TestError("PREVIOUS_UNKNOWN");
      throw err;
    }
    const existing = await this.get(intent.key);
    if (existing || this.spentKeys.has(intent.key)) return { won: false, value: existing };
    const saved = structuredClone({ ...intent, attempts: 1, verifications: 0 });
    this.rows.set(intent.key, saved);
    this.spentKeys.add(intent.key);
    return { won: true, value: structuredClone(saved) };
  }
  async finish(key, ticket, patch) {
    const old = this.rows.get(key);
    if (!old || old.ticket !== ticket) return old ? structuredClone(old) : null;
    const terminal =
      old.state === "SUCCESS" ||
      (old.state === "FAILED" && !(patch.state === "SUCCESS" && patch.recordVerified === true));
    if (terminal) return structuredClone(old);
    const next = { ...old, ...patch, timings: { ...(old.timings || {}), ...(patch.timings || {}) } };
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
  async noteReview(key, at, logs) {
    const old = this.rows.get(key);
    if (!old) return null;
    old.lastReviewedAt = at;
    if (logs) old.logs = logs.slice(-50);
    return structuredClone(old);
  }
}

function makeSeatMap({ seat162Free = true, seat101Free = true, seat101Id = "70101" } = {}) {
  return {
    allContent: {
      children: [
        {},
        {},
        {
          children: {
            children: [
              {
                roomName: "三楼东区阅览室",
                seatMap: {
                  info: { id: 1501 },
                  POIs: [
                    { title: "101", id: seat101Id, state: seat101Free ? "0" : "1" },
                    { title: "102", id: "70102", state: "1" },
                    { title: "2", id: "70002", state: "0" },
                  ],
                },
              },
              {
                roomName: "宋韵云图（四楼）",
                seatMap: {
                  info: { id: 1558 },
                  POIs: [
                    { title: "162", id: "62726", state: seat162Free ? "0" : "1" },
                    { title: "157", id: "62721", state: "0" },
                  ],
                },
              },
            ],
          },
        },
      ],
    },
  };
}

function makeMockIO(opts = {}) {
  let now = opts.now ?? Date.parse("2026-11-20T09:30:00+08:00");
  const state = {
    uid: opts.uid ?? "9876543210",
    loggedIn: opts.loggedIn ?? true,
    clockOk: opts.clockOk ?? true,
    seat162Free: opts.seat162Free ?? true,
    seat101Free: opts.seat101Free ?? true,
    seat101Id: opts.seat101Id ?? "70101",
    bookResponse: opts.bookResponse ?? { CODE: "ok", DATA: { result: "success" } },
    bookError: opts.bookError ?? null,
    records: opts.records ?? [],
    recordAfterBook: opts.recordAfterBook ?? true,
    writes: 0,
    recordReads: 0,
    seatPostReads: 0,
    lastWriteForm: null,
  };

  const io = {
    state,
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
    clockValid: () => state.clockOk,
    async request(path, options = {}) {
      const dispatchAt = new Date(now).toISOString();
      if (options.write) {
        state.writes++;
        state.lastWriteForm = options.form;
        options.onDispatch?.(dispatchAt);
        if (state.bookError) {
          const err = new TestError(state.bookError);
          err.timing = { totalRequestMs: 42 };
          throw err;
        }
        const timing = {
          dispatchAt,
          responseAt: new Date(now + 15).toISOString(),
          dispatchToHeadersMs: 15,
          bodyDecodeMs: 2,
          businessResultAt: new Date(now + 17).toISOString(),
          totalRequestMs: 17,
        };
        options.onHeaders?.({ status: 200, timing });
        options.onBusiness?.(state.bookResponse, timing);
        if (state.recordAfterBook && state.bookResponse?.CODE === "ok") {
          const seatId = options.form.get("seats[0]");
          const is162 = seatId === "62726";
          state.records.push({
            status: "1",
            time: Number(options.form.get("beginTime")),
            duration: Number(options.form.get("duration")),
            seatNum: is162 ? "162" : "101",
            seatId,
            roomName: is162 ? "宋韵云图（四楼）" : "三楼东区阅览室",
          });
        }
        return { body: state.bookResponse, timing };
      }

      if (path === "/User/Center/baseInfo") {
        return {
          body: state.loggedIn
            ? { CODE: "ok", DATA: { is_login: true, uid: state.uid, name: "SECRET_USER" } }
            : { CODE: "ok", DATA: { is_login: false } },
          timing: { totalRequestMs: 5 },
        };
      }
      if (path === "/Space/Category/list?LAB_JSON=1") {
        return {
          body: { content: { defaultItems: [{ name: "自习室", link: "/Seat/Index/searchSeats?room=1" }] } },
          timing: { totalRequestMs: 5 },
        };
      }
      if (path.startsWith("/Seat/Index/searchSeats?") && !options.form) {
        return {
          body: {
            data: {
              space_category: { category_id: "591", content_id: "31" },
              range: {
                advance_date: Date.parse("2026-11-20T00:00:00+08:00") / 1000,
                max_date: Date.parse("2026-11-22T00:00:00+08:00") / 1000,
                minBeginTime: 8,
                maxEndTime: 22,
                min_duration: 1,
                max_duration: 14,
                max_num: 1,
              },
            },
          },
          timing: { totalRequestMs: 5 },
        };
      }
      if (path === "/Seat/Index/searchSeats?LAB_JSON=1" && options.form) {
        state.seatPostReads++;
        return {
          body: makeSeatMap({
            seat162Free: state.seat162Free,
            seat101Free: state.seat101Free,
            seat101Id: state.seat101Id,
          }),
          timing: { totalRequestMs: 8 },
        };
      }
      if (path === P70_RECORD_PATH) {
        state.recordReads++;
        return { body: { content: { defaultItems: state.records } }, timing: { totalRequestMs: 6 } };
      }
      throw new Error(`Unexpected path: ${path}`);
    },
  };
  return io;
}

test("resolveRoomsAndSeats parses multiple rooms, sorts preferred room first and seats naturally", () => {
  const rooms = resolveRoomsAndSeats(makeSeatMap());
  assert.equal(rooms.length, 2);
  assert.equal(rooms[0].room, "宋韵云图（四楼）");
  assert.equal(rooms[0].freeCount, 2);
  assert.equal(rooms[1].room, "三楼东区阅览室");
  assert.deepEqual(
    rooms[1].seats.map((s) => s.number),
    ["2", "101", "102"],
  );
  assert.equal(rooms[1].freeCount, 2);
});

test("validateSlotSelection enforces 1-hour future open slots and exclusive max_date", () => {
  const range = { dates: ["2026-11-20", "2026-11-21"], min: 8, max: 22, maxDateExclusive: "2026-11-22" };
  const now = Date.parse("2026-11-20T09:30:00+08:00");
  const begin = validateSlotSelection({ date: "2026-11-20", hour: 10, hours: 1 }, range, now);
  assert.equal(begin, Date.parse("2026-11-20T10:00:00+08:00") / 1000);
  assert.throws(() => validateSlotSelection({ date: "2026-11-20", hour: 9, hours: 1 }, range, now), /DATE_OR_TIME_NOT_OPEN/);
  assert.throws(() => validateSlotSelection({ date: "2026-11-22", hour: 10, hours: 1 }, range, now), /DATE_OR_TIME_NOT_OPEN/);
  assert.throws(() => validateSlotSelection({ date: "2026-11-20", hour: 10, hours: 2 }, range, now), /INVALID_TIME/);
  assert.throws(() => validateSlotSelection({ date: "2026-11-20", hour: 22, hours: 1 }, range, now), /INVALID_TIME/);
});

test("read-only checkLogin, openDates, and queryRooms perform zero writes and leak no UID", async () => {
  const io = makeMockIO();
  const store = new MemoryStore();
  const engine = new IpadBookingEngine(io, store);
  assert.deepEqual(await engine.checkLogin(), { valid: true });
  const range = await engine.openDates();
  assert.deepEqual(range.dates, ["2026-11-20", "2026-11-21"]);
  const queried = await engine.queryRooms("2026-11-20", 10);
  assert.equal(queried.rooms.length, 2);
  assert.equal(queried.conflicts, 0);
  assert.equal(io.state.writes, 0);
  const exported = JSON.stringify(await engine.diagnosticExport());
  assert.doesNotMatch(exported, /9876543210|SECRET_USER|Api-Token/);
});

test("user-selected available seat in any room completes single 1-hour booking and official record verification", async () => {
  const io = makeMockIO();
  const store = new MemoryStore();
  const engine = new IpadBookingEngine(io, store);
  const preview = await engine.prepare({
    date: "2026-11-20",
    hour: 10,
    floorId: 1501,
    room: "三楼东区阅览室",
    seatId: "70101",
    seatNumber: "101",
  });
  assert.equal(io.state.writes, 0);
  assert.match(slotSummary(preview.target), /2026-11-20 10:00–11:00 · 1小时 \/ 1人 · 三楼东区阅览室 101号/);

  const result = await engine.confirm(preview.ticket, { details: true, rules: true });
  assert.equal(io.state.writes, 1);
  assert.equal(io.state.seatPostReads, 1);
  assert.equal(io.state.lastWriteForm.get("duration"), String(P70_DURATION));
  assert.equal(io.state.lastWriteForm.get("seats[0]"), "70101");
  assert.equal(result.state, "SUCCESS");
  assert.equal(result.recordVerified, true);
  assert.equal(result.attempts, 1);

  const exported = await engine.diagnosticExport();
  assert.equal(exported.current.state, "SUCCESS");
  assert.equal(exported.current.room, "三楼东区阅览室");
  assert.equal(exported.current.seatNumber, "101");
  assert.equal(exported.current.duration, 3600);
  assert.doesNotMatch(JSON.stringify(exported), /9876543210|SECRET_USER/);
});

test("confirm requires both checkboxes and valid unexpired ticket", async () => {
  const io = makeMockIO();
  const store = new MemoryStore();
  const engine = new IpadBookingEngine(io, store);
  const preview = await engine.prepare({
    date: "2026-11-20",
    hour: 10,
    floorId: 1558,
    room: "宋韵云图（四楼）",
    seatId: "62726",
    seatNumber: "162",
  });
  await assert.rejects(() => engine.confirm(preview.ticket, { details: true, rules: false }), /CONFIRMATION_REQUIRED/);
  assert.equal(io.state.writes, 0);

  const preview2 = await engine.prepare({
    date: "2026-11-20",
    hour: 10,
    floorId: 1558,
    room: "宋韵云图（四楼）",
    seatId: "62726",
    seatNumber: "162",
  });
  io.advance(300001);
  await assert.rejects(() => engine.confirm(preview2.ticket, { details: true, rules: true }), /PREVIEW_EXPIRED/);
  assert.equal(io.state.writes, 0);
});

test("queryRooms->prepare->confirm uses only ONE searchSeats POST; occupied/conflict/background stop before write", async () => {
  // Full guided flow sends exactly 1 searchSeats POST total
  {
    const io = makeMockIO();
    const engine = new IpadBookingEngine(io, new MemoryStore());
    await engine.checkLogin();
    await engine.openDates();
    await engine.queryRooms("2026-11-20", 10);
    const p = await engine.prepare({ date: "2026-11-20", hour: 10, floorId: 1501, seatId: "70101", seatNumber: "101" });
    const r = await engine.confirm(p.ticket, { details: true, rules: true });
    assert.equal(r.state, "SUCCESS");
    assert.equal(io.state.seatPostReads, 1);
    assert.equal(io.state.writes, 1);
  }
  // Occupied seat blocked at prepare
  {
    const io = makeMockIO({ seat101Free: false });
    const engine = new IpadBookingEngine(io, new MemoryStore());
    await assert.rejects(
      () => engine.prepare({ date: "2026-11-20", hour: 10, floorId: 1501, seatId: "70101", seatNumber: "101" }),
      /SEAT_UNAVAILABLE/,
    );
    assert.equal(io.state.writes, 0);
  }
  // Mapping mismatch blocked at prepare
  {
    const io = makeMockIO({ seat101Id: "79999" });
    const engine = new IpadBookingEngine(io, new MemoryStore());
    await assert.rejects(
      () => engine.prepare({ date: "2026-11-20", hour: 10, floorId: 1501, seatId: "70101", seatNumber: "101" }),
      /MAPPING_INVALID/,
    );
    assert.equal(io.state.writes, 0);
  }
  // Existing overlapping booking
  {
    const io = makeMockIO({
      records: [
        {
          status: "1",
          time: slotBeginTime({ date: "2026-11-20", hour: 10, hours: 1 }),
          duration: 3600,
          seatNum: "157",
          roomName: "宋韵云图（四楼）",
        },
      ],
    });
    const engine = new IpadBookingEngine(io, new MemoryStore());
    await assert.rejects(
      () => engine.prepare({ date: "2026-11-20", hour: 10, floorId: 1501, seatId: "70101", seatNumber: "101" }),
      /EXISTING/,
    );
    assert.equal(io.state.writes, 0);
  }
  // Page hidden (background)
  {
    const io = makeMockIO();
    let isVisible = true;
    const engine = new IpadBookingEngine(io, new MemoryStore(), () => {}, { visible: () => isVisible });
    const p = await engine.prepare({ date: "2026-11-20", hour: 10, floorId: 1501, seatId: "70101", seatNumber: "101" });
    isVisible = false;
    await assert.rejects(() => engine.confirm(p.ticket, { details: true, rules: true }), /FOREGROUND_REQUIRED/);
    assert.equal(io.state.writes, 0);
  }
});

test("single-write protection blocks duplicate submission on same slot across two engines", async () => {
  const io = makeMockIO();
  const store = new MemoryStore();
  const e1 = new IpadBookingEngine(io, store);
  const e2 = new IpadBookingEngine(io, store);
  const p1 = await e1.prepare({ date: "2026-11-20", hour: 10, floorId: 1501, seatId: "70101", seatNumber: "101" });
  const p2 = await e2.prepare({ date: "2026-11-20", hour: 10, floorId: 1501, seatId: "70101", seatNumber: "101" });
  const r1 = await e1.confirm(p1.ticket, { details: true, rules: true });
  assert.equal(r1.state, "SUCCESS");
  const r2 = await e2.confirm(p2.ticket, { details: true, rules: true });
  assert.equal(io.state.writes, 1);
  assert.equal(r2.state, "SUCCESS");
});

test("timeout/404/network produce UNKNOWN, block new bookings, and bounded review can promote to SUCCESS", async () => {
  for (const errCode of ["TIMEOUT", "HTTP_404", "NETWORK_ERROR"]) {
    const io = makeMockIO({ bookError: errCode, recordAfterBook: false });
    const store = new MemoryStore();
    const engine = new IpadBookingEngine(io, store);
    const p = await engine.prepare({ date: "2026-11-20", hour: 10, floorId: 1501, seatId: "70101", seatNumber: "101" });
    const r = await engine.confirm(p.ticket, { details: true, rules: true });
    assert.equal(io.state.writes, 1);
    assert.equal(r.state, "UNKNOWN");

    // Any new booking on a different seat is blocked until UNKNOWN is resolved
    await assert.rejects(
      () => engine.prepare({ date: "2026-11-20", hour: 11, floorId: 1558, seatId: "62726", seatNumber: "162" }),
      /PREVIOUS_UNKNOWN/,
    );
    assert.equal(io.state.writes, 1);

    // Review before 2s interval is throttled; after 2s with real record promotes to SUCCESS without new write
    io.state.records.push({
      status: "1",
      time: slotBeginTime(p.target),
      duration: 3600,
      seatNum: "101",
      seatId: "70101",
      roomName: "三楼东区阅览室",
    });
    io.advance(2500);
    const reviewed = await engine.review();
    assert.equal(reviewed.state, "SUCCESS");
    assert.equal(reviewed.recordVerified, true);
    assert.equal(io.state.writes, 1);
  }
});

test("definite refusal (SEAT_UNAVAILABLE / LIMITED) never retries and LIMITED performs zero record reads", async () => {
  const io1 = makeMockIO({
    bookResponse: { CODE: "ParamError", MESSAGE: "座位不可用" },
    recordAfterBook: false,
  });
  const e1 = new IpadBookingEngine(io1, new MemoryStore());
  const p1 = await e1.prepare({ date: "2026-11-20", hour: 10, floorId: 1501, seatId: "70101", seatNumber: "101" });
  const r1 = await e1.confirm(p1.ticket, { details: true, rules: true });
  assert.equal(io1.state.writes, 1);
  assert.equal(r1.state, "FAILED");
  assert.equal(r1.reason, "SEAT_UNAVAILABLE");

  const io2 = makeMockIO({ bookError: "LIMITED", recordAfterBook: false });
  const e2 = new IpadBookingEngine(io2, new MemoryStore());
  const p2 = await e2.prepare({ date: "2026-11-20", hour: 10, floorId: 1501, seatId: "70101", seatNumber: "101" });
  const readsBefore = io2.state.recordReads;
  const r2 = await e2.confirm(p2.ticket, { details: true, rules: true });
  assert.equal(io2.state.writes, 1);
  assert.equal(r2.state, "FAILED");
  assert.equal(r2.reason, "LIMITED");
  // confirm performs ZERO record reads after LIMITED
  assert.equal(io2.state.recordReads, readsBefore);
});

test("Safari durability options TypeError falls back cleanly and storage failure fails closed", async () => {
  const store = new IpadStore();
  let calls = 0;
  const fakeDb = {
    transaction(name, mode, options) {
      calls++;
      if (options) throw new TypeError("durability option unsupported");
      return { name, mode };
    },
  };
  const tx = store.openTx(fakeDb, "tasks", "readwrite");
  assert.equal(calls, 2);
  assert.deepEqual(tx, { name: "tasks", mode: "readwrite" });

  // Storage unavailable blocks prepare with zero writes
  const io = makeMockIO();
  const broken = new IpadBookingEngine(io, new MemoryStore({ failProbe: true }));
  await assert.rejects(
    () => broken.prepare({ date: "2026-11-20", hour: 10, floorId: 1501, seatId: "70101", seatNumber: "101" }),
    /STORAGE_UNAVAILABLE/,
  );
  assert.equal(io.state.writes, 0);
});

test("verifiedSlot checks exact room, seat, start time, and 3600s duration; safeRandomId returns UUID", () => {
  assert.match(safeRandomId(), /^[0-9a-f-]{36}$/);
  const target = {
    date: "2026-11-20",
    hour: 10,
    hours: 1,
    room: "三楼东区阅览室",
    seatNumber: "101",
    seatId: "70101",
  };
  const begin = slotBeginTime(target);
  assert.equal(
    verifiedSlot([{ status: "1", time: begin, duration: 3600, seatNum: "101", seatId: "70101", roomName: "三楼东区阅览室" }], target),
    true,
  );
  assert.equal(
    verifiedSlot([{ status: "1", time: begin, duration: 7200, seatNum: "101", seatId: "70101", roomName: "三楼东区阅览室" }], target),
    false,
  );
  assert.equal(
    verifiedSlot([{ status: "1", time: begin, duration: 3600, seatNum: "102", seatId: "70102", roomName: "三楼东区阅览室" }], target),
    false,
  );
});

test("built P7.0 iPad Safari artifact has valid header, zero forbidden patterns, and no legacy DB dependency", async () => {
  const code = await readFile("userscripts/hdu-p70-ipad-phase1.user.js", "utf8");
  assert.ok(code.startsWith("// ==UserScript=="));
  assert.match(code, /@version\s+7\.0\.2-phase1/);
  assert.match(code, /@inject-into\s+page/);
  assert.match(code, /@match\s+https:\/\/hdu\.huitu\.zhishulib\.com\/\*/);
  assert.match(code, /hdu-p70-ipad-booking/);
  assert.doesNotMatch(code, /@require|GM_xmlhttpRequest|document\.cookie|lockSeats|cancelBooking|signIn/);
  assert.doesNotMatch(code, /hdu-p53-formal-booking|hdu-p60-daily-booking|P52_RECEIPT_REQUIRED/);
  const diag = publicIpadDiagnostics({ state: "IDLE", reason: "READ_ONLY_DEFAULT" });
  assert.equal(diag.platform, "ipad-safari-userscripts");
});
