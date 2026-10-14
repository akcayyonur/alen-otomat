/**
 * Uygulama secimi (dashboard/apps.js): hangi rol hangi uygulamayi gorur. Yetkiyi sunucu verir (policy.js); burasi yalniz
 * hangi kullanicinin secim ekranini gorecegini belirler: birden cok uygulamasi olan secim ekranini, tek uygulamali dogrudan girer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APPS, appsFor } from '../dashboard/apps.js';

test('yonetici iki uygulamayi gorur (secim ekrani), izleyici yalniz Telemetri, operator yalniz Planlama (dogrudan girerler)', () => {
  assert.deepEqual(appsFor('admin').map((a) => a.key), ['telemetri', 'planlama']);
  assert.deepEqual(appsFor('viewer').map((a) => a.key), ['telemetri']);
  assert.deepEqual(appsFor('operator').map((a) => a.key), ['planlama']);
});

test('bilinmeyen ya da bos rol hicbir uygulama gormez', () => {
  for (const r of ['', undefined, null, 'root', 'ADMIN']) assert.deepEqual(appsFor(r), [], String(r));
});

test('her uygulamanin adresi var ve benzersiz; planlama yalniz yonetici', () => {
  assert.equal(new Set(APPS.map((a) => a.key)).size, APPS.length);
  assert.equal(new Set(APPS.map((a) => a.entry)).size, APPS.length);
  assert.ok(APPS.every((a) => /^#\//.test(a.entry)));
  assert.deepEqual(APPS.find((a) => a.key === 'planlama').roles, ['admin', 'operator']);
  assert.deepEqual(APPS.find((a) => a.key === 'telemetri').roles, ['admin', 'viewer'], 'operator telemetri uygulamasini gormez');
});
