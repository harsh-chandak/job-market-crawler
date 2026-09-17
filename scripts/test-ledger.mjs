/** Token ledger tests — no network, no DB, no model. node scripts/test-ledger.mjs */
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ratesFor, costOf, record, readLedger, summarize } from "../src/ledger.js";

let pass = 0, fail = 0; const failures = [];
const ok = (n, c, d = "") => (c ? pass++ : (fail++, failures.push(`${n}${d ? ` — ${d}` : ""}`)));
const near = (a, b) => Math.abs(a - b) < 1e-9;

const INTRO = Date.parse("2026-08-06T00:00:00Z");
const LIST = Date.parse("2026-09-15T00:00:00Z");

/* ---- pricing, including the intro period that ends 2026-08-31 ---- */
ok("intro input", ratesFor("claude-sonnet-5", INTRO).input === 2.0);
ok("intro output", ratesFor("claude-sonnet-5", INTRO).output === 10.0);
ok("list input after 08-31", ratesFor("claude-sonnet-5", LIST).input === 3.0);
ok("list output after 08-31", ratesFor("claude-sonnet-5", LIST).output === 15.0);
ok("boundary is 09-01", ratesFor("claude-sonnet-5", Date.parse("2026-08-31T23:59:59Z")).input === 2.0);
ok("cache write is 1.25x", near(ratesFor("claude-sonnet-5", INTRO).cacheWrite, 2.5));
ok("cache read is 0.1x", near(ratesFor("claude-sonnet-5", INTRO).cacheRead, 0.2));
ok("opus priced", ratesFor("claude-opus-5").input === 5.0);
ok("unknown model unpriced", ratesFor("llama-3.3-70b-versatile") === null);

/* ---- cost arithmetic ---- */
ok("output dominates",
  costOf("claude-sonnet-5", { output: 1e6 }, INTRO) > costOf("claude-sonnet-5", { input: 1e6 }, INTRO));
ok("1M output at intro = $10", near(costOf("claude-sonnet-5", { output: 1e6 }, INTRO), 10));
ok("1M cache read at intro = $0.20", near(costOf("claude-sonnet-5", { cacheRead: 1e6 }, INTRO), 0.2));
ok("unbilled provider costs nothing", costOf("llama-3.3-70b-versatile", { output: 1e6 }) === 0);
ok("empty usage is free", costOf("claude-sonnet-5", {}, INTRO) === 0);
ok("missing usage is free", costOf("claude-sonnet-5", undefined, INTRO) === 0);

/* ---- the ledger must never break the call it measures ---- */
const bad = await record({ stage: "x", model: "claude-sonnet-5", usage: { input: 1 },
  at: INTRO, path: "/proc/nonexistent/cannot/write/x.jsonl" });
ok("unwritable path returns null rather than throwing", bad === null, JSON.stringify(bad));

/* ---- round trip ---- */
const P = join(tmpdir(), `ledger-test-${process.pid}.jsonl`);
await rm(P, { force: true });
process.env.TOKEN_LEDGER_PATH = P;
const { record: rec, readLedger: read } = await import(`../src/ledger.js?t=${process.pid}`);

await rec({ stage: "score", provider: "anthropic", model: "claude-sonnet-5",
  usage: { input: 1000, cacheRead: 9000, output: 300 }, at: INTRO });
await rec({ stage: "tailor", provider: "anthropic", model: "claude-sonnet-5",
  usage: { input: 500, cacheWrite: 10000, output: 200 }, at: INTRO });
await rec({ stage: "score", provider: "anthropic", model: "claude-sonnet-5",
  usage: { input: 900, output: 100 }, ok: false, at: INTRO });

const rows = await read({ path: P });
ok("three rows written", rows.length === 3, String(rows.length));
ok("cost recorded per row", rows.every((r) => typeof r.usd === "number"));

const s = summarize(rows);
ok("total is the sum", near(s.total.usd, rows.reduce((a, r) => a + r.usd, 0)));
ok("failures counted", s.total.failed === 1);
ok("grouped by stage", s.byStage.score.calls === 2 && s.byStage.tailor.calls === 1);
ok("grouped by day", Object.keys(s.byDay)[0] === "2026-08-06");
ok("cache hit rate in range", s.total.cacheHitRate > 0 && s.total.cacheHitRate < 1);
ok("hit rate counts reads over cacheable",
  near(s.total.cacheHitRate, 9000 / (9000 + 10000 + 2400)));

/* ---- a half-written final line must not lose the file ---- */
const { appendFile } = await import("node:fs/promises");
await appendFile(P, '{"ts":"2026-08-06T00:00:00.000Z","stage":"trunc"');
const after = await read({ path: P });
ok("truncated line skipped, rest kept", after.length === 3, String(after.length));

/* ---- a date filter that excludes everything is empty, not everything ---- */
const old = await read({ path: P, sinceDays: 0.00001 });
ok("date filter applies", old.length === 0, String(old.length));

/* ---- a missing ledger reads as empty, not as a crash ---- */
ok("missing file is empty", (await read({ path: join(tmpdir(), "definitely-not-here.jsonl") })).length === 0);
ok("summarize of nothing is zero", summarize([]).total.usd === 0);

await rm(P, { force: true });
console.log(failures.map((f) => `  FAIL ${f}`).join("\n"));
console.log(`\n  ${pass} passed, ${fail} failed`);
console.log(fail ? "  FAILURES" : "  all green");
process.exit(fail ? 1 : 0);
