import { check, integer, parseRange, rangeMidnight, shanghaiDate } from "../core.js";
import { TASK as P53_TASK } from "../p53/policy.js";

export function dailyTask(now = Date.now()) {
  check(Number.isSafeInteger(now), "INVALID_TIME");
  const day = shanghaiDate(now),
    midnight = rangeMidnight(day);
  const date = shanghaiDate(midnight + 2 * 86400000),
    target = rangeMidnight(date);
  return Object.freeze({
    ...P53_TASK,
    day,
    date,
    open: midnight + 20 * 3600000,
    begin: target / 1000 + 8 * 3600,
    end: target / 1000 + 22 * 3600,
  });
}
export function validateDailyTask(task) {
  const canonical = dailyTask(task.open);
  for (const key of Object.keys(canonical)) check(task[key] === canonical[key], "TASK_INVALID");
}
export function suffix(task) {
  return `${task.date}:08:00-22:00`;
}
export function isP53Slot(task) {
  return task.begin === P53_TASK.begin && task.duration === P53_TASK.duration;
}
export function pending(row) {
  return row?.attempts === 1 && !["SUCCESS", "FAILED"].includes(row.state);
}

// First excluded date is valid preflight evidence, never an open-date permit.
export function openingRange(raw, task) {
  const range = parseRange(raw);
  check(
    range.min <= 8 && range.max >= 22 && integer(raw.min_duration) <= 14 && integer(raw.max_duration) >= 14,
    "FOURTEEN_HOURS_NOT_ALLOWED",
  );
  const open = range.dates.includes(task.date);
  check(open || range.maxDateExclusive === task.date, "DATE_RULE_MISMATCH");
  return { open, maxDateExclusive: range.maxDateExclusive };
}
export function canReconcileNotOpen(row) {
  if (!row || row.state !== "UNKNOWN" || row.reason !== "USER_STOPPED" || row.attempts !== 1) return false;
  const get = (k) => row[k] ?? row.timings?.[k];
  const d = Date.parse(get("firstDispatchAt")),
    b = Date.parse(get("firstBusinessResultAt"));
  const f = Date.parse(get("uiFeedback")?.FAILED?.stateUpdatedAt);
  return (
    get("responseCode") === "NOT_OPEN" &&
    row.recordVerified !== true &&
    !get("firstServerSuccessAt") &&
    !get("firstRecordVerifiedAt") &&
    Number.isFinite(d) &&
    Number.isFinite(b) &&
    Number.isFinite(f) &&
    d <= b &&
    b <= f
  );
}
export const FIRST_FIELDS = [
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
  "resultStateUpdatedAt",
];
export function mergeDiagnostics(old, incoming = {}) {
  const merged = { ...old };
  for (const field of FIRST_FIELDS)
    if (merged[field] == null && incoming[field] != null) merged[field] = incoming[field];
  if (incoming.lastReviewedAt && (!old.lastReviewedAt || incoming.lastReviewedAt > old.lastReviewedAt))
    merged.lastReviewedAt = incoming.lastReviewedAt;
  const feedback = { ...old.uiFeedback };
  for (const [state, detail] of Object.entries(incoming.uiFeedback || {})) {
    feedback[state] = { ...detail, ...feedback[state] }; // first measured value wins
  }
  merged.uiFeedback = feedback;
  return merged;
}

// Explicit export allowlist: never serialize a transport response, UID, token,
// account hash, headers, request body, or arbitrary stored object.
export function publicDiagnostics(row) {
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
    recordVerified: row.recordVerified === true,
    ...fields,
    lastReviewedAt: row.lastReviewedAt || null,
    reconciledAt: row.reconciledAt || null,
    uiFeedback: cleanUI(row.uiFeedback),
    events: (row.logs || [])
      .slice(-60)
      .map((e) => ({ at: e.at, category: e.category, state: e.state, code: e.reason })),
    timingMeaning:
      "fetch调用/响应头/业务解析/记录核验均为客户端事件；DOM和rAF不是用户实际看到的时刻；不分离网络与服务端耗时",
  };
}
function cleanUI(feedback = {}) {
  return Object.fromEntries(
    Object.entries(feedback).map(([state, value]) => [
      state,
      Object.fromEntries(
        ["stateUpdatedAt", "domUpdatedAt", "domUpdateMs", "renderOpportunityAt", "renderOpportunityDelayMs"]
          .filter((k) => value[k] !== undefined)
          .map((k) => [k, value[k]]),
      ),
    ]),
  );
}
