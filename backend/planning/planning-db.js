/**
 * Planlama veritabani - AYRI dosya (data/planlama.db). Telemetri (telemetry.db) ve program kutuphanesinden (library.db) bilerek ayri:
 * uretim plani, urun kartlari ve siparis satirlari budanmaz, ayri yedeklenir. `node:sqlite`, bagimlilik yok.
 *
 *   products          urun karti (stok kodu = Mikro stok kodu / "ALEN KOD"). Anahtar: katlanmis kod (Nİ002.001 = NI002.001)
 *   product_programs  program adi -> urun eslemesi (tornadaki program adi, buyuk/kucuk ve Turkce harf duyarsiz)
 *   order_lines       siparis satirlari (kaynak: CSV simdilik, ileride Mikro); tekrar iceri alinabilir (line_key)
 *   import_batches    her iceri alma: kim, ne zaman, kac satir, uyarilar
 *
 * Birimler: agirliklar KG (parca basina), uzunluk MM, sure SN. Excel'deki "BRUT GR/NET GR" kolonlari aslinda KG'dir.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { foldTr } from './normalize.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  code_key      TEXT PRIMARY KEY,
  stock_code    TEXT NOT NULL,
  name          TEXT,
  customer_code TEXT,
  material      TEXT,
  alt_material  TEXT,
  length_mm     REAL,
  net_kg        REAL,
  gross_kg      REAL,
  planned_sec   REAL,
  note          TEXT,
  measure_plan  TEXT,
  measure_plan_at INTEGER,
  source        TEXT    NOT NULL,
  edited        INTEGER NOT NULL DEFAULT 0,
  search_key    TEXT    NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  updated_by    TEXT
);
CREATE INDEX IF NOT EXISTS idx_products_customer_code ON products (customer_code);

CREATE TABLE IF NOT EXISTS product_programs (
  program_key  TEXT PRIMARY KEY,
  program_name TEXT NOT NULL,
  code_key     TEXT NOT NULL REFERENCES products(code_key),
  source       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  created_by   TEXT
);
CREATE INDEX IF NOT EXISTS idx_product_programs_code ON product_programs (code_key);

CREATE TABLE IF NOT EXISTS import_batches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT    NOT NULL,
  filename    TEXT,
  at          INTEGER NOT NULL,
  imported_by TEXT,
  total_rows  INTEGER,
  added       INTEGER,
  updated     INTEGER,
  unchanged   INTEGER,
  skipped     INTEGER,
  warnings    TEXT
);

CREATE TABLE IF NOT EXISTS order_lines (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  line_key       TEXT    NOT NULL UNIQUE,
  source         TEXT    NOT NULL,
  doc_no         TEXT    NOT NULL DEFAULT '',
  doc_key        TEXT    NOT NULL DEFAULT '',
  customer       TEXT    NOT NULL DEFAULT '',
  customer_key   TEXT    NOT NULL DEFAULT '',
  cust_order_no  TEXT    NOT NULL DEFAULT '',
  cust_order_key TEXT    NOT NULL DEFAULT '',
  code_key       TEXT    NOT NULL DEFAULT '',
  stock_code     TEXT    NOT NULL DEFAULT '',
  item_name      TEXT,
  item_key       TEXT    NOT NULL DEFAULT '',
  order_date     INTEGER,
  qty            REAL,
  shipped        REAL,
  remaining      REAL,
  due_date       INTEGER,
  material       TEXT,
  last_batch     INTEGER NOT NULL,
  stale          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_lines_cust_order ON order_lines (cust_order_key);
CREATE INDEX IF NOT EXISTS idx_lines_doc ON order_lines (doc_key);
CREATE INDEX IF NOT EXISTS idx_lines_code ON order_lines (code_key);

-- Is emirleri. Urun degerleri (hammadde, gramaj, sure ...) is emri acildigi andaki KOPYADIR: urun karti sonradan degisse eski is emri degismez.
CREATE TABLE IF NOT EXISTS work_orders (
  no              TEXT    PRIMARY KEY,
  year            INTEGER NOT NULL,
  seq             INTEGER NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'planlandi',
  machine_id      TEXT    NOT NULL,
  code_key        TEXT    NOT NULL,
  stock_code      TEXT    NOT NULL,
  line_id         INTEGER,
  doc_no          TEXT    NOT NULL DEFAULT '',
  cust_order_no   TEXT    NOT NULL DEFAULT '',
  customer        TEXT    NOT NULL DEFAULT '',
  target_qty      INTEGER NOT NULL,
  due_date        INTEGER,
  sample_qty      INTEGER,
  product_name    TEXT,
  customer_code   TEXT,
  material        TEXT,
  alt_material    TEXT,
  length_mm       REAL,
  net_kg          REAL,
  gross_kg        REAL,
  planned_sec     REAL,
  used_material   TEXT,
  material_gk_no  TEXT,
  gkk_report_no   TEXT,
  first_approval_no TEXT,
  measured_net_kg REAL,
  note            TEXT,
  search_key      TEXT    NOT NULL DEFAULT '',
  cancelled_at    INTEGER,
  cancel_reason   TEXT,
  started_at      INTEGER,
  started_by      TEXT,
  started_person  TEXT,
  start_total     INTEGER,
  finished_at     INTEGER,
  finished_by     TEXT,
  finished_person TEXT,
  finish_total    INTEGER,
  result_json     TEXT,
  fis_at          INTEGER,
  fis_by          TEXT,
  fis_doc_no      TEXT,
  fis_kg          REAL,
  fis_note        TEXT,
  created_at      INTEGER NOT NULL,
  created_by      TEXT,
  updated_at      INTEGER NOT NULL,
  updated_by      TEXT,
  UNIQUE (year, seq)
);
CREATE INDEX IF NOT EXISTS idx_wo_machine ON work_orders (machine_id, status);
CREATE INDEX IF NOT EXISTS idx_wo_line ON work_orders (line_id);
CREATE INDEX IF NOT EXISTS idx_wo_code ON work_orders (code_key);

CREATE TABLE IF NOT EXISTS work_order_events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  wo_no  TEXT    NOT NULL,
  at     INTEGER NOT NULL,
  by     TEXT,
  kind   TEXT    NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_wo_events_no ON work_order_events (wo_no);

-- Durus nedeni kodlari (config/downtime-codes.json'dan esitlenir; kodlar silinmez, kaldirilanlar pasif olur: eski kayitlar bagli kalir)
CREATE TABLE IF NOT EXISTS downtime_codes (
  code     TEXT    PRIMARY KEY,
  name     TEXT    NOT NULL,
  grp      TEXT    NOT NULL,
  kind     TEXT    NOT NULL,
  frequent INTEGER NOT NULL DEFAULT 0,
  sort     INTEGER NOT NULL,
  active   INTEGER NOT NULL DEFAULT 1
);

-- Durus nedenleri: olculmus bir durusun ALT ARALIGINA baglanir (sure telemetriden, neden insandan). Silme yumusaktir (denetim izi).
CREATE TABLE IF NOT EXISTS downtime_reasons (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id TEXT    NOT NULL,
  from_ts    INTEGER NOT NULL,
  to_ts      INTEGER NOT NULL,
  code       TEXT    NOT NULL,
  note       TEXT,
  wo_no      TEXT,
  person     TEXT,
  entered_by TEXT,
  entered_at INTEGER NOT NULL,
  deleted_at INTEGER,
  deleted_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_downtime_reasons_machine ON downtime_reasons (machine_id, from_ts);

-- Kasalar (Urun Tanitim Karti, K asamasi): makineden cikan urun kasaya dolar, her kasaya sistemin bastigi bir kart konur. Dolarken adet BILINMEZ:
-- kasa acilirken / kapanirken tezgahin parca sayaci kaydedilir (sayilan adet = telemetri tahmini), kesin adet paketlemede girilir (packed_qty).
-- wash_* / dry_* / anneal_*: kartta isaretlenen islemler (karti basarken usta tikler): yikamaya gidecek / yikandi, kurutmaya gidecek / kurutuldu, tavlamaya gidecek / tavlandi (0/1).
-- reject: kartta "URUN RET" tiki (0/1). Ret edilen kasa PAKETLEMEYE GITMEZ (tekrar isleme ya da hurdaya ayrilir): durumu 'ret', paketleme listesine dusmez.
CREATE TABLE IF NOT EXISTS crates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  seq           INTEGER NOT NULL UNIQUE,
  wo_no         TEXT    NOT NULL,
  machine_id    TEXT    NOT NULL,
  opened_at     INTEGER NOT NULL,
  opened_by     TEXT,
  opened_person TEXT,
  start_total   INTEGER,
  closed_at     INTEGER,
  closed_by     TEXT,
  closed_person TEXT,
  end_total     INTEGER,
  counted_qty   INTEGER,
  approx_qty    INTEGER,
  packed_qty    INTEGER,
  packed_at     INTEGER,
  packed_by     TEXT,
  packed_person TEXT,
  note          TEXT,
  voided_at     INTEGER,
  voided_by     TEXT,
  void_reason   TEXT,
  wash_to       INTEGER NOT NULL DEFAULT 0,
  wash_done     INTEGER NOT NULL DEFAULT 0,
  dry_to        INTEGER NOT NULL DEFAULT 0,
  dry_done      INTEGER NOT NULL DEFAULT 0,
  anneal_to     INTEGER NOT NULL DEFAULT 0,
  anneal_done   INTEGER NOT NULL DEFAULT 0,
  reject        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_crates_wo ON crates (wo_no);

-- Olcu kontrolu (EYS.FR.005): is emrinde saatlik olcumler. Sutun = 30 dk'ya yuvarlanmis zaman (slot); kind 'olcu' (row_no 1..10: deger) ya da
-- 'gorsel' / 'gecer' / 'gecmez' (row_no 0: ok 1/0). Ayni (is emri, slot, kind, satir) yeniden kaydedilirse GUNCELLENIR. Urun tanitim karti kendi
-- zaman araligindaki olcumleri gosterir (measured_at = girisin gercek zamani).
CREATE TABLE IF NOT EXISTS measurements (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  wo_no          TEXT    NOT NULL,
  slot           INTEGER NOT NULL,
  kind           TEXT    NOT NULL,
  row_no         INTEGER NOT NULL DEFAULT 0,
  value          REAL,
  ok             INTEGER,
  measured_at    INTEGER NOT NULL,
  entered_by     TEXT,
  entered_person TEXT,
  UNIQUE (wo_no, slot, kind, row_no)
);
CREATE INDEX IF NOT EXISTS idx_measurements_wo ON measurements (wo_no, slot);

-- Is emri numarasi tabani: Excel'de en son verilen sira (iceri alinan is emirleri listesinden ya da elle). Yil basina.
CREATE TABLE IF NOT EXISTS seq_floor (
  year  INTEGER PRIMARY KEY,
  floor INTEGER NOT NULL
);
`;

/** LIKE ozel karakterlerini kacirir (kullanici metni desen olmasin). */
import { CRATE_STEP_COLUMNS } from './card-steps.js';

const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const productOut = (r) => (r == null ? null : {
  codeKey: r.code_key,
  stockCode: r.stock_code,
  name: r.name,
  customerCode: r.customer_code,
  material: r.material,
  altMaterial: r.alt_material,
  lengthMm: r.length_mm,
  netKg: r.net_kg,
  grossKg: r.gross_kg,
  plannedSec: r.planned_sec,
  note: r.note,
  measurePlan: r.measure_plan ? JSON.parse(r.measure_plan) : [],
  measurePlanAt: r.measure_plan_at == null ? null : Number(r.measure_plan_at),
  source: r.source,
  edited: r.edited === 1,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
  updatedBy: r.updated_by,
  ...(r.program_count !== undefined ? { programCount: Number(r.program_count) } : {}),
});

export class PlanningDb {
  /** @param {string} file ':memory:' testler icin */
  constructor(file) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);
    this.#migrate();
  }

  /** Eski veritabanlari (C asamasindan once olusanlar): is emri yasam dongusu sutunlari eklenir. */
  #migrate() {
    const have = new Set(this.db.prepare('PRAGMA table_info(work_orders)').all().map((c) => c.name));
    const add = [
      ['started_at', 'INTEGER'], ['started_by', 'TEXT'], ['started_person', 'TEXT'], ['start_total', 'INTEGER'],
      ['finished_at', 'INTEGER'], ['finished_by', 'TEXT'], ['finished_person', 'TEXT'], ['finish_total', 'INTEGER'], ['result_json', 'TEXT'],
      // D asamasi: Mikro sarfiyat fisi takibi (elle girildi isareti)
      ['fis_at', 'INTEGER'], ['fis_by', 'TEXT'], ['fis_doc_no', 'TEXT'], ['fis_kg', 'REAL'], ['fis_note', 'TEXT'],
      // olcu kontrolu: is emrinin olcu plani (JSON: [{label, nominal, lower, upper}])
      ['measure_plan', 'TEXT'], ['measure_plan_at', 'INTEGER'],
    ];
    for (const [name, type] of add) if (!have.has(name)) this.db.exec(`ALTER TABLE work_orders ADD COLUMN ${name} ${type}`);

    // urun karti: kalici olcu plani (her urunun olculeri farklidir; 3 olcu ya da 5 olcu olabilir)
    const haveP = new Set(this.db.prepare('PRAGMA table_info(products)').all().map((c) => c.name));
    for (const [name, type] of [['measure_plan', 'TEXT'], ['measure_plan_at', 'INTEGER']]) if (!haveP.has(name)) this.db.exec(`ALTER TABLE products ADD COLUMN ${name} ${type}`);

    // kasa/kart: yikama, kurutma, tavlama isaretleri (eski veritabanlari bos = hicbiri isaretli degil)
    const haveC = new Set(this.db.prepare('PRAGMA table_info(crates)').all().map((c) => c.name));
    for (const name of [...CRATE_STEP_COLUMNS, 'reject']) if (!haveC.has(name)) this.db.exec(`ALTER TABLE crates ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`);
  }

  /** Urun kartinin olcu plani (JSON metni) ve zamani; yeni is emrine kopyalanir (is emrinin plani daha yeniyse o). */
  setProductMeasurePlan(codeKey, planJson, now = Date.now()) {
    this.db.prepare('UPDATE products SET measure_plan = ?, measure_plan_at = ? WHERE code_key = ?').run(planJson, now, codeKey);
  }

  /**
   * Olcu kontrolu olan is emirleri (en son olcum ustte): olcum girilmis sutun sayisi ve son olcum zamani.
   * @returns {{total: number, items: {no: string, columns: number, lastAt: number}[]}}
   */
  measureReportRows({ q = '', limit = 50, offset = 0 } = {}) {
    const key = foldTr(q);
    const where = key === '' ? '' : "WHERE w.search_key LIKE ? ESCAPE '\\'";
    const args = key === '' ? [] : [`%${likeEscape(key)}%`];
    const from = `FROM (SELECT wo_no, COUNT(DISTINCT slot) AS cols, MAX(measured_at) AS last_at FROM measurements GROUP BY wo_no) m JOIN work_orders w ON w.no = m.wo_no ${where}`;
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...args).n);
    const items = this.db.prepare(`SELECT w.no, m.cols, m.last_at ${from} ORDER BY m.last_at DESC LIMIT ? OFFSET ?`).all(...args, limit, offset)
      .map((r) => ({ no: r.no, columns: Number(r.cols), lastAt: Number(r.last_at) }));
    return { total, items };
  }

  /* ------------------------------------------------------------ olcu kontrolu */

  /**
   * Ayni urunun EN SON DUZENLENEN olcu plani (JSON metni + duzenlenme zamani): yeni is emrine kopyalanir, plan bir kez tanimlanir.
   * Kopya kaynagin zamanini tasir (kopyalamak planin "son duzenlenme" sirasini degistirmez).
   */
  latestMeasurePlan(codeKey) {
    const r = this.db.prepare(
      `SELECT measure_plan, measure_plan_at FROM work_orders WHERE code_key = ? AND measure_plan IS NOT NULL AND measure_plan <> '[]' AND measure_plan <> ''
        ORDER BY measure_plan_at DESC, created_at DESC, no DESC LIMIT 1`,
    ).get(codeKey);
    return r ? { plan: r.measure_plan, at: r.measure_plan_at == null ? 0 : Number(r.measure_plan_at) } : null;
  }

  upsertMeasurement({ woNo, slot, kind, rowNo = 0, value = null, ok = null, measuredAt, by = null, person = null }) {
    this.db.prepare(
      `INSERT INTO measurements (wo_no, slot, kind, row_no, value, ok, measured_at, entered_by, entered_person) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT (wo_no, slot, kind, row_no) DO UPDATE SET value = excluded.value, ok = excluded.ok, measured_at = excluded.measured_at,
         entered_by = excluded.entered_by, entered_person = excluded.entered_person`,
    ).run(woNo, slot, kind, rowNo, value, ok, measuredAt, by, person);
  }

  deleteMeasurement(woNo, slot, kind, rowNo = 0) {
    this.db.prepare('DELETE FROM measurements WHERE wo_no = ? AND slot = ? AND kind = ? AND row_no = ?').run(woNo, slot, kind, rowNo);
  }

  /** Bir is emrinin tum olcum kayitlari (slot, sonra kind/satir sirasiyla). */
  measurementsOfWo(woNo) {
    return this.db.prepare('SELECT * FROM measurements WHERE wo_no = ? ORDER BY slot, kind, row_no').all(woNo).map((r) => ({
      slot: Number(r.slot), kind: r.kind, rowNo: Number(r.row_no), value: r.value == null ? null : Number(r.value), ok: r.ok == null ? null : r.ok === 1,
      measuredAt: Number(r.measured_at), by: r.entered_by, person: r.entered_person,
    }));
  }

  /** Plan satir sayisi azaltilirken: bu satirdan sonrasinda olcum kaydi var mi? */
  maxMeasuredRow(woNo) {
    return Number(this.db.prepare("SELECT COALESCE(MAX(row_no), 0) AS m FROM measurements WHERE wo_no = ? AND kind = 'olcu'").get(woNo).m);
  }

  lastMeasurementAt(woNo) {
    const r = this.db.prepare('SELECT MAX(measured_at) AS t FROM measurements WHERE wo_no = ?').get(woNo);
    return r?.t == null ? null : Number(r.t);
  }

  /** Tek islemde calistirir; hata olursa geri alinir. */
  tx(fn) {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /* ------------------------------------------------------------- urunler */

  getProduct(codeKey) {
    return productOut(this.db.prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM product_programs x WHERE x.code_key = p.code_key) AS program_count
         FROM products p WHERE p.code_key = ?`,
    ).get(codeKey));
  }

  /** Musteri urun kodundan (birden cok urun olabilir). */
  productsByCustomerCode(customerCode) {
    if (!customerCode) return [];
    return this.db.prepare('SELECT * FROM products WHERE customer_code = ? ORDER BY stock_code').all(customerCode).map(productOut);
  }

  /**
   * Adi verilen kodla BASLAYAN urunler ("600000000001 TEST NİPEL ..."): musteri kodu bos kalmis urunler icin program onerisi.
   * Ad ilk sozcugu musteri koduyla her zaman ayni degil (gercek veride ~%65), bu yuzden yalniz ONERI olarak kullanilir.
   */
  productsByNamePrefix(prefix) {
    const p = String(prefix ?? '').trim();
    if (p === '') return [];
    return this.db.prepare("SELECT * FROM products WHERE name LIKE ? ESCAPE '\\' ORDER BY stock_code").all(`${likeEscape(p)} %`).map(productOut);
  }

  listProducts({ q = '', limit = 100, offset = 0 } = {}) {
    const key = foldTr(q);
    const where = key === '' ? '' : "WHERE p.search_key LIKE ? ESCAPE '\\'";
    const args = key === '' ? [] : [`%${likeEscape(key)}%`];
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM products p ${where}`).get(...args).n);
    const items = this.db.prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM product_programs x WHERE x.code_key = p.code_key) AS program_count
         FROM products p ${where} ORDER BY p.stock_code COLLATE NOCASE LIMIT ? OFFSET ?`,
    ).all(...args, limit, offset).map(productOut);
    return { total, items };
  }

  /**
   * Urun ekler ya da gunceller (tum alanlar verilen `fields`'tan; verilmeyen alan DOKUNULMAZ).
   * @param {string} codeKey
   * @param {{stockCode?: string, name?: string|null, customerCode?: string|null, material?: string|null, altMaterial?: string|null,
   *          lengthMm?: number|null, netKg?: number|null, grossKg?: number|null, plannedSec?: number|null, note?: string|null}} fields
   * @param {{source: string, by?: string|null, edited?: boolean, now?: number}} meta
   */
  saveProduct(codeKey, fields, { source, by = null, edited, now = Date.now() }) {
    const cur = this.db.prepare('SELECT * FROM products WHERE code_key = ?').get(codeKey);
    const pick = (field, column) => (field in fields ? fields[field] : cur?.[column] ?? null);
    const next = {
      stock_code: fields.stockCode ?? cur?.stock_code ?? codeKey,
      name: pick('name', 'name'),
      customer_code: pick('customerCode', 'customer_code'),
      material: pick('material', 'material'),
      alt_material: pick('altMaterial', 'alt_material'),
      length_mm: pick('lengthMm', 'length_mm'),
      net_kg: pick('netKg', 'net_kg'),
      gross_kg: pick('grossKg', 'gross_kg'),
      planned_sec: pick('plannedSec', 'planned_sec'),
      note: pick('note', 'note'),
    };
    const searchKey = foldTr(`${next.stock_code} ${next.name ?? ''} ${next.customer_code ?? ''}`);
    const isEdited = edited ?? cur?.edited === 1;
    if (cur) {
      this.db.prepare(
        `UPDATE products SET stock_code=?, name=?, customer_code=?, material=?, alt_material=?, length_mm=?, net_kg=?, gross_kg=?,
                planned_sec=?, note=?, source=?, edited=?, search_key=?, updated_at=?, updated_by=? WHERE code_key=?`,
      ).run(next.stock_code, next.name, next.customer_code, next.material, next.alt_material, next.length_mm, next.net_kg, next.gross_kg,
        next.planned_sec, next.note, source, isEdited ? 1 : 0, searchKey, now, by, codeKey);
    } else {
      this.db.prepare(
        `INSERT INTO products (code_key, stock_code, name, customer_code, material, alt_material, length_mm, net_kg, gross_kg,
                planned_sec, note, source, edited, search_key, created_at, updated_at, updated_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(codeKey, next.stock_code, next.name, next.customer_code, next.material, next.alt_material, next.length_mm, next.net_kg,
        next.gross_kg, next.planned_sec, next.note, source, isEdited ? 1 : 0, searchKey, now, now, by);
    }
    return this.getProduct(codeKey);
  }

  /* ------------------------------------------------------ program eslemesi */

  getProgramMap() {
    const rows = this.db.prepare(
      `SELECT m.program_key, m.program_name, m.code_key, m.source, m.created_at, m.created_by, p.stock_code, p.name
         FROM product_programs m JOIN products p ON p.code_key = m.code_key`,
    ).all();
    return new Map(rows.map((r) => [r.program_key, {
      programKey: r.program_key, programName: r.program_name, codeKey: r.code_key, stockCode: r.stock_code,
      productName: r.name, source: r.source, createdAt: Number(r.created_at), createdBy: r.created_by,
    }]));
  }

  setProgramMap(programKey, programName, codeKey, { source, by = null, now = Date.now() }) {
    this.db.prepare(
      `INSERT INTO product_programs (program_key, program_name, code_key, source, created_at, created_by) VALUES (?,?,?,?,?,?)
       ON CONFLICT(program_key) DO UPDATE SET program_name=excluded.program_name, code_key=excluded.code_key,
         source=excluded.source, created_at=excluded.created_at, created_by=excluded.created_by`,
    ).run(programKey, programName, codeKey, source, now, by);
  }

  deleteProgramMap(programKey) {
    return Number(this.db.prepare('DELETE FROM product_programs WHERE program_key = ?').run(programKey).changes) > 0;
  }

  programsOfProduct(codeKey) {
    return this.db.prepare('SELECT program_name AS name, source FROM product_programs WHERE code_key = ? ORDER BY program_name')
      .all(codeKey).map((r) => ({ name: r.name, source: r.source }));
  }

  /* ------------------------------------------------------- durus nedenleri */

  /** @param {{code: string, name: string, group: string, kind: string, frequent?: boolean}[]} list listedeki sira = gosterim sirasi */
  syncDowntimeCodes(list) {
    this.tx(() => {
      this.db.prepare('UPDATE downtime_codes SET active = 0').run();
      const up = this.db.prepare(
        `INSERT INTO downtime_codes (code, name, grp, kind, frequent, sort, active) VALUES (?,?,?,?,?,?,1)
         ON CONFLICT(code) DO UPDATE SET name=excluded.name, grp=excluded.grp, kind=excluded.kind, frequent=excluded.frequent, sort=excluded.sort, active=1`,
      );
      list.forEach((c, i) => up.run(c.code, c.name, c.group, c.kind, c.frequent ? 1 : 0, i));
    });
  }

  listDowntimeCodes({ activeOnly = true } = {}) {
    return this.db.prepare(`SELECT * FROM downtime_codes ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY sort`).all()
      .map((r) => ({ code: r.code, name: r.name, group: r.grp, kind: r.kind, frequent: r.frequent === 1, active: r.active === 1 }));
  }

  insertDowntimeReason({ machineId, from, to, code, note = null, woNo = null, person = null, by = null, now }) {
    return Number(this.db.prepare(
      'INSERT INTO downtime_reasons (machine_id, from_ts, to_ts, code, note, wo_no, person, entered_by, entered_at) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(machineId, from, to, code, note, woNo, person, by, now).lastInsertRowid);
  }

  #reasonOut(r) {
    if (r == null) return null;
    return {
      id: Number(r.id), machineId: r.machine_id, from: Number(r.from_ts), to: Number(r.to_ts), code: r.code, name: r.name ?? null, note: r.note,
      woNo: r.wo_no, person: r.person, enteredBy: r.entered_by, enteredAt: Number(r.entered_at),
      deletedAt: r.deleted_at == null ? null : Number(r.deleted_at), deletedBy: r.deleted_by,
    };
  }

  getDowntimeReason(id) {
    return this.#reasonOut(this.db.prepare(
      'SELECT r.*, c.name FROM downtime_reasons r LEFT JOIN downtime_codes c ON c.code = r.code WHERE r.id = ?',
    ).get(id));
  }

  /** [fromMs, toMs] ile kesisen, silinmemis nedenler (zaman sirali). */
  downtimeReasonsFor(machineId, fromMs, toMs) {
    return this.db.prepare(
      `SELECT r.*, c.name FROM downtime_reasons r LEFT JOIN downtime_codes c ON c.code = r.code
        WHERE r.machine_id = ? AND r.deleted_at IS NULL AND r.to_ts > ? AND r.from_ts < ? ORDER BY r.from_ts`,
    ).all(machineId, fromMs, toMs).map((r) => this.#reasonOut(r));
  }

  deleteDowntimeReason(id, { by = null, now }) {
    return Number(this.db.prepare('UPDATE downtime_reasons SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL').run(now, by, id).changes) > 0;
  }

  /* ------------------------------------------------------------- kasalar (K) */

  /** Kart numarasi sirasi: en buyuk verilen sira ile (varsa) elle verilen taban (seq_floor, yil=0) arasindan sonrakisi. */
  nextCrateSeq() {
    const floor = Number(this.db.prepare('SELECT floor FROM seq_floor WHERE year = 0').get()?.floor ?? 0);
    const max = Number(this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM crates').get().m);
    return { floor, max, next: Math.max(floor, max) + 1 };
  }

  insertCrate({ seq, woNo, machineId, openedAt, openedBy = null, openedPerson = null, startTotal = null, note = null }) {
    return Number(this.db.prepare(
      'INSERT INTO crates (seq, wo_no, machine_id, opened_at, opened_by, opened_person, start_total, note) VALUES (?,?,?,?,?,?,?,?)',
    ).run(seq, woNo, machineId, openedAt, openedBy, openedPerson, startTotal, note).lastInsertRowid);
  }

  #crateOut(r) {
    if (r == null) return null;
    const n = (v) => (v == null ? null : Number(v));
    const state = r.voided_at != null ? 'iptal' : r.closed_at == null ? 'acik' : r.reject ? 'ret' : r.packed_qty == null ? 'kapali' : 'paketlendi';
    return {
      id: Number(r.id), seq: Number(r.seq), cardNo: `K${String(r.seq).padStart(6, '0')}`, state, woNo: r.wo_no, machineId: r.machine_id,
      openedAt: Number(r.opened_at), openedBy: r.opened_by, openedPerson: r.opened_person, startTotal: n(r.start_total),
      closedAt: n(r.closed_at), closedBy: r.closed_by, closedPerson: r.closed_person, endTotal: n(r.end_total), countedQty: n(r.counted_qty), approxQty: n(r.approx_qty),
      packedQty: n(r.packed_qty), packedAt: n(r.packed_at), packedBy: r.packed_by, packedPerson: r.packed_person, note: r.note,
      voidedAt: n(r.voided_at), voidedBy: r.voided_by, voidReason: r.void_reason,
      reject: !!r.reject,
      steps: { washTo: !!r.wash_to, washDone: !!r.wash_done, dryTo: !!r.dry_to, dryDone: !!r.dry_done, annealTo: !!r.anneal_to, annealDone: !!r.anneal_done },
      // kartta gorunen is emri bilgileri (is emrinin kopya degerleri)
      stockCode: r.stock_code ?? null, productName: r.product_name ?? null, customerCode: r.customer_code ?? null, gkkReportNo: r.gkk_report_no ?? null,
      targetQty: r.target_qty == null ? null : Number(r.target_qty),
    };
  }

  #crateSelect = `SELECT c.*, w.stock_code, w.product_name, w.customer_code, w.gkk_report_no, w.target_qty
                    FROM crates c LEFT JOIN work_orders w ON w.no = c.wo_no`;

  getCrate(id) {
    return this.#crateOut(this.db.prepare(`${this.#crateSelect} WHERE c.id = ?`).get(id));
  }

  /** Is emrinin ACIK (kapanmamis, iptal edilmemis) kasasi. */
  openCrateOfWo(woNo) {
    return this.#crateOut(this.db.prepare(`${this.#crateSelect} WHERE c.wo_no = ? AND c.closed_at IS NULL AND c.voided_at IS NULL`).get(woNo));
  }

  /** Iptal edilmemis kasalar (kart numarasi sirasiyla). */
  cratesOfWo(woNo) {
    return this.db.prepare(`${this.#crateSelect} WHERE c.wo_no = ? AND c.voided_at IS NULL ORDER BY c.seq`).all(woNo).map((r) => this.#crateOut(r));
  }

  /**
   * @param {{woNo?: string, machineId?: string, state?: string, limit?: number, offset?: number}} [f]
   *   state: 'acik' | 'kapali' (kapanmis, paketleme bekleyen; RET olanlar HARIC) | 'paketlendi' | 'ret' (kartta ret tikli, paketlemeye gitmez) | 'iptal' | 'aktif' (iptal haric, varsayilan) | 'tumu'
   */
  listCrates({ woNo = '', machineId = '', state = 'aktif', limit = 100, offset = 0 } = {}) {
    const conds = [];
    const args = [];
    if (woNo !== '') { conds.push('c.wo_no = ?'); args.push(woNo); }
    if (machineId !== '') { conds.push('c.machine_id = ?'); args.push(machineId); }
    if (state === 'acik') conds.push('c.closed_at IS NULL AND c.voided_at IS NULL');
    else if (state === 'kapali') conds.push('c.closed_at IS NOT NULL AND c.packed_qty IS NULL AND c.voided_at IS NULL AND c.reject = 0');
    else if (state === 'ret') conds.push('c.reject = 1 AND c.voided_at IS NULL');
    else if (state === 'paketlendi') conds.push('c.packed_qty IS NOT NULL AND c.voided_at IS NULL');
    else if (state === 'iptal') conds.push('c.voided_at IS NOT NULL');
    else if (state === 'aktif') conds.push('c.voided_at IS NULL');
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM crates c ${where}`).get(...args).n);
    const items = this.db.prepare(`${this.#crateSelect} ${where} ORDER BY c.seq DESC LIMIT ? OFFSET ?`).all(...args, limit, offset).map((r) => this.#crateOut(r));
    return { total, items };
  }

  updateCrate(id, cols) {
    const names = Object.keys(cols);
    if (names.length > 0) this.db.prepare(`UPDATE crates SET ${names.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...names.map((c) => cols[c]), id);
  }

  /* ----------------------------------------------------------- siparisler */

  beginBatch(kind, { filename = null, by = null, now = Date.now() } = {}) {
    return Number(this.db.prepare('INSERT INTO import_batches (kind, filename, at, imported_by) VALUES (?,?,?,?)')
      .run(kind, filename, now, by).lastInsertRowid);
  }

  finishBatch(id, { totalRows, added, updated, unchanged, skipped, warnings }) {
    this.db.prepare(
      'UPDATE import_batches SET total_rows=?, added=?, updated=?, unchanged=?, skipped=?, warnings=? WHERE id=?',
    ).run(totalRows, added, updated, unchanged, skipped, JSON.stringify(warnings ?? []), id);
  }

  lastBatches(limit = 5) {
    return this.db.prepare('SELECT * FROM import_batches ORDER BY id DESC LIMIT ?').all(limit).map((r) => ({
      id: Number(r.id), kind: r.kind, filename: r.filename, at: Number(r.at), by: r.imported_by,
      totalRows: r.total_rows, added: r.added, updated: r.updated, unchanged: r.unchanged, skipped: r.skipped,
      warnings: r.warnings ? JSON.parse(r.warnings) : [],
    }));
  }

  /**
   * Siparis satirini ekler / gunceller (line_key ile). @returns {'added'|'updated'|'unchanged'}
   */
  upsertLine(line, batchId) {
    const cur = this.db.prepare('SELECT * FROM order_lines WHERE line_key = ?').get(line.lineKey);
    const vals = [
      line.source, line.docNo, line.docKey, line.customer, line.customerKey, line.custOrderNo, line.custOrderKey,
      line.codeKey, line.stockCode, line.itemName, line.itemKey ?? '', line.orderDate, line.qty, line.shipped, line.remaining, line.dueDate, line.material,
    ];
    if (!cur) {
      this.db.prepare(
        `INSERT INTO order_lines (source, doc_no, doc_key, customer, customer_key, cust_order_no, cust_order_key, code_key, stock_code,
                item_name, item_key, order_date, qty, shipped, remaining, due_date, material, line_key, last_batch, stale)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
      ).run(...vals, line.lineKey, batchId);
      return 'added';
    }
    const same = cur.item_name === line.itemName && cur.qty === line.qty && cur.shipped === line.shipped && cur.remaining === line.remaining
      && cur.due_date === line.dueDate && cur.material === line.material && cur.customer === line.customer
      && cur.cust_order_no === line.custOrderNo && cur.stale === 0;
    this.db.prepare(
      `UPDATE order_lines SET source=?, doc_no=?, doc_key=?, customer=?, customer_key=?, cust_order_no=?, cust_order_key=?, code_key=?,
              stock_code=?, item_name=?, item_key=?, order_date=?, qty=?, shipped=?, remaining=?, due_date=?, material=?, last_batch=?, stale=0
        WHERE line_key=?`,
    ).run(...vals, batchId, line.lineKey);
    return same ? 'unchanged' : 'updated';
  }

  /** Son iceri almada gorunmeyen satirlari "eski" isaretler (silinmez: ileride is emirleri bunlara baglanacak). */
  markStale(source, batchId) {
    return Number(this.db.prepare('UPDATE order_lines SET stale = 1 WHERE source = ? AND last_batch < ? AND stale = 0').run(source, batchId).changes);
  }

  /**
   * Siparisleri (musteri siparis no + evrak no + musteri) gruplar. `q`: musteri siparis no, evrak no, musteri, urun kodu/adi icinde arar.
   */
  searchOrders({ q = '', openOnly = false, limit = 100 } = {}) {
    const key = foldTr(q);
    const loose = key.replace(/\s+/g, '');
    const conds = ['stale = 0'];
    const args = [];
    if (key !== '') {
      conds.push("(cust_order_key LIKE ? ESCAPE '\\' OR doc_key LIKE ? ESCAPE '\\' OR customer_key LIKE ? ESCAPE '\\' OR code_key LIKE ? ESCAPE '\\' OR item_key LIKE ? ESCAPE '\\')");
      const like = `%${likeEscape(loose)}%`;
      args.push(like, like, `%${likeEscape(key)}%`, like, `%${likeEscape(key)}%`);
    }
    const having = openOnly ? 'HAVING open_qty > 0' : '';
    // Tam eslesen (musteri siparis no ya da evrak no aynen) once: "SPR-4" araninca SPR-40, SPR-41 ... araya karismasin.
    const exact = key === '' ? '' : '(cust_order_key = ? OR doc_key = ?) DESC, ';
    const exactArgs = key === '' ? [] : [loose, loose];
    const rows = this.db.prepare(
      `SELECT MAX(customer) AS customer, MAX(cust_order_no) AS cust_order_no, MAX(doc_no) AS doc_no,
              customer_key, cust_order_key, doc_key,
              MIN(order_date) AS order_date, COUNT(*) AS line_count, SUM(COALESCE(qty,0)) AS qty,
              SUM(CASE WHEN remaining > 0 THEN remaining ELSE 0 END) AS open_qty
         FROM order_lines
        WHERE ${conds.join(' AND ')}
        GROUP BY customer_key, cust_order_key, doc_key ${having}
        ORDER BY ${exact}MAX(order_date) DESC, doc_key DESC LIMIT ?`,
    ).all(...args, ...exactArgs, limit);
    return rows.map((r) => ({
      customer: r.customer, custOrderNo: r.cust_order_no, docNo: r.doc_no,
      customerKey: r.customer_key, custOrderKey: r.cust_order_key, docKey: r.doc_key,
      orderDate: r.order_date == null ? null : Number(r.order_date), lineCount: Number(r.line_count),
      qty: Number(r.qty), openQty: Number(r.open_qty),
    }));
  }

  /**
   * Bir siparisin (grup anahtariyla) satirlari. `planned`: bu satira baglanmis (iptal edilmemis) is emirlerinin hedef adetleri toplami;
   * `unplanned`: kalan - planned (0'in altina inmez) = henuz is emrine baglanmamis adet.
   */
  orderLines({ customerKey, custOrderKey, docKey }) {
    return this.db.prepare(
      `SELECT l.*,
              (SELECT COALESCE(SUM(w.target_qty), 0) FROM work_orders w WHERE w.line_id = l.id AND w.status <> 'iptal') AS planned,
              EXISTS (SELECT 1 FROM products p WHERE p.code_key = l.code_key) AS has_product
         FROM order_lines l WHERE l.stale = 0 AND l.customer_key = ? AND l.cust_order_key = ? AND l.doc_key = ? ORDER BY l.id`,
    ).all(customerKey, custOrderKey, docKey).map((r) => this.#lineOut(r));
  }

  #lineOut(r) {
    const planned = Number(r.planned ?? 0);
    return {
      id: Number(r.id), docNo: r.doc_no, customer: r.customer, custOrderNo: r.cust_order_no, stockCode: r.stock_code, codeKey: r.code_key,
      itemName: r.item_name, orderDate: r.order_date == null ? null : Number(r.order_date), qty: r.qty, shipped: r.shipped,
      remaining: r.remaining, dueDate: r.due_date == null ? null : Number(r.due_date), material: r.material,
      hasProduct: Number(r.has_product) === 1, planned, unplanned: Math.max(0, (r.remaining ?? 0) - planned), stale: r.stale === 1,
    };
  }

  /** Tek siparis satiri (id ile); gizlenmis (eski) satir da doner, `stale` ile. */
  getLine(id) {
    const r = this.db.prepare(
      `SELECT l.*,
              (SELECT COALESCE(SUM(w.target_qty), 0) FROM work_orders w WHERE w.line_id = l.id AND w.status <> 'iptal') AS planned,
              EXISTS (SELECT 1 FROM products p WHERE p.code_key = l.code_key) AS has_product
         FROM order_lines l WHERE l.id = ?`,
    ).get(id);
    return r ? this.#lineOut(r) : null;
  }

  /* ------------------------------------------------------------ is emirleri */

  /** Numara tabanini yukseltir (asla dusurmez): Excel'deki en son is emri sirasi. */
  raiseSeqFloor(year, seq) {
    this.db.prepare(
      'INSERT INTO seq_floor (year, floor) VALUES (?, ?) ON CONFLICT(year) DO UPDATE SET floor = MAX(floor, excluded.floor)',
    ).run(year, seq);
  }

  /** @returns {{floor: number, max: number, next: number}} floor: Excel'den gelen taban, max: bu uygulamada verilen en buyuk sira */
  seqInfo(year) {
    const floor = Number(this.db.prepare('SELECT floor FROM seq_floor WHERE year = ?').get(year)?.floor ?? 0);
    const max = Number(this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM work_orders WHERE year = ?').get(year).m);
    return { floor, max, next: Math.max(floor, max) + 1 };
  }

  insertWorkOrder(w) {
    this.db.prepare(
      `INSERT INTO work_orders (no, year, seq, status, machine_id, code_key, stock_code, line_id, doc_no, cust_order_no, customer, target_qty, due_date,
              sample_qty, product_name, customer_code, material, alt_material, length_mm, net_kg, gross_kg, planned_sec, used_material, material_gk_no,
              gkk_report_no, first_approval_no, measured_net_kg, note, search_key, created_at, created_by, updated_at, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(w.no, w.year, w.seq, w.status ?? 'planlandi', w.machineId ?? '', w.codeKey, w.stockCode, w.lineId ?? null, w.docNo ?? '', w.custOrderNo ?? '',
      w.customer ?? '', w.targetQty, w.dueDate ?? null, w.sampleQty ?? null, w.productName ?? null, w.customerCode ?? null, w.material ?? null,
      w.altMaterial ?? null, w.lengthMm ?? null, w.netKg ?? null, w.grossKg ?? null, w.plannedSec ?? null, w.usedMaterial ?? null, w.materialGkNo ?? null,
      w.gkkReportNo ?? null, w.firstApprovalNo ?? null, w.measuredNetKg ?? null, w.note ?? null,
      foldTr(`${w.no} ${w.stockCode} ${w.productName ?? ''} ${w.custOrderNo ?? ''} ${w.docNo ?? ''} ${w.customer ?? ''}`),
      w.now, w.by ?? null, w.now, w.by ?? null);
  }

  #woOut(r) {
    if (r == null) return null;
    const n = (v) => (v == null ? null : Number(v));
    return {
      no: r.no, year: Number(r.year), seq: Number(r.seq), status: r.status, machineId: r.machine_id === '' ? null : r.machine_id, codeKey: r.code_key, stockCode: r.stock_code,
      lineId: n(r.line_id), docNo: r.doc_no, custOrderNo: r.cust_order_no, customer: r.customer, targetQty: Number(r.target_qty), dueDate: n(r.due_date),
      sampleQty: n(r.sample_qty), productName: r.product_name, customerCode: r.customer_code, material: r.material, altMaterial: r.alt_material,
      lengthMm: r.length_mm, netKg: r.net_kg, grossKg: r.gross_kg, plannedSec: r.planned_sec, usedMaterial: r.used_material,
      measurePlan: r.measure_plan ? JSON.parse(r.measure_plan) : [],
      gkkReportNo: r.gkk_report_no, firstApprovalNo: r.first_approval_no, measuredNetKg: r.measured_net_kg,
      note: r.note, cancelledAt: n(r.cancelled_at), cancelReason: r.cancel_reason,
      startedAt: n(r.started_at), startedBy: r.started_by, startedPerson: r.started_person, startTotal: n(r.start_total),
      finishedAt: n(r.finished_at), finishedBy: r.finished_by, finishedPerson: r.finished_person, finishTotal: n(r.finish_total),
      result: r.result_json ? JSON.parse(r.result_json) : null,
      fisAt: n(r.fis_at), fisBy: r.fis_by, fisDocNo: r.fis_doc_no, fisKg: r.fis_kg, fisNote: r.fis_note,
      createdAt: Number(r.created_at), createdBy: r.created_by, updatedAt: Number(r.updated_at), updatedBy: r.updated_by,
    };
  }

  getWorkOrder(no) {
    return this.#woOut(this.db.prepare('SELECT * FROM work_orders WHERE no = ?').get(no));
  }

  /**
   * @param {{q?: string, status?: string, machineId?: string, limit?: number, offset?: number}} [f]
   *   status: 'aktif' (planlandi + uretimde) | 'uretimde' | 'bitti' | 'planlandi' | 'iptal' | 'tumu'. Uretimde olanlar listede en uste gelir.
   */
  listWorkOrders({ q = '', status = 'aktif', machineId = '', limit = 100, offset = 0 } = {}) {
    const conds = [];
    const args = [];
    if (status === 'aktif') conds.push("status IN ('planlandi', 'uretimde')");
    else if (['planlandi', 'uretimde', 'bitti', 'iptal'].includes(status)) conds.push(`status = '${status}'`);
    if (machineId !== '') { conds.push('machine_id = ?'); args.push(machineId); }
    const key = foldTr(q);
    if (key !== '') {
      conds.push("search_key LIKE ? ESCAPE '\\'");
      args.push(`%${likeEscape(key)}%`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM work_orders ${where}`).get(...args).n);
    const items = this.db.prepare(`SELECT * FROM work_orders ${where} ORDER BY CASE status WHEN 'uretimde' THEN 0 ELSE 1 END, year DESC, seq DESC LIMIT ? OFFSET ?`).all(...args, limit, offset).map((r) => this.#woOut(r));
    return { total, items };
  }

  /** Verilen alanlari gunceller (yalniz bilinen sutunlar). @param {Record<string, unknown>} cols snake_case sutun -> deger */
  updateWorkOrder(no, colsIn, { by = null, now = Date.now() } = {}) {
    const cols = 'machine_id' in colsIn && colsIn.machine_id == null ? { ...colsIn, machine_id: '' } : colsIn; // tezgah atamasi kaldirilirsa ''
    const names = Object.keys(cols);
    if (names.length > 0) {
      this.db.prepare(`UPDATE work_orders SET ${names.map((c) => `${c} = ?`).join(', ')}, updated_at = ?, updated_by = ? WHERE no = ?`)
        .run(...names.map((c) => cols[c]), now, by, no);
    }
  }

  /** [fromMs, toMs] ile pencereleri KESISEN baslamis is emirleri (uretimde, biten, uretimdeyken iptal edilen); verimlilik raporu icin. */
  listOrdersOverlapping(fromMs, toMs, machineId = '') {
    return this.db.prepare(
      `SELECT * FROM work_orders WHERE started_at IS NOT NULL AND started_at < ? AND COALESCE(finished_at, 9223372036854775807) > ?
         AND status IN ('uretimde', 'bitti', 'iptal') ${machineId ? 'AND machine_id = ?' : ''} ORDER BY started_at, no`,
    ).all(...(machineId ? [toMs, fromMs, machineId] : [toMs, fromMs])).map((r) => this.#woOut(r));
  }

  /** [fromMs, toMs] ile kesisen, silinmemis durus nedenleri (tum tezgahlar ya da biri). */
  downtimeReasonsBetween(fromMs, toMs, machineId = '') {
    return this.db.prepare(
      `SELECT r.*, c.name FROM downtime_reasons r LEFT JOIN downtime_codes c ON c.code = r.code
        WHERE r.deleted_at IS NULL AND r.to_ts > ? AND r.from_ts < ? ${machineId ? 'AND r.machine_id = ?' : ''} ORDER BY r.machine_id, r.from_ts`,
    ).all(...(machineId ? [fromMs, toMs, machineId] : [fromMs, toMs])).map((r) => this.#reasonOut(r));
  }

  /** [fromMs, toMs) araliginda BITEN is emirleri (bitis zamanina gore). */
  listFinishedBetween(fromMs, toMs) {
    return this.db.prepare("SELECT * FROM work_orders WHERE status = 'bitti' AND finished_at >= ? AND finished_at < ? ORDER BY finished_at, no")
      .all(fromMs, toMs).map((r) => this.#woOut(r));
  }

  /**
   * Bir tezgahta baslatilmis (uretimde) ya da bitmis is emirlerinin zaman pencereleri: cakisma denetimi icin.
   * @returns {{no: string, status: string, startedAt: number, finishedAt: number|null}[]}
   */
  machineWindows(machineId, excludeNo = '') {
    return this.db.prepare(
      `SELECT no, status, started_at, finished_at FROM work_orders
        WHERE machine_id = ? AND status IN ('uretimde', 'bitti') AND started_at IS NOT NULL AND no <> ? ORDER BY started_at`,
    ).all(machineId, excludeNo).map((r) => ({ no: r.no, status: r.status, startedAt: Number(r.started_at), finishedAt: r.finished_at == null ? null : Number(r.finished_at) }));
  }

  addWorkOrderEvent(no, kind, detail, { by = null, now = Date.now() } = {}) {
    this.db.prepare('INSERT INTO work_order_events (wo_no, at, by, kind, detail) VALUES (?,?,?,?,?)').run(no, now, by, kind, detail ?? null);
  }

  workOrderEvents(no) {
    return this.db.prepare('SELECT at, by, kind, detail FROM work_order_events WHERE wo_no = ? ORDER BY id').all(no)
      .map((r) => ({ at: Number(r.at), by: r.by, kind: r.kind, detail: r.detail }));
  }

  stats() {
    const n = (sql) => Number(this.db.prepare(sql).get().n);
    return {
      products: n('SELECT COUNT(*) AS n FROM products'),
      mappedPrograms: n('SELECT COUNT(*) AS n FROM product_programs'),
      orderLines: n('SELECT COUNT(*) AS n FROM order_lines WHERE stale = 0'),
      openOrderLines: n('SELECT COUNT(*) AS n FROM order_lines WHERE stale = 0 AND remaining > 0'),
      orders: n('SELECT COUNT(*) AS n FROM (SELECT 1 FROM order_lines WHERE stale = 0 GROUP BY customer_key, cust_order_key, doc_key)'),
      workOrders: Object.fromEntries(['planlandi', 'uretimde', 'bitti', 'iptal'].map((st) => [st, n(`SELECT COUNT(*) AS n FROM work_orders WHERE status = '${st}'`)])),
    };
  }

  close() {
    this.db.close();
  }
}
