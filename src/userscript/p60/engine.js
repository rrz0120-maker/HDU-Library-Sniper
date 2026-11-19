import { category, check, codeOf, responseCode, shanghaiDate } from "../core.js";
import { SingleEngine } from "../p53/engine.js";
import { PREPARE_MS, RECORD_PATH } from "../p53/policy.js";
import {
  dailyTask,
  isP53Slot,
  mergeDiagnostics,
  openingRange,
  publicDiagnostics,
  validateDailyTask,
} from "./policy.js";

const RESULTS = new Set([
  "SERVER_SUCCESS",
  "SEAT_UNAVAILABLE",
  "NOT_OPEN",
  "EXISTING",
  "LIMITED",
  "AUTH_REQUIRED",
  "HTTP_404",
  "TIMEOUT",
  "NETWORK_ERROR",
  "RESPONSE_UNKNOWN",
]);
export class DailyEngine extends SingleEngine {
  constructor(io, store, notify, env = {}) {
    super(io, store, notify, { ...env, task: env.task || dailyTask((env.wall || Date.now)()) });
    validateDailyTask(this.task);
    this.canWrite = env.canWrite !== false;
    this.timings.scheduledAt = new Date(this.task.open).toISOString();
    this.diagWrites = Promise.resolve();
  }
  iso() {
    return new Date(this.wall()).toISOString();
  }
  ensure(g) {
    super.ensure(g);
    if (this.formal && !this.reviewing)
      check(shanghaiDate(this.wall()) === this.task.day, "AUTHORIZATION_EXPIRED");
  }
  mark(values) {
    this.timings = mergeDiagnostics(this.timings, values);
  }
  persistDiagnostics() {
    if (!this.key) return;
    const key = this.key,
      values = structuredClone(this.timings),
      logs = this.logs.slice();
    // Metadata writes never delay first response feedback or the booking fetch.
    this.diagWrites = this.diagWrites
      .then(() => this.store.note(key, values, logs))
      .catch(() => {
        this.diagnosticStorageFailed = true;
      });
  }
  emit(state, reason, details = {}) {
    if (state === "WAITING" && !this.waiting) {
      state = "IDLE";
      reason = "WAITING_VIEW_ONLY";
    }
    if (reason === "SUBMITTING_ONCE") state = "SUBMITTING";
    if (reason === "SERVER_SUCCESS" && state !== "SUCCESS") state = "VERIFYING";
    if (
      ["SEAT_UNAVAILABLE", "NOT_OPEN", "EXISTING"].includes(reason) &&
      this.attempted &&
      state === "UNKNOWN"
    )
      state = "VERIFYING";
    if (
      ["MISSED_WINDOW", "PREPARE_WINDOW", "AUTHORIZATION_EXPIRED", "PREPARE_TOO_LATE_OR_STOPPED"].includes(
        reason,
      ) &&
      !this.attempted
    )
      state = "EXPIRED";
    if (reason === "FORMAL_PREFLIGHT" || reason === "READ_ONLY_REHEARSAL")
      this.mark({ prepareStartedAt: this.iso() });
    if (reason === "ARMED_FOR_2000") this.mark({ armedAt: this.iso() });
    const http = this.timings.http;
    if (http)
      this.mark({
        dispatchToHeadersMs: http.dispatchToHeadersMs,
        bodyDecodeMs: http.bodyDecodeMs,
        totalRequestMs: http.totalRequestMs,
      });
    if (this.attempted && RESULTS.has(reason))
      this.mark({ responseCode: reason, resultStateUpdatedAt: this.iso() });
    if (this.reviewing && reason === "RECORD_VERIFIED" && !this.verifiedDuringReview)
      reason = "REVIEW_SAVED_RESULT";
    if (this.state === state && this.reason === reason && !["LOGIN_OK", "RANGE_OK"].includes(reason)) return;
    this.state = state;
    this.reason = reason;
    const category = this.verifying
      ? "RECORD_VERIFICATION"
      : this.reviewing
        ? "REVIEW"
        : reason === "HTTP_HEADERS"
          ? "BOOKING_HTTP"
          : ["HTTP_404", "TIMEOUT", "NETWORK_ERROR", "HTTP_ERROR", "STOPPED"].includes(reason) &&
              this.attempted
            ? "BOOKING_REQUEST_ERROR"
            : RESULTS.has(reason) && this.attempted
              ? "BOOKING_BUSINESS_RESULT"
              : reason === "RECORD_VERIFIED"
                ? "RECORD_VERIFICATION"
                : ["UI_REATTACHED", "PAGE_CONTEXT_END", "PAGE_ERROR_OBSERVED"].includes(reason)
                  ? "PAGE_OBSERVATION"
                  : state === "PREPARING" || (!this.attempted && !this.waiting)
                    ? "QUERY_OR_PREPARATION"
                    : "TASK";
    this.logs.push({ at: this.iso(), category, state, reason, ...details });
    if (this.logs.length > 60) this.logs.shift();
    this.notify(this.view());
    this.persistDiagnostics();
  }
  view() {
    return {
      ...super.view(),
      task: this.task,
      attempts: this.attempted ? 1 : 0,
      diagnosticStorageFailed: !!this.diagnosticStorageFailed,
    };
  }
  async login(g, observe = true) {
    await super.login(g, observe);
    this.store.bind(this.identity.account);
  }
  async read(path, g, form, observe = true) {
    try {
      const body = await super.read(path, g, form, observe);
      if (
        this.state === "PREPARING" &&
        !form &&
        path.startsWith("/Seat/Index/searchSeats?") &&
        body?.data?.range
      ) {
        this.openRangePath = path;
        this.openRangeCategory = category(body.data);
      }
      return body;
    } catch (e) {
      this.logs.push({
        at: this.iso(),
        category: path === RECORD_PATH ? "RECORD_QUERY_ERROR" : "QUERY_REQUEST_ERROR",
        state: this.state,
        reason: codeOf(e),
      });
      this.persistDiagnostics();
      throw e;
    }
  }
  async prepare({ arm = false, confirmed = false, authorizedDay } = {}) {
    if (this.busy || this.formal) return this.view();
    if (
      arm &&
      (!this.canWrite ||
        !confirmed ||
        authorizedDay !== this.task.day ||
        shanghaiDate(this.wall()) !== this.task.day)
    ) {
      this.emit("STOPPED", "TODAY_AUTHORIZATION_REQUIRED");
      return this.view();
    }
    if (arm && isP53Slot(this.task)) {
      this.emit("STOPPED", "P53_SLOT_FROZEN");
      return this.view();
    }
    if (arm && this.wall() < this.task.open - PREPARE_MS) {
      this.emit("IDLE", "PREPARE_TOO_EARLY");
      return this.view();
    }
    this.timings = { scheduledAt: new Date(this.task.open).toISOString() };
    this.openRangePath = undefined;
    this.openRangeCategory = undefined;
    this.openProofGeneration = undefined;
    this.openingChecks = 0;
    this.nextOpeningCheckMono = 0;
    if (arm && this.wall() >= this.task.open - PREPARE_MS && this.wall() < this.task.open)
      this.store.activateDay?.();
    return super.prepare({ arm, confirmed });
  }
  async tick() {
    if (!this.waiting || this.busy) return;
    const g = this.generation;
    try {
      check(!this.store.stopped(), "USER_STOPPED");
      check(this.visible(), "FOREGROUND_REQUIRED");
      this.clock.deadline();
      if (!this.clock.released()) return;
      const bounds = this.clock.bounds();
      this.mark({
        firstGatePassedAt: this.iso(),
        gateClockLowerMs: bounds.lower,
        gateClockUpperMs: bounds.upper,
        gateClockPhoneOffsetMs: bounds.phoneOffsetMs,
        gateClockSampleRttMs: bounds.sampleRttMs,
      });
      if (this.mono() < this.nextOpeningCheckMono) return;
      check(this.openRangePath && this.openRangeCategory && this.openingChecks < 2, "OPEN_RANGE_UNCONFIRMED");
      this.busy = true;
      this.openingChecks++;
      this.mark({ openingCheckStartedAt: this.iso() });
      this.emit("WAITING", "OPEN_RANGE_CHECKING");
      // Read-only; never send a booking to test readiness. Preserve the existing clock sample.
      const body = await this.read(this.openRangePath, g, undefined, false);
      this.ensure(g);
      const group = category(body?.data);
      check(
        group.category_id === this.openRangeCategory.category_id &&
          group.content_id === this.openRangeCategory.content_id,
        "OPEN_RANGE_UNCONFIRMED",
      );
      const result = openingRange(body?.data?.range, this.task);
      check(!this.store.stopped() && this.visible(), "FOREGROUND_REQUIRED");
      this.clock.deadline();
      check(this.clock.released(), "NOT_RELEASED");
      if (!result.open) {
        check(this.openingChecks < 2, "OPEN_RANGE_UNCONFIRMED");
        this.nextOpeningCheckMono = this.mono() + 1000;
        this.emit("WAITING", "OPEN_RANGE_NOT_YET");
        return;
      }
      this.openProofGeneration = g;
      this.mark({ openConfirmedAt: this.iso(), confirmedMaxDateExclusive: result.maxDateExclusive });
      this.emit("WAITING", "OPEN_RANGE_CONFIRMED");
      this.busy = false;
      await this.submit();
    } catch (error) {
      if (g === this.generation) await this.stop(codeOf(error));
    } finally {
      this.busy = false;
    }
  }
  submissionHeaders(sample) {
    this.mark({
      firstResponseAt: sample.timing?.responseAt || new Date(sample.receivedWall).toISOString(),
      dispatchToHeadersMs: sample.timing?.dispatchToHeadersMs,
    });
    this.emit("SUBMITTING", "HTTP_HEADERS", { status: sample.status });
  }
  submissionBusiness(body, timing) {
    const reason = responseCode(body),
      at = timing.businessResultAt || this.iso();
    this.mark({
      firstBusinessResultAt: at,
      firstServerSuccessAt: reason === "SERVER_SUCCESS" ? at : undefined,
      responseCode: reason,
      bodyDecodeMs: timing.bodyDecodeMs,
      dispatchToHeadersMs: timing.dispatchToHeadersMs,
    });
    this.emit(["LIMITED", "AUTH_REQUIRED"].includes(reason) ? "FAILED" : "UNKNOWN", reason);
  }
  async submit() {
    check(
      this.openProofGeneration === this.generation && this.timings.openConfirmedAt,
      "OPEN_RANGE_UNCONFIRMED",
    );
    // Reuse the proven single POST path. Wrap only the optional observation
    // callback; no second HTTP/signature implementation and no write retries.
    const original = this.io;
    this.io = {
      request: (path, options = {}) =>
        original.request(
          path,
          options.write
            ? {
                ...options,
                onDispatch: (at) => {
                  check(this.openProofGeneration === this.generation, "OPEN_RANGE_UNCONFIRMED");
                  options.onDispatch?.(at);
                  this.mark({ firstDispatchAt: at });
                  this.persistDiagnostics();
                },
              }
            : options,
        ),
    };
    try {
      await super.submit();
    } finally {
      this.io = original;
    }
    // Successful receipt without a matching record must leave VERIFYING.
    if (this.state === "VERIFYING") this.emit("UNKNOWN", "RECORD_NOT_VERIFIED");
  }
  async verify(g) {
    this.verifying = true;
    let result;
    try {
      result = await super.verify(g);
    } finally {
      this.verifying = false;
    }
    if (result === false && this.reviewing) this.verifiedAbsentDuringReview = true;
    if (result) {
      this.mark({ firstRecordVerifiedAt: this.iso() });
      if (this.reviewing) this.verifiedDuringReview = true;
    }
    return result;
  }
  async review() {
    if (this.busy || this.waiting) return this.view();
    this.reviewing = true;
    this.verifiedDuringReview = false;
    this.verifiedAbsentDuringReview = false;
    const at = this.iso();
    try {
      await super.review();
      if (this.key && this.verifiedAbsentDuringReview && this.store.reconcileNotOpen) {
        this.busy = true;
        try {
          const row = await this.store.reconcileNotOpen(this.key, this.iso());
          if (row?.state === "FAILED") this.emit("FAILED", row.reason);
        } finally {
          this.busy = false;
        }
      }
    } finally {
      this.reviewing = false;
      this.timings.lastReviewedAt = at;
      if (this.key)
        await this.store.note(this.key, { lastReviewedAt: at }, this.logs).catch(() => {
          this.diagnosticStorageFailed = true;
        });
      this.notify(this.view());
    }
    return this.view();
  }
  recordUI(phase, metrics) {
    this.mark({ uiFeedback: { [phase]: metrics } });
    this.persistDiagnostics();
  }
  observePage(code) {
    this.logs.push({ at: this.iso(), category: "PAGE_OBSERVATION", state: this.state, reason: code });
    if (this.logs.length > 60) this.logs.shift();
    this.persistDiagnostics();
  }
  async diagnosticExport() {
    await this.diagWrites;
    let rows = [];
    if (this.identity) rows = await this.store.list();
    const stored = rows.find((r) => r.key === this.key);
    return {
      version: "6.1.0",
      current: publicDiagnostics(
        stored || {
          target: this.task,
          version: "6.1.0",
          state: this.state,
          reason: this.reason,
          attempts: this.attempted ? 1 : 0,
          ...this.timings,
          logs: this.logs,
        },
      ),
      recent: rows
        .sort((a, b) => b.target.date.localeCompare(a.target.date))
        .slice(0, 7)
        .map(publicDiagnostics),
      diagnosticStorageFailed: !!this.diagnosticStorageFailed,
    };
  }
  async suspend(code = "FOREGROUND_REQUIRED") {
    try {
      await this.stop(code);
    } catch (e) {
      this.emit(this.attempted ? "UNKNOWN" : "STOPPED", codeOf(e));
    }
  }
  async stop(reason = "USER_STOPPED") {
    this.generation++;
    this.waiting = false;
    this.controller?.abort();
    let row;
    try {
      if (this.formal || this.store.active()) {
        this.store.stopSignal();
        row = this.key ? await this.store.stop(this.key, reason) : await this.store.activeTask?.();
        this.attempted ||= row?.attempts === 1;
      }
    } catch {
      reason = "STORAGE_UNAVAILABLE";
    }
    if (row && ["SUCCESS", "FAILED"].includes(row.state)) {
      this.emit(row.state, row.reason);
      return;
    }
    this.emit(this.state === "SUCCESS" ? "SUCCESS" : this.attempted ? "UNKNOWN" : "STOPPED", reason);
  }
}
