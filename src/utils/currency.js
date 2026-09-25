// src/utils/currency.js
//
// Shared currency parsing for cost fields. Returns null (not 0) for anything
// that isn't a real amount -- null, undefined, '', 'N/A' -- so callers can tell
// "cost is $0" apart from "no cost entered". Plain Number(null) is 0, which is
// how a missing cost used to slip into totals as a real $0.
//
// Accepts numbers and strings like "$1,200,000", "1.2M", "450K", "(1,000)".

const SUFFIX_MULTIPLIERS = { k: 1e3, m: 1e6, b: 1e9 };

export function parseCurrency(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let text = String(value).trim();
  if (!text) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(text)) {
    sign = -1;
    text = text.slice(1, -1);
  }
  text = text.replace(/[$,\s]/g, '').toLowerCase();
  const match = text.match(/^(-?\d*\.?\d+)([kmb])?$/);
  if (!match) return null;
  const n = Number(match[1]) * (match[2] ? SUFFIX_MULTIPLIERS[match[2]] : 1);
  return Number.isFinite(n) ? sign * n : null;
}

// First real amount among the candidates, or null if none are real.
export function firstCurrencyValue(candidates) {
  for (const candidate of candidates) {
    const n = parseCurrency(candidate);
    if (n != null) return n;
  }
  return null;
}
