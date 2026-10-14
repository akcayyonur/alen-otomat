/**
 * Planlama modulunun ortak metin / sayi / tarih yardimcilari.
 *
 * Excel'den "CSV" olarak kaydedilen dosyalar yerel ayara gore yazilir: ondalik ayirici VIRGUL, tarih 12.10.2026, ayirici
 * noktali virgul. Buradaki cozumleyiciler hem bu bicimi hem ISO/nokta-ondalik bicimini kabul eder.
 */

const TR_FOLD = Object.freeze({
  İ: 'I', I: 'I', ı: 'I', i: 'I', Ş: 'S', ş: 'S', Ğ: 'G', ğ: 'G', Ü: 'U', ü: 'U', Ö: 'O', ö: 'O', Ç: 'C', ç: 'C',
});

/**
 * Karsilastirma anahtari: Turkce harfler ASCII'ye, BUYUK harf, kenar bosluklari atilir.
 * "Nİ002.001" ile tornadaki "NI002-001" gibi adlar ayni anahtara dusebilsin diye (nokta/tire ayrimi ayri kuralla).
 */
export function foldTr(value) {
  return String(value ?? '')
    .replace(/ /g, ' ')
    .replace(/[İIıiŞşĞğÜüÖöÇç]/g, (c) => TR_FOLD[c])
    .toUpperCase()
    .trim();
}

/** Baslik anahtari: yalniz A-Z ve 0-9 ("Müşt.Sip.No" -> "MUSTSIPNO", "gün top" -> "GUNTOP"). */
export const headerKey = (value) => foldTr(value).replace(/[^A-Z0-9]/g, '');

/** Siparis no gibi serbest kodlar icin: bosluklar da atilir ("sas 123" = "SAS123"). */
export const looseKey = (value) => foldTr(value).replace(/\s+/g, '');

/** Excel'in sayi hucresinden yazdigi ".0" sonekini ve kenar bosluklarini temizler ("2400000001.0" -> "2400000001"). */
export function cleanCode(value) {
  const t = String(value ?? '').replace(/ /g, ' ').trim();
  return /^\d+[.,]0+$/.test(t) ? t.replace(/[.,]0+$/, '') : t;
}

/** Bilimsel gosterim ("6,01E+11"): 12 haneli kodlar Excel'de bu hale gelip DEGER KAYBEDER. */
export const isScientific = (value) => /^\s*[+-]?\d+([.,]\d+)?e[+-]?\d+\s*$/i.test(String(value ?? ''));

/**
 * Sayi cozumleme. Hata degerleri (#REF!, #DIV/0!) ve bos metin `null`. `integer`: "5.000" binlik ayiracidir.
 * @returns {number|null}
 */
export function parseNumber(raw, { integer = false } = {}) {
  let t = String(raw ?? '').replace(/[\s ]/g, '');
  if (t === '' || t.startsWith('#') || t === '-') return null;
  if (isScientific(t)) t = t.replace(',', '.');
  else if (t.includes(',') && t.includes('.')) {
    // Hangisi sondaysa ondaliktir; digeri binlik ayiracidir.
    t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (t.includes(',')) {
    t = t.replace(',', '.');
  } else if (integer && /^\d{1,3}(\.\d{3})+$/.test(t)) {
    t = t.replace(/\./g, '');
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Tarih cozumleme (yerel gece yarisi, epoch ms). Kabul: 2026-10-12 (saatli de), 12.10.2026, 12/10/2026, 12-10-2026.
 * Gecersiz tarih (30 Subat) ya da tanimsiz bicim `null`.
 * @returns {number|null}
 */
export function parseDate(raw) {
  const t = String(raw ?? '').trim();
  let y; let m; let d;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/.exec(t);
  if (r) [, y, m, d] = r;
  else if ((r = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:\s.*)?$/.exec(t))) [, d, m, y] = r;
  else return null;
  y = Number(y); m = Number(m); d = Number(d);
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt.getTime();
}
