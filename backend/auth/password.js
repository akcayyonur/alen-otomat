/**
 * Sifre saklama: Node'un gomulu `scrypt`'i (bagimlilik yok). Saklanan metin:
 *   scrypt$N$r$p$tuz(base64)$anahtar(base64)
 * Parametreler metnin icinde oldugundan ileride artirilabilir; eski kayitlar kendi parametreleriyle dogrulanir.
 */
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';

const N = 16_384;
const R = 8;
const P = 1;
const KEY_LEN = 32;

export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 200;

function derive(password, salt, n, r, p) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LEN, { N: n, r, p, maxmem: 256 * n * r }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** @returns {string|null} hata metni ya da null */
export function validatePassword(password) {
  if (typeof password !== 'string') return 'Şifre yok.';
  if (password.length < MIN_PASSWORD) return `Şifre en az ${MIN_PASSWORD} karakter olmalı.`;
  if (password.length > MAX_PASSWORD) return `Şifre en fazla ${MAX_PASSWORD} karakter olabilir.`;
  if (password.trim() === '') return 'Şifre yalnızca boşluktan oluşamaz.';
  return null;
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Bozuk/yabanci biçimli kayıtta sessizce false (asla özel durum fırlatmaz). */
export async function verifyPassword(password, stored) {
  try {
    const parts = String(stored ?? '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    // Parametre sınırları: bozuk kayıt sunucuyu belleğe boğmasın.
    if (!Number.isInteger(n) || n < 1024 || n > 1_048_576 || (n & (n - 1)) !== 0) return false;
    if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return false;
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    if (salt.length < 8 || expected.length !== KEY_LEN) return false;
    const actual = await derive(String(password ?? ''), salt, n, r, p);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
