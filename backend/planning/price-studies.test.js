/**
 * Fiyat çalışması (price-studies.js): ürün kartı açılmadan önceki teknik resim + hammadde/süre ön çalışması.
 * `products` tablosuyla HİÇ BAĞLANMAZ (kullanıcı kararı). TÜM veriler sentetiktir.
 *
 * Yetki (admin-only olusturma/silme, 'fiyat' ekranina read/write) backend/auth/policy.test.js'te sinanir;
 * burada yalniz is mantigi ve HTTP uclarinin kendisi.
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Planning } from './planning.js';
import { createPlanningRoutes } from './routes.js';
import { describePages } from '../pdf-merge.js';

/** En küçük geçerli PDF: tek sayfa, bir etiket. */
function pdf(label) {
  const objs = [];
  objs[1] = '<</Type /Catalog /Pages 2 0 R>>';
  objs[2] = '<</Type /Pages /Kids [4 0 R] /Count 1 /MediaBox [0 0 595 842] /Resources <</Font <</F1 3 0 R>>>>>>';
  objs[3] = '<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>';
  objs[4] = '<</Type /Page /Parent 2 0 R /Contents 5 0 R>>';
  const c = `BT /F1 24 Tf 72 700 Td (${label}) Tj ET`;
  objs[5] = `<</Length ${c.length}>>\nstream\n${c}\nendstream`;
  let out = '%PDF-1.4\n';
  const offs = [];
  for (let k = 1; k < objs.length; k += 1) { offs[k] = out.length; out += `${k} 0 obj\n${objs[k]}\nendobj\n`; }
  const x = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let k = 1; k < objs.length; k += 1) out += `${String(offs[k]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<</Size ${objs.length} /Root 1 0 R>>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const labelOf = (buf) => describePages(buf).map((p) => /\(([^)]*)\)/.exec(p.content)?.[1])[0];

function kur() {
  return new Planning({ dbFile: ':memory:' });
}

test('olustur: gecerli PDF kabul edilir (bekliyor), bozuk/bos/cok buyuk reddedilir', () => {
  const p = kur();
  const s = p.priceStudies.create({ title: 'Müşteri A', name: 'resim.pdf', data: pdf('FIYAT-1') });
  assert.equal(s.status, 'bekliyor');
  assert.equal(s.title, 'Müşteri A');
  assert.equal(s.drawingName, 'resim.pdf');
  assert.equal(s.material, null);
  assert.equal(s.plannedSec, null);

  assert.throws(() => p.priceStudies.create({ data: Buffer.alloc(0) }), /boş/);
  assert.throws(() => p.priceStudies.create({ data: Buffer.from('pdf değil '.repeat(20)) }), /kabul edilmedi/);
  assert.throws(() => p.priceStudies.create({ data: Buffer.alloc(21 * 1024 * 1024) }), /çok büyük/);
  p.close();
});

test('liste: durum suzgeci, bekleyenler once; ayrinti ve PDF icerigi', () => {
  const p = kur();
  const a = p.priceStudies.create({ title: 'A', name: 'a.pdf', data: pdf('A') }, { by: 'admin' });
  const b = p.priceStudies.create({ title: 'B', name: 'b.pdf', data: pdf('B') }, { by: 'admin' });
  p.priceStudies.fill(a.id, { material: 'HM614.YU23.00', plannedSec: 22 }, { by: 'usta' });

  const hepsi = p.priceStudies.list({});
  assert.equal(hepsi.total, 2);
  assert.deepEqual(hepsi.items.map((x) => x.status), ['bekliyor', 'dolduruldu'], 'bekleyenler once gelir');
  assert.deepEqual(p.priceStudies.list({ status: 'bekliyor' }).items.map((x) => x.id), [b.id]);
  assert.deepEqual(p.priceStudies.list({ status: 'dolduruldu' }).items.map((x) => x.id), [a.id]);

  const detay = p.priceStudies.get(a.id);
  assert.equal(detay.material, 'HM614.YU23.00');
  assert.equal(detay.plannedSec, 22);
  assert.equal(detay.filledBy, 'usta');
  assert.equal(labelOf(p.priceStudies.drawingData(a.id).data), 'A');
  assert.throws(() => p.priceStudies.get(9999), /bulunamadı/);
  p.close();
});

test('doldur: hammadde + sure zorunlu; bulunamayan kayit 404', () => {
  const p = kur();
  const s = p.priceStudies.create({ name: 'x.pdf', data: pdf('X') });
  assert.throws(() => p.priceStudies.fill(s.id, { material: '' }), /girilmeli/);
  assert.throws(() => p.priceStudies.fill(s.id, { material: 'HM-1' }), /girilmeli/, 'sure hic verilmemis');
  assert.throws(() => p.priceStudies.fill(s.id, { material: 'HM-1', plannedSec: 0 }), /arasında bir sayı olmalı/, '0 gecersiz araliktadir, "girilmeli" degil');
  const r = p.priceStudies.fill(s.id, { material: 'HM-1', plannedSec: 18.5, note: 'not' }, { by: 'usta' });
  assert.equal(r.status, 'dolduruldu');
  assert.equal(r.plannedSec, 18.5);
  assert.throws(() => p.priceStudies.fill(9999, { material: 'x', plannedSec: 1 }), /bulunamadı/);
  p.close();
});

test('sil: kayit kalkar; icerik baska kayitla PAYLASILIYORSA (ayni PDF) silinmez, hic kullanilmiyorsa silinir', () => {
  const p = kur();
  const ayniIcerik = pdf('AYNI');
  const a = p.priceStudies.create({ name: 'a.pdf', data: ayniIcerik });
  const b = p.priceStudies.create({ name: 'b.pdf', data: ayniIcerik }); // ayni sha
  const tek = p.priceStudies.create({ name: 'tek.pdf', data: pdf('TEK') });

  p.priceStudies.delete(a.id);
  assert.throws(() => p.priceStudies.get(a.id), /bulunamadı/);
  assert.equal(labelOf(p.priceStudies.drawingData(b.id).data), 'AYNI', 'b hala okunabiliyor (icerik paylasimli, silinmedi)');

  p.priceStudies.delete(tek.id);
  assert.throws(() => p.priceStudies.drawingData(tek.id), /bulunamadı/);
  assert.throws(() => p.priceStudies.delete(9999), /bulunamadı/);
  p.close();
});

/* ====================================================================================== HTTP */

test('HTTP: olustur, listele, ayrinti, PDF indir, doldur, sil', async () => {
  const p = kur();
  const routes = createPlanningRoutes({ planning: p });
  const srv = http.createServer(async (req, res) => { if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (yol, method = 'GET', obj) => {
    const r = await fetch(base + yol, { method, headers: { 'content-type': 'application/json' }, ...(obj === undefined ? {} : { body: JSON.stringify(obj) }) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  try {
    const up = await fetch(`${base}/api/planning/price-studies?${new URLSearchParams({ title: 'Müşteri A', name: 'resim.pdf' })}`, {
      method: 'POST', headers: { 'content-type': 'application/pdf' }, body: pdf('HTTP-1'),
    });
    assert.equal(up.status, 201);
    const s = await up.json();
    assert.equal(s.status, 'bekliyor');

    const liste = await j('/api/planning/price-studies');
    assert.equal(liste.json.total, 1);
    const ayrinti = await j(`/api/planning/price-studies/${s.id}`);
    assert.equal(ayrinti.json.title, 'Müşteri A');

    const dl = await fetch(`${base}/api/planning/price-studies/${s.id}/drawing.pdf`);
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get('content-type'), 'application/pdf');
    assert.equal(labelOf(Buffer.from(await dl.arrayBuffer())), 'HTTP-1');

    const dold = await j(`/api/planning/price-studies/${s.id}/fill`, 'PUT', { material: 'HM614.YU23.00', plannedSec: 19, note: 'tamam' });
    assert.equal(dold.status, 200);
    assert.equal(dold.json.status, 'dolduruldu');

    const bos = await fetch(`${base}/api/planning/price-studies?name=x.pdf`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: Buffer.alloc(0) });
    assert.equal(bos.status, 400);

    assert.equal((await j(`/api/planning/price-studies/${s.id}`, 'DELETE')).status, 200);
    assert.equal((await j(`/api/planning/price-studies/${s.id}`)).status, 404);
  } finally {
    await new Promise((r) => srv.close(r));
    p.close();
  }
});
