# Proprietary career portals — what works, what doesn't

Findings from probing each portal directly. The reusable technique for any new
one is to load the careers SPA in a browser and read its resource timings:

```js
performance.getEntriesByType('resource').map(r => r.name)
  .filter(u => /api|search|job|graphql/i.test(u))
```

That is how the live Microsoft endpoint was found after the documented one
stopped resolving.

| Portal | Status | Detail |
|---|---|---|
| **Amazon** | built | `amazon.jobs/en/search.json` — public JSON, real ETag, `result_limit` caps at 100, `sort=recent`. Richest source in the pipeline: returns full `description` + `basic_qualifications`, so work-auth and YoE checks actually run instead of degrading to 'unknown'. |
| **Microsoft** | built | `apply.careers.microsoft.com/api/pcsx/search` — public JSON, no auth. Page size fixed at 10 (`num` is accepted and ignored), `start` paginates, no ETag so change detection uses a page-0 fingerprint. |
| **Apple** | browser-only (confirmed twice) | Server-renders results into a `__ACGH_DATA__` script tag at `loaderData.search.searchResults`. Extraction works, but plain HTTP returns **zero** results where a browser returns 20 — Apple gates SSR on something curl doesn't send. No XHR fallback: client-side navigation fires no API call (verified). Needs a real browser session. Retried with a primed cookie jar and full `Sec-Fetch-*` navigation headers — still zero. |
| **Google** | no clean API | Careers runs on `boq` and fetches via obfuscated `batchexecute` RPC. No JSON endpoint, no embedded JSON, no usable job links in the DOM. 1,017 results visible in-browser but unreachable programmatically. |
| **Meta** | not attempted past probe | `metacareers.com/graphql` returns 400 without session tokens. |
| **Bank of America** | built | `/services/jobssearchservlet` — found with the recipe above. `search` is a MODE not a query (`search=software engineer` returns 0; `search=getAllJobs` returns all 2,054). Critically, `start` is an offset WITHIN the returned set, not a global cursor: `start=100&rows=100` returns 0 rows while `start=10&rows=100` returns 90. So one request with a large `rows` fetches everything — there is no page loop. Payload includes `jobDescriptionExternal` and structured `minYearsOfExperience`. |

## Coverage for the ones that don't work

These are not blind spots in practice:

1. **Alert emails.** All four run their own job-alert emails. `src/adapters/email.js`
   parses them, and a dedicated address per source (`apple@`, `google@`) gives
   attribution for free. ToS-clean, no scraping.
2. **Community feeds.** Google, Meta and Apple new-grad postings routinely appear
   in the GitHub feeds already harvested by `seed/discover-companies.mjs`.
3. **Workday.** Many large enterprises — including most big banks — are Workday
   tenants and are already covered by that adapter.

Adding one later is a config entry plus a normalizer, not a redesign: the poller
is ATS-agnostic and every adapter returns the same shape.
