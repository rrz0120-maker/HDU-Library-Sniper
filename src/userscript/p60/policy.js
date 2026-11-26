import { check, integer, parseRange, rangeMidnight, responseCode, shanghaiDate } from "../core.js";
import { TASK } from "../p53/policy.js";

export const VERSION = "6.4.0";
export const CLASSIFIER_VERSION = "p64.1";
export const DEFAULTS = Object.freeze({ startHour: 8, endHour: 22, offsetMs: 1350 });
export const WRITE_INTERVAL = 10000;
export const BAN_TIME = 600000;

export function dailyTask(now = Date.now(), { startHour = 8, endHour = 22, offsetMs = 1350 } = {}) {
  check(Number.isSafeInteger(now), "INVALID_TIME");
  check(
    Number.isInteger(startHour) &&
      Number.isInteger(endHour) &&
      startHour >= 7 &&
      endHour <= 22 &&
      startHour < endHour,
    "INVALID_TIME",
  );
  check(Number.isInteger(offsetMs) && offsetMs >= 800 && offsetMs <= 2000, "INVALID_OFFSET");
  const day = shanghaiDate(now);
  const midnight = rangeMidnight(day);
  const date = shanghaiDate(midnight + 2 * 86400000);
  return Object.freeze({
    ...TASK,
    day,
    date,
    startHour,
    endHour,
    offsetMs,
    open: midnight + 20 * 3600000,
    planned: midnight + 20 * 3600000 + offsetMs,
    begin: rangeMidnight(date) / 1000 + startHour * 3600,
    duration: (endHour - startHour) * 3600,
  });
}

export function validateDailyTask(task) {
  const expected = dailyTask(task.open, task);
  for (const field of Object.keys(expected)) check(expected[field] === task[field], "TASK_INVALID");
}

export function preparationRange(raw, task) {
  const range = parseRange(raw);
  check(
    task.startHour >= range.min &&
      task.endHour <= range.max &&
      task.endHour - task.startHour >= integer(raw.min_duration) &&
      task.endHour - task.startHour <= integer(raw.max_duration),
    "TIME_NOT_ALLOWED",
  );
  // P6's verified +2 rule. Before release the target is the first excluded date.
  check(range.dates.includes(task.date) || range.maxDateExclusive === task.date, "DATE_RULE_MISMATCH");
  return range;
}

export function nextCheckMs(remaining) {
  if (remaining <= 0) return 0;
  if (remaining <= 1500) return Math.min(remaining, 20);
  if (remaining <= 5000) return Math.min(remaining - 1500, 100);
  return Math.min(remaining - 5000, 1000);
}

export function bookingResult(body, status = 200, invalidJson = false) {
  const code = responseCode(body);
  if (status === 429 || body?.CODE === "LIMITED" || code === "LIMITED") return "LIMITED";
  if (status === 401 || body?.CODE === "AUTH_REQUIRED" || code === "AUTH_REQUIRED") return "AUTH_REQUIRED";
  if (status === 404 || code === "HTTP_404") return "HTTP_404";
  if (status < 200 || status >= 300) return "HTTP_ERROR";
  if (invalidJson) return "INVALID_RESPONSE";
  if (body?.CODE === "ParamError") {
    const message = String(body.DATA?.msg || body.MESSAGE || "");
    if (/未登录|登录(?:状态)?已失效|登录(?:已)?过期|身份验证失败/.test(message)) return "AUTH_REQUIRED";
    if (/超出可预约座位时间范围/.test(message)) return "TIME_RANGE_INVALID";
    if (/未到(?:预约|开放)时间|(?:预约日期|预约时间)(?:尚)?未开放/.test(message)) return "NOT_OPEN";
    if (code === "EXISTING") return code;
    if (/座位不可用|座位无法预约|座位(?:已经?)?(?:被(?:其他人|他人)?)?(?:锁定|占用)/.test(message))
      return "SEAT_UNAVAILABLE";
    if (/账户无法预约|账号无法预约|参数(?:错误|无效)|无法预约/.test(message)) return "BUSINESS_REJECTED";
    return body?.DATA?.result === "fail" ? "BUSINESS_REJECTED" : "RESPONSE_UNKNOWN";
  }
  if (body?.DATA?.result === "fail") return "BUSINESS_REJECTED";
  return code === "SERVER_SUCCESS" ? code : "RESPONSE_UNKNOWN";
}

export function banUntil(retryAfter, now) {
  const seconds = /^\d+$/.test(retryAfter || "") ? Number(retryAfter) : NaN;
  const until = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(retryAfter);
  return Math.max(now + BAN_TIME, Number.isFinite(until) ? until : 0);
}

export const STATES = Object.freeze({
  IDLE: "未启动",
  PREPARING: "准备中",
  WAITING: "等待20:00",
  SENDING: "已发出，等待回执",
  ACCEPTED: "已受理，尚未核验成功",
  SUCCESS: "预约成功且记录已核验",
  FAILED: "业务明确拒绝",
  UNKNOWN: "结果待核实",
});
export const REASONS = Object.freeze({
  IDLE: "未启动",
  PREPARING: "正在检查登录身份和预约时段",
  WAITING: "准备完成，等待本地时钟触发",
  SENDING: "浏览器已接手预约 POST",
  SERVER_SUCCESS: "服务器返回预约成功",
  RECORD_VERIFIED: "官方记录已匹配",
  USER_STOPPED: "已停止待命，可以重新启动",
  DUPLICATE: "已有预约申请，本次未发送",
  PENDING: "存在未决申请，请核验官方记录",
  EXISTING: "已有预约或申请时段冲突",
  NOT_OPEN: "馆方返回未开放",
  TIME_RANGE_INVALID: "馆方返回超出允许预约时间范围",
  INVALID_RESPONSE: "响应无法解析，预约结果待核实",
  SEAT_UNAVAILABLE: "馆方返回座位不可用或已被占用",
  LIMITED: "馆方限流，写入已停止",
  AUTH_REQUIRED: "请在官网重新登录",
  TIMEOUT: "请求超时，结果待核实",
  NETWORK_ERROR: "网络异常，结果待核实",
  HTTP_404: "馆方返回 HTTP 404，请核验官方记录",
  HTTP_ERROR: "HTTP 响应异常，结果待核实",
  RESPONSE_UNKNOWN: "业务回执无法确认，结果待核实",
  BUSINESS_REJECTED: "馆方拒绝本次申请",
  INVALID_TIME: "请选择 07:00–22:00 内的有效整点时段",
  INVALID_OFFSET: "首发偏移须为 800–2000 毫秒",
  TASK_INVALID: "任务参数无效",
  TIME_NOT_ALLOWED: "所选时段超出馆方当前允许范围",
  DATE_RULE_MISMATCH: "馆方日期范围与后天规则不符",
  DATE_CONTRACT_UNKNOWN: "馆方日期范围解析失败",
  ACTIVE_TAB: "另一标签页正在执行本账号的预约",
  LOCK_UNAVAILABLE: "浏览器未提供请求互斥功能",
  INTENT_STORAGE_ERROR: "无法保存未决请求标记，请检查站点存储后重新启动",
  PACING: "距离上次写请求不足 10 秒，请等待后重新启动",
  DAY_EXPIRED: "网页恢复时已跨日，本次未发送",
  LEGACY_ACTIVE: "检测到旧版脚本，请停用后重新打开馆方页面",
  RECORDS_UNKNOWN: "官方预约列表解析失败",
  ACCOUNT_CHANGED: "当前登录账号与待核验申请不符",
  STOPPED: "准备已取消，可重新启动",
  LOCAL_ERROR: "准备未完成，可修正后重新启动",
});
export const VERIFICATIONS = Object.freeze({
  NONE: "尚未核验",
  CHECKING: "正在核验",
  MATCHED: "记录匹配",
  ABSENT: "尚无匹配记录",
  ERROR: "读取失败",
  AUTH_REQUIRED: "需要重新登录",
  LIMITED: "核验时返回限流",
});

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const codes = new Set(["ok", "ParamError", "NotFound", "LIMITED", "AUTH_REQUIRED", "0", "1"]);

// This allowlist also applies to restored data. Raw response text never enters exported JSON.
// Only retain verbatim recognized fragments. Unknown text may include names or credentials.
export function safeMessage(value) {
  return typeof value === "string"
    ? (value.match(
        /选择的座位无法预约，可能座位不可用或已经被其他人锁定或占用|未到(?:预约|开放)时间|座位不可用，已被占用|(?:预约日期|预约时间)(?:尚)?未开放|未登录|登录(?:状态)?已失效|登录(?:已)?过期|身份验证失败|该账户无法预约|该账号无法预约|参数错误|参数无效|超出可预约座位时间范围|请求过于频繁，请10分钟后再试|请求太频繁了|座位不可用|已有预约|重复预约/,
      )?.[0] ?? null)
    : null;
}

export function receiptMissing(body, invalidJson = false) {
  const message = body?.DATA?.msg || body?.MESSAGE;
  const status = (value, allowed) =>
    invalidJson ? "INVALID_RESPONSE" : value == null ? "ABSENT" : allowed ? null : "REDACTED";
  return {
    businessCode: status(body?.CODE, codes.has(body?.CODE)),
    businessResult: status(body?.DATA?.result, ["success", "fail"].includes(body?.DATA?.result)),
    failureMessage:
      body?.CODE === "ok" && body?.DATA?.result === "success"
        ? "NOT_APPLICABLE"
        : status(message, safeMessage(message) !== null),
  };
}

const missingStatuses = new Set([
  "ABSENT",
  "REDACTED",
  "INVALID_RESPONSE",
  "NOT_OBSERVED",
  "NOT_APPLICABLE",
  "LEGACY_NOT_RECORDED",
]);
export function publicDiagnostics(row = {}) {
  const task = row.task || {};
  const number = (n) => (Number.isFinite(n) ? n : null);
  const stamp = (s) => (typeof s === "string" && ISO.test(s) ? s : null);
  const reason = Object.hasOwn(REASONS, row.reason) ? row.reason : "LOCAL_ERROR";
  return {
    version: ["6.2.0", "6.3.0", VERSION].includes(row.version) ? row.version : null,
    classifierVersion: row.classifierVersion === CLASSIFIER_VERSION ? CLASSIFIER_VERSION : null,
    missingFields: Object.fromEntries(
      ["httpStatus", "businessCode", "businessResult", "failureMessage"].map((key) => [
        key,
        missingStatuses.has(row.missingFields?.[key])
          ? row.missingFields[key]
          : row[key] != null
            ? null
            : row.version === VERSION
              ? "NOT_OBSERVED"
              : "LEGACY_NOT_RECORDED",
      ]),
    ),
    runId: /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(row.runId) ? row.runId : null,
    storageStatus: row.diagnosticStorageFailed ? "ERROR" : row.storageStatus === "SAVED" ? "SAVED" : null,
    failureMessage: safeMessage(row.failureMessage),
    requestToFirstByteMs: number(row.requestToFirstByteMs),
    responseDownloadMs: number(row.responseDownloadMs),
    room: TASK.room,
    floorId: TASK.floorId,
    seat: TASK.seat,
    seatId: TASK.seatId,
    date: /^\d{4}-\d\d-\d\d$/.test(task.date) ? task.date : null,
    startHour: number(task.startHour),
    endHour: number(task.endHour),
    offsetMs: number(task.offsetMs),
    state: Object.hasOwn(STATES, row.state) ? row.state : "IDLE",
    reason,
    message: row.recordVerified === true ? REASONS.RECORD_VERIFIED : REASONS[reason],
    prepareStartedAt: stamp(row.prepareStartedAt),
    preparedAt: stamp(row.preparedAt),
    plannedAt: stamp(row.plannedAt),
    dispatchAt: stamp(row.dispatchAt),
    responseAt: stamp(row.responseAt),
    requestStartAt: stamp(row.requestStartAt),
    businessAt: stamp(row.businessAt),
    verifiedAt: stamp(row.verifiedAt),
    delayFrom20Ms: number(row.delayFrom20Ms),
    scheduleLagMs: number(row.scheduleLagMs),
    clockChangeMs: number(row.clockChangeMs),
    httpMs: number(row.httpMs),
    httpStatus: number(row.httpStatus),
    businessCode: codes.has(row.businessCode) ? row.businessCode : row.businessCode ? "OTHER" : null,
    businessResult: ["success", "fail"].includes(row.businessResult) ? row.businessResult : null,
    accepted: typeof row.accepted === "boolean" ? row.accepted : null,
    recordVerified: typeof row.recordVerified === "boolean" ? row.recordVerified : null,
    verification: Object.hasOwn(VERIFICATIONS, row.verification) ? row.verification : "NONE",
    attempts: [0, 1].includes(row.attempts) ? row.attempts : null,
    inWindow: typeof row.inWindow === "boolean" ? row.inWindow : null,
    hiddenDuringWait: typeof row.hiddenDuringWait === "boolean" ? row.hiddenDuringWait : null,
    nextWriteAt: stamp(row.nextWriteAt),
    diagnosticStorageFailed: row.diagnosticStorageFailed === true,
  };
}

export function restoredReport(raw) {
  check(raw && typeof raw === "object", "RECORDS_UNKNOWN");
  const task = dailyTask(Date.parse(`${raw.date}T12:00:00+08:00`) - 2 * 86400000, raw);
  const clean = publicDiagnostics({ ...raw, task });
  return { ...clean, task };
}
