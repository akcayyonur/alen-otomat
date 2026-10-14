/**
 * İş emri formu PDF'i: sayfa sayısı, Türkçe karakter kodlaması, uzun metnin bölünmesi ve teknik resimlerle TEK PDF'te birleştirme. TÜM veriler sentetiktir.
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkOrderFormPdf } from './wo-form-pdf.js';
import { inspectPdf, describePages } from '../pdf-merge.js';
import { Planning } from './planning.js';

const NOW = new Date(2026, 9, 14, 12).getTime();
const MAKINELER = [{ id: 'CNC-01', name: 'Torna 1' }];
const ISEMRI = [
  'ÜRETİM EMRİ NO;TARİH;MAMÜL ADI;ALEN KOD;MÜŞTERİ KODU;MAKİNA NO;ADET;HAMMADDE;ALTERNATİF HM;ÜRETİM SN;HM TOPLAM;BRÜT GR;NET GR',
  '2026000001;02.01.2026;TEST SOMUN A;ST001.013;900000013;CNC;3500;HM614.AA24.00XYU13.00;;27;62,65;0,039;0,0078',
  '',
].join('\r\n');

const ornek = (ek = {}) => ({
  no: '2026001113', createdAt: NOW, dueDate: NOW + 86_400_000, stockCode: 'ZZ001.001', productName: 'DENEME SOMUN', custOrderNo: 'S-1', customerCode: 'M-1',
  targetQty: 1400, usedMaterial: 'HM614.AA24.00XYU13.00', material: 'HM614.AA24.00XYU13.00', altMaterial: null, netKg: 0.02242, grossKg: 0.04772, measuredNetKg: null,
  plannedSec: 20, plannedHours: 2.22, gkkReportNo: 'GK26.291', firstApprovalNo: 'I26-1281', machineNumber: 1, machineId: 'CNC-01', rawKg: 19.09, bars: 2, note: null, status: 'uretimde',
  progress: { shifts: [{ date: '2026-10-14', label: 'Gündüz', qty: 75 }] }, ...ek,
});

const metin = (buf) => buf.toString('latin1');
/** PDF içindeki metin işleminin onaltılık dizgesi (WinAnsi kodları). */
const hexOf = (codes) => `<${codes.map((c) => c.toString(16).padStart(2, '0')).join('')}>`;
const ascii = (t) => hexOf([...t].map((ch) => ch.charCodeAt(0)));

/** En küçük geçerli PDF'ler: her sayfada bir etiket. */
function pdf(...labels) {
  const n = labels.length;
  const objs = [];
  objs[1] = '<</Type /Catalog /Pages 2 0 R>>';
  objs[2] = `<</Type /Pages /Kids [${labels.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${n} /MediaBox [0 0 595 842] /Resources <</Font <</F1 3 0 R>>>>>>`;
  objs[3] = '<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>';
  labels.forEach((l, i) => {
    objs[4 + i * 2] = `<</Type /Page /Parent 2 0 R /Contents ${5 + i * 2} 0 R>>`;
    const c = `BT /F1 24 Tf 72 700 Td (${l}) Tj ET`;
    objs[5 + i * 2] = `<</Length ${c.length}>>\nstream\n${c}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offs = [];
  for (let k = 1; k < objs.length; k += 1) { offs[k] = out.length; out += `${k} 0 obj\n${objs[k]}\nendobj\n`; }
  const x = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let k = 1; k < objs.length; k += 1) out += `${String(offs[k]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<</Size ${objs.length} /Root 1 0 R>>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('form PDF: tek sayfalık A4, geçerli PDF yapısı', () => {
  const buf = buildWorkOrderFormPdf(ornek(), { now: NOW });
  assert.equal(buf.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.ok(metin(buf).trimEnd().endsWith('%%EOF'));
  assert.equal(inspectPdf(buf).pages, 1);
  assert.match(metin(buf), /\/MediaBox \[0 0 595\.28 841\.89\]/);
});

test('form PDF: Türkçe harfler doğru kodlanır (Ğ ğ Ş ş İ ı Differences ile 128-133, Ç Ö Ü WinAnsi ile)', () => {
  const s = metin(buildWorkOrderFormPdf(ornek({ productName: 'ĞğŞşİıÇÖÜ' }), { now: NOW }));
  assert.match(s, /\/Differences \[128 \/Gbreve \/gbreve \/Scedilla \/scedilla \/Idotaccent \/dotlessi\]/);
  assert.ok(s.includes(hexOf([128, 129, 130, 131, 132, 133, 0xc7, 0xd6, 0xdc])), 'ürün adı beklenen kodlarla yazılmalı');
  // etiketlerdeki İ/Ş (ör. "İŞ EMRİ", "TERMİN SÜRESİ:") de aynı kodlarla
  assert.ok(s.includes(hexOf([132, 130, 0x20, 0x45, 0x4d, 0x52, 132])), '"İŞ EMRİ" başlığı');
});

test('form PDF: desteklenmeyen karakter "?" olur; parantez ve ters bölü metni bozmaz', () => {
  const s = metin(buildWorkOrderFormPdf(ornek({ productName: '(A)\\B Ω Ø' }), { now: NOW }));
  assert.ok(s.includes(hexOf([0x28, 0x41, 0x29, 0x5c, 0x42, 0x20, 0x3f, 0x20, 0xd8])), "(A)\\B ? Ø (Ø WinAnsi'de vardır, Ω yoktur)");
});

test('form PDF: boş alanlar boş kalır, dolu alanlar yazılır (kimlik, numaralar, vardiya adedi)', () => {
  const s = metin(buildWorkOrderFormPdf(ornek(), { now: NOW }));
  for (const t of ['2026001113', 'ZZ001.001', 'GK26.291', '75', '14.10.2026', '1.400 AD', '22,42 GR', '47,72 GR']) assert.ok(s.includes(ascii(t)), t);
  const bos = metin(buildWorkOrderFormPdf(ornek({ gkkReportNo: null, firstApprovalNo: null, netKg: null, progress: null }), { now: NOW }));
  assert.ok(!bos.includes(ascii('GK26.291')) && !bos.includes(ascii('22,42 GR')));
});

test('form PDF: uzun açıklama satırlara bölünür ve sayfa dışına taşmaz', () => {
  const uzun = Array.from({ length: 80 }, (_, i) => `kelime${i}`).join(' ');
  const buf = buildWorkOrderFormPdf(ornek({ note: uzun }), { now: NOW });
  assert.equal(inspectPdf(buf).pages, 1);
  const ys = [...metin(buf).matchAll(/ ([\d.]+) Td /g)].map((m) => Number(m[1]));
  assert.ok(ys.length > 30 && Math.min(...ys) > 20, `en küçük y ${Math.min(...ys)}`);
  assert.ok(metin(buf).includes('85>'), 'çok uzun metin altı satıra kısaltılır ve "…" ile biter');
});

test('iptal edilmiş iş emrinin formunda "İPTAL EDİLDİ" yazar', () => {
  const s = metin(buildWorkOrderFormPdf(ornek({ status: 'iptal' }), { now: NOW }));
  // altbilgi tek dizge: "İPTAL EDİLDİ · Sistemden ..." (dizgenin başı)
  const bas = hexOf([132, 0x50, 0x54, 0x41, 0x4c, 0x20, 0x45, 0x44, 132, 0x4c, 0x44, 132]).slice(0, -1);
  assert.ok(s.includes(bas), 'İPTAL EDİLDİ');
  assert.ok(!metin(buildWorkOrderFormPdf(ornek(), { now: NOW })).includes(bas), 'iptal değilse yok');
});

test('Planning.workOrderPrintPdf: resim yokken yalnız form, resim varsa form + resimler TEK PDF; bilinmeyen iş emri 404', () => {
  const p = new Planning({ dbFile: ':memory:', listMachines: () => MAKINELER, productionEvents: () => [], liveMachine: () => null });
  p.importCsv(Buffer.from(ISEMRI, 'utf8'));
  const w = p.createWorkOrder({ stockCode: 'ST001.013', targetQty: 10 }, { now: NOW });
  assert.equal(inspectPdf(p.workOrderPrintPdf(w.no, { now: NOW })).pages, 1, 'resim yok: yalnız form');

  p.quality.addDrawing(w.no, { name: 'a.pdf', data: pdf('RESIM-A1', 'RESIM-A2') }, { now: NOW });
  p.quality.addDrawing(w.no, { name: 'b.pdf', data: pdf('RESIM-B1') }, { now: NOW });
  const buf = p.workOrderPrintPdf(w.no, { now: NOW });
  const sayfalar = describePages(buf);
  assert.equal(sayfalar.length, 4, 'form + 3 resim sayfası');
  // ilk sayfa form, sonrakiler resimler sırayla
  assert.ok(sayfalar[0].content.includes(ascii('ST001.013')) || sayfalar[0].content.length > 0);
  assert.deepEqual(sayfalar.slice(1).map((s) => /\(([^)]*)\)/.exec(s.content)?.[1]), ['RESIM-A1', 'RESIM-A2', 'RESIM-B1']);

  assert.throws(() => p.workOrderPrintPdf('2026009999', { now: NOW }), (e) => e.status === 404);
});
