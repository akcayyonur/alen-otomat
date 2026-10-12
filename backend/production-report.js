/**
 * Uretim raporu: vardiya x tezgah x program adetleri ve ortalama cevrim suresi.
 *
 * Tek kaynak `production` tablosudur (backend/production.js olaylari). Ekran, panel ve CSV AYNI toplamlari
 * kullanir: toplamlar burada bir kez hesaplanir, istemci yalniz cizer.
 *
 * "Urun" = kontrolcunun calistirdigi program adi. Program adi ile musteri urun kodunu eslemek ayri bir is
 * (ikinci urun: Mikro / is emri) ve burada yoktur.
 */
import { SHIFTS, shiftOf, shiftWindows, addDays, parseDateKey, daysBetween } from '../shared/shifts.js';
import { csvDocument } from './csv.js';

/** Bir raporda en fazla bu kadar uretim gunu (sorgu sayisini sinirlar). */
export const MAX_REPORT_DAYS = 93;

const blank = () => ({ qty: 0, approxQty: 0, cycleN: 0, cycleSum: 0, cycleMin: null, cycleMax: null });

function merge(into, r) {
  into.qty += r.qty;
  into.approxQty += r.approxQty;
  into.cycleN += r.cycleN;
  into.cycleSum += r.cycleSum;
  if (r.cycleMin != null) into.cycleMin = into.cycleMin == null ? r.cycleMin : Math.min(into.cycleMin, r.cycleMin);
  if (r.cycleMax != null) into.cycleMax = into.cycleMax == null ? r.cycleMax : Math.max(into.cycleMax, r.cycleMax);
}

const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

/** Ic toplami disari verilecek biçime cevirir: ortalama cevrim suresi, 1 ondalik. */
function finish(s) {
  return {
    qty: s.qty,
    approxQty: s.approxQty,
    cycleN: s.cycleN,
    cycleAvg: s.cycleN > 0 ? round1(s.cycleSum / s.cycleN) : null,
    cycleMin: round1(s.cycleMin),
    cycleMax: round1(s.cycleMax),
  };
}

function shiftTotals(shifts, map) {
  return Object.fromEntries(shifts.map((s) => [s.id, finish(map[s.id])]));
}

/**
 * @param {{date: string, shift: string, machineId: string, program: string|null, qty: number, approxQty: number,
 *          cycleN: number, cycleSum: number, cycleMin: number|null, cycleMax: number|null}[]} rows
 * @param {{shifts?: readonly object[], machineIds?: string[]}} [opts] machineIds: adedi 0 olsa da listelenecek tezgahlar
 */
export function aggregate(rows, { shifts = SHIFTS, machineIds = [] } = {}) {
  const fresh = () => Object.fromEntries(shifts.map((s) => [s.id, blank()]));
  const totals = blank();
  const machines = new Map();
  const products = new Map();
  const days = new Map();

  for (const id of machineIds) machines.set(id, { machineId: id, total: blank(), shifts: fresh(), programs: new Map() });

  for (const r of rows) {
    merge(totals, r);

    let m = machines.get(r.machineId);
    if (!m) machines.set(r.machineId, (m = { machineId: r.machineId, total: blank(), shifts: fresh(), programs: new Map() }));
    merge(m.total, r);
    merge(m.shifts[r.shift], r);
    const pk = r.program ?? '';
    let mp = m.programs.get(pk);
    if (!mp) m.programs.set(pk, (mp = { program: r.program, total: blank(), shifts: fresh() }));
    merge(mp.total, r);
    merge(mp.shifts[r.shift], r);

    let p = products.get(pk);
    if (!p) products.set(pk, (p = { program: r.program, total: blank(), shifts: fresh(), machines: new Map() }));
    merge(p.total, r);
    merge(p.shifts[r.shift], r);
    p.machines.set(r.machineId, (p.machines.get(r.machineId) ?? 0) + r.qty);

    let d = days.get(r.date);
    if (!d) days.set(r.date, (d = { date: r.date, total: blank(), shifts: fresh() }));
    merge(d.total, r);
    merge(d.shifts[r.shift], r);
  }

  const byQtyDesc = (a, b) => b.total.qty - a.total.qty;
  return {
    totals: finish(totals),
    byMachine: [...machines.values()]
      .sort((a, b) => a.machineId.localeCompare(b.machineId, 'tr', { numeric: true }))
      .map((m) => ({
        machineId: m.machineId,
        total: finish(m.total),
        shifts: shiftTotals(shifts, m.shifts),
        programs: [...m.programs.values()].sort(byQtyDesc).map((p) => ({
          program: p.program, total: finish(p.total), shifts: shiftTotals(shifts, p.shifts),
        })),
      })),
    byProduct: [...products.values()].sort(byQtyDesc).map((p) => ({
      program: p.program,
      total: finish(p.total),
      shifts: shiftTotals(shifts, p.shifts),
      machines: [...p.machines].map(([machineId, qty]) => ({ machineId, qty })).sort((a, b) => b.qty - a.qty),
    })),
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map((d) => ({
      date: d.date, total: finish(d.total), shifts: shiftTotals(shifts, d.shifts),
    })),
  };
}

/**
 * Sorgu parametrelerinden uretim gunu araligi: `from`, `to` = 'YYYY-MM-DD' (dahil). Verilmezse bugunun uretim gunu.
 * @returns {{from: string, to: string}|{error: string}}
 */
export function resolveRange(fromRaw, toRaw, now = Date.now(), shifts = SHIFTS) {
  const today = shiftOf(now, shifts).date;
  const from = fromRaw || toRaw || today;
  const to = toRaw || fromRaw || today;
  if (!parseDateKey(from) || !parseDateKey(to)) return { error: 'tarih YYYY-AA-GG biciminde olmali' };
  if (from > to) return { error: 'baslangic tarihi bitisten sonra olamaz' };
  if (daysBetween(from, to) > MAX_REPORT_DAYS) return { error: `en fazla ${MAX_REPORT_DAYS} gunluk aralik istenebilir` };
  return { from, to };
}

/**
 * @param {{db: import('./db.js').TelemetryDb, machines: {id: string, name?: string}[], from: string, to: string,
 *          machineId?: string|null, now?: number, shifts?: readonly object[]}} args
 */
export function buildReport({ db, machines, from, to, machineId = null, now = Date.now(), shifts = SHIFTS }) {
  const rows = [];
  const windows = shiftWindows(from, to, shifts);
  for (const w of windows) {
    if (w.fromMs > now) continue; // henuz baslamamis vardiyada olay olamaz
    for (const r of db.productionWindow(w.fromMs, w.toMs, machineId)) rows.push({ date: w.date, shift: w.id, ...r });
  }

  const current = shiftOf(now, shifts);
  const ids = machineId ? [machineId] : machines.map((m) => m.id);
  const view = aggregate(rows, { shifts, machineIds: ids });
  const suspect = db.productionSuspect(windows[0].fromMs, windows[windows.length - 1].toMs, machineId);

  return {
    from,
    to,
    machineId,
    now,
    current: { date: current.date, shift: current.id },
    shifts: shifts.map((s) => ({ id: s.id, label: s.label, startHour: s.startHour, endHour: s.endHour })),
    machines: machines.map((m) => ({ id: m.id, name: m.name ?? m.id })),
    // Gun gezinmesi ve hazir araliklar: istemci tarih hesabi yapmasin.
    prevDate: addDays(from, -1),
    nextDate: to < current.date ? addDays(to, 1) : null,
    presets: {
      today: { from: current.date, to: current.date },
      yesterday: { from: addDays(current.date, -1), to: addDays(current.date, -1) },
      last7: { from: addDays(current.date, -6), to: current.date },
      last30: { from: addDays(current.date, -29), to: current.date },
    },
    suspect,
    ...view,
    rows: rows.map((r) => ({ ...r, ...finish(r) })).map(({ cycleSum, ...rest }) => rest),
  };
}

/* ---------------------------------------------------------------- CSV */

const UNKNOWN = '(program bilinmiyor)';
const programText = (p) => p ?? UNKNOWN;

/** Vardiya basina "adet" + "ort_sn" sutunlari. */
const shiftHeaders = (shifts) => shifts.flatMap((s) => [`${s.id}_adet`, `${s.id}_ort_sn`]);
const shiftCells = (shifts, byShift) => shifts.flatMap((s) => [byShift[s.id].qty, byShift[s.id].cycleAvg]);

/**
 * @param {ReturnType<typeof buildReport>} report
 * @param {'makine'|'urun'|'gunluk'} view
 */
export function reportCsv(report, view) {
  const shifts = report.shifts;
  const tail = (t) => [t.qty, t.cycleAvg, t.cycleMin, t.cycleMax];
  const tailHeaders = ['toplam_adet', 'ort_cevrim_sn', 'en_kisa_sn', 'en_uzun_sn'];

  if (view === 'urun') {
    return csvDocument(
      ['program', ...shiftHeaders(shifts), ...tailHeaders, 'tezgahlar'],
      report.byProduct.map((p) => [
        programText(p.program), ...shiftCells(shifts, p.shifts), ...tail(p.total),
        p.machines.map((m) => `${m.machineId} (${m.qty})`).join(', '),
      ]),
    );
  }
  if (view === 'gunluk') {
    const label = Object.fromEntries(shifts.map((s) => [s.id, s.label]));
    return csvDocument(
      ['tarih', 'vardiya', 'tezgah', 'program', 'adet', 'ort_cevrim_sn', 'en_kisa_sn', 'en_uzun_sn', 'yaklasik_adet'],
      report.rows.map((r) => [r.date, label[r.shift] ?? r.shift, r.machineId, programText(r.program), r.qty, r.cycleAvg, r.cycleMin, r.cycleMax, r.approxQty]),
    );
  }
  return csvDocument(
    ['tezgah', 'program', ...shiftHeaders(shifts), ...tailHeaders],
    report.byMachine.flatMap((m) => m.programs.map((p) => [m.machineId, programText(p.program), ...shiftCells(shifts, p.shifts), ...tail(p.total)])),
  );
}

/* ----------------------------------------------- tezgah kompakt dokumu */

const alarmKey = (alarms) => (alarms ? String(alarms) : '');

/**
 * Tezgah "ozet" dokumu: her saniyelik satirlar YERINE yalniz anlamli satirlar.
 *   - her uretilen parca (sayac artisi): zaman, program, adet, sayaclar, cevrim suresi
 *   - durum / program / alarm degisimi (ve kaydin ilk satiri)
 * Degisim olmadan arada gecen ornekler (calisirken ayni durum, ayni program) atilir.
 * @param {import('./db.js').TelemetryDb} db
 */
export function compactMachineCsv(db, machineId, fromMs, toMs) {
  const { rows: samples } = db.samples(machineId, fromMs, toMs, 1_000_000);
  const lines = [];

  let prev = null;
  for (const s of samples) {
    const program = s.main_program ?? s.program ?? null;
    const key = { status: s.status, program, alarms: alarmKey(s.alarms) };
    const changed = [];
    if (prev == null) changed.push('Kayıt başladı');
    else {
      if (key.status !== prev.status) changed.push('Durum değişti');
      if (key.program !== prev.program) changed.push('Program değişti');
      if (key.alarms !== prev.alarms) changed.push(key.alarms ? 'Alarm' : 'Alarm bitti');
    }
    prev = key;
    if (changed.length === 0) continue;
    lines.push({
      ts: Number(s.ts), order: 0,
      cells: [changed.join(' + '), s.status, program, null, s.part_count, s.part_total, null, s.spindle_rpm, s.feed_rate, s.alarms, s.downtime_reason, null],
    });
  }

  for (const e of db.productionEvents(machineId, fromMs, toMs)) {
    const note = e.suspect ? 'Sayaç elle değiştirilmiş olabilir, toplamlara katılmadı'
      : e.gapMs > 0 ? 'Veri kopukluğundan sonra sayıldı, zamanı yaklaşık' : null;
    lines.push({
      ts: e.ts, order: 1,
      cells: ['Parça üretildi', e.status, e.program, e.qty, e.partCount, e.partTotal, e.cycleSec, null, null, null, null, note],
    });
  }

  lines.sort((a, b) => a.ts - b.ts || a.order - b.order);
  return csvDocument(
    ['zaman', 'olay', 'durum', 'program', 'adet', 'parca', 'toplam_parca', 'cevrim_sn', 'mil_devri_rpm', 'ilerleme_mm_dk', 'alarmlar', 'durus_nedeni', 'not'],
    lines.map((l) => [new Date(l.ts).toLocaleString('tr-TR'), ...l.cells]),
  );
}
