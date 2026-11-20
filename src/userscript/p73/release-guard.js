import { check, responseCode, TestError } from "../core.js";
import { IpadBookingEngine } from "../p70/engine.js";
import { CrossModeCoordinator } from "../p71/coordinator.js";

export function releaseResponseCode(body) {
  const code = responseCode(body);
  if (body?.CODE === "LIMITED") return "LIMITED";
  if (code !== "NOT_OPEN" && (code !== "RESPONSE_UNKNOWN" || body?.CODE !== "ParamError")) return code;
  const text = body?.DATA?.msg || body?.MESSAGE;
  return /未到(?:预约|开放)时间|(?:预约日期|预约时间)(?:尚)?未开放|超出可预约座位时间范围/.test(String(text))
    ? "NOT_OPEN"
    : "RESPONSE_UNKNOWN";
}

export function checkReleaseRead(path, body) {
  check(releaseResponseCode(body) !== "LIMITED", "LIMITED");
  if (path.split("?")[0] === "/Seat/Index/myBookingList") {
    check(body?.CODE === undefined || body.CODE === "ok", "RECORDS_UNKNOWN");
  }
}

function overlapsConfirmed(row, target) {
  if (row.state !== "SUCCESS" || row.recordVerified !== true || row.target?.date !== target.date)
    return false;
  const bounds = (slot) => [slot.startHour ?? slot.hour, slot.endHour ?? slot.hour + (slot.hours ?? 1)];
  const [a, b] = bounds(row.target);
  const [x, y] = bounds(target);
  return a < y && x < b;
}

export class ReleaseCoordinator extends CrossModeCoordinator {
  constructor(locks = globalThis.navigator?.locks) {
    super();
    this.locks = locks;
    this.limited = false;
  }

  async withCommit(run) {
    check(this.locks?.request, "CROSS_MODE_LOCK_UNAVAILABLE");
    return this.locks.request("hdu-ipad-booking-commit", { ifAvailable: true }, (lock) => {
      check(lock, "CROSS_MODE_ACTIVE_TASK");
      check(!this.limited, "LIMITED");
      return run();
    });
  }

  async checkForScheduled(account, task) {
    const conflict = await super.checkForScheduled(account);
    if (conflict || !task) return conflict;
    if (await this.scheduledStore.pendingUnknown(account))
      return { blockedByMode: "scheduled-p71", code: "PREVIOUS_UNKNOWN" };
    const normal = await this.normalStore.list(account);
    const scheduled = await this.scheduledStore.list(account);
    if ([...normal, ...scheduled].some((row) => overlapsConfirmed(row, task)))
      return { blockedByMode: "other-booking", code: "EXISTING" };
    return null;
  }

  async checkForNormal(account, target) {
    const conflict = await super.checkForNormal(account, target);
    if (conflict || !target) return conflict;
    const normal = await this.normalStore.list(account);
    const scheduled = await this.scheduledStore.list(account);
    if ([...normal, ...scheduled].some((row) => overlapsConfirmed(row, target)))
      return { blockedByMode: "other-booking", code: "EXISTING" };
    return null;
  }
}

export class ReleaseNormalEngine extends IpadBookingEngine {
  constructor(io, ...args) {
    super(
      {
        clockValid: () => io.clockValid(),
        async request(path, options) {
          const response = await io.request(path, options);
          if (options?.write) {
            const code = releaseResponseCode(response.body);
            if (code !== responseCode(response.body)) {
              const error = new TestError(code);
              error.timing = response.timing;
              throw error;
            }
          }
          return response;
        },
      },
      ...args,
    );
  }

  async read(path, generation, form) {
    check(!this.coordinator.limited, "LIMITED");
    try {
      const body = await super.read(path, generation, form);
      checkReleaseRead(path, body);
      return body;
    } catch (error) {
      if (error.code === "LIMITED") this.coordinator.limited = true;
      throw error;
    }
  }

  async confirm(ticket, options) {
    try {
      const row = await this.coordinator.withCommit(() => super.confirm(ticket, options));
      if (row?.reason === "LIMITED") this.coordinator.limited = true;
      return row;
    } catch (error) {
      this.preview = null;
      throw error;
    }
  }
}
