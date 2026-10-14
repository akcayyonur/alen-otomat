/**
 * Kalite kayıtları ve çizimler için tablolar (planlama veritabanında, `PlanningDb` ile AYNI dosya):
 *   gkk_reports      GKK (giriş kalite kontrol) rapor numarası takip formu (EYS.FR.011): hammadde cinsi → rapor no, üretici rapor tarihi, açıklama
 *   first_approvals  İlk baskı onay / numune takip listesi (EYS.FR.013): ilk onay kodu → ürün, GK kodu, iş emri, tarih, operatör, CNC
 *   counters         numara tabanları (rapor numarası dizileri; Excel'de zaten verilmiş numaralardan devam edilsin)
 *   drawing_files    yüklenen teknik resim PDF'leri (içerik adresli: aynı dosya bir kez saklanır)
 *   wo_drawings      iş emrine bağlı çizimler (sıralı)
 */
import { foldTr } from './normalize.js';
import { compactKey } from './gkk.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gkk_reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  report_no     TEXT    NOT NULL,
  report_key    TEXT    NOT NULL,
  year          INTEGER NOT NULL,
  seq           INTEGER NOT NULL,
  material      TEXT    NOT NULL,
  material_key  TEXT    NOT NULL,
  producer_date INTEGER,
  note          TEXT,
  sort_no       INTEGER,
  search_key    TEXT    NOT NULL,
  compact_key   TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  created_by    TEXT,
  updated_at    INTEGER NOT NULL,
  updated_by    TEXT,
  UNIQUE (report_key, material_key)
);
CREATE INDEX IF NOT EXISTS idx_gkk_year_seq ON gkk_reports (year, seq);

CREATE TABLE IF NOT EXISTS first_approvals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT    NOT NULL UNIQUE,
  year        INTEGER NOT NULL,
  seq         INTEGER NOT NULL,
  stock_code  TEXT,
  gk_code     TEXT,
  wo_no       TEXT,
  approved_on INTEGER,
  operator    TEXT,
  machine_id  TEXT,
  note        TEXT,
  search_key  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  created_by  TEXT,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT,
  UNIQUE (year, seq)
);
CREATE INDEX IF NOT EXISTS idx_fa_wo ON first_approvals (wo_no);

CREATE TABLE IF NOT EXISTS counters (
  name  TEXT    NOT NULL,
  year  INTEGER NOT NULL,
  floor INTEGER NOT NULL,
  PRIMARY KEY (name, year)
);

CREATE TABLE IF NOT EXISTS drawing_files (
  sha        TEXT    PRIMARY KEY,
  size       INTEGER NOT NULL,
  pages      INTEGER NOT NULL,
  data       BLOB    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wo_drawings (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  wo_no    TEXT    NOT NULL,
  name     TEXT    NOT NULL,
  sha      TEXT    NOT NULL,
  sort     INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  added_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_wo_drawings_wo ON wo_drawings (wo_no, sort);
`;

const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const n = (v) => (v == null ? null : Number(v));

const gkkOut = (r) => (r == null ? null : {
  id: Number(r.id), reportNo: r.report_no, year: Number(r.year), seq: Number(r.seq), material: r.material, producerDate: n(r.producer_date),
  note: r.note, sortNo: n(r.sort_no), createdAt: Number(r.created_at), createdBy: r.created_by, updatedAt: Number(r.updated_at), updatedBy: r.updated_by,
});

const approvalOut = (r) => (r == null ? null : {
  id: Number(r.id), code: r.code, year: Number(r.year), seq: Number(r.seq), stockCode: r.stock_code, gkCode: r.gk_code, woNo: r.wo_no,
  approvedOn: n(r.approved_on), operator: r.operator, machineId: r.machine_id, note: r.note,
  createdAt: Number(r.created_at), createdBy: r.created_by, updatedAt: Number(r.updated_at), updatedBy: r.updated_by,
});

export class QualityDb {
  /** @param {import('node:sqlite').DatabaseSync} db PlanningDb'nin açık bağlantısı */
  constructor(db) {
    this.db = db;
    this.db.exec(SCHEMA);
  }

  /* ---------------------------------------------------------------- numara tabanları */

  floor(name, year) {
    return Number(this.db.prepare('SELECT floor FROM counters WHERE name = ? AND year = ?').get(name, year)?.floor ?? 0);
  }

  raiseFloor(name, year, value) {
    this.db.prepare('INSERT INTO counters (name, year, floor) VALUES (?,?,?) ON CONFLICT(name, year) DO UPDATE SET floor = MAX(floor, excluded.floor)').run(name, year, value);
  }

  /* --------------------------------------------------------------------------- GKK */

  gkkMaxSeq(year) {
    return Number(this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM gkk_reports WHERE year = ?').get(year).m);
  }

  gkkGet(id) {
    return gkkOut(this.db.prepare('SELECT * FROM gkk_reports WHERE id = ?').get(id));
  }

  gkkFind(reportKey, materialKey) {
    return gkkOut(this.db.prepare('SELECT * FROM gkk_reports WHERE report_key = ? AND material_key = ?').get(reportKey, materialKey));
  }

  /** @returns {number} yeni kaydın id'si */
  gkkInsert(g, { by = null, now = Date.now() } = {}) {
    return Number(this.db.prepare(
      `INSERT INTO gkk_reports (report_no, report_key, year, seq, material, material_key, producer_date, note, sort_no, search_key, compact_key,
              created_at, created_by, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(g.reportNo, compactKey(g.reportNo), g.year, g.seq, g.material, compactKey(g.material), g.producerDate ?? null, g.note ?? null, g.sortNo ?? null,
      foldTr(`${g.material} ${g.reportNo} ${g.note ?? ''}`), compactKey(`${g.material}${g.reportNo}${g.note ?? ''}`), now, by, now, by).lastInsertRowid);
  }

  gkkUpdate(id, g, { by = null, now = Date.now() } = {}) {
    this.db.prepare(
      `UPDATE gkk_reports SET report_no=?, report_key=?, year=?, seq=?, material=?, material_key=?, producer_date=?, note=?, sort_no=?, search_key=?, compact_key=?,
              updated_at=?, updated_by=? WHERE id=?`,
    ).run(g.reportNo, compactKey(g.reportNo), g.year, g.seq, g.material, compactKey(g.material), g.producerDate ?? null, g.note ?? null, g.sortNo ?? null,
      foldTr(`${g.material} ${g.reportNo} ${g.note ?? ''}`), compactKey(`${g.material}${g.reportNo}${g.note ?? ''}`), now, by, id);
  }

  gkkDelete(id) {
    this.db.prepare('DELETE FROM gkk_reports WHERE id = ?').run(id);
  }

  /** Kayıtların tamamı (iş emri eşleştirmesi bellekte yapılır; kayıt sayısı yüzler düzeyinde). */
  gkkAll() {
    return this.db.prepare('SELECT * FROM gkk_reports').all().map(gkkOut);
  }

  gkkSearch(q) {
    const key = foldTr(q);
    if (key === '') return this.gkkAll();
    const compact = compactKey(q);
    return this.db.prepare("SELECT * FROM gkk_reports WHERE search_key LIKE ? ESCAPE '\\' OR (? <> '' AND compact_key LIKE ? ESCAPE '\\')")
      .all(`%${likeEscape(key)}%`, compact, `%${likeEscape(compact)}%`).map(gkkOut);
  }

  gkkCount() {
    return Number(this.db.prepare('SELECT COUNT(*) AS n FROM gkk_reports').get().n);
  }

  /* ------------------------------------------------------------------ ilk onay (FR.013) */

  approvalMaxSeq(year) {
    return Number(this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM first_approvals WHERE year = ?').get(year).m);
  }

  approvalGet(id) {
    return approvalOut(this.db.prepare('SELECT * FROM first_approvals WHERE id = ?').get(id));
  }

  approvalByCode(code) {
    return approvalOut(this.db.prepare('SELECT * FROM first_approvals WHERE code = ?').get(code));
  }

  approvalsOfWo(woNo) {
    return this.db.prepare('SELECT * FROM first_approvals WHERE wo_no = ? ORDER BY year, seq').all(woNo).map(approvalOut);
  }

  approvalInsert(a, { by = null, now = Date.now() } = {}) {
    return Number(this.db.prepare(
      `INSERT INTO first_approvals (code, year, seq, stock_code, gk_code, wo_no, approved_on, operator, machine_id, note, search_key,
              created_at, created_by, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(a.code, a.year, a.seq, a.stockCode ?? null, a.gkCode ?? null, a.woNo ?? null, a.approvedOn ?? null, a.operator ?? null, a.machineId ?? null, a.note ?? null,
      foldTr(`${a.code} ${a.stockCode ?? ''} ${a.gkCode ?? ''} ${a.woNo ?? ''} ${a.operator ?? ''} ${a.machineId ?? ''}`), now, by, now, by).lastInsertRowid);
  }

  approvalUpdate(id, a, { by = null, now = Date.now() } = {}) {
    this.db.prepare(
      `UPDATE first_approvals SET stock_code=?, gk_code=?, wo_no=?, approved_on=?, operator=?, machine_id=?, note=?, search_key=?, updated_at=?, updated_by=? WHERE id=?`,
    ).run(a.stockCode ?? null, a.gkCode ?? null, a.woNo ?? null, a.approvedOn ?? null, a.operator ?? null, a.machineId ?? null, a.note ?? null,
      foldTr(`${a.code} ${a.stockCode ?? ''} ${a.gkCode ?? ''} ${a.woNo ?? ''} ${a.operator ?? ''} ${a.machineId ?? ''}`), now, by, id);
  }

  approvalDelete(id) {
    this.db.prepare('DELETE FROM first_approvals WHERE id = ?').run(id);
  }

  approvalList({ q = '', year = null, limit = 100, offset = 0 } = {}) {
    const conds = [];
    const args = [];
    const key = foldTr(q);
    if (key !== '') { conds.push("search_key LIKE ? ESCAPE '\\'"); args.push(`%${likeEscape(key)}%`); }
    if (year) { conds.push('year = ?'); args.push(year); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM first_approvals ${where}`).get(...args).n);
    const items = this.db.prepare(`SELECT * FROM first_approvals ${where} ORDER BY year DESC, seq DESC LIMIT ? OFFSET ?`).all(...args, limit, offset).map(approvalOut);
    return { total, items };
  }

  approvalYears() {
    return this.db.prepare('SELECT DISTINCT year FROM first_approvals ORDER BY year DESC').all().map((r) => Number(r.year));
  }

  /* ------------------------------------------------------------------------ çizimler */

  drawingsOfWo(woNo) {
    return this.db.prepare(
      `SELECT d.id, d.name, d.sha, d.sort, d.added_at, d.added_by, f.size, f.pages
         FROM wo_drawings d JOIN drawing_files f ON f.sha = d.sha WHERE d.wo_no = ? ORDER BY d.sort, d.id`,
    ).all(woNo).map((r) => ({ id: Number(r.id), name: r.name, sha: r.sha, sort: Number(r.sort), size: Number(r.size), pages: Number(r.pages), addedAt: Number(r.added_at), addedBy: r.added_by }));
  }

  /** Dosya içerikleri (sıralı) — birleştirme için. @returns {Buffer[]} */
  drawingBuffersOfWo(woNo) {
    return this.db.prepare(
      `SELECT f.data FROM wo_drawings d JOIN drawing_files f ON f.sha = d.sha WHERE d.wo_no = ? ORDER BY d.sort, d.id`,
    ).all(woNo).map((r) => Buffer.from(r.data));
  }

  /** @returns {number} yeni çizim kaydının id'si */
  addDrawing(woNo, { name, sha, size, pages, data }, { by = null, now = Date.now() } = {}) {
    this.db.prepare('INSERT OR IGNORE INTO drawing_files (sha, size, pages, data, created_at) VALUES (?,?,?,?,?)').run(sha, size, pages, data, now);
    const sort = Number(this.db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM wo_drawings WHERE wo_no = ?').get(woNo).s);
    return Number(this.db.prepare('INSERT INTO wo_drawings (wo_no, name, sha, sort, added_at, added_by) VALUES (?,?,?,?,?,?)').run(woNo, name, sha, sort, now, by).lastInsertRowid);
  }

  drawingGet(id) {
    const r = this.db.prepare('SELECT * FROM wo_drawings WHERE id = ?').get(id);
    return r ? { id: Number(r.id), woNo: r.wo_no, name: r.name, sha: r.sha } : null;
  }

  deleteDrawing(id) {
    const d = this.drawingGet(id);
    if (!d) return false;
    this.db.prepare('DELETE FROM wo_drawings WHERE id = ?').run(id);
    // başka hiçbir iş emri kullanmıyorsa dosya içeriği de silinir
    if (Number(this.db.prepare('SELECT COUNT(*) AS n FROM wo_drawings WHERE sha = ?').get(d.sha).n) === 0) this.db.prepare('DELETE FROM drawing_files WHERE sha = ?').run(d.sha);
    return true;
  }

  /** En son çizimi olan, aynı ürünün başka iş emri: yeni iş emrine çizimler bağlanır (dosya kopyalanmaz). @returns {{name: string, sha: string}[]} */
  drawingsOfLatestOrderOf(codeKey, excludeNo) {
    const r = this.db.prepare(
      `SELECT w.no FROM work_orders w WHERE w.code_key = ? AND w.no <> ? AND EXISTS (SELECT 1 FROM wo_drawings d WHERE d.wo_no = w.no)
        ORDER BY w.created_at DESC, w.no DESC LIMIT 1`,
    ).get(codeKey, excludeNo);
    if (!r) return [];
    return this.db.prepare('SELECT name, sha FROM wo_drawings WHERE wo_no = ? ORDER BY sort, id').all(r.no).map((x) => ({ name: x.name, sha: x.sha }));
  }

  linkDrawing(woNo, { name, sha }, { by = null, now = Date.now() } = {}) {
    const sort = Number(this.db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM wo_drawings WHERE wo_no = ?').get(woNo).s);
    this.db.prepare('INSERT INTO wo_drawings (wo_no, name, sha, sort, added_at, added_by) VALUES (?,?,?,?,?,?)').run(woNo, name, sha, sort, now, by);
  }
}
