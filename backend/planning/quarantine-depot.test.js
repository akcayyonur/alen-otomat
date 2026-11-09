/**
 * Karantina deposu (quarantine-depot.js): hurda girişi bir iş emrine bağlıysa Karantina(5)<->Geçici(2)/Hurda(3)
 * Mikro hareketleri + quarantine.js/planning.js'teki otomatik tetikleme kancaları. GERÇEK AĞ YOK (mikroStock.client
 * sahte fonksiyonlarla beslenir, product-depot.test.js'teki desenin aynısı).
 *
 * Çalıştırma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Planning } from './planning.js';
import { KARANTINA_DEPO_NO, HURDA_DEPO_NO } from './quarantine-depot.js';
import { GECICI_DEPO_NO } from './product-depot.js';

const NOW = new Date(2026, 10, 9, 10).getTime();
const MAKINELER = [{ id: 'CNC-01', name: 'Torna 1' }];
const ISEMRI = [
  'ÜRETİM EMRİ NO;TARİH;MAMÜL ADI;ALEN KOD;MÜŞTERİ KODU;MAKİNA NO;ADET;HAMMADDE;ALTERNATİF HM;ÜRETİM SN;HM TOPLAM;BRÜT GR;NET GR',
  '2026000001;02.01.2026;TEST SOMUN A;SR001.013;100000013;CNC;3500;HM614.YU23.00;;27;62,65;0,039;0,0078',
  '',
].join('\r\n');

/** product-depot.test.js'teki `kur()` ile AYNI desen; ayrıca `quarantineDepot.enabled` da aynı kapıya bağlanır. */
function kur({ writeEnabled = true, depotEnabled = true, call = async () => ({ Data: { list: [{ guid: 'g1', evrakno_seri: 'CNCT', evrakno_sira: '7' }] } }) } = {}) {
  const calls = [];
  const client = {
    configured: () => true,
    sqlQuery: async () => [],
    call: async (endpoint, body, opts) => { calls.push({ endpoint, body, opts }); return call(endpoint, body); },
  };
  const p = new Planning({ dbFile: ':memory:', listMachines: () => MAKINELER, productionEvents: () => [], liveMachine: () => null, mikroClient: client });
  p.importCsv(Buffer.from(ISEMRI, 'utf8'));
  p.mikroStock.writeEnabled = () => writeEnabled;
  p.productDepot.enabled = () => depotEnabled;
  p.quarantineDepot.enabled = () => depotEnabled;
  return { p, calls };
}

function uretimdeIsEmri(p, { machine = 'CNC-01', target = 1000 } = {}) {
  const w = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: target, machineId: machine }, { now: NOW });
  return p.startWorkOrder(w.no, {}, { now: NOW }).no;
}

function bitmisIsEmri(p, qty, { machine = 'CNC-01', target = 1000 } = {}) {
  const no = uretimdeIsEmri(p, { machine, target });
  p.finishWorkOrder(no, { qty }, { now: NOW });
  return no;
}

/* ================================================================================ sendGiris/sendOk/sendHurda */

test('sendGiris: batchQty netleşince Karantina(5) İÇİNDE GİRİŞ virmanı gönderilir; delta ile çalışır (ikinci kez tam toplam değil)', async () => {
  const { p, calls } = kur();
  const no = uretimdeIsEmri(p);
  const q = p.quarantine.create({ woNo: no, productLabel: 'SR001.013', issue: 'Çap toleransı dışı', enteredBy: 'Ayşe', batchQty: 500 }, { now: NOW });
  await new Promise((r) => setTimeout(r, 0)); // create()'in fire-and-forget sendGiris'ini bekle
  const satir = calls[0].body.evraklar[0].satirlar[0];
  assert.deepEqual(
    [satir.sth_stok_kod, satir.sth_miktar, satir.sth_cikis_depo_no, satir.sth_giris_depo_no, satir.sth_evraktip, satir.sth_tip, satir.sth_cins, satir.sth_evrakno_seri],
    ['SR001.013', 500, KARANTINA_DEPO_NO, KARANTINA_DEPO_NO, 6, 0, 3, ''],
    'GIRIS virmani: cikis=giris=Karantina, evraktip=6/tip=0(giren)/cins=3, evrak serisi GIRIS oldugu icin bos',
  );
  const s1 = p.quarantineDepot.statusFor(q.id);
  assert.deepEqual([s1.giris.sent, s1.giris.pending], [500, 0]);

  // miktar sonradan 650'ye duzeltildi (yeniden tartim): yalniz DELTA (150) gonderilmeli.
  p.quarantine.update(q.id, { batchQty: 650 }, { now: NOW });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.evraklar[0].satirlar[0].sth_miktar, 150);
  assert.deepEqual([p.quarantineDepot.statusFor(q.id).giris.sent, p.quarantineDepot.statusFor(q.id).giris.pending], [650, 0]);
});

test('sendGiris: woNo yoksa ya da batchQty hiç girilmediyse hiçbir Mikro isteği atılmaz', async () => {
  const { p, calls } = kur();
  p.quarantine.create({ productLabel: 'SR001.013', issue: 'x', enteredBy: 'Ayşe' }, { now: NOW }); // woNo yok
  const no = uretimdeIsEmri(p);
  p.quarantine.create({ woNo: no, productLabel: 'SR001.013', issue: 'x', enteredBy: 'Ayşe' }, { now: NOW }); // batchQty yok
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.length, 0);
});

test('sendOk/sendHurda: Karantina(5)->Geçici(2) ve Karantina(5)->Hurda(3) TRANSFER olarak gönderilir', async () => {
  const { p, calls } = kur();
  const no = bitmisIsEmri(p, 1000);
  const q = p.quarantine.create({ woNo: no, productLabel: 'SR001.013', issue: 'x', enteredBy: 'Ayşe', batchQty: 500 }, { now: NOW });
  await p.quarantineDepot.sendOk(q.id, 300, { now: NOW });
  await p.quarantineDepot.sendHurda(q.id, 200, { now: NOW });
  const okSatir = calls.at(-2).body.evraklar[0].satirlar[0];
  const hurdaSatir = calls.at(-1).body.evraklar[0].satirlar[0];
  assert.deepEqual([okSatir.sth_miktar, okSatir.sth_cikis_depo_no, okSatir.sth_giris_depo_no], [300, KARANTINA_DEPO_NO, GECICI_DEPO_NO]);
  assert.deepEqual([hurdaSatir.sth_miktar, hurdaSatir.sth_cikis_depo_no, hurdaSatir.sth_giris_depo_no], [200, KARANTINA_DEPO_NO, HURDA_DEPO_NO]);
  const s = p.quarantineDepot.statusFor(q.id);
  assert.deepEqual([s.ok.sent, s.hurda.sent], [300, 200]);
  const events = p.getWorkOrder(no).events.map((e) => e.kind);
  assert.ok(events.includes('karantina-ok-aktarildi'));
  assert.ok(events.includes('karantina-hurda-aktarildi'));
});

/* ================================================================================ kapılar */

test('kapılar: PRODUCT_DEPOT_ENABLED kapalıyken sendGiris/sendOk/sendHurda 409 depot-flow-disabled verir, hiçbir Mikro isteği gitmez', async () => {
  const { p, calls } = kur({ depotEnabled: false });
  const no = uretimdeIsEmri(p);
  const q = p.quarantine.create({ woNo: no, productLabel: 'SR001.013', issue: 'x', enteredBy: 'Ayşe' }, { now: NOW });
  await assert.rejects(() => p.quarantineDepot.sendGiris(q.id, { now: NOW }).then((r) => { if (r === null) throw Object.assign(new Error('null'), { status: 0 }); return r; }), () => true);
  await assert.rejects(() => p.quarantineDepot.sendOk(q.id, 10, { now: NOW }), (e) => e.status === 409 && e.code === 'depot-flow-disabled');
  await assert.rejects(() => p.quarantineDepot.sendHurda(q.id, 10, { now: NOW }), (e) => e.status === 409 && e.code === 'depot-flow-disabled');
  assert.equal(calls.length, 0);
});

test('kapılar: MIKRO_WRITE_ENABLED kapalıyken 409 mikro-write-disabled, hiçbir kayıt yazılmaz', async () => {
  const { p, calls } = kur({ writeEnabled: false });
  const no = bitmisIsEmri(p, 100);
  const q = p.quarantine.create({ woNo: no, productLabel: 'SR001.013', issue: 'x', enteredBy: 'Ayşe' }, { now: NOW });
  await assert.rejects(() => p.quarantineDepot.sendOk(q.id, 10, { now: NOW }), (e) => e.status === 409 && e.code === 'mikro-write-disabled');
  assert.equal(calls.length, 0);
  assert.equal(p.quarantineDepot.statusFor(q.id).ok.history.length, 0, 'denenmedi: gecmise kaydedilmemis olmali');
});

/* ================================================================================ pendingQty / pendingOk / flushPendingOk */

test('pendingQtyForWorkOrder: birden fazla karantina kaydı aynı iş emrine bağlıyken toplanır; tashih ile çözülen kısım düşer', async () => {
  const { p } = kur();
  const no = uretimdeIsEmri(p);
  const q1 = p.quarantine.create({ woNo: no, productLabel: 'SR001.013', issue: 'x', enteredBy: 'A', batchQty: 300 }, { now: NOW });
  const q2 = p.quarantine.create({ woNo: no, productLabel: 'SR001.013', issue: 'y', enteredBy: 'A', batchQty: 200 }, { now: NOW });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(p.quarantineDepot.pendingQtyForWorkOrder(no), 500, 'ikisi de hic tashih edilmedi, tamami bekliyor');

  p.quarantine.addCorrection(q1.id, { operator: 'A', description: 'tashih', qty: 300, okQty: 120, scrapQty: 180 }, { now: NOW });
  assert.equal(p.quarantineDepot.pendingQtyForWorkOrder(no), 200, 'q1 tamamen cozuldu (120+180=300), yalniz q2nin 200u bekliyor');

  p.quarantine.addCorrection(q2.id, { operator: 'A', description: 'tashih', qty: 200, okQty: 200 }, { now: NOW });
  assert.equal(p.quarantineDepot.pendingQtyForWorkOrder(no), 0);
});

test('addCorrection: iş emri ÜRETİMDEYKEN OK sonucu Mikro\'ya HEMEN gitmez (yalnız iş emri geçmişine not düşer); hurda İŞ EMRİ DURUMUNDAN BAĞIMSIZ hemen gönderilir', async () => {
  const { p, calls } = kur();
  const no = uretimdeIsEmri(p); // HENUZ bitmedi
  const q = p.quarantine.create({ woNo: no, productLabel: 'SR001.013', issue: 'x', enteredBy: 'A', batchQty: 500 }, { now: NOW });
  await new Promise((r) => setTimeout(r, 0)); // sendGiris
  assert.equal(calls.length, 1, 'yalniz GIRIS gitti');

  p.quarantine.addCorrection(q.id, { operator: 'A', description: 'tashih', qty: 500, okQty: 300, scrapQty: 200 }, { now: NOW });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.length, 2, 'yalniz HURDA transferi gitti (OK ertelendi), GIRIS+HURDA=2');
  assert.equal(calls[1].body.evraklar[0].satirlar[0].sth_giris_depo_no, HURDA_DEPO_NO);

  const s = p.quarantineDepot.statusFor(q.id);
  assert.deepEqual([s.ok.sent, s.hurda.sent], [0, 200], 'OK henuz gonderilmedi, hurda gonderildi');
  assert.equal(p.quarantineDepot.pendingOkForWorkOrder(no), 300, '300 adet OK Mikroya gonderilmeyi bekliyor');
  const ev = p.getWorkOrder(no).events.find((e) => e.kind === 'karantina-tashih');
  assert.ok(ev, 'is emri gecmisine ertelenmis OK notu dusulmeli');
  assert.match(ev.detail, /300 adet OK/);
});

test('flushPendingOk: iş emri BİTİNCE üretimdeyken ertelenmiş OK otomatik Karantina->Geçici gönderilir (finishWorkOrder fire-and-forget çağırır)', async () => {
  const { p, calls } = kur();
  const no = uretimdeIsEmri(p, { target: 1000 });
  const q = p.quarantine.create({ woNo: no, productLabel: 'SR001.013', issue: 'x', enteredBy: 'A', batchQty: 500 }, { now: NOW });
  await new Promise((r) => setTimeout(r, 0));
  p.quarantine.addCorrection(q.id, { operator: 'A', description: 'tashih', qty: 500, okQty: 300, scrapQty: 200 }, { now: NOW });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(p.quarantineDepot.statusFor(q.id).ok.sent, 0, 'on kosul: OK henuz gonderilmedi');

  p.finishWorkOrder(no, { qty: 1000 }, { now: NOW });
  await new Promise((r) => setTimeout(r, 0)); // flushPendingOk fire-and-forget
  const s = p.quarantineDepot.statusFor(q.id);
  assert.equal(s.ok.sent, 300, 'is emri bitince ertelenmis OK otomatik gonderildi');
  const ev = p.getWorkOrder(no).events.find((e) => e.kind === 'karantina-ok-aktarildi');
  assert.ok(ev);
  assert.match(ev.detail, /300 adet/);
});

test('flushPendingOk: idempotent — iki kez çağrılırsa ikinci kez tekrar göndermez', async () => {
  const { p, calls } = kur();
  const no = uretimdeIsEmri(p);
  const q = p.quarantine.create({ woNo: no, productLabel: 'SR001.013', issue: 'x', enteredBy: 'A', batchQty: 100 }, { now: NOW });
  await new Promise((r) => setTimeout(r, 0));
  p.quarantine.addCorrection(q.id, { operator: 'A', description: 'tashih', qty: 100, okQty: 100 }, { now: NOW });

  await p.quarantineDepot.flushPendingOk(no, { now: NOW });
  const afterFirst = calls.length;
  await p.quarantineDepot.flushPendingOk(no, { now: NOW });
  assert.equal(calls.length, afterFirst, 'ikinci cagri hicbir yeni istek atmamali (gonderilecek bir sey kalmadi)');
});

test('addCorrection: iş emri ZATEN BİTMİŞKEN OK sonucu gelirse Karantina->Geçici transferi HEMEN (gecikme olmadan) gider', async () => {
  const { p, calls } = kur();
  const no = bitmisIsEmri(p, 1000);
  const q = p.quarantine.create({ woNo: no, productLabel: 'SR001.013', issue: 'x', enteredBy: 'A', batchQty: 400 }, { now: NOW });
  await new Promise((r) => setTimeout(r, 0));
  const beforeCorr = calls.length;

  p.quarantine.addCorrection(q.id, { operator: 'A', description: 'tashih', qty: 400, okQty: 400 }, { now: NOW });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(calls.length, beforeCorr + 1, 'is emri zaten bitmisti, OK hemen gonderilmeli');
  assert.equal(p.quarantineDepot.statusFor(q.id).ok.sent, 400);
});

/* ================================================================================ product-depot.js entegrasyonu */

test('sendFinishTransfer: karantinada (tashih sonucu belirlenmemiş) bekleyen miktar üretilen adetten DÜŞÜLÜR, iki kez sayılmaz', async () => {
  const { p } = kur();
  const no = uretimdeIsEmri(p, { target: 8000 });
  p.quarantine.create({ woNo: no, productLabel: 'SR001.013', issue: 'x', enteredBy: 'A', batchQty: 500 }, { now: NOW });
  await new Promise((r) => setTimeout(r, 0));
  p.finishWorkOrder(no, { qty: 8000 }, { now: NOW });
  await new Promise((r) => setTimeout(r, 0));

  const status = p.productDepot.statusFor(no);
  assert.deepEqual([status.bitis.produced, status.bitis.pendingQuarantine, status.bitis.pending], [8000, 500, 7500]);

  const r = await p.productDepot.sendFinishTransfer(no);
  assert.equal(r.bitis.sent, 7500, '8000 uretildi, 500u karantinada bekliyor: yalniz 7500 Geciciye gonderilmeli');
});

test('sendFinishTransfer: karantinadaki TÜM üretilen miktarı kapsıyorsa (hiçbiri çözülmediyse) "nothing-to-send" der, karantinaya özel mesaj verir', async () => {
  const { p } = kur();
  const no = uretimdeIsEmri(p, { target: 500 });
  p.quarantine.create({ woNo: no, productLabel: 'SR001.013', issue: 'x', enteredBy: 'A', batchQty: 500 }, { now: NOW });
  await new Promise((r) => setTimeout(r, 0));
  p.finishWorkOrder(no, { qty: 500 }, { now: NOW });
  await new Promise((r) => setTimeout(r, 0));
  await assert.rejects(() => p.productDepot.sendFinishTransfer(no), (e) => e.status === 409 && e.code === 'nothing-to-send' && /karantinada/.test(e.message));
});

/* ================================================================================ HTTP */

test('HTTP: GET .../:id yanıtında depot alanı; GET hurda-deposu; POST .../depot/retry-giris başarısız GİRİŞ\'i yeniden dener', async () => {
  const http = await import('node:http');
  const { createPlanningRoutes } = await import('./routes.js');
  let fail = true;
  const { p } = kur({ call: async (endpoint, body) => { if (fail) { fail = false; throw new Error('MikroAPI\'ye ulaşılamadı'); } return { Data: { list: [{ evrakno_seri: 'CNCT', evrakno_sira: '3' }] } }; } });
  const no = uretimdeIsEmri(p);
  const q = p.quarantine.create({ woNo: no, productLabel: 'SR001.013', issue: 'x', enteredBy: 'A', batchQty: 100 }, { now: NOW });
  await new Promise((r) => setTimeout(r, 0)); // ilk (basarisiz) sendGiris denemesi

  const routes = createPlanningRoutes({ planning: p });
  const srv = http.default.createServer(async (req, res) => { if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (yol, init) => { const r = await fetch(base + yol, init); return { status: r.status, json: await r.json() }; };
  try {
    const g = await j(`/api/planning/quarantine/${q.id}`);
    assert.equal(g.status, 200);
    assert.equal(g.json.depot.giris.pending, 100, 'ilk deneme basarisiz oldugu icin hala bekliyor');

    const retry = await j(`/api/planning/quarantine/${q.id}/depot/retry-giris`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(retry.status, 200);
    assert.equal(retry.json.depot.giris.sent, 100, 'elle yeniden deneme basarili olmali');

    p.quarantine.addCorrection(q.id, { operator: 'A', description: 'tashih', qty: 100, scrapQty: 100 }, { now: NOW });
    await new Promise((r) => setTimeout(r, 0));
    const h = await j('/api/planning/quarantine/hurda-deposu');
    assert.equal(h.status, 200);
    assert.equal(h.json.items.length, 1);
    assert.deepEqual([h.json.items[0].qty, h.json.items[0].stockCode], [100, 'SR001.013']);
  } finally {
    await new Promise((r) => srv.close(r));
    p.close();
  }
});
