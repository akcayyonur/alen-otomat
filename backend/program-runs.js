/**
 * Program calisma araliklari: "hangi program hangi saatte devreye girdi, ne zaman bitti".
 *
 * Neden ayri bir kayit: ornekler 7 gunde silinir; vardiya raporlari aylarca geriye bakar. Bir program degisiminde
 * bir satir (tezgah basina gunde birkac) cok kucuktur ve 400 gun saklanir (tablo `program_runs`, backend/db.js).
 *
 * Kurallar (hepsi test edilir, backend/program-runs.test.js):
 *  - Program = ana program (`programOf`, uretim adediyle ayni kaynak); alt program gecici gecisi aralik bolmez.
 *    Ortak alt program (O9001, ör. cubuk alma) `programOf`'ta okunamayan sayilir: ayri bir satir ACILMAZ, acik
 *    aralik onun uzerinden devam eder.
 *  - OKUNAMAYAN program (null) bir degisiklik sayilmaz: aralik surer ("okunamayan alan null, asla baska bir sey").
 *  - Program degisince onceki aralik, yenisinin basladigi anda biter (kontrolcu arada baska bir sey calistirmaz).
 *  - Uzun sessizlik (RUN_GAP_MS) araligi tezgahin SON GORULDUGU anda bitirir; veri gelince (ayni program bile olsa)
 *    yeni aralik acilir: "tezgah kapaliydi / veri yoktu" ile "ayni program calismaya devam etti" ayri seylerdir.
 *  - Sunucu yeniden baslarsa onceki aralik son kayitli ornekte kapanir; ayni program kisa surede (RUN_GAP_MS icinde)
 *    geri gelirse AYNI aralik surer (her guncellemede bolunmesin).
 *  - Aralıklar ASLA cakismaz: zaman geri giderse (saat duzeltmesi, tampondan eski mesaj) yeni aralik onceki bitisten
 *    once baslamaz (basi, onceki bitisine sabitlenir).
 */

/** Bu sureden uzun sessizlik araligi sonlandirir (tezgah kapandi / ajan durdu). */
export const RUN_GAP_MS = 10 * 60_000;

const clean = (program) => {
  if (program == null) return null;
  const text = String(program).trim();
  return text === '' ? null : text;
};

/**
 * @typedef {object} RunSink
 * @property {(machineId: string, program: string, startedAt: number) => number} open      yeni aralik, kimligini dondurur
 * @property {(id: number, endedAt: number) => void} close
 * @property {(id: number) => void} [reopen]                                               kapali araligi yeniden acar
 */

export class ProgramRunTracker {
  /**
   * @param {RunSink} sink
   * @param {{gapMs?: number, seed?: (machineId: string) => ({id: number, program: string, startedAt: number, endedAt: number|null}|null)}} [opts]
   *   seed: yeniden baslamada tezgahin SON kayitli araligi (ilk mesajda devam mi yeni mi karari icin)
   */
  constructor(sink, { gapMs = RUN_GAP_MS, seed = () => null } = {}) {
    this.sink = sink;
    this.gapMs = gapMs;
    this.seed = seed;
    /** @type {Map<string, {id: number, program: string, startedAt: number, lastTs: number}>} */
    this.cur = new Map();
    /** @type {Set<string>} ilk mesajda tohum denetimi yapilmis tezgahlar */
    this.seeded = new Set();
    /** @type {Map<string, number>} tezgahin en son kapanan araliginin bitisi (yeni aralik bundan once baslamasin) */
    this.lastEnd = new Map();
  }

  #close(machineId, cur, endedAt) {
    const end = Math.max(cur.startedAt, endedAt);
    this.sink.close(cur.id, end);
    this.lastEnd.set(machineId, end);
    this.cur.delete(machineId);
  }

  /**
   * @param {string} machineId
   * @param {number} tsRaw      mesaj zamani (epoch ms)
   * @param {string|null} program programOf(msg)
   */
  observe(machineId, tsRaw, program) {
    const key = clean(program);
    let ts = tsRaw;
    let cur = this.cur.get(machineId);

    if (!cur && !this.seeded.has(machineId)) {
      this.seeded.add(machineId);
      const last = this.seed(machineId);
      if (last?.endedAt != null) this.lastEnd.set(machineId, last.endedAt);
      if (last && last.endedAt != null && ts - last.endedAt <= this.gapMs && key != null && key === last.program && this.sink.reopen) {
        this.sink.reopen(last.id);
        cur = { id: last.id, program: last.program, startedAt: last.startedAt, lastTs: Math.max(last.endedAt, ts) };
        this.cur.set(machineId, cur);
        return;
      }
    }

    if (cur) {
      if (ts < cur.lastTs) ts = cur.lastTs; // geri gelen zaman (tampondan donen eski mesaj) aralik sirasini bozmaz
      if (ts - cur.lastTs > this.gapMs) {
        this.#close(machineId, cur, cur.lastTs);
      } else {
        cur.lastTs = ts;
        if (key == null || key === cur.program) return;
        this.#close(machineId, cur, ts);
      }
    }
    if (key == null) return;
    ts = Math.max(ts, this.lastEnd.get(machineId) ?? -Infinity);
    const id = this.sink.open(machineId, key, ts);
    this.cur.set(machineId, { id, program: key, startedAt: ts, lastTs: ts });
  }

  /** Sessiz kalan tezgahlarin acik araligini son goruldukleri anda bitirir (periyodik cagrilir). */
  sweep(now = Date.now()) {
    for (const [machineId, cur] of [...this.cur]) {
      if (now - cur.lastTs > this.gapMs) this.#close(machineId, cur, cur.lastTs);
    }
  }

  /** Kapanista: acik araliklar son goruldukleri anda biter. */
  closeAll() {
    for (const [machineId, cur] of [...this.cur]) this.#close(machineId, cur, cur.lastTs);
  }

  /** Bir tezgahin su an acik araligi (yoksa null). */
  current(machineId) {
    const c = this.cur.get(machineId);
    return c ? { program: c.program, startedAt: c.startedAt } : null;
  }
}
