# Running it

## One-time setup

```bash
cd ~/Desktop/job-hunt
npm install
npx playwright install chromium
node scripts/set-targets.mjs
```

`set-targets.mjs` pins the 43 curated employers to tier S and re-verifies every
board that has a checkable API, so a dead token cannot sit at the 3-minute
cadence burning polls. Re-run it whenever the target list changes.

`.env` must exist. Required: `MONGODB_URI`, `GROQ_API_KEY`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

## Day to day

```bash
npm start
```

Runs until you stop it with Ctrl-C. Three clocks run independently:

| clock  | interval                    | what it does                               |
| ------ | --------------------------- | ------------------------------------------ |
| poll   | `CYCLE_SECONDS` (180)       | check due boards, ingest and screen        |
| score  | `SCORE_CYCLE_SECONDS` (300) | rank fresh jobs, push the best to Telegram |
| listen | continuous                  | record approve/skip button presses         |

They are separate on purpose. Poll cadence is the product — a posting missed at
08:40 cannot be un-missed at 09:00 — while scoring is bound by the Groq free
tier and can always catch up. When they were chained, the slow recoverable stage
set the pace of the fast unrecoverable one: 8.5 minutes against a 3-minute
target.

Other entry points:

```bash
npm start -- --once          # single pass, useful for checking a change
npm start -- --minutes 60    # run for an hour, then exit
npm run submit               # process the approved queue (DRY RUN by default)
```

Only one loop may run at a time; a second refuses to start. Both would poll the
same boards and drain the same Telegram update queue, which can notify a job
twice.

## Running it unattended

```bash
./ops/install.sh
tail -f logs/jobhunt.log
```

This installs a LaunchAgent that starts at login and restarts on crash. To
remove it:

```bash
./ops/install.sh remove
```

### The part that does not work around a closed laptop

**A closed MacBook does not poll.** `caffeinate -is` in the LaunchAgent prevents
idle and system sleep, but it cannot defeat the lid switch. Closing the lid
suspends the process, and it resumes when you open it — meaning zero coverage
for exactly the 8–10am window this system exists to cover.

Three options, honestly ranked:

1. **Lid open, plugged in, display off.** Free and works today. Put the laptop
   somewhere with power, leave it open, turn the display brightness to zero. The
   LaunchAgent handles the rest.
2. **Move it to a small always-on host.** Oracle Cloud Always Free (an ARM
   instance, genuinely free and permanent) or a Hetzner CX22 at about €4/month.
   The stack is Node plus a Mongo URI, so it lifts and shifts unchanged. This is
   the correct answer if the system proves useful.
3. **An external display with clamshell mode** keeps the machine awake with the
   lid shut, but requires the display and power to be connected.

Option 1 tonight, option 2 within the week. Do not rely on `pmset` overrides to
beat the lid switch — they do not.

### Checking on it

```bash
launchctl list | grep jobhunt          # 2nd column is last exit code, 0 is fine
tail -50 logs/jobhunt.log
tail -50 logs/jobhunt.err.log
```

A healthy poll line looks like:

```
[08:41:12] poll   600 boards · 480 unchanged · 117 changed · 2 new · 2 match
```

`unchanged` should dominate — those are 304s, which cost almost nothing and are
what make a 3-minute cadence affordable across hundreds of boards. If that
column collapses toward zero, conditional GET has broken and the polling budget
is being spent on full responses.

## Tuning

All in `.env`:

| variable              | default | effect                                              |
| --------------------- | ------- | --------------------------------------------------- |
| `CYCLE_SECONDS`       | 180     | poll interval; tier-S cadence                       |
| `SCORE_CYCLE_SECONDS` | 300     | scoring interval                                    |
| `SCORE_PER_CYCLE`     | 8       | jobs scored per pass; raise if quota allows         |
| `NOTIFY_PER_CYCLE`    | 5       | cards per pass                                      |
| `MIN_FIT`             | 70      | score below which nothing is sent                   |
| `MAX_AGE_HOURS`       | 72      | ignore anything older; freshness is the whole point |
| `DAILY_NOTIFY_CAP`    | 40      | ceiling per day                                     |
| `BURST_PER_HOUR`      | 6       | postings/hour that count as a batch drop            |
| `WARM_MAX_GAP_HOURS`  | 1.5     | how recently a board must have been seen to warm it |

`DAILY_NOTIFY_CAP` is set to the top of the stated 20–40/day range. A queue
nobody clears is worse than a short one — if cards go unanswered for a day,
lower this before raising `MIN_FIT`.

## The daily rhythm

1. Cards arrive on Telegram through the day. Approve or skip on the phone; it
   takes a second each and the decision is recorded immediately.
2. In the evening, `npm run submit` — a dry run that tailors, renders and fills
   every field, then screenshots and stops before the submit control.
3. Inspect `out/*.png`.
4. Then, only if the dry run looks right:

```bash
SUBMIT_LIVE_CONFIRM=i-understand npm run submit -- --live --limit 5
```

Two independent switches, because an application cannot be recalled and a bad
one burns that employer.
