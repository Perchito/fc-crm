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

async function api(path, opts) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts && opts.headers) },
  });
  if (!res.ok) throw new Error(await res.text());
  return res.status === 204 ? null : res.json();
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function pill(stage) { return `<span class="pill pill-${stage}">${escapeHtml(STAGE_LABEL[stage] || stage)}</span>`; }

async function loadContacts() {
  contacts = await api('/api/contacts');
  renderBoard();
  renderProspects();
}

// ── pipeline (kanban) ────────────────────────────────────
function renderBoard() {
  const board = document.getElementById('board');
  if (!board) return;
  board.innerHTML = '';
  for (const [stage, label] of STAGES) {
    const col = document.createElement('div');
    col.className = 'column';
    col.dataset.stage = stage;
    const list = contacts.filter((c) => c.pipeline_stage === stage);
    col.innerHTML = `<h2>${label} <span>${list.length}</span></h2>`;
    for (const c of list) col.appendChild(renderCard(c));
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const id = e.dataTransfer.getData('text/plain');
      const contact = contacts.find((c) => c.id === id);
      if (!contact || contact.pipeline_stage === stage) return;
      contact.pipeline_stage = stage;
      renderBoard();
      await api(`/api/contacts/${id}`, { method: 'PATCH', body: JSON.stringify({ pipeline_stage: stage }) });
    });
    board.appendChild(col);
  }
}

function renderCard(c) {
  const card = document.createElement('div');
  card.className = 'card kanban-card';
  card.draggable = true;
  card.innerHTML = `<div class="biz">${escapeHtml(c.business || '(no name)')}</div>
    <div class="meta">${escapeHtml(c.contact_name || c.email || c.phone || '')}</div>
    <select class="card-stage">${STAGES.map(([v, l]) => `<option value="${v}" ${v === c.pipeline_stage ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  card.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', c.id));
  card.addEventListener('click', () => openDrawer(c.id));
  const stageSelect = card.querySelector('.card-stage');
  stageSelect.addEventListener('click', (e) => e.stopPropagation());
  stageSelect.addEventListener('change', async (e) => {
    const stage = e.target.value;
    c.pipeline_stage = stage;
    renderBoard();
    await api(`/api/contacts/${c.id}`, { method: 'PATCH', body: JSON.stringify({ pipeline_stage: stage }) });
  });
  return card;
}

// ── prospects (table) ───────────────────────────────────
function renderProspects() {
  const tbody = document.getElementById('prospects-tbody');
  if (!tbody) return;
  const q = (document.getElementById('prospects-search').value || '').toLowerCase();
  const stageFilter = document.getElementById('prospects-filter').value;
  const rows = contacts.filter((c) => {
    if (stageFilter && c.pipeline_stage !== stageFilter) return false;
    if (!q) return true;
    return (c.business || '').toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q) || (c.contact_name || '').toLowerCase().includes(q);
  });
  document.getElementById('prospects-count').textContent = `${rows.length} shown. Search or filter by pipeline stage.`;
  tbody.innerHTML = '';
  for (const c of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(c.business || '(no name)')}</td><td>${escapeHtml(c.email || '')}</td>
      <td>${escapeHtml(c.phone || '')}</td><td>${/^https?:\/\//i.test(c.website || '') ? `<a href="${escapeHtml(c.website)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${escapeHtml(c.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a>` : ''}</td><td>${escapeHtml(c.address || '')}</td><td>${escapeHtml(c.source || '')}</td><td>${pill(c.pipeline_stage)}</td>`;
    tr.addEventListener('click', () => openDrawer(c.id));
    tbody.appendChild(tr);
  }
}

const filterSelect = document.getElementById('prospects-filter');
for (const [v, l] of STAGES) filterSelect.insertAdjacentHTML('beforeend', `<option value="${v}">${l}</option>`);
document.getElementById('prospects-search').addEventListener('input', renderProspects);
filterSelect.addEventListener('change', renderProspects);

document.getElementById('new-contact-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  await api('/api/contacts', { method: 'POST', body: JSON.stringify(body) });
  e.target.reset();
  loadContacts();
});

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
    } catch (err) { alert(`Send failed: ${err.message}`); e.target.disabled = false; return; }
    after();
  });
  box.querySelector('.d-discard').addEventListener('click', async () => {
    if (!confirm('Discard this draft?')) return;
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

// ── calendar (busy blocks + booked visits) ──────────────
const SLOT_MIN = 30, ROW_PX = 20, ROWS = 48;
let calWeek = startOfWeek(new Date()), calAnchor = null;
function startOfWeek(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const atSlot = (day, i) => { const x = new Date(day); x.setMinutes(i * SLOT_MIN); return x; };
const hhmm = (d) => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

async function loadCalendarView() {
  const from = calWeek, to = addDays(calWeek, 7);
  const [{ blocks, appointments }, bs] = await Promise.all([
    api(`/api/calendar?from=${from.toISOString()}&to=${to.toISOString()}`), api('/api/booking-settings')]);
  document.getElementById('cal-label').textContent =
    `${from.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${addDays(from, 6).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
  document.getElementById('cal-book-url').value = bs.booking_url;
  document.getElementById('cal-ics-url').value = bs.ics_url;
  for (const k of ['visit_minutes', 'gap_minutes', 'day_start', 'day_end', 'min_notice_hours', 'horizon_days']) document.getElementById(`bs-${k}`).value = bs[k];

  const cal = document.getElementById('cal');
  const today = new Date().toDateString();
  let html = '<div class="cal-corner"></div>';
  for (let d = 0; d < 7; d++) {
    const day = addDays(from, d);
    html += `<div class="cal-dayhead ${day.toDateString() === today ? 'today' : ''}">${day.toLocaleDateString('en-GB', { weekday: 'short' })} <b>${day.getDate()}</b></div>`;
  }
  html += '<div class="cal-gutter">' + Array.from({ length: 24 }, (_, h) => `<div style="height:${ROW_PX * 2}px">${h ? `${String(h).padStart(2, '0')}:00` : ''}</div>`).join('') + '</div>';
  for (let d = 0; d < 7; d++) html += `<div class="cal-col" data-d="${d}" style="height:${ROWS * ROW_PX}px"></div>`;
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
      if (st) col.insertAdjacentHTML('beforeend', `<button class="cal-ev appt" data-contact="${a.contact_id}" style="${st}">${escapeHtml(a.business || a.contact_name || a.title)}<span>${hhmm(a.starts_at)} · ${escapeHtml(a.title)}</span></button>`);
    }
  });
  const wrap = cal.parentElement;
  if (!wrap.dataset.scrolled) { wrap.scrollTop = 6 * 2 * ROW_PX; wrap.dataset.scrolled = '1'; }
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
  loadCalendarView();
}
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
    return;
  }
  if (!ev) return;
  if (ev.dataset.block) {
    if (!confirm('Remove this busy block?')) return;
    await api(`/api/blocks/${ev.dataset.block}`, { method: 'DELETE' });
    loadCalendarView();
  } else if (ev.dataset.contact) {
    if (!contacts.length) await loadContacts();
    openDrawer(ev.dataset.contact);
  }
});
document.getElementById('cal-prev').addEventListener('click', () => { calWeek = addDays(calWeek, -7); loadCalendarView(); });
document.getElementById('cal-next').addEventListener('click', () => { calWeek = addDays(calWeek, 7); loadCalendarView(); });
document.getElementById('cal-today').addEventListener('click', () => { calWeek = startOfWeek(new Date()); loadCalendarView(); });
document.getElementById('cal-copy').addEventListener('click', async () => {
  const r = await api('/api/blocks/copy-week', { method: 'POST', body: JSON.stringify({ from: addDays(calWeek, -7).toISOString(), to: calWeek.toISOString() }) });
  if (!r.copied) alert('Last week has no shifts to copy.');
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
  const c = contacts.find((x) => x.id === id);
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
    <button class="close-btn" id="drawer-close">✕</button>
    <h2>${escapeHtml(c.business || '(no name)')}</h2>
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
      <div class="copy-row"><input id="f-booklink" readonly value="${escapeHtml(`${location.origin}/book?c=${c.booking_token}`)}" /><button class="btn-secondary" data-copy="f-booklink">Copy</button></div></div>
    <div style="margin-top:10px;display:flex;gap:8px"><button class="btn-primary" id="save-btn">Save</button>
      <button class="btn-secondary" id="delete-btn">Delete</button></div>

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
    await api(`/api/contacts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    closeDrawer();
    loadContacts();
  });
  drawer.querySelector('#delete-btn').addEventListener('click', async () => {
    if (!confirm('Delete this contact?')) return;
    await api(`/api/contacts/${id}`, { method: 'DELETE' });
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
}

function closeDrawer() {
  document.getElementById('drawer').classList.add('hidden');
  document.getElementById('drawer-backdrop').classList.add('hidden');
}
document.getElementById('drawer-backdrop').addEventListener('click', closeDrawer);

// ── tabs ─────────────────────────────────────────────────
const loaders = { dashboard: loadDashboard, drafts: loadDraftsView, calendar: loadCalendarView, campaigns: loadCampaignsView, settings: loadSettingsView };
for (const btn of document.querySelectorAll('#tabs .tab')) {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#tabs .tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    for (const el of document.querySelectorAll('main .view')) el.classList.add('hidden');
    document.getElementById(`view-${btn.dataset.view}`).classList.remove('hidden');
    const loader = loaders[btn.dataset.view];
    if (loader) loader();
    closeSidebar();
  });
}

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

// ── dashboard ────────────────────────────────────────────
async function loadDashboard() {
  if (!contacts.length) await loadContacts();
  const counts = Object.fromEntries(STAGES.map(([v]) => [v, contacts.filter((c) => c.pipeline_stage === v).length]));
  const cards = document.getElementById('stat-cards');
  cards.innerHTML = `<div class="stat-card"><div class="n">${contacts.length}</div><div class="label">Total prospects</div></div>` +
    STAGES.map(([v, l]) => `<div class="stat-card"><div class="n">${counts[v]}</div><div class="label">${l}</div></div>`).join('');

  const [appts, activity, drafts] = await Promise.all([api('/api/appointments'), api('/api/activity'), api('/api/drafts')]);

  document.getElementById('drafts-count').textContent = `Drafts awaiting review (${drafts.length})`;
  const draftsTbody = document.getElementById('drafts-tbody');
  draftsTbody.innerHTML = drafts.length ? '' : '<tr><td colspan="3" class="empty">Nothing waiting — new AI-discovered leads get drafted automatically.</td></tr>';
  for (const d of drafts) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(d.business || '')}</td><td>${escapeHtml(d.subject || '')}</td><td></td>`;
    tr.addEventListener('click', () => document.querySelector('#tabs .tab[data-view="drafts"]').click());
    draftsTbody.appendChild(tr);
  }

  const apptsEl = document.getElementById('dash-appointments');
  apptsEl.innerHTML = appts.length ? appts.slice(0, 8).map((a) =>
    `<div class="list-row"><span>${escapeHtml(a.title)} — ${escapeHtml(a.business || '')}</span><span class="dim">${new Date(a.starts_at).toLocaleDateString()}</span></div>`
  ).join('') : '<div class="empty">Nothing scheduled.</div>';

  const actEl = document.getElementById('dash-activity');
  actEl.innerHTML = activity.length ? activity.map((ev) =>
    `<div class="list-row"><span>${escapeHtml(ev.business || '')} — ${ev.type === 'stage_change' ? `stage → ${escapeHtml(ev.body)}` : escapeHtml(ev.type)}</span><span class="dim">${new Date(ev.at).toLocaleDateString()}</span></div>`
  ).join('') : '<div class="empty">No activity yet.</div>';
}

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

loadDashboard();
