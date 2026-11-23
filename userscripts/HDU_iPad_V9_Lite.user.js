// ==UserScript==
// @name         HDU iPad V9 Lite · 四楼162
// @namespace    https://github.com/rrz0120-maker/HDU-Library-Sniper/ipad-v9
// @version      9.0.0
// @description  北京时间20:00预约与已开放时段真实预约，使用当前官网会话。
// @match        https://hdu.huitu.zhishulib.com/*
// @grant        none
// @inject-into  page
// @noframes
// @run-at       document-end
// @license      MIT
// ==/UserScript==
(function() {
  "use strict";
  const ORIGIN = "https://hdu.huitu.zhishulib.com";
  const BOOK_PATH = "/Seat/Index/bookSeats?LAB_JSON=1";
  const DAY$1 = 864e5;
  class TestError extends Error {
    constructor(code) {
      super(code);
      this.code = code;
    }
  }
  function check(condition, code) {
    if (!condition) throw new TestError(code);
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
    check(first <= last && (last - first) / DAY$1 <= 31, "DATE_CONTRACT_UNKNOWN");
    const min = integer(raw.minBeginTime), max = integer(raw.maxEndTime);
    check(
      min >= 0 && max <= 24 && min < max && integer(raw.min_duration) <= 1 && integer(raw.min_duration) >= 1 && integer(raw.max_duration) >= 1,
      "ONE_HOUR_NOT_ALLOWED"
    );
    if (raw.max_num !== void 0) check(integer(raw.max_num) >= 1, "ONE_PERSON_NOT_ALLOWED");
    const dates = [];
    for (let at = first; at < last; at += DAY$1) dates.push(shanghaiDate(at));
    return { dates, min, max, maxDateExclusive: shanghaiDate(last) };
  }
  function roomMatches(name) {
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
  function bookSeatRequest(seatId, uid, begin, apiTime, duration) {
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
  const SEAT = Object.freeze({
    room: TASK.room,
    floorId: TASK.floorId,
    seat: TASK.seat,
    seatId: TASK.seatId
  });
  const DAY = 864e5;
  const PACING_MS = 1e4;
  const BAN_MS = 6e5;
  const DEFAULT_OFFSET = 1200;
  function makeTask(mode, now, start = 9, end = 22, offset = DEFAULT_OFFSET) {
    check(mode === "scheduled" || mode === "now", "INVALID_TASK");
    check(
      Number.isInteger(start) && Number.isInteger(end) && start >= 7 && end <= 22 && start < end,
      "INVALID_TIME"
    );
    check(Number.isInteger(offset) && offset >= 800 && offset <= 2e3, "INVALID_OFFSET");
    const today = shanghaiDate(now);
    const tonight = Date.parse(`${today}T20:00:00+08:00`);
    const open = mode === "now" && now < tonight ? tonight - DAY : tonight;
    const date = shanghaiDate(open + 2 * DAY);
    const begin = Date.parse(`${date}T00:00:00+08:00`) / 1e3 + start * 3600;
    return {
      ...SEAT,
      mode,
      date,
      start,
      end,
      begin,
      duration: (end - start) * 3600,
      open,
      planned: mode === "scheduled" ? open + offset : now
    };
  }
  function matchesRecord(row, task) {
    return row && ["0", "1", "2"].includes(String(row.status)) && Number(row.time) === task.begin && Number(row.duration) === task.duration && String(row.seatNum).trim() === SEAT.seat && roomMatches(row.roomName) && (row.seatId === void 0 || String(row.seatId) === SEAT.seatId) && (row.floorId === void 0 || Number(row.floorId) === SEAT.floorId);
  }
  function classify(status, body) {
    const message = String(body?.DATA?.msg || body?.MESSAGE || "");
    const code = responseCode(body);
    if (status === 429 || body?.CODE === "LIMITED" || code === "LIMITED") return "LIMITED";
    if (status === 401 || code === "AUTH_REQUIRED" || body?.CODE === "AUTH_REQUIRED") return "AUTH_REQUIRED";
    if (status >= 500 || status === 408) return "HTTP_UNCERTAIN";
    if (status >= 200 && status < 300 && code === "SERVER_SUCCESS") return code;
    if (body?.CODE === "ParamError") {
      if (/未到(?:预约|开放)时间|(?:预约日期|预约时间|座位预约)(?:尚)?未开放|超出可预约座位时间范围/.test(message))
        return "NOT_OPEN";
      if (code === "EXISTING" || code === "SEAT_UNAVAILABLE") return code;
      return "BUSINESS_REJECTED";
    }
    if (status === 404 || body?.CODE === "NotFound") return "HTTP_404";
    if (body?.DATA?.result === "fail" || body?.CODE && body.CODE !== "ok" && message)
      return "BUSINESS_REJECTED";
    return status >= 400 ? "HTTP_UNCERTAIN" : "RESPONSE_UNKNOWN";
  }
  const REASONS = Object.freeze({
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
    LOCAL_ERROR: "准备失败，可重新启动"
  });
  const STATES = Object.freeze({
    idle: "未启动",
    preparing: "准备中",
    waiting: "等待20:00",
    sending: "正在发送",
    accepted: "服务器已受理",
    verified: "预约成功且记录已核验",
    failed: "预约失败",
    unknown: "结果待核实"
  });
  const VERIFICATIONS = Object.freeze({
    none: "未核验",
    checking: "正在读取官方记录",
    matched: "匹配",
    absent: "未见匹配记录",
    error: "读取失败",
    auth: "核验时需重新登录",
    limited: "核验时馆方返回限流"
  });
  const publicCodes = /* @__PURE__ */ new Set(["ok", "ParamError", "NotFound", "LIMITED", "AUTH_REQUIRED", "1", "0"]);
  function beijing(ms) {
    return new Date(ms + 8 * 36e5).toISOString().replace("Z", "+08:00");
  }
  function diagnostic(source = {}) {
    function stamp(key) {
      const value = source[key];
      return typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}\+08:00$/.test(value) ? value : null;
    }
    const num = (key) => Number.isFinite(source[key]) ? source[key] : null;
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
      timingStatus: inWindow === false || result === "MISSED_DAY" ? "WINDOW_MISSED" : inWindow ? "IN_WINDOW" : null,
      hiddenDuringWait: source.hiddenDuringWait === true,
      httpStatus: num("httpStatus"),
      businessCode: publicCodes.has(source.businessCode) ? source.businessCode : source.businessCode ? "OTHER" : null,
      businessResult: ["success", "fail"].includes(source.businessResult) ? source.businessResult : null,
      sends: [0, 1].includes(source.sends) ? source.sends : null,
      verification: Object.hasOwn(VERIFICATIONS, source.verification) ? source.verification : "none",
      verifiedAt: stamp("verifiedAt"),
      nextWriteAfter: stamp("nextWriteAfter")
    };
  }
  function initialReport(task) {
    return diagnostic({
      ...task,
      plannedAt: beijing(task.planned),
      state: "preparing",
      result: "PREPARING",
      sends: 0
    });
  }
  async function accountName(uid) {
    return `hdu-v9:${await accountKey(uid)}`;
  }
  function slotKey(task) {
    return [task.date, task.start, task.end].join("/");
  }
  class Guard {
    constructor(name, today) {
      this.name = name;
      try {
        const raw = localStorage.getItem(name);
        this.data = raw === null ? { next: 0, limited: 0, slots: {} } : JSON.parse(raw);
        check(
          Number.isFinite(this.data.next) && Number.isFinite(this.data.limited) && this.data.slots && typeof this.data.slots === "object",
          "GUARD_UNAVAILABLE"
        );
        for (const key of Object.keys(this.data.slots)) {
          if (key.slice(0, 10) < today) delete this.data.slots[key];
        }
      } catch {
        throw new TestError("GUARD_UNAVAILABLE");
      }
    }
    save() {
      try {
        localStorage.setItem(this.name, JSON.stringify(this.data));
      } catch {
        throw new TestError("GUARD_UNAVAILABLE");
      }
    }
    record(task, report, phase, supplemented) {
      this.data.slots[slotKey(task)] = { phase, supplemented, report: diagnostic(report) };
      this.save();
    }
    intent(task, report, supplemented) {
      const key = slotKey(task);
      const previous = this.data.slots[key];
      const previousNext = this.data.next;
      this.data.next = Date.now() + PACING_MS;
      this.record(
        task,
        { ...report, sends: null, state: "unknown", result: "PENDING" },
        "pending",
        supplemented
      );
      return () => {
        this.data.next = previousNext;
        if (previous) this.data.slots[key] = previous;
        else delete this.data.slots[key];
        this.save();
      };
    }
  }
  const LAST = "hdu-v9:last";
  function rememberGuard(name) {
    try {
      sessionStorage.setItem(`${LAST}-guard`, name);
    } catch {
    }
  }
  function recall() {
    try {
      let data = diagnostic(JSON.parse(sessionStorage.getItem(LAST)) || { sends: 0 });
      const name = sessionStorage.getItem(`${LAST}-guard`);
      if (data.date && /^hdu-v9:[a-f0-9]{64}$/.test(name)) {
        const row = JSON.parse(localStorage.getItem(name))?.slots?.[slotKey(data)];
        if (row?.report?.plannedAt === data.plannedAt) data = diagnostic(row.report);
      }
      if (data.state === "sending") Object.assign(data, { state: "unknown", result: "PENDING" });
      if (data.verification === "checking") data.verification = "none";
      if (["preparing", "waiting"].includes(data.state))
        Object.assign(data, { state: "idle", result: "STOPPED" });
      return diagnostic(data);
    } catch {
      return diagnostic();
    }
  }
  function remember(report) {
    try {
      sessionStorage.setItem(LAST, JSON.stringify(diagnostic(report)));
    } catch {
    }
  }
  const options = { credentials: "same-origin", mode: "same-origin", redirect: "error", cache: "no-store" };
  const bookURL = ORIGIN + BOOK_PATH;
  function deadline(ms, parent) {
    const ctrl = new AbortController();
    const abort = () => ctrl.abort();
    const timer = setTimeout(abort, ms);
    if (parent?.aborted) abort();
    parent?.addEventListener("abort", abort, { once: true });
    return {
      signal: ctrl.signal,
      close() {
        clearTimeout(timer);
        parent?.removeEventListener("abort", abort);
      }
    };
  }
  function limitUntil(retryAfter, now) {
    const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : NaN;
    const headerTime = Number.isFinite(seconds) ? now + seconds * 1e3 : Date.parse(retryAfter);
    return Math.max(now + BAN_MS, Number.isFinite(headerTime) ? headerTime : 0);
  }
  async function read(path, signal) {
    const clock = deadline(5e3, signal);
    try {
      const response = await fetch(ORIGIN + path, {
        ...options,
        signal: clock.signal,
        headers: { Accept: "application/json" }
      });
      const body = await response.json().catch(() => null);
      const code = classify(response.status, body);
      if (code === "LIMITED") {
        const error = new TestError(code);
        error.until = limitUntil(response.headers.get("Retry-After"), Date.now());
        throw error;
      }
      check(code !== "AUTH_REQUIRED", code);
      check(response.ok && body && (body.CODE === void 0 || body.CODE === "ok"), "READ_ERROR");
      return body;
    } catch (error) {
      if (error instanceof TestError) throw error;
      throw new TestError(signal?.aborted ? "STOPPED" : "READ_ERROR");
    } finally {
      clock.close();
    }
  }
  async function login(signal) {
    const { DATA } = await read("/User/Center/baseInfo", signal);
    check(DATA?.is_login === true && /^\d+$/.test(String(DATA.uid ?? "")), "AUTH_REQUIRED");
    return String(DATA.uid);
  }
  async function verify(task, signal) {
    const items = records(await read(RECORD_PATH, signal));
    if (items.some((item) => matchesRecord(item, task))) return true;
    for (const item of items) {
      if (["3", "4", "5", "6", "7", "9"].includes(String(item?.status))) continue;
      check(Number(item?.time) > 0, "READ_ERROR");
      if (Number(item.time) === task.begin) {
        check(
          ["0", "1", "2"].includes(String(item.status)) && Number(item.duration) > 0 && item.roomName && String(item.seatNum ?? "").trim(),
          "READ_ERROR"
        );
      }
    }
    return false;
  }
  async function confirmOpen(task, signal) {
    const path = roomQuery(await read("/Space/Category/list?LAB_JSON=1", signal));
    const raw = (await read(path, signal)).data?.range;
    const range = parseRange(raw);
    check(
      range.dates.includes(task.date) && task.start >= range.min && task.end <= range.max && task.end - task.start >= Number(raw.min_duration) && task.end - task.start <= Number(raw.max_duration),
      "OPEN_NOT_CONFIRMED"
    );
  }
  function requestStart(mono, wall, headersMono) {
    const entries = performance.getEntriesByName(bookURL, "resource").filter(
      (entry) => entry.initiatorType === "fetch" && entry.startTime >= mono && entry.startTime <= headersMono && entry.requestStart > 0 && entry.requestStart >= entry.startTime && entry.requestStart <= headersMono
    );
    return entries.length === 1 ? beijing(wall + Math.round(entries[0].requestStart - mono)) : null;
  }
  async function submitPrepared(task, uid, report, { beforeSend, onDispatch, onLimit }) {
    const { form, token } = bookSeatRequest(
      task.seatId,
      uid,
      task.begin,
      Math.floor(Date.now() / 1e3),
      task.duration
    );
    const clock = deadline(3e4);
    const init = {
      ...options,
      method: "POST",
      body: form,
      signal: clock.signal,
      headers: { Accept: "application/json", "Api-Token": token }
    };
    try {
      const undoIntent = beforeSend();
      const mono = performance.now();
      const wall = Date.now();
      let pending;
      try {
        pending = fetch(bookURL, init);
      } catch (error) {
        undoIntent();
        throw error;
      }
      report.dispatchAt = beijing(wall);
      report.sends = 1;
      report.delayFrom20Ms = wall - task.open;
      report.inWindow = task.mode === "scheduled" ? report.delayFrom20Ms >= 800 && report.delayFrom20Ms <= 2e3 : null;
      onDispatch();
      let response;
      try {
        response = await pending;
      } catch {
        return { result: clock.signal.aborted ? "TIMEOUT" : "NETWORK_ERROR" };
      }
      const headersMono = performance.now();
      report.responseAt = beijing(Date.now());
      report.httpMs = Math.round((headersMono - mono) * 10) / 10;
      report.httpStatus = response.status;
      const until = limitUntil(response.headers.get("Retry-After"), Date.now());
      if (response.status === 429) onLimit?.(until);
      const body = await response.json().catch(() => null);
      try {
        report.requestStartAt = requestStart(mono, wall, headersMono);
      } catch {
      }
      const result = classify(response.status, body);
      report.businessCode = body?.CODE == null ? null : String(body.CODE);
      report.businessResult = body?.DATA?.result ?? null;
      return {
        result: clock.signal.aborted && !body && result !== "LIMITED" && result !== "AUTH_REQUIRED" ? "TIMEOUT" : result,
        message: String(body?.DATA?.msg || body?.MESSAGE || "").slice(0, 500),
        code: report.businessCode,
        until: result === "LIMITED" ? until : 0
      };
    } finally {
      clock.close();
    }
  }
  const uncertain = /* @__PURE__ */ new Set(["TIMEOUT", "NETWORK_ERROR", "HTTP_UNCERTAIN", "RESPONSE_UNKNOWN"]);
  const errorCode = (e) => Object.hasOwn(REASONS, e?.code) ? e.code : "LOCAL_ERROR";
  function waitUntil(target, signal, report) {
    return new Promise((resolve, reject) => {
      let timer;
      function finish(error) {
        clearTimeout(timer);
        document.removeEventListener("visibilitychange", wake);
        window.removeEventListener("pageshow", wake);
        signal.removeEventListener("abort", cancel);
        if (error) reject(error);
        else resolve();
      }
      function cancel() {
        finish(new TestError("STOPPED"));
      }
      function wake() {
        clearTimeout(timer);
        if (signal.aborted) return cancel();
        if (document.hidden) {
          report.hiddenDuringWait = true;
          return;
        }
        const left = target - Date.now();
        if (left <= 0) finish();
        else timer = setTimeout(wake, Math.min(left, 3e4));
      }
      document.addEventListener("visibilitychange", wake);
      window.addEventListener("pageshow", wake);
      signal.addEventListener("abort", cancel, { once: true });
      wake();
    });
  }
  class Booking {
    constructor(render, legacy) {
      this.render = render;
      this.legacy = legacy;
      this.report = recall();
      this.active = null;
      this.detail = "";
      this.sessionLimit = 0;
    }
    update(state, result) {
      Object.assign(this.report, { state, result });
      remember(this.report);
      this.paint();
    }
    paint() {
      this.render(diagnostic(this.report), this.detail, this.active);
    }
    stop() {
      if (this.active && !this.active.dispatched && !this.active.review) this.active.controller.abort();
    }
    // Acquire once in preparation, never queue a second writer behind the timer.
    async withAccount(run, work) {
      const signal = run.controller.signal;
      const uid = await login(signal);
      const name = await accountName(uid);
      check(!signal.aborted, "STOPPED");
      check(navigator.locks?.request, "LOCK_UNAVAILABLE");
      await navigator.locks.request(name, { ifAvailable: true }, async (lock) => {
        check(lock, "ACTIVE_TAB");
        check(!signal.aborted, "STOPPED");
        const guard = new Guard(name, shanghaiDate());
        if (!run.review) rememberGuard(name);
        try {
          await work(uid, guard);
        } catch (error) {
          if (error.until) {
            this.sessionLimit = guard.data.limited = error.until;
            try {
              guard.save();
            } catch {
              this.storageNote();
            }
          }
          throw error;
        }
      });
    }
    async start(task) {
      if (this.active) return;
      const run = { controller: new AbortController(), dispatched: false };
      this.active = run;
      this.report = initialReport(task);
      this.detail = "";
      this.update("preparing", "PREPARING");
      try {
        check(!this.legacy, "LEGACY");
        check(task.mode !== "scheduled" || Date.now() < task.open, "TOO_LATE");
        await this.withAccount(run, (uid, guard) => this.reserve(task, run, uid, guard));
      } catch (error) {
        if (error.until) {
          this.sessionLimit = Math.max(this.sessionLimit, error.until);
          this.report.nextWriteAfter = beijing(this.sessionLimit);
        }
        if (run.dispatched) this.update("unknown", "PENDING");
        else {
          const reason = run.controller.signal.aborted ? "STOPPED" : errorCode(error);
          this.update("idle", reason);
        }
      } finally {
        this.active = null;
        this.paint();
      }
    }
    checkPace(guard, at) {
      const limited = Math.max(this.sessionLimit, guard.data.limited);
      const next = Math.max(guard.data.next, limited);
      if (next > at) {
        this.report.nextWriteAfter = beijing(next);
        throw new TestError(limited > at ? "LIMITED" : "PACING");
      }
    }
    async reserve(task, run, uid, guard) {
      const signal = run.controller.signal;
      const row = guard.data.slots[slotKey(task)];
      if (row?.phase === "pending" || row?.phase === "accepted") {
        this.report = diagnostic(row.report);
        if (row.phase === "pending")
          this.update("unknown", this.report.state === "unknown" ? this.report.result : "PENDING");
        else this.update("accepted", "SERVER_SUCCESS");
        return;
      }
      if (row?.phase === "verified") {
        const fresh = this.report;
        this.report = diagnostic(row.report);
        await this.checkRecord(task, guard, row.phase, row.supplemented, signal);
        if (this.report.verification !== "absent") return;
        this.report = fresh;
      }
      const supplement = row?.phase === "not-open";
      this.checkPace(guard, Math.max(task.planned, Date.now()));
      if (supplement) {
        check(task.mode === "now" && !row.supplemented, "NO_SUPPLEMENT");
        await confirmOpen(task, signal);
      }
      check(!signal.aborted, "STOPPED");
      this.report.preparedAt = beijing(Date.now());
      if (task.mode === "scheduled") this.update("waiting", "WAITING");
      await waitUntil(task.planned, signal, this.report);
      check(!signal.aborted, "STOPPED");
      check(shanghaiDate(Date.now()) === shanghaiDate(task.planned), "MISSED_DAY");
      const report = this.report;
      const receipt = await submitPrepared(task, uid, report, {
        beforeSend: () => {
          this.checkPace(guard, Date.now());
          return guard.intent(task, report, supplement);
        },
        onDispatch: () => {
          run.dispatched = true;
          guard.data.next = Date.parse(report.dispatchAt) + PACING_MS;
          this.update("sending", "SENDING");
          this.saveReceipt(guard, task, "pending", supplement);
        },
        onLimit: (until) => {
          this.sessionLimit = guard.data.limited = until;
          report.nextWriteAfter = beijing(until);
          this.update("failed", "LIMITED");
          this.saveReceipt(guard, task, "limited", supplement);
        }
      });
      this.detail = [receipt.code, receipt.message].filter(Boolean).join(" · ");
      const result = receipt.result;
      if (result === "LIMITED") {
        this.sessionLimit = guard.data.limited = receipt.until;
        report.nextWriteAfter = beijing(receipt.until);
      }
      if (result === "SERVER_SUCCESS") {
        this.update("accepted", result);
        this.saveReceipt(guard, task, "accepted", supplement);
        await this.checkRecord(task, guard, "accepted", supplement, signal);
      } else if (uncertain.has(result)) {
        this.update("unknown", result);
        this.saveReceipt(guard, task, "pending", supplement);
      } else {
        this.update("failed", result);
        if (result === "NOT_OPEN") this.saveReceipt(guard, task, "not-open", supplement);
        else {
          delete guard.data.slots[slotKey(task)];
          try {
            guard.save();
          } catch {
            this.storageNote();
          }
        }
      }
    }
    storageNote() {
      this.detail += "（本机回执保存失败，请保留诊断并查看官方记录）";
    }
    saveReceipt(guard, task, phase, supplement) {
      try {
        guard.record(task, this.report, phase, supplement);
      } catch {
        this.storageNote();
      }
    }
    async checkRecord(task, guard, phase, supplement, signal) {
      const r = this.report;
      r.verification = "checking";
      this.paint();
      try {
        if (await verify(task, signal)) {
          r.verification = "matched";
          r.verifiedAt ??= beijing(Date.now());
          this.update("verified", r.result);
          this.saveReceipt(guard, task, "verified", supplement);
          return;
        }
        r.verification = "absent";
      } catch (error) {
        r.verification = error.code === "AUTH_REQUIRED" ? "auth" : error.code === "LIMITED" ? "limited" : "error";
        if (error.until) {
          this.sessionLimit = guard.data.limited = error.until;
          r.nextWriteAfter = beijing(error.until);
        }
      }
      if (phase === "verified") r.state = r.result === "SERVER_SUCCESS" ? "accepted" : "unknown";
      remember(r);
      this.saveReceipt(guard, task, phase, supplement);
      this.paint();
    }
    async review() {
      if (this.active || !["accepted", "unknown", "verified"].includes(this.report.state)) return;
      const r = this.report;
      const run = { controller: new AbortController(), review: true };
      this.active = run;
      this.paint();
      try {
        const release = Date.parse(`${r.date}T20:00:00+08:00`) - 2 * DAY;
        const task = makeTask("scheduled", release, r.start, r.end);
        await this.withAccount(run, async (_, guard) => {
          const row = guard.data.slots[slotKey(task)];
          check(row, "ACCOUNT_MISMATCH");
          this.report = diagnostic(row.report);
          if (row.phase === "pending" && this.report.state !== "unknown") this.update("unknown", "PENDING");
          await this.checkRecord(task, guard, row.phase, row.supplemented, run.controller.signal);
        });
      } catch (error) {
        if (error.until) this.sessionLimit = Math.max(this.sessionLimit, error.until);
        this.report.verification = error.code === "AUTH_REQUIRED" ? "auth" : error.code === "LIMITED" ? "limited" : "error";
        this.detail = REASONS[errorCode(error)];
        remember(this.report);
      } finally {
        this.active = null;
        this.paint();
      }
    }
  }
  const hostId = "hdu-ipad-v9-lite";
  const legacyIds = ["hdu-p51-panel", "hdu-p53-host", "hdu-p60-host", "hdu-p70-host", "hdu-p71-host"];
  function mount() {
    if (location.origin !== ORIGIN || window !== window.top || document.getElementById(hostId)) return;
    const host = document.createElement("div");
    host.id = hostId;
    const legacy = legacyIds.some((id) => document.getElementById(id));
    if (legacy) host.dataset.legacy = "present";
    if (!legacy) {
      for (const id of legacyIds) {
        const marker = document.createElement("span");
        marker.id = id;
        marker.hidden = true;
        host.append(marker);
      }
    }
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = [
      "<style>:host{all:initial;position:fixed;right:max(8px,env(safe-area-inset-right));bottom:max(8px,env(safe-area-inset-bottom));z-index:2147483000;color:#172c36;font:15px/1.4 system-ui,sans-serif}",
      ":host([data-legacy]){top:max(8px,env(safe-area-inset-top));bottom:auto}",
      "*{box-sizing:border-box}details{max-width:calc(100vw - 16px);background:#fafdfc;border:1px solid #9bb5ae;border-radius:12px;box-shadow:0 3px 14px #132e382b}details[open]{width:332px}",
      "summary{cursor:pointer;padding:10px 13px;color:#164f46;font-weight:650;overflow-wrap:anywhere}.body{padding:0 12px 12px;max-height:65vh;overflow:auto;overscroll-behavior:contain}",
      "label{display:inline-flex;align-items:center;gap:4px}select,input,button,textarea{font:inherit;color:inherit}input{width:80px}select,input,button{min-height:36px}",
      "button{cursor:pointer;border:1px solid #a4b9b2;border-radius:7px;background:#fff;padding:4px 9px}button:disabled{opacity:.5}#start{background:#155c50;color:white;border-color:#155c50}",
      ".row{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin:6px 0}p{margin:6px 0}.note{font-size:13px;color:#486059}output{display:block;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}textarea{width:100%;height:95px}</style>",
      '<details><summary>162 预约 · <span id="status" role="status"></span></summary><div class="body">',
      '<p>宋韵云图（四楼） · 162 号</p><label>模式 <select id="mode"><option value="scheduled">整点预约</option><option value="now">已开放时段测试</option></select></label>',
      '<div class="row"><label>开始 <select id="from"></select></label><label>结束 <select id="to"></select></label></div>',
      '<label id="offsetRow">20:00 后 <input type="number" min="800" max="2000" step="1" id="offset" value="1200"> 毫秒</label>',
      '<p id="target"></p><p class="note">请保持 Safari 前台、屏幕常亮，并开启系统自动校时。</p>',
      '<div class="row"><button id="start"></button><button id="stop">停止</button></div>',
      '<output id="feedback" aria-live="polite"></output><output id="metrics"></output>',
      '<div class="row"><button id="review">核验官方记录</button><button id="copy">复制诊断日志</button></div>',
      '<span id="copied" role="status"></span><textarea id="log" aria-label="诊断日志" readonly hidden></textarea>',
      "</div></details>"
    ].join("");
    document.body.append(host);
    const el = (id) => root.getElementById(id);
    const details = root.querySelector("details");
    const fmtHour = (hour) => `${String(hour).padStart(2, "0")}:00`;
    for (let hour = 7; hour <= 22; hour++) {
      if (hour < 22) el("from").add(new Option(fmtHour(hour), hour));
      if (hour > 7) el("to").add(new Option(fmtHour(hour), hour));
    }
    let prefs;
    try {
      prefs = JSON.parse(localStorage.getItem("hdu-v9:settings"));
    } catch {
    }
    try {
      if (![prefs.start, prefs.end, prefs.offset].every(Number.isInteger)) throw new Error();
      makeTask("scheduled", Date.now(), prefs.start, prefs.end, prefs.offset);
    } catch {
      prefs = { start: 9, end: 22, offset: 1200 };
    }
    el("from").value = prefs.start;
    el("to").value = prefs.end;
    el("offset").value = prefs.offset;
    const booking = new Booking(render, legacy);
    let shownDate;
    function selection() {
      return makeTask(el("mode").value, Date.now(), +el("from").value, +el("to").value, +el("offset").value);
    }
    function preview() {
      el("offsetRow").style.display = el("mode").value === "scheduled" ? "" : "none";
      el("start").textContent = el("mode").value === "now" ? "立即真实预约" : "启动 20:00 预约";
      try {
        const task = selection();
        shownDate = task.date;
        el("target").textContent = `预约 ${task.date}　${fmtHour(task.start)}–${fmtHour(task.end)}`;
        el("start").disabled = !!booking.active || legacy;
        return task;
      } catch (error) {
        shownDate = null;
        el("target").textContent = REASONS[error.code] || "请检查设置";
        el("start").disabled = true;
      }
    }
    function render(r, detail, run) {
      el("status").textContent = legacy ? "检测到旧版" : STATES[r.state];
      const warning = r.inWindow === false ? "\n超出准点窗口；前台主线程延迟或系统暂停均可能推迟发送。" : "";
      el("feedback").textContent = (legacy ? `${REASONS.LEGACY}
` : "") + (r.state === "idle" && r.result === "IDLE" ? "" : r.reason) + (detail ? `
${detail}` : "") + warning;
      const time = (stamp) => stamp ? stamp.slice(11, 23) : "—";
      el("metrics").textContent = r.date ? [
        `本次 ${r.date}　${fmtHour(r.start)}–${fmtHour(r.end)}`,
        `计划 ${time(r.plannedAt)}　发出 ${time(r.dispatchAt)}`,
        "相对开放 " + (r.delayFrom20Ms == null ? "—" : `${r.delayFrom20Ms} ms`) + "　实际发送 " + (r.sends ?? "未知"),
        `响应 ${time(r.responseAt)}　${r.httpMs == null ? "—" : `${r.httpMs} ms`}`,
        `HTTP ${r.httpStatus ?? "—"}　业务码 ${r.businessCode ?? "—"}　${r.result}`,
        `官方记录 ${VERIFICATIONS[r.verification]}`,
        r.nextWriteAfter ? `最早可重新申请 ${r.nextWriteAfter.slice(0, 19).replace("T", " ")}` : ""
      ].filter(Boolean).join("\n") : "";
      for (const id of ["mode", "from", "to", "offset"]) el(id).disabled = !!run;
      el("start").disabled = !!run || legacy || !shownDate;
      el("stop").disabled = !run || run.dispatched || run.review;
      el("review").disabled = !!run || !["unknown", "accepted", "verified"].includes(r.state);
    }
    for (const id of ["mode", "from", "to", "offset"]) el(id).oninput = preview;
    details.ontoggle = () => {
      if (details.open && !booking.active) preview();
    };
    el("start").onclick = () => {
      const previousDate = shownDate;
      const task = preview();
      if (!task || booking.active || legacy) return;
      if (previousDate !== shownDate) {
        el("target").append("　日期已更新，请确认后启动。");
        return;
      }
      try {
        localStorage.setItem(
          "hdu-v9:settings",
          JSON.stringify({ start: task.start, end: task.end, offset: +el("offset").value })
        );
      } catch {
      }
      el("copied").textContent = "";
      el("log").hidden = true;
      void booking.start(task);
    };
    el("stop").onclick = () => booking.stop();
    el("review").onclick = () => void booking.review();
    el("copy").onclick = async () => {
      const json = JSON.stringify(diagnostic(booking.report), null, 2);
      try {
        await navigator.clipboard.writeText(json);
        el("copied").textContent = "已复制";
        el("log").hidden = true;
      } catch {
        const box = el("log");
        box.hidden = false;
        box.value = json;
        box.focus();
        box.select();
        el("copied").textContent = "可长按复制所选日志";
      }
    };
    preview();
    booking.paint();
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
})();
