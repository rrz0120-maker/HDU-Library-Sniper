import { check, TestError } from "../core.js";
import { safeRandomId } from "../p70/policy.js";
import { mergeP71Diagnostics, P71_FIRST_FIELDS, p71Pending, P71_VERSION } from "./policy.js";

// Dedicated iPad P7.1 scheduled database. Completely isolated from phone DBs and P7.0 normal booking DB.
export class ScheduledIpadStore {
  constructor(task, { database = "hdu-p71-ipad-scheduled" } = {}) {
    this.database = database;
    this.task = task;
    this.db = null;
    this.account = null;
    this.control = `hdu-p71-control:${task.day}:`;
    this.prefix = `hdu-p71:probe:${task.date}:`;
  }

  bind(account) {
    this.account = account;
    this.prefix = `hdu-p71:${account}:${this.task.date}:`;
  }

  async open() {
    if (this.db) return this.db;
    check(globalThis.indexedDB && globalThis.localStorage, "STORAGE_UNAVAILABLE");
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(this.database, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains("tasks"))
          req.result.createObjectStore("tasks", { keyPath: "key" });
        if (!req.result.objectStoreNames.contains("meta")) req.result.createObjectStore("meta");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = req.onblocked = () => reject(new TestError("STORAGE_UNAVAILABLE"));
    });
    this.db.onversionchange = () => {
      this.db.close();
      this.db = null;
    };
    return this.db;
  }

  // Safari <16.4 durability options fallback
  openTx(db, storeName, mode) {
    if (mode !== "readwrite") return db.transaction(storeName, mode);
    try {
      return db.transaction(storeName, "readwrite", { durability: "strict" });
    } catch (e) {
      if (e instanceof TypeError) return db.transaction(storeName, "readwrite");
      throw e;
    }
  }

  async probe() {
    const db = await this.open();
    const value = safeRandomId();
    try {
      localStorage.setItem(`${this.prefix}probe`, value);
      check(localStorage.getItem(`${this.prefix}probe`) === value, "STORAGE_UNAVAILABLE");
    } catch {
      throw new TestError("STORAGE_UNAVAILABLE");
    }
    await new Promise((resolve, reject) => {
      const tx = this.openTx(db, "meta", "readwrite");
      tx.objectStore("meta").put(value, "probe");
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(new TestError("STORAGE_UNAVAILABLE"));
    });
    await new Promise((resolve, reject) => {
      const tx = this.openTx(db, "meta", "readonly");
      const req = tx.objectStore("meta").get("probe");
      req.onsuccess = () =>
        req.result === value ? resolve() : reject(new TestError("STORAGE_UNAVAILABLE"));
      tx.onerror = tx.onabort = () => reject(new TestError("STORAGE_UNAVAILABLE"));
    });
  }

  activateDay() {
    try {
      localStorage.setItem(`${this.control}active`, "1");
    } catch {
      /* handled by probe */
    }
  }

  active() {
    try {
      return (
        localStorage.getItem(`${this.prefix}active`) === "1" ||
        localStorage.getItem(`${this.control}active`) === "1"
      );
    } catch {
      return false;
    }
  }

  stopped() {
    try {
      return (
        localStorage.getItem(`${this.prefix}stop`) === "1" ||
        localStorage.getItem(`${this.control}stop`) === "1"
      );
    } catch {
      return true;
    }
  }

  stopSignal() {
    try {
      localStorage.setItem(`${this.control}stop`, "1");
      if (this.account) localStorage.setItem(`${this.prefix}stop`, "1");
    } catch {
      /* handled by probe */
    }
  }

  spent(key) {
    try {
      return localStorage.getItem(`${this.prefix}spent:${key}`) === "1";
    } catch {
      return true;
    }
  }

  async transact(key, change) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      let result = null;
      let failure = null;
      const tx = this.openTx(db, "tasks", change ? "readwrite" : "readonly");
      const store = tx.objectStore("tasks");
      const req = store.get(key);
      req.onsuccess = () => {
        result = req.result || null;
        if (!change) return;
        try {
          const next = change(result);
          if (next) {
            store.put(next);
            result = next;
          }
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(failure || new TestError("STORAGE_UNAVAILABLE"));
    });
  }

  get(key) {
    return this.transact(key);
  }

  async list(account = this.account) {
    if (!account) return [];
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.openTx(db, "tasks", "readonly");
      const req = tx.objectStore("tasks").getAll();
      req.onsuccess = () => resolve(req.result.filter((r) => r.key.startsWith(`${account}:`)));
      tx.onerror = tx.onabort = () => reject(new TestError("STORAGE_UNAVAILABLE"));
    });
  }

  async pendingUnknown(account = this.account, excludeKey = null) {
    const rows = await this.list(account);
    return rows.find((r) => r.key !== excludeKey && p71Pending(r)) || null;
  }

  async reserve(row) {
    check(this.account && row.key.startsWith(`${this.account}:`), "IDENTITY_CHANGED");
    const db = await this.open();
    return new Promise((resolve, reject) => {
      let won = false;
      let value = null;
      let failure = null;
      const tx = this.openTx(db, "tasks", "readwrite");
      const store = tx.objectStore("tasks");
      const req = store.getAll();
      req.onsuccess = () => {
        try {
          const accountRows = req.result.filter((r) => r.key.startsWith(`${this.account}:`));
          check(!accountRows.some((r) => r.key !== row.key && p71Pending(r)), "PREVIOUS_UNKNOWN");
          value = accountRows.find((r) => r.key === row.key) || null;
          if (value || this.stopped() || this.spent(row.key)) return;
          won = true;
          value = mergeP71Diagnostics({ ...row, version: P71_VERSION }, row.timings);
          store.put(value);
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => {
        try {
          if (won) localStorage.setItem(`${this.prefix}active`, "1");
          resolve({ won, value });
        } catch {
          reject(new TestError("STORAGE_UNAVAILABLE"));
        }
      };
      tx.onerror = tx.onabort = () => reject(failure || new TestError("STORAGE_UNAVAILABLE"));
    });
  }

  async claim(key, owner, at) {
    let won = false;
    const value = await this.transact(key, (old) => {
      if (
        !old ||
        old.owner !== owner ||
        old.state !== "WAITING" ||
        old.attempts !== 0 ||
        this.stopped() ||
        this.spent(key)
      )
        return null;
      won = true;
      return { ...old, state: "UNKNOWN", reason: "WRITE_INTENT_PERSISTED", attempts: 1, intentAt: at };
    });
    if (won) {
      try {
        localStorage.setItem(`${this.prefix}spent:${key}`, "1");
      } catch {
        throw new TestError("STORAGE_UNAVAILABLE");
      }
    }
    return { won, value };
  }

  finish(key, owner, patch) {
    return this.transact(key, (old) => {
      if (!old || old.owner !== owner) return null;
      const terminal =
        old.state === "SUCCESS" ||
        (old.state === "FAILED" && !(patch.state === "SUCCESS" && patch.recordVerified === true));
      const next = terminal ? { ...old } : { ...old, ...patch };
      const d = mergeP71Diagnostics(old, { ...patch.timings, ...patch });
      for (const field of [...P71_FIRST_FIELDS, "lastReviewedAt"]) {
        if (d[field] !== undefined) next[field] = d[field];
      }
      next.timings = mergeP71Diagnostics(old.timings || {}, patch.timings || {});
      return next;
    });
  }

  // Preserves terminal SUCCESS and FAILED states (P6.1 rule).
  stop(key, reason = "USER_STOPPED") {
    return this.transact(key, (old) =>
      old && !["SUCCESS", "FAILED"].includes(old.state)
        ? { ...old, state: old.attempts ? "UNKNOWN" : "STOPPED", reason }
        : null,
    );
  }

  async takeVerification(key, now = Date.now()) {
    let won = false;
    await this.transact(key, (old) => {
      if (
        !old ||
        old.state === "SUCCESS" ||
        old.attempts !== 1 ||
        (old.verifications || 0) >= 3 ||
        now - (old.lastVerification || 0) < 2000
      )
        return null;
      won = true;
      return { ...old, verifications: (old.verifications || 0) + 1, lastVerification: now };
    });
    return won;
  }

  note(key, diagnostics, logs) {
    return this.transact(key, (old) =>
      old
        ? {
            ...mergeP71Diagnostics(old, diagnostics),
            timings: mergeP71Diagnostics(old.timings || {}, diagnostics),
            logs: logs?.slice(-60) || old.logs,
          }
        : null,
    );
  }
}
