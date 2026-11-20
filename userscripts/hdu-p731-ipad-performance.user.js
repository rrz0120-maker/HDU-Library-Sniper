// ==UserScript==
// @name         杭电图书馆 P7.3 iPad 正式性能版 (162整点 & 普通预约)
// @namespace    https://github.com/rrz0120-maker/HDU-Library-Sniper/p73-ipad
// @version      7.3.1
// @description  iPad Safari + Userscripts 正式性能候选版：固定四楼162、自定义时段、19:57正式准备、静态映射严格复用、19:59:15重校时、跨标签写入互斥、实际开放确认双门禁、跨模式互斥、后台挂起中止与单次写入保护。
// @match        https://hdu.huitu.zhishulib.com/*
// @grant        none
// @inject-into  page
// @noframes
// @run-at       document-idle
// @updateURL    none
// @license      MIT
// ==/UserScript==
(function () {
  "use strict";
  // --- src/userscript/core.js ---
// P5.1: the request/signature contract follows crates/hdu/src/library/{parse,booking,catalog}.rs.
const ORIGIN = "https://hdu.huitu.zhishulib.com";
const BOOK_PATH = "/Seat/Index/bookSeats?LAB_JSON=1";
const DAY = 86400000;
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
const scalar = (v) => (typeof v === "string" || typeof v === "number" ? String(v) : "");
function shanghaiDate(ms = Date.now()) {
  return new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
}
function midnight(date) {
  check(typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date), "DATE_CONTRACT_UNKNOWN");
  const ms = Date.parse(`${date}T00:00:00+08:00`);
  check(Number.isFinite(ms) && shanghaiDate(ms) === date, "DATE_CONTRACT_UNKNOWN");
  return ms;
}
// Verified by the user's P5.1 read-only response: numeric boundaries are Unix
// seconds, not offsets. Keep date-only strings compatible and never coerce units.
function rangeMidnight(value) {
  if (typeof value === "string") return midnight(value);
  check(Number.isSafeInteger(value) && value >= 0 && value < 10_000_000_000, "DATE_CONTRACT_UNKNOWN");
  const ms = value * 1000;
  check(midnight(shanghaiDate(ms)) === ms, "DATE_CONTRACT_UNKNOWN");
  // Explicit IANA zone check also rejects historical DST/non-midnight values.
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  check(
    parts.filter((p) => ["hour", "minute", "second"].includes(p.type)).every((p) => p.value === "00"),
    "DATE_CONTRACT_UNKNOWN",
  );
  return ms;
}
function beginTime(selection) {
  check(["162", "157"].includes(selection.seat), "SEAT_NOT_ALLOWED");
  const hour = integer(selection.hour);
  check(hour >= 0 && hour < 24 && selection.hours === 1, "INVALID_TIME");
  return midnight(selection.date) / 1000 + hour * 3600;
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
    "max_num",
  ]) {
    const value = range?.[key];
    const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    result[key] = {
      type,
      value:
        type === "number" || (type === "string" && /^[0-9\-/: .T+Z]{1,32}$/.test(value)) ? value : "未解析",
    };
  }
  return result;
}
function parseRange(raw) {
  const first = rangeMidnight(raw?.advance_date),
    last = rangeMidnight(raw?.max_date);
  check(first <= last && (last - first) / DAY <= 31, "DATE_CONTRACT_UNKNOWN");
  const min = integer(raw.minBeginTime),
    max = integer(raw.maxEndTime);
  check(
    min >= 0 &&
      max <= 24 &&
      min < max &&
      integer(raw.min_duration) <= 1 &&
      integer(raw.min_duration) >= 1 &&
      integer(raw.max_duration) >= 1,
    "ONE_HOUR_NOT_ALLOWED",
  );
  if (raw.max_num !== undefined) check(integer(raw.max_num) >= 1, "ONE_PERSON_NOT_ALLOWED");
  const dates = [];
  // Official control: _renderDay() is the day difference; _renderDate() uses n < days.
  // max_date is the first excluded date (see docs/evidence/p52/date-control.json).
  for (let at = first; at < last; at += DAY) dates.push(shanghaiDate(at));
  return { dates, min, max, maxDateExclusive: shanghaiDate(last) };
}
function validateSelection(selection, range, now = Date.now()) {
  const begin = beginTime(selection);
  check(range.dates.includes(selection.date) && begin * 1000 > now, "DATE_OR_TIME_NOT_OPEN");
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
  const id = scalar(data?.space_category?.category_id),
    content = scalar(data?.space_category?.content_id);
  check(/^\d+$/.test(id) && id !== "0" && /^\d+$/.test(content), "CATEGORY_UNKNOWN");
  return { category_id: id, content_id: content };
}
function resolveSeats(body) {
  const floors = body?.allContent?.children?.[2]?.children?.children;
  check(Array.isArray(floors), "SEAT_RESPONSE_UNKNOWN");
  const rooms = floors.filter((f) => roomMatches(f.roomName));
  check(rooms.length === 1, "ROOM_NOT_UNIQUE");
  const floor = rooms[0],
    floorId = integer(floor.seatMap?.info?.id);
  check(floorId > 0 && Array.isArray(floor.seatMap.POIs), "MAPPING_INVALID");
  const seats = ["162", "157"].map((number) => {
    const entries = floor.seatMap.POIs.filter((p) => scalar(p.title).trim() === number);
    check(entries.length === 1, "MAPPING_INVALID");
    const id = scalar(entries[0].id),
      state = scalar(entries[0].state);
    check(
      /^[a-zA-Z0-9_-]{1,128}$/.test(id) && id !== "0" && ["0", "1", "3"].includes(state),
      "MAPPING_INVALID",
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
  const begin = beginTime(selection),
    end = begin + 3600;
  return items.filter((r) => {
    const state = scalar(r.status);
    if (["3", "4", "5", "6", "7", "9"].includes(state)) return false;
    check(["0", "1", "2"].includes(state), "RECORDS_UNKNOWN");
    const time = integer(r.time),
      duration = integer(r.duration);
    check(
      time > 0 && duration > 0 && duration <= 86400 && Number.isSafeInteger(time + duration),
      "RECORDS_UNKNOWN",
    );
    return time < end && time + duration > begin;
  });
}
function verified(items, preview) {
  return conflicts(items, preview.selection).some(
    (r) =>
      integer(r.time) === beginTime(preview.selection) &&
      integer(r.duration) === 3600 &&
      scalar(r.seatNum).trim() === preview.selection.seat &&
      r.roomName === preview.mapping.room,
  );
}
// RFC 1321 MD5. No remote dependencies; UTF-8 input matches Rust source.as_bytes().
function md5(source) {
  const bytes = new TextEncoder().encode(source);
  const size = Math.ceil((bytes.length + 9) / 64) * 64;
  const buffer = new Uint8Array(size);
  buffer.set(bytes);
  buffer[bytes.length] = 128;
  const view = new DataView(buffer.buffer);
  view.setUint32(size - 8, (bytes.length * 8) >>> 0, true);
  view.setUint32(size - 4, Math.floor(bytes.length / 536870912), true);
  const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let offset = 0; offset < size; offset += 64) {
    let [a, b, c, d] = h;
    for (let i = 0; i < 64; i++) {
      let f, index;
      if (i < 16) {
        f = (b & c) | (~b & d);
        index = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        index = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        index = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        index = (7 * i) % 16;
      }
      const shift = shifts[Math.floor(i / 16) * 4 + (i % 4)];
      const sum =
        (a +
          f +
          Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) +
          view.getUint32(offset + index * 4, true)) |
        0;
      const next = (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0;
      a = d;
      d = c;
      c = b;
      b = next;
    }
    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
  }
  return h
    .flatMap((n) => [0, 8, 16, 24].map((bits) => ((n >>> bits) & 255).toString(16).padStart(2, "0")))
    .join("");
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
      "seatBookers[0]": uid,
    }),
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

  // --- src/userscript/transport.js ---
const PATHS = new Set([
  "/User/Center/baseInfo",
  "/Space/Category/list",
  "/Seat/Index/searchSeats",
  "/Seat/Index/myBookingList",
  "/Seat/Index/bookSeats",
]);
class Transport {
  constructor() {
    this.clock = null;
  }
  now() {
    return Date.now();
  }
  clockValid() {
    return this.clock && performance.now() - this.clock.at < 60000 && Math.abs(this.clock.offset) <= 5000;
  }
  async request(path, { form, token, write = false, signal, onHeaders, onDispatch, onBusiness } = {}) {
    const url = new URL(path, ORIGIN);
    check(location.origin === ORIGIN && url.origin === ORIGIN && PATHS.has(url.pathname), "ORIGIN_DENIED");
    check((url.pathname === "/Seat/Index/bookSeats") === write, "WRITE_GATE_CLOSED");
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
      write ? 30000 : 5000,
    );
    const start = performance.now();
    const timing = { dispatchAt: new Date().toISOString(), serverProcessingMs: null, requestUploadMs: null };
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
        ...(form ? { body: form } : {}),
      });
      timing.responseAt = new Date().toISOString();
      timing.dispatchToHeadersMs = performance.now() - start;
      onHeaders?.({
        status: response.status,
        timing: { ...timing },
        date: response.headers.get("Date"),
        age: response.headers.get("Age"),
        sentMono: start,
        receivedMono: performance.now(),
        receivedWall: Date.now(),
      });
      const date = Date.parse(response.headers.get("Date"));
      if (Number.isFinite(date)) this.clock = { at: performance.now(), offset: Date.now() - date };
      if (!response.ok)
        throw new TestError(
          response.status === 429 || response.status === 403
            ? "LIMITED"
            : response.status === 401
              ? "AUTH_REQUIRED"
              : response.status === 404
                ? "HTTP_404"
                : "HTTP_ERROR",
        );
      const decode = performance.now();
      const body = await response.json();
      timing.bodyDecodeMs = performance.now() - decode;
      timing.businessResultAt = new Date().toISOString();
      onBusiness?.(body, timing);
      return { body, timing };
    } catch (error) {
      const failure =
        error instanceof TestError
          ? error
          : new TestError(
              signal?.aborted
                ? "STOPPED"
                : timeout
                  ? "TIMEOUT"
                  : error instanceof SyntaxError
                    ? "RESPONSE_UNKNOWN"
                    : "NETWORK_ERROR",
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

  // --- src/userscript/ledger.js ---
// One permanent P5.1 write budget per account in THIS browser/origin. No reset/delete API.
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
        update ? { durability: "strict" } : undefined,
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
    return this.transaction(key, (old) =>
      old?.ticket === ticket && old.state !== "SUCCESS" ? { ...old, ...result } : null,
    );
  }
}
async function accountKey(uid) {
  check(globalThis.crypto?.subtle, "STORAGE_UNAVAILABLE");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`HDU-P5.1:${uid}`));
  return [...new Uint8Array(hash)].map((v) => v.toString(16).padStart(2, "0")).join("");
}

  // --- src/userscript/p70/policy.js ---
const P70_VERSION = "7.0.2-phase1";
const P70_RECORD_PATH = "/Seat/Index/myBookingList?fromType=web&LAB_JSON=1";
const P70_DURATION = 3600;
const P70_PREVIEW_TTL_MS = 300000;

const p70Scalar = (v) => (typeof v === "string" || typeof v === "number" ? String(v) : "");
function safeRandomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function compareSeatNumber(a, b) {
  return a.number.localeCompare(b.number, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
}
function resolveRoomsAndSeats(body) {
  const floors = body?.allContent?.children?.[2]?.children?.children;
  check(Array.isArray(floors) && floors.length > 0, "SEAT_RESPONSE_UNKNOWN");
  const rooms = [];
  const seenFloorIds = new Set();
  for (const floor of floors) {
    const roomName = p70Scalar(floor?.roomName).trim();
    if (!roomName || !floor?.seatMap) continue;
    const floorId = integer(floor.seatMap?.info?.id);
    check(floorId > 0 && Array.isArray(floor.seatMap.POIs), "MAPPING_INVALID");
    check(!seenFloorIds.has(floorId), "MAPPING_INVALID");
    seenFloorIds.add(floorId);
    const seenIds = new Set();
    const seenNumbers = new Set();
    const seats = [];
    for (const poi of floor.seatMap.POIs) {
      const number = p70Scalar(poi?.title).trim();
      const id = p70Scalar(poi?.id).trim();
      const state = p70Scalar(poi?.state).trim();
      if (!number || !id) continue;
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || id === "0" || !["0", "1", "3"].includes(state)) continue;
      if (seenIds.has(id) || seenNumbers.has(number)) continue;
      seenIds.add(id);
      seenNumbers.add(number);
      seats.push({ number, id, free: state === "0" });
    }
    if (!seats.length) continue;
    seats.sort(compareSeatNumber);
    const freeCount = seats.filter((s) => s.free).length;
    rooms.push({
      floorId,
      room: roomName,
      preferred: roomMatches(roomName),
      totalCount: seats.length,
      freeCount,
      seats,
    });
  }
  check(rooms.length > 0, "MAPPING_INVALID");
  rooms.sort((a, b) => Number(b.preferred) - Number(a.preferred) || b.freeCount - a.freeCount || a.floorId - b.floorId);
  return rooms;
}
function slotBeginTime(selection) {
  check(selection && typeof selection === "object", "INVALID_TIME");
  const hour = integer(selection.hour);
  const hours = selection.hours ?? 1;
  check(hour >= 0 && hour < 24 && hours === 1, "INVALID_TIME");
  return rangeMidnight(selection.date) / 1000 + hour * 3600;
}
function validateSlotSelection(selection, range, now = Date.now()) {
  const begin = slotBeginTime(selection);
  check(range && Array.isArray(range.dates), "DATE_CONTRACT_UNKNOWN");
  check(range.dates.includes(selection.date) && begin * 1000 > now, "DATE_OR_TIME_NOT_OPEN");
  check(selection.hour >= range.min && selection.hour + 1 <= range.max, "INVALID_TIME");
  return begin;
}
function resolveSelectedSeat(rooms, selection) {
  check(selection && typeof selection.seatId === "string" && selection.seatId.length > 0, "SEAT_REQUIRED");
  const floorId = integer(selection.floorId);
  const roomMatchesList = rooms.filter((r) => r.floorId === floorId);
  check(roomMatchesList.length === 1, "ROOM_NOT_UNIQUE");
  const room = roomMatchesList[0];
  const seatMatches = room.seats.filter(
    (s) => s.id === selection.seatId && s.number === String(selection.seatNumber || "").trim(),
  );
  check(seatMatches.length === 1, "MAPPING_INVALID");
  return { floorId: room.floorId, room: room.room, seat: seatMatches[0] };
}
function slotConflicts(items, selection) {
  const begin = slotBeginTime(selection);
  const end = begin + P70_DURATION;
  return items.filter((r) => {
    const state = p70Scalar(r.status);
    if (["3", "4", "5", "6", "7", "9"].includes(state)) return false;
    check(["0", "1", "2"].includes(state), "RECORDS_UNKNOWN");
    const time = integer(r.time);
    const duration = integer(r.duration);
    check(
      time > 0 && duration > 0 && duration <= 86400 && Number.isSafeInteger(time + duration),
      "RECORDS_UNKNOWN",
    );
    return time < end && time + duration > begin;
  });
}
function verifiedSlot(items, target) {
  const begin = slotBeginTime(target);
  return slotConflicts(items, target).some(
    (r) =>
      integer(r.time) === begin &&
      integer(r.duration) === P70_DURATION &&
      p70Scalar(r.seatNum).trim() === String(target.seatNumber).trim() &&
      r.roomName === target.room &&
      (r.seatId === undefined || p70Scalar(r.seatId).trim() === String(target.seatId).trim()),
  );
}
function slotKey(account, target) {
  const hourStr = String(integer(target.hour)).padStart(2, "0");
  return `${account}:${target.date}:${hourStr}:00-1h:${target.floorId}:${target.seatId}`;
}
function slotFingerprint(target) {
  return JSON.stringify([target.floorId, target.room, target.seatNumber, target.seatId]);
}
function slotSummary(target) {
  const h = String(integer(target.hour)).padStart(2, "0");
  const nextH = String(integer(target.hour) + 1).padStart(2, "0");
  return `${target.date} ${h}:00–${nextH}:00 · 1小时 / 1人 · ${target.room} ${target.seatNumber}号`;
}
function p70Pending(row) {
  return row?.attempts === 1 && !["SUCCESS", "FAILED"].includes(row.state);
}

const P70_TIMING_FIELDS = [
  "loginCheckMs",
  "catalogReadMs",
  "idResolutionMs",
  "conflictReadMs",
  "preSubmitLocalMs",
  "dispatchToHeadersMs",
  "bodyDecodeMs",
  "totalRequestMs",
  "verificationMs",
  "firstDispatchAt",
  "firstResponseAt",
  "firstBusinessResultAt",
  "firstRecordVerifiedAt",
  "responseCode",
];

// Explicit allowlist export: never serialize UID, token, cookies, headers, request body, or raw responses.
function publicIpadDiagnostics(row) {
  if (!row) return null;
  const timings = row.timings || {};
  const metrics = Object.fromEntries(P70_TIMING_FIELDS.map((k) => [k, row[k] ?? timings[k] ?? null]));
  return {
    version: row.version || P70_VERSION,
    platform: "ipad-safari-userscripts",
    date: row.target?.date || null,
    hour: row.target?.hour ?? null,
    duration: P70_DURATION,
    room: row.target?.room || null,
    floorId: row.target?.floorId ?? null,
    seatNumber: row.target?.seatNumber || null,
    state: row.state || "IDLE",
    reason: row.reason || "READ_ONLY_DEFAULT",
    attempts: row.attempts ?? 0,
    recordVerified: row.recordVerified === true,
    verifications: row.verifications ?? 0,
    ...metrics,
    lastReviewedAt: row.lastReviewedAt || null,
    events: (row.logs || [])
      .slice(-50)
      .map((e) => ({
        at: e.at,
        state: e.state,
        code: e.code || e.reason,
        ...(e.httpStatus != null ? { httpStatus: e.httpStatus } : {}),
        ...(e.endpoint ? { endpoint: e.endpoint } : {}),
      })),
    timingMeaning:
      "所有耗时与时间戳均为客户端观测值，不分离网络与服务端处理时间；日志已脱敏，不含账号、凭据或原始响应体",
  };
}

  // --- src/userscript/p70/store.js ---
// Dedicated iPad Phase 1 database. Never touches or fabricates P5.1/P5.3/P6.0/P6.1 legacy records.
class IpadStore {
  constructor({ database = "hdu-p70-ipad-booking", prefix = "hdu-p70:" } = {}) {
    this.database = database;
    this.prefix = prefix;
    this.db = null;
    this.account = null;
  }

  bind(account) {
    this.account = account;
  }

  async open() {
    if (this.db) return this.db;
    check(globalThis.indexedDB && globalThis.localStorage, "STORAGE_UNAVAILABLE");
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(this.database, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains("tasks"))
          req.result.createObjectStore("tasks", { keyPath: "key" });
        if (!req.result.objectStoreNames.contains("meta")) req.result.createObjectStore("meta");
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

  // Safari <16.4 and some WebKit builds reject the durability options bag with TypeError.
  openTx(db, storeName, mode) {
    if (mode !== "readwrite") return db.transaction(storeName, mode);
    try {
      return db.transaction(storeName, "readwrite", { durability: "strict" });
    } catch (e) {
      if (e instanceof TypeError) return db.transaction(storeName, "readwrite");
      throw e;
    }
  }

  async probe() {
    const db = await this.open();
    const value = safeRandomId();
    try {
      localStorage.setItem(`${this.prefix}probe`, value);
      check(localStorage.getItem(`${this.prefix}probe`) === value, "STORAGE_UNAVAILABLE");
    } catch {
      throw new TestError("STORAGE_UNAVAILABLE");
    }
    await new Promise((resolve, reject) => {
      const tx = this.openTx(db, "meta", "readwrite");
      tx.objectStore("meta").put(value, "probe");
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(new TestError("STORAGE_UNAVAILABLE"));
    });
    await new Promise((resolve, reject) => {
      const tx = this.openTx(db, "meta", "readonly");
      const req = tx.objectStore("meta").get("probe");
      req.onsuccess = () =>
        req.result === value ? resolve() : reject(new TestError("STORAGE_UNAVAILABLE"));
      tx.onerror = tx.onabort = () => reject(new TestError("STORAGE_UNAVAILABLE"));
    });
  }

  async transact(key, change) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      let result = null;
      let failure = null;
      const tx = this.openTx(db, "tasks", change ? "readwrite" : "readonly");
      const store = tx.objectStore("tasks");
      const req = store.get(key);
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

  async list(account = this.account) {
    if (!account) return [];
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.openTx(db, "tasks", "readonly");
      const req = tx.objectStore("tasks").getAll();
      req.onsuccess = () => resolve(req.result.filter((r) => r.key.startsWith(`${account}:`)));
      tx.onerror = tx.onabort = () => reject(new TestError("STORAGE_UNAVAILABLE"));
    });
  }

  async pendingUnknown(account = this.account) {
    const rows = await this.list(account);
    return rows.find(p70Pending) || null;
  }

  spent(key) {
    try {
      return localStorage.getItem(`${this.prefix}spent:${key}`) === "1";
    } catch {
      return true;
    }
  }

  stopSignal() {
    try {
      localStorage.setItem(`${this.prefix}stop`, String(Date.now()));
    } catch {
      /* Storage error handled by probe/claim */
    }
  }

  async claim(intent) {
    check(this.account && intent.key.startsWith(`${this.account}:`), "IDENTITY_CHANGED");
    const db = await this.open();
    return new Promise((resolve, reject) => {
      let won = false;
      let value = null;
      let failure = null;
      const tx = this.openTx(db, "tasks", "readwrite");
      const store = tx.objectStore("tasks");
      const req = store.getAll();
      req.onsuccess = () => {
        try {
          const accountRows = req.result.filter((r) => r.key.startsWith(`${this.account}:`));
          check(!accountRows.some(p70Pending), "PREVIOUS_UNKNOWN");
          value = accountRows.find((r) => r.key === intent.key) || null;
          if (value || this.spent(intent.key)) return;
          won = true;
          value = { ...intent, attempts: 1, verifications: 0 };
          store.put(value);
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => {
        try {
          if (won) localStorage.setItem(`${this.prefix}spent:${intent.key}`, "1");
          resolve({ won, value });
        } catch {
          reject(new TestError("STORAGE_UNAVAILABLE"));
        }
      };
      tx.onerror = tx.onabort = () => reject(failure || new TestError("STORAGE_UNAVAILABLE"));
    });
  }

  finish(key, ticket, patch) {
    return this.transact(key, (old) => {
      if (!old || old.ticket !== ticket) return null;
      const terminal =
        old.state === "SUCCESS" ||
        (old.state === "FAILED" && !(patch.state === "SUCCESS" && patch.recordVerified === true));
      if (terminal) return old;
      return { ...old, ...patch, timings: { ...(old.timings || {}), ...(patch.timings || {}) } };
    });
  }

  async takeVerification(key, now = Date.now()) {
    let won = false;
    await this.transact(key, (old) => {
      if (
        !old ||
        old.state === "SUCCESS" ||
        old.attempts !== 1 ||
        (old.verifications || 0) >= 3 ||
        now - (old.lastVerification || 0) < 2000
      )
        return null;
      won = true;
      return { ...old, verifications: (old.verifications || 0) + 1, lastVerification: now };
    });
    return won;
  }

  noteReview(key, at, logs) {
    return this.transact(key, (old) =>
      old ? { ...old, lastReviewedAt: at, logs: logs?.slice(-50) || old.logs } : null,
    );
  }
}

  // --- src/userscript/p70/engine.js ---
const REJECTED = new Set(["SEAT_UNAVAILABLE", "NOT_OPEN", "EXISTING", "LIMITED", "AUTH_REQUIRED"]);
class IpadBookingEngine {
  constructor(io, store, notify = () => {}, env = {}) {
    this.io = io;
    this.store = store;
    this.notify = notify;
    this.wall = env.wall || (() => (io.now ? io.now() : Date.now()));
    this.mono = env.mono || (() => performance.now());
    this.visible = env.visible || (() => (typeof document === "undefined" ? true : document.visibilityState === "visible"));
    this.state = "IDLE";
    this.reason = "READ_ONLY_DEFAULT";
    this.generation = 0;
    this.busy = false;
    this.controller = null;
    this.identity = null;
    this.lastRange = null;
    this.lastSnapshot = null;
    this.preview = null;
    this.activeKey = null;
    this.coordinator = env.coordinator || null;
    this.duplicateActionBlocked = 0;
    this.crossModeConflict = null;
    this.lastHttpDiag = null;
    this.logs = [];
  }

  iso() {
    return new Date(this.wall()).toISOString();
  }

  emit(state, code, details = {}) {
    this.state = state;
    this.reason = code;
    this.logs.push({ at: this.iso(), state, code, ...details });
    if (this.logs.length > 50) this.logs.shift();
    this.notify({ state, code, details });
  }

  ensure(generation) {
    check(generation === this.generation, "STOPPED");
  }

  clearSnapshot() {
    this.lastSnapshot = null;
    this.preview = null;
  }

  stop(reason = "STOPPED") {
    this.generation++;
    this.preview = null;
    this.controller?.abort();
    this.store.stopSignal?.();
    this.emit(this.state === "SUBMITTING" ? "UNKNOWN" : "STOPPED", reason);
  }

  suspend(reason = "FOREGROUND_REQUIRED") {
    if (this.busy || this.preview) this.stop(reason);
  }

  async run(fn) {
    if (this.busy) {
      this.duplicateActionBlocked++;
      check(false, "BUSY");
    }
    this.busy = true;
    this.controller = new AbortController();
    const generation = this.generation;
    try {
      return await fn(generation);
    } catch (error) {
      this.preview = null;
      const code = codeOf(error);
      const diag = this.lastHttpDiag || {};
      this.lastHttpDiag = null;
      this.emit(this.state === "SUBMITTING" ? "UNKNOWN" : "STOPPED", code, diag);
      throw error;
    } finally {
      this.busy = false;
      this.controller = null;
    }
  }

  async read(path, generation, form) {
    this.ensure(generation);
    let httpStatus = null;
    const endpoint = String(path).split("?")[0];
    try {
      const { body } = await this.io.request(path, {
        form,
        signal: this.controller.signal,
        onHeaders: (sample) => {
          httpStatus = sample?.status ?? null;
        },
      });
      this.ensure(generation);
      const code = responseCode(body);
      if (["LIMITED", "HTTP_404", "AUTH_REQUIRED"].includes(code)) {
        this.lastHttpDiag = { httpStatus, endpoint };
        check(false, code);
      }
      return body;
    } catch (error) {
      this.lastHttpDiag = { httpStatus, endpoint };
      throw error;
    }
  }

  async login(generation, timings = {}) {
    const start = this.mono();
    const body = await this.read("/User/Center/baseInfo", generation);
    const uid = body?.DATA?.uid;
    check(body?.DATA?.is_login === true && /^\d+$/.test(String(uid ?? "")), "AUTH_REQUIRED");
    const account = await accountKey(String(uid));
    this.ensure(generation);
    if (this.identity) check(this.identity.account === account, "IDENTITY_CHANGED");
    this.identity = { uid: String(uid), account };
    this.store.bind(account);
    timings.loginCheckMs = this.mono() - start;
    this.emit("READY_READ_ONLY", "LOGIN_OK");
    return this.identity;
  }

  async readRange(generation, timings = {}) {
    const start = this.mono();
    const query = roomQuery(await this.read("/Space/Category/list?LAB_JSON=1", generation));
    const body = await this.read(query, generation);
    this.emit("READY_READ_ONLY", "RANGE_SHAPE", { fields: inspectRange(body?.data?.range) });
    const range = parseRange(body?.data?.range);
    const group = category(body?.data);
    timings.catalogReadMs = this.mono() - start;
    this.lastRange = { range, group, at: this.wall() };
    this.emit("READY_READ_ONLY", "DATES_OK", {
      dates: range.dates,
      min: range.min,
      max: range.max,
      maxDateExclusive: range.maxDateExclusive,
    });
    return { range, group };
  }

  checkLogin() {
    return this.run(async (g) => {
      await this.login(g);
      return { valid: true };
    });
  }

  openDates() {
    return this.run(async (g) => {
      if (!this.identity) await this.login(g);
      return (await this.readRange(g)).range;
    });
  }

  async fetchRoomsSnapshot(slot, generation, timings = {}) {
    const identity = this.identity || (await this.login(generation, timings));
    const freshRange =
      this.lastRange && this.wall() - this.lastRange.at <= 120000
        ? this.lastRange
        : await this.readRange(generation, timings);
    const { range, group } = freshRange;
    const begin = validateSlotSelection({ date: slot.date, hour: slot.hour, hours: 1 }, range, this.wall());
    check(this.io.clockValid(), "CLOCK_UNVERIFIED");
    const start = this.mono();
    const mapBody = await this.read(
      "/Seat/Index/searchSeats?LAB_JSON=1",
      generation,
      new URLSearchParams({
        beginTime: String(begin),
        duration: String(P70_DURATION),
        num: "1",
        "space_category[category_id]": group.category_id,
        "space_category[content_id]": group.content_id,
      }),
    );
    timings.catalogReadMs = (timings.catalogReadMs || 0) + (this.mono() - start);
    const parseStart = this.mono();
    const rooms = resolveRoomsAndSeats(mapBody);
    timings.idResolutionMs = this.mono() - parseStart;
    const conflictStart = this.mono();
    const booked = records(await this.read(P70_RECORD_PATH, generation));
    timings.conflictReadMs = this.mono() - conflictStart;
    const conflictCount = slotConflicts(booked, { date: slot.date, hour: slot.hour, hours: 1 }).length;
    this.emit("READY_READ_ONLY", "SEATS_CHECKED", {
      roomCount: rooms.length,
      freeSeats: rooms.reduce((sum, r) => sum + r.freeCount, 0),
      conflicts: conflictCount,
    });
    const snap = {
      date: slot.date,
      hour: Number(slot.hour),
      at: this.wall(),
      identity,
      range,
      rooms,
      conflictCount,
      timings,
    };
    this.lastSnapshot = snap;
    return snap;
  }

  queryRooms(date, hour) {
    return this.run(async (g) => {
      const snap = await this.fetchRoomsSnapshot({ date, hour }, g);
      return { rooms: snap.rooms, conflicts: snap.conflictCount, range: snap.range };
    });
  }

  prepare(selection) {
    this.preview = null;
    return this.run(async (g) => {
      check(this.visible(), "FOREGROUND_REQUIRED");
      await this.store.probe();
      this.ensure(g);
      const reusable =
        this.lastSnapshot &&
        this.lastSnapshot.date === selection.date &&
        this.lastSnapshot.hour === Number(selection.hour) &&
        this.wall() - this.lastSnapshot.at <= P70_PREVIEW_TTL_MS;
      const snap = reusable ? this.lastSnapshot : await this.fetchRoomsSnapshot(selection, g);
      validateSlotSelection({ date: selection.date, hour: selection.hour, hours: 1 }, snap.range, this.wall());
      if (this.coordinator) {
        const conflict = await this.coordinator.checkForNormal(snap.identity.account, selection);
        if (conflict) {
          this.crossModeConflict = conflict;
          check(false, conflict.code);
        }
      }
      const pending = await this.store.pendingUnknown(snap.identity.account);
      check(!pending, "PREVIOUS_UNKNOWN");
      check(snap.conflictCount === 0, "EXISTING");
      const resolved = resolveSelectedSeat(snap.rooms, selection);
      check(resolved.seat.free, "SEAT_UNAVAILABLE");
      const target = {
        date: selection.date,
        hour: Number(selection.hour),
        hours: 1,
        floorId: resolved.floorId,
        room: resolved.room,
        seatNumber: resolved.seat.number,
        seatId: resolved.seat.id,
      };
      const key = slotKey(snap.identity.account, target);
      const existing = await this.store.get(key);
      check(!existing && !this.store.spent(key), "BUDGET_SPENT");
      this.ensure(g);
      this.preview = {
        ticket: safeRandomId(),
        key,
        account: snap.identity.account,
        uid: snap.identity.uid,
        range: snap.range,
        target,
        expires: Math.min(snap.at + P70_PREVIEW_TTL_MS, this.wall() + P70_PREVIEW_TTL_MS),
        timings: { ...snap.timings },
      };
      this.emit("AWAITING_CONFIRMATION", "AWAITING_CONFIRMATION");
      return this.preview;
    });
  }

  confirm(ticket, { details = false, rules = false } = {}) {
    return this.run(async (g) => {
      const preview = this.preview;
      check(preview && ticket === preview.ticket && details && rules, "CONFIRMATION_REQUIRED");
      this.preview = null;
      check(this.visible(), "FOREGROUND_REQUIRED");
      check(this.wall() <= preview.expires, "PREVIEW_EXPIRED");
      await this.store.probe();
      this.ensure(g);
      if (this.coordinator) {
        const conflict = await this.coordinator.checkForNormal(preview.account, preview.target);
        if (conflict) {
          this.crossModeConflict = conflict;
          check(false, conflict.code);
        }
      }
      const pending = await this.store.pendingUnknown(preview.account);
      check(!pending, "PREVIOUS_UNKNOWN");
      const prior = await this.store.get(preview.key);
      if (prior || this.store.spent(preview.key)) {
        this.activeKey = preview.key;
        this.emit(prior?.state || "UNKNOWN", "BUDGET_SPENT");
        return prior || { key: preview.key, state: "UNKNOWN", reason: "BUDGET_SPENT", attempts: 1 };
      }

      // Reuse the verified seat snapshot from Step 3 without re-calling POST /Seat/Index/searchSeats,
      // preventing unnecessary seat-map POST rate limits while preserving strict single-write protection.
      validateSlotSelection(preview.target, preview.range, this.wall());
      check(this.io.clockValid(), "CLOCK_UNVERIFIED");

      const localStart = this.mono();
      const timings = { ...preview.timings };
      const intent = {
        key: preview.key,
        ticket,
        version: P70_VERSION,
        target: preview.target,
        state: "UNKNOWN",
        reason: "WRITE_INTENT_PERSISTED",
        attempts: 1,
        recordVerified: false,
        timings,
        logs: this.logs.slice(-50),
      };
      const claim = await this.store.claim(intent);
      this.activeKey = preview.key;
      if (!claim.won) {
        this.emit(claim.value?.state || "UNKNOWN", "BUDGET_SPENT");
        return claim.value;
      }

      let reason = "STOPPED";
      let verifiedRecord = false;
      let verificationReadSucceeded = false;
      try {
        this.ensure(g);
        check(this.visible(), "FOREGROUND_REQUIRED");
        check(this.wall() <= preview.expires, "PREVIEW_EXPIRED");
        const request = signedRequest(
          preview.target.seatId,
          preview.uid,
          slotBeginTime(preview.target),
          Math.floor(this.wall() / 1000),
          P70_DURATION,
        );
        timings.preSubmitLocalMs = this.mono() - localStart;
        this.emit("SUBMITTING", "SUBMITTING_ONCE");
        const response = await this.io.request(BOOK_PATH, {
          ...request,
          write: true,
          signal: this.controller.signal,
          onDispatch: (at) => {
            timings.firstDispatchAt = at;
          },
          onHeaders: (sample) => {
            timings.firstResponseAt = sample.timing?.responseAt || this.iso();
            timings.dispatchToHeadersMs = sample.timing?.dispatchToHeadersMs;
          },
          onBusiness: (body, t) => {
            timings.firstBusinessResultAt = t.businessResultAt || this.iso();
            timings.bodyDecodeMs = t.bodyDecodeMs;
          },
        });
        timings.totalRequestMs = response.timing?.totalRequestMs ?? null;
        reason = responseCode(response.body);
        timings.responseCode = reason;
      } catch (error) {
        reason = codeOf(error);
        timings.responseCode = reason;
        if (error.timing?.totalRequestMs != null) timings.totalRequestMs = error.timing.totalRequestMs;
      }

      // Never retry POST and never auto-switch seats. At most 1 automatic official record check.
      if (g === this.generation && !["LIMITED", "AUTH_REQUIRED"].includes(reason)) {
        const canVerify = await this.store.takeVerification(preview.key, this.wall());
        if (canVerify) {
          const vStart = this.mono();
          try {
            const items = records(await this.read(P70_RECORD_PATH, g));
            verificationReadSucceeded = true;
            verifiedRecord = verifiedSlot(items, preview.target);
            if (verifiedRecord) timings.firstRecordVerifiedAt = this.iso();
          } catch {
            verificationReadSucceeded = false;
          }
          timings.verificationMs = this.mono() - vStart;
        }
      }

      const state = verifiedRecord
        ? "SUCCESS"
        : ["LIMITED", "AUTH_REQUIRED"].includes(reason) || (verificationReadSucceeded && REJECTED.has(reason))
          ? "FAILED"
          : "UNKNOWN";
      const finalReason = verifiedRecord ? "RECORD_VERIFIED" : reason;
      this.emit(state, finalReason);
      const saved = await this.store.finish(preview.key, ticket, {
        state,
        reason: finalReason,
        recordVerified: verifiedRecord,
        timings,
        logs: this.logs.slice(-50),
      });
      return saved;
    });
  }

  review(key = this.activeKey) {
    return this.run(async (g) => {
      const identity = this.identity || (await this.login(g));
      const rows = await this.store.list(identity.account);
      let row = key ? rows.find((r) => r.key === key) : null;
      if (!row && rows.length) {
        row = rows.find((r) => r.state === "UNKNOWN") || rows[rows.length - 1];
      }
      if (!row) {
        this.emit("IDLE", "NO_ATTEMPT");
        return { state: "IDLE", reason: "NO_ATTEMPT", attempts: 0 };
      }
      this.activeKey = row.key;
      if (row.state === "SUCCESS") {
        this.emit("SUCCESS", "REVIEW_SAVED_RESULT");
        await this.store.noteReview(row.key, this.iso(), this.logs);
        return row;
      }
      const allowed = await this.store.takeVerification(row.key, this.wall());
      if (!allowed) {
        this.emit(row.state, "READ_CHECK_LIMIT_OR_ERROR");
        await this.store.noteReview(row.key, this.iso(), this.logs);
        return row;
      }
      const vStart = this.mono();
      const items = records(await this.read(P70_RECORD_PATH, g));
      const vMs = this.mono() - vStart;
      if (verifiedSlot(items, row.target)) {
        const at = this.iso();
        this.emit("SUCCESS", "RECORD_VERIFIED");
        const updated = await this.store.finish(row.key, row.ticket, {
          state: "SUCCESS",
          reason: "RECORD_VERIFIED",
          recordVerified: true,
          lastReviewedAt: at,
          timings: { firstRecordVerifiedAt: row.timings?.firstRecordVerifiedAt || at, verificationMs: vMs },
          logs: this.logs.slice(-50),
        });
        return updated;
      }
      this.emit(row.state === "FAILED" ? "FAILED" : "UNKNOWN", "RECORD_NOT_VERIFIED");
      await this.store.noteReview(row.key, this.iso(), this.logs);
      return await this.store.get(row.key);
    });
  }

  async listRecent() {
    if (!this.identity) return [];
    const rows = await this.store.list(this.identity.account);
    return rows.slice(-7).reverse();
  }

  async diagnosticExport() {
    let rows = [];
    if (this.identity) rows = await this.store.list(this.identity.account);
    const active = (this.activeKey && rows.find((r) => r.key === this.activeKey)) || rows[rows.length - 1] || null;
    return {
      version: P70_VERSION,
      platform: "ipad-safari-userscripts",
      current: publicIpadDiagnostics(
        active || {
          version: P70_VERSION,
          state: this.state,
          reason: this.reason,
          attempts: 0,
          logs: this.logs,
        },
      ),
      duplicateActionBlocked: this.duplicateActionBlocked,
      crossModeConflict: this.crossModeConflict,
      recent: rows.slice(-7).reverse().map(publicIpadDiagnostics),
    };
  }
}

  // --- src/userscript/p70/panel.js ---
const P70_MESSAGES = {
  READ_ONLY_DEFAULT: "默认只读；请先检查登录并读取开放日期。",
  LOGIN_OK: "官网登录有效（账号信息不展示）。",
  AUTH_REQUIRED: "登录已失效，请在官网正常登录后重新检查。",
  RANGE_SHAPE: "已记录馆方日期字段脱敏结构。",
  DATES_OK: "已读取开放日期与允许时段，请选择日期与1小时时段后查询空位。",
  DATE_CONTRACT_UNKNOWN: "日期字段格式尚不支持，已禁止提交。",
  CLOCK_UNVERIFIED: "设备与服务器时钟偏差过大或无法核对，请检查iPad自动日期与时间设置。",
  ONE_HOUR_NOT_ALLOWED: "馆方当前不允许该1小时预约规则。",
  SEATS_CHECKED: "已读取房间与当前空余座位，请选择空闲座位并点击准备预约方案。",
  SEAT_REQUIRED: "请先选择一个当前空余座位。",
  SEAT_UNAVAILABLE: "所选座位已不可预约，已停止。不会自动换座。",
  EXISTING: "该时段已有冲突预约，禁止重复提交。",
  PREVIOUS_UNKNOWN: "存在未决提交记录，已禁止新预约。请先点“查看官方结果”核验或人工检查官网。",
  CROSS_MODE_ACTIVE_TASK: "整点预约模式正在待命或执行，普通模式已互斥阻断。",
  CROSS_MODE_UNKNOWN: "整点预约模式存在未决(UNKNOWN)记录，请先在整点模式核验官方记录。",
  CROSS_MODE_CONFLICT: "整点模式已占用同日期任务，普通模式已互斥阻断。",
  AWAITING_CONFIRMATION: "方案已就绪（5分钟内有效），真实提交仍关闭；请核对后双勾选确认。",
  SUBMITTING_ONCE: "正在提交唯一一次预约请求，请保持Safari在前台且屏幕唤醒。",
  RECORD_VERIFIED: "预约成功：已通过官方记录核验房间、座位、日期与1小时时长。",
  REVIEW_SAVED_RESULT: "已核验成功的预约记录，不重复提交。",
  RECORD_NOT_VERIFIED: "官方记录暂未匹配到本次预约，请查看官网“我的预约”；不会自动重发。",
  READ_CHECK_LIMIT_OR_ERROR: "核验次数已达上限或间隔不足2秒，请直接查看官网“我的预约”。",
  UNKNOWN: "结果待确认，已停止且不会自动重发，请先点“查看官方结果”或核对官网。",
  STOPPED: "当前任务已停止；若已发出提交请求，停止不会撤销预约。",
  FOREGROUND_REQUIRED: "页面离开前台，操作已中止；不会自动恢复提交。",
  LIMITED: "馆方限流或拒绝访问，已停止。",
  BUDGET_SPENT: "该时段座位已使用过单次提交额度，请查看官方结果；不会重复提交。",
  PREVIEW_EXPIRED: "预约方案已超过5分钟有效期，请重新准备。",
  CONFIRMATION_REQUIRED: "请先准备方案，并手动勾选两项确认后再提交。",
  IDENTITY_CHANGED: "登录账号已变化，已停止。",
  MAPPING_CHANGED: "房间或座位映射发生变化，已禁止提交，请重新查询。",
  DATE_OR_TIME_NOT_OPEN: "所选日期或时段未开放，或开始时间已过。",
  INVALID_TIME: "请选择馆方允许的未来整点1小时时段。",
  STORAGE_UNAVAILABLE: "Safari本地存储（IndexedDB/localStorage）不可用，禁止提交。请关闭无痕浏览并检查权限。",
  HTTP_404: "接口返回404，已停止；若发生在提交阶段，请先核验官方记录。",
  TIMEOUT: "请求超时，已停止；若发生在提交阶段，不得自动重发，请核验官方记录。",
  NETWORK_ERROR: "网络异常，已停止；若发生在提交阶段，请核验官方记录。",
  RESPONSE_UNKNOWN: "接口响应无法解析，已停止。",
  NO_ATTEMPT: "本机尚无P7.0提交记录。",
  BUSY: "当前操作进行中，请等待或点击停止。",
  LOCAL_ERROR: "本机处理异常，已停止；如已提交请先核对官方记录。",
};

const P70_TONES = {
  IDLE: ["iPad P7.0 · 待机", "idle"],
  READY_READ_ONLY: ["iPad P7.0 · 只读", "active"],
  AWAITING_CONFIRMATION: ["iPad P7.0 · 待确认", "active"],
  SUBMITTING: ["iPad P7.0 · 提交中", "active"],
  SUCCESS: ["iPad P7.0 · 已成功", "success"],
  FAILED: ["iPad P7.0 · 未成功", "failed"],
  UNKNOWN: ["iPad P7.0 · 待核验", "unknown"],
  STOPPED: ["iPad P7.0 · 已停止", "stopped"],
};
function mountIpadPanel(engine) {
  const host = document.createElement("div");
  host.id = "hdu-p70-host";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
    :host{all:initial;position:fixed;right:max(12px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom));z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:#142636;font-size:15px;line-height:1.45}
    *{box-sizing:border-box}[hidden]{display:none!important}
    button,input,select,textarea{font-family:inherit;font-size:16px}
    button,select,input[type=checkbox]{touch-action:manipulation}
    button{min-height:44px;padding:8px 12px;border:1px solid #9db0be;border-radius:10px;background:#fff;color:#142636;cursor:pointer}
    button:disabled{opacity:.5;cursor:default}
    #toggle{float:right;background:#154c79;color:#fff;border:0;font-weight:600;box-shadow:0 4px 14px rgba(0,0,0,.22)}
    #toggle[data-tone=success]{background:#17633b}#toggle[data-tone=failed]{background:#a0212b}#toggle[data-tone=unknown]{background:#945008}#toggle[data-tone=stopped]{background:#59646b}
    #panel{clear:both;width:min(400px,calc(100vw - 24px));max-height:min(76vh,calc(100dvh - 88px));overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;background:#f8fafc;border:1px solid #9db0be;border-radius:14px;padding:14px;margin-bottom:8px;box-shadow:0 8px 28px rgba(0,0,0,.2);overflow-wrap:anywhere}
    h2{font-size:18px;margin:0 0 6px}p{margin:6px 0}.hint{font-size:13px;color:#466070}
    #status{padding:9px 10px;border-radius:8px;background:#e6f0f8;font-weight:500}
    .grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 0}
    .fields{display:grid;gap:8px;margin:8px 0}
    label{display:block;font-size:14px}
    select{width:100%;min-height:44px;margin-top:4px;padding:8px 10px;border:1px solid #94a3b8;border-radius:8px;background:#fff;color:#142636}
    .confirm{margin:10px 0;padding:10px;border:1px solid #cbd5e1;border-radius:10px;background:#fff}
    .confirm label{display:flex;gap:8px;align-items:flex-start;margin:8px 0}
    input[type=checkbox]{width:22px;height:22px;flex:none;margin-top:2px}
    #preview{font-weight:600;color:#142636}
    #submit{width:100%;background:#154c79;color:#fff;border:0;font-weight:600}
    #stop{border-color:#a52727;color:#a52727}
    #roomMeta{font-size:13px;color:#334e60;white-space:pre-wrap}
    textarea{width:100%;height:170px;margin-top:8px;padding:8px;border:1px solid #94a3b8;border-radius:8px;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;background:#fff;color:#142636}
    a{color:#154c79;font-weight:500}
  </style>
  <section id="panel" hidden aria-label="P7.0 iPad 原生预约验证">
    <h2>P7.0 iPad 原生预约 · Phase 1</h2>
    <p class="hint">Safari + Userscripts 单次空余座位预约验证（1小时 / 1人）。不含20:00抢座、不自动重试、不伪造旧凭据。</p>
    <p id="status" role="status" aria-live="polite">${P70_MESSAGES.READ_ONLY_DEFAULT}</p>
    <div class="grid2"><button id="login">1. 检查登录</button><button id="dates">2. 读取开放日期</button></div>
    <div class="fields">
      <label>预约日期（北京时间）<select id="date"><option value="">请先读取开放日期</option></select></label>
      <label>1小时时段<select id="hour"><option value="">请先选择日期</option></select></label>
    </div>
    <div class="grid2"><button id="query">3. 查询房间与空位</button><button id="prepare" disabled>4. 准备预约方案</button></div>
    <div class="fields">
      <label>选择房间<select id="room" disabled><option value="">请先查询房间与空位</option></select></label>
      <label>当前空余座位<select id="seat" disabled><option value="">请先选择房间</option></select></label>
    </div>
    <p id="roomMeta"></p>
    <div class="confirm">
      <p id="preview">尚未准备预约方案</p>
      <label><input id="details" type="checkbox" disabled><span>我确认上述房间、空余座位、日期及1小时时段，本人实际使用。</span></label>
      <label><input id="rules" type="checkbox" disabled><span>我已确认馆方允许本次正常预约，并授权最多一次正式提交。</span></label>
      <button id="submit" disabled>5. 确认提交一次预约</button>
    </div>
    <div class="grid2">
      <button id="review">查看官方结果</button>
      <button id="stop">停止任务</button>
      <button id="toggleLogs">显示/隐藏日志</button>
      <button id="copy">复制脱敏日志</button>
    </div>
    <p class="hint"><a href="${ORIGIN}/#!/Seat/Index/myBookingList" target="_blank" rel="noopener noreferrer">打开官方“我的预约”</a> · <span id="copyStatus"></span></p>
    <textarea id="logText" readonly hidden aria-label="脱敏JSON日志"></textarea>
  </section>
  <button id="toggle" aria-expanded="false" data-tone="idle">iPad P7.0 · 待机</button>`;

  const el = (id) => root.getElementById(id);
  let range = null;
  let rooms = [];
  let preview = null;
  let uiBusy = false;
  let destroyed = false;

  const attach = () => {
    if (!destroyed && location.origin === ORIGIN && !host.isConnected)
      (document.documentElement || document.body)?.append(host);
  };
  attach();

  const observer = new MutationObserver(() => {
    if (!destroyed && location.origin === ORIGIN && !host.isConnected) attach();
  });
  observer.observe(document, { childList: true, subtree: true });

  const setTone = (state, code) => {
    const [label, tone] = P70_TONES[state] || P70_TONES.UNKNOWN;
    el("toggle").textContent = label;
    el("toggle").dataset.tone = tone;
    el("status").textContent = P70_MESSAGES[code] || `状态：${code}（请查看脱敏日志）`;
  };

  const clearPreview = () => {
    preview = null;
    el("details").checked = false;
    el("rules").checked = false;
    el("details").disabled = true;
    el("rules").disabled = true;
    el("submit").disabled = true;
    el("preview").textContent = "尚未准备预约方案";
  };

  const syncPrepareBtn = () => {
    el("prepare").disabled = uiBusy || !el("date").value || el("hour").value === "" || !el("room").value || !el("seat").value;
  };

  const syncConfirmBtn = () => {
    el("submit").disabled = uiBusy || !preview || !el("details").checked || !el("rules").checked;
  };

  const renderHours = () => {
    const old = el("hour").value;
    el("hour").replaceChildren();
    if (!range || !el("date").value) {
      el("hour").append(new Option("请先选择日期", ""));
      return;
    }
    let count = 0;
    for (let h = range.min; h < range.max; h++) {
      const startMs = Date.parse(`${el("date").value}T${String(h).padStart(2, "0")}:00:00+08:00`);
      if (startMs <= Date.now()) continue;
      el("hour").append(new Option(`${String(h).padStart(2, "0")}:00–${String(h + 1).padStart(2, "0")}:00`, String(h)));
      count++;
    }
    if (!count) el("hour").append(new Option("当日已无可约未来时段", ""));
    else if ([...el("hour").options].some((o) => o.value === old)) el("hour").value = old;
  };

  const renderSeatsForRoom = () => {
    const floorId = Number(el("room").value);
    const room = rooms.find((r) => r.floorId === floorId);
    el("seat").replaceChildren();
    if (!room) {
      el("seat").append(new Option("请先选择房间", ""));
      el("seat").disabled = true;
      syncPrepareBtn();
      return;
    }
    const freeSeats = room.seats.filter((s) => s.free);
    if (!freeSeats.length) {
      el("seat").append(new Option("该房间此时段无空余座位", ""));
      el("seat").disabled = true;
    } else {
      for (const s of freeSeats) el("seat").append(new Option(`${s.number}号（空闲）`, s.id));
      el("seat").disabled = uiBusy;
    }
    syncPrepareBtn();
  };

  const refreshLogs = async () => {
    try {
      el("logText").value = JSON.stringify(await engine.diagnosticExport(), null, 2);
    } catch {
      el("logText").value = JSON.stringify({ version: "7.0.2-phase1", error: "EXPORT_FAILED" });
    }
  };

  engine.notify = ({ state, code }) => {
    setTone(state, code);
    if (!el("logText").hidden) void refreshLogs();
  };

  const currentSelection = () => {
    const floorId = Number(el("room").value);
    const room = rooms.find((r) => r.floorId === floorId);
    const seat = room?.seats.find((s) => s.id === el("seat").value);
    return {
      date: el("date").value,
      hour: el("hour").value === "" ? -1 : Number(el("hour").value),
      hours: 1,
      floorId,
      room: room?.room || "",
      seatId: seat?.id || "",
      seatNumber: seat?.number || "",
    };
  };

  const runAction = async (work, keepPreview = false) => {
    if (uiBusy) return;
    uiBusy = true;
    if (!keepPreview) clearPreview();
    const controls = ["login", "dates", "query", "prepare", "review", "date", "hour", "room", "seat"];
    for (const id of controls) el(id).disabled = true;
    el("submit").disabled = true;
    try {
      await work();
    } catch (e) {
      clearPreview();
      setTone(engine.state === "SUBMITTING" ? "UNKNOWN" : "STOPPED", codeOf(e));
    } finally {
      uiBusy = false;
      for (const id of ["login", "dates", "query", "review", "date", "hour"]) el(id).disabled = false;
      el("room").disabled = rooms.length === 0;
      el("seat").disabled = rooms.length === 0 || el("seat").options.length === 0 || !el("seat").value;
      syncPrepareBtn();
      syncConfirmBtn();
    }
  };

  const trusted = (fn) => (event) => {
    if (event.isTrusted) void fn();
  };

  el("toggle").onclick = trusted(() => {
    el("panel").hidden = !el("panel").hidden;
    el("toggle").setAttribute("aria-expanded", String(!el("panel").hidden));
  });

  el("login").onclick = trusted(() => runAction(() => engine.checkLogin()));

  el("dates").onclick = trusted(() =>
    runAction(async () => {
      range = await engine.openDates();
      el("date").replaceChildren();
      const openDates = range.dates.filter((d) => d >= shanghaiDate());
      if (!openDates.length) el("date").append(new Option("暂无开放日期", ""));
      else for (const d of openDates) el("date").append(new Option(d, d));
      renderHours();
    }),
  );

  el("query").onclick = trusted(() =>
    runAction(async () => {
      const data = await engine.queryRooms(el("date").value, Number(el("hour").value));
      rooms = data.rooms;
      el("room").replaceChildren();
      for (const r of rooms)
        el("room").append(new Option(`${r.room}（空闲 ${r.freeCount}/${r.totalCount}）`, String(r.floorId)));
      renderSeatsForRoom();
      const totalFree = rooms.reduce((s, r) => s + r.freeCount, 0);
      el("roomMeta").textContent = `共读取 ${rooms.length} 个房间，当前空闲座位 ${totalFree} 个；此时段已有冲突预约：${data.conflicts}`;
    }),
  );

  el("prepare").onclick = trusted(() =>
    runAction(async () => {
      preview = await engine.prepare(currentSelection());
      el("preview").textContent = slotSummary(preview.target);
      el("details").disabled = false;
      el("rules").disabled = false;
      syncConfirmBtn();
    }),
  );

  el("details").onchange = el("rules").onchange = syncConfirmBtn;

  el("submit").onclick = (event) => {
    if (!event.isTrusted) {
      setTone("STOPPED", "CONFIRMATION_REQUIRED");
      return;
    }
    void runAction(async () => {
      const p = preview;
      const perms = { details: el("details").checked, rules: el("rules").checked };
      clearPreview();
      const result = await engine.confirm(p?.ticket, perms);
      if (result?.target) el("preview").textContent = slotSummary(result.target);
      await refreshLogs();
    }, true);
  };

  el("review").onclick = trusted(() =>
    runAction(async () => {
      const result = await engine.review();
      if (result?.target) el("preview").textContent = slotSummary(result.target);
      await refreshLogs();
    }),
  );

  el("stop").onclick = trusted(() => {
    engine.stop("STOPPED");
    clearPreview();
  });

  el("date").onchange = () => {
    engine.clearSnapshot?.();
    clearPreview();
    renderHours();
    rooms = [];
    el("room").replaceChildren(new Option("日期已变，请重新查询房间与空位", ""));
    el("seat").replaceChildren(new Option("请先查询房间与空位", ""));
    el("room").disabled = true;
    el("seat").disabled = true;
    el("roomMeta").textContent = "";
    syncPrepareBtn();
  };

  el("hour").onchange = () => {
    engine.clearSnapshot?.();
    clearPreview();
    rooms = [];
    el("room").replaceChildren(new Option("时段已变，请重新查询房间与空位", ""));
    el("seat").replaceChildren(new Option("请先查询房间与空位", ""));
    el("room").disabled = true;
    el("seat").disabled = true;
    el("roomMeta").textContent = "";
    syncPrepareBtn();
  };

  el("room").onchange = () => {
    clearPreview();
    renderSeatsForRoom();
  };

  el("seat").onchange = () => {
    clearPreview();
    syncPrepareBtn();
  };

  el("toggleLogs").onclick = trusted(async () => {
    await refreshLogs();
    el("logText").hidden = !el("logText").hidden;
  });

  el("copy").onclick = trusted(async () => {
    await refreshLogs();
    el("logText").hidden = false;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(el("logText").value);
        el("copyStatus").textContent = "脱敏日志已复制";
        return;
      } catch {
        /* Safari gesture fallback */
      }
    }
    el("logText").focus();
    el("logText").select();
    el("copyStatus").textContent = "请长按下方文本框全选复制";
  });

  return {
    root,
    host,
    destroy() {
      destroyed = true;
      observer.disconnect();
      host.remove();
    },
  };
}

  // --- src/userscript/p71/coordinator.js ---
// Cross-mode guard uniting P7.0 normal mode (hdu-p70-ipad-booking) and P7.1 scheduled mode (hdu-p71-ipad-scheduled).
// Never clears databases or resets attempt/verification counts.
class CrossModeCoordinator {
  constructor() {
    this.normalStore = null;
    this.scheduledStore = null;
    this.normalEngine = null;
    this.scheduledEngine = null;
  }

  attachNormal(engine, store) {
    this.normalEngine = engine;
    this.normalStore = store;
  }

  attachScheduled(engine, store) {
    this.scheduledEngine = engine;
    this.scheduledStore = store;
  }

  async checkForScheduled(account) {
    if (this.normalEngine && (this.normalEngine.busy || this.normalEngine.state === "SUBMITTING")) {
      return { blockedByMode: "normal-p70", code: "CROSS_MODE_ACTIVE_TASK" };
    }
    if (this.normalStore && account) {
      const pending = await this.normalStore.pendingUnknown(account);
      if (pending) return { blockedByMode: "normal-p70", code: "CROSS_MODE_UNKNOWN" };
    }
    return null;
  }

  async checkForNormal(account, selection = null) {
    if (
      this.scheduledEngine &&
      (this.scheduledEngine.formal ||
        this.scheduledEngine.waiting ||
        this.scheduledEngine.busy ||
        ["PREPARING", "WAITING", "SUBMITTING", "VERIFYING"].includes(this.scheduledEngine.state))
    ) {
      return { blockedByMode: "scheduled-p71", code: "CROSS_MODE_ACTIVE_TASK" };
    }
    if (this.scheduledStore && account) {
      const pending = await this.scheduledStore.pendingUnknown(account);
      if (pending) return { blockedByMode: "scheduled-p71", code: "CROSS_MODE_UNKNOWN" };
      if (selection?.date) {
        const rows = await this.scheduledStore.list(account);
        const activeOnDate = rows.find(
          (r) => r.target?.date === selection.date && ["WAITING", "UNKNOWN"].includes(r.state),
        );
        if (activeOnDate) return { blockedByMode: "scheduled-p71", code: "CROSS_MODE_CONFLICT" };
      }
    }
    return null;
  }

  async assertAllowedForScheduled(account) {
    const conflict = await this.checkForScheduled(account);
    check(!conflict, conflict?.code || "CROSS_MODE_CONFLICT");
  }

  async assertAllowedForNormal(account, selection = null) {
    const conflict = await this.checkForNormal(account, selection);
    check(!conflict, conflict?.code || "CROSS_MODE_CONFLICT");
  }
}

  // --- src/userscript/p71/policy.js ---
const P71_VERSION = "7.1.1";
const P71_SEAT = Object.freeze({
  seat: "162",
  seatId: "62726",
  floorId: 1558,
  room: "宋韵云图（四楼）",
});
const P71_PREPARE_MS = 300000; // 19:55:00 to 20:00:00
const P71_RECALIBRATE_BEFORE_MS = 45000; // 19:59:15 automatic fresh clock sample
const P71_SAMPLE_MAX_AGE_MS = 60000; // reject stale samples older than 60s
const P71_LATE_MS = 10000; // conservative 20:00:00–20:00:10 window
const P71_TIMER_DRIFT_MAX_MS = 1500; // detect Safari tab suspension / lock-screen stall
const P71_STATIC_CACHE_TTL_MS = 15 * 60 * 1000; // 15-minute session-only static catalog/mapping cache
const P71_REHEARSAL_DEDUPE_MS = 30000; // prevent duplicate back-to-back rehearsal bursts
const P71_RECORD_PATH = P70_RECORD_PATH;

const p71Scalar = (v) => (typeof v === "string" || typeof v === "number" ? String(v) : "");
function scheduledTask(now = Date.now(), startHour = 8, endHour = 22) {
  check(Number.isSafeInteger(now), "INVALID_TIME");
  const sh = integer(startHour);
  const eh = integer(endHour);
  check(sh >= 0 && eh <= 24 && sh < eh, "INVALID_DURATION");
  const day = shanghaiDate(now);
  const midnight = rangeMidnight(day);
  const date = shanghaiDate(midnight + 2 * 86400000);
  const targetMidnight = rangeMidnight(date);
  const hours = eh - sh;
  const duration = hours * 3600;
  const begin = targetMidnight / 1000 + sh * 3600;
  const end = begin + duration;
  return Object.freeze({
    ...P71_SEAT,
    day,
    date,
    open: midnight + 20 * 3600000,
    startHour: sh,
    endHour: eh,
    hours,
    duration,
    begin,
    end,
  });
}
function validateScheduledTask(task) {
  check(task && typeof task === "object", "TASK_INVALID");
  const canonical = scheduledTask(task.open, task.startHour, task.endHour);
  for (const key of Object.keys(canonical)) check(task[key] === canonical[key], "TASK_INVALID");
  check(
    task.begin + task.duration === Date.parse(`${task.date}T${String(task.endHour).padStart(2, "0")}:00:00+08:00`) / 1000,
    "INVALID_DURATION",
  );
}
function scheduledTaskKey(account, task) {
  return `${account}:${task.date}:162`;
}
function scheduledTimeLabel(task) {
  const s = String(task.startHour).padStart(2, "0");
  const e = String(task.endHour).padStart(2, "0");
  return `${s}:00—${e}:00`;
}
function validateScheduledRange(raw, now, task) {
  const range = parseRange(raw);
  const minDur = integer(raw.min_duration);
  const maxDur = integer(raw.max_duration);
  check(
    task.startHour >= range.min &&
      task.endHour <= range.max &&
      task.hours >= minDur &&
      task.hours <= maxDur,
    "DURATION_NOT_ALLOWED",
  );
  // Pre-release: target date must be either already open or the exact first excluded date (max_date).
  check(range.dates.includes(task.date) || range.maxDateExclusive === task.date, "DATE_RULE_MISMATCH");
  check(rangeMidnight(raw.advance_date) <= task.begin * 1000, "DATE_RULE_MISMATCH");
  for (const date of range.dates) {
    for (let hour = range.min; hour + 1 <= range.max; hour++) {
      const begin = rangeMidnight(date) / 1000 + hour * 3600;
      if (begin * 1000 > now + 60000) return { ...range, minDur, maxDur, mapBegin: begin, mapDate: date };
    }
  }
  check(false, "NO_LEGAL_MAPPING_SLOT");
}

// First excluded date is valid preflight evidence, never an open-date permit.
function openingScheduledRange(raw, task) {
  const range = parseRange(raw);
  const minDur = integer(raw.min_duration);
  const maxDur = integer(raw.max_duration);
  check(
    task.startHour >= range.min &&
      task.endHour <= range.max &&
      task.hours >= minDur &&
      task.hours <= maxDur,
    "DURATION_NOT_ALLOWED",
  );
  const open = range.dates.includes(task.date);
  check(open || range.maxDateExclusive === task.date, "DATE_RULE_MISMATCH");
  return { open, maxDateExclusive: range.maxDateExclusive };
}
function resolveScheduled162(body) {
  const floors = body?.allContent?.children?.[2]?.children?.children;
  check(Array.isArray(floors), "SEAT_RESPONSE_UNKNOWN");
  const rooms = floors.filter((f) => roomMatches(f.roomName));
  check(rooms.length === 1, "ROOM_NOT_UNIQUE");
  const room = rooms[0];
  check(
    integer(room.seatMap?.info?.id) === P71_SEAT.floorId && Array.isArray(room.seatMap?.POIs),
    "MAPPING_INVALID",
  );
  const seats = room.seatMap.POIs.filter((p) => p71Scalar(p.title).trim() === P71_SEAT.seat);
  check(seats.length === 1 && p71Scalar(seats[0].id).trim() === P71_SEAT.seatId, "MAPPING_INVALID");
  check(
    room.seatMap.POIs.filter((p) => p71Scalar(p.id).trim() === P71_SEAT.seatId).length === 1,
    "MAPPING_INVALID",
  );
  return { floorId: P71_SEAT.floorId, room: room.roomName, number: P71_SEAT.seat, id: P71_SEAT.seatId };
}
function validateStaticCacheEntry(entry, { account, day, date, group, now }) {
  if (!entry) return { valid: false, reason: "MISSING", ageMs: null };
  const ageMs = now - entry.verifiedAt;
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > P71_STATIC_CACHE_TTL_MS)
    return { valid: false, reason: "EXPIRED", ageMs: Number.isFinite(ageMs) ? ageMs : null };
  if (entry.account !== account) return { valid: false, reason: "ACCOUNT_CHANGED", ageMs };
  if (entry.day !== day || entry.date !== date) return { valid: false, reason: "TARGET_CHANGED", ageMs };
  if (group) {
    if (
      !entry.mapping ||
      entry.mapping.floorId !== P71_SEAT.floorId ||
      entry.mapping.number !== P71_SEAT.seat ||
      entry.mapping.id !== P71_SEAT.seatId
    )
      return { valid: false, reason: "MAPPING_MISSING", ageMs };
    if (entry.categoryId !== group.category_id || entry.contentId !== group.content_id)
      return { valid: false, reason: "CATEGORY_CHANGED", ageMs };
  } else if (!entry.roomQuery || !entry.roomQuery.startsWith("/Seat/Index/searchSeats?")) {
    return { valid: false, reason: "ROOM_QUERY_MISSING", ageMs };
  }
  return { valid: true, reason: "VALID", ageMs };
}
function scheduledOverlaps(items, task) {
  return items.filter((r) => {
    const status = p71Scalar(r.status);
    if (["3", "4", "5", "6", "7", "9"].includes(status)) return false;
    check(["0", "1", "2"].includes(status), "RECORDS_UNKNOWN");
    const begin = integer(r.time);
    const duration = integer(r.duration);
    check(
      begin > 0 && duration > 0 && duration <= 86400 && Number.isSafeInteger(begin + duration),
      "RECORDS_UNKNOWN",
    );
    return begin < task.begin + task.duration && begin + duration > task.begin;
  });
}
function verifiedScheduled162(items, mapping, task) {
  return scheduledOverlaps(items, task).some(
    (r) =>
      integer(r.time) === task.begin &&
      integer(r.duration) === task.duration &&
      p71Scalar(r.seatNum).trim() === task.seat &&
      r.roomName === mapping.room &&
      (r.seatId === undefined || p71Scalar(r.seatId).trim() === task.seatId),
  );
}

// Reuses proven md5() & BOOK_PATH contract from core.js; supports validated custom whole-hour durations.
function signedScheduledRequest(seatId, uid, begin, apiTime, duration) {
  check(
    Number.isSafeInteger(duration) && duration >= 3600 && duration <= 86400 && duration % 3600 === 0,
    "INVALID_DURATION",
  );
  const source = `post&${BOOK_PATH}&api_time${apiTime}&beginTime${begin}&duration${duration}&is_recommend0&seatBookers[0]${uid}&seats[0]${seatId}`;
  return {
    token: btoa(md5(source)),
    form: new URLSearchParams({
      beginTime: String(begin),
      duration: String(duration),
      is_recommend: "0",
      api_time: String(apiTime),
      "seats[0]": seatId,
      "seatBookers[0]": uid,
    }),
  };
}
class ScheduledClock {
  constructor(wall = () => Date.now(), mono = () => performance.now(), task) {
    this.wall = wall;
    this.mono = mono;
    this.task = task;
    this.sample = null;
  }

  observe(sample) {
    const server = Date.parse(sample.date);
    const rtt = sample.receivedMono - sample.sentMono;
    check(
      Number.isFinite(server) && server % 1000 === 0 && (!sample.age || sample.age === "0"),
      "CLOCK_UNVERIFIED",
    );
    check(rtt >= 0 && rtt <= 2000 && Math.abs(sample.receivedWall - server) <= 5000, "CLOCK_UNVERIFIED");
    this.sample = { ...sample, server, rtt };
  }

  sampleAgeMs() {
    if (!this.sample) return Infinity;
    return this.mono() - this.sample.receivedMono;
  }

  bounds(maxAgeMs = P71_SAMPLE_MAX_AGE_MS) {
    const s = this.sample;
    check(s, "CLOCK_UNVERIFIED");
    const elapsed = this.mono() - s.receivedMono;
    const wallElapsed = this.wall() - s.receivedWall;
    check(
      elapsed >= 0 && elapsed <= maxAgeMs && Math.abs(elapsed - wallElapsed) <= 500,
      "CLOCK_CHANGED_OR_STALE",
    );
    return {
      lower: s.server + Math.min(elapsed, wallElapsed) - 250,
      upper: s.server + 1000 + s.rtt + Math.max(elapsed, wallElapsed) + 250,
      phoneOffsetMs: s.receivedWall - s.server,
      sampleRttMs: s.rtt,
      sampleAgeMs: elapsed,
    };
  }

  released() {
    return this.wall() >= this.task.open && this.bounds().lower >= this.task.open;
  }

  deadline() {
    check(
      this.wall() <= this.task.open + P71_LATE_MS && this.bounds().upper <= this.task.open + P71_LATE_MS,
      "MISSED_WINDOW",
    );
  }
}
function p71Pending(row) {
  return row?.attempts === 1 && !["SUCCESS", "FAILED"].includes(row.state);
}
const P71_FIRST_FIELDS = [
  "prepareStartedAt",
  "armedAt",
  "scheduledAt",
  "recalibratedAt",
  "recalibratedOffsetMs",
  "recalibratedRttMs",
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
  "maxTimerDriftMs",
  "pageSuspendedAt",
  "resultStateUpdatedAt",
];

const P71_MUTABLE_DIAG_FIELDS = [
  "preparationStage",
  "stoppedEndpoint",
  "httpStatus",
  "normalizedBusinessCode",
  "requestCountByEndpoint",
  "cacheHit",
  "duplicateActionBlocked",
  "crossModeConflict",
];
function mergeP71Diagnostics(old = {}, incoming = {}) {
  const merged = { ...old };
  for (const field of P71_FIRST_FIELDS) {
    if (merged[field] == null && incoming[field] != null) merged[field] = incoming[field];
  }
  for (const field of P71_MUTABLE_DIAG_FIELDS) {
    if (incoming[field] !== undefined) merged[field] = incoming[field];
  }
  if (incoming.maxTimerDriftMs != null) {
    merged.maxTimerDriftMs = Math.max(old.maxTimerDriftMs || 0, incoming.maxTimerDriftMs);
  }
  if (incoming.lastReviewedAt && (!old.lastReviewedAt || incoming.lastReviewedAt > old.lastReviewedAt)) {
    merged.lastReviewedAt = incoming.lastReviewedAt;
  }
  return merged;
}
function publicScheduledDiagnostics(row) {
  if (!row) return null;
  const fields = Object.fromEntries(P71_FIRST_FIELDS.map((k) => [k, row[k] ?? row.timings?.[k] ?? null]));
  const mutable = Object.fromEntries(
    P71_MUTABLE_DIAG_FIELDS.map((k) => [k, row[k] ?? row.timings?.[k] ?? null]),
  );
  return {
    version: row.version || P71_VERSION,
    platform: "ipad-safari-userscripts",
    mode: "scheduled-162",
    taskDay: row.target?.day || null,
    date: row.target?.date || null,
    seat: P71_SEAT.seat,
    floorId: P71_SEAT.floorId,
    room: row.target?.room || P71_SEAT.room,
    begin: row.target ? `${String(row.target.startHour).padStart(2, "0")}:00` : null,
    end: row.target ? `${String(row.target.endHour).padStart(2, "0")}:00` : null,
    duration: row.target?.duration ?? null,
    state: row.state || "IDLE",
    reason: row.reason || "READ_ONLY_DEFAULT",
    attempts: row.attempts ?? 0,
    recordVerified: row.recordVerified === true,
    verifications: row.verifications ?? 0,
    ...fields,
    ...mutable,
    lastReviewedAt: row.lastReviewedAt || null,
    events: (row.logs || []).slice(-60).map((e) => ({
      at: e.at,
      state: e.state,
      code: e.code || e.reason,
      ...(e.stage ? { stage: e.stage } : {}),
      ...(e.httpStatus != null ? { httpStatus: e.httpStatus } : {}),
      ...(e.endpoint ? { endpoint: e.endpoint } : {}),
    })),
    timingMeaning:
      "所有耗时与时间戳均为iPad Safari客户端观测值，不分离网络与服务端耗时；日志已脱敏，不含账号、凭据或原始响应体",
  };
}

  // --- src/userscript/p71/store.js ---
// Dedicated iPad P7.1 scheduled database. Completely isolated from phone DBs and P7.0 normal booking DB.
class ScheduledIpadStore {
  constructor(task, { database = "hdu-p71-ipad-scheduled" } = {}) {
    this.database = database;
    this.task = task;
    this.db = null;
    this.account = null;
    this.control = `hdu-p71-control:${task.day}:`;
    this.prefix = `hdu-p71:probe:${task.date}:`;
  }

  bind(account) {
    this.account = account;
    this.prefix = `hdu-p71:${account}:${this.task.date}:`;
  }

  async open() {
    if (this.db) return this.db;
    check(globalThis.indexedDB && globalThis.localStorage, "STORAGE_UNAVAILABLE");
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(this.database, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains("tasks"))
          req.result.createObjectStore("tasks", { keyPath: "key" });
        if (!req.result.objectStoreNames.contains("meta")) req.result.createObjectStore("meta");
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

  // Safari <16.4 durability options fallback
  openTx(db, storeName, mode) {
    if (mode !== "readwrite") return db.transaction(storeName, mode);
    try {
      return db.transaction(storeName, "readwrite", { durability: "strict" });
    } catch (e) {
      if (e instanceof TypeError) return db.transaction(storeName, "readwrite");
      throw e;
    }
  }

  async probe() {
    const db = await this.open();
    const value = safeRandomId();
    try {
      localStorage.setItem(`${this.prefix}probe`, value);
      check(localStorage.getItem(`${this.prefix}probe`) === value, "STORAGE_UNAVAILABLE");
    } catch {
      throw new TestError("STORAGE_UNAVAILABLE");
    }
    await new Promise((resolve, reject) => {
      const tx = this.openTx(db, "meta", "readwrite");
      tx.objectStore("meta").put(value, "probe");
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(new TestError("STORAGE_UNAVAILABLE"));
    });
    await new Promise((resolve, reject) => {
      const tx = this.openTx(db, "meta", "readonly");
      const req = tx.objectStore("meta").get("probe");
      req.onsuccess = () =>
        req.result === value ? resolve() : reject(new TestError("STORAGE_UNAVAILABLE"));
      tx.onerror = tx.onabort = () => reject(new TestError("STORAGE_UNAVAILABLE"));
    });
  }

  activateDay() {
    try {
      localStorage.setItem(`${this.control}active`, "1");
    } catch {
      /* handled by probe */
    }
  }

  active() {
    try {
      return (
        localStorage.getItem(`${this.prefix}active`) === "1" ||
        localStorage.getItem(`${this.control}active`) === "1"
      );
    } catch {
      return false;
    }
  }

  stopped() {
    try {
      return (
        localStorage.getItem(`${this.prefix}stop`) === "1" ||
        localStorage.getItem(`${this.control}stop`) === "1"
      );
    } catch {
      return true;
    }
  }

  stopSignal() {
    try {
      localStorage.setItem(`${this.control}stop`, "1");
      if (this.account) localStorage.setItem(`${this.prefix}stop`, "1");
    } catch {
      /* handled by probe */
    }
  }

  spent(key) {
    try {
      return localStorage.getItem(`${this.prefix}spent:${key}`) === "1";
    } catch {
      return true;
    }
  }

  async transact(key, change) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      let result = null;
      let failure = null;
      const tx = this.openTx(db, "tasks", change ? "readwrite" : "readonly");
      const store = tx.objectStore("tasks");
      const req = store.get(key);
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

  async list(account = this.account) {
    if (!account) return [];
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.openTx(db, "tasks", "readonly");
      const req = tx.objectStore("tasks").getAll();
      req.onsuccess = () => resolve(req.result.filter((r) => r.key.startsWith(`${account}:`)));
      tx.onerror = tx.onabort = () => reject(new TestError("STORAGE_UNAVAILABLE"));
    });
  }

  async pendingUnknown(account = this.account, excludeKey = null) {
    const rows = await this.list(account);
    return rows.find((r) => r.key !== excludeKey && p71Pending(r)) || null;
  }

  async reserve(row) {
    check(this.account && row.key.startsWith(`${this.account}:`), "IDENTITY_CHANGED");
    const db = await this.open();
    return new Promise((resolve, reject) => {
      let won = false;
      let value = null;
      let failure = null;
      const tx = this.openTx(db, "tasks", "readwrite");
      const store = tx.objectStore("tasks");
      const req = store.getAll();
      req.onsuccess = () => {
        try {
          const accountRows = req.result.filter((r) => r.key.startsWith(`${this.account}:`));
          check(!accountRows.some((r) => r.key !== row.key && p71Pending(r)), "PREVIOUS_UNKNOWN");
          value = accountRows.find((r) => r.key === row.key) || null;
          if (value || this.stopped() || this.spent(row.key)) return;
          won = true;
          value = mergeP71Diagnostics({ ...row, version: P71_VERSION }, row.timings);
          store.put(value);
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => {
        try {
          if (won) localStorage.setItem(`${this.prefix}active`, "1");
          resolve({ won, value });
        } catch {
          reject(new TestError("STORAGE_UNAVAILABLE"));
        }
      };
      tx.onerror = tx.onabort = () => reject(failure || new TestError("STORAGE_UNAVAILABLE"));
    });
  }

  async claim(key, owner, at) {
    let won = false;
    const value = await this.transact(key, (old) => {
      if (
        !old ||
        old.owner !== owner ||
        old.state !== "WAITING" ||
        old.attempts !== 0 ||
        this.stopped() ||
        this.spent(key)
      )
        return null;
      won = true;
      return { ...old, state: "UNKNOWN", reason: "WRITE_INTENT_PERSISTED", attempts: 1, intentAt: at };
    });
    if (won) {
      try {
        localStorage.setItem(`${this.prefix}spent:${key}`, "1");
      } catch {
        throw new TestError("STORAGE_UNAVAILABLE");
      }
    }
    return { won, value };
  }

  finish(key, owner, patch) {
    return this.transact(key, (old) => {
      if (!old || old.owner !== owner) return null;
      const terminal =
        old.state === "SUCCESS" ||
        (old.state === "FAILED" && !(patch.state === "SUCCESS" && patch.recordVerified === true));
      const next = terminal ? { ...old } : { ...old, ...patch };
      const d = mergeP71Diagnostics(old, { ...patch.timings, ...patch });
      for (const field of [...P71_FIRST_FIELDS, "lastReviewedAt"]) {
        if (d[field] !== undefined) next[field] = d[field];
      }
      next.timings = mergeP71Diagnostics(old.timings || {}, patch.timings || {});
      return next;
    });
  }

  // Preserves terminal SUCCESS and FAILED states (P6.1 rule).
  stop(key, reason = "USER_STOPPED") {
    return this.transact(key, (old) =>
      old && !["SUCCESS", "FAILED"].includes(old.state)
        ? { ...old, state: old.attempts ? "UNKNOWN" : "STOPPED", reason }
        : null,
    );
  }

  async takeVerification(key, now = Date.now()) {
    let won = false;
    await this.transact(key, (old) => {
      if (
        !old ||
        old.state === "SUCCESS" ||
        old.attempts !== 1 ||
        (old.verifications || 0) >= 3 ||
        now - (old.lastVerification || 0) < 2000
      )
        return null;
      won = true;
      return { ...old, verifications: (old.verifications || 0) + 1, lastVerification: now };
    });
    return won;
  }

  note(key, diagnostics, logs) {
    return this.transact(key, (old) =>
      old
        ? {
            ...mergeP71Diagnostics(old, diagnostics),
            timings: mergeP71Diagnostics(old.timings || {}, diagnostics),
            logs: logs?.slice(-60) || old.logs,
          }
        : null,
    );
  }
}

  // --- src/userscript/p71/engine.js ---
const P71_REJECTED = new Set(["SEAT_UNAVAILABLE", "NOT_OPEN", "EXISTING"]);
class ScheduledIpadEngine {
  constructor(io, store, notify = () => {}, env = {}) {
    this.io = io;
    this.store = store;
    this.notify = notify;
    this.wall = env.wall || (() => Date.now());
    this.mono = env.mono || (() => performance.now());
    this.visible = env.visible || (() => (typeof document === "undefined" ? true : document.visibilityState === "visible"));
    this.staticCache = env.staticCache || { roomQueryEntry: null, mappingEntry: null };
    this.coordinator = env.coordinator || null;
    this.task = env.task || scheduledTask(this.wall(), env.startHour ?? 8, env.endHour ?? 22);
    validateScheduledTask(this.task);
    this.clock = new ScheduledClock(this.wall, this.mono, this.task);
    this.owner = safeRandomId();
    this.state = "IDLE";
    this.reason = "READ_ONLY_DEFAULT";
    this.generation = 0;
    this.busy = false;
    this.formal = false;
    this.waiting = false;
    this.attempted = false;
    this.reviewing = false;
    this.identity = null;
    this.key = null;
    this.mapping = null;
    this.range = null;
    this.controller = null;
    this.openRangePath = null;
    this.openRangeCategory = null;
    this.openProofGeneration = null;
    this.openingChecks = 0;
    this.nextOpeningCheckMono = 0;
    this.recalibrated = false;
    this.lastTickWall = null;
    this.lastTickMono = null;
    this.lastHttpDiag = null;
    this.lastRehearsalAt = null;
    this.lastRehearsalSignature = null;
    this.duplicateActionBlocked = 0;
    this.requestCountByEndpoint = {};
    this.preparationStage = "IDLE";
    this.logs = [];
    this.timings = {
      scheduledAt: new Date(this.task.open).toISOString(),
      preparationStage: "IDLE",
      stoppedEndpoint: null,
      httpStatus: null,
      normalizedBusinessCode: null,
      requestCountByEndpoint: {},
      cacheHit: { roomQueryHit: false, seatMappingHit: false, valid: false, reason: "NOT_CHECKED", ageMs: null },
      duplicateActionBlocked: 0,
      crossModeConflict: null,
    };
    this.diagWrites = Promise.resolve();
  }

  iso() {
    return new Date(this.wall()).toISOString();
  }

  setStage(stage) {
    this.preparationStage = stage;
    this.mark({ preparationStage: stage });
  }

  countRequest(method, path) {
    const endpoint = String(path).split("?")[0];
    const key = `${method} ${endpoint}`;
    this.requestCountByEndpoint[key] = (this.requestCountByEndpoint[key] || 0) + 1;
    this.mark({ requestCountByEndpoint: { ...this.requestCountByEndpoint } });
  }

  mark(values) {
    this.timings = mergeP71Diagnostics(this.timings, values);
  }

  persistDiagnostics() {
    if (!this.key) return;
    const key = this.key;
    const values = structuredClone(this.timings);
    const logs = this.logs.slice(-60);
    this.diagWrites = this.diagWrites
      .then(() => this.store.note(key, values, logs))
      .catch(() => {});
  }

  emit(state, code, details = {}) {
    if (state === "WAITING" && !this.waiting) {
      state = "IDLE";
      code = "WAITING_VIEW_ONLY";
    }
    if (
      ["MISSED_WINDOW", "PREPARE_WINDOW", "AUTHORIZATION_EXPIRED", "PREPARE_TOO_LATE_OR_STOPPED"].includes(code) &&
      !this.attempted
    ) {
      state = "EXPIRED";
    }
    if (code === "FORMAL_PREFLIGHT" || code === "READ_ONLY_REHEARSAL") this.mark({ prepareStartedAt: this.iso() });
    if (code === "ARMED_FOR_2000") this.mark({ armedAt: this.iso() });
    if (this.state === state && this.reason === code && !["LOGIN_OK", "RANGE_OK"].includes(code)) return;
    this.state = state;
    this.reason = code;
    this.logs.push({ at: this.iso(), state, code, stage: this.preparationStage, ...details });
    if (this.logs.length > 60) this.logs.shift();
    this.notify(this.view());
    this.persistDiagnostics();
  }

  view() {
    return {
      state: this.state,
      reason: this.reason,
      formal: this.formal,
      waiting: this.waiting,
      attempted: this.attempted,
      task: this.task,
      login: !!this.identity,
      mapping: this.mapping,
      timings: this.timings,
      logs: this.logs.slice(),
    };
  }

  ensure(g) {
    check(g === this.generation, "USER_STOPPED");
    if (this.formal && !this.reviewing) {
      check(shanghaiDate(this.wall()) === this.task.day, "AUTHORIZATION_EXPIRED");
    }
  }

  async read(path, g, form, observe = true) {
    this.ensure(g);
    let httpStatus = null;
    const endpoint = String(path).split("?")[0];
    this.countRequest(form ? "POST" : "GET", path);
    try {
      const response = await this.io.request(path, {
        form,
        signal: this.controller.signal,
        onHeaders: (sample) => {
          httpStatus = sample?.status ?? null;
          if (observe) this.clock.observe(sample);
        },
      });
      this.ensure(g);
      const code = responseCode(response.body);
      if (["LIMITED", "HTTP_404", "AUTH_REQUIRED"].includes(code)) {
        this.lastHttpDiag = { httpStatus, endpoint, normalizedBusinessCode: code };
        check(false, code);
      }
      return response.body;
    } catch (error) {
      const code = codeOf(error);
      this.lastHttpDiag = { httpStatus, endpoint, normalizedBusinessCode: code };
      throw error;
    }
  }

  async login(g, observe = true) {
    const start = this.mono();
    const body = await this.read("/User/Center/baseInfo", g, undefined, observe);
    const uid = body?.DATA?.uid;
    check(body?.DATA?.is_login === true && /^\d+$/.test(String(uid ?? "")), "AUTH_REQUIRED");
    const account = await accountKey(String(uid));
    this.ensure(g);
    if (this.identity) check(this.identity.account === account, "IDENTITY_CHANGED");
    this.identity = { uid: String(uid), account };
    this.store.bind(account);
    this.key = scheduledTaskKey(account, this.task);
    this.mark({ loginCheckMs: this.mono() - start });
    this.emit(this.state, "LOGIN_OK");
  }

  async prepare({ arm = false, confirmed = false, authorizedDay } = {}) {
    // Guard duplicate clicks / already-active formal tasks with zero network requests.
    if (this.busy || this.formal || this.waiting) {
      this.duplicateActionBlocked++;
      this.mark({ duplicateActionBlocked: this.duplicateActionBlocked });
      return this.view();
    }
    const rehearsalSig = `${this.task.day}:${this.task.date}:${this.task.startHour}-${this.task.endHour}`;
    if (
      !arm &&
      this.state === "READY_READ_ONLY" &&
      this.lastRehearsalSignature === rehearsalSig &&
      this.lastRehearsalAt != null &&
      this.wall() - this.lastRehearsalAt < P71_REHEARSAL_DEDUPE_MS
    ) {
      this.duplicateActionBlocked++;
      this.mark({ duplicateActionBlocked: this.duplicateActionBlocked });
      return this.view();
    }

    if (arm && (!confirmed || authorizedDay !== this.task.day || shanghaiDate(this.wall()) !== this.task.day)) {
      this.emit("STOPPED", "TODAY_AUTHORIZATION_REQUIRED");
      return this.view();
    }
    if (arm && this.wall() < this.task.open - P71_PREPARE_MS) {
      this.emit("IDLE", "PREPARE_TOO_EARLY");
      return this.view();
    }
    if (arm && this.wall() >= this.task.open) {
      this.emit("EXPIRED", "PREPARE_WINDOW");
      return this.view();
    }

    this.busy = true;
    this.formal = arm;
    this.controller = new AbortController();
    const g = this.generation;
    this.openRangePath = null;
    this.openRangeCategory = null;
    this.openProofGeneration = null;
    this.openingChecks = 0;
    this.nextOpeningCheckMono = 0;
    this.recalibrated = false;
    this.lastTickWall = null;
    this.lastTickMono = null;
    this.lastHttpDiag = null;
    this.timings = {
      scheduledAt: new Date(this.task.open).toISOString(),
      preparationStage: "PREFLIGHT_START",
      stoppedEndpoint: null,
      httpStatus: null,
      normalizedBusinessCode: null,
      requestCountByEndpoint: { ...this.requestCountByEndpoint },
      cacheHit: { roomQueryHit: false, seatMappingHit: false, valid: false, reason: "NOT_CHECKED", ageMs: null },
      duplicateActionBlocked: this.duplicateActionBlocked,
      crossModeConflict: null,
    };
    if (arm) this.store.activateDay?.();
    this.setStage("PREFLIGHT_START");
    this.emit("PREPARING", arm ? "FORMAL_PREFLIGHT" : "READ_ONLY_REHEARSAL");

    try {
      validateScheduledTask(this.task);
      check(this.visible(), "FOREGROUND_REQUIRED");
      if (arm) check(!this.store.stopped(), "USER_STOPPED");

      this.setStage("STORAGE_PROBE");
      await this.store.probe();
      this.ensure(g);

      this.setStage("LOGIN");
      await this.login(g, true);

      this.setStage("CROSS_MODE_CHECK");
      if (this.coordinator) {
        const conflict = await this.coordinator.checkForScheduled(this.identity.account);
        if (conflict) {
          this.mark({ crossModeConflict: conflict });
          check(false, conflict.code);
        }
      }
      const pending = await this.store.pendingUnknown(this.identity.account, this.key);
      check(!pending, "PREVIOUS_UNKNOWN");
      const old = await this.store.get(this.key);
      this.ensure(g);
      if (old || this.store.spent(this.key)) {
        this.timings = mergeP71Diagnostics(old?.timings || {}, this.timings);
        this.mapping = old?.mapping || this.mapping;
        this.attempted ||= old?.attempts === 1;
        this.emit(old?.state || "UNKNOWN", "TASK_ALREADY_RESERVED");
        return this.view();
      }

      const start = this.mono();
      const cacheCtx = {
        account: this.identity.account,
        day: this.task.day,
        date: this.task.date,
        now: this.wall(),
      };
      const rqCheck = validateStaticCacheEntry(this.staticCache.roomQueryEntry, cacheCtx);
      let query;
      if (rqCheck.valid) {
        query = this.staticCache.roomQueryEntry.roomQuery;
      } else {
        this.setStage("CATEGORY_LIST");
        query = roomQuery(await this.read("/Space/Category/list?LAB_JSON=1", g, undefined, true));
        this.staticCache.roomQueryEntry = {
          account: this.identity.account,
          day: this.task.day,
          date: this.task.date,
          roomQuery: query,
          verifiedAt: this.wall(),
        };
      }

      // Always read live room range and category (never cached).
      this.setStage("RANGE_READ");
      const body = await this.read(query, g, undefined, true);
      const rawRange = body?.data?.range;
      this.range = validateScheduledRange(rawRange, this.wall(), this.task);
      const group = category(body?.data);
      this.openRangePath = query;
      this.openRangeCategory = group;
      this.emit("PREPARING", "RANGE_OK", {
        fields: inspectRange(rawRange),
        dates: this.range.dates,
        mapDate: this.range.mapDate,
      });

      // Reuse static physical 162->62726 mapping ONLY when verified in-session, same account/day/target/category, and within TTL.
      const mapCheck = validateStaticCacheEntry(this.staticCache.mappingEntry, { ...cacheCtx, group });
      this.mark({
        cacheHit: {
          roomQueryHit: rqCheck.valid,
          seatMappingHit: mapCheck.valid,
          valid: mapCheck.valid,
          reason: mapCheck.reason,
          ageMs: mapCheck.ageMs,
        },
      });
      if (mapCheck.valid) {
        this.mapping = { ...this.staticCache.mappingEntry.mapping };
        this.mark({ catalogReadMs: this.mono() - start, idResolutionMs: 0 });
      } else {
        this.setStage("SEAT_MAPPING");
        const mapBody = await this.read(
          "/Seat/Index/searchSeats?LAB_JSON=1",
          g,
          new URLSearchParams({
            beginTime: String(this.range.mapBegin),
            duration: "3600",
            num: "1",
            "space_category[category_id]": group.category_id,
            "space_category[content_id]": group.content_id,
          }),
          true,
        );
        this.mark({ catalogReadMs: this.mono() - start });
        const parseStart = this.mono();
        this.mapping = resolveScheduled162(mapBody);
        this.mark({ idResolutionMs: this.mono() - parseStart });
        this.staticCache.mappingEntry = {
          account: this.identity.account,
          day: this.task.day,
          date: this.task.date,
          categoryId: group.category_id,
          contentId: group.content_id,
          mapping: { ...this.mapping },
          verifiedAt: this.wall(),
        };
      }

      // Always read live official records for conflict checking (never cached).
      this.setStage("CONFLICT_CHECK");
      const conflictStart = this.mono();
      const booked = records(await this.read(P71_RECORD_PATH, g, undefined, true));
      check(scheduledOverlaps(booked, this.task).length === 0, "EXISTING");
      this.mark({ conflictReadMs: this.mono() - conflictStart });

      this.setStage("SIGN_DRY_RUN");
      this.clock.bounds();
      const dryRun = signedScheduledRequest(
        this.task.seatId,
        this.identity.uid,
        this.task.begin,
        Math.floor(this.wall() / 1000),
        this.task.duration,
      );
      check(dryRun.form.get("duration") === String(this.task.duration), "INVALID_DURATION");
      this.ensure(g);
      check(this.visible(), "FOREGROUND_REQUIRED");

      if (!arm) {
        this.lastRehearsalAt = this.wall();
        this.lastRehearsalSignature = rehearsalSig;
        this.setStage("READY_READ_ONLY");
        this.emit("READY_READ_ONLY", "REHEARSAL_PASSED");
        return this.view();
      }

      this.setStage("RESERVE");
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
        logs: this.logs.slice(-60),
        target: { ...this.task },
        createdAt: this.iso(),
        verifications: 0,
      });
      this.ensure(g);
      check(reserved.won, "TASK_ALREADY_RESERVED");
      this.waiting = true;
      this.lastTickWall = this.wall();
      this.lastTickMono = this.mono();
      this.setStage("ARMED");
      this.emit("WAITING", "ARMED_FOR_2000");
    } catch (error) {
      const reason = codeOf(error);
      const diag = this.lastHttpDiag || {};
      this.lastHttpDiag = null;
      this.mark({
        stoppedEndpoint: diag.endpoint || null,
        httpStatus: diag.httpStatus ?? null,
        normalizedBusinessCode: diag.normalizedBusinessCode || reason,
      });
      this.emit(this.attempted ? "UNKNOWN" : "STOPPED", reason, diag);
      if (arm && this.key) {
        await this.store.finish(this.key, this.owner, { state: "STOPPED", reason, timings: this.timings }).catch(() => {});
      }
    } finally {
      this.busy = false;
    }
    return this.view();
  }

  checkTimerIntegrity() {
    const nowWall = this.wall();
    const nowMono = this.mono();
    if (this.lastTickWall != null && this.lastTickMono != null) {
      const dWall = nowWall - this.lastTickWall;
      const dMono = nowMono - this.lastTickMono;
      const drift = Math.abs(dWall - dMono);
      if (drift > 0) this.mark({ maxTimerDriftMs: drift });
      if (dWall > P71_TIMER_DRIFT_MAX_MS || dMono > P71_TIMER_DRIFT_MAX_MS || drift > 500) {
        this.mark({ pageSuspendedAt: this.iso() });
        check(false, "SAFARI_TIMER_SUSPENDED");
      }
    }
    this.lastTickWall = nowWall;
    this.lastTickMono = nowMono;
  }

  async recalibrateClock(g) {
    this.busy = true;
    this.setStage("RECALIBRATE");
    try {
      this.emit("WAITING", "RECALIBRATING_CLOCK");
      await this.read("/User/Center/baseInfo", g, undefined, true);
      const b = this.clock.bounds();
      this.recalibrated = true;
      this.mark({
        recalibratedAt: this.iso(),
        recalibratedOffsetMs: b.phoneOffsetMs,
        recalibratedRttMs: b.sampleRttMs,
      });
      this.lastTickWall = this.wall();
      this.lastTickMono = this.mono();
      this.emit("WAITING", "RECALIBRATED_OK");
    } finally {
      this.busy = false;
    }
  }

  async tick() {
    if (!this.waiting || this.busy) return;
    const g = this.generation;
    try {
      check(!this.store.stopped(), "USER_STOPPED");
      check(this.visible(), "FOREGROUND_REQUIRED");
      this.checkTimerIntegrity();

      const toOpen = this.task.open - this.wall();
      if (!this.recalibrated && toOpen <= P71_RECALIBRATE_BEFORE_MS && toOpen > 3000) {
        await this.recalibrateClock(g);
        return;
      }
      if (toOpen > 0) {
        if (this.recalibrated) this.clock.bounds();
        return;
      }

      this.clock.deadline();
      if (!this.clock.released()) return;

      const bounds = this.clock.bounds();
      this.mark({
        firstGatePassedAt: this.iso(),
        gateClockLowerMs: bounds.lower,
        gateClockUpperMs: bounds.upper,
        gateClockPhoneOffsetMs: bounds.phoneOffsetMs,
        gateClockSampleRttMs: bounds.sampleRttMs,
      });

      if (this.mono() < this.nextOpeningCheckMono) return;
      check(this.openRangePath && this.openRangeCategory && this.openingChecks < 2, "OPEN_RANGE_UNCONFIRMED");

      this.busy = true;
      this.setStage("OPEN_CONFIRM");
      this.openingChecks++;
      this.mark({ openingCheckStartedAt: this.iso() });
      this.emit("WAITING", "OPEN_RANGE_CHECKING");

      const body = await this.read(this.openRangePath, g, undefined, false);
      this.ensure(g);
      this.lastTickWall = this.wall();
      this.lastTickMono = this.mono();
      const group = category(body?.data);
      check(
        group.category_id === this.openRangeCategory.category_id &&
          group.content_id === this.openRangeCategory.content_id,
        "OPEN_RANGE_UNCONFIRMED",
      );
      const result = openingScheduledRange(body?.data?.range, this.task);
      check(!this.store.stopped() && this.visible(), "FOREGROUND_REQUIRED");
      this.clock.deadline();
      check(this.clock.released(), "NOT_RELEASED");

      if (!result.open) {
        check(this.openingChecks < 2, "OPEN_RANGE_UNCONFIRMED");
        this.nextOpeningCheckMono = this.mono() + 1000;
        this.emit("WAITING", "OPEN_RANGE_NOT_YET");
        return;
      }

      this.openProofGeneration = g;
      this.mark({ openConfirmedAt: this.iso(), confirmedMaxDateExclusive: result.maxDateExclusive });
      this.emit("WAITING", "OPEN_RANGE_CONFIRMED");
      this.busy = false;
      await this.submit();
    } catch (error) {
      const code = codeOf(error);
      const diag = this.lastHttpDiag || {};
      this.lastHttpDiag = null;
      this.mark({
        stoppedEndpoint: diag.endpoint || null,
        httpStatus: diag.httpStatus ?? null,
        normalizedBusinessCode: diag.normalizedBusinessCode || code,
      });
      if (g === this.generation) await this.stop(code);
    } finally {
      this.busy = false;
    }
  }

  async submit() {
    this.busy = true;
    this.waiting = false;
    this.setStage("SUBMIT");
    const g = this.generation;
    const localStart = this.mono();
    let claimed = false;
    let reason = "LOCAL_ERROR";
    let verification = null;
    let submitHttpStatus = null;

    try {
      this.ensure(g);
      check(this.openProofGeneration === g && this.timings.openConfirmedAt, "OPEN_RANGE_UNCONFIRMED");
      check(this.formal && !this.attempted && this.visible() && !this.store.stopped(), "WRITE_GATE_CLOSED");
      if (this.coordinator) {
        const conflict = await this.coordinator.checkForScheduled(this.identity.account);
        if (conflict) {
          this.mark({ crossModeConflict: conflict });
          check(false, conflict.code);
        }
      }
      this.clock.deadline();
      check(this.clock.released(), "NOT_RELEASED");

      const claim = await this.store.claim(this.key, this.owner, this.iso());
      check(claim.won, "BUDGET_SPENT");
      claimed = true;
      this.attempted = true;

      this.ensure(g);
      check(this.visible() && !this.store.stopped(), "USER_STOPPED");
      this.clock.deadline();
      check(this.clock.released(), "NOT_RELEASED");

      const request = signedScheduledRequest(
        this.task.seatId,
        this.identity.uid,
        this.task.begin,
        Math.floor(this.wall() / 1000),
        this.task.duration,
      );
      this.mark({ preSubmitLocalMs: this.mono() - localStart });
      this.emit("SUBMITTING", "SUBMITTING_ONCE");
      this.countRequest("POST", BOOK_PATH);

      const response = await this.io.request(BOOK_PATH, {
        ...request,
        write: true,
        signal: this.controller.signal,
        onDispatch: (at) => {
          this.ensure(g);
          check(this.openProofGeneration === g, "OPEN_RANGE_UNCONFIRMED");
          check(this.visible() && !this.store.stopped(), "USER_STOPPED");
          this.clock.deadline();
          check(this.clock.released(), "NOT_RELEASED");
          this.mark({ firstDispatchAt: at });
          this.persistDiagnostics();
        },
        onHeaders: (sample) => {
          submitHttpStatus = sample?.status ?? null;
          this.mark({
            firstResponseAt: sample.timing?.responseAt || this.iso(),
            dispatchToHeadersMs: sample.timing?.dispatchToHeadersMs,
            httpStatus: submitHttpStatus,
          });
        },
        onBusiness: (body, timing) => {
          const code = responseCode(body);
          const at = timing.businessResultAt || this.iso();
          this.mark({
            firstBusinessResultAt: at,
            firstServerSuccessAt: code === "SERVER_SUCCESS" ? at : undefined,
            responseCode: code,
            normalizedBusinessCode: code,
            bodyDecodeMs: timing.bodyDecodeMs,
          });
        },
      });
      this.mark({ totalRequestMs: response.timing?.totalRequestMs ?? null });
      reason = responseCode(response.body);
      this.mark({ responseCode: reason, normalizedBusinessCode: reason, resultStateUpdatedAt: this.iso() });
    } catch (error) {
      reason = codeOf(error);
      this.mark({
        responseCode: reason,
        normalizedBusinessCode: reason,
        stoppedEndpoint: "/Seat/Index/bookSeats",
        httpStatus: submitHttpStatus,
        resultStateUpdatedAt: this.iso(),
      });
      if (error.timing?.totalRequestMs != null) this.mark({ totalRequestMs: error.timing.totalRequestMs });
    }

    const immediate = !claimed
      ? "STOPPED"
      : ["LIMITED", "AUTH_REQUIRED"].includes(reason)
        ? "FAILED"
        : "UNKNOWN";
    this.emit(reason === "SERVER_SUCCESS" ? "VERIFYING" : immediate, reason);

    if (claimed) {
      try {
        const persisted = await this.store.finish(this.key, this.owner, {
          state: immediate,
          reason,
          timings: this.timings,
          logs: this.logs.slice(-60),
        });
        if (persisted?.state === "SUCCESS") {
          this.setStage("DONE");
          this.emit("SUCCESS", "RECORD_VERIFIED");
          this.busy = false;
          return;
        }
        if (g === this.generation && !["LIMITED", "AUTH_REQUIRED"].includes(reason) && !this.store.stopped()) {
          this.setStage("VERIFY");
          verification = await this.verify(g);
        }
        const state =
          verification === true
            ? "SUCCESS"
            : verification === false && P71_REJECTED.has(reason)
              ? "FAILED"
              : immediate;
        const finalReason = verification === true ? "RECORD_VERIFIED" : reason;
        const finalRow = await this.store.finish(this.key, this.owner, {
          state,
          reason: finalReason,
          recordVerified: verification === true,
          timings: this.timings,
          logs: this.logs.slice(-60),
        });
        if (finalRow?.state === "SUCCESS") {
          this.setStage("DONE");
          this.emit("SUCCESS", "RECORD_VERIFIED");
          this.busy = false;
          return;
        }
        this.setStage("DONE");
        this.emit(
          g !== this.generation && state !== "SUCCESS" ? "UNKNOWN" : state,
          g !== this.generation && state !== "SUCCESS" ? "USER_STOPPED" : finalReason,
        );
      } catch (error) {
        this.emit("UNKNOWN", codeOf(error));
      }
    }
    this.busy = false;
  }

  async verify(g) {
    if (!(await this.store.takeVerification(this.key, this.wall()))) return null;
    const start = this.mono();
    try {
      const items = records(await this.read(P71_RECORD_PATH, g, undefined, false));
      const ok = verifiedScheduled162(items, this.mapping, this.task);
      if (ok) this.mark({ firstRecordVerifiedAt: this.iso() });
      return ok;
    } catch (error) {
      this.emit("UNKNOWN", codeOf(error));
      return null;
    } finally {
      this.mark({ verificationMs: this.mono() - start });
    }
  }

  async review() {
    if (this.busy || this.waiting) {
      this.duplicateActionBlocked++;
      this.mark({ duplicateActionBlocked: this.duplicateActionBlocked });
      return this.view();
    }
    this.busy = true;
    this.reviewing = true;
    this.controller = new AbortController();
    const g = this.generation;
    const at = this.iso();
    try {
      await this.login(g, false);
      const row = await this.store.get(this.key);
      this.ensure(g);
      if (!row) {
        this.emit("IDLE", "NO_FORMAL_TASK");
        return this.view();
      }
      this.mapping = row.mapping;
      this.timings = mergeP71Diagnostics(row.timings || {}, row);
      this.attempted ||= row.attempts === 1;
      if (row.logs) this.logs = row.logs.slice(-60);
      if (row.state === "SUCCESS") {
        this.emit("SUCCESS", "REVIEW_SAVED_RESULT");
        return this.view();
      }
      if (row.attempts !== 1) {
        this.emit(row.state, row.reason);
        return this.view();
      }
      const ok = await this.verify(g);
      if (ok === true) {
        await this.store.finish(this.key, row.owner, {
          state: "SUCCESS",
          reason: "RECORD_VERIFIED",
          recordVerified: true,
          timings: this.timings,
          logs: this.logs.slice(-60),
        });
        this.emit("SUCCESS", "RECORD_VERIFIED");
      } else {
        this.emit(
          row.state === "FAILED" ? "FAILED" : "UNKNOWN",
          ok === null ? "READ_CHECK_LIMIT_OR_ERROR" : "RECORD_NOT_VERIFIED",
        );
      }
    } catch (error) {
      this.emit("UNKNOWN", codeOf(error));
    } finally {
      this.reviewing = false;
      this.busy = false;
      this.timings.lastReviewedAt = at;
      if (this.key) await this.store.note(this.key, { lastReviewedAt: at }, this.logs).catch(() => {});
      this.notify(this.view());
    }
    return this.view();
  }

  async suspend(code = "FOREGROUND_REQUIRED") {
    this.mark({ pageSuspendedAt: this.iso() });
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
    let row = null;
    try {
      if (this.formal || this.store.active()) {
        this.store.stopSignal();
        row = this.key ? await this.store.stop(this.key, reason) : null;
        this.attempted ||= row?.attempts === 1;
      }
    } catch {
      reason = "STORAGE_UNAVAILABLE";
    }
    if (row && ["SUCCESS", "FAILED"].includes(row.state)) {
      this.emit(row.state, row.reason);
      return;
    }
    this.emit(this.state === "SUCCESS" ? "SUCCESS" : this.attempted ? "UNKNOWN" : "STOPPED", reason);
  }

  async diagnosticExport() {
    await this.diagWrites;
    let rows = [];
    if (this.identity) rows = await this.store.list(this.identity.account);
    const stored = rows.find((r) => r.key === this.key);
    return {
      version: P71_VERSION,
      platform: "ipad-safari-userscripts",
      mode: "scheduled-162",
      current: publicScheduledDiagnostics(
        stored
          ? {
              ...stored,
              duplicateActionBlocked: Math.max(
                stored.duplicateActionBlocked || 0,
                this.duplicateActionBlocked,
              ),
              requestCountByEndpoint: Object.keys(this.requestCountByEndpoint).length
                ? { ...this.requestCountByEndpoint }
                : stored.requestCountByEndpoint || {},
              crossModeConflict: this.timings.crossModeConflict || stored.crossModeConflict || null,
            }
          : {
              target: this.task,
              version: P71_VERSION,
              state: this.state,
              reason: this.reason,
              attempts: this.attempted ? 1 : 0,
              ...this.timings,
              logs: this.logs,
            },
      ),
      recent: rows
        .sort((a, b) => (b.target?.date || "").localeCompare(a.target?.date || ""))
        .slice(0, 7)
        .map(publicScheduledDiagnostics),
    };
  }
}

  // --- src/userscript/p71/panel.js ---
const P71_MESSAGES = {
  READ_ONLY_DEFAULT: "默认只读；每天需重新勾选授权。未勾选点击启动可做只读预检。",
  PREPARE_TOO_EARLY: "未到北京时间19:55。可先取消勾选做只读预检；到19:55后需重新勾选并点击启动。",
  PREPARE_WINDOW: "正式准备仅限北京时间19:55至20:00前；其他时间仅支持只读预检。",
  REHEARSAL_PASSED: "只读预检通过（含自定义时段与162映射核验），未提交预约。",
  ARMED_FOR_2000: "已进入20:00待命（19:59:15将自动重校时）。请保持Safari前台与屏幕常亮。",
  RECALIBRATING_CLOCK: "临近20:00，正在自动重新校时...",
  RECALIBRATED_OK: "临近校时通过，继续等待20:00开放门禁。",
  OPEN_RANGE_CHECKING: "20:00门禁已过，正在核对馆方实际可约日期（尚未提交）。",
  OPEN_RANGE_NOT_YET: "馆方尚未列出目标日期，将在安全窗口内间隔1秒后至多再核对一次。",
  OPEN_RANGE_CONFIRMED: "馆方已确认目标日期开放，准备执行唯一一次正式预约。",
  OPEN_RANGE_UNCONFIRMED: "未能确认目标日期已开放，本次未提交预约（0次写入）。请查看官网。",
  SUBMITTING_ONCE: "正在提交唯一一次162预约请求，请保持前台与网络正常。",
  SERVER_SUCCESS: "162 · 馆方已受理，正在核验官方记录...",
  RECORD_VERIFIED: "预约成功：官方记录已核验四楼162与自定义时段完全一致。",
  REVIEW_SAVED_RESULT: "已核验成功的预约记录；首次时间戳保持不变。",
  RECORD_NOT_VERIFIED: "暂未核验到官方记录，请查看官网“我的预约”；绝不自动重发。",
  SEAT_UNAVAILABLE: "馆方拒绝：162号不可预约。不自动换座。",
  NOT_OPEN: "馆方拒绝：目标日期或时段未开放。不重发。",
  EXISTING: "目标时段已有冲突预约，禁止重复提交。",
  LIMITED: "馆方限流或拒绝访问，已停止。",
  AUTH_REQUIRED: "登录已失效，请在官网重新登录。不会自动恢复提交。",
  PREVIOUS_UNKNOWN: "存在往日未决(UNKNOWN)记录，已禁止新预约；请先核验官方记录。",
  CROSS_MODE_ACTIVE_TASK: "普通预约模式正在执行任务，整点模式已互斥阻断。",
  CROSS_MODE_UNKNOWN: "普通预约模式存在未决(UNKNOWN)记录，请先在普通模式核验官方记录。",
  CROSS_MODE_CONFLICT: "另一模式存在冲突任务，已阻止重复操作。",
  TASK_ALREADY_RESERVED: "今日目标日期任务已存在，仅查看不重复启动。",
  NO_FORMAL_TASK: "尚无本日正式整点任务。",
  TODAY_AUTHORIZATION_REQUIRED: "请核对日期并勾选今日明确授权。",
  DURATION_NOT_ALLOWED: "所选自定义时段或时长不符合馆方当前开放规则，请调整开始/结束时间。",
  INVALID_DURATION: "结束时间必须晚于开始时间且为整点小时。",
  CLOCK_UNVERIFIED: "校时样本无法验证，禁止提交。请检查iPad自动日期与时间设置。",
  CLOCK_CHANGED_OR_STALE: "校时样本过期或时钟发生跳变，已停止；不会补发。",
  SAFARI_TIMER_SUSPENDED: "检测到Safari定时器被挂起或锁屏中断，已安全停止；不会恢复补发。",
  MISSED_WINDOW: "已超过20:00:10安全执行窗口，已停止；不补发。",
  FOREGROUND_REQUIRED: "页面离开前台或锁屏，已立即停止；不会自动恢复提交。",
  USER_STOPPED: "已停止后续自动操作。停止不会撤销已发出的预约。",
  HTTP_404: "接口返回404；若已提交则状态待确认，请核验官方记录，不重发。",
  TIMEOUT: "请求超时，服务端可能已处理，请先核验官方记录，不重发。",
  NETWORK_ERROR: "网络异常，结果待确认，请核验官方记录，不重发。",
  STORAGE_UNAVAILABLE: "Safari本地存储不可用，禁止提交。请关闭无痕模式。",
  READ_CHECK_LIMIT_OR_ERROR: "核验次数已达上限(3次)或间隔不足2秒，请直接查看官网“我的预约”。",
  WAITING_VIEW_ONLY: "已存在待命记录（仅查看，本页不恢复提交）。",
  LOGIN_OK: "登录有效。",
  RANGE_OK: "日期规则校验通过。",
};

const P71_PHASES = {
  IDLE: ["162 · 待启动", "idle"],
  PREPARING: ["162 · 预检中", "active"],
  READY_READ_ONLY: ["162 · 预检通过", "active"],
  WAITING: ["162 · 待命", "active"],
  SUBMITTING: ["162 · 提交中", "active"],
  VERIFYING: ["162 · 核验中", "active"],
  SUCCESS: ["162 · 已成功", "success"],
  FAILED: ["162 · 未成功", "failed"],
  UNKNOWN: ["162 · 待核验", "unknown"],
  STOPPED: ["162 · 已停止", "stopped"],
  EXPIRED: ["162 · 窗口结束", "stopped"],
};
function mountP71Panel(actions, normalEngine) {
  const host = document.createElement("div");
  host.id = "hdu-p71-host";
  const root = host.attachShadow({ mode: "open" });

  const hourOptions = (start, end, selected) => {
    let html = "";
    for (let h = start; h <= end; h++) {
      html += `<option value="${h}"${h === selected ? " selected" : ""}>${String(h).padStart(2, "0")}:00</option>`;
    }
    return html;
  };

  root.innerHTML = `<style>
    :host{all:initial;position:fixed;right:max(12px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom));z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:#142636;font-size:15px;line-height:1.45}
    *{box-sizing:border-box}[hidden]{display:none!important}
    button,input,select,textarea{font-family:inherit;font-size:16px}
    button,select,input[type=checkbox]{touch-action:manipulation}
    button{min-height:44px;padding:8px 10px;border:1px solid #9db0be;border-radius:10px;background:#fff;color:#142636;cursor:pointer}
    button:disabled{opacity:.5;cursor:default}
    #toggle{float:right;background:#154c79;color:#fff;border:0;font-weight:600;box-shadow:0 4px 14px rgba(0,0,0,.22)}
    #toggle[data-tone=success]{background:#17633b}#toggle[data-tone=failed]{background:#a0212b}#toggle[data-tone=unknown]{background:#945008}#toggle[data-tone=stopped]{background:#59646b}
    #panel{clear:both;width:min(410px,calc(100vw - 24px));max-height:min(78vh,calc(100dvh - 88px));overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;background:#f8fafc;border:1px solid #9db0be;border-radius:14px;padding:13px;margin-bottom:8px;box-shadow:0 8px 28px rgba(0,0,0,.2);overflow-wrap:anywhere}
    h2{font-size:17px;margin:0 0 6px}p{margin:5px 0}.hint{font-size:13px;color:#466070}
    .tabs{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:8px 0}
    .tab{min-height:40px;font-weight:600;background:#e8eef3;border-color:#b6c6d3}
    .tab[aria-selected=true]{background:#154c79;color:#fff;border-color:#154c79}
    .box{padding:9px 10px;border-radius:8px;background:#e6f0f8;font-weight:500}
    .grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 0}
    .fields{display:grid;gap:8px;margin:8px 0}
    label{display:block;font-size:14px}
    select{width:100%;min-height:44px;margin-top:4px;padding:8px 10px;border:1px solid #94a3b8;border-radius:8px;background:#fff;color:#142636}
    .checkRow{display:flex;gap:8px;align-items:flex-start;margin:8px 0}
    input[type=checkbox]{width:22px;height:22px;flex:none;margin-top:2px}
    .primary{background:#154c79;color:#fff;border:0;font-weight:600}
    .danger{border-color:#a52727;color:#a52727}
    .confirm{margin:8px 0;padding:10px;border:1px solid #cbd5e1;border-radius:10px;background:#fff}
    textarea{width:100%;height:160px;margin-top:6px;padding:8px;border:1px solid #94a3b8;border-radius:8px;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;background:#fff;color:#142636}
    a{color:#154c79;font-weight:500}
  </style>
  <section id="panel" hidden aria-label="P7.1 iPad 预约控制面板">
    <h2>P7.1.1 iPad · 固定162整点 & 普通预约</h2>
    <div class="tabs" role="tablist">
      <button id="tabSched" class="tab" role="tab" aria-selected="true">20:00 整点 162</button>
      <button id="tabNormal" class="tab" role="tab" aria-selected="false">普通预约 (P7.0)</button>
    </div>

    <div id="paneSched">
      <p id="sTarget" style="font-weight:600"></p>
      <p id="sClock" class="hint"></p>
      <div class="grid2">
        <label>开始时间<select id="sStart">${hourOptions(7, 21, 8)}</select></label>
        <label>结束时间<select id="sEnd">${hourOptions(8, 22, 22)}</select></label>
      </div>
      <p id="sDuration" class="hint"></p>
      <p id="sStatus" class="box" role="status" aria-live="polite">${P71_MESSAGES.READ_ONLY_DEFAULT}</p>
      <label class="checkRow"><input type="checkbox" id="sAuth"><span id="sAuthLabel"></span></label>
      <div class="grid2">
        <button id="sStartBtn" class="primary" style="grid-column:span 2">启动20:00待命（未勾选=只读预检）</button>
        <button id="sStopBtn" class="danger">停止任务</button>
        <button id="sReviewBtn">查看官方结果</button>
        <button id="sToggleLog">显示/隐藏日志</button>
        <button id="sCopyLog">复制脱敏日志</button>
      </div>
      <p class="hint">19:55起可正式待命；19:59:15自动重校时。保持Safari前台与屏幕常亮，切后台/锁屏自动中止不补发。</p>
      <p class="hint"><a href="${ORIGIN}/#!/Seat/Index/myBookingList" target="_blank" rel="noopener noreferrer">官方我的预约</a> · <span id="sCopyStatus"></span></p>
      <textarea id="sLogText" readonly hidden aria-label="整点脱敏日志"></textarea>
    </div>

    <div id="paneNormal" hidden>
      <p class="hint">复用 P7.0 普通模式：读取全部房间与当前空余座位，单次 1 小时正常预约。</p>
      <p id="nStatus" class="box" role="status" aria-live="polite">${P70_MESSAGES.READ_ONLY_DEFAULT}</p>
      <div class="grid2"><button id="nLogin">1. 检查登录</button><button id="nDates">2. 读取开放日期</button></div>
      <div class="fields">
        <label>预约日期（北京时间）<select id="nDate"><option value="">请先读取开放日期</option></select></label>
        <label>1小时时段<select id="nHour"><option value="">请先选择日期</option></select></label>
      </div>
      <div class="grid2"><button id="nQuery">3. 查询房间与空位</button><button id="nPrepare" disabled>4. 准备预约方案</button></div>
      <div class="fields">
        <label>选择房间<select id="nRoom" disabled><option value="">请先查询房间与空位</option></select></label>
        <label>当前空余座位<select id="nSeat" disabled><option value="">请先选择房间</option></select></label>
      </div>
      <p id="nRoomMeta" class="hint"></p>
      <div class="confirm">
        <p id="nPreview" style="font-weight:600">尚未准备预约方案</p>
        <label class="checkRow"><input id="nDetails" type="checkbox" disabled><span>确认上述房间、空位、日期与1小时时段。</span></label>
        <label class="checkRow"><input id="nRules" type="checkbox" disabled><span>确认馆方允许本次预约，授权最多1次提交。</span></label>
        <button id="nSubmit" class="primary" style="width:100%" disabled>5. 确认提交一次预约</button>
      </div>
      <div class="grid2">
        <button id="nReview">查看官方结果</button>
        <button id="nStop" class="danger">停止任务</button>
        <button id="nToggleLog">显示/隐藏日志</button>
        <button id="nCopyLog">复制脱敏日志</button>
      </div>
      <p class="hint"><a href="${ORIGIN}/#!/Seat/Index/myBookingList" target="_blank" rel="noopener noreferrer">官方我的预约</a> · <span id="nCopyStatus"></span></p>
      <textarea id="nLogText" readonly hidden aria-label="普通模式脱敏日志"></textarea>
    </div>
  </section>
  <button id="toggle" aria-expanded="false" data-tone="idle">162 · 待启动</button>`;

  const el = (id) => root.getElementById(id);
  let destroyed = false;
  let authDay = "";
  let schedView = null;

  const attach = () => {
    if (!destroyed && location.origin === ORIGIN && !host.isConnected)
      (document.documentElement || document.body)?.append(host);
  };
  attach();
  const observer = new MutationObserver(() => {
    if (!destroyed && location.origin === ORIGIN && !host.isConnected) attach();
  });
  observer.observe(document, { childList: true, subtree: true });

  const trusted = (fn) => (event) => {
    if (event.isTrusted) void fn();
  };

  el("toggle").onclick = trusted(() => {
    el("panel").hidden = !el("panel").hidden;
    el("toggle").setAttribute("aria-expanded", String(!el("panel").hidden));
  });

  // Tab switch
  const switchTab = (mode) => {
    const isSched = mode === "sched";
    el("tabSched").setAttribute("aria-selected", String(isSched));
    el("tabNormal").setAttribute("aria-selected", String(!isSched));
    el("paneSched").hidden = !isSched;
    el("paneNormal").hidden = isSched;
  };
  el("tabSched").onclick = trusted(() => switchTab("sched"));
  el("tabNormal").onclick = trusted(() => switchTab("normal"));

  // --- Scheduled 162 tab ---
  const updateDurationLabel = () => {
    const s = Number(el("sStart").value);
    const e = Number(el("sEnd").value);
    const hrs = e - s;
    el("sDuration").textContent =
      hrs > 0
        ? `固定：宋韵云图（四楼）162号 · ${String(s).padStart(2, "0")}:00—${String(e).padStart(2, "0")}:00（${hrs}小时 / ${hrs * 3600}秒 / 1人）`
        : "时段无效：结束时间必须晚于开始时间";
  };
  updateDurationLabel();

  const onTimeChange = () => {
    updateDurationLabel();
    actions.updateHours(Number(el("sStart").value), Number(el("sEnd").value));
  };
  el("sStart").onchange = onTimeChange;
  el("sEnd").onchange = onTimeChange;

  el("sStartBtn").onclick = trusted(() =>
    actions.start(el("sAuth").checked, authDay, Number(el("sStart").value), Number(el("sEnd").value)),
  );
  el("sStopBtn").onclick = trusted(() => actions.stop());
  el("sReviewBtn").onclick = trusted(() => actions.review());

  const copyHelper = async (textarea, statusEl, getter) => {
    try {
      const value = JSON.stringify(await getter(), null, 2);
      textarea.value = value;
      textarea.hidden = false;
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(value);
          statusEl.textContent = "脱敏日志已复制";
          return;
        } catch {
          /* Safari fallback */
        }
      }
      textarea.focus();
      textarea.select();
      statusEl.textContent = "请长按文本框全选复制";
    } catch {
      statusEl.textContent = "日志读取失败";
    }
  };

  el("sToggleLog").onclick = trusted(async () => {
    el("sLogText").value = JSON.stringify(await actions.exportSched(), null, 2);
    el("sLogText").hidden = !el("sLogText").hidden;
  });
  el("sCopyLog").onclick = trusted(() => copyHelper(el("sLogText"), el("sCopyStatus"), actions.exportSched));

  // --- Normal P7.0 tab (reuses IpadBookingEngine directly) ---
  let nRange = null;
  let nRooms = [];
  let nPreview = null;
  let nBusy = false;

  const nClear = () => {
    nPreview = null;
    el("nDetails").checked = el("nRules").checked = false;
    el("nDetails").disabled = el("nRules").disabled = true;
    el("nSubmit").disabled = true;
    el("nPreview").textContent = "尚未准备预约方案";
  };
  const nSyncBtns = () => {
    el("nPrepare").disabled = nBusy || !el("nDate").value || el("nHour").value === "" || !el("nRoom").value || !el("nSeat").value;
    el("nSubmit").disabled = nBusy || !nPreview || !el("nDetails").checked || !el("nRules").checked;
  };
  const nRenderHours = () => {
    el("nHour").replaceChildren();
    if (!nRange || !el("nDate").value) {
      el("nHour").append(new Option("请先选择日期", ""));
      return;
    }
    let cnt = 0;
    for (let h = nRange.min; h < nRange.max; h++) {
      if (Date.parse(`${el("nDate").value}T${String(h).padStart(2, "0")}:00:00+08:00`) <= Date.now()) continue;
      el("nHour").append(new Option(`${String(h).padStart(2, "0")}:00–${String(h + 1).padStart(2, "0")}:00`, String(h)));
      cnt++;
    }
    if (!cnt) el("nHour").append(new Option("当日无可约未来时段", ""));
  };
  const nRenderSeats = () => {
    const floorId = Number(el("nRoom").value);
    const room = nRooms.find((r) => r.floorId === floorId);
    el("nSeat").replaceChildren();
    if (!room) {
      el("nSeat").append(new Option("请先选择房间", ""));
      el("nSeat").disabled = true;
      nSyncBtns();
      return;
    }
    const free = room.seats.filter((s) => s.free);
    if (!free.length) {
      el("nSeat").append(new Option("该房间此时段无空位", ""));
      el("nSeat").disabled = true;
    } else {
      for (const s of free) el("nSeat").append(new Option(`${s.number}号（空闲）`, s.id));
      el("nSeat").disabled = nBusy;
    }
    nSyncBtns();
  };
  normalEngine.notify = ({ code }) => {
    el("nStatus").textContent = P70_MESSAGES[code] || `状态：${code}`;
  };
  const nRun = async (work, keep = false) => {
    if (nBusy) return;
    nBusy = true;
    if (!keep) nClear();
    for (const id of ["nLogin", "nDates", "nQuery", "nPrepare", "nReview", "nDate", "nHour", "nRoom", "nSeat"])
      el(id).disabled = true;
    el("nSubmit").disabled = true;
    try {
      await work();
    } catch (e) {
      nClear();
      el("nStatus").textContent = P70_MESSAGES[codeOf(e)] || `状态：${codeOf(e)}`;
    } finally {
      nBusy = false;
      for (const id of ["nLogin", "nDates", "nQuery", "nReview", "nDate", "nHour"]) el(id).disabled = false;
      el("nRoom").disabled = nRooms.length === 0;
      el("nSeat").disabled = nRooms.length === 0 || !el("nSeat").value;
      nSyncBtns();
    }
  };

  el("nLogin").onclick = trusted(() => nRun(() => normalEngine.checkLogin()));
  el("nDates").onclick = trusted(() =>
    nRun(async () => {
      nRange = await normalEngine.openDates();
      el("nDate").replaceChildren();
      for (const d of nRange.dates.filter((x) => x >= shanghaiDate())) el("nDate").append(new Option(d, d));
      nRenderHours();
    }),
  );
  el("nQuery").onclick = trusted(() =>
    nRun(async () => {
      const data = await normalEngine.queryRooms(el("nDate").value, Number(el("nHour").value));
      nRooms = data.rooms;
      el("nRoom").replaceChildren();
      for (const r of nRooms) el("nRoom").append(new Option(`${r.room}（空闲 ${r.freeCount}/${r.totalCount}）`, String(r.floorId)));
      nRenderSeats();
      el("nRoomMeta").textContent = `共 ${nRooms.length} 个房间，空闲 ${nRooms.reduce((a, r) => a + r.freeCount, 0)} 个；冲突：${data.conflicts}`;
    }),
  );
  el("nPrepare").onclick = trusted(() =>
    nRun(async () => {
      const floorId = Number(el("nRoom").value);
      const room = nRooms.find((r) => r.floorId === floorId);
      const seat = room?.seats.find((s) => s.id === el("nSeat").value);
      nPreview = await normalEngine.prepare({
        date: el("nDate").value,
        hour: Number(el("nHour").value),
        hours: 1,
        floorId,
        room: room?.room || "",
        seatId: seat?.id || "",
        seatNumber: seat?.number || "",
      });
      el("nPreview").textContent = slotSummary(nPreview.target);
      el("nDetails").disabled = el("nRules").disabled = false;
      nSyncBtns();
    }),
  );
  el("nDetails").onchange = el("nRules").onchange = nSyncBtns;
  el("nSubmit").onclick = trusted(() =>
    nRun(async () => {
      const p = nPreview;
      const perms = { details: el("nDetails").checked, rules: el("nRules").checked };
      nClear();
      const res = await normalEngine.confirm(p?.ticket, perms);
      if (res?.target) el("nPreview").textContent = slotSummary(res.target);
    }, true),
  );
  el("nReview").onclick = trusted(() => nRun(() => normalEngine.review()));
  el("nStop").onclick = trusted(() => {
    normalEngine.stop("STOPPED");
    nClear();
  });
  el("nDate").onchange = () => {
    normalEngine.clearSnapshot?.();
    nClear();
    nRenderHours();
    nRooms = [];
    el("nRoom").replaceChildren(new Option("日期已变，请重新查询", ""));
    el("nSeat").replaceChildren(new Option("请先查询", ""));
    el("nRoom").disabled = el("nSeat").disabled = true;
    nSyncBtns();
  };
  el("nHour").onchange = () => {
    normalEngine.clearSnapshot?.();
    nClear();
    nRooms = [];
    el("nRoom").replaceChildren(new Option("时段已变，请重新查询", ""));
    el("nSeat").replaceChildren(new Option("请先查询", ""));
    el("nRoom").disabled = el("nSeat").disabled = true;
    nSyncBtns();
  };
  el("nRoom").onchange = () => {
    nClear();
    nRenderSeats();
  };
  el("nSeat").onchange = () => {
    nClear();
    nSyncBtns();
  };
  el("nToggleLog").onclick = trusted(async () => {
    el("nLogText").value = JSON.stringify(await normalEngine.diagnosticExport(), null, 2);
    el("nLogText").hidden = !el("nLogText").hidden;
  });
  el("nCopyLog").onclick = trusted(() => copyHelper(el("nLogText"), el("nCopyStatus"), () => normalEngine.diagnosticExport()));

  return {
    root,
    host,
    newDay(task) {
      authDay = task.day;
      el("sAuth").checked = false;
      el("sAuth").disabled = false;
      el("sAuthLabel").textContent = `我确认馆方规则且手机未同时承担今日正式预约，授权 ${task.day} 最多一次提交。`;
    },
    renderScheduled(view) {
      schedView = view;
      const locked = view.formal || view.state === "PREPARING";
      el("sStart").disabled = locked;
      el("sEnd").disabled = locked;
      el("sAuth").disabled = locked;
      el("sStartBtn").disabled = locked;
      el("sTarget").textContent = `今日 ${view.task.day} → 预约 ${view.task.date} · 四楼162 (${scheduledTimeLabel(view.task)})`;
      const [label, tone] = P71_PHASES[view.state] || P71_PHASES.UNKNOWN;
      el("toggle").textContent = label;
      el("toggle").dataset.tone = tone;
      el("sStatus").textContent = P71_MESSAGES[view.reason] || `状态：${view.reason}`;
      if (!el("sLogText").hidden) {
        void actions.exportSched().then((d) => {
          el("sLogText").value = JSON.stringify(d, null, 2);
        });
      }
    },
    clock(task, now) {
      const remaining = Math.max(0, Math.ceil((task.open - now) / 1000));
      const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
      const ss = String(remaining % 60).padStart(2, "0");
      const text = `北京时间20:00 · ${remaining ? `剩余 ${mm}:${ss}` : "已到开放时点"}`;
      if (el("sClock").textContent !== text) el("sClock").textContent = text;
      if (remaining > 0 && schedView?.state === "WAITING") {
        const btnLabel = `162 · ${mm}:${ss}`;
        if (el("toggle").textContent !== btnLabel) el("toggle").textContent = btnLabel;
      }
    },
    destroy() {
      destroyed = true;
      observer.disconnect();
      host.remove();
    },
  };
}

  // --- src/userscript/p73/release-guard.js ---
function releaseResponseCode(body) {
  const code = responseCode(body);
  if (body?.CODE === "LIMITED") return "LIMITED";
  if (code !== "NOT_OPEN" && (code !== "RESPONSE_UNKNOWN" || body?.CODE !== "ParamError")) return code;
  const text = body?.DATA?.msg || body?.MESSAGE;
  return /未到(?:预约|开放)时间|(?:预约日期|预约时间)(?:尚)?未开放|超出可预约座位时间范围/.test(String(text))
    ? "NOT_OPEN"
    : "RESPONSE_UNKNOWN";
}
function checkReleaseRead(path, body) {
  check(releaseResponseCode(body) !== "LIMITED", "LIMITED");
  if (path.split("?")[0] === "/Seat/Index/myBookingList") {
    check(body?.CODE === undefined || body.CODE === "ok", "RECORDS_UNKNOWN");
  }
}

function overlapsConfirmed(row, target) {
  if (row.state !== "SUCCESS" || row.recordVerified !== true || row.target?.date !== target.date)
    return false;
  const bounds = (slot) => [slot.startHour ?? slot.hour, slot.endHour ?? slot.hour + (slot.hours ?? 1)];
  const [a, b] = bounds(row.target);
  const [x, y] = bounds(target);
  return a < y && x < b;
}
class ReleaseCoordinator extends CrossModeCoordinator {
  constructor(locks = globalThis.navigator?.locks) {
    super();
    this.locks = locks;
    this.limited = false;
  }

  async withCommit(run) {
    check(this.locks?.request, "CROSS_MODE_LOCK_UNAVAILABLE");
    return this.locks.request("hdu-ipad-booking-commit", { ifAvailable: true }, (lock) => {
      check(lock, "CROSS_MODE_ACTIVE_TASK");
      check(!this.limited, "LIMITED");
      return run();
    });
  }

  async checkForScheduled(account, task) {
    const conflict = await super.checkForScheduled(account);
    if (conflict || !task) return conflict;
    if (await this.scheduledStore.pendingUnknown(account))
      return { blockedByMode: "scheduled-p71", code: "PREVIOUS_UNKNOWN" };
    const normal = await this.normalStore.list(account);
    const scheduled = await this.scheduledStore.list(account);
    if ([...normal, ...scheduled].some((row) => overlapsConfirmed(row, task)))
      return { blockedByMode: "other-booking", code: "EXISTING" };
    return null;
  }

  async checkForNormal(account, target) {
    const conflict = await super.checkForNormal(account, target);
    if (conflict || !target) return conflict;
    const normal = await this.normalStore.list(account);
    const scheduled = await this.scheduledStore.list(account);
    if ([...normal, ...scheduled].some((row) => overlapsConfirmed(row, target)))
      return { blockedByMode: "other-booking", code: "EXISTING" };
    return null;
  }
}
class ReleaseNormalEngine extends IpadBookingEngine {
  constructor(io, ...args) {
    super(
      {
        clockValid: () => io.clockValid(),
        async request(path, options) {
          const response = await io.request(path, options);
          if (options?.write) {
            const code = releaseResponseCode(response.body);
            if (code !== responseCode(response.body)) {
              const error = new TestError(code);
              error.timing = response.timing;
              throw error;
            }
          }
          return response;
        },
      },
      ...args,
    );
  }

  async read(path, generation, form) {
    check(!this.coordinator.limited, "LIMITED");
    try {
      const body = await super.read(path, generation, form);
      checkReleaseRead(path, body);
      return body;
    } catch (error) {
      if (error.code === "LIMITED") this.coordinator.limited = true;
      throw error;
    }
  }

  async confirm(ticket, options) {
    try {
      const row = await this.coordinator.withCommit(() => super.confirm(ticket, options));
      if (row?.reason === "LIMITED") this.coordinator.limited = true;
      return row;
    } catch (error) {
      this.preview = null;
      throw error;
    }
  }
}

  // --- src/userscript/p73/engine.js ---
const P73_VERSION = "7.3.1";

const P73_REJECTED = new Set(["SEAT_UNAVAILABLE", "NOT_OPEN", "EXISTING"]);
const P73_PERF_FIELDS = [
  "openCheckMs",
  "gateToDispatchMs",
  "openConfirmToDispatchMs",
  "signLocalMs",
  "claimWriteMs",
  "uiUpdatesSuppressed",
  "deferredDiagWrites",
];

// Production Performance Candidate extending P7.1.1 ScheduledIpadEngine.
// Preserves ALL safety gates (double-gate open confirmation, single-write claim before fetch,
// 19:59:15 recalibration, Safari suspension guard, cross-mode exclusion, terminal protection).
// Optimizations strictly target critical-path local overhead and IndexedDB lock contention.
class PerformanceScheduledEngine extends ScheduledIpadEngine {
  constructor(io, store, notify = () => {}, env = {}) {
    super(io, store, notify, env);
    this.hotPathActive = false;
    this.deferredDiagWrites = 0;
    this.uiUpdatesSuppressed = 0;
    this.signTemplate = null;
    this.gatePassedMono = null;
    this.openConfirmedMono = null;
    this.perfMetrics = {
      openCheckMs: null,
      gateToDispatchMs: null,
      openConfirmToDispatchMs: null,
      signLocalMs: null,
      claimWriteMs: null,
      uiUpdatesSuppressed: 0,
      deferredDiagWrites: 0,
    };
  }

  noteUiSuppressed() {
    this.uiUpdatesSuppressed++;
    this.perfMetrics.uiUpdatesSuppressed = this.uiUpdatesSuppressed;
  }

  buildSignTemplate() {
    if (!this.identity?.uid) return null;
    const { seatId, begin, duration } = this.task;
    check(
      Number.isSafeInteger(duration) && duration >= 3600 && duration <= 86400 && duration % 3600 === 0,
      "INVALID_DURATION",
    );
    return {
      prefix: `post&${BOOK_PATH}&api_time`,
      suffix: `&beginTime${begin}&duration${duration}&is_recommend0&seatBookers[0]${this.identity.uid}&seats[0]${seatId}`,
      beginStr: String(begin),
      durationStr: String(duration),
      seatId,
      uid: this.identity.uid,
    };
  }

  fastSign(apiTime) {
    const tpl = this.signTemplate || this.buildSignTemplate();
    check(
      tpl?.uid === this.identity?.uid &&
        tpl?.seatId === this.task.seatId &&
        tpl.beginStr === String(this.task.begin) &&
        tpl.durationStr === String(this.task.duration),
      "IDENTITY_CHANGED",
    );
    check(Number.isSafeInteger(apiTime) && apiTime > 0, "INVALID_TIME");
    const t0 = this.mono();
    const apiTimeStr = String(apiTime);
    const token = btoa(md5(`${tpl.prefix}${apiTimeStr}${tpl.suffix}`));
    const form = new URLSearchParams({
      beginTime: tpl.beginStr,
      duration: tpl.durationStr,
      is_recommend: "0",
      api_time: apiTimeStr,
      "seats[0]": tpl.seatId,
      "seatBookers[0]": tpl.uid,
    });
    const elapsed = this.mono() - t0;
    if (this.perfMetrics.signLocalMs == null) this.perfMetrics.signLocalMs = elapsed;
    return { token, form };
  }

  persistDiagnostics() {
    // Avoid IndexedDB readwrite lock contention with store.claim() during the 20:00 hot release path.
    if (this.hotPathActive) {
      this.deferredDiagWrites++;
      this.perfMetrics.deferredDiagWrites = this.deferredDiagWrites;
      return;
    }
    super.persistDiagnostics();
  }

  async prepare(opts = {}) {
    if (!this.formal && !this.busy && this.coordinator?.limited) {
      this.emit("STOPPED", "LIMITED");
      return this.view();
    }
    const res = await super.prepare(opts);
    if (this.waiting && this.identity?.uid) {
      this.signTemplate = this.buildSignTemplate();
    }
    return res;
  }

  async read(path, g, form, observe = true) {
    check(!this.coordinator?.limited, "LIMITED");
    try {
      const body = await super.read(path, g, form, observe);
      checkReleaseRead(path, body);
      if (path === "/User/Center/baseInfo" && this.identity) {
        check(body?.DATA?.is_login === true, "AUTH_REQUIRED");
        check(String(body.DATA.uid) === this.identity.uid, "IDENTITY_CHANGED");
      }
      return body;
    } catch (error) {
      if (codeOf(error) === "LIMITED") {
        this.staticCache.roomQueryEntry = this.staticCache.mappingEntry = null;
        if (this.coordinator) this.coordinator.limited = true;
      }
      throw error;
    }
  }

  async tick() {
    if (!this.waiting || this.busy) return;
    const g = this.generation;
    try {
      check(!this.store.stopped(), "USER_STOPPED");
      check(this.visible(), "FOREGROUND_REQUIRED");
      this.checkTimerIntegrity();

      const toOpen = this.task.open - this.wall();
      if (!this.recalibrated && toOpen <= P71_RECALIBRATE_BEFORE_MS && toOpen > 3000) {
        await this.recalibrateClock(g);
        return;
      }
      if (toOpen > 0) {
        if (this.recalibrated) this.clock.bounds();
        return;
      }

      this.clock.deadline();
      if (!this.clock.released()) return;

      const bounds = this.clock.bounds();
      if (this.gatePassedMono == null) this.gatePassedMono = this.mono();
      this.mark({
        firstGatePassedAt: this.iso(),
        gateClockLowerMs: bounds.lower,
        gateClockUpperMs: bounds.upper,
        gateClockPhoneOffsetMs: bounds.phoneOffsetMs,
        gateClockSampleRttMs: bounds.sampleRttMs,
      });

      if (this.mono() < this.nextOpeningCheckMono) return;
      check(this.openRangePath && this.openRangeCategory && this.openingChecks < 2, "OPEN_RANGE_UNCONFIRMED");

      this.busy = true;
      this.hotPathActive = true;
      this.setStage("OPEN_CONFIRM");
      this.openingChecks++;
      const openCheckStartMono = this.mono();
      this.mark({ openingCheckStartedAt: this.iso() });
      this.emit("WAITING", "OPEN_RANGE_CHECKING");

      // Mandatory real-time open confirmation (never bypassed in production).
      const body = await this.read(this.openRangePath, g, undefined, false);
      this.ensure(g);
      this.lastTickWall = this.wall();
      this.lastTickMono = this.mono();
      const group = category(body?.data);
      check(
        group.category_id === this.openRangeCategory.category_id &&
          group.content_id === this.openRangeCategory.content_id,
        "OPEN_RANGE_UNCONFIRMED",
      );
      const result = openingScheduledRange(body?.data?.range, this.task);
      check(!this.store.stopped() && this.visible(), "FOREGROUND_REQUIRED");
      this.clock.deadline();
      check(this.clock.released(), "NOT_RELEASED");

      if (!result.open) {
        check(this.openingChecks < 2, "OPEN_RANGE_UNCONFIRMED");
        this.nextOpeningCheckMono = this.mono() + 1000;
        this.hotPathActive = false;
        this.emit("WAITING", "OPEN_RANGE_NOT_YET");
        return;
      }

      this.openConfirmedMono = this.mono();
      if (this.perfMetrics.openCheckMs == null) {
        this.perfMetrics.openCheckMs = this.openConfirmedMono - openCheckStartMono;
      }
      this.openProofGeneration = g;
      this.mark({ openConfirmedAt: this.iso(), confirmedMaxDateExclusive: result.maxDateExclusive });
      this.emit("WAITING", "OPEN_RANGE_CONFIRMED");
      this.busy = false;
      await this.submit();
    } catch (error) {
      this.hotPathActive = false;
      const code = codeOf(error);
      const diag = this.lastHttpDiag || {};
      this.lastHttpDiag = null;
      this.mark({
        stoppedEndpoint: diag.endpoint || null,
        httpStatus: diag.httpStatus ?? null,
        normalizedBusinessCode: diag.normalizedBusinessCode || code,
      });
      if (g === this.generation) await this.stop(code);
    } finally {
      this.hotPathActive = false;
      this.busy = false;
    }
  }

  async submit() {
    this.busy = true;
    this.waiting = false;
    try {
      check(this.coordinator, "CROSS_MODE_LOCK_UNAVAILABLE");
      await this.coordinator.withCommit(() => this.submitLocked());
    } catch (error) {
      this.hotPathActive = false;
      await this.stop(codeOf(error));
    } finally {
      this.busy = false;
    }
  }

  async submitLocked() {
    this.busy = true;
    this.waiting = false;
    this.hotPathActive = true;
    this.setStage("SUBMIT");
    const g = this.generation;
    const localStart = this.mono();
    let claimed = false;
    let reason = "LOCAL_ERROR";
    let verification = null;
    let submitHttpStatus = null;

    try {
      this.ensure(g);
      check(this.openProofGeneration === g && this.timings.openConfirmedAt, "OPEN_RANGE_UNCONFIRMED");
      check(this.formal && !this.attempted && this.visible() && !this.store.stopped(), "WRITE_GATE_CLOSED");
      if (this.coordinator) {
        const conflict = await this.coordinator.checkForScheduled(this.identity.account, this.task);
        if (conflict) {
          this.mark({ crossModeConflict: conflict });
          check(false, conflict.code);
        }
      }
      this.clock.deadline();
      check(this.clock.released(), "NOT_RELEASED");

      // Mandatory strict durable write-intent claim BEFORE fetch (zero IndexedDB contention from deferred diag writes).
      const claimStart = this.mono();
      const claim = await this.store.claim(this.key, this.owner, this.iso());
      if (this.perfMetrics.claimWriteMs == null) this.perfMetrics.claimWriteMs = this.mono() - claimStart;
      check(claim.won, "BUDGET_SPENT");
      claimed = true;
      this.attempted = true;

      this.ensure(g);
      check(!this.coordinator.limited, "LIMITED");
      check(this.visible() && !this.store.stopped(), "USER_STOPPED");
      this.clock.deadline();
      check(this.clock.released(), "NOT_RELEASED");

      const request = this.fastSign(Math.floor(this.wall() / 1000));
      this.mark({ preSubmitLocalMs: this.mono() - localStart });
      this.emit("SUBMITTING", "SUBMITTING_ONCE");
      this.countRequest("POST", BOOK_PATH);

      const response = await this.io.request(BOOK_PATH, {
        ...request,
        write: true,
        signal: this.controller.signal,
        onDispatch: (at) => {
          this.ensure(g);
          check(!this.coordinator.limited, "LIMITED");
          check(this.openProofGeneration === g, "OPEN_RANGE_UNCONFIRMED");
          check(this.visible() && !this.store.stopped(), "USER_STOPPED");
          this.clock.deadline();
          check(this.clock.released(), "NOT_RELEASED");
          const nowMono = this.mono();
          if (this.gatePassedMono != null && this.perfMetrics.gateToDispatchMs == null) {
            this.perfMetrics.gateToDispatchMs = nowMono - this.gatePassedMono;
          }
          if (this.openConfirmedMono != null && this.perfMetrics.openConfirmToDispatchMs == null) {
            this.perfMetrics.openConfirmToDispatchMs = nowMono - this.openConfirmedMono;
          }
          this.mark({ firstDispatchAt: at });
        },
        onHeaders: (sample) => {
          submitHttpStatus = sample?.status ?? null;
          this.mark({
            firstResponseAt: sample.timing?.responseAt || this.iso(),
            dispatchToHeadersMs: sample.timing?.dispatchToHeadersMs,
            httpStatus: submitHttpStatus,
          });
        },
        onBusiness: (body, timing) => {
          const code = releaseResponseCode(body);
          const at = timing.businessResultAt || this.iso();
          this.mark({
            firstBusinessResultAt: at,
            firstServerSuccessAt: code === "SERVER_SUCCESS" ? at : undefined,
            responseCode: code,
            normalizedBusinessCode: code,
            bodyDecodeMs: timing.bodyDecodeMs,
          });
        },
      });
      this.mark({ totalRequestMs: response.timing?.totalRequestMs ?? null });
      reason = releaseResponseCode(response.body);
      this.mark({ responseCode: reason, normalizedBusinessCode: reason, resultStateUpdatedAt: this.iso() });
    } catch (error) {
      reason = codeOf(error);
      this.mark({
        responseCode: reason,
        normalizedBusinessCode: reason,
        stoppedEndpoint: "/Seat/Index/bookSeats",
        httpStatus: submitHttpStatus,
        resultStateUpdatedAt: this.iso(),
      });
      if (error.timing?.totalRequestMs != null) this.mark({ totalRequestMs: error.timing.totalRequestMs });
    } finally {
      // Release hot-path lock after fetch completes so diagnostics flush cleanly.
      this.hotPathActive = false;
    }

    const immediate = !claimed
      ? "STOPPED"
      : ["LIMITED", "AUTH_REQUIRED"].includes(reason)
        ? "FAILED"
        : "UNKNOWN";
    if (reason === "LIMITED") this.coordinator.limited = true;
    this.emit(reason === "SERVER_SUCCESS" ? "VERIFYING" : immediate, reason);

    if (claimed) {
      try {
        const persisted = await this.store.finish(this.key, this.owner, {
          state: immediate,
          reason,
          timings: { ...this.timings, ...this.perfMetrics },
          logs: this.logs.slice(-60),
        });
        if (persisted?.state === "SUCCESS") {
          this.setStage("DONE");
          this.emit("SUCCESS", "RECORD_VERIFIED");
          this.busy = false;
          return;
        }
        if (
          g === this.generation &&
          !["LIMITED", "AUTH_REQUIRED"].includes(reason) &&
          !this.store.stopped()
        ) {
          this.setStage("VERIFY");
          verification = await this.verify(g);
        }
        const state =
          verification === true
            ? "SUCCESS"
            : verification === false && P73_REJECTED.has(reason)
              ? "FAILED"
              : immediate;
        const finalReason = verification === true ? "RECORD_VERIFIED" : reason;
        const finalRow = await this.store.finish(this.key, this.owner, {
          state,
          reason: finalReason,
          recordVerified: verification === true,
          timings: { ...this.timings, ...this.perfMetrics },
          logs: this.logs.slice(-60),
        });
        if (finalRow?.state === "SUCCESS") {
          this.setStage("DONE");
          this.emit("SUCCESS", "RECORD_VERIFIED");
          this.busy = false;
          return;
        }
        this.setStage("DONE");
        this.emit(
          g !== this.generation && state !== "SUCCESS" ? "UNKNOWN" : state,
          g !== this.generation && state !== "SUCCESS" ? "USER_STOPPED" : finalReason,
        );
      } catch (error) {
        this.emit("UNKNOWN", codeOf(error));
      }
    }
    this.busy = false;
  }

  async diagnosticExport() {
    const base = await super.diagnosticExport();
    base.version = P73_VERSION;
    if (base.current) {
      base.current.version = P73_VERSION;
      for (const k of P73_PERF_FIELDS) {
        base.current[k] = this.perfMetrics[k] ?? base.current[k] ?? null;
      }
    }
    return base;
  }
}

  // --- src/userscript/p73/panel.js ---
// Thin P7.3 UI wrapper around proven P7.1.1 Shadow DOM panel:
// - Updates branding & 19:57 operational guidance
// - Suppresses non-critical live log textarea JSON serialization during 20:00 hot path
// - Disables tab switching while scheduled task is actively PREPARING/WAITING/SUBMITTING
function mountP73Panel(actions, normalEngine) {
  const panel = mountP71Panel(actions, normalEngine);
  const el = (id) => panel.root.getElementById(id);

  const heading = panel.root.querySelector("h2");
  if (heading) heading.textContent = "P7.3 iPad 正式性能版 · 162整点 & 普通预约";

  const startBtn = el("sStartBtn");
  if (startBtn) startBtn.textContent = "启动20:00待命（建议19:57正式启动 · 未勾选=只读预检）";

  const hints = panel.root.querySelectorAll("#paneSched .hint");
  if (hints.length >= 3) {
    hints[2].textContent =
      "建议19:57起正式待命（19:55起已开放窗口）；19:59:15自动重校时。保持Safari前台与屏幕常亮，切后台/锁屏自动中止不补发。";
  }

  let lastRenderSig = "";
  const origRender = panel.renderScheduled;
  panel.renderScheduled = (view) => {
    const inHotPath =
      view.state === "SUBMITTING" ||
      view.state === "VERIFYING" ||
      (view.state === "WAITING" &&
        ["OPEN_RANGE_CHECKING", "OPEN_RANGE_CONFIRMED", "RECALIBRATING_CLOCK"].includes(view.reason));

    const sig = `${view.task.day}:${view.task.startHour}-${view.task.endHour}:${view.state}:${view.reason}:${view.formal}`;
    if (sig === lastRenderSig) return;
    lastRenderSig = sig;

    const tabNormal = el("tabNormal");
    if (tabNormal) tabNormal.disabled = view.formal || view.waiting || view.state === "PREPARING";

    // Prevent heavy JSON.stringify DOM updates on the hot 20:00 release path.
    const logBox = el("sLogText");
    const wasLogOpen = logBox && !logBox.hidden;
    if (inHotPath && wasLogOpen) {
      logBox.hidden = true;
      actions.onUiSuppressed?.();
    }
    origRender(view);
  };

  return panel;
}

  // --- src/userscript/p73/entry.js ---
function bootIpadP73() {
  if (
    location.origin !== ORIGIN ||
    window.top !== window.self ||
    window.__HDU_P73_MOUNTED__ ||
    document.getElementById("hdu-p71-host")
  )
    return;
  window.__HDU_P73_MOUNTED__ = true;

  let startHour = 8;
  let endHour = 22;
  let current = null;
  let panel = null;

  const sessionStaticCache = { roomQueryEntry: null, mappingEntry: null };
  const coordinator = new ReleaseCoordinator();

  const normalStore = new IpadStore();
  const normalEngine = new ReleaseNormalEngine(new Transport(), normalStore, () => {}, { coordinator });
  coordinator.attachNormal(normalEngine, normalStore);

  const createScheduled = (task) => {
    const store = new ScheduledIpadStore(task);
    const engine = new PerformanceScheduledEngine(
      new Transport(),
      store,
      (v) => {
        if (engine === current) panel?.renderScheduled(v);
      },
      { task, staticCache: sessionStaticCache, coordinator },
    );
    coordinator.attachScheduled(engine, store);
    return engine;
  };

  function dayCheck(forceRecreate = false) {
    const task = scheduledTask(Date.now(), startHour, endHour);
    if (!forceRecreate && current?.task.day === task.day) return false;
    if (current?.formal) void current.suspend("AUTHORIZATION_EXPIRED");
    current = createScheduled(task);
    panel?.newDay(task);
    panel?.renderScheduled(current.view());
    return true;
  }

  const runSafe = async (fn) => {
    try {
      await fn();
    } catch (e) {
      current?.emit(current.attempted ? "UNKNOWN" : "STOPPED", codeOf(e));
    }
  };

  panel = mountP73Panel(
    {
      updateHours: (s, e) => {
        if (current?.formal || current?.busy || current?.waiting) return;
        if (Number.isInteger(s) && Number.isInteger(e) && s >= 0 && e <= 24 && s < e) {
          startHour = s;
          endHour = e;
          dayCheck(true);
        }
      },
      start: (arm, authorizedDay, s, e) =>
        runSafe(async () => {
          if (dayCheck()) return;
          if (!current.formal && !current.busy && !current.waiting && (s !== startHour || e !== endHour)) {
            if (!(Number.isInteger(s) && Number.isInteger(e) && s >= 0 && e <= 24 && s < e)) {
              current.emit("STOPPED", "INVALID_DURATION");
              return;
            }
            startHour = s;
            endHour = e;
            dayCheck(true);
          }
          await current.prepare({ arm, confirmed: arm, authorizedDay });
        }),
      stop: () => runSafe(() => current.suspend("USER_STOPPED")),
      review: () => runSafe(() => current.review()),
      exportSched: () => current.diagnosticExport(),
      onUiSuppressed: () => current?.noteUiSuppressed?.(),
    },
    normalEngine,
  );

  dayCheck(true);

  const suspendAll = (code = "FOREGROUND_REQUIRED") => {
    if (current?.formal || current?.waiting) void current.suspend(code);
    normalEngine.suspend(code);
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") suspendAll("FOREGROUND_REQUIRED");
    else dayCheck();
  });
  document.addEventListener("freeze", () => suspendAll("FOREGROUND_REQUIRED"));
  window.addEventListener("pagehide", () => suspendAll("FOREGROUND_REQUIRED"));
  window.addEventListener("storage", (event) => {
    if (current?.formal && current.store.stopped()) void current.suspend("USER_STOPPED");
    if (event.key === "hdu-p70:stop") normalEngine.suspend("STOPPED");
  });

  // Adaptive timer: 250ms idle -> 50ms within 5s of 20:00 -> 20ms within 1.5s of 20:00 / open confirmation.
  const loop = () => {
    dayCheck();
    const now = Date.now();
    if (current && !current.formal && current.state === "IDLE" && now >= current.task.open) {
      current.emit("EXPIRED", "PREPARE_WINDOW");
    }
    if (current) {
      panel.clock(current.task, now);
      void current.tick();
    }
    const toOpen = current ? current.task.open - now : Infinity;
    const interval = current?.waiting ? (toOpen <= 1500 ? 20 : toOpen <= 5000 ? 50 : 250) : 250;
    setTimeout(loop, interval);
  };
  loop();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootIpadP73, { once: true });
} else {
  bootIpadP73();
}
})();
