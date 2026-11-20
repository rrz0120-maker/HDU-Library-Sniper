import { check, integer, rangeMidnight, roomMatches } from "../core.js";

export const P70_VERSION = "7.0.2-phase1";
export const P70_RECORD_PATH = "/Seat/Index/myBookingList?fromType=web&LAB_JSON=1";
export const P70_DURATION = 3600;
export const P70_PREVIEW_TTL_MS = 300000;

const p70Scalar = (v) => (typeof v === "string" || typeof v === "number" ? String(v) : "");

export function safeRandomId() {
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

export function resolveRoomsAndSeats(body) {
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

export function slotBeginTime(selection) {
  check(selection && typeof selection === "object", "INVALID_TIME");
  const hour = integer(selection.hour);
  const hours = selection.hours ?? 1;
  check(hour >= 0 && hour < 24 && hours === 1, "INVALID_TIME");
  return rangeMidnight(selection.date) / 1000 + hour * 3600;
}

export function validateSlotSelection(selection, range, now = Date.now()) {
  const begin = slotBeginTime(selection);
  check(range && Array.isArray(range.dates), "DATE_CONTRACT_UNKNOWN");
  check(range.dates.includes(selection.date) && begin * 1000 > now, "DATE_OR_TIME_NOT_OPEN");
  check(selection.hour >= range.min && selection.hour + 1 <= range.max, "INVALID_TIME");
  return begin;
}

export function resolveSelectedSeat(rooms, selection) {
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

export function slotConflicts(items, selection) {
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

export function verifiedSlot(items, target) {
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

export function slotKey(account, target) {
  const hourStr = String(integer(target.hour)).padStart(2, "0");
  return `${account}:${target.date}:${hourStr}:00-1h:${target.floorId}:${target.seatId}`;
}

export function slotFingerprint(target) {
  return JSON.stringify([target.floorId, target.room, target.seatNumber, target.seatId]);
}

export function slotSummary(target) {
  const h = String(integer(target.hour)).padStart(2, "0");
  const nextH = String(integer(target.hour) + 1).padStart(2, "0");
  return `${target.date} ${h}:00–${nextH}:00 · 1小时 / 1人 · ${target.room} ${target.seatNumber}号`;
}

export function p70Pending(row) {
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
export function publicIpadDiagnostics(row) {
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
