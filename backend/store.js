import { MachineStatus } from '../shared/schema.js';
import { loadInventory } from '../shared/inventory.js';

const RIBBON_CHAR = {
  [MachineStatus.RUNNING]: 'R',
  [MachineStatus.IDLE]: 'I',
  [MachineStatus.OFF]: 'O',
  [MachineStatus.ALARM]: 'A',
};
const RIBBON_SLOTS = 120;

/**
 * Gecmisi sabit sayida kovaya indirger. Her kovada en cok gorulen durum kazanir
 * (calisma oranini dogru gostermek icin); alarm varsa her zaman o kazanir -
 * kisa suren bir alarm indirgemede kaybolmamali.
 */
function buildRibbon(history) {
  if (history.length === 0) return '';
  const out = new Array(RIBBON_SLOTS).fill('-');
  const perSlot = history.length / RIBBON_SLOTS;

  for (let slot = 0; slot < RIBBON_SLOTS; slot += 1) {
    const start = Math.floor(slot * perSlot);
    const end = Math.max(start + 1, Math.floor((slot + 1) * perSlot));

    const tally = new Map();
    let hasAlarm = false;
    for (let i = start; i < end && i < history.length; i += 1) {
      const s = history[i].status;
      if (s === MachineStatus.ALARM) hasAlarm = true;
      tally.set(s, (tally.get(s) ?? 0) + 1);
    }
    if (tally.size === 0) continue;

    let winner = MachineStatus.ALARM;
    if (!hasAlarm) {
      let best = -1;
      for (const [status, count] of tally) {
        if (count > best) { best = count; winner = status; }
      }
    }
    out[slot] = RIBBON_CHAR[winner];
  }
  return out.join('');
}

/** Sparkline icin ~15 dakikalik pencere (1 Hz varsayimiyla). */
const HISTORY_CAP = 900;
/** Bu sureden uzun sessiz kalan tezgah "baglanti yok" sayilir. */
const STALE_AFTER_MS = 10_000;

/**
 * Bellek ici durum deposu. Iskelet asamasinda kalicilik yok - Bolum 10'daki
 * zaman serisi veritabani (TimescaleDB/InfluxDB) bunun yerine gececek.
 */
export class TelemetryStore {
  constructor() {
    /** @type {Map<string, any>} */
    this.machines = new Map();
    this.startedAt = Date.now();
    this.messageCount = 0;
    this.rejectedCount = 0;

    // Envanterdeki tezgahlar, henuz veri gelmese de dashboard'da gorunur.
    for (const info of loadInventory()) {
      this.machines.set(info.id, this.#blank(info));
    }
  }

  #blank(info) {
    return {
      info,
      latest: null,
      history: [],
      lastSeenAt: null,
      statusSince: null,
      /** Her durumda gecirilen toplam sure (ms). */
      statusMs: {
        [MachineStatus.RUNNING]: 0,
        [MachineStatus.IDLE]: 0,
        [MachineStatus.ALARM]: 0,
        [MachineStatus.OFF]: 0,
      },
    };
  }

  /** @param {object} msg parseTelemetry'den gecmis normalize mesaj */
  ingest(msg) {
    let entry = this.machines.get(msg.machineId);
    if (!entry) {
      // Envanterde olmayan bir tezgah veri gonderdi - yine de kabul et.
      entry = this.#blank({
        id: msg.machineId,
        name: msg.machineId,
        vendor: 'Bilinmiyor',
        controller: '—',
        year: null,
        source: msg.source,
        reports: [],
        unregistered: true,
      });
      this.machines.set(msg.machineId, entry);
    }

    const now = Date.now();
    const prev = entry.latest;

    if (prev && entry.lastSeenAt) {
      const delta = Math.min(now - entry.lastSeenAt, STALE_AFTER_MS);
      entry.statusMs[prev.status] = (entry.statusMs[prev.status] ?? 0) + delta;
    }
    if (!prev || prev.status !== msg.status) {
      entry.statusSince = now;
    }

    entry.latest = msg;
    entry.lastSeenAt = now;
    entry.history.push({
      ts: msg.ts,
      status: msg.status,
      spindleRpm: msg.spindleRpm,
      feedRate: msg.feedRate,
    });
    if (entry.history.length > HISTORY_CAP) entry.history.shift();

    this.messageCount += 1;
    return entry;
  }

  /** Tezgahin gozlem suresi icindeki calisma orani (tam OEE degil). */
  #runRatio(entry) {
    const ms = entry.statusMs;
    const observed = ms[MachineStatus.RUNNING] + ms[MachineStatus.IDLE] + ms[MachineStatus.ALARM];
    if (observed < 1000) return null;
    return ms[MachineStatus.RUNNING] / observed;
  }

  #view(entry, now) {
    const stale = entry.lastSeenAt === null || now - entry.lastSeenAt > STALE_AFTER_MS;
    return {
      ...entry.info,
      machineId: entry.info.id,
      connected: !stale,
      lastSeenAt: entry.lastSeenAt,
      statusSince: entry.statusSince,
      statusDurationSec: entry.statusSince ? Math.round((now - entry.statusSince) / 1000) : null,
      runRatio: this.#runRatio(entry),
      ribbon: buildRibbon(entry.history),
      telemetry: entry.latest,
    };
  }

  snapshot() {
    const now = Date.now();
    const machines = [...this.machines.values()].map((e) => this.#view(e, now));

    const counts = { RUNNING: 0, IDLE: 0, ALARM: 0, OFF: 0, OFFLINE: 0 };
    for (const m of machines) {
      if (!m.connected) counts.OFFLINE += 1;
      else counts[m.telemetry.status] += 1;
    }

    return {
      serverTime: now,
      uptimeSec: Math.round((now - this.startedAt) / 1000),
      messageCount: this.messageCount,
      rejectedCount: this.rejectedCount,
      counts,
      machines,
    };
  }

  history(machineId) {
    const entry = this.machines.get(machineId);
    if (!entry) return null;
    return { machineId, samples: entry.history };
  }
}
