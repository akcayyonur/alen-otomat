/**
 * SİPARİŞ FİŞİ — atölyenin malzeme/takım/sarf talebi (kullanıcının kendi tarifi: usta ihtiyaç duyduğunu elle
 * bir "SİPARİŞ FİŞİ" kağıdına yazıp kesiyor — İsim, Tarih + Adet/Malın cinsi/Marka satırları; kağıdın
 * Adres/Şehir/V.D./H.No./Fatura No/Ambar gibi genel-amaçlı (herhangi bir matbu "sipariş fişi" defterinden)
 * alanları usta tarafından HİÇ kullanılmıyor, buraya alınmadı).
 *
 * `products` ile BAĞLANMAZ (Numune Takip/Hurda Girişi/Fiyat çalışması ile AYNI ilke): "malın cinsi" genelde
 * tedarikçi katalog numarasıdır (ör. "B114.0016.2.02"), Alen ürün kodu değil; bir fişte birden çok kalem olur.
 *
 * Durum (kullanıcı kararı, 2026-11-17): `bekliyor` → `verildi` (sipariş verildi) → `geldi` (teslim alındı).
 * Yanlışlıkla ileri götürülürse `back()` ile bir adım geri alınır (Hurda Girişi'nin `reopen()`'ıyla AYNI felsefe,
 * yalnız burada üç durum olduğu için "bir adım geri").
 *
 * Kalemler (satırlar) TEK SEFERDE yazılır/değiştirilir (wholesale replace, JSON sütun) — ölçü planının
 * (`measure.js` `normalizePlan`) ile AYNI desen; kalem başına ayrı ekle/sil ucu YOK, bilerek basit tutuldu.
 *
 * Erişim (kullanıcı kararı): oluşturma/düzenleme/durum değiştirme `siparisfisi` ekranına yazabilen HER role
 * açık (Tezgah başı/Paketleme ile AYNI desen — hangi role admin bu ekranı açacağına Ayarlar > Roller'den karar
 * verir); silme yalnız yönetici (kayıtsız → admin, diğer tüm "takip" modülleriyle AYNI kural).
 */
import { PlanningError } from './errors.js';
import { foldTr } from './normalize.js';
import { text, number, day } from './fields.js';

export const STATUS = Object.freeze(['bekliyor', 'verildi', 'geldi']);
/** Kâğıt fişte ~14 satır vardı; dijitalde fazlasına izin verilir ama sınırsız değil. */
export const MAX_LINES = 60;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS supply_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  requested_by TEXT    NOT NULL,
  requested_on INTEGER NOT NULL,
  note         TEXT,
  lines_json   TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'bekliyor',
  ordered_on   INTEGER,
  ordered_by   TEXT,
  received_on  INTEGER,
  received_by  TEXT,
  search_key   TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  created_by   TEXT,
  updated_at   INTEGER NOT NULL,
  updated_by   TEXT
);
CREATE INDEX IF NOT EXISTS idx_supply_requests_status ON supply_requests (status, id DESC);
CREATE INDEX IF NOT EXISTS idx_supply_requests_search ON supply_requests (search_key);
`;

const localMidnight = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
/** Ayrı bir sayaç İCAT EDİLMEDİ: görüntü kodu doğrudan DB id'sinden türetilir (K000001/H000001 ile AYNI görünüm). */
export const fmtCode = (id) => `S${String(id).padStart(6, '0')}`;

/**
 * Fişin kalemleri: her satır {qty, item, brand?}. @param {object[]} rows
 * @returns {{qty: number, item: string, brand: string|null}[]}
 */
export function normalizeLines(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new PlanningError('En az bir kalem gerekli.');
  if (rows.length > MAX_LINES) throw new PlanningError(`En fazla ${MAX_LINES} kalem eklenebilir.`);
  return rows.map((r, i) => {
    const qty = number(r?.qty, `${i + 1}. satır adet`, { max: 1_000_000, integer: true });
    if (qty == null) throw new PlanningError(`${i + 1}. satır: adet gerekli.`);
    const item = text(r?.item, `${i + 1}. satır malın cinsi`, 200);
    if (!item) throw new PlanningError(`${i + 1}. satır: malın cinsi gerekli.`);
    const brand = text(r?.brand, `${i + 1}. satır marka`, 80);
    return { qty, item, brand };
  });
}

const row = (r) => (r == null ? null : {
  id: Number(r.id), code: fmtCode(r.id), requestedBy: r.requested_by, requestedOn: Number(r.requested_on), note: r.note,
  lines: JSON.parse(r.lines_json), status: r.status,
  orderedOn: r.ordered_on == null ? null : Number(r.ordered_on), orderedBy: r.ordered_by,
  receivedOn: r.received_on == null ? null : Number(r.received_on), receivedBy: r.received_by,
  createdAt: Number(r.created_at), createdBy: r.created_by, updatedAt: Number(r.updated_at), updatedBy: r.updated_by,
});

export class SupplyRequests {
  /** @param {{planning: import('./planning.js').Planning}} deps */
  constructor({ planning }) {
    this.planning = planning;
    this.db = planning.db.db; // ayni sqlite baglantisi
    this.db.exec(SCHEMA);
  }

  #searchKey(f) {
    return foldTr([f.requestedBy, f.note, ...f.lines.flatMap((l) => [l.item, l.brand])].filter(Boolean).join(' '));
  }

  /** @param {{q?: string, status?: string, limit?: number, offset?: number}} [f] */
  list({ q = '', status = '', limit = 200, offset = 0 } = {}) {
    const conds = [];
    const args = [];
    if (q.trim() !== '') { conds.push("search_key LIKE ? ESCAPE '\\'"); args.push(`%${foldTr(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`); }
    if (STATUS.includes(status)) { conds.push('status = ?'); args.push(status); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM supply_requests ${where}`).get(...args).n);
    const items = this.db.prepare(`SELECT * FROM supply_requests ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset).map(row);
    return { total, items };
  }

  get(id) {
    const r = this.db.prepare('SELECT * FROM supply_requests WHERE id = ?').get(Number(id));
    if (!r) throw new PlanningError('Sipariş fişi bulunamadı.', 404);
    return row(r);
  }

  #fields(input, { partial = false, now = Date.now() } = {}) {
    const out = {};
    const has = (k) => Object.hasOwn(input, k);
    if (!partial || has('requestedBy')) {
      const v = text(input.requestedBy, 'İsim', 100);
      if (!v) throw new PlanningError('İsim gerekli.');
      out.requestedBy = v;
    }
    if (!partial || has('requestedOn')) {
      const d = day(input.requestedOn, 'Tarih');
      if (partial) { if (d != null) out.requestedOn = d; } else out.requestedOn = d ?? localMidnight(now);
    }
    if (has('note')) out.note = text(input.note, 'Açıklama', 500);
    if (!partial || has('lines')) out.lines = normalizeLines(input.lines);
    return out;
  }

  /** Yeni sipariş fişi: isim, tarih (boş = bugün) ve en az bir kalem zorunlu. */
  create(input = {}, { by = null, now = Date.now() } = {}) {
    const f = this.#fields(input, { now });
    const id = Number(this.db.prepare(
      `INSERT INTO supply_requests (requested_by, requested_on, note, lines_json, status, search_key, created_at, created_by, updated_at, updated_by)
       VALUES (?,?,?,?,'bekliyor',?,?,?,?,?)`,
    ).run(f.requestedBy, f.requestedOn, f.note ?? null, JSON.stringify(f.lines), this.#searchKey(f), now, by, now, by).lastInsertRowid);
    return this.get(id);
  }

  /** Alanları düzeltir (yalnız gönderilenler değişir); `lines` gönderilirse TÜM kalemler değişir (wholesale). */
  update(id, input = {}, { by = null, now = Date.now() } = {}) {
    const cur = this.get(id);
    const f = this.#fields(input, { partial: true });
    if (Object.keys(f).length === 0) return cur;
    const next = { ...cur, ...f };
    const cols = [];
    const args = [];
    if (Object.hasOwn(f, 'requestedBy')) { cols.push('requested_by = ?'); args.push(f.requestedBy); }
    if (Object.hasOwn(f, 'requestedOn')) { cols.push('requested_on = ?'); args.push(f.requestedOn); }
    if (Object.hasOwn(f, 'note')) { cols.push('note = ?'); args.push(f.note ?? null); }
    if (Object.hasOwn(f, 'lines')) { cols.push('lines_json = ?'); args.push(JSON.stringify(f.lines)); }
    cols.push('search_key = ?'); args.push(this.#searchKey(next));
    cols.push('updated_at = ?', 'updated_by = ?'); args.push(now, by);
    this.db.prepare(`UPDATE supply_requests SET ${cols.join(', ')} WHERE id = ?`).run(...args, Number(id));
    return this.get(id);
  }

  /** "Sipariş verildi": bekliyor → verildi. */
  order(id, { by = null, now = Date.now() } = {}) {
    const cur = this.get(id);
    if (cur.status !== 'bekliyor') throw new PlanningError('Bu fiş zaten sipariş verilmiş ya da teslim alınmış.', 409);
    this.db.prepare('UPDATE supply_requests SET status = ?, ordered_on = ?, ordered_by = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .run('verildi', now, by, now, by, Number(id));
    return this.get(id);
  }

  /** "Teslim alındı": verildi → geldi. */
  receive(id, { by = null, now = Date.now() } = {}) {
    const cur = this.get(id);
    if (cur.status !== 'verildi') throw new PlanningError('Önce "sipariş verildi" işaretlenmeli.', 409);
    this.db.prepare('UPDATE supply_requests SET status = ?, received_on = ?, received_by = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .run('geldi', now, by, now, by, Number(id));
    return this.get(id);
  }

  /** Yanlışlıkla ileri götürülen durumu BİR ADIM geri alır (geldi→verildi→bekliyor); zaten bekliyorsa no-op. */
  back(id, { by = null, now = Date.now() } = {}) {
    const cur = this.get(id);
    if (cur.status === 'geldi') {
      this.db.prepare('UPDATE supply_requests SET status = ?, received_on = NULL, received_by = NULL, updated_at = ?, updated_by = ? WHERE id = ?').run('verildi', now, by, Number(id));
    } else if (cur.status === 'verildi') {
      this.db.prepare('UPDATE supply_requests SET status = ?, ordered_on = NULL, ordered_by = NULL, updated_at = ?, updated_by = ? WHERE id = ?').run('bekliyor', now, by, Number(id));
    } else {
      return cur;
    }
    return this.get(id);
  }

  /** Yanlış açılmış fişi sil. Yalnız yönetici. */
  delete(id) {
    this.get(id);
    this.db.prepare('DELETE FROM supply_requests WHERE id = ?').run(Number(id));
    return { ok: true };
  }
}
