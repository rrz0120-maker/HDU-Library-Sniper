import { check, TestError } from "../core.js";
import { p70Pending, safeRandomId } from "./policy.js";

// Dedicated iPad Phase 1 database. Never touches or fabricates P5.1/P5.3/P6.0/P6.1 legacy records.
export class IpadStore {
  constructor({ database = "hdu-p70-ipad-booking", prefix = "hdu-p70:" } = {}) {
    this.database = database;
    this.prefix = prefix;
    this.db = null;
    this.account = null;
  }

  bind(account) {
    this.account = account;
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

  // Safari <16.4 and some WebKit builds reject the durability options bag with TypeError.
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

  async pendingUnknown(account = this.account) {
    const rows = await this.list(account);
    return rows.find(p70Pending) || null;
  }

  spent(key) {
    try {
      return localStorage.getItem(`${this.prefix}spent:${key}`) === "1";
    } catch {
      return true;
    }
  }

  stopSignal() {
    try {
      localStorage.setItem(`${this.prefix}stop`, String(Date.now()));
    } catch {
      /* Storage error handled by probe/claim */
    }
  }

  async claim(intent) {
    check(this.account && intent.key.startsWith(`${this.account}:`), "IDENTITY_CHANGED");
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
          check(!accountRows.some(p70Pending), "PREVIOUS_UNKNOWN");
          value = accountRows.find((r) => r.key === intent.key) || null;
          if (value || this.spent(intent.key)) return;
          won = true;
          value = { ...intent, attempts: 1, verifications: 0 };
          store.put(value);
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => {
        try {
          if (won) localStorage.setItem(`${this.prefix}spent:${intent.key}`, "1");
          resolve({ won, value });
        } catch {
          reject(new TestError("STORAGE_UNAVAILABLE"));
        }
      };
      tx.onerror = tx.onabort = () => reject(failure || new TestError("STORAGE_UNAVAILABLE"));
    });
  }

  finish(key, ticket, patch) {
    return this.transact(key, (old) => {
      if (!old || old.ticket !== ticket) return null;
      const terminal =
        old.state === "SUCCESS" ||
        (old.state === "FAILED" && !(patch.state === "SUCCESS" && patch.recordVerified === true));
      if (terminal) return old;
      return { ...old, ...patch, timings: { ...(old.timings || {}), ...(patch.timings || {}) } };
    });
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

  noteReview(key, at, logs) {
    return this.transact(key, (old) =>
      old ? { ...old, lastReviewedAt: at, logs: logs?.slice(-50) || old.logs } : null,
    );
  }
}
