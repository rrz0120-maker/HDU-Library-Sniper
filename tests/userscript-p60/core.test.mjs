import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  dailyTask,
  validateDailyTask,
  mergeDiagnostics,
  publicDiagnostics,
  pending,
  FIRST_FIELDS,
  canReconcileNotOpen,
} from "../../src/userscript/p60/policy.js";
import {
  checkSchedule,
  targetRange,
  overlaps,
  verified162,
  ReleaseClock,
} from "../../src/userscript/p53/policy.js";
import { signedRequest, TestError } from "../../src/userscript/core.js";
import { DailyEngine } from "../../src/userscript/p60/engine.js";
import { DailyStore } from "../../src/userscript/p60/store.js";
import { MemoryStore, mapBody } from "../userscript-p53/fixtures.mjs";

for (const [day, target] of [
  ["2026-11-18", "2026-11-20"],
  ["2026-11-19", "2026-11-21"],
  ["2026-11-29", "2026-12-01"],
  ["2026-12-31", "2027-01-02"],
  ["2028-02-28", "2028-03-01"],
  ["2027-02-28", "2027-03-02"],
])
  test(`daily Shanghai ${day} -> ${target}, exact 14 hours`, () => {
    const task = dailyTask(Date.parse(`${day}T19:59:00+08:00`));
    assert.equal(task.day, day);
    assert.equal(task.date, target);
    checkSchedule(task);
    validateDailyTask(task);
    assert.equal(task.end - task.begin, 50400);
    assert.equal(task.open, Date.parse(`${day}T20:00:00+08:00`));
    assert.equal(task.seat, "162");
    assert.equal(task.seatId, "62726");
  });
for (const tz of ["UTC", "Asia/Shanghai", "America/Los_Angeles", "Pacific/Auckland"])
  test(`phone timezone ${tz} does not change the Shanghai task`, () => {
    const code = `import {dailyTask} from './src/userscript/p60/policy.js'; process.stdout.write(JSON.stringify(dailyTask(Date.parse('2026-12-31T16:01:00Z'))));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...process.env, TZ: tz },
      encoding: "utf8",
    });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).day, "2027-01-01");
    assert.equal(JSON.parse(r.stdout).date, "2027-01-03");
  });
test("dynamic signature keeps the proven 50400-second vectors", () => {
  for (const v of JSON.parse(readFileSync("tests/fixtures/p53-signatures.json"))) {
    const r = signedRequest(v.seatId, v.uid, v.beginTime, v.apiTime, 50400);
    assert.equal(r.token, v.token);
    assert.equal(r.form.get("duration"), "50400");
  }
});
test("first metrics/timestamps immutable; review timestamp independent", () => {
  const old = Object.fromEntries(FIRST_FIELDS.map((f, i) => [f, i]));
  const next = mergeDiagnostics(old, {
    ...Object.fromEntries(FIRST_FIELDS.map((f) => [f, "replacement"])),
    lastReviewedAt: "2026-11-19T01:00:00Z",
  });
  for (const f of FIRST_FIELDS) assert.equal(next[f], old[f]);
  assert.equal(next.lastReviewedAt, "2026-11-19T01:00:00Z");
  assert.equal(
    mergeDiagnostics({ firstRecordVerifiedAt: null }, { firstRecordVerifiedAt: "first" })
      .firstRecordVerifiedAt,
    "first",
  );
});
test("diagnostic allowlist excludes identity, authentication and request data", () => {
  const out = publicDiagnostics({
    uid: "PRIVATE_UID",
    cookie: "PRIVATE_COOKIE",
    password: "PRIVATE_PASSWORD",
    name: "PRIVATE_NAME",
    token: "PRIVATE_TOKEN",
    response: { data: "PRIVATE_RESPONSE" },
    timings: { raw: "PRIVATE_RAW" },
    target: dailyTask(),
    state: "UNKNOWN",
    logs: [{ reason: "HTTP_404", response: "PRIVATE_ERROR" }],
  });
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE_/);
  assert.equal(out.firstRecordVerifiedAt, null);
});

class Store extends MemoryStore {
  takeVerification = DailyStore.prototype.takeVerification;
  verificationFinished = DailyStore.prototype.verificationFinished;
  reconcileNotOpen = DailyStore.prototype.reconcileNotOpen;
  async transact(key, change) {
    const old = await this.get(key);
    const next = change(old);
    if (next) this.rows.set(key, next);
    return next || old;
  }
  bind(account) {
    this.account = account;
  }
  async list() {
    return [...this.rows.values()];
  }
  async legacy() {
    if ([...this.rows.values()].some(pending)) throw new TestError("PREVIOUS_UNKNOWN");
    return this.receipt;
  }
  async reserve(row) {
    return super.reserve({ ...row, ...mergeDiagnostics({}, row.timings) });
  }
  async finish(key, owner, patch) {
    const old = structuredClone(this.rows.get(key));
    const r = await super.finish(key, owner, patch);
    if (r) {
      const d = mergeDiagnostics(old || {}, patch.timings);
      for (const field of [...FIRST_FIELDS, "uiFeedback", "lastReviewedAt"])
        if (d[field] !== undefined) r[field] = d[field];
      r.timings = mergeDiagnostics(old?.timings || {}, patch.timings);
    }
    return r;
  }
  async stop(key, reason = "USER_STOPPED") {
    const row = this.rows.get(key);
    if (row && !["SUCCESS", "FAILED"].includes(row.state))
      Object.assign(row, { state: row.attempts ? "UNKNOWN" : "STOPPED", reason });
    return row;
  }
  async note(key, values) {
    const row = this.rows.get(key);
    if (row) {
      Object.assign(row, mergeDiagnostics(row, values));
      row.timings = mergeDiagnostics(row.timings || {}, values);
    }
  }
}
function setup(day = "2026-11-18") {
  const task = dailyTask(Date.parse(`${day}T19:59:30+08:00`)),
    time = { wall: task.open - 30000, mono: 0, visible: true };
  const store = new Store(),
    transitions = [];
  const io = {
    writes: 0,
    successRecord: true,
    openAt: task.open,
    openingReads: 0,
    response: { CODE: "ok", DATA: { result: "success" } },
    async request(path, opts = {}) {
      if (opts.write) {
        opts.onDispatch?.(new Date(time.wall).toISOString());
        this.writes++;
        opts.onHeaders?.({ receivedWall: time.wall + 50, timing: { dispatchToHeadersMs: 50 }, status: 200 });
        if (this.failure) throw new TestError(this.failure);
        opts.onBusiness?.(this.response, {
          businessResultAt: new Date(time.wall + 51).toISOString(),
          dispatchToHeadersMs: 50,
          bodyDecodeMs: 1,
        });
        return {
          body: this.response,
          timing: { dispatchToHeadersMs: 50, totalRequestMs: 51, bodyDecodeMs: 1 },
        };
      }
      opts.onHeaders?.({
        date: new Date(time.wall).toUTCString(),
        sentMono: time.mono,
        receivedMono: time.mono,
        receivedWall: time.wall,
      });
      if (path.includes("baseInfo")) return { body: { DATA: { is_login: !this.authFailed, uid: "123456" } } };
      if (path.includes("Category"))
        return {
          body: {
            content: { defaultItems: [{ name: "自习室", link: "/Seat/Index/searchSeats?category_id=3" }] },
          },
        };
      if (path.includes("myBookingList"))
        return {
          body: {
            content: {
              defaultItems:
                this.writes && this.successRecord
                  ? [{ status: 0, time: task.begin, duration: 50400, seatNum: "162", roomName: task.room }]
                  : [],
            },
          },
        };
      if (opts.form) return { body: mapBody() };
      if (time.wall >= task.open) {
        this.openingReads++;
        if (this.openingFailure) throw new TestError(this.openingFailure);
      }
      return {
        body: {
          data: {
            space_category: { category_id: "3", content_id: "93" },
            range: {
              advance_date: day,
              max_date: dailyTask(time.wall >= this.openAt ? task.open + 86400000 : task.open).date,
              minBeginTime: 7,
              maxEndTime: 22,
              min_duration: 1,
              max_duration: 15,
              max_num: 4,
            },
          },
        },
      };
    },
  };
  const engine = new DailyEngine(io, store, (v) => transitions.push({ state: v.state, reason: v.reason }), {
    task,
    wall: () => time.wall,
    mono: () => time.mono,
    visible: () => time.visible,
  });
  const advance = (ms) => {
    time.wall += ms;
    time.mono += ms;
  };
  return { engine, store, io, task, time, advance, transitions };
}
const arm = (s, day = s.task.day) => s.engine.prepare({ arm: true, confirmed: true, authorizedDay: day });
const fire = async (s) => {
  s.advance(30400);
  await s.engine.tick();
  await s.engine.diagWrites;
};
test("read-only remains no-write even after release", async () => {
  const s = setup();
  await s.engine.prepare();
  await fire(s);
  assert.equal(s.io.writes, 0);
  assert.equal(s.engine.state, "READY_READ_ONLY");
});
test("yesterday's authorization and P5.3 fixed slot are rejected", async () => {
  const a = setup();
  await arm(a, "2026-11-17");
  await fire(a);
  assert.equal(a.io.writes, 0);
  const b = setup("2026-11-17");
  await arm(b);
  await fire(b);
  assert.equal(b.engine.reason, "P53_SLOT_FROZEN");
  assert.equal(b.io.writes, 0);
});
test("19:58 gate, already past release and >10s late all stop", async () => {
  for (const delta of [-120000, 31000]) {
    const s = setup();
    s.advance(delta);
    await arm(s);
    await fire(s);
    assert.equal(s.io.writes, 0);
  }
  const s = setup();
  await arm(s);
  s.advance(41000);
  await s.engine.tick();
  assert.equal(s.engine.state, "EXPIRED");
  assert.equal(s.io.writes, 0);
});
test("daily clock preserves conservative lower-bound release", async () => {
  const s = setup();
  await arm(s);
  s.advance(29000);
  await s.engine.tick();
  assert.equal(s.io.writes, 0);
  s.advance(1000);
  await s.engine.tick();
  assert.equal(s.io.writes, 0);
  s.advance(400);
  await s.engine.tick();
  assert.equal(s.io.writes, 1);
});
test("immediate accepted feedback precedes record success and immutable first times", async () => {
  const s = setup();
  await arm(s);
  await fire(s);
  const accepted = s.transitions.findIndex((v) => v.reason === "SERVER_SUCCESS"),
    verified = s.transitions.findIndex((v) => v.state === "SUCCESS");
  assert.ok(accepted >= 0 && verified > accepted);
  assert.equal(s.transitions[accepted].state, "VERIFYING");
  const row = structuredClone(await s.store.get(s.engine.key));
  for (const field of [
    "prepareStartedAt",
    "armedAt",
    "firstDispatchAt",
    "firstResponseAt",
    "firstBusinessResultAt",
    "firstServerSuccessAt",
    "firstRecordVerifiedAt",
  ])
    assert.ok(row[field], field);
  s.advance(7200000);
  await s.engine.review();
  await s.engine.diagWrites;
  const reviewed = await s.store.get(s.engine.key);
  for (const f of FIRST_FIELDS) assert.equal(reviewed[f], row[f], f);
  assert.ok(reviewed.lastReviewedAt);
  assert.equal(s.io.writes, 1);
});
for (const [kind, response, failure, expected] of [
  ["404", {}, "HTTP_404", "UNKNOWN"],
  ["timeout", {}, "TIMEOUT", "UNKNOWN"],
  ["network", {}, "NETWORK_ERROR", "UNKNOWN"],
  ["occupied", { CODE: "ParamError", MESSAGE: "座位不可用" }, null, "FAILED"],
  ["closed", { CODE: "ParamError", MESSAGE: "未到开放时间" }, null, "FAILED"],
  ["limited", { CODE: "1", MESSAGE: "请求太频繁了" }, null, "FAILED"],
  ["accepted without record", { CODE: "ok", DATA: { result: "success" } }, null, "UNKNOWN"],
])
  test(`${kind} never retries; pending UI does not become unverified success`, async () => {
    const s = setup();
    s.io.response = response;
    s.io.failure = failure;
    s.io.successRecord = false;
    await arm(s);
    await fire(s);
    assert.equal(s.engine.state, expected);
    await arm(s);
    await s.engine.tick();
    assert.equal(s.io.writes, 1);
  });
test("auth expiry, wrong date range and full-duration overlaps retain core rules", async () => {
  const s = setup();
  s.io.authFailed = true;
  await arm(s);
  await fire(s);
  assert.equal(s.io.writes, 0);
  assert.throws(() =>
    targetRange({ advance_date: "2026-11-20", max_date: "2026-11-18" }, Date.now(), s.task),
  );
  assert.equal(overlaps([{ status: 0, time: s.task.end - 3600, duration: 3600 }], s.task).length, 1);
  assert.equal(
    verified162(
      [{ status: 0, time: s.task.begin, duration: 3600, seatNum: "162", roomName: s.task.room }],
      { room: s.task.room },
      s.task,
    ),
    false,
  );
});
test("stop before send, in-flight intent and background never restore writes", async () => {
  const s = setup();
  await arm(s);
  await s.engine.stop();
  await fire(s);
  assert.equal(s.io.writes, 0);
  const b = setup();
  await arm(b);
  b.time.visible = false;
  await b.engine.tick();
  b.time.visible = true;
  await fire(b);
  assert.equal(b.io.writes, 0);
});
test("calibration rejects stale sample and wall-clock jumps for dynamic day", () => {
  const s = setup(),
    clock = new ReleaseClock(
      () => s.time.wall,
      () => s.time.mono,
      s.task,
    );
  clock.observe({
    date: new Date(s.time.wall).toUTCString(),
    receivedWall: s.time.wall,
    receivedMono: 0,
    sentMono: 0,
  });
  s.time.wall += 1000;
  assert.throws(() => clock.bounds());
});
test("restored WAITING is view-only, never shows an armed local timer or submits", async () => {
  const s = setup();
  await arm(s);
  const other = new DailyEngine(s.io, s.store, () => {}, {
    task: s.task,
    wall: () => s.time.wall,
    mono: () => s.time.mono,
    visible: () => true,
  });
  await other.review();
  assert.equal(other.reason, "WAITING_VIEW_ONLY");
  assert.equal(other.state, "IDLE");
  s.advance(30400);
  await other.tick();
  assert.equal(s.io.writes, 0);
  await s.engine.tick();
  assert.equal(s.io.writes, 1);
});

test("clock open but official range closed: no write until fresh positive range", async () => {
  const s = setup();
  s.io.openAt = s.task.open + 1000;
  await arm(s);
  await fire(s);
  assert.equal(s.io.writes, 0);
  assert.equal(s.io.openingReads, 1);
  assert.equal(s.engine.reason, "OPEN_RANGE_NOT_YET");
  s.advance(999);
  await s.engine.tick();
  assert.equal(s.io.openingReads, 1);
  s.advance(1);
  await s.engine.tick();
  await s.engine.diagWrites;
  assert.equal(s.io.openingReads, 2);
  assert.equal(s.io.writes, 1);
  assert.ok(s.engine.timings.openConfirmedAt);
});
test("persistent closed range stops after two reads without consuming booking budget", async () => {
  const s = setup();
  s.io.openAt = s.task.open + 10000;
  await arm(s);
  await fire(s);
  s.advance(1000);
  await s.engine.tick();
  await s.engine.diagWrites;
  assert.equal(s.io.openingReads, 2);
  assert.equal(s.io.writes, 0);
  assert.equal(s.engine.reason, "OPEN_RANGE_UNCONFIRMED");
  assert.equal((await s.store.get(s.engine.key)).attempts, 0);
});
test("opening query error fails closed", async () => {
  const s = setup();
  s.io.openingFailure = "HTTP_404";
  await arm(s);
  await fire(s);
  s.advance(1500);
  await s.engine.tick();
  assert.equal(s.io.openingReads, 1);
  assert.equal(s.io.writes, 0);
});
test("definite NOT_OPEN refusal survives later stop", async () => {
  const s = setup();
  s.io.successRecord = false;
  s.io.response = { CODE: "ParamError", MESSAGE: "未到开放时间" };
  await arm(s);
  await fire(s);
  assert.equal(s.engine.state, "FAILED");
  await s.engine.stop();
  assert.equal(s.engine.state, "FAILED");
  assert.equal((await s.store.get(s.engine.key)).state, "FAILED");
  assert.equal(s.io.writes, 1);
});
test("legacy NOT_OPEN recovery requires prior terminal evidence", () => {
  const t = "2026-11-19T12:00:00.550Z";
  const row = {
    state: "UNKNOWN",
    reason: "USER_STOPPED",
    attempts: 1,
    recordVerified: false,
    responseCode: "NOT_OPEN",
    firstDispatchAt: "2026-11-19T12:00:00.440Z",
    firstBusinessResultAt: t,
    uiFeedback: { FAILED: { stateUpdatedAt: "2026-11-19T12:00:00.743Z" } },
  };
  assert.equal(canReconcileNotOpen(row), true);
  assert.equal(canReconcileNotOpen({ ...row, responseCode: "TIMEOUT" }), false);
  assert.equal(canReconcileNotOpen({ ...row, uiFeedback: {} }), false);
  assert.equal(canReconcileNotOpen({ ...row, firstServerSuccessAt: t }), false);
});

test("historical recovery permit is separate, explicit, and consumed even on read error", async () => {
  const store = new Store();
  store.bind("account");
  const key = "account:2026-11-21:08:00-22:00";
  const now = Date.parse("2026-11-20T01:04:19Z");
  const row = {
    key,
    state: "UNKNOWN",
    reason: "USER_STOPPED",
    attempts: 1,
    recordVerified: false,
    responseCode: "NOT_OPEN",
    firstDispatchAt: "2026-11-19T12:00:00.440Z",
    firstBusinessResultAt: "2026-11-19T12:00:00.550Z",
    uiFeedback: { FAILED: { stateUpdatedAt: "2026-11-19T12:00:00.743Z" } },
    verifications: 3,
    lastVerification: now - 3000,
  };
  store.rows.set(key, row);
  for (const missingEvidence of [
    { responseCode: "HTTP_404" },
    { responseCode: "TIMEOUT" },
    { responseCode: "SERVER_SUCCESS" },
    { firstServerSuccessAt: row.firstBusinessResultAt },
    { recordVerified: undefined },
    { uiFeedback: {} },
  ]) {
    store.rows.set(key, { ...row, ...missingEvidence });
    assert.equal((await store.takeVerification(key, now, true)).reason, "VERIFICATION_BUDGET_EXHAUSTED");
    assert.equal((await store.get(key)).historyRecoveryChecks, undefined);
    assert.equal((await store.get(key)).state, "UNKNOWN");
  }
  store.rows.set(key, row);
  assert.equal((await store.takeVerification(key, now, false)).reason, "VERIFICATION_BUDGET_EXHAUSTED");
  const grant = await store.takeVerification(key, now, true);
  assert.equal(grant.stamp, "lastHistoryRecoveryVerification");
  await store.verificationFinished(key, grant, "VERIFICATION_READ_ERROR", "HTTP_404");
  await store.reconcileNotOpen(key, new Date(now).toISOString(), grant);
  assert.equal((await store.takeVerification(key, now + 3000, true)).reason, "HISTORY_RECOVERY_EXHAUSTED");
  assert.deepEqual(publicDiagnostics(await store.get(key)), {
    ...publicDiagnostics(row),
    historyRecoveryChecks: 1,
    lastHistoryRecoveryVerification: now,
    verificationBlockReason: "HISTORY_RECOVERY_EXHAUSTED",
    verificationResult: "VERIFICATION_READ_ERROR",
    verificationErrorCode: "HTTP_404",
  });
});
