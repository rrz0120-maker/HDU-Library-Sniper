import { check } from "../core.js";

// Cross-mode guard uniting P7.0 normal mode (hdu-p70-ipad-booking) and P7.1 scheduled mode (hdu-p71-ipad-scheduled).
// Never clears databases or resets attempt/verification counts.
export class CrossModeCoordinator {
  constructor() {
    this.normalStore = null;
    this.scheduledStore = null;
    this.normalEngine = null;
    this.scheduledEngine = null;
  }

  attachNormal(engine, store) {
    this.normalEngine = engine;
    this.normalStore = store;
  }

  attachScheduled(engine, store) {
    this.scheduledEngine = engine;
    this.scheduledStore = store;
  }

  async checkForScheduled(account) {
    if (this.normalEngine && (this.normalEngine.busy || this.normalEngine.state === "SUBMITTING")) {
      return { blockedByMode: "normal-p70", code: "CROSS_MODE_ACTIVE_TASK" };
    }
    if (this.normalStore && account) {
      const pending = await this.normalStore.pendingUnknown(account);
      if (pending) return { blockedByMode: "normal-p70", code: "CROSS_MODE_UNKNOWN" };
    }
    return null;
  }

  async checkForNormal(account, selection = null) {
    if (
      this.scheduledEngine &&
      (this.scheduledEngine.formal ||
        this.scheduledEngine.waiting ||
        this.scheduledEngine.busy ||
        ["PREPARING", "WAITING", "SUBMITTING", "VERIFYING"].includes(this.scheduledEngine.state))
    ) {
      return { blockedByMode: "scheduled-p71", code: "CROSS_MODE_ACTIVE_TASK" };
    }
    if (this.scheduledStore && account) {
      const pending = await this.scheduledStore.pendingUnknown(account);
      if (pending) return { blockedByMode: "scheduled-p71", code: "CROSS_MODE_UNKNOWN" };
      if (selection?.date) {
        const rows = await this.scheduledStore.list(account);
        const activeOnDate = rows.find(
          (r) => r.target?.date === selection.date && ["WAITING", "UNKNOWN"].includes(r.state),
        );
        if (activeOnDate) return { blockedByMode: "scheduled-p71", code: "CROSS_MODE_CONFLICT" };
      }
    }
    return null;
  }

  async assertAllowedForScheduled(account) {
    const conflict = await this.checkForScheduled(account);
    check(!conflict, conflict?.code || "CROSS_MODE_CONFLICT");
  }

  async assertAllowedForNormal(account, selection = null) {
    const conflict = await this.checkForNormal(account, selection);
    check(!conflict, conflict?.code || "CROSS_MODE_CONFLICT");
  }
}
