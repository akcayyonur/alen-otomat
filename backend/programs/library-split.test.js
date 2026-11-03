/**
 * Ortak + makine basina kutuphane bolunmesi: 'ortak' varsayilan kutuphane, her tezgah (CNC-0X) kendi kimligiyle
 * ayri bir kutuphane olabilir. Ayni (musteri, ad) FARKLI kutuphanelerde BAGIMSIZ var olabilir (ayri surumler,
 * ayri yedekler). Eski (bolunmeden onceki) veritabanlari sessizce 'ortak'a goc eder, davranis degismez.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { kur, ekle, ORNEK } from './test/harness.js';
import { Library, ValidationError, DEFAULT_LIBRARY, validateLibrary, sha256 } from './library.js';
import { LibraryDb } from './library-db.js';
import { createProgramRoutes } from './routes.js';

const A = Buffer.from('//A  ORTAK SURUM\r\nG0 X0.\r\nM99\r\n');
const B = Buffer.from('//B  CNC-03 KENDI SURUMU\r\nG0 X9.\r\nM99\r\n');

test('validateLibrary: bos = ortak, bicim denetlenir (varlik denetlenmez - bu HTTP katmaninin isi)', () => {
  assert.equal(validateLibrary(undefined), DEFAULT_LIBRARY);
  assert.equal(validateLibrary(''), DEFAULT_LIBRARY);
  assert.equal(validateLibrary('CNC-03'), 'CNC-03');
  assert.throws(() => validateLibrary('a/b'), ValidationError);
  assert.throws(() => validateLibrary('x'.repeat(33)), ValidationError);
});

test('ayni (musteri, ad) iki FARKLI kutuphanede bagimsiz: ayri icerik, ayri surum sayaci', () => {
  const lib = new Library(':memory:');
  const ortak = lib.addUpload({ library: 'ortak', customer: 'MUSTERI_B', name: 'SR001', content: A, createdBy: 'ayse' });
  const ozel = lib.addUpload({ library: 'CNC-03', customer: 'MUSTERI_B', name: 'SR001', content: B, createdBy: 'ayse' });
  assert.notEqual(ortak.program.id, ozel.program.id, 'ayni ad farkli kutuphanede AYRI program');
  assert.equal(ortak.version.sha256, sha256(A));
  assert.equal(lib.db.getProgram(ortak.program.id).library, 'ortak');
  assert.equal(lib.db.getProgram(ozel.program.id).library, 'CNC-03');

  // Ortak kutuphanede ikinci surum acmak CNC-03'teki programa DOKUNMAZ.
  const v2 = lib.addUpload({ library: 'ortak', customer: 'MUSTERI_B', name: 'SR001', content: Buffer.concat([A, Buffer.from('M30\r\n')]) });
  assert.equal(v2.program.id, ortak.program.id);
  assert.equal(v2.version.versionNo, 2);
  assert.equal(lib.db.listVersions(ozel.program.id).length, 1, 'CNC-03daki surum etkilenmedi');
  lib.close();
});

test('findProgram / saveText / renameProgram kutuphaneye gore kapsanir', () => {
  const lib = new Library(':memory:');
  lib.addUpload({ library: 'ortak', customer: 'AA', name: 'P1', content: A });
  lib.addUpload({ library: 'CNC-01', customer: 'AA', name: 'P1', content: B });

  assert.ok(lib.db.findProgram('ortak', 'AA', 'P1'));
  assert.ok(lib.db.findProgram('CNC-01', 'AA', 'P1'));
  assert.equal(lib.db.findProgram('CNC-02', 'AA', 'P1'), null, 'baska kutuphanede yok');

  // saveText: CNC-01'de "AA/P1" zaten var oldugu icin YENI PROGRAM olarak CNC-01'e acilamaz (409), ama ORTAK'ta serbest degil (o da dolu) - CNC-02'de serbest.
  assert.throws(() => lib.saveText({ library: 'CNC-01', customer: 'AA', name: 'P1', text: 'x\n' }), (e) => e.code === 'exists');
  const yeni = lib.saveText({ library: 'CNC-02', customer: 'AA', name: 'P1', text: 'G0 X0.\nM99\n', createdBy: 'ayse' });
  assert.equal(yeni.created, true);
  assert.equal(lib.db.getProgram(yeni.program.id).library, 'CNC-02');

  // renameProgram: CNC-01'deki P1'i AYNI kutuphanede P2 yapmak, ORTAK'taki P1'le CATISMAZ (farkli kutuphane).
  const cnc01 = lib.db.findProgram('CNC-01', 'AA', 'P1');
  const renamed = lib.renameProgram({ id: cnc01.id, newName: 'P2' });
  assert.equal(renamed.renamed, true);
  assert.ok(lib.db.findProgram('CNC-01', 'AA', 'P2'));
  assert.ok(lib.db.findProgram('ortak', 'AA', 'P1'), 'ortaktaki P1 etkilenmedi');
  lib.close();
});

test('listPrograms: library filtreler, library:null TUM kutuphaneleri verir', () => {
  const lib = new Library(':memory:');
  lib.addUpload({ library: 'ortak', customer: 'AA', name: 'P1', content: A });
  lib.addUpload({ library: 'CNC-01', customer: 'AA', name: 'P1', content: B });
  lib.addUpload({ library: 'CNC-02', customer: 'BB', name: 'P2', content: A });

  assert.equal(lib.db.listPrograms({ library: 'ortak' }).length, 1);
  assert.equal(lib.db.listPrograms({ library: 'CNC-01' }).length, 1);
  assert.equal(lib.db.listPrograms({ library: 'CNC-09' }).length, 0, 'hic programi olmayan kutuphane bos liste');
  assert.equal(lib.db.listPrograms({ library: null }).length, 3, 'library:null kutuphane sinirlamasi yok');
  lib.close();
});

test('backup (toplu gonderimde ezilen eski hal) kutuphaneye gore ayri saklanir ve geri alinir', () => {
  const lib = new Library(':memory:');
  const a = lib.db.addBackup({ library: 'ortak', customer: 'AA', name: 'P1', machineId: 'CNC-08', content: A, sha256: sha256(A), createdBy: 'ayse' });
  const b = lib.db.addBackup({ library: 'CNC-03', customer: 'AA', name: 'P1', machineId: 'CNC-03', content: B, sha256: sha256(B), createdBy: 'ayse' });
  assert.notEqual(a.id, b.id, 'ayni (musteri,ad) farkli kutuphanede ayri yedek');
  assert.equal(lib.db.listBackups('ortak', 'AA', 'P1').length, 1);
  assert.equal(lib.db.listBackups('CNC-03', 'AA', 'P1').length, 1);

  const restored = lib.restoreBackup({ id: b.id, by: 'ayse' });
  assert.equal(restored.created, true);
  assert.equal(lib.db.getProgram(restored.program.id).library, 'CNC-03', 'yedek AIT OLDUGU kutuphaneye doner');
  lib.close();
});

test('compareMachine / matrix: belirtilen kutuphaneye gore calisir, baska kutuphanedeki ayni adli program karismaz', async () => {
  const t = await kur();
  try {
    ekle(t.library, 'MUSTERI_B', 'ORTAK-1', ORNEK); // varsayilan 'ortak'
    t.library.addUpload({ library: 'CNC-08', customer: 'MUSTERI_B', name: 'OZEL-1', content: ORNEK, createdBy: 'test' });
    await t.files.scan('CNC-08', 'ortak'); // sahte sunucuda 100200300/O9001 var; 'ortak' kutuphanesine gore karsilastir

    const ortakGorunum = t.library.compareMachine('CNC-08', 'ortak');
    assert.equal(ortakGorunum.library, 'ortak');
    const ozelGorunum = t.library.compareMachine('CNC-08', 'CNC-08');
    assert.equal(ozelGorunum.missing.some((p) => p.name === 'OZEL-1'), true, "CNC-08 kutuphanesindeki OZEL-1 tezgahta yok (henuz gonderilmedi) -> 'missing'");
    assert.equal(ortakGorunum.missing.some((p) => p.name === 'OZEL-1'), false, "ortak gorunumunde OZEL-1 hic yok (baska kutuphanede)");

    const matrisOrtak = t.library.matrix(t.machines, 'ortak');
    assert.equal(matrisOrtak.library, 'ortak');
    assert.equal(matrisOrtak.rows.some((r) => r.name === 'OZEL-1'), false);
    const matrisOzel = t.library.matrix(t.machines, 'CNC-08');
    assert.equal(matrisOzel.rows.some((r) => r.name === 'OZEL-1'), true);
  } finally { await t.kapat(); }
});

test('HTTP: ?library= gecersizse 400, gecerliyse (ortak ya da gercek tezgah kimligi) o kutuphaneyi suzer', async () => {
  const t = await kur();
  try {
    t.library.addUpload({ library: 'ortak', customer: 'AA', name: 'P1', content: A, createdBy: 'ayse' });
    t.library.addUpload({ library: 'CNC-08', customer: 'AA', name: 'P1', content: B, createdBy: 'ayse' });

    const routes = createProgramRoutes({ library: t.library, files: t.files, listMachines: () => t.machines });
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://x');
      if (!(await routes(req, res, url))) { res.writeHead(404); res.end('{}'); }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const j = async (path) => { const r = await fetch(base + path); return { status: r.status, body: await r.json().catch(() => null) }; };
    try {
      const yanlis = await j('/api/library/programs?library=BOYLE-BIR-TEZGAH-YOK');
      assert.equal(yanlis.status, 400);

      const ortak = await j('/api/library/programs?library=ortak');
      assert.equal(ortak.status, 200);
      assert.equal(ortak.body.programs.length, 1);
      assert.equal(ortak.body.programs[0].library, 'ortak');

      const ozel = await j('/api/library/programs?library=CNC-08');
      assert.equal(ozel.status, 200);
      assert.equal(ozel.body.programs.length, 1);
      assert.equal(ozel.body.programs[0].library, 'CNC-08');

      const varsayilan = await j('/api/library/programs');
      assert.equal(varsayilan.body.programs.length, 1, 'library verilmezse varsayilan "ortak"');
    } finally { await new Promise((r) => server.close(r)); }
  } finally { await t.kapat(); }
});

test('veritabani gecisi: library sutunu olmayan ESKI programs/program_backups tablosu acilir, kayitlar "ortak" olur, kimlikler (ve FK) korunur', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cnc-libsplit-'));
  const file = join(dir, 'eski.db');
  try {
    const eski = new DatabaseSync(file);
    eski.exec(`CREATE TABLE programs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, customer TEXT NOT NULL COLLATE NOCASE, name TEXT NOT NULL COLLATE NOCASE,
      note TEXT, created_at INTEGER NOT NULL, UNIQUE (customer, name))`);
    eski.exec(`CREATE TABLE program_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, program_id INTEGER NOT NULL REFERENCES programs(id), version_no INTEGER NOT NULL,
      content BLOB NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL, source TEXT NOT NULL,
      source_machine TEXT, original_name TEXT, note TEXT, created_by TEXT, UNIQUE (program_id, version_no))`);
    eski.exec(`CREATE TABLE program_backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT, customer TEXT NOT NULL COLLATE NOCASE, name TEXT NOT NULL COLLATE NOCASE,
      machine_id TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, content BLOB NOT NULL, created_at INTEGER NOT NULL,
      created_by TEXT, transfer_id INTEGER, UNIQUE (customer, name, sha256))`);
    const pid = eski.prepare('INSERT INTO programs (customer, name, note, created_at) VALUES (?,?,?,?)').run('MUSTERI_A', 'ESKI-1', null, 111).lastInsertRowid;
    eski.prepare('INSERT INTO program_versions (program_id, version_no, content, sha256, size, created_at, source) VALUES (?,1,?,?,?,?,?)')
      .run(Number(pid), A, 'abc123', A.length, 111, 'yukleme');
    eski.prepare('INSERT INTO program_backups (customer, name, machine_id, sha256, size, content, created_at) VALUES (?,?,?,?,?,?,?)')
      .run('MUSTERI_A', 'ESKI-1', 'CNC-08', 'def456', A.length, A, 111);
    eski.close();

    const db = new LibraryDb(file);
    const prog = db.getProgram(Number(pid));
    assert.equal(prog.library, 'ortak', 'goc sonrasi varsayilan kutuphane');
    assert.equal(prog.customer, 'MUSTERI_A');
    assert.equal(db.listVersions(prog.id).length, 1, 'program_id referansi (FK) korundu');
    assert.equal(db.listBackups('ortak', 'MUSTERI_A', 'ESKI-1').length, 1, 'yedek de ortaka goctu');
    db.close();

    // Goc sonrasi YENI bir kutuphanede ayni (musteri, ad) eklenebilmeli (eski UNIQUE kisiti kaldirilmis olmali).
    // Bu ikinci acilis ayrica "gecis tekrar calismiyor" kanitidir (calissaydi ALTER/CREATE TABLE ikinci kez hata verirdi).
    const lib = new Library(file);
    const yeni = lib.addUpload({ library: 'CNC-03', customer: 'MUSTERI_A', name: 'ESKI-1', content: B, createdBy: 'ayse' });
    assert.equal(yeni.newProgram, true);
    assert.notEqual(yeni.program.id, prog.id);
    assert.equal(lib.db.listPrograms({ library: null }).length, 2, 'eski + yeni kutuphane kaydi birlikte duruyor');
    lib.close();
  } finally {
    // Windows'ta dosya tutamaci close()'dan hemen sonra bazen aninda serbest kalmayabilir (gercek bir urun
    // riski degil - urun kendi veritabani dosyasini hic silmiyor; yalniz bu testin kendi gecici klasoru
    // icin): kisa bir yeniden deneme ile temizle.
    for (let deneme = 0; ; deneme += 1) {
      try { rmSync(dir, { recursive: true, force: true }); break; } catch (err) {
        if (err.code !== 'EBUSY' || deneme >= 5) throw err;
        await sleep(50);
      }
    }
  }
});
