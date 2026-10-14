/**
 * Is emri alan kurallari (2026-10-13 kullanici istekleri): tezgah SECMEDEN is emri olusturulabilir (baslatirken secilir), olusturmada
 * alternatif hammadde girilebilir, hammadde GK no kaldirildi (GKK rapor no ile ayni), ilk onay rapor no OLMADAN baslatilabilir ve
 * Tezgah basindan (operator) uretim sirasinda yalniz izinli alanlar duzenlenebilir. TUM veriler sentetiktir.
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Planning } from './planning.js';
import { createPlanningRoutes } from './routes.js';

const day = (h, m = 0, d = 12) => new Date(2026, 9, d, h, m).getTime();
const NOW = day(10);
const MAKINELER = [{ id: 'CNC-01', name: 'Torna 1' }, { id: 'CNC-03', name: 'Torna 3' }];
const ISEMRI = [
  'ÜRETİM EMRİ NO;TARİH;MAMÜL ADI;ALEN KOD;MÜŞTERİ KODU;MAKİNA NO;ADET;HAMMADDE;ALTERNATİF HM;ÜRETİM SN;HM TOPLAM;BRÜT GR;NET GR',
  '2026000001;02.01.2026;TEST SOMUN A;SR001.013;100000013;CNC;3500;HM614.YU23.00;HM614.AA12.00;27;62,65;0,039;0,0078',
  '',
].join('\r\n');
const kur = () => {
  const p = new Planning({ dbFile: ':memory:', listMachines: () => MAKINELER, liveMachine: () => ({ connected: true, state: 'RUNNING', program: 'X', partTotal: 100 }) });
  p.importCsv(Buffer.from(ISEMRI, 'utf8'));
  return p;
};

test('tezgah secmeden is emri olusturulur; liste/ayrinti tezgah=null; baslatirken tezgah SART; secilince atanir', () => {
  const p = kur();
  const w = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 100 }, { now: NOW });
  assert.equal(w.machineId, null);
  assert.equal(w.machineNumber, null);
  assert.match(p.getWorkOrder(w.no, { now: NOW }).events[0].detail, /tezgah atanmadı/);
  assert.equal(p.listWorkOrders({ status: 'planlandi' }, { now: NOW }).items[0].machineId, null);
  // bos metin / null da "atanmamis"
  assert.equal(p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 5, machineId: '' }, { now: NOW }).machineId, null);
  assert.equal(p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 5, machineId: null }, { now: NOW }).machineId, null);
  // tezgah olmadan baslatilamaz
  assert.throws(() => p.startWorkOrder(w.no, {}, { now: NOW }), (e) => e.status === 400 && e.code === 'no-machine');
  assert.throws(() => p.startWorkOrder(w.no, { machineId: 'CNC-99' }, { now: NOW }), /Bilinmeyen tezgah/);
  const b = p.startWorkOrder(w.no, { machineId: 'CNC-03' }, { now: NOW });
  assert.deepEqual([b.status, b.machineId, b.machineNumber], ['uretimde', 'CNC-03', 3]);
  assert.match(p.getWorkOrder(w.no, { now: NOW }).events.find((e) => e.kind === 'baslatildi').detail, /^CNC-03/);
});

test('planlanmis is emrinin tezgahi sonradan atanabilir ve kaldirilabilir (yonetici duzenlemesi)', () => {
  const p = kur();
  const w = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 100 }, { now: NOW });
  assert.equal(p.updateWorkOrder(w.no, { machineId: 'CNC-01' }, { now: NOW }).machineId, 'CNC-01');
  assert.equal(p.updateWorkOrder(w.no, { machineId: '' }, { now: NOW }).machineId, null, 'atama kaldirilir');
  assert.equal(p.updateWorkOrder(w.no, { machineId: 'CNC-03' }, { now: NOW }).machineId, 'CNC-03');
  // tezgahsiz bekleyen is emri tezgah basi ekraninda hicbir tezgahin sirasinda degil; "baska is emri baslat" ile baslatilir
  const w2 = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 10 }, { now: NOW });
  const o = p.shopOverview({ now: NOW });
  assert.ok(o.machines.every((m) => !m.planned.some((x) => x.no === w2.no)));
  assert.equal(p.listWorkOrders({ status: 'planlandi', q: w2.no }, { now: NOW }).items.length, 1);
});

test('olusturmada alternatif hammadde girilebilir (kartinkini ezer); girilmezse kartinki kopyalanir', () => {
  const p = kur();
  const a = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 10 }, { now: NOW });
  assert.equal(a.altMaterial, 'HM614.AA12.00', 'urun kartindan kopya');
  const b = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 10, altMaterial: 'HM617.AA12.00' }, { now: NOW });
  assert.equal(b.altMaterial, 'HM617.AA12.00');
  const c = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 10, altMaterial: '' }, { now: NOW });
  assert.equal(c.altMaterial, null, 'bos birakilirsa is emrinde alternatif yok');
  assert.equal(p.getProduct('SR001.013').altMaterial, 'HM614.AA12.00', 'urun karti degismez');
});

test('ilk onay rapor no OLMADAN baslatilabilir; sonra Tezgah basindan (operator alanlari) girilir ve gecmise yazilir', () => {
  const p = kur();
  const w = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 100, machineId: 'CNC-01' }, { now: NOW });
  const b = p.startWorkOrder(w.no, { fields: { gkkReportNo: 'GKK-1' } }, { now: NOW });
  assert.equal(b.status, 'uretimde');
  assert.equal(b.firstApprovalNo, null);
  assert.equal(b.measuredNetKg, null);

  const g = p.updateWorkOrderFields(w.no, { firstApprovalNo: 'IO-26-77', measuredNetKg: 0.0079, note: 'ilk parca olculdu', usedMaterial: 'HM614.AA12.00' }, { by: 'fabrika', now: NOW + 1000 });
  assert.deepEqual([g.firstApprovalNo, g.measuredNetKg, g.note, g.usedMaterial, g.updatedBy], ['IO-26-77', 0.0079, 'ilk parca olculdu', 'HM614.AA12.00', 'fabrika']);
  const ev = p.getWorkOrder(w.no, { now: NOW }).events.find((e) => e.kind === 'guncellendi' && /ilk onay rapor no: — → IO-26-77/.test(e.detail));
  assert.ok(ev, 'gecmise "ilk onay rapor no: — → ..." yazildi');
  assert.match(ev.detail, /ölçülen net gramaj \(g\): — → 7\.9/);

  // planlama alanlari buradan degismez
  for (const k of ['targetQty', 'machineId', 'grossKg', 'material', 'plannedSec', 'dueDate', 'sampleQty']) {
    assert.throws(() => p.updateWorkOrderFields(w.no, { [k]: 5 }), (e) => e.status === 403, k);
  }
  assert.equal(p.getWorkOrder(w.no, { now: NOW }).targetQty, 100);
  // biten is emrinde de yazilabilir (sonradan duzeltme); iptal edilende degil
  p.finishWorkOrder(w.no, {}, { now: NOW + 5000 });
  assert.equal(p.updateWorkOrderFields(w.no, { gkkReportNo: 'GKK-2' }).gkkReportNo, 'GKK-2');
  const x = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 5, machineId: 'CNC-03' }, { now: NOW });
  p.cancelWorkOrder(x.no, { reason: 'deneme' });
  assert.throws(() => p.updateWorkOrderFields(x.no, { note: 'a' }), (e) => e.code === 'cancelled');
});

test('HTTP: POST /work-orders/:no/fields (200, 403 yasak alan, 400 gecersiz) ve tezgahsiz olusturma', async () => {
  const p = kur();
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
    const w = await j('/api/planning/work-orders', 'POST', { stockCode: 'SR001.013', targetQty: 20 });
    assert.equal(w.status, 201, JSON.stringify(w.json));
    assert.equal(w.json.machineId, null);
    assert.equal((await j(`/api/planning/work-orders/${w.json.no}/start`, 'POST', {})).json.code, 'no-machine');
    assert.equal((await j(`/api/planning/work-orders/${w.json.no}/start`, 'POST', { machineId: 'CNC-01' })).status, 200);
    const f = await j(`/api/planning/work-orders/${w.json.no}/fields`, 'POST', { fields: { firstApprovalNo: 'A-1', measuredNetKg: 0.008 } });
    assert.deepEqual([f.status, f.json.firstApprovalNo, f.json.measuredNetKg], [200, 'A-1', 0.008]);
    assert.equal((await j(`/api/planning/work-orders/${w.json.no}/fields`, 'POST', { fields: { targetQty: 5 } })).status, 403);
    assert.equal((await j(`/api/planning/work-orders/${w.json.no}/fields`, 'POST', { fields: { measuredNetKg: 'abc' } })).status, 400);
    assert.equal((await j('/api/planning/work-orders/0000000000/fields', 'POST', { fields: {} })).status, 404);
  } finally {
    await new Promise((r) => srv.close(r));
    p.close();
  }
});
