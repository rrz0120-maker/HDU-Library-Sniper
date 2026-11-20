import {
  BOOK_PATH,
  check,
  integer,
  md5,
  parseRange,
  rangeMidnight,
  roomMatches,
  shanghaiDate,
} from "../core.js";
import { P70_RECORD_PATH } from "../p70/policy.js";

export const P71_VERSION = "7.1.0";
export const P71_SEAT = Object.freeze({
  seat: "162",
  seatId: "62726",
  floorId: 1558,
  room: "宋韵云图（四楼）",
});
export const P71_PREPARE_MS = 300000; // 19:55:00 to 20:00:00
export const P71_RECALIBRATE_BEFORE_MS = 45000; // 19:59:15 automatic fresh clock sample
export const P71_SAMPLE_MAX_AGE_MS = 60000; // reject stale samples older than 60s
export const P71_LATE_MS = 10000; // conservative 20:00:00–20:00:10 window
export const P71_TIMER_DRIFT_MAX_MS = 1500; // detect Safari tab suspension / lock-screen stall
export const P71_RECORD_PATH = P70_RECORD_PATH;

const p71Scalar = (v) => (typeof v === "string" || typeof v === "number" ? String(v) : "");

export function scheduledTask(now = Date.now(), startHour = 8, endHour = 22) {
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

export function validateScheduledTask(task) {
  check(task && typeof task === "object", "TASK_INVALID");
  const canonical = scheduledTask(task.open, task.startHour, task.endHour);
  for (const key of Object.keys(canonical)) check(task[key] === canonical[key], "TASK_INVALID");
  check(task.begin + task.duration === Date.parse(`${task.date}T${String(task.endHour).padStart(2, "0")}:00:00+08:00`) / 1000, "INVALID_DURATION");
}

export function scheduledTaskKey(account, task) {
  return `${account}:${task.date}:162`;
}

export function scheduledTimeLabel(task) {
  const s = String(task.startHour).padStart(2, "0");
  const e = String(task.endHour).padStart(2, "0");
  return `${s}:00—${e}:00`;
}

export function validateScheduledRange(raw, now, task) {
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
export function openingScheduledRange(raw, task) {
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

export function resolveScheduled162(body) {
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

export function scheduledOverlaps(items, task) {
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

export function verifiedScheduled162(items, mapping, task) {
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
export function signedScheduledRequest(seatId, uid, begin, apiTime, duration) {
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

export class ScheduledClock {
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

export function p71Pending(row) {
  return row?.attempts === 1 && !["SUCCESS", "FAILED"].includes(row.state);
}

export const P71_FIRST_FIELDS = [
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

export function mergeP71Diagnostics(old = {}, incoming = {}) {
  const merged = { ...old };
  for (const field of P71_FIRST_FIELDS) {
    if (merged[field] == null && incoming[field] != null) merged[field] = incoming[field];
  }
  if (incoming.maxTimerDriftMs != null) {
    merged.maxTimerDriftMs = Math.max(old.maxTimerDriftMs || 0, incoming.maxTimerDriftMs);
  }
  if (incoming.lastReviewedAt && (!old.lastReviewedAt || incoming.lastReviewedAt > old.lastReviewedAt)) {
    merged.lastReviewedAt = incoming.lastReviewedAt;
  }
  return merged;
}

export function publicScheduledDiagnostics(row) {
  if (!row) return null;
  const fields = Object.fromEntries(P71_FIRST_FIELDS.map((k) => [k, row[k] ?? row.timings?.[k] ?? null]));
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
    lastReviewedAt: row.lastReviewedAt || null,
    events: (row.logs || []).slice(-60).map((e) => ({
      at: e.at,
      state: e.state,
      code: e.code || e.reason,
      ...(e.httpStatus != null ? { httpStatus: e.httpStatus } : {}),
      ...(e.endpoint ? { endpoint: e.endpoint } : {}),
    })),
    timingMeaning:
      "所有耗时与时间戳均为iPad Safari客户端观测值，不分离网络与服务端耗时；日志已脱敏，不含账号、凭据或原始响应体",
  };
}
