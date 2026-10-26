/**
 * Planlama > Verimlilik (yalnız yönetici): bugünkü "Üretim Kartı Verileri" Excel'inin otomatik karşılığı (E aşaması).
 *
 * Görünümler: Özet (tezgah, ürün, gün bazında), Matris (tezgah × gün × vardiya verimliliği), Günlük kartlar (tezgah × vardiya × ürün satırları),
 * Duruşlar (neden kodu dakikaları, nedeni belirsiz kalanlar). Hesaplar sunucuda (backend/planning/efficiency.js); ekran ve CSV aynı sayıları kullanır.
 *
 *   Verimlilik % = kazanılan süre ÷ ayrılan süre   (kazanılan = adet × planlanan çevrim; ayrılan = iş emri penceresi ∩ vardiya; toplamlar süre ağırlıklı)
 *   Kullanılabilirlik (A) = RUNNING süresi ÷ ölçülen süre;  Performans (P) = planlanan çevrim ÷ ölçülen çevrim;  verimlilik ≈ A × P (yaklaşık).
 *   Kalite (fire) ölçülmez: ret/hurda tutulmaz.
 *
 * Görsel kurallar (dataviz): sayılar her zaman yazılı; renk tek başına anlam taşımaz (▼ düşük, ▲ planlananın üstü işaretleri); matriste tek ton (vurgu rengi),
 * koyu = yüksek; çubuklar tek renk, değere göre ton değiştirmez.
 */
import { escapeHtml } from './format.js';
import { api } from './lib-common.js';
import { cellText, fmtNum, fmtDec, dateText, dateTimeText, chip, put, truncCell, RANGE_PRESETS } from './planning-common.js';

const pct = (v) => (v == null ? '<span class="is-null">—</span>' : `${fmtDec(v * 100, 1)}%`);
const hours = (sec) => (sec == null ? '<span class="is-null">—</span>' : fmtDec(sec / 3600, 1));
const kgText = (v) => (v == null ? '<span class="is-null">—</span>' : fmtDec(v, 1));
const dayText = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' }); };
const EFF_LOW = 0.8;
const EFF_OVER = 1.05;

/** Verimlilik hücresi: sayı + işaret (▼ düşük / ▲ planlananın üstü) + tek renkli çubuk. */
function effCell(v) {
  if (v == null) return '<span class="is-null">—</span>';
  const mark = v < EFF_LOW ? '<span class="eff-mark" aria-label="düşük">▼</span>' : v > EFF_OVER ? '<span class="eff-mark" aria-label="planlananın üstünde">▲</span>' : '';
  return `<span class="eff-cell"><span class="eff-num">${fmtDec(v * 100, 1)}%</span>${mark}<span class="eff-bar${v > EFF_OVER ? ' is-over' : ''}"><i style="width:${Math.min(100, v * 100)}%"></i></span></span>`;
}

/** @param {HTMLElement} host */
export async function renderEfficiency(host) {
  const now = new Date();
  const st = { view: 'ozet', preset: 'ay', from: RANGE_PRESETS[1].range(now)[0], to: RANGE_PRESETS[1].range(now)[1], machine: '', eff: null, down: null, machines: [], seq: 0 };
  host.innerHTML =
    '<div class="seg pl-tabs" role="group" aria-label="Verimlilik görünümleri" data-role="views">' +
    '<button type="button" data-view="ozet">Özet</button><button type="button" data-view="matris">Matris</button>' +
    '<button type="button" data-view="gunluk">Günlük kartlar</button><button type="button" data-view="durus">Duruşlar</button></div>' +
    '<div data-role="controls"></div><div data-role="body"></div>';
  const $ = (r) => host.querySelector(`[data-role="${r}"]`);
  try { st.machines = (await api('/api/planning/summary')).machines; } catch { /* tezgah süzgeci olmadan da çalışır */ }

  const qs = () => new URLSearchParams({ from: st.from, to: st.to, ...(st.machine ? { machine: st.machine } : {}) }).toString();
  const csv = (kind, view, label) => `<a class="icon-btn" href="/api/planning/${kind}.csv?${qs()}&view=${view}" download>${label}</a>`;

  function controls() {
    const links = {
      ozet: csv('efficiency', 'tezgah', 'CSV · tezgah') + csv('efficiency', 'urun', 'CSV · ürün'),
      matris: csv('efficiency', 'matris', 'CSV · matris (uzun biçim)'),
      gunluk: csv('efficiency', 'gunluk', 'CSV · günlük kartlar'),
      durus: csv('downtime-report', 'durus', 'CSV · duruşlar') + csv('downtime-report', 'durus-kod-gun', 'CSV · kod × gün'),
    }[st.view];
    for (const b of host.querySelectorAll('[data-view]')) {
      const on = b.dataset.view === st.view;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    $('controls').innerHTML =
      '<div class="pl-bar">' +
      '<div class="seg" role="group" aria-label="Tarih aralığı">' + RANGE_PRESETS.map((p) => `<button type="button" data-preset="${p.key}" class="${st.preset === p.key ? 'is-on' : ''}">${p.label}</button>`).join('') + '</div>' +
      `<label class="fld-inline">Başlangıç <input type="date" data-role="from" value="${escapeHtml(st.from)}"></label>` +
      `<label class="fld-inline">Bitiş <input type="date" data-role="to" value="${escapeHtml(st.to)}"></label>` +
      `<label class="fld-inline">Tezgah <select data-role="machine"><option value="">Tümü</option>${st.machines.map((m) => `<option value="${escapeHtml(m.id)}"${st.machine === m.id ? ' selected' : ''}>${escapeHtml(m.id)}</option>`).join('')}</select></label>` +
      `${links}</div>`;
  }

  const tile = (label, value, sub = '', hero = false) => `<div class="pl-kpi${hero ? ' is-hero' : ''}"><span class="pl-kpi-l">${label}</span><span class="pl-kpi-v">${value}</span>${sub ? `<small class="hint">${sub}</small>` : ''}</div>`;
  const warnings = (list) => (list.length ? `<ul class="checks">${list.map((w) => `<li class="check check-warn"><span class="check-ic" aria-hidden="true">▲</span><div>${escapeHtml(w)}</div></li>`).join('')}</ul>` : '');
  const explain = '<details class="grp"><summary>Nasıl hesaplanır?</summary><div class="grp-body"><p class="hint">' +
    '<b>Verimlilik</b> = kazanılan süre ÷ ayrılan süre (kazanılan = adet × planlanan çevrim; ayrılan = iş emrinin vardiyadaki süresi). Toplamlar süre ağırlıklıdır. ' +
    '<b>A</b> = çalışma süresi ÷ ölçülen süre, <b>P</b> = planlanan ÷ ölçülen çevrim; verimlilik ≈ A × P (yaklaşık). Kalite (fire) ölçülmez.</p></div></details>';

  /* ---------------------------------------------------------------- özet */
  function ozet() {
    const d = st.eff;
    const t = d.totals;
    return (
      explain +
      '<div class="pl-kpis">' +
      tile('Verimlilik', pct(t.efficiency), `${fmtNum(t.orders)} iş emri · ${hours(t.allottedSec)} sa ayrılan`, true) + tile('Kullanılabilirlik (A)', pct(t.availability), t.coverage != null ? `veri kapsamı ${pct(t.coverage)}` : '') + tile('Performans (P)', pct(t.performance)) +
      tile('Adet', fmtNum(t.qty), t.avgDailyQty != null ? `günlük ort. ${fmtNum(t.avgDailyQty)} · ${t.days} gün` : '') + tile('Brüt / net', `${kgText(t.grossKg)} / ${kgText(t.netKg)} kg`) + tile('Beklenen talaş', `${kgText(t.scrapKg)} kg`) + '</div>' +
      warnings(d.warnings) +
      (d.atRisk.length
        ? '<h4 class="sub">Termin riski olan iş emirleri</h4><div class="table-wrap"><table class="tbl tbl-pl"><thead><tr><th>İş emri</th><th>Tezgah</th><th>Ürün</th><th class="num">Kalan</th><th>Termin</th><th>Tahmini bitiş</th></tr></thead><tbody>' +
          d.atRisk.map((r) => `<tr><td class="mono"><b>${escapeHtml(r.no)}</b></td><td class="mono">${escapeHtml(r.machineId)}</td><td class="trunc"${truncCell(r.productName)}><span class="mono">${escapeHtml(r.stockCode)}</span> ${cellText(r.productName)}</td><td class="num">${fmtNum(r.remaining)}</td><td>${dateText(r.dueDate)}</td><td>${escapeHtml(dateTimeText(r.etaMs))} ${chip('bad', '▲', 'termin riski')}</td></tr>`).join('') + '</tbody></table></div>'
        : '') +
      '<h4 class="sub">Tezgah bazında</h4>' +
      '<div class="table-wrap"><table class="tbl tbl-pl"><thead><tr><th>Tezgah</th><th class="num">Ayrılan (sa)</th><th class="num">Adet</th><th>Verimlilik</th><th class="num">A</th><th class="num">P</th><th class="num">Brüt (kg)</th><th class="num">Net (kg)</th><th class="num">Talaş (kg)</th></tr></thead><tbody>' +
      d.machines.map((m) => `<tr><td class="mono"><b>${escapeHtml(m.machineId)}</b></td><td class="num">${hours(m.allottedSec)}</td><td class="num">${fmtNum(m.qty)}</td><td>${effCell(m.efficiency)}</td><td class="num">${pct(m.availability)}</td><td class="num">${pct(m.performance)}</td><td class="num">${kgText(m.grossKg)}</td><td class="num">${kgText(m.netKg)}</td><td class="num">${kgText(m.scrapKg)}</td></tr>`).join('') + '</tbody></table></div>' +
      '<h4 class="sub">Ürün bazında</h4>' +
      (d.products.length === 0 ? '<p class="empty">Bu aralıkta üretim yok.</p>' :
        '<p class="hint">Gerçekleşen = ayrılan süre ÷ adet (duruş ve yükleme kaybı dahil); ölçülen çevrim kontrolcü sayacıdır. Verimlilik %105\'in üstündeyse planlanan süre fazla temkinli olabilir: öneri çıkar (otomatik değişmez).</p>' +
        '<div class="table-wrap"><table class="tbl tbl-pl"><thead><tr><th>Ürün</th><th class="num">Ayrılan (sa)</th><th class="num">Adet</th><th class="num">Planlanan (sn)</th><th class="num">Ölçülen çevrim (sn)</th><th class="num">Gerçekleşen (sn)</th><th>Verimlilik</th><th class="num">A</th><th class="num">P</th><th></th></tr></thead><tbody>' +
        d.products.map((p) => `<tr><td class="trunc"${truncCell(p.productName)}><span class="mono"><b>${escapeHtml(p.stockCode)}</b></span> ${cellText(p.productName)}</td><td class="num">${hours(p.allottedSec)}</td><td class="num">${fmtNum(p.qty)}</td><td class="num">${p.plannedSec == null ? cellText(null) : fmtDec(p.plannedSec, 1)}</td>` +
          `<td class="num">${p.measuredCycleSec == null ? cellText(null) : fmtDec(p.measuredCycleSec, 1)}</td><td class="num">${p.realizedSec == null ? cellText(null) : fmtDec(p.realizedSec, 1)}</td><td>${effCell(p.efficiency)}</td><td class="num">${pct(p.availability)}</td><td class="num">${pct(p.performance)}</td>` +
          `<td class="nowrap">${p.suggestion ? `<button type="button" class="icon-btn icon-btn-sm" data-act="suggest" data-code="${escapeHtml(p.stockCode)}" data-sec="${p.suggestion.plannedSec}">Planlanan süreyi ${fmtDec(p.suggestion.plannedSec, 1)} sn yap…</button>` : ''}</td></tr>`).join('') + '</tbody></table></div>') +
      '<h4 class="sub">Gün bazında (tüm tezgahlar)</h4>' +
      (d.days.length === 0 ? '<p class="empty">Bu aralıkta üretim yok.</p>' :
        '<div class="table-wrap"><table class="tbl tbl-pl"><thead><tr><th>Üretim günü</th><th class="num">Adet</th><th>Gündüz</th><th>Gece</th><th>Gün</th></tr></thead><tbody>' +
        d.days.map((x) => `<tr><td>${escapeHtml(dayText(x.date))}</td><td class="num">${fmtNum(x.qty)}</td><td>${effCell(x.shifts.gunduz?.efficiency)}</td><td>${effCell(x.shifts.gece?.efficiency)}</td><td>${effCell(x.efficiency)}</td></tr>`).join('') + '</tbody></table></div>')
    );
  }

  /* -------------------------------------------------------------- matris */
  function matris() {
    const d = st.eff;
    const dates = d.days.map((x) => x.date);
    if (dates.length === 0) return '<p class="empty">Bu aralıkta üretim yok.</p>';
    const SH = [{ id: 'gunduz', label: 'G', title: 'Gündüz' }, { id: 'gece', label: 'N', title: 'Gece' }];
    const cellMap = new Map(d.matrix.map((x) => [`${x.date}|${x.shiftId}|${x.machineId}`, x]));
    const heat = (v) => (v == null ? '' : ` style="--p:${Math.round(Math.max(6, Math.min(55, ((v - 0.4) / 0.7) * 55)))}"`);
    const cell = (v, title) => (v == null
      ? `<td class="heat is-empty" title="${escapeHtml(title)}">—</td>`
      : `<td class="heat"${heat(v)} title="${escapeHtml(title)}">${fmtDec(v * 100, 0)}${v < EFF_LOW ? '<sup aria-label="düşük">▼</sup>' : v > EFF_OVER ? '<sup aria-label="planlananın üstünde">▲</sup>' : ''}</td>`);
    return (
      `<p class="hint">Hücre = verimlilik %. Koyu ton = yüksek; <b>▼</b> %${EFF_LOW * 100}'in altı, <b>▲</b> %${EFF_OVER * 100}'in üstü (planlanan süre fazla temkinli olabilir). G = Gündüz, N = Gece vardiyası; boş = o vardiyada iş emri yok. Üzerine gelince adet ve ayrılan süre görünür.</p>` +
      '<div class="table-wrap table-wrap-tall"><table class="tbl heat-tbl"><thead><tr><th rowspan="2">Tezgah</th>' +
      dates.map((dt) => `<th colspan="2">${escapeHtml(dayText(dt))}</th>`).join('') + '<th rowspan="2">Toplam</th></tr><tr>' +
      dates.map(() => SH.map((s) => `<th title="${s.title}">${s.label}</th>`).join('')).join('') + '</tr></thead><tbody>' +
      d.machines.map((m) => `<tr><th class="mono">${escapeHtml(m.machineId)}</th>` + dates.map((dt) => SH.map((s) => {
        const x = cellMap.get(`${dt}|${s.id}|${m.machineId}`);
        return cell(x?.efficiency ?? null, x ? `${m.machineId} · ${dayText(dt)} ${s.title}: ${fmtNum(x.qty)} adet, ${hours(x.allottedSec)} sa ayrılan${x.unassignedSec ? `, ${hours(x.unassignedSec)} sa iş emri yok` : ''}` : `${m.machineId} · ${dayText(dt)} ${s.title}: iş emri yok`);
      }).join('')).join('') + `<td class="heat-total">${m.efficiency == null ? '—' : `<b>${fmtDec(m.efficiency * 100, 1)}%</b>`}</td></tr>`).join('') +
      '</tbody><tfoot><tr><th>Tüm tezgahlar</th>' + d.days.map((x) => SH.map((s) => cell(x.shifts[s.id]?.efficiency ?? null, `${dayText(x.date)} ${s.title}: tüm tezgahlar`)).join('')).join('') +
      `<td class="heat-total"><b>${d.totals.efficiency == null ? '—' : `${fmtDec(d.totals.efficiency * 100, 1)}%`}</b></td></tr></tfoot></table></div>`
    );
  }

  /* ------------------------------------------------------------- günlük */
  function gunluk() {
    const d = st.eff;
    if (d.segments.length === 0) return '<p class="empty">Bu aralıkta üretim yok.</p>';
    return (
      '<p class="hint">Aylık üretim kartının günlük satırları: tezgah × vardiya × ürün. Hedef adet = ayrılan süre ÷ planlanan çevrim.</p>' +
      '<div class="table-wrap table-wrap-tall"><table class="tbl tbl-pl"><thead><tr><th>Tarih</th><th>Vardiya</th><th>Tezgah</th><th>İş emri</th><th>Ürün</th><th class="num">Ayrılan (sa)</th><th class="num">Planlanan (sn)</th><th class="num">Hedef</th><th class="num">Adet</th><th>Verimlilik</th><th class="num">A</th><th class="num">P</th><th class="num">Brüt (kg)</th><th class="num">Net (kg)</th><th class="num">Talaş (kg)</th></tr></thead><tbody>' +
      d.segments.slice().sort((a, b) => (a.date === b.date ? a.shiftId.localeCompare(b.shiftId) || a.machineId.localeCompare(b.machineId) : a.date < b.date ? -1 : 1)).map((x) => {
        const planned = x.plannedSec;
        const eff = planned ? (x.qty * planned) / x.allottedSec : null;
        const avail = x.observedSec > 0 ? x.runningSec / x.observedSec : null;
        const perf = planned && x.cycleSum > 0 ? (planned * x.cycleN) / x.cycleSum : null;
        return `<tr><td>${escapeHtml(dayText(x.date))}</td><td>${escapeHtml(x.label)}</td><td class="mono">${escapeHtml(x.machineId)}</td><td class="mono">${escapeHtml(x.woNo)}</td><td class="trunc"${truncCell(x.productName)}><span class="mono">${escapeHtml(x.stockCode)}</span> ${cellText(x.productName)}</td>` +
          `<td class="num">${hours(x.allottedSec)}</td><td class="num">${planned == null ? cellText(null) : fmtDec(planned, 1)}</td><td class="num">${planned ? fmtNum(Math.round(x.allottedSec / planned)) : cellText(null)}</td><td class="num"><b>${fmtNum(x.qty)}</b>${x.approxQty ? ' *' : ''}</td>` +
          `<td>${effCell(eff)}</td><td class="num">${pct(avail)}</td><td class="num">${pct(perf)}</td>` +
          `<td class="num">${x.grossKg == null ? cellText(null) : kgText(x.qty * x.grossKg)}</td><td class="num">${x.netKg == null ? cellText(null) : kgText(x.qty * x.netKg)}</td><td class="num">${x.grossKg == null || x.netKg == null ? cellText(null) : kgText(x.qty * (x.grossKg - x.netKg))}</td></tr>`;
      }).join('') + '</tbody></table></div>' +
      (d.segments.some((x) => x.approxQty) ? '<p class="hint">* veri kopukluğundan sonra sayılan adet içerir (adet gerçek, vardiyası yaklaşık).</p>' : '')
    );
  }

  /* ------------------------------------------------------------- duruşlar */
  function durus() {
    const d = st.down;
    const t = d.totals;
    const totalMin = t.reasonMin;
    const days = [...new Set([...d.rows.map((x) => x.date), ...d.unknown.map((x) => x.date)])].sort();
    const cell = new Map();
    for (const x of d.rows) cell.set(`${x.code}|${x.date}`, (cell.get(`${x.code}|${x.date}`) ?? 0) + x.minutes);
    for (const x of d.unknown) cell.set(`—|${x.date}`, (cell.get(`—|${x.date}`) ?? 0) + x.minutes);
    const codes = [...d.codes.map((c) => [c.code, c.name]), ['—', 'Nedeni belirsiz']];
    return (
      '<p class="hint">Süre telemetriden ölçülür (boşta/alarm/kapalı, ' + d.minStopMinutes + ' dk\'dan uzun); neden operatörün seçtiği koddur. <b>Nedeni belirsiz</b> = ölçülmüş ama kodlanmamış duruş. Gün = üretim günü (gece vardiyası başladığı güne yazılır).</p>' +
      '<div class="pl-kpis">' + tile('Ölçülen duruş', `${fmtDec(t.stopMin, 0)} dk`, `${fmtDec(t.stopMin / 60, 1)} sa`, true) + tile('Nedeni girilen', `${fmtDec(t.reasonMin, 0)} dk`) +
      tile('Nedeni belirsiz', `${fmtDec(t.unknownMin, 0)} dk`, t.unknownMin > 0 ? 'Tezgah başı › Duruşlar\'dan girilir' : '') + tile('Kapsama', pct(t.coverage), 'neden girilen ÷ ölçülen') + '</div>' +
      '<h4 class="sub">Neden koduna göre</h4>' +
      (d.codes.length === 0 ? '<p class="empty">Bu aralıkta nedeni girilmiş duruş yok.</p>' :
        '<div class="table-wrap"><table class="tbl tbl-pl"><thead><tr><th>Kod</th><th>Duruş nedeni</th><th class="num">Dakika</th><th>Pay</th></tr></thead><tbody>' +
        d.codes.map((c) => `<tr><td class="mono"><b>${escapeHtml(c.code)}</b></td><td class="trunc" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}${c.kind === 'Z' ? ` ${chip('info', 'ℹ', 'devir düşüklüğü')}` : ''}</td><td class="num">${fmtDec(c.minutes, 0)}</td><td><span class="eff-cell"><span class="eff-num">${totalMin > 0 ? fmtDec((c.minutes / totalMin) * 100, 1) : '0'}%</span><span class="eff-bar"><i style="width:${totalMin > 0 ? (c.minutes / totalMin) * 100 : 0}%"></i></span></span></td></tr>`).join('') + '</tbody></table></div>') +
      '<h4 class="sub">Tezgah bazında</h4>' +
      '<div class="table-wrap"><table class="tbl tbl-pl"><thead><tr><th>Tezgah</th><th class="num">Ölçülen (dk)</th><th class="num">Nedeni girilen (dk)</th><th class="num">Belirsiz (dk)</th><th class="num">Kapsama</th></tr></thead><tbody>' +
      d.machines.map((m) => `<tr><td class="mono"><b>${escapeHtml(m.machineId)}</b></td><td class="num">${fmtDec(m.stopMin, 0)}</td><td class="num">${fmtDec(m.reasonMin, 0)}</td><td class="num">${m.unknownMin > 0 ? `<b>${fmtDec(m.unknownMin, 0)}</b>` : '0'}</td><td class="num">${pct(m.coverage)}</td></tr>`).join('') + '</tbody></table></div>' +
      '<h4 class="sub">Kod × gün (dakika)</h4>' +
      (days.length === 0 ? '<p class="empty">Veri yok.</p>' : days.length > 31 ? '<p class="hint">Aralık 31 günden uzun: tablo için aralığı daraltın ya da CSV indirin (kod × gün).</p>' :
        '<div class="table-wrap table-wrap-tall"><table class="tbl tbl-pl"><thead><tr><th>Kod</th><th>Duruş nedeni</th>' + days.map((x) => `<th class="num">${escapeHtml(dayText(x))}</th>`).join('') + '<th class="num">Toplam</th></tr></thead><tbody>' +
        codes.map(([code, name]) => {
          const vals = days.map((x) => cell.get(`${code}|${x}`) ?? null);
          const sum = vals.reduce((a, v) => a + (v ?? 0), 0);
          if (sum === 0) return '';
          return `<tr><td class="mono"><b>${escapeHtml(code)}</b></td><td class="trunc" title="${escapeHtml(name)}">${escapeHtml(name)}</td>${vals.map((v) => `<td class="num">${v == null ? '<span class="is-null">·</span>' : fmtDec(v, 0)}</td>`).join('')}<td class="num"><b>${fmtDec(sum, 0)}</b></td></tr>`;
        }).join('') + '</tbody></table></div>')
    );
  }

  /* --------------------------------------------------------------- yükleme */
  async function load() {
    const my = ++st.seq;
    controls();
    $('body').innerHTML = '<p class="empty">Yükleniyor…</p>';
    try {
      if (st.view === 'durus') {
        const d = await api(`/api/planning/downtime-report?${qs()}`);
        if (my !== st.seq) return;
        st.down = d;
        $('body').innerHTML = durus();
      } else {
        const d = await api(`/api/planning/efficiency?${qs()}`);
        if (my !== st.seq) return;
        st.eff = d;
        $('body').innerHTML = st.view === 'matris' ? matris() : st.view === 'gunluk' ? gunluk() : ozet();
      }
    } catch (err) {
      if (my === st.seq) $('body').innerHTML = `<p class="notice notice-sim">Rapor alınamadı: ${escapeHtml(err.message)}</p>`;
    }
  }

  host.onclick = async (ev) => {
    const view = ev.target.closest('[data-view]')?.dataset.view;
    if (view) { st.view = view; await load(); return; }
    const preset = ev.target.closest('[data-preset]')?.dataset.preset;
    if (preset) {
      const p = RANGE_PRESETS.find((x) => x.key === preset);
      [st.from, st.to] = p.range(new Date());
      st.preset = preset;
      await load();
      return;
    }
    const sug = ev.target.closest('[data-act="suggest"]');
    if (sug) {
      const sec = Number(sug.dataset.sec);
      if (!window.confirm(`${sug.dataset.code} ürün kartının planlanan çevrim süresi ${fmtDec(sec, 1)} sn olarak güncellensin mi? Sonraki iş emirleri bu süreyi kopyalar; açık iş emirleri ve geçmiş raporlar değişmez.`)) return;
      try {
        await put(`/api/planning/products/${encodeURIComponent(sug.dataset.code)}`, { plannedSec: sec });
        sug.outerHTML = '<small class="hint">Ürün kartına yazıldı.</small>';
      } catch (e) { window.alert(e.message); }
    }
  };
  host.onchange = async (ev) => {
    const role = ev.target.dataset?.role;
    if (role === 'from' || role === 'to') {
      if (role === 'from') st.from = ev.target.value; else st.to = ev.target.value;
      st.preset = '';
      if (st.from && st.to) await load();
    } else if (role === 'machine') { st.machine = ev.target.value; await load(); }
  };

  await load();
}
