/* FC Cleaning CRM — router, shared UI helpers and the business views.
   Loaded after app.js (shares its globals: api, escapeHtml, STAGES, STAGE_LABEL, contacts,
   loadContacts, openDrawer, closeDrawer, closeSidebar, loadDraftsView, loadCalendarView,
   loadCampaignsView, loadSettingsView). Plain browser JS, no build step. */
'use strict';
const esc = escapeHtml;
let ME = null, USERS = [];
const can = (role) => ME && { staff: 1, manager: 2, admin: 3 }[ME.role] >= { staff: 1, manager: 2, admin: 3 }[role];

// ── formatting ───────────────────────────────────────────
const money = (p) => (p == null || p === '' ? '—' : `£${(Number(p) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const moneyShort = (p) => `£${Math.round(Number(p || 0) / 100).toLocaleString('en-GB')}`;
const fmtDate = (d) => (d ? new Date(String(d).length === 10 ? `${d}T12:00:00` : d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const fmtDT = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const isoDay = (d = new Date()) => new Date(d).toLocaleDateString('en-CA');
const relDays = (d) => { const n = Math.round((new Date(isoDay(d)) - new Date(isoDay())) / 86400000); return n === 0 ? 'today' : n === 1 ? 'tomorrow' : n === -1 ? 'yesterday' : n > 0 ? `in ${n} days` : `${-n} days ago`; };
const LABELS = { partially_signed: 'Partially signed', renewal_due: 'Renewal due', visit_booked: 'Visit booked', follow_up: 'Follow-up', site_visit: 'Site visit', quality_check: 'Quality check', proposal_pdf: 'Proposal', contract_pdf: 'Contract', signed_pdf: 'Signed contract', audit_trail: 'Signing audit trail', upload: 'Upload' };
const label = (s) => LABELS[s] || String(s || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const badge = (s) => `<span class="badge b-${esc(s)}">${esc(label(s))}</span>`;
/** "12.50" → 1250 pence. '' stays ''. Anything else → NaN (shown as an error). */
function toPence(v) {
  const s = String(v ?? '').replace(/[£,\s]/g, '');
  if (!s) return '';
  const m = s.match(/^(\d+)(?:\.(\d{1,2}))?$/);
  return m ? Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0')) : NaN;
}
const fromPence = (p) => (p === '' || p == null ? '' : (Number(p) / 100).toFixed(2));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ── toasts, confirm, modal ───────────────────────────────
function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
}
const modalEl = document.getElementById('modal');
modalEl.addEventListener('click', (e) => { if (e.target === modalEl) modalEl.close(); });
/**
 * Opens the shared dialog. body is HTML (put form fields in it). onSubmit(form, fd) may throw:
 * its message shows inside the dialog. Resolves with onSubmit's result, or null if cancelled.
 */
function modal({ title, sub = '', body = '', submit = 'Save', cancel = 'Cancel', danger = false, wide = false, onSubmit = async () => true, noSubmit = false }) {
  return new Promise((resolve) => {
    modalEl.className = `modal${wide ? ' wide' : ''}`;
    modalEl.innerHTML = `<form method="dialog" novalidate><h2>${esc(title)}</h2>${sub ? `<p class="msub">${sub}</p>` : ''}<div class="mcontent">${body}</div>
      <p class="err-text merr" role="alert"></p>
      <div class="mactions"><button type="button" class="btn-secondary" value="cancel">${esc(cancel)}</button>${noSubmit ? '' : `<button class="${danger ? 'btn-danger' : 'btn-primary'}" value="ok">${esc(submit)}</button>`}</div></form>`;
    const form = modalEl.querySelector('form');
    let result = null;
    form.querySelector('[value=cancel]').addEventListener('click', () => modalEl.close());
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[value=ok]');
      for (const el of form.querySelectorAll('[required]')) if (!String(el.value).trim()) { form.querySelector('.merr').textContent = `${el.closest('.field')?.querySelector('label')?.textContent || 'A field'} is required.`; el.focus(); return; }
      btn.disabled = true; btn.classList.add('loading'); form.querySelector('.merr').textContent = '';
      try { result = await onSubmit(form, new FormData(form)); if (result !== false) modalEl.close(); }
      catch (err) {
        const probs = err.data?.problems;
        form.querySelector('.merr').innerHTML = esc(err.message) + (probs ? `<ul>${probs.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : '');
      } finally { btn.disabled = false; btn.classList.remove('loading'); }
    });
    modalEl.addEventListener('close', () => resolve(result), { once: true });
    modalEl.showModal();
    form.querySelector('input:not([type=hidden]), textarea, select')?.focus();
  });
}
const confirmDialog = ({ title, body = '', confirmText = 'Confirm', danger = false }) =>
  modal({ title, body: body ? `<p>${esc(body)}</p>` : '', submit: confirmText, danger, onSubmit: async () => true }).then((r) => r === true);
const field = (lbl, input, hint = '') => `<div class="field"><label>${lbl}</label>${input}${hint ? `<span class="hint">${hint}</span>` : ''}</div>`;
async function busy(btn, fn) {
  btn.disabled = true; btn.classList.add('loading');
  try { return await fn(); } catch (err) { toast(err.message, 'error'); if (err.data?.problems) showProblems(err.data.problems); } finally { btn.disabled = false; btn.classList.remove('loading'); }
}
function showProblems(list) {
  modal({ title: 'Not ready yet', body: `<ul>${list.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`, noSubmit: true, cancel: 'OK' });
}
const empty = (title, text = '', action = '') => `<div class="empty"><b>${esc(title)}</b>${esc(text)}${action}</div>`;
const skeleton = (n = 4) => `<div class="card">${'<div class="skel"></div>'.repeat(n)}</div>`;
const userOptions = (sel, blank = 'Unassigned') => `<option value="">${blank}</option>${USERS.map((u) => `<option value="${u.id}" ${u.id === sel ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}`;

// ── upload helper (raw body, file name in a header) ──────
async function uploadFile(file, query) {
  const res = await fetch(`/api/documents?${new URLSearchParams(query)}`, { method: 'POST', body: file,
    headers: { 'X-FC-CSRF': '1', 'X-Filename': encodeURIComponent(file.name), 'Content-Type': file.type || 'application/octet-stream' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data;
}
function pickAndUpload(query, done) {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.pdf,.png,.jpg,.jpeg,.webp,.docx,.xlsx,.txt,.csv' });
  input.addEventListener('change', async () => {
    const f = input.files[0];
    if (!f) return;
    if (f.size > 15 * 1024 * 1024) return toast('Files can be at most 15 MB.', 'error');
    try { await uploadFile(f, query); toast(`Uploaded ${f.name}`); done(); } catch (err) { toast(err.message, 'error'); }
  });
  input.click();
}
// PDF preview drawn with PDF.js (vendored in /vendor/pdfjs): every page fitted to the width,
// pinch or − / + to zoom. (Phones show a PDF in an <iframe> as one fixed, unzoomable page.)
let pdfjsLib = null;
async function loadPdfJs() {
  if (!pdfjsLib) {
    pdfjsLib = await import('/vendor/pdfjs/pdf.min.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
  }
  return pdfjsLib;
}
function previewPdf(url, title) {
  const dl = `${url}${url.includes('?') ? '&' : '?'}download=1`;
  modalEl.className = 'modal pdf-modal';
  modalEl.innerHTML = `<div class="pdf-bar"><b>${esc(title)}</b>
      <a class="btn-primary btn-sm" href="${esc(dl)}">Download</a>
      <a class="btn-secondary btn-sm pdf-open" href="${esc(url)}" target="_blank" rel="noopener">Open</a>
      <button type="button" class="pdf-close" aria-label="Close preview">✕</button></div>
    <div class="pdf-pages" tabindex="0"><div class="pdf-stack"><div class="skel" style="height:60vh"></div></div></div>
    <div class="pdf-zoom" role="group" aria-label="Zoom"><button type="button" data-z="-">−</button><button type="button" data-z="fit" class="pdf-pct">100%</button><button type="button" data-z="+">+</button></div>`;
  modalEl.querySelector('.pdf-close').onclick = () => modalEl.close();
  modalEl.showModal();
  history.pushState({ pdf: 1 }, '', location.href); // phone back button closes the preview
  const onPop = () => { if (modalEl.open) modalEl.close(); };
  window.addEventListener('popstate', onPop, { once: true });
  let closed = false;
  modalEl.addEventListener('close', () => { closed = true; window.removeEventListener('popstate', onPop); if (history.state?.pdf) history.back(); }, { once: true });

  const box = modalEl.querySelector('.pdf-pages'), stack = modalEl.querySelector('.pdf-stack'), pct = modalEl.querySelector('.pdf-pct');
  let doc = null, pages = [], zoom = 1, renderTimer = null;
  const fitWidth = () => box.clientWidth - 24;
  // canvases are sized by CSS instantly (smooth pinch); re-rendered sharp shortly after
  const layout = () => {
    for (const pg of pages) { const w = fitWidth() * zoom; pg.canvas.style.width = `${w}px`; pg.canvas.style.height = `${w * pg.ratio}px`; }
    pct.textContent = `${Math.round(zoom * 100)}%`;
    clearTimeout(renderTimer); renderTimer = setTimeout(renderAll, 200);
  };
  const renderAll = async () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    for (const pg of pages) {
      if (closed) return;
      const cssW = fitWidth() * zoom, scale = (cssW / pg.base.width) * dpr;
      if (pg.scale === scale) continue;
      pg.scale = scale;
      const vp = pg.page.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      await pg.page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      pg.canvas.width = c.width; pg.canvas.height = c.height;
      pg.canvas.getContext('2d').drawImage(c, 0, 0);
    }
  };
  const setZoom = (z, anchor) => {
    const old = zoom;
    zoom = Math.min(4, Math.max(0.5, z));
    // keep the point under the fingers / centre in place
    const ax = anchor?.x ?? box.clientWidth / 2, ay = anchor?.y ?? box.clientHeight / 2;
    const sx = box.scrollLeft + ax, sy = box.scrollTop + ay;
    layout();
    box.scrollLeft = sx * (zoom / old) - ax; box.scrollTop = sy * (zoom / old) - ay;
  };
  modalEl.querySelector('.pdf-zoom').onclick = (e) => {
    const z = e.target.dataset.z;
    if (z === '+') setZoom(zoom * 1.25); if (z === '-') setZoom(zoom / 1.25); if (z === 'fit') setZoom(1);
  };
  box.addEventListener('wheel', (e) => { if (!e.ctrlKey) return; e.preventDefault(); const r = box.getBoundingClientRect(); setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), { x: e.clientX - r.left, y: e.clientY - r.top }); }, { passive: false });
  // two-finger pinch
  let pinch = null;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  box.addEventListener('touchstart', (e) => { if (e.touches.length === 2) { const r = box.getBoundingClientRect(); pinch = { d: dist(e.touches), z: zoom, x: (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left, y: (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top }; } }, { passive: true });
  box.addEventListener('touchmove', (e) => { if (pinch && e.touches.length === 2) { e.preventDefault(); setZoom(pinch.z * (dist(e.touches) / pinch.d), pinch); } }, { passive: false });
  box.addEventListener('touchend', () => { pinch = null; });
  window.addEventListener('resize', () => { if (!closed) layout(); });

  (async () => {
    try {
      const lib = await loadPdfJs();
      const res = await fetch(url, { headers: { 'X-FC-CSRF': '1' } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Couldn’t load the PDF (${res.status})`);
      doc = await lib.getDocument({ data: new Uint8Array(await res.arrayBuffer()) }).promise;
      if (closed) return;
      stack.innerHTML = '';
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i), base = page.getViewport({ scale: 1 });
        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-page'; canvas.setAttribute('aria-label', `Page ${i} of ${doc.numPages}`);
        stack.appendChild(canvas);
        pages.push({ page, base, ratio: base.height / base.width, canvas, scale: 0 });
      }
      layout();
    } catch (err) {
      // fall back to the browser's own viewer
      stack.innerHTML = `<div class="alert alert-warn">The preview couldn’t be drawn here (${esc(err.message)}). Use <b>Open</b> or <b>Download</b>.</div><iframe src="${esc(url)}" title="${esc(title)}"></iframe>`;
    }
  })();
}

// ── native invoicing ───────────────────────────────────────
function dueText(i) {
  if (i.status === 'paid') return i.paid_on ? `Paid ${fmtDate(i.paid_on)}` : 'Paid';
  if (i.status === 'draft') return `Due ${fmtDate(i.due_date)}`;
  const d = Math.round((Date.parse(String(i.due_date).slice(0, 10)) - Date.parse(isoDay())) / 864e5);
  return d > 0 ? `Due in ${d} day${d === 1 ? '' : 's'}: ${fmtDate(i.due_date)}` : d === 0 ? 'Due today' : `Overdue by ${-d} day${d === -1 ? '' : 's'}`;
}
async function renderInvoices(section, contact = null) {
  if (!can('manager')) { section.innerHTML = '<div class="alert">Only managers and administrators can create invoices.</div>'; return; }
  const [invoices, customers] = await Promise.all([api(`/api/invoices${contact ? `?contact_id=${encodeURIComponent(contact.id)}` : ''}`), api('/api/contacts?limit=1000')]);
  // only customers we've at least quoted (or already invoiced) — not every prospect
  const invoiced = new Set(invoices.map((i) => i.contact_id));
  const active = customers.filter((c) => !c.archived_at && (['quoted', 'won'].includes(c.pipeline_stage) || invoiced.has(c.id) || c.id === contact?.id)).sort((a, b) => String(a.business || a.contact_name || '').localeCompare(String(b.business || b.contact_name || '')));
  const outstanding = invoices.filter((i) => ['issued', 'part_paid'].includes(i.status)).reduce((s, i) => s + Number(i.balance_pence), 0);
  const overdue = (i) => ['issued', 'part_paid'].includes(i.status) && String(i.due_date).slice(0, 10) < isoDay();
  const card = (i) => `<article class="inv-card" data-q="${esc(`${i.number} ${i.business || ''}`.toLowerCase())}" data-status="${esc(i.status)}">
      <div class="inv-top"><b class="inv-no">${esc(i.number)}</b>${badge(i.status)}${overdue(i) ? '<span class="badge b-expired">Overdue</span>' : ''}</div>
      <div class="inv-cust">${esc(i.business || '—')}</div>
      <div class="inv-meta"><span>${i.status === 'draft' ? 'Dated' : 'Issued'} ${fmtDate(i.issue_date)}</span><span class="${overdue(i) ? 'inv-late' : ''}">${dueText(i)}</span>${i.last_reminder_at ? `<span>Reminder sent ${fmtDate(i.last_reminder_at)}</span>` : ''}</div>
      <div class="inv-money"><div><small>Total</small><b>${money(i.total_pence)}</b></div>${i.status === 'draft' ? '' : `<div><small>Balance</small><b>${money(i.balance_pence)}</b></div>`}</div>
      <div class="inv-actions">
        <button class="btn-secondary btn-sm" data-act="pdf">View PDF</button>
        ${i.status === 'draft' ? '<button class="btn-secondary btn-sm" data-act="edit">Edit</button><button class="btn-primary btn-sm" data-act="issue">Issue</button><button class="btn-ghost btn-sm inv-del" data-act="delete">Delete</button>' : ''}
        ${['issued', 'part_paid'].includes(i.status) && Number(i.balance_pence) > 0 ? `<button class="btn-primary btn-sm" data-act="paid">Mark paid</button><button class="btn-secondary btn-sm" data-act="pay">Part payment</button><button class="btn-secondary btn-sm" data-act="remind">Send reminder</button>` : ''}
        ${['paid', 'part_paid'].includes(i.status) ? '<button class="btn-ghost btn-sm" data-act="unpaid">Mark unpaid</button>' : ''}
      </div></article>`;
  const lineRow = (l = {}) => `<div class="invoice-line">
      <label class="inv-desc">Description<input name="description" required maxlength="300" value="${esc(l.description ?? 'Cleaning service')}"></label>
      <label>Qty<input name="quantity" type="number" inputmode="decimal" min="0.001" step="0.001" value="${esc(l.quantity ?? '1')}" required></label>
      <label>Unit cost (£)<input name="unit_price" type="number" inputmode="decimal" min="0" step="0.01" value="${esc(l.unit_price ?? '')}" placeholder="0.00" required></label>
      <button type="button" class="inv-remove" aria-label="Remove line" title="Remove line">×</button></div>`;
  section.innerHTML = `<div class="page-head"><div>${contact ? '<h2>Invoices</h2>' : '<h1>Invoices</h1>'}<p>${invoices.length ? `${invoices.length} invoice${invoices.length === 1 ? '' : 's'}${outstanding ? ` · ${money(outstanding)} outstanding` : ''}` : 'Create, issue and track payment of customer invoices.'}</p></div>
      <div class="actions"><button class="btn-primary" id="inv-new">+ New invoice</button></div></div>
    <div class="card inv-form-card" id="inv-form-card" hidden>
      <div class="card-head"><h2 id="inv-form-title">New invoice</h2></div>
      <form id="invoice-form" class="form-grid" novalidate>
        <label class="span-all">Customer<select name="contact_id" required><option value="">Choose customer…</option>${active.map((c) => `<option value="${esc(c.id)}">${esc(c.business || c.contact_name || c.email || 'Customer')}</option>`).join('')}</select></label>
        <label>Issue date<input name="issue_date" type="date" value="${isoDay()}" required></label>
        <label>Due date<input name="due_date" type="date" value="${isoDay(new Date(Date.now() + 14 * 86400000))}" required></label>
        <label>VAT<select name="vat_rate_bp"><option value="2000">20%</option><option value="500">5%</option><option value="0">No VAT (0%)</option></select></label>
        <fieldset class="span-all inv-lines"><legend>What you're charging for</legend><div id="invoice-lines"></div>
          <button type="button" id="invoice-add-line" class="btn-ghost btn-sm">+ Add another line</button></fieldset>
        <div class="span-all inv-totals" id="invoice-total-preview" aria-live="polite"></div>
        <details class="span-all inv-more"><summary>Contract value, deposit, note and terms (optional)</summary><div class="form-grid">
          <label>Total contract value incl. VAT (£)<input name="contract_total" type="number" inputmode="decimal" min="0" step="0.01"></label>
          <label>Deposit / upfront incl. VAT (£)<input name="deposit" type="number" inputmode="decimal" min="0" step="0.01"></label>
          <label class="span-all">Note to customer<textarea name="customer_note" rows="2" placeholder="e.g. Please quote the invoice number when paying."></textarea></label>
          <label class="span-all">Terms &amp; conditions<textarea name="terms" rows="3" placeholder="e.g. Payment due within 14 days."></textarea></label></div></details>
        <div class="span-all inv-form-actions"><button type="submit" class="btn-primary">Save draft</button><button type="button" class="btn-secondary" id="inv-cancel">Cancel</button></div>
      </form></div>
    ${invoices.length ? `<div class="toolbar"><input type="search" id="inv-q" placeholder="Search number or customer…" aria-label="Search invoices">
      <select id="inv-status" aria-label="Status"><option value="">All statuses</option>${['draft', 'issued', 'part_paid', 'paid'].map((s) => `<option value="${s}">${label(s)}</option>`).join('')}</select></div>
      <div class="inv-list" id="inv-list">${invoices.map(card).join('')}</div><p class="empty hidden" id="inv-none">No invoices match.</p>`
      : empty('No invoices yet', 'Tap + New invoice to create your first one.')}`;

  const form = section.querySelector('#invoice-form'), formCard = section.querySelector('#inv-form-card'), linesEl = section.querySelector('#invoice-lines');
  const updatePreview = () => {
    let sub = 0;
    for (const row of linesEl.children) sub += Math.round(Number(row.querySelector('[name=quantity]').value || 0) * Math.round(Number(row.querySelector('[name=unit_price]').value || 0) * 100));
    const rate = Number(form.vat_rate_bp.value || 0), vat = Math.round(sub * rate / 10000);
    section.querySelector('#invoice-total-preview').innerHTML = `<div><span>Subtotal</span><b>${money(sub)}</b></div><div><span>VAT (${rate / 100}%)</span><b>${money(vat)}</b></div><div class="inv-grand"><span>Total</span><b>${money(sub + vat)}</b></div>`;
  };
  const addLine = (l) => { linesEl.insertAdjacentHTML('beforeend', lineRow(l)); syncRemove(); updatePreview(); };
  const syncRemove = () => linesEl.querySelectorAll('.inv-remove').forEach((b) => { b.hidden = linesEl.children.length < 2; });
  const openForm = (inv = null) => {
    form.reset(); delete form.dataset.editing; linesEl.innerHTML = '';
    section.querySelector('#inv-form-title').textContent = inv ? `Edit ${inv.number}` : 'New invoice';
    form.querySelector('[type=submit]').textContent = inv ? 'Save changes' : 'Save draft';
    if (inv) {
      form.dataset.editing = inv.id;
      form.contact_id.value = inv.contact_id; form.issue_date.value = String(inv.issue_date).slice(0, 10); form.due_date.value = String(inv.due_date).slice(0, 10);
      form.vat_rate_bp.value = String(inv.vat_rate_bp);
      form.contract_total.value = inv.contract_total_pence == null ? '' : (inv.contract_total_pence / 100).toFixed(2);
      form.deposit.value = inv.deposit_pence == null ? '' : (inv.deposit_pence / 100).toFixed(2);
      form.customer_note.value = inv.customer_note || ''; form.terms.value = inv.terms || '';
      form.querySelector('.inv-more').open = !!(inv.customer_note || inv.terms || inv.contract_total_pence != null || inv.deposit_pence != null);
      inv.lines.forEach((l) => addLine({ description: l.description, quantity: String(Number(l.quantity)), unit_price: (l.unit_price_pence / 100).toFixed(2) }));
    } else { addLine(); if (contact) form.contact_id.value = contact.id; }
    formCard.hidden = false; formCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  section.querySelector('#inv-new').onclick = () => openForm();
  section.querySelector('#inv-cancel').onclick = () => { formCard.hidden = true; window.scrollTo({ top: 0, behavior: 'smooth' }); };
  section.querySelector('#invoice-add-line').onclick = () => { addLine({ description: '' }); linesEl.lastElementChild.querySelector('input').focus(); };
  linesEl.addEventListener('click', (e) => { const b = e.target.closest('.inv-remove'); if (b && linesEl.children.length > 1) { b.closest('.invoice-line').remove(); syncRemove(); updatePreview(); } });
  form.addEventListener('input', updatePreview); form.addEventListener('change', updatePreview);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.contact_id.value) { toast('Choose a customer first.', 'error'); form.contact_id.focus(); return; }
    const bad = [...linesEl.querySelectorAll('input')].find((i) => !i.checkValidity() || !i.value.trim());
    if (bad) { toast('Each line needs a description, quantity and unit cost.', 'error'); bad.focus(); return; }
    await busy(form.querySelector('[type=submit]'), async () => {
      const fd = new FormData(form), editing = form.dataset.editing;
      const payload = { contact_id: fd.get('contact_id'), issue_date: fd.get('issue_date'), due_date: fd.get('due_date'), vat_rate_bp: Number(fd.get('vat_rate_bp')),
        lines: [...linesEl.children].map((r) => ({ description: r.querySelector('[name=description]').value, quantity: Number(r.querySelector('[name=quantity]').value), unit_price: Number(r.querySelector('[name=unit_price]').value) })),
        contract_total: fd.get('contract_total'), deposit: fd.get('deposit'), customer_note: fd.get('customer_note'), terms: fd.get('terms') };
      const inv = await api(editing ? `/api/invoices/${editing}` : '/api/invoices', { method: editing ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      toast(editing ? `${inv.number} updated` : `Draft ${inv.number} saved — check the PDF, then tap Issue`);
      await renderInvoices(section, contact);
    });
  });

  const filter = () => {
    const q = section.querySelector('#inv-q').value.trim().toLowerCase(), st = section.querySelector('#inv-status').value;
    let shown = 0;
    section.querySelectorAll('.inv-card').forEach((c) => { c.hidden = (q && !c.dataset.q.includes(q)) || (st && c.dataset.status !== st); if (!c.hidden) shown++; });
    section.querySelector('#inv-none').classList.toggle('hidden', shown > 0);
  };
  section.querySelector('#inv-q')?.addEventListener('input', filter);
  section.querySelector('#inv-status')?.addEventListener('change', filter);

  section.querySelector('#inv-list')?.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const i = invoices[[...section.querySelectorAll('.inv-card')].indexOf(b.closest('.inv-card'))];
    if (b.dataset.act === 'pdf') return previewPdf(`/api/invoices/${i.id}/pdf`, i.number);
    if (b.dataset.act === 'edit') return busy(b, async () => openForm(await api(`/api/invoices/${i.id}`)));
    if (b.dataset.act === 'issue') {
      const ok = await modal({ title: `Issue ${i.number}?`, sub: `${esc(i.business || '')} · ${money(i.total_pence)}. Once issued it can't be edited, so check the PDF first.`, submit: 'Issue invoice',
        onSubmit: async () => { await api(`/api/invoices/${i.id}/issue`, { method: 'POST', body: '{}' }); return true; } });
      if (ok !== null) { toast(`${i.number} issued`); await renderInvoices(section, contact); }
    }
    if (b.dataset.act === 'delete') {
      const ok = await modal({ title: `Delete ${i.number}?`, sub: 'This draft hasn’t been sent, so it can be deleted.', submit: 'Delete', danger: true,
        onSubmit: async () => { await api(`/api/invoices/${i.id}`, { method: 'DELETE' }); return true; } });
      if (ok !== null) { toast('Draft deleted'); await renderInvoices(section, contact); }
    }
    if (b.dataset.act === 'paid') {
      const ok = await modal({ title: `Mark ${i.number} as paid?`, sub: `${esc(i.business || '')} · ${money(i.balance_pence)}`, body: field('Paid on', `<input name="paid_on" type="date" value="${isoDay()}" required>`), submit: 'Mark paid',
        onSubmit: async (_, fd) => { await api(`/api/invoices/${i.id}/payments`, { method: 'POST', body: JSON.stringify({ amount: Number(i.balance_pence) / 100, paid_on: fd.get('paid_on'), reference: '' }) }); return true; } });
      if (ok !== null) { toast(`${i.number} marked paid`); await renderInvoices(section, contact); }
    }
    if (b.dataset.act === 'unpaid') {
      const ok = await modal({ title: `Mark ${i.number} as unpaid?`, sub: 'This removes the payments recorded against it.', submit: 'Mark unpaid', danger: true,
        onSubmit: async () => { await api(`/api/invoices/${i.id}/unpaid`, { method: 'POST', body: '{}' }); return true; } });
      if (ok !== null) { toast(`${i.number} is unpaid again`); await renderInvoices(section, contact); }
    }
    if (b.dataset.act === 'remind') {
      const ok = await modal({ title: `Send a reminder for ${i.number}?`, sub: `Emails the customer the invoice PDF and the ${money(i.balance_pence)} still owed.`, submit: 'Send reminder',
        onSubmit: async () => api(`/api/invoices/${i.id}/remind`, { method: 'POST', body: '{}' }) });
      if (ok) { toast(`Reminder sent to ${ok.to}`); await renderInvoices(section, contact); }
    }
    if (b.dataset.act === 'pay') {
      const bal = (Number(i.balance_pence) / 100).toFixed(2);
      const ok = await modal({ title: `Record payment · ${i.number}`, sub: `Outstanding ${money(i.balance_pence)}`,
        body: `${field('Amount (£)', `<input name="amount" type="number" inputmode="decimal" min="0.01" max="${bal}" step="0.01" value="${bal}" required>`)}${field('Paid on', `<input name="paid_on" type="date" value="${isoDay()}" required>`)}${field('Reference', '<input name="reference" maxlength="200" placeholder="e.g. bank transfer ref">', 'Optional')}`,
        submit: 'Record payment',
        onSubmit: async (_, fd) => { await api(`/api/invoices/${i.id}/payments`, { method: 'POST', body: JSON.stringify({ amount: Number(fd.get('amount')), paid_on: fd.get('paid_on'), reference: fd.get('reference') }) }); return true; } });
      if (ok !== null) { toast('Payment recorded'); await renderInvoices(section, contact); }
    }
  });
}

// ── router ───────────────────────────────────────────────
const LEGACY_VIEWS = { pipeline: () => loadContacts(), drafts: () => loadDraftsView(), campaigns: () => loadCampaignsView(), calendar: () => loadCalendarView(true) };
const VIEWS = {
  dashboard: { title: 'Dashboard', render: renderDashboard },
  tasks: { title: 'Tasks', render: renderTasks },
  customers: { title: 'Customers', render: renderCustomers, detail: { section: 'customer', render: renderCustomer } },
  pipeline: { title: 'Pipeline' }, drafts: { title: 'Outreach drafts' }, campaigns: { title: 'Campaigns' }, calendar: { title: 'Calendar' },
  proposals: { title: 'Proposals', render: renderProposals, detail: { section: 'proposal', render: renderProposal } },
  invoices: { title: 'Invoices', render: (el) => renderInvoices(el) },
  contracts: { title: 'Contracts', render: renderContracts, detail: { section: 'contract', render: renderContract } },
  documents: { title: 'Documents', render: renderDocuments },
  reports: { title: 'Reports', render: renderReports },
  settings: { title: 'Settings', render: renderSettings },
};
let leaveGuard = null; // set by editors with unsaved changes
function setCrumbs(parts) {
  document.getElementById('crumbs').innerHTML = parts.map(([t, href], i) => (i === parts.length - 1 ? `<b>${esc(t)}</b>` : `<a href="${href}">${esc(t)}</a><span class="sep">/</span>`)).join('');
  document.title = `${parts[parts.length - 1][0]} · FC Cleaning CRM`;
}
async function route() {
  const [, name = 'dashboard', id, sub] = location.hash.match(/^#\/([\w-]+)(?:\/([\w-]+))?(?:\/([\w-]+))?/) || [];
  const v = VIEWS[name] ? name : 'dashboard';
  const conf = VIEWS[v];
  for (const el of document.querySelectorAll('main .view')) { el.classList.add('hidden'); el.classList.remove('has-mbar'); }
  document.querySelectorAll('#tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
  document.querySelectorAll('#tabs .tab').forEach((t) => (t.dataset.view === v ? t.setAttribute('aria-current', 'page') : t.removeAttribute('aria-current')));
  closeSidebar();
  closeDrawer();
  const sectionId = id && conf.detail ? conf.detail.section : v;
  const section = document.getElementById(`view-${sectionId}`);
  section.classList.remove('hidden');
  setCrumbs([[conf.title, `#/${v}`]]);
  try {
    if (LEGACY_VIEWS[v]) await LEGACY_VIEWS[v]();
    else if (id && conf.detail) { section.innerHTML = skeleton(8); await conf.detail.render(section, id, sub); }
    else { if (!section.innerHTML.trim() || v !== 'settings') section.innerHTML = skeleton(); await conf.render(section, id); }
  } catch (err) {
    section.innerHTML = `<div class="alert alert-danger"><b>Couldn’t load this page.</b> ${esc(err.message)} <button class="btn-secondary btn-sm" onclick="route()">Try again</button></div>`;
  }
  document.getElementById('main').focus({ preventScroll: true });
  window.scrollTo(0, 0);
}
let lastHash = location.hash;
window.addEventListener('hashchange', async () => {
  if (leaveGuard && !leaveGuard()) {
    const ok = await confirmDialog({ title: 'Leave without saving?', body: 'You have unsaved changes on this page.', confirmText: 'Leave', danger: true });
    if (!ok) { history.replaceState(null, '', lastHash); return; }
  }
  leaveGuard = null; lastHash = location.hash;
  route();
});
window.addEventListener('beforeunload', (e) => { if (leaveGuard && !leaveGuard()) { e.preventDefault(); e.returnValue = ''; } });
document.getElementById('menu-toggle').setAttribute('aria-expanded', 'false');

// ── global search + "New" menu ───────────────────────────
const gs = document.getElementById('gsearch'), gsr = document.getElementById('gsearch-results');
gs.addEventListener('input', debounce(async () => {
  const q = gs.value.trim();
  if (q.length < 2) { gsr.hidden = true; return; }
  const rows = await api(`/api/contacts?q=${encodeURIComponent(q)}&limit=8`).catch(() => []);
  gsr.innerHTML = rows.length ? rows.map((c) => `<a href="#/customers/${c.id}" role="option">${esc(c.business || c.contact_name)}<small>${esc([c.contact_name, c.email, c.phone].filter(Boolean).join(' · '))}</small></a>`).join('') : '<div class="empty">No customers match.</div>';
  gsr.hidden = false;
}, 200));
gs.addEventListener('keydown', (e) => {
  const links = [...gsr.querySelectorAll('a')];
  let i = links.findIndex((a) => a.classList.contains('on'));
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); links[i]?.classList.remove('on'); i = (i + (e.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length; links[i]?.classList.add('on'); }
  if (e.key === 'Enter' && links.length) { e.preventDefault(); location.hash = (links[i] || links[0]).getAttribute('href'); gsr.hidden = true; gs.value = ''; }
  if (e.key === 'Escape') gsr.hidden = true;
});
gsr.addEventListener('click', () => { gsr.hidden = true; gs.value = ''; });
document.addEventListener('click', (e) => {
  if (!e.target.closest('.gsearch')) gsr.hidden = true;
  for (const d of document.querySelectorAll('details.menu[open]')) if (!d.contains(e.target)) d.open = false;
});
document.querySelector('.new-menu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-new]');
  if (!b) return;
  e.target.closest('details').open = false;
  ({ customer: newCustomer, proposal: () => newProposal(), task: () => newTask() })[b.dataset.new]();
});

// ══════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════
let dashRange = 30;
async function renderDashboard(el) {
  const from = isoDay(Date.now() - dashRange * 86400000);
  const [r, drafts] = await Promise.all([api(`/api/reports?from=${from}`), api('/api/drafts').catch(() => [])]);
  const m = r.metrics, d = r.definitions, L = r.lists;
  const pctTxt = (x) => (x.pct == null ? '—' : `${x.pct}%`);
  const info = (k) => `<span class="info" title="${esc(d[k] || '')}">i</span>`;
  el.innerHTML = `
    <div class="page-head"><div><h1>Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening'}${ME ? `, ${esc(ME.name.split(' ')[0])}` : ''}</h1><p>Everything that needs attention, from the live database.</p></div>
      <div class="actions"><select id="dash-range" aria-label="Period">${[[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [365, 'Last 12 months']].map(([n, t]) => `<option value="${n}" ${n === dashRange ? 'selected' : ''}>${t}</option>`).join('')}</select>
      <a class="btn-secondary" href="#/reports">Full report</a></div></div>
    <div class="kpis">
      <a class="kpi" href="#/contracts"><div class="lbl">Contracted per month ${info('contracted_monthly')}</div><div class="val">${moneyShort(m.contracted.monthly_pence)}</div><div class="sub">${m.contracted.count} contract${m.contracted.count === 1 ? '' : 's'} · ex VAT · not cash</div></a>
      <a class="kpi" href="#/proposals"><div class="lbl">Quoted, awaiting reply ${info('open_pipeline_monthly')}</div><div class="val">${moneyShort(m.open_pipeline.monthly_pence)}<small class="muted" style="font-size:13px">/mo</small></div><div class="sub">${m.open_pipeline.count} proposal${m.open_pipeline.count === 1 ? '' : 's'}${m.open_pipeline.one_off_pence ? ` + ${moneyShort(m.open_pipeline.one_off_pence)} one-off` : ''}</div></a>
      <a class="kpi" href="#/customers"><div class="lbl">New leads ${info('leads_created')}</div><div class="val">${m.leads_created}</div><div class="sub">in the last ${dashRange} days</div></a>
      <a class="kpi ${m.tasks.overdue ? 'alertish' : ''}" href="#/tasks/overdue"><div class="lbl">Overdue tasks</div><div class="val">${m.tasks.overdue}</div><div class="sub">${m.tasks.open} open in total</div></a>
      <a class="kpi" href="#/contracts"><div class="lbl">Awaiting signature</div><div class="val">${L.signing.filter((k) => ['sent', 'partially_signed'].includes(k.status)).length}</div><div class="sub">${L.signing.filter((k) => k.status === 'signed').length} signed, to activate</div></a>
      <a class="kpi" href="#/tasks"><div class="lbl">Onboarding & quality</div><div class="val">${m.tasks.onboarding + m.tasks.quality}</div><div class="sub">${m.tasks.onboarding} onboarding · ${m.tasks.quality} follow-ups open</div></a>
    </div>
    <div class="card"><h2>Conversion — last ${dashRange} days</h2>
      <div class="funnel">
        ${[['Lead → site visit', m.lead_to_visit, 'lead_to_visit'], ['Site visit → proposal', m.visit_to_proposal, 'visit_to_proposal'], ['Proposal accepted', m.proposal_acceptance, 'proposal_acceptance']].map(([t, x, k]) =>
          `<div class="step"><span class="small muted">${t} ${info(k)}</span><b>${pctTxt(x)}</b><span class="small muted">${x.num} of ${x.den}</span><div class="bar"><i style="width:${x.pct || 0}%"></i></div></div>`).join('')}
      </div>
      <p class="small muted" style="margin:12px 0 0">Won ${m.won} · Lost ${m.lost} in the period.</p>
    </div>
    <div class="grid-2">
      ${listCard('Upcoming visits (14 days)', L.upcoming, (a) => [`<a href="#/customers/${a.contact_id}">${esc(a.business || '')}</a> <span class="muted small">${esc(a.title)}</span>`, `${fmtDT(a.starts_at)}`], 'Nothing booked.', '#/calendar')}
      ${listCard('Proposals awaiting a reply', L.awaiting, (p) => [`<a href="#/proposals/${p.id}">${esc(p.number)}</a> <span class="muted small">${esc(p.business)}</span>`, `${p.monthly_net_pence > 0 ? `${moneyShort(p.monthly_net_pence)}/mo · ` : ''}valid ${p.valid_until ? relDays(p.valid_until) : '—'}`], 'No proposals out.', '#/proposals')}
      ${listCard('Contracts in signing', L.signing, (k) => [`<a href="#/contracts/${k.id}">${esc(k.number)}</a> <span class="muted small">${esc(k.business)}</span>`, badge(k.status)], 'Nothing waiting.', '#/contracts')}
      ${listCard('Renewals in the next 90 days', L.renewals, (k) => [`<a href="#/contracts/${k.id}">${esc(k.number)}</a> <span class="muted small">${esc(k.business)}</span>`, `${fmtDate(k.renewal_date)} (${relDays(k.renewal_date)})`], 'No renewals coming up.', '#/contracts')}
      ${listCard('Overdue tasks', L.overdue, (t) => [`${t.contact_id ? `<a href="#/customers/${t.contact_id}">${esc(t.title)}</a>` : esc(t.title)} <span class="muted small">${esc(t.business || '')}</span>`, `<span style="color:var(--danger)">${relDays(t.due_at)}</span>`], 'Nothing overdue. Nice.', '#/tasks/overdue')}
      ${listCard(`Outreach drafts awaiting review (${drafts.length})`, drafts.slice(0, 8), (x) => [`<a href="#/drafts">${esc(x.business || '')}</a>`, `<span class="muted small">${esc((x.subject || '').slice(0, 40))}</span>`], 'Nothing waiting.', '#/drafts')}
    </div>`;
  el.querySelector('#dash-range').addEventListener('change', (e) => { dashRange = Number(e.target.value); renderDashboard(el); });
}
function listCard(title, rows, fn, emptyText, href) {
  return `<div class="card"><div class="card-head"><h2>${esc(title)}</h2>${href ? `<a class="btn-ghost btn-sm" href="${href}">View all</a>` : ''}</div>
    ${rows.length ? rows.map((r) => { const [a, b] = fn(r); return `<div class="list-row"><span>${a}</span><span class="dim">${b}</span></div>`; }).join('') : `<p class="muted" style="margin:0">${esc(emptyText)}</p>`}</div>`;
}

// ══════════════════════════════════════════════════════════
// CUSTOMERS
// ══════════════════════════════════════════════════════════
const custState = { q: '', stage: '', sort: '', archived: false, page: 0, size: 50 };
async function renderCustomers(el) {
  el.innerHTML = `<div class="page-head"><div><h1>Customers</h1><p>Every lead and customer. Click one for their full profile.</p></div>
    <div class="actions">${can('manager') ? '<button class="btn-secondary" id="c-import">Import CSV</button><a class="btn-secondary" href="/api/contacts.csv" download>Export CSV</a>' : ''}<button class="btn-primary" id="c-new">+ New customer</button></div></div>
    <div class="toolbar">
      <input type="search" id="c-q" placeholder="Search name, email, phone or address…" value="${esc(custState.q)}" aria-label="Search customers">
      <select id="c-stage" aria-label="Stage"><option value="">All stages</option>${STAGES.map(([v, l]) => `<option value="${v}" ${v === custState.stage ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select id="c-sort" aria-label="Sort"><option value="">Recently updated</option><option value="business" ${custState.sort === 'business' ? 'selected' : ''}>Name A–Z</option><option value="created" ${custState.sort === 'created' ? 'selected' : ''}>Newest first</option></select>
      <label class="check"><input type="checkbox" id="c-arch" ${custState.archived ? 'checked' : ''}> Archived</label>
    </div>
    <div class="card table-card"><div class="table-wrap"><table class="mobile-cards"><thead><tr><th>Business</th><th>Contact</th><th>Phone</th><th>Stage</th><th>Owner</th><th>Updated</th></tr></thead><tbody id="c-body"><tr><td colspan="6"><div class="skel"></div></td></tr></tbody></table></div><div class="pager" id="c-pager"></div></div>`;
  const load = async () => {
    const qs = new URLSearchParams({ limit: custState.size, offset: custState.page * custState.size, ...(custState.q && { q: custState.q }), ...(custState.stage && { stage: custState.stage }), ...(custState.sort && { sort: custState.sort }), ...(custState.archived && { archived: 1 }) });
    const res = await fetch(`/api/contacts?${qs}`, { headers: { 'X-FC-CSRF': '1' } });
    if (res.status === 401) { location.href = '/login'; return; }
    const rows = await res.json(), total = Number(res.headers.get('X-Total-Count') || rows.length);
    const body = el.querySelector('#c-body');
    body.innerHTML = rows.length ? rows.map((c) => `<tr class="click" data-id="${c.id}" tabindex="0">
      <td>${esc(c.business || '(no name)')}${c.trading_name ? `<span class="sub">t/a ${esc(c.trading_name)}</span>` : ''}</td>
      <td data-label="Contact">${esc(c.contact_name || '')}<span class="sub">${esc(c.email || '')}</span></td><td data-label="Phone">${esc(c.phone || '')}</td>
      <td>${pill(c.pipeline_stage)}</td><td data-label="Owner">${esc(USERS.find((u) => u.id === c.owner_id)?.name || '')}</td><td data-label="Updated" class="muted">${fmtDate(c.updated_at)}</td></tr>`).join('')
      : `<tr><td colspan="6">${empty(custState.q || custState.stage ? 'No customers match' : 'No customers yet', custState.q || custState.stage ? 'Try a different search or stage.' : 'Add your first customer to get started.')}</td></tr>`;
    const pages = Math.max(1, Math.ceil(total / custState.size));
    el.querySelector('#c-pager').innerHTML = `<span>${total.toLocaleString('en-GB')} customer${total === 1 ? '' : 's'}</span><span class="row">
      <button class="btn-secondary btn-sm" id="c-prev" ${custState.page ? '' : 'disabled'}>‹ Prev</button> Page ${custState.page + 1} of ${pages}
      <button class="btn-secondary btn-sm" id="c-next" ${custState.page + 1 < pages ? '' : 'disabled'}>Next ›</button></span>`;
    el.querySelector('#c-prev').onclick = () => { custState.page--; load(); };
    el.querySelector('#c-next').onclick = () => { custState.page++; load(); };
  };
  el.querySelector('#c-body').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) location.hash = `#/customers/${tr.dataset.id}`; });
  el.querySelector('#c-body').addEventListener('keydown', (e) => { const tr = e.target.closest('tr[data-id]'); if (tr && e.key === 'Enter') location.hash = `#/customers/${tr.dataset.id}`; });
  el.querySelector('#c-q').addEventListener('input', debounce((e) => { custState.q = e.target.value.trim(); custState.page = 0; load(); }, 250));
  el.querySelector('#c-stage').addEventListener('change', (e) => { custState.stage = e.target.value; custState.page = 0; load(); });
  el.querySelector('#c-sort').addEventListener('change', (e) => { custState.sort = e.target.value; load(); });
  el.querySelector('#c-arch').addEventListener('change', (e) => { custState.archived = e.target.checked; custState.page = 0; load(); });
  el.querySelector('#c-new').addEventListener('click', newCustomer);
  el.querySelector('#c-import')?.addEventListener('click', importCsv);
  await load();
}

const CUSTOMER_FIELDS = (c = {}) => `<div class="fields">
  ${field('Business name *', `<input name="business" value="${esc(c.business || '')}" required>`)}
  ${field('Trading name', `<input name="trading_name" value="${esc(c.trading_name || '')}">`)}
  ${field('Main contact', `<input name="contact_name" value="${esc(c.contact_name || '')}">`)}
  ${field('Email', `<input name="email" type="email" value="${esc(c.email || '')}">`)}
  ${field('Phone', `<input name="phone" type="tel" value="${esc(c.phone || '')}">`)}
  ${field('Website', `<input name="website" value="${esc(c.website || '')}">`)}
  <div class="wide">${field('Service address', `<input name="address" value="${esc(c.address || '')}">`)}</div>
  ${field('Type of premises', `<input name="premises_type" value="${esc(c.premises_type || '')}" placeholder="Restaurant, pub, office, bakery…">`)}
  ${field('Lead source', `<input name="source" value="${esc(c.source || '')}">`)}
</div>`;
async function newCustomer(prefill = {}) {
  let force = false;
  const created = await modal({ title: 'New customer', body: CUSTOMER_FIELDS(prefill) + '<div id="dups"></div>', submit: 'Create customer', onSubmit: async (form, fd) => {
    const body = Object.fromEntries(fd); if (force) body.force = true;
    try { return await api('/api/contacts', { method: 'POST', body: JSON.stringify(body) }); }
    catch (err) {
      if (err.status !== 409 || !err.data.duplicates) throw err;
      force = true;
      form.querySelector('#dups').innerHTML = `<div class="alert alert-warn"><b>Possible duplicate.</b> These look like the same business:<ul>${err.data.duplicates.map((d) => `<li><a href="#/customers/${d.id}" onclick="document.getElementById('modal').close()">${esc(d.business || d.contact_name)}</a> ${esc([d.email, d.phone].filter(Boolean).join(' · '))}${d.archived_at ? ' (archived)' : ''}</li>`).join('')}</ul>Press <b>Create customer</b> again to add it anyway.</div>`;
      return false;
    }
  } });
  if (created) { toast('Customer created'); location.hash = `#/customers/${created.id}`; }
}

async function importCsv() {
  let text = '';
  await modal({ title: 'Import customers from CSV', sub: 'Columns (header row): business, trading_name, contact_name, email, phone, address, billing_address, website, source, pipeline_stage, premises_type, company_number, vat_number, tags, notes. Rows that match an existing customer are skipped.',
    body: `${field('CSV file', '<input type="file" name="file" accept=".csv,text/csv" required>')}<div id="imp-res"></div>`, submit: 'Check file', onSubmit: async (form) => {
      const btn = form.querySelector('[value=ok]');
      if (!text) {
        const f = form.querySelector('[name=file]').files[0];
        if (!f) throw new Error('Choose a file.');
        text = await f.text();
      }
      const dry = btn.textContent === 'Check file';
      const r = await api(`/api/contacts/import${dry ? '?dry_run=1' : ''}`, { method: 'POST', body: text, headers: { 'Content-Type': 'text/csv' } });
      form.querySelector('#imp-res').innerHTML = `<div class="alert ${dry ? 'alert-info' : 'alert-ok'}">${dry ? 'Ready to import' : 'Imported'} <b>${r.created}</b> of ${r.total} rows.
        ${r.duplicates.length ? `<br>${r.duplicates.length} skipped as duplicates: ${r.duplicates.slice(0, 8).map((d) => `row ${d.row} (${esc(d.business || '')})`).join(', ')}${r.duplicates.length > 8 ? '…' : ''}` : ''}
        ${r.errors.length ? `<br>${r.errors.length} with errors: ${r.errors.slice(0, 5).map((e) => `row ${e.row}: ${esc(e.error)}`).join('; ')}` : ''}
        ${r.ignored_columns.length ? `<br>Ignored columns: ${esc(r.ignored_columns.join(', '))}` : ''}</div>`;
      if (dry && r.created) { btn.textContent = `Import ${r.created}`; return false; }
      if (!dry) { toast(`Imported ${r.created} customers`); route(); return true; }
      return false;
    } });
}

// ── customer profile ─────────────────────────────────────
async function renderCustomer(el, id, tab = 'overview') {
  const c = await api(`/api/contacts/${id}/profile`);
  setCrumbs([['Customers', '#/customers'], [c.business || c.contact_name || 'Customer']]);
  const active = c.contracts.find((k) => ['active', 'renewal_due', 'signed'].includes(k.status));
  const nextVisit = c.appointments.filter((a) => a.status === 'scheduled' && new Date(a.starts_at) > new Date()).sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))[0];
  const openTasks = c.tasks.filter((t) => !t.done);
  const tabs = [['overview', 'Overview'], ['people', 'People', c.people.length], ['sites', 'Sites', c.sites.filter((s) => !s.archived_at).length], ['proposals', 'Proposals', c.proposals.length], ['contracts', 'Contracts', c.contracts.length], ...(can('manager') ? [['invoices', 'Invoices', c.invoice_count]] : []), ['tasks', 'Tasks & visits', openTasks.length], ['documents', 'Documents', c.documents.length], ['timeline', 'Timeline']];
  el.innerHTML = `
    ${c.archived_at ? `<div class="alert alert-warn">This customer was archived on ${fmtDate(c.archived_at)}. <button class="btn-secondary btn-sm" id="p-restore">Restore</button></div>` : ''}
    <div class="profile-head"><div class="row" style="align-items:flex-start;flex-wrap:nowrap"><div class="avatar" aria-hidden="true">${esc((c.business || '?').trim()[0] || '?')}</div><div>
      <h1>${esc(c.business || c.contact_name || 'Customer')}</h1>
      <div class="meta">${c.contact_name ? `<span>${esc(c.contact_name)}</span>` : ''}${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : ''}${c.address ? `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.address)}" target="_blank" rel="noopener">${esc(c.address)}</a>` : ''}</div>
    </div></div>
    <div class="row"><select id="p-stage" aria-label="Pipeline stage">${STAGES.map(([v, l]) => `<option value="${v}" ${v === c.pipeline_stage ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button class="btn-primary" id="p-proposal">+ Proposal</button>
      <details class="menu"><summary class="btn-secondary">More ▾</summary><div class="menu-list">
        <button data-a="task">Add task</button><button data-a="visit">Book a visit</button><button data-a="note">Add note</button><button data-a="upload">Upload document</button><button data-a="quick">Quick view (drawer)</button>
        <hr>${c.archived_at ? '<button data-a="restore">Restore</button>' : '<button data-a="archive" class="danger">Archive customer</button>'}${can('admin') ? '<button data-a="delete" class="danger">Delete permanently…</button>' : ''}
      </div></details></div></div>
    <div class="kpis">
      <div class="kpi"><div class="lbl">Contract</div><div class="val" style="font-size:18px">${active ? `<a href="#/contracts/${active.id}">${esc(active.number)}</a>` : '—'}</div><div class="sub">${active ? `${badge(active.status)} ${money(active.monthly_net_pence)}/mo ex VAT` : 'No active contract'}</div></div>
      <div class="kpi"><div class="lbl">Renewal</div><div class="val" style="font-size:18px">${active?.renewal_date ? fmtDate(active.renewal_date) : '—'}</div><div class="sub">${active?.start_date ? `Started ${fmtDate(active.start_date)}` : ''}</div></div>
      <div class="kpi"><div class="lbl">Next visit</div><div class="val" style="font-size:18px">${nextVisit ? fmtDT(nextVisit.starts_at) : '—'}</div><div class="sub">${nextVisit ? esc(nextVisit.title) : ''}</div></div>
      <div class="kpi"><div class="lbl">Open tasks</div><div class="val" style="font-size:18px">${openTasks.length}</div><div class="sub">${openTasks.filter((t) => t.due_at && new Date(t.due_at) < new Date()).length} overdue</div></div>
    </div>
    <div class="tabbar" role="tablist">${tabs.map(([k, l, n]) => `<a href="#/customers/${c.id}/${k}" role="tab" aria-selected="${k === tab}" class="${k === tab ? 'on' : ''}">${l}${n ? `<span class="count">${n}</span>` : ''}</a>`).join('')}</div>
    <div id="p-tab"></div>`;
  const reload = () => renderCustomer(el, id, tab);
  el.querySelector('#p-stage').addEventListener('change', async (e) => {
    try { await api(`/api/contacts/${c.id}`, { method: 'PATCH', body: JSON.stringify({ pipeline_stage: e.target.value }) }); toast(`Stage → ${STAGE_LABEL[e.target.value]}`); } catch (err) { toast(err.message, 'error'); }
  });
  el.querySelector('#p-proposal').addEventListener('click', () => newProposal(c));
  el.querySelector('#p-restore')?.addEventListener('click', async () => { await api(`/api/contacts/${c.id}/restore`, { method: 'POST' }); toast('Restored'); reload(); });
  el.querySelector('.menu-list').addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    e.target.closest('details').open = false;
    if (a === 'task') { if (await newTask({ contact_id: c.id })) reload(); }
    if (a === 'visit') { if (await newVisit(c)) reload(); }
    if (a === 'note') { if (await addNote(c.id)) reload(); }
    if (a === 'upload') pickAndUpload({ contact_id: c.id }, reload);
    if (a === 'quick') { await loadContacts().catch(() => {}); openDrawer(c.id); }
    if (a === 'restore') { await api(`/api/contacts/${c.id}/restore`, { method: 'POST' }); toast('Restored'); reload(); }
    if (a === 'archive' && await confirmDialog({ title: 'Archive this customer?', body: 'They are hidden from lists and their sequences stop. Proposals, contracts and documents are kept and the customer can be restored.', confirmText: 'Archive', danger: true })) {
      await api(`/api/contacts/${c.id}`, { method: 'DELETE' }); toast('Customer archived'); reload();
    }
    if (a === 'delete' && await confirmDialog({ title: 'Delete permanently?', body: 'This removes the customer and their timeline for good. It is only allowed when they have no proposals, contracts or documents.', confirmText: 'Delete for good', danger: true })) {
      try { await api(`/api/contacts/${c.id}?permanent=1`, { method: 'DELETE' }); toast('Deleted'); location.hash = '#/customers'; } catch (err) { toast(err.message, 'error'); }
    }
  });
  const t = el.querySelector('#p-tab');
  const TABS = { overview: tabOverview, people: tabPeople, sites: tabSites, proposals: tabProposals, contracts: tabContracts, invoices: tabInvoices, tasks: tabTasks, documents: tabDocuments, timeline: tabTimeline };
  await (TABS[tab] || tabOverview)(t, c, reload);
}

function tabOverview(t, c, reload) {
  const ta = (n, v, rows = 3, ph = '') => `<textarea name="${n}" rows="${rows}" placeholder="${esc(ph)}">${esc(v || '')}</textarea>`;
  t.innerHTML = `<form class="card" id="ov-form" novalidate><div class="card-head"><h2>Customer details</h2><span class="dirty-dot" id="ov-dirty" hidden title="Unsaved changes"></span></div>
    ${CUSTOMER_FIELDS(c)}
    <div class="fields">
      ${field('Company registration no.', `<input name="company_number" value="${esc(c.company_number || '')}">`)}
      ${field('VAT number', `<input name="vat_number" value="${esc(c.vat_number || '')}">`)}
      ${field('Billing email', `<input name="billing_email" type="email" value="${esc(c.billing_email || '')}">`)}
      ${field('Sales owner', `<select name="owner_id">${userOptions(c.owner_id, 'No owner')}</select>`)}
      <div class="wide">${field('Billing / registered address', `<input name="billing_address" value="${esc(c.billing_address || '')}">`)}</div>
      ${field('Tags', `<input name="tags" value="${esc((c.tags || []).join(', '))}" placeholder="comma, separated">`)}
      ${field('Payment terms', `<input name="payment_terms" value="${esc(c.payment_terms || '')}" placeholder="e.g. 14 days from invoice">`)}
      <div class="wide">${field('Cleaning requirements', ta('requirements', c.requirements, 3, 'Areas, frequency, access times, special equipment…'))}</div>
      <div class="wide">${field('Communication preferences', ta('comm_prefs', c.comm_prefs, 2, 'e.g. email only, call after 3pm, no marketing'))}</div>
      <div class="wide">${field('Notes about the business', ta('notes', c.notes, 4))}</div>
    </div>
    <div class="row end"><button class="btn-primary" id="ov-save">Save changes</button></div></form>
    ${c.booking_token ? `<div class="card"><h2>Personal booking link</h2><p class="dim-p">Send this so they can pick a site-visit time (details prefilled).</p><div class="copy-row"><input id="ov-book" readonly value="${esc(`${BOOK_URL}?c=${c.booking_token}`)}"><button class="btn-secondary" data-copy="ov-book">Copy</button></div></div>` : ''}`;
  const form = t.querySelector('#ov-form');
  let dirty = false;
  form.addEventListener('input', () => { dirty = true; t.querySelector('#ov-dirty').hidden = false; });
  leaveGuard = () => !dirty;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await busy(t.querySelector('#ov-save'), async () => {
      const body = Object.fromEntries(new FormData(form));
      await api(`/api/contacts/${c.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      dirty = false; leaveGuard = null; toast('Saved'); reload();
    });
  });
}

function tabPeople(t, c, reload) {
  t.innerHTML = `<div class="card table-card"><div class="card-head" style="padding:16px 20px 0"><h2>People</h2><button class="btn-primary btn-sm" id="pp-add">+ Add person</button></div>
    <div class="table-wrap"><table class="mobile-cards"><thead><tr><th>Name</th><th>Job title</th><th>Email</th><th>Phone</th><th>Role</th><th></th></tr></thead><tbody>
    ${c.people.map((p) => `<tr><td>${esc(p.name)}</td><td data-label="Title">${esc(p.job_title || '')}</td><td data-label="Email">${p.email ? `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : ''}</td><td data-label="Phone">${esc(p.phone || '')}</td>
      <td>${p.is_primary ? '<span class="badge">Primary</span> ' : ''}${p.is_signer ? '<span class="badge b-normal">Signer</span>' : ''}</td>
      <td class="num"><button class="btn-ghost btn-sm" data-edit="${p.id}">Edit</button><button class="btn-ghost btn-sm" data-del="${p.id}">Remove</button></td></tr>`).join('') || `<tr><td colspan="6">${empty('No people yet', 'Add the people you deal with — one can be the contract signer.')}</td></tr>`}
    </tbody></table></div></div>`;
  const form = (p = {}) => `<div class="fields">${field('Name *', `<input name="name" required value="${esc(p.name || '')}">`)}${field('Job title', `<input name="job_title" value="${esc(p.job_title || '')}">`)}
    ${field('Email', `<input name="email" type="email" value="${esc(p.email || '')}">`)}${field('Phone', `<input name="phone" type="tel" value="${esc(p.phone || '')}">`)}</div>
    <label class="check"><input type="checkbox" name="is_primary" ${p.is_primary ? 'checked' : ''}> Primary contact</label>
    <label class="check"><input type="checkbox" name="is_signer" ${p.is_signer ? 'checked' : ''}> Can sign contracts</label>
    ${field('Notes', `<textarea name="notes" rows="2">${esc(p.notes || '')}</textarea>`)}`;
  const save = (p) => modal({ title: p ? 'Edit person' : 'Add person', body: form(p), onSubmit: async (f, fd) => {
    const body = { ...Object.fromEntries(fd), is_primary: fd.has('is_primary'), is_signer: fd.has('is_signer') };
    return api(p ? `/api/people/${p.id}` : `/api/contacts/${c.id}/people`, { method: p ? 'PATCH' : 'POST', body: JSON.stringify(body) });
  } }).then((r) => { if (r) { toast('Saved'); reload(); } });
  t.querySelector('#pp-add').onclick = () => save();
  t.addEventListener('click', async (e) => {
    const ed = e.target.dataset.edit, del = e.target.dataset.del;
    if (ed) save(c.people.find((p) => p.id === ed));
    if (del && await confirmDialog({ title: 'Remove this person?', confirmText: 'Remove', danger: true })) { await api(`/api/people/${del}`, { method: 'DELETE' }); toast('Removed'); reload(); }
  });
}

function tabSites(t, c, reload) {
  const live = c.sites.filter((s) => !s.archived_at);
  t.innerHTML = `<div class="card"><div class="card-head"><h2>Service locations</h2><button class="btn-primary btn-sm" id="st-add">+ Add site</button></div>
    ${live.map((s) => `<div class="list-row"><span><b>${esc(s.name)}</b><span class="sub muted">${esc(s.address)}</span>${s.access_notes ? `<span class="sub small muted">Access: ${esc(s.access_notes)}</span>` : ''}</span>
      <span><button class="btn-ghost btn-sm" data-edit="${s.id}">Edit</button><button class="btn-ghost btn-sm" data-del="${s.id}">Archive</button></span></div>`).join('') || empty('No sites yet', 'Add each address you clean for this customer.')}</div>`;
  const save = (s) => modal({ title: s ? 'Edit site' : 'Add site', body: `${field('Site name', `<input name="name" value="${esc(s?.name || '')}" placeholder="Main site">`)}${field('Address *', `<input name="address" required value="${esc(s?.address || '')}">`)}${field('Access notes', `<textarea name="access_notes" rows="3" placeholder="Keys, alarm codes (avoid writing codes here if possible), parking, opening times">${esc(s?.access_notes || '')}</textarea>`)}`,
    onSubmit: (f, fd) => api(s ? `/api/sites/${s.id}` : `/api/contacts/${c.id}/sites`, { method: s ? 'PATCH' : 'POST', body: JSON.stringify(Object.fromEntries(fd)) }) }).then((r) => { if (r) { toast('Saved'); reload(); } });
  t.querySelector('#st-add').onclick = () => save();
  t.addEventListener('click', async (e) => {
    if (e.target.dataset.edit) save(live.find((s) => s.id === e.target.dataset.edit));
    if (e.target.dataset.del && await confirmDialog({ title: 'Archive this site?', body: 'Existing proposals and contracts keep the address they were issued with.', confirmText: 'Archive' })) { await api(`/api/sites/${e.target.dataset.del}`, { method: 'DELETE' }); reload(); }
  });
}

function tabProposals(t, c) {
  t.innerHTML = `<div class="card table-card"><div class="card-head" style="padding:16px 20px 0"><h2>Proposals</h2><button class="btn-primary btn-sm" id="tp-new">+ New proposal</button></div>
    <div class="table-wrap"><table class="mobile-cards"><thead><tr><th>Reference</th><th>Status</th><th class="num">Monthly</th><th class="num">One-off</th><th>Valid until</th></tr></thead><tbody>
    ${c.proposals.map((p) => `<tr class="click" onclick="location.hash='#/proposals/${p.id}'"><td>${esc(p.number)} <span class="sub">v${p.issued_version || p.version}${p.archived_at ? ' · archived' : ''}</span></td><td>${badge(p.status)}</td><td class="num money" data-label="Monthly">${money(p.monthly_net_pence)}</td><td class="num money" data-label="One-off">${money(p.one_off_net_pence)}</td><td data-label="Valid until">${fmtDate(p.valid_until)}</td></tr>`).join('') || `<tr><td colspan="5">${empty('No proposals yet')}</td></tr>`}
    </tbody></table></div></div>`;
  t.querySelector('#tp-new').onclick = () => newProposal(c);
}
function tabContracts(t, c) {
  t.innerHTML = `<div class="card table-card"><h2>Contracts</h2><div class="table-wrap"><table class="mobile-cards"><thead><tr><th>Reference</th><th>Status</th><th class="num">Monthly</th><th>Start</th><th>Renewal</th></tr></thead><tbody>
    ${c.contracts.map((k) => `<tr class="click" onclick="location.hash='#/contracts/${k.id}'"><td>${esc(k.number)}</td><td>${badge(k.status)}</td><td class="num money" data-label="Monthly">${money(k.monthly_net_pence)}</td><td data-label="Start">${fmtDate(k.start_date)}</td><td data-label="Renewal">${fmtDate(k.renewal_date)}</td></tr>`).join('') || `<tr><td colspan="5">${empty('No contracts yet', 'Contracts are created from an accepted proposal.')}</td></tr>`}
    </tbody></table></div></div>`;
}
// same cards and buttons as Sales → Invoices, just this customer's
const tabInvoices = (t, c) => renderInvoices(t, c);
function tabTasks(t, c, reload) {
  const visits = [...c.appointments].sort((a, b) => new Date(b.starts_at) - new Date(a.starts_at));
  t.innerHTML = `<div class="grid-2"><div class="card" style="padding:0"><div class="card-head" style="padding:16px 20px 0"><h2>Tasks</h2><button class="btn-primary btn-sm" id="tt-add">+ Task</button></div><div id="tt-list"></div></div>
    <div class="card"><div class="card-head"><h2>Visits & appointments</h2><button class="btn-primary btn-sm" id="tt-visit">+ Visit</button></div>
      ${visits.map((a) => `<div class="list-row"><span><b>${esc(a.title)}</b> ${a.status !== 'scheduled' ? badge(a.status) : ''}<span class="sub muted">${esc(label(a.kind))}${a.notes ? ` · ${esc(a.notes)}` : ''}</span></span><span class="dim">${fmtDT(a.starts_at)}</span></div>`).join('') || empty('No visits yet')}</div></div>`;
  renderTaskList(t.querySelector('#tt-list'), c.tasks, reload);
  t.querySelector('#tt-add').onclick = async () => { if (await newTask({ contact_id: c.id })) reload(); };
  t.querySelector('#tt-visit').onclick = async () => { if (await newVisit(c)) reload(); };
}
function tabDocuments(t, c, reload) {
  t.innerHTML = `<div class="card table-card"><div class="card-head" style="padding:16px 20px 0"><h2>Documents</h2><button class="btn-primary btn-sm" id="td-up">Upload</button></div>${docTable(c.documents, true)}</div>`;
  t.querySelector('#td-up').onclick = () => pickAndUpload({ contact_id: c.id }, reload);
  wireDocTable(t, reload);
}
async function tabTimeline(t, c, reload) {
  const events = await api(`/api/contacts/${c.id}/events`);
  t.innerHTML = `<div class="card"><div class="card-head"><h2>Activity</h2><button class="btn-primary btn-sm" id="tl-note">+ Note</button></div>
    <ul class="timeline">${events.map((e) => `<li class="t-${esc(e.type)}"><div>${e.type === 'stage_change' ? `Stage → <b>${esc(STAGE_LABEL[e.body] || e.body)}</b>` : `${e.type === 'note' ? '<b>Note:</b> ' : ''}${esc(e.body || label(e.type))}`}</div><div class="when">${fmtDT(e.at)} · ${esc(label(e.type))}</div></li>`).join('') || '<li>No activity yet.</li>'}</ul></div>`;
  t.querySelector('#tl-note').onclick = async () => { if (await addNote(c.id)) reload(); };
}
const addNote = (contactId) => modal({ title: 'Add note', body: field('Note', '<textarea name="body" rows="5" required></textarea>'),
  onSubmit: (f, fd) => api(`/api/contacts/${contactId}/notes`, { method: 'POST', body: JSON.stringify({ body: fd.get('body') }) }) }).then((r) => { if (r) toast('Note added'); return r; });
function newVisit(c) {
  const d = new Date(Date.now() + 86400000); d.setHours(10, 0, 0, 0);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  return modal({ title: `Book a visit — ${c.business || ''}`, body: `<div class="fields">${field('Type', `<select name="kind"><option value="site_visit">Site visit</option><option value="quality_check">Quality check</option><option value="meeting">Meeting</option><option value="other">Other</option></select>`)}
    ${field('Title *', '<input name="title" value="Site visit" required>')}${field('Starts *', `<input type="datetime-local" name="starts_at" value="${local}" required>`)}${field('Duration (min)', '<input type="number" name="mins" value="45" min="5" step="5">')}
    ${field('Assigned to', `<select name="assigned_to">${userOptions(ME?.id)}</select>`)}</div>${field('Notes', '<textarea name="notes" rows="2"></textarea>')}
    <p class="small muted">This adds it to the CRM calendar only — the customer isn’t emailed. Use their booking link to let them pick a time themselves.</p>`,
  onSubmit: (f, fd) => { const s = new Date(fd.get('starts_at')); return api(`/api/contacts/${c.id}/appointments`, { method: 'POST', body: JSON.stringify({ kind: fd.get('kind'), title: fd.get('title'), starts_at: s.toISOString(), ends_at: new Date(s.getTime() + Number(fd.get('mins') || 45) * 60000).toISOString(), notes: fd.get('notes'), assigned_to: fd.get('assigned_to') }) }); } })
    .then((r) => { if (r) toast('Visit booked'); return r; });
}

// ══════════════════════════════════════════════════════════
// TASKS
// ══════════════════════════════════════════════════════════
const TASK_VIEWS = [['mine', 'My tasks'], ['open', 'All open'], ['overdue', 'Overdue'], ['today', 'Today'], ['upcoming', 'Upcoming'], ['done', 'Done'], ['visits', 'Visits']];
async function renderTasks(el, view = 'mine') {
  if (!TASK_VIEWS.some(([k]) => k === view)) view = 'mine';
  const kind = ['follow_up', 'onboarding', 'quality', 'renewal', 'task', 'internal'].find((k) => k === new URLSearchParams(location.hash.split('?')[1] || '').get('kind')) || '';
  el.innerHTML = `<div class="page-head"><div><h1>Tasks</h1><p>Follow-ups, onboarding checklists, quality checks and renewals — yours and the team’s.</p></div>
    <div class="actions"><button class="btn-primary" id="t-new">+ New task</button></div></div>
    <div class="tabbar" role="tablist">${TASK_VIEWS.map(([k, l]) => `<a href="#/tasks/${k}" role="tab" aria-selected="${k === view}" class="${k === view ? 'on' : ''}">${l}</a>`).join('')}</div>
    ${view === 'visits' ? '' : `<div class="toolbar"><select id="t-kind" aria-label="Kind"><option value="">All kinds</option>${['follow_up', 'onboarding', 'quality', 'renewal', 'task', 'internal'].map((k) => `<option value="${k}" ${k === kind ? 'selected' : ''}>${label(k)}</option>`).join('')}</select></div>`}
    <div class="card" style="padding:0" id="t-list">${skeleton(5)}</div>`;
  el.querySelector('#t-new').onclick = async () => { if (await newTask()) renderTasks(el, view); };
  el.querySelector('#t-kind')?.addEventListener('change', (e) => { history.replaceState(null, '', `#/tasks/${view}${e.target.value ? `?kind=${e.target.value}` : ''}`); renderTasks(el, view); });
  const list = el.querySelector('#t-list');
  if (view === 'visits') {
    const appts = await api(`/api/appointments?from=${new Date(Date.now() - 86400000).toISOString()}&to=${new Date(Date.now() + 60 * 86400000).toISOString()}`);
    list.innerHTML = appts.length ? appts.map((a) => `<div class="task-row"><span></span><div><div class="t-title">${esc(a.title)} — <a href="#/customers/${a.contact_id}">${esc(a.business || a.contact_name || '')}</a></div><div class="t-meta"><span>${esc(label(a.kind))}</span>${a.address ? `<span>${esc(a.address)}</span>` : ''}${a.assigned_name ? `<span>${esc(a.assigned_name)}</span>` : ''}</div></div><span class="muted small">${fmtDT(a.starts_at)}</span></div>`).join('')
      : empty('No visits in the next 60 days', 'Book visits from a customer’s profile or the Calendar.');
    return;
  }
  const tasks = await api(`/api/tasks?view=${view}${kind ? `&kind=${kind}` : ''}`);
  renderTaskList(list, tasks, () => renderTasks(el, view));
}
function renderTaskList(box, tasks, reload) {
  if (!tasks.length) { box.innerHTML = empty('Nothing here', 'Tasks you add, and ones the automations create, show up here.'); return; }
  box.innerHTML = tasks.map((t) => {
    const overdue = !t.done && t.due_at && new Date(t.due_at) < new Date(new Date().toDateString());
    return `<div class="task-row ${t.done ? 'done' : ''}" data-id="${t.id}"><input type="checkbox" ${t.done ? 'checked' : ''} aria-label="Done: ${esc(t.title)}">
      <div><div class="t-title">${esc(t.title)}</div><div class="t-meta">
        ${t.due_at ? `<span class="${overdue ? 'overdue' : ''}">Due ${fmtDate(t.due_at)} (${relDays(t.due_at)})</span>` : '<span>No due date</span>'}
        ${t.priority === 'high' ? badge('high') : ''}${t.kind && t.kind !== 'task' ? `<span>${esc(label(t.kind))}</span>` : ''}
        ${t.business ? `<a href="#/customers/${t.contact_id}">${esc(t.business)}</a>` : ''}${t.contract_number ? `<a href="#/contracts/${t.contract_id}">${esc(t.contract_number)}</a>` : ''}${t.proposal_number ? `<a href="#/proposals/${t.proposal_id}">${esc(t.proposal_number)}</a>` : ''}
        ${t.assigned_name ? `<span>→ ${esc(t.assigned_name)}</span>` : ''}${t.recur_days ? `<span>repeats every ${t.recur_days}d</span>` : ''}
      </div>${t.notes ? `<div class="small muted">${esc(t.notes)}</div>` : ''}</div>
      <span><button class="btn-ghost btn-sm" data-edit="${t.id}">Edit</button></span></div>`;
  }).join('');
  box.onchange = async (e) => {
    const row = e.target.closest('.task-row');
    if (!row || e.target.type !== 'checkbox') return;
    try { await api(`/api/tasks/${row.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ done: e.target.checked }) }); row.classList.toggle('done', e.target.checked); toast(e.target.checked ? 'Task done' : 'Task reopened'); refreshNavCount(); }
    catch (err) { e.target.checked = !e.target.checked; toast(err.message, 'error'); }
  };
  box.onclick = async (e) => { const id = e.target.dataset.edit; if (id && await newTask(tasks.find((t) => t.id === id))) reload(); };
}
function newTask(t = {}) {
  const editing = !!t.id;
  const due = t.due_at ? isoDay(t.due_at) : isoDay(Date.now() + 86400000);
  return modal({ title: editing ? 'Edit task' : 'New task', body: `${field('Task *', `<input name="title" required value="${esc(t.title || '')}">`)}
    <div class="fields">${field('Due', `<input type="date" name="due" value="${due}">`)}${field('Priority', `<select name="priority">${['low', 'normal', 'high'].map((p) => `<option ${p === (t.priority || 'normal') ? 'selected' : ''}>${p}</option>`).join('')}</select>`)}
    ${field('Assigned to', `<select name="assigned_to">${userOptions(editing ? t.assigned_to : ME?.id, 'Team (unassigned)')}</select>`)}${field('Repeat every (days)', `<input type="number" name="recur_days" min="1" max="366" value="${t.recur_days || ''}" placeholder="No repeat">`)}</div>
    ${t.contact_id || editing ? '' : field('Customer (optional)', '<input name="customer" list="cust-list" placeholder="Start typing a business…"><datalist id="cust-list"></datalist>')}
    ${field('Notes', `<textarea name="notes" rows="2">${esc(t.notes || '')}</textarea>`)}
    ${editing ? '<label class="check"><input type="checkbox" name="delete"> Delete this task</label>' : ''}`,
  onSubmit: async (f, fd) => {
    if (fd.get('delete')) { await api(`/api/tasks/${t.id}`, { method: 'DELETE' }); return true; }
    const body = { title: fd.get('title'), due_at: fd.get('due') ? new Date(`${fd.get('due')}T09:00`).toISOString() : null, priority: fd.get('priority'), assigned_to: fd.get('assigned_to') || null, recur_days: fd.get('recur_days') || null, notes: fd.get('notes') };
    if (!editing) { body.contact_id = t.contact_id || custIdFromList(f, fd.get('customer')) || null; return api('/api/tasks', { method: 'POST', body: JSON.stringify(body) }); }
    return api(`/api/tasks/${t.id}`, { method: 'PATCH', body: JSON.stringify(body) });
  } }).then((r) => { if (r) { toast('Saved'); refreshNavCount(); } return r; });
}
// customer picker: <input list> filled as you type. Every suggestion ever shown is remembered
// (label → id), so choosing one never depends on the latest search — picking a suggestion
// fires another input event whose search (for the full "Name — email" text) finds nothing.
const custLabel = (c) => `${c.business || c.contact_name}${c.email ? ` — ${c.email}` : ''}`;
const custSeen = new Map();
document.addEventListener('input', debounce(async (e) => {
  if (e.target.getAttribute?.('list') !== 'cust-list') return;
  const q = e.target.value.trim();
  if (q.length < 2 || custSeen.has(q)) return;
  const rows = await api(`/api/contacts?q=${encodeURIComponent(q)}&limit=15`).catch(() => []);
  if (!rows.length) return; // keep the current suggestions
  for (const c of rows) custSeen.set(custLabel(c), c.id);
  const list = document.getElementById('cust-list');
  if (list) list.innerHTML = rows.map((c) => `<option value="${esc(custLabel(c))}">`).join('');
}, 200));
// exact label, or a unique business-name match if the suggestion wasn't tapped
function custIdFromList(f, text) {
  const t = String(text || '').trim();
  if (custSeen.has(t)) return custSeen.get(t);
  const hits = [...custSeen].filter(([l]) => l.toLowerCase().startsWith(t.toLowerCase()) && t.length >= 3);
  return new Set(hits.map(([, id]) => id)).size === 1 ? hits[0][1] : null;
}
async function refreshNavCount() {
  const n = (await api('/api/tasks?view=overdue').catch(() => [])).length;
  const b = document.getElementById('nav-overdue');
  b.hidden = !n; b.textContent = n; b.title = `${n} overdue task${n === 1 ? '' : 's'}`;
}

// ══════════════════════════════════════════════════════════
// DOCUMENTS
// ══════════════════════════════════════════════════════════
function docTable(docs, compact = false) {
  if (!docs.length) return empty('No documents', 'Issued proposals, contracts, signed PDFs and uploads appear here.');
  return `<div class="table-wrap"><table class="mobile-cards"><thead><tr><th>Document</th><th>Type</th>${compact ? '' : '<th>Customer</th>'}<th>Added</th><th class="num">Size</th><th></th></tr></thead><tbody>
    ${docs.map((d) => `<tr><td>${esc(d.title)}<span class="sub">${esc(d.filename)}</span></td><td>${badge(d.kind)}</td>${compact ? '' : `<td data-label="Customer">${d.contact_id ? `<a href="#/customers/${d.contact_id}">${esc(d.business || '')}</a>` : ''}</td>`}
      <td data-label="Added" class="muted">${fmtDate(d.created_at)}${d.created_by_name ? `<span class="sub">${esc(d.created_by_name)}</span>` : ''}</td><td class="num muted" data-label="Size">${d.size > 1048576 ? `${(d.size / 1048576).toFixed(1)} MB` : `${Math.ceil(d.size / 1024)} KB`}</td>
      <td class="num"><button class="btn-ghost btn-sm" data-view-doc="${d.id}" data-mime="${esc(d.mime || '')}" data-title="${esc(d.title)}">View</button><a class="btn-ghost btn-sm" href="/api/documents/${d.id}/file?download=1">Download</a>${d.kind === 'upload' && can('manager') ? `<button class="btn-ghost btn-sm" data-rm-doc="${d.id}">Remove</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div>`;
}
function wireDocTable(box, reload) {
  box.addEventListener('click', async (e) => {
    const v = e.target.dataset.viewDoc, rm = e.target.dataset.rmDoc;
    if (v) { if (/pdf|image/.test(e.target.dataset.mime) || !e.target.dataset.mime) previewPdf(`/api/documents/${v}/file`, e.target.dataset.title); else location.href = `/api/documents/${v}/file?download=1`; }
    if (rm && await confirmDialog({ title: 'Remove this file?', body: 'Uploaded files can be removed; the action is logged.', confirmText: 'Remove', danger: true })) {
      try { await api(`/api/documents/${rm}`, { method: 'DELETE' }); toast('Removed'); reload(); } catch (err) { toast(err.message, 'error'); }
    }
  });
}
async function renderDocuments(el) {
  el.innerHTML = `<div class="page-head"><div><h1>Documents</h1><p>Every issued proposal and contract, signed agreements, signing audit trails and uploaded files.${can('manager') ? '' : ' Contracts and signed documents are visible to managers.'}</p></div></div>
    <div class="toolbar"><input type="search" id="d-q" placeholder="Search title, file or customer…" aria-label="Search documents">
      <select id="d-kind" aria-label="Type"><option value="">All types</option>${['proposal_pdf', 'contract_pdf', 'signed_pdf', 'audit_trail', 'upload'].map((k) => `<option value="${k}">${label(k)}</option>`).join('')}</select></div>
    <div class="card table-card" id="d-list">${skeleton()}</div>`;
  const load = async () => {
    const q = el.querySelector('#d-q').value.trim(), kind = el.querySelector('#d-kind').value;
    el.querySelector('#d-list').innerHTML = docTable(await api(`/api/documents?${new URLSearchParams({ ...(q && { q }), ...(kind && { kind }) })}`));
  };
  el.querySelector('#d-q').addEventListener('input', debounce(load, 250));
  el.querySelector('#d-kind').addEventListener('change', load);
  wireDocTable(el.querySelector('#d-list'), load);
  await load();
}

// ══════════════════════════════════════════════════════════
// REPORTS
// ══════════════════════════════════════════════════════════
async function renderReports(el) {
  const p = new URLSearchParams(location.hash.split('?')[1] || '');
  const okDate = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(x || '') ? x : null); // values come from the URL: validate before use
  const from = okDate(p.get('from')) || isoDay(Date.now() - 90 * 86400000), to = okDate(p.get('to')) || isoDay();
  const r = await api(`/api/reports?${new URLSearchParams({ from, to })}`);
  const m = r.metrics, d = r.definitions;
  const totalStage = Object.values(m.stages).reduce((a, b) => a + b, 0) || 1;
  const metric = (title, value, key, sub = '') => `<div class="kpi"><div class="lbl">${title}</div><div class="val">${value}</div><div class="sub">${esc(d[key] || '')}${sub ? ` ${sub}` : ''}</div></div>`;
  el.innerHTML = `<div class="page-head"><div><h1>Reports</h1><p>Measured from the live database. Every figure says exactly what it counts.</p></div>
    <form class="actions" id="r-form"><label class="sr-only" for="r-from">From</label><input type="date" id="r-from" value="${esc(from)}"><label class="sr-only" for="r-to">To</label><input type="date" id="r-to" value="${esc(to)}"><button class="btn-primary">Apply</button>${can('manager') ? `<a class="btn-secondary" href="/api/reports.csv?${esc(new URLSearchParams({ from, to }).toString())}">Export CSV</a>` : ''}</form></div>
    <h2 style="font-size:15px;margin:0 0 10px">Sales (${fmtDate(from)} – ${fmtDate(to)})</h2>
    <div class="kpis">
      ${metric('Leads created', m.leads_created, 'leads_created')}
      ${metric('Lead → visit', m.lead_to_visit.pct == null ? '—' : `${m.lead_to_visit.pct}%`, 'lead_to_visit', `(${m.lead_to_visit.num}/${m.lead_to_visit.den})`)}
      ${metric('Visit → proposal', m.visit_to_proposal.pct == null ? '—' : `${m.visit_to_proposal.pct}%`, 'visit_to_proposal', `(${m.visit_to_proposal.num}/${m.visit_to_proposal.den})`)}
      ${metric('Proposal acceptance', m.proposal_acceptance.pct == null ? '—' : `${m.proposal_acceptance.pct}%`, 'proposal_acceptance', `(${m.proposal_acceptance.num}/${m.proposal_acceptance.den}; ${m.proposal_acceptance.sent} sent)`)}
      ${metric('Won', m.won, 'won')}${metric('Lost', m.lost, 'lost')}
    </div>
    <h2 style="font-size:15px;margin:6px 0 10px">Money — quoted vs contracted (all ex VAT)</h2>
    <div class="kpis">
      ${metric('Quoted, awaiting reply (monthly)', money(m.open_pipeline.monthly_pence), 'open_pipeline_monthly')}
      ${metric('Quoted, awaiting reply (one-off)', money(m.open_pipeline.one_off_pence), 'open_pipeline_one_off')}
      ${metric('Contracted recurring (monthly)', money(m.contracted.monthly_pence), 'contracted_monthly')}
      ${metric('Contracted recurring (annual)', money(m.contracted.annual_pence), 'contracted_annual')}
      ${metric('One-off work signed in period', money(m.contracted.one_off_period_pence), 'contracted_one_off_period')}
      ${metric('Cash collected', 'Not tracked', 'cash_collected')}
    </div>
    <div class="grid-2">
      <div class="card"><h2>Customers by stage (now)</h2>${STAGES.map(([k, l]) => `<div class="list-row"><span>${pill(k)}</span><span style="flex:1;margin:0 12px"><span class="bar"><i style="width:${((m.stages[k] || 0) / totalStage) * 100}%"></i></span></span><b>${m.stages[k] || 0}</b></div>`).join('')}</div>
      <div class="card"><h2>Lead sources (period)</h2>${m.sources.map((s) => `<div class="list-row"><span>${esc(s.source)}</span><b>${s.n}</b></div>`).join('') || '<p class="muted">No leads in this period.</p>'}</div>
      ${listCard('Proposals awaiting a reply', r.lists.awaiting, (x) => [`<a href="#/proposals/${x.id}">${esc(x.number)}</a> <span class="muted small">${esc(x.business)}</span>`, `${money(x.monthly_net_pence)}/mo`], 'None.', '#/proposals')}
      ${listCard('Renewals (next 90 days)', r.lists.renewals, (k) => [`<a href="#/contracts/${k.id}">${esc(k.number)}</a> <span class="muted small">${esc(k.business)}</span>`, fmtDate(k.renewal_date)], 'None.', '#/contracts')}
    </div>
    <div class="card"><h2>Operations</h2><div class="kpis" style="margin:0">
      <div class="kpi"><div class="lbl">Open tasks</div><div class="val">${m.tasks.open}</div></div><div class="kpi ${m.tasks.overdue ? 'alertish' : ''}"><div class="lbl">Overdue</div><div class="val">${m.tasks.overdue}</div></div>
      <div class="kpi"><div class="lbl">Onboarding steps open</div><div class="val">${m.tasks.onboarding}</div></div><div class="kpi"><div class="lbl">Quality follow-ups open</div><div class="val">${m.tasks.quality}</div></div></div></div>`;
  el.querySelector('#r-form').addEventListener('submit', (e) => { e.preventDefault(); location.hash = `#/reports?from=${el.querySelector('#r-from').value}&to=${el.querySelector('#r-to').value}`; });
}

// ══════════════════════════════════════════════════════════
// SHARED EDITORS: priced lines, sections, key/value rows
// ══════════════════════════════════════════════════════════
let LIBRARY = null;
const getLibrary = async (fresh = false) => (LIBRARY && !fresh ? LIBRARY : (LIBRARY = await api('/api/library')));
const FREQ = [['one_off', 'One-off'], ['weekly', 'Weekly (price per visit)'], ['monthly', 'Monthly (price per month)']];

/** Editable priced lines. state.data.lines is mutated in place; onChange() after each edit. */
function linesEditor(box, state, { readonly, onChange }) {
  const lines = state.data.lines;
  const dis = readonly ? 'disabled' : '';
  const money = (k, l, lbl) => field(lbl, `<div class="input-money"><input inputmode="decimal" data-k="${k}" value="${fromPence(l[k])}" ${dis} aria-label="${lbl}"></div>`);
  box.innerHTML = lines.map((l, i) => {
    const hourly = l.billing === 'hourly', oneOff = l.frequency === 'one_off';
    return `<div class="line-card ${l.optional ? 'optional' : ''}" data-i="${i}">
      <div class="line-head"><input class="l-name" data-k="name" value="${esc(l.name)}" placeholder="Service name" ${dis} aria-label="Service name">
        ${readonly ? '' : `<button type="button" class="icon-btn" data-act="up" title="Move up" aria-label="Move up">↑</button><button type="button" class="icon-btn" data-act="down" title="Move down" aria-label="Move down">↓</button><button type="button" class="icon-btn danger" data-act="rm" title="Remove" aria-label="Remove line">✕</button>`}</div>
      <div class="line-grid">
        ${field('Billed', `<select data-k="billing" ${dis}><option value="fixed" ${!hourly ? 'selected' : ''}>Fixed price</option><option value="hourly" ${hourly ? 'selected' : ''}>Hourly rate</option></select>`)}
        ${field('Frequency', `<select data-k="frequency" ${dis}>${FREQ.map(([v, t]) => `<option value="${v}" ${v === l.frequency ? 'selected' : ''}>${t}</option>`).join('')}</select>`)}
        ${oneOff ? '' : field('Visits / week', `<input type="number" step="0.5" min="0" data-k="visits_per_week" value="${esc(l.visits_per_week ?? '')}" ${dis}>`)}
        ${field('Hours / visit', `<input type="number" step="0.25" min="0" data-k="hours_per_visit" value="${esc(l.hours_per_visit ?? '')}" ${dis}>`)}
        ${field('Staff', `<input type="number" min="1" step="1" data-k="staff" value="${esc(l.staff ?? '')}" ${dis}>`)}
        ${hourly ? money('rate_pence', l, 'Rate / labour-hour') : money('price_pence', l, oneOff ? 'Price' : l.frequency === 'weekly' ? 'Price per visit' : 'Price per month')}
        ${field('Discount', `<select data-k="discount_type" ${dis}><option value="none">None</option><option value="percent" ${l.discount_type === 'percent' ? 'selected' : ''}>%</option><option value="amount" ${l.discount_type === 'amount' ? 'selected' : ''}>£ amount</option></select>`)}
        ${l.discount_type === 'percent' ? field('Discount %', `<input type="number" step="0.01" min="0" max="100" data-k="discount_pct" value="${l.discount_value ? l.discount_value / 100 : ''}" ${dis}>`) : ''}
        ${l.discount_type === 'amount' ? money('discount_value', l, oneOff ? 'Discount £' : 'Discount £/month') : ''}
      </div>
      <label class="check" style="margin-top:10px"><input type="checkbox" data-k="optional" ${l.optional ? 'checked' : ''} ${dis}> Optional extra (priced, not in the totals)</label>
      <div class="fields" style="margin-top:10px">
        ${field('Days & times', `<input data-k="schedule" value="${esc(l.schedule || '')}" placeholder="e.g. Mon–Sun after 4:00 pm" ${dis}>`)}
        ${field('Price notes', `<input data-k="notes" value="${esc(l.notes || '')}" placeholder="e.g. 50% deposit before scheduling" ${dis}>`)}
        <div class="wide">${field('Scope of work', `<textarea data-k="scope" rows="${Math.min(12, Math.max(3, (l.scope || '').split('\n').length + 1))}" ${dis} placeholder="- one duty per line\n### Area heading">${esc(l.scope || '')}</textarea>`, '“- ” bullet · “### ” area heading · blank line = new paragraph')}</div>
      </div>
      <div class="line-price" data-price="${esc(l.id)}"></div></div>`;
  }).join('') || empty('No services yet', 'Add a service from your templates, or a blank line.');
  if (readonly) return;
  box.oninput = (e) => {
    const card = e.target.closest('.line-card'), k = e.target.dataset.k;
    if (!card || !k) return;
    const l = lines[card.dataset.i];
    let v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (['rate_pence', 'price_pence', 'discount_value'].includes(k)) { v = toPence(v); e.target.setAttribute('aria-invalid', Number.isNaN(v)); if (Number.isNaN(v)) return; }
    if (k === 'discount_pct') { l.discount_value = v === '' ? 0 : Math.round(Number(v) * 100); }
    else l[k] = v;
    if (k === 'optional') card.classList.toggle('optional', v);
    onChange(['billing', 'frequency', 'discount_type'].includes(k));
  };
  box.onclick = (e) => {
    const act = e.target.dataset.act, card = e.target.closest('.line-card');
    if (!act || !card) return;
    const i = Number(card.dataset.i);
    if (act === 'rm') lines.splice(i, 1);
    if (act === 'up' && i > 0) [lines[i - 1], lines[i]] = [lines[i], lines[i - 1]];
    if (act === 'down' && i < lines.length - 1) [lines[i + 1], lines[i]] = [lines[i], lines[i + 1]];
    onChange(true);
  };
}
const newLineId = () => `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const num = (v) => (v == null || v === '' ? '' : Number(v));
const lineFromTemplate = (s) => ({ id: newLineId(), name: s.name, billing: s.billing, frequency: s.frequency, visits_per_week: num(s.visits_per_week), hours_per_visit: num(s.hours_per_visit), staff: s.staff ?? '', rate_pence: s.rate_pence ?? '', price_pence: s.price_pence ?? '', discount_type: 'none', discount_value: 0, optional: false, scope: s.scope || '', schedule: '', notes: '' });

/** Shows server-computed prices under each line and in the totals box. */
function showPricing(root, priced, err) {
  const tot = root.querySelector('[data-totals]');
  if (err) { tot.innerHTML = `<div class="alert alert-warn">${esc(err)}</div>`; return; }
  if (!priced) return;
  for (const l of priced.lines) {
    const el = root.querySelector(`[data-price="${CSS.escape(l.id)}"]`);
    if (!el) continue;
    const p = l.price;
    el.innerHTML = p.one_off ? `One-off <b>${money(p.one_off)}</b> ex VAT${p.discount ? ` (after ${money(p.discount)} discount)` : ''}`
      : `${p.per_visit != null ? `Per visit <b>${money(p.per_visit)}</b> · ` : ''}${p.weekly != null ? `Weekly <b>${money(p.weekly)}</b> · ` : ''}Monthly <b>${money(p.monthly)}</b> · Annual <b>${money(p.annual)}</b> ex VAT${p.discount ? ` (after ${money(p.discount)}/mo discount)` : ''}`;
  }
  const t = priced.totals, vat = `${(t.vat_rate_bp / 100).toLocaleString('en-GB')}%`;
  const mt = root.querySelector('[data-mtotal]');
  if (mt) mt.innerHTML = `<b>${t.monthly_net ? `${money(t.monthly_net)}/mo` : money(t.one_off_net)}</b>${t.monthly_net && t.one_off_net ? `+ ${money(t.one_off_net)} one-off · ` : ''}ex VAT`;
  tot.innerHTML = `<table class="totals"><tbody>
    <tr><td>Recurring / month</td><td>${money(t.monthly_net)}</td></tr><tr><td class="muted">VAT ${vat}</td><td class="muted">${money(t.monthly_vat)}</td></tr><tr class="strong"><td>Per month inc VAT</td><td>${money(t.monthly_gross)}</td></tr>
    <tr class="gap"><td>One-off</td><td>${money(t.one_off_net)}</td></tr><tr><td class="muted">VAT ${vat}</td><td class="muted">${money(t.one_off_vat)}</td></tr><tr class="strong"><td>One-off inc VAT</td><td>${money(t.one_off_gross)}</td></tr>
    <tr class="gap"><td>Annual recurring (ex VAT)</td><td>${money(t.annual_net)}</td></tr><tr><td>First-year value (ex VAT)</td><td>${money(t.first_year_net)}</td></tr>
    ${t.optional_monthly_net || t.optional_one_off_net ? `<tr class="gap"><td class="muted">Optional extras</td><td class="muted">${t.optional_monthly_net ? `${money(t.optional_monthly_net)}/mo ` : ''}${t.optional_one_off_net ? money(t.optional_one_off_net) : ''}</td></tr>` : ''}
    </tbody></table>${priced.assumptions?.length ? `<details style="margin-top:10px"><summary class="small">Pricing assumptions (${priced.assumptions.length})</summary><ul class="small muted">${priced.assumptions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></details>` : ''}
    <p class="small muted" style="margin:8px 0 0">Calculated on the server in whole pence.</p>`;
}

function sectionsEditor(box, state, { readonly, onChange }) {
  const secs = state.data.sections, dis = readonly ? 'disabled' : '';
  box.innerHTML = secs.map((s, i) => `<div class="sec-card ${s.enabled ? '' : 'off'}" data-i="${i}">
    <div class="sec-head"><input type="checkbox" data-k="enabled" ${s.enabled ? 'checked' : ''} ${dis || (s.required ? 'disabled' : '')} title="${s.required ? 'Required section' : 'Include this section'}" aria-label="Include section">
      <input type="text" data-k="title" value="${esc(s.title)}" ${dis} aria-label="Section title">
      ${readonly ? '' : `<button type="button" class="icon-btn" data-act="up" aria-label="Move up">↑</button><button type="button" class="icon-btn" data-act="down" aria-label="Move down">↓</button>${!s.required ? '<button type="button" class="icon-btn danger" data-act="rm" aria-label="Remove section">✕</button>' : ''}`}</div>
    ${s.generated ? '<div class="gen-note">Filled in automatically from the services, schedule and prices. Optional intro text:</div>' : ''}
    <textarea data-k="body" rows="${Math.min(14, Math.max(s.generated ? 2 : 4, (s.body || '').split('\n').length + 1))}" ${dis}>${esc(s.body || '')}</textarea></div>`).join('')
    + (readonly ? '' : '<button type="button" class="btn-secondary btn-sm" data-act="add">+ Add a section</button>');
  box.querySelectorAll('textarea').forEach((ta) => { if (/\[\[/.test(ta.value)) ta.setAttribute('aria-invalid', 'true'); });
  if (readonly) return;
  box.oninput = (e) => {
    const card = e.target.closest('.sec-card'), k = e.target.dataset.k;
    if (!card || !k) return;
    secs[card.dataset.i][k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (k === 'enabled') card.classList.toggle('off', !e.target.checked);
    if (k === 'body') e.target.setAttribute('aria-invalid', /\[\[/.test(e.target.value));
    onChange(false);
  };
  box.onclick = (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
    const i = Number(e.target.closest('.sec-card')?.dataset.i);
    if (act === 'add') secs.splice(secs.findIndex((s) => s.key === 'acceptance') >>> 0, 0, { key: `custom_${Date.now().toString(36)}`, title: 'New section', body: '', enabled: true });
    if (act === 'rm') secs.splice(i, 1);
    if (act === 'up' && i > 0) [secs[i - 1], secs[i]] = [secs[i], secs[i - 1]];
    if (act === 'down' && i < secs.length - 1) [secs[i + 1], secs[i]] = [secs[i], secs[i + 1]];
    onChange(true);
  };
}
function pairsEditor(box, arr, { readonly, onChange, a = 'Item', b = 'Details' }) {
  const dis = readonly ? 'disabled' : '';
  box.innerHTML = `<div class="pairs">${arr.map((p, i) => `<div class="pair" data-i="${i}"><input data-j="0" value="${esc(p[0])}" placeholder="${a}" ${dis} aria-label="${a}"><input data-j="1" value="${esc(p[1])}" placeholder="${b}" ${dis} aria-label="${b}">${readonly ? '' : '<button type="button" class="icon-btn danger" data-rm aria-label="Remove row">✕</button>'}</div>`).join('')}</div>${readonly ? '' : '<button type="button" class="btn-secondary btn-sm" data-add>+ Add row</button>'}`;
  if (readonly) return;
  box.oninput = (e) => { const r = e.target.closest('.pair'); if (r) { arr[r.dataset.i][e.target.dataset.j] = e.target.value; onChange(false); } };
  box.onclick = (e) => {
    if (e.target.hasAttribute('data-add')) { arr.push(['', '']); onChange(true); }
    if (e.target.hasAttribute('data-rm')) { arr.splice(e.target.closest('.pair').dataset.i, 1); onChange(true); }
  };
}

// ══════════════════════════════════════════════════════════
// PROPOSALS
// ══════════════════════════════════════════════════════════
async function renderProposals(el) {
  const p = new URLSearchParams(location.hash.split('?')[1] || '');
  const status = p.get('status') || '', q = p.get('q') || '', archived = p.get('archived') === '1';
  el.innerHTML = `<div class="page-head"><div><h1>Proposals</h1><p>Build, price, send and track cleaning proposals. Sent versions are kept exactly as the customer received them.</p></div>
    <div class="actions"><button class="btn-primary" id="pr-new">+ New proposal</button></div></div>
    <div class="toolbar"><input type="search" id="pr-q" value="${esc(q)}" placeholder="Search reference, customer or title…" aria-label="Search proposals">
      <select id="pr-status" aria-label="Status"><option value="">All statuses</option>${['draft', 'sent', 'accepted', 'rejected', 'expired'].map((s) => `<option value="${s}" ${s === status ? 'selected' : ''}>${label(s)}</option>`).join('')}</select>
      <label class="check"><input type="checkbox" id="pr-arch" ${archived ? 'checked' : ''}> Archived</label></div>
    <div class="card table-card" id="pr-list">${skeleton()}</div>`;
  const load = async () => {
    const qs = { ...(el.querySelector('#pr-q').value.trim() && { q: el.querySelector('#pr-q').value.trim() }), ...(el.querySelector('#pr-status').value && { status: el.querySelector('#pr-status').value }), ...(el.querySelector('#pr-arch').checked && { archived: 1 }) };
    history.replaceState(null, '', `#/proposals${Object.keys(qs).length ? `?${new URLSearchParams(qs)}` : ''}`);
    const rows = await api(`/api/proposals?${new URLSearchParams(qs)}`);
    el.querySelector('#pr-list').innerHTML = rows.length ? `<div class="table-wrap"><table class="mobile-cards"><thead><tr><th>Reference</th><th>Customer</th><th>Status</th><th class="num">Monthly (ex VAT)</th><th class="num">One-off (ex VAT)</th><th>Valid until</th><th>Updated</th></tr></thead><tbody>
      ${rows.map((r) => `<tr class="click" data-id="${r.id}" tabindex="0"><td>${esc(r.number)}<span class="sub">v${r.issued_version || r.version} · ${esc(r.title)}</span></td><td data-label="Customer">${esc(r.business || '')}</td><td>${badge(r.status)}${r.contract_id ? ' <span class="badge b-active">Contract</span>' : ''}</td>
        <td class="num money" data-label="Monthly">${money(r.monthly_net_pence)}</td><td class="num money" data-label="One-off">${money(r.one_off_net_pence)}</td><td data-label="Valid until">${fmtDate(r.valid_until)}</td><td class="muted" data-label="Updated">${fmtDate(r.updated_at)}</td></tr>`).join('')}</tbody></table></div>`
      : empty(qs.q || qs.status ? 'No proposals match' : 'No proposals yet', qs.q || qs.status ? '' : 'Create one from a customer, or press “New proposal”.');
  };
  el.querySelector('#pr-list').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) location.hash = `#/proposals/${tr.dataset.id}`; });
  el.querySelector('#pr-list').addEventListener('keydown', (e) => { const tr = e.target.closest('tr[data-id]'); if (tr && e.key === 'Enter') location.hash = `#/proposals/${tr.dataset.id}`; });
  el.querySelector('#pr-q').addEventListener('input', debounce(load, 250));
  el.querySelector('#pr-status').addEventListener('change', load);
  el.querySelector('#pr-arch').addEventListener('change', load);
  el.querySelector('#pr-new').onclick = () => newProposal();
  await load();
}
async function newProposal(customer = null) {
  const lib = await getLibrary(true);
  const created = await modal({ title: 'New proposal', sub: 'Pick the customer and the services to start from — everything stays editable.',
    body: `${customer ? `<p><b>${esc(customer.business)}</b></p>` : field('Customer *', '<input name="customer" list="cust-list" required placeholder="Start typing a business…" autocomplete="off"><datalist id="cust-list"></datalist>', 'Not in the CRM yet? <a href="#" id="np-newcust">Create the customer first</a>.')}
      ${field('Title', '<input name="title" value="Commercial Cleaning Proposal">')}
      <div class="field"><span class="label">Services</span>${lib.services.filter((s) => s.active).map((s) => `<label class="check"><input type="checkbox" name="svc" value="${s.id}"> ${esc(s.name)} <span class="muted small">${s.price_pence != null ? money(s.price_pence) : s.rate_pence != null ? `${money(s.rate_pence)}/h` : ''} · ${esc(label(s.frequency))}</span></label>`).join('')}</div>`,
    submit: 'Create proposal', onSubmit: async (f, fd) => {
      const contact_id = customer?.id || custIdFromList(f, fd.get('customer'));
      if (!contact_id) throw new Error('Choose the customer from the list.');
      return api('/api/proposals', { method: 'POST', body: JSON.stringify({ contact_id, title: fd.get('title'), service_ids: fd.getAll('svc') }) });
    } });
  if (created) { toast(`Proposal ${created.number} created`); location.hash = `#/proposals/${created.id}`; }
}
document.addEventListener('click', (e) => { if (e.target.id === 'np-newcust') { e.preventDefault(); modalEl.close(); setTimeout(() => newCustomer(), 50); } });

async function renderProposal(el, id) {
  const [p, lib] = await Promise.all([api(`/api/proposals/${id}`), getLibrary()]);
  setCrumbs([['Proposals', '#/proposals'], [p.contact.business || 'Customer', `#/customers/${p.contact_id}`], [`${p.number}`]]);
  const ro = p.status !== 'draft';
  const state = { data: structuredClone(p.data), dirty: false };
  state.data.summary_rows ||= []; state.data.terms_extra ||= [];
  const latestPdf = p.issued_version ? `/api/proposals/${p.id}/pdf?version=${p.issued_version}` : null;
  el.innerHTML = `
    <div class="page-head"><div><h1>${esc(p.number)} ${badge(p.status)} ${p.archived_at ? badge('archived') : ''}</h1><p>${esc(p.title)} for <a href="#/customers/${p.contact_id}">${esc(p.contact.business)}</a> · ${ro ? `version ${p.issued_version} (as sent)` : `draft of version ${p.version}`}</p></div>
      <div class="actions" id="pr-actions"></div></div>
    ${ro ? `<div class="alert alert-info">This version has been ${p.status === 'sent' ? 'sent' : esc(p.status)} and can’t be changed. ${can('manager') && ['sent', 'rejected', 'expired'].includes(p.status) ? 'Use <b>Revise</b> to start a new version — the sent one stays as it was.' : ''}</div>` : ''}
    <div class="split"><div>
      <div class="card editor-section"><h2><span><span class="num">1</span>Customer & document</span></h2><div class="fields">
        ${field('Contact (addressed to)', `<select id="e-person" ${ro ? 'disabled' : ''}><option value="">—</option>${p.people.map((x) => `<option value="${x.id}" ${x.id === p.person_id ? 'selected' : ''}>${esc(x.name)}${x.job_title ? ` (${esc(x.job_title)})` : ''}</option>`).join('')}</select>`, `<a href="#/customers/${p.contact_id}/people">Manage people</a>`)}
        ${field('Service location', `<select id="e-site" ${ro ? 'disabled' : ''}><option value="">Customer’s main address</option>${p.sites.map((x) => `<option value="${x.id}" ${x.id === p.site_id ? 'selected' : ''}>${esc(x.name)} — ${esc(x.address)}</option>`).join('')}</select>`, `<a href="#/customers/${p.contact_id}/sites">Manage sites</a>`)}
        ${field('Title', `<input id="e-title" value="${esc(p.title)}" ${ro ? 'disabled' : ''}>`)}
        ${field('Issue date', `<input type="date" id="e-issue" value="${p.issue_date || ''}" ${ro ? 'disabled' : ''}>`)}
        ${field('Valid until', `<input type="date" id="e-valid" value="${p.valid_until || ''}" ${ro ? 'disabled' : ''}>`)}
      </div></div>
      <div class="card editor-section"><h2><span><span class="num">2</span>Services & pricing</span>
        ${ro ? '' : `<span class="row"><select id="e-addsvc" aria-label="Add a service"><option value="">+ Add from templates…</option>${lib.services.filter((s) => s.active).map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select><button class="btn-secondary btn-sm" id="e-blank">+ Blank line</button></span>`}</h2>
        <div id="e-lines"></div>
        <div class="fields">${field('VAT', `<select id="e-vat" ${ro ? 'disabled' : ''}><option value="2000" ${state.data.vat_rate_bp === 2000 ? 'selected' : ''}>20% (standard)</option><option value="500" ${state.data.vat_rate_bp === 500 ? 'selected' : ''}>5%</option><option value="0" ${state.data.vat_rate_bp === 0 ? 'selected' : ''}>No VAT</option></select>`)}</div>
      </div>
      <div class="card editor-section"><h2><span><span class="num">3</span>Schedule & terms</span></h2><div class="fields">
        ${field('Minimum / introductory term', `<input id="e-minterm" value="${esc(state.data.minimum_term || '')}" placeholder="3 months" ${ro ? 'disabled' : ''}>`)}
        ${field('Notice period', `<input id="e-notice" value="${esc(state.data.notice_period || '')}" placeholder="1 month" ${ro ? 'disabled' : ''}>`)}
        ${field('Start date (wording)', `<input id="e-start" value="${esc(state.data.start_date_text || '')}" placeholder="To be confirmed by the client" ${ro ? 'disabled' : ''}>`)}
        <div class="wide">${field('Schedule notes', `<textarea id="e-sched" rows="3" ${ro ? 'disabled' : ''} placeholder="Shown under the schedule table">${esc(state.data.schedule_notes || '')}</textarea>`)}</div></div>
        <div class="field"><span class="label">Executive summary — extra rows</span><div id="e-summary"></div></div>
        <div class="field"><span class="label">Commercial terms — extra rows</span><div id="e-terms"></div></div>
      </div>
      <div class="card editor-section"><h2><span><span class="num">4</span>Sections & wording</span></h2>
        <p class="small muted" style="margin-top:-6px">Merge fields: {{client}}, {{site_address}}, {{signatory_title}}, {{minimum_term}}, {{notice_period}}. Anything in [[double brackets]] must be completed before the proposal can be issued.</p>
        <div id="e-sections"></div></div>
      <div class="card editor-section"><h2>Internal notes <span class="small muted">(never printed)</span></h2><textarea id="e-internal" rows="3" style="width:100%" ${ro ? 'disabled' : ''}>${esc(state.data.internal_notes || '')}</textarea></div>
    </div>
    <div class="sticky">
      <div class="card"><div class="card-head"><h2>Totals</h2>${ro ? '' : '<span class="dirty-dot" id="e-dirty" hidden title="Unsaved changes"></span>'}</div><div data-totals></div></div>
      <div class="card" id="e-problems-card"><h2>Ready to issue?</h2><div id="e-problems"></div></div>
      <div class="card"><h2>Versions</h2>${p.versions.length ? p.versions.map((v) => `<div class="list-row"><span>v${v.version}<span class="sub muted">${fmtDT(v.issued_at)}${v.issued_by_name ? ` · ${esc(v.issued_by_name)}` : ''}</span></span><span><button class="btn-ghost btn-sm" data-pdf="${v.version}">View</button><a class="btn-ghost btn-sm" href="/api/proposals/${p.id}/pdf?version=${v.version}&download=1">PDF</a></span></div>`).join('') : '<p class="muted small" style="margin:0">Nothing issued yet. A version is frozen (with its PDF) when it’s sent.</p>'}</div>
      ${p.contract ? `<div class="card"><h2>Contract</h2><a href="#/contracts/${p.contract.id}">${esc(p.contract.number)}</a> ${badge(p.contract.status)}</div>` : ''}
    </div></div><div class="mbar"><div class="mtot" data-mtotal>Totals</div>${ro ? '<button class="btn-secondary" data-mbar="preview">View PDF</button>' : '<button class="btn-secondary" data-mbar="preview">Preview</button><button class="btn-primary" data-mbar="save">Save</button>'}</div>`;
  el.classList.add('has-mbar');

  const root = el;
  const problems = (list) => { root.querySelector('#e-problems').innerHTML = list.length ? `<ul class="small" style="margin:0;padding-left:18px">${list.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="small" style="margin:0;color:var(--ok)">✓ Everything needed is filled in.</p>'; };
  problems(p.problems);
  const markDirty = () => { if (ro) return; state.dirty = true; root.querySelector('#e-dirty').hidden = false; };
  const reprice = debounce(async () => {
    try { showPricing(root, await api('/api/pricing/preview', { method: 'POST', body: JSON.stringify({ lines: state.data.lines, vat_rate_bp: state.data.vat_rate_bp }) })); }
    catch (err) { showPricing(root, null, err.message); }
  }, 350);
  const drawLines = () => linesEditor(root.querySelector('#e-lines'), state, { readonly: ro, onChange: (redraw) => { markDirty(); if (redraw) drawLines(); reprice(); } });
  const drawSections = () => sectionsEditor(root.querySelector('#e-sections'), state, { readonly: ro, onChange: (redraw) => { markDirty(); if (redraw) drawSections(); } });
  const drawPairs = () => {
    pairsEditor(root.querySelector('#e-summary'), state.data.summary_rows, { readonly: ro, onChange: (r) => { markDirty(); if (r) drawPairs(); } });
    pairsEditor(root.querySelector('#e-terms'), state.data.terms_extra, { readonly: ro, a: 'Term', onChange: (r) => { markDirty(); if (r) drawPairs(); } });
  };
  drawLines(); drawSections(); drawPairs();
  showPricing(root, p.priced, p.priced ? null : 'Complete the service lines to see prices.');
  if (!ro) {
    const bind = (sel, key) => root.querySelector(sel).addEventListener('input', (e) => { state.data[key] = e.target.value; markDirty(); });
    bind('#e-minterm', 'minimum_term'); bind('#e-notice', 'notice_period'); bind('#e-start', 'start_date_text'); bind('#e-sched', 'schedule_notes'); bind('#e-internal', 'internal_notes');
    for (const s of ['#e-person', '#e-site', '#e-title', '#e-issue', '#e-valid']) root.querySelector(s).addEventListener('input', markDirty);
    root.querySelector('#e-vat').addEventListener('change', (e) => { state.data.vat_rate_bp = Number(e.target.value); markDirty(); reprice(); });
    root.querySelector('#e-addsvc').addEventListener('change', (e) => { const s = lib.services.find((x) => x.id === e.target.value); if (s) { state.data.lines.push(lineFromTemplate(s)); e.target.value = ''; markDirty(); drawLines(); reprice(); } });
    root.querySelector('#e-blank').addEventListener('click', () => { state.data.lines.push({ ...lineFromTemplate({ name: 'New service', billing: 'fixed', frequency: 'monthly' }), visits_per_week: 1 }); markDirty(); drawLines(); });
    leaveGuard = () => !state.dirty;
  }
  const save = async () => {
    if (ro || !state.dirty) return;
    await api(`/api/proposals/${p.id}`, { method: 'PATCH', body: JSON.stringify({ data: state.data, person_id: root.querySelector('#e-person').value || null, site_id: root.querySelector('#e-site').value || null,
      title: root.querySelector('#e-title').value, issue_date: root.querySelector('#e-issue').value || null, valid_until: root.querySelector('#e-valid').value || null }) });
    state.dirty = false; leaveGuard = () => !state.dirty;
    root.querySelector('#e-dirty').hidden = true;
    problems((await api(`/api/proposals/${p.id}`)).problems);
  };
  const reload = () => { leaveGuard = null; renderProposal(el, id); };

  // actions by status and role
  const A = root.querySelector('#pr-actions'), M = can('manager');
  const btn = (k, t, cls = 'btn-secondary') => `<button class="${cls}" data-act="${k}">${t}</button>`;
  A.innerHTML = [
    !ro && btn('save', 'Save', 'btn-primary'),
    btn('preview', ro ? 'View PDF' : 'Preview PDF'),
    !ro && M && btn('send', 'Send by email…', 'btn-primary'),
    p.status === 'sent' && M && btn('accept', 'Mark accepted', 'btn-primary'),
    p.status === 'accepted' && M && !p.contract && btn('contract', 'Create contract', 'btn-primary'),
    `<details class="menu"><summary class="btn-secondary">More ▾</summary><div class="menu-list">
      ${!ro && M ? '<button data-act="marksent">Mark as sent (sent another way)</button>' : ''}
      ${['sent', 'expired'].includes(p.status) && M ? '<button data-act="reject">Mark rejected…</button>' : ''}
      ${p.status === 'expired' && M ? '<button data-act="accept">Mark accepted</button>' : ''}
      ${['sent', 'rejected', 'expired'].includes(p.status) && M ? '<button data-act="revise">Revise (new version)</button>' : ''}
      ${latestPdf ? `<a href="${latestPdf}&download=1">Download v${p.issued_version} PDF</a>` : ''}
      <button data-act="duplicate">Duplicate</button>
      <button data-act="archive">${p.archived_at ? 'Unarchive' : 'Archive'}</button></div></details>`,
  ].filter(Boolean).join('');
  root.addEventListener('click', (e) => { const v = e.target.dataset.pdf; if (v) previewPdf(`/api/proposals/${p.id}/pdf?version=${v}`, `${p.number} v${v}`); });
  A.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    b.closest('details')?.removeAttribute('open');
    if (act === 'save') return busy(b, async () => { await save(); toast('Saved'); });
    if (act === 'preview') return busy(b, async () => { await save(); previewPdf(ro && p.issued_version ? latestPdf : `/api/proposals/${p.id}/pdf?t=${Date.now()}`, ro ? `${p.number} v${p.issued_version}` : `${p.number} — draft preview`); });
    if (act === 'send') {
      try { await save(); } catch (err) { return toast(err.message, 'error'); }
      const person = p.people.find((x) => x.id === (root.querySelector('#e-person').value || p.person_id));
      const ok = await modal({ title: `Send ${p.number}`, sub: 'The PDF is frozen as this version and attached. You’ll see it on the timeline.',
        body: `${field('To *', `<input type="email" name="to" required value="${esc(person?.email || p.contact.email || '')}">`)}${field('Cc', '<input type="email" name="cc">')}
          ${field('Subject', `<input name="subject" value="Cleaning proposal ${esc(p.number)} — FC Cleaning Company Ltd">`)}
          ${field('Message', `<textarea name="message" rows="6">Please find attached our proposal for cleaning services${p.contact.business ? ` at ${esc(p.contact.business)}` : ''}, following our site visit.\n\nThe proposal sets out the scope, schedule and pricing. If you have any questions or would like anything adjusted, just reply to this email.</textarea>`)}`,
        submit: 'Send proposal', onSubmit: (f, fd) => api(`/api/proposals/${p.id}/send`, { method: 'POST', body: JSON.stringify(Object.fromEntries(fd)) }) });
      if (ok) { toast('Proposal sent'); reload(); }
      return;
    }
    if (act === 'marksent') {
      if (!(await confirmDialog({ title: 'Mark as sent?', body: `Version ${p.version} will be frozen with its PDF. Use this when you’ve sent or handed it over outside the CRM.`, confirmText: 'Mark as sent' }))) return;
      return busy(b, async () => { await save(); await api(`/api/proposals/${p.id}/mark-sent`, { method: 'POST' }); toast('Marked as sent'); reload(); });
    }
    if (act === 'accept') {
      if (!(await confirmDialog({ title: 'Mark as accepted?', body: 'The customer accepted this version. A task to prepare the contract will be created.', confirmText: 'Mark accepted' }))) return;
      return busy(b, async () => { await api(`/api/proposals/${p.id}/accept`, { method: 'POST' }); toast('Accepted 🎉'); reload(); });
    }
    if (act === 'reject') {
      const r = await modal({ title: 'Mark as rejected', body: field('Reason (optional)', '<textarea name="reason" rows="3"></textarea>'), submit: 'Mark rejected', danger: true, onSubmit: (f, fd) => api(`/api/proposals/${p.id}/reject`, { method: 'POST', body: JSON.stringify({ reason: fd.get('reason') }) }) });
      if (r) { toast('Marked rejected'); reload(); }
      return;
    }
    if (act === 'revise') {
      if (!(await confirmDialog({ title: `Start version ${(p.issued_version || p.version) + 1}?`, body: `Version ${p.issued_version} stays exactly as sent. You’ll edit a new draft.`, confirmText: 'Revise' }))) return;
      return busy(b, async () => { await api(`/api/proposals/${p.id}/revise`, { method: 'POST' }); reload(); });
    }
    if (act === 'contract') return busy(b, async () => { const k = await api('/api/contracts', { method: 'POST', body: JSON.stringify({ proposal_id: p.id }) }); toast(`Contract ${k.number} drafted`); location.hash = `#/contracts/${k.id}`; });
    if (act === 'duplicate') return busy(b, async () => { const d = await api(`/api/proposals/${p.id}/duplicate`, { method: 'POST' }); toast(`Copied to ${d.number}`); location.hash = `#/proposals/${d.id}`; });
    if (act === 'archive') return busy(b, async () => { await api(`/api/proposals/${p.id}/archive`, { method: 'POST', body: JSON.stringify({ archived: !p.archived_at }) }); toast(p.archived_at ? 'Unarchived' : 'Archived'); reload(); });
  });
  root.querySelector('.mbar')?.addEventListener('click', (e) => { const a = e.target.dataset.mbar; if (a) A.querySelector(`[data-act=${a}]`)?.click(); });
  // Ctrl/Cmd+S saves
  root.onkeydown = (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 's' && !ro) { e.preventDefault(); A.querySelector('[data-act=save]').click(); } };
}

// ══════════════════════════════════════════════════════════
// CONTRACTS
// ══════════════════════════════════════════════════════════
const MOVE_LABEL = { review: 'Send to review', draft: 'Back to draft', ready: 'Mark ready to sign', active: 'Activate', renewal_due: 'Flag renewal due', terminated: 'End contract…', expired: 'Mark expired', cancelled: 'Cancel contract…' };
async function renderContracts(el) {
  const p = new URLSearchParams(location.hash.split('?')[1] || '');
  el.innerHTML = `<div class="page-head"><div><h1>Contracts</h1><p>Service agreements: drafted from accepted proposals, signed through DocuSeal, then onboarded and renewed.</p></div>
    ${can('manager') ? '<div class="actions"><button class="btn-secondary" id="k-new">+ Blank contract</button></div>' : ''}</div>
    <div class="toolbar"><input type="search" id="k-q" placeholder="Search reference or customer…" aria-label="Search contracts" value="${esc(p.get('q') || '')}">
      <select id="k-status" aria-label="Status"><option value="">All statuses</option>
        <option value="draft,review,ready">Being prepared</option><option value="sent,partially_signed">Out for signature</option><option value="signed">Signed — to activate</option><option value="active,renewal_due">Live</option><option value="renewal_due">Renewal due</option><option value="expired,terminated,cancelled,declined">Ended</option></select>
      <label class="check"><input type="checkbox" id="k-arch"> Archived</label></div>
    <div class="card table-card" id="k-list">${skeleton()}</div>`;
  const load = async () => {
    const q = el.querySelector('#k-q').value.trim(), st = el.querySelector('#k-status').value;
    const rows = await api(`/api/contracts?${new URLSearchParams({ ...(q && { q }), ...(st && { status: st }), ...(el.querySelector('#k-arch').checked && { archived: 1 }) })}`);
    el.querySelector('#k-list').innerHTML = rows.length ? `<div class="table-wrap"><table class="mobile-cards"><thead><tr><th>Reference</th><th>Customer</th><th>Status</th><th class="num">Monthly (ex VAT)</th><th>Start</th><th>Renewal</th></tr></thead><tbody>
      ${rows.map((k) => `<tr class="click" data-id="${k.id}" tabindex="0"><td>${esc(k.number)}<span class="sub">${k.proposal_number ? `from ${esc(k.proposal_number)}` : 'blank'} · v${k.issued_version || k.version}</span></td><td data-label="Customer">${esc(k.business)}</td><td>${badge(k.status)}</td>
        <td class="num money" data-label="Monthly">${money(k.monthly_net_pence)}</td><td data-label="Start">${fmtDate(k.start_date)}</td><td data-label="Renewal">${fmtDate(k.renewal_date)}</td></tr>`).join('')}</tbody></table></div>`
      : empty('No contracts here', 'Accept a proposal, then press “Create contract”.');
  };
  el.querySelector('#k-list').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-id]'); if (tr) location.hash = `#/contracts/${tr.dataset.id}`; });
  el.querySelector('#k-list').addEventListener('keydown', (e) => { const tr = e.target.closest('tr[data-id]'); if (tr && e.key === 'Enter') location.hash = `#/contracts/${tr.dataset.id}`; });
  el.querySelector('#k-q').addEventListener('input', debounce(load, 250));
  el.querySelector('#k-status').addEventListener('change', load);
  el.querySelector('#k-arch').addEventListener('change', load);
  el.querySelector('#k-new')?.addEventListener('click', async () => {
    const k = await modal({ title: 'Blank contract', sub: 'Usually you’d create a contract from an accepted proposal, so the agreed prices are copied exactly. Use this for existing customers without one.',
      body: field('Customer *', '<input name="customer" list="cust-list" required autocomplete="off"><datalist id="cust-list"></datalist>'), submit: 'Create',
      onSubmit: (f, fd) => { const contact_id = custIdFromList(f, fd.get('customer')); if (!contact_id) throw new Error('Choose the customer from the list.'); return api('/api/contracts', { method: 'POST', body: JSON.stringify({ contact_id }) }); } });
    if (k) location.hash = `#/contracts/${k.id}`;
  });
  await load();
}

async function renderContract(el, id) {
  const [k, lib] = await Promise.all([api(`/api/contracts/${id}`), getLibrary()]);
  setCrumbs([['Contracts', '#/contracts'], [k.contact.business || 'Customer', `#/customers/${k.contact_id}`], [k.number]]);
  const M = can('manager'), editable = M && ['draft', 'review'].includes(k.status);
  const ro = !editable;
  const state = { data: structuredClone(k.data), dirty: false };
  state.data.summary_rows ||= []; state.data.terms_extra ||= [];
  const sig = k.signatures[0];
  const signed = k.signed_document_id;
  el.innerHTML = `
    <div class="page-head"><div><h1>${esc(k.number)} ${badge(k.status)}</h1><p>Service agreement for <a href="#/customers/${k.contact_id}">${esc(k.contact.business)}</a>${k.proposal ? ` · from proposal <a href="#/proposals/${k.proposal.id}">${esc(k.proposal.number)}</a> (${esc(k.data.proposal_ref || '')})` : ''}</p></div>
      <div class="actions" id="k-actions"></div></div>
    ${!editable && ['draft', 'review'].includes(k.status) ? '<div class="alert alert-info">Only managers can edit contracts.</div>' : ''}
    ${!['draft', 'review'].includes(k.status) ? `<div class="alert alert-info">${k.status === 'ready' ? 'Locked while ready to sign. Use <b>Back to review</b> to change it.' : 'This contract is issued; its terms are fixed. Version history and signed documents are below.'}</div>` : ''}
    <div class="split"><div>
      <div class="card editor-section"><h2><span><span class="num">1</span>Parties, dates & term</span></h2><div class="fields">
        ${field('Signs for the customer', `<select id="c-person" ${ro ? 'disabled' : ''}><option value="">— choose —</option>${k.people.map((x) => `<option value="${x.id}" ${x.id === k.person_id ? 'selected' : ''}>${esc(x.name)}${x.email ? ` <${esc(x.email)}>` : ' (no email)'}</option>`).join('')}</select>`, `<a href="#/customers/${k.contact_id}/people">Add or edit people</a>`)}
        ${field('Service location', `<select id="c-site" ${ro ? 'disabled' : ''}><option value="">Customer’s main address</option>${k.sites.map((x) => `<option value="${x.id}" ${x.id === k.site_id ? 'selected' : ''}>${esc(x.name)} — ${esc(x.address)}</option>`).join('')}</select>`)}
        ${field('Effective (start) date', `<input type="date" id="c-start" value="${k.start_date || ''}" ${ro ? 'disabled' : ''}>`)}
        ${field('Review / renewal date', `<input type="date" id="c-renewal" value="${k.renewal_date || ''}" ${ro ? 'disabled' : ''}>`, 'Defaults to start + minimum term')}
        ${field('End date (if fixed)', `<input type="date" id="c-end" value="${k.end_date || ''}" ${ro ? 'disabled' : ''}>`)}
        ${field('Minimum / introductory term', `<input id="c-minterm" value="${esc(state.data.minimum_term || '')}" ${ro ? 'disabled' : ''}>`)}
        ${field('Notice period', `<input id="c-notice" value="${esc(state.data.notice_period || '')}" ${ro ? 'disabled' : ''}>`)}
        <div class="wide">${field('Payment terms for this account', `<textarea id="c-payterms" rows="3" ${ro ? 'disabled' : ''} placeholder="Optional — printed under Commercial Terms">${esc(state.data.payment_terms || '')}</textarea>`)}</div>
      </div></div>
      <div class="card editor-section"><h2><span><span class="num">2</span>Agreed services & prices</span>${ro ? '' : `<select id="c-addsvc" aria-label="Add a service"><option value="">+ Add from templates…</option>${lib.services.filter((s) => s.active).map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>`}</h2>
        ${k.proposal ? '<p class="small muted" style="margin-top:-6px">Copied from the accepted proposal. Changing them here does not change the proposal.</p>' : ''}
        <div id="c-lines"></div>
        ${field('Schedule notes', `<textarea id="c-sched" rows="3" style="width:100%" ${ro ? 'disabled' : ''}>${esc(state.data.schedule_notes || '')}</textarea>`)}</div>
      <div class="card editor-section"><h2><span><span class="num">3</span>Clauses</span></h2>
        <p class="small muted" style="margin-top:-6px">Generated wording is not legal advice — check the clauses suit this customer. [[Double brackets]] must be completed before sending.</p>
        <div id="c-sections"></div></div>
      <div class="card"><h2>History</h2><ul class="timeline">${k.history.map((h) => `<li class="t-${esc(h.type)}"><div>${esc(h.body)}</div><div class="when">${fmtDT(h.at)}</div></li>`).join('') || '<li>No history yet.</li>'}</ul></div>
    </div>
    <div class="sticky">
      <div class="card"><div class="card-head"><h2>Totals</h2>${ro ? '' : '<span class="dirty-dot" id="e-dirty" hidden></span>'}</div><div data-totals></div></div>
      <div class="card"><h2>Ready to send?</h2><div id="c-problems"></div></div>
      <div class="card"><h2>Signing ${sig ? badge(sig.status) : ''}</h2>${signingPanel(k, sig)}</div>
      <div class="card"><div class="card-head"><h2>Documents</h2>${M ? '<button class="btn-ghost btn-sm" id="c-upload">Upload</button>' : ''}</div>
        ${signed ? `<div class="list-row"><span><b>Signed agreement</b></span><span><button class="btn-ghost btn-sm" data-doc="${signed}">View</button><a class="btn-ghost btn-sm" href="/api/documents/${signed}/file?download=1">PDF</a></span></div>` : ''}
        ${sig?.audit_document_id ? `<div class="list-row"><span>Signing audit trail</span><span><button class="btn-ghost btn-sm" data-doc="${sig.audit_document_id}">View</button></span></div>` : ''}
        ${k.versions.map((v) => `<div class="list-row"><span>Issued v${v.version}<span class="sub muted">${fmtDT(v.issued_at)}${v.issued_by_name ? ` · ${esc(v.issued_by_name)}` : ''}</span></span><span><button class="btn-ghost btn-sm" data-ver="${v.version}">View</button></span></div>`).join('') || '<p class="small muted" style="margin:0">A version (with its PDF) is frozen when it’s sent for signature.</p>'}
        <div id="c-docs"></div></div>
    </div></div><div class="mbar"><div class="mtot" data-mtotal>Totals</div>${ro ? '<button class="btn-secondary" data-mbar="preview">View PDF</button>' : '<button class="btn-secondary" data-mbar="preview">Preview</button><button class="btn-primary" data-mbar="save">Save</button>'}</div>`;
  el.classList.add('has-mbar');
  const root = el;
  root.querySelector('#c-problems').innerHTML = k.problems.length ? `<ul class="small" style="margin:0;padding-left:18px">${k.problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="small" style="margin:0;color:var(--ok)">✓ Nothing missing.</p>';
  const markDirty = () => { if (ro) return; state.dirty = true; root.querySelector('#e-dirty').hidden = false; };
  const reprice = debounce(async () => { try { showPricing(root, await api('/api/pricing/preview', { method: 'POST', body: JSON.stringify({ lines: state.data.lines, vat_rate_bp: state.data.vat_rate_bp }) })); } catch (err) { showPricing(root, null, err.message); } }, 350);
  const drawLines = () => linesEditor(root.querySelector('#c-lines'), state, { readonly: ro, onChange: (r) => { markDirty(); if (r) drawLines(); reprice(); } });
  const drawSections = () => sectionsEditor(root.querySelector('#c-sections'), state, { readonly: ro, onChange: (r) => { markDirty(); if (r) drawSections(); } });
  drawLines(); drawSections();
  showPricing(root, k.priced, k.priced ? null : 'Add the agreed services to see prices.');
  if (M) api(`/api/documents?contract_id=${k.id}&kind=upload`).then((docs) => { root.querySelector('#c-docs').innerHTML = docs.map((d) => `<div class="list-row"><span>${esc(d.title)}</span><span><button class="btn-ghost btn-sm" data-doc="${d.id}">View</button></span></div>`).join(''); }).catch(() => {});
  if (!ro) {
    const bind = (sel, key) => root.querySelector(sel).addEventListener('input', (e) => { state.data[key] = e.target.value; markDirty(); });
    bind('#c-minterm', 'minimum_term'); bind('#c-notice', 'notice_period'); bind('#c-payterms', 'payment_terms'); bind('#c-sched', 'schedule_notes');
    for (const s of ['#c-person', '#c-site', '#c-start', '#c-renewal', '#c-end']) root.querySelector(s).addEventListener('input', markDirty);
    root.querySelector('#c-addsvc').addEventListener('change', (e) => { const s = lib.services.find((x) => x.id === e.target.value); if (s) { state.data.lines.push(lineFromTemplate(s)); e.target.value = ''; markDirty(); drawLines(); reprice(); } });
    leaveGuard = () => !state.dirty;
  }
  const save = async () => {
    if (ro || !state.dirty) return;
    await api(`/api/contracts/${k.id}`, { method: 'PATCH', body: JSON.stringify({ data: state.data, person_id: root.querySelector('#c-person').value || null, site_id: root.querySelector('#c-site').value || null,
      start_date: root.querySelector('#c-start').value, renewal_date: root.querySelector('#c-renewal').value, end_date: root.querySelector('#c-end').value }) });
    state.dirty = false;
  };
  const reload = () => { leaveGuard = null; renderContract(el, id); };
  root.addEventListener('click', (e) => {
    if (e.target.dataset.doc) previewPdf(`/api/documents/${e.target.dataset.doc}/file`, 'Document');
    if (e.target.dataset.ver) previewPdf(`/api/contracts/${k.id}/pdf?version=${e.target.dataset.ver}`, `${k.number} v${e.target.dataset.ver}`);
  });
  root.querySelector('#c-upload')?.addEventListener('click', () => pickAndUpload({ contract_id: k.id, title: 'Supporting document' }, reload));

  const A = root.querySelector('#k-actions');
  A.innerHTML = [
    editable && '<button class="btn-primary" data-act="save">Save</button>',
    M && `<button class="btn-secondary" data-act="preview">${k.issued_version && !editable ? 'View issued PDF' : 'Preview PDF'}</button>`,
    ...(M ? k.moves.map((m) => `<button class="${['ready', 'active'].includes(m) ? 'btn-primary' : ['cancelled', 'terminated'].includes(m) ? 'btn-secondary' : 'btn-secondary'}" data-move="${m}">${MOVE_LABEL[m] || label(m)}</button>`) : []),
    M && ['ready', 'declined'].includes(k.status) && '<button class="btn-secondary" data-act="revise">Revise (new version)</button>',
    M && ['cancelled', 'declined', 'terminated', 'expired'].includes(k.status) && `<button class="btn-secondary" data-act="archive">${k.archived_at ? 'Unarchive' : 'Archive'}</button>`,
  ].filter(Boolean).join('');
  A.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'save') return busy(b, async () => { await save(); toast('Saved'); reload(); });
    if (b.dataset.act === 'preview') return busy(b, async () => { await save(); previewPdf(!editable && k.issued_version ? `/api/contracts/${k.id}/pdf?version=${k.issued_version}` : `/api/contracts/${k.id}/pdf?t=${Date.now()}`, k.number); });
    if (b.dataset.act === 'revise') { if (await confirmDialog({ title: 'Revise this contract?', body: 'It goes back to draft as a new version. Issued versions stay as they are.', confirmText: 'Revise' })) busy(b, async () => { await api(`/api/contracts/${k.id}/revise`, { method: 'POST' }); reload(); }); return; }
    if (b.dataset.act === 'archive') return busy(b, async () => { await api(`/api/contracts/${k.id}/archive`, { method: 'POST', body: JSON.stringify({ archived: !k.archived_at }) }); reload(); });
    const to = b.dataset.move;
    if (!to) return;
    let body = { to };
    if (['terminated', 'cancelled'].includes(to)) {
      const r = await modal({ title: to === 'terminated' ? 'End this contract' : 'Cancel this contract', body: field(`Reason${to === 'terminated' ? ' *' : ''}`, `<textarea name="reason" rows="3" ${to === 'terminated' ? 'required' : ''}></textarea>`), submit: to === 'terminated' ? 'End contract' : 'Cancel contract', danger: true, onSubmit: async (f, fd) => ({ reason: fd.get('reason') }) });
      if (!r) return;
      body.reason = r.reason;
    } else if (to === 'active') {
      if (!(await confirmDialog({ title: 'Activate this contract?', body: 'Creates the onboarding checklist and weekly quality follow-ups, and marks the customer Won.', confirmText: 'Activate' }))) return;
    } else if (to === 'renewal_due' || to === 'expired') {
      if (!(await confirmDialog({ title: `${MOVE_LABEL[to]}?`, confirmText: 'Yes' }))) return;
    }
    busy(b, async () => { await save(); await api(`/api/contracts/${k.id}/status`, { method: 'POST', body: JSON.stringify(body) }); toast(`Contract: ${label(to)}`); reload(); });
  });
  root.querySelector('.mbar')?.addEventListener('click', (e) => { const a = e.target.dataset.mbar; if (a) A.querySelector(`[data-act=${a}]`)?.click(); });
  // signing panel actions
  root.querySelector('#sign-panel')?.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-sign]');
    if (!b) return;
    const a = b.dataset.sign;
    if (a === 'send') {
      if (!(await confirmDialog({ title: 'Send for signature?', body: `DocuSeal will email signing links (${k.people.find((x) => x.id === k.person_id)?.email || 'customer'} and FC’s signatory). This version is frozen.`, confirmText: 'Send for signature' }))) return;
      return busy(b, async () => { await save(); await api(`/api/contracts/${k.id}/signature`, { method: 'POST', headers: { 'Idempotency-Key': `${k.id}:${k.version}` } }); toast('Sent for signature'); reload(); });
    }
    if (a === 'refresh') return busy(b, async () => { await api(`/api/contracts/${k.id}/signature/refresh`, { method: 'POST' }); toast('Status updated from DocuSeal'); reload(); });
    if (a === 'resend') return busy(b, async () => { const r = await api(`/api/contracts/${k.id}/signature/resend`, { method: 'POST' }); toast(`Reminder sent to ${r.resent_to.join(', ') || 'nobody (all signed)'}`); });
    if (a === 'cancel') { if (await confirmDialog({ title: 'Cancel the signature request?', body: 'The signing links stop working. The contract goes back to “ready to sign”.', confirmText: 'Cancel request', danger: true })) busy(b, async () => { await api(`/api/contracts/${k.id}/signature/cancel`, { method: 'POST' }); toast('Request cancelled'); reload(); }); return; }
    if (a === 'link') return busy(b, async () => { const r = await api(`/api/contracts/${k.id}/signature/link?role=${encodeURIComponent(b.dataset.role)}`); window.open(r.url, '_blank', 'noopener'); });
  });
}
function signingPanel(k, sig) {
  const M = can('manager');
  if (!M) return '<p class="small muted">Managers handle signatures.</p>';
  const live = sig && ['sent', 'partially_signed'].includes(sig.status);
  const signers = (sig?.signers || []).map((s) => `<div class="signer"><span>${esc(s.role)}<span class="sub muted">${esc(s.name || '')} · ${esc(s.email || '')}</span></span><span>${s.completed_at ? `<span class="badge b-completed">Signed</span>` : s.declined_at ? badge('declined') : `<span class="badge b-sent">${esc(label(s.status || 'waiting'))}</span>${live && s.role === 'FC Cleaning' ? ` <button class="btn-ghost btn-sm" data-sign="link" data-role="${esc(s.role)}">Sign now</button>` : ''}`}</span></div>`).join('');
  return `<div id="sign-panel">
    ${sig ? `<div class="signers">${signers}</div><p class="small muted">Request ${fmtDT(sig.created_at)}${sig.docuseal_submission_id ? ` · DocuSeal #${esc(sig.docuseal_submission_id)}` : ''}${sig.error ? `<br><span style="color:var(--danger)">${esc(sig.error)}</span>` : ''}</p>` : '<p class="small muted">Not sent yet.</p>'}
    <div class="row">${k.status === 'ready' ? '<button class="btn-primary" data-sign="send">Send for signature</button>' : ''}
      ${live ? '<button class="btn-secondary btn-sm" data-sign="resend">Resend reminder</button><button class="btn-secondary btn-sm" data-sign="cancel">Cancel request</button>' : ''}
      ${sig?.docuseal_submission_id ? '<button class="btn-ghost btn-sm" data-sign="refresh">Refresh status</button>' : ''}</div></div>`;
}

// ══════════════════════════════════════════════════════════
// SETTINGS
// ══════════════════════════════════════════════════════════
const SETTINGS_TABS = [['account', 'My account', 'staff'], ['company', 'Company', 'staff'], ['library', 'Services & clauses', 'staff'], ['automations', 'Automations', 'staff'], ['users', 'Users', 'admin'], ['integrations', 'Integrations', 'manager'], ['audit', 'Audit log', 'admin'], ['outreach', 'Outreach & suppression', 'staff']];
async function renderSettings(el, tab = 'account') {
  const tabs = SETTINGS_TABS.filter(([, , r]) => can(r));
  if (!tabs.some(([k]) => k === tab)) tab = 'account';
  el.querySelector('#settings-tabs').innerHTML = tabs.map(([k, l]) => `<a href="#/settings/${k}" role="tab" aria-selected="${k === tab}" class="${k === tab ? 'on' : ''}">${l}</a>`).join('');
  const panel = el.querySelector('#settings-panel'), outreach = el.querySelector('#settings-outreach');
  outreach.hidden = tab !== 'outreach';
  panel.innerHTML = tab === 'outreach' ? '' : skeleton();
  setCrumbs([['Settings', '#/settings'], [tabs.find(([k]) => k === tab)[1]]]);
  const reload = () => renderSettings(el, tab);
  if (tab === 'outreach') return loadSettingsView();
  if (tab === 'account') {
    panel.innerHTML = `<div class="card" style="max-width:560px"><h2>Signed in as ${esc(ME.name)}</h2><p class="muted">${esc(ME.email)} · ${esc(label(ME.role))}</p>
      <form id="pw-form" novalidate><h3 style="margin:18px 0 10px">Change password</h3>${field('Current password', '<input type="password" name="current" autocomplete="current-password" required>')}
      ${field('New password', '<input type="password" name="next" autocomplete="new-password" minlength="10" required>', 'At least 10 characters. Other devices are signed out.')}
      <button class="btn-primary">Change password</button></form></div>`;
    panel.querySelector('#pw-form').addEventListener('submit', (e) => { e.preventDefault(); busy(e.submitter, async () => { await api('/api/me/password', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))) }); e.target.reset(); toast('Password changed'); }); });
  }
  if (tab === 'company') {
    const { company: c } = await getLibrary(true), A = can('admin'), dis = A ? '' : 'disabled';
    const inp = (k, l, t = 'text') => field(l, `<input name="${k}" type="${t}" value="${esc(c[k] ?? '')}" ${dis}>`);
    panel.innerHTML = `<form class="card" id="co-form" style="max-width:820px" novalidate><h2>Company details</h2><p class="muted small" style="margin-top:-8px">Printed on every proposal and contract. ${A ? '' : 'Only an administrator can change these.'}</p>
      <div class="fields">${inp('name', 'Company name')}${inp('company_number', 'Company number')}${inp('vat_number', 'VAT number')}<div class="wide">${inp('address', 'Address')}</div>
      ${inp('phone', 'Phone')}${inp('email', 'Email', 'email')}${inp('website', 'Website')}${inp('signatory_name', 'Signatory name')}${inp('signatory_title', 'Signatory job title')}${inp('signatory_email', 'Signatory email (DocuSeal)', 'email')}
      ${field('Default VAT', `<select name="vat_rate_bp" ${dis}>${[[2000, '20%'], [500, '5%'], [0, 'Not VAT registered']].map(([v, t]) => `<option value="${v}" ${Number(c.vat_rate_bp) === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`)}
      ${field('Proposals valid for (days)', `<input type="number" name="proposal_valid_days" min="1" max="365" value="${esc(c.proposal_valid_days ?? 30)}" ${dis}>`)}
      ${field('Signing order', `<select name="sign_order" ${dis}>${[['fc_first', 'FC signs first, then the customer'], ['client_first', 'Customer first, then FC'], ['together', 'Both at the same time']].map(([v, t]) => `<option value="${v}" ${(c.sign_order || 'fc_first') === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`)}</div>
      ${A ? '<button class="btn-primary">Save</button>' : ''}</form>`;
    panel.querySelector('#co-form').addEventListener('submit', (e) => { e.preventDefault(); busy(e.submitter, async () => { const b = Object.fromEntries(new FormData(e.target)); b.vat_rate_bp = Number(b.vat_rate_bp); b.proposal_valid_days = Number(b.proposal_valid_days); await api('/api/company', { method: 'PUT', body: JSON.stringify(b) }); LIBRARY = null; toast('Company details saved'); }); });
  }
  if (tab === 'library') {
    const lib = await getLibrary(true), M = can('manager');
    const group = (dt) => lib.blocks.filter((b) => b.doc_type === dt).map((b) => `<div class="list-row"><span><b>${esc(b.title)}</b> ${b.active ? '' : badge('archived')}${b.required ? ' <span class="badge">Required</span>' : ''}<span class="sub muted small">${esc(b.body.slice(0, 110))}${b.body.length > 110 ? '…' : ''}</span></span>${M ? `<button class="btn-ghost btn-sm" data-block="${b.id}">Edit</button>` : ''}</div>`).join('');
    panel.innerHTML = `<div class="card"><div class="card-head"><h2>Service templates & pricing items</h2>${M ? '<button class="btn-primary btn-sm" id="lib-addsvc">+ Service</button>' : ''}</div>
      <p class="small muted" style="margin-top:-6px">Starting points for proposals — every value can be changed per proposal.</p>
      <div class="table-wrap"><table class="mobile-cards"><thead><tr><th>Service</th><th>Billed</th><th>Frequency</th><th class="num">Price / rate</th><th></th></tr></thead><tbody>
      ${lib.services.map((s) => `<tr><td>${esc(s.name)} ${s.active ? '' : badge('archived')}</td><td>${s.billing === 'hourly' ? 'Hourly' : 'Fixed'}</td><td>${esc(label(s.frequency))}${s.visits_per_week ? ` · ${Number(s.visits_per_week)}/wk` : ''}${s.hours_per_visit ? ` · ${Number(s.hours_per_visit)}h` : ''}</td>
        <td class="num money">${s.billing === 'hourly' ? (s.rate_pence != null ? `${money(s.rate_pence)}/h` : 'set per proposal') : (s.price_pence != null ? money(s.price_pence) : 'set per proposal')}</td><td class="num">${M ? `<button class="btn-ghost btn-sm" data-svc="${s.id}">Edit</button>` : ''}</td></tr>`).join('')}</tbody></table></div></div>
      <div class="grid-2"><div class="card"><div class="card-head"><h2>Proposal sections</h2>${M ? '<button class="btn-ghost btn-sm" data-newblock="proposal">+ Section</button>' : ''}</div>${group('proposal')}</div>
      <div class="card"><div class="card-head"><h2>Contract clauses</h2>${M ? '<button class="btn-ghost btn-sm" data-newblock="contract">+ Clause</button>' : ''}</div>${group('contract')}
        <p class="small muted">This wording came from FC’s own templates. It is not legal advice — have a solicitor review the clauses, particularly liability, insurance and termination.</p></div></div>`;
    const svcForm = (s = {}) => `<div class="fields">${field('Name *', `<input name="name" required value="${esc(s.name || '')}">`)}
      ${field('Billed', `<select name="billing"><option value="fixed">Fixed price</option><option value="hourly" ${s.billing === 'hourly' ? 'selected' : ''}>Hourly rate</option></select>`)}
      ${field('Frequency', `<select name="frequency">${FREQ.map(([v, t]) => `<option value="${v}" ${v === s.frequency ? 'selected' : ''}>${t}</option>`).join('')}</select>`)}
      ${field('Visits / week', `<input type="number" step="0.5" name="visits_per_week" value="${esc(num(s.visits_per_week))}">`)}${field('Hours / visit', `<input type="number" step="0.25" name="hours_per_visit" value="${esc(num(s.hours_per_visit))}">`)}
      ${field('Staff', `<input type="number" name="staff" value="${esc(s.staff ?? '')}">`)}${field('Price (fixed) £', `<input inputmode="decimal" name="price" value="${fromPence(s.price_pence)}">`)}${field('Rate (hourly) £', `<input inputmode="decimal" name="rate" value="${fromPence(s.rate_pence)}">`)}
      ${field('Sort order', `<input type="number" name="sort" value="${esc(s.sort ?? 0)}">`)}</div>
      ${field('Scope of work', `<textarea name="scope" rows="8">${esc(s.scope || '')}</textarea>`, '“- ” bullet · “### ” area heading')}
      <label class="check"><input type="checkbox" name="active" ${s.active === false ? '' : 'checked'}> Active (offered in new proposals)</label>`;
    const saveSvc = (s) => modal({ title: s ? 'Edit service' : 'New service', wide: true, body: svcForm(s), onSubmit: (f, fd) => {
      const price = toPence(fd.get('price')), rate = toPence(fd.get('rate'));
      if (Number.isNaN(price) || Number.isNaN(rate)) throw new Error('Prices must be like 12.50');
      const body = { name: fd.get('name'), billing: fd.get('billing'), frequency: fd.get('frequency'), visits_per_week: fd.get('visits_per_week'), hours_per_visit: fd.get('hours_per_visit'), staff: fd.get('staff'), price_pence: price, rate_pence: rate, scope: fd.get('scope'), sort: fd.get('sort'), active: fd.has('active') };
      return api(s ? `/api/library/services/${s.id}` : '/api/library/services', { method: s ? 'PUT' : 'POST', body: JSON.stringify(body) });
    } }).then((r) => { if (r) { LIBRARY = null; toast('Saved'); reload(); } });
    const saveBlock = (b, docType) => modal({ title: b ? `Edit: ${b.title}` : `New ${docType} section`, wide: true, body: `${b ? '' : field('Key *', '<input name="key" required placeholder="e.g. waste_handling">', 'Lowercase, used internally')}
      ${field('Title *', `<input name="title" required value="${esc(b?.title || '')}">`)}${field('Wording', `<textarea name="body" rows="14" style="font-family:ui-monospace,monospace;font-size:13px">${esc(b?.body || '')}</textarea>`, 'Applies to NEW proposals/contracts. Ones already started keep their own copy.')}
      ${b?.required ? '' : `<label class="check"><input type="checkbox" name="active" ${b?.active === false ? '' : 'checked'}> Included in new documents</label>`}`,
    onSubmit: (f, fd) => api(b ? `/api/library/blocks/${b.id}` : '/api/library/blocks', { method: b ? 'PUT' : 'POST', body: JSON.stringify({ doc_type: docType, key: fd.get('key'), title: fd.get('title'), body: fd.get('body'), active: b?.required ? true : fd.has('active'), sort: b?.sort }) }) })
      .then((r) => { if (r) { LIBRARY = null; toast('Saved'); reload(); } });
    panel.querySelector('#lib-addsvc')?.addEventListener('click', () => saveSvc());
    panel.onclick = (e) => {
      if (e.target.dataset.svc) saveSvc(lib.services.find((s) => s.id === e.target.dataset.svc));
      if (e.target.dataset.block) { const b = lib.blocks.find((x) => x.id === e.target.dataset.block); saveBlock(b, b.doc_type); }
      if (e.target.dataset.newblock) saveBlock(null, e.target.dataset.newblock);
    };
  }
  if (tab === 'automations') {
    const { rules, settings } = await api('/api/automation'), A = can('admin');
    panel.innerHTML = `<form class="card" id="au-form" style="max-width:820px" novalidate><h2>Automations</h2><p class="small muted" style="margin-top:-6px">These create internal tasks and update statuses. None of them email customers.${A ? '' : ' Only an administrator can change them.'}</p>
      ${Object.entries(rules).map(([k, r]) => { const s = settings[k] || {}; return `<div class="list-row"><label class="check"><input type="checkbox" name="${k}.enabled" ${s.enabled !== false ? 'checked' : ''} ${A ? '' : 'disabled'}> ${esc(r.label)}</label>
        ${r.unit ? `<span class="row"><input type="number" min="0" max="365" name="${k}.${r.unit}" value="${esc(s[r.unit] ?? '')}" style="width:80px" ${A ? '' : 'disabled'} aria-label="${r.unit}"> <span class="muted small">${r.unit}</span></span>` : ''}</div>`; }).join('')}
      ${A ? '<div class="row end" style="margin-top:12px"><button class="btn-primary">Save automations</button></div>' : ''}</form>`;
    panel.querySelector('#au-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const out = {};
      for (const k of Object.keys(rules)) { out[k] = { enabled: e.target.querySelector(`[name="${k}.enabled"]`).checked }; const u = rules[k].unit; if (u) out[k][u] = e.target.querySelector(`[name="${k}.${u}"]`).value; }
      busy(e.submitter, async () => { await api('/api/automation', { method: 'PUT', body: JSON.stringify(out) }); toast('Automations saved'); });
    });
  }
  if (tab === 'users') {
    const users = await api('/api/users');
    panel.innerHTML = `<div class="card table-card"><div class="card-head" style="padding:16px 20px 0"><h2>Users</h2><button class="btn-primary btn-sm" id="u-add">+ Add user</button></div>
      <p class="small muted" style="padding:0 20px">Staff: customers, tasks, visits, draft proposals. Managers: also send proposals, contracts, signatures, exports, library. Administrators: also users, company, automations, audit log.</p>
      <div class="table-wrap"><table class="mobile-cards"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last sign-in</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr><td>${esc(u.name)} ${u.active ? '' : badge('archived')}</td><td>${esc(u.email)}</td><td>${esc(label(u.role))}</td><td class="muted">${u.last_login_at ? fmtDT(u.last_login_at) : 'never'}</td><td class="num"><button class="btn-ghost btn-sm" data-u="${u.id}">Edit</button></td></tr>`).join('')}</tbody></table></div></div>`;
    const showPw = (u) => modal({ title: 'Password for ' + u.name, body: `<p>Give this to ${esc(u.name)} privately. It is shown once.</p><div class="copy-row"><input id="newpw" readonly value="${esc(u.password)}"><button type="button" class="btn-secondary" data-copy="newpw">Copy</button></div><p class="small muted">They should change it under Settings → My account.</p>`, noSubmit: true, cancel: 'Done' });
    panel.querySelector('#u-add').onclick = async () => {
      const u = await modal({ title: 'Add user', body: `${field('Name *', '<input name="name" required>')}${field('Email *', '<input name="email" type="email" required>')}${field('Role', '<select name="role"><option value="staff">Staff</option><option value="manager">Manager</option><option value="admin">Administrator</option></select>')}`, submit: 'Create user',
        onSubmit: (f, fd) => api('/api/users', { method: 'POST', body: JSON.stringify(Object.fromEntries(fd)) }) });
      if (u) { await showPw(u); reload(); }
    };
    panel.onclick = async (e) => {
      const u = users.find((x) => x.id === e.target.dataset.u);
      if (!u) return;
      const r = await modal({ title: `Edit ${u.name}`, body: `${field('Name', `<input name="name" value="${esc(u.name)}">`)}${field('Role', `<select name="role">${['staff', 'manager', 'admin'].map((x) => `<option value="${x}" ${x === u.role ? 'selected' : ''}>${label(x === 'admin' ? 'administrator' : x)}</option>`).join('')}</select>`)}
        <label class="check"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> Can sign in</label><label class="check"><input type="checkbox" name="reset_password"> Reset password (signs them out)</label>`,
        onSubmit: (f, fd) => api(`/api/users/${u.id}`, { method: 'PATCH', body: JSON.stringify({ name: fd.get('name'), role: fd.get('role'), active: fd.has('active'), reset_password: fd.has('reset_password') }) }) });
      if (r?.password) await showPw({ ...r, name: u.name });
      if (r) { toast('User updated'); USERS = await api('/api/users').then((l) => l.filter((x) => x.active !== false)); reload(); }
    };
  }
  if (tab === 'integrations') {
    const [i, h] = await Promise.all([api('/api/integrations'), api('/api/health')]);
    const row = (name, ok, text) => `<div class="list-row"><span><b>${name}</b><span class="sub muted small">${text}</span></span>${ok ? '<span class="badge b-active">Connected</span>' : '<span class="badge b-failed">Not set up</span>'}</div>`;
    panel.innerHTML = `<div class="card" style="max-width:820px"><h2>Integrations</h2>
      ${row('DocuSeal e-signatures', i.docuseal.configured, `${esc(i.docuseal.url)} — API key and webhook secret are kept on the server (.env), never in the browser.`)}
      ${row('Email (iCloud SMTP)', h.email, 'Used to send proposals and booking emails, from fernando.c@fccleaningcompany.com.')}
      ${row('Private document storage', h.storage, 'perchito-storage project “fc-crm” — backed up nightly and offsite (B2).')}
      ${row('SMS', h.sms, 'Optional, for campaign SMS steps.')}</div>`;
  }
  if (tab === 'audit') {
    const rows = await api('/api/audit?limit=300');
    panel.innerHTML = `<div class="card table-card"><h2>Audit log <span class="small muted">(latest 300, can’t be edited)</span></h2><div class="table-wrap"><table class="mobile-cards"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Details</th></tr></thead><tbody>
      ${rows.map((a) => `<tr><td class="muted">${fmtDT(a.at)}</td><td>${esc(a.user_name || 'system')}</td><td>${esc(label(a.action))}</td><td class="muted">${esc(a.entity || '')}${a.entity_id ? ` ${esc(String(a.entity_id).slice(0, 8))}` : ''}</td><td class="muted small">${esc(JSON.stringify(a.detail)).slice(0, 160)}</td></tr>`).join('')}</tbody></table></div></div>`;
  }
}
// Settings needs its section's static markup (outreach forms), so the router mustn't wipe it
VIEWS.settings.render = (el, id) => renderSettings(el, id);
// the existing outreach settings form: confirm saves
document.getElementById('settings-form').addEventListener('submit', () => setTimeout(() => toast('Sending window saved'), 300));

// ── start ────────────────────────────────────────────────
(async function init() {
  try { ME = await api('/api/me'); } catch { return; }
  USERS = await api('/api/users').then((l) => l.filter((u) => u.active !== false)).catch(() => []);
  document.getElementById('side-user').innerHTML = `<b>${esc(ME.name)}</b><small>${esc(label(ME.role === 'admin' ? 'administrator' : ME.role))}</small><br><button id="logout">Sign out</button>`;
  document.getElementById('logout').onclick = async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); location.href = '/login'; };
  document.querySelectorAll('.tab[data-view]').forEach((a) => a.addEventListener('click', () => { if (location.hash === a.getAttribute('href')) route(); }));
  route();
  refreshNavCount();
  setInterval(refreshNavCount, 5 * 60_000);
})();
