import { check, TestError } from "../core.js";
import { TASK_SUFFIX } from "./policy.js";

const PREFIX = `hdu-p53:${TASK_SUFFIX}:`;
export class FormalStore {
  constructor({ database = "hdu-p53-formal-booking", prefix = PREFIX } = {}) {
    this.database = database;
    this.prefix = prefix;
  }
  async open() {
    if (this.db) return this.db;
    check(globalThis.indexedDB && globalThis.localStorage, "STORAGE_UNAVAILABLE");
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(this.database, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("tasks", { keyPath: "key" });
        req.result.createObjectStore("meta");
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
  async probe() {
    const db = await this.open();
    // Separate metadata, never a booking budget and never deletes a task.
    const value = crypto.randomUUID();
    localStorage.setItem(`${this.prefix}probe`, value);
    check(localStorage.getItem(`${this.prefix}probe`) === value, "STORAGE_UNAVAILABLE");
    await new Promise((resolve, reject) => {
      const tx = db.transaction("meta", "readwrite", { durability: "strict" });
      tx.objectStore("meta").put(value, "probe");
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(new TestError("STORAGE_UNAVAILABLE"));
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("meta", "readonly"),
        req = tx.objectStore("meta").get("probe");
      req.onsuccess = () => (req.result === value ? resolve() : reject(new TestError("STORAGE_UNAVAILABLE")));
      tx.onerror = tx.onabort = () => reject(new TestError("STORAGE_UNAVAILABLE"));
    });
  }
  async transact(key, change) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      let result, failure;
      const tx = db.transaction(
        "tasks",
        change ? "readwrite" : "readonly",
        change ? { durability: "strict" } : undefined,
      );
      const store = tx.objectStore("tasks"),
        req = store.get(key);
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
  async reserve(row) {
    let won = false;
    const value = await this.transact(row.key, (old) => {
      if (old || this.stopped() || this.spent(row.key)) return null;
      won = true;
      return row;
    });
    if (won) localStorage.setItem(`${this.prefix}active`, "1");
    return { won, value };
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
    if (won) localStorage.setItem(`${this.prefix}spent:${key}`, "1");
    return { won, value };
  }
  finish(key, owner, patch) {
    return this.transact(key, (old) =>
      old?.owner === owner && old.state !== "SUCCESS" ? { ...old, ...patch } : null,
    );
  }
  async takeVerification(key, now) {
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
  active() {
    return localStorage.getItem(`${this.prefix}active`) === "1";
  }
  spent(key) {
    return localStorage.getItem(`${this.prefix}spent:${key}`) === "1";
  }
  stopped() {
    return localStorage.getItem(`${this.prefix}stop`) === "1";
  }
  stopSignal() {
    localStorage.setItem(`${this.prefix}stop`, "1");
  }
  stop(key) {
    return this.transact(key, (old) =>
      old && old.state !== "SUCCESS"
        ? {
            ...old,
            state: old.attempts ? "UNKNOWN" : "STOPPED",
            reason: "USER_STOPPED",
          }
        : null,
    );
  }
  // No version argument, no upgrades, no modifications to P5.2 history.
  async legacy(key) {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("hdu-p51-single-write");
      req.onupgradeneeded = () => req.transaction.abort();
      req.onerror = req.onblocked = () => reject(new TestError("P52_RECEIPT_REQUIRED"));
      req.onsuccess = () => resolve(req.result);
    });
    try {
      check(db.objectStoreNames.contains("attempts"), "P52_RECEIPT_REQUIRED");
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("attempts", "readonly"),
          req = tx.objectStore("attempts").get(key);
        req.onsuccess = () => resolve(req.result || null);
        tx.onerror = tx.onabort = () => reject(new TestError("STORAGE_UNAVAILABLE"));
      });
    } finally {
      db.close();
    }
  }
}
