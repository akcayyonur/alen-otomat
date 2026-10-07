/**
 * Program kutuphanesi veritabani - AYRI dosya (data/library.db).
 *
 * Telemetri veritabanindan bilerek ayri: telemetri DB'si budanir (ornekler 7 gun)
 * ve gerektiginde sifirlanabilir; kutuphane (programlarin kendisi) ASLA budanmaz
 * ve ayri yedeklenir. `node:sqlite`, bagimlilik yok.
 *
 *   programs          kimlik = (musteri klasoru, ad); musteri '' = kok (musterisiz)
 *   program_versions  icerik BLOB + SHA-256; ayni icerik ikinci kez surum olmaz
 *   machine_programs  son taramada tezgahta GORULENLER (envanter)
 *   machine_scans     tezgah basina son tarama bilgisi
 *   transfers         gonderme denetim kaydi (kim, ne zaman, hangi tezgaha, sonuc)
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
  customer   TEXT    NOT NULL COLLATE NOCASE,
  name       TEXT    NOT NULL COLLATE NOCASE,
  note       TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (customer, name)
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

const programRow = (r) => ({ id: r.id, customer: r.customer, name: r.name, note: r.note, createdAt: r.created_at });

export class LibraryDb {
  /** @param {string} file ':memory:' testler icin */
  constructor(file) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL'); // programlar kritik: yazma kaybolmasin
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
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

  findProgram(customer, name) {
    const r = this.db.prepare('SELECT * FROM programs WHERE customer = ? AND name = ?').get(customer, name);
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
  addVersion({ customer, name, content, sha256, source, sourceMachine = null, originalName = null, note = null, createdBy = null }) {
    return this.#tx(() => {
      let program = this.findProgram(customer, name);
      const newProgram = program === null;
      if (newProgram) {
        const ins = this.db
          .prepare('INSERT INTO programs (customer, name, note, created_at) VALUES (?, ?, ?, ?)')
          .run(customer, name, note, Date.now());
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

  /** Liste: her programin en son surumuyle. `q` ad/musteri icinde arar. */
  listPrograms({ customer = null, q = '' } = {}) {
    const rows = this.db
      .prepare(
        `SELECT p.*, v.version_no, v.sha256, v.size, v.created_at AS v_created,
                (SELECT COUNT(*) FROM program_versions WHERE program_id = p.id) AS version_count
           FROM programs p
           JOIN program_versions v ON v.program_id = p.id
            AND v.version_no = (SELECT MAX(version_no) FROM program_versions WHERE program_id = p.id)
          ORDER BY p.customer, p.name`,
      )
      .all();
    const needle = q.trim().toLowerCase();
    return rows
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

  /** Tum surumlerin (program, surum, sha, boyut) ozeti: karsilastirma icin, icerik yok. */
  allVersionsIndex() {
    return this.db
      .prepare(
        `SELECT p.id AS program_id, p.customer, p.name, v.version_no, v.sha256, v.size
           FROM programs p JOIN program_versions v ON v.program_id = p.id`,
      )
      .all();
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

  /* ----------------------------------------------------------------- denetim kaydi */

  startTransfer(t) {
    const r = this.db
      .prepare(
        `INSERT INTO transfers (machine_id, program_id, version_id, customer, name, started_at, status, size, sha_sent, requested_by, client_ip, acks)
         VALUES (?, ?, ?, ?, ?, ?, 'basladi', ?, ?, ?, ?, ?)`,
      )
      .run(t.machineId, t.programId ?? null, t.versionId ?? null, t.customer ?? null, t.name ?? null, Date.now(), t.size ?? null, t.shaSent ?? null, t.requestedBy ?? null, t.clientIp ?? null, JSON.stringify(t.acks ?? []));
    return Number(r.lastInsertRowid);
  }

  finishTransfer(id, { status, shaVerified = null, error = null, steps = [] }) {
    this.db
      .prepare('UPDATE transfers SET finished_at = ?, status = ?, sha_verified = ?, error = ?, steps = ? WHERE id = ?')
      .run(Date.now(), status, shaVerified, error, JSON.stringify(steps), id);
  }

  #transferRow(r) {
    return {
      id: r.id, machineId: r.machine_id, programId: r.program_id, versionId: r.version_id,
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
    };
  }

  close() {
    this.db.close();
  }
}
