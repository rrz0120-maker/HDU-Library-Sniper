import {
  ORIGIN,
  BOOK_PATH,
  bookSeatRequest,
  check,
  TestError,
  records,
  roomQuery,
  parseRange,
} from "../core.js";
import { RECORD_PATH } from "../p53/policy.js";
import { BAN_MS, beijing, classify, matchesRecord } from "./policy.js";

const options = { credentials: "same-origin", mode: "same-origin", redirect: "error", cache: "no-store" };
const bookURL = ORIGIN + BOOK_PATH;

// Keep the deadline active until the body is consumed. A truncated reply can still follow a successful write.
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
    },
  };
}

export function limitUntil(retryAfter, now) {
  const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : NaN;
  const headerTime = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(retryAfter);
  return Math.max(now + BAN_MS, Number.isFinite(headerTime) ? headerTime : 0);
}

async function read(path, signal) {
  const clock = deadline(5000, signal);
  try {
    const response = await fetch(ORIGIN + path, {
      ...options,
      signal: clock.signal,
      headers: { Accept: "application/json" },
    });
    const body = await response.json().catch(() => null);
    const code = classify(response.status, body);
    if (code === "LIMITED") {
      const error = new TestError(code);
      error.until = limitUntil(response.headers.get("Retry-After"), Date.now());
      throw error;
    }
    check(code !== "AUTH_REQUIRED", code);
    if (response.status === 404) throw new TestError("READ_404");
    if (clock.signal.aborted) throw new TestError(signal?.aborted ? "STOPPED" : "READ_TIMEOUT");
    check(response.ok && body && (body.CODE === undefined || body.CODE === "ok"), "READ_ERROR");
    return body;
  } catch (error) {
    if (error instanceof TestError) throw error;
    throw new TestError(signal?.aborted ? "STOPPED" : clock.signal.aborted ? "READ_TIMEOUT" : "READ_ERROR");
  } finally {
    clock.close();
  }
}

export async function login(signal) {
  const { DATA } = await read("/User/Center/baseInfo", signal);
  check(DATA?.is_login === true && /^\d+$/.test(String(DATA.uid ?? "")), "AUTH_REQUIRED");
  return String(DATA.uid);
}

export async function verify(task, signal) {
  const items = records(await read(RECORD_PATH, signal));
  if (items.some((item) => matchesRecord(item, task))) return true;
  // An unfamiliar row at this time cannot establish absence for a previously verified booking.
  for (const item of items) {
    if (["3", "4", "5", "6", "7", "9"].includes(String(item?.status))) continue;
    check(Number(item?.time) > 0, "READ_ERROR");
    if (Number(item.time) === task.begin) {
      check(
        ["0", "1", "2"].includes(String(item.status)) &&
          Number(item.duration) > 0 &&
          item.roomName &&
          String(item.seatNum ?? "").trim(),
        "READ_ERROR",
      );
    }
  }
  return false;
}

// Only for an explicitly requested make-up after a definitive NOT_OPEN. Never called by the timer.
export async function confirmOpen(task, signal) {
  const path = roomQuery(await read("/Space/Category/list?LAB_JSON=1", signal));
  const raw = (await read(path, signal)).data?.range;
  const range = parseRange(raw);
  check(
    range.dates.includes(task.date) &&
      task.start >= range.min &&
      task.end <= range.max &&
      task.end - task.start >= Number(raw.min_duration) &&
      task.end - task.start <= Number(raw.max_duration),
    "OPEN_NOT_CONFIRMED",
  );
}

export function networkTiming(mono, wall, headersMono) {
  // Optional browser network-stack measurement; leave null when missing or ambiguous.
  const entries = performance
    .getEntriesByName(bookURL, "resource")
    .filter(
      (entry) =>
        entry.initiatorType === "fetch" &&
        entry.startTime >= mono &&
        entry.startTime <= headersMono &&
        entry.requestStart > 0 &&
        entry.requestStart >= entry.startTime &&
        entry.requestStart <= headersMono,
    );
  if (entries.length !== 1) return {};
  const { requestStart, responseStart, responseEnd } = entries[0];
  return {
    requestStartAt: beijing(wall + Math.round(requestStart - mono)),
    responseWaitMs: responseStart >= requestStart ? Math.round(responseStart - requestStart) : null,
    responseDownloadMs:
      responseStart > 0 && responseEnd >= responseStart ? Math.round(responseEnd - responseStart) : null,
  };
}

export async function submitPrepared(task, uid, report, { beforeSend, onDispatch, onLimit }) {
  const { form, token } = bookSeatRequest(
    task.seatId,
    uid,
    task.begin,
    Math.floor(Date.now() / 1000),
    task.duration,
  );
  const clock = deadline(30000);
  const init = {
    ...options,
    method: "POST",
    body: form,
    signal: clock.signal,
    headers: { Accept: "application/json", "Api-Token": token },
  };
  try {
    const undoIntent = beforeSend(); // Synchronous write-ahead marker under the already-held Web Lock.
    const mono = performance.now();
    const wall = Date.now();
    let pending;
    try {
      pending = fetch(bookURL, init);
    } catch (error) {
      undoIntent(); // The browser never accepted the call.
      throw error;
    }
    // No panel rendering, storage, signing or timer callback between the timestamp and fetch.
    report.dispatchAt = beijing(wall);
    report.sends = 1;
    report.delayFrom20Ms = wall - task.open;
    report.inWindow =
      task.mode === "scheduled" ? report.delayFrom20Ms >= 800 && report.delayFrom20Ms <= 2000 : null;
    onDispatch(wall, mono);
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
      Object.assign(report, networkTiming(mono, wall, headersMono));
    } catch {
      /* optional telemetry */
    }
    if (body !== null) report.businessAt = beijing(Date.now());
    const result = classify(response.status, body);
    report.businessCode = body?.CODE == null ? null : String(body.CODE);
    report.businessResult = body?.DATA?.result ?? null;
    return {
      result:
        clock.signal.aborted && !body && result !== "LIMITED" && result !== "AUTH_REQUIRED"
          ? "TIMEOUT"
          : result,
      message: String(body?.DATA?.msg || body?.MESSAGE || "").slice(0, 500),
      code: report.businessCode,
      until: result === "LIMITED" ? until : 0,
    };
  } finally {
    clock.close();
  }
}
