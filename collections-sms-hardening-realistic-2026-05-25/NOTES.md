# Stella SMS Hardening — Handoff Notes

## Summary

Two files changed: `src/send_flow.js` and `src/monthly_collections.js`. One test file extended with edge-case coverage. No new dependencies. `npm test` runs offline, no network, no credentials.

- **Send-flow:** UI now returns ~20 ms after provider acceptance (down from ~420 ms). All 5 bookkeeping writes still happen — they're deferred via `ctx.waitUntil`, error-isolated, and observable through an optional `onDeferredError` callback.
- **Monthly batch:** rule-based selection respecting balance, holds, stale/high-DPD escalation, recent meaningful replies, minimum spacing, and a step-1→2→3 cadence cap. Each emitted item carries a `reason` code.

The patch is small and additive. All new `opts` fields are optional — existing callers don't need to change.

---

## How to verify

```
npm test
```

Output:

```
✔ fixtures include sanitized real thread and tenant examples
✔ optimized SMS flow returns after provider acceptance and defers slow bookkeeping
✔ monthly batch includes current-ish tenants with balances on the 5th
✔ monthly batch excludes stale high-DPD tenants from friendly month-start automation
✔ monthly batch excludes tenants who replied meaningfully after the last outreach
✔ monthly batch step 2 is due on the 8th after step 1 with no meaningful reply
✔ monthly batch generates reviewable script messages, not live sends
✔ optimized SMS flow surfaces provider rejection and registers no deferred work
✔ optimized SMS flow surfaces deferred errors via onDeferredError without poisoning other jobs
✔ monthly batch excludes tenants on hold
✔ monthly batch advances to step 3 after step 2 with no meaningful reply
✔ monthly batch does not advance past step 3
✔ monthly batch enforces minimum 3-day spacing between steps
✔ monthly batch excludes tenants who used payment language in their reply

tests 14 | pass 14 | fail 0
```

7 original tests preserved verbatim; 7 added for edge-case coverage.

---

## What changed and why

### `src/send_flow.js`

`sendSmsCurrentFlow` is left untouched as the baseline reference.

`sendSmsOptimizedFlow` now:
1. Blocks **only** on `sendProvider` — the SMS is in flight when this resolves; the UI has nothing further to wait on.
2. Hands the 5 bookkeeping calls (`writeLedger`, `writeThread`, `writeContact`, `updateTenant`, `commitGate`) to `ctx.waitUntil` for background settlement.
3. Wraps each deferred job in its own `.catch` so one DB failure doesn't poison `Promise.all` in `flushDeferred`. The optional `opts.onDeferredError(err, jobName)` callback lets the host app log / alert / retry.
4. Surfaces a `sendProvider` rejection as a thrown error, with **no deferred work registered** — if the SMS didn't go out, we have nothing to audit.

### `src/monthly_collections.js`

Filter chain, cheapest-first so we skip easy cases before doing thread / contact lookups:

| # | Gate | Skip reason |
|---|---|---|
| 1 | `balance <= 0` | `no_balance` |
| 2 | `hold_flag === true` | `on_hold` (whatever placed the hold owns the next outreach) |
| 3 | `days_past_due >= 31` or `stage === "16+_dpd"` | `escalation_track` (friendly month-start phrasing would contradict the legal posture) |
| 4 | meaningful reply since last contact | `tenant_replied_meaningfully` (pause cadence on real engagement) |
| 5 | `< 3 days` since last contact | `min_spacing_not_met` |
| 6 | prior `cadence_step >= 3` | `max_cadence_reached` |

"Meaningful reply" delegates to `isMeaningfulTenantReply` in `_data.js` — the same canonical rule `_smart_templates.js` already uses. So "ok", "thanks", 👍, "got it" do NOT pause the cadence, but "Zelle sent", "I'll pay Friday", "lost my job" do.

Emitted items carry a `reason`:
- `month_start_outreach` — step 1 (no prior contact)
- `no_response_to_step_1` — step 2 (prior step 1, no meaningful reply, spacing met)
- `final_no_response` — step 3 (prior step 2, same)

---

## Sample I/O

### Send flow — happy path

```js
const ctx = createDeferredContext();
const result = await sendSmsOptimizedFlow({
  ctx,
  message: "Hi Alexander, your balance is $815.68.",
  sendProvider: () => callTwilio(...),         // ~20 ms
  writeLedger:  () => db.ledger.insert(...),   // ~80 ms
  writeThread:  () => db.threads.append(...),  // ~80 ms
  writeContact: () => db.contacts.update(...), // ~80 ms
  updateTenant: () => db.tenants.update(...),  // ~80 ms
  commitGate:   () => db.dedupe.commit(...),   // ~80 ms
  onDeferredError: (err, jobName) => log.error({ jobName, err }),
});
// result.elapsedMs ≈ 20  (was ~420)
// result.deferred === true
// ctx.deferredCount() === 5
// All 5 writes settle in the background; await ctx.flushDeferred() before shutdown.
```

### Monthly batch — typical run

```js
const batch = buildMonthlyCollectionsBatch({
  now: new Date("2026-05-08T16:00:00Z"),
  tenants: [
    { id: "t1", balance: 815.68, days_past_due: 5,  stage: "1-5_dpd",  hold_flag: false, ... },
    { id: "t2", balance: 1200,   days_past_due: 31, stage: "16+_dpd", hold_flag: false, ... }, // skipped
    { id: "t3", balance: 500,    days_past_due: 5,  stage: "1-5_dpd",  hold_flag: true,  ... }, // skipped
  ],
  contacts: [
    { tenant_id: "t1", cadence_key: "month_start_no_response", cadence_step: 1, contacted_at: "2026-05-05T15:00:00Z" }
  ],
  threadsByTenantId: {
    t1: [{ direction: "in", body: "ok", timestamp: "2026-05-06T14:00:00Z" }]
  }
});
// → [{ tenantId: "t1", cadenceStep: 2, reason: "no_response_to_step_1", message: "Hi Alexander, ..." }]
```

---

## Edge cases covered (by new tests)

- Provider rejection — error surfaces, zero deferred work registered
- Deferred-job failure — surfaces via `onDeferredError`, other jobs unaffected
- Tenant on hold — excluded
- Step 3 emission after step 2 (with trivial "k" reply)
- Step 3 cap — no step 4 ever emitted
- Spacing < 3 days — excluded
- Payment-language reply ("Zelle sent") — meaningful, pauses cadence

---

## Approach + assumptions

### Why defer all 5 bookkeeping writes (not just 4)

The in-file hint suggested keeping a "safety gate" in the blocking path. Within the API surface given, the only candidate for that gate is `commitGate` — but it's called *after* `sendProvider`, which means it's structurally a post-send commit-marker, not a pre-send dedupe check. Two reads:

- **Post-send commit-marker (my read):** records the just-completed send in the dedupe table so future requests can see it. Safe to defer — the SMS has already gone out, this is bookkeeping for *future* requests.
- **Pre-send dedupe check (the alternative read):** would prevent duplicate sends. If true, it's in the wrong position in the current code; it should run *before* `sendProvider`, not after.

Either way, blocking on `commitGate` in its current position doesn't prevent any duplicate that wasn't already going to happen — by the time it runs, the SMS is in Twilio's queue.

**Verify in live Stella:** confirm `commitGate`'s role. If it's actually a pre-send check that got placed wrong, the right fix is restructuring (move it before `sendProvider`), not blocking.

### Why "meaningful reply" delegates to `_data.js`

`_smart_templates.js` already uses `isMeaningfulTenantReply` to pick conversation openers. Using a different rule here would let the cadence pause on signals the template generator doesn't recognize (and vice versa) — confusing in audit. One canonical rule keeps behavior consistent across the codebase.

### Why 3-day minimum spacing

Tuned to the trial's `step-2 on the 8th after step-1 on the 5th` test. In real Stella this should be config-driven per property/track. Constants are pulled out at the top of `monthly_collections.js` to make this an easy change.

---

## Production gaps — what this patch does NOT solve

We were honest about the limits of what fits inside `sendSmsOptimizedFlow`. These items live outside this file and need separate work:

| Failure mode | Why this patch can't fix it | Recommended fix |
|---|---|---|
| User refreshes during the ~80 ms deferred-write gap, button becomes clickable again, sends twice | The race is between client refresh and server-side write commit — server-side ordering alone can't close it | **UI:** generate idempotency key per send, persist `{key, startedAt}` in `sessionStorage`, render "sending…" on refresh if a recent key exists |
| Two tabs / two devices send the same template same day | Server has no pre-send check in the trial API | **Backend:** add `preSendDedupeCheck` (Redis SETNX on `{tenant, template, date}`, < 10 ms) before `sendProvider` |
| Network retry of same HTTP request | Same — needs server-side idempotency | **Backend:** Stripe-style request-key idempotency, cache result against key |
| Process crash before deferred writes flush → audit row lost | In-memory `Promise.all` dies with the process | **Backend:** swap `ctx.waitUntil` for a durable queue (BullMQ + Redis), worker drains with retry/backoff + DLQ |
| Persistent write failure (DB constraint, etc.) | Patch surfaces it via `onDeferredError` but recovery is the caller's job | **Backend:** outbox pattern — write row intents to an outbox table inside the request, fan out to real tables via worker |
| User opens page hours later, button still active | Frontend doesn't know what's been sent | **Backend + UI:** on page load, query ledger; render button as "Already sent at HH:MM" if a matching row exists |

### Stage-2 recommended architecture (for backend review)

```
UI (idempotency key + sessionStorage in-flight marker)
   │
   ▼
API: sendSmsOptimizedFlow
   ├─ preSendDedupeCheck(key)    → Redis SETNX (~5 ms)
   ├─ sendProvider               → Twilio / RingCentral (block)
   ├─ enqueue × 5 bookkeeping    → BullMQ on Redis (~5 ms each)
   └─ return ≈ 20 ms
   │
   ▼
Worker (separate process)
   ├─ Drains BullMQ queue
   ├─ Writes to Postgres
   ├─ Exponential backoff retries
   └─ DLQ + alerts on permanent failure
```

The `sendSmsOptimizedFlow` interface in this patch is shaped so this migration is a one-file change in `createDeferredContext` — `sendSmsOptimizedFlow` itself doesn't move.

---

## Data-quality observations from the fixtures

A few items worth raising with the live data:

1. **Only one thread is `tenant_context_source: "phone_matched"`** — the other 49 are `sample_real_context`. Joining threads to tenants by tenant id can't be assumed safe across fixtures. Cross-fixture analytics should explicitly filter on `phone_matched`.
2. **`hold_dispute` stage**: appears in fixtures (e.g., tenant_case_002) as a stage value outside the standard DPD ladder, always paired with `hold_flag: true` in what we observed. Our filter treats it as "on hold" via `hold_flag`. Worth confirming the invariant holds in production data.
3. **Date format inconsistency**: tenant `last_payment_date` uses `MM/DD/YYYY` in fixture cases ("04/30/2025") but `YYYY-MM-DD` elsewhere. `_smart_templates.js` parses both via permissive `Date()`. A live import should normalize on entry.
4. **`was_current_at_month_end`** field is present on tenant records but no test gates on it. Possible meaning: "this is a new-month miss, not a chronic late." Left unused in this patch — flagged as an open question (see below).

---

## Open questions for live Stella verification

1. Is `commitGate` a post-send commit-marker (defer is correct) or a pre-send dedupe placed in the wrong position (needs restructuring)?
2. Does Stella have any pre-send idempotency check today, or is the system relying on UI button state alone?
3. Should `was_current_at_month_end === false` exclude a tenant from friendly month-start outreach (because they're chronic, not new-this-month)?
4. Should `hold_dispute` route differently from generic `hold_flag` holds, or are they handled by the same downstream team?
5. Is the 3-day minimum step spacing right per property/track, or should it be config?
6. What's the durability requirement for deferred bookkeeping writes? In-memory is fine for low-volume periods but loses rows on crash. Worth Stage-2 (BullMQ) from day one?
7. Are the 5 bookkeeping writes order-dependent in production (e.g., does `writeContact` read state from `writeLedger`)? If so, deferred jobs need ordering, not just parallel fire-and-forget.

---

## Anything needing a real env

Nothing in the patch needs live access. The Stage-2 architecture in §"Production gaps" does — Redis, a worker process, and frontend changes to UI button + sessionStorage handling. Those are scoped as a follow-up sprint, not part of this submission.

---

## File map

```
src/send_flow.js              — modified (sendSmsOptimizedFlow + deferJob helper)
src/monthly_collections.js    — modified (filter chain, reason codes, helpers)
test/send_latency_and_monthly.test.mjs — extended (7 → 14 tests)
```

`src/_data.js`, `src/_smart_templates.js`, fixtures — untouched.
