# Security Boundaries

This is an offline test package. It contains no working provider credentials and should not require any access to our systems.

Rules for the task:

- Do not ask for or use API keys, bot tokens, SMS provider credentials, deploy access, database access, or live app access.
- Do not add code that sends SMS, email, webhooks, HTTP requests, or production mutations.
- Do not restore phone numbers or email addresses.
- Do not add dependencies unless there is a clear reason and the package still runs with a simple `npm test`.

The fixture keeps real names, properties, units, balances, stages, notes, and message text because those are needed to evaluate judgment. Phone numbers, emails, provider message IDs, and credentials are intentionally removed.
