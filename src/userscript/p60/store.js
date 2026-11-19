import { check, TestError } from "../core.js";
import { FormalStore } from "../p53/store.js";
import { TASK as P53_TASK } from "../p53/policy.js";
import { canReconcileNotOpen, FIRST_FIELDS, isP53Slot, mergeDiagnostics, pending, suffix } from "./policy.js";

async function oldRows(database, store) {
  let absent = false;
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(database); // read-only existing schema; abort creation
    req.onupgradeneeded = () => {
      absent = true;
      req.transaction.abort();
    };
    req.onerror = () => (absent ? resolve(null) : reject(new TestError("LEGACY_STORAGE_UNKNOWN")));
    req.onblocked = () => reject(new TestError("LEGACY_STORAGE_UNKNOWN"));
    req.onsuccess = () => resolve(req.result);
  });
  if (!db) return [];
  try {
    check(db.objectStoreNames.contains(store), "LEGACY_STORAGE_UNKNOWN");
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readonly"),
        req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(new TestError("LEGACY_STORAGE_UNKNOWN"));
    });
  } finally {
    db.close();
  }
}
export class DailyStore extends FormalStore {
  constructor(task) {
    super({ database: "hdu-p60-daily-booking", prefix: `hdu-p60:probe:${suffix(task)}:` });
    this.task = task;
    this.control = `hdu-p60-control:${task.day}:`;
  }
  activateDay() {
    localStorage.setItem(`${this.control}active`, "1");
  }
  active() {
    return super.active() || localStorage.getItem(`${this.control}active`) === "1";
  }
  stopped() {
    return super.stopped() || localStorage.getItem(`${this.control}stop`) === "1";
  }
  stopSignal() {
    localStorage.setItem(`${this.control}stop`, "1");
    if (this.account) super.stopSignal();
  }
  async activeTask() {
    const key = localStorage.getItem(`${this.control}task`);
    return key ? this.get(key) : null;
  }
  bind(account) {
    this.account = account;
    this.prefix = `hdu-p60:${account}:${suffix(this.task)}:`;
  }
  async list() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("tasks", "readonly"),
        req = tx.objectStore("tasks").getAll();
      req.onsuccess = () => resolve(req.result.filter((r) => r.key.startsWith(`${this.account}:`)));
      tx.onerror = tx.onabort = () => reject(new TestError("STORAGE_UNAVAILABLE"));
    });
  }
  async legacy(account) {
    this.bind(account);
    const p52 = await super.legacy(account);
    const p53 = (await oldRows("hdu-p53-formal-booking", "tasks")).filter((r) =>
      r.key.startsWith(`${account}:`),
    );
    const key = `${account}:${suffix(P53_TASK)}`;
    const spent = localStorage.getItem(`hdu-p53:${suffix(P53_TASK)}:spent:${key}`) === "1";
    check(!spent || p53.some((r) => r.key === key), "LEGACY_UNKNOWN");
    // P5.3 stores definite refusals as FAILED; any UNKNOWN remains unresolved.
    check(!p53.some(pending), "LEGACY_UNKNOWN");
    check(
      !(await this.list()).some((r) => pending(r) && r.key !== `${account}:${suffix(this.task)}`),
      "PREVIOUS_UNKNOWN",
    );
    return p52;
  }
  async reserve(row) {
    check(this.account && row.key.startsWith(`${this.account}:`), "IDENTITY_CHANGED");
    check(!isP53Slot(this.task), "P53_SLOT_FROZEN");
    // Serialize account-wide unresolved checking with task reservation. Different
    // days are independent, but an unresolved submission cannot silently expire.
    const db = await this.open();
    return new Promise((resolve, reject) => {
      let won = false,
        value = null,
        failure;
      const tx = db.transaction("tasks", "readwrite", { durability: "strict" }),
        store = tx.objectStore("tasks");
      const req = store.getAll();
      req.onsuccess = () => {
        try {
          value = req.result.find((r) => r.key === row.key) || null;
          check(
            !req.result.some((r) => r.key.startsWith(`${this.account}:`) && r.key !== row.key && pending(r)),
            "PREVIOUS_UNKNOWN",
          );
          if (value || this.stopped() || this.spent(row.key)) return;
          won = true;
          value = mergeDiagnostics({ ...row, version: "6.1.0" }, row.timings);
          store.put(value);
        } catch (e) {
          failure = e;
          tx.abort();
        }
      };
      tx.oncomplete = () => {
        try {
          if (won) {
            localStorage.setItem(`${this.prefix}active`, "1");
            localStorage.setItem(`${this.control}task`, row.key);
          }
          resolve({ won, value });
        } catch {
          reject(new TestError("STORAGE_UNAVAILABLE"));
        }
      };
      tx.onerror = tx.onabort = () => reject(failure || new TestError("STORAGE_UNAVAILABLE"));
    });
  }
  finish(key, owner, patch) {
    return this.transact(key, (old) => {
      if (!old || old.owner !== owner) return null;
      const terminal =
        old.state === "SUCCESS" ||
        (old.state === "FAILED" && !(patch.state === "SUCCESS" && patch.recordVerified === true));
      const next = terminal ? { ...old } : { ...old, ...patch };
      const d = mergeDiagnostics(old, { ...patch.timings, ...patch });
      for (const field of [...FIRST_FIELDS, "lastReviewedAt", "uiFeedback"])
        if (d[field] !== undefined) next[field] = d[field];
      // First metric values in exported flat fields and nested legacy-compatible timings agree.
      next.timings = mergeDiagnostics(old.timings || {}, patch.timings || {});
      return next;
    });
  }
  stop(key, reason = "USER_STOPPED") {
    return this.transact(key, (old) =>
      old && !["SUCCESS", "FAILED"].includes(old.state)
        ? { ...old, state: old.attempts ? "UNKNOWN" : "STOPPED", reason }
        : null,
    );
  }
  // Only invoked by explicit review with a fresh successful official absence check.
  reconcileNotOpen(key, at) {
    check(this.account && key.startsWith(`${this.account}:`), "IDENTITY_CHANGED");
    return this.transact(key, (old) =>
      canReconcileNotOpen(old) ? { ...old, state: "FAILED", reason: "NOT_OPEN", reconciledAt: at } : null,
    );
  }
  note(key, diagnostics, logs) {
    return this.transact(key, (old) =>
      old
        ? {
            ...mergeDiagnostics(old, diagnostics),
            timings: mergeDiagnostics(old.timings || {}, diagnostics),
            logs: logs?.slice(-60) || old.logs,
          }
        : null,
    );
  }
}
