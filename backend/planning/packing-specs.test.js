/**
 * Paketleme listesi (packing-specs.js, EYS.LS.005): koli boyutu/kasa ozelligi/kat sayisi/koli ici adet/etiket/
 * agirlik referans kaydi. `products` ile BAGLANMAZ (ad/kod oradan gelir); `koli_ici_adet` `products.box_qty`'den
 * BAGIMSIZ kendi alani (packing.test.js'teki entegrasyon testleri bu ikisinin ETKILESIMINI sinar). TUM veriler
 * sentetiktir.
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Planning } from './planning.js';
import { createPlanningRoutes } from './routes.js';
import { xlsxOf } from './test/xlsx-fixture.js';

const at = (h, m = 0, d = 12) => new Date(2026, 9, d, h, m).getTime();

function kur() {
  const p = new Planning({ dbFile: ':memory:' });
  p.createProduct({ stockCode: 'SR001.013', name: 'TEST SOMUN' }, { by: 'test' });
  p.createProduct({ stockCode: 'SR002.014', name: 'TEST NİPEL' }, { by: 'test' });
  return p;
}

/* ====================================================================================== update + learnIfEmpty */

test('update: yalniz gonderilen alanlar degisir; satir yoksa olusturulur; "X" kat sayisi null olur', () => {
  const p = kur();
  const a = p.packingSpecs.update('SR001.013', { musteri: 'AYVAZ', koliBoyutu: '25 X 25 X 17', katSayisi: 'x ' }, { now: at(10) });
  assert.equal(a.musteri, 'AYVAZ');
  assert.equal(a.koliBoyutu, '25 X 25 X 17');
  assert.equal(a.katSayisi, null, '"X" yer tutucu null sayilir');

  const b = p.packingSpecs.update('SR001.013', { koliIciAdet: 500 }, { now: at(11) });
  assert.equal(b.musteri, 'AYVAZ', 'onceki alan dokunulmadi');
  assert.equal(b.koliIciAdet, 500);
  assert.throws(() => p.packingSpecs.update('OLMAYAN-URUN', { musteri: 'x' }), /bulunamadı/);
  assert.throws(() => p.packingSpecs.update('SR001.013', { koliIciAdet: -1 }), /Koli içi adet/);
  assert.throws(() => p.packingSpecs.update('SR001.013', { koliAgirligiKg: -5 }), /Koli ağırlığı/);
  p.close();
});

test('learnIfEmpty: bos alanlara yazar, dolu alana dokunmaz, satir yoksa olusturur', () => {
  const p = kur();
  p.packingSpecs.learnIfEmpty('SR001.013', { musteri: 'AYVAZ', koliIciAdet: 300 }, { now: at(9) });
  let a = p.packingSpecs.find('SR001.013');
  assert.equal(a.musteri, 'AYVAZ');
  assert.equal(a.koliIciAdet, 300);
  assert.equal(a.koliBoyutu, null, 'hic gonderilmeyen alan bos kalir');

  // dolu alana yeniden ogrenme denensin: degismez
  p.packingSpecs.learnIfEmpty('SR001.013', { musteri: 'BASKA', koliIciAdet: 999, koliBoyutu: '25 X 25 X 17' }, { now: at(10) });
  a = p.packingSpecs.find('SR001.013');
  assert.equal(a.musteri, 'AYVAZ', 'dolu alan ezilmedi');
  assert.equal(a.koliIciAdet, 300, 'dolu alan ezilmedi');
  assert.equal(a.koliBoyutu, '25 X 25 X 17', 'bos olan alan ogrenildi');

  assert.equal(p.packingSpecs.find('SR002.014'), null, 'hic ogrenilmeyen urun kaydi yok');
  p.close();
});

/* ====================================================================================== list */

test('list: urun listesiyle ayni arama; izlenmeyen urunler varsayilan degerlerle gelir', () => {
  const p = kur();
  p.packingSpecs.update('SR001.013', { musteri: 'AYVAZ' }, { now: at(10) });
  const r = p.packingSpecs.list({});
  assert.equal(r.total, 2);
  const nipel = r.items.find((x) => x.stockCode === 'SR002.014');
  assert.equal(nipel.musteri, null);
  assert.equal(nipel.koliIciAdet, null);
  const somun = r.items.find((x) => x.stockCode === 'SR001.013');
  assert.equal(somun.musteri, 'AYVAZ');
  assert.equal(p.packingSpecs.list({ q: 'SR001' }).total, 1);
  p.close();
});

/* ====================================================================================== Excel'den iceri aktarma (EYS.LS.005) */

const PACKING_HEADERS = [
  'MÜŞTERİ', 'ALEN OTOMAT ÜRÜN KODU', 'MÜŞTERİ ÜRÜN KODU', 'ÜRÜN TANIMI', 'KOLİ BOYUTU', 'KASA ÖZELLİĞİ', 'KAT SAYISI', 'KOLİ/KASA İÇİ ADET', 'KOLİ ETİKETİ', 'KOLİ AĞIRLIĞI (KG)',
];

function swappedRow({ musteri = 'AYVAZ', alenKod = '', musteriKod = '', ad = 'ürün', boyut = '25 X 25 X 17', kasa = 'STANDART', kat = '3 X 85', adet = 500, etiket = 'QR', agirlik = 12.5 } = {}) {
  // Gercek EYS.LS.005 dosyasindaki gibi SUTUNLAR TERS: B (ALEN OTOMAT ÜRÜN KODU) sutununa musteri kodu, C (MÜŞTERİ ÜRÜN KODU) sutununa Alen kodu konur.
  return [musteri, musteriKod, alenKod, ad, boyut, kasa, kat, adet, etiket, agirlik];
}

test('iceri aktarma: gercek Excel gibi B/C sutunlari TERS olsa da, hangi sutun gercek urun kartina karsilik geliyorsa o Alen kodu sayilir', () => {
  const p = kur();
  const buf = xlsxOf([{
    name: 'Sayfa1',
    rows: [
      [null, null, 'LİSTE TAKİP SORUMLUSU', 'DOKÜMAN NO:', null, 'EYS.LS.005', null, null, 'REVİZYON NO:', 0],
      ['PAKETLEME LİSTESİ'],
      PACKING_HEADERS,
      swappedRow({ musteri: 'AYVAZ', alenKod: 'SR001.013', musteriKod: '601335141025', adet: 500, kat: '7 X 273' }),
      // bu satirda basliga UYGUN (B=Alen, C=Musteri): ikisi de tek sutunda cozulebilmeli
      ['AYVAZ N', 'SR002.014', '601ADN601179', 'ürün', '25 X 25 X 17', 'STANDART', 'X ', 138, 'STANDART', 22],
    ],
  }]);
  const r = p.packingSpecs.importXlsx(buf, { by: 'paketleme', now: at(10) });
  assert.equal(r.total, 2);
  assert.equal(r.matched, 2);
  assert.equal(r.ambiguous, 0);
  assert.deepEqual(r.warnings, []);

  const a = p.packingSpecs.find('SR001.013');
  assert.equal(a.musteri, 'AYVAZ');
  assert.equal(a.koliIciAdet, 500);
  assert.equal(a.katSayisi, '7 X 273');

  const b = p.packingSpecs.find('SR002.014');
  assert.equal(b.koliIciAdet, 138);
  assert.equal(b.katSayisi, null, '"X" yer tutucu null oldu');
  p.close();
});

test('iceri aktarma: hicbir sutun urun kartina karsilik gelmiyorsa uyariyla atlanir; bos satir hic sayilmaz', () => {
  const p = kur();
  const buf = xlsxOf([{
    name: 'Sayfa1',
    rows: [
      PACKING_HEADERS,
      swappedRow({ alenKod: '', musteriKod: '' }), // iki kod da bos: bos satir, hic sayilmaz
      swappedRow({ alenKod: 'SR999.999', musteriKod: 'YOK123' }), // ikisi de urun kartina karsilik gelmiyor
      swappedRow({ alenKod: 'SR001.013', musteriKod: '601335141025' }),
    ],
  }]);
  const r = p.packingSpecs.importXlsx(buf, { now: at(10) });
  assert.equal(r.total, 2, 'bos satir hic sayilmadi');
  assert.equal(r.matched, 1);
  assert.equal(r.noProduct, 1);
  assert.match(r.warnings[0], /ürün kartı yok/);
  p.close();
});

test('iceri aktarma: iki sutun da FARKLI urun kartlarina eslesirse belirsiz sayilir, atlanir', () => {
  const p = kur();
  const buf = xlsxOf([{
    name: 'Sayfa1',
    rows: [
      PACKING_HEADERS,
      // B sutunu SR001.013'e, C sutunu SR002.014'e eslesiyor: iki FARKLI gercek urun
      ['AYVAZ', 'SR001.013', 'SR002.014', 'ürün', '25 X 25 X 17', 'STANDART', '3', 100, 'QR', 10],
    ],
  }]);
  const r = p.packingSpecs.importXlsx(buf, { now: at(10) });
  assert.equal(r.total, 1);
  assert.equal(r.matched, 0);
  assert.equal(r.ambiguous, 1);
  assert.match(r.warnings[0], /farklı ürün kartlarına eşleşiyor/);
  p.close();
});

test('iceri aktarma: ayni Alen kodundan BIRDEN COK satir -> SON satir kazanir (tarih sutunu yok)', () => {
  const p = kur();
  const buf = xlsxOf([{
    name: 'Sayfa1',
    rows: [
      PACKING_HEADERS,
      swappedRow({ alenKod: 'SR001.013', musteriKod: '601335141025', musteri: 'ESKİ', adet: 100 }),
      swappedRow({ alenKod: 'SR001.013', musteriKod: '601335141025', musteri: 'YENİ', adet: 999 }),
    ],
  }]);
  const r = p.packingSpecs.importXlsx(buf, { now: at(10) });
  assert.equal(r.total, 2);
  assert.equal(r.matched, 1);
  assert.equal(r.duplicates, 1);
  assert.match(r.warnings[0], /yinelenen/);
  const a = p.packingSpecs.find('SR001.013');
  assert.equal(a.musteri, 'YENİ', 'son satir kazandi');
  assert.equal(a.koliIciAdet, 999);
  p.close();
});

test('iceri aktarma: bozuk tek satir (gecersiz sayi) tum iceri almayi dusurmez, yalniz o satir uyariyla atlanir', () => {
  const p = kur();
  const buf = xlsxOf([{
    name: 'Sayfa1',
    rows: [
      PACKING_HEADERS,
      ['AYVAZ', '', 'SR001.013', 'ürün', '25 X 25 X 17', 'STANDART', '3', 'bozuk-sayi-degeri', 'QR', 10],
      swappedRow({ alenKod: 'SR002.014', musteriKod: '601ADN601179' }),
    ],
  }]);
  const r = p.packingSpecs.importXlsx(buf, { now: at(10) });
  assert.equal(r.total, 2);
  assert.equal(r.matched, 1, 'bozuk satir atlandi, digeri isledi');
  assert.ok(r.warnings.some((w) => /SR001\.013|Satır 2/.test(w)));
  assert.ok(p.packingSpecs.find('SR002.014'));
  p.close();
});

test('iceri aktarma: baslik bulunamazsa anlasilir hata', () => {
  const p = kur();
  const buf = xlsxOf([{ name: 'Sayfa1', rows: [['A', 'B', 'C'], [1, 2, 3]] }]);
  assert.throws(() => p.packingSpecs.importXlsx(buf), /EYS\.LS\.005/);
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
    const liste = await j('/api/planning/packing/specs');
    assert.equal(liste.json.total, 2);

    const duzenle = await j('/api/planning/packing/specs/SR001.013', 'PUT', { musteri: 'AYVAZ', koliIciAdet: 500 });
    assert.equal(duzenle.status, 200);
    assert.equal(duzenle.json.musteri, 'AYVAZ');

    assert.equal((await j('/api/planning/packing/specs/OLMAYAN', 'PUT', { musteri: 'x' })).status, 404);

    const buf = xlsxOf([{ name: 'Sayfa1', rows: [PACKING_HEADERS, swappedRow({ alenKod: 'SR002.014', musteriKod: '601ADN601179' })] }]);
    const rImport = await fetch(`${base}/api/planning/packing/specs/import`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: buf });
    assert.equal(rImport.status, 200);
    const importJson = await rImport.json();
    assert.equal(importJson.matched, 1);
  } finally {
    await new Promise((r) => srv.close(r));
    p.close();
  }
});
