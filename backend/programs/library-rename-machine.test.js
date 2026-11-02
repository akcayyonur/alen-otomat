/**
 * Kutuphanede program yeniden adlandirilince TORNADAKI dosyanin da adini degistirme (FTP RNFR/RNTO; icerik
 * degismez). Sahte FTP sunucusu kullanilir (gercek torna ASLA bu testlerde). Kanitlanan kurallar:
 *   - onay metni: 1 tezgahta kimlik, >1 tezgahta SAYI (kutuphaneden toplu silmedeki desen)
 *   - calisan/secili programin adi degistirilmez; hedefte zaten o adda dosya varsa UZERINE YAZILMAZ
 *   - canli veri yoksa (ajan baglanmamis) o tezgah icin atlanir, FTP'ye hic gidilmez
 *   - model kapisi kapaliysa atlanir, FTP'ye hic gidilmez
 *   - tezgahta dosya zaten yoksa envanterden de kaldirilir
 *   - her deneme (basarisiz dahil) transfers tablosuna kind='yeniden-adlandirma' ile yazilir
 *
 * DRIVERS_FILE: harness'in kullandigi 'syntec-remoteapi/11TB' GERCEK configteki gibi acik birakilir (diger
 * testler etkilenmez), yalniz model kapisi testi icin SENTETIK bir 'KAPALI' model eklenir - 2026-10-30'da
 * 22TB gonderme gercek configte ACILDIGI icin (kullanici karari) model kapisinin MEKANIZMASI artik gercek
 * 22TB ornegiyle sinanamiyor (bkz. backend/drivers-gate.test.js).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dizin = mkdtempSync(join(tmpdir(), 'rename-machine-drivers-'));
const dosya = join(dizin, 'drivers.json');
writeFileSync(dosya, JSON.stringify({
  drivers: [{
    id: 'syntec-remoteapi', label: 'Syntec RemoteAPI', status: 'supported', defaultModel: '11TB',
    models: [
      { id: '11TB', label: 'SYNTEC 11TB', fileTransfer: { sendEnabled: true, deleteEnabled: true } },
      { id: 'KAPALI', label: 'Kapalı Model (test)', fileTransfer: { sendEnabled: false, reason: 'Kapalı Model (test) için program gönderme henüz doğrulanmadı.' } },
    ],
  }],
}));
process.env.DRIVERS_FILE = dosya;
test.after(() => rmSync(dizin, { recursive: true, force: true }));

const { kur, ekle } = await import('./test/harness.js');
const { MockFtpServer } = await import('./test/mock-ftp.js');
const { Library, sha256 } = await import('./library.js');
const { MachineFiles, DisabledError } = await import('./machine-files.js');
const { createProgramRoutes } = await import('./routes.js');

const ic = (ad, v) => Buffer.from(`//${ad} v${v}\r\nG0 X${v}.\r\nM99\r\n`, 'latin1');

/** Ortak kurulum: kutuphanede 'ESKI-AD' var, tornada da ayni adla dosya duruyor (envanterde de). */
async function kurRename(opts = {}) {
  const t = await kur({
    live: { connected: true, state: 'RUNNING', program: 'BASKA-PROGRAM', mainProgram: 'BASKA-PROGRAM' },
    seed: (s) => { s.put('MUSTERI_B/ESKI-AD', ic('V', 1)); },
    ...opts,
  });
  const p = ekle(t.library, 'MUSTERI_B', 'ESKI-AD', ic('V', 1));
  t.library.db.upsertInventory('CNC-08', { customer: 'MUSTERI_B', name: 'ESKI-AD', size: ic('V', 1).length, sha256: sha256(ic('V', 1)) });
  t.library.renameProgram({ id: p.program.id, newName: 'YENI-AD' });
  return t;
}

const sonuc = (r, id = 'CNC-08') => r.results.find((x) => x.machineId === id);

test('0 tezgah bulunduysa hicbir sey yapilmaz, onay istenmez, FTP acilmaz', async () => {
  const t = await kur();
  try {
    const r = await t.files.renameAcrossMachines({ customer: 'MUSTERI_B', oldName: 'YOK', newName: 'YENI', machineIds: [], confirm: '' });
    assert.deepEqual(r, { machines: 0, results: [] });
    assert.equal(t.server.commands.length, 0);
  } finally { await t.kapat(); }
});

test('1 tezgah: onay = tezgah kimligi; yanlis onay 400, torna HIC DOKUNULMAZ', async () => {
  const t = await kurRename();
  try {
    await assert.rejects(
      () => t.files.renameAcrossMachines({ customer: 'MUSTERI_B', oldName: 'ESKI-AD', newName: 'YENI-AD', machineIds: ['CNC-08'], confirm: 'yanlis' }),
      (e) => e.status === 400 && /tezgah kimliğini/.test(e.message),
    );
    assert.equal(t.server.names('MUSTERI_B').includes('ESKI-AD'), true, 'eski ad tornada hala duruyor');
    assert.equal(t.server.commands.filter((c) => c.startsWith('RNFR')).length, 0, 'hic RNFR denenmedi');
  } finally { await t.kapat(); }
});

test('1 tezgah, dogru onay: RNFR/RNTO ile yeniden adlandirilir, envanter guncellenir, denetim kaydi yazilir', async () => {
  const t = await kurRename();
  try {
    const r = await t.files.renameAcrossMachines({ customer: 'MUSTERI_B', oldName: 'ESKI-AD', newName: 'YENI-AD', machineIds: ['CNC-08'], confirm: 'CNC-08', by: 'ayse' });
    assert.equal(r.machines, 1);
    const s = sonuc(r);
    assert.equal(s.outcome, 'degisti');
    assert.equal(t.server.names('MUSTERI_B').includes('YENI-AD'), true, 'tornada yeni ad var');
    assert.equal(t.server.names('MUSTERI_B').includes('ESKI-AD'), false, 'eski ad gitti');
    assert.ok(t.server.read('MUSTERI_B/YENI-AD').equals(ic('V', 1)), 'icerik degismedi (ayni dosya, yalniz ad)');

    const inv = t.library.db.getInventory('CNC-08');
    assert.equal(inv.find((e) => e.name === 'ESKI-AD'), undefined, 'eski ad envanterde yok');
    const yeni = inv.find((e) => e.name === 'YENI-AD');
    assert.ok(yeni, 'yeni ad envanterde var');
    assert.equal(yeni.sha256, sha256(ic('V', 1)));

    const log = t.library.db.listTransfers('CNC-08');
    assert.equal(log[0].kind, 'yeniden-adlandirma');
    assert.equal(log[0].status, 'basarili');
    assert.equal(log[0].requestedBy, 'ayse');
  } finally { await t.kapat(); }
});

test('calisan/secili programin adi DEGISTIRILMEZ', async () => {
  const t = await kurRename({ live: { connected: true, state: 'RUNNING', program: 'ESKI-AD', mainProgram: 'ESKI-AD' } });
  try {
    const r = await t.files.renameAcrossMachines({ customer: 'MUSTERI_B', oldName: 'ESKI-AD', newName: 'YENI-AD', machineIds: ['CNC-08'], confirm: 'CNC-08' });
    assert.equal(sonuc(r).outcome, 'atlandi');
    assert.match(sonuc(r).detail, /çalıştırıyor/);
    assert.equal(t.server.names('MUSTERI_B').includes('ESKI-AD'), true, 'eski ad hala tornada');
    assert.equal(t.library.db.listTransfers('CNC-08')[0].status, 'reddedildi');
  } finally { await t.kapat(); }
});

test('hedefte YENI ad zaten varsa UZERINE YAZILMAZ', async () => {
  const t = await kurRename({ seed: (s) => { s.put('MUSTERI_B/ESKI-AD', ic('V', 1)); s.put('MUSTERI_B/YENI-AD', ic('BASKA', 5)); } });
  try {
    const r = await t.files.renameAcrossMachines({ customer: 'MUSTERI_B', oldName: 'ESKI-AD', newName: 'YENI-AD', machineIds: ['CNC-08'], confirm: 'CNC-08' });
    assert.equal(sonuc(r).outcome, 'atlandi');
    assert.match(sonuc(r).detail, /zaten.*dosya.*var/);
    assert.ok(t.server.read('MUSTERI_B/YENI-AD').equals(ic('BASKA', 5)), 'hedefteki dosya DOKUNULMADI');
    assert.equal(t.server.names('MUSTERI_B').includes('ESKI-AD'), true, 'kaynak dosya da yerinde kaldi');
  } finally { await t.kapat(); }
});

test('tornada bu adla dosya yoksa "bulunamadi"; envanterdeki artik girdi de kaldirilir', async () => {
  const t = await kurRename({ seed: () => {} }); // ESKI-AD HICBIR YERDE YOK (seed boş)
  try {
    const r = await t.files.renameAcrossMachines({ customer: 'MUSTERI_B', oldName: 'ESKI-AD', newName: 'YENI-AD', machineIds: ['CNC-08'], confirm: 'CNC-08' });
    assert.equal(sonuc(r).outcome, 'bulunamadi');
    assert.equal(t.library.db.getInventory('CNC-08').find((e) => e.name === 'ESKI-AD'), undefined);
  } finally { await t.kapat(); }
});

test('canli veri yoksa (ajan baglanmamis) o tezgah ATLANIR, FTP hic acilmaz', async () => {
  const t = await kurRename({ live: null });
  try {
    const r = await t.files.renameAcrossMachines({ customer: 'MUSTERI_B', oldName: 'ESKI-AD', newName: 'YENI-AD', machineIds: ['CNC-08'], confirm: 'CNC-08' });
    assert.equal(sonuc(r).outcome, 'atlandi');
    assert.match(sonuc(r).detail, /canlı veri/);
    assert.equal(t.server.commands.length, 0, 'hic FTP komutu gonderilmedi');
  } finally { await t.kapat(); }
});

test('model kapisi kapaliysa atlanir, FTP hic acilmaz', async () => {
  const t = await kurRename();
  t.machines[0].controllerModel = 'KAPALI'; // sentetik DRIVERS_FILE: sendEnabled=false
  try {
    const r = await t.files.renameAcrossMachines({ customer: 'MUSTERI_B', oldName: 'ESKI-AD', newName: 'YENI-AD', machineIds: ['CNC-08'], confirm: 'CNC-08' });
    assert.equal(sonuc(r).outcome, 'atlandi');
    assert.match(sonuc(r).detail, /Kapalı Model/);
    assert.equal(t.server.commands.length, 0);
  } finally { await t.kapat(); }
});

test('TRANSFER_DISABLED: hic denenmez', async () => {
  const t = await kurRename({ disabled: true });
  try {
    await assert.rejects(
      () => t.files.renameAcrossMachines({ customer: 'MUSTERI_B', oldName: 'ESKI-AD', newName: 'YENI-AD', machineIds: ['CNC-08'], confirm: 'CNC-08' }),
      DisabledError,
    );
    assert.equal(t.server.commands.length, 0);
  } finally { await t.kapat(); }
});

/* ------------------------------------------------------------------- cok tezgahli: onay = SAYI */

test('>1 tezgah: onay = tezgah SAYISI; ikisi de BAGIMSIZ basariyla degisir', async () => {
  const s1 = new MockFtpServer({}); s1.mkdir('MUSTERI_B'); s1.put('MUSTERI_B/ESKI-AD', ic('V', 1)); await s1.start();
  const s2 = new MockFtpServer({}); s2.mkdir('MUSTERI_B'); s2.put('MUSTERI_B/ESKI-AD', ic('V', 2)); await s2.start();
  const library = new Library(':memory:');
  const machines = [
    { id: 'CNC-01', name: 'Torna 1', ip: '127.0.0.1', driverId: 'syntec-remoteapi' },
    { id: 'CNC-02', name: 'Torna 2', ip: '127.0.0.1', driverId: 'syntec-remoteapi' },
  ];
  const files = new MachineFiles({
    library,
    getMachine: (id) => machines.find((m) => m.id === id) ?? null,
    liveInfo: () => ({ connected: true, state: 'IDLE', program: 'BASKA', mainProgram: 'BASKA' }),
    ftpOptionsFor: (m) => ({ host: '127.0.0.1', port: m.id === 'CNC-01' ? s1.port : s2.port, commandTimeoutMs: 2000, connectTimeoutMs: 2000, dataIdleTimeoutMs: 2000 }),
    pauseMs: 0,
  });
  try {
    await assert.rejects(
      () => files.renameAcrossMachines({ customer: 'MUSTERI_B', oldName: 'ESKI-AD', newName: 'YENI-AD', machineIds: ['CNC-01', 'CNC-02'], confirm: 'CNC-01' }),
      (e) => e.status === 400 && /tezgah sayısını/.test(e.message) && /2/.test(e.message),
      'yanlis onay (kimlik yerine sayi gerekiyor) reddedilir',
    );
    assert.equal(s1.names('MUSTERI_B').includes('ESKI-AD'), true, 'yanlis onayda hicbir seye dokunulmadi');

    const r = await files.renameAcrossMachines({ customer: 'MUSTERI_B', oldName: 'ESKI-AD', newName: 'YENI-AD', machineIds: ['CNC-01', 'CNC-02'], confirm: '2' });
    assert.equal(r.machines, 2);
    assert.deepEqual(r.results.map((x) => x.outcome).sort(), ['degisti', 'degisti']);
    assert.equal(s1.names('MUSTERI_B').includes('YENI-AD'), true);
    assert.equal(s2.names('MUSTERI_B').includes('YENI-AD'), true);
    assert.ok(s1.read('MUSTERI_B/YENI-AD').equals(ic('V', 1)), 'her tezgahin kendi icerigi degismedi');
    assert.ok(s2.read('MUSTERI_B/YENI-AD').equals(ic('V', 2)));
  } finally {
    await s1.stop(); await s2.stop(); library.close();
  }
});

/* ------------------------------------------------------------------------- HTTP */

test('HTTP: POST /api/library/programs/:id/rename-on-machines (200 basarili, 400 onay)', async () => {
  const t = await kurRename();
  const prog = t.library.db.findProgram('MUSTERI_B', 'YENI-AD');
  const routes = createProgramRoutes({ library: t.library, files: t.files, listMachines: () => t.machines });
  const server = http.createServer(async (req, res) => {
    if (!(await routes(req, res, new URL(req.url, 'http://x')))) { res.writeHead(404); res.end('{}'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, obj) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
    return { status: r.status, body: await r.json() };
  };
  try {
    const kotu = await post(`/api/library/programs/${prog.id}/rename-on-machines`, {
      customer: 'MUSTERI_B', oldName: 'ESKI-AD', newName: 'YENI-AD', machineIds: ['CNC-08'], confirm: 'yanlis',
    });
    assert.equal(kotu.status, 400);
    assert.equal(t.server.names('MUSTERI_B').includes('ESKI-AD'), true);

    const ok = await post(`/api/library/programs/${prog.id}/rename-on-machines`, {
      customer: 'MUSTERI_B', oldName: 'ESKI-AD', newName: 'YENI-AD', machineIds: ['CNC-08'], confirm: 'CNC-08', by: 'ayse',
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.machines, 1);
    assert.equal(ok.body.results[0].outcome, 'degisti');
    assert.equal(t.server.names('MUSTERI_B').includes('YENI-AD'), true);
  } finally {
    await new Promise((r) => server.close(r));
    await t.kapat();
  }
});
