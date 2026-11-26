import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

// Preserve the audited P6.3 release. Build current sources with build:userscript:p64.
const path = "userscripts/HDU_Android_P6.3_Lite.user.js";
const baseline = "dccafec5d02993cb31e85f9d19bee6e9e461ee7f";
await writeFile(path, execFileSync("git", ["show", baseline + ":" + path]));
