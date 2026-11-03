/**
 * Program kutuphanesi veritabani - AYRI dosya (data/library.db).
 *
 * Telemetri veritabanindan bilerek ayri: telemetri DB'si budanir (ornekler 7 gun)
 * ve gerektiginde sifirlanabilir; kutuphane (programlarin kendisi) ASLA budanmaz
 * ve ayri yedeklenir. `node:sqlite`, bagimlilik yok.
 *
 *   programs          kimlik = (kutuphane, musteri klasoru, ad); musteri '' = kok (musterisiz).
 *                      `library`: 'ortak' (varsayilan, ORTAK kutuphane) ya da bir tezgah kimligi (ör. 'CNC-03' -
 *                      o tezgahin KENDI kutuphanesi). Ayni (musteri, ad) FARKLI kutuphanelerde ayri ayri var olabilir.
 *   program_versions  icerik BLOB + SHA-256; ayni icerik ikinci kez surum olmaz
 *   machine_programs  son taramada tezgahta GORULENLER (envanter)
 *   machine_scans     tezgah basina son tarama bilgisi
 *   transfers         tezgaha YAZMA denetim kaydi (kim, ne zaman, hangi tezgaha, sonuc);
 *                     kind = 'gonderme' (program) | 'klasor' (yeni musteri klasoru) | 'silme' (tornadan silme) | 'toplu' (toplu gonderme: program basina bir kayit)
 *                     | 'yeniden-adlandirma' (kutuphanede ad degisince tornadaki dosyayi da RNFR/RNTO ile yeniden adlandirma; tezgah basina bir kayit)
 *   library_log       KUTUPHANEDEN silme VE yeniden adlandirma kaydi (kim, ne zaman, hangi program, eski/yeni ad)
 *   program_backups   TOPLU GONDERMEDE ezilen tornadaki eski haller (surum DEGIL: surum numaralarini ve "guncel surum" mantigini
 *                     bozmasin diye ayri tablo). Ayni (musteri, ad, SHA) bir kez saklanir.
 *
 * Ad karsilastirmalari buyuk/kucuk harfe DUYARSIZ (COLLATE NOCASE): tornanin
 * Windows CE dosya sistemi de oyle; "ornek" ile "ORNEK" ayni dosyadir.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS programs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  library    TEXT    NOT NULL DEFAULT 'ortak' COLLATE NOCASE,
  customer   TEXT    NOT NULL COLLATE NOCASE,
  name       TEXT    NOT NULL COLLATE NOCASE,
  note       TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (library, customer, name)
);

CREATE TABLE IF NOT EXISTS program_versions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id     INTEGER NOT NULL REFERENCES programs(id),
  version_no     INTEGER NOT NULL,
  content        BLOB    NOT NULL,
  sha256         TEXT    NOT NULL,
  size           INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  source         TEXT    NOT NULL,
  source_machine TEXT,
  original_name  TEXT,
  note           TEXT,
  created_by     TEXT,
  UNIQUE (program_id, version_no)
);
CREATE INDEX IF NOT EXISTS idx_versions_sha ON program_versions (sha256);

CREATE TABLE IF NOT EXISTS machine_scans (
  machine_id  TEXT PRIMARY KEY,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  status      TEXT    NOT NULL,
  entries     INTEGER,
  error       TEXT
);

-- Tezgahin kok dizinindeki klasorler (BOS olanlar dahil): yukleme/gonderme listeleri icin.
CREATE TABLE IF NOT EXISTS machine_folders (
  machine_id TEXT NOT NULL,
  name       TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (machine_id, name)
);

CREATE TABLE IF NOT EXISTS machine_programs (
  machine_id TEXT    NOT NULL,
  customer   TEXT    NOT NULL COLLATE NOCASE,
  name       TEXT    NOT NULL COLLATE NOCASE,
  size       INTEGER,
  modified   TEXT,
  seen_at    INTEGER NOT NULL,
  sha256     TEXT,
  PRIMARY KEY (machine_id, customer, name)
);

CREATE TABLE IF NOT EXISTS transfers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id   TEXT    NOT NULL,
  library      TEXT,
  program_id   INTEGER,
  version_id   INTEGER,
  customer     TEXT,
  name         TEXT,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  status       TEXT    NOT NULL,
  size         INTEGER,
  sha_sent     TEXT,
  sha_verified TEXT,
  requested_by TEXT,
  client_ip    TEXT,
  error        TEXT,
  steps        TEXT,
  acks         TEXT
);
CREATE INDEX IF NOT EXISTS idx_transfers_machine ON transfers (machine_id, started_at);

-- Kutuphaneden program silme kaydi: silinen icerik geri gelmez, ama kimin neyi ne zaman sildigi (ve silinen
-- surumlerin SHA-256'lari) kalir. Tezgahtaki dosyalara dokunulmaz.
-- Toplu gonderimde ezilen tornadaki eski haller: geri donus icin. Surum degil (program_versions'a girmez).
CREATE TABLE IF NOT EXISTS program_backups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  library     TEXT    NOT NULL DEFAULT 'ortak' COLLATE NOCASE,
  customer    TEXT    NOT NULL COLLATE NOCASE,
  name        TEXT    NOT NULL COLLATE NOCASE,
  machine_id  TEXT    NOT NULL,
  sha256      TEXT    NOT NULL,
  size        INTEGER NOT NULL,
  content     BLOB    NOT NULL,
  created_at  INTEGER NOT NULL,
  created_by  TEXT,
  transfer_id INTEGER,
  UNIQUE (library, customer, name, sha256)
);
-- idx_backups_name BURADA YOK (bkz. constructor): 'library' sutununu referans eder, eski (sutun henuz
-- eklenmemis) bir program_backups tablosunda CREATE TABLE IF NOT EXISTS sessizce atlanir ama bu INDEX
-- atlanmaz ve "no such column: library" ile PATLAR - sutun #migrate() tablo yeniden kurulumuyla
-- EKLENDIKTEN SONRA, ayri olarak kurulur.

CREATE TABLE IF NOT EXISTS library_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  action     TEXT    NOT NULL,
  program_id INTEGER,
  library    TEXT,
  customer   TEXT,
  name       TEXT,
  versions   INTEGER,
  detail     TEXT,
  by_user    TEXT,
  client_ip  TEXT
);
`;

function toBuffer(blob) {
  return blob == null ? null : Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
}

const versionMeta = (r) => ({
  id: r.id,
  programId: r.program_id,
  versionNo: r.version_no,
  sha256: r.sha256,
  size: r.size,
  createdAt: r.created_at,
  source: r.source,
  sourceMachine: r.source_machine,
  originalName: r.original_name,
  note: r.note,
  createdBy: r.created_by,
});

const programRow = (r) => ({ id: r.id, library: r.library, customer: r.customer, name: r.name, note: r.note, createdAt: r.created_at });

const backupMeta = (r) => ({
  id: r.id, library: r.library, customer: r.customer, name: r.name, machineId: r.machine_id, sha256: r.sha256, size: r.size,
  createdAt: r.created_at, createdBy: r.created_by, transferId: r.transfer_id,
});

export class LibraryDb {
  /** @param {string} file ':memory:' testler icin */
  constructor(file) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL'); // programlar kritik: yazma kaybolmasin
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.#migrate();
    // 'library' sutununu referans eder: SCHEMA'nin kendisinde degil, buraya - #migrate() (eski tabloyu
    // yeniden kurup sutunu ekleme) KESIN bittikten sonra kurulur (bkz. program_backups tablosundaki not).
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_backups_name ON program_backups (library, customer, name)');
  }

  /** Var olan (gercek) library.db'yi bozmadan eksik sutunlari ekler. */
  #migrate() {
    const cols = this.db.prepare('PRAGMA table_info(transfers)').all().map((c) => c.name);
    // kind: 'gonderme' (program gonderme) | 'klasor' (tezgahta yeni musteri klasoru acma)
    if (!cols.includes('kind')) this.db.exec("ALTER TABLE transfers ADD COLUMN kind TEXT NOT NULL DEFAULT 'gonderme'");
    if (!cols.includes('library')) this.db.exec('ALTER TABLE transfers ADD COLUMN library TEXT');

    const logCols = this.db.prepare('PRAGMA table_info(library_log)').all().map((c) => c.name);
    if (!logCols.includes('library')) this.db.exec('ALTER TABLE library_log ADD COLUMN library TEXT');

    // 'programs' DROP edilecekse program_versions.program_id -> programs(id) FK'si bunu reddeder (RENAME ile
    // ayni ID'ler geri geldigi icin islemin SONUNDA FK'ler yine saglam - auth-db.js'teki users gocuyle ayni desen).
    this.db.exec('PRAGMA foreign_keys = OFF');
    try {
      this.#migrateLibraryColumn('programs', 'UNIQUE (library, customer, name)');
      this.#migrateLibraryColumn('program_backups', 'UNIQUE (library, customer, name, sha256)');
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON');
    }
  }

  /**
   * Eski semada `library` sutunu yok (eski UNIQUE kisiti kutuphane bolunmesinden ONCE kuruldugu icin): SQLite
   * kisit degistiremedigi icin tablo AuthDb'deki `users_new` deseniyle yeniden kurulur - kayitlar (ve ID'leri,
   * baska tablolardan FK ile referans edildigi icin) korunur, hepsi `library='ortak'` olur (davranis degismez,
   * her sey eskisi gibi tek kutuphanede gorunmeye devam eder). Sutunu referans eden INDEX'ler burada DEGIL,
   * constructor'da #migrate()'den SONRA kurulur (bkz. oradaki not - erken kurulursa eski tabloda patlar).
   */
  #migrateLibraryColumn(table, uniqueClause) {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (cols.includes('library')) return; // zaten yeni sema
    if (cols.length === 0) return; // tablo henuz yok: SCHEMA zaten dogru kurar

    const createSql = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).sql;
    const newSql = createSql
      .replace(new RegExp(`^CREATE TABLE ${table}`, 'i'), `CREATE TABLE ${table}_new`)
      .replace(/,\s*UNIQUE\s*\([^)]*\)/i, '') // eski UNIQUE kisitini at, assagida yenisi eklenir
      .replace(/\)\s*$/, `, library TEXT NOT NULL DEFAULT 'ortak' COLLATE NOCASE, ${uniqueClause})`);

    this.db.exec('BEGIN');
    try {
      this.db.exec(newSql);
      this.db.exec(`INSERT INTO ${table}_new SELECT *, 'ortak' FROM ${table}`);
      this.db.exec(`DROP TABLE ${table}`);
      this.db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  #tx(fn) {
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

  /* ------------------------------------------------------------------ programlar */

  findProgram(library, customer, name) {
    const r = this.db.prepare('SELECT * FROM programs WHERE library = ? AND customer = ? AND name = ?').get(library, customer, name);
    return r ? programRow(r) : null;
  }

  getProgram(id) {
    const r = this.db.prepare('SELECT * FROM programs WHERE id = ?').get(id);
    return r ? programRow(r) : null;
  }

  latestVersion(programId) {
    const r = this.db
      .prepare('SELECT * FROM program_versions WHERE program_id = ? ORDER BY version_no DESC LIMIT 1')
      .get(programId);
    return r ? versionMeta(r) : null;
  }

  /**
   * Programa yeni surum ekler; program yoksa olusturur. Icerik en son surumle
   * AYNIYSA (SHA-256) yeni surum acilmaz.
   * @returns {{program: object, version: object, created: boolean, newProgram: boolean}}
   */
  addVersion({ library = 'ortak', customer, name, content, sha256, source, sourceMachine = null, originalName = null, note = null, createdBy = null }) {
    return this.#tx(() => {
      let program = this.findProgram(library, customer, name);
      const newProgram = program === null;
      if (newProgram) {
        const ins = this.db
          .prepare('INSERT INTO programs (library, customer, name, note, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(library, customer, name, note, Date.now());
        program = this.getProgram(Number(ins.lastInsertRowid));
      }
      const latest = this.latestVersion(program.id);
      if (latest && latest.sha256 === sha256) {
        return { program, version: latest, created: false, newProgram: false };
      }
      const versionNo = (latest?.versionNo ?? 0) + 1;
      const ins = this.db
        .prepare(
          `INSERT INTO program_versions
             (program_id, version_no, content, sha256, size, created_at, source, source_machine, original_name, note, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(program.id, versionNo, content, sha256, content.length, Date.now(), source, sourceMachine, originalName, note, createdBy);
      const row = this.db.prepare('SELECT * FROM program_versions WHERE id = ?').get(Number(ins.lastInsertRowid));
      return { program, version: versionMeta(row), created: true, newProgram };
    });
  }

  /**
   * Liste: her programin en son surumuyle. `library = null` -> TUM kutuphaneler (yalniz library.customers() gibi
   * genel amacli yerlerde; ekranlar her zaman belirli bir kutuphane ister). `q` ad/musteri icinde arar.
   */
  listPrograms({ library = 'ortak', customer = null, q = '' } = {}) {
    const rows = this.db
      .prepare(
        `SELECT p.*, v.version_no, v.sha256, v.size, v.created_at AS v_created,
                (SELECT COUNT(*) FROM program_versions WHERE program_id = p.id) AS version_count
           FROM programs p
           JOIN program_versions v ON v.program_id = p.id
            AND v.version_no = (SELECT MAX(version_no) FROM program_versions WHERE program_id = p.id)
          ORDER BY p.library, p.customer, p.name`,
      )
      .all();
    const needle = q.trim().toLowerCase();
    return rows
      .filter((r) => library === null || r.library.toLowerCase() === library.toLowerCase())
      .filter((r) => customer === null || r.customer.toLowerCase() === customer.toLowerCase())
      .filter((r) => needle === '' || r.name.toLowerCase().includes(needle) || r.customer.toLowerCase().includes(needle))
      .map((r) => ({
        ...programRow(r),
        latest: { versionNo: r.version_no, sha256: r.sha256, size: r.size, createdAt: r.v_created },
        versionCount: r.version_count,
      }));
  }

  listVersions(programId) {
    return this.db
      .prepare('SELECT * FROM program_versions WHERE program_id = ? ORDER BY version_no DESC')
      .all(programId)
      .map(versionMeta);
  }

  /** @returns {{meta: object, content: Buffer}|null} */
  getVersion(programId, versionNo) {
    const r = this.db
      .prepare('SELECT * FROM program_versions WHERE program_id = ? AND version_no = ?')
      .get(programId, versionNo);
    return r ? { meta: versionMeta(r), content: toBuffer(r.content) } : null;
  }

  /** Bir kutuphanenin tum surumlerinin (program, surum, sha, boyut) ozeti: karsilastirma icin, icerik yok. */
  allVersionsIndex(library = 'ortak') {
    return this.db
      .prepare(
        `SELECT p.id AS program_id, p.customer, p.name, v.version_no, v.sha256, v.size
           FROM programs p JOIN program_versions v ON v.program_id = p.id
          WHERE p.library = ?`,
      )
      .all(library);
  }

  /**
   * Programi YENIDEN ADLANDIRIR (ayni musteri klasorunde; klasor tasima yok). Surumler/icerik dokunulmaz.
   * Bu programin (henuz kutuphaneye geri alinmamis) toplu-gonderim yedekleri de yeni adla izlenebilsin diye
   * `program_backups` ayni kapsamda yeniden adlandirilir. `transfers` (gonderme gecmisi) ve `machine_programs`
   * (son taramadaki envanter) BILEREK dokunulmaz: biri o anki gercek gonderimin donmus kaydi, digeri tezgahtaki
   * fiziksel gercek - tezgahtaki dosya yeniden gonderilene kadar hala eski adla durur.
   * @returns {object} guncel program
   */
  renameProgram(id, newName, { by = null, clientIp = null } = {}) {
    return this.#tx(() => {
      const program = this.getProgram(id);
      const oldName = program.name;
      this.db.prepare('UPDATE programs SET name = ? WHERE id = ?').run(newName, id);
      this.db.prepare('UPDATE program_backups SET name = ? WHERE library = ? AND customer = ? AND name = ?').run(newName, program.library, program.customer, oldName);
      this.db
        .prepare(
          `INSERT INTO library_log (at, action, program_id, library, customer, name, versions, detail, by_user, client_ip)
           VALUES (?, 'program-yeniden-adlandirma', ?, ?, ?, ?, NULL, ?, ?, ?)`,
        )
        .run(Date.now(), id, program.library, program.customer, newName, JSON.stringify({ from: oldName, to: newName }), by, clientIp);
      return this.getProgram(id);
    });
  }

  /**
   * Programlari (tum surumleriyle) kutuphaneden siler ve her biri icin denetim kaydi yazar. Tek islemde: ya hepsi ya hicbiri.
   * Tezgahtaki dosyalara ve gonderme gecmisine dokunulmaz.
   * @returns {{id: number, customer: string, name: string, versions: number}[]}
   */
  deletePrograms(ids, { by = null, clientIp = null } = {}) {
    return this.#tx(() => {
      const out = [];
      const delVersions = this.db.prepare('DELETE FROM program_versions WHERE program_id = ?');
      const delProgram = this.db.prepare('DELETE FROM programs WHERE id = ?');
      const log = this.db.prepare(
        `INSERT INTO library_log (at, action, program_id, library, customer, name, versions, detail, by_user, client_ip)
         VALUES (?, 'program-silme', ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const id of ids) {
        const program = this.getProgram(id);
        if (!program) continue;
        const versions = this.listVersions(id);
        delVersions.run(id);
        delProgram.run(id);
        log.run(Date.now(), id, program.library, program.customer, program.name, versions.length,
          JSON.stringify(versions.map((v) => ({ versionNo: v.versionNo, sha256: v.sha256, size: v.size, createdAt: v.createdAt, source: v.source }))),
          by, clientIp);
        out.push({ id, customer: program.customer, name: program.name, versions: versions.length });
      }
      return out;
    });
  }

  /* ------------------------------------------------------------ toplu gonderim yedekleri */

  /**
   * Ezilen tornadaki eski hali saklar. Ayni (musteri, ad, SHA-256) ikinci kez saklanmaz (baska tornadan gelse bile).
   * @returns {{id: number, created: boolean}}
   */
  addBackup({ library = 'ortak', customer, name, machineId, content, sha256, createdBy = null, transferId = null }) {
    const found = this.db.prepare('SELECT id FROM program_backups WHERE library = ? AND customer = ? AND name = ? AND sha256 = ?').get(library, customer, name, sha256);
    if (found) return { id: Number(found.id), created: false };
    const ins = this.db
      .prepare('INSERT INTO program_backups (library, customer, name, machine_id, sha256, size, content, created_at, created_by, transfer_id) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(library, customer, name, machineId, sha256, content.length, content, Date.now(), createdBy, transferId);
    return { id: Number(ins.lastInsertRowid), created: true };
  }

  /** Bir programin yedekleri (en yeni uste), icerik yok. */
  listBackups(library, customer, name) {
    return this.db
      .prepare('SELECT id, library, customer, name, machine_id, sha256, size, created_at, created_by, transfer_id FROM program_backups WHERE library = ? AND customer = ? AND name = ? ORDER BY id DESC')
      .all(library, customer, name)
      .map(backupMeta);
  }

  /** @returns {{meta: object, content: Buffer}|null} */
  getBackup(id) {
    const r = this.db.prepare('SELECT * FROM program_backups WHERE id = ?').get(id);
    return r ? { meta: backupMeta(r), content: toBuffer(r.content) } : null;
  }

  /** Kutuphane denetim kaydi (en yeni uste). */
  listLog({ limit = 50 } = {}) {
    return this.db
      .prepare('SELECT * FROM library_log ORDER BY id DESC LIMIT ?')
      .all(limit)
      .map((r) => ({
        id: r.id, at: r.at, action: r.action, programId: r.program_id, library: r.library, customer: r.customer, name: r.name,
        versions: r.versions, by: r.by_user, clientIp: r.client_ip, detail: r.detail ? JSON.parse(r.detail) : [],
      }));
  }

  customers() {
    return this.db
      .prepare('SELECT DISTINCT customer FROM programs ORDER BY customer')
      .all()
      .map((r) => r.customer);
  }

  /* ---------------------------------------------------------------------- envanter */

  /**
   * Bir tezgahin taramasini yazar; eski envanterin YERINE gecer. Tarama basarisizsa
   * eski envanter korunur (bu fonksiyon yalnizca basarili taramada cagrilir).
   */
  replaceInventory(machineId, entries, { startedAt, finishedAt, folders = [] }) {
    this.#tx(() => {
      this.db.prepare('DELETE FROM machine_programs WHERE machine_id = ?').run(machineId);
      this.db.prepare('DELETE FROM machine_folders WHERE machine_id = ?').run(machineId);
      const insFolder = this.db.prepare('INSERT OR REPLACE INTO machine_folders (machine_id, name) VALUES (?, ?)');
      for (const name of folders) insFolder.run(machineId, name);
      const ins = this.db.prepare(
        'INSERT OR REPLACE INTO machine_programs (machine_id, customer, name, size, modified, seen_at, sha256) VALUES (?,?,?,?,?,?,?)',
      );
      for (const e of entries) ins.run(machineId, e.customer, e.name, e.size, e.modified ?? null, finishedAt, e.sha256 ?? null);
      this.db
        .prepare(
          `INSERT OR REPLACE INTO machine_scans (machine_id, started_at, finished_at, status, entries, error)
           VALUES (?, ?, ?, 'tamam', ?, NULL)`,
        )
        .run(machineId, startedAt, finishedAt, entries.length);
    });
  }

  /** Basarisiz tarama: envanter dokunulmaz, yalnizca hata kaydi guncellenir. */
  recordScanFailure(machineId, { startedAt, finishedAt, error }) {
    const prev = this.db.prepare('SELECT * FROM machine_scans WHERE machine_id = ?').get(machineId);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO machine_scans (machine_id, started_at, finished_at, status, entries, error)
         VALUES (?, ?, ?, 'hata', ?, ?)`,
      )
      .run(machineId, startedAt, finishedAt, prev?.entries ?? null, error);
  }

  setInventorySha(machineId, customer, name, sha256) {
    this.db
      .prepare('UPDATE machine_programs SET sha256 = ? WHERE machine_id = ? AND customer = ? AND name = ?')
      .run(sha256, machineId, customer, name);
  }

  /** Tornadan silme sonrasi: envanterden kaldir (dosya artik tezgahta yok). */
  removeInventory(machineId, customer, name) {
    this.db.prepare('DELETE FROM machine_programs WHERE machine_id = ? AND customer = ? AND name = ?').run(machineId, customer, name);
  }

  /** Bu adla kayitli dosyasi olan tezgahlar (son envantere gore): kutuphanede yeniden adlandirirken "nerede var" sorusu. */
  machinesWithEntry(customer, name) {
    return this.db
      .prepare('SELECT DISTINCT machine_id FROM machine_programs WHERE customer = ? AND name = ? ORDER BY machine_id')
      .all(customer, name)
      .map((r) => r.machine_id);
  }

  /**
   * Tezgahtaki envanter kaydini YENIDEN ADLANDIRIR (gercek FTP rename basariyla dogrulandiktan sonra cagrilir):
   * icerik/boyut/SHA aynen kalir, yalniz ad degisir; seen_at simdiye guncellenir (az once dogrulandi). Kayit
   * yoksa sessizce atlanir (envanter zaten baska bir sekilde guncellenmis olabilir).
   */
  renameInventoryEntry(machineId, customer, oldName, newName) {
    this.#tx(() => {
      const row = this.db.prepare('SELECT * FROM machine_programs WHERE machine_id = ? AND customer = ? AND name = ?').get(machineId, customer, oldName);
      if (!row) return;
      this.db.prepare('DELETE FROM machine_programs WHERE machine_id = ? AND customer = ? AND name = ?').run(machineId, customer, oldName);
      this.db
        .prepare(
          `INSERT OR REPLACE INTO machine_programs (machine_id, customer, name, size, modified, seen_at, sha256)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(machineId, customer, newName, row.size, row.modified, Date.now(), row.sha256);
    });
  }

  /** Gonderme sonrasi: tezgahta artik bu dosya var. */
  upsertInventory(machineId, { customer, name, size, sha256 }) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO machine_programs (machine_id, customer, name, size, modified, seen_at, sha256)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(machineId, customer, name, size, Date.now(), sha256);
  }

  getScan(machineId) {
    const r = this.db.prepare('SELECT * FROM machine_scans WHERE machine_id = ?').get(machineId);
    return r
      ? { machineId: r.machine_id, startedAt: r.started_at, finishedAt: r.finished_at, status: r.status, entries: r.entries, error: r.error }
      : null;
  }

  getInventory(machineId) {
    return this.db
      .prepare('SELECT * FROM machine_programs WHERE machine_id = ? ORDER BY customer, name')
      .all(machineId)
      .map((r) => ({ customer: r.customer, name: r.name, size: r.size, modified: r.modified, seenAt: r.seen_at, sha256: r.sha256 }));
  }

  allScans() {
    return this.db.prepare('SELECT * FROM machine_scans').all().map((r) => ({
      machineId: r.machine_id, startedAt: r.started_at, finishedAt: r.finished_at, status: r.status, entries: r.entries, error: r.error,
    }));
  }

  /** Tezgahlarda gorulen musteri klasorleri: bos klasorler dahil (yukleme/gonderme listeleri icin). */
  inventoryCustomers() {
    return this.db
      .prepare(
        `SELECT name FROM machine_folders
         UNION SELECT customer FROM machine_programs WHERE customer <> ''
         ORDER BY 1`,
      )
      .all()
      .map((r) => r.name);
  }

  /** Bir tezgahin kok klasorleri (son taramadan). */
  getFolders(machineId) {
    return this.db
      .prepare('SELECT name FROM machine_folders WHERE machine_id = ? ORDER BY name')
      .all(machineId)
      .map((r) => r.name);
  }

  /** Tezgahta yeni acilan klasoru bilinen klasorlere ekler (yeniden taramaya gerek kalmasin). */
  addFolder(machineId, name) {
    this.db.prepare('INSERT OR IGNORE INTO machine_folders (machine_id, name) VALUES (?, ?)').run(machineId, name);
  }

  /* ----------------------------------------------------------------- denetim kaydi */

  startTransfer(t) {
    const r = this.db
      .prepare(
        `INSERT INTO transfers (kind, machine_id, library, program_id, version_id, customer, name, started_at, status, size, sha_sent, requested_by, client_ip, acks)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'basladi', ?, ?, ?, ?, ?)`,
      )
      .run(t.kind ?? 'gonderme', t.machineId, t.library ?? null, t.programId ?? null, t.versionId ?? null, t.customer ?? null, t.name ?? null, Date.now(), t.size ?? null, t.shaSent ?? null, t.requestedBy ?? null, t.clientIp ?? null, JSON.stringify(t.acks ?? []));
    return Number(r.lastInsertRowid);
  }

  finishTransfer(id, { status, shaVerified = null, error = null, steps = [] }) {
    this.db
      .prepare('UPDATE transfers SET finished_at = ?, status = ?, sha_verified = ?, error = ?, steps = ? WHERE id = ?')
      .run(Date.now(), status, shaVerified, error, JSON.stringify(steps), id);
  }

  #transferRow(r) {
    return {
      id: r.id, kind: r.kind, machineId: r.machine_id, library: r.library, programId: r.program_id, versionId: r.version_id,
      customer: r.customer, name: r.name, startedAt: r.started_at, finishedAt: r.finished_at,
      status: r.status, size: r.size, shaSent: r.sha_sent, shaVerified: r.sha_verified,
      requestedBy: r.requested_by, clientIp: r.client_ip, error: r.error,
      steps: r.steps ? JSON.parse(r.steps) : [], acks: r.acks ? JSON.parse(r.acks) : [],
    };
  }

  getTransfer(id) {
    const r = this.db.prepare('SELECT * FROM transfers WHERE id = ?').get(id);
    return r ? this.#transferRow(r) : null;
  }

  listTransfers({ machineId = null, limit = 50 } = {}) {
    const rows = machineId
      ? this.db.prepare('SELECT * FROM transfers WHERE machine_id = ? ORDER BY id DESC LIMIT ?').all(machineId, limit)
      : this.db.prepare('SELECT * FROM transfers ORDER BY id DESC LIMIT ?').all(limit);
    return rows.map((r) => this.#transferRow(r));
  }

  stats() {
    const n = (sql) => this.db.prepare(sql).get().n;
    return {
      programs: n('SELECT COUNT(*) AS n FROM programs'),
      versions: n('SELECT COUNT(*) AS n FROM program_versions'),
      transfers: n('SELECT COUNT(*) AS n FROM transfers'),
      backups: n('SELECT COUNT(*) AS n FROM program_backups'),
    };
  }

  close() {
    this.db.close();
  }
}
