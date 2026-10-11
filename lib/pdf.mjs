// Proposal + service-agreement PDFs (pdfkit — no LaTeX or browser on the server).
// Layout reproduces FC's LaTeX templates: A4, Helvetica, navy (#003C71) section titles
// numbered 01, 02…, bordered tables with light-blue header/zebra rows, a cover page with
// the logo, running header (company / document type | reference / client), footer
// (confidential | Page X of Y). The in-app preview IS this PDF, so they always match.
//
// Input is a snapshot (see lib/documents-model.mjs) — plain data, already priced.
// renderContract also returns where it drew the signature/date/name boxes (normalised
// 0..1 page coordinates, 0-based page) so DocuSeal fields land exactly on them.
import PDFDocument from 'pdfkit';
import { readFileSync } from 'node:fs';
import { gbp } from './pricing.mjs';

const BLUE = '#003C71', GREY = '#5A5A5A', LIGHT = '#E8F0F8', HEAD = '#D6E3F0', RULE = '#9DB3CC', INK = '#1A1A1A';
const LOGO = readFileSync(new URL('../assets/fc-logo-black.png', import.meta.url));
const CM = 28.3465;
const M = { left: 2.2 * CM, right: 2.2 * CM, top: 2.8 * CM, bottom: 2.6 * CM };

// pdfkit's built-in Helvetica only has WinAnsi glyphs: map the usual suspects, drop the rest
const MAP = { '≈': '~', '→': '->', '←': '<-', '✓': 'Yes', '✔': 'Yes', '✗': 'No', '≥': '>=', '≤': '<=', ' ': ' ', ' ': ' ', ' ': ' ' };
export const clean = (s) => String(s ?? '').replace(/[^\x09\x0a\x0d\x20-\x7e -ÿ–—‘’“”•…€™ŒœŠšŸŽžƒˆ˜†‡‰‹›]/g, (c) => MAP[c] ?? '');

export const fmtDate = (d) => {
  if (!d) return 'To be confirmed';
  const x = new Date(`${String(d).slice(0, 10)}T12:00:00Z`);
  return isNaN(x) ? String(d) : x.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
};

/** Fills {{merge}} fields. Unknown fields are left visible so they get noticed. */
export function merge(text, vars) {
  return String(text ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (vars[k] != null && vars[k] !== '' ? String(vars[k]) : m));
}
/** Every [[...]] placeholder and unfilled {{merge}} left in a set of texts. */
export function unresolved(texts) {
  const out = new Set();
  for (const t of texts) for (const m of String(t ?? '').matchAll(/\[\[([^\]]*)\]\]|\{\{\s*\w+\s*\}\}/g)) out.add(m[0]);
  return [...out];
}

const freqLabel = (l) => (l.frequency === 'one_off' ? 'One-off' : l.frequency === 'weekly' ? 'Weekly' : 'Monthly');
const n1 = (scaled, dp) => (scaled / 10 ** dp).toLocaleString('en-GB', { maximumFractionDigits: dp });
export function basis(l) {
  const bits = [];
  if (l.frequency !== 'one_off' && l.visits_t) bits.push(`${n1(l.visits_t, 1)} visit${l.visits_t === 10 ? '' : 's'}/week`);
  if (l.hours_c) bits.push(`${n1(l.hours_c, 2)} h/visit${l.staff > 1 ? ` × ${l.staff} staff` : ''}`);
  if (l.billing === 'hourly') bits.push(`${gbp(l.rate_pence)}/labour-hour`);
  else if (l.frequency === 'weekly') bits.push(`${gbp(l.price_pence)} per visit`);
  else bits.push(l.frequency === 'one_off' ? 'Fixed price' : 'Fixed monthly price');
  return bits.join(', ');
}
const vatWord = (s) => (s.vat_rate_bp ? ' + VAT' : '');
const amountText = (s, l) => {
  const p = l.price;
  return l.frequency === 'one_off' ? `${gbp(p.one_off)}${vatWord(s)}` : `${gbp(p.monthly)}${vatWord(s)} / month`;
};

function makeDoc(s, docLabel) {
  const doc = new PDFDocument({ size: 'A4', margins: M, bufferPages: true, autoFirstPage: true,
    info: { Title: clean(`${docLabel} ${s.number} — ${s.customer.business}`), Author: clean(s.company.name), Subject: docLabel } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  return { doc, done };
}

/** Shared drawing helpers bound to one document. */
function kit(doc) {
  const W = doc.page.width - M.left - M.right;
  const bottom = () => doc.page.height - M.bottom;
  const ensure = (h) => { if (doc.y + h > bottom()) doc.addPage(); };
  const body = (size = 10.5) => doc.font('Helvetica').fontSize(size).fillColor(INK);
  let secNo = 0;

  const section = (title) => {
    ensure(70);
    doc.moveDown(doc.y > M.top + 5 ? 1.1 : 0);
    secNo += 1;
    doc.font('Helvetica-Bold').fontSize(13).fillColor(BLUE)
      .text(`${String(secNo).padStart(2, '0')}    ${clean(title)}`, M.left, doc.y, { width: W });
    doc.moveDown(0.45);
    body();
  };
  const subsection = (title) => {
    ensure(50);
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(BLUE).text(clean(title), M.left, doc.y, { width: W });
    doc.moveDown(0.25);
    body();
  };
  const para = (text) => { body(); doc.text(clean(text), M.left, doc.y, { width: W, lineGap: 2 }); doc.moveDown(0.5); };
  const bullet = (text) => {
    body();
    const indent = 14, h = doc.heightOfString(clean(text), { width: W - indent, lineGap: 1.5 });
    ensure(h + 2);
    const y = doc.y;
    doc.text('•', M.left + 2, y);
    doc.text(clean(text), M.left + indent, y, { width: W - indent, lineGap: 1.5 });
    doc.moveDown(0.15);
  };

  /** Light markup: "## " subheading, "### " group heading, "- " bullet, blank line = paragraph. */
  const markup = (text) => {
    const lines = String(text ?? '').replace(/\r/g, '').split('\n');
    let paraBuf = [];
    const flush = () => { if (paraBuf.length) { para(paraBuf.join('\n')); paraBuf = []; } };
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (!line.trim()) { flush(); continue; }
      if (line.startsWith('### ')) {
        flush(); ensure(40); doc.moveDown(0.3);
        doc.font('Helvetica-Bold').fontSize(10.5).fillColor(BLUE).text(clean(line.slice(4)), M.left, doc.y, { width: W });
        doc.moveDown(0.15);
      } else if (line.startsWith('## ')) { flush(); subsection(line.slice(3)); }
      else if (/^\s*[-•*]\s+/.test(line)) { flush(); bullet(line.replace(/^\s*[-•*]\s+/, '')); }
      else paraBuf.push(line.trim());
    }
    flush();
    if (doc.y > M.top) doc.moveDown(0.2);
  };

  /**
   * Bordered table that never runs off the page: each row is measured first and starts a
   * new page (repeating the header) when it won't fit. cells: string or { text, bold, fill, align }.
   */
  const table = (widths, rows, { header = null, zebra = true, size = 9.5, pad = 5 } = {}) => {
    const total = widths.reduce((a, b) => a + b, 0), cols = widths.map((w) => (w / total) * W);
    const cellOf = (c) => (typeof c === 'object' && c !== null ? c : { text: c });
    const measure = (row, bold) => Math.max(...row.map((c, i) => {
      const cell = cellOf(c);
      doc.font(cell.bold || bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
      return doc.heightOfString(clean(cell.text ?? ''), { width: cols[i] - pad * 2, lineGap: 1 });
    })) + pad * 2;
    const draw = (row, { bold = false, fill = null } = {}) => {
      const h = measure(row, bold);
      if (doc.y + h > bottom()) { doc.addPage(); if (header && row !== header) draw(header, { bold: true, fill: HEAD }); }
      const y = doc.y;
      let x = M.left;
      row.forEach((c, i) => {
        const cell = cellOf(c), f = cell.fill || fill;
        if (f) doc.rect(x, y, cols[i], h).fill(f);
        doc.lineWidth(0.6).strokeColor(GREY).rect(x, y, cols[i], h).stroke();
        doc.font(cell.bold || bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(cell.color || INK)
          .text(clean(cell.text ?? ''), x + pad, y + pad, { width: cols[i] - pad * 2, align: cell.align || 'left', lineGap: 1 });
        x += cols[i];
      });
      doc.x = M.left; doc.y = y + h;
    };
    if (header) { ensure(measure(header, true) + measure(rows[0] || header) + 4); draw(header, { bold: true, fill: HEAD }); }
    rows.forEach((r, i) => draw(r, { fill: zebra && i % 2 === 0 ? LIGHT : null }));
    doc.moveDown(0.6);
  };

  const box = (text) => table([1], [[{ text, bold: true, fill: HEAD }]], { zebra: false, size: 10 });
  return { W, bottom, ensure, section, subsection, para, bullet, markup, table, box, body };
}

function cover(doc, s, docLabel) {
  const W = doc.page.width - M.left - M.right;
  doc.y = M.top + 1.0 * CM;
  doc.rect(M.left, doc.y, W, 2.5).fill(BLUE);
  doc.y += 1 * CM;
  const logoH = 3 * CM, top = doc.y;
  doc.image(LOGO, M.left, top, { height: logoH });
  const tx = M.left + logoH * (647 / 683) + 1.2 * CM;
  doc.font('Helvetica-Bold').fontSize(18).fillColor(BLUE).text(clean(s.company.name.toUpperCase()), tx, top + logoH / 2 - 22, { width: W - (tx - M.left) });
  doc.font('Helvetica').fontSize(14).fillColor(INK).text(clean(docLabel), tx, doc.y + 4, { width: W - (tx - M.left) });
  doc.y = top + logoH + 2 * CM;
  doc.font('Helvetica-Bold').fontSize(9).fillColor(GREY).text('PREPARED FOR', M.left, doc.y);
  doc.moveDown(0.5);
  doc.font('Helvetica-Bold').fontSize(16).fillColor(INK).text(clean(s.customer.business), M.left, doc.y, { width: W });
  const addr = s.site?.address || s.customer.address;
  if (addr) { doc.moveDown(0.2); doc.font('Helvetica').fontSize(12).text(clean(addr), { width: W }); }
  doc.moveDown(1.2);
}

function chrome(doc, s, { docLabel, footerLabel, refLabel }) {
  const { start, count } = doc.bufferedPageRange();
  const W = doc.page.width - M.left - M.right;
  for (let i = start; i < start + count; i++) {
    doc.switchToPage(i);
    const keep = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // writing in the margin must not trigger a new page
    if (i > start) {
      const y = M.top - 34;
      doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(clean(s.company.name.toUpperCase()), M.left, y, { width: W / 2, lineBreak: false });
      doc.font('Helvetica').fontSize(7.5).fillColor(GREY).text(clean(docLabel), M.left, y + 12, { width: W / 2, lineBreak: false });
      doc.font('Helvetica').fontSize(9).fillColor(INK).text(clean(`${refLabel} ${s.number}${s.version > 1 ? ` v${s.version}` : ''}`), M.left + W / 2, y, { width: W / 2, align: 'right', lineBreak: false });
      doc.font('Helvetica').fontSize(7.5).fillColor(GREY).text(clean(s.customer.business), M.left + W / 2, y + 12, { width: W / 2, align: 'right', lineBreak: false });
      doc.lineWidth(0.5).strokeColor(INK).moveTo(M.left, y + 24).lineTo(M.left + W, y + 24).stroke();
    }
    const fy = doc.page.height - M.bottom + 22;
    doc.font('Helvetica').fontSize(7.5).fillColor(GREY)
      .text(clean(`${s.company.name} — ${footerLabel}`), M.left, fy, { width: W / 2, lineBreak: false })
      .text(`Page ${i - start + 1} of ${count}`, M.left + W / 2, fy, { width: W / 2, align: 'right', lineBreak: false });
    doc.page.margins.bottom = keep;
  }
}

function partiesTable(k, s, { clientExtra = [] } = {}) {
  const c = s.customer, co = s.company, p = s.person || {};
  const left = [
    c.business,
    ...(c.trading_name && c.trading_name !== c.business ? [`Trading as ${c.trading_name}`] : []),
    s.site?.address || c.address || '',
    p.name ? `Contact: ${p.name}${p.job_title ? `, ${p.job_title}` : ''}` : '',
    p.phone ? `Tel: ${p.phone}` : '',
    p.email ? `Email: ${p.email}` : '',
    ...clientExtra,
  ].filter(Boolean);
  const right = [co.name, co.address, co.phone && `Tel: ${co.phone}`, co.email && `Email: ${co.email}`, co.website && `Web: ${co.website}`,
    [co.vat_number && `VAT No: ${co.vat_number}`, co.company_number && `Co. No: ${co.company_number}`].filter(Boolean).join('  |  ')].filter(Boolean);
  k.table([1, 1], [[{ text: left.join('\n') }, { text: right.join('\n') }]],
    { header: [{ text: 'CLIENT', color: BLUE, bold: true }, { text: 'CONTRACTOR', color: BLUE, bold: true }], zebra: false });
}

function pricingTables(k, s) {
  const t = s.totals, vatPct = `${(s.vat_rate_bp / 100).toLocaleString('en-GB')}%`;
  const inc = s.lines.filter((l) => !l.optional), extra = s.lines.filter((l) => l.optional);
  const row = (l) => [l.name, freqLabel(l), basis(l), { text: l.frequency === 'one_off' ? '—' : gbp(l.price.monthly), align: 'right' }, { text: l.frequency === 'one_off' ? gbp(l.price.one_off) : '—', align: 'right' }];
  if (inc.length) k.table([3.2, 1.3, 3.4, 1.7, 1.7], inc.map(row), { header: ['Service', 'Frequency', 'Basis', { text: 'Monthly (ex VAT)', align: 'right' }, { text: 'One-off (ex VAT)', align: 'right' }] });

  const tot = [];
  if (t.monthly_net || !t.one_off_net) tot.push(['Recurring — per month (ex VAT)', gbp(t.monthly_net)], [`VAT at ${vatPct}`, gbp(t.monthly_vat)], [{ text: 'Recurring — per month (inc VAT)', bold: true }, { text: gbp(t.monthly_gross), bold: true }]);
  if (t.one_off_net) tot.push(['One-off total (ex VAT)', gbp(t.one_off_net)], [`VAT at ${vatPct}`, gbp(t.one_off_vat)], [{ text: 'One-off total (inc VAT)', bold: true }, { text: gbp(t.one_off_gross), bold: true }]);
  if (t.annual_net) tot.push(['Recurring — annual value (ex VAT)', gbp(t.annual_net)]);
  if (t.discount_monthly) tot.push(['Discounts included (per month)', `−${gbp(t.discount_monthly)}`]);
  if (t.discount_one_off) tot.push(['Discounts included (one-off)', `−${gbp(t.discount_one_off)}`]);
  k.table([4, 1.6], tot.map(([a, b]) => [a, typeof b === 'object' ? { ...b, align: 'right' } : { text: b, align: 'right' }]), { header: ['Totals', { text: 'Amount', align: 'right' }] });
  if (!s.vat_rate_bp) k.para('Prices are not subject to VAT.');

  if (extra.length) {
    k.subsection('Optional extras (not included in the totals above)');
    k.table([3.2, 1.3, 3.4, 2], extra.map((l) => [l.name, freqLabel(l), basis(l), { text: amountText(s, l), align: 'right' }]), { header: ['Service', 'Frequency', 'Basis', { text: 'Price', align: 'right' }] });
  }
  if (s.assumptions?.length) {
    k.subsection('Pricing assumptions');
    for (const a of s.assumptions) k.bullet(a);
    k.bullet('Prices are estimates based on the information and site visit available at the date of issue.');
  }
}

function scheduleTable(k, s) {
  const rec = s.lines.filter((l) => !l.optional);
  if (!rec.length) return;
  k.table([3.2, 1.4, 1.3, 1.3, 1, 3], rec.map((l) => [l.name, freqLabel(l),
    l.frequency === 'one_off' ? '—' : (l.visits_t ? n1(l.visits_t, 1) : '—'), l.hours_c ? n1(l.hours_c, 2) : '—', l.staff ? String(l.staff) : '—', l.schedule || 'To be agreed']),
  { header: ['Service', 'Frequency', 'Visits / week', 'Hours / visit', 'Staff', 'Days and times'] });
}

function scopeOfServices(k, s) {
  for (const l of s.lines) {
    k.subsection(`${l.name}${l.optional ? ' (optional extra)' : ''}`);
    if (l.scope) k.markup(l.scope);
    if (l.frequency === 'one_off') {
      k.box(`Price: ${amountText(s, l)}${l.notes ? `   |   ${l.notes}` : ''}`);
    } else {
      const rows = [['Frequency', l.visits_t ? `${n1(l.visits_t, 1)} visit${l.visits_t === 10 ? '' : 's'} per week` : freqLabel(l)]];
      if (l.hours_c) rows.push(['Labour allowance', `${n1(l.hours_c, 2)} hours per visit${l.staff > 1 ? ` × ${l.staff} staff` : ''}`]);
      if (l.schedule) rows.push(['Days and times', l.schedule]);
      rows.push(['Price', amountText(s, l)]);
      if (l.notes) rows.push(['Notes', l.notes]);
      k.table([1.6, 3.4], rows, { header: ['Item', 'Details'] });
    }
  }
}

/** Proposal PDF → Buffer */
export async function renderProposal(s) {
  const label = s.title || 'Commercial Cleaning Proposal';
  const { doc, done } = makeDoc(s, label);
  const k = kit(doc);
  cover(doc, s, label);
  k.table([1, 1, 1, 0.6], [[s.number, fmtDate(s.issue_date), fmtDate(s.valid_until), `v${s.version}`]],
    { header: ['Proposal Reference', 'Date', 'Valid Until', 'Version'], zebra: false, size: 10 });
  doc.y = doc.page.height - M.bottom - 40;
  doc.rect(M.left, doc.y, k.W, 2.5).fill(BLUE);
  doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(clean([s.company.name, s.company.phone && `Tel: ${s.company.phone}`, s.company.website].filter(Boolean).join('   |   ')), M.left, doc.y + 12, { width: k.W });

  doc.addPage();
  partiesTable(k, s);
  for (const sec of s.sections) {
    if (sec.key === 'acceptance') { doc.addPage(); doc.y = M.top; }
    k.section(sec.title);
    if (sec.key === 'executive_summary') {
      k.markup(sec.body);
      const rows = s.lines.filter((l) => !l.optional).map((l) => [l.name, `${amountText(s, l)}${l.frequency !== 'one_off' && l.hours_c ? ` — ${n1(l.hours_c, 2)} labour-hours per visit` : ''}`]);
      for (const [a, b] of s.summary_rows || []) rows.push([a, b]);
      if (rows.length) k.table([2, 3.6], rows, { header: ['Item', 'Details'] });
    } else if (sec.key === 'scope') { if (sec.body) k.markup(sec.body); scopeOfServices(k, s); }
    else if (sec.key === 'schedule') { if (sec.body) k.markup(sec.body); scheduleTable(k, s); if (s.schedule_notes) k.markup(s.schedule_notes); }
    else if (sec.key === 'pricing') { if (sec.body) k.markup(sec.body); pricingTables(k, s); }
    else if (sec.key === 'commercial_terms') {
      k.markup(sec.body);
      if (s.terms?.length) k.table([1.6, 3.4], s.terms.map(([a, b]) => [a, b]), { header: ['Term', 'Details'] });
    } else if (sec.key === 'acceptance') {
      k.markup(sec.body);
      signatureBlock(doc, k, s, { proposal: true });
    } else k.markup(sec.body);
  }
  chrome(doc, s, { docLabel: label, footerLabel: 'Confidential Proposal', refLabel: 'Proposal' });
  doc.end();
  return done;
}

// signature area: client on the left, FC on the right; returns field boxes for DocuSeal
function signatureBlock(doc, k, s, { proposal = false } = {}) {
  k.ensure(260);
  doc.moveDown(1.5);
  const colW = (k.W - 30) / 2, xL = M.left, xR = M.left + colW + 30, fields = [];
  const pageIndex = doc.bufferedPageRange().start + doc.bufferedPageRange().count - 1;
  const norm = (x, y, w, h) => ({ page: pageIndex, x: x / doc.page.width, y: y / doc.page.height, w: w / doc.page.width, h: h / doc.page.height });
  let y = doc.y;
  const head = (x, who) => {
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(GREY).text('FOR AND ON BEHALF OF', x, y, { width: colW });
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(clean(who), x, y + 13, { width: colW });
  };
  head(xL, s.customer.business); head(xR, s.company.name);
  y += 46;
  const lineRow = (x, label, role, type, value) => {
    doc.font('Helvetica').fontSize(10).fillColor(INK).text(label, x, y + (type === 'signature' ? 26 : 6), { width: 70, lineBreak: false });
    const lx = x + 62, lw = colW - 62, h = type === 'signature' ? 40 : 18, ly = y + h + 4;
    if (value) doc.font('Helvetica-Bold').fontSize(10).text(clean(value), lx + 2, y + (type === 'signature' ? 26 : 6), { width: lw, lineBreak: false });
    else doc.lineWidth(0.5).strokeColor(INK).moveTo(lx, ly).lineTo(lx + lw, ly).stroke();
    if (role && !value) fields.push({ role, type, name: `${role} ${label.replace(':', '')}`, ...norm(lx, y + 2, lw, h) });
  };
    // client name/position stay fillable (DocuSeal prefills them from the signer); FC's are printed
  const rowsL = [['Name:', 'text'], ['Position:', 'text'], ['Signature:', 'signature'], ['Date:', 'date']];
  const rowsR = [['Name:', 'text', s.company.signatory_name], ['Position:', 'text', s.company.signatory_title], ['Signature:', 'signature'], ['Date:', 'date']];
  for (let i = 0; i < rowsL.length; i++) {
    const [lab, type, valL] = rowsL[i], [, , valR] = rowsR[i];
    lineRow(xL, lab, proposal ? null : 'Client', type, valL || null);
    lineRow(xR, lab, proposal ? null : 'FC Cleaning', type, valR || null);
    y += type === 'signature' ? 60 : 32;
  }
  doc.x = M.left; doc.y = y + 10;
  return fields;
}

/** Service agreement PDF → { buffer, fields } */
export async function renderContract(s) {
  const label = 'Service Agreement';
  const { doc, done } = makeDoc(s, label);
  const k = kit(doc);
  cover(doc, s, label);
  k.table([1, 1, 1, 0.6], [[s.number, fmtDate(s.issue_date), fmtDate(s.start_date), `v${s.version}`]],
    { header: ['Agreement Reference', 'Date', 'Effective Date', 'Version'], zebra: false, size: 10 });
  partiesTable(k, s, { clientExtra: [s.customer.company_number && `Company No: ${s.customer.company_number}`].filter(Boolean) });
  doc.y = doc.page.height - M.bottom - 40;
  doc.rect(M.left, doc.y, k.W, 2.5).fill(BLUE);
  doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(clean([s.company.name, s.company.phone && `Tel: ${s.company.phone}`, s.company.website].filter(Boolean).join('   |   ')), M.left, doc.y + 12, { width: k.W });

  doc.addPage();
  let fields = [];
  for (const sec of s.sections) {
    if (sec.key === 'acceptance') { doc.addPage(); doc.y = M.top; }
    k.section(sec.title);
    if (sec.key === 'overview') {
      k.markup(sec.body);
      const c = s.customer;
      const rows = [
        ['Contractor', `${s.company.name}${s.company.company_number ? `, Company No. ${s.company.company_number}` : ''}`],
        ['Client', `${c.business}${c.company_number ? `, Company No. ${c.company_number}` : ''}`],
        ...(c.billing_address ? [['Registered / billing address', c.billing_address]] : []),
        ['Service address', s.site?.address || c.address || 'To be confirmed'],
        ...(s.signer?.name ? [['Client contact', [s.signer.name, s.signer.job_title, s.signer.phone].filter(Boolean).join(', ')]] : []),
        ['Effective date', fmtDate(s.start_date)],
        ...(s.renewal_date ? [['Review / renewal date', fmtDate(s.renewal_date)]] : []),
        ...(s.proposal_ref ? [['Proposal reference', s.proposal_ref]] : []),
      ];
      k.table([1.6, 3.4], rows, { header: ['Party / item', 'Details'] });
    } else if (sec.key === 'scope') {
      if (sec.body) k.markup(sec.body);
      scopeOfServices(k, s);
      k.subsection('Cleaning schedule');
      scheduleTable(k, s);
      if (s.schedule_notes) k.markup(s.schedule_notes);
    } else if (sec.key === 'commercial_terms') {
      k.subsection('Pricing');
      pricingTables(k, s);
      k.markup(sec.body);
      if (s.payment_terms) { k.subsection('Payment terms agreed for this account'); k.markup(s.payment_terms); }
    } else if (sec.key === 'acceptance') {
      k.markup(sec.body);
      fields = signatureBlock(doc, k, s);
    } else k.markup(sec.body);
  }
  chrome(doc, s, { docLabel: label, footerLabel: 'Confidential Document', refLabel: 'Agreement' });
  doc.end();
  return { buffer: await done, fields };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (await import('node:assert')).strict;
  const { priceDocument } = await import('./pricing.mjs');
  const { writeFile } = await import('node:fs/promises');
  assert.equal(clean('a ≈ b → c ✓ £5 – “x”'), 'a ~ b -> c Yes £5 – “x”');
  assert.equal(merge('Hi {{client}} {{nope}}', { client: 'HDO' }), 'Hi HDO {{nope}}');
  assert.deepEqual(unresolved(['a [[fill me]] b', '{{x}}', 'ok']), ['[[fill me]]', '{{x}}']);
  const priced = priceDocument({ lines: [
    { name: 'One-Off Deep Clean', billing: 'fixed', frequency: 'one_off', price_pence: 69500, scope: '- High-level AC dust removal\n- Floors', notes: 'Payment: 50% deposit before scheduling' },
    { name: 'Daily Cleaning Service', billing: 'fixed', frequency: 'monthly', price_pence: 375000, visits_per_week: 7, hours_per_visit: 5, schedule: 'Mon–Sun after 4:00 pm', scope: '### Kitchen\n- Clean sinks\n- Mop floors' },
    { name: 'Window cleaning', billing: 'fixed', frequency: 'monthly', price_pence: 6000, optional: true },
  ] });
  const company = { name: 'FC Cleaning Company Ltd', address: '57 St. Davids Crescent, Aspull, Wigan WN2 1SZ', phone: '0161 399 0482', email: 'fernando.c@fccleaningcompany.com', website: 'fccleaningcompany.com', vat_number: '517 4596 68', company_number: '17091521', signatory_name: 'Fernando Caceres', signatory_title: 'Operations Director' };
  const s = { number: 'FCC-TST-001', version: 1, issue_date: '2026-10-11', valid_until: '2026-11-10', company, vat_rate_bp: 2000,
    customer: { business: 'Test Bakery Ltd', address: 'Unit 1, Manchester M4 4HF' }, person: { name: 'Frankie', job_title: 'Ops Manager' }, signer: { name: 'Frankie Baird', job_title: 'Operations Manager' },
    site: { address: 'Unit 17 Red Bank, Manchester M4 4HF' }, ...priced, summary_rows: [['Quality assurance', 'Weekly follow-ups during first 5 weeks']],
    terms: [['Start date', 'To be confirmed'], ['Minimum term', '3 months']], start_date: '2026-11-01',
    sections: ['executive_summary', 'scope', 'schedule', 'pricing', 'commercial_terms', 'acceptance'].map((key) => ({ key, title: key.replace(/_/g, ' '), body: 'Body text.\n\n- bullet one\n- bullet two' })) };
  const pdf = await renderProposal(s);
  assert.ok(pdf.subarray(0, 5).toString() === '%PDF-' && pdf.length > 5000);
  const c = await renderContract({ ...s, sections: ['overview', 'scope', 'commercial_terms', 'governing_law', 'acceptance'].map((key) => ({ key, title: key, body: 'Clause.' })) });
  assert.equal(c.fields.filter((f) => f.role === 'Client').length, 4);       // name, position, signature, date
  assert.equal(c.fields.filter((f) => f.role === 'FC Cleaning').length, 2);
  assert.ok(c.fields.every((f) => f.x > 0 && f.x < 1 && f.y > 0 && f.y < 1 && f.page >= 1));
  if (process.argv[2]) { await writeFile(`${process.argv[2]}/proposal.pdf`, pdf); await writeFile(`${process.argv[2]}/contract.pdf`, c.buffer); }
  console.log('pdf ok');
}
