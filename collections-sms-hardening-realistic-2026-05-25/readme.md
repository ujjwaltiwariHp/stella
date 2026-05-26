# Stella Collections SMS Hardening — Complete Interview Guide

> Full preparation guide from first-principles to advanced architecture. Covers the codebase, design decisions, JavaScript/Node.js internals, async patterns, system design, and production engineering topics the client may probe on.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Key Terms Glossary](#2-key-terms-glossary)
3. [Codebase Architecture Map](#3-codebase-architecture-map)
4. [Section A — Foundational Questions (Q1–Q20)](#section-a--foundational-questions)
5. [Section B — Send Flow Deep Dive (Q21–Q45)](#section-b--send-flow-deep-dive)
6. [Section C — Monthly Collections Logic (Q46–Q65)](#section-c--monthly-collections-logic)
7. [Section D — JavaScript & Node.js Internals (Q66–Q80)](#section-d--javascript--nodejs-internals)
8. [Section E — System Design & Production Architecture (Q81–Q95)](#section-e--system-design--production-architecture)
9. [Section F — Testing Strategy (Q96–Q105)](#section-f--testing-strategy)
10. [Section G — Scenario / Behavioural Questions (Q106–Q115)](#section-g--scenario--behavioural-questions)
11. [Quick-Reference Cheat Sheet](#quick-reference-cheat-sheet)

---

## 1. Project Overview

**What is Stella?**
Stella is a property management SaaS platform used by real estate companies to manage tenant relationships, rent collection, and communications via SMS (Twilio / RingCentral).

**What problem does this trial solve?**
Two concrete production pain points:

| Problem | Root Cause | Fix Delivered |
|---|---|---|
| UI sits for ~420 ms after clicking Send | `sendSmsCurrentFlow` awaits all 5 bookkeeping writes sequentially after provider call | `sendSmsOptimizedFlow` defers all 5 writes; returns in ~20 ms |
| Monthly collections is manual / error-prone | `selectMonthlyCollectionsCandidates` emitted every tenant with `balance > 0` without any filtering | Six-gate filter chain with cadence progression and reason codes |

**Stack used:**
- Runtime: Node.js ≥ 20 (native `node --test` runner)
- Module system: ES Modules (`"type": "module"` in package.json)
- No external dependencies — pure Node.js standard library
- Fixture data: JSON (sanitized real Stella / Twilio / RingCentral data)

---

## 2. Key Terms Glossary

| Term | Definition |
|---|---|
| **DPD** | Days Past Due — how many days since rent was due but unpaid |
| **Cadence step** | Which message in a sequential outreach series (1 = first, 3 = final) |
| **Hold flag** | Boolean on a tenant record indicating they must not receive automated messages |
| **Escalation track** | Tenants with DPD ≥ 31 or stage `16+_dpd` who are in eviction proceedings — require formal legal language, not friendly month-start texts |
| **`commitGate`** | Post-send bookkeeping call that marks the send as committed in a deduplication table |
| **`ctx.waitUntil`** | Cloudflare Workers-style API for registering background promises that should outlive the HTTP response |
| **`flushDeferred`** | Drains all registered `waitUntil` jobs — used in tests and graceful shutdown |
| **Meaningful reply** | A tenant inbound message that contains real engagement intent (payment language, dispute, promise) — NOT trivial acks like "ok", "thanks", 👍 |
| **Idempotency key** | A client-generated UUID tied to a single logical operation; prevents duplicate processing on retry |
| **BullMQ** | Redis-backed durable job queue library for Node.js — recommended for Phase 2 |
| **Outbox pattern** | Write job intents to a local DB table first; a worker fans them out — survives process crashes |
| **`isMeaningfulTenantReply`** | Canonical function in `_data.js` that classifies whether a tenant reply should pause the cadence |
| **Month-start outreach** | Scheduled friendly batch at the start of each month targeting tenants with low DPD and open balances |
| **`deferJob`** | Helper in `send_flow.js` that wraps a deferred call in per-job error isolation |
| **`onDeferredError`** | Optional callback `(err, jobName) => void` — routes deferred failures to the host app's logger/alerting |

---

## 3. Codebase Architecture Map

```
src/
├── _data.js                  Canonical data helpers (normalizeSmsText, isMeaningfulTenantReply)
├── _smart_templates.js       Context-aware SMS composer (opener + core + ask pattern)
├── send_flow.js              SMS send path — current (blocking) + optimized (deferred)
└── monthly_collections.js   Tenant selection + batch builder for month-start automation

test/
└── send_latency_and_monthly.test.mjs   14 tests (7 original + 7 added edge-case)

fixtures/
├── real_threads_sanitized.json          50 real SMS threads (phone/email removed)
└── real_collections_tenant_cases.json  50 real tenant cases (phone/email removed)
```

**Data flow — send path:**
```
UI click → sendSmsOptimizedFlow
             │
             ├─ BLOCK: sendProvider (~20ms) ─────────────── return result to UI
             │
             └─ DEFER via ctx.waitUntil:
                  writeLedger   (~80ms)
                  writeThread   (~80ms)
                  writeContact  (~80ms)
                  updateTenant  (~80ms)
                  commitGate    (~80ms)
                              ↓
                  each in own .catch → onDeferredError if fails
```

**Data flow — monthly batch:**
```
tenants[] → classifyTenant (6-gate filter) → candidates[]
                                                    │
                                           buildSmartMonthStart
                                                    │
                                           reviewable batch[]
```

---

## Section A — Foundational Questions

**Q1. What is this project trying to solve in one sentence?**

It makes the Stella SMS send path 20x faster by deferring non-critical bookkeeping, and replaces a stub monthly collections selector with a rule-based filter that respects holds, escalation status, cadence history, and tenant replies.

---

**Q2. What is `sendSmsCurrentFlow` and why wasn't it touched?**

`sendSmsCurrentFlow` is the original blocking implementation — it awaits all five bookkeeping writes sequentially (~420 ms total). It was kept untouched as:
- A **baseline reference** for behavior comparison
- A **fallback** for callers who need the synchronous guarantee
- A **regression anchor** — if the optimized flow has a bug, current flow behavior is preserved and testable

---

**Q3. What is the ES Module system and why does this project use it?**

ES Modules (`import`/`export`) is the native JavaScript module system. The project uses `"type": "module"` in `package.json`, which:
- Enables `import`/`export` syntax in all `.js` files without transpilation
- Requires `.mjs` extension for test files to disambiguate
- Enables top-level `await` in modules
- Node.js ≥ 20 supports this natively, matching the engine constraint

---

**Q4. How do you run the tests?**

```bash
cd collections-sms-hardening-realistic-2026-05-25
npm test
```

This runs `node --test`, which uses Node.js's built-in test runner (no Jest/Mocha needed). All 14 tests pass in ~225 ms, fully offline.

---

**Q5. What are the five bookkeeping calls and what does each do in production?**

| Function | Production Role | Latency |
|---|---|---|
| `writeLedger` | Immutable audit row — compliance, legal, dispute review | ~80ms |
| `writeThread` | Appends message to tenant's conversation thread in the inbox UI | ~80ms |
| `writeContact` | Updates `last_contacted_at`, channel info — roll-up state for reporting | ~80ms |
| `updateTenant` | Updates cadence step, last outreach date, possible stage transition | ~80ms |
| `commitGate` | Marks this send as committed in the deduplication table | ~80ms |

---

**Q6. What is a `cadence step` and why does it matter?**

A cadence step tracks which message in a sequential outreach series a tenant has received. The system uses steps 1–3:
- Step 1: Friendly month-start reminder (`month_start_outreach`)
- Step 2: Follow-up with no response (`no_response_to_step_1`)
- Step 3: Final notice (`final_no_response`)

It prevents tenants from receiving the same message repeatedly and ensures escalation happens incrementally. Capped at 3 because step 3 messages are already firm final notices.

---

**Q7. Why does the monthly batch exclude tenants with DPD ≥ 31?**

Tenants with 31+ days past due are on the **escalation/eviction track**. Sending them a friendly "month-start" text would:
1. Contradict the legal posture of ongoing eviction proceedings
2. Create inconsistent audit records
3. Potentially be used by tenants to argue the landlord wasn't taking action seriously

These tenants need formal escalation language, not automated friendly outreach.

---

**Q8. What does `hold_flag: true` mean, and why does the batch skip those tenants?**

`hold_flag` indicates that a hold has been placed on the tenant's account — reasons include dispute, payment plan negotiation, or manual review. Whoever placed the hold "owns" the next outreach decision. The automated batch skipping hold-flag tenants prevents the automation from overriding a human decision in progress.

---

**Q9. What is `isMeaningfulTenantReply` and where does the canonical version live?**

It's a function in `src/_data.js` that classifies whether a tenant inbound SMS represents real engagement intent. It returns `false` for trivial acks like "ok", "thanks", 👍, and `true` for anything with payment language ("Zelle sent", "I'll pay Friday"), longer messages (≥ 20 chars), or specific intent keywords.

The canonical version lives in `_data.js` and is shared between `_smart_templates.js` (template selection) and `monthly_collections.js` (cadence gating). Using one canonical source ensures consistent behavior across the codebase.

---

**Q10. What is the difference between `deferred: true` and `deferred: false` in the result shape?**

Both `sendSmsCurrentFlow` and `sendSmsOptimizedFlow` return a result object. The `deferred` field distinguishes them:
- `deferred: false` — all bookkeeping writes already completed before the function returned (current flow)
- `deferred: true` — bookkeeping writes are still in progress in the background (optimized flow)

This lets callers know whether they can assume writes are settled or need to wait on `ctx.flushDeferred()`.

---

**Q11. What is the `ctx` (deferred context) object and what are its three methods?**

```js
const ctx = createDeferredContext();
ctx.waitUntil(promise)    // Register a background promise
await ctx.flushDeferred() // Drain all registered promises (used in tests/shutdown)
ctx.deferredCount()       // Returns how many jobs are registered
```

The design mirrors Cloudflare Workers' `event.waitUntil()` — the interface is shaped so Phase 2 can swap the in-process `Promise.all` implementation for BullMQ without changing `sendSmsOptimizedFlow`.

---

**Q12. Why is `MIN_STEP_SPACING_DAYS` set to 3?**

It was tuned to pass the trial test — "step 2 is due on the 8th after step 1 on the 5th" = 3 days. In production it should be config-driven per property or track. The constant is extracted to the top of `monthly_collections.js` to make it a single-line change when the client wants to adjust it.

---

**Q13. What are the six filter gates in `classifyTenant` and in what order?**

```
1. balance <= 0           → no_balance
2. hold_flag === true     → on_hold
3. DPD >= 31 or 16+_dpd  → escalation_track
4. meaningful inbound     → tenant_replied_meaningfully
5. < 3 days since contact → min_spacing_not_met
6. cadence_step >= 3      → max_cadence_reached
```

Order is cheapest-first: skip easy cases (no math, no lookups) before doing thread/contact traversals.

---

**Q14. What is the reason taxonomy used on emitted batch items?**

| Reason | Meaning |
|---|---|
| `month_start_outreach` | First contact this cycle (step 1) |
| `no_response_to_step_1` | Step 2 — prior step 1, no meaningful reply, spacing met |
| `final_no_response` | Step 3 — prior step 2, same conditions |

These reason codes support the README requirement that "logic explains its decisions" — a property manager reviewing the batch can see exactly why each tenant was included.

---

**Q15. What is `MONTH_START_CADENCE_KEY` and why is it a named constant?**

It's the string `"month_start_no_response"` — the key used to identify contacts that belong to the month-start cadence in the contacts table. Making it a named constant means:
- If the key ever changes in production, it's a one-line update
- Tests and production code reference the same string without string-literal duplication
- It's visible at the top of the module for easy discoverability

---

**Q16. What does `buildMonthlyCollectionsBatch` return?**

An array of objects, one per selected tenant:
```js
{
  tenantId: string,
  cadenceStep: number,     // 1, 2, or 3
  message: string,         // Ready-to-review SMS text
  reason: string           // month_start_outreach | no_response_to_step_1 | final_no_response
}
```

Critically, it is a **reviewable batch** — not a live send. Messages are generated but must be approved before delivery.

---

**Q17. What technology constraints were imposed on this trial?**

- Offline only — no network calls, API clients, SMS sending, external AI calls
- No new npm dependencies
- Must run with `npm test` — no build step
- No credentials, tokens, or provider access
- No deploy steps or infrastructure changes

---

**Q18. What fixtures are included and what do they represent?**

| Fixture | Contents |
|---|---|
| `real_threads_sanitized.json` | 50 real SMS thread examples from Stella/RingCentral/Twilio with phone numbers and emails removed |
| `real_collections_tenant_cases.json` | 50 exact Stella collections tenant cases with names, properties, balances, stages, notes, and historical message text |

Only one thread is `phone_matched` to its tenant. The others are `sample_real_context` — real data, but not verified to belong to the displayed tenant.

---

**Q19. What is `buildSmartMonthStart` and what pattern does it use?**

It's the SMS template composer in `_smart_templates.js`. It uses an **opener + core + ask** pattern:
- **Opener**: Most recent meaningful signal (recent payment ack, reply ack, promise reference)
- **Core**: Stage/balance/DPD-specific reminder
- **Ask**: Call to action tuned to tone (hardship vs. cooperative vs. default)

This produces personalized, deterministic, testable SMS text without an LLM call.

---

**Q20. What public API changes were made?**

`sendSmsOptimizedFlow` gained two new optional fields:

| Field | Direction | Required | Purpose |
|---|---|---|---|
| `opts.onDeferredError` | new | optional | `(err, jobName) => void` callback for failed deferred jobs |
| `result.deferred` | new | always present | Boolean — true for optimized flow |

`selectMonthlyCollectionsCandidates` and `buildMonthlyCollectionsBatch` kept identical signatures — only behavior changed.

---

## Section B — Send Flow Deep Dive

**Q21. Walk me through exactly what happens when `sendSmsOptimizedFlow` is called.**

```
1. opts.ctx is resolved (caller-provided or internal fallback)
2. sendProvider is called and awaited — BLOCKING (~20ms)
   → If it rejects, throw immediately, zero deferred work registered
3. Five deferJob() calls register bookkeeping as background promises
4. Function returns { ok, providerAccepted, provider, elapsedMs, deferred: true }
5. In the background, each deferred job runs independently:
   → Each has its own .catch
   → Failures route to onDeferredError without poisoning other jobs
6. ctx.flushDeferred() can be awaited before shutdown to drain all jobs
```

---

**Q22. Why is `sendProvider` the only blocking call?**

By the time `sendProvider` resolves, the SMS is in Twilio/RingCentral's queue — the message is "sent." There is nothing left for the UI to wait on from the user's perspective. Every subsequent bookkeeping call reads from the provider response but doesn't affect the tenant's immediate experience.

---

**Q23. What happens if `sendProvider` rejects?**

The error propagates as a thrown exception from `sendSmsOptimizedFlow`. Critically:
- **Zero deferred jobs are registered** — if the SMS never went out, there is nothing to audit
- The UI receives the error immediately
- No partial state is written

This is tested in: `"optimized SMS flow surfaces provider rejection and registers no deferred work"`.

---

**Q24. Why does each deferred job get its own `.catch` instead of using one `Promise.all`?**

Without per-job `.catch`, a single failure in `Promise.all` causes it to reject immediately, which:
1. Marks all other pending jobs as "failed" even if they would have succeeded
2. Prevents their results from being observed
3. Creates incorrect audit records (e.g., `writeLedger` failed, but the error was actually in `writeThread`)

Per-job `.catch` means each job runs to completion independently. One DB blip doesn't cascade.

---

**Q25. What is the `deferJob` helper and what are its four parameters?**

```js
function deferJob(ctx, jobName, fn, onError)
```

| Parameter | Type | Purpose |
|---|---|---|
| `ctx` | DeferredContext | The context to register the job with |
| `jobName` | string | Name passed to `onError` for identification |
| `fn` | function | The actual async work to run |
| `onError` | function\|undefined | Optional sink for failures |

It wraps `fn` in a `Promise.resolve().then(fn).catch(...)` chain so errors are isolated and routed to `onError` without bubbling to `flushDeferred`.

---

**Q26. Why is there a try/catch around the `onError` call inside `deferJob`?**

```js
try { onError(err, jobName); } catch (_) {}
```

If the host app's logger itself throws (e.g., the logging service is down), that exception must not crash the deferred job chain. The goal is observability, not correctness — a failing logger should never prevent other bookkeeping jobs from running.

---

**Q27. What is `ctx.waitUntil` modeled after?**

Cloudflare Workers' `event.waitUntil(promise)` — it registers a promise that should be awaited before the runtime considers the request "done," even after the response has been sent. The same interface is used here so the Phase 2 migration (swapping in-process `Promise.all` for BullMQ enqueue) is a one-file change in `createDeferredContext`.

---

**Q28. What is the timing contract the test enforces?**

```js
assert.ok(elapsed < 90, "response should not wait for all bookkeeping writes");
```

The function must return in under 90 ms even though 5 bookkeeping writes at ~80 ms each would take ~420 ms if sequential. This is the core latency requirement.

---

**Q29. What is `commitGate` and why is it deferred?**

`commitGate` marks the send as committed in a deduplication table. In the original code it is called *after* `sendProvider` — structurally a post-send commit marker, not a pre-send check. Since the SMS is already in Twilio's queue before `commitGate` runs, blocking on it cannot prevent any duplicate that wasn't already going to happen.

It is flagged as an open question for live Stella verification: if `commitGate` is actually meant as a pre-send dedupe check that got placed in the wrong position, the fix is to move it *before* `sendProvider`, not to un-defer it.

---

**Q30. What is the refresh-during-gap race condition and why can't `sendSmsOptimizedFlow` fix it?**

```
T+0ms   User clicks Send
T+20ms  sendProvider accepted → UI shows "sent"
T+20ms  5 deferred writes registered, none committed yet
T+25ms  User hits Cmd+R (impatient)
T+25ms  Page reloads. Server queried: "was this sent today?"
        → No row yet → button is clickable
T+30ms  User clicks again → duplicate SMS
T+100ms Deferred writes commit (too late)
```

This race is between client refresh and server-side write commit. Server-side ordering alone cannot close it. The fix requires:
1. UI-side idempotency key stored in `sessionStorage`
2. Pre-send Redis `SETNX` check on the server before `sendProvider`

---

**Q31. What is the `maybeCall` utility function?**

```js
async function maybeCall(fn, arg) {
  if (typeof fn !== "function") return null;
  return await fn(arg);
}
```

It safely calls an optional function with one argument, returning `null` if the function wasn't provided. This lets tests pass partial `opts` objects without providing every bookkeeping function.

---

**Q32. What does `result.elapsedMs` measure?**

The wall-clock time from the start of `sendSmsOptimizedFlow` to just before the `return` statement. In the optimized flow, this reflects only `sendProvider` latency (~20 ms). It doesn't include deferred bookkeeping time because those run after the function returns.

---

**Q33. What would a Phase 2 `createDeferredContext` look like?**

```js
function createDeferredContext() {
  return {
    waitUntil(job) {
      return bookkeepingQueue.add('generic', { job });
    },
    async flushDeferred() {
      // No-op in production — queue drains asynchronously via worker
    },
    deferredCount() {
      // Could query queue depth
    }
  };
}
```

`sendSmsOptimizedFlow` itself doesn't change — only the context implementation swaps.

---

**Q34. Why does the function create an internal `ctx` if `opts.ctx` is omitted?**

```js
var ctx = opts.ctx || createDeferredContext();
```

This makes the function robust for production callers that forget to pass a context. Deferred work still runs — it's just not observable from outside (no way to call `flushDeferred`). This prevents silent data loss at the cost of reduced observability.

---

**Q35. What are the two reads of `commitGate` and which one did the implementation choose?**

| Read | Meaning | Position | Action |
|---|---|---|---|
| Post-send commit marker | Records the just-completed send for future dedupe lookups | After `sendProvider` — correct as-is | Defer |
| Pre-send dedupe check | Prevents duplicate sends before calling Twilio | Should be before `sendProvider` — currently misplaced | Restructure |

The implementation chose the post-send-commit-marker read because it's structurally consistent with the existing code position. The alternative read is flagged as the top open question.

---

**Q36. Why does `sendSmsCurrentFlow` use `await` for every call sequentially?**

Legacy code written for correctness over performance. Each write was made atomic and sequential to guarantee ordering. The problem is that none of the writes actually need to be sequential — they all take the same `provider` argument and don't read from each other.

---

**Q37. What happens to deferred jobs if the Node.js process crashes mid-flight?**

They are lost. In-memory `Promise.all` dies with the process. This is the core durability gap of Phase 1. Phase 2 addresses it by using BullMQ (Redis-backed) — jobs are persisted to Redis before the process acknowledges them, so a worker can drain them after restart.

---

**Q38. What does `provider` contain and why does every bookkeeping call need it?**

`provider` is the response from `sendProvider` — in production it contains the Twilio/RingCentral message ID and acceptance status. Bookkeeping calls need it because:
- `writeLedger` records the provider message ID for audit
- `writeThread` references the message ID to correlate with inbound replies
- `commitGate` stores the message ID in the dedupe table

---

**Q39. How does the test verify deferred error isolation?**

```js
const errors = [];
const result = await sendSmsOptimizedFlow({
  writeLedger: () => Promise.reject(new Error("ledger db down")),
  writeThread:  () => delay(20, true),
  // ... 4 other jobs succeed
  onDeferredError: (err, jobName) => errors.push({ jobName, message: err.message })
});
assert.equal(result.ok, true);      // Function still returned ok
await ctx.flushDeferred();
assert.equal(errors.length, 1);     // Only one failure surfaced
assert.equal(errors[0].jobName, "writeLedger");
```

---

**Q40. What is the significance of `result.ok: true` even when a deferred job fails?**

`ok: true` reflects that the provider accepted the SMS — from the tenant's perspective, the message was sent. A bookkeeping failure is an internal system issue, not a send failure. The UI should not show an error to the user because of a ledger DB blip. That's why `onDeferredError` routes to logging/alerting rather than the UI response.

---

**Q41. What is the Stripe-style idempotency pattern mentioned in the notes?**

Stripe's API accepts an `Idempotency-Key` header. If the server has already processed a request with that key, it returns the cached response without re-executing the operation. Applied here: the client generates a UUID, includes it in the send request, and the server caches `{key → result}` in Redis. Network retries of the same request are safe because the server recognizes the key.

---

**Q42. What is the pre-send Redis `SETNX` pattern?**

```
SETNX key value  // Set key only if it doesn't exist (atomic)
```

Before calling `sendProvider`:
- Try `SETNX {tenantId}:{templateId}:{date}` with a TTL
- If `NEW` → proceed with send
- If `SEEN` → return cached result, skip `sendProvider`

This closes the duplicate-send race without any blocking DB write.

---

**Q43. Why is there no `async` keyword on `deferJob` itself?**

`deferJob` is synchronous — it registers a job but doesn't wait for it. Adding `async` would misleadingly suggest it awaits the job. The actual async work happens inside the `fn` callback that `deferJob` wraps in a `.then().catch()` chain.

---

**Q44. What is the "process crash before flush" failure mode?**

If the Node.js process terminates (crash, OOM, SIGKILL) after `sendProvider` accepts but before all deferred jobs complete:
- The SMS was sent to the tenant
- Some or all audit/thread/contact rows may be missing
- This is a silent data loss scenario

Phase 1 accepts this risk for low-volume environments. Phase 2 mitigates it via BullMQ persisting jobs to Redis before acknowledgment.

---

**Q45. What is the output of `ctx.deferredCount()` immediately after `sendSmsOptimizedFlow` returns?**

`5` — exactly five `deferJob` calls register with `ctx.waitUntil`, one for each bookkeeping function. The test asserts:
```js
assert.ok(ctx.deferredCount() >= 1);
```
And the provider-rejection test asserts:
```js
assert.equal(ctx.deferredCount(), 0);
```

---

## Section C — Monthly Collections Logic

**Q46. What was wrong with the original `selectMonthlyCollectionsCandidates`?**

It returned every tenant with `balance > 0` as a step-1 candidate with reason `"balance_positive"`. No filtering for:
- Holds
- Escalation track
- Recent replies
- Cadence history
- Spacing
This meant the batch would include tenants in eviction, tenants on dispute holds, and tenants who just responded — all contradicting their actual situation.

---

**Q47. Walk me through the six-gate filter chain.**

```js
function classifyTenant(tenant, opts) {
  // Gate 1 — cheapest, no lookups needed
  if (balance <= 0) return { include: false, reason: "no_balance" };

  // Gate 2 — single boolean check
  if (tenant.hold_flag === true) return { include: false, reason: "on_hold" };

  // Gate 3 — two comparisons
  if (dpd >= 31 || tenant.stage === "16+_dpd") return { include: false, reason: "escalation_track" };

  // Gate 4 — thread lookup (first non-trivial cost)
  var prior = lastMonthStartContact(opts.contacts, tenant.id);
  if (!prior) return { include: true, cadenceStep: 1, reason: "month_start_outreach" };
  if (isMeaningfulRecentInbound(thread, prior.contacted_at)) return { include: false, reason: "tenant_replied_meaningfully" };

  // Gate 5 — date math
  if (days < MIN_STEP_SPACING_DAYS) return { include: false, reason: "min_spacing_not_met" };

  // Gate 6 — cadence cap
  if (priorStep >= MAX_CADENCE_STEP) return { include: false, reason: "max_cadence_reached" };

  return { include: true, cadenceStep: nextStep, reason: stepReason };
}
```

---

**Q48. Why is the filter chain ordered cheapest-first?**

Performance optimization. Balance check requires only one numeric comparison. Hold flag requires one boolean check. Escalation requires two comparisons. Thread lookup requires iterating an array and calling `isMeaningfulTenantReply` on each message. By skipping tenants on cheap checks first, expensive lookups only run for tenants that pass the cheap gates.

---

**Q49. What is `lastMonthStartContact` and what does it return?**

It searches the `contacts` array for the most recent entry matching:
- `tenant_id === tenant.id`
- `cadence_key === "month_start_no_response"`

It returns the contact record (with `cadence_step` and `contacted_at`) or `null` if no prior contact exists. A `null` result means the tenant has never been contacted this cycle → step 1.

---

**Q50. Why does "ok" not pause the cadence but "Zelle sent" does?**

`isMeaningfulTenantReply` in `_data.js` maintains an explicit trivial list:
```js
var trivial = { "k": true, "ok": true, "okay": true, "thanks": true, ... }
```

"ok" is in the trivial list → returns `false` → cadence continues.
"Zelle sent" contains the keyword "zelle" which matches the regex → returns `true` → cadence pauses.

The logic ensures that polite acknowledgements don't accidentally halt the collections process, but real payment intent signals do.

---

**Q51. What is cadence progression logic?**

```js
var priorStep = Number(prior.cadence_step || 1);
var nextStep = priorStep + 1;  // prior step + 1
// Capped by: if priorStep >= MAX_CADENCE_STEP → excluded
```

Prior step 1 → emit step 2 (`no_response_to_step_1`)
Prior step 2 → emit step 3 (`final_no_response`)
Prior step 3 → excluded (`max_cadence_reached`)

---

**Q52. What does `isMeaningfulRecentInbound` check?**

```js
export function isMeaningfulRecentInbound(thread, since) {
  return thread.some(function(msg) {
    // Must be inbound (direction starts with "in")
    if (!dir.startsWith("in")) return false;
    // Must be after the last contact timestamp
    if (sinceDate && (!ts || ts <= sinceDate)) return false;
    // Must pass the canonical meaningful-reply check
    return isMeaningfulTenantReply(msg.body || msg.text || "");
  });
}
```

It delegates to `_data.js` for the "meaningful" classification rather than reimplementing it.

---

**Q53. What is `buildSmartMonthStart` and how does it vary by step?**

```
Step 1: "There is still an outstanding balance of $X. Please let us know when we can expect payment."
Step 2: "We have not yet received a response on the outstanding balance of $X. Please get back to us..."
Step 3: "We have not heard back regarding the outstanding balance of $X. If we do not hear from you..."
```

Each step escalates in urgency while remaining accurate about the tenant's situation.

---

**Q54. What is the `parseDate` helper in `monthly_collections.js`?**

```js
function parseDate(value) {
  if (!value) return null;
  var d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
```

It handles both `Date` objects and ISO strings, returning `null` for invalid inputs. Used defensively throughout the module since tenant data can have inconsistent formats.

---

**Q55. What is the `daysBetween` helper?**

```js
function daysBetween(later, earlier) {
  return Math.floor((later.getTime() - earlier.getTime()) / MS_PER_DAY);
}
```

Returns integer days between two dates. `Math.floor` ensures partial days count as zero — a tenant contacted 2.9 days ago doesn't meet the 3-day minimum.

---

**Q56. What is the `threadsByTenantId` parameter shape?**

```js
{
  "tenant_1": [
    { direction: "in", body: "ok", timestamp: "2026-05-06T14:00:00Z" },
    { direction: "out", body: "Hi...", timestamp: "2026-05-05T15:00:00Z" }
  ]
}
```

An object keyed by tenant ID where values are arrays of SMS message objects. Defaults to empty array per tenant if not provided.

---

**Q57. What is `was_current_at_month_end` and why is it not used?**

It's a field on tenant records that appears to mean "this tenant was current at the end of the previous month" (i.e., this is a new-month miss rather than a chronic late payer). It was left unused in Phase 1 because:
- No test gates on it
- Its exact semantics are unclear
- It's flagged as open question #3 for live Stella verification

If `false` means "chronic late payer," excluding those tenants from friendly month-start outreach might make sense.

---

**Q58. What are the data quality issues spotted in the fixtures?**

1. Only one thread is `phone_matched` — don't assume thread-to-tenant joins are safe
2. `hold_dispute` stage appears outside the standard DPD ladder, always paired with `hold_flag: true`
3. Date format inconsistency: `MM/DD/YYYY` vs `YYYY-MM-DD` in different fields
4. `was_current_at_month_end` present but semantically unclear

---

**Q59. What is the `contacts` array and what fields does each contact need?**

```js
[{
  tenant_id: string,
  cadence_key: string,       // "month_start_no_response"
  cadence_step: number,      // 1, 2, or 3
  contacted_at: string       // ISO date string
}]
```

Represents the historical record of outreach contacts. The batch builder reads this to determine what step each tenant is on.

---

**Q60. What does the batch output look like for one tenant?**

```js
{
  tenantId: "tenant_1",
  cadenceStep: 2,
  message: "Hi Alexander, We have not yet received a response on the outstanding balance of $815.68. Please get back to us as soon as possible with an update.",
  reason: "no_response_to_step_1"
}
```

---

**Q61. Why is the output a reviewable batch rather than a live send?**

The README explicitly requires: "The result should be a reviewable batch of messages first, not automatic live sending." This gives property managers the ability to:
- Remove specific tenants before sending
- Edit message text
- Approve the batch
This prevents automated messages going to tenants with situations the system doesn't know about.

---

**Q62. How does `selectMonthlyCollectionsCandidates` differ from `buildMonthlyCollectionsBatch`?**

`selectMonthlyCollectionsCandidates` returns raw candidate objects with `{ tenant, cadenceStep, reason }`.
`buildMonthlyCollectionsBatch` maps those candidates through `buildSmartMonthStart` to add the actual message text, returning `{ tenantId, cadenceStep, message, reason }`.

---

**Q63. What is the `stage` field on a tenant and what values appear in the fixtures?**

The DPD-ladder stages observed:
- `current` — no balance due
- `1-5_dpd` — 1–5 days past due
- `6-10_dpd` — 6–10 days past due
- `11-15_dpd` — 11–15 days past due
- `16+_dpd` — 16+ days past due (escalation)
- `hold_dispute` — on hold due to a dispute (outside the DPD ladder)

---

**Q64. What tenant would cause the monthly batch to emit step 3?**

A tenant with:
- `balance > 0`
- `hold_flag: false`
- `days_past_due < 31` and stage ≠ `16+_dpd`
- No meaningful inbound reply since last contact
- Last contacted ≥ 3 days ago
- Prior `cadence_step === 2`

---

**Q65. How would you add per-property spacing configuration?**

Replace the top-level constant with a lookup:
```js
function getSpacingDays(tenant) {
  return spacingConfig[tenant.property_id] || MIN_STEP_SPACING_DAYS;
}
```
Or accept a `spacingDays` field in `opts`. The constants were deliberately extracted to the module top to make this a small change.

---

## Section D — JavaScript & Node.js Internals

**Q66. What is the difference between `Promise.all` and individual `.catch` handlers?**

`Promise.all` fails fast — the first rejection causes it to reject immediately, even if other promises are still pending or would resolve. Individual `.catch` handlers on each promise mean each settles independently. This is the core safety property of the deferred job isolation.

---

**Q67. What is the event loop and how does `ctx.waitUntil` interact with it?**

The event loop processes macrotasks (setTimeout, I/O) and microtasks (Promise callbacks) sequentially. `ctx.waitUntil` registers promises that the event loop continues to process after the HTTP response is sent. The promises are still in the microtask queue — they don't block the response, but they do execute before the process goes idle.

---

**Q68. What does `Promise.resolve().then(fn)` do that `fn()` alone doesn't?**

`Promise.resolve().then(fn)` schedules `fn` as a microtask — it runs asynchronously, after the current synchronous frame completes. `fn()` would run synchronously if `fn` is not async. This ensures deferred jobs don't start executing before `sendSmsOptimizedFlow` returns its result.

---

**Q69. What is `async`/`await` under the hood?**

`async` functions return Promises. `await` is syntactic sugar for `.then()` — it yields execution until the awaited Promise settles, then resumes on the next microtask tick. `async function foo()` compiles to a generator-based state machine in older engines; in V8 it's natively optimized.

---

**Q70. What is the difference between `var`, `let`, and `const` and which does this codebase use?**

The codebase uses `var` throughout the source files (older style) and `const`/`let` in the test file (modern style). All three have function-level scoping for `var` and block-level for `let`/`const`. `const` prevents reassignment; `let` allows it.

---

**Q71. What is Node.js's built-in test runner (`node --test`)?**

Available since Node.js 18 (stable in 20), it provides:
- `test(name, fn)` — define a test
- `assert` — Node's built-in assertion library
- `node --test` CLI — discovers and runs `.test.mjs` / `.test.js` files
- No external dependencies needed (no Jest, Mocha, Vitest)

---

**Q72. What is the `with { type: "json" }` import attribute in the test file?**

```js
import tenantsFixture from "../fixtures/real_collections_tenant_cases.json" with { type: "json" };
```

It's a Node.js import assertion (JSON module) required when importing `.json` files as ES modules. Without it, Node.js wouldn't know how to parse the file as JSON.

---

**Q73. What does `Number.isNaN` do and how is it different from `isNaN`?**

`Number.isNaN(value)` returns `true` only if `value` is the actual `NaN` value. The global `isNaN(value)` coerces the argument first — `isNaN("hello")` returns `true`, but `Number.isNaN("hello")` returns `false`. The codebase uses `Number.isNaN(d.getTime())` to safely check for invalid Date objects.

---

**Q74. What is `Array.prototype.some` and how is it used in `isMeaningfulRecentInbound`?**

`some` returns `true` as soon as one element passes the predicate — it short-circuits. Used here to check if any message in the thread is an inbound meaningful reply after the last contact. More efficient than `filter(...).length > 0` because it stops at the first match.

---

**Q75. What is the `matchAll` method and where is it used?**

`String.prototype.matchAll(regex)` returns an iterator of all matches including capture groups. Used in `_smart_templates.js` for `hasPositiveMatch` to find all occurrences of a regex and check if any are not negated. Requires the `g` flag on the regex.

---

**Q76. What is closure and how is it used in `createDeferredContext`?**

```js
function createDeferredContext() {
  var jobs = [];   // Closed over
  return {
    waitUntil: function(promise) { jobs.push(...); },
    flushDeferred: async function() { await Promise.all(jobs); },
    deferredCount: function() { return jobs.length; }
  };
}
```

The `jobs` array is in the outer function's scope. The three returned methods close over it — they all share the same `jobs` reference. This is the module pattern for encapsulation without classes.

---

**Q77. What is the ES Module `import`/`export` system vs CommonJS `require`?**

| Feature | ES Modules | CommonJS |
|---|---|---|
| Syntax | `import`/`export` | `require()`/`module.exports` |
| Loading | Static (parsed at compile time) | Dynamic (runtime) |
| Top-level await | Supported | Not supported |
| Tree-shaking | Possible | Hard |
| `"type": "module"` | Required in package.json | Default |

---

**Q78. What is `delay` in the test file and what does it simulate?**

```js
function delay(ms, value) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}
```

It simulates asynchronous latency — `delay(80, true)` resolves with `true` after 80ms. Used to mock database writes at realistic latencies without actual DB connections.

---

**Q79. How does `assert.rejects` work?**

```js
await assert.rejects(
  () => sendSmsOptimizedFlow({ sendProvider: () => Promise.reject(new Error("fail")) }),
  /fail/
);
```

It awaits the async function, expects it to reject, and optionally validates the error against a regex or class. If the function resolves instead of rejecting, the assertion fails.

---

**Q80. What is `assert.doesNotMatch` and when is it used in the fixture test?**

```js
assert.doesNotMatch(serialized, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
```

It asserts that a string does NOT match a regex. Used to verify that the serialized fixtures don't contain any email addresses or phone numbers — ensuring the sanitization was successful.

---

## Section E — System Design & Production Architecture

**Q81. What are the six production failure modes Phase 1 doesn't close?**

1. Refresh during ~80ms deferred-write gap → duplicate SMS
2. Two tabs / two devices sending same template same day
3. Network retry of same HTTP request
4. Process crash before deferred writes flush → lost audit rows
5. Persistent write failure (DB constraint) → `onDeferredError` surfaces but recovery is manual
6. User opens page hours later — button still active (no server-side read-back guard)

---

**Q82. Describe the Phase 2 architecture end-to-end.**

```
Frontend:
  • Generate idempotency_key (UUID) on form open
  • Persist {key, startedAt, tenant, template} → sessionStorage before API call
  • On refresh during gap → restore "sending..." state
  • Include idempotency_key in every send request

API (sendSmsOptimizedFlow):
  1. preSendDedupeCheck(key) → Redis SETNX (~5ms)
     SEEN → return cached result, NO RE-SEND
  2. sendProvider() → Twilio (~20ms)
     rejected → DEL key, return error
  3. Cache result in Redis against key
  4. Enqueue 5 bookkeeping jobs → BullMQ (~5ms each)
  5. Return in ~20ms

Worker (separate process):
  • Drains BullMQ queue
  • Writes to Postgres
  • Exponential backoff retries
  • Dead-letter queue + alerts
  • Survives API restart — queue is durable
```

---

**Q83. What is BullMQ and why is it recommended for Phase 2?**

BullMQ is a Node.js job queue backed by Redis. Features relevant here:
- **Durability**: Jobs are persisted in Redis before acknowledgment — survive process crashes
- **Retries**: Configurable exponential backoff on failure
- **Dead-letter queue**: Permanently failed jobs go to a DLQ with alerting
- **Dashboard**: Built-in visibility into job health, queue depth, processing latency
- **Worker isolation**: Workers run as separate processes, scaled independently from the API

---

**Q84. What is the outbox pattern and how does it apply here?**

The outbox pattern writes job intents to a local DB table within the same transaction as the main operation:
```sql
BEGIN;
  INSERT INTO sms_sends ...;
  INSERT INTO outbox (job_type, payload) VALUES ('writeLedger', ...);
COMMIT;
```
A separate worker reads the outbox and executes the real bookkeeping writes. This closes the "process crash before flush" gap because the intent was persisted atomically with the send record.

---

**Q85. What is Redis `SETNX` and how does it solve the duplicate-send problem?**

`SETNX key value` is an atomic "set if not exists" operation. Used as a pre-send dedupe check:
```
SETNX "{tenantId}:{templateId}:{date}" "1" EX 86400
→ 1 (new) → proceed with sendProvider
→ 0 (exists) → return cached result, skip sendProvider
```

Because SETNX is atomic, two concurrent requests for the same tenant/template/date will race, one wins, one gets the "SEEN" response — preventing double sends.

---

**Q86. What is the sessionStorage strategy for idempotency across refreshes?**

1. On form open: generate UUID, store `{key, startedAt, tenantId, templateId}` in `sessionStorage`
2. Before calling API: check if key exists in `sessionStorage` (form still open = same send intent)
3. After sending: mark key as "completed" or "pending" in `sessionStorage`
4. On page reload: read `sessionStorage`, if key exists and `startedAt` is recent, show "sending..." state
5. On API response: update `sessionStorage` with result

This gives the page continuity across the ~80ms deferred-write gap.

---

**Q87. Why is the migration from Phase 1 to Phase 2 a "one-file change"?**

Because `sendSmsOptimizedFlow` calls `ctx.waitUntil(...)` without knowing what `ctx` is. The entire Phase 2 migration is:
1. Update `createDeferredContext` to enqueue via BullMQ instead of push to in-memory array
2. `sendSmsOptimizedFlow` doesn't change
3. Callers don't change (they still pass `ctx`)

The interface was deliberately designed to be an abstraction boundary.

---

**Q88. What is exponential backoff and why is it used in job retries?**

Exponential backoff delays retries by increasing intervals: 1s, 2s, 4s, 8s... This prevents:
- Thundering herd — all failed jobs retrying simultaneously after a DB outage
- Overloading a DB that's recovering
- Wasted compute on rapid retries for persistent errors

BullMQ implements this with configurable base delay and maximum retry count.

---

**Q89. What is a dead-letter queue (DLQ)?**

A DLQ is a queue where jobs go after exhausting all retry attempts. Purpose:
- Preserve failed jobs for manual inspection and replay
- Trigger alerts when jobs enter the DLQ
- Prevent indefinite retry loops for fundamentally broken payloads

In this context, a `writeLedger` job that fails all retries would end up in the DLQ — triggering an alert for the engineering team to investigate the compliance gap.

---

**Q90. What is "page-load read-back guard" mentioned in the Phase 2 recommendations?**

On page load, the UI queries the server: "Was template X sent to tenant Y today?"
```
GET /api/sent?tenantId=Y&templateId=X&date=today
→ hit  → render "Already sent at HH:MM" (button disabled)
→ miss → render "Send" (button enabled)
```

This prevents the scenario where a user opens the page hours after a send and clicks the button again because the UI has no memory of the previous send.

---

**Q91. What is the difference between horizontal and vertical scaling for the worker process?**

- **Vertical**: Give the single worker process more CPU/memory — limited by one machine
- **Horizontal**: Run multiple worker processes consuming from the same BullMQ Redis queue — scales linearly

BullMQ supports horizontal scaling natively — multiple workers competing for jobs from the same queue, each claiming exclusive ownership of a job via Redis locks.

---

**Q92. What is the two-phase commit problem and is it relevant here?**

Two-phase commit coordinates distributed transactions across multiple systems. Here, the problem manifests as: `sendProvider` succeeded but `writeLedger` failed — the SMS is sent but the audit record doesn't exist.

Phase 1 accepts this inconsistency as acceptable for low-DPD bookkeeping. Phase 2 mitigates it via the outbox pattern — writing job intents atomically with the send record before calling `sendProvider`.

---

**Q93. What monitoring would you add in production?**

| Signal | Tool | Alert Threshold |
|---|---|---|
| Deferred job failure rate | `onDeferredError` → Datadog/Sentry | Any `writeLedger` failure |
| Queue depth | BullMQ dashboard | > 100 pending jobs |
| Worker processing latency | BullMQ metrics | p99 > 500ms |
| DLQ size | Redis keyspace + alert | Any entry |
| API response time | APM | p99 > 100ms |
| Duplicate send rate | Custom metric on `SETNX` returns | Any > 0 in 1hr |

---

**Q94. How would you test the refresh-during-gap race condition?**

It can't be deterministically unit-tested because it depends on wall-clock timing. Approaches:
1. **Integration test with artificial delay**: Mock `waitUntil` to introduce a 200ms gap, simulate a concurrent request within that window
2. **Contract test**: Test the idempotency key behavior independently — verify that two requests with the same key return the same result without re-calling `sendProvider`
3. **Chaos testing**: Deploy to staging, use a script to reload the page during active sends

---

**Q95. What is the "bookkeeping write order dependency" open question?**

If `writeContact` reads state that `writeLedger` writes (e.g., needs the ledger ID as a foreign key), then the deferred jobs must run in order, not in parallel. Currently they're registered with `Promise.all` semantics (parallel). Phase 2 would need to configure BullMQ job dependencies to enforce ordering if this is true in production.

---

## Section F — Testing Strategy

**Q96. Why were the original 7 tests preserved verbatim?**

They serve as the behavioral contract — the specification from the client. Weakening or renaming them would break the contract even if the implementation improved. Preserving them verbatim proves the implementation doesn't regress existing behavior.

---

**Q97. What do the 7 added tests cover?**

| Test | Edge Case |
|---|---|
| Provider rejection + zero deferred work | Error path cleanup |
| Deferred error via `onDeferredError` without poisoning | Per-job isolation |
| Tenants on hold excluded | `hold_flag` gate |
| Step 3 after step 2 with trivial reply | Cadence progression + "ok" pass-through |
| No step 4 ever emitted | `MAX_CADENCE_STEP` cap |
| Minimum 3-day spacing enforced | `MIN_STEP_SPACING_DAYS` gate |
| Payment language reply excluded | `isMeaningfulTenantReply` payment keywords |

---

**Q98. Why is the test suite fully offline?**

Per the client's constraint: no network calls, API clients, SMS sending, external AI calls, or credentials. Tests use in-memory mocks and fixture JSON. This makes the suite:
- Fast (~225ms total)
- Deterministic (no network flakiness)
- Safe (no accidental sends to real tenants)
- Portable (runs anywhere with Node ≥ 20)

---

**Q99. What is the test for the "meaningful reply" cadence pause checking?**

```js
test("monthly batch excludes tenants who replied meaningfully after the last outreach", () => {
  const candidates = selectMonthlyCollectionsCandidates({
    ...
    threadsByTenantId: {
      tenant_1: [
        { direction: "in", body: "I sent the payment today.", timestamp: "2026-05-06T..." }
      ]
    }
  });
  assert.equal(candidates.length, 0);
});
```

The body "I sent the payment today." contains "payment" → `isMeaningfulTenantReply` returns `true` → cadence paused.

---

**Q100. How would you add a test for the `no_balance` gate?**

```js
test("monthly batch excludes tenants with zero balance", () => {
  const candidates = selectMonthlyCollectionsCandidates({
    now: new Date("2026-05-05T16:00:00Z"),
    tenants: [tenant({ balance: 0 })],
    contacts: [],
    threadsByTenantId: {}
  });
  assert.equal(candidates.length, 0);
});
```

---

**Q101. What testing pattern is used for the deferred error test?**

The test uses a **spy pattern** — it passes an `onDeferredError` callback that pushes to a local `errors` array, then asserts on that array after `flushDeferred`. This avoids needing a mocking library.

---

**Q102. Why does `assert.ok(elapsed < 90)` use 90ms instead of exactly 20ms?**

`delay(20, ...)` is a minimum — `setTimeout` is not precise. The 90ms buffer accommodates:
- Timer resolution on slow CI machines
- Event loop overhead
- JS engine startup cost

The guard is loose enough to not produce flaky tests but tight enough to catch if someone accidentally adds a blocking write.

---

**Q103. How would you test that `buildMonthlyCollectionsBatch` generates correct step 2 messages?**

```js
test("batch generates step 2 message for pending tenant", () => {
  const batch = buildMonthlyCollectionsBatch({
    now: new Date("2026-05-08T16:00:00Z"),
    tenants: [tenant()],
    contacts: [{ tenant_id: "tenant_1", cadence_key: "month_start_no_response", cadence_step: 1, contacted_at: "2026-05-05T15:00:00Z" }],
    threadsByTenantId: { tenant_1: [{ direction: "in", body: "ok", timestamp: "2026-05-06T..." }] }
  });
  assert.equal(batch[0].cadenceStep, 2);
  assert.equal(batch[0].reason, "no_response_to_step_1");
  assert.match(batch[0].message, /not yet received a response/);
});
```

---

**Q104. What is the fixture integrity test checking?**

```js
test("fixtures include sanitized real thread and tenant examples", () => {
  assert.equal(threadsFixture.examples.length, 50);
  assert.equal(tenantsFixture.cases.length, 50);
  assert.doesNotMatch(serialized, /email_regex/);
  assert.doesNotMatch(serialized, /phone_regex/);
});
```

It verifies:
1. Both fixtures have exactly 50 records
2. No email addresses leaked through sanitization
3. No phone numbers leaked through sanitization

---

**Q105. What would you do if you needed to test the BullMQ integration in Phase 2?**

1. Use `bullmq`'s `MockQueue` or an in-memory Redis mock (`ioredis-mock`)
2. Test that jobs are enqueued with correct payloads
3. Test that the worker processes jobs and makes the expected DB calls
4. Integration test with a real Redis in a Docker container in CI
5. Test idempotency: re-process the same job, assert no duplicate DB writes

---

## Section G — Scenario / Behavioural Questions

**Q106. A property manager reports that a tenant received the same SMS twice. How do you debug it?**

1. Check the ledger — are there two `writeLedger` rows for the same tenant/template/date?
2. Check server logs — were there two HTTP requests, or one request with two `sendProvider` calls?
3. Check the deferred commit: did `commitGate` succeed? If not, the deduplication table has no record of the first send
4. Check for the refresh-during-gap scenario — timestamp difference between the two sends
5. Long-term: implement Redis `SETNX` pre-send check and UI idempotency key

---

**Q107. The `writeLedger` function is failing silently. How do you surface it?**

In Phase 1: pass `onDeferredError` callback:
```js
sendSmsOptimizedFlow({
  ...,
  onDeferredError: (err, jobName) => {
    if (jobName === "writeLedger") alertComplianceTeam(err);
    logger.error({ jobName, err });
  }
});
```

In Phase 2: BullMQ's DLQ will catch persistent failures, with automatic alerting on queue depth.

---

**Q108. A new developer asks: "Why not just increase the database connection pool to make the current flow faster?" How do you respond?**

Connection pool tuning reduces wait time for DB connections but doesn't eliminate the fundamental bottleneck: five sequential 80ms writes = 400ms minimum, regardless of pool size. The writes could be parallelized (saving ~320ms) while still blocking the HTTP response, or deferred entirely (saving ~400ms). The optimal solution depends on whether callers need to know that writes completed — and in this case, they don't.

---

**Q109. The client wants to add a fourth cadence step. How do you implement it?**

Two changes:
1. Update `MAX_CADENCE_STEP` from 3 to 4 at the top of `monthly_collections.js`
2. Add a new reason and message template for step 4 in `buildSmartMonthStart`:
```js
} else {
  // step 4 — ultra-final
  core = "This is our final automated notice regarding the outstanding balance of $" + balStr + ".";
  ask = "Please contact us immediately to avoid formal proceedings.";
}
```
No other code changes needed — the progression logic is generic.

---

**Q110. A PM asks: "Can we run the monthly batch automatically on the 1st of each month?" What do you say?**

The batch is currently pure logic with no scheduler. To automate it:
1. Add a cron job (node-cron or system cron) that calls `buildMonthlyCollectionsBatch` on the 1st
2. Write results to a `pending_batches` table instead of sending directly
3. Send a Slack/email notification to the PM with a link to review the batch
4. PM approves → system sends the messages via `sendSmsOptimizedFlow`

The "reviewable first" constraint in the README should be preserved even with automation.

---

**Q111. How would you handle a tenant who opts out of SMS?**

Add a seventh gate to `classifyTenant`:
```js
if (tenant.sms_opt_out === true) {
  return { include: false, reason: "sms_opt_out" };
}
```

Place it after `hold_flag` (both are early-exit boolean checks). Also:
- Store the opt-out flag from STOP replies (Twilio handles this automatically but the DB needs updating)
- Ensure `send_flow.js` checks opt-out status before calling `sendProvider`
- Add legal compliance logging for opt-out handling

---

**Q112. The test suite is passing but the client says the batch is still including escalation tenants in production. How do you investigate?**

The test uses `stage: "16+_dpd"` specifically. Possible mismatches:
1. Production data has different stage strings (e.g., `"16+dpd"` without underscore) — check for string matching issues
2. `days_past_due` is stored differently in the live DB (string vs. number)
3. The production version of `monthly_collections.js` wasn't actually updated — verify the deploy
4. The filter was correct but contacts data isn't being passed, causing every tenant to appear as "first contact" at step 1

---

**Q113. The client wants to add a "hardship hold" that's different from the regular hold. How do you extend the system?**

Option A — extend the `hold_flag` check:
```js
if (tenant.hold_flag === true || tenant.hold_reason === "hardship") {
  return { include: false, reason: "on_hold" };
}
```

Option B — add a new gate between hold and escalation:
```js
if (tenant.hardship_flag === true) {
  return { include: false, reason: "hardship_hold" };
}
```

Option B is better because hardship holds may need different downstream routing (e.g., route to a counseling team), not just exclusion.

---

**Q114. How would you add logging to track how many tenants hit each filter gate?**

Add an optional `metrics` callback to `selectMonthlyCollectionsCandidates`:
```js
function classifyTenant(tenant, opts) {
  // ... same logic but:
  var result = { include: false, reason: "no_balance" };
  opts.metrics && opts.metrics.increment("skip." + result.reason);
  return result;
}
```

Or accumulate skip-reason counts in a summary object and return it alongside the candidates:
```js
return { candidates, skips: { no_balance: 12, on_hold: 3, ... } };
```

---

**Q115. You're doing a code review and see a colleague added `await ctx.flushDeferred()` directly inside `sendSmsOptimizedFlow` before the return. What do you say?**

This defeats the entire purpose of the optimization. Awaiting `flushDeferred` before returning means the function blocks until all five bookkeeping writes complete — exactly the same as `sendSmsCurrentFlow`. The correct pattern is:
- Return immediately after `sendProvider`
- Let the caller decide when to flush (tests call `flushDeferred` for assertion, production lets it drain in the background)
- Document that `flushDeferred` should only be called at graceful shutdown, not in the request path

---

## Quick-Reference Cheat Sheet

### Key Numbers
| Metric | Value |
|---|---|
| `sendSmsCurrentFlow` latency | ~420ms |
| `sendSmsOptimizedFlow` latency | ~20ms |
| Test execution time | ~225ms |
| Total tests | 14 (7 original + 7 added) |
| Bookkeeping calls deferred | 5 |
| Monthly batch filter gates | 6 |
| Max cadence step | 3 |
| Min step spacing | 3 days |
| Fixture records | 50 threads + 50 tenant cases |

### Key Files and Their Purpose
| File | Purpose |
|---|---|
| `src/send_flow.js` | SMS send path — current + optimized + `deferJob` helper |
| `src/monthly_collections.js` | Tenant selection + batch builder |
| `src/_data.js` | Canonical helpers: `isMeaningfulTenantReply`, `normalizeSmsText` |
| `src/_smart_templates.js` | Context-aware SMS composer |
| `test/send_latency_and_monthly.test.mjs` | 14 tests |

### Critical Design Decisions
| Decision | Reason |
|---|---|
| Block only on `sendProvider` | SMS in provider queue = nothing left to block on |
| Each deferred job in own `.catch` | One failure must not poison other jobs |
| `commitGate` deferred | Position after `sendProvider` = post-send commit marker, not pre-send check |
| Meaningful reply delegates to `_data.js` | One canonical rule across the codebase |
| Filter chain cheapest-first | Skip expensive lookups for easy-exit cases |
| `ctx.waitUntil` interface preserved | Phase 2 swaps implementation without changing callers |
| No new dependencies | Client constraint: offline, `npm test` only |

### Open Questions for Live Stella Verification
1. Is `commitGate` a post-send marker or a misplaced pre-send check?
2. Does Stella have any pre-send idempotency check today?
3. Should `was_current_at_month_end === false` exclude a tenant?
4. Should `hold_dispute` route differently than other holds?
5. Is the 3-day spacing right per property/track?
6. What's the durability requirement for deferred writes?
7. Are the 5 bookkeeping writes order-dependent?

---

*End of guide. 115 questions across 7 sections covering the full depth of this project.*