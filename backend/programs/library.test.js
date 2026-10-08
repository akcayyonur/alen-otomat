/**
 * Kutuphane kurallari: ad/musteri/icerik dogrulamasi, surumleme, karsilastirma durumlari.
 * Icerik YORUMLANMAZ: yalnizca bayt ve SHA-256.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Library, ValidationError, MAX_PROGRAM_BYTES, compareEntry, sha256,
  validateProgramName, validateCustomer, validateContent,
} from './library.js';
import { ORNEK } from './test/harness.js';

test('program adi: gercek tezgah adlari gecer, tehlikeli adlar reddedilir', () => {
  for (const ad of ['ORNEK-013', '100200300', 'O0179', '11-1', '2', 'MUSTERI-001', 'A1ORNEKPROG']) {
    assert.equal(validateProgramName(ad), ad);
  }
  for (const ad of ['', ' ', 'a/b', '..', '.', 'a\\b', 'a b', 'x'.repeat(41), 'ZZUP123456', 'zzup1', 'ZZRB9', 'a\r\nDELE b', 'ğüş']) {
    assert.throws(() => validateProgramName(ad), ValidationError, `reddedilmeli: ${JSON.stringify(ad)}`);
  }
  assert.equal(validateProgramName('  ORNEK  '), 'ORNEK', 'kenar bosluklari kirpilir');
});

test('musteri klasoru: bos = kok, yol ayiraci/kontrol karakteri reddedilir', () => {
  assert.equal(validateCustomer(''), '');
  assert.equal(validateCustomer('MUSTERI_B'), 'MUSTERI_B');
  assert.equal(validateCustomer('MUSTERI A'), 'MUSTERI A');
  assert.equal(validateCustomer('MUSTERI-002'), 'MUSTERI-002');
  for (const c of ['a/b', 'a\\b', '..', '.', ' A', 'A ', 'a\r\nb', 'a:b', 'x'.repeat(65)]) {
    assert.throws(() => validateCustomer(c), ValidationError, `reddedilmeli: ${JSON.stringify(c)}`);
  }
});

test('icerik: bos, buyuk ve ikili dosya reddedilir; CRLF ve sondaki bosluklar korunur', () => {
  assert.throws(() => validateContent(Buffer.alloc(0)), ValidationError);
  assert.throws(() => validateContent(Buffer.from('a\0b')), /ikili/);
  assert.throws(() => validateContent(Buffer.alloc(MAX_PROGRAM_BYTES + 1, 65)), (e) => e.status === 413);
  assert.doesNotThrow(() => validateContent(ORNEK));
});

test('kutuphane: ilk yukleme v1, ayni icerik yeni surum acmaz, degisen icerik v2', () => {
  const lib = new Library(':memory:');
  const a = lib.addUpload({ customer: 'MUSTERI_B', name: '100200300', content: ORNEK, createdBy: 'ayse' });
  assert.equal(a.created, true);
  assert.equal(a.newProgram, true);
  assert.equal(a.version.versionNo, 1);
  assert.equal(a.version.sha256, sha256(ORNEK));
  assert.equal(a.version.size, ORNEK.length);

  const same = lib.addUpload({ customer: 'MUSTERI_B', name: '100200300', content: Buffer.from(ORNEK) });
  assert.equal(same.created, false, 'ayni icerik: yeni surum yok');
  assert.equal(same.version.versionNo, 1);

  const changed = lib.addUpload({ customer: 'MUSTERI_B', name: '100200300', content: Buffer.concat([ORNEK, Buffer.from('M30\r\n')]) });
  assert.equal(changed.created, true);
  assert.equal(changed.newProgram, false);
  assert.equal(changed.version.versionNo, 2);
  assert.equal(lib.db.listVersions(a.program.id).length, 2);
  lib.close();
});

test('kutuphane: kimlik (musteri, ad) ve buyuk/kucuk harf duyarsiz; baska musteri = baska program', () => {
  const lib = new Library(':memory:');
  const a = lib.addUpload({ customer: 'MUSTERI_B', name: 'ORNEK-013', content: ORNEK });
  const b = lib.addUpload({ customer: 'musteri_b', name: 'ornek-013', content: ORNEK });
  assert.equal(b.program.id, a.program.id, 'CE dosya sistemi gibi harf duyarsiz');
  const c = lib.addUpload({ customer: 'MUSTERI_A', name: 'ORNEK-013', content: ORNEK });
  assert.notEqual(c.program.id, a.program.id);
  const d = lib.addUpload({ customer: '', name: 'ORNEK-013', content: ORNEK });
  assert.notEqual(d.program.id, a.program.id, 'kok (musterisiz) ayri program');
  assert.deepEqual(lib.customers(), ['MUSTERI_A', 'MUSTERI_B']);
  lib.close();
});

test('onizleme: satir sonu bilgisi ve kesme; icerik degistirilmez', () => {
  const lib = new Library(':memory:');
  const { program } = lib.addUpload({ customer: 'MUSTERI_B', name: 'X1', content: ORNEK });
  const p = lib.preview(program.id, 1);
  assert.equal(p.lineEnding, 'CRLF');
  assert.ok(p.text.startsWith('//100200300'));
  assert.equal(p.truncated, false);
  assert.equal(lib.preview(program.id, 1, 10).truncated, true);
  // DB'deki icerik gonderilen baytlarla ayni.
  assert.ok(lib.db.getVersion(program.id, 1).content.equals(ORNEK));
  lib.close();
});

test('compareEntry: guncel / eski / farkli / kutuphanede-yok / belirsiz', () => {
  const v = [
    { versionNo: 1, sha256: 'aaa', size: 100 },
    { versionNo: 2, sha256: 'bbb', size: 120 },
  ];
  assert.deepEqual(compareEntry({ size: 120, sha256: 'bbb' }, v), { status: 'guncel', versionNo: 2, latestVersion: 2 });
  assert.deepEqual(compareEntry({ size: 100, sha256: 'aaa' }, v), { status: 'eski', versionNo: 1, latestVersion: 2 });
  assert.equal(compareEntry({ size: 120, sha256: 'ccc' }, v).status, 'farkli', 'ayni boyut, farkli icerik = farkli');
  assert.equal(compareEntry({ size: 999, sha256: null }, v).status, 'farkli', 'boyut hicbirine tutmuyorsa indirmeden farkli');
  assert.equal(compareEntry({ size: 120, sha256: null }, v).status, 'belirsiz', 'boyut tutuyor, SHA yok');
  assert.equal(compareEntry({ size: 1, sha256: 'x' }, []).status, 'kutuphanede-yok');
});

test('karsilastirma ve matris: tezgah envanterine gore durumlar', () => {
  const lib = new Library(':memory:');
  const a = lib.addUpload({ customer: 'MUSTERI_B', name: 'P1', content: Buffer.from('v1\r\n') });
  lib.addUpload({ customer: 'MUSTERI_B', name: 'P1', content: Buffer.from('v2 yeni\r\n') });
  lib.addUpload({ customer: 'MUSTERI_B', name: 'P2', content: Buffer.from('iki\r\n') });
  lib.addUpload({ customer: 'MUSTERI_A', name: 'P3', content: Buffer.from('uc\r\n') });
  const shaV1 = sha256(Buffer.from('v1\r\n'));
  lib.db.replaceInventory('CNC-08', [
    { customer: 'MUSTERI_B', name: 'P1', size: 4, sha256: shaV1 },                          // eski (v1)
    { customer: 'MUSTERI_B', name: 'P2', size: 77, sha256: null },                          // farkli (boyut hicbirine tutmuyor)
    { customer: 'MUSTERI_B', name: 'ORTAK', size: 10, sha256: null },                       // kutuphanede-yok
    { customer: '', name: 'MDIBlock', size: 22, sha256: null },                        // sistem
  ], { startedAt: 1, finishedAt: 2 });

  const cmp = lib.compareMachine('CNC-08');
  const by = Object.fromEntries(cmp.entries.map((e) => [`${e.customer}/${e.name}`, e]));
  assert.equal(by['MUSTERI_B/P1'].status, 'eski');
  assert.equal(by['MUSTERI_B/P1'].versionNo, 1);
  assert.equal(by['MUSTERI_B/P2'].status, 'farkli');
  assert.equal(by['MUSTERI_B/ORTAK'].status, 'kutuphanede-yok');
  assert.equal(by['/MDIBlock'].status, 'sistem');
  assert.deepEqual(cmp.missing.map((m) => `${m.customer}/${m.name}`), ['MUSTERI_A/P3']);

  const mx = lib.matrix([{ id: 'CNC-08', name: 'T8' }, { id: 'CNC-02', name: 'T2' }]);
  const row = (name) => mx.rows.find((r) => r.name === name);
  assert.equal(row('P1').cells['CNC-08'].status, 'eski');
  assert.equal(row('P3').cells['CNC-08'].status, 'tezgahta-yok');
  assert.equal(row('P1').cells['CNC-02'].status, 'taranmadi', 'hic taranmamis tezgah');
  assert.equal(a.program.id, row('P1').programId);
  lib.close();
});

test('envanter yenileme: basarisiz tarama eski envanteri korur', () => {
  const lib = new Library(':memory:');
  lib.db.replaceInventory('CNC-08', [{ customer: 'MUSTERI_B', name: 'P1', size: 4 }], { startedAt: 1, finishedAt: 2 });
  lib.db.recordScanFailure('CNC-08', { startedAt: 3, finishedAt: 4, error: 'bağlantı koptu' });
  assert.equal(lib.db.getInventory('CNC-08').length, 1, 'envanter silinmemeli');
  assert.equal(lib.db.getScan('CNC-08').status, 'hata');
  assert.equal(lib.db.getScan('CNC-08').entries, 1);
  lib.close();
});
