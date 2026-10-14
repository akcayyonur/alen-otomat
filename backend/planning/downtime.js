/**
 * Duruslar (T asamasi): telemetri durum araliklarindan OLCULMUS duruslar ve onlara baglanan NEDEN kayitlari. Saf islevler.
 *
 * Kural (PLANLAMA-TASARIM.md 7.1): sure telemetriden gelir, NEDEN insandan gelir; kimse dakika yazmaz, olculmus durusu secer.
 *  - Durus = art arda gelen BOSTA / ALARM / KAPALI araliklarin birlesimi. VERI YOK (NO_DATA) durus DEGILDIR ve durusu boler:
 *    "veri gelmedi" ile "tezgah durdu" karistirilmaz.
 *  - Esik suresinden kisa duruslar (varsayilan 3 dk) sorulmaz.
 *  - Bir durusa birden cok neden baglanabilir (40 dk cubuk degisimi + 20 dk ayarci bekleme): nedenler durus icinde ALT ARALIKLARDIR,
 *    cakisamaz. Neden atanmamis kisim "nedeni belirsiz" kalir ve operator ekraninda bekleyen is olarak gorunur.
 */

export const STOP_STATES = Object.freeze(['IDLE', 'ALARM', 'OFF']);
export const DEFAULT_MIN_STOP_MS = 3 * 60_000;
/** Bir durusun neden atanmamis kismi bu surenin altindaysa "cevaplandi" sayilir (yuvarlama/saniye farklari). */
export const ANSWERED_SLACK_MS = 60_000;

/**
 * @param {{state: string, startedAt: number, endedAt: number}[]} spans zaman sirali (db.spans: pencereye kirpilmis)
 * @param {{minMs?: number, now: number}} o
 * @returns {{from: number, to: number, durationMs: number, ongoing: boolean, states: Record<string, number>, dominant: string}[]} zaman sirali
 */
export function buildStops(spans, { minMs = DEFAULT_MIN_STOP_MS, now }) {
  const stops = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.to - cur.from >= minMs) {
      const dominant = Object.entries(cur.states).sort((a, b) => b[1] - a[1])[0][0];
      stops.push({ from: cur.from, to: cur.to, durationMs: cur.to - cur.from, ongoing: cur.ongoing, states: cur.states, dominant });
    }
    cur = null;
  };
  for (const s of spans) {
    if (!STOP_STATES.includes(s.state) || !(s.endedAt > s.startedAt)) {
      flush(); // RUNNING ve NO_DATA durusu boler
      continue;
    }
    const ongoing = s.endedAt >= now - 1000;
    if (cur && s.startedAt - cur.to <= 1000) {
      cur.to = s.endedAt;
      cur.states[s.state] = (cur.states[s.state] ?? 0) + (s.endedAt - s.startedAt);
      cur.ongoing = ongoing;
    } else {
      flush();
      cur = { from: s.startedAt, to: s.endedAt, ongoing, states: { [s.state]: s.endedAt - s.startedAt } };
    }
  }
  flush();
  return stops;
}

/** [from, to] icinde reasons'in kapsamadigi parcalar. reasons: {from, to}[] */
export function uncoveredParts(from, to, reasons) {
  const parts = [];
  let at = from;
  for (const r of [...reasons].sort((a, b) => a.from - b.from)) {
    if (r.to <= at) continue;
    if (r.from >= to) break;
    if (r.from > at) parts.push({ from: at, to: Math.min(r.from, to) });
    at = Math.max(at, r.to);
    if (at >= to) break;
  }
  if (at < to) parts.push({ from: at, to });
  return parts;
}

/**
 * Durusa baglanan nedenleri ve cevaplanmamis kismi ekler.
 * @param {ReturnType<typeof buildStops>} stops
 * @param {{id: number, from: number, to: number}[]} reasons silinmemis nedenler (durusla kesisenler kirpilarak sayilir)
 */
export function attachReasons(stops, reasons) {
  return stops.map((s) => {
    const mine = reasons.filter((r) => r.to > s.from && r.from < s.to);
    const clipped = mine.map((r) => ({ from: Math.max(r.from, s.from), to: Math.min(r.to, s.to) }));
    const uncovered = uncoveredParts(s.from, s.to, clipped);
    const uncoveredMs = uncovered.reduce((a, p) => a + (p.to - p.from), 0);
    return { ...s, reasons: mine, reasonMs: s.durationMs - uncoveredMs, uncoveredMs, uncovered, answered: uncoveredMs <= ANSWERED_SLACK_MS };
  });
}
