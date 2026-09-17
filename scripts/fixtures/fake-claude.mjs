#!/usr/bin/env node
/**
 * Stand-in for the `claude` CLI, so the claude-code provider can be tested with
 * no login and no model call. Records what it was handed — argv, stdin, and
 * whether an API key reached it — to FAKE_CLAUDE_LOG, then answers the way
 * `claude -p --output-format json` does. FAKE_CLAUDE_MODE picks the scenario.
 */
import { appendFileSync } from "node:fs";
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  const argv = process.argv.slice(2);
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({
    argv,
    stdinLength: stdin.length,
    stdinHead: stdin.slice(0, 40),
    sawApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
    sawAuthToken: Boolean(process.env.ANTHROPIC_AUTH_TOKEN),
    cwd: process.cwd(),
  }) + "\n");
  const mode = process.env.FAKE_CLAUDE_MODE || "ok";
  const base = { type: "result", session_id: "x", duration_ms: 5, num_turns: 1,
    usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: { "claude-fable-5-1": {} }, total_cost_usd: 0.01 };
  if (mode === "limit") {
    process.stdout.write(JSON.stringify({ ...base, is_error: true, subtype: "success",
      result: "You've hit your session limit · resets 1pm (America/Phoenix)" }));
  } else if (mode === "auth") {
    process.stdout.write(JSON.stringify({ ...base, is_error: true, subtype: "success",
      result: "Failed to authenticate: OAuth session expired and could not be refreshed" }));
  } else if (mode === "aux") {
    // What the real CLI returns: its own small Haiku call listed first.
    process.stdout.write(JSON.stringify({ ...base, is_error: false, subtype: "success", result: "",
      structured_output: { ok: true },
      modelUsage: { "claude-haiku-4-5-20251001": { inputTokens: 898, outputTokens: 11 },
                    "claude-fable-5-1": { inputTokens: 2, outputTokens: 30, cacheCreationInputTokens: 3605 } } }));
  } else if (mode === "switched") {
    process.stdout.write(JSON.stringify({ ...base, is_error: false, subtype: "success", result: "",
      structured_output: { ok: true },
      modelUsage: { "claude-haiku-4-5-20251001": { inputTokens: 3600, outputTokens: 30 } } }));
  } else {
    process.stdout.write(JSON.stringify({ ...base, is_error: false, subtype: "success",
      result: "", structured_output: { ok: true } }));
  }
});
