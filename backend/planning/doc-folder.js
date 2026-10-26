/**
 * DOKUMAN KLASORLERI: iki AYRI klasor vardir, her birinin kendi yolu ve kendi "eslestir" dugmesi:
 *
 *   TEKNIK RESIM klasoru (kind 'cizim')  .pdf          -> urun kartinin teknik resimleri; yeni is emri bunlari kendisi alir
 *   ETIKET klasoru       (kind 'etiket') .docx .doc .pdf -> urun kartinin kutu etiketi dosyasi (Word tasarimlari); paketleme ekrani gosterir
 *
 * Dosyalar URUN KODUNA gore urun kartlarina baglanir; is emri acilirken her seferinde PDF yuklemek gerekmez. Sira (ilk bulan kazanir):
 *   1) dosya adinda / klasor yolunda ALEN OTOMAT urun kodu (SR002.013),
 *   2) dosya adinda MUSTERI URUN KODU (urun kartindaki kod: "601037010525.doc", "1235-669.doc", "Nİ049.002 - 601.SMN.613.001.pdf"); fabrikadaki etiket
 *      dosyalari cogunlukla musteri klasorlerinde ve musteri koduyla adlandirilmistir. Ayni musteri kodu birden cok kartta varsa BAGLANMAZ (belirsiz),
 *   3) (yalniz etiket) Word dosyasinin ICINDEKI yazi: once Alen kodu, sonra karttaki bir musteri kodu.
 *
 *   - Klasor: yonetici ayarlar (settings 'docs.<tur>.dir'); ayar yoksa varsayilan (data/teknik-resim, data/etiket; ilk bakista olusturulur).
 *     Alt klasorler taranir (en cok 4 derinlik). ~$ kilit dosyalari ve . ile baslayanlar atlanir.
 *   - Kod: dosya adinda ve klasor yolunda aranir ("SR002.013 DAIKIN.pdf", "SR002-013.pdf", "SR 002 013.docx", klasor adi "SR002.013"). Alen kodu yoksa dosya adinin
 *     her sozcugu karttaki musteri kodlariyla karsilastirilir (buyuk/kucuk harf, nokta/tire/bosluk fark etmez; en az 5 karakter ve bir rakam). Etiket klasorunde adda
 *     kod yoksa .docx / .doc'un ICINDE aranir (kodlar etiketin uzerinde yazar; .doc'ta ham metin taramasi). Bir dosyada birden cok Alen kodu varsa hepsine
 *     baglanir. Yalnizca VAR OLAN urun kartlarina baglanir; karti olmayan kod "eslesmedi" olarak listelenir.
 *   - Varsayilan: yalniz resmi / etiketi OLMAYAN urunler eslenir. Olana dokunulmaz (elle yuklenmis eski resimler ve is emri resimleri de "var" sayilir).
 *     `update`: klasorden eslenmis dosyalar yeniden okunur, icerik degistiyse (yeni revizyon) yenisiyle degistirilir; elle eklenenlere dokunulmaz.
 *   - Yeni baglanan teknik resimler, ayni urunun BITMEMIS (planlandi / uretimde) ve resimsiz is emirlerine de baglanir.
 *
 * Not: sunucu SYSTEM hesabiyla calisir; ag paylasimi ona kapali olabilir, YEREL klasor kullanin.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { PlanningError } from './errors.js';
import { foldTr, headerKey, resolveCustomerCode } from './normalize.js';
import { readZip } from './xlsx-read.js';
import { MAX_PRODUCT_FILES } from './quality.js';

/** Hangi klasorde hangi uzantilar okunur. */
export const FOLDER_EXTENSIONS = Object.freeze({ cizim: ['.pdf'], etiket: ['.docx', '.doc', '.pdf'] });
const LABEL = Object.freeze({ cizim: 'Teknik resim', etiket: 'Etiket' });
const MAX_DEPTH = 4;
const MAX_ENTRIES = 20_000;
const MAX_DOCX_SCANS = 2_000; // kod adinda yoksa icerigine bakilan Word dosyasi sayisi
const LIST_CAP = 60;

const MIN_CUSTOMER_KEY = 5; // musteri kodu anahtari en az bu uzunlukta ve bir rakamli olmali ("N", "2", "ETIKET" kod sayilmaz)
const LETTER = 'A-Za-zÇĞİÖŞÜçğıöşü';
const CODE_RE = new RegExp(`(?<![0-9${LETTER}])([${LETTER}]{2})[\\s._-]{0,2}(\\d{3})[\\s._-]{0,2}(\\d{3})(?!\\d)`, 'g');

/**
 * Bir metindeki Alen Otomat urun kodlari (SR002.013). Ayirici nokta, tire, alt cizgi, bosluk ya da hic olmayabilir ("SR002013").
 * @returns {{key: string, code: string}[]} key: katlanmis urun anahtari (NI002.001), code: gosterim (SR002.013)
 */
export function productCodesIn(text) {
  const out = new Map();
  for (const m of String(text ?? '').matchAll(CODE_RE)) {
    const code = `${m[1]}${m[2]}.${m[3]}`;
    out.set(foldTr(code), code.toUpperCase());
  }
  return [...out].map(([key, code]) => ({ key, code }));
}

const TOKEN_RE = /[A-Za-z0-9ÇĞİÖŞÜçğıöşü][A-Za-z0-9ÇĞİÖŞÜçğıöşü._-]{3,}/g;
const isCustomerKey = (k) => k.length >= MIN_CUSTOMER_KEY && /\d/.test(k);

/** Dosya adindan (uzantisiz) musteri kodu adaylari: tum ad ve her sozcuk ("601037100010 N" -> 601037100010, "Nİ001.012 - 6018011703501" -> 6018011703501). */
export function nameKeys(rel) {
  const base = basename(rel, extname(rel));
  const out = new Set([headerKey(base)]);
  for (const part of base.split(/[\s,;()[\]]+/)) out.add(headerKey(part));
  for (const part of base.split(/[\s,;()[\]_]+/)) out.add(headerKey(part));
  return [...out].filter(isCustomerKey);
}

/** Serbest metindeki kod benzeri sozcukler (Word icerigi); anahtar olarak. */
export function textKeys(text) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(TOKEN_RE)) { const k = headerKey(m[0]); if (isCustomerKey(k)) out.add(k); }
  return [...out];
}

/** Etiket dosyasinin okunabilir metni: .docx'te XML metni; .doc'ta ham bayt taramasi (8 bit + UTF-16, iki hizalama). */
function labelText(path, ext) {
  const buf = readFileSync(path);
  if (ext === '.docx') return docxText(buf);
  return `${buf.toString('latin1')}\n${buf.toString('utf16le')}\n${buf.subarray(1).toString('utf16le')}`;
}

/** .docx'in metni (belge, ustbilgi, altbilgi); kod aramasi icin. Calisma parcalari bitistirilir ("SR002" + "." + "013"). */
function docxText(buf) {
  let text = '';
  for (const [name, get] of readZip(buf)) {
    if (/^word\/(?:document|header\d*|footer\d*)\.xml$/.test(name)) text += `${get().toString('utf8').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '')}\n`;
  }
  return text;
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

export class DocFolder {
  /**
   * @param {{planning: import('./planning.js').Planning, kind: 'cizim'|'etiket', defaultDir?: string|null}} deps
   *   defaultDir verilmezse (testler) klasor ayarlanana dek yok sayilir.
   */
  constructor({ planning, kind, defaultDir = null }) {
    if (!FOLDER_EXTENSIONS[kind]) throw new Error(`doc-folder: bilinmeyen tür: ${kind}`);
    this.planning = planning;
    this.kind = kind;
    this.defaultDir = defaultDir ? resolve(defaultDir) : null;
    this.busy = false;
    this.settingDir = `docs.${kind}.dir`;
    this.settingLast = `docs.${kind}.last`;
  }

  get #db() { return this.planning.db; }

  get #quality() { return this.planning.quality; }

  dir() { return this.#db.getSetting(this.settingDir) ?? this.defaultDir; }

  config() {
    const dir = this.dir();
    return { kind: this.kind, dir, defaultDir: this.defaultDir, isDefault: dir === this.defaultDir, extensions: FOLDER_EXTENSIONS[this.kind] };
  }

  setDir(value) {
    const raw = typeof value === 'string' ? value.trim() : '';
    if (raw === '') { this.#db.setSetting(this.settingDir, null); return this.config(); }
    if (raw.length > 260) throw new PlanningError('Klasör yolu en fazla 260 karakter olabilir.');
    if (!isAbsolute(raw)) throw new PlanningError('Klasör yolu tam (mutlak) olmalı, ör. C:\\CNC-Telemetri\\data\\teknik-resim');
    const dir = resolve(raw);
    let st;
    try { st = statSync(dir); } catch { throw new PlanningError(`Klasör bulunamadı ya da okunamıyor: ${dir}`, 400, 'no-dir'); }
    if (!st.isDirectory()) throw new PlanningError(`Bu bir klasör değil: ${dir}`, 400, 'no-dir');
    this.#db.setSetting(this.settingDir, dir);
    return this.config();
  }

  #ensureDefault(dir) {
    if (dir && dir === this.defaultDir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  /** Klasordeki okunabilir dosyalar (alt klasorler dahil). @returns {{files: object[], truncated: boolean}} */
  #scan(dir) {
    const allowed = new Set(FOLDER_EXTENSIONS[this.kind]);
    const files = [];
    let entries = 0;
    let truncated = false;
    const walk = (d, depth) => {
      let list;
      try { list = readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of list) {
        if (e.name.startsWith('.') || e.name.startsWith('~$')) continue;
        if (++entries > MAX_ENTRIES) { truncated = true; return; }
        const p = join(d, e.name);
        if (e.isDirectory()) { if (depth < MAX_DEPTH) walk(p, depth + 1); continue; }
        const ext = extname(e.name).toLowerCase();
        if (!e.isFile() || !allowed.has(ext)) continue;
        let st;
        try { st = statSync(p); } catch { continue; }
        files.push({ name: e.name, rel: relative(dir, p), path: p, ext, size: st.size });
      }
    };
    walk(dir, 0);
    files.sort((a, b) => a.rel.localeCompare(b.rel, 'tr'));
    return { files, truncated };
  }

  /**
   * Musteri urun kodu anahtari -> o koda sahip kartlar (kod karttan ya da urun adinin basindan, `resolveCustomerCode`). Ayni kod birden cok kartta varsa liste uzar.
   * @returns {Map<string, {key: string, product: {stockCode: string}}[]>}
   */
  #customerIndex() {
    const index = new Map();
    for (const r of this.#db.db.prepare('SELECT code_key, stock_code, name, customer_code FROM products').all()) {
      const k = headerKey(resolveCustomerCode(r.customer_code, r.name));
      if (!isCustomerKey(k)) continue;
      const list = index.get(k) ?? [];
      list.push({ key: r.code_key, product: { stockCode: r.stock_code } });
      index.set(k, list);
    }
    return index;
  }

  /** Bu turde dosyasi olmayan urun kartlari (resim icin: elle yuklenmis eski resimler ve is emri resimleri de "var" sayilir). */
  #missing() {
    const rows = this.#db.db.prepare('SELECT code_key, stock_code FROM products ORDER BY stock_code COLLATE NOCASE').all();
    const none = rows.filter((r) => (this.kind === 'cizim' ? !this.#quality.db.hasAnyDrawing(r.code_key) : this.#quality.db.productFiles(r.code_key, 'etiket').length === 0))
      .map((r) => r.stock_code);
    return { total: rows.length, none };
  }

  /** Eslemeden durum: klasor, dosya sayisi ve dosyasi olmayan urun sayisi. */
  status() {
    const cfg = this.config();
    const last = this.#db.getSetting(this.settingLast);
    const base = { ...cfg, exists: false, files: 0, truncated: false, products: 0, without: 0, last: last ? JSON.parse(last) : null };
    if (!cfg.dir) return base;
    this.#ensureDefault(cfg.dir);
    if (!existsSync(cfg.dir)) return base;
    const { files, truncated } = this.#scan(cfg.dir);
    const miss = this.#missing();
    return { ...base, exists: true, files: files.length, truncated, products: miss.total, without: miss.none.length };
  }

  /**
   * Klasoru tarar ve dosyalari urun kartlarina baglar.
   * @param {{by?: string|null, update?: boolean, now?: number}} [opts] update: klasorden eslenmis dosyalari (degistiyse) yenile
   */
  match({ by = null, update = false, now = Date.now() } = {}) {
    if (this.busy) throw new PlanningError('Bir eşleme zaten sürüyor, bitmesini bekleyin.', 409, 'busy');
    this.busy = true;
    try {
      const { kind } = this;
      const dir = this.dir();
      if (!dir) throw new PlanningError(`${LABEL[kind]} klasörü ayarlanmadı. "Klasör" ile belirleyin.`, 409, 'no-dir');
      this.#ensureDefault(dir);
      if (!existsSync(dir)) throw new PlanningError(`${LABEL[kind]} klasörü bulunamadı: ${dir}`, 409, 'no-dir');

      const { files, truncated } = this.#scan(dir);
      /** @type {Map<string, {product: object, files: object[]}>} */
      const byProduct = new Map();
      const unmatched = [];
      let unmatchedTotal = 0;
      let docScans = 0;
      const addUnmatched = (rel, reason) => { unmatchedTotal += 1; if (unmatched.length < LIST_CAP) unmatched.push({ name: rel, reason }); };

      const custIndex = this.#customerIndex();
      for (const f of files) {
        let why = 'ürün kodu bulunamadı';
        const note = (reason, strong = false) => { if (strong || why === 'ürün kodu bulunamadı') why = reason; };
        const byAlen = (text, via) => {
          const codes = productCodesIn(text);
          if (codes.length === 0) return [];
          const known = codes.map((c) => ({ key: c.key, product: this.#db.getProduct(c.key), via })).filter((c) => c.product);
          if (known.length === 0) note(`ürün kartı yok (${codes.map((c) => c.code).join(', ')})`);
          return known;
        };
        const byCustomer = (keys, via) => {
          const out = [];
          for (const k of keys) {
            const list = custIndex.get(k);
            if (!list) continue;
            if (list.length > 1) { note(`müşteri kodu birden çok ürün kartında (${list.map((p) => p.product.stockCode).join(', ')})`, true); continue; }
            out.push({ ...list[0], via });
          }
          return out;
        };

        let hits = byAlen(f.rel, 'ürün kodu');
        if (hits.length === 0) hits = byCustomer(nameKeys(f.rel), 'müşteri kodu');
        if (hits.length === 0 && kind === 'etiket' && f.ext !== '.pdf' && docScans < MAX_DOCX_SCANS) {
          docScans += 1;
          let text = '';
          try { text = labelText(f.path, f.ext); } catch { /* okunamayan Word dosyasi: kod bulunamadi sayilir */ }
          hits = byAlen(text, 'dosya içi');
          if (hits.length === 0) hits = byCustomer(textKeys(text), 'dosya içi');
        }
        if (hits.length === 0) { addUnmatched(f.rel, why); continue; }
        for (const h of hits) {
          const entry = byProduct.get(h.key) ?? { product: h.product, files: [], via: new Set() };
          if (!entry.files.includes(f)) entry.files.push(f);
          entry.via.add(h.via);
          byProduct.set(h.key, entry);
        }
      }

      const result = {
        kind, dir, at: now, update, truncated, scanned: files.length,
        attached: [], products: 0, alreadyHad: 0, updated: 0, unchanged: 0, orders: 0,
        unmatched, unmatchedTotal, rejected: [],
      };
      const reject = (rel, error) => { if (result.rejected.length < LIST_CAP) result.rejected.push({ name: rel, error }); };

      const attach = (key, list, slots) => {
        const names = [];
        const rels = [];
        for (const f of list) {
          if (names.length >= slots) { reject(f.rel, `en çok ${MAX_PRODUCT_FILES} dosya eklenebilir`); continue; }
          try {
            this.#quality.addProductFile(key, kind, { name: f.name, data: f.data ?? readFileSync(f.path), source: 'klasor', relPath: f.rel }, { by, now });
            names.push(f.name);
            rels.push(f.rel);
          } catch (err) {
            if (err instanceof PlanningError) { if (err.code !== 'duplicate') reject(f.rel, err.message); } else reject(f.rel, err.message);
          }
        }
        // ayni ad farkli musteri klasorlerinden gelebilir ("601030772035.doc" x2): o zaman klasor yoluyla gosterilir
        return new Set(names).size === names.length ? names : rels;
      };

      for (const [key, entry] of [...byProduct].sort((a, b) => a[1].product.stockCode.localeCompare(b[1].product.stockCode, 'tr'))) {
        const existing = this.#quality.db.productFiles(key, kind);
        const had = kind === 'cizim' ? this.#quality.db.hasAnyDrawing(key) : existing.length > 0;
        let names = [];
        let updated = false;
        if (!had) {
          names = attach(key, entry.files, MAX_PRODUCT_FILES - existing.length);
        } else if (update && existing.some((e) => e.source === 'klasor')) {
          const mine = existing.filter((e) => e.source === 'klasor');
          const loaded = [];
          for (const f of entry.files) { try { loaded.push({ ...f, data: readFileSync(f.path) }); } catch (err) { reject(f.rel, `okunamadı: ${err.code ?? err.message}`); } }
          const same = mine.length === loaded.length && loaded.every((l) => mine.some((m) => m.relPath === l.rel && m.sha === sha256(l.data)));
          if (same) { result.unchanged += 1; continue; }
          for (const m of mine) this.#quality.removeProductFile(m.id);
          names = attach(key, loaded, MAX_PRODUCT_FILES - (existing.length - mine.length));
          updated = true;
        } else { result.alreadyHad += 1; continue; }

        if (names.length === 0) continue;
        result.products += 1;
        if (updated) result.updated += 1;
        const orders = kind === 'cizim' ? this.#quality.applyProductDrawingsToOpenOrders(key, { by, now }) : 0;
        result.orders += orders;
        if (result.attached.length < LIST_CAP) result.attached.push({ stockCode: entry.product.stockCode, files: names, updated, orders, via: [...entry.via] });
      }

      const miss = this.#missing();
      result.missing = { products: miss.total, total: miss.none.length, sample: miss.none.slice(0, LIST_CAP) };
      this.#db.setSetting(this.settingLast, JSON.stringify({ at: now, by, update, matched: result.products, missing: miss.none.length }));
      return result;
    } finally {
      this.busy = false;
    }
  }
}
