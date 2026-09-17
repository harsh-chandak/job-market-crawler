/** ByteDance/TikTok adapter unit tests — no network. node scripts/test-bytedance.mjs */
import {
  applyUrlFor,
  locationsOf,
  bodyOf,
  normalizePost,
  BYTEDANCE_BOARDS,
  RND_CATEGORY_ID,
} from "../src/adapters/bytedance.js";
import { htmlToText, supportedAts } from "../src/adapters/index.js";

let pass = 0,
  fail = 0;
const failures = [];
const ok = (n, c, d = "") =>
  c ? pass++ : (fail++, failures.push(`${n}${d ? ` — ${d}` : ""}`));

const TIKTOK = BYTEDANCE_BOARDS.find((b) => b.token === "tiktok");
const BYTED = BYTEDANCE_BOARDS.find((b) => b.token === "bytedance");

/* ---- board config ---- */
ok("boards: two of them", BYTEDANCE_BOARDS.length === 2);
ok("boards: tiktok host", TIKTOK.btHost === "api.lifeattiktok.com");
ok("boards: tiktok website-path", TIKTOK.btWebsitePath === "tiktok");
ok("boards: bytedance host", BYTED.btHost === "jobs.bytedance.com");
// The gateway rejects every other value with a bare 400; `en` was found by
// brute force, not from the bundle, so pin it.
ok("boards: bytedance website-path is 'en'", BYTED.btWebsitePath === "en");
ok(
  "adapters: bytedance is a supported ats",
  supportedAts().includes("bytedance"),
);

/* ---- apply URLs (both verified 200 with the posting rendered) ---- */
ok(
  "applyUrl: tiktok",
  applyUrlFor(TIKTOK, "7613184212766607621") ===
    "https://lifeattiktok.com/search/7613184212766607621",
  applyUrlFor(TIKTOK, "7613184212766607621"),
);
ok(
  "applyUrl: bytedance",
  applyUrlFor(BYTED, "7626484869123836165") ===
    "https://jobs.bytedance.com/en/position/7626484869123836165/detail",
  applyUrlFor(BYTED, "7626484869123836165"),
);

/* ---- locations ----
   city_info is a linked list city -> state -> country. The whole chain is
   emitted as one string because the US gate reads country and state names out
   of the text; a bare "San Jose" would leave Vancouver ambiguous. */
{
  const row = {
    city_info: {
      en_name: "San Jose",
      parent: {
        en_name: "California",
        parent: { en_name: "United States of America", parent: null },
      },
    },
  };
  ok(
    "locations: full city/state/country chain",
    locationsOf(row)[0] === "San Jose, California, United States of America",
    JSON.stringify(locationsOf(row)),
  );
}
{
  const row = {
    city_info: {
      en_name: "Singapore",
      parent: { en_name: "Singapore", parent: null },
    },
  };
  ok(
    "locations: repeated names are not duplicated",
    locationsOf(row)[0] === "Singapore",
    JSON.stringify(locationsOf(row)),
  );
}
ok("locations: empty when city_info missing", locationsOf({}).length === 0);
{
  // i18n_name is the fallback when en_name is absent.
  const row = { city_info: { en_name: "", i18n_name: "Tokyo", parent: null } };
  ok("locations: falls back to i18n_name", locationsOf(row)[0] === "Tokyo");
}
{
  // A self-referential parent chain must not hang the poller.
  const node = { en_name: "Loop" };
  node.parent = node;
  ok(
    "locations: cyclic parent chain terminates",
    locationsOf({ city_info: node })[0] === "Loop",
  );
}

/* ---- body ----
   description and requirement are PLAIN TEXT: zero HTML tags and zero entities
   across 585 rows. htmlToText must therefore not be applied unconditionally —
   its `<[^>]+>` strip would delete the literal "<a-frame>" that one posting
   lists as a framework. */
{
  const row = { description: "Build things.", requirement: "- 3 years Go" };
  ok(
    "body: description and requirement joined",
    bodyOf(row, htmlToText) === "Build things.\n\n- 3 years Go",
    JSON.stringify(bodyOf(row, htmlToText)),
  );
}
{
  const row = {
    description:
      "Experience with Three.js, Babylon.js, <a-frame>, or React-three-fiber",
    requirement: "",
  };
  ok(
    "body: plain text is NOT run through htmlToText",
    bodyOf(row, htmlToText).includes("<a-frame>"),
    bodyOf(row, htmlToText),
  );
}
{
  // ...but stays correct if ByteDance ever switches these fields to HTML.
  const row = {
    description: "<p>Build <strong>things</strong>.</p>",
    requirement: "",
  };
  const b = bodyOf(row, htmlToText);
  ok(
    "body: real HTML is converted",
    !/[<>]/.test(b) && b.includes("Build things"),
    b,
  );
}
ok("body: empty row yields empty string", bodyOf({}, htmlToText) === "");
ok(
  "body: requirement alone still produces a body",
  bodyOf({ requirement: "- Go" }, htmlToText) === "- Go",
);

/* ---- normalization ---- */
{
  const row = {
    id: "7613184212766607621",
    code: "A223818A",
    title: "Software Engineer, TikTok AIGC Agentic Workflow",
    description: "You will build agentic workflows.",
    requirement: "- 2 years of experience",
    job_category: { en_name: "Backend", parent: { en_name: "R&D" } },
    recruit_type: { en_name: "Regular" },
    city_info: {
      en_name: "San Jose",
      parent: {
        en_name: "California",
        parent: { en_name: "United States of America", parent: null },
      },
    },
    job_post_info: { min_salary: null, expiry_time: null },
  };
  const j = normalizePost(row, TIKTOK, htmlToText);
  ok("normalize: id", j.sourceJobId === "7613184212766607621");
  ok(
    "normalize: title",
    j.title === "Software Engineer, TikTok AIGC Agentic Workflow",
  );
  ok(
    "normalize: body carries both fields",
    j.description.includes("agentic") && j.description.includes("2 years"),
  );
  ok(
    "normalize: applyUrl",
    j.applyUrl === "https://lifeattiktok.com/search/7613184212766607621",
  );
  ok(
    "normalize: location",
    j.locations[0].endsWith("United States of America"),
  );
  // The single most important assertion in this file. There is no date field in
  // the row, the detail page or the id — inventing one would poison
  // claimedLagMs, which every age gate reads.
  ok(
    "normalize: postedAtClaimed is null, never fabricated",
    j.postedAtClaimed === null,
  );
  ok("normalize: meta carries the req code", j.meta.code === "A223818A");
  ok("normalize: meta carries the category", j.meta.category === "Backend");
}
{
  const j = normalizePost({}, TIKTOK, htmlToText);
  ok("normalize: empty row yields no id", j.sourceJobId === "");
  ok("normalize: empty row yields no applyUrl", j.applyUrl === "");
  ok(
    "normalize: empty row still has null postedAt",
    j.postedAtClaimed === null,
  );
}

/* ---- filter ids ----
   `job_category_id_list` filters (3,830 -> 1,104); `job_type_id_list` is the
   name that looks right in the config and is silently ignored. Both verified by
   counting against the live endpoint. */
ok(
  "filters: R&D category id pinned",
  RND_CATEGORY_ID === "6704215862603155720",
);

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\n  failures:");
  failures.forEach((f) => console.log(`    ✗ ${f}`));
  process.exit(1);
}
console.log("  all green\n");
