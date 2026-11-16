import { TestError } from "../../src/userscript/core.js";
import { TASK, RECORD_PATH } from "../../src/userscript/p53/policy.js";
export const rawRange = () => ({
  advance_date: 1794844800,
  max_date: 1795017600,
  minBeginTime: 7,
  maxEndTime: 22,
  min_duration: 1,
  max_duration: 15,
  max_num: 4,
});
export const mapBody = () => ({
  allContent: {
    children: [
      {},
      {},
      {
        children: {
          children: [
            {
              roomName: TASK.room,
              seatMap: { info: { id: TASK.floorId }, POIs: [{ title: "162", id: "62726", state: "1" }] },
            },
          ],
        },
      },
    ],
  },
});
export const legacy = () => ({
  attempts: 1,
  state: "SUCCESS",
  recordVerified: true,
  mapping: {
    floorId: 1558,
    room: TASK.room,
    seats: [
      { number: "162", id: "62726" },
      { number: "157", id: "62721" },
    ],
  },
  selection: { date: "2026-11-17", hour: 10, hours: 1, seat: "157" },
});
export const validRecord = () => ({
  status: 0,
  time: TASK.begin,
  duration: 50400,
  seatNum: "162",
  roomName: TASK.room,
});

export class MemoryStore {
  constructor() {
    this.rows = new Map();
    this.receipt = legacy();
    this.stopFlag = false;
    this.activeFlag = false;
    this.spentKeys = new Set();
  }
  async probe() {}
  async legacy() {
    return structuredClone(this.receipt);
  }
  async get(key) {
    return structuredClone(this.rows.get(key) || null);
  }
  stopped() {
    return this.stopFlag;
  }
  active() {
    return this.activeFlag;
  }
  spent(key) {
    return this.spentKeys.has(key);
  }
  stopSignal() {
    this.stopFlag = true;
  }
  async reserve(row) {
    const old = this.rows.get(row.key);
    if (old || this.stopFlag || this.spent(row.key)) return { won: false, value: old };
    this.rows.set(row.key, structuredClone(row));
    this.activeFlag = true;
    return { won: true, value: row };
  }
  async claim(key, owner, at) {
    const row = this.rows.get(key);
    if (
      !row ||
      row.owner !== owner ||
      row.state !== "WAITING" ||
      row.attempts !== 0 ||
      this.stopFlag ||
      this.spent(key)
    )
      return { won: false, value: row };
    Object.assign(row, { state: "UNKNOWN", reason: "WRITE_INTENT_PERSISTED", attempts: 1, intentAt: at });
    this.spentKeys.add(key);
    return { won: true, value: row };
  }
  async finish(key, owner, patch) {
    const row = this.rows.get(key);
    if (row?.owner === owner && row.state !== "SUCCESS") Object.assign(row, structuredClone(patch));
    return row;
  }
  async stop(key) {
    const row = this.rows.get(key);
    if (row && row.state !== "SUCCESS")
      Object.assign(row, { state: row.attempts ? "UNKNOWN" : "STOPPED", reason: "USER_STOPPED" });
    return row;
  }
  async takeVerification(key, at) {
    const row = this.rows.get(key);
    if (
      !row ||
      row.state === "SUCCESS" ||
      row.attempts !== 1 ||
      row.verifications >= 3 ||
      at - (row.lastVerification || 0) < 2000
    )
      return false;
    row.verifications++;
    row.lastVerification = at;
    return true;
  }
}
export class FakeIO {
  constructor(clock) {
    this.clock = clock;
    this.requests = [];
    this.writes = [];
    this.response = { CODE: "ok", DATA: { result: "success" } };
    this.record = true;
    this.existing = [];
  }
  async request(path, options = {}) {
    this.requests.push({ path, write: !!options.write });
    options.onHeaders?.({
      date: new Date(this.clock.wall).toUTCString(),
      age: null,
      sentMono: this.clock.mono,
      receivedMono: this.clock.mono,
      receivedWall: this.clock.wall,
    });
    if (options.write) {
      options.onDispatch?.(new Date(this.clock.wall).toISOString());
      this.writes.push(options);
      if (this.onWrite) await this.onWrite();
      if (this.failure) throw new TestError(this.failure);
      return {
        body: this.response,
        timing: { dispatchAt: new Date(this.clock.wall).toISOString(), dispatchToHeadersMs: 30 },
      };
    }
    if (path === "/User/Center/baseInfo")
      return { body: { DATA: { is_login: !this.authFailed, uid: "9876543210" } } };
    if (path.startsWith("/Space/Category"))
      return {
        body: {
          content: {
            defaultItems: [
              {
                name: "自习室",
                link: "/Seat/Index/searchSeats?space_category[category_id]=3&space_category[content_id]=93",
              },
            ],
          },
        },
      };
    if (path === RECORD_PATH)
      return {
        body: {
          content: { defaultItems: this.writes.length && this.record ? [validRecord()] : this.existing },
        },
      };
    if (options.form) return { body: this.mapping || mapBody() };
    return {
      body: {
        data: { range: this.range || rawRange(), space_category: { category_id: "3", content_id: "93" } },
      },
    };
  }
}
