/**
 * GKK KALITE RAPORU klasoru (hammaddenin ureticisinden gelen sertifika PDF'leri; dosya adindan cikan GK RAPOR
 * NUMARASINA gore GKK kayitlarina baglanir — hammadde cinsine DEGIL, 2026-11-19 duzeltmesi: kullanici gercek
 * klasorde ayni hammaddenin FARKLI teslimatlarinin FARKLI sertifika tasidigini fark etti). Tek seferlik ("zaten
 * raporu olana dokunulmaz"), 8 dosya siniri, bozuk PDF, HTTP. TUM veriler sentetiktir.
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Planning } from './planning.js';
import { createPlanningRoutes } from './routes.js';
import { pdf } from './test/doc-fixture.js';

const NOW = new Date(2026, 9, 15, 10).getTime();

function kur() {
  const dir = mkdtempSync(join(tmpdir(), 'cnc-gkk-rapor-'));
  const rapor = join(dir, 'gkk-rapor');
  const p = new Planning({ dbFile: ':memory:', gkkFilesDir: rapor });
  // ayni hammaddenin IKI FARKLI teslimati (GK25.141 / GK25.179) + baska bir hammaddenin AYNI rapor nosunu
  // paylasan bir satiri (GK25.141'i AA24X14'e de yazdirarak) + hic dosyasi gelmeyecek bir kayit (YUV18-PB2)
  p.quality.createGkk({ material: 'AA11,11 - PB2', reportNo: 'GK25.141' }, { now: NOW });
  p.quality.createGkk({ material: 'AA11,11 - PB2', reportNo: 'GK25.179' }, { now: NOW });
  p.quality.createGkk({ material: 'AA24 X 14 - PB2', reportNo: 'GK25.141' }, { now: NOW }); // ayni rapor no, FARKLI hammadde
  p.quality.createGkk({ material: 'YUV18 - PB2', reportNo: 'GK25.200' }, { now: NOW });
  const yaz = (ad, icerik) => { const yol = join(rapor, ad); mkdirSync(join(yol, '..'), { recursive: true }); writeFileSync(yol, icerik); };
  return { p, dir, rapor, yaz, bitir: () => { p.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('klasor ayari: varsayilan ilk bakista olusur, ayarlanan olusturulmaz, gecersiz yol reddedilir', () => {
  const k = kur();
  try {
    assert.deepEqual([k.p.gkkFolder.status().dir, k.p.gkkFolder.status().exists], [k.rapor, true]);
    assert.deepEqual(k.p.gkkFolder.config().extensions, ['.pdf']);
    const diger = join(k.dir, 'baska');
    mkdirSync(diger);
    k.p.gkkFolder.setDir(diger);
    assert.equal(k.p.gkkFolder.config().dir, diger);
    assert.equal(k.p.gkkFolder.setDir('').isDefault, true);
    assert.throws(() => k.p.gkkFolder.setDir('goreli'), /tam \(mutlak\)/);
    assert.throws(() => k.p.gkkFolder.setDir(join(k.dir, 'yok')), (e) => e.code === 'no-dir');
  } finally { k.bitir(); }
});

test('dosya adindaki GK rapor numarasina gore eslenir (hammadde adi degil); ayni rapor nosunu paylasan FARKLI hammaddeler ayni dosyayi gorur', () => {
  const k = kur();
  try {
    k.yaz('AA11,11 - PB2 - GK25.141.pdf', pdf('S1')); // "hammadde - GK no" sirasi
    k.yaz('GK25.179 - AA11,11 - PB2.pdf', pdf('S2')); // "GK no - hammadde" sirasi (ters)
    k.yaz('rastgele.pdf', pdf('S4')); // dosya adinda hic GK numarasi yok

    assert.deepEqual([k.p.gkkFolder.status().files, k.p.gkkFolder.status().without], [3, 3]);
    const r = k.p.gkkFolder.match({ by: 'ayse', now: NOW });
    assert.deepEqual([r.scanned, r.reports, r.alreadyHad], [3, 2, 0]);
    assert.deepEqual(r.attached.map((a) => [a.reportNo, a.files]).sort((a, b) => a[0].localeCompare(b[0])), [
      ['GK25.141', ['AA11,11 - PB2 - GK25.141.pdf']],
      ['GK25.179', ['GK25.179 - AA11,11 - PB2.pdf']],
    ]);
    assert.deepEqual(r.unmatched.map((u) => [u.name, u.reason]), [['rastgele.pdf', 'rapor numarası bulunamadı (dosya adında GKxx.xxx yok)']]);
    assert.deepEqual(r.rejected, []);
    assert.deepEqual([r.missing.total, r.missing.sample], [1, ['GK25.200']]);

    // GK25.141'i paylasan IKI FARKLI hammadde satiri da AYNI dosyayi gorur
    assert.deepEqual(k.p.quality.listGkkFiles('GK25.141').map((f) => f.name), ['AA11,11 - PB2 - GK25.141.pdf']);
    assert.deepEqual(k.p.quality.listGkkFiles('GK25.179').map((f) => f.name), ['GK25.179 - AA11,11 - PB2.pdf'], 'AYNI hammadde, FARKLI rapor no: AYRI dosya');

    // tek seferlik: ikinci calistirmada hic bir seye dokunulmaz
    const r2 = k.p.gkkFolder.match({ now: NOW });
    assert.deepEqual([r2.reports, r2.alreadyHad], [0, 2]);
  } finally { k.bitir(); }
});

test('dosya adinda GK numarasi var ama o numarayla eslesen GKK kaydi HIC yoksa eslesmedi listelenir', () => {
  const k = kur();
  try {
    k.yaz('AA24 X 13 - PB3 - GK99.999.pdf', pdf('X')); // kayitli degil
    const r = k.p.gkkFolder.match({ now: NOW });
    assert.equal(r.reports, 0);
    assert.deepEqual(r.unmatched, [{ name: 'AA24 X 13 - PB3 - GK99.999.pdf', reason: 'GK99.999 için GKK kaydı yok' }]);
    assert.deepEqual(k.p.quality.listGkkFiles('GK99.999'), []);
  } finally { k.bitir(); }
});

test('rakam dizisinin TAMAMI yakalanir: GK25.10 ile GK25.100 KARISMAZ', () => {
  const k = kur();
  try {
    k.p.quality.createGkk({ material: 'AA10 - PB3', reportNo: 'GK25.10' }, { now: NOW });
    k.p.quality.createGkk({ material: 'AA100 - PB3', reportNo: 'GK25.100' }, { now: NOW });
    k.yaz('AA10 - PB3 - GK25.10.pdf', pdf('ON'));
    k.yaz('AA100 - PB3 - GK25.100.pdf', pdf('YUZ'));
    const r = k.p.gkkFolder.match({ now: NOW });
    assert.equal(r.reports, 2);
    assert.deepEqual(k.p.quality.listGkkFiles('GK25.10').map((f) => f.name), ['AA10 - PB3 - GK25.10.pdf']);
    assert.deepEqual(k.p.quality.listGkkFiles('GK25.100').map((f) => f.name), ['AA100 - PB3 - GK25.100.pdf']);
  } finally { k.bitir(); }
});

test('kabul edilmeyen dosyalar: bozuk PDF, 8 dosya siniri; kalan dosyalar yine eslenir', () => {
  const k = kur();
  try {
    k.yaz('YUV18-PB2-bozuk-GK25.200.pdf', Buffer.from('%PDF-1.4 bozuk icerik'));
    k.yaz('YUV18-PB2-iyi-GK25.200.pdf', pdf('IYI'));
    for (let i = 0; i < 9; i += 1) {
      k.p.quality.createGkk({ material: `AA${i} - PB3`, reportNo: `GK25.3${i}` }, { now: NOW });
      k.yaz(`AA${i} - PB3 - GK25.3${i}.pdf`, pdf(`S${i}`));
    }
    const r = k.p.gkkFolder.match({ now: NOW });
    assert.equal(k.p.quality.listGkkFiles('GK25.200').length, 1, 'bozuk PDF atlandi, iyisi eslendi');
    assert.equal(r.reports, 10, '1 (YUV18) + 9 (AA0..AA8)');
    assert.ok(r.rejected.some((x) => x.name === 'YUV18-PB2-bozuk-GK25.200.pdf' && /PDF kabul edilmedi/.test(x.error)), JSON.stringify(r.rejected));
  } finally { k.bitir(); }
});

test('HTTP: klasor durumu / ayari / esleme; satirin ustune basinca acilan dosya listesi ve indirme', async () => {
  const k = kur();
  const routes = createPlanningRoutes({ planning: k.p });
  const srv = http.createServer(async (req, res) => { if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (yol, init) => { const r = await fetch(base + yol, init); return { status: r.status, json: await r.json().catch(() => null) }; };
  const json = (method, obj) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
  try {
    k.yaz('AA11,11 - PB2 - GK25.141.pdf', pdf('R'));
    assert.equal((await j('/api/planning/gkk-folder')).json.files, 1);
    const m1 = await j('/api/planning/gkk-folder/match', json('POST', {}));
    assert.deepEqual([m1.status, m1.json.reports], [200, 1]);
    assert.equal((await j('/api/planning/gkk-folder/dir', json('PUT', { dir: 'goreli' }))).status, 400);

    const kayit = k.p.quality.listGkk({ q: 'GK25.141' }).items.find((x) => x.reportNo === 'GK25.141' && x.material === 'AA11,11 - PB2');
    assert.equal(kayit.fileCount, 1);
    const files = (await j(`/api/planning/gkk/${kayit.id}/files`)).json;
    assert.equal(files.length, 1);
    const dl = await fetch(`${base}/api/planning/gkk-files/${files[0].id}`);
    assert.deepEqual([dl.status, dl.headers.get('content-type')], [200, 'application/pdf']);
    assert.ok((await dl.arrayBuffer()).byteLength > 0);

    // AYNI rapor nosunu (GK25.141) paylasan OBUR hammadde kaydi da ayni dosyayi gorur
    const kayit2 = k.p.quality.listGkk({ q: 'GK25.141' }).items.find((x) => x.material === 'AA24 X 14 - PB2');
    assert.equal(kayit2.fileCount, 1);
    assert.deepEqual((await j(`/api/planning/gkk/${kayit2.id}/files`)).json.map((f) => f.id), files.map((f) => f.id));

    assert.equal((await j(`/api/planning/gkk-files/${files[0].id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await j(`/api/planning/gkk-files/${files[0].id}`)).status, 404);
    assert.equal((await j(`/api/planning/gkk/${kayit.id}/files`)).json.length, 0);
    assert.equal((await j(`/api/planning/gkk/${kayit2.id}/files`)).json.length, 0, 'paylasan kayit da gormez');
  } finally {
    await new Promise((r) => srv.close(r));
    k.bitir();
  }
});
