/**
 * Uygulama secimi (dashboard/apps.js): hangi rol hangi uygulamayi gorur. Yetkiyi sunucu verir (policy.js); burasi yalniz
 * hangi kullanicinin secim ekranini gorecegini belirler: birden cok uygulamasi olan secim ekranini, tek uygulamali dogrudan girer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APPS, appsFor } from '../dashboard/apps.js';
import { TAB_ROLES, tabsForRole, defaultTabFor } from '../dashboard/planning-tabs.js';

test('yonetici ve izleyici iki uygulamayi gorur (secim ekrani), operator yalniz Planlama (dogrudan girer)', () => {
  assert.deepEqual(appsFor('admin').map((a) => a.key), ['telemetri', 'planlama']);
  assert.deepEqual(appsFor('viewer').map((a) => a.key), ['telemetri', 'planlama'], 'izleyici planlamada da YALNIZ okur (sunucu zorlar)');
  assert.deepEqual(appsFor('operator').map((a) => a.key), ['planlama']);
});

test('bilinmeyen ya da bos rol hicbir uygulama gormez', () => {
  for (const r of ['', undefined, null, 'root', 'ADMIN']) assert.deepEqual(appsFor(r), [], String(r));
});

test('her uygulamanin adresi var ve benzersiz; planlama operator ve izleyiciye de acik', () => {
  assert.equal(new Set(APPS.map((a) => a.key)).size, APPS.length);
  assert.equal(new Set(APPS.map((a) => a.entry)).size, APPS.length);
  assert.ok(APPS.every((a) => /^#\//.test(a.entry)));
  assert.deepEqual(APPS.find((a) => a.key === 'planlama').roles, ['admin', 'operator', 'viewer']);
  assert.deepEqual(APPS.find((a) => a.key === 'telemetri').roles, ['admin', 'viewer'], 'operator telemetri uygulamasini gormez');
});

test('planlama sekmeleri: izleyici yalniz okunan bolumleri gorur, operator fabrika PC\'sinin bolumlerini, yonetici hepsini', () => {
  assert.deepEqual(tabsForRole('viewer'), ['tezgahbasi', 'isemirleri', 'gkk', 'ilkonay', 'olcuraporlari']);
  assert.deepEqual(tabsForRole('operator'), ['tezgahbasi', 'paketleme', 'isemirleri', 'gkk', 'ilkonay', 'olcuraporlari', 'programlar']);
  assert.equal(tabsForRole('admin').length, 11, 'yonetici her sekmeyi gorur');
  assert.deepEqual(tabsForRole('admin').slice(0, 3), ['tezgahbasi', 'paketleme', 'isemirleri']);
  for (const gizli of ['paketleme', 'verimlilik', 'hammadde', 'urunler', 'siparisler', 'programlar']) {
    assert.ok(!tabsForRole('viewer').includes(gizli), `izleyici ${gizli} sekmesini gormez`);
  }
  for (const r of ['', undefined, null, 'root', 'ADMIN']) assert.deepEqual(tabsForRole(r), [], String(r));
  // acilis sekmesi: yonetici is emirleri; diger roller tezgah basi (kendi gorebildiklerinden biri olmali)
  for (const r of ['admin', 'operator', 'viewer']) assert.ok(tabsForRole(r).includes(defaultTabFor(r)), `${r} acilis sekmesini gorebilmeli`);
  assert.equal(defaultTabFor('admin'), 'isemirleri');
  assert.equal(defaultTabFor('viewer'), 'tezgahbasi');
  // her sekmenin rol listesi gecerli rollerden olusur
  for (const [k, roles] of Object.entries(TAB_ROLES)) assert.ok(roles.length > 0 && roles.every((r) => ['admin', 'operator', 'viewer'].includes(r)), k);
});
