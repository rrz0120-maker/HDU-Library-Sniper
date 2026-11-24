import { Guard as V9Guard, slotKey, LAST } from "../v9/guard.js";
import { diagnostic } from "./policy.js";
export { accountName, slotKey } from "../v9/guard.js";

// Same lock and intent ledger as V9, including the rollback path.
export class Guard extends V9Guard {
  record(task, report, phase, supplemented) {
    this.data.slots[slotKey(task)] = { phase, supplemented, report: diagnostic(report) };
    this.save();
  }
}

const prefix = "hdu-v10:history:";
function keys() {
  return Object.keys(localStorage)
    .filter((k) => k.startsWith(prefix))
    .sort()
    .reverse();
}
function historyKey(r) {
  return `${prefix}${r.prepareStartedAt}/${r.runId}`;
}
export function history() {
  return keys()
    .map((k) => diagnostic(JSON.parse(localStorage.getItem(k))))
    .filter((r) => r.runId);
}
export function clearHistory() {
  for (const key of keys()) localStorage.removeItem(key);
}
export function archive(r) {
  if (!r.runId) return;
  // One key per run avoids cross-tab read/modify/write loss. Prune only on insert.
  const key = historyKey(r);
  const fresh = localStorage.getItem(key) === null;
  r.storageStatus = r.storageStatus === "ERROR" ? "ERROR" : "SAVED";
  const snapshot = r.state === "sending" ? { ...r, state: "unknown", result: "PENDING" } : r;
  localStorage.setItem(key, JSON.stringify(diagnostic(snapshot)));
  if (fresh) for (const old of keys().slice(30)) localStorage.removeItem(old);
}
export function recall() {
  let r = diagnostic({ sends: 0 });
  try {
    const raw = sessionStorage.getItem(LAST);
    if (raw) r = diagnostic(JSON.parse(raw));
    const name = sessionStorage.getItem(`${LAST}-guard`);
    if (
      r.date &&
      /^hdu-v9:[a-f0-9]{64}$/.test(name) &&
      ["sending", "waiting", "preparing", "unknown", "accepted"].includes(r.state)
    ) {
      const row = JSON.parse(localStorage.getItem(name))?.slots?.[slotKey(r)];
      if (row?.report?.plannedAt === r.plannedAt && (!r.runId || row.report.runId === r.runId))
        r = diagnostic(row.report);
    }
    if (r.state === "sending") Object.assign(r, { state: "unknown", result: "PENDING" });
    if (["waiting", "preparing"].includes(r.state))
      Object.assign(r, { state: "ended", result: "INTERRUPTED" });
    if (r.verification === "checking") r.verification = "none";
  } catch {
    r.storageStatus = "ERROR";
  }
  if (!r.date) {
    try {
      const previous = history()[0];
      if (previous) {
        if (r.storageStatus === "ERROR") previous.storageStatus = "ERROR";
        return previous;
      }
    } catch {
      r.storageStatus = "ERROR";
    }
  }
  return diagnostic(r);
}
export function remember(r, name) {
  try {
    if (name) sessionStorage.setItem(`${LAST}-guard`, name);
    sessionStorage.setItem(LAST, JSON.stringify(diagnostic(r)));
  } catch {
    r.storageStatus = "ERROR";
  }
}
