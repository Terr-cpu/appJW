/* =========================================================
   Hourglass Panel — configuración
   ========================================================= */
const CONFIG = {
  // Sustituye por tu Client ID de Google Cloud Console (OAuth 2.0 → Web application)
  CLIENT_ID: '989709837307-449de0hk767r7lplvjfc4ilfb6smnpfd.apps.googleusercontent.com',
  SCOPES: 'https://www.googleapis.com/auth/drive.file',
  FOLDER_NAME: 'Hourglass Panel',
  CUADRANTE_NAME: 'cuadrante-actual.pdf',
  EVENTS_NAME: 'eventos.json',
  PROYECTOS_NAME: 'proyectos.json',
};

/* =========================================================
   Estado
   ========================================================= */
let tokenClient, accessToken = null, folderId = null;
let events = [];
let proyectos = [];
let calMonth = new Date(calYearMonthStart());
let notifiedIds = new Set(JSON.parse(localStorage.getItem('hg_notified') || '[]'));

function calYearMonthStart(){ const d = new Date(); d.setDate(1); d.setHours(0,0,0,0); return d; }

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* =========================================================
   Google Identity Services — autenticación
   ========================================================= */
window.addEventListener('load', () => {
  const check = setInterval(() => {
    if (window.google && google.accounts) {
      clearInterval(check);
      initAuth();
    }
  }, 100);
});

function initAuth(){
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: CONFIG.SCOPES,
    callback: async (resp) => {
      if (resp.error) { console.error(resp); return; }
      accessToken = resp.access_token;
      localStorage.setItem('hg_token', accessToken);
      localStorage.setItem('hg_token_ts', Date.now().toString());
      await onSignedIn();
    },
  });

  $('#signInBtn').addEventListener('click', () => tokenClient.requestAccessToken({ prompt: 'consent' }));
  $('#signOutBtn').addEventListener('click', signOut);

  // Reutiliza el token si sigue fresco (~50 min)
  const cached = localStorage.getItem('hg_token');
  const ts = parseInt(localStorage.getItem('hg_token_ts') || '0', 10);
  if (cached && Date.now() - ts < 50 * 60 * 1000) {
    accessToken = cached;
    onSignedIn();
  }
}

function signOut(){
  if (accessToken) google.accounts.oauth2.revoke(accessToken, () => {});
  accessToken = null;
  localStorage.removeItem('hg_token');
  localStorage.removeItem('hg_token_ts');
  $('#signedInInfo').hidden = true;
  $('#signInBtn').hidden = false;
  $('#tabs').hidden = true;
  $('#app').hidden = true;
}

async function onSignedIn(){
  $('#signInBtn').hidden = true;
  $('#signedInInfo').hidden = false;
  $('#tabs').hidden = false;
  $('#app').hidden = false;
  fetchProfile();
  showSand('Preparando tu carpeta en Drive…');
  try {
    await ensureFolder();
    await Promise.all([loadEvents(), loadProyectos(), loadCuadrante()]);
    renderCalendar();
    renderUpcoming();
    renderProyectos();
    checkReminders();
    setInterval(checkReminders, 60000);
  } catch (err) {
    console.error(err);
    alert('Hubo un problema conectando con Drive. Vuelve a intentar el inicio de sesión.');
  } finally {
    hideSand();
  }
}

async function fetchProfile(){
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const info = await res.json();
    $('#userName').textContent = info.name || info.email || '';
    if (info.picture) $('#userAvatar').src = info.picture;
  } catch (e) { /* no crítico */ }
}

/* =========================================================
   Ayudas de UI
   ========================================================= */
function showSand(text){
  $('#sandOverlayText').textContent = text || 'Sincronizando con Drive…';
  $('#sandOverlay').hidden = false;
}
function hideSand(){ $('#sandOverlay').hidden = true; }

$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    $$('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $(`#tab-${tab.dataset.tab}`).classList.add('active');
  });
});

/* =========================================================
   Drive — utilidades genéricas
   ========================================================= */
async function driveFetch(url, options = {}){
  const res = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Drive API ${res.status}: ${text}`);
  }
  return res;
}

async function findFile(name, parentId, mimeType){
  let q = `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and trashed=false`;
  if (mimeType) q += ` and mimeType='${mimeType}'`;
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime)&spaces=drive`
  );
  const data = await res.json();
  return data.files && data.files[0] ? data.files[0] : null;
}

async function createFileMeta(name, parentId, mimeType){
  const res = await driveFetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parents: [parentId], mimeType }),
  });
  return res.json();
}

async function updateFileContent(fileId, mimeType, body){
  await driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: 'PATCH',
    headers: { 'Content-Type': mimeType },
    body,
  });
}

async function saveFile(name, mimeType, content, parentId){
  let f = await findFile(name, parentId);
  if (!f) f = await createFileMeta(name, parentId, mimeType);
  await updateFileContent(f.id, mimeType, content);
  return f.id;
}

async function downloadFile(fileId){
  return driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
}

async function ensureFolder(){
  const cached = localStorage.getItem('hg_folder_id');
  if (cached) { folderId = cached; return; }
  let f = await findFile(CONFIG.FOLDER_NAME, 'root', 'application/vnd.google-apps.folder');
  if (!f) f = await createFileMeta(CONFIG.FOLDER_NAME, 'root', 'application/vnd.google-apps.folder');
  folderId = f.id;
  localStorage.setItem('hg_folder_id', folderId);
}

/* =========================================================
   Cuadrante (PDF)
   ========================================================= */
$('#pdfInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  showSand('Subiendo cuadrante…');
  try {
    await saveFile(CONFIG.CUADRANTE_NAME, 'application/pdf', file, folderId);
    await loadCuadrante();
  } catch (err) {
    console.error(err);
    alert('No se pudo subir el PDF.');
  } finally {
    hideSand();
    e.target.value = '';
  }
});

let currentPdfBlob = null;
let currentPdfUrl = null;

async function loadCuadrante(){
  const f = await findFile(CONFIG.CUADRANTE_NAME, folderId, 'application/pdf');
  const viewer = $('#cuadranteViewer');
  const meta = $('#cuadranteMeta');
  if (!f) {
    viewer.classList.add('empty');
    viewer.innerHTML = '<p>Todavía no hay ningún cuadrante subido.</p>';
    meta.textContent = '';
    currentPdfBlob = null;
    renderNameMatches();
    return;
  }
  const res = await downloadFile(f.id);
  const blob = await res.blob();
  currentPdfBlob = blob;
  currentPdfUrl = URL.createObjectURL(blob);
  viewer.classList.remove('empty');
  viewer.innerHTML = `<embed id="pdfEmbed" src="${currentPdfUrl}" type="application/pdf">`;
  const d = new Date(f.modifiedTime);
  meta.textContent = `Subido el ${d.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' })}`;
  renderNameMatches();
}

function jumpToPage(page){
  const embed = $('#pdfEmbed');
  if (embed && currentPdfUrl) embed.setAttribute('src', `${currentPdfUrl}#page=${page}`);
}

/* ---------- Localizar mi nombre en el PDF (pdf.js, en el navegador) ---------- */
const nameInput = $('#myNameInput');
nameInput.value = localStorage.getItem('hg_myname') || '';
nameInput.addEventListener('change', () => {
  localStorage.setItem('hg_myname', nameInput.value.trim());
  renderNameMatches();
});

function normalizeText(s){
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function groupTextIntoLines(items){
  const rows = {};
  items.forEach(it => {
    const y = Math.round(it.transform[5]);
    if (!rows[y]) rows[y] = [];
    rows[y].push(it.str);
  });
  return Object.keys(rows).sort((a, b) => b - a).map(y => rows[y].join(' ').replace(/\s+/g, ' ').trim());
}

function extractDateLike(line){
  if (!line) return null;
  const monthMatch = line.match(/\d{1,2}\s*(?:de\s*)?(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|ene\.?|feb\.?|mar\.?|abr\.?|may\.?|jun\.?|jul\.?|ago\.?|sep\.?|oct\.?|nov\.?|dic\.?)/i);
  if (monthMatch) return monthMatch[0].trim();
  const numMatch = line.match(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/);
  if (numMatch) return numMatch[0];
  const wd = line.match(/(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)/i);
  if (wd) return wd[0];
  return null;
}

function highlightName(text, name){
  const escaped = escapeHtml(text);
  if (!name) return escaped;
  try {
    const re = new RegExp(`(${name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig');
    return escaped.replace(re, '<mark>$1</mark>');
  } catch (e) { return escaped; }
}

async function findNameInPdf(blob, name){
  if (!blob || !name) return [];
  if (typeof pdfjsLib === 'undefined') return [];
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const buf = await blob.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const target = normalizeText(name);
  const results = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const lines = groupTextIntoLines(content.items);
    lines.forEach((line, idx) => {
      if (!line || !normalizeText(line).includes(target)) return;
      let date = extractDateLike(line);
      for (let back = 1; !date && back <= 5 && idx - back >= 0; back++) {
        date = extractDateLike(lines[idx - back]);
      }
      results.push({ page: p, text: line, date });
    });
  }
  return results;
}

let nameSearchToken = 0;
async function renderNameMatches(){
  const box = $('#nameMatches');
  const name = nameInput.value.trim();

  if (!currentPdfBlob) { box.innerHTML = ''; return; }
  if (!name) { box.innerHTML = '<p class="nm-status">Añade tu nombre arriba para ver aquí tus asignaciones, sin abrir el PDF.</p>'; return; }

  const token = ++nameSearchToken;
  box.innerHTML = '<p class="nm-status">Buscando tus asignaciones…</p>';
  try {
    const matches = await findNameInPdf(currentPdfBlob, name);
    if (token !== nameSearchToken) return; // una búsqueda más nueva ya está en marcha
    if (matches.length === 0) {
      box.innerHTML = `<p class="nm-status">No aparece "${escapeHtml(name)}" en este cuadrante.</p>`;
      return;
    }
    box.innerHTML = `
      <p class="nm-status">Esto es lo que tienes:</p>
      <ul class="nm-cards">${matches.map(m => `
        <li data-page="${m.page}">
          <div class="nm-top">
            <span class="nm-fecha">${m.date ? escapeHtml(m.date) : 'Sin fecha detectada'}</span>
            <span class="nm-pagesmall">pág. ${m.page}</span>
          </div>
          <div class="nm-detalle">${highlightName(m.text, name)}</div>
        </li>`).join('')}</ul>
      <p class="nm-hint">Toca una tarjeta para ver esa página del PDF si necesitas más contexto.</p>`;
    box.querySelectorAll('li[data-page]').forEach(li => li.addEventListener('click', () => jumpToPage(li.dataset.page)));
  } catch (err) {
    console.error(err);
    if (token === nameSearchToken) box.innerHTML = '<p class="nm-status">No se pudo analizar el PDF para buscar tu nombre.</p>';
  }
}

/* =========================================================
   Calendario
   ========================================================= */
async function loadEvents(){
  const f = await findFile(CONFIG.EVENTS_NAME, folderId, 'application/json');
  if (!f) { events = []; return; }
  const res = await downloadFile(f.id);
  events = await res.json().catch(() => []);
}

async function persistEvents(){
  await saveFile(CONFIG.EVENTS_NAME, 'application/json', JSON.stringify(events, null, 2), folderId);
}

function eventsOn(dateStr){ return events.filter(e => e.date === dateStr); }

function renderCalendar(){
  const grid = $('#calGrid');
  grid.innerHTML = '';
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  $('#calLabel').textContent = calMonth.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });

  ['L', 'M', 'X', 'J', 'V', 'S', 'D'].forEach(d => {
    const el = document.createElement('div');
    el.className = 'cal-dow';
    el.textContent = d;
    grid.appendChild(el);
  });

  const first = new Date(y, m, 1);
  const startOffset = (first.getDay() + 6) % 7; // lunes = 0
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const daysInPrevMonth = new Date(y, m, 0).getDate();
  const todayStr = new Date().toISOString().slice(0, 10);

  const cells = [];
  for (let i = startOffset; i > 0; i--) cells.push({ day: daysInPrevMonth - i + 1, other: true });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, other: false });
  while (cells.length % 7 !== 0) cells.push({ day: cells.length, other: true });

  cells.forEach(c => {
    const cell = document.createElement('div');
    const dateStr = c.other ? null : `${y}-${String(m + 1).padStart(2, '0')}-${String(c.day).padStart(2, '0')}`;
    cell.className = 'cal-day' + (c.other ? ' other' : '') + (dateStr === todayStr ? ' today' : '');
    const has = dateStr && eventsOn(dateStr).length > 0;
    if (has) cell.classList.add('has-event');
    cell.innerHTML = `<span class="num">${c.day}</span>${has ? '<span class="dot"></span>' : ''}`;
    if (dateStr) cell.addEventListener('click', () => openDayModal(dateStr));
    grid.appendChild(cell);
  });
}

$('#prevMonth').addEventListener('click', () => { calMonth.setMonth(calMonth.getMonth() - 1); renderCalendar(); });
$('#nextMonth').addEventListener('click', () => { calMonth.setMonth(calMonth.getMonth() + 1); renderCalendar(); });
$('#addEventBtn').addEventListener('click', () => openEventModal());

function renderUpcoming(){
  const list = $('#upcomingList');
  const now = new Date();
  const upcoming = events
    .filter(e => new Date(`${e.date}T${e.time || '00:00'}`) >= new Date(now.toDateString()))
    .sort((a, b) => `${a.date}${a.time || ''}`.localeCompare(`${b.date}${b.time || ''}`))
    .slice(0, 8);

  list.innerHTML = '';
  if (upcoming.length === 0) {
    list.innerHTML = '<li class="empty-note" style="list-style:none;">Sin eventos próximos.</li>';
    return;
  }
  upcoming.forEach(ev => {
    const li = document.createElement('li');
    const d = new Date(`${ev.date}T${ev.time || '00:00'}`);
    const dateLabel = d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' }) + (ev.time ? ` · ${ev.time}` : '');
    li.innerHTML = `
      <span class="ev-date">${dateLabel}</span>
      <span class="ev-title">${escapeHtml(ev.title)}</span>
      <span class="ev-actions">
        <button class="icon-btn" title="Añadir a mi calendario" data-ics="${ev.id}">⇩</button>
        <button class="icon-btn" title="Editar" data-edit="${ev.id}">✎</button>
        <button class="icon-btn" title="Eliminar" data-del="${ev.id}">✕</button>
      </span>`;
    list.appendChild(li);
  });

  list.querySelectorAll('[data-ics]').forEach(b => b.addEventListener('click', () => downloadIcs(b.dataset.ics)));
  list.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openEventModal(b.dataset.edit)));
  list.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => deleteEvent(b.dataset.del)));
}

function openDayModal(dateStr){
  const dayEvents = eventsOn(dateStr);
  const niceDate = new Date(`${dateStr}T00:00`).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  const rows = dayEvents.map(ev => `
    <div class="parte-row">
      <span>${ev.time ? ev.time + ' · ' : ''}${escapeHtml(ev.title)}</span>
      <span class="ev-actions">
        <button class="icon-btn" data-edit="${ev.id}">✎</button>
        <button class="icon-btn" data-del="${ev.id}">✕</button>
      </span>
    </div>`).join('') || '<p class="empty-note">Sin eventos este día.</p>';

  renderModal(`
    <h3 style="text-transform:capitalize">${niceDate}</h3>
    ${rows}
    <div class="modal-actions">
      <button class="btn btn-ghost" id="modalClose">Cerrar</button>
      <button class="btn btn-primary" id="modalAdd">+ Añadir evento</button>
    </div>
  `);
  $('#modalClose').addEventListener('click', closeModal);
  $('#modalAdd').addEventListener('click', () => openEventModal(null, dateStr));
  $$('#modalRoot [data-edit]').forEach(b => b.addEventListener('click', () => openEventModal(b.dataset.edit)));
  $$('#modalRoot [data-del]').forEach(b => b.addEventListener('click', () => { deleteEvent(b.dataset.del); openDayModal(dateStr); }));
}

function openEventModal(id, presetDate){
  const existing = id ? events.find(e => e.id === id) : null;
  renderModal(`
    <h3>${existing ? 'Editar evento' : 'Nuevo evento'}</h3>
    <div class="field"><label>Título</label><input id="fTitle" value="${existing ? escapeAttr(existing.title) : ''}" placeholder="Reunión de entre semana"></div>
    <div class="field"><label>Fecha</label><input id="fDate" type="date" value="${existing ? existing.date : (presetDate || new Date().toISOString().slice(0,10))}"></div>
    <div class="field"><label>Hora (opcional)</label><input id="fTime" type="time" value="${existing ? existing.time || '' : ''}"></div>
    <div class="field"><label>Notas</label><textarea id="fNotes">${existing ? escapeHtml(existing.notes || '') : ''}</textarea></div>
    <div class="field" style="flex-direction:row; align-items:center; gap:8px;">
      <input type="checkbox" id="fRemind" ${existing && existing.remind === false ? '' : 'checked'} style="width:auto;">
      <label style="margin:0;">Avisarme mientras tenga el panel abierto</label>
    </div>
    <div class="modal-actions">
      ${existing ? '<button class="btn btn-ghost" id="modalDelete" style="color:#B4432D;">Eliminar</button>' : ''}
      <button class="btn btn-ghost" id="modalCancel">Cancelar</button>
      <button class="btn btn-primary" id="modalSave">Guardar</button>
    </div>
  `);
  $('#modalCancel').addEventListener('click', closeModal);
  if (existing) $('#modalDelete').addEventListener('click', () => { deleteEvent(existing.id); closeModal(); });
  $('#modalSave').addEventListener('click', async () => {
    const title = $('#fTitle').value.trim();
    const date = $('#fDate').value;
    if (!title || !date) { alert('Falta título o fecha.'); return; }
    const data = {
      id: existing ? existing.id : 'e_' + Date.now(),
      title, date,
      time: $('#fTime').value,
      notes: $('#fNotes').value.trim(),
      remind: $('#fRemind').checked,
    };
    if (existing) Object.assign(existing, data);
    else events.push(data);
    closeModal();
    showSand('Guardando en Drive…');
    try { await persistEvents(); renderCalendar(); renderUpcoming(); }
    finally { hideSand(); }
  });
}

async function deleteEvent(id){
  events = events.filter(e => e.id !== id);
  showSand('Guardando en Drive…');
  try { await persistEvents(); renderCalendar(); renderUpcoming(); }
  finally { hideSand(); }
}

function downloadIcs(id){
  const ev = events.find(e => e.id === id);
  if (!ev) return;
  const dt = `${ev.date.replace(/-/g, '')}${ev.time ? 'T' + ev.time.replace(':', '') + '00' : ''}`;
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Hourglass Panel//ES',
    'BEGIN:VEVENT',
    `UID:${ev.id}@hourglass-panel`,
    ev.time ? `DTSTART:${dt}` : `DTSTART;VALUE=DATE:${dt}`,
    `SUMMARY:${(ev.title || '').replace(/\n/g, ' ')}`,
    ev.notes ? `DESCRIPTION:${ev.notes.replace(/\n/g, '\\n')}` : '',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
  const blob = new Blob([ics], { type: 'text/calendar' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${ev.title.replace(/[^\w-]+/g, '_')}.ics`;
  a.click();
}

function checkReminders(){
  if (!('Notification' in window)) return;
  const now = new Date();
  events.forEach(ev => {
    if (!ev.remind || !ev.time || notifiedIds.has(ev.id)) return;
    const when = new Date(`${ev.date}T${ev.time}`);
    const diffMin = (when - now) / 60000;
    if (diffMin > 0 && diffMin <= 30) {
      notifiedIds.add(ev.id);
      localStorage.setItem('hg_notified', JSON.stringify([...notifiedIds]));
      notify(ev.title, `Hoy a las ${ev.time}`);
    }
  });
}

function notify(title, body){
  if (Notification.permission === 'granted') new Notification(title, { body, icon: undefined });
  else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then(p => { if (p === 'granted') new Notification(title, { body }); });
  }
}

/* =========================================================
   Proyectos de reunión
   ========================================================= */
async function loadProyectos(){
  const f = await findFile(CONFIG.PROYECTOS_NAME, folderId, 'application/json');
  if (!f) { proyectos = []; return; }
  const res = await downloadFile(f.id);
  proyectos = await res.json().catch(() => []);
}

async function persistProyectos(){
  await saveFile(CONFIG.PROYECTOS_NAME, 'application/json', JSON.stringify(proyectos, null, 2), folderId);
}

function renderProyectos(){
  const wrap = $('#proyectosList');
  if (proyectos.length === 0) {
    wrap.innerHTML = '<p class="empty-note">Todavía no has creado ningún proyecto de reunión.</p>';
    return;
  }
  wrap.innerHTML = proyectos
    .slice()
    .sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''))
    .map(p => `
      <div class="proyecto-card" data-id="${p.id}">
        <h3>${escapeHtml(p.titulo)}</h3>
        <p class="fecha">${p.fecha ? new Date(p.fecha + 'T00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }) : ''}</p>
        ${(p.partes || []).map(pt => `<div class="parte-row"><span>${escapeHtml(pt.titulo)}</span><span class="asignado">${escapeHtml(pt.asignado || '')}</span></div>`).join('') || '<p class="empty-note">Sin partes añadidas.</p>'}
        <div class="proyecto-actions">
          <button class="btn btn-ghost" data-edit-p="${p.id}">Editar</button>
          <button class="btn btn-ghost" data-del-p="${p.id}" style="color:#B4432D;">Eliminar</button>
        </div>
      </div>`).join('');

  wrap.querySelectorAll('[data-edit-p]').forEach(b => b.addEventListener('click', () => openProyectoModal(b.dataset.editP)));
  wrap.querySelectorAll('[data-del-p]').forEach(b => b.addEventListener('click', () => deleteProyecto(b.dataset.delP)));
}

$('#addProyectoBtn').addEventListener('click', () => openProyectoModal());

function openProyectoModal(id){
  const existing = id ? proyectos.find(p => p.id === id) : null;
  const partes = existing ? existing.partes.slice() : [{ titulo: '', asignado: '' }];

  function partesHtml(){
    return partes.map((pt, i) => `
      <div class="parte-input-row" data-i="${i}">
        <input class="pt-titulo" placeholder="Parte (p. ej. Perlas de la Palabra)" value="${escapeAttr(pt.titulo)}">
        <input class="pt-asignado" placeholder="Asignado" value="${escapeAttr(pt.asignado)}" style="max-width:120px;">
        <button class="icon-btn" data-remove-parte="${i}">✕</button>
      </div>`).join('');
  }

  renderModal(`
    <h3>${existing ? 'Editar proyecto' : 'Nuevo proyecto de reunión'}</h3>
    <div class="field"><label>Título</label><input id="pTitulo" value="${existing ? escapeAttr(existing.titulo) : ''}" placeholder="Reunión de vida y ministerio"></div>
    <div class="field"><label>Fecha</label><input id="pFecha" type="date" value="${existing ? existing.fecha || '' : new Date().toISOString().slice(0,10)}"></div>
    <div class="field"><label>Partes</label><div id="partesWrap">${partesHtml()}</div>
      <button class="btn btn-ghost" id="addParteBtn" style="align-self:flex-start;">+ Añadir parte</button>
    </div>
    <div class="modal-actions">
      ${existing ? '<button class="btn btn-ghost" id="modalDelete" style="color:#B4432D;">Eliminar</button>' : ''}
      <button class="btn btn-ghost" id="modalCancel">Cancelar</button>
      <button class="btn btn-primary" id="modalSave">Guardar</button>
    </div>
  `);

  function bindParteRows(){
    $$('#partesWrap [data-remove-parte]').forEach(b => b.addEventListener('click', () => {
      partes.splice(Number(b.dataset.removeParte), 1);
      $('#partesWrap').innerHTML = partesHtml();
      bindParteRows();
    }));
  }
  bindParteRows();

  $('#addParteBtn').addEventListener('click', () => {
    partes.push({ titulo: '', asignado: '' });
    $('#partesWrap').innerHTML = partesHtml();
    bindParteRows();
  });

  $('#modalCancel').addEventListener('click', closeModal);
  if (existing) $('#modalDelete').addEventListener('click', () => { deleteProyecto(existing.id); closeModal(); });

  $('#modalSave').addEventListener('click', async () => {
    const titulo = $('#pTitulo').value.trim();
    if (!titulo) { alert('Falta el título.'); return; }
    const rows = $$('#partesWrap .parte-input-row').map(row => ({
      titulo: row.querySelector('.pt-titulo').value.trim(),
      asignado: row.querySelector('.pt-asignado').value.trim(),
    })).filter(p => p.titulo);

    const data = { id: existing ? existing.id : 'p_' + Date.now(), titulo, fecha: $('#pFecha').value, partes: rows };
    if (existing) Object.assign(existing, data);
    else proyectos.push(data);

    closeModal();
    showSand('Guardando en Drive…');
    try { await persistProyectos(); renderProyectos(); }
    finally { hideSand(); }
  });
}

async function deleteProyecto(id){
  proyectos = proyectos.filter(p => p.id !== id);
  showSand('Guardando en Drive…');
  try { await persistProyectos(); renderProyectos(); }
  finally { hideSand(); }
}

/* =========================================================
   Modal genérico
   ========================================================= */
function renderModal(innerHtml){
  $('#modalRoot').innerHTML = `<div class="modal-backdrop" id="backdrop"><div class="modal">${innerHtml}</div></div>`;
  $('#backdrop').addEventListener('click', (e) => { if (e.target.id === 'backdrop') closeModal(); });
}
function closeModal(){ $('#modalRoot').innerHTML = ''; }

/* =========================================================
   Utilidades
   ========================================================= */
function escapeHtml(str){
  return String(str || '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function escapeAttr(str){ return escapeHtml(str); }

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
