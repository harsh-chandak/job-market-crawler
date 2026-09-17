# Metric provenance and how to defend each claim

Written while the measurements were still remembered. The original dashboards
and logs are gone, so this file is the record — if a number here cannot be
traced to a method below, it should not be on the resume.

## The principle

Every number on the resume is an **estimate from a real measurement**, not a
figure from a monitoring system. That is normal and defensible. What is not
defensible is presenting an estimate with the precision of a measurement.

So: hedged language ("roughly halved", "well over half", "nearly half") rather
than invented precision ("47%"). A specific number asserts a specific
measurement, and the follow-up question is always _how did you measure it_.

**Volunteer the method before being asked.** Saying "this was a Postman
spot-check, not production telemetry" up front reads as rigour. Being walked
into that admission reads as padding. Same fact, opposite impression.

## Per-claim scripts

### Precision 0.999 across 19 personas — Example Corp

**This claim was previously overstated and has been corrected.** The bank used
to say "zero false positives on a 43K+ catalogue", which fused two unrelated
numbers: 43K is the size of the catalogue, while the precision measurement came
from a much smaller validation run. Stated together they imply exhaustive
verification across 43K scholarships, which did not happen. That is the kind of
claim that collapses on the first follow-up question.

**Method:** a read-only precision/recall QA on the dev environment, reusing the
real evaluator and projection against the live rule library — 19 student
personas against 1,382 ruled scholarships, plus a live end-to-end call.
Measured precision 0.99896, with no false positives on the enforced tier.

> "I built a read-only evaluation harness that ran the real evaluator against
> the live rule library — 19 student personas across about 1,400 ruled
> scholarships. Precision came out at 0.999, no false positives on the enforced
> tier. We optimised for precision over recall deliberately: a wrong match
> wastes a student's application, a missed one just isn't seen."

Say "across 19 personas" or "on the validation set" — never "across the
catalogue". The harness is the strong part of this story; it means the number
was produced by a repeatable measurement rather than by spot-checking.

### Reranker 17s to 3.8s, then a further 40-66% p50 — Example Corp

**Method:** measured p50 latency on the matching path before and after two
changes, recorded in the merged-PR history.

> "The reranker was taking about 17 seconds. Index-keying the scoring path
> brought it to under four. After that I added two tunable levers — rerank pool
> size and prompt truncation — which cut p50 by another 40 to 66 percent
> depending on how aggressively you set the top-N. The levers are console-
> tunable, so it is a trade dial rather than a fixed setting."

The strongest performance claim in the set, and the mechanism is stated, so the
number is derivable rather than asserted.

### Zero LLM calls on a full cache hit — Example Corp

**Method:** design property, not a measurement. The rerank-score and
query-embedding caches are deterministic and keyed on the inputs, so a complete
hit serves the response without invoking a model at all.

> "The caches are deterministic and keyed on the request inputs, so on a full
> hit the match is served without any model call. That's a property of the
> design rather than a benchmark — the interesting part was making the scoring
> deterministic enough that caching it was safe."

### ~25% recall recovery across 320 awards — Example Corp

**Method:** identified during the validation run above. Un-canonicalized rule
values on residency, citizenship and year-in-school suppressed eligible matches;
the affected population was counted, not estimated.

> "During validation I found rule values that weren't canonicalized to entity
> IDs, so eligible students were being filtered out. I'd already shipped the fix
> for intended_major — that one surfaced about 88 scholarships — and I
> documented the same class of problem across three more fields, roughly 25
> percent of true matches on 320 awards."

State clearly which part shipped and which part was documented for later. Both
are creditable; conflating them is not.

### Roughly halved inference cost by batching — Example Corp

**Method:** before/after comparison of provider spend once requests were
batched rather than sent per-item.

> "Before batching we made one model call per item; after, we grouped them. The
> provider bill for that pipeline came down to about half. That's from comparing
> spend across runs, not a cost dashboard — call it approximate."

### Halved model calls, 4 parallel workers, ~8x total runtime — ASU

**Strongest claim on the resume. It is arithmetic, not a measurement.**

> "Two changes compounded. We generated four candidates per input and scored
> them with a rubric; I found two were enough for the same output quality, which
> halved the model calls. Then I ran execution across four async workers instead
> of sequentially. Two times four is roughly eight, and wall-clock on our test
> set matched that."

The resume says "halved model calls per input" rather than "reduced K from 4 to
2". K is internal shorthand — a reviewer outside the team reads it as noise, and
the plain phrasing carries the same fact. Use K only if the interviewer is
already talking about candidate generation.

Because the mechanism is stated, the number is derivable. This is the most
credible form a metric can take — offer this one first when asked for impact.

### P95 latency cut by nearly half — ASU ingestion

**Method:** Postman timings before and after adding idempotency and
backpressure, over a handful of runs. Not production telemetry.

> "I measured request latency in Postman across several runs before and after.
> P95 came down by close to half. It was a local benchmark rather than
> production monitoring, so I'd treat it as indicative."

### 20K+ req/day via indexing and Redis — ERP Co.

**Method:** query indexing plus Redis caching on hot read paths. The latency
improvement here had the widest margin of the whole set, so no magnitude is
claimed on the resume — the throughput figure carries the bullet instead.

> "The slow endpoints were doing repeated uncached lookups. Adding the right
> indexes and caching hot reads brought them down substantially — I'd say more
> than half, but I no longer have the figures, so I don't put a number on it.
> The throughput number, 20K+ requests a day, I'm confident in."

Deliberately unquantified on latency: five separate bullets were converging on
"about half", which flattened distinct achievements into one repeated claim.
Where a bullet already carries a solid figure, a second soft magnitude adds
repetition rather than information.

### 20K+ req/day, 2K+ events/day, 70+ clients, 50+ PRs, 7 microservices

Counts, not estimates. Safe to state plainly. Know roughly how they were
counted (client list, service inventory, merged PRs).

## Questions to expect

**"How did you measure that?"** — answer with the method in one sentence, then
say what it was not. Never bluff a methodology.

**"Can you walk me through the biggest performance win?"** — use the ASU 8x. It
is the one where mechanism, arithmetic and result all line up.

**"These look approximate."** — agree, immediately. "They are. I've written them
as estimates rather than precise figures because I no longer have the
dashboards." Confidence about the limits of your own data is a senior trait.

## Conflicts with MASTER RESUME (SOURCE OF TRUTH).pdf

That document was reviewed as source material. It carries four figures that
contradict this bank. **`resume/bullets.yaml` wins on every number and every
duration** — confirmed by the candidate. Recorded here so the PDF cannot quietly
re-contaminate the bank on a later pass:

| claim              | bank (authoritative)     | master PDF (rejected) |
| ------------------ | ------------------------ | --------------------- |
| ERP Co. API load | 20K+ req/day             | ~30K requests/day     |
| ERP Co. latency  | deliberately unquantified | ~60% reduction        |
| ASU async speedup  | ~8x end to end           | ~40% runtime reduction |
| ASU appointment    | Aug 2025 – May 2026, part-time | split into two roles, Dec 2025 – Present |

The ASU speedup is the one that mattered. A ~40% runtime reduction is 1.7x; the
bank claims 8x. Those are not two phrasings of one result, and 8x is the version
with a stated mechanism (K=4 to K=2, times four async workers) — which is why it
survives an interview and the other would not.

The master PDF also omits Example Corp entirely. The bank keeps it; it is the
current role.

### 5K events/min at sub-second latency — Kafka to Neo4j pipeline

**Method:** both figures were pass conditions for a graded course project,
verified as test cases. The pipeline had to sustain 5K events/min *and* stay
under a second to be accepted, and it did.

> "That was a course project. Both numbers were pass conditions — it had to
> sustain 5K events a minute and stay under a second of latency, and those were
> test cases rather than benchmarks I ran myself. The pipeline met both. I don't
> know where its ceiling was, because I never pushed past the requirement."

The pairing is what makes this strong. Throughput alone can be bought by
queueing — latency degrades while the count still clears. Holding both at once
is the harder claim and the one that says something about the design, which is
why backpressure control belongs in the same bullet: it is the mechanism that
makes the two compatible.

This is unusually clean provenance: a third party set the bar and the system was
tested against it. Two rules follow from what it is:

- Say **"sustained"**, never "scaled to" or "peaked at". A cleared threshold is
  a floor, not a ceiling, and claiming a ceiling invites a question with no
  answer.
- Volunteer that it was coursework. It sits under Projects, not Experience, so
  nothing is being hidden — but saying it first costs nothing and being caught
  implying production experience costs a lot.

Both halves are confirmed as stated test conditions. Neither is an estimate,
which makes this the only claim in the set with no error bar to disclose.

## What is deliberately not claimed

- No "100% precision" — no matching system achieves it, and the claim invites
  doubt about everything near it. "Zero false positives, precision chosen over
  recall" is the true and stronger version.
- No company-growth attribution. The modules that supported growth from 5 to 70+
  clients are provable; "drove 14x growth" is not.
- No duration claim. With the ASU role part-time the defensible total is ~2
  years full-time equivalent, and the summaries read fine without a number.
