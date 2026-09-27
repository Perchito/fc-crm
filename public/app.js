const STAGES = [
  ['new', 'New'],
  ['contacted', 'Contacted'],
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
      <td>${escapeHtml(c.phone || '')}</td><td>${escapeHtml(c.source || '')}</td><td>${pill(c.pipeline_stage)}</td>`;
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

// ── drawer ──────────────────────────────────────────────
async function openDrawer(id) {
  const drawer = document.getElementById('drawer');
  const backdrop = document.getElementById('drawer-backdrop');
  const c = contacts.find((x) => x.id === id);
  const [events, tasks, appts, drafts] = await Promise.all([
    api(`/api/contacts/${id}/events`),
    api(`/api/contacts/${id}/tasks`),
    api(`/api/contacts/${id}/appointments`),
    api(`/api/contacts/${id}/drafts`),
  ]);

  drawer.innerHTML = `
    <button class="close-btn" id="drawer-close">✕</button>
    <h2>${escapeHtml(c.business || '(no name)')}</h2>
    <div class="field"><label>Stage</label>
      <select id="f-stage">${STAGES.map(([v, l]) => `<option value="${v}" ${v === c.pipeline_stage ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    <div class="field"><label>Contact name</label><input id="f-contact_name" value="${escapeHtml(c.contact_name || '')}" /></div>
    <div class="field"><label>Email</label><input id="f-email" value="${escapeHtml(c.email || '')}" /></div>
    <div class="field"><label>Phone</label><input id="f-phone" value="${escapeHtml(c.phone || '')}" /></div>
    <div class="field"><label>Source</label><input id="f-source" value="${escapeHtml(c.source || '')}" /></div>
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
  for (const d of drafts) {
    const box = document.createElement('div');
    box.className = 'section draft-box';
    box.innerHTML = `
      <strong style="font-size:13px">AI-drafted email</strong>
      <input class="d-subject" value="${escapeHtml(d.subject || '')}" style="margin-top:8px" />
      <textarea class="d-body" rows="8">${escapeHtml(d.body || '')}</textarea>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn-primary d-send">Send</button>
        <button class="btn-secondary d-discard">Discard</button>
      </div>
    `;
    box.querySelector('.d-subject').addEventListener('change', (e) => api(`/api/sends/${d.id}`, { method: 'PATCH', body: JSON.stringify({ subject: e.target.value }) }));
    box.querySelector('.d-body').addEventListener('change', (e) => api(`/api/sends/${d.id}`, { method: 'PATCH', body: JSON.stringify({ body: e.target.value }) }));
    box.querySelector('.d-send').addEventListener('click', async () => {
      const subject = box.querySelector('.d-subject').value;
      const body = box.querySelector('.d-body').value;
      await api(`/api/sends/${d.id}`, { method: 'PATCH', body: JSON.stringify({ subject, body }) });
      await api(`/api/sends/${d.id}/send`, { method: 'POST' });
      loadContacts();
      openDrawer(id);
    });
    box.querySelector('.d-discard').addEventListener('click', async () => {
      if (!confirm('Discard this draft?')) return;
      await api(`/api/sends/${d.id}/discard`, { method: 'POST' });
      openDrawer(id);
    });
    draftsSection.appendChild(box);
  }

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
const loaders = { dashboard: loadDashboard, campaigns: loadCampaignsView, settings: loadSettingsView };
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
    tr.addEventListener('click', () => {
      document.querySelector('#tabs .tab[data-view="prospects"]').click();
      openDrawer(d.contact_id);
    });
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
      <div class="steps-summary">${c.steps.map((s) => `${s.step_index + 1}. [${escapeHtml(s.channel)}] +${Number(s.wait_days)}d`).join(' → ') || 'no steps'}</div>
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
