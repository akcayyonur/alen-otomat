/**
 * Planlama > Hammadde (yalnız yönetici): hammadde İHTİYACI, gerçekleşen SARFİYAT ve Mikro sarfiyat fişi takibi (D aşaması).
 *
 * Sarfiyat TEORİKTİR: tezgahın işlediği tüm parça (sayaç) × brüt gramaj, kg olarak; çubuk sayısı (BOY) bilgidir. Mikro'ya yazma API'si doğrulanana
 * kadar fiş ELLE girilir: burada kesilecek fiş listelenir, ofis Mikro'ya girer ve "girildi" işaretler (evrak no ile); girilen iş emri tekrar işaretlenemez
 * (çift fiş olmasın). Hesaplar sunucuda (backend/planning/material.js); ekran ve CSV aynı sayıları kullanır.
 */
import { escapeHtml } from './format.js';
import { api, post } from './lib-common.js';
import { cellText, fmtNum, fmtDec, dateText, dateTimeText, openModal, chip, sectionClosed, truncCell, debounce, parseInput, canWrite, RANGE_PRESETS as PRESETS } from './planning-common.js';

const kg = (v) => (v == null ? '<span class="is-null">—</span>' : `${fmtDec(v, 3)}`);

/** Hammadde adının yanında: alternatif / planlıdan farklı uyarısı (ikon + etiket). */
const materialFlag = (r) => (r.isAlt ? ` ${chip('info', 'ℹ', 'alternatif hammadde')}` : r.differs ? ` ${chip('bad', '▲', 'planlıdan farklı')}` : '');

/** Rezervasyon durum rozeti ("ayrıldı/tüketildi/serbest bırakıldı"). @param {object|null} r `w.reservation`, @param {string} status `w.status` */
function reservationTile(r, status) {
  if (!r) {
    if (status !== 'uretimde' && status !== 'bitti') return '';
    // Nedeni burada kesin bilinmez: baslatilirken agirlik/hammadde kodu eksik olabilir, YA DA bu is emri bu ozellik eklenmeden once baslatilmis olabilir (yukseltme sonrasi eski uretimdeki is emirleri).
    return '<div class="pl-kpi"><span class="pl-kpi-l">Hammadde ayırma</span><span class="pl-kpi-v"><span class="is-null">ayrılmadı</span> <small class="hint">ağırlık/hammadde kodu eksikti ya da bu iş emri bu özellikten önce başlatılmıştı</small></span></div>';
  }
  const v = r.status === 'ayrildi'
    ? `${chip('info', '▶', 'ayrıldı')} <b>${kg(r.reservedKg)} kg</b> <small class="hint">üretime ayrıldı</small>`
    : r.status === 'tuketildi'
      ? `${chip('ok', '✓', 'tüketildi')} <b>${kg(r.consumedKg)} kg</b> <small class="hint">${r.consumedSource === 'paketleme' ? 'paketlemeden' : 'sayaçtan'}</small>`
      : `${chip('none', '↺', 'serbest bırakıldı')} <small class="hint">${kg(r.reservedKg)} kg hiç kullanılmadı</small>`;
  return `<div class="pl-kpi"><span class="pl-kpi-l">Hammadde ayırma</span><span class="pl-kpi-v">${v}</span></div>`;
}

/** İş emri ayrıntısındaki "Hammadde" paneli. @param {object} w /api/planning/work-orders/:no yanıtı (consumption ile) */
export function materialPanelHtml(w) {
  const c = w.consumption;
  if (!c || c.qty == null) return '<section class="pl-prog" data-role="material" hidden></section>';
  const fis = c.fis ?? {};
  // Hammadde bolumu bu kurulumda kapaliysa Mikro fisi isaretlenemez: "bekliyor" hep orada kalirdi, bu yuzden o kutu gosterilmez (kg ve cubuk bilgi olarak kalir).
  const fisTile = sectionClosed('hammadde') ? '' : (
    `<div class="pl-kpi"><span class="pl-kpi-l">Mikro sarfiyat fişi</span><span class="pl-kpi-v">${fis.status === 'girildi'
      ? `${chip('ok', '✓', 'girildi')} ${fis.docNo ? escapeHtml(fis.docNo) : ''} <small class="hint">${kg(fis.kg)} kg · ${escapeHtml(dateTimeText(fis.at))}</small>`
      : fis.status === 'bekliyor' ? chip('none', '◔', 'bekliyor') : '<span class="is-null">iş emri bitince</span>'}</span></div>`);
  return (
    '<section class="pl-prog" data-role="material">' +
    '<h4 class="sub">Hammadde · sarfiyat</h4>' +
    `<p class="hint">${c.qtySource === 'paketleme' ? 'Gerçek sarfiyat: paketlemedeki (sevk edilen + hurda) adet × brüt gramaj.' : 'Sarfiyat teoriktir: tezgahın işlediği tüm parça (sayaç) × brüt gramaj; çubuk tartımı değil.'}</p>` +
    '<div class="pl-kpis">' +
    `<div class="pl-kpi"><span class="pl-kpi-l">Hammadde</span><span class="pl-kpi-v">${cellText(c.material)}${materialFlag(c)}</span></div>` +
    `<div class="pl-kpi"><span class="pl-kpi-l">Adet${c.qtySource === 'paketleme' ? ' (paketleme)' : ' (sayaç)'}</span><span class="pl-kpi-v">${fmtNum(c.qty)}${c.qtySource === 'paketleme' ? ` <small class="hint">${fmtNum(c.packedQty)} sevk + ${fmtNum(c.scrapQty)} hurda</small>` : ''}</span></div>` +
    `<div class="pl-kpi"><span class="pl-kpi-l">Sarfiyat</span><span class="pl-kpi-v">${c.kg == null ? '<span class="is-null">—</span> <small class="hint">brüt ağırlık yok</small>' : `${kg(c.kg)} kg`}</span></div>` +
    `<div class="pl-kpi"><span class="pl-kpi-l">Çubuk (BOY)</span><span class="pl-kpi-v">${c.bars == null ? '<span class="is-null">—</span>' : fmtDec(c.bars, 2)}</span></div>` +
    `<div class="pl-kpi"><span class="pl-kpi-l">Beklenen talaş</span><span class="pl-kpi-v">${c.scrapKg == null ? '<span class="is-null">—</span>' : `${kg(c.scrapKg)} kg`}</span></div>` +
    reservationTile(w.reservation, w.status) +
    fisTile +
    '</div></section>'
  );
}

/** @param {HTMLElement} host */
export async function renderMaterial(host) {
  const now = new Date();
  const st = { view: 'sarfiyat', preset: 'ay', from: PRESETS[1].range(now)[0], to: PRESETS[1].range(now)[1], fis: 'tumu', data: null, need: null, stock: null, quarantine: null, selected: new Set(), seq: 0 };
  host.innerHTML =
    '<div class="seg pl-tabs" role="group" aria-label="Hammadde bölümleri" data-role="views">' +
    '<button type="button" data-view="sarfiyat">Sarfiyat ve fiş</button><button type="button" data-view="ihtiyac">İhtiyaç</button><button type="button" data-view="stok">Depo stoğu</button>' +
    '<button type="button" data-view="karantina">Karantina</button></div>' +
    '<div class="pl-bar"><button type="button" class="icon-btn" data-act="transfer-dialog">Depolar arası sevkiyat (Mikro)…</button></div>' +
    '<div data-role="body"></div>';
  const $ = (r) => host.querySelector(`[data-role="${r}"]`);

  const setViewButtons = () => {
    for (const b of host.querySelectorAll('[data-view]')) {
      const on = b.dataset.view === st.view;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  };

  /* ------------------------------------------------------------ sarfiyat */
  const qs = () => new URLSearchParams({ from: st.from, to: st.to, fis: st.fis }).toString();

  function consumptionHtml() {
    const d = st.data;
    const t = d.totals;
    const tile = (label, value, sub = '') => `<div class="pl-kpi"><span class="pl-kpi-l">${label}</span><span class="pl-kpi-v">${value}</span>${sub ? `<small class="hint">${sub}</small>` : ''}</div>`;
    return (
      '<div class="pl-bar">' +
      '<div class="seg" role="group" aria-label="Tarih aralığı">' + PRESETS.map((p) => `<button type="button" data-preset="${p.key}" class="${st.preset === p.key ? 'is-on' : ''}">${p.label}</button>`).join('') + '</div>' +
      `<label class="fld-inline">Başlangıç <input type="date" data-role="from" value="${escapeHtml(st.from)}"></label>` +
      `<label class="fld-inline">Bitiş <input type="date" data-role="to" value="${escapeHtml(st.to)}"></label>` +
      `<label class="fld-inline">Fiş <select data-role="fis"><option value="tumu"${st.fis === 'tumu' ? ' selected' : ''}>Tümü</option><option value="bekleyen"${st.fis === 'bekleyen' ? ' selected' : ''}>Fişi bekleyenler</option><option value="girildi"${st.fis === 'girildi' ? ' selected' : ''}>Girilenler</option></select></label>` +
      `<a class="icon-btn" href="/api/planning/material/consumption.csv?${qs()}&view=hammadde" download>CSV · hammadde bazlı</a>` +
      `<a class="icon-btn" href="/api/planning/material/consumption.csv?${qs()}&view=is-emri" download>CSV · iş emri bazlı</a></div>` +
      '<p class="hint">Bitiş tarihi bu aralıkta olan <b>biten</b> iş emirleri. Adet, iş emri bitince dondurulan sayaç adedidir; sarfiyat teoriktir (sayaç × brüt gramaj). Mikro\'ya yazma doğrulanana kadar fiş elle girilir.</p>' +
      '<div class="pl-kpis">' +
      tile('Sarfiyat', `${kg(t.kg)} kg`, `${fmtNum(t.orders)} iş emri · ${fmtNum(t.qty)} adet`) + tile('Çubuk (BOY)', fmtDec(t.bars, 2)) + tile('Beklenen talaş', `${kg(t.scrapKg)} kg`) +
      tile('Fişi bekleyen', `${kg(t.pendingKg)} kg`, `${fmtNum(t.pendingOrders)} iş emri`) + '</div>' +
      (t.noWeight > 0 ? `<p class="notice notice-sim"><b>${t.noWeight} iş emrinde brüt ağırlık yok</b>: sarfiyatları hesaplanamadı (toplama girmedi). İş emri ayrıntısından ağırlığı girin ya da fişe kg'ı elle yazın.</p>` : '') +
      (t.differs > 0 ? `<p class="notice"><b>${t.differs} iş emrinde kullanılan hammadde planlıdan farklı</b> (satırlarda işaretli): fişi doğru hammaddeye kesin.</p>` : '') +
      '<h4 class="sub">Hammadde bazında</h4>' +
      (d.byMaterial.length === 0 ? '<p class="empty">Bu aralıkta biten iş emri yok.</p>' :
        '<div class="table-wrap"><table class="tbl tbl-pl"><thead><tr><th>Hammadde</th><th class="num">İş emri</th><th class="num">Adet</th><th class="num">Sarfiyat (kg)</th><th class="num">Çubuk</th><th class="num">Beklenen talaş (kg)</th><th class="num">Fişi bekleyen (kg)</th></tr></thead><tbody>' +
        d.byMaterial.map((g) => `<tr><td class="mono trunc"${truncCell(g.material)}><b>${cellText(g.material)}</b></td><td class="num">${fmtNum(g.orders)}</td><td class="num">${fmtNum(g.qty)}</td><td class="num"><b>${kg(g.kg)}</b>${g.unknownKg ? ` <small class="hint">+${g.unknownKg} ağırlıksız</small>` : ''}</td>` +
          `<td class="num">${fmtDec(g.bars, 2)}</td><td class="num">${kg(g.scrapKg)}</td><td class="num">${g.pendingKg > 0 ? `<b>${kg(g.pendingKg)}</b>` : '0'}</td></tr>`).join('') + '</tbody></table></div>') +
      '<h4 class="sub">İş emri bazında</h4>' +
      (d.rows.length === 0 ? '' :
        (canWrite('hammadde')
          ? `<div class="pl-bar"><button type="button" class="icon-btn btn-primary" data-act="mark"${st.selected.size === 0 ? ' disabled' : ''}>Seçilenleri Mikro'ya girildi işaretle (${st.selected.size})…</button>` +
            '<button type="button" class="icon-btn" data-act="select-pending">Fişi bekleyenlerin hepsini seç</button><button type="button" class="icon-btn" data-act="select-none">Seçimi temizle</button></div>'
          : '') +
        '<div class="table-wrap table-wrap-tall"><table class="tbl tbl-pl"><thead><tr><th></th><th>İş emri</th><th>Bitiş</th><th>Tezgah</th><th>Ürün</th><th>Hammadde</th><th class="num">Adet</th><th class="num">Sarfiyat (kg)</th><th class="num">Çubuk</th><th class="num">Talaş (kg)</th><th>Mikro fişi</th><th></th></tr></thead><tbody>' +
        d.rows.map((r) => {
          const done = r.fis.status === 'girildi';
          const yazabilir = canWrite('hammadde');
          return `<tr data-no="${escapeHtml(r.no)}"><td>${done || !yazabilir ? '' : `<input type="checkbox" data-role="pick" aria-label="${escapeHtml(r.no)} seç"${st.selected.has(r.no) ? ' checked' : ''}>`}</td>` +
            `<td class="mono"><b>${escapeHtml(r.no)}</b></td><td>${escapeHtml(dateTimeText(r.finishedAt))}</td><td class="mono">${escapeHtml(r.machineId)}</td>` +
            `<td class="trunc"${truncCell(r.productName)}><span class="mono">${escapeHtml(r.stockCode)}</span> ${cellText(r.productName)}</td><td class="mono trunc"${truncCell(r.material)}>${cellText(r.material)}${materialFlag(r)}</td><td class="num">${fmtNum(r.produced)}</td>` +
            `<td class="num"><b>${kg(r.kg)}</b></td><td class="num">${r.bars == null ? cellText(null) : fmtDec(r.bars, 2)}</td><td class="num">${kg(r.scrapKg)}</td>` +
            `<td>${done ? `${chip('ok', '✓', 'girildi')} ${r.fis.docNo ? `<span class="mono">${escapeHtml(r.fis.docNo)}</span>` : ''}<br><small class="hint">${kg(r.fis.kg)} kg</small>` : chip('none', '◔', 'bekliyor')}</td>` +
            `<td class="nowrap">${!yazabilir ? '' : done ? '<button type="button" class="icon-btn icon-btn-sm" data-act="undo">Geri al</button>' : '<button type="button" class="icon-btn icon-btn-sm" data-act="mark-one">Girildi…</button>'}` +
            `${r.kg != null && yazabilir ? ` <button type="button" class="icon-btn icon-btn-sm" data-act="virman-dialog" data-material="${escapeHtml(r.material ?? '')}" data-kg="${r.kg}">Virman fişi kes (Mikro)…</button>` : ''}</td></tr>`;
        }).join('') + '</tbody></table></div>') +
      (d.inProgress.length === 0 ? '' :
        '<h4 class="sub">Üretimdeki iş emirleri (henüz fiş yok)</h4><div class="table-wrap"><table class="tbl tbl-pl"><thead><tr><th>İş emri</th><th>Tezgah</th><th>Ürün</th><th>Hammadde</th><th class="num">Şimdiye kadar adet</th><th class="num">Sarfiyat (kg)</th></tr></thead><tbody>' +
        d.inProgress.map((r) => `<tr><td class="mono"><b>${escapeHtml(r.no)}</b></td><td class="mono">${escapeHtml(r.machineId)}</td><td class="trunc"${truncCell(r.productName)}><span class="mono">${escapeHtml(r.stockCode)}</span> ${cellText(r.productName)}</td>` +
          `<td class="mono trunc"${truncCell(r.material)}>${cellText(r.material)}${materialFlag(r)}</td><td class="num">${fmtNum(r.produced)}</td><td class="num">${kg(r.kg)}</td></tr>`).join('') + '</tbody></table></div>')
    );
  }

  async function loadConsumption() {
    const my = ++st.seq;
    try {
      const d = await api(`/api/planning/material/consumption?${qs()}`);
      if (my !== st.seq || st.view !== 'sarfiyat') return;
      st.data = d;
      st.selected = new Set([...st.selected].filter((no) => d.rows.some((r) => r.no === no && r.fis.status !== 'girildi')));
      $('body').innerHTML = consumptionHtml();
    } catch (err) {
      if (my === st.seq) $('body').innerHTML = `<p class="notice notice-sim">Sarfiyat alınamadı: ${escapeHtml(err.message)}</p>`;
    }
  }

  /* ------------------------------------------------------------- ihtiyaç */
  function needHtml() {
    const n = st.need;
    const t = n.totals;
    return (
      '<p class="hint">Planlanan ve üretimdeki iş emirlerinin (üretimdekiler için <b>kalan</b> adet) hammadde ihtiyacı; hammadde kullanılacaksa o, yoksa planlı hammadde esas alınır. ' +
      '"Depoda serbest" Depo stoğu sekmesindeki en son Mikro görüntüsünden gelir (hammadde koduna göre eşleşir).</p>' +
      `<div class="pl-kpis"><div class="pl-kpi"><span class="pl-kpi-l">İhtiyaç</span><span class="pl-kpi-v">${kg(t.kg)} kg</span><small class="hint">${fmtNum(t.orders)} iş emri</small></div>` +
      `<div class="pl-kpi"><span class="pl-kpi-l">Çubuk (BOY)</span><span class="pl-kpi-v">${fmtDec(t.bars, 2)}</span></div></div>` +
      (t.noWeight > 0 ? `<p class="notice notice-sim"><b>${t.noWeight} iş emrinde brüt ağırlık yok</b>: ihtiyaca katılamadı.</p>` : '') +
      (t.noMaterial > 0 ? `<p class="notice notice-sim"><b>${t.noMaterial} iş emrinde hammadde yazılı değil</b> (ürün kartını tamamlayın).</p>` : '') +
      (t.short > 0 ? `<p class="notice notice-sim"><b>${t.short} hammaddede ihtiyaç depodaki serbest stoğu aşıyor</b> (satırlarda işaretli): depoyu tazeleyin ya da tedarik planlayın.</p>` : '') +
      (t.noStock > 0 ? `<p class="notice"><b>${t.noStock} hammaddenin depo stoğunda eşleşen kodu yok</b>: Depo stoğu sekmesinden kontrol edin.</p>` : '') +
      '<h4 class="sub">Hammadde bazında</h4>' +
      (n.byMaterial.length === 0 ? '<p class="empty">Planlanan ya da üretimdeki iş emri yok.</p>' :
        '<div class="table-wrap"><table class="tbl tbl-pl"><thead><tr><th>Hammadde</th><th class="num">İş emri</th><th class="num">Kalan adet</th><th class="num">İhtiyaç (kg)</th><th class="num">Depoda serbest (kg)</th><th class="num">Eksik (kg)</th><th class="num">Çubuk (BOY)</th><th class="num">Beklenen talaş (kg)</th></tr></thead><tbody>' +
        n.byMaterial.map((g) => `<tr><td class="mono trunc"${truncCell(g.material)}><b>${cellText(g.material)}</b></td><td class="num">${fmtNum(g.orders)}</td><td class="num">${fmtNum(g.qty)}</td>` +
          `<td class="num"><b>${kg(g.kg)}</b>${g.unknownKg ? ` <small class="hint">+${g.unknownKg} ağırlıksız</small>` : ''}</td>` +
          `<td class="num">${kg(g.freeKg)}</td><td class="num">${(g.shortKg ?? 0) > 0 ? `<b>${kg(g.shortKg)}</b> ${chip('bad', '▲', 'yetersiz')}` : g.shortKg == null ? cellText(null) : '0'}</td>` +
          `<td class="num">${fmtDec(g.bars, 2)}</td><td class="num">${kg(g.scrapKg)}</td></tr>`).join('') + '</tbody></table></div>') +
      '<h4 class="sub">İş emri bazında</h4>' +
      (n.rows.length === 0 ? '' :
        '<div class="table-wrap table-wrap-tall"><table class="tbl tbl-pl"><thead><tr><th>İş emri</th><th>Durum</th><th>Tezgah</th><th>Ürün</th><th>Hammadde</th><th>Alternatif</th><th class="num">Hedef</th><th class="num">Kalan</th><th class="num">İhtiyaç (kg)</th><th class="num">Çubuk</th><th>Termin</th></tr></thead><tbody>' +
        n.rows.map((r) => `<tr><td class="mono"><b>${escapeHtml(r.no)}</b></td><td>${r.status === 'uretimde' ? chip('info', '▶', 'üretimde') : chip('none', '◔', 'planlandı')}</td><td class="mono">${escapeHtml(r.machineId)}</td>` +
          `<td class="trunc"${truncCell(r.productName)}><span class="mono">${escapeHtml(r.stockCode)}</span> ${cellText(r.productName)}</td><td class="mono trunc"${truncCell(r.material)}>${cellText(r.material)}</td><td class="mono trunc"${truncCell(r.altMaterial)}>${cellText(r.altMaterial)}</td>` +
          `<td class="num">${fmtNum(r.targetQty)}</td><td class="num">${fmtNum(r.remaining)}</td><td class="num"><b>${kg(r.kg)}</b></td><td class="num">${r.bars == null ? cellText(null) : fmtDec(r.bars, 2)}</td><td>${dateText(r.dueDate)}</td></tr>`).join('') + '</tbody></table></div>')
    );
  }

  async function loadNeed() {
    try {
      st.need = await api('/api/planning/material/need');
      if (st.view === 'ihtiyac') $('body').innerHTML = needHtml();
    } catch (err) {
      $('body').innerHTML = `<p class="notice notice-sim">İhtiyaç alınamadı: ${escapeHtml(err.message)}</p>`;
    }
  }

  /* --------------------------------------------------------- depo stogu */
  function stockHtml() {
    const d = st.stock;
    const t = d.totals;
    return (
      '<p class="hint">Mikro\'daki hammadde deposu (Kaynak klasöründen gelen en son görüntü) eksi üretime <b>ayrılan</b> ve Mikro\'ya <b>henüz girilmemiş</b> tüketim = <b>serbest</b> (kullanılabilir) kg. ' +
      'Depo miktarı yalnızca "Kaynak dosyadan yenile" ile tazelenir; iş emri bitip fiş Mikro\'ya girilince bir sonraki yenilemede kendiliğinden düşer.</p>' +
      `<div class="pl-kpis"><div class="pl-kpi"><span class="pl-kpi-l">Toplam serbest</span><span class="pl-kpi-v">${kg(t.freeKg)} kg</span><small class="hint">${fmtNum(t.materials)} hammadde</small></div></div>` +
      (t.unmatched > 0 ? `<p class="notice notice-sim"><b>${t.unmatched} hammaddenin</b> rezervasyonu var ama depo stoğunda eşleşen kodu yok (satırlarda işaretli): hammadde kodu yazım farkı olabilir, Kaynak klasöründeki stok dosyasını ya da iş emrindeki hammadde kodunu kontrol edin.</p>` : '') +
      (d.rows.length === 0 ? '<p class="empty">Depo stoğu henüz içeri alınmadı (Kaynak klasöründen "Kaynak dosyadan yenile").</p>' :
        '<div class="table-wrap"><table class="tbl tbl-pl"><thead><tr><th>Hammadde</th><th class="num">Mikro\'daki stok (kg)</th><th class="num">Ayrılan (üretimde)</th><th class="num">Mikro\'ya girilmemiş</th><th class="num">Serbest</th></tr></thead><tbody>' +
        d.rows.map((r) => `<tr><td class="mono trunc"${truncCell(r.name ? `${r.materialKey} · ${r.name}` : r.materialKey)}><b>${cellText(r.name ? `${r.materialKey} · ${r.name}` : r.materialKey)}</b>${r.stockKg == null ? ` ${chip('bad', '▲', 'depoda eşleşmedi')}` : ''}</td>` +
          `<td class="num">${kg(r.stockKg)}</td><td class="num">${r.reservedKg > 0 ? kg(r.reservedKg) : '0'}</td><td class="num">${r.unenteredKg > 0 ? kg(r.unenteredKg) : '0'}</td>` +
          `<td class="num"><b>${kg(r.freeKg)}</b>${r.freeKg != null && r.freeKg < 0 ? ` ${chip('bad', '▼', 'eksi')}` : ''}</td></tr>`).join('') + '</tbody></table></div>')
    );
  }

  async function loadStock() {
    try {
      st.stock = await api('/api/planning/material/stock');
      if (st.view === 'stok') $('body').innerHTML = stockHtml();
    } catch (err) {
      $('body').innerHTML = `<p class="notice notice-sim">Depo stoğu alınamadı: ${escapeHtml(err.message)}</p>`;
    }
  }

  /* ------------------------------------------------- hammadde karantinasi (yanlis teslimat) */

  const Q_STATUS_CHIP = {
    'aktarilamadi': (r) => chip('bad', '✕', 'aktarılamadı'),
    'karantinada': () => chip('warn', '◔', 'karantinada'),
    'iade-edildi': () => chip('ok', '✓', 'iade edildi'),
  };

  function quarantineHtml() {
    const rows = st.quarantine;
    const yazabilir = canWrite('hammadde');
    return (
      '<p class="hint">Tedarikçi yanlış hammadde gönderdiğinde: "Karantinaya aktar…" Merkez depodaki miktarı Mikro\'da Karantina depoya (Depolar Arası Sevk Fişi) aktarır. ' +
      'Tedarikçiye geri gönderilince "İade et…" aynı miktarı Karantina depodan sarf (stok virman) fişiyle tamamen düşer.</p>' +
      (yazabilir ? '<div class="pl-bar"><button type="button" class="icon-btn btn-primary" data-act="q-transfer-dialog">Karantinaya aktar…</button></div>' : '') +
      (rows.length === 0 ? '<p class="empty">Karantinaya aktarılmış hammadde yok.</p>' :
        '<div class="table-wrap"><table class="tbl tbl-pl"><thead><tr><th>Hammadde</th><th class="num">Kilo</th><th>Not</th><th>Durum</th><th>Tarih</th><th></th></tr></thead><tbody>' +
        rows.map((r) => {
          const lastErr = r.status === 'aktarilamadi' ? r.transfer.error : r.return?.status === 'basarisiz' ? r.return.error : null;
          const evrak = r.status === 'iade-edildi' && r.return?.evrakSira ? `<br><small class="hint">iade evrak ${r.return.evrakSeri ? `${escapeHtml(r.return.evrakSeri)}-` : ''}${escapeHtml(r.return.evrakSira)}</small>`
            : r.status !== 'aktarilamadi' && r.transfer.evrakSira ? `<br><small class="hint">sevk evrak ${r.transfer.evrakSeri ? `${escapeHtml(r.transfer.evrakSeri)}-` : ''}${escapeHtml(r.transfer.evrakSira)}</small>` : '';
          return `<tr data-id="${r.id}"><td class="mono trunc"${truncCell(r.stockName ? `${r.stockCode} · ${r.stockName}` : r.stockCode)}><b>${escapeHtml(r.stockCode)}</b>${r.stockName ? ` ${cellText(r.stockName)}` : ''}</td>` +
            `<td class="num">${kg(r.kg)}</td><td class="trunc"${truncCell(r.note)}>${cellText(r.note)}</td>` +
            `<td>${Q_STATUS_CHIP[r.status](r)}${lastErr ? `<br><small class="hint">${escapeHtml(lastErr)}</small>` : ''}${evrak}</td>` +
            `<td>${escapeHtml(dateTimeText(r.createdAt))}</td>` +
            `<td class="nowrap">${!yazabilir ? '' : (r.status === 'aktarilamadi' ? '<button type="button" class="icon-btn icon-btn-sm" data-act="q-retry">Yeniden dene…</button>' : '') +
              (r.status === 'karantinada' ? '<button type="button" class="icon-btn icon-btn-sm" data-act="q-return">İade et…</button>' : '') +
              (r.status !== 'karantinada' ? '<button type="button" class="icon-btn icon-btn-sm" data-act="q-delete">Sil</button>' : '')}</td></tr>`;
        }).join('') + '</tbody></table></div>')
    );
  }

  async function loadQuarantine() {
    try {
      const r = await api('/api/planning/material/quarantine');
      st.quarantine = r.items;
      if (st.view === 'karantina') $('body').innerHTML = quarantineHtml();
    } catch (err) {
      $('body').innerHTML = `<p class="notice notice-sim">Karantina listesi alınamadı: ${escapeHtml(err.message)}</p>`;
    }
  }

  /** "Karantinaya aktar…" penceresi: hammadde ara (Mikro'dan canlı) + kilo + not, "Önizle" ile Depolar Arası Sevk
   * Fişi'nin tam gövdesi gösterilir (gerçek gönderme `MIKRO_WRITE_ENABLED` olmadan KAPALI), "Gönder" hem kaydı
   * oluşturur hem Mikro'ya hemen gönderir. */
  function openMaterialQuarantineDialog() {
    const m = openModal({ title: 'Karantinaya aktar (Mikro)', wide: true });
    const dst = { material: null };
    m.body.innerHTML =
      '<form autocomplete="off"><div class="fld-grid">' +
      '<label class="fld pl-wide"><span>Hammadde (Mikro stok kodu)</span><input data-role="matQ" placeholder="Kod ya da ad ara…" autocomplete="off"></label>' +
      '<div class="pl-pick-result" data-role="matResult" hidden></div><div data-role="matList"></div>' +
      '<label class="fld"><span>Kilo</span><input data-role="kg" inputmode="decimal"></label>' +
      '<label class="fld pl-wide"><span>Not (isteğe bağlı, ör. tedarikçi/sipariş)</span><input data-role="note" maxlength="300"></label>' +
      '</div><p class="notice notice-sim" data-role="err" hidden></p>' +
      '<div class="dt-actions"><button type="button" class="icon-btn" data-act="close">Vazgeç</button><button type="button" class="icon-btn btn-primary" data-act="preview">Önizle</button></div>' +
      '<div data-role="preview"></div></form>';

    function selectMaterial(mat) {
      dst.material = mat;
      const res = m.body.querySelector('[data-role="matResult"]');
      res.hidden = false;
      res.innerHTML = `${chip('ok', '✓', 'seçildi')} <span class="mono">${escapeHtml(mat.stockCode)}</span> · ${escapeHtml(mat.name)} <button type="button" class="icon-btn icon-btn-sm" data-act="mat-clear">Değiştir</button>`;
      m.body.querySelector('[data-role="matList"]').innerHTML = '';
      m.body.querySelector('[data-role="matQ"]').value = '';
    }

    const searchMaterials = debounce(async (q) => {
      const list = m.body.querySelector('[data-role="matList"]');
      if (!list) return;
      if (q.trim() === '') { list.innerHTML = ''; return; }
      list.innerHTML = '<p class="empty">Aranıyor…</p>';
      try {
        const r = await api(`/api/planning/material/mikro/materials?${new URLSearchParams({ q, limit: 20 })}`);
        if (!m.body.contains(list)) return;
        if (r.items.length === 0) { list.innerHTML = '<p class="empty">Eşleşen hammadde yok.</p>'; return; }
        list.dataset.cache = JSON.stringify(r.items);
        list.innerHTML = '<div class="table-wrap"><table class="tbl tbl-pl"><tbody>' +
          r.items.map((x) => `<tr class="pl-row" data-act="mat-pick" data-code="${escapeHtml(x.stockCode)}" tabindex="0"><td class="mono">${escapeHtml(x.stockCode)}</td><td class="trunc"${truncCell(x.name)}>${cellText(x.name)}</td><td class="num">${cellText(x.unit)}</td></tr>`).join('') +
          '</tbody></table></div>';
      } catch (err) {
        list.innerHTML = `<p class="notice notice-sim">${escapeHtml(err.message)}</p>`;
      }
    }, 300);

    function currentInput() {
      return { stockCode: dst.material?.stockCode, stockName: dst.material?.name, kg: parseInput(m.body.querySelector('[data-role="kg"]').value), note: m.body.querySelector('[data-role="note"]').value };
    }

    function previewHtml(p) {
      return (
        (p.writeEnabled
          ? '<p class="notice">Mikro\'ya gerçek yazma AÇIK: "Gönder" gerçekten fiş oluşturur ve kalıcı bir karantina kaydı açar.</p>'
          : '<p class="notice notice-sim">Mikro\'ya gerçek yazma şu an KAPALI (inceleme/onay aşaması): "Gönder" yine de kaydı oluşturur ama Mikro\'ya hiçbir şey gitmez, kayıt "aktarılamadı" görünür ve sonra yeniden denenebilir.</p>') +
        `<pre class="code-view">${escapeHtml(JSON.stringify(p.body, null, 2))}</pre>` +
        '<div class="dt-actions"><button type="button" class="icon-btn btn-primary" data-act="send">Gönder</button></div>'
      );
    }

    m.body.addEventListener('input', (ev) => { if (ev.target.dataset.role === 'matQ') searchMaterials(ev.target.value); });
    m.body.addEventListener('click', async (ev) => {
      if (ev.target.closest('[data-act="mat-pick"]')) {
        const row = ev.target.closest('[data-act="mat-pick"]');
        const items = JSON.parse(m.body.querySelector('[data-role="matList"]').dataset.cache ?? '[]');
        const found = items.find((x) => x.stockCode === row.dataset.code);
        if (found) selectMaterial(found);
        return;
      }
      if (ev.target.closest('[data-act="mat-clear"]')) {
        dst.material = null;
        const res = m.body.querySelector('[data-role="matResult"]');
        res.hidden = true;
        res.innerHTML = '';
        return;
      }
      const err = m.body.querySelector('[data-role="err"]');
      if (ev.target.closest('[data-act="preview"]')) {
        err.hidden = true;
        if (!dst.material) { err.textContent = 'Önce hammadde seçin (arama sonuçlarından tıklayın).'; err.hidden = false; return; }
        try {
          // Merkez(1)->Karantina(5): backend/planning/product-depot.js MERKEZ_DEPO_NO / quarantine-depot.js
          // KARANTINA_DEPO_NO ile AYNI, sabit depo numaraları (gerçek `DEPOLAR` tablosundan, CLAUDE.md'de belgeli).
          // `POST /api/planning/material/quarantine` zaten bunları sunucuda sabit kullanır; bu yalnız önizleme.
          const p = await post('/api/planning/material/mikro/transfer-preview', { fromDepotNo: 1, toDepotNo: 5, ...currentInput() });
          m.body.querySelector('[data-role="preview"]').innerHTML = previewHtml(p);
        } catch (e) { err.textContent = e.message; err.hidden = false; }
        return;
      }
      const sendBtn = ev.target.closest('[data-act="send"]');
      if (sendBtn) {
        err.hidden = true;
        sendBtn.disabled = true;
        try {
          await post('/api/planning/material/quarantine', currentInput());
          m.close();
          await loadQuarantine();
        } catch (e) {
          m.body.querySelector('[data-role="preview"]').innerHTML += `<p class="notice notice-sim">${escapeHtml(e.message)} <small class="hint">Kayıt yine de oluşturuldu, "Karantina" listesinde "Yeniden dene…" ile tekrar denenebilir.</small></p>`;
          sendBtn.disabled = false;
          await loadQuarantine();
        }
      }
    });
  }

  /* --------------------------------------------------------------- fiş */
  /** Mikro'ya girildi işaretle: tek ya da toplu; toplu işaretlemede ortak evrak no. */
  function openMarkDialog(nos) {
    const single = nos.length === 1 ? st.data.rows.find((r) => r.no === nos[0]) : null;
    const m = openModal({ title: `Mikro sarfiyat fişi girildi · ${nos.length} iş emri` });
    const rows = st.data.rows.filter((r) => nos.includes(r.no));
    const total = rows.reduce((a, r) => a + (r.kg ?? 0), 0);
    m.body.innerHTML =
      `<p class="notice">Sarfiyat fişini Mikro'ya <b>kendiniz girdikten sonra</b> işaretleyin: iş emri bir daha işaretlenemez (çift fiş olmasın). Toplam hesaplanan sarfiyat: <b>${kg(Math.round(total * 1000) / 1000)} kg</b> (${rows.map((r) => escapeHtml(r.no)).join(', ')}).</p>` +
      '<form autocomplete="off"><div class="fld-grid">' +
      '<label class="fld"><span>Mikro evrak no (isteğe bağlı)</span><input name="docNo" maxlength="40"></label>' +
      (single ? `<label class="fld"><span>Fişe yazılan kg (boş = hesaplanan${single.kg == null ? '; brüt ağırlık yok: girin' : ''})</span><input name="kg" inputmode="decimal" placeholder="${single.kg == null ? '' : fmtDec(single.kg, 3)}"></label>` : '') +
      '<label class="fld pl-wide"><span>Not (isteğe bağlı)</span><input name="note" maxlength="200"></label></div>' +
      '<p class="notice notice-sim" data-role="err" hidden></p><div class="dt-actions"><button type="button" class="icon-btn" data-act="close">Vazgeç</button><button type="submit" class="icon-btn btn-primary">Girildi olarak işaretle</button></div></form>';
    const form = m.body.querySelector('form');
    form.elements.docNo.focus();
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const err = m.body.querySelector('[data-role="err"]');
      const btn = form.querySelector('[type="submit"]');
      err.hidden = true;
      btn.disabled = true;
      try {
        await post('/api/planning/material/fis', { orders: nos, docNo: form.elements.docNo.value, note: form.elements.note.value, ...(single && form.elements.kg.value.trim() !== '' ? { kg: form.elements.kg.value } : {}) });
        m.close();
        st.selected.clear();
        await loadConsumption();
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
        btn.disabled = false;
      }
    });
  }

  /* ------------------------------------- depolar arasi sevkiyat / sarfiyat (virman) fisi: Mikro YAZMA (G asamasi) */

  /**
   * Depolar arası sevkiyat ya da sarfiyat (virman) fişi penceresi: depo(lar) + hammadde (Mikro'dan canlı arama) +
   * kilo seçilir, "Önizle" ile gönderilecek tam içerik gösterilir (gerçek Mikro yazması `MIKRO_WRITE_ENABLED`
   * olmadan KAPALI — "Gönder" o zaman devre dışı kalır, sunucu da 409 ile reddeder).
   * @param {'transfer'|'virman'} kind
   * @param {{fromDepotNo?: number, toDepotNo?: number, depotNo?: number, stockQuery?: string, kg?: number, note?: string}} [initial]
   */
  function openStockMoveDialog(kind, initial = {}) {
    const isTransfer = kind === 'transfer';
    const m = openModal({ title: isTransfer ? 'Depolar arası sevkiyat (Mikro)' : 'Sarfiyat (virman) fişi kes (Mikro)', wide: true });
    const dst = { depots: null, material: null };

    function fieldsHtml() {
      const depotOpt = (v) => dst.depots.map((d) => `<option value="${d.depotNo}"${String(d.depotNo) === String(v) ? ' selected' : ''}>${escapeHtml(d.name)} (${d.depotNo})</option>`).join('');
      return (
        '<form autocomplete="off"><div class="fld-grid">' +
        (isTransfer
          ? `<label class="fld"><span>Kaynak depo</span><select data-role="from"><option value="">Seçin…</option>${depotOpt(initial.fromDepotNo)}</select></label>` +
            `<label class="fld"><span>Hedef depo</span><select data-role="to"><option value="">Seçin…</option>${depotOpt(initial.toDepotNo)}</select></label>`
          : `<label class="fld"><span>Depo</span><select data-role="depot"><option value="">Seçin…</option>${depotOpt(initial.depotNo)}</select></label>` +
            `<label class="fld"><span>Yön</span><select data-role="direction"><option value="cikan"${(initial.direction ?? 'cikan') === 'cikan' ? ' selected' : ''}>Çıkan (sarfiyat)</option><option value="giren"${initial.direction === 'giren' ? ' selected' : ''}>Giren</option></select></label>`) +
        '<label class="fld pl-wide"><span>Hammadde (Mikro stok kodu)</span>' +
        `<input data-role="matQ" placeholder="Kod ya da ad ara…" value="${escapeHtml(initial.stockQuery ?? '')}" autocomplete="off"></label>` +
        '<div class="pl-pick-result" data-role="matResult" hidden></div><div data-role="matList"></div>' +
        `<label class="fld"><span>Kilo</span><input data-role="kg" inputmode="decimal" value="${initial.kg != null ? escapeHtml(String(initial.kg)) : ''}"></label>` +
        `<label class="fld pl-wide"><span>Not (isteğe bağlı)</span><input data-role="note" maxlength="200" value="${escapeHtml(initial.note ?? '')}"></label>` +
        '</div><p class="notice notice-sim" data-role="err" hidden></p>' +
        '<div class="dt-actions"><button type="button" class="icon-btn" data-act="close">Vazgeç</button><button type="button" class="icon-btn btn-primary" data-act="preview">Önizle</button></div>' +
        '<div data-role="preview"></div></form>'
      );
    }

    function selectMaterial(mat) {
      dst.material = mat;
      const res = m.body.querySelector('[data-role="matResult"]');
      res.hidden = false;
      res.innerHTML = `${chip('ok', '✓', 'seçildi')} <span class="mono">${escapeHtml(mat.stockCode)}</span> · ${escapeHtml(mat.name)} <button type="button" class="icon-btn icon-btn-sm" data-act="mat-clear">Değiştir</button>`;
      m.body.querySelector('[data-role="matList"]').innerHTML = '';
      m.body.querySelector('[data-role="matQ"]').value = '';
    }

    const searchMaterials = debounce(async (q) => {
      const list = m.body.querySelector('[data-role="matList"]');
      if (!list) return;
      if (q.trim() === '') { list.innerHTML = ''; return; }
      list.innerHTML = '<p class="empty">Aranıyor…</p>';
      try {
        const r = await api(`/api/planning/material/mikro/materials?${new URLSearchParams({ q, limit: 20 })}`);
        if (!m.body.contains(list)) return;
        if (r.items.length === 0) { list.innerHTML = '<p class="empty">Eşleşen hammadde yok.</p>'; return; }
        list.dataset.cache = JSON.stringify(r.items);
        list.innerHTML = '<div class="table-wrap"><table class="tbl tbl-pl"><tbody>' +
          r.items.map((x) => `<tr class="pl-row" data-act="mat-pick" data-code="${escapeHtml(x.stockCode)}" tabindex="0"><td class="mono">${escapeHtml(x.stockCode)}</td><td class="trunc"${truncCell(x.name)}>${cellText(x.name)}</td><td class="num">${cellText(x.unit)}</td></tr>`).join('') +
          '</tbody></table></div>';
      } catch (err) {
        list.innerHTML = `<p class="notice notice-sim">${escapeHtml(err.message)}</p>`;
      }
    }, 300);

    function currentInput() {
      const kgVal = parseInput(m.body.querySelector('[data-role="kg"]').value);
      const note = m.body.querySelector('[data-role="note"]').value;
      const stockCode = dst.material?.stockCode;
      return isTransfer
        ? { fromDepotNo: m.body.querySelector('[data-role="from"]').value, toDepotNo: m.body.querySelector('[data-role="to"]').value, stockCode, kg: kgVal, note }
        : { depotNo: m.body.querySelector('[data-role="depot"]').value, direction: m.body.querySelector('[data-role="direction"]').value, stockCode, kg: kgVal, note };
    }

    function previewHtml(p) {
      return (
        (p.writeEnabled
          ? '<p class="notice">Mikro\'ya gerçek yazma AÇIK: "Gönder" gerçekten fiş oluşturur.</p>'
          : '<p class="notice notice-sim">Mikro\'ya gerçek yazma şu an KAPALI (inceleme/onay aşaması): bu yalnız önizlemedir, hiçbir şey gönderilmiyor.</p>') +
        '<p class="hint">Bazı alanlar (evrak tipi/tip/cins, seri, tutar) gerçek Mikro verisinden gözlenen bir örüntüye dayanıyor; göndermeden önce yönetici ile kontrol edin.</p>' +
        `<pre class="code-view">${escapeHtml(JSON.stringify(p.body, null, 2))}</pre>` +
        (kind === 'virman' ? '<p class="hint">Not: bu gönderim, "Sarfiyat ve fiş" sekmesindeki eski "elle girildi" işaretini DEĞİŞTİRMEZ; istenirse orayı da ayrıca işaretleyin.</p>' : '') +
        `<div class="dt-actions"><button type="button" class="icon-btn btn-primary" data-act="send"${p.writeEnabled ? '' : ' disabled title="Mikro yazma kapalı"'}>Gönder</button></div>`
      );
    }

    async function loadDepots() {
      try {
        const r = await api('/api/planning/material/mikro/depots');
        dst.depots = r.items;
        m.body.innerHTML = fieldsHtml();
        if (!isTransfer && !initial.depotNo) {
          const guess = dst.depots.find((d) => /rezerv|üretim/i.test(d.name));
          if (guess) m.body.querySelector('[data-role="depot"]').value = String(guess.depotNo);
        }
      } catch (err) {
        m.body.innerHTML = `<p class="notice notice-sim">Depo listesi alınamadı: ${escapeHtml(err.message)}</p>`;
      }
    }

    m.body.innerHTML = '<p class="empty">Depo listesi yükleniyor…</p>';
    m.body.addEventListener('input', (ev) => { if (ev.target.dataset.role === 'matQ') searchMaterials(ev.target.value); });
    m.body.addEventListener('click', async (ev) => {
      if (ev.target.closest('[data-act="mat-pick"]')) {
        const row = ev.target.closest('[data-act="mat-pick"]');
        const items = JSON.parse(m.body.querySelector('[data-role="matList"]').dataset.cache ?? '[]');
        const found = items.find((x) => x.stockCode === row.dataset.code);
        if (found) selectMaterial(found);
        return;
      }
      if (ev.target.closest('[data-act="mat-clear"]')) {
        dst.material = null;
        const res = m.body.querySelector('[data-role="matResult"]');
        res.hidden = true;
        res.innerHTML = '';
        return;
      }
      const err = m.body.querySelector('[data-role="err"]');
      if (ev.target.closest('[data-act="preview"]')) {
        err.hidden = true;
        if (!dst.material) { err.textContent = 'Önce hammadde seçin (arama sonuçlarından tıklayın).'; err.hidden = false; return; }
        try {
          const url = isTransfer ? '/api/planning/material/mikro/transfer-preview' : '/api/planning/material/mikro/virman-preview';
          const p = await post(url, currentInput());
          m.body.querySelector('[data-role="preview"]').innerHTML = previewHtml(p);
        } catch (e) { err.textContent = e.message; err.hidden = false; }
        return;
      }
      const sendBtn = ev.target.closest('[data-act="send"]');
      if (sendBtn) {
        err.hidden = true;
        sendBtn.disabled = true;
        try {
          const url = isTransfer ? '/api/planning/material/mikro/transfer-send' : '/api/planning/material/mikro/virman-send';
          await post(url, currentInput());
          m.body.querySelector('[data-role="preview"]').innerHTML = '<p class="notice">Gönderildi.</p>';
        } catch (e) {
          err.textContent = e.message;
          err.hidden = false;
          sendBtn.disabled = false;
        }
      }
    });
    loadDepots();
  }

  /* -------------------------------------------------------------- olaylar */
  async function show(view) {
    st.view = view;
    setViewButtons();
    $('body').innerHTML = '<p class="empty">Yükleniyor…</p>';
    if (view === 'sarfiyat') await loadConsumption();
    else if (view === 'stok') await loadStock();
    else if (view === 'karantina') await loadQuarantine();
    else await loadNeed();
  }

  host.onclick = async (ev) => {
    const view = ev.target.closest('[data-view]')?.dataset.view;
    if (view) { await show(view); return; }
    const preset = ev.target.closest('[data-preset]')?.dataset.preset;
    if (preset) {
      const p = PRESETS.find((x) => x.key === preset);
      [st.from, st.to] = p.range(new Date());
      st.preset = preset;
      await loadConsumption();
      return;
    }
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    const no = ev.target.closest('tr[data-no]')?.dataset.no;
    if (act === 'transfer-dialog') openStockMoveDialog('transfer', {});
    else if (act === 'virman-dialog') {
      const btn = ev.target.closest('[data-act="virman-dialog"]');
      const kgAttr = btn.dataset.kg;
      openStockMoveDialog('virman', { stockQuery: btn.dataset.material, kg: kgAttr === '' || kgAttr == null ? undefined : Number(kgAttr), note: no ? `İş emri ${no} sarfiyatı` : '' });
    } else if (act === 'mark-one') openMarkDialog([no]);
    else if (act === 'mark') openMarkDialog([...st.selected]);
    else if (act === 'select-pending') { st.selected = new Set(st.data.rows.filter((r) => r.fis.status !== 'girildi').map((r) => r.no)); $('body').innerHTML = consumptionHtml(); }
    else if (act === 'select-none') { st.selected.clear(); $('body').innerHTML = consumptionHtml(); }
    else if (act === 'undo') {
      if (!window.confirm(`${no} için "Mikro fişi girildi" işareti geri alınsın mı? (Mikro'daki fişi silmez; yalnız bu ekrandaki işareti kaldırır.)`)) return;
      try { await post('/api/planning/material/fis/undo', { orders: [no] }); await loadConsumption(); } catch (e) { window.alert(e.message); }
    } else if (act === 'q-transfer-dialog') openMaterialQuarantineDialog();
    else if (act === 'q-retry' || act === 'q-return' || act === 'q-delete') {
      const id = ev.target.closest('tr[data-id]')?.dataset.id;
      if (!id) return;
      if (act === 'q-retry') {
        try { await post(`/api/planning/material/quarantine/${id}/retry-transfer`, {}); await loadQuarantine(); } catch (e) { window.alert(e.message); }
      } else if (act === 'q-return') {
        if (!window.confirm('Bu hammadde Karantina depodan sarf (stok virman, çıkan) fişiyle TAMAMEN düşülecek — Mikro\'nun defterinden çıkar, GERİ ALINAMAZ. Tedarikçiye gerçekten iade edildiyse onaylayın.')) return;
        try { await post(`/api/planning/material/quarantine/${id}/return`, {}); await loadQuarantine(); } catch (e) { window.alert(e.message); }
      } else {
        if (!window.confirm('Bu kayıt silinsin mi? (Yalnız bu listedeki kaydı siler; Mikro\'da gerçekleşmiş bir hareket varsa onu DEĞİŞTİRMEZ.)')) return;
        try { await api(`/api/planning/material/quarantine/${id}`, { method: 'DELETE' }); await loadQuarantine(); } catch (e) { window.alert(e.message); }
      }
    }
  };
  host.onchange = async (ev) => {
    const role = ev.target.dataset?.role;
    if (role === 'from' || role === 'to') {
      if (role === 'from') st.from = ev.target.value; else st.to = ev.target.value;
      st.preset = '';
      if (st.from && st.to) await loadConsumption();
    } else if (role === 'fis') { st.fis = ev.target.value; await loadConsumption(); }
    else if (role === 'pick') {
      const no = ev.target.closest('tr[data-no]').dataset.no;
      if (ev.target.checked) st.selected.add(no); else st.selected.delete(no);
      const btn = host.querySelector('[data-act="mark"]');
      if (btn) { btn.disabled = st.selected.size === 0; btn.textContent = `Seçilenleri Mikro'ya girildi işaretle (${st.selected.size})…`; }
    }
  };

  await show('sarfiyat');
}
