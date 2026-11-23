import { check, TestError } from "../core.js";
import { accountKey } from "../ledger.js";
import { diagnostic, PACING_MS } from "./policy.js";

export async function accountName(uid) {
  return `hdu-v9:${await accountKey(uid)}`;
}

export function slotKey(task) {
  return [task.date, task.start, task.end].join("/");
}

// Only opened under the account's Web Lock. No waiting/preparation/stopped row is ever reserved.
export class Guard {
  constructor(name, today) {
    this.name = name;
    try {
      const raw = localStorage.getItem(name);
      this.data = raw === null ? { next: 0, limited: 0, slots: {} } : JSON.parse(raw);
      check(
        Number.isFinite(this.data.next) &&
          Number.isFinite(this.data.limited) &&
          this.data.slots &&
          typeof this.data.slots === "object",
        "GUARD_UNAVAILABLE",
      );
      for (const key of Object.keys(this.data.slots)) {
        if (key.slice(0, 10) < today) delete this.data.slots[key];
      }
    } catch {
      throw new TestError("GUARD_UNAVAILABLE");
    }
  }
  save() {
    try {
      localStorage.setItem(this.name, JSON.stringify(this.data));
    } catch {
      throw new TestError("GUARD_UNAVAILABLE");
    }
  }
  record(task, report, phase, supplemented) {
    this.data.slots[slotKey(task)] = { phase, supplemented, report: diagnostic(report) };
    this.save();
  }
  intent(task, report, supplemented) {
    const key = slotKey(task);
    const previous = this.data.slots[key];
    const previousNext = this.data.next;
    this.data.next = Date.now() + PACING_MS;
    this.record(
      task,
      { ...report, sends: null, state: "unknown", result: "PENDING" },
      "pending",
      supplemented,
    );
    return () => {
      this.data.next = previousNext;
      if (previous) this.data.slots[key] = previous;
      else delete this.data.slots[key];
      this.save();
    };
  }
}

export const LAST = "hdu-v9:last";
export function rememberGuard(name) {
  try {
    sessionStorage.setItem(`${LAST}-guard`, name);
  } catch {
    /* optional reload display */
  }
}
export function recall() {
  try {
    let data = diagnostic(JSON.parse(sessionStorage.getItem(LAST)) || { sends: 0 });
    // The durable intent can be newer than the tab log if navigation interrupted hand-off.
    const name = sessionStorage.getItem(`${LAST}-guard`);
    if (data.date && /^hdu-v9:[a-f0-9]{64}$/.test(name)) {
      const row = JSON.parse(localStorage.getItem(name))?.slots?.[slotKey(data)];
      if (row?.report?.plannedAt === data.plannedAt) data = diagnostic(row.report);
    }
    if (data.state === "sending") Object.assign(data, { state: "unknown", result: "PENDING" });
    if (data.verification === "checking") data.verification = "none";
    if (["preparing", "waiting"].includes(data.state))
      Object.assign(data, { state: "idle", result: "STOPPED" });
    return diagnostic(data);
  } catch {
    return diagnostic();
  }
}
export function remember(report) {
  try {
    sessionStorage.setItem(LAST, JSON.stringify(diagnostic(report)));
  } catch {
    /* diagnostics are optional */
  }
}
