// Proposal / contract pricing. All money is integer pence; fractional quantities (hours,
// visits) are scaled to integers and every product is exact BigInt maths, rounded half-up
// to the penny once, at the end — so no floating-point drift ever reaches a total.
//
// A line is one priced service:
//   billing   'hourly' (hours × staff × rate) | 'fixed' (price_pence)
//   frequency 'one_off'                 → price is the whole job
//             'weekly'                  → fixed price is PER VISIT; × visits_per_week × 52 / 12 a month
//             'monthly'                 → fixed price is PER MONTH (hourly lines still use visits/week)
//   discount  { type: 'none'|'percent'|'amount', value } — percent in basis points (1250 = 12.5%),
//             amount in pence off the one-off total or off each month
//   optional  true = optional extra: priced and shown, but kept out of the totals

export const BILLING = ['hourly', 'fixed'];
export const FREQUENCY = ['one_off', 'weekly', 'monthly'];
const WEEKS_PER_YEAR = 52n, MONTHS = 12n;

export class PricingError extends Error { name = 'PricingError'; status = 400; expose = true; }

const num = (v, { min = 0, max, dp = 0, name }) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || (max != null && n > max)) throw new PricingError(`${name} must be between ${min} and ${max}`);
  const scaled = Math.round(n * 10 ** dp);
  if (Math.abs(scaled - n * 10 ** dp) > 1e-6) throw new PricingError(`${name} allows at most ${dp} decimal places`);
  return scaled; // integer, scaled by 10^dp
};
const str = (v, n = 200) => String(v ?? '').trim().slice(0, n);

/** Validates and normalises one line from the browser. Returns integers only. */
export function normaliseLine(raw = {}, i = 0) {
  const name = str(raw.name, 120);
  if (!name) throw new PricingError(`Line ${i + 1}: give the service a name`);
  const billing = BILLING.includes(raw.billing) ? raw.billing : null;
  const frequency = FREQUENCY.includes(raw.frequency) ? raw.frequency : null;
  if (!billing || !frequency) throw new PricingError(`${name}: choose how it is billed and how often`);
  const L = {
    id: str(raw.id, 40) || `l${i + 1}`,
    name, billing, frequency,
    visits_t: num(raw.visits_per_week, { max: 70, dp: 1, name: `${name}: visits per week` }),   // tenths
    hours_c: num(raw.hours_per_visit, { max: 1000, dp: 2, name: `${name}: hours per visit` }),   // hundredths
    staff: num(raw.staff, { min: 1, max: 100, name: `${name}: staff` }),
    rate_pence: num(raw.rate_pence, { max: 10_000_00, name: `${name}: hourly rate` }),
    price_pence: num(raw.price_pence, { max: 10_000_000_00, name: `${name}: price` }),
    discount_type: ['percent', 'amount'].includes(raw.discount_type) ? raw.discount_type : 'none',
    discount_value: 0,
    optional: raw.optional === true,
    scope: str(raw.scope, 8000),
    schedule: str(raw.schedule, 300),   // e.g. "Mon–Sun after 4:00 pm"
    notes: str(raw.notes, 1000),
  };
  if (L.discount_type === 'percent') L.discount_value = num(raw.discount_value, { max: 10000, name: `${name}: discount %` }) ?? 0;
  if (L.discount_type === 'amount') L.discount_value = num(raw.discount_value, { max: 10_000_000_00, name: `${name}: discount` }) ?? 0;
  const recurring = frequency !== 'one_off';
  if (billing === 'hourly') {
    if (L.hours_c == null || L.rate_pence == null) throw new PricingError(`${name}: hourly lines need hours per visit and an hourly rate`);
    L.staff ??= 1;
  } else if (L.price_pence == null) throw new PricingError(`${name}: enter a price`);
  if (recurring && (billing === 'hourly' || frequency === 'weekly') && !L.visits_t) throw new PricingError(`${name}: enter visits per week`);
  return L;
}

// exact fraction helpers (BigInt numerator/denominator), rounded half-up to whole pence
const round = (n, d) => { const neg = n < 0n; if (neg) n = -n; const r = (2n * n + d) / (2n * d); return Number(neg ? -r : r); };

/** Prices one normalised line: { one_off, weekly, monthly, annual, discount_* } in pence. */
export function priceLine(L) {
  const recurring = L.frequency !== 'one_off';
  // per-visit amount as an exact fraction pv_n / pv_d pence
  let pv_n, pv_d;
  if (L.billing === 'hourly') { pv_n = BigInt(L.hours_c) * BigInt(L.staff ?? 1) * BigInt(L.rate_pence); pv_d = 100n; }
  else { pv_n = BigInt(L.price_pence); pv_d = 1n; }

  const pct = L.discount_type === 'percent' ? BigInt(L.discount_value) : 0n;
  const off = (n) => n * (10000n - pct);   // keep percent discount exact: denominator gains × 10000
  const out = { per_visit: null, weekly: null, monthly: 0, annual: 0, one_off: 0, gross_before_discount: 0, discount: 0 };

  if (!recurring) {
    const before = round(pv_n, pv_d);
    let net = round(off(pv_n), pv_d * 10000n);
    if (L.discount_type === 'amount') net = Math.max(0, net - L.discount_value);
    Object.assign(out, { one_off: net, gross_before_discount: before, discount: before - net });
    return out;
  }
  if (L.billing === 'fixed' && L.frequency === 'monthly') {
    const before = round(pv_n, pv_d);
    let m = round(off(pv_n), pv_d * 10000n);
    if (L.discount_type === 'amount') m = Math.max(0, m - L.discount_value);
    return Object.assign(out, { monthly: m, annual: m * 12, gross_before_discount: before, discount: before - m });
  }
  // per-visit priced, × visits per week (tenths)
  const wk_n = pv_n * BigInt(L.visits_t), wk_d = pv_d * 10n;
  const before = round(wk_n * WEEKS_PER_YEAR, wk_d * MONTHS);
  let monthly = round(off(wk_n) * WEEKS_PER_YEAR, wk_d * 10000n * MONTHS);
  let annual = round(off(wk_n) * WEEKS_PER_YEAR, wk_d * 10000n);
  if (L.discount_type === 'amount') { monthly = Math.max(0, monthly - L.discount_value); annual = Math.max(0, annual - L.discount_value * 12); }
  return Object.assign(out, {
    per_visit: round(pv_n, pv_d), weekly: round(off(wk_n), wk_d * 10000n), monthly, annual,
    gross_before_discount: before, discount: before - monthly,
  });
}

export const vatOf = (pence, bp) => round(BigInt(pence) * BigInt(bp), 10000n);

/** Whole-document pricing. Returns normalised lines (each with .price) and totals in pence. */
export function priceDocument({ lines = [], vat_rate_bp = 2000 } = {}) {
  if (!Array.isArray(lines)) throw new PricingError('lines must be a list');
  if (lines.length > 60) throw new PricingError('at most 60 lines');
  const bp = num(vat_rate_bp, { max: 10000, name: 'VAT rate' }) ?? 0;
  const out = lines.map((raw, i) => { const L = normaliseLine(raw, i); return { ...L, price: priceLine(L) }; });
  const inc = out.filter((l) => !l.optional);
  const sum = (k, list = inc) => list.reduce((a, l) => a + l.price[k], 0);
  const t = { one_off_net: sum('one_off'), monthly_net: sum('monthly'), annual_net: sum('annual'), discount_monthly: 0, discount_one_off: 0 };
  for (const l of inc) { if (l.frequency === 'one_off') t.discount_one_off += l.price.discount; else t.discount_monthly += l.price.discount; }
  for (const k of ['one_off', 'monthly', 'annual']) {
    t[`${k}_vat`] = vatOf(t[`${k}_net`], bp);
    t[`${k}_gross`] = t[`${k}_net`] + t[`${k}_vat`];
  }
  t.first_year_net = t.annual_net + t.one_off_net;
  t.first_year_gross = t.annual_gross + t.one_off_gross;
  t.optional_one_off_net = sum('one_off', out.filter((l) => l.optional));
  t.optional_monthly_net = sum('monthly', out.filter((l) => l.optional));
  t.vat_rate_bp = bp;
  return { lines: out, totals: t, assumptions: assumptions(out) };
}

export const gbp = (pence) => `£${(Number(pence) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtN = (scaled, dp) => (scaled / 10 ** dp).toLocaleString('en-GB', { maximumFractionDigits: dp });

/** Plain-English pricing assumptions printed under the breakdown. */
export function assumptions(lines) {
  const a = [];
  for (const l of lines) {
    const p = l.price, bits = [];
    if (l.frequency !== 'one_off' && l.visits_t) bits.push(`${fmtN(l.visits_t, 1)} visit${l.visits_t === 10 ? '' : 's'} per week`);
    if (l.hours_c) bits.push(`${fmtN(l.hours_c, 2)} hour${l.hours_c === 100 ? '' : 's'} per visit${l.staff > 1 ? ` × ${l.staff} staff` : ''}`);
    if (l.billing === 'hourly') bits.push(`${gbp(l.rate_pence)} per labour-hour`);
    if (l.frequency === 'weekly' && l.billing === 'fixed') bits.push(`${gbp(l.price_pence)} per visit`);
    if (l.frequency !== 'one_off' && !(l.billing === 'fixed' && l.frequency === 'monthly')) bits.push('monthly = weekly × 52 ÷ 12');
    // effective labour rate for a fixed recurring price with a stated labour allowance
    if (l.billing === 'fixed' && l.frequency !== 'one_off' && l.hours_c && l.visits_t) {
      const hrsMonth_n = BigInt(l.hours_c) * BigInt(l.staff ?? 1) * BigInt(l.visits_t) * WEEKS_PER_YEAR; // ×100 ×10 ×12
      const rate = round(BigInt(p.monthly) * 100n * 10n * MONTHS, hrsMonth_n);
      bits.push(`effective charge-out rate approximately ${gbp(rate)} per labour-hour`);
    }
    if (l.discount_type === 'percent' && l.discount_value) bits.push(`${fmtN(l.discount_value, 2)}% discount applied`);
    if (l.discount_type === 'amount' && l.discount_value) bits.push(`${gbp(l.discount_value)} discount applied${l.frequency === 'one_off' ? '' : ' per month'}`);
    if (l.optional) bits.push('optional extra — not included in the totals');
    if (bits.length) a.push(`${l.name}: ${bits.join('; ')}.`);
  }
  return a;
}

/** Converts a normalised line back to the browser's units (for editing). */
export function lineForEditing(L) {
  return {
    id: L.id, name: L.name, billing: L.billing, frequency: L.frequency,
    visits_per_week: L.visits_t == null ? '' : L.visits_t / 10,
    hours_per_visit: L.hours_c == null ? '' : L.hours_c / 100,
    staff: L.staff ?? '', rate_pence: L.rate_pence ?? '', price_pence: L.price_pence ?? '',
    discount_type: L.discount_type, discount_value: L.discount_value, optional: L.optional,
    scope: L.scope, schedule: L.schedule, notes: L.notes,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (await import('node:assert')).strict;
  // FCC-HDO-001: £695 deep clean + £3,750/month daily (7 × 5h)
  const r = priceDocument({ lines: [
    { name: 'Deep clean', billing: 'fixed', frequency: 'one_off', price_pence: 69500 },
    { name: 'Daily', billing: 'fixed', frequency: 'monthly', price_pence: 375000, visits_per_week: 7, hours_per_visit: 5 },
  ] });
  assert.equal(r.totals.one_off_net, 69500);
  assert.equal(r.totals.one_off_vat, 13900);
  assert.equal(r.totals.monthly_net, 375000);
  assert.equal(r.totals.annual_net, 4500000);
  assert.equal(r.totals.monthly_gross, 450000);
  assert.ok(r.assumptions.some((a) => a.includes('£24.73 per labour-hour')), r.assumptions.join(' | '));
  // hourly weekly: 3 visits × 2.5h × 2 staff × £18.50 = £277.50/wk → ×52/12 = £1,202.50/month, £14,430/yr
  const h = priceDocument({ lines: [{ name: 'Office', billing: 'hourly', frequency: 'weekly', visits_per_week: 3, hours_per_visit: 2.5, staff: 2, rate_pence: 1850 }] });
  assert.equal(h.lines[0].price.weekly, 27750);
  assert.equal(h.totals.monthly_net, 120250);
  assert.equal(h.totals.annual_net, 1443000);
  // classic float trap: 0.1 + 0.2 style rates; 1.15h × £19.99 × 1 visit/week
  const f = priceDocument({ lines: [{ name: 'F', billing: 'hourly', frequency: 'weekly', visits_per_week: 1, hours_per_visit: 1.15, rate_pence: 1999 }] });
  assert.equal(f.lines[0].price.per_visit, 2299);           // 22.9885 → 22.99
  assert.equal(f.totals.monthly_net, 9962);                 // 22.9885 × 52 / 12 = 99.6168… → 99.62
  // percent discount 12.5% on £1,000/month, amount discount £50 off a one-off £300; optional extra excluded
  const d = priceDocument({ lines: [
    { name: 'M', billing: 'fixed', frequency: 'monthly', price_pence: 100000, discount_type: 'percent', discount_value: 1250 },
    { name: 'O', billing: 'fixed', frequency: 'one_off', price_pence: 30000, discount_type: 'amount', discount_value: 5000 },
    { name: 'X', billing: 'fixed', frequency: 'one_off', price_pence: 99900, optional: true },
  ], vat_rate_bp: 2000 });
  assert.deepEqual([d.totals.monthly_net, d.totals.one_off_net, d.totals.optional_one_off_net, d.totals.discount_monthly], [87500, 25000, 99900, 12500]);
  // weekly fixed per-visit £45 × 2 visits = £90/wk → £390/month
  assert.equal(priceDocument({ lines: [{ name: 'W', billing: 'fixed', frequency: 'weekly', visits_per_week: 2, price_pence: 4500 }] }).totals.monthly_net, 39000);
  // VAT 0 (not registered) and bad input
  assert.equal(priceDocument({ lines: [{ name: 'Z', billing: 'fixed', frequency: 'one_off', price_pence: 100 }], vat_rate_bp: 0 }).totals.one_off_gross, 100);
  assert.throws(() => priceDocument({ lines: [{ name: 'B', billing: 'hourly', frequency: 'weekly', visits_per_week: 1, hours_per_visit: 1.234, rate_pence: 1 }] }), /decimal/);
  assert.throws(() => priceDocument({ lines: [{ name: 'N', billing: 'fixed', frequency: 'one_off', price_pence: -5 }] }), PricingError);
  assert.throws(() => priceDocument({ lines: [{ name: '', billing: 'fixed', frequency: 'one_off', price_pence: 5 }] }), /name/);
  // round-trip for the editor
  const back = lineForEditing(h.lines[0]);
  assert.deepEqual([back.hours_per_visit, back.visits_per_week, back.staff], [2.5, 3, 2]);
  assert.equal(gbp(123456789), '£1,234,567.89');
  console.log('pricing ok');
}
