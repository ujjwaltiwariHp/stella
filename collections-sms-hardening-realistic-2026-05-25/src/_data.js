export function normalizeSmsText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{2,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function isMeaningfulTenantReply(body) {
  var text = normalizeSmsText(body).toLowerCase();
  if (!text) return false;

  var trivial = {
    "k": true,
    "ok": true,
    "okay": true,
    "kk": true,
    "thanks": true,
    "thank you": true,
    "thx": true,
    "got it": true,
    "received": true,
    "👍": true,
    "👌": true
  };
  if (trivial[text]) return false;

  if (text.length >= 20) return true;
  if (/\b(pay|paid|payment|paying|send|sent|sending|zelle|venmo|cashapp|check|money order|tomorrow|today|tonight|friday|monday|tuesday|wednesday|thursday|saturday|sunday|date|call|called|late|issue|problem|arrangement|plan|promise|resolve|stop|wrong|dispute)\b/.test(text)) {
    return true;
  }

  var wordCount = text.split(/\s+/).filter(Boolean).length;
  return wordCount >= 3;
}
