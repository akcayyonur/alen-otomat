/**
 * Bitmiş ürün depo akışı (product-depot.js): iş emri bitince Merkez->Geçici, paketlenince (delta) Geçici->Merkez.
 * GERÇEK AĞ YOK (mikroStock.client sahte fonksiyonlarla beslenir, mikro-stock.test.js'teki desenin aynısı).
 *
 * Çalıştırma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Planning } from './planning.js';
import { createPlanningRoutes } from './routes.js';
import { MERKEZ_DEPO_NO, GECICI_DEPO_NO } from './product-depot.js';

const NOW = new Date(2026, 10, 3, 10).getTime();
const MAKINELER = [{ id: 'CNC-01', name: 'Torna 1' }];
const ISEMRI = [
  'ÜRETİM EMRİ NO;TARİH;MAMÜL ADI;ALEN KOD;MÜŞTERİ KODU;MAKİNA NO;ADET;HAMMADDE;ALTERNATİF HM;ÜRETİM SN;HM TOPLAM;BRÜT GR;NET GR',
  '2026000001;02.01.2026;TEST SOMUN A;SR001.013;100000013;CNC;3500;HM614.YU23.00;;27;62,65;0,039;0,0078',
  '',
].join('\r\n');

/** @param {{writeEnabled?: boolean, call?: (endpoint, body) => any}} [o] */
function kur({ writeEnabled = true, call = async () => ({ Data: { list: [{ guid: 'g1', evrakno_seri: 'CNCT', evrakno_sira: '7' }] } }) } = {}) {
  const calls = [];
  const client = {
    configured: () => true,
    sqlQuery: async () => [],
    call: async (endpoint, body, opts) => { calls.push({ endpoint, body, opts }); return call(endpoint, body); },
  };
  const p = new Planning({ dbFile: ':memory:', listMachines: () => MAKINELER, productionEvents: () => [], liveMachine: () => null, mikroClient: client });
  p.importCsv(Buffer.from(ISEMRI, 'utf8'));
  p.mikroStock.writeEnabled = () => writeEnabled;
  return { p, calls };
}

/** Telemetriden bağımsız: elle, hemen BİTMİŞ bir iş emri (qty adet üretildi). */
function bitmisIsEmri(p, qty, { machine = 'CNC-01', target = 100 } = {}) {
  const w = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: target, machineId: machine }, { now: NOW });
  return p.finishWorkOrderManually(w.no, { qty, finishedAt: NOW }, { now: NOW }).no;
}

test('statusFor: planlandı/üretimdeki iş emrinde bitiş aktarımı yok (pending 0), paketleme de 0', () => {
  const { p } = kur();
  const w = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 100, machineId: 'CNC-01' }, { now: NOW });
  const s = p.productDepot.statusFor(w.no);
  assert.deepEqual([s.bitis.produced, s.bitis.pending, s.paketleme.packedTotal, s.paketleme.pending], [0, 0, 0, 0]);
  assert.equal(s.stockCode, 'SR001.013');
});

test('sendFinishTransfer: bitmemiş iş emrinde 409 bad-status', async () => {
  const { p } = kur();
  const w = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 100, machineId: 'CNC-01' }, { now: NOW });
  await assert.rejects(() => p.productDepot.sendFinishTransfer(w.no), (e) => e.status === 409 && e.code === 'bad-status');
});

test('sendFinishTransfer: yazma KAPALIYKEN 409 mikro-write-disabled, Mikroya hiçbir istek gitmez, hiçbir kayıt YAZILMAZ', async () => {
  const { p, calls } = kur({ writeEnabled: false });
  const no = bitmisIsEmri(p, 250);
  await assert.rejects(() => p.productDepot.sendFinishTransfer(no), (e) => e.status === 409 && e.code === 'mikro-write-disabled');
  assert.equal(calls.length, 0);
  assert.equal(p.productDepot.statusFor(no).bitis.history.length, 0, 'denenmedi: gecmise kaydedilmemis olmali');
});

test('sendFinishTransfer: yazma açıkken ÜRETİLEN adet Merkez(1)->Geçici(2) gönderilir, evrak kaydedilir, olay yazılır', async () => {
  const { p, calls } = kur();
  const no = bitmisIsEmri(p, 250);
  const r = await p.productDepot.sendFinishTransfer(no);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, 'DahiliStokHareketKaydetV2');
  assert.deepEqual(calls[0].opts, { nestInMikro: true });
  const satir = calls[0].body.evraklar[0].satirlar[0];
  assert.deepEqual([satir.sth_stok_kod, satir.sth_miktar, satir.sth_cikis_depo_no, satir.sth_giris_depo_no], ['SR001.013', 250, MERKEZ_DEPO_NO, GECICI_DEPO_NO]);
  assert.deepEqual([r.bitis.sent, r.bitis.pending], [250, 0]);
  assert.equal(r.bitis.history[0].status, 'basarili');
  assert.equal(r.bitis.history[0].evrakSeri, 'CNCT');
  const ev = p.getWorkOrder(no).events.find((e) => e.kind === 'gecici-depoya-aktarildi');
  assert.ok(ev, 'is emri gecmisine olay yazilmali');
  assert.match(ev.detail, /250 adet/);
});

test('sendFinishTransfer: zaten gönderilmiş iş emrinde ikinci kez çağrılınca 409 nothing-to-send (ikinci kez gönderilmez)', async () => {
  const { p, calls } = kur();
  const no = bitmisIsEmri(p, 100);
  await p.productDepot.sendFinishTransfer(no);
  await assert.rejects(() => p.productDepot.sendFinishTransfer(no), (e) => e.status === 409 && e.code === 'nothing-to-send');
  assert.equal(calls.length, 1, 'ikinci denemede Mikroya tekrar gidilmemeli');
});

test('sendFinishTransfer: hiç üretilmediyse (0 adet) 409 nothing-to-send', async () => {
  const { p } = kur();
  const no = bitmisIsEmri(p, 0);
  await assert.rejects(() => p.productDepot.sendFinishTransfer(no), (e) => e.status === 409 && e.code === 'nothing-to-send');
});

test('sendFinishTransfer: Mikro hata dönerse BASARISIZ kaydedilir, pending hâlâ dolu, YENİDEN DENENEBİLİR ve ikinci deneme başarıyla kapanır', async () => {
  let attempt = 0;
  const { p } = kur({ call: async () => { attempt += 1; if (attempt === 1) throw new Error('MikroAPI\'ye ulaşılamadı'); return { Data: { list: [{ evrakno_seri: 'CNCT', evrakno_sira: '9' }] } }; } });
  const no = bitmisIsEmri(p, 80);
  await assert.rejects(() => p.productDepot.sendFinishTransfer(no), /ulaşılamadı/);
  const after1 = p.productDepot.statusFor(no);
  assert.deepEqual([after1.bitis.sent, after1.bitis.pending], [0, 80]);
  assert.equal(after1.bitis.history[0].status, 'basarisiz');
  assert.match(after1.bitis.history[0].error, /ulaşılamadı/);

  const r2 = await p.productDepot.sendFinishTransfer(no);
  assert.deepEqual([r2.bitis.sent, r2.bitis.pending], [80, 0]);
  assert.equal(r2.bitis.history.length, 2, 'basarisiz deneme de tarihcede kalir');
});

test('sendPackingTransfer: hiç paketlenmemişken 409 nothing-to-send', async () => {
  const { p } = kur();
  const no = bitmisIsEmri(p, 100);
  await assert.rejects(() => p.productDepot.sendPackingTransfer(no), (e) => e.status === 409 && e.code === 'nothing-to-send');
});

test('sendPackingTransfer: paketlenen ADET Geçici(2)->Merkez(1) gönderilir; sonraki paketlemede yalnız DELTA gönderilir (ikinci kez tam toplam değil)', async () => {
  const { p, calls } = kur();
  const no = bitmisIsEmri(p, 500);
  p.packing.addRow({ stockCode: 'SR001.013', operator: 'Ayşe', woNo: no, boxes: 2, boxQty: 100 }, { now: NOW }); // 200 adet

  const r1 = await p.productDepot.sendPackingTransfer(no);
  assert.deepEqual([r1.paketleme.sent, r1.paketleme.pending], [200, 0]);
  assert.deepEqual([calls[0].body.evraklar[0].satirlar[0].sth_miktar, calls[0].body.evraklar[0].satirlar[0].sth_cikis_depo_no, calls[0].body.evraklar[0].satirlar[0].sth_giris_depo_no], [200, GECICI_DEPO_NO, MERKEZ_DEPO_NO]);

  // Daha sonra (ör. ertesi gün) 150 adet daha paketlendi: toplam 350, DELTA = 150 gonderilmeli.
  p.packing.addRow({ stockCode: 'SR001.013', operator: 'Ayşe', woNo: no, boxes: 1, boxQty: 150 }, { now: NOW });
  const r2 = await p.productDepot.sendPackingTransfer(no);
  assert.equal(calls[1].body.evraklar[0].satirlar[0].sth_miktar, 150, 'ikinci sevk yalnizca YENI paketlenen (delta) adedi tasimali');
  assert.deepEqual([r2.paketleme.packedTotal, r2.paketleme.sent, r2.paketleme.pending], [350, 350, 0]);
});

test('HTTP: GET depot-status + POST .../depot/finish-transfer ve .../depot/packing-transfer', async () => {
  const { p } = kur();
  const no = bitmisIsEmri(p, 40);
  p.packing.addRow({ stockCode: 'SR001.013', operator: 'Ayşe', woNo: no, boxes: 1, boxQty: 40 }, { now: NOW });
  const routes = createPlanningRoutes({ planning: p });
  const srv = http.createServer(async (req, res) => { if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (yol, init) => { const r = await fetch(base + yol, init); return { status: r.status, json: await r.json() }; };
  try {
    const g = await j(`/api/planning/work-orders/${no}/depot-status`);
    assert.deepEqual([g.status, g.json.bitis.produced, g.json.paketleme.packedTotal], [200, 40, 40]);

    const f = await j(`/api/planning/work-orders/${no}/depot/finish-transfer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.deepEqual([f.status, f.json.bitis.sent], [200, 40]);

    const pk = await j(`/api/planning/work-orders/${no}/depot/packing-transfer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.deepEqual([pk.status, pk.json.paketleme.sent], [200, 40]);
  } finally {
    await new Promise((r) => srv.close(r));
    p.close();
  }
});
