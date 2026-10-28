/**
 * Planning.importLegacyWorkOrders (eski Excel is emri sisteminden BIR KEZLIK gecis) - gercek .xlsx tamponu uzerinden
 * uctan uca: readXlsx -> detectFormat -> urun kartlari (importParsed) + is emri kayitlari (wo-import.js). Renk
 * (xlsx-fixture.js stil 5=yesil, 6=kirmizi) gercekten HTTP/Planning katmanindan geciyor mu burada sinanir; cekirdek
 * kurallar (durum esleme, idempotentlik, seq_floor) wo-import.test.js'te zaten sentetik {headers,rows,rowFills} ile
 * dogrudan test edildi - burasi yalniz GERCEK .xlsx -> dogru alanlar BAGLANTISINI dogrular.
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Planning } from './planning.js';
import { createPlanningRoutes } from './routes.js';
import { xlsxOf } from './test/xlsx-fixture.js';

// ÜRETİM EMRİ NO BİLEREK A SÜTUNU (gercek dosyadaki gibi): xlsx-read.js satir rengini A sütunundan okur.
const HEADERS = ['ÜRETİM EMRİ NO', 'ALEN KOD', 'MAMÜL ADI', 'MÜŞTERİ KODU', 'TARİH', 'MAKİNA NO', 'ADET', 'HAMMADDE', 'ALTERNATİF HM', 'ÜRETİM SN', 'BRÜT GR', 'NET GR', 'TERMİN TARİHİ'];

/** @param {{no:number, fill?: 5|6}[]} satirlar s:5 yesil(bitti), s:6 kirmizi(iptal), yoksa stilsiz (planlandi) */
function kitap(satirlar) {
  return xlsxOf([{
    name: 'PLANLANAN',
    rows: [
      HEADERS,
      ...satirlar.map((x) => [
        { n: x.no, s: x.fill ?? 0 }, 'SR001.001', 'TEST ÜRÜN', 140100168, { n: 46023, s: 2 }, 'CNC', x.adet ?? 100,
        'HM614.AA19.00', '', 24, 0.0179, 0.0078, { n: 46033, s: 2 },
      ]),
    ],
  }]);
}

function kur() {
  const p = new Planning({ dbFile: ':memory:', listMachines: () => [], productionEvents: () => [], liveMachine: () => null });
  p.createProduct({ stockCode: 'SR001.001', name: 'test' }, {});
  return p;
}

test('yesil (stil 5) -> bitti, adet=sonuc; kirmizi (stil 6) -> iptal; stilsiz -> planlandi; urun kartlari da guncellenir', () => {
  const p = kur();
  try {
    const buf = kitap([{ no: 2026000001, fill: 5, adet: 3500 }, { no: 2026000002, fill: 6 }, { no: 2026000003 }]);
    const r = p.importLegacyWorkOrders(buf, { by: 'gocis' });
    assert.equal(r.sheet, 'PLANLANAN');
    assert.deepEqual(r.workOrders.byStatus, { bitti: 1, planlandi: 1, iptal: 1 });
    assert.equal(r.products.products.updated + r.products.products.added > 0, true);

    const bitti = p.getWorkOrder('2026000001');
    assert.equal(bitti.status, 'bitti');
    assert.equal(bitti.progress.produced, 3500);
    const iptal = p.getWorkOrder('2026000002');
    assert.equal(iptal.status, 'iptal');
  } finally { p.close(); }
});

test('ikinci kez ayni dosyayi aktarmak guvenlidir (idempotent): hicbir satir eklenmez', () => {
  const p = kur();
  try {
    const buf = kitap([{ no: 2026000010, fill: 5 }]);
    p.importLegacyWorkOrders(buf, {});
    const r2 = p.importLegacyWorkOrders(buf, {});
    assert.deepEqual([r2.workOrders.added, r2.workOrders.existing], [0, 1]);
  } finally { p.close(); }
});

test('taninmayan sayfa/baslik 400 unrecognized; xlsx olmayan govde 400', () => {
  const p = kur();
  try {
    const bosKitap = xlsxOf([{ name: 'Sayfa1', rows: [['A', 'B'], ['1', '2']] }]);
    assert.throws(() => p.importLegacyWorkOrders(bosKitap), (e) => e.status === 400 && e.code === 'unrecognized');
    assert.throws(() => p.importLegacyWorkOrders(Buffer.from('CSV degil ama xlsx de degil')), (e) => e.status === 400 && e.code === 'not-xlsx');
  } finally { p.close(); }
});

test('HTTP: POST /api/planning/work-orders/import-legacy ham .xlsx govdesiyle calisir', async () => {
  const p = kur();
  const routes = createPlanningRoutes({ planning: p });
  const srv = http.createServer(async (req, res) => { if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const buf = kitap([{ no: 2026000020, fill: 5, adet: 777 }]);
    const res = await fetch(`${base}/api/planning/work-orders/import-legacy`, {
      method: 'POST', headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, body: buf,
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.deepEqual(json.workOrders.byStatus, { bitti: 1, planlandi: 0, iptal: 0 });
    assert.equal(p.getWorkOrder('2026000020').progress.produced, 777);
  } finally {
    await new Promise((r) => srv.close(r));
    p.close();
  }
});
