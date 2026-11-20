import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

// Pure Node.js zero-dependency bundler for P7.0 iPad Phase 1 Safari Userscripts artifact.
const MODULES = [
  "src/userscript/core.js",
  "src/userscript/transport.js",
  "src/userscript/ledger.js",
  "src/userscript/p70/policy.js",
  "src/userscript/p70/store.js",
  "src/userscript/p70/engine.js",
  "src/userscript/p70/panel.js",
  "src/userscript/p70/entry.js",
];

const METADATA = `// ==UserScript==
// @name         杭电图书馆 P7.0 iPad 原生预约验证 (Phase 1)
// @namespace    https://github.com/rrz0120-maker/HDU-Library-Sniper/p70-ipad
// @version      7.0.2-phase1
// @description  iPad Safari + Userscripts 独立实验版：同源只读查询房间与当前空余座位，经明确双确认后完成单次1小时正常预约与官方记录核验；不含20:00抢座、不重试、不伪造旧凭据。
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
  // Remove single-line and multi-line import statements
  let cleaned = source.replace(/^\s*import\s+[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "");
  // Strip leading `export ` keyword on declarations
  cleaned = cleaned.replace(/^\s*export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/gm, "");
  return `  // --- ${file} ---\n${cleaned.trim()}\n`;
}

await mkdir("userscripts", { recursive: true });
const parts = [];
for (const file of MODULES) {
  const raw = await readFile(file, "utf8");
  parts.push(stripModuleSyntax(raw, file));
}

const outPath = "userscripts/hdu-p70-ipad-phase1.user.js";
const code = `${METADATA}(function () {\n  "use strict";\n${parts.join("\n")}})();\n`;

if (!code.startsWith("// ==UserScript==")) throw new Error("Missing UserScript header");
if (/@require|GM_xmlhttpRequest|document\.cookie|lockSeats|cancelBooking|signIn/.test(code)) {
  throw new Error("Invalid P7.0 artifact: forbidden pattern detected");
}

await writeFile(outPath, code, "utf8");
execFileSync(process.execPath, ["--check", outPath], { stdio: "inherit" });

const sha256 = createHash("sha256").update(code, "utf8").digest("hex");
console.log(`${outPath} (${Buffer.byteLength(code, "utf8")} bytes)`);
console.log(`SHA256: ${sha256}`);
