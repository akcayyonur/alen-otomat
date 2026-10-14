/**
 * Kalici depolama - Node'un gomulu `node:sqlite` modulu. Dis bagimlilik yok.
 *
 * Bolum 10 zaman serisi veritabani (TimescaleDB/InfluxDB) ongoruyordu; tek
 * ofis PC'sinde calisan bir kurulum icin SQLite yeterli ve kurulum gerektirmez.
 * Olcek buyurse sorgular ayni kalacak sekilde tasinabilir.
 *
 * Iki tablo, iki ayri is:
 *
 *   samples - detayli grafik verisi. Her ornegi yazmak gereksiz buyuk (7 tezgah
 *             x 1 Hz = gunde 600 bin satir), bu yuzden "degisimde ya da N
 *             saniyede bir" yazilir. Kisa saklama suresi.
 *
 *   spans   - durum araliklari; her durum degisiminde bir satir. Cok kucuk,
 *             uzun saklanir ve raporlari (calisma orani, durus listesi) satir
 *             sayisindan bagimsiz olarak aninda verir.
 *
 * NO_DATA araliklari da spans'e yazilir. "Ornek gelmedi" ile "tezgah kapali"
 * ayri seylerdir; ayni kovaya atilirsa durus raporu yanlis cikar.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { TimelineState } from '../shared/schema.js';
import { PartTracker, programOf } from './production.js';
import { ProgramRunTracker } from './program-runs.js';

/** Bu sureden uzun sessizlik veri boslugu sayilir. */
export const GAP_THRESHOLD_MS = 10_000;

/** Ornekler en az bu araliklarla yazilir (degisim varsa her zaman yazilir). */
const SAMPLE_MIN_INTERVAL_MS = 5_000;

/** Tampon bu aralikla tek islemde bosaltilir. */
const FLUSH_MS = 2_000;

const SAMPLE_RETENTION_DAYS = 7;
const SPAN_RETENTION_DAYS = 400;
const PRODUCTION_RETENTION_DAYS = 400;

const PRODUCTION_COLUMNS = 'machine_id, ts, program, qty, part_total, part_count, status, cycle_sec, gap_ms, suspect';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS samples (
  machine_id      TEXT    NOT NULL,
  ts              INTEGER NOT NULL,
  status          TEXT    NOT NULL,
  source          TEXT,
  spindle_rpm     REAL,
  feed_rate       REAL,
  spindle_ov      REAL,
  feed_ov         REAL,
  part_count      INTEGER,
  part_target     INTEGER,
  part_total      INTEGER,
  cycle_time      REAL,
  cutting_time    REAL,
  power_on_time   REAL,
  work_time       REAL,
  block_no        INTEGER,
  program         TEXT,
  main_program    TEXT,
  mode            TEXT,
  block           TEXT,
  alarms          TEXT,
  downtime_reason TEXT,
  controller      TEXT
);
CREATE INDEX IF NOT EXISTS idx_samples_machine_ts ON samples (machine_id, ts);

CREATE TABLE IF NOT EXISTS spans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id  TEXT    NOT NULL,
  state       TEXT    NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  reason      TEXT
);
CREATE INDEX IF NOT EXISTS idx_spans_machine_start ON spans (machine_id, started_at);

-- Uretim olaylari: parca sayaci her artisinda bir satir (backend/production.js). Ornekler 7 gunde silinir,
-- vardiya/urun raporlari aylarca geriye baktigi icin bunlar ayri ve uzun saklanir.
CREATE TABLE IF NOT EXISTS production (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id TEXT    NOT NULL,
  ts         INTEGER NOT NULL,
  program    TEXT,
  qty        INTEGER NOT NULL,
  part_total INTEGER,
  part_count INTEGER,
  status     TEXT,
  cycle_sec  REAL,
  gap_ms     INTEGER NOT NULL DEFAULT 0,
  suspect    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_production_machine_ts ON production (machine_id, ts);
CREATE INDEX IF NOT EXISTS idx_production_ts ON production (ts);

-- Program calisma araliklari: hangi program hangi saatte devreye girdi, ne zaman bitti (backend/program-runs.js).
-- ended_at NULL = su an suruyor. Ornekler 7 gunde silinir; bunlar 400 gun saklanir.
CREATE TABLE IF NOT EXISTS program_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id TEXT    NOT NULL,
  program    TEXT    NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_program_runs_machine_start ON program_runs (machine_id, started_at);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

const SAMPLE_COLUMNS = Object.freeze([
  ['machine_id', (m) => m.machineId],
  ['ts', (m) => Date.parse(m.ts)],
  ['status', (m) => m.status],
  ['source', (m) => m.source],
  ['spindle_rpm', (m) => m.spindleRpm],
  ['feed_rate', (m) => m.feedRate],
  ['spindle_ov', (m) => m.spindleOverridePct],
  ['feed_ov', (m) => m.feedOverridePct],
  ['part_count', (m) => m.partCount],
  ['part_target', (m) => m.partTarget],
  ['part_total', (m) => m.partTotal],
  ['cycle_time', (m) => m.cycleTimeSec],
  ['cutting_time', (m) => m.cuttingTimeSec],
  ['power_on_time', (m) => m.powerOnTimeSec],
  ['work_time', (m) => m.workTimeSec],
  ['block_no', (m) => m.blockNo],
  ['program', (m) => m.program],
  ['main_program', (m) => m.mainProgram],
  ['mode', (m) => m.mode],
  ['block', (m) => m.block],
  ['alarms', (m) => (m.alarms?.length ? JSON.stringify(m.alarms) : null)],
  ['downtime_reason', (m) => m.downtimeReason],
  ['controller', (m) => (Object.keys(m.controller ?? {}).length ? JSON.stringify(m.controller) : null)],
]);

/** SQLite yalnizca null/sayi/metin/blob baglar; undefined ve boolean gelmesin. */
function bindable(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return value;
}

export class TelemetryDb {
  /** @param {string} file veritabani dosyasi; ':memory:' testler icin */
  constructor(file) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);

    const names = SAMPLE_COLUMNS.map(([name]) => name);
    this.insertSample = this.db.prepare(
      `INSERT INTO samples (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`,
    );
    this.openSpan = this.db.prepare(
      'INSERT INTO spans (machine_id, state, started_at, reason) VALUES (?, ?, ?, ?)',
    );
    this.closeSpanStmt = this.db.prepare('UPDATE spans SET ended_at = ? WHERE id = ?');
    this.insertProduction = this.db.prepare(
      `INSERT INTO production (${PRODUCTION_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    this.insertRun = this.db.prepare('INSERT INTO program_runs (machine_id, program, started_at) VALUES (?, ?, ?)');
    this.closeRunStmt = this.db.prepare('UPDATE program_runs SET ended_at = ? WHERE id = ?');
    this.reopenRunStmt = this.db.prepare('UPDATE program_runs SET ended_at = NULL WHERE id = ?');

    /** @type {object[]} yazilmayi bekleyen ornekler */
    this.pending = [];
    /** @type {Map<string, number>} tezgah -> en son yazilan ornegin zamani */
    this.lastWrittenAt = new Map();

    this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);
    this.flushTimer.unref?.();

    this.pruneOld();
    try {
      this.backfillProduction();
    } catch (err) {
      // Gecmisi doldurmak bir kolaylik: basarisizsa sunucu yine acilir, bir sonraki acilista yeniden denenir.
      console.error('[db] uretim gecmisi orneklerden doldurulamadi:', err.message);
    }
    try {
      this.backfillProgramRuns();
      this.closeStaleProgramRuns();
    } catch (err) {
      console.error('[db] program araliklari hazirlanamadi:', err.message);
    }
  }

  /* ----------------------------------------------------- program calisma araliklari */

  /** ProgramRunTracker'in yazma arayuzu. */
  get runSink() {
    return {
      open: (machineId, program, startedAt) => Number(this.insertRun.run(machineId, program, startedAt).lastInsertRowid),
      close: (id, endedAt) => { this.closeRunStmt.run(endedAt, id); },
      reopen: (id) => { this.reopenRunStmt.run(id); },
    };
  }

  /** Tezgahin en son kayitli araligi (yeniden baslamada devam mi yeni mi karari icin). */
  lastProgramRun(machineId) {
    const r = this.db
      .prepare('SELECT id, program, started_at, ended_at FROM program_runs WHERE machine_id = ? ORDER BY started_at DESC, id DESC LIMIT 1')
      .get(machineId);
    return r ? { id: Number(r.id), program: r.program, startedAt: Number(r.started_at), endedAt: r.ended_at == null ? null : Number(r.ended_at) } : null;
  }

  /**
   * Sunucu kapaniken acik kalmis araliklari tezgahin SON KAYITLI ornegiyle bitirir (ani kapanista bile bitis
   * yeniden baslama ani degil, tezgahin son bilinen ani olur).
   * @returns {number} kapatilan aralik sayisi
   */
  closeStaleProgramRuns() {
    const open = this.db.prepare('SELECT id, machine_id, started_at FROM program_runs WHERE ended_at IS NULL').all();
    const last = this.db.prepare('SELECT MAX(ts) AS ts FROM samples WHERE machine_id = ?');
    for (const r of open) {
      const ts = last.get(r.machine_id).ts;
      const startedAt = Number(r.started_at);
      this.closeRunStmt.run(ts == null ? startedAt : Math.max(startedAt, Number(ts)), r.id);
    }
    return open.length;
  }

  /**
   * Ilk acilista (tablo eklenmeden onceki) ornekleri tarar ve program araliklarini cikarir; boylece guncellemeden
   * hemen sonra "bugun hangi programlar calisti" bos gorunmez. Bir kez calisir (`meta`).
   * @returns {number} eklenen aralik sayisi
   */
  backfillProgramRuns() {
    if (this.db.prepare("SELECT 1 AS x FROM meta WHERE key = 'program_runs_backfill'").get()) return 0;
    const machines = this.db.prepare('SELECT DISTINCT machine_id AS id FROM samples').all();
    const rowsOf = this.db.prepare('SELECT ts, program, main_program FROM samples WHERE machine_id = ? ORDER BY ts');
    let inserted = 0;
    this.db.exec('BEGIN');
    try {
      for (const { id } of machines) {
        const tracker = new ProgramRunTracker({
          open: (m, program, startedAt) => { inserted += 1; return this.runSink.open(m, program, startedAt); },
          close: (rid, endedAt) => this.runSink.close(rid, endedAt),
        });
        for (const r of rowsOf.all(id)) tracker.observe(id, Number(r.ts), programOf({ mainProgram: r.main_program, program: r.program }));
        tracker.closeAll();
      }
      this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('program_runs_backfill', ?)").run(String(Date.now()));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return inserted;
  }

  /**
   * [fromMs, toMs) ile kesisen program araliklari (zaman sirasiyla). Her aralik icin `qty`: aralikla pencerenin
   * KESISIMINDE o programdan uretilen adet (supheli sayac sicramalari haric); `approxQty`: veri kopuklugundan sonra
   * sayilan kismi. Acik aralik (`endedAt` null) `now`'a kadar sayilir.
   * @returns {{id: number, machineId: string, program: string, startedAt: number, endedAt: number|null, qty: number, approxQty: number}[]}
   */
  programRuns(machineId, fromMs, toMs, now = Date.now()) {
    const runs = this.db
      .prepare(
        `SELECT id, machine_id, program, started_at, ended_at FROM program_runs
          WHERE started_at < ? AND (ended_at IS NULL OR ended_at > ?) ${machineId ? 'AND machine_id = ?' : ''}
          ORDER BY started_at, machine_id, id`,
      )
      .all(...(machineId ? [toMs, fromMs, machineId] : [toMs, fromMs]));
    const qtyOf = this.db.prepare(
      `SELECT COALESCE(SUM(qty), 0) AS qty, COALESCE(SUM(CASE WHEN gap_ms > 0 THEN qty ELSE 0 END), 0) AS approx
         FROM production WHERE machine_id = ? AND program = ? AND ts >= ? AND ts < ? AND suspect = 0`,
    );
    return runs.map((r) => {
      const startedAt = Number(r.started_at);
      const endedAt = r.ended_at == null ? null : Number(r.ended_at);
      // Bitis anindaki parca eski programindir (program sonra secilir): kapali aralikta bitis DAHIL sayilir.
      const hi = Math.min((endedAt ?? now) + 1, toMs);
      const q = qtyOf.get(r.machine_id, r.program, Math.max(startedAt, fromMs), hi);
      return { id: Number(r.id), machineId: r.machine_id, program: r.program, startedAt, endedAt, qty: Number(q.qty), approxQty: Number(q.approx) };
    });
  }

  /**
   * Uretim olayini yazar (parca sayaci artti). Nadir (tezgah basina ~25 sn'de bir) oldugu icin
   * tamponlanmaz: anlik yazilir, sunucu cokse bile kaybolmaz.
   * @param {import('./production.js').ProductionEvent} ev
   */
  recordProduction(ev) {
    this.insertProduction.run(
      ev.machineId, ev.ts, bindable(ev.program), ev.qty, bindable(ev.partTotal), bindable(ev.partCount),
      bindable(ev.status), bindable(ev.cycleSec), ev.gapMs ?? 0, ev.suspect ? 1 : 0,
    );
  }

  /**
   * Sunucu yeniden basladiginda uretim izleyicisinin tabani: tezgahin son kayitli ornegi.
   * (Ornekler seyreltilir; en gec ~5 sn eski olabilir, aradaki artis ilk mesajda yakalanir.)
   */
  lastCounters(machineId) {
    const r = this.db
      .prepare(
        `SELECT ts, part_total, part_count, program, main_program FROM samples
          WHERE machine_id = ? ORDER BY ts DESC LIMIT 1`,
      )
      .get(machineId);
    if (!r) return null;
    return {
      ts: Number(r.ts),
      total: r.part_total,
      count: r.part_count,
      program: programOf({ mainProgram: r.main_program, program: r.program }),
    };
  }

  /**
   * Ilk acilista (uretim tablosu ozelligi eklenmeden onceki) ornekleri tarar ve uretim olaylarini cikarir;
   * boylece guncellemeden hemen sonra "bu vardiya" bos gorunmez. Bir kez calisir (`meta`).
   * Ornekler seyreltilmis oldugu icin bu olaylarin cevrim suresi yoktur (`cycle_sec` NULL): tahmin yazilmaz.
   * @returns {number} eklenen olay sayisi
   */
  backfillProduction() {
    if (this.db.prepare("SELECT 1 AS x FROM meta WHERE key = 'production_backfill'").get()) return 0;
    const machines = this.db.prepare('SELECT DISTINCT machine_id AS id FROM samples').all();
    const rowsOf = this.db.prepare(
      `SELECT ts, status, part_total, part_count, program, main_program
         FROM samples WHERE machine_id = ? ORDER BY ts`,
    );
    let inserted = 0;
    this.db.exec('BEGIN');
    try {
      for (const { id } of machines) {
        const tracker = new PartTracker({ gapMs: GAP_THRESHOLD_MS });
        for (const r of rowsOf.all(id)) {
          const ev = tracker.observe({
            machineId: id,
            ts: new Date(Number(r.ts)).toISOString(),
            status: r.status,
            partTotal: r.part_total,
            partCount: r.part_count,
            program: r.program,
            mainProgram: r.main_program,
            cycleTimeSec: null,
          });
          if (ev) { this.recordProduction(ev); inserted += 1; }
        }
      }
      this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('production_backfill', ?)").run(String(Date.now()));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return inserted;
  }

  /**
   * [fromMs, toMs) araligindaki uretim: tezgah x program toplamlari. Supheli (elle ayarlanmis sayac) olaylar
   * hariç. `approxQty`: veri kopuklugundan sonra sayilan (zamani kesin olmayan) adet.
   * Cevrim suresi yalniz `cycle_sec` bilinen olaylardan (cycleN) hesaplanir.
   */
  productionWindow(fromMs, toMs, machineId = null) {
    const rows = this.db
      .prepare(
        `SELECT machine_id AS machineId, program,
                SUM(qty) AS qty,
                SUM(CASE WHEN gap_ms > 0 THEN qty ELSE 0 END) AS approxQty,
                COUNT(cycle_sec) AS cycleN, SUM(cycle_sec) AS cycleSum,
                MIN(cycle_sec) AS cycleMin, MAX(cycle_sec) AS cycleMax
           FROM production
          WHERE ts >= ? AND ts < ? AND suspect = 0 ${machineId ? 'AND machine_id = ?' : ''}
          GROUP BY machine_id, program
          ORDER BY machine_id, program`,
      )
      .all(...(machineId ? [fromMs, toMs, machineId] : [fromMs, toMs]));
    return rows.map((r) => ({
      machineId: r.machineId,
      program: r.program ?? null,
      qty: Number(r.qty),
      approxQty: Number(r.approxQty),
      cycleN: Number(r.cycleN),
      cycleSum: r.cycleSum == null ? 0 : Number(r.cycleSum),
      cycleMin: r.cycleMin == null ? null : Number(r.cycleMin),
      cycleMax: r.cycleMax == null ? null : Number(r.cycleMax),
    }));
  }

  /** Sayilmayan (supheli) olaylar: [fromMs, toMs) icinde kac olay, toplam kac adet. */
  productionSuspect(fromMs, toMs, machineId = null) {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(qty), 0) AS qty FROM production
          WHERE ts >= ? AND ts < ? AND suspect = 1 ${machineId ? 'AND machine_id = ?' : ''}`,
      )
      .get(...(machineId ? [fromMs, toMs, machineId] : [fromMs, toMs]));
    return { events: Number(r.n), qty: Number(r.qty) };
  }

  /**
   * Uretim olaylarinda gorulen program adlari (planlama modulu: program <-> urun eslemesi icin). Supheli olaylar sayilmaz.
   * @returns {{program: string, parts: number, machines: string[], lastTs: number}[]}
   */
  productionPrograms() {
    return this.db
      .prepare(
        `SELECT program, SUM(qty) AS parts, GROUP_CONCAT(DISTINCT machine_id) AS machines, MAX(ts) AS last_ts
           FROM production WHERE program IS NOT NULL AND program <> '' AND suspect = 0
          GROUP BY program ORDER BY parts DESC`,
      )
      .all()
      .map((r) => ({
        program: r.program, parts: Number(r.parts), machines: r.machines ? String(r.machines).split(',') : [], lastTs: Number(r.last_ts),
      }));
  }

  /** Ham uretim olaylari (CSV icin), zaman sirasiyla. */
  productionEvents(machineId, fromMs, toMs) {
    return this.db
      .prepare(
        `SELECT ts, program, qty, part_total AS partTotal, part_count AS partCount, status,
                cycle_sec AS cycleSec, gap_ms AS gapMs, suspect
           FROM production WHERE machine_id = ? AND ts >= ? AND ts <= ? ORDER BY ts, id`,
      )
      .all(machineId, fromMs, toMs)
      .map((r) => ({ ...r, ts: Number(r.ts), qty: Number(r.qty), gapMs: Number(r.gapMs), suspect: r.suspect === 1 }));
  }

  /**
   * Ornegi yazma kuyruguna alir. Her ornek yazilmaz: degisim yoksa
   * SAMPLE_MIN_INTERVAL_MS'den once gelen ornek atlanir. Durum degisimi,
   * alarm ve parca sayaci artisi her zaman yazilir - bunlar kaybedilemez.
   */
  recordSample(msg, { force = false } = {}) {
    const ts = Date.parse(msg.ts);
    if (!Number.isFinite(ts)) return;

    const last = this.lastWrittenAt.get(msg.machineId);
    if (!force && last !== undefined && ts - last < SAMPLE_MIN_INTERVAL_MS) return;

    this.lastWrittenAt.set(msg.machineId, ts);
    this.pending.push(msg);
    if (this.pending.length >= 500) this.flush();
  }

  flush() {
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];

    this.db.exec('BEGIN');
    try {
      for (const msg of batch) {
        this.insertSample.run(...SAMPLE_COLUMNS.map(([, read]) => bindable(read(msg))));
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Yeni bir durum araligi acar, id dondurur. */
  beginSpan(machineId, state, startedAt, reason = null) {
    const info = this.openSpan.run(machineId, state, startedAt, bindable(reason));
    return Number(info.lastInsertRowid);
  }

  closeSpan(spanId, endedAt) {
    if (spanId == null) return;
    this.closeSpanStmt.run(endedAt, spanId);
  }

  /**
   * Sunucu yeniden baslarken zaman cizelgesini toparlar: sunucu (ve onunla ayni
   * PC'deki ajan) kapaliyken gecen sure NO_DATA olarak isaretlenir.
   *
   * Iki kapanis bicimi ayni sonuca varir:
   *  - DUZGUN kapanis: son aralik kapanista (store.close) kapatilmistir.
   *  - ANI kapanis (elektrik kesintisi, cokme, guc dugmesi): son aralik ACIK
   *    kalmistir ve gercek bitisi bilinmez.
   *
   * Acik araligi yeniden baslama aniyla kapatmak, PC'nin kapali kaldigi TUM
   * sureyi son duruma yazar (RUNNING ise calisma orani sisirilir, "veri kaybi
   * calisma oranini etkilemez" kurali bozulur). Bu yuzden bitis olarak
   * tezgahin KAYDEDILEN son ornegi alinir; o yoksa araligin basi. Oradan simdiye
   * kadar olan sure NO_DATA'dir ve ilk ornek gelince store tarafindan kapatilir.
   *
   * Izlenmeyen (envanterde olmayan) tezgahlarda yalnizca acik aralik kapatilir,
   * NO_DATA acilmaz: artik veri gelmeyecek bir tezgah icin sonsuza kadar acik
   * bir bosluk birakilmaz.
   *
   * @param {Iterable<string>} watched izlenen (envanterdeki) tezgah kimlikleri
   * @param {number} at yeniden baslama ani (epoch ms)
   * @returns {Map<string, {id: number, startedAt: number}>} tezgah -> HALA ACIK
   *   olan NO_DATA araligi (en fazla bir tane)
   */
  resumeTimelines(watched, at) {
    const watchedSet = new Set(watched);
    const resumed = new Map();

    // Normalde tezgah basina tek acik aralik olur (#setState once kapatir, sonra
    // acar); sonuncu disinda acik kalan varsa bir sonrakinin basinda bitir.
    this.db
      .prepare(
        `UPDATE spans
            SET ended_at = (SELECT MIN(s2.started_at) FROM spans s2
                             WHERE s2.machine_id = spans.machine_id AND s2.id > spans.id)
          WHERE ended_at IS NULL
            AND id NOT IN (SELECT MAX(id) FROM spans GROUP BY machine_id)`,
      )
      .run();

    const lastSample = this.db.prepare('SELECT MAX(ts) AS ts FROM samples WHERE machine_id = ?');
    const reopenStmt = this.db.prepare('UPDATE spans SET ended_at = NULL WHERE id = ?');

    for (const last of this.lastSpanPerMachine()) {
      const watching = watchedSet.has(last.machineId);
      const startedAt = Number(last.startedAt);
      const isGap = last.state === TimelineState.NO_DATA;

      if (last.endedAt == null) {
        // ANI kapanis: aralik acik kalmis.
        if (watching && isGap) {
          // Bosluk zaten suruyor; ikinci bir NO_DATA acip ikiye bolme.
          resumed.set(last.machineId, { id: Number(last.id), startedAt });
          continue;
        }
        const sampleTs = lastSample.get(last.machineId).ts;
        const lastKnown = sampleTs == null ? startedAt : Number(sampleTs);
        // Alt sinir: aralik basi. Ust sinir: yeniden baslama ani (saat sapmasi).
        const endedAt = Math.min(Math.max(startedAt, lastKnown), Math.max(startedAt, at));
        this.closeSpanStmt.run(endedAt, last.id);
        if (watching) {
          resumed.set(last.machineId, {
            id: this.beginSpan(last.machineId, TimelineState.NO_DATA, endedAt),
            startedAt: endedAt,
          });
        }
      } else if (watching) {
        // DUZGUN kapanis: kapanista kapatilmis; ondan sonrasi bosluk.
        const endedAt = Number(last.endedAt);
        if (isGap) {
          reopenStmt.run(last.id);
          resumed.set(last.machineId, { id: Number(last.id), startedAt });
        } else {
          resumed.set(last.machineId, {
            id: this.beginSpan(last.machineId, TimelineState.NO_DATA, endedAt),
            startedAt: endedAt,
          });
        }
      }
    }
    return resumed;
  }

  /** @returns {{id: number, machineId: string, state: string, startedAt: number, endedAt: number|null}[]} */
  lastSpanPerMachine() {
    return this.db
      .prepare(
        `SELECT id, machine_id AS machineId, state, started_at AS startedAt, ended_at AS endedAt
           FROM spans
          WHERE id IN (SELECT MAX(id) FROM spans GROUP BY machine_id)`,
      )
      .all();
  }

  /**
   * Belirtilen aralikta tezgahin ornekleri. `maxPoints` verilirse esit
   * araliklarla seyreltilir - tarayiciya 100 bin nokta gondermemek icin.
   */
  samples(machineId, fromMs, toMs, maxPoints = 1500) {
    const total = this.db
      .prepare('SELECT COUNT(*) AS n FROM samples WHERE machine_id = ? AND ts BETWEEN ? AND ?')
      .get(machineId, fromMs, toMs).n;

    const step = Math.max(1, Math.ceil(Number(total) / maxPoints));
    // rowid'ye gore seyreltme: ornekler sirali eklendigi icin zamanda da esit dagilir.
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT *, ROW_NUMBER() OVER (ORDER BY ts) AS rn
             FROM samples
            WHERE machine_id = ? AND ts BETWEEN ? AND ?
         ) WHERE (rn - 1) % ? = 0
         ORDER BY ts`,
      )
      .all(machineId, fromMs, toMs, step);

    return { total: Number(total), step, rows };
  }

  /** Aralikla kesisen durum araliklari, kesisim sinirlarina kirpilmis halde. */
  spans(machineId, fromMs, toMs) {
    const rows = this.db
      .prepare(
        `SELECT state, started_at AS startedAt, ended_at AS endedAt, reason
           FROM spans
          WHERE machine_id = ?
            AND started_at < ?
            AND (ended_at IS NULL OR ended_at > ?)
          ORDER BY started_at`,
      )
      .all(machineId, toMs, fromMs);

    return rows.map((r) => ({
      state: r.state,
      startedAt: Math.max(Number(r.startedAt), fromMs),
      endedAt: Math.min(r.endedAt == null ? toMs : Number(r.endedAt), toMs),
      reason: r.reason ?? null,
    }));
  }

  /**
   * Durum basina toplam sure (ms) ve veri boslugu ozeti. Raporlarin dayandigi
   * tek kaynak burasi - NO_DATA ayri tutuldugu icin calisma orani veri
   * kaybindan etkilenmez.
   */
  summary(machineId, fromMs, toMs) {
    const totals = Object.fromEntries(Object.values(TimelineState).map((s) => [s, 0]));
    let gapCount = 0;
    let longestGapMs = 0;
    let trackedFrom = null;

    for (const span of this.spans(machineId, fromMs, toMs)) {
      const ms = Math.max(0, span.endedAt - span.startedAt);
      totals[span.state] = (totals[span.state] ?? 0) + ms;
      trackedFrom ??= span.startedAt;
      if (span.state === TimelineState.NO_DATA) {
        gapCount += 1;
        longestGapMs = Math.max(longestGapMs, ms);
      }
    }

    const observedMs = totals.RUNNING + totals.IDLE + totals.ALARM + totals.OFF;
    /**
     * Kapsama, istenen pencereye degil GERCEKTEN IZLENEN sureye gore olculur:
     * ilk kaydin oncesi "veri kaybi" degil, henuz izlemeye baslanmamis zamandir.
     * Aksi halde yeni kurulan sistem ilk saatlerde %99 kayip gosterir.
     */
    const trackedMs = trackedFrom == null ? 0 : Math.max(0, toMs - trackedFrom);

    return {
      machineId,
      fromMs,
      toMs,
      /** Izlemenin bu pencere icinde fiilen basladigi an. */
      trackedFrom,
      trackedMs,
      windowMs: Math.max(0, toMs - fromMs),
      totals,
      observedMs,
      coverage: trackedMs > 0 ? observedMs / trackedMs : null,
      runRatio: observedMs > 0 ? totals.RUNNING / observedMs : null,
      gapCount,
      longestGapMs,
      noDataMs: totals.NO_DATA,
    };
  }

  /** Durus listesi: IDLE / ALARM / OFF araliklari, uzunlugu azalan sirada. */
  downtimes(machineId, fromMs, toMs, limit = 50) {
    return this.spans(machineId, fromMs, toMs)
      .filter((s) => s.state !== TimelineState.RUNNING)
      .map((s) => ({ ...s, durationMs: s.endedAt - s.startedAt }))
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, limit);
  }

  pruneOld(now = Date.now()) {
    const sampleCut = now - SAMPLE_RETENTION_DAYS * 86_400_000;
    const spanCut = now - SPAN_RETENTION_DAYS * 86_400_000;
    this.db.prepare('DELETE FROM samples WHERE ts < ?').run(sampleCut);
    this.db.prepare('DELETE FROM spans WHERE ended_at IS NOT NULL AND ended_at < ?').run(spanCut);
    this.db.prepare('DELETE FROM production WHERE ts < ?').run(now - PRODUCTION_RETENTION_DAYS * 86_400_000);
    this.db.prepare('DELETE FROM program_runs WHERE ended_at IS NOT NULL AND ended_at < ?').run(now - PRODUCTION_RETENTION_DAYS * 86_400_000);
  }

  stats() {
    const samples = this.db.prepare('SELECT COUNT(*) AS n FROM samples').get().n;
    const spans = this.db.prepare('SELECT COUNT(*) AS n FROM spans').get().n;
    const production = this.db.prepare('SELECT COUNT(*) AS n FROM production').get().n;
    const programRuns = this.db.prepare('SELECT COUNT(*) AS n FROM program_runs').get().n;
    return { samples: Number(samples), spans: Number(spans), production: Number(production), programRuns: Number(programRuns), pending: this.pending.length };
  }

  close() {
    clearInterval(this.flushTimer);
    this.flush();
    this.db.close();
  }
}
