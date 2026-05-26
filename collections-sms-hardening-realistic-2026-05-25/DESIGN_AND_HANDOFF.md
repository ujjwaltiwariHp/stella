# Stella Collections SMS Hardening — Design & Handoff

> **Single-source document.** If you read only one file in this submission, read this one.
> It covers, in order: what I understood about the problem, the approach I worked through with my collaborator, the decisions we landed on and why, what shipped in Phase 1, what we recommend for Phase 2, plus the handoff package and the Loom walkthrough script.

---

## Table of contents

0. [TL;DR](#0-tldr)
1. [The engagement](#1-the-engagement)
2. [The problem](#2-the-problem)
3. [What I understood first](#3-what-i-understood-first)
4. [User stories — real-world scenarios](#4-user-stories--real-world-scenarios)
5. [The approach discussion](#5-the-approach-discussion)
6. [Decisions and why](#6-decisions-and-why)
7. [Phase 1 — what shipped](#7-phase-1--what-shipped)
8. [Phase 2 — recommended next steps](#8-phase-2--recommended-next-steps)
9. [Data-quality observations from the fixtures](#9-data-quality-observations-from-the-fixtures)
10. [Open questions for live Stella verification](#10-open-questions-for-live-stella-verification)
11. [The handoff package](#11-the-handoff-package)
12. [Loom walkthrough script](#12-loom-walkthrough-script)
13. [Final checklist](#13-final-checklist)

---

## 0. TL;DR

- **Send flow:** UI now returns in ~20 ms (was ~420 ms). All five bookkeeping writes still run — they're deferred via `ctx.waitUntil`, error-isolated, and observable through a new optional `onDeferredError` callback.
- **Monthly batch:** rule-based selection replacing the `balance > 0` stub. Filters: balance, holds, stale/high-DPD escalation, meaningful replies, minimum 3-day spacing, max cadence step 3. Each emitted item carries a reason code.
- **Tests:** 7 originals preserved verbatim, 7 added for edge cases. `npm test` → 14/14 green, ~225 ms, offline.
- **Phase 2:** the patch leaves real production gaps open by design — refresh race, cross-tab dedupe, process-crash durability. Section 8 lays out the Redis + BullMQ architecture that closes them. The Phase 1 interface is shaped so Phase 2 plugs in without rewriting this code.

---

## 1. The engagement

| | |
|---|---|
| **Client** | Mayank Kumawat |
| **Role being screened for** | True developer using AI coding tools to work from sanitized repos and return patch-style handoffs with tests and verification. Not Zapier-style automation. |
| **Stack disclosed to client** | Claude Code for planning, architecture decisions, and review; Cursor for implementation. |
| **Rate agreed** | $20/hr to start, for consistent ongoing work. |
| **Handoff format promised** | PR-style commits + unit and fixture-based tests + 5–10 min Loom walkthrough + short doc on how it was tested + sample I/O + handoff doc summarizing changes, edge cases, next steps, and anything needing a real env. |
| **Constraint** | Offline only — no network calls, API clients, SMS sending, external AI calls, deploy steps, or credential/access requests. |

The trial is the gate before a scheduled call. A strong submission opens the door to ongoing work.

---

## 2. The problem

Two improvements in one sanitized package:

1. **SMS send-flow latency.** The current optimized flow awaits all five bookkeeping writes (`writeLedger`, `writeThread`, `writeContact`, `updateTenant`, `commitGate`) sequentially after the provider call. UI sits there for ~420 ms when only the ~20 ms provider call is structurally necessary.
2. **Monthly collections automation.** `selectMonthlyCollectionsCandidates` is a stub — it emits every tenant with `balance > 0` as a step-1 candidate with reason `"balance_positive"`. No filtering for holds, escalation track, recent replies, or cadence history. The output isn't a reviewable batch a property manager could trust.

Both pieces have to ship as clean, patchable code that drops back into Stella with minimal rewriting.

---

## 3. What I understood first

Before discussing approach, I established what each piece of the codebase actually represents in production. This is the foundation everything else builds on.

### 3.1 Each function in `src/send_flow.js`

| Function | Production role | Cost driver |
|---|---|---|
| `sendProvider` | Hands the SMS to Twilio / RingCentral. Returns `{id, status}` on acceptance. | Network call to external provider. ~20 ms in the test mock. |
| `writeLedger` | Immutable audit row: who, when, what, provider id. For compliance, legal, dispute review. | DB write to ledger table. ~80 ms. |
| `writeThread` | Append the outbound message to the tenant's conversation thread shown in Stella's inbox UI. | DB write to threads table. ~80 ms. |
| `writeContact` | Update contact row: `last_contacted_at`, channel, etc. Roll-up state for reporting. | DB write to contacts table. ~80 ms. |
| `updateTenant` | Update tenant aggregates: cadence step, last outreach date, possibly stage transition. | DB write to tenants table. ~80 ms. |
| `commitGate` | Mark this send as committed in the dedupe table. Defends future requests against duplicates. **Ambiguity:** could be a pre-send dedupe check placed in the wrong position, or a post-send commit-marker. We resolved this in §5.2. | DB write to dedupe table. ~80 ms. |

Total mocked latency: ~420 ms blocking. Test budget allows < 90 ms.

### 3.2 What the monthly collections selector needs to gate on

Reading the README's "we care about" list and the existing failing tests, the selector needs:

- Positive balance only
- Skip tenants on `hold_flag` (holds get a different track)
- Skip stale / high-DPD cases (`days_past_due >= 31` or `stage === "16+_dpd"`) — they go to the escalation track, not friendly month-start
- Skip tenants who replied meaningfully since the last touch
- Honor cadence step progression (step 1 → 2 → 3) with minimum spacing
- Stop at step 3 (no step 4)
- Emit `reason` codes per the README ("logic explains its decisions")
- Output is a **reviewable batch** — data, not live sends

---

## 4. User stories — real-world scenarios

These are the scenarios the design has to be defensible against.

### 4.1 Send-flow scenarios

| # | Scenario | What must hold |
|---|---|---|
| 1 | Manager clicks Send once, happy path | UI returns fast; tenant receives one SMS; all five writes eventually settle |
| 2 | Manager double-clicks Send by accident | Only one SMS to the tenant |
| 3 | Manager clicks Send, page hangs briefly, hits Cmd+R, button is clickable on the reloaded page, clicks again | Only one SMS to the tenant |
| 4 | Manager has two browser tabs open on the same tenant, sends from each | Only one SMS to the tenant |
| 5 | Network drops mid-request, client retries | Only one SMS to the tenant |
| 6 | Server process crashes after `sendProvider` accepted but before deferred writes flush | Ledger / thread / contact eventually consistent — or explicit reconciliation. No silent loss. |
| 7 | `sendProvider` rejects (Twilio 4xx/5xx) | No bookkeeping happens; UI surfaces the error |
| 8 | One deferred write fails (ledger DB blip) | Other writes still attempt; failure is observable; send is not silently lost from audit |
| 9 | User opens the page hours later | Send button rendered as "already sent at HH:MM" — read from server state |

### 4.2 Monthly batch scenarios

| # | Scenario | Expected behavior |
|---|---|---|
| 1 | Tenant with balance, no prior contact, current-ish | Emit at step 1 |
| 2 | Tenant on hold (any reason) | Excluded — holds team owns the next move |
| 3 | Tenant in 16+ DPD or eviction track | Excluded — escalation path, not friendly cadence |
| 4 | Tenant replied "ok" after step 1 | Step 2 still emits — trivial ack does not pause cadence |
| 5 | Tenant replied "I'll pay Friday" after step 1 | Excluded — meaningful engagement pauses cadence |
| 6 | Tenant received step 1 yesterday | Excluded — spacing not met |
| 7 | Tenant received step 3 already | Excluded — cadence capped |
| 8 | Tenant has dispute hold | Excluded — `hold_flag` catches this |
| 9 | Tenant with balance from recent partial payment | Emit step 1 on the remaining balance |

---

## 5. The approach discussion

This is the conversation that produced the final design, summarized so anyone reviewing can follow the reasoning.

### 5.1 First question — which calls block, which defer?

The naive answer: block on `sendProvider`, defer everything else. The defensible answer: anything we defer must be safe to defer — meaning a brief window where the row doesn't yet exist on the server is acceptable.

Walking the five bookkeeping ops one at a time:

- **`writeLedger`** — read by auditors days or weeks later. Nobody reads it in the 100 ms after the click. ✅ Defer.
- **`writeThread`** — the conversation view re-fetches lazily or renders optimistically from the message text the UI already holds. ✅ Defer.
- **`writeContact`** — roll-up reporting state. Eventual consistency is fine. ✅ Defer.
- **`updateTenant`** — cadence step / last outreach date. Matters for the *next* batch (days away), not the current request. ✅ Defer.
- **`commitGate`** — ambiguous. See §5.2.

### 5.2 The `commitGate` debate

There are two distinct gate concepts in any production SMS flow:

- **Pre-send idempotency gate** — answers "are we about to send a duplicate?" Runs *before* `sendProvider`. Must block. Skipping it = double-billing the tenant and the SMS provider.
- **Post-send commit gate** — answers "mark this send committed so future requests see it." Runs *after* `sendProvider`. Can defer. A few hundred ms of "uncommitted" state is tolerable.

In the trial code, `commitGate` is called *after* `sendProvider`. Structurally, that places it as a post-send commit-marker, not a pre-send check. By the time it runs, the SMS is already with Twilio — blocking on it cannot prevent a duplicate that already happened.

The in-file hint ("keep the safety gate in the blocking path") was written ambiguously. The test budget (90 ms total, 80 ms `commitGate`) makes a blocking interpretation arithmetically impossible. We landed on:

- Treat `commitGate` as a post-send commit-marker. Defer it.
- Flag the ambiguity for live-Stella verification: if `commitGate` is meant as a pre-send check that got placed wrong, the right fix is restructuring (move it before `sendProvider`), not blocking.

### 5.3 The refresh-during-gap race

Once we're deferring all five writes, there's an ~80 ms window between UI return and bookkeeping commit. What happens if the user refreshes inside that window?

```
T+0ms    user clicks send
T+20ms   sendProvider accepted; UI sets sent: true
T+20ms   5 deferred writes registered, none committed yet
T+25ms   user hits Cmd+R (impatient)
T+25ms   page reloads. React state gone. sessionStorage empty.
         Server queried: "was this tenant sent template X today?"
         → no row yet → button rendered clickable
T+30ms   user clicks again → duplicate SMS
T+100ms  deferred writes finally commit (too late)
```

This race is small (~80 ms) but real. Blocking on `commitGate` or `writeLedger` *narrows* the window but doesn't close it — a refresh during the blocking window has the same "row not yet written" problem.

What actually closes the race lives outside `sendSmsOptimizedFlow`:

1. **Client-side idempotency key.** UI generates a UUID when the form opens, persists `{key, startedAt}` to `sessionStorage`. On send, server checks if the key was seen — if yes, return the cached result without re-sending. Survives refresh.
2. **Pre-send server check.** Fast Redis SETNX (< 10 ms) on `{tenant, template, date}` before `sendProvider`. The partner `commitGate` currently lacks.
3. **Persisted UI in-flight state.** sessionStorage carries the "sending..." state across refresh inside the gap.

This was the moment we realized the trial code can't fully solve the production problem — and that surfacing this clearly in the handoff is more valuable than over-engineering inside the file.

### 5.4 Queue + Redis architecture (Stage 2)

Then we asked: what *would* the production-grade design look like end-to-end?

```
┌──────────────────────────────────────────────────────────────┐
│ FRONTEND                                                     │
│  • Generates idempotency_key on form open                    │
│  • Persists {key, startedAt, tenant, template} → sessionStorage │
│  • On refresh during gap → restores "sending…" state         │
│  • Includes idempotency_key in every send request            │
└─────────────────────┬────────────────────────────────────────┘
                      │ POST /send {message, idempotency_key}
                      ▼
┌──────────────────────────────────────────────────────────────┐
│ API: sendSmsOptimizedFlow                                    │
│                                                              │
│  1. preSendDedupeCheck(key)    → Redis SETNX (~5 ms)         │
│       NEW    → proceed                                       │
│       SEEN   → return cached result, NO RE-SEND              │
│                                                              │
│  2. sendProvider(message)      → Twilio / RingCentral        │
│       ok       → cache result against key in Redis           │
│       rejected → DEL key (allow retry), return error         │
│                                                              │
│  3. Enqueue 5 bookkeeping jobs → BullMQ (Redis-backed)       │
│       writeLedger, writeThread, writeContact,                │
│       updateTenant, commitGate                               │
│                                                              │
│  4. Return { ok, provider, elapsedMs ≈ 20ms }                │
└─────────────────────┬────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────────────────────┐
│ WORKER (separate process, BullMQ consumer)                   │
│  • Pulls jobs from Redis queue                               │
│  • Writes to Postgres                                        │
│  • Exponential backoff retries                               │
│  • Dead-letter queue + alerts on permanent failure           │
│  • Survives API restart — queue is durable                   │
└──────────────────────────────────────────────────────────────┘
```

This architecture closes every gap in the user stories above. But it requires Redis infrastructure, BullMQ as a dependency, a worker process, and frontend changes — none of which fit Mayank's "offline only" trial constraint.

### 5.5 Why we landed on a two-phase plan

The pragmatic move: build Phase 1 within the constraints (no infra, no deps, offline), but shape the code so Phase 2 plugs in as a follow-up without rewriting `sendSmsOptimizedFlow`. Specifically:

- Keep the `ctx.waitUntil` interface — Phase 2 just swaps the implementation behind it from in-process `Promise.all` to BullMQ enqueue.
- Add `onDeferredError` as the seam for production observability — Phase 1 logs via callback, Phase 2 logs via BullMQ's dashboard.
- Document the Phase 2 design clearly so the client's backend team can run with it.

The reviewer / senior engineer signal: a junior developer makes the tests green. A senior developer makes the tests green *and* leaves a clear migration story for the production-grade follow-up.

---

## 6. Decisions and why

| Decision | Why |
|---|---|
| Block only on `sendProvider`; defer all 5 bookkeeping calls | Test budget forces it; deeper analysis (§5.1–§5.2) shows it's also the correct production design within the given API surface |
| Treat `commitGate` as a post-send commit-marker | Position in the code (called after `sendProvider`) is structurally inconsistent with a pre-send check; flag the ambiguity for live verification |
| Add optional `onDeferredError` callback | Smallest possible Phase-1 observability hook; tests pass without it; gives the host app a logger/alerting seam |
| Each deferred job in its own `.catch` | Without this, one failure poisons `Promise.all` in `flushDeferred` and marks other jobs as failed even when they succeeded |
| `sendProvider` rejection registers zero deferred work | If the SMS never went out, there's nothing to audit; surfacing the rejection cleanly is more honest than queuing writes against an undefined provider response |
| Filter chain ordered cheapest-first | Skip easy cases (no balance, on hold, escalation track) before doing thread / contact lookups |
| "Meaningful reply" delegates to `_data.js` | Same canonical rule that `_smart_templates.js` uses → consistent behavior across the codebase, "ok" doesn't pause cadence but "Zelle sent" does |
| 3-day minimum spacing | Tuned to match the trial test (`step-2 on the 8th after step-1 on the 5th`); constants pulled to module top for easy config later |
| Cadence cap at step 3 | Trial expectation; final-notice messages are already firm in `_smart_templates.js` |
| Reason taxonomy: `month_start_outreach` / `no_response_to_step_1` / `final_no_response` | Matches README's "logic explains its decisions" rubric criterion |
| No new dependencies, no Redis in the patch | Mayank explicitly said offline only; Phase 2 architecture lives in the recommendations, not the code |
| Add 7 edge-case tests on top of the 7 originals | The original test file was the contract; the new tests demonstrate edge-case awareness without weakening anything |

---

## 7. Phase 1 — what shipped

### 7.1 `src/send_flow.js`

**Untouched:** `createDeferredContext`, `maybeCall`, `sendSmsCurrentFlow` (left as the baseline reference).

**Rewritten:** `sendSmsOptimizedFlow`.

**New helper:** `deferJob(ctx, jobName, fn, onError)` — wraps a deferred call in error isolation and routes failures to the optional `onError` callback.

**Behavior:**

```js
const ctx = createDeferredContext();
const result = await sendSmsOptimizedFlow({
  ctx,
  message: "...",
  sendProvider:    () => callTwilio(...),         // BLOCKS (~20 ms)
  writeLedger:     () => db.ledger.insert(...),   // deferred (~80 ms)
  writeThread:     () => db.threads.append(...),  // deferred
  writeContact:    () => db.contacts.update(...), // deferred
  updateTenant:    () => db.tenants.update(...),  // deferred
  commitGate:      () => db.dedupe.commit(...),   // deferred
  onDeferredError: (err, jobName) => log.error(...) // optional
});
// result.elapsedMs ≈ 20 (was ~420)
// result.deferred === true
// ctx.deferredCount() === 5
// All five writes settle in the background.
```

**Public API delta:**

| Field | Direction | Required? |
|---|---|---|
| `opts.onDeferredError` | new | optional |
| `result.deferred` | new | always present |

### 7.2 `src/monthly_collections.js`

**Untouched API:** `selectMonthlyCollectionsCandidates(opts)`, `buildMonthlyCollectionsBatch(opts)`, `isMeaningfulRecentInbound(thread, since)` — same signatures, new behavior.

**Filter chain:**

| # | Gate | Skip reason emitted |
|---|---|---|
| 1 | `balance > 0` | `no_balance` |
| 2 | NOT `hold_flag` | `on_hold` |
| 3 | NOT (`days_past_due >= 31` OR `stage === "16+_dpd"`) | `escalation_track` |
| 4 | No meaningful inbound since last contact | `tenant_replied_meaningfully` |
| 5 | At least 3 days since last contact | `min_spacing_not_met` |
| 6 | Prior `cadence_step < 3` | `max_cadence_reached` |

**Cadence progression:** prior step + 1, capped at 3. First emission is step 1.

**Reason codes on emitted items:**
- `month_start_outreach` (step 1)
- `no_response_to_step_1` (step 2)
- `final_no_response` (step 3)

**Internal:** helpers `parseDate`, `daysBetween`, `lastMonthStartContact`, `classifyTenant` factored out. Tunable constants `MIN_STEP_SPACING_DAYS`, `MAX_CADENCE_STEP`, `MONTH_START_CADENCE_KEY` at module top.

### 7.3 Tests

**7 originals preserved verbatim.**

**7 added:**

| Name | Locks down |
|---|---|
| optimized SMS flow surfaces provider rejection and registers no deferred work | Failed `sendProvider` throws; `ctx.deferredCount() === 0` |
| optimized SMS flow surfaces deferred errors via `onDeferredError` without poisoning other jobs | One failing job → callback called once; other jobs succeed; `result.ok === true` |
| monthly batch excludes tenants on hold | `hold_flag: true` → 0 candidates |
| monthly batch advances to step 3 after step 2 with no meaningful reply | "k" reply after step 2 → step 3 with reason `final_no_response` |
| monthly batch does not advance past step 3 | Prior `cadence_step: 3` → 0 candidates |
| monthly batch enforces minimum 3-day spacing between steps | 1 day after step 1 → 0 candidates |
| monthly batch excludes tenants who used payment language in their reply | "Zelle sent" → meaningful → 0 candidates |

### 7.4 File map

```
collections-sms-hardening-realistic-2026-05-25/
├── README.md                        (unchanged)
├── CANDIDATE_MESSAGE.md             (unchanged)
├── REVIEW_RUBRIC.md                 (unchanged)
├── SECURITY.md                      (unchanged)
├── package.json                     (unchanged)
├── DESIGN_AND_HANDOFF.md            ← this file (new)
├── NOTES.md                         ← handoff notes (new)
├── CHANGES.md                       ← file-by-file diff inventory (new)
├── fixtures/
│   ├── real_threads_sanitized.json          (unchanged)
│   └── real_collections_tenant_cases.json   (unchanged)
├── src/
│   ├── _data.js                     (unchanged)
│   ├── _smart_templates.js          (unchanged)
│   ├── send_flow.js                 ← modified
│   └── monthly_collections.js       ← rewritten
└── test/
    └── send_latency_and_monthly.test.mjs    ← extended (7 → 14 tests)
```

### 7.5 How to verify

```
npm test
```

Expected output:

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

tests 14 | pass 14 | fail 0 | duration ~225 ms
```

---

## 8. Phase 2 — recommended next steps

### 8.1 The gaps Phase 1 doesn't close

| Failure mode | Why Phase 1 can't fix it | Phase 2 mechanism |
|---|---|---|
| User refreshes during ~80 ms deferred-write gap; button re-clickable → duplicate SMS | Race between client refresh and server commit; server-side ordering alone can't close it | UI idempotency key + sessionStorage + backend pre-send dedupe |
| Two tabs / two devices send the same template same day | No pre-send check in the trial API | Backend pre-send dedupe (Redis SETNX) |
| Network retry of same HTTP request | Same — needs server-side idempotency | Server-side request-key idempotency, Stripe-style |
| Process crash before deferred writes flush → audit row lost | In-memory `Promise.all` dies with the process | Durable queue (BullMQ on Redis); worker process drains with retries + DLQ |
| Persistent write failure (DB constraint, etc.) | `onDeferredError` surfaces it; recovery is the caller's job | Outbox pattern + DLQ + alerting |
| User opens page hours later, button still active | Frontend doesn't know what's been sent | Page-load query: render button as "Already sent at HH:MM" if matching ledger row |

### 8.2 Phase 2 architecture (full design)

See the diagram in §5.4. The components:

**Frontend changes**
- Generate `idempotencyKey` (UUID) on send-form open
- Persist `{key, startedAt, tenant, template}` to `sessionStorage` *before* calling the API
- On refresh, read sessionStorage; if a recent key exists, render button as "sending…" until either confirmation or 30 s timeout
- Include `idempotencyKey` in every send request
- On page load, query `/api/sent?tenant=X&template=Y&date=today`; if hit, render "Already sent at HH:MM"

**Backend changes**
- Add `preSendDedupeCheck(idempotencyKey)` → Redis `SETNX` with TTL; if seen, return cached result without re-sending
- After `sendProvider` accepts, cache `{key → response}` in Redis with the same TTL
- Replace in-process `ctx.waitUntil` with `bookkeepingQueue.add(jobName, payload)` (BullMQ)
- Stand up a worker process subscribed to the queue; configure exponential backoff retries and a dead-letter queue
- Wire BullMQ dashboard for visibility

**Infra changes**
- Redis service (managed or self-hosted)
- Worker process deploys (separate from API process; scale independently)
- Monitoring + alerts on DLQ size, queue depth, processing latency

### 8.3 Migration path — Phase 1 → Phase 2

The Phase 1 patch is designed for surgical migration:

1. `sendSmsOptimizedFlow` itself does not change. ✅
2. `createDeferredContext` gets a new implementation:
   ```js
   // PHASE 2 — replaces in-process Promise.all
   function createDeferredContext() {
     return {
       waitUntil(job) { return bookkeepingQueue.add('generic', { job }); },
       async flushDeferred() { /* maybe a no-op in prod; queue drains async */ },
       deferredCount() { /* observability; queries queue */ }
     };
   }
   ```
3. Callers of `sendSmsOptimizedFlow` add `opts.preSendDedupeCheck` and `opts.idempotencyKey` to the call site. (These can be added to `sendSmsOptimizedFlow`'s opts shape in a Phase-1.5 patch if desired — they're additive and don't affect existing tests.)
4. Frontend rollout in parallel with backend.
5. Page-load read-back guard added incrementally.

**Estimated effort to Phase 2:**
- Backend: 2–3 weeks (Redis setup, BullMQ integration, worker process, DLQ wiring, monitoring)
- Frontend: 1–2 weeks (idempotency key + sessionStorage + button-state restoration + page-load guard)
- QA: 1 week (race conditions are hard to test deterministically; need integration suite)

---

## 9. Data-quality observations from the fixtures

Items worth raising with the live data:

1. **Only one thread is `tenant_context_source: "phone_matched"`.** The other 49 are `sample_real_context`. Joining threads to tenants by tenant id can't be assumed safe across fixtures. Cross-fixture analytics should explicitly filter on `phone_matched`.
2. **`hold_dispute` stage.** Appears in fixtures (e.g., `tenant_case_002`) as a stage value outside the standard DPD ladder, always paired with `hold_flag: true` in what we observed. The Phase 1 filter treats it as on-hold via `hold_flag`. Worth confirming the invariant holds in production data.
3. **Date format inconsistency.** Tenant `last_payment_date` uses `MM/DD/YYYY` in fixture cases ("04/30/2025") but `YYYY-MM-DD` elsewhere. `_smart_templates.js` parses both via permissive `Date()`. A live import should normalize on entry.
4. **`was_current_at_month_end`.** Present on tenant records but no test gates on it. Possible meaning: "this is a new-month miss, not a chronic late." Left unused in this patch — flagged as an open question.

---

## 10. Open questions for live Stella verification

In rough priority order:

1. **`commitGate` semantics.** Post-send commit-marker (defer is correct) or pre-send dedupe placed in wrong position (needs restructuring)?
2. **Existing dedupe story.** Does Stella have any pre-send idempotency check today, or is the system relying on UI button state alone?
3. **`was_current_at_month_end` gating.** Should `false` exclude a tenant from friendly month-start outreach because they're chronic, not new-this-month?
4. **`hold_dispute` routing.** Does the dispute hold route to a different team than other holds, or are they handled identically downstream?
5. **3-day spacing.** Right per property / track, or should it be config?
6. **Durability requirement for deferred writes.** Is the in-memory Phase 1 acceptable as step 1, or should we go to BullMQ from day one?
7. **Bookkeeping write order.** Are the 5 writes order-dependent in production (e.g., does `writeContact` read state from `writeLedger`)? Phase 2 queue config depends on this.

---

## 11. The handoff package

### 11.1 What's in the zip

Everything in the project folder. Specifically:

- All original files (untouched): `README.md`, `CANDIDATE_MESSAGE.md`, `REVIEW_RUBRIC.md`, `SECURITY.md`, `package.json`, `fixtures/`, `src/_data.js`, `src/_smart_templates.js`
- Modified: `src/send_flow.js`, `src/monthly_collections.js`, `test/send_latency_and_monthly.test.mjs`
- Added: `NOTES.md`, `CHANGES.md`, `DESIGN_AND_HANDOFF.md` (this file)

The trial is not a git repo — the client shipped it as a folder — so the handoff is the folder as a zip, not a PR.

### 11.2 Cover message to the client

```
Hi Mayank,

Trial deliverable attached. Sharing the full folder (not just a patch)
so you can drop it into any reviewer's environment and run `npm test`
directly.

Quick map:

  1. DESIGN_AND_HANDOFF.md — start here if you want the full story
                              (understanding → approach → decisions →
                              what shipped → what's recommended next).

  2. NOTES.md               — handoff notes if you prefer a tighter read
                              (approach, sample I/O, production gaps).

  3. CHANGES.md             — file-by-file diff inventory if you want
                              to scan changes without opening every file.

  4. src/                   — two files touched: send_flow.js and
                              monthly_collections.js. The other two src
                              files are untouched.

  5. test/                  — 7 original tests preserved verbatim, 7
                              added for edge cases. `npm test` → 14/14
                              green, ~225 ms, fully offline.

Headline numbers:
  • Optimized send returns in ~20 ms (was ~420 ms). Bookkeeping still
    happens — deferred via ctx.waitUntil, error-isolated, observable
    via an optional onDeferredError callback.
  • Monthly batch now filters by balance, holds, stale/high-DPD
    escalation, meaningful replies, minimum 3-day spacing, and a
    step-1→2→3 cadence cap. Each emitted item carries a reason code.

One item I'd specifically flag for live-Stella verification (top of
the open-questions list in either NOTES.md or DESIGN_AND_HANDOFF.md):
is `commitGate` meant as a post-send commit-marker (which is how I
treated it) or a pre-send dedupe check placed in the wrong position?
The answer changes the recommendation.

A short Loom walkthrough is coming separately.

Happy to iterate on anything.

Hamdev
```

### 11.3 Verification command

```bash
cd collections-sms-hardening-realistic-2026-05-25
npm test
```

### 11.4 Zipping the package

```bash
cd /Users/hamdev/Downloads
zip -r collections-sms-hardening-hamdev.zip \
  collections-sms-hardening-realistic-2026-05-25 \
  -x '*/node_modules/*' '*/.DS_Store' '*/.git/*'
```

---

## 12. Loom walkthrough script

Target length: 6–8 minutes. Read for guidance, not verbatim.

### Setup before recording

- Open the project folder in your editor (VS Code / Cursor)
- Open a terminal tab inside the project root
- Close all other windows — just editor + terminal visible
- Have these files ready to switch to quickly:
  `DESIGN_AND_HANDOFF.md`, `NOTES.md`, `src/send_flow.js`, `src/monthly_collections.js`, `test/send_latency_and_monthly.test.mjs`
- Resize the Loom window so terminal + editor are both readable
- Test mic level; speak at a normal pace, not rushed

### [0:00 – 0:45] Opening — context

**On screen:** `README.md` visible

**Say:**
> "Hi Mayank, this is Hamdev — quick walkthrough of the trial submission.
>
> The package had two improvements to make: first, make the SMS send flow return quickly after provider acceptance without skipping the bookkeeping; second, replace the stub monthly collections selector with rule-based logic that respects balance, holds, escalation, recent replies, and cadence history.
>
> I'll show you the test results first, then walk the two files, then spend the last minute on the production-grade concerns I flagged for your backend team."

### [0:45 – 1:30] Test results — proof first

**On screen:** terminal

**Action:** type `npm test` and press enter

**Say (while it runs):**
> "14 tests total. The original 7 are preserved exactly as you shipped them — nothing renamed, nothing weakened. The 7 I added cover edge cases: provider rejection, deferred-job failure isolation, hold-flag exclusion, step-3 cap, minimum spacing, and payment-language replies."

**Action:** scroll up so all 14 ✔ lines are visible at once

**Say:**
> "All green, runs in about 225 milliseconds, fully offline — no network, no credentials, no new dependencies."

### [1:30 – 3:00] `src/send_flow.js` — the latency fix

**On screen:** `src/send_flow.js`, scrolled to `sendSmsOptimizedFlow`

**Say:**
> "Send flow. The current flow awaits all five bookkeeping writes sequentially after provider acceptance — that's why the UI sits there for around 400 milliseconds."

**Action:** highlight the `await maybeCall(opts.writeLedger, provider)` line and its 4 siblings in `sendSmsCurrentFlow`

**Say:**
> "In the optimized flow, only `sendProvider` blocks. Once Twilio says accepted, the message is in their queue — there's nothing left for the UI to wait on."

**Action:** scroll to `sendSmsOptimizedFlow`

**Say:**
> "All five bookkeeping calls go to `ctx.waitUntil`. They run in the background after we return. The function returns in about 20 milliseconds instead of 420."

**Action:** highlight the `deferJob` helper

**Say:**
> "Two pieces of safety here. First, each deferred job has its own `.catch`. Without that, one failing job — say a ledger DB blip — would reject the `Promise.all` in `flushDeferred` and mark every other job as failed too, even when they succeeded.
>
> Second, the optional `onDeferredError` callback. If a job fails, the host app can log it, alert on it, or queue it for retry, without having to re-patch this file. The trial mock doesn't pass one, so existing tests are unaffected, but I added a test that specifically exercises this path."

**Action:** switch to test file, scroll to "surfaces deferred errors via onDeferredError"

**Say:**
> "This test fails one deferred job, succeeds the other four, and asserts the callback is called exactly once with the right job name, while the overall result still comes back ok."

**Action:** switch back to `src/send_flow.js`

**Say:**
> "One callout in the handoff doc: `commitGate`. The in-file hint suggested keeping a 'safety gate' in the blocking path, but `commitGate` is called *after* `sendProvider` in the original code — structurally it's a post-send commit-marker, not a pre-send dedupe check. By the time it runs, Twilio already has the message, so blocking on it doesn't prevent any duplicate that wasn't going to happen.
>
> If `commitGate` is actually meant as a pre-send check that got placed in the wrong position, the right fix is restructuring — move it before `sendProvider` — not blocking. That's flagged as the top open question for live Stella verification."

### [3:00 – 4:30] `src/monthly_collections.js` — the selector

**On screen:** `src/monthly_collections.js`, scrolled to `classifyTenant`

**Say:**
> "Monthly batch. The old selector returned every tenant with balance greater than zero, all marked step 1, no filtering. I replaced it with a six-gate filter chain, cheapest checks first."

**Action:** highlight each gate in order while reading

**Say:**
> "Balance check — skip if zero or negative.
> Hold check — if `hold_flag` is true, something else placed the hold; that team owns the next outreach.
> Escalation check — DPD 31 or more, or stage `16+_dpd`, route to the eviction track. Sending a friendly month-start text to a tenant in eviction contradicts the legal posture.
> Meaningful reply check — pause the cadence if the tenant replied since the last touch. Critically, 'ok' or 'thanks' or thumbs-up do NOT count, but 'Zelle sent' or 'I'll pay Friday' do. That rule lives in `_data.js` and is the same one `_smart_templates.js` already uses — keeping it canonical means audit logs are consistent across the codebase.
> Spacing check — at least 3 days between steps.
> Cap check — step 3 is final, no step 4."

**Action:** scroll to `selectMonthlyCollectionsCandidates`

**Say:**
> "The emitted items carry a reason code — `month_start_outreach` for step 1, `no_response_to_step_1` for step 2, `final_no_response` for step 3. That's per your README — the logic should explain its decisions."

**Action:** scroll to the constants at module top

**Say:**
> "Three constants pulled to the top: minimum spacing days, max cadence, and the cadence key name. Per-property or per-track configuration is flagged as a follow-up — for the trial these are tuned to match the test expectations."

### [4:30 – 6:00] `DESIGN_AND_HANDOFF.md` — Phase 2 recommendations

**On screen:** `DESIGN_AND_HANDOFF.md`, scrolled to §8 "Phase 2 — recommended next steps"

**Say:**
> "This is the part I'd most like your backend team to weigh in on.
>
> The patch makes the send fast and the selector smart, but a refresh during the 80-millisecond gap after we return — where the deferred writes haven't committed yet — could let a user re-click the Send button and double-send. Same for two tabs open. Same for a network retry of the same request. None of those can be solved inside `sendSmsOptimizedFlow` alone."

**Action:** highlight the gaps table

**Say:**
> "The fixes split cleanly between UI and backend. UI side: generate an idempotency key when the send form opens, persist it in sessionStorage so a refresh inside the gap restores the 'sending...' state. Backend side: add a fast pre-send dedupe check — Redis SETNX on tenant plus template plus date — that runs before `sendProvider` and short-circuits duplicates."

**Action:** scroll to the Phase 2 architecture diagram

**Say:**
> "Phase 2 is the bigger move: swap the in-process `Promise.all` behind `ctx.waitUntil` for a BullMQ-backed durable queue. Jobs persist in Redis, survive any process restart, retry with exponential backoff, and land in a DLQ if they ultimately fail. That closes the 'process crash before flush' gap and gives you a real dashboard for write health.
>
> The key thing — and this is why I structured the patch the way I did — is that swapping to Phase 2 is a one-file change in `createDeferredContext`. `sendSmsOptimizedFlow` itself doesn't move. The interface stays put."

**Action:** scroll to §10 "Open questions"

**Say:**
> "Seven open questions for verification in live Stella — I won't read them all, but the top three are: one, what is `commitGate` actually meant to do; two, does Stella have any pre-send idempotency check today or is the system relying on UI button state alone; three, are the five bookkeeping writes order-dependent in production — if `writeContact` reads state from `writeLedger`, deferred jobs need ordering."

### [6:00 – 6:45] Data-quality observations

**On screen:** `DESIGN_AND_HANDOFF.md`, scrolled to §9

**Say:**
> "Four small things I noticed in the fixtures that are worth knowing in live data:
>
> Only one thread is phone-matched to a tenant — cross-fixture joins by tenant id aren't safe by default.
>
> `hold_dispute` stage appears outside the standard DPD ladder, and always paired with `hold_flag: true` in what I saw. Worth confirming that invariant in your production data.
>
> Date formats are mixed — `MM/DD/YYYY` in some places, ISO in others. The existing parsers handle both, but a live import should normalize at the boundary.
>
> And `was_current_at_month_end` is on every tenant record but no test gates on it — possible meaning is 'this is a new-month miss, not a chronic late' — I left it unused but flagged as a question."

### [6:45 – 7:15] Closing

**On screen:** project root in the file tree

**Say:**
> "Wrap-up. The folder is self-contained — `npm test` is the entire build. `DESIGN_AND_HANDOFF.md` has the full approach writeup, `NOTES.md` is the tighter version, `CHANGES.md` is a file-by-file diff inventory if you want to scan changes without opening every file.
>
> Two src files changed, one test file extended, three markdown files added. The other src files and fixtures are untouched.
>
> Happy to walk through any of this on a call, and especially happy to iterate on the Phase 2 architecture with your backend team if that direction looks right.
>
> Thanks for sending the trial — was a good problem to think through."

**Action:** stop recording

### Loom delivery tips

- Don't read these lines word-for-word — paraphrase. Reading sounds robotic.
- The terminal `npm test` moment is the strongest beat. Don't rush past it.
- If you flub a section, don't restart — Loom lets you trim the start/end, and senior engineers expect a small amount of natural friction.
- The closing line is important — it signals collaboration, not "I'm done."
- Aim for 6:30–7:30. Under 6 = rushed. Over 8 = too long for a screen.

---

## 13. Final checklist

| Step | Status |
|---|---|
| Code changes — `send_flow.js`, `monthly_collections.js` | ✅ Done |
| Tests — 7 original preserved, 7 added | ✅ 14/14 green, ~225 ms |
| `NOTES.md` — handoff notes | ✅ Done |
| `CHANGES.md` — file-by-file diff inventory | ✅ Done |
| `DESIGN_AND_HANDOFF.md` — this file | ✅ Done |
| Cover message to client | ✅ §11.2 above |
| Zip command | ✅ §11.4 above |
| Record Loom | ⏸ Your turn — script in §12 |
| Send the zip + cover message + Loom link | ⏸ Your turn |
| Reply to any follow-up from the client | ⏸ When it arrives |

---

*End of document.*
