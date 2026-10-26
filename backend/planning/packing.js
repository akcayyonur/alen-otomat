/**
 * PAKETLEME FORMU (EYS.FR.007) - kagit formun dijital karsiligi. Her sey ALEN OTOMAT URUN KODU uzerinden ilerler: vardiya sayfasinda her satir bir urunun
 * paketlenmesidir (operator, urun, is emri, koli sayisi, koli ici adet, yarim koli adedi, %100 gorsel kontrol, hurda adedi); sayfa basliginda tarih, vardiya ve
 * hava basinc gosterge degeri (bar) vardir.
 *
 * KOLI ICI ADET: bir urunun kutusuna giren adet genelde SABITTIR. Urunun ilk koli paketlenisi "standart koli ici adet"i urun kartina yazar (bir kere; kart
 * "elle duzenlendi" sayilmaz); sonraki paketlemelerde ONERI olarak gelir. Kutuya bazen 10-15 adet fazla sikistirilir, fazlasi yarim koli olur: satirdaki adet
 * serbestce degistirilir, standart degismez (urun kartindan elle degistirilir). Son paketlemelerde sik gorulen degerler de onerilir.
 *
 *   toplam = koli sayisi x koli ici adet + yarim koli adedi
 *
 * Kayit SILINMEZ: iptal edilen satir (neden, kim, ne zaman) sayfada gorunmez ama tabloda durur. Is emrine bagli satirlar is emri ayrintisinda toplanir.
 */
import { PlanningError } from './errors.js';
import { SHIFTS, parseDateKey, shiftOf } from '../../shared/shifts.js';
import { foldTr, resolveCustomerCode } from './normalize.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS packing_sheets (
  day        TEXT NOT NULL,
  shift      TEXT NOT NULL,
  air_bar    REAL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (day, shift)
);

CREATE TABLE IF NOT EXISTS packing_rows (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  day           TEXT    NOT NULL,
  shift         TEXT    NOT NULL,
  operator      TEXT    NOT NULL,
  code_key      TEXT    NOT NULL,
  stock_code    TEXT    NOT NULL,
  product_name  TEXT,
  customer_code TEXT,
  wo_no         TEXT,
  boxes         INTEGER NOT NULL DEFAULT 0,
  box_qty       INTEGER NOT NULL DEFAULT 0,
  half_qty      INTEGER,
  visual_check  INTEGER NOT NULL DEFAULT 0,
  scrap_qty     INTEGER,
  note          TEXT,
  created_at    INTEGER NOT NULL,
  created_by    TEXT,
  updated_at    INTEGER NOT NULL,
  updated_by    TEXT,
  voided_at     INTEGER,
  voided_by     TEXT,
  void_reason   TEXT
);
CREATE INDEX IF NOT EXISTS idx_packing_rows_sheet ON packing_rows (day, shift);
CREATE INDEX IF NOT EXISTS idx_packing_rows_code ON packing_rows (code_key, id);
CREATE INDEX IF NOT EXISTS idx_packing_rows_wo ON packing_rows (wo_no);
`;

const MAX_BOXES = 100_000;
/** Dosyanin geldigi klasorun adi (etiketler musteri klasorlerinde durur); kok dizindeyse bos. */
const parentFolder = (rel) => { const parts = String(rel ?? '').split(/[\\/]/); return parts.length > 1 ? parts[parts.length - 2] : ''; };
const MAX_QTY = 1_000_000;

/** Bos -> null; tam sayi, 0..max degilse hata. */
function whole(value, label, max, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new PlanningError(`${label} girilmeli.`);
    return null;
  }
  const n = typeof value === 'number' ? value : Number(String(value).replace(/\s/g, '').replace(',', '.'));
  if (!Number.isInteger(n) || n < 0 || n > max) throw new PlanningError(`${label} 0 ile ${max.toLocaleString('tr-TR')} arasında bir tam sayı olmalı.`);
  return n;
}

function text(value, label, max) {
  const t = String(value ?? '').trim();
  if (t.length > max) throw new PlanningError(`${label} en fazla ${max} karakter olabilir.`);
  return t === '' ? null : t;
}

const rowOut = (r) => ({
  id: Number(r.id), day: r.day, shift: r.shift, operator: r.operator, stockCode: r.stock_code, productName: r.product_name, customerCode: r.customer_code,
  woNo: r.wo_no, boxes: Number(r.boxes), boxQty: Number(r.box_qty), halfQty: r.half_qty == null ? null : Number(r.half_qty), visualCheck: r.visual_check === 1,
  scrapQty: r.scrap_qty == null ? null : Number(r.scrap_qty), note: r.note, total: Number(r.boxes) * Number(r.box_qty) + (r.half_qty == null ? 0 : Number(r.half_qty)),
  createdAt: Number(r.created_at), createdBy: r.created_by, updatedAt: Number(r.updated_at), updatedBy: r.updated_by,
});

export class Packing {
  /** @param {{planning: import('./planning.js').Planning}} deps */
  constructor({ planning }) {
    this.planning = planning;
    this.db = planning.db.db;
    this.db.exec(SCHEMA);
  }

  #shift(id) {
    const s = SHIFTS.find((x) => x.id === id);
    if (!s) throw new PlanningError(`Vardiya ${SHIFTS.map((x) => x.id).join(' ya da ')} olmalı.`);
    return s;
  }

  #day(date) {
    if (!parseDateKey(date)) throw new PlanningError('Tarih yyyy-aa-gg biçiminde olmalı.');
    return date;
  }

  /** Verilmeyen tarih/vardiya = su anki uretim gunu ve vardiyasi. */
  #where({ day, shift }, now) {
    const w = shiftOf(now);
    const d = this.#day(day ?? w.date);
    const s = this.#shift(shift ?? w.id);
    return { day: d, shift: s.id, shiftLabel: s.label, current: { day: w.date, shift: w.id } };
  }

  /**
   * Bir vardiyanin paketleme sayfasi: baslik (hava basinci) + iptal edilmemis satirlar + toplamlar.
   * @param {{day?: string, shift?: string}} [q]
   */
  sheet(q = {}, { now = Date.now() } = {}) {
    const w = this.#where(q, now);
    const head = this.db.prepare('SELECT air_bar, updated_at, updated_by FROM packing_sheets WHERE day = ? AND shift = ?').get(w.day, w.shift);
    const rows = this.db.prepare('SELECT * FROM packing_rows WHERE day = ? AND shift = ? AND voided_at IS NULL ORDER BY id').all(w.day, w.shift).map(rowOut);
    return {
      ...w, airBar: head?.air_bar ?? null, airBarBy: head?.updated_by ?? null, rows,
      totals: {
        rows: rows.length, boxes: rows.reduce((s, r) => s + r.boxes, 0), pieces: rows.reduce((s, r) => s + r.total, 0), scrap: rows.reduce((s, r) => s + (r.scrapQty ?? 0), 0),
      },
    };
  }

  /** Sayfa basligindaki hava basinc gosterge degeri (bar; bos = silinir). */
  setAirBar({ day, shift, airBar }, { by = null, now = Date.now() } = {}) {
    const w = this.#where({ day, shift }, now);
    let v = null;
    if (airBar !== null && airBar !== undefined && airBar !== '') {
      v = Number(String(airBar).replace(',', '.'));
      if (!Number.isFinite(v) || v < 0 || v > 20) throw new PlanningError('Hava basıncı 0 ile 20 bar arasında olmalı.');
    }
    this.db.prepare(
      `INSERT INTO packing_sheets (day, shift, air_bar, updated_at, updated_by) VALUES (?,?,?,?,?)
       ON CONFLICT(day, shift) DO UPDATE SET air_bar = excluded.air_bar, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).run(w.day, w.shift, v, now, by);
    return this.sheet({ day: w.day, shift: w.shift }, { now });
  }

  #product(stockCode) {
    const code = String(stockCode ?? '').trim();
    if (code === '') throw new PlanningError('Ürün (Alen Otomat ürün kodu) seçilmeli.');
    const p = this.planning.db.getProduct(foldTr(code));
    if (!p) throw new PlanningError(`${code} için ürün kartı yok. Önce Ürün kartları sekmesinden kartı açın.`, 404, 'no-product');
    return p;
  }

  /** Satir alanlarini dogrular (ekleme ve duzeltme ayni kurallar). @returns {object} veritabani degerleri */
  #fields(input, product) {
    const operator = text(input.operator, 'Operatör ismi', 60);
    if (operator === null) throw new PlanningError('Operatör ismi girilmeli.');
    const boxes = whole(input.boxes, 'Koli sayısı', MAX_BOXES) ?? 0;
    const boxQty = whole(input.boxQty, 'Koli içi adet', MAX_QTY) ?? 0;
    const halfQty = whole(input.halfQty, 'Yarım koli adedi', MAX_QTY);
    const scrapQty = whole(input.scrapQty, 'Hurda adedi', MAX_QTY);
    if (boxes > 0 && boxQty <= 0) throw new PlanningError('Koli sayısı girildi: koli içi adet de girilmeli.');
    if (boxes * boxQty + (halfQty ?? 0) === 0 && !(scrapQty > 0)) throw new PlanningError('Adet girilmedi: koli sayısı ve koli içi adet, yarım koli ya da hurda adedi girin.');
    let woNo = text(input.woNo, 'İş emri no', 10);
    if (woNo !== null) {
      const w = this.planning.db.getWorkOrder(woNo);
      if (!w) throw new PlanningError(`İş emri bulunamadı: ${woNo}`, 404);
      if (w.codeKey !== product.codeKey) throw new PlanningError(`${woNo} iş emri başka bir ürüne ait (${w.stockCode}).`, 409, 'wo-mismatch');
      woNo = w.no;
    }
    return { operator, boxes, boxQty, halfQty, scrapQty, visualCheck: input.visualCheck === true ? 1 : 0, note: text(input.note, 'Not', 200), woNo };
  }

  /**
   * Sayfaya satir ekler. Urunun standart koli ici adedi yoksa ve en az bir tam koli yapildiysa BU degeri standart olarak urun kartina yazar (`learned`).
   * @param {{day?: string, shift?: string, stockCode: string, operator: string, woNo?: string, boxes?: number, boxQty?: number, halfQty?: number,
   *          visualCheck?: boolean, scrapQty?: number, note?: string}} input
   */
  addRow(input, { by = null, now = Date.now() } = {}) {
    const w = this.#where(input, now);
    const product = this.#product(input.stockCode);
    const f = this.#fields(input, product);
    const id = Number(this.db.prepare(
      `INSERT INTO packing_rows (day, shift, operator, code_key, stock_code, product_name, customer_code, wo_no, boxes, box_qty, half_qty, visual_check, scrap_qty, note,
                                 created_at, created_by, updated_at, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(w.day, w.shift, f.operator, product.codeKey, product.stockCode, product.name, resolveCustomerCode(product.customerCode, product.name), f.woNo, f.boxes, f.boxQty,
      f.halfQty, f.visualCheck, f.scrapQty, f.note, now, by, now, by).lastInsertRowid);
    const learned = f.boxes >= 1 && f.boxQty > 0 && this.planning.db.setBoxQtyIfEmpty(product.codeKey, f.boxQty, now);
    return { ...rowOut(this.db.prepare('SELECT * FROM packing_rows WHERE id = ?').get(id)), learned, standardBoxQty: this.planning.db.getProduct(product.codeKey).boxQty };
  }

  #row(id) {
    const r = this.db.prepare('SELECT * FROM packing_rows WHERE id = ?').get(Number(id));
    if (!r || r.voided_at != null) throw new PlanningError('Paketleme satırı bulunamadı.', 404);
    return r;
  }

  /** Satiri duzeltir (urun degismez: yanlis urunse satiri iptal edip yenisini ekleyin). */
  updateRow(id, input, { by = null, now = Date.now() } = {}) {
    const cur = this.#row(id);
    const product = this.planning.db.getProduct(cur.code_key) ?? this.#product(cur.stock_code);
    const f = this.#fields({ ...rowOut(cur), operator: cur.operator, ...input }, product);
    this.db.prepare(
      `UPDATE packing_rows SET operator=?, wo_no=?, boxes=?, box_qty=?, half_qty=?, visual_check=?, scrap_qty=?, note=?, updated_at=?, updated_by=? WHERE id=?`,
    ).run(f.operator, f.woNo, f.boxes, f.boxQty, f.halfQty, f.visualCheck, f.scrapQty, f.note, now, by, cur.id);
    return rowOut(this.db.prepare('SELECT * FROM packing_rows WHERE id = ?').get(cur.id));
  }

  /** Satiri iptal eder (silinmez). */
  voidRow(id, { reason = '' } = {}, { by = null, now = Date.now() } = {}) {
    const cur = this.#row(id);
    const why = text(reason, 'Neden', 200);
    this.db.prepare('UPDATE packing_rows SET voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ?').run(now, by, why, cur.id);
    return { id: cur.id, voided: true };
  }

  /**
   * Bir urun secilince ekrana gelenler: urunun standart koli ici adedi, son paketlemelerde sik gorulen degerler, secilebilecek is emirleri ve etiket dosyalari.
   */
  suggest(stockCode) {
    const p = this.#product(stockCode);
    const common = this.db.prepare(
      `SELECT box_qty, COUNT(*) AS n FROM (SELECT box_qty FROM packing_rows WHERE code_key = ? AND voided_at IS NULL AND boxes > 0 AND box_qty > 0 ORDER BY id DESC LIMIT 12)
        GROUP BY box_qty ORDER BY n DESC, box_qty DESC LIMIT 5`,
    ).all(p.codeKey).map((r) => ({ boxQty: Number(r.box_qty), count: Number(r.n) }));
    const rank = { uretimde: 0, bitti: 1, planlandi: 2 };
    const orders = this.db.prepare(
      `SELECT no, status, target_qty, machine_id, started_at, finished_at FROM work_orders WHERE code_key = ? AND status <> 'iptal' ORDER BY created_at DESC, no DESC LIMIT 15`,
    ).all(p.codeKey).map((r) => ({
      no: r.no, status: r.status, targetQty: Number(r.target_qty), machineId: r.machine_id === '' ? null : r.machine_id,
      startedAt: r.started_at == null ? null : Number(r.started_at), finishedAt: r.finished_at == null ? null : Number(r.finished_at),
    })).sort((a, b) => rank[a.status] - rank[b.status] || (b.startedAt ?? 0) - (a.startedAt ?? 0));
    const stickers = this.planning.quality.db.productFiles(p.codeKey, 'etiket').map((f) => ({ id: f.id, name: f.name, size: f.size, folder: parentFolder(f.relPath) }));
    return { stockCode: p.stockCode, name: p.name, customerCode: resolveCustomerCode(p.customerCode, p.name), boxQty: p.boxQty, common, orders, stickers };
  }

  /** Bir iş emrine bağlı paketleme satırlarının toplamı (iş emri ayrıntısı). */
  forWorkOrder(woNo) {
    const r = this.db.prepare(
      `SELECT COUNT(*) AS rows, COALESCE(SUM(boxes), 0) AS boxes, COALESCE(SUM(boxes * box_qty + COALESCE(half_qty, 0)), 0) AS pieces, COALESCE(SUM(scrap_qty), 0) AS scrap
         FROM packing_rows WHERE wo_no = ? AND voided_at IS NULL`,
    ).get(woNo);
    return { rows: Number(r.rows), boxes: Number(r.boxes), pieces: Number(r.pieces), scrap: Number(r.scrap) };
  }
}
