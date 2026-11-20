import { ORIGIN, codeOf } from "../core.js";
import { Transport } from "../transport.js";
import { IpadStore } from "../p70/store.js";
import { ReleaseCoordinator, ReleaseNormalEngine } from "./release-guard.js";
import { scheduledTask } from "../p71/policy.js";
import { ScheduledIpadStore } from "../p71/store.js";
import { PerformanceScheduledEngine } from "./engine.js";
import { mountP73Panel } from "./panel.js";

function bootIpadP73() {
  if (
    location.origin !== ORIGIN ||
    window.top !== window.self ||
    window.__HDU_P73_MOUNTED__ ||
    document.getElementById("hdu-p71-host")
  )
    return;
  window.__HDU_P73_MOUNTED__ = true;

  let startHour = 8;
  let endHour = 22;
  let current = null;
  let panel = null;

  const sessionStaticCache = { roomQueryEntry: null, mappingEntry: null };
  const coordinator = new ReleaseCoordinator();

  const normalStore = new IpadStore();
  const normalEngine = new ReleaseNormalEngine(new Transport(), normalStore, () => {}, { coordinator });
  coordinator.attachNormal(normalEngine, normalStore);

  const createScheduled = (task) => {
    const store = new ScheduledIpadStore(task);
    const engine = new PerformanceScheduledEngine(
      new Transport(),
      store,
      (v) => {
        if (engine === current) panel?.renderScheduled(v);
      },
      { task, staticCache: sessionStaticCache, coordinator },
    );
    coordinator.attachScheduled(engine, store);
    return engine;
  };

  function dayCheck(forceRecreate = false) {
    const task = scheduledTask(Date.now(), startHour, endHour);
    if (!forceRecreate && current?.task.day === task.day) return false;
    if (current?.formal) void current.suspend("AUTHORIZATION_EXPIRED");
    current = createScheduled(task);
    panel?.newDay(task);
    panel?.renderScheduled(current.view());
    return true;
  }

  const runSafe = async (fn) => {
    try {
      await fn();
    } catch (e) {
      current?.emit(current.attempted ? "UNKNOWN" : "STOPPED", codeOf(e));
    }
  };

  panel = mountP73Panel(
    {
      updateHours: (s, e) => {
        if (current?.formal || current?.busy || current?.waiting) return;
        if (Number.isInteger(s) && Number.isInteger(e) && s >= 0 && e <= 24 && s < e) {
          startHour = s;
          endHour = e;
          dayCheck(true);
        }
      },
      start: (arm, authorizedDay, s, e) =>
        runSafe(async () => {
          if (dayCheck()) return;
          if (!current.formal && !current.busy && !current.waiting && (s !== startHour || e !== endHour)) {
            if (!(Number.isInteger(s) && Number.isInteger(e) && s >= 0 && e <= 24 && s < e)) {
              current.emit("STOPPED", "INVALID_DURATION");
              return;
            }
            startHour = s;
            endHour = e;
            dayCheck(true);
          }
          await current.prepare({ arm, confirmed: arm, authorizedDay });
        }),
      stop: () => runSafe(() => current.suspend("USER_STOPPED")),
      review: () => runSafe(() => current.review()),
      exportSched: () => current.diagnosticExport(),
      onUiSuppressed: () => current?.noteUiSuppressed?.(),
    },
    normalEngine,
  );

  dayCheck(true);

  const suspendAll = (code = "FOREGROUND_REQUIRED") => {
    if (current?.formal || current?.waiting) void current.suspend(code);
    normalEngine.suspend(code);
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") suspendAll("FOREGROUND_REQUIRED");
    else dayCheck();
  });
  document.addEventListener("freeze", () => suspendAll("FOREGROUND_REQUIRED"));
  window.addEventListener("pagehide", () => suspendAll("FOREGROUND_REQUIRED"));
  window.addEventListener("storage", (event) => {
    if (current?.formal && current.store.stopped()) void current.suspend("USER_STOPPED");
    if (event.key === "hdu-p70:stop") normalEngine.suspend("STOPPED");
  });

  // Adaptive timer: 250ms idle -> 50ms within 5s of 20:00 -> 20ms within 1.5s of 20:00 / open confirmation.
  const loop = () => {
    dayCheck();
    const now = Date.now();
    if (current && !current.formal && current.state === "IDLE" && now >= current.task.open) {
      current.emit("EXPIRED", "PREPARE_WINDOW");
    }
    if (current) {
      panel.clock(current.task, now);
      void current.tick();
    }
    const toOpen = current ? current.task.open - now : Infinity;
    const interval = current?.waiting ? (toOpen <= 1500 ? 20 : toOpen <= 5000 ? 50 : 250) : 250;
    setTimeout(loop, interval);
  };
  loop();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootIpadP73, { once: true });
} else {
  bootIpadP73();
}
