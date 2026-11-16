import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  beginTime,
  md5,
  signedRequest,
  parseRange,
  rangeMidnight,
  inspectRange,
  validateSelection,
  records,
  conflicts,
  roomQuery,
  TestError,
  responseCode,
  shanghaiDate,
} from "../../src/userscript/core.js";
import { Engine } from "../../src/userscript/engine.js";
const vectors = JSON.parse(await readFile(new URL("../fixtures/p51-signatures.json", import.meta.url)));
test("MD5 UTF-8 and shared Rust signing vectors", () => {
  for (const source of ["", "abc", "a".repeat(1000), "杭电🙂"])
    assert.equal(md5(source), createHash("md5").update(source).digest("hex"));
  for (const v of vectors) {
    const request = signedRequest(v.seatId, v.uid, v.beginTime, v.apiTime);
    assert.equal(request.token, v.token);
    assert.equal(request.form.get("duration"), "3600");
    assert.equal(request.form.get("seatBookers[0]"), v.uid);
  }
});
class MemoryLedger {
  data = new Map();
  async get(key) {
    return this.data.get(key) || null;
  }
  async claim(value) {
    this.onClaim?.();
    const old = this.data.get(value.key);
    if (old) return { won: false, value: old };
    this.data.set(value.key, structuredClone(value));
    return { won: true, value };
  }
  async finish(key, ticket, patch) {
    const old = this.data.get(key);
    if (old.ticket === ticket && old.state !== "SUCCESS") this.data.set(key, { ...old, ...patch });
    return this.data.get(key);
  }
}
function fixture() {
  const day = shanghaiDate(Date.now() + 86400000);
  const selection = { date: day, hour: 9, hours: 1, seat: "162" };
  const range = {
    advance_date: day,
    max_date: shanghaiDate(Date.now() + 3 * 86400000),
    minBeginTime: 7,
    maxEndTime: 22,
    min_duration: 1,
    max_duration: 15,
    max_num: 4,
  };
  const map = {
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
                  info: { id: 4 },
                  POIs: [
                    { title: "162", id: "id162", state: "0" },
                    { title: "157", id: "id157", state: "0" },
                  ],
                },
              },
            ],
          },
        },
      ],
    },
  };
  const io = {
    writes: [],
    reads: [],
    loggedIn: true,
    uid: "1234567890",
    available: true,
    before: [],
    after: null,
    response: { CODE: "ok", DATA: { result: "success" } },
    error: null,
    time: Date.now(),
    now() {
      return this.time;
    },
    clockValid() {
      return true;
    },
    async request(path, options = {}) {
      this.onRequest?.(path, options);
      if (options.write) {
        this.writes.push(options);
        this.onWrite?.();
        if (this.error) throw this.error;
        return {
          body: this.response,
          timing: { totalRequestMs: 2, serverProcessingMs: null, requestUploadMs: null },
        };
      }
      this.reads.push(path);
      let body;
      if (path.startsWith("/User")) body = { DATA: { is_login: this.loggedIn, uid: this.uid } };
      else if (path.startsWith("/Space"))
        body = {
          content: {
            defaultItems: [
              {
                name: "自习室",
                link: "/Seat/Index/searchSeats?space_category[category_id]=3&space_category[content_id]=93",
              },
            ],
          },
        };
      else if (path.startsWith("/Seat/Index/myBookingList")) {
        if (this.writes.length && this.verifyError) throw this.verifyError;
        const written = this.writes[0]?.form;
        body = {
          content: {
            defaultItems: this.writes.length
              ? this.after || [
                  {
                    status: 0,
                    time: Number(written.get("beginTime")),
                    duration: 3600,
                    seatNum: written.get("seats[0]") === "id157" ? "157" : "162",
                    roomName: "宋韵云图（四楼）",
                  },
                ]
              : this.before,
          },
        };
      } else if (options.form) body = map;
      else body = { data: { range, space_category: { category_id: 3, content_id: 93 } } };
      return { body, timing: {} };
    },
  };
  const ledger = new MemoryLedger();
  const engine = new Engine(io, ledger);
  return {
    io,
    ledger,
    engine,
    selection,
    range,
    map,
    confirm: (p, e = engine) => e.confirm(p.ticket, { details: true, rules: true }),
  };
}
test("Shanghai date bounds, one hour, invalid dates and date changes", () => {
  const f = fixture();
  const p = parseRange(f.range);
  const first = beginTime(f.selection);
  const changed = { ...f.selection, date: p.dates[1] };
  assert.equal(beginTime(changed) - first, 86400);
  assert.equal(changed.hours, 1);
  for (const patch of [{ seat: "158" }, { hours: 14 }, { date: "2026-02-30" }, { hour: 24 }])
    assert.throws(() => beginTime({ ...f.selection, ...patch }));
  assert.throws(() => validateSelection(f.selection, p, first * 1000));
  for (const max_date of [2, 1794700800, null, { password: "private" }]) {
    assert.throws(() => parseRange({ ...f.range, max_date }));
    assert.ok(!JSON.stringify(inspectRange({ ...f.range, max_date })).includes("private"));
  }
});
test("room query cannot point at another origin", () => {
  assert.throws(() =>
    roomQuery({
      content: {
        defaultItems: [{ name: "自习室", link: "https://evil.invalid/Seat/Index/searchSeats?a=1" }],
      },
    }),
  );
});
test("read-only checks never write, expose no identity or cookies", async () => {
  const f = fixture();
  await f.engine.checkLogin();
  await f.engine.openDates();
  await f.engine.querySeats(f.selection);
  await f.engine.prepare(f.selection);
  assert.equal(f.io.writes.length, 0);
  assert.ok(!JSON.stringify(f.engine.logs).includes(f.io.uid));
});
test("explicitly confirmed 162 success performs one write then exact record verification", async () => {
  const f = fixture();
  const p = await f.engine.prepare(f.selection);
  const result = await f.confirm(p);
  assert.equal(result.state, "SUCCESS");
  assert.equal(result.recordVerified, true);
  assert.equal(f.io.writes.length, 1);
  assert.equal(f.io.writes[0].form.get("duration"), "3600");
  await assert.rejects(() => f.confirm(p));
  await assert.rejects(() => f.engine.prepare(f.selection), /BUDGET_SPENT/);
  assert.equal(f.io.writes.length, 1);
});
test("explicit 157 never tries 162 or another seat", async () => {
  const f = fixture();
  const p = await f.engine.prepare({ ...f.selection, seat: "157" });
  const r = await f.confirm(p);
  assert.equal(r.state, "SUCCESS");
  assert.equal(f.io.writes[0].form.get("seats[0]"), "id157");
  assert.equal(f.io.writes.length, 1);
});
test("both user confirmations required and not restored after failure", async () => {
  for (const options of [{}, { details: true }, { rules: true }]) {
    const f = fixture();
    const p = await f.engine.prepare(f.selection);
    await assert.rejects(() => f.engine.confirm(p.ticket, options), /CONFIRMATION_REQUIRED/);
    assert.equal(f.io.writes.length, 0);
  }
});
test("occupied seat, duplicate mapping, unknown state, conflicts and auth block before write", async () => {
  for (const mode of ["occupied", "duplicate", "unknown", "conflict", "auth"]) {
    const f = fixture();
    const pois = f.map.allContent.children[2].children.children[0].seatMap.POIs;
    if (mode === "occupied") pois[0].state = "1";
    if (mode === "unknown") pois[0].state = "unexpected";
    if (mode === "duplicate") pois.push(pois[0]);
    if (mode === "conflict") f.io.before = [{ status: 0, time: beginTime(f.selection), duration: 3600 }];
    if (mode === "auth") f.io.loggedIn = false;
    await assert.rejects(() => f.engine.prepare(f.selection));
    assert.equal(f.io.writes.length, 0);
  }
});
test("fresh identity/mapping checks and expiring previews precede any write", async () => {
  for (const mode of ["identity", "mapping", "expired"]) {
    const f = fixture();
    const p = await f.engine.prepare(f.selection);
    if (mode === "identity") f.io.uid = "9876543210";
    if (mode === "mapping") f.map.allContent.children[2].children.children[0].seatMap.POIs[0].id = "new-id";
    if (mode === "expired") f.io.time += 300001;
    await assert.rejects(() => f.confirm(p));
    assert.equal(f.io.writes.length, 0);
  }
});
test("timeout may be verified successful without reissue", async () => {
  const f = fixture();
  const p = await f.engine.prepare(f.selection);
  f.io.error = new TestError("TIMEOUT");
  const r = await f.confirm(p);
  assert.equal(r.state, "SUCCESS");
  assert.equal(r.reason, "TIMEOUT");
  assert.equal(f.io.writes.length, 1);
});
test("timeout, HTTP404, invalid response and network failures remain UNKNOWN with one write", async () => {
  for (const code of ["TIMEOUT", "HTTP_404", "NETWORK_ERROR", "RESPONSE_UNKNOWN"]) {
    const f = fixture();
    const p = await f.engine.prepare(f.selection);
    f.io.error = new TestError(code);
    f.io.after = [];
    const r = await f.confirm(p);
    assert.equal(r.state, "UNKNOWN");
    assert.equal(f.io.writes.length, 1);
    const restart = new Engine(f.io, f.ledger);
    await assert.rejects(() => restart.prepare(f.selection), /BUDGET_SPENT/);
    assert.equal(f.io.writes.length, 1);
  }
});
test("limit and auth rejection stop without further read/write; explicit seat rejection never falls back", async () => {
  for (const code of ["LIMITED", "AUTH_REQUIRED", "SEAT_UNAVAILABLE"]) {
    const f = fixture();
    const p = await f.engine.prepare(f.selection);
    f.io.error = new TestError(code);
    f.io.after = [];
    let reads;
    f.io.onWrite = () => {
      reads = f.io.reads.length;
    };
    const r = await f.confirm(p);
    assert.equal(r.state, "STOPPED");
    assert.equal(f.io.writes.length, 1);
    if (code !== "SEAT_UNAVAILABLE") assert.equal(f.io.reads.length, reads);
  }
});
test("all official record fields must match, including duration and room", async () => {
  for (const key of ["time", "duration", "seatNum", "roomName", "status"]) {
    const f = fixture();
    const p = await f.engine.prepare(f.selection);
    f.io.after = [
      {
        status: 0,
        time: beginTime(f.selection),
        duration: 3600,
        seatNum: "162",
        roomName: p.mapping.room,
        [key]: "incorrect",
      },
    ];
    assert.equal((await f.confirm(p)).state, "UNKNOWN");
  }
});
test("failed record read remains UNKNOWN; explicit later review can verify without another write", async () => {
  const f = fixture();
  const p = await f.engine.prepare(f.selection);
  f.io.verifyError = new TestError("HTTP_404");
  assert.equal((await f.confirm(p)).state, "UNKNOWN");
  f.io.verifyError = null;
  assert.equal((await f.engine.review()).state, "SUCCESS");
  assert.equal(f.io.writes.length, 1);
});
test("double confirmation is serialized; durable intent blocks another engine", async () => {
  const f = fixture();
  const other = new Engine(f.io, f.ledger);
  const p = await f.engine.prepare(f.selection),
    q = await other.prepare(f.selection);
  const values = await Promise.allSettled([f.confirm(p), f.confirm(p), f.confirm(q, other)]);
  assert.equal(f.io.writes.length, 1);
  assert.ok(values.some((r) => r.status === "rejected"));
});
test("stop before dispatch spends no additional write, including after intent is persisted", async () => {
  const f = fixture();
  const p = await f.engine.prepare(f.selection);
  f.ledger.onClaim = () => f.engine.stop();
  const r = await f.confirm(p);
  assert.equal(r.state, "UNKNOWN");
  assert.equal(f.io.writes.length, 0);
  assert.equal((await f.ledger.get(p.account)).attempts, 1);
});
test("stop during write permits no hidden subsequent requests", async () => {
  const f = fixture();
  const p = await f.engine.prepare(f.selection);
  let reads;
  f.io.onWrite = () => {
    reads = f.io.reads.length;
    f.engine.stop();
  };
  assert.equal((await f.confirm(p)).state, "UNKNOWN");
  assert.equal(f.io.reads.length, reads);
  assert.equal(f.io.writes.length, 1);
});
test("storage failure before intent forbids submission", async () => {
  const f = fixture();
  const p = await f.engine.prepare(f.selection);
  f.ledger.claim = async () => {
    throw new TestError("STORAGE_UNAVAILABLE");
  };
  await assert.rejects(() => f.confirm(p));
  assert.equal(f.io.writes.length, 0);
});
test("records malformed and explicit upstream categories fail closed", () => {
  assert.throws(() => records({}));
  assert.throws(() => conflicts([{ status: "new" }], fixture().selection));
  assert.equal(responseCode({ CODE: "NotFound" }), "HTTP_404");
  assert.equal(responseCode({ CODE: "ParamError", DATA: { msg: "超出可预约座位时间范围" } }), "NOT_OPEN");
  assert.equal(
    responseCode({
      CODE: "ParamError",
      DATA: { msg: "选择的座位无法预约，可能座位不可用或已经被其他人锁定或占用" },
    }),
    "SEAT_UNAVAILABLE",
  );
});

test("transport uses same-origin cookies, forbids external/extra write endpoints, and times out without replay", async (t) => {
  const { Transport } = await import("../../src/userscript/transport.js");
  const prior = globalThis.location;
  globalThis.location = { origin: "https://hdu.huitu.zhishulib.com" };
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    calls++;
    assert.equal(init.credentials, "same-origin");
    assert.equal(init.mode, "same-origin");
    assert.equal(init.redirect, "error");
    return new Promise((_resolve, reject) =>
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
    );
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const io = new Transport();
    await assert.rejects(
      () => io.request("https://third-party.invalid/Seat/Index/bookSeats", { write: true }),
      /ORIGIN_DENIED/,
    );
    await assert.rejects(() => io.request("/Seat/Index/cancelBooking", { write: true }), /ORIGIN_DENIED/);
    await assert.rejects(() => io.request("/Seat/Index/bookSeats?LAB_JSON=1"), /WRITE_GATE_CLOSED/);
    const pending = io.request("/Seat/Index/bookSeats?LAB_JSON=1", {
      ...signedRequest("162", "123", 1, 1),
      write: true,
    });
    const result = assert.rejects(pending, /TIMEOUT/);
    t.mock.timers.tick(30001);
    await result;
    assert.equal(calls, 1);
  } finally {
    if (prior === undefined) delete globalThis.location;
    else globalThis.location = prior;
  }
});

test("phone resuming after durable intent cannot submit an expired confirmation", async () => {
  const f = fixture();
  const p = await f.engine.prepare(f.selection);
  f.ledger.onClaim = () => {
    f.io.time += 300001;
  };
  const result = await f.confirm(p);
  assert.equal(result.state, "UNKNOWN");
  assert.equal(result.reason, "PREVIEW_EXPIRED");
  assert.equal(f.io.writes.length, 0);
});

test("backup seat occupancy change does not invalidate unchanged selected internal ID", async () => {
  const f = fixture();
  const p = await f.engine.prepare(f.selection);
  f.map.allContent.children[2].children.children[0].seatMap.POIs[1].state = "1";
  assert.equal((await f.confirm(p)).state, "SUCCESS");
  assert.equal(f.io.writes.length, 1);
});

test("P5.2 real Unix seconds convert to Shanghai midnight with exclusive max_date", async () => {
  const raw = JSON.parse(await readFile(new URL("../fixtures/p52-real-range.json", import.meta.url)));
  assert.equal(rangeMidnight(1794758400), Date.parse("2026-11-16T00:00:00+08:00"));
  assert.equal(rangeMidnight(1795017600), Date.parse("2026-11-19T00:00:00+08:00"));
  assert.equal(shanghaiDate(rangeMidnight(1794758400)), "2026-11-16");
  assert.equal(shanghaiDate(rangeMidnight(1795017600)), "2026-11-19");
  const range = parseRange(raw);
  assert.deepEqual(range.dates, ["2026-11-16", "2026-11-17", "2026-11-18"]);
  assert.equal(range.maxDateExclusive, "2026-11-19");
  assert.deepEqual(parseRange({ ...raw, advance_date: "2026-11-16", max_date: "2026-11-19" }), range);
  assert.deepEqual(parseRange({ ...raw, advance_date: "2026-11-16" }), range);
  assert.throws(
    () => validateSelection({ date: "2026-11-19", hour: 8, hours: 1, seat: "162" }, range, 0),
    /DATE_OR_TIME_NOT_OPEN/,
  );
});

test("P5.2 rejects milliseconds, unsafe/fractional numbers, UTC midnight and invalid dates", () => {
  for (const value of [
    1794758400000,
    1795017600000,
    Number.MAX_SAFE_INTEGER + 1,
    Number.MAX_SAFE_INTEGER,
    NaN,
    Infinity,
    -Infinity,
    -1,
    1794758400.5,
    1794758400 + 1,
    1794758400 + 60,
    1794758400 + 3600,
    Date.parse("2026-11-16T00:00:00Z") / 1000,
    "1794758400",
    "1794758400000",
    "2026-02-30",
    "2026-11-31",
    "2026-13-01",
    "2026-11-16T00:00:00+08:00",
    {},
    [],
    true,
    null,
    undefined,
  ]) {
    assert.throws(() => rangeMidnight(value), /DATE_CONTRACT_UNKNOWN/, String(value));
  }
});

test("P5.2 rejects inverted/abnormal spans and handles empty ranges without inventing dates", () => {
  const raw = {
    advance_date: 1794758400,
    max_date: 1795017600,
    minBeginTime: 7,
    maxEndTime: 22,
    min_duration: 1,
    max_duration: 15,
    max_num: 4,
  };
  assert.throws(
    () => parseRange({ ...raw, advance_date: raw.max_date, max_date: raw.advance_date }),
    /DATE_CONTRACT_UNKNOWN/,
  );
  assert.throws(
    () => parseRange({ ...raw, max_date: raw.advance_date + 32 * 86400 }),
    /DATE_CONTRACT_UNKNOWN/,
  );
  assert.equal(parseRange({ ...raw, max_date: raw.advance_date + 31 * 86400 }).dates.length, 31);
  assert.deepEqual(parseRange({ ...raw, max_date: raw.advance_date }).dates, []);
});

test("P5.2 numeric date selection preserves 1-hour start/duration and keeps readonly queries write-free", async () => {
  const f = fixture();
  f.range.advance_date = Date.parse(`${f.range.advance_date}T00:00:00+08:00`) / 1000;
  f.range.max_date = Date.parse(`${f.range.max_date}T00:00:00+08:00`) / 1000;
  const range = await f.engine.openDates();
  for (const date of range.dates) {
    await f.engine.querySeats({ ...f.selection, date });
    assert.equal(beginTime({ ...f.selection, date }), Date.parse(`${date}T09:00:00+08:00`) / 1000);
  }
  assert.equal(f.io.writes.length, 0);
  assert.ok(f.engine.logs.some((log) => log.code === "DATES_OK" && log.maxDateExclusive));
});
