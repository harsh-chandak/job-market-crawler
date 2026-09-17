/**
 * Burst detector: does a board earn the 3-minute cadence?
 *
 * The regression that prompted this: thresholds were raw counts, so a tier-C
 * board polled six hours ago that had gained ten roles tripped the same wire as
 * a tier-S board that gained ten in three minutes. One sweep put 44 of 600
 * boards on burst cadence. The cases below fix the shape of the rule — the same
 * delta must resolve differently depending on the observation window.
 */

import { burstVerdict } from "../src/poller.js";

let pass = 0;
let fail = 0;

const check = (name, got, want) => {
  const ok = got === want;
  if (ok) pass++;
  else fail++;
  console.log(
    `  ${ok ? "✓" : "✗"} ${name}${ok ? "" : `  (got ${got}, want ${want})`}`,
  );
};

console.log("burst detector\n");

// --- the core asymmetry: identical delta, different window -----------------
check(
  "+10 roles in 3 minutes is a batch drop",
  burstVerdict({ prevOpen: 40, nowOpen: 50, hoursSince: 0.05 }).reason,
  "rate",
);
check(
  "+10 roles over 6 hours is ordinary hiring",
  burstVerdict({ prevOpen: 40, nowOpen: 50, hoursSince: 6 }).burst,
  false,
);

// --- first poll ingests a backlog, which is not a burst --------------------
check(
  "first successful poll never bursts",
  burstVerdict({
    prevOpen: null,
    nowOpen: 684,
    hoursSince: null,
    inserted: 684,
  }).burst,
  false,
);
check(
  "prevOpen undefined is also treated as a first poll",
  burstVerdict({
    prevOpen: undefined,
    nowOpen: 300,
    hoursSince: 1,
    inserted: 300,
  }).burst,
  false,
);

// --- absolute floor: tiny deltas are noise regardless of rate --------------
check(
  "+2 roles in a minute is below the absolute floor",
  burstVerdict({ prevOpen: 100, nowOpen: 102, hoursSince: 1 / 60 }).reason,
  "quiet",
);
check(
  "+3 roles in a minute clears the floor and the rate",
  burstVerdict({ prevOpen: 100, nowOpen: 103, hoursSince: 1 / 60 }).reason,
  "rate",
);

// --- relative rule catches small boards the absolute rule would miss -------
check(
  "small board growing 30%/hr qualifies on the relative rule",
  burstVerdict({ prevOpen: 10, nowOpen: 13, hoursSince: 1 }).reason,
  "rate",
);
check(
  "large board gaining the same 3 roles in an hour does not",
  burstVerdict({ prevOpen: 500, nowOpen: 503, hoursSince: 1 }).burst,
  false,
);

// --- warm rule: clustering, gated on how recently we looked ---------------
check(
  "one fresh posting on a board seen 5m ago warms it",
  burstVerdict({ prevOpen: 50, nowOpen: 50, hoursSince: 0.08, inserted: 1 })
    .reason,
  "warm",
);
check(
  "one fresh posting on a board last seen 6h ago does not",
  burstVerdict({ prevOpen: 50, nowOpen: 50, hoursSince: 6, inserted: 1 }).burst,
  false,
);
check(
  "warm is not reported as a burst event",
  burstVerdict({ prevOpen: 50, nowOpen: 50, hoursSince: 0.08, inserted: 1 })
    .reason === "rate",
  false,
);

// --- shrinking and static boards ------------------------------------------
check(
  "board that lost roles is quiet",
  burstVerdict({ prevOpen: 60, nowOpen: 45, hoursSince: 1 }).burst,
  false,
);
check(
  "unchanged board with no inserts is quiet",
  burstVerdict({ prevOpen: 60, nowOpen: 60, hoursSince: 1, inserted: 0 })
    .reason,
  "quiet",
);

// --- the real-world cases the old detector flagged ------------------------
// Observed in a live sweep. The first two are genuine drops and must still
// fire; the last is the false-positive class that motivated the fix.
check(
  "warnerbros +60 within the hour still fires",
  burstVerdict({ prevOpen: 240, nowOpen: 300, hoursSince: 1 }).reason,
  "rate",
);
check(
  "intel +40 over 6 hours still fires on rate",
  burstVerdict({ prevOpen: 400, nowOpen: 440, hoursSince: 6 }).reason,
  "rate",
);
check(
  "tier-C board +1 over 6 hours no longer fires",
  burstVerdict({ prevOpen: 20, nowOpen: 21, hoursSince: 6, inserted: 1 }).burst,
  false,
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
