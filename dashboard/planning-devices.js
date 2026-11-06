/**
 * Planlama > Ölçüm cihazları takip (EYS.LS.006 "Ölçüm Cihazları Takip Listesi"): mastar/kumpas/mihengir/görüş
 * sistemi vb. ölçüm ekipmanının envanteri + kalibrasyon zamanlaması. `products`/ölçü planıyla HİÇ BAĞLANMAZ
 * (Numune Takip ile aynı ilke) — kategori serbest metin, "yeniler de satın alınıyor" (kullanıcı), kısıtlanmaz.
 *
 * Satır rengi (yeşil/sarı/kırmızı), gerçek EYS.LS.006 Excel'indeki koşullu biçimlendirmeyle BİREBİR: `calibration`
 * alanı sunucuda hesaplanır (bkz. `backend/planning/measuring-devices.js` `calibrationStatus`), burada yalnız
 * gösterilir. Renk tek başına değil, her zaman ikon+etiket çipiyle birlikte (CLAUDE.md §7).
 */
import { escapeHtml } from './format.js';
import { api, post } from './lib-common.js';
import {
  put, del, cellText, fmtNum, dateText, debounce, openModal, chip, canWrite, isAdminRole, openListPrint, truncCell, isoDate,
} from './planning-common.js';

const CAL_CHIP = Object.freeze({
  yesil: chip('ok', '✓', 'kalibrasyonlu'),
  sari: chip('warn', '◔', 'vaktine 1 ay var'),
  kirmizi: chip('bad', '✕', 'zamanı gelmiş'),
  bilinmiyor: chip('none', '–', 'tarih yok'),
  pasif: chip('none', '–', 'pasif'),
});
const rowClass = (cal) => (cal === 'yesil' ? ' pl-done' : cal === 'sari' ? ' pl-waiting' : cal === 'kirmizi' ? ' pl-rejected' : cal === 'pasif' ? ' pl-cancelled' : '');
const USABLE_LABEL = Object.freeze({ kullanilabilir: 'Kullanılabilir', kullanilamaz: 'Kullanılamaz' });
const CATEGORY_OPTIONS = ['Mastar', 'Kumpas', 'Mihengir', 'Kameralı Görüntüleme', 'Mikrometre', 'Terazi'];

/* ============================================================================================== liste */

/** @param {HTMLElement} host */
export async function renderDevices(host) {
  const canEdit = canWrite('olcucihazlari');
  const st = { q: '', active: 'aktif', calibration: '', items: [], total: 0, seq: 0 };
  host.innerHTML =
    '<div class="pl-bar"><input type="search" class="pl-search" data-role="q" placeholder="Takip no, cihaz tanımı, seri no ara…" aria-label="Ölçüm cihazı ara">' +
    '<label class="fld-inline">Durum <select data-role="active"><option value="aktif" selected>Aktif</option><option value="pasif">Pasif</option><option value="">Tümü</option></select></label>' +
    '<label class="fld-inline">Kalibrasyon <select data-role="cal"><option value="">Tümü</option><option value="yesil">Kalibrasyonlu</option>' +
    '<option value="sari">Vaktine 1 ay var</option><option value="kirmizi">Zamanı gelmiş</option><option value="bilinmiyor">Tarih yok</option></select></label>' +
    '<button type="button" class="icon-btn" data-act="print">Listeyi yazdır</button>' +
    (isAdminRole() ? '<button type="button" class="icon-btn" data-act="import">Excel\'den içeri aktar…</button>' : '') +
    (canEdit ? '<button type="button" class="icon-btn btn-primary" data-act="new">Yeni ölçüm cihazı ekle</button>' : '') + '</div>' +
    '<p class="hint" data-role="count"></p>' +
    '<div class="table-wrap table-wrap-tall" data-role="list"></div>';
  const $ = (r) => host.querySelector(`[data-role="${r}"]`);

  function draw() {
    $('count').textContent = st.total === 0
      ? (st.q || st.calibration || st.active !== 'aktif' ? 'Eşleşen ölçüm cihazı yok.' : `Henüz ölçüm cihazı yok.${canEdit ? ' "Yeni ölçüm cihazı ekle" ile başlayın.' : ''}`)
      : `${fmtNum(st.total)} ölçüm cihazı`;
    $('list').innerHTML = st.items.length === 0 ? '' :
      '<table class="tbl tbl-pl"><thead><tr><th>Kategori</th><th>Takip no</th><th>Cihaz tanımı</th><th>Seri no</th><th>Kalibrasyon</th><th>Gelecek tarih</th><th>Cihaz durumu</th></tr></thead><tbody>' +
      st.items.map((d) =>
        `<tr class="pl-row${rowClass(d.calibration)}" data-id="${d.id}" tabindex="0"><td>${cellText(d.category)}</td><td class="mono">${cellText(d.trackingNo)}</td>` +
        `<td class="trunc"${truncCell(d.name)}>${cellText(d.name)}</td><td class="mono">${cellText(d.serialNo)}</td>` +
        `<td>${CAL_CHIP[d.calibration] ?? d.calibration}</td><td>${dateText(d.nextCalibrationOn)}</td>` +
        `<td>${d.usable === 'kullanilamaz' ? chip('bad', '✕', 'kullanılamaz') : cellText(USABLE_LABEL[d.usable])}</td></tr>`).join('') +
      '</tbody></table>';
  }

  async function load() {
    const seq = ++st.seq;
    $('count').innerHTML = 'Yükleniyor…';
    try {
      const r = await api(`/api/planning/devices?${new URLSearchParams({ q: st.q, active: st.active, calibration: st.calibration, limit: 1000 })}`);
      if (seq !== st.seq) return;
      st.total = r.total; st.items = r.items;
      draw();
    } catch (err) {
      if (seq !== st.seq) return;
      $('count').innerHTML = `Ölçüm cihazları alınamadı: ${escapeHtml(err.message)} <button type="button" class="icon-btn icon-btn-sm" data-act="retry">Yeniden dene</button>`;
    }
  }

  const search = debounce((value) => { st.q = value.trim(); load(); }, 250);
  host.oninput = (ev) => { if (ev.target.dataset?.role === 'q') search(ev.target.value); };
  host.onchange = (ev) => {
    if (ev.target.dataset?.role === 'active') { st.active = ev.target.value; load(); }
    if (ev.target.dataset?.role === 'cal') { st.calibration = ev.target.value; load(); }
  };
  host.onclick = (ev) => {
    if (ev.target.closest('[data-act="retry"]')) { load(); return; }
    if (ev.target.closest('[data-act="new"]')) { openDeviceDialog(null, load); return; }
    if (ev.target.closest('[data-act="import"]')) { openImportDialog(load); return; }
    if (ev.target.closest('[data-act="print"]')) {
      openListPrint({
        title: 'Ölçüm Cihazları Takip Listesi', formNo: 'EYS.LS.006',
        heads: ['Kategori', 'Takip no', 'Cihaz tanımı', 'Seri no', 'Kalibrasyon', 'Gelecek tarih', 'Cihaz durumu'],
        rows: st.items.map((d) => [d.category, d.trackingNo, d.name, d.serialNo,
          { yesil: 'Kalibrasyonlu', sari: 'Vaktine 1 ay var', kirmizi: 'Zamanı gelmiş', bilinmiyor: 'Tarih yok', pasif: 'Pasif' }[d.calibration] ?? d.calibration,
          dateText(d.nextCalibrationOn).replace(/<[^>]+>/g, ''), USABLE_LABEL[d.usable] ?? d.usable]),
      });
      return;
    }
    const row = ev.target.closest('.pl-row');
    if (row) openDeviceDialog(Number(row.dataset.id), load);
  };
  await load();
}

/* ============================================================================================== form / duzenle */

/**
 * Ölçüm cihazı detay/düzenle penceresi: yeni (id=null) ya da var olan kayıt. Salt okuma rolü (yalnız 'read') görür, değiştiremez.
 * @param {number|null} id @param {() => void} [onDone]
 */
export async function openDeviceDialog(id, onDone = () => {}) {
  const editable = canWrite('olcucihazlari');
  const m = openModal({ title: id ? 'Ölçüm cihazı' : 'Yeni ölçüm cihazı', wide: true });
  m.body.innerHTML = '<p class="empty">Yükleniyor…</p>';
  let d = null;
  if (id) {
    try { d = await api(`/api/planning/devices/${id}`); } catch (err) { m.body.innerHTML = `<p class="notice notice-sim">Alınamadı: ${escapeHtml(err.message)}</p>`; return; }
  }
  let error = null;

  const v = (key) => (d ? d[key] : null);
  const txt = (key, label, max, extra = '') => `<label class="fld"><span>${escapeHtml(label)}</span><input name="${key}" value="${escapeHtml(v(key) ?? '')}" maxlength="${max}" autocomplete="off"${editable ? '' : ' readonly'}${extra}></label>`;
  const num = (key, label) => `<label class="fld"><span>${escapeHtml(label)}</span><input name="${key}" inputmode="decimal" value="${escapeHtml(v(key) == null ? '' : String(v(key)).replace('.', ','))}" autocomplete="off"${editable ? '' : ' readonly'}></label>`;
  const dt = (key, label) => `<label class="fld"><span>${escapeHtml(label)}</span><input name="${key}" type="date" value="${isoDate(v(key))}"${editable ? '' : ' disabled'}></label>`;
  const sel = (key, label, options) => `<label class="fld"><span>${escapeHtml(label)}</span><select name="${key}"${editable ? '' : ' disabled'}>` +
    options.map(([val, text2]) => `<option value="${val}"${v(key) === val ? ' selected' : ''}>${escapeHtml(text2)}</option>`).join('') + '</select></label>';

  function draw() {
    m.body.innerHTML =
      (d ? `<p class="pl-wohead"><b>${escapeHtml(d.category)}</b> · ${escapeHtml(d.name)} · ${CAL_CHIP[d.calibration] ?? ''}</p>` : '') +
      '<form autocomplete="off"><h4 class="sub">Cihaz bilgileri</h4><div class="fld-grid">' +
      `<label class="fld"><span>Cihaz kategorisi *</span><input name="category" value="${escapeHtml(v('category') ?? '')}" maxlength="80" autocomplete="off" list="dev-cat-list" required${editable ? '' : ' readonly'}></label>` +
      txt('trackingNo', 'Takip no', 60) + txt('name', 'Cihaz tanımı *', 200, ' required') + txt('serialNo', 'Seri no', 80) +
      txt('modelBrand', 'Model-marka', 80) + txt('measureRange', 'Ölçüm aralığı', 80) + num('resolutionMm', 'Çözünürlük (mm)') +
      txt('gaugeType', 'Mastar özelliği', 40, ' placeholder="HALKA / TAMPON"') + txt('interimCheck', 'Ara kontrol', 40) +
      txt('deviationNote', 'Sapma durumu', 300) +
      '</div><h4 class="sub">Kalibrasyon</h4><div class="fld-grid">' +
      sel('usable', 'Cihaz durumu', [['kullanilabilir', 'Kullanılabilir'], ['kullanilamaz', 'Kullanılamaz']]) +
      sel('active', 'Kayıt durumu', [['aktif', 'Aktif'], ['pasif', 'Pasif (kullanım dışı)']]) +
      dt('lastCalibratedOn', 'Kalibrasyon tarihi') + txt('calibrationCompany', 'Kalibrasyon firması', 120) +
      dt('nextCalibrationOn', 'Gelecek kalibrasyon tarihi') +
      '</div><h4 class="sub">Zimmet / konum</h4><div class="fld-grid">' +
      txt('department', 'Bölüm-alt bölüm', 120) + txt('heldBy', 'Teslim alan', 120) + dt('deliveredOn', 'Teslim tarihi') +
      '</div>' +
      `<label class="fld"><span>Hata bilgisi</span><textarea name="issueNote" rows="2" maxlength="500"${editable ? '' : ' readonly'}>${escapeHtml(v('issueNote') ?? '')}</textarea></label>` +
      `<label class="fld"><span>Not</span><textarea name="note" rows="2" maxlength="500"${editable ? '' : ' readonly'}>${escapeHtml(v('note') ?? '')}</textarea></label>` +
      (error ? `<p class="notice notice-sim">${escapeHtml(error)}</p>` : '') +
      '<div class="dt-actions">' +
      (isAdminRole() && d ? '<button type="button" class="icon-btn" data-act="delete">Sil…</button>' : '') +
      '<button type="button" class="icon-btn" data-act="close">Kapat</button>' +
      (editable ? `<button type="submit" class="icon-btn btn-primary" data-act="save">${d ? 'Kaydet' : 'Cihazı ekle'}</button>` : '') +
      '</div></form>' +
      '<datalist id="dev-cat-list">' + CATEGORY_OPTIONS.map((c) => `<option value="${escapeHtml(c)}">`).join('') + '</datalist>';
  }
  draw();

  m.body.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-act="close"]')) { m.close(); return; }
    if (ev.target.closest('[data-act="delete"]')) {
      if (!window.confirm(`"${d.name}" silinsin mi? Bu geri alınamaz.`)) return;
      del(`/api/planning/devices/${d.id}`).then(() => { onDone(); m.close(); }).catch((e) => { error = e.message; draw(); });
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
        category: f.elements.category.value, trackingNo: f.elements.trackingNo.value, name: f.elements.name.value,
        serialNo: f.elements.serialNo.value, modelBrand: f.elements.modelBrand.value, measureRange: f.elements.measureRange.value,
        resolutionMm: f.elements.resolutionMm.value, gaugeType: f.elements.gaugeType.value, interimCheck: f.elements.interimCheck.value,
        deviationNote: f.elements.deviationNote.value, usable: f.elements.usable.value, active: f.elements.active.value,
        lastCalibratedOn: f.elements.lastCalibratedOn.value || null, calibrationCompany: f.elements.calibrationCompany.value,
        nextCalibrationOn: f.elements.nextCalibrationOn.value || null, department: f.elements.department.value,
        heldBy: f.elements.heldBy.value, deliveredOn: f.elements.deliveredOn.value || null,
        issueNote: f.elements.issueNote.value, note: f.elements.note.value,
      };
      d = d ? await put(`/api/planning/devices/${d.id}`, body) : await post('/api/planning/devices', body);
      onDone(); // ilk olusturmadan sonra da diyalog acik kalir: d artik dolu, draw() "duzenle" goruntusune gecer
      draw();
    } catch (e) {
      error = e.message;
      btn.disabled = false;
      draw();
    }
  });
}

/* ============================================================================================== Excel'den ilk sefer icin iceri aktarma */

/** Setup kurulumunda İLK SEFER için: gerçek EYS.LS.006 Excel'ini yükler. Yalnız yönetici (uç de kayıtsız → admin). */
function openImportDialog(onDone) {
  const m = openModal({ title: 'Excel\'den içeri aktar (EYS.LS.006)' });
  let busy = false;
  let error = null;
  let result = null;
  function draw() {
    m.body.innerHTML =
      '<p class="hint">Ölçüm Cihazları Takip Listesi Excel\'ini (EYS.LS.006) seçin. Bu, kurulumdan sonra İLK SEFER için var olan cihazların mevcut hâlini aktarır; ' +
      'Takip No ile zaten kayıtlı bir cihaz varsa o satır atlanır — iki kez yüklemek güvenlidir.</p>' +
      `<input type="file" accept=".xlsx" data-role="file"${busy ? ' disabled' : ''}>` +
      (error ? `<p class="notice notice-sim">${escapeHtml(error)}</p>` : '') +
      (result ? `<p class="notice">${fmtNum(result.added)} cihaz eklendi, ${fmtNum(result.skipped)} satır atlandı (${fmtNum(result.total)} satır okundu).` +
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
      result = await api('/api/planning/devices/import', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: await file.arrayBuffer() });
    } catch (e) {
      error = e.message;
    } finally {
      busy = false;
      draw();
    }
  });
}
