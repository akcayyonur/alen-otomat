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

/** Bu sureden uzun sessizlik veri boslugu sayilir. */
export const GAP_THRESHOLD_MS = 10_000;

/** Ornekler en az bu araliklarla yazilir (degisim varsa her zaman yazilir). */
const SAMPLE_MIN_INTERVAL_MS = 5_000;

/** Tampon bu aralikla tek islemde bosaltilir. */
const FLUSH_MS = 2_000;

const SAMPLE_RETENTION_DAYS = 7;
const SPAN_RETENTION_DAYS = 400;

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

    /** @type {object[]} yazilmayi bekleyen ornekler */
    this.pending = [];
    /** @type {Map<string, number>} tezgah -> en son yazilan ornegin zamani */
    this.lastWrittenAt = new Map();

    this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);
    this.flushTimer.unref?.();

    this.pruneOld();
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
   * Sunucu kapanip acildiginda yarim kalmis araliklari kapatir. Acik birakilan
   * aralik, sunucunun ayakta oldugu anlamina gelir - kapaliyken veri de
   * gelmedigi icin gerisi NO_DATA'dir.
   */
  closeDanglingSpans(at) {
    const open = this.db
      .prepare('SELECT id, machine_id, started_at FROM spans WHERE ended_at IS NULL')
      .all();
    for (const row of open) {
      this.closeSpanStmt.run(Math.max(Number(row.started_at), at), row.id);
    }
    return open.length;
  }

  /** @returns {{machineId: string, state: string, startedAt: number}[]} */
  lastSpanPerMachine() {
    return this.db
      .prepare(
        `SELECT machine_id AS machineId, state, started_at AS startedAt, ended_at AS endedAt
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
  }

  stats() {
    const samples = this.db.prepare('SELECT COUNT(*) AS n FROM samples').get().n;
    const spans = this.db.prepare('SELECT COUNT(*) AS n FROM spans').get().n;
    return { samples: Number(samples), spans: Number(spans), pending: this.pending.length };
  }

  close() {
    clearInterval(this.flushTimer);
    this.flush();
    this.db.close();
  }
}
