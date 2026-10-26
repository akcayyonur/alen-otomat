/**
 * Planlama > Hammadde (yalnız yönetici): hammadde İHTİYACI, gerçekleşen SARFİYAT ve Mikro sarfiyat fişi takibi (D aşaması).
 *
 * Sarfiyat TEORİKTİR: tezgahın işlediği tüm parça (sayaç) × brüt gramaj, kg olarak; çubuk sayısı (BOY) bilgidir. Mikro'ya yazma API'si doğrulanana
 * kadar fiş ELLE girilir: burada kesilecek fiş listelenir, ofis Mikro'ya girer ve "girildi" işaretler (evrak no ile); girilen iş emri tekrar işaretlenemez
 * (çift fiş olmasın). Hesaplar sunucuda (backend/planning/material.js); ekran ve CSV aynı sayıları kullanır.
 */
import { escapeHtml } from './format.js';
import { api, post } from './lib-common.js';
import { cellText, fmtNum, fmtDec, dateText, dateTimeText, openModal, chip, sectionClosed, truncCell, RANGE_PRESETS as PRESETS } from './planning-common.js';

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
  const st = { view: 'sarfiyat', preset: 'ay', from: PRESETS[1].range(now)[0], to: PRESETS[1].range(now)[1], fis: 'tumu', data: null, need: null, stock: null, selected: new Set(), seq: 0 };
  host.innerHTML =
    '<div class="seg pl-tabs" role="group" aria-label="Hammadde bölümleri" data-role="views">' +
    '<button type="button" data-view="sarfiyat">Sarfiyat ve fiş</button><button type="button" data-view="ihtiyac">İhtiyaç</button><button type="button" data-view="stok">Depo stoğu</button></div>' +
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
        `<div class="pl-bar"><button type="button" class="icon-btn btn-primary" data-act="mark"${st.selected.size === 0 ? ' disabled' : ''}>Seçilenleri Mikro'ya girildi işaretle (${st.selected.size})…</button>` +
        '<button type="button" class="icon-btn" data-act="select-pending">Fişi bekleyenlerin hepsini seç</button><button type="button" class="icon-btn" data-act="select-none">Seçimi temizle</button></div>' +
        '<div class="table-wrap table-wrap-tall"><table class="tbl tbl-pl"><thead><tr><th></th><th>İş emri</th><th>Bitiş</th><th>Tezgah</th><th>Ürün</th><th>Hammadde</th><th class="num">Adet</th><th class="num">Sarfiyat (kg)</th><th class="num">Çubuk</th><th class="num">Talaş (kg)</th><th>Mikro fişi</th><th></th></tr></thead><tbody>' +
        d.rows.map((r) => {
          const done = r.fis.status === 'girildi';
          return `<tr data-no="${escapeHtml(r.no)}"><td>${done ? '' : `<input type="checkbox" data-role="pick" aria-label="${escapeHtml(r.no)} seç"${st.selected.has(r.no) ? ' checked' : ''}>`}</td>` +
            `<td class="mono"><b>${escapeHtml(r.no)}</b></td><td>${escapeHtml(dateTimeText(r.finishedAt))}</td><td class="mono">${escapeHtml(r.machineId)}</td>` +
            `<td class="trunc"${truncCell(r.productName)}><span class="mono">${escapeHtml(r.stockCode)}</span> ${cellText(r.productName)}</td><td class="mono trunc"${truncCell(r.material)}>${cellText(r.material)}${materialFlag(r)}</td><td class="num">${fmtNum(r.produced)}</td>` +
            `<td class="num"><b>${kg(r.kg)}</b></td><td class="num">${r.bars == null ? cellText(null) : fmtDec(r.bars, 2)}</td><td class="num">${kg(r.scrapKg)}</td>` +
            `<td>${done ? `${chip('ok', '✓', 'girildi')} ${r.fis.docNo ? `<span class="mono">${escapeHtml(r.fis.docNo)}</span>` : ''}<br><small class="hint">${kg(r.fis.kg)} kg</small>` : chip('none', '◔', 'bekliyor')}</td>` +
            `<td class="nowrap">${done ? '<button type="button" class="icon-btn icon-btn-sm" data-act="undo">Geri al</button>' : '<button type="button" class="icon-btn icon-btn-sm" data-act="mark-one">Girildi…</button>'}</td></tr>`;
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

  /* -------------------------------------------------------------- olaylar */
  async function show(view) {
    st.view = view;
    setViewButtons();
    $('body').innerHTML = '<p class="empty">Yükleniyor…</p>';
    if (view === 'sarfiyat') await loadConsumption();
    else if (view === 'stok') await loadStock();
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
    if (act === 'mark-one') openMarkDialog([no]);
    else if (act === 'mark') openMarkDialog([...st.selected]);
    else if (act === 'select-pending') { st.selected = new Set(st.data.rows.filter((r) => r.fis.status !== 'girildi').map((r) => r.no)); $('body').innerHTML = consumptionHtml(); }
    else if (act === 'select-none') { st.selected.clear(); $('body').innerHTML = consumptionHtml(); }
    else if (act === 'undo') {
      if (!window.confirm(`${no} için "Mikro fişi girildi" işareti geri alınsın mı? (Mikro'daki fişi silmez; yalnız bu ekrandaki işareti kaldırır.)`)) return;
      try { await post('/api/planning/material/fis/undo', { orders: [no] }); await loadConsumption(); } catch (e) { window.alert(e.message); }
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
