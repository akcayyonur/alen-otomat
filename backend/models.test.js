/**
 * Kontrolcu modeli (SYNTEC 11TB / 22TB): envanter, ajan listesi suzgeci ve gonderme politikasi.
 *
 * Neden onemli: iki model iki ayri Syntec paketi (ve ayri ajan sureci) ister. Bir 22TB tezgahin
 * 11TB ajanina (ya da tersine) verilmesi tezgahi sessizce okunamaz birakir; ve gercek tezgahta
 * hic denenmemis bir modele program GONDERMEK kapali olmali.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Envanter dosyasi modul yuklenirken okunur: gecici dosyayi ONCE ayarla, sonra iceri al.
const dizin = mkdtempSync(join(tmpdir(), 'cnc-model-'));
const dosya = join(dizin, 'machines.json');
writeFileSync(
  dosya,
  JSON.stringify({
    defaults: {
      driverId: 'syntec-remoteapi',
      controller: 'SYNTEC 11B',
      controllerPanel: 'SYNTEC 11TB',
      softwareVersion: '10.116.54S',
    },
    machines: [
      { id: 'CNC-A', name: 'A', ip: '10.0.0.1' }, // model secilmemis: varsayilan (11TB)
      { id: 'CNC-B', name: 'B', ip: '10.0.0.2', controllerModel: '11TB' },
      { id: 'CNC-C', name: 'C', ip: '10.0.0.3', controllerModel: '22TB' },
      { id: 'CNC-D', name: 'D', ip: null, controllerModel: '22TB' }, // IP yok: ajana verilmez
      { id: 'CNC-E', name: 'E', ip: '10.0.0.5', controllerModel: '22TB', softwareVersion: '10.118.99X' },
      { id: 'SIM-1', name: 'S', ip: '10.0.0.6', driverId: 'simulator' },
    ],
  }),
);
process.env.MACHINES_FILE = dosya;

const { loadInventory, validateMachines, agentMachines } = await import('../shared/inventory.js');
const { getDriver, resolveModel } = await import('../shared/drivers.js');
const { kur, ekle } = await import('./programs/test/harness.js');
const { sendPolicy, UnsupportedError } = await import('./programs/machine-files.js');

test.after(() => rmSync(dizin, { recursive: true, force: true }));

const by = (liste, id) => liste.find((m) => m.id === id);

/* ------------------------------------------------------------- surucu kaydi */

test('surucu kaydi: Syntec surucusunun iki modeli var, 22TB gonderme kapali', () => {
  const d = getDriver('syntec-remoteapi');
  assert.deepEqual(d.models.map((m) => m.id), ['11TB', '22TB']);
  assert.equal(d.defaultModel, '11TB');
  assert.equal(by(d.models, '11TB').clientDll, 'Syntec.RemoteCNC.Win32.dll');
  assert.equal(by(d.models, '22TB').clientDll, 'Syntec.OpenCNC.dll');
  assert.equal(by(d.models, '22TB').status, 'experimental', '22TB gercek tezgahta denenmedi: supported olamaz');
  assert.equal(by(d.models, '22TB').fileTransfer.sendEnabled, false);
  assert.notEqual(by(d.models, '11TB').fileTransfer.sendEnabled, false);
  assert.deepEqual(getDriver('simulator').models, [], 'modeli olmayan surucu: bos liste');
});

test('resolveModel: bos ya da bilinmeyen id surucunun varsayilanina duser', () => {
  const d = getDriver('syntec-remoteapi');
  assert.equal(resolveModel(d, '22TB').id, '22TB');
  assert.equal(resolveModel(d, undefined).id, '11TB');
  assert.equal(resolveModel(d, 'YOK').id, '11TB');
  assert.equal(resolveModel(getDriver('simulator'), '22TB'), null);
});

/* ----------------------------------------------------------------- envanter */

test('envanter: model secilmemisse varsayilan 11TB ve defaults aynen gecerli', () => {
  const inv = loadInventory();
  const a = by(inv, 'CNC-A');
  assert.equal(a.controllerModel, '11TB');
  assert.equal(a.controllerModelLabel, 'SYNTEC 11TB');
  assert.equal(a.controller, 'SYNTEC 11B');
  assert.equal(a.softwareVersion, '10.116.54S');
});

test('envanter: 22TB secilince kontrolcu/panel/yazilim kimligi modelden gelir, tezgahin kendi degeri onceliklidir', () => {
  const inv = loadInventory();
  const c = by(inv, 'CNC-C');
  assert.equal(c.controllerModel, '22TB');
  assert.equal(c.controller, 'SYNTEC 22B');
  assert.equal(c.controllerPanel, 'SYNTEC 22TB');
  assert.equal(c.softwareVersion, '10.118.88T');
  assert.equal(by(inv, 'CNC-E').softwareVersion, '10.118.99X', 'tezgahin kendi yazilim surumu modelinkini ezer');
  // Eski 11TB tezgahlar etkilenmez.
  assert.equal(by(inv, 'CNC-B').controller, 'SYNTEC 11B');
});

test('envanter: modeli olmayan surucuda controllerModel null', () => {
  const s = by(loadInventory(), 'SIM-1');
  assert.equal(s.controllerModel, null);
  assert.equal(s.controllerModelLabel, null);
});

/* ------------------------------------------------------------- ajan listesi */

test('ajan listesi: model suzgeci her ajana yalniz kendi modelindeki tezgahlari verir', () => {
  const inv = loadInventory();
  const ids = (o) => agentMachines(inv, o).map((m) => m.id);
  assert.deepEqual(ids({ driver: 'syntec-remoteapi', model: '11TB' }), ['CNC-A', 'CNC-B']);
  assert.deepEqual(ids({ driver: 'syntec-remoteapi', model: '22TB' }), ['CNC-C', 'CNC-E'], 'IP\'si olmayan CNC-D yok');
  // Her tezgah tam bir ajana duser: ikisi birden okumaz, hicbiri atlanmaz.
  const hepsi = [...ids({ driver: 'syntec-remoteapi', model: '11TB' }), ...ids({ driver: 'syntec-remoteapi', model: '22TB' })];
  assert.deepEqual(hepsi.sort(), ids({ driver: 'syntec-remoteapi' }).sort());
});

test('ajan listesi: model verilmezse (eski ajan) suzulmez; surucu suzgeci korunur', () => {
  const inv = loadInventory();
  assert.equal(agentMachines(inv, { driver: 'syntec-remoteapi' }).length, 4);
  assert.equal(agentMachines(inv, { driver: 'syntec-remoteapi', model: '' }).length, 4);
  assert.deepEqual(agentMachines(inv, { driver: 'simulator' }).map((m) => m.id), ['SIM-1']);
  assert.equal(agentMachines(inv, { driver: 'syntec-remoteapi', model: 'YOK' }).length, 0, 'bilinmeyen model: bos');
});

/* ----------------------------------------------------------------- dogrulama */

test('dogrulama: gecerli model kabul edilir, bos model varsayilan demektir ve kaydedilmez', () => {
  const r = validateMachines([
    { id: 'A', name: 'A', ip: '10.0.0.1', controllerModel: '22TB' },
    { id: 'B', name: 'B', ip: '10.0.0.2', controllerModel: '' },
    { id: 'C', name: 'C', ip: '10.0.0.3' },
  ]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.machines[0].controllerModel, '22TB');
  assert.equal('controllerModel' in r.machines[1], false);
  assert.equal('controllerModel' in r.machines[2], false);
});

test('dogrulama: bilinmeyen model ve modeli olmayan surucuye model reddedilir', () => {
  const kotu = validateMachines([{ id: 'A', name: 'A', ip: '10.0.0.1', controllerModel: '33XX' }]);
  assert.equal(kotu.ok, false);
  assert.match(kotu.errors[0], /kontrolcü modeli geçersiz "33XX".*11TB.*22TB/);

  const sim = validateMachines([{ id: 'S', name: 'S', driverId: 'simulator', ip: '10.0.0.1', controllerModel: '22TB' }]);
  assert.equal(sim.ok, false);
  assert.match(sim.errors[0], /kontrolcü modeli seçimi yok/);
});

/* -------------------------------------------------------- gonderme politikasi */

test('gonderme politikasi: 22TB kapali (nedeniyle), 11TB ve modelsiz tezgah acik', () => {
  const inv = loadInventory();
  const p22 = sendPolicy(by(inv, 'CNC-C'));
  assert.equal(p22.allowed, false);
  assert.equal(p22.model, 'SYNTEC 22TB');
  assert.match(p22.reason, /gerçek tezgahta henüz doğrulanmadı/);
  assert.equal(sendPolicy(by(inv, 'CNC-A')).allowed, true);
  assert.equal(sendPolicy(by(inv, 'SIM-1')).allowed, true);
  assert.equal(sendPolicy({ id: 'X', driverId: 'syntec-remoteapi', controllerModel: '22TB' }).allowed, false);
});

test('22TB tezgah: on kontrol engeller ve FTP\'ye HIC dokunmaz; gonderme reddedilir, tornaya yazilmaz', async () => {
  const t = await kur();
  try {
    t.machines.push({ id: 'CNC-22', name: 'Torna 22', ip: '127.0.0.1', driverId: 'syntec-remoteapi', controllerModel: '22TB' });
    const { program } = ekle(t.library, 'AA', 'ORNEK-013');
    const once = t.server.commands.length;

    const pre = await t.files.precheck({ machineId: 'CNC-22', programId: program.id, customer: 'AA' });
    assert.equal(pre.canSend, false);
    const engel = pre.checks.find((k) => k.level === 'block');
    assert.equal(engel.id, 'model');
    assert.match(engel.title, /SYNTEC 22TB.*gönderme kapalı/);
    assert.equal(t.server.commands.length, once, 'on kontrol FTP baglantisi bile acmadi');

    await assert.rejects(
      () => t.files.send({ machineId: 'CNC-22', programId: program.id, customer: 'AA', confirm: 'CNC-22' }),
      (e) => e instanceof UnsupportedError && /SYNTEC 22TB/.test(e.message),
    );
    assert.equal(t.server.commands.length, once, 'gonderme reddedildi: tornaya tek komut gitmedi');
    assert.equal(t.library.db.listTransfers({}).length, 0, 'reddedilen model engeli aktarim kaydi acmaz');
  } finally {
    await t.kapat();
  }
});

test('22TB tezgah: salt okunur tarama CALISIR (modeli dogrulamanin yolu)', async () => {
  const t = await kur({ seed: (s) => s.put('AA/P1', 'x\r\n') });
  try {
    t.machines.push({ id: 'CNC-22', name: 'Torna 22', ip: '127.0.0.1', driverId: 'syntec-remoteapi', controllerModel: '22TB' });
    const r = await t.files.scan('CNC-22');
    assert.ok(r.entries >= 1, 'tarama girdileri buldu');
    assert.equal(t.server.commands.filter((k) => /^(STOR|RNFR|RNTO|DELE|MKD|RMD)\b/.test(k)).length, 0, 'taramada yazma komutu yok');
  } finally {
    await t.kapat();
  }
});

test('11TB tezgah: gonderme politikasi onu ENGELLEMEZ (kural yalniz dogrulanmamis modeli kapatir)', async () => {
  const t = await kur();
  try {
    t.machines.push({ id: 'CNC-11', name: 'Torna 11', ip: '127.0.0.1', driverId: 'syntec-remoteapi', controllerModel: '11TB' });
    const { program } = ekle(t.library, 'AA', 'ORNEK-013');
    const pre = await t.files.precheck({ machineId: 'CNC-11', programId: program.id, customer: 'AA' });
    assert.equal(pre.checks.some((k) => k.id === 'model'), false);
  } finally {
    await t.kapat();
  }
});
