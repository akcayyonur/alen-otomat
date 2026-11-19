/**
 * PDF'ten DÜZ METİN + KONUM çıkarma (mail'den gelen sipariş PDF'lerini okumak için, §6 "Mail'den otomatik
 * sipariş girişi"). PDF nesne modelini (xref/xref akışı/nesne akışı, bozuk dosyada onarma) ve akış çözmeyi
 * (Flate + PNG öngörücü) `backend/pdf-merge.js`'ten AYNEN kullanır — ikinci bir PDF ayrıştırıcı YAZILMAZ.
 *
 * Ne yapar: her sayfanın içerik akışındaki metin gösterme komutlarını (q/Q/cm, BT/ET, Tf, Tm/Td/TD, Tj/TJ)
 * izler, her metin parçasını (sayfa üzerindeki GERÇEK x,y — grafik dönüşüm matrisiyle birlikte — font
 * boyutu, metin) olarak toplar. Kod -> Unicode çevirisi için ÖNCE fontun `/ToUnicode` akışını (bfchar/
 * bfrange) dener; yoksa basit (CID olmayan) bir fontta `/Encoding /WinAnsiEncoding` (ya da hiç belirtilmemiş,
 * PDF'in güvenli varsayılanı) ise standart WinAnsi (CP1252) tablosuna düşer. Bu ikisi birlikte gerçek
 * örneklerin BÜYÜK ÇOĞUNLUĞUNU kapsadı: Siamp (iText, ToUnicode), Ayvaz-HaVana (tarayıcı "PDF olarak
 * yazdır", ToUnicode + `cm` ile konumlanmış metin) VE ilk bakışta "çözülemez" görünen Konveyör (Adobe
 * LiveCycle: gövde metni ToUnicode'suz `/WinAnsiEncoding`, yalnız birkaç Türkçe harf ayrı küçük bir CID
 * fontla — WinAnsi geri düşümü sayesinde ikisi de okunuyor).
 *
 * BİLEREK YAPILMAYAN (kapsam dışı, gerçek örneklerde görülüp belgelenen sınırlar):
 *   - Gömülü (altyapısı ne ToUnicode ne WinAnsi/Standard olan) bir CID fontla yazılmış metin ÇÖZÜLEMEZ
 *     — sayfa `unreadable:'no-cmap'` ile döner. Harfleri doğru çözmek, gömülü CFF/TrueType fontun kendi
 *     glyph-ad tablosunu (charset) ayrıştırıp Adobe Glyph List üzerinden Unicode'a çevirmeyi gerektirir;
 *     bu BİLİNÇLİ OLARAK ertelendi (4 gerçek örnekten hiçbirinde bu durumla karşılaşılmadı).
 *   - TARANMIŞ sayfalar (gerçek örnek: Canon fotokopi/tarayıcıdan gelen Ayvaz siparişi) hiç metin
 *     İÇERMEZ — yalnız görüntü. Bu modül metin arar; göremezse `unreadable:'scanned'` ile döner, VE sayfadaki
 *     en uygun gömülü görüntüyü (`image`: CCITT Group4 ya da DCT/JPEG, `extractScanImage`) çıkarır — gerçek
 *     içeriği OCR ile okuyan AYRI modül (`ocr.js`) bunu kullanır. **Gerçek bulgu:** bu tarayıcı iki katmanlı
 *     (MRC) sıkıştırma kullanıyor — düşük çözünürlüklü bulanık bir JPEG "arka plan" + yüksek çözünürlüklü
 *     keskin CCITT Group4 "metin" katmanı; `extractScanImage` ALAN olarak büyük olanı (gerçek örnekte hep
 *     CCITT) seçer, CLAUDE.md §6'daki ilk tahmin ("yalnız JPEG yeter") bu yüzden YANLIŞTI.
 *   - İçi gömülü görüntü (inline image, `BI...ID...EI`) olan içerik akışları desteklenmez: görüldüğü
 *     anda o sayfadaki metin toplama durur (daha önce toplanan metin KAYBOLMAZ, yalnız eksik kalabilir).
 *     Gerçek örneklerde görüntüler hep XObject (`/…Do`) ile çizildi, inline image görülmedi.
 *   - Metin matrisinin (Tm) ve grafik dönüşüm matrisinin (cm) DÖNME/EĞİKLİK bileşenleri konum hesabına
 *     katılır (nokta dönüşümü doğru) ama tek tek karakterin KENDİ genişliği/dönmesi hesaba katılmaz —
 *     faturalarda metin hep yatay, gerçek örneklerle doğrulandı.
 *   - Sözcük/hücre ayrımı (boşluk nereye konur, hangi karakterler aynı tablo hücresinde) font genişlik
 *     tablosu (örn. `/Widths`) OLMADAN güvenilir değildir (gerçek Ayvaz örneğiyle ölçüldü: harf arası ve
 *     sözcük arası boşluk aynı büyüklükte çıkabiliyor) — bu modül yalnız SATIR sırasını ve satır içi X
 *     sırasını verir (`groupRunsIntoLines`), sözcük/sütun ayrımı YAPMAZ; bu, ayrı bir modülün işi.
 */
import { inflateSync } from 'node:zlib';
import { openForText, Lexer, Kw, Name, nameOf } from '../pdf-merge.js';

export class PdfTextError extends Error {}

/* ============================================================== ToUnicode CMap (bfchar / bfrange) */

/** `<XXXX>` türü hex dizgisini UTF-16BE kod birimleri olarak çözer (her 4 hex hane bir kod birimi). */
function hexToUtf16(hex) {
  const h = hex.length % 4 === 0 ? hex : hex.padStart(hex.length + (4 - (hex.length % 4)), '0');
  let out = '';
  for (let i = 0; i < h.length; i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
  return out;
}

/**
 * ToUnicode akışının (CMap, bir PostScript lehçesi) `beginbfchar…endbfchar` ve `beginbfrange…endbfrange`
 * bloklarını ayrıştırır. @param {Buffer} bytes @returns {Map<number, string>} kod (tam sayı) -> Unicode metin
 */
export function parseToUnicodeCMap(bytes) {
  const text = bytes.toString('latin1');
  const map = new Map();
  const hexTok = /<([0-9a-fA-F]+)>/g;

  for (const m of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    const toks = [...m[1].matchAll(hexTok)].map((t) => t[1]);
    for (let i = 0; i + 1 < toks.length; i += 2) map.set(parseInt(toks[i], 16), hexToUtf16(toks[i + 1]));
  }

  const entryRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F]+>)/g;
  for (const m of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const e of m[1].matchAll(entryRe)) {
      const lo = parseInt(e[1], 16);
      const hi = parseInt(e[2], 16);
      if (hi < lo || hi - lo > 65536) continue; // bozuk aralık: atla
      if (e[3][0] === '[') {
        const arr = [...e[3].matchAll(hexTok)].map((x) => hexToUtf16(x[1]));
        for (let c = lo, i = 0; c <= hi && i < arr.length; c += 1, i += 1) map.set(c, arr[i]);
      } else {
        const dstHex = e[3].slice(1, -1);
        const dstBase = parseInt(dstHex, 16);
        for (let c = lo; c <= hi; c += 1) map.set(c, hexToUtf16((dstBase + (c - lo)).toString(16).padStart(dstHex.length, '0')));
      }
    }
  }
  return map;
}

/* ===================================================================================== font çözümü */

/**
 * WinAnsiEncoding (= Windows-1252/CP1252; PDF Ek D) — 0x20-0x7E ve 0xA0-0xFF ASCII/Latin-1 ile birebir,
 * yalnız 0x80-0x9F özel ("akıllı tırnak", tire…) karakterler taşır. Gömülü/özel kodlamalı değil, STANDART
 * (fontu üreten araç tanımlamamış) basit fontlarda ToUnicode akışı olmadan metni çözmenin tek yolu budur
 * — gerçek örnekle doğrulandı (Konveyör siparişi: `FontDescriptor` yok = gömülü değil, adı `/WinAnsiEncoding`).
 */
const WIN_ANSI_HIGH = new Map([
  [0x80, 0x20AC], [0x82, 0x201A], [0x83, 0x0192], [0x84, 0x201E], [0x85, 0x2026], [0x86, 0x2020], [0x87, 0x2021],
  [0x88, 0x02C6], [0x89, 0x2030], [0x8A, 0x0160], [0x8B, 0x2039], [0x8C, 0x0152], [0x8E, 0x017D], [0x91, 0x2018],
  [0x92, 0x2019], [0x93, 0x201C], [0x94, 0x201D], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014], [0x98, 0x02DC],
  [0x99, 0x2122], [0x9A, 0x0161], [0x9B, 0x203A], [0x9C, 0x0153], [0x9E, 0x017E], [0x9F, 0x0178],
]);
function winAnsiMap() {
  const m = new Map();
  for (let c = 0x20; c <= 0x7E; c += 1) m.set(c, String.fromCharCode(c));
  for (let c = 0xA0; c <= 0xFF; c += 1) m.set(c, String.fromCharCode(c));
  for (const [c, u] of WIN_ANSI_HIGH) m.set(c, String.fromCharCode(u));
  return m;
}

/**
 * Sayfanın `/Resources /Font` sözlüğündeki her fontu çözer: kaç baytlık kod kullandığı (basit font 1,
 * Type0/CID font 2 — Identity-H/V varsayılır, gerçek örneklerle doğrulandı) ve kod -> Unicode haritası.
 * Öncelik: `/ToUnicode` akışı varsa o kullanılır (en güvenilir). Yoksa, basit fontta `/Encoding` açıkça
 * `/WinAnsiEncoding` ise (ya da hiç verilmemişse — PDF'te varsayılan, çoğu basit font için güvenli) standart
 * WinAnsi tablosu kullanılır. **`/Differences` (ad bazlı tekil geçersiz kılma) YOK SAYILIR** — bilinçli
 * sınırlama: yalnız o birkaç kod yanlış/boş çözülür, geri kalan metin etkilenmez.
 * @returns {Map<string, {byteWidth: number, cmap: (Map<number,string>|null)}>}
 */
function resolveFonts(fontsDict, resolve, decode) {
  const out = new Map();
  if (!(fontsDict instanceof Map)) return out;
  for (const [name, ref] of fontsDict) {
    const dict = resolve(ref);
    if (!(dict instanceof Map)) continue;
    const subtype = nameOf(resolve(dict.get('Subtype')));
    const byteWidth = subtype === 'Type0' ? 2 : 1;
    const tu = dict.get('ToUnicode');
    const bytes = tu !== undefined ? decode(tu) : null;
    let cmap = bytes ? parseToUnicodeCMap(bytes) : null;
    if (!cmap && byteWidth === 1) {
      const enc = resolve(dict.get('Encoding'));
      const baseEnc = enc instanceof Map ? nameOf(resolve(enc.get('BaseEncoding'))) : nameOf(enc);
      if (enc === undefined || baseEnc === 'WinAnsiEncoding') cmap = winAnsiMap();
    }
    out.set(name, { byteWidth, cmap });
  }
  return out;
}

/** Bir metin parçasını (Tj/TJ'den gelen ham bayt) geçerli fontla Unicode'a çevirir; font/harita yoksa `null`. */
function decodeRun(bytes, font) {
  if (!font || !font.cmap) return null;
  let out = '';
  for (let i = 0; i + font.byteWidth <= bytes.length; i += font.byteWidth) {
    let code = 0;
    for (let k = 0; k < font.byteWidth; k += 1) code = code * 256 + bytes[i + k];
    const ch = font.cmap.get(code);
    if (ch !== undefined) out += ch;
  }
  return out;
}

/* ===================================================================================== içerik akışı */

const IDENTITY = [1, 0, 0, 1, 0, 0];
/** PDF matris çarpımı: A önce, sonra B uygulanmış gibi (satır-vektör kuralı). */
function matMul(a, b) {
  return [
    a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}
/** Bir noktayı (yalnız öteleme/ölçek/eğiklik; dönme açısı yok sayılır, bkz. dosya başındaki not) matrisle dönüştürür. */
function transformPoint(px, py, m) { return [px * m[0] + py * m[2] + m[4], px * m[1] + py * m[3] + m[5]]; }

/**
 * İçerik akışındaki metin gösterme komutlarını izler. `Lexer.value()` PDF'in genel değer dilbilgisini
 * (sayı/dizgi/ad/dizi) okur; bilinmeyen bir sözcük (operatör, ör. "Tj") `Kw` olarak döner — bu yüzden
 * ayrı bir "içerik akışı sözcük çözümleyici" YAZILMADI, aynı Lexer kullanılır.
 * **`cm` (grafik dönüşüm matrisi, `q`/`Q` ile yığınlanır) izlenir** — bazı PDF üreticileri (ör. tarayıcı
 * "PDF olarak yazdır") metnin gerçek sayfa konumunu doğrudan Tm'de değil `cm` ile verir; bu izlenmezse
 * metin doğru çözülse bile SATIR/SÜTUN konumu KARIŞIR (gerçek Ayvaz/Konveyör örnekleriyle bulundu).
 * @param {Buffer} contentBytes @param {Map<string, {byteWidth:number, cmap:(Map|null)}>} fonts
 * @returns {{runs: {x:number, y:number, size:number, text:(string|null)}[]}}
 */
function walkContent(contentBytes, fonts) {
  const lx = new Lexer(contentBytes, 0);
  const runs = [];
  let stack = [];
  let font = null;
  let fontSize = 0;
  let tx = 0; // Tm'nin öteleme bileşeni (e,f) — dönme/ölçek yok sayılır, bkz. dosya başı
  let ty = 0;
  let ctm = IDENTITY; // q/Q ile yığınlanan grafik dönüşüm matrisi
  const gsStack = [];

  const pushRun = (text) => {
    const [px, py] = transformPoint(tx, ty, ctm);
    if (text !== '') runs.push({ x: px, y: py, size: fontSize, text: text === null ? null : text });
  };

  for (;;) {
    lx.skipWs();
    if (lx.p >= contentBytes.length) break;
    let v;
    try { v = lx.value(); } catch { break; } // içi gömülü görüntü (BI/ID/EI) gibi dilbilgisi dışı içerik: dur
    if (!(v instanceof Kw)) { stack.push(v); continue; }
    const op = v.word;
    switch (op) {
      case 'q':
        gsStack.push(ctm);
        break;
      case 'Q':
        if (gsStack.length) ctm = gsStack.pop();
        break;
      case 'cm':
        if (stack.length >= 6) ctm = matMul(stack.slice(-6), ctm);
        break;
      case 'BT':
        tx = 0; ty = 0; // metin matrisi BT'de KİMLİK'e döner (önceki bloktan miras kalmaz)
        break;
      case 'Tf':
        if (stack.length >= 2 && stack[stack.length - 2] instanceof Name) {
          font = fonts.get(stack[stack.length - 2].name) ?? null;
          fontSize = typeof stack[stack.length - 1] === 'number' ? stack[stack.length - 1] : fontSize;
        }
        break;
      case 'Tm':
        if (stack.length >= 6) { tx = stack[stack.length - 2]; ty = stack[stack.length - 1]; }
        break;
      case 'Td':
      case 'TD':
        if (stack.length >= 2) { tx += stack[stack.length - 2]; ty += stack[stack.length - 1]; }
        break;
      case 'Tj':
        if (stack.length >= 1 && stack[stack.length - 1]?.bytes) pushRun(decodeRun(stack[stack.length - 1].bytes, font));
        break;
      case 'TJ':
        if (stack.length >= 1 && Array.isArray(stack[stack.length - 1])) {
          let combined = font && font.cmap ? '' : null;
          let sawAny = false;
          for (const el of stack[stack.length - 1]) {
            if (el?.bytes) { sawAny = true; const d = decodeRun(el.bytes, font); if (combined !== null) combined += d ?? ''; }
          }
          if (sawAny) pushRun(combined);
        }
        break;
      default:
        break;
    }
    stack = [];
  }
  return { runs };
}

/* ===================================================================================== sayfa / belge */

/** Herhangi bir goruntu XObject'i var mi (taranmis sayfa tespiti - TUM alt turler, OCR desteklemese de). @returns {boolean} */
function hasImageXObjects(resources, resolve) {
  const xo = resolve(resources?.get('XObject'));
  if (!(xo instanceof Map)) return false;
  for (const ref of xo.values()) {
    const obj = resolve(ref);
    const dict = obj?.dict instanceof Map ? obj.dict : null;
    if (dict && nameOf(resolve(dict.get('Subtype'))) === 'Image') return true;
  }
  return false;
}

/**
 * Sayfadaki en büyük DCTDecode (JPEG) görüntüsünü döndürür. PDF'te DCTDecode'un KENDİSİ JPEG dosya
 * baytlarıdır, ek çözme GEREKMEZ (`stream.raw` doğrudan kullanılır; `pdf-merge.js#decodeStream` DCTDecode'u
 * reddeder — o fonksiyon yalnız Flate içindir). **Gerçek taranmış bir PDF'te (Ayvaz/Canon) bulundu:** tek
 * filtre değil, `[/FlateDecode /DCTDecode]` da görülüyor (bazı tarayıcılar JPEG baytını AYRICA deflate ile
 * sıkıştırıyor) — bu durumda önce inflate edilir, sonuç JPEG baytıdır (predictor YOK: çözülen şey ham piksel
 * değil, kendisi sıkıştırılmış bir JPEG akışı).
 * @returns {{bytes:Buffer, width:number, height:number}|null}
 */
function extractDctImage(resources, resolve) {
  const xo = resolve(resources?.get('XObject'));
  if (!(xo instanceof Map)) return null;
  let best = null;
  for (const ref of xo.values()) {
    const obj = resolve(ref);
    const dict = obj?.dict instanceof Map ? obj.dict : null;
    if (!dict || nameOf(resolve(dict.get('Subtype'))) !== 'Image') continue;
    let filter = resolve(dict.get('Filter'));
    filter = filter === undefined || filter === null ? [] : Array.isArray(filter) ? filter : [filter];
    const names = filter.map((f) => nameOf(resolve(f)));
    let bytes = null;
    if (names.length === 1 && names[0] === 'DCTDecode') bytes = obj.raw;
    else if (names.length === 2 && names[0] === 'FlateDecode' && names[1] === 'DCTDecode') {
      try { bytes = inflateSync(obj.raw); } catch { continue; }
    } else continue;
    const width = resolve(dict.get('Width'));
    const height = resolve(dict.get('Height'));
    if (!width || !height || !bytes) continue;
    if (!best || width * height > best.width * best.height) best = { bytes, width, height };
  }
  return best;
}

/**
 * Sayfadaki en büyük CCITTFaxDecode (Group 4, `/K -1`) görüntüsünü döndürür — ham, SIKIŞTIRILMIŞ bitleriyle
 * (Tesseract/Leptonica'nın kendisi çözsün diye bir TIFF'e sarılacak, bkz. `ocr.js#wrapCcittAsTiff`; burada
 * bit-akışı ÇÖZÜLMEZ). `BlackIs1` (DecodeParms, vars. `false`) ile birlikte döner — TIFF'e sarılırken hangi
 * bitin "mürekkep" (koyu) olduğunu belirler. Yalnız Group 4 (`/K` negatif) desteklenir; Group 3 (`/K>=0`)
 * gerçek örneklerde görülmedi, bilinçli olarak atlanır.
 * @returns {{bytes:Buffer, width:number, height:number, blackIs1:boolean}|null}
 */
function extractCcittImage(resources, resolve) {
  const xo = resolve(resources?.get('XObject'));
  if (!(xo instanceof Map)) return null;
  let best = null;
  for (const ref of xo.values()) {
    const obj = resolve(ref);
    const dict = obj?.dict instanceof Map ? obj.dict : null;
    if (!dict || nameOf(resolve(dict.get('Subtype'))) !== 'Image') continue;
    let filter = resolve(dict.get('Filter'));
    filter = filter === undefined || filter === null ? [] : Array.isArray(filter) ? filter : [filter];
    if (filter.length !== 1 || nameOf(resolve(filter[0])) !== 'CCITTFaxDecode') continue;
    let parms = resolve(dict.get('DecodeParms'));
    parms = Array.isArray(parms) ? resolve(parms[0]) : parms;
    const k = parms instanceof Map ? resolve(parms.get('K')) : undefined;
    if (!(typeof k === 'number' && k < 0)) continue; // yalniz Group 4 (K<0); Group 3 gercek ornekte gorulmedi
    const blackIs1 = parms instanceof Map ? resolve(parms.get('BlackIs1')) === true : false;
    const width = resolve(dict.get('Width'));
    const height = resolve(dict.get('Height'));
    if (!width || !height || !obj.raw) continue;
    if (!best || width * height > best.width * best.height) best = { bytes: obj.raw, width, height, blackIs1 };
  }
  return best;
}

/**
 * Sayfadaki OCR'a en uygun gömülü görüntüyü seçer: CCITT (Group 4) ile DCT (JPEG) adaylarından ALAN olarak
 * BÜYÜK OLANI. **Gerçek taranmış bir PDF'te (Ayvaz/Canon) bulundu, CLAUDE.md §6'daki ilk tahmin YANLIŞTI:**
 * bu tarayıcı iki KATMAN üretiyor — düşük çözünürlüklü (ör. 1240×1753) griton bir "arka plan" JPEG'i (metin
 * OKUNAMAYACAK kadar bulanık) VE yüksek çözünürlüklü (ör. 2096×3152) keskin, bilevel bir CCITT Group 4 "metin"
 * katmanı (MRC/mixed-raster-content sıkıştırma tekniği). CCITT katmanı GERÇEK OCR'da (4 sayfa, tesseract
 * `--psm 1 -l tur+eng`) tam okunur Türkçe/İngilizce metin verdi; JPEG katmanı yalnız gürültü verdi. Alan
 * karşılaştırması bunu doğru seçer (gerçek 4 sayfada da CCITT adayı her zaman DCT adayından büyük çıktı).
 * @returns {{bytes:Buffer, width:number, height:number, format:('ccitt-g4'|'jpeg'), blackIs1:boolean}|null}
 */
function extractScanImage(resources, resolve) {
  const ccitt = extractCcittImage(resources, resolve);
  const dct = extractDctImage(resources, resolve);
  if (!ccitt && !dct) return null;
  if (ccitt && (!dct || ccitt.width * ccitt.height >= dct.width * dct.height)) {
    return { bytes: ccitt.bytes, width: ccitt.width, height: ccitt.height, format: 'ccitt-g4', blackIs1: ccitt.blackIs1 };
  }
  return { bytes: dct.bytes, width: dct.width, height: dct.height, format: 'jpeg', blackIs1: false };
}

/**
 * Bir PDF'in her sayfasından metin parçalarını (konumlu) çıkarır.
 * @param {Buffer} buf
 * @returns {{pages: {index:number, mediaBox:(number[]|null), runs:{x:number,y:number,size:number,text:(string|null)}[], unreadable:(string|null), image:({bytes:Buffer,width:number,height:number,format:('ccitt-g4'|'jpeg'),blackIs1:boolean}|null)}[]}}
 */
export function extractPdfText(buf) {
  let doc;
  try { doc = openForText(buf); } catch (err) { throw new PdfTextError(err.message); }
  const pages = doc.pages.map((page, index) => {
    const resources = doc.resolve(page.get('Resources'));
    const fontsDict = doc.resolve(resources?.get('Font'));
    const fonts = resolveFonts(fontsDict, doc.resolve, doc.decode);
    let contents = doc.resolve(page.get('Contents'));
    contents = Array.isArray(contents) ? contents : contents === undefined || contents === null ? [] : [contents];
    const parts = contents.map((c) => doc.decode(c)).filter(Boolean);
    const contentBytes = parts.length ? Buffer.concat(parts.flatMap((p, i) => (i > 0 ? [Buffer.from('\n'), p] : [p]))) : Buffer.alloc(0);
    const { runs } = walkContent(contentBytes, fonts);
    const box = doc.resolve(page.get('MediaBox'));
    const mediaBox = Array.isArray(box) ? box.map((v) => doc.resolve(v)) : null;

    const readableChars = runs.reduce((n, r) => n + (r.text ? r.text.length : 0), 0);
    const hadTextCommands = runs.length > 0;
    let unreadable = null;
    let image = null;
    if (!hadTextCommands && hasImageXObjects(resources, doc.resolve)) {
      unreadable = 'scanned';
      image = extractScanImage(resources, doc.resolve); // null olabilir (desteklenmeyen filtre): OCR o zaman denenmez
    } else if (hadTextCommands && readableChars === 0) unreadable = 'no-cmap';

    return { index, mediaBox, runs, unreadable, image };
  });
  return { pages };
}

/**
 * Konum bilgisiyle gelen metin parçalarını okunabilir SATIRLARA gruplar (aynı Y — birkaç punto toleransla —
 * aynı satır sayılır, satır içinde X'e göre soldan sağa sıralanır). Tablo yapısını (sütun) BİLMEZ; yalnız
 * "bu sayfada hangi metin hangi satırda, nerede" sorusuna cevap verir — sütunlara ayırma/müşteri eşleme
 * ayrı bir modülün (ör. `incoming-orders.js`, henüz yazılmadı) işi.
 * @param {{x:number,y:number,size:number,text:(string|null)}[]} runs @param {number} [tolerance]
 * @returns {{y:number, cells:{x:number,text:string}[]}[]} Y'ye göre YUKARIDAN AŞAĞIYA (PDF'te y küçülür) sıralı
 */
export function groupRunsIntoLines(runs, tolerance = 2.5) {
  const usable = runs.filter((r) => r.text);
  const sorted = [...usable].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const r of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - r.y) <= tolerance) last.cells.push({ x: r.x, text: r.text });
    else lines.push({ y: r.y, cells: [{ x: r.x, text: r.text }] });
  }
  for (const line of lines) line.cells.sort((a, b) => a.x - b.x);
  return lines;
}
