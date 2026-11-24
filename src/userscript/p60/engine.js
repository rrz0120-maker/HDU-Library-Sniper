import { archive } from "./history.js";
import {
  BOOK_PATH,
  check,
  codeOf,
  records,
  roomQuery,
  shanghaiDate,
  signedRequest,
  TestError,
} from "../core.js";
import { accountKey } from "../ledger.js";
import { RECORD_PATH, verified162 } from "../p53/policy.js";
import {
  banUntil,
  bookingResult,
  nextCheckMs,
  preparationRange,
  publicDiagnostics,
  REASONS,
  restoredReport,
  validateDailyTask,
} from "./policy.js";
import { DailyStore, recall, remember, slotKey } from "./store.js";

const unresolved = new Set(["TIMEOUT", "NETWORK_ERROR", "HTTP_404", "HTTP_ERROR", "RESPONSE_UNKNOWN"]);

export class DailyEngine {
  constructor(io, notify = () => {}, env = {}) {
    this.io = io;
    this.notify = notify;
    this.wall = env.wall || (() => Date.now());
    this.mono = env.mono || (() => performance.now());
    this.visible = env.visible || (() => !document.hidden);
    this.locks = env.locks || globalThis.navigator?.locks;
    this.openStore = env.openStore || ((name) => new DailyStore(name));
    this.previous = recall();
    this.report = { state: "IDLE", reason: "IDLE", attempts: 0 };
    this.running = false;
    this.waiting = false;
    this.reviewing = false;
    this.message = "";
    this.storeName = null;
    this.limitedUntil = 0;
    this.pageSuspended = false;
    if (this.previous?.runId && this.previous.storageStatus !== "SAVED") this.archiveResult(this.previous);
  }
  view() {
    return {
      ...publicDiagnostics(this.previous || this.report),
      historical: Boolean(this.previous),
      message: this.message,
      running: this.running,
      waiting: this.waiting,
      reviewing: this.reviewing,
    };
  }
  render() {
    try {
      this.notify(this.view());
    } catch {
      this.report.diagnosticStorageFailed = true;
    }
  }
  saveDisplay() {
    if (!remember(this.report, this.storeName)) this.report.diagnosticStorageFailed = true;
  }
  archiveResult(report = this.report) {
    if (!report.runId) return;
    const snapshot = Symbol();
    report.archiveSnapshot = snapshot;
    report.storageStatus = null;
    const row = publicDiagnostics({ ...report, storageStatus: "SAVED" });
    if (row.state === "SENDING")
      Object.assign(row, { state: "UNKNOWN", reason: "PENDING", message: REASONS.PENDING });
    archive(row)
      .then(() => {
        if (report.archiveSnapshot === snapshot) report.storageStatus = "SAVED";
      })
      .catch(() => {
        report.diagnosticStorageFailed = true;
      })
      .finally(() => {
        if (report.archiveSnapshot !== snapshot) return;
        if (this.previous === report) this.render();
        if (this.report === report) {
          this.saveDisplay();
          this.render();
        }
      });
  }
  emit(state, reason) {
    Object.assign(this.report, { state, reason, storageStatus: null, archiveSnapshot: null });
    this.saveDisplay();
    this.render();
  }
  saveReceipt() {
    try {
      this.store.receipt(this.report);
    } catch {
      this.report.diagnosticStorageFailed = true;
    }
  }
  limit(until) {
    this.limitedUntil = Math.max(this.limitedUntil, until);
    this.report.nextWriteAt = new Date(this.limitedUntil).toISOString();
    if (this.store) {
      this.store.data.limitedUntil = Math.max(this.store.data.limitedUntil, until);
      try {
        this.store.save();
      } catch {
        this.report.diagnosticStorageFailed = true;
      }
    }
  }
  async read(path, signal) {
    const { body, status } = await this.io.request(path, {
      signal,
      inspectHttpErrors: true,
      onHeaders: (sample) => {
        if (sample.status === 429) this.limit(banUntil(sample.retryAfter, this.wall()));
      },
    });
    const reason = bookingResult(body, status);
    if (reason === "LIMITED") this.limit(banUntil(null, this.wall()));
    check(!["LIMITED", "AUTH_REQUIRED", "HTTP_404", "HTTP_ERROR"].includes(reason), reason);
    check(body && (body.CODE === undefined || body.CODE === "ok"), "RESPONSE_UNKNOWN");
    return body;
  }
  async withAccount(signal, action) {
    const body = await this.read("/User/Center/baseInfo", signal);
    const uid = String(body?.DATA?.uid ?? "");
    check(body?.DATA?.is_login === true && /^\d+$/.test(uid), "AUTH_REQUIRED");
    const name = `hdu-p62:${await accountKey(uid)}`;
    check(!signal.aborted, "STOPPED");
    check(this.locks?.request, "LOCK_UNAVAILABLE");
    await this.locks.request(name, { ifAvailable: true }, async (lock) => {
      check(lock, "ACTIVE_TAB");
      check(!signal.aborted, "STOPPED");
      this.store = this.openStore(name);
      this.storeName = name;
      this.store.prune(shanghaiDate(this.wall()));
      this.saveDisplay();
      await action(uid);
    });
  }
  pace(at) {
    const limited = Math.max(this.limitedUntil, this.store.data.limitedUntil);
    const next = Math.max(limited, this.store.data.nextWrite);
    if (next > at) {
      this.report.nextWriteAt = new Date(next).toISOString();
      throw new TestError(limited > at ? "LIMITED" : "PACING");
    }
  }
  async prepare(task) {
    if (this.running) return;
    this.running = true;
    this.store = null;
    this.storeName = null;
    this.message = "";
    this.controller = new AbortController();
    this.pageSuspended = !this.visible();
    const signal = this.controller.signal;
    this.previous = null;
    this.report = {
      runId: crypto.randomUUID(),
      task,
      state: "PREPARING",
      reason: "PREPARING",
      attempts: 0,
      verification: "NONE",
      plannedAt: new Date(task.planned).toISOString(),
      prepareStartedAt: new Date(this.wall()).toISOString(),
    };
    this.emit("PREPARING", "PREPARING");
    try {
      validateDailyTask(task);
      check(task.day === shanghaiDate(this.wall()), "DAY_EXPIRED");
      await this.withAccount(signal, async (uid) => {
        const existing = this.store.conflict(task);
        if (existing) {
          const fresh = this.report;
          this.report = restoredReport(existing);
          if (this.report.state === "SUCCESS" || this.report.verifiedAt) {
            await this.verify(signal);
            // A cancelled confirmed booking can be applied for again after a fresh official read.
            if (this.report.verification !== "ABSENT") {
              this.archiveResult({ ...fresh, state: "IDLE", reason: "DUPLICATE" });
              return;
            }
            delete this.store.data.requests[slotKey(this.report.task)];
            this.store.save();
            this.report = fresh;
          } else {
            this.archiveResult({ ...fresh, state: "IDLE", reason: "DUPLICATE" });
            this.emit(
              this.report.accepted ? "ACCEPTED" : "UNKNOWN",
              this.report.reason === "SENDING" ? "PENDING" : this.report.reason,
            );
            return;
          }
        }
        this.pace(Math.max(this.wall(), task.planned));
        const path = roomQuery(await this.read("/Space/Category/list?LAB_JSON=1", signal));
        preparationRange((await this.read(path, signal)).data?.range, task);
        check(!signal.aborted, "STOPPED");
        this.preparedWall = this.wall();
        this.preparedMono = this.mono();
        this.report.preparedAt = new Date(this.preparedWall).toISOString();
        this.emit("WAITING", "WAITING");
        await this.wait(signal);
        check(task.day === shanghaiDate(this.wall()), "DAY_EXPIRED");
        await this.submit(uid);
      });
    } catch (error) {
      if (this.report.attempts !== 0) {
        if (!["SUCCESS", "ACCEPTED", "FAILED"].includes(this.report.state)) this.emit("UNKNOWN", "PENDING");
      } else {
        const reason = signal.aborted ? "USER_STOPPED" : codeOf(error);
        this.emit("IDLE", Object.hasOwn(REASONS, reason) ? reason : "LOCAL_ERROR");
      }
    } finally {
      this.archiveResult();
      this.waiting = false;
      this.running = false;
      this.render();
    }
  }
  wait(signal) {
    this.waiting = true;
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error) => {
        clearTimeout(timer);
        this.wake = null;
        this.waiting = false;
        signal.removeEventListener("abort", cancel);
        if (error) reject(error);
        else resolve();
      };
      const cancel = () => finish(new TestError("STOPPED"));
      this.wake = () => {
        clearTimeout(timer);
        if (signal.aborted) return cancel();
        if (!this.visible() || this.pageSuspended) {
          this.report.hiddenDuringWait = true;
          timer = setTimeout(this.wake, 1000);
          return;
        }
        const remaining = this.report.task.planned - this.wall();
        if (remaining <= 0) finish();
        else timer = setTimeout(this.wake, nextCheckMs(remaining));
      };
      signal.addEventListener("abort", cancel, { once: true });
      this.wake();
    });
  }
  observePage(event) {
    if (!this.running || this.report.attempts !== 0) return;
    if (event === "freeze" || event === "pagehide") this.pageSuspended = true;
    if (event === "pageshow" || event === "resume" || (event === "visibilitychange" && this.visible()))
      this.pageSuspended = false;
    if (!this.visible() || this.pageSuspended) this.report.hiddenDuringWait = true;
    this.wake?.();
  }
  stop() {
    if (this.running && !this.reviewing && this.report.attempts === 0) this.controller.abort();
  }
  async submit(uid) {
    const r = this.report,
      task = r.task;
    this.store.reload(); // Synchronous unresolved check under the already-held account lock.
    check(!this.store.conflict(task), "PENDING");
    this.pace(this.wall());
    const request = signedRequest(
      task.seatId,
      uid,
      task.begin,
      Math.floor(this.wall() / 1000),
      task.duration,
    );
    let undo;
    try {
      const response = await this.io.request(BOOK_PATH, {
        ...request,
        write: true,
        inspectHttpErrors: true,
        beforeDispatch: () => {
          undo = this.store.intent(task, this.wall(), r.runId);
        },
        onDispatched: (at) => {
          r.attempts = 1;
          r.dispatchAt = at;
          r.delayFrom20Ms = Date.parse(at) - task.open;
          r.scheduleLagMs = Date.parse(at) - task.planned;
          r.inWindow = r.delayFrom20Ms >= 800 && r.delayFrom20Ms <= 2000;
          r.clockChangeMs = Math.round(this.wall() - this.preparedWall - (this.mono() - this.preparedMono));
          r.state = "SENDING";
          r.reason = "SENDING";
          this.saveReceipt();
          this.emit("SENDING", "SENDING");
          this.archiveResult();
        },
        onHeaders: (sample) => {
          r.httpStatus = sample.status;
          r.responseAt = sample.timing.responseAt;
          r.httpMs = sample.timing.dispatchToHeadersMs;
          if (sample.status === 429) {
            this.limit(banUntil(sample.retryAfter, this.wall()));
            this.emit("FAILED", "LIMITED");
            this.saveReceipt();
          }
        },
      });
      r.requestStartAt = response.timing?.requestStartAt;
      r.requestToFirstByteMs = response.timing?.requestToFirstByteMs;
      r.responseDownloadMs = response.timing?.responseDownloadMs;
      r.businessAt = response.timing?.businessResultAt;
      r.businessCode = response.body?.CODE == null ? null : String(response.body.CODE);
      r.businessResult = response.body?.DATA?.result;
      this.message = String(response.body?.DATA?.msg || response.body?.MESSAGE || "").slice(0, 500);
      const reason = bookingResult(response.body, response.status);
      if (reason !== "SERVER_SUCCESS") r.failureMessage = this.message;
      if (reason === "LIMITED") this.limit(banUntil(response.retryAfter, this.wall()));
      r.accepted = reason === "SERVER_SUCCESS";
      this.emit(r.accepted ? "ACCEPTED" : unresolved.has(reason) ? "UNKNOWN" : "FAILED", reason);
      this.saveReceipt();
      if (r.accepted) await this.verify();
    } catch (error) {
      if (r.attempts === 0) {
        undo?.();
        throw error;
      }
      if (r.reason !== "LIMITED") this.emit("UNKNOWN", codeOf(error));
      this.saveReceipt();
    }
  }
  async verify(signal) {
    const r = this.report;
    r.storageStatus = null;
    r.archiveSnapshot = null;
    r.verification = "CHECKING";
    this.render();
    try {
      const body = await this.read(RECORD_PATH, signal);
      const items = records(body);
      const matched = verified162(items, { room: r.task.room }, r.task);
      r.verification = matched ? "MATCHED" : "ABSENT";
      r.recordVerified = matched;
      if (matched) {
        r.verifiedAt ||= new Date(this.wall()).toISOString();
        r.state = "SUCCESS";
      } else if (r.state === "SUCCESS") {
        r.state = r.accepted ? "ACCEPTED" : "UNKNOWN";
      }
    } catch (error) {
      r.verification = ["AUTH_REQUIRED", "LIMITED"].includes(error.code) ? error.code : "ERROR";
    }
    this.saveReceipt();
    this.saveDisplay();
    this.render();
  }
  async review() {
    if (this.previous && !this.running) {
      this.report = this.previous;
      this.previous = null;
    }
    if (this.running || !this.report.task || this.report.attempts === 0) return;
    this.running = this.reviewing = true;
    this.store = null;
    this.controller = new AbortController();
    this.render();
    try {
      const task = this.report.task;
      await this.withAccount(this.controller.signal, async () => {
        const saved = this.store.conflict(task);
        check(saved, "ACCOUNT_CHANGED");
        this.report = { ...restoredReport(saved), runId: this.report.runId ?? saved.runId };
        if (this.report.state === "SENDING") {
          this.report.state = "UNKNOWN";
          this.report.reason = "PENDING";
        }
        await this.verify();
      });
    } catch (error) {
      this.report.verification = ["AUTH_REQUIRED", "LIMITED"].includes(error.code) ? error.code : "ERROR";
      this.message = REASONS[codeOf(error)] || REASONS.LOCAL_ERROR;
      this.saveDisplay();
    } finally {
      this.archiveResult();
      this.running = this.reviewing = false;
      this.render();
    }
  }
  diagnosticExport() {
    return publicDiagnostics(this.previous || this.report);
  }
}
