import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { signedRequest } from "../../src/userscript/core.js";
import { SingleEngine } from "../../src/userscript/p53/engine.js";
import {
  TASK,
  ReleaseClock,
  checkSchedule,
  targetRange,
  resolve162,
  overlaps,
  verified162,
  checkLegacy,
} from "../../src/userscript/p53/policy.js";
import { FakeIO, MemoryStore, rawRange, mapBody, validRecord, legacy } from "./fixtures.mjs";

function setup(store = new MemoryStore()) {
  const clock = { wall: TASK.open - 30000, mono: 10000, visible: true };
  const io = new FakeIO(clock);
  const engine = new SingleEngine(io, store, () => {}, {
    wall: () => clock.wall,
    mono: () => clock.mono,
    visible: () => clock.visible,
  });
  const advance = (ms) => {
    clock.wall += ms;
    clock.mono += ms;
  };
  return { engine, store, io, clock, advance };
}
const arm = (s) => s.engine.prepare({ arm: true, confirmed: true });
const fire = async (s) => {
  s.advance(30500);
  await s.engine.tick();
};

test("fixed task: date +2, Shanghai 08–22, 50400s, only 162", () => {
  checkSchedule();
  assert.equal(new Date(TASK.begin * 1000).toISOString(), "2026-11-19T00:00:00.000Z");
  assert.equal(TASK.duration, 50400);
  assert.equal(TASK.seat, "162");
});
test("14h vectors: JS matches independently generated MD5/base64 and shared Rust fixture", () => {
  const vectors = JSON.parse(readFileSync("tests/fixtures/p53-signatures.json"));
  for (const v of vectors) {
    const r = signedRequest(v.seatId, v.uid, v.beginTime, v.apiTime, v.duration);
    assert.equal(r.token, v.token);
    assert.equal(r.form.get("duration"), "50400");
    const source = `post&/Seat/Index/bookSeats?LAB_JSON=1&api_time${v.apiTime}&beginTime${v.beginTime}&duration50400&is_recommend0&seatBookers[0]${v.uid}&seats[0]${v.seatId}`;
    assert.equal(r.token, Buffer.from(createHash("md5").update(source).digest("hex")).toString("base64"));
  }
});
test("max_date exclusive; prepare uses legal old date, does not infer future occupancy", () => {
  const range = targetRange(rawRange(), TASK.open - 60000);
  assert.deepEqual(range.dates, ["2026-11-17", "2026-11-18"]);
  assert.equal(range.maxDateExclusive, TASK.date);
  assert.notEqual(range.mapDate, TASK.date);
  assert.equal(resolve162(mapBody()).id, "62726"); // state=1 on OLD slot is ignored
});
test("range refuses short hours/duration, unrelated dates and inverted bounds", () => {
  for (const patch of [
    { max_duration: 1 },
    { maxEndTime: 21 },
    { minBeginTime: 9 },
    { max_date: 1794931200 },
    { advance_date: 1795104000 },
  ])
    assert.throws(() => targetRange({ ...rawRange(), ...patch }, TASK.open - 60000));
});
test("mapping requires unique 162, exact 1558/62726 and unique ID", () => {
  for (const mutate of [
    (f) => {
      f.seatMap.info.id = 9;
    },
    (f) => {
      f.seatMap.POIs[0].id = "62721";
    },
    (f) => {
      f.seatMap.POIs.push({ title: "162", id: "another" });
    },
    (f) => {
      f.seatMap.POIs.push({ title: "157", id: "62726" });
    },
  ]) {
    const body = mapBody();
    mutate(body.allContent.children[2].children.children[0]);
    assert.throws(() => resolve162(body));
  }
});
test("overlap checks late hours and exact 14h success, rejects 1h/wrong seat/inactive", () => {
  const mapping = resolve162(mapBody());
  assert.equal(overlaps([{ ...validRecord(), time: TASK.begin + 13 * 3600, duration: 3600 }]).length, 1);
  assert.equal(overlaps([{ ...validRecord(), time: TASK.begin + TASK.duration }]).length, 0);
  assert.equal(verified162([validRecord()], mapping), true);
  for (const patch of [
    { duration: 3600 },
    { seatNum: "157" },
    { status: 3 },
    { time: TASK.begin + 3600 },
    { roomName: "其他房间" },
    { seatId: "62721" },
  ])
    assert.equal(verified162([{ ...validRecord(), ...patch }], mapping), false);
});
test("P5.2 receipt is mandatory; no writes or history edits in rehearsal", async () => {
  const s = setup();
  const before = structuredClone(s.store.receipt);
  await s.engine.prepare();
  assert.equal(s.engine.state, "READY_READ_ONLY");
  s.advance(60000);
  await s.engine.tick();
  assert.equal(s.io.writes.length, 0);
  assert.equal(s.store.rows.size, 0);
  assert.deepEqual(s.store.receipt, before);
  assert.throws(() => checkLegacy({ ...legacy(), state: "UNKNOWN" }));
});
test("19:59:59 and local 20:00 with server lower bound not open: zero writes", async () => {
  const s = setup();
  await arm(s);
  s.advance(29000);
  await s.engine.tick();
  assert.equal(s.io.writes.length, 0);
  s.advance(1000);
  await s.engine.tick();
  assert.equal(s.io.writes.length, 0);
  s.advance(250);
  await s.engine.tick();
  assert.equal(s.io.writes.length, 1);
  assert.equal(s.engine.state, "SUCCESS");
});
test("at legal release exactly one POST with fresh api_time, 14h body and no critical-path reads", async () => {
  const s = setup();
  await arm(s);
  const before = s.io.requests.length;
  await fire(s);
  await s.engine.tick();
  assert.equal(s.io.writes.length, 1);
  const f = s.io.writes[0].form;
  assert.equal(f.get("duration"), "50400");
  assert.equal(f.get("seats[0]"), "62726");
  assert.equal(f.get("beginTime"), String(TASK.begin));
  assert.equal(f.get("api_time"), String(Math.floor(s.clock.wall / 1000)));
  assert.equal(s.io.requests[before].write, true);
  assert.equal((await s.store.get(s.engine.key)).attempts, 1);
});
test("phone 4s ahead still waits for server lower bound", () => {
  let wall = TASK.open + 100,
    mono = 0;
  const c = new ReleaseClock(
    () => wall,
    () => mono,
  );
  c.observe({
    date: new Date(TASK.open - 4000).toUTCString(),
    receivedWall: wall,
    sentMono: 0,
    receivedMono: 0,
  });
  assert.equal(c.released(), false);
  wall += 4250;
  mono += 4250;
  assert.equal(c.released(), true);
});
test("clock missing, cached, inaccurate, slow, jumped or stale: fail closed", () => {
  const s = setup(),
    c = new ReleaseClock(
      () => s.clock.wall,
      () => s.clock.mono,
    );
  const sample = {
    date: new Date(s.clock.wall).toUTCString(),
    receivedWall: s.clock.wall,
    sentMono: 10000,
    receivedMono: 10000,
  };
  for (const patch of [{ date: null }, { age: "10" }, { receivedWall: s.clock.wall + 6000 }, { sentMono: 1 }])
    assert.throws(() => c.observe({ ...sample, ...patch }));
  c.observe(sample);
  s.clock.wall += 1000;
  assert.throws(() => c.bounds());
  s.clock.mono += 1000;
  s.advance(121000);
  assert.throws(() => c.bounds());
});
test("timer delayed 3s is safe and sends once; >10s late stops", async () => {
  const a = setup();
  await arm(a);
  a.advance(33000);
  await a.engine.tick();
  assert.equal(a.io.writes.length, 1);
  const b = setup();
  await arm(b);
  b.advance(41000);
  await b.engine.tick();
  assert.equal(b.io.writes.length, 0);
  assert.equal(b.engine.state, "STOPPED");
});
for (const [name, response, failure, record, expected] of [
  ["success", { CODE: "ok", DATA: { result: "success" } }, null, true, "SUCCESS"],
  [
    "seat unavailable",
    { CODE: "ParamError", MESSAGE: "选择的座位无法预约，可能座位不可用或已经被其他人锁定或占用" },
    null,
    false,
    "FAILED",
  ],
  ["not open", { CODE: "ParamError", MESSAGE: "超出可预约座位时间范围" }, null, false, "FAILED"],
  ["HTTP 404", {}, "HTTP_404", false, "UNKNOWN"],
  ["timeout", {}, "TIMEOUT", false, "UNKNOWN"],
  ["network", {}, "NETWORK_ERROR", false, "UNKNOWN"],
  ["timeout with real record", {}, "TIMEOUT", true, "SUCCESS"],
  ["limited", { CODE: "1", MESSAGE: "请求过于频繁，请10分钟后再试" }, null, false, "FAILED"],
  ["auth expired", {}, "AUTH_REQUIRED", false, "FAILED"],
  ["success but record delayed", { CODE: "ok", DATA: { result: "success" } }, null, false, "UNKNOWN"],
  ["unknown response", { CODE: "some-new-format" }, null, false, "UNKNOWN"],
])
  test(`${name}: one POST, explicit outcome, no retry/fallback on click or next tick`, async () => {
    const s = setup();
    s.io.response = response;
    s.io.failure = failure;
    s.io.record = record;
    await arm(s);
    await fire(s);
    assert.equal(s.engine.state, expected);
    await arm(s);
    s.advance(500);
    await s.engine.tick();
    assert.equal(s.io.writes.length, 1);
    if (name === "limited" || name === "auth expired") assert.equal(s.io.requests.at(-1).write, true);
  });
test("existing target-period record (even at 21:00) prevents writes", async () => {
  const s = setup();
  s.io.existing = [{ ...validRecord(), time: TASK.begin + 13 * 3600, duration: 3600 }];
  await arm(s);
  await fire(s);
  assert.equal(s.io.writes.length, 0);
  assert.equal(s.engine.reason, "EXISTING");
});
test("duplicate clicks and two engines share a single durable reservation", async () => {
  const a = setup(),
    b = setup(a.store);
  await Promise.all([arm(a), arm(a), arm(b)]);
  await Promise.all([fire(a), fire(b)]);
  assert.equal(a.io.writes.length + b.io.writes.length, 1);
});
test("refresh/restored engine never resumes WAITING or UNKNOWN", async () => {
  const a = setup();
  await arm(a);
  const b = setup(a.store);
  await b.engine.tick();
  await arm(b);
  await fire(b);
  assert.equal(b.io.writes.length, 0);
  a.io.failure = "TIMEOUT";
  a.io.record = false;
  await fire(a);
  const c = setup(a.store);
  await arm(c);
  await fire(c);
  assert.equal(c.io.writes.length, 0);
});
test("background transition stops and returning foreground never resumes", async () => {
  const s = setup();
  await arm(s);
  s.clock.visible = false;
  await s.engine.tick();
  s.clock.visible = true;
  await fire(s);
  await arm(s);
  assert.equal(s.io.writes.length, 0);
});
test("stop before release persists tombstone, blocks other tabs and refresh", async () => {
  const s = setup();
  await arm(s);
  await s.engine.stop();
  await fire(s);
  const b = setup(s.store);
  await arm(b);
  await fire(b);
  assert.equal(s.io.writes.length + b.io.writes.length, 0);
  assert.equal(s.store.stopped(), true);
});
test("stop after claim but before fetch spends budget, zero writes", async () => {
  const s = setup();
  await arm(s);
  const claim = s.store.claim.bind(s.store);
  s.store.claim = async (...args) => {
    const result = await claim(...args);
    await s.engine.stop();
    return result;
  };
  await fire(s);
  assert.equal(s.io.writes.length, 0);
  assert.equal((await s.store.get(s.engine.key)).attempts, 1);
  assert.equal(s.engine.state, "UNKNOWN");
});
test("stop during request cannot imply cancellation: UNKNOWN and one write", async () => {
  const s = setup();
  await arm(s);
  s.io.onWrite = () => s.engine.stop();
  await fire(s);
  assert.equal(s.engine.state, "UNKNOWN");
  assert.equal(s.io.writes.length, 1);
});
test("stop triggered at final send boundary prevents fetch after persisted intent", async () => {
  const s = setup();
  await arm(s);
  s.engine.notify = (view) => {
    if (view.reason === "SUBMITTING_ONCE") void s.engine.stop();
  };
  await fire(s);
  assert.equal(s.io.writes.length, 0);
  assert.equal(s.engine.state, "UNKNOWN");
  assert.equal((await s.store.get(s.engine.key)).attempts, 1);
});
test("unavailable persistence prevents all writes", async () => {
  const s = setup();
  s.store.probe = async () => {
    throw new Error("mock storage failure");
  };
  await arm(s);
  await fire(s);
  assert.equal(s.io.writes.length, 0);
  assert.equal(s.store.rows.size, 0);
});
test("another tab's verified SUCCESS cannot be downgraded by a late timeout", async () => {
  const s = setup();
  await arm(s);
  s.io.record = false;
  s.io.failure = "TIMEOUT";
  s.io.onWrite = async () => {
    const other = setup(s.store);
    other.io.existing = [validRecord()];
    await other.engine.review();
    assert.equal(other.engine.state, "SUCCESS");
  };
  await fire(s);
  assert.equal(s.engine.state, "SUCCESS");
  assert.equal((await s.store.get(s.engine.key)).state, "SUCCESS");
  assert.equal(s.io.writes.length, 1);
});
test("bounded user record checks can promote UNKNOWN, never resubmit", async () => {
  const s = setup();
  s.io.record = false;
  s.io.failure = "TIMEOUT";
  await arm(s);
  await fire(s);
  s.advance(3000);
  await s.engine.review();
  s.advance(3000);
  s.io.record = true;
  await s.engine.review();
  assert.equal(s.engine.state, "SUCCESS");
  assert.equal(s.io.writes.length, 1);
});
test("record check budget persists across reload, maximum 3 including automatic", async () => {
  const s = setup();
  s.io.record = false;
  await arm(s);
  await fire(s);
  for (let i = 0; i < 5; i++) {
    s.advance(3000);
    await s.engine.review();
  }
  assert.equal((await s.store.get(s.engine.key)).verifications, 3);
  assert.equal(s.io.writes.length, 1);
});
test("no real authorization/no P5.2 success/no login/bad mapping: no formal write", async () => {
  for (const cause of ["confirmation", "history", "auth", "mapping"]) {
    const s = setup();
    if (cause === "history") s.store.receipt.state = "UNKNOWN";
    if (cause === "auth") s.io.authFailed = true;
    if (cause === "mapping") s.io.mapping = {};
    await s.engine.prepare({ arm: true, confirmed: cause !== "confirmation" });
    await fire(s);
    assert.equal(s.io.writes.length, 0);
  }
});
