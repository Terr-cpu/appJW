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

    // Borra cualquier cuadrante anterior (puede tener otra extensión si antes era PDF/imagen distinta)
    const old = await findFilesByPrefix(CONFIG.CUADRANTE_PREFIX, folderId);
    for (const f of old) await deleteFile(f.id);

    await saveFile(`${CONFIG.CUADRANTE_PREFIX}.${ext}`, mime, file, folderId);
    await loadCuadrante({ forceReparse: true });
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

async function loadCuadrante({ forceReparse = false } = {}){
  const files = await findFilesByPrefix(CONFIG.CUADRANTE_PREFIX, folderId);
  const f = files[0] || null;
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
  } catch (err) {
    console.error(err);
    currentParsed = { tipo: 'desconocido', asignaciones: [], error: true };
    showError('No se pudo digitalizar el documento; puedes seguir consultando el original.');
  } finally {
    hideSand();
  }
  renderDigitalView(currentParsed);
  renderNameMatches();
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
function clusterItemsIntoLines(items, yTolerance = 6){
  const sorted = items.slice().sort((a, b) => a.y - b.y);
  const lines = [];
  sorted.forEach(it => {
    const line = lines[lines.length - 1];
    if (!line || Math.abs(it.y - line.avgY) > yTolerance) {
      lines.push({ avgY: it.y, items: [it] });
    } else {
      line.items.push(it);
      line.avgY = (line.avgY * (line.items.length - 1) + it.y) / line.items.length;
    }
  });
  return lines
    .map(l => {
      const items2 = l.items.slice().sort((a, b) => a.x - b.x);
      return { items: items2, text: items2.map(i => i.text).join(' ').replace(/\s+/g, ' ').trim() };
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
    const items = content.items.map(it => ({ text: it.str, x: it.transform[4], y: -it.transform[5] }));
    pages.push({ width: viewport.width, lines: clusterItemsIntoLines(items) });
  }
  return pages;
}

async function extractPagesFromImage(blob, onProgress){
  if (typeof Tesseract === 'undefined') throw new Error('Tesseract no disponible');
  const { data } = await Tesseract.recognize(blob, 'spa', { logger: onProgress });
  const items = (data.words || []).map(w => ({ text: w.text, x: w.bbox.x0, y: w.bbox.y0 }));
  const width = data.width || (items.length ? Math.max(...items.map(i => i.x)) : 1000);
  return [{ width, lines: clusterItemsIntoLines(items, 10) }];
}

/* =========================================================
   Parsers — de texto posicionado a asignaciones estructuradas
   ========================================================= */
function normalizeText(s){
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function normalizeKey(s){ return normalizeText(s).replace(/[^a-z0-9]+/g, ' ').trim(); }

/* Encuentra el mayor "hueco" horizontal en la página (entre el 25% y el 85% del ancho)
   para usarlo como frontera entre la columna de "concepto" y la de "nombre/rol".
   Es más fiable que un ratio fijo porque se adapta a cada documento. */
function detectColumnSplit(page){
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

function splitLineByColumn(line, splitX){
  const leftItems = line.items.filter(i => i.x < splitX);
  const rightItems = line.items.filter(i => i.x >= splitX);
  return {
    left: leftItems.map(i => i.text).join(' ').replace(/\s+/g, ' ').trim(),
    right: rightItems.map(i => i.text).join(' ').replace(/\s+/g, ' ').trim(),
  };
}

/* Limpia artefactos típicos de fuentes con mapeo Unicode roto en el PDF de origen
   (viñetas que se extraen como "e", "«", "+", comas en vez de puntos, etc.) */
function cleanParteText(s){
  let t = String(s || '').trim();
  // 1) Quita cualquier viñeta/artefacto de 1-2 caracteres NO alfanuméricos al principio
  t = t.replace(/^[^\wÀ-ÿ¿¡0-9]{1,2}\s*/, '');
  // 2) Si empieza por número de parte, normaliza "N," / "N;" a "N."
  t = t.replace(/^(\d{1,2})[,;]\s*/, '$1. ');
  // 3) Quita una letra suelta (artefacto de fuente), p.ej. "e Palabras" → "Palabras"
  t = t.replace(/^[a-zA-Z]\s+(?=[A-ZÁÉÍÓÚÑ0-9¿])/, '');
  return t.trim();
}

function detectTipo(pages){
  const key = normalizeKey(pages.map(p => p.lines.map(l => l.text).join(' ')).join(' '));
  if (key.includes('tesoros de la biblia') || key.includes('seamos mejores maestros')) return 'entre-semana';
  if (key.includes('discursante') && key.includes('congregacion')) return 'publica';
  return 'desconocido';
}

const MIDWEEK_SECTIONS = ['tesoros de la biblia', 'seamos mejores maestros', 'nuestra vida cristiana', 'vivamos como cristianos'];

/* Igual que en "publica": no se procesa línea a línea de forma aislada. Cada FILA LÓGICA
   (todo lo que cuelga de una misma hora, aunque el título de la parte o el nombre se
   repartan en varias líneas por ser largos) se acumula y se cierra solo cuando llega la
   siguiente hora, sección o fecha. Así los nombres largos partidos en dos líneas no se
   convierten en "asignaciones fantasma" sueltas. */
function parseMidweek(pages){
  const asignaciones = [];
  let fecha = null, lectura = null, seccion = null;
  let currentRow = null;

  function flushRow(){
    if (!currentRow) return;
    const leftText = currentRow.leftParts.join(' ').replace(/\s+/g, ' ').trim();
    let rightText = currentRow.rightParts.join(' ').replace(/\s+/g, ' ').trim();
    const hora = currentRow.hora;
    let parte = cleanParteText(leftText);

    const durMatch = rightText.match(/^\((\d+\s*min\.?)\)\s*/i);
    if (durMatch) { parte = `${parte} (${durMatch[1]})`.trim(); rightText = rightText.slice(durMatch[0].length).trim(); }

    if (!rightText) {
      if (parte) asignaciones.push({ fecha: currentRow.fecha, lectura: currentRow.lectura, seccion: currentRow.seccion, hora, parte, rol: null, nombres: [] });
    } else {
      const roleMatch = rightText.match(/^(Oraci[oó]n|Presidente|Conductor|Lector|Consejero de la sala auxiliar)\s+(.*)$/i);
      const rol = roleMatch ? roleMatch[1] : null;
      const nombreTexto = roleMatch ? roleMatch[2] : rightText;
      const nombres = nombreTexto.split('/').map(n => n.trim()).filter(Boolean);
      if (parte || nombres.length) {
        asignaciones.push({ fecha: currentRow.fecha, lectura: currentRow.lectura, seccion: currentRow.seccion, hora, parte, rol, nombres });
      }
    }
    currentRow = null;
  }

  pages.forEach(page => {
    const splitX = detectColumnSplit(page);
    page.lines.forEach(line => {
      const t = line.text;
      const dateMatch = t.match(/^(\d{4}\/\d{2}\/\d{2})\s*\|\s*(.+)$/);
      if (dateMatch) { flushRow(); fecha = dateMatch[1]; lectura = dateMatch[2].trim(); seccion = null; return; }
      if (MIDWEEK_SECTIONS.includes(normalizeKey(t))) { flushRow(); seccion = t.trim(); return; }
      if (/^sala auxiliar/i.test(t) || /^auditorio principal/i.test(t) || /^impreso/i.test(t)) return;
      if (!fecha) return;

      const { left, right } = splitLineByColumn(line, splitX);
      if (!left && !right) return;

      const timeMatch = left.match(/^(\d{1,2}:\d{2})\s*(.*)$/);
      const rightStartsRole = /^(Oraci[oó]n|Presidente|Conductor|Lector|Consejero de la sala auxiliar)\b/i.test(right);

      if (timeMatch) {
        flushRow();
        currentRow = { fecha, lectura, seccion, hora: timeMatch[1], leftParts: [timeMatch[2]], rightParts: [right] };
      } else if (currentRow && rightStartsRole && currentRow.rightParts.some(p => p)) {
        // Segundo rol para la MISMA parte (p. ej. "Conductor" + "Lector" en el estudio bíblico):
        // cierra la asignación ya acumulada y abre otra con la misma hora/parte para este nuevo rol.
        const { fecha: f2, lectura: l2, seccion: s2, hora: h2, leftParts: lp2 } = currentRow;
        flushRow();
        currentRow = { fecha: f2, lectura: l2, seccion: s2, hora: h2, leftParts: lp2.slice(), rightParts: [right] };
      } else if (currentRow) {
        // continuación (línea envuelta) de la fila abierta: se añade a lo que ya había
        if (left) currentRow.leftParts.push(left);
        if (right) currentRow.rightParts.push(right);
      } else {
        // línea suelta sin hora todavía al principio de la fecha/sección
        currentRow = { fecha, lectura, seccion, hora: null, leftParts: [left], rightParts: [right] };
      }
    });
  });
  flushRow();
  return asignaciones;
}

const PUBLIC_LEFT_DEFS = [
  { key: 'discursante', phrase: 'DISCURSANTE' },
  { key: 'tema', phrase: 'TEMA' },
  { key: 'congregacion', phrase: 'CONGREGACI[OÓ]N' },
];
const PUBLIC_RIGHT_DEFS = [
  { key: 'presidente', phrase: 'PRESIDENTE' },
  { key: 'lectorAtalaya', phrase: 'LECTOR\\s+DE\\s+LA\\s+ATALAYA' },
  { key: 'oracionConclusion', phrase: 'ORACI[OÓ]N\\s+DE\\s+CONCLUSI[OÓ]N' },
];

function extractFieldsByAnchors(text, defs){
  const found = [];
  defs.forEach(({ key, phrase }) => {
    const m = new RegExp(phrase, 'i').exec(text);
    if (m) found.push({ key, start: m.index, end: m.index + m[0].length });
  });
  found.sort((a, b) => a.start - b.start);
  const result = {};
  found.forEach((f, i) => {
    const end = i + 1 < found.length ? found[i + 1].start : text.length;
    result[f.key] = text.slice(f.end, end).trim();
  });
  return result;
}

/* Importante: aquí NO se agrupa línea a línea. Se reparte cada palabra de todo el bloque
   (una fecha hasta la siguiente) en dos bolsas —izquierda/derecha— según su columna, y
   SOLO DESPUÉS se reconstruyen las líneas de cada bolsa por separado. Así, aunque dos filas
   estén muy pegadas verticalmente, nunca se mezclan palabras de una columna con la otra. */
function parsePublica(pages){
  const blocks = [];
  let current = null;
  pages.forEach(page => {
    const splitX = detectColumnSplit(page);
    page.lines.forEach(line => {
      const t = line.text;
      const dateMatch = t.match(/^(\d{1,2}\s+[A-ZÁÉÍÓÚÑ]+\s+\d{4})$/);
      if (dateMatch) { current = { fecha: dateMatch[1], leftItems: [], rightItems: [] }; blocks.push(current); return; }
      if (!current) return;
      line.items.forEach(it => (it.x < splitX ? current.leftItems : current.rightItems).push(it));
    });
  });

  return blocks
    .map(b => {
      const leftText = clusterItemsIntoLines(b.leftItems, 4).map(l => l.text).join(' ');
      const rightText = clusterItemsIntoLines(b.rightItems, 4).map(l => l.text).join(' ');
      if (/ASAMBLEA/i.test(leftText + ' ' + rightText)) return { fecha: b.fecha, asamblea: true };
      return { fecha: b.fecha, ...extractFieldsByAnchors(leftText, PUBLIC_LEFT_DEFS), ...extractFieldsByAnchors(rightText, PUBLIC_RIGHT_DEFS) };
    })
    .filter(a => a.asamblea || a.discursante);
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
        <span class="dr-parte">${escapeHtml(f.parte || '')}</span>
        <span class="dr-nombre">${f.rol ? `<em>${escapeHtml(f.rol)}</em>` : ''}${escapeHtml((f.nombres || []).join(' / '))}</span>
      </div>`;
  });
  return html;
}

/* ---------- Localizar mi nombre a partir de los datos digitalizados ---------- */
const nameInput = $('#myNameInput');
nameInput.value = localStorage.getItem('hg_myname') || '';
nameInput.addEventListener('change', () => {
  localStorage.setItem('hg_myname', nameInput.value.trim());
  renderNameMatches();
});

function findMyAssignments(parsed, name){
  if (!parsed || !name) return [];
  const target = normalizeText(name);
  const out = [];

  if (parsed.tipo === 'entre-semana') {
    parsed.asignaciones.forEach(a => {
      const nombres = a.nombres || [];
      if (nombres.some(n => normalizeText(n).includes(target))) {
        out.push({
          fecha: a.fecha,
          etiqueta: a.hora || '',
          // Si es un rol (Oración/Presidente/Conductor/Lector), lo que "tienes" es el rol,
          // no el título de la canción o parte a la que va pegado en el documento.
          detalle: a.rol || a.parte || '',
          nombreTexto: nombres.join(' / '),
        });
      }
    });
  } else if (parsed.tipo === 'publica') {
    parsed.asignaciones.forEach(a => {
      if (a.asamblea) return;
      const roles = [
        ['discursante', 'Discursante'], ['presidente', 'Presidente'],
        ['lectorAtalaya', 'Lector de La Atalaya'], ['oracionConclusion', 'Oración de conclusión'],
      ];
      roles.forEach(([key, label]) => {
        if (a[key] && normalizeText(a[key]).includes(target)) {
          out.push({ fecha: a.fecha, etiqueta: label, detalle: a.tema || '', nombreTexto: a[key] });
        }
      });
    });
  }
  return out;
}

function renderNameMatches(){
  const box = $('#nameMatches');
  const name = nameInput.value.trim();

  if (!currentParsed || !currentParsed.asignaciones || currentParsed.asignaciones.length === 0) { box.innerHTML = ''; return; }
  if (!name) { box.innerHTML = '<p class="nm-status">Añade tu nombre arriba para ver aquí tus asignaciones, sin abrir el documento.</p>'; return; }

  const matches = findMyAssignments(currentParsed, name);
  if (matches.length === 0) {
    box.innerHTML = `<p class="nm-status">No aparece "${escapeHtml(name)}" en este cuadrante.</p>`;
    return;
  }
  box.innerHTML = `
    <p class="nm-status">Esto es lo que tienes:</p>
    <ul class="nm-cards">${matches.map(m => `
      <li>
        <div class="nm-top">
          <span class="nm-fecha">${escapeHtml(m.fecha)}</span>
          ${m.etiqueta ? `<span class="nm-pagesmall">${escapeHtml(m.etiqueta)}</span>` : ''}
        </div>
        <div class="nm-detalle">${m.detalle ? escapeHtml(m.detalle) + ' — ' : ''}${highlightName(m.nombreTexto, name)}</div>
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
