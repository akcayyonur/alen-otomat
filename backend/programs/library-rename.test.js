/**
 * Kutuphanede program yeniden adlandirma: ayni musteri klasorunde, surumler/icerik dokunulmaz, ayni ada
 * (buyuk/kucuk harf duyarsiz) no-op, catisan ada 409, denetim kaydi, toplu-gonderim yedekleri yeni adla
 * izlenebilir kalir; tezgah envanteri VE gonderme gecmisi (donmus kayit) BILEREK dokunulmaz. HTTP uclari.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Library, ValidationError, sha256 } from './library.js';
import { createProgramRoutes } from './routes.js';

const A1 = Buffer.from('//A1\r\nG0 X1.\r\nM99\r\n');
const B1 = Buffer.from('//B1\r\nG0 X3.\r\nM99\r\n');

function kur() {
  const lib = new Library(':memory:');
  const a = lib.addUpload({ customer: 'MUSTERI_A', name: 'ALF-001', content: A1, createdBy: 'ayse' });
  const b = lib.addUpload({ customer: 'MUSTERI_A', name: 'ALF-002', content: B1, createdBy: 'ayse' });
  const k = lib.addUpload({ customer: '', name: 'ORNEK', content: B1, createdBy: 'ayse' });
  return { lib, a: a.program.id, b: b.program.id, k: k.program.id };
}

test('yeniden adlandirma: ad degisir, musteri/surumler/icerik dokunulmaz', () => {
  const { lib, a } = kur();
  const r = lib.renameProgram({ id: a, newName: 'ALF-001-REV2', by: 'ayse' });
  assert.equal(r.renamed, true);
  assert.equal(r.oldName, 'ALF-001');
  assert.equal(r.program.name, 'ALF-001-REV2');
  assert.equal(r.program.customer, 'MUSTERI_A');
  assert.equal(r.program.id, a);
  assert.equal(lib.db.listVersions(a).length, 1, 'surumler dokunulmadi');
  assert.equal(lib.db.getVersion(a, 1).meta.sha256, sha256(A1), 'icerik ayni');
  assert.equal(lib.db.findProgram('MUSTERI_A', 'ALF-001'), null, 'eski adla artik bulunmuyor');
  assert.ok(lib.db.findProgram('MUSTERI_A', 'ALF-001-REV2'), 'yeni adla bulunuyor');
  lib.close();
});

test('ayni ada (buyuk/kucuk harf duyarsiz) yeniden adlandirma no-op sayilir, denetim kaydi yazilmaz', () => {
  const { lib, a } = kur();
  const r = lib.renameProgram({ id: a, newName: 'alf-001' });
  assert.equal(r.renamed, false);
  assert.equal(r.program.name, 'ALF-001', 'ad degismedi');
  assert.equal(lib.db.listLog().length, 0);
  lib.close();
});

test('catisan ad (ayni musteride var olan baska program) 409 ile reddedilir; hicbir sey degismez', () => {
  const { lib, a } = kur();
  assert.throws(() => lib.renameProgram({ id: a, newName: 'ALF-002' }), (e) => e instanceof ValidationError && e.status === 409 && /zaten var/.test(e.message));
  assert.equal(lib.db.getProgram(a).name, 'ALF-001', 'degismedi');
  // buyuk/kucuk harf duyarsiz catisma da yakalanir
  assert.throws(() => lib.renameProgram({ id: a, newName: 'alf-002' }), (e) => e.status === 409);
  lib.close();
});

test('baska musteri klasorunde ayni ad SERBESTTIR (klasor tasima degil, catisma yalniz ayni klasorde)', () => {
  const { lib, a } = kur(); // kok klasorde 'ORNEK' var; a 'MUSTERI_A' klasorunde
  const r = lib.renameProgram({ id: a, newName: 'ORNEK' });
  assert.equal(r.renamed, true);
  assert.equal(r.program.customer, 'MUSTERI_A', 'klasor degismedi, yalniz ad');
  lib.close();
});

test('gecersiz ad (desene uymayan, ZZUP/ZZRB onekli) 400; olmayan program 404; gecersiz kimlik 400', () => {
  const { lib, a } = kur();
  assert.throws(() => lib.renameProgram({ id: a, newName: 'kötü ad!' }), ValidationError);
  assert.throws(() => lib.renameProgram({ id: a, newName: 'ZZUP123456' }), ValidationError);
  assert.throws(() => lib.renameProgram({ id: 999999, newName: 'YENI' }), (e) => e.status === 404);
  for (const id of [0, -1, 1.5, 'abc', null]) {
    assert.throws(() => lib.renameProgram({ id, newName: 'YENI' }), ValidationError, JSON.stringify(id));
  }
  lib.close();
});

test('denetim kaydi: eski/yeni ad, kim, ne zaman', () => {
  const { lib, a } = kur();
  lib.renameProgram({ id: a, newName: 'ALF-001-REV2', by: 'mehmet', clientIp: '10.0.0.7' });
  const log = lib.db.listLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].action, 'program-yeniden-adlandirma');
  assert.equal(log[0].customer, 'MUSTERI_A');
  assert.equal(log[0].name, 'ALF-001-REV2', 'YENI ad kayitta');
  assert.deepEqual(log[0].detail, { from: 'ALF-001', to: 'ALF-001-REV2' });
  assert.equal(log[0].by, 'mehmet');
  assert.equal(log[0].clientIp, '10.0.0.7');
  assert.ok(Math.abs(log[0].at - Date.now()) < 5000);
  lib.close();
});

test('toplu-gonderim yedekleri yeni adla izlenebilir kalir (ayni musteri+ad anahtari)', () => {
  const { lib, a } = kur();
  lib.db.addBackup({ customer: 'MUSTERI_A', name: 'ALF-001', machineId: 'CNC-08', content: B1, sha256: sha256(B1), createdBy: 'ayse' });
  assert.equal(lib.db.listBackups('MUSTERI_A', 'ALF-001').length, 1);

  lib.renameProgram({ id: a, newName: 'ALF-001-REV2' });
  assert.equal(lib.db.listBackups('MUSTERI_A', 'ALF-001').length, 0, 'eski adla artik bulunmuyor');
  const after = lib.db.listBackups('MUSTERI_A', 'ALF-001-REV2');
  assert.equal(after.length, 1, 'yeni adla bulunuyor, kaybolmadi');
  assert.equal(after[0].machineId, 'CNC-08');
  lib.close();
});

test('tezgah envanteri (fiziksel gercek) ve gonderme gecmisi (donmus kayit) rename\'den ETKILENMEZ', () => {
  const { lib, a } = kur();
  lib.db.replaceInventory('CNC-08', [{ customer: 'MUSTERI_A', name: 'ALF-001', size: A1.length, sha256: sha256(A1) }], { startedAt: 1, finishedAt: 2, folders: ['MUSTERI_A'] });
  const t = lib.db.startTransfer({ kind: 'gonderme', machineId: 'CNC-08', programId: a, customer: 'MUSTERI_A', name: 'ALF-001', requestedBy: 'ayse' });
  lib.db.finishTransfer(t, { status: 'basarili' });

  lib.renameProgram({ id: a, newName: 'ALF-001-REV2' });

  assert.equal(lib.db.getInventory('CNC-08')[0].name, 'ALF-001', 'tezgahtaki fiziksel dosya hala eski adla (rename lathe\'e gitmedi)');
  assert.equal(lib.db.listTransfers()[0].name, 'ALF-001', 'gecmis kaydi donmus, geriye donuk degismedi');
  // karsilastirmada: eski ad artik kutuphanede yok, yeni ad bu tezgahta henuz yok
  const cmp = lib.compareMachine('CNC-08');
  assert.equal(cmp.entries.find((e) => e.name === 'ALF-001').status, 'kutuphanede-yok');
  assert.ok(cmp.missing.some((p) => p.name === 'ALF-001-REV2'), 'yeni ad bu tezgahta eksik gorunuyor');
  lib.close();
});

/* ------------------------------------------------------------------------- HTTP */

test('HTTP: POST /api/library/programs/:id/rename (200, 400 gecersiz ad, 404, 409 catisma)', async () => {
  const { lib, a, b } = kur();
  const routes = createProgramRoutes({ library: lib, files: { flags: {}, transferEnabled: true }, listMachines: () => [] });
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
    const ok = await post(`/api/library/programs/${a}/rename`, { name: 'ALF-001-REV2', by: 'ayse' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.program.name, 'ALF-001-REV2');
    assert.equal(ok.body.oldName, 'ALF-001');

    const kotu = await post(`/api/library/programs/${a}/rename`, { name: 'kötü ad!' });
    assert.equal(kotu.status, 400);

    const yok = await post('/api/library/programs/424242/rename', { name: 'YENI' });
    assert.equal(yok.status, 404);

    const catisma = await post(`/api/library/programs/${a}/rename`, { name: 'ALF-002' });
    assert.equal(catisma.status, 409);
    assert.match(catisma.body.error, /zaten var/);

    const sonra = await (await fetch(`${base}/api/library/programs/${a}`)).json();
    assert.equal(sonra.program.name, 'ALF-001-REV2', 'basarisiz denemeler degistirmedi');
    assert.equal((await (await fetch(`${base}/api/library/programs/${b}`)).json()).program.name, 'ALF-002', 'diger program etkilenmedi');
  } finally {
    await new Promise((r) => server.close(r));
    lib.close();
  }
});
