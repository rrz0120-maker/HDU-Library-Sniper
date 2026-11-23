import { check, TestError, shanghaiDate } from "../core.js";
import { accountName, Guard, recall, remember, rememberGuard, slotKey } from "./guard.js";
import { login, verify, confirmOpen, submitPrepared } from "./network.js";
import { beijing, DAY, diagnostic, initialReport, makeTask, PACING_MS, REASONS } from "./policy.js";

const uncertain = new Set(["TIMEOUT", "NETWORK_ERROR", "HTTP_UNCERTAIN", "RESPONSE_UNKNOWN"]);
const errorCode = (e) => (Object.hasOwn(REASONS, e?.code) ? e.code : "LOCAL_ERROR");

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
        return; // A return to the foreground rechecks the same target.
      }
      const left = target - Date.now();
      if (left <= 0) finish();
      else timer = setTimeout(wake, Math.min(left, 30000));
    }
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("pageshow", wake);
    signal.addEventListener("abort", cancel, { once: true });
    wake();
  });
}

export class Booking {
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
      // A previously confirmed booking can be cancelled through the official page.
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
    // Device clock only. No fetch, IndexedDB transaction or lock acquisition in the timer.
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
      },
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
      r.verification =
        error.code === "AUTH_REQUIRED" ? "auth" : error.code === "LIMITED" ? "limited" : "error";
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
      this.report.verification =
        error.code === "AUTH_REQUIRED" ? "auth" : error.code === "LIMITED" ? "limited" : "error";
      this.detail = REASONS[errorCode(error)];
      remember(this.report);
    } finally {
      this.active = null;
      this.paint();
    }
  }
}
