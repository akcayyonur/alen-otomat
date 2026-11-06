/**
 * TEKNIK RESIM TAKIP (EYS.LS.007 "Seri Üretim Teknik Resim Takip Listesi"): sistemdeki her ürünün teknik resminin
 * NE ZAMAN kayda girdiği ve NE ZAMAN revize olduğu. Gerçek Excel'in dağıtım/toplama/arşiv bürokrasi bölümü (398
 * satırın TAMAMINDA boştu, 2026-11-06'da salt okuma ile doğrulandı) alınmadı — yalnız KİMLİK + REVİZYON alanları
 * (kullanıcı kararı): müşteri, resim no, kayıt tarihi, rev no, yayın tarihi, rev tarihi, tutulduğu ortam, durumu,
 * revizyon nedeni. "Durumu" serbest metin kalır (gerçek veride 'İPTAL'/'revize edildi'/'REVİZE EDİLDİ' gibi
 * tutarsız büyük/küçük harf örnekleri var; bir enum/kısıtlama UYGULANMAZ).
 *
 * Ürün adı/stok kodu/müşteri kodu `products` tablosundan gelir (burada TEKRAR SAKLANMAZ); Excel'deki "MÜŞTERİ"
 * (müşteri ADI, `products`'ta karşılığı yok) bu tabloda `musteri` kolonunda.
 *
 * REV NO ürün bazlı: hiç revizyon gelmediyse 0, SİSTEM dosya her değiştiğinde otomatik +1 arttırır (kullanıcı
 * kararı). Kritik ayrım, `recordDrawingChange`'de (bkz. `doc-folder.js`'in `match()`'inden çağrılır):
 *   - "Excel'den baseline'ı olan (ya da hiç izlenmeyen) bir ürüne İLK DEFA dijital resim eklenmesi" rev_no'yu
 *     ARTIRMAZ (Excel'deki mevcut rev_no/tarih korunur; satır hiç yoksa 0'dan başlar) — bu yalnız kâğıttaki
 *     bilgiyi dijitale taşımak.
 *   - "Zaten dijital resmi olan bir ürünün dosyası DEĞİŞMESİ" (gerçek revizyon) rev_no'yu +1 ARTIRIR ve
 *     rev_tarihi'ni günceller.
 * `doc-folder.js`'in `match()`'i zaten bu ayrımı (`had`: üründe önceden cizim dosyası var mıydı) hesaplıyor; bu
 * modül içinde YENİDEN türetilmeye çalışılmadı (doğru an orada, "update" dalı eski satırı SİLMEDEN ÖNCE).
 */
import { PlanningError } from './errors.js';
import { findHeaderByKeys, foldTr, parseDate } from './normalize.js';
import { text, day } from './fields.js';
import { XlsxError, readXlsx } from './xlsx-read.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS drawing_tracking (
  code_key          TEXT PRIMARY KEY,
  musteri           TEXT,
  resim_no          TEXT,
  kayit_tarihi      INTEGER,
  rev_no            INTEGER NOT NULL DEFAULT 0,
  yayin_tarihi      INTEGER,
  rev_tarihi        INTEGER,
  tutuldugu_ortam   TEXT,
  durumu            TEXT,
  revizyon_nedeni   TEXT,
  updated_at        INTEGER NOT NULL,
  updated_by        TEXT
);
`;

const DEFAULTS = Object.freeze({
  musteri: null, resimNo: null, kayitTarihi: null, revNo: 0, yayinTarihi: null, revTarihi: null,
  tutuldugu: null, durumu: null, revizyonNedeni: null,
});

const row = (r) => (r == null ? null : {
  musteri: r.musteri, resimNo: r.resim_no, kayitTarihi: r.kayit_tarihi == null ? null : Number(r.kayit_tarihi),
  revNo: Number(r.rev_no), yayinTarihi: r.yayin_tarihi == null ? null : Number(r.yayin_tarihi),
  revTarihi: r.rev_tarihi == null ? null : Number(r.rev_tarihi), tutuldugu: r.tutuldugu_ortam, durumu: r.durumu,
  revizyonNedeni: r.revizyon_nedeni, updatedAt: Number(r.updated_at), updatedBy: r.updated_by,
});

export class DrawingTracking {
  /** @param {{planning: import('./planning.js').Planning}} deps */
  constructor({ planning }) {
    this.planning = planning;
    this.db = planning.db.db; // ayni sqlite baglantisi
    this.db.exec(SCHEMA);
  }

  #raw(codeKey) {
    return row(this.db.prepare('SELECT * FROM drawing_tracking WHERE code_key = ?').get(codeKey));
  }

  #write(codeKey, next, { by = null, now = Date.now() } = {}) {
    this.db.prepare(
      `INSERT INTO drawing_tracking (code_key, musteri, resim_no, kayit_tarihi, rev_no, yayin_tarihi, rev_tarihi, tutuldugu_ortam, durumu, revizyon_nedeni, updated_at, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(code_key) DO UPDATE SET musteri=excluded.musteri, resim_no=excluded.resim_no, kayit_tarihi=excluded.kayit_tarihi,
         rev_no=excluded.rev_no, yayin_tarihi=excluded.yayin_tarihi, rev_tarihi=excluded.rev_tarihi,
         tutuldugu_ortam=excluded.tutuldugu_ortam, durumu=excluded.durumu, revizyon_nedeni=excluded.revizyon_nedeni,
         updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
    ).run(
      codeKey, next.musteri ?? null, next.resimNo ?? null, next.kayitTarihi ?? null, next.revNo ?? 0,
      next.yayinTarihi ?? null, next.revTarihi ?? null, next.tutuldugu ?? null, next.durumu ?? null,
      next.revizyonNedeni ?? null, now, by,
    );
  }

  #fields(input, { partial = false } = {}) {
    const out = {};
    const has = (k) => Object.hasOwn(input, k);
    if (!partial || has('musteri')) out.musteri = text(input.musteri, 'Müşteri', 120);
    if (!partial || has('resimNo')) out.resimNo = text(input.resimNo, 'Resim no', 60);
    if (!partial || has('kayitTarihi')) out.kayitTarihi = day(input.kayitTarihi, 'Kayıt tarihi');
    if (!partial || has('revNo')) {
      const v = input.revNo;
      if (v === undefined || v === null || v === '') out.revNo = 0;
      else {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n > 9999) throw new PlanningError('Rev no 0 ile 9999 arasında tam sayı olmalı.');
        out.revNo = n;
      }
    }
    if (!partial || has('yayinTarihi')) out.yayinTarihi = day(input.yayinTarihi, 'Yayın tarihi');
    if (!partial || has('revTarihi')) out.revTarihi = day(input.revTarihi, 'Rev. tarihi');
    if (!partial || has('tutuldugu')) out.tutuldugu = text(input.tutuldugu, 'Tutulduğu ortam', 40);
    if (!partial || has('durumu')) out.durumu = text(input.durumu, 'Durumu', 60);
    if (!partial || has('revizyonNedeni')) out.revizyonNedeni = text(input.revizyonNedeni, 'Revizyon nedeni', 300);
    return out;
  }

  #compose(product, tracking) {
    const t = tracking ?? DEFAULTS;
    const counts = this.planning.quality.db.productFileCounts([product.codeKey]).get(product.codeKey);
    return {
      codeKey: product.codeKey, stockCode: product.stockCode, name: product.name, customerCode: product.customerCode,
      drawingCount: counts.cizim, ...t,
    };
  }

  /** @param {{q?: string, limit?: number, offset?: number}} [f] */
  list({ q = '', limit = 200, offset = 0 } = {}) {
    const r = this.planning.db.listProducts({ q, limit, offset });
    const codeKeys = r.items.map((p) => p.codeKey);
    const counts = this.planning.quality.db.productFileCounts(codeKeys);
    const items = r.items.map((p) => ({
      codeKey: p.codeKey, stockCode: p.stockCode, name: p.name, customerCode: p.customerCode,
      drawingCount: counts.get(p.codeKey).cizim, ...(this.#raw(p.codeKey) ?? DEFAULTS),
    }));
    return { total: r.total, items };
  }

  /** Bir ürünün izleme alanlarını düzenler (yalnız gönderilen alanlar değişir; satır yoksa oluşturulur). */
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
   * `doc-folder.js`'in `match()`'inden çağrılır: bir ürüne 'cizim' dosyası başarıyla eklendiğinde.
   * @param {string} codeKey
   * @param {{isRevision: boolean, now?: number}} opts isRevision: bu üründe DAHA ÖNCE cizim dosyası var mıydı (`had`).
   */
  recordDrawingChange(codeKey, { isRevision, now = Date.now() } = {}) {
    const cur = this.#raw(codeKey);
    if (!cur) {
      // Hic izlenmiyordu (Excel'de de yoktu): ilk dijital esleme rev_no=0, gercek revizyonsa (savunmaci) 1.
      this.#write(codeKey, { ...DEFAULTS, revNo: isRevision ? 1 : 0, revTarihi: isRevision ? now : null, yayinTarihi: isRevision ? null : now }, { now });
      return;
    }
    if (!isRevision) {
      // Excel'den baseline mevcut, ilk kez dijitale tasiniyor: rev_no/rev_tarihine DOKUNMA, yalniz yayin_tarihi bossa doldur.
      if (cur.yayinTarihi == null) this.#write(codeKey, { ...cur, yayinTarihi: now }, { now });
      return;
    }
    // Zaten dijital resmi vardi, icerik degisti: gercek revizyon.
    this.#write(codeKey, { ...cur, revNo: cur.revNo + 1, revTarihi: now }, { now });
  }

  /** EYS.LS.007 sayfasinda baslik satirini bulur (ilk ~12 satirda aranir, form basligi/lejant ustunde olabilir). */
  #findHeader(rows) {
    return findHeaderByKeys(rows, ['ALENOTOMATURUNKODU', 'REVNO']);
  }

  /**
   * Gercek EYS.LS.007 Excel'ini icerik aktarir: Alen Otomat urun koduyla `products`'a karsi eslenir. Ayni Alen
   * kodundan BIRDEN COK satir varsa (gercek dosyada 27/398 goruldu) en YENI olan (rev_tarihi, yoksa yayin_tarihi,
   * yoksa kayit_tarihi) baz alinir, digerleri "yinelenen" uyarisiyla ATLANIR (sessizce uzerine yazilmaz).
   * @returns {{total: number, matched: number, duplicates: number, unmatched: number, warnings: string[]}}
   */
  importXlsx(buffer, { by = null, now = Date.now() } = {}) {
    let book;
    try { book = readXlsx(buffer); } catch (err) { throw err instanceof XlsxError ? new PlanningError(err.message) : err; }

    let found = null; let sheetRows = null; let rowNumbers = null;
    for (const sheet of book.sheets) {
      const f = this.#findHeader(sheet.rows);
      if (f) { found = f; sheetRows = sheet.rows; rowNumbers = sheet.rowNumbers; break; }
    }
    if (!found) throw new PlanningError("Bu dosyada Teknik Resim Takip Listesi (EYS.LS.007) başlıkları bulunamadı.");
    const { index, headerRow } = found;
    const get = (r, key) => (index.has(key) ? String(r[index.get(key)] ?? '').trim() : '');

    const warnings = [];
    const warn = (m) => { if (warnings.length < 25) warnings.push(m); else if (warnings.length === 25) warnings.push('… ve daha fazla uyarı var'); };

    /** @type {Map<string, {excelRow: number, codeKey: string, fields: object, sortAt: number}>} */
    const byCode = new Map();
    let total = 0;
    let noProduct = 0;
    let duplicates = 0;
    for (let r = headerRow + 1; r < sheetRows.length; r += 1) {
      const rowVals = sheetRows[r];
      const alenCode = get(rowVals, 'ALENOTOMATURUNKODU');
      if (alenCode === '') continue; // bos satir ya da urun kodu olmayan (serbest not) satir
      total += 1;
      const excelRow = rowNumbers[r];
      const key = foldTr(alenCode);
      if (!this.planning.db.getProduct(key)) { noProduct += 1; warn(`Satır ${excelRow}: ürün kartı yok (${alenCode}), atlandı.`); continue; }

      const parseCell = (raw, label) => {
        const t = String(raw ?? '').trim();
        if (t === '') return null;
        const ms = parseDate(t);
        if (ms === null) warn(`Satır ${excelRow}: ${label} okunamadı ("${t}"), boş geçildi.`);
        return ms;
      };
      const kayitTarihi = parseCell(get(rowVals, 'ALENOTOMATKAYITTARIHI'), 'kayıt tarihi');
      const yayinTarihi = parseCell(get(rowVals, 'YAYINTARIHI'), 'yayın tarihi');
      const revTarihi = parseCell(get(rowVals, 'REVTARIHI'), 'rev. tarihi');
      const revNoRaw = get(rowVals, 'REVNO');
      const revNo = revNoRaw === '' ? 0 : Number(revNoRaw);
      const fields = {
        musteri: get(rowVals, 'MUSTERI') || null, resimNo: get(rowVals, 'RESIMNO') || null, kayitTarihi,
        revNo: Number.isInteger(revNo) && revNo >= 0 ? revNo : 0, yayinTarihi, revTarihi,
        tutuldugu: get(rowVals, 'TUTULDUGUORTAM') || null, durumu: get(rowVals, 'DURUMU') || null,
        revizyonNedeni: get(rowVals, 'REVIZYONNEDENI') || null,
      };
      const sortAt = revTarihi ?? yayinTarihi ?? kayitTarihi ?? 0;
      const prev = byCode.get(key);
      if (prev) {
        duplicates += 1;
        warn(`Satır ${excelRow}: Alen kodu "${alenCode}" yinelenen (önceki: satır ${prev.excelRow}), eski olan atlandı.`);
        if (sortAt <= prev.sortAt) continue;
      }
      byCode.set(key, { excelRow, codeKey: key, fields, sortAt });
    }

    for (const { codeKey, fields } of byCode.values()) this.#write(codeKey, { ...DEFAULTS, ...fields }, { by, now });
    return { total, matched: byCode.size, duplicates, noProduct, warnings };
  }
}
