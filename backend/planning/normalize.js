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

/**
 * Uyarilarda gosterilecek SATIR NUMARASI. `index`, `[headers, ...rows]` dizisindeki sira (0 = baslik). CSV'de bos satirlar atildigi icin
 * numara dizi sirasidir (index + 1); .xlsx'te Excel'deki gercek satir numarasi (`parsed.rowNumbers`) kullanilir.
 */
export const sheetRow = (parsed, index) => parsed.rowNumbers?.[index] ?? index + 1;

/** Baslik anahtari: yalniz A-Z ve 0-9 ("Müşt.Sip.No" -> "MUSTSIPNO", "gün top" -> "GUNTOP"). */
export const headerKey = (value) => foldTr(value).replace(/[^A-Z0-9]/g, '');

/** Siparis no gibi serbest kodlar icin: bosluklar da atilir ("sas 123" = "SAS123"). */
export const looseKey = (value) => foldTr(value).replace(/\s+/g, '');

/** Excel'in sayi hucresinden yazdigi ".0" sonekini ve kenar bosluklarini temizler ("2400000001.0" -> "2400000001"). */
export function cleanCode(value) {
  const t = String(value ?? '').replace(/ /g, ' ').trim();
  return /^\d+[.,]0+$/.test(t) ? t.replace(/[.,]0+$/, '') : t;
}

/**
 * MUSTERI URUN KODU = degerin ILK SOZCUGU (bosluga kadar): "140100188 1234-567" -> "140100188". Tire, nokta, alt cizgi kodun parcasidir
 * ("1234-567", "A123AB456-789" tek koddur); yalniz bosluktan sonrasi (cizim no, revizyon, aciklama) koda girmez.
 */
export function firstToken(value) {
  const t = String(value ?? '').replace(/ /g, ' ').trim();
  return t === '' ? '' : t.split(/\s+/)[0];
}

/**
 * Urun ADININ basindaki musteri urun kodu (Mikro urun adlari "140100188 DAİKİN 4P396838-2 SOMUN 5/8\"" diye baslar). Ilk sozcuk kod SAYILIR eger:
 * en az 5 rakam icerir ve yalniz harf/rakam/`-`/`.`/`_` karakterlerinden olusur. Olcu ve dis yazimlari ("1/2\"", "G1/2\"", "M10", "99,9/99") kod degildir:
 * tirnak, egik cizgi, virgul, parantez icerir ya da 5'ten az rakamlidir. Sondaki tire/nokta ayiraci kirpilir. Kod degilse null.
 * Gercek urun listesinde (499 urun) ilk sozcuk 466 urunde rakamli; "9999-999", "A999AA999-999" gibi tireli kodlar tek kod olarak alinir.
 */
export function customerCodeFromName(name) {
  const tok = firstToken(name).replace(/[-–.]+$/, '');
  if (tok === '' || tok.length > 40) return null;
  if (!/^[0-9A-Za-zÇĞİÖŞÜçğıöşü][0-9A-Za-zÇĞİÖŞÜçğıöşü._\-–]*$/.test(tok)) return null;
  return (tok.match(/\d/g) ?? []).length >= 5 ? tok : null;
}

/** Kayitli deger (ilk sozcuge indirilmis) yoksa urun adinin basindaki kod; ikisi de yoksa null. */
export const resolveCustomerCode = (stored, name) => firstToken(stored) || customerCodeFromName(name) || null;

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
