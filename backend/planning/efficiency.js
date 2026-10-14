/**
 * Verimlilik (planlama E aşaması): saf hesaplar. Bugünkü "Üretim Kartı Verileri" Excel'inin otomatik karşılığı (PLANLAMA-TASARIM.md §7).
 *
 *   Verimlilik % = KAZANILAN süre ÷ AYRILAN süre,  kazanılan = adet × planlanan çevrim (sn)
 *                = gerçek adet ÷ (ayrılan süre ÷ planlanan sn)   (Excel'deki tanımla aynı)
 *   Ayrılan süre = iş emrinin penceresi ∩ vardiya (başlat/bitir insan eylemi; adet telemetriden). Excel'de elle bölünen "ürün değişince 6 sa + 6 sa" budur.
 *   Toplamlar SÜRE AĞIRLIKLIDIR (10 sa × %96 + 2 sa × %50 → ÷ 12): Σ kazanılan ÷ Σ ayrılan.
 *   Kullanılabilirlik (A) = tezgahın RUNNING süresi ÷ ÖLÇÜLEN süre (veri yok payda dışı: kayıp veri çalışma oranını bozmaz).
 *   Performans (P) = planlanan çevrim ÷ ölçülen çevrim (kontrolcü çevrim sayacı tepe değeri). Verimlilik ≈ A × P (yaklaşık: parçalar arası kayıp ayrıca görünür).
 *   Kalite (fire) ölçülmez: ret/hurda tutulmaz, OEE'nin kalite ayağı yoktur.
 *
 * Bilinmeyen girdi null (0 değil): planlanan çevrimi olmayan iş emri verimlilik toplamına katılmaz, ayrıca sayılır.
 */
import { shiftWindows, dateKey, addDays } from '../../shared/shifts.js';

export const overlapMs = (a1, a2, b1, b2) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
const r = (x, d) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

/**
 * [fromMs, toMs] aralığını vardiya parçalarına böler (üretim günü = vardiyanın başladığı gün).
 * @returns {{date: string, shiftId: string, label: string, from: number, to: number, shiftFrom: number, shiftTo: number}[]}
 */
export function splitByShift(fromMs, toMs) {
  if (!(toMs > fromMs)) return [];
  const startKey = addDays(dateKey(new Date(fromMs)), -1); // gece vardiyası önceki günden taşar
  const endKey = dateKey(new Date(toMs));
  return shiftWindows(startKey, endKey)
    .map((w) => ({ date: w.date, shiftId: w.id, label: w.label, from: Math.max(w.fromMs, fromMs), to: Math.min(w.toMs, toMs), shiftFrom: w.fromMs, shiftTo: w.toMs }))
    .filter((p) => p.to > p.from);
}

/**
 * Bir iş emrinin penceresindeki vardiya parçaları (iş emri × vardiya).
 * @param {{wo: object, from: number, to: number, events: object[], spans: object[], eventAfter?: number}} a
 *   from/to: ayrılan süre penceresi; events: o tezgahın üretim olayları (ts, qty, cycleSec, gapMs, suspect); spans: durum aralıkları (state, startedAt, endedAt);
 *   eventAfter: bu andan SONRAKİ olaylar sayılır (iş emri başlangıcı: aynı anda biten parça bir önceki işindir). Vardiya sınırı yarı açık [başlangıç, bitiş)
 *   (üretim raporuyla aynı); pencerenin bitişi dahil.
 */
export function orderSegments({ wo, from, to, events, spans, eventAfter = -Infinity }) {
  const out = [];
  for (const part of splitByShift(from, to)) {
    const evs = events.filter((e) => !e.suspect && e.ts > eventAfter && e.ts >= from && e.ts <= to && e.ts >= part.shiftFrom && e.ts < part.shiftTo);
    const qty = evs.reduce((a, e) => a + e.qty, 0);
    const cycles = evs.map((e) => e.cycleSec).filter((c) => c != null && Number.isFinite(c));
    let running = 0;
    let observed = 0;
    for (const s of spans) {
      const o = overlapMs(s.startedAt, s.endedAt, part.from, part.to);
      if (o === 0 || s.state === 'NO_DATA') continue;
      observed += o;
      if (s.state === 'RUNNING') running += o;
    }
    const planned = wo.plannedSec > 0 ? wo.plannedSec : null;
    out.push({
      date: part.date, shiftId: part.shiftId, label: part.label, machineId: wo.machineId, woNo: wo.no, status: wo.status, stockCode: wo.stockCode, productName: wo.productName,
      from: part.from, to: part.to, allottedSec: (part.to - part.from) / 1000, qty, approxQty: evs.reduce((a, e) => a + (e.gapMs > 0 ? e.qty : 0), 0),
      plannedSec: planned, earnedSec: planned == null ? null : qty * planned,
      runningSec: running / 1000, observedSec: observed / 1000, cycleN: cycles.length, cycleSum: cycles.reduce((a, c) => a + c, 0),
      grossKg: wo.grossKg ?? null, netKg: wo.netKg ?? null,
    });
  }
  return out;
}

/** Segment listesinin toplamları ve oranları (süre ağırlıklı). */
export function summarize(segs) {
  const t = {
    orders: new Set(), allottedSec: 0, knownAllottedSec: 0, qty: 0, earnedSec: 0, runningSec: 0, observedSec: 0, perfPlanned: 0, perfCycle: 0,
    grossKg: 0, netKg: 0, scrapKg: 0, noPlanned: 0, approxQty: 0,
  };
  for (const s of segs) {
    t.orders.add(s.woNo);
    t.allottedSec += s.allottedSec;
    t.qty += s.qty;
    t.approxQty += s.approxQty;
    t.runningSec += s.runningSec;
    t.observedSec += s.observedSec;
    if (s.plannedSec == null) t.noPlanned += 1;
    else {
      t.knownAllottedSec += s.allottedSec;
      t.earnedSec += s.earnedSec;
      if (s.cycleN > 0) { t.perfPlanned += s.plannedSec * s.cycleN; t.perfCycle += s.cycleSum; }
    }
    if (s.grossKg != null) t.grossKg += s.qty * s.grossKg;
    if (s.netKg != null) t.netKg += s.qty * s.netKg;
    if (s.grossKg != null && s.netKg != null) t.scrapKg += s.qty * (s.grossKg - s.netKg);
  }
  return {
    orders: t.orders.size, allottedSec: r(t.allottedSec, 0), qty: t.qty, approxQty: t.approxQty,
    efficiency: t.knownAllottedSec > 0 ? r(t.earnedSec / t.knownAllottedSec, 4) : null,
    availability: t.observedSec > 0 ? r(t.runningSec / t.observedSec, 4) : null,
    coverage: t.allottedSec > 0 ? r(Math.min(1, t.observedSec / t.allottedSec), 4) : null,
    performance: t.perfCycle > 0 && t.perfPlanned > 0 ? r(t.perfPlanned / t.perfCycle, 4) : null,
    earnedSec: r(t.earnedSec, 0), runningSec: r(t.runningSec, 0),
    grossKg: r(t.grossKg, 3), netKg: r(t.netKg, 3), scrapKg: r(t.scrapKg, 3), noPlanned: t.noPlanned,
  };
}

/** Anahtara göre gruplar (sıra korunur). */
export function groupBy(items, keyFn) {
  const map = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(it);
  }
  return map;
}

/**
 * Tezgah × gün × vardiya satırları (verimlilik matrisi). `shiftSec`: o vardiyanın [rangeFrom, rangeTo] içinde kalan süresi;
 * `unassignedSec`: bu tezgahta iş emri atanmamış (verimliliğe girmeyen) süre = vardiya süresi − ayrılan süre.
 */
export function matrixRows(segs, { rangeFrom, rangeTo }) {
  const shiftSec = new Map(splitByShift(rangeFrom, rangeTo).map((p) => [`${p.date}|${p.shiftId}`, (p.to - p.from) / 1000]));
  return [...groupBy(segs, (s) => `${s.date}|${s.shiftId}|${s.machineId}`).values()].map((list) => {
    const f = list[0];
    const sum = summarize(list);
    const total = shiftSec.get(`${f.date}|${f.shiftId}`) ?? null;
    return {
      date: f.date, shiftId: f.shiftId, label: f.label, machineId: f.machineId, products: [...new Set(list.map((s) => s.stockCode))], ...sum,
      shiftSec: total, unassignedSec: total == null ? null : Math.max(0, Math.round(total - sum.allottedSec)),
    };
  }).sort((a, b) => (a.date === b.date ? a.shiftId.localeCompare(b.shiftId) || a.machineId.localeCompare(b.machineId) : a.date < b.date ? -1 : 1));
}

/** Ürün bazında: planlanan ↔ ölçülen çevrim ↔ gerçekleşen (ayrılan ÷ adet). Verimlilik %105'in üstündeyse planlanan süre fazla temkinli olabilir: ÖNERİ (otomatik değişmez). */
export function productRows(segs) {
  return [...groupBy(segs, (s) => s.stockCode).entries()].map(([stockCode, list]) => {
    const sum = summarize(list);
    const cycleN = list.reduce((a, s) => a + s.cycleN, 0);
    const cycleSum = list.reduce((a, s) => a + s.cycleSum, 0);
    const measured = cycleN > 0 ? r(cycleSum / cycleN, 2) : null;
    const known = list.filter((s) => s.plannedSec != null);
    const knownQty = known.reduce((a, s) => a + s.qty, 0);
    const planned = knownQty > 0 ? r(known.reduce((a, s) => a + s.earnedSec, 0) / knownQty, 2) : (known[0]?.plannedSec ?? null);
    const enough = sum.allottedSec >= 3600 && sum.qty >= 20; // az veriden öneri çıkmaz
    return {
      stockCode, productName: list[0].productName, ...sum,
      plannedSec: planned, measuredCycleSec: measured, realizedSec: sum.qty > 0 ? r(sum.allottedSec / sum.qty, 2) : null,
      suggestion: enough && sum.efficiency != null && sum.efficiency > 1.05 && measured != null ? { kind: 'planlanan-sure-fazla', plannedSec: r(measured, 1) } : null,
    };
  }).sort((a, b) => b.allottedSec - a.allottedSec);
}

/** Gün bazında (tüm tezgahlar): Gündüz / Gece / gün toplamı verimliliği (süre ağırlıklı). */
export function dayRows(segs) {
  return [...groupBy(segs, (s) => s.date).entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, list]) => {
    const byShift = {};
    for (const [id, l] of groupBy(list, (s) => s.shiftId)) byShift[id] = summarize(l);
    return { date, ...summarize(list), shifts: byShift };
  });
}
