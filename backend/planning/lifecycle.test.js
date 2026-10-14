/**
 * Is emri yasam dongusu ve telemetri baglantisi (planlama C asamasi): planlandi -> uretimde -> bitti (+ iptal), gerceklesen adet
 * (baslat-bitir penceresi, vardiya kirilimi, program capraz denetimi), donmus sonuc, cakisma denetimi, eski veritabani gecisi, HTTP.
 * TUM veriler ve telemetri olaylari sentetiktir (sahte productionEvents / liveMachine).
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Planning } from './planning.js';
import { createPlanningRoutes } from './routes.js';
import { computeProgress } from './progress.js';
import { programKey } from './program-map.js';

const day = (h, m = 0, s = 0, d = 12) => new Date(2026, 9, d, h, m, s).getTime();
const NOW = day(10);
const MAKINELER = [{ id: 'CNC-01', name: 'Torna 1' }, { id: 'CNC-03', name: 'Torna 3' }];

const ISEMRI = [
  'ÜRETİM EMRİ NO;TARİH;MAMÜL ADI;ALEN KOD;MÜŞTERİ KODU;MAKİNA NO;ADET;HAMMADDE;ALTERNATİF HM;ÜRETİM SN;HM TOPLAM;BRÜT GR;NET GR',
  '2026000001;02.01.2026;TEST SOMUN A;SR001.013;100000013;CNC;3500;HM614.YU23.00;;27;62,65;0,039;0,0078',
  '2026000002;05.01.2026;TEST NİPEL;Nİ002.001;600000000001;CNC;500;HM617.YU18.00;;45;53;0,1065;0,036',
  '',
].join('\r\n');

/** @returns {{p: Planning, st: {events: object[], live: Map<string, object>}}} */
function kur() {
  const st = { events: [], live: new Map() };
  const p = new Planning({
    dbFile: ':memory:',
    listMachines: () => MAKINELER,
    productionEvents: (machineId, from, to) => st.events.filter((e) => e.machineId === machineId && e.ts >= from && e.ts <= to).map(({ machineId: _m, ...e }) => e),
    liveMachine: (id) => st.live.get(id) ?? null,
  });
  p.importCsv(Buffer.from(ISEMRI, 'utf8'));
  p.mapProgram('140100187', 'SR001.013');
  p.mapProgram('O555', 'Nİ002.001');
  return { p, st };
}
const ev = (ts, qty = 1, o = {}) => ({ machineId: 'CNC-01', ts, program: '140100187', qty, partTotal: null, cycleSec: 24, gapMs: 0, suspect: false, ...o });
const yeni = (p, o = {}) => p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 20, machineId: 'CNC-01', ...o }, { now: NOW });
const canli = (state = 'RUNNING', o = {}) => ({ connected: true, state, program: '140100187', partTotal: 5000, ...o });

/* ------------------------------------------------- gerceklesen uretim (saf islev) */

test('ilerleme: adet, vardiya kirilimi, olculen sure, program capraz denetimi, supheli ve kopukluk, tahmin', () => {
  const programMap = new Map([
    [programKey('140100187'), { codeKey: 'SR001.013', stockCode: 'SR001.013' }],
    [programKey('O555'), { codeKey: 'NI002.001', stockCode: 'Nİ002.001' }],
  ]);
  const events = [
    ev(day(18, 56), 1, { cycleSec: 24 }), ev(day(18, 57), 1, { cycleSec: 24 }), ev(day(18, 58), 1, { cycleSec: 26 }), ev(day(18, 59), 1, { cycleSec: 22 }),
    ev(day(19, 0), 1, { cycleSec: 24 }), ev(day(19, 1), 1, { cycleSec: 24, program: 'O555' }), ev(day(19, 2), 1, { cycleSec: null, program: 'X999' }),
    ev(day(19, 3), 2, { cycleSec: null, gapMs: 90_000 }), ev(day(19, 4), 500, { suspect: true }),
  ];
  const now = day(19, 5);
  const r = computeProgress({
    wo: { codeKey: 'SR001.013', targetQty: 20, plannedSec: 27, dueDate: null }, events, programMap, hasMapping: true,
    from: day(18, 50), to: now, open: true, now, live: { connected: true, state: 'RUNNING', program: '140100187' },
  });
  assert.equal(r.produced, 9, 'supheli sayac sicramasi (500) sayilmaz');
  assert.equal(r.approxQty, 2);
  assert.deepEqual([r.suspectEvents, r.suspectQty], [1, 500]);
  assert.deepEqual(r.shifts.map((s) => [s.shiftId, s.qty]), [['gunduz', 4], ['gece', 5]], '19:00 geceye gecer');
  assert.equal(r.remaining, 11);
  assert.equal(r.pct, 45);
  assert.deepEqual(r.cycle, { plannedSec: 27, measuredAvgSec: 24, measuredN: 6, intervalSec: 60 }, 'kopukluktan sonra sayilan olay parcalar arasi sureye girmez');
  assert.deepEqual(r.programs.map((p) => [p.program, p.qty, p.status]), [['140100187', 7, 'esli'], ['O555', 1, 'baska-urun'], ['X999', 1, 'esli-degil']]);
  assert.equal(r.programs[1].stockCode, 'Nİ002.001');
  const metin = r.warnings.map((w) => w.text).join('|');
  assert.match(metin, /başka ürüne eşli programdan/);
  assert.match(metin, /eşlenmemiş programdan/);
  assert.match(metin, /sayaç sıçraması/);
  assert.match(metin, /veri kopukluğundan sonra/);
  assert.deepEqual(r.eta, { ms: now + 11 * 60_000, basis: 'aralik', lateRisk: false });
  assert.equal(r.live.programStatus, 'esli');

  // termin gecmisse risk; hiz bilgisi yoksa planlanana dusulur
  const gec = computeProgress({
    wo: { codeKey: 'SR001.013', targetQty: 20, plannedSec: 27, dueDate: day(0, 0, 0, 11) }, events, programMap, hasMapping: true, from: day(18, 50), to: now, open: true, now,
  });
  assert.equal(gec.eta.lateRisk, true);
  const hizsiz = computeProgress({ wo: { codeKey: 'SR001.013', targetQty: 20, plannedSec: 27, dueDate: null }, events: [], programMap, hasMapping: true, from: now, to: now, open: true, now });
  assert.deepEqual(hizsiz.eta, { ms: now + 20 * 27_000, basis: 'plan', lateRisk: false });
  assert.equal(hizsiz.produced, 0);
});

test('numune: ilk N adedin olculen ortalamasi; tamamlaninca ve fark varsa urun karti onerisi, kendiliginden yazilmaz', () => {
  const wo = { codeKey: 'SR001.013', targetQty: 20, sampleQty: 3, plannedSec: 27, dueDate: null };
  const now = day(12);
  const events = [30, 30, 28, 26, 24, 24].map((c, i) => ev(day(10, i), 1, { cycleSec: c }));
  const calis = (sampleQty, evs = events) => computeProgress({ wo: { ...wo, sampleQty }, events: evs, programMap: new Map(), hasMapping: false, from: day(9), to: now, open: false, now }).sample;
  assert.deepEqual(calis(3), { qty: 3, doneQty: 3, complete: true, measuredAvgSec: 29.33, measuredN: 3, plannedSec: 27, suggestSec: 29.3 });
  const surerken = calis(10);
  assert.deepEqual([surerken.complete, surerken.doneQty, surerken.suggestSec], [false, 6, null], 'numune bitmeden oneri yok');
  assert.equal(calis(2, [ev(day(10, 0), 1, { cycleSec: 27.2 }), ev(day(10, 1), 1, { cycleSec: 26.9 })]).suggestSec, null, 'planlananla %2 icinde ise oneri yok');
  assert.equal(computeProgress({ wo: { ...wo, sampleQty: null }, events, programMap: new Map(), hasMapping: false, from: day(9), to: now, open: false, now }).sample, null, 'numune adedi girilmemisse numune asamasi yok');
});

test('ilerleme: programi hic eslenmemis urunde adet yine sayilir, bilgi notu cikar; canli veri yoksa uyari', () => {
  const now = day(12);
  const r = computeProgress({
    wo: { codeKey: 'SR001.013', targetQty: 5, plannedSec: 27, dueDate: null }, events: [ev(day(11), 3)], programMap: new Map(), hasMapping: false,
    from: day(10), to: now, open: true, now, live: { connected: false, state: 'NO_DATA', program: null },
  });
  assert.equal(r.produced, 3);
  assert.equal(r.programs[0].status, 'esli-degil');
  assert.ok(r.warnings.some((w) => w.level === 'info' && /eşlemesi yok/.test(w.text)));
  assert.ok(r.warnings.some((w) => w.level === 'warn' && /veri gelmiyor/.test(w.text)));
  assert.ok(!r.warnings.some((w) => /eşlenmemiş programdan/.test(w.text)), 'eslemesi hic olmayan urunde "eslenmemis" uyarisi cikmaz');
});

/* ----------------------------------------------------------------- baslat */

test('baslat: uretimde olur, sayim penceresi baslangictan baslar; geriye alinmis baslangicta sayac yazilmaz', () => {
  const { p, st } = kur();
  st.live.set('CNC-01', canli());
  const w = yeni(p);
  assert.equal(w.status, 'planlandi');
  assert.equal(w.progress, undefined, 'baslamamis is emrinin ilerlemesi yok');

  st.events.push(ev(day(6, 59)), ev(day(7, 10)), ev(day(7, 12)), ev(day(9, 59, 30)), ev(day(10, 0, 30)));
  const b = p.startWorkOrder(w.no, { startAt: day(7), person: 'Ayşe', fields: { usedMaterial: 'HM614.YU23.00', gkkReportNo: '26-1' } }, { by: 'ortak', now: NOW });
  assert.equal(b.status, 'uretimde');
  assert.equal(b.startedAt, day(7));
  assert.equal(b.startedBy, 'ortak');
  assert.equal(b.startedPerson, 'Ayşe');
  assert.equal(b.startTotal, null, '3 saat geriye alinmis baslangicta o anki sayac bilinmez');
  assert.equal(b.usedMaterial, 'HM614.YU23.00');
  assert.equal(b.gkkReportNo, '26-1');
  assert.equal(b.progress.produced, 3, 'baslangictan ONCEKI (06:59) ve simdiden SONRAKI (10:00:30) olay sayilmaz');
  assert.deepEqual(b.events.map((e) => e.kind), ['olusturuldu', 'baslatildi', 'guncellendi']);
  assert.match(b.events[1].detail, /CNC-01 · Ayşe · başlangıç/);
  assert.deepEqual(b.warnings, [], 'tezgah bagli, program eslesiyor: uyari yok');

  const c = p.startWorkOrder(yeni(p, { machineId: 'CNC-03' }).no, {}, { by: 'ortak', now: NOW });
  assert.equal(c.startedAt, NOW, 'zaman verilmezse simdi');
  assert.match(c.warnings.join('|'), /CNC-03 için telemetri verisi yok/);

  st.live.set('CNC-01', canli('RUNNING', { partTotal: 7777 }));
  p.finishWorkOrder(b.no, {}, { now: NOW });
  const d = p.startWorkOrder(yeni(p).no, {}, { now: NOW });
  assert.equal(d.startTotal, 7777, 'simdi baslatinca tezgahin o anki omur boyu sayaci kaydedilir');
});

test('baslat: ayni tezgahta ikinci uretimde is emri ve onceki is emriyle zaman cakismasi reddedilir', () => {
  const { p } = kur();
  const a = yeni(p);
  p.startWorkOrder(a.no, { startAt: day(7) }, { now: NOW });
  const b = yeni(p);
  assert.throws(() => p.startWorkOrder(b.no, {}, { now: NOW }), (e) => e.status === 409 && e.code === 'machine-busy' && e.message.includes(a.no));

  p.finishWorkOrder(a.no, { endAt: day(9) }, { now: NOW });
  assert.throws(() => p.startWorkOrder(b.no, { startAt: day(8, 30) }, { now: NOW }), (e) => e.status === 409 && e.code === 'overlap', 'bitis saatinden once baslayamaz');
  assert.equal(p.startWorkOrder(b.no, { startAt: day(9) }, { now: NOW }).status, 'uretimde', 'bitisle ayni dakika serbest');

  // baska tezgah ve tezgah degistirerek baslatma
  const c = yeni(p);
  const cc = p.startWorkOrder(c.no, { machineId: 'CNC-03' }, { now: NOW });
  assert.equal(cc.machineId, 'CNC-03', 'operator "bu tezgahta baslatiyorum" der: tezgah degisir');
  assert.match(cc.events.find((e) => e.kind === 'baslatildi').detail, /tezgah CNC-01 → CNC-03/);
});

test('baslat: durum, zaman ve alan dogrulamalari', () => {
  const { p } = kur();
  const w = yeni(p);
  assert.throws(() => p.startWorkOrder(w.no, { startAt: NOW + 10 * 60_000 }, { now: NOW }), /gelecekte/);
  assert.throws(() => p.startWorkOrder(w.no, { startAt: NOW - 73 * 3_600_000 }, { now: NOW }), /72 saat/);
  assert.throws(() => p.startWorkOrder(w.no, { startAt: 'dun aksam' }, { now: NOW }), /geçerli bir tarih/);
  assert.throws(() => p.startWorkOrder(w.no, { machineId: 'CNC-99' }, { now: NOW }), /Bilinmeyen tezgah/);
  assert.throws(() => p.startWorkOrder(w.no, { person: 'x'.repeat(61) }, { now: NOW }), /en fazla 60/);
  assert.throws(() => p.startWorkOrder(w.no, { fields: { sampleQty: 999 } }, { now: NOW }), /Numune adedi hedef adetten/);
  assert.equal(p.getWorkOrder(w.no).status, 'planlandi', 'hatali istek durumu degistirmez');

  // yerel tarih-saat metni (tarayicidaki datetime-local) kabul edilir
  const ok = p.startWorkOrder(w.no, { startAt: '2026-10-12T08:15' }, { now: NOW });
  assert.equal(ok.startedAt, day(8, 15));
  assert.throws(() => p.startWorkOrder(w.no, {}, { now: NOW }), (e) => e.code === 'bad-status' && /zaten üretimde/.test(e.message));
  assert.throws(() => p.startWorkOrder('2026999999', {}, { now: NOW }), (e) => e.status === 404);

  const iptal = yeni(p, { machineId: 'CNC-03' });
  p.cancelWorkOrder(iptal.no, { reason: 'deneme' });
  assert.throws(() => p.startWorkOrder(iptal.no, {}, { now: NOW }), /İptal edilmiş/);
});

/* ------------------------------------------------------------------ bitir */

test('bitir: sonuc DONDURULUR (sonradan gelen olay degistirmez), hedef sapmasi uyarilir, kisi ve sayac kaydedilir', () => {
  const { p, st } = kur();
  st.live.set('CNC-01', canli());
  const w = yeni(p, { targetQty: 5 });
  assert.throws(() => p.finishWorkOrder(w.no, {}, { now: NOW }), (e) => e.code === 'bad-status' && /başlatılmadı/.test(e.message));
  p.startWorkOrder(w.no, { startAt: day(7) }, { now: NOW });
  st.events.push(ev(day(7, 30)), ev(day(8, 0)), ev(day(8, 30), 2));

  assert.throws(() => p.finishWorkOrder(w.no, { endAt: day(6) }, { now: NOW }), /başlangıçtan/);
  const f = p.finishWorkOrder(w.no, { person: 'Veli' }, { by: 'ortak', now: NOW });
  assert.equal(f.status, 'bitti');
  assert.equal(f.finishedAt, NOW);
  assert.equal(f.finishedBy, 'ortak');
  assert.equal(f.finishedPerson, 'Veli');
  assert.equal(f.finishTotal, 5000);
  assert.equal(f.progress.frozen, true);
  assert.equal(f.progress.produced, 4);
  assert.equal(f.progress.remaining, 1);
  assert.deepEqual(f.warnings, ['Hedefin altında bitirildi: 4 / 5 adet.']);
  assert.match(f.events.at(-1).detail, /4 adet · hedef 5 · Veli · sayaç 5000/);

  st.events.push(ev(day(9, 0), 10)); // pencere icinde ama is emri kapandi: sonuc degismez
  assert.equal(p.getWorkOrder(w.no).progress.produced, 4);
  // hedef sonradan duzenlenirse kalan/yuzde yeni hedefe gore, adet ayni
  p.updateWorkOrder(w.no, { targetQty: 8 }, { now: NOW });
  const g = p.getWorkOrder(w.no).progress;
  assert.deepEqual([g.produced, g.remaining, g.pct], [4, 4, 50]);
  assert.throws(() => p.finishWorkOrder(w.no, {}, { now: NOW }), /zaten bitmiş/);

  const sifir = yeni(p, { machineId: 'CNC-03', targetQty: 3 });
  p.startWorkOrder(sifir.no, { startAt: day(9) }, { now: NOW });
  assert.match(p.finishWorkOrder(sifir.no, {}, { now: NOW }).warnings.join('|'), /Hiç parça sayılmadı/);

  const fazla = yeni(p, { targetQty: 3 });
  st.events.push(ev(day(10, 40), 5));
  p.startWorkOrder(fazla.no, { startAt: day(10, 30) }, { now: day(11) });
  assert.ok(p.finishWorkOrder(fazla.no, {}, { now: day(11) }).warnings.includes('Hedefin üzerinde: 5 / 3 adet (2 fazla).'));
});

test('geri al: yanlislikla bitirilen uretime doner; sonraki is emri varsa reddedilir', () => {
  const { p, st } = kur();
  st.events.push(ev(day(7, 30)), ev(day(8, 0)));
  const a = yeni(p);
  p.startWorkOrder(a.no, { startAt: day(7) }, { now: NOW });
  p.finishWorkOrder(a.no, { endAt: day(8, 30) }, { now: NOW });
  assert.throws(() => p.reopenWorkOrder(yeni(p, { machineId: 'CNC-03' }).no), /Yalnız biten/);

  const r = p.reopenWorkOrder(a.no, { by: 'ortak', now: NOW });
  assert.equal(r.status, 'uretimde');
  assert.equal(r.finishedAt, null);
  assert.equal(r.result, null);
  assert.equal(r.progress.frozen, false);
  assert.equal(r.progress.to, NOW, 'pencere yeniden simdiye kadar acik');
  assert.equal(r.events.at(-1).kind, 'yeniden-acildi');

  p.finishWorkOrder(a.no, { endAt: day(8, 30) }, { now: NOW });
  const b = yeni(p);
  p.startWorkOrder(b.no, { startAt: day(9) }, { now: NOW });
  assert.throws(() => p.reopenWorkOrder(a.no), (e) => e.code === 'machine-busy');
  p.finishWorkOrder(b.no, { endAt: day(9, 30) }, { now: NOW });
  assert.throws(() => p.reopenWorkOrder(a.no), (e) => e.code === 'overlap', 'sonrasinda baska is emri calismis');
});

/* ----------------------------------------------------- iptal, guncelleme, liste */

test('iptal: uretimdeki is emrinin adedi dondurulur; biten iptal edilmez; baslamis is emrinin tezgahi kilitlenir', () => {
  const { p, st } = kur();
  st.events.push(ev(day(7, 30)), ev(day(8, 0)));
  const a = yeni(p);
  p.startWorkOrder(a.no, { startAt: day(7) }, { now: NOW });
  assert.throws(() => p.updateWorkOrder(a.no, { machineId: 'CNC-03' }), (e) => e.code === 'machine-locked');
  assert.equal(p.updateWorkOrder(a.no, { machineId: 'CNC-01', note: 'x' }).note, 'x', 'ayni tezgahi yazmak sorun degil');

  const c = p.cancelWorkOrder(a.no, { reason: 'musteri vazgecti', now: day(8, 10) });
  assert.equal(c.status, 'iptal');
  assert.equal(c.progress.frozen, true);
  assert.equal(c.progress.produced, 2, 'iptale kadar sayilan adet gorunur');
  assert.equal(yeni(p).status, 'planlandi');
  const b = yeni(p);
  assert.equal(p.startWorkOrder(b.no, { startAt: day(7, 45) }, { now: NOW }).status, 'uretimde', 'iptal edilen is emri tezgahi mesgul etmez');

  p.finishWorkOrder(b.no, {}, { now: NOW });
  assert.throws(() => p.cancelWorkOrder(b.no, { reason: 'hata' }), (e) => e.code === 'finished');

  const hic = yeni(p, { machineId: 'CNC-03' });
  assert.equal(p.cancelWorkOrder(hic.no, { reason: 'hic baslamadi' }).progress, null);
});

test('liste: uretimdekiler en ustte, durum suzgecleri, adet ve yuzde; ozet durum sayilari', () => {
  const { p, st } = kur();
  st.events.push(ev(day(7, 30)), ev(day(8, 0)));
  const a = yeni(p);
  const b = yeni(p, { machineId: 'CNC-03' });
  const c = yeni(p);
  p.startWorkOrder(b.no, { startAt: day(7) }, { now: NOW });
  p.startWorkOrder(a.no, { startAt: day(7) }, { now: NOW });
  p.finishWorkOrder(a.no, { endAt: day(8, 30) }, { now: NOW });

  const hepsi = p.listWorkOrders({ status: 'tumu' }).items;
  assert.deepEqual(hepsi.map((w) => w.status), ['uretimde', 'planlandi', 'bitti'], 'uretimde en ustte, sonra yeni numaradan eskiye');
  assert.equal(hepsi[0].no, b.no);
  assert.deepEqual(p.listWorkOrders({ status: 'aktif' }).items.map((w) => w.no).sort(), [b.no, c.no].sort(), 'aktif = planlandi + uretimde');
  assert.deepEqual(p.listWorkOrders({ status: 'bitti' }).items.map((w) => [w.no, w.produced, w.pct]), [[a.no, 2, 10]]);
  assert.equal(p.listWorkOrders({ status: 'planlandi' }).items[0].produced, null, 'baslamamis is emrinde adet yok (0 degil)');
  assert.deepEqual(p.summary().workOrders, { planlandi: 1, uretimde: 1, bitti: 1, iptal: 0 });
});

/* ------------------------------------------------ eski veritabani gecisi, HTTP */

test('gecis: C asamasindan once olusmus veritabani acilinca yeni sutunlar eklenir, eski is emri bozulmaz', () => {
  const dir = mkdtempSync(join(tmpdir(), 'planlama-gecis-'));
  const dbFile = join(dir, 'planlama.db');
  try {
    const p1 = new Planning({ dbFile, listMachines: () => MAKINELER });
    p1.importCsv(Buffer.from(ISEMRI, 'utf8'));
    const w = p1.createWorkOrder({ stockCode: 'SR001.013', targetQty: 20, machineId: 'CNC-01' }, { now: NOW });
    p1.close();

    const raw = new DatabaseSync(dbFile);
    for (const c of ['started_at', 'started_by', 'started_person', 'start_total', 'finished_at', 'finished_by', 'finished_person', 'finish_total', 'result_json']) {
      raw.exec(`ALTER TABLE work_orders DROP COLUMN ${c}`);
    }
    raw.close();

    const p2 = new Planning({ dbFile, listMachines: () => MAKINELER });
    const old = p2.getWorkOrder(w.no);
    assert.equal(old.status, 'planlandi');
    assert.equal(old.startedAt, null);
    assert.equal(p2.startWorkOrder(w.no, { startAt: NOW - 60_000 }, { now: NOW }).status, 'uretimde');
    p2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP: baslat / bitir / geri al uclari ve hata kodlari', async () => {
  const { p } = kur();
  const routes = createPlanningRoutes({ planning: p });
  const srv = http.createServer(async (req, res) => {
    if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (yol, method = 'GET', obj) => {
    const r = await fetch(base + yol, { method, headers: { 'content-type': 'application/json' }, ...(obj === undefined ? {} : { body: JSON.stringify(obj) }) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  try {
    const a = (await j('/api/planning/work-orders', 'POST', { stockCode: 'SR001.013', targetQty: 20, machineId: 'CNC-01' })).json;
    const b = (await j('/api/planning/work-orders', 'POST', { stockCode: 'SR001.013', targetQty: 20, machineId: 'CNC-01' })).json;

    const start = await j(`/api/planning/work-orders/${a.no}/start`, 'POST', { person: 'Ayşe' });
    assert.equal(start.status, 200);
    assert.equal(start.json.status, 'uretimde');
    assert.ok(Array.isArray(start.json.warnings));
    assert.equal((await j(`/api/planning/work-orders/${b.no}/start`, 'POST', {})).json.code, 'machine-busy');
    assert.equal((await j(`/api/planning/work-orders/${a.no}/start`, 'POST', {})).status, 409);
    assert.equal((await j(`/api/planning/work-orders/${b.no}/start`, 'POST', { startAt: 'saçma' })).status, 400);
    assert.equal((await j('/api/planning/work-orders/2026999999/start', 'POST', {})).status, 404);

    assert.equal((await j('/api/planning/work-orders?status=uretimde')).json.total, 1);
    const fin = await j(`/api/planning/work-orders/${a.no}/finish`, 'POST', {});
    assert.equal(fin.status, 200);
    assert.equal(fin.json.status, 'bitti');
    assert.equal((await j(`/api/planning/work-orders/${a.no}/cancel`, 'POST', { reason: 'hata var' })).json.code, 'finished');
    const geri = await j(`/api/planning/work-orders/${a.no}/reopen`, 'POST');
    assert.equal(geri.json.status, 'uretimde');
    assert.equal((await j(`/api/planning/work-orders/${a.no}/reopen`, 'POST')).status, 409);
  } finally {
    await new Promise((r) => srv.close(r));
    p.close();
  }
});
