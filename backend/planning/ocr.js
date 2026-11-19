/**
 * Taranmış (fotokopi/tarayıcı) PDF sayfaları için Tesseract OCR (bkz. CLAUDE.md §6 "Mail'den otomatik sipariş
 * girişi" > "PDF ayrıştırma": Claude API/LLM DEĞİL, ücretsiz/açık kaynak Tesseract — Setup.exe projenin köküne
 * `runtime\tesseract\` olarak gömer (`optimizer/schedule_solver.py` / `runtime\python\` deseniyle AYNI).
 * Geliştirme makinesinde kurulu değilse / bulunamazsa / başarısız olursa sessizce `null` döner — çağıran
 * (`incoming-orders.js`) eski "taranmış, okunamadı" davranışına düşer.
 *
 * Sayfanın gömülü GÖRÜNTÜSÜ (`pdf-text.js#extractPdfText`'in döndürdüğü `image`: `extractScanImage`'ın seçtiği
 * CCITT Group4 ya da JPEG) bir geçici dosyaya yazılır (CCITT için önce `wrapCcittAsTiff` ile minimal bir TIFF'e
 * sarılır — Tesseract'ın kendi kütüphanesi (Leptonica) G4 bit akışını çözer, biz ÇÖZMEYİZ), tesseract'ın TSV
 * çıktısından KELİME kutuları (bounding box) alınır ve `pdf-text.js#groupRunsIntoLines`/`pdf-table.js
 * #extractOrderTable`'ın beklediği AYNI `runs` ({x,y,size,text}) biçimine çevrilir — İKİNCİ bir tablo ayrıştırıcı
 * YAZILMAZ; OCR'dan gelen metin de aynı sütun-orta-nokta mantığından geçer. `--psm 1` (otomatik sayfa bölümleme +
 * YÖN TESPİTİ) kullanılır: gerçek taranmış belgelerde sayfa/katman 90°/180° döndürülmüş olabilir (gerçek Ayvaz
 * PDF'inde bulundu), `osd.traineddata` bunu kendiliğinden düzeltir.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Setup.exe projenin kokune runtime\tesseract\tesseract.exe olarak gomer (runtime\python\python.exe deseni;
// bkz. schedule.js ve installer/build-installer.ps1). Gelistirmede bu klasor yok, KNOWN_BINS / PATH'e dusulur.
const BUNDLED_TESSERACT = fileURLToPath(new URL('../../runtime/tesseract/tesseract.exe', import.meta.url));
const BUNDLED_TESSDATA = fileURLToPath(new URL('../../runtime/tesseract/tessdata', import.meta.url));

const KNOWN_BINS = Object.freeze([
  'C:\\Program Files\\Tesseract-OCR\\tesseract.exe',
  'C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe',
]);

/** tesseract çalıştırılabilir dosyası: `TESSERACT_BIN` > gömülü (Setup.exe, `runtime\tesseract\`) > bilinen Windows kurulum yerleri > PATH. */
export function tesseractBin() {
  if (process.env.TESSERACT_BIN) return process.env.TESSERACT_BIN;
  if (existsSync(BUNDLED_TESSERACT)) return BUNDLED_TESSERACT;
  for (const p of KNOWN_BINS) { if (existsSync(p)) return p; }
  return 'tesseract';
}

function runOpts(bin, base) {
  // Gomulu Tesseract kullanilirken hedef PC'de sistem genelinde farkli/eski bir TESSDATA_PREFIX tanimli olsa
  // bile kendi yanindaki tessdata'yi (tur+eng+osd) kullansin diye TESSDATA_PREFIX sabitlenir.
  if (bin === BUNDLED_TESSERACT && existsSync(BUNDLED_TESSDATA)) {
    return { ...base, env: { ...process.env, TESSDATA_PREFIX: BUNDLED_TESSDATA } };
  }
  return base;
}

/** tesseract GERÇEKTEN çalışıyor mu (süreci açıp `--version` ile dener). @param {Function} [run] testte sahte çağrı için */
export function tesseractAvailable(run = spawnSync) {
  try {
    const bin = tesseractBin();
    const r = run(bin, ['--version'], runOpts(bin, { timeout: 5000, encoding: 'utf8' }));
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Tesseract'ın TSV çıktısını `runs` biçimine çevirir: yalnız KELİME satırları (level=5), görüntü PİKSEL
 * biriminden sayfanın pt birimine ölçeklenir (mediaBox/görüntü oranı), y PDF'teki gibi YUKARI pozitif olsun
 * diye ters çevrilir (görüntüde y aşağı artar).
 * @param {string} tsv @param {{scaleX:number, scaleY:number, imageHeight:number}} geo
 * @returns {{x:number,y:number,size:null,text:string}[]}
 */
export function parseTsvRuns(tsv, { scaleX, scaleY, imageHeight }) {
  const lines = String(tsv ?? '').split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split('\t');
  const idx = (name) => header.indexOf(name);
  const li = idx('level'); const lefti = idx('left'); const topi = idx('top'); const texti = idx('text');
  if (li < 0 || lefti < 0 || topi < 0 || texti < 0) return [];
  const runs = [];
  for (const line of lines.slice(1)) {
    const cols = line.split('\t');
    if (Number(cols[li]) !== 5) continue; // yalniz KELIME satirlari (1=sayfa, 2=blok, 3=paragraf, 4=satir, 5=kelime)
    const text = (cols[texti] ?? '').trim();
    if (!text) continue;
    const left = Number(cols[lefti]);
    const top = Number(cols[topi]);
    if (!Number.isFinite(left) || !Number.isFinite(top)) continue;
    runs.push({ x: left * scaleX, y: (imageHeight - top) * scaleY, size: null, text });
  }
  return runs;
}

/**
 * Ham CCITTFaxDecode (Group 4, `/K -1`) baytlarını MİNİMAL bir TIFF dosyasına sarar — bit akışının kendisi
 * ÇÖZÜLMEZ (Tesseract'ın Leptonica'sı G4'ü zaten okur), yalnız TIFF başlığı/IFD'si (tek şerit) eklenir.
 * `PhotometricInterpretation`: `blackIs1` doğruysa 0, değilse (varsayılan, PDF'in `BlackIs1=false` öntanımıyla
 * UYUMLU: örnek deger 0 = siyah) 1 (BlackIsZero) — **gerçek taranmış Ayvaz PDF'inin 4 sayfasıyla da DOĞRULANDI**
 * (bkz. CLAUDE.md §6): tesseract tam, okunur Türkçe/İngilizce metin verdi.
 * @param {Buffer} bytes @param {number} width @param {number} height @param {{blackIs1?:boolean}} [opts]
 * @returns {Buffer}
 */
export function wrapCcittAsTiff(bytes, width, height, { blackIs1 = false } = {}) {
  const entries = [
    [256, 4, 1, width], // ImageWidth (LONG)
    [257, 4, 1, height], // ImageLength (LONG)
    [258, 3, 1, 1], // BitsPerSample (SHORT) = 1 (bilevel)
    [259, 3, 1, 4], // Compression (SHORT) = 4 (CCITT Group 4 / T.6)
    [262, 3, 1, blackIs1 ? 0 : 1], // PhotometricInterpretation: blackIs1=false (PDF varsayilani) -> 1=BlackIsZero (orneklenmis 0=siyah)
    [273, 4, 1, 0], // StripOffsets (LONG) - asagida doldurulur
    [277, 3, 1, 1], // SamplesPerPixel (SHORT) = 1
    [278, 4, 1, height], // RowsPerStrip (LONG): tek serit
    [279, 4, 1, bytes.length], // StripByteCounts (LONG)
  ];
  const n = entries.length;
  const ifdOffset = 8;
  const dataOffset = ifdOffset + 2 + n * 12 + 4; // 2 bayt giris sayisi + N*12 bayt giris + 4 bayt "sonraki IFD yok"
  entries[5][3] = dataOffset; // StripOffsets fixup
  const out = Buffer.alloc(dataOffset + bytes.length);
  out.write('II', 0, 'latin1'); // kucuk-endian
  out.writeUInt16LE(42, 2); // TIFF sihirli sayi
  out.writeUInt32LE(ifdOffset, 4);
  out.writeUInt16LE(n, ifdOffset);
  entries.forEach(([tag, type, count, value], i) => {
    const o = ifdOffset + 2 + i * 12;
    out.writeUInt16LE(tag, o);
    out.writeUInt16LE(type, o + 2);
    out.writeUInt32LE(count, o + 4);
    if (type === 3) { out.writeUInt16LE(value, o + 8); out.writeUInt16LE(0, o + 10); } else out.writeUInt32LE(value, o + 8);
  });
  out.writeUInt32LE(0, ifdOffset + 2 + n * 12); // sonraki IFD yok
  bytes.copy(out, dataOffset);
  return out;
}

/**
 * Taranmış bir sayfayı OCR eder; tesseract yoksa/başarısızsa `null` döner (çağıran eski 'scanned' davranışına düşer).
 * @param {{bytes:Buffer,width:number,height:number,format?:('ccitt-g4'|'jpeg'),blackIs1?:boolean}} image @param {number[]|null} mediaBox
 * @param {{run?:Function}} [opts] testte sahte süreç çağrısı için
 * @returns {{x:number,y:number,size:null,text:string}[]|null}
 */
export function ocrPage(image, mediaBox, { run = spawnSync } = {}) {
  if (!image?.bytes || !image.width || !image.height) return null;
  if (!tesseractAvailable(run)) return null;
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), 'cnc-ocr-'));
    const isCcitt = image.format === 'ccitt-g4';
    const imgPath = join(dir, isCcitt ? 'sayfa.tif' : 'sayfa.jpg');
    const outBase = join(dir, 'cikti');
    writeFileSync(imgPath, isCcitt ? wrapCcittAsTiff(image.bytes, image.width, image.height, { blackIs1: image.blackIs1 }) : image.bytes);
    const bin = tesseractBin();
    // --psm 1: otomatik sayfa bolumleme + YON TESPITI (osd.traineddata) - taranmis sayfa/katman dondurulmus olabilir.
    const r = run(bin, [imgPath, outBase, '-l', 'tur+eng', '--psm', '1', 'tsv'], runOpts(bin, { timeout: 30_000, encoding: 'utf8' }));
    if (r.error || r.status !== 0) return null;
    const tsv = readFileSync(`${outBase}.tsv`, 'utf8');
    const pageW = mediaBox ? mediaBox[2] - mediaBox[0] : image.width;
    const pageH = mediaBox ? mediaBox[3] - mediaBox[1] : image.height;
    return parseTsvRuns(tsv, { scaleX: pageW / image.width, scaleY: pageH / image.height, imageHeight: image.height });
  } catch {
    return null;
  } finally {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* gecici dosya, onemli degil */ } }
  }
}
