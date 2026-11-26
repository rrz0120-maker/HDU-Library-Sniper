import { ORIGIN, BOOK_PATH, check, TestError } from "./core.js";
const PATHS = new Set([
  "/User/Center/baseInfo",
  "/Space/Category/list",
  "/Seat/Index/searchSeats",
  "/Seat/Index/myBookingList",
  "/Seat/Index/bookSeats",
]);
export class Transport {
  constructor() {
    this.clock = null;
  }
  now() {
    return Date.now();
  }
  clockValid() {
    return this.clock && performance.now() - this.clock.at < 60000 && Math.abs(this.clock.offset) <= 5000;
  }
  async request(
    path,
    {
      form,
      token,
      write = false,
      signal,
      onHeaders,
      onDispatch,
      onBusiness,
      beforeDispatch,
      onDispatched,
      inspectHttpErrors = false,
    } = {},
  ) {
    const url = new URL(path, ORIGIN);
    check(location.origin === ORIGIN && url.origin === ORIGIN && PATHS.has(url.pathname), "ORIGIN_DENIED");
    check((url.pathname === "/Seat/Index/bookSeats") === write, "WRITE_GATE_CLOSED");
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
      write ? 30000 : 5000,
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
        ...(form ? { body: form } : {}),
      };
      // Preserve legacy pre-send checks, then sample the actual fetch invocation.
      onDispatch?.(new Date(Date.now()).toISOString());
      beforeDispatch?.();
      start = performance.now();
      const wall = Date.now();
      const pending = fetch(url.href, init);
      timing.dispatchAt = new Date(wall).toISOString();
      // Observation errors must not hide the response of a request already handed off.
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
        retryAfter: response.headers.get("Retry-After"),
      });
      const date = Date.parse(response.headers.get("Date"));
      if (Number.isFinite(date)) this.clock = { at: performance.now(), offset: Date.now() - date };
      if (!response.ok && !inspectHttpErrors)
        throw new TestError(
          response.status === 429 || response.status === 403
            ? "LIMITED"
            : response.status === 401
              ? "AUTH_REQUIRED"
              : response.status === 404
                ? "HTTP_404"
                : "HTTP_ERROR",
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
      // Resource Timing is optional, never a condition for success.
      try {
        const candidates = performance
          .getEntriesByName(url.href, "resource")
          .filter(
            (r) =>
              r.initiatorType === "fetch" &&
              r.startTime >= start &&
              r.startTime <= start + timing.dispatchToHeadersMs &&
              r.requestStart >= r.startTime &&
              r.requestStart > 0,
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
        /* Firefox or browser privacy settings may omit this measurement. */
      }
      return { body, timing, status: response.status, retryAfter: response.headers.get("Retry-After") };
    } catch (error) {
      const failure =
        error instanceof TestError
          ? error
          : new TestError(
              signal?.aborted
                ? "STOPPED"
                : timeout
                  ? "TIMEOUT"
                  : error instanceof SyntaxError
                    ? "RESPONSE_UNKNOWN"
                    : "NETWORK_ERROR",
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
