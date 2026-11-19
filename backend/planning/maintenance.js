/**
 * BAKIM (EYS.FR.016 "Bakım Kayıt Formu" + Bakım Sicil Kartları → dijital bakım takip ekranı).
 *
 * Kağıttaki iki form: (1) her makinenin SABİT sicil kartı — ne bakımı yapılacak, ne sıklıkla (PERİYODU: "Her
 * vardiya başlarken", "Vardiyada 2 kez", "Günlük", "Haftalık", "Aylık", "4 aylık (Mart-Temmuz-Kasım)" gibi),
 * kim yapacak, nereye kaydedilecek; (2) her makinenin BOŞ takip formu — haftalık/aylık tik kutuları + rutin/arızi
 * bakım logu. Müşteri bu akışı beğenmedi: istenen, "makine tipi seç → bakımları gör" şeklinde açılır/kapanır bir
 * ekran VE periyotların koda gömülü DEĞİL, admin tarafından ayarlanabilir olması (usta yalnızca tik atar).
 *
 * **Periyotlar TİP bazında tanımlanır, tik atma/geçmiş ASSET (fiziksel makine) bazındadır.** 7 CNC torna aynı
 * 13 kalemlik listeyi paylaşıyor; admin bir periyodu düzeltince (ör. "aylık" → "ayda 2") hepsi birden değişsin —
 * kağıttaki "7 ayrı ama birbirinin kopyası kart" yerine TEK tanım + her makinenin kendi tik geçmişi.
 */
import { PlanningError } from './errors.js';
import { text, number, day } from './fields.js';
import { findHeaderByKeys, foldTr } from './normalize.js';
import { XlsxError, readXlsx } from './xlsx-read.js';
import { shiftOf } from '../../shared/shifts.js';

export const PERIOD_UNITS = Object.freeze(['vardiya', 'gun', 'hafta', 'ay', 'yil']);
export const REQUIRES_NOTE = Object.freeze(['hayir', 'degisimde', 'her_zaman']);
export const LOG_KIND = Object.freeze(['kontrol', 'rutin', 'arizi']);
export const ACTIVE = Object.freeze(['aktif', 'pasif']);
/** Hesaplanan durum (DB'de saklanmaz): `null` = periyot tanımsız/okunamıyor. */
export const DUE_STATUS = Object.freeze(['tamam', 'yaklasiyor', 'gecikti']);

/**
 * OTOMATİK TİK (2026-11-19, kullanıcı bulgusu): usta bu ekranı GÜNLÜK KULLANMIYOR — tikler yalnız DENETİM
 * geldiğinde doldurulup gösteriliyor. Kullanıcı bunu otomatikleştirmek istedi: periyodu gelince sistem
 * KENDİSİ, HER MAKİNE İÇİN BAĞIMSIZ RASTGELE bir saatte "kontrol" tik'i atsın; istenirse kapatılabilsin.
 * `AUTO_PERSON` kaydın `person`/`created_by` alanına yazılır (ayrı bir sütun İCAT EDİLMEDİ) — admin'in kendi
 * ekranında hangi tiklerin otomatik olduğunu ayırt edebilmesi için (bu ekranın bir yazdırma/form çıkışı YOK,
 * bu yüzden "görünmesi" bir sorun değil, bkz. CLAUDE.md §6 "Bakım").
 */
export const AUTO_PERSON = 'Otomatik';
const AUTO_SETTING_KEY = 'bakim.otomatikTik';
/** Zaten gecikmiş (grace=0, ör. günlük/vardiya) bir kalem için "şimdiden ne kadar sonraya kadar" rastgele yakalama penceresi. */
const AUTO_CATCHUP_MAX_MS = 6 * 3_600_000;
/** Ateşlenmiş kuyruk satırları bu kadar süre sonra silinir (diğer veri saklama sürelerinin BENZERİ — gerçek bilgi `maintenance_logs`'ta kalıcı kalır, bu yalnız planlama kuyruğu). */
const AUTO_FIRED_RETENTION_MS = 400 * 86_400_000;
/** Bir pencere için planlanıp hiç ATEŞLENMEDEN kalan (ör. usta elle tiklediği için o pencere artık geçersiz olan) satırlar bu kadar sonra temizlenir. */
const AUTO_ORPHAN_RETENTION_MS = 30 * 86_400_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS maintenance_types (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  note       TEXT,
  active     TEXT    NOT NULL DEFAULT 'aktif',
  created_at INTEGER NOT NULL,
  created_by TEXT,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
CREATE TABLE IF NOT EXISTS maintenance_assets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  type_id         INTEGER NOT NULL REFERENCES maintenance_types(id),
  sicil_no        TEXT,
  asset_no        TEXT,
  brand           TEXT,
  model           TEXT,
  motor_power_kw  REAL,
  purchase_note   TEXT,
  cnc_machine_id  TEXT,
  active          TEXT    NOT NULL DEFAULT 'aktif',
  note            TEXT,
  search_key      TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  created_by      TEXT,
  updated_at      INTEGER NOT NULL,
  updated_by      TEXT
);
CREATE INDEX IF NOT EXISTS idx_maint_assets_type ON maintenance_assets (type_id, id);
CREATE INDEX IF NOT EXISTS idx_maint_assets_search ON maintenance_assets (search_key);
CREATE TABLE IF NOT EXISTS maintenance_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  type_id           INTEGER NOT NULL REFERENCES maintenance_types(id),
  description       TEXT    NOT NULL,
  responsible       TEXT,
  requires_note     TEXT    NOT NULL DEFAULT 'hayir',
  timing_note       TEXT,
  period_unit       TEXT,
  period_every      INTEGER NOT NULL DEFAULT 1,
  times_per_period  INTEGER NOT NULL DEFAULT 1,
  anchor_months     TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  active            TEXT    NOT NULL DEFAULT 'aktif',
  created_at        INTEGER NOT NULL,
  created_by        TEXT,
  updated_at        INTEGER NOT NULL,
  updated_by        TEXT
);
CREATE INDEX IF NOT EXISTS idx_maint_items_type ON maintenance_items (type_id, sort_order, id);
CREATE TABLE IF NOT EXISTS maintenance_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id    INTEGER NOT NULL REFERENCES maintenance_assets(id),
  item_id     INTEGER REFERENCES maintenance_items(id),
  kind        TEXT    NOT NULL,
  changed     INTEGER NOT NULL DEFAULT 0,
  done_on     INTEGER NOT NULL,
  company     TEXT,
  description TEXT,
  person      TEXT,
  created_at  INTEGER NOT NULL,
  created_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_maint_logs_asset_item ON maintenance_logs (asset_id, item_id, done_on);
CREATE TABLE IF NOT EXISTS maintenance_auto_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id   INTEGER NOT NULL REFERENCES maintenance_assets(id),
  item_id    INTEGER NOT NULL REFERENCES maintenance_items(id),
  due_at     INTEGER NOT NULL,
  target_at  INTEGER NOT NULL,
  fired_at   INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_maint_auto_queue_window ON maintenance_auto_queue (asset_id, item_id, due_at);
`;

/* --------------------------------------------------------------------------- durum hesabı */

const GRACE_MS = { vardiya: 0, gun: 0, hafta: 2 * 86_400_000, ay: 5 * 86_400_000, yil: 15 * 86_400_000 };

function gunWindow(ms) {
  const d = new Date(ms);
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return { fromMs: from, toMs: from + 86_400_000 };
}
function haftaWindow(ms) {
  const d = new Date(ms);
  const dow = (d.getDay() + 6) % 7; // 0 = Pazartesi
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow).getTime();
  return { fromMs: monday, toMs: monday + 7 * 86_400_000 };
}
function ayWindow(ms) {
  const d = new Date(ms);
  const from = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  return { fromMs: from, toMs: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() };
}
function vardiyaWindow(ms) {
  const w = shiftOf(ms);
  return { fromMs: w.fromMs, toMs: w.toMs };
}
function yilWindow(ms) {
  const d = new Date(ms);
  return { fromMs: new Date(d.getFullYear(), 0, 1).getTime(), toMs: new Date(d.getFullYear() + 1, 0, 1).getTime() };
}
const WINDOW_OF = { vardiya: vardiyaWindow, gun: gunWindow, hafta: haftaWindow, ay: ayWindow, yil: yilWindow };
/** Bir pencerenin bitişinden (`toMs`) hemen sonraki, AYNI birimden bir sonraki pencere. */
const nextWindowOf = (unit, afterToMs) => WINDOW_OF[unit](afterToMs);

const monthEnd = (startMs) => { const d = new Date(startMs); return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime(); };

/** Takvime SABİT ayların (anchorMonths) `fromMs`'ten sonraki (dahil) ilk ay başlangıcı. */
function nextAnchorMonthStart(anchorMonths, fromMs) {
  const d = new Date(fromMs);
  let y = d.getFullYear();
  let m = d.getMonth() + 1; // 1-12
  const sorted = [...anchorMonths].sort((a, b) => a - b);
  for (let guard = 0; guard < 24; guard += 1) {
    if (sorted.includes(m)) return new Date(y, m - 1, 1).getTime();
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return null; // anchorMonths bos/gecersiz olamaz (cagiran denetler), yalniz guvenlik
}
/** `atMs`'ten ÖNCEKİ (dahil) en son anchor ayının başlangıcı — `nextAnchorMonthStart`'ın ters yönü. */
function previousAnchorMonthStart(anchorMonths, atMs) {
  const d = new Date(atMs);
  let y = d.getFullYear();
  let m = d.getMonth() + 1;
  const sorted = [...anchorMonths].sort((a, b) => a - b);
  for (let guard = 0; guard < 24; guard += 1) {
    if (sorted.includes(m)) return new Date(y, m - 1, 1).getTime();
    m -= 1;
    if (m < 1) { m = 12; y -= 1; }
  }
  return null;
}

/**
 * Takvime sabit aylar: yalnız EN SON (şimdiki ya da en son geçmiş) anchor ayına bakar — eski bir kaçırılan
 * anchor sonsuza dek "gecikti" göstermesin (bu kalem o zamandan sonra defalarca düzgün yapılmış olabilir).
 * `referenceAt`'tan ÖNCE biten bir anchor (kalem/makine o zaman yoktu) sayılmaz.
 */
function anchoredNextDueAt(anchorMonths, timesPerPeriod, doneAtList, referenceAt, now) {
  const start = previousAnchorMonthStart(anchorMonths, now);
  const end = monthEnd(start);
  const count = doneAtList.filter((t) => t >= start && t < end).length;
  if (count >= timesPerPeriod || end <= referenceAt) return monthEnd(nextAnchorMonthStart(anchorMonths, end));
  return end; // bu (ya da en son gecmis) anchor kacirildi/henuz suruyor -> son tarih onun sonu
}

/**
 * `every>1` ve ay/yıl sabit TAKVİM ayına bağlı DEĞİLSE (ör. "6 aylık", ay belirtilmeden): son yapılandan `every`
 * birim sonrası. Hiç yapılmadıysa taban `referenceAt` (asset/kalem oluşturulduğu an "o an yapılmış gibi" sayılır
 * — AYRIK pencerelerdeki (gün/hafta/vardiya) "yeni eklenen kaleme hemen kırmızı gösterme" ilkesiyle TUTARLI:
 * aksi halde Excel'den yeni aktarılan bir "6 aylık yağ değişimi" kalemi anında "gecikti" görünürdü).
 */
function rollingNextDueAt(unit, every, timesPerPeriod, doneAtList, referenceAt) {
  const base = new Date(doneAtList.length >= timesPerPeriod ? doneAtList[doneAtList.length - timesPerPeriod] : referenceAt);
  return unit === 'yil'
    ? new Date(base.getFullYear() + every, base.getMonth(), base.getDate()).getTime()
    : new Date(base.getFullYear(), base.getMonth() + every, base.getDate()).getTime();
}

/**
 * Vardiya/gün/hafta/ay gibi AYRIK (discrete) dönem kutucukları. Yalnız ŞİMDİKİ ve ONDAN ÖNCEKİ kutucuğa bakar
 * (eski bir tek kaçırılan gün/hafta sonsuza dek "gecikti" göstermesin): şimdiki kutucuk tamamsa sıradaki
 * kutucuğun sonuna atlanır; değilse ve ÖNCEKİ kutucuk da (kalem o zaman zaten varsa) kaçırıldıysa zaten
 * gecikmiş sayılır, yoksa şimdiki kutucuğun kendi sonu son tarihtir.
 */
function discreteNextDueAt(unit, timesPerPeriod, doneAtList, referenceAt, now) {
  const cur = WINDOW_OF[unit](now);
  const curCount = doneAtList.filter((t) => t >= cur.fromMs && t < cur.toMs).length;
  if (curCount >= timesPerPeriod) return nextWindowOf(unit, cur.toMs).toMs;
  const prev = WINDOW_OF[unit](cur.fromMs - 1);
  if (prev.toMs <= referenceAt) return cur.toMs; // kalem/makine henuz yokken gecerli bir "onceki donem" yok
  const prevCount = doneAtList.filter((t) => t >= prev.fromMs && t < prev.toMs).length;
  return prevCount < timesPerPeriod ? prev.toMs : cur.toMs;
}

/**
 * Bir (asset, kalem) çifti için "bir sonraki son tarih" (ms). Saf, test edilebilir fonksiyon — `calibrationStatus()`
 * (measuring-devices.js) ile aynı felsefe. `item.anchorMonths` doluysa takvime sabit (rolling interval DEĞİL);
 * yoksa vardiya/gün/hafta için AYRIK dönem kutucukları, ay/yıl + `periodEvery>1` için kayan (rolling) aralık.
 * @param {{periodUnit:string, periodEvery?:number, timesPerPeriod?:number, anchorMonths?:number[]|null}} item
 * @param {number[]} doneAtList - bu (asset,kalem) çiftinin `kind='kontrol'` log'larının `done_on` değerleri, ARTAN sırada
 * @param {{referenceAt:number, now?:number}} opts - `referenceAt`: hiç yapılmadıysa "hemen gecikmiş" sayılacak taban an
 */
export function nextDueAt(item, doneAtList, { referenceAt, now = Date.now() }) {
  const unit = item.periodUnit;
  if (!PERIOD_UNITS.includes(unit)) return null;
  const every = item.periodEvery ?? 1;
  const times = item.timesPerPeriod ?? 1;
  const anchors = Array.isArray(item.anchorMonths) ? item.anchorMonths.filter((m) => m >= 1 && m <= 12) : null;
  if (anchors && anchors.length > 0) return anchoredNextDueAt(anchors, times, doneAtList, referenceAt, now);
  if ((unit === 'ay' || unit === 'yil') && every > 1) return rollingNextDueAt(unit, every, times, doneAtList, referenceAt);
  return discreteNextDueAt(unit, times, doneAtList, referenceAt, now);
}

/** `nextDueAt()`'in sonucunu yeşil/sarı/kırmızıya çevirir (birime göre ölçeklenen bir "yaklaşıyor" payı ile). */
export function dueStatus(nextDueAtMs, unit, now = Date.now()) {
  if (nextDueAtMs == null) return null;
  const grace = GRACE_MS[unit] ?? 0;
  if (now >= nextDueAtMs) return 'gecikti';
  if (now >= nextDueAtMs - grace) return 'yaklasiyor';
  return 'tamam';
}

const STATUS_RANK = { gecikti: 3, yaklasiyor: 2, tamam: 1 };
/** Birden çok durumun "en kötüsü" (accordion'un kapalı başlıklarındaki özet rozet için). `null`'lar yok sayılır. */
function worstStatus(statuses) {
  let worst = null;
  for (const s of statuses) { if (s && (worst == null || STATUS_RANK[s] > STATUS_RANK[worst])) worst = s; }
  return worst;
}

/* ------------------------------------------------------------------------------- periyot metni ayrıştırma */

const TR_MONTHS = { OCAK: 1, SUBAT: 2, MART: 3, NISAN: 4, MAYIS: 5, HAZIRAN: 6, TEMMUZ: 7, AGUSTOS: 8, EYLUL: 9, EKIM: 10, KASIM: 11, ARALIK: 12 };

function parseAnchorMonths(text) {
  const tokens = foldTr(text).split(/[^A-Z]+/).filter(Boolean);
  const months = [...new Set(tokens.map((t) => TR_MONTHS[t]).filter((m) => m !== undefined))].sort((a, b) => a - b);
  return months.length ? months : null;
}

/**
 * Sicil kartındaki PERİYODU hücresini (ör. "Vardiyada 2 kez", "4 aylık\n(Mart - Temmuz -Kasım)") yapılandırılmış
 * periyot alanlarına çevirir. TANINMAYAN bir kalıp için `null` döner — asla sessizce tahmin edilmez.
 */
export function parsePeriodText(raw) {
  const f = foldTr(raw).replace(/\s+/g, ' ').trim();
  let m;
  if (f === 'HER VARDIYA BASLARKEN') return { periodUnit: 'vardiya', periodEvery: 1, timesPerPeriod: 1, anchorMonths: null, timingNote: 'Her vardiya başlarken' };
  if ((m = /^VARDIYADA (\d+) *KEZ$/.exec(f))) return { periodUnit: 'vardiya', periodEvery: 1, timesPerPeriod: Number(m[1]), anchorMonths: null, timingNote: null };
  if (f === 'GUNLUK') return { periodUnit: 'gun', periodEvery: 1, timesPerPeriod: 1, anchorMonths: null, timingNote: null };
  if (f === 'HAFTALIK') return { periodUnit: 'hafta', periodEvery: 1, timesPerPeriod: 1, anchorMonths: null, timingNote: null };
  if (f === 'AYLIK') return { periodUnit: 'ay', periodEvery: 1, timesPerPeriod: 1, anchorMonths: null, timingNote: null };
  if ((m = /^YILLIK\s*(?:\(([^)]+)\))?$/.exec(f))) return { periodUnit: 'yil', periodEvery: 1, timesPerPeriod: 1, anchorMonths: m[1] ? parseAnchorMonths(m[1]) : null, timingNote: null };
  if ((m = /^(\d+) *AYLIK\s*(?:\(([^)]+)\))?$/.exec(f))) return { periodUnit: 'ay', periodEvery: Number(m[1]), timesPerPeriod: 1, anchorMonths: m[2] ? parseAnchorMonths(m[2]) : null, timingNote: null };
  return null;
}

function parseRequiresNote(raw) {
  const f = foldTr(raw).replace(/\s+/g, ' ');
  if (f.includes('KAYIT TUTULMAZ')) return 'hayir';
  if (f.includes('DEGISIM')) return 'degisimde';
  return 'her_zaman';
}

/* -------------------------------------------------------------------------------------- sicil kartı import */

const normLabel = (s) => foldTr(s).replace(/\s+/g, ' ').trim();
const LABEL = {
  TANIM: 'MAKINE / CIHAZ TANIMI:', NUMARA: 'MAKINE / CIHAZ NUMARASI:', MARKA: 'MARKA:', MODEL: 'MODEL:',
  MOTOR: 'MOTOR GUCU:', SATINALMA: 'SATINALMA TARIHI:',
};

/** `labelFolded` etiketiyle TAM eşleşen hücreyi bulup AYNI SATIRDA ondan sonraki ilk dolu hücreyi döner. */
function nextCellValue(rows, labelFolded, maxRows = 10) {
  for (let r = 0; r < Math.min(rows.length, maxRows); r += 1) {
    const row = rows[r];
    for (let c = 0; c < row.length; c += 1) {
      if (row[c] && normLabel(row[c]) === labelFolded) {
        for (let c2 = c + 1; c2 < row.length; c2 += 1) if (row[c2]) return String(row[c2]).trim();
        return null;
      }
    }
  }
  return null;
}

/** Etiket+değer AYNI hücrede olan alanlar için (ör. "Sicil No:  BS.001") — ham metinde regex arar. */
function rawLabelMatch(rows, regex, maxRows = 10) {
  for (let r = 0; r < Math.min(rows.length, maxRows); r += 1) {
    for (const cell of rows[r]) {
      if (typeof cell !== 'string') continue;
      const m = regex.exec(cell);
      if (m) return m[1].trim();
    }
  }
  return null;
}

const BAKIM_HEADER_KEYS = ['YAPILACAKBAKIM', 'PERIYODU', 'SORUMLU', 'KAYDEDILECEGIYER'];

export class Maintenance {
  /** @param {{planning: import('./planning.js').Planning}} deps */
  constructor({ planning }) {
    this.planning = planning;
    this.db = planning.db.db; // ayni sqlite baglantisi
    this.db.exec(SCHEMA);
  }

  /* ----------------------------------------------------------------------------------------------- tipler */

  #type(r) {
    return r == null ? null : {
      id: Number(r.id), name: r.name, note: r.note, active: r.active,
      createdAt: Number(r.created_at), createdBy: r.created_by, updatedAt: Number(r.updated_at), updatedBy: r.updated_by,
    };
  }

  getType(id) {
    const r = this.db.prepare('SELECT * FROM maintenance_types WHERE id = ?').get(Number(id));
    if (!r) throw new PlanningError('Makine tipi bulunamadı.', 404);
    return this.#type(r);
  }

  findTypeByName(name) {
    const key = foldTr(name);
    const r = this.db.prepare('SELECT * FROM maintenance_types').all().find((t) => foldTr(t.name) === key);
    return r ? this.#type(r) : null;
  }

  createType(input = {}, { by = null, now = Date.now() } = {}) {
    const name = text(input.name, 'Tip adı', 80);
    if (!name) throw new PlanningError('Tip adı gerekli.');
    if (this.findTypeByName(name)) throw new PlanningError('Bu adda bir makine tipi zaten var.', 409, 'duplicate-name');
    const note = text(input.note, 'Not', 500);
    const id = Number(this.db.prepare(
      'INSERT INTO maintenance_types (name, note, active, created_at, created_by, updated_at, updated_by) VALUES (?,?,?,?,?,?,?)',
    ).run(name, note ?? null, 'aktif', now, by, now, by).lastInsertRowid);
    return this.getType(id);
  }

  updateType(id, input = {}, { by = null, now = Date.now() } = {}) {
    const cur = this.getType(id);
    const cols = [];
    const args = [];
    if (Object.hasOwn(input, 'name')) {
      const name = text(input.name, 'Tip adı', 80);
      if (!name) throw new PlanningError('Tip adı gerekli.');
      const other = this.findTypeByName(name);
      if (other && other.id !== cur.id) throw new PlanningError('Bu adda bir makine tipi zaten var.', 409, 'duplicate-name');
      cols.push('name = ?'); args.push(name);
    }
    if (Object.hasOwn(input, 'note')) { cols.push('note = ?'); args.push(text(input.note, 'Not', 500) ?? null); }
    if (Object.hasOwn(input, 'active')) {
      const v = String(input.active ?? '').trim();
      if (v !== '' && !ACTIVE.includes(v)) throw new PlanningError('Durum "aktif" ya da "pasif" olmalı.');
      cols.push('active = ?'); args.push(v || 'aktif');
    }
    if (cols.length === 0) return cur;
    cols.push('updated_at = ?', 'updated_by = ?'); args.push(now, by);
    this.db.prepare(`UPDATE maintenance_types SET ${cols.join(', ')} WHERE id = ?`).run(...args, Number(id));
    return this.getType(id);
  }

  /** Kullanımdaki (makinesi olan) bir tip silinemez. Yalnız yönetici (kayıtsız uç → admin). */
  deleteType(id) {
    this.getType(id);
    const n = this.db.prepare('SELECT COUNT(*) AS n FROM maintenance_assets WHERE type_id = ?').get(Number(id)).n;
    if (n > 0) throw new PlanningError('Bu tipte makine var, önce onları silin/başka tipe taşıyın.', 409, 'has-assets');
    this.db.prepare('DELETE FROM maintenance_items WHERE type_id = ?').run(Number(id));
    this.db.prepare('DELETE FROM maintenance_types WHERE id = ?').run(Number(id));
    return { ok: true };
  }

  /* ---------------------------------------------------------------------------------------- bakım kalemleri */

  #item(r) {
    return r == null ? null : {
      id: Number(r.id), typeId: Number(r.type_id), description: r.description, responsible: r.responsible,
      requiresNote: r.requires_note, timingNote: r.timing_note, periodUnit: r.period_unit,
      periodEvery: Number(r.period_every), timesPerPeriod: Number(r.times_per_period),
      anchorMonths: r.anchor_months ? JSON.parse(r.anchor_months) : null,
      sortOrder: Number(r.sort_order), active: r.active,
      createdAt: Number(r.created_at), createdBy: r.created_by, updatedAt: Number(r.updated_at), updatedBy: r.updated_by,
    };
  }

  listItems(typeId) {
    return this.db.prepare('SELECT * FROM maintenance_items WHERE type_id = ? ORDER BY sort_order, id').all(Number(typeId)).map((r) => this.#item(r));
  }

  getItem(id) {
    const r = this.db.prepare('SELECT * FROM maintenance_items WHERE id = ?').get(Number(id));
    if (!r) throw new PlanningError('Bakım kalemi bulunamadı.', 404);
    return this.#item(r);
  }

  #itemFields(input, { partial = false } = {}) {
    const out = {};
    const has = (k) => Object.hasOwn(input, k);
    if (!partial || has('description')) {
      const v = text(input.description, 'Bakım açıklaması', 300);
      if (!v) throw new PlanningError('Bakım açıklaması gerekli.');
      out.description = v;
    }
    if (has('responsible')) out.responsible = text(input.responsible, 'Sorumlu', 80);
    if (has('timingNote')) out.timingNote = text(input.timingNote, 'Zamanlama notu', 200);
    if (has('requiresNote')) {
      const v = String(input.requiresNote ?? '').trim();
      if (v !== '' && !REQUIRES_NOTE.includes(v)) throw new PlanningError('"Kayıt" alanı hayir/degisimde/her_zaman olmalı.');
      out.requiresNote = v || 'hayir';
    }
    if (!partial || has('periodUnit')) {
      const v = String(input.periodUnit ?? '').trim();
      if (!PERIOD_UNITS.includes(v)) throw new PlanningError('Periyot birimi vardiya/gun/hafta/ay/yil olmalı.');
      out.periodUnit = v;
    }
    if (has('periodEvery')) out.periodEvery = number(input.periodEvery, 'Kaç birimde bir', { integer: true }) ?? 1;
    if (has('timesPerPeriod')) out.timesPerPeriod = number(input.timesPerPeriod, 'Birim içinde kaç kez', { integer: true }) ?? 1;
    if (has('anchorMonths')) {
      if (input.anchorMonths == null || (Array.isArray(input.anchorMonths) && input.anchorMonths.length === 0)) out.anchorMonths = null;
      else {
        if (!Array.isArray(input.anchorMonths)) throw new PlanningError('Aylar bir liste olmalı.');
        const months = input.anchorMonths.map((m) => Number(m));
        if (!months.every((m) => Number.isInteger(m) && m >= 1 && m <= 12)) throw new PlanningError('Aylar 1-12 arası olmalı.');
        out.anchorMonths = [...new Set(months)].sort((a, b) => a - b);
      }
    }
    if (has('sortOrder')) out.sortOrder = number(input.sortOrder, 'Sıra', { integer: true, allowZero: true }) ?? 0;
    if (has('active')) {
      const v = String(input.active ?? '').trim();
      if (v !== '' && !ACTIVE.includes(v)) throw new PlanningError('Durum "aktif" ya da "pasif" olmalı.');
      out.active = v || 'aktif';
    }
    return out;
  }

  createItem(typeId, input = {}, { by = null, now = Date.now() } = {}) {
    this.getType(typeId); // var olduğunu doğrula
    const f = this.#itemFields(input);
    const id = Number(this.db.prepare(
      `INSERT INTO maintenance_items (type_id, description, responsible, requires_note, timing_note, period_unit,
        period_every, times_per_period, anchor_months, sort_order, active, created_at, created_by, updated_at, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      Number(typeId), f.description, f.responsible ?? null, f.requiresNote ?? 'hayir', f.timingNote ?? null, f.periodUnit,
      f.periodEvery ?? 1, f.timesPerPeriod ?? 1, f.anchorMonths ? JSON.stringify(f.anchorMonths) : null, f.sortOrder ?? 0,
      'aktif', now, by, now, by,
    ).lastInsertRowid);
    return this.getItem(id);
  }

  updateItem(id, input = {}, { by = null, now = Date.now() } = {}) {
    const cur = this.getItem(id);
    const f = this.#itemFields(input, { partial: true });
    if (Object.keys(f).length === 0) return cur;
    const cols = [];
    const args = [];
    const map = {
      description: 'description', responsible: 'responsible', requiresNote: 'requires_note', timingNote: 'timing_note',
      periodUnit: 'period_unit', periodEvery: 'period_every', timesPerPeriod: 'times_per_period', sortOrder: 'sort_order', active: 'active',
    };
    for (const [k, col] of Object.entries(map)) if (Object.hasOwn(f, k)) { cols.push(`${col} = ?`); args.push(f[k] ?? null); }
    if (Object.hasOwn(f, 'anchorMonths')) { cols.push('anchor_months = ?'); args.push(f.anchorMonths ? JSON.stringify(f.anchorMonths) : null); }
    cols.push('updated_at = ?', 'updated_by = ?'); args.push(now, by);
    this.db.prepare(`UPDATE maintenance_items SET ${cols.join(', ')} WHERE id = ?`).run(...args, Number(id));
    return this.getItem(id);
  }

  /** Hiç tiklenmemiş bir kalem silinebilir; geçmişi olan kalem yalnız pasife alınabilir (`update(active:'pasif')`). */
  deleteItem(id) {
    this.getItem(id);
    const n = this.db.prepare('SELECT COUNT(*) AS n FROM maintenance_logs WHERE item_id = ?').get(Number(id)).n;
    if (n > 0) throw new PlanningError('Bu kalemde tik/kayıt geçmişi var, silinemez — "pasif" yapabilirsiniz.', 409, 'has-logs');
    this.db.prepare('DELETE FROM maintenance_items WHERE id = ?').run(Number(id));
    return { ok: true };
  }

  /* --------------------------------------------------------------------------------------------- makineler */

  #searchKey(f, typeName) {
    return foldTr([typeName, f.sicilNo, f.assetNo, f.brand, f.model].filter(Boolean).join(' '));
  }

  #asset(r) {
    return r == null ? null : {
      id: Number(r.id), typeId: Number(r.type_id), sicilNo: r.sicil_no, assetNo: r.asset_no, brand: r.brand, model: r.model,
      motorPowerKw: r.motor_power_kw == null ? null : Number(r.motor_power_kw), purchaseNote: r.purchase_note,
      cncMachineId: r.cnc_machine_id, active: r.active, note: r.note,
      createdAt: Number(r.created_at), createdBy: r.created_by, updatedAt: Number(r.updated_at), updatedBy: r.updated_by,
    };
  }

  getAsset(id) {
    const r = this.db.prepare('SELECT * FROM maintenance_assets WHERE id = ?').get(Number(id));
    if (!r) throw new PlanningError('Makine bulunamadı.', 404);
    return this.#asset(r);
  }

  findAssetBySicilNo(sicilNo) {
    if (!sicilNo) return null;
    const key = foldTr(sicilNo);
    const r = this.db.prepare("SELECT * FROM maintenance_assets WHERE sicil_no IS NOT NULL AND sicil_no <> ''").all().find((a) => foldTr(a.sicil_no) === key);
    return r ? this.#asset(r) : null;
  }

  #assetFields(input, { partial = false } = {}) {
    const out = {};
    const has = (k) => Object.hasOwn(input, k);
    if (!partial || has('typeId')) {
      const id = Number(input.typeId);
      if (!Number.isInteger(id) || id <= 0) throw new PlanningError('Makine tipi gerekli.');
      this.getType(id); // var olduğunu doğrula
      out.typeId = id;
    }
    if (has('sicilNo')) out.sicilNo = text(input.sicilNo, 'Sicil no', 40);
    if (has('assetNo')) out.assetNo = text(input.assetNo, 'Makine numarası', 40);
    if (has('brand')) out.brand = text(input.brand, 'Marka', 80);
    if (has('model')) out.model = text(input.model, 'Model', 80);
    if (has('motorPowerKw')) out.motorPowerKw = number(input.motorPowerKw, 'Motor gücü (KW)', { max: 1000 });
    if (has('purchaseNote')) out.purchaseNote = text(input.purchaseNote, 'Satınalma tarihi/notu', 80);
    if (has('cncMachineId')) out.cncMachineId = text(input.cncMachineId, 'CNC makine kimliği', 20);
    if (has('note')) out.note = text(input.note, 'Not', 1000);
    if (has('active')) {
      const v = String(input.active ?? '').trim();
      if (v !== '' && !ACTIVE.includes(v)) throw new PlanningError('Durum "aktif" ya da "pasif" olmalı.');
      out.active = v || 'aktif';
    }
    return out;
  }

  createAsset(input = {}, { by = null, now = Date.now() } = {}) {
    const f = this.#assetFields(input);
    if (f.sicilNo && this.findAssetBySicilNo(f.sicilNo)) throw new PlanningError('Bu sicil no zaten kayıtlı.', 409, 'duplicate-sicil');
    const typeName = this.getType(f.typeId).name;
    const id = Number(this.db.prepare(
      `INSERT INTO maintenance_assets (type_id, sicil_no, asset_no, brand, model, motor_power_kw, purchase_note,
        cnc_machine_id, active, note, search_key, created_at, created_by, updated_at, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      f.typeId, f.sicilNo ?? null, f.assetNo ?? null, f.brand ?? null, f.model ?? null, f.motorPowerKw ?? null,
      f.purchaseNote ?? null, f.cncMachineId ?? null, f.active ?? 'aktif', f.note ?? null,
      this.#searchKey(f, typeName), now, by, now, by,
    ).lastInsertRowid);
    return this.getAsset(id);
  }

  updateAsset(id, input = {}, { by = null, now = Date.now() } = {}) {
    const cur = this.getAsset(id);
    const f = this.#assetFields(input, { partial: true });
    if (Object.keys(f).length === 0) return cur;
    if (Object.hasOwn(f, 'sicilNo') && f.sicilNo) {
      const other = this.findAssetBySicilNo(f.sicilNo);
      if (other && other.id !== cur.id) throw new PlanningError('Bu sicil no zaten kayıtlı.', 409, 'duplicate-sicil');
    }
    const next = { ...cur, ...f };
    const typeName = this.getType(next.typeId).name;
    const cols = [];
    const args = [];
    const map = {
      typeId: 'type_id', sicilNo: 'sicil_no', assetNo: 'asset_no', brand: 'brand', model: 'model',
      motorPowerKw: 'motor_power_kw', purchaseNote: 'purchase_note', cncMachineId: 'cnc_machine_id', active: 'active', note: 'note',
    };
    for (const [k, col] of Object.entries(map)) if (Object.hasOwn(f, k)) { cols.push(`${col} = ?`); args.push(f[k] ?? null); }
    cols.push('search_key = ?'); args.push(this.#searchKey(next, typeName));
    cols.push('updated_at = ?', 'updated_by = ?'); args.push(now, by);
    this.db.prepare(`UPDATE maintenance_assets SET ${cols.join(', ')} WHERE id = ?`).run(...args, Number(id));
    return this.getAsset(id);
  }

  /** Hiç log'u olmayan bir makine silinebilir; geçmişi olan makine yalnız pasife alınabilir. */
  deleteAsset(id) {
    this.getAsset(id);
    const n = this.db.prepare('SELECT COUNT(*) AS n FROM maintenance_logs WHERE asset_id = ?').get(Number(id)).n;
    if (n > 0) throw new PlanningError('Bu makinede tik/kayıt geçmişi var, silinemez — "pasif" yapabilirsiniz.', 409, 'has-logs');
    this.db.prepare('DELETE FROM maintenance_assets WHERE id = ?').run(Number(id));
    return { ok: true };
  }

  /* -------------------------------------------------------------------------------------------------- loglar */

  #log(r) {
    return r == null ? null : {
      id: Number(r.id), assetId: Number(r.asset_id), itemId: r.item_id == null ? null : Number(r.item_id), kind: r.kind,
      changed: !!r.changed, doneOn: Number(r.done_on), company: r.company, description: r.description, person: r.person,
      createdAt: Number(r.created_at), createdBy: r.created_by,
    };
  }

  /**
   * Bir tik (`itemId` verilirse, `kind` zorunlu olarak 'kontrol') ya da serbest rutin/arızi kayıt (`itemId` yok,
   * `kind` 'rutin'|'arizi') ekler. Kağıttaki "imza" yerine oturumdaki kullanıcı (`by`) kullanılır.
   */
  addLog(assetId, input = {}, { by = null, now = Date.now() } = {}) {
    const asset = this.getAsset(assetId);
    const itemId = input.itemId == null || input.itemId === '' ? null : Number(input.itemId);
    let item = null;
    if (itemId != null) {
      item = this.getItem(itemId);
      if (item.typeId !== asset.typeId) throw new PlanningError('Bu bakım kalemi bu makinenin tipine ait değil.', 400);
      if (String(input.kind ?? 'kontrol') !== 'kontrol') throw new PlanningError('Bir kaleme bağlı kayıt "kontrol" türünde olmalı.');
    }
    const kind = itemId != null ? 'kontrol' : String(input.kind ?? '').trim();
    if (!LOG_KIND.includes(kind)) throw new PlanningError('Kayıt türü kontrol/rutin/arizi olmalı.');
    if (itemId == null && kind === 'kontrol') throw new PlanningError('Serbest kayıt (kalemsiz) "rutin" ya da "arizi" olmalı.');
    const changed = itemId != null && item.requiresNote === 'degisimde' ? Boolean(input.changed) : false;
    const d = new Date(now);
    const doneOn = day(input.doneOn, 'Tarih') ?? new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const company = text(input.company, 'Firma', 120);
    const description = text(input.description, 'Açıklama/not', 500);
    if ((kind === 'rutin' || kind === 'arizi') && !description && !company) throw new PlanningError('Rutin/arızi kayıtta en az firma ya da açıklama girilmeli.');
    const id = Number(this.db.prepare(
      `INSERT INTO maintenance_logs (asset_id, item_id, kind, changed, done_on, company, description, person, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(Number(assetId), itemId, kind, changed ? 1 : 0, doneOn, company ?? null, description ?? null, by, now, by).lastInsertRowid);
    return this.#log(this.db.prepare('SELECT * FROM maintenance_logs WHERE id = ?').get(id));
  }

  listLogs(assetId, { itemId, kind, limit = 50 } = {}) {
    const conds = ['asset_id = ?'];
    const args = [Number(assetId)];
    if (itemId != null && itemId !== '') { conds.push('item_id = ?'); args.push(Number(itemId)); }
    if (LOG_KIND.includes(kind)) { conds.push('kind = ?'); args.push(kind); }
    const rows = this.db.prepare(`SELECT * FROM maintenance_logs WHERE ${conds.join(' AND ')} ORDER BY done_on DESC, id DESC LIMIT ?`)
      .all(...args, Math.max(1, Math.min(500, Number(limit) || 50)));
    return rows.map((r) => this.#log(r));
  }

  /** Yanlış girilen tik/kayıt. Yalnız yönetici (kayıtsız uç → admin). */
  deleteLog(id) {
    const r = this.db.prepare('SELECT * FROM maintenance_logs WHERE id = ?').get(Number(id));
    if (!r) throw new PlanningError('Kayıt bulunamadı.', 404);
    this.db.prepare('DELETE FROM maintenance_logs WHERE id = ?').run(Number(id));
    return { ok: true };
  }

  /* --------------------------------------------------------------------------------------------- genel görünüm */

  /**
   * Ekranın tek bulk-okuma ucu: tip → makine → kalem (durum hesaplanmış) ağacı. Veri küçük (≈5 tip, ≈12 makine,
   * ≈150 (makine,kalem) çifti) — ayrı sayfalama/istekler gerekmiyor; accordion yalnız RENDER'ı geciktirir, veri
   * TEK istekte gelir.
   */
  overview({ q = '', now = Date.now() } = {}) {
    const logs = this.db.prepare("SELECT asset_id, item_id, done_on, person FROM maintenance_logs WHERE kind = 'kontrol' ORDER BY done_on ASC").all();
    const byPair = new Map(); // "assetId:itemId" -> [doneOn,...] artan
    const lastLog = new Map(); // "assetId:itemId" -> {doneOn, person} (artan sirada son gorulen = en yeni)
    for (const l of logs) {
      const key = `${l.asset_id}:${l.item_id}`;
      if (!byPair.has(key)) byPair.set(key, []);
      byPair.get(key).push(Number(l.done_on));
      lastLog.set(key, { doneOn: Number(l.done_on), person: l.person });
    }

    const types = this.db.prepare('SELECT * FROM maintenance_types ORDER BY name').all().map((r) => this.#type(r));
    const itemsByType = new Map(types.map((t) => [t.id, this.listItems(t.id)]));
    const assetRows = this.db.prepare('SELECT * FROM maintenance_assets ORDER BY type_id, id').all().map((r) => this.#asset(r));

    const needle = q.trim() ? foldTr(q) : '';
    const out = [];
    for (const type of types) {
      const items = itemsByType.get(type.id) ?? [];
      const assets = assetRows.filter((a) => a.typeId === type.id)
        .filter((a) => !needle || foldTr([type.name, a.sicilNo, a.assetNo, a.brand, a.model].filter(Boolean).join(' ')).includes(needle))
        .map((asset) => {
          const assetItems = items.map((item) => {
            const key = `${asset.id}:${item.id}`;
            const doneAtList = byPair.get(key) ?? [];
            const referenceAt = Math.max(asset.createdAt, item.createdAt);
            const due = nextDueAt(item, doneAtList, { referenceAt, now });
            const last = lastLog.get(key) ?? null;
            return { ...item, nextDueAt: due, status: dueStatus(due, item.periodUnit, now), lastDoneOn: last?.doneOn ?? null, lastDoneBy: last?.person ?? null };
          }).filter((it) => it.active === 'aktif');
          return { ...asset, items: assetItems, worstStatus: worstStatus(assetItems.map((it) => it.status)) };
        });
      if (needle && assets.length === 0) continue;
      out.push({ ...type, items, assets, worstStatus: worstStatus(assets.map((a) => a.worstStatus)) });
    }
    return { types: out };
  }

  /* --------------------------------------------------------------------------------------------- otomatik tik */

  /** Otomatik tik AÇIK mı — ayar hiç ayarlanmamışsa (ilk kurulum) VARSAYILAN AÇIKTIR (özelliğin asıl amacı bu). */
  autoTickEnabled() {
    return this.planning.db.getSetting(AUTO_SETTING_KEY) !== '0';
  }

  /** Bakım ekranının kendi üst çubuğundan (admin) çağrılır — `routes.js`'te kayıtsız bırakıldı, admin'e düşer. */
  setAutoTickEnabled(on) {
    this.planning.db.setSetting(AUTO_SETTING_KEY, on ? '1' : '0');
    return { enabled: this.autoTickEnabled() };
  }

  /**
   * `server.js`'teki periyodik bir `setInterval` tarafından çağrılır (bkz. CLAUDE.md §6 "Bakım: otomatik tik").
   * Anahtar KAPALIYSA hiçbir şey yapmaz (ne yeni bir rastgele an PLANLANIR ne de önceden planlanmış biri
   * ATEŞLENİR — kapatınca GERÇEKTEN durmalı). Her (makine, kalem) çifti kendi kuyruk satırını taşır; HER MAKİNE
   * İÇİN BAĞIMSIZ bir rastgele an seçilir (`random`, testlerde enjekte edilebilir — `schedule.js#suggest({run})`
   * ile AYNI ilke). Zaten `dueStatus()`'un var olan "yaklaşıyor/gecikti" mantığına biner: bir kalem yalnız KENDİ
   * grace penceresi açıldığında (ör. haftalıkta son 2 gün) ya da zaten gecikmişse ele alınır — ayrı bir "tüm
   * periyot" penceresi İCAT EDİLMEDİ.
   * @returns {{scheduled:number, fired:number}}
   */
  runAutoTick({ now = Date.now(), random = Math.random } = {}) {
    if (!this.autoTickEnabled()) return { scheduled: 0, fired: 0 };
    let scheduled = 0;
    let fired = 0;
    const assets = this.db.prepare("SELECT * FROM maintenance_assets WHERE active = 'aktif'").all().map((r) => this.#asset(r));
    const itemsByType = new Map();
    for (const asset of assets) {
      if (!itemsByType.has(asset.typeId)) {
        itemsByType.set(asset.typeId, this.listItems(asset.typeId).filter((it) => it.active === 'aktif' && PERIOD_UNITS.includes(it.periodUnit)));
      }
      for (const item of itemsByType.get(asset.typeId)) {
        const doneAtList = this.db.prepare(
          "SELECT done_on FROM maintenance_logs WHERE asset_id = ? AND item_id = ? AND kind = 'kontrol' ORDER BY done_on ASC",
        ).all(asset.id, item.id).map((r) => Number(r.done_on));
        const referenceAt = Math.max(asset.createdAt, item.createdAt);
        const due = nextDueAt(item, doneAtList, { referenceAt, now });
        if (due == null || dueStatus(due, item.periodUnit, now) === 'tamam') continue; // henuz sira gelmedi
        const existing = this.db.prepare('SELECT * FROM maintenance_auto_queue WHERE asset_id = ? AND item_id = ? AND due_at = ?').get(asset.id, item.id, due);
        if (!existing) {
          // bu pencere icin ilk kez goruluyor: HER MAKINE icin BAGIMSIZ rastgele bir an sec.
          const windowEnd = due > now ? due : now + AUTO_CATCHUP_MAX_MS;
          const target = now + Math.floor(random() * Math.max(1, windowEnd - now));
          try {
            this.db.prepare('INSERT INTO maintenance_auto_queue (asset_id, item_id, due_at, target_at, created_at) VALUES (?,?,?,?,?)')
              .run(asset.id, item.id, due, target, now);
            scheduled += 1;
          } catch { /* ayni (makine,kalem,pencere) icin es zamanli ikinci bir cagri - benzersizlik index'i reddetti, yoksay */ }
        } else if (!existing.fired_at && Number(existing.target_at) <= now) {
          this.addLog(asset.id, { itemId: item.id, kind: 'kontrol' }, { by: AUTO_PERSON, now });
          this.db.prepare('UPDATE maintenance_auto_queue SET fired_at = ? WHERE id = ?').run(now, existing.id);
          fired += 1;
        }
      }
    }
    // temizlik: atesleneni uzun sure sakla (ateslenmemis bilgi degil), ATESLENMEDEN kalan (ustanin elle tikledigi
    // icin o pencerenin due_at'i artik gecersiz oldugu — hic yeniden sorgulanmayacak) satirlari daha cabuk at.
    this.db.prepare('DELETE FROM maintenance_auto_queue WHERE fired_at IS NOT NULL AND fired_at < ?').run(now - AUTO_FIRED_RETENTION_MS);
    this.db.prepare('DELETE FROM maintenance_auto_queue WHERE fired_at IS NULL AND created_at < ?').run(now - AUTO_ORPHAN_RETENTION_MS);
    return { scheduled, fired };
  }

  /* ---------------------------------------------------------------------------------------- Excel'den ilk kurulum */

  /**
   * Setup.exe kurulumunda İLK SEFER için: gerçek BAKIM SİCİL KARTLARI Excel'ini içeri aktarır. Her SAYFA bir
   * makineye karşılık gelir; aynı tip (ör. "CNC TORNA") birden çok sayfada tekrar ediyorsa bakım kalemleri YALNIZ
   * İLK sayfadan (ya da DB'de zaten varsa hiç) oluşturulur — periyotlar tip bazında, 7 torna tek tanımı paylaşır.
   * Sicil no (varsa) zaten kayıtlıysa o sayfa atlanır (iki kez yüklemek güvenlidir).
   */
  importXlsx(buffer, { by = null, now = Date.now() } = {}) {
    let book;
    try { book = readXlsx(buffer); } catch (err) { throw err instanceof XlsxError ? new PlanningError(err.message) : err; }

    let totalSheets = 0;
    let addedAssets = 0;
    let addedTypes = 0;
    let skipped = 0;
    const warnings = [];
    const warn = (m) => { if (warnings.length < 40) warnings.push(m); else if (warnings.length === 40) warnings.push('… ve daha fazla uyarı var'); };
    const typesSeenThisRun = new Set(); // ad (foldTr) -> bu calistirmada kalemleri zaten islendi

    for (const sheet of book.sheets) {
      if (sheet.hidden) continue;
      const rows = sheet.rows;
      totalSheets += 1;

      const typeName = nextCellValue(rows, LABEL.TANIM);
      if (!typeName) { warn(`"${sheet.name}": makine/cihaz tanımı bulunamadı, sayfa atlandı.`); skipped += 1; continue; }
      const sicilNo = rawLabelMatch(rows, /Sicil\s*No\s*:\s*(.+)/i);
      if (sicilNo && this.findAssetBySicilNo(sicilNo)) { warn(`"${sheet.name}": sicil no "${sicilNo}" zaten kayıtlı, sayfa atlandı.`); skipped += 1; continue; }

      const found = findHeaderByKeys(rows, BAKIM_HEADER_KEYS, { maxRows: 20 });
      if (!found) { warn(`"${sheet.name}": bakım kalemleri tablosu (YAPILACAK BAKIM/PERİYODU/SORUMLU/KAYDEDİLECEĞİ YER) bulunamadı.`); }

      let type = this.findTypeByName(typeName);
      const typeKey = foldTr(typeName);
      const isNewType = !type;
      if (!type) { type = this.createType({ name: typeName }, { by, now }); addedTypes += 1; }

      if (found && !typesSeenThisRun.has(typeKey) && (isNewType || this.listItems(type.id).length === 0)) {
        typesSeenThisRun.add(typeKey);
        const { index, headerRow } = found;
        const col = (k) => index.get(k);
        let sortOrder = 0;
        for (let r = headerRow + 1; r < rows.length; r += 1) {
          const row = rows[r];
          const desc = String(row[col('YAPILACAKBAKIM')] ?? '').trim();
          const periyodu = String(row[col('PERIYODU')] ?? '').trim();
          if (!desc || !periyodu) break; // cek-listesi bitti (dipnot/HAZIRLAYAN satirina gelindi)
          const sorumlu = String(row[col('SORUMLU')] ?? '').trim();
          const kayit = String(row[col('KAYDEDILECEGIYER')] ?? '').trim();
          const period = parsePeriodText(periyodu);
          if (!period) warn(`"${sheet.name}", "${desc}": periyot metni ("${periyodu.replace(/\s+/g, ' ')}") tanınmadı, elle ayarlanmalı.`);
          sortOrder += 1;
          this.createItem(type.id, {
            description: desc, responsible: sorumlu || null, requiresNote: parseRequiresNote(kayit),
            periodUnit: period?.periodUnit ?? 'gun', // taninmayan periyotta gecerli bir birim gerekir; admin duzeltene kadar "gun" varsayilir
            periodEvery: period?.periodEvery ?? 1, timesPerPeriod: period?.timesPerPeriod ?? 1,
            anchorMonths: period?.anchorMonths ?? null, timingNote: period?.timingNote ?? null, sortOrder,
          }, { by, now });
        }
      } else typesSeenThisRun.add(typeKey);

      const assetNo = nextCellValue(rows, LABEL.NUMARA);
      const brand = nextCellValue(rows, LABEL.MARKA);
      const model = nextCellValue(rows, LABEL.MODEL);
      const motorRaw = nextCellValue(rows, LABEL.MOTOR);
      // `number()` ("." binlik ayracı) DEĞİL: bu hücre readXlsx'ten geldiği için (readXlsx her sayıyı zaten nokta-ondalık
      // METNE çevirir, binlik gruplama HİÇ eklemez) burada "." zaten gerçek bir ondalık noktasıdır — motor gücü de
      // hiçbir zaman binlerce KW olmaz, bu yüzden Turkce binlik-ayracı yorumu burada YANLIŞ olurdu (7.5 -> 75).
      let motorPowerKw = null;
      if (motorRaw) {
        const n = Number(String(motorRaw).trim().replace(',', '.'));
        if (Number.isFinite(n) && n > 0 && n <= 1000) motorPowerKw = n;
        else warn(`"${sheet.name}": motor gücü ("${motorRaw}") okunamadı.`);
      }
      const purchaseNote = nextCellValue(rows, LABEL.SATINALMA);

      this.createAsset({ typeId: type.id, sicilNo, assetNo, brand, model, motorPowerKw, purchaseNote }, { by, now });
      addedAssets += 1;
    }
    return { totalSheets, addedTypes, addedAssets, skipped, warnings };
  }
}
