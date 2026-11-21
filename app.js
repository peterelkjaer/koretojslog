/* Køretøjslog – vedligeholdelse, udgifter og kilometer. Data gemmes lokalt og synkroniseres til Google Drive. */
'use strict';

const APP_VERSION = '1.0.0';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const ROOT_FOLDER = 'Køretøjslog';
const PDFJS = 'lib/pdf.min.js';
const PDFJS_WORKER = 'lib/pdf.worker.min.js';

const TYPES = {
  service:    { label: 'Service',            icon: '🔧', color: '#2563eb' },
  repair:     { label: 'Reparation',         icon: '🛠️', color: '#dc2626' },
  parts:      { label: 'Reservedele',        icon: '⚙️', color: '#7c3aed' },
  tires:      { label: 'Dæk',                icon: '🛞', color: '#0d9488' },
  inspection: { label: 'Syn',                icon: '✅', color: '#16a34a' },
  fuel:       { label: 'Brændstof/opladning',icon: '⛽', color: '#ea580c' },
  insurance:  { label: 'Forsikring',         icon: '🛡️', color: '#0891b2' },
  tax:        { label: 'Afgifter',           icon: '🏛️', color: '#64748b' },
  care:       { label: 'Vask/parkering',     icon: '🧽', color: '#db2777' },
  other:      { label: 'Andet',              icon: '📌', color: '#a16207' },
};
const FUELS = ['Benzin', 'Diesel', 'El', 'Hybrid', 'Plug-in hybrid', 'Andet'];
const REM_TEMPLATES = [
  { name: 'Olieskift', intervalKm: 15000, intervalMonths: 12 },
  { name: 'Service', intervalKm: 30000, intervalMonths: 24 },
  { name: 'Syn', intervalKm: null, intervalMonths: 24 },
  { name: 'Bremsevæske', intervalKm: null, intervalMonths: 24 },
  { name: 'Tandrem', intervalKm: 120000, intervalMonths: 72 },
  { name: 'Luftfilter', intervalKm: 30000, intervalMonths: 24 },
  { name: 'Kabinefilter', intervalKm: 15000, intervalMonths: 12 },
  { name: 'Tændrør', intervalKm: 60000, intervalMonths: 48 },
  { name: 'Dækskifte (sommer/vinter)', intervalKm: null, intervalMonths: 6 },
];
const COLLS = ['vehicles', 'entries', 'readings', 'reminders', 'files'];

/* ---------- Hjælpere ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const nowIso = () => new Date().toISOString();
const localDate = d => d.toLocaleDateString('sv-SE');
const today = () => localDate(new Date());
const parseD = s => new Date(s + 'T12:00:00');
const addMonths = (s, n) => { const d = parseD(s); const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + n);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); return localDate(d); };
const addDays = (s, n) => { const d = parseD(s); d.setDate(d.getDate() + Math.round(n)); return localDate(d); };
const daysBetween = (a, b) => Math.round((parseD(b) - parseD(a)) / 864e5);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => (v === '' || v == null || isNaN(Number(v))) ? null : Number(v);
const fmtKr = n => (n || 0).toLocaleString('da-DK', { style: 'currency', currency: 'DKK', maximumFractionDigits: 0 });
const fmtKr2 = n => (n || 0).toLocaleString('da-DK', { style: 'currency', currency: 'DKK', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNum = n => (n ?? 0).toLocaleString('da-DK', { maximumFractionDigits: 0 });
const fmtKm = n => n == null ? '–' : fmtNum(n) + ' km';
const fmtDate = s => s ? parseD(s).toLocaleDateString('da-DK', { day: 'numeric', month: 'short', year: 'numeric' }) : '–';
const fmtMonth = s => parseD(s).toLocaleDateString('da-DK', { month: 'long', year: 'numeric' });
const fmtSize = b => b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' kB';
const isWide = () => matchMedia('(min-width: 840px)').matches;
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms); }
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000); }
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Kunne ikke hente ' + src)); document.head.appendChild(s); }); }

/* ---------- IndexedDB ---------- */
const DB = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('koretojslog', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('blobs'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (store, mode, fn) => { const db = await open(); return new Promise((res, rej) => {
    const t = db.transaction(store, mode); const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req ? req.result : undefined); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); };
  return {
    get: (s, k) => tx(s, 'readonly', o => o.get(k)),
    set: (s, k, v) => tx(s, 'readwrite', o => o.put(v, k)),
    del: (s, k) => tx(s, 'readwrite', o => o.delete(k)),
  };
})();

/* ---------- Data ---------- */
const emptyData = () => ({ schema: 1, vehicles: [], entries: [], readings: [], reminders: [], files: [] });
let data = emptyData();
const live = c => data[c].filter(x => !x.deleted);
const byId = (c, id) => data[c].find(x => x.id === id && !x.deleted);

function upsert(c, obj) {
  obj.updatedAt = nowIso();
  const i = data[c].findIndex(x => x.id === obj.id);
  if (i >= 0) data[c][i] = obj; else data[c].push(obj);
}
function softDelete(c, id) { const o = data[c].find(x => x.id === id); if (o && !o.deleted) { o.deleted = true; o.updatedAt = nowIso(); } }
function deleteFilesOf(kind, id) { for (const f of live('files')) if (f.ownerType === kind && f.ownerId === id) softDelete('files', f.id); }
function deleteVehicle(id) {
  softDelete('vehicles', id); deleteFilesOf('vehicle', id);
  for (const c of ['entries', 'readings', 'reminders']) for (const x of live(c)) if (x.vehicleId === id) {
    softDelete(c, x.id); if (c === 'entries') deleteFilesOf('entry', x.id); }
}
async function persist() { await DB.set('kv', 'data', data); Sync.schedule(); }

function merge(a, b) {
  const out = emptyData();
  for (const c of COLLS) {
    const m = new Map();
    for (const x of (a[c] || [])) m.set(x.id, x);
    for (const x of (b[c] || [])) { const y = m.get(x.id); if (!y || (x.updatedAt || '') > (y.updatedAt || '')) m.set(x.id, x); }
    out[c] = [...m.values()];
  }
  return out;
}
const sig = d => JSON.stringify(COLLS.map(c => [...(d[c] || [])].sort((x, y) => x.id < y.id ? -1 : 1)));

/* ---------- Beregninger ---------- */
function kmPoints(vid) {
  const pts = [];
  for (const r of live('readings')) if (r.vehicleId === vid && r.km != null) pts.push({ date: r.date, km: r.km });
  for (const e of live('entries')) if (e.vehicleId === vid && e.km != null) pts.push({ date: e.date, km: e.km });
  return pts.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.km - b.km);
}
function currentKm(vid) { let m = null; for (const p of kmPoints(vid)) if (m == null || p.km > m) m = p.km; return m; }
function lastKmDate(vid) { const p = kmPoints(vid); return p.length ? p[p.length - 1].date : null; }
function kmPerDay(vid) {
  const pts = kmPoints(vid); if (pts.length < 2) return null;
  const L = pts[pts.length - 1]; const cutoff = addDays(L.date, -400);
  const F = pts.find(p => p.date >= cutoff) || pts[0];
  const days = daysBetween(F.date, L.date); if (days < 14 || L.km <= F.km) return null;
  return (L.km - F.km) / days;
}
function reminderStatus(rem) {
  const vid = rem.vehicleId; const cur = currentKm(vid);
  let lastKm = rem.lastKm ?? null, lastDate = rem.lastDate || null;
  for (const e of live('entries')) if (e.vehicleId === vid && (e.reminderIds || []).includes(rem.id)) {
    if (!lastDate || e.date >= lastDate) { lastDate = e.date; lastKm = e.km ?? lastKm; }
  }
  const nextKm = rem.intervalKm && lastKm != null ? lastKm + rem.intervalKm : null;
  const nextDate = rem.intervalMonths && lastDate ? addMonths(lastDate, rem.intervalMonths) : null;
  const kmLeft = nextKm != null && cur != null ? nextKm - cur : null;
  const daysLeft = nextDate ? daysBetween(today(), nextDate) : null;
  const kpd = kmPerDay(vid);
  const predDate = kmLeft != null && kpd ? addDays(today(), Math.max(0, kmLeft) / kpd) : null;
  let level = 'ok';
  const soonKm = rem.intervalKm ? Math.min(1500, rem.intervalKm * 0.1) : 0;
  if ((kmLeft != null && kmLeft <= 0) || (daysLeft != null && daysLeft <= 0)) level = 'overdue';
  else if ((kmLeft != null && kmLeft <= soonKm) || (daysLeft != null && daysLeft <= 30)) level = 'soon';
  if (lastKm == null && lastDate == null) level = 'unknown';
  // Hvor langt er vi i intervallet (0..1)?
  let progress = 0;
  if (kmLeft != null) progress = Math.max(progress, 1 - kmLeft / rem.intervalKm);
  if (daysLeft != null) progress = Math.max(progress, 1 - daysLeft / (rem.intervalMonths * 30.44));
  const dueDate = [nextDate, predDate].filter(Boolean).sort()[0] || null;
  return { lastKm, lastDate, nextKm, nextDate, kmLeft, daysLeft, predDate, level, dueDate, progress: Math.min(1, Math.max(0, progress)) };
}
const LEVEL_ORDER = { overdue: 0, soon: 1, ok: 2, unknown: 3 };
const LEVEL_TXT = { overdue: 'Overskredet', soon: 'Snart', ok: 'OK', unknown: 'Mangler start' };
function sortedReminders(vid) {
  return live('reminders').filter(r => !vid || r.vehicleId === vid).map(r => ({ r, s: reminderStatus(r) }))
    .sort((a, b) => LEVEL_ORDER[a.s.level] - LEVEL_ORDER[b.s.level] || (a.s.dueDate || '9') .localeCompare(b.s.dueDate || '9'));
}
function remText(s) {
  const parts = [];
  if (s.kmLeft != null) parts.push(s.kmLeft >= 0 ? `om ${fmtKm(s.kmLeft)}` : `${fmtKm(-s.kmLeft)} over`);
  if (s.daysLeft != null) parts.push(s.daysLeft >= 0 ? `senest ${fmtDate(s.nextDate)}` : `forfaldt ${fmtDate(s.nextDate)}`);
  if (s.predDate && s.kmLeft > 0) parts.push(`ca. ${fmtMonth(s.predDate)} ved nuv. kørsel`);
  if (s.level === 'unknown') parts.push('Angiv hvornår det sidst blev udført');
  return parts.join(' · ');
}
const vehicleName = id => byId('vehicles', id)?.name || '(slettet)';
const entryTitle = e => e.title || TYPES[e.type]?.label || 'Post';
const filesOf = (kind, id) => live('files').filter(f => f.ownerType === kind && f.ownerId === id);

/* ---------- Google Drive ---------- */
class NeedAuth extends Error { constructor() { super('Login kræves'); } }
const Drive = {
  token: null, exp: 0,
  ids: JSON.parse(localStorage.getItem('driveIds') || '{}'),
  saveIds() { localStorage.setItem('driveIds', JSON.stringify(this.ids)); },
  clientId() { return (localStorage.getItem('clientId') || (window.APP_CONFIG || {}).GOOGLE_CLIENT_ID || '').trim(); },
  enabled() { return localStorage.getItem('mode') === 'drive'; },
  async loadGis() { if (!(window.google && google.accounts && google.accounts.oauth2)) await loadScript('https://accounts.google.com/gsi/client'); },
  async login() {
    if (!this.clientId()) throw new Error('Indsæt først dit Google Client ID under Indstillinger.');
    await this.loadGis();
    return new Promise((res, rej) => {
      const tc = google.accounts.oauth2.initTokenClient({
        client_id: this.clientId(), scope: SCOPE,
        callback: r => {
          if (r.error) return rej(new Error(r.error_description || r.error));
          this.token = r.access_token; this.exp = Date.now() + (Number(r.expires_in) - 120) * 1000;
          localStorage.setItem('tok', JSON.stringify({ t: this.token, e: this.exp }));
          localStorage.setItem('consented', '1'); res();
        },
        error_callback: e => rej(new Error(e.type === 'popup_closed' ? 'Login blev lukket' : (e.message || 'Login fejlede'))),
      });
      tc.requestAccessToken({ prompt: localStorage.getItem('consented') ? '' : 'consent' });
    });
  },
  hasToken() {
    if (this.token && Date.now() < this.exp) return true;
    const s = JSON.parse(localStorage.getItem('tok') || 'null');
    if (s && Date.now() < s.e) { this.token = s.t; this.exp = s.e; return true; }
    return false;
  },
  logout() {
    if (this.token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(this.token, () => {});
    this.token = null; localStorage.removeItem('tok'); localStorage.removeItem('consented');
  },
  async api(url, opts = {}) {
    if (!this.hasToken()) throw new NeedAuth();
    const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + this.token } });
    if (r.status === 401) { this.token = null; localStorage.removeItem('tok'); throw new NeedAuth(); }
    if (!r.ok) { const t = await r.text(); const e = new Error(`Drive-fejl ${r.status}: ${t.slice(0, 160)}`); e.status = r.status; throw e; }
    return r;
  },
  async find(name, parent, mime) {
    let q = `name='${name.replace(/'/g, "\\'")}' and trashed=false`;
    if (parent) q += ` and '${parent}' in parents`;
    if (mime) q += ` and mimeType='${mime}'`;
    const r = await (await this.api(`${API}/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive&orderBy=createdTime`)).json();
    return r.files[0]?.id || null;
  },
  async folder(name, parent) {
    const id = await this.find(name, parent, FOLDER_MIME); if (id) return id;
    const r = await this.api(`${API}/files?fields=id`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: parent ? [parent] : undefined }) });
    return (await r.json()).id;
  },
  async init() {
    if (this.ids.root && this.ids.files) return;
    this.ids.root = await this.folder(ROOT_FOLDER);
    this.ids.files = await this.folder('Bilag', this.ids.root);
    this.ids.data = await this.find('data.json', this.ids.root);
    this.saveIds();
  },
  async multipart(blob, meta, id) {
    const b = 'kl' + uid();
    const body = new Blob([`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`, blob, `\r\n--${b}--`]);
    const r = await this.api(`${UPLOAD}/files${id ? '/' + id : ''}?uploadType=multipart&fields=id`,
      { method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body });
    return (await r.json()).id;
  },
  async upload(blob, name, parent) {
    const init = await this.api(`${UPLOAD}/files?uploadType=resumable&fields=id`, { method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': blob.type || 'application/octet-stream' },
      body: JSON.stringify({ name, parents: [parent] }) });
    const loc = init.headers.get('Location');
    if (!loc) return this.multipart(blob, { name, parents: [parent] });
    const r = await fetch(loc, { method: 'PUT', body: blob });
    if (!r.ok) throw new Error('Upload fejlede (' + r.status + ')');
    return (await r.json()).id;
  },
  async readData() {
    if (!this.ids.data) return null;
    try { return await (await this.api(`${API}/files/${this.ids.data}?alt=media`)).json(); }
    catch (e) { if (e.status === 404) { this.ids.data = null; this.saveIds(); return null; } throw e; }
  },
  async writeData(obj) {
    const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
    if (this.ids.data) await this.multipart(blob, {}, this.ids.data);
    else { this.ids.data = await this.multipart(blob, { name: 'data.json', parents: [this.ids.root] }); this.saveIds(); }
  },
  async downloadFile(id) { return (await this.api(`${API}/files/${id}?alt=media`)).blob(); },
  async trash(id) {
    try { await this.api(`${API}/files/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) }); }
    catch (e) { if (e.status !== 404) throw e; }
  },
};

const Sync = {
  timer: null, busy: false, again: false, state: 'local', err: '',
  schedule() { if (!Drive.enabled()) return; clearTimeout(this.timer); this.timer = setTimeout(() => this.run(), 1200); },
  set(state, err = '') { this.state = state; this.err = err; renderSync(); },
  async run() {
    if (!Drive.enabled()) return this.set('local');
    if (this.busy) { this.again = true; return; }
    this.busy = true; this.set('syncing');
    try {
      if (!Drive.hasToken()) throw new NeedAuth();
      try { await Drive.init(); } catch (e) { if (e.status === 404) { Drive.ids = {}; await Drive.init(); } else throw e; }
      await this.pushFiles();
      const remote = await Drive.readData();
      const merged = remote ? merge(data, remote) : data;
      if (!remote || sig(merged) !== sig(remote)) await Drive.writeData(merged);
      const fresh = merge(data, merged); // bevar evt. ændringer lavet mens vi synkroniserede
      if (sig(fresh) !== sig(data)) { data = fresh; await DB.set('kv', 'data', data); render(); }
      localStorage.setItem('lastSync', nowIso());
      this.set('ok');
    } catch (e) {
      if (e instanceof NeedAuth) this.set('auth');
      else { console.error(e); this.set('error', e.message); }
    } finally {
      this.busy = false;
      if (this.again) { this.again = false; this.schedule(); }
    }
  },
  async pushFiles() {
    let changed = false;
    for (const f of data.files) {
      if (!f.deleted && !f.driveId) {
        const blob = await DB.get('blobs', f.id); if (!blob) continue;
        f.driveId = await Drive.upload(blob, `${f.id}_${f.name}`, Drive.ids.files); f.updatedAt = nowIso(); changed = true;
      } else if (f.deleted && f.driveId && !f.trashed) {
        await Drive.trash(f.driveId); f.trashed = true; f.updatedAt = nowIso(); changed = true;
        DB.del('blobs', f.id);
      }
    }
    if (changed) await DB.set('kv', 'data', data);
  },
};

function renderSync() {
  const p = $('#syncPill'); if (!p) return;
  const map = {
    local: ['📱 Kun på denne enhed', 'warn'], syncing: ['⟳ Synkroniserer…', ''], ok: ['☁️ Synkroniseret', 'ok'],
    auth: ['⚠️ Tryk for at logge ind', 'warn'], error: ['⚠️ Synkfejl – prøv igen', 'err'],
  };
  const [t, c] = map[Sync.state]; p.textContent = t; p.className = 'sync-pill ' + c; p.title = Sync.err || '';
  const last = localStorage.getItem('lastSync');
  $('#sideSync').textContent = Drive.enabled() && last ? 'Sidst synk.: ' + new Date(last).toLocaleString('da-DK', { dateStyle: 'short', timeStyle: 'short' }) : '';
}

async function connectDrive() {
  try {
    await Drive.login();
    localStorage.setItem('mode', 'drive');
    toast('Forbundet til Google Drive');
    await Sync.run(); render();
  } catch (e) { toast(e.message, 4000); }
}

/* ---------- Filer / bilag ---------- */
async function compressImage(file) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.type === 'image/svg+xml') return file;
  try {
    const bmp = await createImageBitmap(file);
    const sc = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    if (blob && blob.size < file.size) return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch (e) { console.warn(e); }
  return file;
}
async function addFile(file, ownerType, ownerId, kind, label) {
  const f = await compressImage(file);
  const rec = { id: uid(), name: f.name || 'fil', mime: f.type || 'application/octet-stream', size: f.size,
    ownerType, ownerId, kind, label: label || '', driveId: null, addedAt: nowIso() };
  await DB.set('blobs', rec.id, f);
  upsert('files', rec);
  return rec;
}
async function getBlob(f) {
  const cached = await DB.get('blobs', f.id); if (cached) return cached;
  if (!f.driveId) throw new Error('Filen er endnu ikke uploadet fra den enhed, hvor den blev tilføjet.');
  if (!Drive.hasToken()) throw new Error('Log ind på Google Drive for at hente filen.');
  toast('Henter fil fra Google Drive…', 1500);
  const blob = await Drive.downloadFile(f.driveId);
  const typed = blob.type ? blob : new Blob([blob], { type: f.mime });
  DB.set('blobs', f.id, typed).catch(() => {});
  return typed;
}
const fileIcon = f => f.mime === 'application/pdf' ? '📄' : f.mime.startsWith('image/') ? '🖼️' : '📎';
function fileChips(files, removable) {
  if (!files.length) return '';
  return `<div class="files">${files.map(f => `<div class="file" data-act="openFile" data-id="${f.id}">
    <span>${fileIcon(f)}</span><span class="n">${esc(f.label || f.name)}</span>
    ${removable ? `<button type="button" data-act="removeFile" data-id="${f.id}" aria-label="Fjern">✕</button>` : ''}</div>`).join('')}</div>`;
}

/* ---------- Viser (PDF / billeder) ---------- */
async function openFile(id) {
  const f = data.files.find(x => x.id === id); if (!f) return;
  const ov = document.createElement('div'); ov.className = 'viewer';
  ov.innerHTML = `<div class="vt"><button data-close>← Luk</button><div class="ttl">${esc(f.label || f.name)}</div><span class="vtools"></span>
    <button data-dl title="Gem / åbn i anden app">⤓</button></div><div class="msg">Indlæser…</div>`;
  pushLayer(ov);
  let blob;
  try { blob = await getBlob(f); } catch (e) { $('.msg', ov).textContent = e.message; return; }
  $('[data-dl]', ov).onclick = () => download(blob, f.name);
  if (f.mime.startsWith('image/')) {
    const url = URL.createObjectURL(blob);
    $('.msg', ov).outerHTML = `<div class="imgwrap"><img src="${url}" alt=""></div>`;
    ov._cleanup = () => URL.revokeObjectURL(url);
  } else if (f.mime === 'application/pdf') {
    try { await pdfView(ov, blob); }
    catch (e) { console.error(e); $('.msg', ov).innerHTML = `PDF-viseren kunne ikke indlæses (${esc(e.message)}).<br><br><button class="btn" id="pdfdl">Åbn i anden app</button>`;
      $('#pdfdl', ov).onclick = () => download(blob, f.name); }
  } else {
    $('.msg', ov).innerHTML = `Denne filtype kan ikke vises her.<br><br><button class="btn" id="odl">Download</button>`;
    $('#odl', ov).onclick = () => download(blob, f.name);
  }
}
async function pdfView(ov, blob) {
  if (!window.pdfjsLib) { await loadScript(PDFJS); pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; }
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  const n = pdf.numPages; let zoom = 1;
  $('.vtools', ov).innerHTML = `<button data-z="-1">−</button><button data-z="1">＋</button>
    <input type="number" min="1" max="${n}" value="1" inputmode="numeric" aria-label="Side"><span class="small" style="color:#bbb">/ ${n}</span>`;
  const pagesEl = document.createElement('div'); pagesEl.className = 'pages';
  $('.msg', ov).replaceWith(pagesEl);
  const first = await pdf.getPage(1); const v1 = first.getViewport({ scale: 1 }); const ratio = v1.height / v1.width;
  const holders = [];
  const baseW = () => Math.min(pagesEl.clientWidth - 16, 1100);
  const size = () => holders.forEach(h => { const w = baseW() * zoom; h.style.width = w + 'px'; h.style.height = (w * (h._ratio || ratio)) + 'px'; });
  for (let i = 1; i <= n; i++) { const h = document.createElement('div'); h.className = 'pg'; h.dataset.p = i; h.innerHTML = `<span class="pn">${i}</span>`; pagesEl.appendChild(h); holders.push(h); }
  size();
  const rendering = new Set();
  async function renderPage(h) {
    const i = +h.dataset.p; if (h._done === zoom || rendering.has(i)) return; rendering.add(i);
    try {
      const page = await pdf.getPage(i); const vp1 = page.getViewport({ scale: 1 });
      h._ratio = vp1.height / vp1.width; const w = baseW() * zoom; h.style.height = (w * h._ratio) + 'px';
      const scale = (w / vp1.width) * Math.min(window.devicePixelRatio || 1, 2);
      const vp = page.getViewport({ scale });
      const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      $('canvas', h)?.remove(); h.prepend(c); h._done = zoom;
    } finally { rendering.delete(i); }
  }
  const io = new IntersectionObserver(es => es.forEach(e => {
    if (e.isIntersecting) renderPage(e.target);
    else { const c = $('canvas', e.target); if (c) { c.width = 0; c.remove(); e.target._done = null; } }
  }), { root: pagesEl, rootMargin: '1200px 0px' });
  holders.forEach(h => io.observe(h));
  const inp = $('input', ov);
  pagesEl.addEventListener('scroll', () => {
    const mid = pagesEl.scrollTop + pagesEl.clientHeight / 3;
    const h = holders.find(h => h.offsetTop + h.offsetHeight > mid); if (h && document.activeElement !== inp) inp.value = h.dataset.p;
  }, { passive: true });
  inp.addEventListener('change', () => { const p = Math.min(n, Math.max(1, +inp.value || 1)); holders[p - 1].scrollIntoView(); });
  $$('[data-z]', ov).forEach(b => b.onclick = () => {
    const p = +inp.value || 1; zoom = Math.min(4, Math.max(0.5, zoom * (b.dataset.z > 0 ? 1.25 : 0.8)));
    size(); holders[p - 1].scrollIntoView();
    holders.forEach(h => { if ($('canvas', h)) renderPage(h); });
  });
  ov._cleanup = () => { io.disconnect(); pdf.destroy(); };
}

/* ---------- Lag (modaler) + tilbage-knap ---------- */
const layers = [];
function pushLayer(el) {
  $('#modal').appendChild(el); layers.push(el); history.pushState({ layer: layers.length }, '');
  el.addEventListener('click', e => { if (e.target === el || e.target.closest('[data-close]')) closeLayer(); });
}
let closeWaiters = [];
function closeLayer() { return new Promise(res => { closeWaiters.push(res); history.back(); }); }
window.addEventListener('popstate', () => {
  const el = layers.pop();
  if (el) { el._cleanup?.(); el.remove(); }
  const w = closeWaiters; closeWaiters = []; w.forEach(f => f());
});
function modal(title, inner, opts = {}) {
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal"><div class="modal-h"><h2>${esc(title)}</h2><button class="x" data-close aria-label="Luk">✕</button></div>${inner}</div>`;
  pushLayer(bg); opts.onMount?.($('.modal', bg));
  return $('.modal', bg);
}

/* ---------- Formularer ---------- */
function vehicleOptions(sel) {
  return live('vehicles').map(v => `<option value="${v.id}" ${v.id === sel ? 'selected' : ''}>${esc(v.name)}</option>`).join('');
}
function needVehicle() { if (!live('vehicles').length) { toast('Opret først et køretøj'); vehicleForm(); return true; } return false; }

function vehicleForm(id) {
  const v = id ? { ...byId('vehicles', id) } : { id: uid(), name: '', fuel: 'Benzin' };
  const m = modal(id ? 'Rediger køretøj' : 'Nyt køretøj', `<form>
    <div class="fgrid">
      <div class="f full"><label>Navn *</label><input name="name" required value="${esc(v.name)}" placeholder="F.eks. Peugeot 208"></div>
      <div class="f"><label>Mærke</label><input name="make" value="${esc(v.make)}"></div>
      <div class="f"><label>Model</label><input name="model" value="${esc(v.model)}"></div>
      <div class="f"><label>Årgang</label><input name="year" type="number" inputmode="numeric" value="${esc(v.year)}"></div>
      <div class="f"><label>Nummerplade</label><input name="plate" value="${esc(v.plate)}" style="text-transform:uppercase"></div>
      <div class="f"><label>Stelnummer (VIN)</label><input name="vin" value="${esc(v.vin)}"></div>
      <div class="f"><label>Drivmiddel</label><select name="fuel">${FUELS.map(f => `<option ${f === v.fuel ? 'selected' : ''}>${f}</option>`).join('')}</select></div>
      ${id ? '' : `<div class="f full"><label>Nuværende kilometerstand</label><input name="km" type="number" inputmode="numeric" placeholder="F.eks. 142500"></div>`}
      <div class="f full"><label>Noter (dækstørrelse, olietype, osv.)</label><textarea name="notes">${esc(v.notes)}</textarea></div>
    </div>
    <div class="modal-actions">${id ? '<button type="button" class="btn danger" data-del>Slet</button><span class="spacer"></span>' : ''}
      <button type="button" class="btn" data-close>Annuller</button><button class="btn primary">Gem</button></div></form>`);
  $('form', m).onsubmit = async e => {
    e.preventDefault(); const fd = new FormData(e.target);
    for (const k of ['name', 'make', 'model', 'plate', 'vin', 'fuel', 'notes']) v[k] = (fd.get(k) || '').trim();
    v.plate = v.plate.toUpperCase(); v.year = num(fd.get('year'));
    if (!v.createdAt) v.createdAt = nowIso();
    upsert('vehicles', v);
    const km = num(fd.get('km'));
    if (!id && km != null) upsert('readings', { id: uid(), vehicleId: v.id, date: today(), km });
    await persist(); await closeLayer();
    if (!id) location.hash = '#/v/' + v.id; else render();
    toast('Gemt');
  };
  $('[data-del]', m)?.addEventListener('click', async () => {
    if (!confirm(`Slet "${v.name}" og al dens historik, påmindelser og bilag?`)) return;
    deleteVehicle(id); await persist(); await closeLayer(); location.hash = '#/vehicles'; toast('Slettet');
  });
}

function entryForm(id, preset = {}) {
  if (needVehicle()) return;
  const e = id ? { ...byId('entries', id) } : { id: uid(), vehicleId: preset.vehicleId || lastVehicle(), type: preset.type || 'service',
    date: today(), title: preset.title || '', reminderIds: preset.reminderIds || [], km: null, cost: null };
  if (!id && e.km == null) e.km = null;
  const pending = []; // nye filer: {rec}
  const existing = id ? filesOf('entry', id) : [];
  const removed = new Set();
  const m = modal(id ? 'Rediger registrering' : 'Ny udgift / service', `<form>
    <div class="fgrid">
      <div class="f"><label>Køretøj</label><select name="vehicleId">${vehicleOptions(e.vehicleId)}</select></div>
      <div class="f"><label>Kategori</label><select name="type">${Object.entries(TYPES).map(([k, t]) => `<option value="${k}" ${k === e.type ? 'selected' : ''}>${t.icon} ${t.label}</option>`).join('')}</select></div>
      <div class="f full"><label>Beskrivelse</label><input name="title" value="${esc(e.title)}" placeholder="F.eks. Olie + filter, 5W-30"></div>
      <div class="f"><label>Dato</label><input name="date" type="date" required value="${esc(e.date)}"></div>
      <div class="f"><label>Kilometerstand</label><input name="km" type="number" inputmode="numeric" value="${e.km ?? ''}" placeholder=""></div>
      <div class="f"><label>Beløb (kr.)</label><input name="cost" type="number" step="any" inputmode="decimal" value="${e.cost ?? ''}"></div>
      <div class="f fuelonly"><label>Liter / kWh</label><input name="liters" type="number" step="any" inputmode="decimal" value="${e.liters ?? ''}"></div>
      <div class="f notfuel"><label>Værksted / sted</label><input name="workshop" value="${esc(e.workshop)}"></div>
      <div class="f full"><label>Noter</label><textarea name="notes">${esc(e.notes)}</textarea></div>
      <div class="f full rems"></div>
      <div class="f full"><label>Kvitteringer og bilag</label>
        <div class="fl"></div>
        <div class="row" style="margin-top:6px">
          <label class="btn sm">📷 Tag billede<input type="file" accept="image/*" capture="environment" hidden data-pick></label>
          <label class="btn sm">📎 Vælg fil<input type="file" accept="image/*,application/pdf" multiple hidden data-pick></label>
        </div></div>
    </div>
    <div class="modal-actions">${id ? '<button type="button" class="btn danger" data-del>Slet</button><span class="spacer"></span>' : ''}
      <button type="button" class="btn" data-close>Annuller</button><button class="btn primary">Gem</button></div></form>`);
  const form = $('form', m);
  const kmInput = form.km;
  const refresh = () => {
    const vid = form.vehicleId.value; const type = form.type.value;
    $$('.fuelonly', m).forEach(x => x.style.display = type === 'fuel' ? '' : 'none');
    $$('.notfuel', m).forEach(x => x.style.display = type === 'fuel' ? 'none' : '');
    const cur = currentKm(vid); kmInput.placeholder = cur != null ? 'Senest: ' + fmtNum(cur) : '';
    const rems = live('reminders').filter(r => r.vehicleId === vid);
    $('.rems', m).innerHTML = rems.length && type !== 'fuel' ? `<label>Udført vedligehold (nulstiller påmindelsen)</label>` +
      rems.map(r => `<label class="check"><input type="checkbox" name="rem" value="${r.id}" ${(e.reminderIds || []).includes(r.id) ? 'checked' : ''}> ${esc(r.name)}</label>`).join('') : '';
  };
  const drawFiles = () => {
    const list = [...existing.filter(f => !removed.has(f.id)), ...pending];
    $('.fl', m).innerHTML = list.length ? fileChips(list, true) : '<span class="muted small">Ingen bilag endnu</span>';
  };
  form.vehicleId.onchange = refresh; form.type.onchange = refresh;
  $$('.rems', m)[0].addEventListener('change', ev => { if (ev.target.name === 'rem') e.reminderIds = $$('input[name=rem]:checked', m).map(x => x.value); });
  $$('[data-pick]', m).forEach(inp => inp.onchange = async () => {
    for (const file of inp.files) { const f = await compressImage(file); pending.push({ id: 'p' + uid(), name: f.name, mime: f.type, size: f.size, _file: f }); }
    inp.value = ''; drawFiles();
  });
  $('.fl', m).addEventListener('click', ev => {
    const rm = ev.target.closest('[data-act=removeFile]');
    if (rm) { ev.stopPropagation(); const fid = rm.dataset.id; const i = pending.findIndex(p => p.id === fid);
      if (i >= 0) pending.splice(i, 1); else removed.add(fid); drawFiles(); return; }
    const op = ev.target.closest('[data-act=openFile]');
    if (op && op.dataset.id.startsWith('p')) { ev.stopPropagation(); const p = pending.find(x => x.id === op.dataset.id);
      if (p) { const u = URL.createObjectURL(p._file); window.open(u, '_blank'); } }
  }, true);
  refresh(); drawFiles();
  form.onsubmit = async ev => {
    ev.preventDefault(); const fd = new FormData(form);
    e.vehicleId = fd.get('vehicleId'); e.type = fd.get('type'); e.title = fd.get('title').trim(); e.date = fd.get('date');
    e.km = num(fd.get('km')); e.cost = num(fd.get('cost')); e.liters = e.type === 'fuel' ? num(fd.get('liters')) : null;
    e.workshop = (fd.get('workshop') || '').trim(); e.notes = fd.get('notes').trim();
    e.reminderIds = e.type === 'fuel' ? [] : fd.getAll('rem');
    const cur = currentKm(e.vehicleId);
    if (e.km != null && cur != null && e.km < cur && !id && !confirm(`Kilometerstanden (${fmtNum(e.km)}) er lavere end den seneste (${fmtNum(cur)}). Gem alligevel?`)) return;
    if (!e.createdAt) e.createdAt = nowIso();
    upsert('entries', e);
    for (const fid of removed) softDelete('files', fid);
    for (const p of pending) await addFile(p._file, 'entry', e.id, 'receipt');
    localStorage.setItem('lastVehicle', e.vehicleId);
    await persist(); await closeLayer(); render(); toast('Gemt');
  };
  $('[data-del]', m)?.addEventListener('click', async () => {
    if (!confirm('Slet denne registrering og dens bilag?')) return;
    softDelete('entries', id); deleteFilesOf('entry', id); await persist(); await closeLayer(); render(); toast('Slettet');
  });
}
const lastVehicle = () => { const l = localStorage.getItem('lastVehicle'); return byId('vehicles', l) ? l : live('vehicles')[0]?.id; };

function entryView(id) {
  const e = byId('entries', id); if (!e) return;
  const t = TYPES[e.type] || TYPES.other;
  const rems = (e.reminderIds || []).map(r => byId('reminders', r)?.name).filter(Boolean);
  const m = modal(entryTitle(e), `
    <div class="row" style="margin-bottom:10px"><span class="badge b-unknown">${t.icon} ${t.label}</span><span class="muted">${esc(vehicleName(e.vehicleId))}</span></div>
    <div class="kpis" style="margin-bottom:12px">
      <div class="kpi"><div class="l">Dato</div><div class="v" style="font-size:1.05rem">${fmtDate(e.date)}</div></div>
      <div class="kpi"><div class="l">Kilometer</div><div class="v" style="font-size:1.05rem">${fmtKm(e.km)}</div></div>
      <div class="kpi"><div class="l">Beløb</div><div class="v" style="font-size:1.05rem">${e.cost != null ? fmtKr2(e.cost) : '–'}</div></div>
      ${e.liters ? `<div class="kpi"><div class="l">Liter/kWh</div><div class="v" style="font-size:1.05rem">${e.liters.toLocaleString('da-DK')}</div></div>` : ''}
    </div>
    ${e.workshop ? `<p><span class="lbl">Værksted / sted</span><br>${esc(e.workshop)}</p>` : ''}
    ${rems.length ? `<p><span class="lbl">Udført vedligehold</span><br>${rems.map(esc).join(', ')}</p>` : ''}
    ${e.notes ? `<p><span class="lbl">Noter</span><br>${esc(e.notes).replace(/\n/g, '<br>')}</p>` : ''}
    <p class="lbl">Bilag</p>${fileChips(filesOf('entry', id), false) || '<span class="muted small">Ingen bilag</span>'}
    <div class="modal-actions"><button class="btn" data-close>Luk</button><button class="btn primary" data-edit>Rediger</button></div>`);
  $('[data-edit]', m).onclick = async () => { await closeLayer(); entryForm(id); };
}

function readingForm(vid, rid) {
  if (needVehicle()) return;
  const r = rid ? { ...byId('readings', rid) } : { id: uid(), vehicleId: vid || lastVehicle(), date: today(), km: null };
  const m = modal(rid ? 'Rediger kilometerstand' : 'Registrér kilometerstand', `<form>
    <div class="f"><label>Køretøj</label><select name="vehicleId">${vehicleOptions(r.vehicleId)}</select></div>
    <div class="fgrid">
      <div class="f"><label>Dato</label><input name="date" type="date" required value="${r.date}"></div>
      <div class="f"><label>Kilometerstand</label><input name="km" type="number" inputmode="numeric" required value="${r.km ?? ''}" autofocus></div>
    </div><p class="muted small hint"></p>
    <div class="modal-actions">${rid ? '<button type="button" class="btn danger" data-del>Slet</button><span class="spacer"></span>' : ''}
      <button type="button" class="btn" data-close>Annuller</button><button class="btn primary">Gem</button></div></form>`);
  const form = $('form', m);
  const hint = () => { const c = currentKm(form.vehicleId.value); $('.hint', m).textContent = c != null ? `Seneste registrerede: ${fmtKm(c)} (${fmtDate(lastKmDate(form.vehicleId.value))})` : ''; };
  form.vehicleId.onchange = hint; hint();
  setTimeout(() => form.km.focus(), 200);
  form.onsubmit = async ev => {
    ev.preventDefault(); const fd = new FormData(form);
    r.vehicleId = fd.get('vehicleId'); r.date = fd.get('date'); r.km = num(fd.get('km'));
    const c = currentKm(r.vehicleId);
    if (!rid && c != null && r.km < c && !confirm(`${fmtNum(r.km)} km er lavere end seneste registrering (${fmtNum(c)} km). Gem alligevel?`)) return;
    upsert('readings', r); localStorage.setItem('lastVehicle', r.vehicleId);
    await persist(); await closeLayer(); render();
    const due = sortedReminders(r.vehicleId).filter(x => x.s.level === 'overdue' || x.s.level === 'soon');
    toast(due.length ? `Gemt · ${due.length} påmindelse(r) kræver opmærksomhed` : 'Kilometerstand gemt');
  };
  $('[data-del]', m)?.addEventListener('click', async () => { softDelete('readings', rid); await persist(); await closeLayer(); render(); });
}

function reminderForm(vid, rid) {
  const r = rid ? { ...byId('reminders', rid) } : { id: uid(), vehicleId: vid, name: '', intervalKm: null, intervalMonths: null, lastKm: currentKm(vid), lastDate: today() };
  const m = modal(rid ? 'Rediger påmindelse' : 'Ny påmindelse', `<form>
    ${rid ? '' : `<div class="lbl" style="margin-bottom:6px">Hurtigvalg</div><div class="chips" style="margin-bottom:14px">${REM_TEMPLATES.map((t, i) => `<button type="button" class="chip" data-t="${i}">${esc(t.name)}</button>`).join('')}</div>`}
    <div class="fgrid">
      <div class="f full"><label>Navn *</label><input name="name" required value="${esc(r.name)}" placeholder="F.eks. Olieskift"></div>
      <div class="f"><label>Interval, km</label><input name="intervalKm" type="number" inputmode="numeric" value="${r.intervalKm ?? ''}" placeholder="F.eks. 15000"></div>
      <div class="f"><label>Interval, måneder</label><input name="intervalMonths" type="number" inputmode="numeric" value="${r.intervalMonths ?? ''}" placeholder="F.eks. 12"></div>
      <div class="f full"><p class="muted small" style="margin:0">Det, der kommer først, gælder. Sidst udført opdateres automatisk, når du registrerer en service og sætter flueben ved påmindelsen.</p></div>
      <div class="f"><label>Sidst udført ved km</label><input name="lastKm" type="number" inputmode="numeric" value="${r.lastKm ?? ''}"></div>
      <div class="f"><label>Sidst udført dato</label><input name="lastDate" type="date" value="${r.lastDate || ''}"></div>
      <div class="f full"><label>Noter</label><input name="notes" value="${esc(r.notes)}" placeholder="F.eks. 4,25 L 5W-30, filter nr. ..."></div>
    </div>
    <div class="modal-actions">${rid ? '<button type="button" class="btn danger" data-del>Slet</button><span class="spacer"></span>' : ''}
      <button type="button" class="btn" data-close>Annuller</button><button class="btn primary">Gem</button></div></form>`);
  const form = $('form', m);
  $$('[data-t]', m).forEach(b => b.onclick = () => { const t = REM_TEMPLATES[b.dataset.t];
    form.name.value = t.name; form.intervalKm.value = t.intervalKm ?? ''; form.intervalMonths.value = t.intervalMonths ?? ''; });
  form.onsubmit = async ev => {
    ev.preventDefault(); const fd = new FormData(form);
    r.name = fd.get('name').trim(); r.intervalKm = num(fd.get('intervalKm')); r.intervalMonths = num(fd.get('intervalMonths'));
    r.lastKm = num(fd.get('lastKm')); r.lastDate = fd.get('lastDate') || null; r.notes = fd.get('notes').trim();
    if (!r.intervalKm && !r.intervalMonths) { toast('Angiv et interval i km og/eller måneder'); return; }
    upsert('reminders', r); await persist(); await closeLayer(); render(); toast('Gemt');
  };
  $('[data-del]', m)?.addEventListener('click', async () => { if (!confirm('Slet påmindelsen?')) return; softDelete('reminders', rid); await persist(); await closeLayer(); render(); });
}

function docForm(vid) {
  const m = modal('Tilføj dokument', `<form>
    <div class="f"><label>Titel</label><input name="label" placeholder="F.eks. Instruktionsbog, Servicemanual, Registreringsattest"></div>
    <div class="f"><label>Fil (PDF eller billede)</label><input name="file" type="file" accept="application/pdf,image/*" required></div>
    <p class="muted small">Store PDF-filer kan tage lidt tid at uploade til Google Drive. Appen uploader i baggrunden.</p>
    <div class="modal-actions"><button type="button" class="btn" data-close>Annuller</button><button class="btn primary">Gem</button></div></form>`);
  $('form', m).onsubmit = async ev => {
    ev.preventDefault(); const fd = new FormData(ev.target); const file = fd.get('file'); if (!file || !file.size) return;
    await addFile(file, 'vehicle', vid, 'manual', fd.get('label').trim() || file.name.replace(/\.[^.]+$/, ''));
    await persist(); await closeLayer(); render(); toast('Dokument gemt');
  };
}

function quickAdd() {
  const vid = currentRoute().vid;
  const m = modal('Ny registrering', `<div class="quick">
    <button data-q="entry"><span>🧾</span><div><b>Udgift / service</b><div class="muted small">Værksted, reservedele, forsikring, brændstof …</div></div></button>
    <button data-q="km"><span>🔢</span><div><b>Kilometerstand</b><div class="muted small">Hold styr på kørsel og kommende service</div></div></button>
    <button data-q="vehicle"><span>🚗</span><div><b>Nyt køretøj</b><div class="muted small">Bil, motorcykel, trailer, traktor …</div></div></button>
  </div>`);
  $$('[data-q]', m).forEach(b => b.onclick = async () => {
    await closeLayer();
    ({ entry: () => entryForm(null, { vehicleId: vid }), km: () => readingForm(vid), vehicle: () => vehicleForm() })[b.dataset.q]();
  });
}

/* ---------- Visninger ---------- */
function currentRoute() {
  const h = location.hash.replace(/^#\/?/, '');
  const [a, b] = h.split('/');
  if (a === 'v' && b) return { name: 'vehicle', vid: b };
  return { name: a || 'home' };
}
const view = () => $('#view');
function setTitle(t, nav) {
  $('#pageTitle').textContent = t; document.title = t + ' · Køretøjslog';
  $$('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === nav));
}
function render() {
  const r = currentRoute();
  const keepScroll = window.scrollY;
  if (r.name === 'vehicle') renderVehicle(r.vid);
  else if (r.name === 'vehicles') renderVehicles();
  else if (r.name === 'reports') renderReports();
  else if (r.name === 'settings') renderSettings();
  else renderHome();
  if (render._last === location.hash) window.scrollTo(0, keepScroll); else window.scrollTo(0, 0);
  render._last = location.hash;
  renderSync();
}

function storageBanner() {
  if (Drive.enabled()) return '';
  return `<div class="banner">Dine data gemmes kun på denne enhed. <a href="#/settings">Forbind Google Drive</a> for backup og synkronisering mellem tablet og telefon.</div>`;
}
function remItem(r, s, showVehicle) {
  return `<div class="item rem ${s.level}" data-act="editReminder" data-id="${r.id}">
    <div class="body"><div class="row between"><span class="t">${esc(r.name)}${showVehicle ? ` <span class="muted small">· ${esc(vehicleName(r.vehicleId))}</span>` : ''}</span>
    <span class="badge b-${s.level}">${LEVEL_TXT[s.level]}</span></div>
    <div class="s">${remText(s)}</div><div class="bar"><i style="width:${Math.round(s.progress * 100)}%"></i></div>
    <div class="row" style="margin-top:8px"><button class="btn sm" data-act="doneReminder" data-id="${r.id}">✓ Registrér udført</button></div></div></div>`;
}
function yearCost(vid, year) { return live('entries').filter(e => (!vid || e.vehicleId === vid) && e.date.startsWith(year)).reduce((a, e) => a + (e.cost || 0), 0); }

function renderHome() {
  setTitle('Oversigt', 'home');
  const vs = live('vehicles');
  if (!vs.length) {
    view().innerHTML = storageBanner() + `<div class="empty"><div class="e">🚗</div><h2>Velkommen til Køretøjslog</h2>
      <p>Start med at oprette dit første køretøj.</p><button class="btn primary" data-act="addVehicle">＋ Tilføj køretøj</button>
      ${!Drive.enabled() ? '<p class="small" style="margin-top:20px">Har du allerede data på Google Drive fra en anden enhed? <a href="#/settings">Forbind Google Drive</a> først.</p>' : ''}</div>`;
    return;
  }
  const y = today().slice(0, 4);
  const rems = sortedReminders().filter(x => x.s.level !== 'ok').slice(0, 8);
  const upcoming = rems.length ? rems : sortedReminders().slice(0, 3);
  const recent = live('entries').sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
  view().innerHTML = storageBanner() + `
    <div class="row no-print" style="margin-bottom:14px"><button class="btn primary" data-act="addEntry">🧾 Udgift / service</button><button class="btn" data-act="addReading">🔢 Kilometerstand</button></div>
    <div class="two-col"><div>
      <h2 style="margin-top:0">Dine køretøjer</h2>
      <div class="grid">${vs.map(v => vehicleCard(v, y)).join('')}</div>
      <h2>Seneste registreringer</h2>
      <div class="list">${recent.length ? recent.map(e => entryItem(e, true)).join('') : '<p class="muted">Ingen endnu.</p>'}</div>
    </div><div>
      <h2 style="margin-top:0">${rems.length ? 'Kræver opmærksomhed' : 'Kommende vedligehold'}</h2>
      <div class="list">${upcoming.length ? upcoming.map(x => remItem(x.r, x.s, vs.length > 1)).join('') : '<p class="muted small">Ingen påmindelser oprettet. Åbn et køretøj og tilføj f.eks. olieskift.</p>'}</div>
      <h2>Udgifter ${y}</h2>
      <div class="kpis"><div class="kpi"><div class="l">I alt</div><div class="v">${fmtKr(yearCost(null, y))}</div></div>
      <div class="kpi"><div class="l">Sidste år</div><div class="v">${fmtKr(yearCost(null, String(y - 1)))}</div></div></div>
    </div></div>`;
}
function vehicleCard(v, y) {
  const top = sortedReminders(v.id)[0]; const km = currentKm(v.id); const lk = lastKmDate(v.id);
  return `<div class="card click" data-act="goVehicle" data-id="${v.id}">
    <div class="row between"><h3>${esc(v.name)}</h3>${v.plate ? `<span class="badge b-unknown">${esc(v.plate)}</span>` : ''}</div>
    <div class="muted small">${esc([v.make, v.model, v.year].filter(Boolean).join(' '))}</div>
    <div class="row between" style="margin-top:8px"><span class="big-km">${fmtKm(km)}</span><span class="muted small">${lk ? 'pr. ' + fmtDate(lk) : ''}</span></div>
    ${top ? `<div class="small" style="margin-top:6px"><span class="badge b-${top.s.level}">${esc(top.r.name)}</span> <span class="muted">${remText(top.s).split(' · ')[0] || ''}</span></div>` : ''}
    <div class="muted small" style="margin-top:6px">Udgifter i år: <b>${fmtKr(yearCost(v.id, y))}</b></div></div>`;
}
function entryItem(e, showVehicle) {
  const t = TYPES[e.type] || TYPES.other; const nf = filesOf('entry', e.id).length;
  return `<div class="item" data-act="viewEntry" data-id="${e.id}"><div class="ic">${t.icon}</div>
    <div class="body"><div class="t">${esc(entryTitle(e))}</div>
    <div class="s">${fmtDate(e.date)}${e.km != null ? ' · ' + fmtKm(e.km) : ''}${showVehicle ? ' · ' + esc(vehicleName(e.vehicleId)) : ''}${e.workshop ? ' · ' + esc(e.workshop) : ''}${nf ? ` · 📎${nf}` : ''}</div></div>
    <div class="amt">${e.cost != null ? fmtKr(e.cost) : ''}</div></div>`;
}

function renderVehicles() {
  setTitle('Køretøjer', 'vehicles');
  const vs = live('vehicles'); const y = today().slice(0, 4);
  view().innerHTML = storageBanner() + `<div class="row" style="margin-bottom:14px"><button class="btn primary" data-act="addVehicle">＋ Tilføj køretøj</button></div>
    ${vs.length ? `<div class="grid">${vs.map(v => vehicleCard(v, y)).join('')}</div>` : '<div class="empty"><div class="e">🚗</div><p>Ingen køretøjer endnu.</p></div>'}`;
}

const vTab = {}; const vSearch = {};
function renderVehicle(id) {
  const v = byId('vehicles', id);
  if (!v) { view().innerHTML = '<div class="empty">Køretøjet findes ikke. <a href="#/vehicles">Tilbage</a></div>'; setTitle('Køretøj', 'vehicles'); return; }
  setTitle(v.name, 'vehicles');
  const wide = isWide();
  let tab = vTab[id] || 'history';
  if (wide && (tab === 'reminders' || tab === 'docs')) tab = 'history';
  const km = currentKm(id); const kpd = kmPerDay(id); const y = today().slice(0, 4);
  const tabs = wide ? [['history', 'Historik'], ['km', 'Kilometer']] : [['history', 'Historik'], ['reminders', 'Vedligehold'], ['km', 'Km'], ['docs', 'Dokumenter']];
  const panel = { history: historyPanel(v), km: kmPanel(v), reminders: remindersPanel(v), docs: docsPanel(v) };
  view().innerHTML = `
    <div class="card">
      <div class="row between"><div><div class="muted small">${esc([v.make, v.model, v.year, v.fuel].filter(Boolean).join(' · '))}${v.plate ? ' · <b>' + esc(v.plate) + '</b>' : ''}</div>
        <div class="big-km">${fmtKm(km)}</div><div class="muted small">${kpd ? `ca. ${fmtNum(kpd * 365)} km/år` : 'Registrér km jævnligt for at beregne forventet kørsel'}</div></div>
        <div class="row no-print"><button class="btn" data-act="addReading" data-id="${id}">🔢 Km</button><button class="btn primary" data-act="addEntry" data-id="${id}">🧾 Registrér</button><button class="btn" data-act="editVehicle" data-id="${id}" aria-label="Rediger">✏️</button></div></div>
      <div class="kpis" style="margin-top:12px">
        <div class="kpi"><div class="l">Udgifter i år</div><div class="v">${fmtKr(yearCost(id, y))}</div></div>
        <div class="kpi"><div class="l">Udgifter i alt</div><div class="v">${fmtKr(yearCost(id, ''))}</div></div>
        <div class="kpi"><div class="l">Registreringer</div><div class="v">${live('entries').filter(e => e.vehicleId === id).length}</div></div>
      </div>
      ${v.notes ? `<p class="small" style="margin:10px 0 0;white-space:pre-wrap">${esc(v.notes)}</p>` : ''}
      ${v.vin ? `<p class="muted small" style="margin:6px 0 0">VIN: ${esc(v.vin)}</p>` : ''}
    </div>
    <div class="${wide ? 'two-col' : ''}"><div>
      <div class="tabs">${tabs.map(([k, l]) => `<button class="${k === tab ? 'on' : ''}" data-act="tab" data-id="${id}" data-tab="${k}">${l}</button>`).join('')}</div>
      <div id="vpanel">${panel[tab]}</div>
    </div>${wide ? `<div><h2>Vedligehold</h2>${panel.reminders}<h2>Dokumenter og manualer</h2>${panel.docs}</div>` : ''}</div>`;
  const s = $('#hsearch'); if (s) { s.oninput = () => { vSearch[id] = s.value; $('#hlist').innerHTML = historyList(v); }; }
}
function historyList(v) {
  const q = (vSearch[v.id] || '').toLowerCase();
  const es = live('entries').filter(e => e.vehicleId === v.id)
    .filter(e => !q || [entryTitle(e), e.notes, e.workshop, TYPES[e.type]?.label].join(' ').toLowerCase().includes(q))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.km || 0) - (a.km || 0));
  if (!es.length) return `<p class="muted">${q ? 'Intet matcher søgningen.' : 'Ingen registreringer endnu. Tryk “Registrér” for at tilføje service, reparationer eller udgifter.'}</p>`;
  let out = '', year = null;
  for (const e of es) {
    const y = e.date.slice(0, 4);
    if (y !== year) { year = y; out += `<div class="year-h"><span>${y}</span><span>${fmtKr(es.filter(x => x.date.startsWith(y)).reduce((a, x) => a + (x.cost || 0), 0))}</span></div>`; }
    out += entryItem(e, false);
  }
  return `<div class="list">${out}</div>`;
}
function historyPanel(v) {
  return `<input id="hsearch" type="search" placeholder="Søg i historik …" value="${esc(vSearch[v.id] || '')}" style="margin-bottom:10px"><div id="hlist">${historyList(v)}</div>`;
}
function kmPanel(v) {
  const rs = live('readings').filter(r => r.vehicleId === v.id).sort((a, b) => b.date.localeCompare(a.date) || b.km - a.km);
  const pts = kmPoints(v.id);
  return `${pts.length >= 2 ? `<div class="card chart" style="margin-bottom:12px">${lineChart(pts)}</div>` : ''}
    <div class="row" style="margin-bottom:10px"><button class="btn" data-act="addReading" data-id="${v.id}">＋ Registrér kilometerstand</button></div>
    <div class="list">${rs.length ? rs.map(r => `<div class="item" data-act="editReading" data-id="${r.id}"><div class="ic">🔢</div>
      <div class="body"><div class="t">${fmtKm(r.km)}</div><div class="s">${fmtDate(r.date)}</div></div></div>`).join('') : '<p class="muted">Ingen kilometeraflæsninger endnu. Kilometerstand fra registreringer tæller også med.</p>'}</div>`;
}
function remindersPanel(v) {
  const rs = sortedReminders(v.id);
  return `<div class="list">${rs.map(x => remItem(x.r, x.s, false)).join('') || '<p class="muted small">Ingen påmindelser endnu.</p>'}</div>
    <div class="row" style="margin-top:10px"><button class="btn" data-act="addReminder" data-id="${v.id}">＋ Tilføj påmindelse</button></div>`;
}
function docsPanel(v) {
  const fs = filesOf('vehicle', v.id);
  return `<div class="list">${fs.map(f => `<div class="item" data-act="openFile" data-id="${f.id}"><div class="ic">${fileIcon(f)}</div>
    <div class="body"><div class="t">${esc(f.label || f.name)}</div><div class="s">${esc(f.name)} · ${fmtSize(f.size)}${f.driveId ? '' : ' · venter på upload'}</div></div>
    <button class="btn sm danger" data-act="deleteDoc" data-id="${f.id}" aria-label="Slet">🗑</button></div>`).join('') || '<p class="muted small">Gem f.eks. instruktionsbog, servicemanual eller registreringsattest her.</p>'}</div>
    <div class="row" style="margin-top:10px"><button class="btn" data-act="addDoc" data-id="${v.id}">＋ Tilføj dokument</button></div>`;
}

/* ---------- Diagrammer ---------- */
function lineChart(pts) {
  const W = 600, H = 200, P = { l: 52, r: 12, t: 12, b: 26 };
  const t0 = parseD(pts[0].date).getTime(), t1 = Math.max(parseD(pts[pts.length - 1].date).getTime(), t0 + 864e5);
  const k0 = Math.min(...pts.map(p => p.km)), k1 = Math.max(...pts.map(p => p.km), k0 + 1);
  const x = d => P.l + (parseD(d).getTime() - t0) / (t1 - t0) * (W - P.l - P.r);
  const yy = k => H - P.b - (k - k0) / (k1 - k0) * (H - P.t - P.b);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${yy(p.km).toFixed(1)}`).join('');
  const ticks = [0, .5, 1].map(f => k0 + (k1 - k0) * f);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Kilometerstand over tid">
    ${ticks.map(k => `<line x1="${P.l}" x2="${W - P.r}" y1="${yy(k)}" y2="${yy(k)}" stroke="currentColor" opacity=".1"/><text x="${P.l - 6}" y="${yy(k) + 4}" text-anchor="end">${fmtNum(k)}</text>`).join('')}
    <path d="${path}" fill="none" stroke="var(--primary)" stroke-width="2.5"/>
    ${pts.map(p => `<circle cx="${x(p.date)}" cy="${yy(p.km)}" r="3" fill="var(--primary)"><title>${fmtDate(p.date)}: ${fmtKm(p.km)}</title></circle>`).join('')}
    <text x="${P.l}" y="${H - 6}">${fmtDate(pts[0].date)}</text><text x="${W - P.r}" y="${H - 6}" text-anchor="end">${fmtDate(pts[pts.length - 1].date)}</text></svg>`;
}
function barChart(buckets, cats) {
  const W = 640, H = 230, P = { l: 56, r: 8, t: 10, b: 30 };
  const max = Math.max(1, ...buckets.map(b => b.total));
  const bw = (W - P.l - P.r) / buckets.length;
  const yy = v => (v / max) * (H - P.t - P.b);
  const ticks = [0, .5, 1].map(f => max * f);
  const every = Math.ceil(buckets.length / 12);
  let bars = '';
  buckets.forEach((b, i) => {
    let y0 = H - P.b;
    for (const c of cats) { const v = b.by[c] || 0; if (!v) continue; const h = yy(v); y0 -= h;
      bars += `<rect x="${(P.l + i * bw + bw * .15).toFixed(1)}" y="${y0.toFixed(1)}" width="${(bw * .7).toFixed(1)}" height="${h.toFixed(1)}" fill="${TYPES[c].color}"><title>${b.label}: ${TYPES[c].label} ${fmtKr(v)}</title></rect>`; }
    if (i % every === 0) bars += `<text x="${P.l + i * bw + bw / 2}" y="${H - 10}" text-anchor="middle">${b.short}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Udgifter over tid">
    ${ticks.map(t => `<line x1="${P.l}" x2="${W - P.r}" y1="${H - P.b - yy(t)}" y2="${H - P.b - yy(t)}" stroke="currentColor" opacity=".1"/><text x="${P.l - 6}" y="${H - P.b - yy(t) + 4}" text-anchor="end">${fmtNum(t)}</text>`).join('')}
    ${bars}</svg><div class="legend">${cats.map(c => `<span><i style="background:${TYPES[c].color}"></i>${TYPES[c].label}</span>`).join('')}</div>`;
}

/* ---------- Rapporter ---------- */
const rf = { vehicle: '', period: 'thisYear', from: '', to: '', cats: new Set(Object.keys(TYPES)), q: '' };
function periodRange() {
  const t = today(), y = +t.slice(0, 4);
  switch (rf.period) {
    case 'thisYear': return [y + '-01-01', t];
    case 'lastYear': return [(y - 1) + '-01-01', (y - 1) + '-12-31'];
    case '12m': return [addDays(addMonths(t, -12), 1), t];
    case 'custom': return [rf.from || '1900-01-01', rf.to || t];
    default: { const ds = live('entries').map(e => e.date).sort(); return [ds[0] || t, ds[ds.length - 1] > t ? ds[ds.length - 1] : t]; }
  }
}
function kmDriven(vid, from, to) {
  const pts = kmPoints(vid); const inR = pts.filter(p => p.date >= from && p.date <= to); if (!inR.length) return 0;
  const before = pts.filter(p => p.date < from).pop();
  const max = Math.max(...inR.map(p => p.km)); const base = before ? before.km : Math.min(...inR.map(p => p.km));
  return Math.max(0, max - base);
}
function reportEntries() {
  const [from, to] = periodRange(); const q = rf.q.toLowerCase();
  return live('entries').filter(e => (!rf.vehicle || e.vehicleId === rf.vehicle) && e.date >= from && e.date <= to && rf.cats.has(e.type)
    && (!q || [entryTitle(e), e.notes, e.workshop].join(' ').toLowerCase().includes(q)))
    .sort((a, b) => b.date.localeCompare(a.date));
}
function renderReports() {
  setTitle('Rapporter', 'reports');
  const [from, to] = periodRange(); const es = reportEntries();
  const total = es.reduce((a, e) => a + (e.cost || 0), 0);
  const vids = rf.vehicle ? [rf.vehicle] : live('vehicles').map(v => v.id);
  const km = vids.reduce((a, v) => a + kmDriven(v, from, to), 0);
  const months = Math.max(1, daysBetween(from, to) / 30.44);
  // Buckets
  const byMonth = months <= 25;
  const buckets = []; const bmap = {};
  if (byMonth) { let d = from.slice(0, 7) + '-01'; while (d <= to) { const k = d.slice(0, 7); const b = { key: k, label: fmtMonth(d), short: parseD(d).toLocaleDateString('da-DK', { month: 'short' }).replace('.', ''), total: 0, by: {} }; buckets.push(b); bmap[k] = b; d = addMonths(d, 1); } }
  else { for (let y = +from.slice(0, 4); y <= +to.slice(0, 4); y++) { const b = { key: String(y), label: String(y), short: String(y), total: 0, by: {} }; buckets.push(b); bmap[y] = b; } }
  const byCat = {}; const byVeh = {};
  for (const e of es) { const c = e.cost || 0; const b = bmap[byMonth ? e.date.slice(0, 7) : e.date.slice(0, 4)];
    if (b) { b.total += c; b.by[e.type] = (b.by[e.type] || 0) + c; }
    byCat[e.type] = (byCat[e.type] || 0) + c; byVeh[e.vehicleId] = (byVeh[e.vehicleId] || 0) + c; }
  const cats = Object.keys(TYPES).filter(c => byCat[c]);
  const catMax = Math.max(1, ...Object.values(byCat));
  const periods = [['thisYear', 'I år'], ['12m', 'Seneste 12 mdr.'], ['lastYear', 'Sidste år'], ['all', 'Alt'], ['custom', 'Vælg periode']];
  view().innerHTML = `
    <div class="card no-print">
      <div class="fgrid">
        <div class="f"><label class="lbl">Køretøj</label><select id="rVeh"><option value="">Alle køretøjer</option>${vehicleOptions(rf.vehicle)}</select></div>
        <div class="f"><label class="lbl">Periode</label><select id="rPer">${periods.map(([k, l]) => `<option value="${k}" ${k === rf.period ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        ${rf.period === 'custom' ? `<div class="f"><label class="lbl">Fra</label><input type="date" id="rFrom" value="${rf.from}"></div><div class="f"><label class="lbl">Til</label><input type="date" id="rTo" value="${rf.to}"></div>` : ''}
      </div>
      <div class="lbl" style="margin-bottom:6px">Kategorier</div>
      <div class="chips">${Object.entries(TYPES).map(([k, t]) => `<button class="chip ${rf.cats.has(k) ? 'on' : ''}" data-act="rCat" data-id="${k}">${t.icon} ${t.label}</button>`).join('')}
        <button class="chip" data-act="rCatAll">Alle / ingen</button></div>
      <div class="row" style="margin-top:12px"><input id="rQ" type="search" placeholder="Søg (f.eks. bremser, værkstedsnavn)" value="${esc(rf.q)}" class="grow" style="flex:1;min-width:180px">
        <button class="btn" data-act="exportCsv">⤓ CSV (Excel)</button><button class="btn" data-act="print">🖨️ Udskriv / PDF</button></div>
    </div>
    <div class="print-only"><h2>${esc(rf.vehicle ? vehicleName(rf.vehicle) : 'Alle køretøjer')} · ${fmtDate(from)} – ${fmtDate(to)}</h2></div>
    <h2>Nøgletal <span class="muted small">(${fmtDate(from)} – ${fmtDate(to)})</span></h2>
    <div class="kpis">
      <div class="kpi"><div class="l">Udgifter i alt</div><div class="v">${fmtKr(total)}</div></div>
      <div class="kpi"><div class="l">Pr. måned</div><div class="v">${fmtKr(total / months)}</div></div>
      <div class="kpi"><div class="l">Kørt</div><div class="v">${fmtKm(km)}</div></div>
      <div class="kpi"><div class="l">Pr. km</div><div class="v">${km ? fmtKr2(total / km) : '–'}</div></div>
      <div class="kpi"><div class="l">Registreringer</div><div class="v">${es.length}</div></div>
    </div>
    ${total ? `<div class="two-col" style="margin-top:4px"><div><h2>Udgifter pr. ${byMonth ? 'måned' : 'år'}</h2><div class="card chart">${barChart(buckets, cats)}</div></div>
    <div><h2>Fordeling</h2><div class="card">${cats.sort((a, b) => byCat[b] - byCat[a]).map(c => `<div class="hbar"><span>${TYPES[c].icon} ${TYPES[c].label}</span>
      <span class="track"><i style="width:${byCat[c] / catMax * 100}%;background:${TYPES[c].color}"></i></span><span class="nowrap"><b>${fmtKr(byCat[c])}</b> <span class="muted small">${Math.round(byCat[c] / total * 100)}%</span></span></div>`).join('')}</div>
      ${!rf.vehicle && live('vehicles').length > 1 ? `<h2>Pr. køretøj</h2><div class="card"><table class="t"><tr><th>Køretøj</th><th class="n">Kørt</th><th class="n">Udgifter</th><th class="n">Pr. km</th></tr>
      ${live('vehicles').map(v => { const k = kmDriven(v.id, from, to); const c = byVeh[v.id] || 0; return `<tr><td>${esc(v.name)}</td><td class="n">${fmtKm(k)}</td><td class="n">${fmtKr(c)}</td><td class="n">${k ? fmtKr2(c / k) : '–'}</td></tr>`; }).join('')}</table></div>` : ''}
    </div></div>` : ''}
    <h2>Historik (${es.length})</h2>
    <div class="card scroll-x"><table class="t"><tr><th>Dato</th>${rf.vehicle ? '' : '<th>Køretøj</th>'}<th>Kategori</th><th>Beskrivelse</th><th class="n">Km</th><th class="n">Beløb</th></tr>
      ${es.map(e => `<tr data-act="viewEntry" data-id="${e.id}" style="cursor:pointer"><td class="nowrap">${fmtDate(e.date)}</td>${rf.vehicle ? '' : `<td>${esc(vehicleName(e.vehicleId))}</td>`}
        <td class="nowrap">${TYPES[e.type]?.icon || ''} ${TYPES[e.type]?.label || ''}</td><td>${esc(entryTitle(e))}${filesOf('entry', e.id).length ? ' 📎' : ''}</td>
        <td class="n">${e.km != null ? fmtNum(e.km) : ''}</td><td class="n">${e.cost != null ? fmtKr2(e.cost) : ''}</td></tr>`).join('') || `<tr><td colspan="6" class="muted">Ingen registreringer i perioden.</td></tr>`}
      ${es.length ? `<tr><td colspan="${rf.vehicle ? 4 : 5}"><b>I alt</b></td><td class="n"><b>${fmtKr2(total)}</b></td></tr>` : ''}</table></div>
    ${rf.vehicle ? serviceSummary(rf.vehicle) : ''}`;
  $('#rVeh').onchange = e => { rf.vehicle = e.target.value; render(); };
  $('#rPer').onchange = e => { rf.period = e.target.value; render(); };
  $('#rFrom') && ($('#rFrom').onchange = e => { rf.from = e.target.value; render(); });
  $('#rTo') && ($('#rTo').onchange = e => { rf.to = e.target.value; render(); });
  $('#rQ').onchange = e => { rf.q = e.target.value; render(); };
}
function serviceSummary(vid) {
  const rs = sortedReminders(vid); if (!rs.length) return '';
  return `<h2>Vedligeholdsstatus</h2><div class="card scroll-x"><table class="t"><tr><th>Punkt</th><th>Interval</th><th>Sidst udført</th><th>Næste</th><th>Status</th></tr>
    ${rs.map(({ r, s }) => `<tr><td>${esc(r.name)}</td><td class="nowrap">${[r.intervalKm ? fmtKm(r.intervalKm) : '', r.intervalMonths ? r.intervalMonths + ' mdr.' : ''].filter(Boolean).join(' / ')}</td>
      <td class="nowrap">${s.lastDate ? fmtDate(s.lastDate) : '–'}${s.lastKm != null ? ' · ' + fmtKm(s.lastKm) : ''}</td>
      <td class="nowrap">${[s.nextKm != null ? fmtKm(s.nextKm) : '', s.nextDate ? fmtDate(s.nextDate) : ''].filter(Boolean).join(' / ')}</td>
      <td><span class="badge b-${s.level}">${LEVEL_TXT[s.level]}</span></td></tr>`).join('')}</table></div>`;
}
function exportCsv() {
  const es = reportEntries();
  const cell = v => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const dec = n => n == null ? '' : String(n).replace('.', ',');
  const rows = [['Dato', 'Køretøj', 'Kategori', 'Beskrivelse', 'Kilometer', 'Beløb (kr)', 'Liter/kWh', 'Værksted/sted', 'Udført vedligehold', 'Noter', 'Antal bilag']];
  for (const e of es) rows.push([e.date, vehicleName(e.vehicleId), TYPES[e.type]?.label, entryTitle(e), e.km ?? '', dec(e.cost), dec(e.liters), e.workshop,
    (e.reminderIds || []).map(r => byId('reminders', r)?.name).filter(Boolean).join(', '), e.notes, filesOf('entry', e.id).length]);
  const csv = '﻿' + rows.map(r => r.map(cell).join(';')).join('\r\n');
  download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `koretojslog-${today()}.csv`);
}

/* ---------- Indstillinger ---------- */
function renderSettings() {
  setTitle('Indstillinger', 'settings');
  const en = Drive.enabled(); const last = localStorage.getItem('lastSync');
  const pendingUp = live('files').filter(f => !f.driveId).length;
  view().innerHTML = `
    <div class="card"><h3>☁️ Google Drive</h3>
      <p class="muted small">Alle data og bilag gemmes i mappen <b>${ROOT_FOLDER}</b> på dit Google Drive, så tablet og telefon altid er synkroniseret. Appen kan kun se de filer, den selv har oprettet.</p>
      <div class="f"><label class="lbl">Google OAuth Client ID</label><input id="cid" value="${esc(Drive.clientId())}" placeholder="xxxxxxxx.apps.googleusercontent.com"></div>
      ${en ? `<p>Status: <b>${{ ok: 'Synkroniseret', syncing: 'Synkroniserer…', auth: 'Login udløbet', error: 'Fejl', local: '' }[Sync.state]}</b>${last ? ` · sidst ${new Date(last).toLocaleString('da-DK')}` : ''}
        ${Sync.err ? `<br><span class="small" style="color:var(--bad)">${esc(Sync.err)}</span>` : ''}${pendingUp ? `<br><span class="small muted">${pendingUp} fil(er) venter på upload</span>` : ''}</p>
        <div class="row"><button class="btn primary" data-act="syncNow">⟳ Synkronisér nu</button>${Sync.state === 'auth' ? '<button class="btn" data-act="connect">Log ind igen</button>' : ''}
        ${Drive.ids.root ? `<a class="btn" href="https://drive.google.com/drive/folders/${Drive.ids.root}" target="_blank" rel="noopener">Åbn mappe i Drive</a>` : ''}
        <button class="btn danger" data-act="disconnect">Afbryd</button></div>`
      : `<button class="btn primary" data-act="connect">Forbind Google Drive</button>`}
    </div>
    <div class="card" style="margin-top:14px"><h3>💾 Backup</h3>
      <p class="muted small">Eksportér alle registreringer som en JSON-fil (uden bilag), eller importér en tidligere backup. Import fletter med eksisterende data.</p>
      <div class="row"><button class="btn" data-act="exportJson">⤓ Eksportér data</button><label class="btn">⤒ Importér<input type="file" accept="application/json,.json" hidden id="imp"></label></div>
    </div>
    <div class="card" style="margin-top:14px"><h3>📲 Installation</h3>
      <p class="muted small">Åbn appens adresse i Chrome, tryk på ⋮-menuen og vælg <b>Installér app</b> / <b>Føj til startskærm</b>. Gør det samme på telefonen, og forbind til samme Google-konto.</p>
      <p class="muted small">Version ${APP_VERSION}</p>
    </div>`;
  $('#cid').onchange = e => { localStorage.setItem('clientId', e.target.value.trim()); toast('Client ID gemt'); };
  $('#imp').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { const d = JSON.parse(await f.text()); if (!d.vehicles) throw new Error('Ugyldig fil');
      data = merge(data, d); await persist(); render(); toast('Data importeret'); } catch (err) { toast('Import fejlede: ' + err.message); }
  };
}

/* ---------- Handlinger ---------- */
const ACT = {
  quickAdd: () => quickAdd(),
  addVehicle: () => vehicleForm(),
  editVehicle: d => vehicleForm(d.id),
  goVehicle: d => { location.hash = '#/v/' + d.id; },
  addEntry: d => entryForm(null, { vehicleId: d.id }),
  viewEntry: d => entryView(d.id),
  addReading: d => readingForm(d.id),
  editReading: d => readingForm(null, d.id),
  addReminder: d => reminderForm(d.id),
  editReminder: d => reminderForm(null, d.id),
  doneReminder: d => { const r = byId('reminders', d.id); entryForm(null, { vehicleId: r.vehicleId, type: 'service', title: r.name, reminderIds: [r.id] }); },
  addDoc: d => docForm(d.id),
  openFile: d => openFile(d.id),
  deleteDoc: async d => { const f = byId('files', d.id); if (!confirm(`Slet "${f.label || f.name}"?`)) return; softDelete('files', d.id); await persist(); render(); },
  tab: d => { vTab[d.id] = d.tab; render(); },
  rCat: d => { rf.cats.has(d.id) ? rf.cats.delete(d.id) : rf.cats.add(d.id); render(); },
  rCatAll: () => { rf.cats = rf.cats.size === Object.keys(TYPES).length ? new Set() : new Set(Object.keys(TYPES)); render(); },
  exportCsv: () => exportCsv(),
  print: () => window.print(),
  connect: () => connectDrive(),
  syncNow: () => Drive.hasToken() ? Sync.run().then(render) : connectDrive(),
  syncPill: () => { if (Sync.state === 'auth') connectDrive(); else if (Sync.state === 'local') location.hash = '#/settings'; else Sync.run().then(render); },
  disconnect: () => { if (!confirm('Afbryd forbindelsen til Google Drive? Data bliver liggende både på denne enhed og på Drive.')) return;
    Drive.logout(); localStorage.removeItem('mode'); Drive.ids = {}; Drive.saveIds(); Sync.set('local'); render(); },
  exportJson: () => download(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }), `koretojslog-backup-${today()}.json`),
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  if (el.closest('.modal') && (el.dataset.act === 'removeFile')) return; // håndteres i formularen
  const fn = ACT[el.dataset.act]; if (!fn) return;
  e.preventDefault(); e.stopPropagation(); fn(el.dataset, el);
});

/* ---------- Opstart ---------- */
async function start() {
  try { const d = await DB.get('kv', 'data'); if (d) data = merge(emptyData(), d); } catch (e) { console.error(e); toast('Kunne ikke læse lokale data'); }
  window.addEventListener('hashchange', render);
  matchMedia('(min-width: 840px)').addEventListener('change', render);
  render();
  if (Drive.enabled()) { Sync.run(); } else Sync.set('local');
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Drive.enabled() && Drive.hasToken()) Sync.run(); });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(console.warn);
}
start();
