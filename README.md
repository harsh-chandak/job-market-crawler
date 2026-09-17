# Job Market Crawler and LLM Ranker

A single-user job pipeline. It polls ATS boards directly, screens
deterministically, ranks before it ever calls a model, and measures its own
detection latency.

This is a public mirror of a private working repository. The applications
database, the rendered resumes and the outreach records stay in the private one:
what is here is the code, not the job search.

## Why direct ATS polling

Applicant volume arrives _after_ aggregators index a posting. The gap between a
company's ATS publishing a req and LinkedIn/Indeed surfacing it runs from ~20
minutes to over a day. Polling boards directly means applying while the posting
is effectively invisible to everyone else. That gap is the entire edge — not
speed against other bots, speed against indexing.

## Status

| Stage                                    | State                           |
| ---------------------------------------- | ------------------------------- |
| Company discovery (harvest + verify)     | ✅ 1,867 live boards            |
| Tiered polling w/ conditional GET        | ✅ 100% 304 on unchanged boards |
| Freshness, repost detection, clustering  | ✅                              |
| Deterministic screen                     | ✅ 67 tests                     |
| Latency SLA measurement                  | ✅                              |
| Sponsorship enrichment (H-1B / E-Verify) | ⬜ next                         |
| Workday + proprietary (FAANG) adapters   | ⬜                              |
| LLM fit scoring | ✅ provider-agnostic, runs keyless on Ollama |
| Resume tailoring | ✅ bullet-bank selection, fabrication impossible by construction |
| Telegram approve loop | ✅ one-tap, verified live |
| Playwright submit | ✅ dry-run default, required-field gate |

## Setup

```bash
npm install
cp .env.example .env      # add MONGODB_URI
npm run seed:discover     # harvest + verify ATS tokens  → seed/out/companies.json
npm run seed:import       # load into Mongo
npm run poll -- --limit 2000   # first full sweep
node scripts/retier.mjs   # assign tiers from observed matches
npm run stats
```

Then run continuously:

```bash
npm run poll:loop
```

## Design decisions worth knowing

**`firstSeenAt` is our clock and the only freshness ground truth.** A board's
claimed post date is stored as `postedAtClaimed` and never trusted — reposting
a 45-day-old req resets it, and sprinting to be applicant #301 is worthless.

**`contentHash` catches those reposts.** Same company + title + body under a new
req id means a stale posting wearing a fresh date. Flagged and deprioritized.

**`clusterKey` collapses one role across N locations** into a single card, so
Amazon posting the same SDE-1 in 40 cities doesn't flood the queue.

**Conditional GET is load-bearing.** All four ATS honor `If-None-Match`, so most
polls cost a 304 with no body — that's what makes 3-minute tier-S polling
affordable at ~1.8 requests/sec across 1,867 boards.

Note: Node's global `fetch` (undici) does **not** produce a 304 from Lever's API
even when replaying the exact ETag it just returned — verified by A/B against
curl and `node:https`, which both do. `src/util/http.js` uses `node:https`
directly for this reason. Don't "simplify" it back to `fetch`.

**Workday needs its own module.** It is POST-based, paginated at 20 rows, and
serves no ETag, so conditional GET is impossible. Instead page 0 is fingerprinted
(total + job paths) and an unchanged fingerprint reports `not_modified` — one
small POST instead of full pagination. Results are ordered newest-first
(verified: offset 0 → "Posted Today", offset 400 → "Posted Yesterday"), so
reading the first 5 pages reads the freshest slice rather than paginating 900
pages through CVS Health's 17,992 roles. Workday throttles hard under
concurrency: a 429 mid-pagination used to break the loop and return a short page
set as a clean success, which made a 684-job board report 21 jobs and look like
a filter problem. It now backs off, and a genuinely partial read withholds the
fingerprint so the next poll re-fetches instead of reporting `not_modified`.

**LinkedIn and Indeed are read from alert emails, not scraped.** Neither has a
public jobs API for individuals, and automating the logged-in site risks the
account you also need for networking. `src/adapters/email.js` parses alert
emails — data those services choose to send you. Postings arriving only by email
have no description (LinkedIn gates it behind auth), so body checks degrade to
'unknown'; the high-value case is an alert pointing at a board already polled
directly, which `linkToAtsCandidate` detects for reconciliation.

**Tiers are earned, not assigned.** A board reaches tier S by actually posting
roles that clear the screen. `scripts/retier.mjs` recomputes from evidence.

**Only screen-passing jobs are persisted.** Storing the ~95% that fail would push
a full sweep past 1.2M documents — far past the 512MB Atlas free tier — for data
never read. Rejections are still counted in `poll_log`, so coverage auditing is
unaffected. Set `STORE_SCREENED_OUT=true` to keep everything.

**Silence on sponsorship is not a green light.** `workAuth: 'unknown'` (95% of
postings) means the JD said nothing. The company-level H-1B history and E-Verify
join decides — that's the next build step, and it matters more than usual here:
the STEM OPT extension _requires_ an E-Verify employer, so a company that
sponsors H-1B but isn't E-Verify enrolled silently costs 24 months of runway.

## Applying — the safety model

`submit-queue.mjs` is DRY RUN by default. A dry run does everything a live run
does — tailors, renders the PDF, fills every field, answers work authorization —
then screenshots and stops before the submit control. Going live needs both
`--live` and `SUBMIT_LIVE_CONFIRM=i-understand`, because a mistyped flag should
not be able to fire twenty applications.

Three things will refuse to submit, in live mode too:

- **Unanswered required fields.** Company-specific questions ("are you
  physically based in New York and willing to come in 5 days a week", "any
  blockchain experience") cannot be answered without inventing an answer.
  Submitting blanks consumes the posting and it cannot be retried cleanly.
- **A visible CAPTCHA challenge.** Never solved or circumvented — handed back
  for manual completion. Note the distinction: Greenhouse embeds an *invisible*
  reCAPTCHA badge on nearly every board, and treating that as a blocker would
  abort the single largest source. Only a visible challenge frame stops a run.
- **A fabrication check failure.** Every rendered string must appear verbatim in
  the bank.

## Layout

```
seed/discover-companies.mjs   harvest ATS tokens from public feeds, verify each
src/db.js                     single-user Mongo (no master/tenant split)
src/adapters/index.js         greenhouse | lever | ashby | smartrecruiters
src/adapters/workday.js       POST + fingerprint change detection
src/adapters/amazon.js        search.json, full JDs, real ETag
src/adapters/microsoft.js     pcsx search API
src/adapters/email.js         LinkedIn/Indeed alert emails
src/util/http.js              conditional GET over node:https
src/util/normalize.js         contentHash, clusterKey, company/title normalization
src/util/location.js          US-eligibility gate + Phoenix-metro flag
src/filter.js                 deterministic screen (67 tests)
src/poller.js                 tiering, ingest, repost detection, burst detector
scripts/                      import, poll, loop, retier, stats, rescreen, tests
```

## Lineage

Ports four components from `Next/job-alerts` (the multi-tenant version):
the data-driven `responseMapping` adapter model, the Mongo work queue with
lease/backoff, the Puppeteer launch/recycle patterns, and the `sentJobs`
application tracker. Multi-tenancy, JWT auth, and per-user tenant DBs are
deliberately dropped — there is one user.

`src/filter.js` is a rewrite, not a port. The original had three bugs:
`ex.replace(/\W/g,'')` collapsed multi-word phrases before building the regex
(so `\bvicepresident\b` and `\b5years\b` could never match — roughly half the
exclusion list was dead code), ~10 duplicated entries, and substring INCLUDE
matching that let `'ml'` match "HTML/CSS Designer". Regression tests for all
three are in `scripts/test-filter.mjs`.
