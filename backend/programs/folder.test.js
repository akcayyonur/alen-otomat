/**
 * Tezgahta YENI musteri klasoru acma (FTP MKD): sahte Windows CE FTP sunucusuna karsi.
 *
 * Kanitlanan kurallar: yalniz gecerli yeni ad, tezgah kimligiyle onay, var olan klasor/dosya adiyla
 * acilmaz, ozellik/model kapisi tornaya HIC baglanmadan reddeder, acilan klasor dogrulanir,
 * denetim kaydi (reddedilenler dahil), hicbir yerde silme (RMD/DELE) yok.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { kur, ekle } from './test/harness.js';
import { ValidationError } from './library.js';
import { BusyError, DisabledError, UnsupportedError, NotFoundError } from './machine-files.js';
import { createProgramRoutes } from './routes.js';

const komutlar = (s, onek) => s.commands.filter((k) => k.startsWith(onek));
const yazma = (s) => s.commands.filter((k) => /^(STOR|RNFR|RNTO|DELE|MKD|XMKD|RMD|XRMD)\b/.test(k));

test('klasor ac: basarili - MKD gider, klasor tornada var ve bos, bilinen klasorlere eklenir, denetim kaydi yazilir', async () => {
  const t = await kur({ seed: (s) => s.put('MUSTERI_B/P1', 'x\r\n') });
  try {
    await t.files.scan('CNC-08');
    assert.deepEqual(t.library.db.getFolders('CNC-08'), ['AA', 'MUSTERI_B']);
    const once = t.server.commands.length;

    const r = await t.files.createFolder({ machineId: 'CNC-08', name: 'MUSTERI_C', confirm: 'CNC-08', by: 'ayse', clientIp: '10.0.0.5' });
    assert.equal(r.status, 'basarili', r.error);
    assert.equal(r.kind, 'klasor');
    assert.equal(r.customer, 'MUSTERI_C');
    assert.equal(r.requestedBy, 'ayse');
    assert.equal(r.clientIp, '10.0.0.5');
    assert.deepEqual(r.steps.map((x) => [x.step, x.ok]), [['on-kontrol', true], ['klasor-ac', true], ['klasor-dogrula', true]]);

    assert.ok(t.server.exists('MUSTERI_C'), 'klasor tornada olustu');
    assert.deepEqual(t.server.names('MUSTERI_C'), [], 'bos');
    assert.deepEqual(t.server.commands.slice(once).filter((k) => /^(MKD|STOR|RNFR|RNTO|DELE|RMD)/.test(k)), ['MKD MUSTERI_C'],
      'tornaya yalniz tek yazma komutu gitti');
    assert.deepEqual(t.library.db.getFolders('CNC-08'), ['AA', 'MUSTERI_B', 'MUSTERI_C'], 'tarama beklemeden hedef klasorler listesinde');
    assert.equal(t.library.db.listTransfers({}).length, 1);
    assert.equal(t.library.db.listTransfers({})[0].kind, 'klasor');
    assert.ok(t.library.customers().includes('MUSTERI_C'));
  } finally { await t.kapat(); }
});

test('klasor ac: acilan klasore program HEMEN gonderilebilir (klasor yok engeli kalkar)', async () => {
  const t = await kur();
  try {
    const { program } = ekle(t.library, 'YENI_MUSTERI', 'ORNEK-013');
    const once = await t.files.precheck({ machineId: 'CNC-08', programId: program.id, customer: 'YENI_MUSTERI' });
    assert.equal(once.canSend, false);
    assert.match(once.checks.find((k) => k.id === 'klasor').detail, /Yeni klasör…/);

    const k = await t.files.createFolder({ machineId: 'CNC-08', name: 'YENI_MUSTERI', confirm: 'CNC-08' });
    assert.equal(k.status, 'basarili', k.error);
    const g = await t.files.send({ machineId: 'CNC-08', programId: program.id, customer: 'YENI_MUSTERI', confirm: 'CNC-08', acks: ['unknown-state'] });
    assert.equal(g.status, 'basarili', g.error);
    assert.ok(t.server.read('YENI_MUSTERI/ORNEK-013'));
  } finally { await t.kapat(); }
});

test('klasor ac: var olan klasor (buyuk/kucuk harf duyarsiz) ya da ayni adli dosya -> reddedildi, MKD gonderilmez', async () => {
  const t = await kur({ seed: (s) => s.put('ADLI_DOSYA', 'x') });
  try {
    for (const [ad, beklenen] of [['musteri_b', /zaten var/], ['AA', /zaten var/], ['ADLI_DOSYA', /dosya var/]]) {
      const r = await t.files.createFolder({ machineId: 'CNC-08', name: ad, confirm: 'CNC-08' });
      assert.equal(r.status, 'reddedildi', ad);
      assert.match(r.error, beklenen);
    }
    assert.equal(komutlar(t.server, 'MKD').length, 0);
    assert.equal(t.library.db.listTransfers({}).length, 3, 'reddedilenler de denetim kaydinda');
  } finally { await t.kapat(); }
});

test('klasor ac: gecersiz ad 400 ve tornaya baglanilmaz; yanlis onay metni 400; tezgah yoksa 404', async () => {
  const t = await kur();
  try {
    const baglanti = t.server.sessions;
    for (const ad of ['', 'ÖZKAN', 'a/b', '..', 'CON', 'ZZUP000001', 'x'.repeat(41)]) {
      await assert.rejects(() => t.files.createFolder({ machineId: 'CNC-08', name: ad, confirm: 'CNC-08' }), ValidationError, `"${ad}"`);
    }
    await assert.rejects(() => t.files.createFolder({ machineId: 'CNC-08', name: 'YENI', confirm: 'onaylıyorum' }), (e) => e instanceof ValidationError && /CNC-08/.test(e.message));
    await assert.rejects(() => t.files.createFolder({ machineId: 'CNC-08', name: 'YENI', confirm: 'cnc-08' }), ValidationError, 'onay metni birebir');
    await assert.rejects(() => t.files.createFolder({ machineId: 'CNC-99', name: 'YENI', confirm: 'CNC-99' }), NotFoundError);
    assert.equal(t.server.sessions, baglanti, 'bu reddedilenlerde tornaya HIC baglanilmadi');
    assert.equal(t.library.db.listTransfers({}).length, 0);
  } finally { await t.kapat(); }
});

test('klasor ac: TRANSFER_DISABLED -> 403; 22TB (gonderme kapali model) -> 422; ikisinde de tornaya baglanilmaz', async () => {
  const t = await kur({ disabled: true });
  const t2 = await kur();
  try {
    await assert.rejects(() => t.files.createFolder({ machineId: 'CNC-08', name: 'YENI', confirm: 'CNC-08' }), DisabledError);
    assert.equal(t.server.sessions, 0);

    t2.machines.push({ id: 'CNC-22', name: 'Torna 22', ip: '127.0.0.1', driverId: 'syntec-remoteapi', controllerModel: '22TB' });
    await assert.rejects(
      () => t2.files.createFolder({ machineId: 'CNC-22', name: 'YENI', confirm: 'CNC-22' }),
      (e) => e instanceof UnsupportedError && /SYNTEC 22TB/.test(e.message),
    );
    assert.equal(t2.server.sessions, 0, '22TB: tornaya tek baglanti bile acilmadi');
    assert.equal(t2.library.db.listTransfers({}).length, 0);

    // 11TB ise engellenmez
    t2.machines.push({ id: 'CNC-11', name: 'Torna 11', ip: '127.0.0.1', driverId: 'syntec-remoteapi', controllerModel: '11TB' });
    const r = await t2.files.createFolder({ machineId: 'CNC-11', name: 'YENI', confirm: 'CNC-11' });
    assert.equal(r.status, 'basarili', r.error);
  } finally { await t.kapat(); await t2.kapat(); }
});

test('klasor ac: sunucu MKD\'yi reddederse basarisiz (kayit tutulur); salt okunur sunucuda hicbir sey olusmaz', async () => {
  const t = await kur({ ftp: { failMkd: true } });
  try {
    const r = await t.files.createFolder({ machineId: 'CNC-08', name: 'YENI', confirm: 'CNC-08' });
    assert.equal(r.status, 'basarisiz');
    assert.match(r.error, /MKD: beklenmeyen yanıt: 550/);
    assert.equal(r.steps.at(-1).step, 'klasor-ac');
    assert.equal(r.steps.at(-1).ok, false);
    assert.ok(!t.server.exists('YENI'));
    assert.deepEqual(t.library.db.getFolders('CNC-08'), [], 'basarisiz: bilinen klasorlere eklenmedi');
  } finally { await t.kapat(); }
});

test('klasor ac: "olustu" denip listede yoksa dogrulanamadi (klasor kayda eklenmez, yorum: elle bakin)', async () => {
  const t = await kur({ ftp: { mkdNoop: true } });
  try {
    const r = await t.files.createFolder({ machineId: 'CNC-08', name: 'HAYALET', confirm: 'CNC-08' });
    assert.equal(r.status, 'dogrulanamadi');
    assert.match(r.error, /kök listesinde görünmüyor/);
    assert.deepEqual(t.library.db.getFolders('CNC-08'), []);
    assert.equal(komutlar(t.server, 'MKD').length, 1);
  } finally { await t.kapat(); }
});

test('klasor ac: ayni tezgaha eszamanli ikinci islem 409; baglanti kopunca basarisiz', async () => {
  const t = await kur({ ftp: { delayMs: 40 } });
  try {
    const bir = t.files.createFolder({ machineId: 'CNC-08', name: 'BIR', confirm: 'CNC-08' });
    await new Promise((r) => setTimeout(r, 30));
    await assert.rejects(() => t.files.createFolder({ machineId: 'CNC-08', name: 'IKI', confirm: 'CNC-08' }), BusyError);
    assert.equal((await bir).status, 'basarili');
    assert.ok(t.server.exists('BIR'));
    assert.ok(!t.server.exists('IKI'));

    await t.server.stop();
    const kopuk = await t.files.createFolder({ machineId: 'CNC-08', name: 'UC', confirm: 'CNC-08' });
    assert.equal(kopuk.status, 'basarisiz', 'bağlantı hatası denetim kaydına basarisiz olarak yazılır (gönderme ile aynı)');
    assert.match(kopuk.error, /bağlantı/);
    assert.equal(t.library.db.listTransfers({}).filter((x) => x.kind === 'klasor').length, 2);
  } finally { await t.library.close(); }
});

test('klasor ac: hicbir kosulda silme komutu (DELE/RMD) gonderilmez ve baska yazma olmaz', async () => {
  const t = await kur({ seed: (s) => s.put('MUSTERI_B/P1', 'x') });
  try {
    await t.files.createFolder({ machineId: 'CNC-08', name: 'A1', confirm: 'CNC-08' });
    await t.files.createFolder({ machineId: 'CNC-08', name: 'MUSTERI_B', confirm: 'CNC-08' }); // reddedilir
    t.server.opts.mkdNoop = true;
    await t.files.createFolder({ machineId: 'CNC-08', name: 'A2', confirm: 'CNC-08' });         // dogrulanamadi
    t.server.opts.failMkd = true;
    await t.files.createFolder({ machineId: 'CNC-08', name: 'A3', confirm: 'CNC-08' });         // basarisiz
    assert.deepEqual(yazma(t.server), ['MKD A1', 'MKD A2', 'MKD A3']);
    assert.ok(t.server.read('MUSTERI_B/P1'), 'var olan dosyaya dokunulmadi');
  } finally { await t.kapat(); }
});

/* ---------------------------------------------------------------------- HTTP */

test('HTTP: POST /api/machines/:id/folders - 200 kayit, hata kodlari (400/403/404/422), kayit listesinde kind=klasor', async () => {
  const t = await kur();
  const t22 = { machines: [...t.machines, { id: 'CNC-22', name: 'Torna 22', ip: '127.0.0.1', driverId: 'syntec-remoteapi', controllerModel: '22TB' }] };
  try {
    const routes = createProgramRoutes({ library: t.library, files: t.files, listMachines: () => t22.machines });
    t.machines.push(t22.machines[1]);
    const server = http.createServer(async (req, res) => {
      if (!(await routes(req, res, new URL(req.url, 'http://x')))) { res.writeHead(404); res.end('{}'); }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (path, obj) => {
      const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    try {
      const ok = await post('/api/machines/CNC-08/folders', { name: 'WEB_MUSTERI', confirm: 'CNC-08', by: 'ayse' });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.status, 'basarili', ok.body.error);
      assert.equal(ok.body.kind, 'klasor');
      assert.ok(t.server.exists('WEB_MUSTERI'));

      const var_ = await post('/api/machines/CNC-08/folders', { name: 'WEB_MUSTERI', confirm: 'CNC-08' });
      assert.equal(var_.status, 200);
      assert.equal(var_.body.status, 'reddedildi');

      assert.equal((await post('/api/machines/CNC-08/folders', { name: 'ŞİRKET', confirm: 'CNC-08' })).status, 400);
      assert.equal((await post('/api/machines/CNC-08/folders', { name: 'X1', confirm: 'yanlis' })).status, 400);
      assert.equal((await post('/api/machines/CNC-99/folders', { name: 'X1', confirm: 'CNC-99' })).status, 404);
      const m22 = await post('/api/machines/CNC-22/folders', { name: 'X1', confirm: 'CNC-22' });
      assert.equal(m22.status, 422);
      assert.match(m22.body.error, /SYNTEC 22TB/);

      const log = await (await fetch(`${base}/api/transfers?machineId=CNC-08`)).json();
      assert.deepEqual(log.transfers.map((x) => [x.kind, x.status]), [['klasor', 'reddedildi'], ['klasor', 'basarili']]);
    } finally { await new Promise((r) => server.close(r)); }
  } finally { await t.kapat(); }
});
