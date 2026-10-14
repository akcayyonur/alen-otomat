/**
 * Verimlilik ve durus raporlari (planlama E asamasi): ayrilan sure (is emri x vardiya), kazanilan sure / ayrilan sure, kullanilabilirlik (A),
 * performans (P), sure agirlikli toplamlar, atanmamis sure, urun onerisi, durus nedeni dakikalari ve nedeni belirsiz kalanlar, CSV, HTTP.
 * TUM veriler ve telemetri (olaylar, durum araliklari) sentetiktir.
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Planning } from './planning.js';
import { createPlanningRoutes } from './routes.js';
import { splitByShift, orderSegments, summarize, matrixRows, productRows } from './efficiency.js';

const day = (h, m = 0, s = 0, d = 12) => new Date(2026, 9, d, h, m, s).getTime();
const NOW = day(8, 0, 0, 13);
const H = 3_600_000;
const MAKINELER = [{ id: 'CNC-01', name: 'Torna 1' }, { id: 'CNC-03', name: 'Torna 3' }];
const KODLAR = {
  groups: [{ id: 'degisim', label: 'Değişim ve ayar' }, { id: 'bekleme', label: 'Bekleme ve yok' }],
  codes: [
    { code: 'D1', name: 'Ürün değişikliği', group: 'degisim', kind: 'D' }, { code: 'D4', name: 'Çubuk değişimi', group: 'degisim', kind: 'D' },
    { code: 'D5', name: 'Ayarcı bekleme', group: 'bekleme', kind: 'D' }, { code: 'Z1', name: 'Devir düşüklüğü', group: 'bekleme', kind: 'Z' },
  ],
};
const ISEMRI = [
  'ÜRETİM EMRİ NO;TARİH;MAMÜL ADI;ALEN KOD;MÜŞTERİ KODU;MAKİNA NO;ADET;HAMMADDE;ALTERNATİF HM;ÜRETİM SN;HM TOPLAM;BRÜT GR;NET GR',
  '2026000001;02.01.2026;TEST SOMUN A;SR001.013;100000013;CNC;3500;HM614.YU23.00;;27;62,65;0,039;0,0078',
  '2026000002;05.01.2026;TEST NİPEL;Nİ002.001;600000000001;CNC;500;HM617.YU18.00;;45;53;0,1065;0,036',
  '',
].join('\r\n');

/** CNC-01: 07-14 calisir, 14-15 bosta, 15-21 calisir. */
const SPANS = [['RUNNING', day(6), day(14)], ['IDLE', day(14), day(15)], ['RUNNING', day(15), day(21)], ['IDLE', day(23, 30), day(0, 30, 0, 13)]]
  .map(([state, startedAt, endedAt]) => ({ machineId: 'CNC-01', state, startedAt, endedAt }));

function kur(spans = SPANS) {
  const st = { events: [], spans: [...spans] };
  const p = new Planning({
    dbFile: ':memory:',
    listMachines: () => MAKINELER,
    productionEvents: (machineId, from, to) => st.events.filter((e) => e.machineId === machineId && e.ts >= from && e.ts <= to).map(({ machineId: _m, ...e }) => e),
    spans: (id, from, to) => st.spans.filter((s) => s.machineId === id && s.startedAt < to && s.endedAt > from)
      .map((s) => ({ state: s.state, startedAt: Math.max(s.startedAt, from), endedAt: Math.min(s.endedAt, to), reason: null })),
    downtimeConfig: KODLAR,
  });
  p.importCsv(Buffer.from(ISEMRI, 'utf8'));
  return { p, st };
}
const ev = (ts, qty, o = {}) => ({ machineId: 'CNC-01', ts, program: 'X', qty, partTotal: null, cycleSec: 24, gapMs: 0, suspect: false, ...o });
const wo = (o = {}) => ({ no: '2026000001', machineId: 'CNC-01', status: 'bitti', stockCode: 'SR001.013', productName: 'TEST', plannedSec: 30, grossKg: 0.04, netKg: 0.01, ...o });

/* ------------------------------------------------------------ saf islevler */

test('vardiya bolme: 19:00 gunduz/gece siniri; gece vardiyasi onceki gunun uretim gunudur', () => {
  assert.deepEqual(splitByShift(day(18), day(20)).map((p) => [p.date, p.shiftId, (p.to - p.from) / H]), [['2026-10-12', 'gunduz', 1], ['2026-10-12', 'gece', 1]]);
  assert.deepEqual(splitByShift(day(2, 0, 0, 13), day(9, 0, 0, 13)).map((p) => [p.date, p.shiftId, (p.to - p.from) / H]), [['2026-10-12', 'gece', 5], ['2026-10-13', 'gunduz', 2]]);
  assert.deepEqual(splitByShift(day(9), day(9)), []);
});

test('is emri x vardiya: ayrilan sure, adet (vardiya siniri yari acik), verimlilik, kullanilabilirlik (A), performans (P)', () => {
  const spans = [{ state: 'RUNNING', startedAt: day(8), endedAt: day(8, 50) }, { state: 'IDLE', startedAt: day(8, 50), endedAt: day(9) }];
  const events = [ev(day(8, 30), 99, { cycleSec: 24 }), ev(day(9), 1, { cycleSec: 24 }), ev(day(8, 40), 500, { suspect: true })];
  const segs = orderSegments({ wo: wo(), from: day(8), to: day(9), events, spans });
  assert.equal(segs.length, 1);
  const s = segs[0];
  assert.deepEqual([s.allottedSec, s.qty, s.earnedSec, s.runningSec, s.observedSec, s.cycleN], [3600, 100, 3000, 3000, 3600, 2], 'penceronin bitisi dahil, supheli sicrama sayilmaz');
  const sum = summarize(segs);
  assert.deepEqual([sum.efficiency, sum.availability, sum.performance, sum.coverage], [0.8333, 0.8333, 1.25, 1], '100 x 30 sn / 3600 sn; 50/60 dk; planlanan 30 / olculen 24');

  // is emri baslangicinda ayni anda biten parca onceki isin: eventAfter dislar
  const bas = orderSegments({ wo: wo(), from: day(8), to: day(9), events: [ev(day(8), 1), ev(day(8, 1), 2)], spans: [], eventAfter: day(8) });
  assert.equal(bas[0].qty, 2);
  // 19:00'daki parca geceye gider
  const sinir = orderSegments({ wo: wo(), from: day(18, 30), to: day(19, 30), events: [ev(day(18, 59), 1), ev(day(19), 10)], spans: [] });
  assert.deepEqual(sinir.map((x) => [x.shiftId, x.qty, x.allottedSec]), [['gunduz', 1, 1800], ['gece', 10, 1800]]);
  assert.equal(summarize(sinir).availability, null, 'durum verisi yoksa kullanilabilirlik bilinmez (0 degil)');
});

test('toplamlar SURE AGIRLIKLI: 10 sa %96 + 2 sa %50 -> %88,3; planlanan cevrimi olmayan verimlilige katilmaz ama sayilir', () => {
  const seg = (allottedSec, eff, o = {}) => ({ woNo: 'W', allottedSec, qty: 100, approxQty: 0, plannedSec: 30, earnedSec: allottedSec * eff, runningSec: allottedSec, observedSec: allottedSec, cycleN: 0, cycleSum: 0, grossKg: null, netKg: null, ...o });
  const t = summarize([seg(36000, 0.96), seg(7200, 0.5)]);
  assert.equal(t.efficiency, 0.8833);
  const eksik = summarize([seg(36000, 0.96), seg(7200, 0, { plannedSec: null, earnedSec: null })]);
  assert.deepEqual([eksik.efficiency, eksik.noPlanned, eksik.qty, eksik.allottedSec], [0.96, 1, 200, 43200], 'planlanan sure yok: oran disinda, adet ve sure toplanir');
  assert.equal(summarize([]).efficiency, null);
});

test('matris: atanmamis sure (vardiya - ayrilan); urun satiri: planlanan / olculen / gerceklesen cevrim ve %105 ustu icin oneri', () => {
  const segs = orderSegments({ wo: wo(), from: day(7), to: day(13), events: [ev(day(10), 600, { cycleSec: 20 })], spans: [] });
  const m = matrixRows(segs, { rangeFrom: day(0), rangeTo: day(0, 0, 0, 13) });
  assert.deepEqual([m[0].date, m[0].shiftId, m[0].allottedSec, m[0].shiftSec, m[0].unassignedSec], ['2026-10-12', 'gunduz', 21600, 43200, 21600]);

  const urun = productRows(segs)[0];
  assert.deepEqual([urun.stockCode, urun.plannedSec, urun.measuredCycleSec, urun.realizedSec, urun.efficiency], ['SR001.013', 30, 20, 36, 0.8333]);
  assert.equal(urun.suggestion, null, 'verimlilik %105 altinda: oneri yok');
  const hizli = orderSegments({ wo: wo(), from: day(7), to: day(13), events: [ev(day(10), 800, { cycleSec: 20 })], spans: [] });
  assert.deepEqual(productRows(hizli)[0].suggestion, { kind: 'planlanan-sure-fazla', plannedSec: 20 }, '800 x 30 / 21600 = %111: planlanan sure fazla temkinli olabilir');
  const az = orderSegments({ wo: wo(), from: day(7), to: day(7, 30), events: [ev(day(7, 10), 100, { cycleSec: 5 })], spans: [] });
  assert.equal(productRows(az)[0].suggestion, null, 'az sure/adetten oneri cikmaz');
});

/* -------------------------------------------------------------- planlama */

/** A: SR001.013 07-15 (8 sa, 1000 adet). B: Nİ002.001 15-21 (vardiya sinirini asar; 100 + 60 adet). */
function uretim(p, st) {
  st.events.push(ev(day(10), 1000, { cycleSec: 24 }), ev(day(16), 100, { cycleSec: 40 }), ev(day(20), 60, { cycleSec: 40 }));
  const a = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 2000, machineId: 'CNC-01' }, { now: NOW });
  p.startWorkOrder(a.no, { startAt: day(7) }, { now: NOW });
  p.finishWorkOrder(a.no, { endAt: day(15) }, { now: NOW });
  const b = p.createWorkOrder({ stockCode: 'Nİ002.001', targetQty: 200, machineId: 'CNC-01' }, { now: NOW });
  p.startWorkOrder(b.no, { startAt: day(15) }, { now: NOW });
  p.finishWorkOrder(b.no, { endAt: day(21) }, { now: NOW });
  return { a, b };
}

test('verimlilik raporu: is emri x vardiya, tezgah x vardiya matrisi, gun, tezgah, urun; tum tezgahlar listelenir', () => {
  const { p, st } = kur();
  uretim(p, st);
  const r = p.efficiencyReport({ from: '2026-10-12', to: '2026-10-12', now: NOW });
  assert.deepEqual([r.from, r.to, r.machine], ['2026-10-12', '2026-10-12', null]);
  assert.equal(r.segments.length, 3, 'A (gunduz) + B (gunduz + gece)');
  assert.equal(r.totals.qty, 1160);
  assert.equal(r.totals.days, 1);
  assert.equal(r.totals.avgDailyQty, 1160);
  assert.equal(r.totals.allottedSec, 28800 + 14400 + 7200);

  const gunduz = r.matrix.find((x) => x.shiftId === 'gunduz');
  assert.deepEqual([gunduz.machineId, gunduz.qty, gunduz.allottedSec, gunduz.efficiency, gunduz.unassignedSec], ['CNC-01', 1100, 43200, 0.7292, 0], '(27000 + 4500) / 43200: sure agirlikli');
  assert.equal(gunduz.availability, 0.9167, '(7 + 4) saat calisti / 12 saat olculen');
  const gece = r.matrix.find((x) => x.shiftId === 'gece');
  assert.deepEqual([gece.allottedSec, gece.efficiency, gece.unassignedSec], [7200, 0.375, 10800], 'aralik gece yarisinda biter: 19-24 = 5 sa vardiya, 2 sa atanmis');

  assert.deepEqual(r.machines.map((m) => [m.machineId, m.qty, m.allottedSec]), [['CNC-01', 1160, 50400], ['CNC-03', 0, 0]], 'is emri olmayan tezgah da listede');
  assert.equal(r.machines[1].efficiency, null, 'hic atanmamis tezgahin verimliligi bilinmez (0 degil)');
  assert.deepEqual(r.days.map((d) => [d.date, d.qty, d.shifts.gunduz.qty, d.shifts.gece.qty]), [['2026-10-12', 1160, 1100, 60]]);
  assert.deepEqual(r.products.map((x) => [x.stockCode, x.qty, x.plannedSec, x.measuredCycleSec]), [['SR001.013', 1000, 27, 24], ['Nİ002.001', 160, 45, 40]]);
  assert.equal(r.totals.grossKg, Math.round((1000 * 0.039 + 160 * 0.1065) * 1000) / 1000);
  assert.equal(p.efficiencyReport({ from: '2026-10-12', to: '2026-10-12', machine: 'CNC-03', now: NOW }).totals.qty, 0);
  assert.throws(() => p.efficiencyReport({ machine: 'CNC-99', now: NOW }), /Bilinmeyen tezgah/);
});

test('verimlilik raporu: suren iş emri simdiye kadar, uretimdeyken iptal edilen dahil, planlanan cevrimi olmayan uyarilir, aralik disi is emri girmez', () => {
  const { p, st } = kur();
  const w = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 100, machineId: 'CNC-01' }, { now: NOW });
  p.startWorkOrder(w.no, { startAt: day(6, 0, 0, 13) }, { now: NOW });
  st.events.push(ev(day(7, 0, 0, 13), 40));
  const r = p.efficiencyReport({ from: '2026-10-13', to: '2026-10-13', now: NOW });
  assert.deepEqual([r.totals.qty, r.totals.allottedSec], [40, 7200], 'simdi (08:00) - baslangic (06:00)');
  assert.equal(p.efficiencyReport({ from: '2026-10-11', to: '2026-10-11', now: NOW }).totals.qty, 0, 'baska gunun raporunda yok');

  const iptal = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 10, machineId: 'CNC-03' }, { now: NOW });
  p.startWorkOrder(iptal.no, { startAt: day(5, 0, 0, 13) }, { now: NOW });
  st.events.push(ev(day(5, 30, 0, 13), 7, { machineId: 'CNC-03' }));
  p.cancelWorkOrder(iptal.no, { reason: 'musteri vazgecti', now: day(6, 0, 0, 13) });
  assert.equal(p.efficiencyReport({ from: '2026-10-13', to: '2026-10-13', now: NOW }).totals.qty, 47, 'iptal edilene kadar uretilen adet gercek');

  const plansiz = p.createWorkOrder({ stockCode: 'Nİ002.001', targetQty: 10, machineId: 'CNC-03', plannedSec: 30 }, { now: NOW });
  p.db.updateWorkOrder(plansiz.no, { planned_sec: null }, { now: NOW });
  p.startWorkOrder(plansiz.no, { startAt: day(6, 30, 0, 13) }, { now: NOW });
  st.events.push(ev(day(7, 30, 0, 13), 5, { machineId: 'CNC-03' }));
  const r2 = p.efficiencyReport({ from: '2026-10-13', to: '2026-10-13', now: NOW });
  assert.match(r2.warnings.join('|'), /planlanan çevrim yok/);
  assert.equal(r2.totals.noPlanned, 2, 'segment sayisi: pencere gece ve gunduz vardiyasina bolunur');
});

/* ---------------------------------------------------------------- duruslar */

test('durus raporu: neden dakikalari (kod x gun x tezgah), nedeni belirsiz kalan, kapsama; gece vardiyasi onceki uretim gunune yazilir', () => {
  const { p } = kur();
  p.addDowntimeReason({ machineId: 'CNC-01', from: day(14), to: day(14, 40), code: 'D4', person: 'Ayşe' }, { now: NOW });
  const r = p.downtimeReport({ from: '2026-10-12', to: '2026-10-13', now: NOW });
  assert.deepEqual(r.codes.map((c) => [c.code, c.name, c.minutes]), [['D4', 'Çubuk değişimi', 40]]);
  const c1 = r.machines.find((m) => m.machineId === 'CNC-01');
  assert.deepEqual([c1.stopMin, c1.reasonMin, c1.unknownMin, c1.coverage], [120, 40, 80, 0.333], 'olculen: 60 + 60 dk; neden atanan 40; belirsiz 80');
  assert.deepEqual(r.totals, { stopMin: 120, reasonMin: 40, unknownMin: 80, coverage: 0.333 });
  // 23:30-00:30 duruşu: gece vardiyasi 12'sinde baslar -> iki parca da 2026-10-12 gunune yazilir
  assert.deepEqual(r.unknown.map((x) => [x.date, x.machineId, x.minutes]), [['2026-10-12', 'CNC-01', 80]], '14:00 duruşunun 20 dk kalanı + gece duruşu 60 dk');

  p.addDowntimeReason({ machineId: 'CNC-01', from: day(23, 30), to: day(0, 30, 0, 13), code: 'D1' }, { now: NOW });
  const r2 = p.downtimeReport({ from: '2026-10-12', to: '2026-10-13', now: NOW });
  assert.deepEqual(r2.rows.map((x) => [x.date, x.code, x.minutes]), [['2026-10-12', 'D1', 60], ['2026-10-12', 'D4', 40]]);
  assert.deepEqual(r2.totals, { stopMin: 120, reasonMin: 100, unknownMin: 20, coverage: 0.833 });

  assert.equal(p.downtimeReport({ from: '2026-10-12', to: '2026-10-12', machine: 'CNC-03', now: NOW }).totals.stopMin, 0);
  assert.deepEqual(p.downtimeReport({ from: '2026-10-12', to: '2026-10-12', machine: 'CNC-03', now: NOW }).machines.map((m) => m.coverage), [null], 'duruş yoksa kapsama bilinmez');
});

test('CSV: Excel uyumlu (BOM, sep=;, ondalik virgul); gunluk, matris, urun, tezgah, durus, kod x gun', () => {
  const { p, st } = kur();
  uretim(p, st);
  p.addDowntimeReason({ machineId: 'CNC-01', from: day(14), to: day(14, 40), code: 'D4' }, { now: NOW });
  const q = { from: '2026-10-12', to: '2026-10-12', now: NOW };

  const g = p.efficiencyCsv(q, 'gunluk');
  assert.equal(g.filename, 'uretim-karti-gunluk-2026-10-12_2026-10-12.csv');
  const lines = g.text.split('\r\n');
  assert.equal(lines[0], '﻿sep=;');
  assert.match(lines[1], /^Tarih;Vardiya;Tezgah;İş emri;Stok kodu;Ürün;Ayrılan süre \(sn\);Planlanan çevrim \(sn\);Hedef adet;Adet;Verimlilik \(%\)/);
  assert.match(lines.find((l) => l.includes('SR001.013')), /;28800;27;1067;1000;93,8;/, 'hedef 28800/27 = 1067, verimlilik %93,8 (ondalik virgul)');

  assert.match(p.efficiencyCsv(q, 'matris').text, /Tarih;Vardiya;Tezgah;Ürünler;Ayrılan süre \(sa\);Atanmamış süre \(sa\);Adet;Verimlilik \(%\)/);
  assert.match(p.efficiencyCsv(q, 'urun').text, /Stok kodu;Ürün;Ayrılan süre \(sa\);Adet;Planlanan çevrim \(sn\);Ölçülen çevrim \(sn\)/);
  assert.match(p.efficiencyCsv(q, 'tezgah').text, /CNC-03;0;0;;;;0;0;0/, 'atanmamis tezgah: bos oranlar, 0 kg');

  const d = p.efficiencyCsv({ ...q, to: '2026-10-13' }, 'durus');
  assert.equal(d.filename, 'durus-2026-10-12_2026-10-13.csv');
  assert.match(d.text, /2026-10-12;CNC-01;D4;Çubuk değişimi;degisim;D;40/);
  assert.match(d.text, /2026-10-12;CNC-01;—;Nedeni belirsiz \(ölçülmüş duruş\);;;80/);
  const kg = p.efficiencyCsv({ ...q, to: '2026-10-13' }, 'durus-kod-gun');
  assert.match(kg.text, /Kod;Duruş nedeni;2026-10-12;Toplam/);
  assert.match(kg.text, /D4;Çubuk değişimi;40;40/);
});

test('HTTP: verimlilik ve durus raporu (json ve csv), gecersiz tarih 400, bilinmeyen gorunum varsayilana duser', async () => {
  const { p, st } = kur();
  uretim(p, st);
  const routes = createPlanningRoutes({ planning: p });
  const srv = http.createServer(async (req, res) => {
    if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (yol) => {
    const r = await fetch(base + yol);
    return { status: r.status, json: await r.json().catch(() => null), headers: r.headers };
  };
  try {
    const gecmis = '?from=2020-01-01&to=2020-01-02';
    const e = await j(`/api/planning/efficiency${gecmis}`);
    assert.equal(e.status, 200);
    assert.deepEqual([e.json.totals.qty, e.json.machines.length], [0, 2], 'gercek saatle calisir: eski aralikta bos');
    assert.equal((await j('/api/planning/efficiency?from=abc')).status, 400);
    assert.equal((await j('/api/planning/efficiency?machine=CNC-99')).status, 400);
    assert.equal((await j(`/api/planning/downtime-report${gecmis}`)).json.totals.stopMin, 0);

    const csv = await fetch(`${base}/api/planning/efficiency.csv${gecmis}&view=bozuk`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.headers.get('content-disposition'), /uretim-karti-gunluk-2020-01-01_2020-01-02\.csv/, 'bilinmeyen gorunum gunluk olur');
    const d = await fetch(`${base}/api/planning/downtime-report.csv${gecmis}&view=durus-kod-gun`);
    assert.match(d.headers.get('content-disposition'), /durus-kod-gun-2020-01-01_2020-01-02\.csv/);
  } finally {
    await new Promise((r) => srv.close(r));
    p.close();
  }
});
