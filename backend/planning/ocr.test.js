/**
 * Tesseract OCR modulu testleri: GERCEK tesseract hic cagrilmaz (sahte `run` enjekte edilir, `optimizer/
 * schedule_solver.py`'nin Python alt-surec desenindeki AYNI ilke: sahte cagiriyla saf mantik testli, gercek
 * ikili elle/ayrica denenir). Bkz. CLAUDE.md §6 "Mail'den otomatik siparis girisi" - gercek Tesseract'a karsi
 * ayrica, bu makineye kurulup, gercek taranmis Ayvaz PDF'iyle denendi (testte DEGIL).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { parseTsvRuns, tesseractBin, tesseractAvailable, ocrPage, wrapCcittAsTiff } from './ocr.js';

const TSV_HEADER = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';

test('parseTsvRuns: yalniz KELIME (level=5) satirlari alinir, piksel -> pt olceklenir, y ters cevrilir', () => {
  const tsv = [
    TSV_HEADER,
    '1\t1\t0\t0\t0\t0\t0\t0\t400\t300\t-1\t', // sayfa satiri: atlanir
    '4\t1\t1\t1\t1\t0\t10\t20\t100\t15\t-1\t', // satir satiri: atlanir
    '5\t1\t1\t1\t1\t1\t10\t20\t40\t15\t92.5\tMERHABA',
    '5\t1\t1\t1\t1\t2\t60\t22\t30\t14\t88\tDUNYA',
  ].join('\n');
  const runs = parseTsvRuns(tsv, { scaleX: 2, scaleY: 2, imageHeight: 300 });
  assert.deepEqual(runs, [
    { x: 20, y: (300 - 20) * 2, size: null, text: 'MERHABA' },
    { x: 120, y: (300 - 22) * 2, size: null, text: 'DUNYA' },
  ]);
});

test('parseTsvRuns: bos/bosluklu metinli kelime satirlari atlanir', () => {
  const tsv = [TSV_HEADER, '5\t1\t1\t1\t1\t1\t0\t0\t10\t10\t95\t   ', '5\t1\t1\t1\t1\t2\t0\t0\t10\t10\t95\t'].join('\n');
  assert.deepEqual(parseTsvRuns(tsv, { scaleX: 1, scaleY: 1, imageHeight: 10 }), []);
});

test('parseTsvRuns: bos tsv ya da beklenen basliklar yoksa []', () => {
  assert.deepEqual(parseTsvRuns('', { scaleX: 1, scaleY: 1, imageHeight: 10 }), []);
  assert.deepEqual(parseTsvRuns('foo\tbar\n5\t1\t2', { scaleX: 1, scaleY: 1, imageHeight: 10 }), []);
});

test('tesseractAvailable: calisan surec true, hata/sifir-disi durum false', () => {
  assert.equal(tesseractAvailable(() => ({ status: 0 })), true);
  assert.equal(tesseractAvailable(() => ({ status: 1 })), false);
  assert.equal(tesseractAvailable(() => ({ status: 0, error: new Error('bulunamadi') })), false);
  assert.equal(tesseractAvailable(() => { throw new Error('patladi'); }), false);
});

test('tesseractBin: TESSERACT_BIN ortam degiskenini oncelikli alir', () => {
  const prev = process.env.TESSERACT_BIN;
  try {
    process.env.TESSERACT_BIN = 'C:\\ozel\\tesseract.exe';
    assert.equal(tesseractBin(), 'C:\\ozel\\tesseract.exe');
    delete process.env.TESSERACT_BIN;
    assert.ok(tesseractBin().length > 0);
  } finally {
    if (prev === undefined) delete process.env.TESSERACT_BIN; else process.env.TESSERACT_BIN = prev;
  }
});

test('ocrPage: goruntu baytlari/boyutu yoksa surec hic cagrilmadan null doner', () => {
  let calls = 0;
  const run = () => { calls += 1; return { status: 0 }; };
  assert.equal(ocrPage(null, null, { run }), null);
  assert.equal(ocrPage({ bytes: Buffer.from('x'), width: 0, height: 10 }, null, { run }), null);
  assert.equal(calls, 0);
});

test('ocrPage: tesseract kurulu degil (--version basarisiz) -> null, gercek OCR cagrisi hic yapilmaz', () => {
  let ocrCalled = false;
  const run = (bin, args) => {
    if (args[0] === '--version') return { status: 1 };
    ocrCalled = true;
    return { status: 0 };
  };
  const image = { bytes: Buffer.from('jpegbaytlari'), width: 100, height: 100 };
  assert.equal(ocrPage(image, [0, 0, 200, 200], { run }), null);
  assert.equal(ocrCalled, false);
});

test('ocrPage: OCR sureci basarisiz (status!=0) -> null', () => {
  const run = (bin, args) => (args[0] === '--version' ? { status: 0 } : { status: 1 });
  const image = { bytes: Buffer.from('jpegbaytlari'), width: 100, height: 100 };
  assert.equal(ocrPage(image, null, { run }), null);
});

/** Gercek disk I/O'yu taklit eder: '--version' cagrisinda basarili doner, gercek OCR cagrisinda
 * `run`'a verilen `outBase` yoluna (args[1]) sahte bir TSV dosyasi yazar - `ocrPage` bunu okur. */
function fakeRun(tsvContent) {
  return (bin, args) => {
    if (args[0] === '--version') return { status: 0 };
    const outBase = args[1];
    writeFileSync(`${outBase}.tsv`, tsvContent, 'utf8');
    return { status: 0 };
  };
}

test('ocrPage: uctan uca (sahte run) - goruntuyu gecici dosyaya yazar, TSV\'yi okur, mediaBox oranina gore olcekler', () => {
  const tsv = [TSV_HEADER, '5\t1\t1\t1\t1\t1\t100\t200\t50\t20\t90\tSIPARIS'].join('\n');
  const image = { bytes: Buffer.from('sahte-jpeg-baytlari'), width: 1000, height: 2000 };
  const mediaBox = [0, 0, 500, 1000]; // goruntunun yarisi boyutunda sayfa -> scale=0.5
  const runs = ocrPage(image, mediaBox, { run: fakeRun(tsv) });
  assert.deepEqual(runs, [{ x: 50, y: (2000 - 200) * 0.5, text: 'SIPARIS', size: null }]);
});

test('ocrPage: mediaBox yoksa goruntu boyutunun kendisi kullanilir (scale=1)', () => {
  const tsv = [TSV_HEADER, '5\t1\t1\t1\t1\t1\t10\t10\t10\t10\t90\tX'].join('\n');
  const image = { bytes: Buffer.from('b'), width: 300, height: 400 };
  const runs = ocrPage(image, null, { run: fakeRun(tsv) });
  assert.deepEqual(runs, [{ x: 10, y: 400 - 10, text: 'X', size: null }]);
});

/* ============================================================================================== wrapCcittAsTiff */

test('wrapCcittAsTiff: gecerli minimal TIFF uretir (header, IFD etiketleri, veri konumu/uzunlugu dogru)', () => {
  const bytes = Buffer.from('ccitt-ornek-baytlari');
  const tiff = wrapCcittAsTiff(bytes, 123, 456, { blackIs1: false });
  assert.equal(tiff.toString('latin1', 0, 2), 'II'); // kucuk-endian
  assert.equal(tiff.readUInt16LE(2), 42); // TIFF sihirli sayi
  const ifdOffset = tiff.readUInt32LE(4);
  assert.equal(ifdOffset, 8);
  const n = tiff.readUInt16LE(ifdOffset);
  assert.equal(n, 9);
  const tags = {};
  for (let i = 0; i < n; i += 1) {
    const o = ifdOffset + 2 + i * 12;
    tags[tiff.readUInt16LE(o)] = tiff.readUInt32LE(o + 8);
  }
  assert.equal(tags[256], 123); // ImageWidth
  assert.equal(tags[257], 456); // ImageLength
  assert.equal(tags[258], 1); // BitsPerSample
  assert.equal(tags[259], 4); // Compression = Group4
  assert.equal(tags[262], 1); // PhotometricInterpretation: blackIs1=false -> BlackIsZero
  assert.equal(tags[277], 1); // SamplesPerPixel
  assert.equal(tags[278], 456); // RowsPerStrip = tek serit
  assert.equal(tags[279], bytes.length); // StripByteCounts
  const stripOffset = tags[273];
  assert.deepEqual(tiff.subarray(stripOffset, stripOffset + bytes.length), bytes); // veri aynen ve dogru yerde
  assert.equal(tiff.readUInt32LE(ifdOffset + 2 + n * 12), 0); // sonraki IFD yok
  assert.equal(tiff.length, stripOffset + bytes.length); // dosyada fazladan bayt yok
});

test('wrapCcittAsTiff: blackIs1=true -> PhotometricInterpretation=0 (WhiteIsZero)', () => {
  const tiff = wrapCcittAsTiff(Buffer.from('x'), 1, 1, { blackIs1: true });
  const ifdOffset = tiff.readUInt32LE(4);
  const n = tiff.readUInt16LE(ifdOffset);
  let photometric;
  for (let i = 0; i < n; i += 1) {
    const o = ifdOffset + 2 + i * 12;
    if (tiff.readUInt16LE(o) === 262) photometric = tiff.readUInt16LE(o + 8);
  }
  assert.equal(photometric, 0);
});

test('ocrPage: image.format="ccitt-g4" -> TIFF\'e sarilip .tif dosyasina yazilir, -l tur+eng --psm 1 ile cagrilir', () => {
  const tsv = [TSV_HEADER, '5\t1\t1\t1\t1\t1\t5\t5\t10\t10\t90\tMETIN'].join('\n');
  let seenArgs = null;
  let writtenTiff = null;
  const run = (bin, args) => {
    if (args[0] === '--version') return { status: 0 };
    seenArgs = args;
    writtenTiff = readFileSync(args[0]);
    writeFileSync(`${args[1]}.tsv`, tsv, 'utf8');
    return { status: 0 };
  };
  const image = { bytes: Buffer.from('ccittbaytlari'), width: 10, height: 10, format: 'ccitt-g4', blackIs1: false };
  const runs = ocrPage(image, null, { run });
  assert.ok(seenArgs[0].endsWith('.tif'), 'CCITT icin .tif uzantili gecici dosya yazildi (.jpg degil)');
  assert.ok(seenArgs.includes('-l') && seenArgs.includes('tur+eng'), 'Turkce+Ingilizce dil paketi kullanildi');
  assert.ok(seenArgs.includes('--psm') && seenArgs.includes('1'), 'otomatik yon tespiti (--psm 1) kullanildi');
  // yazilan dosya GERCEKTEN kendi wrapCcittAsTiff'imizle AYNI (bagimsiz uretilip kiyaslanir)
  assert.deepEqual(writtenTiff, wrapCcittAsTiff(image.bytes, image.width, image.height, { blackIs1: false }));
  assert.deepEqual(runs, [{ x: 5, y: (10 - 5), text: 'METIN', size: null }]);
});
