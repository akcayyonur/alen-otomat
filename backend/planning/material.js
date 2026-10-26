/**
 * Hammadde ve sarfiyat (planlama D aşaması): saf hesaplar.
 *
 * Kurallar (PLANLAMA-TASARIM.md §6 ve 7.2):
 *  - Sarfiyat TEORİKTİR: tezgahın işlediği TÜM parça (sayaç; numune/ayar/bozuk parça dahil) × brüt gramaj. Çubuk tartımı değildir;
 *    sayaç hatalı parçayı ayıramaz. Ret/hurda ayrıca izlenmez.
 *  - Birim kg (Mikro'ya sarfiyat kg olarak yazılır). Çubuk sayısı (BOY) bilgi olarak ayrıca verilir (calc.js formülü).
 *  - Hangi hammadde: operatörün başlatırken yazdığı GERÇEK hammadde (usedMaterial), yoksa iş emrindeki planlı hammadde.
 *  - Talaş (beklenen) = adet × (brüt − net): çıktıdır, satılan talaşla karşılaştırmaya yarar bilgi; sarfiyatı değiştirmez.
 *  - Bilinmeyen girdi null (0 değil): brüt ağırlık yoksa kg null, "ağırlık yok" olarak ayrıca sayılır.
 */
import { foldTr } from './normalize.js';
import { rawMaterial } from './calc.js';

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
const clean = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());

/** Hammadde kodunun gruplama anahtarı (büyük/küçük harf ve Türkçe harf duyarsız). */
export const materialKey = (m) => foldTr(String(m ?? '').trim());

/**
 * Bir iş emrinin (gerçekleşen ya da planlanan) adedi için hammadde hesabı.
 * @param {{material?: string|null, usedMaterial?: string|null, altMaterial?: string|null, grossKg?: number|null, netKg?: number|null, lengthMm?: number|null}} w
 * @param {number|null} qty adet (üretilen ya da kalan/hedef)
 */
export function consumptionOf(w, qty) {
  const planned = clean(w.material);
  const used = clean(w.usedMaterial);
  const material = used ?? planned;
  const alt = clean(w.altMaterial);
  const grossKnown = w.grossKg != null && w.grossKg > 0;
  const netKnown = w.netKg != null && w.netKg > 0;
  const known = qty != null && Number.isFinite(qty);
  const zero = known && qty === 0;
  return {
    material,
    plannedMaterial: planned,
    usedMaterial: used,
    // gerçek hammadde planlıdan da alternatifinden de farklıysa uyarılır; alternatif beklenen bir sapmadır
    isAlt: !!(used && alt && materialKey(used) === materialKey(alt) && !(planned && materialKey(used) === materialKey(planned))),
    differs: !!(used && planned && materialKey(used) !== materialKey(planned) && !(alt && materialKey(used) === materialKey(alt))),
    qty: known ? qty : null,
    grossKnown,
    kg: !known || !grossKnown ? null : zero ? 0 : round(qty * w.grossKg, 3),
    bars: !known ? null : zero ? (w.lengthMm > 0 ? 0 : null) : rawMaterial({ qty, grossKg: w.grossKg, lengthMm: w.lengthMm }).bars,
    netKg: !known || !netKnown ? null : zero ? 0 : round(qty * w.netKg, 3),
    scrapKg: !known || !grossKnown || !netKnown ? null : zero ? 0 : round(qty * (w.grossKg - w.netKg), 3),
  };
}

/**
 * GERÇEK sarfiyat (F aşaması): paketleme satırı varsa (sevk edilen adet + hurda adedi) × brüt; yoksa ("paketleme" bölümü kapalı ya da
 * henüz paketlenmedi) TEORİK (sayaç × brüt) kalır. Net ağırlık ve beklenen talaş HER ZAMAN teorik sayaca göredir (hurda bir parçanın
 * net/talaş değeri tanımlı değildir) — yalnız brüt sarfiyat (kg) ve çubuk sayısı gerçek adede göre değişir.
 * @param {{material?, usedMaterial?, altMaterial?, grossKg?, netKg?, lengthMm?}} w
 * @param {{rows: number, boxes: number, pieces: number, scrap: number}|null} packing `Packing.forWorkOrder(woNo)` çıktısı
 * @param {number|null} producedQty teorik (sayaç) adet — paketleme yoksa bu kullanılır
 */
export function realConsumptionOf(w, packing, producedQty) {
  const theoretical = consumptionOf(w, producedQty);
  if (!packing || packing.rows === 0) return { ...theoretical, qtySource: 'teorik' };
  const realQty = packing.pieces + packing.scrap;
  const grossKnown = w.grossKg != null && w.grossKg > 0;
  return {
    ...theoretical,
    qtySource: 'paketleme',
    packedQty: packing.pieces,
    scrapQty: packing.scrap,
    qty: realQty,
    kg: grossKnown ? round(realQty * w.grossKg, 3) : null,
    bars: rawMaterial({ qty: realQty, grossKg: w.grossKg, lengthMm: w.lengthMm }).bars,
  };
}

/**
 * Satırları hammaddeye göre toplar. Her satır: {material, kg, bars, scrapKg, qty, pendingKg?}. Bilinmeyen (null) değerler toplama katılmaz;
 * kaç satırda bilinmediği `unknownKg` ile ayrıca verilir.
 * @returns {{material: string, key: string, orders: number, qty: number, kg: number, bars: number, scrapKg: number, pendingKg: number, unknownKg: number}[]} kg'a göre azalan
 */
export function groupByMaterial(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = materialKey(r.material) || '—';
    const g = map.get(key) ?? { material: r.material ?? '— (hammadde yok)', key, orders: 0, qty: 0, kg: 0, bars: 0, scrapKg: 0, pendingKg: 0, unknownKg: 0 };
    g.orders += 1;
    g.qty += r.qty ?? 0;
    if (r.kg == null) g.unknownKg += 1;
    else g.kg += r.kg;
    g.bars += r.bars ?? 0;
    g.scrapKg += r.scrapKg ?? 0;
    g.pendingKg += r.pendingKg ?? 0;
    map.set(key, g);
  }
  return [...map.values()]
    .map((g) => ({ ...g, kg: round(g.kg, 3), bars: round(g.bars, 2), scrapKg: round(g.scrapKg, 3), pendingKg: round(g.pendingKg, 3) }))
    .sort((a, b) => b.kg - a.kg || a.material.localeCompare(b.material, 'tr'));
}
