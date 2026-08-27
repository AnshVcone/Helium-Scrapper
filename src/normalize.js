// Every rule here comes from a failure measured during the 18-19 Aug
// investigation. Changing one silently corrupts a column downstream.

const NO_DATA = new Set(['n/a', 'na', '-', '--', '', 'undefined', 'null']);

// `-1` is Helium 10's "no data" sentinel, not a value. It shows up in sales,
// revenue, fee and dimension fields. Loaded raw it poisons every SUM and AVG,
// and negative unit sales do not look obviously broken on a dashboard.
const isSentinel = (n) => n === -1;

// Shape validators. The panel renders tile *labels* several seconds before the
// figures arrive, so the line after "30-Day Revenue" is the next tile's label
// ("Current Rating") until the value lands. Without a shape check that label is
// happily accepted as a revenue reading -- and two early samples of it look
// perfectly stable. Anything not matching these is "not populated yet", never a
// value.
export const looksLikeMoney = (v) =>
  typeof v === 'string' && /^(\$\s*[\d,]+(\.\d+)?|N\/A|NA|-|--)$/i.test(v.trim());

export const looksLikeUnits = (v) =>
  typeof v === 'string' && /^([\d,]+|N\/A|NA|-|--)$/i.test(v.trim());

export function parseMoneyToCents(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (NO_DATA.has(s.toLowerCase())) return null;

  const m = s.match(/-?[\d.,]+/);
  if (!m) return null;

  // Strip thousands separators, keep the decimal point.
  const cleaned = m[0].replace(/,/g, '');
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  if (isSentinel(value)) return null;

  // Stored in cents as an integer: the two H10 surfaces use the same field
  // name for cents and for dollars, 100x apart. One unit, decided here.
  return Math.round(value * 100);
}

export function parseIntOrNull(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (NO_DATA.has(s.toLowerCase())) return null;

  const m = s.match(/-?[\d,]+/);
  if (!m) return null;
  const value = Number(m[0].replace(/,/g, ''));
  if (!Number.isInteger(value)) return null;
  if (isSentinel(value)) return null;
  return value;
}

export function parseFloatOrNull(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (NO_DATA.has(s.toLowerCase())) return null;
  const m = s.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const value = Number(m[0]);
  if (!Number.isFinite(value) || isSentinel(value)) return null;
  return value;
}

// "Health & Hous... #30,276 / Vitamin B12 Supplements #145" -> ranks.
// The panel shows a top-level rank and a subcategory rank; keep both, and keep
// the category names so a wrong-category read is visible on inspection.
export function parseRanks(rawLines) {
  const out = [];
  for (const line of rawLines || []) {
    const m = String(line).match(/^(.*?)\s*#([\d,]+)\s*$/);
    if (!m) continue;
    const rank = parseIntOrNull(m[2]);
    if (rank == null) continue;
    out.push({ category: m[1].trim().replace(/\.\.\.$/, ''), rank });
  }
  return out;
}
