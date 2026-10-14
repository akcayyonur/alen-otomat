/**
 * Bağımlılıksız PDF BİRLEŞTİRİCİ (teknik resimlerin iş emri formunun arka sayfasında alt alta çıkması için).
 *
 * Ne yapar: verilen PDF dosyalarının SAYFALARINI sırayla tek bir PDF'te toplar. Sayfaların içeriği (çizim, yazı tipi, görsel) AYNEN taşınır; yeniden
 * çizilmez, sıkıştırması bozulmaz. Okunan: klasik çapraz başvuru (xref) tablosu, xref akışı, nesne akışları (ObjStm), artımlı güncellemeler (/Prev),
 * hibrit dosyalar ve bozuk/eksik xref (dosya taranıp onarılır). Yazılan: tüm nesneleri açık yazan, klasik xref'li, sade bir PDF.
 *
 * Bilerek yapılmayanlar:
 *   - ŞİFRELİ PDF birleştirilmez (hata verir: şifreyi kaldırıp yeniden kaydedin).
 *   - Sayfa ek açıklamaları (/Annots: bağlantılar, form alanları, yorumlar) taşınmaz; teknik resimde baskıda görünen çizim içeriği taşınır.
 *   - Bölünmüş (iki sayfayı bir kâğıda sığdırma) yoktur: sayfalar art arda eklenir (görüntüleyicide alt alta görünür).
 *   - Yalnız Flate (zlib) sıkıştırmalı xref/nesne akışları okunur; sayfa içerikleri her filtreyle aynen taşınır.
 */
import { inflateSync, constants as zc } from 'node:zlib';

export class PdfError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'PdfError';
    this.status = 400;
  }
}

/** Tek dosyada en çok sayfa (çok büyük/bozuk dosyaya karşı sınır). */
export const MAX_PAGES_PER_FILE = 500;

/* ===================================================================== değer türleri */

class Name { constructor(name) { this.name = name; } }
class Ref { constructor(num, gen = 0) { this.num = num; this.gen = gen; } }
class PStr { constructor(bytes) { this.bytes = bytes; } }
/** Sözcük (obj, endobj, stream ...): `value()` bunları değer olarak vermez, çağıran karar verir. */
class Kw { constructor(word) { this.word = word; } }
class Stream { constructor(dict, raw) { this.dict = dict; this.raw = raw; } }

const isWs = (c) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const isDelim = (c) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
const isRegular = (c) => c !== undefined && !isWs(c) && !isDelim(c);
const isDigit = (c) => c >= 48 && c <= 57;

/* ========================================================================== sözcük çözümleyici */

class Lexer {
  /** @param {Buffer} buf @param {number} pos */
  constructor(buf, pos = 0) { this.buf = buf; this.p = pos; }

  skipWs() {
    const b = this.buf;
    for (;;) {
      const c = b[this.p];
      if (c === undefined) return;
      if (isWs(c)) this.p += 1;
      else if (c === 37) { while (this.p < b.length && b[this.p] !== 10 && b[this.p] !== 13) this.p += 1; } // % yorum
      else return;
    }
  }

  startsWith(word) { return this.buf.toString('latin1', this.p, this.p + word.length) === word; }

  /** Boşlukları atlayıp işaretsiz tam sayı okur. */
  intToken() {
    this.skipWs();
    const s = this.p;
    while (isDigit(this.buf[this.p])) this.p += 1;
    if (this.p === s) throw new PdfError(`Sayı bekleniyordu (konum ${s}).`);
    return Number(this.buf.toString('latin1', s, this.p));
  }

  wordToken() {
    this.skipWs();
    const s = this.p;
    while (isRegular(this.buf[this.p])) this.p += 1;
    return this.buf.toString('latin1', s, this.p);
  }

  /** @returns {any} */
  value() {
    this.skipWs();
    const b = this.buf;
    const c = b[this.p];
    if (c === undefined) throw new PdfError('Dosya beklenmedik biçimde bitti.');
    if (c === 0x3c) return b[this.p + 1] === 0x3c ? this.dict() : this.hexString();
    if (c === 0x5b) return this.array();
    if (c === 0x28) return this.literalString();
    if (c === 0x2f) return this.name();
    const start = this.p;
    while (isRegular(b[this.p])) this.p += 1;
    if (this.p === start) throw new PdfError(`Çözümlenemeyen karakter (${c}) konum ${start}.`);
    const tok = b.toString('latin1', start, this.p);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) {
      if (/^\d+$/.test(tok)) { // "n g R" dolaylı başvuru olabilir
        const save = this.p;
        this.skipWs();
        const s2 = this.p;
        while (isDigit(b[this.p])) this.p += 1;
        if (this.p > s2) {
          const gen = Number(b.toString('latin1', s2, this.p));
          this.skipWs();
          if (b[this.p] === 0x52 && !isRegular(b[this.p + 1])) { this.p += 1; return new Ref(Number(tok), gen); }
        }
        this.p = save;
      }
      return Number(tok);
    }
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    return new Kw(tok);
  }

  name() {
    this.p += 1; // '/'
    const b = this.buf;
    let out = '';
    while (isRegular(b[this.p])) {
      const c = b[this.p];
      if (c === 0x23 && /^[0-9a-fA-F]{2}$/.test(b.toString('latin1', this.p + 1, this.p + 3))) {
        out += String.fromCharCode(parseInt(b.toString('latin1', this.p + 1, this.p + 3), 16));
        this.p += 3;
      } else { out += String.fromCharCode(c); this.p += 1; }
    }
    return new Name(out);
  }

  dict() {
    this.p += 2; // <<
    const map = new Map();
    for (;;) {
      this.skipWs();
      if (this.buf[this.p] === 0x3e && this.buf[this.p + 1] === 0x3e) { this.p += 2; return map; }
      if (this.buf[this.p] !== 0x2f) throw new PdfError(`Sözlükte anahtar bekleniyordu (konum ${this.p}).`);
      const key = this.name().name;
      const v = this.value();
      if (v instanceof Kw) throw new PdfError(`Sözlük değeri geçersiz: ${v.word}`);
      map.set(key, v);
    }
  }

  array() {
    this.p += 1; // [
    const out = [];
    for (;;) {
      this.skipWs();
      if (this.buf[this.p] === 0x5d) { this.p += 1; return out; }
      const v = this.value();
      if (v instanceof Kw) throw new PdfError(`Dizi değeri geçersiz: ${v.word}`);
      out.push(v);
    }
  }

  literalString() {
    this.p += 1; // (
    const b = this.buf;
    const out = [];
    let depth = 1;
    while (this.p < b.length) {
      const c = b[this.p++];
      if (c === 0x5c) { // \
        const n = b[this.p++];
        if (n === 0x6e) out.push(10);
        else if (n === 0x72) out.push(13);
        else if (n === 0x74) out.push(9);
        else if (n === 0x62) out.push(8);
        else if (n === 0x66) out.push(12);
        else if (n === 13) { if (b[this.p] === 10) this.p += 1; } // satır devamı
        else if (n === 10) { /* satır devamı */ }
        else if (n >= 48 && n <= 55) {
          let v = n - 48;
          for (let i = 0; i < 2 && b[this.p] >= 48 && b[this.p] <= 55; i += 1) v = v * 8 + (b[this.p++] - 48);
          out.push(v & 255);
        } else if (n !== undefined) out.push(n);
      } else if (c === 0x28) { depth += 1; out.push(c); }
      else if (c === 0x29) { depth -= 1; if (depth === 0) return new PStr(Buffer.from(out)); out.push(c); }
      else out.push(c);
    }
    throw new PdfError('Metin dizisi kapanmadı.');
  }

  hexString() {
    this.p += 1; // <
    const b = this.buf;
    let hex = '';
    while (this.p < b.length && b[this.p] !== 0x3e) {
      const ch = String.fromCharCode(b[this.p++]);
      if (/[0-9a-fA-F]/.test(ch)) hex += ch;
    }
    this.p += 1;
    return new PStr(Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex'));
  }
}

const nameOf = (v) => (v instanceof Name ? v.name : null);

/* ============================================================================== akış çözme */

/** PNG öngörücüsü (xref akışları ve nesne akışları genellikle Predictor 12 kullanır). */
function unpredict(data, parms) {
  const predictor = parms?.get('Predictor') ?? 1;
  if (predictor === 1) return data;
  if (predictor === 2) throw new PdfError('TIFF öngörücüsü desteklenmiyor.');
  if (predictor < 10) throw new PdfError(`Desteklenmeyen öngörücü: ${predictor}`);
  const colors = parms.get('Colors') ?? 1;
  const bpc = parms.get('BitsPerComponent') ?? 8;
  const columns = parms.get('Columns') ?? 1;
  const rowBytes = Math.ceil((colors * bpc * columns) / 8);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rows = Math.floor(data.length / (rowBytes + 1));
  const out = Buffer.alloc(rows * rowBytes);
  for (let r = 0; r < rows; r += 1) {
    const type = data[r * (rowBytes + 1)];
    const src = r * (rowBytes + 1) + 1;
    const dst = r * rowBytes;
    for (let i = 0; i < rowBytes; i += 1) {
      const x = data[src + i];
      const a = i >= bpp ? out[dst + i - bpp] : 0;
      const b = r > 0 ? out[dst - rowBytes + i] : 0;
      const c = r > 0 && i >= bpp ? out[dst - rowBytes + i - bpp] : 0;
      let v;
      if (type === 0) v = x;
      else if (type === 1) v = x + a;
      else if (type === 2) v = x + b;
      else if (type === 3) v = x + ((a + b) >> 1);
      else if (type === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new PdfError(`Bilinmeyen PNG süzgeci: ${type}`);
      out[dst + i] = v & 255;
    }
  }
  return out;
}

/** xref akışı / nesne akışı içeriğini çözer: yalnız Flate (ve yok). */
function decodeStream(stream, doc) {
  const dict = stream.dict;
  let filters = doc.resolve(dict.get('Filter'));
  let parms = doc.resolve(dict.get('DecodeParms'));
  filters = filters === undefined || filters === null ? [] : Array.isArray(filters) ? filters : [filters];
  parms = Array.isArray(parms) ? parms : [parms];
  let data = stream.raw;
  filters.forEach((f, i) => {
    const n = nameOf(doc.resolve(f));
    const p = doc.resolve(parms[i]);
    if (n === 'FlateDecode' || n === 'Fl') {
      try { data = inflateSync(data, { finishFlush: zc.Z_SYNC_FLUSH }); } catch (err) { throw new PdfError(`Akış açılamadı: ${err.message}`); }
      data = unpredict(data, p instanceof Map ? p : null);
    } else throw new PdfError(`Desteklenmeyen akış süzgeci: ${n} (yalnız Flate okunur).`);
  });
  return data;
}

/* ===================================================================== belge (okuma tarafı) */

class PdfDoc {
  /** @param {Buffer} buf */
  constructor(buf) {
    this.buf = buf;
    const head = buf.subarray(0, Math.min(buf.length, 1024)).indexOf('%PDF-');
    if (head < 0) throw new PdfError('Bu bir PDF dosyası değil (%PDF- başlığı yok).');
    this.base = head;
    this.reset();
  }

  reset() {
    /** @type {Map<number, {off?: number, stm?: number, free?: boolean}>} */
    this.xref = new Map();
    this.trailer = null;
    this.cache = new Map();
    this.objStms = new Map();
  }

  resolve(v) {
    let guard = 0;
    while (v instanceof Ref) {
      if (guard++ > 32) throw new PdfError('Başvuru döngüsü.');
      v = this.getObj(v.num);
    }
    return v;
  }

  /** @returns {{num: number, gen: number, value: any}} */
  parseObjectAt(pos, expectNum) {
    if (pos < 0 || pos >= this.buf.length) throw new PdfError(`Nesne konumu geçersiz (${pos}).`);
    const lx = new Lexer(this.buf, pos);
    const num = lx.intToken();
    const gen = lx.intToken();
    if (lx.wordToken() !== 'obj') throw new PdfError(`Nesne başlığı bulunamadı (konum ${pos}).`);
    if (expectNum !== undefined && num !== expectNum) throw new PdfError(`xref uyuşmuyor: ${expectNum} beklenirken ${num} bulundu.`);
    const v = lx.value();
    if (v instanceof Kw) return { num, gen, value: null }; // "n g obj endobj": boş nesne
    lx.skipWs();
    if (v instanceof Map && lx.startsWith('stream')) {
      lx.p += 6;
      const b = this.buf;
      if (b[lx.p] === 13 && b[lx.p + 1] === 10) lx.p += 2;
      else if (b[lx.p] === 10 || b[lx.p] === 13) lx.p += 1;
      const start = lx.p;
      let len = v.get('Length');
      if (len instanceof Ref) { const r = this.getObj(len.num); len = typeof r === 'number' ? r : undefined; }
      let end = -1;
      if (Number.isInteger(len) && len >= 0 && start + len <= b.length) {
        let q = start + len;
        while (isWs(b[q])) q += 1;
        if (b.toString('latin1', q, q + 9) === 'endstream') end = start + len;
      }
      if (end < 0) { // Length yanlış/eksik: endstream aranır
        const idx = b.indexOf('endstream', start, 'latin1');
        if (idx < 0) throw new PdfError('Akış sonu (endstream) bulunamadı.');
        end = idx;
        if (b[end - 1] === 10) end -= 1;
        if (b[end - 1] === 13) end -= 1;
      }
      return { num, gen, value: new Stream(v, b.subarray(start, end)) };
    }
    return { num, gen, value: v };
  }

  getObj(num) {
    if (this.cache.has(num)) return this.cache.get(num);
    const e = this.xref.get(num);
    let v = null;
    if (e && !e.free) {
      if (e.off !== undefined) v = this.parseObjectAt(this.base + e.off, num).value;
      else if (e.stm !== undefined) v = this.fromObjStm(e.stm, num);
    }
    this.cache.set(num, v);
    return v;
  }

  fromObjStm(stmNum, num) {
    let info = this.objStms.get(stmNum);
    if (!info) {
      const s = this.getObj(stmNum);
      if (!(s instanceof Stream)) throw new PdfError(`Nesne akışı ${stmNum} okunamadı.`);
      const data = decodeStream(s, this);
      const n = this.resolve(s.dict.get('N'));
      const first = this.resolve(s.dict.get('First'));
      if (!Number.isInteger(n) || !Number.isInteger(first)) throw new PdfError('Nesne akışı başlığı geçersiz.');
      const lx = new Lexer(data, 0);
      const pairs = new Map();
      for (let i = 0; i < n; i += 1) { const objNum = lx.intToken(); const off = lx.intToken(); pairs.set(objNum, off); }
      info = { data, first, pairs };
      this.objStms.set(stmNum, info);
    }
    const off = info.pairs.get(num);
    if (off === undefined) return null;
    const v = new Lexer(info.data, info.first + off).value();
    return v instanceof Kw ? null : v;
  }

  /* ---- xref ---- */

  readXref() {
    const tail = this.buf.subarray(Math.max(0, this.buf.length - 2048));
    const i = tail.lastIndexOf('startxref');
    if (i < 0) throw new PdfError('startxref bulunamadı.');
    let next = new Lexer(tail, i + 9).intToken();
    const seen = new Set();
    while (next !== null && !seen.has(next)) {
      seen.add(next);
      next = this.readXrefSection(next);
    }
    if (!this.trailer) throw new PdfError('Trailer bulunamadı.');
  }

  readXrefSection(off) {
    const lx = new Lexer(this.buf, this.base + off);
    lx.skipWs();
    let trailer;
    if (lx.startsWith('xref')) {
      lx.p += 4;
      for (;;) {
        lx.skipWs();
        if (lx.startsWith('trailer')) { lx.p += 7; break; }
        const start = lx.intToken();
        const count = lx.intToken();
        if (count > 10_000_000) throw new PdfError('xref bölümü çok büyük.');
        for (let i = 0; i < count; i += 1) {
          const o = lx.intToken();
          const g = lx.intToken();
          const t = lx.wordToken();
          if (t !== 'n' && t !== 'f') throw new PdfError('xref girdisi bozuk.');
          if (!this.xref.has(start + i)) this.xref.set(start + i, t === 'n' ? { off: o, gen: g } : { free: true });
        }
      }
      trailer = lx.value();
      if (!(trailer instanceof Map)) throw new PdfError('Trailer sözlüğü okunamadı.');
      const xs = trailer.get('XRefStm');
      if (Number.isInteger(xs)) { try { this.readXrefStream(xs); } catch { /* hibrit dosyada yardımcı akış: bozuksa yok say */ } }
    } else {
      trailer = this.readXrefStream(off);
    }
    if (!this.trailer) this.trailer = trailer;
    const prev = trailer.get('Prev');
    return Number.isInteger(prev) ? prev : null;
  }

  readXrefStream(off) {
    const { value: s } = this.parseObjectAt(this.base + off);
    if (!(s instanceof Stream) || nameOf(s.dict.get('Type')) !== 'XRef') throw new PdfError('xref akışı bulunamadı.');
    const data = decodeStream(s, this);
    const w = s.dict.get('W');
    if (!Array.isArray(w) || w.length < 3 || w.some((x) => !Number.isInteger(x) || x < 0 || x > 8)) throw new PdfError('xref akışı /W geçersiz.');
    const size = s.dict.get('Size');
    const index = Array.isArray(s.dict.get('Index')) ? s.dict.get('Index') : [0, size];
    const rowLen = w[0] + w[1] + w[2];
    if (rowLen === 0) throw new PdfError('xref akışı satırı boş.');
    const read = (pos, n) => { let v = 0; for (let k = 0; k < n; k += 1) v = v * 256 + data[pos + k]; return v; };
    let pos = 0;
    for (let k = 0; k + 1 < index.length; k += 2) {
      for (let i = 0; i < index[k + 1]; i += 1) {
        if (pos + rowLen > data.length) break;
        const type = w[0] === 0 ? 1 : read(pos, w[0]);
        const f2 = read(pos + w[0], w[1]);
        const f3 = read(pos + w[0] + w[1], w[2]);
        pos += rowLen;
        const num = index[k] + i;
        if (this.xref.has(num)) continue;
        if (type === 0) this.xref.set(num, { free: true });
        else if (type === 1) this.xref.set(num, { off: f2, gen: f3 });
        else if (type === 2) this.xref.set(num, { stm: f2, idx: f3 });
      }
    }
    return s.dict;
  }

  /** Bozuk/eksik xref: dosya taranıp nesneler bulunur ("n g obj"). */
  rebuild() {
    this.reset();
    const s = this.buf.toString('latin1');
    const re = /(?<![\d.])(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    while ((m = re.exec(s)) !== null) this.xref.set(Number(m[1]), { off: m.index - this.base, gen: Number(m[2]) });

    // trailer sözlükleri (sonuncusu, Root'lu olan)
    const tre = /trailer/g;
    while ((m = tre.exec(s)) !== null) {
      try {
        const d = new Lexer(this.buf, m.index + 7).value();
        if (d instanceof Map && d.has('Root')) this.trailer = d;
      } catch { /* bozuk trailer: atla */ }
    }
    // nesne akışları ve xref akışları
    for (const [num, e] of [...this.xref]) {
      if (e.off === undefined) continue;
      const peek = s.slice(this.base + e.off, this.base + e.off + 400);
      try {
        if (!this.trailer && /\/Type\s*\/XRef/.test(peek)) {
          const d = this.getObj(num);
          if (d instanceof Stream && d.dict.has('Root')) this.trailer = d.dict;
        }
        if (/\/Type\s*\/ObjStm/.test(peek)) {
          const o = this.getObj(num);
          if (o instanceof Stream) {
            const data = decodeStream(o, this);
            const n = this.resolve(o.dict.get('N'));
            const lx = new Lexer(data, 0);
            for (let i = 0; i < n; i += 1) { const objNum = lx.intToken(); lx.intToken(); if (!this.xref.has(objNum)) this.xref.set(objNum, { stm: num }); }
          }
        }
      } catch { /* bozuk akış: atla */ }
    }
    if (!this.trailer) { // son çare: Catalog'u ara
      for (const [num, e] of this.xref) {
        if (e.off === undefined) continue;
        if (/\/Type\s*\/Catalog/.test(s.slice(this.base + e.off, this.base + e.off + 300))) this.trailer = new Map([['Root', new Ref(num, 0)]]);
      }
    }
    if (!this.trailer) throw new PdfError('PDF yapısı onarılamadı (belge kökü bulunamadı).');
  }

  /** Sayfa sözlükleri (sırayla; Resources/MediaBox/CropBox/Rotate üst düğümlerden miras alınmış). */
  pages() {
    if (this.trailer.has('Encrypt')) throw new PdfError('Şifreli PDF birleştirilemez. Şifresini kaldırıp (ör. "PDF olarak yazdır") yeniden yükleyin.');
    const root = this.resolve(this.trailer.get('Root'));
    if (!(root instanceof Map)) throw new PdfError('Belge kökü (Catalog) okunamadı.');
    const out = [];
    const seen = new Set();
    const INHERIT = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];
    const walk = (node, inherited, depth) => {
      if (depth > 64) throw new PdfError('Sayfa ağacı çok derin.');
      if (node instanceof Ref) { if (seen.has(node.num)) return; seen.add(node.num); }
      const dict = this.resolve(node);
      if (!(dict instanceof Map)) return;
      const inh = new Map(inherited);
      for (const k of INHERIT) if (dict.has(k)) inh.set(k, dict.get(k));
      const kids = this.resolve(dict.get('Kids'));
      if (Array.isArray(kids) && nameOf(dict.get('Type')) !== 'Page') {
        for (const kid of kids) walk(kid, inh, depth + 1);
        return;
      }
      const page = new Map(dict);
      for (const [k, v] of inh) if (!page.has(k)) page.set(k, v);
      out.push(page);
      if (out.length > MAX_PAGES_PER_FILE) throw new PdfError(`Bir dosyada en çok ${MAX_PAGES_PER_FILE} sayfa birleştirilebilir.`);
    };
    walk(root.get('Pages'), new Map(), 0);
    if (out.length === 0) throw new PdfError('PDF\'te sayfa bulunamadı.');
    return out;
  }
}

/**
 * Belgeyi açar ve sayfalarını verir. xref bozuksa ya da sayfa ağacı okunamazsa dosyayı tarayarak bir kez onarmayı dener.
 * @param {Buffer} buf @returns {{doc: PdfDoc, pages: Map<string, any>[]}}
 */
function open(buf) {
  const doc = new PdfDoc(buf);
  try {
    doc.readXref();
    return { doc, pages: doc.pages() };
  } catch (err) {
    if (err instanceof PdfError && /Şifreli/.test(err.message)) throw err;
    doc.rebuild();
    return { doc, pages: doc.pages() };
  }
}

/** Yükleme denetimi: geçerli, şifresiz, sayfası olan bir PDF mi? @returns {{pages: number}} */
export function inspectPdf(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 20) throw new PdfError('Dosya boş ya da çok küçük.');
  try {
    return { pages: open(buf).pages.length };
  } catch (err) {
    if (err instanceof PdfError) throw err;
    throw new PdfError(`PDF okunamadı: ${err.message}`);
  }
}

/**
 * Tanı/test yardımcısı: her sayfanın sayfa kutusu, kaynak var mı ve içerik akışı (Flate ise açılmış metin).
 * @param {Buffer} buf @returns {{mediaBox: number[]|null, hasResources: boolean, content: string}[]}
 */
export function describePages(buf) {
  const { doc, pages } = open(buf);
  return pages.map((page) => {
    const box = doc.resolve(page.get('MediaBox'));
    let contents = doc.resolve(page.get('Contents'));
    contents = Array.isArray(contents) ? contents : contents === undefined || contents === null ? [] : [contents];
    const text = contents.map((c) => {
      const s = doc.resolve(c);
      if (!(s instanceof Stream)) return '';
      const f = doc.resolve(s.dict.get('Filter'));
      return (f === undefined ? s.raw : decodeStream(s, doc)).toString('latin1');
    }).join('\n');
    return { mediaBox: Array.isArray(box) ? box.map((x) => doc.resolve(x)) : null, hasResources: page.has('Resources'), content: text };
  });
}

/* ============================================================================ yazma tarafı */

const NAME_SAFE = /^[!-~]$/;
function serName(n) {
  let out = '/';
  for (const ch of n) {
    const c = ch.charCodeAt(0);
    out += NAME_SAFE.test(ch) && !isDelim(c) && ch !== '#' ? ch : `#${c.toString(16).padStart(2, '0')}`;
  }
  return out;
}
function serNum(n) {
  if (Number.isInteger(n)) return String(n);
  const t = n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return t === '-0' ? '0' : t;
}

class Writer {
  constructor() {
    this.next = 1;
    this.map = new Map(); // "docId:num" -> yeni numara
    this.queue = [];
    this.objects = new Map(); // yeni numara -> Buffer (gövde)
    this.docIds = new Map();
  }

  alloc() { const n = this.next; this.next += 1; return n; }

  docId(doc) {
    if (!this.docIds.has(doc)) this.docIds.set(doc, this.docIds.size);
    return this.docIds.get(doc);
  }

  /** Kaynak başvurusunu yeni numaraya çevirir; nesne sıraya alınır. */
  ref(doc, r) {
    const key = `${this.docId(doc)}:${r.num}`;
    let n = this.map.get(key);
    if (n === undefined) { n = this.alloc(); this.map.set(key, n); this.queue.push({ doc, old: r.num, n }); }
    return new Ref(n, 0);
  }

  /** Değerdeki tüm başvuruları yeniden numaralar (kopya döner). */
  copy(doc, v) {
    if (v instanceof Ref) return this.ref(doc, v);
    if (Array.isArray(v)) return v.map((x) => this.copy(doc, x));
    if (v instanceof Map) { const m = new Map(); for (const [k, x] of v) m.set(k, this.copy(doc, x)); return m; }
    return v;
  }

  ser(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number') return serNum(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (v instanceof Name) return serName(v.name);
    if (v instanceof Ref) return `${v.num} 0 R`;
    if (v instanceof PStr) return `<${v.bytes.toString('hex')}>`;
    if (Array.isArray(v)) return `[${v.map((x) => this.ser(x)).join(' ')}]`;
    if (v instanceof Map) return `<<${[...v].map(([k, x]) => `${serName(k)} ${this.ser(x)}`).join(' ')}>>`;
    throw new PdfError('Yazılamayan değer.');
  }

  /** Sıradaki kaynak nesnelerini yazılacak nesnelere çevirir (başvurulanlar da sıraya girer). */
  drain() {
    while (this.queue.length > 0) {
      const { doc, old, n } = this.queue.pop();
      const obj = doc.getObj(old);
      if (obj instanceof Stream) {
        const dict = this.copy(doc, obj.dict);
        dict.set('Length', obj.raw.length);
        this.objects.set(n, Buffer.concat([Buffer.from(`${this.ser(dict)}\nstream\n`, 'latin1'), obj.raw, Buffer.from('\nendstream', 'latin1')]));
      } else {
        this.objects.set(n, Buffer.from(this.ser(this.copy(doc, obj)), 'latin1'));
      }
    }
  }

  serialize(rootNum) {
    const chunks = [Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
    let offset = chunks[0].length;
    const offsets = [];
    for (let n = 1; n < this.next; n += 1) {
      const body = this.objects.get(n) ?? Buffer.from('null', 'latin1');
      const head = Buffer.from(`${n} 0 obj\n`, 'latin1');
      const tail = Buffer.from('\nendobj\n', 'latin1');
      offsets[n] = offset;
      chunks.push(head, body, tail);
      offset += head.length + body.length + tail.length;
    }
    let xref = `xref\n0 ${this.next}\n0000000000 65535 f \n`;
    for (let n = 1; n < this.next; n += 1) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
    xref += `trailer\n<</Size ${this.next} /Root ${rootNum} 0 R>>\nstartxref\n${offset}\n%%EOF\n`;
    chunks.push(Buffer.from(xref, 'latin1'));
    return Buffer.concat(chunks);
  }
}

/** Sayfada taşınmayan anahtarlar: üst bağlantı, ek açıklamalar (bağlantı/form/yorum), ipuçları. */
const DROP_PAGE_KEYS = new Set(['Parent', 'Annots', 'B', 'Thumb', 'PieceInfo', 'StructParents', 'Metadata', 'AA', 'LastModified', 'ID', 'PZ', 'SeparationInfo', 'Tabs', 'TemplateInstantiated']);

/**
 * PDF'leri sırayla tek PDF'te birleştirir. Tek dosya verilirse aynen döner (yeniden yazılmaz).
 * @param {Buffer[]} buffers @returns {Buffer}
 */
export function mergePdfs(buffers) {
  if (!Array.isArray(buffers) || buffers.length === 0) throw new PdfError('Birleştirilecek PDF yok.');
  if (buffers.length === 1) { inspectPdf(buffers[0]); return buffers[0]; }
  const sources = buffers.map((b, i) => {
    try { return open(b); } catch (err) {
      if (err instanceof PdfError) throw new PdfError(`${i + 1}. PDF: ${err.message}`);
      throw new PdfError(`${i + 1}. PDF okunamadı: ${err.message}`);
    }
  });
  const w = new Writer();
  const catalogNum = w.alloc();
  const pagesNum = w.alloc();
  const kids = [];
  for (const { doc, pages } of sources) {
    for (const page of pages) {
      const n = w.alloc();
      const dict = new Map();
      for (const [k, v] of page) if (!DROP_PAGE_KEYS.has(k)) dict.set(k, w.copy(doc, v));
      dict.set('Type', new Name('Page'));
      dict.set('Parent', new Ref(pagesNum, 0));
      w.objects.set(n, Buffer.from(w.ser(dict), 'latin1'));
      kids.push(new Ref(n, 0));
    }
  }
  w.drain();
  w.objects.set(pagesNum, Buffer.from(w.ser(new Map([['Type', new Name('Pages')], ['Kids', kids], ['Count', kids.length]])), 'latin1'));
  w.objects.set(catalogNum, Buffer.from(w.ser(new Map([['Type', new Name('Catalog')], ['Pages', new Ref(pagesNum, 0)]])), 'latin1'));
  return w.serialize(catalogNum);
}
