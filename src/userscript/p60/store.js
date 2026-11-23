import { check, TestError } from "../core.js";
import { publicDiagnostics, restoredReport, WRITE_INTERVAL } from "./policy.js";

export const LAST_REPORT = "hdu-p62:last-report";
export const LAST_ACCOUNT = "hdu-p62:last-store";

export function slotKey(task) {
  return [task.date, task.startHour, task.endHour].join("/");
}

// The caller holds the account Web Lock, acquired during preparation.
// Waiting/stopped tasks are never stored in the write-intent ledger.
export class DailyStore {
  constructor(name, storage = globalThis.localStorage) {
    this.name = name;
    this.storage = storage;
    this.data = { nextWrite: 0, limitedUntil: 0, requests: {} };
    this.reload();
  }
  reload() {
    try {
      const raw = this.storage.getItem(this.name);
      this.data = raw === null ? { nextWrite: 0, limitedUntil: 0, requests: {} } : JSON.parse(raw);
      check(
        Number.isFinite(this.data.nextWrite) &&
          Number.isFinite(this.data.limitedUntil) &&
          this.data.requests &&
          typeof this.data.requests === "object" &&
          !Array.isArray(this.data.requests),
        "INTENT_STORAGE_ERROR",
      );
    } catch {
      throw new TestError("INTENT_STORAGE_ERROR");
    }
  }
  save() {
    try {
      this.storage.setItem(this.name, JSON.stringify(this.data));
    } catch {
      throw new TestError("INTENT_STORAGE_ERROR");
    }
  }
  conflict(task) {
    return Object.values(this.data.requests).find(
      (r) =>
        ["UNKNOWN", "SENDING", "ACCEPTED", "SUCCESS"].includes(r.state) &&
        r.date === task.date &&
        r.startHour < task.endHour &&
        r.endHour > task.startHour,
    );
  }
  prune(today) {
    for (const key of Object.keys(this.data.requests)) {
      if (key.slice(0, 10) < today) delete this.data.requests[key];
    }
  }
  intent(task, now) {
    const key = slotKey(task);
    const old = this.data.requests[key],
      next = this.data.nextWrite;
    this.data.nextWrite = now + WRITE_INTERVAL;
    this.data.requests[key] = publicDiagnostics({
      task,
      plannedAt: new Date(task.planned).toISOString(),
      state: "UNKNOWN",
      reason: "PENDING",
      attempts: null,
    });
    this.save();
    return () => {
      this.data.nextWrite = next;
      if (old) this.data.requests[key] = old;
      else delete this.data.requests[key];
      this.save();
    };
  }
  receipt(report) {
    this.data.requests[slotKey(report.task)] = publicDiagnostics(report);
    if (report.dispatchAt)
      this.data.nextWrite = Math.max(this.data.nextWrite, Date.parse(report.dispatchAt) + WRITE_INTERVAL);
    this.save();
  }
}

export function remember(report, storeName) {
  try {
    if (storeName) sessionStorage.setItem(LAST_ACCOUNT, storeName);
    sessionStorage.setItem(LAST_REPORT, JSON.stringify(publicDiagnostics(report)));
    return true;
  } catch {
    return false;
  }
}
export function recall() {
  let report = null;
  try {
    const raw = sessionStorage.getItem(LAST_REPORT);
    if (!raw) return null;
    report = restoredReport(JSON.parse(raw));
    const name = sessionStorage.getItem(LAST_ACCOUNT);
    if (/^hdu-p62:[a-f0-9]{64}$/.test(name)) {
      const stored = JSON.parse(localStorage.getItem(name))?.requests?.[slotKey(report.task)];
      if (stored?.plannedAt === report.plannedAt) report = restoredReport(stored);
    }
  } catch {
    /* Optional display history cannot cancel a fresh preparation. */
  }
  if (report && ["PREPARING", "WAITING"].includes(report.state)) {
    report.state = "IDLE";
    report.reason = "USER_STOPPED";
  }
  if (report?.state === "SENDING") {
    report.state = "UNKNOWN";
    report.reason = "PENDING";
  }
  if (report?.verification === "CHECKING") report.verification = "NONE";
  return report;
}
