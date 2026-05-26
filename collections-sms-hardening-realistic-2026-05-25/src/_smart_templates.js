// Smart templates — context-aware draft messages assembled from phrase blocks.
//
// Phrase blocks read tenant state (last reply, last payment, promise date, notes)
// and produce a 1-3 sentence SMS that's deterministic, testable, and personalized
// without requiring an LLM call.
//
// Architecture: opener (signal acknowledgement) + core (escalation reminder) + ask (call to action).
// The most-recent meaningful signal becomes the opener. If no signals are present, the
// output is equivalent in quality to the legacy boilerplate.
//
// Toggled by stella_config.useSmartTemplates (default: true). Original templates in _data.js
// are preserved verbatim and used when the flag is off.

import { isMeaningfulTenantReply, normalizeSmsText } from "./_data.js";

// ── Time helpers ──────────────────────────────────────────────────────────────

// Parse a YYYY-MM-DD string to a Date at midnight ET (close enough for day-comparison).
function parseDateKey(s) {
  if (!s || typeof s !== "string") return null;
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  var d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  if (isNaN(d.getTime())) return null;
  return d;
}

function daysBetween(later, earlier) {
  if (!later || !earlier) return null;
  var ms = later.getTime() - earlier.getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function formatShortDate(d) {
  if (!d) return "";
  var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return months[d.getMonth()] + " " + d.getDate();
}

// ── Signal extraction ─────────────────────────────────────────────────────────

// Last MEANINGFUL inbound message (ignores trivial acknowledgements like "ok", "thx").
function lastMeaningfulInbound(thread) {
  if (!Array.isArray(thread) || thread.length === 0) return null;
  // Walk backwards in time
  var sorted = thread.slice().sort(function(a, b) {
    var ta = new Date(a.timestamp || a.ts || 0).getTime();
    var tb = new Date(b.timestamp || b.ts || 0).getTime();
    return tb - ta;
  });
  for (var i = 0; i < sorted.length; i++) {
    var msg = sorted[i];
    var dir = String(msg.direction || msg.type || "").toLowerCase();
    if (dir.indexOf("in") === -1) continue;
    var body = msg.body || msg.text || msg.subject || "";
    if (!body) continue;
    if (!isMeaningfulTenantReply(body)) continue;
    return {
      body: normalizeSmsText(body),
      timestamp: new Date(msg.timestamp || msg.ts || 0)
    };
  }
  return null;
}

// Within ~30 chars before `idx`, does a negation word appear without an intervening sentence
// boundary? Prevents "not working with us" from being classified as cooperative.
function isNegated(lower, idx) {
  if (idx <= 0) return false;
  var start = Math.max(0, idx - 30);
  var window = lower.slice(start, idx);
  // Sentence boundary inside window — negation in a prior sentence doesn't apply.
  var lastBoundary = Math.max(window.lastIndexOf("."), window.lastIndexOf(";"), window.lastIndexOf(":"), window.lastIndexOf("\n"));
  if (lastBoundary !== -1) window = window.slice(lastBoundary + 1);
  return /\b(not|no\s+longer|never|stopped|refuses?|won't|wont|isn't|isnt|doesn't|doesnt|hasn't|hasnt|hadn't|hadnt)\b/.test(window);
}

// True if `lower` contains at least one match of `regex` that is NOT negated.
function hasPositiveMatch(lower, regex) {
  var flags = regex.flags.indexOf("g") === -1 ? regex.flags + "g" : regex.flags;
  var globalRe = new RegExp(regex.source, flags);
  var matches = lower.matchAll(globalRe);
  for (var m of matches) {
    if (!isNegated(lower, m.index)) return true;
  }
  return false;
}

// Categorize note text into a tone tag. Hardship trumps cooperation/active when ambiguous.
// Negation-aware: "not working with us" is NOT classified as cooperative.
function noteToneTag(notes) {
  if (!notes || typeof notes !== "string") return null;
  var lower = notes.toLowerCase();
  var hardshipRe = /\b(lost\s+job|laid\s+off|unemploy(ed|ment)?|hospital(ized)?|medical|illness|sick|surgery|family\s+emergency|hardship|disab(led|ility)|covid|widow(ed|er)?|funeral|death\s+in\s+the\s+family|fire|flood)\b/;
  if (hasPositiveMatch(lower, hardshipRe)) return "hardship";
  var activeRe = /\b(payment\s+plan|arrangement|agreed\s+to|weekly\s+pay|biweekly|installment|schedule\s+to\s+pay|on\s+a\s+plan)\b/;
  if (hasPositiveMatch(lower, activeRe)) return "active";
  var coopRe = /\b(working\s+with\s+us|catching\s+up|in\s+touch|reaching\s+out|communicat(es|ing|ion|ions|or|ors)?|partial|trying\s+to\s+pay|paying\s+down|good\s+communicat(ion|ions|or)?)\b/;
  if (hasPositiveMatch(lower, coopRe)) return "cooperative";
  return null;
}

// ── Phrase block helpers ──────────────────────────────────────────────────────

// "Thanks for the $500 payment on Apr 22." — only when payment is recent (within 14 days).
function paymentAckSnippet(tenant, today) {
  if (!tenant || !tenant.last_payment_date || !tenant.last_payment_amount) return null;
  var paid = parseDateKey(tenant.last_payment_date);
  if (!paid) return null;
  var days = daysBetween(today, paid);
  if (days === null || days < 0 || days > 14) return null;
  var amt = Number(tenant.last_payment_amount || 0);
  if (!isFinite(amt) || amt <= 0) return null;
  // Round to whole dollars only when the value is exactly integer; otherwise show cents
  // so SMS confirmations match the tenant's payment record.
  var amtStr = Number.isInteger(amt) ? "$" + amt.toFixed(0) : "$" + amt.toFixed(2);
  return {
    text: "Thanks for the " + amtStr + " payment on " + formatShortDate(paid) + ".",
    when: paid
  };
}

// "Following up on your last message." or with date variant if older.
function replyAckSnippet(thread, today) {
  var reply = lastMeaningfulInbound(thread);
  if (!reply) return null;
  var days = daysBetween(today, reply.timestamp);
  if (days === null || days < 0 || days > 30) return null;
  var snippet;
  if (days <= 1) {
    snippet = "Following up on your last message.";
  } else if (days <= 7) {
    snippet = "Following up on what you mentioned " + formatShortDate(reply.timestamp) + ".";
  } else {
    snippet = "Circling back on our conversation from " + formatShortDate(reply.timestamp) + ".";
  }
  return {
    text: snippet,
    when: reply.timestamp,
    body: reply.body
  };
}

// "You mentioned paying by Apr 22 — checking in." for active or just-broken promises.
function promiseRefSnippet(tenant, today) {
  if (!tenant || !tenant.promise_date) return null;
  var promise = parseDateKey(tenant.promise_date);
  if (!promise) return null;
  var deltaDays = daysBetween(today, promise); // positive if past, negative if future
  // Only reference promises within a reasonable window (60 days back, 14 days forward)
  if (deltaDays === null || deltaDays > 60 || deltaDays < -14) return null;
  var snippet;
  if (deltaDays > 0) {
    snippet = "You mentioned paying by " + formatShortDate(promise) + " — that date has passed.";
  } else if (deltaDays === 0) {
    snippet = "Today is the date you mentioned for payment (" + formatShortDate(promise) + ") — checking in.";
  } else {
    snippet = "You mentioned paying by " + formatShortDate(promise) + " — checking in.";
  }
  return {
    text: snippet,
    when: promise
  };
}

// Pick the most recent of the three signal candidates. Past events always rank ahead of
// future-dated promises — a payment from yesterday is more relevant than a promise for next
// week. Among past events, most recent wins.
function pickOpener(tenant, thread, today) {
  var candidates = [
    paymentAckSnippet(tenant, today),
    replyAckSnippet(thread, today),
    promiseRefSnippet(tenant, today)
  ].filter(function(c) { return c != null; });
  if (candidates.length === 0) return null;
  var todayMs = today.getTime();
  candidates.sort(function(a, b) {
    var aFuture = a.when.getTime() > todayMs;
    var bFuture = b.when.getTime() > todayMs;
    if (aFuture && !bFuture) return 1;
    if (!aFuture && bFuture) return -1;
    return b.when.getTime() - a.when.getTime();
  });
  return candidates[0];
}

// Late-stage final notices preserve formal/legal phrasing. Adding an opener like "Thanks for
// the $200 payment" on top of "this is a final notice before further action" creates a
// contradictory record that hurts both goodwill and any eviction proceeding.
function isFinalNoticeStage(stage, touchNumber) {
  return touchNumber >= 2 && (stage === "11-15_dpd" || stage === "16+_dpd");
}

// ── Tone-aware core reminders ────────────────────────────────────────────────

// Stage + track + touch + toneTag → core reminder sentence (no opener, no ask).
function coreReminder(stage, track, touchNumber, tenant, toneTag) {
  var name = (tenant && tenant.first_name) ? tenant.first_name : "there";
  var balance = Number((tenant && tenant.balance) || 0);
  var balStr = balance.toFixed(2);
  var dpd = (tenant && tenant.days_past_due) || 0;
  var partial = track === "partial";

  // Touch 3 in late-stage buckets stays formal — legal language preserved verbatim from legacy
  // for due-process / eviction defensibility. Tone tags can SOFTEN but only by adding context,
  // never by weakening the legal language itself.
  // NOTE: compose() owns the salutation ("Hi <name>,"). Core text must NOT prepend the name again.
  if (touchNumber >= 2 && (stage === "11-15_dpd" || stage === "16+_dpd")) {
    if (partial) {
      return "Your remaining balance of $" + balStr + " is " + dpd + " days past due. We need to formalize a repayment arrangement.";
    }
    return "Your account balance of $" + balStr + " is " + dpd + " days past due. Multiple attempts to reach you have been made — this is a final notice before further action.";
  }

  // Tone-modulated mid + early stage cores
  if (toneTag === "hardship") {
    if (partial) {
      return "We know things have been tough — your remaining balance of $" + balStr + " is now " + dpd + " days past due, and we'd like to find a workable plan.";
    }
    return "We know things have been tough — your balance of $" + balStr + " is now " + dpd + " days past due. Let's work on a plan that fits your situation.";
  }
  if (toneTag === "active" || toneTag === "cooperative") {
    if (partial) {
      return "Following up on the arrangement — remaining balance is $" + balStr + " (" + dpd + " days past due).";
    }
    return "Following up on what we discussed — balance of $" + balStr + " is now " + dpd + " days past due.";
  }

  // Default tone (no signal)
  var dpdLabel = (dpd === 1) ? "1 day past due" : dpd + " days past due";
  if (stage === "1-5_dpd") {
    if (partial) return "Remaining balance of $" + balStr + " is still outstanding (" + dpdLabel + ").";
    return "Your rent balance of $" + balStr + " is " + dpdLabel + ".";
  }
  if (stage === "6-10_dpd") {
    if (partial) return "Remaining balance of $" + balStr + " is now " + dpd + " days past due.";
    return "Your rent balance of $" + balStr + " is now " + dpd + " days past due.";
  }
  if (stage === "11-15_dpd") {
    if (partial) return "Remaining balance of $" + balStr + " is now " + dpd + " days past due. A formal arrangement is needed.";
    return "Account balance of $" + balStr + " is now " + dpd + " days past due. A formal notice may be issued if we don't hear from you.";
  }
  if (stage === "16+_dpd") {
    if (partial) return "Despite partial payments, balance of $" + balStr + " remains past due (" + dpd + " days).";
    return "Account balance of $" + balStr + " remains past due (" + dpd + " days).";
  }
  return "Balance of $" + balStr + " is past due.";
}

// ── Closing ask ──────────────────────────────────────────────────────────────

function closingAsk(touchNumber, stage, toneTag) {
  // Late-stage final notices keep firm closing
  if (touchNumber >= 2 && (stage === "11-15_dpd" || stage === "16+_dpd")) {
    return "Please contact us today to avoid further action.";
  }
  if (toneTag === "hardship") {
    return "Reach out when you can — we'd rather work this out together.";
  }
  if (toneTag === "active" || toneTag === "cooperative") {
    return "Let us know where things stand.";
  }
  if (touchNumber === 0) return "Please let us know when we can expect payment or if you'd like to discuss options.";
  if (touchNumber === 1) return "Please get back to us so we can sort this out.";
  return "Please contact us today.";
}

// ── Composition ──────────────────────────────────────────────────────────────

function compose(name, parts) {
  var greet = name && name !== "there" ? "Hi " + name + "," : "Hi,";
  var sentences = [greet];
  for (var i = 0; i < parts.length; i++) {
    if (parts[i]) sentences.push(parts[i]);
  }
  // Join with spaces. Use single spacing — SMS clients render naturally.
  return sentences.join(" ").replace(/\s{2,}/g, " ").trim();
}

// ── Public template builders ─────────────────────────────────────────────────

export function buildSmartFollowUp(opts) {
  opts = opts || {};
  var tenant = opts.tenant || {};
  var stage = opts.stage || tenant.stage;
  var track = opts.track || "standard";
  var touch = (opts.touchNumber != null ? opts.touchNumber : 1) - 1; // normalize to 0-indexed internally
  if (touch < 0) touch = 0;
  var thread = opts.smsThread || [];
  var now = opts.now instanceof Date ? opts.now : new Date();
  var name = tenant.first_name || "there";
  var toneTag = noteToneTag(tenant.notes);

  // Suppress opener on late-stage final notices — payment/promise/reply acknowledgements
  // contradict the "multiple attempts to reach you have been made" framing on those messages.
  var openerText = "";
  if (!isFinalNoticeStage(stage, touch)) {
    var opener = pickOpener(tenant, thread, now);
    if (opener) openerText = opener.text;
  }
  var coreText = coreReminder(stage, track, touch, tenant, toneTag);
  var askText = closingAsk(touch, stage, toneTag);

  return compose(name, [openerText, coreText, askText]);
}

export function buildSmartMonthStart(opts) {
  opts = opts || {};
  var tenant = opts.tenant || {};
  var step = opts.step || 1;
  var thread = opts.smsThread || [];
  var now = opts.now instanceof Date ? opts.now : new Date();
  var name = tenant.first_name || "there";
  var balance = Number(tenant.balance || 0);
  var balStr = balance.toFixed(2);
  var toneTag = noteToneTag(tenant.notes);
  var opener = pickOpener(tenant, thread, now);
  var openerText = opener ? opener.text : "";

  var core, ask;
  if (step === 1) {
    core = "There is still an outstanding balance of $" + balStr + " on your account.";
    ask = toneTag === "hardship"
      ? "Reach out when you can — we want to help find a way forward."
      : "Please let us know when we can expect payment.";
  } else if (step === 2) {
    core = "We have not yet received a response on the outstanding balance of $" + balStr + ".";
    ask = "Please get back to us as soon as possible with an update.";
  } else {
    // step 3 — stays serious
    core = "We have not heard back regarding the outstanding balance of $" + balStr + ".";
    ask = "If we do not hear from you by end of day, we may proceed with further action. Please contact us immediately.";
  }
  return compose(name, [openerText, core, ask]);
}

export function buildSmartManualSmsFollowUp(opts) {
  opts = opts || {};
  var tenant = opts.tenant || {};
  var track = opts.track || "standard";
  var followUp = opts.followUp || {};
  var thread = opts.smsThread || [];
  var now = opts.now instanceof Date ? opts.now : new Date();
  var name = tenant.first_name || "there";
  var balance = Number(tenant.balance || 0);
  var balStr = balance.toFixed(2);
  var stage = tenant.stage || "";
  var label = followUp.label ? String(followUp.label).toLowerCase() : "";
  var urgent = stage.indexOf("16") >= 0 || stage.indexOf("31") >= 0 || label.indexOf("final") >= 0;
  var toneTag = noteToneTag(tenant.notes);
  var opener = pickOpener(tenant, thread, now);
  var openerText;
  if (opener) {
    openerText = opener.text;
  } else if (urgent) {
    // The urgent core carries the balance — opener stays neutral so we don't repeat "past-due"
    openerText = "I've been trying to reach you.";
  } else {
    openerText = "I tried reaching you about your past-due balance.";
  }

  var core;
  if (track === "partial") {
    core = "Remaining balance of $" + balStr + " is still outstanding.";
  } else if (urgent) {
    core = "Past-due balance of $" + balStr + " needs to be resolved.";
  } else {
    core = "Balance of $" + balStr + " is past due.";
  }
  var ask;
  if (urgent) {
    ask = "Please contact us today to discuss resolution and avoid further escalation.";
  } else if (toneTag === "hardship") {
    ask = "Let us know when you can — we'd like to find a workable plan.";
  } else {
    ask = "Please reply here or call us so we can discuss arrangements.";
  }
  return compose(name, [openerText, core, ask]);
}

export function buildSmartPromiseFollowUp(opts) {
  opts = opts || {};
  var tenant = opts.tenant || {};
  var thread = opts.smsThread || [];
  var now = opts.now instanceof Date ? opts.now : new Date();
  var name = tenant.first_name || "there";
  var balance = Number(tenant.balance || 0);
  var balStr = balance.toFixed(2);
  var promiseDateStr = tenant.promise_date || "";
  var promiseDate = parseDateKey(promiseDateStr);
  var promiseLabel = promiseDate ? formatShortDate(promiseDate) : promiseDateStr;
  var toneTag = noteToneTag(tenant.notes);

  // Promise follow-up has its own opener — promise was the trigger, so reference it directly.
  var opener = "You mentioned paying by " + promiseLabel + " — we haven't seen that come through.";
  // If the tenant has replied since the promise date, layer that acknowledgement first.
  var reply = lastMeaningfulInbound(thread);
  if (reply && promiseDate && reply.timestamp.getTime() > promiseDate.getTime()) {
    opener = "Following up on your last message — we still haven't received the payment you mentioned by " + promiseLabel + ".";
  }
  var core = "Outstanding balance is $" + balStr + ".";
  var ask;
  if (toneTag === "hardship") {
    ask = "Let us know how we can help — we'd rather work this out together.";
  } else {
    ask = "Please let us know when we can expect payment or if you need to discuss arrangements.";
  }
  return compose(name, [opener, core, ask]);
}

// ── Test exports (for unit testing internals) ────────────────────────────────

export var __test__ = {
  parseDateKey: parseDateKey,
  daysBetween: daysBetween,
  formatShortDate: formatShortDate,
  lastMeaningfulInbound: lastMeaningfulInbound,
  noteToneTag: noteToneTag,
  paymentAckSnippet: paymentAckSnippet,
  replyAckSnippet: replyAckSnippet,
  promiseRefSnippet: promiseRefSnippet,
  pickOpener: pickOpener,
  coreReminder: coreReminder,
  closingAsk: closingAsk,
  isFinalNoticeStage: isFinalNoticeStage,
  isNegated: isNegated
};
