/**
 * Planlama modulu: yardimcilar, CSV okuma, iceri alma (is emirleri ve siparis), urun karti, program eslemesi, HTTP uclari.
 * TUM veriler sentetiktir (depo herkese acik: gercek musteri/urun verisi testlere yazilmaz).
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { foldTr, headerKey, looseKey, parseNumber, parseDate, isScientific, cleanCode } from './normalize.js';
import { parseCsv, decodeCsv } from './csv-read.js';
import { PlanningDb } from './planning-db.js';
import { importCsv, detectFormat, ImportError } from './importers.js';
import { suggestProducts } from './program-map.js';
import { Planning, PlanningError } from './planning.js';
import { createPlanningRoutes } from './routes.js';

/* ------------------------------------------------------------- yardimcilar */

test('foldTr / headerKey: Turkce harfler ASCII\'ye, baslik anahtari yalniz harf ve rakam', () => {
  assert.equal(foldTr('Nİ002.001'), 'NI002.001');
  assert.equal(foldTr('  pirinç talaşı '), 'PIRINC TALASI');
  assert.equal(foldTr('ıİiI'), 'IIII');
  assert.equal(headerKey('MAMÜL ADI'), 'MAMULADI');
  assert.equal(headerKey('Müşt.Sip.No'), 'MUSTSIPNO');
  assert.equal(headerKey('gün top'), 'GUNTOP');
  assert.equal(headerKey('GKK RAPOR NO '), 'GKKRAPORNO');
  assert.equal(looseKey(' sas 123 4 '), 'SAS1234');
});

test('parseNumber: Turkce ve ISO bicimleri; hata degerleri ve bos metin null', () => {
  assert.equal(parseNumber('0,0179'), 0.0179);
  assert.equal(parseNumber('0.0179'), 0.0179);
  assert.equal(parseNumber('1.234,5'), 1234.5);
  assert.equal(parseNumber('1,234.5'), 1234.5);
  assert.equal(parseNumber('5.000', { integer: true }), 5000, 'tamsayi sutununda nokta binlik ayiracidir');
  assert.equal(parseNumber('5.000'), 5, 'ondalik sutununda nokta ondaliktir');
  assert.equal(parseNumber('12.345.678', { integer: true }), 12345678);
  assert.equal(parseNumber('#REF!'), null);
  assert.equal(parseNumber('#DIV/0!'), null);
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber('abc'), null);
  assert.equal(parseNumber(' 24 '), 24);
});

test('parseDate: gg.aa.yyyy, yyyy-aa-gg (saatli de), gg/aa/yyyy; gecersiz tarih null', () => {
  const g = (y, a, d) => new Date(y, a - 1, d).getTime();
  assert.equal(parseDate('12.10.2026'), g(2026, 10, 12));
  assert.equal(parseDate('2026-10-12'), g(2026, 10, 12));
  assert.equal(parseDate('2026-10-12 00:00:00'), g(2026, 10, 12));
  assert.equal(parseDate('12/10/2026'), g(2026, 10, 12));
  assert.equal(parseDate('30.02.2026'), null);
  assert.equal(parseDate('00:00:00'), null, 'yalniz saat tarih degildir');
  assert.equal(parseDate(''), null);
});

test('isScientific / cleanCode: 12 haneli kodun bilimsel gosterimi yakalanir, ".0" soneki atilir', () => {
  assert.equal(isScientific('6,01E+11'), true);
  assert.equal(isScientific('6.00000e+11'), true);
  assert.equal(isScientific('600000000001'), false);
  assert.equal(cleanCode('2400000001.0'), '2400000001');
  assert.equal(cleanCode(' SAS1234567 '), 'SAS1234567');
  assert.equal(cleanCode('1.5'), '1.5');
});

/* --------------------------------------------------------------- CSV okuma */

test('parseCsv: noktali virgul, tirnak, "" kacisi, alan icinde satir sonu, BOM, bos satirlar atlanir', () => {
  const metin = '﻿A;B;C\r\n1;"x;y";3\r\n\r\n;;\r\n"a ""q"" b";"satir\nikinci";\r\n4;5;6';
  const r = parseCsv(metin);
  assert.equal(r.delimiter, ';');
  assert.deepEqual(r.headers, ['A', 'B', 'C']);
  assert.deepEqual(r.rows, [['1', 'x;y', '3'], ['a "q" b', 'satir\nikinci', ''], ['4', '5', '6']]);
});

test('parseCsv: virgul ve sekme ayiricisi ilk satirdan anlasilir; sep= satiri okunur', () => {
  assert.equal(parseCsv('a,b,c\n1,2,3').delimiter, ',');
  assert.equal(parseCsv('a\tb\tc\n1\t2\t3').delimiter, '\t');
  const r = parseCsv('sep=;\na;b\n1;2');
  assert.deepEqual(r.headers, ['a', 'b']);
  assert.deepEqual(r.rows, [['1', '2']]);
});

test('parseCsv: yuz binlerce bos satir (Excel\'in bicimli bos alani) hizli ve atlanir', () => {
  const bos = ';;;;;;;;;;;;;;;;;;;;\r\n'.repeat(300_000);
  const t0 = Date.now();
  const r = parseCsv(`A;B\r\n1;2\r\n${bos}3;4\r\n`);
  assert.deepEqual(r.rows, [['1', '2'], ['3', '4']]);
  assert.ok(Date.now() - t0 < 5000, `cok yavas: ${Date.now() - t0} ms`);
});

/** Windows-1254 kodlamasini elle uretir (Node'un yerlesik kodlayicisi yok). */
function cp1254(metin) {
  const harita = { İ: 0xdd, ı: 0xfd, Ş: 0xde, ş: 0xfe, Ğ: 0xd0, ğ: 0xf0, Ü: 0xdc, ü: 0xfc, Ö: 0xd6, ö: 0xf6, Ç: 0xc7, ç: 0xe7 };
  return Buffer.from([...metin].map((c) => harita[c] ?? c.charCodeAt(0)));
}

test('decodeCsv: gecerli UTF-8 oldugu gibi, degilse Windows-1254 (eski Excel CSV kaydi)', () => {
  assert.deepEqual(decodeCsv(Buffer.from('MAMÜL;ŞĞİ', 'utf8')), { text: 'MAMÜL;ŞĞİ', encoding: 'utf-8' });
  assert.deepEqual(decodeCsv(cp1254('MAMÜL;ŞĞİıöç')), { text: 'MAMÜL;ŞĞİıöç', encoding: 'windows-1254' });
});

/* ------------------------------------------------- iceri alma: is emirleri */

const ISEMRI_BASLIK = 'ÜRETİM EMRİ NO;TARİH;MAMÜL ADI;ALEN KOD;MÜŞTERİ KODU;MAKİNA NO;ADET;HAMMADDE;ALTERNATİF HM;ÜRETİM SN;HM TOPLAM;BRÜT GR;NET GR;SAAT;TERMİN TARİHİ';
const ISEMRI = [
  ISEMRI_BASLIK,
  '2026000001;02.01.2026;TEST SOMUN A;SR001.013;100000013;CNC;3500;HM614.YU23.00;;24;62,65;0,0179;0,0078;23,3;12.01.2026',
  '2026000002;05.01.2026;TEST SOMUN A;SR001.013;100000013;CNC;1000;HM614.YU23.00;HM617.YU24.00;25;18;0,0180;0,0079;7;20.01.2026',
  '2026000003;06.01.2026;TEST NİPEL;Nİ002.001;600000000001;CNC;500;HM617.YU18.00;0;45;53;0,1065;0,036;6,3;',
  '2026000004;;;;;;;;;0;;;0;;',
  '',
].join('\r\n');

const yeniDb = () => new PlanningDb(':memory:');

test('is emirleri: urun kartlari olusur, ayni urun icin EN SON is emri gecerli, bos numarali satirlar atlanir', () => {
  const db = yeniDb();
  const r = importCsv(db, Buffer.from(ISEMRI, 'utf8'), { by: 'ayse' });
  assert.equal(r.format, 'isemri');
  assert.equal(r.totalRows, 3);
  assert.equal(r.skipped, 1);
  assert.deepEqual(r.products, { added: 2, updated: 0, unchanged: 0 });

  const a = db.getProduct('SR001.013');
  assert.equal(a.stockCode, 'SR001.013');
  assert.equal(a.name, 'TEST SOMUN A');
  assert.equal(a.customerCode, '100000013');
  assert.equal(a.material, 'HM614.YU23.00');
  assert.equal(a.altMaterial, 'HM617.YU24.00', 'en son is emrindeki alternatif hammadde');
  assert.equal(a.plannedSec, 25, 'en son is emri (2026000002)');
  assert.equal(a.grossKg, 0.018);
  assert.equal(a.netKg, 0.0079);
  assert.equal(a.source, 'csv-isemri');

  const n = db.getProduct('NI002.001');
  assert.equal(n.stockCode, 'Nİ002.001', 'Turkce I\'li orijinal yazim korunur');
  assert.equal(n.altMaterial, null, '"0" alternatif hammadde degil');
  assert.equal(db.getProduct(foldTr('Nİ002.001')).codeKey, 'NI002.001');
});

test('is emirleri: tekrar iceri alma degisiklik yapmaz; degisen deger guncellenir', () => {
  const db = yeniDb();
  importCsv(db, Buffer.from(ISEMRI, 'utf8'));
  const ikinci = importCsv(db, Buffer.from(ISEMRI, 'utf8'));
  assert.deepEqual(ikinci.products, { added: 0, updated: 0, unchanged: 2 });
  const degisen = ISEMRI.replace('2026000003;06.01.2026;TEST NİPEL;Nİ002.001;600000000001;CNC;500;HM617.YU18.00;0;45;', '2026000003;06.01.2026;TEST NİPEL;Nİ002.001;600000000001;CNC;500;HM617.YU18.00;0;40;');
  const ucuncu = importCsv(db, Buffer.from(degisen, 'utf8'));
  assert.deepEqual(ucuncu.products, { added: 0, updated: 1, unchanged: 1 });
  assert.equal(db.getProduct('NI002.001').plannedSec, 40);
});

test('is emirleri: elle duzenlenen kartin dolu alanlari ezilmez, bos alanlar doldurulur', () => {
  const planning = new Planning({ dbFile: ':memory:' });
  planning.createProduct({ stockCode: 'SR001.013', name: 'ELLE AD', plannedSec: 30 }, { by: 'ayse' });
  const r = planning.importCsv(Buffer.from(ISEMRI, 'utf8'));
  assert.equal(r.products.updated, 1);
  const p = planning.getProduct('SR001.013');
  assert.equal(p.name, 'ELLE AD', 'elle yazilan ad ezilmedi');
  assert.equal(p.plannedSec, 30, 'elle girilen sure ezilmedi');
  assert.equal(p.material, 'HM614.YU23.00', 'bos hammadde dosyadan dolduruldu');
  assert.equal(p.edited, true);
  planning.close();
});

test('is emirleri: bilimsel gosterimli musteri kodu degeri bozmaz, UYARI verir; gecersiz urun kodu atlanir', () => {
  const db = yeniDb();
  const csv = [
    ISEMRI_BASLIK,
    '2026000010;02.01.2026;URUN X;SR010.001;6,01E+11;CNC;100;HM614.YU18.00;;20;2;0,02;0,01;1;',
    '2026000011;02.01.2026;URUN Y;9,9 9;123;CNC;100;HM614.YU18.00;;20;2;0,02;0,01;1;',
    '2026000012;02.01.2026;URUN Z;SR010.002;123;CNC;100;HM614.YU18.00;;;2;0,02;0,01;1;',
  ].join('\n');
  const r = importCsv(db, Buffer.from(csv, 'utf8'));
  assert.equal(db.getProduct('SR010.001').customerCode, null, 'bozulmus kod saklanmaz');
  assert.equal(db.getProduct('9,9 9'), null);
  assert.equal(r.skipped, 1);
  const uyari = r.warnings.join('\n');
  assert.match(uyari, /bilimsel gösterim/);
  assert.match(uyari, /ürün kodu geçersiz/);
  assert.match(uyari, /planlanan süre/);
});

test('tanınmayan dosya ve bos dosya anlasilir hata verir', () => {
  const db = yeniDb();
  assert.throws(() => importCsv(db, Buffer.from('A;B\n1;2', 'utf8')), (e) => e instanceof ImportError && /tanınmadı/.test(e.message));
  assert.throws(() => importCsv(db, Buffer.alloc(0)), /boş/);
  assert.equal(detectFormat(['Mamul_Kodu', 'Evrak_No']), 'siparis');
  assert.equal(detectFormat(['ALEN KOD', 'MAMÜL ADI']), 'isemri');
  assert.equal(detectFormat(['x']), null);
});

/* ----------------------------------------------------- iceri alma: siparis */

const SIPARIS_BASLIK = 'Musteri;Mamul_Kodu;Mamul_Adi;Evrak_No;Sip_Tarihi;Miktar;Sevk_Edilen_Miktar;Kalan_Miktar;FIILI STOK;GECICI STOK;Acik_0;Teyit_Edilen_Tarih;Must_Sip_No;BR;NT;SN;HM;TAM BOY';
const SIPARIS = [
  SIPARIS_BASLIK,
  'FIRMA A;SR001.013;TEST SOMUN A;SPR-1;13.09.2025;8.000;3.000;5.000;0;0;2;19.09.2025;2400000001;0,0179;0,0078;24;HM614.YU23.00 ;6,9',
  'FIRMA A;Nİ002.001;TEST NİPEL;SPR-1;13.09.2025;4000;4000;0;0;0;2;00:00:00;2400000001;0,1065;0,036;27;HM617.YU18.00;43',
  'FIRMA A;SR001.013;TEST SOMUN A;SPR-1;13.09.2025;8.000;0;8.000;0;0;2;19.09.2025;2400000001;0,0179;0,0078;24;HM614.YU23.00;6,9',
  'FIRMA B;SR005.001;URUN B;SPR-2;20.09.2025;100;0;100;0;0;2;;NUMUNE;0,05;0,02;30;HM617.YU18.00;12',
  'FIRMA C;SR005.001;URUN B;SPR-9;21.09.2025;200;0;200;0;0;2;;NUMUNE;0,05;0,02;30;HM617.YU18.00;12',
  'FIRMA A;PR-001;PİRİNÇ TALAŞI;TALAŞ-139;18.12.2025;500;500;0;0;0;2;;;0;0;0;;',
  '',
].join('\r\n');

test('siparis: satirlar iceri alinir; ayni evrakta ayni urun birden cok satir olabilir; talas urun karti olmaz', () => {
  const db = yeniDb();
  const r = importCsv(db, Buffer.from(SIPARIS, 'utf8'), { by: 'ayse' });
  assert.equal(r.format, 'siparis');
  assert.equal(r.totalRows, 6);
  assert.equal(r.added, 6, 'ayni evrak+urun+miktar+tarih iki satir da korunur (siralama anahtari)');
  assert.deepEqual(Object.keys(r.products).sort(), ['added', 'unchanged', 'updated']);
  assert.equal(r.products.added, 3, 'SR001.013, Nİ002.001, SR005.001 (PR-001 urun degil)');
  assert.equal(db.getProduct('PR-001'), null);
  assert.equal(db.stats().orderLines, 6);
  assert.equal(db.stats().openOrderLines, 4, 'kalan > 0 olanlar (5.000, 8.000, 100, 200)');
});

test('siparis: urun kartina tam boy, hammadde, agirlik ve sure gelir; birimler kg/mm', () => {
  const db = yeniDb();
  importCsv(db, Buffer.from(SIPARIS, 'utf8'));
  const p = db.getProduct('SR001.013');
  assert.equal(p.lengthMm, 6.9);
  assert.equal(p.material, 'HM614.YU23.00', 'sondaki bosluk atilir');
  assert.equal(p.grossKg, 0.0179);
  assert.equal(p.netKg, 0.0078);
  assert.equal(p.plannedSec, 24);
  assert.equal(p.source, 'csv-siparis');
});

test('siparis: is emri degerleri siparis dosyasiyla EZILMEZ (yalniz tam boy gelir, bos alanlar dolar)', () => {
  const db = yeniDb();
  importCsv(db, Buffer.from(ISEMRI, 'utf8')); // SR001.013: sure 25, brut 0,018
  importCsv(db, Buffer.from(SIPARIS, 'utf8')); // siparis: sure 24, brut 0,0179
  const p = db.getProduct('SR001.013');
  assert.equal(p.plannedSec, 25);
  assert.equal(p.grossKg, 0.018);
  assert.equal(p.lengthMm, 6.9, 'tam boy yalniz siparis dosyasinda var');
  assert.equal(p.source, 'csv-isemri');
});

test('siparis: tekrar iceri alma idempotent; degisen kalan miktar guncellenir; dosyada olmayan satir eski isaretlenir', () => {
  const db = yeniDb();
  importCsv(db, Buffer.from(SIPARIS, 'utf8'));
  const ayni = importCsv(db, Buffer.from(SIPARIS, 'utf8'));
  assert.equal(ayni.added, 0);
  assert.equal(ayni.unchanged, 6);
  assert.equal(db.stats().orderLines, 6);

  // kalan miktar degisti + bir satir dosyadan cikti
  const yeni = SIPARIS.replace('8.000;3.000;5.000', '8.000;5.000;3.000').split('\r\n').filter((s) => !s.startsWith('FIRMA C')).join('\r\n');
  const r = importCsv(db, Buffer.from(yeni, 'utf8'));
  assert.equal(r.updated, 1);
  assert.equal(r.staleMarked, 1, 'dosyada olmayan FIRMA C satiri eski');
  assert.equal(db.stats().orderLines, 5, 'eski satirlar listelenmez');

  const korun = importCsv(db, Buffer.from(SIPARIS.split('\r\n').slice(0, 3).join('\r\n'), 'utf8'), { keepOld: true });
  assert.equal(korun.staleMarked, 0, 'keepOld: kismi dosya eski satirlari gizlemez');
});

test('siparis arama: musteri siparis no (bosluk/harf duyarsiz), evrak no, Turkce urun adi; ayni no iki musteride ayri gruplar', () => {
  const db = yeniDb();
  importCsv(db, Buffer.from(SIPARIS, 'utf8'));

  const a = db.searchOrders({ q: '2400000001' });
  assert.equal(a.length, 1);
  assert.equal(a[0].lineCount, 3, 'bir siparis, uc satir (iki urun, biri iki kez)');
  assert.equal(a[0].openQty, 13000);
  assert.equal(a[0].custOrderNo, '2400000001');

  assert.equal(db.searchOrders({ q: 'spr-1' }).length, 1);
  assert.equal(db.searchOrders({ q: 'nipel' }).length, 1, 'NİPEL aramasi nipel ile bulunur');
  assert.equal(db.searchOrders({ q: 'pirinc' }).length, 1);

  const numune = db.searchOrders({ q: 'numune' });
  assert.equal(numune.length, 2, 'tekrar eden "NUMUNE" no: musteri/evrak bazinda ayri gruplar, tek sonuc varsayilmaz');
  assert.deepEqual(numune.map((x) => x.customer).sort(), ['FIRMA B', 'FIRMA C']);

  assert.equal(db.searchOrders({ openOnly: true }).length, 3, 'yalniz acik kalani olanlar');
  assert.deepEqual(db.searchOrders({ q: '%' }), [], 'LIKE ozel karakteri desen olmaz');
});

test('siparis arama: tam eslesen once gelir (SPR-4 araninca SPR-40 araya girmez)', () => {
  const db = yeniDb();
  const csv = [
    SIPARIS_BASLIK,
    'FIRMA A;SR001.013;URUN;SPR-40;01.10.2026;10;0;10;0;0;2;;MUS40;0,01;0,005;20;HM1;5',
    'FIRMA A;SR001.013;URUN;SPR-4;01.01.2025;10;0;10;0;0;2;;MUS4;0,01;0,005;20;HM1;5',
    'FIRMA A;SR001.013;URUN;SPR-41;02.10.2026;10;0;10;0;0;2;;MUS41;0,01;0,005;20;HM1;5',
  ].join('\r\n');
  importCsv(db, Buffer.from(csv, 'utf8'));
  const r = db.searchOrders({ q: 'spr-4' });
  assert.equal(r.length, 3);
  assert.equal(r[0].docNo, 'SPR-4', 'en eski olsa da tam eşleşen ilk sırada');
  assert.equal(db.searchOrders({ q: 'mus4' })[0].custOrderNo, 'MUS4');
});

test('siparis satirlari: grup anahtariyla gelir, urun karti var/yok bilgisi', () => {
  const db = yeniDb();
  importCsv(db, Buffer.from(SIPARIS, 'utf8'));
  const [g] = db.searchOrders({ q: '2400000001' });
  const satirlar = db.orderLines({ customerKey: g.customerKey, custOrderKey: g.custOrderKey, docKey: g.docKey });
  assert.equal(satirlar.length, 3);
  assert.deepEqual(satirlar.map((s) => s.stockCode), ['SR001.013', 'Nİ002.001', 'SR001.013']);
  assert.ok(satirlar.every((s) => s.hasProduct));
  assert.equal(satirlar[0].qty, 8000);
  assert.equal(satirlar[0].remaining, 5000);
  assert.ok(satirlar[0].dueDate > 0);
  assert.equal(satirlar[1].dueDate, null, '"00:00:00" teyit tarihi degil');
});

/* ---------------------------------------------------------- program onerisi */

test('program onerisi: stok koduna gore (tire/nokta, Turkce I), musteri koduna gore, belirsiz ve yok', () => {
  const db = yeniDb();
  importCsv(db, Buffer.from(ISEMRI, 'utf8'));
  db.saveProduct('SR090.001', { stockCode: 'SR090.001', name: 'IKIZ 1', customerCode: '555' }, { source: 'elle' });
  db.saveProduct('SR090.002', { stockCode: 'SR090.002', name: 'IKIZ 2', customerCode: '555' }, { source: 'elle' });
  db.saveProduct('SR091.001', { stockCode: 'SR091.001', name: '777000111 TEST PARÇA' }, { source: 'elle' }); // müşteri kodu karta girilmemiş
  const lookup = {
    productByCodeKey: (k) => db.getProduct(k), productsByCustomerCode: (c) => db.productsByCustomerCode(c),
    productsByNamePrefix: (p) => db.productsByNamePrefix(p),
  };

  const a = suggestProducts('SR001-013', lookup);
  assert.equal(a.kind, 'kod');
  assert.equal(a.candidates[0].stockCode, 'SR001.013');
  assert.equal(suggestProducts('sr001-013', lookup).kind, 'kod', 'buyuk/kucuk harf duyarsiz');
  const n = suggestProducts('NI002-001', lookup);
  assert.equal(n.candidates[0].stockCode, 'Nİ002.001', 'NI002-001 = Nİ002.001');
  assert.equal(suggestProducts('600000000001', lookup).kind, 'musteri-kodu');
  const ikiz = suggestProducts('555', lookup);
  assert.equal(ikiz.kind, 'musteri-kodu');
  assert.equal(ikiz.candidates.length, 2, 'bir musteri kodu iki urune gidiyor: belirsiz, elle secilecek');
  const adla = suggestProducts('777000111', lookup);
  assert.equal(adla.kind, 'ad', 'ürün adı bu kodla başlıyor: daha zayıf kanıt, yalnız öneri');
  assert.equal(adla.candidates[0].stockCode, 'SR091.001');
  assert.equal(suggestProducts('TEST', lookup).kind, null, 'rakam içermeyen / kısa adlar ad önekiyle eşlenmez');
  assert.equal(suggestProducts('O9001', lookup).kind, null);
  assert.equal(suggestProducts('SR777-777', lookup).kind, null, 'urun karti olmayan kod oneri vermez');
});

/* -------------------------------------------------------------- urun karti */

test('urun karti: olusturma dogrulamasi, kopya 409, net > brut reddi, birimler', () => {
  const p = new Planning({ dbFile: ':memory:' });
  assert.throws(() => p.createProduct({ stockCode: 'a b' }), /Stok kodu/);
  assert.throws(() => p.createProduct({ stockCode: '' }), /Stok kodu/);
  assert.throws(() => p.createProduct({ stockCode: 'X1', netKg: 0.05, grossKg: 0.02 }), /Net ağırlık brüt/);
  assert.throws(() => p.createProduct({ stockCode: 'X1', plannedSec: -3 }), /Planlanan süre/);
  assert.throws(() => p.createProduct({ stockCode: 'X1', lengthMm: 'abc' }), /Tam boy/);

  const c = p.createProduct({ stockCode: 'SR100.001', name: ' Ürün ', lengthMm: '12,5', netKg: 0.01, grossKg: 0.03, plannedSec: 24, customerCode: '123456789012.0' }, { by: 'ayse' });
  assert.equal(c.name, 'Ürün');
  assert.equal(c.lengthMm, 12.5);
  assert.equal(c.customerCode, '123456789012');
  assert.equal(c.source, 'elle');
  assert.equal(c.edited, true);
  assert.equal(c.updatedBy, 'ayse');

  assert.throws(() => p.createProduct({ stockCode: 'sr100.001' }), (e) => e instanceof PlanningError && e.status === 409 && e.code === 'exists');
  assert.throws(() => p.getProduct('YOK-1'), (e) => e.status === 404);

  const g = p.updateProduct('SR100.001', { grossKg: 0.04, note: 'not' }, { by: 'veli' });
  assert.equal(g.grossKg, 0.04);
  assert.equal(g.netKg, 0.01, 'verilmeyen alana dokunulmaz');
  assert.equal(g.updatedBy, 'veli');
  assert.throws(() => p.updateProduct('SR100.001', { netKg: 0.09 }), /Net ağırlık brüt/);
  assert.throws(() => p.updateProduct('YOK-1', {}), (e) => e.status === 404);
  const bos = p.updateProduct('SR100.001', { note: '' });
  assert.equal(bos.note, null);

  const arama = p.listProducts({ q: 'urun' });
  assert.equal(arama.total, 1, 'Ürün aramasi urun ile bulunur');
  p.close();
});

/* -------------------------------------------------------------- program eslemesi */

function planlamaVeProgramlar(seen) {
  const p = new Planning({ dbFile: ':memory:', listSeenPrograms: () => seen });
  p.importCsv(Buffer.from(ISEMRI, 'utf8'));
  return p;
}

test('programlar: tornalarda gorulenler + esleme durumu; yazim farklari birlesir; eslesip artik gorulmeyen de listelenir', () => {
  const seen = [
    { program: 'SR001-013', parts: 100, machines: ['CNC-02'], lastTs: 5 },
    { program: 'sr001-013', parts: 50, machines: ['CNC-03'], lastTs: 9 },
    { program: '600000000001', parts: 10, machines: ['CNC-01'], lastTs: 3 },
    { program: 'O9001', parts: 1, machines: ['CNC-04'], lastTs: 1 },
  ];
  const p = planlamaVeProgramlar(seen);
  const r = p.listPrograms();
  assert.equal(r.counts.total, 3, 'SR001-013 / sr001-013 tek program');
  const sr = r.programs.find((x) => x.programKey === 'SR001.013' || x.program.toUpperCase() === 'SR001-013');
  assert.equal(sr.parts, 150);
  assert.deepEqual(sr.machines, ['CNC-02', 'CNC-03']);
  assert.equal(sr.status, 'oneri');
  assert.equal(sr.suggestionKind, 'kod');
  assert.equal(r.programs.find((x) => x.program === 'O9001').status, 'yok');
  assert.equal(r.programs.find((x) => x.program === '600000000001').suggestionKind, 'musteri-kodu');
  assert.deepEqual(r.programs.map((x) => x.status), ['oneri', 'oneri', 'yok'], 'oneriler once, eslenmeyenler sonra');

  const m = p.mapProgram('SR001-013', 'SR001.013', { by: 'ayse' });
  assert.equal(m.source, 'oneri-onay');
  const e = p.mapProgram('O9001', 'Nİ002.001', { by: 'ayse' });
  assert.equal(e.source, 'elle', 'oneri disi secim');
  const sonra = p.listPrograms();
  assert.equal(sonra.counts.mapped, 2);
  assert.equal(sonra.programs.find((x) => x.program === 'O9001').mapped.stockCode, 'Nİ002.001');
  assert.deepEqual(p.getProduct('SR001.013').programs, [{ name: 'SR001-013', source: 'oneri-onay' }]);

  assert.throws(() => p.mapProgram('X', 'YOK-1'), (err) => err.status === 404);
  p.unmapProgram('o9001');
  assert.throws(() => p.unmapProgram('o9001'), (err) => err.status === 404);
  p.close();

  // torna artik bu programi gostermese de eslemesi listede kalir
  const q = planlamaVeProgramlar([]);
  q.mapProgram('ESKI-PROG', 'SR001.013');
  const liste = q.listPrograms();
  assert.equal(liste.programs.length, 1);
  assert.equal(liste.programs[0].seen, false);
  q.close();
});

test('programlar: toplu onay yalniz stok koduyla birebir tutan TEK oneriyi onaylar', () => {
  const p = planlamaVeProgramlar([
    { program: 'SR001-013', parts: 5, machines: [], lastTs: 1 },
    { program: 'NI002-001', parts: 5, machines: [], lastTs: 1 },
    { program: '600000000001', parts: 5, machines: [], lastTs: 1 },
    { program: 'XYZ', parts: 5, machines: [], lastTs: 1 },
  ]);
  assert.equal(p.confirmExactSuggestions({ by: 'ayse' }), 2, 'musteri koduyla olan oneri toplu onaylanmaz');
  const r = p.listPrograms();
  assert.equal(r.counts.mapped, 2);
  assert.equal(r.counts.suggested, 1);
  assert.equal(r.counts.unmatched, 1);
  p.close();
});

/* ------------------------------------------------------------------ HTTP */

async function sunucu(planning) {
  const routes = createPlanningRoutes({ planning });
  const srv = http.createServer(async (req, res) => {
    if (!(await routes(req, res, new URL(req.url, 'http://x')))) { res.writeHead(404).end(); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  return { base, kapat: () => new Promise((r) => srv.close(r)) };
}

test('HTTP: urun CRUD, CSV iceri alma, siparis arama, program esleme uclari', async () => {
  const planning = planlamaVeProgramlar([{ program: 'SR001-013', parts: 5, machines: ['CNC-01'], lastTs: 1 }]);
  const { base, kapat } = await sunucu(planning);
  const j = async (yol, init) => {
    const r = await fetch(base + yol, init);
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const post = (yol, obj) => j(yol, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  try {
    assert.equal((await j('/api/planning/summary')).json.products, 2);

    const liste = (await j('/api/planning/products?q=somun')).json;
    assert.equal(liste.total, 1);
    assert.equal(liste.items[0].stockCode, 'SR001.013');

    const olustur = await post('/api/planning/products', { stockCode: 'SR200.001', name: 'YENI', netKg: 0.01, grossKg: 0.02 });
    assert.equal(olustur.status, 201);
    assert.equal((await post('/api/planning/products', { stockCode: 'SR200.001' })).status, 409);
    assert.equal((await post('/api/planning/products', { stockCode: 'SR200.002', netKg: 5, grossKg: 1 })).status, 400);

    const kod = encodeURIComponent('Nİ002.001');
    assert.equal((await j(`/api/planning/products/${kod}`)).json.name, 'TEST NİPEL');
    assert.equal((await j('/api/planning/products/YOK')).status, 404);
    const put = await j(`/api/planning/products/${kod}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lengthMm: 43 }) });
    assert.equal(put.json.lengthMm, 43);
    assert.equal((await j(`/api/planning/products/${kod}`, { method: 'PUT', body: '{bozuk' })).status, 400);

    // siparis dosyasini yukle (ham govde)
    const yukle = await j('/api/planning/import?filename=siparis.csv', { method: 'POST', headers: { 'content-type': 'text/csv' }, body: Buffer.from(SIPARIS, 'utf8') });
    assert.equal(yukle.status, 200);
    assert.equal(yukle.json.format, 'siparis');
    assert.equal(yukle.json.added, 6);
    assert.equal((await j('/api/planning/import', { method: 'POST', body: 'A;B\n1;2' })).status, 400);

    const siparisler = (await j('/api/planning/orders?q=2400000001')).json.orders;
    assert.equal(siparisler.length, 1);
    const g = siparisler[0];
    const qs = new URLSearchParams({ customerKey: g.customerKey, custOrderKey: g.custOrderKey, docKey: g.docKey });
    assert.equal((await j(`/api/planning/orders/lines?${qs}`)).json.lines.length, 3);
    assert.equal((await j('/api/planning/orders/lines')).status, 400);

    const prog = (await j('/api/planning/programs')).json;
    assert.equal(prog.counts.suggested, 1);
    const harita = await j('/api/planning/programs/map', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ program: 'SR001-013', stockCode: 'SR001.013' }) });
    assert.equal(harita.json.source, 'oneri-onay');
    assert.equal((await j('/api/planning/programs/map?program=SR001-013', { method: 'DELETE' })).status, 200);
    assert.equal((await j('/api/planning/programs/map?program=SR001-013', { method: 'DELETE' })).status, 404);
    assert.equal((await post('/api/planning/programs/confirm-exact', {})).json.confirmed, 1);

    assert.equal((await j('/api/planning/yok')).status, 404);
  } finally {
    await kapat();
    planning.close();
  }
});
