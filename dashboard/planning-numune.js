/**
 * Planlama > Numune takip (EYS.FR.012 "Numune Talep / Takip Formu"): müşteriye numune üretilip gönderilmesi ve
 * müşteriden gelen onay/ret geri bildiriminin takibi. `products` tablosuyla HİÇ BAĞLANMAZ (ürün kartı henüz
 * olmayabilir — kâğıt formdaki ALEN ÜRÜN KODU boş kalabilir, serbest metindir).
 *
 * Akış: "Yeni numune formu aç" → NUMUNE TANIMLAMA + NUMUNE ÜRETİM BİLGİLERİ alanları girilir (çoğu isteğe
 * bağlı, zamanla doldurulur) → "Formu oluştur/kaydet" ile kayıt oluşur → "Formu görüntüle/yazdır" ile çıktı
 * alınıp müşteriye gönderilir (fiziksel) → müşteriden e-posta ile gelen karar "Düzenle"den elle işaretlenir:
 * onaylandı / onaylanmadı → satır rengi yeşil/kırmızı (ikon+etiket de var, renk tek başına değil).
 *
 * Kâğıt formdaki "KALİTE KONTROL RAPOR NO" alanı YANLIŞ adlandırılmış: aslında GKK rapor no'dur (kullanıcı
 * teyidi, 2026-11-02) — burada "GKK rapor no" olarak gösterilir, openGkkPicker ile aynı listeden seçilebilir.
 */
import { escapeHtml } from './format.js';
import { api, post } from './lib-common.js';
import {
  put, del, cellText, fmtNum, dateText, debounce, openModal, chip, canWrite, isAdminRole, printModal, openListPrint, truncCell,
} from './planning-common.js';
import { openGkkPicker } from './planning-gkk.js';

const STATUS_CHIP = Object.freeze({
  bekliyor: chip('warn', '◔', 'karar bekliyor'),
  onaylandi: chip('ok', '✓', 'onaylandı'),
  reddedildi: chip('bad', '✕', 'onaylanmadı'),
});
const rowClass = (status) => (status === 'onaylandi' ? ' pl-done' : status === 'reddedildi' ? ' pl-rejected' : ' pl-waiting');
const isoDate = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');
const decInput = (v) => (v === null || v === undefined ? '' : String(v).replace('.', ','));

/* ============================================================================================== liste */

/** @param {HTMLElement} host */
export async function renderSamples(host) {
  const canEdit = canWrite('numune');
  const st = { q: '', status: '', items: [], total: 0, seq: 0 };
  host.innerHTML =
    '<div class="pl-bar"><input type="search" class="pl-search" data-role="q" placeholder="Kod, müşteri, müşteri numune/ürün kodu, Alen kodu ara…" aria-label="Numune ara">' +
    '<label class="fld-inline">Durum <select data-role="status"><option value="">Tümü</option><option value="bekliyor">Karar bekliyor</option><option value="onaylandi">Onaylandı</option><option value="reddedildi">Onaylanmadı</option></select></label>' +
    '<button type="button" class="icon-btn" data-act="print">Listeyi yazdır</button>' +
    (canEdit ? '<button type="button" class="icon-btn btn-primary" data-act="new">Yeni numune formu aç</button>' : '') + '</div>' +
    '<p class="hint" data-role="count"></p>' +
    '<div class="table-wrap table-wrap-tall" data-role="list"></div>' +
    (isAdminRole() ? '<div data-role="seq-box"></div>' : '');
  const $ = (r) => host.querySelector(`[data-role="${r}"]`);

  function draw() {
    $('count').textContent = st.total === 0
      ? (st.q || st.status ? 'Eşleşen numune kaydı yok.' : `Henüz numune kaydı yok.${canEdit ? ' "Yeni numune formu aç" ile başlayın.' : ''}`)
      : `${fmtNum(st.total)} numune kaydı`;
    $('list').innerHTML = st.items.length === 0 ? '' :
      '<table class="tbl tbl-pl"><thead><tr><th>Kod</th><th>Tarih</th><th>Müşteri</th><th>Müşteri numune/ürün kodu</th><th>Alen ürün kodu</th><th>Durum</th></tr></thead><tbody>' +
      st.items.map((s) =>
        `<tr class="pl-row${rowClass(s.status)}" data-id="${s.id}" tabindex="0"><td class="mono"><b>${escapeHtml(s.code)}</b></td><td>${dateText(s.requestedOn)}</td>` +
        `<td class="trunc"${truncCell(s.customer)}>${cellText(s.customer)}</td>` +
        `<td class="trunc"${truncCell([s.customerSampleCode, s.customerCode].filter(Boolean).join(' · '))}>${cellText([s.customerSampleCode, s.customerCode].filter(Boolean).join(' · ') || null)}</td>` +
        `<td class="mono">${cellText(s.stockCode)}</td><td>${STATUS_CHIP[s.status] ?? s.status}</td></tr>`).join('') +
      '</tbody></table>';
  }

  async function load() {
    const seq = ++st.seq;
    $('count').innerHTML = 'Yükleniyor…';
    try {
      const r = await api(`/api/planning/samples?${new URLSearchParams({ q: st.q, status: st.status, limit: 300 })}`);
      if (seq !== st.seq) return;
      st.total = r.total; st.items = r.items;
      draw();
      if (isAdminRole()) drawSeq(r.next);
    } catch (err) {
      if (seq !== st.seq) return;
      $('count').innerHTML = `Numune kayıtları alınamadı: ${escapeHtml(err.message)} <button type="button" class="icon-btn icon-btn-sm" data-act="retry">Yeniden dene</button>`;
    }
  }

  /** Numara taban ayarı (kâğıt defterdeki SERİ NO'yla çakışmasın). Yalnız yönetici. */
  function drawSeq(n) {
    const box = $('seq-box');
    if (!box) return;
    box.innerHTML =
      '<div class="pl-seq-box"><p class="hint-meta">Sıradaki numune kodu: <b class="mono">' + escapeHtml(n.nextCode) + '</b>' +
      (n.floor > 0 || n.max > 0 ? '' : ' <span class="is-null">(taban girilmedi, 000001\'den başlıyor)</span>') + '</p>' +
      '<div class="pl-seq"><input type="text" inputmode="numeric" maxlength="6" data-role="seq-last" placeholder="ör. 219" aria-label="Kâğıt defterde en son verilen numune sıra no">' +
      '<button type="button" class="icon-btn" data-act="seq-set">Bu numaradan devam ettir</button></div>' +
      '<p class="hint">Kâğıt defterde (EYS.FR.012) hâlâ kullanılan bir sıra varsa en son verilen numarayı bir kez buraya girin. Numara yalnız yükseltilebilir, geri alınamaz.</p>' +
      '<p class="notice notice-sim" data-role="seq-err" hidden></p></div>';
  }

  const search = debounce((value) => { st.q = value.trim(); load(); }, 250);
  host.oninput = (ev) => { if (ev.target.dataset?.role === 'q') search(ev.target.value); };
  host.onchange = (ev) => { if (ev.target.dataset?.role === 'status') { st.status = ev.target.value; load(); } };
  host.onclick = (ev) => {
    if (ev.target.closest('[data-act="retry"]')) { load(); return; }
    if (ev.target.closest('[data-act="new"]')) { openSampleDialog(null, load); return; }
    if (ev.target.closest('[data-act="print"]')) {
      openListPrint({
        title: 'Numune Talep / Takip Formu Listesi', formNo: 'EYS.FR.012',
        heads: ['Kod', 'Tarih', 'Müşteri', 'Müşteri numune/ürün kodu', 'Alen ürün kodu', 'Durum'],
        rows: st.items.map((s) => [s.code, dateText(s.requestedOn).replace(/<[^>]+>/g, ''), s.customer,
          [s.customerSampleCode, s.customerCode].filter(Boolean).join(' · '), s.stockCode, { bekliyor: 'Karar bekliyor', onaylandi: 'Onaylandı', reddedildi: 'Onaylanmadı' }[s.status] ?? s.status]),
      });
      return;
    }
    const setBtn = ev.target.closest('[data-act="seq-set"]');
    if (setBtn) {
      const box = ev.target.closest('.pl-seq-box');
      const err = box.querySelector('[data-role="seq-err"]');
      err.hidden = true;
      put('/api/planning/samples/sequence', { last: box.querySelector('[data-role="seq-last"]').value })
        .then((n) => drawSeq(n)).catch((e) => { err.textContent = e.message; err.hidden = false; });
      return;
    }
    const row = ev.target.closest('.pl-row');
    if (row) openSampleDialog(Number(row.dataset.id), load);
  };
  await load();
}

/* ============================================================================================== form / duzenle */

const FIELD_LABEL = Object.freeze({
  customer: 'Müşteri', customerSampleCode: 'Müşteri numune kodu', customerCode: 'Müşteri ürün kodu', stockCode: 'Alen ürün kodu',
  sampleQty: 'Numune miktarı', dueDate: 'Teslim tarihi', quoteNetG: 'Fiyat teklif net ağırlığı (gr)', sampleNetG: 'Numune net ağırlığı (gr)',
  productionSec: 'Üretim süresi (sn)', material: 'Hammadde', altMaterial: 'Alternatif hammadde', gauges: 'Kullanılan mastar/lar',
  producedQty: 'Üretim miktarı', sampleSetQty: 'Ayrılan örnek miktarı', producedOn: 'Üretim tarihi', sentQty: 'Gönderilen miktar',
});

/**
 * Numune formu: yeni (id=null) ya da düzenle. Salt okuma rolü (yalnız 'read') formu görür, değiştiremez.
 * @param {number|null} id @param {() => void} [onDone]
 */
export async function openSampleDialog(id, onDone = () => {}) {
  const editable = canWrite('numune');
  const m = openModal({ title: id ? `Numune formu düzenle` : 'Yeni numune formu', wide: true });
  m.body.innerHTML = '<p class="empty">Yükleniyor…</p>';
  let s = null;
  if (id) {
    try { s = await api(`/api/planning/samples/${id}`); } catch (err) { m.body.innerHTML = `<p class="notice notice-sim">Alınamadı: ${escapeHtml(err.message)}</p>`; return; }
  }
  let error = null;
  let decideMode = null; // 'onaylandi' | 'reddedildi' | null

  const v = (key) => (s ? s[key] : null);
  const txt = (key, label, max, extra = '') => `<label class="fld"><span>${escapeHtml(label)}</span><input name="${key}" value="${escapeHtml(v(key) ?? '')}" maxlength="${max}" autocomplete="off"${editable ? '' : ' readonly'}${extra}></label>`;
  const num = (key, label, extra = '') => `<label class="fld"><span>${escapeHtml(label)}</span><input name="${key}" inputmode="decimal" value="${escapeHtml(decInput(v(key)))}" autocomplete="off"${editable ? '' : ' readonly'}${extra}></label>`;
  const dt = (key, label) => `<label class="fld"><span>${escapeHtml(label)}</span><input name="${key}" type="date" value="${isoDate(v(key))}"${editable ? '' : ' disabled'}></label>`;

  function draw() {
    m.body.innerHTML =
      (s ? `<p class="pl-wohead"><b class="mono">${escapeHtml(s.code)}</b> · ${dateText(s.requestedOn)} · ${STATUS_CHIP[s.status]}</p>` : '') +
      '<form autocomplete="off"><h4 class="sub">Numune tanımlama</h4><div class="fld-grid">' +
      txt('customer', 'Müşteri *', 120, ' required') + txt('customerSampleCode', 'Müşteri numune kodu', 60) +
      txt('customerCode', 'Müşteri ürün kodu', 60) + txt('stockCode', 'Alen ürün kodu', 40) +
      txt('sampleQty', 'Numune miktarı', 40, ' placeholder="ör. 1.100 AD."') + dt('dueDate', 'Teslim tarihi') +
      '</div><h4 class="sub">Numune üretim bilgileri</h4><div class="fld-grid">' +
      num('quoteNetG', 'Fiyat teklif net ağırlığı (gr)') + num('sampleNetG', 'Numune net ağırlığı (gr)') +
      num('productionSec', 'Üretim süresi (sn)') + txt('material', 'Hammadde', 80) + txt('altMaterial', 'Alternatif hammadde', 80) +
      txt('gauges', 'Kullanılan mastar/lar', 120) + num('producedQty', 'Üretim miktarı') + num('sampleSetQty', 'Ayrılan örnek miktarı') +
      dt('producedOn', 'Üretim tarihi') +
      `<label class="fld"><span>GKK rapor no</span><span class="fld-row"><input name="gkkReportNo" maxlength="40" autocomplete="off" value="${escapeHtml(v('gkkReportNo') ?? '')}"${editable ? '' : ' readonly'}>` +
      (editable ? '<button type="button" class="icon-btn icon-btn-sm" data-act="pick-gk">Listeden seç…</button>' : '') + '</span></label>' +
      num('sentQty', 'Gönderilen miktar') +
      '</div>' +
      `<label class="fld"><span>Müşteri geri bildirim</span><textarea name="customerFeedback" rows="3" maxlength="2000"${editable ? '' : ' readonly'}>${escapeHtml(v('customerFeedback') ?? '')}</textarea></label>` +
      `<label class="fld"><span>Not</span><input name="note" maxlength="500" autocomplete="off" value="${escapeHtml(v('note') ?? '')}"${editable ? '' : ' readonly'}></label>` +
      (decideMode
        ? `<div class="notice${decideMode === 'reddedildi' ? ' notice-sim' : ''}"><b>${decideMode === 'onaylandi' ? 'Seri üretim onaylandı' : 'Numune onaylanmadı'} olarak işaretlenecek.</b></div>` +
          `<label class="fld"><span>${decideMode === 'onaylandi' ? 'Seri üretim onay tarihi' : 'Karar tarihi'}</span><input name="decidedOn" type="date" value="${isoDate(Date.now())}"></label>` +
          `<label class="fld"><span>${decideMode === 'onaylandi' ? 'Not (isteğe bağlı)' : 'Ret sebebi ve müşteri rapor no'}</span><textarea name="decisionNote" rows="2" maxlength="1000">${escapeHtml(s?.status === decideMode ? (s.decisionNote ?? '') : '')}</textarea></label>` +
          '<div class="dt-actions"><button type="button" class="icon-btn" data-act="decide-cancel">Vazgeç</button>' +
          `<button type="submit" class="icon-btn btn-primary" data-act="decide-save">${decideMode === 'onaylandi' ? 'Onaylandı olarak kaydet' : 'Onaylanmadı olarak kaydet'}</button></div>`
        : '') +
      (error ? `<p class="notice notice-sim">${escapeHtml(error)}</p>` : '') +
      '<div class="dt-actions">' +
      (s ? '<button type="button" class="icon-btn" data-act="view">Formu görüntüle/yazdır</button>' : '') +
      (editable && !decideMode ? [
        s && s.status !== 'onaylandi' ? '<button type="button" class="icon-btn" data-act="approve">✓ Onaylandı</button>' : '',
        s && s.status !== 'reddedildi' ? '<button type="button" class="icon-btn" data-act="reject">✕ Onaylanmadı</button>' : '',
        s && s.status !== 'bekliyor' ? '<button type="button" class="icon-btn" data-act="reopen">Kararı geri al</button>' : '',
      ].join('') : '') +
      (isAdminRole() && s ? '<button type="button" class="icon-btn" data-act="delete">Sil…</button>' : '') +
      '<button type="button" class="icon-btn" data-act="close">Kapat</button>' +
      (editable && !decideMode ? `<button type="submit" class="icon-btn btn-primary" data-act="save">${s ? 'Kaydet' : 'Formu oluştur'}</button>` : '') +
      '</div></form>';
  }
  draw();

  m.body.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-act="close"]')) { m.close(); return; }
    if (ev.target.closest('[data-act="view"]')) { openSampleForm(s); return; }
    if (ev.target.closest('[data-act="pick-gk"]')) {
      const f = m.body.querySelector('form');
      openGkkPicker({ stockCode: f.elements.stockCode.value, current: f.elements.gkkReportNo.value, onPick: (no) => { f.elements.gkkReportNo.value = no; } });
      return;
    }
    if (ev.target.closest('[data-act="approve"]')) { decideMode = 'onaylandi'; error = null; draw(); return; }
    if (ev.target.closest('[data-act="reject"]')) { decideMode = 'reddedildi'; error = null; draw(); return; }
    if (ev.target.closest('[data-act="decide-cancel"]')) { decideMode = null; error = null; draw(); return; }
    if (ev.target.closest('[data-act="reopen"]')) {
      post(`/api/planning/samples/${s.id}/reopen`).then((r) => { s = r; onDone(); draw(); }).catch((e) => { error = e.message; draw(); });
      return;
    }
    if (ev.target.closest('[data-act="delete"]')) {
      if (!window.confirm(`"${s.code}" numaralı numune kaydı silinsin mi? Bu geri alınamaz.`)) return;
      del(`/api/planning/samples/${s.id}`).then(() => { onDone(); m.close(); }).catch((e) => { error = e.message; draw(); });
    }
  });
  m.body.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const btn = f.querySelector('[type="submit"]');
    btn.disabled = true;
    error = null;
    try {
      if (decideMode) {
        s = await post(`/api/planning/samples/${s.id}/decide`, { status: decideMode, decidedOn: f.elements.decidedOn.value || null, note: f.elements.decisionNote.value });
        decideMode = null;
      } else {
        const body = {
          customer: f.elements.customer.value, customerSampleCode: f.elements.customerSampleCode.value, customerCode: f.elements.customerCode.value,
          stockCode: f.elements.stockCode.value, sampleQty: f.elements.sampleQty.value, dueDate: f.elements.dueDate.value || null,
          quoteNetG: f.elements.quoteNetG.value, sampleNetG: f.elements.sampleNetG.value, productionSec: f.elements.productionSec.value,
          material: f.elements.material.value, altMaterial: f.elements.altMaterial.value, gauges: f.elements.gauges.value,
          producedQty: f.elements.producedQty.value, sampleSetQty: f.elements.sampleSetQty.value, producedOn: f.elements.producedOn.value || null,
          gkkReportNo: f.elements.gkkReportNo.value, sentQty: f.elements.sentQty.value, customerFeedback: f.elements.customerFeedback.value, note: f.elements.note.value,
        };
        s = s ? await put(`/api/planning/samples/${s.id}`, body) : await post('/api/planning/samples', body);
      }
      onDone(); // ilk olusturmadan sonra da diyalog acik kalir: s artik dolu, draw() "duzenle" goruntusune gecer
      draw();
    } catch (e) {
      error = e.message;
      btn.disabled = false;
      draw();
    }
  });
}

/* ============================================================================================== basilan form (EYS.FR.012) */

/** Kâğıt formun düzeninde (A4 dikey) tek kayıt. @param {object} s */
function sampleFormHtml(s) {
  const row = (label, value, cls = '') => `<tr><th scope="row">${escapeHtml(label)}</th><td class="${cls}">${value === '' || value == null ? '&nbsp;' : escapeHtml(String(value))}</td></tr>`;
  const sec = (label) => `<tr class="pl-nf-sec"><th colspan="2">${escapeHtml(label)}</th></tr>`;
  return (
    '<div class="pl-form">' +
    `<div class="pl-f-head"><div class="pl-f-title">NUMUNE TALEP / TAKİP FORMU</div><div class="pl-f-no"><span class="pl-f-label">SERİ NO</span> ${escapeHtml(s.code)}<br>` +
    `<span class="pl-f-label">TARİH</span> ${dateText(s.requestedOn)}</div></div>` +
    '<table class="pl-nf-t"><tbody>' +
    sec('Numune tanımlama') +
    row('MÜŞTERİ', s.customer) + row('MÜŞTERİ NUMUNE KODU', s.customerSampleCode) + row('MÜŞTERİ ÜRÜN KODU', s.customerCode) +
    row('ALEN ÜRÜN KODU', s.stockCode) + row('NUMUNE MİKTARI', s.sampleQty) + row('TESLİM TARİHİ', s.dueDate ? dateText(s.dueDate) : null) +
    sec('Numune üretim bilgileri') +
    row('FİYAT TEKLİF NET AĞIRLIĞI (gr)', decInput(s.quoteNetG)) + row('NUMUNE NET AĞIRLIĞI (gr)', decInput(s.sampleNetG)) +
    row('ÜRETİM SÜRESİ (sn)', decInput(s.productionSec)) + row('HAMMADDE', s.material) + row('ALTERNATİF HAMMADDE', s.altMaterial) +
    row('KULLANILAN MASTAR/LAR', s.gauges) + row('ÜRETİM MİKTARI', s.producedQty) + row('AYRILAN ÖRNEK MİKTARI', s.sampleSetQty) +
    row('ÜRETİM TARİHİ', s.producedOn ? dateText(s.producedOn) : null) + row('GKK RAPOR NO', s.gkkReportNo) + row('GÖNDERİLEN MİKTAR', s.sentQty) +
    sec('Müşteri geri bildirim') +
    row('GERİ BİLDİRİM', s.customerFeedback, 'pl-nf-note') +
    sec('Sonuç') +
    row('SERİ ÜRETİM ONAY TARİHİ', s.status === 'onaylandi' ? dateText(s.decidedOn) : null) +
    row('RET SEBEBİ VE MÜŞTERİ RAPOR NO', s.status === 'reddedildi' ? s.decisionNote : null, 'pl-nf-note') +
    '</tbody></table>' +
    `<p class="pl-f-foot">EYS.FR.012 · YAYIN TAR: 20.09.2024 · REV NO: -- · REV TARİHİ: -- · Sistemden basıldı ${escapeHtml(new Date().toLocaleString('tr-TR', { hour12: false }))}</p>` +
    '</div>'
  );
}

/** Tek bir numune formunu görüntüle ve yazdır (A4 dikey). @param {object} s */
function openSampleForm(s) {
  const m = openModal({ title: `Numune formu · ${s.code}`, wide: true });
  m.dlg.classList.add('pl-form-dlg');
  m.body.innerHTML =
    '<div class="dt-actions pl-form-actions"><button type="button" class="icon-btn btn-primary" data-act="print">Yazdır</button></div>' +
    sampleFormHtml(s);
  m.body.querySelector('[data-act="print"]').addEventListener('click', printModal);
}
