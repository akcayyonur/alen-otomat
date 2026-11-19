/**
 * TAKIM VE PENS TAKİP (EYS.LS.026 "Pens ve Takım Takip Listesi" + ayrı bir "Takım Uçları ve Tutucuları"
 * dosyası): atölyenin kesici takım (matkap, kılavuz, freze, uç...), pens (kollet) ve takım tutucusu ENVANTERİ.
 *
 * `products` ile BAĞLANMAZ (Ölçüm Cihazları Takip/Numune Takip ile AYNI ilke): kategori SERBEST METİNdir —
 * yeni takım türleri KISITLANMADAN eklenebilmeli (ölçüm cihazlarındaki "yeniler de satın alınıyor" kararıyla
 * AYNI gerekçe).
 *
 * Gerçek EYS.LS.026 dosyası İKİ AYRI alt liste taşır (aynı çalışma kitabının iki sayfası):
 *   "… TAKIM TAKİP"  Marka/Kod/İsim/Stok/Kritik Stok/Açıklama (İsim = takım TÜRÜ, ör. "Matkap"/"Kılavuz")
 *   "… PENS TAKİP"   şekle göre YUVARLAK/ALTI KÖŞE/SEKİZ KÖŞE gruplu Ölçü/Adet/Not üçlüleri
 * AYRICA bağımsız "Takım Uçları ve Tutucuları" dosyası: Marka/Kodu/İsmi/Adet (sayfa adı — "Uçları" ya da
 * "Tutucular" — kategoriyi belirler, sütunlarda bir ayrım yok). Üçü de BU TEK tabloya aynı alan setiyle
 * normalize edilir (bkz. `parseTakimSheet`/`parsePensSheet`/`parseUcTutucuSheet`).
 *
 * Stok/kritik stok SERBEST METİNdir (sayı DEĞİL): gerçek dosyada bu sütunlarda "X" gibi sayısal olmayan
 * işaretler de var ("stok yok/tükendi" anlamında görünüyor) — zorla sayıya çevirmek bu bilgiyi kaybederdi.
 *
 * İçeri aktarmada DOĞAL bir benzersiz anahtar yok (Pens Takip'te "kod" sütunu hiç yok, aynı ölçü — ör. "AK13" —
 * BİRDEN FAZLA ayrı satırda, muhtemelen ayrı fiziksel parti olarak, gerçekten tekrar edebiliyor). Bu yüzden
 * dedup KAYIT SAYISINA göre: (kategori+tanım+marka+kod) anahtarı için veritabanında zaten KAÇ kayıt varsa, sayfadaki
 * aynı anahtarlı satırların İLK O KADARI "zaten var" sayılıp atlanır, FAZLASI yeni kayıt olur. Aynı dosyayı
 * iki kez yüklemek bu sayede güvenlidir (hiçbir satır tekrar eklenmez) ama gerçekten tekrar eden satırlar
 * (AK13 gibi) da veri kaybetmeden korunur.
 */
import { PlanningError } from './errors.js';
import { findHeaderByKeys, foldTr, headerKey } from './normalize.js';
import { text } from './fields.js';
import { XlsxError, readXlsx } from './xlsx-read.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tool_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  category     TEXT    NOT NULL,
  name         TEXT    NOT NULL,
  brand        TEXT,
  code         TEXT,
  qty          TEXT,
  critical_qty TEXT,
  note         TEXT,
  search_key   TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  created_by   TEXT,
  updated_at   INTEGER NOT NULL,
  updated_by   TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_items_category ON tool_items (category, name);
CREATE INDEX IF NOT EXISTS idx_tool_items_search ON tool_items (search_key);
`;

const row = (r) => (r == null ? null : {
  id: Number(r.id), category: r.category, name: r.name, brand: r.brand, code: r.code, qty: r.qty, criticalQty: r.critical_qty,
  note: r.note, createdAt: Number(r.created_at), createdBy: r.created_by, updatedAt: Number(r.updated_at), updatedBy: r.updated_by,
});

/** Esleme/dedup anahtari: kategori+tanim+marka+kod (foldTr ile). */
const dedupKey = (f) => [f.category, f.name, f.brand, f.code].map((v) => foldTr(v ?? '')).join('|');

/* ======================================================================== Excel icerik ayristirma (saf) */

/** "… TAKIM TAKİP" sayfası: Marka/Kod/İsim/Stok/Kritik Stok/Açıklama. İsim takım TÜRÜdür (kategori); Kod yoksa İsim adı da üstlenir. */
export function parseTakimSheet(rows, rowNumbers, found) {
  const { index, headerRow } = found;
  const get = (r, key) => (index.has(key) ? String(r[index.get(key)] ?? '').trim() : '');
  const records = [];
  for (let r = headerRow + 1; r < rows.length; r += 1) {
    const marka = get(rows[r], 'MARKA');
    const kod = get(rows[r], 'KOD');
    const isim = get(rows[r], 'ISIM');
    if (!marka && !kod && !isim) continue; // tamamen bos satir
    const name = kod || isim;
    if (!name) continue;
    records.push({
      category: isim || kod, name, brand: marka || null, code: kod || null,
      qty: get(rows[r], 'STOK') || null, criticalQty: get(rows[r], 'KRITIKSTOK') || null, note: get(rows[r], 'ACIKLAMA') || null,
      excelRow: rowNumbers[r],
    });
  }
  return records;
}

/** "Takım Uçları"/"Takım Tutucular" sayfası: Marka/Kodu/İsmi/Adet. Kategori sayfa ADINDAN gelir (sütunlarda ayrım yok). */
export function parseUcTutucuSheet(rows, rowNumbers, found, sheetName) {
  const { index, headerRow } = found;
  const get = (r, key) => (index.has(key) ? String(r[index.get(key)] ?? '').trim() : '');
  const category = foldTr(sheetName).includes('TUTUCU') ? 'Takım Tutucu' : 'Takım Ucu';
  const records = [];
  for (let r = headerRow + 1; r < rows.length; r += 1) {
    const marka = get(rows[r], 'MARKA');
    const kodu = get(rows[r], 'KODU');
    const ismi = get(rows[r], 'ISMI');
    if (!marka && !kodu && !ismi) continue;
    const name = ismi || kodu;
    if (!name) continue;
    records.push({ category, name, brand: marka || null, code: kodu || null, qty: get(rows[r], 'ADET') || null, criticalQty: null, note: null, excelRow: rowNumbers[r] });
  }
  return records;
}

const PENS_GROUP_LABEL = Object.freeze({ YUVARLAK: 'Yuvarlak', ALTIKOSE: 'Altı Köşe', SEKIZKOSE: 'Sekiz Köşe' });

/** Pens Takip sayfasındaki şekil gruplarını (grup adının olduğu satır + sütun) bulur; sub-başlık metnine bakmaz (Ölçü/Çap farkı önemsiz). */
function findPensGroups(rows, maxRows = 12) {
  for (let r = 0; r < Math.min(rows.length, maxRows); r += 1) {
    const groups = [];
    (rows[r] ?? []).forEach((cell, col) => {
      const label = PENS_GROUP_LABEL[headerKey(cell)];
      if (label) groups.push({ col, label });
    });
    if (groups.length > 0) return { groups, labelRow: r };
  }
  return null;
}

/**
 * Pens Takip sayfası: YUVARLAK/ALTI KÖŞE/SEKİZ KÖŞE grupları, her biri kendi Ölçü/Adet/Not üçlüsü (grup
 * etiketinin sütunundan +0/+1/+2). Gruplar BAĞIMSIZ uzunluktaki satırlara sahip olabilir (ör. Yuvarlak 30
 * satır, Sekiz Köşe 6 satır) — her satırda her grup AYRI ayrı kontrol edilir, boş olan grup o satırda atlanır.
 * Grup etiketi bulunamazsa (bu bir Pens Takip sayfası değilse) `null` döner.
 */
export function parsePensSheet(rows, rowNumbers) {
  const found = findPensGroups(rows);
  if (!found) return null;
  const { groups, labelRow } = found;
  const records = [];
  for (let r = labelRow + 2; r < rows.length; r += 1) {
    for (const g of groups) {
      const measure = String(rows[r]?.[g.col] ?? '').trim();
      if (measure === '') continue;
      const qty = String(rows[r]?.[g.col + 1] ?? '').trim();
      const note = String(rows[r]?.[g.col + 2] ?? '').trim();
      records.push({ category: `Pens - ${g.label}`, name: measure, brand: null, code: null, qty: qty || null, criticalQty: null, note: note || null, excelRow: rowNumbers[r] });
    }
  }
  return records;
}

export class ToolInventory {
  /** @param {{planning: import('./planning.js').Planning}} deps */
  constructor({ planning }) {
    this.planning = planning;
    this.db = planning.db.db; // ayni sqlite baglantisi
    this.db.exec(SCHEMA);
  }

  #searchKey(f) {
    return foldTr([f.category, f.name, f.brand, f.code, f.note].filter(Boolean).join(' '));
  }

  #fields(input, { partial = false } = {}) {
    const out = {};
    const has = (k) => Object.hasOwn(input, k);
    if (!partial || has('category')) {
      const v = text(input.category, 'Kategori', 80);
      if (!v) throw new PlanningError('Kategori gerekli.');
      out.category = v;
    }
    if (!partial || has('name')) {
      const v = text(input.name, 'Tanım', 200);
      if (!v) throw new PlanningError('Tanım gerekli.');
      out.name = v;
    }
    if (has('brand')) out.brand = text(input.brand, 'Marka', 80);
    if (has('code')) out.code = text(input.code, 'Kod', 150);
    if (has('qty')) out.qty = text(input.qty, 'Stok/Adet', 20);
    if (has('criticalQty')) out.criticalQty = text(input.criticalQty, 'Kritik stok', 20);
    if (has('note')) out.note = text(input.note, 'Açıklama', 500);
    return out;
  }

  /** @param {{q?: string, limit?: number, offset?: number}} [f] */
  list({ q = '', limit = 500, offset = 0 } = {}) {
    const conds = [];
    const args = [];
    if (q.trim() !== '') { conds.push("search_key LIKE ? ESCAPE '\\'"); args.push(`%${foldTr(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM tool_items ${where}`).get(...args).n);
    const items = this.db.prepare(`SELECT * FROM tool_items ${where} ORDER BY category, name LIMIT ? OFFSET ?`).all(...args, limit, offset).map(row);
    return { total, items };
  }

  /** Kayıtlı kategoriler (DISTINCT, alfabetik) — filtre açılır kutusu / öneri listesi için. */
  categories() {
    return this.db.prepare('SELECT DISTINCT category FROM tool_items ORDER BY category COLLATE NOCASE').all().map((r) => r.category);
  }

  get(id) {
    const r = this.db.prepare('SELECT * FROM tool_items WHERE id = ?').get(Number(id));
    if (!r) throw new PlanningError('Takım/pens kaydı bulunamadı.', 404);
    return row(r);
  }

  /** Yeni kayıt ekle. Yalnız kategori ve tanım zorunlu. */
  create(input = {}, { by = null, now = Date.now() } = {}) {
    const f = this.#fields(input);
    const id = Number(this.db.prepare(
      `INSERT INTO tool_items (category, name, brand, code, qty, critical_qty, note, search_key, created_at, created_by, updated_at, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(f.category, f.name, f.brand ?? null, f.code ?? null, f.qty ?? null, f.criticalQty ?? null, f.note ?? null, this.#searchKey(f), now, by, now, by)
      .lastInsertRowid);
    return this.get(id);
  }

  /** Alanları düzenler (yalnız gönderilenler değişir). */
  update(id, input = {}, { by = null, now = Date.now() } = {}) {
    const cur = this.get(id);
    const f = this.#fields(input, { partial: true });
    if (Object.keys(f).length === 0) return cur;
    const next = { ...cur, ...f };
    const cols = [];
    const args = [];
    const map = { category: 'category', name: 'name', brand: 'brand', code: 'code', qty: 'qty', criticalQty: 'critical_qty', note: 'note' };
    for (const [k, col] of Object.entries(map)) { if (Object.hasOwn(f, k)) { cols.push(`${col} = ?`); args.push(f[k] ?? null); } }
    cols.push('search_key = ?'); args.push(this.#searchKey(next));
    cols.push('updated_at = ?', 'updated_by = ?'); args.push(now, by);
    this.db.prepare(`UPDATE tool_items SET ${cols.join(', ')} WHERE id = ?`).run(...args, Number(id));
    return this.get(id);
  }

  /** Yanlış açılmış kaydı sil. Yalnız yönetici (kayıtsız uç → admin). */
  delete(id) {
    this.get(id);
    this.db.prepare('DELETE FROM tool_items WHERE id = ?').run(Number(id));
    return { ok: true };
  }

  /**
   * EYS.LS.026 ("… TAKIM TAKİP" + "… PENS TAKİP" sayfaları) ya da "Takım Uçları ve Tutucuları" dosyasını içeri
   * aktarır. Çalışma kitabındaki HER sayfa sırayla denenir (Takım Takip → Uç/Tutucu → Pens); tanınmayan sayfalar
   * sessizce atlanır (ör. boş yardımcı sayfalar, eski/yinelenen kopyalar — bkz. dosya başı dedup notu).
   * @returns {{totalRows: number, added: number, skipped: number, skippedSheets: string[], warnings: string[]}}
   */
  importXlsx(buffer, { by = null, now = Date.now() } = {}) {
    let book;
    try { book = readXlsx(buffer); } catch (err) { throw err instanceof XlsxError ? new PlanningError(err.message) : err; }

    const existingCounts = new Map();
    for (const r of this.db.prepare('SELECT category, name, brand, code FROM tool_items').all()) {
      const k = dedupKey(r);
      existingCounts.set(k, (existingCounts.get(k) ?? 0) + 1);
    }
    const consumed = new Map();

    let totalRows = 0;
    let added = 0;
    let skipped = 0;
    const skippedSheets = [];
    const warnings = [];
    const warn = (m) => { if (warnings.length < 25) warnings.push(m); else if (warnings.length === 25) warnings.push('… ve daha fazla uyarı var'); };
    let matchedAny = false;
    // Ayni calisma kitabinda BIREBIR ayni kategori kumesini ureten ikinci bir sayfa (ör. "Sayfa2": eski/yinelenen
    // bir calisma kopyasi, gercek EYS.LS.026 dosyasinda boyle bir sayfa bulundu) TAMAMEN atlanir. Tek-calistirmalik
    // sayim-bazli dedup (asagida) bunu COZEMEZ: ilk yukleme sirasinda veritabani bos oldugu icin "zaten var" sayisi
    // her iki sayfa icin de 0'dir, bu yuzden GERCEKTEN tekrar eden satirlar (ayni sayfadaki iki ayri "AK13" gibi)
    // ile FARKLI bir sayfadan gelen TAM KOPYA satirlar ayirt edilemez - bu ayrim yalniz sayfa seviyesinde yapilabilir.
    const seenCategorySets = new Set();

    for (const sheet of book.sheets) {
      const takimFound = findHeaderByKeys(sheet.rows, ['MARKA', 'KOD', 'ISIM', 'STOK']);
      const ucFound = !takimFound ? findHeaderByKeys(sheet.rows, ['MARKA', 'KODU', 'ISMI', 'ADET']) : null;
      const records = takimFound ? parseTakimSheet(sheet.rows, sheet.rowNumbers, takimFound)
        : ucFound ? parseUcTutucuSheet(sheet.rows, sheet.rowNumbers, ucFound, sheet.name)
          : parsePensSheet(sheet.rows, sheet.rowNumbers);
      if (!records) { skippedSheets.push(sheet.name); continue; }
      matchedAny = true;

      if (records.length > 0) {
        const categorySet = [...new Set(records.map((r) => foldTr(r.category)))].sort().join('\u0001');
        if (seenCategorySets.has(categorySet)) {
          warn(`"${sheet.name}" sayfası atlandı: aynı kategoriler başka bir sayfadan zaten işlendi (eski/yinelenen bir kopya olabilir).`);
          continue;
        }
        seenCategorySets.add(categorySet);
      }

      for (const rec of records) {
        totalRows += 1;
        const key = dedupKey(rec);
        const have = existingCounts.get(key) ?? 0;
        const used = consumed.get(key) ?? 0;
        if (used < have) { consumed.set(key, used + 1); skipped += 1; continue; }
        try {
          this.create(rec, { by, now });
        } catch (err) {
          skipped += 1;
          warn(`${sheet.name} · satır ${rec.excelRow}: ${err.message}`);
          continue;
        }
        consumed.set(key, used + 1);
        added += 1;
      }
    }
    if (!matchedAny) throw new PlanningError('Bu dosyada Takım/Pens Takip (EYS.LS.026) ya da Takım Uçları/Tutucuları başlıkları bulunamadı.');
    return { totalRows, added, skipped, skippedSheets, warnings };
  }
}
