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
  assert.equal(K('POST', '/api/production'), 'admin');
  assert.equal(K('GET', '/api/production/baska'), 'admin');
  assert.equal(K('POST', '/api/auth/logout'), 'viewer');
  assert.equal(K('POST', '/api/auth/password'), 'viewer');
});

test('admin: program kutuphanesi, tezgah programlari/klasorleri, aktarim, ayarlar, kullanicilar', () => {
  const adminUclar = [
    ['GET', '/api/library/config'], ['GET', '/api/library/programs'], ['POST', '/api/library/programs'],
    ['POST', '/api/library/programs/text'], ['GET', '/api/library/programs/1/versions/1'], ['GET', '/api/library/matrix'],
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
