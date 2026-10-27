/**
 * Uretim adetleri: (1) tezgah detayindaki "vardiya adetleri" paneli, (2) "Uretim raporu" ekrani.
 *
 * Her ikisi de /api/production'dan gelir; toplamlar sunucuda hesaplanir (ekran ve CSV ayni sayilari gosterir).
 * Program gecisleri (hangi program hangi saatte devreye girdi, ne zaman bitti) /api/production/runs'tan gelir.
 * Panelde ve raporda tarih secimi: tek gun (takvim ya da onceki/sonraki dugmeleri) ya da aralik (baslangic-bitis, hazir secimler).
 * "Urun" = kontrolcunun calistirdigi program adi. Yanindaki sure, parca basina ORTALAMA cevrim suresidir
 * (kontrolcunun cevrim sayacinin parca artmadan onceki tepe degeri); bilinmiyorsa yazilmaz.
 * Izleyici (viewer) rolu de gorur: tezgah ag bilgisi icermez.
 */
import { escapeHtml, num, dur } from './format.js';
import { api } from './lib-common.js';
import { lineChart, barChart } from './charts.js';

const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const WEEKDAYS = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
const UNKNOWN_PROGRAM = '(program bilinmiyor)';
const REFRESH_MS = 15_000;

const dayLabel = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y} ${WEEKDAYS[new Date(y, m - 1, d).getDay()]}`;
};
const shortDay = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return `${d} ${MONTHS[m - 1].slice(0, 3)} ${WEEKDAYS[new Date(y, m - 1, d).getDay()].slice(0, 3)}`;
};
const hh = (n) => String(n).padStart(2, '0');
const hours = (s) => `${hh(s.startHour)}–${hh(s.endHour)}`;
const programText = (p) => p ?? UNKNOWN_PROGRAM;
const cycleText = (sec) => (sec == null ? '' : sec >= 60 ? dur(sec) : `${num(sec, 1)} sn`);

/** Vardiya hucresi: "120 adet · 24 sn" (sure bilinmiyorsa yalniz adet; hic yoksa soluk tire). */
function qtyCell(s, { time = true } = {}) {
  if (!s || s.qty === 0) return '<span class="is-null" aria-label="üretim yok">—</span>';
  const t = time ? cycleText(s.cycleAvg) : '';
  return `<b>${num(s.qty)}</b> adet${t ? ` <span class="prod-time">· ${escapeHtml(t)}</span>` : ''}` +
    (s.approxQty > 0 ? ` <span class="prod-approx" title="${num(s.approxQty)} adedi veri kopukluğundan sonra sayıldı; hangi vardiyaya düştüğü yaklaşık">*</span>` : '');
}

const stampText = (ms) => {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} ${hh(d.getHours())}:${hh(d.getMinutes())}`;
};

/** Program gecisleri tablosu (panelde tek tezgah, raporda tum tezgahlar). */
function runsTable(runs, { machine = false } = {}) {
  if (runs.length === 0) return '<p class="empty">Bu aralıkta program kaydı yok.</p>';
  const sorted = runs.slice().sort((a, b) => (machine ? a.machineId.localeCompare(b.machineId, 'tr', { numeric: true }) : 0) || a.startedAt - b.startedAt);
  const shiftText = (r) => {
    const a = r.startShift.label;
    if (!r.endShift || (r.endShift.id === r.startShift.id && r.endShift.date === r.startShift.date)) return escapeHtml(a);
    return `${escapeHtml(a)} → ${escapeHtml(r.endShift.label)}`;
  };
  const rows = sorted.map((r) =>
    `<tr>${machine ? `<td><a href="#/tezgah/${encodeURIComponent(r.machineId)}">${escapeHtml(r.machineId)}</a></td>` : ''}` +
    `<td class="mono"><b>${escapeHtml(r.program)}</b></td>` +
    `<td class="num">${escapeHtml(stampText(r.startedAt))}${r.startsBefore ? ' <span class="prod-approx" title="Bu program seçilen aralıktan önce başlamış; adet yalnız seçilen aralıktaki parçaları sayar">◂</span>' : ''}</td>` +
    `<td class="num">${r.ongoing ? '<span class="prod-live">devam ediyor</span>' : escapeHtml(stampText(r.endedAt))}${!r.ongoing && r.endsAfter ? ' <span class="prod-approx" title="Bu program seçilen aralıktan sonra bitmiş">▸</span>' : ''}</td>` +
    `<td class="num">${escapeHtml(dur(r.durationMs / 1000))}</td>` +
    `<td class="num">${r.qty > 0 ? `<b>${num(r.qty)}</b> adet` : '<span class="is-null" aria-label="parça sayılmadı">—</span>'}</td>` +
    `<td>${shiftText(r)}</td></tr>`).join('');
  return '<div class="table-wrap table-wrap-tall"><table class="tbl tbl-prod"><thead><tr>' +
    (machine ? '<th>Tezgah</th>' : '') +
    '<th>Program</th><th class="num">Başladı</th><th class="num">Bitti</th><th class="num">Süre</th><th class="num">Adet</th><th>Vardiya</th>' +
    `</tr></thead><tbody>${rows}</tbody></table></div>`;
}

const RUNS_HINT = 'Her satır, programın tezgahta çalışmaya başladığı ve bittiği saattir (bir sonraki programın başladığı an). ' +
  'Tezgah kapalıyken ya da veri yokken (10 dk üzeri) aralık biter; ◂ ▸ işaretli aralıklar seçilen tarihlerin dışına taşar.';

const rangeText = (s) => (s.cycleMin == null ? '<span class="is-null">—</span>'
  : s.cycleMin === s.cycleMax ? escapeHtml(cycleText(s.cycleMin)) : `${escapeHtml(cycleText(s.cycleMin))} – ${escapeHtml(cycleText(s.cycleMax))}`);

function notesHtml(d) {
  const notes = [];
  const approx = d.totals.approxQty;
  if (approx > 0) notes.push(`* ${num(approx)} adet veri kopukluğundan (ya da sunucu kapalıyken) sonra sayıldı: sayı doğru, hangi vardiyaya yazıldığı yaklaşık.`);
  if (d.suspect.events > 0) notes.push(`${num(d.suspect.events)} sayaç sıçraması (${num(d.suspect.qty)} adet) toplamlara katılmadı: tezgahta sayaç elle değiştirilmiş görünüyor.`);
  notes.push('Süre: parça başına ortalama çevrim süresi (kontrolcünün çevrim sayacı).');
  return notes.map((n) => `<p class="hint prod-note">${escapeHtml(n)}</p>`).join('');
}

const shiftHead = (d, s, date) => {
  // 'devam ediyor' yalniz tek gunluk gorunumde anlamli (cok gunluk toplamda bir sutun birden cok gundur).
  const live = d.from === d.to && d.current.date === date && d.current.shift === s.id;
  return `<th class="num">${escapeHtml(s.label)} <span class="prod-hours">${hours(s)}</span>${live ? ' <span class="prod-live">devam ediyor</span>' : ''}</th>`;
};

/* ============================================================ tezgah paneli */

const QUICK = [
  { key: 'today', label: 'Bugün' },
  { key: 'yesterday', label: 'Dün' },
  { key: 'last7', label: 'Son 7 gün' },
  { key: 'last30', label: 'Son 30 gün' },
];

/** @type {{host: HTMLElement, machineId: string, from: string|null, to: string|null, sig: string, seq: number, data: any, runs: any}|null} */
let panel = null;

/** Tezgah detayindaki "Uretim" bolumunu kurar (host her tezgah degisiminde yenidir). */
export function initMachineProduction(host, machineId) {
  const p = { host, machineId, from: null, to: null, sig: '', seq: 0, data: null, runs: null };
  panel = p;
  // Denetimler (tarih kutulari) bir kez kurulur; yalniz govde yenilenir: periyodik tazeleme secim yaparken kutuyu bozmasin.
  host.innerHTML =
    '<div class="dt-block-head"><h3>Üretim · vardiya adetleri</h3>' +
    '<div class="dt-actions prod-nav">' +
    '<button type="button" class="icon-btn" data-prod="prev" aria-label="Önceki aralık">◀</button>' +
    '<span class="prod-date" data-role="label">…</span>' +
    '<button type="button" class="icon-btn" data-prod="next" aria-label="Sonraki aralık" disabled>▶</button>' +
    '</div></div>' +
    '<div class="prod-controls">' +
    '<div class="seg" data-role="quick" role="group" aria-label="Hazır aralık"></div>' +
    '<label class="fld-inline">Başlangıç <input type="date" data-role="from"></label>' +
    '<label class="fld-inline">Bitiş <input type="date" data-role="to"></label>' +
    '</div>' +
    '<div data-role="body" aria-live="polite"><p class="empty">Yükleniyor…</p></div>';
  const $ = (role) => host.querySelector(`[data-role="${role}"]`);

  host.onclick = (ev) => {
    const btn = ev.target.closest('[data-prod]');
    if (btn && !btn.disabled && p.data) {
      const r = btn.dataset.prod === 'prev' ? p.data.prevRange : btn.dataset.prod === 'next' ? p.data.nextRange : null;
      if (r) { p.from = r.from; p.to = r.to; loadPanel(true); }
      return;
    }
    const quick = ev.target.closest('[data-quick]')?.dataset.quick;
    if (quick && p.data) {
      const r = p.data.presets[quick];
      p.from = r.from; p.to = r.to;
      loadPanel(true);
    }
  };
  host.onchange = (ev) => {
    const role = ev.target.dataset?.role;
    if (role !== 'from' && role !== 'to') return;
    const f = $('from').value;
    const t = $('to').value;
    if (!f && !t) return;
    p.from = f || t; p.to = t || f;
    if (p.from > p.to) { if (role === 'from') p.to = p.from; else p.from = p.to; }
    loadPanel(true);
  };
  loadPanel(true);
}

/** Periyodik tazeleme: veri degismediyse DOM'a dokunulmaz (odak ve imlec kaybolmasin). */
export const refreshMachineProduction = () => loadPanel(false);

async function loadPanel(force) {
  const p = panel;
  if (!p || !p.host.isConnected) return;
  const seq = ++p.seq;
  const q = new URLSearchParams({ machine: p.machineId });
  if (p.from) { q.set('from', p.from); q.set('to', p.to); }
  let data;
  let runs;
  try {
    [data, runs] = await Promise.all([api(`/api/production?${q}`), api(`/api/production/runs?${q}`)]);
  } catch (err) {
    if (panel === p && seq === p.seq && force) {
      p.host.querySelector('[data-role="body"]').innerHTML = `<p class="empty">Üretim verisi alınamadı: ${escapeHtml(err.message)}</p>`;
      p.sig = '';
    }
    return;
  }
  if (panel !== p || seq !== p.seq || !p.host.isConnected) return; // bu arada baska tezgaha/tarihe gecildi
  p.data = data;
  p.runs = runs;
  p.from = data.from; p.to = data.to;
  const sig = JSON.stringify([data.from, data.to, data.rows, data.suspect, data.current, data.nextRange, runs.runs]);
  if (!force && sig === p.sig) return;
  p.sig = sig;
  drawPanelControls(p);
  p.host.querySelector('[data-role="body"]').innerHTML = panelBody(data, runs);
}

function drawPanelControls(p) {
  const d = p.data;
  const $ = (role) => p.host.querySelector(`[data-role="${role}"]`);
  const single = d.from === d.to;
  const today = d.from === d.current.date && single;
  $('label').textContent = single
    ? `${dayLabel(d.from)}${today ? ' · bugün' : ''}`
    : `${shortDay(d.from)} – ${shortDay(d.to)} · ${daysIn(d)} gün`;
  p.host.querySelector('[data-prod="prev"]').disabled = !d.prevRange;
  p.host.querySelector('[data-prod="next"]').disabled = !d.nextRange;
  const from = $('from');
  const to = $('to');
  if (document.activeElement !== from) from.value = d.from;
  if (document.activeElement !== to) to.value = d.to;
  from.max = to.max = d.current.date;
  $('quick').innerHTML = QUICK.map((x) => {
    const r = d.presets[x.key];
    const on = r.from === d.from && r.to === d.to;
    return `<button type="button" data-quick="${x.key}" aria-pressed="${on}"${on ? ' class="is-on"' : ''}>${escapeHtml(x.label)}</button>`;
  }).join('');
}

const keyMs = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
const daysIn = (d) => Math.round((keyMs(d.to) - keyMs(d.from)) / 86_400_000) + 1;

function panelBody(d, runsReport) {
  const m = d.byMachine[0];
  const programs = m?.programs ?? [];
  const multi = d.from !== d.to;
  let html = '';

  if (programs.length === 0) {
    html += '<p class="empty">Bu aralıkta bu tezgahta sayılan parça yok.</p>';
  } else {
    html += '<div class="table-wrap"><table class="tbl tbl-prod"><thead><tr><th>Program</th>' +
      d.shifts.map((s) => shiftHead(d, s, d.from)).join('') +
      '<th class="num">Toplam</th></tr></thead><tbody>' +
      programs.map((p) =>
        `<tr><td class="mono">${escapeHtml(programText(p.program))}</td>` +
        d.shifts.map((s) => `<td class="num">${qtyCell(p.shifts[s.id])}</td>`).join('') +
        `<td class="num">${qtyCell(p.total)}</td></tr>`).join('') +
      '</tbody>' +
      (programs.length > 1
        ? '<tfoot><tr class="prod-total"><td>Toplam</td>' +
          d.shifts.map((s) => `<td class="num">${qtyCell(m.shifts[s.id], { time: false })}</td>`).join('') +
          `<td class="num">${qtyCell(m.total, { time: false })}</td></tr></tfoot>`
        : '') +
      '</table></div>';
  }

  // Cok gunluk secimde gun gun dokum (en yeni gun uste).
  if (multi && d.days.length > 0) {
    html += '<h4 class="prod-sub-h">Gün gün</h4><div class="table-wrap"><table class="tbl tbl-prod"><thead><tr><th>Üretim günü</th>' +
      d.shifts.map((s) => `<th class="num">${escapeHtml(s.label)} <span class="prod-hours">${hours(s)}</span></th>`).join('') +
      '<th class="num">Toplam</th></tr></thead><tbody>' +
      d.days.slice().reverse().map((day) =>
        `<tr><td>${escapeHtml(shortDay(day.date))}</td>` +
        d.shifts.map((s) => `<td class="num">${qtyCell(day.shifts[s.id], { time: false })}</td>`).join('') +
        `<td class="num">${qtyCell(day.total, { time: false })}</td></tr>`).join('') +
      '</tbody></table></div>';
  }

  const qs = new URLSearchParams({ from: d.from, to: d.to, machine: d.machineId ?? '' });
  html += '<div class="dt-block-head prod-runs-head"><h4 class="prod-sub-h">Program geçişleri</h4>' +
    `<div class="dt-actions"><a class="icon-btn" href="/api/production/runs.csv?${qs}" download>CSV indir</a></div></div>` +
    `<p class="hint prod-note">${escapeHtml(RUNS_HINT)}</p>` + runsTable(runsReport.runs);
  return html + notesHtml(d);
}

/* ============================================================ rapor ekrani */

const MODES = [
  { key: 'makine', label: 'Makine bazlı' },
  { key: 'urun', label: 'Ürün (program) bazlı' },
  { key: 'gunluk', label: 'Günlük' },
  { key: 'programlar', label: 'Program geçişleri' },
];
const PRESETS = [
  { key: 'today', label: 'Bugün' },
  { key: 'yesterday', label: 'Dün' },
  { key: 'last7', label: 'Son 7 gün' },
  { key: 'last30', label: 'Son 30 gün' },
];

/** @type {{host: HTMLElement, from: string|null, to: string|null, machine: string, mode: string, data: any, runs: any, sig: string, seq: number, timer: any}|null} */
let view = null;

/** Rapor ekranindan cikilinca zamanlayici durur ve sonraki giriste taze kurulur. */
export function resetProductionView() {
  if (view) clearInterval(view.timer);
  view = null;
}

export function renderProduction(host) {
  resetProductionView();
  const v = { host, from: null, to: null, machine: '', mode: 'makine', data: null, runs: null, sig: '', seq: 0, timer: null };
  view = v;
  host.innerHTML =
    '<section class="dt-block">' +
    '<div class="dt-block-head"><div><h3>Üretim raporu</h3>' +
    '<p class="hint">Vardiya adetleri: Gündüz 07–19, Gece 19–07. Gece vardiyası başladığı günün sayılır (ör. 13 Ekim 03:00, 12 Ekim gecesidir).</p></div>' +
    '<div class="dt-actions"><a class="icon-btn" data-role="csv" download>CSV indir</a>' +
    '<a class="icon-btn" data-role="csv-detail" download title="Tarih × vardiya × tezgah × program satırları (Excel özet tablosu için)">Ayrıntılı CSV</a></div></div>' +
    '<div class="prod-controls">' +
    '<div class="seg" data-role="presets" role="group" aria-label="Hazır aralık"></div>' +
    '<label class="fld-inline">Başlangıç <input type="date" data-role="from"></label>' +
    '<label class="fld-inline">Bitiş <input type="date" data-role="to"></label>' +
    '<label class="fld-inline">Tezgah <select data-role="machine"><option value="">Tüm tezgahlar</option></select></label>' +
    '</div>' +
    '<div class="seg prod-modes" data-role="modes" role="group" aria-label="Görünüm"></div>' +
    '<div data-role="body" aria-live="polite"><p class="empty">Yükleniyor…</p></div>' +
    '</section>';

  const $ = (role) => host.querySelector(`[data-role="${role}"]`);
  $('modes').innerHTML = MODES.map((m) =>
    `<button type="button" data-mode="${m.key}" aria-pressed="${m.key === v.mode}"${m.key === v.mode ? ' class="is-on"' : ''}>${escapeHtml(m.label)}</button>`).join('');

  host.onclick = (ev) => {
    const mode = ev.target.closest('[data-mode]')?.dataset.mode;
    if (mode && mode !== v.mode) { v.mode = mode; drawModes(); if (mode === 'programlar') load(true); else drawBody(); return; }
    const preset = ev.target.closest('[data-preset]')?.dataset.preset;
    if (preset && v.data) {
      const r = v.data.presets[preset];
      v.from = r.from; v.to = r.to;
      load(true);
    }
  };
  host.onchange = (ev) => {
    const role = ev.target.dataset?.role;
    if (role === 'from' || role === 'to') {
      const f = $('from').value;
      const t = $('to').value;
      if (!f && !t) return;
      v.from = f || t; v.to = t || f;
      if (v.from > v.to) { if (role === 'from') v.to = v.from; else v.from = v.to; }
      load(true);
    } else if (role === 'machine') {
      v.machine = ev.target.value;
      load(true);
    }
  };

  v.timer = setInterval(() => { if (view === v && !host.hidden && host.isConnected) load(false); }, REFRESH_MS);
  load(true);
}

function drawModes() {
  const v = view;
  for (const b of v.host.querySelectorAll('[data-mode]')) {
    const on = b.dataset.mode === v.mode;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', String(on));
  }
}

async function load(force) {
  const v = view;
  if (!v) return;
  const seq = ++v.seq;
  const q = new URLSearchParams();
  if (v.from) { q.set('from', v.from); q.set('to', v.to); }
  if (v.machine) q.set('machine', v.machine);
  let data;
  let runs = null;
  try {
    // Program gecisleri yalniz o gorunum seciliyken istenir (tum tezgahlar x uzun aralikta buyuk olabilir).
    [data, runs] = await Promise.all([api(`/api/production?${q}`), v.mode === 'programlar' ? api(`/api/production/runs?${q}`) : null]);
  } catch (err) {
    if (view === v && seq === v.seq && force) {
      v.host.querySelector('[data-role="body"]').innerHTML = `<p class="empty">Üretim raporu alınamadı: ${escapeHtml(err.message)}</p>`;
      v.sig = '';
    }
    return;
  }
  if (view !== v || seq !== v.seq) return;
  v.data = data;
  v.runs = runs;
  v.from = data.from; v.to = data.to;
  const sig = JSON.stringify([data.from, data.to, data.machineId, data.rows, data.suspect, data.current, data.machines, runs?.runs]);
  if (!force && sig === v.sig) return;
  v.sig = sig;
  drawControls();
  drawBody();
}

function drawControls() {
  const v = view;
  const d = v.data;
  const $ = (role) => v.host.querySelector(`[data-role="${role}"]`);
  const from = $('from');
  const to = $('to');
  if (document.activeElement !== from) from.value = d.from;
  if (document.activeElement !== to) to.value = d.to;
  from.max = to.max = d.current.date;

  $('presets').innerHTML = PRESETS.map((p) => {
    const r = d.presets[p.key];
    const on = r.from === d.from && r.to === d.to;
    return `<button type="button" data-preset="${p.key}" aria-pressed="${on}"${on ? ' class="is-on"' : ''}>${escapeHtml(p.label)}</button>`;
  }).join('');

  const sel = $('machine');
  const want = v.machine;
  sel.innerHTML = '<option value="">Tüm tezgahlar</option>' + d.machines.map((m) =>
    `<option value="${escapeHtml(m.id)}"${m.id === want ? ' selected' : ''}>${escapeHtml(m.id === m.name ? m.id : `${m.id} · ${m.name}`)}</option>`).join('');

  const qs = new URLSearchParams({ from: d.from, to: d.to });
  if (d.machineId) qs.set('machine', d.machineId);
  const base = `/api/production/export.csv?${qs}`;
  $('csv').href = v.mode === 'programlar' ? `/api/production/runs.csv?${qs}` : `${base}&view=${v.mode}`;
  $('csv-detail').href = `${base}&view=gunluk`;
}

function drawBody() {
  const v = view;
  if (!v?.data) return;
  const d = v.data;
  const body = v.host.querySelector('[data-role="body"]');
  drawControls(); // CSV baglantisi secili gorunume gore

  const summary =
    `<p class="hint">${escapeHtml(d.from === d.to ? dayLabel(d.from) : `${dayLabel(d.from)} – ${dayLabel(d.to)}`)} · ` +
    `<b>${num(d.totals.qty)}</b> adet${d.machineId ? ` · ${escapeHtml(d.machineId)}` : ''}</p>`;

  if (v.mode === 'programlar') {
    body.innerHTML = summary + `<p class="hint prod-note">${escapeHtml(RUNS_HINT)}</p>` + (v.runs ? runsTable(v.runs.runs, { machine: true }) : '<p class="empty">Yükleniyor…</p>');
    return;
  }
  if (d.totals.qty === 0) {
    body.innerHTML = summary + '<p class="empty">Bu aralıkta sayılan parça yok.</p>' + notesHtml(d);
    return;
  }
  body.innerHTML = summary + chartFigureHtml(v, d) + (v.mode === 'urun' ? productTable(d) : v.mode === 'gunluk' ? dayTable(d) : machineTable(d)) + notesHtml(d);
  drawReportCharts(body, v, d);
}

const nameOf = (d, id) => d.machines.find((m) => m.id === id)?.name ?? id;
const sumShift = (list, id) => list.reduce((a, x) => a + x.shifts[id].qty, 0);
const stat = (qty) => ({ qty, approxQty: 0, cycleAvg: null });

function totalRow(d, list, label) {
  const total = list.reduce((a, x) => a + x.total.qty, 0);
  return `<tfoot><tr class="prod-total"><td colspan="1">${escapeHtml(label)}</td>` +
    d.shifts.map((s) => `<td class="num">${qtyCell(stat(sumShift(list, s.id)), { time: false })}</td>`).join('') +
    `<td class="num">${qtyCell(stat(total), { time: false })}</td><td></td></tr></tfoot>`;
}

const dayToMs = (key) => { const [y, m, dd] = key.split('-').map(Number); return new Date(y, m - 1, dd).getTime(); };
const msToDayLabel = (ts) => new Date(ts).toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' });

/** Mod degisince cizilen grafik: gunluk=egilim, makine/urun=siralanmis cubuk. Tablo altinda zaten tam sayilar var. */
function chartFigureHtml(v, d) {
  if (v.mode === 'gunluk') {
    if (d.days.length < 2) return ''; // tek gunde egilim grafigi anlamsiz, tablo yeter
    return '<figure class="chart"><figcaption>Günlük üretim<span class="unit">seçili aralık</span></figcaption><div class="chart-host" data-role="prod-trend"></div></figure>';
  }
  if (v.mode === 'makine' && d.byMachine.some((m) => m.total.qty > 0)) {
    return '<figure class="chart"><figcaption>Tezgah bazında üretim<span class="unit">çoktan aza</span></figcaption><div class="chart-host" data-role="prod-machines"></div></figure>';
  }
  if (v.mode === 'urun' && d.byProduct.length > 0) {
    return `<figure class="chart"><figcaption>Ürün bazında üretim<span class="unit">ilk ${Math.min(10, d.byProduct.length)}</span></figcaption><div class="chart-host" data-role="prod-products"></div></figure>`;
  }
  return '';
}

/** chartFigureHtml ile mount edilen yer tutucuyu doldurur (innerHTML string dondurdugu icin mount sonrasi ayrı cagrilir). */
function drawReportCharts(host, v, d) {
  if (v.mode === 'gunluk') {
    const trendHost = host.querySelector('[data-role="prod-trend"]');
    if (trendHost) {
      const points = d.days.map((x) => ({ ts: dayToMs(x.date), value: x.total.qty }));
      lineChart(trendHost, { points, unit: ' adet', label: 'Günlük üretim', xLabel: msToDayLabel });
    }
  } else if (v.mode === 'makine') {
    const mHost = host.querySelector('[data-role="prod-machines"]');
    if (mHost) {
      const items = d.byMachine.filter((m) => m.total.qty > 0).sort((a, b) => b.total.qty - a.total.qty)
        .map((m) => { const label = nameOf(d, m.machineId); return { label: m.machineId, value: m.total.qty, title: `${m.machineId}${label !== m.machineId ? ` · ${label}` : ''}: ${num(m.total.qty)} adet` }; });
      barChart(mHost, { items, unit: ' adet', ariaLabel: 'Tezgah bazında üretim' });
    }
  } else if (v.mode === 'urun') {
    const pHost = host.querySelector('[data-role="prod-products"]');
    if (pHost) {
      const items = d.byProduct.slice().sort((a, b) => b.total.qty - a.total.qty).slice(0, 10)
        .map((p) => ({ label: programText(p.program), value: p.total.qty, title: `${programText(p.program)}: ${num(p.total.qty)} adet` }));
      barChart(pHost, { items, unit: ' adet', ariaLabel: 'Ürün bazında üretim' });
    }
  }
}

function machineTable(d) {
  const rows = d.byMachine.map((m) => {
    const label = nameOf(d, m.machineId);
    let html = `<tr class="prod-machine"><th scope="row"><a href="#/tezgah/${encodeURIComponent(m.machineId)}">${escapeHtml(m.machineId)}</a>` +
      `${label !== m.machineId ? ` <span class="prod-sub">${escapeHtml(label)}</span>` : ''}</th>` +
      d.shifts.map((s) => `<td class="num">${qtyCell(m.shifts[s.id], { time: false })}</td>`).join('') +
      `<td class="num">${qtyCell(m.total, { time: false })}</td>` +
      // Uretmeyen tezgah tek satir: 7 bos tezgah ekrani uzatmasin.
      `<td class="num prod-none">${m.programs.length === 0 ? 'üretim kaydı yok' : ''}</td></tr>`;
    for (const p of m.programs) {
      html += `<tr class="prod-prog"><td class="mono">${escapeHtml(programText(p.program))}</td>` +
        d.shifts.map((s) => `<td class="num">${qtyCell(p.shifts[s.id])}</td>`).join('') +
        `<td class="num">${qtyCell(p.total)}</td><td class="num">${rangeText(p.total)}</td></tr>`;
    }
    return html;
  }).join('');
  return '<div class="table-wrap table-wrap-tall"><table class="tbl tbl-prod"><thead><tr><th>Tezgah / program</th>' +
    d.shifts.map((s) => shiftHead(d, s, d.to)).join('') +
    '<th class="num">Toplam</th><th class="num">En kısa – en uzun</th></tr></thead><tbody>' + rows + '</tbody>' +
    totalRow(d, d.byMachine, 'Tüm tezgahlar') + '</table></div>';
}

function productTable(d) {
  const rows = d.byProduct.map((p) =>
    `<tr><td class="mono">${escapeHtml(programText(p.program))}</td>` +
    d.shifts.map((s) => `<td class="num">${qtyCell(p.shifts[s.id])}</td>`).join('') +
    `<td class="num">${qtyCell(p.total)}</td><td class="num">${rangeText(p.total)}</td>` +
    `<td>${p.machines.map((m) => `<a href="#/tezgah/${encodeURIComponent(m.machineId)}">${escapeHtml(m.machineId)}</a> <span class="prod-time">(${num(m.qty)})</span>`).join(', ')}</td></tr>`).join('');
  const total = d.byProduct.reduce((a, p) => a + p.total.qty, 0);
  return '<div class="table-wrap table-wrap-tall"><table class="tbl tbl-prod"><thead><tr><th>Program (ürün)</th>' +
    d.shifts.map((s) => shiftHead(d, s, d.to)).join('') +
    '<th class="num">Toplam</th><th class="num">En kısa – en uzun</th><th>Üretildiği tezgahlar</th></tr></thead><tbody>' + rows + '</tbody>' +
    `<tfoot><tr class="prod-total"><td>Toplam</td>${d.shifts.map((s) => `<td class="num">${qtyCell(stat(sumShift(d.byProduct, s.id)), { time: false })}</td>`).join('')}` +
    `<td class="num">${qtyCell(stat(total), { time: false })}</td><td></td><td></td></tr></tfoot></table></div>`;
}

function dayTable(d) {
  const rows = d.days.slice().reverse().map((day) =>
    `<tr><td>${escapeHtml(shortDay(day.date))}</td>` +
    d.shifts.map((s) => `<td class="num">${qtyCell(day.shifts[s.id], { time: false })}</td>`).join('') +
    `<td class="num">${qtyCell(day.total, { time: false })}</td></tr>`).join('');
  return '<div class="table-wrap table-wrap-tall"><table class="tbl tbl-prod"><thead><tr><th>Üretim günü</th>' +
    d.shifts.map((s) => shiftHead(d, s, d.to)).join('') +
    '<th class="num">Toplam</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
    '<p class="hint">Hangi programdan kaç adet yapıldığı için “Ayrıntılı CSV”yi ya da diğer görünümleri kullanın.</p>';
}
