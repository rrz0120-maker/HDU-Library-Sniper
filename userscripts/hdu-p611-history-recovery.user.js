// ==UserScript==
// @name         杭电图书馆 P6.1 Lite 每日162
// @namespace    https://github.com/rrz0120-maker/HDU-Library-Sniper/p61
// @version      6.1.1
// @description  默认只读；每日明确授权，20:00且馆方日期核验后最多一次预约后天四楼162 08:00–22:00；实时悬浮反馈，不重试不换座。
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
    async request(path, { form, token, write = false, signal, onHeaders, onDispatch, onBusiness } = {}) {
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
          status: response.status,
          timing: { ...timing },
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
        timing.businessResultAt = (/* @__PURE__ */ new Date()).toISOString();
        onBusiness?.(body, timing);
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
  function taskKey(account, task = TASK) {
    return `${account}:${task.date}:08:00-22:00`;
  }
  function checkSchedule(task = TASK) {
    check(shanghaiDate(task.open + 2 * 864e5) === task.date, "DATE_RULE_MISMATCH");
    check(task.begin + task.duration === Date.parse(`${task.date}T22:00:00+08:00`) / 1e3, "INVALID_DURATION");
  }
  function targetRange(raw, now, task = TASK) {
    const range = parseRange(raw);
    check(
      range.min <= 8 && range.max >= 22 && integer(raw.min_duration) <= 14 && integer(raw.max_duration) >= 14,
      "FOURTEEN_HOURS_NOT_ALLOWED"
    );
    check(range.dates.includes(task.date) || range.maxDateExclusive === task.date, "DATE_RULE_MISMATCH");
    check(rangeMidnight(raw.advance_date) <= task.begin * 1e3, "DATE_RULE_MISMATCH");
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
  function overlaps(items, task = TASK) {
    return items.filter((r) => {
      const status = String(r.status);
      if (["3", "4", "5", "6", "7", "9"].includes(status)) return false;
      check(["0", "1", "2"].includes(status), "RECORDS_UNKNOWN");
      const begin = integer(r.time), duration = integer(r.duration);
      check(
        begin > 0 && duration > 0 && duration <= 86400 && Number.isSafeInteger(begin + duration),
        "RECORDS_UNKNOWN"
      );
      return begin < task.begin + task.duration && begin + duration > task.begin;
    });
  }
  function verified162(items, mapping, task = TASK) {
    return overlaps(items, task).some(
      (r) => integer(r.time) === task.begin && integer(r.duration) === task.duration && String(r.seatNum).trim() === task.seat && r.roomName === mapping.room && (r.seatId === void 0 || String(r.seatId) === task.seatId)
    );
  }
  class ReleaseClock {
    constructor(wall = () => Date.now(), mono = () => performance.now(), task = TASK) {
      this.task = task;
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
      return this.wall() >= this.task.open && this.bounds().lower >= this.task.open;
    }
    deadline() {
      check(
        this.wall() <= this.task.open + LATE_MS && this.bounds().upper <= this.task.open + LATE_MS,
        "MISSED_WINDOW"
      );
    }
  }
  const REJECTED = /* @__PURE__ */ new Set(["SEAT_UNAVAILABLE", "NOT_OPEN", "EXISTING"]);
  class SingleEngine {
    constructor(io, store, notify = () => {
    }, env = {}) {
      this.task = env.task || TASK;
      this.io = io;
      this.store = store;
      this.notify = notify;
      this.wall = env.wall || (() => Date.now());
      this.mono = env.mono || (() => performance.now());
      this.visible = env.visible || (() => document.visibilityState === "visible");
      this.clock = new ReleaseClock(this.wall, this.mono, this.task);
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
      this.key = taskKey(account, this.task);
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
        checkSchedule(this.task);
        check(this.visible(), "FOREGROUND_REQUIRED");
        if (arm) {
          check(confirmed, "CONFIRMATION_REQUIRED");
          check(this.wall() >= this.task.open - PREPARE_MS && this.wall() < this.task.open, "PREPARE_WINDOW");
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
        this.range = targetRange(raw, this.wall(), this.task);
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
        check(overlaps(records(await this.read(RECORD_PATH, g)), this.task).length === 0, "EXISTING");
        this.timings.conflictReadMs = this.mono() - readAt;
        this.clock.bounds();
        const sample = signedRequest(
          this.task.seatId,
          this.identity.uid,
          this.task.begin,
          Math.floor(this.wall() / 1e3),
          this.task.duration
        );
        check(sample.form.get("duration") === "50400", "INVALID_DURATION");
        this.ensure(g);
        check(this.visible(), "FOREGROUND_REQUIRED");
        this.preparedAt = this.mono();
        if (!arm) {
          this.emit("READY_READ_ONLY", "REHEARSAL_PASSED");
          return this.view();
        }
        check(this.wall() < this.task.open && !this.store.stopped(), "PREPARE_TOO_LATE_OR_STOPPED");
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
          target: { ...this.task },
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
          this.task.seatId,
          this.identity.uid,
          this.task.begin,
          Math.floor(this.wall() / 1e3),
          this.task.duration
        );
        this.timings.preSubmitLocalMs = this.mono() - localStart;
        this.emit("UNKNOWN", "SUBMITTING_ONCE");
        const response = await this.io.request(BOOK_PATH, {
          ...request,
          write: true,
          onHeaders: (sample) => this.submissionHeaders?.(sample),
          onBusiness: (body, timing) => this.submissionBusiness?.(body, timing),
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
        return verified162(items, this.mapping, this.task);
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
  const VERSION = "6.1.1";
  function dailyTask(now = Date.now()) {
    check(Number.isSafeInteger(now), "INVALID_TIME");
    const day = shanghaiDate(now), midnight2 = rangeMidnight(day);
    const date = shanghaiDate(midnight2 + 2 * 864e5), target = rangeMidnight(date);
    return Object.freeze({
      ...TASK,
      day,
      date,
      open: midnight2 + 20 * 36e5,
      begin: target / 1e3 + 8 * 3600,
      end: target / 1e3 + 22 * 3600
    });
  }
  function validateDailyTask(task) {
    const canonical = dailyTask(task.open);
    for (const key of Object.keys(canonical)) check(task[key] === canonical[key], "TASK_INVALID");
  }
  function suffix(task) {
    return `${task.date}:08:00-22:00`;
  }
  function isP53Slot(task) {
    return task.begin === TASK.begin && task.duration === TASK.duration;
  }
  function pending(row) {
    return row?.attempts === 1 && !["SUCCESS", "FAILED"].includes(row.state);
  }
  function openingRange(raw, task) {
    const range = parseRange(raw);
    check(
      range.min <= 8 && range.max >= 22 && integer(raw.min_duration) <= 14 && integer(raw.max_duration) >= 14,
      "FOURTEEN_HOURS_NOT_ALLOWED"
    );
    const open = range.dates.includes(task.date);
    check(open || range.maxDateExclusive === task.date, "DATE_RULE_MISMATCH");
    return { open, maxDateExclusive: range.maxDateExclusive };
  }
  function canReconcileNotOpen(row) {
    if (row?.state !== "UNKNOWN" || row.reason !== "USER_STOPPED" || row.attempts !== 1) return false;
    const get = (k) => row[k] ?? row.timings?.[k];
    const d = Date.parse(get("firstDispatchAt")), b = Date.parse(get("firstBusinessResultAt"));
    const f = Date.parse(get("uiFeedback")?.FAILED?.stateUpdatedAt);
    return get("responseCode") === "NOT_OPEN" && row.recordVerified === false && !get("firstServerSuccessAt") && !get("firstRecordVerifiedAt") && Number.isFinite(d) && Number.isFinite(b) && Number.isFinite(f) && d <= b && b <= f;
  }
  const FIRST_FIELDS = [
    "prepareStartedAt",
    "armedAt",
    "scheduledAt",
    "firstGatePassedAt",
    "gateClockLowerMs",
    "gateClockUpperMs",
    "gateClockPhoneOffsetMs",
    "gateClockSampleRttMs",
    "openingCheckStartedAt",
    "openConfirmedAt",
    "confirmedMaxDateExclusive",
    "firstDispatchAt",
    "firstResponseAt",
    "firstBusinessResultAt",
    "firstServerSuccessAt",
    "firstRecordVerifiedAt",
    "responseCode",
    "loginCheckMs",
    "catalogReadMs",
    "idResolutionMs",
    "conflictReadMs",
    "preSubmitLocalMs",
    "dispatchToHeadersMs",
    "bodyDecodeMs",
    "totalRequestMs",
    "verificationMs",
    "resultStateUpdatedAt"
  ];
  function mergeDiagnostics(old, incoming = {}) {
    const merged = { ...old };
    for (const field of FIRST_FIELDS)
      if (merged[field] == null && incoming[field] != null) merged[field] = incoming[field];
    if (incoming.lastReviewedAt && (!old.lastReviewedAt || incoming.lastReviewedAt > old.lastReviewedAt))
      merged.lastReviewedAt = incoming.lastReviewedAt;
    const feedback = { ...old.uiFeedback };
    for (const [state, detail] of Object.entries(incoming.uiFeedback || {})) {
      feedback[state] = { ...detail, ...feedback[state] };
    }
    merged.uiFeedback = feedback;
    return merged;
  }
  function publicDiagnostics(row) {
    if (!row) return null;
    const fields = Object.fromEntries(FIRST_FIELDS.map((key) => [key, row[key] ?? row.timings?.[key] ?? null]));
    return {
      version: row.version || "6.0.0",
      taskDay: row.target?.day,
      date: row.target?.date,
      seat: "162",
      room: "宋韵云图（四楼）",
      begin: "08:00",
      end: "22:00",
      duration: 50400,
      state: row.state,
      reason: row.reason,
      attempts: row.attempts ?? 0,
      verifications: row.verifications ?? 0,
      lastVerification: row.lastVerification ?? null,
      historyRecoveryChecks: row.historyRecoveryChecks ?? 0,
      lastHistoryRecoveryVerification: row.lastHistoryRecoveryVerification ?? null,
      verificationBlockReason: row.verificationBlockReason ?? null,
      verificationResult: row.verificationResult ?? null,
      verificationErrorCode: row.verificationErrorCode ?? null,
      recordVerified: row.recordVerified === true,
      ...fields,
      lastReviewedAt: row.lastReviewedAt || null,
      reconciledAt: row.reconciledAt || null,
      uiFeedback: cleanUI(row.uiFeedback),
      events: (row.logs || []).slice(-60).map((e) => ({ at: e.at, category: e.category, state: e.state, code: e.reason })),
      timingMeaning: "fetch调用/响应头/业务解析/记录核验均为客户端事件；DOM和rAF不是用户实际看到的时刻；不分离网络与服务端耗时"
    };
  }
  function cleanUI(feedback = {}) {
    return Object.fromEntries(
      Object.entries(feedback).map(([state, value]) => [
        state,
        Object.fromEntries(
          ["stateUpdatedAt", "domUpdatedAt", "domUpdateMs", "renderOpportunityAt", "renderOpportunityDelayMs"].filter((k) => value[k] !== void 0).map((k) => [k, value[k]])
        )
      ])
    );
  }
  const RESULTS = /* @__PURE__ */ new Set([
    "SERVER_SUCCESS",
    "SEAT_UNAVAILABLE",
    "NOT_OPEN",
    "EXISTING",
    "LIMITED",
    "AUTH_REQUIRED",
    "HTTP_404",
    "TIMEOUT",
    "NETWORK_ERROR",
    "RESPONSE_UNKNOWN"
  ]);
  class DailyEngine extends SingleEngine {
    constructor(io, store, notify, env = {}) {
      super(io, store, notify, { ...env, task: env.task || dailyTask((env.wall || Date.now)()) });
      validateDailyTask(this.task);
      this.canWrite = env.canWrite !== false;
      this.timings.scheduledAt = new Date(this.task.open).toISOString();
      this.diagWrites = Promise.resolve();
    }
    iso() {
      return new Date(this.wall()).toISOString();
    }
    ensure(g) {
      super.ensure(g);
      if (this.formal && !this.reviewing)
        check(shanghaiDate(this.wall()) === this.task.day, "AUTHORIZATION_EXPIRED");
    }
    mark(values) {
      this.timings = mergeDiagnostics(this.timings, values);
    }
    persistDiagnostics() {
      if (!this.key) return;
      const key = this.key, values = structuredClone(this.timings), logs = this.logs.slice();
      this.diagWrites = this.diagWrites.then(() => this.store.note(key, values, logs)).catch(() => {
        this.diagnosticStorageFailed = true;
      });
    }
    emit(state, reason, details = {}) {
      if (this.reviewing && ["READ_CHECK_LIMIT_OR_ERROR", "RECORD_NOT_VERIFIED"].includes(reason))
        reason = this.verificationOutcome || reason;
      if (state === "WAITING" && !this.waiting) {
        state = "IDLE";
        reason = "WAITING_VIEW_ONLY";
      }
      if (reason === "SUBMITTING_ONCE") state = "SUBMITTING";
      if (reason === "SERVER_SUCCESS" && state !== "SUCCESS") state = "VERIFYING";
      if (["SEAT_UNAVAILABLE", "NOT_OPEN", "EXISTING"].includes(reason) && this.attempted && state === "UNKNOWN")
        state = "VERIFYING";
      if (["MISSED_WINDOW", "PREPARE_WINDOW", "AUTHORIZATION_EXPIRED", "PREPARE_TOO_LATE_OR_STOPPED"].includes(
        reason
      ) && !this.attempted)
        state = "EXPIRED";
      if (reason === "FORMAL_PREFLIGHT" || reason === "READ_ONLY_REHEARSAL")
        this.mark({ prepareStartedAt: this.iso() });
      if (reason === "ARMED_FOR_2000") this.mark({ armedAt: this.iso() });
      const http = this.timings.http;
      if (http)
        this.mark({
          dispatchToHeadersMs: http.dispatchToHeadersMs,
          bodyDecodeMs: http.bodyDecodeMs,
          totalRequestMs: http.totalRequestMs
        });
      if (this.attempted && RESULTS.has(reason))
        this.mark({ responseCode: reason, resultStateUpdatedAt: this.iso() });
      if (this.reviewing && reason === "RECORD_VERIFIED" && !this.verifiedDuringReview)
        reason = "REVIEW_SAVED_RESULT";
      if (this.state === state && this.reason === reason && !["LOGIN_OK", "RANGE_OK"].includes(reason)) return;
      this.state = state;
      this.reason = reason;
      const category2 = this.verifying ? "RECORD_VERIFICATION" : this.reviewing ? "REVIEW" : reason === "HTTP_HEADERS" ? "BOOKING_HTTP" : ["HTTP_404", "TIMEOUT", "NETWORK_ERROR", "HTTP_ERROR", "STOPPED"].includes(reason) && this.attempted ? "BOOKING_REQUEST_ERROR" : RESULTS.has(reason) && this.attempted ? "BOOKING_BUSINESS_RESULT" : reason === "RECORD_VERIFIED" ? "RECORD_VERIFICATION" : ["UI_REATTACHED", "PAGE_CONTEXT_END", "PAGE_ERROR_OBSERVED"].includes(reason) ? "PAGE_OBSERVATION" : state === "PREPARING" || !this.attempted && !this.waiting ? "QUERY_OR_PREPARATION" : "TASK";
      this.logs.push({ at: this.iso(), category: category2, state, reason, ...details });
      if (this.logs.length > 60) this.logs.shift();
      this.notify(this.view());
      this.persistDiagnostics();
    }
    view() {
      return {
        ...super.view(),
        task: this.task,
        attempts: this.attempted ? 1 : 0,
        diagnosticStorageFailed: !!this.diagnosticStorageFailed
      };
    }
    async login(g, observe = true) {
      await super.login(g, observe);
      this.store.bind(this.identity.account);
    }
    async read(path, g, form, observe = true) {
      try {
        const body = await super.read(path, g, form, observe);
        if (this.state === "PREPARING" && !form && path.startsWith("/Seat/Index/searchSeats?") && body?.data?.range) {
          this.openRangePath = path;
          this.openRangeCategory = category(body.data);
        }
        return body;
      } catch (e) {
        this.logs.push({
          at: this.iso(),
          category: path === RECORD_PATH ? "RECORD_QUERY_ERROR" : "QUERY_REQUEST_ERROR",
          state: this.state,
          reason: codeOf(e)
        });
        this.persistDiagnostics();
        throw e;
      }
    }
    async prepare({ arm = false, confirmed = false, authorizedDay } = {}) {
      if (this.busy || this.formal) return this.view();
      if (arm && (!this.canWrite || !confirmed || authorizedDay !== this.task.day || shanghaiDate(this.wall()) !== this.task.day)) {
        this.emit("STOPPED", "TODAY_AUTHORIZATION_REQUIRED");
        return this.view();
      }
      if (arm && isP53Slot(this.task)) {
        this.emit("STOPPED", "P53_SLOT_FROZEN");
        return this.view();
      }
      if (arm && this.wall() < this.task.open - PREPARE_MS) {
        this.emit("IDLE", "PREPARE_TOO_EARLY");
        return this.view();
      }
      this.timings = { scheduledAt: new Date(this.task.open).toISOString() };
      this.openRangePath = void 0;
      this.openRangeCategory = void 0;
      this.openProofGeneration = void 0;
      this.openingChecks = 0;
      this.nextOpeningCheckMono = 0;
      if (arm && this.wall() >= this.task.open - PREPARE_MS && this.wall() < this.task.open)
        this.store.activateDay?.();
      return super.prepare({ arm, confirmed });
    }
    async tick() {
      if (!this.waiting || this.busy) return;
      const g = this.generation;
      try {
        check(!this.store.stopped(), "USER_STOPPED");
        check(this.visible(), "FOREGROUND_REQUIRED");
        this.clock.deadline();
        if (!this.clock.released()) return;
        const bounds = this.clock.bounds();
        this.mark({
          firstGatePassedAt: this.iso(),
          gateClockLowerMs: bounds.lower,
          gateClockUpperMs: bounds.upper,
          gateClockPhoneOffsetMs: bounds.phoneOffsetMs,
          gateClockSampleRttMs: bounds.sampleRttMs
        });
        if (this.mono() < this.nextOpeningCheckMono) return;
        check(this.openRangePath && this.openRangeCategory && this.openingChecks < 2, "OPEN_RANGE_UNCONFIRMED");
        this.busy = true;
        this.openingChecks++;
        this.mark({ openingCheckStartedAt: this.iso() });
        this.emit("WAITING", "OPEN_RANGE_CHECKING");
        const body = await this.read(this.openRangePath, g, void 0, false);
        this.ensure(g);
        const group = category(body?.data);
        check(
          group.category_id === this.openRangeCategory.category_id && group.content_id === this.openRangeCategory.content_id,
          "OPEN_RANGE_UNCONFIRMED"
        );
        const result = openingRange(body?.data?.range, this.task);
        check(!this.store.stopped() && this.visible(), "FOREGROUND_REQUIRED");
        this.clock.deadline();
        check(this.clock.released(), "NOT_RELEASED");
        if (!result.open) {
          check(this.openingChecks < 2, "OPEN_RANGE_UNCONFIRMED");
          this.nextOpeningCheckMono = this.mono() + 1e3;
          this.emit("WAITING", "OPEN_RANGE_NOT_YET");
          return;
        }
        this.openProofGeneration = g;
        this.mark({ openConfirmedAt: this.iso(), confirmedMaxDateExclusive: result.maxDateExclusive });
        this.emit("WAITING", "OPEN_RANGE_CONFIRMED");
        this.busy = false;
        await this.submit();
      } catch (error) {
        if (g === this.generation) await this.stop(codeOf(error));
      } finally {
        this.busy = false;
      }
    }
    submissionHeaders(sample) {
      this.mark({
        firstResponseAt: sample.timing?.responseAt || new Date(sample.receivedWall).toISOString(),
        dispatchToHeadersMs: sample.timing?.dispatchToHeadersMs
      });
      this.emit("SUBMITTING", "HTTP_HEADERS", { status: sample.status });
    }
    submissionBusiness(body, timing) {
      const reason = responseCode(body), at = timing.businessResultAt || this.iso();
      this.mark({
        firstBusinessResultAt: at,
        firstServerSuccessAt: reason === "SERVER_SUCCESS" ? at : void 0,
        responseCode: reason,
        bodyDecodeMs: timing.bodyDecodeMs,
        dispatchToHeadersMs: timing.dispatchToHeadersMs
      });
      this.emit(["LIMITED", "AUTH_REQUIRED"].includes(reason) ? "FAILED" : "UNKNOWN", reason);
    }
    async submit() {
      check(
        this.openProofGeneration === this.generation && this.timings.openConfirmedAt,
        "OPEN_RANGE_UNCONFIRMED"
      );
      const original = this.io;
      this.io = {
        request: (path, options = {}) => original.request(
          path,
          options.write ? {
            ...options,
            onDispatch: (at) => {
              check(this.openProofGeneration === this.generation, "OPEN_RANGE_UNCONFIRMED");
              options.onDispatch?.(at);
              this.mark({ firstDispatchAt: at });
              this.persistDiagnostics();
            }
          } : options
        )
      };
      try {
        await super.submit();
      } finally {
        this.io = original;
      }
      if (this.state === "VERIFYING") this.emit("UNKNOWN", "RECORD_NOT_VERIFIED");
    }
    async verify(g) {
      const historical = this.reviewing && this.task.day < shanghaiDate(this.wall());
      const grant = await this.store.takeVerification(this.key, this.wall(), historical);
      if (grant.reason) {
        this.verificationOutcome = grant.reason;
        return null;
      }
      const start = this.mono();
      this.verifying = true;
      let result = null, errorCode = null;
      try {
        const body = await this.read(RECORD_PATH, g, void 0, false);
        check(body?.CODE === void 0 || body.CODE === "ok", "RECORDS_UNKNOWN");
        const items = records(body);
        result = verified162(items, this.mapping, this.task);
        this.verificationOutcome = result ? "VERIFICATION_RECORD_MATCHED" : overlaps(items, this.task).length ? "VERIFICATION_RECORD_CONFLICT" : "VERIFICATION_RECORD_ABSENT";
        if (result) {
          this.mark({ firstRecordVerifiedAt: this.iso() });
          if (this.reviewing) this.verifiedDuringReview = true;
        }
      } catch (error) {
        errorCode = codeOf(error);
        this.verificationOutcome = "VERIFICATION_READ_ERROR";
      } finally {
        this.timings.verificationMs = this.mono() - start;
        this.verifying = false;
      }
      await this.store.verificationFinished(this.key, grant, this.verificationOutcome, errorCode);
      if (this.reviewing && g === this.generation && this.verificationOutcome === "VERIFICATION_RECORD_ABSENT")
        this.absenceProof = grant;
      return result;
    }
    async review() {
      if (this.busy || this.waiting) return this.view();
      this.reviewing = true;
      this.verifiedDuringReview = false;
      this.absenceProof = null;
      this.verificationOutcome = null;
      const at = this.iso();
      try {
        await super.review();
        if (this.key && this.absenceProof) {
          this.busy = true;
          try {
            const row = await this.store.reconcileNotOpen(this.key, this.iso(), this.absenceProof);
            if (row?.state === "FAILED") this.emit("FAILED", row.reason);
          } finally {
            this.busy = false;
          }
        }
      } finally {
        this.reviewing = false;
        this.timings.lastReviewedAt = at;
        if (this.key)
          await this.store.note(this.key, { lastReviewedAt: at }, this.logs).catch(() => {
            this.diagnosticStorageFailed = true;
          });
        this.notify(this.view());
      }
      return this.view();
    }
    recordUI(phase, metrics) {
      this.mark({ uiFeedback: { [phase]: metrics } });
      this.persistDiagnostics();
    }
    observePage(code) {
      this.logs.push({ at: this.iso(), category: "PAGE_OBSERVATION", state: this.state, reason: code });
      if (this.logs.length > 60) this.logs.shift();
      this.persistDiagnostics();
    }
    async diagnosticExport() {
      await this.diagWrites;
      let rows = [];
      if (this.identity) rows = await this.store.list();
      const stored = rows.find((r) => r.key === this.key);
      return {
        version: VERSION,
        current: publicDiagnostics(
          stored || {
            target: this.task,
            version: VERSION,
            state: this.state,
            reason: this.reason,
            attempts: this.attempted ? 1 : 0,
            ...this.timings,
            logs: this.logs
          }
        ),
        recent: rows.sort((a, b) => b.target.date.localeCompare(a.target.date)).slice(0, 7).map(publicDiagnostics),
        diagnosticStorageFailed: !!this.diagnosticStorageFailed
      };
    }
    async suspend(code = "FOREGROUND_REQUIRED") {
      try {
        await this.stop(code);
      } catch (e) {
        this.emit(this.attempted ? "UNKNOWN" : "STOPPED", codeOf(e));
      }
    }
    async stop(reason = "USER_STOPPED") {
      this.generation++;
      this.waiting = false;
      this.controller?.abort();
      let row;
      try {
        if (this.formal || this.store.active()) {
          this.store.stopSignal();
          row = this.key ? await this.store.stop(this.key, reason) : await this.store.activeTask?.();
          this.attempted ||= row?.attempts === 1;
        }
      } catch {
        reason = "STORAGE_UNAVAILABLE";
      }
      if (row && ["SUCCESS", "FAILED"].includes(row.state)) {
        this.emit(row.state, row.reason);
        return;
      }
      if (!["SUCCESS", "FAILED"].includes(this.state))
        this.emit(this.attempted ? "UNKNOWN" : "STOPPED", reason);
    }
  }
  const PREFIX = `hdu-p53:${TASK_SUFFIX}:`;
  class FormalStore {
    constructor({ database = "hdu-p53-formal-booking", prefix = PREFIX } = {}) {
      this.database = database;
      this.prefix = prefix;
    }
    async open() {
      if (this.db) return this.db;
      check(globalThis.indexedDB && globalThis.localStorage, "STORAGE_UNAVAILABLE");
      this.db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(this.database, 1);
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
      localStorage.setItem(`${this.prefix}probe`, value);
      check(localStorage.getItem(`${this.prefix}probe`) === value, "STORAGE_UNAVAILABLE");
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
      if (won) localStorage.setItem(`${this.prefix}active`, "1");
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
      if (won) localStorage.setItem(`${this.prefix}spent:${key}`, "1");
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
      return localStorage.getItem(`${this.prefix}active`) === "1";
    }
    spent(key) {
      return localStorage.getItem(`${this.prefix}spent:${key}`) === "1";
    }
    stopped() {
      return localStorage.getItem(`${this.prefix}stop`) === "1";
    }
    stopSignal() {
      localStorage.setItem(`${this.prefix}stop`, "1");
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
  async function oldRows(database, store) {
    let absent = false;
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(database);
      req.onupgradeneeded = () => {
        absent = true;
        req.transaction.abort();
      };
      req.onerror = () => absent ? resolve(null) : reject(new TestError("LEGACY_STORAGE_UNKNOWN"));
      req.onblocked = () => reject(new TestError("LEGACY_STORAGE_UNKNOWN"));
      req.onsuccess = () => resolve(req.result);
    });
    if (!db) return [];
    try {
      check(db.objectStoreNames.contains(store), "LEGACY_STORAGE_UNKNOWN");
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readonly"), req = tx.objectStore(store).getAll();
        req.onsuccess = () => resolve(req.result);
        tx.onerror = tx.onabort = () => reject(new TestError("LEGACY_STORAGE_UNKNOWN"));
      });
    } finally {
      db.close();
    }
  }
  class DailyStore extends FormalStore {
    constructor(task) {
      super({ database: "hdu-p60-daily-booking", prefix: `hdu-p60:probe:${suffix(task)}:` });
      this.task = task;
      this.control = `hdu-p60-control:${task.day}:`;
    }
    activateDay() {
      localStorage.setItem(`${this.control}active`, "1");
    }
    active() {
      return super.active() || localStorage.getItem(`${this.control}active`) === "1";
    }
    stopped() {
      return super.stopped() || localStorage.getItem(`${this.control}stop`) === "1";
    }
    stopSignal() {
      localStorage.setItem(`${this.control}stop`, "1");
      if (this.account) super.stopSignal();
    }
    async activeTask() {
      const key = localStorage.getItem(`${this.control}task`);
      return key ? this.get(key) : null;
    }
    bind(account) {
      this.account = account;
      this.prefix = `hdu-p60:${account}:${suffix(this.task)}:`;
    }
    async list() {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("tasks", "readonly"), req = tx.objectStore("tasks").getAll();
        req.onsuccess = () => resolve(req.result.filter((r) => r.key.startsWith(`${this.account}:`)));
        tx.onerror = tx.onabort = () => reject(new TestError("STORAGE_UNAVAILABLE"));
      });
    }
    async legacy(account) {
      this.bind(account);
      const p52 = await super.legacy(account);
      const p53 = (await oldRows("hdu-p53-formal-booking", "tasks")).filter(
        (r) => r.key.startsWith(`${account}:`)
      );
      const key = `${account}:${suffix(TASK)}`;
      const spent = localStorage.getItem(`hdu-p53:${suffix(TASK)}:spent:${key}`) === "1";
      check(!spent || p53.some((r) => r.key === key), "LEGACY_UNKNOWN");
      check(!p53.some(pending), "LEGACY_UNKNOWN");
      check(
        !(await this.list()).some((r) => pending(r) && r.key !== `${account}:${suffix(this.task)}`),
        "PREVIOUS_UNKNOWN"
      );
      return p52;
    }
    async reserve(row) {
      check(this.account && row.key.startsWith(`${this.account}:`), "IDENTITY_CHANGED");
      check(!isP53Slot(this.task), "P53_SLOT_FROZEN");
      const db = await this.open();
      return new Promise((resolve, reject) => {
        let won = false, value = null, failure;
        const tx = db.transaction("tasks", "readwrite", { durability: "strict" }), store = tx.objectStore("tasks");
        const req = store.getAll();
        req.onsuccess = () => {
          try {
            value = req.result.find((r) => r.key === row.key) || null;
            check(
              !req.result.some((r) => r.key.startsWith(`${this.account}:`) && r.key !== row.key && pending(r)),
              "PREVIOUS_UNKNOWN"
            );
            if (value || this.stopped() || this.spent(row.key)) return;
            won = true;
            value = mergeDiagnostics({ ...row, version: VERSION }, row.timings);
            store.put(value);
          } catch (e) {
            failure = e;
            tx.abort();
          }
        };
        tx.oncomplete = () => {
          try {
            if (won) {
              localStorage.setItem(`${this.prefix}active`, "1");
              localStorage.setItem(`${this.control}task`, row.key);
            }
            resolve({ won, value });
          } catch {
            reject(new TestError("STORAGE_UNAVAILABLE"));
          }
        };
        tx.onerror = tx.onabort = () => reject(failure || new TestError("STORAGE_UNAVAILABLE"));
      });
    }
    finish(key, owner, patch) {
      return this.transact(key, (old) => {
        if (!old || old.owner !== owner) return null;
        const terminal = old.state === "SUCCESS" || old.state === "FAILED" && !(patch.state === "SUCCESS" && patch.recordVerified === true);
        const next = terminal ? { ...old } : { ...old, ...patch };
        const d = mergeDiagnostics(old, { ...patch.timings, ...patch });
        for (const field of [...FIRST_FIELDS, "lastReviewedAt", "uiFeedback"])
          if (d[field] !== void 0) next[field] = d[field];
        next.timings = mergeDiagnostics(old.timings || {}, patch.timings || {});
        return next;
      });
    }
    stop(key, reason = "USER_STOPPED") {
      return this.transact(
        key,
        (old) => old && !["SUCCESS", "FAILED"].includes(old.state) ? { ...old, state: old.attempts ? "UNKNOWN" : "STOPPED", reason } : null
      );
    }
    async takeVerification(key, now, historical) {
      let grant;
      await this.transact(key, (old) => {
        const count = old?.verifications ?? 0;
        const recovery = historical && count >= 3 && canReconcileNotOpen(old);
        let reason;
        if (!old || old.state === "SUCCESS" || old.attempts !== 1) reason = "VERIFICATION_NOT_NEEDED";
        else if (count >= 3 && !recovery) reason = "VERIFICATION_BUDGET_EXHAUSTED";
        else if (recovery && (old.historyRecoveryChecks ?? 0) >= 1) reason = "HISTORY_RECOVERY_EXHAUSTED";
        else if (now - Math.max(old.lastVerification ?? 0, old.lastHistoryRecoveryVerification ?? 0) < 2e3)
          reason = "VERIFICATION_COOLDOWN";
        if (reason) {
          grant = { reason };
          return old && { ...old, verificationBlockReason: reason };
        }
        const stamp = recovery ? "lastHistoryRecoveryVerification" : "lastVerification";
        grant = { stamp, at: now };
        return {
          ...old,
          ...recovery ? { historyRecoveryChecks: 1 } : { verifications: count + 1 },
          [stamp]: now,
          verificationBlockReason: null,
          verificationResult: "VERIFICATION_PENDING",
          verificationErrorCode: null
        };
      });
      return grant;
    }
    verificationFinished(key, grant, result, errorCode) {
      return this.transact(
        key,
        (old) => old?.[grant.stamp] === grant.at && Math.max(old.lastVerification ?? 0, old.lastHistoryRecoveryVerification ?? 0) === grant.at ? { ...old, verificationResult: result, verificationErrorCode: errorCode } : null
      );
    }
    // Called only by an explicit review that just read the official records.
    reconcileNotOpen(key, at, grant) {
      check(this.account && key.startsWith(`${this.account}:`), "IDENTITY_CHANGED");
      return this.transact(
        key,
        (old) => canReconcileNotOpen(old) && old[grant.stamp] === grant.at && old.verificationResult === "VERIFICATION_RECORD_ABSENT" ? { ...old, state: "FAILED", reason: "NOT_OPEN", reconciledAt: at } : null
      );
    }
    note(key, diagnostics, logs) {
      return this.transact(
        key,
        (old) => old ? {
          ...mergeDiagnostics(old, diagnostics),
          timings: mergeDiagnostics(old.timings || {}, diagnostics),
          logs: logs?.slice(-60) || old.logs
        } : null
      );
    }
  }
  const PHASES = {
    IDLE: ["162 · 待启动", "idle"],
    PREPARING: ["正在检查", "active"],
    READY_READ_ONLY: ["只读检查通过", "active"],
    WAITING: ["162 · 待命", "active"],
    SUBMITTING: ["162 · 提交中", "active"],
    VERIFYING: ["162 · 正在核对", "active"],
    SUCCESS: ["162 · 已成功", "success"],
    FAILED: ["失败 · 手动接管", "failed"],
    UNKNOWN: ["结果待确认", "unknown"],
    STOPPED: ["已停止", "stopped"],
    EXPIRED: ["今日窗口已结束", "stopped"]
  };
  const MANUAL_STATES = ["FAILED", "STOPPED", "EXPIRED"];
  const REASONS = {
    WAITING_VIEW_ONLY: "这里只查看已保存的待命记录，本页不会恢复提交；若原标签页仍在运行，它可继续。停止任务可停止本浏览器今日任务。",
    PREPARE_TOO_EARLY: "未到19:58。可先取消勾选做只读检查；到时需再次点击启动，不会自动开始。",
    READ_ONLY_DEFAULT: "默认只读；每天需重新授权。",
    REHEARSAL_PASSED: "只读检查通过，没有提交预约。",
    ARMED_FOR_2000: "已正式待命。保持前台、屏幕唤醒和网络正常。",
    OPEN_RANGE_CHECKING: "正在核对馆方实际可约日期，尚未提交预约。",
    OPEN_RANGE_NOT_YET: "馆方尚未列出目标日期，将在安全窗口内至多再核对一次。",
    OPEN_RANGE_CONFIRMED: "馆方已列出目标日期，准备进行唯一一次正式预约。",
    OPEN_RANGE_UNCONFIRMED: "未能确认目标日期已开放，本次未提交预约。请查看官网。",
    HTTP_HEADERS: "HTTP响应已到达，正在解析业务结果。",
    SERVER_SUCCESS: "162 · 已受理，正在核验",
    RECORD_VERIFIED: "官方记录已核验：四楼162，08:00—22:00。",
    REVIEW_SAVED_RESULT: "显示已保存的官方核验结果；首次核验时间保持不变。",
    SEAT_UNAVAILABLE: "馆方拒绝：座位不可预约。需要核对记录后才能判定最终失败。",
    NOT_OPEN: "馆方拒绝：日期或时段未开放。不重发。",
    EXISTING: "已有预约或馆方拒绝重复预约。",
    LIMITED: "馆方限流或拒绝访问，自动请求已停止。",
    AUTH_REQUIRED: "登录已失效，请在官网正常认证。本任务不自动恢复。",
    P52_RECEIPT_REQUIRED: "缺少同浏览器、同账号的P5.2成功凭据。不要清除或伪造旧数据。",
    P53_SLOT_FROZEN: "P5.3固定时段已冻结，P6不会重新提交该任务。",
    LEGACY_UNKNOWN: "P5.3仍有未决提交，请核对旧版本与官方记录。禁止通过升级重新预约。",
    PREVIOUS_UNKNOWN: "还有往日未决提交。请在近期任务中查看结果；不能靠跨日解除保护。",
    USER_STOPPED: "已停止后续自动写入。停止不等于撤销预约。",
    FOREGROUND_REQUIRED: "页面离开前台，已停止；不会自动恢复。",
    RECORD_NOT_VERIFIED: "结果待确认，请检查官方预约。不重新提交。",
    VERIFICATION_BUDGET_EXHAUSTED: "普通核验额度已用完，请在官方我的预约中确认。",
    HISTORY_RECOVERY_EXHAUSTED: "本条历史任务的一次补充核验已使用，请在官方我的预约中确认。",
    VERIFICATION_COOLDOWN: "请间隔至少两秒再核验。",
    VERIFICATION_READ_ERROR: "官方记录读取失败。原有任务状态继续保留。",
    VERIFICATION_RECORD_CONFLICT: "官方存在重叠记录，结果仍需人工确认。",
    VERIFICATION_RECORD_ABSENT: "官方未发现匹配记录，原有任务保护继续保留。",
    HTTP_404: "预约或查询接口返回404。若已提交，结果待确认；不重发。",
    TIMEOUT: "请求超时，服务器可能已经处理，请核对官方预约。",
    NETWORK_ERROR: "网络异常，结果待确认，不重发。",
    TASK_ALREADY_RESERVED: "已存在该任务，仅恢复查看，不重新启动或提交。",
    NO_FORMAL_TASK: "尚无本日正式任务。",
    TODAY_AUTHORIZATION_REQUIRED: "请核对并重新授权当前北京时间日期的任务。",
    CLOCK_UNVERIFIED: "馆方时间样本无法验证，禁止提交。请检查手机自动校时。",
    CLOCK_CHANGED_OR_STALE: "校时样本过期或时间发生变化，已停止。",
    MISSED_WINDOW: "已错过安全执行窗口，不补发。",
    PREPARE_WINDOW: "正式准备仅限北京时间19:58至20:00前；其他时间可只读检查。"
  };
  function mountPanel(actions) {
    const host = document.createElement("div");
    host.id = "hdu-p60-host";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
    :host{all:initial;position:fixed;right:8px;bottom:12px;z-index:2147483647;font:14px/1.45 system-ui,sans-serif;color:#142d3c}
    *{box-sizing:border-box}[hidden]{display:none!important}button,input,select,textarea{font:inherit}button{min-height:44px;padding:8px 12px;border:1px solid #a5b7c1;border-radius:9px;background:#f8fafc;color:#142d3c;touch-action:manipulation}button:disabled{opacity:.55}
    #toggle{float:right;max-width:calc(100vw - 16px);background:#174e68;color:white;font-weight:600;font-size:14px}
    #toggle[data-tone=success]{background:#17633b}#toggle[data-tone=failed]{background:#a0212b}#toggle[data-tone=unknown]{background:#945008}#toggle[data-tone=stopped]{background:#59646b}
    #panel{clear:both;width:min(344px,calc(100vw - 16px));max-height:68vh;overflow:auto;background:#fff;border:1px solid #a5b7c1;border-radius:12px;padding:12px;margin-bottom:6px;box-shadow:0 3px 16px #0003;overflow-wrap:anywhere}
    h2{font-size:17px;margin:0 0 6px}p{margin:6px 0}small{display:block;color:#46606e}label{display:flex;gap:8px;margin:10px 0}input{width:22px;height:22px;flex-shrink:0}#actions{display:grid;grid-template-columns:1fr 1fr;gap:6px}#start{grid-column:span 2;background:#174e68;color:white}#state{font-weight:600}summary{padding:10px 0;min-height:44px}select,textarea{width:100%;min-height:44px}textarea{height:170px;white-space:pre-wrap;font:12px/1.4 monospace}a{color:#174e68}#recentLabel{display:block}#logStatus{font-size:12px}
  </style>
  <section id="panel" hidden aria-label="P6.1.1 Lite每日预约"><h2>P6.1.1 Lite · 四楼162</h2>
    <p id="target"></p><small>08:00—22:00 · 14小时 / 50400秒 / 1人</small>
    <p id="clock"></p><p id="state" role="status" aria-live="polite">未启动</p><small id="reason"></small>
    <label><input type="checkbox" id="authorize"><span id="authLabel"></span></label>
    <div id="actions"><button id="start">启动今日抢座</button><button id="stop">停止任务</button><button id="review">查看结果</button></div>
    <small>未勾选＝只读演练。保持前台和屏幕唤醒；收起面板不会停止任务。</small>
    <p><a href="${ORIGIN}/#!/Seat/Index/myBookingList" target="_blank" rel="noopener noreferrer">官方我的预约</a><span id="manualWrap" hidden> · <a id="manual" href="${ORIGIN}/#!/Space/Category/list">官网手动选座</a></span></p>
    <details id="diagnostics"><summary>诊断日志与近期任务</summary>
      <label id="recentLabel">查看范围<select id="recent"><option value="">今日任务</option></select></label>
      <button id="copy">复制脱敏日志</button><p id="logStatus"></p><textarea id="logText" readonly hidden aria-label="脱敏JSON日志"></textarea>
    </details>
  </section><button id="toggle" aria-expanded="false" data-tone="idle">162 · 待启动</button>`;
    const el = (id) => root.getElementById(id);
    let view, engine, displaySignature = "", authDay = "", frameRevision = 0, destroyed = false;
    const attach = () => {
      if (!destroyed && location.origin === ORIGIN && !host.isConnected) document.documentElement?.append(host);
    };
    attach();
    const observer = new MutationObserver(() => {
      if (host.isConnected || destroyed || location.origin !== ORIGIN) return;
      attach();
      actions.observe("UI_REATTACHED");
    });
    observer.observe(document, { childList: true, subtree: true });
    const trusted = (fn) => (event) => {
      if (event.isTrusted) void fn();
    };
    el("toggle").onclick = trusted(() => {
      el("panel").hidden = !el("panel").hidden;
      el("toggle").setAttribute("aria-expanded", String(!el("panel").hidden));
    });
    el("start").onclick = trusted(() => actions.start(el("authorize").checked, authDay));
    el("stop").onclick = trusted(() => actions.stop());
    el("review").onclick = trusted(() => actions.review(el("recent").value));
    el("manual").onclick = (event) => {
      if (!MANUAL_STATES.includes(view?.state)) {
        event.preventDefault();
        el("reason").textContent = "仅在明确失败后人工选座；结果未知时请先检查官方预约。";
      } else {
        el("panel").hidden = true;
        el("toggle").setAttribute("aria-expanded", "false");
      }
    };
    const showLogs = async (copy) => {
      try {
        const value = JSON.stringify(await actions.export(), null, 2);
        el("logText").value = value;
        if (copy && navigator.clipboard?.writeText) {
          try {
            await navigator.clipboard.writeText(value);
            el("logStatus").textContent = "脱敏日志已复制";
            return;
          } catch {
          }
        }
        el("logText").hidden = false;
        el("logText").focus();
        el("logText").select();
        el("logStatus").textContent = "请长按日志文本，全选并复制。";
      } catch {
        el("logStatus").textContent = "日志读取失败；不影响已保存的提交保护。";
      }
    };
    el("copy").onclick = trusted(() => showLogs(true));
    el("diagnostics").ontoggle = () => {
      if (el("diagnostics").open) void actions.recent();
    };
    return {
      root,
      host,
      newDay(task) {
        authDay = task.day;
        el("authorize").checked = false;
        el("authorize").disabled = false;
        el("recent").replaceChildren(new Option("今日任务", ""));
        el("authLabel").textContent = `我确认馆方规则及上述方案，授权 ${task.day} 今日最多一次提交。`;
      },
      recent(rows) {
        const previous = el("recent").value;
        el("recent").replaceChildren(
          new Option("今日任务", ""),
          ...rows.map((r) => new Option(`${r.target.date} · ${r.state}`, r.target.day))
        );
        if ([...el("recent").options].some((o) => o.value === previous)) el("recent").value = previous;
      },
      render(next, source) {
        view = next;
        engine = source;
        const historical = next.task.day !== authDay;
        el("authorize").disabled = historical || next.formal || next.state === "PREPARING";
        el("start").disabled = historical || next.formal || next.state === "PREPARING";
        if (historical) el("authorize").checked = false;
        el("target").textContent = `${next.task.day === authDay ? "今日" : "历史只读"}任务 ${next.task.day} → 预约 ${next.task.date}`;
        const phase = next.reason === "SERVER_SUCCESS" && next.state === "VERIFYING" ? "ACCEPTED" : next.state;
        const signature = `${next.task.day}:${phase}:${next.reason}`;
        if (signature === displaySignature) return;
        displaySignature = signature;
        const started = performance.now(), stateUpdatedAt = (/* @__PURE__ */ new Date()).toISOString();
        const [label, tone] = PHASES[next.state] || PHASES.UNKNOWN;
        const text = next.reason === "WAITING_VIEW_ONLY" ? "待命记录 · 仅查看" : phase === "ACCEPTED" ? "162 · 已受理，正在核验" : label;
        el("toggle").textContent = next.task.day === authDay ? text : `${next.task.date.slice(5)} · ${label}`;
        el("toggle").dataset.tone = tone;
        el("state").textContent = text;
        el("reason").textContent = REASONS[next.reason] || `状态代码：${next.reason}。不会重发预约。`;
        el("manualWrap").hidden = !MANUAL_STATES.includes(next.state);
        const domEnd = performance.now(), domUpdatedAt = (/* @__PURE__ */ new Date()).toISOString();
        source.recordUI(phase, { stateUpdatedAt, domUpdatedAt, domUpdateMs: domEnd - started });
        const revision = ++frameRevision;
        requestAnimationFrame(() => {
          if (revision !== frameRevision || engine !== source || document.visibilityState !== "visible") return;
          source.recordUI(phase, {
            renderOpportunityAt: (/* @__PURE__ */ new Date()).toISOString(),
            renderOpportunityDelayMs: performance.now() - domEnd
          });
        });
      },
      clock(task, now) {
        const remaining = Math.max(0, Math.ceil((task.open - now) / 1e3));
        const countdown = `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`;
        const text = `北京时间20:00 · ${remaining ? `剩余 ${countdown}` : "已到开放时点"}`;
        if (el("clock").textContent !== text) el("clock").textContent = text;
        if (remaining > 0 && view?.state === "WAITING" && view.task.day === authDay) {
          const label = `162 · ${countdown}`;
          if (el("toggle").textContent !== label) el("toggle").textContent = label;
        }
      },
      destroy() {
        destroyed = true;
        observer.disconnect();
        host.remove();
      }
    };
  }
  if (location.origin === ORIGIN && window.top === window.self && !document.getElementById("hdu-p60-host")) {
    let dayCheck = function() {
      const task = dailyTask();
      if (current?.task.day === task.day) return false;
      if (current?.formal) void current.suspend("AUTHORIZATION_EXPIRED");
      current = create(task);
      viewing = current;
      panel.newDay(task);
      panel.render(current.view(), current);
      return true;
    };
    let current, viewing, panel;
    const display = (view, source) => {
      if (source === viewing) panel.render(view, source);
    };
    const create = (task, canWrite = true) => {
      const engine = new DailyEngine(new Transport(), new DailyStore(task), (v) => display(v, engine), {
        task,
        canWrite
      });
      return engine;
    };
    const action = async (fn) => {
      try {
        await fn();
      } catch (e) {
        viewing.emit(viewing.attempted ? "UNKNOWN" : "STOPPED", codeOf(e));
      }
    };
    panel = mountPanel({
      start: (arm, authorizedDay) => action(async () => {
        if (dayCheck()) return;
        viewing = current;
        panel.render(current.view(), current);
        await current.prepare({ arm, confirmed: arm, authorizedDay });
      }),
      stop: () => action(async () => {
        await current.suspend("USER_STOPPED");
        if (viewing !== current) await viewing.suspend("USER_STOPPED");
      }),
      review: (day) => action(async () => {
        if (current.busy || current.waiting || viewing.busy) return;
        dayCheck();
        viewing = day && day !== current.task.day ? create(dailyTask(Date.parse(`${day}T12:00:00+08:00`)), false) : current;
        panel.render(viewing.view(), viewing);
        await viewing.review();
      }),
      recent: () => action(async () => {
        const engine = viewing.identity ? viewing : current;
        if (!engine.identity) return;
        panel.recent(
          (await engine.store.list()).sort((a, b) => b.target.date.localeCompare(a.target.date)).slice(0, 7)
        );
      }),
      export: () => viewing.diagnosticExport(),
      observe: (code) => {
        if (viewing) viewing.observePage(code);
      }
    });
    dayCheck();
    const suspend = (code = "FOREGROUND_REQUIRED") => {
      if (current.formal) void current.suspend(code);
    };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") suspend();
      else dayCheck();
    });
    document.addEventListener("freeze", () => suspend());
    window.addEventListener("pagehide", () => {
      viewing.observePage("PAGE_CONTEXT_END");
      suspend();
    });
    window.addEventListener("storage", () => {
      if (current.formal && current.store.stopped()) void current.suspend();
    });
    const loop = () => {
      dayCheck();
      if (!current.formal && current.state === "IDLE" && Date.now() >= current.task.open)
        current.emit("EXPIRED", "PREPARE_WINDOW");
      panel.clock(current.task, Date.now());
      void current.tick();
      setTimeout(loop, current.waiting && current.task.open - Date.now() <= 2e3 ? 50 : 250);
    };
    loop();
  }
})();
