/**
 * Planlama > Paketleme > Liste (EYS.LS.005 "Paketleme Listesi"): her ürünün koli boyutu, kasa özelliği, kat
 * sayısı, koli/kasa içi adet, koli etiketi, koli ağırlığı referans kaydı. Paketleme formu ürün seçilince bu
 * kayıttan okur (`packing.js#suggest()`'in `packingSpec` alanı); bir ürünün hiç kaydı yoksa paketleme formunun
 * satır ekleme ekranında doğrudan girilip buraya öğrenilir (bkz. `planning-packing-form.js`).
 *
 * Ayrı bir ekran DEĞİL — "Paketleme formu"/"Kasalar" gibi Paketleme ekranının üçüncü görünümü, aynı `paketleme`
 * yetkisini paylaşır (`planning-packing.js`'teki sekme geçişiyle açılır).
 */
import { escapeHtml } from './format.js';
import { api } from './lib-common.js';
import { put, cellText, fmtNum, openModal, canWrite, isAdminRole, debounce, truncCell } from './planning-common.js';

const PAGE = 100;
const KASA_OPTIONS = ['STANDART'];
const ETIKET_OPTIONS = ['STANDART', 'QR', 'İNGİLİZCE/LOGOSUZ'];

/** @param {HTMLElement} host */
export function renderPackingSpecs(host) {
  const canEdit = canWrite('paketleme');
  const st = { q: '', items: [], total: 0, seq: 0 };
  host.innerHTML =
    '<p class="hint">Her ürünün nasıl paketlendiğini sabitleyen kayıt (EYS.LS.005): koli boyutu, kasa özelliği, kat sayısı, koli/kasa içi adet, ' +
    'koli etiketi, koli ağırlığı. Paketleme formunda ürün seçilince buradan okunur; hiç kaydı olmayan bir ürün ilk paketlendiğinde girilen değerler buraya öğrenilir.</p>' +
    '<div class="pl-bar"><input type="search" class="pl-search" data-role="q" placeholder="Stok kodu, ürün adı ya da müşteri kodu ara…" aria-label="Ürün ara">' +
    (isAdminRole() ? '<button type="button" class="icon-btn" data-act="import">Excel\'den içeri aktar…</button>' : '') + '</div>' +
    '<p class="hint" data-role="count"></p>' +
    '<div class="table-wrap table-wrap-tall" data-role="list"></div>' +
    '<p class="pl-more" data-role="more" hidden><button type="button" class="icon-btn" data-act="more">Daha fazla göster</button></p>';
  const $ = (r) => host.querySelector(`[data-role="${r}"]`);

  function draw() {
    $('count').textContent = st.total === 0
      ? (st.q ? 'Eşleşen ürün yok.' : 'Henüz ürün kartı yok.')
      : `${fmtNum(st.total)} ürün${st.items.length < st.total ? ` (ilk ${fmtNum(st.items.length)} gösteriliyor)` : ''}`;
    $('list').innerHTML = st.items.length === 0 ? '' :
      '<table class="tbl tbl-pl"><thead><tr><th>Alen kodu</th><th>Müşteri kodu</th><th>Ürün adı</th><th>Müşteri</th>' +
      '<th>Koli boyutu</th><th>Kasa özelliği</th><th>Kat sayısı</th><th class="num">Koli içi adet</th><th>Koli etiketi</th><th class="num">Koli ağırlığı (kg)</th><th></th></tr></thead><tbody>' +
      st.items.map((p) =>
        `<tr class="pl-row" data-code="${escapeHtml(p.stockCode)}" tabindex="0">` +
        `<td class="mono"><b>${escapeHtml(p.stockCode)}</b></td><td class="mono">${cellText(p.customerCode)}</td>` +
        `<td class="trunc"${truncCell(p.name)}>${cellText(p.name)}</td><td class="trunc"${truncCell(p.musteri)}>${cellText(p.musteri)}</td>` +
        `<td>${cellText(p.koliBoyutu)}</td><td>${cellText(p.kasaOzelligi)}</td><td>${cellText(p.katSayisi)}</td>` +
        `<td class="num">${p.koliIciAdet == null ? cellText(null) : fmtNum(p.koliIciAdet)}</td><td>${cellText(p.koliEtiketi)}</td>` +
        `<td class="num">${p.koliAgirligiKg == null ? cellText(null) : fmtNum(p.koliAgirligiKg, 2)}</td>` +
        `<td>${canEdit ? `<button type="button" class="icon-btn icon-btn-sm" data-act="edit" data-code="${escapeHtml(p.stockCode)}">Düzenle</button>` : ''}</td></tr>`).join('') +
      '</tbody></table>';
    $('more').hidden = st.items.length >= st.total;
  }

  async function load(reset) {
    const seq = ++st.seq;
    const offset = reset ? 0 : st.items.length;
    try {
      const r = await api(`/api/planning/packing/specs?${new URLSearchParams({ q: st.q, limit: PAGE, offset })}`);
      if (seq !== st.seq) return;
      st.total = r.total;
      st.items = reset ? r.items : [...st.items, ...r.items];
      draw();
    } catch (err) {
      if (seq === st.seq) $('count').textContent = `Ürünler alınamadı: ${err.message}`;
    }
  }

  const search = debounce((value) => { st.q = value.trim(); load(true); }, 250);
  host.oninput = (ev) => { if (ev.target.dataset?.role === 'q') search(ev.target.value); };
  host.onclick = (ev) => {
    if (ev.target.closest('[data-act="import"]')) { openImportDialog(() => load(true)); return; }
    if (ev.target.closest('[data-act="more"]')) { load(false); return; }
    const editBtn = ev.target.closest('[data-act="edit"]');
    if (editBtn) { openSpecDialog(st.items.find((x) => x.stockCode === editBtn.dataset.code), () => load(true)); return; }
    const row = ev.target.closest('.pl-row');
    if (row && canEdit) openSpecDialog(st.items.find((x) => x.stockCode === row.dataset.code), () => load(true));
  };
  load(true);
}

/* ============================================================================================== duzenle */

/** Paketleme listesi alanlarını düzenleme penceresi (EYS.LS.005); satır listede zaten yüklü, yeniden sorgulanmaz. @param {object} p @param {() => void} [onDone] */
function openSpecDialog(p, onDone = () => {}) {
  const m = openModal({ title: `Paketleme listesi · ${p.stockCode}` });
  let error = null;

  function draw() {
    m.body.innerHTML =
      `<p class="pl-wohead"><b>${escapeHtml(p.stockCode)}</b> · ${escapeHtml(p.name ?? '')}</p>` +
      '<form autocomplete="off"><div class="fld-grid">' +
      `<label class="fld"><span>Müşteri</span><input name="musteri" value="${escapeHtml(p.musteri ?? '')}" maxlength="120" autocomplete="off"></label>` +
      `<label class="fld"><span>Koli boyutu</span><input name="koliBoyutu" value="${escapeHtml(p.koliBoyutu ?? '')}" maxlength="60" placeholder="ör. 25 X 25 X 17" autocomplete="off"></label>` +
      `<label class="fld"><span>Kasa özelliği</span><input name="kasaOzelligi" value="${escapeHtml(p.kasaOzelligi ?? '')}" maxlength="60" list="pk-kasa-list" autocomplete="off"></label>` +
      `<label class="fld"><span>Kat sayısı</span><input name="katSayisi" value="${escapeHtml(p.katSayisi ?? '')}" maxlength="40" placeholder="ör. 7 X 273" autocomplete="off"></label>` +
      `<label class="fld"><span>Koli içi adet</span><input name="koliIciAdet" value="${p.koliIciAdet ?? ''}" inputmode="numeric" autocomplete="off"></label>` +
      `<label class="fld"><span>Koli etiketi</span><input name="koliEtiketi" value="${escapeHtml(p.koliEtiketi ?? '')}" maxlength="60" list="pk-etiket-list" autocomplete="off"></label>` +
      `<label class="fld"><span>Koli ağırlığı (kg)</span><input name="koliAgirligiKg" value="${p.koliAgirligiKg == null ? '' : String(p.koliAgirligiKg).replace('.', ',')}" inputmode="decimal" autocomplete="off"></label>` +
      '</div>' +
      (error ? `<p class="notice notice-sim">${escapeHtml(error)}</p>` : '') +
      '<div class="dt-actions"><button type="button" class="icon-btn" data-act="close">Kapat</button>' +
      '<button type="submit" class="icon-btn btn-primary">Kaydet</button></div></form>' +
      `<datalist id="pk-kasa-list">${KASA_OPTIONS.map((o) => `<option value="${escapeHtml(o)}">`).join('')}</datalist>` +
      `<datalist id="pk-etiket-list">${ETIKET_OPTIONS.map((o) => `<option value="${escapeHtml(o)}">`).join('')}</datalist>`;
  }
  draw();

  m.body.addEventListener('click', (ev) => { if (ev.target.closest('[data-act="close"]')) m.close(); });
  m.body.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const btn = f.querySelector('[type="submit"]');
    btn.disabled = true;
    error = null;
    try {
      p = await put(`/api/planning/packing/specs/${encodeURIComponent(p.stockCode)}`, {
        musteri: f.elements.musteri.value, koliBoyutu: f.elements.koliBoyutu.value, kasaOzelligi: f.elements.kasaOzelligi.value,
        katSayisi: f.elements.katSayisi.value, koliIciAdet: f.elements.koliIciAdet.value, koliEtiketi: f.elements.koliEtiketi.value,
        koliAgirligiKg: f.elements.koliAgirligiKg.value,
      });
      m.close();
      onDone();
    } catch (e) {
      error = e.message;
      btn.disabled = false;
      draw();
    }
  });
}

/* ============================================================================================== Excel'den ilk sefer icin iceri aktarma */

/** Gerçek EYS.LS.005 Excel'ini içeri aktarır. Yalnız yönetici (uç de kayıtsız → admin). */
function openImportDialog(onDone) {
  const m = openModal({ title: 'Excel\'den içeri aktar (EYS.LS.005)' });
  let busy = false;
  let error = null;
  let result = null;
  function draw() {
    m.body.innerHTML =
      '<p class="hint">Paketleme Listesi Excel\'ini (EYS.LS.005) seçin. Alen Otomat ürün koduyla eşleşen satırlar işlenir; ' +
      'ürün kartı olmayan kodlar ve yinelenen kodlar (son satır baz alınır) uyarı olarak listelenir.</p>' +
      `<input type="file" accept=".xlsx" data-role="file"${busy ? ' disabled' : ''}>` +
      (error ? `<p class="notice notice-sim">${escapeHtml(error)}</p>` : '') +
      (result ? `<p class="notice">${fmtNum(result.matched)} ürün güncellendi, ${fmtNum(result.duplicates)} yinelenen, ${fmtNum(result.noProduct)} ürün kartı yok, ${fmtNum(result.ambiguous)} belirsiz ` +
        `(${fmtNum(result.total)} satır okundu).` + (result.warnings.length ? `<br>${result.warnings.map((w) => escapeHtml(w)).join('<br>')}</p>` : '</p>') : '') +
      '<div class="dt-actions"><button type="button" class="icon-btn" data-act="close">Kapat</button></div>';
  }
  draw();
  m.body.addEventListener('click', (ev) => { if (ev.target.closest('[data-act="close"]')) { m.close(); if (result) onDone(); } });
  m.body.addEventListener('change', async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    busy = true; error = null; result = null; draw();
    try {
      result = await api('/api/planning/packing/specs/import', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: await file.arrayBuffer() });
    } catch (e) {
      error = e.message;
    } finally {
      busy = false;
      draw();
    }
  });
}
