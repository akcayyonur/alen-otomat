/**
 * Kutuphaneden program silme: onay metni (tek program = adi, birden cok = sayisi), tek islemde hepsi ya da hicbiri,
 * surumlerle birlikte silinir, denetim kaydi (kim/ne zaman/SHA), tezgah envanterine ve gonderme gecmisine dokunulmaz,
 * HTTP uclari. Tezgahlardaki dosyalar KUTUPHANE silmesinden etkilenmez.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Library, ValidationError, MAX_DELETE_BATCH, sha256 } from './library.js';
import { createProgramRoutes } from './routes.js';

const A1 = Buffer.from('//A1\r\nG0 X1.\r\nM99\r\n');
const A2 = Buffer.from('//A1 degisti\r\nG0 X2.\r\nM99\r\n');
const B1 = Buffer.from('//B1\r\nG0 X3.\r\nM99\r\n');

function kur() {
  const lib = new Library(':memory:');
  const a = lib.addUpload({ customer: 'MUSTERI_A', name: 'ALF-001', content: A1, createdBy: 'ayse' });
  lib.addUpload({ customer: 'MUSTERI_A', name: 'ALF-001', content: A2, createdBy: 'ayse' }); // v2
  const b = lib.addUpload({ customer: 'MUSTERI_A', name: 'ALF-002', content: B1, createdBy: 'ayse' });
  const k = lib.addUpload({ customer: '', name: 'O9001', content: B1, createdBy: 'ayse' });
  return { lib, a: a.program.id, b: b.program.id, k: k.program.id };
}

test('tek program: onay metni programin adi; tum surumler silinir, baska program kalir', () => {
  const { lib, a, b } = kur();
  assert.throws(() => lib.deletePrograms({ ids: [a], confirm: 'yanlis' }), (e) => e instanceof ValidationError && /ALF-001/.test(e.message));
  assert.throws(() => lib.deletePrograms({ ids: [a], confirm: '' }), ValidationError);
  assert.equal(lib.db.listVersions(a).length, 2, 'yanlis onayda hicbir sey silinmedi');

  const r = lib.deletePrograms({ ids: [a], confirm: 'ALF-001', by: 'ayse', clientIp: '10.0.0.5' });
  assert.deepEqual(r.deleted, [{ id: a, customer: 'MUSTERI_A', name: 'ALF-001', versions: 2 }]);
  assert.equal(r.versions, 2);
  assert.equal(lib.db.getProgram(a), null);
  assert.equal(lib.db.listVersions(a).length, 0, 'surumler de gitti');
  assert.ok(lib.db.getProgram(b), 'ayni musterideki baska program duruyor');
  assert.equal(lib.db.stats().programs, 2);
  lib.close();
});

test('birden cok program: onay metni program SAYISI; yanlis sayi reddedilir; ayni kimlik iki kez sayilmaz', () => {
  const { lib, a, b, k } = kur();
  assert.throws(() => lib.deletePrograms({ ids: [a, b], confirm: 'ALF-001' }), (e) => /sayısını/.test(e.message));
  assert.throws(() => lib.deletePrograms({ ids: [a, b, k], confirm: '2' }), ValidationError);
  const r = lib.deletePrograms({ ids: [a, a, b], confirm: '2', by: 'ayse' });
  assert.equal(r.programs, 2);
  assert.equal(r.versions, 3);
  assert.deepEqual(lib.db.listPrograms().map((p) => p.name), ['O9001'], 'kokteki ortak program kaldi');
  lib.close();
});

test('hepsi ya da hicbiri: olmayan kimlik 404, gecersiz kimlik 400, bos secim 400, ust sinir', () => {
  const { lib, a } = kur();
  assert.throws(() => lib.deletePrograms({ ids: [a, 99999], confirm: '2' }), (e) => e.status === 404);
  assert.ok(lib.db.getProgram(a), 'bulunamayan kimlik yuzunden hicbiri silinmedi');
  for (const ids of [[], null, 'x', [0], [-1], [1.5], ['abc']]) {
    assert.throws(() => lib.deletePrograms({ ids, confirm: 'x' }), ValidationError, JSON.stringify(ids));
  }
  const cok = Array.from({ length: MAX_DELETE_BATCH + 1 }, (_, i) => i + 1);
  assert.throws(() => lib.deletePrograms({ ids: cok, confirm: String(cok.length) }), /en fazla/);
  lib.close();
});

test('denetim kaydi: kim, ne zaman, kac surum, silinen surumlerin SHA-256 ozeti; tezgah envanteri ve gecmis korunur', () => {
  const { lib, a } = kur();
  lib.db.replaceInventory('CNC-08', [{ customer: 'MUSTERI_A', name: 'ALF-001', size: A2.length, sha256: sha256(A2) }], { startedAt: 1, finishedAt: 2, folders: ['MUSTERI_A'] });
  const t = lib.db.startTransfer({ kind: 'gonderme', machineId: 'CNC-08', programId: a, customer: 'MUSTERI_A', name: 'ALF-001', requestedBy: 'ayse' });
  lib.db.finishTransfer(t, { status: 'basarili' });

  lib.deletePrograms({ ids: [a], confirm: 'ALF-001', by: 'mehmet', clientIp: '10.0.0.7' });
  const log = lib.db.listLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].action, 'program-silme');
  assert.equal(log[0].name, 'ALF-001');
  assert.equal(log[0].customer, 'MUSTERI_A');
  assert.equal(log[0].by, 'mehmet');
  assert.equal(log[0].clientIp, '10.0.0.7');
  assert.equal(log[0].versions, 2);
  assert.deepEqual(log[0].detail.map((v) => v.sha256), [sha256(A2), sha256(A1)], 'en yeni surum once');
  assert.ok(Math.abs(log[0].at - Date.now()) < 5000);

  // tezgahin envanteri ve gonderme gecmisi AYNEN duruyor (tezgahtaki dosyaya dokunulmadi)
  assert.equal(lib.db.getInventory('CNC-08').length, 1);
  assert.equal(lib.db.listTransfers().length, 1);
  // ayni ad yeniden eklenebilir (yeni program, v1)
  const yeni = lib.addUpload({ customer: 'MUSTERI_A', name: 'ALF-001', content: A1 });
  assert.equal(yeni.version.versionNo, 1);
  assert.notEqual(yeni.program.id, a);
  lib.close();
});

/* ------------------------------------------------------------------------- HTTP */

test('HTTP: POST /api/library/programs/delete (400 onay, 404, 200) ve GET /api/library/log', async () => {
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
    const yanlis = await post('/api/library/programs/delete', { ids: [a], confirm: 'yanlis' });
    assert.equal(yanlis.status, 400);
    assert.match(yanlis.body.error, /ALF-001/);
    assert.equal((await post('/api/library/programs/delete', { ids: [424242], confirm: 'x' })).status, 404);
    assert.equal((await post('/api/library/programs/delete', { ids: [], confirm: '' })).status, 400);

    const ok = await post('/api/library/programs/delete', { ids: [a, b], confirm: '2', by: 'ayse' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.programs, 2);
    assert.equal(ok.body.versions, 3);

    const log = await (await fetch(`${base}/api/library/log`)).json();
    assert.equal(log.log.length, 2);
    assert.equal(log.log[0].by, 'ayse', 'giris kapaliyken istemcinin yazdigi ad');
    assert.equal((await (await fetch(`${base}/api/library/programs`)).json()).programs.length, 1);
  } finally {
    await new Promise((r) => server.close(r));
    lib.close();
  }
});
