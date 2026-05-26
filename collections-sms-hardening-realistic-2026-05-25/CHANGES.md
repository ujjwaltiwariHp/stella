# Changes in this submission

Quick inventory of what moved, so any reviewer can scan the diff without running `diff` themselves. Narrative reasoning lives in [`NOTES.md`](./NOTES.md); this file is the "what" only.

## Files modified

| File | Change type | Lines added | Lines removed | Public API change? |
|---|---|---|---|---|
| `src/send_flow.js` | Functional rewrite of `sendSmsOptimizedFlow` + new `deferJob` helper | +47 | -3 | Yes — 1 new optional `opts` field (additive) |
| `src/monthly_collections.js` | Filter chain + cadence progression added; helpers + constants extracted | +95 | -23 | No — function signatures unchanged |
| `test/send_latency_and_monthly.test.mjs` | 7 new edge-case tests appended | +109 | 0 | N/A |

## Files added

| File | Purpose |
|---|---|
| `NOTES.md` | Handoff doc: approach, assumptions, production gaps, Stage-2 architecture recommendation, data-quality observations, open questions |
| `CHANGES.md` | This file |

## Files unchanged

`README.md`, `CANDIDATE_MESSAGE.md`, `REVIEW_RUBRIC.md`, `SECURITY.md`, `package.json`, `fixtures/*`, `src/_data.js`, `src/_smart_templates.js`.

---

## `src/send_flow.js` — change detail

### Before
```js
export async function sendSmsOptimizedFlow(opts) {
  // Candidate task: ... move non-critical bookkeeping into ctx.waitUntil ...
  return await sendSmsCurrentFlow(opts);
}
```
A pass-through to `sendSmsCurrentFlow`, which sequentially awaits all 5 bookkeeping writes (~420 ms total) before returning.

### After
- Blocks **only** on `sendProvider` (~20 ms).
- Hands all 5 bookkeeping calls (`writeLedger`, `writeThread`, `writeContact`, `updateTenant`, `commitGate`) to `ctx.waitUntil` via a new `deferJob` helper.
- Each deferred job runs in its own `.catch` so one failure does not poison `Promise.all` in `flushDeferred`.
- New optional `opts.onDeferredError(err, jobName)` callback surfaces deferred failures to the host app's logger/alerting without re-patching this file.
- If `opts.ctx` is omitted, the function creates one internally so deferred work still runs (just unobservable to the caller).
- Provider rejection: surfaces as a thrown error, **zero deferred work registered** (if the SMS never went out, there is nothing to audit).
- Response shape gains `deferred: true` so callers can distinguish optimized vs. current-flow results.

### Public API delta

| Field | Direction | Required? | Purpose |
|---|---|---|---|
| `opts.onDeferredError` | new | optional | `(err, jobName) => void`. Called once per failing deferred job. Tests pass without it. |
| `result.deferred` | new | always | Boolean — `true` for the optimized flow, `false` for the legacy `sendSmsCurrentFlow`. |

`sendSmsCurrentFlow` is left untouched as the baseline reference and a fallback for anyone who wants the old behavior.

---

## `src/monthly_collections.js` — change detail

### Before
`selectMonthlyCollectionsCandidates` returned every tenant with `balance > 0` as a step-1 candidate, reason `"balance_positive"`. No filtering for holds, escalation track, replies, or cadence history.

`isMeaningfulRecentInbound` used a hand-rolled trivial-list (`"ok"`, `"thanks"`, `"thank you"`).

### After
- New filter chain, cheapest-first, with named skip reasons:
  1. `no_balance` — `balance <= 0`
  2. `on_hold` — `hold_flag === true`
  3. `escalation_track` — `days_past_due >= 31` OR `stage === "16+_dpd"`
  4. `tenant_replied_meaningfully` — inbound message after last contact passes `isMeaningfulTenantReply`
  5. `min_spacing_not_met` — `< 3 days` since last contact
  6. `max_cadence_reached` — prior `cadence_step >= 3`
- Cadence progression: prior step + 1, capped at 3. First emission is step 1.
- New `reason` taxonomy on emitted items: `month_start_outreach` | `no_response_to_step_1` | `final_no_response`.
- `isMeaningfulRecentInbound` now delegates to `isMeaningfulTenantReply` from `_data.js` — the canonical "meaningful" rule already used by `_smart_templates.js`. Catches payment-language replies ("Zelle sent", "I'll pay Friday") that the old hand-rolled list missed.
- Helpers extracted: `parseDate`, `daysBetween`, `lastMonthStartContact`, `classifyTenant`.
- Tunable constants pulled to module top: `MIN_STEP_SPACING_DAYS`, `MAX_CADENCE_STEP`, `MONTH_START_CADENCE_KEY`.

### Public API delta

None. `selectMonthlyCollectionsCandidates(opts)` and `buildMonthlyCollectionsBatch(opts)` keep their existing signatures. Only the behavior changed.

The exported `isMeaningfulRecentInbound` is preserved for backward-compat; its body now defers to `isMeaningfulTenantReply`.

---

## `test/send_latency_and_monthly.test.mjs` — change detail

### Preserved verbatim
All 7 original tests are kept exactly as Mayank shipped them. Nothing renamed, nothing weakened.

### Added (7 new tests)

| # | Name | What it locks down |
|---|---|---|
| 8 | optimized SMS flow surfaces provider rejection and registers no deferred work | A failed `sendProvider` throws; `ctx.deferredCount() === 0` |
| 9 | optimized SMS flow surfaces deferred errors via `onDeferredError` without poisoning other jobs | One failing deferred job invokes the callback exactly once; other jobs are unaffected; `result.ok` is still `true` |
| 10 | monthly batch excludes tenants on hold | `hold_flag: true` → 0 candidates |
| 11 | monthly batch advances to step 3 after step 2 with no meaningful reply | Trivial "k" reply after step 2 → step 3 emitted with reason `final_no_response` |
| 12 | monthly batch does not advance past step 3 | Prior `cadence_step: 3` → 0 candidates (max cap) |
| 13 | monthly batch enforces minimum 3-day spacing between steps | 1 day after step 1 → 0 candidates |
| 14 | monthly batch excludes tenants who used payment language in their reply | "Zelle sent" → meaningful → 0 candidates |

### Test results

```
tests 14 | pass 14 | fail 0 | duration ~225 ms
```

---

## Behavioral changes a reviewer or future user will notice

| Scenario | Before | After |
|---|---|---|
| Click Send on an SMS | UI waits ~420 ms for all bookkeeping | UI returns ~20 ms; bookkeeping settles in background |
| One bookkeeping write fails (e.g., ledger DB blip) | Failure swallowed silently; `flushDeferred` rejects, marking other jobs as failed | Failure surfaces to `opts.onDeferredError`; other jobs continue independently |
| `sendProvider` rejects | Still tried to await `writeLedger(undefined)` etc. — broken path | Throws cleanly with no deferred work registered |
| Monthly batch run with `balance > 0` tenants only | All emitted at step 1, no filtering | Filtered by hold, escalation track, recent replies, spacing, cadence cap |
| Tenant with `stage: "16+_dpd"` and `balance > 0` | Emitted at step 1 — friendly month-start phrasing contradicts eviction posture | Excluded — routes to escalation track |
| Tenant on hold with balance | Emitted at step 1 — overrides hold | Excluded — hold owns the next outreach |
| Tenant who replied "Zelle sent" after step 1 | Emitted at step 2 — old "meaningful" rule didn't catch payment language | Excluded — `_data.js` recognizes payment keywords |
| Tenant who already received step 3 | Emitted at step 4 (no cap) | Excluded — max cadence reached |
| Manager sees output | Generic `reason: "balance_positive"` | Specific reason per cadence step + skip reasons available for debugging |

---

## How to verify

```
npm test
```

All 14 tests should pass. Detailed output in [`NOTES.md`](./NOTES.md).
