import {
  BOOK_PATH,
  category,
  check,
  codeOf,
  inspectRange,
  parseRange,
  records,
  responseCode,
  roomQuery,
  signedRequest,
} from "../core.js";
import { accountKey } from "../ledger.js";
import {
  P70_DURATION,
  P70_PREVIEW_TTL_MS,
  P70_RECORD_PATH,
  P70_VERSION,
  publicIpadDiagnostics,
  resolveRoomsAndSeats,
  resolveSelectedSeat,
  safeRandomId,
  slotBeginTime,
  slotConflicts,
  slotKey,
  validateSlotSelection,
  verifiedSlot,
} from "./policy.js";

const REJECTED = new Set(["SEAT_UNAVAILABLE", "NOT_OPEN", "EXISTING", "LIMITED", "AUTH_REQUIRED"]);

export class IpadBookingEngine {
  constructor(io, store, notify = () => {}, env = {}) {
    this.io = io;
    this.store = store;
    this.notify = notify;
    this.wall = env.wall || (() => (io.now ? io.now() : Date.now()));
    this.mono = env.mono || (() => performance.now());
    this.visible = env.visible || (() => (typeof document === "undefined" ? true : document.visibilityState === "visible"));
    this.state = "IDLE";
    this.reason = "READ_ONLY_DEFAULT";
    this.generation = 0;
    this.busy = false;
    this.controller = null;
    this.identity = null;
    this.lastRange = null;
    this.lastSnapshot = null;
    this.preview = null;
    this.activeKey = null;
    this.coordinator = env.coordinator || null;
    this.duplicateActionBlocked = 0;
    this.crossModeConflict = null;
    this.lastHttpDiag = null;
    this.logs = [];
  }

  iso() {
    return new Date(this.wall()).toISOString();
  }

  emit(state, code, details = {}) {
    this.state = state;
    this.reason = code;
    this.logs.push({ at: this.iso(), state, code, ...details });
    if (this.logs.length > 50) this.logs.shift();
    this.notify({ state, code, details });
  }

  ensure(generation) {
    check(generation === this.generation, "STOPPED");
  }

  clearSnapshot() {
    this.lastSnapshot = null;
    this.preview = null;
  }

  stop(reason = "STOPPED") {
    this.generation++;
    this.preview = null;
    this.controller?.abort();
    this.store.stopSignal?.();
    this.emit(this.state === "SUBMITTING" ? "UNKNOWN" : "STOPPED", reason);
  }

  suspend(reason = "FOREGROUND_REQUIRED") {
    if (this.busy || this.preview) this.stop(reason);
  }

  async run(fn) {
    if (this.busy) {
      this.duplicateActionBlocked++;
      check(false, "BUSY");
    }
    this.busy = true;
    this.controller = new AbortController();
    const generation = this.generation;
    try {
      return await fn(generation);
    } catch (error) {
      this.preview = null;
      const code = codeOf(error);
      const diag = this.lastHttpDiag || {};
      this.lastHttpDiag = null;
      this.emit(this.state === "SUBMITTING" ? "UNKNOWN" : "STOPPED", code, diag);
      throw error;
    } finally {
      this.busy = false;
      this.controller = null;
    }
  }

  async read(path, generation, form) {
    this.ensure(generation);
    let httpStatus = null;
    const endpoint = String(path).split("?")[0];
    try {
      const { body } = await this.io.request(path, {
        form,
        signal: this.controller.signal,
        onHeaders: (sample) => {
          httpStatus = sample?.status ?? null;
        },
      });
      this.ensure(generation);
      const code = responseCode(body);
      if (["LIMITED", "HTTP_404", "AUTH_REQUIRED"].includes(code)) {
        this.lastHttpDiag = { httpStatus, endpoint };
        check(false, code);
      }
      return body;
    } catch (error) {
      this.lastHttpDiag = { httpStatus, endpoint };
      throw error;
    }
  }

  async login(generation, timings = {}) {
    const start = this.mono();
    const body = await this.read("/User/Center/baseInfo", generation);
    const uid = body?.DATA?.uid;
    check(body?.DATA?.is_login === true && /^\d+$/.test(String(uid ?? "")), "AUTH_REQUIRED");
    const account = await accountKey(String(uid));
    this.ensure(generation);
    if (this.identity) check(this.identity.account === account, "IDENTITY_CHANGED");
    this.identity = { uid: String(uid), account };
    this.store.bind(account);
    timings.loginCheckMs = this.mono() - start;
    this.emit("READY_READ_ONLY", "LOGIN_OK");
    return this.identity;
  }

  async readRange(generation, timings = {}) {
    const start = this.mono();
    const query = roomQuery(await this.read("/Space/Category/list?LAB_JSON=1", generation));
    const body = await this.read(query, generation);
    this.emit("READY_READ_ONLY", "RANGE_SHAPE", { fields: inspectRange(body?.data?.range) });
    const range = parseRange(body?.data?.range);
    const group = category(body?.data);
    timings.catalogReadMs = this.mono() - start;
    this.lastRange = { range, group, at: this.wall() };
    this.emit("READY_READ_ONLY", "DATES_OK", {
      dates: range.dates,
      min: range.min,
      max: range.max,
      maxDateExclusive: range.maxDateExclusive,
    });
    return { range, group };
  }

  checkLogin() {
    return this.run(async (g) => {
      await this.login(g);
      return { valid: true };
    });
  }

  openDates() {
    return this.run(async (g) => {
      if (!this.identity) await this.login(g);
      return (await this.readRange(g)).range;
    });
  }

  async fetchRoomsSnapshot(slot, generation, timings = {}) {
    const identity = this.identity || (await this.login(generation, timings));
    const freshRange =
      this.lastRange && this.wall() - this.lastRange.at <= 120000
        ? this.lastRange
        : await this.readRange(generation, timings);
    const { range, group } = freshRange;
    const begin = validateSlotSelection({ date: slot.date, hour: slot.hour, hours: 1 }, range, this.wall());
    check(this.io.clockValid(), "CLOCK_UNVERIFIED");
    const start = this.mono();
    const mapBody = await this.read(
      "/Seat/Index/searchSeats?LAB_JSON=1",
      generation,
      new URLSearchParams({
        beginTime: String(begin),
        duration: String(P70_DURATION),
        num: "1",
        "space_category[category_id]": group.category_id,
        "space_category[content_id]": group.content_id,
      }),
    );
    timings.catalogReadMs = (timings.catalogReadMs || 0) + (this.mono() - start);
    const parseStart = this.mono();
    const rooms = resolveRoomsAndSeats(mapBody);
    timings.idResolutionMs = this.mono() - parseStart;
    const conflictStart = this.mono();
    const booked = records(await this.read(P70_RECORD_PATH, generation));
    timings.conflictReadMs = this.mono() - conflictStart;
    const conflictCount = slotConflicts(booked, { date: slot.date, hour: slot.hour, hours: 1 }).length;
    this.emit("READY_READ_ONLY", "SEATS_CHECKED", {
      roomCount: rooms.length,
      freeSeats: rooms.reduce((sum, r) => sum + r.freeCount, 0),
      conflicts: conflictCount,
    });
    const snap = {
      date: slot.date,
      hour: Number(slot.hour),
      at: this.wall(),
      identity,
      range,
      rooms,
      conflictCount,
      timings,
    };
    this.lastSnapshot = snap;
    return snap;
  }

  queryRooms(date, hour) {
    return this.run(async (g) => {
      const snap = await this.fetchRoomsSnapshot({ date, hour }, g);
      return { rooms: snap.rooms, conflicts: snap.conflictCount, range: snap.range };
    });
  }

  prepare(selection) {
    this.preview = null;
    return this.run(async (g) => {
      check(this.visible(), "FOREGROUND_REQUIRED");
      await this.store.probe();
      this.ensure(g);
      const reusable =
        this.lastSnapshot &&
        this.lastSnapshot.date === selection.date &&
        this.lastSnapshot.hour === Number(selection.hour) &&
        this.wall() - this.lastSnapshot.at <= P70_PREVIEW_TTL_MS;
      const snap = reusable ? this.lastSnapshot : await this.fetchRoomsSnapshot(selection, g);
      validateSlotSelection({ date: selection.date, hour: selection.hour, hours: 1 }, snap.range, this.wall());
      if (this.coordinator) {
        const conflict = await this.coordinator.checkForNormal(snap.identity.account, selection);
        if (conflict) {
          this.crossModeConflict = conflict;
          check(false, conflict.code);
        }
      }
      const pending = await this.store.pendingUnknown(snap.identity.account);
      check(!pending, "PREVIOUS_UNKNOWN");
      check(snap.conflictCount === 0, "EXISTING");
      const resolved = resolveSelectedSeat(snap.rooms, selection);
      check(resolved.seat.free, "SEAT_UNAVAILABLE");
      const target = {
        date: selection.date,
        hour: Number(selection.hour),
        hours: 1,
        floorId: resolved.floorId,
        room: resolved.room,
        seatNumber: resolved.seat.number,
        seatId: resolved.seat.id,
      };
      const key = slotKey(snap.identity.account, target);
      const existing = await this.store.get(key);
      check(!existing && !this.store.spent(key), "BUDGET_SPENT");
      this.ensure(g);
      this.preview = {
        ticket: safeRandomId(),
        key,
        account: snap.identity.account,
        uid: snap.identity.uid,
        range: snap.range,
        target,
        expires: Math.min(snap.at + P70_PREVIEW_TTL_MS, this.wall() + P70_PREVIEW_TTL_MS),
        timings: { ...snap.timings },
      };
      this.emit("AWAITING_CONFIRMATION", "AWAITING_CONFIRMATION");
      return this.preview;
    });
  }

  confirm(ticket, { details = false, rules = false } = {}) {
    return this.run(async (g) => {
      const preview = this.preview;
      check(preview && ticket === preview.ticket && details && rules, "CONFIRMATION_REQUIRED");
      this.preview = null;
      check(this.visible(), "FOREGROUND_REQUIRED");
      check(this.wall() <= preview.expires, "PREVIEW_EXPIRED");
      await this.store.probe();
      this.ensure(g);
      if (this.coordinator) {
        const conflict = await this.coordinator.checkForNormal(preview.account, preview.target);
        if (conflict) {
          this.crossModeConflict = conflict;
          check(false, conflict.code);
        }
      }
      const pending = await this.store.pendingUnknown(preview.account);
      check(!pending, "PREVIOUS_UNKNOWN");
      const prior = await this.store.get(preview.key);
      if (prior || this.store.spent(preview.key)) {
        this.activeKey = preview.key;
        this.emit(prior?.state || "UNKNOWN", "BUDGET_SPENT");
        return prior || { key: preview.key, state: "UNKNOWN", reason: "BUDGET_SPENT", attempts: 1 };
      }

      // Reuse the verified seat snapshot from Step 3 without re-calling POST /Seat/Index/searchSeats,
      // preventing unnecessary seat-map POST rate limits while preserving strict single-write protection.
      validateSlotSelection(preview.target, preview.range, this.wall());
      check(this.io.clockValid(), "CLOCK_UNVERIFIED");

      const localStart = this.mono();
      const timings = { ...preview.timings };
      const intent = {
        key: preview.key,
        ticket,
        version: P70_VERSION,
        target: preview.target,
        state: "UNKNOWN",
        reason: "WRITE_INTENT_PERSISTED",
        attempts: 1,
        recordVerified: false,
        timings,
        logs: this.logs.slice(-50),
      };
      const claim = await this.store.claim(intent);
      this.activeKey = preview.key;
      if (!claim.won) {
        this.emit(claim.value?.state || "UNKNOWN", "BUDGET_SPENT");
        return claim.value;
      }

      let reason = "STOPPED";
      let verifiedRecord = false;
      let verificationReadSucceeded = false;
      try {
        this.ensure(g);
        check(this.visible(), "FOREGROUND_REQUIRED");
        check(this.wall() <= preview.expires, "PREVIEW_EXPIRED");
        const request = signedRequest(
          preview.target.seatId,
          preview.uid,
          slotBeginTime(preview.target),
          Math.floor(this.wall() / 1000),
          P70_DURATION,
        );
        timings.preSubmitLocalMs = this.mono() - localStart;
        this.emit("SUBMITTING", "SUBMITTING_ONCE");
        const response = await this.io.request(BOOK_PATH, {
          ...request,
          write: true,
          signal: this.controller.signal,
          onDispatch: (at) => {
            timings.firstDispatchAt = at;
          },
          onHeaders: (sample) => {
            timings.firstResponseAt = sample.timing?.responseAt || this.iso();
            timings.dispatchToHeadersMs = sample.timing?.dispatchToHeadersMs;
          },
          onBusiness: (body, t) => {
            timings.firstBusinessResultAt = t.businessResultAt || this.iso();
            timings.bodyDecodeMs = t.bodyDecodeMs;
          },
        });
        timings.totalRequestMs = response.timing?.totalRequestMs ?? null;
        reason = responseCode(response.body);
        timings.responseCode = reason;
      } catch (error) {
        reason = codeOf(error);
        timings.responseCode = reason;
        if (error.timing?.totalRequestMs != null) timings.totalRequestMs = error.timing.totalRequestMs;
      }

      // Never retry POST and never auto-switch seats. At most 1 automatic official record check.
      if (g === this.generation && !["LIMITED", "AUTH_REQUIRED"].includes(reason)) {
        const canVerify = await this.store.takeVerification(preview.key, this.wall());
        if (canVerify) {
          const vStart = this.mono();
          try {
            const items = records(await this.read(P70_RECORD_PATH, g));
            verificationReadSucceeded = true;
            verifiedRecord = verifiedSlot(items, preview.target);
            if (verifiedRecord) timings.firstRecordVerifiedAt = this.iso();
          } catch {
            verificationReadSucceeded = false;
          }
          timings.verificationMs = this.mono() - vStart;
        }
      }

      const state = verifiedRecord
        ? "SUCCESS"
        : ["LIMITED", "AUTH_REQUIRED"].includes(reason) || (verificationReadSucceeded && REJECTED.has(reason))
          ? "FAILED"
          : "UNKNOWN";
      const finalReason = verifiedRecord ? "RECORD_VERIFIED" : reason;
      this.emit(state, finalReason);
      const saved = await this.store.finish(preview.key, ticket, {
        state,
        reason: finalReason,
        recordVerified: verifiedRecord,
        timings,
        logs: this.logs.slice(-50),
      });
      return saved;
    });
  }

  review(key = this.activeKey) {
    return this.run(async (g) => {
      const identity = this.identity || (await this.login(g));
      const rows = await this.store.list(identity.account);
      let row = key ? rows.find((r) => r.key === key) : null;
      if (!row && rows.length) {
        row = rows.find((r) => r.state === "UNKNOWN") || rows[rows.length - 1];
      }
      if (!row) {
        this.emit("IDLE", "NO_ATTEMPT");
        return { state: "IDLE", reason: "NO_ATTEMPT", attempts: 0 };
      }
      this.activeKey = row.key;
      if (row.state === "SUCCESS") {
        this.emit("SUCCESS", "REVIEW_SAVED_RESULT");
        await this.store.noteReview(row.key, this.iso(), this.logs);
        return row;
      }
      const allowed = await this.store.takeVerification(row.key, this.wall());
      if (!allowed) {
        this.emit(row.state, "READ_CHECK_LIMIT_OR_ERROR");
        await this.store.noteReview(row.key, this.iso(), this.logs);
        return row;
      }
      const vStart = this.mono();
      const items = records(await this.read(P70_RECORD_PATH, g));
      const vMs = this.mono() - vStart;
      if (verifiedSlot(items, row.target)) {
        const at = this.iso();
        this.emit("SUCCESS", "RECORD_VERIFIED");
        const updated = await this.store.finish(row.key, row.ticket, {
          state: "SUCCESS",
          reason: "RECORD_VERIFIED",
          recordVerified: true,
          lastReviewedAt: at,
          timings: { firstRecordVerifiedAt: row.timings?.firstRecordVerifiedAt || at, verificationMs: vMs },
          logs: this.logs.slice(-50),
        });
        return updated;
      }
      this.emit(row.state === "FAILED" ? "FAILED" : "UNKNOWN", "RECORD_NOT_VERIFIED");
      await this.store.noteReview(row.key, this.iso(), this.logs);
      return await this.store.get(row.key);
    });
  }

  async listRecent() {
    if (!this.identity) return [];
    const rows = await this.store.list(this.identity.account);
    return rows.slice(-7).reverse();
  }

  async diagnosticExport() {
    let rows = [];
    if (this.identity) rows = await this.store.list(this.identity.account);
    const active = (this.activeKey && rows.find((r) => r.key === this.activeKey)) || rows[rows.length - 1] || null;
    return {
      version: P70_VERSION,
      platform: "ipad-safari-userscripts",
      current: publicIpadDiagnostics(
        active || {
          version: P70_VERSION,
          state: this.state,
          reason: this.reason,
          attempts: 0,
          logs: this.logs,
        },
      ),
      duplicateActionBlocked: this.duplicateActionBlocked,
      crossModeConflict: this.crossModeConflict,
      recent: rows.slice(-7).reverse().map(publicIpadDiagnostics),
    };
  }
}
