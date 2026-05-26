import assert from "node:assert/strict";
import { test } from "node:test";
import threadsFixture from "../fixtures/real_threads_sanitized.json" with { type: "json" };
import tenantsFixture from "../fixtures/real_collections_tenant_cases.json" with { type: "json" };
import {
  createDeferredContext,
  sendSmsOptimizedFlow
} from "../src/send_flow.js";
import {
  buildMonthlyCollectionsBatch,
  selectMonthlyCollectionsCandidates
} from "../src/monthly_collections.js";

function delay(ms, value) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function tenant(overrides = {}) {
  return {
    id: "tenant_1",
    first_name: "Alexander",
    last_name: "Makler",
    property_name: "10 Robby Dr",
    unit: "(SFH)",
    balance: 815.68,
    days_past_due: 5,
    stage: "1-5_dpd",
    track: "standard",
    was_current_at_month_end: true,
    hold_flag: false,
    ...overrides
  };
}

test("fixtures include sanitized real thread and tenant examples", () => {
  assert.equal(threadsFixture.examples.length, 50);
  assert.equal(tenantsFixture.cases.length, 50);
  const serialized = JSON.stringify({ threadsFixture, tenantsFixture });
  assert.doesNotMatch(serialized, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  assert.doesNotMatch(serialized, /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/);
});

test("optimized SMS flow returns after provider acceptance and defers slow bookkeeping", async () => {
  const ctx = createDeferredContext();
  const started = Date.now();
  const result = await sendSmsOptimizedFlow({
    ctx,
    message: "Hi Alexander, your balance is $815.68.",
    sendProvider: () => delay(20, { id: "provider_accepted" }),
    writeLedger: () => delay(80, true),
    writeThread: () => delay(80, true),
    writeContact: () => delay(80, true),
    updateTenant: () => delay(80, true),
    commitGate: () => delay(80, true)
  });

  const elapsed = Date.now() - started;
  assert.equal(result.ok, true);
  assert.equal(result.providerAccepted, true);
  assert.ok(elapsed < 90, "response should not wait for all bookkeeping writes");
  assert.ok(ctx.deferredCount() >= 1, "slow bookkeeping should be registered with waitUntil/deferred work");
  await ctx.flushDeferred();
});

test("monthly batch includes current-ish tenants with balances on the 5th", () => {
  const candidates = selectMonthlyCollectionsCandidates({
    now: new Date("2026-05-05T16:00:00Z"),
    tenants: [tenant()],
    contacts: [],
    threadsByTenantId: {}
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].cadenceStep, 1);
});

test("monthly batch excludes stale high-DPD tenants from friendly month-start automation", () => {
  const candidates = selectMonthlyCollectionsCandidates({
    now: new Date("2026-05-05T16:00:00Z"),
    tenants: [tenant({ id: "late", days_past_due: 31, stage: "16+_dpd" })],
    contacts: [],
    threadsByTenantId: {}
  });

  assert.equal(candidates.length, 0);
});

test("monthly batch excludes tenants who replied meaningfully after the last outreach", () => {
  const candidates = selectMonthlyCollectionsCandidates({
    now: new Date("2026-05-08T16:00:00Z"),
    tenants: [tenant()],
    contacts: [
      { tenant_id: "tenant_1", cadence_key: "month_start_no_response", cadence_step: 1, contacted_at: "2026-05-05T15:00:00Z" }
    ],
    threadsByTenantId: {
      tenant_1: [
        { direction: "out", body: "Please let us know when we can expect payment.", timestamp: "2026-05-05T15:00:00Z" },
        { direction: "in", body: "I sent the payment today.", timestamp: "2026-05-06T14:00:00Z" }
      ]
    }
  });

  assert.equal(candidates.length, 0);
});

test("monthly batch step 2 is due on the 8th after step 1 with no meaningful reply", () => {
  const candidates = selectMonthlyCollectionsCandidates({
    now: new Date("2026-05-08T16:00:00Z"),
    tenants: [tenant({ stage: "6-10_dpd", days_past_due: 8 })],
    contacts: [
      { tenant_id: "tenant_1", cadence_key: "month_start_no_response", cadence_step: 1, contacted_at: "2026-05-05T15:00:00Z" }
    ],
    threadsByTenantId: {
      tenant_1: [
        { direction: "out", body: "Please let us know when we can expect payment.", timestamp: "2026-05-05T15:00:00Z" },
        { direction: "in", body: "ok", timestamp: "2026-05-06T14:00:00Z" }
      ]
    }
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].cadenceStep, 2);
});

test("monthly batch generates reviewable script messages, not live sends", () => {
  const batch = buildMonthlyCollectionsBatch({
    now: new Date("2026-05-05T16:00:00Z"),
    tenants: [tenant()],
    contacts: [],
    threadsByTenantId: {}
  });

  assert.equal(batch.length, 1);
  assert.equal(batch[0].tenantId, "tenant_1");
  assert.match(batch[0].message, /Alexander/);
  assert.match(batch[0].message, /\$815\.68/);
  assert.doesNotMatch(JSON.stringify(batch), /sendNow|provider|twilio|ringcentral/i);
});

// ── Added coverage tests ─────────────────────────────────────────────────────

test("optimized SMS flow surfaces provider rejection and registers no deferred work", async () => {
  const ctx = createDeferredContext();
  await assert.rejects(
    () => sendSmsOptimizedFlow({
      ctx,
      message: "Hi Alexander, your balance is $815.68.",
      sendProvider: () => Promise.reject(new Error("provider unavailable")),
      writeLedger:  () => delay(80, true),
      writeThread:  () => delay(80, true),
      writeContact: () => delay(80, true),
      updateTenant: () => delay(80, true),
      commitGate:   () => delay(80, true)
    }),
    /provider unavailable/
  );
  assert.equal(ctx.deferredCount(), 0, "no bookkeeping should be queued when the SMS never went out");
});

test("optimized SMS flow surfaces deferred errors via onDeferredError without poisoning other jobs", async () => {
  const ctx = createDeferredContext();
  const errors = [];
  const result = await sendSmsOptimizedFlow({
    ctx,
    message: "Hi Alexander, your balance is $815.68.",
    sendProvider: () => delay(20, { id: "provider_accepted" }),
    writeLedger:  () => Promise.reject(new Error("ledger db down")),
    writeThread:  () => delay(20, true),
    writeContact: () => delay(20, true),
    updateTenant: () => delay(20, true),
    commitGate:   () => delay(20, true),
    onDeferredError: (err, jobName) => errors.push({ jobName, message: err.message })
  });

  assert.equal(result.ok, true);
  assert.equal(result.deferred, true);
  await ctx.flushDeferred();
  assert.equal(errors.length, 1, "only the one failing job should surface");
  assert.equal(errors[0].jobName, "writeLedger");
  assert.match(errors[0].message, /ledger db down/);
});

test("monthly batch excludes tenants on hold", () => {
  const candidates = selectMonthlyCollectionsCandidates({
    now: new Date("2026-05-05T16:00:00Z"),
    tenants: [tenant({ hold_flag: true })],
    contacts: [],
    threadsByTenantId: {}
  });

  assert.equal(candidates.length, 0);
});

test("monthly batch advances to step 3 after step 2 with no meaningful reply", () => {
  const candidates = selectMonthlyCollectionsCandidates({
    now: new Date("2026-05-11T16:00:00Z"),
    tenants: [tenant({ stage: "11-15_dpd", days_past_due: 11 })],
    contacts: [
      { tenant_id: "tenant_1", cadence_key: "month_start_no_response", cadence_step: 2, contacted_at: "2026-05-08T15:00:00Z" }
    ],
    threadsByTenantId: {
      tenant_1: [
        { direction: "in", body: "k", timestamp: "2026-05-09T14:00:00Z" }
      ]
    }
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].cadenceStep, 3);
  assert.equal(candidates[0].reason, "final_no_response");
});

test("monthly batch does not advance past step 3", () => {
  const candidates = selectMonthlyCollectionsCandidates({
    now: new Date("2026-05-14T16:00:00Z"),
    tenants: [tenant({ stage: "11-15_dpd", days_past_due: 14 })],
    contacts: [
      { tenant_id: "tenant_1", cadence_key: "month_start_no_response", cadence_step: 3, contacted_at: "2026-05-11T15:00:00Z" }
    ],
    threadsByTenantId: {}
  });

  assert.equal(candidates.length, 0);
});

test("monthly batch enforces minimum 3-day spacing between steps", () => {
  const candidates = selectMonthlyCollectionsCandidates({
    now: new Date("2026-05-06T16:00:00Z"),
    tenants: [tenant()],
    contacts: [
      { tenant_id: "tenant_1", cadence_key: "month_start_no_response", cadence_step: 1, contacted_at: "2026-05-05T15:00:00Z" }
    ],
    threadsByTenantId: {}
  });

  assert.equal(candidates.length, 0);
});

test("monthly batch excludes tenants who used payment language in their reply", () => {
  const candidates = selectMonthlyCollectionsCandidates({
    now: new Date("2026-05-08T16:00:00Z"),
    tenants: [tenant()],
    contacts: [
      { tenant_id: "tenant_1", cadence_key: "month_start_no_response", cadence_step: 1, contacted_at: "2026-05-05T15:00:00Z" }
    ],
    threadsByTenantId: {
      tenant_1: [
        { direction: "in", body: "Zelle sent", timestamp: "2026-05-06T14:00:00Z" }
      ]
    }
  });

  assert.equal(candidates.length, 0);
});
