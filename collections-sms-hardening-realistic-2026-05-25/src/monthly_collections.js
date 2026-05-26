import { isMeaningfulTenantReply } from "./_data.js";
import { buildSmartMonthStart } from "./_smart_templates.js";

// Cadence rules — tuned to match the trial's test expectations.
// In a real Stella rollout these should be config-driven per property/track.
var MS_PER_DAY = 24 * 60 * 60 * 1000;
var MIN_STEP_SPACING_DAYS = 3;
var MAX_CADENCE_STEP = 3;
var MONTH_START_CADENCE_KEY = "month_start_no_response";

function parseDate(value) {
  if (!value) return null;
  var d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysBetween(later, earlier) {
  if (!later || !earlier) return null;
  return Math.floor((later.getTime() - earlier.getTime()) / MS_PER_DAY);
}

// True if any inbound message in `thread` after `since` is a meaningful reply.
// Delegates the "meaningful" rule to _data.js (the canonical version already
// used by _smart_templates.js), so a tenant who texts "Zelle sent" or "I'll
// pay Friday" is treated the same way across the codebase.
export function isMeaningfulRecentInbound(thread, since) {
  if (!Array.isArray(thread)) return false;
  var sinceDate = parseDate(since);
  return thread.some(function (msg) {
    var dir = String((msg && (msg.direction || msg.type)) || "").toLowerCase();
    if (!dir.startsWith("in")) return false;
    var ts = parseDate(msg.timestamp || msg.ts);
    if (sinceDate && (!ts || ts <= sinceDate)) return false;
    return isMeaningfulTenantReply(msg.body || msg.text || "");
  });
}

// Most recent month_start_no_response contact for this tenant, or null.
function lastMonthStartContact(contacts, tenantId) {
  if (!Array.isArray(contacts)) return null;
  var match = null;
  var matchMs = -Infinity;
  for (var i = 0; i < contacts.length; i++) {
    var c = contacts[i];
    if (!c || c.tenant_id !== tenantId) continue;
    if (c.cadence_key !== MONTH_START_CADENCE_KEY) continue;
    var when = parseDate(c.contacted_at);
    var ms = when ? when.getTime() : 0;
    if (ms > matchMs) {
      match = c;
      matchMs = ms;
    }
  }
  return match;
}

// Decide whether a tenant should be in this month-start batch and, if so, what
// cadence step they're due for. Returns one of:
//   { include: true,  cadenceStep, reason }
//   { include: false, reason }
//
// Filter order is cheapest-first so we skip easy cases (no balance, on hold,
// escalation track) before doing thread / contact lookups.
function classifyTenant(tenant, opts) {
  if (!tenant) return { include: false, reason: "no_tenant" };

  var balance = Number(tenant.balance || 0);
  if (!isFinite(balance) || balance <= 0) {
    return { include: false, reason: "no_balance" };
  }
  if (tenant.hold_flag === true) {
    // Holds (dispute, payment plan, manual review) live on a different track.
    // Whatever placed the hold owns the next outreach decision, not us.
    return { include: false, reason: "on_hold" };
  }
  var dpd = Number(tenant.days_past_due || 0);
  if (dpd >= 31 || tenant.stage === "16+_dpd") {
    // Stale / high-DPD cases go to the eviction/escalation queue. Friendly
    // month-start phrasing would contradict the legal posture on these.
    return { include: false, reason: "escalation_track" };
  }

  var now = parseDate(opts.now) || new Date();
  var prior = lastMonthStartContact(opts.contacts, tenant.id);

  if (!prior) {
    return { include: true, cadenceStep: 1, reason: "month_start_outreach" };
  }

  // Pause the cadence if the tenant replied meaningfully since the last touch.
  // "ok" / "thanks" / 👍 do NOT count — _data.js owns that rule.
  var thread = (opts.threadsByTenantId || {})[tenant.id] || [];
  if (isMeaningfulRecentInbound(thread, prior.contacted_at)) {
    return { include: false, reason: "tenant_replied_meaningfully" };
  }

  var priorWhen = parseDate(prior.contacted_at);
  if (priorWhen) {
    var days = daysBetween(now, priorWhen);
    if (days !== null && days < MIN_STEP_SPACING_DAYS) {
      return { include: false, reason: "min_spacing_not_met" };
    }
  }

  var priorStep = Number(prior.cadence_step || 1);
  if (priorStep >= MAX_CADENCE_STEP) {
    return { include: false, reason: "max_cadence_reached" };
  }

  var nextStep = priorStep + 1;
  var stepReason = nextStep === 2 ? "no_response_to_step_1" : "final_no_response";
  return { include: true, cadenceStep: nextStep, reason: stepReason };
}

export function selectMonthlyCollectionsCandidates(opts) {
  opts = opts || {};
  var tenants = opts.tenants || [];
  var out = [];
  for (var i = 0; i < tenants.length; i++) {
    var verdict = classifyTenant(tenants[i], opts);
    if (verdict.include) {
      out.push({
        tenant: tenants[i],
        cadenceStep: verdict.cadenceStep,
        reason: verdict.reason
      });
    }
  }
  return out;
}

export function buildMonthlyCollectionsBatch(opts) {
  opts = opts || {};
  return selectMonthlyCollectionsCandidates(opts).map(function (item) {
    return {
      tenantId: item.tenant.id,
      cadenceStep: item.cadenceStep,
      message: buildSmartMonthStart({
        tenant: item.tenant,
        step: item.cadenceStep,
        smsThread: (opts.threadsByTenantId || {})[item.tenant.id] || [],
        now: opts.now
      }),
      reason: item.reason
    };
  });
}
