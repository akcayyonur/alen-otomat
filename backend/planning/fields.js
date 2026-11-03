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

/** Boş -> null; sayı değilse ya da aralık dışındaysa hata. */
export function number(value, label, { max }) {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0 || n > max) throw new PlanningError(`${label} 0 ile ${max} arasında bir sayı olmalı.`);
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
