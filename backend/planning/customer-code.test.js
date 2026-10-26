/**
 * MUSTERI URUN KODU = ilk sozcuk (tire/nokta kodun parcasi) ve MIKRO'DA DEGISEN urun karti alanlarinin uygulanmasi.
 * TUM veriler sentetiktir (depo herkese acik).
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstToken, customerCodeFromName, resolveCustomerCode } from './normalize.js';
import { PlanningDb } from './planning-db.js';
import { Planning } from './planning.js';

const yeni = () => new Planning({ dbFile: ':memory:', listMachines: () => [{ id: 'CNC-01', name: 'Torna 1' }], productionEvents: () => [], liveMachine: () => null });

/* ------------------------------------------------------------------ kural */

test('firstToken: ilk sozcuk; tire/nokta/alt cizgi kodun parcasi; bosluktan sonrasi koda girmez', () => {
  assert.equal(firstToken('140100188 1234-567'), '140100188');
  assert.equal(firstToken('  A123AB456-789   X Y'), 'A123AB456-789');
  assert.equal(firstToken('12.345.678'), '12.345.678');
  assert.equal(firstToken('KOD_1 SONRA'), 'KOD_1', 'bolunemez bosluk da ayiricidir');
  assert.equal(firstToken(''), '');
  assert.equal(firstToken(null), '');
});

test('customerCodeFromName: urun adinin basindaki kod; olcu ve dis yazimlari kod degildir', () => {
  const kod = (ad) => customerCodeFromName(ad);
  // gercek listede gorulen kalip aileleri (rakamlar sentetik)
  assert.equal(kod('140100188 DAİKİN 4P396838-2 SOMUN 5/8"'), '140100188');
  assert.equal(kod('1234567890 PARCA'), '1234567890');
  assert.equal(kod('123456789012 PARCA'), '123456789012');
  assert.equal(kod('1234-567 PARCA'), '1234-567', 'tireli kod tek kod');
  assert.equal(kod('1234-5678 PARCA'), '1234-5678');
  assert.equal(kod('A123AB456-789 PARCA'), 'A123AB456-789');
  assert.equal(kod('12345-67890-123 PARCA'), '12345-67890-123');
  assert.equal(kod('AB12345678 PARCA'), 'AB12345678');
  assert.equal(kod('123.456.789 PARCA'), '123.456.789', 'noktali kod');
  assert.equal(kod('1234567- PARCA'), '1234567', 'sondaki ayirac tire kirpilir');
  assert.equal(kod('1234567 - PARCA'), '1234567', 'bosluklu tire ayiractir');
  // kod OLMAYANLAR
  for (const ad of ['G1/2" SOMUN 6121470', '1/2" NIPEL', '5/8" X', 'M10 SOMUN', 'AA99 X', '99,9/99/9,9 Y', 'PİRİNÇ SOMUN G1/2', 'SOMUN', '(12345) X', '', '   ', null, undefined]) {
    assert.equal(kod(ad), null, String(ad));
  }
  assert.equal(kod(`${'1'.repeat(41)} X`), null, '40 karakterden uzun');
  assert.equal(kod('1234 X'), null, '5 rakamdan az');
});

test('resolveCustomerCode: kayitli deger ilk sozcuge iner; yoksa urun adindaki kod; ikisi de yoksa null', () => {
  assert.equal(resolveCustomerCode('140100188 1234-567', 'ABC'), '140100188');
  assert.equal(resolveCustomerCode('', '987654321 FOO'), '987654321');
  assert.equal(resolveCustomerCode(null, '987654321 FOO'), '987654321');
  assert.equal(resolveCustomerCode(null, 'G1/2" SOMUN'), null);
  assert.equal(resolveCustomerCode('AB', '987654321 FOO'), 'AB', 'kayitli deger varsa ad kullanilmaz');
});

/* ----------------------------------------------------------- iceri alma */

const ISEMRI = [
  'ÜRETİM EMRİ NO;TARİH;MAMÜL ADI;ALEN KOD;MÜŞTERİ KODU;MAKİNA NO;ADET;HAMMADDE;ALTERNATİF HM;ÜRETİM SN;HM TOPLAM;BRÜT GR;NET GR',
  '2026000001;02.01.2026;123456789 TEST SOMUN A 1/2";SR001.013;123456789 4321-567;CNC;3500;HM614.YU23.00;;27;62,65;0,039;0,0078',
  '2026000002;03.01.2026;ORNEK NIPEL G1/2" 5/8;SR002.013;;CNC;100;HM614.YU23.00;;27;5;0,039;0,0078',
  '2026000003;04.01.2026;4455-667 DENEME PARCA;SR003.013;;CNC;100;HM614.YU23.00;;27;5;0,039;0,0078',
  '2026000004;05.01.2026;998877665 BILIMSEL;SR004.013;9,9E+11;CNC;100;HM614.YU23.00;;27;5;0,039;0,0078',
  '',
].join('\r\n');

test('is emirleri listesi: musteri kodu sutunu ilk sozcuge iner; sutun bos/bozuksa urun adinin basindaki kod kullanilir', () => {
  const p = yeni();
  const r = p.importFile(Buffer.from(ISEMRI, 'utf8'));
  assert.ok(r.warnings.some((w) => /SR004\.013.*bilimsel/.test(w)), 'bozuk sutun yine uyarilir');
  assert.equal(p.getProduct('SR001.013').customerCode, '123456789', 'iki parcali sutun: ilk sozcuk');
  assert.equal(p.getProduct('SR002.013').customerCode, null, 'adda kod yok, sutun bos');
  assert.equal(p.getProduct('SR003.013').customerCode, '4455-667', 'sutun bos: adin basindaki tireli kod');
  assert.equal(p.getProduct('SR004.013').customerCode, '998877665', 'bilimsel gosterimde kayip: adin basindaki kod');
  assert.deepEqual(r.changes.products.added.map((x) => x.stockCode), ['SR001.013', 'SR002.013', 'SR003.013', 'SR004.013']);
  p.close();
});

test('is emri: urun kartinda kod yoksa bile formda adindaki kod gelir; eski iki parcali kopya ilk sozcuge iner', () => {
  const p = yeni();
  p.createProduct({ stockCode: 'SR900.001', name: '246813579 ADLI URUN', material: 'HM1', grossKg: 0.05, netKg: 0.04, plannedSec: 20 });
  assert.equal(p.getProduct('SR900.001').customerCode, null, 'elle acilan kart kendiliginden doldurulmaz');
  const w = p.createWorkOrder({ stockCode: 'SR900.001', targetQty: 10, machineId: 'CNC-01' });
  assert.equal(w.customerCode, '246813579', 'is emri formundaki MUSTERI URUN KODU');
  const hexOf = (t) => `<${[...t].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('')}>`;
  assert.ok(p.workOrderPrintPdf(w.no).toString('latin1').includes(hexOf('246813579')), 'basilan form PDF icinde de yazar');
  p.createProduct({ stockCode: 'SR900.002', name: 'G1/2" SOMUN', customerCode: '111222333 4444-555', material: 'HM1', grossKg: 0.05, netKg: 0.04, plannedSec: 20 });
  const w2 = p.createWorkOrder({ stockCode: 'SR900.002', targetQty: 10, machineId: 'CNC-01' });
  assert.equal(p.db.getWorkOrder(w2.no).customerCode, '111222333', 'elle yazilmis iki parcali kod is emrinde ilk sozcuk');
  p.close();
});

/* ------------------------------------------------------------- gecis (bir kerelik) */

test('gecis: iki parcali kodlar ilk sozcuge iner, bos kodlar adin basindan dolar; elle duzenlenmis kartlara dokunulmaz; bir kez calisir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cnc-kod-'));
  const file = join(dir, 'p.db');
  try {
    let db = new PlanningDb(file);
    db.saveProduct('SR1', { stockCode: 'SR1', name: '123456789 FOO', customerCode: '123456789 1111-222' }, { source: 'csv-isemri' });
    db.saveProduct('SR2', { stockCode: 'SR2', name: '987654321 BAR' }, { source: 'csv-isemri' });
    db.saveProduct('SR3', { stockCode: 'SR3', name: '555666777 BAZ', customerCode: 'KEEP ME' }, { source: 'elle', edited: true });
    db.saveProduct('SR4', { stockCode: 'SR4', name: 'G1/2" SOMUN' }, { source: 'csv-isemri' });
    db.db.exec("DELETE FROM settings WHERE key = 'gecis.musteri-urun-kodu-v1'");
    db.close();

    db = new PlanningDb(file); // gecis acilista calisir
    assert.equal(db.getProduct('SR1').customerCode, '123456789');
    assert.equal(db.getProduct('SR2').customerCode, '987654321');
    assert.equal(db.getProduct('SR3').customerCode, 'KEEP ME', 'elle duzenlenmis');
    assert.equal(db.getProduct('SR4').customerCode, null);
    assert.equal(db.listProducts({ q: '987654321' }).items.length, 1, 'arama anahtari da guncellendi');
    // bayrak konduktan sonra yeniden calismaz: sonradan elle bosaltilan kod geri dolmaz
    db.db.prepare("UPDATE products SET customer_code = NULL WHERE code_key = 'SR2'").run();
    db.close();
    db = new PlanningDb(file);
    assert.equal(db.getProduct('SR2').customerCode, null);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------- Mikro'da degisen alanlar */

const SIPARIS_BASLIK = 'Musteri;Mamul_Kodu;Mamul_Adi;Evrak_No;Sip_Tarihi;Miktar;Sevk_Edilen_Miktar;Kalan_Miktar;Must_Sip_No;BR;NT;SN;HM;TAM BOY';
const siparis = (satirlar) => Buffer.from([SIPARIS_BASLIK, ...satirlar, ''].join('\r\n'), 'utf8');
//                       musteri ; kod ;         ad ;                evrak ; tarih ; mik ; sev ; kal ; musSip ; BR ; NT ; SN ; HM ; boy
const A = (br = '0,0200', sn = 30) => `FIRMA X;SR010.001;111222333 PARCA A;SPR-1;13.09.2025;100;0;100;MS-1;${br};0,0100;${sn};HM1;40`;
const B = (br = '0,0300') => `FIRMA X;SR010.002;111222334 PARCA B;SPR-1;13.09.2025;100;0;100;MS-1;${br};0,0150;30;HM1;40`;
const C = (br = '0,0400') => `FIRMA X;SR010.003;111222335 PARCA C;SPR-1;13.09.2025;100;0;100;MS-1;${br};0,0200;30;HM1;40`;

test('Mikro dosyasi: ilk iceri alma karttaki degerleri ezmez; sonra YALNIZ Mikro\'da degisen alanlar uygulanir; elle duzenlenmis kart korunur ve bildirilir', () => {
  const p = yeni();
  // A karti planlama Excel'inden geldi (planlanan sure 25, brut 0,021: Mikro'dakinden farkli ve "ayarlanmis" olabilir)
  p.importFile(Buffer.from([
    'ÜRETİM EMRİ NO;TARİH;MAMÜL ADI;ALEN KOD;MÜŞTERİ KODU;MAKİNA NO;ADET;HAMMADDE;ALTERNATİF HM;ÜRETİM SN;HM TOPLAM;BRÜT GR;NET GR',
    '2026000009;02.01.2026;PARCA A;SR010.001;;CNC;100;HM1;;25;2;0,021;0,01', '',
  ].join('\r\n'), 'utf8'));

  const ilk = p.importFile(siparis([A(), B(), C()]));
  assert.equal(p.getProduct('SR010.001').plannedSec, 25, 'ilk Mikro iceri almasi karttaki degeri ezmez');
  assert.equal(p.getProduct('SR010.001').grossKg, 0.021);
  assert.equal(p.getProduct('SR010.001').customerCode, '111222333', 'bos kod adin basindan dolar');
  assert.equal(p.getProduct('SR010.002').grossKg, 0.03, 'yeni kart Mikro degerleriyle acilir');
  assert.deepEqual(ilk.changes.products.added.map((x) => x.stockCode), ['SR010.002', 'SR010.003']);
  assert.deepEqual(ilk.changes.lines.added.map((x) => x.stockCode), ['SR010.001', 'SR010.002', 'SR010.003']);

  p.updateProduct('SR010.003', { note: 'elle duzenlendi' }); // C karti artik elle duzenlenmis
  const ayni = p.importFile(siparis([A(), B(), C()]));
  assert.deepEqual([ayni.products.updated, ayni.protectedCards, ayni.added, ayni.updated], [0, 0, 0, 0], 'degisiklik yok: hicbir sey degismez');

  // Mikro'da: A'nin SN'si, B'nin BR'si, C'nin BR'si degisti; A'nin BR'si degismedi; yeni bir siparis satiri geldi
  const yeniSatir = 'FIRMA X;SR010.001;111222333 PARCA A;SPR-2;20.09.2025;50;0;50;MS-2;0,0200;0,0100;28;HM1;40';
  const ikinci = p.importFile(siparis([A('0,0200', 28), B('0,0310'), C('0,0410'), yeniSatir]));
  const a = p.getProduct('SR010.001');
  assert.equal(a.plannedSec, 28, "Mikro'da degisen alan uygulandi");
  assert.equal(a.grossKg, 0.021, "Mikro'da DEGISMEYEN alan karttaki degeri korur");
  assert.equal(p.getProduct('SR010.002').grossKg, 0.031);
  assert.equal(p.getProduct('SR010.003').grossKg, 0.04, 'elle duzenlenmis kart: dokunulmadi');
  assert.deepEqual(ikinci.changes.products.updated, [
    { stockCode: 'SR010.001', fields: ['planlanan süre'] },
    { stockCode: 'SR010.002', fields: ['brüt ağırlık'] },
  ]);
  assert.deepEqual(ikinci.changes.products.protected, [{ stockCode: 'SR010.003', fields: ['brüt ağırlık'] }]);
  assert.equal(ikinci.protectedCards, 1);
  assert.deepEqual(ikinci.changes.lines.added, [{ docNo: 'SPR-2', custOrderNo: 'MS-2', stockCode: 'SR010.001', qty: 50, remaining: 50 }]);
  p.close();
});
