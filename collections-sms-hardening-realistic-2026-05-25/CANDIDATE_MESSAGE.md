Hi,

Here is the small Stella collections SMS trial package.

Please run `npm test`, then improve the two areas in the package:

1. SMS send speed: make the optimized send flow return quickly after provider acceptance while deferring slow bookkeeping safely.
2. Monthly collections automation: select tenants and generate reviewable monthly SMS batches based on tenant balance, days past due, cadence history, holds, and recent communications.

The goal is not to build a new app. The goal is to make this code safer, faster, and more automated in a way we can apply back to our Stella codebase easily.

Important: this is offline only. Do not add network calls, API clients, SMS sending, external AI calls, deploy steps, or requests for credentials/access. The fixture includes realistic tenant/message context but no phone numbers, emails, tokens, or provider access.

What I will be looking for:

- a practical fix for send latency
- useful monthly automation logic that still keeps messages reviewable
- clean, testable code
- minimal back-and-forth
- practical notes about assumptions and verification

Thanks.
