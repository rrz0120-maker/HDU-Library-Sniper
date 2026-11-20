import { ORIGIN, codeOf } from "../core.js";
import { Transport } from "../transport.js";
import { IpadStore } from "../p70/store.js";
import { IpadBookingEngine } from "../p70/engine.js";
import { CrossModeCoordinator } from "./coordinator.js";
import { scheduledTask } from "./policy.js";
import { ScheduledIpadStore } from "./store.js";
import { ScheduledIpadEngine } from "./engine.js";
import { mountP71Panel } from "./panel.js";

function bootIpadP71() {
  if (
    location.origin !== ORIGIN ||
    window.top !== window.self ||
    window.__HDU_P71_MOUNTED__ ||
    document.getElementById("hdu-p71-host")
  )
    return;
  window.__HDU_P71_MOUNTED__ = true;

  let startHour = 8;
  let endHour = 22;
  let current = null;
  let panel = null;

  // Shared session-scoped static cache and cross-mode mutual exclusion coordinator.
  const sessionStaticCache = { roomQueryEntry: null, mappingEntry: null };
  const coordinator = new CrossModeCoordinator();

  const normalStore = new IpadStore();
  const normalEngine = new IpadBookingEngine(new Transport(), normalStore, () => {}, { coordinator });
  coordinator.attachNormal(normalEngine, normalStore);

  const createScheduled = (task) => {
    const store = new ScheduledIpadStore(task);
    const engine = new ScheduledIpadEngine(
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

  panel = mountP71Panel(
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

  const loop = () => {
    dayCheck();
    if (current && !current.formal && current.state === "IDLE" && Date.now() >= current.task.open) {
      current.emit("EXPIRED", "PREPARE_WINDOW");
    }
    if (current) {
      panel.clock(current.task, Date.now());
      void current.tick();
    }
    const fast = current?.waiting && current.task.open - Date.now() <= 2000;
    setTimeout(loop, fast ? 50 : 250);
  };
  loop();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootIpadP71, { once: true });
} else {
  bootIpadP71();
}
