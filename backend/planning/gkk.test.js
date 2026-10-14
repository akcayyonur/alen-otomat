/**
 * GKK rapor numarası (EYS.FR.011) ve ilk onay kodu (EYS.FR.013) SAF yardımcıları: numara biçimleri, hammadde eşleştirme, form CSV'si okuma.
 * Hammadde adları genel malzeme tanımlarıdır; tüm kayıtlar sentetiktir.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from './csv-read.js';
import { parseGkNo, formatGkNo, parseMaterial, parseErpMaterial, matchMaterials, compareMaterials, readGkkSheet, findGkkHeader, compactKey } from './gkk.js';
import { parseApprovalCode, formatApprovalCode, readApprovalSheet } from './first-approval.js';

test('GK numarası: biçim, tolerans, geçersizler', () => {
  assert.deepEqual(parseGkNo('GK26.396'), { year: 2026, seq: 396, no: 'GK26.396' });
  assert.deepEqual(parseGkNo(' gk26.5 '), { year: 2026, seq: 5, no: 'GK26.005' }, 'küçük harf, boşluk, kısa sıra');
  assert.equal(parseGkNo('GK25-178')?.no, 'GK25.178');
  assert.equal(formatGkNo(2026, 7), 'GK26.007');
  for (const bad of ['', null, 'GK26', 'GK2026.1', 'XX26.001', 'GK26.0', 'GK26.12345', '26.001']) assert.equal(parseGkNo(bad), null, String(bad));
  assert.equal(compactKey('AA24 X 13 - PB3'), 'AA24X13PB3');
});

test('hammadde cinsi çözümleme: kayıt tarafı', () => {
  assert.deepEqual(parseMaterial('AA24 X 13 - PB3'), { shape: 'AA', dims: [24, 13], alloy: 'PB3', extra: '' });
  assert.deepEqual(parseMaterial('YUV18 - PB3 ISIL İŞLEMLİ'), { shape: 'YUV', dims: [18], alloy: 'PB3', extra: 'ISILISLEMLI' });
  assert.deepEqual(parseMaterial('YUV 22 - 602N'), { shape: 'YUV', dims: [22], alloy: '602N', extra: '' });
  assert.deepEqual(parseMaterial('8 KÖŞE 52 X 27 - 602 N'), { shape: 'SK', dims: [52, 27], alloy: '602N', extra: '' }, '8 köşe ve "602 N" boşluğu');
  assert.deepEqual(parseMaterial('AA11,18 - CW603N'), { shape: 'AA', dims: [11.18], alloy: 'CW603N', extra: '' }, 'ondalık virgül');
  assert.equal(parseMaterial('AA14 - 603N ').alloy, 'CW603N', '603N = CW603N');
  assert.equal(parseMaterial('AA24 - PB3 - R430S').extra, 'R430S');
  assert.equal(parseMaterial('AA30 X 17 - PB3 HB').extra, 'HB');
  assert.equal(parseMaterial('ST001.001 - 900000001'), null, 'ürün satırı: tanınmaz');
  assert.equal(parseMaterial('YUV32  23 - PB2'), null, 'bozuk yazım: tanınmaz (serbest aramayla bulunur)');
});

test('hammadde cinsi çözümleme: iş emrindeki ERP kodu', () => {
  assert.deepEqual(parseErpMaterial('HM614.YU23.00XYU16.00'), { shape: 'YUV', dims: [23, 16], alloy: 'PB3', extra: '' });
  assert.deepEqual(parseErpMaterial('HM617.AA24.00'), { shape: 'AA', dims: [24], alloy: 'PB2', extra: '' });
  assert.deepEqual(parseErpMaterial('HM617.AA11.11'), { shape: 'AA', dims: [11.11], alloy: 'PB2', extra: '' });
  assert.deepEqual(parseErpMaterial('HM602.SK52.00XYU27.00'), { shape: 'SK', dims: [52, 27], alloy: '602N', extra: '' });
  assert.deepEqual(parseErpMaterial('HM3604.AA21.00'), { shape: 'AA', dims: [21], alloy: 'C3604BD', extra: '' });
  assert.equal(parseErpMaterial('HM614HB.AA30.00XYU17.00').extra, 'HB', 'HB varyantı');
  assert.equal(parseErpMaterial('HM614.AA24.0 R430').extra, 'R430', 'sondaki ek sözcük');
  assert.equal(parseErpMaterial('DÖVME ÜRÜN'), null);
  assert.equal(parseErpMaterial('HM999.AA24.00'), null, 'bilinmeyen alaşım: eşleştirilmez');
  assert.equal(parseErpMaterial(''), null);
});

test('iş emri hammaddesi için eşleşme: tam / aynı ölçü işlem farklı / dövme ürün; yeni rapor önce', () => {
  const kayit = [
    { id: 1, material: 'AA24 X 13 - PB3', producerDate: Date.UTC(2026, 2, 1), year: 2026, seq: 100 },
    { id: 2, material: 'AA24 X 13 - PB3', producerDate: Date.UTC(2026, 8, 1), year: 2026, seq: 300 },
    { id: 3, material: 'AA24 X 13 - PB3 ISIL İŞLEMLİ', producerDate: Date.UTC(2026, 9, 1), year: 2026, seq: 386 },
    { id: 4, material: 'AA24 X 13 - PB2', producerDate: Date.UTC(2026, 8, 1), year: 2026, seq: 301 },
    { id: 5, material: 'AA24 X 14 - PB3', producerDate: Date.UTC(2026, 8, 1), year: 2026, seq: 302 },
    { id: 6, material: 'ST014.013 - 900000185', producerDate: null, year: 2026, seq: 159 },
  ];
  const m = matchMaterials(kayit, { erpMaterial: 'HM614.AA24.00XYU13.00' });
  assert.deepEqual(m, [{ id: 2, kind: 'tam' }, { id: 1, kind: 'tam' }, { id: 3, kind: 'islemli' }], 'tam eşleşmeler yeni tarihten eskiye, işlemli en sonda; PB2 ve başka ölçü yok');
  assert.deepEqual(matchMaterials(kayit, { erpMaterial: 'DÖVME ÜRÜN', stockCode: 'ST014.013' }), [{ id: 6, kind: 'urun' }], 'dövme ürün: stok koduyla');
  assert.deepEqual(matchMaterials(kayit, { erpMaterial: 'HM617.AA24.00XYU13.00' }), [{ id: 4, kind: 'tam' }], '617 = PB2');
  assert.deepEqual(matchMaterials(kayit, {}), []);
  assert.deepEqual(matchMaterials(kayit, { erpMaterial: 'HM614.YU99.00' }), [], 'karşılığı olmayan');
});

test('liste sırası formdaki gibi: YUV, AA, 8 KÖŞE, sonra diğerleri; aynı grupta ölçüye göre', () => {
  const sirali = ['SR001.013 - 100', '8 KÖŞE 34 X 20 - PB2', 'AA24 X 13 - PB3', 'YUV14 - PB3', 'AA11,11 - PB2', 'YUV12 - PB3', 'AA24 - PB3'];
  assert.deepEqual([...sirali].sort(compareMaterials), ['YUV12 - PB3', 'YUV14 - PB3', 'AA11,11 - PB2', 'AA24 - PB3', 'AA24 X 13 - PB3', '8 KÖŞE 34 X 20 - PB2', 'SR001.013 - 100']);
});

const GKK_CSV = [
  ';;GİRİŞ KALİTE KONTROL RAPOR NUMARASI TAKİP FORMU;;;',
  '',
  'SIRA;ÜRÜN ;;RAPOR NO;ÜRETİCİ RAPOR TARİHİ;AÇIKLAMA',
  '1;YUV12 - PB3;;GK25.013;02.02.2024;',
  '2;AA24 X 13 - PB3;;GK26.395;26.09.2026;ısıl işlem notu',
  '3;ST014.013 - 900000185;;GK26.159;;DÖVME ÜRÜN',
  '4;AA99 - PB3;;GK26.9;31.02.2026;',
  ';;;GK26.396;;',
  ';;;GK26.397;;',
  '5;YUV20 - PB3;;;12.10.2026;numarasız',
  '',
].join('\r\n');

test('GKK formu CSV\'si: başlık birkaç satır aşağıda; önceden basılmış boş numaralar kayıt değildir; bozuk tarih uyarılır', () => {
  const parsed = parseCsv(GKK_CSV);
  assert.equal(findGkkHeader(parsed).headerRow, 1, 'ilk dolu satır form başlığı, ikincisi sütun başlıkları');
  const uyari = [];
  const r = readGkkSheet(parsed, (m) => uyari.push(m));
  assert.deepEqual(r.records.map((x) => [x.sortNo, x.material, x.reportNo, x.producerDate === null ? null : new Date(x.producerDate).getFullYear(), x.note]), [
    [1, 'YUV12 - PB3', 'GK25.013', 2024, null],
    [2, 'AA24 X 13 - PB3', 'GK26.395', 2026, 'ısıl işlem notu'],
    [3, 'ST014.013 - 900000185', 'GK26.159', null, 'DÖVME ÜRÜN'],
    [4, 'AA99 - PB3', 'GK26.009', null, null],
  ]);
  assert.equal(r.freeNumbers, 2);
  assert.ok(uyari.some((u) => /1 satırda üretici rapor tarihi okunamadı/.test(u)), uyari.join('|'));
  assert.ok(uyari.some((u) => /rapor numarası okunamadı \(""\)|numarası okunamadı/.test(u)), 'numarası olmayan ürün satırı uyarılır');
  assert.deepEqual(readGkkSheet(parseCsv('A;B\r\n1;2\r\n')).records, [], 'tanınmayan dosya: kayıt yok');
});

test('ilk onay kodu: biçim ve tolerans', () => {
  assert.deepEqual(parseApprovalCode('İ26-1281'), { year: 2026, seq: 1281, code: 'İ26-1281' });
  assert.equal(parseApprovalCode('i26-1281')?.code, 'İ26-1281', 'küçük i');
  assert.equal(parseApprovalCode('I26-010')?.code, 'İ26-010', 'noktasız İ, 3 haneli');
  assert.equal(parseApprovalCode(' İ26 - 5 ')?.code, 'İ26-005');
  assert.equal(formatApprovalCode(2026, 7), 'İ26-007');
  assert.equal(formatApprovalCode(2026, 1281), 'İ26-1281');
  for (const bad of ['', 'İ26', 'GK26.001', 'İ2026-5', 'İ26-0']) assert.equal(parseApprovalCode(bad), null, bad);
});

const FA_CSV = [
  'İLK BASKI ONAY / NUMUNE TAKİP LİSTESİ;;;;;;',
  '',
  'İLK BASKI ONAY KODU;ÜRÜN KODU;GK- KODU;İŞ EMRİ NO;TARİH;OPERATÖR;CNC NO',
  'İ26-1279;ST001.013;GK26.395;2026001100;12.10.2026;Ayşe;5',
  'İ26-1280;ST002.001;GK-;;13.10.2026;;',
  'İ26-1281;;GK-;;;;',
  'İ26-1282;;GK-;;;;',
  'İ26-bozuk;ST003.001;;;;;',
].join('\r\n');

test('ilk onay listesi CSV\'si: önceden basılmış boş kodlar kayıt değil (en küçüğü sıradaki numarayı gösterir); "GK-" yer tutucudur', () => {
  const uyari = [];
  const r = readApprovalSheet(parseCsv(FA_CSV), (m) => uyari.push(m));
  assert.deepEqual(r.records.map((x) => [x.code, x.stockCode, x.gkCode, x.woNo, x.operator, x.machineId, x.approvedOn === null ? null : new Date(x.approvedOn).getDate()]), [
    ['İ26-1279', 'ST001.013', 'GK26.395', '2026001100', 'Ayşe', 'CNC-05', 12],
    ['İ26-1280', 'ST002.001', null, null, null, null, 13],
  ]);
  assert.equal(r.firstBlank.get(2026), 1281);
  assert.ok(uyari.some((u) => /okunamadı \("İ26-bozuk"\)/.test(u)));
});
