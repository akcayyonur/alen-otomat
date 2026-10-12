/**
 * Uretim adetleri: (1) tezgah detayindaki "vardiya adetleri" paneli, (2) "Uretim raporu" ekrani.
 *
 * Her ikisi de /api/production'dan gelir; toplamlar sunucuda hesaplanir (ekran ve CSV ayni sayilari gosterir).
 * "Urun" = kontrolcunun calistirdigi program adi. Yanindaki sure, parca basina ORTALAMA cevrim suresidir
 * (kontrolcunun cevrim sayacinin parca artmadan onceki tepe degeri); bilinmiyorsa yazilmaz.
 * Izleyici (viewer) rolu de gorur: tezgah ag bilgisi icermez.
 */
import { escapeHtml, num, dur } from './format.js';
import { api } from './lib-common.js';

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

/** @type {{host: HTMLElement, machineId: string, date: string|null, sig: string, seq: number, data: any}|null} */
let panel = null;

/** Tezgah detayindaki "Uretim" bolumunu kurar (host her tezgah degisiminde yenidir). */
export function initMachineProduction(host, machineId) {
  const p = { host, machineId, date: null, sig: '', seq: 0, data: null };
  panel = p;
  host.innerHTML = '<h3>Üretim · vardiya adetleri</h3><p class="empty">Yükleniyor…</p>';
  host.onclick = (ev) => {
    const btn = ev.target.closest('[data-prod]');
    if (!btn || btn.disabled || !p.data) return;
    const act = btn.dataset.prod;
    if (act === 'prev') p.date = p.data.prevDate;
    else if (act === 'next') p.date = p.data.nextDate;
    else if (act === 'today') p.date = null;
    else return;
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
  if (p.date) { q.set('from', p.date); q.set('to', p.date); }
  let data;
  try {
    data = await api(`/api/production?${q}`);
  } catch (err) {
    if (panel === p && seq === p.seq && force) {
      p.host.innerHTML = `<h3>Üretim · vardiya adetleri</h3><p class="empty">Üretim verisi alınamadı: ${escapeHtml(err.message)}</p>`;
      p.sig = '';
    }
    return;
  }
  if (panel !== p || seq !== p.seq || !p.host.isConnected) return; // bu arada baska tezgaha/gune gecildi
  p.data = data;
  const sig = JSON.stringify([data.from, data.rows, data.suspect, data.current, data.nextDate]);
  if (!force && sig === p.sig) return;
  p.sig = sig;
  p.host.innerHTML = panelHtml(data);
}

function panelHtml(d) {
  const m = d.byMachine[0];
  const programs = m?.programs ?? [];
  const today = d.from === d.current.date;
  let html =
    '<div class="dt-block-head"><h3>Üretim · vardiya adetleri</h3>' +
    '<div class="dt-actions prod-nav">' +
    '<button type="button" class="icon-btn" data-prod="prev" aria-label="Önceki üretim günü">◀</button>' +
    `<span class="prod-date">${escapeHtml(dayLabel(d.from))}${today ? ' · bugün' : ''}</span>` +
    `<button type="button" class="icon-btn" data-prod="next" aria-label="Sonraki üretim günü"${d.nextDate ? '' : ' disabled'}>▶</button>` +
    (today ? '' : '<button type="button" class="icon-btn" data-prod="today">Bugüne dön</button>') +
    '</div></div>';

  if (programs.length === 0) {
    return html + '<p class="empty">Bu üretim gününde bu tezgahta sayılan parça yok.</p>' + notesHtml(d);
  }

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
  return html + notesHtml(d);
}

/* ============================================================ rapor ekrani */

const MODES = [
  { key: 'makine', label: 'Makine bazlı' },
  { key: 'urun', label: 'Ürün (program) bazlı' },
  { key: 'gunluk', label: 'Günlük' },
];
const PRESETS = [
  { key: 'today', label: 'Bugün' },
  { key: 'yesterday', label: 'Dün' },
  { key: 'last7', label: 'Son 7 gün' },
  { key: 'last30', label: 'Son 30 gün' },
];

/** @type {{host: HTMLElement, from: string|null, to: string|null, machine: string, mode: string, data: any, sig: string, seq: number, timer: any}|null} */
let view = null;

/** Rapor ekranindan cikilinca zamanlayici durur ve sonraki giriste taze kurulur. */
export function resetProductionView() {
  if (view) clearInterval(view.timer);
  view = null;
}

export function renderProduction(host) {
  resetProductionView();
  const v = { host, from: null, to: null, machine: '', mode: 'makine', data: null, sig: '', seq: 0, timer: null };
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
    if (mode && mode !== v.mode) { v.mode = mode; drawModes(); drawBody(); return; }
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
  try {
    data = await api(`/api/production?${q}`);
  } catch (err) {
    if (view === v && seq === v.seq && force) {
      v.host.querySelector('[data-role="body"]').innerHTML = `<p class="empty">Üretim raporu alınamadı: ${escapeHtml(err.message)}</p>`;
      v.sig = '';
    }
    return;
  }
  if (view !== v || seq !== v.seq) return;
  v.data = data;
  v.from = data.from; v.to = data.to;
  const sig = JSON.stringify([data.from, data.to, data.machineId, data.rows, data.suspect, data.current, data.machines]);
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
  $('csv').href = `${base}&view=${v.mode}`;
  $('csv-detail').href = `${base}&view=gunluk`;
}

function drawBody() {
  const v = view;
  if (!v?.data) return;
  const d = v.data;
  const body = v.host.querySelector('[data-role="body"]');
  const csv = v.host.querySelector('[data-role="csv"]');
  if (csv) csv.href = csv.href.replace(/view=\w+/, `view=${v.mode}`);

  const summary =
    `<p class="hint">${escapeHtml(d.from === d.to ? dayLabel(d.from) : `${dayLabel(d.from)} – ${dayLabel(d.to)}`)} · ` +
    `<b>${num(d.totals.qty)}</b> adet${d.machineId ? ` · ${escapeHtml(d.machineId)}` : ''}</p>`;

  if (d.totals.qty === 0) {
    body.innerHTML = summary + '<p class="empty">Bu aralıkta sayılan parça yok.</p>' + notesHtml(d);
    return;
  }
  body.innerHTML = summary + (v.mode === 'urun' ? productTable(d) : v.mode === 'gunluk' ? dayTable(d) : machineTable(d)) + notesHtml(d);
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
