// node tests/userscript-v9/upstream-signatures.mjs /path/to/AlaIchhe-checkout
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bookSeatRequest } from "../../src/userscript/core.js";
import { makeTask } from "../../src/userscript/v9/policy.js";

const ref = "f1055c9713c7b5917c4ef4d6d1c959864e41f05c";
const checkout = process.argv[2];
if (!checkout) throw new Error("Pass the path to a clone of AlaIchhe/HDU-Library-Sniper");
const cryptoGo = execFileSync("git", ["-C", checkout, "show", `${ref}:internal/hdu/crypto.go`]);
const dir = mkdtempSync(join(tmpdir(), "hdu-v9-go-"));
try {
  const cases = JSON.parse(readFileSync("tests/fixtures/p53-signatures.json", "utf8"));
  for (let start = 7; start < 22; start++)
    for (let end = start + 1; end <= 22; end++) {
      const now = Date.parse("2026-11-22T20:00:01.200+08:00");
      const t = makeTask("scheduled", now, start, end);
      const uid = "111";
      const apiTime = Math.floor(now / 1000);
      cases.push({
        seatId: t.seatId,
        uid,
        apiTime,
        beginTime: t.begin,
        duration: t.duration,
        token: bookSeatRequest(t.seatId, uid, t.begin, apiTime, t.duration).token,
      });
    }
  writeFileSync(join(dir, "crypto.go"), cryptoGo);
  writeFileSync(join(dir, "cases.json"), JSON.stringify(cases));
  writeFileSync(
    join(dir, "oracle_test.go"),
    [
      "package hdu",
      'import ("testing"; "os"; "encoding/json")',
      "func TestV9(t *testing.T) {",
      'b, err := os.ReadFile("cases.json"); if err != nil { t.Fatal(err) }',
      "var rows []struct { SeatId, Uid, Token string; BeginTime, Duration, ApiTime int64 }",
      "if err := json.Unmarshal(b, &rows); err != nil { t.Fatal(err) }",
      'for i, x := range rows { if ApiToken(x.SeatId, x.Uid, x.BeginTime, x.Duration, x.ApiTime) != x.Token { t.Fatalf("case %d", i) } }',
      't.Logf("%d vectors matched upstream ApiToken", len(rows))',
      "}",
    ].join("\n"),
  );
  execFileSync(process.env.GO_BINARY || "go", ["test", "-v", "crypto.go", "oracle_test.go"], {
    cwd: dir,
    stdio: "inherit",
    env: { ...process.env, GO111MODULE: "off" },
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
