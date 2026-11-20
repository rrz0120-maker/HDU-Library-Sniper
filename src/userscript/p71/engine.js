import {
  BOOK_PATH,
  category,
  check,
  codeOf,
  inspectRange,
  records,
  responseCode,
  roomQuery,
  shanghaiDate,
} from "../core.js";
import { accountKey } from "../ledger.js";
import { safeRandomId } from "../p70/policy.js";
import {
  mergeP71Diagnostics,
  openingScheduledRange,
  P71_PREPARE_MS,
  P71_RECALIBRATE_BEFORE_MS,
  P71_RECORD_PATH,
  P71_REHEARSAL_DEDUPE_MS,
  P71_TIMER_DRIFT_MAX_MS,
  P71_VERSION,
  publicScheduledDiagnostics,
  resolveScheduled162,
  ScheduledClock,
  scheduledOverlaps,
  scheduledTask,
  scheduledTaskKey,
  signedScheduledRequest,
  validateScheduledRange,
  validateScheduledTask,
  validateStaticCacheEntry,
  verifiedScheduled162,
} from "./policy.js";

const P71_REJECTED = new Set(["SEAT_UNAVAILABLE", "NOT_OPEN", "EXISTING"]);

export class ScheduledIpadEngine {
  constructor(io, store, notify = () => {}, env = {}) {
    this.io = io;
    this.store = store;
    this.notify = notify;
    this.wall = env.wall || (() => Date.now());
    this.mono = env.mono || (() => performance.now());
    this.visible = env.visible || (() => (typeof document === "undefined" ? true : document.visibilityState === "visible"));
    this.staticCache = env.staticCache || { roomQueryEntry: null, mappingEntry: null };
    this.coordinator = env.coordinator || null;
    this.task = env.task || scheduledTask(this.wall(), env.startHour ?? 8, env.endHour ?? 22);
    validateScheduledTask(this.task);
    this.clock = new ScheduledClock(this.wall, this.mono, this.task);
    this.owner = safeRandomId();
    this.state = "IDLE";
    this.reason = "READ_ONLY_DEFAULT";
    this.generation = 0;
    this.busy = false;
    this.formal = false;
    this.waiting = false;
    this.attempted = false;
    this.reviewing = false;
    this.identity = null;
    this.key = null;
    this.mapping = null;
    this.range = null;
    this.controller = null;
    this.openRangePath = null;
    this.openRangeCategory = null;
    this.openProofGeneration = null;
    this.openingChecks = 0;
    this.nextOpeningCheckMono = 0;
    this.recalibrated = false;
    this.lastTickWall = null;
    this.lastTickMono = null;
    this.lastHttpDiag = null;
    this.lastRehearsalAt = null;
    this.lastRehearsalSignature = null;
    this.duplicateActionBlocked = 0;
    this.requestCountByEndpoint = {};
    this.preparationStage = "IDLE";
    this.logs = [];
    this.timings = {
      scheduledAt: new Date(this.task.open).toISOString(),
      preparationStage: "IDLE",
      stoppedEndpoint: null,
      httpStatus: null,
      normalizedBusinessCode: null,
      requestCountByEndpoint: {},
      cacheHit: { roomQueryHit: false, seatMappingHit: false, valid: false, reason: "NOT_CHECKED", ageMs: null },
      duplicateActionBlocked: 0,
      crossModeConflict: null,
    };
    this.diagWrites = Promise.resolve();
  }

  iso() {
    return new Date(this.wall()).toISOString();
  }

  setStage(stage) {
    this.preparationStage = stage;
    this.mark({ preparationStage: stage });
  }

  countRequest(method, path) {
    const endpoint = String(path).split("?")[0];
    const key = `${method} ${endpoint}`;
    this.requestCountByEndpoint[key] = (this.requestCountByEndpoint[key] || 0) + 1;
    this.mark({ requestCountByEndpoint: { ...this.requestCountByEndpoint } });
  }

  mark(values) {
    this.timings = mergeP71Diagnostics(this.timings, values);
  }

  persistDiagnostics() {
    if (!this.key) return;
    const key = this.key;
    const values = structuredClone(this.timings);
    const logs = this.logs.slice(-60);
    this.diagWrites = this.diagWrites
      .then(() => this.store.note(key, values, logs))
      .catch(() => {});
  }

  emit(state, code, details = {}) {
    if (state === "WAITING" && !this.waiting) {
      state = "IDLE";
      code = "WAITING_VIEW_ONLY";
    }
    if (
      ["MISSED_WINDOW", "PREPARE_WINDOW", "AUTHORIZATION_EXPIRED", "PREPARE_TOO_LATE_OR_STOPPED"].includes(code) &&
      !this.attempted
    ) {
      state = "EXPIRED";
    }
    if (code === "FORMAL_PREFLIGHT" || code === "READ_ONLY_REHEARSAL") this.mark({ prepareStartedAt: this.iso() });
    if (code === "ARMED_FOR_2000") this.mark({ armedAt: this.iso() });
    if (this.state === state && this.reason === code && !["LOGIN_OK", "RANGE_OK"].includes(code)) return;
    this.state = state;
    this.reason = code;
    this.logs.push({ at: this.iso(), state, code, stage: this.preparationStage, ...details });
    if (this.logs.length > 60) this.logs.shift();
    this.notify(this.view());
    this.persistDiagnostics();
  }

  view() {
    return {
      state: this.state,
      reason: this.reason,
      formal: this.formal,
      waiting: this.waiting,
      attempted: this.attempted,
      task: this.task,
      login: !!this.identity,
      mapping: this.mapping,
      timings: this.timings,
      logs: this.logs.slice(),
    };
  }

  ensure(g) {
    check(g === this.generation, "USER_STOPPED");
    if (this.formal && !this.reviewing) {
      check(shanghaiDate(this.wall()) === this.task.day, "AUTHORIZATION_EXPIRED");
    }
  }

  async read(path, g, form, observe = true) {
    this.ensure(g);
    let httpStatus = null;
    const endpoint = String(path).split("?")[0];
    this.countRequest(form ? "POST" : "GET", path);
    try {
      const response = await this.io.request(path, {
        form,
        signal: this.controller.signal,
        onHeaders: (sample) => {
          httpStatus = sample?.status ?? null;
          if (observe) this.clock.observe(sample);
        },
      });
      this.ensure(g);
      const code = responseCode(response.body);
      if (["LIMITED", "HTTP_404", "AUTH_REQUIRED"].includes(code)) {
        this.lastHttpDiag = { httpStatus, endpoint, normalizedBusinessCode: code };
        check(false, code);
      }
      return response.body;
    } catch (error) {
      const code = codeOf(error);
      this.lastHttpDiag = { httpStatus, endpoint, normalizedBusinessCode: code };
      throw error;
    }
  }

  async login(g, observe = true) {
    const start = this.mono();
    const body = await this.read("/User/Center/baseInfo", g, undefined, observe);
    const uid = body?.DATA?.uid;
    check(body?.DATA?.is_login === true && /^\d+$/.test(String(uid ?? "")), "AUTH_REQUIRED");
    const account = await accountKey(String(uid));
    this.ensure(g);
    if (this.identity) check(this.identity.account === account, "IDENTITY_CHANGED");
    this.identity = { uid: String(uid), account };
    this.store.bind(account);
    this.key = scheduledTaskKey(account, this.task);
    this.mark({ loginCheckMs: this.mono() - start });
    this.emit(this.state, "LOGIN_OK");
  }

  async prepare({ arm = false, confirmed = false, authorizedDay } = {}) {
    // Guard duplicate clicks / already-active formal tasks with zero network requests.
    if (this.busy || this.formal || this.waiting) {
      this.duplicateActionBlocked++;
      this.mark({ duplicateActionBlocked: this.duplicateActionBlocked });
      return this.view();
    }
    const rehearsalSig = `${this.task.day}:${this.task.date}:${this.task.startHour}-${this.task.endHour}`;
    if (
      !arm &&
      this.state === "READY_READ_ONLY" &&
      this.lastRehearsalSignature === rehearsalSig &&
      this.lastRehearsalAt != null &&
      this.wall() - this.lastRehearsalAt < P71_REHEARSAL_DEDUPE_MS
    ) {
      this.duplicateActionBlocked++;
      this.mark({ duplicateActionBlocked: this.duplicateActionBlocked });
      return this.view();
    }

    if (arm && (!confirmed || authorizedDay !== this.task.day || shanghaiDate(this.wall()) !== this.task.day)) {
      this.emit("STOPPED", "TODAY_AUTHORIZATION_REQUIRED");
      return this.view();
    }
    if (arm && this.wall() < this.task.open - P71_PREPARE_MS) {
      this.emit("IDLE", "PREPARE_TOO_EARLY");
      return this.view();
    }
    if (arm && this.wall() >= this.task.open) {
      this.emit("EXPIRED", "PREPARE_WINDOW");
      return this.view();
    }

    this.busy = true;
    this.formal = arm;
    this.controller = new AbortController();
    const g = this.generation;
    this.openRangePath = null;
    this.openRangeCategory = null;
    this.openProofGeneration = null;
    this.openingChecks = 0;
    this.nextOpeningCheckMono = 0;
    this.recalibrated = false;
    this.lastTickWall = null;
    this.lastTickMono = null;
    this.lastHttpDiag = null;
    this.timings = {
      scheduledAt: new Date(this.task.open).toISOString(),
      preparationStage: "PREFLIGHT_START",
      stoppedEndpoint: null,
      httpStatus: null,
      normalizedBusinessCode: null,
      requestCountByEndpoint: { ...this.requestCountByEndpoint },
      cacheHit: { roomQueryHit: false, seatMappingHit: false, valid: false, reason: "NOT_CHECKED", ageMs: null },
      duplicateActionBlocked: this.duplicateActionBlocked,
      crossModeConflict: null,
    };
    if (arm) this.store.activateDay?.();
    this.setStage("PREFLIGHT_START");
    this.emit("PREPARING", arm ? "FORMAL_PREFLIGHT" : "READ_ONLY_REHEARSAL");

    try {
      validateScheduledTask(this.task);
      check(this.visible(), "FOREGROUND_REQUIRED");
      if (arm) check(!this.store.stopped(), "USER_STOPPED");

      this.setStage("STORAGE_PROBE");
      await this.store.probe();
      this.ensure(g);

      this.setStage("LOGIN");
      await this.login(g, true);

      this.setStage("CROSS_MODE_CHECK");
      if (this.coordinator) {
        const conflict = await this.coordinator.checkForScheduled(this.identity.account);
        if (conflict) {
          this.mark({ crossModeConflict: conflict });
          check(false, conflict.code);
        }
      }
      const pending = await this.store.pendingUnknown(this.identity.account, this.key);
      check(!pending, "PREVIOUS_UNKNOWN");
      const old = await this.store.get(this.key);
      this.ensure(g);
      if (old || this.store.spent(this.key)) {
        this.timings = mergeP71Diagnostics(old?.timings || {}, this.timings);
        this.mapping = old?.mapping || this.mapping;
        this.attempted ||= old?.attempts === 1;
        this.emit(old?.state || "UNKNOWN", "TASK_ALREADY_RESERVED");
        return this.view();
      }

      const start = this.mono();
      const cacheCtx = {
        account: this.identity.account,
        day: this.task.day,
        date: this.task.date,
        now: this.wall(),
      };
      const rqCheck = validateStaticCacheEntry(this.staticCache.roomQueryEntry, cacheCtx);
      let query;
      if (rqCheck.valid) {
        query = this.staticCache.roomQueryEntry.roomQuery;
      } else {
        this.setStage("CATEGORY_LIST");
        query = roomQuery(await this.read("/Space/Category/list?LAB_JSON=1", g, undefined, true));
        this.staticCache.roomQueryEntry = {
          account: this.identity.account,
          day: this.task.day,
          date: this.task.date,
          roomQuery: query,
          verifiedAt: this.wall(),
        };
      }

      // Always read live room range and category (never cached).
      this.setStage("RANGE_READ");
      const body = await this.read(query, g, undefined, true);
      const rawRange = body?.data?.range;
      this.range = validateScheduledRange(rawRange, this.wall(), this.task);
      const group = category(body?.data);
      this.openRangePath = query;
      this.openRangeCategory = group;
      this.emit("PREPARING", "RANGE_OK", {
        fields: inspectRange(rawRange),
        dates: this.range.dates,
        mapDate: this.range.mapDate,
      });

      // Reuse static physical 162->62726 mapping ONLY when verified in-session, same account/day/target/category, and within TTL.
      const mapCheck = validateStaticCacheEntry(this.staticCache.mappingEntry, { ...cacheCtx, group });
      this.mark({
        cacheHit: {
          roomQueryHit: rqCheck.valid,
          seatMappingHit: mapCheck.valid,
          valid: mapCheck.valid,
          reason: mapCheck.reason,
          ageMs: mapCheck.ageMs,
        },
      });
      if (mapCheck.valid) {
        this.mapping = { ...this.staticCache.mappingEntry.mapping };
        this.mark({ catalogReadMs: this.mono() - start, idResolutionMs: 0 });
      } else {
        this.setStage("SEAT_MAPPING");
        const mapBody = await this.read(
          "/Seat/Index/searchSeats?LAB_JSON=1",
          g,
          new URLSearchParams({
            beginTime: String(this.range.mapBegin),
            duration: "3600",
            num: "1",
            "space_category[category_id]": group.category_id,
            "space_category[content_id]": group.content_id,
          }),
          true,
        );
        this.mark({ catalogReadMs: this.mono() - start });
        const parseStart = this.mono();
        this.mapping = resolveScheduled162(mapBody);
        this.mark({ idResolutionMs: this.mono() - parseStart });
        this.staticCache.mappingEntry = {
          account: this.identity.account,
          day: this.task.day,
          date: this.task.date,
          categoryId: group.category_id,
          contentId: group.content_id,
          mapping: { ...this.mapping },
          verifiedAt: this.wall(),
        };
      }

      // Always read live official records for conflict checking (never cached).
      this.setStage("CONFLICT_CHECK");
      const conflictStart = this.mono();
      const booked = records(await this.read(P71_RECORD_PATH, g, undefined, true));
      check(scheduledOverlaps(booked, this.task).length === 0, "EXISTING");
      this.mark({ conflictReadMs: this.mono() - conflictStart });

      this.setStage("SIGN_DRY_RUN");
      this.clock.bounds();
      const dryRun = signedScheduledRequest(
        this.task.seatId,
        this.identity.uid,
        this.task.begin,
        Math.floor(this.wall() / 1000),
        this.task.duration,
      );
      check(dryRun.form.get("duration") === String(this.task.duration), "INVALID_DURATION");
      this.ensure(g);
      check(this.visible(), "FOREGROUND_REQUIRED");

      if (!arm) {
        this.lastRehearsalAt = this.wall();
        this.lastRehearsalSignature = rehearsalSig;
        this.setStage("READY_READ_ONLY");
        this.emit("READY_READ_ONLY", "REHEARSAL_PASSED");
        return this.view();
      }

      this.setStage("RESERVE");
      check(this.wall() < this.task.open && !this.store.stopped(), "PREPARE_TOO_LATE_OR_STOPPED");
      const reserved = await this.store.reserve({
        key: this.key,
        owner: this.owner,
        state: "WAITING",
        reason: "EXPLICIT_USER_ARM",
        attempts: 0,
        recordVerified: false,
        mapping: this.mapping,
        timings: this.timings,
        logs: this.logs.slice(-60),
        target: { ...this.task },
        createdAt: this.iso(),
        verifications: 0,
      });
      this.ensure(g);
      check(reserved.won, "TASK_ALREADY_RESERVED");
      this.waiting = true;
      this.lastTickWall = this.wall();
      this.lastTickMono = this.mono();
      this.setStage("ARMED");
      this.emit("WAITING", "ARMED_FOR_2000");
    } catch (error) {
      const reason = codeOf(error);
      const diag = this.lastHttpDiag || {};
      this.lastHttpDiag = null;
      this.mark({
        stoppedEndpoint: diag.endpoint || null,
        httpStatus: diag.httpStatus ?? null,
        normalizedBusinessCode: diag.normalizedBusinessCode || reason,
      });
      this.emit(this.attempted ? "UNKNOWN" : "STOPPED", reason, diag);
      if (arm && this.key) {
        await this.store.finish(this.key, this.owner, { state: "STOPPED", reason, timings: this.timings }).catch(() => {});
      }
    } finally {
      this.busy = false;
    }
    return this.view();
  }

  checkTimerIntegrity() {
    const nowWall = this.wall();
    const nowMono = this.mono();
    if (this.lastTickWall != null && this.lastTickMono != null) {
      const dWall = nowWall - this.lastTickWall;
      const dMono = nowMono - this.lastTickMono;
      const drift = Math.abs(dWall - dMono);
      if (drift > 0) this.mark({ maxTimerDriftMs: drift });
      if (dWall > P71_TIMER_DRIFT_MAX_MS || dMono > P71_TIMER_DRIFT_MAX_MS || drift > 500) {
        this.mark({ pageSuspendedAt: this.iso() });
        check(false, "SAFARI_TIMER_SUSPENDED");
      }
    }
    this.lastTickWall = nowWall;
    this.lastTickMono = nowMono;
  }

  async recalibrateClock(g) {
    this.busy = true;
    this.setStage("RECALIBRATE");
    try {
      this.emit("WAITING", "RECALIBRATING_CLOCK");
      await this.read("/User/Center/baseInfo", g, undefined, true);
      const b = this.clock.bounds();
      this.recalibrated = true;
      this.mark({
        recalibratedAt: this.iso(),
        recalibratedOffsetMs: b.phoneOffsetMs,
        recalibratedRttMs: b.sampleRttMs,
      });
      this.lastTickWall = this.wall();
      this.lastTickMono = this.mono();
      this.emit("WAITING", "RECALIBRATED_OK");
    } finally {
      this.busy = false;
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
      this.setStage("OPEN_CONFIRM");
      this.openingChecks++;
      this.mark({ openingCheckStartedAt: this.iso() });
      this.emit("WAITING", "OPEN_RANGE_CHECKING");

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
        this.emit("WAITING", "OPEN_RANGE_NOT_YET");
        return;
      }

      this.openProofGeneration = g;
      this.mark({ openConfirmedAt: this.iso(), confirmedMaxDateExclusive: result.maxDateExclusive });
      this.emit("WAITING", "OPEN_RANGE_CONFIRMED");
      this.busy = false;
      await this.submit();
    } catch (error) {
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
      this.busy = false;
    }
  }

  async submit() {
    this.busy = true;
    this.waiting = false;
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
        const conflict = await this.coordinator.checkForScheduled(this.identity.account);
        if (conflict) {
          this.mark({ crossModeConflict: conflict });
          check(false, conflict.code);
        }
      }
      this.clock.deadline();
      check(this.clock.released(), "NOT_RELEASED");

      const claim = await this.store.claim(this.key, this.owner, this.iso());
      check(claim.won, "BUDGET_SPENT");
      claimed = true;
      this.attempted = true;

      this.ensure(g);
      check(this.visible() && !this.store.stopped(), "USER_STOPPED");
      this.clock.deadline();
      check(this.clock.released(), "NOT_RELEASED");

      const request = signedScheduledRequest(
        this.task.seatId,
        this.identity.uid,
        this.task.begin,
        Math.floor(this.wall() / 1000),
        this.task.duration,
      );
      this.mark({ preSubmitLocalMs: this.mono() - localStart });
      this.emit("SUBMITTING", "SUBMITTING_ONCE");
      this.countRequest("POST", BOOK_PATH);

      const response = await this.io.request(BOOK_PATH, {
        ...request,
        write: true,
        signal: this.controller.signal,
        onDispatch: (at) => {
          this.ensure(g);
          check(this.openProofGeneration === g, "OPEN_RANGE_UNCONFIRMED");
          check(this.visible() && !this.store.stopped(), "USER_STOPPED");
          this.clock.deadline();
          check(this.clock.released(), "NOT_RELEASED");
          this.mark({ firstDispatchAt: at });
          this.persistDiagnostics();
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
          const code = responseCode(body);
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
      reason = responseCode(response.body);
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
    }

    const immediate = !claimed
      ? "STOPPED"
      : ["LIMITED", "AUTH_REQUIRED"].includes(reason)
        ? "FAILED"
        : "UNKNOWN";
    this.emit(reason === "SERVER_SUCCESS" ? "VERIFYING" : immediate, reason);

    if (claimed) {
      try {
        const persisted = await this.store.finish(this.key, this.owner, {
          state: immediate,
          reason,
          timings: this.timings,
          logs: this.logs.slice(-60),
        });
        if (persisted?.state === "SUCCESS") {
          this.setStage("DONE");
          this.emit("SUCCESS", "RECORD_VERIFIED");
          this.busy = false;
          return;
        }
        if (g === this.generation && !["LIMITED", "AUTH_REQUIRED"].includes(reason) && !this.store.stopped()) {
          this.setStage("VERIFY");
          verification = await this.verify(g);
        }
        const state =
          verification === true
            ? "SUCCESS"
            : verification === false && P71_REJECTED.has(reason)
              ? "FAILED"
              : immediate;
        const finalReason = verification === true ? "RECORD_VERIFIED" : reason;
        const finalRow = await this.store.finish(this.key, this.owner, {
          state,
          reason: finalReason,
          recordVerified: verification === true,
          timings: this.timings,
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

  async verify(g) {
    if (!(await this.store.takeVerification(this.key, this.wall()))) return null;
    const start = this.mono();
    try {
      const items = records(await this.read(P71_RECORD_PATH, g, undefined, false));
      const ok = verifiedScheduled162(items, this.mapping, this.task);
      if (ok) this.mark({ firstRecordVerifiedAt: this.iso() });
      return ok;
    } catch (error) {
      this.emit("UNKNOWN", codeOf(error));
      return null;
    } finally {
      this.mark({ verificationMs: this.mono() - start });
    }
  }

  async review() {
    if (this.busy || this.waiting) {
      this.duplicateActionBlocked++;
      this.mark({ duplicateActionBlocked: this.duplicateActionBlocked });
      return this.view();
    }
    this.busy = true;
    this.reviewing = true;
    this.controller = new AbortController();
    const g = this.generation;
    const at = this.iso();
    try {
      await this.login(g, false);
      const row = await this.store.get(this.key);
      this.ensure(g);
      if (!row) {
        this.emit("IDLE", "NO_FORMAL_TASK");
        return this.view();
      }
      this.mapping = row.mapping;
      this.timings = mergeP71Diagnostics(row.timings || {}, row);
      this.attempted ||= row.attempts === 1;
      if (row.logs) this.logs = row.logs.slice(-60);
      if (row.state === "SUCCESS") {
        this.emit("SUCCESS", "REVIEW_SAVED_RESULT");
        return this.view();
      }
      if (row.attempts !== 1) {
        this.emit(row.state, row.reason);
        return this.view();
      }
      const ok = await this.verify(g);
      if (ok === true) {
        await this.store.finish(this.key, row.owner, {
          state: "SUCCESS",
          reason: "RECORD_VERIFIED",
          recordVerified: true,
          timings: this.timings,
          logs: this.logs.slice(-60),
        });
        this.emit("SUCCESS", "RECORD_VERIFIED");
      } else {
        this.emit(
          row.state === "FAILED" ? "FAILED" : "UNKNOWN",
          ok === null ? "READ_CHECK_LIMIT_OR_ERROR" : "RECORD_NOT_VERIFIED",
        );
      }
    } catch (error) {
      this.emit("UNKNOWN", codeOf(error));
    } finally {
      this.reviewing = false;
      this.busy = false;
      this.timings.lastReviewedAt = at;
      if (this.key) await this.store.note(this.key, { lastReviewedAt: at }, this.logs).catch(() => {});
      this.notify(this.view());
    }
    return this.view();
  }

  async suspend(code = "FOREGROUND_REQUIRED") {
    this.mark({ pageSuspendedAt: this.iso() });
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
    let row = null;
    try {
      if (this.formal || this.store.active()) {
        this.store.stopSignal();
        row = this.key ? await this.store.stop(this.key, reason) : null;
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

  async diagnosticExport() {
    await this.diagWrites;
    let rows = [];
    if (this.identity) rows = await this.store.list(this.identity.account);
    const stored = rows.find((r) => r.key === this.key);
    return {
      version: P71_VERSION,
      platform: "ipad-safari-userscripts",
      mode: "scheduled-162",
      current: publicScheduledDiagnostics(
        stored
          ? {
              ...stored,
              duplicateActionBlocked: Math.max(
                stored.duplicateActionBlocked || 0,
                this.duplicateActionBlocked,
              ),
              requestCountByEndpoint: Object.keys(this.requestCountByEndpoint).length
                ? { ...this.requestCountByEndpoint }
                : stored.requestCountByEndpoint || {},
              crossModeConflict: this.timings.crossModeConflict || stored.crossModeConflict || null,
            }
          : {
              target: this.task,
              version: P71_VERSION,
              state: this.state,
              reason: this.reason,
              attempts: this.attempted ? 1 : 0,
              ...this.timings,
              logs: this.logs,
            },
      ),
      recent: rows
        .sort((a, b) => (b.target?.date || "").localeCompare(a.target?.date || ""))
        .slice(0, 7)
        .map(publicScheduledDiagnostics),
    };
  }
}
