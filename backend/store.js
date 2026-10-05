import { MachineStatus, TimelineState } from '../shared/schema.js';
import { loadInventory } from '../shared/inventory.js';
import { TelemetryDb, GAP_THRESHOLD_MS } from './db.js';

const RIBBON_CHAR = Object.freeze({
  [TimelineState.RUNNING]: 'R',
  [TimelineState.IDLE]: 'I',
  [TimelineState.ALARM]: 'A',
  [TimelineState.OFF]: 'O',
  [TimelineState.NO_DATA]: 'N',
});
const RIBBON_SLOTS = 120;
/** Kart uzerindeki seride ve canli grafiklerde gosterilen pencere. */
export const LIVE_WINDOW_MS = 15 * 60_000;
/** Kartlardaki calisma orani bu pencere uzerinden hesaplanir (bir vardiya). */
export const SHIFT_WINDOW_MS = 8 * 3_600_000;

/** Sparkline icin ~15 dakikalik bellek ici pencere (1 Hz varsayimiyla). */
const HISTORY_CAP = 900;

/**
 * Durum araliklarini sabit sayida kovaya boyar. Ornek saymak yerine araliklari
 * kullanir: bir kovaya dusen en uzun durum kazanir, ALARM her zaman kazanir -
 * kisa suren bir alarm indirgemede kaybolmamali.
 */
function buildRibbon(spans, fromMs, toMs, slots = RIBBON_SLOTS) {
  const out = new Array(slots).fill('-');
  const span = toMs - fromMs;
  if (span <= 0) return out.join('');
  const slotMs = span / slots;

  /** @type {Map<string, number>[]} */
  const tally = Array.from({ length: slots }, () => new Map());

  for (const s of spans) {
    const first = Math.max(0, Math.floor((s.startedAt - fromMs) / slotMs));
    const last = Math.min(slots - 1, Math.floor((s.endedAt - fromMs) / slotMs));
    for (let i = first; i <= last; i += 1) {
      const slotStart = fromMs + i * slotMs;
      const overlap =
        Math.min(s.endedAt, slotStart + slotMs) - Math.max(s.startedAt, slotStart);
      if (overlap <= 0) continue;
      tally[i].set(s.state, (tally[i].get(s.state) ?? 0) + overlap);
    }
  }

  for (let i = 0; i < slots; i += 1) {
    if (tally[i].size === 0) continue;
    if (tally[i].has(TimelineState.ALARM)) {
      out[i] = RIBBON_CHAR[TimelineState.ALARM];
      continue;
    }
    let winner = null;
    let best = -1;
    for (const [state, ms] of tally[i]) {
      if (ms > best) { best = ms; winner = state; }
    }
    out[i] = RIBBON_CHAR[winner] ?? '-';
  }
  return out.join('');
}

/**
 * Durum deposu. Canli veri bellekte (hizli, her SSE karesi icin DB'ye gitmez),
 * gecmis ve raporlar SQLite'ta (sunucu yeniden baslayinca kaybolmaz).
 */
export class TelemetryStore {
  /** @param {string} dbFile */
  constructor(dbFile = 'data/telemetry.db') {
    this.db = new TelemetryDb(dbFile);
    /** @type {Map<string, any>} */
    this.machines = new Map();
    this.startedAt = Date.now();
    this.messageCount = 0;
    this.rejectedCount = 0;
    /** @type {Set<string>} Durum eslemesinde taninmayan ham degerler. */
    this.unknownRawStatus = new Set();

    for (const info of loadInventory()) {
      this.machines.set(info.id, this.#blank(info));
    }

    // Onceki calismadan yarim kalan araliklari kapat; sunucu kapaliyken veri de
    // gelmedigi icin o sure NO_DATA'dir ve ilk ornekte oyle yazilacak.
    this.db.closeDanglingSpans(this.startedAt);
  }

  /**
   * Ayarlar ekranindan yapilandirma degistiginde cagrilir - sunucuyu yeniden
   * baslatmaya gerek kalmaz. Var olan tezgahlarin gecmisi korunur.
   *
   * Envanterden cikarilan bir tezgahin verisi varsa listeden silinmez,
   * `removed` isaretiyle kalir: kayit altina alinmis gecmis erisilemez hale
   * gelmemeli.
   */
  reloadInventory() {
    const seen = new Set();
    for (const info of loadInventory()) {
      seen.add(info.id);
      const entry = this.machines.get(info.id);
      if (entry) entry.info = info;
      else this.machines.set(info.id, this.#blank(info));
    }
    for (const [id, entry] of this.machines) {
      if (seen.has(id)) continue;
      if (entry.latest == null) this.machines.delete(id);
      else entry.info = { ...entry.info, removed: true };
    }
    return this.machines.size;
  }

  #blank(info) {
    return {
      info,
      latest: null,
      /** @type {{ts:number,status:string,spindleRpm:number|null,feedRate:number|null,partCount:number|null}[]} */
      history: [],
      lastSeenAt: null,
      statusSince: null,
      /** @type {number|null} acik durum araliginin id'si */
      spanId: null,
      /** @type {string|null} acik araligin durumu (NO_DATA olabilir) */
      spanState: null,
      firstSeenAt: null,
    };
  }

  /**
   * Acik araligi kapatip yenisini acar. Ayni durum tekrar gelirse hicbir sey
   * yapmaz - aralik sayisi durum degisimi sayisina esit kalir.
   */
  #setState(entry, state, at, reason = null) {
    if (entry.spanState === state) return;
    if (entry.spanId != null) this.db.closeSpan(entry.spanId, at);
    entry.spanId = this.db.beginSpan(entry.info.id, state, at, reason);
    entry.spanState = state;
    entry.statusSince = at;
  }

  /** @param {object} msg parseTelemetry'den gecmis normalize mesaj */
  ingest(msg) {
    let entry = this.machines.get(msg.machineId);
    if (!entry) {
      // Envanterde olmayan bir tezgah veri gonderdi - yine de kabul et, ama
      // dashboard'da "kayitsiz" olarak isaretlensin.
      entry = this.#blank({
        id: msg.machineId,
        name: msg.machineId,
        vendor: 'Bilinmiyor',
        controller: '—',
        source: msg.source,
        reports: [],
        unregistered: true,
      });
      this.machines.set(msg.machineId, entry);
    }

    const now = Date.now();
    const prev = entry.latest;

    // Sessizlik esigi asilmissa, suskunlugun basladigi andan itibaren bir
    // NO_DATA araligi yaz; ardindan yeni durum araligi acilir.
    if (entry.lastSeenAt != null && now - entry.lastSeenAt > GAP_THRESHOLD_MS) {
      this.#setState(entry, TimelineState.NO_DATA, entry.lastSeenAt);
    }
    this.#setState(entry, msg.status, now, msg.downtimeReason);

    // Durum degisimi, alarm ve parca artisi kaybedilemez; gerisi seyreltilir.
    const force =
      prev == null ||
      prev.status !== msg.status ||
      (msg.alarms?.length ?? 0) !== (prev.alarms?.length ?? 0) ||
      msg.partCount !== prev.partCount;
    this.db.recordSample(msg, { force });

    // Durum eslemesi henuz dogrulanmamis ham degerleri topla (RUNNING metni
    // gercek tezgahta hala bilinmiyor - bkz. SYNTEC-REMOTEAPI.md).
    const raw = msg.controller?.rawStatus;
    if (raw) this.unknownRawStatus.add(`${msg.status}<-${raw}`);

    entry.latest = msg;
    entry.lastSeenAt = now;
    entry.firstSeenAt ??= now;
    entry.history.push({
      ts: Date.parse(msg.ts),
      status: msg.status,
      spindleRpm: msg.spindleRpm,
      feedRate: msg.feedRate,
      partCount: msg.partCount,
    });
    if (entry.history.length > HISTORY_CAP) entry.history.shift();

    this.messageCount += 1;
    return entry;
  }

  /**
   * Sessiz kalan tezgahlari NO_DATA'ya gecirir. Veri geri gelmesini beklemeden
   * bosluk aninda gorunsun diye periyodik olarak cagrilir.
   */
  sweep(now = Date.now()) {
    for (const entry of this.machines.values()) {
      if (entry.lastSeenAt == null) continue;
      if (now - entry.lastSeenAt > GAP_THRESHOLD_MS) {
        this.#setState(entry, TimelineState.NO_DATA, entry.lastSeenAt);
      }
    }
  }

  #view(entry, now) {
    const connected =
      entry.lastSeenAt != null && now - entry.lastSeenAt <= GAP_THRESHOLD_MS;

    const shiftFrom = now - SHIFT_WINDOW_MS;
    const summary = this.db.summary(entry.info.id, shiftFrom, now);
    const liveFrom = now - LIVE_WINDOW_MS;

    return {
      ...entry.info,
      machineId: entry.info.id,
      connected,
      /** Zaman serisinde gosterilen durum: baglanti yoksa NO_DATA. */
      state: connected ? entry.latest.status : TimelineState.NO_DATA,
      lastSeenAt: entry.lastSeenAt,
      statusSince: entry.statusSince,
      statusDurationSec: entry.statusSince
        ? Math.round((now - entry.statusSince) / 1000)
        : null,
      shift: summary,
      runRatio: summary.runRatio,
      ribbon: buildRibbon(this.db.spans(entry.info.id, liveFrom, now), liveFrom, now),
      telemetry: entry.latest,
    };
  }

  snapshot() {
    const now = Date.now();
    this.sweep(now);
    const machines = [...this.machines.values()].map((e) => this.#view(e, now));

    const counts = { RUNNING: 0, IDLE: 0, ALARM: 0, OFF: 0, NO_DATA: 0 };
    for (const m of machines) counts[m.state] += 1;

    return {
      serverTime: now,
      uptimeSec: Math.round((now - this.startedAt) / 1000),
      messageCount: this.messageCount,
      rejectedCount: this.rejectedCount,
      liveWindowMs: LIVE_WINDOW_MS,
      shiftWindowMs: SHIFT_WINDOW_MS,
      gapThresholdMs: GAP_THRESHOLD_MS,
      counts,
      machines,
    };
  }

  /** Bellek ici canli pencere - detay grafikleri bunu kullanir. */
  liveHistory(machineId) {
    const entry = this.machines.get(machineId);
    if (!entry) return null;
    return { machineId, samples: entry.history };
  }

  has(machineId) {
    return this.machines.has(machineId);
  }

  close() {
    const now = Date.now();
    for (const entry of this.machines.values()) {
      if (entry.spanId != null) this.db.closeSpan(entry.spanId, now);
    }
    this.db.close();
  }
}
