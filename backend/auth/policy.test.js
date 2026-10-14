/**
 * Izin tablosu (policy.js): kim hangi ucu cagirabilir. Kural "varsayilan reddet": listede olmayan her /api yolu admin.
 * Bu test, viewer'in gorebilecegi seyi TAM olarak sabitler; yeni bir uc eklenince yanlislikla viewer'a acilmaz.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, redactMachine, redactSnapshot, redactDetail } from './policy.js';

const K = (m, p) => classify(m, p);

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

test('viewer: yalniz izleme uclari', () => {
  assert.equal(K('GET', '/api/stream'), 'viewer');
  assert.equal(K('GET', '/api/machines'), 'viewer');
  for (const alt of ['', '/history', '/spans', '/summary', '/downtimes', '/export.csv']) {
    assert.equal(K('GET', `/api/machines/CNC-01${alt}`), 'viewer', alt || 'ayrinti');
  }
  assert.equal(K('GET', '/api/machines/CNC%2001/history'), 'viewer');
  // uretim raporu (vardiya adetleri) izleme verisidir; baska yontem / alt yol viewer'a acilmaz
  assert.equal(K('GET', '/api/production'), 'viewer');
  assert.equal(K('GET', '/api/production/export.csv'), 'viewer');
  assert.equal(K('GET', '/api/production/runs'), 'viewer');
  assert.equal(K('GET', '/api/production/runs.csv'), 'viewer');
  assert.equal(K('POST', '/api/production/runs'), 'admin');
  assert.equal(K('POST', '/api/production'), 'admin');
  assert.equal(K('GET', '/api/production/baska'), 'admin');
  assert.equal(K('POST', '/api/auth/logout'), 'viewer');
  assert.equal(K('POST', '/api/auth/password'), 'viewer');
});

test('admin: program kutuphanesi, tezgah programlari/klasorleri, aktarim, ayarlar, kullanicilar', () => {
  const adminUclar = [
    ['GET', '/api/library/config'], ['GET', '/api/library/programs'], ['POST', '/api/library/programs'],
    ['POST', '/api/library/programs/text'], ['GET', '/api/library/programs/1/versions/1'], ['GET', '/api/library/matrix'],
    ['POST', '/api/library/programs/delete'], ['GET', '/api/library/log'],
    ['GET', '/api/machines/CNC-01/programs'], ['POST', '/api/machines/CNC-01/programs/scan'],
    ['POST', '/api/machines/CNC-01/programs/import'], ['POST', '/api/machines/CNC-01/folders'],
    ['POST', '/api/transfers'], ['POST', '/api/transfers/precheck'], ['GET', '/api/transfers'],
    ['GET', '/api/config'], ['PUT', '/api/config/machines'], ['GET', '/api/drivers'],
    ['GET', '/api/users'], ['POST', '/api/users'], ['DELETE', '/api/users/3'], ['PUT', '/api/users/3/password'],
    ['GET', '/api/auth/audit'],
    // toplu iceri alma ve tornadan silme
    ['POST', '/api/machines/CNC-01/programs/import-plan'], ['GET', '/api/machines/CNC-01/programs/import-plan/abc123'],
    ['GET', '/api/machines/CNC-01/programs/import-plan/abc123/diff'], ['POST', '/api/machines/CNC-01/programs/import-apply'],
    ['POST', '/api/machines/CNC-01/programs/delete-precheck'], ['POST', '/api/machines/CNC-01/programs/delete'],
    // planlama (urun kartlari, siparisler, program eslemesi): yalniz yonetici
    ['GET', '/api/planning/products'], ['POST', '/api/planning/products'],
    ['GET', '/api/planning/products/SR001.013'], ['PUT', '/api/planning/products/SR001.013'], ['POST', '/api/planning/import'],
    ['GET', '/api/planning/orders'], ['GET', '/api/planning/orders/lines'], ['GET', '/api/planning/programs'],
    ['PUT', '/api/planning/programs/map'], ['DELETE', '/api/planning/programs/map'], ['POST', '/api/planning/programs/confirm-exact'],
    ['POST', '/api/planning/work-orders'], ['GET', '/api/planning/work-orders/next'],
    ['PUT', '/api/planning/work-orders/sequence'], ['PUT', '/api/planning/work-orders/2026001055'],
    ['POST', '/api/planning/work-orders/2026001055/cancel'], ['POST', '/api/planning/work-orders/2026001055/reopen'],
    // hammadde ve sarfiyat (D): yalniz yonetici (operator ve viewer goremez)
    ['GET', '/api/planning/material/need'], ['GET', '/api/planning/material/consumption'], ['GET', '/api/planning/material/consumption.csv'],
    ['POST', '/api/planning/material/fis'], ['POST', '/api/planning/material/fis/undo'],
    // verimlilik ve durus raporlari (E): yalniz yonetici
    ['GET', '/api/planning/efficiency'], ['GET', '/api/planning/efficiency.csv'], ['GET', '/api/planning/downtime-report'], ['GET', '/api/planning/downtime-report.csv'],
  ];
  for (const [m, p] of adminUclar) assert.equal(K(m, p), 'admin', `${m} ${p}`);
});

test('operator: fabrika PC\'sinin ortak hesabi YALNIZ is emri baslat/bitir, durus nedeni ve okuma uclarini kullanir', () => {
  const operatorUclar = [
    ['GET', '/api/planning/summary'], ['GET', '/api/planning/work-orders'], ['GET', '/api/planning/work-orders/2026001055'],
    ['POST', '/api/planning/work-orders/2026001055/start'], ['POST', '/api/planning/work-orders/2026001055/finish'],
    ['GET', '/api/planning/downtime-codes'], ['GET', '/api/planning/shop/overview'], ['GET', '/api/planning/shop/stops'],
    ['POST', '/api/planning/shop/downtime-reasons'], ['DELETE', '/api/planning/shop/downtime-reasons/17'],
    ['GET', '/api/planning/crates'], ['GET', '/api/planning/crates/7'], ['POST', '/api/planning/work-orders/2026001055/crates'],
    ['POST', '/api/planning/work-orders/2026001055/cards'], ['POST', '/api/planning/work-orders/2026001055/fields'],
    ['GET', '/api/planning/work-orders/2026001055/measurements'], ['PUT', '/api/planning/work-orders/2026001055/measure-plan'],
    ['POST', '/api/planning/work-orders/2026001055/measurements'], ['GET', '/api/planning/crates/7/sheet'],
    ['POST', '/api/planning/crates/7/close'], ['POST', '/api/planning/crates/7/pack'], ['POST', '/api/planning/crates/7/void'],
  ];
  for (const [m, p] of operatorUclar) assert.equal(K(m, p), 'operator', `${m} ${p}`);
  // benzer ama farkli yontem / yol / numara bicimi operator'a ACILMAZ (varsayilan reddet: admin)
  for (const [m, p] of [
    ['PUT', '/api/planning/work-orders/2026001055'], ['POST', '/api/planning/work-orders'], ['GET', '/api/planning/work-orders/next'],
    ['GET', '/api/planning/work-orders/123'], ['POST', '/api/planning/work-orders/2026001055/cancel'], ['POST', '/api/planning/work-orders/2026001055/reopen'],
    ['GET', '/api/planning/work-orders/2026001055/start'], ['PUT', '/api/planning/shop/downtime-reasons'], ['DELETE', '/api/planning/shop/downtime-reasons/abc'],
    ['GET', '/api/planning/shop/overview/x'], ['GET', '/api/planning/products'], ['GET', '/api/planning/orders'], ['POST', '/api/planning/import'],
    ['GET', '/api/planning/programs'], ['GET', '/API/planning/summary'],
    // kasalar: kart numarasi sirasi tabani yalniz yonetici; benzer ama farkli yol/yontem acilmaz
    ['PUT', '/api/planning/crates/sequence'], ['GET', '/api/planning/crates/abc'], ['DELETE', '/api/planning/crates/7'], ['POST', '/api/planning/crates/7/reopen'],
    ['POST', '/api/planning/crates/7'], ['GET', '/api/planning/crates/7/close'], ['POST', '/api/planning/work-orders/123/crates'], ['POST', '/api/planning/work-orders/123/cards'], ['GET', '/api/planning/work-orders/123/measurements'], ['POST', '/api/planning/crates/7/sheet'], ['DELETE', '/api/planning/work-orders/2026001055/measurements'], ['GET', '/api/planning/work-orders/2026001055/cards'], ['PUT', '/api/planning/work-orders/2026001055/crates'],
  ]) assert.equal(K(m, p), 'admin', `${m} ${p}`);
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
