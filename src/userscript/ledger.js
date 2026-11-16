import { check, TestError } from "./core.js";
// One permanent P5.1 write budget per account in THIS browser/origin. No reset/delete API.
export class Ledger {
  async open() {
    if (this.db) return this.db;
    check(globalThis.indexedDB, "STORAGE_UNAVAILABLE");
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("hdu-p51-single-write", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("attempts", { keyPath: "key" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = req.onblocked = () => reject(new TestError("STORAGE_UNAVAILABLE"));
    });
    this.db.onversionchange = () => {
      this.db.close();
      this.db = null;
    };
    return this.db;
  }
  async transaction(key, update) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      let result;
      const tx = db.transaction(
        "attempts",
        update ? "readwrite" : "readonly",
        update ? { durability: "strict" } : undefined,
      );
      const store = tx.objectStore("attempts");
      const request = store.get(key);
      request.onsuccess = () => {
        result = request.result || null;
        if (update) {
          const next = update(result);
          if (next) {
            store.put(next);
            result = next;
          }
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(new TestError("STORAGE_UNAVAILABLE"));
    });
  }
  get(key) {
    return this.transaction(key);
  }
  async claim(intent) {
    let won = false;
    const value = await this.transaction(intent.key, (old) => {
      if (old) return null;
      won = true;
      return intent;
    });
    return { won, value };
  }
  finish(key, ticket, result) {
    return this.transaction(key, (old) =>
      old?.ticket === ticket && old.state !== "SUCCESS" ? { ...old, ...result } : null,
    );
  }
}
export async function accountKey(uid) {
  check(globalThis.crypto?.subtle, "STORAGE_UNAVAILABLE");
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`HDU-P5.1:${uid}`));
  return [...new Uint8Array(hash)].map((v) => v.toString(16).padStart(2, "0")).join("");
}
