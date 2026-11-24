import {
  diagnostic as base,
  REASONS as original,
  STATES as oldStates,
  classify as originalClassify,
  VERIFICATIONS as originalChecks,
  beijing,
} from "../v9/policy.js";
export { makeTask, DAY, PACING_MS, BAN_MS, matchesRecord, beijing } from "../v9/policy.js";

export const VERIFICATIONS = { ...originalChecks, timeout: "记录读取超时", http404: "记录读取返回 HTTP 404" };
export const STATES = { ...oldStates, ended: "本次任务已结束" };
export const REASONS = {
  ...original,
  HTTP_404: "馆方返回 HTTP 404，预约结果待核实",
  READ_TIMEOUT: "读取馆方数据超时",
  READ_404: "读取馆方数据时返回 HTTP 404",
  DUPLICATE: "已有相关申请，本次未发送",
  LOCK_UNAVAILABLE: "无法取得浏览器 Web Lock，请检查 Safari 版本与站点权限",
  GUARD_UNAVAILABLE: "未决请求保护不可用，请保存诊断并核对官方记录",
  INTERRUPTED: "页面重新载入，先前的待命已结束",
};
export function classify(status, body) {
  const result = originalClassify(status, body);
  if (["LIMITED", "AUTH_REQUIRED"].includes(result)) return result;
  if (status === 404) return "HTTP_404";
  if (status < 200 || status >= 300) return "HTTP_UNCERTAIN";
  if (result === "BUSINESS_REJECTED" && body?.CODE !== "ParamError" && body?.DATA?.result !== "fail")
    return "RESPONSE_UNKNOWN";
  const message = String(body?.DATA?.msg || body?.MESSAGE || "");
  if (
    result === "SEAT_UNAVAILABLE" &&
    !/座位不可用|座位无法预约|座位.*(?:锁定|占用)|已被.*(?:锁定|占用)/.test(message)
  )
    return "BUSINESS_REJECTED";
  return result;
}
// Only copy a recognized substring. Never persist free-form account or receipt text.
export function safeMessage(text) {
  return typeof text === "string"
    ? (text.match(
        /选择的座位无法预约，可能座位不可用或已经被其他人锁定或占用|未到(?:预约|开放)时间|(?:预约日期|预约时间|座位预约)(?:尚)?未开放|超出可预约座位时间范围|请求过于频繁，请10分钟后再试|请求太频繁了|座位不可用|已有预约|重复预约/,
      )?.[0] ?? null)
    : null;
}
export function diagnostic(source = {}) {
  const common = base(source);
  const num = (key) => (Number.isFinite(source[key]) ? source[key] : null);
  const stamp = (key) =>
    typeof source[key] === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}\+08:00$/.test(source[key])
      ? source[key]
      : null;
  const result = Object.hasOwn(REASONS, source.result) ? source.result : common.result;
  const state = Object.hasOwn(STATES, source.state) ? source.state : common.state;
  return {
    ...common,
    version: source.version === "9.0.0" ? "9.0.0" : "10.0.0",
    runId: /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(source.runId) ? source.runId : null,
    state,
    result,
    verification: Object.hasOwn(VERIFICATIONS, source.verification) ? source.verification : "none",
    reason: state === "verified" ? REASONS.VERIFIED : REASONS[result],
    prepareStartedAt: stamp("prepareStartedAt"),
    businessAt: stamp("businessAt"),
    offsetMs: num("offsetMs"),
    scheduleLagMs: num("scheduleLagMs"),
    clockChangeMs: num("clockChangeMs"),
    responseWaitMs: num("responseWaitMs"),
    responseDownloadMs: num("responseDownloadMs"),
    failureMessage: safeMessage(source.failureMessage),
    failureReason:
      ["unknown", "failed", "ended"].includes(state) || (state === "verified" && result !== "SERVER_SUCCESS")
        ? result
        : null,
    attempts: common.sends,
    accepted: result === "SERVER_SUCCESS" ? true : state === "failed" ? false : null,
    recordVerified:
      source.verification === "absent"
        ? false
        : typeof source.recordVerified === "boolean"
          ? source.recordVerified
          : !!common.verifiedAt,
    storageStatus: ["SAVED", "ERROR"].includes(source.storageStatus) ? source.storageStatus : null,
  };
}
export function initialReport(task) {
  return diagnostic({
    ...task,
    runId: crypto.randomUUID(),
    offsetMs: task.mode === "scheduled" ? task.planned - task.open : null,
    prepareStartedAt: beijing(Date.now()),
    plannedAt: beijing(task.planned),
    state: "preparing",
    result: "PREPARING",
    sends: 0,
  });
}
