/* =========================================================
   Hourglass Panel — configuración
   ========================================================= */
const CONFIG = {
  // Sustituye por tu Client ID de Google Cloud Console (OAuth 2.0 → Web application)
  CLIENT_ID: '989709837307-449de0hk767r7lplvjfc4ilfb6smnpfd.apps.googleusercontent.com',
  SCOPES: 'https://www.googleapis.com/auth/drive.file',
  FOLDER_NAME: 'Hourglass Panel',
  CUADRANTE_PREFIX: 'cuadrante-actual',   // solo para migrar cuadrantes antiguos
  ASIGNACIONES_NAME: 'asignaciones.json', // idem
  CUADRANTES_INDEX: 'cuadrantes.json',    // índice del historial de cuadrantes
  HISTORIAL_NAME: 'historial-asignaciones.json',
  OCULTAS_NAME: 'asignaciones-ocultas.json',
  EVENTS_NAME: 'eventos.json',
  PROYECTOS_NAME: 'proyectos.json',
  MINISTERIO_NAME: 'ministerio.json',
  TAREAS_NAME: 'tareas.json',
};

/* =========================================================
   Estado
   ========================================================= */
let tokenClient, accessToken = null, folderId = null;
let events = [];
let proyectos = [];
let ministerio = [];          // [{ id, date, minutes, note }]
let tareas = [];              // [{ id, title, done, doneAt, due, time, priority, project, labels[], notes, subtasks[], createdAt }]
let tareasView = 'hoy';       // hoy | proximo | todas | hechas
let tareasFilter = { project: '', label: '' };
let hiddenKeys = new Set();   // claves de asignaciones ocultadas por el usuario
let cuadrantesIdx = [];       // [{ id, uploaded, mime, ext, tipo, docName, parseName }] (recientes primero)
let currentCuadranteId = null;
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
    await loadHistorial(); // primero, para que openCuadrante pueda fusionar sin condición de carrera
    await loadHidden();
    await loadEvents();     // antes de openCuadrante: su sync al calendario necesita los eventos ya cargados
    await loadMinisterio();
    await loadTareas();
    await loadCuadrantesIndex();
    await Promise.all([loadProyectos(), openCuadrante()]);
    renderNameMatches();
    updateHiddenBar();
    renderCuadranteHistory();
    await syncMyAssignmentsToCalendar(); // vuelca mis asignaciones al calendario
    renderCalendar();
    renderUpcoming();
    renderProyectos();
    renderMinisterio();
    renderTareas();
    renderDashboard();
    handleLaunchParams();
    checkReminders();
    setInterval(checkReminders, 60000);
  } catch (err) {
    console.error(err);
    showError('Hubo un problema conectando con Drive. Vuelve a intentar el inicio de sesión.');
  } finally {
    hideSand();
  }
}

/* Accesos directos del icono / widgets: index.html?go=<pestaña>&nueva=1 */
function handleLaunchParams(){
  const q = new URLSearchParams(location.search);
  const go = q.get('go');
  if (go && document.getElementById('tab-' + go)) activateTab(go);
  if (q.get('nueva') === '1' && go === 'tareas') setTimeout(() => openTareaModal(), 200);
  if (go || q.get('nueva')) history.replaceState(null, '', location.pathname);
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

function showError(msg){
  let banner = document.getElementById('errorBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'errorBanner';
    banner.className = 'error-banner';
    document.body.prepend(banner);
  }
  banner.innerHTML = `<span>${escapeHtml(msg)}</span><button aria-label="Cerrar">✕</button>`;
  banner.querySelector('button').addEventListener('click', () => banner.remove());
  clearTimeout(banner._hideTimer);
  banner._hideTimer = setTimeout(() => banner.remove(), 8000);
}

function activateTab(name){
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $$('.panel').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
$$('.tab').forEach(tab => tab.addEventListener('click', () => activateTab(tab.dataset.tab)));
document.getElementById('goProgramaBtn').addEventListener('click', () => activateTab('programa'));

/* =========================================================
   Drive — utilidades genéricas
   ========================================================= */
async function driveFetch(url, options = {}){
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Tiempo de espera agotado hablando con Drive.');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
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

async function findFilesByPrefix(prefix, parentId){
  const q = `name contains '${prefix.replace(/'/g, "\\'")}' and '${parentId}' in parents and trashed=false`;
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,modifiedTime)&spaces=drive&orderBy=modifiedTime desc`
  );
  const data = await res.json();
  return data.files || [];
}

async function deleteFile(fileId){
  await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, { method: 'DELETE' });
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
   Cuadrantes — subida e historial (PDF o imagen)
   Cada subida se guarda como cuadrante-<sello>.<ext> + asignaciones-<sello>.json
   y se registra en cuadrantes.json. No se borra ninguno automáticamente.
   ========================================================= */
let currentDocBlob = null;
let currentDocUrl = null;
let currentDocMime = null;
let currentParsed = null; // { tipo, asignaciones: [...] }

function nowStamp(){
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function tipoLabel(t){
  return t === 'entre-semana' ? 'Entre semana'
    : t === 'publica' ? 'Reunión pública'
    : 'Documento';
}

$('#pdfInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const isImage = file.type.startsWith('image/');
  const isPdf = file.type === 'application/pdf';
  if (!isImage && !isPdf) { showError('Sube un PDF o una imagen (JPG, PNG…).'); e.target.value = ''; return; }

  showSand('Subiendo cuadrante…');
  try {
    const ext = isPdf ? 'pdf' : (file.name.split('.').pop() || 'jpg').toLowerCase();
    const mime = isPdf ? 'application/pdf' : file.type;
    const stamp = nowStamp();
    const docName = `cuadrante-${stamp}.${ext}`;
    const parseName = `asignaciones-${stamp}.json`;

    const meta = await createFileMeta(docName, folderId, mime);
    await updateFileContent(meta.id, mime, file);

    // muestra ya el original mientras se analiza
    if (currentDocUrl) URL.revokeObjectURL(currentDocUrl);
    currentDocBlob = file; currentDocMime = mime;
    currentDocUrl = URL.createObjectURL(file);
    renderOriginalViewer(currentDocMime, currentDocUrl);
    $('#viewToggle').hidden = false;

    currentParsed = await parseBlob(file, mime);
    await saveFile(parseName, 'application/json', JSON.stringify(currentParsed, null, 2), folderId);
    await mergeIntoHistorial(currentParsed);

    const entry = { id: stamp, uploaded: new Date().toISOString(), mime, ext, tipo: currentParsed.tipo, docName, parseName };
    cuadrantesIdx.unshift(entry);
    await persistCuadrantesIndex();
    currentCuadranteId = stamp;

    $('#cuadranteMeta').textContent = `${tipoLabel(currentParsed.tipo)} · subido hoy`;
    { const gp = document.getElementById('goProgramaBtn'); if (gp) gp.hidden = false; }
    renderCuadranteHistory();
    renderDigitalView(currentParsed);
    renderNameMatches();
    updateHiddenBar();
    await syncMyAssignmentsToCalendar();
    renderDashboard();
  } catch (err) {
    console.error(err);
    showError('No se pudo subir el archivo.');
  } finally {
    hideSand();
    e.target.value = '';
  }
});

/* Analiza un blob (PDF/imagen) y devuelve { tipo, asignaciones }. Nunca lanza. */
async function parseBlob(blob, mime){
  showSand(mime === 'application/pdf' ? 'Leyendo el PDF…' : 'Reconociendo el texto de la imagen (OCR)…');
  try {
    const pages = mime === 'application/pdf'
      ? await extractPagesFromPdf(blob)
      : await extractPagesFromImage(blob, (m) => {
          if (m.status === 'recognizing text') showSand(`Reconociendo texto… ${Math.round((m.progress || 0) * 100)}%`);
        });
    return parseCuadrante(pages);
  } catch (err) {
    console.error(err);
    showError('No se pudo digitalizar el documento; puedes seguir consultando el original.');
    return { tipo: 'desconocido', asignaciones: [], error: true };
  } finally {
    hideSand();
  }
}

async function persistCuadrantesIndex(){
  await saveFile(CONFIG.CUADRANTES_INDEX, 'application/json', JSON.stringify(cuadrantesIdx, null, 2), folderId);
}

/* Carga el índice; si no existe, migra los cuadrantes del formato antiguo. */
async function loadCuadrantesIndex(){
  const f = await findFile(CONFIG.CUADRANTES_INDEX, folderId, 'application/json');
  if (f) {
    try {
      const r = await downloadFile(f.id);
      cuadrantesIdx = (await r.json()) || [];
    } catch (e) { cuadrantesIdx = []; }
  } else {
    cuadrantesIdx = [];
    const legacy = await findFilesByPrefix(CONFIG.CUADRANTE_PREFIX, folderId);
    if (legacy.length) {
      const oldParse = await findFile(CONFIG.ASIGNACIONES_NAME, folderId, 'application/json');
      legacy
        .sort((a, b) => (b.modifiedTime || '').localeCompare(a.modifiedTime || ''))
        .forEach((lf, i) => {
          cuadrantesIdx.push({
            id: 'legacy-' + i,
            uploaded: lf.modifiedTime || new Date().toISOString(),
            mime: lf.mimeType || (/\.pdf$/i.test(lf.name) ? 'application/pdf' : 'image/*'),
            ext: (lf.name.split('.').pop() || 'pdf').toLowerCase(),
            tipo: '?',
            docName: lf.name,
            parseName: (i === 0 && oldParse) ? CONFIG.ASIGNACIONES_NAME : null,
          });
        });
      try { await persistCuadrantesIndex(); } catch (e) { /* no crítico */ }
    }
  }
  cuadrantesIdx.sort((a, b) => (b.uploaded || '').localeCompare(a.uploaded || ''));
}

/* Abre un cuadrante del historial (o el más reciente si no se indica id). */
async function openCuadrante(id){
  const entry = (id && cuadrantesIdx.find(c => c.id === id)) || cuadrantesIdx[0] || null;
  const meta = $('#cuadranteMeta');
  const toggle = $('#viewToggle');
  const gp = document.getElementById('goProgramaBtn');

  if (!entry) {
    currentCuadranteId = null; currentDocBlob = null; currentParsed = null;
    toggle.hidden = true;
    setOriginalViewerEmpty();
    $('#digitalView').innerHTML = '';
    meta.textContent = '';
    if (gp) gp.hidden = true;
    renderCuadranteHistory();
    renderDigitalView(null);
    renderNameMatches();
    return;
  }
  currentCuadranteId = entry.id;

  const docFile = await findFile(entry.docName, folderId);
  if (!docFile) { showError('No se encontró el archivo de este cuadrante en Drive.'); return; }
  const blob = await (await downloadFile(docFile.id)).blob();
  if (currentDocUrl) URL.revokeObjectURL(currentDocUrl);
  currentDocBlob = blob;
  currentDocMime = entry.mime && entry.mime !== 'image/*' ? entry.mime : blob.type;
  currentDocUrl = URL.createObjectURL(blob);
  renderOriginalViewer(currentDocMime, currentDocUrl);
  toggle.hidden = false;
  if (gp) gp.hidden = false;

  const d = new Date(entry.uploaded);
  meta.textContent = `${tipoLabel(entry.tipo)} · subido el ${d.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' })}`;

  let parsed = null;
  if (entry.parseName) {
    const pf = await findFile(entry.parseName, folderId, 'application/json');
    if (pf) { try { parsed = await (await downloadFile(pf.id)).json(); } catch (e) { parsed = null; } }
  }
  if (!parsed) {
    parsed = await parseBlob(blob, currentDocMime);
    const pn = entry.parseName || `asignaciones-${entry.id}.json`;
    entry.parseName = pn;
    try { await saveFile(pn, 'application/json', JSON.stringify(parsed, null, 2), folderId); } catch (e) { /* no crítico */ }
  }
  currentParsed = parsed;

  if (entry.tipo === '?' && parsed.tipo && parsed.tipo !== 'desconocido') {
    entry.tipo = parsed.tipo;
    try { await persistCuadrantesIndex(); } catch (e) { /* no crítico */ }
  }

  await mergeIntoHistorial(parsed);
  renderCuadranteHistory();
  renderDigitalView(parsed);
  renderNameMatches();
  updateHiddenBar();
  await syncMyAssignmentsToCalendar();
  renderDashboard();
}

async function deleteCuadrante(id){
  const entry = cuadrantesIdx.find(c => c.id === id);
  if (!entry) return;
  const d = new Date(entry.uploaded).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
  renderModal(`
    <h3>Borrar cuadrante</h3>
    <p>Se eliminará el documento de <strong>${escapeHtml(d)}</strong> (${escapeHtml(tipoLabel(entry.tipo))}).
    Las asignaciones que ya se registraron se conservan en tu historial.</p>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="modalCancel">Cancelar</button>
      <button class="btn btn-primary" id="modalConfirm" style="background:#B4432D; color:#FFF5EF;">Borrar</button>
    </div>`);
  $('#modalCancel').addEventListener('click', closeModal);
  $('#modalConfirm').addEventListener('click', async () => {
    closeModal();
    showSand('Borrando…');
    try {
      for (const nm of [entry.docName, entry.parseName]) {
        if (!nm) continue;
        const ff = await findFile(nm, folderId);
        if (ff) { try { await deleteFile(ff.id); } catch (_) {} }
      }
      cuadrantesIdx = cuadrantesIdx.filter(c => c.id !== id);
      await persistCuadrantesIndex();
      if (currentCuadranteId === id) await openCuadrante();
      else { renderCuadranteHistory(); renderDashboard(); }
    } catch (err) {
      console.error(err);
      showError('No se pudo borrar el cuadrante.');
    } finally { hideSand(); }
  });
}

function renderCuadranteHistory(){
  const box = document.getElementById('cuadranteHistory');
  if (!box) return;
  if (!cuadrantesIdx.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = `<span class="ch-label">Cuadrantes guardados</span>
    <div class="ch-list">${cuadrantesIdx.map(c => {
      const d = new Date(c.uploaded).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
      return `<div class="ch-item${c.id === currentCuadranteId ? ' active' : ''}" data-open="${escapeAttr(c.id)}">
        <span class="ch-date">${escapeHtml(d)}</span>
        <span class="ch-tipo">${escapeHtml(tipoLabel(c.tipo))}</span>
        <button class="ch-del" title="Borrar" data-del="${escapeAttr(c.id)}">🗑</button>
      </div>`;
    }).join('')}</div>`;
  box.querySelectorAll('.ch-item').forEach(el => el.addEventListener('click', (e) => {
    if (e.target.closest('.ch-del')) return;
    openCuadrante(el.dataset.open);
  }));
  box.querySelectorAll('.ch-del').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteCuadrante(b.dataset.del);
  }));
}

/* ---------- Historial de asignaciones (persiste aunque se reemplace el cuadrante) ---------- */
let currentHistorial = [];

async function loadHistorial(){
  const f = await findFile(CONFIG.HISTORIAL_NAME, folderId, 'application/json');
  if (!f) { currentHistorial = []; return; }
  try {
    const r = await downloadFile(f.id);
    currentHistorial = await r.json();
  } catch (e) { currentHistorial = []; }
}

function assignmentKey(a){
  if (a.tipo === 'entre-semana') return ['mw', a.fecha, a.parte, a.rol, (a.nombres || []).join('/')].join('|');
  return ['pub', a.fecha, a.discursante || '', a.presidente || '', a.asamblea ? 'asamblea' : ''].join('|');
}
/* clave de una asignación de `currentParsed` (que no lleva `tipo` propio) */
function keyOf(a, tipo){ return assignmentKey(tipo ? { tipo, ...a } : a); }
function isHiddenKey(k){ return k && hiddenKeys.has(k); }

/* ---------- Asignaciones ocultadas por el usuario (persisten en Drive) ---------- */
async function loadHidden(){
  const f = await findFile(CONFIG.OCULTAS_NAME, folderId, 'application/json');
  if (!f) { hiddenKeys = new Set(); return; }
  try {
    const r = await downloadFile(f.id);
    hiddenKeys = new Set(await r.json());
  } catch (e) { hiddenKeys = new Set(); }
}
async function persistHidden(){
  await saveFile(CONFIG.OCULTAS_NAME, 'application/json', JSON.stringify([...hiddenKeys], null, 2), folderId);
}

async function hideAssignment(key){
  if (!key || hiddenKeys.has(key)) return;
  hiddenKeys.add(key);
  showSand('Guardando…');
  try { await persistHidden(); } catch (e) { showError('No se pudo guardar el cambio.'); }
  finally { hideSand(); }
  renderDigitalView(currentParsed);
  renderNameMatches();
  updateHiddenBar();
  await syncMyAssignmentsToCalendar();
}
async function resetHidden(){
  if (hiddenKeys.size === 0) return;
  hiddenKeys.clear();
  showSand('Guardando…');
  try { await persistHidden(); } catch (e) { showError('No se pudo guardar el cambio.'); }
  finally { hideSand(); }
  renderDigitalView(currentParsed);
  renderNameMatches();
  updateHiddenBar();
  await syncMyAssignmentsToCalendar();
}
function updateHiddenBar(){
  const bar = document.getElementById('hiddenBar');
  if (!bar) return;
  if (hiddenKeys.size === 0) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  bar.innerHTML = `<span>${hiddenKeys.size} asignación${hiddenKeys.size === 1 ? '' : 'es'} oculta${hiddenKeys.size === 1 ? '' : 's'}.</span>
    <button class="btn btn-ghost" id="resetHiddenBtn">Volver a mostrar todas</button>`;
  bar.querySelector('#resetHiddenBtn').addEventListener('click', resetHidden);
}

async function mergeIntoHistorial(parsed){
  const seen = new Set(currentHistorial.map(assignmentKey));
  let added = 0;
  (parsed.asignaciones || []).forEach(a => {
    const record = { tipo: parsed.tipo, ...a };
    const key = assignmentKey(record);
    if (!seen.has(key)) { seen.add(key); currentHistorial.push(record); added++; }
  });
  if (added > 0) {
    await saveFile(CONFIG.HISTORIAL_NAME, 'application/json', JSON.stringify(currentHistorial, null, 2), folderId);
  }
}

/* ---------- Alternar vista digital / documento original ---------- */
$$('#viewToggle .vt-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('#viewToggle .vt-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const digital = btn.dataset.view === 'digital';
    $('#digitalView').hidden = !digital;
    $('#cuadranteViewer').hidden = digital;
  });
});

function setOriginalViewerEmpty(){
  const viewer = $('#cuadranteViewer');
  viewer.hidden = false;
  viewer.classList.add('empty');
  viewer.innerHTML = '<p>Todavía no hay ningún cuadrante subido.</p>';
}

function renderOriginalViewer(mime, url){
  const viewer = $('#cuadranteViewer');
  viewer.classList.remove('empty');
  viewer.hidden = true; // por defecto se muestra la vista digital
  if (mime === 'application/pdf') {
    viewer.innerHTML = `<embed id="pdfEmbed" src="${url}" type="application/pdf">`;
  } else {
    viewer.innerHTML = `<img id="pdfEmbed" src="${url}" alt="Cuadrante" style="width:100%; display:block;">`;
  }
}

function jumpToPage(page){
  const embed = $('#pdfEmbed');
  if (!embed || !currentDocUrl) return;
  activateTab('programa');
  $$('#viewToggle .vt-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'original'));
  $('#digitalView').hidden = true;
  $('#cuadranteViewer').hidden = false;
  if (currentDocMime === 'application/pdf') embed.setAttribute('src', `${currentDocUrl}#page=${page}`);
}

/* =========================================================
   Extracción de texto posicionado — PDF (pdf.js) e imagen (Tesseract OCR)
   Ambas convergen en el mismo formato: pages = [{ width, lines: [{items, text}] }]
   ========================================================= */
function median(arr){
  if (!arr || !arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/* Une los fragmentos de una misma línea mirando el hueco real en X entre uno y el
   siguiente: si van pegados se concatenan sin espacio (evita "pa labra"); si hay
   separación se mete un espacio (evita "9:30Lectura de la Biblia"). Respeta los
   espacios que el propio extractor ya haya incluido en el fragmento. */
function joinItemsX(items){
  const refH = median(items.map(i => i.h).filter(Boolean)) || 6;
  let out = '';
  let prevEnd = null;
  items.forEach((it, i) => {
    const frag = String(it.text || '');
    if (i === 0 || prevEnd == null) { out = frag; prevEnd = it.x + (it.w || 0); return; }
    const gap = it.x - prevEnd;
    const glued = /\s$/.test(out) || /^\s/.test(frag);
    out += (!glued && gap > refH * 0.2 ? ' ' : '') + frag;
    prevEnd = it.x + (it.w || 0);
  });
  return out.replace(/\s+/g, ' ').trim();
}

/* Agrupa los fragmentos sueltos en líneas visuales por su CENTRO vertical (no por
   la baseline), con una tolerancia proporcional a la altura del texto. Así una
   fila con varios tamaños de fuente (hora + título + nombre) no se parte en dos. */
function clusterItemsIntoLines(items, yTolerance){
  if (!items || !items.length) return [];
  if (yTolerance == null) {
    const medH = median(items.map(i => i.h).filter(Boolean)) || 10;
    yTolerance = Math.max(4, medH * 0.6);
  }
  const withMid = items.map(i => ({
    ...i,
    mid: (i.y != null ? i.y : 0) + (i.h ? i.h / 2 : 0),
  }));
  const sorted = withMid.slice().sort((a, b) => a.mid - b.mid || a.x - b.x);

  const lines = [];
  sorted.forEach(it => {
    const line = lines[lines.length - 1];
    if (line && Math.abs(it.mid - line.mid) <= yTolerance) {
      line.items.push(it);
      line.mid = (line.mid * line._n + it.mid) / (line._n + 1);
      line._n++;
    } else {
      lines.push({ mid: it.mid, _n: 1, items: [it] });
    }
  });

  return lines
    .map(l => {
      const its = l.items.slice().sort((a, b) => a.x - b.x);
      return { y: l.mid, items: its, text: joinItemsX(its) };
    })
    .filter(l => l.text);
}

async function extractPagesFromPdf(blob){
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const buf = await blob.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items
      .filter(it => it.str && it.str.trim() !== '')
      .map(it => {
        const tx = it.transform;
        const h = it.height || Math.hypot(tx[2], tx[3]) || 10;
        return {
          text: it.str,
          x: tx[4],
          y: viewport.height - tx[5], // origen arriba, crece hacia abajo
          w: it.width || 0,
          h,
        };
      });
    pages.push({ width: viewport.width, height: viewport.height, lines: clusterItemsIntoLines(items) });
  }
  return pages;
}

async function extractPagesFromImage(blob, onProgress){
  if (typeof Tesseract === 'undefined') throw new Error('Tesseract no disponible');
  const { data } = await Tesseract.recognize(blob, 'spa', { logger: onProgress });
  const items = (data.words || [])
    .filter(w => w.text && w.text.trim() !== '')
    .map(w => ({
      text: w.text,
      x: w.bbox.x0,
      y: w.bbox.y0,
      w: w.bbox.x1 - w.bbox.x0,
      h: w.bbox.y1 - w.bbox.y0,
    }));
  const width = data.width || (items.length ? Math.max(...items.map(i => i.x + i.w)) : 1000);
  return [{ width, height: data.height || 1000, lines: clusterItemsIntoLines(items) }];
}

/* =========================================================
   Parsers — de texto posicionado a asignaciones estructuradas
   ========================================================= */
function normalizeText(s){
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function normalizeKey(s){ return normalizeText(s).replace(/[^a-z0-9]+/g, ' ').trim(); }

/* Frontera entre la columna de "concepto" (izquierda) y la de "rol / nombre"
   (derecha). Método principal: alinearla con el borde izquierdo de las etiquetas
   fijas de la derecha ("Oración", "Presidente"… / "PRESIDENTE", "LECTOR"…), que en
   estos cuadrantes están SIEMPRE a la misma x. Respaldo: el mayor hueco horizontal.
   Es mucho más estable que el hueco solo, que se rompe con títulos largos. */
function detectColumnSplit(page, labelTokens){
  if (labelTokens && labelTokens.length) {
    const xs = [];
    page.lines.forEach(l => l.items.forEach(it => {
      const n = normalizeText(it.text).trim();
      if (labelTokens.some(tok => n === tok || n.startsWith(tok + ' '))) xs.push(it.x);
    }));
    if (xs.length >= 2) {
      xs.sort((a, b) => a - b);
      // Cuartil inferior ≈ borde izquierdo de la columna de etiquetas; el margen deja
      // la frontera claramente a la izquierda de ellas (y de sus valores).
      const edge = xs[Math.floor(xs.length * 0.25)];
      return edge - Math.max(12, page.width * 0.02);
    }
  }
  const xs = [];
  page.lines.forEach(l => l.items.forEach(i => xs.push(Math.round(i.x))));
  const uniq = [...new Set(xs)].sort((a, b) => a - b);
  if (uniq.length < 4) return page.width * 0.6;
  const lo = page.width * 0.25, hi = page.width * 0.85;
  let bestGap = 0, bestSplit = page.width * 0.6;
  for (let i = 1; i < uniq.length; i++) {
    const mid = (uniq[i] + uniq[i - 1]) / 2;
    if (mid < lo || mid > hi) continue;
    const gap = uniq[i] - uniq[i - 1];
    if (gap > bestGap) { bestGap = gap; bestSplit = mid; }
  }
  return bestSplit;
}

/* Divide un texto de nombres en personas sueltas. Separadores reales en los
   cuadrantes: "/", "&", "+". NO se parte por coma ni por "y" porque aparecen
   dentro de nombres ("Diaz, Domínguez", "Amaya y..."). */
function splitNames(text){
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/\s*[\/⁄&+]\s*/)
    .map(s => s.trim().replace(/^[·•\-–,;.]+\s*/, '').trim())
    .filter(Boolean);
}

/* Limpia artefactos típicos de fuentes con mapeo Unicode roto en el PDF de origen
   (viñetas que se extraen como "e", "«", "+", comas en vez de puntos, etc.) */
function cleanParteText(s){
  let t = String(s || '').trim();
  // 0) Quita viñetas al principio (una o varias): • · ▪ ◦ ‣ ∙ *
  t = t.replace(/^[•·▪◦‣∙*]+\s*/, '');
  // 1) Quita cualquier viñeta/artefacto de 1-2 caracteres NO alfanuméricos al principio
  t = t.replace(/^[^\wÀ-ÿ¿¡0-9]{1,2}\s*/, '');
  // 2) Si empieza por número de parte, normaliza "N," / "N;" a "N."
  t = t.replace(/^(\d{1,2})[,;]\s*/, '$1. ');
  // 3) Quita una letra suelta (artefacto de fuente), p.ej. "e Palabras" → "Palabras"
  t = t.replace(/^[a-zA-Z]\s+(?=[A-ZÁÉÍÓÚÑ0-9¿])/, '');
  return t.trim();
}

function detectTipo(pages){
  const raw = pages.map(p => p.lines.map(l => l.text).join('\n')).join('\n');
  const key = normalizeKey(raw);
  if (key.includes('tesoros de la biblia') || key.includes('seamos mejores maestros') || key.includes('nuestra vida cristiana')) return 'entre-semana';
  if ((key.includes('discursante') && key.includes('congregacion')) || key.includes('lector de la atalaya')) return 'publica';
  // Respaldo por formato de fecha cuando los encabezados no se han extraído limpios
  if (/\d{4}\/\d{2}\/\d{2}\s*\|/.test(raw)) return 'entre-semana';
  if (/^\s*\d{1,2}\s+[A-ZÁÉÍÓÚÑ]{3,}\s+\d{4}\s*$/m.test(raw)) return 'publica';
  return 'desconocido';
}

const MIDWEEK_SECTIONS = ['tesoros de la biblia', 'seamos mejores maestros', 'nuestra vida cristiana', 'vivamos como cristianos'];

const MIDWEEK_LABEL_TOKENS = ['oracion', 'presidente', 'conductor', 'lector'];
const MIDWEEK_ROLE_RE = /^\s*(Oraci[oó]n|Presidente|Conductor|Lector|Consejero(?:\s+de\s+la\s+sala\s+auxiliar)?)\b[\s:.\-]*(.*)$/i;
const MIDWEEK_SKIP_RE = /^(sala auxiliar|sala auxiliar auditorio principal|auditorio principal|consejero de la sala auxiliar)$/;
const MIDWEEK_TIME_RE = /^(\d{1,2}):(\d{2})$/;
const MIDWEEK_DATE_RE = /^(\d{4}\/\d{2}\/\d{2})\s*[|｜Il]\s*(.*)$/;

function midweekRole(text){
  const m = String(text || '').match(MIDWEEK_ROLE_RE);
  if (!m) return null;
  const r = m[1].toLowerCase();
  const rol = /^oraci/.test(r) ? 'Oración'
    : /^presidente/.test(r) ? 'Presidente'
    : /^conductor/.test(r) ? 'Conductor'
    : /^lector/.test(r) ? 'Lector'
    : 'Consejero de la sala auxiliar';
  return { rol, resto: m[2].trim() };
}

function isMidweekSkipLine(t){
  const k = normalizeKey(t);
  if (MIDWEEK_SKIP_RE.test(k)) return true;
  if (/^(consejerodelasalaauxiliar|salaauxiliarauditorioprincipal|salaauxiliar|auditorioprincipal)/.test(k.replace(/\s+/g, ''))) return true;
  return /^impreso\b/i.test(t) || /^programa para la reuni/i.test(t);
}

/* El cuadrante de entre semana es una tabla densa donde la HORA (columna izquierda)
   aparece un poco por debajo del título y del nombre de su fila, y filas contiguas
   se solapan verticalmente. Por eso NO se agrupa por cercanía vertical: se anclan
   las filas en los tokens de hora y cada fila abarca una "banda" [hora.y - Δ, …).
   Dentro de la banda, la izquierda es el título y la derecha se trocea en grupos:
   cada sub-línea que empieza por un rol (Conductor, Lector…) abre un grupo nuevo. */
function parseMidweek(pages){
  const asignaciones = [];

  pages.forEach(page => {
    const width = page.width;
    const items = page.lines.reduce((acc, l) => acc.concat(l.items), []);
    if (!items.length) return;
    const splitX = detectColumnSplit(page, MIDWEEK_LABEL_TOKENS);
    const subs = clusterItemsIntoLines(items, 4.5);

    // --- clasifica sub-líneas en fronteras (fecha / sección / hora) ---
    const boundaries = []; // { y, kind, text }
    const timeYs = [];
    subs.forEach(s => {
      const t = s.text.trim();
      if (!t) return;
      if (MIDWEEK_DATE_RE.test(t)) { boundaries.push({ y: s.y, kind: 'date', text: t }); return; }
      if (MIDWEEK_SECTIONS.includes(normalizeKey(t))) { boundaries.push({ y: s.y, kind: 'section', text: t }); return; }
      const first = s.items[0];
      if (first && MIDWEEK_TIME_RE.test(first.text.trim()) && first.x < width * 0.18) {
        boundaries.push({ y: s.y, kind: 'time', text: first.text.trim() });
        timeYs.push(s.y);
      }
    });
    boundaries.sort((a, b) => a.y - b.y);

    const gaps = timeYs.slice(1).map((y, i) => y - timeYs[i]);
    const delta = Math.min(13, Math.max(6, 0.6 * (gaps.length ? median(gaps) : 20)));

    // banda de cada hora: [hora.y - Δ, siguiente frontera.y - Δ)
    const bands = [];
    boundaries.forEach((b, i) => {
      if (b.kind !== 'time') return;
      const next = boundaries[i + 1];
      bands.push({
        yTop: b.y - delta,
        yBot: next ? next.y - delta : Infinity,
        hora: b.text,
        lefts: [], rights: [],
      });
    });

    // contexto (fecha/lectura/sección) vigente a una altura dada
    const ctxAt = (y) => {
      let fecha = null, lectura = null, seccion = null;
      for (const b of boundaries) {
        if (b.y - delta > y + 0.1) break;
        if (b.kind === 'date') {
          const dm = b.text.match(MIDWEEK_DATE_RE);
          fecha = dm[1]; lectura = dm[2].trim() || null; seccion = null;
        } else if (b.kind === 'section') {
          seccion = b.text.trim();
        }
      }
      return { fecha, lectura, seccion };
    };

    subs.forEach(s => {
      const t = s.text.trim();
      if (!t || isMidweekSkipLine(t)) return;
      if (MIDWEEK_DATE_RE.test(t) || MIDWEEK_SECTIONS.includes(normalizeKey(t))) return;
      const first = s.items[0];
      if (first && MIDWEEK_TIME_RE.test(first.text.trim()) && first.x < width * 0.18 && s.items.length === 1) return;

      const band = bands.find(b => s.y >= b.yTop && s.y < b.yBot);
      if (!band) return;
      const leftItems = s.items.filter(it => it.x < splitX && !MIDWEEK_TIME_RE.test(it.text.trim()));
      const rightItems = s.items.filter(it => it.x >= splitX);
      const lt = joinItemsX(leftItems).trim();
      const rt = joinItemsX(rightItems).trim();
      if (lt) band.lefts.push({ y: s.y, text: lt });
      if (rt) band.rights.push({ y: s.y, text: rt });
    });

    bands.forEach(band => {
      const { fecha, lectura, seccion } = ctxAt(band.yTop + delta);
      if (!fecha) return;
      const leftText = band.lefts.sort((a, b) => a.y - b.y).map(x => x.text).join(' ').replace(/\s+/g, ' ').trim();
      const parte = cleanParteText(leftText);

      // Agrupa la derecha: cada sub-línea que empieza por un ROL abre grupo nuevo;
      // las demás son continuación (nombre partido). Se trocea en personas al final.
      const groups = [];
      band.rights.sort((a, b) => a.y - b.y).forEach(({ text: rt }) => {
        const r = midweekRole(rt);
        if (r) groups.push({ rol: r.rol, raw: r.resto });
        else if (groups.length) groups[groups.length - 1].raw = `${groups[groups.length - 1].raw} ${rt}`.trim();
        else groups.push({ rol: null, raw: rt });
      });
      const parsed = groups.map(g => ({ rol: g.rol, nombres: splitNames(g.raw) }));

      if (!parsed.length) {
        if (parte) asignaciones.push({ fecha, lectura, seccion, hora: band.hora, parte, rol: null, nombres: [] });
        return;
      }
      parsed.forEach(g => {
        if (!parte && !g.rol && !g.nombres.length) return;
        asignaciones.push({ fecha, lectura, seccion, hora: band.hora, parte, rol: g.rol, nombres: g.nombres });
      });
    });
  });

  return asignaciones;
}

const PUBLIC_LABEL_TOKENS = ['presidente', 'lector', 'oracion'];
const SPANISH_MONTHS = new Set([
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
  'septiembre', 'setiembre', 'octubre', 'noviembre', 'diciembre',
]);

/* Etiquetas fijas de cada mitad de la tabla. El "valor" es lo que va detrás de la
   etiqueta (misma celda) o en celdas siguientes de la misma mitad hasta la próxima
   etiqueta. Las etiquetas de la derecha se parten en dos renglones ("LECTOR DE LA"
   / "ATALAYA"): el segundo renglón se reconoce como RUIDO y se descarta. */
const PUBLIC_LEFT_LABELS = [
  { key: 'discursante',  re: /^\s*discursante\b[\s:.\-]*/i },
  { key: 'tema',         re: /^\s*tema\b[\s:.\-]*/i },
  { key: 'congregacion', re: /^\s*congregaci[oó]n\b[\s:.\-]*/i },
];
const PUBLIC_RIGHT_LABELS = [
  { key: 'presidente',        re: /^\s*presidente\b[\s:.\-]*/i },
  { key: 'lectorAtalaya',     re: /^\s*lector(?:\s+de\s+la(?:\s+atalaya)?)?\b[\s:.\-]*/i },
  { key: 'oracionConclusion', re: /^\s*oraci[oó]n(?:\s+de(?:\s+conclusi[oó]n)?)?\b[\s:.\-]*/i },
];
/* Restos del 2º renglón de una etiqueta partida ("LECTOR DE LA" / "ATALAYA",
   "ORACIÓN DE" / "CONCLUSIÓN"). Se quitan del principio de una celda de valor. */
const PUBLIC_RIGHT_NOISE_RE = /^\s*(?:atalaya|conclusi[oó]n|de\s+la\s+atalaya|de\s+conclusi[oó]n|de\s+la|de)\b[\s:.\-]*/i;

function stripPublicLabel(text, re){
  const m = String(text).match(re);
  return m ? String(text).slice(m[0].length).trim() : null;
}

/* Trocea una línea en "celdas" allí donde hay un hueco horizontal grande
   (frontera real de columna), no en cada espacio entre palabras. */
function rowCells(items, pageWidth){
  const gapMin = Math.max(10, pageWidth * 0.022);
  const sorted = items.slice().sort((a, b) => a.x - b.x);
  const cells = [];
  let cur = null;
  sorted.forEach(it => {
    if (cur && it.x - cur.end < gapMin) {
      cur.text += (/\s$/.test(cur.text) ? '' : ' ') + it.text;
      cur.end = it.x + (it.w || 0);
    } else {
      cur = { text: it.text, x: it.x, end: it.x + (it.w || 0) };
      cells.push(cur);
    }
  });
  return cells.map(c => ({ text: c.text.replace(/\s+/g, ' ').trim(), x: c.x })).filter(c => c.text);
}

/* La reunión pública es una tabla: cada fecha es un bloque con dos mitades. Se lee
   fila por fila y celda por celda; cada celda es una etiqueta (fija el campo activo
   de esa mitad) o un valor (se añade al campo activo de su mitad). Así los valores
   partidos en varias líneas ("CARLOS ALONSO DEL" / "RÍO") se recomponen bien. */
function parsePublica(pages){
  const results = [];
  let cur = null;

  function flush(){
    if (!cur) return;
    const b = cur; cur = null;
    if (/\bASAMBLEA\b/i.test(b.allText)) { results.push({ fecha: b.fecha, asamblea: true }); return; }

    const f = { fecha: b.fecha, discursante: '', tema: '', congregacion: '', presidente: '', lectorAtalaya: '', oracionConclusion: '' };
    let activeL = null, activeR = null;
    // Un valor puede aparecer ANTES que su etiqueta (2ª línea de un nombre que
    // se agrupa por encima de la fila de la etiqueta). Se guarda en espera y se
    // adjudica en cuanto se fija la etiqueta de esa mitad.
    let pendingL = '', pendingR = '';
    const addTo = (key, text) => { if (text) f[key] += (f[key] ? ' ' : '') + text; };
    b.rows.forEach(cells => {
      cells.forEach(cell => {
        const right = cell.x >= b.split;
        const labels = right ? PUBLIC_RIGHT_LABELS : PUBLIC_LEFT_LABELS;
        let isLabel = false;
        for (const lab of labels) {
          const rest = stripPublicLabel(cell.text, lab.re);
          if (rest == null) continue;
          if (right) { activeR = lab.key; if (pendingR) { addTo(lab.key, pendingR); pendingR = ''; } }
          else { activeL = lab.key; if (pendingL) { addTo(lab.key, pendingL); pendingL = ''; } }
          addTo(lab.key, rest);
          isLabel = true;
          break;
        }
        if (isLabel) return;
        let val = cell.text;
        if (right) {
          val = val.replace(PUBLIC_RIGHT_NOISE_RE, '').trim();
          if (!val) return; // era solo el resto de una etiqueta partida
        }
        const active = right ? activeR : activeL;
        if (active) addTo(active, val);
        else if (right) pendingR += (pendingR ? ' ' : '') + val;
        else pendingL += (pendingL ? ' ' : '') + val;
      });
    });
    Object.keys(f).forEach(k => { if (typeof f[k] === 'string') f[k] = f[k].replace(/\s+/g, ' ').trim(); });
    // Un bloque con fecha pero sin ningún dato = semana de asamblea / sin reunión
    // pública (el rótulo "ASAMBLEA" del PDF suele ser una imagen y no se extrae).
    if (!(f.discursante || f.tema || f.congregacion || f.presidente || f.lectorAtalaya || f.oracionConclusion)) {
      results.push({ fecha: b.fecha, asamblea: true });
      return;
    }
    results.push(f);
  }

  pages.forEach(page => {
    const split = detectColumnSplit(page, PUBLIC_LABEL_TOKENS);
    page.lines.forEach(line => {
      const t = line.text.trim();
      if (!t || /^reuni[oó]n p[uú]blica/i.test(t)) return;
      const dm = t.match(/^(\d{1,2})\s+([A-Za-zÁÉÍÓÚÜÑáéíóúüñ.]{3,})\s+(\d{4})\b/);
      if (dm && SPANISH_MONTHS.has(normalizeText(dm[2]).replace(/[^a-z]/g, ''))) {
        flush();
        cur = { fecha: `${dm[1]} ${dm[2].toUpperCase()} ${dm[3]}`, rows: [], allText: '', split };
        return;
      }
      if (!cur) return;
      cur.rows.push(rowCells(line.items, page.width));
      cur.allText += ' ' + t;
    });
  });
  flush();
  return results;
}

function parseCuadrante(pages){
  const tipo = detectTipo(pages);
  if (tipo === 'entre-semana') return { tipo, asignaciones: parseMidweek(pages) };
  if (tipo === 'publica') return { tipo, asignaciones: parsePublica(pages) };
  return { tipo, asignaciones: [] };
}

/* =========================================================
   Vista digitalizada
   ========================================================= */
function highlightName(text, name){
  const escaped = escapeHtml(text);
  if (!name) return escaped;
  try {
    const re = new RegExp(`(${name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig');
    return escaped.replace(re, '<mark>$1</mark>');
  } catch (e) { return escaped; }
}

function renderDigitalView(parsed){
  const box = $('#digitalView');
  if (!parsed || !parsed.asignaciones || parsed.asignaciones.length === 0) {
    box.innerHTML = `<p class="empty-note">${parsed && parsed.error
      ? 'No se pudo digitalizar este documento. Consulta "Documento original".'
      : parsed && parsed.tipo === 'desconocido'
        ? 'No reconocemos el formato de este documento todavía; consulta "Documento original".'
        : 'Sube un cuadrante para ver aquí la versión digitalizada.'}</p>`;
    return;
  }

  const tipo = parsed.tipo;
  const visibles = parsed.asignaciones.filter(a => !isHiddenKey(keyOf(a, tipo)));
  if (visibles.length === 0) {
    box.innerHTML = `<p class="empty-note">Has ocultado todas las asignaciones de este cuadrante.
      Usa «Volver a mostrar todas» en la pestaña Cuadrante para recuperarlas.</p>`;
    return;
  }

  if (tipo === 'entre-semana') {
    const porFecha = [];
    visibles.forEach(a => {
      let grupo = porFecha.find(g => g.fecha === a.fecha);
      if (!grupo) { grupo = { fecha: a.fecha, lectura: a.lectura, filas: [] }; porFecha.push(grupo); }
      grupo.filas.push(a);
    });
    box.innerHTML = porFecha.map(g => `
      <div class="digital-week">
        <h3>${escapeHtml(g.fecha)}${g.lectura ? ` · ${escapeHtml(g.lectura)}` : ''}</h3>
        ${renderMidweekRows(g.filas, tipo)}
      </div>`).join('');
  } else if (tipo === 'publica') {
    box.innerHTML = visibles.map(a => {
      const k = keyOf(a, tipo);
      if (a.asamblea) {
        return `<div class="digital-week"><h3>${escapeHtml(a.fecha)}${delBtn(k)}</h3>
          <p class="empty-note">Asamblea — sin reunión pública.</p></div>`;
      }
      return `
        <div class="digital-week">
          <h3>${escapeHtml(a.fecha)}${delBtn(k)}</h3>
          <div class="digital-row"><span class="dr-parte">Discurso</span><span class="dr-nombre">${escapeHtml(a.discursante || '')}</span></div>
          ${a.tema ? `<div class="digital-row"><span class="dr-parte">Tema</span><span class="dr-nombre">${escapeHtml(a.tema)}</span></div>` : ''}
          ${a.congregacion ? `<div class="digital-row"><span class="dr-parte">Congregación</span><span class="dr-nombre">${escapeHtml(a.congregacion)}</span></div>` : ''}
          <div class="digital-row"><span class="dr-parte">Presidente</span><span class="dr-nombre">${escapeHtml(a.presidente || '')}</span></div>
          <div class="digital-row"><span class="dr-parte">Lector de La Atalaya</span><span class="dr-nombre">${escapeHtml(a.lectorAtalaya || '')}</span></div>
          <div class="digital-row"><span class="dr-parte">Oración de conclusión</span><span class="dr-nombre">${escapeHtml(a.oracionConclusion || '')}</span></div>
        </div>`;
    }).join('');
  } else {
    box.innerHTML = '';
    return;
  }

  box.querySelectorAll('.dv-del').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    hideAssignment(b.dataset.hk);
  }));
}

function delBtn(key){
  return `<button class="dv-del" title="Ocultar esta asignación" data-hk="${escapeAttr(key)}">✕</button>`;
}

const SECTION_STYLE = {
  'tesoros de la biblia': { color: '#2F6F62', bg: '#EAF2EF' },
  'seamos mejores maestros': { color: '#9B7623', bg: '#FBF3DC' },
  'nuestra vida cristiana': { color: '#B4432D', bg: '#FBEAE5' },
  'vivamos como cristianos': { color: '#B4432D', bg: '#FBEAE5' },
};

function renderMidweekRows(filas, tipo){
  let html = '';
  let lastSeccion; // undefined ≠ null: fuerza a pintar el primer grupo, incluso si es "sin sección"
  filas.forEach(f => {
    if (f.seccion !== lastSeccion) {
      lastSeccion = f.seccion;
      if (f.seccion) {
        const style = SECTION_STYLE[normalizeKey(f.seccion)] || { color: 'var(--ink-soft)', bg: 'var(--paper)' };
        html += `<div class="dv-section" style="color:${style.color}; background:${style.bg}; border-color:${style.color}">${escapeHtml(f.seccion)}</div>`;
      }
    }
    html += `
      <div class="digital-row">
        <span class="dr-hora">${f.hora ? escapeHtml(f.hora) : ''}</span>
        <span class="dr-parte"><span class="dr-cat">${escapeHtml(categorizeMidweekRow(f))}</span>${escapeHtml(f.parte || '')}</span>
        <span class="dr-nombre">${f.rol ? `<em>${escapeHtml(f.rol)}</em>` : ''}${escapeHtml((f.nombres || []).join(' / '))}</span>
        ${delBtn(keyOf(f, tipo))}
      </div>`;
  });
  return html;
}

/* Traduce cada asignación a la categoría fija del programa a la que pertenece
   (Oración, Presidencia, Tesoros de la Biblia, Perlas escondidas, Asignación estudiantil,
   Nuestra Vida Cristiana, Estudio bíblico...) en vez de depender del título variable. */
function categorizeMidweekRow(a){
  if (a.rol) {
    if (/oraci/i.test(a.rol)) return a.seccion ? 'Oración final' : 'Oración inicial';
    if (/presidente/i.test(a.rol)) return 'Presidencia';
    if (/conductor/i.test(a.rol)) return 'Conductor del estudio';
    if (/lector/i.test(a.rol)) return 'Lector del estudio';
    return a.rol;
  }
  const parte = a.parte || '';
  if (/^canci[oó]n\b/i.test(parte)) return 'Canción';
  if (/palabras de introducci/i.test(parte)) return 'Palabras de introducción';
  if (/palabras de conclusi/i.test(parte)) return 'Palabras de conclusión';
  if (/necesidades de la congregaci/i.test(parte)) return 'Necesidades de la congregación';

  const seccionKey = a.seccion ? normalizeKey(a.seccion) : null;
  if (seccionKey === 'tesoros de la biblia') {
    if (/lectura de la biblia/i.test(parte)) return 'Lectura de la Biblia';
    if (/perlas escondidas/i.test(parte)) return 'Perlas escondidas';
    return 'Tesoros de la Biblia';
  }
  if (seccionKey === 'seamos mejores maestros') return 'Asignación estudiantil';
  if (seccionKey === 'nuestra vida cristiana' || seccionKey === 'vivamos como cristianos') {
    if (/estudio b[ií]blico/i.test(parte)) return 'Estudio bíblico';
    return 'Nuestra Vida Cristiana';
  }
  return parte || 'Asignación';
}

/* ---------- Localizar mi nombre en el historial registrado (no depende del documento actual) ---------- */
const nameInput = $('#myNameInput');
nameInput.value = localStorage.getItem('hg_myname') || '';
nameInput.addEventListener('change', async () => {
  localStorage.setItem('hg_myname', nameInput.value.trim());
  renderNameMatches();
  await syncMyAssignmentsToCalendar();
  renderDashboard();
});

function findMyAssignments(historial, name){
  if (!historial || !name) return [];
  const target = normalizeText(name);
  const out = [];

  historial.forEach(a => {
    const k = assignmentKey(a);
    if (hiddenKeys.has(k)) return;
    if (a.tipo === 'entre-semana') {
      const nombres = a.nombres || [];
      if (nombres.some(n => normalizeText(n).includes(target))) {
        out.push({ _key: k, fecha: a.fecha, hora: a.hora || '', categoria: categorizeMidweekRow(a), nombreTexto: nombres.join(' / ') });
      }
    } else if (a.tipo === 'publica') {
      if (a.asamblea) return;
      const campos = [
        ['discursante', 'Discurso público'], ['presidente', 'Presidencia'],
        ['lectorAtalaya', 'Lectura de La Atalaya'], ['oracionConclusion', 'Oración de conclusión'],
      ];
      campos.forEach(([key, label]) => {
        if (a[key] && normalizeText(a[key]).includes(target)) {
          out.push({ _key: k, fecha: a.fecha, hora: '', categoria: label, nombreTexto: a[key] });
        }
      });
    }
  });
  return out;
}

function renderNameMatches(){
  const box = $('#nameMatches');
  const name = nameInput.value.trim();

  if (!currentHistorial || currentHistorial.length === 0) { box.innerHTML = ''; return; }
  if (!name) { box.innerHTML = '<p class="nm-status">Añade tu nombre arriba para ver aquí tus asignaciones registradas, aunque cambies de cuadrante.</p>'; return; }

  const matches = findMyAssignments(currentHistorial, name);
  if (matches.length === 0) {
    box.innerHTML = `<p class="nm-status">No hay asignaciones registradas para "${escapeHtml(name)}" todavía.</p>`;
    return;
  }
  box.innerHTML = `
    <p class="nm-status">Esto es lo que tienes (se añade solo al calendario):</p>
    <ul class="nm-cards">${matches.map(m => `
      <li>
        <div class="nm-top">
          <span class="nm-fecha">${escapeHtml(m.categoria)}</span>
          <span class="nm-pagesmall">${escapeHtml(m.fecha)}${m.hora ? ' · ' + escapeHtml(m.hora) : ''}</span>
        </div>
        <div class="nm-detalle">${highlightName(m.nombreTexto, name)}</div>
        <button class="dv-del" title="Ocultar (también se quita del calendario)" data-hk="${escapeAttr(m._key)}">✕</button>
      </li>`).join('')}</ul>`;
  box.querySelectorAll('.dv-del').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    hideAssignment(b.dataset.hk);
  }));
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

/* ---------- Volcado automático de "mis asignaciones" al calendario ---------- */
const MONTHS_ES = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

/* Convierte la fecha de una asignación a ISO (YYYY-MM-DD).
   Entre semana: "2026/10/14"   ·   Pública: "06 SEPTIEMBRE 2026" */
function assignmentDateISO(fecha){
  if (!fecha) return null;
  let m = String(fecha).match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = String(fecha).match(/^(\d{1,2})\s+([A-Za-zÁÉÍÓÚÜÑáéíóúüñ.]+)\s+(\d{4})$/);
  if (m) {
    const mon = MONTHS_ES[normalizeText(m[2]).replace(/[^a-z]/g, '')];
    if (mon) return `${m[3]}-${String(mon).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

function hashStr(s){
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

let autoSyncBusy = false;
/* Regenera los eventos `auto:true` a partir de las asignaciones que coinciden con
   "Mi nombre" y no están ocultas. Es un espejo: para quitar uno permanentemente,
   se oculta la asignación (✕) en Cuadrante / Programa. */
async function syncMyAssignmentsToCalendar(){
  if (autoSyncBusy || !folderId) return;
  const name = (nameInput.value || '').trim();

  const prevAuto = JSON.stringify(events.filter(e => e.auto).map(e => e.id).sort());
  const manuales = events.filter(e => !e.auto);
  const autos = [];

  if (name) {
    findMyAssignments(currentHistorial, name).forEach(m => {
      const date = assignmentDateISO(m.fecha);
      if (!date) return;
      const id = 'auto_' + hashStr(`${m._key}|${m.categoria}|${date}`);
      if (autos.some(e => e.id === id)) return;
      const time = /^\d{1,2}:\d{2}$/.test(m.hora || '') ? m.hora.replace(/^(\d):/, '0$1:') : '';
      autos.push({
        id, auto: true, srcKey: m._key,
        title: m.categoria,
        date, time,
        notes: m.nombreTexto || '',
        remind: false,
      });
    });
  }

  events = manuales.concat(autos);
  const nextAuto = JSON.stringify(autos.map(e => e.id).sort());
  if (prevAuto !== nextAuto) {
    autoSyncBusy = true;
    try { await persistEvents(); }
    catch (e) { console.error(e); }
    finally { autoSyncBusy = false; }
  }
  renderCalendar();
  renderUpcoming();
}

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
    renderDashboard();
    return;
  }
  upcoming.forEach(ev => {
    const li = document.createElement('li');
    if (ev.auto) li.className = 'ev-auto';
    const d = new Date(`${ev.date}T${ev.time || '00:00'}`);
    const dateLabel = d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' }) + (ev.time ? ` · ${ev.time}` : '');
    li.innerHTML = `
      <span class="ev-date">${dateLabel}</span>
      <span class="ev-title">${ev.auto ? '📋 ' : ''}${escapeHtml(ev.title)}${ev.auto && ev.notes ? ` <em>· ${escapeHtml(ev.notes)}</em>` : ''}</span>
      <span class="ev-actions">
        <button class="icon-btn" title="Descargar .ics" data-ics="${ev.id}">⇩</button>
        ${ev.auto ? '' : `<button class="icon-btn" title="Editar" data-edit="${ev.id}">✎</button>`}
        <button class="icon-btn" title="${ev.auto ? 'Ocultar esta asignación' : 'Eliminar'}" data-del="${ev.id}">✕</button>
      </span>`;
    list.appendChild(li);
  });

  list.querySelectorAll('[data-ics]').forEach(b => b.addEventListener('click', () => downloadIcs(b.dataset.ics)));
  list.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openEventModal(b.dataset.edit)));
  list.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => deleteEvent(b.dataset.del)));
  renderDashboard();
}

function openDayModal(dateStr){
  const dayEvents = eventsOn(dateStr);
  const niceDate = new Date(`${dateStr}T00:00`).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  const rows = dayEvents.map(ev => `
    <div class="parte-row">
      <span>${ev.time ? ev.time + ' · ' : ''}${ev.auto ? '📋 ' : ''}${escapeHtml(ev.title)}</span>
      <span class="ev-actions">
        ${ev.auto ? '' : `<button class="icon-btn" data-edit="${ev.id}">✎</button>`}
        <button class="icon-btn" title="${ev.auto ? 'Ocultar asignación' : 'Eliminar'}" data-del="${ev.id}">✕</button>
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
    if (!title || !date) { showError('Falta título o fecha.'); return; }
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
  const ev = events.find(e => e.id === id);
  if (ev && ev.auto) { await hideAssignment(ev.srcKey); return; } // auto = espejo de una asignación
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
    renderDashboard();
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
  renderDashboard();
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
    if (!titulo) { showError('Falta el título.'); return; }
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
   Ministerio — registro de horas de predicación
   ========================================================= */
async function loadMinisterio(){
  const f = await findFile(CONFIG.MINISTERIO_NAME, folderId, 'application/json');
  if (!f) { ministerio = []; return; }
  try { ministerio = (await (await downloadFile(f.id)).json()) || []; }
  catch (e) { ministerio = []; }
}
async function persistMinisterio(){
  await saveFile(CONFIG.MINISTERIO_NAME, 'application/json', JSON.stringify(ministerio, null, 2), folderId);
}

function fmtDur(min){
  min = Math.max(0, Math.round(min || 0));
  const h = Math.floor(min / 60), m = min % 60;
  if (h && m) return `${h} h ${m} min`;
  if (h) return `${h} h`;
  return `${m} min`;
}
/* Año de servicio: 1 sep – 31 ago */
function serviceYearStart(ref){
  const d = ref ? new Date(ref) : new Date();
  const y = d.getMonth() >= 8 ? d.getFullYear() : d.getFullYear() - 1;
  return new Date(y, 8, 1);
}
function ministerioTotals(){
  const now = new Date();
  const mesKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const syStart = serviceYearStart(now);
  let mes = 0, mesN = 0, sy = 0;
  ministerio.forEach(s => {
    const min = Number(s.minutes) || 0;
    if ((s.date || '').slice(0, 7) === mesKey) { mes += min; mesN++; }
    if (s.date && new Date(s.date + 'T00:00') >= syStart) sy += min;
  });
  return { mes, mesN, sy };
}

function renderMinisterio(){
  const stats = document.getElementById('ministerioStats');
  const list = document.getElementById('ministerioList');
  if (!stats || !list) return;
  const t = ministerioTotals();
  stats.innerHTML = `
    <div class="min-stat"><span class="ms-num">${fmtDur(t.mes)}</span><span class="ms-lbl">Este mes · ${t.mesN} salida${t.mesN === 1 ? '' : 's'}</span></div>
    <div class="min-stat"><span class="ms-num">${fmtDur(t.sy)}</span><span class="ms-lbl">Año de servicio</span></div>`;

  if (!ministerio.length) {
    list.innerHTML = '<p class="empty-note">Aún no has registrado ninguna salida. Usa «+ Añadir salida».</p>';
    renderDashboard();
    return;
  }
  const byMonth = [];
  ministerio.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '')).forEach(s => {
    const k = (s.date || '').slice(0, 7);
    let g = byMonth.find(x => x.k === k);
    if (!g) { g = { k, total: 0, items: [] }; byMonth.push(g); }
    g.total += Number(s.minutes) || 0;
    g.items.push(s);
  });
  list.innerHTML = byMonth.map(g => {
    const [y, m] = g.k.split('-');
    const title = new Date(+y, (+m || 1) - 1, 1).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
    return `<div class="min-month">
      <div class="mm-head"><span style="text-transform:capitalize">${escapeHtml(title)}</span><span>${fmtDur(g.total)}</span></div>
      ${g.items.map(s => `
        <div class="parte-row">
          <span>${escapeHtml(new Date((s.date || '') + 'T00:00').toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' }))}
            · <strong>${fmtDur(s.minutes)}</strong>${s.note ? ' · ' + escapeHtml(s.note) : ''}</span>
          <span class="ev-actions">
            <button class="icon-btn" data-edit-m="${escapeAttr(s.id)}">✎</button>
            <button class="icon-btn" data-del-m="${escapeAttr(s.id)}">✕</button>
          </span>
        </div>`).join('')}
    </div>`;
  }).join('');
  list.querySelectorAll('[data-edit-m]').forEach(b => b.addEventListener('click', () => openMinisterioModal(b.dataset.editM)));
  list.querySelectorAll('[data-del-m]').forEach(b => b.addEventListener('click', () => deleteMinisterioSesion(b.dataset.delM)));
  renderDashboard();
}

document.getElementById('addMinisterioBtn').addEventListener('click', () => openMinisterioModal());

function openMinisterioModal(id){
  const s = id ? ministerio.find(x => x.id === id) : null;
  const h = s ? Math.floor((s.minutes || 0) / 60) : '';
  const mm = s ? (s.minutes || 0) % 60 : '';
  renderModal(`
    <h3>${s ? 'Editar salida' : 'Añadir salida'}</h3>
    <div class="field"><label>Fecha</label><input id="mDate" type="date" value="${s ? s.date : new Date().toISOString().slice(0, 10)}"></div>
    <div class="field" style="flex-direction:row; gap:10px;">
      <div style="flex:1; display:flex; flex-direction:column; gap:5px;"><label>Horas</label><input id="mH" type="number" min="0" max="24" value="${h}"></div>
      <div style="flex:1; display:flex; flex-direction:column; gap:5px;"><label>Minutos</label><input id="mM" type="number" min="0" max="59" value="${mm}"></div>
    </div>
    <div class="field"><label>Nota (opcional)</label><input id="mNote" value="${s ? escapeAttr(s.note || '') : ''}" placeholder="territorio, con quién…"></div>
    <div class="modal-actions">
      ${s ? '<button class="btn btn-ghost" id="modalDelete" style="color:#B4432D;">Eliminar</button>' : ''}
      <button class="btn btn-ghost" id="modalCancel">Cancelar</button>
      <button class="btn btn-primary" id="modalSave">Guardar</button>
    </div>`);
  $('#modalCancel').addEventListener('click', closeModal);
  if (s) $('#modalDelete').addEventListener('click', () => { deleteMinisterioSesion(s.id); closeModal(); });
  $('#modalSave').addEventListener('click', async () => {
    const date = $('#mDate').value;
    const minutes = (parseInt($('#mH').value, 10) || 0) * 60 + (parseInt($('#mM').value, 10) || 0);
    if (!date || minutes <= 0) { showError('Indica la fecha y una duración mayor que cero.'); return; }
    const data = { id: s ? s.id : 'm_' + Date.now(), date, minutes, note: $('#mNote').value.trim() };
    if (s) Object.assign(s, data); else ministerio.push(data);
    closeModal();
    showSand('Guardando en Drive…');
    try { await persistMinisterio(); renderMinisterio(); } finally { hideSand(); }
  });
}

async function deleteMinisterioSesion(id){
  ministerio = ministerio.filter(s => s.id !== id);
  showSand('Guardando en Drive…');
  try { await persistMinisterio(); renderMinisterio(); } finally { hideSand(); }
}

/* =========================================================
   Tareas — lista de tareas (proyectos, etiquetas y subtareas)
   ========================================================= */
async function loadTareas(){
  const f = await findFile(CONFIG.TAREAS_NAME, folderId, 'application/json');
  if (!f) { tareas = []; return; }
  try { tareas = (await (await downloadFile(f.id)).json()) || []; }
  catch (e) { tareas = []; }
}
async function persistTareas(){
  await saveFile(CONFIG.TAREAS_NAME, 'application/json', JSON.stringify(tareas, null, 2), folderId);
}

const PRIO = { 1: { lbl: 'Alta', cls: 'p1' }, 2: { lbl: 'Media', cls: 'p2' }, 3: { lbl: 'Baja', cls: 'p3' } };
const uid = (p) => p + Math.random().toString(36).slice(2, 8);

function tareaProjects(){
  return [...new Set(tareas.map(t => (t.project || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
function tareaLabels(){
  const s = new Set();
  tareas.forEach(t => (t.labels || []).forEach(l => { if (l) s.add(l); }));
  return [...s].sort((a, b) => a.localeCompare(b));
}
function tareaMatchesFilter(t){
  if (tareasFilter.project && (t.project || '') !== tareasFilter.project) return false;
  if (tareasFilter.label && !(t.labels || []).includes(tareasFilter.label)) return false;
  return true;
}
function tareasForView(){
  const today = todayISO();
  const in7 = new Date(); in7.setDate(in7.getDate() + 7);
  const in7ISO = in7.toISOString().slice(0, 10);
  let list = tareas.filter(tareaMatchesFilter);
  if (tareasView === 'hechas') {
    return list.filter(t => t.done).sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || ''));
  }
  list = list.filter(t => !t.done);
  if (tareasView === 'hoy') list = list.filter(t => t.due && t.due <= today);
  else if (tareasView === 'proximo') list = list.filter(t => t.due && t.due > today && t.due <= in7ISO);
  return list.sort((a, b) => {
    const ka = a.due ? a.due + (a.time || '99:99') : '9999';
    const kb = b.due ? b.due + (b.time || '99:99') : '9999';
    if (ka !== kb) return ka < kb ? -1 : 1;
    return (a.priority || 3) - (b.priority || 3);
  });
}
function tareasHoyPend(){
  const today = todayISO();
  return tareas.filter(t => !t.done && t.due && t.due <= today)
    .sort((a, b) => (a.due + (a.time || '')).localeCompare(b.due + (b.time || '')));
}

function dueBadge(t){
  if (!t.due) return '';
  const today = todayISO();
  const cls = t.due < today ? 'due-over' : t.due === today ? 'due-today' : 'due-fut';
  const txt = t.due === today ? 'Hoy'
    : new Date(t.due + 'T00:00').toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
  return `<span class="tk-due ${cls}">${escapeHtml(txt)}${t.time ? ' ' + escapeHtml(t.time) : ''}</span>`;
}

function renderTareasFiltros(){
  const box = document.getElementById('tareasFiltros');
  if (!box) return;
  const projs = tareaProjects(), labs = tareaLabels();
  if (!projs.length && !labs.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  const chip = (txt, active, kind, val) =>
    `<button class="tk-chip${active ? ' active' : ''}" data-kind="${kind}" data-val="${escapeAttr(val)}">${escapeHtml(txt)}</button>`;
  box.innerHTML =
    (projs.length ? `<div class="tk-chiprow">${chip('Todos', !tareasFilter.project, 'project', '')}${projs.map(p => chip('# ' + p, tareasFilter.project === p, 'project', p)).join('')}</div>` : '') +
    (labs.length ? `<div class="tk-chiprow">${chip('Todas', !tareasFilter.label, 'label', '')}${labs.map(l => chip('@ ' + l, tareasFilter.label === l, 'label', l)).join('')}</div>` : '');
  box.querySelectorAll('.tk-chip').forEach(b => b.addEventListener('click', () => {
    tareasFilter[b.dataset.kind] = b.dataset.val;
    renderTareas();
  }));
}

function renderTareas(){
  const list = document.getElementById('tareasList');
  if (!list) return;
  renderTareasFiltros();
  document.querySelectorAll('#tareasNav .tk-vbtn').forEach(b => b.classList.toggle('active', b.dataset.view === tareasView));

  const rows = tareasForView();
  if (!rows.length) {
    list.innerHTML = `<p class="empty-note">${
      tareasView === 'hoy' ? 'Nada para hoy. 🎉'
      : tareasView === 'proximo' ? 'Nada en los próximos 7 días.'
      : tareasView === 'hechas' ? 'Aún no has completado ninguna tarea.'
      : 'No hay tareas. Crea una con «+ Nueva tarea».'}</p>`;
    renderDashboard();
    return;
  }
  list.innerHTML = rows.map(t => {
    const p = PRIO[t.priority] || PRIO[3];
    const subs = t.subtasks || [];
    const subDone = subs.filter(s => s.done).length;
    return `<div class="tk-item${t.done ? ' done' : ''}">
      <button class="tk-check" data-toggle="${escapeAttr(t.id)}" aria-label="Marcar hecha">${t.done ? '✔' : ''}</button>
      <div class="tk-body">
        <div class="tk-line1">
          <span class="tk-prio ${p.cls}" title="Prioridad ${p.lbl}"></span>
          <span class="tk-title">${escapeHtml(t.title)}</span>
        </div>
        <div class="tk-meta">
          ${dueBadge(t)}
          ${t.project ? `<span class="tk-tag">#${escapeHtml(t.project)}</span>` : ''}
          ${(t.labels || []).map(l => `<span class="tk-tag tk-lab">@${escapeHtml(l)}</span>`).join('')}
          ${subs.length ? `<span class="tk-sub-count">${subDone}/${subs.length}</span>` : ''}
        </div>
        ${subs.length ? `<div class="tk-subs">${subs.map(s => `
          <label class="tk-subrow${s.done ? ' done' : ''}"><input type="checkbox" data-sub="${escapeAttr(t.id)}|${escapeAttr(s.id)}" ${s.done ? 'checked' : ''}><span>${escapeHtml(s.title)}</span></label>`).join('')}</div>` : ''}
        ${t.notes ? `<div class="tk-notes">${escapeHtml(t.notes)}</div>` : ''}
      </div>
      <span class="ev-actions">
        <button class="icon-btn" data-edit-t="${escapeAttr(t.id)}">✎</button>
        <button class="icon-btn" data-del-t="${escapeAttr(t.id)}">✕</button>
      </span>
    </div>`;
  }).join('');

  list.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', () => toggleTarea(b.dataset.toggle)));
  list.querySelectorAll('[data-sub]').forEach(c => c.addEventListener('change', () => toggleSubtarea(c.dataset.sub)));
  list.querySelectorAll('[data-edit-t]').forEach(b => b.addEventListener('click', () => openTareaModal(b.dataset.editT)));
  list.querySelectorAll('[data-del-t]').forEach(b => b.addEventListener('click', () => deleteTarea(b.dataset.delT)));
  renderDashboard();
}

document.querySelectorAll('#tareasNav .tk-vbtn').forEach(b =>
  b.addEventListener('click', () => { tareasView = b.dataset.view; renderTareas(); }));
document.getElementById('addTareaBtn').addEventListener('click', () => openTareaModal());

async function toggleTarea(id){
  const t = tareas.find(x => x.id === id);
  if (!t) return;
  t.done = !t.done;
  t.doneAt = t.done ? new Date().toISOString() : null;
  showSand('Guardando…');
  try { await persistTareas(); renderTareas(); } finally { hideSand(); }
}
async function toggleSubtarea(pair){
  const [tid, sid] = pair.split('|');
  const t = tareas.find(x => x.id === tid);
  const s = t && (t.subtasks || []).find(x => x.id === sid);
  if (!s) return;
  s.done = !s.done;
  showSand('Guardando…');
  try { await persistTareas(); renderTareas(); } finally { hideSand(); }
}
async function deleteTarea(id){
  tareas = tareas.filter(t => t.id !== id);
  showSand('Guardando…');
  try { await persistTareas(); renderTareas(); } finally { hideSand(); }
}

function openTareaModal(id){
  const t = id ? tareas.find(x => x.id === id) : null;
  let subs = t ? (t.subtasks || []).map(s => ({ ...s })) : [];
  const subsHtml = () => subs.map((s, i) => `
    <div class="parte-input-row" data-i="${i}">
      <input class="st-title" value="${escapeAttr(s.title)}" placeholder="Subtarea">
      <button class="icon-btn" data-rm-st="${i}">✕</button>
    </div>`).join('');
  const readSubs = () => $$('#stWrap .st-title').map((inp, i) => ({
    id: (subs[i] && subs[i].id) || uid('s_'), title: inp.value, done: subs[i] ? !!subs[i].done : false,
  }));

  renderModal(`
    <h3>${t ? 'Editar tarea' : 'Nueva tarea'}</h3>
    <div class="field"><label>Título</label><input id="tTitle" value="${t ? escapeAttr(t.title) : ''}" placeholder="Llamar a…"></div>
    <div class="field" style="flex-direction:row; gap:10px;">
      <div style="flex:1; display:flex; flex-direction:column; gap:5px;"><label>Fecha</label><input id="tDue" type="date" value="${t ? t.due || '' : ''}"></div>
      <div style="flex:1; display:flex; flex-direction:column; gap:5px;"><label>Hora</label><input id="tTime" type="time" value="${t ? t.time || '' : ''}"></div>
    </div>
    <div class="field"><label>Prioridad</label>
      <select id="tPrio">
        <option value="1"${t && t.priority == 1 ? ' selected' : ''}>Alta</option>
        <option value="2"${!t || t.priority == 2 ? ' selected' : ''}>Media</option>
        <option value="3"${t && t.priority == 3 ? ' selected' : ''}>Baja</option>
      </select>
    </div>
    <div class="field"><label>Proyecto / lista</label>
      <input id="tProj" list="tProjList" value="${t ? escapeAttr(t.project || '') : ''}" placeholder="p. ej. Congregación">
      <datalist id="tProjList">${tareaProjects().map(p => `<option value="${escapeAttr(p)}"></option>`).join('')}</datalist>
    </div>
    <div class="field"><label>Etiquetas (separadas por comas)</label>
      <input id="tLabels" value="${t ? escapeAttr((t.labels || []).join(', ')) : ''}" placeholder="urgente, ministerio"></div>
    <div class="field"><label>Subtareas</label><div id="stWrap">${subsHtml()}</div>
      <button class="btn btn-ghost" id="addStBtn" style="align-self:flex-start;">+ Añadir subtarea</button></div>
    <div class="field"><label>Notas</label><textarea id="tNotes">${t ? escapeHtml(t.notes || '') : ''}</textarea></div>
    <div class="modal-actions">
      ${t ? '<button class="btn btn-ghost" id="modalDelete" style="color:#B4432D;">Eliminar</button>' : ''}
      <button class="btn btn-ghost" id="modalCancel">Cancelar</button>
      <button class="btn btn-primary" id="modalSave">Guardar</button>
    </div>`);

  function bindSt(){
    $$('#stWrap [data-rm-st]').forEach(b => b.addEventListener('click', () => {
      subs = readSubs();
      subs.splice(Number(b.dataset.rmSt), 1);
      $('#stWrap').innerHTML = subsHtml(); bindSt();
    }));
  }
  bindSt();
  $('#addStBtn').addEventListener('click', () => {
    subs = readSubs();
    subs.push({ id: uid('s_'), title: '', done: false });
    $('#stWrap').innerHTML = subsHtml(); bindSt();
  });
  $('#modalCancel').addEventListener('click', closeModal);
  if (t) $('#modalDelete').addEventListener('click', () => { deleteTarea(t.id); closeModal(); });
  $('#modalSave').addEventListener('click', async () => {
    const title = $('#tTitle').value.trim();
    if (!title) { showError('La tarea necesita un título.'); return; }
    const subtasks = readSubs().filter(s => s.title.trim()).map(s => ({ ...s, title: s.title.trim() }));
    const labels = $('#tLabels').value.split(',').map(s => s.trim()).filter(Boolean);
    const data = {
      id: t ? t.id : uid('t_'),
      title,
      done: t ? !!t.done : false,
      doneAt: t ? t.doneAt || null : null,
      due: $('#tDue').value || '',
      time: $('#tTime').value || '',
      priority: parseInt($('#tPrio').value, 10) || 2,
      project: $('#tProj').value.trim(),
      labels,
      notes: $('#tNotes').value.trim(),
      subtasks,
      createdAt: t ? t.createdAt || new Date().toISOString() : new Date().toISOString(),
    };
    if (t) Object.assign(t, data); else tareas.push(data);
    closeModal();
    showSand('Guardando en Drive…');
    try { await persistTareas(); renderTareas(); } finally { hideSand(); }
  });
}

/* =========================================================
   Dashboard (pestaña Inicio)
   ========================================================= */
function todayISO(){ return new Date().toISOString().slice(0, 10); }

/* Reuniones deducidas de las fechas de los cuadrantes ya registrados. */
function deriveMeetings(){
  const seen = new Set(), out = [];
  (currentHistorial || []).forEach(a => {
    const iso = assignmentDateISO(a.fecha);
    if (!iso) return;
    const kind = a.tipo === 'publica' ? 'fs' : 'es';
    if (seen.has(iso + kind)) return;
    seen.add(iso + kind);
    out.push({ iso, kind, label: kind === 'fs' ? 'Reunión pública' : 'Reunión de entre semana' });
  });
  return out;
}

function renderDashboard(){
  const box = document.getElementById('dashboard');
  if (!box) return;
  const today = todayISO();
  const name = (nameInput.value || '').trim();

  const meetings = deriveMeetings()
    .concat(events.filter(e => !e.auto).map(e => ({ iso: e.date, kind: 'ev', label: e.title, time: e.time })))
    .filter(m => m.iso && m.iso >= today)
    .sort((a, b) => (a.iso + (a.time || '')).localeCompare(b.iso + (b.time || '')))
    .slice(0, 6);

  const mine = findMyAssignments(currentHistorial, name)
    .map(m => ({ ...m, iso: assignmentDateISO(m.fecha) }))
    .filter(m => m.iso && m.iso >= today)
    .sort((a, b) => a.iso.localeCompare(b.iso))
    .slice(0, 6);

  const t = ministerioTotals();
  const proxProyecto = proyectos.slice()
    .filter(p => p.fecha && p.fecha >= today)
    .sort((a, b) => a.fecha.localeCompare(b.fecha))[0];
  const tHoy = tareasHoyPend().slice(0, 6);

  const fD = (iso, opts) => escapeHtml(new Date(iso + 'T00:00').toLocaleDateString('es-ES', opts));
  const card = (title, body, tab) => `
    <div class="dash-card"${tab ? ` data-goto="${tab}"` : ''}>
      <h3>${title}</h3>${body}
    </div>`;

  box.innerHTML =
    card('Tareas de hoy',
      tHoy.length
        ? `<ul class="dash-lines">${tHoy.map(x => `<li>
            <span class="dl-date">${x.due < today ? '⚠ ' : ''}${x.time ? escapeHtml(x.time) : 'hoy'}</span>
            <span class="dl-main">${escapeHtml(x.title)}</span></li>`).join('')}</ul>`
        : '<p class="empty-note">Sin tareas pendientes para hoy.</p>',
      'tareas') +

    card('Mis próximas responsabilidades',
      mine.length
        ? `<ul class="dash-lines">${mine.map(m => `<li>
            <span class="dl-date">${fD(m.iso, { day: '2-digit', month: 'short' })}${m.hora ? ' · ' + escapeHtml(m.hora) : ''}</span>
            <span class="dl-main">${escapeHtml(m.categoria)}</span></li>`).join('')}</ul>`
        : `<p class="empty-note">${name ? 'Sin asignaciones futuras registradas.' : 'Escribe tu nombre en la pestaña Cuadrante para verlas aquí.'}</p>`,
      'cuadrante') +

    card('Próximas reuniones',
      meetings.length
        ? `<ul class="dash-lines">${meetings.map(m => `<li>
            <span class="dl-date">${fD(m.iso, { weekday: 'short', day: '2-digit', month: 'short' })}${m.time ? ' · ' + escapeHtml(m.time) : ''}</span>
            <span class="dl-main">${escapeHtml(m.label)}</span></li>`).join('')}</ul>`
        : '<p class="empty-note">Sube un cuadrante o añade eventos para ver aquí las reuniones.</p>',
      'calendario') +

    card('Ministerio este mes',
      `<p class="dash-big">${fmtDur(t.mes)}</p>
       <p class="empty-note">${t.mesN} salida${t.mesN === 1 ? '' : 's'} · Año de servicio: ${fmtDur(t.sy)}</p>`,
      'ministerio') +

    card('Proyectos',
      proxProyecto
        ? `<p class="dash-big">${escapeHtml(proxProyecto.titulo)}</p>
           <p class="empty-note">${fD(proxProyecto.fecha, { day: 'numeric', month: 'long' })} · ${proyectos.length} en total</p>`
        : `<p class="empty-note">${proyectos.length ? proyectos.length + ' proyecto(s), ninguno con fecha futura.' : 'Sin proyectos.'}</p>`,
      'proyectos') +

    card('Guardado',
      `<p class="empty-note">${cuadrantesIdx.length} cuadrante${cuadrantesIdx.length === 1 ? '' : 's'} guardado${cuadrantesIdx.length === 1 ? '' : 's'} ·
        ${(currentHistorial || []).length} asignaciones registradas</p>`,
      'programa');

  box.querySelectorAll('[data-goto]').forEach(el => el.addEventListener('click', () => activateTab(el.dataset.goto)));
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
