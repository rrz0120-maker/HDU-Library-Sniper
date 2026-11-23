import { ORIGIN } from "../core.js";
import { Transport } from "../transport.js";
import { DailyEngine } from "./engine.js";
import { mountPanel } from "./panel.js";

function boot() {
  if (location.origin !== ORIGIN || window.top !== window.self || document.getElementById("hdu-p62-host"))
    return;
  const ids = ["hdu-p51-panel", "hdu-p53-host", "hdu-p60-host"];
  const legacy = ids.some((id) => document.getElementById(id));
  const host = document.createElement("div");
  host.id = "hdu-p62-host";
  if (!legacy) {
    // Frozen mobile entry points check these DOM IDs before creating their engine.
    // This also works when Tampermonkey uses an isolated JavaScript world.
    for (const id of ids) {
      const marker = document.createElement("span");
      marker.id = id;
      marker.hidden = true;
      host.append(marker);
    }
  }
  document.body.append(host);
  const engine = new DailyEngine(new Transport());
  const panel = mountPanel(host, engine, legacy);
  engine.notify = panel.render;
  engine.render();
  document.addEventListener("visibilitychange", () => engine.observePage("visibilitychange"));
  document.addEventListener("freeze", () => engine.observePage("freeze"));
  document.addEventListener("resume", () => engine.observePage("resume"));
  window.addEventListener("pagehide", () => engine.observePage("pagehide"));
  window.addEventListener("pageshow", () => engine.observePage("pageshow"));
}

if (document.body) boot();
else document.addEventListener("DOMContentLoaded", boot, { once: true });
