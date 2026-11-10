/**
 * Ortak alan doğrulayıcıları (fields.js): `text`/`number`/`day`. `number()`in Türkçe binlik/ondalık ayracı
 * düzeltmesi ve `allowZero`/`integer` seçenekleri burada doğrulanır (2026-11-10, kod incelemesinde bulundu —
 * bkz. fields.js'teki açıklama: eskiden "12.500" gibi binlik yazımlar 1000 kat küçük okunuyordu, SESSİZCE).
 *
 * Çalıştırma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { text, number, day } from './fields.js';

test('number: bos -> null', () => {
  assert.equal(number(undefined, 'X', { max: 10 }), null);
  assert.equal(number(null, 'X', { max: 10 }), null);
  assert.equal(number('', 'X', { max: 10 }), null);
});

test('number: varsayilan (allowZero yok) 0 ve negatifi reddeder, aralik disini reddeder', () => {
  assert.throws(() => number(0, 'Süre', { max: 100 }), /Süre/);
  assert.throws(() => number(-1, 'Süre', { max: 100 }), /Süre/);
  assert.throws(() => number(101, 'Süre', { max: 100 }), /Süre/);
  assert.equal(number(50, 'Süre', { max: 100 }), 50);
});

test('number: allowZero:true 0\'i kabul eder, negatifi hala reddeder', () => {
  assert.equal(number(0, 'O.K. adedi', { max: 100, allowZero: true }), 0);
  assert.throws(() => number(-1, 'O.K. adedi', { max: 100, allowZero: true }), /O\.K\. adedi/);
  assert.equal(number(100, 'O.K. adedi', { max: 100, allowZero: true }), 100);
});

test('number: integer:true tam sayi olmayani reddeder', () => {
  assert.throws(() => number(1.5, 'Adet', { max: 100, integer: true }), /Adet/);
  assert.equal(number(5, 'Adet', { max: 100, integer: true }), 5);
});

test('number: Turkce yazim — "." HER ZAMAN binlik ayracidir (virgulsuz de olsa), "," ondalik ayracidir', () => {
  assert.equal(number('12.500', 'Tutar', { max: 1_000_000, allowZero: true }), 12500, 'virgulsuz nokta binlik ayraci sayilmali, ondalik DEGIL');
  assert.equal(number('12.500,50', 'Tutar', { max: 1_000_000, allowZero: true }), 12500.5);
  assert.equal(number('1.500', 'Adet', { max: 1_000_000, integer: true, allowZero: true }), 1500);
  assert.equal(number('9,5', 'Kilo', { max: 1_000_000, allowZero: true }), 9.5, 'nokta yoksa virgul hala ondalik ayraci');
});

test('number: plain JS sayisi string ayristirmadan dogrudan kullanilir', () => {
  assert.equal(number(12.5, 'Kilo', { max: 100, allowZero: true }), 12.5);
});

test('text/day: degismedi (regresyon)', () => {
  assert.equal(text('  x  ', 'Ad', 10), 'x');
  assert.equal(text('', 'Ad', 10), null);
  assert.equal(day('10.11.2026', 'Tarih'), new Date(2026, 10, 10).getTime());
});
