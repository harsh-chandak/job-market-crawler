/** Stack- and domain-mismatch tests — no network, no DB. node scripts/test-prerank.mjs */
import { stackMismatch, domainMismatch } from "../src/prerank.js";
import { descriptionText } from "../src/poller.js";

let pass = 0, fail = 0; const failures = [];
const ok = (n, c, d = "") => (c ? pass++ : (fail++, failures.push(`${n}${d ? ` — ${d}` : ""}`)));
const st = (t) => stackMismatch(t).points;
const dm = (b, t = "") => domainMismatch(b, t).points;

/* ---- non-word boundaries. Every one of these silently matched nothing when
   the pattern was written \bc#\b or \bc++\b or \b.net\b. ---- */
ok("c# fires",            st("Required: C# and .NET experience") === -30);
ok("c# no trailing \\b",   st("c#-based backend") === -30);
ok("c++ fires",           st("Strong C++ skills required") === -30);
ok("c++ with suffix",     st("modern C++17") === -30);
ok(".net fires",          st("built on .NET 8") === -30);
ok("asp.net fires",       st("ASP.NET Core services") === -30);

/* ---- .net must not match a domain name ---- */
ok(".net domain ignored",  st("apply at careers.robinhood.net today") === 0);
ok(".net domains plural",  st("see foo.net and bar.net") === 0);

/* ---- "go" is a verb before it is a language ---- */
ok("golang fires",         st("Golang microservices") === -12);
ok("written in go",        st("services written in Go") === -12);
ok("go beside a peer",     st("Kubernetes platform, Go and Terraform") === -12);
ok("go-to-market spared",  st("we go to market fast") === 0);
ok("go-getter spared",     st("a go-getter who can go above and beyond") === 0);
ok("go through spared",    st("go through the onboarding") === 0);

/* ---- java is a prefix of javascript ---- */
ok("java fires",           st("Build services in Java and Kotlin") === -30);
ok("javascript spared",    st("JavaScript and CSS") === 0);

/* ---- the rule only fires on an ABSENCE of his stack ---- */
ok("polyglot spared",      st("We use Python and C++ across the stack") === 0);
ok("his stack spared",     st("TypeScript, Node.js and Postgres") === 0);
ok("no language spared",   st("Strong engineering fundamentals, any language") === 0);
ok("empty spared",         st("") === 0);

/* ---- weight scales with how much of the posting he cannot do ---- */
ok("one weak lang",        st("Golang services") === -12);
ok("two weak langs",       st("Go/Rust backend") === -20);
ok("one strong lang",      st("C++ and MATLAB for controls") === -30);

/* ---- domain: hard markers are required, boilerplate alone is not enough ---- */
ok("boilerplate spared",
  dm("we build autonomous vehicles and robotics", "Software Engineer - Python") === 0);
ok("cuda kernel spared",
  dm("CUDA kernel optimization for LLM inference", "ML Infra Engineer") === 0);
ok("fraud radar spared",
  dm("fraud radar dashboard, react and rest api", "SE, Trust") === 0);
ok("one hard marker alone spared",
  dm("some firmware is involved", "Backend Engineer") === 0);
ok("hard + context fires",
  dm("linux kernel module and firmware for robotics", "SE II - Operating System") < 0);
ok("title marker weighs more",
  dm("embedded systems work, robotics", "Embedded Software Engineer") <=
    dm("embedded systems work, robotics", "Backend Engineer"));

/* ---- descriptions are converted before they are cut, not after ---- */
ok("html converted",       descriptionText("<p>Hello <strong>world</strong></p>") === "Hello world");
ok("plain text untouched", descriptionText("plain text with a < sign") === "plain text with a < sign");
ok("list becomes bullets", descriptionText("<li>Python</li><li>C++</li>") === "• Python\n• C++");
ok("empty safe",           descriptionText("") === "");
ok("conversion is idempotent",
  descriptionText(descriptionText("<p>Java only</p>")) === "Java only");

/* ---- the whole point: converting first lets the stack rule see requirements ---- */
const buried = `<div>${"<span>About the company blah</span>".repeat(160)}<p>Required: C# and .NET</p></div>`;
ok("requirements survive the cap", st(descriptionText(buried)) === -30,
  `len=${descriptionText(buried).length}`);
ok("raw html would have missed it", st(buried.slice(0, 5000)) === 0);

console.log(failures.map((f) => `  FAIL ${f}`).join("\n"));
console.log(`\n  ${pass} passed, ${fail} failed`);
console.log(fail ? "  FAILURES" : "  all green");
process.exit(fail ? 1 : 0);
