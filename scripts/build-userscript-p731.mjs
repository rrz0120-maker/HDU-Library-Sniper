import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

// Pure Node.js zero-dependency bundler for P7.3 iPad Performance Production Candidate.
const MODULES = [
  "src/userscript/core.js",
  "src/userscript/transport.js",
  "src/userscript/ledger.js",
  "src/userscript/p70/policy.js",
  "src/userscript/p70/store.js",
  "src/userscript/p70/engine.js",
  "src/userscript/p70/panel.js",
  "src/userscript/p71/coordinator.js",
  "src/userscript/p71/policy.js",
  "src/userscript/p71/store.js",
  "src/userscript/p71/engine.js",
  "src/userscript/p71/panel.js",
  "src/userscript/p73/release-guard.js",
  "src/userscript/p73/engine.js",
  "src/userscript/p73/panel.js",
  "src/userscript/p73/entry.js",
];

const METADATA = `// ==UserScript==
// @name         杭电图书馆 P7.3 iPad 正式性能版 (162整点 & 普通预约)
// @namespace    https://github.com/rrz0120-maker/HDU-Library-Sniper/p73-ipad
// @version      7.3.1
// @description  iPad Safari + Userscripts 正式性能候选版：固定四楼162、自定义时段、19:57正式准备、静态映射严格复用、19:59:15重校时、跨标签写入互斥、实际开放确认双门禁、跨模式互斥、后台挂起中止与单次写入保护。
// @match        https://hdu.huitu.zhishulib.com/*
// @grant        none
// @inject-into  page
// @noframes
// @run-at       document-idle
// @updateURL    none
// @license      MIT
// ==/UserScript==
`;

function stripModuleSyntax(source, file) {
  let cleaned = source.replace(/^\s*import\s+[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "");
  cleaned = cleaned.replace(/^\s*export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/gm, "");
  return `  // --- ${file} ---\n${cleaned.trim()}\n`;
}

await mkdir("userscripts", { recursive: true });
const parts = [];
for (const file of MODULES) {
  const raw = await readFile(file, "utf8");
  parts.push(stripModuleSyntax(raw, file));
}

const outPath = "userscripts/hdu-p731-ipad-performance.user.js";
const code = `${METADATA}(function () {\n  "use strict";\n${parts.join("\n")}})();\n`;

if (!code.startsWith("// ==UserScript==")) throw new Error("Missing UserScript header");
if (/@require|GM_xmlhttpRequest|document\.cookie|lockSeats|cancelBooking|signIn/.test(code)) {
  throw new Error("Invalid P7.3 artifact: forbidden pattern detected");
}

await writeFile(outPath, code, "utf8");
execFileSync(process.execPath, ["--check", outPath], { stdio: "inherit" });

const sha256 = createHash("sha256").update(code, "utf8").digest("hex");
console.log(`${outPath} (${Buffer.byteLength(code, "utf8")} bytes)`);
console.log(`SHA256: ${sha256}`);
