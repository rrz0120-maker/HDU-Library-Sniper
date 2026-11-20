// ==UserScript==
// @name         杭电图书馆 P7.0 iPad 原生预约验证 (Phase 1)
// @namespace    https://github.com/rrz0120-maker/HDU-Library-Sniper/p70-ipad
// @version      7.0.2-phase1
// @description  iPad Safari + Userscripts 独立实验版：同源只读查询房间与当前空余座位，经明确双确认后完成单次1小时正常预约与官方记录核验；不含20:00抢座、不重试、不伪造旧凭据。
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
    check(!this.busy, "BUSY");
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

  // --- src/userscript/p70/entry.js ---
function bootIpadP70() {
  if (
    location.origin !== ORIGIN ||
    window.top !== window.self ||
    window.__HDU_P70_MOUNTED__ ||
    document.getElementById("hdu-p70-host")
  )
    return;
  window.__HDU_P70_MOUNTED__ = true;
  const store = new IpadStore();
  const engine = new IpadBookingEngine(new Transport(), store);
  mountIpadPanel(engine);

  const suspend = () => engine.suspend("FOREGROUND_REQUIRED");
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") suspend();
  });
  window.addEventListener("pagehide", suspend);
  window.addEventListener("storage", (event) => {
    if (event.key === `${store.prefix}stop`) engine.suspend("STOPPED");
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootIpadP70, { once: true });
} else {
  bootIpadP70();
}
})();
