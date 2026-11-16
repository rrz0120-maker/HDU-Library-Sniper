// ==UserScript==
// @name         杭电图书馆 P5.1 单次预约测试
// @namespace    https://github.com/rrz0120-maker/HDU-Library-Sniper
// @version      5.1.0
// @description  官网同源只读检查与明确确认后单次预约；不自动重试、不取消、不提供20:00定时模式。
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
  function beginTime(selection) {
    check(["162", "157"].includes(selection.seat), "SEAT_NOT_ALLOWED");
    const hour = integer(selection.hour);
    check(hour >= 0 && hour < 24 && selection.hours === 1, "INVALID_TIME");
    return midnight(selection.date) / 1e3 + hour * 3600;
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
    const first = midnight(raw?.advance_date), last = midnight(raw?.max_date);
    check(first <= last && (last - first) / DAY <= 31, "DATE_CONTRACT_UNKNOWN");
    const min = integer(raw.minBeginTime), max = integer(raw.maxEndTime);
    check(
      min >= 0 && max <= 24 && min < max && integer(raw.min_duration) <= 1 && integer(raw.min_duration) >= 1 && integer(raw.max_duration) >= 1,
      "ONE_HOUR_NOT_ALLOWED"
    );
    if (raw.max_num !== void 0) check(integer(raw.max_num) >= 1, "ONE_PERSON_NOT_ALLOWED");
    const dates = [];
    for (let at = first; at <= last; at += DAY) dates.push(shanghaiDate(at));
    return { dates, min, max };
  }
  function validateSelection(selection, range, now = Date.now()) {
    const begin = beginTime(selection);
    check(range.dates.includes(selection.date) && begin * 1e3 > now, "DATE_OR_TIME_NOT_OPEN");
    check(selection.hour >= range.min && selection.hour + 1 <= range.max, "INVALID_TIME");
    return begin;
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
  function resolveSeats(body) {
    const floors = body?.allContent?.children?.[2]?.children?.children;
    check(Array.isArray(floors), "SEAT_RESPONSE_UNKNOWN");
    const rooms = floors.filter((f) => roomMatches(f.roomName));
    check(rooms.length === 1, "ROOM_NOT_UNIQUE");
    const floor = rooms[0], floorId = integer(floor.seatMap?.info?.id);
    check(floorId > 0 && Array.isArray(floor.seatMap.POIs), "MAPPING_INVALID");
    const seats = ["162", "157"].map((number) => {
      const entries = floor.seatMap.POIs.filter((p) => scalar(p.title).trim() === number);
      check(entries.length === 1, "MAPPING_INVALID");
      const id = scalar(entries[0].id), state = scalar(entries[0].state);
      check(
        /^[a-zA-Z0-9_-]{1,128}$/.test(id) && id !== "0" && ["0", "1", "3"].includes(state),
        "MAPPING_INVALID"
      );
      return { number, id, free: state === "0" };
    });
    check(seats[0].id !== seats[1].id, "MAPPING_INVALID");
    return { floorId, room: floor.roomName, seats };
  }
  function records(body) {
    check(Array.isArray(body?.content?.defaultItems), "RECORDS_UNKNOWN");
    return body.content.defaultItems;
  }
  function conflicts(items, selection) {
    const begin = beginTime(selection), end = begin + 3600;
    return items.filter((r) => {
      const state = scalar(r.status);
      if (["3", "4", "5", "6", "7", "9"].includes(state)) return false;
      check(["0", "1", "2"].includes(state), "RECORDS_UNKNOWN");
      const time = integer(r.time), duration = integer(r.duration);
      check(
        time > 0 && duration > 0 && duration <= 86400 && Number.isSafeInteger(time + duration),
        "RECORDS_UNKNOWN"
      );
      return time < end && time + duration > begin;
    });
  }
  function verified(items, preview) {
    return conflicts(items, preview.selection).some(
      (r) => integer(r.time) === beginTime(preview.selection) && integer(r.duration) === 3600 && scalar(r.seatNum).trim() === preview.selection.seat && r.roomName === preview.mapping.room
    );
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
  function signedRequest(seatId, uid, begin, apiTime) {
    const source = `post&${BOOK_PATH}&api_time${apiTime}&beginTime${begin}&duration3600&is_recommend0&seatBookers[0]${uid}&seats[0]${seatId}`;
    return {
      token: btoa(md5(source)),
      form: new URLSearchParams({
        beginTime: String(begin),
        duration: "3600",
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
  function summary(selection) {
    return `${selection.date} ${String(selection.hour).padStart(2, "0")}:00–${String(selection.hour + 1).padStart(2, "0")}:00 · 1小时 / 1人 · 宋韵云图（四楼）${selection.seat}号`;
  }
  function mappingFingerprint(mapping) {
    return JSON.stringify([mapping.floorId, mapping.room, mapping.seats.map((s) => [s.number, s.id])]);
  }
  class Ledger {
    async open() {
      if (this.db) return this.db;
      check(globalThis.indexedDB, "STORAGE_UNAVAILABLE");
      this.db = await new Promise((resolve, reject) => {
        const req = indexedDB.open("hdu-p51-single-write", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("attempts", { keyPath: "key" });
        req.onsuccess = () => resolve(req.result);
        req.onerror = req.onblocked = () => reject(new TestError("STORAGE_UNAVAILABLE"));
      });
      this.db.onversionchange = () => {
        this.db.close();
        this.db = null;
      };
      return this.db;
    }
    async transaction(key, update) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        let result;
        const tx = db.transaction(
          "attempts",
          update ? "readwrite" : "readonly",
          update ? { durability: "strict" } : void 0
        );
        const store = tx.objectStore("attempts");
        const request = store.get(key);
        request.onsuccess = () => {
          result = request.result || null;
          if (update) {
            const next = update(result);
            if (next) {
              store.put(next);
              result = next;
            }
          }
        };
        tx.oncomplete = () => resolve(result);
        tx.onerror = tx.onabort = () => reject(new TestError("STORAGE_UNAVAILABLE"));
      });
    }
    get(key) {
      return this.transaction(key);
    }
    async claim(intent) {
      let won = false;
      const value = await this.transaction(intent.key, (old) => {
        if (old) return null;
        won = true;
        return intent;
      });
      return { won, value };
    }
    finish(key, ticket, result) {
      return this.transaction(
        key,
        (old) => old?.ticket === ticket && old.state !== "SUCCESS" ? { ...old, ...result } : null
      );
    }
  }
  async function accountKey(uid) {
    check(globalThis.crypto?.subtle, "STORAGE_UNAVAILABLE");
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`HDU-P5.1:${uid}`));
    return [...new Uint8Array(hash)].map((v) => v.toString(16).padStart(2, "0")).join("");
  }
  class Engine {
    constructor(io, ledger, notify = () => {
    }) {
      this.io = io;
      this.ledger = ledger;
      this.notify = notify;
      this.logs = [];
      this.generation = 0;
      this.busy = false;
      this.preview = null;
      this.identity = null;
    }
    log(code, details = {}) {
      this.logs.push({ at: (/* @__PURE__ */ new Date()).toISOString(), code, ...details });
      if (this.logs.length > 40) this.logs.shift();
      this.notify({ code, details });
    }
    ensure(generation) {
      check(generation === this.generation, "STOPPED");
    }
    stop() {
      this.generation++;
      this.preview = null;
      this.controller?.abort();
      this.log("STOPPED");
    }
    async run(fn) {
      check(!this.busy, "BUSY");
      this.busy = true;
      this.controller = new AbortController();
      const generation = this.generation;
      try {
        return await fn(generation);
      } catch (e) {
        this.preview = null;
        this.log(codeOf(e));
        throw e;
      } finally {
        this.busy = false;
        this.controller = null;
      }
    }
    async read(path, generation, form) {
      this.ensure(generation);
      const { body } = await this.io.request(path, { form, signal: this.controller.signal });
      this.ensure(generation);
      const code = responseCode(body);
      check(!["LIMITED", "HTTP_404", "AUTH_REQUIRED"].includes(code), code);
      return body;
    }
    async login(generation, timings = {}) {
      const start = performance.now();
      const body = await this.read("/User/Center/baseInfo", generation);
      const uid = body?.DATA?.uid;
      check(body?.DATA?.is_login === true && /^[0-9]+$/.test(String(uid ?? "")), "AUTH_REQUIRED");
      const identity = { uid: String(uid), key: await accountKey(String(uid)) };
      this.ensure(generation);
      this.identity = identity;
      timings.loginCheckMs = performance.now() - start;
      this.log("LOGIN_OK", { loginCheckMs: timings.loginCheckMs });
      return identity;
    }
    async ranges(generation, timings = {}) {
      const start = performance.now();
      const query = roomQuery(await this.read("/Space/Category/list?LAB_JSON=1", generation));
      const body = await this.read(query, generation);
      this.log("RANGE_SHAPE", { fields: inspectRange(body?.data?.range) });
      const range = parseRange(body?.data?.range);
      const group = category(body?.data);
      timings.catalogReadMs = performance.now() - start;
      this.log("DATES_OK", { dates: range.dates, min: range.min, max: range.max });
      return { range, group };
    }
    checkLogin() {
      return this.run((g) => this.login(g).then(() => ({ valid: true })));
    }
    openDates() {
      return this.run(async (g) => {
        await this.login(g);
        return (await this.ranges(g)).range;
      });
    }
    async snapshot(selection, generation, requireFree) {
      const timings = {};
      const identity = await this.login(generation, timings);
      if (requireFree) {
        check(!await this.ledger.get(identity.key), "BUDGET_SPENT");
        this.ensure(generation);
      }
      const { range, group } = await this.ranges(generation, timings);
      const begin = validateSelection(selection, range, this.io.now());
      check(this.io.clockValid(), "CLOCK_UNVERIFIED");
      const start = performance.now();
      const mapBody = await this.read(
        "/Seat/Index/searchSeats?LAB_JSON=1",
        generation,
        new URLSearchParams({
          beginTime: String(begin),
          duration: "3600",
          num: "1",
          "space_category[category_id]": group.category_id,
          "space_category[content_id]": group.content_id
        })
      );
      timings.catalogReadMs += performance.now() - start;
      const parsed = performance.now();
      const mapping = resolveSeats(mapBody);
      timings.idResolutionMs = performance.now() - parsed;
      const read = performance.now();
      const booked = records(await this.read("/Seat/Index/myBookingList?fromType=web&LAB_JSON=1", generation));
      timings.conflictReadMs = performance.now() - read;
      const count = conflicts(booked, selection).length;
      this.log("SEATS_CHECKED", { mapping, conflicts: count, timings });
      if (requireFree) {
        check(count === 0, "EXISTING");
        check(mapping.seats.find((s) => s.number === selection.seat)?.free, "SEAT_UNAVAILABLE");
      }
      return { identity, range, selection: { ...selection }, mapping, conflictCount: count, timings };
    }
    querySeats(selection) {
      return this.run(async (g) => {
        const snap = await this.snapshot(selection, g, false);
        return { mapping: snap.mapping, conflicts: snap.conflictCount };
      });
    }
    prepare(selection) {
      this.preview = null;
      return this.run(async (g) => {
        const snap = await this.snapshot(selection, g, true);
        check(!await this.ledger.get(snap.identity.key), "BUDGET_SPENT");
        this.ensure(g);
        this.preview = {
          ticket: crypto.randomUUID(),
          selection: snap.selection,
          mapping: snap.mapping,
          account: snap.identity.key,
          expires: this.io.now() + 3e5,
          timings: snap.timings
        };
        this.log("AWAITING_CONFIRMATION");
        return this.preview;
      });
    }
    confirm(ticket, { details = false, rules = false } = {}) {
      return this.run(async (g) => {
        const preview = this.preview;
        check(preview && ticket === preview.ticket && details && rules, "CONFIRMATION_REQUIRED");
        this.preview = null;
        check(this.io.now() <= preview.expires, "PREVIEW_EXPIRED");
        const existing = await this.ledger.get(preview.account);
        this.ensure(g);
        if (existing) {
          this.log("BUDGET_SPENT");
          return existing;
        }
        const fresh = await this.snapshot(preview.selection, g, true);
        check(fresh.identity.key === preview.account, "IDENTITY_CHANGED");
        check(mappingFingerprint(fresh.mapping) === mappingFingerprint(preview.mapping), "MAPPING_CHANGED");
        check(this.io.now() <= preview.expires, "PREVIEW_EXPIRED");
        const localStart = performance.now();
        const intent = {
          key: preview.account,
          ticket,
          selection: fresh.selection,
          mapping: fresh.mapping,
          state: "UNKNOWN",
          reason: "WRITE_INTENT_PERSISTED",
          attempts: 1,
          recordVerified: false,
          timings: fresh.timings
        };
        const claim = await this.ledger.claim(intent);
        if (!claim.won) {
          this.log("BUDGET_SPENT");
          return claim.value;
        }
        let reason = "STOPPED", verifiedRecord = false, verificationError = null;
        const timings = { ...fresh.timings, preSubmitLocalMs: performance.now() - localStart };
        try {
          this.ensure(g);
          check(this.io.now() <= preview.expires, "PREVIEW_EXPIRED");
          validateSelection(fresh.selection, fresh.range, this.io.now());
          check(this.io.clockValid(), "CLOCK_UNVERIFIED");
          const request = signedRequest(
            fresh.mapping.seats.find((s) => s.number === fresh.selection.seat).id,
            fresh.identity.uid,
            beginTime(fresh.selection),
            Math.floor(this.io.now() / 1e3)
          );
          timings.preSubmitLocalMs = performance.now() - localStart;
          this.log("SUBMITTING_ONCE");
          const response = await this.io.request(BOOK_PATH, {
            ...request,
            write: true,
            signal: this.controller.signal
          });
          timings.http = response.timing;
          reason = responseCode(response.body);
        } catch (error) {
          reason = codeOf(error);
          timings.http = error.timing || null;
        }
        if (g === this.generation && !["LIMITED", "AUTH_REQUIRED"].includes(reason)) {
          const verification = performance.now();
          try {
            verifiedRecord = verified(
              records(await this.read("/Seat/Index/myBookingList?fromType=web&LAB_JSON=1", g)),
              fresh
            );
          } catch (error) {
            verificationError = codeOf(error);
          }
          timings.verificationMs = performance.now() - verification;
        }
        const state = verifiedRecord ? "SUCCESS" : ["LIMITED", "AUTH_REQUIRED", "SEAT_UNAVAILABLE", "EXISTING", "NOT_OPEN"].includes(reason) ? "STOPPED" : "UNKNOWN";
        const result = await this.ledger.finish(preview.account, ticket, {
          state,
          reason,
          recordVerified: verifiedRecord,
          verificationError,
          timings
        });
        this.log(state, { reason, recordVerified: verifiedRecord, timings });
        return result;
      });
    }
    review() {
      return this.run(async (g) => {
        const identity = await this.login(g);
        const attempt = await this.ledger.get(identity.key);
        this.ensure(g);
        const items = records(await this.read("/Seat/Index/myBookingList?fromType=web&LAB_JSON=1", g));
        if (!attempt) {
          this.log("NO_ATTEMPT", { existingRecordCount: items.length });
          return { state: "NOT_STARTED", existingRecordCount: items.length };
        }
        if (verified(items, attempt)) {
          const result = await this.ledger.finish(identity.key, attempt.ticket, {
            state: "SUCCESS",
            recordVerified: true
          });
          this.log("SUCCESS", { recordVerified: true });
          return result;
        }
        this.log(attempt.state, { reason: attempt.reason, recordVerified: attempt.recordVerified });
        return attempt;
      });
    }
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
    async request(path, { form, token, write = false, signal } = {}) {
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
        timing.dispatchToHeadersMs = performance.now() - start;
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
  const messages = {
    LOGIN_OK: "官网登录有效（身份信息不展示）",
    AUTH_REQUIRED: "登录已失效，请在官网正常登录后重试只读检查。",
    DATES_OK: "已读取开放日期及允许时段",
    RANGE_SHAPE: "已记录日期字段的脱敏类型",
    DATE_CONTRACT_UNKNOWN: "日期字段格式尚不支持，已禁止提交。请查看并复制脱敏日志以便适配。",
    CLOCK_UNVERIFIED: "手机与服务器时钟无法核对，请检查自动日期时间设置后重新只读检查。",
    ONE_HOUR_NOT_ALLOWED: "馆方当前不允许所选的一小时时段",
    SEATS_CHECKED: "座位与已有预约检查完成",
    SEAT_UNAVAILABLE: "所选座位不可预约，已停止。不会自动尝试其他座位。",
    EXISTING: "已有冲突预约，禁止重复提交",
    AWAITING_CONFIRMATION: "准备完成，真实写入仍关闭，请核对下方方案。",
    SUBMITTING_ONCE: "正在提交一次预约，请保持前台和网络正常。",
    SUCCESS: "预约成功：已通过官方记录核对座位、日期、时间及一小时时长。",
    UNKNOWN: "结果待确认，自动操作已停止。不得重发，请查看预约结果或在官网人工核对。",
    STOPPED: "当前任务已停止；已发送的请求可能完成，停止不会取消已有预约。",
    LIMITED: "馆方限流或限制访问，已停止。请勿继续提交。",
    BUDGET_SPENT: "本浏览器已使用该账号的一次测试额度，请查看预约结果；不会重新提交。",
    PREVIEW_EXPIRED: "准备方案已过期，请重新只读准备",
    CONFIRMATION_REQUIRED: "请先准备，并明确确认完整方案及馆方规则。",
    IDENTITY_CHANGED: "登录账号改变，已停止",
    MAPPING_CHANGED: "座位映射改变，已禁止提交，请重新只读检查。",
    DATE_OR_TIME_NOT_OPEN: "所选日期或时段未开放，或开始时间已过",
    INVALID_TIME: "请选择馆方允许的未来整点时段（1小时）",
    STORAGE_UNAVAILABLE: "本机持久化保护不可用，禁止提交。请使用普通浏览模式并检查存储权限。",
    HTTP_404: "接口返回404，已停止；这不等于座位被抢走。",
    TIMEOUT: "请求超时，已停止；若发生在提交阶段，不得重发。",
    NETWORK_ERROR: "网络请求失败，已停止。",
    RESPONSE_UNKNOWN: "接口响应无法确认，已停止。",
    NO_ATTEMPT: "本浏览器尚无测试提交记录",
    BUSY: "当前操作进行中，请等待或停止。",
    LOCAL_ERROR: "本机处理失败，已停止；如曾提交，请检查官方记录。"
  };
  function mount(engine) {
    const host = document.createElement("div");
    host.id = "hdu-p51-panel";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
    :host{all:initial;position:fixed;right:8px;bottom:12px;z-index:2147483646;font-family:system-ui,sans-serif;color:#17212c;font-size:16px;line-height:1.5}
    *{box-sizing:border-box}button,input,select{font:inherit}button,select,input[type=checkbox]{touch-action:manipulation}button{min-height:44px;border:1px solid #b4bec8;border-radius:8px;padding:9px 12px;background:#fff;color:#17212c;cursor:pointer}button:disabled{opacity:.5;cursor:default}
    #toggle{background:#164d80;color:white;border:0;box-shadow:0 3px 12px #0004}section{background:#f8fafc;border:1px solid #aab6c2;border-radius:12px;padding:14px;width:min(380px,calc(100vw - 16px));max-height:calc(100vh - 80px);max-height:calc(100dvh - 80px);overflow-y:auto;overscroll-behavior:contain;box-shadow:0 4px 20px #0003;margin-bottom:8px}section[hidden]{display:none}
    h2{font-size:19px;margin:0 0 8px}p{margin:8px 0;overflow-wrap:anywhere}.hint{font-size:13px;color:#475569}.actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0}.fields{display:grid;gap:8px}select{width:100%;min-height:44px;border:1px solid #94a3b8;border-radius:6px;background:white;color:#17212c;padding:8px}label{display:block}.confirm{padding:10px;border:1px solid #cbd5e1;border-radius:8px;margin-top:10px}.confirm label{display:flex;gap:8px;align-items:flex-start;margin:10px 0}input[type=checkbox]{width:22px;height:22px;flex:none}#submit{width:100%;background:#164d80;color:white}#stop{border-color:#a52727;color:#a52727}#status{padding:8px;background:#e7eff7;border-radius:6px}#preview{font-weight:600}textarea{width:100%;height:180px;font:12px/1.5 monospace;white-space:pre-wrap;overflow-wrap:anywhere}#seats{font-size:14px;white-space:pre-wrap}a{color:#164d80}button:focus-visible,select:focus-visible{outline:3px solid #f0b84d}
  </style><section hidden aria-label="P5.1 单次预约测试">
    <h2>P5.1 单次预约测试</h2>
    <p class="hint">宋韵云图（四楼）· 仅 162 / 157 · 1小时 / 1人。真实提交默认关闭。</p>
    <p class="hint">保持浏览器前台、屏幕唤醒及网络正常。暂不提供20:00定时抢座。</p>
    <p id="status" role="status" aria-live="polite">先检查登录，再查询开放日期。</p>
    <div class="actions"><button id="login">检查登录状态</button><button id="dates">查询开放日期</button></div>
    <div class="fields"><label>使用日期（北京时间）<select id="date" aria-label="使用日期"><option value="">先查询开放日期</option></select></label><label>开始时间（时长固定1小时）<select id="hour" aria-label="开始时间"><option value="">先选择日期</option></select></label><label>测试座位<select id="seat" aria-label="测试座位"><option value="162">162</option><option value="157">157</option></select></label></div>
    <div class="actions"><button id="query">查询四楼162/157</button><button id="prepare">准备预约</button></div>
    <p id="seats"></p><div class="confirm"><p id="preview">尚未准备预约方案</p><label><input id="details" type="checkbox" disabled>我确认上述日期、时间、楼层及座位，实际需要使用1小时。</label><label><input id="rules" type="checkbox" disabled>我已核实馆方允许此预约方式，授权本次最多一次提交。</label><button id="submit" disabled>确认提交一次预约</button></div>
    <div class="actions"><button id="result">查看预约结果</button><button id="logs">查看运行日志</button><button id="stop">停止当前任务</button><button id="copy">复制脱敏日志</button></div>
    <textarea id="logtext" aria-label="脱敏运行日志" readonly hidden></textarea>
    <p class="hint">防重复记录只在当前浏览器内有效。请勿用无痕模式、清除网站数据、重装或换设备绕过次数保护。停止任务不会取消预约。</p>
  </section><button id="toggle" aria-expanded="false">P5.1 预约测试</button>`;
    document.documentElement.append(host);
    const el = (id) => root.getElementById(id);
    let range = null, preview = null, uiBusy = false;
    const status = (code) => {
      el("status").textContent = messages[code] || `已停止：${code}（请查看脱敏日志）`;
    };
    const clear = () => {
      preview = null;
      el("details").checked = el("rules").checked = false;
      el("details").disabled = el("rules").disabled = true;
      el("submit").disabled = true;
      el("preview").textContent = "尚未准备预约方案";
    };
    const showLogs = () => {
      el("logtext").value = JSON.stringify(
        {
          version: "P5.1.0",
          realPerformance: "只代表本次手机环境，不代表20:00高峰；网络、排队和服务器时间无法分离",
          logs: engine.logs
        },
        null,
        2
      );
    };
    engine.notify = ({ code, details }) => {
      status(code === "STOPPED" && details.reason ? details.reason : code);
      showLogs();
    };
    function selection() {
      return {
        date: el("date").value,
        hour: el("hour").value === "" ? -1 : Number(el("hour").value),
        hours: 1,
        seat: el("seat").value
      };
    }
    function hours() {
      const old = el("hour").value;
      el("hour").replaceChildren();
      if (!range || !el("date").value) return;
      for (let h = range.min; h < range.max; h++) {
        if (Date.parse(`${el("date").value}T${String(h).padStart(2, "0")}:00:00+08:00`) <= Date.now()) continue;
        const opt = document.createElement("option");
        opt.value = String(h);
        opt.textContent = `${String(h).padStart(2, "0")}:00–${String(h + 1).padStart(2, "0")}:00`;
        el("hour").append(opt);
      }
      if ([...el("hour").options].some((o) => o.value === old)) el("hour").value = old;
    }
    async function action(work, keep = false) {
      if (uiBusy) return;
      uiBusy = true;
      if (!keep) clear();
      for (const id of ["login", "dates", "query", "prepare", "result", "date", "hour", "seat"])
        el(id).disabled = true;
      el("submit").disabled = true;
      try {
        await work();
      } catch (e) {
        clear();
        status(codeOf(e));
      } finally {
        uiBusy = false;
        for (const id of ["login", "dates", "query", "prepare", "result", "date", "hour", "seat"])
          el(id).disabled = false;
        el("submit").disabled = !preview || !el("details").checked || !el("rules").checked;
      }
    }
    el("toggle").onclick = () => {
      const section = root.querySelector("section");
      section.hidden = !section.hidden;
      el("toggle").setAttribute("aria-expanded", String(!section.hidden));
    };
    el("login").onclick = () => action(() => engine.checkLogin());
    el("dates").onclick = () => action(async () => {
      range = await engine.openDates();
      el("date").replaceChildren();
      for (const date of range.dates.filter((d) => d >= shanghaiDate())) {
        const opt = document.createElement("option");
        opt.value = date;
        opt.textContent = date;
        el("date").append(opt);
      }
      hours();
    });
    const showSeats = (mapping, count) => {
      el("seats").textContent = `${mapping.room}
${mapping.seats.map((s) => `${s.number}：内部ID ${s.id}，${s.free ? "该时段空闲" : "不可预约"}`).join("\n")}
已有冲突预约：${count}`;
    };
    el("query").onclick = () => action(async () => {
      const data = await engine.querySeats(selection());
      showSeats(data.mapping, data.conflicts);
    });
    el("prepare").onclick = () => action(async () => {
      preview = await engine.prepare(selection());
      showSeats(preview.mapping, 0);
      el("preview").textContent = summary(preview.selection);
      el("details").disabled = el("rules").disabled = false;
    });
    const toggleConfirm = () => {
      el("submit").disabled = uiBusy || !preview || !el("details").checked || !el("rules").checked;
    };
    el("details").onchange = el("rules").onchange = toggleConfirm;
    el("submit").onclick = (event) => {
      if (!event.isTrusted) {
        status("CONFIRMATION_REQUIRED");
        return;
      }
      return action(async () => {
        const p = preview;
        const permissions = { details: el("details").checked, rules: el("rules").checked };
        clear();
        const result = await engine.confirm(p?.ticket, permissions);
        status(result.state === "STOPPED" ? result.reason : result.state);
        el("preview").textContent = result.selection ? summary(result.selection) : "无提交记录";
      }, true);
    };
    el("result").onclick = () => action(async () => {
      const result = await engine.review();
      if (result.selection) el("preview").textContent = summary(result.selection);
    });
    el("stop").onclick = () => {
      engine.stop();
      clear();
    };
    for (const id of ["date", "hour", "seat"])
      el(id).onchange = () => {
        engine.stop();
        clear();
        el("seats").textContent = "参数已改变，需要重新只读检查";
        if (id === "date") hours();
      };
    el("logs").onclick = () => {
      showLogs();
      el("logtext").hidden = !el("logtext").hidden;
    };
    el("copy").onclick = async () => {
      showLogs();
      el("logtext").hidden = false;
      try {
        await navigator.clipboard.writeText(el("logtext").value);
      } catch {
        el("logtext").focus();
        el("logtext").select();
      }
    };
  }
  if (location.origin === ORIGIN && window.top === window.self && !document.getElementById("hdu-p51-panel"))
    mount(new Engine(new Transport(), new Ledger()));
})();
