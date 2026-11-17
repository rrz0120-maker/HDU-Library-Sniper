import {
  BOOK_PATH,
  category,
  check,
  codeOf,
  inspectRange,
  records,
  responseCode,
  roomQuery,
  signedRequest,
} from "../core.js";
import { accountKey } from "../ledger.js";
import {
  TASK,
  PREPARE_MS,
  RECORD_PATH,
  ReleaseClock,
  checkLegacy,
  checkSchedule,
  overlaps,
  resolve162,
  targetRange,
  taskKey,
  verified162,
} from "./policy.js";

const REJECTED = new Set(["SEAT_UNAVAILABLE", "NOT_OPEN", "EXISTING"]);
export class SingleEngine {
  constructor(io, store, notify = () => {}, env = {}) {
    this.task = env.task || TASK;
    this.io = io;
    this.store = store;
    this.notify = notify;
    this.wall = env.wall || (() => Date.now());
    this.mono = env.mono || (() => performance.now());
    this.visible = env.visible || (() => document.visibilityState === "visible");
    this.clock = new ReleaseClock(this.wall, this.mono, this.task);
    this.owner = crypto.randomUUID();
    this.state = "IDLE";
    this.reason = "READ_ONLY_DEFAULT";
    this.generation = 0;
    this.busy = false;
    this.formal = false;
    this.attempted = false;
    this.logs = [];
    this.timings = {};
  }
  emit(state, reason, details = {}) {
    this.state = state;
    this.reason = reason;
    this.logs.push({ at: new Date(this.wall()).toISOString(), state, reason, ...details });
    if (this.logs.length > 40) this.logs.shift();
    this.notify(this.view());
  }
  view() {
    return {
      state: this.state,
      reason: this.reason,
      formal: this.formal,
      login: !!this.identity,
      mapping: this.mapping || null,
      range: this.range || null,
      timings: this.timings,
      logs: this.logs.slice(),
    };
  }
  ensure(g) {
    check(g === this.generation, "USER_STOPPED");
  }
  async read(path, g, form, observe = true) {
    this.ensure(g);
    const response = await this.io.request(path, {
      form,
      signal: this.controller.signal,
      onHeaders: observe ? (sample) => this.clock.observe(sample) : undefined,
    });
    this.ensure(g);
    const code = responseCode(response.body);
    check(!["LIMITED", "AUTH_REQUIRED", "HTTP_404"].includes(code), code);
    return response.body;
  }
  async login(g, observe = true) {
    const start = this.mono(),
      body = await this.read("/User/Center/baseInfo", g, undefined, observe);
    const uid = body?.DATA?.uid;
    check(body?.DATA?.is_login === true && /^\d+$/.test(String(uid ?? "")), "AUTH_REQUIRED");
    const account = await accountKey(String(uid));
    this.ensure(g);
    if (this.identity) check(this.identity.account === account, "IDENTITY_CHANGED");
    this.identity = { uid: String(uid), account };
    this.key = taskKey(account, this.task);
    this.timings.loginCheckMs = this.mono() - start;
    this.emit(this.state, "LOGIN_OK");
  }
  async prepare({ arm = false, confirmed = false } = {}) {
    if (this.busy || this.formal) return this.view();
    this.busy = true;
    this.formal = arm;
    const g = this.generation;
    this.controller = new AbortController();
    this.emit("PREPARING", arm ? "FORMAL_PREFLIGHT" : "READ_ONLY_REHEARSAL");
    try {
      checkSchedule(this.task);
      check(this.visible(), "FOREGROUND_REQUIRED");
      if (arm) {
        check(confirmed, "CONFIRMATION_REQUIRED");
        check(this.wall() >= this.task.open - PREPARE_MS && this.wall() < this.task.open, "PREPARE_WINDOW");
        check(!this.store.stopped(), "USER_STOPPED");
      }
      await this.store.probe();
      this.ensure(g);
      await this.login(g);
      const history = await this.store.legacy(this.identity.account);
      this.ensure(g);
      checkLegacy(history);
      const old = await this.store.get(this.key);
      this.ensure(g);
      if (old || this.store.spent(this.key)) {
        this.timings = old?.timings || this.timings;
        if (old?.logs) this.logs = old.logs.slice(-40);
        this.mapping = old?.mapping || this.mapping;
        this.attempted ||= old?.attempts === 1;
        this.emit(old?.state || "UNKNOWN", "TASK_ALREADY_RESERVED");
        return this.view(); // Never resumes a durable task on reload or a second tab.
      }
      const start = this.mono();
      const query = roomQuery(await this.read("/Space/Category/list?LAB_JSON=1", g));
      const body = await this.read(query, g),
        raw = body?.data?.range;
      this.range = targetRange(raw, this.wall(), this.task);
      const group = category(body?.data);
      this.emit("PREPARING", "RANGE_OK", {
        fields: inspectRange(raw),
        dates: this.range.dates,
        mapDate: this.range.mapDate,
      });
      const map = await this.read(
        "/Seat/Index/searchSeats?LAB_JSON=1",
        g,
        new URLSearchParams({
          beginTime: String(this.range.mapBegin),
          duration: "3600",
          num: "1",
          "space_category[category_id]": group.category_id,
          "space_category[content_id]": group.content_id,
        }),
      );
      this.timings.catalogReadMs = this.mono() - start;
      const parsed = this.mono();
      this.mapping = resolve162(map);
      this.timings.idResolutionMs = this.mono() - parsed;
      const readAt = this.mono();
      check(overlaps(records(await this.read(RECORD_PATH, g)), this.task).length === 0, "EXISTING");
      this.timings.conflictReadMs = this.mono() - readAt;
      this.clock.bounds();
      // Exercise the same generic signing implementation before arming; no write.
      const sample = signedRequest(
        this.task.seatId,
        this.identity.uid,
        this.task.begin,
        Math.floor(this.wall() / 1000),
        this.task.duration,
      );
      check(sample.form.get("duration") === "50400", "INVALID_DURATION");
      this.ensure(g);
      check(this.visible(), "FOREGROUND_REQUIRED");
      this.preparedAt = this.mono();
      if (!arm) {
        this.emit("READY_READ_ONLY", "REHEARSAL_PASSED");
        return this.view();
      }
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
        logs: this.logs.slice(),
        target: { ...this.task },
        createdAt: new Date(this.wall()).toISOString(),
        verifications: 0,
      });
      this.ensure(g);
      check(reserved.won, "TASK_ALREADY_RESERVED");
      this.waiting = true;
      this.emit("WAITING", "ARMED_FOR_2000", { clock: this.clock.bounds() });
    } catch (error) {
      const reason = codeOf(error);
      this.emit(this.attempted ? "UNKNOWN" : "STOPPED", reason);
      if (arm && this.key)
        await this.store.finish(this.key, this.owner, { state: "STOPPED", reason }).catch(() => {});
    } finally {
      this.busy = false;
    }
    return this.view();
  }
  async tick() {
    if (!this.waiting || this.busy) return;
    try {
      check(!this.store.stopped(), "USER_STOPPED");
      check(this.visible(), "FOREGROUND_REQUIRED");
      this.clock.deadline();
      if (!this.clock.released()) return;
      await this.submit();
    } catch (error) {
      await this.stop(codeOf(error));
    }
  }
  async submit() {
    this.busy = true;
    this.waiting = false;
    const g = this.generation,
      localStart = this.mono();
    let claimed = false,
      reason = "LOCAL_ERROR",
      verification = null;
    try {
      this.ensure(g);
      check(this.formal && !this.attempted && this.visible() && !this.store.stopped(), "WRITE_GATE_CLOSED");
      check(this.mono() - this.preparedAt <= PREPARE_MS, "PREPARATION_STALE");
      this.clock.deadline();
      check(this.clock.released(), "NOT_RELEASED");
      const claim = await this.store.claim(this.key, this.owner, new Date(this.wall()).toISOString());
      check(claim.won, "BUDGET_SPENT");
      claimed = true;
      this.attempted = true;
      this.ensure(g);
      check(this.visible() && !this.store.stopped(), "USER_STOPPED");
      this.clock.deadline();
      check(this.clock.released(), "NOT_RELEASED");
      // Nothing asynchronous between the final local checks, fresh signature,
      // and fetch. No catalog/login/record reads on the release critical path.
      const request = signedRequest(
        this.task.seatId,
        this.identity.uid,
        this.task.begin,
        Math.floor(this.wall() / 1000),
        this.task.duration,
      );
      this.timings.preSubmitLocalMs = this.mono() - localStart;
      this.emit("UNKNOWN", "SUBMITTING_ONCE");
      const response = await this.io.request(BOOK_PATH, {
        ...request,
        write: true,
        onHeaders: (sample) => this.submissionHeaders?.(sample),
        onBusiness: (body, timing) => this.submissionBusiness?.(body, timing),
        signal: this.controller.signal,
        onDispatch: (at) => {
          this.ensure(g);
          check(this.visible() && !this.store.stopped(), "USER_STOPPED");
          this.clock.deadline();
          check(this.clock.released(), "NOT_RELEASED");
          this.timings.dispatchAt = at;
          this.notify(this.view());
        },
      });
      this.timings.http = response.timing;
      reason = responseCode(response.body);
    } catch (error) {
      reason = codeOf(error);
      if (error.timing) this.timings.http = error.timing;
    }
    // Display the first response immediately. At most ONE automatic record read,
    // never a polling/retry queue. LIMITED/AUTH/STOP cause no follow-up traffic.
    const immediate = !claimed
      ? "STOPPED"
      : ["LIMITED", "AUTH_REQUIRED"].includes(reason)
        ? "FAILED"
        : "UNKNOWN";
    this.emit(immediate, reason);
    if (claimed) {
      try {
        const persisted = await this.store.finish(this.key, this.owner, {
          state: immediate,
          reason,
          timings: this.timings,
          logs: this.logs.slice(),
        });
        // Another tab may already have verified the official record while this
        // request was pending. A late response must not downgrade that success.
        if (persisted?.state === "SUCCESS") {
          this.emit("SUCCESS", "RECORD_VERIFIED");
          this.busy = false;
          return;
        }
        if (
          g === this.generation &&
          !["LIMITED", "AUTH_REQUIRED"].includes(reason) &&
          !this.store.stopped()
        ) {
          verification = await this.verify(g);
        }
        const state =
          verification === true
            ? "SUCCESS"
            : verification === false && REJECTED.has(reason)
              ? "FAILED"
              : immediate;
        const finalReason = verification === true ? "RECORD_VERIFIED" : reason;
        const finalRow = await this.store.finish(this.key, this.owner, {
          state,
          reason: finalReason,
          recordVerified: verification === true,
          timings: this.timings,
          logs: this.logs.slice(),
        });
        if (finalRow?.state === "SUCCESS") {
          this.emit("SUCCESS", "RECORD_VERIFIED");
          this.busy = false;
          return;
        }
        // A stop after send cannot prove failure, even if it interrupted a read.
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
      const items = records(await this.read(RECORD_PATH, g, undefined, false));
      return verified162(items, this.mapping, this.task);
    } catch (error) {
      this.emit("UNKNOWN", codeOf(error));
      return null;
    } finally {
      this.timings.verificationMs = this.mono() - start;
    }
  }
  async review() {
    if (this.busy || this.waiting) return this.view();
    this.busy = true;
    this.controller = new AbortController();
    const g = this.generation;
    try {
      await this.login(g, false);
      const row = await this.store.get(this.key);
      this.ensure(g);
      if (!row) {
        this.emit("IDLE", "NO_FORMAL_TASK");
        return this.view();
      }
      this.mapping = row.mapping;
      this.timings = row.timings || {};
      this.attempted ||= row.attempts === 1;
      if (row.logs) this.logs = row.logs.slice(-40);
      this.emit(row.state, row.reason);
      if (row.state === "SUCCESS" || row.attempts !== 1) return this.view();
      const success = await this.verify(g);
      if (success === true) {
        await this.store.finish(this.key, row.owner, {
          state: "SUCCESS",
          reason: "RECORD_VERIFIED",
          recordVerified: true,
          timings: this.timings,
        });
        this.emit("SUCCESS", "RECORD_VERIFIED");
      } else
        this.emit(
          row.state === "FAILED" ? "FAILED" : "UNKNOWN",
          success === null ? "READ_CHECK_LIMIT_OR_ERROR" : "RECORD_NOT_VERIFIED",
        );
    } catch (error) {
      this.emit("UNKNOWN", codeOf(error));
    } finally {
      this.busy = false;
    }
    return this.view();
  }
  async stop(reason = "USER_STOPPED") {
    this.generation++;
    this.waiting = false;
    this.controller?.abort();
    try {
      const formal = this.formal || this.store.active();
      if (formal) this.store.stopSignal(); // Synchronous cross-tab tombstone first.
      if (formal && this.key) {
        const row = await this.store.stop(this.key);
        this.attempted ||= !!row?.attempts;
      }
    } catch {
      reason = "STORAGE_UNAVAILABLE";
    }
    this.emit(this.state === "SUCCESS" ? "SUCCESS" : this.attempted ? "UNKNOWN" : "STOPPED", reason);
  }
}
