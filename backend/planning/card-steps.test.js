/**
 * Ürün tanıtım kartındaki işlem işaretleri (yıkama, kurutma, tavlama; her birinde "gidecek" ve "yapıldı" kutusu): doğrulama, kayıt, eski veritabanı geçişi,
 * HTTP ve ekranla (dashboard/planning-card.js) aynı tanım. TÜM veriler sentetiktir.
 *
 * Calistirma:  npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Planning } from './planning.js';
import { createPlanningRoutes } from './routes.js';
import { CARD_STEPS, STEP_KEYS, CRATE_STEP_COLUMNS, parseSteps, stepsText } from './card-steps.js';
import * as ui from '../../dashboard/planning-card.js';

const day = (h, m = 0, s = 0, d = 12) => new Date(2026, 9, d, h, m, s).getTime();
const MAKINELER = [{ id: 'CNC-01', name: 'Torna 1' }];
const ISEMRI = [
  'ÜRETİM EMRİ NO;TARİH;MAMÜL ADI;ALEN KOD;MÜŞTERİ KODU;MAKİNA NO;ADET;HAMMADDE;ALTERNATİF HM;ÜRETİM SN;HM TOPLAM;BRÜT GR;NET GR',
  '2026000001;02.01.2026;TEST SOMUN A;SR001.013;100000013;CNC;3500;HM614.YU23.00;;27;62,65;0,039;0,0078',
  '',
].join('\r\n');

function kur(dbFile = ':memory:') {
  const st = { live: new Map() };
  const p = new Planning({ dbFile, listMachines: () => MAKINELER, productionEvents: () => [], liveMachine: (id) => st.live.get(id) ?? null });
  p.importCsv(Buffer.from(ISEMRI, 'utf8'));
  return { p, st };
}
function uretimde(p, st) {
  st.live.set('CNC-01', { connected: true, state: 'RUNNING', program: '1', partTotal: 500 });
  const w = p.createWorkOrder({ stockCode: 'SR001.013', targetQty: 100, machineId: 'CNC-01' }, { now: day(7) });
  return p.startWorkOrder(w.no, {}, { now: day(7) });
}
const HEPSI_BOS = Object.fromEntries(STEP_KEYS.map((k) => [k, false]));

test('tanım: üç işlem x iki kutu; ekrandaki liste sunucudakiyle aynı', () => {
  assert.deepEqual(CARD_STEPS.map((s) => [s.key, s.label, s.to, s.done]), [
    ['wash', 'YIKAMA', 'Yıkamaya gidecek', 'Yıkandı'], ['dry', 'KURUTMA', 'Kurutmaya gidecek', 'Kurutuldu'], ['anneal', 'TAVLAMA', 'Tavlamaya gidecek', 'Tavlandı'],
  ]);
  assert.deepEqual(STEP_KEYS, ['washTo', 'washDone', 'dryTo', 'dryDone', 'annealTo', 'annealDone']);
  assert.deepEqual(CRATE_STEP_COLUMNS, ['wash_to', 'wash_done', 'dry_to', 'dry_done', 'anneal_to', 'anneal_done']);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.CARD_STEPS)), JSON.parse(JSON.stringify(CARD_STEPS)), 'dashboard/planning-card.js ile aynı liste');
  const ornek = { washTo: true, dryDone: true, annealTo: true };
  assert.equal(ui.stepsText(ornek), stepsText(ornek));
  assert.equal(stepsText(ornek), 'Yıkamaya gidecek · Kurutuldu · Tavlamaya gidecek');
  assert.equal(stepsText(HEPSI_BOS), '');
});

test('doğrulama: yoksa dokunulmaz, boolean olmayan ya da bilinmeyen anahtar 400', () => {
  assert.equal(parseSteps(undefined), undefined);
  assert.deepEqual(parseSteps({}), HEPSI_BOS);
  assert.deepEqual(parseSteps({ washTo: true }), { ...HEPSI_BOS, washTo: true });
  for (const kotu of [{ washTo: 'true' }, { washTo: 1 }, { washTo: null }, { yikama: true }, [], 'x', 5]) {
    assert.throws(() => parseSteps(kotu), (e) => e.status === 400, JSON.stringify(kotu));
  }
});

test('kart bas: işaretler kasa kaydıyla saklanır; verilmezse hiçbiri işaretli değil; iş emri geçmişine yazılır', () => {
  const { p, st } = kur();
  const w = uretimde(p, st);
  const k1 = p.issueCard(w.no, { person: 'Ayşe', steps: { washTo: true, dryTo: true } }, { now: day(9) });
  assert.deepEqual(k1.steps, { ...HEPSI_BOS, washTo: true, dryTo: true });
  const k2 = p.issueCard(w.no, { person: 'Ayşe' }, { now: day(10) });
  assert.deepEqual(k2.steps, HEPSI_BOS, 'işaret verilmeyen kart işaretsiz (öncekinden devralmaz)');
  const k3 = p.issueCard(w.no, { steps: { washDone: true, dryDone: true, annealDone: true } }, { now: day(11) });
  assert.deepEqual(k3.steps, { ...HEPSI_BOS, washDone: true, dryDone: true, annealDone: true });

  // kayıttan okununca aynı (yeniden basım, iş emri ayrıntısı, kasa listesi)
  assert.deepEqual(p.getCrate(k1.id).steps, k1.steps);
  const liste = p.getWorkOrder(w.no).crates.items;
  assert.deepEqual(liste.map((k) => k.steps.washTo), [true, false, false]);
  assert.deepEqual(p.listCrates({ woNo: w.no }).items.find((k) => k.id === k3.id).steps, k3.steps);

  const olaylar = p.getWorkOrder(w.no).events.filter((e) => e.kind === 'kart-basildi').map((e) => e.detail);
  assert.ok(olaylar.some((d) => d.includes('Yıkamaya gidecek · Kurutmaya gidecek')), olaylar.join(' | '));
});

test('kart bas: geçersiz işaret kart HARCAMAZ (numara verilmez, kayıt oluşmaz)', () => {
  const { p, st } = kur();
  const w = uretimde(p, st);
  assert.throws(() => p.issueCard(w.no, { steps: { washTo: 'evet' } }, { now: day(9) }), (e) => e.status === 400);
  assert.throws(() => p.issueCard(w.no, { steps: { baska: true } }, { now: day(9) }), (e) => e.status === 400);
  assert.equal(p.getWorkOrder(w.no).crates.items.length, 0);
  assert.equal(p.issueCard(w.no, {}, { now: day(9, 5) }).cardNo, 'K000001', 'ilk geçerli kart numarayı alır');
});

test('eski akıştan kalan AÇIK kasa kart olurken de işaretler yazılır', () => {
  const { p, st } = kur();
  const w = uretimde(p, st);
  const acik = p.openCrate(w.no, {}, { now: day(8) });
  const k = p.issueCard(w.no, { steps: { annealTo: true } }, { now: day(9) });
  assert.equal(k.id, acik.id);
  assert.deepEqual(k.steps, { ...HEPSI_BOS, annealTo: true });
});

test('geçiş: işlem sütunları olmayan eski veritabanı açılınca eklenir, eski kartlar işaretsiz görünür', () => {
  const dir = mkdtempSync(join(tmpdir(), 'planlama-kart-'));
  const dbFile = join(dir, 'planlama.db');
  try {
    const { p: p1, st } = kur(dbFile);
    const w = uretimde(p1, st);
    const eski = p1.issueCard(w.no, {}, { now: day(9) });
    p1.close();
    const raw = new DatabaseSync(dbFile);
    for (const c of [...CRATE_STEP_COLUMNS, 'reject']) raw.exec(`ALTER TABLE crates DROP COLUMN ${c}`);
    raw.close();

    const p2 = new Planning({ dbFile, listMachines: () => MAKINELER, productionEvents: () => [], liveMachine: () => null });
    assert.deepEqual(p2.getCrate(eski.id).steps, HEPSI_BOS);
    assert.equal(p2.getCrate(eski.id).reject, false);
    assert.equal(p2.getCrate(eski.id).state, 'kapali', 'eski kart ret degil, paketleme bekler');
    assert.deepEqual(p2.issueCard(w.no, { steps: { dryDone: true } }, { now: day(10) }).steps, { ...HEPSI_BOS, dryDone: true });
    p2.close();
  } finally {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows dosyayı kısa süre tutabilir; geçici dizin */ }
  }
});

test('HTTP: POST /cards steps (201), geçersiz steps 400, kasa ayrıntısında işaretler', async () => {
  const { p, st } = kur();
  st.live.set('CNC-01', { connected: true, state: 'RUNNING', program: '1', partTotal: 500 });
  const routes = createPlanningRoutes({ planning: p });
  const srv = http.createServer(async (req, res) => {
    if (!(await routes(req, res, new URL(req.url, 'http://x')))) res.writeHead(404).end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (yol, method = 'GET', obj) => {
    const r = await fetch(base + yol, { method, headers: { 'content-type': 'application/json' }, ...(obj === undefined ? {} : { body: JSON.stringify(obj) }) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  try {
    const w = (await j('/api/planning/work-orders', 'POST', { stockCode: 'SR001.013', targetQty: 20, machineId: 'CNC-01' })).json;
    await j(`/api/planning/work-orders/${w.no}/start`, 'POST', {});
    assert.equal((await j(`/api/planning/work-orders/${w.no}/cards`, 'POST', { steps: { washTo: 'x' } })).status, 400);
    const k = await j(`/api/planning/work-orders/${w.no}/cards`, 'POST', { person: 'Ayşe', steps: { washTo: true, annealDone: true } });
    assert.equal(k.status, 201);
    assert.deepEqual(k.json.steps, { ...HEPSI_BOS, washTo: true, annealDone: true });
    assert.deepEqual((await j(`/api/planning/crates/${k.json.id}`)).json.steps, k.json.steps, 'kartın yeniden basımı için ayrıntı');
    assert.equal((await j('/api/planning/crates?state=kapali')).json.items[0].steps.annealDone, true, 'paketleme listesi');
    // ÜRÜN RET: HTTP ucundan da paketlemeye gitmez
    const ret = await j(`/api/planning/work-orders/${w.no}/cards`, 'POST', { reject: true });
    assert.deepEqual([ret.status, ret.json.state, ret.json.reject], [201, 'ret', true]);
    assert.equal((await j(`/api/planning/work-orders/${w.no}/cards`, 'POST', { reject: 'evet' })).status, 400);
    assert.deepEqual((await j('/api/planning/crates?state=ret')).json.items.map((x) => x.cardNo), [ret.json.cardNo]);
    assert.ok(!(await j('/api/planning/crates?state=kapali')).json.items.some((x) => x.id === ret.json.id), 'ret kasa paketleme bekleyenlerde yok');
    const pk = await j(`/api/planning/crates/${ret.json.id}/pack`, 'POST', { qty: 5 });
    assert.deepEqual([pk.status, pk.json.code], [409, 'rejected']);
  } finally {
    await new Promise((r) => srv.close(r));
    p.close();
  }
});

test('ÜRÜN RET tiki: ret kasa paketlemeye gitmez (durum "ret", paketleme listesine düşmez, paketlenemez), iptal edilebilir', () => {
  const { p, st } = kur();
  const w = uretimde(p, st);
  const ok = p.issueCard(w.no, { person: 'Ayşe' }, { now: day(9) });
  const ret = p.issueCard(w.no, { person: 'Ayşe', reject: true, steps: { washTo: true } }, { now: day(10) });
  assert.deepEqual([ok.reject, ok.state], [false, 'kapali']);
  assert.deepEqual([ret.reject, ret.state], [true, 'ret']);
  assert.ok(ret.warnings.some((x) => /RET olarak basıldı/.test(x)));

  // paketleme listesi / sayaç: yalnız ret olmayan bekler
  assert.deepEqual(p.listCrates({ state: 'kapali' }).items.map((k) => k.cardNo), [ok.cardNo]);
  assert.deepEqual(p.listCrates({ state: 'ret' }).items.map((k) => k.cardNo), [ret.cardNo]);
  assert.equal(p.listCrates({ state: 'aktif' }).total, 2, '"hepsi" ret olanı da gösterir');
  assert.equal(p.listCrates({ state: 'paketlendi' }).total, 0);
  assert.equal(p.shopOverview({ now: day(11) }).packing.waiting, 1, 'tezgah başındaki "paketleme bekleyen" ret olanı saymaz');
  const t = p.getWorkOrder(w.no).crates.totals;
  assert.deepEqual([t.count, t.unpacked, t.rejected], [2, 1, 1]);
  assert.ok(t.rejectedCounted >= 0);

  // paketlenemez; normal kasa paketlenir
  assert.throws(() => p.packCrate(ret.id, { qty: 10 }, { now: day(11) }), (e) => e.status === 409 && e.code === 'rejected');
  assert.equal(p.packCrate(ok.id, { qty: 10 }, { now: day(11) }).state, 'paketlendi');

  // yanlış tiklenen ret kart iptal edilir (paketlenmediği için)
  assert.equal(p.voidCrate(ret.id, { reason: 'yanlış tik' }, { now: day(12) }).state, 'iptal');
  assert.equal(p.listCrates({ state: 'ret' }).total, 0);

  // geçmişe yazılır; geçersiz değer 400 ve kart numarası harcanmaz
  assert.ok(p.getWorkOrder(w.no).events.some((e) => e.kind === 'kart-basildi' && /ÜRÜN RET/.test(e.detail)));
  const sira = p.db.nextCrateSeq().next;
  assert.throws(() => p.issueCard(w.no, { reject: 'evet' }, { now: day(13) }), (e) => e.status === 400);
  assert.equal(p.db.nextCrateSeq().next, sira);
});

test('kart (ekran): ÜRÜN RET satırı kutulu; işaretliyse ✓ ve "paketlemeye gitmez" yazar, el yazısı bloğu yok', () => {
  const bos = ui.cardHtml({ cardNo: 'K000001', stockCode: 'ZZ', customerCode: 'M', machineId: 'CNC-01', woNo: '1', gkkReportNo: '', steps: {} });
  const ret = ui.cardHtml({ cardNo: 'K000002', stockCode: 'ZZ', customerCode: 'M', machineId: 'CNC-01', woNo: '1', gkkReportNo: '', steps: {}, reject: true });
  for (const h of [bos, ret]) {
    assert.ok(h.includes('ÜRÜN RET') && h.includes('Ürün ret edildi (paketlemeye gitmez)'));
    assert.ok(!/<input|<textarea|UYGUNSUZLUK|YENİDEN İŞLEM/.test(h), 'kartta giriş alanı ya da el yazısı bloğu yok');
  }
  const kutu = (h) => /pl-c-reject[^>]*>.*?<i class="pl-c-box( is-on)?"/s.exec(h)?.[1] ?? '';
  assert.equal(kutu(bos), '');
  assert.equal(kutu(ret), ' is-on');
  assert.ok(ret.indexOf('TAVLAMA') < ret.indexOf('ÜRÜN RET'), 'ret satırı işlem satırlarından sonra');
});
