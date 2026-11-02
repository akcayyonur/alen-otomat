/**
 * Izin tablosu (policy.js): kim hangi ucu cagirabilir. Kural "varsayilan reddet": listede olmayan her /api yolu admin.
 * Esnek rol sisteminde (2026-10-30) classify() cogu /api/planning/* yolu icin bir rol adi degil {screen, level}
 * ciftini doner (shared/screens.js'teki ekran id'si + 'read'|'write'); http.js bunu req.user.grants'a gore degerlendirir.
 * Bu test, her ekranin TAM OLARAK hangi uclari actigini sabitler: yeni bir uc eklenince yanlislikla baska ekrana acilmaz.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, redactMachine, redactSnapshot, redactDetail, SCREEN_ROUTES } from './policy.js';
import { screenById, SCREEN_IDS } from '../../shared/screens.js';

const K = (m, p) => classify(m, p);
/** Belirli bir ekrana/seviyeye duser mi? */
const S = (m, p, screen, level) => assert.deepEqual(K(m, p), { screen, level }, `${m} ${p}`);

test('public: statik dosyalar, oturum durumu, giris/kurulum, saglik', () => {
  for (const p of ['/', '/app.js', '/styles.css', '/auth-view.js', '/bilinmeyen-yol']) assert.equal(K('GET', p), 'public', p);
  assert.equal(K('GET', '/api/session'), 'public');
  assert.equal(K('POST', '/api/auth/login'), 'public');
  assert.equal(K('POST', '/api/auth/setup'), 'public');
  assert.equal(K('GET', '/api/health'), 'public');
});

test('local: yalniz ajanin kullandigi uclar (sunucu bilgisayarindan)', () => {
  assert.equal(K('POST', '/api/ingest'), 'local');
  assert.equal(K('GET', '/api/agent/machines'), 'local');
  // ayni yollar baska yontemle local DEGIL (varsayilan admin)
  assert.equal(K('GET', '/api/ingest'), 'admin');
  assert.equal(K('POST', '/api/agent/machines'), 'admin');
});

test('viewer: giris yapmis HERKESE acik temel izleme (ekran yetkisine bagli degil)', () => {
  assert.equal(K('GET', '/api/stream'), 'viewer');
  assert.equal(K('GET', '/api/machines'), 'viewer');
  for (const alt of ['', '/history', '/spans', '/summary', '/downtimes', '/export.csv']) {
    assert.equal(K('GET', `/api/machines/CNC-01${alt}`), 'viewer', alt || 'ayrinti');
  }
  assert.equal(K('GET', '/api/machines/CNC%2001/history'), 'viewer');
  assert.equal(K('GET', '/api/production'), 'viewer');
  assert.equal(K('GET', '/api/production/export.csv'), 'viewer');
  assert.equal(K('GET', '/api/production/runs'), 'viewer');
  assert.equal(K('GET', '/api/production/runs.csv'), 'viewer');
  assert.equal(K('GET', '/api/planning/summary'), 'viewer');
  assert.equal(K('POST', '/api/production/runs'), 'admin');
  assert.equal(K('POST', '/api/production'), 'admin');
  assert.equal(K('GET', '/api/production/baska'), 'admin');
  assert.equal(K('POST', '/api/planning/summary'), 'admin');
  assert.equal(K('POST', '/api/auth/logout'), 'viewer');
  assert.equal(K('POST', '/api/auth/password'), 'viewer');
});

test('yapisal: SCREEN_ROUTES yalniz gecerli ekran id\'lerini kullanir; writable:false ekranda ASLA write rotasi yok', () => {
  for (const [, , screen, level] of SCREEN_ROUTES) {
    const s = screenById(screen);
    assert.ok(s, `bilinmeyen ekran: ${screen}`);
    assert.ok(level === 'read' || level === 'write', `${screen}: gecersiz seviye ${level}`);
    if (level === 'write') assert.ok(s.writable, `${screen} writable:false ama bir 'write' rotasi var`);
  }
  // isemirleri ve olcuraporlari HER ZAMAN salt okunur: shared/screens.js'te de writable:false olmali
  assert.equal(screenById('isemirleri').writable, false);
  assert.equal(screenById('olcuraporlari').writable, false);
  // her SCREENS girdisi en az bir yerde (rota ya da 'telemetri' app'i) kullanilir
  assert.ok(SCREEN_IDS.includes('telemetri') && SCREEN_IDS.includes('fiyat'));
});

test('ekran: tezgah basi (fabrika PC\'si) - baslat/bitir/tezgah duzelt, durus, kasa/kart, olcu kontrolu', () => {
  for (const [m, p] of [
    ['POST', '/api/planning/work-orders/2026001055/start'], ['POST', '/api/planning/work-orders/2026001055/finish'],
    ['POST', '/api/planning/shop/downtime-reasons'], ['DELETE', '/api/planning/shop/downtime-reasons/17'],
    ['POST', '/api/planning/work-orders/2026001055/crates'], ['POST', '/api/planning/work-orders/2026001055/cards'],
    ['POST', '/api/planning/work-orders/2026001055/fields'], ['PUT', '/api/planning/work-orders/2026001055/measure-plan'],
    ['POST', '/api/planning/work-orders/2026001055/measurements'],
    ['POST', '/api/planning/crates/7/close'], ['POST', '/api/planning/crates/7/void'],
  ]) S(m, p, 'tezgahbasi', 'write');
  for (const [m, p] of [
    ['GET', '/api/planning/downtime-codes'], ['GET', '/api/planning/shop/overview'], ['GET', '/api/planning/shop/stops'],
    ['GET', '/api/planning/crates'], ['GET', '/api/planning/crates/7'], ['GET', '/api/planning/crates/7/sheet'],
    ['GET', '/api/planning/work-orders/2026001055/measurements'],
  ]) S(m, p, 'tezgahbasi', 'read');
  // benzer ama farkli: admin (kayitsiz)
  for (const [m, p] of [
    ['PUT', '/api/planning/shop/downtime-reasons'], ['DELETE', '/api/planning/shop/downtime-reasons/abc'],
    ['PUT', '/api/planning/crates/sequence'], ['GET', '/api/planning/crates/abc'], ['DELETE', '/api/planning/crates/7'],
  ]) assert.equal(K(m, p), 'admin', `${m} ${p}`);
  S('POST', '/api/planning/crates/7/pack', 'paketleme', 'write'); // kesin paketleme adedi: paketleme ekranina ait, tezgahbasi'na DEGIL
});

test('ekran: paketleme formu (EYS.FR.007)', () => {
  for (const [m, p] of [['GET', '/api/planning/packing/sheet'], ['GET', '/api/planning/packing/suggest'], ['GET', '/api/planning/product-files/9']]) {
    S(m, p, 'paketleme', 'read');
  }
  for (const [m, p] of [
    ['PUT', '/api/planning/packing/sheet/air'], ['POST', '/api/planning/packing/rows'], ['PUT', '/api/planning/packing/rows/5'],
    ['DELETE', '/api/planning/packing/rows/5'], ['POST', '/api/planning/crates/7/pack'],
  ]) S(m, p, 'paketleme', 'write');
  assert.equal(K('DELETE', '/api/planning/product-files/9'), 'admin', 'klasor eslestirme/dosya kaldirma yonetici');
});

test('ekran: is emirleri - HER ZAMAN salt okunur, hic yazma rotasi yok', () => {
  for (const [m, p] of [
    ['GET', '/api/planning/work-orders'], ['GET', '/api/planning/work-orders/2026001055'],
    ['GET', '/api/planning/work-orders/2026001055/drawings.pdf'], ['GET', '/api/planning/work-orders/2026001055/print.pdf'],
  ]) S(m, p, 'isemirleri', 'read');
  // olusturma/duzenleme/iptal/geri alma/numara/tezgah duzeltme: kayitsiz -> admin (is emirleri "Yazabilir" olamaz kurali boylece yapisal)
  for (const [m, p] of [
    ['POST', '/api/planning/work-orders'], ['PUT', '/api/planning/work-orders/2026001055'],
    ['POST', '/api/planning/work-orders/2026001055/cancel'], ['POST', '/api/planning/work-orders/2026001055/reopen'],
    ['POST', '/api/planning/work-orders/2026001055/finish-manual'], ['POST', '/api/planning/work-orders/2026001055/reassign-machine'],
    ['GET', '/api/planning/work-orders/next'], ['PUT', '/api/planning/work-orders/sequence'],
  ]) assert.equal(K(m, p), 'admin', `${m} ${p}`);
});

test('ekran: GKK rapor no / ilk onay raporu - okuma herkese, usta numara ALABILIR; duzelt/sil/taban yonetici', () => {
  S('GET', '/api/planning/gkk', 'gkk', 'read');
  S('POST', '/api/planning/gkk', 'gkk', 'write');
  S('GET', '/api/planning/first-approvals', 'ilkonay', 'read');
  S('POST', '/api/planning/first-approvals', 'ilkonay', 'write');
  for (const [m, p] of [
    ['PUT', '/api/planning/gkk/5'], ['DELETE', '/api/planning/gkk/5'], ['PUT', '/api/planning/gkk/sequence'], ['GET', '/api/planning/gkk/5'],
    ['PUT', '/api/planning/first-approvals/5'], ['DELETE', '/api/planning/first-approvals/5'], ['PUT', '/api/planning/first-approvals/sequence'], ['GET', '/api/planning/first-approvals/5'],
  ]) assert.equal(K(m, p), 'admin', `${m} ${p}`);
});

test('ekran: olcu raporlari - HER ZAMAN salt okunur (girisler tezgah basindan)', () => {
  S('GET', '/api/planning/measure-reports', 'olcuraporlari', 'read');
  S('GET', '/api/planning/work-orders/2026001055/measure-report', 'olcuraporlari', 'read');
  assert.equal(K('GET', '/api/planning/measure-reports/1'), 'admin');
});

test('ekran: program eslemesi - okuma + dar urun aramasi + esle/kaldir/onayla', () => {
  for (const [m, p] of [['GET', '/api/planning/programs'], ['GET', '/api/planning/programs/product-search']]) S(m, p, 'programlar', 'read');
  for (const [m, p] of [['PUT', '/api/planning/programs/map'], ['DELETE', '/api/planning/programs/map'], ['POST', '/api/planning/programs/confirm-exact']]) {
    S(m, p, 'programlar', 'write');
  }
  for (const [m, p] of [['POST', '/api/planning/programs'], ['GET', '/api/planning/programs/map'], ['PUT', '/api/planning/programs/product-search']]) {
    assert.equal(K(m, p), 'admin', `${m} ${p}`);
  }
});

test('ekran: urun kartlari / siparisler / hammadde / verimlilik / cizelgeleme / fiyat - admin-disi rollere ACILABILIR', () => {
  S('GET', '/api/planning/products', 'urunler', 'read');
  S('POST', '/api/planning/products', 'urunler', 'write');
  S('GET', '/api/planning/products/SR001.013', 'urunler', 'read');
  S('PUT', '/api/planning/products/SR001.013', 'urunler', 'write');
  S('PUT', '/api/planning/products/SR001.013/measure-plan', 'urunler', 'write');
  S('GET', '/api/planning/orders', 'siparisler', 'read');
  S('GET', '/api/planning/orders/lines', 'siparisler', 'read');
  S('GET', '/api/planning/material/need', 'hammadde', 'read');
  S('GET', '/api/planning/material/consumption', 'hammadde', 'read');
  S('GET', '/api/planning/material/mikro/depots', 'hammadde', 'read');
  S('POST', '/api/planning/material/mikro/transfer-preview', 'hammadde', 'read');
  S('POST', '/api/planning/material/fis', 'hammadde', 'write');
  S('POST', '/api/planning/material/fis/undo', 'hammadde', 'write');
  S('POST', '/api/planning/material/mikro/transfer-send', 'hammadde', 'write');
  S('POST', '/api/planning/material/mikro/virman-send', 'hammadde', 'write');
  S('GET', '/api/planning/efficiency', 'verimlilik', 'read');
  S('GET', '/api/planning/efficiency.csv', 'verimlilik', 'read');
  S('GET', '/api/planning/downtime-report', 'verimlilik', 'read');
  S('POST', '/api/planning/schedule/suggest', 'cizelgeleme', 'read');
  S('POST', '/api/planning/schedule/apply', 'cizelgeleme', 'write');
  S('GET', '/api/planning/price-studies', 'fiyat', 'read');
  S('GET', '/api/planning/price-studies/3', 'fiyat', 'read');
  S('GET', '/api/planning/price-studies/3/drawing.pdf', 'fiyat', 'read');
  S('PUT', '/api/planning/price-studies/3/fill', 'fiyat', 'write');
  // olusturma/silme (teknik resim yukleme) her zaman admin: 'fiyat' ekranina kayitli degil
  assert.equal(K('POST', '/api/planning/price-studies'), 'admin');
  assert.equal(K('DELETE', '/api/planning/price-studies/3'), 'admin');
  // ice aktarma / kaynak klasoru / Mikro durum / sources yalniz yonetici (bu ekranlarin hicbirine kayitli degil)
  for (const [m, p] of [['POST', '/api/planning/import'], ['GET', '/api/planning/sources'], ['POST', '/api/planning/sources/refresh'], ['GET', '/api/planning/mikro']]) {
    assert.equal(K(m, p), 'admin', `${m} ${p}`);
  }
});

test('admin: program kutuphanesi, tezgah programlari/klasorleri, aktarim, ayarlar, kullanicilar/roller', () => {
  const adminUclar = [
    ['GET', '/api/library/config'], ['GET', '/api/library/programs'], ['POST', '/api/library/programs'],
    ['POST', '/api/library/programs/text'], ['GET', '/api/library/programs/1/versions/1'], ['GET', '/api/library/matrix'],
    ['POST', '/api/library/programs/delete'], ['GET', '/api/library/log'],
    ['GET', '/api/machines/CNC-01/programs'], ['POST', '/api/machines/CNC-01/programs/scan'],
    ['POST', '/api/machines/CNC-01/programs/import'], ['POST', '/api/machines/CNC-01/folders'],
    ['POST', '/api/transfers'], ['POST', '/api/transfers/precheck'], ['GET', '/api/transfers'],
    ['GET', '/api/config'], ['PUT', '/api/config/machines'], ['GET', '/api/drivers'],
    ['GET', '/api/users'], ['POST', '/api/users'], ['DELETE', '/api/users/3'], ['PUT', '/api/users/3/password'],
    ['GET', '/api/roles'], ['POST', '/api/roles'], ['PUT', '/api/roles/1'], ['DELETE', '/api/roles/1'],
    ['GET', '/api/auth/audit'],
    ['POST', '/api/machines/CNC-01/programs/import-plan'], ['GET', '/api/machines/CNC-01/programs/import-plan/abc123'],
    ['GET', '/api/machines/CNC-01/programs/import-plan/abc123/diff'], ['POST', '/api/machines/CNC-01/programs/import-apply'],
    ['POST', '/api/machines/CNC-01/programs/delete-precheck'], ['POST', '/api/machines/CNC-01/programs/delete'],
    ['POST', '/api/machines/CNC-01/programs/push-plan'], ['GET', '/api/machines/CNC-01/programs/push-plan/abc123'],
    ['POST', '/api/machines/CNC-01/programs/push-apply'], ['POST', '/api/machines/CNC-01/programs/push-stop'],
    ['GET', '/api/library/backups/1'], ['POST', '/api/library/backups/1/restore'],
  ];
  for (const [m, p] of adminUclar) assert.equal(K(m, p), 'admin', `${m} ${p}`);
});

test('varsayilan reddet: bilinmeyen /api yollari, buyuk/kucuk harf ve yol kandirmalari admin', () => {
  for (const p of ['/api/yeni-bir-uc', '/api/', '/api', '/API/library/config', '/Api/Machines', '/api/machines/CNC-01/programs/', '/api/machines/CNC-01/history/x', '/api/machines/a/b/c']) {
    assert.equal(K('GET', p), 'admin', p);
  }
  // viewer ucunun YONTEMI degisirse admin
  for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal(K(m, '/api/machines'), 'admin', m);
  assert.equal(K('DELETE', '/api/machines/CNC-01'), 'admin');
  // yol gezinmesi: tezgah kimligi / icermez
  assert.equal(K('GET', '/api/machines/../library/config'), 'admin');
});

test('viewer verisi suzulur: IP/port gibi ic ag bilgisi cikarilir, geri kalani aynen kalir', () => {
  const m = { machineId: 'CNC-01', name: 'Torna 1', ip: '192.168.88.91', ftpPort: 21, port: 5566, state: 'RUNNING', telemetry: { partCount: 5 } };
  const r = redactMachine(m);
  assert.deepEqual(r, { machineId: 'CNC-01', name: 'Torna 1', state: 'RUNNING', telemetry: { partCount: 5 } });
  assert.equal(m.ip, '192.168.88.91', 'orijinal degismez (admin ayni nesneyi kullaniyor)');

  const snap = redactSnapshot({ counts: { RUNNING: 1 }, machines: [m] });
  assert.equal(snap.machines[0].ip, undefined);
  assert.deepEqual(snap.counts, { RUNNING: 1 });

  const det = redactDetail({ machine: m, live: [1, 2], summary: { a: 1 } });
  assert.equal(det.machine.ip, undefined);
  assert.deepEqual(det.live, [1, 2]);
  assert.equal(redactDetail(undefined), undefined);
  assert.equal(redactMachine(null), null);
});
