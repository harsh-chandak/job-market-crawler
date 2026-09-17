/**
 * claude-code provider tests — a fake CLI, no login, no model call, no billing.
 * node scripts/test-claude-code.mjs
 *
 * The property that matters most is the first one. Claude Code prefers
 * ANTHROPIC_API_KEY over the subscription login whenever the variable is set,
 * and dotenv puts it in process.env for the rest of the pipeline. If it reached
 * the child, "switch to the Max plan" would quietly keep billing the key.
 */
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LOG = join(tmpdir(), `fake-claude-${process.pid}.log`);
const LEDGER = join(tmpdir(), `ledger-cc-${process.pid}.jsonl`);
rmSync(LOG, { force: true }); rmSync(LEDGER, { force: true });
process.env.FAKE_CLAUDE_LOG = LOG;
process.env.TOKEN_LEDGER_PATH = LEDGER;
process.env.CLAUDE_CODE_BIN = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
// Present in the parent on purpose: the test is that it does NOT reach the child.
process.env.ANTHROPIC_API_KEY = "sk-ant-should-never-reach-the-child";
process.env.ANTHROPIC_AUTH_TOKEN = "should-never-reach-the-child";

const { complete, claudeCodeStatus, resetClaudeCodePause } = await import("../src/llm.js");

let pass = 0, fail = 0; const failures = [];
const ok = (n, c, d = "") => (c ? pass++ : (fail++, failures.push(`${n}${d ? ` — ${d}` : ""}`)));
const calls = () => readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const SCHEMA = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };

/* ---- happy path ---- */
const res = await complete({
  provider: "claude-code", model: "fable", stage: "score",
  system: "You return JSON only.", user: "catalogue ... posting ...", cachePrefix: "PREFIX:",
  schema: SCHEMA, retries: 0,
});
const c = calls()[0];
ok("returns the structured output", res?.data?.ok === true, JSON.stringify(res?.data));
ok("API key stripped from the child", c.sawApiKey === false);
ok("auth token stripped from the child", c.sawAuthToken === false);
ok("parent still has its key (only the child is cleaned)", process.env.ANTHROPIC_API_KEY?.startsWith("sk-ant-"));
ok("--safe-mode passed", c.argv.includes("--safe-mode"));
ok("--bare NOT passed (it forces API-key auth)", !c.argv.includes("--bare"));
ok("headless -p", c.argv.includes("-p"));
ok("json output", c.argv.join(" ").includes("--output-format json"));
ok("no session persistence", c.argv.includes("--no-session-persistence"));
const ti = c.argv.indexOf("--tools");
ok("all tools disabled", ti >= 0 && c.argv[ti + 1] === "");
ok("model forwarded", c.argv[c.argv.indexOf("--model") + 1] === "fable");
ok("system prompt replaced", c.argv[c.argv.indexOf("--system-prompt") + 1] === "You return JSON only.");
ok("json schema forwarded", c.argv.includes("--json-schema"));
ok("prompt sent on stdin, prefix included", c.stdinHead.startsWith("PREFIX:"), c.stdinHead);
ok("runs outside the project", !c.cwd.includes("job-hunt/") || c.cwd.includes("job-hunt-claude-code"), c.cwd);

const led = readFileSync(LEDGER, "utf8").trim().split("\n").map((l) => JSON.parse(l));
ok("ledger records the call", led.length === 1 && led[0].provider === "claude-code");
ok("ledger bills it at $0", led[0].usd === 0, String(led[0].usd));
ok("ledger keeps the token counts", led[0].input === 120 && led[0].output === 30);

/* ---- per-stage effort ---- */
process.env.CLAUDE_CODE_EFFORT_TAILOR = "high";
const effortOf = (c) => c.argv[c.argv.indexOf("--effort") + 1];
await complete({ provider: "claude-code", model: "fable", stage: "tailor", system: "s", user: "u", schema: SCHEMA, retries: 0 });
ok("tailor stage takes its own effort", effortOf(calls().at(-1)) === "high", effortOf(calls().at(-1)));
await complete({ provider: "claude-code", model: "fable", stage: "score", system: "s", user: "u", schema: SCHEMA, retries: 0 });
ok("other stages keep the default", effortOf(calls().at(-1)) !== "high", effortOf(calls().at(-1)));
delete process.env.CLAUDE_CODE_EFFORT_TAILOR;

/* ---- the ledger names the model that answered, not the CLI's helper ---- */
process.env.FAKE_CLAUDE_MODE = "aux";
await complete({ provider: "claude-code", model: "fable", stage: "score", system: "s", user: "u", schema: SCHEMA, retries: 0 });
{
  const last = readFileSync(LEDGER, "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
  ok("ledger records Fable, not the CLI's own Haiku call", last.model === "claude-fable-5-1", last.model);
}

/* ---- a response the requested model did not answer is refused ---- */
process.env.FAKE_CLAUDE_MODE = "switched";
let swErr = null;
try { await complete({ provider: "claude-code", model: "fable", stage: "score", system: "s", user: "u", schema: SCHEMA, retries: 0 }); } catch (e) { swErr = e; }
ok("a switched-model answer throws", /not fable/.test(String(swErr?.message)), String(swErr?.message));
ok("a switched model pauses the provider", claudeCodeStatus().paused === true && /did not answer/.test(claudeCodeStatus().reason || ""), JSON.stringify(claudeCodeStatus()));
resetClaudeCodePause();
delete process.env.FAKE_CLAUDE_MODE;

/* ---- Max plan session limit pauses the provider ---- */
process.env.FAKE_CLAUDE_MODE = "limit";
let limitErr = null;
try { await complete({ provider: "claude-code", model: "fable", stage: "score", system: "s", user: "u", schema: SCHEMA, retries: 0 }); } catch (e) { limitErr = e; }
ok("session-limit failure throws", /session limit/.test(String(limitErr?.message)), String(limitErr?.message));
ok("session limit pauses the provider", claudeCodeStatus().paused === true && /usage limit/.test(claudeCodeStatus().reason || ""), JSON.stringify(claudeCodeStatus()));
resetClaudeCodePause();
delete process.env.FAKE_CLAUDE_MODE;

/* ---- logged out: fails loudly, pauses, never falls back to the key ---- */
process.env.FAKE_CLAUDE_MODE = "auth";
let err = null;
try { await complete({ provider: "claude-code", model: "fable", system: "s", user: "u", schema: SCHEMA, retries: 0 }); }
catch (e) { err = e; }
ok("auth failure throws", /authenticat/i.test(String(err?.message)), String(err?.message));
ok("provider pauses after an auth failure", claudeCodeStatus().paused === true);
const before = calls().length;
let err2 = null;
try { await complete({ provider: "claude-code", model: "fable", system: "s", user: "u", schema: SCHEMA, retries: 0 }); }
catch (e) { err2 = e; }
ok("paused provider does not spawn again", calls().length === before, `${calls().length} vs ${before}`);
ok("paused error names the fix", /claude auth login/.test(String(err2?.message)), String(err2?.message));

rmSync(LOG, { force: true }); rmSync(LEDGER, { force: true });
console.log(failures.map((f) => `  FAIL ${f}`).join("\n"));
console.log(`\n  ${pass} passed, ${fail} failed`);
console.log(fail ? "  FAILURES" : "  all green");
process.exit(fail ? 1 : 0);
