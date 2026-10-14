/**
 * Kalite kayıtları: GKK rapor numaraları, ilk onay raporu / numune takip listesi, iş emrinin teknik resim PDF'leri,
 * ürün kartının kalıcı ölçü planı ve ölçü raporları. TÜM veriler sentetiktir.
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Planning } from './planning.js';
import { createPlanningRoutes } from './routes.js';
import { describePages } from '../pdf-merge.js';

const day = (h, m = 0, d = 12) => new Date(2026, 9, d, h, m).getTime();
const NOW = day(10);
const MAKINELER = [{ id: 'CNC-01', name: 'Torna 1' }, { id: 'CNC-05', name: 'Torna 5' }];
const ISEMRI = [
  'ÜRETİM EMRİ NO;TARİH;MAMÜL ADI;ALEN KOD;MÜŞTERİ KODU;MAKİNA NO;ADET;HAMMADDE;ALTERNATİF HM;ÜRETİM SN;HM TOPLAM;BRÜT GR;NET GR',
  '2026000001;02.01.2026;TEST SOMUN A;ST001.013;900000013;CNC;3500;HM614.AA24.00XYU13.00;;27;62,65;0,039;0,0078',
  '2026000002;05.01.2026;TEST NİPEL;ST002.001;900000021;CNC;500;HM617.YU18.00;;45;53;0,1065;0,036',
  '',
].join('\r\n');

/** En küçük geçerli PDF'ler: her sayfada bir etiket. */
function pdf(...labels) {
  const n = labels.length;
  const objs = [];
  objs[1] = '<</Type /Catalog /Pages 2 0 R>>';
  objs[2] = `<</Type /Pages /Kids [${labels.map((_, i) => `${4 + i * 2} 0 R`).join(' ')}] /Count ${n} /MediaBox [0 0 595 842] /Resources <</Font <</F1 3 0 R>>>>>>`;
  objs[3] = '<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>';
  labels.forEach((l, i) => {
    objs[4 + i * 2] = `<</Type /Page /Parent 2 0 R /Contents ${5 + i * 2} 0 R>>`;
    const c = `BT /F1 24 Tf 72 700 Td (${l}) Tj ET`;
    objs[5 + i * 2] = `<</Length ${c.length}>>\nstream\n${c}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offs = [];
  for (let k = 1; k < objs.length; k += 1) { offs[k] = out.length; out += `${k} 0 obj\n${objs[k]}\nendobj\n`; }
  const x = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let k = 1; k < objs.length; k += 1) out += `${String(offs[k]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<</Size ${objs.length} /Root 1 0 R>>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const label = (buf) => describePages(buf).map((p) => /\(([^)]*)\)/.exec(p.content)?.[1]);

function kur() {
  const st = { live: new Map(), events: [] };
  const p = new Planning({
    dbFile: ':memory:', listMachines: () => MAKINELER,
    productionEvents: (id, from, to) => st.events.filter((e) => e.machineId === id && e.ts >= from && e.ts <= to).map(({ machineId: _m, ...e }) => e),
    liveMachine: (id) => st.live.get(id) ?? null,
  });
  p.importCsv(Buffer.from(ISEMRI, 'utf8'));
  return { p, st };
}
const canli = (partTotal) => ({ connected: true, state: 'RUNNING', program: '900000013', partTotal });
function uretimde(p, st, o = {}) {
  st.live.set('CNC-01', canli(100));
  const w = p.createWorkOrder({ stockCode: 'ST001.013', targetQty: 100, machineId: 'CNC-01', ...o }, { now: day(7) });
  return p.startWorkOrder(w.no, {}, { now: day(7) });
}

/* ================================================================================ GKK */

test('GKK: sıradaki numara, elle numara, aynı numara başka hammadde, çift kayıt, doğrulamalar', () => {
  const { p } = kur();
  const q = p.quality;
  assert.equal(q.gkkNext(NOW).no, 'GK26.001', 'kayıt yokken yılın ilk numarası');
  const a = q.createGkk({ material: ' AA24  X 13 - PB3 ', producerDate: '2026-09-26', note: 'deneme' }, { by: 'ali', now: NOW });
  assert.deepEqual([a.reportNo, a.material, a.note, a.createdBy], ['GK26.001', 'AA24 X 13 - PB3', 'deneme', 'ali'], 'boşluklar sadeleşir, numara sistemden');
  assert.equal(new Date(a.producerDate).getDate(), 26);
  assert.equal(q.createGkk({ material: 'YUV18 - PB3', reportNo: 'gk26.395' }, { now: NOW }).reportNo, 'GK26.395', 'elle numara (küçük harf toleransı)');
  assert.equal(q.gkkNext(NOW).no, 'GK26.396', 'sıradaki = bu yılın en büyüğü + 1');
  // aynı numara birden çok hammaddeye verilebilir (formda dövme ürünler böyle), ama aynı numara + aynı hammadde ikinci kez değil
  q.createGkk({ material: 'ST014.013 - 900000185', reportNo: 'GK26.159' }, { now: NOW });
  q.createGkk({ material: 'ST037.013 - 900000255', reportNo: 'GK26.159' }, { now: NOW });
  assert.throws(() => q.createGkk({ material: 'st037.013 - 900000255', reportNo: 'GK26.159' }, { now: NOW }), (e) => e.status === 409 && e.code === 'duplicate');
  assert.throws(() => q.createGkk({ material: '' }, { now: NOW }), (e) => e.status === 400);
  assert.throws(() => q.createGkk({ material: 'X', reportNo: 'GK26' }, { now: NOW }), (e) => e.status === 400 && /GK26\.396/.test(e.message));
  assert.throws(() => q.createGkk({ material: 'X', producerDate: '31.02.2026' }, { now: NOW }), (e) => e.status === 400);
  assert.throws(() => q.createGkk({ material: 'x'.repeat(81) }, { now: NOW }), (e) => e.status === 400);

  const u = q.updateGkk(a.id, { note: 'düzeltildi', producerDate: null }, { by: 'veli', now: NOW });
  assert.deepEqual([u.note, u.producerDate, u.updatedBy, u.material], ['düzeltildi', null, 'veli', 'AA24 X 13 - PB3']);
  assert.throws(() => q.updateGkk(a.id, { reportNo: 'GK26.395', material: 'YUV18 - PB3' }, { now: NOW }), (e) => e.code === 'duplicate', 'başka kaydın aynısına çevrilemez');
  assert.throws(() => q.updateGkk(99999, { note: 'x' }), (e) => e.status === 404);
  assert.deepEqual(q.deleteGkk(a.id), { ok: true });
  assert.throws(() => q.deleteGkk(a.id), (e) => e.status === 404);

  // taban: kâğıtta verilmiş ama listede olmayan numaralar
  assert.throws(() => q.setGkkSequence('GK26.100'), (e) => e.status === 409, 'zaten daha büyük kayıt var');
  assert.equal(q.setGkkSequence('GK26.500').no, 'GK26.501');
  assert.equal(q.gkkNext(NOW).no, 'GK26.501');
  assert.equal(q.gkkNext(new Date(2027, 0, 5).getTime()).no, 'GK27.001', 'yıl dönünce sıra 1\'den');
});

test('GKK listesi: arama (boşluksuz da), form sırası, iş emri için eşleşenler', () => {
  const { p } = kur();
  const q = p.quality;
  for (const m of ['YUV18 - PB2', 'AA24 X 13 - PB3', 'AA24 X 13 - PB3 HB', 'AA24 X 14 - PB3', 'ST014.013 - 900000185']) q.createGkk({ material: m }, { now: NOW });
  const hepsi = q.listGkk({}, { now: NOW });
  assert.deepEqual(hepsi.items.map((x) => x.material), ['YUV18 - PB2', 'AA24 X 13 - PB3', 'AA24 X 13 - PB3 HB', 'AA24 X 14 - PB3', 'ST014.013 - 900000185']);
  assert.equal(hepsi.total, 5);
  assert.deepEqual(q.listGkk({ q: 'aa24x13' }).items.map((x) => x.material), ['AA24 X 13 - PB3', 'AA24 X 13 - PB3 HB'], 'boşluksuz arama');
  assert.equal(q.listGkk({ q: 'GK26.002' }).items[0].material, 'AA24 X 13 - PB3', 'numarayla');
  assert.equal(q.listGkk({ q: 'yok-boyle-bir-sey' }).total, 0);
  const w = p.createWorkOrder({ stockCode: 'ST001.013', targetQty: 10 }, { now: NOW }); // hammadde HM614.AA24.00XYU13.00
  const e = q.listGkk({ erpMaterial: w.material, stockCode: w.stockCode });
  assert.deepEqual(e.matches.map((x) => [x.material, x.match]), [['AA24 X 13 - PB3', 'tam'], ['AA24 X 13 - PB3 HB', 'islemli']]);
  assert.equal(q.listGkk({ erpMaterial: 'DÖVME ÜRÜN', stockCode: 'ST014.013' }).matches[0].match, 'urun');
  assert.equal(q.listGkk({ limit: 2, offset: 1 }).items.length, 2);
});

const GKK_CSV = [
  ';;GİRİŞ KALİTE KONTROL RAPOR NUMARASI TAKİP FORMU;;;', '',
  'SIRA;ÜRÜN ;;RAPOR NO;ÜRETİCİ RAPOR TARİHİ;AÇIKLAMA',
  '1;YUV12 - PB3;;GK25.013;02.02.2024;',
  '2;AA24 X 13 - PB3;;GK26.395;26.09.2026;not',
  ';;;GK26.396;;', ';;;GK26.397;;', '',
].join('\r\n');

test('GKK formu içeri alma: tanınır, tekrar yüklemek güvenli, değişen alan güncellenir, sıradaki numara hesaplanır', () => {
  const { p } = kur();
  const r1 = p.importCsv(Buffer.from(GKK_CSV, 'utf8'), { filename: 'fr011.csv', by: 'ali', now: NOW });
  assert.equal(r1.format, 'gkk');
  assert.deepEqual([r1.totalRows, r1.added, r1.updated, r1.unchanged, r1.freeNumbers], [2, 2, 0, 0, 2]);
  assert.equal(r1.next.no, 'GK26.396', 'önceden basılmış boş numaralar atlanır: sıradaki en büyük kullanılmışın bir fazlası');
  const r2 = p.importCsv(Buffer.from(GKK_CSV, 'utf8'), { now: NOW });
  assert.deepEqual([r2.added, r2.updated, r2.unchanged], [0, 0, 2], 'idempotent');
  const r3 = p.importCsv(Buffer.from(GKK_CSV.replace(';26.09.2026;not', ';26.09.2026;yeni not'), 'utf8'), { now: NOW });
  assert.deepEqual([r3.added, r3.updated], [0, 1]);
  assert.equal(p.quality.listGkk({ q: 'GK26.395' }).items[0].note, 'yeni not');
  assert.equal(p.summary().lastImports[0].kind, 'gkk');
  assert.throws(() => p.importCsv(Buffer.from('A;B\r\n1;2\r\n', 'utf8')), (e) => /EYS\.FR\.011/.test(e.message), 'tanınmayan dosya iletisi yeni formları da sayar');
});

/* ================================================================================ ilk onay */

test('ilk onay: usta iş emrinden numara alır; iş emri alanı yazılır; ikinci kez onay ister; iptal edilen reddedilir', () => {
  const { p, st } = kur();
  const q = p.quality;
  const w = uretimde(p, st);
  p.updateWorkOrder(w.no, { gkkReportNo: 'gk26.395' }, { now: day(8) });
  const a = q.createApproval({ woNo: w.no, person: 'Ayşe' }, { by: 'fabrika', now: day(9) });
  assert.deepEqual([a.code, a.stockCode, a.gkCode, a.woNo, a.operator, a.machineId, a.cncNo, a.createdBy], ['İ26-001', 'ST001.013', 'GK26.395', w.no, 'Ayşe', 'CNC-01', 1, 'fabrika']);
  assert.equal(new Date(a.approvedOn).getHours(), 0, 'tarih gün olarak saklanır');
  const g = p.getWorkOrder(w.no, { now: NOW });
  assert.equal(g.firstApprovalNo, 'İ26-001', 'iş emrinin ilk onay rapor no alanı yazıldı');
  assert.deepEqual(g.approvals.map((x) => x.code), ['İ26-001']);
  assert.ok(g.events.some((e) => e.kind === 'guncellendi' && /ilk onay rapor no: — → İ26-001/.test(e.detail)));
  assert.throws(() => q.createApproval({ woNo: w.no }, { now: day(9, 5) }), (e) => e.status === 409 && e.code === 'exists' && /İ26-001/.test(e.message));
  const b = q.createApproval({ woNo: w.no, again: true }, { now: day(9, 10) });
  assert.equal(b.code, 'İ26-002');
  assert.equal(p.getWorkOrder(w.no, { now: NOW }).firstApprovalNo, 'İ26-002');
  assert.throws(() => q.createApproval({ woNo: '2026009999' }, { now: NOW }), (e) => e.status === 404);
  const iptal = p.createWorkOrder({ stockCode: 'ST002.001', targetQty: 5 }, { now: NOW });
  p.cancelWorkOrder(iptal.no, { reason: 'deneme', now: NOW });
  assert.throws(() => q.createApproval({ woNo: iptal.no }, { now: NOW }), (e) => e.code === 'cancelled');
  assert.equal(q.approvalNext(NOW).code, 'İ26-003');
});

test('ilk onay: elle kayıt (yönetici), düzenleme, silme iş emri alanını boşaltır, sıra tabanı', () => {
  const { p, st } = kur();
  const q = p.quality;
  assert.throws(() => q.createApproval({}, { now: NOW }), (e) => e.status === 400, 'iş emri de ürün kodu da yok');
  const m = q.createApproval({ stockCode: 'ST002.001', gkCode: 'gk26.7', approvedOn: '2026-10-05', person: 'Veli', machineId: 'CNC-05', note: 'numune' }, { by: 'ali', now: NOW });
  assert.deepEqual([m.code, m.gkCode, m.cncNo, m.woNo, m.note], ['İ26-001', 'GK26.007', 5, null, 'numune']);
  assert.equal(new Date(m.approvedOn).getDate(), 5);
  const u = q.updateApproval(m.id, { operator: 'Mehmet', woNo: null, gkCode: null }, { by: 'ali', now: NOW });
  assert.deepEqual([u.operator, u.gkCode, u.stockCode, u.code], ['Mehmet', null, 'ST002.001', 'İ26-001'], 'kod değişmez');
  const w = uretimde(p, st);
  const a = q.createApproval({ woNo: w.no }, { now: day(9) });
  assert.equal(p.getWorkOrder(w.no, { now: NOW }).firstApprovalNo, a.code);
  assert.throws(() => q.setApprovalSequence('İ26-1'), (e) => e.status === 409, 'bu yıl zaten daha büyük kod verilmiş');
  q.deleteApproval(a.id, { by: 'ali', now: day(9, 30) });
  assert.equal(p.getWorkOrder(w.no, { now: NOW }).firstApprovalNo, null, 'silinen koda bağlı iş emri alanı boşalır');
  assert.throws(() => q.deleteApproval(a.id), (e) => e.status === 404);

  assert.throws(() => q.setApprovalSequence('İ26-0'), (e) => e.status === 400);
  assert.equal(q.setApprovalSequence('İ26-1280').code, 'İ26-1281');
  assert.equal(q.setApprovalSequence('İ26-5').code, 'İ26-1281', 'taban asla düşürülmez');
  const list = q.listApprovals({ q: 'veli' });
  assert.equal(list.total, 0, 'arama operatör adında (Mehmet\'e güncellendi)');
  assert.equal(q.listApprovals({ q: 'mehmet' }).total, 1);
  assert.deepEqual(q.listApprovals({}).years, [2026]);
});

const FA_CSV = [
  'İLK BASKI ONAY / NUMUNE TAKİP LİSTESİ;;;;;;', '',
  'İLK BASKI ONAY KODU;ÜRÜN KODU;GK- KODU;İŞ EMRİ NO;TARİH;OPERATÖR;CNC NO',
  'İ26-1279;ST001.013;GK26.395;2026001100;12.10.2026;Ayşe;5',
  'İ26-1281;;GK-;;;;', 'İ26-1282;;GK-;;;;', '',
].join('\r\n');

test('ilk onay listesi içeri alma: kayıtlar gelir, önceden basılmış ilk boş kod sıradaki numara olur, tekrar güvenli', () => {
  const { p } = kur();
  const r = p.importCsv(Buffer.from(FA_CSV, 'utf8'), { now: NOW });
  assert.equal(r.format, 'ilkonay');
  assert.deepEqual([r.totalRows, r.added], [1, 1]);
  assert.equal(r.next.code, 'İ26-1281', 'İ26-1279 kullanılmış, İ26-1281 ilk basılı boş: sıradaki 1281 (1280 kâğıtta verilmiş sayılır)');
  assert.deepEqual([p.importCsv(Buffer.from(FA_CSV, 'utf8')).added, p.importCsv(Buffer.from(FA_CSV, 'utf8')).unchanged], [0, 1]);
  assert.equal(p.quality.listApprovals({ q: 'ayşe' }).items[0].machineId, 'CNC-05');
});

/* ============================================================================ çizimler */

test('çizimler: yükleme doğrulaması, aynı dosya iki kez olmaz, birleşik PDF sıralı, aynı ürünün yeni iş emri çizimleri miras alır', () => {
  const { p } = kur();
  const q = p.quality;
  const w = p.createWorkOrder({ stockCode: 'ST001.013', targetQty: 10 }, { now: NOW });
  assert.equal(q.mergedDrawings(w.no), null, 'çizim yokken null');
  assert.deepEqual(p.getWorkOrder(w.no, { now: NOW }).drawings, []);

  const a = pdf('RESIM-A1', 'RESIM-A2');
  const b = pdf('RESIM-B1');
  const l1 = q.addDrawing(w.no, { name: 'C:\\klasor\\parca-a.pdf', data: a }, { by: 'ali', now: NOW });
  assert.deepEqual([l1.length, l1[0].name, l1[0].pages, l1[0].addedBy], [1, 'parca-a.pdf', 2, 'ali'], 'dosya adından klasör atılır');
  q.addDrawing(w.no, { name: 'parca-b.pdf', data: b }, { now: NOW });
  assert.throws(() => q.addDrawing(w.no, { name: 'tekrar.pdf', data: a }, { now: NOW }), (e) => e.status === 409 && e.code === 'duplicate');
  assert.throws(() => q.addDrawing(w.no, { name: 'x.pdf', data: Buffer.from('bu bir pdf degil '.repeat(10)) }, { now: NOW }), (e) => e.status === 422 && e.code === 'bad-pdf');
  assert.throws(() => q.addDrawing(w.no, { name: 'x.pdf', data: Buffer.alloc(0) }, { now: NOW }), (e) => e.status === 400);
  assert.throws(() => q.addDrawing('2026009999', { name: 'x.pdf', data: a }, { now: NOW }), (e) => e.status === 404);

  const merged = q.mergedDrawings(w.no);
  assert.deepEqual([merged.pages, merged.count], [3, 2]);
  assert.deepEqual(label(merged.buffer), ['RESIM-A1', 'RESIM-A2', 'RESIM-B1'], 'yükleme sırası');
  assert.equal(q.mergedDrawings(w.no).buffer, merged.buffer, 'dosya kümesi değişmedikçe önbellekten');

  // aynı ürünün yeni iş emri çizimleri otomatik alır (dosya kopyalanmaz)
  const w2 = p.createWorkOrder({ stockCode: 'ST001.013', targetQty: 5 }, { now: NOW + 1000 });
  assert.deepEqual(p.getWorkOrder(w2.no, { now: NOW }).drawings.map((d) => d.name), ['parca-a.pdf', 'parca-b.pdf']);
  assert.equal(p.quality.db.db.prepare('SELECT COUNT(*) AS n FROM drawing_files').get().n, 2, 'iki iş emri, iki dosya');
  // başka ürünün iş emri almaz
  assert.deepEqual(p.getWorkOrder(p.createWorkOrder({ stockCode: 'ST002.001', targetQty: 5 }, { now: NOW }).no, { now: NOW }).drawings, []);

  // silme: bağlantı kalkar; başka iş emri hâlâ kullanıyorsa dosya durur, kimse kullanmıyorsa silinir
  const d1 = p.getWorkOrder(w.no, { now: NOW }).drawings;
  q.deleteDrawing(w.no, d1[0].id, { by: 'ali', now: NOW });
  assert.equal(q.mergedDrawings(w.no).pages, 1);
  assert.equal(p.quality.db.db.prepare('SELECT COUNT(*) AS n FROM drawing_files').get().n, 2, 'dosya w2 tarafından kullanılıyor');
  q.deleteDrawing(w2.no, p.getWorkOrder(w2.no, { now: NOW }).drawings[0].id, { now: NOW });
  assert.equal(p.quality.db.db.prepare('SELECT COUNT(*) AS n FROM drawing_files').get().n, 1, 'kimse kullanmayan dosya silindi');
  assert.throws(() => q.deleteDrawing(w.no, d1[0].id, {}), (e) => e.status === 404);
  assert.throws(() => q.deleteDrawing(w2.no, p.getWorkOrder(w.no, { now: NOW }).drawings[0].id, {}), (e) => e.status === 404, 'başka iş emrinin çizimi silinemez');
  const ev = p.getWorkOrder(w.no, { now: NOW }).events.map((e) => e.kind);
  assert.ok(ev.includes('cizim-eklendi') && ev.includes('cizim-silindi'));
});

test('çizimler: sayı sınırı, iptal edilen iş emri, şifreli/bozuk PDF anlaşılır hata', () => {
  const { p } = kur();
  const q = p.quality;
  const w = p.createWorkOrder({ stockCode: 'ST001.013', targetQty: 10 }, { now: NOW });
  for (let i = 0; i < 8; i += 1) q.addDrawing(w.no, { name: `r${i}.pdf`, data: pdf(`S${i}`) }, { now: NOW });
  assert.throws(() => q.addDrawing(w.no, { name: 'r9.pdf', data: pdf('S9') }, { now: NOW }), (e) => e.status === 409 && e.code === 'too-many');
  const w2 = p.createWorkOrder({ stockCode: 'ST002.001', targetQty: 5 }, { now: NOW });
  const sifreli = Buffer.from(pdf('GIZLI').toString('latin1').replace('/Root 1 0 R', '/Root 1 0 R /Encrypt 3 0 R'), 'latin1');
  assert.throws(() => q.addDrawing(w2.no, { name: 's.pdf', data: sifreli }, { now: NOW }), (e) => e.status === 422 && /Şifreli/.test(e.message));
  p.cancelWorkOrder(w2.no, { reason: 'deneme', now: NOW });
  assert.throws(() => q.addDrawing(w2.no, { name: 'a.pdf', data: pdf('A') }, { now: NOW }), (e) => e.code === 'cancelled');
});

/* ================================================================ ölçü planı ve raporları */

test('ölçü planı: ürün kartındaki kalıcı plan ile iş emri planından DAHA YENİ olan yeni iş emrine kopyalanır; "ürün kartına da kaydet"', () => {
  const { p } = kur();
  const plan3 = [{ label: 'Ø34,2', nominal: 34.2, lower: -0.1, upper: 0 }, { label: 'Boy 14', nominal: 14, lower: -0.05, upper: 0.05 }, { label: 'Ø30,8', nominal: 30.8 }];
  const plan5 = [...plan3, { label: 'Ø12' }, { label: 'Ø9,5' }];
  p.setProductMeasurePlan('ST001.013', plan3, { now: day(8) });
  assert.equal(p.getProduct('ST001.013').measurePlan.length, 3);
  const w1 = p.createWorkOrder({ stockCode: 'ST001.013', targetQty: 10 }, { now: day(9) });
  assert.deepEqual(p.getMeasurements(w1.no).plan.map((r) => r.label), ['Ø34,2', 'Boy 14', 'Ø30,8'], 'yeni iş emri ürün kartının planını alır (3 ölçü)');
  // iş emrinde plan DAHA YENİ düzenlenirse (kartta değil) sonraki iş emri onu alır
  p.setMeasurePlan(w1.no, plan5, { now: day(10) });
  assert.equal(p.getMeasurements(p.createWorkOrder({ stockCode: 'ST001.013', targetQty: 1 }, { now: day(11) }).no).plan.length, 5);
  // "ürün kartına da kaydet": kart güncellenir ve kart artık daha yeni
  p.setMeasurePlan(w1.no, plan3.slice(0, 2), { now: day(12), saveToProduct: true });
  assert.equal(p.getProduct('ST001.013').measurePlan.length, 2);
  assert.equal(p.getMeasurements(p.createWorkOrder({ stockCode: 'ST001.013', targetQty: 1 }, { now: day(13) }).no).plan.length, 2);
  assert.ok(p.getWorkOrder(w1.no, { now: NOW }).events.some((e) => e.kind === 'olcu-plani' && /ürün kartına da kaydedildi/.test(e.detail)));
  // başka ürün etkilenmez; 10'dan fazla ölçü reddedilir; bilinmeyen ürün 404
  assert.equal(p.getMeasurements(p.createWorkOrder({ stockCode: 'ST002.001', targetQty: 1 }, { now: day(13) }).no).plan.length, 0);
  assert.throws(() => p.setProductMeasurePlan('ST001.013', Array.from({ length: 11 }, (_, i) => ({ label: `o${i}` }))), (e) => e.status === 400);
  assert.throws(() => p.setProductMeasurePlan('YOK-99', plan3), (e) => e.status === 404);
  assert.deepEqual(p.setProductMeasurePlan('ST001.013', [], { now: day(14) }).measurePlan, [], 'plan boşaltılabilir');
});

test('ölçü raporları: ölçüm girilmiş iş emirleri, tolerans dışı / karta bağlanmamış sütunlar, kartlar; iş emrinin tüm ölçümleri', () => {
  const { p, st } = kur();
  const w = uretimde(p, st);
  p.setMeasurePlan(w.no, [{ label: 'Ø34,2', nominal: 34.2, lower: -0.1, upper: 0 }, { label: 'Boy', nominal: 14, lower: -0.05, upper: 0.05 }, { label: 'Ø30,8' }], { now: day(7, 5) });
  p.saveMeasurements(w.no, { values: { 1: '34,13', 2: '14,00' }, checks: { gorsel: true } }, { now: day(8) });
  p.saveMeasurements(w.no, { values: { 1: '34,40' }, checks: { gecer: false } }, { now: day(8, 30) }); // tolerans dışı + uygun değil
  st.events.push({ machineId: 'CNC-01', ts: day(8, 45), program: '900000013', qty: 1, partTotal: null, cycleSec: 24, gapMs: 0, suspect: false });
  st.live.set('CNC-01', canli(101));
  const kart = p.issueCard(w.no, { person: 'Ayşe' }, { now: day(9) });
  p.saveMeasurements(w.no, { values: { 1: '34,15' } }, { now: day(9, 30) }); // karttan sonra: kart bekliyor

  const r = p.measureReports({}, { now: day(10) });
  assert.equal(r.total, 1);
  const row = r.items[0];
  assert.deepEqual([row.no, row.stockCode, row.planRows, row.columns, row.flagged, row.pending, row.machineNumber], [w.no, 'ST001.013', 3, 3, 1, 1, 1]);
  assert.equal(row.lastAt, day(9, 30));
  assert.deepEqual(row.cards.map((c) => [c.cardNo, c.columns]), [[kart.cardNo, 2]], 'kart başına sütun sayısı');
  assert.equal(p.measureReports({ q: 'yok-yok' }, { now: NOW }).total, 0);
  assert.equal(p.measureReports({ q: 'somun' }, { now: NOW }).total, 1, 'ürün adıyla arama');

  const rep = p.measureReport(w.no, { now: day(10) });
  assert.equal(rep.scope, 'is-emri');
  assert.equal(rep.card, null);
  assert.deepEqual(rep.slots.map((s) => [s.card?.cardNo ?? null, s.outOfTol.length]), [[kart.cardNo, 0], [kart.cardNo, 1], [null, 0]]);
  assert.deepEqual([rep.wo.stockCode, rep.wo.machineNumber], ['ST001.013', 1]);
  assert.equal(rep.plan.length, 3);
  assert.equal(rep.slots[1].checks.gecer, false);
  // ölçümü olmayan iş emri listede yok
  p.createWorkOrder({ stockCode: 'ST002.001', targetQty: 1 }, { now: NOW });
  assert.equal(p.measureReports({}, { now: NOW }).total, 1);
});

/* ====================================================================================== HTTP */

test('HTTP: GKK, ilk onay (operatör sınırı), çizim yükle / birleşik PDF indir / sil, ölçü raporları, ürün planı', async () => {
  const { p, st } = kur();
  const routes = createPlanningRoutes({ planning: p });
  let user = { role: 'admin', username: 'ali' };
  const srv = http.createServer(async (req, res) => {
    req.user = user;
    if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (yol, method = 'GET', obj) => {
    const r = await fetch(base + yol, { method, headers: { 'content-type': 'application/json' }, ...(obj === undefined ? {} : { body: JSON.stringify(obj) }) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  try {
    // GKK
    const g = await j('/api/planning/gkk', 'POST', { material: 'AA24 X 13 - PB3', note: 'deneme' });
    assert.deepEqual([g.status, g.json.reportNo], [201, 'GK26.' + String(g.json.seq).padStart(3, '0')]);
    assert.equal((await j('/api/planning/gkk', 'POST', { material: '' })).status, 400);
    const liste = await j('/api/planning/gkk?q=aa24&erpMaterial=' + encodeURIComponent('HM614.AA24.00XYU13.00'));
    assert.deepEqual([liste.status, liste.json.total, liste.json.matches.map((x) => x.match)], [200, 1, ['tam']]);
    assert.equal((await j(`/api/planning/gkk/${g.json.id}`, 'PUT', { note: 'yeni' })).json.note, 'yeni');
    assert.equal((await j('/api/planning/gkk/sequence', 'PUT', { last: 'GK26.300' })).json.no, 'GK26.301');
    assert.equal((await j(`/api/planning/gkk/${g.json.id}`, 'DELETE')).status, 200);
    assert.equal((await j('/api/planning/gkk/99999', 'DELETE')).status, 404);

    // ilk onay: operator yalniz is emrinden numara alir
    st.live.set('CNC-01', canli(100));
    const w = (await j('/api/planning/work-orders', 'POST', { stockCode: 'ST001.013', targetQty: 20, machineId: 'CNC-01' })).json;
    await j(`/api/planning/work-orders/${w.no}/start`, 'POST', {});
    user = { role: 'operator', username: 'fabrika' };
    assert.equal((await j('/api/planning/first-approvals', 'POST', { stockCode: 'ST001.013' })).status, 403, 'operator elle kayıt açamaz');
    assert.equal((await j('/api/planning/first-approvals', 'POST', { woNo: w.no, stockCode: 'BASKA' })).status, 403, 'operator alan yazamaz');
    const fa = await j('/api/planning/first-approvals', 'POST', { woNo: w.no, person: 'Ayşe' });
    assert.deepEqual([fa.status, fa.json.code, fa.json.createdBy, fa.json.operator], [201, 'İ26-001', 'fabrika', 'Ayşe']);
    assert.equal((await j('/api/planning/first-approvals', 'POST', { woNo: w.no })).json.code, 'exists');
    assert.equal((await j('/api/planning/first-approvals', 'POST', { woNo: w.no, again: true })).status, 201);
    user = { role: 'admin', username: 'ali' };
    assert.equal((await j('/api/planning/first-approvals', 'POST', { stockCode: 'ST002.001', person: 'Veli' })).json.stockCode, 'ST002.001', 'yönetici elle açabilir');
    assert.equal((await j(`/api/planning/first-approvals/${fa.json.id}`, 'PUT', { note: 'x' })).json.note, 'x');
    const fl = await j('/api/planning/first-approvals?q=ayşe&year=2026');
    assert.deepEqual([fl.json.total, fl.json.next.code], [1, 'İ26-004'], 'arama operatör adında; sıradaki kod 3 kayıttan sonra 004');
    assert.equal((await j('/api/planning/first-approvals')).json.total, 3);
    assert.equal((await j('/api/planning/first-approvals/sequence', 'PUT', { last: 'İ26-1280' })).json.code, 'İ26-1281');

    // çizimler
    const pdfPost = (no, buf, name) => fetch(`${base}/api/planning/work-orders/${no}/drawings?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: buf });
    assert.equal((await (await fetch(`${base}/api/planning/work-orders/${w.no}/drawings.pdf`)).status), 404, 'çizim yokken 404');
    const up1 = await pdfPost(w.no, pdf('HTTP-A'), 'a.pdf');
    assert.equal(up1.status, 201);
    assert.equal((await pdfPost(w.no, pdf('HTTP-B'), 'b.pdf')).status, 201);
    assert.equal((await pdfPost(w.no, Buffer.from('pdf degil '.repeat(20)), 'x.pdf')).status, 422);
    const dl = await fetch(`${base}/api/planning/work-orders/${w.no}/drawings.pdf`);
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get('content-type'), 'application/pdf');
    assert.equal(dl.headers.get('x-frame-options'), 'SAMEORIGIN', 'çerçevede gösterilebilsin');
    assert.deepEqual(label(Buffer.from(await dl.arrayBuffer())), ['HTTP-A', 'HTTP-B']);
    // form + resimler TEK PDF (ön sayfa form, arkası resimler): ekranda gösterilen ve basılan dosya
    const pr = await fetch(`${base}/api/planning/work-orders/${w.no}/print.pdf`);
    assert.deepEqual([pr.status, pr.headers.get('content-type'), pr.headers.get('x-frame-options')], [200, 'application/pdf', 'SAMEORIGIN']);
    const prBuf = Buffer.from(await pr.arrayBuffer());
    assert.equal(describePages(prBuf).length, 3, 'form + 2 resim sayfası');
    assert.deepEqual(label(prBuf).slice(1), ['HTTP-A', 'HTTP-B']);
    assert.equal((await fetch(`${base}/api/planning/work-orders/2026009999/print.pdf`)).status, 404);
    const ilk = (await up1.json()).drawings[0];
    const del = await j(`/api/planning/work-orders/${w.no}/drawings/${ilk.id}`, 'DELETE');
    assert.deepEqual(del.json.drawings.map((d) => d.name), ['b.pdf']);

    // ölçü planı ürün kartına + ölçü raporları
    assert.equal((await j('/api/planning/products/ST001.013/measure-plan', 'PUT', { rows: [{ label: 'Ø34,2', nominal: 34.2, lower: -0.1, upper: 0 }] })).json.measurePlan.length, 1);
    user = { role: 'operator', username: 'fabrika' };
    assert.equal((await j(`/api/planning/work-orders/${w.no}/measure-plan`, 'PUT', { rows: [{ label: 'Ø1' }], saveToProduct: true })).status, 403, 'operator ürün kartına yazamaz');
    assert.equal((await j(`/api/planning/work-orders/${w.no}/measure-plan`, 'PUT', { rows: [{ label: 'Ø1' }] })).status, 200);
    await j(`/api/planning/work-orders/${w.no}/measurements`, 'POST', { values: { 1: '1,0' } });
    assert.equal((await j('/api/planning/measure-reports')).json.total, 1);
    const mr = await j(`/api/planning/work-orders/${w.no}/measure-report`);
    assert.deepEqual([mr.status, mr.json.scope, mr.json.slots.length], [200, 'is-emri', 1]);
  } finally {
    await new Promise((r) => srv.close(r));
    p.close();
  }
});
