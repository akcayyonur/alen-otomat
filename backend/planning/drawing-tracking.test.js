/**
 * Teknik resim takip (drawing-tracking.js, EYS.LS.007): her urunun teknik resim durumu/rev no/tarihleri.
 * `products` ile BAGLANMAZ (ad/kod oradan gelir); REV NO sistem tarafindan otomatik artirilir. TUM veriler sentetiktir.
 *
 * Yetki ('teknikresim' ekrani read/write, Excel ici aktarma admin-only) backend/auth/policy.test.js'te sinanir;
 * burada yalniz is mantigi, `recordDrawingChange`'in "ilk dijital esleme vs gercek revizyon" ayrimi ve HTTP uclari.
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Planning } from './planning.js';
import { createPlanningRoutes } from './routes.js';
import { xlsxOf, serial } from './test/xlsx-fixture.js';

const at = (h, m = 0, d = 12) => new Date(2026, 9, d, h, m).getTime();

function kur() {
  const p = new Planning({ dbFile: ':memory:' });
  p.createProduct({ stockCode: 'SR001.013', name: 'TEST SOMUN' }, { by: 'test' });
  p.createProduct({ stockCode: 'SR002.014', name: 'TEST NİPEL' }, { by: 'test' });
  return p;
}

/* ====================================================================================== recordDrawingChange (doc-folder.js kancasi) */

test('recordDrawingChange: hic izlenmeyen urunde ilk dijital esleme rev_no=0 ile baslar, revizyon rev_no=1 ile', () => {
  const p = kur();
  p.drawingTracking.recordDrawingChange('SR001.013', { isRevision: false, now: at(10) });
  const a = p.drawingTracking.list({ q: 'SR001.013' }).items[0];
  assert.equal(a.revNo, 0);
  assert.equal(a.yayinTarihi, at(10));
  assert.equal(a.revTarihi, null);

  const p2 = kur();
  p2.drawingTracking.recordDrawingChange('SR002.014', { isRevision: true, now: at(11) });
  const b = p2.drawingTracking.list({ q: 'SR002.014' }).items[0];
  assert.equal(b.revNo, 1, 'savunmaci: satir yoktu ama revizyon denildi');
  assert.equal(b.revTarihi, at(11));
  p.close(); p2.close();
});

test('recordDrawingChange: Excel baseline\'i olan urune ILK dijital esleme rev_no/rev_tarihine DOKUNMAZ, yalniz yayin_tarihi bossa doldurur', () => {
  const p = kur();
  p.drawingTracking.update('SR001.013', { revNo: 7, revTarihi: '13.10.2025' }, { now: at(9) });
  p.drawingTracking.recordDrawingChange('SR001.013', { isRevision: false, now: at(10) });
  const a = p.drawingTracking.list({ q: 'SR001.013' }).items[0];
  assert.equal(a.revNo, 7, 'Excel\'den gelen rev no korunur');
  assert.equal(a.revTarihi, new Date(2025, 9, 13).getTime(), 'rev tarihi korunur');
  assert.equal(a.yayinTarihi, at(10), 'yayin tarihi bos oldugu icin dolduruldu');

  // yayin tarihi de doluysa HICBIR SEY degismez
  const before = { ...a };
  p.drawingTracking.recordDrawingChange('SR001.013', { isRevision: false, now: at(12) });
  assert.deepEqual(p.drawingTracking.list({ q: 'SR001.013' }).items[0], before);
  p.close();
});

test('recordDrawingChange: zaten dijital resmi olan urunun dosyasi DEGISIRSE (gercek revizyon) rev_no +1 artar', () => {
  const p = kur();
  p.drawingTracking.recordDrawingChange('SR001.013', { isRevision: false, now: at(9) }); // ilk esleme: rev_no=0
  p.drawingTracking.recordDrawingChange('SR001.013', { isRevision: true, now: at(10) }); // gercek revizyon
  let a = p.drawingTracking.list({ q: 'SR001.013' }).items[0];
  assert.equal(a.revNo, 1);
  assert.equal(a.revTarihi, at(10));

  p.drawingTracking.recordDrawingChange('SR001.013', { isRevision: true, now: at(14) }); // ikinci revizyon
  a = p.drawingTracking.list({ q: 'SR001.013' }).items[0];
  assert.equal(a.revNo, 2);
  assert.equal(a.revTarihi, at(14));
  p.close();
});

test('doc-folder.js kancasi: ilk esleme rev_no artirmaz, klasorden DEGISEN dosya (update) +1 artirir', () => {
  const p = kur();
  // doc-folder.js'in match()'i 'had' (onceden cizim dosyasi var miydi) degerini aninda hesaplar: ilk eklemede false, update dalinda true
  p.drawingTracking.recordDrawingChange('SR001.013', { isRevision: false, now: at(9) });
  assert.equal(p.drawingTracking.list({ q: 'SR001.013' }).items[0].revNo, 0, 'had=false: ilk ekleme, artmadi');
  p.drawingTracking.recordDrawingChange('SR001.013', { isRevision: true, now: at(10) });
  assert.equal(p.drawingTracking.list({ q: 'SR001.013' }).items[0].revNo, 1, 'had=true (update dali): gercek revizyon, artti');
  p.close();
});

/* ====================================================================================== update (elle duzeltme) */

test('update: yalniz gonderilen alanlar degisir; satir yoksa olusturulur', () => {
  const p = kur();
  const a = p.drawingTracking.update('SR001.013', { musteri: 'AYVAZ', resimNo: 'R-100' }, { by: 'kalite', now: at(10) });
  assert.equal(a.musteri, 'AYVAZ');
  assert.equal(a.resimNo, 'R-100');
  assert.equal(a.revNo, 0, 'hic gonderilmedi: varsayilan');

  const b = p.drawingTracking.update('SR001.013', { durumu: 'revize edildi' }, { now: at(11) });
  assert.equal(b.musteri, 'AYVAZ', 'onceki alan dokunulmadi');
  assert.equal(b.durumu, 'revize edildi');
  assert.throws(() => p.drawingTracking.update('OLMAYAN-URUN', { musteri: 'x' }), /bulunamadı/);
  assert.throws(() => p.drawingTracking.update('SR001.013', { revNo: -1 }), /Rev no/);
  assert.throws(() => p.drawingTracking.update('SR001.013', { revNo: 1.5 }), /Rev no/);
  p.close();
});

test('update: urun kartindaki ad/stok kodu/musteri kodu ve drawingCount compose edilir', () => {
  const p = kur();
  const a = p.drawingTracking.update('SR001.013', { musteri: 'AYVAZ' }, { now: at(10) });
  assert.equal(a.stockCode, 'SR001.013');
  assert.equal(a.name, 'TEST SOMUN');
  assert.equal(a.drawingCount, 0);
  p.close();
});

/* ====================================================================================== list */

test('list: urun listesiyle ayni arama; izlenmeyen urunler varsayilan degerlerle gelir', () => {
  const p = kur();
  p.drawingTracking.update('SR001.013', { musteri: 'AYVAZ' }, { now: at(10) });
  const r = p.drawingTracking.list({});
  assert.equal(r.total, 2);
  const nipel = r.items.find((x) => x.stockCode === 'SR002.014');
  assert.equal(nipel.revNo, 0);
  assert.equal(nipel.musteri, null);
  const somun = r.items.find((x) => x.stockCode === 'SR001.013');
  assert.equal(somun.musteri, 'AYVAZ');
  assert.equal(p.drawingTracking.list({ q: 'SR001' }).total, 1);
  p.close();
});

test('customers: DISTINCT musteri adlarini alfabetik doner; hic kaydi olmayan urun katilmaz', () => {
  const p = kur();
  p.drawingTracking.update('SR001.013', { musteri: 'AYVAZ' }, { now: at(10) });
  p.drawingTracking.update('SR002.014', { musteri: 'Berg Metal' }, { now: at(10) });
  p.createProduct({ stockCode: 'SR003.015', name: 'ÜÇÜNCÜ ÜRÜN' }, { by: 'test' }); // hic teknik resim takip kaydi yok
  assert.deepEqual(p.drawingTracking.customers(), ['AYVAZ', 'Berg Metal']);
  p.close();
});

test('list: customer ile filtrelenince yalnız o müşterinin kaydı olan ürünler gelir; q ile BİRLİKTE de çalışır', () => {
  const p = kur();
  p.drawingTracking.update('SR001.013', { musteri: 'AYVAZ' }, { now: at(10) });
  p.drawingTracking.update('SR002.014', { musteri: 'Berg Metal' }, { now: at(10) });
  const r = p.drawingTracking.list({ customer: 'AYVAZ' });
  assert.equal(r.total, 1);
  assert.equal(r.items[0].stockCode, 'SR001.013');
  assert.equal(p.drawingTracking.list({ customer: 'Berg Metal' }).items[0].stockCode, 'SR002.014');
  assert.equal(p.drawingTracking.list({ customer: 'Olmayan Müşteri' }).total, 0);
  // q ile birlikte: ayni musteride iki urun olsa bile q eslesen tek urune daraltir
  p.drawingTracking.update('SR002.014', { musteri: 'AYVAZ' }, { now: at(11) });
  assert.equal(p.drawingTracking.list({ customer: 'AYVAZ' }).total, 2);
  assert.equal(p.drawingTracking.list({ customer: 'AYVAZ', q: 'SR001' }).total, 1);
  p.close();
});

/* ====================================================================================== Excel'den iceri aktarma (EYS.LS.007) */

const DRAWING_HEADERS = [
  'SIRA NO', 'RESİM NO', 'ÜRÜN ADI', 'MÜŞTERİ ÜRÜN KODU', 'ALEN OTOMAT ÜRÜN KODU', 'MÜŞTERİ', 'ALEN OTOMAT KAYIT TARİHİ',
  'REV. NO', 'YAYIN TARİHİ', 'REV. TARİHİ', 'TUTULDUĞU ORTAM', 'ÜRETİM BÖLÜMÜ', 'DAĞITIM TARİHİ', 'KALİTE KONTROL B.', 'DAĞITIM TARİHİ',
  null, null, 'ÜRETİM BÖLÜMÜ', 'TOPLAMA TARİHİ', 'KALİTE KONTROL B.', 'TOPLAMA TARİHİ', null, 'DURUMU', 'BÖLÜMDE', 'ARŞİVDE', 'Revizyon Nedeni',
];

function drawingRow({ resimNo = null, alenCode = '', musteri = '', kayit = null, revNo = 0, yayin = null, rev = null, ortam = 'BİLGİSAYAR', durumu = null } = {}) {
  return [95, resimNo, 'ÜRÜN ADI', null, alenCode, musteri, kayit, revNo, yayin, rev, ortam, 1, kayit, '-', '-', null, null, null, null, null, null, null, durumu];
}

test('iceri aktarma: baslik gercek Excel gibi 6. satirda (ustunde lejant); eslesen satirlar isleniyor', () => {
  const p = kur();
  const buf = xlsxOf([{
    name: 'TEKNİK RESİM TAKİP',
    rows: [
      [null, null, 'LİSTE TAKİP SORUMLUSU', 'DOKÜMAN NO:', null, 'EYS.LS.007', null, null, null, 'REVİZYON NO:', null, 0],
      [null, null, 'KALİTE BÖLÜMÜ', 'YAYIN TARİHİ:', null, { s: 2, n: serial(2024, 10, 4) }],
      [null, null, null, 'GÜNCELLEME TARİHİ:', null, { s: 2, n: serial(2025, 5, 14) }],
      ['SERİ ÜRETİM TEKNİK RESİM TAKİP LİSTESİ'],
      [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'DAĞITILAN BİRİMLER'],
      DRAWING_HEADERS,
      drawingRow({ resimNo: '601037010525', alenCode: 'SR001.013', musteri: 'AYVAZ', kayit: { s: 2, n: serial(2025, 1, 4) }, revNo: 1, yayin: { s: 2, n: serial(2019, 5, 28) } }),
      drawingRow({ alenCode: 'SR002.014', musteri: 'BHW KONTROL', kayit: { s: 2, n: serial(2025, 1, 4) }, durumu: 'revize edildi' }),
    ],
  }]);
  const r = p.drawingTracking.importXlsx(buf, { by: 'kalite', now: at(10) });
  assert.equal(r.total, 2);
  assert.equal(r.matched, 2);
  assert.equal(r.duplicates, 0);
  assert.equal(r.noProduct, 0);
  assert.deepEqual(r.warnings, []);

  const a = p.drawingTracking.list({ q: 'SR001.013' }).items[0];
  assert.equal(a.resimNo, '601037010525');
  assert.equal(a.musteri, 'AYVAZ');
  assert.equal(a.revNo, 1);
  assert.equal(a.yayinTarihi, new Date(2019, 4, 28).getTime());
  assert.equal(a.kayitTarihi, new Date(2025, 0, 4).getTime());

  const b = p.drawingTracking.list({ q: 'SR002.014' }).items[0];
  assert.equal(b.durumu, 'revize edildi');
  assert.equal(b.revNo, 0);
  p.close();
});

test('iceri aktarma: urun karti olmayan Alen kodu uyariyla ATLANIR, bos satir sayilmaz', () => {
  const p = kur();
  const buf = xlsxOf([{
    name: 'Sayfa1',
    rows: [
      DRAWING_HEADERS,
      drawingRow({ alenCode: '' }), // alen kodu yok: bos satir sayilir, hic sayilmaz
      drawingRow({ alenCode: 'SR999.999', musteri: 'YOK' }), // urun karti yok
      drawingRow({ alenCode: 'SR001.013', musteri: 'AYVAZ' }),
    ],
  }]);
  const r = p.drawingTracking.importXlsx(buf, { now: at(10) });
  assert.equal(r.total, 2, 'bos alen kodlu satir hic sayilmadi');
  assert.equal(r.matched, 1);
  assert.equal(r.noProduct, 1);
  assert.match(r.warnings[0], /ürün kartı yok/);
  p.close();
});

test('iceri aktarma: ayni Alen kodundan BIRDEN COK satir -> en YENI (rev/yayin/kayit tarihi) baz alinir, digeri yinelenen uyarisiyla atlanir', () => {
  const p = kur();
  const buf = xlsxOf([{
    name: 'Sayfa1',
    rows: [
      DRAWING_HEADERS,
      drawingRow({ alenCode: 'SR001.013', musteri: 'ESKİ', revNo: 1, rev: { s: 2, n: serial(2020, 1, 1) } }),
      drawingRow({ alenCode: 'SR001.013', musteri: 'YENİ', revNo: 2, rev: { s: 2, n: serial(2026, 1, 1) } }),
    ],
  }]);
  const r = p.drawingTracking.importXlsx(buf, { now: at(10) });
  assert.equal(r.total, 2);
  assert.equal(r.matched, 1);
  assert.equal(r.duplicates, 1);
  assert.match(r.warnings[0], /yinelenen/);
  const a = p.drawingTracking.list({ q: 'SR001.013' }).items[0];
  assert.equal(a.musteri, 'YENİ', 'en yeni (rev tarihi en ileri) kazandi');
  assert.equal(a.revNo, 2);
  p.close();
});

test('iceri aktarma: baslik bulunamazsa anlasilir hata', () => {
  const p = kur();
  const buf = xlsxOf([{ name: 'Sayfa1', rows: [['A', 'B', 'C'], [1, 2, 3]] }]);
  assert.throws(() => p.drawingTracking.importXlsx(buf), /EYS\.LS\.007/);
  p.close();
});

/* ====================================================================================== HTTP */

test('HTTP: listele, duzenle, Excel iceri aktar', async () => {
  const p = kur();
  const routes = createPlanningRoutes({ planning: p });
  const srv = http.createServer(async (req, res) => { if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (yol, method = 'GET', obj) => {
    const r = await fetch(base + yol, { method, headers: { 'content-type': 'application/json' }, ...(obj === undefined ? {} : { body: JSON.stringify(obj) }) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  try {
    const liste = await j('/api/planning/drawing-tracking');
    assert.equal(liste.json.total, 2);

    const duzenle = await j('/api/planning/drawing-tracking/SR001.013', 'PUT', { musteri: 'AYVAZ', resimNo: 'R-1' });
    assert.equal(duzenle.status, 200);
    assert.equal(duzenle.json.musteri, 'AYVAZ');

    assert.deepEqual((await j('/api/planning/drawing-tracking/customers')).json.items, ['AYVAZ']);
    const musteriyeGore = await j('/api/planning/drawing-tracking?customer=AYVAZ');
    assert.deepEqual(musteriyeGore.json.items.map((x) => x.stockCode), ['SR001.013']);

    assert.equal((await j('/api/planning/drawing-tracking/OLMAYAN', 'PUT', { musteri: 'x' })).status, 404);

    const buf = xlsxOf([{ name: 'Sayfa1', rows: [DRAWING_HEADERS, drawingRow({ alenCode: 'SR002.014', musteri: 'HTTP TEST' })] }]);
    const rImport = await fetch(`${base}/api/planning/drawing-tracking/import`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: buf });
    assert.equal(rImport.status, 200);
    const importJson = await rImport.json();
    assert.equal(importJson.matched, 1);
  } finally {
    await new Promise((r) => srv.close(r));
    p.close();
  }
});
