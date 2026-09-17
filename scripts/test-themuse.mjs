/** The Muse adapter tests — no network, no DB. node scripts/test-themuse.mjs */
import { museUrl, normalizeMuse } from "../src/adapters/themuse.js";

let pass = 0, fail = 0; const failures = [];
const ok = (n, c, d = "") => (c ? pass++ : (fail++, failures.push(`${n}${d ? ` — ${d}` : ""}`)));

/* ---- url building ---- */
ok("category encoded", museUrl({ category: "Software Engineering", page: 3 })
  .includes("category=Software+Engineering"));
ok("page carried", museUrl({ category: "IT", page: 3 }).includes("page=3"));
ok("page defaults to 1", museUrl({ category: "IT" }).includes("page=1"));
ok("level optional", !museUrl({ category: "IT" }).includes("level="));

/* ---- normalisation ---- */
const j = normalizeMuse({
  id: 42, name: "  Software Engineer  ", contents: "<p>Build things</p>",
  locations: [{ name: "Phoenix, AZ" }, { name: "Remote" }],
  refs: { landing_page: "https://www.themuse.com/jobs/x/y" },
  publication_date: "2026-08-01T00:00:00Z",
  levels: [{ name: "Entry Level" }], company: { name: "Acme" },
});
ok("id stringified", j.sourceJobId === "42");
ok("title trimmed", j.title === "Software Engineer");
ok("html left raw for the poller to convert", j.description === "<p>Build things</p>");
ok("locations flattened", JSON.stringify(j.locations) === '["Phoenix, AZ","Remote"]');
ok("apply url", j.applyUrl === "https://www.themuse.com/jobs/x/y");
ok("posted date", j.postedAtClaimed === "2026-08-01T00:00:00Z");
ok("levels captured", JSON.stringify(j.museLevels) === '["Entry Level"]');
ok("company captured", j.museCompany === "Acme");

/* ---- missing fields must not throw ---- */
const bare = normalizeMuse({});
ok("empty record survives", bare.sourceJobId === "" && bare.title === "");
ok("missing locations become []", Array.isArray(bare.locations) && bare.locations.length === 0);
ok("missing refs give empty url", bare.applyUrl === "");
ok("missing levels become []", Array.isArray(bare.museLevels));

console.log(failures.map((f) => `  FAIL ${f}`).join("\n"));
console.log(`\n  ${pass} passed, ${fail} failed`);
console.log(fail ? "  FAILURES" : "  all green");
process.exit(fail ? 1 : 0);
