/**
 * HURDA GİRİŞİ — Karantina Alanı Giriş-Çıkış Formu (EYS.FR.043) + Tashih Sonrası Tekrar Kontrol Formu (EYS.FR.049).
 *
 * Paketlemedeki hurdadan (`packing.js` `scrapQty`) AYRI bir süreç: ÜRETİM sırasında fark edilen hurda/uygunsuz
 * parça fiziksel karantina alanına çekilir. Giriş kaydı açılır (ürün tanımı, ürün tanıtım form numarası,
 * uygunsuzluk tanımı, giriş tarihi/personeli) → kayıt "açık" olarak listede durur → giriş ile çıkış arasında
 * sıfır ya da daha fazla TASHİH (düzeltme/rework) denemesi kaydedilebilir (EYS.FR.049: kim yaptı, ne yaptı, kaç
 * adette, kaçı OK kaçı hurda, kaç adam×saat) → son olarak "Çıkış yap" ile kayıt kapanır (çıkış nedeni/tarihi/personeli).
 *
 * `products` tablosuyla HİÇ BAĞLANMAZ (Numune Takip / Fiyat çalışması ile aynı ilke): kâğıt formdaki örneklerde
 * ürün tanımı çoğunlukla düz Mikro/müşteri stok kodu, her zaman Alen SR0xx.xxx biçiminde değil; serbest metin.
 * "Ürün tanıtım form numarası" da serbest metindir (genelde Ürün Tanıtım Kartı K0000xx numarasına işaret eder
 * ama kâğıt örneklerde başka biçimler de var) — ayrı bir sayaç/FK İCAT EDİLMEDİ.
 *
 * **Kalite biriminin fiilen tuttuğu HURDA ÜRÜN TAKİP LİSTESİ (EYS.LS.018) ile karşılaştırılıp eksik alanlar
 * eklendi** (2026-11-05, kullanıcı isteği: "bizim sistem doğru olsun"). Gerçek listedeki sütunlar bu kayıt
 * modeliyle giriş-çıkış+tashih akışını BOZMADAN, isteğe bağlı alanlar olarak genişletildi: `customer`/
 * `customerCode`/`stockCode` (`productLabel`in yanında, ürünü üç ayrı eksende tanımlar — gerçek listede üçü de
 * AYRI sütun), `detectedAt` (uygunsuzluk tespit yeri — gerçek veride "MÜŞTERİ"/"ÜRETİM"/"PAKETLEME" ve yazım
 * hatalı varyantlar (`ÜRETTİM`, `ÜRTİM`) görüldüğü için SERBEST METİN, sabit liste DEĞİL — bir enum eski kayıtları
 * reddederdi), `action` (yapılacak işlem — tek satırlık planlanan düzeltme, tashih geçmişinden AYRI: gerçek
 * listede birçok satırın hiç tashih kaydı yokken bile bu alan dolu), `batchQty`/`scrapQty` (parti/hurda miktarı —
 * GİRİŞ ANINDA bilinen toplam; `get()`'in `totals.scrapQty`'si tashih denemelerinden toplanan AYRI bir sayı,
 * ikisi KARIŞTIRILMASIN: gerçek listede çoğu satırda hiç tashih denemesi yokken bile hurda miktarı dolu),
 * `qualityCostTl` (kalitesizlik maliyeti, TL), `note` (açıklama — `issue`den AYRI genel not). Bu alanların hiçbiri
 * zorunlu değil (EYS.FR.043 formu bunları istemiyordu, EYS.LS.018 listesi ayrıca tutuyor); **EYS.LS.018 için ayrı
 * bir Excel içeri aktarma eklenmedi** (kullanıcı yalnız doğrulama istedi, EYS.LS.006'daki gibi bir "ilk kurulum
 * aktarımı" İSTEMEDİ).
 */
import { PlanningError } from './errors.js';
import { foldTr } from './normalize.js';
import { text, day } from './fields.js';

export const STATUS = Object.freeze(['acik', 'kapali']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS quarantine_entries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  product_label   TEXT    NOT NULL,
  card_no         TEXT,
  issue           TEXT    NOT NULL,
  customer        TEXT,
  customer_code   TEXT,
  stock_code      TEXT,
  detected_at     TEXT,
  action          TEXT,
  batch_qty       INTEGER,
  scrap_qty       INTEGER,
  quality_cost_tl REAL,
  note            TEXT,
  entered_on      INTEGER NOT NULL,
  entered_by      TEXT    NOT NULL,
  exit_reason     TEXT,
  exited_on       INTEGER,
  exited_by       TEXT,
  status          TEXT    NOT NULL DEFAULT 'acik',
  search_key      TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  created_by      TEXT,
  updated_at      INTEGER NOT NULL,
  updated_by      TEXT
);
CREATE INDEX IF NOT EXISTS idx_quarantine_status ON quarantine_entries (status, id DESC);
CREATE INDEX IF NOT EXISTS idx_quarantine_search ON quarantine_entries (search_key);

CREATE TABLE IF NOT EXISTS quarantine_corrections (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  quarantine_id INTEGER NOT NULL REFERENCES quarantine_entries(id),
  done_on       INTEGER NOT NULL,
  operator      TEXT    NOT NULL,
  description   TEXT    NOT NULL,
  qty           INTEGER NOT NULL,
  ok_qty        INTEGER,
  scrap_qty     INTEGER,
  man_hours     REAL,
  note          TEXT,
  created_at    INTEGER NOT NULL,
  created_by    TEXT
);
CREATE INDEX IF NOT EXISTS idx_quarantine_corr_entry ON quarantine_corrections (quarantine_id, id);
`;

const localMidnight = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };

/** Ayrı bir sayaç İCAT EDİLMEDİ: görüntü kodu doğrudan DB id'sinden türetilir (K000001/numune 6 hane ile aynı görünüm). */
const fmtCode = (id) => `H${String(id).padStart(6, '0')}`;

const entryRow = (r) => (r == null ? null : {
  id: Number(r.id), code: fmtCode(r.id), productLabel: r.product_label, cardNo: r.card_no, issue: r.issue,
  customer: r.customer, customerCode: r.customer_code, stockCode: r.stock_code, detectedAt: r.detected_at, action: r.action,
  batchQty: r.batch_qty == null ? null : Number(r.batch_qty), scrapQty: r.scrap_qty == null ? null : Number(r.scrap_qty),
  qualityCostTl: r.quality_cost_tl == null ? null : Number(r.quality_cost_tl), note: r.note,
  enteredOn: Number(r.entered_on), enteredBy: r.entered_by,
  exitReason: r.exit_reason, exitedOn: r.exited_on == null ? null : Number(r.exited_on), exitedBy: r.exited_by,
  status: r.status, createdAt: Number(r.created_at), createdBy: r.created_by, updatedAt: Number(r.updated_at), updatedBy: r.updated_by,
});

const corrRow = (r) => (r == null ? null : {
  id: Number(r.id), quarantineId: Number(r.quarantine_id), doneOn: Number(r.done_on), operator: r.operator, description: r.description,
  qty: Number(r.qty), okQty: r.ok_qty == null ? null : Number(r.ok_qty), scrapQty: r.scrap_qty == null ? null : Number(r.scrap_qty),
  manHours: r.man_hours == null ? null : Number(r.man_hours), note: r.note, createdAt: Number(r.created_at), createdBy: r.created_by,
});

function intRequired(value, label, { max = 1_000_000 } = {}) {
  const n = Number(String(value ?? '').trim().replace(/\./g, '').replace(',', '.'));
  if (!Number.isInteger(n) || n <= 0 || n > max) throw new PlanningError(`${label} 1 ile ${max} arasında bir tam sayı olmalı.`);
  return n;
}
function intOptional(value, label, { max = 1_000_000 } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(String(value).trim().replace(/\./g, '').replace(',', '.'));
  if (!Number.isInteger(n) || n < 0 || n > max) throw new PlanningError(`${label} 0 ile ${max} arasında bir tam sayı olmalı.`);
  return n;
}
function decOptional(value, label, { max = 10_000 } = {}) {
  if (value === undefined || value === null || value === '') return null;
  // Turkce yazim: virgul varsa binlik noktalari at ("12.500,50" -> 12500.5); virgul yoksa nokta ondalik ("12.5" -> 12.5)
  const s = String(value).trim();
  const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new PlanningError(`${label} 0 ile ${max} arasında bir sayı olmalı.`);
  return n;
}

export class Quarantine {
  /** @param {{planning: import('./planning.js').Planning}} deps */
  constructor({ planning }) {
    this.planning = planning;
    this.db = planning.db.db; // ayni sqlite baglantisi
    this.db.exec(SCHEMA);
    this.#migrate();
  }

  /** Eski veritabanlari (EYS.LS.018 alanlari eklenmeden once olusanlar): yeni sutunlar bos eklenir. */
  #migrate() {
    const have = new Set(this.db.prepare('PRAGMA table_info(quarantine_entries)').all().map((c) => c.name));
    const add = [
      ['customer', 'TEXT'], ['customer_code', 'TEXT'], ['stock_code', 'TEXT'], ['detected_at', 'TEXT'], ['action', 'TEXT'],
      ['batch_qty', 'INTEGER'], ['scrap_qty', 'INTEGER'], ['quality_cost_tl', 'REAL'], ['note', 'TEXT'],
    ];
    for (const [name, type] of add) if (!have.has(name)) this.db.exec(`ALTER TABLE quarantine_entries ADD COLUMN ${name} ${type}`);
  }

  /* --------------------------------------------------------------------------------- liste / kayit */

  #searchKey(f) {
    return foldTr([f.productLabel, f.cardNo, f.issue, f.customer, f.customerCode, f.stockCode].filter(Boolean).join(' '));
  }

  /** @param {{q?: string, status?: string, limit?: number, offset?: number}} [f] */
  list({ q = '', status = '', limit = 200, offset = 0 } = {}) {
    const conds = [];
    const args = [];
    if (q.trim() !== '') { conds.push("search_key LIKE ? ESCAPE '\\'"); args.push(`%${foldTr(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`); }
    if (STATUS.includes(status)) { conds.push('status = ?'); args.push(status); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM quarantine_entries ${where}`).get(...args).n);
    const items = this.db.prepare(`SELECT * FROM quarantine_entries ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset).map(entryRow);
    // liste satirinda tashih sayisi (kullanici "kac tashih yapildi" diye tek tek acmadan gorsun)
    const ids = items.map((i) => i.id);
    const counts = ids.length
      ? Object.fromEntries(this.db.prepare(`SELECT quarantine_id, COUNT(*) AS n FROM quarantine_corrections WHERE quarantine_id IN (${ids.map(() => '?').join(',')}) GROUP BY quarantine_id`).all(...ids).map((r) => [Number(r.quarantine_id), Number(r.n)]))
      : {};
    return { total, items: items.map((i) => ({ ...i, correctionCount: counts[i.id] ?? 0 })) };
  }

  /** Kayit + tashih gecmisi + toplamlar. */
  get(id) {
    const r = this.db.prepare('SELECT * FROM quarantine_entries WHERE id = ?').get(Number(id));
    if (!r) throw new PlanningError('Karantina kaydı bulunamadı.', 404);
    const corrections = this.db.prepare('SELECT * FROM quarantine_corrections WHERE quarantine_id = ? ORDER BY id').all(Number(id)).map(corrRow);
    const totals = corrections.reduce((s, c) => ({
      qty: s.qty + c.qty, okQty: s.okQty + (c.okQty ?? 0), scrapQty: s.scrapQty + (c.scrapQty ?? 0), manHours: s.manHours + (c.manHours ?? 0),
    }), { qty: 0, okQty: 0, scrapQty: 0, manHours: 0 });
    return { ...entryRow(r), corrections, totals };
  }

  #entryFields(input, { partial = false, now = Date.now() } = {}) {
    const out = {};
    const has = (k) => Object.hasOwn(input, k);
    if (!partial || has('productLabel')) {
      const v = text(input.productLabel, 'Ürün tanımı', 200);
      if (!v) throw new PlanningError('Ürün tanımı gerekli.');
      out.productLabel = v;
    }
    if (has('cardNo')) out.cardNo = text(input.cardNo, 'Ürün tanıtım form numarası', 40);
    if (!partial || has('issue')) {
      const v = text(input.issue, 'Uygunsuzluk tanımı', 500);
      if (!v) throw new PlanningError('Uygunsuzluk tanımı gerekli.');
      out.issue = v;
    }
    if (has('customer')) out.customer = text(input.customer, 'Müşteri', 120);
    if (has('customerCode')) out.customerCode = text(input.customerCode, 'Müşteri ürün kodu', 60);
    if (has('stockCode')) out.stockCode = text(input.stockCode, 'Alen ürün kodu', 40);
    if (has('detectedAt')) out.detectedAt = text(input.detectedAt, 'Uygunsuzluk tespit yeri', 60);
    if (has('action')) out.action = text(input.action, 'Yapılacak işlem', 500);
    if (has('batchQty')) out.batchQty = intOptional(input.batchQty, 'Parti miktarı');
    if (has('scrapQty')) out.scrapQty = intOptional(input.scrapQty, 'Hurda miktarı');
    if (has('qualityCostTl')) out.qualityCostTl = decOptional(input.qualityCostTl, 'Kalitesizlik maliyeti (TL)', { max: 10_000_000 });
    if (has('note')) out.note = text(input.note, 'Açıklama', 1000);
    if (!partial || has('enteredOn')) {
      const d = day(input.enteredOn, 'Giriş tarihi');
      if (partial) { if (d != null) out.enteredOn = d; } // bos gonderilirse dokunulmaz (NOT NULL alan temizlenemez)
      else out.enteredOn = d ?? localMidnight(now);
    }
    if (!partial || has('enteredBy')) {
      const v = text(input.enteredBy, 'Giriş yapan personel', 100);
      if (partial) { if (v) out.enteredBy = v; }
      else { if (!v) throw new PlanningError('Giriş yapan personelin adı gerekli.'); out.enteredBy = v; }
    }
    if (has('exitReason')) out.exitReason = text(input.exitReason, 'Çıkış nedeni', 300);
    if (has('exitedOn')) out.exitedOn = day(input.exitedOn, 'Çıkış tarihi');
    if (has('exitedBy')) out.exitedBy = text(input.exitedBy, 'Çıkış yapan personel', 100);
    return out;
  }

  /** Yeni giriş kaydı ("Giriş-çıkış formu oluştur"): ürün tanımı, uygunsuzluk tanımı, giriş tarihi/personeli zorunlu. */
  create(input = {}, { by = null, now = Date.now() } = {}) {
    const f = this.#entryFields(input, { now });
    const id = Number(this.db.prepare(
      `INSERT INTO quarantine_entries (product_label, card_no, issue, customer, customer_code, stock_code, detected_at, action,
        batch_qty, scrap_qty, quality_cost_tl, note, entered_on, entered_by, status, search_key, created_at, created_by, updated_at, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'acik',?,?,?,?,?)`,
    ).run(
      f.productLabel, f.cardNo ?? null, f.issue, f.customer ?? null, f.customerCode ?? null, f.stockCode ?? null, f.detectedAt ?? null,
      f.action ?? null, f.batchQty ?? null, f.scrapQty ?? null, f.qualityCostTl ?? null, f.note ?? null,
      f.enteredOn, f.enteredBy, this.#searchKey(f), now, by, now, by,
    ).lastInsertRowid);
    return this.get(id);
  }

  /** Giriş/çıkış alanlarını düzeltir (yalnız gönderilen alanlar değişir; durum BURADAN değişmez — bkz. exit()/reopen()). */
  update(id, input = {}, { by = null, now = Date.now() } = {}) {
    const cur = this.get(id);
    const f = this.#entryFields(input, { partial: true });
    if (Object.keys(f).length === 0) return cur;
    const next = { ...cur, ...f };
    const cols = [];
    const args = [];
    const map = {
      productLabel: 'product_label', cardNo: 'card_no', issue: 'issue',
      customer: 'customer', customerCode: 'customer_code', stockCode: 'stock_code', detectedAt: 'detected_at', action: 'action',
      batchQty: 'batch_qty', scrapQty: 'scrap_qty', qualityCostTl: 'quality_cost_tl', note: 'note',
      enteredOn: 'entered_on', enteredBy: 'entered_by', exitReason: 'exit_reason', exitedOn: 'exited_on', exitedBy: 'exited_by',
    };
    for (const [k, col] of Object.entries(map)) { if (Object.hasOwn(f, k)) { cols.push(`${col} = ?`); args.push(f[k] ?? null); } }
    cols.push('search_key = ?'); args.push(this.#searchKey(next));
    cols.push('updated_at = ?', 'updated_by = ?'); args.push(now, by);
    this.db.prepare(`UPDATE quarantine_entries SET ${cols.join(', ')} WHERE id = ?`).run(...args, Number(id));
    return this.get(id);
  }

  /** "Çıkış yap": yalnız açık kayıtta. Çıkış nedeni/tarihi/personeli zorunlu. */
  exit(id, input = {}, { by = null, now = Date.now() } = {}) {
    const cur = this.get(id);
    if (cur.status !== 'acik') throw new PlanningError('Bu kayıt zaten kapalı (çıkış yapılmış).', 409);
    const exitReason = text(input.exitReason, 'Çıkış nedeni', 300);
    if (!exitReason) throw new PlanningError('Çıkış nedeni gerekli.');
    const exitedBy = text(input.exitedBy, 'Çıkış yapan personel', 100);
    if (!exitedBy) throw new PlanningError('Çıkış yapan personelin adı gerekli.');
    const exitedOn = day(input.exitedOn, 'Çıkış tarihi') ?? localMidnight(now);
    this.db.prepare('UPDATE quarantine_entries SET status = ?, exit_reason = ?, exited_on = ?, exited_by = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .run('kapali', exitReason, exitedOn, exitedBy, now, by, Number(id));
    return this.get(id);
  }

  /** Yanlışlıkla yapılan çıkışı geri al (yeniden "açık" olur, çıkış alanları temizlenir). */
  reopen(id, { by = null, now = Date.now() } = {}) {
    const cur = this.get(id);
    if (cur.status === 'acik') return cur;
    this.db.prepare('UPDATE quarantine_entries SET status = ?, exit_reason = NULL, exited_on = NULL, exited_by = NULL, updated_at = ?, updated_by = ? WHERE id = ?')
      .run('acik', now, by, Number(id));
    return this.get(id);
  }

  /** Yanlış açılmış kaydı (ve tashih geçmişini) sil. Yalnız yönetici. */
  delete(id) {
    this.get(id);
    this.db.prepare('DELETE FROM quarantine_corrections WHERE quarantine_id = ?').run(Number(id));
    this.db.prepare('DELETE FROM quarantine_entries WHERE id = ?').run(Number(id));
    return { ok: true };
  }

  /* --------------------------------------------------------------------------------- tashih (EYS.FR.049) */

  /**
   * Giriş ve çıkış arasında bir tashih (düzeltme/rework) denemesi kaydeder. Yalnız açık kayıtta (karantinadan
   * çıkmış bir parça üzerinde ayrıca tashih kaydı AÇILMAZ — önce "Girişi geri al", sonra tashih eklenir).
   * Ürün kodu ayrıca sorulmaz: zaten üst kaydın `productLabel`'inden gelir (tekrar yazdırmaya gerek yok).
   */
  addCorrection(id, input = {}, { by = null, now = Date.now() } = {}) {
    const cur = this.get(id);
    if (cur.status !== 'acik') throw new PlanningError('Kapanmış (çıkış yapılmış) bir kayda tashih eklenemez; önce "Girişi geri al".', 409);
    const doneOn = day(input.doneOn, 'Tarih') ?? localMidnight(now);
    const operator = text(input.operator, 'Tashih yapan operatör', 100);
    if (!operator) throw new PlanningError('Tashih yapan operatörün adı gerekli.');
    const description = text(input.description, 'Yapılan tashihin tanımı', 500);
    if (!description) throw new PlanningError('Yapılan tashihin tanımı gerekli.');
    const qty = intRequired(input.qty, 'Tashih edilen adet');
    const okQty = intOptional(input.okQty, 'O.K. adedi');
    const scrapQty = intOptional(input.scrapQty, 'Hurda adedi');
    const manHours = decOptional(input.manHours, 'Sarf edilen adam×saat');
    const note = text(input.note, 'Açıklama', 500);
    this.db.prepare(
      `INSERT INTO quarantine_corrections (quarantine_id, done_on, operator, description, qty, ok_qty, scrap_qty, man_hours, note, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(Number(id), doneOn, operator, description, qty, okQty, scrapQty, manHours, note, now, by);
    return this.get(id);
  }

  /** Yanlış girilen tashih satırını sil. Yalnız yönetici. */
  deleteCorrection(correctionId) {
    const r = this.db.prepare('SELECT quarantine_id FROM quarantine_corrections WHERE id = ?').get(Number(correctionId));
    if (!r) throw new PlanningError('Tashih kaydı bulunamadı.', 404);
    this.db.prepare('DELETE FROM quarantine_corrections WHERE id = ?').run(Number(correctionId));
    return this.get(Number(r.quarantine_id));
  }
}
