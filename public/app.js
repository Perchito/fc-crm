const STAGES = [
  ['new', 'New'],
  ['contacted', 'Contacted'],
  ['visit_booked', 'Visit booked'],
  ['quoted', 'Quoted'],
  ['won', 'Won'],
  ['lost', 'Lost'],
];
const STAGE_LABEL = Object.fromEntries(STAGES);

let contacts = [];
let BOOK_URL = 'https://book.fccleaningcompany.com'; // customer booking page (personal link adds ?c=<token>); real value from the server below

// Manchester (Fernando) / London (Luis): the area being viewed goes on every call as X-FC-Area ('' = all).
// Remembered per browser; the first visit opens on the signed-in person's own area (set in biz.js init).
let AREA = (() => { try { return localStorage.getItem('fc-area'); } catch { return null; } })();
const AREA_LABEL = { manchester: 'Manchester', london: 'London' };

// every call carries the CSRF header; an expired session goes back to the sign-in page;
// errors carry the server's readable message (and .data, e.g. a list of problems)
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-FC-CSRF': '1', ...(AREA ? { 'X-FC-Area': AREA } : {}), ...(opts && opts.headers) },
  });
  if (res.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
  if (!res.ok) {
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch { data = { error: text }; }
    throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
  }
  if (res.status === 204) return null;
  return (res.headers.get('content-type') || '').includes('json') ? res.json() : res.text();
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function pill(stage) { return `<span class="pill pill-${stage}">${escapeHtml(STAGE_LABEL[stage] || stage)}</span>`; }

async function loadContacts() {
  contacts = await api('/api/pipeline');
  renderBoard();
}

// ── pipeline (kanban) ────────────────────────────────────
const daysSince = (d) => Math.max(0, Math.floor((Date.now() - new Date(d)) / 86400000));
function pipeFiltered() {
  const q = (document.getElementById('pipe-search')?.value || '').toLowerCase();
  const owner = document.getElementById('pipe-owner')?.value, source = document.getElementById('pipe-source')?.value;
  return contacts.filter((c) => (!owner || c.owner_id === owner) && (!source || (c.source || '') === source)
    && (!q || [c.business, c.contact_name, c.email, c.source].some((v) => (v || '').toLowerCase().includes(q))));
}
function renderBoard() {
  const board = document.getElementById('board');
  if (!board) return;
  const list = pipeFiltered();
  // filter options from the data
  const srcSel = document.getElementById('pipe-source'), ownSel = document.getElementById('pipe-owner');
  const keep = (sel, opts) => { const v = sel.value; sel.innerHTML = sel.options[0].outerHTML + opts.map(([val, label]) => `<option value="${escapeHtml(val)}">${escapeHtml(label)}</option>`).join(''); sel.value = v; };
  keep(srcSel, [...new Set(contacts.map((c) => c.source).filter(Boolean))].sort().map((s) => [s, s]));
  keep(ownSel, [...new Map(contacts.filter((c) => c.owner_id).map((c) => [c.owner_id, c.owner_name])).entries()]);
  // conversion summary: how many reached each stage or beyond (lost excluded from the chain)
  const order = ['new', 'contacted', 'visit_booked', 'quoted', 'won'];
  const reached = order.map((st, i) => list.filter((c) => order.indexOf(c.pipeline_stage) >= i).length);
  document.getElementById('pipe-summary').innerHTML = order.map((st, i) => `<div class="ps-step"><b>${list.filter((c) => c.pipeline_stage === st).length}</b><span>${STAGE_LABEL[st]}</span>${i ? `<small title="Share of customers at ${STAGE_LABEL[order[i - 1]]} or beyond that reached ${STAGE_LABEL[st]} or beyond">${reached[i - 1] ? Math.round((reached[i] / reached[i - 1]) * 100) : 0}% from previous</small>` : '<small>in stage</small>'}</div>`).join('')
    + `<div class="ps-step lost"><b>${list.filter((c) => c.pipeline_stage === 'lost').length}</b><span>Lost</span><small>in stage</small></div>`;
  board.innerHTML = '';
  for (const [stage, label] of STAGES) {
    const col = document.createElement('div');
    col.className = 'column';
    col.dataset.stage = stage;
    const inStage = list.filter((c) => c.pipeline_stage === stage);
    const value = inStage.reduce((a, c) => a + Number(c.quoted_monthly_pence || 0), 0);
    col.innerHTML = `<h2><span class="col-dot dot-${stage}"></span>${label} <span>${inStage.length}</span></h2>${value ? `<div class="col-value" title="Monthly value of proposals awaiting a reply (ex VAT) — not revenue">${typeof money === 'function' ? money(value) : ''}/mo quoted</div>` : ''}`;
    for (const c of inStage.slice(0, 200)) col.appendChild(renderCard(c));
    if (inStage.length > 200) col.insertAdjacentHTML('beforeend', `<p class="empty">+ ${inStage.length - 200} more — use the filter above</p>`);
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const id = e.dataTransfer.getData('text/plain');
      moveStage(contacts.find((c) => c.id === id), stage);
    });
    board.appendChild(col);
  }
}
async function moveStage(contact, stage) {
  if (!contact || contact.pipeline_stage === stage) return;
  const prev = contact.pipeline_stage;
  contact.pipeline_stage = stage; contact.stage_since = new Date().toISOString();
  renderBoard();
  try {
    await api(`/api/contacts/${contact.id}`, { method: 'PATCH', body: JSON.stringify({ pipeline_stage: stage }) });
    toast(`${contact.business || 'Customer'} → ${STAGE_LABEL[stage]}`);
  } catch (err) { contact.pipeline_stage = prev; renderBoard(); toast(err.message, 'error'); }
}

function renderCard(c) {
  const card = document.createElement('div');
  card.className = 'card kanban-card';
  card.draggable = true;
  card.tabIndex = 0;
  const overdue = c.next_task_due && new Date(c.next_task_due) < new Date();
  card.innerHTML = `<div class="biz">${escapeHtml(c.business || '(no name)')}</div>
    <div class="meta">${escapeHtml(c.contact_name || c.email || c.phone || '')}</div>
    ${c.next_task ? `<div class="next ${overdue ? 'overdue' : ''}" title="Next task">→ ${escapeHtml(c.next_task)}${c.next_task_due ? ` · ${new Date(c.next_task_due).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}</div>` : '<div class="next none">No next action</div>'}
    <div class="card-foot"><span title="Days in this stage">${daysSince(c.stage_since)}d in stage</span>${c.source ? `<span>${escapeHtml(c.source)}</span>` : ''}</div>
    <select class="card-stage" aria-label="Stage">${STAGES.map(([v, l]) => `<option value="${v}" ${v === c.pipeline_stage ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  card.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', c.id));
  card.addEventListener('click', () => openDrawer(c.id));
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === card) openDrawer(c.id); });
  const stageSelect = card.querySelector('.card-stage');
  stageSelect.addEventListener('click', (e) => e.stopPropagation());
  stageSelect.addEventListener('change', (e) => moveStage(c, e.target.value));
  return card;
}
for (const id of ['pipe-search', 'pipe-owner', 'pipe-source']) document.getElementById(id)?.addEventListener('input', renderBoard);

// ── draft editor (drawer + Drafts page) ─────────────────
function draftBox(d, after) {
  const box = document.createElement('div');
  box.className = 'section draft-box';
  box.innerHTML = `
    <strong style="font-size:13px">${d.step_index > 0 ? 'Follow-up email' : 'AI-drafted email'}</strong>
    <input class="d-subject" value="${escapeHtml(d.subject || '')}" style="margin-top:8px" />
    <textarea class="d-body" rows="8">${escapeHtml(d.body || '')}</textarea>
    <div style="display:flex;gap:8px;margin-top:8px">
      <button class="btn-primary d-send">Send</button>
      <button class="btn-secondary d-discard">Discard</button>
    </div>
  `;
  box.querySelector('.d-subject').addEventListener('change', (e) => api(`/api/sends/${d.id}`, { method: 'PATCH', body: JSON.stringify({ subject: e.target.value }) }));
  box.querySelector('.d-body').addEventListener('change', (e) => api(`/api/sends/${d.id}`, { method: 'PATCH', body: JSON.stringify({ body: e.target.value }) }));
  box.querySelector('.d-send').addEventListener('click', async (e) => {
    e.target.disabled = true;
    const subject = box.querySelector('.d-subject').value;
    const body = box.querySelector('.d-body').value;
    try {
      await api(`/api/sends/${d.id}`, { method: 'PATCH', body: JSON.stringify({ subject, body }) });
      await api(`/api/sends/${d.id}/send`, { method: 'POST' });
    } catch (err) { toast(`Send failed: ${err.message}`, 'error'); e.target.disabled = false; return; }
    toast('Email sent');
    after();
  });
  box.querySelector('.d-discard').addEventListener('click', async () => {
    if (!(await confirmDialog({ title: 'Discard this draft?', body: 'The email won’t be sent and the sequence stops for this lead.', confirmText: 'Discard', danger: true }))) return;
    await api(`/api/sends/${d.id}/discard`, { method: 'POST' });
    after();
  });
  return box;
}

// ── drafts page ─────────────────────────────────────────
async function loadDraftsView() {
  const drafts = await api('/api/drafts');
  document.getElementById('drafts-page-count').textContent =
    `${drafts.length} waiting. Nothing is sent until you press Send.`;
  const list = document.getElementById('drafts-list');
  list.innerHTML = drafts.length ? '' : '<p class="empty">Nothing waiting — new leads and due follow-ups get drafted here automatically.</p>';
  for (const d of drafts) {
    const card = document.createElement('div');
    card.className = 'card draft-card';
    const site = /^https?:\/\//i.test(d.website || '') ? `<a href="${escapeHtml(d.website)}" target="_blank" rel="noopener">${escapeHtml(d.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a>` : '';
    card.innerHTML = `
      <div class="row1"><h3><a href="#" class="open-lead">${escapeHtml(d.business || '(no name)')}</a></h3>
        <span class="dim">${escapeHtml(d.campaign_name || '')}</span></div>
      <div class="meta">${[escapeHtml(d.email || ''), site, escapeHtml(d.address || '')].filter(Boolean).join(' · ')}</div>
      ${d.notes ? `<p class="about">${escapeHtml(d.notes).replace(/\n+/g, '<br>')}</p>` : ''}
    `;
    card.querySelector('.open-lead').addEventListener('click', async (e) => {
      e.preventDefault();
      if (!contacts.length) await loadContacts();
      openDrawer(d.contact_id);
    });
    card.appendChild(draftBox(d, loadDraftsView));
    list.appendChild(card);
  }
}

api('/api/booking-settings').then((b) => { BOOK_URL = b.booking_url; }).catch(() => {});

// ── calendar (busy blocks + booked visits) ──────────────
const SLOT_MIN = 30, ROWS = 48;
// phones get a one-day view (pick the day from a strip) with taller, easier-to-tap rows
const calMobile = matchMedia('(max-width: 700px)');
let ROW_PX = calMobile.matches ? 30 : 20;
let calDay = (new Date().getDay() + 6) % 7; // 0 = Monday of calWeek
let calWeek = startOfWeek(new Date()), calAnchor = null, calItems = {};
function startOfWeek(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const atSlot = (day, i) => { const x = new Date(day); x.setMinutes(i * SLOT_MIN); return x; };
const hhmm = (d) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

async function loadCalendarView(scrollTo7am = false) {
  const from = calWeek, to = addDays(calWeek, 7);
  const [{ blocks, appointments }, bs] = await Promise.all([
    api(`/api/calendar?from=${from.toISOString()}&to=${to.toISOString()}`), api('/api/booking-settings')]);
  calItems = Object.fromEntries([...blocks.map((b) => [b.id, { ...b, kind: 'block' }]), ...appointments.map((a) => [a.id, { ...a, kind: 'appt' }])]);
  document.getElementById('cal-label').textContent =
    `${from.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${addDays(from, 6).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
  document.getElementById('cal-book-url').value = bs.booking_url;
  document.getElementById('cal-ics-url').value = bs.ics_url;
  for (const k of ['visit_minutes', 'gap_minutes', 'day_start', 'day_end', 'min_notice_hours', 'horizon_days']) document.getElementById(`bs-${k}`).value = bs[k];

  const cal = document.getElementById('cal');
  const today = new Date().toDateString();
  ROW_PX = calMobile.matches ? 30 : 20;
  const shown = calMobile.matches ? [calDay] : [0, 1, 2, 3, 4, 5, 6];
  cal.style.gridTemplateColumns = `52px repeat(${shown.length}, minmax(0, 1fr))`;
  const onDay = (list, d, key = 'starts_at') => list.filter((x) => new Date(x[key]).toDateString() === addDays(from, d).toDateString());
  document.getElementById('cal-days').innerHTML = calMobile.matches ? [0, 1, 2, 3, 4, 5, 6].map((d) => {
    const day = addDays(from, d), nb = onDay(blocks, d).length, na = onDay(appointments, d).length;
    return `<button class="cal-day ${d === calDay ? 'on' : ''} ${day.toDateString() === today ? 'today' : ''}" data-day="${d}">
      <small>${day.toLocaleDateString('en-GB', { weekday: 'short' })}</small><b>${day.getDate()}</b>
      <span class="marks">${nb ? '<i class="m-block"></i>' : ''}${na ? '<i class="m-appt"></i>' : ''}</span></button>`;
  }).join('') : '';
  let html = '<div class="cal-corner"></div>';
  for (const d of shown) {
    const day = addDays(from, d);
    html += `<div class="cal-dayhead ${day.toDateString() === today ? 'today' : ''}">${day.toLocaleDateString('en-GB', { weekday: 'short' })} <b>${day.getDate()}</b></div>`;
  }
  html += '<div class="cal-gutter">' + Array.from({ length: 24 }, (_, h) => `<div style="height:${ROW_PX * 2}px">${h ? `${String(h).padStart(2, '0')}:00` : ''}</div>`).join('') + '</div>';
  for (const d of shown) html += `<div class="cal-col" data-d="${d}" style="height:${ROWS * ROW_PX}px;background-size:100% ${ROW_PX * 2}px"></div>`;
  cal.innerHTML = html;

  const place = (startMs, endMs, d) => {
    const dayStart = addDays(from, d).getTime(), dayEnd = addDays(from, d + 1).getTime();
    const s = Math.max(startMs, dayStart), e = Math.min(endMs, dayEnd);
    if (e <= s) return null;
    return `top:${((s - dayStart) / 60000 / SLOT_MIN) * ROW_PX}px;height:${Math.max(((e - s) / 60000 / SLOT_MIN) * ROW_PX, 14)}px`;
  };
  cal.querySelectorAll('.cal-col').forEach((col) => {
    const d = Number(col.dataset.d);
    for (const b of blocks) {
      const st = place(new Date(b.starts_at).getTime(), new Date(b.ends_at).getTime(), d);
      if (st) col.insertAdjacentHTML('beforeend', `<button class="cal-ev block" data-block="${b.id}" style="${st}" title="Click to remove">${escapeHtml(b.title)}<span>${hhmm(b.starts_at)}–${hhmm(b.ends_at)}</span></button>`);
    }
    for (const a of appointments) {
      const end = a.ends_at ? new Date(a.ends_at).getTime() : new Date(a.starts_at).getTime() + 45 * 60000;
      const st = place(new Date(a.starts_at).getTime(), end, d);
      if (st) col.insertAdjacentHTML('beforeend', `<button class="cal-ev appt" data-appt="${a.id}" style="${st}">${escapeHtml(a.business || a.contact_name || a.title)}<span>${hhmm(a.starts_at)} · ${escapeHtml(a.title)}</span></button>`);
    }
  });
  // nothing is booked 10pm-7am, so each time the page opens, start the view at 7am
  if (scrollTo7am) cal.parentElement.scrollTop = 7 * (60 / SLOT_MIN) * ROW_PX - 12; // -12 keeps the "07:00" label visible
}

// drag (mouse) or tap-start-then-tap-end (touch) to add a busy block
function calSlotAt(col, clientY) { return Math.max(0, Math.min(ROWS - 1, Math.floor((clientY - col.getBoundingClientRect().top) / ROW_PX))); }
function calPreview(col, a, b) {
  col.querySelector('.cal-sel')?.remove();
  const [lo, hi] = [Math.min(a, b), Math.max(a, b)];
  col.insertAdjacentHTML('beforeend', `<div class="cal-sel" style="top:${lo * ROW_PX}px;height:${(hi - lo + 1) * ROW_PX}px">${hhmm(atSlot(addDays(calWeek, +col.dataset.d), lo))}–${hhmm(atSlot(addDays(calWeek, +col.dataset.d), hi + 1))}</div>`);
}
async function calCreate(col, a, b) {
  const day = addDays(calWeek, +col.dataset.d);
  const [lo, hi] = [Math.min(a, b), Math.max(a, b)];
  await api('/api/blocks', { method: 'POST', body: JSON.stringify({ starts_at: atSlot(day, lo).toISOString(), ends_at: atSlot(day, hi + 1).toISOString(), title: "Dave's Hot Chicken" }) });
  calAnchor = null;
  calHint(null);
  loadCalendarView();
}
function calHint(text) {
  document.getElementById('cal-hint').hidden = !text;
  if (text) document.getElementById('cal-hint-text').textContent = text;
}
document.getElementById('cal-hint-cancel').addEventListener('click', () => { calAnchor = null; calHint(null); document.querySelectorAll('.cal-sel').forEach((x) => x.remove()); });
document.getElementById('cal-days').addEventListener('click', (e) => {
  const b = e.target.closest('.cal-day');
  if (!b) return;
  calDay = +b.dataset.day; calAnchor = null; calHint(null);
  loadCalendarView();
});
calMobile.addEventListener('change', () => { if (!document.getElementById('view-calendar').classList.contains('hidden')) loadCalendarView(true); });
const calEl = document.getElementById('cal');
let calDrag = null;
calEl.addEventListener('pointerdown', (e) => {
  const col = e.target.closest('.cal-col');
  if (!col || e.target.closest('.cal-ev')) return;
  if (e.pointerType !== 'mouse') return; // touch/pen: tap-tap via click below, so scrolling never selects
  const i = calSlotAt(col, e.clientY);
  calDrag = { col, a: i }; calPreview(col, i, i); e.preventDefault();
});
let calLastPointer = 'mouse';
calEl.addEventListener('pointerdown', (e) => { calLastPointer = e.pointerType; }, true);
calEl.addEventListener('pointermove', (e) => { if (calDrag) calPreview(calDrag.col, calDrag.a, calSlotAt(calDrag.col, e.clientY)); });
window.addEventListener('pointerup', (e) => { if (!calDrag) return; const { col, a } = calDrag; calDrag = null; calCreate(col, a, calSlotAt(col, e.clientY)); });
calEl.addEventListener('click', async (e) => {
  const ev = e.target.closest('.cal-ev');
  const col = e.target.closest('.cal-col');
  if (!ev && col && calLastPointer !== 'mouse') {
    const i = calSlotAt(col, e.clientY);
    if (calAnchor && calAnchor.col === col) return calCreate(col, calAnchor.a, i);
    document.querySelectorAll('.cal-sel').forEach((x) => x.remove());
    calAnchor = { col, a: i }; calPreview(col, i, i);
    calHint(`Starts ${hhmm(atSlot(addDays(calWeek, +col.dataset.d), i))} — now tap the end time`);
    return;
  }
  if (!ev) return;
  calEdit(calItems[ev.dataset.block || ev.dataset.appt]);
});

// edit sheet: move / resize / relabel a shift, or move / cancel a booked visit
const ceDlg = document.getElementById('cal-edit');
let ceItem = null;
const pad = (n) => String(n).padStart(2, '0');
const dateVal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeVal = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
function calEdit(item) {
  if (!item) return;
  ceItem = item;
  const s = new Date(item.starts_at), e = new Date(item.ends_at || s.getTime() + 45 * 60000);
  const appt = item.kind === 'appt';
  document.getElementById('ce-title').textContent = appt ? `Visit — ${item.business || item.contact_name || ''}` : 'Shift / busy time';
  document.getElementById('ce-sub').textContent = appt ? (item.address || '') : 'Customers can’t book during this time.';
  document.getElementById('ce-name-row').hidden = appt;
  document.getElementById('ce-name').value = appt ? '' : item.title;
  document.getElementById('ce-date').value = dateVal(s);
  document.getElementById('ce-start').value = timeVal(s);
  document.getElementById('ce-end').value = timeVal(e);
  document.getElementById('ce-notify-row').hidden = !appt;
  document.getElementById('ce-notify').checked = true;
  document.getElementById('ce-lead').hidden = !appt;
  document.getElementById('ce-delete').textContent = appt ? 'Cancel visit' : 'Delete shift';
  document.getElementById('ce-err').textContent = '';
  ceDlg.showModal();
}
document.getElementById('ce-form').addEventListener('submit', async (e) => {
  const action = e.submitter?.value;
  if (action === 'close' || !ceItem) return;
  e.preventDefault();
  const appt = ceItem.kind === 'appt';
  const notify = document.getElementById('ce-notify').checked;
  const err = document.getElementById('ce-err');
  try {
    if (action === 'lead') {
      ceDlg.close();
      if (!contacts.length) await loadContacts();
      return openDrawer(ceItem.contact_id);
    }
    if (action === 'delete') {
      if (!(await confirmDialog({ title: appt ? 'Cancel this visit?' : 'Delete this shift?', body: appt && notify ? 'The customer will be emailed.' : '', confirmText: appt ? 'Cancel visit' : 'Delete', danger: true }))) return;
      if (appt) await api(`/api/appointments/${ceItem.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled', notify }) });
      else await api(`/api/blocks/${ceItem.id}`, { method: 'DELETE' });
    } else {
      const d = document.getElementById('ce-date').value;
      const start = new Date(`${d}T${document.getElementById('ce-start').value}`);
      let end = new Date(`${d}T${document.getElementById('ce-end').value}`);
      if (end <= start) end = new Date(end.getTime() + 86400000); // e.g. 18:00 -> 01:00 runs past midnight
      const body = { starts_at: start.toISOString(), ends_at: end.toISOString() };
      if (appt) await api(`/api/appointments/${ceItem.id}`, { method: 'PATCH', body: JSON.stringify({ ...body, notify }) });
      else await api(`/api/blocks/${ceItem.id}`, { method: 'PATCH', body: JSON.stringify({ ...body, title: document.getElementById('ce-name').value.trim() }) });
    }
    ceDlg.close();
    loadCalendarView();
  } catch (ex) { err.textContent = String(ex.message || ex).replace(/^\{"error":"|"\}$/g, ''); }
});
ceDlg.addEventListener('click', (e) => { if (e.target === ceDlg) ceDlg.close(); }); // tap outside closes
document.getElementById('cal-prev').addEventListener('click', () => { calWeek = addDays(calWeek, -7); loadCalendarView(); });
document.getElementById('cal-next').addEventListener('click', () => { calWeek = addDays(calWeek, 7); loadCalendarView(); });
document.getElementById('cal-today').addEventListener('click', () => { calWeek = startOfWeek(new Date()); calDay = (new Date().getDay() + 6) % 7; loadCalendarView(true); });
document.getElementById('cal-copy').addEventListener('click', async () => {
  const r = await api('/api/blocks/copy-week', { method: 'POST', body: JSON.stringify({ from: addDays(calWeek, -7).toISOString(), to: calWeek.toISOString() }) });
  toast(r.copied ? `Copied ${r.copied} shift${r.copied === 1 ? '' : 's'}` : 'Last week has no shifts to copy.', r.copied ? 'ok' : 'warn');
  loadCalendarView();
});
document.getElementById('cal-settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = (k) => document.getElementById(`bs-${k}`).value;
  await api('/api/booking-settings', { method: 'PUT', body: JSON.stringify({
    visit_minutes: +v('visit_minutes'), gap_minutes: +v('gap_minutes'), day_start: v('day_start'), day_end: v('day_end'),
    min_notice_hours: +v('min_notice_hours'), horizon_days: +v('horizon_days') }) });
  document.getElementById('bs-saved').textContent = ' Saved ✓';
  setTimeout(() => { document.getElementById('bs-saved').textContent = ''; }, 1500);
});
// any [data-copy="<input id>"] button copies that input's value
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const input = document.getElementById(btn.dataset.copy);
  try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand('copy'); }
  const t = btn.textContent; btn.textContent = 'Copied ✓'; setTimeout(() => { btn.textContent = t; }, 1500);
});

// ── drawer ──────────────────────────────────────────────
async function openDrawer(id) {
  const drawer = document.getElementById('drawer');
  const backdrop = document.getElementById('drawer-backdrop');
  const c = contacts.find((x) => x.id === id) || await api(`/api/contacts/${id}/profile`);
  const [events, tasks, appts, drafts, enrollments] = await Promise.all([
    api(`/api/contacts/${id}/events`),
    api(`/api/contacts/${id}/tasks`),
    api(`/api/contacts/${id}/appointments`),
    api(`/api/contacts/${id}/drafts`),
    api(`/api/contacts/${id}/enrollments`).catch(() => []),
  ]);
  const enrollmentLine = (e) => {
    const state = e.status === 'active'
      ? (e.next_due_at ? `follow-up due ${new Date(e.next_due_at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}` : 'first email awaiting review')
      : e.status === 'completed' ? 'sequence finished' : `stopped (${(e.stopped_reason || '').replace('_', ' ')})`;
    return `<div class="list-row"><span>${escapeHtml(e.campaign_name)}</span><span class="dim">${escapeHtml(state)}</span></div>`;
  };

  drawer.innerHTML = `
    <button class="close-btn" id="drawer-close" aria-label="Close">✕</button>
    <h2>${escapeHtml(c.business || '(no name)')}</h2>
    <a class="btn btn-secondary btn-sm" href="#/customers/${c.id}" id="drawer-profile">Open full profile →</a>
    <div class="field"><label>About the business</label><textarea id="f-notes" rows="5" placeholder="What the place is, owner, size, busy times...">${escapeHtml(c.notes || '')}</textarea></div>
    ${enrollments.length ? `<div class="field"><label>Campaign</label>${enrollments.map(enrollmentLine).join('')}</div>` : ''}
    <div class="field"><label>Stage</label>
      <select id="f-stage">${STAGES.map(([v, l]) => `<option value="${v}" ${v === c.pipeline_stage ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    <div class="field"><label>Contact name</label><input id="f-contact_name" value="${escapeHtml(c.contact_name || '')}" /></div>
    <div class="field"><label>Email</label><input id="f-email" value="${escapeHtml(c.email || '')}" /></div>
    <div class="field"><label>Phone</label><input id="f-phone" value="${escapeHtml(c.phone || '')}" /></div>
    <div class="field"><label>Website ${/^https?:\/\//i.test(c.website || '') ? `<a href="${escapeHtml(c.website)}" target="_blank" rel="noopener">open ↗</a>` : ''}</label><input id="f-website" value="${escapeHtml(c.website || '')}" /></div>
    <div class="field"><label>Address ${c.address ? `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.address)}" target="_blank" rel="noopener">map ↗</a>` : ''}</label><input id="f-address" value="${escapeHtml(c.address || '')}" /></div>
    <div class="field"><label>Source</label><input id="f-source" value="${escapeHtml(c.source || '')}" /></div>
    <div class="field"><label>Booking link <span class="dim">(send this so they can pick a visit time)</span></label>
      <div class="copy-row"><input id="f-booklink" readonly value="${escapeHtml(`${BOOK_URL}?c=${c.booking_token}`)}" /><button class="btn-secondary" data-copy="f-booklink">Copy</button></div></div>
    <div style="margin-top:10px;display:flex;gap:8px"><button class="btn-primary" id="save-btn">Save</button>
      <button class="btn-secondary" id="delete-btn">Archive</button></div>

    <div id="drafts-section"></div>

    <div class="section">
      <label style="font-size:12px;color:var(--text-dim)">Add note</label>
      <textarea id="note-input" rows="2" placeholder="Note..."></textarea>
      <button class="btn-secondary" id="note-btn" style="margin-top:6px">Add note</button>
    </div>

    <div class="section">
      <strong style="font-size:13px">Tasks</strong>
      <div id="tasks-list"></div>
      <input id="task-input" placeholder="New task, press Enter" style="margin-top:6px" />
    </div>

    <div class="section">
      <strong style="font-size:13px">Appointments</strong>
      <div id="appts-list"></div>
      <div style="display:flex;gap:6px;margin-top:6px">
        <input id="appt-title" placeholder="Title" />
        <input id="appt-when" type="datetime-local" />
      </div>
      <button class="btn-secondary" id="appt-btn" style="margin-top:6px">Add appointment</button>
    </div>

    <div class="section">
      <strong style="font-size:13px">Timeline</strong>
      <div id="events-list"></div>
    </div>
  `;

  const draftsSection = drawer.querySelector('#drafts-section');
  for (const d of drafts) draftsSection.appendChild(draftBox(d, () => { loadContacts(); openDrawer(id); }));

  const tasksList = drawer.querySelector('#tasks-list');
  if (!tasks.length) tasksList.innerHTML = '<div class="empty">No tasks.</div>';
  for (const t of tasks) {
    const row = document.createElement('div');
    row.className = 'task' + (t.done ? ' done' : '');
    row.innerHTML = `<input type="checkbox" ${t.done ? 'checked' : ''} /> <label>${escapeHtml(t.title)}</label>`;
    row.querySelector('input').addEventListener('change', async (e) => {
      await api(`/api/tasks/${t.id}`, { method: 'PATCH', body: JSON.stringify({ done: e.target.checked }) });
    });
    tasksList.appendChild(row);
  }

  const apptsList = drawer.querySelector('#appts-list');
  if (!appts.length) apptsList.innerHTML = '<div class="empty">None scheduled.</div>';
  for (const a of appts) {
    const row = document.createElement('div');
    row.className = 'event';
    row.innerHTML = `<div>${escapeHtml(a.title)}</div><div class="when">${new Date(a.starts_at).toLocaleString()}</div>`;
    apptsList.appendChild(row);
  }

  const eventsList = drawer.querySelector('#events-list');
  if (!events.length) eventsList.innerHTML = '<div class="empty">No activity yet.</div>';
  for (const ev of events) {
    const row = document.createElement('div');
    row.className = 'event';
    row.innerHTML = `<div>${ev.type === 'stage_change' ? `Stage → <b>${escapeHtml(ev.body)}</b>` : escapeHtml(ev.body || ev.type)}</div>
      <div class="when">${new Date(ev.at).toLocaleString()}</div>`;
    eventsList.appendChild(row);
  }

  drawer.querySelector('#drawer-close').addEventListener('click', closeDrawer);
  drawer.querySelector('#drawer-profile').addEventListener('click', closeDrawer);
  drawer.querySelector('#save-btn').addEventListener('click', async () => {
    const patch = {
      pipeline_stage: drawer.querySelector('#f-stage').value,
      contact_name: drawer.querySelector('#f-contact_name').value,
      email: drawer.querySelector('#f-email').value,
      phone: drawer.querySelector('#f-phone').value,
      website: drawer.querySelector('#f-website').value,
      address: drawer.querySelector('#f-address').value,
      notes: drawer.querySelector('#f-notes').value,
      source: drawer.querySelector('#f-source').value,
    };
    try { await api(`/api/contacts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }); } catch (err) { return toast(err.message, 'error'); }
    toast('Saved');
    closeDrawer();
    loadContacts();
  });
  drawer.querySelector('#delete-btn').addEventListener('click', async () => {
    if (!(await confirmDialog({ title: 'Archive this customer?', body: 'They disappear from lists and sequences stop. Proposals, contracts and documents are kept, and you can restore them from Customers → Archived.', confirmText: 'Archive', danger: true }))) return;
    await api(`/api/contacts/${id}`, { method: 'DELETE' });
    toast('Customer archived');
    closeDrawer();
    loadContacts();
  });
  drawer.querySelector('#note-btn').addEventListener('click', async () => {
    const body = drawer.querySelector('#note-input').value.trim();
    if (!body) return;
    await api(`/api/contacts/${id}/notes`, { method: 'POST', body: JSON.stringify({ body }) });
    openDrawer(id);
  });
  drawer.querySelector('#task-input').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || !e.target.value.trim()) return;
    await api(`/api/contacts/${id}/tasks`, { method: 'POST', body: JSON.stringify({ title: e.target.value.trim() }) });
    openDrawer(id);
  });
  drawer.querySelector('#appt-btn').addEventListener('click', async () => {
    const title = drawer.querySelector('#appt-title').value.trim();
    const when = drawer.querySelector('#appt-when').value;
    if (!title || !when) return;
    await api(`/api/contacts/${id}/appointments`, { method: 'POST', body: JSON.stringify({ title, starts_at: new Date(when).toISOString() }) });
    openDrawer(id);
  });

  drawer.classList.remove('hidden');
  backdrop.classList.remove('hidden');
  drawer.setAttribute('role', 'dialog'); drawer.setAttribute('aria-label', c.business || 'Customer');
  drawer.querySelector('#drawer-close').focus();
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !document.getElementById('drawer').classList.contains('hidden')) closeDrawer(); });

function closeDrawer() {
  document.getElementById('drawer').classList.add('hidden');
  document.getElementById('drawer-backdrop').classList.add('hidden');
}
document.getElementById('drawer-backdrop').addEventListener('click', closeDrawer);

// ── mobile sidebar ──────────────────────────────────────
function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebar-backdrop').classList.remove('hidden');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-backdrop').classList.add('hidden');
}
document.getElementById('menu-toggle').addEventListener('click', openSidebar);
document.getElementById('sidebar-backdrop').addEventListener('click', closeSidebar);

// ── campaigns ────────────────────────────────────────────
async function loadCampaignsView() {
  const campaigns = await api('/api/campaigns');
  const list = document.getElementById('campaigns-list');
  list.innerHTML = '';
  if (!campaigns.length) { list.innerHTML = '<p class="empty">No campaigns yet.</p>'; return; }
  for (const c of campaigns) {
    const card = document.createElement('div');
    card.className = 'card campaign-card';
    const enrolled = Object.entries(c.enrollments || {}).map(([k, v]) => `${v} ${k}`).join(', ') || 'none enrolled';
    card.innerHTML = `
      <div class="row1">
        <h3>${escapeHtml(c.name)}</h3>
        <select class="status-select">
          <option value="active" ${c.status === 'active' ? 'selected' : ''}>Active</option>
          <option value="paused" ${c.status === 'paused' ? 'selected' : ''}>Paused</option>
        </select>
      </div>
      <div class="meta">${c.trigger_stage ? `Auto-enrols on stage → ${escapeHtml(STAGE_LABEL[c.trigger_stage] || c.trigger_stage)}` : 'Manual enrol only'} · cap ${c.daily_cap}/day · ${enrolled}</div>
      <div class="steps-summary">${c.steps.length && c.steps[0].step_index === 1 ? '1. [AI draft, reviewed by hand] → ' : ''}${c.steps.map((s) => `${s.step_index + 1}. [${escapeHtml(s.channel)}] +${Number(s.wait_days)}d`).join(' → ') || 'no steps'}</div>
    `;
    card.querySelector('.status-select').addEventListener('change', async (e) => {
      await api(`/api/campaigns/${c.id}`, { method: 'PATCH', body: JSON.stringify({ status: e.target.value }) });
    });
    list.appendChild(card);
  }
}

function addStepRow(container) {
  const row = document.createElement('div');
  row.className = 'step-row';
  row.innerHTML = `
    <div class="step-row-top">
      <select class="s-channel"><option value="email">Email</option><option value="sms">SMS</option></select>
      <input type="number" class="s-wait" min="0" value="0" title="days after previous step" />
      <button type="button" class="remove-step">Remove</button>
    </div>
    <input class="s-subject" placeholder="Subject (email only)" />
    <textarea class="s-body" rows="2" placeholder="Body — {{business}}, {{first_name}}, {{email}}, {{phone}}"></textarea>
  `;
  row.querySelector('.remove-step').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

const stepsContainer = document.getElementById('steps-container');
addStepRow(stepsContainer);
document.getElementById('add-step-btn').addEventListener('click', () => addStepRow(stepsContainer));
document.getElementById('new-campaign-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const steps = [...stepsContainer.querySelectorAll('.step-row')].map((row) => ({
    channel: row.querySelector('.s-channel').value,
    wait_days: Number(row.querySelector('.s-wait').value || 0),
    subject_tmpl: row.querySelector('.s-subject').value || null,
    body_tmpl: row.querySelector('.s-body').value,
  }));
  await api('/api/campaigns', { method: 'POST', body: JSON.stringify({ name: fd.get('name'), trigger_stage: fd.get('trigger_stage') || null, steps }) });
  toast('Campaign created');
  e.target.reset();
  stepsContainer.innerHTML = '';
  addStepRow(stepsContainer);
  loadCampaignsView();
});

// ── settings ─────────────────────────────────────────────
async function loadSettingsView() {
  const s = await api('/api/settings');
  const form = document.getElementById('settings-form');
  form.send_window_start.value = s.send_window_start;
  form.send_window_end.value = s.send_window_end;
  form.send_days.value = s.send_days.join(',');
  form.daily_send_limit.value = s.daily_send_limit;
  loadSuppression();
}

document.getElementById('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await api('/api/settings', {
    method: 'PUT',
    body: JSON.stringify({
      send_window_start: fd.get('send_window_start'),
      send_window_end: fd.get('send_window_end'),
      send_days: fd.get('send_days').split(',').map((n) => Number(n.trim())).filter(Boolean),
      daily_send_limit: Number(fd.get('daily_send_limit')),
    }),
  });
});

async function loadSuppression() {
  const rows = await api('/api/suppression');
  document.getElementById('suppression-count').textContent = `Suppression list (${rows.length})`;
  const tbody = document.getElementById('suppression-tbody');
  tbody.innerHTML = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(r.email)}</td><td>${escapeHtml(r.reason)}</td><td>${new Date(r.created_at).toLocaleString()}</td><td></td>`;
    const btn = document.createElement('button');
    btn.className = 'btn-secondary';
    btn.textContent = 'Remove';
    btn.addEventListener('click', async () => { await api(`/api/suppression/${encodeURIComponent(r.email)}`, { method: 'DELETE' }); loadSuppression(); });
    tr.lastElementChild.appendChild(btn);
    tbody.appendChild(tr);
  }
}

document.getElementById('suppress-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await api('/api/suppression', { method: 'POST', body: JSON.stringify({ email: fd.get('email'), reason: fd.get('reason') }) });
  e.target.reset();
  loadSuppression();
});

