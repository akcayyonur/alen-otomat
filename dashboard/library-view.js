/**
 * Program kutuphanesi ekrani, tezgah detayindaki "Programlar" paneli ve
 * "Programi tezgaha gonder" penceresi.
 *
 * Kurallar (ekranda da yazar):
 *  - Program tezgaha KOPYALANIR; calistirmak icin panelden secilmesi gerekir.
 *  - Mevcut dosyanin uzerine YAZILMAZ.
 *  - Gondermeden once on kontrol, sonra TEZGAH KIMLIGINI yazarak onay.
 * Icerik yorumlanmaz: dosya oldugu gibi saklanir ve tasinir.
 *
 * Durum rengi tek basina anlam tasimaz: her durum ikon + etiket + renk.
 */
import { escapeHtml, num, dateTime, clock } from './format.js';

/* ------------------------------------------------------------------ ortak */

const STATUS = Object.freeze({
  guncel: { icon: '✓', label: 'Güncel', cls: 'ok' },
  eski: { icon: '▼', label: 'Eski sürüm', cls: 'warn' },
  farkli: { icon: '≠', label: 'Farklı içerik', cls: 'bad' },
  belirsiz: { icon: '?', label: 'Doğrulanmadı', cls: 'warn' },
  'kutuphanede-yok': { icon: '＋', label: 'Kütüphanede yok', cls: 'info' },
  'tezgahta-yok': { icon: '—', label: 'Tezgahta yok', cls: 'none' },
  taranmadi: { icon: '·', label: 'Taranmadı', cls: 'none' },
  sistem: { icon: '⚙', label: 'Sistem dosyası', cls: 'none' },
});

const TRANSFER_STATUS = Object.freeze({
  basarili: { icon: '✓', label: 'Başarılı', cls: 'ok' },
  reddedildi: { icon: '✕', label: 'Gönderilmedi (ön kontrol)', cls: 'bad' },
  basarisiz: { icon: '✕', label: 'Başarısız', cls: 'bad' },
  dogrulanamadi: { icon: '▲', label: 'Doğrulanamadı', cls: 'warn' },
  basladi: { icon: '…', label: 'Sürüyor', cls: 'info' },
});

const STEP_LABEL = Object.freeze({
  'on-kontrol': 'Ön kontrol',
  yukle: 'Geçici adla yükleme',
  'boyut-dogrula': 'Boyut doğrulama',
  'geri-oku-sha': 'Geri okuma ve SHA-256',
  'nihai-ada-cevir': 'Nihai ada çevirme',
  'son-dogrulama': 'Son doğrulama',
  temizlik: 'Temizlik',
});

const CHECK_ICON = Object.freeze({ ok: '✓', info: 'ℹ', warn: '▲', block: '✕' });

const kb = (n) => (n == null ? '—' : n < 1024 ? `${num(n)} bayt` : `${num(n / 1024, 1)} KB`);
/** Sinir etiketi: 1.000.000 bayt "1 MB" okunur (976,6 KB degil). */
const maxLabel = (n) => (n % 1_000_000 === 0 ? `${n / 1_000_000} MB` : kb(n));
const folderLabel = (c) => (c === '' ? 'Kök (ortak alan)' : c);
const programLabel = (customer, name) => `${customer === '' ? '' : `${customer}\\`}${name}`;

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function api(path, init) {
  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    throw new ApiError(`Sunucuya ulaşılamadı: ${err.message}`, 0);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error ?? `Hata (HTTP ${res.status})`, res.status);
  return body;
}
const post = (path, obj) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj ?? {}) });

const userName = {
  get() { try { return localStorage.getItem('cnc-user') ?? ''; } catch { return ''; } },
  set(v) { try { localStorage.setItem('cnc-user', v); } catch { /* gizli sekme */ } },
};

function chip(status, text = null, title = null) {
  const s = STATUS[status] ?? { icon: '·', label: String(status), cls: 'none' };
  return `<span class="chip chip-${s.cls}" title="${escapeHtml(title ?? s.label)}"><span aria-hidden="true">${s.icon}</span> ${escapeHtml(text ?? s.label)}</span>`;
}

/** Matris hucresi: kisa metin + ikon; tam aciklama title'da. */
function cell(c) {
  if (!c) return chip('taranmadi', '·');
  switch (c.status) {
    case 'guncel': return chip('guncel', `v${c.versionNo}`, `Güncel: tezgahta son sürüm (v${c.versionNo}) var`);
    case 'eski': return chip('eski', `v${c.versionNo}`, `Eski sürüm: tezgahta v${c.versionNo}, kütüphanede son sürüm v${c.latestVersion}`);
    case 'farkli': return chip('farkli', 'farklı', 'Aynı ad, kütüphanedeki hiçbir sürümle tutmayan içerik');
    case 'belirsiz': return chip('belirsiz', '?', 'Ad ve boyut tutuyor ama içerik henüz doğrulanmadı');
    case 'tezgahta-yok': return chip('tezgahta-yok', 'yok', 'Bu tezgahta yok');
    case 'kutuphanede-yok': return chip('kutuphanede-yok', 'kütüphanede yok', 'Tezgahta var, kütüphanede yok: kütüphaneye alınabilir');
    case 'sistem': return chip('sistem', 'sistem', 'Program değil: tezgahın kendi dosyası');
    default: return chip('taranmadi', '·', 'Tezgah henüz taranmadı');
  }
}

function toast(host, text, ok = true) {
  const el = host.querySelector('[data-role="msg"]');
  if (!el) return;
  el.hidden = !text;
  el.className = `notice${ok ? '' : ' notice-sim'}`;
  el.textContent = text ?? '';
}

const CHANGED = 'cnc:programs-changed';
const announce = () => document.dispatchEvent(new CustomEvent(CHANGED));

/* ================================================================ KUTUPHANE EKRANI */

const lib = {
  host: null, ready: false, config: null, programs: [], matrix: null, customers: [],
  transfers: [], query: '', customer: '', selectedId: null, detail: null, previewNo: null,
  preview: null, pending: [], seq: 0,
};

export function resetLibraryView() {
  lib.ready = false;
  lib.selectedId = null;
  lib.detail = null;
}

export async function renderLibrary(host, selectedId = null) {
  lib.host = host;
  if (!lib.ready) {
    lib.ready = true;
    buildLibrarySkeleton();
    wireLibrary();
    await loadLibrary();
  }
  if (selectedId !== lib.selectedId) await selectProgram(selectedId);
}

function buildLibrarySkeleton() {
  lib.host.innerHTML =
    '<header class="dt-head"><div>' +
    '<span class="eyebrow">Program kütüphanesi</span><h2>Tezgah programları</h2>' +
    '<p class="dt-sub">Programlar merkezi bir kütüphanede tutulur, hangi programın hangi tezgahta ve ' +
    'hangi sürümde olduğu görünür, ve seçilen tezgahın müşteri klasörüne gönderilir. ' +
    '<b>Gönderilen program tezgahta aktif olmaz</b>: çalıştırmak için panelden seçilmesi gerekir.</p>' +
    '</div></header>' +
    '<p data-role="msg" class="notice" hidden></p>' +
    '<div data-role="notices"></div>' +

    '<section class="dt-block"><div class="dt-block-head"><h3>Programı kütüphaneye ekle</h3>' +
    '<label class="fld-inline">Adınız (kayıt için) <input data-role="user" maxlength="40" placeholder="ör. Ayşe"></label></div>' +
    '<div class="dropzone" data-role="drop" tabindex="0" role="button" ' +
    'aria-label="Program dosyalarını sürükleyip bırakın ya da dosya seçmek için Enter\'a basın">' +
    '<p><b>Program dosyalarını buraya sürükleyin</b> ya da <u>dosya seçin</u></p>' +
    '<p class="hint">Dosya olduğu gibi saklanır ve tezgaha aynen gönderilir; içeriği yorumlanmaz. En fazla <span data-role="max">1 MB</span>.</p>' +
    '<input type="file" multiple hidden data-role="file"></div>' +
    '<div data-role="pending"></div></section>' +

    '<section class="dt-block"><div class="dt-block-head"><h3>Programlar ve tezgahlardaki durumu</h3>' +
    '<div class="dt-actions">' +
    '<input type="search" data-role="q" placeholder="Program ya da müşteri ara…" aria-label="Program ara" class="fld-sm">' +
    '<select data-role="cust" aria-label="Müşteri filtresi" class="fld-sm"></select></div></div>' +
    '<div class="table-wrap" data-role="table"></div>' +
    '<ul class="legend legend-chips" data-role="legend"></ul></section>' +

    '<section class="dt-block" data-role="detail" hidden></section>' +

    '<section class="dt-block"><div class="dt-block-head"><h3>Gönderme geçmişi</h3>' +
    '<button type="button" class="icon-btn" data-act="refresh-history">Yenile</button></div>' +
    '<div class="table-wrap" data-role="history"></div></section>';

  const userInput = lib.host.querySelector('[data-role="user"]');
  userInput.value = userName.get();
}

async function loadLibrary() {
  try {
    const [config, programs, matrix, customers, transfers] = await Promise.all([
      api('/api/library/config'),
      api('/api/library/programs'),
      api('/api/library/matrix'),
      api('/api/library/customers'),
      api('/api/transfers?limit=15'),
    ]);
    Object.assign(lib, { config, programs: programs.programs, matrix, customers: customers.customers, transfers: transfers.transfers });
  } catch (err) {
    toast(lib.host, `Kütüphane yüklenemedi: ${err.message}`, false);
    return;
  }
  renderNotices();
  renderPending();
  renderTable();
  renderHistory();
  lib.host.querySelector('[data-role="max"]').textContent = maxLabel(lib.config.maxProgramBytes);
}

// Bir gonderme/tarama/iceri alma bitince (baska ekranlardan da) kutuphane listeleri tazelenir.
document.addEventListener(CHANGED, () => {
  if (lib.ready && lib.host?.isConnected && !lib.host.hidden) reloadLists();
});

async function reloadLists() {
  try {
    const [programs, matrix, customers, transfers] = await Promise.all([
      api('/api/library/programs'), api('/api/library/matrix'), api('/api/library/customers'), api('/api/transfers?limit=15'),
    ]);
    Object.assign(lib, { programs: programs.programs, matrix, customers: customers.customers, transfers: transfers.transfers });
  } catch (err) {
    toast(lib.host, `Liste yenilenemedi: ${err.message}`, false);
  }
  renderPending();
  renderTable();
  renderHistory();
  if (lib.selectedId != null) await selectProgram(lib.selectedId, true);
}

function renderNotices() {
  const c = lib.config;
  const parts = [];
  if (!c.transferEnabled) {
    parts.push('<p class="notice notice-sim"><b>Tezgaha gönderme kapalı</b> (sunucu <code>TRANSFER_DISABLED=1</code> ile başlatılmış). ' +
      'Kütüphane, tarama ve karşılaştırma çalışır.</p>');
  }
  parts.push('<p class="notice">Bu ekranda kimlik doğrulama <b>yok</b>; ofis ağındaki herkes programları görüp gönderebilir. ' +
    'Gönderirken tezgahın kimliğini yazarak onaylamanız istenir. Üzerine yazma yoktur: aynı adlı dosya varsa gönderilmez.</p>');
  if (c.machines.every((m) => !m.capable)) {
    parts.push('<p class="notice notice-sim">Dosya aktarımı yapabilen (IP\'si tanımlı, FTP destekli) tezgah yok. ' +
      'Ayarlar ekranından tezgahın IP\'sini girin.</p>');
  }
  lib.host.querySelector('[data-role="notices"]').innerHTML = parts.join('');
}

/* ---- yukleme ---- */

function addFiles(fileList) {
  for (const file of fileList) {
    lib.pending.push({
      id: ++lib.seq, file,
      name: file.name.replace(/\.(nc|txt|cnc|tap|ptp)$/i, ''),
      customer: lib.customer && lib.customer !== '__root' ? lib.customer : '',
      note: '', state: file.size > (lib.config?.maxProgramBytes ?? 1_000_000) ? 'hata' : 'bekliyor',
      msg: file.size > (lib.config?.maxProgramBytes ?? 1_000_000) ? 'Dosya çok büyük' : '',
    });
  }
  renderPending();
}

function renderPending() {
  const host = lib.host.querySelector('[data-role="pending"]');
  if (lib.pending.length === 0) { host.innerHTML = ''; return; }
  const options = lib.customers.map((c) => `<option value="${escapeHtml(c)}">`).join('');
  const waiting = lib.pending.filter((p) => p.state === 'bekliyor' || p.state === 'hata').length;
  host.innerHTML =
    `<datalist id="lib-customers">${options}</datalist>` +
    '<div class="table-wrap"><table class="tbl tbl-edit tbl-pending"><thead><tr><th>Dosya</th><th>Program adı</th><th>Müşteri klasörü</th><th>Not</th><th class="num">Boyut</th><th>Durum</th><th></th></tr></thead><tbody>' +
    lib.pending.map((p) => {
      const done = p.state === 'tamam';
      const stateCell = p.state === 'tamam' ? chip('guncel', p.msg || 'Eklendi')
        : p.state === 'hata' ? `<span class="chip chip-bad chip-wrap"><span aria-hidden="true">✕</span> ${escapeHtml(p.msg || 'Hata')}</span>`
        : p.state === 'yukleniyor' ? '<span class="chip chip-info">… yükleniyor</span>' : '<span class="chip chip-none">bekliyor</span>';
      return `<tr data-pid="${p.id}">` +
        `<td class="mono">${escapeHtml(p.file.name)}</td>` +
        `<td><input data-pid="${p.id}" data-key="name" value="${escapeHtml(p.name)}" class="mono" size="14" maxlength="40"${done ? ' disabled' : ''}></td>` +
        `<td><input data-pid="${p.id}" data-key="customer" value="${escapeHtml(p.customer)}" list="lib-customers" placeholder="boş = kök (ortak alan)" size="16"${done ? ' disabled' : ''}></td>` +
        `<td><input data-pid="${p.id}" data-key="note" value="${escapeHtml(p.note)}" size="16" maxlength="200"${done ? ' disabled' : ''}></td>` +
        `<td class="num">${escapeHtml(kb(p.file.size))}</td><td>${stateCell}</td>` +
        `<td><button type="button" class="icon-btn" data-act="remove-pending" data-pid="${p.id}" aria-label="${escapeHtml(p.file.name)} dosyasını listeden çıkar">Çıkar</button></td></tr>`;
    }).join('') + '</tbody></table></div>' +
    '<div class="dt-actions" style="margin-top:9px">' +
    `<button type="button" class="icon-btn btn-primary" data-act="upload"${waiting === 0 ? ' disabled' : ''}>Kütüphaneye ekle (${num(waiting)})</button>` +
    '<button type="button" class="icon-btn" data-act="clear-pending">Listeyi temizle</button></div>' +
    '<p class="hint">Müşteri klasörü, programın tezgahta duracağı klasördür (ör. müşteri adı). Boş bırakırsanız kök dizin (ortak alan) olur.</p>';
}

async function uploadPending() {
  const by = lib.host.querySelector('[data-role="user"]').value.trim();
  userName.set(by);
  for (const p of lib.pending.filter((x) => x.state === 'bekliyor' || x.state === 'hata')) {
    if (p.file.size > (lib.config?.maxProgramBytes ?? 1_000_000)) continue;
    p.state = 'yukleniyor';
    renderPending();
    try {
      const q = new URLSearchParams({ customer: p.customer.trim(), name: p.name.trim(), by, note: p.note.trim(), originalName: p.file.name });
      const res = await api(`/api/library/programs?${q}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: await p.file.arrayBuffer() });
      p.state = 'tamam';
      p.msg = res.created ? (res.newProgram ? `Eklendi (v${res.version.versionNo})` : `Yeni sürüm v${res.version.versionNo}`) : `Aynı içerik zaten var (v${res.version.versionNo})`;
    } catch (err) {
      p.state = 'hata';
      p.msg = err.message;
    }
    renderPending();
  }
  await reloadLists();
}

/* ---- liste + matris ---- */

function renderTable() {
  const machines = lib.matrix?.machines ?? [];
  const sel = lib.host.querySelector('[data-role="cust"]');
  const filterOptions = ['<option value="">Tüm müşteriler</option>', '<option value="__root">Kök (ortak alan)</option>']
    .concat([...new Set(lib.programs.map((p) => p.customer).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'tr'))
      .map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`));
  sel.innerHTML = filterOptions.join('');
  sel.value = lib.customer;

  const q = lib.query.trim().toLowerCase();
  const rows = lib.programs.filter((p) => {
    if (lib.customer === '__root' ? p.customer !== '' : lib.customer && p.customer !== lib.customer) return false;
    return q === '' || p.name.toLowerCase().includes(q) || p.customer.toLowerCase().includes(q);
  });

  const host = lib.host.querySelector('[data-role="table"]');
  if (lib.programs.length === 0) {
    host.innerHTML = '<p class="empty">Kütüphane boş. Yukarıdan bir program dosyası sürükleyip bırakın ya da bir tezgahtaki programları kütüphaneye alın.</p>';
  } else {
    const byId = new Map((lib.matrix?.rows ?? []).map((r) => [r.programId, r]));
    host.innerHTML =
      '<table class="tbl tbl-lib"><thead><tr><th>Müşteri</th><th>Program</th><th>Sürüm</th><th class="num">Boyut</th><th>Eklenme</th>' +
      machines.map((m) =>
        `<th class="mx-h" title="${escapeHtml(m.name)}"><span class="mono">${escapeHtml(m.id)}</span>` +
        `<small>${m.scannedAt ? `tarama ${escapeHtml(clock(m.scannedAt))}` : 'taranmadı'}</small>` +
        `<button type="button" class="icon-btn icon-btn-sm" data-act="scan" data-machine="${escapeHtml(m.id)}" aria-label="${escapeHtml(m.id)} tezgahını tara">⟳ tara</button></th>`).join('') +
      '</tr></thead><tbody>' +
      (rows.length === 0 ? `<tr><td colspan="${5 + machines.length}" class="empty">Aramaya uyan program yok.</td></tr>` :
        rows.map((p) => {
          const mx = byId.get(p.id);
          return `<tr data-program="${p.id}" class="is-click${p.id === lib.selectedId ? ' is-selected' : ''}" tabindex="0" aria-label="${escapeHtml(programLabel(p.customer, p.name))} ayrıntısı">` +
            `<td>${p.customer === '' ? '<span class="chip chip-none">kök</span>' : escapeHtml(p.customer)}</td>` +
            `<td class="mono"><b>${escapeHtml(p.name)}</b></td>` +
            `<td>v${p.latest.versionNo}${p.versionCount > 1 ? ` <small class="hint">(${p.versionCount} sürüm)</small>` : ''}</td>` +
            `<td class="num">${escapeHtml(kb(p.latest.size))}</td><td>${escapeHtml(dateTime(p.latest.createdAt))}</td>` +
            machines.map((m) => `<td>${cell(mx?.cells[m.id])}</td>`).join('') + '</tr>';
        }).join('')) +
      '</tbody></table>';
  }

  lib.host.querySelector('[data-role="legend"]').innerHTML = ['guncel', 'eski', 'farkli', 'belirsiz', 'tezgahta-yok', 'taranmadi']
    .map((k) => `<li>${chip(k)}</li>`).join('');
}

/* ---- program ayrintisi ---- */

async function selectProgram(id, quiet = false) {
  lib.selectedId = id;
  const host = lib.host.querySelector('[data-role="detail"]');
  for (const tr of lib.host.querySelectorAll('tr[data-program]')) tr.classList.toggle('is-selected', Number(tr.dataset.program) === id);
  if (id == null) { host.hidden = true; lib.detail = null; return; }
  if (!quiet) host.hidden = false;
  try {
    const data = await api(`/api/library/programs/${id}`);
    lib.detail = data;
    lib.previewNo = data.versions[0]?.versionNo ?? null;
    lib.preview = lib.previewNo ? await api(`/api/library/programs/${id}/versions/${lib.previewNo}`) : null;
    host.hidden = false;
    renderDetail();
  } catch (err) {
    host.hidden = false;
    host.innerHTML = `<p class="notice notice-sim">Program ayrıntısı alınamadı: ${escapeHtml(err.message)}</p>`;
  }
}

async function previewVersion(no) {
  lib.previewNo = no;
  lib.preview = await api(`/api/library/programs/${lib.selectedId}/versions/${no}`);
  renderDetail();
}

function renderDetail() {
  const host = lib.host.querySelector('[data-role="detail"]');
  const { program, versions } = lib.detail;
  const mx = (lib.matrix?.rows ?? []).find((r) => r.programId === program.id);
  const machines = lib.matrix?.machines ?? [];
  const pv = lib.preview;

  host.innerHTML =
    '<div class="dt-block-head">' +
    `<div><span class="eyebrow">${escapeHtml(folderLabel(program.customer))}</span><h3 class="mono">${escapeHtml(program.name)}</h3></div>` +
    '<div class="dt-actions">' +
    `<button type="button" class="icon-btn btn-primary" data-act="send" data-program="${program.id}">Tezgaha gönder…</button>` +
    '<button type="button" class="icon-btn" data-act="close-detail">Kapat</button></div></div>' +

    '<h4 class="sub">Sürümler</h4><div class="table-wrap"><table class="tbl"><thead><tr><th>Sürüm</th><th class="num">Boyut</th><th>SHA-256</th><th>Eklenme</th><th>Kaynak</th><th>Kim</th><th>Not</th><th></th></tr></thead><tbody>' +
    versions.map((v) =>
      `<tr${v.versionNo === lib.previewNo ? ' class="is-selected"' : ''}><td><b>v${v.versionNo}</b></td><td class="num">${escapeHtml(kb(v.size))}</td>` +
      `<td class="mono" title="${escapeHtml(v.sha256)}">${escapeHtml(v.sha256.slice(0, 12))}…</td><td>${escapeHtml(dateTime(v.createdAt))}</td>` +
      `<td>${v.source === 'tezgah-tarama' ? `tezgahtan alındı (${escapeHtml(v.sourceMachine ?? '')})` : 'yüklendi'}${v.originalName ? ` · <span class="mono">${escapeHtml(v.originalName)}</span>` : ''}</td>` +
      `<td>${escapeHtml(v.createdBy ?? '—')}</td><td>${escapeHtml(v.note ?? '')}</td>` +
      `<td class="nowrap"><button type="button" class="icon-btn icon-btn-sm" data-act="preview" data-no="${v.versionNo}">Önizle</button> ` +
      `<a class="icon-btn icon-btn-sm" href="/api/library/programs/${program.id}/versions/${v.versionNo}?download=1" download>İndir</a></td></tr>`).join('') +
    '</tbody></table></div>' +

    (machines.length === 0 ? '' :
      '<h4 class="sub">Tezgahlardaki durumu</h4><div class="mx-list">' +
      machines.map((m) => `<div class="mx-item"><span class="mono">${escapeHtml(m.id)}</span> ${cell(mx?.cells[m.id])}` +
        `<button type="button" class="icon-btn icon-btn-sm" data-act="send" data-program="${program.id}" data-machine="${escapeHtml(m.id)}">Gönder…</button></div>`).join('') + '</div>') +

    (pv ? `<h4 class="sub">Önizleme · v${pv.meta.versionNo}</h4>` +
      `<p class="hint">${num(pv.lines)} satır · satır sonu ${escapeHtml(pv.lineEnding)} · kodlama ${escapeHtml(pv.encoding)}` +
      `${pv.truncated ? ' · yalnızca ilk 20.000 karakter gösteriliyor' : ''}. İçerik değiştirilmeden saklanır.</p>` +
      `<pre class="code-view" tabindex="0" aria-label="Program içeriği">${escapeHtml(pv.text)}</pre>` : '');
}

/* ---- gecmis ---- */

function renderHistory() {
  const host = lib.host.querySelector('[data-role="history"]');
  if (lib.transfers.length === 0) { host.innerHTML = '<p class="empty">Henüz gönderme yapılmadı.</p>'; return; }
  host.innerHTML =
    '<table class="tbl"><thead><tr><th>Zaman</th><th>Tezgah</th><th>Program</th><th>Sonuç</th><th>Kim</th><th>Ayrıntı</th></tr></thead><tbody>' +
    lib.transfers.map((t) => {
      const s = TRANSFER_STATUS[t.status] ?? { icon: '·', label: t.status, cls: 'none' };
      return `<tr><td>${escapeHtml(dateTime(t.startedAt))}</td><td class="mono">${escapeHtml(t.machineId)}</td>` +
        `<td class="mono">${escapeHtml(programLabel(t.customer ?? '', t.name ?? ''))}</td>` +
        `<td><span class="chip chip-${s.cls}"><span aria-hidden="true">${s.icon}</span> ${escapeHtml(s.label)}</span></td>` +
        `<td>${escapeHtml(t.requestedBy ?? '—')}${t.clientIp ? ` <small class="hint">${escapeHtml(t.clientIp)}</small>` : ''}</td>` +
        `<td>${escapeHtml(t.error ?? '')}</td></tr>`;
    }).join('') + '</tbody></table>';
}

/* ---- olaylar ---- */

function wireLibrary() {
  const host = lib.host;
  const drop = host.querySelector('[data-role="drop"]');
  const fileInput = host.querySelector('[data-role="file"]');

  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); fileInput.click(); } });
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
  for (const name of ['dragenter', 'dragover']) drop.addEventListener(name, (ev) => { ev.preventDefault(); drop.classList.add('is-over'); });
  for (const name of ['dragleave', 'drop']) drop.addEventListener(name, (ev) => { ev.preventDefault(); drop.classList.remove('is-over'); });
  drop.addEventListener('drop', (ev) => addFiles(ev.dataTransfer.files));

  host.querySelector('[data-role="user"]').addEventListener('input', (ev) => userName.set(ev.target.value.trim()));
  host.querySelector('[data-role="q"]').addEventListener('input', (ev) => { lib.query = ev.target.value; renderTable(); });
  host.querySelector('[data-role="cust"]').addEventListener('change', (ev) => { lib.customer = ev.target.value; renderTable(); });

  // Asagidakiler `host` uzerine baglanir ve ekran her kuruldugunda (icerik yeniden
  // yazilsa da) host ayni kalir: BIR KEZ baglanmali, yoksa tiklama birden cok islenir.
  if (host.dataset.wired === '1') return;
  host.dataset.wired = '1';

  host.addEventListener('input', (ev) => {
    const t = ev.target;
    if (!t.dataset?.pid || !t.dataset.key) return;
    const p = lib.pending.find((x) => x.id === Number(t.dataset.pid));
    if (!p) return;
    p[t.dataset.key] = t.value;
    if (p.state === 'hata') { p.state = 'bekliyor'; p.msg = ''; }
  });

  host.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-act]');
    const row = ev.target.closest('tr[data-program]');
    if (!btn && row && !ev.target.closest('a,button')) { location.hash = `#/programlar/${row.dataset.program}`; return; }
    if (!btn) return;
    const act = btn.dataset.act;
    try {
      if (act === 'remove-pending') { lib.pending = lib.pending.filter((p) => p.id !== Number(btn.dataset.pid)); renderPending(); }
      else if (act === 'clear-pending') { lib.pending = []; renderPending(); }
      else if (act === 'upload') { btn.disabled = true; await uploadPending(); }
      else if (act === 'refresh-history') { lib.transfers = (await api('/api/transfers?limit=15')).transfers; renderHistory(); }
      else if (act === 'close-detail') { location.hash = '#/programlar'; }
      else if (act === 'preview') { await previewVersion(Number(btn.dataset.no)); }
      else if (act === 'send') { openSendDialog({ programId: Number(btn.dataset.program), machineId: btn.dataset.machine ?? null }); }
      else if (act === 'scan') {
        const id = btn.dataset.machine;
        btn.disabled = true;
        btn.textContent = '⟳ taranıyor…';
        toast(host, `${id} taranıyor… (tornaya FTP ile bağlanılıyor, birkaç saniye sürer)`);
        try {
          const r = await post(`/api/machines/${encodeURIComponent(id)}/programs/scan`);
          toast(host, `${id}: ${num(r.entries)} program, ${num(r.folders)} klasör tarandı (${num(r.durationMs / 1000, 1)} sn)` +
            `${r.warnings.length ? ` · ${r.warnings.length} uyarı: ${r.warnings.slice(0, 2).join('; ')}` : ''}.`);
        } catch (err) {
          toast(host, `${id} taranamadı: ${err.message}`, false);
        }
        await reloadLists();
        announce();
      }
    } catch (err) {
      toast(host, err.message, false);
    }
  });

  host.addEventListener('keydown', (ev) => {
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('tr[data-program]')) {
      ev.preventDefault();
      location.hash = `#/programlar/${ev.target.dataset.program}`;
    }
  });
}

/* ================================================== TEZGAH DETAYI: PROGRAMLAR PANELI */

/**
 * @param {HTMLElement} host `[data-role="programs"]` bolumu
 * @param {{machineId: string, name?: string}} machine
 */
export function renderMachinePrograms(host, machine) {
  const st = { id: machine.machineId, data: null, cfg: null, filter: '', busy: false };
  host.innerHTML =
    '<div class="dt-block-head"><h3>Programlar</h3><div class="dt-actions" data-role="actions"></div></div>' +
    '<p data-role="msg" class="notice" hidden></p><div data-role="body"><p class="empty">Yükleniyor…</p></div>';

  const body = () => host.querySelector('[data-role="body"]');
  const mInfo = () => st.cfg?.machines.find((m) => m.id === st.id);

  async function load() {
    try {
      const [cfg, data] = await Promise.all([api('/api/library/config'), api(`/api/machines/${encodeURIComponent(st.id)}/programs`)]);
      st.cfg = cfg;
      st.data = data;
    } catch (err) {
      body().innerHTML = `<p class="notice notice-sim">Programlar alınamadı: ${escapeHtml(err.message)}</p>`;
      return;
    }
    render();
  }

  /** Göndermeyi engelleyen neden (özellik kapalı / bu kontrolcü modelinde doğrulanmadı) ya da null. */
  function sendBlocked() {
    if (!st.cfg.transferEnabled) return 'Gönderme kapalı (TRANSFER_DISABLED=1)';
    const info = mInfo();
    return info?.sendAllowed === false ? (info.sendBlockedReason ?? 'Bu kontrolcü modelinde gönderme kapalı') : null;
  }

  function render() {
    const info = mInfo();
    const actions = host.querySelector('[data-role="actions"]');
    if (!info?.capable) {
      actions.innerHTML = '';
      body().innerHTML = `<p class="notice">Bu tezgahta program aktarımı kullanılamıyor: ${escapeHtml(info?.reason ?? 'bilinmiyor')}</p>`;
      return;
    }
    const blocked = sendBlocked();
    actions.innerHTML =
      '<button type="button" class="icon-btn" data-act="scan">Tezgahtaki programları tara</button>' +
      `<button type="button" class="icon-btn btn-primary" data-act="send"${blocked ? ` disabled title="${escapeHtml(blocked)}"` : ''}>Program gönder…</button>` +
      // Özellik genelde açık ama bu kontrolcü modelinde doğrulanmamışsa nedeni göster (üzerine gelmeden de görünsün).
      (blocked && st.cfg.transferEnabled
        ? `<span class="hint" style="margin:0" title="${escapeHtml(blocked)}">${escapeHtml(info.controllerModel ?? '')} modelinde gönderme, gerçek tezgahta doğrulanana kadar kapalı</span>`
        : '');

    const d = st.data;
    if (!d.scan || d.scan.entries == null) {
      body().innerHTML = '<p class="empty">Bu tezgah henüz taranmadı. "Tezgahtaki programları tara" ile tornadaki klasörler ve programlar listelenir ' +
        '(yalnızca okuma; tornaya hiçbir şey yazılmaz).</p>';
      return;
    }
    const counts = d.counts ?? {};
    const summary = ['guncel', 'eski', 'farkli', 'belirsiz', 'kutuphanede-yok']
      .filter((k) => counts[k]).map((k) => chip(k, `${num(counts[k])} ${STATUS[k].label.toLowerCase()}`)).join(' ');
    const stale = d.scan.status === 'hata' ? `<p class="notice notice-sim">Son tarama başarısız (${escapeHtml(d.scan.error ?? '')}); aşağıdaki liste eski taramadan.</p>` : '';

    const groups = new Map();
    for (const e of d.entries) {
      if (e.system) continue;
      if (st.filter && e.status !== st.filter) continue;
      if (!groups.has(e.customer)) groups.set(e.customer, []);
      groups.get(e.customer).push(e);
    }
    for (const f of d.folders ?? []) if (!st.filter && !groups.has(f)) groups.set(f, []);
    const names = [...groups.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b, 'tr')));

    body().innerHTML = stale +
      `<p class="hint">Son tarama: ${escapeHtml(dateTime(d.scan.finishedAt))} · ${num(d.scan.entries)} program · ${num((d.folders ?? []).length)} klasör</p>` +
      `<div class="mx-list">${summary || '<span class="hint">Karşılaştırılacak program yok.</span>'}` +
      `<label class="fld-inline">Göster <select data-role="filter" class="fld-sm"><option value="">Tümü</option>` +
      ['farkli', 'eski', 'belirsiz', 'kutuphanede-yok', 'guncel'].map((k) => `<option value="${k}"${st.filter === k ? ' selected' : ''}>${escapeHtml(STATUS[k].label)}</option>`).join('') +
      '</select></label></div>' +
      (names.length === 0 ? '<p class="empty">Bu filtreye uyan program yok.</p>' :
        names.map((c) => {
          const list = groups.get(c);
          const bad = list.filter((e) => e.status === 'farkli').length;
          const old = list.filter((e) => e.status === 'eski').length;
          const noLib = list.filter((e) => e.status === 'kutuphanede-yok').length;
          return `<details class="grp" data-customer="${escapeHtml(c)}"><summary><b>${escapeHtml(folderLabel(c))}</b> · ${num(list.length)} program` +
            `${bad ? ` ${chip('farkli', `${bad} farklı`)}` : ''}${old ? ` ${chip('eski', `${old} eski`)}` : ''}${noLib ? ` ${chip('kutuphanede-yok', `${noLib} kütüphanede yok`)}` : ''}` +
            `</summary><div class="grp-body"></div></details>`;
        }).join('')) +
      ((d.missing ?? []).length === 0 ? '' :
        `<details class="grp" data-missing="1"><summary><b>Kütüphanede var, bu tezgahta yok</b> · ${num(d.missing.length)} program</summary><div class="grp-body"></div></details>`);
  }

  function fillGroup(details) {
    const body_ = details.querySelector('.grp-body');
    if (body_.dataset.filled) return;
    body_.dataset.filled = '1';
    const d = st.data;
    if (details.dataset.missing) {
      body_.innerHTML = '<table class="tbl"><thead><tr><th>Müşteri</th><th>Program</th><th>Sürüm</th><th class="num">Boyut</th><th></th></tr></thead><tbody>' +
        d.missing.map((m) => `<tr><td>${escapeHtml(folderLabel(m.customer))}</td><td class="mono"><b>${escapeHtml(m.name)}</b></td><td>v${m.latestVersion}</td>` +
          `<td class="num">${escapeHtml(kb(m.size))}</td><td><button type="button" class="icon-btn icon-btn-sm" data-act="send" data-program="${m.programId}"${sendBlocked() ? ` disabled title="${escapeHtml(sendBlocked())}"` : ''}>Gönder…</button></td></tr>`).join('') +
        '</tbody></table>';
      return;
    }
    const customer = details.dataset.customer;
    const list = d.entries.filter((e) => !e.system && e.customer === customer && (!st.filter || e.status === st.filter));
    body_.innerHTML = list.length === 0 ? '<p class="empty">Bu klasörde program yok.</p>' :
      '<table class="tbl"><thead><tr><th>Program</th><th class="num">Boyut</th><th>Tezgah tarihi</th><th>Durum</th><th></th></tr></thead><tbody>' +
      list.map((e) => `<tr><td class="mono"><b>${escapeHtml(e.name)}</b></td><td class="num">${escapeHtml(kb(e.size))}</td><td>${escapeHtml(e.modified ?? '—')}</td>` +
        `<td>${cell(e)}</td><td>${e.status === 'kutuphanede-yok'
          ? `<button type="button" class="icon-btn icon-btn-sm" data-act="import" data-customer="${escapeHtml(e.customer)}" data-name="${escapeHtml(e.name)}">Kütüphaneye al</button>` : ''}</td></tr>`).join('') +
      '</tbody></table>';
  }

  host.addEventListener('toggle', (ev) => { if (ev.target.matches?.('details.grp') && ev.target.open) fillGroup(ev.target); }, true);
  host.addEventListener('change', (ev) => { if (ev.target.matches('[data-role="filter"]')) { st.filter = ev.target.value; render(); } });
  host.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn || st.busy) return;
    const act = btn.dataset.act;
    if (act === 'send') { openSendDialog({ machineId: st.id, programId: btn.dataset.program ? Number(btn.dataset.program) : null }); return; }
    st.busy = true;
    btn.disabled = true;
    try {
      if (act === 'scan') {
        btn.textContent = 'Taranıyor…';
        toast(host, `Tornaya FTP ile bağlanılıp klasörler listeleniyor (yalnızca okuma)… birkaç saniye sürer.`);
        const r = await post(`/api/machines/${encodeURIComponent(st.id)}/programs/scan`);
        toast(host, `Tarama bitti: ${num(r.entries)} program, ${num(r.folders)} klasör (${num(r.durationMs / 1000, 1)} sn)` +
          `${r.hashed ? ` · ${num(r.hashed)} dosya içerik karşılaştırması için okundu` : ''}` +
          `${r.warnings.length ? ` · ${r.warnings.length} uyarı: ${r.warnings.slice(0, 3).join('; ')}` : ''}.`);
        announce();
      } else if (act === 'import') {
        const res = await post(`/api/machines/${encodeURIComponent(st.id)}/programs/import`, { customer: btn.dataset.customer, name: btn.dataset.name, by: userName.get() });
        toast(host, `${programLabel(btn.dataset.customer, btn.dataset.name)} kütüphaneye alındı (v${res.version.versionNo}).`);
        announce();
      }
    } catch (err) {
      toast(host, `${act === 'scan' ? 'Tarama' : 'İşlem'} başarısız: ${err.message}`, false);
    } finally {
      st.busy = false;
    }
    await load();
  });

  const onChanged = () => { if (!host.isConnected) { document.removeEventListener(CHANGED, onChanged); return; } if (!st.busy) load(); };
  document.addEventListener(CHANGED, onChanged);
  load();
}

/* ============================================================ GONDERME PENCERESI */

let dlg = null;
const sd = {
  machineId: null, programId: null, versionNo: null, customer: '', capable: [], programs: [], folders: [], scanned: false,
  pre: null, acks: new Set(), confirm: '', by: '', phase: 'form', busy: false, error: null, result: null,
};

function ensureDialog() {
  if (dlg) return dlg;
  dlg = document.createElement('dialog');
  dlg.className = 'modal';
  dlg.setAttribute('aria-labelledby', 'send-title');
  document.body.append(dlg);
  dlg.addEventListener('cancel', (ev) => { if (sd.busy) ev.preventDefault(); });
  dlg.addEventListener('click', (ev) => { if (ev.target === dlg && !sd.busy) dlg.close(); });
  wireDialog();
  return dlg;
}

/** Hedef klasor secenekleri: secili tezgahin taramadan bilinen klasorleri. */
async function loadFolders() {
  sd.folders = [];
  sd.scanned = false;
  if (!sd.machineId) return;
  try {
    const d = await api(`/api/machines/${encodeURIComponent(sd.machineId)}/programs`);
    sd.folders = d.folders ?? [];
    sd.scanned = !!d.scan && d.scan.entries != null;
  } catch { /* bos kalir */ }
}

export async function openSendDialog({ machineId = null, programId = null } = {}) {
  ensureDialog();
  Object.assign(sd, { pre: null, acks: new Set(), confirm: '', phase: 'form', busy: false, error: null, result: null, by: userName.get() });
  try {
    const [cfg, progs] = await Promise.all([api('/api/library/config'), api('/api/library/programs')]);
    sd.capable = cfg.machines.filter((m) => m.capable);
    sd.programs = progs.programs;
    sd.transferEnabled = cfg.transferEnabled;
  } catch (err) {
    sd.error = err.message;
  }
  sd.machineId = machineId && sd.capable.some((m) => m.id === machineId) ? machineId : (sd.capable[0]?.id ?? null);
  sd.programId = programId;
  const p = sd.programs.find((x) => x.id === programId);
  sd.versionNo = p ? p.latest.versionNo : null;
  sd.customer = p ? p.customer : '';
  await loadFolders();
  renderDialog();
  if (!dlg.open) dlg.showModal();
}

function currentProgram() { return sd.programs.find((p) => p.id === sd.programId) ?? null; }

/**
 * Gonderilebilir mi (istemci tarafi): engel yok ve istenen tum sari uyarilar onaylandi.
 * Sunucu bunu yine kendisi denetler; burasi yalnizca dugmeyi acip kapatir.
 */
function sendable() {
  const p = sd.pre;
  return !!p && !p.checks.some((c) => c.level === 'block') && p.needsAck.every((a) => sd.acks.has(a));
}

function renderDialog() {
  const p = currentProgram();
  const machine = sd.capable.find((m) => m.id === sd.machineId);
  const done = sd.phase === 'done';
  const checksHtml = sd.pre ? checksBlock() : '';
  const canGo = sendable() && sd.confirm === sd.machineId && sd.by.trim() !== '' && !sd.busy;

  dlg.innerHTML =
    '<div class="modal-inner">' +
    '<header class="modal-head"><div><span class="eyebrow">Tezgaha aktarım</span><h3 id="send-title">Programı tezgaha gönder</h3></div>' +
    `<button type="button" class="icon-btn" data-act="close"${sd.busy ? ' disabled' : ''}>Kapat</button></header>` +
    '<div class="modal-body">' +
    '<p class="notice">Program tezgaha <b>kopyalanır</b>; çalıştırmak için tezgah panelinden seçilmesi gerekir. ' +
    'Mevcut bir dosyanın <b>üzerine yazılmaz</b>. Dosya önce geçici adla yüklenir, doğrulanır, sonra asıl adına çevrilir.</p>' +
    (sd.error ? `<p class="notice notice-sim">${escapeHtml(sd.error)}</p>` : '') +
    (sd.transferEnabled === false ? '<p class="notice notice-sim"><b>Gönderme kapalı</b> (TRANSFER_DISABLED=1).</p>' : '') +

    (done ? resultBlock() :
      '<div class="fld-grid">' +
      `<label class="fld"><span>Hedef tezgah</span><select data-key="machineId"${sd.busy ? ' disabled' : ''}>` +
      (sd.capable.length === 0 ? '<option value="">(aktarım yapabilen tezgah yok)</option>' :
        sd.capable.map((m) => `<option value="${escapeHtml(m.id)}"${m.id === sd.machineId ? ' selected' : ''}>${escapeHtml(m.id)} · ${escapeHtml(m.name)}</option>`).join('')) +
      '</select></label>' +

      '<label class="fld"><span>Program (kütüphaneden)</span>' +
      `<input data-key="program" list="send-programs" placeholder="Müşteri\\Ad yazın ya da seçin" value="${escapeHtml(p ? programLabel(p.customer, p.name) : '')}"${sd.busy ? ' disabled' : ''}>` +
      `<datalist id="send-programs">${sd.programs.map((x) => `<option value="${escapeHtml(programLabel(x.customer, x.name))}">`).join('')}</datalist></label>` +

      '<label class="fld"><span>Sürüm</span>' +
      `<select data-key="versionNo"${!p || sd.busy ? ' disabled' : ''}>${p ? Array.from({ length: p.latest.versionNo }, (_, i) => p.latest.versionNo - i)
        .map((n) => `<option value="${n}"${n === sd.versionNo ? ' selected' : ''}>v${n}${n === p.latest.versionNo ? ' (son)' : ''}</option>`).join('') : ''}</select></label>` +

      '<label class="fld"><span>Hedef klasör (müşteri)</span>' +
      (sd.scanned || sd.folders.length > 0
        ? `<select data-key="customer"${sd.busy ? ' disabled' : ''}><option value=""${sd.customer === '' ? ' selected' : ''}>Kök (ortak alan)</option>` +
          sd.folders.map((f) => `<option value="${escapeHtml(f)}"${f.toLowerCase() === sd.customer.toLowerCase() ? ' selected' : ''}>${escapeHtml(f)}</option>`).join('') + '</select>'
        : '<span class="hint">Bu tezgah henüz taranmadı: hedef klasörler bilinmiyor. ' +
          '<button type="button" class="icon-btn icon-btn-sm" data-act="scan-here">Tezgahı tara</button></span>') +
      '</label></div>' +

      `<div class="dt-actions"><button type="button" class="icon-btn" data-act="precheck"${!sd.machineId || !p || sd.busy || (!sd.scanned && sd.folders.length === 0) ? ' disabled' : ''}>` +
      `${sd.busy && sd.phase === 'checking' ? 'Kontrol ediliyor…' : 'Ön kontrol yap'}</button></div>` +
      checksHtml +
      (sd.pre ? confirmBlock(machine, canGo) : '')) +
    '</div></div>';
}

function checksBlock() {
  const pre = sd.pre;
  return '<h4 class="sub">Ön kontrol sonucu</h4><ul class="checks">' +
    pre.checks.map((c) => `<li class="check check-${c.level}"><span class="check-ic" aria-hidden="true">${CHECK_ICON[c.level] ?? '·'}</span>` +
      `<div><b>${escapeHtml(c.title)}</b>${c.detail ? `<p>${escapeHtml(c.detail)}</p>` : ''}` +
      `${c.level === 'warn' && c.ack ? `<label class="chk"><input type="checkbox" data-ack="${escapeHtml(c.ack)}"${sd.acks.has(c.ack) ? ' checked' : ''}${sd.busy ? ' disabled' : ''}> Anladım, yine de göndermek istiyorum</label>` : ''}</div></li>`).join('') +
    '</ul>' +
    `<p class="hint">Gönderilecek: <b class="mono">${escapeHtml(programLabel(sd.pre.folder ?? sd.pre.customer, sd.pre.name))}</b> · v${sd.pre.versionNo} · ${escapeHtml(kb(sd.pre.size))} · SHA-256 <span class="mono">${escapeHtml(sd.pre.sha256.slice(0, 16))}…</span></p>`;
}

function confirmBlock(machine, canGo) {
  const blocked = sd.pre.checks.some((c) => c.level === 'block');
  if (blocked) return '<p class="notice notice-sim"><b>Gönderilemez.</b> Yukarıdaki ✕ ile işaretli engeli giderip ön kontrolü yeniden yapın.</p>';
  return '<div class="confirm-box">' +
    '<label class="fld"><span>Adınız (kayıt için, zorunlu)</span>' +
    `<input data-key="by" value="${escapeHtml(sd.by)}" maxlength="40" placeholder="ör. Ayşe"${sd.busy ? ' disabled' : ''}></label>` +
    `<label class="fld"><span>Onaylamak için tezgahın kimliğini yazın: <b class="mono">${escapeHtml(sd.machineId ?? '')}</b></span>` +
    `<input data-key="confirm" value="${escapeHtml(sd.confirm)}" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(sd.machineId ?? '')}" class="mono"${sd.busy ? ' disabled' : ''}></label>` +
    `<div class="dt-actions"><button type="button" class="icon-btn btn-primary" data-act="send-now"${canGo ? '' : ' disabled'}>` +
    `${sd.busy && sd.phase === 'sending' ? 'Gönderiliyor…' : `${escapeHtml(machine?.name ?? sd.machineId)} tezgahına gönder`}</button></div>` +
    (sd.pre.needsAck.length > 0 && !sd.pre.needsAck.every((a) => sd.acks.has(a)) ? '<p class="hint">Sarı (▲) uyarıları onaylamadan gönderilemez.</p>' : '') +
    '</div>';
}

function resultBlock() {
  const t = sd.result;
  const s = TRANSFER_STATUS[t.status] ?? { icon: '·', label: t.status, cls: 'none' };
  const headline = {
    basarili: 'Program tezgaha kopyalandı ve doğrulandı.',
    reddedildi: 'Gönderilmedi: ön kontrol engeline takıldı. Tezgaha hiçbir şey yazılmadı.',
    basarisiz: 'Gönderme başarısız oldu. Yarım kalan geçici dosya temizlenmeye çalışıldı.',
    dogrulanamadi: 'Dosya yerine kondu ama son doğrulama yapılamadı: tezgahta elle kontrol edin.',
  }[t.status] ?? t.status;
  return `<div class="result result-${s.cls}"><span class="result-ic" aria-hidden="true">${s.icon}</span><div><b>${escapeHtml(headline)}</b>` +
    `${t.error ? `<p>${escapeHtml(t.error)}</p>` : ''}` +
    `${t.status === 'basarili' ? '<p>Çalıştırmak için tezgah panelinden programı seçin. Program kendiliğinden aktif olmaz.</p>' : ''}</div></div>` +
    '<h4 class="sub">Adımlar</h4><table class="tbl"><thead><tr><th>Adım</th><th>Sonuç</th><th class="num">Süre</th><th>Ayrıntı</th></tr></thead><tbody>' +
    t.steps.map((x) => `<tr><td>${escapeHtml(STEP_LABEL[x.step] ?? x.step)}</td><td>${x.ok ? chip('guncel', 'tamam') : chip('farkli', 'hata')}</td>` +
      `<td class="num">${num(x.ms)} ms</td><td class="mono">${escapeHtml(x.detail ?? '')}</td></tr>`).join('') + '</tbody></table>' +
    `<p class="hint">Kayıt no ${t.id} · ${escapeHtml(t.requestedBy ?? '')} · SHA-256 ${escapeHtml((t.shaSent ?? '').slice(0, 16))}…</p>` +
    '<div class="dt-actions"><button type="button" class="icon-btn" data-act="again">Başka bir program gönder</button>' +
    '<button type="button" class="icon-btn btn-primary" data-act="close">Kapat</button></div>';
}

function resetPre() { sd.pre = null; sd.acks = new Set(); sd.confirm = ''; }

function wireDialog() {
  dlg.addEventListener('change', async (ev) => {
    const t = ev.target;
    if (t.dataset?.ack) {
      if (t.checked) sd.acks.add(t.dataset.ack); else sd.acks.delete(t.dataset.ack);
      renderDialog();
      return;
    }
    const key = t.dataset?.key;
    if (!key) return;
    // Metin alanlarindan cikarken yeniden cizme: tiklanan dugme yutulmasin.
    if (key === 'confirm' || key === 'by') return;
    if (key === 'machineId') { sd.machineId = t.value; resetPre(); sd.customer = currentProgram()?.customer ?? ''; await loadFolders(); }
    else if (key === 'versionNo') { sd.versionNo = Number(t.value); resetPre(); }
    else if (key === 'customer') { sd.customer = t.value; resetPre(); }
    else if (key === 'program') {
      const p = sd.programs.find((x) => programLabel(x.customer, x.name).toLowerCase() === t.value.trim().toLowerCase());
      sd.programId = p?.id ?? null;
      sd.versionNo = p ? p.latest.versionNo : null;
      sd.customer = p ? p.customer : sd.customer;
      resetPre();
    }
    renderDialog();
  });

  // Yazarken yeniden cizmeyiz (odak kaybolur): yalnizca durumu guncelle ve dugmeyi ac/kapat.
  dlg.addEventListener('input', (ev) => {
    const key = ev.target.dataset?.key;
    if (key !== 'confirm' && key !== 'by') return;
    sd[key] = ev.target.value;
    if (key === 'by') userName.set(sd.by.trim());
    const go = dlg.querySelector('[data-act="send-now"]');
    if (go) go.disabled = !(sendable() && sd.confirm === sd.machineId && sd.by.trim() !== '' && !sd.busy);
  });

  dlg.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'close') { if (!sd.busy) dlg.close(); return; }
    if (act === 'again') { sd.phase = 'form'; sd.result = null; resetPre(); renderDialog(); return; }
    if (act === 'scan-here') {
      btn.disabled = true;
      btn.textContent = 'Taranıyor…';
      try { await post(`/api/machines/${encodeURIComponent(sd.machineId)}/programs/scan`); announce(); } catch (err) { sd.error = `Tarama başarısız: ${err.message}`; }
      await loadFolders();
      renderDialog();
      return;
    }
    if (act === 'precheck') {
      sd.busy = true; sd.phase = 'checking'; sd.error = null; resetPre();
      renderDialog();
      try {
        sd.pre = await post('/api/transfers/precheck', { machineId: sd.machineId, programId: sd.programId, versionNo: sd.versionNo, customer: sd.customer, acks: [] });
      } catch (err) {
        sd.error = `Ön kontrol yapılamadı: ${err.message}`;
      }
      sd.busy = false; sd.phase = 'form';
      renderDialog();
      return;
    }
    if (act === 'send-now') {
      sd.busy = true; sd.phase = 'sending'; sd.error = null;
      renderDialog();
      try {
        sd.result = await post('/api/transfers', {
          machineId: sd.machineId, programId: sd.programId, versionNo: sd.versionNo, customer: sd.customer,
          confirm: sd.confirm, by: sd.by.trim(), acks: [...sd.acks],
        });
        sd.phase = 'done';
        announce();
      } catch (err) {
        sd.error = `Gönderme isteği başarısız: ${err.message}`;
        sd.phase = 'form';
      }
      sd.busy = false;
      renderDialog();
    }
  });
}
