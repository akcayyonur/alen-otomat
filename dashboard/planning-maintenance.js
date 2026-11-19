/**
 * Planlama > Bakım (EYS.FR.016 "Bakım Kayıt Formu" + Bakım Sicil Kartları): makine tipi → bakım kalemi
 * (periyodu YÖNETİCİ ayarlar, usta yalnızca tik atar) → makine (asset) başına tik/rutin/arızi kayıt geçmişi.
 * `products` ile BAĞLANMAZ. İki seviyeli açılır/kapanır liste — kütüphane ekranının "klasöre göre grupla"
 * mekaniğiyle AYNI (`dashboard/library-view.js`): native `<details class="grp">`, açık/kapalı durum bir
 * `Set`te hatırlanır. Durum rengi (tamam/yaklaşıyor/gecikti) sunucuda hesaplanır (`backend/planning/maintenance.js`
 * `nextDueAt`/`dueStatus`); burada yalnız ikon+etiket+renk birlikte gösterilir (CLAUDE.md §7).
 */
import { escapeHtml } from './format.js';
import { api, post } from './lib-common.js';
import { put, del, cellText, fmtNum, dateText, debounce, openModal, chip, canWrite, isAdminRole, isoDate } from './planning-common.js';

const DUE_CHIP = Object.freeze({
  tamam: chip('ok', '✓', 'tamam'),
  yaklasiyor: chip('warn', '◔', 'yaklaşıyor'),
  gecikti: chip('bad', '✕', 'gecikti'),
});
const ROW_CLASS = Object.freeze({ tamam: 'pl-done', yaklasiyor: 'pl-waiting', gecikti: 'pl-rejected' });
const UNIT_LABEL = Object.freeze({ vardiya: 'Vardiya', gun: 'Gün', hafta: 'Hafta', ay: 'Ay', yil: 'Yıl' });
const REQUIRES_LABEL = Object.freeze({ hayir: 'Kayıt tutulmaz', degisimde: 'Değişim olursa not', her_zaman: 'Her zaman kayıt' });
const MONTH_NAMES = Object.freeze(['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık']);

function assetLabel(a) {
  const parts = [];
  if (a.sicilNo) parts.push(a.sicilNo);
  if (a.assetNo) parts.push(`No ${a.assetNo}`);
  const bm = [a.brand, a.model].filter(Boolean).join(' ');
  if (bm) parts.push(bm);
  return parts.length ? parts.join(' · ') : `Makine #${a.id}`;
}

/** Bir kalemin periyodunu insan okur metne çevirir (sunucudaki `parsePeriodText`'in TERS yönü — yalnız gösterim). */
function periodText(it) {
  if (!it.periodUnit) return 'Periyot tanımsız';
  if (it.anchorMonths?.length) {
    const months = it.anchorMonths.map((m) => MONTH_NAMES[m - 1]).join('-');
    return it.periodUnit === 'yil' ? `Yıllık (${months})` : `${it.periodEvery} ayda bir (${months})`;
  }
  if (it.periodUnit === 'vardiya') return it.timesPerPeriod > 1 ? `Vardiyada ${it.timesPerPeriod} kez` : 'Her vardiya';
  if (it.periodUnit === 'gun') return it.timesPerPeriod > 1 ? `Günde ${it.timesPerPeriod} kez` : 'Günlük';
  if (it.periodUnit === 'hafta') return it.timesPerPeriod > 1 ? `Haftada ${it.timesPerPeriod} kez` : 'Haftalık';
  if (it.periodUnit === 'ay') return it.periodEvery > 1 ? `${it.periodEvery} ayda bir` : (it.timesPerPeriod > 1 ? `Ayda ${it.timesPerPeriod} kez` : 'Aylık');
  if (it.periodUnit === 'yil') return it.periodEvery > 1 ? `${it.periodEvery} yılda bir` : 'Yıllık';
  return '—';
}

/* ============================================================================================== liste */

/** @param {HTMLElement} host */
export async function renderMaintenance(host) {
  const st = { q: '', types: [], openTypes: new Set(), openAssets: new Set(), seq: 0, autoTick: null };
  host.innerHTML =
    '<div class="pl-bar"><input type="search" class="pl-search" data-role="q" placeholder="Makine tipi, sicil no, marka/model ara…" aria-label="Bakım ara">' +
    (isAdminRole() ? '<button type="button" class="icon-btn" data-act="import">Excel\'den içeri aktar…</button>' : '') +
    (isAdminRole() ? '<button type="button" class="icon-btn" data-act="new-type">Yeni tip ekle…</button>' : '') +
    (isAdminRole() ? '<button type="button" class="icon-btn btn-primary" data-act="new-asset">Yeni makine ekle…</button>' : '') +
    '</div>' +
    // Usta bu ekrani gunluk kullanmiyor - tikler yalniz denetimde dolduruluyordu (kullanici bulgusu); bu yuzden
    // sistem periyodu gelince KENDISI, her makine icin BAGIMSIZ rastgele bir saatte tik atar. Anahtar yalniz
    // yoneticiye: "ayarlar sayfasi" burasi - Bakim ayri bir Planlama Ayarlari ekrani yok (bkz. CLAUDE.md).
    (isAdminRole()
      ? '<p class="hint"><label class="chk"><input type="checkbox" data-role="auto-tick" disabled> ' +
        'Otomatik tik (periyodu gelince sistem her makine için rastgele bir saatte kendisi tik atar)</label></p>'
      : '') +
    '<p class="hint" data-role="count"></p><div data-role="list"></div>';
  const $ = (r) => host.querySelector(`[data-role="${r}"]`);

  const itemsTable = (a) => {
    const canEdit = canWrite('bakim');
    return '<table class="tbl tbl-pl"><thead><tr><th>Bakım</th><th>Periyot</th><th>Sorumlu</th><th>Durum</th><th>Son yapılan</th><th></th></tr></thead><tbody>' +
      a.items.map((it) => `<tr class="${ROW_CLASS[it.status] ?? ''}">` +
        `<td>${escapeHtml(it.description)}${it.timingNote ? `<br><small class="hint">${escapeHtml(it.timingNote)}</small>` : ''}</td>` +
        `<td>${escapeHtml(periodText(it))}</td><td>${cellText(it.responsible)}</td>` +
        `<td>${it.status ? DUE_CHIP[it.status] : chip('none', '–', 'periyot tanımsız')}</td>` +
        `<td>${it.lastDoneOn ? `${dateText(it.lastDoneOn)}${it.lastDoneBy ? ` · ${escapeHtml(it.lastDoneBy)}` : ''}` : cellText(null)}</td>` +
        `<td>${canEdit ? `<button type="button" class="icon-btn icon-btn-sm" data-act="tick" data-asset="${a.id}" data-item="${it.id}">Tik at</button> ` : ''}` +
        `<button type="button" class="icon-btn icon-btn-sm" data-act="history" data-asset="${a.id}" data-item="${it.id}">Geçmiş</button></td></tr>`).join('') +
      '</tbody></table>';
  };

  const assetBlock = (a, open) => {
    const canEdit = canWrite('bakim');
    const badge = a.worstStatus ? DUE_CHIP[a.worstStatus] : '';
    return `<details class="grp mnt-asset" data-asset="${a.id}"${open ? ' open' : ''}>` +
      `<summary><b>${escapeHtml(assetLabel(a))}</b> ${a.active === 'pasif' ? chip('none', '–', 'pasif') : ''} ${badge}</summary>` +
      '<div class="grp-body">' +
      '<div class="dt-actions lib-grp-actions">' +
      (canEdit ? `<button type="button" class="icon-btn icon-btn-sm" data-act="free-log" data-kind="rutin" data-asset="${a.id}">Rutin bakım kaydı ekle…</button>` +
        `<button type="button" class="icon-btn icon-btn-sm" data-act="free-log" data-kind="arizi" data-asset="${a.id}">Arızi bakım kaydı ekle…</button>` : '') +
      (isAdminRole() ? `<button type="button" class="icon-btn icon-btn-sm" data-act="edit-asset" data-asset="${a.id}">Düzenle…</button>` : '') +
      '</div>' +
      (a.items.length === 0 ? '<p class="empty">Bu tip için bakım kalemi tanımlı değil.</p>' : itemsTable(a)) +
      '</div></details>';
  };

  function draw() {
    const types = st.types;
    if (types.length === 0) {
      $('count').textContent = st.q ? 'Eşleşen makine yok.' : `Henüz makine yok.${isAdminRole() ? ' "Excel\'den içeri aktar…" ya da "Yeni makine ekle…" ile başlayın.' : ''}`;
      $('list').innerHTML = '';
      return;
    }
    const totalAssets = types.reduce((n, t) => n + t.assets.length, 0);
    $('count').textContent = `${fmtNum(types.length)} makine tipi · ${fmtNum(totalAssets)} makine`;
    const searching = !!st.q;
    $('list').innerHTML = types.map((t) => {
      const open = searching || st.openTypes.has(t.id);
      const badge = t.worstStatus ? DUE_CHIP[t.worstStatus] : '';
      return `<details class="grp mnt-grp" data-type="${t.id}"${open ? ' open' : ''}>` +
        `<summary><b>${escapeHtml(t.name)}</b> <span class="hint">· ${fmtNum(t.assets.length)} makine</span> ${badge}</summary>` +
        '<div class="grp-body">' +
        (isAdminRole() ? '<div class="dt-actions lib-grp-actions">' +
          `<button type="button" class="icon-btn icon-btn-sm" data-act="edit-plan" data-type="${t.id}">Bu tipin bakım planını düzenle…</button>` +
          `<button type="button" class="icon-btn icon-btn-sm" data-act="new-asset" data-type="${t.id}">Yeni makine ekle…</button></div>` : '') +
        (t.assets.length === 0 ? '<p class="empty">Bu tipte henüz makine yok.</p>' : t.assets.map((a) => assetBlock(a, searching || st.openAssets.has(a.id))).join('')) +
        '</div></details>';
    }).join('');
  }

  async function load() {
    const seq = ++st.seq;
    $('count').innerHTML = 'Yükleniyor…';
    try {
      const r = await api(`/api/planning/maintenance?${new URLSearchParams({ q: st.q })}`);
      if (seq !== st.seq) return;
      st.types = r.types;
      draw();
    } catch (err) {
      if (seq !== st.seq) return;
      $('count').innerHTML = `Bakım verisi alınamadı: ${escapeHtml(err.message)} <button type="button" class="icon-btn icon-btn-sm" data-act="retry">Yeniden dene</button>`;
    }
  }

  /** Otomatik tik anahtarının şu anki durumu (yalnız yönetici görür/değiştirir). */
  async function loadAutoTick() {
    const box = $('auto-tick');
    if (!box) return;
    try {
      const r = await api('/api/planning/maintenance/auto-tick');
      st.autoTick = r.enabled;
      box.checked = r.enabled;
      box.disabled = false;
    } catch { /* yuklenemedi: kutu devre disi kalir, bir sonraki "load()"da yeniden denenir */ }
  }

  const findAsset = (id) => {
    for (const t of st.types) { const a = t.assets.find((x) => x.id === id); if (a) return { type: t, asset: a }; }
    return null;
  };
  const findItem = (assetId, itemId) => {
    const hit = findAsset(assetId);
    return hit ? { ...hit, item: hit.asset.items.find((x) => x.id === itemId) } : null;
  };

  const search = debounce((value) => { st.q = value.trim(); load(); }, 250);
  host.oninput = (ev) => { if (ev.target.dataset?.role === 'q') search(ev.target.value); };
  host.addEventListener('change', async (ev) => {
    if (ev.target.dataset?.role !== 'auto-tick') return;
    const box = ev.target;
    const next = box.checked;
    box.disabled = true;
    try { await put('/api/planning/maintenance/auto-tick', { enabled: next }); st.autoTick = next; }
    catch (e) { box.checked = !next; window.alert(`Kaydedilemedi: ${e.message}`); }
    box.disabled = false;
  });
  host.addEventListener('toggle', (ev) => {
    const d = ev.target;
    if (d.matches?.('details.mnt-grp')) { const id = Number(d.dataset.type); if (d.open) st.openTypes.add(id); else st.openTypes.delete(id); }
    else if (d.matches?.('details.mnt-asset')) { const id = Number(d.dataset.asset); if (d.open) st.openAssets.add(id); else st.openAssets.delete(id); }
  }, true);
  host.onclick = (ev) => {
    if (ev.target.closest('[data-act="retry"]')) { load(); return; }
    if (ev.target.closest('[data-act="import"]')) { openImportDialog(load); return; }
    if (ev.target.closest('[data-act="new-type"]')) { openTypeCreateDialog(load); return; }
    const newAssetBtn = ev.target.closest('[data-act="new-asset"]');
    if (newAssetBtn) { openAssetDialog(null, st.types, load, { defaultTypeId: newAssetBtn.dataset.type ? Number(newAssetBtn.dataset.type) : null }); return; }
    const editPlanBtn = ev.target.closest('[data-act="edit-plan"]');
    if (editPlanBtn) { const t = st.types.find((x) => x.id === Number(editPlanBtn.dataset.type)); if (t) openTypePlanDialog(t, load); return; }
    const editAssetBtn = ev.target.closest('[data-act="edit-asset"]');
    if (editAssetBtn) { const hit = findAsset(Number(editAssetBtn.dataset.asset)); if (hit) openAssetDialog(hit.asset, st.types, load); return; }
    const tickBtn = ev.target.closest('[data-act="tick"]');
    if (tickBtn) { const hit = findItem(Number(tickBtn.dataset.asset), Number(tickBtn.dataset.item)); if (hit?.item) openTickDialog(hit.asset, hit.item, load); return; }
    const historyBtn = ev.target.closest('[data-act="history"]');
    if (historyBtn) { const hit = findItem(Number(historyBtn.dataset.asset), Number(historyBtn.dataset.item)); if (hit?.item) openHistoryDialog(hit.asset, hit.item); return; }
    const freeLogBtn = ev.target.closest('[data-act="free-log"]');
    if (freeLogBtn) { const hit = findAsset(Number(freeLogBtn.dataset.asset)); if (hit) openFreeLogDialog(hit.asset, freeLogBtn.dataset.kind, load); }
  };
  await load();
  loadAutoTick();
}

/* ============================================================================================== tik at / rutin-arizi */

/** @param {object} asset @param {object} item @param {() => void} onDone */
function openTickDialog(asset, item, onDone) {
  const m = openModal({ title: 'Tik at' });
  let busy = false;
  let error = null;
  function draw() {
    m.body.innerHTML =
      `<p class="pl-wohead"><b>${escapeHtml(assetLabel(asset))}</b> · ${escapeHtml(item.description)} <span class="hint">· ${escapeHtml(periodText(item))}</span></p>` +
      '<form autocomplete="off"><div class="fld-grid">' +
      `<label class="fld"><span>Tarih</span><input name="doneOn" type="date" value="${isoDate(Date.now())}" required${busy ? ' disabled' : ''}></label>` +
      (item.requiresNote !== 'hayir' ? `<label class="fld"><span>Firma</span><input name="company" maxlength="120" autocomplete="off"${busy ? ' disabled' : ''}></label>` : '') +
      '</div>' +
      (item.requiresNote !== 'hayir' ? `<label class="fld"><span>Not</span><textarea name="description" rows="2" maxlength="500"${busy ? ' disabled' : ''}></textarea></label>` : '') +
      (item.requiresNote === 'degisimde' ? `<label class="pl-steps-opt"><input type="checkbox" name="changed"${busy ? ' disabled' : ''}> Değişim/müdahale yapıldı (Rutin Bakım Kaydı'na da düşer)</label>` : '') +
      (error ? `<p class="notice notice-sim">${escapeHtml(error)}</p>` : '') +
      '<div class="dt-actions"><button type="button" class="icon-btn" data-act="close">Kapat</button>' +
      `<button type="submit" class="icon-btn btn-primary"${busy ? ' disabled' : ''}>Tik at</button></div></form>`;
  }
  draw();
  m.body.addEventListener('click', (ev) => { if (ev.target.closest('[data-act="close"]')) m.close(); });
  m.body.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    busy = true; error = null; draw();
    try {
      await post(`/api/planning/maintenance/assets/${asset.id}/logs`, {
        itemId: item.id, doneOn: f.elements.doneOn.value,
        company: f.elements.company?.value, description: f.elements.description?.value, changed: f.elements.changed?.checked,
      });
      onDone(); m.close();
    } catch (e) { error = e.message; busy = false; draw(); }
  });
}

/** @param {object} asset @param {'rutin'|'arizi'} kind @param {() => void} onDone */
function openFreeLogDialog(asset, kind, onDone) {
  const m = openModal({ title: kind === 'rutin' ? 'Rutin bakım kaydı' : 'Arızi bakım kaydı' });
  let error = null;
  function draw() {
    m.body.innerHTML =
      `<p class="pl-wohead"><b>${escapeHtml(assetLabel(asset))}</b></p>` +
      '<form autocomplete="off"><div class="fld-grid">' +
      `<label class="fld"><span>Tarih</span><input name="doneOn" type="date" value="${isoDate(Date.now())}" required></label>` +
      '<label class="fld"><span>Firma</span><input name="company" maxlength="120" autocomplete="off"></label></div>' +
      '<label class="fld"><span>Yapılan işlem</span><textarea name="description" rows="3" maxlength="500"></textarea></label>' +
      (error ? `<p class="notice notice-sim">${escapeHtml(error)}</p>` : '') +
      '<div class="dt-actions"><button type="button" class="icon-btn" data-act="close">Kapat</button>' +
      '<button type="submit" class="icon-btn btn-primary">Kaydet</button></div></form>';
  }
  draw();
  m.body.addEventListener('click', (ev) => { if (ev.target.closest('[data-act="close"]')) m.close(); });
  m.body.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    error = null;
    try {
      await post(`/api/planning/maintenance/assets/${asset.id}/logs`, { kind, doneOn: f.elements.doneOn.value, company: f.elements.company.value, description: f.elements.description.value });
      onDone(); m.close();
    } catch (e) { error = e.message; draw(); }
  });
}

/** @param {object} asset @param {object} item */
async function openHistoryDialog(asset, item) {
  const m = openModal({ title: `Geçmiş · ${item.description}`, wide: true });
  m.body.innerHTML = '<p class="empty">Yükleniyor…</p>';
  try {
    const r = await api(`/api/planning/maintenance/assets/${asset.id}/logs?${new URLSearchParams({ itemId: item.id, limit: 100 })}`);
    m.body.innerHTML = r.items.length === 0 ? '<p class="empty">Hiç tik yok.</p>' :
      '<table class="tbl tbl-pl"><thead><tr><th>Tarih</th><th>Kim</th><th>Firma</th><th>Not</th><th>Değişim</th></tr></thead><tbody>' +
      r.items.map((l) => `<tr><td>${dateText(l.doneOn)}</td><td>${cellText(l.person)}</td><td>${cellText(l.company)}</td><td>${cellText(l.description)}</td><td>${l.changed ? chip('warn', '!', 'evet') : ''}</td></tr>`).join('') +
      '</tbody></table>';
  } catch (e) { m.body.innerHTML = `<p class="notice notice-sim">Alınamadı: ${escapeHtml(e.message)}</p>`; }
  m.body.insertAdjacentHTML('beforeend', '<div class="dt-actions"><button type="button" class="icon-btn" data-act="close">Kapat</button></div>');
  m.body.addEventListener('click', (ev) => { if (ev.target.closest('[data-act="close"]')) m.close(); });
}

/* ============================================================================================== tip / plan (yalniz yonetici) */

/** @param {() => void} onDone */
function openTypeCreateDialog(onDone) {
  const m = openModal({ title: 'Yeni makine tipi' });
  let error = null;
  function draw() {
    m.body.innerHTML =
      '<form autocomplete="off"><div class="fld-grid">' +
      '<label class="fld"><span>Tip adı *</span><input name="name" maxlength="80" required autocomplete="off"></label>' +
      '<label class="fld"><span>Not</span><input name="note" maxlength="500" autocomplete="off"></label></div>' +
      (error ? `<p class="notice notice-sim">${escapeHtml(error)}</p>` : '') +
      '<div class="dt-actions"><button type="button" class="icon-btn" data-act="close">Kapat</button>' +
      '<button type="submit" class="icon-btn btn-primary">Ekle</button></div></form>';
  }
  draw();
  m.body.addEventListener('click', (ev) => { if (ev.target.closest('[data-act="close"]')) m.close(); });
  m.body.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    error = null;
    try {
      await post('/api/planning/maintenance/types', { name: f.elements.name.value, note: f.elements.note.value });
      onDone(); m.close();
    } catch (e) { error = e.message; draw(); }
  });
}

function itemEditForm(it) {
  const id = it ? it.id : 'new';
  const anchors = new Set(it?.anchorMonths ?? []);
  return `<form data-item="${id}" autocomplete="off"><div class="fld-grid">` +
    `<label class="fld"><span>Açıklama *</span><input name="description" maxlength="300" required value="${escapeHtml(it?.description ?? '')}"></label>` +
    `<label class="fld"><span>Sorumlu</span><input name="responsible" maxlength="80" value="${escapeHtml(it?.responsible ?? '')}" placeholder="CNC Operatörü"></label>` +
    `<label class="fld"><span>Birim</span><select name="periodUnit">${Object.entries(UNIT_LABEL).map(([v, l]) => `<option value="${v}"${(it?.periodUnit ?? 'gun') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>` +
    `<label class="fld"><span>Kaç birimde bir</span><input name="periodEvery" inputmode="numeric" value="${it?.periodEvery ?? 1}"></label>` +
    `<label class="fld"><span>Birim içinde kaç kez</span><input name="timesPerPeriod" inputmode="numeric" value="${it?.timesPerPeriod ?? 1}"></label>` +
    `<label class="fld"><span>Kayıt</span><select name="requiresNote">${Object.entries(REQUIRES_LABEL).map(([v, l]) => `<option value="${v}"${(it?.requiresNote ?? 'hayir') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>` +
    `<label class="fld"><span>Zamanlama notu</span><input name="timingNote" maxlength="200" value="${escapeHtml(it?.timingNote ?? '')}" placeholder="Her vardiya başlarken"></label>` +
    `<label class="fld"><span>Durum</span><select name="active"><option value="aktif"${(it?.active ?? 'aktif') === 'aktif' ? ' selected' : ''}>Aktif</option><option value="pasif"${it?.active === 'pasif' ? ' selected' : ''}>Pasif</option></select></label>` +
    '</div><p class="hint">Takvime sabit aylar (yalnız ay/yıl birimi; boş bırakılırsa periyot her zaman son yapılandan sonra sayılır):</p>' +
    `<div class="mnt-months">${MONTH_NAMES.map((name, i) => `<label><input type="checkbox" name="month${i + 1}"${anchors.has(i + 1) ? ' checked' : ''}> ${name}</label>`).join('')}</div>` +
    '<div class="dt-actions">' + (it ? `<button type="button" class="icon-btn" data-act="delete-item" data-item="${it.id}">Sil</button>` : '') +
    `<button type="submit" class="icon-btn btn-primary">${it ? 'Kaydet' : 'Kalemi ekle'}</button></div></form>`;
}

/** @param {object} type @param {() => void} onDone */
function openTypePlanDialog(type, onDone) {
  const m = openModal({ title: `"${type.name}" bakım planı`, wide: true });
  let items = [...type.items].sort((a, b) => a.sortOrder - b.sortOrder);
  let adding = false;
  let error = null;

  function draw() {
    m.body.innerHTML =
      '<p class="hint">Periyotları burada yönetici ayarlar; usta ekranda yalnızca tik atar.</p>' +
      items.map((it) => `<details class="grp"><summary><b>${escapeHtml(it.description)}</b> <span class="hint">· ${escapeHtml(periodText(it))}</span>${it.active === 'pasif' ? ` ${chip('none', '–', 'pasif')}` : ''}</summary><div class="grp-body">${itemEditForm(it)}</div></details>`).join('') +
      (adding ? `<details class="grp" open><summary><b>Yeni kalem</b></summary><div class="grp-body">${itemEditForm(null)}</div></details>` :
        '<div class="dt-actions"><button type="button" class="icon-btn" data-act="add-item">+ Bakım kalemi ekle</button></div>') +
      (error ? `<p class="notice notice-sim">${escapeHtml(error)}</p>` : '') +
      '<div class="dt-actions"><button type="button" class="icon-btn" data-act="close">Kapat</button></div>';
  }
  draw();
  m.body.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-act="close"]')) { m.close(); return; }
    if (ev.target.closest('[data-act="add-item"]')) { adding = true; draw(); return; }
    const delBtn = ev.target.closest('[data-act="delete-item"]');
    if (delBtn) {
      const id = Number(delBtn.dataset.item);
      const it = items.find((x) => x.id === id);
      if (!it || !window.confirm(`"${it.description}" silinsin mi?`)) return;
      del(`/api/planning/maintenance/items/${id}`).then(() => { items = items.filter((x) => x.id !== id); onDone(); draw(); }).catch((e) => { error = e.message; draw(); });
    }
  });
  m.body.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const id = f.dataset.item;
    error = null;
    const anchorMonths = Array.from({ length: 12 }, (_, i) => i + 1).filter((n) => f.elements[`month${n}`].checked);
    const body = {
      description: f.elements.description.value, responsible: f.elements.responsible.value,
      periodUnit: f.elements.periodUnit.value, periodEvery: f.elements.periodEvery.value,
      timesPerPeriod: f.elements.timesPerPeriod.value, requiresNote: f.elements.requiresNote.value,
      timingNote: f.elements.timingNote.value, active: f.elements.active.value,
      anchorMonths: anchorMonths.length ? anchorMonths : null,
    };
    try {
      if (id === 'new') { const created = await post(`/api/planning/maintenance/types/${type.id}/items`, body); items.push(created); adding = false; }
      else { const updated = await put(`/api/planning/maintenance/items/${id}`, body); items = items.map((x) => (x.id === updated.id ? updated : x)); }
      onDone(); draw();
    } catch (e) { error = e.message; draw(); }
  });
}

/* ============================================================================================== makine (asset) */

/** @param {object|null} asset @param {object[]} types @param {() => void} onDone */
function openAssetDialog(asset, types, onDone, { defaultTypeId = null } = {}) {
  const editable = isAdminRole();
  const m = openModal({ title: asset ? 'Makine' : 'Yeni makine', wide: true });
  let a = asset;
  let error = null;
  const v = (k) => (a ? a[k] : null);
  function draw() {
    m.body.innerHTML =
      (a ? `<p class="pl-wohead"><b>${escapeHtml(assetLabel(a))}</b></p>` : '') +
      '<form autocomplete="off"><div class="fld-grid">' +
      `<label class="fld"><span>Makine tipi *</span><select name="typeId" required${editable ? '' : ' disabled'}>` +
      types.map((t) => `<option value="${t.id}"${(v('typeId') ?? defaultTypeId) === t.id ? ' selected' : ''}>${escapeHtml(t.name)}</option>`).join('') + '</select></label>' +
      `<label class="fld"><span>Sicil no</span><input name="sicilNo" maxlength="40" value="${escapeHtml(v('sicilNo') ?? '')}" autocomplete="off"${editable ? '' : ' readonly'}></label>` +
      `<label class="fld"><span>Makine numarası</span><input name="assetNo" maxlength="40" value="${escapeHtml(v('assetNo') ?? '')}" autocomplete="off"${editable ? '' : ' readonly'}></label>` +
      `<label class="fld"><span>Marka</span><input name="brand" maxlength="80" value="${escapeHtml(v('brand') ?? '')}" autocomplete="off"${editable ? '' : ' readonly'}></label>` +
      `<label class="fld"><span>Model</span><input name="model" maxlength="80" value="${escapeHtml(v('model') ?? '')}" autocomplete="off"${editable ? '' : ' readonly'}></label>` +
      `<label class="fld"><span>Motor gücü (KW)</span><input name="motorPowerKw" inputmode="decimal" value="${v('motorPowerKw') ?? ''}" autocomplete="off"${editable ? '' : ' readonly'}></label>` +
      `<label class="fld"><span>Satınalma tarihi/notu</span><input name="purchaseNote" maxlength="80" value="${escapeHtml(v('purchaseNote') ?? '')}" autocomplete="off"${editable ? '' : ' readonly'}></label>` +
      `<label class="fld"><span>CNC makine kimliği</span><input name="cncMachineId" maxlength="20" value="${escapeHtml(v('cncMachineId') ?? '')}" placeholder="CNC-05 (isteğe bağlı)" autocomplete="off"${editable ? '' : ' readonly'}></label>` +
      `<label class="fld"><span>Durum</span><select name="active"${editable ? '' : ' disabled'}><option value="aktif"${v('active') !== 'pasif' ? ' selected' : ''}>Aktif</option><option value="pasif"${v('active') === 'pasif' ? ' selected' : ''}>Pasif</option></select></label>` +
      '</div>' +
      `<label class="fld"><span>Not</span><textarea name="note" rows="2" maxlength="1000"${editable ? '' : ' readonly'}>${escapeHtml(v('note') ?? '')}</textarea></label>` +
      (error ? `<p class="notice notice-sim">${escapeHtml(error)}</p>` : '') +
      '<div class="dt-actions">' +
      (editable && a ? '<button type="button" class="icon-btn" data-act="delete">Sil…</button>' : '') +
      '<button type="button" class="icon-btn" data-act="close">Kapat</button>' +
      (editable ? `<button type="submit" class="icon-btn btn-primary">${a ? 'Kaydet' : 'Makineyi ekle'}</button>` : '') +
      '</div></form>';
  }
  draw();
  m.body.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-act="close"]')) { m.close(); return; }
    if (ev.target.closest('[data-act="delete"]')) {
      if (!window.confirm(`"${assetLabel(a)}" silinsin mi?`)) return;
      del(`/api/planning/maintenance/assets/${a.id}`).then(() => { onDone(); m.close(); }).catch((e) => { error = e.message; draw(); });
    }
  });
  m.body.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    error = null;
    try {
      const body = {
        typeId: Number(f.elements.typeId.value), sicilNo: f.elements.sicilNo.value, assetNo: f.elements.assetNo.value,
        brand: f.elements.brand.value, model: f.elements.model.value, motorPowerKw: f.elements.motorPowerKw.value,
        purchaseNote: f.elements.purchaseNote.value, cncMachineId: f.elements.cncMachineId.value,
        active: f.elements.active.value, note: f.elements.note.value,
      };
      a = a ? await put(`/api/planning/maintenance/assets/${a.id}`, body) : await post('/api/planning/maintenance/assets', body);
      onDone(); draw();
    } catch (e) { error = e.message; draw(); }
  });
}

/* ============================================================================================== Excel'den ilk sefer icin iceri aktarma */

/** Setup kurulumunda İLK SEFER için: gerçek Bakım Sicil Kartları Excel'ini yükler. Yalnız yönetici (uç de kayıtsız → admin). */
function openImportDialog(onDone) {
  const m = openModal({ title: 'Excel\'den içeri aktar (Bakım Sicil Kartları)' });
  let busy = false;
  let error = null;
  let result = null;
  function draw() {
    m.body.innerHTML =
      '<p class="hint">Bakım Sicil Kartları Excel\'ini seçin (her sayfa bir makine). Bu, kurulumdan sonra İLK SEFER için mevcut hâli aktarır; ' +
      'sicil no zaten kayıtlıysa o sayfa atlanır — iki kez yüklemek güvenlidir.</p>' +
      `<input type="file" accept=".xlsx" data-role="file"${busy ? ' disabled' : ''}>` +
      (error ? `<p class="notice notice-sim">${escapeHtml(error)}</p>` : '') +
      (result ? `<p class="notice">${fmtNum(result.addedAssets)} makine, ${fmtNum(result.addedTypes)} yeni tip eklendi, ${fmtNum(result.skipped)} sayfa atlandı (${fmtNum(result.totalSheets)} sayfa okundu).` +
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
      result = await api('/api/planning/maintenance/import', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: await file.arrayBuffer() });
    } catch (e) { error = e.message; } finally { busy = false; draw(); }
  });
}
