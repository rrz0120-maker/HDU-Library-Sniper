import { BOOK_PATH, category, check, codeOf, md5 } from "../core.js";
import {
  mergeP71Diagnostics,
  openingScheduledRange,
  P71_RECALIBRATE_BEFORE_MS,
  publicScheduledDiagnostics,
} from "../p71/policy.js";
import { ScheduledIpadEngine } from "../p71/engine.js";
import { checkReleaseRead, releaseResponseCode } from "./release-guard.js";

export const P73_VERSION = "7.3.1";

const P73_REJECTED = new Set(["SEAT_UNAVAILABLE", "NOT_OPEN", "EXISTING"]);
const P73_PERF_FIELDS = [
  "openCheckMs",
  "gateToDispatchMs",
  "openConfirmToDispatchMs",
  "signLocalMs",
  "claimWriteMs",
  "uiUpdatesSuppressed",
  "deferredDiagWrites",
];

// Production Performance Candidate extending P7.1.1 ScheduledIpadEngine.
// Preserves ALL safety gates (double-gate open confirmation, single-write claim before fetch,
// 19:59:15 recalibration, Safari suspension guard, cross-mode exclusion, terminal protection).
// Optimizations strictly target critical-path local overhead and IndexedDB lock contention.
export class PerformanceScheduledEngine extends ScheduledIpadEngine {
  constructor(io, store, notify = () => {}, env = {}) {
    super(io, store, notify, env);
    this.hotPathActive = false;
    this.deferredDiagWrites = 0;
    this.uiUpdatesSuppressed = 0;
    this.signTemplate = null;
    this.gatePassedMono = null;
    this.openConfirmedMono = null;
    this.perfMetrics = {
      openCheckMs: null,
      gateToDispatchMs: null,
      openConfirmToDispatchMs: null,
      signLocalMs: null,
      claimWriteMs: null,
      uiUpdatesSuppressed: 0,
      deferredDiagWrites: 0,
    };
  }

  noteUiSuppressed() {
    this.uiUpdatesSuppressed++;
    this.perfMetrics.uiUpdatesSuppressed = this.uiUpdatesSuppressed;
  }

  buildSignTemplate() {
    if (!this.identity?.uid) return null;
    const { seatId, begin, duration } = this.task;
    check(
      Number.isSafeInteger(duration) && duration >= 3600 && duration <= 86400 && duration % 3600 === 0,
      "INVALID_DURATION",
    );
    return {
      prefix: `post&${BOOK_PATH}&api_time`,
      suffix: `&beginTime${begin}&duration${duration}&is_recommend0&seatBookers[0]${this.identity.uid}&seats[0]${seatId}`,
      beginStr: String(begin),
      durationStr: String(duration),
      seatId,
      uid: this.identity.uid,
    };
  }

  fastSign(apiTime) {
    const tpl = this.signTemplate || this.buildSignTemplate();
    check(
      tpl?.uid === this.identity?.uid &&
        tpl?.seatId === this.task.seatId &&
        tpl.beginStr === String(this.task.begin) &&
        tpl.durationStr === String(this.task.duration),
      "IDENTITY_CHANGED",
    );
    check(Number.isSafeInteger(apiTime) && apiTime > 0, "INVALID_TIME");
    const t0 = this.mono();
    const apiTimeStr = String(apiTime);
    const token = btoa(md5(`${tpl.prefix}${apiTimeStr}${tpl.suffix}`));
    const form = new URLSearchParams({
      beginTime: tpl.beginStr,
      duration: tpl.durationStr,
      is_recommend: "0",
      api_time: apiTimeStr,
      "seats[0]": tpl.seatId,
      "seatBookers[0]": tpl.uid,
    });
    const elapsed = this.mono() - t0;
    if (this.perfMetrics.signLocalMs == null) this.perfMetrics.signLocalMs = elapsed;
    return { token, form };
  }

  persistDiagnostics() {
    // Avoid IndexedDB readwrite lock contention with store.claim() during the 20:00 hot release path.
    if (this.hotPathActive) {
      this.deferredDiagWrites++;
      this.perfMetrics.deferredDiagWrites = this.deferredDiagWrites;
      return;
    }
    super.persistDiagnostics();
  }

  async prepare(opts = {}) {
    if (!this.formal && !this.busy && this.coordinator?.limited) {
      this.emit("STOPPED", "LIMITED");
      return this.view();
    }
    const res = await super.prepare(opts);
    if (this.waiting && this.identity?.uid) {
      this.signTemplate = this.buildSignTemplate();
    }
    return res;
  }

  async read(path, g, form, observe = true) {
    check(!this.coordinator?.limited, "LIMITED");
    try {
      const body = await super.read(path, g, form, observe);
      checkReleaseRead(path, body);
      if (path === "/User/Center/baseInfo" && this.identity) {
        check(body?.DATA?.is_login === true, "AUTH_REQUIRED");
        check(String(body.DATA.uid) === this.identity.uid, "IDENTITY_CHANGED");
      }
      return body;
    } catch (error) {
      if (codeOf(error) === "LIMITED") {
        this.staticCache.roomQueryEntry = this.staticCache.mappingEntry = null;
        if (this.coordinator) this.coordinator.limited = true;
      }
      throw error;
    }
  }

  async tick() {
    if (!this.waiting || this.busy) return;
    const g = this.generation;
    try {
      check(!this.store.stopped(), "USER_STOPPED");
      check(this.visible(), "FOREGROUND_REQUIRED");
      this.checkTimerIntegrity();

      const toOpen = this.task.open - this.wall();
      if (!this.recalibrated && toOpen <= P71_RECALIBRATE_BEFORE_MS && toOpen > 3000) {
        await this.recalibrateClock(g);
        return;
      }
      if (toOpen > 0) {
        if (this.recalibrated) this.clock.bounds();
        return;
      }

      this.clock.deadline();
      if (!this.clock.released()) return;

      const bounds = this.clock.bounds();
      if (this.gatePassedMono == null) this.gatePassedMono = this.mono();
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
      this.hotPathActive = true;
      this.setStage("OPEN_CONFIRM");
      this.openingChecks++;
      const openCheckStartMono = this.mono();
      this.mark({ openingCheckStartedAt: this.iso() });
      this.emit("WAITING", "OPEN_RANGE_CHECKING");

      // Mandatory real-time open confirmation (never bypassed in production).
      const body = await this.read(this.openRangePath, g, undefined, false);
      this.ensure(g);
      this.lastTickWall = this.wall();
      this.lastTickMono = this.mono();
      const group = category(body?.data);
      check(
        group.category_id === this.openRangeCategory.category_id &&
          group.content_id === this.openRangeCategory.content_id,
        "OPEN_RANGE_UNCONFIRMED",
      );
      const result = openingScheduledRange(body?.data?.range, this.task);
      check(!this.store.stopped() && this.visible(), "FOREGROUND_REQUIRED");
      this.clock.deadline();
      check(this.clock.released(), "NOT_RELEASED");

      if (!result.open) {
        check(this.openingChecks < 2, "OPEN_RANGE_UNCONFIRMED");
        this.nextOpeningCheckMono = this.mono() + 1000;
        this.hotPathActive = false;
        this.emit("WAITING", "OPEN_RANGE_NOT_YET");
        return;
      }

      this.openConfirmedMono = this.mono();
      if (this.perfMetrics.openCheckMs == null) {
        this.perfMetrics.openCheckMs = this.openConfirmedMono - openCheckStartMono;
      }
      this.openProofGeneration = g;
      this.mark({ openConfirmedAt: this.iso(), confirmedMaxDateExclusive: result.maxDateExclusive });
      this.emit("WAITING", "OPEN_RANGE_CONFIRMED");
      this.busy = false;
      await this.submit();
    } catch (error) {
      this.hotPathActive = false;
      const code = codeOf(error);
      const diag = this.lastHttpDiag || {};
      this.lastHttpDiag = null;
      this.mark({
        stoppedEndpoint: diag.endpoint || null,
        httpStatus: diag.httpStatus ?? null,
        normalizedBusinessCode: diag.normalizedBusinessCode || code,
      });
      if (g === this.generation) await this.stop(code);
    } finally {
      this.hotPathActive = false;
      this.busy = false;
    }
  }

  async submit() {
    this.busy = true;
    this.waiting = false;
    try {
      check(this.coordinator, "CROSS_MODE_LOCK_UNAVAILABLE");
      await this.coordinator.withCommit(() => this.submitLocked());
    } catch (error) {
      this.hotPathActive = false;
      await this.stop(codeOf(error));
    } finally {
      this.busy = false;
    }
  }

  async submitLocked() {
    this.busy = true;
    this.waiting = false;
    this.hotPathActive = true;
    this.setStage("SUBMIT");
    const g = this.generation;
    const localStart = this.mono();
    let claimed = false;
    let reason = "LOCAL_ERROR";
    let verification = null;
    let submitHttpStatus = null;

    try {
      this.ensure(g);
      check(this.openProofGeneration === g && this.timings.openConfirmedAt, "OPEN_RANGE_UNCONFIRMED");
      check(this.formal && !this.attempted && this.visible() && !this.store.stopped(), "WRITE_GATE_CLOSED");
      if (this.coordinator) {
        const conflict = await this.coordinator.checkForScheduled(this.identity.account, this.task);
        if (conflict) {
          this.mark({ crossModeConflict: conflict });
          check(false, conflict.code);
        }
      }
      this.clock.deadline();
      check(this.clock.released(), "NOT_RELEASED");

      // Mandatory strict durable write-intent claim BEFORE fetch (zero IndexedDB contention from deferred diag writes).
      const claimStart = this.mono();
      const claim = await this.store.claim(this.key, this.owner, this.iso());
      if (this.perfMetrics.claimWriteMs == null) this.perfMetrics.claimWriteMs = this.mono() - claimStart;
      check(claim.won, "BUDGET_SPENT");
      claimed = true;
      this.attempted = true;

      this.ensure(g);
      check(!this.coordinator.limited, "LIMITED");
      check(this.visible() && !this.store.stopped(), "USER_STOPPED");
      this.clock.deadline();
      check(this.clock.released(), "NOT_RELEASED");

      const request = this.fastSign(Math.floor(this.wall() / 1000));
      this.mark({ preSubmitLocalMs: this.mono() - localStart });
      this.emit("SUBMITTING", "SUBMITTING_ONCE");
      this.countRequest("POST", BOOK_PATH);

      const response = await this.io.request(BOOK_PATH, {
        ...request,
        write: true,
        signal: this.controller.signal,
        onDispatch: (at) => {
          this.ensure(g);
          check(!this.coordinator.limited, "LIMITED");
          check(this.openProofGeneration === g, "OPEN_RANGE_UNCONFIRMED");
          check(this.visible() && !this.store.stopped(), "USER_STOPPED");
          this.clock.deadline();
          check(this.clock.released(), "NOT_RELEASED");
          const nowMono = this.mono();
          if (this.gatePassedMono != null && this.perfMetrics.gateToDispatchMs == null) {
            this.perfMetrics.gateToDispatchMs = nowMono - this.gatePassedMono;
          }
          if (this.openConfirmedMono != null && this.perfMetrics.openConfirmToDispatchMs == null) {
            this.perfMetrics.openConfirmToDispatchMs = nowMono - this.openConfirmedMono;
          }
          this.mark({ firstDispatchAt: at });
        },
        onHeaders: (sample) => {
          submitHttpStatus = sample?.status ?? null;
          this.mark({
            firstResponseAt: sample.timing?.responseAt || this.iso(),
            dispatchToHeadersMs: sample.timing?.dispatchToHeadersMs,
            httpStatus: submitHttpStatus,
          });
        },
        onBusiness: (body, timing) => {
          const code = releaseResponseCode(body);
          const at = timing.businessResultAt || this.iso();
          this.mark({
            firstBusinessResultAt: at,
            firstServerSuccessAt: code === "SERVER_SUCCESS" ? at : undefined,
            responseCode: code,
            normalizedBusinessCode: code,
            bodyDecodeMs: timing.bodyDecodeMs,
          });
        },
      });
      this.mark({ totalRequestMs: response.timing?.totalRequestMs ?? null });
      reason = releaseResponseCode(response.body);
      this.mark({ responseCode: reason, normalizedBusinessCode: reason, resultStateUpdatedAt: this.iso() });
    } catch (error) {
      reason = codeOf(error);
      this.mark({
        responseCode: reason,
        normalizedBusinessCode: reason,
        stoppedEndpoint: "/Seat/Index/bookSeats",
        httpStatus: submitHttpStatus,
        resultStateUpdatedAt: this.iso(),
      });
      if (error.timing?.totalRequestMs != null) this.mark({ totalRequestMs: error.timing.totalRequestMs });
    } finally {
      // Release hot-path lock after fetch completes so diagnostics flush cleanly.
      this.hotPathActive = false;
    }

    const immediate = !claimed
      ? "STOPPED"
      : ["LIMITED", "AUTH_REQUIRED"].includes(reason)
        ? "FAILED"
        : "UNKNOWN";
    if (reason === "LIMITED") this.coordinator.limited = true;
    this.emit(reason === "SERVER_SUCCESS" ? "VERIFYING" : immediate, reason);

    if (claimed) {
      try {
        const persisted = await this.store.finish(this.key, this.owner, {
          state: immediate,
          reason,
          timings: { ...this.timings, ...this.perfMetrics },
          logs: this.logs.slice(-60),
        });
        if (persisted?.state === "SUCCESS") {
          this.setStage("DONE");
          this.emit("SUCCESS", "RECORD_VERIFIED");
          this.busy = false;
          return;
        }
        if (
          g === this.generation &&
          !["LIMITED", "AUTH_REQUIRED"].includes(reason) &&
          !this.store.stopped()
        ) {
          this.setStage("VERIFY");
          verification = await this.verify(g);
        }
        const state =
          verification === true
            ? "SUCCESS"
            : verification === false && P73_REJECTED.has(reason)
              ? "FAILED"
              : immediate;
        const finalReason = verification === true ? "RECORD_VERIFIED" : reason;
        const finalRow = await this.store.finish(this.key, this.owner, {
          state,
          reason: finalReason,
          recordVerified: verification === true,
          timings: { ...this.timings, ...this.perfMetrics },
          logs: this.logs.slice(-60),
        });
        if (finalRow?.state === "SUCCESS") {
          this.setStage("DONE");
          this.emit("SUCCESS", "RECORD_VERIFIED");
          this.busy = false;
          return;
        }
        this.setStage("DONE");
        this.emit(
          g !== this.generation && state !== "SUCCESS" ? "UNKNOWN" : state,
          g !== this.generation && state !== "SUCCESS" ? "USER_STOPPED" : finalReason,
        );
      } catch (error) {
        this.emit("UNKNOWN", codeOf(error));
      }
    }
    this.busy = false;
  }

  async diagnosticExport() {
    const base = await super.diagnosticExport();
    base.version = P73_VERSION;
    if (base.current) {
      base.current.version = P73_VERSION;
      for (const k of P73_PERF_FIELDS) {
        base.current[k] = this.perfMetrics[k] ?? base.current[k] ?? null;
      }
    }
    return base;
  }
}
