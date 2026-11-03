/**
 * NUMUNE TAKİP (EYS.FR.012 "Numune Talep / Takip Formu"): müşteriye numune üretilip gönderilmesi ve müşteriden
 * gelen onay/ret geri bildiriminin takibi. Ürün kartı (ya da hatta Alen ürün kodu) henüz hiç olmayabilir — bu
 * BİLİNÇLİ: `products` tablosuyla HİÇ BAĞLANMAZ (Fiyat çalışması ile aynı ilke: ürün kartı sonra, elle açılır).
 *
 * Kâğıt formdaki "KALİTE KONTROL RAPOR NO" alanı yanlış adlandırılmış: aslında GKK rapor no'dur (kullanıcı
 * teyidi, 2026-11-02) — burada `gkkReportNo` olarak tutulur, openGkkPicker ile aynı listeden seçilebilir.
 *
 * Akış: "Yeni numune formu aç" → NUMUNE TANIMLAMA + NUMUNE ÜRETİM BİLGİLERİ alanları girilir (çoğu isteğe bağlı,
 * zamanla doldurulur: usta üretip gönderince üretim/gönderim alanlarını siz ya da usta doldurur) → form basılıp
 * müşteriye gönderilir (fiziksel; e-posta ile gelen müşteri geri bildirimi SONRADAN elle girilir) → "Düzenle"den
 * MÜŞTERİ GERİ BİLDİRİM + onaylandı/onaylanmadı işaretlenir → satır rengi yeşil/kırmızı (ikon+etiket de var, renk
 * tek başına değil).
 */
import { PlanningError } from './errors.js';
import { foldTr } from './normalize.js';
import { text, number, day } from './fields.js';

export const STATUS = Object.freeze(['bekliyor', 'onaylandi', 'reddedildi']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sample_requests (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  seq                  INTEGER NOT NULL UNIQUE,
  code                 TEXT    NOT NULL UNIQUE,
  requested_on         INTEGER NOT NULL,
  customer             TEXT    NOT NULL,
  customer_sample_code TEXT,
  customer_code        TEXT,
  stock_code           TEXT,
  sample_qty           TEXT,
  due_date             INTEGER,
  quote_net_g          REAL,
  sample_net_g         REAL,
  production_sec       REAL,
  material             TEXT,
  alt_material         TEXT,
  gauges               TEXT,
  produced_qty         INTEGER,
  sample_set_qty       INTEGER,
  produced_on          INTEGER,
  gkk_report_no        TEXT,
  sent_qty             INTEGER,
  customer_feedback    TEXT,
  status               TEXT    NOT NULL DEFAULT 'bekliyor',
  decided_on           INTEGER,
  decision_note        TEXT,
  note                 TEXT,
  search_key           TEXT    NOT NULL,
  created_at           INTEGER NOT NULL,
  created_by           TEXT,
  updated_at           INTEGER NOT NULL,
  updated_by           TEXT
);
CREATE INDEX IF NOT EXISTS idx_samples_status ON sample_requests (status, id DESC);
CREATE INDEX IF NOT EXISTS idx_samples_search ON sample_requests (search_key);

-- counters: quality-db.js'teki AYNI tablo (ayni veritabani baglantisi); burada da IF NOT EXISTS ile kurulur ki
-- bu modul hangi sirada ilklendirilirse ilklendirilsin kendi basina calissin (baska bir modulun init sirasina bagli olmasin).
CREATE TABLE IF NOT EXISTS counters (
  name  TEXT    NOT NULL,
  year  INTEGER NOT NULL,
  floor INTEGER NOT NULL,
  PRIMARY KEY (name, year)
);
`;

const n = (v) => (v == null ? null : Number(v));
const fmtCode = (seq) => String(seq).padStart(6, '0');
const localMidnight = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };

const row = (r) => (r == null ? null : {
  id: Number(r.id), seq: Number(r.seq), code: r.code, requestedOn: Number(r.requested_on), customer: r.customer,
  customerSampleCode: r.customer_sample_code, customerCode: r.customer_code, stockCode: r.stock_code, sampleQty: r.sample_qty,
  dueDate: n(r.due_date), quoteNetG: n(r.quote_net_g), sampleNetG: n(r.sample_net_g), productionSec: n(r.production_sec),
  material: r.material, altMaterial: r.alt_material, gauges: r.gauges, producedQty: n(r.produced_qty), sampleSetQty: n(r.sample_set_qty),
  producedOn: n(r.produced_on), gkkReportNo: r.gkk_report_no, sentQty: n(r.sent_qty), customerFeedback: r.customer_feedback,
  status: r.status, decidedOn: n(r.decided_on), decisionNote: r.decision_note, note: r.note,
  createdAt: Number(r.created_at), createdBy: r.created_by, updatedAt: Number(r.updated_at), updatedBy: r.updated_by,
});

export class SampleTracking {
  /** @param {{planning: import('./planning.js').Planning}} deps */
  constructor({ planning }) {
    this.planning = planning;
    this.db = planning.db.db; // ayni sqlite baglantisi
    this.db.exec(SCHEMA);
  }

  /* --------------------------------------------------------------------------- numaralandirma */

  /** Siradaki numune kodu (kagit formdaki "SERI NO": 6 haneli, yil YOK - K000001 tarzi duz sira). */
  nextSeq() {
    const floor = Number(this.db.prepare('SELECT floor FROM counters WHERE name = ? AND year = 0').get('numune')?.floor ?? 0);
    const max = Number(this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM sample_requests').get().m);
    const next = Math.max(floor, max) + 1;
    return { floor, max, next, nextCode: fmtCode(next) };
  }

  /** "En son verilen numara" tabani (kagitta onceden basilmis numaralarla cakismasin); yalniz yukseltilebilir. */
  setSequence(last) {
    const seq = Number(String(last ?? '').trim());
    if (!Number.isInteger(seq) || seq < 0 || seq > 999_999) throw new PlanningError('Sıra 0 ile 999999 arasında bir tam sayı olmalı.');
    const { max } = this.nextSeq();
    if (seq < max) throw new PlanningError(`${fmtCode(max)} numarasına kadar zaten kayıt var.`, 409);
    this.db.prepare('INSERT INTO counters (name, year, floor) VALUES (?,0,?) ON CONFLICT(name, year) DO UPDATE SET floor = MAX(floor, excluded.floor)').run('numune', seq);
    return this.nextSeq();
  }

  /* --------------------------------------------------------------------------------- liste / kayit */

  /** @param {{q?: string, status?: string, limit?: number, offset?: number}} [f] */
  list({ q = '', status = '', limit = 200, offset = 0 } = {}) {
    const conds = [];
    const args = [];
    if (q.trim() !== '') { conds.push("search_key LIKE ? ESCAPE '\\'"); args.push(`%${foldTr(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`); }
    if (STATUS.includes(status)) { conds.push('status = ?'); args.push(status); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM sample_requests ${where}`).get(...args).n);
    const items = this.db.prepare(`SELECT * FROM sample_requests ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset).map(row);
    return { total, items, next: this.nextSeq() };
  }

  get(id) {
    const r = this.db.prepare('SELECT * FROM sample_requests WHERE id = ?').get(Number(id));
    if (!r) throw new PlanningError('Numune kaydı bulunamadı.', 404);
    return row(r);
  }

  #searchKey(f) {
    return foldTr([f.customer, f.customerSampleCode, f.customerCode, f.stockCode, f.code].filter(Boolean).join(' '));
  }

  /** Alanları doğrular (kısmi: yalnız gönderilen anahtarlar). @param {boolean} partial */
  #fields(input, { partial = false, now = Date.now() } = {}) {
    const out = {};
    const has = (k) => Object.hasOwn(input, k);
    if (!partial || has('customer')) {
      const customer = text(input.customer, 'Müşteri', 120);
      if (!customer) throw new PlanningError('Müşteri gerekli.');
      out.customer = customer;
    }
    if (!partial || has('requestedOn')) {
      const d = day(input.requestedOn, 'Tarih');
      if (partial) { if (d != null) out.requestedOn = d; } // bos gonderilirse dokunulmaz (NOT NULL alan temizlenemez)
      else out.requestedOn = d ?? localMidnight(now);
    }
    if (has('customerSampleCode')) out.customerSampleCode = text(input.customerSampleCode, 'Müşteri numune kodu', 60);
    if (has('customerCode')) out.customerCode = text(input.customerCode, 'Müşteri ürün kodu', 60);
    if (has('stockCode')) out.stockCode = text(input.stockCode, 'Alen ürün kodu', 40);
    if (has('sampleQty')) out.sampleQty = text(input.sampleQty, 'Numune miktarı', 40);
    if (has('dueDate')) out.dueDate = day(input.dueDate, 'Teslim tarihi');
    if (has('quoteNetG')) out.quoteNetG = number(input.quoteNetG, 'Fiyat teklif net ağırlığı', { max: 100_000 });
    if (has('sampleNetG')) out.sampleNetG = number(input.sampleNetG, 'Numune net ağırlığı', { max: 100_000 });
    if (has('productionSec')) out.productionSec = number(input.productionSec, 'Üretim süresi', { max: 36_000 });
    if (has('material')) out.material = text(input.material, 'Hammadde', 80);
    if (has('altMaterial')) out.altMaterial = text(input.altMaterial, 'Alternatif hammadde', 80);
    if (has('gauges')) out.gauges = text(input.gauges, 'Kullanılan mastar/lar', 120);
    if (has('producedQty')) out.producedQty = input.producedQty === null || input.producedQty === '' ? null : intOrThrow(input.producedQty, 'Üretim miktarı');
    if (has('sampleSetQty')) out.sampleSetQty = input.sampleSetQty === null || input.sampleSetQty === '' ? null : intOrThrow(input.sampleSetQty, 'Ayrılan örnek miktarı');
    if (has('producedOn')) out.producedOn = day(input.producedOn, 'Üretim tarihi');
    if (has('gkkReportNo')) out.gkkReportNo = text(input.gkkReportNo, 'GKK rapor no', 40);
    if (has('sentQty')) out.sentQty = input.sentQty === null || input.sentQty === '' ? null : intOrThrow(input.sentQty, 'Gönderilen miktar');
    if (has('customerFeedback')) out.customerFeedback = text(input.customerFeedback, 'Müşteri geri bildirim', 2000);
    if (has('note')) out.note = text(input.note, 'Not', 500);
    return out;
  }

  /** Yeni numune formu ("Yeni numune formu aç"). Yalnız müşteri zorunlu; geri kalan alanlar sonradan doldurulabilir. */
  create(input = {}, { by = null, now = Date.now() } = {}) {
    const f = this.#fields(input, { now });
    const { next, nextCode } = this.nextSeq();
    const id = Number(this.db.prepare(
      `INSERT INTO sample_requests (seq, code, requested_on, customer, customer_sample_code, customer_code, stock_code, sample_qty, due_date,
        quote_net_g, sample_net_g, production_sec, material, alt_material, gauges, produced_qty, sample_set_qty, produced_on, gkk_report_no,
        sent_qty, customer_feedback, status, note, search_key, created_at, created_by, updated_at, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'bekliyor',?,?,?,?,?,?)`,
    ).run(
      next, nextCode, f.requestedOn, f.customer, f.customerSampleCode ?? null, f.customerCode ?? null, f.stockCode ?? null, f.sampleQty ?? null,
      f.dueDate ?? null, f.quoteNetG ?? null, f.sampleNetG ?? null, f.productionSec ?? null, f.material ?? null, f.altMaterial ?? null,
      f.gauges ?? null, f.producedQty ?? null, f.sampleSetQty ?? null, f.producedOn ?? null, f.gkkReportNo ?? null, f.sentQty ?? null,
      f.customerFeedback ?? null, f.note ?? null, this.#searchKey({ ...f, code: nextCode }), now, by, now, by,
    ).lastInsertRowid);
    return this.get(id);
  }

  /** Alanları günceller (iş emri "Düzenle"siyle aynı mantık: yalnız gönderilen alanlar değişir). Onaylandı/reddedildi olmuş kayıt da düzenlenebilir (müşteri bilgisi düzeltmek için). */
  update(id, input = {}, { by = null, now = Date.now() } = {}) {
    const cur = this.get(id);
    const f = this.#fields(input, { partial: true });
    if (Object.keys(f).length === 0) return cur;
    const next = { ...cur, ...f };
    const cols = [];
    const args = [];
    const map = {
      requestedOn: 'requested_on', customer: 'customer', customerSampleCode: 'customer_sample_code', customerCode: 'customer_code',
      stockCode: 'stock_code', sampleQty: 'sample_qty', dueDate: 'due_date', quoteNetG: 'quote_net_g', sampleNetG: 'sample_net_g',
      productionSec: 'production_sec', material: 'material', altMaterial: 'alt_material', gauges: 'gauges', producedQty: 'produced_qty',
      sampleSetQty: 'sample_set_qty', producedOn: 'produced_on', gkkReportNo: 'gkk_report_no', sentQty: 'sent_qty',
      customerFeedback: 'customer_feedback', note: 'note',
    };
    for (const [k, col] of Object.entries(map)) { if (Object.hasOwn(f, k)) { cols.push(`${col} = ?`); args.push(f[k] ?? null); } }
    cols.push('search_key = ?'); args.push(this.#searchKey(next));
    cols.push('updated_at = ?', 'updated_by = ?'); args.push(now, by);
    this.db.prepare(`UPDATE sample_requests SET ${cols.join(', ')} WHERE id = ?`).run(...args, Number(id));
    return this.get(id);
  }

  /** Müşteriden gelen karar (e-posta ile gelir, elle girilir): onaylandı ya da onaylanmadı. @param {{status: 'onaylandi'|'reddedildi', decidedOn?: any, note?: string}} input */
  decide(id, input = {}, { by = null, now = Date.now() } = {}) {
    this.get(id);
    if (input.status !== 'onaylandi' && input.status !== 'reddedildi') throw new PlanningError('Durum "onaylandi" ya da "reddedildi" olmalı.');
    const decidedOn = day(input.decidedOn, 'Karar tarihi') ?? localMidnight(now);
    const note = text(input.note, 'Açıklama', 1000);
    this.db.prepare('UPDATE sample_requests SET status = ?, decided_on = ?, decision_note = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .run(input.status, decidedOn, note, now, by, Number(id));
    return this.get(id);
  }

  /** Yanlışlıkla işaretlenen kararı geri al (yeniden "bekliyor" olur). */
  reopen(id, { by = null, now = Date.now() } = {}) {
    const cur = this.get(id);
    if (cur.status === 'bekliyor') return cur;
    this.db.prepare('UPDATE sample_requests SET status = ?, decided_on = NULL, decision_note = NULL, updated_at = ?, updated_by = ? WHERE id = ?')
      .run('bekliyor', now, by, Number(id));
    return this.get(id);
  }

  /** Yanlış açılmış kaydı sil (yalnız yönetici; onay/ret kararı verilmiş bir kayıt da silinebilir - geçmiş kayıt değil, bu bir form). */
  delete(id) {
    this.get(id);
    this.db.prepare('DELETE FROM sample_requests WHERE id = ?').run(Number(id));
    return { ok: true };
  }
}

function intOrThrow(value, label) {
  const n2 = Number(String(value).trim().replace(/\./g, '').replace(',', '.'));
  if (!Number.isInteger(n2) || n2 < 0 || n2 > 10_000_000) throw new PlanningError(`${label} 0 ile 10.000.000 arasında bir tam sayı olmalı.`);
  return n2;
}
