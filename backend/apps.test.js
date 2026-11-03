/**
 * Uygulama secimi (dashboard/apps.js): hangi kullanici hangi uygulamayi gorur. Yetkiyi sunucu verir
 * (policy.js); burasi yalniz hangi kullanicinin secim ekranini gorecegini belirler: birden cok
 * uygulamasi olan secim ekranini, tek uygulamali dogrudan girer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APPS, appsFor } from '../dashboard/apps.js';
import { TAB_ORDER, tabsForUser, defaultTabFor } from '../dashboard/planning-tabs.js';
import { SCREENS as SHARED_SCREENS } from '../shared/screens.js';
import { SCREENS as DASH_SCREENS } from '../dashboard/screens.js';

const ADMIN = Object.freeze({ isAdmin: true });
/** Goc eslemesindeki (auth-db.js MIGRATED_ROLE_GRANTS) AYNI yetkiler. */
const OPERATOR = Object.freeze({ isAdmin: false, grants: { tezgahbasi: 'write', paketleme: 'write', isemirleri: 'read', gkk: 'read', ilkonay: 'write', olcuraporlari: 'read', programlar: 'write' } });
const VIEWER = Object.freeze({ isAdmin: false, grants: { telemetri: 'read', tezgahbasi: 'read', isemirleri: 'read', gkk: 'read', ilkonay: 'read', olcuraporlari: 'read' } });

test('dashboard/screens.js, shared/screens.js ile AYNI (tarayici shared/*.js cekemez, kopya elle senkron tutulur)', () => {
  assert.deepEqual(DASH_SCREENS, SHARED_SCREENS);
});

test('admin ve izleyici iki uygulamayi gorur (secim ekrani), operator yalniz Planlama (dogrudan girer)', () => {
  assert.deepEqual(appsFor(ADMIN).map((a) => a.key), ['telemetri', 'planlama']);
  assert.deepEqual(appsFor(VIEWER).map((a) => a.key), ['telemetri', 'planlama'], 'izleyici planlamada da YALNIZ okur (sunucu zorlar)');
  assert.deepEqual(appsFor(OPERATOR).map((a) => a.key), ['planlama'], 'operator telemetri grant\'ina sahip degil');
});

test('kullanicisiz / grants\'siz kullanici hicbir uygulama gormez', () => {
  for (const u of [null, undefined, { isAdmin: false }, { isAdmin: false, grants: {} }]) assert.deepEqual(appsFor(u), [], JSON.stringify(u));
});

test('her uygulamanin adresi var ve benzersiz', () => {
  assert.equal(new Set(APPS.map((a) => a.key)).size, APPS.length);
  assert.equal(new Set(APPS.map((a) => a.entry)).size, APPS.length);
  assert.ok(APPS.every((a) => /^#\//.test(a.entry)));
});

test('planlama sekmeleri: izleyici yalniz okunan bolumleri gorur, operator fabrika PC\'sinin bolumlerini, admin hepsini', () => {
  assert.deepEqual(tabsForUser(VIEWER), ['tezgahbasi', 'isemirleri', 'gkk', 'ilkonay', 'olcuraporlari']);
  assert.deepEqual(tabsForUser(OPERATOR), ['tezgahbasi', 'paketleme', 'isemirleri', 'gkk', 'ilkonay', 'olcuraporlari', 'programlar']);
  assert.equal(tabsForUser(ADMIN).length, 14, 'admin her sekmeyi gorur (fiyat, numune dahil)');
  assert.deepEqual(tabsForUser(ADMIN).slice(0, 3), ['tezgahbasi', 'paketleme', 'isemirleri']);
  assert.ok(tabsForUser(ADMIN).includes('fiyat'));
  for (const gizli of ['paketleme', 'verimlilik', 'cizelgeleme', 'hammadde', 'urunler', 'siparisler', 'programlar', 'fiyat']) {
    assert.ok(!tabsForUser(VIEWER).includes(gizli), `izleyici ${gizli} sekmesini gormez`);
  }
  for (const u of [null, undefined, {}]) assert.deepEqual(tabsForUser(u), [], JSON.stringify(u));
  // acilis sekmesi: admin is emirlerini, digerleri gorebildiklerinden ilkini gorur
  for (const u of [ADMIN, OPERATOR, VIEWER]) assert.ok(tabsForUser(u).includes(defaultTabFor(u)), 'acilis sekmesini gorebilmeli');
  assert.equal(defaultTabFor(ADMIN), 'isemirleri');
  assert.equal(defaultTabFor(VIEWER), 'tezgahbasi');
  // is emirleri ve olcu raporlari ekranlari HER ZAMAN TAB_ORDER'da (sekme listesinden hic cikarilmaz)
  assert.ok(TAB_ORDER.includes('isemirleri') && TAB_ORDER.includes('olcuraporlari') && TAB_ORDER.includes('fiyat'));
});
