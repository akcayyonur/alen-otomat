/**
 * Kutuphaneyi flash/USB'ye aktarma: `Library.exportZip` + `GET /api/library/export.zip`.
 * ZIP'in kendi bayt duzeni (store/deflate, CRC) zaten `zip-writer.test.js`'te (ve Windows'un kendi
 * Expand-Archive'iyle elle) dogrulandi; burada yalnizca DOGRU GIRDILERIN (hangi program, hangi yol,
 * HANGI kutuphaneden) paketlendigi sinaniyor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { inflateRawSync } from 'node:zlib';
import { kur, ekle } from './test/harness.js';
import { createProgramRoutes } from './routes.js';

/** Test-only ZIP okuyucu (zip-writer.test.js ile ayni, kucuk ve bagimsiz). */
function readZip(buf) {
  const out = new Map();
  let off = 0;
  while (off < buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 18);
    const rawSize = buf.readUInt32LE(off + 22);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.subarray(off + 30, off + 30 + nameLen).toString('utf8');
    const dataStart = off + 30 + nameLen + extraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    out.set(name, method === 0 ? raw : inflateRawSync(raw));
    assert.equal(out.get(name).length, rawSize);
    off = dataStart + compSize;
  }
  return out;
}

const A = Buffer.from('G00 X0 Y0\r\nM30\r\n');
const B = Buffer.from('G01 X5\r\nM30\r\n');

test('exportZip: kok program koke, musteri klasorlu program kendi klasorune duser; EN SON surum paketlenir', async () => {
  const t = await kur();
  try {
    ekle(t.library, '', 'O9001', A);
    ekle(t.library, 'MUSTERI_A', 'SR001.013', B);
    t.library.addUpload({ customer: 'MUSTERI_A', name: 'SR001.013', content: Buffer.from('G01 X9\r\nM30\r\n'), createdBy: 'ayse' }); // 2. surum

    const zip = t.library.exportZip('ortak');
    const entries = readZip(zip);
    assert.equal(entries.size, 2);
    assert.deepEqual(entries.get('O9001'), A);
    assert.deepEqual(entries.get('MUSTERI_A/SR001.013'), Buffer.from('G01 X9\r\nM30\r\n'), 'eski surum degil, EN SON surum paketlenmeli');
  } finally { await t.kapat(); }
});

test('exportZip: yalniz ISTENEN kutuphanenin programlari paketlenir, digerleri sizmaz', async () => {
  const t = await kur();
  try {
    t.library.addUpload({ library: 'ortak', customer: '', name: 'ORTAK-1', content: A, createdBy: 'ayse' });
    t.library.addUpload({ library: 'CNC-08', customer: '', name: 'OZEL-1', content: B, createdBy: 'ayse' });

    const ortakZip = readZip(t.library.exportZip('ortak'));
    assert.equal(ortakZip.size, 1);
    assert.ok(ortakZip.has('ORTAK-1'));

    const ozelZip = readZip(t.library.exportZip('CNC-08'));
    assert.equal(ozelZip.size, 1);
    assert.ok(ozelZip.has('OZEL-1'));
  } finally { await t.kapat(); }
});

test('exportZip: bos kutuphane icin gecerli (0 girdili) bir ZIP doner', async () => {
  const t = await kur();
  try {
    const zip = t.library.exportZip('ortak');
    assert.equal(readZip(zip).size, 0);
    assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50, 'son kayit (EOCD) imzasi');
  } finally { await t.kapat(); }
});

test('HTTP GET /api/library/export.zip: dogru icerik turu/dosya adiyla ZIP doner, gecersiz kutuphanede 400', async () => {
  const t = await kur();
  try {
    ekle(t.library, 'AA', 'P1', A);

    const routes = createProgramRoutes({ library: t.library, files: t.files, listMachines: () => t.machines });
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://x');
      if (!(await routes(req, res, url))) { res.writeHead(404); res.end('{}'); }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const r = await fetch(`${base}/api/library/export.zip?library=ortak`);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('content-type'), 'application/zip');
      assert.equal(r.headers.get('content-disposition'), 'attachment; filename="ortak-kutuphane.zip"');
      const body = Buffer.from(await r.arrayBuffer());
      const entries = readZip(body);
      assert.deepEqual(entries.get('AA/P1'), A);

      const kotu = await fetch(`${base}/api/library/export.zip?library=BOYLE-BIR-TEZGAH-YOK`);
      assert.equal(kotu.status, 400);
    } finally { await new Promise((r) => server.close(r)); }
  } finally { await t.kapat(); }
});
