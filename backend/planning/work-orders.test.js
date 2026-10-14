/**
 * Is emirleri (planlama B asamasi): hesaplar, numara sirasi, siparis satirindan olusturma, kopya degerler, planlanan/planlanmamis adet,
 * guncelleme/iptal, arama ve HTTP uclari. TUM veriler sentetiktir.
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { rawMaterial, plannedHours, machineNumber } from './calc.js';
import { Planning } from './planning.js';
import { createPlanningRoutes } from './routes.js';

const NOW = new Date(2026, 9, 12, 10, 0, 0).getTime();
const MAKINELER = [{ id: 'CNC-01', name: 'Torna 1' }, { id: 'CNC-03', name: 'Torna 3' }];

const ISEMRI = [
  'ÜRETİM EMRİ NO;TARİH;MAMÜL ADI;ALEN KOD;MÜŞTERİ KODU;MAKİNA NO;ADET;HAMMADDE;ALTERNATİF HM;ÜRETİM SN;HM TOPLAM;BRÜT GR;NET GR',
  '2026000001;02.01.2026;TEST SOMUN A;SR001.013;100000013;CNC;3500;HM614.YU23.00;;27;62,65;0,039;0,0078',
  '2026000002;05.01.2026;TEST NİPEL;Nİ002.001;600000000001;CNC;500;HM617.YU18.00;;45;53;0,1065;0,036',
  '2026000003;06.01.2026;TEST PARÇA C;SR003.001;300;CNC;100;HM617.YU18.00;;30;1;0,02;0,01',
  '',
].join('\r\n');

const SIPARIS_BASLIK = 'Musteri;Mamul_Kodu;Mamul_Adi;Evrak_No;Sip_Tarihi;Miktar;Sevk_Edilen_Miktar;Kalan_Miktar;Teyit_Edilen_Tarih;Must_Sip_No;TAM BOY';
const SIPARIS = [
  SIPARIS_BASLIK,
  'FIRMA A;SR001.013;TEST SOMUN A;SPR-1;13.09.2026;1000;0;1000;30.10.2026;SIP-100;13',
  'FIRMA A;Nİ002.001;TEST NİPEL;SPR-1;13.09.2026;400;100;300;15.11.2026;SIP-100;43',
  'FIRMA A;SR777.001;KARTSIZ URUN;SPR-1;13.09.2026;50;0;50;;SIP-100;5',
  'FIRMA A;PR-001;PİRİNÇ TALAŞI;SPR-2;13.09.2026;500;0;500;;SIP-200;',
  '',
].join('\r\n');

function kur() {
  const p = new Planning({ dbFile: ':memory:', listMachines: () => MAKINELER });
  p.importCsv(Buffer.from(ISEMRI, 'utf8'));
  p.importCsv(Buffer.from(SIPARIS, 'utf8'));
  return p;
}
/** SIP-100 siparisinin satirlari (id ile). */
function satirlar(p) {
  const [g] = p.searchOrders({ q: 'SIP-100' });
  return p.orderLines({ customerKey: g.customerKey, custOrderKey: g.custOrderKey, docKey: g.docKey });
}
const satir = (p, kod) => satirlar(p).find((s) => s.stockCode === kod);
/** Urun karti OLMAYAN satir: talas satiri (PR-001 urun degil, siparis iceri almasi bunun icin kart acmaz). */
function kartsizSatir(p) {
  const [g] = p.searchOrders({ q: 'SIP-200' });
  return p.orderLines({ customerKey: g.customerKey, custOrderKey: g.custOrderKey, docKey: g.docKey })[0];
}

/* ----------------------------------------------------------------- hesaplar */

test('hesaplar: hammadde kg, cubuk sayisi, planlanan saat (Excel formulleriyle ayni); bilinmeyen null', () => {
  // kagit is emri ornegi: 250 adet, brut 39 g, 27 sn  ->  9,75 kg, 1,88 saat
  assert.equal(rawMaterial({ qty: 250, grossKg: 0.039, lengthMm: null }).kg, 9.75);
  assert.equal(plannedHours(250, 27), 1.88);
  // BOY = adet x (tam boy + 2) / 2900 (gercek veride Excel ile birebir: 5000 adet, 13 mm -> 25,86)
  assert.equal(rawMaterial({ qty: 5000, grossKg: 0.07, lengthMm: 13 }).bars, 25.86);
  assert.equal(rawMaterial({ qty: 2000, grossKg: 0.07, lengthMm: 28 }).bars, 20.69);
  assert.deepEqual(rawMaterial({ qty: 100, grossKg: null, lengthMm: null }), { kg: null, bars: null }, 'bilinmeyen 0 degil null');
  assert.equal(plannedHours(100, null), null);
  assert.equal(machineNumber('CNC-03'), 3);
  assert.equal(machineNumber('CNC-12'), 12);
  assert.equal(machineNumber('TORNA'), null);
});

/* ------------------------------------------------------------ numara sirasi */

test('numara: yil + 6 haneli sira; Excel\'den gelen taban uzerinden devam eder, hic dusmez', () => {
  const bos = new Planning({ dbFile: ':memory:', listMachines: () => MAKINELER });
  assert.equal(bos.nextWorkOrderNo(NOW).no, '2026000001', 'taban yoksa 1\'den');
  bos.close();

  const p = kur();
  assert.equal(p.nextWorkOrderNo(NOW).no, '2026000004', 'is emirleri listesi 2026000003\'e kadar: devam eder');
  const a = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 100, machineId: 'CNC-01' }, { now: NOW });
  const b = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 100, machineId: 'CNC-01' }, { now: NOW });
  assert.equal(a.no, '2026000004');
  assert.equal(b.no, '2026000005');

  // daha kucuk dosya tabani dusurmez
  p.importCsv(Buffer.from(ISEMRI.split('\r\n').slice(0, 2).join('\r\n'), 'utf8'));
  assert.equal(p.nextWorkOrderNo(NOW).no, '2026000006');

  // elle taban: Excel'de en son 2026001109 verilmis
  assert.equal(p.setWorkOrderSequence('2026001109').no.slice(4), '001110');
  assert.equal(p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 10, machineId: 'CNC-01' }, { now: NOW }).no, '2026001110');
  assert.throws(() => p.setWorkOrderSequence('2026000010'), (e) => e.status === 409, 'verilmis numaranin altina inilmez');
  assert.throws(() => p.setWorkOrderSequence('12345'), /10 haneli/);

  // yeni yil: sira yeniden baslar (taban yoksa 1)
  const yeniYil = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 10, machineId: 'CNC-01' }, { now: new Date(2027, 0, 5).getTime() });
  assert.equal(yeniYil.no, '2027000001');
  p.close();
});

/* ------------------------------------------------- siparis satirindan olusturma */

test('olusturma: siparis satirindan; urun degerleri KOPYALANIR, hesaplar ve varsayilan termin gelir', () => {
  const p = kur();
  const s = satir(p, 'SR001.013');
  assert.equal(s.unplanned, 1000);
  const w = p.createWorkOrder({ lineId: s.id, targetQty: 250, machineId: 'CNC-03', note: 'acil', sampleQty: 20 }, { by: 'ayse', now: NOW });

  assert.equal(w.no, '2026000004');
  assert.equal(w.status, 'planlandi');
  assert.equal(w.stockCode, 'SR001.013');
  assert.equal(w.productName, 'TEST SOMUN A');
  assert.equal(w.customerCode, '100000013');
  assert.equal(w.custOrderNo, 'SIP-100');
  assert.equal(w.docNo, 'SPR-1');
  assert.equal(w.customer, 'FIRMA A');
  assert.equal(w.material, 'HM614.YU23.00');
  assert.equal(w.grossKg, 0.039);
  assert.equal(w.plannedSec, 27);
  assert.equal(w.lengthMm, 13, 'tam boy siparis dosyasindan urun kartina, oradan is emrine');
  assert.equal(w.sampleQty, 20);
  assert.equal(w.dueDate, new Date(2026, 9, 30).getTime(), 'termin: siparis satirinin teyit tarihi');
  assert.equal(w.machineNumber, 3);
  assert.equal(w.rawKg, 9.75);
  assert.equal(w.plannedHours, 1.88);
  assert.equal(w.bars, 1.29, '250 x (13 + 2) / 2900');
  assert.equal(w.createdBy, 'ayse');
  assert.deepEqual(w.warnings, []);

  const e = p.getWorkOrder(w.no).events;
  assert.equal(e.length, 1);
  assert.equal(e[0].kind, 'olusturuldu');
  p.close();
});

test('olusturma: urun karti sonradan degisse is emri DEGISMEZ; is emrine ozel deger duzeltilebilir', () => {
  const p = kur();
  const w = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 100, machineId: 'CNC-01' }, { now: NOW });
  p.updateProduct('SR001.013', { grossKg: 0.05, plannedSec: 99, material: 'YENI-HM' });
  const g = p.getWorkOrder(w.no);
  assert.equal(g.grossKg, 0.039);
  assert.equal(g.plannedSec, 27);
  assert.equal(g.material, 'HM614.YU23.00');

  const o = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 100, machineId: 'CNC-01', plannedSec: 30, material: 'OZEL-HM' }, { now: NOW });
  assert.equal(o.plannedSec, 30, 'olusturulurken is emrine ozel sure');
  assert.equal(o.material, 'OZEL-HM');
  assert.equal(o.grossKg, 0.05, 'verilmeyen alan karttan (guncel kopya)');
  p.close();
});

test('planlanan / planlanmamis: satira bagli is emirleri toplanir, iptal geri verir, fazla hedef uyari', () => {
  const p = kur();
  const s = satir(p, 'SR001.013');
  const a = p.createWorkOrder({ lineId: s.id, targetQty: 600, machineId: 'CNC-01' }, { now: NOW });
  assert.equal(satir(p, 'SR001.013').planned, 600);
  assert.equal(satir(p, 'SR001.013').unplanned, 400);

  const b = p.createWorkOrder({ lineId: s.id, targetQty: 500, machineId: 'CNC-03' }, { now: NOW });
  assert.match(b.warnings[0], /planlanmamış kalanından \(400\) fazla/);
  assert.equal(satir(p, 'SR001.013').unplanned, 0, '0\'in altina inmez');

  p.cancelWorkOrder(b.no, { reason: 'müşteri vazgeçti', by: 'ayse', now: NOW });
  assert.equal(satir(p, 'SR001.013').planned, 600, 'iptal edilen sayilmaz');
  assert.equal(satir(p, 'SR001.013').unplanned, 400);
  assert.equal(p.getWorkOrder(a.no).line.planned, 600);
  // kismi sevk edilmis satir: kalan 300
  assert.equal(satir(p, 'Nİ002.001').unplanned, 300);
  p.close();
});

test('olusturma dogrulamalari: kart yok, eski satir, bilinmeyen tezgah, adet, numune, net > brut', () => {
  const p = kur();
  const kartsiz = kartsizSatir(p);
  assert.equal(kartsiz.hasProduct, false);
  assert.equal(satir(p, 'SR777.001').hasProduct, true, 'urun biçimli kod icin taslak kart acilir (eksik alanlar sonra doldurulur)');
  assert.throws(() => p.createWorkOrder({ lineId: kartsiz.id, targetQty: 5, machineId: 'CNC-01' }), (e) => e.status === 409 && e.code === 'no-product');
  assert.throws(() => p.createWorkOrder({ stockCode: 'YOK-1', targetQty: 5, machineId: 'CNC-01' }), (e) => e.code === 'no-product');
  assert.throws(() => p.createWorkOrder({ lineId: 99999, targetQty: 5, machineId: 'CNC-01' }), (e) => e.status === 404);
  assert.throws(() => p.createWorkOrder({ targetQty: 5, machineId: 'CNC-01' }), /satırı ya da stok kodu/);
  const ok = { stockCode: 'SR001.013', machineId: 'CNC-01' };
  assert.throws(() => p.createWorkOrder({ ...ok, targetQty: 5, machineId: 'CNC-99' }), /Bilinmeyen tezgah/);
  // tezgah artik ZORUNLU DEGIL (baslatirken secilir): bos / verilmemis = atanmamis (bkz. wo-fields.test.js)
  assert.equal(p.createWorkOrder({ ...ok, targetQty: 5, machineId: '' }).machineId, null);
  assert.equal(p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 5 }).machineId, null);
  assert.throws(() => p.createWorkOrder({ ...ok }), /Hedef adet gerekli/);
  assert.throws(() => p.createWorkOrder({ ...ok, targetQty: 0 }), /Hedef adet/);
  assert.throws(() => p.createWorkOrder({ ...ok, targetQty: 1.5 }), /Hedef adet/);
  assert.throws(() => p.createWorkOrder({ ...ok, targetQty: 5, sampleQty: 9 }), /Numune adedi/);
  assert.throws(() => p.createWorkOrder({ ...ok, targetQty: 5, netKg: 1, grossKg: 0.5 }), /Net ağırlık brüt/);
  assert.throws(() => p.createWorkOrder({ ...ok, targetQty: 5, dueDate: 'yarın' }), /Termin/);
  assert.equal(p.listWorkOrders({ status: 'tumu' }).total, 2, 'hatali istekler hicbir sey olusturmadi (yalniz yukaridaki iki GECERLI tezgahsiz is emri var)');
  assert.equal(p.nextWorkOrderNo(NOW).no, '2026000006', 'hatali istekler numara harcamadi: yalniz iki gecerli tezgahsiz is emri (004, 005) numara aldi');

  // siparis dosyasindan cikmis (eski) satir
  const s = satir(p, 'SR001.013');
  p.importCsv(Buffer.from(SIPARIS.split('\r\n').filter((l) => !l.includes('SR001.013')).join('\r\n'), 'utf8'));
  assert.throws(() => p.createWorkOrder({ lineId: s.id, targetQty: 5, machineId: 'CNC-01' }), (e) => e.status === 409 && e.code === 'stale-line');
  p.close();
});

test('siparissiz is emri: stok kodu ile; termin metin, bos ve null kabul', () => {
  const p = kur();
  const w = p.createWorkOrder({ stockCode: 'nı002.001', targetQty: 10, machineId: 'CNC-01', dueDate: '20.11.2026' }, { now: NOW });
  assert.equal(w.stockCode, 'Nİ002.001', 'Turkce I katlanir');
  assert.equal(w.lineId, null);
  assert.equal(w.custOrderNo, '');
  assert.equal(w.dueDate, new Date(2026, 10, 20).getTime());
  assert.equal(p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 10, machineId: 'CNC-01', dueDate: '' }, { now: NOW }).dueDate, null);
  p.close();
});

/* ----------------------------------------------------------- guncelle / iptal */

test('guncelleme: izinli alanlar degisir, olay kaydi tutulur; iptal edilen degismez; iptal nedeni zorunlu', () => {
  const p = kur();
  const w = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 100, machineId: 'CNC-01' }, { by: 'ayse', now: NOW });
  const g = p.updateWorkOrder(w.no, {
    targetQty: 150, machineId: 'CNC-03', note: 'not', materialGkNo: 'artik-yok', gkkReportNo: '26-166', firstApprovalNo: '26-1170',
    usedMaterial: 'HM614.YU23.00', measuredNetKg: 0.0079, plannedSec: 28,
  }, { by: 'veli', now: NOW + 1000 });
  assert.equal(g.targetQty, 150);
  assert.equal(g.machineId, 'CNC-03');
  assert.equal(g.machineNumber, 3);
  assert.equal(g.materialGkNo, undefined, 'hammadde GK no kaldirildi (GKK rapor no ile ayni sey): gonderilse de yok sayilir');
  assert.equal(g.gkkReportNo, '26-166');
  assert.equal(g.firstApprovalNo, '26-1170');
  assert.equal(g.measuredNetKg, 0.0079);
  assert.equal(g.plannedSec, 28);
  assert.equal(g.updatedBy, 'veli');
  assert.equal(g.rawKg, 5.85, 'hedef adet degisince hammadde yeniden hesaplanir (150 x 0,039)');
  const olay = g.events.at(-1);
  assert.equal(olay.kind, 'guncellendi');
  assert.match(olay.detail, /hedef adet: 100 → 150/);
  assert.ok(olay.detail.includes('ölçülen net gramaj (g): — → 7.9'), 'agirlik gecmiste gram olarak yazilir');

  assert.equal(p.updateWorkOrder(w.no, { note: 'not' }).events.length, 2, 'degisiklik yoksa olay yazilmaz');
  assert.throws(() => p.updateWorkOrder(w.no, { sampleQty: 500 }), /Numune adedi/);
  assert.throws(() => p.updateWorkOrder(w.no, { netKg: 5 }), /Net ağırlık brüt/);
  assert.throws(() => p.updateWorkOrder(w.no, { machineId: 'CNC-99' }), /Bilinmeyen tezgah/);
  assert.throws(() => p.updateWorkOrder('2026999999', { note: 'x' }), (e) => e.status === 404);

  assert.throws(() => p.cancelWorkOrder(w.no, { reason: '' }), /İptal nedeni/);
  assert.throws(() => p.cancelWorkOrder(w.no, { reason: 'ab' }), /İptal nedeni/);
  const iptal = p.cancelWorkOrder(w.no, { reason: 'yanlış girildi', by: 'ayse', now: NOW + 5000 });
  assert.equal(iptal.status, 'iptal');
  assert.equal(iptal.cancelReason, 'yanlış girildi');
  assert.equal(iptal.cancelledAt, NOW + 5000);
  assert.throws(() => p.updateWorkOrder(w.no, { note: 'y' }), (e) => e.status === 409 && e.code === 'cancelled');
  assert.throws(() => p.cancelWorkOrder(w.no, { reason: 'tekrar' }), (e) => e.status === 409);
  p.close();
});

/* ----------------------------------------------------------------- liste/arama */

test('liste ve arama: numara, Turkce urun adi, musteri siparis no, tezgah, durum', () => {
  const p = kur();
  const a = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 100, machineId: 'CNC-01' }, { now: NOW });
  const b = p.createWorkOrder({ lineId: satir(p, 'Nİ002.001').id, targetQty: 50, machineId: 'CNC-03' }, { now: NOW });
  p.cancelWorkOrder(a.no, { reason: 'deneme' });

  assert.equal(p.listWorkOrders().total, 1, 'varsayilan: iptal haric');
  assert.equal(p.listWorkOrders({ status: 'tumu' }).total, 2);
  assert.equal(p.listWorkOrders({ status: 'iptal' }).items[0].no, a.no);
  assert.equal(p.listWorkOrders({ q: b.no }).items[0].no, b.no);
  assert.equal(p.listWorkOrders({ q: 'nipel' }).total, 1, 'NİPEL aramasi nipel ile bulunur');
  assert.equal(p.listWorkOrders({ q: 'ni002.001' }).total, 1);
  assert.equal(p.listWorkOrders({ q: 'sip-100' }).total, 1, 'musteri siparis no');
  assert.equal(p.listWorkOrders({ q: 'somun', status: 'tumu' }).total, 1);
  assert.equal(p.listWorkOrders({ machineId: 'CNC-03' }).total, 1);
  assert.equal(p.listWorkOrders({ machineId: 'CNC-01' }).total, 0);
  assert.equal(p.listWorkOrders({ q: '%', status: 'tumu' }).total, 0, 'LIKE ozel karakteri desen olmaz');
  assert.equal(p.listWorkOrders({ status: 'tumu' }).items[0].no, b.no, 'en yeni once');
  p.close();
});

test('ozet: tezgah listesi ve siradaki numara', () => {
  const p = kur();
  const s = p.summary();
  assert.deepEqual(s.machines, [{ id: 'CNC-01', name: 'Torna 1' }, { id: 'CNC-03', name: 'Torna 3' }]);
  assert.match(s.nextWorkOrder.no, /^\d{10}$/);
  assert.equal(s.nextWorkOrder.floor, 3, 'iceri alinan is emirleri listesinden');
  p.close();
});

/* ------------------------------------------------------------------------ HTTP */

test('HTTP: is emri olustur / oku / guncelle / iptal / numara uclari ve hata kodlari', async () => {
  const planning = kur();
  const routes = createPlanningRoutes({ planning });
  const srv = http.createServer(async (req, res) => {
    if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (yol, init) => {
    const r = await fetch(base + yol, init);
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const gonder = (yol, method, obj) => j(yol, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  try {
    const sira = (await j('/api/planning/work-orders/next')).json;
    assert.equal(sira.floor, 3);

    const s = satir(planning, 'SR001.013');
    const yeni = await gonder('/api/planning/work-orders', 'POST', { lineId: s.id, targetQty: 200, machineId: 'CNC-03', sampleQty: 10 });
    assert.equal(yeni.status, 201);
    const no = yeni.json.no;
    assert.match(no, /^\d{10}$/);
    assert.equal(yeni.json.rawKg, 7.8);

    assert.equal((await gonder('/api/planning/work-orders', 'POST', { lineId: s.id, targetQty: 0, machineId: 'CNC-03' })).status, 400);
    assert.equal((await gonder('/api/planning/work-orders', 'POST', { lineId: kartsizSatir(planning).id, targetQty: 1, machineId: 'CNC-03' })).json.code, 'no-product');

    const oku = (await j(`/api/planning/work-orders/${no}`)).json;
    assert.equal(oku.line.planned, 200);
    assert.equal(oku.events.length, 1);
    assert.equal((await j('/api/planning/work-orders/2026999999')).status, 404);

    const put = await gonder(`/api/planning/work-orders/${no}`, 'PUT', { targetQty: 300, gkkReportNo: '26-1' });
    assert.equal(put.json.targetQty, 300);
    assert.equal(put.json.gkkReportNo, '26-1');
    assert.equal((await gonder(`/api/planning/work-orders/${no}`, 'PUT', { machineId: 'CNC-99' })).status, 400);

    const liste = (await j('/api/planning/work-orders?q=somun&machine=CNC-03')).json;
    assert.equal(liste.total, 1);
    assert.equal((await j('/api/planning/work-orders?status=bozuk')).json.total, 1, 'bilinmeyen durum filtresi aktif sayilir');

    assert.equal((await gonder(`/api/planning/work-orders/${no}/cancel`, 'POST', { reason: '' })).status, 400);
    assert.equal((await gonder(`/api/planning/work-orders/${no}/cancel`, 'POST', { reason: 'deneme' })).json.status, 'iptal');
    assert.equal((await gonder(`/api/planning/work-orders/${no}/cancel`, 'POST', { reason: 'deneme' })).status, 409);
    assert.equal((await gonder(`/api/planning/work-orders/${no}`, 'PUT', { note: 'x' })).status, 409);

    assert.equal((await gonder('/api/planning/work-orders/sequence', 'PUT', { last: '2026001109' })).json.floor, 1109);
    assert.equal((await gonder('/api/planning/work-orders/sequence', 'PUT', { last: 'abc' })).status, 400);
    assert.equal((await j('/api/planning/work-orders/next')).json.no.slice(4), '001110');
  } finally {
    await new Promise((r) => srv.close(r));
    planning.close();
  }
});
