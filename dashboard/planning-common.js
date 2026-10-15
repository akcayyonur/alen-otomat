/**
 * Planlama ekranlarinin ORTAK yardimcilari (urunler, siparisler, program eslemesi, iceri alma). Ekranlar birbirini import etmez.
 */
import { escapeHtml } from './format.js';
import { api } from './lib-common.js';
import { getSession, closedSections } from './auth-view.js';

export const put = (path, obj) =>
  api(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
export const del = (path) => api(path, { method: 'DELETE' });

const formats = new Map();
const nf = (d) => {
  if (!formats.has(d)) formats.set(d, new Intl.NumberFormat('tr-TR', { maximumFractionDigits: d }));
  return formats.get(d);
};

export const DASH = '<span class="is-null" aria-label="boş">—</span>';
/** Okunamayan/bos alan soluk tire (0 ile karismaz). */
export const cellText = (v) => (v === null || v === undefined || v === '' ? DASH : escapeHtml(v));
export const fmtNum = (v, digits = 0) => (v === null || v === undefined ? DASH : nf(digits).format(v));
/** kg -> gram metni (agirliklar kg saklanir, ekranda gram gosterilir). */
export const gramText = (kg) => (kg === null || kg === undefined ? DASH : nf(2).format(kg * 1000));
export const dateText = (ms) => (ms === null || ms === undefined ? DASH : escapeHtml(new Date(ms).toLocaleDateString('tr-TR')));
export const dateTimeText = (ms) => (ms ? new Date(ms).toLocaleString('tr-TR', { hour12: false }) : '—');

/** Gram/ondalik metni (virgul ya da nokta) sayiya; bos null; cozulemezse metin aynen (sunucu anlasilir hata versin). */
export function parseInput(value) {
  const t = String(value ?? '').trim().replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : String(value).trim();
}
/** gram -> kg (kayan nokta kirini temizler). */
export const gramToKg = (g) => (typeof g === 'number' ? Number((g / 1000).toFixed(9)) : g);

export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** Kapatma dugmeli, Esc ile kapanan basit pencere. @returns {{dlg: HTMLDialogElement, body: HTMLElement, close: () => void}} */
export function openModal({ title, eyebrow = 'Planlama', wide = false }) {
  const dlg = document.createElement('dialog');
  dlg.className = `modal${wide ? ' modal-wide' : ''}`;
  const id = `pl-title-${Math.random().toString(36).slice(2, 8)}`;
  dlg.setAttribute('aria-labelledby', id);
  dlg.innerHTML =
    `<div class="modal-inner"><header class="modal-head"><div><span class="eyebrow">${escapeHtml(eyebrow)}</span>` +
    `<h3 id="${id}">${escapeHtml(title)}</h3></div><button type="button" class="icon-btn" data-act="close">Kapat</button></header>` +
    '<div class="modal-body" data-role="body"></div></div>';
  document.body.append(dlg);
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.addEventListener('click', (ev) => { if (ev.target.closest('[data-act="close"]')) close(); });
  dlg.addEventListener('cancel', (ev) => { ev.preventDefault(); close(); });
  dlg.showModal();
  return { dlg, body: dlg.querySelector('[data-role="body"]'), close };
}

/** Durum rozeti: renk tek basina anlam tasimaz, ikon + etiket her zaman var. */
export const chip = (cls, icon, label) => `<span class="chip chip-${cls}"><span aria-hidden="true">${icon}</span> ${escapeHtml(label)}</span>`;

/* ---- is emri hesaplari: backend/planning/calc.js ile AYNI formuller (ekranda canli onizleme icin; bir test iki dosyanin esitligini denetler) ---- */
export const BAR_USABLE_MM = 2900;
export const CUT_ALLOWANCE_MM = 2;
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
/** @returns {{kg: number|null, bars: number|null}} */
export function rawMaterial({ qty, grossKg, lengthMm }) {
  return {
    kg: qty > 0 && grossKg > 0 ? round(qty * grossKg, 3) : null,
    bars: qty > 0 && lengthMm > 0 ? round((qty * (lengthMm + CUT_ALLOWANCE_MM)) / BAR_USABLE_MM, 2) : null,
  };
}
export const plannedHours = (qty, sec) => (qty > 0 && sec > 0 ? round((qty * sec) / 3600, 2) : null);
export const machineNumber = (id) => { const m = /(\d+)\s*$/.exec(String(id ?? '')); return m ? Number(m[1]) : null; };

/** Yerel gun anahtari 'YYYY-MM-DD' (rapor araliklari). */
export const dateKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** Rapor araligi hazir secimleri (Hammadde, Verimlilik): range(simdi) -> [baslangic, bitis] 'YYYY-MM-DD'. */
export const RANGE_PRESETS = Object.freeze([
  { key: 'bugun', label: 'Bugün', range: (n) => [dateKey(n), dateKey(n)] },
  { key: 'ay', label: 'Bu ay', range: (n) => [dateKey(new Date(n.getFullYear(), n.getMonth(), 1)), dateKey(n)] },
  { key: 'gecenay', label: 'Geçen ay', range: (n) => [dateKey(new Date(n.getFullYear(), n.getMonth() - 1, 1)), dateKey(new Date(n.getFullYear(), n.getMonth(), 0))] },
  { key: '30', label: 'Son 30 gün', range: (n) => [dateKey(new Date(n.getFullYear(), n.getMonth(), n.getDate() - 29)), dateKey(n)] },
]);

/** ms -> 'YYYY-MM-DD' (yerel; <input type="date"> degeri). */
export function isoDate(ms) {
  if (ms === null || ms === undefined) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Fabrika PC'si ortak hesapla kullanilir: "yapan kisi" (serbest metin, kimlik dogrulama DEGIL) bir sonraki islem icin hatirlanir.
 * Tarayici depolamasi kapaliysa sessizce bos doner.
 */
const PERSON_KEY = 'cnc-shop-person';
export function rememberedPerson() {
  try { return localStorage.getItem(PERSON_KEY) ?? ''; } catch { return ''; }
}
export function rememberPerson(value) {
  try {
    const t = String(value ?? '').trim();
    if (t) localStorage.setItem(PERSON_KEY, t);
  } catch { /* gizli sekme */ }
}

/** Ondalik sayi metni (virgullu, en cok `d` hane). */
export const fmtDec = (v, d = 2) => (v === null || v === undefined ? '' : new Intl.NumberFormat('tr-TR', { maximumFractionDigits: d }).format(v));

/** Is emri durumu rozeti: renk tek basina anlam tasimaz, ikon + etiket her zaman var. */
const WO_STATUS = Object.freeze({
  planlandi: ['none', '◔', 'planlandı'], uretimde: ['info', '▶', 'üretimde'], bitti: ['ok', '✓', 'bitti'], iptal: ['bad', '✕', 'iptal'],
});
export const woStatusChip = (s) => chip(...(WO_STATUS[s] ?? ['none', '?', String(s)]));

/* ---- roller: planlama ekranlari hangi dugmeleri gosterecegini buradan okur (YETKIYI sunucu verir; bu yalniz gorunum) ---- */
/** 'admin' | 'operator' | 'viewer' (izleyici). */
export const planningRole = () => getSession()?.user?.role ?? 'viewer';
export const isViewer = () => planningRole() === 'viewer';
export const isAdminRole = () => planningRole() === 'admin';
/** Bu bolum bu kurulumda KAPALI mi (sunucu uclarini da reddeder)? Ekranlar kapali bolumun bilgisini gostermez. */
export const sectionClosed = (key) => closedSections().includes(key);

/** Acik .pl-form-dlg penceresini tarayicinin yazdir penceresiyle basar (styles.css: body.pl-printing). */
export function printModal() {
  document.body.classList.add('pl-printing');
  const done = () => { document.body.classList.remove('pl-printing'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
}

/** Bayt -> "123 KB" / "1,2 MB". */
export const sizeText = (bytes) => (bytes == null ? '' : bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1).replace('.', ',')} MB`);

/**
 * Bir LISTEYI kagit formun duzeninde yazdirir (GKK rapor numaralari EYS.FR.011, ilk baskı onay listesi EYS.FR.013):
 * baslik, form no, tarih ve satirlar; sayfa degisince sutun basliklari tekrarlanir.
 * @param {{title: string, formNo: string, heads: string[], rows: (string|number|null)[][], note?: string}} o
 */
export function openListPrint({ title, formNo, heads, rows, note = '' }) {
  const m = openModal({ title: `Yazdır · ${title}`, wide: true });
  m.dlg.classList.add('pl-form-dlg');
  m.body.innerHTML =
    '<div class="dt-actions pl-form-actions"><button type="button" class="icon-btn btn-primary" data-act="print">Yazdır</button></div>' +
    `<p class="hint pl-form-actions">${rows.length} satır, A4 dikey. Listeyi yazdırmadan önce ekranda süzün ya da arayın: süzülmüş satırlar basılır.</p>` +
    '<div class="pl-form pl-lf">' +
    `<div class="pl-f-head"><div class="pl-f-title pl-lf-title">${escapeHtml(title)}</div><div class="pl-f-no"><span class="pl-f-label">${escapeHtml(formNo)}</span> · ${escapeHtml(new Date().toLocaleDateString('tr-TR'))}</div></div>` +
    `<table class="pl-lf-t"><thead><tr>${heads.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c == null ? '' : escapeHtml(String(c))}</td>`).join('')}</tr>`).join('')}</tbody></table>` +
    `<p class="pl-f-foot">${note ? `${escapeHtml(note)} · ` : ''}Sistemden basıldı · ${escapeHtml(new Date().toLocaleString('tr-TR', { hour12: false }))}</p></div>`;
  m.body.querySelector('[data-act="print"]').addEventListener('click', printModal);
  return m;
}
