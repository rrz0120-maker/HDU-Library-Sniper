// ==UserScript==
// @name         杭电图书馆 Android P6.4 Lite 候选
// @namespace    https://github.com/rrz0120-maker/HDU-Library-Sniper/p64
// @version      6.4.0
// @description  四楼162号，默认北京时间20:00:01.350预约后天08:00–22:00；一次正式POST与官方记录核验。
// @match        https://hdu.huitu.zhishulib.com/*
// @grant        none
// @noframes
// @run-at       document-end
// @updateURL    none
// @license      MIT
// ==/UserScript==
(function() {
  "use strict";
  const ORIGIN = "https://hdu.huitu.zhishulib.com";
  const BOOK_PATH = "/Seat/Index/bookSeats?LAB_JSON=1";
  const DAY = 864e5;
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
  const scalar = (v) => typeof v === "string" || typeof v === "number" ? String(v) : "";
  function shanghaiDate(ms = Date.now()) {
    return new Date(ms + 8 * 36e5).toISOString().slice(0, 10);
  }
  function midnight(date) {
    check(typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date), "DATE_CONTRACT_UNKNOWN");
    const ms = Date.parse(`${date}T00:00:00+08:00`);
    check(Number.isFinite(ms) && shanghaiDate(ms) === date, "DATE_CONTRACT_UNKNOWN");
    return ms;
  }
  function rangeMidnight(value) {
    if (typeof value === "string") return midnight(value);
    check(Number.isSafeInteger(value) && value >= 0 && value < 1e10, "DATE_CONTRACT_UNKNOWN");
    const ms = value * 1e3;
    check(midnight(shanghaiDate(ms)) === ms, "DATE_CONTRACT_UNKNOWN");
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date(ms));
    check(
      parts.filter((p) => ["hour", "minute", "second"].includes(p.type)).every((p) => p.value === "00"),
      "DATE_CONTRACT_UNKNOWN"
    );
    return ms;
  }
  function parseRange(raw) {
    const first = rangeMidnight(raw?.advance_date), last = rangeMidnight(raw?.max_date);
    check(first <= last && (last - first) / DAY <= 31, "DATE_CONTRACT_UNKNOWN");
    const min = integer(raw.minBeginTime), max = integer(raw.maxEndTime);
    check(
      min >= 0 && max <= 24 && min < max && integer(raw.min_duration) <= 1 && integer(raw.min_duration) >= 1 && integer(raw.max_duration) >= 1,
      "ONE_HOUR_NOT_ALLOWED"
    );
    if (raw.max_num !== void 0) check(integer(raw.max_num) >= 1, "ONE_PERSON_NOT_ALLOWED");
    const dates = [];
    for (let at = first; at < last; at += DAY) dates.push(shanghaiDate(at));
    return { dates, min, max, maxDateExclusive: shanghaiDate(last) };
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
  function records(body) {
    check(Array.isArray(body?.content?.defaultItems), "RECORDS_UNKNOWN");
    return body.content.defaultItems;
  }
  function md5(source) {
    const bytes = new TextEncoder().encode(source);
    const size = Math.ceil((bytes.length + 9) / 64) * 64;
    const buffer = new Uint8Array(size);
    buffer.set(bytes);
    buffer[bytes.length] = 128;
    const view = new DataView(buffer.buffer);
    view.setUint32(size - 8, bytes.length * 8 >>> 0, true);
    view.setUint32(size - 4, Math.floor(bytes.length / 536870912), true);
    const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    const h = [1732584193, 4023233417, 2562383102, 271733878];
    for (let offset = 0; offset < size; offset += 64) {
      let [a, b, c, d] = h;
      for (let i = 0; i < 64; i++) {
        let f, index;
        if (i < 16) {
          f = b & c | ~b & d;
          index = i;
        } else if (i < 32) {
          f = d & b | ~d & c;
          index = (5 * i + 1) % 16;
        } else if (i < 48) {
          f = b ^ c ^ d;
          index = (3 * i + 5) % 16;
        } else {
          f = c ^ (b | ~d);
          index = 7 * i % 16;
        }
        const shift = shifts[Math.floor(i / 16) * 4 + i % 4];
        const sum = a + f + Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) + view.getUint32(offset + index * 4, true) | 0;
        const next = b + (sum << shift | sum >>> 32 - shift) | 0;
        a = d;
        d = c;
        c = b;
        b = next;
      }
      h[0] = h[0] + a | 0;
      h[1] = h[1] + b | 0;
      h[2] = h[2] + c | 0;
      h[3] = h[3] + d | 0;
    }
    return h.flatMap((n) => [0, 8, 16, 24].map((bits) => (n >>> bits & 255).toString(16).padStart(2, "0"))).join("");
  }
  function signedRequest(seatId, uid, begin, apiTime, duration = 3600) {
    check(
      Number.isInteger(duration) && duration >= 3600 && duration <= 54e3 && duration % 3600 === 0,
      "INVALID_DURATION"
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
        "seatBookers[0]": uid
      })
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
  const PATHS = /* @__PURE__ */ new Set([
    "/User/Center/baseInfo",
    "/Space/Category/list",
    "/Seat/Index/searchSeats",
    "/Seat/Index/myBookingList",
    "/Seat/Index/bookSeats"
  ]);
  class Transport {
    constructor() {
      this.clock = null;
    }
    now() {
      return Date.now();
    }
    clockValid() {
      return this.clock && performance.now() - this.clock.at < 6e4 && Math.abs(this.clock.offset) <= 5e3;
    }
    async request(path, {
      form,
      token,
      write = false,
      signal,
      onHeaders,
      onDispatch,
      onBusiness,
      beforeDispatch,
      onDispatched,
      inspectHttpErrors = false
    } = {}) {
      const url = new URL(path, ORIGIN);
      check(location.origin === ORIGIN && url.origin === ORIGIN && PATHS.has(url.pathname), "ORIGIN_DENIED");
      check(url.pathname === "/Seat/Index/bookSeats" === write, "WRITE_GATE_CLOSED");
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
        write ? 3e4 : 5e3
      );
      let start = performance.now();
      const timing = { dispatchAt: null, serverProcessingMs: null, requestUploadMs: null };
      try {
        const init = {
          method: form ? "POST" : "GET",
          credentials: "same-origin",
          mode: "same-origin",
          redirect: "error",
          cache: "no-store",
          signal: controller.signal,
          headers: token ? { "Api-Token": token, Accept: "application/json" } : { Accept: "application/json" },
          ...form ? { body: form } : {}
        };
        onDispatch?.(new Date(Date.now()).toISOString());
        beforeDispatch?.();
        start = performance.now();
        const wall = Date.now();
        const pending = fetch(url.href, init);
        timing.dispatchAt = new Date(wall).toISOString();
        try {
          onDispatched?.(timing.dispatchAt);
        } catch {
          timing.observationError = true;
        }
        const response = await pending;
        timing.responseAt = new Date(Date.now()).toISOString();
        timing.dispatchToHeadersMs = performance.now() - start;
        onHeaders?.({
          status: response.status,
          timing: { ...timing },
          date: response.headers.get("Date"),
          age: response.headers.get("Age"),
          sentMono: start,
          receivedMono: performance.now(),
          receivedWall: Date.now(),
          retryAfter: response.headers.get("Retry-After")
        });
        const date = Date.parse(response.headers.get("Date"));
        if (Number.isFinite(date)) this.clock = { at: performance.now(), offset: Date.now() - date };
        if (!response.ok && !inspectHttpErrors)
          throw new TestError(
            response.status === 429 || response.status === 403 ? "LIMITED" : response.status === 401 ? "AUTH_REQUIRED" : response.status === 404 ? "HTTP_404" : "HTTP_ERROR"
          );
        const decode = performance.now();
        timing.httpStatus = response.status;
        let body;
        try {
          body = await response.json();
        } catch (error) {
          if (inspectHttpErrors && error instanceof SyntaxError) {
            body = null;
            timing.invalidJson = true;
          } else throw error;
        }
        timing.bodyDecodeMs = performance.now() - decode;
        timing.businessResultAt = new Date(Date.now()).toISOString();
        onBusiness?.(body, timing);
        try {
          const candidates = performance.getEntriesByName(url.href, "resource").filter(
            (r) => r.initiatorType === "fetch" && r.startTime >= start && r.startTime <= start + timing.dispatchToHeadersMs && r.requestStart >= r.startTime && r.requestStart > 0
          );
          if (candidates.length === 1) {
            const entry = candidates[0];
            if (entry.responseStart >= entry.requestStart)
              timing.requestToFirstByteMs = entry.responseStart - entry.requestStart;
            if (entry.responseStart > 0 && entry.responseEnd >= entry.responseStart)
              timing.responseDownloadMs = entry.responseEnd - entry.responseStart;
            timing.requestStartAt = new Date(wall + candidates[0].requestStart - start).toISOString();
          }
        } catch {
        }
        return { body, timing, status: response.status, retryAfter: response.headers.get("Retry-After") };
      } catch (error) {
        const failure = error instanceof TestError ? error : new TestError(
          signal?.aborted ? "STOPPED" : timeout ? "TIMEOUT" : error instanceof SyntaxError ? "RESPONSE_UNKNOWN" : "NETWORK_ERROR"
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
  const KEY = "hdu-p64:history";
  const LEGACY_KEY = "hdu-p63:history";
  function readRows(storage, key) {
    const rows = JSON.parse(storage.getItem(key) ?? "[]");
    if (!Array.isArray(rows)) throw new Error("Invalid diagnostic history");
    return rows;
  }
  function readHistory(storage = localStorage) {
    return [...readRows(storage, KEY), ...readRows(storage, LEGACY_KEY)];
  }
  async function archive(row) {
    await navigator.locks.request(KEY, () => {
      const rows = readRows(localStorage, KEY);
      const index = rows.findIndex((item) => item.runId === row.runId);
      if (index >= 0) rows[index] = row;
      else rows.unshift(row);
      localStorage.setItem(KEY, JSON.stringify(rows.slice(0, 30)));
    });
  }
  async function accountKey(uid) {
    check(globalThis.crypto?.subtle, "STORAGE_UNAVAILABLE");
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`HDU-P5.1:${uid}`));
    return [...new Uint8Array(hash)].map((v) => v.toString(16).padStart(2, "0")).join("");
  }
  const TASK = Object.freeze({
    date: "2026-11-19",
    open: Date.parse("2026-11-17T20:00:00+08:00"),
    begin: Date.parse("2026-11-19T08:00:00+08:00") / 1e3,
    duration: 50400,
    seat: "162",
    seatId: "62726",
    floorId: 1558,
    room: "宋韵云图（四楼）"
  });
  const RECORD_PATH = "/Seat/Index/myBookingList?fromType=web&LAB_JSON=1";
  `${TASK.date}:08:00-22:00`;
  function overlaps(items, task = TASK) {
    return items.filter((r) => {
      const status = String(r.status);
      if (["3", "4", "5", "6", "7", "9"].includes(status)) return false;
      check(["0", "1", "2"].includes(status), "RECORDS_UNKNOWN");
      const begin = integer(r.time), duration = integer(r.duration);
      check(
        begin > 0 && duration > 0 && duration <= 86400 && Number.isSafeInteger(begin + duration),
        "RECORDS_UNKNOWN"
      );
      return begin < task.begin + task.duration && begin + duration > task.begin;
    });
  }
  function verified162(items, mapping, task = TASK) {
    return overlaps(items, task).some(
      (r) => integer(r.time) === task.begin && integer(r.duration) === task.duration && String(r.seatNum).trim() === task.seat && r.roomName === mapping.room && (r.seatId === void 0 || String(r.seatId) === task.seatId)
    );
  }
  const VERSION = "6.4.0";
  const CLASSIFIER_VERSION = "p64.1";
  const DEFAULTS = Object.freeze({ startHour: 8, endHour: 22, offsetMs: 1350 });
  const WRITE_INTERVAL = 1e4;
  const BAN_TIME = 6e5;
  function dailyTask(now = Date.now(), { startHour = 8, endHour = 22, offsetMs = 1350 } = {}) {
    check(Number.isSafeInteger(now), "INVALID_TIME");
    check(
      Number.isInteger(startHour) && Number.isInteger(endHour) && startHour >= 7 && endHour <= 22 && startHour < endHour,
      "INVALID_TIME"
    );
    check(Number.isInteger(offsetMs) && offsetMs >= 800 && offsetMs <= 2e3, "INVALID_OFFSET");
    const day = shanghaiDate(now);
    const midnight2 = rangeMidnight(day);
    const date = shanghaiDate(midnight2 + 2 * 864e5);
    return Object.freeze({
      ...TASK,
      day,
      date,
      startHour,
      endHour,
      offsetMs,
      open: midnight2 + 20 * 36e5,
      planned: midnight2 + 20 * 36e5 + offsetMs,
      begin: rangeMidnight(date) / 1e3 + startHour * 3600,
      duration: (endHour - startHour) * 3600
    });
  }
  function validateDailyTask(task) {
    const expected = dailyTask(task.open, task);
    for (const field of Object.keys(expected)) check(expected[field] === task[field], "TASK_INVALID");
  }
  function preparationRange(raw, task) {
    const range = parseRange(raw);
    check(
      task.startHour >= range.min && task.endHour <= range.max && task.endHour - task.startHour >= integer(raw.min_duration) && task.endHour - task.startHour <= integer(raw.max_duration),
      "TIME_NOT_ALLOWED"
    );
    check(range.dates.includes(task.date) || range.maxDateExclusive === task.date, "DATE_RULE_MISMATCH");
    return range;
  }
  function nextCheckMs(remaining) {
    if (remaining <= 0) return 0;
    if (remaining <= 1500) return Math.min(remaining, 20);
    if (remaining <= 5e3) return Math.min(remaining - 1500, 100);
    return Math.min(remaining - 5e3, 1e3);
  }
  function bookingResult(body, status = 200, invalidJson = false) {
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
  function banUntil(retryAfter, now) {
    const seconds = /^\d+$/.test(retryAfter || "") ? Number(retryAfter) : NaN;
    const until = Number.isFinite(seconds) ? now + seconds * 1e3 : Date.parse(retryAfter);
    return Math.max(now + BAN_TIME, Number.isFinite(until) ? until : 0);
  }
  const STATES = Object.freeze({
    IDLE: "未启动",
    PREPARING: "准备中",
    WAITING: "等待20:00",
    SENDING: "已发出，等待回执",
    ACCEPTED: "已受理，尚未核验成功",
    SUCCESS: "预约成功且记录已核验",
    FAILED: "业务明确拒绝",
    UNKNOWN: "结果待核实"
  });
  const REASONS = Object.freeze({
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
    LOCAL_ERROR: "准备未完成，可修正后重新启动"
  });
  const VERIFICATIONS = Object.freeze({
    NONE: "尚未核验",
    CHECKING: "正在核验",
    MATCHED: "记录匹配",
    ABSENT: "尚无匹配记录",
    ERROR: "读取失败",
    AUTH_REQUIRED: "需要重新登录",
    LIMITED: "核验时返回限流"
  });
  const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
  const codes = /* @__PURE__ */ new Set(["ok", "ParamError", "NotFound", "LIMITED", "AUTH_REQUIRED", "0", "1"]);
  function safeMessage(value) {
    return typeof value === "string" ? value.match(
      /选择的座位无法预约，可能座位不可用或已经被其他人锁定或占用|未到(?:预约|开放)时间|座位不可用，已被占用|(?:预约日期|预约时间)(?:尚)?未开放|未登录|登录(?:状态)?已失效|登录(?:已)?过期|身份验证失败|该账户无法预约|该账号无法预约|参数错误|参数无效|超出可预约座位时间范围|请求过于频繁，请10分钟后再试|请求太频繁了|座位不可用|已有预约|重复预约/
    )?.[0] ?? null : null;
  }
  function receiptMissing(body, invalidJson = false) {
    const message = body?.DATA?.msg || body?.MESSAGE;
    const status = (value, allowed) => invalidJson ? "INVALID_RESPONSE" : value == null ? "ABSENT" : allowed ? null : "REDACTED";
    return {
      businessCode: status(body?.CODE, codes.has(body?.CODE)),
      businessResult: status(body?.DATA?.result, ["success", "fail"].includes(body?.DATA?.result)),
      failureMessage: body?.CODE === "ok" && body?.DATA?.result === "success" ? "NOT_APPLICABLE" : status(message, safeMessage(message) !== null)
    };
  }
  const missingStatuses = /* @__PURE__ */ new Set([
    "ABSENT",
    "REDACTED",
    "INVALID_RESPONSE",
    "NOT_OBSERVED",
    "NOT_APPLICABLE",
    "LEGACY_NOT_RECORDED"
  ]);
  function publicDiagnostics(row = {}) {
    const task = row.task || {};
    const number = (n) => Number.isFinite(n) ? n : null;
    const stamp = (s) => typeof s === "string" && ISO.test(s) ? s : null;
    const reason = Object.hasOwn(REASONS, row.reason) ? row.reason : "LOCAL_ERROR";
    return {
      version: ["6.2.0", "6.3.0", VERSION].includes(row.version) ? row.version : null,
      classifierVersion: row.classifierVersion === CLASSIFIER_VERSION ? CLASSIFIER_VERSION : null,
      missingFields: Object.fromEntries(
        ["httpStatus", "businessCode", "businessResult", "failureMessage"].map((key) => [
          key,
          missingStatuses.has(row.missingFields?.[key]) ? row.missingFields[key] : row[key] != null ? null : row.version === VERSION ? "NOT_OBSERVED" : "LEGACY_NOT_RECORDED"
        ])
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
      diagnosticStorageFailed: row.diagnosticStorageFailed === true
    };
  }
  function restoredReport(raw) {
    check(raw && typeof raw === "object", "RECORDS_UNKNOWN");
    const task = dailyTask(Date.parse(`${raw.date}T12:00:00+08:00`) - 2 * 864e5, raw);
    const clean = publicDiagnostics({ ...raw, task });
    return { ...clean, task };
  }
  const LAST_REPORT = "hdu-p62:last-report";
  const LAST_ACCOUNT = "hdu-p62:last-store";
  function slotKey(task) {
    return [task.date, task.startHour, task.endHour].join("/");
  }
  class DailyStore {
    constructor(name, storage = globalThis.localStorage) {
      this.name = name;
      this.storage = storage;
      this.data = { nextWrite: 0, limitedUntil: 0, requests: {} };
      this.reload();
    }
    reload() {
      try {
        const raw = this.storage.getItem(this.name);
        this.data = raw === null ? { nextWrite: 0, limitedUntil: 0, requests: {} } : JSON.parse(raw);
        check(
          Number.isFinite(this.data.nextWrite) && Number.isFinite(this.data.limitedUntil) && this.data.requests && typeof this.data.requests === "object" && !Array.isArray(this.data.requests),
          "INTENT_STORAGE_ERROR"
        );
      } catch {
        throw new TestError("INTENT_STORAGE_ERROR");
      }
    }
    save() {
      try {
        this.storage.setItem(this.name, JSON.stringify(this.data));
      } catch {
        throw new TestError("INTENT_STORAGE_ERROR");
      }
    }
    conflict(task) {
      return Object.values(this.data.requests).find(
        (r) => ["UNKNOWN", "SENDING", "ACCEPTED", "SUCCESS"].includes(r.state) && r.date === task.date && r.startHour < task.endHour && r.endHour > task.startHour
      );
    }
    prune(today) {
      for (const key of Object.keys(this.data.requests)) {
        if (key.slice(0, 10) < today) delete this.data.requests[key];
      }
    }
    intent(task, now, runId) {
      const key = slotKey(task);
      const old = this.data.requests[key], next = this.data.nextWrite;
      this.data.nextWrite = now + WRITE_INTERVAL;
      this.data.requests[key] = publicDiagnostics({
        version: VERSION,
        classifierVersion: CLASSIFIER_VERSION,
        task,
        runId,
        plannedAt: new Date(task.planned).toISOString(),
        state: "UNKNOWN",
        reason: "PENDING",
        attempts: null
      });
      this.save();
      return () => {
        this.data.nextWrite = next;
        if (old) this.data.requests[key] = old;
        else delete this.data.requests[key];
        this.save();
      };
    }
    receipt(report) {
      this.data.requests[slotKey(report.task)] = publicDiagnostics(report);
      if (report.dispatchAt)
        this.data.nextWrite = Math.max(this.data.nextWrite, Date.parse(report.dispatchAt) + WRITE_INTERVAL);
      this.save();
    }
  }
  function remember(report, storeName) {
    try {
      if (storeName) sessionStorage.setItem(LAST_ACCOUNT, storeName);
      sessionStorage.setItem(LAST_REPORT, JSON.stringify(publicDiagnostics(report)));
      return true;
    } catch {
      return false;
    }
  }
  function recall() {
    let report = null;
    try {
      const raw = sessionStorage.getItem(LAST_REPORT);
      if (!raw) return null;
      report = restoredReport(JSON.parse(raw));
      const name = sessionStorage.getItem(LAST_ACCOUNT);
      if (/^hdu-p62:[a-f0-9]{64}$/.test(name)) {
        const stored = JSON.parse(localStorage.getItem(name))?.requests?.[slotKey(report.task)];
        const interrupted = ["WAITING", "PREPARING", "SENDING"].includes(report.state);
        const sameRun = !report.runId || report.runId === stored?.runId;
        if (stored?.plannedAt === report.plannedAt && sameRun && interrupted) report = restoredReport(stored);
      }
    } catch {
    }
    if (report && ["PREPARING", "WAITING"].includes(report.state)) {
      report.state = "IDLE";
      report.reason = "USER_STOPPED";
    }
    if (report?.state === "SENDING") {
      report.state = "UNKNOWN";
      report.reason = "PENDING";
    }
    if (report?.verification === "CHECKING") report.verification = "NONE";
    return report;
  }
  const unresolved = /* @__PURE__ */ new Set([
    "TIMEOUT",
    "NETWORK_ERROR",
    "HTTP_404",
    "HTTP_ERROR",
    "RESPONSE_UNKNOWN",
    "INVALID_RESPONSE"
  ]);
  class DailyEngine {
    constructor(io, notify = () => {
    }, env = {}) {
      this.io = io;
      this.notify = notify;
      this.wall = env.wall || (() => Date.now());
      this.mono = env.mono || (() => performance.now());
      this.visible = env.visible || (() => !document.hidden);
      this.locks = env.locks || globalThis.navigator?.locks;
      this.openStore = env.openStore || ((name) => new DailyStore(name));
      this.previous = recall();
      this.report = { state: "IDLE", reason: "IDLE", attempts: 0 };
      this.running = false;
      this.waiting = false;
      this.reviewing = false;
      this.message = "";
      this.storeName = null;
      this.limitedUntil = 0;
      this.pageSuspended = false;
      if (this.previous?.runId && this.previous.storageStatus !== "SAVED") this.archiveResult(this.previous);
    }
    view() {
      return {
        ...publicDiagnostics(this.previous || this.report),
        historical: Boolean(this.previous),
        message: this.message,
        running: this.running,
        waiting: this.waiting,
        reviewing: this.reviewing
      };
    }
    render() {
      try {
        this.notify(this.view());
      } catch {
        this.report.diagnosticStorageFailed = true;
      }
    }
    saveDisplay() {
      if (!remember(this.report, this.storeName)) this.report.diagnosticStorageFailed = true;
    }
    archiveResult(report = this.report) {
      if (!report.runId) return;
      const snapshot = /* @__PURE__ */ Symbol();
      report.archiveSnapshot = snapshot;
      report.storageStatus = null;
      const row = publicDiagnostics({ ...report, storageStatus: "SAVED" });
      if (row.state === "SENDING")
        Object.assign(row, { state: "UNKNOWN", reason: "PENDING", message: REASONS.PENDING });
      archive(row).then(() => {
        if (report.archiveSnapshot === snapshot) report.storageStatus = "SAVED";
      }).catch(() => {
        report.diagnosticStorageFailed = true;
      }).finally(() => {
        if (report.archiveSnapshot !== snapshot) return;
        if (this.previous === report) this.render();
        if (this.report === report) {
          this.saveDisplay();
          this.render();
        }
      });
    }
    emit(state, reason) {
      Object.assign(this.report, { state, reason, storageStatus: null, archiveSnapshot: null });
      this.saveDisplay();
      this.render();
    }
    saveReceipt() {
      try {
        this.store.receipt(this.report);
      } catch {
        this.report.diagnosticStorageFailed = true;
      }
    }
    limit(until) {
      this.limitedUntil = Math.max(this.limitedUntil, until);
      this.report.nextWriteAt = new Date(this.limitedUntil).toISOString();
      if (this.store) {
        this.store.data.limitedUntil = Math.max(this.store.data.limitedUntil, until);
        try {
          this.store.save();
        } catch {
          this.report.diagnosticStorageFailed = true;
        }
      }
    }
    async read(path, signal) {
      const { body, status } = await this.io.request(path, {
        signal,
        inspectHttpErrors: true,
        onHeaders: (sample) => {
          if (sample.status === 429) this.limit(banUntil(sample.retryAfter, this.wall()));
        }
      });
      const reason = bookingResult(body, status);
      if (reason === "LIMITED") this.limit(banUntil(null, this.wall()));
      check(!["LIMITED", "AUTH_REQUIRED", "HTTP_404", "HTTP_ERROR"].includes(reason), reason);
      check(body && (body.CODE === void 0 || body.CODE === "ok"), "RESPONSE_UNKNOWN");
      return body;
    }
    async withAccount(signal, action) {
      const body = await this.read("/User/Center/baseInfo", signal);
      const uid = String(body?.DATA?.uid ?? "");
      check(body?.DATA?.is_login === true && /^\d+$/.test(uid), "AUTH_REQUIRED");
      const name = `hdu-p62:${await accountKey(uid)}`;
      check(!signal.aborted, "STOPPED");
      check(this.locks?.request, "LOCK_UNAVAILABLE");
      await this.locks.request(name, { ifAvailable: true }, async (lock) => {
        check(lock, "ACTIVE_TAB");
        check(!signal.aborted, "STOPPED");
        this.store = this.openStore(name);
        this.storeName = name;
        this.store.prune(shanghaiDate(this.wall()));
        this.saveDisplay();
        await action(uid);
      });
    }
    pace(at) {
      const limited = Math.max(this.limitedUntil, this.store.data.limitedUntil);
      const next = Math.max(limited, this.store.data.nextWrite);
      if (next > at) {
        this.report.nextWriteAt = new Date(next).toISOString();
        throw new TestError(limited > at ? "LIMITED" : "PACING");
      }
    }
    async prepare(task) {
      if (this.running) return;
      this.running = true;
      this.store = null;
      this.storeName = null;
      this.message = "";
      this.controller = new AbortController();
      this.pageSuspended = !this.visible();
      const signal = this.controller.signal;
      this.previous = null;
      this.report = {
        version: VERSION,
        classifierVersion: CLASSIFIER_VERSION,
        runId: crypto.randomUUID(),
        task,
        state: "PREPARING",
        reason: "PREPARING",
        attempts: 0,
        verification: "NONE",
        plannedAt: new Date(task.planned).toISOString(),
        prepareStartedAt: new Date(this.wall()).toISOString()
      };
      this.emit("PREPARING", "PREPARING");
      try {
        validateDailyTask(task);
        check(task.day === shanghaiDate(this.wall()), "DAY_EXPIRED");
        await this.withAccount(signal, async (uid) => {
          const existing = this.store.conflict(task);
          if (existing) {
            const fresh = this.report;
            this.report = restoredReport(existing);
            if (this.report.state === "SUCCESS" || this.report.verifiedAt) {
              await this.verify(signal);
              if (this.report.verification !== "ABSENT") {
                this.archiveResult({ ...fresh, state: "IDLE", reason: "DUPLICATE" });
                return;
              }
              delete this.store.data.requests[slotKey(this.report.task)];
              this.store.save();
              this.report = fresh;
            } else {
              this.archiveResult({ ...fresh, state: "IDLE", reason: "DUPLICATE" });
              this.emit(
                this.report.accepted ? "ACCEPTED" : "UNKNOWN",
                this.report.reason === "SENDING" ? "PENDING" : this.report.reason
              );
              return;
            }
          }
          this.pace(Math.max(this.wall(), task.planned));
          const path = roomQuery(await this.read("/Space/Category/list?LAB_JSON=1", signal));
          preparationRange((await this.read(path, signal)).data?.range, task);
          check(!signal.aborted, "STOPPED");
          this.preparedWall = this.wall();
          this.preparedMono = this.mono();
          this.report.preparedAt = new Date(this.preparedWall).toISOString();
          this.emit("WAITING", "WAITING");
          await this.wait(signal);
          check(task.day === shanghaiDate(this.wall()), "DAY_EXPIRED");
          await this.submit(uid);
        });
      } catch (error) {
        if (this.report.attempts !== 0) {
          if (!["SUCCESS", "ACCEPTED", "FAILED"].includes(this.report.state)) this.emit("UNKNOWN", "PENDING");
        } else {
          const reason = signal.aborted ? "USER_STOPPED" : codeOf(error);
          this.emit("IDLE", Object.hasOwn(REASONS, reason) ? reason : "LOCAL_ERROR");
        }
      } finally {
        this.archiveResult();
        this.waiting = false;
        this.running = false;
        this.render();
      }
    }
    wait(signal) {
      this.waiting = true;
      return new Promise((resolve, reject) => {
        let timer;
        const finish = (error) => {
          clearTimeout(timer);
          this.wake = null;
          this.waiting = false;
          signal.removeEventListener("abort", cancel);
          if (error) reject(error);
          else resolve();
        };
        const cancel = () => finish(new TestError("STOPPED"));
        this.wake = () => {
          clearTimeout(timer);
          if (signal.aborted) return cancel();
          if (!this.visible() || this.pageSuspended) {
            this.report.hiddenDuringWait = true;
            timer = setTimeout(this.wake, 1e3);
            return;
          }
          const remaining = this.report.task.planned - this.wall();
          if (remaining <= 0) finish();
          else timer = setTimeout(this.wake, nextCheckMs(remaining));
        };
        signal.addEventListener("abort", cancel, { once: true });
        this.wake();
      });
    }
    observePage(event) {
      if (!this.running || this.report.attempts !== 0) return;
      if (event === "freeze" || event === "pagehide") this.pageSuspended = true;
      if (event === "pageshow" || event === "resume" || event === "visibilitychange" && this.visible())
        this.pageSuspended = false;
      if (!this.visible() || this.pageSuspended) this.report.hiddenDuringWait = true;
      this.wake?.();
    }
    stop() {
      if (this.running && !this.reviewing && this.report.attempts === 0) this.controller.abort();
    }
    async submit(uid) {
      const r = this.report, task = r.task;
      this.store.reload();
      check(!this.store.conflict(task), "PENDING");
      this.pace(this.wall());
      const request = signedRequest(
        task.seatId,
        uid,
        task.begin,
        Math.floor(this.wall() / 1e3),
        task.duration
      );
      let undo;
      try {
        const response = await this.io.request(BOOK_PATH, {
          ...request,
          write: true,
          inspectHttpErrors: true,
          beforeDispatch: () => {
            undo = this.store.intent(task, this.wall(), r.runId);
          },
          onDispatched: (at) => {
            r.attempts = 1;
            r.dispatchAt = at;
            r.delayFrom20Ms = Date.parse(at) - task.open;
            r.scheduleLagMs = Date.parse(at) - task.planned;
            r.inWindow = r.delayFrom20Ms >= 800 && r.delayFrom20Ms <= 2e3;
            r.clockChangeMs = Math.round(this.wall() - this.preparedWall - (this.mono() - this.preparedMono));
            r.state = "SENDING";
            r.reason = "SENDING";
            this.saveReceipt();
            this.emit("SENDING", "SENDING");
            this.archiveResult();
          },
          onHeaders: (sample) => {
            r.httpStatus = sample.status;
            r.responseAt = sample.timing.responseAt;
            r.httpMs = sample.timing.dispatchToHeadersMs;
            if (sample.status === 429) {
              this.limit(banUntil(sample.retryAfter, this.wall()));
              this.emit("FAILED", "LIMITED");
              this.saveReceipt();
            }
          }
        });
        r.requestStartAt = response.timing?.requestStartAt;
        r.requestToFirstByteMs = response.timing?.requestToFirstByteMs;
        r.responseDownloadMs = response.timing?.responseDownloadMs;
        r.businessAt = response.timing?.businessResultAt;
        r.businessCode = response.body?.CODE == null ? null : String(response.body.CODE);
        r.businessResult = response.body?.DATA?.result;
        this.message = String(response.body?.DATA?.msg || response.body?.MESSAGE || "").slice(0, 500);
        r.missingFields = receiptMissing(response.body, response.timing?.invalidJson);
        const reason = bookingResult(response.body, response.status, response.timing?.invalidJson);
        if (reason !== "SERVER_SUCCESS") r.failureMessage = this.message;
        if (reason === "LIMITED") this.limit(banUntil(response.retryAfter, this.wall()));
        r.accepted = reason === "SERVER_SUCCESS";
        this.emit(r.accepted ? "ACCEPTED" : unresolved.has(reason) ? "UNKNOWN" : "FAILED", reason);
        this.saveReceipt();
        if (r.accepted) await this.verify();
      } catch (error) {
        if (r.attempts === 0) {
          undo?.();
          throw error;
        }
        if (r.reason !== "LIMITED") this.emit("UNKNOWN", codeOf(error));
        this.saveReceipt();
      }
    }
    async verify(signal) {
      const r = this.report;
      r.storageStatus = null;
      r.archiveSnapshot = null;
      r.verification = "CHECKING";
      this.render();
      try {
        const body = await this.read(RECORD_PATH, signal);
        const items = records(body);
        const matched = verified162(items, { room: r.task.room }, r.task);
        r.verification = matched ? "MATCHED" : "ABSENT";
        r.recordVerified = matched;
        if (matched) {
          r.verifiedAt ||= new Date(this.wall()).toISOString();
          r.state = "SUCCESS";
        } else if (r.state === "SUCCESS") {
          r.state = r.accepted ? "ACCEPTED" : "UNKNOWN";
        }
      } catch (error) {
        r.verification = ["AUTH_REQUIRED", "LIMITED"].includes(error.code) ? error.code : "ERROR";
      }
      this.saveReceipt();
      this.saveDisplay();
      this.render();
    }
    async review() {
      if (this.previous && !this.running) {
        this.report = this.previous;
        this.previous = null;
      }
      if (this.running || !this.report.task || this.report.attempts === 0) return;
      this.running = this.reviewing = true;
      this.store = null;
      this.controller = new AbortController();
      this.render();
      try {
        const task = this.report.task;
        await this.withAccount(this.controller.signal, async () => {
          const saved = this.store.conflict(task);
          check(saved, "ACCOUNT_CHANGED");
          this.report = { ...restoredReport(saved), runId: this.report.runId ?? saved.runId };
          if (this.report.state === "SENDING") {
            this.report.state = "UNKNOWN";
            this.report.reason = "PENDING";
          }
          await this.verify();
        });
      } catch (error) {
        this.report.verification = ["AUTH_REQUIRED", "LIMITED"].includes(error.code) ? error.code : "ERROR";
        this.message = REASONS[codeOf(error)] || REASONS.LOCAL_ERROR;
        this.saveDisplay();
      } finally {
        this.archiveResult();
        this.running = this.reviewing = false;
        this.render();
      }
    }
    diagnosticExport() {
      return publicDiagnostics(this.previous || this.report);
    }
  }
  const PREFS = "hdu-p62:settings";
  const hour = (n) => `${String(n).padStart(2, "0")}:00`;
  function clock(iso) {
    if (!iso) return "—";
    return new Date(Date.parse(iso) + 8 * 36e5).toISOString().slice(11, 23);
  }
  function mountPanel(host, engine, legacy) {
    const root = host.attachShadow({ mode: "open" });
    if (legacy) host.dataset.legacy = "true";
    root.innerHTML = [
      "<style>:host{all:initial;position:fixed;right:8px;bottom:max(8px,env(safe-area-inset-bottom));z-index:2147483646;font:14px/1.5 system-ui,sans-serif;color:#233842}",
      ":host([data-legacy]){top:8px;bottom:auto}*{box-sizing:border-box}details{max-width:calc(100vw - 16px);border:1px solid #a1b9b5;border-radius:10px;background:#f9fdfc;box-shadow:0 2px 12px #183c3b2a}details[open]{width:318px}",
      "summary{padding:9px 12px;cursor:pointer;color:#155d50;font-weight:650}.body{padding:0 12px 12px;max-height:67vh;overflow:auto;overscroll-behavior:contain}",
      "label{display:inline-flex;align-items:center;gap:4px}select,input,button,textarea{font:inherit}select,input,button{min-height:38px;color:inherit}input{width:76px}",
      ".row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:7px 0}button{padding:4px 9px;border:1px solid #9db7b0;border-radius:7px;background:#fff;cursor:pointer}",
      "#start{background:#155d50;color:#fff;border-color:#155d50}button:disabled{opacity:.5}p{margin:7px 0}.note{font-size:12px;color:#526b6b}",
      "output{display:block;overflow-wrap:anywhere;white-space:pre-wrap;font-size:12px}textarea{width:100%;height:110px}</style>",
      '<details><summary>P6.4 候选 · 162 · <span id="state" role="status"></span></summary><div class="body">',
      '<p>宋韵云图（四楼）162号</p><p id="target"></p>',
      '<div class="row"><label>开始 <select id="startHour"></select></label><label>结束 <select id="endHour"></select></label></div>',
      '<label>20:00 后 <input id="offset" type="number" min="800" max="2000" step="1" value="1350"> 毫秒</label>',
      '<p class="note">请保持 Firefox 前台和屏幕常亮，开启系统自动校时。</p>',
      '<div class="row"><button id="start">启动正式预约</button><button id="stop">停止待命</button></div>',
      '<output id="reason" aria-live="polite"></output><output id="metrics"></output>',
      '<div class="row"><button id="review">核验官方记录</button><button id="copy">复制诊断日志</button></div>',
      '<span id="copyStatus" role="status"></span><textarea id="log" aria-label="脱敏诊断日志" readonly hidden></textarea>',
      '<button id="history">查看运行历史（含P6.3）</button><div id="archive" hidden><select id="runs" aria-label="历史运行"></select><textarea id="snapshot" readonly aria-label="历史诊断"></textarea><button id="copyHistory">复制所选 JSON</button></div>',
      "</div></details>"
    ].join("");
    const el = (id) => root.getElementById(id);
    for (let n = 7; n <= 22; n++) {
      if (n < 22) el("startHour").add(new Option(hour(n), n));
      if (n > 7) el("endHour").add(new Option(hour(n), n));
    }
    let settings = DEFAULTS;
    try {
      const saved = JSON.parse(localStorage.getItem(PREFS));
      if (saved && [saved.startHour, saved.endHour, saved.offsetMs].every(Number.isInteger)) {
        dailyTask(Date.now(), saved);
        settings = saved;
      }
    } catch {
    }
    el("startHour").value = settings.startHour;
    el("endHour").value = settings.endHour;
    el("offset").value = settings.offsetMs;
    let shownDay;
    function selection() {
      return dailyTask(Date.now(), {
        startHour: +el("startHour").value,
        endHour: +el("endHour").value,
        offsetMs: +el("offset").value
      });
    }
    function preview() {
      try {
        const task = selection();
        shownDay = task.day;
        el("target").textContent = `预约 ${task.date}　${hour(task.startHour)}–${hour(task.endHour)}`;
        el("start").disabled = engine.running || legacy;
        return task;
      } catch (error) {
        el("target").textContent = REASONS[error.code] || REASONS.INVALID_TIME;
        el("start").disabled = true;
      }
    }
    function render(view) {
      el("state").textContent = legacy ? "检测到旧版" : view.historical ? "未启动 · 上次 " + STATES[view.state] : STATES[view.state];
      el("reason").textContent = (legacy ? REASONS.LEGACY_ACTIVE : view.recordVerified ? REASONS.RECORD_VERIFIED : REASONS[view.reason]) + (view.diagnosticStorageFailed ? "\n诊断存储异常，建议复制日志。" : "") + (view.message ? `
${view.message}` : "") + (view.inWindow === false ? "\n已超出准点窗口。页面暂停或主线程延迟可能推迟请求。" : "");
      el("metrics").textContent = view.date ? [
        `本次 ${view.date}　${hour(view.startHour)}–${hour(view.endHour)}`,
        `计划 ${clock(view.plannedAt)}　发出 ${clock(view.dispatchAt)}`,
        `相对20:00 ${view.delayFrom20Ms ?? "—"} ms　发送 ${view.attempts ?? "未知"} 次`,
        `HTTP ${view.httpStatus ?? "—"}　${view.httpMs == null ? "—" : `${Math.round(view.httpMs)} ms`}`,
        `响应 ${clock(view.responseAt)}　业务码 ${view.businessCode ?? "—"}`,
        `服务器受理 ${view.accepted ? "是" : "未确认"}　${view.reason}`,
        `最近核验 ${VERIFICATIONS[view.verification]}`,
        view.nextWriteAt ? `最早再次申请 ${clock(view.nextWriteAt)}` : ""
      ].filter(Boolean).join("\n") : "";
      for (const id of ["startHour", "endHour", "offset"]) el(id).disabled = view.running;
      el("start").disabled = view.running || legacy || !shownDay;
      el("history").disabled = view.running;
      el("stop").disabled = !view.running || view.reviewing || view.attempts !== 0;
      el("review").disabled = view.running || !["UNKNOWN", "ACCEPTED", "SUCCESS"].includes(view.state);
    }
    for (const id of ["startHour", "endHour", "offset"]) el(id).oninput = preview;
    root.querySelector("details").ontoggle = () => {
      if (!engine.running) preview();
    };
    el("start").onclick = () => {
      const previousDay = shownDay;
      const task = preview();
      if (!task || engine.running || legacy) return;
      if (previousDay !== shownDay) {
        el("target").append("　日期已更新，请核对后启动。");
        return;
      }
      try {
        localStorage.setItem(
          PREFS,
          JSON.stringify({ startHour: task.startHour, endHour: task.endHour, offsetMs: task.offsetMs })
        );
      } catch {
      }
      el("copyStatus").textContent = "";
      el("log").hidden = true;
      void engine.prepare(task);
    };
    el("stop").onclick = () => engine.stop();
    el("review").onclick = () => void engine.review();
    el("history").onclick = () => {
      try {
        const rows = readHistory();
        const runs = el("runs");
        runs.replaceChildren(
          ...rows.map((row, index) => new Option(`${row.prepareStartedAt ?? row.date} · ${row.reason}`, index))
        );
        runs.onchange = () => {
          el("snapshot").value = JSON.stringify(rows[runs.value], null, 2) ?? "";
        };
        runs.onchange();
        el("archive").hidden = false;
        el("copyHistory").disabled = !rows.length;
        el("copyStatus").textContent = rows.length ? "" : "暂无历史记录";
      } catch {
        el("copyStatus").textContent = "历史诊断读取失败";
      }
    };
    el("copyHistory").onclick = () => copy(el("snapshot").value);
    el("copy").onclick = () => copy(JSON.stringify(engine.diagnosticExport(), null, 2));
    async function copy(text) {
      try {
        await navigator.clipboard.writeText(text);
        el("copyStatus").textContent = "已复制";
        el("log").hidden = true;
      } catch {
        el("log").hidden = false;
        el("log").value = text;
        el("log").focus();
        el("log").select();
        el("copyStatus").textContent = "可长按复制所选日志";
      }
    }
    preview();
    return { render };
  }
  function boot() {
    if (location.origin !== ORIGIN || window.top !== window.self || document.getElementById("hdu-p62-host"))
      return;
    const ids = ["hdu-p51-panel", "hdu-p53-host", "hdu-p60-host"];
    const legacy = ids.some((id) => document.getElementById(id));
    const host = document.createElement("div");
    host.id = "hdu-p62-host";
    if (!legacy) {
      for (const id of ids) {
        const marker = document.createElement("span");
        marker.id = id;
        marker.hidden = true;
        host.append(marker);
      }
    }
    document.body.append(host);
    const engine = new DailyEngine(new Transport());
    const panel = mountPanel(host, engine, legacy);
    engine.notify = panel.render;
    engine.render();
    document.addEventListener("visibilitychange", () => engine.observePage("visibilitychange"));
    document.addEventListener("freeze", () => engine.observePage("freeze"));
    document.addEventListener("resume", () => engine.observePage("resume"));
    window.addEventListener("pagehide", () => engine.observePage("pagehide"));
    window.addEventListener("pageshow", () => engine.observePage("pageshow"));
  }
  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot, { once: true });
})();
