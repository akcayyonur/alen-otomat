/**
 * PAKETLEME LİSTESİ (EYS.LS.005 "Paketleme Listesi"): her ürünün NASIL paketlendiğini sabitleyen referans kaydı —
 * koli boyutu, kasa özelliği, kat sayısı, koli/kasa içi adet, koli etiketi (STANDART/QR/İNGİLİZCE-LOGOSUZ), koli
 * ağırlığı (kg). `packing.js`'in bugünkü "koli içi adet öğrenme" mekanizmasının (`setBoxQtyIfEmpty`, tek alan)
 * 6 alana genişletilmiş karşılığıdır: bu modül `products.box_qty`'ye DOKUNMAZ, kendi `koli_ici_adet`'ini ayrıca
 * tutar — `packing.js#suggest()` önce buradan okur, yoksa eskisi gibi ürün kartından.
 *
 * Ürün adı/stok kodu/müşteri kodu `products`'tan gelir (burada tekrar saklanmaz); Excel'deki "MÜŞTERİ" (müşteri
 * ADI, `products`'ta karşılığı yok) kendi `musteri` kolonunda — Teknik Resim Takip'teki aynı ilke.
 *
 * **Excel'deki ALEN OTOMAT ÜRÜN KODU / MÜŞTERİ ÜRÜN KODU sütun başlıkları gerçek veriyle TUTARSIZ** (2026-11-09'da
 * bulundu, salt okuma ile doğrulandı): 110 satırın 108'inde SR0xx.xxx biçimindeki Alen kodu "MÜŞTERİ ÜRÜN KODU"
 * yazan sütunda duruyor. İçeri aktarırken sütun başlığına değil, iki sütunu da `products`'a karşı deneyip HANGİSİ
 * gerçek bir ürün kartına karşılık geliyorsa onu Alen kodu sayıyoruz (bkz. `importXlsx`).
 */
import { PlanningError } from './errors.js';
import { findHeaderByKeys, foldTr } from './normalize.js';
import { text, number } from './fields.js';
import { whole } from './packing.js';
import { XlsxError, readXlsx } from './xlsx-read.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS packing_specs (
  code_key          TEXT PRIMARY KEY,
  musteri           TEXT,
  koli_boyutu       TEXT,
  kasa_ozelligi     TEXT,
  kat_sayisi        TEXT,
  koli_ici_adet     INTEGER,
  koli_etiketi      TEXT,
  koli_agirligi_kg  REAL,
  updated_at        INTEGER NOT NULL,
  updated_by        TEXT
);
`;

const MAX_KOLI_ICI_ADET = 1_000_000;

const DEFAULTS = Object.freeze({
  musteri: null, koliBoyutu: null, kasaOzelligi: null, katSayisi: null, koliIciAdet: null, koliEtiketi: null, koliAgirligiKg: null,
});

const row = (r) => (r == null ? null : {
  musteri: r.musteri, koliBoyutu: r.koli_boyutu, kasaOzelligi: r.kasa_ozelligi, katSayisi: r.kat_sayisi,
  koliIciAdet: r.koli_ici_adet == null ? null : Number(r.koli_ici_adet), koliEtiketi: r.koli_etiketi,
  koliAgirligiKg: r.koli_agirligi_kg == null ? null : Number(r.koli_agirligi_kg),
  updatedAt: Number(r.updated_at), updatedBy: r.updated_by,
});

export class PackingSpecs {
  /** @param {{planning: import('./planning.js').Planning}} deps */
  constructor({ planning }) {
    this.planning = planning;
    this.db = planning.db.db; // ayni sqlite baglantisi
    this.db.exec(SCHEMA);
  }

  #raw(codeKey) {
    return row(this.db.prepare('SELECT * FROM packing_specs WHERE code_key = ?').get(codeKey));
  }

  #write(codeKey, next, { by = null, now = Date.now() } = {}) {
    this.db.prepare(
      `INSERT INTO packing_specs (code_key, musteri, koli_boyutu, kasa_ozelligi, kat_sayisi, koli_ici_adet, koli_etiketi, koli_agirligi_kg, updated_at, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(code_key) DO UPDATE SET musteri=excluded.musteri, koli_boyutu=excluded.koli_boyutu, kasa_ozelligi=excluded.kasa_ozelligi,
         kat_sayisi=excluded.kat_sayisi, koli_ici_adet=excluded.koli_ici_adet, koli_etiketi=excluded.koli_etiketi,
         koli_agirligi_kg=excluded.koli_agirligi_kg, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
    ).run(
      codeKey, next.musteri ?? null, next.koliBoyutu ?? null, next.kasaOzelligi ?? null, next.katSayisi ?? null,
      next.koliIciAdet ?? null, next.koliEtiketi ?? null, next.koliAgirligiKg ?? null, now, by,
    );
  }

  /** "X" (bos yerine kullanilan yer tutucu, gercek veride goruldu) -> null; yoksa serbest metin. */
  #katSayisi(value) {
    const t = text(value, 'Kat sayısı', 40);
    return t && t.trim().toUpperCase() === 'X' ? null : t;
  }

  #fields(input, { partial = false } = {}) {
    const out = {};
    const has = (k) => Object.hasOwn(input, k);
    if (!partial || has('musteri')) out.musteri = text(input.musteri, 'Müşteri', 120);
    if (!partial || has('koliBoyutu')) out.koliBoyutu = text(input.koliBoyutu, 'Koli boyutu', 60);
    if (!partial || has('kasaOzelligi')) out.kasaOzelligi = text(input.kasaOzelligi, 'Kasa özelliği', 60);
    if (!partial || has('katSayisi')) out.katSayisi = this.#katSayisi(input.katSayisi);
    if (!partial || has('koliIciAdet')) out.koliIciAdet = whole(input.koliIciAdet, 'Koli içi adet', MAX_KOLI_ICI_ADET);
    if (!partial || has('koliEtiketi')) out.koliEtiketi = text(input.koliEtiketi, 'Koli etiketi', 60);
    if (!partial || has('koliAgirligiKg')) out.koliAgirligiKg = number(input.koliAgirligiKg, 'Koli ağırlığı (kg)', { max: 500 });
    return out;
  }

  #compose(product, spec) {
    const s = spec ?? DEFAULTS;
    return { codeKey: product.codeKey, stockCode: product.stockCode, name: product.name, customerCode: product.customerCode, ...s };
  }

  /** Tek kayit (ham satir), yok ise null. `packing.js#suggest()` bundan okur. */
  find(codeKey) {
    return this.#raw(codeKey);
  }

  /** @param {{q?: string, limit?: number, offset?: number}} [f] */
  list({ q = '', limit = 200, offset = 0 } = {}) {
    const r = this.planning.db.listProducts({ q, limit, offset });
    const items = r.items.map((p) => ({
      codeKey: p.codeKey, stockCode: p.stockCode, name: p.name, customerCode: p.customerCode,
      ...(this.#raw(p.codeKey) ?? DEFAULTS),
    }));
    return { total: r.total, items };
  }

  /** Bir ürünün paketleme kaydını düzenler (yalnız gönderilen alanlar değişir; satır yoksa oluşturulur). */
  update(stockCode, input = {}, { by = null, now = Date.now() } = {}) {
    const key = foldTr(stockCode);
    const product = this.planning.db.getProduct(key);
    if (!product) throw new PlanningError(`Ürün bulunamadı: ${stockCode}`, 404);
    const cur = this.#raw(key) ?? DEFAULTS;
    const f = this.#fields(input, { partial: true });
    if (Object.keys(f).length === 0) return this.#compose(product, this.#raw(key));
    this.#write(key, { ...cur, ...f }, { by, now });
    return this.#compose(product, this.#raw(key));
  }

  /**
   * `packing.js#addRow()`'dan çağrılır: bir ürün ilk kez (ya da eksik alanlarla) paketlendiğinde, o an BOŞ olan
   * alanlara girilen değer varsa yazar; dolu alana dokunmaz (`products.setBoxQtyIfEmpty` ile aynı ilke, 6 alana
   * genişletilmiş hâli). Hiçbir alan girilmediyse/hepsi zaten doluysa hiçbir şey yazmaz.
   */
  learnIfEmpty(codeKey, input, { by = null, now = Date.now() } = {}) {
    const cur = this.#raw(codeKey) ?? DEFAULTS;
    const f = this.#fields(input, { partial: true });
    const next = { ...cur };
    let changed = false;
    for (const k of Object.keys(f)) {
      if (cur[k] == null && f[k] != null) { next[k] = f[k]; changed = true; }
    }
    if (changed) this.#write(codeKey, next, { by, now });
  }

  /** EYS.LS.005 sayfasında baslik satirini bulur (ilk ~12 satirda aranir). */
  #findHeader(rows) {
    return findHeaderByKeys(rows, ['ALENOTOMATURUNKODU', 'MUSTERIURUNKODU']);
  }

  /**
   * Gercek EYS.LS.005 Excel'ini icerik aktarir. Her satirda iki kod sutunu da (ALEN OTOMAT ÜRÜN KODU, MÜŞTERİ
   * ÜRÜN KODU) `products`'a karsi dener: hangisi gercek bir urun kartina karsilik geliyorsa o Alen kodu sayilir
   * (sutun basligina GUVENILMEZ, kaynak veride iki sutun yer yer karismis). Hicbiri eslesmezse ya da IKISI DE
   * FARKLI urunlere eslesiyorsa satir "belirsiz" uyarisiyla atlanir. Yinelenen Alen kodunda (tarih sutunu yok,
   * ayrica kaynak metinde ayni urun FARKLI yazimla da tekrar edebilir, ör. musteri kodunun iki ayri bicimi)
   * SON satir kazanir, oncekiler uyariyla raporlanir.
   * @returns {{total: number, matched: number, duplicates: number, noProduct: number, ambiguous: number, warnings: string[]}}
   */
  importXlsx(buffer, { by = null, now = Date.now() } = {}) {
    let book;
    try { book = readXlsx(buffer); } catch (err) { throw err instanceof XlsxError ? new PlanningError(err.message) : err; }

    let found = null; let sheetRows = null; let rowNumbers = null;
    for (const sheet of book.sheets) {
      const f = this.#findHeader(sheet.rows);
      if (f) { found = f; sheetRows = sheet.rows; rowNumbers = sheet.rowNumbers; break; }
    }
    if (!found) throw new PlanningError("Bu dosyada Paketleme Listesi (EYS.LS.005) başlıkları bulunamadı.");
    const { index, headerRow } = found;
    const get = (r, key) => (index.has(key) ? String(r[index.get(key)] ?? '').trim() : '');

    const warnings = [];
    const warn = (m) => { if (warnings.length < 25) warnings.push(m); else if (warnings.length === 25) warnings.push('… ve daha fazla uyarı var'); };

    /** @type {Map<string, {excelRow: number, fields: object}>} */
    const byCode = new Map();
    let total = 0;
    let ambiguous = 0;
    let noProduct = 0;
    let duplicates = 0;
    for (let r = headerRow + 1; r < sheetRows.length; r += 1) {
      const rowVals = sheetRows[r];
      const alenRaw = get(rowVals, 'ALENOTOMATURUNKODU');
      const musteriRaw = get(rowVals, 'MUSTERIURUNKODU');
      if (alenRaw === '' && musteriRaw === '') continue; // bos satir
      total += 1;
      const excelRow = rowNumbers[r];
      const aProduct = alenRaw ? this.planning.db.getProduct(foldTr(alenRaw)) : null;
      const bProduct = musteriRaw ? this.planning.db.getProduct(foldTr(musteriRaw)) : null;
      let key = null;
      if (aProduct && bProduct) {
        if (aProduct.codeKey === bProduct.codeKey) key = aProduct.codeKey;
        else { ambiguous += 1; warn(`Satır ${excelRow}: iki sütun da farklı ürün kartlarına eşleşiyor (${alenRaw} / ${musteriRaw}), atlandı.`); continue; }
      } else if (aProduct) key = aProduct.codeKey;
      else if (bProduct) key = bProduct.codeKey;
      else { noProduct += 1; warn(`Satır ${excelRow}: ürün kartı yok (${alenRaw || musteriRaw || '—'}), atlandı.`); continue; }

      try {
        const fields = {
          musteri: get(rowVals, 'MUSTERI') || null, koliBoyutu: get(rowVals, 'KOLIBOYUTU') || null,
          kasaOzelligi: get(rowVals, 'KASAOZELLIGI') || null, katSayisi: this.#katSayisi(get(rowVals, 'KATSAYISI')),
          koliIciAdet: (() => { const v = get(rowVals, 'KOLIKASAICIADET'); return v === '' ? null : whole(v, 'Koli içi adet', MAX_KOLI_ICI_ADET); })(),
          koliEtiketi: get(rowVals, 'KOLIETIKETI') || null,
          koliAgirligiKg: (() => { const v = get(rowVals, 'KOLIAGIRLIGIKG'); return v === '' ? null : number(v, 'Koli ağırlığı (kg)', { max: 500 }); })(),
        };
        const prev = byCode.get(key);
        if (prev) { duplicates += 1; warn(`Satır ${excelRow}: Alen kodu "${alenRaw || musteriRaw}" yinelenen (önceki: satır ${prev.excelRow}), eski olan atlandı.`); }
        byCode.set(key, { excelRow, fields }); // son satir kazanir (tarih sutunu yok)
      } catch (err) {
        warn(`Satır ${excelRow}: ${err.message}`);
      }
    }

    for (const [key, { fields }] of byCode) this.#write(key, { ...DEFAULTS, ...fields }, { by, now });
    return { total, matched: byCode.size, duplicates, noProduct, ambiguous, warnings };
  }
}
