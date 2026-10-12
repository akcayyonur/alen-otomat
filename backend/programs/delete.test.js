/**
 * Tornadan program SILME (FTP DELE). Geri donusuz oldugu icin kurallar sert; hepsi KODDA zorlanir:
 *   - silme kapisi (modelde deleteEnabled / DELETE_ENABLED) + yazma kapisi (TRANSFER_DISABLED, 22TB)
 *   - onay metni = program adi (birebir)
 *   - calisan program, sistem dosyasi, klasor silinmez; kok dizin ve kutuphane kopyasi yoksa ek onay
 *   - DELE'den hemen once boyut yeniden dogrulanir (yaris), sonra listeden kalktigi dogrulanir
 *   - her deneme (reddedilenler dahil) `transfers` tablosuna kind='silme' ile yazilir
 * Sahte Windows CE FTP sunucusuna karsi; gercek tornada `DELE` HENUZ DENENMEDI (bu yuzden varsayilan KAPALI).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { kur, ekle } from './test/harness.js';
import { sha256, ValidationError } from './library.js';
import { BusyError, DisabledError, UnsupportedError, deletePolicy } from './machine-files.js';
import { createProgramRoutes } from './routes.js';

const ESKI = Buffer.from('//ESKI PROGRAM\r\nG0 X1.\r\nM99\r\n');
const BASKA = Buffer.from('//BASKA ICERIK\r\nG0 X2.\r\nM99\r\n');

const yazma = (s) => s.commands.filter((k) => /^(STOR|RNFR|RNTO|DELE|MKD|XMKD|RMD|XRMD)\b/.test(k));
const silmeler = (s) => s.commands.filter((k) => k.startsWith('DELE'));

async function kurSil(opts = {}) {
  const t = await kur({
    ...opts,
    seed: (s) => {
      s.put('MUSTERI_B/OLD-1', ESKI);
      s.put('MUSTERI_B/OLD-2', ESKI);
      s.put('MUSTERI_B/RACE-1', ESKI);
      s.put('MUSTERI_B/BIG-1', Buffer.alloc(1_100_000, 65));
      s.mkdir('MUSTERI_B/ALT-KLASOR');
      opts.seed?.(s);
    },
  });
  t.files.flags.deleteEnabled = true; // dogrulama bayragi (DELETE_ENABLED=1) gibi
  return t;
}
const sil = (t, ad, ek = {}) => t.files.deleteProgram({ machineId: 'CNC-08', customer: 'MUSTERI_B', name: ad, confirm: ad, by: 'ayse', acks: [], ...ek });

/* ------------------------------------------------------------------------- kapilar */

test('deletePolicy: varsayilan KAPALI (11TB dahil), bayrakla acilir, 22TB bayrakla bile kapali', () => {
  const m11 = { id: 'A', driverId: 'syntec-remoteapi', controllerModel: '11TB' };
  const m22 = { id: 'B', driverId: 'syntec-remoteapi', controllerModel: '22TB' };
  const kapali = deletePolicy(m11, {});
  assert.equal(kapali.allowed, false);
  assert.match(kapali.reason, /DELE\) gerçek tezgahta henüz denenmedi/);
  assert.equal(deletePolicy(m11, { deleteEnabled: true }).allowed, true);
  const p22 = deletePolicy(m22, { deleteEnabled: true });
  assert.equal(p22.allowed, false, 'once yazma kapisindan gecmeli: 22TB yazmaya kapali');
  assert.match(p22.reason, /22TB|doğrulanmadı/);
});

test('kapali silme: on kontrol "engel" verir, deleteProgram 422; tornaya HIC baglanilmaz', async () => {
  const t = await kur({ seed: (s) => s.put('MUSTERI_B/OLD-1', ESKI) });
  try {
    const pre = await t.files.deletePrecheck({ machineId: 'CNC-08', customer: 'MUSTERI_B', name: 'OLD-1' });
    assert.equal(pre.canDelete, false);
    assert.equal(pre.checks[0].id, 'model');
    assert.match(pre.checks[0].title, /tornadan silme kapalı/);
    await assert.rejects(() => sil(t, 'OLD-1'), UnsupportedError);
    assert.equal(t.server.sessions, 0, 'kapida durdu: FTP oturumu acilmadi');
    assert.ok(t.server.exists('MUSTERI_B/OLD-1'));
  } finally { await t.kapat(); }
});

test('TRANSFER_DISABLED ve 22TB: silme acik bayragiyla bile reddedilir, tornaya baglanilmaz', async () => {
  const t = await kurSil({ disabled: true });
  const t2 = await kurSil();
  try {
    await assert.rejects(() => sil(t, 'OLD-1'), DisabledError);
    assert.equal((await t.files.deletePrecheck({ machineId: 'CNC-08', customer: 'MUSTERI_B', name: 'OLD-1' })).checks[0].id, 'ozellik');
    assert.equal(t.server.sessions, 0);

    t2.machines.push({ id: 'CNC-22', name: 'Torna 22', ip: '127.0.0.1', driverId: 'syntec-remoteapi', controllerModel: '22TB' });
    await assert.rejects(() => t2.files.deleteProgram({ machineId: 'CNC-22', customer: 'MUSTERI_B', name: 'OLD-1', confirm: 'OLD-1' }), UnsupportedError);
    assert.equal(t2.server.sessions, 0);
  } finally { await t.kapat(); await t2.kapat(); }
});

test('onay metni program adiyla BIREBIR ayni olmali; gecersiz ad reddedilir; tornaya baglanilmaz', async () => {
  const t = await kurSil();
  try {
    for (const confirm of ['old-1', 'OLD-1 ', '', 'CNC-08', 'onay']) {
      await assert.rejects(() => t.files.deleteProgram({ machineId: 'CNC-08', customer: 'MUSTERI_B', name: 'OLD-1', confirm }), ValidationError, `"${confirm}"`);
    }
    for (const ad of ['', '..', 'a/b', 'a\\b', 'x\r\ny']) {
      await assert.rejects(() => t.files.deleteProgram({ machineId: 'CNC-08', customer: 'MUSTERI_B', name: ad, confirm: ad }), ValidationError, `"${ad}"`);
    }
    assert.equal(t.server.sessions, 0);
  } finally { await t.kapat(); }
});

/* ----------------------------------------------------------------------- basari yolu */

test('silme: kutuphanede ayni icerikli kopya varsa SORUSUZ silinir; tek DELE; kayit, envanter, SHA', async () => {
  const t = await kurSil();
  try {
    ekle(t.library, 'MUSTERI_B', 'OLD-1', ESKI);
    await t.files.scan('CNC-08');
    assert.ok(t.library.db.getInventory('CNC-08').some((e) => e.name === 'OLD-1'));

    const pre = await t.files.deletePrecheck({ machineId: 'CNC-08', customer: 'MUSTERI_B', name: 'OLD-1' });
    assert.equal(pre.canDelete, true, JSON.stringify(pre.checks));
    assert.deepEqual(pre.needsAck, []);
    assert.equal(pre.libraryCopy.versionNo, 1);
    assert.equal(yazma(t.server).length, 0, 'on kontrol yazmaz');

    const r = await sil(t, 'OLD-1');
    assert.equal(r.status, 'basarili', r.error);
    assert.equal(r.kind, 'silme');
    assert.equal(r.customer, 'MUSTERI_B');
    assert.equal(r.name, 'OLD-1');
    assert.equal(r.requestedBy, 'ayse');
    assert.equal(r.shaVerified, sha256(ESKI), 'silinen icerigin SHA-256\'si kayitta');
    assert.deepEqual(r.steps.map((x) => [x.step, x.ok]), [['on-kontrol', true], ['silme', true], ['silme-dogrula', true]]);

    assert.ok(!t.server.exists('MUSTERI_B/OLD-1'), 'torna dosyasi silindi');
    assert.ok(t.server.exists('MUSTERI_B/OLD-2'), 'baska dosyaya dokunulmadi');
    assert.deepEqual(yazma(t.server), ['DELE OLD-1'], 'tornaya YALNIZ tek DELE gitti');
    assert.ok(!t.library.db.getInventory('CNC-08').some((e) => e.name === 'OLD-1'), 'envanterden kalkti');
    assert.equal(t.library.db.listVersions(t.library.db.findProgram('MUSTERI_B', 'OLD-1').id).length, 1, 'kutuphane kopyasi duruyor');
    assert.equal(t.library.db.listTransfers({}).filter((x) => x.kind === 'silme').length, 1);
  } finally { await t.kapat(); }
});

test('silme: kutuphanedeki ESKI bir surumle ayni icerik de yeterli kopyadir', async () => {
  const t = await kurSil();
  try {
    ekle(t.library, 'MUSTERI_B', 'OLD-1', ESKI);
    ekle(t.library, 'MUSTERI_B', 'OLD-1', BASKA); // v2 = son surum
    const pre = await t.files.deletePrecheck({ machineId: 'CNC-08', customer: 'MUSTERI_B', name: 'OLD-1' });
    assert.equal(pre.canDelete, true);
    assert.match(pre.checks.find((k) => k.id === 'kopya').title, /v1/);
    assert.match(pre.checks.find((k) => k.id === 'kopya').detail, /son sürüm v2/);
  } finally { await t.kapat(); }
});

/* ------------------------------------------------------------- kopya ve onay kurallari */

test('kutuphanede kopya YOKSA "no-backup" onayi sart: onaysiz reddedilir (dosya durur), onayla silinir', async () => {
  const t = await kurSil();
  try {
    const r1 = await sil(t, 'OLD-1');
    assert.equal(r1.status, 'reddedildi');
    assert.match(r1.error, /kopyası yok/);
    assert.ok(t.server.exists('MUSTERI_B/OLD-1'));
    assert.equal(silmeler(t.server).length, 0, 'reddedilen islemde DELE gitmez');

    const r2 = await sil(t, 'OLD-1', { acks: ['no-backup'] });
    assert.equal(r2.status, 'basarili', r2.error);
    assert.ok(!t.server.exists('MUSTERI_B/OLD-1'));
    assert.deepEqual(t.library.db.listTransfers({}).map((x) => x.status).reverse(), ['reddedildi', 'basarili'], 'reddedilen de kayitta');
  } finally { await t.kapat(); }
});

test('kutuphanede ayni ad var ama ICERIK farkliysa (bu hal kaybolur) yine "no-backup" onayi ister', async () => {
  const t = await kurSil();
  try {
    ekle(t.library, 'MUSTERI_B', 'OLD-1', BASKA);
    const pre = await t.files.deletePrecheck({ machineId: 'CNC-08', customer: 'MUSTERI_B', name: 'OLD-1' });
    assert.equal(pre.canDelete, false);
    assert.deepEqual(pre.needsAck, ['no-backup']);
    assert.match(pre.checks.find((k) => k.id === 'kopya').title, /hiçbir sürümle içerik tutmuyor/);
    assert.equal((await sil(t, 'OLD-1')).status, 'reddedildi');
    assert.equal((await sil(t, 'OLD-1', { acks: ['no-backup'] })).status, 'basarili');
  } finally { await t.kapat(); }
});

test('1 MB\'tan buyuk dosya: kopya dogrulanamaz -> "no-backup" onayi; icerik indirilmez', async () => {
  const t = await kurSil();
  try {
    const pre = await t.files.deletePrecheck({ machineId: 'CNC-08', customer: 'MUSTERI_B', name: 'BIG-1' });
    assert.deepEqual(pre.needsAck, ['no-backup']);
    assert.equal(t.server.commands.filter((k) => k.startsWith('RETR')).length, 0, 'buyuk dosya indirilmedi');
    assert.equal((await sil(t, 'BIG-1', { acks: ['no-backup'] })).status, 'basarili');
  } finally { await t.kapat(); }
});

test('calisan/secili program SILINMEZ (ad buyuk/kucuk harf ve klasor yolu fark etmez)', async () => {
  const t = await kurSil({ live: { connected: true, state: 'RUNNING', program: 'MUSTERI_B\\old-1', mainProgram: 'X-ANA' } });
  try {
    ekle(t.library, 'MUSTERI_B', 'OLD-1', ESKI);
    const pre = await t.files.deletePrecheck({ machineId: 'CNC-08', customer: 'MUSTERI_B', name: 'OLD-1' });
    assert.equal(pre.canDelete, false);
    assert.equal(pre.checks.find((k) => k.level === 'block').id, 'calisan-program');
    const r = await sil(t, 'OLD-1', { acks: ['no-backup', 'unknown-state', 'root-target'] });
    assert.equal(r.status, 'reddedildi', 'hicbir onay engeli asamaz');
    assert.ok(t.server.exists('MUSTERI_B/OLD-1'));
    assert.equal(silmeler(t.server).length, 0);
    assert.equal((await sil(t, 'OLD-2', { acks: ['no-backup'] })).status, 'basarili', 'baska program silinebilir');
  } finally { await t.kapat(); }
});

test('canli veri yoksa (ajan kapali) "unknown-state" onayi ister', async () => {
  const t = await kurSil({ live: null });
  try {
    ekle(t.library, 'MUSTERI_B', 'OLD-1', ESKI);
    const pre = await t.files.deletePrecheck({ machineId: 'CNC-08', customer: 'MUSTERI_B', name: 'OLD-1' });
    assert.deepEqual(pre.needsAck, ['unknown-state']);
    assert.equal((await sil(t, 'OLD-1')).status, 'reddedildi');
    assert.equal((await sil(t, 'OLD-1', { acks: ['unknown-state'] })).status, 'basarili');
  } finally { await t.kapat(); }
});

/* -------------------------------------------------------------------------- engeller */

test('sistem dosyasi (MDIBlock), klasor, olmayan dosya ve olmayan klasor silinemez; hicbir onay asamaz', async () => {
  const t = await kurSil();
  try {
    const hepsi = ['no-backup', 'root-target', 'unknown-state'];
    const dene = async (customer, name) => t.files.deleteProgram({ machineId: 'CNC-08', customer, name, confirm: name, acks: hepsi });

    const sistem = await dene('', 'MDIBlock');
    assert.equal(sistem.status, 'reddedildi');
    assert.match(sistem.error, /tezgahın kendi dosyası/);
    const klasor = await dene('MUSTERI_B', 'ALT-KLASOR');
    assert.equal(klasor.status, 'reddedildi');
    assert.match(klasor.error, /klasör/);
    const yok = await dene('MUSTERI_B', 'OLMAYAN');
    assert.match(yok.error, /dosyası yok/);
    const yokKlasor = await dene('YOKKLASOR', 'X');
    assert.match(yokKlasor.error, /klasörü yok/);
    assert.equal(silmeler(t.server).length, 0, 'bunlarin hicbirinde DELE gitmedi');
    assert.ok(t.server.exists('MDIBlock'));
    assert.ok(t.server.exists('MUSTERI_B/ALT-KLASOR'));
  } finally { await t.kapat(); }
});

test('kok dizindeki (ortak alan) dosya: "root-target" onayi ister', async () => {
  const t = await kurSil();
  try {
    ekle(t.library, '', 'O9001', Buffer.from('M99\r\n', 'latin1'));
    const pre = await t.files.deletePrecheck({ machineId: 'CNC-08', customer: '', name: 'O9001' });
    assert.equal(pre.canDelete, false);
    assert.deepEqual(pre.needsAck, ['root-target']);
    const r1 = await t.files.deleteProgram({ machineId: 'CNC-08', customer: '', name: 'O9001', confirm: 'O9001' });
    assert.equal(r1.status, 'reddedildi');
    assert.ok(t.server.exists('O9001'));
    const r2 = await t.files.deleteProgram({ machineId: 'CNC-08', customer: '', name: 'O9001', confirm: 'O9001', acks: ['root-target'] });
    assert.equal(r2.status, 'basarili', r2.error);
    assert.ok(!t.server.exists('O9001'));
  } finally { await t.kapat(); }
});

/* ------------------------------------------------------------- yaris / hata / dogrulama */

test('YARIS: dosya on kontrolden sonra degisirse (boyut) silinmez, DELE gitmez', async () => {
  const t = await kurSil({
    ftp: { afterRetr: (srv, cwd, ad) => { if (ad === 'RACE-1') srv.put('MUSTERI_B/RACE-1', 'operator panelden degistirdi, artik cok daha uzun bir icerik'); } },
  });
  try {
    const r = await sil(t, 'RACE-1', { acks: ['no-backup'] });
    assert.equal(r.status, 'basarisiz');
    assert.match(r.error, /bu arada değişti/);
    assert.equal(silmeler(t.server).length, 0);
    assert.match(t.server.read('MUSTERI_B/RACE-1').toString('latin1'), /operator panelden/, 'degisen dosya korundu');
  } finally { await t.kapat(); }
});

test('torna DELE\'yi reddederse (550) basarisiz; dosya, envanter ve kutuphane degismez', async () => {
  const t = await kurSil({ ftp: { readOnly: true } });
  try {
    ekle(t.library, 'MUSTERI_B', 'OLD-1', ESKI);
    t.library.db.upsertInventory('CNC-08', { customer: 'MUSTERI_B', name: 'OLD-1', size: ESKI.length, sha256: sha256(ESKI) });
    const r = await sil(t, 'OLD-1');
    assert.equal(r.status, 'basarisiz');
    assert.match(r.error, /DELE: beklenmeyen yanıt: 550/);
    assert.equal(r.steps.at(-1).step, 'silme');
    assert.equal(r.steps.at(-1).ok, false);
    assert.ok(t.server.exists('MUSTERI_B/OLD-1'));
    assert.ok(t.library.db.getInventory('CNC-08').some((e) => e.name === 'OLD-1'), 'envanter dokunulmadi');
  } finally { await t.kapat(); }
});

test('"silindi" denip dosya listede duruyorsa: dogrulanamadi (envanter DEGISMEZ, elle kontrol uyarisi)', async () => {
  const t = await kurSil({ ftp: { deleNoop: true } });
  try {
    t.library.db.upsertInventory('CNC-08', { customer: 'MUSTERI_B', name: 'OLD-1', size: ESKI.length, sha256: sha256(ESKI) });
    const r = await sil(t, 'OLD-1', { acks: ['no-backup'] });
    assert.equal(r.status, 'dogrulanamadi');
    assert.match(r.error, /listede duruyor/);
    assert.ok(t.library.db.getInventory('CNC-08').some((e) => e.name === 'OLD-1'));
  } finally { await t.kapat(); }
});

test('ayni tezgahta eszamanli ikinci islem 409; baglanti kopunca basarisiz kayit', async () => {
  const t = await kurSil({ ftp: { delayMs: 40 } });
  try {
    const bir = sil(t, 'OLD-1', { acks: ['no-backup'] });
    await new Promise((r) => setTimeout(r, 30));
    await assert.rejects(() => sil(t, 'OLD-2', { acks: ['no-backup'] }), BusyError);
    assert.equal((await bir).status, 'basarili');
    assert.ok(t.server.exists('MUSTERI_B/OLD-2'));

    await t.server.stop();
    const kopuk = await sil(t, 'OLD-2', { acks: ['no-backup'] });
    assert.equal(kopuk.status, 'basarisiz');
    assert.match(kopuk.error, /bağlantı/);
  } finally { await t.library.close(); }
});

/* ---------------------------------------------------------------------------- HTTP */

test('HTTP: on kontrol/silme uclari, 400 onay, 422 kapali, config\'te deleteAllowed', async () => {
  const t = await kur({ seed: (s) => s.put('MUSTERI_B/OLD-1', ESKI) });
  const routes = createProgramRoutes({ library: t.library, files: t.files, listMachines: () => t.machines });
  const server = http.createServer(async (req, res) => {
    if (!(await routes(req, res, new URL(req.url, 'http://x')))) { res.writeHead(404); res.end('{}'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const j = async (path, init) => { const r = await fetch(base + path, init); return { status: r.status, body: await r.json().catch(() => null) }; };
  const post = (path, obj) => j(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  try {
    ekle(t.library, 'MUSTERI_B', 'OLD-1', ESKI);
    assert.equal((await j('/api/library/config')).body.machines[0].deleteAllowed, false);
    const kapali = await post('/api/machines/CNC-08/programs/delete', { customer: 'MUSTERI_B', name: 'OLD-1', confirm: 'OLD-1' });
    assert.equal(kapali.status, 422);
    assert.match(kapali.body.error, /silme|DELE/);

    t.files.flags.deleteEnabled = true;
    const cfg = (await j('/api/library/config')).body.machines[0];
    assert.equal(cfg.deleteAllowed, true);
    assert.equal(cfg.deleteBlockedReason, null);

    const pre = await post('/api/machines/CNC-08/programs/delete-precheck', { customer: 'MUSTERI_B', name: 'OLD-1' });
    assert.equal(pre.status, 200);
    assert.equal(pre.body.canDelete, true);
    const yanlis = await post('/api/machines/CNC-08/programs/delete', { customer: 'MUSTERI_B', name: 'OLD-1', confirm: 'yanlis' });
    assert.equal(yanlis.status, 400);
    assert.match(yanlis.body.error, /OLD-1/);
    assert.equal((await post('/api/machines/CNC-99/programs/delete', { name: 'X', confirm: 'X' })).status, 404);

    const ok = await post('/api/machines/CNC-08/programs/delete', { customer: 'MUSTERI_B', name: 'OLD-1', confirm: 'OLD-1', by: 'ayse' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, 'basarili', ok.body.error);
    assert.equal(ok.body.kind, 'silme');
    assert.ok(!t.server.exists('MUSTERI_B/OLD-1'));
    const log = await j('/api/transfers?machineId=CNC-08');
    assert.equal(log.body.transfers[0].kind, 'silme');
  } finally {
    await new Promise((r) => server.close(r));
    await t.kapat();
  }
});
