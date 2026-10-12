/**
 * Program editoru (sunucu tarafi): metin <-> bayt cevirisi (satir sonu, kodlama, BOM), kutuphaneye
 * yeni program / yeni surum olarak kaydetme, surum cakismasi ve HTTP ucu.
 *
 * Ilke: ICERIK YORUMLANMAZ. Editor yalnizca metni, kullanicinin sectigi satir sonu ve kodlamayla
 * dosyaya cevirir; kullanicinin dokunmadigi dosya bayt bayt AYNI cikmalidir.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { kur, ORNEK } from './test/harness.js';
import { Library, decodeText, encodeText, validateNewFolderName, sha256, MAX_PROGRAM_BYTES, ValidationError } from './library.js';
import { LibraryDb } from './library-db.js';
import { createProgramRoutes } from './routes.js';

const yeni = () => new Library(':memory:');

/* ------------------------------------------------------------- bayt <-> metin */

test('encodeText: CRLF/LF tek bicime cevrilir, tekil CR de satir sonu sayilir', () => {
  assert.equal(encodeText('a\nb\r\nc\rd', { lineEnding: 'CRLF' }).toString('latin1'), 'a\r\nb\r\nc\r\nd');
  assert.equal(encodeText('a\nb\r\nc\rd', { lineEnding: 'LF' }).toString('latin1'), 'a\nb\nc\nd');
  assert.equal(encodeText('tek satir', { lineEnding: 'CRLF' }).toString('latin1'), 'tek satir', 'satir sonu eklenmez');
});

test('decodeText + encodeText: dokunulmayan dosya BAYT BAYT ayni (CRLF, sondaki bos satirlar, satir sonu bosluklari)', () => {
  const d = decodeText(ORNEK);
  assert.equal(d.encoding, 'utf-8');
  assert.equal(d.lineEnding, 'CRLF');
  assert.ok(encodeText(d.text.replace(/\r\n/g, '\n'), { lineEnding: 'CRLF', encoding: d.encoding, bom: d.bom }).equals(ORNEK));

  const lf = Buffer.from('G0 X0. \nM99\n\n\n');
  const dl = decodeText(lf);
  assert.equal(dl.lineEnding, 'LF');
  assert.ok(encodeText(dl.text, { lineEnding: 'LF' }).equals(lf));
});

test('decodeText: UTF-8 BOM metne girmez ama geri konur; UTF-8 degilse latin1 ve kayipsiz', () => {
  const bomlu = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('G0 X0.\r\n// çğ\r\n', 'utf8')]);
  const d = decodeText(bomlu);
  assert.equal(d.bom, true);
  assert.equal(d.encoding, 'utf-8');
  assert.ok(!d.text.startsWith('﻿'));
  assert.ok(encodeText(d.text, { lineEnding: 'CRLF', encoding: 'utf-8', bom: true }).equals(bomlu));

  const latin = Buffer.from([0x2f, 0x2f, 0x20, 0xe7, 0xfd, 0x0d, 0x0a]); // "// çý" cp1252/latin1
  const dl = decodeText(latin);
  assert.equal(dl.encoding, 'latin1');
  assert.equal(dl.bom, false);
  assert.ok(encodeText(dl.text, { lineEnding: 'CRLF', encoding: 'latin1' }).equals(latin), 'latin1 gidis-donus kayipsiz');
});

test('encodeText: latin1 icinde olmayan karakter SESSIZCE bozulmaz, satir numarasiyla reddedilir', () => {
  assert.throws(
    () => encodeText('G0 X0.\n// ışık\nM99', { encoding: 'latin1' }),
    (e) => e instanceof ValidationError && /Satır 2/.test(e.message) && /ı|ş/.test(e.message),
  );
  assert.ok(encodeText('// ışık', { encoding: 'utf-8' }).length > 7, 'UTF-8 ile sorunsuz');
  assert.throws(() => encodeText('x', { lineEnding: 'CR' }), ValidationError);
  assert.throws(() => encodeText('x', { encoding: 'ascii' }), ValidationError);
  assert.throws(() => encodeText(null), ValidationError);
});

/* --------------------------------------------------------------- yeni klasor adi */

test('validateNewFolderName: dar ASCII kumesi, ayrilmis adlar ve ZZUP/ZZRB reddedilir', () => {
  assert.equal(validateNewFolderName('  MUSTERI_C '), 'MUSTERI_C');
  assert.equal(validateNewFolderName('A-1.b_2'), 'A-1.b_2');
  for (const kotu of ['', ' ', 'ÖZKAN', 'Şirket', 'a/b', 'a\\b', '..', '.gizli', 'bitis.', 'a b', 'a:b', 'x'.repeat(41), 'CON', 'nul.txt', 'COM1', 'ZZUP123', 'zzrb1']) {
    assert.throws(() => validateNewFolderName(kotu), ValidationError, `reddedilmeli: "${kotu}"`);
  }
  assert.equal(validateNewFolderName('x'.repeat(40)).length, 40);
});

/* ------------------------------------------------------------------- kaydetme */

test('saveText: yeni program v1 olur (kaynak editor), ayni ad ikinci kez 409/exists', () => {
  const lib = yeni();
  const r = lib.saveText({ customer: 'AA', name: 'YENI-001', text: 'G0 X0.\nM99\n', lineEnding: 'CRLF', createdBy: 'ayse', note: 'ilk' });
  assert.equal(r.created, true);
  assert.equal(r.newProgram, true);
  assert.equal(r.version.versionNo, 1);
  assert.equal(r.version.source, 'editor');
  assert.equal(r.version.createdBy, 'ayse');
  assert.ok(lib.db.getVersion(r.program.id, 1).content.equals(Buffer.from('G0 X0.\r\nM99\r\n')));

  assert.throws(
    () => lib.saveText({ customer: 'aa', name: 'yeni-001', text: 'baska\n' }),
    (e) => e.status === 409 && e.code === 'exists' && /zaten var/.test(e.message),
    'ad buyuk/kucuk harfe duyarsiz: yanlislikla baska programin surumu olmaz',
  );
  assert.equal(lib.db.listVersions(r.program.id).length, 1);
});

test('saveText: gecersiz ad/musteri/bos/NUL/buyuk reddedilir, kutuphane degismez', () => {
  const lib = yeni();
  assert.throws(() => lib.saveText({ customer: 'AA', name: '../x', text: 'a' }), (e) => e.status === 400);
  assert.throws(() => lib.saveText({ customer: 'a/b', name: 'OK1', text: 'a' }), (e) => e.status === 400);
  assert.throws(() => lib.saveText({ customer: 'AA', name: 'ZZUP111111', text: 'a' }), (e) => e.status === 400);
  assert.throws(() => lib.saveText({ customer: 'AA', name: 'OK2', text: '' }), (e) => e.status === 400);
  assert.throws(() => lib.saveText({ customer: 'AA', name: 'OK3', text: 'a\0b' }), (e) => e.status === 400);
  assert.throws(() => lib.saveText({ customer: 'AA', name: 'OK4', text: 'x'.repeat(MAX_PROGRAM_BYTES + 1) }), (e) => e.status === 413);
  assert.equal(lib.db.listPrograms().length, 0);
});

test('saveText: var olan programin YENI SURUMU; ayni icerik yeni surum acmaz; musteri/ad degismez', () => {
  const lib = yeni();
  const ilk = lib.addUpload({ customer: 'AA', name: 'P1', content: ORNEK, createdBy: 'ali' });
  const d = decodeText(ORNEK);

  const ayni = lib.saveText({ programId: ilk.program.id, baseVersionNo: 1, customer: 'BASKA', name: 'BASKA', text: d.text, lineEnding: d.lineEnding, encoding: d.encoding });
  assert.equal(ayni.created, false, 'dokunulmayan metin = ayni SHA: yeni surum yok');
  assert.equal(ayni.version.versionNo, 1);

  const v2 = lib.saveText({ programId: ilk.program.id, baseVersionNo: 1, customer: 'BASKA', name: 'BASKA', text: `${d.text}\nG4 X0.1`, lineEnding: 'CRLF', createdBy: 'ayse', note: 'bekleme eklendi' });
  assert.equal(v2.created, true);
  assert.equal(v2.newProgram, false);
  assert.equal(v2.version.versionNo, 2);
  assert.equal(v2.program.customer, 'AA', 'istekteki musteri/ad yoksayilir: program kimligi sabit');
  assert.equal(v2.program.name, 'P1');
  assert.equal(v2.version.note, 'bekleme eklendi');
  assert.equal(lib.db.listPrograms().length, 1, 'baska program olusmadi');
  assert.ok(lib.db.getVersion(ilk.program.id, 1).content.equals(ORNEK), 'eski surum aynen duruyor');
});

test('saveText: editor acildiktan sonra baska surum olustuysa 409/newer-version; acceptNewer ile asilir', () => {
  const lib = yeni();
  const a = lib.addUpload({ customer: 'AA', name: 'P1', content: Buffer.from('v1\r\n') });
  lib.saveText({ programId: a.program.id, baseVersionNo: 1, text: 'v2 baska kisi\n' });

  assert.throws(
    () => lib.saveText({ programId: a.program.id, baseVersionNo: 1, text: 'benim v1 degisikligim\n' }),
    (e) => e.status === 409 && e.code === 'newer-version' && /son sürüm v2/.test(e.message) && /v3 olarak/.test(e.message),
  );
  assert.equal(lib.db.listVersions(a.program.id).length, 2, 'cakisan kayit yazilmadi');

  const zorla = lib.saveText({ programId: a.program.id, baseVersionNo: 1, text: 'benim v1 degisikligim\n', acceptNewer: true });
  assert.equal(zorla.version.versionNo, 3);
  assert.throws(() => lib.saveText({ programId: a.program.id, baseVersionNo: 9, text: 'x' }), (e) => e.status === 404);
  assert.throws(() => lib.saveText({ programId: 999, baseVersionNo: 1, text: 'x' }), (e) => e.status === 404);
  assert.throws(() => lib.saveText({ programId: a.program.id, text: 'x' }), (e) => e.status === 404, 'baz surum zorunlu');
});

test('preview: Infinity ile tam metin (kesilmez), encodingId ve bom bildirilir', () => {
  const lib = yeni();
  const uzun = `${'G1 X1. Z-1. F0.2\r\n'.repeat(3000)}M99\r\n`;
  const r = lib.addUpload({ customer: 'AA', name: 'UZUN', content: Buffer.from(uzun, 'latin1') });
  const kesik = lib.preview(r.program.id, 1);
  assert.equal(kesik.truncated, true);
  const tam = lib.preview(r.program.id, 1, Infinity);
  assert.equal(tam.truncated, false);
  assert.equal(tam.text, uzun);
  assert.equal(tam.encodingId, 'utf-8');
  assert.equal(tam.bom, false);
  assert.equal(tam.lineEnding, 'CRLF');
  assert.equal(sha256(encodeText(tam.text, { lineEnding: 'CRLF' })), sha256(Buffer.from(uzun)));
  assert.equal(tam.roundTrip, true, 'tek tip satir sonu: editor birebir geri yazabilir');
  assert.equal(kesik.roundTrip, false, 'kesik metin asla birebir sayilmaz');
});

test('preview.roundTrip: karisik ve tekil CR satir sonu editorde birebir korunamaz, kullanici uyarilabilsin', () => {
  const lib = yeni();
  const karisik = lib.addUpload({ customer: 'AA', name: 'KARISIK', content: Buffer.from('a\r\nb\nc\r\n') });
  assert.equal(lib.preview(karisik.program.id, 1, Infinity).lineEnding, 'karışık');
  assert.equal(lib.preview(karisik.program.id, 1, Infinity).roundTrip, false);

  const cr = lib.addUpload({ customer: 'AA', name: 'ESKI-MAC', content: Buffer.from('a\rb\rc') });
  assert.equal(lib.preview(cr.program.id, 1, Infinity).roundTrip, false);

  const lf = lib.addUpload({ customer: 'AA', name: 'LFTEMIZ', content: Buffer.from('a\nb\n') });
  assert.equal(lib.preview(lf.program.id, 1, Infinity).roundTrip, true);
  const bom = lib.addUpload({ customer: 'AA', name: 'BOMLU', content: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\n')]) });
  assert.equal(lib.preview(bom.program.id, 1, Infinity).roundTrip, true, 'BOM korunur');
  const latin = lib.addUpload({ customer: 'AA', name: 'LATIN', content: Buffer.from([0x61, 0xe7, 0x0d, 0x0a]) });
  assert.equal(lib.preview(latin.program.id, 1, Infinity).roundTrip, true, 'latin1 kayipsiz');
});

/* ---------------------------------------------------------------------- HTTP */

async function api(t, govde) {
  const routes = createProgramRoutes({ library: t.library, files: t.files, listMachines: () => t.machines });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!(await routes(req, res, url))) { res.writeHead(404); res.end('{}'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const j = async (path, init) => { const r = await fetch(base + path, init); return { status: r.status, body: await r.json().catch(() => null) }; };
  try { await govde({ j }); } finally { await new Promise((r) => server.close(r)); }
}
const post = (j, path, obj) => j(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });

test('HTTP: editor kaydi 201/200, 409 govdesinde code, tam onizleme ?full=1, 400/413', async () => {
  const t = await kur();
  try {
    await api(t, async ({ j }) => {
      const a = await post(j, '/api/library/programs/text', { customer: 'AA', name: 'EDIT-001', text: 'G0 X0.\nM99\n', lineEnding: 'CRLF', encoding: 'utf-8', by: 'ayse', note: 'ilk' });
      assert.equal(a.status, 201);
      assert.equal(a.body.version.source, 'editor');
      assert.equal(a.body.version.sha256, sha256(Buffer.from('G0 X0.\r\nM99\r\n')));

      const yine = await post(j, '/api/library/programs/text', { customer: 'AA', name: 'EDIT-001', text: 'baska\n' });
      assert.equal(yine.status, 409);
      assert.equal(yine.body.code, 'exists');

      const id = a.body.program.id;
      const v2 = await post(j, '/api/library/programs/text', { programId: id, baseVersionNo: 1, text: 'G0 X0.\nG4 X1.\nM99\n', lineEnding: 'LF' });
      assert.equal(v2.status, 201);
      assert.equal(v2.body.version.versionNo, 2);
      const ayni = await post(j, '/api/library/programs/text', { programId: id, baseVersionNo: 2, text: 'G0 X0.\nG4 X1.\nM99\n', lineEnding: 'LF' });
      assert.equal(ayni.status, 200, 'ayni icerik: yeni surum yok');
      const eski = await post(j, '/api/library/programs/text', { programId: id, baseVersionNo: 1, text: 'x\n' });
      assert.equal(eski.status, 409);
      assert.equal(eski.body.code, 'newer-version');

      const tam = await j(`/api/library/programs/${id}/versions/2?full=1`);
      assert.equal(tam.body.text, 'G0 X0.\nG4 X1.\nM99\n');
      assert.equal(tam.body.lineEnding, 'LF');
      assert.equal(tam.body.encodingId, 'utf-8');

      assert.equal((await post(j, '/api/library/programs/text', { customer: 'AA', name: 'BAD NAME', text: 'x' })).status, 400);
      assert.equal((await post(j, '/api/library/programs/text', { customer: 'AA', name: 'OK2', text: 'x'.repeat(MAX_PROGRAM_BYTES + 10) })).status, 413);
      const bozuk = await j('/api/library/programs/text', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bozuk' });
      assert.equal(bozuk.status, 400);
    });
  } finally { await t.kapat(); }
});

/* ------------------------------------------------------------ veritabani gecisi */

test('library.db gecisi: kind sutunu olmayan ESKI veritabani acilir, eski kayitlar "gonderme" olur', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cnc-libdb-'));
  const file = join(dir, 'eski.db');
  try {
    const eski = new DatabaseSync(file);
    eski.exec(`CREATE TABLE transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, machine_id TEXT NOT NULL, program_id INTEGER, version_id INTEGER,
      customer TEXT, name TEXT, started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL,
      size INTEGER, sha_sent TEXT, sha_verified TEXT, requested_by TEXT, client_ip TEXT, error TEXT, steps TEXT, acks TEXT)`);
    eski.exec("INSERT INTO transfers (machine_id, customer, name, started_at, status) VALUES ('CNC-08', 'AA', 'P1', 1, 'basarili')");
    eski.close();

    const db = new LibraryDb(file);
    assert.equal(db.getTransfer(1).kind, 'gonderme', 'eski kayit korunur ve gonderme sayilir');
    const id = db.startTransfer({ kind: 'klasor', machineId: 'CNC-08', customer: 'YENI', requestedBy: 'ayse' });
    assert.equal(db.getTransfer(id).kind, 'klasor');
    db.close();
    const yine = new LibraryDb(file); // ikinci acilista gecis tekrar calismamali (ALTER iki kez hata verirdi)
    assert.equal(yine.listTransfers({}).length, 2);
    yine.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
