// P5.1: the request/signature contract follows crates/hdu/src/library/{parse,booking,catalog}.rs.
export const ORIGIN = "https://hdu.huitu.zhishulib.com";
export const BOOK_PATH = "/Seat/Index/bookSeats?LAB_JSON=1";
const DAY = 86400000;
export class TestError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
export function check(condition, code) {
  if (!condition) throw new TestError(code);
}
export function codeOf(error) {
  return error instanceof TestError ? error.code : "LOCAL_ERROR";
}
export function integer(value) {
  if (typeof value === "string" && /^\d+$/.test(value)) value = Number(value);
  check(Number.isSafeInteger(value), "CONTRACT_UNKNOWN");
  return value;
}
const scalar = (v) => (typeof v === "string" || typeof v === "number" ? String(v) : "");
export function shanghaiDate(ms = Date.now()) {
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
export function rangeMidnight(value) {
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
export function beginTime(selection) {
  check(["162", "157"].includes(selection.seat), "SEAT_NOT_ALLOWED");
  const hour = integer(selection.hour);
  check(hour >= 0 && hour < 24 && selection.hours === 1, "INVALID_TIME");
  return midnight(selection.date) / 1000 + hour * 3600;
}
export function inspectRange(range) {
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
export function parseRange(raw) {
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
export function validateSelection(selection, range, now = Date.now()) {
  const begin = beginTime(selection);
  check(range.dates.includes(selection.date) && begin * 1000 > now, "DATE_OR_TIME_NOT_OPEN");
  check(selection.hour >= range.min && selection.hour + 1 <= range.max, "INVALID_TIME");
  return begin;
}
export function roomMatches(name) {
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
export function roomQuery(body) {
  const items = [body.content, body.data, body.DATA].map(defaultItems).find(Boolean);
  const rooms = items?.filter((r) => r.name === "自习室") || [];
  check(rooms.length === 1, "ROOM_NOT_UNIQUE");
  const link = rooms[0].link;
  const url = new URL(typeof link === "string" ? link : link?.url, ORIGIN);
  check(url.origin === ORIGIN && url.pathname === "/Seat/Index/searchSeats", "INVALID_ROOM_LINK");
  url.searchParams.set("LAB_JSON", "1");
  return url.pathname + url.search;
}
export function category(data) {
  const id = scalar(data?.space_category?.category_id),
    content = scalar(data?.space_category?.content_id);
  check(/^\d+$/.test(id) && id !== "0" && /^\d+$/.test(content), "CATEGORY_UNKNOWN");
  return { category_id: id, content_id: content };
}
export function resolveSeats(body) {
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
export function records(body) {
  check(Array.isArray(body?.content?.defaultItems), "RECORDS_UNKNOWN");
  return body.content.defaultItems;
}
export function conflicts(items, selection) {
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
export function verified(items, preview) {
  return conflicts(items, preview.selection).some(
    (r) =>
      integer(r.time) === beginTime(preview.selection) &&
      integer(r.duration) === 3600 &&
      scalar(r.seatNum).trim() === preview.selection.seat &&
      r.roomName === preview.mapping.room,
  );
}
// RFC 1321 MD5. No remote dependencies; UTF-8 input matches Rust source.as_bytes().
export function md5(source) {
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
export function signedRequest(seatId, uid, begin, apiTime, duration = 3600) {
  check(duration === 3600 || duration === 50400, "INVALID_DURATION");
  return bookSeatRequest(seatId, uid, begin, apiTime, duration);
}
// Callers validate their own slot policy. Keep the wire contract shared.
export function bookSeatRequest(seatId, uid, begin, apiTime, duration) {
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
export function responseCode(body) {
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
export function summary(selection) {
  return `${selection.date} ${String(selection.hour).padStart(2, "0")}:00–${String(selection.hour + 1).padStart(2, "0")}:00 · 1小时 / 1人 · 宋韵云图（四楼）${selection.seat}号`;
}

export function mappingFingerprint(mapping) {
  return JSON.stringify([mapping.floorId, mapping.room, mapping.seats.map((s) => [s.number, s.id])]);
}
