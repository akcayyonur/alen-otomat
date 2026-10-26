/**
 * Hammadde rezervasyonu (F aşaması): saf hesaplar.
 *
 * Durum makinesi (1 iş emri = 1 satır):
 *   (yok) -> ayrildi            is emri uretime baslayinca, hedef adet x brut gramaj (dondurulur)
 *   ayrildi -> tuketildi        is emri bitince, gercek (paketleme) ya da teorik (sayac) tuketim belirlenir
 *   ayrildi -> serbest-birakildi  uretimdeyken iptal edilince, hic tuketilmedi
 *   tuketildi -> ayrildi        biten is emri uretime geri alinirsa (reserved_kg degismez)
 *
 * Serbest (kullanilabilir) hammadde stogu:
 *   serbestKg = stokKg − ayrilanKg('ayrildi') − girilmemisKg('tuketildi' VE Mikro'ya fis GİRİLMEMİŞ)
 * 'tuketildi' + fiş girilmiş satır hiçbir yerde ayrıca çıkarılmaz: bir sonraki Mikro Excel'i zaten düşmüş stoğu yansıtır.
 */
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

export const RESERVATION_STATUS = Object.freeze({ OPEN: 'ayrildi', RESOLVED: 'tuketildi', RELEASED: 'serbest-birakildi' });

/** Rezervasyon anında dondurulan kg. */
export const reservedKgOf = (targetQty, grossKg) => round(targetQty * grossKg, 3);

/**
 * Depo stoğu (Mikro Excel'i) + açık/çözülmemiş rezervasyonlar -> hammadde bazında serbest kg.
 * @param {{materialKey: string, name?: string|null, stockKg: number|null}[]} stockRows (birden çok Mikro kodu ayni anahtara katlanabilir, zaten toplanmis gelir)
 * @param {{materialKey: string, reservedKg: number, unenteredKg: number}[]} reservationTotals `PlanningDb.reservationTotalsByMaterial()`
 * @returns {{materialKey: string, name: string|null, stockKg: number|null, reservedKg: number, unenteredKg: number, freeKg: number|null}[]}
 */
export function freeStockByMaterial(stockRows, reservationTotals) {
  const stock = new Map(stockRows.map((r) => [r.materialKey, r]));
  const res = new Map(reservationTotals.map((r) => [r.materialKey, r]));
  const keys = new Set([...stock.keys(), ...res.keys()]);
  return [...keys].map((key) => {
    const s = stock.get(key) ?? null;
    const r = res.get(key) ?? { reservedKg: 0, unenteredKg: 0 };
    const stockKg = s ? s.stockKg : null;
    return {
      materialKey: key,
      name: s?.name ?? null,
      stockKg,
      reservedKg: round(r.reservedKg, 3),
      unenteredKg: round(r.unenteredKg, 3),
      freeKg: stockKg == null ? null : round(stockKg - r.reservedKg - r.unenteredKg, 3),
    };
  }).sort((a, b) => (a.freeKg ?? Infinity) - (b.freeKg ?? Infinity) || a.materialKey.localeCompare(b.materialKey, 'tr'));
}
