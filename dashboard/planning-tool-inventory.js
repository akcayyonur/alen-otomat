/**
 * Planlama > Takım ve Pens Takip (EYS.LS.026 "Pens ve Takım Takip Listesi" + ayrı "Takım Uçları ve
 * Tutucuları" dosyası): kesici takım (matkap, kılavuz, freze, uç...), pens (kollet) ve takım tutucusu
 * envanteri. `products` ile HİÇ BAĞLANMAZ (Ölçüm Cihazları Takip ile AYNI ilke) — kategori serbest metin,
 * yeni takım türleri KISITLANMADAN eklenebilir.
 *
 * Stok/kritik stok alanları SERBEST METİNdir (sayı değil): gerçek listede "X" gibi sayısal olmayan
 * işaretler de var, zorla sayıya çevirmek veri kaybederdi (bkz. backend/planning/tool-inventory.js).
 */
import { escapeHtml } from './format.js';
import { api, post } from './lib-common.js';
import { put, del, cellText, fmtNum, debounce, openModal, canWrite, isAdminRole, openListPrint, truncCell } from './planning-common.js';

/* ============================================================================================== liste */

/** @param {HTMLElement} host */
export async function renderToolInventory(host) {
  const canEdit = canWrite('takimtakip');
  const st = { q: '', items: [], total: 0, seq: 0, categories: [] };
  host.innerHTML =
    '<div class="pl-bar"><input type="search" class="pl-search" data-role="q" placeholder="Kategori, marka, kod ya da tanım ara…" aria-label="Takım/pens ara">' +
    '<button type="button" class="icon-btn" data-act="print">Listeyi yazdır</button>' +
    (isAdminRole() ? '<button type="button" class="icon-btn" data-act="import">Excel\'den içeri aktar…</button>' : '') +
    (canEdit ? '<button type="button" class="icon-btn btn-primary" data-act="new">Yeni kayıt ekle</button>' : '') + '</div>' +
    '<p class="hint" data-role="count"></p>' +
    '<div class="table-wrap table-wrap-tall" data-role="list"></div>';
  const $ = (r) => host.querySelector(`[data-role="${r}"]`);

  function draw() {
    $('count').textContent = st.total === 0
      ? (st.q ? 'Eşleşen kayıt yok.' : `Henüz kayıt yok.${canEdit ? ' "Yeni kayıt ekle" ile başlayın.' : ''}`)
      : `${fmtNum(st.total)} kayıt`;
    $('list').innerHTML = st.items.length === 0 ? '' :
      '<table class="tbl tbl-pl"><thead><tr><th>Kategori</th><th>Marka</th><th>Kod</th><th>Tanım</th><th>Stok/Adet</th><th>Kritik stok</th><th>Açıklama</th></tr></thead><tbody>' +
      st.items.map((d) =>
        `<tr class="pl-row" data-id="${d.id}" tabindex="0"><td>${cellText(d.category)}</td><td>${cellText(d.brand)}</td><td class="mono">${cellText(d.code)}</td>` +
        `<td class="trunc"${truncCell(d.name)}>${cellText(d.name)}</td><td class="mono">${cellText(d.qty)}</td><td class="mono">${cellText(d.criticalQty)}</td>` +
        `<td class="trunc"${truncCell(d.note)}>${cellText(d.note)}</td></tr>`).join('') +
      '</tbody></table>';
  }

  async function load() {
    const seq = ++st.seq;
    $('count').innerHTML = 'Yükleniyor…';
    try {
      const r = await api(`/api/planning/tool-items?${new URLSearchParams({ q: st.q, limit: 2000 })}`);
      if (seq !== st.seq) return;
      st.total = r.total; st.items = r.items;
      draw();
    } catch (err) {
      if (seq !== st.seq) return;
      $('count').innerHTML = `Alınamadı: ${escapeHtml(err.message)} <button type="button" class="icon-btn icon-btn-sm" data-act="retry">Yeniden dene</button>`;
    }
  }

  async function loadCategories() {
    try { st.categories = (await api('/api/planning/tool-items/categories')).items; } catch { /* oneri listesi olmadan da ekran calisir */ }
  }

  const search = debounce((value) => { st.q = value.trim(); load(); }, 250);
  host.oninput = (ev) => { if (ev.target.dataset?.role === 'q') search(ev.target.value); };
  host.onclick = (ev) => {
    if (ev.target.closest('[data-act="retry"]')) { load(); return; }
    if (ev.target.closest('[data-act="new"]')) { openToolDialog(null, st.categories, () => { load(); loadCategories(); }); return; }
    if (ev.target.closest('[data-act="import"]')) { openImportDialog(() => { load(); loadCategories(); }); return; }
    if (ev.target.closest('[data-act="print"]')) {
      openListPrint({
        title: 'PENS VE TAKIM TAKİP LİSTESİ', formNo: 'EYS.LS.026',
        heads: ['Kategori', 'Marka', 'Kod', 'Tanım', 'Stok/Adet', 'Kritik stok', 'Açıklama'],
        rows: st.items.map((d) => [d.category, d.brand, d.code, d.name, d.qty, d.criticalQty, d.note]),
        note: st.q ? `Süzgeç: "${st.q}"` : '',
      });
      return;
    }
    const row = ev.target.closest('.pl-row');
    if (row) openToolDialog(Number(row.dataset.id), st.categories, () => { load(); loadCategories(); });
  };
  await Promise.all([load(), loadCategories()]);
}

/* ============================================================================================== form / duzenle */

/**
 * Takım/pens kaydı detay/düzenle penceresi: yeni (id=null) ya da var olan kayıt.
 * @param {number|null} id @param {string[]} categories öneri listesi (datalist) @param {() => void} [onDone]
 */
export async function openToolDialog(id, categories, onDone = () => {}) {
  const editable = canWrite('takimtakip');
  const m = openModal({ title: id ? 'Takım/pens kaydı' : 'Yeni kayıt' });
  m.body.innerHTML = '<p class="empty">Yükleniyor…</p>';
  let d = null;
  if (id) {
    try { d = await api(`/api/planning/tool-items/${id}`); } catch (err) { m.body.innerHTML = `<p class="notice notice-sim">Alınamadı: ${escapeHtml(err.message)}</p>`; return; }
  }
  let error = null;

  const v = (key) => (d ? d[key] : null);
  const txt = (key, label, max, extra = '') => `<label class="fld"><span>${escapeHtml(label)}</span><input name="${key}" value="${escapeHtml(v(key) ?? '')}" maxlength="${max}" autocomplete="off"${editable ? '' : ' readonly'}${extra}></label>`;

  function draw() {
    m.body.innerHTML =
      (d ? `<p class="pl-wohead"><b>${escapeHtml(d.category)}</b> · ${escapeHtml(d.name)}</p>` : '') +
      '<form autocomplete="off"><div class="fld-grid">' +
      `<label class="fld"><span>Kategori *</span><input name="category" value="${escapeHtml(v('category') ?? '')}" maxlength="80" autocomplete="off" list="tool-cat-list" required${editable ? '' : ' readonly'}></label>` +
      txt('name', 'Tanım *', 200, ' required') + txt('brand', 'Marka', 80) + txt('code', 'Kod', 150) +
      txt('qty', 'Stok/Adet', 20, ' placeholder="ör. 5 ya da X"') + txt('criticalQty', 'Kritik stok', 20) +
      '</div>' +
      `<label class="fld"><span>Açıklama</span><textarea name="note" rows="2" maxlength="500"${editable ? '' : ' readonly'}>${escapeHtml(v('note') ?? '')}</textarea></label>` +
      (error ? `<p class="notice notice-sim">${escapeHtml(error)}</p>` : '') +
      '<div class="dt-actions">' +
      (isAdminRole() && d ? '<button type="button" class="icon-btn" data-act="delete">Sil…</button>' : '') +
      '<button type="button" class="icon-btn" data-act="close">Kapat</button>' +
      (editable ? `<button type="submit" class="icon-btn btn-primary" data-act="save">${d ? 'Kaydet' : 'Ekle'}</button>` : '') +
      '</div></form>' +
      '<datalist id="tool-cat-list">' + categories.map((c) => `<option value="${escapeHtml(c)}">`).join('') + '</datalist>';
  }
  draw();

  m.body.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-act="close"]')) { m.close(); return; }
    if (ev.target.closest('[data-act="delete"]')) {
      if (!window.confirm(`"${d.name}" silinsin mi? Bu geri alınamaz.`)) return;
      del(`/api/planning/tool-items/${d.id}`).then(() => { onDone(); m.close(); }).catch((e) => { error = e.message; draw(); });
    }
  });
  m.body.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const btn = f.querySelector('[type="submit"]');
    btn.disabled = true;
    error = null;
    try {
      const body = {
        category: f.elements.category.value, name: f.elements.name.value, brand: f.elements.brand.value,
        code: f.elements.code.value, qty: f.elements.qty.value, criticalQty: f.elements.criticalQty.value, note: f.elements.note.value,
      };
      d = d ? await put(`/api/planning/tool-items/${d.id}`, body) : await post('/api/planning/tool-items', body);
      onDone(); // ilk olusturmadan sonra da diyalog acik kalir: d artik dolu, draw() "duzenle" goruntusune gecer
      draw();
    } catch (e) {
      error = e.message;
      btn.disabled = false;
      draw();
    }
  });
}

/* ============================================================================================== Excel'den iceri aktarma */

/** EYS.LS.026 ya da "Takım Uçları ve Tutucuları" Excel'ini yükler. Yalnız yönetici (uç de kayıtsız → admin). */
function openImportDialog(onDone) {
  const m = openModal({ title: 'Excel\'den içeri aktar' });
  let busy = false;
  let error = null;
  let result = null;
  function draw() {
    m.body.innerHTML =
      '<p class="hint">"Pens ve Takım Takip Listesi" (EYS.LS.026) ya da "Takım Uçları ve Tutucuları" dosyasını seçin. ' +
      'Çalışma kitabındaki her sayfa sırayla denenir; tanınmayan sayfalar atlanır. Aynı dosyayı tekrar yüklemek güvenlidir — zaten kayıtlı satırlar yeniden eklenmez.</p>' +
      `<input type="file" accept=".xlsx" data-role="file"${busy ? ' disabled' : ''}>` +
      (error ? `<p class="notice notice-sim">${escapeHtml(error)}</p>` : '') +
      (result ? `<p class="notice">${fmtNum(result.added)} kayıt eklendi, ${fmtNum(result.skipped)} satır atlandı (${fmtNum(result.totalRows)} satır okundu).` +
        (result.skippedSheets.length ? `<br>Tanınmayan sayfalar: ${result.skippedSheets.map((s) => escapeHtml(s)).join(', ')}` : '') +
        (result.warnings.length ? `<br>${result.warnings.map((w) => escapeHtml(w)).join('<br>')}</p>` : '</p>') : '') +
      '<div class="dt-actions"><button type="button" class="icon-btn" data-act="close">Kapat</button></div>';
  }
  draw();
  m.body.addEventListener('click', (ev) => { if (ev.target.closest('[data-act="close"]')) { m.close(); if (result) onDone(); } });
  m.body.addEventListener('change', async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    busy = true; error = null; result = null; draw();
    try {
      result = await api('/api/planning/tool-items/import', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: await file.arrayBuffer() });
    } catch (e) {
      error = e.message;
    } finally {
      busy = false;
      draw();
    }
  });
}
