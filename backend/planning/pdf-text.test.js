/**
 * PDF metin çıkarma testleri: kendi ürettiğimiz küçük, klasik xref'li PDF'lerle (ToUnicode bfchar/bfrange,
 * WinAnsi tablosu, cm/q/Q grafik dönüşümü, taranmış sayfa). Gerçek sipariş PDF'leriyle (Siamp/iText,
 * Ayvaz-HaVana/Skia, Konveyör/Adobe LiveCycle, taranmış Ayvaz/Canon) AYRICA elle doğrulandı — bkz.
 * CLAUDE.md §6 "Mail'den otomatik sipariş girişi": Konveyör'ün WinAnsi tablosuyla, Ayvaz'ın cm izlemeyle
 * düzgün okunduğu bu şekilde bulundu; taranmış sayfa hiç metin içermediği (`unreadable:'scanned'`)
 * için bu testlerde de gerçek bir görüntü GEREKMEZ — yalnız bir Image XObject + hiç metin yeter.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPdfText, parseToUnicodeCMap, groupRunsIntoLines, PdfTextError } from './pdf-text.js';

const latin1 = (s) => Buffer.from(s, 'latin1');

/** Minimal klasik-xref'li PDF üretir. `objs[k]` ya düz dict metni ya da `{dict, stream}` (Length otomatik). */
function buildPdf(objs) {
  let out = '%PDF-1.4\n';
  const offs = [];
  for (let k = 1; k < objs.length; k += 1) {
    offs[k] = out.length;
    const o = objs[k];
    if (typeof o === 'string') out += `${k} 0 obj\n${o}\nendobj\n`;
    else {
      const dict = o.dict.replace('>>', ` /Length ${o.stream.length} >>`);
      out += `${k} 0 obj\n${dict}\nstream\n${o.stream}\nendstream\nendobj\n`;
    }
  }
  const xrefOffset = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let k = 1; k < objs.length; k += 1) out += `${String(offs[k]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<</Size ${objs.length} /Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return latin1(out);
}

/** Resources'ı üst (Pages) düğümünde veren, tek sayfalı, tek fontlu bir belge. */
function onePagePdf({ fontDict, toUnicodeStream, content }) {
  const objs = [];
  objs[1] = '<</Type /Catalog /Pages 2 0 R>>';
  objs[2] = '<</Type /Pages /Kids [4 0 R] /Count 1 /MediaBox [0 0 595 842] /Resources <</Font <</F1 3 0 R>>>>>>';
  objs[3] = fontDict;
  objs[4] = '<</Type /Page /Parent 2 0 R /Contents 5 0 R>>';
  objs[5] = { dict: '<<>>', stream: content };
  if (toUnicodeStream !== undefined) objs[6] = { dict: '<<>>', stream: toUnicodeStream };
  return buildPdf(objs);
}

const CMAP_HEADER = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n';
const CMAP_FOOTER = '\nendcmap\nend';

test('parseToUnicodeCMap: bfchar tek tek, bfrange dogrusal ve dizi formu', () => {
  const bytes = latin1(`${CMAP_HEADER}2 beginbfchar\n<0001> <0041>\n<0002> <00420043>\nendbfchar\n1 beginbfrange\n<0010> <0012> <0061>\nendbfrange\n1 beginbfrange\n<0020> <0021> [<0078> <0079>]\nendbfrange${CMAP_FOOTER}`);
  const m = parseToUnicodeCMap(bytes);
  assert.equal(m.get(1), 'A');
  assert.equal(m.get(2), 'BC'); // iki kod birimi (ör. baglac) tek bir dst dizgisinde olabilir
  assert.deepEqual([m.get(0x10), m.get(0x11), m.get(0x12)], ['a', 'b', 'c']); // dogrusal artan aralik
  assert.deepEqual([m.get(0x20), m.get(0x21)], ['x', 'y']); // dizi formu
});

test('Type0 + ToUnicode (bfchar+bfrange): Tm ile konumlanmis Tj metni dogru cozulur', () => {
  const toUnicode = latin1(`${CMAP_HEADER}2 beginbfchar\n<0001> <0041>\n<0002> <0042>\nendbfchar\n1 beginbfrange\n<0003> <0005> <0043>\nendbfrange${CMAP_FOOTER}`);
  const buf = onePagePdf({
    fontDict: '<</Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /ToUnicode 6 0 R>>',
    toUnicodeStream: toUnicode,
    content: 'BT /F1 12 Tf 1 0 0 1 100 700 Tm <0001000200030004> Tj ET',
  });
  const { pages } = extractPdfText(buf);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].unreadable, null);
  assert.deepEqual(pages[0].runs, [{ x: 100, y: 700, size: 12, text: 'ABCD' }]);
});

test('TJ dizisi: metin parcalari ayni konumda tek satira birlesir, ayarlama sayilari yok sayilir', () => {
  const toUnicode = latin1(`${CMAP_HEADER}1 beginbfrange\n<0041> <005A> <0041>\nendbfrange${CMAP_FOOTER}`); // kod==ASCII (test kolayligi icin)
  const buf = onePagePdf({
    fontDict: '<</Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /ToUnicode 6 0 R>>',
    toUnicodeStream: toUnicode,
    content: 'BT /F1 10 Tf 1 0 0 1 10 10 Tm [<0041004200> -200 <004300> 50 <0044>] TJ ET',
  });
  const { pages } = extractPdfText(buf);
  assert.equal(pages[0].runs[0].text, 'ABCD');
});

test('cm + q/Q: metin konumu grafik donusum matrisiyle (CTM) birlikte hesaplanir', () => {
  const toUnicode = latin1(`${CMAP_HEADER}1 beginbfrange\n<0041> <005A> <0041>\nendbfrange${CMAP_FOOTER}`);
  const buf = onePagePdf({
    fontDict: '<</Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /ToUnicode 6 0 R>>',
    toUnicodeStream: toUnicode,
    // Gercek Ayvaz/Konveyor orneklerinde oldugu gibi konum Tm'de DEGIL, cm'de: Tm yerelde (0,0).
    content: 'q 1 0 0 1 50 60 cm BT /F1 10 Tf 1 0 0 1 5 7 Tm <0041> Tj ET Q BT /F1 10 Tf 1 0 0 1 9 9 Tm <0042> Tj ET',
  });
  const { pages } = extractPdfText(buf);
  // ilki cm(50,60) + Tm(5,7) = (55,67); Q'dan sonra CTM kimlige doner, ikincisi duz Tm(9,9)
  assert.deepEqual(pages[0].runs.map((r) => [r.x, r.y, r.text]), [[55, 67, 'A'], [9, 9, 'B']]);
});

test('BT metin matrisini sifirlar: onceki bloktan Tm/Td mirasi KALMAZ', () => {
  const toUnicode = latin1(`${CMAP_HEADER}1 beginbfrange\n<0041> <005A> <0041>\nendbfrange${CMAP_FOOTER}`);
  const buf = onePagePdf({
    fontDict: '<</Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /ToUnicode 6 0 R>>',
    toUnicodeStream: toUnicode,
    content: 'BT /F1 10 Tf 1 0 0 1 200 300 Tm <0041> Tj ET BT /F1 10 Tf 5 5 Td <0042> Tj ET',
  });
  const { pages } = extractPdfText(buf);
  assert.deepEqual(pages[0].runs.map((r) => [r.x, r.y]), [[200, 300], [5, 5]]);
});

test('WinAnsiEncoding geri dusumu: ToUnicode OLMAYAN basit fontta (/Encoding /WinAnsiEncoding) metin yine cozulur', () => {
  const buf = onePagePdf({
    fontDict: '<</Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding>>',
    content: 'BT /F1 11 Tf 1 0 0 1 72 700 Tm (Merhaba 123) Tj ET',
  });
  const { pages } = extractPdfText(buf);
  assert.equal(pages[0].unreadable, null);
  assert.equal(pages[0].runs[0].text, 'Merhaba 123');
});

test('Encoding hic verilmemis basit font da WinAnsi (ASCII) ile cozulur', () => {
  const buf = onePagePdf({
    fontDict: '<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>',
    content: 'BT /F1 11 Tf 1 0 0 1 0 0 Tm (ABC) Tj ET',
  });
  const { pages } = extractPdfText(buf);
  assert.equal(pages[0].runs[0].text, 'ABC');
});

test('ToUnicode haritasi olmayan Type0 (CID) font: metin cozulemez, sayfa no-cmap doner', () => {
  const buf = onePagePdf({
    fontDict: '<</Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H>>', // ToUnicode YOK
    content: 'BT /F1 10 Tf 1 0 0 1 0 0 Tm <00010002> Tj ET',
  });
  const { pages } = extractPdfText(buf);
  assert.equal(pages[0].unreadable, 'no-cmap');
  assert.deepEqual(pages[0].runs.map((r) => r.text), [null]);
});

test('hic metin komutu yok ama goruntu XObject var: taranmis sayfa (unreadable:scanned), DCTDecode goruntusu OCR icin cikarilir', () => {
  const objs = [];
  objs[1] = '<</Type /Catalog /Pages 2 0 R>>';
  objs[2] = '<</Type /Pages /Kids [4 0 R] /Count 1 /MediaBox [0 0 595 842] /Resources <</XObject <</Im0 3 0 R>>>>>>';
  objs[3] = { dict: '<</Type /XObject /Subtype /Image /Width 1 /Height 1 /Filter /DCTDecode>>', stream: 'x' };
  objs[4] = '<</Type /Page /Parent 2 0 R /Contents 5 0 R>>';
  objs[5] = { dict: '<<>>', stream: 'q 1 0 0 1 0 0 cm /Im0 Do Q' };
  const buf = buildPdf(objs);
  const { pages } = extractPdfText(buf);
  assert.equal(pages[0].unreadable, 'scanned');
  assert.equal(pages[0].runs.length, 0);
  assert.deepEqual(pages[0].image, { bytes: Buffer.from('x', 'latin1'), width: 1, height: 1, format: 'jpeg', blackIs1: false });
});

test('taranmis sayfa, goruntu CCITTFaxDecode AMA /K DecodeParms yok (varsayilan K=0, Grup 3): image=null (yalniz Grup 4 destekleniyor)', () => {
  const objs = [];
  objs[1] = '<</Type /Catalog /Pages 2 0 R>>';
  objs[2] = '<</Type /Pages /Kids [4 0 R] /Count 1 /MediaBox [0 0 595 842] /Resources <</XObject <</Im0 3 0 R>>>>>>';
  objs[3] = { dict: '<</Type /XObject /Subtype /Image /Width 1 /Height 1 /Filter /CCITTFaxDecode>>', stream: 'x' };
  objs[4] = '<</Type /Page /Parent 2 0 R /Contents 5 0 R>>';
  objs[5] = { dict: '<<>>', stream: 'q 1 0 0 1 0 0 cm /Im0 Do Q' };
  const buf = buildPdf(objs);
  const { pages } = extractPdfText(buf);
  assert.equal(pages[0].unreadable, 'scanned'); // tespit degismedi (hasImageXObjects her alt turu sayar)
  assert.equal(pages[0].image, null); // yalniz OCR icin cikarim yapilmadi
});

test('taranmis sayfa, CCITTFaxDecode Grup 4 (K=-1) goruntu dogru cikarilir (blackIs1 varsayilan false)', () => {
  const objs = [];
  objs[1] = '<</Type /Catalog /Pages 2 0 R>>';
  objs[2] = '<</Type /Pages /Kids [4 0 R] /Count 1 /MediaBox [0 0 595 842] /Resources <</XObject <</Im0 3 0 R>>>>>>';
  objs[3] = { dict: '<</Type /XObject /Subtype /Image /Width 10 /Height 10 /Filter /CCITTFaxDecode /DecodeParms <</K -1 /Columns 10>>>>', stream: 'ccittbaytlari' };
  objs[4] = '<</Type /Page /Parent 2 0 R /Contents 5 0 R>>';
  objs[5] = { dict: '<<>>', stream: 'q 1 0 0 1 0 0 cm /Im0 Do Q' };
  const buf = buildPdf(objs);
  const { pages } = extractPdfText(buf);
  assert.equal(pages[0].unreadable, 'scanned');
  assert.deepEqual(pages[0].image, { bytes: Buffer.from('ccittbaytlari', 'latin1'), width: 10, height: 10, format: 'ccitt-g4', blackIs1: false });
});

test('taranmis sayfada HEM CCITT Grup4 HEM DCTDecode varsa, ALANI BUYUK OLAN secilir (gercek Ayvaz/Canon taramasinda CCITT her zaman buyuktu)', () => {
  const objs = [];
  objs[1] = '<</Type /Catalog /Pages 2 0 R>>';
  objs[2] = '<</Type /Pages /Kids [4 0 R] /Count 1 /MediaBox [0 0 595 842] /Resources <</XObject <</Im0 3 0 R /Im1 6 0 R>>>>>>';
  objs[3] = { dict: '<</Type /XObject /Subtype /Image /Width 100 /Height 100 /Filter /DCTDecode>>', stream: 'kucukjpeg' }; // alan=10000
  objs[4] = '<</Type /Page /Parent 2 0 R /Contents 5 0 R>>';
  objs[5] = { dict: '<<>>', stream: 'q 1 0 0 1 0 0 cm /Im0 Do /Im1 Do Q' };
  objs[6] = { dict: '<</Type /XObject /Subtype /Image /Width 200 /Height 200 /Filter /CCITTFaxDecode /DecodeParms <</K -1 /Columns 200>>>>', stream: 'buyukccitt' }; // alan=40000
  const buf = buildPdf(objs);
  const { pages } = extractPdfText(buf);
  assert.equal(pages[0].image.format, 'ccitt-g4');
  assert.equal(pages[0].image.bytes.toString('latin1'), 'buyukccitt');
});

test('groupRunsIntoLines: ayni Y (toleransli) satir sayilir, satir icinde X artan siralanir', () => {
  const runs = [
    { x: 50, y: 100.3, size: 10, text: 'B' },
    { x: 10, y: 100, size: 10, text: 'A' },
    { x: 20, y: 50, size: 10, text: 'C' },
    { x: 5, y: 100.2, size: 10, text: null }, // cozulemeyen: filtrelenir
  ];
  const lines = groupRunsIntoLines(runs);
  assert.equal(lines.length, 2, 'iki gercek satir (toleransli ayni Y birlesir), null filtrelenir');
  assert.deepEqual(lines[0].cells.map((c) => c.text), ['A', 'B'], 'ust satir (Y buyuk) once, soldan saga');
  assert.deepEqual(lines[1].cells.map((c) => c.text), ['C']);
});

test('gecersiz bir bufferda (PDF basligi yok) PdfTextError firlatilir', () => {
  assert.throws(() => extractPdfText(latin1('bu bir pdf degil')), (err) => err instanceof PdfTextError);
});
