// ==UserScript==
// @name         杭电图书馆 P5.3 四楼162单次整点预约
// @namespace    https://github.com/rrz0120-maker/HDU-Library-Sniper/p53
// @version      5.3.0
// @description  默认只读；明确启用2026-11-17正式任务后，20:00合法开放再单次预约11-19四楼162 08:00–22:00；无重试、无其他座位、无预锁。
// @match        https://hdu.huitu.zhishulib.com/*
// @grant        none
// @noframes
// @run-at       document-idle
// @updateURL    none
// @license      MIT
// ==/UserScript==
(function() {
  "use strict";
  const ORIGIN = "https://hdu.huitu.zhishulib.com";
  const BOOK_PATH = "/Seat/Index/bookSeats?LAB_JSON=1";
  const DAY = 864e5;
  class TestError extends Error {
    constructor(code) {
      super(code);
      this.code = code;
    }
  }
  function check(condition, code) {
    if (!condition) throw new TestError(code);
  }
  function codeOf(error) {
    return error instanceof TestError ? error.code : "LOCAL_ERROR";
  }
  function integer(value) {
    if (typeof value === "string" && /^\d+$/.test(value)) value = Number(value);
    check(Number.isSafeInteger(value), "CONTRACT_UNKNOWN");
    return value;
  }
  const scalar = (v) => typeof v === "string" || typeof v === "number" ? String(v) : "";
  function shanghaiDate(ms = Date.now()) {
    return new Date(ms + 8 * 36e5).toISOString().slice(0, 10);
  }
  function midnight(date) {
    check(typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date), "DATE_CONTRACT_UNKNOWN");
    const ms = Date.parse(`${date}T00:00:00+08:00`);
    check(Number.isFinite(ms) && shanghaiDate(ms) === date, "DATE_CONTRACT_UNKNOWN");
    return ms;
  }
  function rangeMidnight(value) {
    if (typeof value === "string") return midnight(value);
    check(Number.isSafeInteger(value) && value >= 0 && value < 1e10, "DATE_CONTRACT_UNKNOWN");
    const ms = value * 1e3;
    check(midnight(shanghaiDate(ms)) === ms, "DATE_CONTRACT_UNKNOWN");
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date(ms));
    check(
      parts.filter((p) => ["hour", "minute", "second"].includes(p.type)).every((p) => p.value === "00"),
      "DATE_CONTRACT_UNKNOWN"
    );
    return ms;
  }
  function inspectRange(range) {
    const result = {};
    for (const key of [
      "advance_date",
      "max_date",
      "minBeginTime",
      "maxEndTime",
      "min_duration",
      "max_duration",
      "max_num"
    ]) {
      const value = range?.[key];
      const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
      result[key] = {
        type,
        value: type === "number" || type === "string" && /^[0-9\-/: .T+Z]{1,32}$/.test(value) ? value : "未解析"
      };
    }
    return result;
  }
  function parseRange(raw) {
    const first = rangeMidnight(raw?.advance_date), last = rangeMidnight(raw?.max_date);
    check(first <= last && (last - first) / DAY <= 31, "DATE_CONTRACT_UNKNOWN");
    const min = integer(raw.minBeginTime), max = integer(raw.maxEndTime);
    check(
      min >= 0 && max <= 24 && min < max && integer(raw.min_duration) <= 1 && integer(raw.min_duration) >= 1 && integer(raw.max_duration) >= 1,
      "ONE_HOUR_NOT_ALLOWED"
    );
    if (raw.max_num !== void 0) check(integer(raw.max_num) >= 1, "ONE_PERSON_NOT_ALLOWED");
    const dates = [];
    for (let at = first; at < last; at += DAY) dates.push(shanghaiDate(at));
    return { dates, min, max, maxDateExclusive: shanghaiDate(last) };
  }
  function roomMatches(name) {
    return ["宋韵云图（四楼）", "宋韵云图(四楼)", "四楼宋韵云图", "宋韵云图"].includes(name);
  }
  function defaultItems(value) {
    if (!value || typeof value !== "object") return null;
    if (Array.isArray(value.defaultItems) && value.defaultItems.length) return value.defaultItems;
    for (const child of Object.values(value)) {
      const found = defaultItems(child);
      if (found) return found;
    }
    return null;
  }
  function roomQuery(body) {
    const items = [body.content, body.data, body.DATA].map(defaultItems).find(Boolean);
    const rooms = items?.filter((r) => r.name === "自习室") || [];
    check(rooms.length === 1, "ROOM_NOT_UNIQUE");
    const link = rooms[0].link;
    const url = new URL(typeof link === "string" ? link : link?.url, ORIGIN);
    check(url.origin === ORIGIN && url.pathname === "/Seat/Index/searchSeats", "INVALID_ROOM_LINK");
    url.searchParams.set("LAB_JSON", "1");
    return url.pathname + url.search;
  }
  function category(data) {
    const id = scalar(data?.space_category?.category_id), content = scalar(data?.space_category?.content_id);
    check(/^\d+$/.test(id) && id !== "0" && /^\d+$/.test(content), "CATEGORY_UNKNOWN");
    return { category_id: id, content_id: content };
  }
  function records(body) {
    check(Array.isArray(body?.content?.defaultItems), "RECORDS_UNKNOWN");
    return body.content.defaultItems;
  }
  function md5(source) {
    const bytes = new TextEncoder().encode(source);
    const size = Math.ceil((bytes.length + 9) / 64) * 64;
    const buffer = new Uint8Array(size);
    buffer.set(bytes);
    buffer[bytes.length] = 128;
    const view = new DataView(buffer.buffer);
    view.setUint32(size - 8, bytes.length * 8 >>> 0, true);
    view.setUint32(size - 4, Math.floor(bytes.length / 536870912), true);
    const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    const h = [1732584193, 4023233417, 2562383102, 271733878];
    for (let offset = 0; offset < size; offset += 64) {
      let [a, b, c, d] = h;
      for (let i = 0; i < 64; i++) {
        let f, index;
        if (i < 16) {
          f = b & c | ~b & d;
          index = i;
        } else if (i < 32) {
          f = d & b | ~d & c;
          index = (5 * i + 1) % 16;
        } else if (i < 48) {
          f = b ^ c ^ d;
          index = (3 * i + 5) % 16;
        } else {
          f = c ^ (b | ~d);
          index = 7 * i % 16;
        }
        const shift = shifts[Math.floor(i / 16) * 4 + i % 4];
        const sum = a + f + Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) + view.getUint32(offset + index * 4, true) | 0;
        const next = b + (sum << shift | sum >>> 32 - shift) | 0;
        a = d;
        d = c;
        c = b;
        b = next;
      }
      h[0] = h[0] + a | 0;
      h[1] = h[1] + b | 0;
      h[2] = h[2] + c | 0;
      h[3] = h[3] + d | 0;
    }
    return h.flatMap((n) => [0, 8, 16, 24].map((bits) => (n >>> bits & 255).toString(16).padStart(2, "0"))).join("");
  }
  function signedRequest(seatId, uid, begin, apiTime, duration = 3600) {
    check(duration === 3600 || duration === 50400, "INVALID_DURATION");
    const source = `post&${BOOK_PATH}&api_time${apiTime}&beginTime${begin}&duration${duration}&is_recommend0&seatBookers[0]${uid}&seats[0]${seatId}`;
    return {
      token: btoa(md5(source)),
      form: new URLSearchParams({
        beginTime: String(begin),
        duration: String(duration),
        is_recommend: "0",
        api_time: String(apiTime),
        "seats[0]": seatId,
        "seatBookers[0]": uid
      })
    };
  }
  function responseCode(body) {
    const msg = scalar(body?.DATA?.msg) || scalar(body?.MESSAGE);
    if (/频繁|封禁/.test(msg)) return "LIMITED";
    if (body?.CODE === "NotFound") return "HTTP_404";
    if (body?.ui_type === "com.Redirect" || body?.DATA?.is_login === false) return "AUTH_REQUIRED";
    if (body?.CODE === "ok" && body?.DATA?.result === "success") return "SERVER_SUCCESS";
    if (body?.CODE === "ParamError") {
      if (/已有预约|重复预约/.test(msg)) return "EXISTING";
      if (/时间范围|未到/.test(msg)) return "NOT_OPEN";
      if (/座位不可用|占用|无法预约|已被.*锁定/.test(msg)) return "SEAT_UNAVAILABLE";
    }
    return "RESPONSE_UNKNOWN";
  }
  const PATHS = /* @__PURE__ */ new Set([
    "/User/Center/baseInfo",
    "/Space/Category/list",
    "/Seat/Index/searchSeats",
    "/Seat/Index/myBookingList",
    "/Seat/Index/bookSeats"
  ]);
  class Transport {
    constructor() {
      this.clock = null;
    }
    now() {
      return Date.now();
    }
    clockValid() {
      return this.clock && performance.now() - this.clock.at < 6e4 && Math.abs(this.clock.offset) <= 5e3;
    }
    async request(path, { form, token, write = false, signal, onHeaders, onDispatch } = {}) {
      const url = new URL(path, ORIGIN);
      check(location.origin === ORIGIN && url.origin === ORIGIN && PATHS.has(url.pathname), "ORIGIN_DENIED");
      check(url.pathname === "/Seat/Index/bookSeats" === write, "WRITE_GATE_CLOSED");
      if (write) check(path === BOOK_PATH && form && token, "WRITE_GATE_CLOSED");
      if (form && !write) check(url.pathname === "/Seat/Index/searchSeats", "ORIGIN_DENIED");
      const controller = new AbortController();
      let timeout = false;
      const stop = () => controller.abort();
      if (signal?.aborted) throw new TestError("STOPPED");
      signal?.addEventListener("abort", stop, { once: true });
      const timer = setTimeout(
        () => {
          timeout = true;
          controller.abort();
        },
        write ? 3e4 : 5e3
      );
      const start = performance.now();
      const timing = { dispatchAt: (/* @__PURE__ */ new Date()).toISOString(), serverProcessingMs: null, requestUploadMs: null };
      try {
        onDispatch?.(timing.dispatchAt);
        const response = await fetch(url.href, {
          method: form ? "POST" : "GET",
          credentials: "same-origin",
          mode: "same-origin",
          redirect: "error",
          cache: "no-store",
          signal: controller.signal,
          headers: token ? { "Api-Token": token, Accept: "application/json" } : { Accept: "application/json" },
          ...form ? { body: form } : {}
        });
        timing.responseAt = (/* @__PURE__ */ new Date()).toISOString();
        timing.dispatchToHeadersMs = performance.now() - start;
        onHeaders?.({
          date: response.headers.get("Date"),
          age: response.headers.get("Age"),
          sentMono: start,
          receivedMono: performance.now(),
          receivedWall: Date.now()
        });
        const date = Date.parse(response.headers.get("Date"));
        if (Number.isFinite(date)) this.clock = { at: performance.now(), offset: Date.now() - date };
        if (!response.ok)
          throw new TestError(
            response.status === 429 || response.status === 403 ? "LIMITED" : response.status === 401 ? "AUTH_REQUIRED" : response.status === 404 ? "HTTP_404" : "HTTP_ERROR"
          );
        const decode = performance.now();
        const body = await response.json();
        timing.bodyDecodeMs = performance.now() - decode;
        return { body, timing };
      } catch (error) {
        const failure = error instanceof TestError ? error : new TestError(
          signal?.aborted ? "STOPPED" : timeout ? "TIMEOUT" : error instanceof SyntaxError ? "RESPONSE_UNKNOWN" : "NETWORK_ERROR"
        );
        failure.timing = timing;
        throw failure;
      } finally {
        timing.totalRequestMs = performance.now() - start;
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
      }
    }
  }
  async function accountKey(uid) {
    check(globalThis.crypto?.subtle, "STORAGE_UNAVAILABLE");
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`HDU-P5.1:${uid}`));
    return [...new Uint8Array(hash)].map((v) => v.toString(16).padStart(2, "0")).join("");
  }
  const TASK = Object.freeze({
    date: "2026-11-19",
    open: Date.parse("2026-11-17T20:00:00+08:00"),
    begin: Date.parse("2026-11-19T08:00:00+08:00") / 1e3,
    duration: 50400,
    seat: "162",
    seatId: "62726",
    floorId: 1558,
    room: "宋韵云图（四楼）"
  });
  const PREPARE_MS = 12e4;
  const LATE_MS = 1e4;
  const RECORD_PATH = "/Seat/Index/myBookingList?fromType=web&LAB_JSON=1";
  const TASK_SUFFIX = `${TASK.date}:08:00-22:00`;
  function taskKey(account) {
    return `${account}:${TASK_SUFFIX}`;
  }
  function checkSchedule() {
    check(shanghaiDate(TASK.open + 2 * 864e5) === TASK.date, "DATE_RULE_MISMATCH");
    check(TASK.begin + TASK.duration === Date.parse(`${TASK.date}T22:00:00+08:00`) / 1e3, "INVALID_DURATION");
  }
  function targetRange(raw, now) {
    const range = parseRange(raw);
    check(
      range.min <= 8 && range.max >= 22 && integer(raw.min_duration) <= 14 && integer(raw.max_duration) >= 14,
      "FOURTEEN_HOURS_NOT_ALLOWED"
    );
    check(range.dates.includes(TASK.date) || range.maxDateExclusive === TASK.date, "DATE_RULE_MISMATCH");
    check(rangeMidnight(raw.advance_date) <= TASK.begin * 1e3, "DATE_RULE_MISMATCH");
    for (const date of range.dates) {
      for (let hour = range.min; hour + 1 <= range.max; hour++) {
        const begin = rangeMidnight(date) / 1e3 + hour * 3600;
        if (begin * 1e3 > now + 6e4) return { ...range, mapBegin: begin, mapDate: date };
      }
    }
    check(false, "NO_LEGAL_MAPPING_SLOT");
  }
  function resolve162(body) {
    const floors = body?.allContent?.children?.[2]?.children?.children;
    check(Array.isArray(floors), "SEAT_RESPONSE_UNKNOWN");
    const rooms = floors.filter((f) => roomMatches(f.roomName));
    check(rooms.length === 1, "ROOM_NOT_UNIQUE");
    const room = rooms[0];
    check(
      integer(room.seatMap?.info?.id) === TASK.floorId && Array.isArray(room.seatMap?.POIs),
      "MAPPING_INVALID"
    );
    const seats = room.seatMap.POIs.filter((p) => String(p.title).trim() === TASK.seat);
    check(seats.length === 1 && String(seats[0].id) === TASK.seatId, "MAPPING_INVALID");
    check(room.seatMap.POIs.filter((p) => String(p.id) === TASK.seatId).length === 1, "MAPPING_INVALID");
    return { floorId: TASK.floorId, room: room.roomName, number: TASK.seat, id: TASK.seatId };
  }
  function checkLegacy(row) {
    check(
      row?.attempts === 1 && row.state === "SUCCESS" && row.recordVerified === true,
      "P52_RECEIPT_REQUIRED"
    );
    const seats = row.mapping?.seats?.filter((s) => s.number === TASK.seat);
    check(
      row.mapping?.floorId === TASK.floorId && seats?.length === 1 && seats[0].id === TASK.seatId,
      "HISTORY_MAPPING_MISMATCH"
    );
  }
  function overlaps(items) {
    return items.filter((r) => {
      const status = String(r.status);
      if (["3", "4", "5", "6", "7", "9"].includes(status)) return false;
      check(["0", "1", "2"].includes(status), "RECORDS_UNKNOWN");
      const begin = integer(r.time), duration = integer(r.duration);
      check(
        begin > 0 && duration > 0 && duration <= 86400 && Number.isSafeInteger(begin + duration),
        "RECORDS_UNKNOWN"
      );
      return begin < TASK.begin + TASK.duration && begin + duration > TASK.begin;
    });
  }
  function verified162(items, mapping) {
    return overlaps(items).some(
      (r) => integer(r.time) === TASK.begin && integer(r.duration) === TASK.duration && String(r.seatNum).trim() === TASK.seat && r.roomName === mapping.room && (r.seatId === void 0 || String(r.seatId) === TASK.seatId)
    );
  }
  class ReleaseClock {
    constructor(wall = () => Date.now(), mono = () => performance.now()) {
      this.wall = wall;
      this.mono = mono;
      this.sample = null;
    }
    observe(sample) {
      const server = Date.parse(sample.date), rtt = sample.receivedMono - sample.sentMono;
      check(
        Number.isFinite(server) && server % 1e3 === 0 && (!sample.age || sample.age === "0"),
        "CLOCK_UNVERIFIED"
      );
      check(rtt >= 0 && rtt <= 2e3 && Math.abs(sample.receivedWall - server) <= 5e3, "CLOCK_UNVERIFIED");
      this.sample = { ...sample, server, rtt };
    }
    bounds() {
      const s = this.sample;
      check(s, "CLOCK_UNVERIFIED");
      const elapsed = this.mono() - s.receivedMono, wallElapsed = this.wall() - s.receivedWall;
      check(
        elapsed >= 0 && elapsed <= PREPARE_MS && Math.abs(elapsed - wallElapsed) <= 500,
        "CLOCK_CHANGED_OR_STALE"
      );
      return {
        lower: s.server + Math.min(elapsed, wallElapsed) - 250,
        upper: s.server + 1e3 + s.rtt + Math.max(elapsed, wallElapsed) + 250,
        phoneOffsetMs: s.receivedWall - s.server,
        sampleRttMs: s.rtt
      };
    }
    released() {
      return this.wall() >= TASK.open && this.bounds().lower >= TASK.open;
    }
    deadline() {
      check(this.wall() <= TASK.open + LATE_MS && this.bounds().upper <= TASK.open + LATE_MS, "MISSED_WINDOW");
    }
  }
  const REJECTED = /* @__PURE__ */ new Set(["SEAT_UNAVAILABLE", "NOT_OPEN", "EXISTING"]);
  class SingleEngine {
    constructor(io, store, notify = () => {
    }, env = {}) {
      this.io = io;
      this.store = store;
      this.notify = notify;
      this.wall = env.wall || (() => Date.now());
      this.mono = env.mono || (() => performance.now());
      this.visible = env.visible || (() => document.visibilityState === "visible");
      this.clock = new ReleaseClock(this.wall, this.mono);
      this.owner = crypto.randomUUID();
      this.state = "IDLE";
      this.reason = "READ_ONLY_DEFAULT";
      this.generation = 0;
      this.busy = false;
      this.formal = false;
      this.attempted = false;
      this.logs = [];
      this.timings = {};
    }
    emit(state, reason, details = {}) {
      this.state = state;
      this.reason = reason;
      this.logs.push({ at: new Date(this.wall()).toISOString(), state, reason, ...details });
      if (this.logs.length > 40) this.logs.shift();
      this.notify(this.view());
    }
    view() {
      return {
        state: this.state,
        reason: this.reason,
        formal: this.formal,
        login: !!this.identity,
        mapping: this.mapping || null,
        range: this.range || null,
        timings: this.timings,
        logs: this.logs.slice()
      };
    }
    ensure(g) {
      check(g === this.generation, "USER_STOPPED");
    }
    async read(path, g, form, observe = true) {
      this.ensure(g);
      const response = await this.io.request(path, {
        form,
        signal: this.controller.signal,
        onHeaders: observe ? (sample) => this.clock.observe(sample) : void 0
      });
      this.ensure(g);
      const code = responseCode(response.body);
      check(!["LIMITED", "AUTH_REQUIRED", "HTTP_404"].includes(code), code);
      return response.body;
    }
    async login(g, observe = true) {
      const start = this.mono(), body = await this.read("/User/Center/baseInfo", g, void 0, observe);
      const uid = body?.DATA?.uid;
      check(body?.DATA?.is_login === true && /^\d+$/.test(String(uid ?? "")), "AUTH_REQUIRED");
      const account = await accountKey(String(uid));
      this.ensure(g);
      if (this.identity) check(this.identity.account === account, "IDENTITY_CHANGED");
      this.identity = { uid: String(uid), account };
      this.key = taskKey(account);
      this.timings.loginCheckMs = this.mono() - start;
      this.emit(this.state, "LOGIN_OK");
    }
    async prepare({ arm = false, confirmed = false } = {}) {
      if (this.busy || this.formal) return this.view();
      this.busy = true;
      this.formal = arm;
      const g = this.generation;
      this.controller = new AbortController();
      this.emit("PREPARING", arm ? "FORMAL_PREFLIGHT" : "READ_ONLY_REHEARSAL");
      try {
        checkSchedule();
        check(this.visible(), "FOREGROUND_REQUIRED");
        if (arm) {
          check(confirmed, "CONFIRMATION_REQUIRED");
          check(this.wall() >= TASK.open - PREPARE_MS && this.wall() < TASK.open, "PREPARE_WINDOW");
          check(!this.store.stopped(), "USER_STOPPED");
        }
        await this.store.probe();
        this.ensure(g);
        await this.login(g);
        const history = await this.store.legacy(this.identity.account);
        this.ensure(g);
        checkLegacy(history);
        const old = await this.store.get(this.key);
        this.ensure(g);
        if (old || this.store.spent(this.key)) {
          this.timings = old?.timings || this.timings;
          if (old?.logs) this.logs = old.logs.slice(-40);
          this.mapping = old?.mapping || this.mapping;
          this.attempted ||= old?.attempts === 1;
          this.emit(old?.state || "UNKNOWN", "TASK_ALREADY_RESERVED");
          return this.view();
        }
        const start = this.mono();
        const query = roomQuery(await this.read("/Space/Category/list?LAB_JSON=1", g));
        const body = await this.read(query, g), raw = body?.data?.range;
        this.range = targetRange(raw, this.wall());
        const group = category(body?.data);
        this.emit("PREPARING", "RANGE_OK", {
          fields: inspectRange(raw),
          dates: this.range.dates,
          mapDate: this.range.mapDate
        });
        const map = await this.read(
          "/Seat/Index/searchSeats?LAB_JSON=1",
          g,
          new URLSearchParams({
            beginTime: String(this.range.mapBegin),
            duration: "3600",
            num: "1",
            "space_category[category_id]": group.category_id,
            "space_category[content_id]": group.content_id
          })
        );
        this.timings.catalogReadMs = this.mono() - start;
        const parsed = this.mono();
        this.mapping = resolve162(map);
        this.timings.idResolutionMs = this.mono() - parsed;
        const readAt = this.mono();
        check(overlaps(records(await this.read(RECORD_PATH, g))).length === 0, "EXISTING");
        this.timings.conflictReadMs = this.mono() - readAt;
        this.clock.bounds();
        const sample = signedRequest(
          TASK.seatId,
          this.identity.uid,
          TASK.begin,
          Math.floor(this.wall() / 1e3),
          TASK.duration
        );
        check(sample.form.get("duration") === "50400", "INVALID_DURATION");
        this.ensure(g);
        check(this.visible(), "FOREGROUND_REQUIRED");
        this.preparedAt = this.mono();
        if (!arm) {
          this.emit("READY_READ_ONLY", "REHEARSAL_PASSED");
          return this.view();
        }
        check(this.wall() < TASK.open && !this.store.stopped(), "PREPARE_TOO_LATE_OR_STOPPED");
        const reserved = await this.store.reserve({
          key: this.key,
          owner: this.owner,
          state: "WAITING",
          reason: "EXPLICIT_USER_ARM",
          attempts: 0,
          recordVerified: false,
          mapping: this.mapping,
          timings: this.timings,
          logs: this.logs.slice(),
          target: { ...TASK },
          createdAt: new Date(this.wall()).toISOString(),
          verifications: 0
        });
        this.ensure(g);
        check(reserved.won, "TASK_ALREADY_RESERVED");
        this.waiting = true;
        this.emit("WAITING", "ARMED_FOR_2000", { clock: this.clock.bounds() });
      } catch (error) {
        const reason = codeOf(error);
        this.emit(this.attempted ? "UNKNOWN" : "STOPPED", reason);
        if (arm && this.key)
          await this.store.finish(this.key, this.owner, { state: "STOPPED", reason }).catch(() => {
          });
      } finally {
        this.busy = false;
      }
      return this.view();
    }
    async tick() {
      if (!this.waiting || this.busy) return;
      try {
        check(!this.store.stopped(), "USER_STOPPED");
        check(this.visible(), "FOREGROUND_REQUIRED");
        this.clock.deadline();
        if (!this.clock.released()) return;
        await this.submit();
      } catch (error) {
        await this.stop(codeOf(error));
      }
    }
    async submit() {
      this.busy = true;
      this.waiting = false;
      const g = this.generation, localStart = this.mono();
      let claimed = false, reason = "LOCAL_ERROR", verification = null;
      try {
        this.ensure(g);
        check(this.formal && !this.attempted && this.visible() && !this.store.stopped(), "WRITE_GATE_CLOSED");
        check(this.mono() - this.preparedAt <= PREPARE_MS, "PREPARATION_STALE");
        this.clock.deadline();
        check(this.clock.released(), "NOT_RELEASED");
        const claim = await this.store.claim(this.key, this.owner, new Date(this.wall()).toISOString());
        check(claim.won, "BUDGET_SPENT");
        claimed = true;
        this.attempted = true;
        this.ensure(g);
        check(this.visible() && !this.store.stopped(), "USER_STOPPED");
        this.clock.deadline();
        check(this.clock.released(), "NOT_RELEASED");
        const request = signedRequest(
          TASK.seatId,
          this.identity.uid,
          TASK.begin,
          Math.floor(this.wall() / 1e3),
          TASK.duration
        );
        this.timings.preSubmitLocalMs = this.mono() - localStart;
        this.emit("UNKNOWN", "SUBMITTING_ONCE");
        const response = await this.io.request(BOOK_PATH, {
          ...request,
          write: true,
          signal: this.controller.signal,
          onDispatch: (at) => {
            this.ensure(g);
            check(this.visible() && !this.store.stopped(), "USER_STOPPED");
            this.clock.deadline();
            check(this.clock.released(), "NOT_RELEASED");
            this.timings.dispatchAt = at;
            this.notify(this.view());
          }
        });
        this.timings.http = response.timing;
        reason = responseCode(response.body);
      } catch (error) {
        reason = codeOf(error);
        if (error.timing) this.timings.http = error.timing;
      }
      const immediate = !claimed ? "STOPPED" : ["LIMITED", "AUTH_REQUIRED"].includes(reason) ? "FAILED" : "UNKNOWN";
      this.emit(immediate, reason);
      if (claimed) {
        try {
          const persisted = await this.store.finish(this.key, this.owner, {
            state: immediate,
            reason,
            timings: this.timings,
            logs: this.logs.slice()
          });
          if (persisted?.state === "SUCCESS") {
            this.emit("SUCCESS", "RECORD_VERIFIED");
            this.busy = false;
            return;
          }
          if (g === this.generation && !["LIMITED", "AUTH_REQUIRED"].includes(reason) && !this.store.stopped()) {
            verification = await this.verify(g);
          }
          const state = verification === true ? "SUCCESS" : verification === false && REJECTED.has(reason) ? "FAILED" : immediate;
          const finalReason = verification === true ? "RECORD_VERIFIED" : reason;
          const finalRow = await this.store.finish(this.key, this.owner, {
            state,
            reason: finalReason,
            recordVerified: verification === true,
            timings: this.timings,
            logs: this.logs.slice()
          });
          if (finalRow?.state === "SUCCESS") {
            this.emit("SUCCESS", "RECORD_VERIFIED");
            this.busy = false;
            return;
          }
          this.emit(
            g !== this.generation && state !== "SUCCESS" ? "UNKNOWN" : state,
            g !== this.generation && state !== "SUCCESS" ? "USER_STOPPED" : finalReason
          );
        } catch (error) {
          this.emit("UNKNOWN", codeOf(error));
        }
      }
      this.busy = false;
    }
    async verify(g) {
      if (!await this.store.takeVerification(this.key, this.wall())) return null;
      const start = this.mono();
      try {
        const items = records(await this.read(RECORD_PATH, g, void 0, false));
        return verified162(items, this.mapping);
      } catch (error) {
        this.emit("UNKNOWN", codeOf(error));
        return null;
      } finally {
        this.timings.verificationMs = this.mono() - start;
      }
    }
    async review() {
      if (this.busy || this.waiting) return this.view();
      this.busy = true;
      this.controller = new AbortController();
      const g = this.generation;
      try {
        await this.login(g, false);
        const row = await this.store.get(this.key);
        this.ensure(g);
        if (!row) {
          this.emit("IDLE", "NO_FORMAL_TASK");
          return this.view();
        }
        this.mapping = row.mapping;
        this.timings = row.timings || {};
        this.attempted ||= row.attempts === 1;
        if (row.logs) this.logs = row.logs.slice(-40);
        this.emit(row.state, row.reason);
        if (row.state === "SUCCESS" || row.attempts !== 1) return this.view();
        const success = await this.verify(g);
        if (success === true) {
          await this.store.finish(this.key, row.owner, {
            state: "SUCCESS",
            reason: "RECORD_VERIFIED",
            recordVerified: true,
            timings: this.timings
          });
          this.emit("SUCCESS", "RECORD_VERIFIED");
        } else
          this.emit(
            row.state === "FAILED" ? "FAILED" : "UNKNOWN",
            success === null ? "READ_CHECK_LIMIT_OR_ERROR" : "RECORD_NOT_VERIFIED"
          );
      } catch (error) {
        this.emit("UNKNOWN", codeOf(error));
      } finally {
        this.busy = false;
      }
      return this.view();
    }
    async stop(reason = "USER_STOPPED") {
      this.generation++;
      this.waiting = false;
      this.controller?.abort();
      try {
        const formal = this.formal || this.store.active();
        if (formal) this.store.stopSignal();
        if (formal && this.key) {
          const row = await this.store.stop(this.key);
          this.attempted ||= !!row?.attempts;
        }
      } catch {
        reason = "STORAGE_UNAVAILABLE";
      }
      this.emit(this.state === "SUCCESS" ? "SUCCESS" : this.attempted ? "UNKNOWN" : "STOPPED", reason);
    }
  }
  const PREFIX = `hdu-p53:${TASK_SUFFIX}:`;
  class FormalStore {
    async open() {
      if (this.db) return this.db;
      check(globalThis.indexedDB && globalThis.localStorage, "STORAGE_UNAVAILABLE");
      this.db = await new Promise((resolve, reject) => {
        const req = indexedDB.open("hdu-p53-formal-booking", 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore("tasks", { keyPath: "key" });
          req.result.createObjectStore("meta");
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = req.onblocked = () => reject(new TestError("STORAGE_UNAVAILABLE"));
      });
      this.db.onversionchange = () => {
        this.db.close();
        this.db = null;
      };
      return this.db;
    }
    async probe() {
      const db = await this.open();
      const value = crypto.randomUUID();
      localStorage.setItem(`${PREFIX}probe`, value);
      check(localStorage.getItem(`${PREFIX}probe`) === value, "STORAGE_UNAVAILABLE");
      await new Promise((resolve, reject) => {
        const tx = db.transaction("meta", "readwrite", { durability: "strict" });
        tx.objectStore("meta").put(value, "probe");
        tx.oncomplete = resolve;
        tx.onerror = tx.onabort = () => reject(new TestError("STORAGE_UNAVAILABLE"));
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction("meta", "readonly"), req = tx.objectStore("meta").get("probe");
        req.onsuccess = () => req.result === value ? resolve() : reject(new TestError("STORAGE_UNAVAILABLE"));
        tx.onerror = tx.onabort = () => reject(new TestError("STORAGE_UNAVAILABLE"));
      });
    }
    async transact(key, change) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        let result, failure;
        const tx = db.transaction(
          "tasks",
          change ? "readwrite" : "readonly",
          change ? { durability: "strict" } : void 0
        );
        const store = tx.objectStore("tasks"), req = store.get(key);
        req.onsuccess = () => {
          result = req.result || null;
          if (!change) return;
          try {
            const next = change(result);
            if (next) {
              store.put(next);
              result = next;
            }
          } catch (error) {
            failure = error;
            tx.abort();
          }
        };
        tx.oncomplete = () => resolve(result);
        tx.onerror = tx.onabort = () => reject(failure || new TestError("STORAGE_UNAVAILABLE"));
      });
    }
    get(key) {
      return this.transact(key);
    }
    async reserve(row) {
      let won = false;
      const value = await this.transact(row.key, (old) => {
        if (old || this.stopped() || this.spent(row.key)) return null;
        won = true;
        return row;
      });
      if (won) localStorage.setItem(`${PREFIX}active`, "1");
      return { won, value };
    }
    async claim(key, owner, at) {
      let won = false;
      const value = await this.transact(key, (old) => {
        if (!old || old.owner !== owner || old.state !== "WAITING" || old.attempts !== 0 || this.stopped() || this.spent(key))
          return null;
        won = true;
        return { ...old, state: "UNKNOWN", reason: "WRITE_INTENT_PERSISTED", attempts: 1, intentAt: at };
      });
      if (won) localStorage.setItem(`${PREFIX}spent:${key}`, "1");
      return { won, value };
    }
    finish(key, owner, patch) {
      return this.transact(
        key,
        (old) => old?.owner === owner && old.state !== "SUCCESS" ? { ...old, ...patch } : null
      );
    }
    async takeVerification(key, now) {
      let won = false;
      await this.transact(key, (old) => {
        if (!old || old.state === "SUCCESS" || old.attempts !== 1 || (old.verifications || 0) >= 3 || now - (old.lastVerification || 0) < 2e3)
          return null;
        won = true;
        return { ...old, verifications: (old.verifications || 0) + 1, lastVerification: now };
      });
      return won;
    }
    active() {
      return localStorage.getItem(`${PREFIX}active`) === "1";
    }
    spent(key) {
      return localStorage.getItem(`${PREFIX}spent:${key}`) === "1";
    }
    stopped() {
      return localStorage.getItem(`${PREFIX}stop`) === "1";
    }
    stopSignal() {
      localStorage.setItem(`${PREFIX}stop`, "1");
    }
    stop(key) {
      return this.transact(
        key,
        (old) => old && old.state !== "SUCCESS" ? {
          ...old,
          state: old.attempts ? "UNKNOWN" : "STOPPED",
          reason: "USER_STOPPED"
        } : null
      );
    }
    // No version argument, no upgrades, no modifications to P5.2 history.
    async legacy(key) {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open("hdu-p51-single-write");
        req.onupgradeneeded = () => req.transaction.abort();
        req.onerror = req.onblocked = () => reject(new TestError("P52_RECEIPT_REQUIRED"));
        req.onsuccess = () => resolve(req.result);
      });
      try {
        check(db.objectStoreNames.contains("attempts"), "P52_RECEIPT_REQUIRED");
        return await new Promise((resolve, reject) => {
          const tx = db.transaction("attempts", "readonly"), req = tx.objectStore("attempts").get(key);
          req.onsuccess = () => resolve(req.result || null);
          tx.onerror = tx.onabort = () => reject(new TestError("STORAGE_UNAVAILABLE"));
        });
      } finally {
        db.close();
      }
    }
  }
  if (location.origin === ORIGIN && window.top === window.self && !document.getElementById("hdu-p53-host")) {
    const host = document.createElement("div");
    host.id = "hdu-p53-host";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
    :host{all:initial;position:fixed;right:10px;bottom:68px;z-index:2147483646;font:15px/1.5 system-ui,sans-serif;color:#17232b}
    *{box-sizing:border-box}button,input{font:inherit}button{min-height:44px;border:1px solid #9aabb4;border-radius:9px;padding:9px;background:#f7fafc;color:#17232b;touch-action:manipulation}button:disabled{opacity:.55}
    #toggle{background:#174e68;color:white;float:right}#panel{clear:both;background:white;border:1px solid #9aabb4;border-radius:12px;padding:12px;width:min(360px,calc(100vw - 20px));max-height:74vh;overflow:auto;box-shadow:0 3px 18px #0003}
    [hidden]{display:none!important}h2{font-size:18px;margin:0 0 8px}p{margin:8px 0}small{display:block;color:#465c69}label{display:flex;gap:8px;padding:8px 0}input{width:22px;height:22px;flex-shrink:0}#actions{display:grid;grid-template-columns:1fr;gap:8px}#prepare{background:#174e68;color:#fff}#state{font-weight:700;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 monospace}summary{min-height:44px;padding:10px 0}a{color:#174e68}
  </style>
  <button id="toggle" aria-expanded="false">P5.3 · 162</button>
  <section id="panel" hidden aria-label="P5.3 单座预约">
    <h2>P5.3 · 仅 162，一次提交</h2>
    <p>宋韵云图（四楼）<br>2026-11-19 · 08:00–22:00<br>14 小时 / 50400 秒 / 1 人</p>
    <p id="clock"></p><small>开放时点：11 月 17 日 20:00（北京时间）。秒级校时会保守延后，不保证准点。</small>
    <p id="checks">登录：未检查 · 座位 ID：未验证</p>
    <p id="state" role="status">未启动 · 默认只读演练</p>
    <p id="explain"></p>
    <label><input id="arm" type="checkbox">我确认馆方允许此方式及上述日期、时段和座位，启用 11 月 17 日正式任务（仅一次）</label>
    <small>未勾选＝只读演练。正式准备限 19:58–20:00 前；准备后勿更换账号、手动预约或在其他设备操作同一账号。</small>
    <div id="actions"><button id="prepare">准备抢座</button><button id="stop">停止自动任务</button><button id="review">查看结果</button></div>
    <p>保持浏览器前台、屏幕唤醒和网络正常。切到后台即停止；刷新不会恢复提交。请先关闭 P5.2 的悬浮面板，保留其脚本和数据。</p>
    <details><summary>运行日志（脱敏）</summary><pre id="logs"></pre></details>
    <a href="https://hdu.huitu.zhishulib.com/#!/Seat/Index/myBookingList" target="_blank" rel="noopener noreferrer">官方我的预约</a>
  </section>`;
    document.documentElement.append(host);
    const el = (id) => root.getElementById(id);
    const states = {
      IDLE: "未启动",
      PREPARING: "只读检查中",
      READY_READ_ONLY: "只读演练通过 · 未启用提交",
      WAITING: "已授权待命 · 等待 20:00",
      SUCCESS: "SUCCESS — 162号预约成功",
      FAILED: "FAILED — 自动任务已结束",
      UNKNOWN: "UNKNOWN — 预约结果待确认",
      STOPPED: "已停止 · 不会发起新的写入"
    };
    const reasons = {
      SUBMITTING_ONCE: "首次请求已开始，等待响应。没有自动重试。",
      SERVER_SUCCESS: "服务器表示成功，正在核验官方记录。",
      RECORD_VERIFIED: "官方记录已核对日期、08:00–22:00、14 小时、四楼 162 及有效状态。",
      SEAT_UNAVAILABLE: "馆方明确拒绝：座位不可预约。没有备用座位任务。",
      NOT_OPEN: "馆方明确拒绝：时间范围未开放。不会重发。",
      EXISTING: "目标时段已有预约或馆方拒绝重复预约。",
      LIMITED: "馆方限流或拒绝访问，已停止后续自动请求。",
      AUTH_REQUIRED: "登录已失效，请在官网重新认证；本任务不会自动恢复。",
      P52_RECEIPT_REQUIRED: "需要本浏览器、同账号的 P5.2 成功核验记录。请用 P5.2 查看结果；不要清除数据或换账号。",
      HISTORY_MAPPING_MISMATCH: "P5.2 历史映射不匹配，请保留日志。禁止提交。",
      TASK_ALREADY_RESERVED: "已存在正式任务。刷新或再次点击不会创建第二次提交；可查看结果或停止任务。",
      PREPARE_WINDOW: "正式准备仅限 2026-11-17 北京时间 19:58–20:00 前。现在可取消勾选做只读演练。",
      MISSED_WINDOW: "已超出保守的整点执行窗口（最多 10 秒），停止写入，请手动接管。",
      USER_STOPPED: "已停止。若请求已发出，停止不能撤销服务器处理，请查官方记录。",
      FOREGROUND_REQUIRED: "网页离开前台，任务已停止，不会自动恢复。",
      REHEARSAL_PASSED: "登录、合法日期、历史映射、14 小时时段、冲突检查和本地持久化通过；没有预约写入。",
      ARMED_FOR_2000: "只提交四楼 162 一次。请保持前台，勿切换账号。",
      HTTP_404: "接口返回 404，不能判断是否落单。不会重发。",
      TIMEOUT: "请求超时，服务器可能已受理。不会重发。",
      NETWORK_ERROR: "网络错误，结果不明确。不会重发。",
      READ_CHECK_LIMIT_OR_ERROR: "只读核验受限或失败；最多自动一次、手动两次。请转官方我的预约查看。",
      RECORD_NOT_VERIFIED: "官方记录尚不能证明完整目标成功。不会重发。",
      CLOCK_UNVERIFIED: "馆方时间不可验证或偏差过大，禁止提交。请保持手机自动校时。",
      CLOCK_CHANGED_OR_STALE: "校时样本过期、手机时间变化或页面暂停，已停止。"
    };
    const store = new FormalStore();
    const render = (view) => {
      el("state").textContent = states[view.state] || view.state;
      el("explain").textContent = reasons[view.reason] || `状态代码：${view.reason}。没有自动重试。`;
      el("checks").textContent = `登录：${view.login ? "有效（准备时）" : "未检查"} · 座位 ID：${view.mapping ? "162 → 62726 / 房间 1558 已验证" : "未验证"}`;
      el("logs").textContent = JSON.stringify({ timings: view.timings, events: view.logs }, null, 2);
      el("prepare").disabled = view.formal || view.state === "PREPARING";
      el("arm").disabled = view.formal || view.state === "PREPARING";
    };
    const engine = new SingleEngine(new Transport(), store, render);
    const action = (fn) => async (event) => {
      if (!event.isTrusted) return;
      try {
        await fn();
      } catch (error) {
        engine.emit("STOPPED", codeOf(error));
      }
    };
    el("toggle").onclick = () => {
      el("panel").hidden = !el("panel").hidden;
      el("toggle").setAttribute("aria-expanded", String(!el("panel").hidden));
    };
    el("prepare").onclick = action(
      () => engine.prepare({ arm: el("arm").checked, confirmed: el("arm").checked })
    );
    el("stop").onclick = action(() => engine.stop());
    el("review").onclick = action(() => engine.review());
    const suspend = () => {
      if (engine.formal) void engine.stop("FOREGROUND_REQUIRED");
    };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") suspend();
    });
    document.addEventListener("freeze", suspend);
    window.addEventListener("pagehide", suspend);
    window.addEventListener("storage", () => {
      if (engine.formal && store.stopped()) void engine.stop();
    });
    const fmt = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    });
    const loop = () => {
      const remaining = Math.ceil((TASK.open - Date.now()) / 1e3);
      el("clock").textContent = `北京时间 ${fmt.format(Date.now())} · ${remaining > 0 ? `距开放 ${remaining} 秒` : "已到开放时点（仍须通过安全门禁）"}`;
      void engine.tick();
      setTimeout(loop, engine.waiting && remaining <= 2 ? 50 : 250);
    };
    loop();
  }
})();
