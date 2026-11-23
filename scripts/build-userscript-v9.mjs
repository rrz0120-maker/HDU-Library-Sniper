import { build } from "vite";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const banner = [
  "// ==UserScript==",
  "// @name         HDU iPad V9 Lite · 四楼162",
  "// @namespace    https://github.com/rrz0120-maker/HDU-Library-Sniper/ipad-v9",
  "// @version      9.0.0",
  "// @description  北京时间20:00预约与已开放时段真实预约，使用当前官网会话。",
  "// @match        https://hdu.huitu.zhishulib.com/*",
  "// @grant        none",
  "// @inject-into  page",
  "// @noframes",
  "// @run-at       document-end",
  "// @license      MIT",
  "// ==/UserScript==",
].join("\n");

await build({
  configFile: false,
  publicDir: false,
  build: {
    target: "safari15.4",
    outDir: "userscripts",
    emptyOutDir: false,
    minify: false,
    lib: {
      entry: "src/userscript/v9/entry.js",
      name: "HduIpadV9",
      formats: ["iife"],
      fileName: () => "HDU_iPad_V9_Lite.user.js",
    },
  },
});
const file = "HDU_iPad_V9_Lite.user.js";
const path = `userscripts/${file}`;
const code = `${banner}\n${await readFile(path, "utf8")}`;
await writeFile(path, code);
const sums = "userscripts/SHA256SUMS";
const old = (await readFile(sums, "utf8"))
  .trimEnd()
  .split("\n")
  .filter((line) => !line.endsWith(`  ${file}`));
await writeFile(sums, [...old, `${createHash("sha256").update(code).digest("hex")}  ${file}`, ""].join("\n"));
