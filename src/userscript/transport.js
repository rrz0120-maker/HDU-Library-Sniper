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
  async request(path, { form, token, write = false, signal, onHeaders, onDispatch } = {}) {
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
    const start = performance.now();
    const timing = { dispatchAt: new Date().toISOString(), serverProcessingMs: null, requestUploadMs: null };
    try {
      onDispatch?.(timing.dispatchAt);
      const response = await fetch(url.href, {
        method: form ? "POST" : "GET",
        credentials: "same-origin",
        mode: "same-origin",
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
        headers: token ? { "Api-Token": token, Accept: "application/json" } : { Accept: "application/json" },
        ...(form ? { body: form } : {}),
      });
      timing.responseAt = new Date().toISOString();
      timing.dispatchToHeadersMs = performance.now() - start;
      onHeaders?.({
        date: response.headers.get("Date"),
        age: response.headers.get("Age"),
        sentMono: start,
        receivedMono: performance.now(),
        receivedWall: Date.now(),
      });
      const date = Date.parse(response.headers.get("Date"));
      if (Number.isFinite(date)) this.clock = { at: performance.now(), offset: Date.now() - date };
      if (!response.ok)
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
      const body = await response.json();
      timing.bodyDecodeMs = performance.now() - decode;
      return { body, timing };
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
