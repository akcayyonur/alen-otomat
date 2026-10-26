/**
 * Planlama > Is emirleri: liste, yeni is emri (siparis -> satir -> urun), duzenleme/iptal, yazdirilabilir form.
 *
 * Akis (kullanici tarifi): musteri siparis no ile siparisi bul -> siparisteki urun satirlarindan birini sec -> urun karti degerleri
 * (hammadde, gramaj, sure) otomatik gelir -> hedef adet, termin, tezgah (1-8), numune adedi gir -> kaydet, formu yazdir.
 * Is emrine urun degerleri KOPYALANIR (kart sonradan degisse is emri degismez). Yalniz yonetici.
 */
import { escapeHtml } from './format.js';
import { api, post } from './lib-common.js';
import {
  put, cellText, fmtNum, dateText, dateTimeText, debounce, openModal, parseInput, gramToKg, chip,
  rawMaterial, plannedHours, isoDate, fmtDec, woStatusChip, isAdminRole, truncCell,
} from './planning-common.js';
import { openWorkOrderForm } from './planning-wo-form.js';
import { openProductDialog } from './planning-products.js';
import { progressHtml, openStartDialog, openFinishDialog } from './planning-production.js';
import { cratesHtml, openCrateCard, openIssueCard } from './planning-card.js';
import { openMeasureDialog, openMeasureSheet, openMeasurePlanDialog } from './planning-measure.js';
import { openGkkPicker } from './planning-gkk.js';
import { createFirstApproval } from './planning-approvals.js';
import { drawingsEditorHtml, wireDrawings } from './planning-drawings.js';
import { materialPanelHtml } from './planning-material.js';
import { openFormDialog } from './auth-view.js';

const machineOptions = (machines, selected = '', blank = '— seçin —') =>
  `<option value="">${blank}</option>` + machines.map((m) =>
    `<option value="${escapeHtml(m.id)}"${m.id === selected ? ' selected' : ''}>${escapeHtml(m.id)}${m.name && m.name !== m.id ? ` · ${escapeHtml(m.name)}` : ''}</option>`).join('');
const gramInput = (kg) => (kg === null || kg === undefined ? '' : String(Number((kg * 1000).toFixed(4))).replace('.', ','));
const EVENT_LABEL = Object.freeze({
  olusturuldu: 'oluşturuldu', guncellendi: 'güncellendi', iptal: 'iptal edildi', baslatildi: 'üretime başlatıldı', bitirildi: 'bitirildi', 'yeniden-acildi': 'üretime geri alındı',
  'kart-basildi': 'ürün tanıtım kartı basıldı', 'olcu-kontrol': 'ölçü kontrolü girildi', 'olcu-plani': 'ölçü planı güncellendi', 'kasa-acildi': 'kasa açıldı', 'kasa-kapandi': 'kasa kapandı', 'kasa-paketlendi': 'kasa paketlendi', 'kasa-iptal': 'kasa iptal edildi',
  'fis-girildi': 'Mikro fişi girildi', 'fis-geri-alindi': 'Mikro fişi işareti geri alındı',
  'cizim-eklendi': 'teknik resim eklendi', 'cizim-silindi': 'teknik resim kaldırıldı',
  'hammadde-ayrildi': 'hammadde ayrıldı', 'hammadde-tuketildi': 'hammadde tüketildi', 'hammadde-serbest-birakildi': 'hammadde serbest bırakıldı', 'hammadde-tekrar-ayrildi': 'hammadde yeniden ayrıldı',
});

/** Ölçü satırlarının tek satırlık özeti ("3 ölçü: Ø34,2 · Boy 14 · Ø30,8"). */
const planSummary = (w) => (w.measurePlan?.length
  ? `${w.measurePlan.length} ölçü: ${escapeHtml(w.measurePlan.map((r) => r.label).join(' · '))}`
  : 'Ölçü satırları tanımlı değil. Ürüne göre 3, 5 ... ölçü tanımlanır; tanımlanınca Tezgah başında saatlik ölçüm girilir.');
const decInput = (v) => (v === null || v === undefined ? '' : String(v).replace('.', ','));

/* ============================================================ liste */

/** @param {HTMLElement} host */
export async function renderWorkOrders(host) {
  const canEdit = isAdminRole(); // izleyici (viewer) yalniz listeyi ve formu gorur
  const st = { q: '', status: 'aktif', machine: '', items: [], total: 0, seq: 0, machines: [] };
  host.innerHTML =
    '<div class="pl-bar"><input type="search" class="pl-search" data-role="q" placeholder="İş emri no, ürün, müşteri sipariş no ara…" aria-label="İş emri ara">' +
    '<label class="fld-inline">Durum <select data-role="status"><option value="aktif">Aktif (planlandı + üretimde)</option><option value="uretimde">Üretimde</option><option value="planlandi">Planlandı</option><option value="bitti">Biten</option><option value="iptal">İptal edilenler</option><option value="tumu">Tümü</option></select></label>' +
    '<label class="fld-inline">Tezgah <select data-role="machine"><option value="">Tümü</option></select></label>' +
    (canEdit ? '<button type="button" class="icon-btn btn-primary" data-act="new">Yeni iş emri</button>' : '') + '</div>' +
    '<p class="hint" data-role="count"></p>' +
    '<div class="table-wrap table-wrap-tall" data-role="list"></div>' +
    '<p class="pl-more" data-role="more" hidden><button type="button" class="icon-btn" data-act="more">Daha fazla göster</button></p>';
  const $ = (r) => host.querySelector(`[data-role="${r}"]`);

  function draw() {
    $('count').textContent = st.total === 0
      ? (st.q || st.machine || st.status !== 'aktif' ? 'Eşleşen iş emri yok.' : `Henüz iş emri yok.${canEdit ? ' "Yeni iş emri" ile siparişten bir ürün seçip oluşturun (ya da Siparişler sekmesindeki satırdan).' : ''}`)
      : `${fmtNum(st.total)} iş emri${st.items.length < st.total ? ` (ilk ${fmtNum(st.items.length)} gösteriliyor)` : ''}`;
    $('list').innerHTML = st.items.length === 0 ? '' :
      '<table class="tbl tbl-pl"><thead><tr><th>İş emri no</th><th>Ürün</th><th>Müşteri sip. no</th><th>Tezgah</th>' +
      '<th class="num">Hedef</th><th class="num">Üretilen</th><th>Termin</th><th>Durum</th>' + (canEdit ? '<th></th>' : '') + '</tr></thead><tbody>' +
      st.items.map((w) => {
        const no = escapeHtml(w.no);
        const btn = (act, label) => `<button type="button" class="icon-btn icon-btn-sm" data-act="${act}" data-no="${no}">${label}</button> `;
        return `<tr class="pl-row${w.status === 'iptal' ? ' pl-cancelled' : ''}${w.status === 'uretimde' ? ' pl-running' : ''}" data-no="${no}" tabindex="0">` +
          `<td class="mono"><b>${no}</b></td>` +
          `<td class="trunc"${truncCell(w.productName)}><span class="mono"><b>${escapeHtml(w.stockCode)}</b></span> ${cellText(w.productName)}</td><td class="mono trunc"${truncCell(w.custOrderNo)}>${cellText(w.custOrderNo)}</td>` +
          `<td class="mono">${w.machineId ? escapeHtml(w.machineId) : '<span class="is-null" title="Tezgah başlatırken seçilir">atanmadı</span>'}</td><td class="num">${fmtNum(w.targetQty)}</td>` +
          `<td class="num">${w.produced == null ? cellText(null) : `${fmtNum(w.produced)} <small class="hint">%${fmtDec(w.pct ?? 0, 0)}</small>`}</td>` +
          `<td>${dateText(w.dueDate)}</td><td>${woStatusChip(w.status)}</td>` +
          (canEdit ? `<td class="nowrap">${w.status === 'planlandi' ? btn('start', 'Başlat') : ''}${w.status === 'uretimde' ? btn('finish', 'Bitir') : ''}${btn('edit', 'Düzenle')}</td></tr>` : '</tr>');
      }).join('') +
      '</tbody></table>';
    $('more').hidden = st.items.length >= st.total;
  }

  async function load(reset) {
    const seq = ++st.seq;
    const offset = reset ? 0 : st.items.length;
    try {
      const r = await api(`/api/planning/work-orders?${new URLSearchParams({ q: st.q, status: st.status, machine: st.machine, limit: 100, offset })}`);
      if (seq !== st.seq) return;
      st.total = r.total;
      st.items = reset ? r.items : [...st.items, ...r.items];
      draw();
    } catch (err) {
      if (seq === st.seq) $('count').textContent = `İş emirleri alınamadı: ${err.message}`;
    }
  }

  try {
    st.machines = (await api('/api/planning/summary')).machines;
    $('machine').innerHTML = '<option value="">Tümü</option>' + st.machines.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.id)}</option>`).join('');
  } catch { /* tezgah süzgeci olmadan da çalışır */ }

  const search = debounce((value) => { st.q = value.trim(); load(true); }, 250);
  host.oninput = (ev) => { if (ev.target.dataset?.role === 'q') search(ev.target.value); };
  host.onchange = (ev) => {
    const role = ev.target.dataset?.role;
    if (role === 'status') { st.status = ev.target.value; load(true); }
    else if (role === 'machine') { st.machine = ev.target.value; load(true); }
  };
  // Satıra basınca FORM açılır (arka sayfada teknik resimler); "Düzenle" düğmesi (yönetici) iş emrini düzenler.
  const edit = (no) => openWorkOrderDialog(no, () => load(true));
  const open = (ev) => {
    const e = ev.target.closest?.('[data-act="edit"]');
    if (e) { ev.stopPropagation(); edit(e.dataset.no); return true; }
    const row = ev.target.closest?.('.pl-row');
    if (row) { openWorkOrderForm(row.dataset.no, canEdit ? { onEdit: () => edit(row.dataset.no) } : {}); return true; }
    return false;
  };
  host.onclick = (ev) => {
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (act === 'new') return openNewWorkOrder({}, () => load(true));
    if (act === 'more') return load(false);
    const b = ev.target.closest('[data-act="start"], [data-act="finish"]');
    if (b) { ev.stopPropagation(); (b.dataset.act === 'start' ? openStartDialog : openFinishDialog)(b.dataset.no, () => load(true)); return; }
    open(ev);
  };
  host.onkeydown = (ev) => { if (ev.key === 'Enter') open(ev); };
  load(true);
}

/* ===================================================== yeni is emri */

/** Numara tabani bilinmiyorsa (Excel'den gelen yok, hic is emri yok) uyar ve ayarlatir: Excel ile numara cakismasin. */
function sequenceNotice(meta) {
  const n = meta.nextWorkOrder;
  if (n.floor > 0 || n.max > 0) return `<p class="hint">Sıradaki iş emri numarası: <b class="mono">${escapeHtml(n.no)}</b>.</p>`;
  return '<div class="notice notice-sim" data-role="seq-notice"><b>Numara tabanı bilinmiyor.</b> Excel\'de en son verilen iş emri numarası nedir? ' +
    `Girmezseniz numaralar <span class="mono">${escapeHtml(n.no)}</span>'dan başlar ve Excel'dekilerle çakışabilir (iş emirleri listesini CSV olarak içeri almak bunu kendiliğinden ayarlar).` +
    '<div class="pl-seq"><input type="text" inputmode="numeric" maxlength="10" data-role="seq-last" placeholder="ör. 2026001109" aria-label="En son verilen iş emri numarası">' +
    '<button type="button" class="icon-btn" data-act="seq-set">Ayarla</button></div><p class="notice notice-sim" data-role="seq-err" hidden></p></div>';
}

/**
 * @param {{line?: object}} [opts] line: siparis satiri (Siparisler sekmesinden gelirse dogrudan forma gecilir)
 * @param {(w: object) => void} [onDone]
 */
export async function openNewWorkOrder({ line = null } = {}, onDone = () => {}) {
  const m = openModal({ title: 'Yeni iş emri', wide: true });
  m.body.innerHTML = '<p class="empty">Yükleniyor…</p>';
  let meta;
  try {
    meta = await api('/api/planning/summary');
  } catch (err) {
    m.body.innerHTML = `<p class="notice notice-sim">Alınamadı: ${escapeHtml(err.message)}</p>`;
    return;
  }
  const st = { mode: 'siparis', openOnly: true, orders: [], lines: null, orderTitle: '', line, stockCode: line?.stockCode ?? null, product: null, seq: 0 };

  /* ---- 1. adim: siparis / urun sec ---- */
  function drawPick() {
    m.body.innerHTML =
      `<div class="seg" role="group" aria-label="Kaynak"><button type="button" data-mode="siparis" aria-pressed="${st.mode === 'siparis'}"${st.mode === 'siparis' ? ' class="is-on"' : ''}>Siparişten</button>` +
      `<button type="button" data-mode="urun" aria-pressed="${st.mode === 'urun'}"${st.mode === 'urun' ? ' class="is-on"' : ''}>Siparişsiz (ürün seç)</button></div>` +
      (st.mode === 'siparis'
        ? '<div class="pl-bar"><input type="search" class="pl-search" data-role="pq" placeholder="Müşteri sipariş no, evrak no, müşteri ya da ürün ara…" aria-label="Sipariş ara">' +
          `<label class="chk"><input type="checkbox" data-role="open"${st.openOnly ? ' checked' : ''}> yalnız açık</label></div>` +
          '<div class="table-wrap pl-pick" data-role="orders"></div><div data-role="lines"></div>'
        : '<input type="search" class="pl-search" data-role="pq" placeholder="Stok kodu, ürün adı ya da müşteri kodu…" aria-label="Ürün ara">' +
          '<div class="pl-picker" data-role="orders"></div>') +
      sequenceNotice(meta);
    m.body.querySelector('[data-role="pq"]').focus();
    runSearch();
  }

  async function runSearch() {
    const my = ++st.seq;
    const q = m.body.querySelector('[data-role="pq"]')?.value.trim() ?? '';
    const box = m.body.querySelector('[data-role="orders"]');
    if (!box) return;
    try {
      if (st.mode === 'siparis') {
        const r = await api(`/api/planning/orders?${new URLSearchParams({ q, ...(st.openOnly ? { open: '1' } : {}), limit: 50 })}`);
        if (my !== st.seq) return;
        st.orders = r.orders;
        box.innerHTML = r.orders.length === 0 ? '<p class="empty">Eşleşen sipariş yok.</p>' :
          '<table class="tbl tbl-pl"><thead><tr><th>Müşteri</th><th>Müşteri sip. no</th><th>Evrak no</th><th>Tarih</th><th class="num">Satır</th><th class="num">Açık</th></tr></thead><tbody>' +
          r.orders.map((o, i) => `<tr class="pl-row" data-i="${i}" tabindex="0"><td class="trunc"${truncCell(o.customer)}>${cellText(o.customer)}</td><td class="mono"><b>${cellText(o.custOrderNo)}</b></td>` +
            `<td class="mono">${cellText(o.docNo)}</td><td>${dateText(o.orderDate)}</td><td class="num">${fmtNum(o.lineCount)}</td><td class="num">${o.openQty > 0 ? `<b>${fmtNum(o.openQty)}</b>` : '0'}</td></tr>`).join('') +
          '</tbody></table>';
      } else {
        if (q === '') { box.innerHTML = '<p class="empty">Aramaya başlayın.</p>'; return; }
        const r = await api(`/api/planning/products?${new URLSearchParams({ q, limit: 30 })}`);
        if (my !== st.seq) return;
        box.innerHTML = r.items.length === 0 ? '<p class="empty">Eşleşen ürün yok. Önce Ürünler sekmesinden kartı açın.</p>' :
          '<table class="tbl"><tbody>' + r.items.map((p) => `<tr class="pl-row" data-code="${escapeHtml(p.stockCode)}" tabindex="0"><td class="mono"><b>${escapeHtml(p.stockCode)}</b></td><td>${cellText(p.name)}</td><td class="mono">${cellText(p.customerCode)}</td></tr>`).join('') + '</tbody></table>';
      }
    } catch (err) {
      if (my === st.seq) box.innerHTML = `<p class="notice notice-sim">${escapeHtml(err.message)}</p>`;
    }
  }

  async function showLines(o) {
    const box = m.body.querySelector('[data-role="lines"]');
    box.innerHTML = '<p class="empty">Satırlar yükleniyor…</p>';
    try {
      const { lines } = await api(`/api/planning/orders/lines?${new URLSearchParams({ customerKey: o.customerKey, custOrderKey: o.custOrderKey, docKey: o.docKey })}`);
      st.lines = lines;
      st.orderTitle = `${o.customer || '—'} · müşteri sip. no ${o.custOrderNo || '—'} · evrak ${o.docNo || '—'}`;
      box.innerHTML =
        `<h4 class="sub">${escapeHtml(st.orderTitle)} — iş emri açılacak ürünü seçin</h4>` +
        '<div class="table-wrap"><table class="tbl tbl-pl"><thead><tr><th>Ürün kodu</th><th>Ürün adı</th><th class="num">Sipariş</th><th class="num">Kalan</th><th class="num">İş emrinde</th><th class="num">Planlanmamış</th><th>Ürün kartı</th></tr></thead><tbody>' +
        lines.map((l, i) =>
          `<tr class="${l.hasProduct ? 'pl-row' : 'pl-disabled'}" data-line="${i}"${l.hasProduct ? ' tabindex="0"' : ''}><td class="mono"><b>${escapeHtml(l.stockCode)}</b></td><td class="trunc"${truncCell(l.itemName)}>${cellText(l.itemName)}</td>` +
          `<td class="num">${fmtNum(l.qty)}</td><td class="num">${fmtNum(l.remaining)}</td><td class="num">${fmtNum(l.planned)}</td><td class="num">${l.unplanned > 0 ? `<b>${fmtNum(l.unplanned)}</b>` : '0'}</td>` +
          `<td>${l.hasProduct ? chip('ok', '✓', 'var') : chip('none', '✕', 'yok (ürün değil ya da kart açılmamış)')}</td></tr>`).join('') + '</tbody></table></div>';
    } catch (err) {
      box.innerHTML = `<p class="notice notice-sim">${escapeHtml(err.message)}</p>`;
    }
  }

  /* ---- 2. adim: is emri bilgileri ---- */
  async function drawForm() {
    m.body.innerHTML = '<p class="empty">Ürün kartı yükleniyor…</p>';
    try {
      st.product = await api(`/api/planning/products/${encodeURIComponent(st.stockCode)}`);
    } catch (err) {
      m.body.innerHTML = `<p class="notice notice-sim">Ürün kartı alınamadı: ${escapeHtml(err.message)}</p><div class="dt-actions"><button type="button" class="icon-btn" data-act="back">Geri</button></div>`;
      return;
    }
    const p = st.product;
    const l = st.line;
    const defaultQty = l && l.unplanned > 0 ? l.unplanned : ''; // zaten tamami is emrinde olan satirda adet bos: yanlislikla ikinci kez planlanmasin
    const missing = [];
    if (!p.material) missing.push('hammadde');
    if (p.grossKg == null) missing.push('brüt ağırlık');
    if (p.lengthMm == null) missing.push('tam boy');
    if (p.plannedSec == null) missing.push('planlanan süre');
    m.body.innerHTML =
      '<form autocomplete="off" data-role="wo-form">' +
      (l ? `<p class="notice"><b>Sipariş:</b> ${escapeHtml(l.customer || '')} · müşteri sip. no <b class="mono">${escapeHtml(l.custOrderNo || '—')}</b> · evrak ${escapeHtml(l.docNo || '—')} · ` +
        `sipariş ${fmtNum(l.qty)}, kalan ${fmtNum(l.remaining)}, iş emrinde ${fmtNum(l.planned)}, <b>planlanmamış ${fmtNum(l.unplanned)}</b></p>` : '<p class="notice">Siparişsiz iş emri (stok üretimi / numune).</p>') +
      `<h4 class="sub">Ürün · <span class="mono">${escapeHtml(p.stockCode)}</span> ${escapeHtml(p.name ?? '')}</h4>` +
      '<div class="pl-snap">' +
      `<span>Hammadde <b class="mono">${cellText(p.material)}</b></span><span>Alternatif <b class="mono">${cellText(p.altMaterial)}</b></span><span>Tam boy <b>${p.lengthMm == null ? '—' : `${fmtDec(p.lengthMm, 1)} mm`}</b></span>` +
      `<span>Net <b>${p.netKg == null ? '—' : `${fmtDec(p.netKg * 1000)} g`}</b></span><span>Brüt <b>${p.grossKg == null ? '—' : `${fmtDec(p.grossKg * 1000)} g`}</b></span><span>Planlanan <b>${p.plannedSec == null ? '—' : `${fmtDec(p.plannedSec, 1)} sn`}</b></span></div>` +
      (missing.length > 0 ? `<p class="notice notice-sim">Ürün kartında eksik: <b>${escapeHtml(missing.join(', '))}</b>. İş emri yine açılabilir, ama ilgili hesaplar boş kalır. ` +
        '<button type="button" class="icon-btn icon-btn-sm" data-act="card">Ürün kartını aç</button></p>' : '<p class="hint">Bu değerler iş emrine kopyalanır; kart sonradan değişse iş emri değişmez.</p>') +
      '<div class="fld-grid">' +
      `<label class="fld"><span>Hedef adet</span><input name="targetQty" inputmode="numeric" required value="${escapeHtml(String(defaultQty))}"></label>` +
      `<label class="fld"><span>Termin</span><input name="dueDate" type="date" value="${escapeHtml(isoDate(l?.dueDate))}"></label>` +
      `<label class="fld"><span>Tezgah (isteğe bağlı: başlatırken de seçilir)</span><select name="machineId">${machineOptions(meta.machines, '', '— sonra seçilecek —')}</select></label>` +
      `<label class="fld"><span>Alternatif hammadde (isteğe bağlı)</span><input name="altMaterial" maxlength="80" value="${escapeHtml(p.altMaterial ?? '')}" placeholder="yoksa boş"></label>` +
      '<label class="fld"><span>Numune adedi (isteğe bağlı)</span><input name="sampleQty" inputmode="numeric" placeholder="numune yapılmayacaksa boş"></label>' +
      '<label class="fld pl-wide"><span>Açıklama</span><input name="note" maxlength="500"></label></div>' +
      '<p class="hint" data-role="calc"></p>' +
      '<p class="notice notice-sim" data-role="err" hidden></p>' +
      `<div class="dt-actions">${l || st.mode === 'urun' ? '<button type="button" class="icon-btn" data-act="back">Geri</button>' : ''}<button type="submit" class="icon-btn btn-primary">İş emrini oluştur</button></div></form>` +
      sequenceNotice(meta);
    const form = m.body.querySelector('form');
    const calc = () => {
      const qty = Number(String(form.elements.targetQty.value).replace(/\./g, '').replace(',', '.'));
      const h = plannedHours(qty, p.plannedSec);
      const r = rawMaterial({ qty, grossKg: p.grossKg, lengthMm: p.lengthMm });
      const parts = [];
      if (h !== null) parts.push(`planlanan süre ${fmtDec(h)} saat`);
      if (r.kg !== null) parts.push(`hammadde ${fmtDec(r.kg)} kg`);
      if (r.bars !== null) parts.push(`${fmtDec(r.bars)} çubuk`);
      m.body.querySelector('[data-role="calc"]').textContent = parts.length ? `Hesap: ${parts.join(' · ')}` : '';
    };
    form.addEventListener('input', calc);
    calc();
    form.elements.targetQty.focus();

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const err = m.body.querySelector('[data-role="err"]');
      const btn = form.querySelector('[type="submit"]');
      err.hidden = true;
      btn.disabled = true;
      const num = (v) => (String(v).trim() === '' ? null : Number(String(v).replace(/\./g, '').replace(',', '.')));
      try {
        const w = await post('/api/planning/work-orders', {
          ...(l ? { lineId: l.id } : { stockCode: p.stockCode }),
          targetQty: num(form.elements.targetQty.value) ?? '', machineId: form.elements.machineId.value, altMaterial: form.elements.altMaterial.value,
          dueDate: form.elements.dueDate.value || null, sampleQty: num(form.elements.sampleQty.value), note: form.elements.note.value,
        });
        drawDone(w);
        onDone(w);
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
        btn.disabled = false;
      }
    });
  }

  function drawDone(w) {
    m.body.innerHTML =
      `<div class="notice"><b>İş emri oluşturuldu: <span class="mono">${escapeHtml(w.no)}</span></b> · ${escapeHtml(w.stockCode)} · ${fmtNum(w.targetQty)} adet · ${w.machineId ? escapeHtml(w.machineId) : 'tezgah atanmadı (başlatırken seçilir)'}</div>` +
      (w.warnings?.length ? `<ul class="checks">${w.warnings.map((x) => `<li class="check check-warn"><span class="check-ic" aria-hidden="true">▲</span><div>${escapeHtml(x)}</div></li>`).join('')}</ul>` : '') +
      '<div class="dt-actions"><button type="button" class="icon-btn btn-primary" data-act="open-form">Formu aç / yazdır</button><button type="button" class="icon-btn" data-act="close">Kapat</button></div>';
    m.body.querySelector('[data-act="open-form"]').addEventListener('click', () => { m.close(); openWorkOrderForm(w.no, { onEdit: () => openWorkOrderDialog(w.no, onDone) }); });
  }

  /* ---- olaylar ---- */
  m.body.addEventListener('click', async (ev) => {
    const mode = ev.target.closest('[data-mode]')?.dataset.mode;
    if (mode && mode !== st.mode) { st.mode = mode; st.lines = null; drawPick(); return; }
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (act === 'back') { st.line = null; st.stockCode = null; drawPick(); return; }
    if (act === 'card') { openProductDialog(st.stockCode, () => drawForm()); return; }
    if (act === 'seq-set') {
      const last = m.body.querySelector('[data-role="seq-last"]').value.trim();
      const err = m.body.querySelector('[data-role="seq-err"]');
      try {
        await put('/api/planning/work-orders/sequence', { last });
        meta = await api('/api/planning/summary');
        if (st.stockCode) drawForm(); else drawPick();
      } catch (e) { err.textContent = e.message; err.hidden = false; }
      return;
    }
    const row = ev.target.closest('.pl-row');
    if (!row) return;
    if (row.dataset.i !== undefined && st.mode === 'siparis') { showLines(st.orders[Number(row.dataset.i)]); return; }
    if (row.dataset.line !== undefined) { st.line = st.lines[Number(row.dataset.line)]; st.stockCode = st.line.stockCode; drawForm(); return; }
    if (row.dataset.code !== undefined) { st.line = null; st.stockCode = row.dataset.code; drawForm(); }
  });
  m.body.addEventListener('input', (ev) => { if (ev.target.dataset?.role === 'pq') debounced(); });
  m.body.addEventListener('change', (ev) => { if (ev.target.dataset?.role === 'open') { st.openOnly = ev.target.checked; runSearch(); } });
  const debounced = debounce(runSearch, 250);

  if (line) drawForm(); else drawPick();
}

/* ============================================= is emri ayrintisi / duzenleme */

export async function openWorkOrderDialog(no, onChanged = () => {}) {
  const m = openModal({ title: `İş emri · ${no}`, wide: true });
  m.body.innerHTML = '<p class="empty">Yükleniyor…</p>';
  let meta;
  let w;
  try {
    [meta, w] = await Promise.all([api('/api/planning/summary'), api(`/api/planning/work-orders/${encodeURIComponent(no)}`)]);
  } catch (err) {
    m.body.innerHTML = `<p class="notice notice-sim">Alınamadı: ${escapeHtml(err.message)}</p>`;
    return;
  }
  function draw() {
    // iptal edilince ayni pencere yeniden cizilir: salt okunur bayragi her cizimde w.status'tan hesaplanir
    const ro = w.status === 'iptal';
    const dis = ro ? ' disabled' : '';
    const lockMachine = ro || w.status !== 'planlandi'; // baslamis is emrinin tezgahi sabit: adet o tezgahin sayacindan sayiliyor
    const canCancel = w.status === 'planlandi' || w.status === 'uretimde';
    const input = (name, label, value, extra = '') => `<label class="fld"><span>${escapeHtml(label)}</span><input name="${name}" value="${escapeHtml(value ?? '')}" autocomplete="off"${dis}${extra}></label>`;
    m.body.innerHTML =
      `<p class="pl-wohead">${woStatusChip(w.status)} <b class="mono">${escapeHtml(w.no)}</b> · ${escapeHtml(w.stockCode)} ${escapeHtml(w.productName ?? '')} · oluşturan ${escapeHtml(w.createdBy ?? '—')}, ${escapeHtml(dateTimeText(w.createdAt))}</p>` +
      (ro ? `<p class="notice notice-sim"><b>İptal edildi</b> (${escapeHtml(dateTimeText(w.cancelledAt))}): ${escapeHtml(w.cancelReason ?? '')}</p>` : '') +
      (w.line ? `<p class="notice"><b>Sipariş:</b> ${escapeHtml(w.customer)} · müşteri sip. no <b class="mono">${escapeHtml(w.custOrderNo || '—')}</b> · evrak ${escapeHtml(w.docNo || '—')} · satır: sipariş ${fmtNum(w.line.qty)}, kalan ${fmtNum(w.line.remaining)}, iş emrinde ${fmtNum(w.line.planned)}, planlanmamış ${fmtNum(w.line.unplanned)}</p>` : '<p class="notice">Siparişsiz iş emri.</p>') +
      `<p class="hint" data-role="calc">${[w.plannedHours !== null ? `planlanan süre ${fmtDec(w.plannedHours)} saat` : null, w.rawKg !== null ? `hammadde ${fmtDec(w.rawKg)} kg` : null, w.bars !== null ? `${fmtDec(w.bars)} çubuk` : null].filter(Boolean).join(' · ')}</p>` +
      progressHtml(w) + materialPanelHtml(w) + cratesHtml(w) +
      '<form autocomplete="off" data-role="form"><div class="fld-grid">' +
      input('targetQty', 'Hedef adet', w.targetQty, ' inputmode="numeric"') +
      `<label class="fld"><span>Termin</span><input name="dueDate" type="date" value="${escapeHtml(isoDate(w.dueDate))}"${dis}></label>` +
      `<label class="fld"><span>Tezgah</span><select name="machineId"${lockMachine ? ' disabled' : ''}>${machineOptions(meta.machines, w.machineId ?? '', '— atanmadı —')}</select></label>` +
      input('sampleQty', 'Numune adedi', w.sampleQty, ' inputmode="numeric"') +
      input('usedMaterial', 'Kullanılan hammadde (gerçek)', w.usedMaterial ?? '', ' maxlength="80"') +
      `<label class="fld"><span>GKK rapor no</span><span class="fld-row"><input name="gkkReportNo" value="${escapeHtml(w.gkkReportNo ?? '')}" maxlength="40" autocomplete="off"${dis}>` +
      `<button type="button" class="icon-btn icon-btn-sm" data-act="gkk-pick"${dis} title="Hammaddeye uyan GK numaralarını listeler">Listeden seç…</button></span></label>` +
      `<label class="fld"><span>İlk onay rapor no</span><span class="fld-row"><input name="firstApprovalNo" value="${escapeHtml(w.firstApprovalNo ?? '')}" maxlength="40" autocomplete="off"${dis}>` +
      `<button type="button" class="icon-btn icon-btn-sm" data-act="approval-new"${dis} title="Sıradaki ilk onay numarasını verir ve bu alana yazar">Numara al…</button></span></label>` +
      input('measuredNetG', 'Ölçülen net gramaj (gram)', gramInput(w.measuredNetKg), ' inputmode="decimal"') +
      '</div><h4 class="sub">İş emrine özel ürün değerleri (açıldığı andaki kopya; buradan düzeltilebilir)</h4><div class="fld-grid">' +
      input('material', 'Hammadde', w.material ?? '', ' maxlength="80"') + input('altMaterial', 'Alternatif hammadde', w.altMaterial ?? '', ' maxlength="80"') +
      input('lengthMm', 'Tam boy (mm)', decInput(w.lengthMm), ' inputmode="decimal"') +
      input('netG', 'Net ağırlık (gram)', gramInput(w.netKg), ' inputmode="decimal"') + input('grossG', 'Brüt ağırlık (gram)', gramInput(w.grossKg), ' inputmode="decimal"') +
      input('plannedSec', 'Planlanan çevrim (sn)', decInput(w.plannedSec), ' inputmode="decimal"') +
      '</div>' + input('note', 'Açıklama', w.note ?? '', ' maxlength="500"') +
      `<section class="dr-box"><h4 class="sub">Ölçü satırları (ölçü kontrol föyü)</h4><p class="hint" data-role="plan-summary">${planSummary(w)}</p>` +
      `<button type="button" class="icon-btn" data-act="measure-plan"${dis}>Ölçü satırlarını tanımla / düzenle…</button></section>` +
      drawingsEditorHtml(w) +
      '<p class="notice notice-sim" data-role="err" hidden></p>' +
      '<div class="dt-actions"><button type="button" class="icon-btn" data-act="form">Formu aç / yazdır</button>' +
      (w.status === 'planlandi' ? '<button type="button" class="icon-btn btn-primary" data-act="start">Üretime başlat…</button>' : '') +
      (w.status === 'uretimde' ? '<button type="button" class="icon-btn btn-primary" data-act="finish">Bitir…</button>' : '') +
      (w.status === 'bitti' ? '<button type="button" class="icon-btn" data-act="reopen-ask">Üretime geri al…</button>' : '') +
      (canCancel ? '<button type="button" class="icon-btn" data-act="cancel-ask">İptal et…</button>' : '') +
      (ro ? '' : '<button type="submit" class="icon-btn btn-primary">Kaydet</button>') + '</div></form>' +
      '<div data-role="reopen-box" hidden><h4 class="sub">Üretime geri al</h4><p class="hint">Bitiş geri alınır ve dondurulmuş sonuç silinir; iş emri yeniden üretimde olur, adet yeniden canlı sayılır.</p>' +
      '<p class="notice notice-sim" data-role="reopen-err" hidden></p><div class="dt-actions"><button type="button" class="icon-btn" data-act="reopen-no">Vazgeç</button><button type="button" class="icon-btn btn-primary" data-act="reopen-yes">Evet, geri al</button></div></div>' +
      '<div data-role="cancel-box" hidden><h4 class="sub">İş emrini iptal et</h4><label class="fld"><span>İptal nedeni (zorunlu)</span><input name="reason" maxlength="200" autocomplete="off"></label>' +
      '<p class="notice notice-sim" data-role="cancel-err" hidden></p><div class="dt-actions"><button type="button" class="icon-btn" data-act="cancel-no">Vazgeç</button><button type="button" class="icon-btn btn-primary" data-act="cancel-yes">İptali onayla</button></div></div>' +
      '<h4 class="sub">Geçmiş</h4><ul class="pl-events">' + w.events.map((e) => `<li><span class="mono">${escapeHtml(dateTimeText(e.at))}</span> · ${escapeHtml(e.by ?? '—')} · <b>${escapeHtml(EVENT_LABEL[e.kind] ?? e.kind)}</b>${e.detail ? ` — ${escapeHtml(e.detail)}` : ''}</li>`).join('') + '</ul>';
    wire();
  }

  /** Teknik resim bölümü: yükleme/kaldırma sonrası yalnız bölüm yeniden çizilir (formda yazılanlar silinmez). */
  function onDrawings(list) {
    w.drawings = list;
    const sec = m.body.querySelector('[data-role="drawings"]');
    if (!sec) return;
    sec.outerHTML = drawingsEditorHtml(w);
    wireDrawings(m.body, w, onDrawings);
    onChanged();
  }

  function wire() {
    wireDrawings(m.body, w, onDrawings);
    const form = m.body.querySelector('form');
    const num = (v) => (String(v).trim() === '' ? null : Number(String(v).replace(/\./g, '').replace(',', '.')));
    form?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const err = m.body.querySelector('[data-role="err"]');
      const btn = form.querySelector('[type="submit"]');
      err.hidden = true;
      btn.disabled = true;
      const e = form.elements;
      try {
        w = await put(`/api/planning/work-orders/${encodeURIComponent(w.no)}`, {
          targetQty: num(e.targetQty.value) ?? '', dueDate: e.dueDate.value || null, machineId: e.machineId.value, sampleQty: num(e.sampleQty.value), note: e.note.value,
          usedMaterial: e.usedMaterial.value, gkkReportNo: e.gkkReportNo.value, firstApprovalNo: e.firstApprovalNo.value,
          measuredNetKg: gramToKg(parseInput(e.measuredNetG.value)), material: e.material.value, altMaterial: e.altMaterial.value, lengthMm: parseInput(e.lengthMm.value),
          netKg: gramToKg(parseInput(e.netG.value)), grossKg: gramToKg(parseInput(e.grossG.value)), plannedSec: parseInput(e.plannedSec.value),
        });
        onChanged();
        draw();
      } catch (e2) {
        err.textContent = e2.message;
        err.hidden = false;
        btn.disabled = false;
      }
    });
  }

  m.body.addEventListener('click', async (ev) => {
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (act === 'form') openWorkOrderForm(w.no);
    else if (act === 'crate-card') openCrateCard(Number(ev.target.closest('[data-act]').dataset.id));
    else if (act === 'crate-sheet') openMeasureSheet(Number(ev.target.closest('[data-act]').dataset.id));
    else if (act === 'measure') openMeasureDialog(w.no, async () => { w = await api(`/api/planning/work-orders/${encodeURIComponent(w.no)}`); onChanged(); draw(); });
    else if (act === 'issue-card') {
      openIssueCard(w.no, async () => {
        w = await api(`/api/planning/work-orders/${encodeURIComponent(w.no)}`);
        onChanged();
        draw();
      });
    }
    else if (act === 'crate-void') {
      const b = ev.target.closest('[data-act]');
      openFormDialog({
        title: `Kartı iptal et · ${b.dataset.card}`,
        intro: 'Yanlış basılan kart iptal edilir (numara yeniden verilmez). Paketlenmiş kasa iptal edilemez.',
        fields: [{ name: 'reason', label: 'İptal nedeni (zorunlu)' }],
        submitLabel: 'Kartı iptal et',
        onSubmit: async (v) => {
          await post(`/api/planning/crates/${b.dataset.id}/void`, { reason: v.reason });
          w = await api(`/api/planning/work-orders/${encodeURIComponent(w.no)}`);
          onChanged();
          draw();
        },
      });
    }
    else if (act === 'gkk-pick') {
      const f = m.body.querySelector('form').elements;
      openGkkPicker({
        erpMaterial: f.usedMaterial.value.trim() || f.material.value.trim() || w.usedMaterial || w.material || '', stockCode: w.stockCode, current: f.gkkReportNo.value.trim(),
        onPick: (no) => { f.gkkReportNo.value = no; },
      });
    }
    else if (act === 'approval-new') {
      const f = m.body.querySelector('form').elements;
      createFirstApproval(w.no, (a) => { f.firstApprovalNo.value = a.code; w.firstApprovalNo = a.code; onChanged(); });
    }
    else if (act === 'measure-plan') {
      openMeasurePlanDialog(w.no, async () => {
        try {
          const fresh = await api(`/api/planning/work-orders/${encodeURIComponent(w.no)}`);
          w.measurePlan = fresh.measurePlan;
          const el = m.body.querySelector('[data-role="plan-summary"]');
          if (el) el.innerHTML = planSummary(w);
        } catch { /* özet yenilenemedi: kayıt yapıldı */ }
        onChanged();
      });
    }
    else if (act === 'cancel-ask') { m.body.querySelector('[data-role="cancel-box"]').hidden = false; m.body.querySelector('[name="reason"]').focus(); }
    else if (act === 'cancel-no') m.body.querySelector('[data-role="cancel-box"]').hidden = true;
    else if (act === 'start') openStartDialog(w.no, async (r) => { w = await api(`/api/planning/work-orders/${encodeURIComponent(r.no)}`); onChanged(); draw(); });
    else if (act === 'finish') openFinishDialog(w.no, async (r) => { w = await api(`/api/planning/work-orders/${encodeURIComponent(r.no)}`); onChanged(); draw(); });
    else if (act === 'sample-write') {
      const btn = ev.target.closest('[data-act="sample-write"]');
      const sec = Number(btn.dataset.sec);
      if (!window.confirm(`${btn.dataset.code} ürün kartının planlanan çevrim süresi ${fmtDec(sec, 1)} sn olarak güncellensin mi? Sonraki iş emirleri bu süreyi kopyalar; açık iş emirleri değişmez.`)) return;
      try {
        await put(`/api/planning/products/${encodeURIComponent(btn.dataset.code)}`, { plannedSec: sec });
        btn.outerHTML = '<small class="hint">Ürün kartına yazıldı.</small>';
      } catch (e) { btn.outerHTML = `<small class="hint">Yazılamadı: ${escapeHtml(e.message)}</small>`; }
    }
    else if (act === 'reopen-ask') m.body.querySelector('[data-role="reopen-box"]').hidden = false;
    else if (act === 'reopen-no') m.body.querySelector('[data-role="reopen-box"]').hidden = true;
    else if (act === 'reopen-yes') {
      const err = m.body.querySelector('[data-role="reopen-err"]');
      try {
        w = await post(`/api/planning/work-orders/${encodeURIComponent(w.no)}/reopen`, {});
        onChanged();
        draw();
      } catch (e) { err.textContent = e.message; err.hidden = false; }
    }
    else if (act === 'cancel-yes') {
      const err = m.body.querySelector('[data-role="cancel-err"]');
      try {
        w = await post(`/api/planning/work-orders/${encodeURIComponent(w.no)}/cancel`, { reason: m.body.querySelector('[name="reason"]').value });
        onChanged();
        draw();
      } catch (e) { err.textContent = e.message; err.hidden = false; }
    }
  });
  draw();

  // Uretimdeki is emrinin canli adedi 10 sn'de bir tazelenir (yalniz uretim paneli; formda yazilanlar silinmez).
  const timer = setInterval(async () => {
    if (!m.dlg.isConnected) { clearInterval(timer); return; }
    if (w.status !== 'uretimde') return;
    try {
      const fresh = await api(`/api/planning/work-orders/${encodeURIComponent(w.no)}`);
      if (fresh.status !== w.status) { w = fresh; draw(); return; }
      w.progress = fresh.progress;
      w.crates = fresh.crates;
      w.consumption = fresh.consumption;
      const box = m.body.querySelector('[data-role="progress"]');
      if (box) box.outerHTML = progressHtml(w);
      const cbox = m.body.querySelector('[data-role="crates"]');
      if (cbox) cbox.outerHTML = cratesHtml(w);
      const mbox = m.body.querySelector('[data-role="material"]');
      if (mbox) mbox.outerHTML = materialPanelHtml(w);
    } catch { /* gecici ag hatasi: bir sonraki turda yeniden denenir */ }
  }, 10_000);
}
