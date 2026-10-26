/**
 * Program calisma araliklari: izleyici kurallari, kalici kayit, yeniden baslama, gecmisten doldurma,
 * rapor (adet + vardiya) ve CSV. Saatler YEREL saatle kurulur (vardiyalar yerel saattir).
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProgramRunTracker, RUN_GAP_MS } from './program-runs.js';
import { TelemetryDb } from './db.js';
import { TelemetryStore } from './store.js';
import { buildRuns, buildReport, runsCsv } from './production-report.js';
import { parseTelemetry } from '../shared/schema.js';

const SN = 1000;
const DK = 60 * SN;
const yerel = (g, a, y, sa, dk = 0, sn = 0) => new Date(y, a - 1, g, sa, dk, sn).getTime();

/** Bellek ici kayit (DB'siz izleyici testi). */
function bellek() {
  const rows = [];
  const sink = {
    open: (machineId, program, startedAt) => { rows.push({ id: rows.length + 1, machineId, program, startedAt, endedAt: null }); return rows.length; },
    close: (id, endedAt) => { rows[id - 1].endedAt = endedAt; },
    reopen: (id) => { rows[id - 1].endedAt = null; },
  };
  return { rows, sink };
}
const ozet = (rows) => rows.map((r) => `${r.program}@${r.startedAt / SN}-${r.endedAt == null ? 'acik' : r.endedAt / SN}`);

test('izleyici: program degisince onceki aralik yenisinin basladigi anda biter', () => {
  const { rows, sink } = bellek();
  const t = new ProgramRunTracker(sink);
  t.observe('CNC-01', 0, 'P1');
  t.observe('CNC-01', 1 * SN, 'P1');
  t.observe('CNC-01', 100 * SN, 'P1');
  t.observe('CNC-01', 101 * SN, 'P2');
  t.observe('CNC-01', 300 * SN, 'P2');
  assert.deepEqual(ozet(rows), ['P1@0-101', 'P2@101-acik']);
  assert.deepEqual(t.current('CNC-01'), { program: 'P2', startedAt: 101 * SN });
});

test('izleyici: okunamayan (null / bos) program degisiklik sayilmaz, aralik surer', () => {
  const { rows, sink } = bellek();
  const t = new ProgramRunTracker(sink);
  t.observe('CNC-01', 0, 'P1');
  t.observe('CNC-01', 5 * SN, null);
  t.observe('CNC-01', 6 * SN, '  ');
  t.observe('CNC-01', 7 * SN, 'P1');
  assert.deepEqual(ozet(rows), ['P1@0-acik']);
  // hic program bilinmiyorsa aralik acilmaz
  t.observe('CNC-02', 0, null);
  assert.equal(rows.length, 1);
});

test('izleyici: uzun sessizlik araligi SON GORULDUGU anda bitirir, veri gelince yeni aralik acilir (ayni program bile)', () => {
  const { rows, sink } = bellek();
  const t = new ProgramRunTracker(sink);
  t.observe('CNC-01', 0, 'P1');
  t.observe('CNC-01', 60 * SN, 'P1');
  t.observe('CNC-01', 60 * SN + RUN_GAP_MS + SN, 'P1');
  assert.deepEqual(ozet(rows), ['P1@0-60', `P1@${(60 * SN + RUN_GAP_MS + SN) / SN}-acik`]);
  // kisa sessizlik bolmez
  const b = bellek();
  const t2 = new ProgramRunTracker(b.sink);
  t2.observe('CNC-01', 0, 'P1');
  t2.observe('CNC-01', RUN_GAP_MS - SN, 'P1');
  assert.equal(b.rows.length, 1);
});

test('izleyici: sweep sessiz kalan tezgahin araligini son goruldugu anda kapatir; closeAll de oyle', () => {
  const { rows, sink } = bellek();
  const t = new ProgramRunTracker(sink);
  t.observe('CNC-01', 0, 'P1');
  t.observe('CNC-01', 30 * SN, 'P1');
  t.sweep(30 * SN + RUN_GAP_MS - SN);
  assert.equal(rows[0].endedAt, null, 'esik asilmadi');
  t.sweep(30 * SN + RUN_GAP_MS + SN);
  assert.equal(rows[0].endedAt, 30 * SN);
  assert.equal(t.current('CNC-01'), null);
  t.observe('CNC-02', 0, 'P9');
  t.observe('CNC-02', 10 * SN, 'P9');
  t.closeAll();
  assert.equal(rows[1].endedAt, 10 * SN);
});

test('izleyici: geri gelen zaman (tampondan eski mesaj) aralik sirasini bozmaz', () => {
  const { rows, sink } = bellek();
  const t = new ProgramRunTracker(sink);
  t.observe('CNC-01', 100 * SN, 'P1');
  t.observe('CNC-01', 90 * SN, 'P2'); // eski mesaj: zaman 100'e sabitlenir
  assert.deepEqual(ozet(rows), ['P1@100-100', 'P2@100-acik']);
});

test('izleyici: zaman geri giderse yeni aralik onceki bitisten once baslamaz (aralıklar cakismaz)', () => {
  const { rows, sink } = bellek();
  const t = new ProgramRunTracker(sink);
  t.observe('CNC-01', 100 * SN, 'P1');
  t.sweep(100 * SN + RUN_GAP_MS + SN); // P1 [100, 100] kapandi
  t.observe('CNC-01', 90 * SN, 'P2'); // saat geri gitti
  assert.deepEqual(ozet(rows), ['P1@100-100', 'P2@100-acik']);
});

test('izleyici: yeniden baslama — ayni program kisa surede donerse AYNI aralik surer, farkli programda yeni aralik', () => {
  const { rows, sink } = bellek();
  rows.push({ id: 1, machineId: 'CNC-01', program: 'P1', startedAt: 0, endedAt: 50 * SN });
  const seed = () => rows[0];
  const t = new ProgramRunTracker(sink, { seed });
  t.observe('CNC-01', 80 * SN, 'P1');
  assert.deepEqual(ozet(rows), ['P1@0-acik'], 'ayni aralik yeniden acildi');

  const b = bellek();
  b.rows.push({ id: 1, machineId: 'CNC-01', program: 'P1', startedAt: 0, endedAt: 50 * SN });
  const t2 = new ProgramRunTracker(b.sink, { seed: () => b.rows[0] });
  t2.observe('CNC-01', 80 * SN, 'P2');
  assert.deepEqual(ozet(b.rows), ['P1@0-50', 'P2@80-acik']);

  const c = bellek();
  c.rows.push({ id: 1, machineId: 'CNC-01', program: 'P1', startedAt: 0, endedAt: 50 * SN });
  const t3 = new ProgramRunTracker(c.sink, { seed: () => c.rows[0] });
  t3.observe('CNC-01', 50 * SN + RUN_GAP_MS + SN, 'P1');
  assert.equal(c.rows.length, 2, 'uzun kopukluktan sonra yeni aralik');
});

/* ------------------------------------------------------------ veritabani + rapor */

const olay = (o) => ({ machineId: 'CNC-01', program: 'P1', qty: 1, partTotal: null, partCount: null, status: 'RUNNING', cycleSec: null, gapMs: 0, suspect: false, ...o });

test('veritabani: aralik penceresi ve aralik basina adet (program eslesir, sinir parcasi eski programindir)', () => {
  const db = new TelemetryDb(':memory:');
  try {
    const t0 = yerel(12, 10, 2026, 7, 0, 0);
    const a = db.runSink.open('CNC-01', 'P1', t0);
    db.runSink.close(a, t0 + 3 * 3_600_000);
    const b = db.runSink.open('CNC-01', 'P2', t0 + 3 * 3_600_000);
    db.recordProduction(olay({ ts: t0 + 10 * DK }));
    db.recordProduction(olay({ ts: t0 + 20 * DK, gapMs: 90_000 }));
    // gecis ani: parca P1'indir, P2'nin ilk parcasi sonra gelir
    db.recordProduction(olay({ ts: t0 + 3 * 3_600_000 }));
    db.recordProduction(olay({ ts: t0 + 3 * 3_600_000 + 5 * DK, program: 'P2' }));
    db.recordProduction(olay({ ts: t0 + 4 * 3_600_000, program: 'P2', qty: 4900, suspect: true }));
    db.recordProduction(olay({ ts: t0 + 1 * 3_600_000, machineId: 'CNC-02', program: 'P1' }));

    const runs = db.programRuns('CNC-01', t0, t0 + 12 * 3_600_000, t0 + 6 * 3_600_000);
    assert.equal(runs.length, 2);
    assert.deepEqual([runs[0].program, runs[0].qty, runs[0].approxQty, runs[0].endedAt], ['P1', 3, 1, t0 + 3 * 3_600_000]);
    assert.deepEqual([runs[1].program, runs[1].qty, runs[1].endedAt], ['P2', 1, null], 'supheli 4900 sayilmaz');
    assert.equal(db.programRuns(null, t0, t0 + 12 * 3_600_000).length, 2, 'CNC-02 araligi yok');
    assert.equal(db.programRuns('CNC-01', t0 + 4 * 3_600_000, t0 + 5 * 3_600_000, t0 + 6 * 3_600_000).length, 1, 'yalniz acik P2 kesisir');
    assert.equal(db.stats().programRuns, 2);
    void b;
  } finally { db.close(); }
});

test('rapor: aralik pencere disina tasiyorsa isaretlenir; adet yalniz kesisimden; vardiya etiketleri', () => {
  const db = new TelemetryDb(':memory:');
  try {
    const now = yerel(13, 10, 2026, 12);
    // 12 Ekim 05:00 (11 Ekim gecesi) -> 12 Ekim 21:00 (12 Ekim gunduz+gece) : P1 ; sonra P2 acik
    const a = db.runSink.open('CNC-01', 'P1', yerel(12, 10, 2026, 5));
    db.runSink.close(a, yerel(12, 10, 2026, 21));
    db.runSink.open('CNC-01', 'P2', yerel(12, 10, 2026, 21));
    for (const [sa, dk] of [[5, 30], [8, 0], [20, 0]]) db.recordProduction(olay({ ts: yerel(12, 10, 2026, sa, dk) }));
    db.recordProduction(olay({ ts: yerel(12, 10, 2026, 22), program: 'P2' }));

    const r = buildRuns({ db, from: '2026-10-12', to: '2026-10-12', now });
    assert.equal(r.runs.length, 2);
    const [p1, p2] = r.runs;
    assert.equal(p1.startsBefore, true, 'pencere 07:00 baslar, aralik 05:00 baslamis');
    assert.equal(p1.qty, 2, '05:30 pencere disi: yalniz 08:00 ve 20:00');
    assert.deepEqual([p1.startShift.date, p1.startShift.id], ['2026-10-11', 'gece']);
    assert.deepEqual([p1.endShift.date, p1.endShift.id], ['2026-10-12', 'gece']);
    assert.equal(p2.ongoing, true);
    assert.equal(p2.endShift, null);
    assert.equal(p2.endsAfter, true, 'acik aralik pencere bitisinden (13 Ekim 07:00) sonra da suruyor (simdi 12:00)');
    assert.equal(p2.qty, 1);

    const csv = runsCsv(r).split('\r\n');
    assert.match(csv[1], /^tezgah;program;baslangic;bitis/);
    assert.ok(csv.some((l) => l.includes('P2') && l.includes('evet')));
  } finally { db.close(); }
});

test('rapor: gezinme araliklari ayni uzunlukta ve bugunun uretim gununu asmaz', () => {
  const db = new TelemetryDb(':memory:');
  try {
    const now = yerel(13, 10, 2026, 12); // uretim gunu 2026-10-12 (13 Ekim 12:00 -> gunduz, uretim gunu 13)
    const rep = buildReport({ db, machines: [{ id: 'CNC-01' }], from: '2026-10-05', to: '2026-10-07', now });
    assert.deepEqual(rep.prevRange, { from: '2026-10-02', to: '2026-10-04' });
    assert.deepEqual(rep.nextRange, { from: '2026-10-08', to: '2026-10-10' });
    const sonu = buildReport({ db, machines: [{ id: 'CNC-01' }], from: '2026-10-11', to: '2026-10-13', now });
    assert.equal(sonu.nextRange, null, 'bugune kadar gelindi');
    const yaklasan = buildReport({ db, machines: [{ id: 'CNC-01' }], from: '2026-10-08', to: '2026-10-11', now });
    assert.deepEqual(yaklasan.nextRange, { from: '2026-10-12', to: '2026-10-13' }, 'bugunu asmaz');
    const tek = buildReport({ db, machines: [{ id: 'CNC-01' }], from: '2026-10-09', to: '2026-10-09', now });
    assert.deepEqual(tek.prevRange, { from: '2026-10-08', to: '2026-10-08' });
    assert.deepEqual(tek.nextRange, { from: '2026-10-10', to: '2026-10-10' });
  } finally { db.close(); }
});

/* ------------------------------------------------------------ depo (sunucu yeniden baslama + gecmis) */

function mesaj(machineId, ts, program, extra = {}) {
  const r = parseTelemetry({
    machineId, ts: new Date(ts).toISOString(), status: 'RUNNING', source: 'simulator', program, mainProgram: program, ...extra,
  });
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.value;
}

test('depo: ingest program degisimini kaydeder; kapanista acik aralik kapanir; yeniden baslamada devam eder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cnc-runs-'));
  const file = join(dir, 'telemetry.db');
  const acik = [];
  try {
    const bas = Date.now() - 3 * DK; // kapali kalma RUN_GAP_MS (10 dk) icinde
    let store = new TelemetryStore(file);
    acik.push(store);
    store.ingest(mesaj('CNC-01', bas, 'P1'));
    store.ingest(mesaj('CNC-01', bas + 5 * SN, 'P1'));
    store.ingest(mesaj('CNC-01', bas + 10 * SN, 'P2'));
    const canli = store.runs.current('CNC-01');
    assert.equal(canli.program, 'P2');
    store.db.flush();
    store.close();

    store = new TelemetryStore(file);
    acik.push(store);
    const sonra = store.db.programRuns('CNC-01', 0, Date.now() + DK);
    assert.equal(sonra.length, 2);
    assert.ok(sonra.every((r) => r.endedAt != null), 'kapanista acik aralik kalmadi');
    assert.equal(sonra[0].program, 'P1');
    assert.equal(sonra[1].program, 'P2');

    // ayni program kisa surede geri gelirse ayni aralik surer
    store.ingest(mesaj('CNC-01', Date.now(), 'P2'));
    const devam = store.db.programRuns('CNC-01', 0, Date.now() + DK);
    assert.equal(devam.length, 2, 'yeni aralik acilmadi');
    assert.equal(devam[1].endedAt, null);
  } finally {
    // Assert patlasa bile dosyalar serbest kalsin (Windows kilidi): zamanlayici + baglanti kapatilir.
    for (const s of acik) {
      clearInterval(s.db.flushTimer);
      try { s.db.db.close(); } catch { /* zaten kapali */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('depo: ortak alt program (O9001, ör. cubuk alma) icin ayri satir ACILMAZ, gercek programin araligi surer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cnc-runs-o9001-'));
  const file = join(dir, 'telemetry.db');
  const acik = [];
  try {
    const bas = Date.now() - 5 * DK;
    const store = new TelemetryStore(file);
    acik.push(store);
    store.ingest(mesaj('CNC-01', bas, 'SR001.013'));
    // kontrolcu her parcada kisaca cubuk alma rutinine (O9001) geciyor; MainProg da O9001 gosteriyor
    store.ingest(mesaj('CNC-01', bas + 5 * SN, 'O9001'));
    store.ingest(mesaj('CNC-01', bas + 10 * SN, 'SR001.013'));
    store.ingest(mesaj('CNC-01', bas + 15 * SN, 'O9001'));
    store.ingest(mesaj('CNC-01', bas + 20 * SN, 'SR001.013'));
    store.db.flush();
    const rows = store.db.programRuns('CNC-01', 0, Date.now() + DK);
    assert.deepEqual(rows.map((r) => r.program), ['SR001.013'], 'O9001 blip-leri ayri satir acmadi, tek aralik surdu');
    assert.equal(store.runs.current('CNC-01').program, 'SR001.013');
  } finally {
    for (const s of acik) { clearInterval(s.db.flushTimer); try { s.db.db.close(); } catch { /* zaten kapali */ } }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('veritabani: ilk acilista mevcut orneklerden program araliklari cikarilir (bir kez)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cnc-runs-bf-'));
  const file = join(dir, 'telemetry.db');
  try {
    const bas = Date.now() - 3_600_000;
    const db = new TelemetryDb(file);
    for (const [dt, program] of [[0, 'P1'], [5, 'P1'], [10, 'P2'], [15, 'P2']]) db.recordSample(mesaj('CNC-01', bas + dt * DK, program), { force: true });
    db.flush();
    // yedegi sifirla: gecmisten doldurma yeniden calissin
    db.db.exec("DELETE FROM program_runs; DELETE FROM meta WHERE key = 'program_runs_backfill'");
    assert.equal(db.backfillProgramRuns(), 2);
    assert.equal(db.backfillProgramRuns(), 0, 'ikinci kez calismaz');
    const runs = db.programRuns('CNC-01', 0, Date.now() + DK);
    assert.deepEqual(runs.map((r) => [r.program, r.endedAt != null]), [['P1', true], ['P2', true]]);
    assert.equal(runs[0].endedAt, bas + 10 * DK, 'P1, P2 basladigi anda biter');
    assert.equal(runs[1].endedAt, bas + 15 * DK, 'son aralik son ornekte kapanir');
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
