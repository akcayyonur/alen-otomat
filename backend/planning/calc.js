/**
 * Is emri hesaplari (saf islevler). Formuller kullanicinin Excel'inden ve gercek veriden cikarildi:
 *
 *   Hammadde toplami (kg)  = adet x brut agirlik (kg)                     (Excel: HM TOPLAM = BRUT x ADET)
 *   Planlanan sure (saat)  = adet x planlanan cevrim (sn) / 3600           (Excel: SAAT = (ADET x SN / 86400) x 24)
 *   Cubuk sayisi (BOY)     = adet x (tam boy + 2 mm) / 2900 mm            (is emirlerinin %86'sinda birebir tuttu;
 *                                                                          cubuk 3 m, faydali 2900 mm, 2 mm kesim payi; kullanici onayladi)
 *
 * Cubuk sabitleri ileride Ayarlar'dan degistirilebilir olacak (PLANLAMA-TASARIM.md); simdilik burada tek yerde.
 */
export const BAR_USABLE_MM = 2900;
export const CUT_ALLOWANCE_MM = 2;

const round = (x, digits) => {
  const k = 10 ** digits;
  return Math.round(x * k) / k;
};

/** @returns {{kg: number|null, bars: number|null}} bilinmeyen girdi -> null (0 degil) */
export function rawMaterial({ qty, grossKg, lengthMm }) {
  return {
    kg: qty > 0 && grossKg > 0 ? round(qty * grossKg, 3) : null,
    bars: qty > 0 && lengthMm > 0 ? round((qty * (lengthMm + CUT_ALLOWANCE_MM)) / BAR_USABLE_MM, 2) : null,
  };
}

export const plannedHours = (qty, sec) => (qty > 0 && sec > 0 ? round((qty * sec) / 3600, 2) : null);

/** 'CNC-03' -> 3 (kagit formdaki "TEZGAH NO"); sayi yoksa null. */
export function machineNumber(machineId) {
  const m = /(\d+)\s*$/.exec(String(machineId ?? ''));
  return m ? Number(m[1]) : null;
}
