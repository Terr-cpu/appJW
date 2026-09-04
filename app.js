/* =========================================================
   Hourglass Panel — configuración
   ========================================================= */
const CONFIG = {
  // Sustituye por tu Client ID de Google Cloud Console (OAuth 2.0 → Web application)
  CLIENT_ID: '989709837307-449de0hk767r7lplvjfc4ilfb6smnpfd.apps.googleusercontent.com',
  // drive: guardar cuadrantes en tus carpetas + explorador de archivos.
  // calendar: crear el calendario "Agenda JW" y sincronizar eventos/avisos.
  SCOPES: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/calendar',
  FOLDER_NAME: 'Agenda JW',
  FOLDER_NAME_LEGACY: 'Hourglass Panel',
  CUADRANTE_PREFIX: 'cuadrante-actual',   // solo para migrar cuadrantes antiguos
  ASIGNACIONES_NAME: 'asignaciones.json', // idem
  CUADRANTES_INDEX: 'cuadrantes.json',    // índice del historial de cuadrantes
  HISTORIAL_NAME: 'historial-asignaciones.json',
  OCULTAS_NAME: 'asignaciones-ocultas.json',
  GUARDADAS_NAME: 'asignaciones-guardadas.json',
  EVENTS_NAME: 'eventos.json',
  PROYECTOS_NAME: 'proyectos.json',
  MINISTERIO_NAME: 'ministerio.json',
  TAREAS_NAME: 'tareas.json',
  EXPLORADOR_NAME: 'explorador-favoritos.json',
  CONFIG_NAME: 'config.json',
};

/* =========================================================
   Estado
   ========================================================= */
let tokenClient, accessToken = null, folderId = null;
let events = [];
let proyectos = [];
let ministerio = [];          // [{ id, date, minutes, note }]
let tareas = [];              // [{ id, title, done, doneAt, due, time, priority, project, labels[], notes, subtasks[], createdAt }]
let tareasView = 'todas';     // todas (agrupado por proyecto) | hoy | proximo | hechas
let tareasFilter = { project: '', label: '' };
let explorerFavs = [];        // [{ id, name }]
let explorerStack = [];       // [{ id, name }] ruta actual
let explorerLoaded = false;
let appConfig = {};           // { cuadranteDestId, cuadranteDestName }
let hiddenKeys = new Set();   // claves de asignaciones descartadas por el usuario
let savedList = [];           // [{ key, tipo, fecha, hora, categoria, nombreTexto }] guardadas a mano
let searchName = '';          // búsqueda de asignación por nombre en el cuadrante actual
let cuadrantesIdx = [];       // [{ id, uploaded, mime, ext, tipo, docName, parseName }] (recientes primero)
let currentCuadranteId = null;
let calMonth = new Date(calYearMonthStart());
let notifiedIds = new Set(JSON.parse(localStorage.getItem('hg_notified') || '[]'));

function calYearMonthStart(){ const d = new Date(); d.setDate(1); d.setHours(0,0,0,0); return d; }

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* =========================================================
   Google Identity Services — autenticación
   (en web: token client de GIS · en la APK: plugin nativo GoogleAuth)
   ========================================================= */
const IS_NATIVE = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
if (IS_NATIVE) document.documentElement.classList.add('is-app');

window.addEventListener('load', () => {
  if (IS_NATIVE) { initAuthNative(); return; }
  const check = setInterval(() => {
    if (window.google && google.accounts) {
      clearInterval(check);
      initAuth();
    }
  }, 100);
});

/* Sesión: guardamos el token ~50 min y, pasado ese tiempo, intentamos renovarlo
   EN SILENCIO (sin volver a mostrar el selector de cuenta) antes de rendirnos y
   pedir un login interactivo. `hg_ever_signed_in` recuerda que ya hubo consentimiento. */
function applyToken(token){
  accessToken = token;
  localStorage.setItem('hg_token', token);
  localStorage.setItem('hg_token_ts', Date.now().toString());
  localStorage.setItem('hg_ever_signed_in', '1');
}
function tokenIsFresh(){
  const ts = parseInt(localStorage.getItem('hg_token_ts') || '0', 10);
  return Date.now() - ts < 50 * 60 * 1000;
}

async function initAuthNative(){
  const { GoogleAuth } = window.Capacitor.Plugins;
  try { await GoogleAuth.initialize(); } catch (e) {}
  const doLogin = async () => {
    try {
      const user = await GoogleAuth.signIn();
      applyToken(user.authentication.accessToken);
      await onSignedIn();
    } catch (e) { console.error(e); showError('No se pudo iniciar sesión con Google.'); }
  };
  const trySilent = async () => {
    try { const auth = await GoogleAuth.refresh(); applyToken(auth.accessToken); await onSignedIn(); return true; }
    catch (e) { return false; }
  };
  $('#signInBtn').addEventListener('click', doLogin);
  $('#signOutBtn').addEventListener('click', async () => { try { await GoogleAuth.signOut(); } catch (e) {} signOut(); });
  window.__refreshTokenSilently = trySilent;

  const cached = localStorage.getItem('hg_token');
  if (cached && tokenIsFresh()) { accessToken = cached; onSignedIn(); return; }
  if (localStorage.getItem('hg_ever_signed_in') === '1' && await trySilent()) return;
  doLogin();
}

function initAuth(){
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: CONFIG.SCOPES,
    callback: async (resp) => {
      if (resp.error) { console.error(resp); return; }
      applyToken(resp.access_token);
      await onSignedIn();
    },
  });

  $('#signInBtn').addEventListener('click', () => tokenClient.requestAccessToken({ prompt: 'consent' }));
  $('#signOutBtn').addEventListener('click', signOut);
  window.__refreshTokenSilently = () => { tokenClient.requestAccessToken({ prompt: '' }); return Promise.resolve(true); };

  // Reutiliza el token si sigue fresco (~50 min); si no, intenta renovarlo sin
  // mostrar ventanas (funciona si el navegador aún tiene la sesión de Google).
  const cached = localStorage.getItem('hg_token');
  if (cached && tokenIsFresh()) {
    accessToken = cached;
    onSignedIn();
  } else if (localStorage.getItem('hg_ever_signed_in') === '1') {
    tokenClient.requestAccessToken({ prompt: '' });
  }
}

/* Renueva el token en segundo plano antes de que caduque, para que una sesión
   larga (panel abierto horas) no se quede sin permiso a media tarea. */
function scheduleTokenRefresh(){
  setInterval(() => {
    if (accessToken && typeof window.__refreshTokenSilently === 'function') window.__refreshTokenSilently();
  }, 40 * 60 * 1000);
}

function signOut(){
  if (accessToken && window.google && google.accounts) google.accounts.oauth2.revoke(accessToken, () => {});
  accessToken = null;
  localStorage.removeItem('hg_token');
  localStorage.removeItem('hg_token_ts');
  localStorage.removeItem('hg_ever_signed_in');
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
    await loadGuardadas();
    await loadEvents();     // antes de openCuadrante: su sync al calendario necesita los eventos ya cargados
    await loadMinisterio();
    await loadTareas();
    await applyWidgetPendingDone();
    await loadExplorerFavs();
    await loadConfig();
    await loadCuadrantesIndex();
    await Promise.all([loadProyectos(), openCuadrante()]);
    renderNameMatches();
    updateHiddenBar();
    renderCuadranteHistory();
    await syncMyAssignmentsToCalendar(); // vuelca mis asignaciones al calendario
    renderCalendar();
    renderCalSettings();
    renderUpcoming();
    renderProyectos();
    renderMinisterio();
    renderTareas();
    renderAsignaciones();
    updateScopeLabel();
    renderSearchMatches();
    renderDashboard();
    handleLaunchParams();
    checkReminders();
    if (!window.__remindersTimerOn) { window.__remindersTimerOn = true; setInterval(checkReminders, 60000); scheduleTokenRefresh(); }
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
  if (go === 'proyectos') activateTab('proyectos');
  else if (go && document.getElementById('tab-' + go)) activateTab(go);
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
  if (name === 'proyectos') { tareasView = 'proyectos'; name = 'tareas'; }
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $$('.panel').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  closeDrawer();
  if (name === 'archivos' && !explorerLoaded && folderId) openExplorerFolder('root');
  if (name === 'tareas') renderTareas();
}
$$('.tab').forEach(tab => tab.addEventListener('click', () => activateTab(tab.dataset.tab)));

/* ---------- Menú hamburguesa (móvil) ---------- */
function buildDrawer(){
  const panel = document.getElementById('ndPanel');
  if (!panel) return;
  panel.innerHTML = $$('.tab').map(t =>
    `<button class="nd-item" data-tab="${t.dataset.tab}">${t.innerHTML}</button>`).join('');
  panel.querySelectorAll('.nd-item').forEach(b => b.addEventListener('click', () => activateTab(b.dataset.tab)));
}
function openDrawer(){
  const d = document.getElementById('navDrawer');
  if (d) { d.hidden = false; requestAnimationFrame(() => d.classList.add('open')); }
}
function closeDrawer(){
  const d = document.getElementById('navDrawer');
  if (d) { d.classList.remove('open'); setTimeout(() => { d.hidden = true; }, 220); }
}
buildDrawer();
document.getElementById('hamburger').addEventListener('click', openDrawer);
document.getElementById('navDrawer').addEventListener('click', (e) => { if (e.target.id === 'navDrawer') closeDrawer(); });

/* ---------- Tema claro / oscuro ---------- */
function applyTheme(mode){
  const root = document.documentElement;
  if (mode === 'light' || mode === 'dark') root.setAttribute('data-theme', mode);
  else root.removeAttribute('data-theme');
  const btn = document.getElementById('themeToggle');
  const dark = mode === 'dark' || (!mode && matchMedia('(prefers-color-scheme: dark)').matches);
  if (btn) btn.textContent = dark ? '☀️' : '🌙';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#12161C' : '#1E2A38');
}
(function initTheme(){
  applyTheme(localStorage.getItem('hg_theme') || '');
  const btn = document.getElementById('themeToggle');
  if (btn) btn.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : 'dark';
    localStorage.setItem('hg_theme', next);
    applyTheme(next);
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!localStorage.getItem('hg_theme')) applyTheme('');
  });
})();

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

async function renameFile(id, name){
  await driveFetch(`https://www.googleapis.com/drive/v3/files/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

async function ensureFolder(){
  const cached = localStorage.getItem('hg_folder_id');
  if (cached) { folderId = cached; return; }
  let f = await findFile(CONFIG.FOLDER_NAME, 'root', 'application/vnd.google-apps.folder');
  if (!f) {
    // migra la carpeta antigua "Hourglass Panel" → "Agenda JW" sin perder datos
    const legacy = await findFile(CONFIG.FOLDER_NAME_LEGACY, 'root', 'application/vnd.google-apps.folder');
    if (legacy) { try { await renameFile(legacy.id, CONFIG.FOLDER_NAME); } catch (e) { /* no crítico */ } f = legacy; }
  }
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
    : t === 'publica' ? 'Fin de semana'
    : 'Documento';
}

/* Meses que cubre un análisis (["YYYY-MM", ...]) y su etiqueta legible. */
function mesesDe(parsed){
  const s = new Set();
  (parsed && parsed.asignaciones || []).forEach(a => {
    const iso = assignmentDateISO(a.fecha);
    if (iso) s.add(iso.slice(0, 7));
  });
  return [...s].sort();
}
function mesesLabel(meses){
  if (!meses || !meses.length) return '';
  const mn = (ym) => { const [y, m] = ym.split('-'); return new Date(+y, +m - 1, 1).toLocaleDateString('es-ES', { month: 'long' }); };
  const yr = (ym) => ym.slice(0, 4);
  const a = meses[0], b = meses[meses.length - 1];
  if (a === b) return `${mn(a)} ${yr(a)}`;
  if (yr(a) === yr(b)) return `${mn(a)}–${mn(b)} ${yr(a)}`;
  return `${mn(a)} ${yr(a)} – ${mn(b)} ${yr(b)}`;
}

/* ---------- Configuración de la app (carpeta destino, etc.) ---------- */
async function loadConfig(){
  const f = await findFile(CONFIG.CONFIG_NAME, folderId, 'application/json');
  if (!f) { appConfig = {}; return; }
  try { appConfig = (await (await downloadFile(f.id)).json()) || {}; }
  catch (e) { appConfig = {}; }
}
async function persistConfig(){
  await saveFile(CONFIG.CONFIG_NAME, 'application/json', JSON.stringify(appConfig, null, 2), folderId);
}

/* Selector de carpeta de Drive (solo carpetas). Devuelve {id,name} o null. */
function pickFolder({ title = 'Elegir carpeta', startId = 'root', startName = 'Mi unidad' } = {}){
  return new Promise((resolve) => {
    let stack = [{ id: startId, name: startName }];
    let done = false;
    const finish = (v) => { if (!done) { done = true; closeModal2(); resolve(v); } };
    async function show(){
      const cur = stack[stack.length - 1];
      showSand('Cargando carpetas…');
      let folders = [];
      try {
        folders = (await driveList(cur.id)).filter(f => f.mimeType === 'application/vnd.google-apps.folder');
      } catch (err) {
        hideSand();
        if (/Drive API 40[13]/.test(err.message || '')) { reauthDrive(); finish(null); return; }
        showError('No se pudieron cargar las carpetas de Drive.'); finish(null); return;
      }
      hideSand();
      renderModal2(`
        <h3>${escapeHtml(title)}</h3>
        <div class="pk-bar">${stack.map((s, i) =>
          `<button class="ex-crumb" data-c="${i}">${escapeHtml(s.name)}</button>${i < stack.length - 1 ? '<span class="ex-sep">›</span>' : ''}`).join('')}</div>
        <div class="pk-list">${folders.length
          ? folders.map(f => `<div class="ex-row" data-f="${escapeAttr(f.id)}" data-n="${escapeAttr(f.name)}">
              <span class="ex-ic">📁</span><span class="ex-nm">${escapeHtml(f.name)}</span><span class="ex-go">›</span></div>`).join('')
          : '<p class="empty-note">Esta carpeta no tiene subcarpetas.</p>'}</div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="pkCancel">Cancelar</button>
          <button class="btn btn-primary" id="pkChoose">Guardar aquí: «${escapeHtml(cur.name)}»</button>
        </div>`);
      $('#pkCancel').addEventListener('click', () => finish(null));
      $('#pkChoose').addEventListener('click', () => finish({ id: cur.id, name: cur.name }));
      $$('#modalRoot2 .pk-bar .ex-crumb').forEach(b => b.addEventListener('click', () => { stack = stack.slice(0, +b.dataset.c + 1); show(); }));
      $$('#modalRoot2 .pk-list [data-f]').forEach(el => el.addEventListener('click', () => { stack.push({ id: el.dataset.f, name: el.dataset.n }); show(); }));
    }
    show();
  });
}

/* Selector de ARCHIVO de Drive (navega carpetas, elige un archivo). Devuelve
   { id, name, mimeType, webViewLink } o null. */
function pickDriveFile({ title = 'Elegir documento de Drive', startId = 'root', startName = 'Mi unidad' } = {}){
  return new Promise((resolve) => {
    let stack = [{ id: startId, name: startName }];
    let done = false;
    const finish = (v) => { if (!done) { done = true; closeModal2(); resolve(v); } };
    async function show(){
      const cur = stack[stack.length - 1];
      showSand('Cargando Drive…');
      let files = [];
      try { files = await driveList(cur.id); }
      catch (err) {
        hideSand();
        if (/Drive API 40[13]/.test(err.message || '')) { reauthDrive(); finish(null); return; }
        showError('No se pudo leer Drive.'); finish(null); return;
      }
      hideSand();
      const folders = files.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
      const docs = files.filter(f => f.mimeType !== 'application/vnd.google-apps.folder');
      renderModal2(`
        <h3>${escapeHtml(title)}</h3>
        <div class="pk-bar">${stack.map((s, i) =>
          `<button class="ex-crumb" data-c="${i}">${escapeHtml(s.name)}</button>${i < stack.length - 1 ? '<span class="ex-sep">›</span>' : ''}`).join('')}</div>
        <div class="pk-list">
          ${folders.map(f => `<div class="ex-row" data-f="${escapeAttr(f.id)}" data-n="${escapeAttr(f.name)}">
            <span class="ex-ic">📁</span><span class="ex-nm">${escapeHtml(f.name)}</span><span class="ex-go">›</span></div>`).join('')}
          ${docs.map(f => `<div class="ex-row" data-pick="${escapeAttr(f.id)}" data-n="${escapeAttr(f.name)}" data-m="${escapeAttr(f.mimeType || '')}" data-l="${escapeAttr(f.webViewLink || '')}">
            <span class="ex-ic">${fileIcon(f.mimeType)}</span><span class="ex-nm">${escapeHtml(f.name)}</span></div>`).join('')}
          ${files.length ? '' : '<p class="empty-note">Carpeta vacía.</p>'}
        </div>
        <div class="modal-actions"><button class="btn btn-ghost" id="pkCancel">Cancelar</button></div>`);
      $('#pkCancel').addEventListener('click', () => finish(null));
      $$('#modalRoot2 .pk-bar .ex-crumb').forEach(b => b.addEventListener('click', () => { stack = stack.slice(0, +b.dataset.c + 1); show(); }));
      $$('#modalRoot2 .pk-list [data-f]').forEach(el => el.addEventListener('click', () => { stack.push({ id: el.dataset.f, name: el.dataset.n }); show(); }));
      $$('#modalRoot2 .pk-list [data-pick]').forEach(el => el.addEventListener('click', () =>
        finish({ id: el.dataset.pick, name: el.dataset.n, mimeType: el.dataset.m, webViewLink: el.dataset.l })));
    }
    show();
  });
}

/* Decide la carpeta destino del cuadrante: usa la guardada, o abre el selector
   (empezando dentro de tu carpeta "JW" si existe) y la recuerda. */
async function chooseCuadranteDest(){
  if (appConfig.cuadranteDestId) {
    return { id: appConfig.cuadranteDestId, name: appConfig.cuadranteDestName || 'carpeta guardada', remembered: true };
  }
  let start = { id: 'root', name: 'Mi unidad' };
  try {
    const jw = await findFile('JW', 'root', 'application/vnd.google-apps.folder');
    if (jw) start = { id: jw.id, name: 'JW' };
  } catch (e) { /* sin permiso aún */ }
  const dest = await pickFolder({ title: 'Guardar el cuadrante en…', startId: start.id, startName: start.name });
  if (dest) {
    appConfig.cuadranteDestId = dest.id;
    appConfig.cuadranteDestName = dest.name;
    try { await persistConfig(); } catch (e) { /* no crítico */ }
  }
  return dest;
}

/* Nombre opcional para identificar el cuadrante en el historial (p. ej. "Grupo 2 — octubre"). */
function askCuadranteLabel(){
  return new Promise((resolve) => {
    renderModal(`
      <h3>Subir cuadrante</h3>
      <div class="field"><label>Nombre (opcional, para identificarlo luego)</label>
        <input id="cuLabel" placeholder="p. ej. Congregación Centro — octubre"></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="modalCancel">Cancelar</button>
        <button class="btn btn-primary" id="modalOk">Continuar</button>
      </div>`);
    $('#modalCancel').addEventListener('click', () => { closeModal(); resolve(null); });
    $('#modalOk').addEventListener('click', () => { const v = $('#cuLabel').value.trim(); closeModal(); resolve({ nombre: v }); });
    setTimeout(() => { const el = document.getElementById('cuLabel'); if (el) el.focus(); }, 50);
  });
}

$('#pdfInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const isImage = file.type.startsWith('image/');
  const isPdf = file.type === 'application/pdf';
  if (!isImage && !isPdf) { showError('Sube un PDF o una imagen (JPG, PNG…).'); e.target.value = ''; return; }

  const label = await askCuadranteLabel();
  if (!label) { e.target.value = ''; return; }

  const dest = await chooseCuadranteDest();
  if (!dest) { e.target.value = ''; return; }

  showSand('Subiendo cuadrante…');
  try {
    const ext = isPdf ? 'pdf' : (file.name.split('.').pop() || 'jpg').toLowerCase();
    const mime = isPdf ? 'application/pdf' : file.type;
    const stamp = nowStamp();
    const docName = `cuadrante-${stamp}.${ext}`;
    const parseName = `asignaciones-${stamp}.json`;

    // el documento va a la carpeta elegida; el análisis JSON, a la carpeta de la app
    const meta = await createFileMeta(docName, dest.id, mime);
    await updateFileContent(meta.id, mime, file);

    if (currentDocUrl) URL.revokeObjectURL(currentDocUrl);
    currentDocBlob = file; currentDocMime = mime;
    currentDocUrl = URL.createObjectURL(file);
    renderOriginalViewer(currentDocMime, currentDocUrl);
    $('#viewToggle').hidden = false;

    currentParsed = await parseBlob(file, mime);
    const parseId = await saveFile(parseName, 'application/json', JSON.stringify(currentParsed, null, 2), folderId);
    await mergeIntoHistorial(currentParsed, stamp);

    const entry = {
      id: stamp, uploaded: new Date().toISOString(), mime, ext, tipo: currentParsed.tipo,
      nombre: label.nombre || '',
      meses: mesesDe(currentParsed),
      fileId: meta.id, fileName: docName, parentId: dest.id, parentName: dest.name,
      parseId, parseName,
    };
    cuadrantesIdx.unshift(entry);
    await persistCuadrantesIndex();
    currentCuadranteId = stamp;

    $('#cuadranteMeta').textContent = `${entry.nombre ? entry.nombre + ' · ' : ''}${tipoLabel(currentParsed.tipo)}${entry.meses.length ? ' · ' + mesesLabel(entry.meses) : ''} · guardado en «${dest.name}»`;
    renderCuadranteHistory();
    renderDigitalView(currentParsed);
    renderNameMatches();
    updateHiddenBar();
    await syncMyAssignmentsToCalendar();
    renderDashboard();
  } catch (err) {
    console.error(err);
    showError('No se pudo subir el archivo. Comprueba que has dado permiso de Drive.');
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
            fileId: lf.id, fileName: lf.name, parentId: folderId, parentName: CONFIG.FOLDER_NAME,
            parseId: (i === 0 && oldParse) ? oldParse.id : null,
            parseName: (i === 0 && oldParse) ? CONFIG.ASIGNACIONES_NAME : null,
          });
        });
      try { await persistCuadrantesIndex(); } catch (e) { /* no crítico */ }
    }
  }
  cuadrantesIdx.sort((a, b) => (b.uploaded || '').localeCompare(a.uploaded || ''));
}

/* Rellena fileId/parseId por nombre si un entrada antigua aún no los tiene. */
async function ensureEntryIds(entry){
  let changed = false;
  if (!entry.fileId && (entry.fileName || entry.docName)) {
    const f = await findFile(entry.fileName || entry.docName, entry.parentId || folderId).catch(() => null);
    if (f) { entry.fileId = f.id; changed = true; }
  }
  if (!entry.parseId && entry.parseName) {
    const f = await findFile(entry.parseName, folderId, 'application/json').catch(() => null);
    if (f) { entry.parseId = f.id; changed = true; }
  }
  if (changed) { try { await persistCuadrantesIndex(); } catch (e) { /* no crítico */ } }
  return entry;
}

/* Abre un cuadrante del historial (o el más reciente si no se indica id). */
async function openCuadrante(id){
  const entry = (id && cuadrantesIdx.find(c => c.id === id)) || cuadrantesIdx[0] || null;
  const meta = $('#cuadranteMeta');
  const toggle = $('#viewToggle');

  if (!entry) {
    currentCuadranteId = null; currentDocBlob = null; currentParsed = null;
    toggle.hidden = true;
    setOriginalViewerEmpty();
    $('#digitalView').innerHTML = '';
    meta.textContent = '';
    renderCuadranteHistory();
    renderDigitalView(null);
    renderNameMatches();
    return;
  }
  currentCuadranteId = entry.id;
  await ensureEntryIds(entry);

  if (!entry.fileId) { showError('No se encontró el archivo de este cuadrante en Drive (¿se movió o borró?).'); return; }
  let blob;
  try { blob = await (await downloadFile(entry.fileId)).blob(); }
  catch (err) {
    if (/Drive API 40[13]/.test(err.message || '')) { reauthDrive(); return; }
    showError('No se pudo abrir el archivo de este cuadrante.'); return;
  }
  if (currentDocUrl) URL.revokeObjectURL(currentDocUrl);
  currentDocBlob = blob;
  currentDocMime = entry.mime && entry.mime !== 'image/*' ? entry.mime : blob.type;
  currentDocUrl = URL.createObjectURL(blob);
  renderOriginalViewer(currentDocMime, currentDocUrl);
  toggle.hidden = false;

  let parsed = null;
  if (entry.parseId) {
    try { parsed = await (await downloadFile(entry.parseId)).json(); } catch (e) { parsed = null; }
  }
  if (!parsed) {
    parsed = await parseBlob(blob, currentDocMime);
    const pn = entry.parseName || `asignaciones-${entry.id}.json`;
    entry.parseName = pn;
    try { entry.parseId = await saveFile(pn, 'application/json', JSON.stringify(parsed, null, 2), folderId); await persistCuadrantesIndex(); }
    catch (e) { /* no crítico */ }
  }
  currentParsed = parsed;

  let idxChanged = false;
  if (entry.tipo === '?' && parsed.tipo && parsed.tipo !== 'desconocido') { entry.tipo = parsed.tipo; idxChanged = true; }
  if (!entry.meses || !entry.meses.length) { entry.meses = mesesDe(parsed); idxChanged = true; }
  if (idxChanged) { try { await persistCuadrantesIndex(); } catch (e) { /* no crítico */ } }

  meta.textContent = `${entry.nombre ? entry.nombre + ' · ' : ''}${tipoLabel(entry.tipo)}${entry.meses && entry.meses.length ? ' · ' + mesesLabel(entry.meses) : ''}`
    + (entry.parentName ? ` · «${entry.parentName}»` : '');

  await mergeIntoHistorial(parsed, entry.id);
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
  renderModal(`
    <h3>Borrar cuadrante</h3>
    <p>Se eliminará de Drive el cuadrante de <strong>${escapeHtml(tipoLabel(entry.tipo))}${entry.meses && entry.meses.length ? ' · ' + escapeHtml(mesesLabel(entry.meses)) : ''}</strong>${entry.parentName ? ' («' + escapeHtml(entry.parentName) + '»)' : ''}.
    Las asignaciones que ya aprobaste (✓) se conservan.</p>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="modalCancel">Cancelar</button>
      <button class="btn btn-primary" id="modalConfirm" style="background:#B4432D; color:#FFF5EF;">Borrar</button>
    </div>`);
  $('#modalCancel').addEventListener('click', closeModal);
  $('#modalConfirm').addEventListener('click', async () => {
    closeModal();
    showSand('Borrando…');
    try {
      await ensureEntryIds(entry);
      for (const fid of [entry.fileId, entry.parseId]) {
        if (fid) { try { await deleteFile(fid); } catch (_) {} }
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
  const destName = appConfig.cuadranteDestName;
  const destLine = `<div class="ch-dest">Carpeta para nuevos cuadrantes:
    <strong>${destName ? escapeHtml(destName) : 'se preguntará al subir'}</strong>
    <button class="ch-chg" id="chChgDest">Cambiar</button></div>`;

  if (!cuadrantesIdx.length) {
    box.hidden = false;
    box.innerHTML = destLine;
    const b = document.getElementById('chChgDest');
    if (b) b.addEventListener('click', changeCuadranteDest);
    return;
  }
  box.hidden = false;
  box.innerHTML = `<span class="ch-label">Cuadrantes</span>
    <div class="ch-list">${cuadrantesIdx.map(c => {
      const tl = tipoLabel(c.tipo);
      const ml = mesesLabel(c.meses);
      return `<div class="ch-item${c.id === currentCuadranteId ? ' active' : ''}" data-open="${escapeAttr(c.id)}" title="${escapeAttr((c.nombre ? c.nombre + ' · ' : '') + tl + (ml ? ' · ' + ml : ''))}">
        <span class="ch-tipo ${c.tipo === 'entre-semana' ? 'is-es' : c.tipo === 'publica' ? 'is-fs' : ''}">${escapeHtml(tl)}</span>
        ${c.nombre ? `<span class="ch-nombre">${escapeHtml(c.nombre)}</span>` : ''}
        <span class="ch-meses">${ml ? escapeHtml(ml) : 'sin fechas'}</span>
        <button class="ch-edit" title="Renombrar" data-edit="${escapeAttr(c.id)}">✎</button>
        <button class="ch-del" title="Borrar" data-del="${escapeAttr(c.id)}">🗑</button>
      </div>`;
    }).join('')}</div>
    ${destLine}`;
  box.querySelectorAll('.ch-item').forEach(el => el.addEventListener('click', (e) => {
    if (e.target.closest('.ch-del') || e.target.closest('.ch-edit')) return;
    openCuadrante(el.dataset.open);
  }));
  box.querySelectorAll('.ch-del').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteCuadrante(b.dataset.del);
  }));
  box.querySelectorAll('.ch-edit').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    editCuadranteLabel(b.dataset.edit);
  }));
  const chg = document.getElementById('chChgDest');
  if (chg) chg.addEventListener('click', changeCuadranteDest);
}

function editCuadranteLabel(id){
  const entry = cuadrantesIdx.find(c => c.id === id);
  if (!entry) return;
  renderModal(`
    <h3>Nombre del cuadrante</h3>
    <div class="field"><label>Nombre</label>
      <input id="cuLabel2" value="${escapeAttr(entry.nombre || '')}" placeholder="p. ej. Congregación Centro — octubre"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="modalCancel">Cancelar</button>
      <button class="btn btn-primary" id="modalOk">Guardar</button>
    </div>`);
  $('#modalCancel').addEventListener('click', closeModal);
  $('#modalOk').addEventListener('click', async () => {
    entry.nombre = $('#cuLabel2').value.trim();
    closeModal();
    showSand('Guardando…');
    try { await persistCuadrantesIndex(); renderCuadranteHistory(); if (entry.id === currentCuadranteId) openCuadrante(entry.id); }
    finally { hideSand(); }
  });
}

async function changeCuadranteDest(){
  let start = { id: 'root', name: 'Mi unidad' };
  try {
    const jw = await findFile('JW', 'root', 'application/vnd.google-apps.folder');
    if (jw) start = { id: jw.id, name: 'JW' };
  } catch (e) { /* sin permiso */ }
  const dest = await pickFolder({ title: 'Carpeta para nuevos cuadrantes', startId: start.id, startName: start.name });
  if (!dest) return;
  appConfig.cuadranteDestId = dest.id;
  appConfig.cuadranteDestName = dest.name;
  showSand('Guardando…');
  try { await persistConfig(); } catch (e) { showError('No se pudo guardar la preferencia.'); }
  finally { hideSand(); }
  renderCuadranteHistory();
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

/* ---------- Asignaciones GUARDADAS a mano (van al calendario, persisten) ---------- */
async function loadGuardadas(){
  const f = await findFile(CONFIG.GUARDADAS_NAME, folderId, 'application/json');
  if (!f) { savedList = []; return; }
  try { savedList = (await (await downloadFile(f.id)).json()) || []; }
  catch (e) { savedList = []; }
}
async function persistGuardadas(){
  await saveFile(CONFIG.GUARDADAS_NAME, 'application/json', JSON.stringify(savedList, null, 2), folderId);
}
function isSavedKey(k){ return !!k && savedList.some(s => s.key === k); }

/* Registro clave → datos, rellenado al renderizar, para reconstruir la asignación
   cuando se pulsa ✓ Guardar desde cualquier sitio. */
const _amMap = new Map();
function assignmentActions(m){
  const k = m._key || m.key;
  _amMap.set(k, { key: k, tipo: m.tipo || null, fecha: m.fecha || '', hora: m.hora || '', categoria: m.categoria || 'Asignación', nombreTexto: m.nombreTexto || '' });
  const saved = isSavedKey(k);
  return `<span class="dv-acts">
    <button class="dv-save${saved ? ' on' : ''}" title="${saved ? 'Quitar de guardadas' : 'Guardar'}" data-k="${escapeAttr(k)}">✓</button>
    <button class="dv-del" title="Descartar" data-k="${escapeAttr(k)}">✕</button>
  </span>`;
}
function wireAssignmentActions(box){
  box.querySelectorAll('.dv-save').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); toggleGuardada(b.dataset.k); }));
  box.querySelectorAll('.dv-del').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); hideAssignment(b.dataset.k); }));
}

function refreshAssignmentsUI(){
  renderDigitalView(currentParsed);
  renderNameMatches();
  renderSearchMatches();
  renderAsignaciones();
  updateHiddenBar();
}

async function toggleGuardada(key){
  if (!key) return;
  const i = savedList.findIndex(s => s.key === key);
  if (i >= 0) savedList.splice(i, 1);
  else {
    const m = _amMap.get(key) || { key };
    savedList.push({ key, tipo: m.tipo || null, fecha: m.fecha || '', hora: m.hora || '', categoria: m.categoria || 'Asignación', nombreTexto: m.nombreTexto || '' });
    hiddenKeys.delete(key); // guardar deshace descartar
  }
  showSand('Guardando…');
  try { await persistGuardadas(); await persistHidden(); } catch (e) { showError('No se pudo guardar el cambio.'); }
  finally { hideSand(); }
  refreshAssignmentsUI();
  await syncMyAssignmentsToCalendar();
  renderDashboard();
}

async function hideAssignment(key){
  if (!key) return;
  hiddenKeys.add(key);
  const i = savedList.findIndex(s => s.key === key);
  if (i >= 0) savedList.splice(i, 1); // descartar deshace guardar
  showSand('Guardando…');
  try { await persistHidden(); await persistGuardadas(); } catch (e) { showError('No se pudo guardar el cambio.'); }
  finally { hideSand(); }
  refreshAssignmentsUI();
  await syncMyAssignmentsToCalendar();
  renderDashboard();
}
async function resetHidden(){
  if (hiddenKeys.size === 0) return;
  hiddenKeys.clear();
  showSand('Guardando…');
  try { await persistHidden(); } catch (e) { showError('No se pudo guardar el cambio.'); }
  finally { hideSand(); }
  refreshAssignmentsUI();
  await syncMyAssignmentsToCalendar();
  renderDashboard();
}
function updateHiddenBar(){
  const bar = document.getElementById('hiddenBar');
  if (!bar) return;
  const nH = hiddenKeys.size, nG = savedList.length;
  if (!nH && !nG) { bar.hidden = true; bar.innerHTML = ''; return; }
  bar.hidden = false;
  const parts = [];
  if (nG) parts.push(`<span>✓ ${nG} guardada${nG === 1 ? '' : 's'}</span>`);
  if (nH) parts.push(`<span>✕ ${nH} descartada${nH === 1 ? '' : 's'} <button class="btn btn-ghost" id="resetHiddenBtn">mostrar todas</button></span>`);
  bar.innerHTML = parts.join(' · ');
  const rb = bar.querySelector('#resetHiddenBtn');
  if (rb) rb.addEventListener('click', resetHidden);
}

async function mergeIntoHistorial(parsed, srcId){
  const seen = new Set(currentHistorial.map(assignmentKey));
  let added = 0;
  (parsed.asignaciones || []).forEach(a => {
    const record = { tipo: parsed.tipo, ...a, ...(srcId ? { _src: srcId } : {}) };
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
    if (!digital) gotoViewerPage(viewerPage); // ahora sí es visible: pdf.js puede pintar el canvas
  });
});

function setOriginalViewerEmpty(){
  const viewer = $('#cuadranteViewer');
  viewer.hidden = false;
  viewer.classList.add('empty');
  viewer.innerHTML = '<p>Todavía no hay ningún cuadrante subido.</p>';
  viewerPdfDoc = null;
}

/* Documento original: PDF se pinta con pdf.js en un <canvas> (el <embed> nativo
   no siempre está disponible — en la APK no hay visor de PDF del sistema, así
   que a veces se quedaba en blanco). Las imágenes se muestran tal cual. */
let viewerPdfDoc = null, viewerPage = 1;

async function renderOriginalViewer(mime, url){
  const viewer = $('#cuadranteViewer');
  viewer.classList.remove('empty');
  viewer.hidden = true; // por defecto se muestra la vista digital
  viewerPdfDoc = null; viewerPage = 1;

  if (mime !== 'application/pdf') {
    viewer.innerHTML = `<img id="pdfEmbed" src="${url}" alt="Cuadrante" style="width:100%; display:block;">`;
    return;
  }

  viewer.innerHTML = `
    <div class="pdfv-bar">
      <button class="btn btn-ghost" id="pdfvPrev" aria-label="Página anterior">‹</button>
      <span id="pdfvPage" class="pdfv-pagelbl">Cargando…</span>
      <button class="btn btn-ghost" id="pdfvNext" aria-label="Página siguiente">›</button>
    </div>
    <div class="pdfv-canvas-wrap"><canvas id="pdfvCanvas"></canvas></div>`;
  $('#pdfvPrev').addEventListener('click', () => gotoViewerPage(viewerPage - 1));
  $('#pdfvNext').addEventListener('click', () => gotoViewerPage(viewerPage + 1));

  try {
    if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    viewerPdfDoc = await pdfjsLib.getDocument(url).promise;
    const lbl = document.getElementById('pdfvPage');
    if (lbl) lbl.textContent = `Página 1 / ${viewerPdfDoc.numPages}`;
    // OJO: pdf.js se queda colgado si se pinta en un <canvas> dentro de un
    // contenedor display:none — solo renderizamos si la vista ya es visible
    // (si no, se pintará en cuanto el usuario pulse "Documento original").
    if (!viewer.hidden) await gotoViewerPage(1);
  } catch (err) {
    console.error(err);
    viewer.innerHTML = '<p>No se pudo mostrar el documento original en esta pantalla. La vista digital sigue disponible.</p>';
  }
}

/* Comprueba (muestreando una rejilla, barato) si el canvas sigue totalmente
   transparente: el render de pdf.js a veces "resuelve" sin haber pintado nada
   si el worker no cargó bien, así que no basta con mirar si la promesa cumplió. */
function canvasLooksBlank(canvas){
  try {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    if (!w || !h) return true;
    const stepX = Math.max(1, Math.floor(w / 14)), stepY = Math.max(1, Math.floor(h / 14));
    for (let y = 0; y < h; y += stepY) {
      for (let x = 0; x < w; x += stepX) {
        if (ctx.getImageData(x, y, 1, 1).data[3] > 0) return false;
      }
    }
    return true;
  } catch (e) { return false; }
}

let viewerRenderTask = null;
async function gotoViewerPage(n, _retrying){
  if (!viewerPdfDoc || $('#cuadranteViewer').hidden) return;
  n = Math.max(1, Math.min(viewerPdfDoc.numPages, n));
  viewerPage = n;
  const canvas = document.getElementById('pdfvCanvas');
  const lbl = document.getElementById('pdfvPage');
  if (!canvas) return;
  if (viewerRenderTask) { try { viewerRenderTask.cancel(); } catch (e) {} viewerRenderTask = null; }
  let ok = false;
  try {
    const page = await viewerPdfDoc.getPage(n);
    const wrap = canvas.parentElement;
    const baseVp = page.getViewport({ scale: 1 });
    const scale = Math.max(0.5, (wrap.clientWidth || 320) / baseVp.width);
    const vp = page.getViewport({ scale });
    canvas.width = vp.width; canvas.height = vp.height;
    const task = page.render({ canvasContext: canvas.getContext('2d'), viewport: vp });
    viewerRenderTask = task;
    // Salvaguarda: si el renderizado no responde (dispositivo lento, PDF pesado,
    // o el worker de pdf.js no carga bien), no dejamos la pantalla colgada.
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('render-timeout')), 12000));
    await Promise.race([task.promise, timeout]);
    viewerRenderTask = null;
    ok = !canvasLooksBlank(canvas);
  } catch (err) {
    viewerRenderTask = null;
    if (err && err.name !== 'RenderingCancelledException') console.error('Documento original:', err);
  }
  if (!ok && !_retrying) {
    // Reintenta una vez sin worker dedicado (pdf.js cae a hilo principal): más
    // lento, pero evita depender de que el navegador pueda crear el worker.
    try {
      pdfjsLib.GlobalWorkerOptions.workerSrc = '';
      viewerPdfDoc = await pdfjsLib.getDocument(currentDocUrl).promise;
      return gotoViewerPage(n, true);
    } catch (e2) { console.error('Documento original (reintento):', e2); }
  }
  if (lbl) lbl.textContent = ok ? `Página ${n} / ${viewerPdfDoc.numPages}` : 'No se pudo mostrar esta página. Toca ‹ o › para reintentar.';
}

function jumpToPage(page){
  if (!currentDocUrl) return;
  activateTab('cuadrante');
  $$('#viewToggle .vt-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'original'));
  $('#digitalView').hidden = true;
  $('#cuadranteViewer').hidden = false; // visible ANTES de renderizar (ver nota en gotoViewerPage)
  if (currentDocMime === 'application/pdf') gotoViewerPage(page);
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
      const resumen = [
        a.discursante && 'Discurso: ' + a.discursante,
        a.presidente && 'Presidente: ' + a.presidente,
        a.lectorAtalaya && 'Lector: ' + a.lectorAtalaya,
        a.oracionConclusion && 'Oración: ' + a.oracionConclusion,
      ].filter(Boolean).join(' · ');
      const acts = assignmentActions({ _key: k, tipo, fecha: a.fecha, hora: '', categoria: 'Reunión pública', nombreTexto: resumen });
      if (a.asamblea) {
        return `<div class="digital-week"><h3>${escapeHtml(a.fecha)}${acts}</h3>
          <p class="empty-note">Asamblea — sin reunión pública.</p></div>`;
      }
      const row = (lbl, val) => `<div class="digital-row${rowMatchesSearch(val) ? ' dv-hit' : ''}"><span class="dr-parte">${lbl}</span><span class="dr-nombre">${highlightName(val || '', searchName)}</span></div>`;
      return `
        <div class="digital-week${rowMatchesSearch([a.discursante, a.presidente, a.lectorAtalaya, a.oracionConclusion]) ? ' dv-hit-week' : ''}">
          <h3>${escapeHtml(a.fecha)}${acts}</h3>
          ${row('Discurso', a.discursante)}
          ${a.tema ? `<div class="digital-row"><span class="dr-parte">Tema</span><span class="dr-nombre">${escapeHtml(a.tema)}</span></div>` : ''}
          ${a.congregacion ? `<div class="digital-row"><span class="dr-parte">Congregación</span><span class="dr-nombre">${escapeHtml(a.congregacion)}</span></div>` : ''}
          ${row('Presidente', a.presidente)}
          ${row('Lector de La Atalaya', a.lectorAtalaya)}
          ${row('Oración de conclusión', a.oracionConclusion)}
        </div>`;
    }).join('');
  } else {
    box.innerHTML = '';
    return;
  }

  wireAssignmentActions(box);
}

function delBtn(key){
  return `<button class="dv-del" title="Ocultar esta asignación" data-hk="${escapeAttr(key)}">✕</button>`;
}

const SECTION_CLASS = {
  'tesoros de la biblia': 'sec-tesoros',
  'seamos mejores maestros': 'sec-maestros',
  'nuestra vida cristiana': 'sec-vida',
  'vivamos como cristianos': 'sec-vida',
};

function rowMatchesSearch(names){
  if (!searchName) return false;
  const t = normalizeText(searchName);
  return (Array.isArray(names) ? names : [names]).some(n => normalizeText(n || '').includes(t));
}

function renderMidweekRows(filas, tipo){
  let html = '';
  let lastSeccion; // undefined ≠ null: fuerza a pintar el primer grupo, incluso si es "sin sección"
  filas.forEach(f => {
    if (f.seccion !== lastSeccion) {
      lastSeccion = f.seccion;
      if (f.seccion) {
        const cls = SECTION_CLASS[normalizeKey(f.seccion)] || '';
        html += `<div class="dv-section ${cls}">${escapeHtml(f.seccion)}</div>`;
      }
    }
    const cat = categorizeMidweekRow(f);
    const nombresTxt = (f.nombres || []).join(' / ');
    const hit = rowMatchesSearch(f.nombres || []);
    html += `
      <div class="digital-row${hit ? ' dv-hit' : ''}">
        <span class="dr-hora">${f.hora ? escapeHtml(f.hora) : ''}</span>
        <span class="dr-parte"><span class="dr-cat">${escapeHtml(cat)}</span>${escapeHtml(f.parte || '')}</span>
        <span class="dr-nombre">${f.rol ? `<em>${escapeHtml(f.rol)}</em>` : ''}${highlightName(nombresTxt, searchName)}</span>
        ${assignmentActions({ _key: keyOf(f, tipo), tipo, fecha: f.fecha, hora: f.hora, categoria: cat, nombreTexto: nombresTxt })}
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

function findMyAssignments(historial, name, scopeIds){
  if (!historial || !name) return [];
  const target = normalizeText(name);
  const scoped = Array.isArray(scopeIds) && scopeIds.length > 0;
  const out = [];

  historial.forEach(a => {
    if (scoped && a._src && !scopeIds.includes(a._src)) return;
    const k = assignmentKey(a);
    if (hiddenKeys.has(k)) return;
    if (a.tipo === 'entre-semana') {
      const nombres = a.nombres || [];
      if (nombres.some(n => normalizeText(n).includes(target))) {
        out.push({ _key: k, tipo: 'entre-semana', fecha: a.fecha, hora: a.hora || '', categoria: categorizeMidweekRow(a), nombreTexto: nombres.join(' / '), _src: a._src });
      }
    } else if (a.tipo === 'publica') {
      if (a.asamblea) return;
      const campos = [
        ['discursante', 'Discurso público'], ['presidente', 'Presidencia'],
        ['lectorAtalaya', 'Lectura de La Atalaya'], ['oracionConclusion', 'Oración de conclusión'],
      ];
      campos.forEach(([key, label]) => {
        if (a[key] && normalizeText(a[key]).includes(target)) {
          out.push({ _key: k, tipo: 'publica', fecha: a.fecha, hora: '', categoria: label, nombreTexto: a[key], _src: a._src });
        }
      });
    }
  });
  return out;
}

function nmCard(m, name){
  return `<li class="${isSavedKey(m._key) ? 'nm-saved' : ''}${isHiddenKey(m._key) ? ' nm-hidden' : ''}">
    <div class="nm-top">
      <span class="nm-fecha">${escapeHtml(m.categoria)}</span>
      <span class="nm-pagesmall">${escapeHtml(m.fecha)}${m.hora ? ' · ' + escapeHtml(m.hora) : ''}</span>
    </div>
    <div class="nm-detalle">${highlightName(m.nombreTexto, name)}</div>
    ${assignmentActions({ ...m, tipo: m.tipo || (currentParsed && currentParsed.tipo) })}
  </li>`;
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
    <p class="nm-status">Esto es lo que tienes (✓ y ✕ para guardar o descartar):</p>
    <ul class="nm-cards">${matches.map(m => nmCard(m, name)).join('')}</ul>`;
  wireAssignmentActions(box);
}

/* Búsqueda de asignaciones por nombre en el CUADRANTE ACTUAL. */
/* ---------- Buscar asignación por nombre (pestaña Asignaciones), en el
   historial completo, limitado a los cuadrantes que el usuario elija ---------- */
{
  const si = document.getElementById('searchNameInput');
  if (si) {
    let _t;
    si.addEventListener('input', () => { clearTimeout(_t); _t = setTimeout(renderSearchMatches, 220); });
  }
  const sb = document.getElementById('scopePickerBtn');
  if (sb) sb.addEventListener('click', openScopePicker);
}

function cuadranteLabel(c){
  const tl = tipoLabel(c.tipo);
  const ml = mesesLabel(c.meses);
  return (c.nombre ? c.nombre + ' · ' : '') + tl + (ml ? ' · ' + ml : '');
}
function scopeSummaryLabel(){
  const ids = appConfig.searchScope || [];
  if (!ids.length) return 'Todos los cuadrantes';
  if (ids.length === 1) {
    const c = cuadrantesIdx.find(x => x.id === ids[0]);
    return c ? cuadranteLabel(c) : '1 cuadrante';
  }
  return `${ids.length} cuadrantes seleccionados`;
}
function updateScopeLabel(){
  const el = document.getElementById('scopePickerLabel');
  if (el) el.textContent = scopeSummaryLabel();
}

function openScopePicker(){
  let sel = new Set(appConfig.searchScope || []);
  const allMode = () => sel.size === 0;
  const html = () => `
    <h3>Buscar en…</h3>
    <label class="sc-row"><input type="checkbox" id="scAll" ${allMode() ? 'checked' : ''}><strong>Todos los cuadrantes</strong></label>
    <div class="sc-list">${cuadrantesIdx.length ? cuadrantesIdx.map(c => `
        <label class="sc-row"><input type="checkbox" data-c="${escapeAttr(c.id)}" ${!allMode() && sel.has(c.id) ? 'checked' : ''}>
          <span>${escapeHtml(cuadranteLabel(c))}</span></label>`).join('')
      : '<p class="empty-note">Aún no hay cuadrantes subidos.</p>'}</div>
    <div class="modal-actions">
      <button class="btn btn-ghost" id="modalCancel">Cancelar</button>
      <button class="btn btn-primary" id="modalOk">Guardar</button>
    </div>`;
  function wire(){
    $('#scAll').addEventListener('change', (e) => { if (e.target.checked) sel.clear(); renderModal(html()); wire(); });
    $$('#modalRoot .sc-list [data-c]').forEach(cb => cb.addEventListener('change', () => {
      if (cb.checked) sel.add(cb.dataset.c); else sel.delete(cb.dataset.c);
      renderModal(html()); wire();
    }));
    $('#modalCancel').addEventListener('click', closeModal);
    $('#modalOk').addEventListener('click', async () => {
      appConfig.searchScope = [...sel];
      closeModal();
      try { await persistConfig(); } catch (e) { /* no crítico */ }
      updateScopeLabel();
      renderSearchMatches();
    });
  }
  renderModal(html());
  wire();
}

function renderSearchMatches(){
  const box = document.getElementById('searchMatches');
  const inp = document.getElementById('searchNameInput');
  if (!box || !inp) return;
  const name = inp.value.trim();
  if (!name) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  const scope = appConfig.searchScope || [];
  const scoped = scope.length > 0;
  const matches = findMyAssignments(currentHistorial, name, scope);
  box.innerHTML = matches.length
    ? `<p class="nm-status">${matches.length} coincidencia${matches.length === 1 ? '' : 's'} para «${escapeHtml(name)}»${scoped ? ' en los cuadrantes seleccionados' : ''}:</p>
       <ul class="nm-cards">${matches.map(m => nmCard(m, name)).join('')}</ul>`
    : `<p class="nm-status">Sin coincidencias para «${escapeHtml(name)}»${scoped ? ' en los cuadrantes seleccionados' : ''}.</p>`;
  wireAssignmentActions(box);
}

/* =========================================================
   Asignaciones aprobadas (savedList) — lista con crear / editar / borrar
   ========================================================= */
function savedIsoOf(s){
  if (!s || !s.fecha) return '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s.fecha) ? s.fecha : (assignmentDateISO(s.fecha) || '');
}

function renderAsignaciones(){
  const box = document.getElementById('asignacionesList');
  if (!box) return;
  if (!savedList.length) {
    box.innerHTML = '<p class="empty-note">Aún no hay asignaciones aprobadas. Ve a <strong>Cuadrante</strong>, búscate por nombre y pulsa ✓ — o crea una con «+ Nueva».</p>';
    return;
  }
  const rows = savedList
    .map((s, i) => ({ s, i, iso: savedIsoOf(s) || '9999-99-99' }))
    .sort((a, b) => a.iso.localeCompare(b.iso) || (a.s.hora || '').localeCompare(b.s.hora || ''));
  const today = todayISO();
  box.innerHTML = rows.map(({ s, i, iso }) => {
    const fL = iso !== '9999-99-99'
      ? new Date(iso + 'T00:00').toLocaleDateString('es-ES', { weekday: 'short', day: '2-digit', month: 'short' })
      : 'sin fecha';
    const past = iso !== '9999-99-99' && iso < today;
    return `<div class="asg-item${past ? ' asg-past' : ''}">
      <div class="asg-body">
        <div class="asg-line1">
          <span class="asg-cat">${escapeHtml(s.categoria || 'Asignación')}</span>
          ${s.tipo ? `<span class="asg-tipo ${s.tipo === 'entre-semana' ? 'is-es' : 'is-fs'}">${escapeHtml(tipoLabel(s.tipo))}</span>` : ''}
        </div>
        <div class="asg-meta">
          <span class="asg-date">${escapeHtml(fL)}${s.hora ? ' · ' + escapeHtml(s.hora) : ''}</span>
          ${s.nombreTexto ? `<span class="asg-nom">${escapeHtml(s.nombreTexto)}</span>` : ''}
        </div>
        ${s.notes ? `<div class="asg-notes">${escapeHtml(s.notes)}</div>` : ''}
      </div>
      <span class="ev-actions">
        <button class="icon-btn" title="Editar" data-edit-a="${i}">✎</button>
        <button class="icon-btn" title="Eliminar" data-del-a="${i}">✕</button>
      </span>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-edit-a]').forEach(b => b.addEventListener('click', () => openAsignacionModal(+b.dataset.editA)));
  box.querySelectorAll('[data-del-a]').forEach(b => b.addEventListener('click', () => deleteAsignacion(+b.dataset.delA)));
}

document.getElementById('addAsignacionBtn').addEventListener('click', () => openAsignacionModal());

function openAsignacionModal(i){
  const s = (typeof i === 'number' && i >= 0) ? savedList[i] : null;
  const iso = s ? savedIsoOf(s) : '';
  const hh = s && s.hora && /^\d{1,2}:\d{2}$/.test(s.hora) ? s.hora.replace(/^(\d):/, '0$1:') : '';
  renderModal(`
    <h3>${s ? 'Editar asignación' : 'Nueva asignación'}</h3>
    <div class="field"><label>Qué es</label><input id="aCat" value="${s ? escapeAttr(s.categoria || '') : ''}" placeholder="Lectura de la Biblia, Discurso público…"></div>
    <div class="field" style="flex-direction:row; gap:10px;">
      <div style="flex:1; display:flex; flex-direction:column; gap:5px;"><label>Fecha</label><input id="aDate" type="date" value="${iso}"></div>
      <div style="flex:1; display:flex; flex-direction:column; gap:5px;"><label>Hora</label><input id="aTime" type="time" value="${hh}"></div>
    </div>
    <div class="field"><label>Reunión</label>
      <select id="aTipo">
        <option value=""${!s || !s.tipo ? ' selected' : ''}>—</option>
        <option value="entre-semana"${s && s.tipo === 'entre-semana' ? ' selected' : ''}>Entre semana</option>
        <option value="publica"${s && s.tipo === 'publica' ? ' selected' : ''}>Fin de semana</option>
      </select>
    </div>
    <div class="field"><label>Persona(s)</label><input id="aNom" value="${s ? escapeAttr(s.nombreTexto || '') : ''}" placeholder="nombre"></div>
    <div class="field"><label>Notas</label><textarea id="aNotes">${s ? escapeHtml(s.notes || '') : ''}</textarea></div>
    <div class="modal-actions">
      ${s ? '<button class="btn btn-ghost" id="modalDelete" style="color:#B4432D;">Eliminar</button>' : ''}
      <button class="btn btn-ghost" id="modalCancel">Cancelar</button>
      <button class="btn btn-primary" id="modalSave">Guardar</button>
    </div>`);
  $('#modalCancel').addEventListener('click', closeModal);
  if (s) $('#modalDelete').addEventListener('click', () => { deleteAsignacion(i); closeModal(); });
  $('#modalSave').addEventListener('click', async () => {
    const cat = $('#aCat').value.trim();
    if (!cat) { showError('Indica qué es la asignación.'); return; }
    const data = {
      key: s ? s.key : 'man_' + Math.random().toString(36).slice(2, 9),
      tipo: $('#aTipo').value || null,
      fecha: $('#aDate').value || '',
      hora: $('#aTime').value || '',
      categoria: cat,
      nombreTexto: $('#aNom').value.trim(),
      notes: $('#aNotes').value.trim(),
      manual: s ? (s.manual || /^man_/.test(s.key)) : true,
    };
    if (s) savedList[i] = { ...s, ...data }; else savedList.push(data);
    closeModal();
    showSand('Guardando en Drive…');
    try { await persistGuardadas(); } catch (e) { showError('No se pudo guardar.'); } finally { hideSand(); }
    renderAsignaciones();
    await syncMyAssignmentsToCalendar();
    renderDashboard();
  });
}

async function deleteAsignacion(i){
  if (i < 0 || i >= savedList.length) return;
  savedList.splice(i, 1);
  showSand('Guardando…');
  try { await persistGuardadas(); } catch (e) { showError('No se pudo guardar.'); } finally { hideSand(); }
  refreshAssignmentsUI();
  await syncMyAssignmentsToCalendar();
  renderDashboard();
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

/* =========================================================
   Eventos recurrentes: 'none' | 'diario' | 'semanal' | 'mensual', con
   'recurUntil' opcional. Los no recurrentes solo "ocupan" `date`.
   ========================================================= */
function isoOfDate(d){
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function stepOccurrence(d, recur){
  if (recur === 'mensual') d.setMonth(d.getMonth() + 1);
  else if (recur === 'semanal') d.setDate(d.getDate() + 7);
  else d.setDate(d.getDate() + 1); // 'diario'
}
/* Próxima ocurrencia de `ev` en fromISO o después (null si ya no quedan). */
function nextOccurrenceISO(ev, fromISO){
  if (!ev.recur || ev.recur === 'none') return ev.date >= fromISO ? ev.date : null;
  if (ev.date >= fromISO) return ev.date;
  const until = ev.recurUntil || null;
  let d = new Date(ev.date + 'T00:00');
  const from = new Date(fromISO + 'T00:00');
  let guard = 0;
  while (d < from && guard++ < 3000) {
    stepOccurrence(d, ev.recur);
    if (until && isoOfDate(d) > until) return null;
  }
  const iso = isoOfDate(d);
  if (until && iso > until) return null;
  return iso;
}
/* Todas las ocurrencias de `ev` dentro de [fromISO, toISO] (tope 300, por seguridad). */
function occurrencesInRange(ev, fromISO, toISO){
  const out = [];
  let cur = nextOccurrenceISO(ev, fromISO);
  let guard = 0;
  while (cur && cur <= toISO && guard++ < 300) {
    out.push(cur);
    if (!ev.recur || ev.recur === 'none') break;
    const d = new Date(cur + 'T00:00');
    stepOccurrence(d, ev.recur);
    const iso = isoOfDate(d);
    if (ev.recurUntil && iso > ev.recurUntil) break;
    cur = iso;
  }
  return out;
}
const RECUR_LABELS = { diario: 'Cada día', semanal: 'Cada semana', mensual: 'Cada mes' };

function eventsOn(dateStr){ return events.filter(e => occurrencesInRange(e, dateStr, dateStr).length > 0); }

/* ---------- Volcado automático de "mis asignaciones" al calendario ---------- */
const MONTHS_ES = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

/* Convierte la fecha de una asignación a ISO (YYYY-MM-DD).
   Entre semana: "2026/10/14"   ·   Pública: "06 SEPTIEMBRE 2026" */
function assignmentDateISO(fecha){
  if (!fecha) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return fecha; // ya viene en ISO (asignaciones manuales)
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

  const addAuto = (m) => {
    const date = assignmentDateISO(m.fecha);
    if (!date) return;
    const id = 'auto_' + hashStr(`${m._key || m.key}|${m.categoria}|${date}`);
    if (autos.some(e => e.id === id)) return;
    const time = /^\d{1,2}:\d{2}$/.test(m.hora || '') ? m.hora.replace(/^(\d):/, '0$1:') : '';
    autos.push({ id, auto: true, srcKey: m._key || m.key, title: m.categoria, date, time, notes: m.nombreTexto || '', remind: false });
  };

  // 1) asignaciones que coinciden con "Mi nombre"
  if (name) findMyAssignments(currentHistorial, name).forEach(addAuto);
  // 2) asignaciones guardadas a mano (✓), de cualquier nombre
  savedList.forEach(s => { if (!hiddenKeys.has(s.key)) addAuto(s); });

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
  scheduleGCalSync();
  scheduleLocalNotifs();
}

/* =========================================================
   Sincronización con Google Calendar (calendario "Agenda JW")
   Cada evento/tarea/asignación con fecha se refleja como evento de Google
   con recordatorios (popup), así los avisos suenan aunque la app esté cerrada.
   ========================================================= */
function alertMins(){
  const a = appConfig.alertMins;
  return Array.isArray(a) && a.length ? a : [60, 10];
}

async function calFetch(url, opts = {}){
  const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Calendar API ${res.status}: ${t}`); }
  return res.status === 204 ? null : res.json();
}

async function ensureGCal(){
  if (appConfig.gcalId) return appConfig.gcalId;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Madrid';
  const list = await calFetch('https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=owner&maxResults=250');
  const found = (list.items || []).find(c => c.summary === 'Agenda JW');
  let id;
  if (found) id = found.id;
  else {
    const created = await calFetch('https://www.googleapis.com/calendar/v3/calendars', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: 'Agenda JW', description: 'Sincronizado desde la app Agenda JW', timeZone: tz }),
    });
    id = created.id;
    try {
      await calFetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, colorId: '5' }),
      });
    } catch (e) { /* no crítico */ }
  }
  appConfig.gcalId = id;
  try { await persistConfig(); } catch (e) {}
  return id;
}

/* Lista de "eventos deseados" en la ventana de sincronización (hoy .. +120 días). */
function gcalDesired(){
  const today = todayISO();
  const end = new Date(); end.setDate(end.getDate() + 120);
  const endISO = end.toISOString().slice(0, 10);
  const inWin = (d) => d && d >= today && d <= endISO;
  const out = [];
  events.forEach(e => {
    const occ = (e.recur && e.recur !== 'none') ? nextOccurrenceISO(e, today) : e.date;
    if (!inWin(occ)) return;
    out.push({
      hgKey: 'ev:' + e.id,
      summary: (e.kind === 'reunion' ? '📅 ' : e.auto ? '📌 ' : '🗓 ') + e.title + (e.recur && e.recur !== 'none' ? ' ↻' : ''),
      date: occ, time: e.time || '', description: e.notes || '', mins: itemAlertMins(e),
    });
  });
  tareas.forEach(t => {
    if (t.done || !inWin(t.due)) return;
    out.push({
      hgKey: 'tk:' + t.id,
      summary: '✅ ' + t.title,
      date: t.due, time: t.time || '',
      description: (t.project ? `Proyecto: ${t.project}\n` : '') + (t.notes || ''), mins: itemAlertMins(t),
    });
  });
  return out;
}

function gcalBody(it, tz){
  const body = {
    summary: it.summary,
    description: it.description || '',
    extendedProperties: { private: { hgKey: it.hgKey, hgManaged: '1' } },
    reminders: { useDefault: false, overrides: (it.mins || alertMins()).map(m => ({ method: 'popup', minutes: m })) },
  };
  if (/^\d{2}:\d{2}$/.test(it.time || '')) {
    const [h, mn] = it.time.split(':').map(Number);
    const e = h * 60 + mn + 60;
    body.start = { dateTime: `${it.date}T${it.time}:00`, timeZone: tz };
    body.end = { dateTime: `${it.date}T${String(Math.floor(e / 60) % 24).padStart(2, '0')}:${String(e % 60).padStart(2, '0')}:00`, timeZone: tz };
  } else {
    body.start = { date: it.date };
    const d = new Date(it.date + 'T12:00:00'); d.setDate(d.getDate() + 1); // T12 evita el salto de zona horaria
    body.end = { date: d.toISOString().slice(0, 10) };
  }
  return body;
}

let gcalBusy = false, gcalTimer = null;
function scheduleGCalSync(){
  if (!appConfig.gcalOn) return;
  clearTimeout(gcalTimer);
  gcalTimer = setTimeout(() => { syncToGoogleCalendar(); }, 1800);
}

async function syncToGoogleCalendar(silent = true){
  if (!appConfig.gcalOn || !accessToken || gcalBusy) return;
  gcalBusy = true;
  if (!silent) showSand('Sincronizando con Google Calendar…');
  try {
    const calId = await ensureGCal();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Madrid';
    const timeMin = new Date(); timeMin.setHours(0, 0, 0, 0);
    const timeMax = new Date(); timeMax.setDate(timeMax.getDate() + 121);

    let existing = [], pageToken;
    do {
      const u = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`);
      u.searchParams.set('timeMin', timeMin.toISOString());
      u.searchParams.set('timeMax', timeMax.toISOString());
      u.searchParams.set('showDeleted', 'false');
      u.searchParams.set('singleEvents', 'true');
      u.searchParams.set('maxResults', '250');
      if (pageToken) u.searchParams.set('pageToken', pageToken);
      const page = await calFetch(u.toString());
      existing = existing.concat(page.items || []);
      pageToken = page.nextPageToken;
    } while (pageToken);

    const byKey = new Map();
    existing.forEach(ev => { const k = ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private.hgKey; if (k) byKey.set(k, ev); });

    const desired = gcalDesired();
    const desiredKeys = new Set(desired.map(d => d.hgKey));
    const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`;

    for (const it of desired) {
      const body = gcalBody(it, tz);
      const ex = byKey.get(it.hgKey);
      if (!ex) {
        await calFetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      } else {
        const exStart = (ex.start && (ex.start.dateTime || ex.start.date)) || '';
        const wantStart = body.start.dateTime || body.start.date;
        if (ex.summary !== body.summary || !exStart.startsWith(wantStart.slice(0, 16)) || (ex.description || '') !== body.description) {
          await calFetch(`${base}/${ex.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        }
      }
    }
    for (const ev of existing) {
      const k = ev.extendedProperties && ev.extendedProperties.private && ev.extendedProperties.private.hgKey;
      if (k && !desiredKeys.has(k)) { try { await calFetch(`${base}/${ev.id}`, { method: 'DELETE' }); } catch (e) {} }
    }
    if (!silent) showError('Google Calendar actualizado ✓');
  } catch (err) {
    console.error(err);
    if (/Calendar API 40[13]/.test(err.message || '')) reauthDrive();
    else if (!silent) showError('No se pudo sincronizar con Google Calendar.');
  } finally { gcalBusy = false; if (!silent) hideSand(); }
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
    const nEv = dateStr ? eventsOn(dateStr).length : 0;
    const nTk = dateStr ? tasksOn(dateStr).length : 0;
    if (nEv || nTk) cell.classList.add('has-event');
    const dots = (nEv ? '<span class="dot"></span>' : '') + (nTk ? '<span class="dot dot-task"></span>' : '');
    cell.innerHTML = `<span class="num">${c.day}</span>${dots}`;
    if (dateStr) cell.addEventListener('click', () => openDayModal(dateStr));
    grid.appendChild(cell);
  });
}

/* Tareas pendientes con fecha en un día concreto (YYYY-MM-DD). */
function tasksOn(iso){ return tareas.filter(t => !t.done && t.due === iso); }

/* ---------- Ajustes de calendario / avisos ---------- */
const ALERT_PRESETS = [
  { v: [15], t: '15 min antes' },
  { v: [60, 10], t: '1 h y 10 min antes' },
  { v: [1440, 60], t: '1 día y 1 h antes' },
  { v: [2880, 1440, 120], t: '2 días, 1 día y 2 h antes' },
];
/* Select de aviso reutilizado en eventos/tareas: vacío = usar el predeterminado. */
function remindSelectHtml(id, current){
  const cur = Array.isArray(current) && current.length ? JSON.stringify(current) : '';
  return `<select id="${id}"><option value="">Usar el predeterminado</option>${ALERT_PRESETS.map(p =>
    `<option value='${JSON.stringify(p.v)}' ${JSON.stringify(p.v) === cur ? 'selected' : ''}>${p.t}</option>`).join('')}</select>`;
}
function readRemindSelect(id){
  const el = document.getElementById(id);
  if (!el || !el.value) return undefined;
  try { return JSON.parse(el.value); } catch (e) { return undefined; }
}
function renderCalSettings(){
  const box = document.getElementById('calSettings');
  if (!box) return;
  const notifState = ('Notification' in window) ? Notification.permission : 'unsupported';
  const cur = JSON.stringify(alertMins());
  box.innerHTML = `
    <label class="cs-row">
      <input type="checkbox" id="csGcal" ${appConfig.gcalOn ? 'checked' : ''}>
      <span>Sincronizar con Google Calendar${appConfig.gcalOn ? ' (calendario «Agenda JW»)' : ''}</span>
    </label>
    <div class="cs-row">
      <span>Avisos:</span>
      <select id="csLead">${ALERT_PRESETS.map(p => `<option value='${JSON.stringify(p.v)}' ${JSON.stringify(p.v) === cur ? 'selected' : ''}>${p.t}</option>`).join('')}</select>
      ${appConfig.gcalOn ? '<button class="btn btn-ghost" id="csNow">Sincronizar ahora</button>' : ''}
    </div>
    ${notifState === 'granted'
      ? '<p class="cs-hint">🔔 Alertas del navegador activadas (mientras la app esté abierta).</p>'
      : notifState === 'denied'
        ? '<p class="cs-hint">🔕 Alertas del navegador bloqueadas en los ajustes del navegador.</p>'
        : notifState === 'unsupported' ? ''
          : '<button class="btn btn-ghost" id="csNotif">🔔 Activar alertas del navegador</button>'}
    <p class="cs-hint">Con Google Calendar los avisos suenan también con la app cerrada, en todos tus dispositivos.</p>`;

  const gc = box.querySelector('#csGcal');
  gc && gc.addEventListener('change', async () => {
    appConfig.gcalOn = gc.checked;
    try { await persistConfig(); } catch (e) {}
    renderCalSettings();
    if (appConfig.gcalOn) syncToGoogleCalendar(false);
  });
  const lead = box.querySelector('#csLead');
  lead && lead.addEventListener('change', async () => {
    try { appConfig.alertMins = JSON.parse(lead.value); } catch (e) { appConfig.alertMins = [60, 10]; }
    try { await persistConfig(); } catch (e) {}
    notifiedIds.clear(); localStorage.setItem('hg_notified', '[]');
    scheduleGCalSync(); scheduleLocalNotifs();
  });
  const now = box.querySelector('#csNow');
  now && now.addEventListener('click', () => syncToGoogleCalendar(false));
  const nb = box.querySelector('#csNotif');
  nb && nb.addEventListener('click', askNotifPermission);
}

$('#prevMonth').addEventListener('click', () => { calMonth.setMonth(calMonth.getMonth() - 1); renderCalendar(); });
$('#nextMonth').addEventListener('click', () => { calMonth.setMonth(calMonth.getMonth() + 1); renderCalendar(); });
$('#addEventBtn').addEventListener('click', () => openEventModal());

function renderUpcoming(){
  const list = $('#upcomingList');
  const today = new Date().toISOString().slice(0, 10);

  const items = events
    .map(e => ({ e, occ: nextOccurrenceISO(e, today) }))
    .filter(x => x.occ)
    .map(x => ({ t: 'ev', date: x.occ, time: x.e.time || '', ev: x.e }))
    .concat(tareas.filter(t => !t.done && t.due && t.due >= today)
      .map(t => ({ t: 'tk', date: t.due, time: t.time || '', tk: t })))
    .sort((a, b) => (a.date + (a.time || '99:99')).localeCompare(b.date + (b.time || '99:99')))
    .slice(0, 10);

  list.innerHTML = '';
  if (items.length === 0) {
    list.innerHTML = '<li class="empty-note" style="list-style:none;">Nada próximo.</li>';
    renderDashboard();
    return;
  }
  items.forEach(it => {
    const li = document.createElement('li');
    const dateLabel = new Date(`${it.date}T00:00`).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' }) + (it.time ? ` · ${it.time}` : '');
    if (it.t === 'ev') {
      const ev = it.ev;
      if (ev.auto) li.className = 'ev-auto';
      li.innerHTML = `
        <span class="ev-date">${dateLabel}</span>
        <span class="ev-title">${ev.auto ? '📋 ' : ev.kind === 'reunion' ? '📅 ' : ''}${escapeHtml(ev.title)}${ev.recur && ev.recur !== 'none' ? ' <span class=\"ev-recur\" title=\"Recurrente\">↻</span>' : ''}${ev.auto && ev.notes ? ` <em>· ${escapeHtml(ev.notes)}</em>` : ''}</span>
        <span class="ev-actions">
          <button class="icon-btn" title="Descargar .ics" data-ics="${ev.id}">⇩</button>
          ${ev.auto ? '' : `<button class="icon-btn" title="Editar" data-edit="${ev.id}">✎</button>`}
          <button class="icon-btn" title="${ev.auto ? 'Ocultar esta asignación' : 'Eliminar'}" data-del="${ev.id}">✕</button>
        </span>`;
    } else {
      const t = it.tk;
      li.className = 'ev-task';
      li.innerHTML = `
        <span class="ev-date">${dateLabel}</span>
        <span class="ev-title">🗒 ${escapeHtml(t.title)}${t.project ? ` <em>· ${escapeHtml(t.project)}</em>` : ''}</span>
        <span class="ev-actions">
          <button class="icon-btn" title="Marcar hecha" data-tdone="${escapeAttr(t.id)}">✓</button>
          <button class="icon-btn" title="Editar" data-tedit="${escapeAttr(t.id)}">✎</button>
        </span>`;
    }
    list.appendChild(li);
  });

  list.querySelectorAll('[data-ics]').forEach(b => b.addEventListener('click', () => downloadIcs(b.dataset.ics)));
  list.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openEventModal(b.dataset.edit)));
  list.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => deleteEvent(b.dataset.del)));
  list.querySelectorAll('[data-tdone]').forEach(b => b.addEventListener('click', () => toggleTarea(b.dataset.tdone)));
  list.querySelectorAll('[data-tedit]').forEach(b => b.addEventListener('click', () => openTareaModal(b.dataset.tedit)));
  renderDashboard();
}

function openDayModal(dateStr){
  const dayEvents = eventsOn(dateStr);
  const dayTasks = tareas.filter(t => t.due === dateStr);
  const niceDate = new Date(`${dateStr}T00:00`).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  const evRows = dayEvents.map(ev => `
    <div class="parte-row">
      <span>${ev.time ? ev.time + ' · ' : ''}${ev.auto ? '📋 ' : ev.kind === 'reunion' ? '📅 ' : ''}${escapeHtml(ev.title)}</span>
      <span class="ev-actions">
        ${ev.auto ? '' : `<button class="icon-btn" data-edit="${ev.id}">✎</button>`}
        <button class="icon-btn" title="${ev.auto ? 'Ocultar asignación' : 'Eliminar'}" data-del="${ev.id}">✕</button>
      </span>
    </div>`).join('');
  const tkRows = dayTasks.map(t => `
    <div class="parte-row">
      <span>${t.done ? '✔ ' : '🗒 '}${t.time ? escapeHtml(t.time) + ' · ' : ''}<span style="${t.done ? 'text-decoration:line-through;opacity:.6' : ''}">${escapeHtml(t.title)}</span></span>
      <span class="ev-actions">
        <button class="icon-btn" data-ttoggle="${escapeAttr(t.id)}" title="${t.done ? 'Desmarcar' : 'Marcar hecha'}">${t.done ? '↺' : '✓'}</button>
        <button class="icon-btn" data-tedit="${escapeAttr(t.id)}">✎</button>
      </span>
    </div>`).join('');
  const body = (evRows + tkRows) || '<p class="empty-note">Nada este día.</p>';

  renderModal(`
    <h3 style="text-transform:capitalize">${niceDate}</h3>
    ${body}
    <div class="modal-actions">
      <button class="btn btn-ghost" id="modalClose">Cerrar</button>
      <button class="btn btn-ghost" id="modalAddTask">+ Tarea</button>
      <button class="btn btn-primary" id="modalAdd">+ Evento</button>
    </div>
  `);
  $('#modalClose').addEventListener('click', closeModal);
  $('#modalAdd').addEventListener('click', () => openEventModal(null, dateStr));
  $('#modalAddTask').addEventListener('click', () => { closeModal(); openTareaModal(); setTimeout(() => { const el = document.getElementById('tDue'); if (el) el.value = dateStr; }, 60); });
  $$('#modalRoot [data-edit]').forEach(b => b.addEventListener('click', () => openEventModal(b.dataset.edit)));
  $$('#modalRoot [data-del]').forEach(b => b.addEventListener('click', () => { deleteEvent(b.dataset.del); openDayModal(dateStr); }));
  $$('#modalRoot [data-tedit]').forEach(b => b.addEventListener('click', () => { closeModal(); openTareaModal(b.dataset.tedit); }));
  $$('#modalRoot [data-ttoggle]').forEach(b => b.addEventListener('click', async () => { await toggleTarea(b.dataset.ttoggle); openDayModal(dateStr); }));
}

function openEventModal(id, presetDate){
  const existing = id ? events.find(e => e.id === id) : null;
  const recur = existing ? existing.recur || 'none' : 'none';
  renderModal(`
    <h3>${existing ? 'Editar evento' : 'Nuevo evento'}</h3>
    <div class="field"><label>Título</label><input id="fTitle" value="${existing ? escapeAttr(existing.title) : ''}" placeholder="Reunión de entre semana"></div>
    <div class="field"><label>Fecha</label><input id="fDate" type="date" value="${existing ? existing.date : (presetDate || new Date().toISOString().slice(0,10))}"></div>
    <div class="field"><label>Hora (opcional)</label><input id="fTime" type="time" value="${existing ? existing.time || '' : ''}"></div>
    <div class="field" style="flex-direction:row; gap:10px;">
      <div style="flex:1; display:flex; flex-direction:column; gap:5px;"><label>Repetir</label>
        <select id="fRecur">
          <option value="none"${recur === 'none' ? ' selected' : ''}>No se repite</option>
          <option value="diario"${recur === 'diario' ? ' selected' : ''}>Cada día</option>
          <option value="semanal"${recur === 'semanal' ? ' selected' : ''}>Cada semana</option>
          <option value="mensual"${recur === 'mensual' ? ' selected' : ''}>Cada mes</option>
        </select>
      </div>
      <div id="fRecurUntilWrap" style="flex:1; display:flex; flex-direction:column; gap:5px; ${recur === 'none' ? 'visibility:hidden;' : ''}">
        <label>Hasta (opcional)</label><input id="fRecurUntil" type="date" value="${existing ? existing.recurUntil || '' : ''}">
      </div>
    </div>
    <div class="field"><label>Aviso</label>${remindSelectHtml('fRemindMins', existing ? existing.remindMins : null)}</div>
    <div class="field"><label>Notas</label><textarea id="fNotes">${existing ? escapeHtml(existing.notes || '') : ''}</textarea></div>
    <div class="field" style="flex-direction:row; align-items:center; gap:8px;">
      <input type="checkbox" id="fReunion" ${existing && existing.kind === 'reunion' ? 'checked' : ''} style="width:auto;">
      <label style="margin:0;">Es una reunión especial (aparece en Inicio)</label>
    </div>
    <div class="field" style="flex-direction:row; align-items:center; gap:8px;">
      <input type="checkbox" id="fRemind" ${existing && existing.remind === false ? '' : 'checked'} style="width:auto;">
      <label style="margin:0;">Avisarme (notificación de la app, con hora puesta)</label>
    </div>
    <div class="modal-actions">
      ${existing ? '<button class="btn btn-ghost" id="modalDelete" style="color:#B4432D;">Eliminar</button>' : ''}
      <button class="btn btn-ghost" id="modalCancel">Cancelar</button>
      <button class="btn btn-primary" id="modalSave">Guardar</button>
    </div>
  `);
  $('#fRecur').addEventListener('change', () => {
    $('#fRecurUntilWrap').style.visibility = $('#fRecur').value === 'none' ? 'hidden' : 'visible';
  });
  $('#modalCancel').addEventListener('click', closeModal);
  if (existing) $('#modalDelete').addEventListener('click', () => { deleteEvent(existing.id); closeModal(); });
  $('#modalSave').addEventListener('click', async () => {
    const title = $('#fTitle').value.trim();
    const date = $('#fDate').value;
    if (!title || !date) { showError('Falta título o fecha.'); return; }
    const recurVal = $('#fRecur').value;
    const data = {
      id: existing ? existing.id : 'e_' + Date.now(),
      title, date,
      time: $('#fTime').value,
      notes: $('#fNotes').value.trim(),
      remind: $('#fRemind').checked,
      kind: $('#fReunion').checked ? 'reunion' : 'evento',
      recur: recurVal === 'none' ? undefined : recurVal,
      recurUntil: recurVal === 'none' ? undefined : ($('#fRecurUntil').value || undefined),
      remindMins: readRemindSelect('fRemindMins'),
    };
    if (existing) { delete existing.recur; delete existing.recurUntil; delete existing.remindMins; Object.assign(existing, data); }
    else events.push(data);
    closeModal();
    showSand('Guardando en Drive…');
    try { await persistEvents(); renderCalendar(); renderUpcoming(); scheduleGCalSync(); scheduleLocalNotifs(); }
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

/* Todos los avisos con fecha+hora futura: eventos (salvo remind:false, incluidas
   sus próximas ocurrencias si son recurrentes), tareas pendientes y asignaciones
   aprobadas. Cada uno lleva su `mins` (aviso propio, o el predeterminado). */
function itemAlertMins(item){
  return (item && Array.isArray(item.remindMins) && item.remindMins.length) ? item.remindMins : alertMins();
}
function upcomingAlerts(){
  const out = [];
  const today = todayISO();
  const horizon = new Date(); horizon.setDate(horizon.getDate() + 45);
  const horizonISO = isoOfDate(horizon);
  events.forEach(e => {
    if (e.remind === false || !/^\d{2}:\d{2}$/.test(e.time || '')) return;
    const dates = (e.recur && e.recur !== 'none') ? occurrencesInRange(e, today, horizonISO) : [nextOccurrenceISO(e, today)].filter(Boolean);
    dates.forEach(d => out.push({
      id: 'ev:' + e.id + (dates.length > 1 ? ':' + d : ''), date: d, time: e.time,
      title: (e.kind === 'reunion' ? '📅 ' : '') + e.title, mins: itemAlertMins(e),
    }));
  });
  tareas.forEach(t => { if (!t.done && t.due && /^\d{2}:\d{2}$/.test(t.time || '')) out.push({ id: 'tk:' + t.id, date: t.due, time: t.time, title: '✅ ' + t.title, mins: itemAlertMins(t) }); });
  savedList.forEach(s => { const d = savedIsoOf(s); if (d && /^\d{1,2}:\d{2}$/.test(s.hora || '')) out.push({ id: 'as:' + s.key, date: d, time: s.hora.replace(/^(\d):/, '0$1:'), title: '📌 ' + s.categoria, mins: alertMins() }); });
  return out;
}

function checkReminders(){
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const now = new Date();
  upcomingAlerts().forEach(a => {
    if (notifiedIds.has(a.id)) return;
    const lead = Math.max(30, ...a.mins);
    const diffMin = (new Date(`${a.date}T${a.time}`) - now) / 60000;
    if (diffMin > 0 && diffMin <= lead) {
      notifiedIds.add(a.id);
      localStorage.setItem('hg_notified', JSON.stringify([...notifiedIds].slice(-300)));
      notify(a.title, `A las ${a.time}${diffMin > 60 ? ' (en ' + Math.round(diffMin / 60) + ' h)' : ''}`);
    }
  });
}

function notify(title, body){
  try {
    if (Notification.permission === 'granted') new Notification(title, { body, icon: 'icon-192.png', tag: title });
  } catch (e) { /* algunos navegadores exigen SW para Notification */ }
}

async function askNotifPermission(){
  if (!('Notification' in window)) { showError('Este navegador no admite notificaciones.'); return; }
  const p = await Notification.requestPermission();
  if (p === 'granted') { notify('Alertas activadas', 'Te avisaré de tus asignaciones y tareas.'); checkReminders(); }
  renderCalSettings();
}

/* Notificaciones NATIVAS del móvil (Capacitor) — suenan con la app cerrada.
   En web es un no-op; en la APK usa @capacitor/local-notifications. */
async function scheduleLocalNotifs(){
  const LN = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications;
  if (!LN) return;
  try {
    const perm = await LN.checkPermissions();
    if (perm.display !== 'granted') { const r = await LN.requestPermissions(); if (r.display !== 'granted') return; }
    const pend = await LN.getPending();
    if (pend.notifications && pend.notifications.length) await LN.cancel({ notifications: pend.notifications.map(n => ({ id: n.id })) });
    const now = Date.now();
    const toSchedule = [];
    upcomingAlerts().forEach(a => {
      const at = new Date(`${a.date}T${a.time}`).getTime();
      a.mins.forEach(lead => {
        const when = at - lead * 60000;
        if (when > now + 5000) {
          toSchedule.push({
            id: (hashInt(a.id + '|' + lead) % 2000000000),
            title: a.title,
            body: lead >= 60 ? `En ${Math.round(lead / 60)} h · ${a.time}` : `En ${lead} min · ${a.time}`,
            schedule: { at: new Date(when) },
            smallIcon: 'ic_stat_icon',
          });
        }
      });
    });
    if (toSchedule.length) await LN.schedule({ notifications: toSchedule.slice(0, 480) });
  } catch (e) { console.error('LocalNotifications', e); }
}
function hashInt(s){ let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

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
    .map(p => {
      const pt = tareas.filter(t => t.proyectoId === p.id);
      const ptDone = pt.filter(t => t.done).length;
      return `
      <div class="proyecto-card" data-id="${p.id}">
        <h3>${escapeHtml(p.titulo)}</h3>
        <p class="fecha">${p.fecha ? new Date(p.fecha + 'T00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' }) : ''}</p>
        ${(p.partes || []).map(x => `<div class="parte-row"><span>${escapeHtml(x.titulo)}</span><span class="asignado">${escapeHtml(x.asignado || '')}</span></div>`).join('') || '<p class="empty-note">Sin partes añadidas.</p>'}
        <div class="pr-tasks">
          <div class="pr-tasks-h">Tareas del proyecto${pt.length ? ` <span>${ptDone}/${pt.length}</span>` : ''}</div>
          ${pt.length ? `<div class="pr-bar"><i style="width:${pt.length ? Math.round(ptDone / pt.length * 100) : 0}%"></i></div>` : ''}
          ${pt.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999')).map(t => `
            <label class="pr-task${t.done ? ' done' : ''}">
              <input type="checkbox" data-pt-toggle="${escapeAttr(t.id)}" ${t.done ? 'checked' : ''}>
              <span>${escapeHtml(t.title)}${t.due ? ` · ${new Date(t.due + 'T00:00').toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })}` : ''}</span>
              <button class="icon-btn" data-pt-edit="${escapeAttr(t.id)}">✎</button>
            </label>`).join('')}
          <button class="btn btn-ghost pr-add" data-pt-add="${p.id}" data-pt-name="${escapeAttr(p.titulo)}">+ Tarea</button>
        </div>
        <div class="proyecto-actions">
          <button class="btn btn-ghost" data-edit-p="${p.id}">Editar</button>
          <button class="btn btn-ghost" data-del-p="${p.id}" style="color:#B4432D;">Eliminar</button>
        </div>
      </div>`;
    }).join('');

  wrap.querySelectorAll('[data-edit-p]').forEach(b => b.addEventListener('click', () => openProyectoModal(b.dataset.editP)));
  wrap.querySelectorAll('[data-del-p]').forEach(b => b.addEventListener('click', () => deleteProyecto(b.dataset.delP)));
  wrap.querySelectorAll('[data-pt-toggle]').forEach(c => c.addEventListener('change', () => toggleTarea(c.dataset.ptToggle)));
  wrap.querySelectorAll('[data-pt-edit]').forEach(b => b.addEventListener('click', (e) => { e.preventDefault(); openTareaModal(b.dataset.ptEdit); }));
  wrap.querySelectorAll('[data-pt-add]').forEach(b => b.addEventListener('click', () =>
    openTareaModal(null, { proyectoId: b.dataset.ptAdd, project: b.dataset.ptName })));
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

function tareaItemHtml(t){
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
        ${t.project ? `<span class="tk-tag">${t.proyectoId ? '🗂 ' : '#'}${escapeHtml(t.project)}</span>` : ''}
        ${(t.labels || []).map(l => `<span class="tk-tag tk-lab">@${escapeHtml(l)}</span>`).join('')}
        ${subs.length ? `<span class="tk-sub-count">${subDone}/${subs.length}</span>` : ''}
      </div>
      ${subs.length ? `<div class="tk-subs">${subs.map(s => `
        <label class="tk-subrow${s.done ? ' done' : ''}"><input type="checkbox" data-sub="${escapeAttr(t.id)}|${escapeAttr(s.id)}" ${s.done ? 'checked' : ''}><span>${escapeHtml(s.title)}</span></label>`).join('')}</div>` : ''}
      ${(t.attachments || []).length ? `<div class="tk-att">${t.attachments.map(a =>
        `<button class="tk-att-chip" data-att-id="${escapeAttr(a.id)}" data-att-m="${escapeAttr(a.mimeType || '')}" data-att-l="${escapeAttr(a.webViewLink || '')}" data-att-n="${escapeAttr(a.name)}">📎 ${escapeHtml(a.name)}</button>`).join('')}</div>` : ''}
      ${t.notes ? `<div class="tk-notes">${escapeHtml(t.notes)}</div>` : ''}
    </div>
    <span class="ev-actions">
      <button class="icon-btn" data-edit-t="${escapeAttr(t.id)}">✎</button>
      <button class="icon-btn" data-del-t="${escapeAttr(t.id)}">✕</button>
    </span>
  </div>`;
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
  document.querySelectorAll('#tareasNav .tk-vbtn').forEach(b => b.classList.toggle('active', b.dataset.view === tareasView));
  document.getElementById('addTareaBtn').hidden = tareasView === 'proyectos';
  document.getElementById('addProyectoBtn').hidden = tareasView !== 'proyectos';
  document.getElementById('proyectosList').hidden = tareasView !== 'proyectos';
  list.hidden = tareasView === 'proyectos';
  if (tareasView === 'proyectos') { document.getElementById('tareasFiltros').hidden = true; renderProyectos(); return; }
  renderTareasFiltros();

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

  if (tareasView === 'todas') {
    // agrupado por proyecto / apartado; "Sin proyecto" al final
    const groups = [];
    rows.forEach(t => {
      const key = (t.project || '').trim() || ' ';
      let g = groups.find(x => x.key === key);
      if (!g) { g = { key, name: key === ' ' ? 'Sin proyecto' : key, items: [] }; groups.push(g); }
      g.items.push(t);
    });
    groups.sort((a, b) => (a.key === ' ' ? 1 : b.key === ' ' ? -1 : a.name.localeCompare(b.name)));
    list.innerHTML = groups.map(g => `
      <div class="tk-group">
        <h4 class="tk-group-h">${escapeHtml(g.name)} <span>${g.items.length}</span></h4>
        ${g.items.map(tareaItemHtml).join('')}
      </div>`).join('');
  } else {
    list.innerHTML = rows.map(tareaItemHtml).join('');
  }

  list.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', () => toggleTarea(b.dataset.toggle)));
  list.querySelectorAll('[data-sub]').forEach(c => c.addEventListener('change', () => toggleSubtarea(c.dataset.sub)));
  list.querySelectorAll('[data-edit-t]').forEach(b => b.addEventListener('click', () => openTareaModal(b.dataset.editT)));
  list.querySelectorAll('[data-del-t]').forEach(b => b.addEventListener('click', () => deleteTarea(b.dataset.delT)));
  list.querySelectorAll('[data-att-id]').forEach(b => b.addEventListener('click', () =>
    openDriveFile(b.dataset.attId, b.dataset.attM, b.dataset.attL, b.dataset.attN)));
  renderDashboard();
}

document.querySelectorAll('#tareasNav .tk-vbtn').forEach(b =>
  b.addEventListener('click', () => { tareasView = b.dataset.view; renderTareas(); }));
document.getElementById('addTareaBtn').addEventListener('click', () => openTareaModal());

/* tras tocar tareas: refresca su vista y también el calendario/próximo (las que tienen fecha) */
function refreshTareas(){ renderTareas(); renderCalendar(); renderUpcoming(); renderProyectos(); }

async function toggleTarea(id){
  const t = tareas.find(x => x.id === id);
  if (!t) return;
  t.done = !t.done;
  t.doneAt = t.done ? new Date().toISOString() : null;
  showSand('Guardando…');
  try { await persistTareas(); refreshTareas(); } finally { hideSand(); }
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
  try { await persistTareas(); refreshTareas(); } finally { hideSand(); }
}

function openTareaModal(id, preset){
  const t = id ? tareas.find(x => x.id === id) : null;
  let subs = t ? (t.subtasks || []).map(s => ({ ...s })) : [];
  let attach = t ? (t.attachments || []).map(a => ({ ...a })) : [];
  const proyId = t ? t.proyectoId || null : (preset && preset.proyectoId) || null;
  const projVal = t ? (t.project || '') : (preset && preset.project) || '';

  const subsHtml = () => subs.map((s, i) => `
    <div class="parte-input-row" data-i="${i}">
      <input class="st-title" value="${escapeAttr(s.title)}" placeholder="Subtarea">
      <button class="icon-btn" data-rm-st="${i}">✕</button>
    </div>`).join('');
  const readSubs = () => $$('#stWrap .st-title').map((inp, i) => ({
    id: (subs[i] && subs[i].id) || uid('s_'), title: inp.value, done: subs[i] ? !!subs[i].done : false,
  }));
  const attHtml = () => attach.length
    ? attach.map((a, i) => `<span class="tk-att-chip in-modal">📎 ${escapeHtml(a.name)}<button data-rm-at="${i}" class="rm">✕</button></span>`).join('')
    : '<span class="empty-note" style="padding:0;">Ninguno</span>';

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
      <input id="tProj" list="tProjList" value="${escapeAttr(projVal)}" placeholder="p. ej. Congregación" ${proyId ? 'readonly' : ''}>
      <datalist id="tProjList">${tareaProjects().map(p => `<option value="${escapeAttr(p)}"></option>`).join('')}</datalist>
    </div>
    <div class="field"><label>Etiquetas (separadas por comas)</label>
      <input id="tLabels" value="${t ? escapeAttr((t.labels || []).join(', ')) : ''}" placeholder="urgente, ministerio"></div>
    <div class="field"><label>Aviso (si pones fecha y hora)</label>${remindSelectHtml('tRemindMins', t ? t.remindMins : null)}</div>
    <div class="field"><label>Subtareas</label><div id="stWrap">${subsHtml()}</div>
      <button class="btn btn-ghost" id="addStBtn" style="align-self:flex-start;">+ Añadir subtarea</button></div>
    <div class="field"><label>Documentos de Drive</label>
      <div id="atWrap" class="tk-att">${attHtml()}</div>
      <button class="btn btn-ghost" id="addAtBtn" style="align-self:flex-start;">📎 Adjuntar de Drive</button></div>
    <div class="field"><label>Notas</label><textarea id="tNotes">${t ? escapeHtml(t.notes || '') : ''}</textarea></div>
    <div class="modal-actions">
      ${t ? '<button class="btn btn-ghost" id="modalDelete" style="color:#B4432D;">Eliminar</button>' : ''}
      <button class="btn btn-ghost" id="modalCancel">Cancelar</button>
      <button class="btn btn-primary" id="modalSave">Guardar</button>
    </div>`);

  function bindAt(){
    $$('#atWrap [data-rm-at]').forEach(b => b.addEventListener('click', () => {
      attach.splice(+b.dataset.rmAt, 1); $('#atWrap').innerHTML = attHtml(); bindAt();
    }));
  }
  bindAt();
  $('#addAtBtn').addEventListener('click', async () => {
    const f = await pickDriveFile({ title: 'Adjuntar documento de Drive' });
    if (!f) return;
    if (!attach.some(a => a.id === f.id)) attach.push({ id: f.id, name: f.name, mimeType: f.mimeType, webViewLink: f.webViewLink });
    $('#atWrap').innerHTML = attHtml(); bindAt();
  });

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
      remindMins: readRemindSelect('tRemindMins'),
      priority: parseInt($('#tPrio').value, 10) || 2,
      project: $('#tProj').value.trim(),
      proyectoId: proyId || null,
      labels,
      notes: $('#tNotes').value.trim(),
      subtasks,
      attachments: attach,
      createdAt: t ? t.createdAt || new Date().toISOString() : new Date().toISOString(),
    };
    if (t) Object.assign(t, data); else tareas.push(data);
    closeModal();
    showSand('Guardando en Drive…');
    try { await persistTareas(); refreshTareas(); renderProyectos(); } finally { hideSand(); }
  });
}

/* =========================================================
   Dashboard (pestaña Inicio)
   ========================================================= */
function todayISO(){ return new Date().toISOString().slice(0, 10); }

function renderDashboard(){
  const box = document.getElementById('dashboard');
  if (!box) return;
  const today = todayISO();
  const name = (nameInput.value || '').trim();
  const fD = (iso, opts) => escapeHtml(new Date(iso + 'T00:00').toLocaleDateString('es-ES', opts));

  // Tareas pendientes: primero las que tienen fecha (hoy y futuras), luego sin fecha
  const tPend = tareas.filter(t => !t.done && (!t.due || t.due >= today))
    .sort((a, b) => (a.due ? a.due + (a.time || '99:99') : '9999').localeCompare(b.due ? b.due + (b.time || '99:99') : '9999'));
  const tVencidas = tareas.filter(t => !t.done && t.due && t.due < today).length;

  const mine = findMyAssignments(currentHistorial, name)
    .map(m => ({ ...m, iso: assignmentDateISO(m.fecha) }))
    .filter(m => m.iso && m.iso >= today)
    .sort((a, b) => a.iso.localeCompare(b.iso))
    .slice(0, 6);

  const eventosOcc = events
    .filter(e => !e.auto)
    .map(e => { const occ = nextOccurrenceISO(e, today); return occ ? { ...e, date: occ } : null; })
    .filter(Boolean);
  const reuniones = eventosOcc
    .filter(e => e.kind === 'reunion')
    .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')))
    .slice(0, 5);
  const otrosEventos = eventosOcc
    .filter(e => e.kind !== 'reunion')
    .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')))
    .slice(0, 5);

  const t = ministerioTotals();
  const proxProyecto = proyectos.slice()
    .filter(p => p.fecha && p.fecha >= today)
    .sort((a, b) => a.fecha.localeCompare(b.fecha))[0];

  const card = (title, body, tab) =>
    `<div class="dash-card"${tab ? ` data-goto="${tab}"` : ''}><h3>${title}</h3>${body}</div>`;
  const lines = (arr) => `<ul class="dash-lines">${arr.join('')}</ul>`;

  box.innerHTML =
    card('Tareas',
      tPend.length
        ? lines(tPend.slice(0, 6).map(x => `<li>
            <span class="dl-date">${x.due ? (x.due === today ? 'Hoy' : fD(x.due, { day: '2-digit', month: 'short' })) + (x.time ? ' ' + escapeHtml(x.time) : '') : '—'}</span>
            <span class="dl-main">${escapeHtml(x.title)}</span></li>`))
          + (tVencidas ? `<p class="empty-note">⚠ ${tVencidas} vencida${tVencidas === 1 ? '' : 's'}</p>` : '')
        : `<p class="empty-note">Sin tareas pendientes.${tVencidas ? ` ⚠ ${tVencidas} vencida${tVencidas === 1 ? '' : 's'}.` : ''}</p>`,
      'tareas') +

    card('Mis próximas asignaciones',
      mine.length
        ? lines(mine.map(m => `<li>
            <span class="dl-date">${fD(m.iso, { day: '2-digit', month: 'short' })}${m.hora ? ' ' + escapeHtml(m.hora) : ''}</span>
            <span class="dl-main">${escapeHtml(m.categoria)}</span></li>`))
        : `<p class="empty-note">${name ? 'Nada próximo registrado.' : 'Escribe tu nombre en la pestaña Cuadrante.'}</p>`,
      'cuadrante') +

    card('Reuniones especiales',
      reuniones.length
        ? lines(reuniones.map(e => `<li>
            <span class="dl-date">${fD(e.date, { weekday: 'short', day: '2-digit', month: 'short' })}${e.time ? ' ' + escapeHtml(e.time) : ''}</span>
            <span class="dl-main">${escapeHtml(e.title)}</span></li>`))
        : '<p class="empty-note">Crea una reunión especial en Calendario (marca la casilla).</p>',
      'calendario') +

    card('Próximos eventos',
      otrosEventos.length
        ? lines(otrosEventos.map(e => `<li>
            <span class="dl-date">${fD(e.date, { day: '2-digit', month: 'short' })}${e.time ? ' ' + escapeHtml(e.time) : ''}</span>
            <span class="dl-main">${escapeHtml(e.title)}</span></li>`))
        : '<p class="empty-note">Sin eventos próximos.</p>',
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
      'proyectos');

  box.querySelectorAll('[data-goto]').forEach(el => el.addEventListener('click', () => activateTab(el.dataset.goto)));
  pushWidgetData();
}

function isoOf(d){
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/* Lunes..domingo de la semana que contiene `iso`. */
function weekRangeISO(iso){
  const d = new Date(iso + 'T00:00');
  const off = (d.getDay() + 6) % 7;
  const mon = new Date(d); mon.setDate(d.getDate() - off);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  return { start: isoOf(mon), end: isoOf(sun) };
}

/* Reúne todas mis asignaciones futuras (cuadrante + guardadas a mano), ordenadas. */
function myFutureAssignments(){
  const today = todayISO();
  const name = (nameInput.value || '').trim();
  const pad = h => /^\d{1,2}:\d{2}$/.test(h || '') ? h.replace(/^(\d):/, '0$1:') : '';
  const list = [];
  findMyAssignments(currentHistorial, name).forEach(m => {
    const iso = assignmentDateISO(m.fecha);
    if (iso && iso >= today) list.push({ iso, hora: pad(m.hora), cat: m.categoria });
  });
  savedList.forEach(s => {
    const iso = savedIsoOf(s);
    if (iso && iso >= today) list.push({ iso, hora: pad(s.hora), cat: s.categoria });
  });
  const seen = new Set();
  return list
    .filter(x => { const k = x.iso + '|' + x.cat; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (a.iso + (a.hora || '99:99')).localeCompare(b.iso + (b.hora || '99:99')));
}

/* Envía un resumen a los widgets nativos de Android (no-op en web). */
function pushWidgetData(){
  const WB = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.WidgetBridge;
  if (!WB) return;
  try {
    const today = todayISO();
    const mine = myFutureAssignments();

    // --- Próxima asignación (2×2) ---
    const nx = mine[0];
    const proxima = nx ? {
      cat: nx.cat,
      fecha: new Date(nx.iso + 'T00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'short' }),
      hora: nx.hora || '',
    } : '';

    // --- Hoy (4×2): eventos + tareas de hoy, por hora ---
    const hoy = []
      .concat(eventsOn(today).map(e => ({
        id: 'ev_' + (e.id || hashStr(e.title + e.date)),
        t: e.title, time: e.time || '', kind: 'event',
      })))
      .concat(tareas.filter(t => !t.done && t.due === today).map(t => ({
        id: t.id, t: t.title, time: t.time || '', kind: 'task',
      })))
      .sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'))
      .slice(0, 8);

    // --- Cuadrante de esta semana (4×2): mis partes lunes..domingo ---
    const wk = weekRangeISO(today);
    const semLines = mine
      .filter(m => m.iso >= wk.start && m.iso <= wk.end)
      .map(m => (m.hora ? m.hora + ' · ' : '') + m.cat);
    const semana = semLines.length ? { titulo: 'Esta semana', lineas: semLines.slice(0, 6) } : '';

    // --- Calendario mensual (4×4): mes de hoy ---
    const now = new Date();
    const y = now.getFullYear(), mo = now.getMonth();
    const first = new Date(y, mo, 1);
    const dim = new Date(y, mo + 1, 0).getDate();
    const marks = {};
    for (let d = 1; d <= dim; d++) {
      const iso = `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      let bit = 0;
      if (eventsOn(iso).length) bit |= 1;
      if (tareas.some(t => !t.done && t.due === iso)) bit |= 2;
      if (bit) marks[d] = bit;
    }
    const monEndISO = isoOf(new Date(y, mo + 1, 0));
    const mes = {
      y, m: mo,
      label: first.toLocaleDateString('es-ES', { month: 'long' }) + ' ' + y,
      start: (first.getDay() + 6) % 7,
      days: dim,
      today: now.getDate(),
      marks,
      agenda: agendaItemsInRange(today, monEndISO, 3), // franja de agenda bajo la rejilla
    };

    // --- Modos del widget "Hoy" (se puede alternar hoy/semana/mes/todo tocándolo) ---
    const horizonISO = isoOf(new Date(now.getTime() + 30 * 86400000));
    const agendaModes = {
      hoy,
      semana: agendaItemsInRange(today, wk.end, 20),
      mes: agendaItemsInRange(today, monEndISO, 30),
      todo: agendaItemsInRange(today, horizonISO, 40),
    };

    WB.save({
      w_proxima: JSON.stringify(proxima),
      w_hoy: JSON.stringify(hoy),
      w_semana: JSON.stringify(semana),
      w_mes: JSON.stringify(mes),
      w_agenda_modes: JSON.stringify(agendaModes),
    }).catch(() => {});
  } catch (e) { /* no crítico */ }
}

/* Eventos (con ocurrencias si son recurrentes) + tareas pendientes entre dos
   fechas ISO, para las vistas semana/mes/todo del widget "Hoy" y la agenda
   del widget de mes. Cada item lleva `d` (fecha corta) además de `time`. */
function agendaItemsInRange(fromISO, toISO, cap){
  const shortDate = (iso) => new Date(iso + 'T00:00').toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
  const items = []
    .concat(events.flatMap(e => occurrencesInRange(e, fromISO, toISO).map(d => ({
      id: 'ev_' + (e.id || hashStr(e.title + d)) + '_' + d, t: e.title, time: e.time || '', kind: 'event', _d: d,
    }))))
    .concat(tareas.filter(t => !t.done && t.due && t.due >= fromISO && t.due <= toISO).map(t => ({
      id: t.id, t: t.title, time: t.time || '', kind: 'task', _d: t.due,
    })));
  items.sort((a, b) => (a._d + (a.time || '99:99')).localeCompare(b._d + (b.time || '99:99')));
  return items.slice(0, cap || 40).map(({ _d, ...rest }) => ({ ...rest, d: shortDate(_d) }));
}

/* Aplica las tareas marcadas como hechas desde el widget (se llama al arrancar). */
async function applyWidgetPendingDone(){
  const WB = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.WidgetBridge;
  if (!WB || typeof WB.takePendingDone !== 'function') return;
  let ids = [];
  try { const r = await WB.takePendingDone(); ids = (r && r.ids) || []; }
  catch (e) { return; }
  if (!ids.length) return;
  let changed = false;
  ids.forEach(id => {
    const t = tareas.find(x => x.id === id);
    if (t && !t.done) { t.done = true; t.doneAt = new Date().toISOString(); changed = true; }
  });
  if (changed) { try { await persistTareas(); } catch (e) { /* se reintenta al próximo cambio */ } }
}

/* El widget del mes abre un día concreto (lo llama MainActivity al pulsar una celda). */
window.openDayFromWidget = function(iso){
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return;
  try { activateTab('calendario'); } catch (e) {}
  try {
    const d = new Date(iso + 'T00:00');
    calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    renderCalendar();
    openDayModal(iso);
  } catch (e) {}
};

/* =========================================================
   Explorador de Drive (solo lectura de tus carpetas)
   ========================================================= */
async function loadExplorerFavs(){
  const f = await findFile(CONFIG.EXPLORADOR_NAME, folderId, 'application/json');
  if (!f) { explorerFavs = []; return; }
  try { explorerFavs = (await (await downloadFile(f.id)).json()) || []; }
  catch (e) { explorerFavs = []; }
}
async function persistExplorerFavs(){
  await saveFile(CONFIG.EXPLORADOR_NAME, 'application/json', JSON.stringify(explorerFavs, null, 2), folderId);
}

function reauthDrive(){
  showError('Falta permiso para leer tus carpetas de Drive. Pulsa «Entrar con Google» otra vez y acepta.');
  try { tokenClient.requestAccessToken({ prompt: 'consent' }); } catch (e) {}
}

function fileIcon(mime){
  if (!mime) return '📄';
  if (mime === 'application/vnd.google-apps.folder') return '📁';
  if (mime.startsWith('image/')) return '🖼️';
  if (mime === 'application/pdf') return '📕';
  if (mime.includes('spreadsheet') || mime.includes('excel') || mime.includes('csv')) return '📊';
  if (mime.includes('document') || mime.includes('word')) return '📝';
  if (mime.includes('presentation') || mime.includes('powerpoint')) return '📽️';
  if (mime.startsWith('video/')) return '🎬';
  if (mime.startsWith('audio/')) return '🎵';
  return '📄';
}

async function driveList(id){
  const q = `'${id}' in parents and trashed=false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}`
    + `&fields=${encodeURIComponent('files(id,name,mimeType,modifiedTime,size,webViewLink)')}`
    + `&orderBy=folder,name&pageSize=300&spaces=drive`;
  return (await (await driveFetch(url)).json()).files || [];
}

async function openExplorerFolder(id, name){
  if (!folderId) return;
  showSand('Abriendo carpeta…');
  try {
    let files;
    try { files = await driveList(id); }
    catch (err) {
      if (/Drive API 40[13]/.test(err.message || '')) { reauthDrive(); return; }
      throw err;
    }
    if (id === 'root') {
      explorerStack = [{ id: 'root', name: 'Mi unidad' }];
    } else {
      const i = explorerStack.findIndex(s => s.id === id);
      if (i >= 0) explorerStack = explorerStack.slice(0, i + 1);
      else explorerStack.push({ id, name: name || 'Carpeta' });
    }
    explorerLoaded = true;
    renderExplorer(files);
  } catch (err) {
    console.error(err);
    showError('No se pudo abrir la carpeta de Drive.');
  } finally { hideSand(); }
}

function renderExplorer(files){
  const bar = document.getElementById('explorerBar');
  const list = document.getElementById('explorerList');
  const favBox = document.getElementById('explorerFavs');
  if (!bar || !list) return;

  if (explorerFavs.length) {
    favBox.hidden = false;
    favBox.innerHTML = '<span class="ex-lbl">Favoritos</span>' + explorerFavs.map(f =>
      `<button class="ex-fav" data-fav="${escapeAttr(f.id)}" data-favname="${escapeAttr(f.name)}">📁 ${escapeHtml(f.name)}</button>`).join('');
    favBox.querySelectorAll('.ex-fav').forEach(b =>
      b.addEventListener('click', () => openExplorerFolder(b.dataset.fav, b.dataset.favname)));
  } else { favBox.hidden = true; favBox.innerHTML = ''; }

  bar.innerHTML = explorerStack.map((s, i) =>
    `<button class="ex-crumb" data-crumb="${escapeAttr(s.id)}">${escapeHtml(s.name)}</button>${i < explorerStack.length - 1 ? '<span class="ex-sep">›</span>' : ''}`).join('');
  bar.querySelectorAll('.ex-crumb').forEach(b => b.addEventListener('click', () => openExplorerFolder(b.dataset.crumb)));

  const cur = explorerStack[explorerStack.length - 1];
  const isFav = explorerFavs.some(f => f.id === cur.id);
  const folders = files.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
  const docs = files.filter(f => f.mimeType !== 'application/vnd.google-apps.folder');

  list.innerHTML =
    `<div class="ex-tools">
      <label class="btn btn-ghost ex-up">⬆ Subir aquí<input type="file" id="exUpload" hidden></label>
      ${cur.id !== 'root'
        ? `<button class="ex-star${isFav ? ' on' : ''}" id="exStar">${isFav ? '★ Quitar de favoritos' : '☆ Añadir a favoritos'}</button>` : ''}
    </div>` +
    (files.length === 0 ? '<p class="empty-note">Carpeta vacía.</p>' : '') +
    folders.map(f => `<div class="ex-row" data-open="${escapeAttr(f.id)}" data-name="${escapeAttr(f.name)}">
      <span class="ex-ic">📁</span><span class="ex-nm">${escapeHtml(f.name)}</span><span class="ex-go">›</span></div>`).join('') +
    docs.map(f => `<div class="ex-row" data-file="${escapeAttr(f.id)}" data-mime="${escapeAttr(f.mimeType || '')}" data-link="${escapeAttr(f.webViewLink || '')}" data-name="${escapeAttr(f.name)}">
      <span class="ex-ic">${fileIcon(f.mimeType)}</span>
      <span class="ex-nm">${escapeHtml(f.name)}</span>
      <span class="ex-meta">${f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: '2-digit' }) : ''}</span>
    </div>`).join('');

  const star = document.getElementById('exStar');
  if (star) star.addEventListener('click', async () => {
    if (isFav) explorerFavs = explorerFavs.filter(f => f.id !== cur.id);
    else explorerFavs.unshift({ id: cur.id, name: cur.name });
    try { await persistExplorerFavs(); } catch (e) {}
    renderExplorer(files);
  });
  const up = document.getElementById('exUpload');
  if (up) up.addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    showSand(`Subiendo «${f.name}»…`);
    try {
      const m = await createFileMeta(f.name, cur.id, f.type || 'application/octet-stream');
      await updateFileContent(m.id, f.type || 'application/octet-stream', f);
      await openExplorerFolder(cur.id, cur.name);
    } catch (err) {
      if (/Drive API 40[13]/.test(err.message || '')) reauthDrive();
      else { console.error(err); showError('No se pudo subir el archivo.'); }
    } finally { hideSand(); }
  });
  list.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', () => openExplorerFolder(el.dataset.open, el.dataset.name)));
  list.querySelectorAll('[data-file]').forEach(el => el.addEventListener('click', () => openDriveFile(el.dataset.file, el.dataset.mime, el.dataset.link, el.dataset.name)));
}

async function openDriveFile(id, mime, link, name){
  const previewable = mime === 'application/pdf' || (mime || '').startsWith('image/');
  if (!previewable) {
    if (link) window.open(link, '_blank', 'noopener');
    else showError('Este archivo se abre desde Google Drive.');
    return;
  }
  showSand('Cargando vista previa…');
  try {
    const blob = await (await driveFetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`)).blob();
    const url = URL.createObjectURL(blob);
    const inner = mime === 'application/pdf'
      ? `<embed src="${url}" type="application/pdf" style="width:100%; height:70vh; border:none; border-radius:10px;">`
      : `<img src="${url}" alt="${escapeAttr(name)}" style="width:100%; border-radius:10px; display:block;">`;
    renderModal(`
      <h3 style="font-size:.95rem; word-break:break-word;">${escapeHtml(name)}</h3>
      ${inner}
      <div class="modal-actions">
        ${link ? `<a class="btn btn-ghost" href="${escapeAttr(link)}" target="_blank" rel="noopener">Abrir en Drive</a>` : ''}
        <button class="btn btn-primary" id="modalClose">Cerrar</button>
      </div>`);
    $('#modalClose').addEventListener('click', () => { closeModal(); URL.revokeObjectURL(url); });
  } catch (err) {
    if (/Drive API 40[13]/.test(err.message || '')) reauthDrive();
    else { console.error(err); showError('No se pudo abrir el archivo.'); }
  } finally { hideSand(); }
}

/* =========================================================
   Modal genérico
   ========================================================= */
function renderModal(innerHtml){
  $('#modalRoot').innerHTML = `<div class="modal-backdrop" id="backdrop"><div class="modal">${innerHtml}</div></div>`;
  $('#backdrop').addEventListener('click', (e) => { if (e.target.id === 'backdrop') closeModal(); });
}
function closeModal(){ $('#modalRoot').innerHTML = ''; }

/* Segundo nivel de modal (para selectores que se abren sobre otro modal). */
function renderModal2(innerHtml){
  $('#modalRoot2').innerHTML = `<div class="modal-backdrop lvl2" id="backdrop2"><div class="modal">${innerHtml}</div></div>`;
  $('#backdrop2').addEventListener('click', (e) => { if (e.target.id === 'backdrop2') closeModal2(); });
}
function closeModal2(){ $('#modalRoot2').innerHTML = ''; }

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
