import { check, integer, parseRange, rangeMidnight, roomMatches, shanghaiDate } from "../core.js";

// One dated operation, deliberately not a configurable/fallback scheduler.
export const TASK = Object.freeze({
  date: "2026-11-19",
  open: Date.parse("2026-11-17T20:00:00+08:00"),
  begin: Date.parse("2026-11-19T08:00:00+08:00") / 1000,
  duration: 50400,
  seat: "162",
  seatId: "62726",
  floorId: 1558,
  room: "宋韵云图（四楼）",
});
export const PREPARE_MS = 120000;
export const LATE_MS = 10000;
export const RECORD_PATH = "/Seat/Index/myBookingList?fromType=web&LAB_JSON=1";
export const TASK_SUFFIX = `${TASK.date}:08:00-22:00`;

export function taskKey(account) {
  return `${account}:${TASK_SUFFIX}`;
}
export function checkSchedule() {
  check(shanghaiDate(TASK.open + 2 * 86400000) === TASK.date, "DATE_RULE_MISMATCH");
  check(TASK.begin + TASK.duration === Date.parse(`${TASK.date}T22:00:00+08:00`) / 1000, "INVALID_DURATION");
}
export function targetRange(raw, now) {
  const range = parseRange(raw);
  check(
    range.min <= 8 && range.max >= 22 && integer(raw.min_duration) <= 14 && integer(raw.max_duration) >= 14,
    "FOURTEEN_HOURS_NOT_ALLOWED",
  );
  // Before release, only the FIRST EXCLUDED date may be the target. A wildly
  // different rolling range is not evidence for the user's stated +2 policy.
  check(range.dates.includes(TASK.date) || range.maxDateExclusive === TASK.date, "DATE_RULE_MISMATCH");
  check(rangeMidnight(raw.advance_date) <= TASK.begin * 1000, "DATE_RULE_MISMATCH");
  // Read a future slot in the currently legal range. Its occupancy is irrelevant
  // to the target date; this read proves physical mapping only.
  for (const date of range.dates) {
    for (let hour = range.min; hour + 1 <= range.max; hour++) {
      const begin = rangeMidnight(date) / 1000 + hour * 3600;
      if (begin * 1000 > now + 60000) return { ...range, mapBegin: begin, mapDate: date };
    }
  }
  check(false, "NO_LEGAL_MAPPING_SLOT");
}
export function resolve162(body) {
  const floors = body?.allContent?.children?.[2]?.children?.children;
  check(Array.isArray(floors), "SEAT_RESPONSE_UNKNOWN");
  const rooms = floors.filter((f) => roomMatches(f.roomName));
  check(rooms.length === 1, "ROOM_NOT_UNIQUE");
  const room = rooms[0];
  check(
    integer(room.seatMap?.info?.id) === TASK.floorId && Array.isArray(room.seatMap?.POIs),
    "MAPPING_INVALID",
  );
  const seats = room.seatMap.POIs.filter((p) => String(p.title).trim() === TASK.seat);
  check(seats.length === 1 && String(seats[0].id) === TASK.seatId, "MAPPING_INVALID");
  check(room.seatMap.POIs.filter((p) => String(p.id) === TASK.seatId).length === 1, "MAPPING_INVALID");
  return { floorId: TASK.floorId, room: room.roomName, number: TASK.seat, id: TASK.seatId };
}
export function checkLegacy(row) {
  // P5.2's own permanent account budget is the cross-version write exclusion.
  // Never create, edit or erase that database to make this condition pass.
  check(
    row?.attempts === 1 && row.state === "SUCCESS" && row.recordVerified === true,
    "P52_RECEIPT_REQUIRED",
  );
  const seats = row.mapping?.seats?.filter((s) => s.number === TASK.seat);
  check(
    row.mapping?.floorId === TASK.floorId && seats?.length === 1 && seats[0].id === TASK.seatId,
    "HISTORY_MAPPING_MISMATCH",
  );
}
export function overlaps(items) {
  return items.filter((r) => {
    const status = String(r.status);
    if (["3", "4", "5", "6", "7", "9"].includes(status)) return false;
    check(["0", "1", "2"].includes(status), "RECORDS_UNKNOWN");
    const begin = integer(r.time),
      duration = integer(r.duration);
    check(
      begin > 0 && duration > 0 && duration <= 86400 && Number.isSafeInteger(begin + duration),
      "RECORDS_UNKNOWN",
    );
    return begin < TASK.begin + TASK.duration && begin + duration > TASK.begin;
  });
}
export function verified162(items, mapping) {
  return overlaps(items).some(
    (r) =>
      integer(r.time) === TASK.begin &&
      integer(r.duration) === TASK.duration &&
      String(r.seatNum).trim() === TASK.seat &&
      r.roomName === mapping.room &&
      (r.seatId === undefined || String(r.seatId) === TASK.seatId),
  );
}

// HTTP Date is rounded to seconds. A conservative lower bound prevents using
// an optimistic midpoint estimate to send early. This is not millisecond sync.
export class ReleaseClock {
  constructor(wall = () => Date.now(), mono = () => performance.now()) {
    this.wall = wall;
    this.mono = mono;
    this.sample = null;
  }
  observe(sample) {
    const server = Date.parse(sample.date),
      rtt = sample.receivedMono - sample.sentMono;
    check(
      Number.isFinite(server) && server % 1000 === 0 && (!sample.age || sample.age === "0"),
      "CLOCK_UNVERIFIED",
    );
    check(rtt >= 0 && rtt <= 2000 && Math.abs(sample.receivedWall - server) <= 5000, "CLOCK_UNVERIFIED");
    this.sample = { ...sample, server, rtt };
  }
  bounds() {
    const s = this.sample;
    check(s, "CLOCK_UNVERIFIED");
    const elapsed = this.mono() - s.receivedMono,
      wallElapsed = this.wall() - s.receivedWall;
    check(
      elapsed >= 0 && elapsed <= PREPARE_MS && Math.abs(elapsed - wallElapsed) <= 500,
      "CLOCK_CHANGED_OR_STALE",
    );
    return {
      lower: s.server + Math.min(elapsed, wallElapsed) - 250,
      upper: s.server + 1000 + s.rtt + Math.max(elapsed, wallElapsed) + 250,
      phoneOffsetMs: s.receivedWall - s.server,
      sampleRttMs: s.rtt,
    };
  }
  released() {
    return this.wall() >= TASK.open && this.bounds().lower >= TASK.open;
  }
  deadline() {
    check(this.wall() <= TASK.open + LATE_MS && this.bounds().upper <= TASK.open + LATE_MS, "MISSED_WINDOW");
  }
}
