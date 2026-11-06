/**
 * Planlama > Ürünler > Teknik resim takip (EYS.LS.007 "Seri Üretim Teknik Resim Takip Listesi"):
 * sistemdeki HER ürünün teknik resminin durumu (var/yok, kaç no'lu revizyon, ne zaman). Satıra basınca
 * (resim VARSA) PDF açılır; "Düzenle" ile Excel'in kimlik+revizyon alanları elle düzeltilir.
 *
 * Ürün adı/stok kodu/müşteri kodu `products`tan gelir (burada tekrar edilmez); rev no normalde SİSTEM
 * tarafından otomatik artırılır (bir ürüne yeni/değişen teknik resim eklendiğinde, bkz. `doc-folder.js`);
 * burada elle de düzeltilebilir (yanlış geldiyse). "Durumu" serbest metindir, bir listeye kısıtlanmaz.
 */
import { escapeHtml } from './format.js';
import { api } from './lib-common.js';
import {
  put, cellText, fmtNum, dateText, debounce, openModal, chip, canWrite, isAdminRole, isoDate, truncCell,
} from './planning-common.js';

const PAGE = 100;

/** @param {HTMLElement} host */
export function renderDrawingTracking(host) {
  const canEdit = canWrite('teknikresim');
  const st = { q: '', items: [], total: 0, seq: 0 };
  host.innerHTML =
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
      '<th>Resim durumu</th><th class="num">Rev no</th><th>Son değişiklik</th><th>Durumu</th><th></th></tr></thead><tbody>' +
      st.items.map((p) =>
        `<tr class="pl-row" data-code="${escapeHtml(p.stockCode)}" tabindex="0">` +
        `<td class="mono"><b>${escapeHtml(p.stockCode)}</b></td><td class="mono">${cellText(p.customerCode)}</td>` +
        `<td class="trunc"${truncCell(p.name)}>${cellText(p.name)}</td><td class="trunc"${truncCell(p.musteri)}>${cellText(p.musteri)}</td>` +
        `<td>${p.drawingCount > 0 ? chip('ok', '✓', `${fmtNum(p.drawingCount)} dosya`) : chip('none', '–', 'resim yok')}</td>` +
        `<td class="num">${fmtNum(p.revNo)}</td><td>${dateText(p.revTarihi ?? p.yayinTarihi)}</td><td>${cellText(p.durumu)}</td>` +
        `<td>${canEdit ? `<button type="button" class="icon-btn icon-btn-sm" data-act="edit" data-code="${escapeHtml(p.stockCode)}">Düzenle</button>` : ''}</td></tr>`).join('') +
      '</tbody></table>';
    $('more').hidden = st.items.length >= st.total;
  }

  async function load(reset) {
    const seq = ++st.seq;
    const offset = reset ? 0 : st.items.length;
    try {
      const r = await api(`/api/planning/drawing-tracking?${new URLSearchParams({ q: st.q, limit: PAGE, offset })}`);
      if (seq !== st.seq) return;
      st.total = r.total;
      st.items = reset ? r.items : [...st.items, ...r.items];
      draw();
    } catch (err) {
      if (seq === st.seq) $('count').textContent = `Ürünler alınamadı: ${err.message}`;
    }
  }

  /** Satıra/koda basınca: tek resim varsa direkt açar, birden çoksa küçük bir seçim listesi gösterir. */
  async function openDrawing(stockCode) {
    let product;
    try { product = await api(`/api/planning/products/${encodeURIComponent(stockCode)}`); } catch (err) { window.alert(`Ürün alınamadı: ${err.message}`); return; }
    const files = product.files.filter((f) => f.kind === 'cizim');
    if (files.length === 0) { window.alert('Bu ürüne bağlı teknik resim yok.'); return; }
    if (files.length === 1) { window.open(`/api/planning/product-files/${files[0].id}`, '_blank', 'noopener'); return; }
    const m = openModal({ title: `${stockCode} · teknik resimler` });
    m.body.innerHTML = `<ul class="pl-list">${files.map((f) => `<li><a href="/api/planning/product-files/${f.id}" target="_blank" rel="noopener">${escapeHtml(f.name)}</a></li>`).join('')}</ul>`;
  }

  const search = debounce((value) => { st.q = value.trim(); load(true); }, 250);
  host.oninput = (ev) => { if (ev.target.dataset?.role === 'q') search(ev.target.value); };
  host.onclick = (ev) => {
    if (ev.target.closest('[data-act="import"]')) { openImportDialog(() => load(true)); return; }
    if (ev.target.closest('[data-act="more"]')) { load(false); return; }
    const editBtn = ev.target.closest('[data-act="edit"]');
    if (editBtn) { openTrackingDialog(st.items.find((x) => x.stockCode === editBtn.dataset.code), () => load(true)); return; }
    const row = ev.target.closest('.pl-row');
    if (row) openDrawing(row.dataset.code);
  };
  host.onkeydown = (ev) => {
    if (ev.key !== 'Enter') return;
    const row = ev.target.closest?.('.pl-row');
    if (row) openDrawing(row.dataset.code);
  };
  load(true);
}

/* ============================================================================================== duzenle */

/** Teknik resim takip alanlarını düzenleme penceresi (EYS.LS.007); satır listede zaten yüklü, yeniden sorgulanmaz. @param {object} p @param {() => void} [onDone] */
function openTrackingDialog(p, onDone = () => {}) {
  const m = openModal({ title: `Teknik resim takip · ${p.stockCode}` });
  let error = null;

  function draw() {
    m.body.innerHTML =
      `<p class="pl-wohead"><b>${escapeHtml(p.stockCode)}</b> · ${escapeHtml(p.name ?? '')}${p.drawingCount > 0 ? ` · ${chip('ok', '✓', `${p.drawingCount} dosya`)}` : ''}</p>` +
      '<form autocomplete="off"><div class="fld-grid">' +
      `<label class="fld"><span>Müşteri</span><input name="musteri" value="${escapeHtml(p.musteri ?? '')}" maxlength="120" autocomplete="off"></label>` +
      `<label class="fld"><span>Resim no</span><input name="resimNo" value="${escapeHtml(p.resimNo ?? '')}" maxlength="60" autocomplete="off"></label>` +
      `<label class="fld"><span>Kayıt tarihi</span><input name="kayitTarihi" type="date" value="${isoDate(p.kayitTarihi)}"></label>` +
      `<label class="fld"><span>Rev no</span><input name="revNo" value="${p.revNo ?? 0}" inputmode="numeric"></label>` +
      `<label class="fld"><span>Yayın tarihi</span><input name="yayinTarihi" type="date" value="${isoDate(p.yayinTarihi)}"></label>` +
      `<label class="fld"><span>Rev. tarihi</span><input name="revTarihi" type="date" value="${isoDate(p.revTarihi)}"></label>` +
      `<label class="fld"><span>Tutulduğu ortam</span><input name="tutuldugu" value="${escapeHtml(p.tutuldugu ?? '')}" maxlength="40" placeholder="BİLGİSAYAR" autocomplete="off"></label>` +
      `<label class="fld"><span>Durumu</span><input name="durumu" value="${escapeHtml(p.durumu ?? '')}" maxlength="60" autocomplete="off"></label>` +
      '</div>' +
      '<p class="hint">Rev no normalde sistem tarafından otomatik artırılır (yeni ya da değişen teknik resim eklendiğinde); burada yalnız yanlış geldiyse düzeltin.</p>' +
      `<label class="fld"><span>Revizyon nedeni</span><textarea name="revizyonNedeni" rows="2" maxlength="300">${escapeHtml(p.revizyonNedeni ?? '')}</textarea></label>` +
      (error ? `<p class="notice notice-sim">${escapeHtml(error)}</p>` : '') +
      '<div class="dt-actions"><button type="button" class="icon-btn" data-act="close">Kapat</button>' +
      '<button type="submit" class="icon-btn btn-primary">Kaydet</button></div></form>';
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
      p = await put(`/api/planning/drawing-tracking/${encodeURIComponent(p.stockCode)}`, {
        musteri: f.elements.musteri.value, resimNo: f.elements.resimNo.value, kayitTarihi: f.elements.kayitTarihi.value || null,
        revNo: f.elements.revNo.value, yayinTarihi: f.elements.yayinTarihi.value || null, revTarihi: f.elements.revTarihi.value || null,
        tutuldugu: f.elements.tutuldugu.value, durumu: f.elements.durumu.value, revizyonNedeni: f.elements.revizyonNedeni.value,
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

/** Gerçek EYS.LS.007 Excel'ini içeri aktarır. Yalnız yönetici (uç de kayıtsız → admin). */
function openImportDialog(onDone) {
  const m = openModal({ title: 'Excel\'den içeri aktar (EYS.LS.007)' });
  let busy = false;
  let error = null;
  let result = null;
  function draw() {
    m.body.innerHTML =
      '<p class="hint">Teknik Resim Takip Listesi Excel\'ini (EYS.LS.007) seçin. Alen Otomat ürün koduyla eşleşen satırlar işlenir; ' +
      'ürün kartı olmayan kodlar ve yinelenen kodlar (en yeni olan baz alınır) uyarı olarak listelenir.</p>' +
      `<input type="file" accept=".xlsx" data-role="file"${busy ? ' disabled' : ''}>` +
      (error ? `<p class="notice notice-sim">${escapeHtml(error)}</p>` : '') +
      (result ? `<p class="notice">${fmtNum(result.matched)} ürün güncellendi, ${fmtNum(result.duplicates)} yinelenen, ${fmtNum(result.noProduct)} ürün kartı yok ` +
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
      result = await api('/api/planning/drawing-tracking/import', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: await file.arrayBuffer() });
    } catch (e) {
      error = e.message;
    } finally {
      busy = false;
      draw();
    }
  });
}
