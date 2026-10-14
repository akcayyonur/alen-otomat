/**
 * PDF birleştirici testleri: farklı PDF biçimlerini (klasik xref, xref akışı + nesne akışı, artımlı güncelleme, bozuk xref, başı kirli dosya)
 * kendimiz üretiriz; birleştirme sayfaları sırayla ve içerikleri aynen taşımalı. Gerçek çizim dosyalarıyla ayrıca elle denendi
 * (pypdf ve pdftotext ile çıktı doğrulandı); bu testler depodaki sentetik dosyalara dayanır.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { mergePdfs, inspectPdf, describePages, PdfError } from './pdf-merge.js';

const content = (label) => `BT /F1 24 Tf 72 700 Td (${label}) Tj ET`;
const latin1 = (s) => Buffer.from(s, 'latin1');

/** Klasik xref'li PDF. MediaBox/Resources ÜST düğümde (sayfalar miras alır). @returns {{buf: Buffer, xrefOffset: number, objOffsets: number[]}} */
function classic(labels, { trailerExtra = '', annots = false } = {}) {
  const n = labels.length;
  const objs = [];
  objs[1] = '<</Type /Catalog /Pages 2 0 R>>';
  objs[2] = `<</Type /Pages /Kids [${labels.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${n} /MediaBox [0 0 595 842] /Resources <</Font <</F1 3 0 R>>>>>>`;
  objs[3] = '<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>';
  labels.forEach((l, i) => {
    objs[4 + i * 2] = `<</Type /Page /Parent 2 0 R /Contents ${5 + i * 2} 0 R${annots ? ' /Annots [<</Type /Annot /Subtype /Link /Rect [0 0 10 10]>>]' : ''}>>`;
    const c = content(l);
    objs[5 + i * 2] = `<</Length ${c.length}>>\nstream\n${c}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offs = [];
  for (let k = 1; k < objs.length; k += 1) { offs[k] = out.length; out += `${k} 0 obj\n${objs[k]}\nendobj\n`; }
  const xrefOffset = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let k = 1; k < objs.length; k += 1) out += `${String(offs[k]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<</Size ${objs.length} /Root 1 0 R${trailerExtra}>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return { buf: latin1(out), xrefOffset, objOffsets: offs };
}

/** xref akışı + nesne akışı (Flate, PNG "Up" öngörücü) kullanan modern PDF. */
function modern(labels) {
  const n = labels.length;
  const bodies = ['<</Type /Catalog /Pages 2 0 R>>',
    `<</Type /Pages /Kids [${labels.map((_, i) => `${4 + i} 0 R`).join(' ')}] /Count ${n} /MediaBox [0 0 842 595] /Resources <</Font <</F1 3 0 R>>>>>>`,
    '<</Type /Font /Subtype /Type1 /BaseFont /Courier>>',
    ...labels.map((_, i) => `<</Type /Page /Parent 2 0 R /Contents ${4 + n + i} 0 R>>`)];
  const compressed = 3 + n; // nesne akışının içindekiler: 1..3+n
  const stmNum = 4 + 2 * n;
  const xrefNum = 5 + 2 * n;
  let header = '';
  let data = '';
  bodies.forEach((b, i) => { header += `${i + 1} ${data.length} `; data += `${b}\n`; });
  const objStmData = deflateSync(latin1(header + data));
  let out = '%PDF-1.5\n';
  const offs = [];
  labels.forEach((l, i) => {
    offs[4 + n + i] = out.length;
    const c = deflateSync(latin1(content(l)));
    out += `${4 + n + i} 0 obj\n<</Length ${c.length} /Filter /FlateDecode>>\nstream\n`;
    out = latin1(out); // Buffer'a geç
    out = Buffer.concat([out, c, latin1('\nendstream\nendobj\n')]).toString('latin1');
  });
  offs[stmNum] = out.length;
  out += `${stmNum} 0 obj\n<</Type /ObjStm /N ${bodies.length} /First ${header.length} /Length ${objStmData.length} /Filter /FlateDecode>>\nstream\n`;
  out = Buffer.concat([latin1(out), objStmData, latin1('\nendstream\nendobj\n')]).toString('latin1');
  const xrefOffset = out.length;
  offs[xrefNum] = xrefOffset;
  const size = xrefNum + 1;
  const rowLen = 1 + 4 + 2;
  const rows = [];
  for (let k = 0; k < size; k += 1) {
    const r = Buffer.alloc(rowLen);
    if (k === 0) { r[0] = 0; r.writeUInt32BE(0, 1); r.writeUInt16BE(65535, 5); }
    else if (k <= compressed) { r[0] = 2; r.writeUInt32BE(stmNum, 1); r.writeUInt16BE(k - 1, 5); }
    else { r[0] = 1; r.writeUInt32BE(offs[k], 1); r.writeUInt16BE(0, 5); }
    rows.push(r);
  }
  // PNG "Up" öngörücüsü (Predictor 12): her satır önündeki satırdan farkla
  const enc = [];
  rows.forEach((r, k) => {
    const prev = k > 0 ? rows[k - 1] : Buffer.alloc(rowLen);
    const line = Buffer.alloc(rowLen + 1);
    line[0] = 2;
    for (let i = 0; i < rowLen; i += 1) line[i + 1] = (r[i] - prev[i]) & 255;
    enc.push(line);
  });
  const xr = deflateSync(Buffer.concat(enc));
  out += `${xrefNum} 0 obj\n<</Type /XRef /Size ${size} /W [1 4 2] /Root 1 0 R /Filter /FlateDecode /DecodeParms <</Predictor 12 /Columns ${rowLen}>> /Length ${xr.length}>>\nstream\n`;
  out = Buffer.concat([latin1(out), xr, latin1(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`)]);
  return out;
}

const texts = (buf) => describePages(buf).map((p) => /\(([^)]*)\)/.exec(p.content)?.[1] ?? null);

test('klasik PDF: sayfa sayısı okunur, tek dosya aynen döner', () => {
  const { buf } = classic(['A1', 'A2']);
  assert.equal(inspectPdf(buf).pages, 2);
  assert.equal(mergePdfs([buf]), buf, 'tek dosya yeniden yazılmaz');
});

test('iki klasik PDF birleşir: sayfalar sırayla, içerik aynen, miras alınan MediaBox/Resources sayfaya yazılır', () => {
  const a = classic(['A1', 'A2']).buf;
  const b = classic(['B1']).buf;
  const out = mergePdfs([a, b]);
  assert.equal(inspectPdf(out).pages, 3);
  assert.deepEqual(texts(out), ['A1', 'A2', 'B1']);
  for (const p of describePages(out)) {
    assert.deepEqual(p.mediaBox, [0, 0, 595, 842], 'üst düğümdeki MediaBox sayfaya taşındı');
    assert.equal(p.hasResources, true);
  }
  // Çıktının kendisi de geçerli ve tekrar birleştirilebilir (idempotent yapı)
  assert.deepEqual(texts(mergePdfs([out, classic(['C1']).buf])), ['A1', 'A2', 'B1', 'C1']);
});

test('xref akışı + nesne akışı (Flate, PNG öngörücü) okunur ve klasikle birleşir', () => {
  const m = modern(['M1', 'M2', 'M3']);
  assert.equal(inspectPdf(m).pages, 3);
  const out = mergePdfs([classic(['A1']).buf, m]);
  assert.deepEqual(texts(out), ['A1', 'M1', 'M2', 'M3']);
  assert.deepEqual(describePages(out)[1].mediaBox, [0, 0, 842, 595], 'her dosyanın kendi sayfa boyutu korunur');
});

test('artımlı güncelleme: /Prev zinciri izlenir, yeni sürüm kazanır', () => {
  const base = classic(['ESKI']);
  const newContent = content('YENI');
  const upd = `5 0 obj\n<</Length ${newContent.length}>>\nstream\n${newContent}\nendstream\nendobj\n`;
  const off5 = base.buf.length;
  const xrefAt = off5 + upd.length;
  const tail = `xref\n5 1\n${String(off5).padStart(10, '0')} 00000 n \ntrailer\n<</Size 6 /Root 1 0 R /Prev ${base.xrefOffset}>>\nstartxref\n${xrefAt}\n%%EOF\n`;
  const updated = Buffer.concat([base.buf, latin1(upd + tail)]);
  assert.deepEqual(texts(updated), ['YENI']);
  assert.deepEqual(texts(mergePdfs([updated, classic(['B1']).buf])), ['YENI', 'B1']);
});

test('bozuk startxref: dosya taranıp onarılır', () => {
  const { buf } = classic(['A1', 'A2']);
  const broken = Buffer.from(buf.toString('latin1').replace(/startxref\n\d+/, 'startxref\n99999'), 'latin1');
  assert.equal(inspectPdf(broken).pages, 2);
  assert.deepEqual(texts(mergePdfs([broken, classic(['B1']).buf])), ['A1', 'A2', 'B1']);
});

test('yanlış nesne ofsetleri (xref kaymış): onarılır', () => {
  const { buf } = classic(['A1']);
  const shifted = Buffer.from(buf.toString('latin1').replace(/(\d{10}) 00000 n/g, (_, o) => `${String(Number(o) + 7).padStart(10, '0')} 00000 n`), 'latin1');
  assert.deepEqual(texts(shifted), ['A1']);
});

test('modern PDF\'te xref akışı bozuksa nesne akışları taranıp onarılır', () => {
  const m = modern(['M1', 'M2']);
  const broken = Buffer.from(m.toString('latin1').replace(/startxref\n\d+/, 'startxref\n5'), 'latin1');
  assert.deepEqual(texts(broken), ['M1', 'M2']);
});

test('başında çöp bulunan PDF (ofsetler %PDF başlığına göre): okunur', () => {
  const { buf } = classic(['A1', 'A2']);
  const dirty = Buffer.concat([latin1('Content-Type: application/pdf\r\n\r\n'), buf]);
  assert.deepEqual(texts(dirty), ['A1', 'A2']);
});

test('ek açıklamalar (/Annots) taşınmaz, sayfa içeriği taşınır', () => {
  const out = mergePdfs([classic(['A1'], { annots: true }).buf, classic(['B1'], { annots: true }).buf]);
  assert.equal(out.toString('latin1').includes('/Annots'), false);
  assert.deepEqual(texts(out), ['A1', 'B1']);
});

test('ortak nesneler (yazı tipi) bir dosyada bir kez kopyalanır', () => {
  const out = mergePdfs([classic(['A1', 'A2', 'A3']).buf, classic(['B1']).buf]).toString('latin1');
  assert.equal(out.split('/BaseFont /Helvetica').length - 1, 2, 'dosya başına bir kopya (3+1 sayfa, 2 yazı tipi nesnesi)');
});

test('şifreli PDF reddedilir, PDF olmayan dosya reddedilir', () => {
  const enc = classic(['A1'], { trailerExtra: ' /Encrypt 3 0 R' }).buf;
  assert.throws(() => inspectPdf(enc), (e) => e instanceof PdfError && /Şifreli/.test(e.message));
  assert.throws(() => mergePdfs([enc, classic(['B1']).buf]), (e) => e instanceof PdfError && /Şifreli/.test(e.message));
  assert.throws(() => inspectPdf(Buffer.from('Merhaba, ben bir PDF değilim. '.repeat(10))), (e) => e instanceof PdfError && /PDF dosyası değil/.test(e.message));
  assert.throws(() => inspectPdf(Buffer.alloc(3)), PdfError);
  assert.throws(() => mergePdfs([]), PdfError);
});

test('hasarlı dosya anlaşılır bir hata verir (çökmez); hata hangi dosyada olduğunu söyler', () => {
  const truncated = classic(['A1']).buf.subarray(0, 60);
  assert.throws(() => inspectPdf(truncated), PdfError);
  assert.throws(() => mergePdfs([classic(['A1']).buf, truncated]), (e) => e instanceof PdfError && /^2\. PDF/.test(e.message));
});

test('sayfası olmayan PDF reddedilir', () => {
  const zero = Buffer.from(classic(['A1']).buf.toString('latin1').replace('/Kids [4 0 R] /Count 1', '/Kids [] /Count 0'), 'latin1');
  assert.throws(() => inspectPdf(zero), (e) => e instanceof PdfError && /sayfa bulunamadı/.test(e.message));
});
