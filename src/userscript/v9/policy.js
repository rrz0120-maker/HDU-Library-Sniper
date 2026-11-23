import { check, responseCode, roomMatches, shanghaiDate } from "../core.js";
import { TASK } from "../p53/policy.js";

export const SEAT = Object.freeze({
  room: TASK.room,
  floorId: TASK.floorId,
  seat: TASK.seat,
  seatId: TASK.seatId,
});
export const DAY = 86400000;
export const PACING_MS = 10000;
export const BAN_MS = 600000;
export const DEFAULT_OFFSET = 1200;

export function makeTask(mode, now, start = 9, end = 22, offset = DEFAULT_OFFSET) {
  check(mode === "scheduled" || mode === "now", "INVALID_TASK");
  check(
    Number.isInteger(start) && Number.isInteger(end) && start >= 7 && end <= 22 && start < end,
    "INVALID_TIME",
  );
  check(Number.isInteger(offset) && offset >= 800 && offset <= 2000, "INVALID_OFFSET");
  const today = shanghaiDate(now);
  const tonight = Date.parse(`${today}T20:00:00+08:00`);
  // Immediate mode selects the date of the most recent release, including before 20:00.
  const open = mode === "now" && now < tonight ? tonight - DAY : tonight;
  const date = shanghaiDate(open + 2 * DAY);
  const begin = Date.parse(`${date}T00:00:00+08:00`) / 1000 + start * 3600;
  return {
    ...SEAT,
    mode,
    date,
    start,
    end,
    begin,
    duration: (end - start) * 3600,
    open,
    planned: mode === "scheduled" ? open + offset : now,
  };
}

export function matchesRecord(row, task) {
  return (
    row &&
    ["0", "1", "2"].includes(String(row.status)) &&
    Number(row.time) === task.begin &&
    Number(row.duration) === task.duration &&
    String(row.seatNum).trim() === SEAT.seat &&
    roomMatches(row.roomName) &&
    (row.seatId === undefined || String(row.seatId) === SEAT.seatId) &&
    (row.floorId === undefined || Number(row.floorId) === SEAT.floorId)
  );
}

export function classify(status, body) {
  const message = String(body?.DATA?.msg || body?.MESSAGE || "");
  const code = responseCode(body);
  if (status === 429 || body?.CODE === "LIMITED" || code === "LIMITED") return "LIMITED";
  if (status === 401 || code === "AUTH_REQUIRED" || body?.CODE === "AUTH_REQUIRED") return "AUTH_REQUIRED";
  if (status >= 500 || status === 408) return "HTTP_UNCERTAIN";
  if (status >= 200 && status < 300 && code === "SERVER_SUCCESS") return code;
  if (body?.CODE === "ParamError") {
    if (
      /未到(?:预约|开放)时间|(?:预约日期|预约时间|座位预约)(?:尚)?未开放|超出可预约座位时间范围/.test(message)
    )
      return "NOT_OPEN";
    if (code === "EXISTING" || code === "SEAT_UNAVAILABLE") return code;
    return "BUSINESS_REJECTED";
  }
  if (status === 404 || body?.CODE === "NotFound") return "HTTP_404";
  if (body?.DATA?.result === "fail" || (body?.CODE && body.CODE !== "ok" && message))
    return "BUSINESS_REJECTED";
  return status >= 400 ? "HTTP_UNCERTAIN" : "RESPONSE_UNKNOWN";
}

export const REASONS = Object.freeze({
  IDLE: "未启动",
  PREPARING: "正在准备预约",
  WAITING: "已准备，等待本地触发",
  SENDING: "已将预约请求交给浏览器",
  STOPPED: "已停止，发送次数为零，可重新启动",
  SERVER_SUCCESS: "馆方已返回预约成功",
  VERIFIED: "官方有效记录与房间、座位和时段一致",
  NOT_OPEN: "馆方返回该预约时段尚未开放",
  SEAT_UNAVAILABLE: "馆方返回座位不可用或已被占用",
  LIMITED: "馆方已限流，已停止写入",
  AUTH_REQUIRED: "请在官网重新登录",
  TIMEOUT: "请求超时，需核对官方记录",
  NETWORK_ERROR: "网络中断，需核对官方记录",
  HTTP_UNCERTAIN: "HTTP 响应未能确认预约结果",
  HTTP_404: "馆方返回 404，本次提交结束",
  RESPONSE_UNKNOWN: "缺少可确认的业务回执",
  BUSINESS_REJECTED: "馆方拒绝本次预约，详见页面回执",
  EXISTING: "馆方返回已有预约或时段冲突",
  PENDING: "同一请求有未决回执，可只读核验",
  INVALID_TASK: "任务无效",
  INVALID_TIME: "请选择 07:00 至 22:00 内的有效整点时段",
  INVALID_OFFSET: "偏移量须为 800 至 2000 毫秒",
  TOO_LATE: "本日整点已过，可选择已开放时段",
  MISSED_DAY: "页面恢复时已跨日，本次任务未发送",
  LEGACY: "请停用旧版预约脚本并重新打开页面",
  ACTIVE_TAB: "本账号在另一标签页有活动预约",
  LOCK_UNAVAILABLE: "此浏览器未提供 Web Locks",
  GUARD_UNAVAILABLE: "无法读写未决请求保护，尚未发送",
  PACING: "距上次写入不足 10 秒",
  NO_SUPPLEMENT: "本次未开放回执的人工补交已用完",
  OPEN_NOT_CONFIRMED: "官方日期或时段尚未确认开放",
  READ_ERROR: "馆方读取失败",
  ACCOUNT_MISMATCH: "当前登录账号没有这笔请求的回执",
  LOCAL_ERROR: "准备失败，可重新启动",
});
export const STATES = Object.freeze({
  idle: "未启动",
  preparing: "准备中",
  waiting: "等待20:00",
  sending: "正在发送",
  accepted: "服务器已受理",
  verified: "预约成功且记录已核验",
  failed: "预约失败",
  unknown: "结果待核实",
});
export const VERIFICATIONS = Object.freeze({
  none: "未核验",
  checking: "正在读取官方记录",
  matched: "匹配",
  absent: "未见匹配记录",
  error: "读取失败",
  auth: "核验时需重新登录",
  limited: "核验时馆方返回限流",
});
const publicCodes = new Set(["ok", "ParamError", "NotFound", "LIMITED", "AUTH_REQUIRED", "1", "0"]);

export function beijing(ms) {
  return new Date(ms + 8 * 3600000).toISOString().replace("Z", "+08:00");
}

// Project both live and restored diagnostics. Arbitrary response text and storage extras never leave the panel.
export function diagnostic(source = {}) {
  function stamp(key) {
    const value = source[key];
    return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}\+08:00$/.test(value)
      ? value
      : null;
  }
  const num = (key) => (Number.isFinite(source[key]) ? source[key] : null);
  const state = Object.hasOwn(STATES, source.state) ? source.state : "idle";
  const result = Object.hasOwn(REASONS, source.result) ? source.result : "IDLE";
  const inWindow = typeof source.inWindow === "boolean" ? source.inWindow : null;
  return {
    version: "9.0.0",
    room: SEAT.room,
    seat: SEAT.seat,
    seatId: SEAT.seatId,
    mode: ["scheduled", "now"].includes(source.mode) ? source.mode : null,
    date: /^\d{4}-\d\d-\d\d$/.test(source.date) ? source.date : null,
    start: num("start"),
    end: num("end"),
    state,
    result,
    reason: state === "verified" ? REASONS.VERIFIED : REASONS[result],
    plannedAt: stamp("plannedAt"),
    preparedAt: stamp("preparedAt"),
    dispatchAt: stamp("dispatchAt"),
    requestStartAt: stamp("requestStartAt"),
    responseAt: stamp("responseAt"),
    httpMs: num("httpMs"),
    delayFrom20Ms: num("delayFrom20Ms"),
    inWindow,
    timingStatus:
      inWindow === false || result === "MISSED_DAY" ? "WINDOW_MISSED" : inWindow ? "IN_WINDOW" : null,
    hiddenDuringWait: source.hiddenDuringWait === true,
    httpStatus: num("httpStatus"),
    businessCode: publicCodes.has(source.businessCode)
      ? source.businessCode
      : source.businessCode
        ? "OTHER"
        : null,
    businessResult: ["success", "fail"].includes(source.businessResult) ? source.businessResult : null,
    sends: [0, 1].includes(source.sends) ? source.sends : null,
    verification: Object.hasOwn(VERIFICATIONS, source.verification) ? source.verification : "none",
    verifiedAt: stamp("verifiedAt"),
    nextWriteAfter: stamp("nextWriteAfter"),
  };
}

export function initialReport(task) {
  return diagnostic({
    ...task,
    plannedAt: beijing(task.planned),
    state: "preparing",
    result: "PREPARING",
    sends: 0,
  });
}
