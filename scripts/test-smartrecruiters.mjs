/** SmartRecruiters adapter unit tests — no network. node scripts/test-smartrecruiters.mjs */
import {
  publicUrl,
  detailUrl,
  extractBody,
} from "../src/adapters/smartrecruiters.js";
import { ADAPTERS } from "../src/adapters/index.js";

let pass = 0,
  fail = 0;
const failures = [];
const ok = (n, c, d = "") =>
  c ? pass++ : (fail++, failures.push(`${n}${d ? ` — ${d}` : ""}`));

/* ---- public apply URL ---- */
ok(
  "publicUrl: built from token + id",
  publicUrl("AristaNetworks", "744000141561647") ===
    "https://jobs.smartrecruiters.com/AristaNetworks/744000141561647",
  publicUrl("AristaNetworks", "744000141561647"),
);
ok("publicUrl: empty on missing id", publicUrl("AristaNetworks", "") === "");
ok("publicUrl: empty on missing token", publicUrl("", "123") === "");
ok(
  "publicUrl: case is preserved (path is case-sensitive)",
  publicUrl("CapTechConsulting", "1").includes("/CapTechConsulting/"),
);

/* ---- detail URL ---- */
{
  const job = {
    companyToken: "AristaNetworks",
    sourceJobId: "744000141561647",
  };
  ok(
    "detailUrl: derived from job fields",
    detailUrl(job) ===
      "https://api.smartrecruiters.com/v1/companies/AristaNetworks/postings/744000141561647",
    detailUrl(job),
  );
  ok(
    "detailUrl: company token wins over job token",
    detailUrl(job, { token: "Other" }).includes("/companies/Other/"),
  );
}
{
  // Rows written before the applyUrl fix stored the API ref. Still hydratable.
  const legacy = {
    applyUrl: "https://api.smartrecruiters.com/v1/companies/X/postings/1",
  };
  ok(
    "detailUrl: falls back to a legacy API ref",
    detailUrl(legacy) ===
      "https://api.smartrecruiters.com/v1/companies/X/postings/1",
    String(detailUrl(legacy)),
  );
}
ok(
  "detailUrl: null when nothing is derivable",
  detailUrl({ applyUrl: "https://example.com/job/1" }) === null,
);
ok("detailUrl: null on an empty job", detailUrl({}) === null);

/* ---- body extraction ----
   Shape captured from the live detail response for AristaNetworks/744000141561647. */
{
  const detail = {
    jobAd: {
      sections: {
        companyDescription: {
          title: "Company Description",
          text: "<p>Boilerplate about us.</p>",
        },
        jobDescription: {
          title: "Job Description",
          text: "<p>You will build <b>routers</b>.</p>",
        },
        qualifications: {
          title: "Qualifications",
          text: "<ul><li>5 years C++</li></ul>",
        },
        additionalInformation: { title: "Additional Information", text: "" },
      },
    },
  };
  const body = extractBody(detail);
  ok(
    "extractBody: includes jobDescription",
    body.includes("You will build routers"),
    body,
  );
  ok("extractBody: includes qualifications", body.includes("5 years C++"));
  ok("extractBody: includes companyDescription", body.includes("Boilerplate"));
  ok("extractBody: strips HTML", !/[<>]/.test(body), body);
  // Ordering is load-bearing: the poller truncates at MAX_DESC_CHARS, so the
  // marketing boilerplate must be what falls off the end, not the qualifications
  // the work-auth and YoE checks read.
  ok(
    "extractBody: jobDescription before qualifications before companyDescription",
    body.indexOf("You will build") < body.indexOf("5 years C++") &&
      body.indexOf("5 years C++") < body.indexOf("Boilerplate"),
    body,
  );
  ok("extractBody: drops empty sections", !body.includes("Additional"));
}
ok("extractBody: empty on missing jobAd", extractBody({}) === "");
ok("extractBody: empty on null", extractBody(null) === "");
ok(
  "extractBody: empty when every section is blank",
  extractBody({ jobAd: { sections: { jobDescription: { text: "" } } } }) === "",
);

/* ---- list parse: the applyUrl regression ----
   The list row has NO applyUrl field — only `ref`, which is the API URL. The old
   `j.applyUrl || j.ref` therefore always emitted the API URL, and every
   SmartRecruiters card sent the reviewer to raw JSON. */
{
  const listRow = {
    id: "744000141561647",
    uuid: "2ee539e0-fa95-4711-aa01-34b27e883f5c",
    name: "Technical Solutions Engineer",
    ref: "https://api.smartrecruiters.com/v1/companies/AristaNetworks/postings/744000141561647",
    company: { identifier: "AristaNetworks", name: "Arista Networks" },
    releasedDate: "2026-08-04T18:44:38.804Z",
    location: { city: "Vancouver", region: "BC", country: "ca" },
  };
  const [j] = ADAPTERS.smartrecruiters.parse(
    { content: [listRow] },
    {
      token: "AristaNetworks",
    },
  );
  ok(
    "parse: applyUrl is the public page, not the API",
    j.applyUrl ===
      "https://jobs.smartrecruiters.com/AristaNetworks/744000141561647",
    j.applyUrl,
  );
  ok(
    "parse: applyUrl never points at the API host",
    !j.applyUrl.includes("api.smartrecruiters.com"),
  );
  ok("parse: id", j.sourceJobId === "744000141561647");
  ok("parse: title", j.title === "Technical Solutions Engineer");
  ok(
    "parse: postedAtClaimed from releasedDate",
    j.postedAtClaimed === "2026-08-04T18:44:38.804Z",
  );
  ok("parse: no body at poll time", j.description === "");
  ok(
    "parse: location joined",
    j.locations[0] === "Vancouver, BC, ca",
    JSON.stringify(j.locations),
  );
}
{
  // company.identifier absent — fall back to the board token we polled.
  const [j] = ADAPTERS.smartrecruiters.parse(
    { content: [{ id: "9", name: "Dev", ref: "x" }] },
    { token: "LLNL" },
  );
  ok(
    "parse: falls back to the board token",
    j.applyUrl === "https://jobs.smartrecruiters.com/LLNL/9",
    j.applyUrl,
  );
}
{
  const rows = ADAPTERS.smartrecruiters.parse({}, { token: "X" });
  ok(
    "parse: empty payload yields no rows",
    Array.isArray(rows) && rows.length === 0,
  );
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("\n  failures:");
  failures.forEach((f) => console.log(`    ✗ ${f}`));
  process.exit(1);
}
console.log("  all green\n");
