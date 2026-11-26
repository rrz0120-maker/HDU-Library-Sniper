import assert from "node:assert/strict";
import test from "node:test";
import { bookingResult } from "../../src/userscript/p60/policy.js";

const cases = [
  ["选择的座位无法预约，可能座位不可用或已经被其他人锁定或占用。", "SEAT_UNAVAILABLE"],
  ["该账户无法预约", "BUSINESS_REJECTED"],
  ["该账户无法预约座位，账户已被锁定", "BUSINESS_REJECTED"],
  ["座位已被其他人占用", "SEAT_UNAVAILABLE"],
  ["座位状态说明：占用信息暂不可用", "RESPONSE_UNKNOWN"],
  ["参数错误", "BUSINESS_REJECTED"],
  ["登录状态已失效", "AUTH_REQUIRED"],
  ["未到开放时间", "NOT_OPEN"],
  ["预约时间尚未开放", "NOT_OPEN"],
  ["超出可预约座位时间范围", "TIME_RANGE_INVALID"],
  ["已有预约", "EXISTING"],
  ["请求过于频繁，请10分钟后再试", "LIMITED"],
  ["无法识别的新消息", "RESPONSE_UNKNOWN"],
];
for (const [msg, expected] of cases) {
  test(`ParamError ${msg}`, () => {
    assert.equal(bookingResult({ CODE: "ParamError", DATA: { msg } }, 200), expected);
  });
}
test("ParamError without a rejection signal stays unresolved", () => {
  assert.equal(bookingResult({ CODE: "ParamError" }, 200), "RESPONSE_UNKNOWN");
});
test("explicit authentication code", () => {
  assert.equal(bookingResult({ CODE: "AUTH_REQUIRED" }, 200), "AUTH_REQUIRED");
});
test("HTTP 200 alone and partial success fields are unresolved", () => {
  for (const body of [null, {}, { CODE: "ok" }, { DATA: { result: "success" } }])
    assert.equal(bookingResult(body, 200), "RESPONSE_UNKNOWN");
});

test("HTTP priority and exact acceptance stay explicit", () => {
  const success = { CODE: "ok", DATA: { result: "success" } };
  for (const [status, expected] of [
    [200, "SERVER_SUCCESS"],
    [404, "HTTP_404"],
    [503, "HTTP_ERROR"],
    [401, "AUTH_REQUIRED"],
    [429, "LIMITED"],
  ])
    assert.equal(bookingResult(success, status), expected);
  assert.equal(bookingResult(null, 200, true), "INVALID_RESPONSE");
  assert.equal(bookingResult(null, 404, true), "HTTP_404");
});
