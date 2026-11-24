import { readFile, writeFile } from "node:fs/promises";
import { build } from "vite";

const file = "HDU_Android_P6.3_Lite.user.js";
await build({
  configFile: false,
  publicDir: false,
  logLevel: "warn",
  build: {
    target: "firefox115",
    minify: false,
    emptyOutDir: false,
    outDir: "userscripts",
    lib: { entry: "src/userscript/p60/entry.js", name: "HduP63", formats: ["iife"], fileName: () => file },
  },
});
const metadata = [
  "// ==UserScript==",
  "// @name         杭电图书馆 Android P6.3 Lite",
  "// @namespace    https://github.com/rrz0120-maker/HDU-Library-Sniper/p63",
  "// @version      6.3.0",
  "// @description  四楼162号，默认北京时间20:00:01.350预约后天08:00–22:00；一次正式POST与官方记录核验。",
  "// @match        https://hdu.huitu.zhishulib.com/*",
  "// @grant        none",
  "// @noframes",
  "// @run-at       document-end",
  "// @updateURL    none",
  "// @license      MIT",
  "// ==/UserScript==",
].join("\n");
const path = `userscripts/${file}`;
const code = `${metadata}\n${await readFile(path, "utf8")}`;
if (
  /@require|GM_xmlhttpRequest|document\.cookie|OPEN_RANGE_|openProofGeneration|openingChecks|nextOpeningCheckMono/.test(
    code,
  )
)
  throw new Error("Forbidden legacy gate or dependency in P6.3");
await writeFile(path, code);
