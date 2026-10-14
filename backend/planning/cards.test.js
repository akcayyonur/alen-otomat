/**
 * Urun Tanitim Karti BAS (tek adim): kasa doldu, usta iş emrinden kartı basar. Her basis bir KASA kaydi olusur (kapali; paketleme
 * bekler): onceki kartin basildigi andan (ilk kartta is emrinin baslangicindan) simdiye kadar sayilan adet (telemetri, TAHMIN) ve tezgah
 * sayaci zinciri, kart numarasi sistemden, uretimdeki ya da biten is emri, eski acik kasa kapanip kart olur, GKK rapor no basarken yazilabilir.
 * TUM veriler sentetiktir.
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Planning } from './planning.js';
import { createPlanningRoutes } from './routes.js';

const day = (h, m = 0, s = 0, d = 12) => new Date(2026, 9, d, h, m, s).getTime();
const NOW = day(10);
const MAKINELER = [{ id: 'CNC-01', name: 'Torna 1' }, { id: 'CNC-03', name: 'Torna 3' }];
const ISEMRI = [
  'ÜRETİM EMRİ NO;TARİH;MAMÜL ADI;ALEN KOD;MÜŞTERİ KODU;MAKİNA NO;ADET;HAMMADDE;ALTERNATİF HM;ÜRETİM SN;HM TOPLAM;BRÜT GR;NET GR',
  '2026000001;02.01.2026;TEST SOMUN A;SR001.013;100000013;CNC;3500;HM614.YU23.00;;27;62,65;0,039;0,0078',
  '',
].join('\r\n');

function kur() {
  const st = { events: [], live: new Map() };
  const p = new Planning({
    dbFile: ':memory:',
    listMachines: () => MAKINELER,
    productionEvents: (machineId, from, to) => st.events.filter((e) => e.machineId === machineId && e.ts >= from && e.ts <= to).map(({ machineId: _m, ...e }) => e),
    liveMachine: (id) => st.live.get(id) ?? null,
  });
  p.importCsv(Buffer.from(ISEMRI, 'utf8'));
  return { p, st };
}
const ev = (ts, qty = 1) => ({ machineId: 'CNC-01', ts, program: '140100187', qty, partTotal: null, cycleSec: 24, gapMs: 0, suspect: false });
const canli = (partTotal) => ({ connected: true, state: 'RUNNING', program: '140100187', partTotal });
/** Uretimde bir is emri; baslangicta tezgah sayaci 500 (canli). */
function uretimde(p, st, o = {}) {
  st.live.set('CNC-01', canli(500));
  const w = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 100, machineId: 'CNC-01', ...o }, { now: day(7) });
  return p.startWorkOrder(w.no, {}, { now: day(7) });
}

test('kart bas: tek adimda kapali kasa; sayilan adet onceki karttan beri; sayac zinciri; kart no sistemden', () => {
  const { p, st } = kur();
  const w = uretimde(p, st);
  st.events.push(ev(day(7, 30)), ev(day(8, 0)), ev(day(8, 40)), ev(day(9, 20)), ev(day(9, 40)));
  st.live.set('CNC-01', canli(503));

  const k1 = p.issueCard(w.no, { person: 'Ayşe' }, { now: day(9) });
  assert.equal(k1.cardNo, 'K000001');
  assert.equal(k1.state, 'kapali', 'basilir basilmaz kapali: paketleme sayacak');
  assert.deepEqual([k1.openedAt, k1.closedAt, k1.issuedAt], [day(7), day(9), day(9)], 'ilk kart: is emri baslangicindan basildigi ana');
  assert.deepEqual([k1.startTotal, k1.endTotal, k1.countedQty], [500, 503, 3], '07:30, 08:00, 08:40');
  assert.equal(k1.openedPerson, 'Ayşe');
  assert.deepEqual(k1.warnings, []);

  st.live.set('CNC-01', canli(505));
  const k2 = p.issueCard(w.no, { person: 'Ayşe' }, { now: day(9, 50) });
  assert.equal(k2.cardNo, 'K000002');
  assert.deepEqual([k2.openedAt, k2.closedAt, k2.startTotal, k2.endTotal, k2.countedQty], [day(9), day(9, 50), 503, 505, 2], 'ikinci kart: ilk kartin bitisinden; sayac zinciri 503 -> 505');

  const g = p.getWorkOrder(w.no, { now: NOW });
  assert.deepEqual(g.crates.totals, { count: 2, open: false, unpacked: 2, rejected: 0, rejectedCounted: 0, counted: 5, packed: 0, unassigned: 0 });
  assert.equal(p.shopOverview({ now: NOW }).packing.waiting, 2);
  const ev1 = g.events.filter((e) => e.kind === 'kart-basildi');
  assert.equal(ev1.length, 2);
  assert.match(ev1[0].detail, /K00000\d · ~\d adet/);
});

test('kart bas: yalniz uretimdeki ya da biten is emri; planlanan / iptal edilen reddedilir; biten is emrinde bitis anina kadar sayilir', () => {
  const { p, st } = kur();
  const plan = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 10, machineId: 'CNC-01' }, { now: NOW });
  assert.throws(() => p.issueCard(plan.no, {}, { now: NOW }), (e) => e.status === 409 && e.code === 'bad-status');

  const w = uretimde(p, st);
  st.events.push(ev(day(8)), ev(day(9)), ev(day(9, 50)));
  p.finishWorkOrder(w.no, { endAt: day(9, 30) }, { now: NOW });
  const k = p.issueCard(w.no, { person: 'Veli' }, { now: day(9, 45) });
  assert.deepEqual([k.state, k.closedAt, k.countedQty], ['kapali', day(9, 30), 2], 'bitis saatine kadar: 09:50 sayilmaz; kart bitis anina yazilir');
  assert.equal(k.endTotal, null, 'is emri bittiginden canli sayac kaydedilmez');

  const w2 = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 10, machineId: 'CNC-03' }, { now: NOW });
  p.startWorkOrder(w2.no, { startAt: day(8) }, { now: NOW });
  p.cancelWorkOrder(w2.no, { reason: 'musteri vazgecti', now: day(9) });
  assert.throws(() => p.issueCard(w2.no, {}, { now: NOW }), (e) => e.code === 'bad-status', 'iptal edilen is emrinde kart basilmaz');
});

test('kart bas: eski akistan kalma ACIK kasa varsa o kapanir ve kart olur (ikinci kasa acilmaz)', () => {
  const { p, st } = kur();
  const w = uretimde(p, st);
  st.events.push(ev(day(8, 5)), ev(day(8, 10)));
  const acik = p.openCrate(w.no, {}, { now: day(8) });
  const k = p.issueCard(w.no, { person: 'Ayşe' }, { now: day(9) });
  assert.equal(k.id, acik.id);
  assert.deepEqual([k.cardNo, k.state, k.countedQty], ['K000001', 'kapali', 2]);
  assert.equal(p.getWorkOrder(w.no, { now: NOW }).crates.items.length, 1);
});

test('kart bas: GKK rapor no basarken yazilabilir (is emrine islenir, gecmise yazilir); gecersiz deger 400', () => {
  const { p, st } = kur();
  const w = uretimde(p, st);
  assert.equal(p.getWorkOrder(w.no, { now: NOW }).gkkReportNo, null);
  p.issueCard(w.no, { gkkReportNo: 'GKK-2026-0042' }, { now: day(9) });
  const g = p.getWorkOrder(w.no, { now: NOW });
  assert.equal(g.gkkReportNo, 'GKK-2026-0042');
  assert.ok(g.events.some((e) => e.kind === 'guncellendi' && /GKK rapor no: — → GKK-2026-0042/.test(e.detail)));
  // ayni deger ve bos deger iş emrini/gecmisi degistirmez
  const n = g.events.length;
  p.issueCard(w.no, { gkkReportNo: 'GKK-2026-0042' }, { now: day(9, 30) });
  p.issueCard(w.no, { gkkReportNo: '' }, { now: day(9, 40) });
  const g2 = p.getWorkOrder(w.no, { now: NOW });
  assert.equal(g2.gkkReportNo, 'GKK-2026-0042');
  assert.equal(g2.events.filter((e) => e.kind === 'guncellendi').length, 1);
  assert.equal(g2.events.length, n + 2, 'yalniz iki "kart basildi" olayi eklendi');
  assert.throws(() => p.issueCard(w.no, { gkkReportNo: 'x'.repeat(41) }, { now: day(9, 50) }), /GKK rapor no/);
  assert.equal(p.getWorkOrder(w.no, { now: NOW }).crates.items.length, 3, 'gecersiz istekte kart olusmadi');
});

test('kart bas: uyarilar (hic parca sayilmadi, az once baska kart basildi, tezgahtan veri yok)', () => {
  const { p, st } = kur();
  const w = uretimde(p, st);
  st.events.push(ev(day(8)));
  const k1 = p.issueCard(w.no, {}, { now: day(9) });
  assert.deepEqual(k1.warnings, []);
  const k2 = p.issueCard(w.no, {}, { now: day(9, 0, 30) });
  assert.equal(k2.countedQty, 0);
  assert.ok(k2.warnings.some((x) => /hiç parça sayılmadı/.test(x)));
  assert.ok(k2.warnings.some((x) => /Az önce \(30 sn önce\) K000001/.test(x)));
  st.live.delete('CNC-01');
  const k3 = p.issueCard(w.no, {}, { now: day(9, 30) });
  assert.equal(k3.endTotal, null);
  assert.ok(k3.warnings.some((x) => /veri gelmiyor/.test(x)));
});

test('tezgah basi ozeti: basilan kart sayisi ve en son kart', () => {
  const { p, st } = kur();
  const w = uretimde(p, st);
  assert.deepEqual(p.shopOverview({ now: NOW }).machines[0].active.cards, { count: 0, last: null });
  p.issueCard(w.no, {}, { now: day(9) });
  const k2 = p.issueCard(w.no, {}, { now: day(9, 30) });
  const c = p.shopOverview({ now: NOW }).machines[0].active.cards;
  assert.deepEqual([c.count, c.last.cardNo, c.last.at, c.last.id], [2, 'K000002', day(9, 30), k2.id]);
});

test('HTTP: POST /work-orders/:no/cards (201, 409 durum, 400 gecersiz) ve kart ayrintisi', async () => {
  const { p, st } = kur();
  st.live.set('CNC-01', canli(500));
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
    const w = (await j('/api/planning/work-orders', 'POST', { stockCode: 'SR001.013', targetQty: 20, machineId: 'CNC-01' })).json;
    assert.deepEqual([(await j(`/api/planning/work-orders/${w.no}/cards`, 'POST', {})).status, (await j(`/api/planning/work-orders/${w.no}/cards`, 'POST', {})).json.code], [409, 'bad-status']);
    await j(`/api/planning/work-orders/${w.no}/start`, 'POST', {});
    const k = await j(`/api/planning/work-orders/${w.no}/cards`, 'POST', { person: 'Ayşe', gkkReportNo: 'GKK-7' });
    assert.equal(k.status, 201);
    assert.deepEqual([k.json.cardNo, k.json.state, k.json.woNo, k.json.stockCode, k.json.customerCode, k.json.gkkReportNo], ['K000001', 'kapali', w.no, 'SR001.013', '100000013', 'GKK-7']);
    assert.ok(Number.isFinite(k.json.issuedAt));
    assert.equal((await j(`/api/planning/crates/${k.json.id}`)).json.gkkReportNo, 'GKK-7', 'kartin yeniden basimi icin ayrinti');
    assert.equal((await j(`/api/planning/work-orders/${w.no}/cards`, 'POST', { gkkReportNo: 'x'.repeat(50) })).status, 400);
    assert.equal((await j('/api/planning/work-orders/0000000000/cards', 'POST', {})).status, 404);
  } finally {
    await new Promise((r) => srv.close(r));
    p.close();
  }
});
