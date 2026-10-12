/**
 * Vardiya tanimi: 07-19 (Gunduz) ve 19-07 (Gece). Saatler SUNUCU bilgisayarinin yerel saatidir.
 *
 * "Uretim gunu" vardiyanin BASLADIGI gundur: 13 Ekim 03:00, 12 Ekim'in gece vardiyasidir.
 * Vardiya degisirse yalnizca SHIFTS degisir; hesaplar listeyi dolasir (iki vardiyaya sabitlenmemistir).
 */

export const SHIFTS = Object.freeze([
  Object.freeze({ id: 'gunduz', label: 'Gündüz', startHour: 7, endHour: 19 }),
  Object.freeze({ id: 'gece', label: 'Gece', startHour: 19, endHour: 7 }),
]);

const pad = (n) => String(n).padStart(2, '0');

/** Yerel tarih -> 'YYYY-MM-DD'. */
export function dateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 'YYYY-MM-DD' -> {y, m, d} (gercek bir tarihse), degilse null. */
export function parseDateKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(y, mo - 1, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) return null;
  return { y, m: mo, d };
}

/** 'YYYY-MM-DD' + gun sayisi. */
export function addDays(key, days) {
  const p = parseDateKey(key);
  if (!p) throw new RangeError(`gecersiz tarih: ${key}`);
  return dateKey(new Date(p.y, p.m - 1, p.d + days));
}

/**
 * Bir uretim gununun bir vardiyasinin sinirlari: [fromMs, toMs).
 * Bitis saati baslangictan kucukse vardiya ertesi gune tasar (gece 19-07).
 */
export function shiftWindow(date, shift) {
  const p = parseDateKey(date);
  if (!p) throw new RangeError(`gecersiz tarih: ${date}`);
  const overnight = shift.endHour <= shift.startHour;
  return {
    date,
    id: shift.id,
    label: shift.label,
    fromMs: new Date(p.y, p.m - 1, p.d, shift.startHour).getTime(),
    toMs: new Date(p.y, p.m - 1, p.d + (overnight ? 1 : 0), shift.endHour).getTime(),
  };
}

/** Bir ani kapsayan vardiya. */
export function shiftOf(ms, shifts = SHIFTS) {
  const day = dateKey(new Date(ms));
  for (const offset of [-1, 0]) {
    const date = addDays(day, offset);
    for (const shift of shifts) {
      const w = shiftWindow(date, shift);
      if (ms >= w.fromMs && ms < w.toMs) return w;
    }
  }
  // Tanimli vardiyalar gunu tam kaplamiyorsa (ozel ayar) en yakin gunun ilk vardiyasina dus.
  return shiftWindow(day, shifts[0]);
}

/** Uretim gunu (ms icin): vardiyanin basladigi tarih. */
export const productionDate = (ms, shifts = SHIFTS) => shiftOf(ms, shifts).date;

/** [from, to] (dahil) uretim gunlerinin tum vardiyalari, zaman sirasiyla. */
export function shiftWindows(fromDate, toDate, shifts = SHIFTS) {
  const out = [];
  for (let date = fromDate, guard = 0; date <= toDate && guard < 400; date = addDays(date, 1), guard += 1) {
    for (const shift of shifts) out.push(shiftWindow(date, shift));
  }
  return out;
}

/** Bu uretim gunu araligi kac gun (dahil)? */
export function daysBetween(fromDate, toDate) {
  const a = parseDateKey(fromDate);
  const b = parseDateKey(toDate);
  return Math.round((new Date(b.y, b.m - 1, b.d) - new Date(a.y, a.m - 1, a.d)) / 86_400_000) + 1;
}
