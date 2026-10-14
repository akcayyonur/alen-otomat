/**
 * Is emrinin gerceklesen uretimi (saf islev; veritabani ve telemetri disaridan verilir, bu yuzden sentetik olaylarla test edilir).
 *
 * Kural (PLANLAMA-TASARIM.md 7.2): baslat/bitir bir insan eylemidir, ADET telemetriden gelir. Is emrinin penceresi
 * [baslangic, bitis] ve tezgahi belli; adet = o pencerede o tezgahta sayilan parcalar (uretim olaylari, vardiya kirilimli).
 * Program <-> urun eslemesi adedi BELIRLEMEZ, yalniz capraz denetimdir (yanlis tezgah/is emri uyarisi).
 *
 * Olcutler ayri gosterilir (planlanan, olculen cevrim, parcalar arasi sure): aralarindaki fark gizlenmez.
 */
import { shiftOf } from '../../shared/shifts.js';
import { programKey } from './program-map.js';

const DAY_MS = 86_400_000;
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

/**
 * @param {{
 *   wo: {codeKey: string, targetQty: number, sampleQty?: number|null, plannedSec: number|null, dueDate: number|null},
 *   events: {ts: number, program: string|null, qty: number, cycleSec: number|null, gapMs: number, suspect: boolean}[],
 *   programMap: Map<string, {codeKey: string, stockCode: string}>,
 *   hasMapping: boolean,
 *   from: number, to: number, open: boolean, now: number,
 *   live?: {connected: boolean, state: string|null, program: string|null}|null,
 * }} a
 */
export function computeProgress({ wo, events, programMap, hasMapping, from, to, open, now, live = null }) {
  const counted = events.filter((e) => !e.suspect);
  const suspect = events.filter((e) => e.suspect);
  const produced = counted.reduce((a, e) => a + e.qty, 0);
  const approxQty = counted.reduce((a, e) => a + (e.gapMs > 0 ? e.qty : 0), 0);

  // vardiya kirilimi (zaman sirasiyla)
  const byShift = new Map();
  for (const e of counted) {
    const w = shiftOf(e.ts);
    const key = `${w.date}|${w.id}`;
    const cur = byShift.get(key) ?? { date: w.date, shiftId: w.id, label: w.label, qty: 0 };
    cur.qty += e.qty;
    byShift.set(key, cur);
  }

  // olculen cevrim: kontrolcunun cevrim sayaci tepe degeri (production.js); parcalar arasi sure: veri kopuklugu olmayan olaylar arasi
  const cycles = counted.map((e) => e.cycleSec).filter((c) => c != null && Number.isFinite(c));
  const measuredAvgSec = cycles.length ? r2(cycles.reduce((a, c) => a + c, 0) / cycles.length) : null;
  const clean = counted.filter((e) => e.gapMs === 0);
  let intervalSec = null;
  if (clean.length >= 2) {
    const afterFirst = clean.slice(1).reduce((a, e) => a + e.qty, 0);
    if (afterFirst > 0) intervalSec = r2((clean.at(-1).ts - clean[0].ts) / 1000 / afterFirst);
  }

  // numune: ilk N adedin olculen ortalama cevrimi; N tamamlaninca "urun kartina yaz" ONERISI (kendiliginden yazilmaz)
  let sample = null;
  if (wo.sampleQty) {
    let acc = 0;
    const first = [];
    for (const e of counted) {
      if (acc >= wo.sampleQty) break;
      first.push(e);
      acc += e.qty;
    }
    const cs = first.map((e) => e.cycleSec).filter((c) => c != null && Number.isFinite(c));
    const avg = cs.length ? r2(cs.reduce((a, c) => a + c, 0) / cs.length) : null;
    const complete = produced >= wo.sampleQty;
    const differs = avg != null && wo.plannedSec != null ? Math.abs(avg - wo.plannedSec) / wo.plannedSec >= 0.02 : avg != null;
    sample = {
      qty: wo.sampleQty, doneQty: Math.min(produced, wo.sampleQty), complete, measuredAvgSec: avg, measuredN: cs.length, plannedSec: wo.plannedSec ?? null,
      suggestSec: complete && differs ? r1(avg) : null,
    };
  }

  // programlar: eslemeye gore durum
  const progs = new Map();
  for (const e of counted) {
    const name = e.program ?? null;
    const cur = progs.get(name) ?? { program: name, qty: 0 };
    cur.qty += e.qty;
    progs.set(name, cur);
  }
  const programs = [...progs.values()].map((p) => {
    if (p.program == null) return { ...p, status: 'yok' };
    const m = programMap.get(programKey(p.program));
    if (!m) return { ...p, status: 'esli-degil' };
    return { ...p, status: m.codeKey === wo.codeKey ? 'esli' : 'baska-urun', ...(m.codeKey === wo.codeKey ? {} : { stockCode: m.stockCode }) };
  }).sort((a, b) => b.qty - a.qty);

  const remaining = Math.max(0, wo.targetQty - produced);
  const warnings = [];
  const other = programs.filter((p) => p.status === 'baska-urun');
  if (other.length) {
    warnings.push({ level: 'warn', text: `${other.reduce((a, p) => a + p.qty, 0)} adet başka ürüne eşli programdan sayıldı (${other.map((p) => `${p.program} → ${p.stockCode}`).join(', ')}). Yanlış tezgah ya da yanlış iş emri olabilir.` });
  }
  const unmapped = programs.filter((p) => p.status === 'esli-degil');
  if (unmapped.length && hasMapping) {
    warnings.push({ level: 'warn', text: `${unmapped.reduce((a, p) => a + p.qty, 0)} adet eşlenmemiş programdan sayıldı (${unmapped.map((p) => p.program).join(', ')}). Program eşleme sekmesinden eşleyin.` });
  }
  if (produced > 0 && !hasMapping) {
    warnings.push({ level: 'info', text: 'Bu ürün için program eşlemesi yok: adet tezgah ve zaman aralığına göre sayıldı, program doğrulanamadı (Program eşleme sekmesi).' });
  }
  if (suspect.length) {
    warnings.push({ level: 'warn', text: `${suspect.length} sayaç sıçraması (${suspect.reduce((a, e) => a + e.qty, 0)} adet) sayılmadı: sayaç elle ayarlanmış olabilir.` });
  }
  if (approxQty > 0) {
    warnings.push({ level: 'info', text: `${approxQty} adet veri kopukluğundan sonra sayıldı: adet gerçek, zamanı/vardiyası yaklaşık.` });
  }

  let liveInfo = null;
  if (open && live) {
    const livePs = live.program ? programMap.get(programKey(live.program)) : null;
    liveInfo = { connected: live.connected, state: live.state, program: live.program, programStatus: !live.program ? 'yok' : !livePs ? 'esli-degil' : livePs.codeKey === wo.codeKey ? 'esli' : 'baska-urun' };
    if (!live.connected) warnings.push({ level: 'warn', text: 'Tezgahtan şu an veri gelmiyor: sayım gecikir, kopukluktan sonra düzelir.' });
    else if (liveInfo.programStatus === 'baska-urun') warnings.push({ level: 'warn', text: `Tezgahta şu an başka ürüne eşli program çalışıyor (${live.program} → ${livePs.stockCode}).` });
  }
  if (open && produced === 0 && now - from > 30 * 60_000) {
    warnings.push({ level: 'info', text: 'Başlatıldı ama henüz parça sayılmadı.' });
  }

  // tahmini bitis: yalniz acik is emri, mevcut hizla
  let eta = null;
  if (open && remaining > 0) {
    const basis = intervalSec != null ? ['aralik', intervalSec] : measuredAvgSec != null ? ['cevrim', measuredAvgSec] : wo.plannedSec != null ? ['plan', wo.plannedSec] : null;
    if (basis) {
      const ms = now + remaining * basis[1] * 1000;
      eta = { ms: Math.round(ms), basis: basis[0], lateRisk: wo.dueDate != null && ms > wo.dueDate + DAY_MS };
    }
  }

  return {
    from, to, open,
    produced, approxQty, suspectEvents: suspect.length, suspectQty: suspect.reduce((a, e) => a + e.qty, 0),
    remaining, pct: wo.targetQty > 0 ? r1((produced / wo.targetQty) * 100) : null, overBy: Math.max(0, produced - wo.targetQty),
    firstTs: counted[0]?.ts ?? null, lastTs: counted.at(-1)?.ts ?? null,
    shifts: [...byShift.values()],
    cycle: { plannedSec: wo.plannedSec ?? null, measuredAvgSec, measuredN: cycles.length, intervalSec }, sample,
    programs, eta, live: liveInfo, warnings,
  };
}
