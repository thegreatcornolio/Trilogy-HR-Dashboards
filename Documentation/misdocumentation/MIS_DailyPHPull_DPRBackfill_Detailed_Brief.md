# MIS-DailyPHPull & MIS-DPRBackfill — Detailed Brief

## Context
Trilogy BPO (NADClinic campaign), MIS Dashboard 3.0. These two Power Automate flows are the ingestion layer that populates the `mis_agent_ph_daily` table in Azure SQL (TrilogyMIS database on trilogy-hr.database.windows.net), which the Daily Profit Report (DPR) reads from.

**⚠️ CRITICAL STATUS: Both flows are currently BROKEN at the root-cause level and need to be rebuilt, not patched.** See "Known Critical Issue" section below before doing anything else with these flows.

---

## Purpose of Each Flow

### MIS-DailyPHPull
- **Trigger:** Recurrence, scheduled 04:00 UTC daily.
- **Purpose:** Pulls the *previous* SA-local day's agent productive hours (PH) from qContact and inserts one row per agent into `mis_agent_ph_daily`.
- **Status:** Built and "validated" against the old (now known-flawed) methodology. Fully functional in the sense that it runs without error — but the numbers it produces are wrong (see below).

### MIS-DPRBackfill
- **Trigger:** Manual (for one-off/on-demand runs).
- **Purpose:** Loops from June 12, 2026 to present, calling the same per-day logic as MIS-DailyPHPull for each date in the range, to backfill historical rows that didn't exist yet when DPR was first built.
- **Status:** Same as above — runs successfully, but the historical rows it wrote are now known to be inflated and not trustworthy.

---

## Data Source & API Details

- **qContact endpoint used:** `POST /api/v2/entities/Report/actions/user_breakdown`
- **Timestamps:** ISO8601 UTC. SA-local midnight = 22:00 UTC the *previous* calendar day (SA is UTC+2, no DST).
  - Example: for SA-local June 20, the query window is `start: "2026-06-19T22:00:00.000Z"`, `stop: "2026-06-20T21:59:59.000Z"` (or similar end-of-day boundary — confirm exact stop time convention before rebuilding).
- **PH is calculated from the `durations` block in the response** — NOT the `ush_durations` block. (Two parallel duration breakdowns exist in the qContact response; `durations` was chosen as the source of truth for billable time.)
- **Pause code mapping (from `durations` keys):**
  - Pause code 3 = Client Training → **billable**
  - Excluded (non-billable) codes: LoggedOut, Lunch, Meeting, Tea Break, Body Break, Internal Training
  - **Pause code 6 treatment is unconfirmed** — never observed in real data yet, no rule defined.

---

## Billing Agent Logic

- **Demi Bennett** (user_id 25841828980) — billed at actual PH × £10.50/hr
- **Mia Herselman** — billed at actual PH × £10.50/hr
- **Nathaniel Debique** — team leader, flat rate: 135 hrs ÷ working days in month, proportioned. His `billing_amount` is stored as **NULL** in the table and calculated at display time in the DPR frontend (not in these ingestion flows). His actual PH is tracked separately for reference but does not drive his billing.

**Working days** = Monday–Friday, excluding South African public holidays, looked up from the `SAPublicHolidays` table in TrilogyMIS.

---

## Table Schema Notes: `mis_agent_ph_daily`

One row per agent per SA-local calendar day. Stores raw duration buckets, not just the final PH figure, so historical PH could be recomputed if the billing definition changes without re-calling qContact (this design intent is exactly why the current recompute-from-raw-data fix is feasible).

| Column | Type | Notes |
|---|---|---|
| report_date | DATE | SA-local calendar day this row represents |
| user_id | BIGINT | qContact user id |
| agent_name | NVARCHAR(100) | |
| CampaignCode | NVARCHAR(50) | Added post-creation via `ALTER TABLE`, default `'NADClinic'` |
| logged_out_sec … internal_training_sec | FLOAT ×13 | One column per duration bucket (see key table below) |
| ph_seconds | FLOAT | Computed per the (now-known-flawed) formula below |
| ph_hours | FLOAT | ph_seconds / 3600 |
| billing_amount | DECIMAL(10,2) NULL | NULL for Nathaniel always; populated for Demi/Mia |
| is_working_day | BIT | Mon–Fri AND not in SAPublicHolidays, computed at insert time |
| source | NVARCHAR(20) | `'daily_flow'` or `'backfill'` |
| pulled_at | DATETIME2 | |

Unique constraint: `UQ_mis_agent_ph_daily_date_user` on `(report_date, user_id)`.

### `mis_import_log` — FileType constraint
```sql
ALTER TABLE mis_import_log DROP CONSTRAINT CK_mis_import_log_FileType;
ALTER TABLE mis_import_log ADD CONSTRAINT CK_mis_import_log_FileType
    CHECK (
        FileType = 'ConvHistory' OR
        FileType = 'QueueAnswered' OR
        FileType = 'UserProductivity' OR
        FileType = 'ContactActivity' OR
        FileType = 'DPR_PH'
    );
```
Both flows log under `FileType = 'DPR_PH'`.

---

## Flow Structure & Naming Conventions (as actually built)

### MIS-DailyPHPull — full action sequence

**Trigger:** Recurrence, Day/interval 1, time set to **04:00 UTC** (= 06:00 SAST, since SA is UTC+2 year-round, no DST).

**Sequence:**
1. `Get tokens` — HTTP POST to `https://nadclinic.qcontact.com/api/v2/auth/sign_in`, sign-in body `{"email": ..., "password": ...}`. Response **headers** (not body) carry `access-token`, `token-type`, `client`, `expiry`, `uid`. Signed in **once per run** — not once per API call.
2. `Compose_YesterdayDate` / commonly referenced as `YesterdayDate`:
   ```
   formatDateTime(addDays(utcNow(), -1), 'yyyy-MM-dd')
   ```
3. `RangeStart`:
   ```
   addHours(startOfDay(addDays(utcNow(), -2)), 22)
   ```
4. `RangeStop`:
   ```
   addMinutes(addHours(startOfDay(addDays(utcNow(), -1)), 21), 59)
   ```
   (SA midnight = UTC 22:00 the previous day; these three were verified against a known day — e.g. confirmed June 29 → produces `2026-06-28T22:00:00Z` / `2026-06-29T21:59:00Z` — before being trusted.)
5. `AgentList` — Compose, static array:
   ```json
   [
     { "user_id": 25841828980, "agent_name": "Demi Bennett" },
     { "user_id": 25841782587, "agent_name": "Mia Herselman" },
     { "user_id": 25841702797, "agent_name": "Nathaniel Debique" }
   ]
   ```
6. `Apply_to_each` — loops `AgentList`. **Degree of Parallelism = 1** (sequential, deliberate). Inside:
   - `HTTP 1` — POST to `user_breakdown`, body:
     ```json
     {
       "user": <current agent's user_id>,
       "start": "@{outputs('RangeStart')}",
       "stop": "@{outputs('RangeStop')}"
     }
     ```
   - `Parse JSON` — parses the `durations` block (numeric-string keys `"0"`–`"5"`, `"5_1"`–`"5_7"`, all nullable — not every bucket appears every day).
   - `TotalSeconds`, `ExclusionsSeconds`, `PHSeconds` — Compose actions computing:
     ```
     total = 0 + acd_available + communicating + idle + wrapup + logged_out + paused_total
     ph_seconds = total - logged_out - lunch - meeting - tea_break - body_break - internal_training
     ```
     (Client Training `5_3` and unconfirmed `5_6` deliberately excluded from subtraction — treated as billable.) Use `coalesce(body('Parse_JSON')?['durations']?['5_1'], 0)`-style null-safe access for every bucket — keys are sometimes entirely absent.
   - `CheckHoliday` — SQL lookup against `SAPublicHolidays` for the date.
   - `IsWorkingDay` — day-of-week (Mon–Fri) AND absent from `SAPublicHolidays`.
   - `BillingAmount` — **current, final (reverted-to-simple) expression:**
     ```
     if(
       equals(items('Apply_to_each')?['user_id'], 25841702797),
       null,
       mul(div(outputs('PHSeconds'), 3600), 10.50)
     )
     ```
     (Nathaniel's flat-rate calc was deliberately moved to the dashboard/display layer, not computed here — see note below.)
   - `InsertPHRow` — parameterized SQL INSERT into `mis_agent_ph_daily`, `source = 'daily_flow'`.
7. After the loop closes: one `Execute a SQL query (V2) 2` action — INSERT into `mis_import_log`:
   ```sql
   INSERT INTO mis_import_log (
       CampaignCode, ReportDate, FileType, RowsImported, Status, ErrorMessage, ImportedAt
   )
   VALUES (
       'NADClinic', '@{outputs('YesterdayDate')}', 'DPR_PH', 3, 'Success', NULL,
       '@{utcNow('yyyy-MM-ddTHH:mm:ss')}'
   )
   ```

**Loop-item reference convention for this flow:** `items('Apply_to_each')?['user_id']` — this flow's loop is simply named `Apply_to_each` (the PA default name, never renamed). **Do not confuse with the backfill flow's loop names** (see below) — this caused at least one real bug during the original build when expressions were cross-pasted between the two flows.

---

### MIS-DPRBackfill — full action sequence

**Trigger:** Manual (one-time historical run). **Backfill start date: 2026-06-12** — chosen as the earliest date with any evidence of qContact data in the system (earliest `mis_import_log` row). This is a **proxy, not an independently confirmed campaign go-live date** — still flagged as an open assumption.

**Sequence:**
1. `Get tokens` — same sign-in call as the daily flow, done **once**, before the outer date loop (not per-date, not per-agent).
2. `DateList` — Compose, generates an array of day-offsets:
   ```
   range(0, add(div(sub(ticks(utcNow()), ticks('2026-06-12')), 864000000000), 1))
   ```
3. `Apply_to_each_Date` — outer loop over `DateList`. Inside, per date index:
   - `LoopDate`: `formatDateTime(addDays('2026-06-12', item()), 'yyyy-MM-dd')`
   - `LoopRangeStart` / `LoopRangeStop` — same SA-midnight-boundary logic as the daily flow's `RangeStart`/`RangeStop`, but based on `LoopDate` instead of "yesterday."
   - `AgentList` — same static 3-agent array as the daily flow, defined fresh inside this loop.
   - `Apply_to_each_Agent` — **inner loop**, Degree of Parallelism = 1. Inside: identical logic to the daily flow's per-agent block (`HTTP 1`, `Parse JSON`, `TotalSeconds`/`ExclusionsSeconds`/`PHSeconds`, `CheckHoliday`, `IsWorkingDay`, `BillingAmount`, `InsertPHRow`), with `source = 'backfill'`.
4. After **both** loops close (outer date loop, not inner agent loop): one summary `Execute a SQL query` INSERT into `mis_import_log`:
   ```sql
   INSERT INTO mis_import_log (
       CampaignCode, ReportDate, FileType, RowsImported, Status, ErrorMessage, ImportedAt
   )
   VALUES (
       'NADClinic',
       '@{formatDateTime(utcNow(), 'yyyy-MM-dd')}',
       'DPR_PH',
       72,
       'Success',
       'Backfill range: 2026-06-12 to @{outputs('LoopDate')}',
       '@{utcNow('yyyy-MM-ddTHH:mm:ss')}'
   )
   ```
   (One row per whole backfill run, not per date — deliberate choice.)

**Loop-item reference convention for this flow:** `items('Apply_to_each_Agent')?['user_id']` — note the explicit rename (`Apply_to_each_Agent`, not the PA-default `Apply_to_each` used in the daily flow). **This naming difference between the two flows is a known trap** — expressions copied from one flow into the other without updating the loop-reference name will silently produce wrong or null values rather than erroring.

**Verified result (against the pre-inflation-discovery methodology):** 24 dates × 3 agents = 72 rows inserted with zero gaps (confirmed via `GROUP BY report_date`, every date showing count = 3).

---

### A structural bug already found and fixed once in these flows (relevant precedent for the rebuild)
`CheckHoliday` and `GetWorkingDaysInMonth`-style actions **do not depend on which agent is being processed** — only on the date — but were originally placed *inside* the per-agent loop, causing them to fire 3× with identical inputs. Power Automate's SQL connector gateway sometimes serves a cached response for repeated identical calls (`x-ms-apihub-cached-response: true` header), and on at least one occasion this returned an empty/stale result on the 3rd (Nathaniel's) call, causing a `first() expects array or string, got Null` failure. **Fix applied: move any date-only (non-agent-specific) SQL lookups outside the per-agent loop entirely, computed once per date/run, referenced by all agents inside the loop.** This same class of mistake is worth watching for when the interval-merging rebuild adds new per-agent SQL/lookup steps.

### Nathaniel's flat-rate calc — historical note (already resolved, not part of current bug)
An earlier version of both flows attempted to compute Nathaniel's flat-rate billing (135 hrs ÷ working days in month) **inside** these ingestion flows, via an extra `GetWorkingDaysInMonth` SQL action per agent-loop iteration. This was built, tested, and then **deliberately reverted** — the calculation depends on which reporting period is being viewed (day/week/month), which is a display-time concern, not an ingestion-time fact. Both flows now always write `billing_amount = NULL` for Nathaniel; his flat-rate figure is computed client-side in `dpr.html` using `WorkingDaysInPeriod` / `workingDaysInMonth` values returned by `MIS-GetDPR`. **This part of the flows is stable and not affected by the current PH-inflation bug** — Nathaniel isn't billed off `ph_seconds` at all, so the interval-merging fix doesn't change his billing math, only the accuracy of his displayed PH figure (which is FYI-only for him).

---

## ⚠️ KNOWN CRITICAL ISSUE — Root Cause of Inflated PH

**qContact's pre-aggregated duration data (both `user_breakdown` and a second endpoint `user_productivity`) double-counts time when an agent has overlapping/concurrent state records** — e.g., two "Communicating" records with the identical or overlapping `start_at` timestamp both get summed, rather than the overlap being merged into actual wall-clock elapsed time.

**Evidence:**
- Demi's June 2026 total PH via `user_breakdown`: **202.58 hours over 12 working days** (~16.9h/day — impossible).
- Independently confirmed via `user_productivity` for the same month: summing all `durations` buckets gives 2,941,459 seconds, but June only contains 2,592,000 seconds total — **~97 hours of impossible excess for one agent in one month**, and this was a single whole-month API call (not day-by-day), which rules out day-boundary double-counting in our own pipeline as the cause. The inflation is baked into qContact's source data.
- Confirmed example of a duplicate/overlapping record pair: June 8, record id 26007564850 (duration 0.01s) and id 26007627743 (duration 151.28s), both status "Communicating", **identical `start_at`** timestamp (2026-06-08T12:53:26.000Z).
- **Control case:** Mia Herselman's June PH = ~93 hours over 12 working days (~7.75h/day) — plausible, NOT inflated. She is the reference case any rebuilt logic must reproduce closely.

**Business ruling (confirmed by Craig, who owns the NADClinic billing relationship):** Concurrent/overlapping billable time must be counted once, by wall-clock elapsed time, never summed. E.g., 3 simultaneous chats for 10 minutes = 10 billable minutes, not 30.

**Implication for these two flows specifically:** Both MIS-DailyPHPull and MIS-DPRBackfill currently call `user_breakdown` and trust its pre-summed duration totals directly. **This is the exact mechanism causing the inflation.** Neither flow can be fixed by adjusting the billing formula on top of what they currently pull — the raw totals they're consuming are already wrong before any calculation happens.

**Required fix (not yet built):**
1. Both flows need to pull **raw `UserStateHistory` records** (not pre-aggregated `user_breakdown`/`user_productivity` totals) for each agent/day.
2. Implement **interval-merging logic**: for each agent's billable-state records in a given day, merge any overlapping time ranges and sum only the resulting non-overlapping wall-clock duration.
3. **Every existing row in `mis_agent_ph_daily` since June 12 is inflated and needs to be recomputed from raw state history**, not just re-run through a corrected formula on the old pre-aggregated data.
4. **Unresolved open question:** whether overlaps are channel-specific. Hypothesis (unconfirmed): Voice calls can't physically overlap (telephony-enforced, one call per agent), so any Voice overlap would indicate a genuine bug; Email/WhatsApp can legitimately show an agent's thread "open" across a Lunch break, which may be a different problem (elapsed-time-since-touched vs. active-work-time) rather than true double-counting. **`UserStateHistory` has no channel/media-type field** (confirmed by test — requesting `channel`, `media_type`, `contact_type`, `queue` fields returned nothing), so this hypothesis is currently unverifiable from this entity alone. A different qContact entity (possibly something like `Chat`, `Interaction`, `Conversation`) may carry channel info and would need to be found and cross-referenced.

**Good news:** Nothing from these flows has been shared externally with NADClinic yet (no invoices, no DPR figures sent). This is purely an internal correctness fix before any billing goes out.

---

## Test Plan for the Rebuild (once interval-merging logic is designed)

1. **Mia regression test** — rerun on her June data; should land close to her current ~93h figure since she has minimal/no overlap.
2. **Hand-verification** — manually compute correct merged wall-clock time for the known June 8 overlap pair, confirm the new logic matches.
3. **Physical bound check** — merged elapsed time for any agent/period must never exceed actual calendar seconds in that period; assert this in code.
4. **Cross-check** — compare against `count_answered × avg_handle_time` (from qContact stats) as an independent rough sanity bound.
5. **Day-boundary correctness** — verify records spanning the SA-midnight cutoff are clipped to the correct day *before* merging, not after.
6. **Synthetic edge cases** — hand-built small datasets (e.g., three overlapping Communicating blocks; a Communicating block fully inside a Lunch block) to verify merge logic matches obvious human judgment.

---

## Working Principles (carry forward)
- Test one step at a time; wait for confirmation before the next step.
- Validate in Postman before building/changing flows.
- Never assume field names — confirm via actual API responses (the channel-field test came back empty specifically because we checked rather than assumed).
- Full flow/expression rewrites only, never partial snippets to insert manually.
- Craig owns the NADClinic billing relationship and makes billing-policy calls (e.g., "concurrent time = wall-clock, not summed" is final).
