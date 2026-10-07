/**
 * HTTP uclari: kutuphane yukleme/indirme/onizleme, tarama, on kontrol, gonderme,
 * hata kodlari. Gercek http sunucusu + sahte FTP sunucusu.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { kur, ORNEK } from './test/harness.js';
import { createProgramRoutes } from './routes.js';
import { MAX_PROGRAM_BYTES } from './library.js';

async function api(t, govde) {
  const routes = createProgramRoutes({ library: t.library, files: t.files, listMachines: () => t.machines });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!(await routes(req, res, url))) { res.writeHead(404); res.end('{}'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const j = async (path, init) => { const r = await fetch(base + path, init); return { status: r.status, body: await r.json().catch(() => null), res: r }; };
  try { await govde({ base, j }); } finally { await new Promise((r) => server.close(r)); }
}

const yukle = (j, q, govde = ORNEK) =>
  j(`/api/library/programs?${new URLSearchParams(q)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: govde });
const post = (j, path, obj) => j(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });

test('HTTP: yukleme 201, ayni icerik 200 (yeni surum yok), liste/ayrinti/onizleme/indirme', async () => {
  const t = await kur();
  try {
    await api(t, async ({ base, j }) => {
      const a = await yukle(j, { customer: 'AA', name: 'ORNEK-013', by: 'ayse', note: 'ilk', originalName: 'ORNEK-13.txt' });
      assert.equal(a.status, 201);
      assert.equal(a.body.version.versionNo, 1);
      assert.equal(a.body.version.originalName, 'ORNEK-13.txt');

      const b = await yukle(j, { customer: 'AA', name: 'ORNEK-013' });
      assert.equal(b.status, 200);
      assert.equal(b.body.created, false);

      const list = await j('/api/library/programs');
      assert.equal(list.body.programs.length, 1);
      assert.equal(list.body.programs[0].latest.size, ORNEK.length);
      const filtre = await j('/api/library/programs?customer=MUSTERI_B');
      assert.equal(filtre.body.programs.length, 0);
      const ara = await j('/api/library/programs?q=ornek');
      assert.equal(ara.body.programs.length, 1);

      const id = a.body.program.id;
      const ayr = await j(`/api/library/programs/${id}`);
      assert.equal(ayr.body.versions.length, 1);
      const onizleme = await j(`/api/library/programs/${id}/versions/1`);
      assert.equal(onizleme.body.lineEnding, 'CRLF');
      assert.ok(onizleme.body.text.startsWith('//100200300'));

      const dl = await fetch(`${base}/api/library/programs/${id}/versions/1?download=1`);
      assert.equal(dl.status, 200);
      assert.ok(Buffer.from(await dl.arrayBuffer()).equals(ORNEK), 'indirilen dosya yuklenenle bayt bayt ayni');
      assert.match(dl.headers.get('content-disposition'), /filename="ORNEK-013"/);
    });
  } finally { await t.kapat(); }
});

test('HTTP: gecersiz ad/musteri/bos/ikili 400, buyuk dosya 413, yoksa 404', async () => {
  const t = await kur();
  try {
    await api(t, async ({ j }) => {
      assert.equal((await yukle(j, { customer: 'AA', name: '../x' })).status, 400);
      assert.equal((await yukle(j, { customer: 'a/b', name: 'OK1' })).status, 400);
      assert.equal((await yukle(j, { customer: 'AA', name: 'ZZUP111111' })).status, 400);
      assert.equal((await yukle(j, { customer: 'AA', name: 'OK2' }, Buffer.alloc(0))).status, 400);
      assert.equal((await yukle(j, { customer: 'AA', name: 'OK3' }, Buffer.from([65, 0, 66]))).status, 400);
      const buyuk = await yukle(j, { customer: 'AA', name: 'OK4' }, Buffer.alloc(MAX_PROGRAM_BYTES + 5_000, 65));
      assert.equal(buyuk.status, 413);
      assert.equal((await j('/api/library/programs/999')).status, 404);
      assert.equal((await j('/api/library/programs/999/versions/1')).status, 404);
      assert.equal((await j('/api/machines/CNC-99/programs')).status, 404);
      assert.equal((await yukle(j, { customer: 'AA', name: 'OK5' }, Buffer.from('M99\r\n'))).status, 201);
    });
  } finally { await t.kapat(); }
});

test('HTTP: tarama, envanter karsilastirma, matris, ice alma', async () => {
  const t = await kur({ seed: (s) => { s.put('MUSTERI_B/P1', ORNEK); s.put('MUSTERI_B/P2', 'iki\r\n'); } });
  try {
    await api(t, async ({ j }) => {
      await yukle(j, { customer: 'MUSTERI_B', name: 'P1' });
      const tara = await post(j, '/api/machines/CNC-08/programs/scan', {});
      assert.equal(tara.status, 200);
      assert.equal(tara.body.hashed, 1);

      const env = await j('/api/machines/CNC-08/programs');
      const durum = Object.fromEntries(env.body.entries.map((e) => [e.name, e.status]));
      assert.equal(durum.P1, 'guncel');
      assert.equal(durum.P2, 'kutuphanede-yok');
      assert.equal(env.body.counts.guncel, 1);

      const imp = await post(j, '/api/machines/CNC-08/programs/import', { customer: 'MUSTERI_B', name: 'P2', by: 'ayse' });
      assert.equal(imp.status, 201);
      assert.equal(imp.body.version.source, 'tezgah-tarama');

      const mx = await j('/api/library/matrix');
      assert.deepEqual(mx.body.machines.map((m) => m.id), ['CNC-08']);
      assert.equal(mx.body.rows.find((r) => r.name === 'P2').cells['CNC-08'].status, 'guncel');
      assert.deepEqual((await j('/api/library/customers')).body.customers, ['AA', 'MUSTERI_B']);

      const hata = await post(j, '/api/machines/CNC-08/programs/import', { customer: 'MUSTERI_B', name: 'YOK' });
      assert.equal(hata.status, 404);
    });
  } finally { await t.kapat(); }
});

test('HTTP: on kontrol + gonderme (onay metni, engel, basari) ve denetim kaydi', async () => {
  const t = await kur({ seed: (s) => s.put('AA/VAR', 'x\r\n') });
  try {
    await api(t, async ({ j }) => {
      const prog = (await yukle(j, { customer: 'AA', name: 'ORNEK-013' })).body.program;
      const cakisan = (await yukle(j, { customer: 'AA', name: 'VAR' }, Buffer.from('baska\r\n'))).body.program;

      const pre = await post(j, '/api/transfers/precheck', { machineId: 'CNC-08', programId: prog.id });
      assert.equal(pre.status, 200);
      assert.equal(pre.body.canSend, true);
      assert.equal(pre.body.sha256.length, 64);

      const yanlis = await post(j, '/api/transfers', { machineId: 'CNC-08', programId: prog.id, customer: 'AA', confirm: 'onaylıyorum' });
      assert.equal(yanlis.status, 400);
      assert.match(yanlis.body.error, /CNC-08/);

      const engel = await post(j, '/api/transfers', { machineId: 'CNC-08', programId: cakisan.id, customer: 'AA', confirm: 'CNC-08' });
      assert.equal(engel.status, 200);
      assert.equal(engel.body.status, 'reddedildi');

      const ok = await post(j, '/api/transfers', { machineId: 'CNC-08', programId: prog.id, customer: 'AA', confirm: 'CNC-08', by: 'ayse' });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.status, 'basarili', ok.body.error);
      assert.ok(t.server.read('AA/ORNEK-013').equals(ORNEK));

      const log = await j('/api/transfers?machineId=CNC-08');
      assert.deepEqual(log.body.transfers.map((x) => x.status), ['basarili', 'reddedildi']);
      assert.equal(log.body.transfers[0].requestedBy, 'ayse');
    });
  } finally { await t.kapat(); }
});

test('HTTP: TRANSFER_DISABLED -> gonderme 403, okuma uclari calisir; config bunu bildirir', async () => {
  const t = await kur({ disabled: true });
  try {
    await api(t, async ({ j }) => {
      const prog = (await yukle(j, { customer: 'AA', name: 'P1' })).body.program;
      const r = await post(j, '/api/transfers', { machineId: 'CNC-08', programId: prog.id, customer: 'AA', confirm: 'CNC-08' });
      assert.equal(r.status, 403);
      const cfg = await j('/api/library/config');
      assert.equal(cfg.body.transferEnabled, false);
      assert.equal(cfg.body.authRequired, false);
      assert.equal(cfg.body.overwriteEnabled, false);
      assert.equal(cfg.body.machines[0].id, 'CNC-08');
      assert.equal(cfg.body.machines[0].capable, true);
      assert.equal((await post(j, '/api/machines/CNC-08/programs/scan', {})).status, 200);
    });
  } finally { await t.kapat(); }
});

test('HTTP: tezgaha ulasilamazsa 502 ve anlasilir mesaj; ayni tezgah mesgulse 409', async () => {
  const t = await kur({ ftp: { delayMs: 40 } });
  try {
    await api(t, async ({ j }) => {
      const prog = (await yukle(j, { customer: 'AA', name: 'P1' })).body.program;
      const arg = { machineId: 'CNC-08', programId: prog.id, customer: 'AA', confirm: 'CNC-08' };
      const bir = post(j, '/api/transfers', arg);
      await new Promise((r) => setTimeout(r, 30));
      const iki = await post(j, '/api/transfers', arg);
      assert.equal(iki.status, 409);
      assert.equal((await bir).body.status, 'basarili');

      await t.server.stop();
      const kapali = await post(j, '/api/machines/CNC-08/programs/scan', {});
      assert.equal(kapali.status, 502);
      assert.match(kapali.body.error, /Tezgahla FTP konuşulamadı/);
    });
  } finally { await t.library.close(); }
});
