import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync, crc32 } from 'node:zlib';
import { buildZip } from './zip-writer.js';

/** Test-only ZIP okuyucu: yalniz bu modulun ciktigi, sirali (yerel basliklar -> merkezi dizin -> son kayit) dosyayi okur. */
function readZip(buf) {
  const out = [];
  let off = 0;
  while (buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8);
    const crc = buf.readUInt32LE(off + 14);
    const compSize = buf.readUInt32LE(off + 18);
    const rawSize = buf.readUInt32LE(off + 22);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.subarray(off + 30, off + 30 + nameLen).toString('utf8');
    const dataStart = off + 30 + nameLen + extraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    const content = method === 0 ? raw : inflateRawSync(raw);
    assert.equal(content.length, rawSize, `${name}: boyut uyusmuyor`);
    assert.equal(crc32(content) >>> 0, crc, `${name}: CRC uyusmuyor`);
    out.push({ name, content });
    off = dataStart + compSize;
  }
  return out;
}

test('bos listede gecerli (bos) bir ZIP uretir', () => {
  const zip = buildZip([]);
  assert.equal(readZip(zip).length, 0);
  // Son kayit (End Of Central Directory) var ve 0 girdi diyor.
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.equal(zip.readUInt16LE(zip.length - 22 + 10), 0);
});

test('kok ve musteri klasorlu dosyalar: icerik ve ad bire bir geri gelir', () => {
  const entries = [
    { path: 'O9001', content: Buffer.from('G00 X0 Y0\r\nM30\r\n') },
    { path: 'MUSTERI_A/SR001.013', content: Buffer.from('%\nO1234\nG90 G00 X10.5\nM30\n%\n') },
  ];
  const zip = buildZip(entries);
  const read = readZip(zip);
  assert.equal(read.length, 2);
  assert.equal(read[0].name, 'O9001');
  assert.deepEqual(read[0].content, entries[0].content);
  assert.equal(read[1].name, 'MUSTERI_A/SR001.013');
  assert.deepEqual(read[1].content, entries[1].content);
});

test('zaten sikisik/kucuk icerik STORE edilir, boyutu BUYUMEZ (deflate sarmalamasi eklemez)', () => {
  const tiny = Buffer.from('A');
  const zip = buildZip([{ path: 'X', content: tiny }]);
  const [entry] = readZip(zip);
  assert.deepEqual(entry.content, tiny);
  // Yerel baslikta method alani (offset 8) 0 (store) olmali: 1 baytlik icerik deflate'le buyur.
  assert.equal(zip.readUInt16LE(8), 0);
});

test('tekrarlayan metin gercekten deflate ile sikistirilir (method=8, kucuk dosya)', () => {
  const repetitive = Buffer.from('G01 X1.0 Y1.0\r\n'.repeat(200));
  const zip = buildZip([{ path: 'BUYUK.NC', content: repetitive }]);
  const [entry] = readZip(zip);
  assert.deepEqual(entry.content, repetitive);
  assert.equal(zip.readUInt16LE(8), 8); // method = deflate
  assert.ok(zip.length < repetitive.length, 'sikistirilmis ZIP, ham icerikten kucuk olmali');
});

test('birden cok dosya: hepsi sirayla ve bozulmadan okunur', () => {
  const entries = Array.from({ length: 12 }, (_, i) => ({
    path: `M${i}/PROGRAM${i}.NC`,
    content: Buffer.from(`O${1000 + i}\nG00 X${i}\nM30\n`),
  }));
  const zip = buildZip(entries);
  const read = readZip(zip);
  assert.equal(read.length, 12);
  for (let i = 0; i < 12; i += 1) {
    assert.equal(read[i].name, entries[i].path);
    assert.deepEqual(read[i].content, entries[i].content);
  }
});
