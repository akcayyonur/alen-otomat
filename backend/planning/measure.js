/**
 * ÖLÇÜ KONTROLÜ (EYS.FR.005): iş emrinde üretilen ürünlerin saatlik ölçümleri. Kâğıt form: üstte GÜNDÜZ bloğu (07:30 … 19:00, 24 sütun), altta GECE bloğu
 * (19:30 … 07:00, 24 sütun); satırlar 1…10 (ölçülen özellik: ör. "Ø34,2 −0,1/+0") ve üç kontrol satırı (Görsel Kontrol, Geçer Mastarlar, Geçmez Mastarlar).
 *
 * Bu modül SAF hesaplardır (testli): sütun (30 dk) yuvarlama ve formdaki konumu, ölçü planı doğrulaması, tolerans değerlendirmesi, değer ayrıştırma.
 * Veri iş emrine bağlıdır; ürün tanıtım kartı (kasa) kendi zaman aralığındaki ölçümleri gösterir (planning.js `measureSheet`).
 */
import { dateKey, addDays } from '../../shared/shifts.js';

export const SLOT_MIN = 30;
export const MAX_ROWS = 10;
/** Form sütunları: gündüz 07:30 … 19:00, gece 19:30 … ertesi 07:00 (toplam 48 yarım saat). */
export const SLOTS_PER_FORM = 48;
export const FORM_START_MIN = 7 * 60 + 30;
export const CHECK_KINDS = Object.freeze(['gorsel', 'gecer', 'gecmez']);
export const CHECK_LABEL = Object.freeze({ gorsel: 'Görsel Kontrol', gecer: 'Geçer Mastarlar', gecmez: 'Geçmez Mastarlar' });

const pad = (n) => String(n).padStart(2, '0');

/** Bir anı en yakın yarım saat sütununa yuvarlar (yerel saat): 10:12 → 10:00, 10:20 → 10:30. */
export function slotOf(ms) {
  const d = new Date(ms);
  const total = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  const minutes = Math.round(total / SLOT_MIN) * SLOT_MIN;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, minutes).getTime();
}

/**
 * Sütunun kâğıt formdaki yeri: form tarihi (formun BAŞLADIĞI gün: gece bloğu ertesi sabah 07:00'a kadar sürer) ve sütun sırası 0…47.
 * 07:30 → 0 · 19:00 → 23 (gündüz) · 19:30 → 24 · 07:00 (ertesi gün) → 47 (gece).
 */
export function slotPosition(slotMs) {
  const d = new Date(slotMs);
  const minutes = d.getHours() * 60 + d.getMinutes();
  const offset = minutes - FORM_START_MIN;
  const date = offset >= 0 ? dateKey(d) : addDays(dateKey(d), -1);
  const index = (offset >= 0 ? offset : 1440 + offset) / SLOT_MIN;
  return { date, index, block: index < 24 ? 'gunduz' : 'gece', label: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

/** "34,13" / "34.13" / 34.13 → sayı; boş → null; geçersiz → NaN. */
export function parseValue(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
  const t = String(raw).trim().replace(/\s+/g, '');
  if (t === '') return null;
  if (!/^[+-]?(\d+([.,]\d*)?|[.,]\d+)$/.test(t)) return NaN;
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

const num = (v, label) => {
  const n = parseValue(v);
  if (Number.isNaN(n)) throw new RangeError(`${label} sayı olmalı.`);
  return n;
};

/**
 * Ölçü planı (satır tanımları) doğrulaması. Her satır: {label, nominal?, lower?, upper?}; lower/upper NOMİNALE göre işaretli sapmadır
 * (ör. Ø34,2 −0,1/+0 → nominal 34,2, lower −0,1, upper 0). Sapma verilirse nominal gerekir; lower ≤ upper olmalı.
 * @returns {{label: string, nominal: number|null, lower: number|null, upper: number|null}[]}
 */
export function normalizePlan(rows) {
  if (!Array.isArray(rows)) throw new RangeError('Ölçü planı bir liste olmalı.');
  if (rows.length > MAX_ROWS) throw new RangeError(`En fazla ${MAX_ROWS} ölçü satırı tanımlanabilir.`);
  return rows.map((r, i) => {
    const label = String(r?.label ?? '').trim();
    if (label === '') throw new RangeError(`${i + 1}. satır: ölçü adı gerekli (ör. Ø34,2).`);
    if (label.length > 40) throw new RangeError(`${i + 1}. satır: ölçü adı en fazla 40 karakter olabilir.`);
    const nominal = num(r?.nominal, `${i + 1}. satır nominal`);
    const lower = num(r?.lower, `${i + 1}. satır alt sapma`);
    const upper = num(r?.upper, `${i + 1}. satır üst sapma`);
    if ((lower !== null || upper !== null) && nominal === null) throw new RangeError(`${i + 1}. satır: sapma yazılacaksa nominal değer de gerekli.`);
    if (lower !== null && upper !== null && lower > upper) {
      throw new RangeError(`${i + 1}. satır: alt sapma üst sapmadan büyük olamaz (alt sapmayı eksi işaretiyle yazın, ör. −0,1).`);
    }
    for (const [v, n] of [[nominal, 'nominal'], [lower, 'alt sapma'], [upper, 'üst sapma']]) {
      if (v !== null && Math.abs(v) > 1_000_000) throw new RangeError(`${i + 1}. satır: ${n} çok büyük.`);
    }
    return { label, nominal, lower, upper };
  });
}

/** Ölçülen değerin toleransa göre durumu: 'ok' | 'dusuk' | 'yuksek' | null (sınır tanımsız ya da değer yok). */
export function evaluate(row, value) {
  if (!row || value === null || value === undefined || !Number.isFinite(value) || row.nominal == null) return null;
  const eps = 1e-9;
  if (row.lower != null && value < row.nominal + row.lower - eps) return 'dusuk';
  if (row.upper != null && value > row.nominal + row.upper + eps) return 'yuksek';
  return row.lower == null && row.upper == null ? null : 'ok';
}

/** Satırın izin verilen aralığı: "34,1 – 34,2" için {min, max} (tanımsız uç null). */
export function limits(row) {
  if (!row || row.nominal == null) return { min: null, max: null };
  return { min: row.lower == null ? null : row.nominal + row.lower, max: row.upper == null ? null : row.nominal + row.upper };
}
