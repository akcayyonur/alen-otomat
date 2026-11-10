/**
 * Planlama modülünün ortak alan doğrulayıcıları: `text`/`number`, `backend/planning/{planning,quality,price-studies}.js`'te
 * birebir aynı kopyalanmıştı (2026-11-02'de bulundu, tek yere toplandı). PlanningError fırlatır.
 */
import { PlanningError } from './errors.js';
import { parseDate } from './normalize.js';

/** Boş metin -> null, ayrıca uzunluk sınırı. */
export function text(value, label, max) {
  if (value === undefined || value === null) return null;
  const t = String(value).trim();
  if (t === '') return null;
  if (t.length > max) throw new PlanningError(`${label} en fazla ${max} karakter olabilir.`);
  return t;
}

/**
 * Boş -> null; sayı değilse ya da aralık dışındaysa hata. Varsayılan: 0 HARİÇ (eski davranışla AYNI, geriye
 * dönük uyumlu) — `allowZero: true` verilirse 0 da kabul edilir (bazı alanlar için 0 gerçek bir değerdir, ör.
 * "O.K. adedi"). `integer: true` tam sayı ister.
 *
 * Türkçe yazım: "." HER ZAMAN binlik ayracıdır (atılır), "," ondalık ayracıdır. Eskiden yalnız "," -> "."
 * çevriliyordu: "12.500" (on iki bin beş yüz, EYS.LS.018'den kopyalanan tipik bir tutar) virgülsüz olduğu için
 * ondalık sayılıp 12,5 olarak okunuyordu (1000 kat küçük, SESSİZCE) — bu hata ilk `quarantine.js`'in kendi,
 * ayrı parser'ında bulunup düzeltilmişti (2026-11-06); fields.js'teki bu PAYLAŞILAN fonksiyon aynı hatayı hâlâ
 * taşıyordu ve `measuring-devices.js`/`packing-specs.js`/`sample-tracking.js`/`price-studies.js`/`planning.js`'in
 * HEPSİ bunun üzerinden geçiyordu (2026-11-10, kod incelemesinde bulundu). Düzeltme artık burada, tek yerde;
 * `quarantine.js`'in kendi `intRequired`/`intOptional`/`decOptional` kopyaları kaldırılıp bu fonksiyona taşındı.
 */
export function number(value, label, { max, integer = false, allowZero = false } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim().replace(/\./g, '').replace(',', '.'));
  const kind = integer ? 'tam sayı' : 'sayı';
  const low = allowZero ? 0 : (integer ? 1 : 0); // sadece mesaj icin: "1 ile" (tam sayida 0 haric alt sinir) / "0 ile"
  const bad = !Number.isFinite(n) || (integer && !Number.isInteger(n)) || n > max || (allowZero ? n < 0 : n <= 0);
  if (bad) throw new PlanningError(`${label} ${low} ile ${max} arasında bir ${kind} olmalı.`);
  return n;
}

/** ms / 'yyyy-aa-gg' / 'gg.aa.yyyy' → yerel gece yarısı (ms) | null; geçersizse hata. */
export function day(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const ms = typeof value === 'number' ? value : parseDate(value);
  if (!Number.isFinite(ms)) throw new PlanningError(`${label} gg.aa.yyyy ya da yyyy-aa-gg olmalı.`);
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
