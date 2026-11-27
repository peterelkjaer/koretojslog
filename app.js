/* Motorist (tidl. Køretøjslog) – vedligeholdelse, udgifter, ture og kilometer. Data gemmes lokalt og synkroniseres til Google Drive. */
'use strict';

const APP_VERSION = '2.0.0';
/* Kører vi som Android-app (APK)? Så bruges Androids eget Google-login, deling og udskrift. */
const IS_NATIVE = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
const NativePl = name => {
  if (!IS_NATIVE) return null;
  try {
    const C = window.Capacitor;
    if (typeof C.registerPlugin === 'function') return C.registerPlugin(name);
    return (C.Plugins && C.Plugins[name]) || null;
  } catch (e) { console.error('Plugin ' + name, e); return null; }
};
const NH = NativePl('NativeHelper'), NFs = NativePl('Filesystem'), NShare = NativePl('Share'), NBars = NativePl('SystemBars');
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
const KINDS = { car: { label: 'Bil', icon: '🚗' }, mc: { label: 'Motorcykel', icon: '🏍️' }, other: { label: 'Andet', icon: '🚜' } };
const vIcon = v => (KINDS[v?.kind] || KINDS.car).icon;
const MONTHS = ['januar', 'februar', 'marts', 'april', 'maj', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'december'];
const INTERVALS = { month: { m: 1, label: 'Hver måned' }, quarter: { m: 3, label: 'Hvert kvartal' }, half: { m: 6, label: 'Hvert halve år' }, year: { m: 12, label: 'Hvert år' } };
const TIRE_POS = { front: 'Foran', rear: 'Bag', set: 'Hele sættet' };
const PART_CATS = ['Filtre', 'Olie og væsker', 'Bremser', 'Tænding', 'Lys og pærer', 'Kæde og transmission', 'Dæk og hjul', 'Elektrisk', 'Andet'];
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
const COLLS = ['vehicles', 'entries', 'readings', 'reminders', 'files', 'recurring', 'tires', 'parts', 'trips', 'places'];

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
const fmtDec = (n, d = 1) => n.toLocaleString('da-DK', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtSize = b => b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' kB';
const isWide = () => matchMedia('(min-width: 840px)').matches;
/* Fold-ud-sektioner: appen husker, hvad der var åbent */
const FOLDS = (() => { try { return JSON.parse(localStorage.getItem('folds') || '{}'); } catch (e) { return {}; } })();
function fold(key, title, body, def = false, extra = '') {
  const open = key in FOLDS ? FOLDS[key] : def;
  return `<details class="fold" data-fold="${key}" ${open ? 'open' : ''}><summary><span class="fold-t">${title}</span>${extra ? `<span class="fold-x">${extra}</span>` : ''}</summary><div class="fold-b">${body}</div></details>`;
}
let printing = false;
document.addEventListener('toggle', e => { const d = e.target; if (!printing && d.dataset && d.dataset.fold) { FOLDS[d.dataset.fold] = d.open; localStorage.setItem('folds', JSON.stringify(FOLDS)); } }, true);
/* Funktioner, der kan slås fra */
const FEATURES = [['tires', '🛞 Dæk'], ['parts', '🔩 Reservedele'], ['recurring', '📅 Faste udgifter'], ['work', '🏢 Arbejdsture'], ['seasons', '📆 Sæsonstatistik'], ['range', '⛽ Rækkevidde']];
const featState = () => { try { return JSON.parse(localStorage.getItem('features') || '{}'); } catch (e) { return {}; } };
const feat = k => featState()[k] !== false;
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms); }
const blobToBase64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
async function download(blob, name) {
  if (IS_NATIVE) { // Gem i appens midlertidige mappe og åbn Androids "Del"-menu (gem i Filer, Drive, mail, PDF-læser …)
    try {
      const safe = name.replace(/[\\/:*?"<>|]/g, '_');
      const { uri } = await NFs.writeFile({ path: safe, data: await blobToBase64(blob), directory: 'CACHE' });
      await NShare.share({ title: safe, files: [uri], dialogTitle: 'Gem eller del' });
    } catch (e) { if (!/cancel/i.test(e.message || '')) toast('Kunne ikke dele filen: ' + e.message, 4000); }
    return;
  }
  downloadWeb(blob, name);
}
function downloadWeb(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000); }
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Kunne ikke hente ' + src)); document.head.appendChild(s); }); }

/* ---------- Tema ---------- */
const darkMq = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const t = localStorage.getItem('theme') || 'auto';
  const dark = t === 'dark' || (t === 'auto' && darkMq.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#0d1b2c' : '#1e3a5f');
  if (NBars) try {
    Promise.resolve(NBars.setStyle({ style: dark ? 'DARK' : 'LIGHT', bar: 'StatusBar' })).catch(() => {});
    Promise.resolve(NBars.setStyle({ style: 'DARK', bar: 'NavigationBar' })).catch(() => {});
  } catch (e) { console.warn(e); }
  const b = document.getElementById('themeBtn'); if (b) { b.textContent = dark ? '☀️' : '🌙'; b.title = dark ? 'Skift til lyst tema' : 'Skift til mørkt tema'; }
}
function setTheme(t) { localStorage.setItem('theme', t); applyTheme(); }
darkMq.addEventListener('change', applyTheme);

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
const emptyData = () => ({ schema: 1, vehicles: [], entries: [], readings: [], reminders: [], files: [], recurring: [], tires: [], parts: [], trips: [], places: [] });
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
  for (const c of ['entries', 'readings', 'reminders', 'recurring', 'tires', 'parts', 'trips']) for (const x of live(c)) if (x.vehicleId === id) {
    softDelete(c, x.id); if (c === 'entries') deleteFilesOf('entry', x.id); }
}
async function persist() { await DB.set('kv', 'data', data); Sync.schedule(); pushCarDataSoon(); }
/* Øjebliksbillede til Android Auto-skærmen (kun i Android-appen) */
let carTimer = null;
function pushCarDataSoon() { if (!IS_NATIVE) return; clearTimeout(carTimer); carTimer = setTimeout(pushCarData, 800); }
function pushCarData() {
  if (!IS_NATIVE || !NH || !NH.setCarData) return;
  try {
    segCache = null;
    const vehicles = activeVehicles().map(v => {
      const r = fuelRange(v.id);
      return { id: v.id, name: v.name, address: (v.btAddress || '').toUpperCase(), manual: ('MANUAL-' + v.id).toUpperCase(),
        km: currentKm(v.id), factor: v.kmFactor || 1, range: r && feat('range') ? r.range : null,
        reminders: sortedReminders(v.id).filter(x => x.s.level !== 'unknown').map(x => ({ nextKm: x.s.nextKm, nextDate: x.s.nextDate })) };
    });
    const json = JSON.stringify({ updated: Date.now(), warnKm: +(localStorage.getItem('aaWarnKm') || 1000), warnDays: +(localStorage.getItem('aaWarnDays') || 30),
      speedLimit: localStorage.getItem('aaSpeedLimit') !== '0',
      sounds: { over: localStorage.getItem('aaSndOver') !== '0', ahead: localStorage.getItem('aaSndAhead') !== '0', service: localStorage.getItem('aaSndService') !== '0' }, vehicles });
    Promise.resolve(NH.setCarData({ json })).catch(() => {});
  } catch (e) { console.warn('pushCarData', e); }
}

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
  const pts = [], auto = [];
  for (const r of live('readings')) if (r.vehicleId === vid && r.km != null)
    (r.auto ? auto : pts).push({ date: r.date, km: r.km, t: r.createdAt || r.updatedAt || '', end: (() => { const te = r.tripEnd || (r.tripId && data.trips.find(x => x.id === r.tripId)?.endTs); return te ? new Date(te).toISOString() : (r.createdAt || r.updatedAt || ''); })() });
  for (const e of live('entries')) if (e.vehicleId === vid && e.km != null) pts.push({ date: e.date, km: e.km, t: e.createdAt || e.updatedAt || '' });
  // En automatisk (GPS-)aflæsning tæller ikke, hvis en manuel kilometerstand er indtastet efter, at turen sluttede
  // (så er turens kilometer allerede med i det indtastede tal) – også selvom turen først blev hentet senere.
  for (const a of auto) if (!pts.some(m => m.t > a.end && m.date >= a.date)) pts.push({ ...a, t: a.end });
  // Rækkefølge: dato, derefter tidspunktet for registreringen (seneste sidst)
  return pts.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : (a.t || '') < (b.t || '') ? -1 : (a.t || '') > (b.t || '') ? 1 : a.km - b.km);
}
// Den aktuelle kilometerstand er den senest registrerede – så en rettelse nedad også slår igennem
function currentKm(vid) { const p = kmPoints(vid); return p.length ? p[p.length - 1].km : null; }
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
/* Brændstofforbrug: fuld tank til fuld tank. Delvise tankninger lægges til næste fulde. */
let segCache = null;
function fuelSegs() {
  if (segCache) return segCache;
  segCache = { byEntry: {}, byVehicle: {} };
  for (const v of live('vehicles')) {
    const fs = live('entries').filter(e => e.vehicleId === v.id && e.type === 'fuel' && e.km != null && e.liters > 0)
      .sort((a, b) => a.km - b.km || a.date.localeCompare(b.date));
    const segs = []; let lastKm = null, acc = 0;
    for (const e of fs) {
      const full = e.fullTank !== false;
      if (lastKm != null) {
        acc += e.liters;
        if (full) { const d = e.km - lastKm; if (d > 0) { const s = { entryId: e.id, date: e.date, km: d, liters: acc, kml: d / acc, cost: e.cost }; segs.push(s); segCache.byEntry[e.id] = s; } acc = 0; lastKm = e.km; }
      } else if (full) { lastKm = e.km; acc = 0; }
    }
    segCache.byVehicle[v.id] = segs;
  }
  return segCache;
}
const fuelUnit = vid => byId('vehicles', vid)?.fuel === 'El' ? 'km/kWh' : 'km/l';
const volUnit = vid => byId('vehicles', vid)?.fuel === 'El' ? 'kWh' : 'l';
function avgKml(vid, from = '0000', to = '9999') {
  const segs = (fuelSegs().byVehicle[vid] || []).filter(s => s.date >= from && s.date <= to);
  const km = segs.reduce((a, s) => a + s.km, 0), l = segs.reduce((a, s) => a + s.liters, 0);
  return l ? { kml: km / l, n: segs.length, km, liters: l } : null;
}
/* Ejerskabsøkonomi: købspris + alle udgifter − salgspris (eller anslået værdi) */
function ownership(v) {
  if (v.buyPrice == null && v.sellPrice == null) return null;
  const expenses = live('entries').filter(e => e.vehicleId === v.id).reduce((a, e) => a + (e.cost || 0), 0);
  const sold = v.sellPrice != null || !!v.sellDate;
  const endValue = sold ? v.sellPrice : v.estValue;
  const total = (v.buyPrice || 0) + expenses - (endValue || 0);
  const end = v.sellDate || today();
  const months = v.buyDate ? Math.max(1, daysBetween(v.buyDate, end) / 30.44) : null;
  const pts = kmPoints(v.id);
  const kmStart = v.buyKm ?? (pts.length ? Math.min(...pts.map(p => p.km)) : null);
  const kmEnd = v.sellKm ?? currentKm(v.id);
  const km = kmStart != null && kmEnd != null && kmEnd > kmStart ? kmEnd - kmStart : null;
  return { expenses, sold, endValue, total, months, km, hasEnd: endValue != null };
}
function fmtDuration(months) {
  const y = Math.floor(months / 12), mo = Math.round(months % 12);
  return [y ? `${y} år` : '', mo ? `${mo} mdr.` : ''].filter(Boolean).join(' ') || 'under 1 md.';
}
function economyCard(v) {
  const o = ownership(v);
  if (!o) return `<div class="card" style="margin-top:14px"><div class="row between"><h3>💰 Købs- og salgspris</h3><button class="btn sm" data-act="editVehicle" data-id="${v.id}">Angiv købspris</button></div>
    <p class="muted small" style="margin:6px 0 0">Indtast købspris og evt. salgspris eller anslået værdi, så kan du se, hvad køretøjet reelt har kostet dig.</p></div>`;
  const label = o.sold ? 'Samlet pris for ejerskabet' : (o.hasEnd ? 'Reel pris indtil nu' : 'Brugt indtil nu');
  return `<div class="card" style="margin-top:14px"><div class="row between"><h3>💰 Hvad har den kostet?</h3>${o.sold ? '<span class="badge b-unknown">Solgt</span>' : ''}</div>
    <table class="money" style="margin-top:6px">
      <tr><td>Købspris${v.buyDate ? ` <span class="muted small">(${fmtDate(v.buyDate)})</span>` : ''}</td><td class="n">${fmtKr2(v.buyPrice || 0)}</td></tr>
      <tr><td>+ Udgifter i alt</td><td class="n">${fmtKr2(o.expenses)}</td></tr>
      ${o.hasEnd ? `<tr><td>− ${o.sold ? 'Salgspris' : 'Anslået værdi i dag'}${o.sold && v.sellDate ? ` <span class="muted small">(${fmtDate(v.sellDate)})</span>` : ''}</td><td class="n">${fmtKr2(o.endValue)}</td></tr>` : ''}
      <tr class="sum"><td>= ${label}</td><td class="n">${fmtKr2(o.total)}</td></tr>
    </table>
    <div class="kpis" style="margin-top:12px">
      ${o.months ? `<div class="kpi"><div class="l">${o.sold ? 'Ejet i' : 'Ejet indtil nu'}</div><div class="v" style="font-size:1.05rem">${fmtDuration(o.months)}</div></div>
      <div class="kpi"><div class="l">Pr. måned</div><div class="v">${fmtKr(o.total / o.months)}</div></div>` : ''}
      ${o.km ? `<div class="kpi"><div class="l">Kørt i ejertiden</div><div class="v" style="font-size:1.05rem">${fmtKm(o.km)}</div></div>
      <div class="kpi"><div class="l">Pr. km</div><div class="v">${fmtKr2(o.total / o.km)}</div></div>` : ''}
    </div>
    ${!o.hasEnd ? '<p class="muted small" style="margin:10px 0 0">Tip: Angiv en anslået værdi i dag (✏️ Rediger), så tæller værditabet med i stedet for hele købsprisen.</p>' : ''}
    ${!v.buyDate ? '<p class="muted small" style="margin:6px 0 0">Angiv købsdato for at se pris pr. måned.</p>' : ''}</div>`;
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
  async login(interactive = true) {
    if (IS_NATIVE) {
      try {
        const r = await NH.authorize({ scopes: [SCOPE], interactive });
        this.token = r.accessToken; this.exp = Date.now() + 50 * 60 * 1000; // Google-tokens gælder ca. 1 time
        localStorage.setItem('tok', JSON.stringify({ t: this.token, e: this.exp }));
        return;
      } catch (e) {
        if (!interactive) throw new NeedAuth();
        throw new Error(e.message || 'Login fejlede');
      }
    }
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
  // Sørger for et gyldigt token. I Android-appen fornyes det lydløst uden at spørge brugeren.
  async ensureToken() {
    if (this.hasToken()) return;
    if (IS_NATIVE && localStorage.getItem('mode') === 'drive') return this.login(false);
    throw new NeedAuth();
  },
  async api(url, opts = {}, retried = false) {
    await this.ensureToken();
    const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + this.token } });
    if (r.status === 401) { this.token = null; localStorage.removeItem('tok');
      if (IS_NATIVE && !retried && !(opts.body instanceof ReadableStream)) return this.api(url, opts, true);
      throw new NeedAuth(); }
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
      await Drive.ensureToken();
      try { await Drive.init(); } catch (e) { if (e.status === 404) { Drive.ids = {}; await Drive.init(); } else throw e; }
      await this.pushFiles();
      const remote = await Drive.readData();
      const merged = remote ? merge(data, remote) : data;
      if (!remote || sig(merged) !== sig(remote)) await Drive.writeData(merged);
      const fresh = merge(data, merged); // bevar evt. ændringer lavet mens vi synkroniserede
      if (sig(fresh) !== sig(data)) { data = fresh; generateRecurring(); await DB.set('kv', 'data', data); render(); }
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
  try { await Drive.ensureToken(); } catch { throw new Error('Log ind på Google Drive for at hente filen.'); }
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
const isSold = v => !!(v && (v.sellDate || v.sellPrice != null));
const activeVehicles = () => live('vehicles').filter(v => !isSold(v));
const isActiveId = id => { const v = byId('vehicles', id); return !!v && !isSold(v); };
// Solgte køretøjer vises kun i valglister, hvis de allerede er valgt (eller i rapporter)
function vehicleOptions(sel, includeSold) {
  return live('vehicles').filter(v => includeSold || !isSold(v) || v.id === sel).map(v => `<option value="${v.id}" ${v.id === sel ? 'selected' : ''}>${esc(v.name)}</option>`).join('');
}
function needVehicle() { if (!activeVehicles().length) { toast('Opret først et køretøj'); vehicleForm(); return true; } return false; }

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
      <div class="f"><label>Type</label><select name="kind">${Object.entries(KINDS).map(([k, t]) => `<option value="${k}" ${k === (v.kind || 'car') ? 'selected' : ''}>${t.icon} ${t.label}</option>`).join('')}</select></div>
      <div class="f"><label>Tankstørrelse (liter / kWh)</label><input name="tankSize" type="number" step="any" inputmode="decimal" value="${v.tankSize ?? ''}" placeholder="Bruges til rækkevidde"></div>
      <div class="f full"><label>Sæsonen starter i</label><select name="seasonStart">${MONTHS.map((mn, i) => `<option value="${i + 1}" ${(v.seasonStart || 1) === i + 1 ? 'selected' : ''}>${mn[0].toUpperCase() + mn.slice(1)}${i === 0 ? ' (kalenderår)' : ''}</option>`).join('')}</select></div>
      ${id ? '' : `<div class="f full"><label>Nuværende kilometerstand</label><input name="km" type="number" inputmode="numeric" placeholder="F.eks. 142500"></div>`}
      <div class="f full"><label>Noter (dækstørrelse, olietype, osv.)</label><textarea name="notes">${esc(v.notes)}</textarea></div>
      <div class="f full"><h3 style="margin-top:6px">💰 Køb og salg <span class="muted small" style="font-weight:400">(valgfrit)</span></h3></div>
      <div class="f"><label>Købsdato</label><input name="buyDate" type="date" value="${esc(v.buyDate)}"></div>
      <div class="f"><label>Købspris (kr.)</label><input name="buyPrice" type="number" step="any" inputmode="decimal" value="${v.buyPrice ?? ''}"></div>
      <div class="f"><label>Km ved køb</label><input name="buyKm" type="number" inputmode="numeric" value="${v.buyKm ?? ''}"></div>
      <div class="f"><label>Anslået værdi i dag (kr.)</label><input name="estValue" type="number" step="any" inputmode="decimal" value="${v.estValue ?? ''}" placeholder="Hvis ikke solgt"></div>
      <div class="f"><label>Salgsdato</label><input name="sellDate" type="date" value="${esc(v.sellDate)}"></div>
      <div class="f"><label>Salgspris (kr.)</label><input name="sellPrice" type="number" step="any" inputmode="decimal" value="${v.sellPrice ?? ''}"></div>
      <div class="f"><label>Km ved salg</label><input name="sellKm" type="number" inputmode="numeric" value="${v.sellKm ?? ''}"></div>
    </div>
    <div class="modal-actions">${id ? '<button type="button" class="btn danger" data-del>Slet</button><span class="spacer"></span>' : ''}
      <button type="button" class="btn" data-close>Annuller</button><button class="btn primary">Gem</button></div></form>`);
  $('form', m).onsubmit = async e => {
    e.preventDefault(); const fd = new FormData(e.target);
    for (const k of ['name', 'make', 'model', 'plate', 'vin', 'fuel', 'notes']) v[k] = (fd.get(k) || '').trim();
    v.plate = v.plate.toUpperCase(); v.year = num(fd.get('year'));
    for (const k of ['buyPrice', 'buyKm', 'estValue', 'sellPrice', 'sellKm', 'tankSize', 'seasonStart']) v[k] = num(fd.get(k));
    v.kind = fd.get('kind') || 'car';
    v.buyDate = fd.get('buyDate') || null; v.sellDate = fd.get('sellDate') || null;
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
      <div class="f full fuelonly"><label class="check" style="font-weight:400;color:var(--fg)"><input type="checkbox" name="fullTank" ${e.fullTank !== false ? 'checked' : ''}> Fuld tank (bruges til at beregne forbrug)</label>
        <span class="muted small priceHint"></span></div>
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
  const priceHint = () => { const c = num(form.cost.value), l = num(form.liters.value);
    $('.priceHint', m).textContent = c && l ? `= ${fmtDec(c / l, 2)} kr. pr. ${volUnit(form.vehicleId.value)}` : 'Husk kilometerstand og liter ved hver tankning.'; };
  form.cost.oninput = priceHint; form.liters.oninput = priceHint; priceHint();
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
    e.km = num(fd.get('km')); e.cost = num(fd.get('cost')); e.liters = e.type === 'fuel' ? num(fd.get('liters')) : null; e.fullTank = e.type === 'fuel' ? fd.get('fullTank') === 'on' : undefined;
    e.workshop = (fd.get('workshop') || '').trim(); e.notes = fd.get('notes').trim();
    e.reminderIds = e.type === 'fuel' ? [] : fd.getAll('rem');
    const cur = currentKm(e.vehicleId);
    if (e.km != null && cur != null && e.km < cur && !id && !confirm(`Kilometerstanden (${fmtNum(e.km)}) er lavere end den seneste (${fmtNum(cur)}). Gem alligevel?`)) return;
    if (!e.createdAt) e.createdAt = nowIso();
    if (e.km != null && !id) calibrate(e.vehicleId, e.date, e.km, e.createdAt);
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
const lastVehicle = () => { const l = localStorage.getItem('lastVehicle'); return isActiveId(l) ? l : activeVehicles()[0]?.id; };

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
    ${e.type === 'fuel' ? (() => { const s = fuelSegs().byEntry[e.id]; const parts = [];
      if (s) parts.push(`<b>${fmtDec(s.kml)} ${fuelUnit(e.vehicleId)}</b> (${fmtKm(s.km)} siden sidste fulde tank)`);
      if (e.cost && e.liters) parts.push(`${fmtDec(e.cost / e.liters, 2)} kr. pr. ${volUnit(e.vehicleId)}`);
      if (e.fullTank === false) parts.push('Delvis tankning');
      return parts.length ? `<p><span class="lbl">Forbrug</span><br>${parts.join(' · ')}</p>` : ''; })() : ''}
    ${e.recurringId ? `<p class="muted small">🔁 Oprettet automatisk af den faste udgift “${esc(byId('recurring', e.recurringId)?.title || e.title || '')}”.</p>` : ''}
    ${e.workshop ? `<p><span class="lbl">Værksted / sted</span><br>${esc(e.workshop)}</p>` : ''}
    ${rems.length ? `<p><span class="lbl">Udført vedligehold</span><br>${rems.map(esc).join(', ')}</p>` : ''}
    ${e.notes ? `<p><span class="lbl">Noter</span><br>${esc(e.notes).replace(/\n/g, '<br>')}</p>` : ''}
    <p class="lbl">Bilag</p>${fileChips(filesOf('entry', id), false) || '<span class="muted small">Ingen bilag</span>'}
    <div class="modal-actions"><button class="btn danger" data-del>🗑 Slet</button><span class="spacer"></span><button class="btn" data-close>Luk</button><button class="btn primary" data-edit>✏️ Rediger</button></div>`);
  $('[data-edit]', m).onclick = async () => { await closeLayer(); entryForm(id); };
  $('[data-del]', m).onclick = async () => {
    if (!confirm(`Slet "${entryTitle(e)}" fra ${fmtDate(e.date)}${filesOf('entry', id).length ? ' og dens bilag' : ''}?`)) return;
    softDelete('entries', id); deleteFilesOf('entry', id); await persist(); await closeLayer(); render(); toast('Slettet');
  };
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
    if (!r.createdAt) r.createdAt = nowIso(); r.auto = false;
    calibrate(r.vehicleId, r.date, r.km, r.createdAt);
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

// Køretøjet, telefonen sidst var forbundet til via Bluetooth (seneste automatiske tur)
function lastBtVehicle() {
  const t = live('trips').filter(x => isActiveId(x.vehicleId)).sort((a, b) => (b.endTs || 0) - (a.endTs || 0))[0];
  return t ? t.vehicleId : null;
}
function quickAdd() {
  if (needVehicle()) return;
  const vid = currentRoute().vid || lastBtVehicle() || lastVehicle();
  const m = modal('Ny registrering', `<div class="quick">
    <button data-q="fuel"><span>⛽</span><div><b>Optankning</b><div class="muted small">Km-stand, liter og beløb – giver km/l</div></div></button>
    <button data-q="entry"><span>🧾</span><div><b>Udgift</b><div class="muted small">Service, reparation, forsikring, afgift …</div></div></button>
    <button data-q="km"><span>🔢</span><div><b>Km-stand</b><div class="muted small">Ret eller registrér kilometerstanden</div></div></button>
  </div>${activeVehicles().length > 1 ? `<p class="muted small" style="margin:10px 2px 0">Køretøj: <b>${esc(vehicleName(vid))}</b> (kan skiftes i formularen)</p>` : ''}`);
  $$('[data-q]', m).forEach(b => b.onclick = async () => {
    await closeLayer();
    ({ fuel: () => entryForm(null, { vehicleId: vid, type: 'fuel' }), entry: () => entryForm(null, { vehicleId: vid }), km: () => readingForm(vid) })[b.dataset.q]();
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
  $('#pageTitle').textContent = t; document.title = t + ' · Motorist';
  $$('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === nav));
}
function render() {
  segCache = null;
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

const LEVEL_RANK = { overdue: 3, soon: 2, ok: 1, unknown: 0 };
// Samlet "trafiklys" for et køretøj: dårligste status blandt vedligehold (og dæk)
function vehicleLight(vid) {
  let worst = null;
  for (const x of sortedReminders(vid)) if (!worst || LEVEL_RANK[x.s.level] > LEVEL_RANK[worst]) worst = x.s.level;
  if (feat('tires')) for (const t of currentTires(vid)) { const a = tireAge(t); if (a && (!worst || LEVEL_RANK[a.level] > LEVEL_RANK[worst])) worst = a.level; }
  return worst || 'none';
}
const LIGHT_TXT = { overdue: 'Skal ordnes nu', soon: 'Snart tid', ok: 'Alt i orden', unknown: 'Mangler oplysninger', none: 'Intet vedligehold oprettet' };
function renderHome() {
  setTitle('Oversigt', 'home');
  const vs = activeVehicles();
  if (!vs.length) {
    view().innerHTML = storageBanner() + (live('vehicles').length ? `<div class="empty"><div class="e">🚗</div><h2>Ingen aktive køretøjer</h2>
      <p>Alle dine køretøjer er markeret som solgt. De ligger under <a href="#/vehicles">Køretøjer</a>.</p><button class="btn primary" data-act="addVehicle">＋ Tilføj køretøj</button></div>` : '') +
      (live('vehicles').length ? '' : `<div class="empty"><div class="e">🚗</div><h2>Velkommen til Motorist</h2>
      <p>Start med at oprette dit første køretøj.</p><button class="btn primary" data-act="addVehicle">＋ Tilføj køretøj</button>
      ${!Drive.enabled() ? '<p class="small" style="margin-top:20px">Har du allerede data på Google Drive fra en anden enhed? <a href="#/settings">Forbind Google Drive</a> først.</p>' : ''}</div>`);
    return;
  }
  const y = today().slice(0, 4);
  const rems = sortedReminders().filter(x => isActiveId(x.r.vehicleId) && (x.s.level === 'overdue' || x.s.level === 'soon'));
  const tireWarn = feat('tires') ? vs.flatMap(v => currentTires(v.id).map(t => ({ t, a: tireAge(t) }))).filter(x => x.a && x.a.level !== 'ok') : [];
  const recent = live('entries').filter(e => isActiveId(e.vehicleId)).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
  const activeCost = yr => vs.reduce((a, v) => a + yearCost(v.id, yr), 0);
  const nAtt = rems.length + tireWarn.length;
  view().innerHTML = storageBanner() + `
    ${IS_NATIVE ? '<div id="liveTrip"></div>' : ''}
    <div class="grid">${vs.map(v => vehicleCard(v, y)).join('')}</div>
    ${nAtt ? fold('h-att', '⚠️ Kræver opmærksomhed', `<div class="list">${tireWarn.map(x => tireWarnItem(x)).join('')}${rems.map(x => remItem(x.r, x.s, vs.length > 1)).join('')}</div>`, true, String(nAtt)) : ''}
    ${recent.length ? fold('h-recent', '🧾 Seneste udgifter', `<div class="list">${recent.map(e => entryItem(e, vs.length > 1)).join('')}</div>`, true) : ''}
    ${activeCost(y) || activeCost(String(y - 1)) ? fold('h-cost', '💰 Udgifter', `<div class="kpis"><div class="kpi"><div class="l">I år (${y})</div><div class="v">${fmtKr(activeCost(y))}</div></div>
      <div class="kpi"><div class="l">Sidste år</div><div class="v">${fmtKr(activeCost(String(y - 1)))}</div></div></div>`, true, fmtKr(activeCost(y))) : ''}`;
}
function vehicleCard(v, y) {
  const top = sortedReminders(v.id)[0]; const km = currentKm(v.id); const lk = lastKmDate(v.id);
  const light = isSold(v) ? 'none' : vehicleLight(v.id);
  return `<div class="card click vcard" data-act="goVehicle" data-id="${v.id}">
    <div class="row between"><h3>${vIcon(v)} ${esc(v.name)}</h3>${isSold(v) ? '<span class="badge b-soon">Solgt</span>' : `<span class="tl tl-${light}" title="${LIGHT_TXT[light]}"></span>`}</div>
    <div class="row between" style="margin-top:6px"><span class="big-km">${fmtKm(km)}</span><span class="muted small">${lk ? 'pr. ' + fmtDate(lk) : ''}</span></div>
    <div class="small tl-txt tl-c-${light}" style="margin-top:6px"><b>${LIGHT_TXT[light]}</b>${top && light !== 'ok' ? ` · ${esc(top.r.name)} ${remText(top.s).split(' · ')[0] || ''}` : top ? ` · næste: ${esc(top.r.name)}` : ''}</div>
    ${rangeLine(v.id)}</div>`;
}
function entryItem(e, showVehicle) {
  const t = TYPES[e.type] || TYPES.other; const nf = filesOf('entry', e.id).length;
  return `<div class="item" data-act="viewEntry" data-id="${e.id}"><div class="ic">${t.icon}</div>
    <div class="body"><div class="t">${esc(entryTitle(e))}</div>
    <div class="s">${fmtDate(e.date)}${e.km != null ? ' · ' + fmtKm(e.km) : ''}${showVehicle ? ' · ' + esc(vehicleName(e.vehicleId)) : ''}${e.workshop ? ' · ' + esc(e.workshop) : ''}${fuelSegs().byEntry[e.id] ? ` · <b>${fmtDec(fuelSegs().byEntry[e.id].kml)} ${fuelUnit(e.vehicleId)}</b>` : ''}${nf ? ` · 📎${nf}` : ''}</div></div>
    <div class="amt">${e.cost != null ? fmtKr(e.cost) : ''}</div></div>`;
}

function renderVehicles() {
  setTitle('Køretøjer', 'vehicles');
  const vs = activeVehicles(); const sold = live('vehicles').filter(isSold)
    .sort((a, b) => (b.sellDate || '').localeCompare(a.sellDate || '')); const y = today().slice(0, 4);
  view().innerHTML = storageBanner() + `<div class="row" style="margin-bottom:14px"><button class="btn primary" data-act="addVehicle">＋ Tilføj køretøj</button></div>
    ${vs.length ? `<div class="grid">${vs.map(v => vehicleCard(v, y)).join('')}</div>` : `<div class="empty"><div class="e">🚗</div><p>${sold.length ? 'Ingen aktive køretøjer.' : 'Ingen køretøjer endnu.'}</p></div>`}
    ${sold.length ? `<h2 style="margin-top:28px">Solgte køretøjer <span class="muted small">(${sold.length})</span></h2>
      <div class="list">${sold.map(v => { const o = ownership(v); return `<div class="item" data-act="goVehicle" data-id="${v.id}"><div class="ic">🚗</div>
        <div class="body"><div class="t">${esc(v.name)}${v.plate ? ` <span class="muted small">· ${esc(v.plate)}</span>` : ''}</div>
        <div class="s">${esc([v.make, v.model, v.year].filter(Boolean).join(' '))}${v.buyDate || v.sellDate ? ` · ejet ${v.buyDate ? fmtDate(v.buyDate) : '?'} – ${v.sellDate ? fmtDate(v.sellDate) : '?'}` : ''}</div></div>
        ${o ? `<div class="amt" title="Samlet pris for ejerskabet">${fmtKr(o.total)}</div>` : ''}</div>`; }).join('')}</div>` : ''}`;
}

const vTab = {}; const vSearch = {}; const vFilt = {};
const VTABS = [['history', '📜 Historik'], ['maint', '🔧 Vedligehold'], ['econ', '💰 Økonomi'], ['docs', '📁 Dokumenter']];
const OLD_TAB = { trips: 'history', km: 'history', reminders: 'maint', tires: 'maint', parts: 'maint', recurring: 'econ' };
function renderVehicle(id) {
  const v = byId('vehicles', id);
  if (!v) { view().innerHTML = '<div class="empty">Køretøjet findes ikke. <a href="#/vehicles">Tilbage</a></div>'; setTitle('Køretøj', 'vehicles'); return; }
  setTitle(v.name, 'vehicles');
  let tab = OLD_TAB[vTab[id]] || vTab[id] || 'history';
  if (!VTABS.some(t => t[0] === tab)) tab = 'history';
  const km = currentKm(id); const kpd = kmPerDay(id);
  const top = sortedReminders(id)[0]; const rng = feat('range') ? fuelRange(id) : null;
  const details = `<div class="muted small">${esc([v.make, v.model, v.year, v.fuel].filter(Boolean).join(' · '))}${v.plate ? ' · <b>' + esc(v.plate) + '</b>' : ''}</div>
    <p class="small" style="margin:6px 0 0">${kpd ? `Kører ca. <b>${fmtNum(kpd * 365)} km/år</b>` : 'Registrér km jævnligt for at beregne forventet kørsel'}${lastKmDate(id) ? ` · km-stand pr. ${fmtDate(lastKmDate(id))}` : ''}</p>
    ${v.vin ? `<p class="muted small" style="margin:6px 0 0">VIN: ${esc(v.vin)}</p>` : ''}
    ${v.notes ? `<p class="small" style="margin:6px 0 0;white-space:pre-wrap">${esc(v.notes)}</p>` : ''}`;
  const panels = { history: () => historyPanel(v), maint: () => maintPanel(v), econ: () => econPanel(v), docs: () => docsPanel(v) };
  view().innerHTML = `
    <div class="card vhead">
      <div class="big3">
        <div><div class="l">Km-stand</div><div class="v">${fmtKm(km)}</div></div>
        <div><div class="l">Næste vedligehold</div>${top ? `<div class="v v-sm"><span class="tl tl-${top.s.level}"></span> ${esc(top.r.name)}</div><div class="l">${remText(top.s).split(' · ')[0] || LEVEL_TXT[top.s.level]}</div>`
          : '<div class="v v-sm muted">Intet oprettet</div>'}</div>
        ${rng ? `<div><div class="l">Rækkevidde</div><div class="v"><span class="tl tl-${rng.level}"></span> ca. ${fmtNum(Math.round(rng.range / 5) * 5)} km</div></div>` : ''}
      </div>
      <div class="row no-print" style="margin-top:12px"><button class="btn" data-act="addReading" data-id="${id}">🔢 Km-stand</button><button class="btn primary" data-act="addEntry" data-id="${id}">🧾 Udgift</button><button class="btn" data-act="editVehicle" data-id="${id}">✏️ Rediger</button></div>
      ${fold('v-details', 'Vis detaljer', details, false)}
    </div>
    <div class="tabs tabs-4">${VTABS.map(([k, l]) => `<button class="${k === tab ? 'on' : ''}" data-act="tab" data-id="${id}" data-tab="${k}">${l}</button>`).join('')}</div>
    <div id="vpanel">${panels[tab]()}</div>`;
  const s = $('#hsearch'); if (s) { s.oninput = () => { vSearch[id] = s.value; $('#hlist').innerHTML = timelineList(v); }; }
  if (tab === 'history' && (vFilt[id] || 'all') === 'trips' && IS_NATIVE) renderAutoLog(v);
  const ps = $('#psearch'); if (ps) { ps.oninput = () => { pSearch[id] = ps.value; $('#plist').innerHTML = partsList(v); }; }
}
// Historik: udgifter, manuelle km-aflæsninger og ture i én tidslinje
function timelineList(v) {
  const q = (vSearch[v.id] || '').toLowerCase(); const f = vFilt[v.id] || 'all';
  const items = [];
  if (f === 'all' || f === 'entries') for (const e of live('entries').filter(e => e.vehicleId === v.id))
    if (!q || [entryTitle(e), e.notes, e.workshop, TYPES[e.type]?.label].join(' ').toLowerCase().includes(q)) items.push({ date: e.date, k: (e.km || 0), html: entryItem(e, false), cost: e.cost || 0 });
  if (f === 'all') {
    for (const r of live('readings').filter(r => r.vehicleId === v.id && !r.auto))
      if (!q || 'kilometerstand km-stand'.includes(q)) items.push({ date: r.date, k: r.km, html: `<div class="item small-item" data-act="editReading" data-id="${r.id}"><div class="ic">🔢</div><div class="body"><div class="t">Km-stand ${fmtKm(r.km)}</div><div class="s">${fmtDate(r.date)}</div></div></div>`, cost: 0 });
    for (const t of live('trips').filter(t => t.vehicleId === v.id))
      if (!q || [t.title, t.notes, 'tur'].join(' ').toLowerCase().includes(q)) items.push({ date: t.date, k: (t.startTs || 0) / 1e9, html: tripItem(t), cost: 0 });
  }
  items.sort((a, b) => b.date.localeCompare(a.date) || b.k - a.k);
  if (!items.length) return `<p class="muted">${q ? 'Intet matcher søgningen.' : 'Ingenting endnu. Tryk “🧾 Udgift” for at registrere service, reparationer eller udgifter.'}</p>`;
  let out = '', year = null;
  for (const it of items) {
    const y = it.date.slice(0, 4);
    if (y !== year) { year = y; const c = items.filter(x => x.date.startsWith(y)).reduce((a, x) => a + x.cost, 0); out += `<div class="year-h"><span>${y}</span><span>${c ? fmtKr(c) : ''}</span></div>`; }
    out += it.html;
  }
  return `<div class="list">${out}</div>`;
}
function historyPanel(v) {
  const f = vFilt[v.id] || 'all'; const hasTrips = IS_NATIVE || live('trips').some(t => t.vehicleId === v.id);
  const chips = [['all', 'Alt'], ['entries', '🧾 Udgifter'], ...(hasTrips ? [['trips', '🛣️ Ture']] : [])];
  return `<div class="chips" style="margin-bottom:10px">${chips.map(([k, l]) => `<button class="chip ${k === f ? 'on' : ''}" data-act="hFilt" data-id="${v.id}" data-f="${k}">${l}</button>`).join('')}</div>
    ${f === 'trips' ? tripsPanel(v) : `<input id="hsearch" type="search" placeholder="Søg …" value="${esc(vSearch[v.id] || '')}" style="margin-bottom:10px"><div id="hlist">${timelineList(v)}</div>`}`;
}
function maintPanel(v) {
  const rs = sortedReminders(v.id); const tires = currentTires(v.id); const parts = live('parts').filter(p => p.vehicleId === v.id);
  return fold('m-rem', '🔧 Påmindelser', remindersPanel(v), true, rs.length ? String(rs.length) : '')
    + (feat('tires') ? fold('m-tires', '🛞 Dæk', tiresPanel(v), true, tires.length ? `${tires.length} på` : '') : '')
    + (feat('parts') ? fold('m-parts', '🔩 Reservedele', partsPanel(v), false, parts.length ? String(parts.length) : '') : '');
}
function econPanel(v) {
  const id = v.id; const y = today().slice(0, 4); const a = avgKml(id); const segs = fuelSegs().byVehicle[id] || []; const last = segs[segs.length - 1];
  const recs = live('recurring').filter(r => r.vehicleId === id);
  return `<div class="kpis">
      <div class="kpi"><div class="l">Udgifter i år</div><div class="v">${fmtKr(yearCost(id, y))}</div></div>
      <div class="kpi"><div class="l">Udgifter i alt</div><div class="v">${fmtKr(yearCost(id, ''))}</div></div>
      ${a ? `<div class="kpi"><div class="l">Gns. forbrug (${a.n} tankn.)</div><div class="v">${fmtDec(a.kml)} ${fuelUnit(id)}</div>${last ? `<div class="l">Seneste: ${fmtDec(last.kml)} ${fuelUnit(id)}</div>` : ''}</div>` : ''}
    </div>
    ${economyCard(v)}
    ${feat('recurring') ? fold('e-rec', '📅 Faste udgifter', recurringPanel(v), true, recs.length ? String(recs.length) : '') : ''}
    ${segs.length ? fold('e-fuel', '⛽ Brændstofforbrug', fuelTable(id, '0000', '9999'), false) : ''}
    ${feat('seasons') ? (st => st ? fold('e-season', '📆 Sæsoner', st, false) : '')(seasonTable(id)) : ''}`;
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
    <button class="btn sm danger" data-act="deleteDoc" data-id="${f.id}" >🗑 Slet</button></div>`).join('') || '<p class="muted small">Gem f.eks. instruktionsbog, servicemanual eller registreringsattest her.</p>'}</div>
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
        <div class="f"><label class="lbl">Køretøj</label><select id="rVeh"><option value="">Alle køretøjer</option>${vehicleOptions(rf.vehicle, true)}</select></div>
        <div class="f"><label class="lbl">Periode</label><select id="rPer">${periods.map(([k, l]) => `<option value="${k}" ${k === rf.period ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        ${rf.period === 'custom' ? `<div class="f"><label class="lbl">Fra</label><input type="date" id="rFrom" value="${rf.from}"></div><div class="f"><label class="lbl">Til</label><input type="date" id="rTo" value="${rf.to}"></div>` : ''}
      </div>
      ${fold('r-filter', 'Kategorier, søgning og eksport', `      <div class="lbl" style="margin-bottom:6px">Kategorier</div>
      <div class="chips">${Object.entries(TYPES).map(([k, t]) => `<button class="chip ${rf.cats.has(k) ? 'on' : ''}" data-act="rCat" data-id="${k}">${t.icon} ${t.label}</button>`).join('')}
        <button class="chip" data-act="rCatAll">Alle / ingen</button></div>
      <div class="row" style="margin-top:12px"><input id="rQ" type="search" placeholder="Søg (f.eks. bremser, værkstedsnavn)" value="${esc(rf.q)}" class="grow" style="flex:1;min-width:180px">
        <button class="btn" data-act="exportCsv">⤓ CSV (Excel)</button><button class="btn" data-act="print">🖨️ Udskriv / PDF</button></div>`, false, rf.cats.size < Object.keys(TYPES).length || rf.q ? 'filter aktivt' : '')}
    </div>
    <div class="print-only"><h2>${esc(rf.vehicle ? vehicleName(rf.vehicle) : 'Alle køretøjer')} · ${fmtDate(from)} – ${fmtDate(to)}</h2></div>
    <h2>${rf.period === 'thisYear' ? 'Året kort fortalt' : 'Kort fortalt'} <span class="muted small">(${fmtDate(from)} – ${fmtDate(to)})</span></h2>
    <div class="kpis kpis-4">
      <div class="kpi"><div class="l">Udgifter i alt</div><div class="v">${fmtKr(total)}</div><div class="l">${fmtKr(total / months)} pr. måned</div></div>
      <div class="kpi"><div class="l">Kørt</div><div class="v">${fmtKm(km)}</div></div>
      ${(() => { let km = 0, l = 0; for (const v of vids) { const a = avgKml(v, from, to); if (a) { km += a.km; l += a.liters; } }
        return `<div class="kpi"><div class="l">Gns. forbrug</div><div class="v">${l ? fmtDec(km / l) + ' ' + (rf.vehicle ? fuelUnit(rf.vehicle) : 'km/l') : '–'}</div></div>`; })()}
      <div class="kpi"><div class="l">Pris pr. km</div><div class="v">${km ? fmtKr2(total / km) : '–'}</div></div>
    </div>
    ${total ? fold('r-month', `📊 Udgifter pr. ${byMonth ? 'måned' : 'år'}`, `<div class="card chart">${barChart(buckets, cats)}</div>`) : ''}
    ${total ? fold('r-dist', '🥧 Fordeling på kategorier', `<div class="card">${cats.sort((a, b) => byCat[b] - byCat[a]).map(c => `<div class="hbar"><span>${TYPES[c].icon} ${TYPES[c].label}</span>
      <span class="track"><i style="width:${byCat[c] / catMax * 100}%;background:${TYPES[c].color}"></i></span><span class="nowrap"><b>${fmtKr(byCat[c])}</b> <span class="muted small">${Math.round(byCat[c] / total * 100)}%</span></span></div>`).join('')}</div>`, false, cats.length + ' kategorier') : ''}
    ${total && !rf.vehicle && live('vehicles').length > 1 ? fold('r-veh', '🚗 Pr. køretøj', `<div class="card"><table class="t"><tr><th>Køretøj</th><th class="n">Kørt</th><th class="n">Udgifter</th><th class="n">Pr. km</th></tr>
      ${live('vehicles').map(v => { const k = kmDriven(v.id, from, to); const c = byVeh[v.id] || 0; return `<tr><td>${esc(v.name)}</td><td class="n">${fmtKm(k)}</td><td class="n">${fmtKr(c)}</td><td class="n">${k ? fmtKr2(c / k) : '–'}</td></tr>`; }).join('')}</table></div>`) : ''}
    ${fold('r-list', '🧾 Alle udgifter', `<div class="card scroll-x"><table class="t"><tr><th>Dato</th>${rf.vehicle ? '' : '<th>Køretøj</th>'}<th>Kategori</th><th>Beskrivelse</th><th class="n">Km</th><th class="n">Beløb</th></tr>
      ${es.map(e => `<tr data-act="viewEntry" data-id="${e.id}" style="cursor:pointer"><td class="nowrap">${fmtDate(e.date)}</td>${rf.vehicle ? '' : `<td>${esc(vehicleName(e.vehicleId))}</td>`}
        <td class="nowrap">${TYPES[e.type]?.icon || ''} ${TYPES[e.type]?.label || ''}</td><td>${esc(entryTitle(e))}${filesOf('entry', e.id).length ? ' 📎' : ''}</td>
        <td class="n">${e.km != null ? fmtNum(e.km) : ''}</td><td class="n">${e.cost != null ? fmtKr2(e.cost) : ''}</td></tr>`).join('') || `<tr><td colspan="6" class="muted">Ingen udgifter i perioden.</td></tr>`}
      ${es.length ? `<tr><td colspan="${rf.vehicle ? 4 : 5}"><b>I alt</b></td><td class="n"><b>${fmtKr2(total)}</b></td></tr>` : ''}</table></div>`, false, `${es.length} · ${fmtKr(total)}`)}
    ${rf.vehicle ? (() => { const st = feat('seasons') ? seasonTable(rf.vehicle) : ''; const ft = fuelTable(rf.vehicle, from, to); const ss = serviceSummary(rf.vehicle);
      return (st ? fold('r-season', '📆 Sæsoner', st) : '') + (ft ? fold('r-fuel', '⛽ Brændstofforbrug', ft) : '') + (ss ? fold('r-service', '🔧 Vedligeholdsstatus', ss) : ''); })()
      : '<p class="muted small" style="margin-top:14px">Vælg et køretøj øverst for at se sæsoner, brændstofforbrug og vedligeholdsstatus.</p>'}
    ${feat('work') ? workReport() : ''}`;
  $('#rVeh').onchange = e => { rf.vehicle = e.target.value; render(); };
  $('#rPer').onchange = e => { rf.period = e.target.value; render(); };
  $('#rFrom') && ($('#rFrom').onchange = e => { rf.from = e.target.value; render(); });
  $('#rTo') && ($('#rTo').onchange = e => { rf.to = e.target.value; render(); });
  $('#rQ').onchange = e => { rf.q = e.target.value; render(); };
}
function fuelTable(vid, from, to) {
  const segs = (fuelSegs().byVehicle[vid] || []).filter(s => s.date >= from && s.date <= to);
  if (!segs.length) return '';
  const u = fuelUnit(vid), vu = volUnit(vid);
  const pts = segs.map(s => ({ date: s.date, km: s.kml }));
  return `<div class="two-col">
    <div>${segs.length >= 2 ? `<div class="card chart">${kmlChart(pts, u)}</div>` : ''}</div>
    <div class="card scroll-x"><table class="t"><tr><th>Dato</th><th class="n">Kørt</th><th class="n">${vu === 'l' ? 'Liter' : 'kWh'}</th><th class="n">Pris pr. ${vu}</th><th class="n">${u}</th></tr>
    ${segs.slice().reverse().map(s => { const e = byId('entries', s.entryId); return `<tr data-act="viewEntry" data-id="${s.entryId}" style="cursor:pointer"><td class="nowrap">${fmtDate(s.date)}</td>
      <td class="n">${fmtKm(s.km)}</td><td class="n">${fmtDec(s.liters, 2)}</td><td class="n">${e?.cost && e?.liters ? fmtDec(e.cost / e.liters, 2) + ' kr.' : ''}</td><td class="n"><b>${fmtDec(s.kml)}</b></td></tr>`; }).join('')}</table></div></div>`;
}
function kmlChart(pts, unit) {
  const W = 600, H = 180, P = { l: 40, r: 12, t: 12, b: 26 };
  const t0 = parseD(pts[0].date).getTime(), t1 = Math.max(parseD(pts[pts.length - 1].date).getTime(), t0 + 864e5);
  const vals = pts.map(p => p.km); const k0 = Math.floor(Math.min(...vals) - 1), k1 = Math.ceil(Math.max(...vals) + 1);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const x = d => P.l + (parseD(d).getTime() - t0) / (t1 - t0) * (W - P.l - P.r);
  const yy = k => H - P.b - (k - k0) / (k1 - k0) * (H - P.t - P.b);
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Forbrug over tid">
    ${[k0, (k0 + k1) / 2, k1].map(k => `<line x1="${P.l}" x2="${W - P.r}" y1="${yy(k)}" y2="${yy(k)}" stroke="currentColor" opacity=".1"/><text x="${P.l - 6}" y="${yy(k) + 4}" text-anchor="end">${fmtDec(k, 0)}</text>`).join('')}
    <path d="${pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)},${yy(p.km).toFixed(1)}`).join('')}" fill="none" stroke="#ea580c" stroke-width="2.5"/>
    ${pts.map(p => `<circle cx="${x(p.date)}" cy="${yy(p.km)}" r="3" fill="#ea580c"><title>${fmtDate(p.date)}: ${fmtDec(p.km)} ${unit}</title></circle>`).join('')}
    <text x="${P.l}" y="${H - 6}">${fmtDate(pts[0].date)}</text><text x="${W - P.r}" y="${H - 6}" text-anchor="end">${fmtDate(pts[pts.length - 1].date)}</text></svg>`;
}
function serviceSummary(vid) {
  const rs = sortedReminders(vid); if (!rs.length) return '';
  return `<div class="card scroll-x"><table class="t"><tr><th>Punkt</th><th>Interval</th><th>Sidst udført</th><th>Næste</th><th>Status</th></tr>
    ${rs.map(({ r, s }) => `<tr><td>${esc(r.name)}</td><td class="nowrap">${[r.intervalKm ? fmtKm(r.intervalKm) : '', r.intervalMonths ? r.intervalMonths + ' mdr.' : ''].filter(Boolean).join(' / ')}</td>
      <td class="nowrap">${s.lastDate ? fmtDate(s.lastDate) : '–'}${s.lastKm != null ? ' · ' + fmtKm(s.lastKm) : ''}</td>
      <td class="nowrap">${[s.nextKm != null ? fmtKm(s.nextKm) : '', s.nextDate ? fmtDate(s.nextDate) : ''].filter(Boolean).join(' / ')}</td>
      <td><span class="badge b-${s.level}">${LEVEL_TXT[s.level]}</span></td></tr>`).join('')}</table></div>`;
}
function exportCsv() {
  const es = reportEntries();
  const cell = v => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const dec = n => n == null ? '' : String(n).replace('.', ',');
  const rows = [['Dato', 'Køretøj', 'Kategori', 'Beskrivelse', 'Kilometer', 'Beløb (kr)', 'Liter/kWh', 'Værksted/sted', 'Udført vedligehold', 'Noter', 'Antal bilag', 'Forbrug km/l']];
  for (const e of es) rows.push([e.date, vehicleName(e.vehicleId), TYPES[e.type]?.label, entryTitle(e), e.km ?? '', dec(e.cost), dec(e.liters), e.workshop,
    (e.reminderIds || []).map(r => byId('reminders', r)?.name).filter(Boolean).join(', '), e.notes, filesOf('entry', e.id).length, fuelSegs().byEntry[e.id] ? dec(Math.round(fuelSegs().byEntry[e.id].kml * 10) / 10) : '']);
  const csv = '﻿' + rows.map(r => r.map(cell).join(';')).join('\r\n');
  download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `koretojslog-${today()}.csv`);
}

/* ---------- Indstillinger ---------- */
function renderSettings() {
  setTitle('Indstillinger', 'settings');
  const en = Drive.enabled(); const last = localStorage.getItem('lastSync');
  const pendingUp = live('files').filter(f => !f.driveId).length;
  view().innerHTML = `
    <h2 style="margin-top:0">Daglig brug</h2>
    <div class="card"><h3>🎨 Tema</h3>
      <div class="chips" style="margin-top:8px">${[['auto', '⚙️ Følg enheden'], ['light', '☀️ Lyst'], ['dark', '🌙 Mørkt']].map(([k, l]) =>
        `<button class="chip ${(localStorage.getItem('theme') || 'auto') === k ? 'on' : ''}" data-act="theme" data-id="${k}">${l}</button>`).join('')}</div>
      <p class="muted small" style="margin:8px 0 0">Gælder for denne enhed. Du kan også skifte hurtigt med ☀️/🌙-knappen øverst.</p></div>
    ${IS_NATIVE ? `<div class="card" style="margin-top:14px"><h3>🚘 Android Auto</h3>
      <p class="muted small">Køreskærmen viser hastighed, hastighedsgrænse, tur, kilometerstand og rækkevidde for det køretøj, telefonen er forbundet til.</p>
      <div class="fgrid">
        <div class="f"><label class="lbl">Servicelampe: km før</label><input id="aaWarnKm" type="number" inputmode="numeric" value="${esc(localStorage.getItem('aaWarnKm') || 1000)}"></div>
        <div class="f"><label class="lbl">Servicelampe: dage før</label><input id="aaWarnDays" type="number" inputmode="numeric" value="${esc(localStorage.getItem('aaWarnDays') || 30)}"></div>
      </div>
      <label class="check"><input type="checkbox" id="aaSpeedLimit" ${localStorage.getItem('aaSpeedLimit') !== '0' ? 'checked' : ''}> Vis hastighedsgrænse (OpenStreetMap)</label>
      <div class="lbl" style="margin:10px 0 4px">Lyde</div>
      ${[['aaSndOver', '🔔 “Ding”, når fartgrænsen overskrides'], ['aaSndAhead', '🔈 “Bip”, når en ny fartgrænse kommer om 300 m'], ['aaSndService', '🔧 Servicelampe: “ding” ved gul, “biiip” ved rød (gentages hver 20. km)']].map(([k, l]) =>
        `<label class="check"><input type="checkbox" id="${k}" ${localStorage.getItem(k) !== '0' ? 'checked' : ''}> ${l}</label>`).join('')}
      <p class="muted small" style="margin:8px 0 0">Gråt skilt = vejen har ingen registreret grænse, så den generelle grænse er anslået ud fra vejtypen. Fartgrænserne gemmes på telefonen, så kendte strækninger vises med det samme.
        <span id="speedCache"></span></p>
      <details style="margin-top:6px"><summary class="small">Sådan får du appen frem i Android Auto</summary><ol class="small" style="margin:6px 0 0;padding-left:20px">
        <li>Åbn Android Auto-indstillingerne på telefonen (Indstillinger → søg “Android Auto”).</li>
        <li>Rul ned og tryk 10 gange på <b>Version</b>, og godkend udviklertilstand.</li>
        <li>Tryk ⋮ øverst → <b>Udviklerindstillinger</b> → slå <b>Ukendte kilder</b> til.</li>
        <li>Under <b>Tilpas startprogram</b> kan du sætte Motorist på listen.</li>
        <li>Forbind til skærmen, og vælg Motorist i app-oversigten.</li></ol></details></div>` : ''}
    <div class="card" style="margin-top:14px"><h3>🧩 Funktioner</h3>
      <p class="muted small" style="margin-top:0">Slå det fra, du ikke bruger – så forsvinder det fra faner og menuer. Dine data bliver liggende.</p>
      ${FEATURES.map(([k, l]) => `<label class="check"><input type="checkbox" class="featChk" data-id="${k}" ${feat(k) ? 'checked' : ''}> ${l}</label>`).join('')}
    </div>
    ${fold('s-setup', '⚙️ Opsætning', `<div class="card" style="margin-top:14px"><h3>☁️ Google Drive</h3>
      <p class="muted small">Alle data og bilag gemmes i mappen <b>${ROOT_FOLDER}</b> på dit Google Drive, så tablet og telefon altid er synkroniseret. Appen kan kun se de filer, den selv har oprettet.</p>
      ${IS_NATIVE ? '' : `<div class="f"><label class="lbl">Google OAuth Client ID</label><input id="cid" value="${esc(Drive.clientId())}" placeholder="xxxxxxxx.apps.googleusercontent.com"></div>`}
      ${en ? `<p>Status: <b>${{ ok: 'Synkroniseret', syncing: 'Synkroniserer…', auth: 'Login udløbet', error: 'Fejl', local: '' }[Sync.state]}</b>${last ? ` · sidst ${new Date(last).toLocaleString('da-DK')}` : ''}
        ${Sync.err ? `<br><span class="small" style="color:var(--bad)">${esc(Sync.err)}</span>` : ''}${pendingUp ? `<br><span class="small muted">${pendingUp} fil(er) venter på upload</span>` : ''}</p>
        <div class="row"><button class="btn primary" data-act="syncNow">⟳ Synkronisér nu</button>${Sync.state === 'auth' ? '<button class="btn" data-act="connect">Log ind igen</button>' : ''}
        ${Drive.ids.root ? `<a class="btn" href="https://drive.google.com/drive/folders/${Drive.ids.root}" target="_blank" rel="noopener">Åbn mappe i Drive</a>` : ''}
        <button class="btn danger" data-act="disconnect">Afbryd</button></div>`
      : `<button class="btn primary" data-act="connect">Forbind Google Drive</button>`}
    </div>
    ${feat('work') ? workCard() : ''}
    <div class="card" style="margin-top:14px"><h3>💾 Backup</h3>
      <p class="muted small">Eksportér alle registreringer som en JSON-fil (uden bilag), eller importér en tidligere backup. Import fletter med eksisterende data.</p>
      <div class="row"><button class="btn" data-act="exportJson">⤓ Eksportér data</button><label class="btn">⤒ Importér<input type="file" accept="application/json,.json" hidden id="imp"></label></div>
    </div>
    <div class="card" style="margin-top:14px"><h3>📲 Installation</h3>
      ${IS_NATIVE ? `<p class="muted small">Du bruger Android-appen. Nye versioner hentes fra <a href="https://github.com/peterelkjaer/koretojslog/releases/latest" target="_blank" rel="noopener">GitHub (seneste version)</a> og installeres oven på den gamle – dine data bevares.</p>`
        : `<p class="muted small">Åbn appens adresse i Chrome, tryk på ⋮-menuen og vælg <b>Installér app</b> / <b>Føj til startskærm</b>. Gør det samme på telefonen, og forbind til samme Google-konto.</p>`}
      <p class="muted small">Version ${APP_VERSION}${IS_NATIVE ? ' · Android-app' : ''}</p>
    </div>`, false, Drive.enabled() ? 'Google Drive forbundet' : 'Google Drive ikke forbundet')}`;
  $$('.featChk').forEach(c => c.onchange = () => { const st = featState(); st[c.dataset.id] = c.checked; localStorage.setItem('features', JSON.stringify(st)); pushCarData(); toast(c.checked ? 'Slået til' : 'Slået fra'); });
  for (const k of ['aaWarnKm', 'aaWarnDays']) if ($('#' + k)) $('#' + k).onchange = e => { localStorage.setItem(k, String(Math.max(0, num(e.target.value) || 0))); pushCarData(); toast('Gemt'); };
  for (const k of ['aaSpeedLimit', 'aaSndOver', 'aaSndAhead', 'aaSndService']) if ($('#' + k)) $('#' + k).onchange = e => { localStorage.setItem(k, e.target.checked ? '1' : '0'); pushCarData(); };
  if (IS_NATIVE && NH && NH.speedCache) Promise.resolve(NH.speedCache({})).then(r => { const el = $('#speedCache'); if (el && r && r.tiles) el.innerHTML = ` Gemt: ${r.tiles} område${r.tiles > 1 ? 'r' : ''} (${fmtDec(r.bytes / 1048576, 1)} MB). <a href="#" data-act="clearSpeedCache">Ryd</a>`; }).catch(() => {});
  if ($('#cid')) $('#cid').onchange = e => { localStorage.setItem('clientId', e.target.value.trim()); toast('Client ID gemt'); };
  $('#imp').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { const d = JSON.parse(await f.text()); if (!d.vehicles) throw new Error('Ugyldig fil');
      data = merge(data, d); await persist(); render(); toast('Data importeret'); } catch (err) { toast('Import fejlede: ' + err.message); }
  };
}

/* ---------- Gentagne (faste) udgifter ---------- */
// Hver betaling får et fast id (rec_<id>_<dato>), så to enheder aldrig opretter den samme betaling to gange.
function recurringDates(r, until) {
  const out = []; const step = INTERVALS[r.interval]?.m || 12;
  for (let i = 0; i < 600; i++) {
    const d = addMonths(r.startDate, step * i);
    if (d > until || (r.endDate && d > r.endDate)) break;
    out.push(d);
  }
  return out;
}
function nextRecurring(r) {
  if (r.paused) return null;
  const step = INTERVALS[r.interval]?.m || 12; const t = today();
  for (let i = 0; i < 600; i++) { const d = addMonths(r.startDate, step * i); if (r.endDate && d > r.endDate) return null; if (d > t) return d; }
  return null;
}
function generateRecurring() {
  let changed = false; const ids = new Set(data.entries.map(e => e.id));
  for (const r of live('recurring')) {
    if (r.paused || !r.startDate) continue;
    const v = byId('vehicles', r.vehicleId); if (!v) continue;
    let until = today(); if (v.sellDate && v.sellDate < until) until = v.sellDate;
    for (const d of recurringDates(r, until)) {
      const id = `rec_${r.id}_${d}`; if (ids.has(id)) continue;
      const e = { id, vehicleId: r.vehicleId, type: r.type, title: r.title, date: d, cost: r.amount, km: null, recurringId: r.id, reminderIds: [], createdAt: nowIso() };
      upsert('entries', e); ids.add(id); changed = true;
    }
  }
  return changed;
}
function recurringPanel(v) {
  const rs = live('recurring').filter(r => r.vehicleId === v.id).sort((a, b) => (nextRecurring(a) || '9').localeCompare(nextRecurring(b) || '9'));
  const perYear = rs.filter(r => !r.paused && (!r.endDate || r.endDate >= today())).reduce((a, r) => a + (r.amount || 0) * 12 / (INTERVALS[r.interval]?.m || 12), 0);
  return `${rs.length ? `<p class="muted small" style="margin-top:0">Faste udgifter i alt: <b>${fmtKr(perYear)}</b> pr. år (${fmtKr(perYear / 12)} pr. måned).</p>` : ''}
    <div class="list">${rs.map(r => { const t = TYPES[r.type] || TYPES.other; const nx = nextRecurring(r);
      return `<div class="item" data-act="editRecurring" data-id="${r.id}"><div class="ic">${t.icon}</div>
        <div class="body"><div class="t">${esc(r.title || t.label)}</div>
        <div class="s">${INTERVALS[r.interval]?.label || ''} · ${r.paused ? 'stoppet' : nx ? 'næste ' + fmtDate(nx) : 'afsluttet'}</div></div>
        <div class="amt">${fmtKr(r.amount)}</div></div>`; }).join('') || '<p class="muted small">Opret f.eks. forsikring eller vægtafgift én gang, så registreres betalingerne selv på betalingsdatoen.</p>'}</div>
    <div class="row" style="margin-top:10px"><button class="btn" data-act="addRecurring" data-id="${v.id}">＋ Tilføj fast udgift</button></div>`;
}
function recurringForm(vid, rid) {
  const r = rid ? { ...byId('recurring', rid) } : { id: uid(), vehicleId: vid, type: 'insurance', title: '', amount: null, interval: 'year', startDate: today(), endDate: null, paused: false };
  const generated = rid ? live('entries').filter(e => e.recurringId === rid).length : 0;
  const m = modal(rid ? 'Rediger fast udgift' : 'Ny fast udgift', `<form>
    <div class="fgrid">
      <div class="f full"><label>Beskrivelse *</label><input name="title" required value="${esc(r.title)}" placeholder="F.eks. Kaskoforsikring, Vægtafgift"></div>
      <div class="f"><label>Kategori</label><select name="type">${Object.entries(TYPES).filter(([k]) => k !== 'fuel').map(([k, t]) => `<option value="${k}" ${k === r.type ? 'selected' : ''}>${t.icon} ${t.label}</option>`).join('')}</select></div>
      <div class="f"><label>Beløb pr. betaling (kr.) *</label><input name="amount" type="number" step="any" inputmode="decimal" required value="${r.amount ?? ''}"></div>
      <div class="f"><label>Gentages</label><select name="interval">${Object.entries(INTERVALS).map(([k, x]) => `<option value="${k}" ${k === r.interval ? 'selected' : ''}>${x.label}</option>`).join('')}</select></div>
      <div class="f"><label>${rid ? 'Første betaling' : 'Første betalingsdato *'}</label><input name="startDate" type="date" required value="${esc(r.startDate)}" ${rid ? 'disabled' : ''}></div>
      <div class="f"><label>Slutdato (valgfri)</label><input name="endDate" type="date" value="${esc(r.endDate || '')}"></div>
      <div class="f"><label class="check" style="font-weight:400;color:var(--fg);margin-top:22px"><input type="checkbox" name="paused" ${r.paused ? 'checked' : ''}> Stoppet</label></div>
    </div>
    <p class="muted small">${rid ? `${generated} betaling(er) er registreret indtil nu. Ændrer du beløbet, gælder det kun kommende betalinger.`
      : 'Hver betaling registreres automatisk på sin betalingsdato. Ligger første betaling tilbage i tiden, registreres betalingerne frem til i dag med det samme.'}</p>
    <div class="modal-actions">${rid ? '<button type="button" class="btn danger" data-del>Slet</button><span class="spacer"></span>' : ''}
      <button type="button" class="btn" data-close>Annuller</button><button class="btn primary">Gem</button></div></form>`);
  const form = $('form', m);
  form.onsubmit = async ev => {
    ev.preventDefault(); const fd = new FormData(form);
    r.title = fd.get('title').trim(); r.type = fd.get('type'); r.amount = num(fd.get('amount')); r.interval = fd.get('interval');
    if (!rid) r.startDate = fd.get('startDate'); r.endDate = fd.get('endDate') || null; r.paused = fd.get('paused') === 'on';
    upsert('recurring', r); const n0 = data.entries.length; generateRecurring(); const added = live('entries').filter(e => e.recurringId === r.id).length - generated;
    await persist(); await closeLayer(); render(); toast(added > 0 && !rid ? `Gemt · ${added} betaling(er) registreret` : 'Gemt');
  };
  $('[data-del]', m)?.addEventListener('click', async () => {
    if (!confirm(`Slet den faste udgift "${r.title}"? Allerede registrerede betalinger bevares i historikken.`)) return;
    softDelete('recurring', rid); await persist(); await closeLayer(); render();
  });
}

/* ---------- Dæklog ---------- */
const currentTires = vid => live('tires').filter(t => t.vehicleId === vid && !t.removeDate).sort((a, b) => a.position.localeCompare(b.position));
function tireAge(t) {
  const m = /^(\d{2})(\d{2})$/.exec(String(t.dot || '').trim()); if (!m) return null;
  const week = +m[1], year = 2000 + +m[2]; if (week < 1 || week > 53) return null;
  const made = new Date(year, 0, 1 + (week - 1) * 7); const years = (Date.now() - made) / (365.25 * 864e5);
  return { years, made, level: years >= 6 ? 'overdue' : years >= 5 ? 'soon' : 'ok' };
}
const fmtYears = y => y.toLocaleString('da-DK', { maximumFractionDigits: 1 }) + ' år';
function tireKm(t) { const end = t.removeKm ?? currentKm(t.vehicleId); return t.mountKm != null && end != null && end >= t.mountKm ? end - t.mountKm : null; }
function tireWarnItem({ t, a }) {
  return `<div class="item rem ${a.level}" data-act="goVehicleTab" data-id="${t.vehicleId}" data-tab="tires"><div class="body">
    <div class="row between"><span class="t">Dæk ${TIRE_POS[t.position].toLowerCase()} <span class="muted small">· ${esc(vehicleName(t.vehicleId))}</span></span><span class="badge b-${a.level}">${fmtYears(a.years)}</span></div>
    <div class="s">${esc([t.brand, t.model].filter(Boolean).join(' '))} · DOT ${esc(t.dot)} · ${a.level === 'overdue' ? 'over 6 år – bør skiftes' : 'over 5 år – hold øje med revner'}</div></div></div>`;
}
function tiresPanel(v) {
  const cur = currentTires(v.id);
  const old = live('tires').filter(t => t.vehicleId === v.id && t.removeDate).sort((a, b) => b.removeDate.localeCompare(a.removeDate));
  const card = t => { const a = tireAge(t); const km = tireKm(t);
    return `<div class="card click" data-act="editTire" data-id="${t.id}" style="margin-bottom:10px">
      <div class="row between"><h3>${TIRE_POS[t.position]}</h3>${a ? `<span class="badge b-${a.level}">${fmtYears(a.years)} gammelt</span>` : ''}</div>
      <div>${esc([t.brand, t.model].filter(Boolean).join(' ') || 'Ukendt dæk')}${t.size ? ` <span class="muted small">· ${esc(t.size)}</span>` : ''}</div>
      <div class="muted small">Monteret ${fmtDate(t.mountDate)}${t.mountKm != null ? ' ved ' + fmtKm(t.mountKm) : ''}${km != null ? ` · kørt <b>${fmtKm(km)}</b>` : ''}${t.dot ? ' · DOT ' + esc(t.dot) : ''}</div>
      <div class="row" style="margin-top:8px"><button class="btn sm" data-act="changeTire" data-id="${t.id}">🔄 Skift dæk</button></div></div>`; };
  return `${cur.length ? cur.map(card).join('') : '<p class="muted small">Registrér de dæk, der sidder på nu. Med DOT-koden (4 cifre, uge og år) holder appen øje med dækkenes alder.</p>'}
    <div class="row" style="margin:4px 0 6px"><button class="btn" data-act="addTire" data-id="${v.id}">＋ Registrér dæk</button></div>
    ${old.length ? `<h3 style="margin-top:16px">Tidligere dæk</h3><div class="card scroll-x" style="margin-top:8px"><table class="t"><tr><th>Position</th><th>Dæk</th><th>Periode</th><th class="n">Kørt</th><th class="n">Pr. 1.000 km</th></tr>
      ${old.map(t => { const km = tireKm(t); return `<tr data-act="editTire" data-id="${t.id}" style="cursor:pointer"><td>${TIRE_POS[t.position]}</td><td>${esc([t.brand, t.model].filter(Boolean).join(' '))}</td>
        <td class="nowrap">${fmtDate(t.mountDate)} – ${fmtDate(t.removeDate)}</td><td class="n">${km != null ? fmtKm(km) : ''}</td><td class="n">${km && t.price ? fmtKr(t.price / km * 1000) : ''}</td></tr>`; }).join('')}</table></div>` : ''}`;
}
function tireForm(vid, tid, replacing) {
  const v = byId('vehicles', vid || byId('tires', tid)?.vehicleId);
  const t = tid ? { ...byId('tires', tid) } : { id: uid(), vehicleId: v.id, position: replacing?.position || (v.kind === 'mc' ? 'front' : 'set'),
    brand: replacing?.brand || '', model: replacing?.model || '', size: replacing?.size || '', dot: '', price: null, mountDate: today(), mountKm: currentKm(v.id), removeDate: null, removeKm: null, notes: '' };
  const m = modal(tid ? 'Rediger dæk' : replacing ? `Skift dæk – ${TIRE_POS[replacing.position].toLowerCase()}` : 'Registrér dæk', `<form>
    <div class="fgrid">
      <div class="f"><label>Position</label><select name="position" ${replacing ? 'disabled' : ''}>${Object.entries(TIRE_POS).map(([k, l]) => `<option value="${k}" ${k === t.position ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="f"><label>Størrelse</label><input name="size" value="${esc(t.size)}" placeholder="F.eks. 120/70 ZR17"></div>
      <div class="f"><label>Mærke</label><input name="brand" value="${esc(t.brand)}" placeholder="F.eks. Michelin"></div>
      <div class="f"><label>Model</label><input name="model" value="${esc(t.model)}" placeholder="F.eks. Road 6"></div>
      <div class="f"><label>DOT (uge + år, 4 cifre)</label><input name="dot" value="${esc(t.dot)}" inputmode="numeric" maxlength="4" placeholder="F.eks. 2324"></div>
      <div class="f"><label>Pris (kr.)</label><input name="price" type="number" step="any" inputmode="decimal" value="${t.price ?? ''}"></div>
      <div class="f"><label>Monteret dato</label><input name="mountDate" type="date" required value="${esc(t.mountDate)}"></div>
      <div class="f"><label>Monteret ved km</label><input name="mountKm" type="number" inputmode="numeric" value="${t.mountKm ?? ''}"></div>
      ${tid ? `<div class="f"><label>Afmonteret dato</label><input name="removeDate" type="date" value="${esc(t.removeDate || '')}"></div>
      <div class="f"><label>Afmonteret ved km</label><input name="removeKm" type="number" inputmode="numeric" value="${t.removeKm ?? ''}"></div>` : ''}
      <div class="f full"><label>Noter</label><input name="notes" value="${esc(t.notes)}" placeholder="F.eks. dæktryk 2,5/2,9 bar, slid"></div>
      ${tid ? '' : `<div class="f full"><label class="check" style="font-weight:400;color:var(--fg)"><input type="checkbox" name="asExpense" checked> Registrér også prisen som udgift (kategori Dæk)</label></div>`}
    </div>
    ${replacing ? `<p class="muted small">Det gamle dæk (${esc([replacing.brand, replacing.model].filter(Boolean).join(' ') || TIRE_POS[replacing.position])}) bliver flyttet til “Tidligere dæk” med den nye monteringsdato og km.</p>` : ''}
    <div class="modal-actions">${tid ? '<button type="button" class="btn danger" data-del>Slet</button><span class="spacer"></span>' : ''}
      <button type="button" class="btn" data-close>Annuller</button><button class="btn primary">Gem</button></div></form>`);
  const form = $('form', m);
  form.onsubmit = async ev => {
    ev.preventDefault(); const fd = new FormData(form);
    if (!replacing) t.position = fd.get('position');
    for (const k of ['size', 'brand', 'model', 'dot', 'notes']) t[k] = (fd.get(k) || '').trim();
    if (t.dot && !/^\d{4}$/.test(t.dot)) { toast('DOT skal være 4 cifre: uge og år, f.eks. 2324'); return; }
    t.price = num(fd.get('price')); t.mountDate = fd.get('mountDate'); t.mountKm = num(fd.get('mountKm'));
    if (tid) { t.removeDate = fd.get('removeDate') || null; t.removeKm = num(fd.get('removeKm')); }
    if (replacing) upsert('tires', { ...byId('tires', replacing.id), removeDate: t.mountDate, removeKm: t.mountKm });
    else if (!tid) for (const o of currentTires(t.vehicleId)) if (o.position === t.position || o.position === 'set' || t.position === 'set')
      if (confirm(`Skal "${[o.brand, o.model].filter(Boolean).join(' ') || TIRE_POS[o.position]}" (${TIRE_POS[o.position].toLowerCase()}) markeres som afmonteret?`)) upsert('tires', { ...o, removeDate: t.mountDate, removeKm: t.mountKm });
    upsert('tires', t);
    if (!tid && fd.get('asExpense') === 'on' && t.price) upsert('entries', { id: uid(), vehicleId: t.vehicleId, type: 'tires', date: t.mountDate, km: t.mountKm,
      cost: t.price, title: `Dæk ${TIRE_POS[t.position].toLowerCase()}: ${[t.brand, t.model].filter(Boolean).join(' ')}`.trim(), reminderIds: [], createdAt: nowIso() });
    await persist(); await closeLayer(); render(); toast('Gemt');
  };
  $('[data-del]', m)?.addEventListener('click', async () => { if (!confirm('Slet dette dæk fra dæklogen?')) return; softDelete('tires', tid); await persist(); await closeLayer(); render(); });
}

/* ---------- Reservedele ---------- */
const pSearch = {};
function partsList(v) {
  const q = (pSearch[v.id] || '').toLowerCase();
  const ps = live('parts').filter(p => p.vehicleId === v.id && (!q || [p.name, p.partNo, p.altNo, p.spec, p.supplier, p.notes, p.category].join(' ').toLowerCase().includes(q)));
  if (!ps.length) return `<p class="muted small">${q ? 'Intet matcher søgningen.' : 'Gem varenumre og specifikationer, f.eks. oliefilter, olietype og -mængde, tændrør, pærer og bremseklodser.'}</p>`;
  return PART_CATS.filter(c => ps.some(p => (p.category || 'Andet') === c)).map(c => `<div class="year-h"><span>${c}</span></div><div class="list">` +
    ps.filter(p => (p.category || 'Andet') === c).sort((a, b) => a.name.localeCompare(b.name, 'da')).map(p => `<div class="item" data-act="editPart" data-id="${p.id}">
      <div class="body"><div class="t">${esc(p.name)}</div>
      <div class="s">${p.partNo ? `Varenr. <b>${esc(p.partNo)}</b>` : ''}${p.altNo ? ` · alt. ${esc(p.altNo)}` : ''}${p.spec ? ` · ${esc(p.spec)}` : ''}${p.supplier ? ` · ${esc(p.supplier)}` : ''}</div></div>
      <div class="amt">${p.price != null ? fmtKr(p.price) : ''}</div></div>`).join('') + '</div>').join('');
}
function partsPanel(v) {
  return `<input id="psearch" type="search" placeholder="Søg i reservedele …" value="${esc(pSearch[v.id] || '')}" style="margin-bottom:6px"><div id="plist">${partsList(v)}</div>
    <div class="row" style="margin-top:10px"><button class="btn" data-act="addPart" data-id="${v.id}">＋ Tilføj reservedel</button></div>`;
}
function partForm(vid, pid) {
  const p = pid ? { ...byId('parts', pid) } : { id: uid(), vehicleId: vid, category: 'Filtre', name: '', partNo: '', altNo: '', spec: '', supplier: '', url: '', price: null, notes: '' };
  const m = modal(pid ? 'Rediger reservedel' : 'Ny reservedel', `<form>
    <div class="fgrid">
      <div class="f full"><label>Navn *</label><input name="name" required value="${esc(p.name)}" placeholder="F.eks. Oliefilter"></div>
      <div class="f"><label>Kategori</label><select name="category">${PART_CATS.map(c => `<option ${c === p.category ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
      <div class="f"><label>Specifikation</label><input name="spec" value="${esc(p.spec)}" placeholder="F.eks. 3,8 L 10W-40"></div>
      <div class="f"><label>Varenummer (original)</label><input name="partNo" value="${esc(p.partNo)}"></div>
      <div class="f"><label>Alternativt varenummer</label><input name="altNo" value="${esc(p.altNo)}" placeholder="F.eks. HF204"></div>
      <div class="f"><label>Forhandler</label><input name="supplier" value="${esc(p.supplier)}"></div>
      <div class="f"><label>Seneste pris (kr.)</label><input name="price" type="number" step="any" inputmode="decimal" value="${p.price ?? ''}"></div>
      <div class="f full"><label>Link</label><input name="url" type="url" value="${esc(p.url)}" placeholder="https://…"></div>
      <div class="f full"><label>Noter</label><input name="notes" value="${esc(p.notes)}"></div>
    </div>
    ${p.url ? `<p class="small"><a href="${esc(p.url)}" target="_blank" rel="noopener">Åbn link ↗</a></p>` : ''}
    <div class="modal-actions">${pid ? '<button type="button" class="btn danger" data-del>Slet</button><span class="spacer"></span>' : ''}
      <button type="button" class="btn" data-close>Annuller</button><button class="btn primary">Gem</button></div></form>`);
  const form = $('form', m);
  form.onsubmit = async ev => {
    ev.preventDefault(); const fd = new FormData(form);
    for (const k of ['name', 'category', 'spec', 'partNo', 'altNo', 'supplier', 'url', 'notes']) p[k] = (fd.get(k) || '').trim();
    p.price = num(fd.get('price')); upsert('parts', p); await persist(); await closeLayer(); render(); toast('Gemt');
  };
  $('[data-del]', m)?.addEventListener('click', async () => { if (!confirm(`Slet "${p.name}"?`)) return; softDelete('parts', pid); await persist(); await closeLayer(); render(); });
}

/* ---------- Rækkevidde ---------- */
function fuelRange(vid) {
  const v = byId('vehicles', vid); if (!v?.tankSize) return null;
  const segs = (fuelSegs().byVehicle[vid] || []).slice(-5); if (!segs.length) return null;
  const kml = segs.reduce((a, s) => a + s.km, 0) / segs.reduce((a, s) => a + s.liters, 0);
  const fills = live('entries').filter(e => e.vehicleId === vid && e.type === 'fuel' && e.km != null).sort((a, b) => b.km - a.km || b.date.localeCompare(a.date));
  const lastFull = fills.find(e => e.fullTank !== false); if (!lastFull) return null;
  const partial = fills.filter(e => e.fullTank === false && e.km > lastFull.km).reduce((a, e) => a + (e.liters || 0), 0);
  const cur = currentKm(vid) ?? lastFull.km; const since = Math.max(0, cur - lastFull.km);
  const fuelLeft = Math.min(v.tankSize, v.tankSize - since / kml + partial);
  const range = Math.max(0, fuelLeft * kml);
  return { range, kml, since, level: range < 50 ? 'overdue' : range < 100 ? 'soon' : 'ok', asOf: lastKmDate(vid) };
}
function rangeLine(vid) {
  const r = feat('range') ? fuelRange(vid) : null; if (!r) return '';
  return `<div class="small" style="margin-top:6px">⛽ <span class="badge b-${r.level}">ca. ${fmtNum(Math.round(r.range / 5) * 5)} km til tom</span> <span class="muted">${fmtKm(r.since)} siden fuld tank</span></div>`;
}

/* ---------- Statistik pr. sæson ---------- */
function seasonTable(vid) {
  const v = byId('vehicles', vid); const sm = v.seasonStart || 1;
  const dates = [...kmPoints(vid).map(p => p.date), ...live('entries').filter(e => e.vehicleId === vid).map(e => e.date)].sort();
  if (!dates.length) return '';
  const t = today(); let y = +dates[0].slice(0, 4); if (dates[0].slice(5, 7) < String(sm).padStart(2, '0')) y--;
  const rows = [];
  for (; ; y++) {
    const from = `${y}-${String(sm).padStart(2, '0')}-01`; if (from > t) break;
    const to = addDays(addMonths(from, 12), -1);
    const es = live('entries').filter(e => e.vehicleId === vid && e.date >= from && e.date <= to);
    const cost = es.reduce((a, e) => a + (e.cost || 0), 0); const km = kmDriven(vid, from, to);
    const trips = live('trips').filter(x => x.vehicleId === vid && x.date >= from && x.date <= to);
    const longest = trips.reduce((a, x) => Math.max(a, x.km || 0), 0); const fuel = avgKml(vid, from, to);
    rows.push({ label: sm === 1 ? String(y) : `${y}/${String(y + 1).slice(2)}`, cost, km, trips: trips.length, longest, fuel, current: to >= t });
  }
  const hasTrips = rows.some(r => r.trips);
  return `<div class="card scroll-x"><table class="t"><tr><th>Sæson</th><th class="n">Kørt</th>${hasTrips ? '<th class="n">Ture</th><th class="n">Længste</th>' : ''}<th class="n">Forbrug</th><th class="n">Udgifter</th><th class="n">Pr. km</th></tr>
    ${rows.reverse().map(r => `<tr><td class="nowrap">${r.label}${r.current ? ' <span class="muted small">(i gang)</span>' : ''}</td><td class="n">${r.km ? fmtKm(r.km) : '–'}</td>
      ${hasTrips ? `<td class="n">${r.trips || ''}</td><td class="n">${r.longest ? fmtKm(r.longest) : ''}</td>` : ''}
      <td class="n">${r.fuel ? fmtDec(r.fuel.kml) + ' ' + fuelUnit(vid) : ''}</td><td class="n">${fmtKr(r.cost)}</td><td class="n">${r.km ? fmtKr2(r.cost / r.km) : '–'}</td></tr>`).join('')}</table></div>
    <p class="muted small">En sæson regnes fra 1. ${MONTHS[sm - 1]} og 12 måneder frem, så vinterens forsikring og afgifter tæller med. Startmåneden ændres under køretøjet (✏️ Rediger).</p>`;
}

/* ---------- Ture og automatisk km-logning ---------- */
function decodePoly(str) {
  const pts = []; let i = 0, lat = 0, lng = 0;
  while (str && i < str.length) {
    for (const k of [0, 1]) {
      let b, shift = 0, result = 0;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = (result & 1) ? ~(result >> 1) : (result >> 1);
      if (k === 0) lat += d; else lng += d;
    }
    pts.push([lat / 1e5, lng / 1e5]);
  }
  return pts;
}
const fmtTime = ts => new Date(ts).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
const fmtDur = ms => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)} t ${m % 60} min` : `${m} min`; };
const tripAvg = t => t.endTs > t.startTs ? t.km / ((t.endTs - t.startTs) / 3.6e6) : null;

/* Kalibrering: sammenlign en manuel kilometerstand med GPS-turene siden forrige manuelle aflæsning */
function calibrate(vid, date, km, createdAt) {
  const v = byId('vehicles', vid); if (!v || km == null) return;
  const manual = [];
  for (const r of live('readings')) if (r.vehicleId === vid && !r.auto && r.km != null) manual.push({ date: r.date, km: r.km, t: r.createdAt || r.updatedAt || '' });
  for (const e of live('entries')) if (e.vehicleId === vid && e.km != null) manual.push({ date: e.date, km: e.km, t: e.createdAt || e.updatedAt || '' });
  const prev = manual.filter(p => p.t < createdAt && p.km < km).sort((a, b) => b.t.localeCompare(a.t))[0];
  if (!prev) return;
  const from = Date.parse(prev.t), to = Date.parse(createdAt);
  const trips = live('trips').filter(t => t.vehicleId === vid && t.endTs > from && t.endTs <= to);
  const gps = trips.reduce((a, t) => a + (t.gpsKm || 0), 0);
  if (gps < 20 || trips.length === 0) return;
  // Kun hvis alle km i perioden er kørt med logning (ellers ville faktoren blive for stor)
  const f = (km - prev.km) / gps;
  if (f < 0.85 || f > 1.2) return;
  const nf = v.kmFactor ? (v.kmFactor + f) / 2 : f;
  upsert('vehicles', { ...v, kmFactor: Math.round(nf * 10000) / 10000 });
}

let importing = false;
async function importTrips() {
  if (!IS_NATIVE || !NH || importing) return;
  importing = true;
  try {
    const res = await NH.getTrips(); const list = (res && res.trips) || [];
    if (!list.length) return;
    const ack = []; let added = 0, addedKm = 0;
    for (const t of list.sort((a, b) => a.start - b.start)) {
      if (data.trips.some(x => x.id === t.id)) { ack.push(t.id); continue; }
      const addr = String(t.address || '').toUpperCase();
      const v = live('vehicles').find(v => (v.btAddress && v.btAddress.toUpperCase() === addr) || ('MANUAL-' + v.id).toUpperCase() === addr);
      if (!v) continue; // venter, til enheden er koblet til et køretøj
      const gps = (t.meters || 0) / 1000; const km = Math.round(gps * (v.kmFactor || 1) * 10) / 10;
      const base = currentKm(v.id);
      upsert('trips', { id: t.id, vehicleId: v.id, date: localDate(new Date(t.start)), startTs: t.start, endTs: t.end, gpsKm: Math.round(gps * 100) / 100,
        km, maxKmh: Math.round((t.maxSpeed || 0) * 3.6), poly: t.poly || '', title: '', notes: '', work: !!workPlaceOf(t.poly), workAuto: true });
      if (base != null) upsert('readings', { id: 'trip_' + t.id, vehicleId: v.id, date: localDate(new Date(t.end || t.start)), km: Math.round(base + km), auto: true, tripId: t.id, tripEnd: t.end || t.start, createdAt: nowIso() });
      localStorage.setItem('lastVehicle', v.id);
      ack.push(t.id); added++; addedKm += km;
    }
    if (added) { await persist(); render(); toast(`${added} tur${added > 1 ? 'e' : ''} hentet · ${fmtDec(addedKm)} km`); }
    if (ack.length) await NH.ackTrips({ ids: ack });
  } catch (e) { console.warn('importTrips', e); }
  finally { importing = false; }
}

let wasActive = false;
async function pollTrip() {
  if (!IS_NATIVE || !NH || document.visibilityState !== 'visible') return;
  try {
    const s = await NH.autoLogStatus();
    const el = $('#liveTrip');
    if (el) el.innerHTML = s.tripActive ? `<div class="banner" style="background:var(--ok-bg);color:var(--ok)">🔴 Logger tur${s.activeName ? ' – ' + esc(s.activeName) : ''}: <b>${fmtDec(s.activeKm || 0)} km</b> siden ${fmtTime(s.activeStart)}</div>` : '';
    if (wasActive && !s.tripActive) setTimeout(importTrips, 2000);
    wasActive = s.tripActive;
  } catch (e) { /* ignorer */ }
}

function tripsPanel(v) {
  const ts = live('trips').filter(t => t.vehicleId === v.id).sort((a, b) => b.startTs - a.startTs);
  const y = today().slice(0, 4); const yr = ts.filter(t => t.date.startsWith(y));
  let out = IS_NATIVE ? `<div class="card" id="autologCard" style="margin-bottom:14px"><span class="muted small">Henter status …</span></div>`
    : `<p class="muted small" style="margin-top:0">Turene logges automatisk af Android-appen, når telefonen forbinder til køretøjets skærm.</p>`;
  if (!ts.length) return out + '<p class="muted small">Ingen ture endnu.</p>';
  out += `<div class="kpis" style="margin-bottom:10px"><div class="kpi"><div class="l">Ture i ${y}</div><div class="v">${yr.length}</div></div>
    <div class="kpi"><div class="l">Kørt i ${y}</div><div class="v">${fmtKm(Math.round(yr.reduce((a, t) => a + t.km, 0)))}</div></div>
    <div class="kpi"><div class="l">Længste tur</div><div class="v">${fmtKm(Math.round(Math.max(...ts.map(t => t.km))))}</div></div></div>
    <div class="row" style="margin-bottom:8px"><button class="btn" data-act="allTrips" data-id="${v.id}">🗺️ Vis alle ture på kort</button></div>`;
  let month = null;
  for (const t of ts) {
    const m = t.date.slice(0, 7);
    if (m !== month) { month = m; out += `<div class="year-h"><span>${fmtMonth(t.date)}</span><span>${fmtKm(Math.round(ts.filter(x => x.date.startsWith(m)).reduce((a, x) => a + x.km, 0)))}</span></div>`; }
    out += tripItem(t);
  }
  return out;
}
function tripItem(t) {
  const avg = tripAvg(t);
  return `<div class="item" data-act="viewTrip" data-id="${t.id}"><div class="ic">🛣️</div><div class="body">
      <div class="t">${esc(t.title || 'Tur ' + fmtDate(t.date))}${t.work && feat('work') ? ' <span class="badge b-work">Arbejde</span>' : ''}</div>
      <div class="s">${t.title ? fmtDate(t.date) + ' · ' : ''}${fmtTime(t.startTs)}–${fmtTime(t.endTs)} · ${fmtDur(t.endTs - t.startTs)}${avg ? ` · gns. ${Math.round(avg)} km/t` : ''}</div></div>
      <div class="amt">${fmtDec(t.km)} km</div></div>`;
}

async function renderAutoLog(v) {
  const el = $('#autologCard'); if (!el || !NH) return;
  let s; try { s = await NH.autoLogStatus(); } catch (e) { el.innerHTML = `<span class="muted small">Status kunne ikke hentes: ${esc(e.message)}</span>`; return; }
  const addr = (v.btAddress || '').toUpperCase();
  const assoc = (s.associations || []).map(a => a.toUpperCase()).includes(addr);
  const row = (ok, label, tab, fixLabel) => `<div class="row between" style="padding:5px 0;border-bottom:1px solid var(--line)"><span>${ok ? '✅' : '⚠️'} ${label}</span>${ok ? '' : `<button class="btn sm" data-act="fixPerm" data-id="${v.id}" data-tab="${tab}">${fixLabel}</button>`}</div>`;
  const active = s.tripActive && (s.activeAddress || '').toUpperCase() === (addr || ('MANUAL-' + v.id).toUpperCase());
  const activeOther = s.tripActive && !active;
  el.innerHTML = `<div class="row between"><h3>🛰️ Automatisk km-logning</h3>${v.kmFactor ? `<span class="muted small">GPS-korrektion ${v.kmFactor >= 1 ? '+' : ''}${fmtDec((v.kmFactor - 1) * 100)} %</span>` : ''}</div>
    <p class="small" style="margin:6px 0 10px">${v.btName ? `Logger ture, når telefonen forbinder til <b>${esc(v.btName)}</b>.` : 'Vælg den Bluetooth-enhed (f.eks. skærmen), som telefonen forbinder til i dette køretøj.'}</p>
    <div class="row" style="margin-bottom:10px"><button class="btn ${v.btName ? '' : 'primary'}" data-act="pickBt" data-id="${v.id}">📶 ${v.btName ? 'Skift enhed' : 'Vælg Bluetooth-enhed'}</button>
      ${v.btName ? `<button class="btn danger" data-act="removeBt" data-id="${v.id}">Slå fra</button>` : ''}</div>
    ${v.btName ? row(s.location, 'Placering', 'location', 'Tillad') + row(s.backgroundLocation, 'Placering “Tillad altid”', 'backgroundLocation', 'Indstil') +
      row(s.bluetooth, 'Bluetooth', 'bluetooth', 'Tillad') + row(s.notifications, 'Notifikationer', 'notifications', 'Tillad') +
      row(s.batteryUnrestricted, 'Batteri: ubegrænset', 'battery', 'Indstil') + (s.sdk >= 33 ? row(assoc, 'Tilknyttet som companion-enhed', 'associate', 'Tilknyt') : '') : ''}
    <div class="row" style="margin-top:12px">${active ? `<span class="badge b-ok">🔴 Logger nu: ${fmtDec(s.activeKm || 0)} km</span><button class="btn sm" data-act="stopTrip" data-id="${v.id}">⏹ Stop tur</button>`
      : activeOther ? `<span class="muted small">Logger en tur for ${esc(s.activeName || 'et andet køretøj')}.</span>`
      : `<button class="btn sm" data-act="manualTrip" data-id="${v.id}">▶ Start tur manuelt</button><span class="muted small">Til test, eller hvis du kører uden skærmen</span>`}</div>
    ${s.log ? `<details style="margin-top:10px"><summary class="muted small">Hændelseslog</summary><pre class="small" style="white-space:pre-wrap;margin:6px 0 0">${esc(s.log)}</pre></details>` : ''}
    ${v.btAddress ? `<details style="margin-top:6px"><summary class="muted small">Tasker-genvej</summary><p class="small" style="margin:6px 0 0">Start: <code>koretojslog://trip/start?device=${esc(addr)}</code><br>Stop: <code>koretojslog://trip/stop</code></p></details>` : ''}`;
}

async function pickBtDevice(vid) {
  const v = byId('vehicles', vid);
  try {
    let s = await NH.requestPerm({ which: 'bluetooth' });
    if (!s.bluetooth) { toast('Appen skal have adgang til Bluetooth for at se dine enheder'); return; }
    const { devices } = await NH.listBonded();
    if (!devices.length) { toast('Ingen parrede Bluetooth-enheder fundet'); return; }
    const m = modal('Vælg Bluetooth-enhed', `<p class="muted small" style="margin-top:0">Vælg den enhed, telefonen forbinder til i <b>${esc(v.name)}</b> – f.eks. skærmen eller Android Auto-adapteren.</p>
      <div class="quick">${devices.sort((a, b) => a.name.localeCompare(b.name)).map(d => `<button data-addr="${esc(d.address)}" data-name="${esc(d.name)}"><span>📶</span><div><b>${esc(d.name)}</b><div class="muted small">${esc(d.address)}</div></div></button>`).join('')}</div>`);
    $$('[data-addr]', m).forEach(b => b.onclick = async () => {
      await closeLayer();
      if (v.btAddress && v.btAddress !== b.dataset.addr) { try { await NH.disableAutoLog({ address: v.btAddress }); } catch (e) { } }
      upsert('vehicles', { ...v, btAddress: b.dataset.addr, btName: b.dataset.name }); await persist(); render();
      await setupAutoLog(vid);
    });
  } catch (e) { toast('Fejl: ' + e.message, 4000); }
}

async function setupAutoLog(vid) {
  const v = byId('vehicles', vid); if (!v?.btAddress) return;
  try {
    let s = await NH.requestPerm({ which: 'location' });
    if (!s.location) { toast('Placering er nødvendig for at måle turen'); return; }
    if (!s.backgroundLocation) {
      if (confirm('Næste skærm: vælg “Tillad altid” under Placering, så appen kan logge ture, mens den ikke er åben. Tryk derefter tilbage.')) s = await NH.requestPerm({ which: 'backgroundLocation' });
    }
    s = await NH.requestPerm({ which: 'notifications' });
    const r = await NH.enableAutoLog({ address: v.btAddress, name: v.name });
    toast(r.mode === 'companion' ? `Klar! Ture logges, når telefonen forbinder til ${v.btName}` : 'Klar! (Bluetooth-lytter)', 4000);
  } catch (e) { toast(e.code === 'CANCELLED' ? 'Tilknytning annulleret – tryk “Tilknyt” for at prøve igen' : 'Fejl: ' + e.message, 5000); }
  renderAutoLog(byId('vehicles', vid));
}

async function removeBtDevice(vid) {
  const v = byId('vehicles', vid);
  if (!confirm(`Slå automatisk logning fra for ${v.name}?`)) return;
  try { await NH.disableAutoLog({ address: v.btAddress }); } catch (e) { }
  const nv = { ...v }; delete nv.btAddress; delete nv.btName; upsert('vehicles', nv); await persist(); render();
}

async function fixPermission(vid, which) {
  const v = byId('vehicles', vid);
  try {
    if (which === 'battery') await NH.requestBatteryExemption();
    else if (which === 'associate') return setupAutoLog(vid);
    else if (which === 'backgroundLocation') {
      const s = await NH.requestPerm({ which });
      if (!s.backgroundLocation && confirm('Åbn appens indstillinger og vælg Tilladelser → Placering → “Tillad altid”?')) await NH.openAppSettings();
    } else {
      const s = await NH.requestPerm({ which });
      if (!s[which] && confirm('Tilladelsen blev afvist. Åbn appens indstillinger for at give den?')) await NH.openAppSettings();
    }
  } catch (e) { toast('Fejl: ' + e.message); }
  setTimeout(() => renderAutoLog(byId('vehicles', vid)), 800);
}

/* Kort (Leaflet + OpenStreetMap) */
let leafletP = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (!leafletP) leafletP = new Promise((res, rej) => {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = 'lib/leaflet/leaflet.css'; document.head.appendChild(l);
    loadScript('lib/leaflet/leaflet.js').then(res, rej);
  });
  return leafletP;
}
async function drawMap(el, polys) {
  await loadLeaflet();
  const map = L.map(el, { zoomControl: true, attributionControl: true });
  map.attributionControl.setPrefix(false);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  const bounds = [];
  polys.forEach((pts, i) => {
    if (pts.length < 2) return;
    L.polyline(pts, { color: polys.length > 1 ? `hsl(${(i * 47) % 360} 70% 45%)` : '#1e5fae', weight: polys.length > 1 ? 3 : 5, opacity: 0.85 }).addTo(map);
    if (polys.length === 1) {
      L.circleMarker(pts[0], { radius: 7, color: '#16834a', fillOpacity: 1 }).addTo(map).bindTooltip('Start');
      L.circleMarker(pts[pts.length - 1], { radius: 7, color: '#c62828', fillOpacity: 1 }).addTo(map).bindTooltip('Slut');
    }
    bounds.push(...pts);
  });
  if (bounds.length) map.fitBounds(bounds, { padding: [20, 20] }); else map.setView([56, 10.5], 6);
  setTimeout(() => map.invalidateSize(), 250);
  return map;
}

function tripView(id) {
  const t = byId('trips', id); if (!t) return;
  const avg = tripAvg(t);
  const m = modal(t.title || `Tur ${fmtDate(t.date)}`, `
    <div id="tripMap" style="height:${isWide() ? 420 : 300}px;border-radius:12px;overflow:hidden;background:var(--bg)"></div>
    <div class="kpis" style="margin:12px 0">
      <div class="kpi"><div class="l">Distance</div><div class="v">${fmtDec(t.km)} km</div></div>
      <div class="kpi"><div class="l">Tid</div><div class="v" style="font-size:1.05rem">${fmtTime(t.startTs)}–${fmtTime(t.endTs)}</div><div class="l">${fmtDur(t.endTs - t.startTs)}</div></div>
      ${avg ? `<div class="kpi"><div class="l">Gns. fart</div><div class="v">${Math.round(avg)} km/t</div></div>` : ''}
      ${t.maxKmh ? `<div class="kpi"><div class="l">Topfart (GPS)</div><div class="v">${t.maxKmh} km/t</div></div>` : ''}
    </div>
    <form><div class="fgrid">
      ${feat('work') ? `<div class="f full"><label class="check" style="margin:0"><input type="checkbox" name="work" ${t.work ? 'checked' : ''}> 🏢 Arbejde (tæller med i kørselsfradrag)</label></div>` : ''}
      <div class="f full"><label>Titel</label><input name="title" value="${esc(t.title)}" placeholder="F.eks. Tur til Skagen"></div>
      <div class="f full"><label>Noter</label><textarea name="notes">${esc(t.notes)}</textarea></div>
      <div class="f"><label>Distance (km)</label><input name="km" type="number" step="0.1" inputmode="decimal" value="${t.km}"></div>
      <div class="f"><label>Køretøj</label><select name="vehicleId">${vehicleOptions(t.vehicleId)}</select></div>
    </div>
    <p class="muted small">${esc(vehicleName(t.vehicleId))} · GPS målte ${fmtDec(t.gpsKm)} km. Kort: © OpenStreetMap.</p>
    <div class="modal-actions"><button type="button" class="btn danger" data-del>Slet tur</button><span class="spacer"></span>
      <button type="button" class="btn" data-close>Luk</button><button class="btn primary">Gem</button></div></form>`);
  drawMap($('#tripMap', m), [decodePoly(t.poly)]).then(map => { m.closest('.modal-bg')._cleanup = () => map.remove(); }).catch(e => { $('#tripMap', m).innerHTML = `<p class="muted small" style="padding:20px">Kortet kunne ikke indlæses (${esc(e.message)}).</p>`; });
  $('form', m).onsubmit = async ev => {
    ev.preventDefault(); const fd = new FormData(ev.target);
    const work = feat('work') ? fd.get('work') === 'on' : !!t.work;
    const nt = { ...t, title: fd.get('title').trim(), notes: fd.get('notes').trim(), km: num(fd.get('km')) ?? t.km, vehicleId: fd.get('vehicleId'), work, workAuto: work === !!t.work ? t.workAuto : false };
    upsert('trips', nt);
    const r = data.readings.find(x => x.id === 'trip_' + t.id && !x.deleted);
    if (r && (nt.km !== t.km || nt.vehicleId !== t.vehicleId)) upsert('readings', { ...r, km: Math.round(r.km - t.km + nt.km), vehicleId: nt.vehicleId });
    await persist(); await closeLayer(); render(); toast('Gemt');
  };
  $('[data-del]', m).onclick = async () => {
    if (!confirm('Slet turen? Den automatiske kilometeraflæsning fra turen slettes også.')) return;
    softDelete('trips', id); softDelete('readings', 'trip_' + id); await persist(); await closeLayer(); render();
  };
}

/* ---------- Arbejdsture (kørselsfradrag) ---------- */
function distM(aLat, aLon, bLat, bLon) {
  const R = 6371000, r = Math.PI / 180, dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// Arbejdsplads, som turen starter eller slutter ved (eller null)
function workPlaceOf(poly) {
  const places = live('places'); if (!places.length || !poly) return null;
  let pts; try { pts = decodePoly(poly); } catch (e) { return null; }
  if (!pts.length) return null;
  const ends = [pts[0], pts[pts.length - 1]];
  return places.find(p => ends.some(([la, lo]) => distM(la, lo, p.lat, p.lon) <= (p.radius || 400))) || null;
}
function retagWork(silent) {
  let n = 0;
  for (const t of live('trips')) {
    if (t.workAuto === false) continue;      // rettet i hånden – røres ikke
    const w = !!workPlaceOf(t.poly);
    if (w !== !!t.work) { upsert('trips', { ...t, work: w, workAuto: true }); n++; }
  }
  return persist().then(() => { if (!silent) { render(); toast(n ? `${n} tur${n > 1 ? 'e' : ''} opdateret` : 'Ingen ændringer'); } return n; });
}
function workCard() {
  const ps = live('places');
  return `<div class="card" style="margin-top:14px"><h3>🏢 Arbejdsplads (kørselsfradrag)</h3>
    <p class="muted small">Ture, der starter eller slutter ved en arbejdsplads, markeres automatisk som <b>Arbejde</b>. Du kan altid rette det på den enkelte tur. Opgørelsen pr. måned finder du under Rapporter.</p>
    ${ps.map(p => `<div class="item" data-act="editPlace" data-id="${p.id}"><div class="ic">🏢</div><div class="body"><div class="t">${esc(p.name)}</div>
      <div class="s">${esc(p.label || `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`)} · inden for ${p.radius || 400} m</div></div></div>`).join('')}
    <div class="row" style="margin-top:8px"><button class="btn" data-act="addPlace">＋ Tilføj arbejdsplads</button>${ps.length ? '<button class="btn" data-act="retagWork">↻ Markér tidligere ture</button>' : ''}</div></div>`;
}
function placeForm(id) {
  const p = id ? { ...byId('places', id) } : { id: uid(), name: 'Arbejde', kind: 'work', radius: 400, lat: null, lon: null, label: '' };
  const m = modal(id ? 'Arbejdsplads' : 'Ny arbejdsplads', `<form>
    <div class="fgrid">
      <div class="f full"><label>Navn</label><input name="name" value="${esc(p.name)}"></div>
      <div class="f full"><label>Find adresse</label><div class="row" style="flex-wrap:nowrap"><input id="plQ" type="search" placeholder="Vej, nr., by" style="flex:1" value="${esc(p.label)}"><button type="button" class="btn" id="plSearch">Søg</button></div>
        <div id="plRes"></div></div>
      <div class="f full"><button type="button" class="btn" id="plHere">📍 Brug min nuværende position</button></div>
      <div class="f full"><div id="plMap" style="height:260px;border-radius:12px;overflow:hidden;background:var(--bg)"></div>
        <p class="muted small" style="margin:4px 0 0">Tryk på kortet for at flytte punktet.</p></div>
      <div class="f"><label>Afstand (meter)</label><input name="radius" type="number" inputmode="numeric" value="${p.radius || 400}"></div>
    </div>
    <div class="modal-actions">${id ? '<button type="button" class="btn danger" data-del>Slet</button>' : ''}<span class="spacer"></span>
      <button type="button" class="btn" data-close>Annullér</button><button class="btn primary">Gem</button></div></form>`);
  let map = null, mk = null, circ = null;
  const setPt = (lat, lon, label, zoom) => {
    p.lat = lat; p.lon = lon; if (label != null) p.label = label;
    if (!map) return;
    const r = num($('[name=radius]', m).value) || 400;
    if (mk) mk.setLatLng([lat, lon]); else mk = L.marker([lat, lon]).addTo(map);
    if (circ) { circ.setLatLng([lat, lon]); circ.setRadius(r); } else circ = L.circle([lat, lon], { radius: r, color: '#1e5fae', weight: 1, fillOpacity: 0.12 }).addTo(map);
    map.setView([lat, lon], zoom || Math.max(map.getZoom() || 15, 15));
  };
  loadLeaflet().then(() => {
    map = L.map($('#plMap', m)); map.attributionControl.setPrefix(false);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
    if (p.lat != null) setPt(p.lat, p.lon, null, 15); else map.setView([56, 10.5], 6);
    map.on('click', e => setPt(e.latlng.lat, e.latlng.lng, ''));
    m.closest('.modal-bg')._cleanup = () => map.remove();
    setTimeout(() => map.invalidateSize(), 250);
  }).catch(e => { $('#plMap', m).innerHTML = `<p class="muted small" style="padding:20px">Kortet kunne ikke indlæses (${esc(e.message)}).</p>`; });
  $('[name=radius]', m).onchange = () => { if (p.lat != null) setPt(p.lat, p.lon); };
  const search = async () => {
    const q = $('#plQ', m).value.trim(); if (!q) return;
    const box = $('#plRes', m); box.innerHTML = '<p class="muted small">Søger …</p>';
    try {
      const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=dk&accept-language=da&q=' + encodeURIComponent(q));
      const list = await r.json();
      box.innerHTML = list.length ? list.map((x, i) => `<div class="item" data-i="${i}" style="cursor:pointer"><div class="body"><div class="s">${esc(x.display_name)}</div></div></div>`).join('') : '<p class="muted small">Ingen resultater.</p>';
      box.querySelectorAll('[data-i]').forEach(el => el.onclick = () => { const x = list[+el.dataset.i]; setPt(+x.lat, +x.lon, x.display_name.split(',').slice(0, 2).join(','), 16); box.innerHTML = ''; });
    } catch (e) { box.innerHTML = `<p class="muted small">Søgning fejlede (${esc(e.message)}).</p>`; }
  };
  $('#plSearch', m).onclick = search;
  $('#plQ', m).onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); search(); } };
  $('#plHere', m).onclick = () => {
    if (!navigator.geolocation) return toast('Position er ikke tilgængelig');
    toast('Finder position …');
    navigator.geolocation.getCurrentPosition(pos => setPt(pos.coords.latitude, pos.coords.longitude, 'Min position', 16),
      err => toast('Position kunne ikke findes: ' + err.message), { enableHighAccuracy: true, timeout: 15000 });
  };
  $('form', m).onsubmit = async ev => {
    ev.preventDefault();
    if (p.lat == null) return toast('Vælg et punkt på kortet eller søg en adresse');
    const fd = new FormData(ev.target);
    upsert('places', { ...p, name: fd.get('name').trim() || 'Arbejde', radius: Math.max(50, num(fd.get('radius')) || 400) });
    await closeLayer(); const n = await retagWork(true); render(); toast(n ? `Gemt · ${n} tur${n > 1 ? 'e' : ''} markeret` : 'Gemt');
  };
  const del = $('[data-del]', m);
  if (del) del.onclick = async () => { if (!confirm('Slet arbejdspladsen? Ture, der er markeret automatisk, opdateres.')) return;
    softDelete('places', p.id); await closeLayer(); await retagWork(true); render(); };
}
function workTrips(year) {
  return live('trips').filter(t => t.work && t.date.startsWith(year) && (!rf.vehicle || t.vehicleId === rf.vehicle));
}
function workMonths(year) {
  return MONTHS.map((mn, i) => {
    const k = `${year}-${String(i + 1).padStart(2, '0')}`;
    const ts = workTrips(year).filter(t => t.date.startsWith(k));
    return { name: mn[0].toUpperCase() + mn.slice(1), trips: ts.length, days: new Set(ts.map(t => t.date)).size, km: ts.reduce((a, t) => a + (t.km || 0), 0) };
  });
}
function workReport() {
  const all = live('trips').filter(t => t.work);
  if (!all.length && !live('places').length) return '';
  const cy = today().slice(0, 4);
  const years = [...new Set([cy, ...all.map(t => t.date.slice(0, 4))])].sort().reverse();
  const y = rf.workYear && years.includes(rf.workYear) ? rf.workYear : cy;
  const ms = workMonths(y); const tot = ms.reduce((a, m) => ({ trips: a.trips + m.trips, days: a.days + m.days, km: a.km + m.km }), { trips: 0, days: 0, km: 0 });
  return fold('r-work', `🏢 Arbejdsture ${y}`, `<p class="muted small" style="margin-top:0">Til kørselsfradrag${rf.vehicle ? ' · ' + esc(vehicleName(rf.vehicle)) : ''}.</p>
    <div class="row no-print" style="margin-bottom:8px"><div class="chips">${years.map(x => `<button class="chip ${x === y ? 'on' : ''}" data-act="workYear" data-id="${x}">${x}</button>`).join('')}</div>
      <span class="spacer"></span><button class="btn" data-act="exportWorkCsv" data-id="${y}">⤓ CSV</button></div>
    <div class="card scroll-x"><table class="t"><tr><th>Måned</th><th class="n">Ture</th><th class="n">Dage</th><th class="n">Km</th></tr>
      ${ms.map(m => `<tr${m.trips ? '' : ' class="muted"'}><td>${m.name}</td><td class="n">${m.trips}</td><td class="n">${m.days}</td><td class="n">${m.trips ? fmtDec(m.km) : ''}</td></tr>`).join('')}
      <tr><td><b>I alt</b></td><td class="n"><b>${tot.trips}</b></td><td class="n"><b>${tot.days}</b></td><td class="n"><b>${fmtDec(tot.km)}</b></td></tr></table>
      <p class="muted small" style="margin:8px 0 0">Ture = antal ture markeret Arbejde. Dage = antal forskellige dage med mindst én arbejdstur. ${live('places').length ? '' : '<a href="#/settings">Tilføj din arbejdsplads</a> for automatisk markering.'}</p></div>`, false, `${tot.trips} ture`);
}
function exportWorkCsv(year) {
  const ms = workMonths(year);
  const dec = n => String(Math.round(n * 10) / 10).replace('.', ',');
  const rows = [['Måned', 'Ture', 'Dage', 'Km'], ...ms.map(m => [m.name, m.trips, m.days, dec(m.km)]),
    ['I alt', ms.reduce((a, m) => a + m.trips, 0), ms.reduce((a, m) => a + m.days, 0), dec(ms.reduce((a, m) => a + m.km, 0))], [], ['Dato', 'Start', 'Slut', 'Køretøj', 'Km', 'Titel']];
  for (const t of workTrips(year).sort((a, b) => a.startTs - b.startTs)) rows.push([t.date, fmtTime(t.startTs), fmtTime(t.endTs), vehicleName(t.vehicleId), dec(t.km), t.title || '']);
  const csv = '﻿' + rows.map(r => r.map(v => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(';')).join('\r\n');
  download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `arbejdsture-${year}.csv`);
}

function allTripsMap(vid) {
  const v = byId('vehicles', vid);
  const ts = live('trips').filter(t => t.vehicleId === vid && t.poly);
  const years = [...new Set(ts.map(t => t.date.slice(0, 4)))].sort().reverse();
  const m = modal(`Alle ture – ${v.name}`, `<div class="chips" style="margin-bottom:10px">${['alle', ...years].map((y, i) => `<button class="chip ${i === 0 ? 'on' : ''}" data-y="${y}">${y === 'alle' ? 'Alle år' : y}</button>`).join('')}</div>
    <div id="allMap" style="height:${isWide() ? 520 : 420}px;border-radius:12px;overflow:hidden;background:var(--bg)"></div>
    <p class="muted small">${ts.length} ture · ${fmtKm(Math.round(ts.reduce((a, t) => a + t.km, 0)))} · Kort: © OpenStreetMap</p>`);
  const bg = m.closest('.modal-bg'); let map = null;
  const draw = async y => { if (map) map.remove(); map = await drawMap($('#allMap', m), ts.filter(t => y === 'alle' || t.date.startsWith(y)).map(t => decodePoly(t.poly))); bg._cleanup = () => map && map.remove(); };
  $$('[data-y]', m).forEach(b => b.onclick = () => { $$('[data-y]', m).forEach(x => x.classList.toggle('on', x === b)); draw(b.dataset.y); });
  draw('alle').catch(e => { $('#allMap', m).innerHTML = `<p class="muted small" style="padding:20px">Kortet kunne ikke indlæses (${esc(e.message)}).</p>`; });
}

/* ---------- Handlinger ---------- */
function doPrint() {
  printing = true; $$('details.fold').forEach(d => { d.dataset.wasOpen = d.open ? '1' : ''; d.open = true; });
  setTimeout(() => { $$('details.fold').forEach(d => { d.open = d.dataset.wasOpen === '1'; }); printing = false; }, 1500);
  if (IS_NATIVE) return NH.print({ name: 'Motorist ' + today() }).catch(e => toast(e.message));
  window.print();
}
const ACT = {
  quickAdd: () => quickAdd(),
  addVehicle: () => vehicleForm(),
  editVehicle: d => vehicleForm(d.id),
  goVehicle: d => { location.hash = '#/v/' + d.id; },
  goVehicleTab: d => { vTab[d.id] = OLD_TAB[d.tab] || d.tab; location.hash = '#/v/' + d.id; },
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
  hFilt: d => { vFilt[d.id] = d.f; render(); },
  rCat: d => { rf.cats.has(d.id) ? rf.cats.delete(d.id) : rf.cats.add(d.id); render(); },
  rCatAll: () => { rf.cats = rf.cats.size === Object.keys(TYPES).length ? new Set() : new Set(Object.keys(TYPES)); render(); },
  exportCsv: () => exportCsv(),
  addPlace: () => placeForm(), editPlace: d => placeForm(d.id), retagWork: () => retagWork(),
  workYear: d => { rf.workYear = d.id; render(); }, exportWorkCsv: d => exportWorkCsv(d.id),
  clearSpeedCache: async () => { if (!confirm('Slette de gemte fartgrænser? De hentes igen, næste gang du kører.')) return; await NH.speedCache({ clear: true }); render(); toast('Ryddet'); },
  addRecurring: d => recurringForm(d.id), editRecurring: d => recurringForm(null, d.id),
  addTire: d => tireForm(d.id), editTire: d => tireForm(null, d.id), changeTire: d => { const t = byId('tires', d.id); tireForm(t.vehicleId, null, t); },
  addPart: d => partForm(d.id), editPart: d => partForm(null, d.id),
  viewTrip: d => tripView(d.id), allTrips: d => allTripsMap(d.id),
  pickBt: d => pickBtDevice(d.id), removeBt: d => removeBtDevice(d.id),
  fixPerm: d => fixPermission(d.id, d.tab),
  manualTrip: async d => { const v = byId('vehicles', d.id); await NH.startTrip({ address: 'MANUAL-' + v.id, name: v.name }); toast('Tur startet – kør en tur, og tryk Stop bagefter'); setTimeout(() => renderAutoLog(v), 1200); },
  stopTrip: async d => { await NH.stopTrip(); toast('Tur stoppet'); setTimeout(async () => { await importTrips(); const v = byId('vehicles', d.id); if (v) renderAutoLog(v); }, 1500); },
  theme: d => { setTheme(d.id); render(); },
  toggleTheme: () => { setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); if (currentRoute().name === 'settings') render(); },
  print: () => doPrint(),
  connect: () => connectDrive(),
  syncNow: () => (Drive.hasToken() || IS_NATIVE) ? Sync.run().then(render) : connectDrive(),
  syncPill: () => { if (Sync.state === 'auth') connectDrive(); else if (Sync.state === 'local') location.hash = '#/settings'; else Sync.run().then(render); },
  disconnect: () => { if (!confirm('Afbryd forbindelsen til Google Drive? Data bliver liggende både på denne enhed og på Drive.')) return;
    Drive.logout(); localStorage.removeItem('mode'); Drive.ids = {}; Drive.saveIds(); Sync.set('local'); render(); },
  exportJson: () => download(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }), `motorist-backup-${today()}.json`),
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  if (el.closest('.modal') && (el.dataset.act === 'removeFile')) return; // håndteres i formularen
  const fn = ACT[el.dataset.act]; if (!fn) return;
  e.preventDefault(); e.stopPropagation(); fn(el.dataset, el);
});

/* ---------- Opstart ---------- */
async function start() {
  applyTheme();
  try { const d = await DB.get('kv', 'data'); if (d) data = merge(emptyData(), d); } catch (e) { console.error(e); toast('Kunne ikke læse lokale data'); }
  if (generateRecurring()) persist();
  if (IS_NATIVE) { setTimeout(importTrips, 1500); setInterval(pollTrip, 15000); setTimeout(pushCarData, 2000); }
  window.addEventListener('hashchange', render);
  matchMedia('(min-width: 840px)').addEventListener('change', render);
  render();
  if (Drive.enabled()) { Sync.run(); } else Sync.set('local');
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (generateRecurring()) { persist(); render(); }
    if (IS_NATIVE) importTrips();
    if (Drive.enabled() && (Drive.hasToken() || IS_NATIVE)) Sync.run();
  });
  if (!IS_NATIVE && 'serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(console.warn);
}
start();
