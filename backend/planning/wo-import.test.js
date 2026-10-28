/**
 * Eski is emri sisteminden BIR KEZLIK gecis (wo-import.js): PLANLANAN sayfasinin her satiri gercek bir work_orders
 * kaydi olur, durum renkten gelir (yesil=bitti, kirmizi=iptal, diger=planlandi). TUM veriler sentetiktir.
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanningDb } from './planning-db.js';
import { importHistoricalWorkOrders } from './wo-import.js';

const HEADERS = [
  'ÜRETİM EMRİ NO', 'TARİH', 'MAMÜL ADI', 'ALEN KOD', 'MÜŞTERİ KODU', 'MAKİNA NO', 'ADET', 'HAMMADDE', 'ALTERNATİF HM',
  'ÜRETİM SN', 'HM TOPLAM', 'BRÜT GR', 'NET GR', 'SAAT', 'TERMİN TARİHİ', 'HM TOPLAM BOY', 'GKK RAPOR NO ', 'İLK RAPOR NO',
];
const row = (over = {}) => {
  const base = {
    no: '2026000001', tarih: '02.01.2026', ad: 'TEST PARCA', alen: 'SR001.001', musteri: '140100168', makina: 'CNC',
    adet: '3500', hammadde: 'HM614.AA19.00', alt: '', sn: '24', hmToplam: '62', bruyGr: '0,0179', netGr: '0,0078',
    saat: '23,3', termin: '12.01.2026', boy: '7,67', gkk: '25-001', ilkonay: 'i26-010',
  };
  const r = { ...base, ...over };
  return [r.no, r.tarih, r.ad, r.alen, r.musteri, r.makina, r.adet, r.hammadde, r.alt, r.sn, r.hmToplam, r.bruyGr, r.netGr, r.saat, r.termin, r.boy, r.gkk, r.ilkonay];
};

function kur() {
  const db = new PlanningDb(':memory:');
  // urun kartlari zaten var sayilir (importIsEmri ayri calisir): iliskili ALEN KOD'lar icin burada elle olusturuluyor.
  for (const code of ['SR001.001', 'SR002.001', 'SR003.001']) {
    db.saveProduct(code.toLowerCase(), { stockCode: code, name: 'x' }, { source: 'elle', now: Date.now() });
  }
  return db;
}

test('yesil = bitti, ADET hem hedef hem SONUC; kirmizi = iptal (nedenli); baska renk/renksiz = planlandi', () => {
  const db = kur();
  const parsed = {
    headers: HEADERS,
    rows: [row({ no: '2026000001' }), row({ no: '2026000002', alen: 'SR002.001' }), row({ no: '2026000003', alen: 'SR003.001' })],
    rowFills: ['92D050', 'FF0000', 'FFFF00'],
  };
  const r = importHistoricalWorkOrders(db, parsed, { by: 'gocmen' });
  assert.deepEqual([r.totalRows, r.added, r.existing, r.skipped], [3, 3, 0, 0]);
  assert.deepEqual(r.byStatus, { bitti: 1, iptal: 1, planlandi: 1 });

  const bitti = db.getWorkOrder('2026000001');
  assert.equal(bitti.status, 'bitti');
  assert.equal(bitti.result.produced, 3500, 'ADET = SONUC');
  assert.notEqual(bitti.startedAt, null, 'startedAt dolu olmali (progress gorunsun diye)');
  assert.notEqual(bitti.finishedAt, null);

  const iptal = db.getWorkOrder('2026000002');
  assert.equal(iptal.status, 'iptal');
  assert.match(iptal.cancelReason, /içeri aktarıldı/);

  const planlandi = db.getWorkOrder('2026000003');
  assert.equal(planlandi.status, 'planlandi');
  assert.equal(planlandi.startedAt, null, 'planlandi is emri baslamamis olmali');
});

test('renksiz satir (null fill) de planlandi sayilir', () => {
  const db = kur();
  const r = importHistoricalWorkOrders(db, { headers: HEADERS, rows: [row()], rowFills: [null] }, {});
  assert.equal(r.byStatus.planlandi, 1);
  assert.equal(db.getWorkOrder('2026000001').status, 'planlandi');
});

test('tezgah atanmaz (MAKİNA NO genel kategori, belirli tezgah degil)', () => {
  const db = kur();
  importHistoricalWorkOrders(db, { headers: HEADERS, rows: [row()], rowFills: ['92D050'] }, {});
  assert.equal(db.getWorkOrder('2026000001').machineId, null);
});

test('bos ALEN KOD atlanir (uzak bos satirdaki unutulmus "." gibi), gecersiz is emri no da atlanir', () => {
  const db = kur();
  const bosAlenKod = row({ alen: '' });
  const kisaNo = row({ no: '123', alen: 'SR002.001' });
  const r = importHistoricalWorkOrders(db, { headers: HEADERS, rows: [bosAlenKod, kisaNo], rowFills: ['92D050', '92D050'] }, {});
  // totalRows yalniz TUM gecerlilik kontrollerini gecen satirlari sayar (importIsEmri ile ayni kural); ikisi de atlandi.
  assert.deepEqual([r.totalRows, r.skipped, r.added], [0, 2, 0]);
  assert.equal(r.warnings.length, 1, 'bos ALEN KOD icin uyari yazilmaz (bilinen/zararsiz), gecersiz is emri no icin yazilir');
});

test('idempotent: ayni dosya ikinci kez calistirilinca mevcut is emirlerine DOKUNULMAZ', () => {
  const db = kur();
  const parsed = { headers: HEADERS, rows: [row()], rowFills: ['92D050'] };
  importHistoricalWorkOrders(db, parsed, { by: 'gocmen' });
  const before = db.getWorkOrder('2026000001');

  const r2 = importHistoricalWorkOrders(db, parsed, { by: 'baska-biri' });
  assert.deepEqual([r2.added, r2.existing], [0, 1]);
  const after = db.getWorkOrder('2026000001');
  assert.deepEqual(before, after, 'ikinci kosu kaydi degistirmedi');
});

test('seq_floor en buyuk goruneni yukseltir (sonraki YENI is emri numarasi Excel ile cakismasin)', () => {
  const db = kur();
  const parsed = {
    headers: HEADERS,
    rows: [row({ no: '2026000005' }), row({ no: '2026000012', alen: 'SR002.001' })],
    rowFills: ['92D050', 'FFFF00'],
  };
  importHistoricalWorkOrders(db, parsed, {});
  assert.equal(db.seqInfo(2026).floor, 12);
});

test('HTTP ile hic ilgisi yok: dogrudan db ile calisir, hata firlatmaz (bozuk satir atlanir, cokmez)', () => {
  const db = kur();
  const bozuk = row({ adet: 'abc' });
  const r = importHistoricalWorkOrders(db, { headers: HEADERS, rows: [bozuk], rowFills: ['92D050'] }, {});
  assert.deepEqual([r.totalRows, r.skipped, r.added], [1, 1, 0]);
});
