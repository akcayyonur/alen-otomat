/**
 * Model kapisi (fileTransfer.sendEnabled/deleteEnabled = false) MEKANIZMASI, gercek config/drivers.json'dan
 * BAGIMSIZ, sentetik bir surucu dosyasiyla sinanir. 2026-10-30'da 22TB icin gercek gonderme ACILDIKTAN sonra
 * (kullanici karari: kendi izole test klasorunde deneyecek) gercek config'te "sendEnabled:false" olan hicbir
 * model kalmadi - bu, sendPolicy/deletePolicy'nin ENGELLEME dalini gercek bir ornekle sinamayi imkansiz
 * kilardi. DRIVERS_FILE (MACHINES_FILE/FEATURES_FILE ile ayni desen) bunu cozer: yalniz bu test dosyasinda,
 * ayri surecte (node --test her dosyayi ayri surecte calistirir) sahte bir surucu yuklenir.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dizin = mkdtempSync(join(tmpdir(), 'drivers-gate-'));
const dosya = join(dizin, 'drivers.json');
writeFileSync(dosya, JSON.stringify({
  drivers: [{
    id: 'sahte-surucu',
    label: 'Sahte Sürücü',
    status: 'experimental',
    defaultModel: 'A',
    models: [
      { id: 'A', label: 'Model A (açık)', fileTransfer: { sendEnabled: true, deleteEnabled: true } },
      { id: 'B', label: 'Model B (kapalı)', fileTransfer: { sendEnabled: false, deleteEnabled: false, reason: 'Model B henüz doğrulanmadı.' } },
    ],
  }],
}));
process.env.DRIVERS_FILE = dosya;
test.after(() => rmSync(dizin, { recursive: true, force: true }));

const { getDriver, resolveModel } = await import('../shared/drivers.js');
const { sendPolicy, deletePolicy, UnsupportedError } = await import('./programs/machine-files.js');
const { kur, ekle } = await import('./programs/test/harness.js');

test('sendPolicy: sendEnabled=false olan model KAPALI, true olan ACIK', () => {
  const driver = getDriver('sahte-surucu');
  assert.ok(driver, 'sahte sürücü DRIVERS_FILE ile yüklendi');
  const acik = sendPolicy({ id: 'X', driverId: 'sahte-surucu', controllerModel: 'A' });
  const kapali = sendPolicy({ id: 'Y', driverId: 'sahte-surucu', controllerModel: 'B' });
  assert.equal(acik.allowed, true);
  assert.equal(kapali.allowed, false);
  assert.equal(kapali.model, 'Model B (kapalı)');
  assert.equal(kapali.reason, 'Model B henüz doğrulanmadı.');
});

test('deletePolicy: once sendPolicy kapisindan gecer (kapaliysa deleteEnabled bakilmaz)', () => {
  const kapali = deletePolicy({ id: 'Y', driverId: 'sahte-surucu', controllerModel: 'B' }, { deleteEnabled: true });
  assert.equal(kapali.allowed, false, 'gonderme kapaliyken deleteEnabled=true bile silmeyi acamaz');
  assert.match(kapali.reason, /Model B/, 'red nedeni yazma kapisindan geliyor (deleteReason degil)');
  const acik = deletePolicy({ id: 'X', driverId: 'sahte-surucu', controllerModel: 'A' }, { deleteEnabled: true });
  assert.equal(acik.allowed, true, 'yazma aciksa deleteEnabled bayragi gercekten etkili olur');
});

test('resolveModel: bilinmeyen id varsayilan modele duser', () => {
  const driver = getDriver('sahte-surucu');
  assert.equal(resolveModel(driver, 'YOK').id, 'A');
});

test('model kapisi (gercek entegrasyon): on kontrol engeller ve FTP\'ye HIC dokunmaz; gonderme reddedilir, tornaya yazilmaz', async () => {
  const t = await kur();
  try {
    t.machines[0].driverId = 'sahte-surucu';
    t.machines[0].controllerModel = 'B'; // sendEnabled:false
    const { program } = ekle(t.library, 'AA', 'ORNEK-013');
    const once = t.server.commands.length;

    const pre = await t.files.precheck({ machineId: t.machines[0].id, programId: program.id, customer: 'AA' });
    assert.equal(pre.canSend, false);
    const engel = pre.checks.find((k) => k.level === 'block');
    assert.equal(engel.id, 'model');
    assert.match(engel.title, /Model B.*gönderme kapalı/);
    assert.equal(t.server.commands.length, once, 'on kontrol FTP baglantisi bile acmadi');

    await assert.rejects(
      () => t.files.send({ machineId: t.machines[0].id, programId: program.id, customer: 'AA', confirm: t.machines[0].id }),
      (e) => e instanceof UnsupportedError && /Model B/.test(e.message),
    );
    assert.equal(t.server.commands.length, once, 'gonderme reddedildi: tornaya tek komut gitmedi');
    assert.equal(t.library.db.listTransfers({}).length, 0, 'reddedilen model engeli aktarim kaydi acmaz');
  } finally {
    await t.kapat();
  }
});
