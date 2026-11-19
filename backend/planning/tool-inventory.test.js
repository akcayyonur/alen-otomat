/**
 * TAKIM VE PENS TAKİP (EYS.LS.026 + "Takım Uçları ve Tutucuları"): CRUD, Excel içeri aktarma (üç farklı sayfa
 * şekli — Takım Takip, Pens Takip, Takım Uçları/Tutucuları — tek dosyada ya da ayrı dosyalarda), sayım-bazlı
 * dedup (gerçek yinelenen ölçüler veri kaybetmeden korunur, aynı dosyayı tekrar yüklemek güvenlidir), HTTP.
 * TÜM veriler sentetiktir (gerçek dosyanın yapısını taklit eder).
 *
 * Çalıştırma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Planning } from './planning.js';
import { createPlanningRoutes } from './routes.js';
import { xlsxOf } from './test/xlsx-fixture.js';

const NOW = new Date(2026, 10, 17, 9).getTime();

function kur() {
  return new Planning({ dbFile: ':memory:' });
}

/* ================================================================================ CRUD */

test('olusturma: kategori ve tanim zorunlu; diger alanlar isteged bagli, hepsi serbest metin (X gibi degerler de kabul)', () => {
  const p = kur();
  const ti = p.toolInventory;
  const a = ti.create({ category: ' Matkap ', name: 'E.3645.1.1000 Ø10X35X90 SD 10,0 HA', brand: 'NAGREINER', qty: 'X', criticalQty: 'X' }, { by: 'ayse', now: NOW });
  assert.deepEqual([a.category, a.name, a.brand, a.qty, a.criticalQty, a.createdBy], ['Matkap', 'E.3645.1.1000 Ø10X35X90 SD 10,0 HA', 'NAGREINER', 'X', 'X', 'ayse']);
  assert.throws(() => ti.create({ name: 'X' }, { now: NOW }), (e) => e.status === 400 && /Kategori/.test(e.message));
  assert.throws(() => ti.create({ category: 'X' }, { now: NOW }), (e) => e.status === 400 && /Tanım/.test(e.message));

  const u = ti.update(a.id, { qty: '5', note: 'raf 3' }, { by: 'veli', now: NOW });
  assert.deepEqual([u.qty, u.note, u.category, u.updatedBy], ['5', 'raf 3', 'Matkap', 'veli'], 'yalniz gonderilenler degisti');
  assert.throws(() => ti.update(99999, { note: 'x' }), (e) => e.status === 404);

  ti.create({ category: 'Pens - Yuvarlak', name: 'Ø12', qty: '6' }, { now: NOW });
  assert.deepEqual(ti.categories(), ['Matkap', 'Pens - Yuvarlak']);
  assert.equal(ti.list({ q: 'yuvarlak' }).total, 1);
  assert.equal(ti.list({ q: 'nagreiner' }).total, 1, 'marka ile arama');

  assert.deepEqual(ti.delete(a.id), { ok: true });
  assert.throws(() => ti.get(a.id), (e) => e.status === 404);
  assert.throws(() => ti.delete(a.id), (e) => e.status === 404);
});

/* ================================================================================ Excel iceri alma */

test('Takim Takip sayfasi: Marka/Kod/Isim/Stok/Kritik Stok/Aciklama -> kategori=Isim, tanim=Kod; Kod yoksa Isim adi da ustlenir', () => {
  const p = kur();
  const buf = xlsxOf([{
    name: 'TAKIM TAKİP',
    rows: [
      ['SIRA NO', 'MARKA', 'KOD', 'İSİM', 'STOK', 'KRİTİK STOK', 'AÇIKLAMA'],
      [1, 'NAGREINER', 'E.3645.1.1000 Ø10X35X90', 'Matkap', 1, '', ''],
      [2, 'NAGREINER', 'E.3645.1.1150', 'Matkap', 'X', 'X', ''],
      [3, 'AS', '', 'KILAVUZ', 2, '', 'yedek az'], // kod yok -> isim hem kategori hem tanim
      [4, '', '', '', '', '', ''], // tamamen bos satir, atlanir
    ],
  }]);
  const r = p.toolInventory.importXlsx(buf, { by: 'ayse', now: NOW });
  assert.deepEqual([r.totalRows, r.added, r.skipped, r.skippedSheets], [3, 3, 0, []]);
  const items = p.toolInventory.list({}).items;
  assert.deepEqual(items.map((x) => [x.category, x.name, x.brand, x.qty, x.criticalQty, x.note]).sort((a, b) => a[1].localeCompare(b[1])), [
    ['Matkap', 'E.3645.1.1000 Ø10X35X90', 'NAGREINER', '1', null, null],
    ['Matkap', 'E.3645.1.1150', 'NAGREINER', 'X', 'X', null],
    ['KILAVUZ', 'KILAVUZ', 'AS', '2', null, 'yedek az'],
  ]);
});

test('Pens Takip sayfasi: sekil gruplari (Yuvarlak/Alti Kose/Sekiz Kose) BAGIMSIZ uzunlukta; AYNI olcu birden fazla satirda veri KAYBETMEDEN korunur', () => {
  const p = kur();
  const buf = xlsxOf([{
    name: 'PENS TAKİP',
    rows: [
      ['YUVARLAK', '', '', 'ALTI KÖŞE', '', '', 'SEKİZ KÖŞE', '', ''],
      ['Ölçü', 'Adet', 'Not', 'Ölçü', 'Adet', 'Not', 'Ölçü', 'Adet', 'Not'],
      ['Ø12', 6, '', 'AK13', 1, '', 'SK24', 2, ''],
      ['Ø13', 2, '', 'AK13', 1, '', '', '', ''], // AK13 IKINCI kez - gercek dosyadaki gibi, ayri satir olarak kalmali
      ['Ø15', 1, 'eski', '', '', '', '', '', ''],
    ],
  }]);
  const r = p.toolInventory.importXlsx(buf, { now: NOW });
  assert.deepEqual([r.totalRows, r.added, r.skippedSheets], [6, 6, []]);
  const yuv = p.toolInventory.list({ q: 'yuvarlak' }).items;
  assert.deepEqual(yuv.map((x) => [x.name, x.qty, x.note]).sort((a, b) => a[0].localeCompare(b[0])), [['Ø12', '6', null], ['Ø13', '2', null], ['Ø15', '1', 'eski']]);
  const ak13 = p.toolInventory.list({ q: 'AK13' }).items;
  assert.equal(ak13.length, 2, 'IKI AK13 kaydi da korundu, biri digerini EZMEDI');
  assert.ok(ak13.every((x) => x.category === 'Pens - Altı Köşe' && x.qty === '1'));

  // AYNI dosya TEKRAR yuklenirse hicbir satir tekrarlanmaz (sayim-bazli dedup)
  const r2 = p.toolInventory.importXlsx(buf, { now: NOW });
  assert.deepEqual([r2.added, r2.skipped], [0, 6]);
  assert.equal(p.toolInventory.list({ q: 'AK13' }).total, 2, 'ikinci yukleme AK13 sayisini 4\'e CIKARMADI');
});

test('AYNI kategorileri ureten IKINCI bir Pens sayfasi (gercek dosyadaki "Sayfa2" gibi eski/yinelenen kopya) TAMAMEN atlanir, satirlar IKI KEZ sayilmaz', () => {
  const p = kur();
  const resmi = [
    ['YUVARLAK', '', '', 'ALTI KÖŞE', '', ''],
    ['Ölçü', 'Adet', 'Not', 'Ölçü', 'Adet', 'Not'],
    ['Ø12', 6, '', 'AK13', 1, ''],
    ['Ø13', 2, '', 'AK13', 1, ''], // gercek dosyadaki gibi AYNI olcu iki kez - sayfa ICINDE gercek bir tekrar
  ];
  // "Sayfa2": AYNI iki grubu (Yuvarlak + Alti Kose) uretiyor, bu yuzden onceki sayfayla AYNI kategori kumesi -> atlanir
  const kopya = [['YUVARLAK', '', 'ALTI KÖŞE', ''], ['ÇAP', 'ADET', 'ÇAP', 'ADET'], ['Ø12', 6, 'AK13', 1], ['Ø13', 2, 'AK13', 1]];
  const buf = xlsxOf([{ name: 'EYS.LS.016 PENS TAKİP', rows: resmi }, { name: 'Sayfa2', rows: kopya }]);
  const r = p.toolInventory.importXlsx(buf, { now: NOW });
  assert.deepEqual([r.totalRows, r.added, r.skipped], [4, 4, 0], 'yalniz resmi sayfanin 4 satiri sayildi, kopyanin 4 satiri HIC islenmedi');
  assert.ok(r.warnings.some((w) => /Sayfa2.*atlandı/.test(w)), JSON.stringify(r.warnings));
  assert.equal(p.toolInventory.list({ q: 'AK13' }).total, 2, 'kopyadan gelen 2 fazladan AK13 EKLENMEDI (4 degil 2)');
  assert.equal(p.toolInventory.list({}).total, 4, 'toplam kayit 8 degil 4');

  // farkli bir Takim Uclari/Tutuculari cifti ("ayni sekil, FARKLI kategori") BIRBIRINI atlatmaz - ikisi de islenir
  const buf2 = xlsxOf([
    { name: 'Takım Uçları', rows: [['Marka', 'Kodu', 'İsmi', 'Adet'], ['Iscar', 'A1', 'Uc', 1]] },
    { name: 'Takım Tutucular', rows: [['Marka', 'Kodu', 'İsmi', 'Adet'], ['Iscar', 'A1', 'Tutucu', 1]] }, // AYNI kod/marka ama FARKLI kategori (sayfa adindan)
  ]);
  const r2 = p.toolInventory.importXlsx(buf2, { now: NOW });
  assert.deepEqual([r2.added, r2.skipped], [2, 0], 'ayni sekil FARKLI kategoriye dusunce ikisi de eklenir');
});

test('Takim Uclari / Takim Tutuculari sayfalari: kategori SAYFA ADINDAN gelir; Ismi bossa Kodu adi da ustlenir', () => {
  const p = kur();
  const buf = xlsxOf([
    { name: 'Takım Uçları', rows: [['Marka', 'Kodu', 'İsmi', 'Adet'], ['Iscar', 'Penta 24A-WT', 'Penta Whitworth Diş Çekme', 20]] },
    { name: 'Takım Tutucular', rows: [['MARKA', 'KODU', 'İSMİ', 'Adet'], ['YOK', '25mm genişlik 20mm matkap tutucu', '', '']] },
    { name: 'Sayfa1', rows: [] }, // bos sayfa: hicbir sekle uymaz, sessizce atlanir
  ]);
  const r = p.toolInventory.importXlsx(buf, { now: NOW });
  assert.deepEqual([r.totalRows, r.added, r.skippedSheets], [2, 2, ['Sayfa1']]);
  const items = p.toolInventory.list({}).items;
  assert.deepEqual(items.map((x) => [x.category, x.name, x.code]).sort((a, b) => a[0].localeCompare(b[0])), [
    ['Takım Tutucu', '25mm genişlik 20mm matkap tutucu', '25mm genişlik 20mm matkap tutucu'],
    ['Takım Ucu', 'Penta Whitworth Diş Çekme', 'Penta 24A-WT'],
  ]);
});

test('hicbir sayfa taninmazsa anlasilir hata; bozuk dosya PlanningError olarak gecer', () => {
  const p = kur();
  const buf = xlsxOf([{ name: 'Alakasiz', rows: [['A', 'B'], ['1', '2']] }]);
  assert.throws(() => p.toolInventory.importXlsx(buf, { now: NOW }), (e) => e.status === 400 && /bulunamadı/.test(e.message));
  assert.throws(() => p.toolInventory.importXlsx(Buffer.from('bu bir xlsx degil'), { now: NOW }), (e) => e.status === 400);
});

/* ====================================================================================== HTTP */

test('HTTP: olustur, listele/ara, kategoriler, duzenle, sil, Excel iceri aktar', async () => {
  const p = kur();
  const routes = createPlanningRoutes({ planning: p });
  const srv = http.createServer(async (req, res) => {
    req.user = { isAdmin: true, username: 'ali' };
    if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (yol, method = 'GET', obj) => {
    const r = await fetch(base + yol, { method, headers: { 'content-type': 'application/json' }, ...(obj === undefined ? {} : { body: JSON.stringify(obj) }) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  try {
    const c = await j('/api/planning/tool-items', 'POST', { category: 'Matkap', name: 'E.3645.1.1000', brand: 'NAGREINER', qty: '3' });
    assert.deepEqual([c.status, c.json.category, c.json.qty], [201, 'Matkap', '3']);
    assert.equal((await j('/api/planning/tool-items', 'POST', { category: '' })).status, 400);

    const liste = await j('/api/planning/tool-items?q=nagreiner');
    assert.deepEqual([liste.status, liste.json.total], [200, 1]);
    assert.deepEqual((await j('/api/planning/tool-items/categories')).json.items, ['Matkap']);
    assert.equal((await j(`/api/planning/tool-items/${c.json.id}`, 'PUT', { qty: '1' })).json.qty, '1');

    const buf = xlsxOf([{ name: 'Takım Uçları', rows: [['Marka', 'Kodu', 'İsmi', 'Adet'], ['Iscar', 'ABC-1', 'Örnek Uç', 5]] }]);
    const up = await fetch(`${base}/api/planning/tool-items/import`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: buf });
    const upJson = await up.json();
    assert.deepEqual([up.status, upJson.added], [200, 1]);
    assert.equal((await j('/api/planning/tool-items')).json.total, 2);

    assert.equal((await j(`/api/planning/tool-items/${c.json.id}`, 'DELETE')).status, 200);
    assert.equal((await j(`/api/planning/tool-items/${c.json.id}`)).status, 404);
    assert.equal((await j('/api/planning/tool-items/99999', 'DELETE')).status, 404);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
