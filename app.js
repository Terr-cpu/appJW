/* =========================================================
   Hourglass Panel — configuración
   ========================================================= */
const CONFIG = {
  // Sustituye por tu Client ID de Google Cloud Console (OAuth 2.0 → Web application)
  CLIENT_ID: '989709837307-449de0hk767r7lplvjfc4ilfb6smnpfd.apps.googleusercontent.com',
  SCOPES: 'https://www.googleapis.com/auth/drive.file',
  FOLDER_NAME: 'Hourglass Panel',
  CUADRANTE_PREFIX: 'cuadrante-actual',
  ASIGNACIONES_NAME: 'asignaciones.json',
  HISTORIAL_NAME: 'historial-asignaciones.json',
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
    await loadHistorial(); // primero, para que loadCuadrante pueda fusionar sin condición de carrera
    await Promise.all([loadEvents(), loadProyectos(), loadCuadrante()]);
    renderNameMatches();
    renderCalendar();
    renderUpcoming();
    renderProyectos();
    checkReminders();
    setInterval(checkReminders, 60000);
  } catch (err) {
    console.error(err);
    showError('Hubo un problema conectando con Drive. Vuelve a intentar el inicio de sesión.');
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
   Cuadrante — subida (PDF o imagen)
   ========================================================= */
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
    const targetName = `${CONFIG.CUADRANTE_PREFIX}.${ext}`;

    // Localiza los cuadrantes existentes UNA sola vez. Reutiliza en sitio el que ya
    // tenga el nombre correcto y borra el resto DESPUÉS de escribir: así no dependemos
    // del índice de búsqueda de Drive (eventualmente consistente) justo tras un borrado,
    // que es lo que hacía que la 2ª subida fallara y se perdiera también la anterior.
    const existing = await findFilesByPrefix(CONFIG.CUADRANTE_PREFIX, folderId);
    let target = existing.find(f => f.name === targetName) || null;
    if (!target) target = await createFileMeta(targetName, folderId, mime);
    await updateFileContent(target.id, mime, file);

    for (const f of existing) {
      if (f.id !== target.id) { try { await deleteFile(f.id); } catch (_) { /* ya no está */ } }
    }

    await loadCuadrante({
      forceReparse: true,
      file: { id: target.id, mimeType: mime, modifiedTime: new Date().toISOString() },
    });
  } catch (err) {
    console.error(err);
    showError('No se pudo subir el archivo.');
  } finally {
    hideSand();
    e.target.value = '';
  }
});

let currentDocBlob = null;
let currentDocUrl = null;
let currentDocMime = null;
let currentParsed = null; // { tipo, asignaciones: [...] }

async function loadCuadrante({ forceReparse = false, file = null } = {}){
  let f = file;
  if (!f) {
    const files = await findFilesByPrefix(CONFIG.CUADRANTE_PREFIX, folderId);
    f = files[0] || null;
  }
  const meta = $('#cuadranteMeta');
  const toggle = $('#viewToggle');

  if (!f) {
    currentDocBlob = null; currentParsed = null;
    toggle.hidden = true;
    setOriginalViewerEmpty();
    $('#digitalView').innerHTML = '';
    meta.textContent = '';
    renderNameMatches();
    return;
  }

  const res = await downloadFile(f.id);
  const blob = await res.blob();
  currentDocBlob = blob;
  currentDocMime = f.mimeType;
  currentDocUrl = URL.createObjectURL(blob);
  renderOriginalViewer(currentDocMime, currentDocUrl);

  const d = new Date(f.modifiedTime);
  meta.textContent = `Subido el ${d.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' })}`;

  toggle.hidden = false;

  // Reutiliza el análisis ya guardado si el archivo no ha cambiado
  if (!forceReparse) {
    const cached = await findFile(CONFIG.ASIGNACIONES_NAME, folderId, 'application/json');
    if (cached) {
      try {
        const r = await downloadFile(cached.id);
        currentParsed = await r.json();
        await mergeIntoHistorial(currentParsed); // por si el historial aún no lo tenía (p. ej. tras esta actualización)
        renderDigitalView(currentParsed);
        renderNameMatches();
        return;
      } catch (e) { /* si falla, se reanaliza abajo */ }
    }
  }

  await analyzeCuadrante(blob, f.mimeType);
}

async function analyzeCuadrante(blob, mime){
  showSand(mime === 'application/pdf' ? 'Leyendo el PDF…' : 'Reconociendo el texto de la imagen (OCR)…');
  try {
    const pages = mime === 'application/pdf'
      ? await extractPagesFromPdf(blob)
      : await extractPagesFromImage(blob, (m) => {
          if (m.status === 'recognizing text') showSand(`Reconociendo texto… ${Math.round((m.progress || 0) * 100)}%`);
        });
    currentParsed = parseCuadrante(pages);
    await saveFile(CONFIG.ASIGNACIONES_NAME, 'application/json', JSON.stringify(currentParsed, null, 2), folderId);
    await mergeIntoHistorial(currentParsed);
  } catch (err) {
    console.error(err);
    currentParsed = { tipo: 'desconocido', asignaciones: [], error: true };
    // Persiste también el estado de error para que una recarga posterior no reutilice
    // el análisis (cacheado) del cuadrante anterior como si fuera el de este.
    try {
      await saveFile(CONFIG.ASIGNACIONES_NAME, 'application/json', JSON.stringify(currentParsed, null, 2), folderId);
    } catch (_) { /* no crítico */ }
    showError('No se pudo digitalizar el documento; puedes seguir consultando el original.');
  } finally {
    hideSand();
  }
  renderDigitalView(currentParsed);
  renderNameMatches();
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
    out += (!glued && gap > refH * 0.28 ? ' ' : '') + frag;
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
    b.rows.forEach(cells => {
      cells.forEach(cell => {
        const right = cell.x >= b.split;
        const labels = right ? PUBLIC_RIGHT_LABELS : PUBLIC_LEFT_LABELS;
        let isLabel = false;
        for (const lab of labels) {
          const rest = stripPublicLabel(cell.text, lab.re);
          if (rest == null) continue;
          if (right) activeR = lab.key; else activeL = lab.key;
          if (rest) f[lab.key] += (f[lab.key] ? ' ' : '') + rest;
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
        if (active) f[active] += (f[active] ? ' ' : '') + val;
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

  if (parsed.tipo === 'entre-semana') {
    const porFecha = [];
    parsed.asignaciones.forEach(a => {
      let grupo = porFecha.find(g => g.fecha === a.fecha);
      if (!grupo) { grupo = { fecha: a.fecha, lectura: a.lectura, filas: [] }; porFecha.push(grupo); }
      grupo.filas.push(a);
    });
    box.innerHTML = porFecha.map(g => `
      <div class="digital-week">
        <h3>${escapeHtml(g.fecha)}${g.lectura ? ` · ${escapeHtml(g.lectura)}` : ''}</h3>
        ${renderMidweekRows(g.filas)}
      </div>`).join('');
    return;
  }

  if (parsed.tipo === 'publica') {
    box.innerHTML = parsed.asignaciones.map(a => a.asamblea ? `
      <div class="digital-week"><h3>${escapeHtml(a.fecha)}</h3><p class="empty-note">Asamblea — sin reunión pública.</p></div>
    ` : `
      <div class="digital-week">
        <h3>${escapeHtml(a.fecha)}</h3>
        <div class="digital-row"><span class="dr-parte">Discurso</span><span class="dr-nombre">${escapeHtml(a.discursante || '')}</span></div>
        ${a.tema ? `<div class="digital-row"><span class="dr-parte">Tema</span><span class="dr-nombre">${escapeHtml(a.tema)}</span></div>` : ''}
        ${a.congregacion ? `<div class="digital-row"><span class="dr-parte">Congregación</span><span class="dr-nombre">${escapeHtml(a.congregacion)}</span></div>` : ''}
        <div class="digital-row"><span class="dr-parte">Presidente</span><span class="dr-nombre">${escapeHtml(a.presidente || '')}</span></div>
        <div class="digital-row"><span class="dr-parte">Lector de La Atalaya</span><span class="dr-nombre">${escapeHtml(a.lectorAtalaya || '')}</span></div>
        <div class="digital-row"><span class="dr-parte">Oración de conclusión</span><span class="dr-nombre">${escapeHtml(a.oracionConclusion || '')}</span></div>
      </div>`).join('');
    return;
  }

  box.innerHTML = '';
}

const SECTION_STYLE = {
  'tesoros de la biblia': { color: '#2F6F62', bg: '#EAF2EF' },
  'seamos mejores maestros': { color: '#9B7623', bg: '#FBF3DC' },
  'nuestra vida cristiana': { color: '#B4432D', bg: '#FBEAE5' },
  'vivamos como cristianos': { color: '#B4432D', bg: '#FBEAE5' },
};

function renderMidweekRows(filas){
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
nameInput.addEventListener('change', () => {
  localStorage.setItem('hg_myname', nameInput.value.trim());
  renderNameMatches();
});

function findMyAssignments(historial, name){
  if (!historial || !name) return [];
  const target = normalizeText(name);
  const out = [];

  historial.forEach(a => {
    if (a.tipo === 'entre-semana') {
      const nombres = a.nombres || [];
      if (nombres.some(n => normalizeText(n).includes(target))) {
        out.push({ fecha: a.fecha, hora: a.hora || '', categoria: categorizeMidweekRow(a), nombreTexto: nombres.join(' / ') });
      }
    } else if (a.tipo === 'publica') {
      if (a.asamblea) return;
      const campos = [
        ['discursante', 'Discurso público'], ['presidente', 'Presidencia'],
        ['lectorAtalaya', 'Lectura de La Atalaya'], ['oracionConclusion', 'Oración de conclusión'],
      ];
      campos.forEach(([key, label]) => {
        if (a[key] && normalizeText(a[key]).includes(target)) {
          out.push({ fecha: a.fecha, hora: '', categoria: label, nombreTexto: a[key] });
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
    <p class="nm-status">Esto es lo que tienes:</p>
    <ul class="nm-cards">${matches.map(m => `
      <li>
        <div class="nm-top">
          <span class="nm-fecha">${escapeHtml(m.categoria)}</span>
          <span class="nm-pagesmall">${escapeHtml(m.fecha)}${m.hora ? ' · ' + escapeHtml(m.hora) : ''}</span>
        </div>
        <div class="nm-detalle">${highlightName(m.nombreTexto, name)}</div>
      </li>`).join('')}</ul>`;
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
