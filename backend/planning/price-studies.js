/**
 * FIYAT CALISMASI: urun karti henuz acilmadan once yapilan on calisma (kullanici isteği, 2026-10-30).
 * Admin bir teknik resim (PDF) yukler; "usta" (rol sisteminde 'fiyat' ekranina yazma yetkisi olan biri) buna
 * bakip HAMMADDE ve SURE bilgisini girer. Bu kayit `products` tablosuyla HIC BAGLANMAZ: urun kartlari Mikro'da
 * tutuluyor, yonetici bu dolu kaydi gorup Mikro'da kendisi acar. Tamamen bagimsiz bir referans/log'tur.
 *
 * Icerik adresli dosya deposu (drawing_files, quality-db.js'teki AYNI tablo, ayni veritabani baglantisi) tekrar
 * kullanilir: yeni bir dosya depolama katmani icat edilmez.
 */
import { createHash } from 'node:crypto';
import { PlanningError } from './errors.js';
import { inspectPdf, PdfError } from '../pdf-merge.js';
import { text, number } from './fields.js';

export const MAX_DRAWING_BYTES = 20 * 1024 * 1024;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS price_studies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT,
  sha          TEXT    NOT NULL,
  drawing_name TEXT    NOT NULL,
  material     TEXT,
  planned_sec  REAL,
  note         TEXT,
  status       TEXT    NOT NULL DEFAULT 'bekliyor',
  created_at   INTEGER NOT NULL,
  created_by   TEXT,
  filled_at    INTEGER,
  filled_by    TEXT
);
CREATE INDEX IF NOT EXISTS idx_price_studies_status ON price_studies (status, id DESC);
`;

const row = (r) => (r == null ? null : {
  id: Number(r.id), title: r.title, drawingName: r.drawing_name, material: r.material,
  plannedSec: r.planned_sec == null ? null : Number(r.planned_sec), note: r.note, status: r.status,
  createdAt: Number(r.created_at), createdBy: r.created_by,
  filledAt: r.filled_at == null ? null : Number(r.filled_at), filledBy: r.filled_by,
});

export class PriceStudies {
  /** @param {{planning: import('./planning.js').Planning}} deps */
  constructor({ planning }) {
    this.planning = planning;
    this.db = planning.db.db; // ayni sqlite baglantisi (drawing_files tablosu Quality tarafindan zaten kuruldu)
    this.db.exec(SCHEMA);
  }

  list({ status = '', limit = 200, offset = 0 } = {}) {
    const conds = [];
    const args = [];
    if (status === 'bekliyor' || status === 'dolduruldu') { conds.push('status = ?'); args.push(status); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM price_studies ${where}`).get(...args).n);
    const items = this.db.prepare(
      `SELECT id, title, drawing_name, material, planned_sec, note, status, created_at, created_by, filled_at, filled_by
         FROM price_studies ${where} ORDER BY (status = 'dolduruldu'), id DESC LIMIT ? OFFSET ?`,
    ).all(...args, limit, offset).map(row);
    return { total, items };
  }

  get(id) {
    const r = this.db.prepare('SELECT * FROM price_studies WHERE id = ?').get(Number(id));
    if (!r) throw new PlanningError('Fiyat çalışması bulunamadı.', 404);
    return row(r);
  }

  /** PDF icerigi (goruntuleme icin; sendProductFile ile ayni bicimde kullanilir). */
  drawingData(id) {
    const r = this.db.prepare('SELECT drawing_name AS name, sha FROM price_studies WHERE id = ?').get(Number(id));
    if (!r) throw new PlanningError('Fiyat çalışması bulunamadı.', 404);
    const f = this.db.prepare('SELECT data FROM drawing_files WHERE sha = ?').get(r.sha);
    return { name: r.name, data: Buffer.from(f.data) };
  }

  /** Yeni calisma: teknik resim yukle (yalniz admin). @param {{title?: string, name?: string, data: Buffer}} file */
  create({ title, name, data }, { by = null, now = Date.now() } = {}) {
    if (!Buffer.isBuffer(data) || data.length === 0) throw new PlanningError('Dosya boş.');
    if (data.length > MAX_DRAWING_BYTES) throw new PlanningError(`PDF çok büyük (en fazla ${Math.round(MAX_DRAWING_BYTES / 1048576)} MB).`, 413);
    let info;
    try { info = inspectPdf(data); } catch (err) {
      if (err instanceof PdfError) throw new PlanningError(`PDF kabul edilmedi: ${err.message}`, 422, 'bad-pdf');
      throw err;
    }
    const sha = createHash('sha256').update(data).digest('hex');
    this.db.prepare('INSERT OR IGNORE INTO drawing_files (sha, size, pages, data, created_at) VALUES (?,?,?,?,?)').run(sha, data.length, info.pages, data, now);
    const clean = (String(name ?? '').split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120) || 'teknik-resim.pdf';
    const id = Number(this.db.prepare(
      'INSERT INTO price_studies (title, sha, drawing_name, status, created_at, created_by) VALUES (?,?,?,?,?,?)',
    ).run(text(title, 'Başlık', 200), sha, clean, 'bekliyor', now, by).lastInsertRowid);
    return this.get(id);
  }

  /** Usta doldurur: hammadde + sure (zorunlu) + not (istege bagli). */
  fill(id, input = {}, { by = null, now = Date.now() } = {}) {
    this.get(id); // bulunamadiysa 404
    const material = text(input.material, 'Hammadde', 80);
    const plannedSec = number(input.plannedSec, 'Süre (sn)', { max: 36_000 });
    if (!material || plannedSec == null) throw new PlanningError('Hammadde ve süre girilmeli.');
    const note = text(input.note, 'Not', 500);
    this.db.prepare(
      'UPDATE price_studies SET material = ?, planned_sec = ?, note = ?, status = ?, filled_at = ?, filled_by = ? WHERE id = ?',
    ).run(material, plannedSec, note, 'dolduruldu', now, by, Number(id));
    return this.get(id);
  }

  delete(id) {
    const r = this.db.prepare('SELECT sha FROM price_studies WHERE id = ?').get(Number(id));
    if (!r) throw new PlanningError('Fiyat çalışması bulunamadı.', 404);
    this.db.prepare('DELETE FROM price_studies WHERE id = ?').run(Number(id));
    const used = Number(this.db.prepare(
      'SELECT (SELECT COUNT(*) FROM wo_drawings WHERE sha=?) + (SELECT COUNT(*) FROM product_files WHERE sha=?) + (SELECT COUNT(*) FROM price_studies WHERE sha=?) AS n',
    ).get(r.sha, r.sha, r.sha).n);
    if (used === 0) this.db.prepare('DELETE FROM drawing_files WHERE sha = ?').run(r.sha);
  }
}
