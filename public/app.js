const STAGES = [
  ['new', 'New'],
  ['contacted', 'Contacted'],
  ['quoted', 'Quoted'],
  ['won', 'Won'],
  ['lost', 'Lost'],
];

let contacts = [];

async function api(path, opts) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts && opts.headers) },
  });
  if (!res.ok) throw new Error(await res.text());
  return res.status === 204 ? null : res.json();
}

async function loadContacts() {
  contacts = await api('/api/contacts');
  renderBoard();
}

function renderBoard() {
  const board = document.getElementById('board');
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
  card.className = 'card';
  card.draggable = true;
  card.innerHTML = `<div class="biz">${escapeHtml(c.business || '(no name)')}</div>
    <div class="meta">${escapeHtml(c.contact_name || c.email || c.phone || '')}</div>`;
  card.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', c.id));
  card.addEventListener('click', () => openDrawer(c.id));
  return card;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

// ── drawer ──────────────────────────────────────────────
async function openDrawer(id) {
  const drawer = document.getElementById('drawer');
  const backdrop = document.getElementById('drawer-backdrop');
  const c = contacts.find((x) => x.id === id);
  const [events, tasks] = await Promise.all([
    api(`/api/contacts/${id}/events`),
    api(`/api/contacts/${id}/tasks`),
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
    <div style="margin-top:10px"><button class="btn-primary" id="save-btn">Save</button>
      <button class="btn-secondary" id="delete-btn">Delete</button></div>

    <div class="section">
      <label style="font-size:12px;color:#64748b">Add note</label>
      <textarea id="note-input" rows="2" placeholder="Note..."></textarea>
      <button class="btn-secondary" id="note-btn" style="margin-top:6px">Add note</button>
    </div>

    <div class="section">
      <strong style="font-size:13px">Tasks</strong>
      <div id="tasks-list"></div>
      <input id="task-input" placeholder="New task, press Enter" style="margin-top:6px" />
    </div>

    <div class="section">
      <strong style="font-size:13px">Timeline</strong>
      <div id="events-list"></div>
    </div>
  `;

  const tasksList = drawer.querySelector('#tasks-list');
  for (const t of tasks) {
    const row = document.createElement('div');
    row.className = 'task' + (t.done ? ' done' : '');
    row.innerHTML = `<input type="checkbox" ${t.done ? 'checked' : ''} /> <label>${escapeHtml(t.title)}</label>`;
    row.querySelector('input').addEventListener('change', async (e) => {
      await api(`/api/tasks/${t.id}`, { method: 'PATCH', body: JSON.stringify({ done: e.target.checked }) });
    });
    tasksList.appendChild(row);
  }

  const eventsList = drawer.querySelector('#events-list');
  if (!events.length) eventsList.innerHTML = '<div class="meta">No activity yet.</div>';
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

  drawer.classList.remove('hidden');
  backdrop.classList.remove('hidden');
}

function closeDrawer() {
  document.getElementById('drawer').classList.add('hidden');
  document.getElementById('drawer-backdrop').classList.add('hidden');
}
document.getElementById('drawer-backdrop').addEventListener('click', closeDrawer);

// ── new contact modal ───────────────────────────────────
const newBackdrop = document.getElementById('new-modal-backdrop');
document.getElementById('new-contact-btn').addEventListener('click', () => newBackdrop.classList.remove('hidden'));
document.getElementById('new-modal-cancel').addEventListener('click', () => newBackdrop.classList.add('hidden'));
document.getElementById('new-contact-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = Object.fromEntries(fd.entries());
  await api('/api/contacts', { method: 'POST', body: JSON.stringify(body) });
  e.target.reset();
  newBackdrop.classList.add('hidden');
  loadContacts();
});

loadContacts();
