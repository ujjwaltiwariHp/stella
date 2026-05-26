# Stella Collections SMS Send Speed + Monthly Automation Trial

This package is a sanitized Stella Collections engineering trial. It is intentionally small enough to finish quickly, but the shape matches the real problem we need help with: SMS sends feel too slow, and monthly collections outreach is still too manual.

## Goal

Get us closer to reliable, script-driven monthly collections messages based on tenant balance and recent communications, while also improving the SMS send flow so the UI returns quickly after provider acceptance.

In plain English, we want the candidate to show they can help us with this:

- When we click/send an SMS in Stella, it should not sit there for a long time while slow audit/thread/contact writes finish.
- Stella should be able to generate the monthly rent-balance SMS list automatically from tenant data.
- The monthly script should skip tenants who should not get a message, such as holds, stale/high-DPD cases that need a different escalation path, or tenants who already replied meaningfully.
- The result should be a reviewable batch of messages first, not automatic live sending.

We care about:

- making the send path fast without losing auditability or duplicate protection
- moving slow bookkeeping writes into deferred work
- selecting the right tenants for monthly messages based on balance, days past due, cadence step, holds, and recent replies
- producing reviewable message batches, not live sends
- producing a clean patch that can be moved back into our actual code with minimal rewriting
- keeping the work deterministic and testable

## What To Do

1. Run `npm test`.
2. Improve `src/send_flow.js` so the optimized flow returns after provider acceptance and defers slow bookkeeping.
3. Improve `src/monthly_collections.js` so it selects the correct monthly outreach candidates and builds reviewable message batches.
3. Add or adjust tests if your implementation needs more coverage.
4. Send back a patch/diff or a zipped folder with your changed files.

Do not add network calls, API clients, webhooks, browser automation, paid services, or external AI calls. This should run locally with `npm test`.

## Data

`fixtures/real_threads_sanitized.json` contains 50 real SMS thread examples from our Stella/RingCentral/Twilio artifacts. `fixtures/real_collections_tenant_cases.json` contains 50 exact Stella collections tenant cases with real tenant names, property names, unit numbers, balances, days past due, stages, notes, and historical outbound/draft message text.

Only one historical SMS thread could be phone-matched to the current tenant backup, so the thread fixture marks whether the included tenant context is phone-matched or just sample real collections context. Do not assume every SMS thread belongs to the displayed tenant unless `tenant_context_source` says `phone_matched`.

Phone numbers, emails, provider IDs, session keys, credentials, and access details were removed.

## What A Good Submission Looks Like

- `npm test` passes.
- The code is simple enough to review.
- The logic explains its decisions through return fields like `action`, `category`, and `reason`.
- Send speed improves by splitting the hot path from slow bookkeeping instead of skipping safety.
- Monthly messages are generated as a reviewable batch from tenant balance and recent communications.
- The patch is easy to apply back into Stella, especially around the send flow and monthly cadence logic.
