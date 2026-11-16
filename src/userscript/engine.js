import {
  BOOK_PATH,
  beginTime,
  category,
  check,
  codeOf,
  conflicts,
  inspectRange,
  mappingFingerprint,
  parseRange,
  records,
  resolveSeats,
  responseCode,
  roomQuery,
  signedRequest,
  validateSelection,
  verified,
} from "./core.js";
import { accountKey } from "./ledger.js";
export class Engine {
  constructor(io, ledger, notify = () => {}) {
    this.io = io;
    this.ledger = ledger;
    this.notify = notify;
    this.logs = [];
    this.generation = 0;
    this.busy = false;
    this.preview = null;
    this.identity = null;
  }
  log(code, details = {}) {
    this.logs.push({ at: new Date().toISOString(), code, ...details });
    if (this.logs.length > 40) this.logs.shift();
    this.notify({ code, details });
  }
  ensure(generation) {
    check(generation === this.generation, "STOPPED");
  }
  stop() {
    this.generation++;
    this.preview = null;
    this.controller?.abort();
    this.log("STOPPED");
  }
  async run(fn) {
    check(!this.busy, "BUSY");
    this.busy = true;
    this.controller = new AbortController();
    const generation = this.generation;
    try {
      return await fn(generation);
    } catch (e) {
      this.preview = null;
      this.log(codeOf(e));
      throw e;
    } finally {
      this.busy = false;
      this.controller = null;
    }
  }
  async read(path, generation, form) {
    this.ensure(generation);
    const { body } = await this.io.request(path, { form, signal: this.controller.signal });
    this.ensure(generation);
    const code = responseCode(body);
    check(!["LIMITED", "HTTP_404", "AUTH_REQUIRED"].includes(code), code);
    return body;
  }
  async login(generation, timings = {}) {
    const start = performance.now();
    const body = await this.read("/User/Center/baseInfo", generation);
    const uid = body?.DATA?.uid;
    check(body?.DATA?.is_login === true && /^[0-9]+$/.test(String(uid ?? "")), "AUTH_REQUIRED");
    const identity = { uid: String(uid), key: await accountKey(String(uid)) };
    this.ensure(generation);
    this.identity = identity;
    timings.loginCheckMs = performance.now() - start;
    this.log("LOGIN_OK", { loginCheckMs: timings.loginCheckMs });
    return identity;
  }
  async ranges(generation, timings = {}) {
    const start = performance.now();
    const query = roomQuery(await this.read("/Space/Category/list?LAB_JSON=1", generation));
    const body = await this.read(query, generation);
    this.log("RANGE_SHAPE", { fields: inspectRange(body?.data?.range) });
    const range = parseRange(body?.data?.range);
    const group = category(body?.data);
    timings.catalogReadMs = performance.now() - start;
    this.log("DATES_OK", { dates: range.dates, min: range.min, max: range.max });
    return { range, group };
  }
  checkLogin() {
    return this.run((g) => this.login(g).then(() => ({ valid: true })));
  }
  openDates() {
    return this.run(async (g) => {
      await this.login(g);
      return (await this.ranges(g)).range;
    });
  }
  async snapshot(selection, generation, requireFree) {
    const timings = {};
    const identity = await this.login(generation, timings);
    if (requireFree) {
      check(!(await this.ledger.get(identity.key)), "BUDGET_SPENT");
      this.ensure(generation);
    }
    const { range, group } = await this.ranges(generation, timings);
    const begin = validateSelection(selection, range, this.io.now());
    check(this.io.clockValid(), "CLOCK_UNVERIFIED");
    const start = performance.now();
    const mapBody = await this.read(
      "/Seat/Index/searchSeats?LAB_JSON=1",
      generation,
      new URLSearchParams({
        beginTime: String(begin),
        duration: "3600",
        num: "1",
        "space_category[category_id]": group.category_id,
        "space_category[content_id]": group.content_id,
      }),
    );
    timings.catalogReadMs += performance.now() - start;
    const parsed = performance.now();
    const mapping = resolveSeats(mapBody);
    timings.idResolutionMs = performance.now() - parsed;
    const read = performance.now();
    const booked = records(await this.read("/Seat/Index/myBookingList?fromType=web&LAB_JSON=1", generation));
    timings.conflictReadMs = performance.now() - read;
    const count = conflicts(booked, selection).length;
    this.log("SEATS_CHECKED", { mapping, conflicts: count, timings });
    if (requireFree) {
      check(count === 0, "EXISTING");
      check(mapping.seats.find((s) => s.number === selection.seat)?.free, "SEAT_UNAVAILABLE");
    }
    return { identity, range, selection: { ...selection }, mapping, conflictCount: count, timings };
  }
  querySeats(selection) {
    return this.run(async (g) => {
      const snap = await this.snapshot(selection, g, false);
      return { mapping: snap.mapping, conflicts: snap.conflictCount };
    });
  }
  prepare(selection) {
    this.preview = null;
    return this.run(async (g) => {
      const snap = await this.snapshot(selection, g, true);
      check(!(await this.ledger.get(snap.identity.key)), "BUDGET_SPENT");
      this.ensure(g);
      this.preview = {
        ticket: crypto.randomUUID(),
        selection: snap.selection,
        mapping: snap.mapping,
        account: snap.identity.key,
        expires: this.io.now() + 300000,
        timings: snap.timings,
      };
      this.log("AWAITING_CONFIRMATION");
      return this.preview;
    });
  }
  confirm(ticket, { details = false, rules = false } = {}) {
    return this.run(async (g) => {
      const preview = this.preview;
      check(preview && ticket === preview.ticket && details && rules, "CONFIRMATION_REQUIRED");
      this.preview = null; // Confirmation is consumed even if the next read fails.
      check(this.io.now() <= preview.expires, "PREVIEW_EXPIRED");
      const existing = await this.ledger.get(preview.account);
      this.ensure(g);
      if (existing) {
        this.log("BUDGET_SPENT");
        return existing;
      }
      const fresh = await this.snapshot(preview.selection, g, true);
      check(fresh.identity.key === preview.account, "IDENTITY_CHANGED");
      check(mappingFingerprint(fresh.mapping) === mappingFingerprint(preview.mapping), "MAPPING_CHANGED");
      check(this.io.now() <= preview.expires, "PREVIEW_EXPIRED");
      const localStart = performance.now();
      const intent = {
        key: preview.account,
        ticket,
        selection: fresh.selection,
        mapping: fresh.mapping,
        state: "UNKNOWN",
        reason: "WRITE_INTENT_PERSISTED",
        attempts: 1,
        recordVerified: false,
        timings: fresh.timings,
      };
      const claim = await this.ledger.claim(intent);
      if (!claim.won) {
        this.log("BUDGET_SPENT");
        return claim.value;
      }
      // The durable intent is committed before ANY booking request. A stop here spends the budget safely.
      let reason = "STOPPED",
        verifiedRecord = false,
        verificationError = null;
      const timings = { ...fresh.timings, preSubmitLocalMs: performance.now() - localStart };
      try {
        this.ensure(g);
        check(this.io.now() <= preview.expires, "PREVIEW_EXPIRED");
        validateSelection(fresh.selection, fresh.range, this.io.now());
        check(this.io.clockValid(), "CLOCK_UNVERIFIED");
        const request = signedRequest(
          fresh.mapping.seats.find((s) => s.number === fresh.selection.seat).id,
          fresh.identity.uid,
          beginTime(fresh.selection),
          Math.floor(this.io.now() / 1000),
        );
        timings.preSubmitLocalMs = performance.now() - localStart;
        this.log("SUBMITTING_ONCE");
        const response = await this.io.request(BOOK_PATH, {
          ...request,
          write: true,
          signal: this.controller.signal,
        });
        timings.http = response.timing;
        reason = responseCode(response.body);
      } catch (error) {
        reason = codeOf(error);
        timings.http = error.timing || null;
      }
      // Never retry POST, never switch seats, never lock/unlock/cancel.
      if (g === this.generation && !["LIMITED", "AUTH_REQUIRED"].includes(reason)) {
        const verification = performance.now();
        try {
          verifiedRecord = verified(
            records(await this.read("/Seat/Index/myBookingList?fromType=web&LAB_JSON=1", g)),
            fresh,
          );
        } catch (error) {
          verificationError = codeOf(error);
        }
        timings.verificationMs = performance.now() - verification;
      }
      const state = verifiedRecord
        ? "SUCCESS"
        : ["LIMITED", "AUTH_REQUIRED", "SEAT_UNAVAILABLE", "EXISTING", "NOT_OPEN"].includes(reason)
          ? "STOPPED"
          : "UNKNOWN";
      const result = await this.ledger.finish(preview.account, ticket, {
        state,
        reason,
        recordVerified: verifiedRecord,
        verificationError,
        timings,
      });
      this.log(state, { reason, recordVerified: verifiedRecord, timings });
      return result;
    });
  }
  review() {
    return this.run(async (g) => {
      const identity = await this.login(g);
      const attempt = await this.ledger.get(identity.key);
      this.ensure(g);
      const items = records(await this.read("/Seat/Index/myBookingList?fromType=web&LAB_JSON=1", g));
      if (!attempt) {
        this.log("NO_ATTEMPT", { existingRecordCount: items.length });
        return { state: "NOT_STARTED", existingRecordCount: items.length };
      }
      if (verified(items, attempt)) {
        const result = await this.ledger.finish(identity.key, attempt.ticket, {
          state: "SUCCESS",
          recordVerified: true,
        });
        this.log("SUCCESS", { recordVerified: true });
        return result;
      }
      this.log(attempt.state, { reason: attempt.reason, recordVerified: attempt.recordVerified });
      return attempt;
    });
  }
}
