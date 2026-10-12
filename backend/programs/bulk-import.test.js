/**
 * Toplu iceri alma (bir tornadaki TUM programlari kutuphaneye alma): plan -> karar -> uygula.
 * Sahte Windows CE FTP sunucusuna karsi. Kanitlanan kurallar:
 *   - tornaya YALNIZ OKUMA (hicbir STOR/RNFR/RNTO/DELE/MKD/RMD yok)
 *   - siniflandirma: yeni / ayni / cakisma (ayni ad, farkli icerik) / alinamaz; cakisma OTOMATIK alinmaz
 *   - satir sonu farki (CRLF/LF) ayrica isaretlenir
 *   - kararlar uygulanir, ayni plan ikinci kez uygulanirsa tekrar surum acilmaz
 *   - plan sirasinda tezgah kilitli (409), baglanti kopunca plan hata verir ve kilit acilir
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { kur, ekle } from './test/harness.js';
import { sha256, ValidationError, Library } from './library.js';
import { BusyError, NotFoundError } from './machine-files.js';
import { ImportPlans, modifiedHint, planKey } from './bulk-import.js';

const A = Buffer.from('//A  YENI PROGRAM\r\nG0 X0.\r\nM99\r\n');
const B = Buffer.from('//B  AYNI PROGRAM\r\nG0 X5.\r\nM99\r\n');
const C = Buffer.from('//C  TEZGAHTA DEGISMIS\r\nG0 X7.\r\nM99\r\n');
const D = Buffer.from('//C  KUTUPHANEDE\r\nG0 X6.\r\nM99\r\n');
const EOL_CRLF = Buffer.from('G0 X0.\r\nG1 Z-5.\r\nM99\r\n');
const EOL_LF = Buffer.from('G0 X0.\nG1 Z-5.\nM99\n');

const yazma = (s) => s.commands.filter((k) => /^(STOR|RNFR|RNTO|DELE|MKD|XMKD|RMD|XRMD)\b/.test(k));

function tohum(s) {
  s.put('MUSTERI_B/NEW-1', A);
  s.put('MUSTERI_B/SAME-1', B);
  s.put('MUSTERI_B/DIFF-1', C);
  s.put('MUSTERI_B/EOL-1', EOL_LF);
  s.put('AA/NEW-2', A);
  s.put('MUSTERI_B/BAD NAME', A);
  s.put('MUSTERI_B/ZZUP123456', A);
  s.put('MUSTERI_B/BIG-1', Buffer.alloc(1_100_000, 65));
  s.put('MUSTERI_B/BIN-1', Buffer.from([65, 0, 66]));
  s.put('MUSTERI_B/EMPTY-1', Buffer.alloc(0));
}
function kutuphane(lib) {
  ekle(lib, 'MUSTERI_B', 'SAME-1', B);
  ekle(lib, 'MUSTERI_B', 'DIFF-1', D);
  ekle(lib, 'MUSTERI_B', 'EOL-1', EOL_CRLF);
}

async function planBekle(files, machineId, planId, ms = 10_000) {
  const son = Date.now() + ms;
  for (;;) {
    const p = files.getImportPlan(machineId, planId);
    if (p.status !== 'calisiyor') return p;
    if (Date.now() > son) throw new Error('plan zamaninda bitmedi');
    await sleep(20);
  }
}
const planYap = async (t, opts = {}) => planBekle(t.files, 'CNC-08', t.files.startImportPlan({ machineId: 'CNC-08', ...opts }));

/* ----------------------------------------------------------------------- siniflandirma */

test('plan: yeni / ayni / cakisma / alinamaz siniflanir; tornaya YALNIZ OKUMA; icerik istemciye gitmez', async () => {
  const t = await kur({ seed: tohum });
  try {
    kutuphane(t.library);
    const r = await planYap(t);
    assert.equal(r.status, 'bitti', r.error);
    const p = r.plan;

    assert.deepEqual(p.yeni.map((x) => planKey(x.customer, x.name)).sort(), ['AA\\NEW-2', 'MUSTERI_B\\NEW-1', '\\O9001']);
    assert.deepEqual(p.ayni.map((x) => x.name), ['SAME-1']);
    assert.equal(p.ayni[0].versionNo, 1);
    assert.deepEqual(p.cakisma.map((x) => x.name).sort(), ['DIFF-1', 'EOL-1']);
    assert.deepEqual(p.atlanan.map((x) => x.name).sort(), ['BAD NAME', 'BIG-1', 'BIN-1', 'EMPTY-1', 'ZZUP123456']);
    const neden = Object.fromEntries(p.atlanan.map((x) => [x.name, x.reason]));
    assert.match(neden['BAD NAME'], /Program adı geçersiz/);
    assert.match(neden['ZZUP123456'], /aktarım artığı/);
    assert.match(neden['BIG-1'], /çok büyük/);
    assert.match(neden['BIN-1'], /ikili/);
    assert.match(neden['EMPTY-1'], /boş/);
    assert.deepEqual(p.summary, { listed: 12, yeni: 3, ayni: 1, cakisma: 2, atlanan: 5, bytes: p.summary.bytes, eolOnly: 1 });
    assert.ok(!p.yeni.concat(p.ayni, p.cakisma, p.atlanan).some((x) => x.name === 'MDIBlock'), 'sistem dosyasi hic listelenmez');

    const diff = p.cakisma.find((x) => x.name === 'DIFF-1');
    assert.equal(diff.libraryVersion, 1);
    assert.equal(diff.eolOnlyVersion, null);
    assert.equal(diff.sha256, sha256(C));
    const eol = p.cakisma.find((x) => x.name === 'EOL-1');
    assert.equal(eol.eolOnlyVersion, 1, 'yalniz satir sonu farki: kutuphanedeki surumle metni ayni');

    assert.equal(yazma(t.server).length, 0, 'plan tornaya HICBIR sey yazmaz');
    const okunan = t.server.commands.filter((k) => k.startsWith('RETR')).map((k) => k.slice(5)).sort();
    assert.deepEqual(okunan, ['BIN-1', 'DIFF-1', 'EOL-1', 'NEW-1', 'NEW-2', 'O9001', 'SAME-1'], 'boyut/ad nedeniyle atlananlar indirilmez');
    assert.ok(!JSON.stringify(r).includes('G0 X0.'), 'dosya icerigi yanita girmez');
  } finally { await t.kapat(); }
});

test('plan: torna envanteri tazelenir (matris hemen dogru), SHA\'lar islenir', async () => {
  const t = await kur({ seed: tohum });
  try {
    kutuphane(t.library);
    await planYap(t);
    const inv = t.library.db.getInventory('CNC-08');
    assert.equal(inv.length, 12);
    assert.equal(inv.find((e) => e.name === 'NEW-1').sha256, sha256(A));
    assert.equal(inv.find((e) => e.name === 'BAD NAME').sha256, null, 'indirilmeyenin SHA\'si yok');
    assert.equal(t.library.db.getScan('CNC-08').status, 'tamam');
    assert.deepEqual(t.library.db.getFolders('CNC-08'), ['AA', 'MUSTERI_B']);
    const durum = Object.fromEntries(t.library.compareMachine('CNC-08').entries.map((e) => [`${e.customer}/${e.name}`, e.status]));
    assert.equal(durum['MUSTERI_B/SAME-1'], 'guncel');
    assert.equal(durum['MUSTERI_B/DIFF-1'], 'farkli');
    assert.equal(durum['MUSTERI_B/NEW-1'], 'kutuphanede-yok');
  } finally { await t.kapat(); }
});

test('plan: klasor secimi yalniz o klasorleri okur (kok ve digerleri hayir), envanteri bozmaz', async () => {
  const t = await kur({ seed: tohum });
  try {
    const r = await planYap(t, { folders: ['aa'] });
    assert.deepEqual(r.plan.yeni.map((x) => x.name), ['NEW-2']);
    assert.equal(r.plan.summary.listed, 1);
    assert.equal(r.plan.filtered, true);
    const girilen = t.server.commands.filter((k) => k.startsWith('CWD'));
    assert.ok(girilen.length >= 1 && girilen.every((k) => k === 'CWD AA'), `yalniz AA klasorune girilmeli: ${girilen}`);
    assert.equal(t.library.db.getScan('CNC-08'), null, 'kismi okuma tam tarama sayilmaz');
    await assert.rejects(async () => t.files.startImportPlan({ machineId: 'CNC-08', folders: 'AA' }), ValidationError);
  } finally { await t.kapat(); }
});

test('plan: TRANSFER_DISABLED ve 22TB (yazma kapali model) OKUMAYI engellemez', async () => {
  const t = await kur({ disabled: true, seed: tohum });
  try {
    t.machines.push({ id: 'CNC-22', name: 'Torna 22', ip: '127.0.0.1', driverId: 'syntec-remoteapi', controllerModel: '22TB' });
    const id = t.files.startImportPlan({ machineId: 'CNC-22' });
    const r = await planBekle(t.files, 'CNC-22', id);
    assert.equal(r.status, 'bitti', r.error);
    assert.ok(r.plan.summary.yeni >= 1);
    assert.equal(yazma(t.server).length, 0);
  } finally { await t.kapat(); }
});

/* --------------------------------------------------------------------- uygula */

test('uygula: yeniler alinir, cakisma YALNIZ "al" denirse yeni surum olur, atla/skipKeys alinmaz, kaynak/kim/not yazilir', async () => {
  const t = await kur({ seed: tohum });
  try {
    kutuphane(t.library);
    const { planId } = { planId: t.files.startImportPlan({ machineId: 'CNC-08' }) };
    await planBekle(t.files, 'CNC-08', planId);

    const out = t.files.applyImport({
      machineId: 'CNC-08', planId, by: 'ayse',
      decisions: { [planKey('MUSTERI_B', 'DIFF-1')]: 'al', [planKey('MUSTERI_B', 'EOL-1')]: 'atla' },
      skipKeys: [planKey('AA', 'NEW-2')],
    });
    assert.deepEqual(out, { yeniProgram: 2, yeniSurum: 1, zatenVardi: 0, atlanan: 2, hatalar: [] });

    const lib = t.library.db;
    const yeni = lib.findProgram('MUSTERI_B', 'NEW-1');
    const v = lib.getVersion(yeni.id, 1);
    assert.equal(v.meta.source, 'tezgah-tarama');
    assert.equal(v.meta.sourceMachine, 'CNC-08');
    assert.equal(v.meta.createdBy, 'ayse');
    assert.equal(v.meta.note, 'CNC-08 toplu alım');
    assert.ok(v.content.equals(A), 'tornadan okunan baytlar AYNEN');
    assert.ok(lib.findProgram('', 'O9001'), 'kok (ortak alan) programi da alinir');
    assert.equal(lib.findProgram('AA', 'NEW-2'), null, 'skipKeys: alinmadi');

    const diff = lib.findProgram('MUSTERI_B', 'DIFF-1');
    assert.equal(lib.listVersions(diff.id).length, 2, 'cakisma "al": yeni surum, eski surum durur');
    assert.ok(lib.getVersion(diff.id, 2).content.equals(C));
    assert.ok(lib.getVersion(diff.id, 1).content.equals(D), 'kutuphanedeki eski surum aynen kaldi');
    const eol = lib.findProgram('MUSTERI_B', 'EOL-1');
    assert.equal(lib.listVersions(eol.id).length, 1, '"atla": degismedi');

    const durum = Object.fromEntries(t.library.compareMachine('CNC-08').entries.map((e) => [`${e.customer}/${e.name}`, e.status]));
    assert.equal(durum['MUSTERI_B/NEW-1'], 'guncel', 'alinan program artik guncel');
    assert.equal(durum['MUSTERI_B/DIFF-1'], 'guncel');
    assert.equal(durum['MUSTERI_B/EOL-1'], 'farkli', 'atlanan cakisma hala farkli');
    assert.equal(yazma(t.server).length, 0, 'uygulama tornaya hic baglanmaz/yazmaz');
  } finally { await t.kapat(); }
});

test('uygula: ayni plan ikinci kez uygulanirsa tekrar surum ACILMAZ; gecersiz karar ve yabanci/olmayan plan reddedilir', async () => {
  const t = await kur({ seed: tohum });
  try {
    kutuphane(t.library);
    t.machines.push({ id: 'CNC-07', name: 'Torna 7', ip: '127.0.0.1', driverId: 'syntec-remoteapi' });
    const planId = t.files.startImportPlan({ machineId: 'CNC-08' });
    await planBekle(t.files, 'CNC-08', planId);
    const kararlar = { [planKey('MUSTERI_B', 'DIFF-1')]: 'al' };
    t.files.applyImport({ machineId: 'CNC-08', planId, decisions: kararlar });
    const ikinci = t.files.applyImport({ machineId: 'CNC-08', planId, decisions: kararlar });
    assert.equal(ikinci.yeniProgram + ikinci.yeniSurum, 0, 'ikinci uygulama yeni bir sey eklemez');
    assert.equal(ikinci.zatenVardi, 4, '3 yeni + 1 cakisma zaten kutuphanede');
    assert.equal(t.library.db.listVersions(t.library.db.findProgram('MUSTERI_B', 'DIFF-1').id).length, 2);

    assert.throws(() => t.files.applyImport({ machineId: 'CNC-08', planId, decisions: { x: 'belki' } }), ValidationError);
    assert.throws(() => t.files.applyImport({ machineId: 'CNC-08', planId, decisions: [] }), ValidationError);
    assert.throws(() => t.files.applyImport({ machineId: 'CNC-08', planId: 'yok-boyle-plan' }), NotFoundError);
    assert.throws(() => t.files.applyImport({ machineId: 'CNC-07', planId }), NotFoundError, 'baska tezgahin plani uygulanamaz');
    assert.throws(() => t.files.getImportPlan('CNC-07', planId), NotFoundError);
  } finally { await t.kapat(); }
});

test('fark: cakismanin iki tarafi (tornadaki ve kutuphanedeki son surum) ve satir sonu bilgisi gelir', async () => {
  const t = await kur({ seed: tohum });
  try {
    kutuphane(t.library);
    const planId = t.files.startImportPlan({ machineId: 'CNC-08' });
    await planBekle(t.files, 'CNC-08', planId);

    const d = t.files.importPlanDiff('CNC-08', planId, planKey('MUSTERI_B', 'DIFF-1'));
    assert.match(d.lathe.text, /TEZGAHTA DEGISMIS/);
    assert.match(d.library.text, /KUTUPHANEDE/);
    assert.equal(d.library.versionNo, 1);
    assert.equal(d.eolOnlyVersion, null);

    const e = t.files.importPlanDiff('CNC-08', planId, planKey('MUSTERI_B', 'EOL-1'));
    assert.equal(e.lathe.lineEnding, 'LF');
    assert.equal(e.library.lineEnding, 'CRLF');
    assert.equal(e.eolOnlyVersion, 1);

    assert.throws(() => t.files.importPlanDiff('CNC-08', planId, planKey('MUSTERI_B', 'NEW-1')), NotFoundError, 'yeni olan cakisma degil');
    assert.throws(() => t.files.importPlanDiff('CNC-08', planId, 'yok'), NotFoundError);
  } finally { await t.kapat(); }
});

/* ------------------------------------------------------- kilit, ilerleme, kopma */

test('plan suresince tezgah kilitli (409), ilerleme bildirilir, bitince kilit acilir', async () => {
  const t = await kur({ ftp: { delayMs: 25 }, seed: tohum });
  try {
    const planId = t.files.startImportPlan({ machineId: 'CNC-08' });
    const ilk = t.files.getImportPlan('CNC-08', planId);
    assert.equal(ilk.status, 'calisiyor');
    await assert.rejects(() => t.files.scan('CNC-08'), (e) => e instanceof BusyError && /toplu okuma/.test(e.message));
    assert.throws(() => t.files.startImportPlan({ machineId: 'CNC-08' }), BusyError);

    let okumaGoruldu = false;
    const son = Date.now() + 15_000;
    for (;;) {
      const p = t.files.getImportPlan('CNC-08', planId);
      if (p.progress.phase === 'okuma' && p.progress.total > 0) okumaGoruldu = true;
      if (p.status !== 'calisiyor') break;
      assert.ok(Date.now() < son, 'plan bitmedi');
      await sleep(15);
    }
    assert.ok(okumaGoruldu, 'okuma asamasinda toplam/yapilan bildirildi');
    const r = await t.files.scan('CNC-08'); // kilit acildi
    assert.ok(r.entries > 0);
  } finally { await t.kapat(); }
});

test('baglanti kopunca plan "hata" olur, kilit acilir, kutuphane ve envanter bozulmaz', async () => {
  const t = await kur({ ftp: { delayMs: 40 }, seed: tohum });
  try {
    kutuphane(t.library);
    const onceki = t.library.db.stats().versions;
    const planId = t.files.startImportPlan({ machineId: 'CNC-08' });
    await sleep(150);
    await t.server.stop();
    const r = await planBekle(t.files, 'CNC-08', planId);
    assert.equal(r.status, 'hata');
    assert.match(r.error, /bağlantı|yanıt/);
    await sleep(50);
    assert.equal(t.files.locks.has('CNC-08'), false, 'kilit acildi');
    assert.equal(t.library.db.stats().versions, onceki);
    assert.equal(t.library.db.getScan('CNC-08'), null, 'yarim plan envanteri degistirmedi');
    assert.throws(() => t.files.applyImport({ machineId: 'CNC-08', planId }), NotFoundError, 'hatali plan uygulanamaz');
  } finally { await t.library.close(); }
});

/* ---------------------------------------------------------- yardimcilar (birim) */

test('modifiedHint: tezgah tarihi kutuphane surumunden yeni/eski/ayni gun; gecersiz tarih null', () => {
  const kutup = new Date(2026, 8, 1, 12, 0).getTime();
  assert.equal(modifiedHint('2026-10-12 10:00', kutup), 'tezgah-yeni');
  assert.equal(modifiedHint('2026-01-01 10:00', kutup), 'kutuphane-yeni');
  assert.equal(modifiedHint('2026-09-01 09:30', kutup), 'ayni-gun');
  for (const kotu of [null, '', 'dun', '1980-01-01 00:00', '2026-13-45 99:99x']) assert.equal(modifiedHint(kotu, kutup), null, String(kotu));
  assert.equal(modifiedHint('2026-10-12 10:00', Number.NaN), null);
});

test('plan deposu: sure dolunca silinir, calisan plan silinmez, baska tezgah goremez, sayi sinirli', () => {
  const clock = { t: 1_000_000 };
  const plans = new ImportPlans({ now: () => clock.t, ttlMs: 60_000 });
  const biten = plans.create('CNC-01');
  biten.status = 'bitti';
  const calisan = plans.create('CNC-02');
  assert.equal(plans.get(biten.id, 'CNC-01'), biten);
  assert.equal(plans.get(biten.id, 'CNC-02'), null, 'baska tezgahin plani gorulmez');
  clock.t += 61_000;
  assert.equal(plans.get(biten.id, 'CNC-01'), null, 'bitmis plan TTL sonrasi gider');
  assert.equal(plans.get(calisan.id, 'CNC-02'), calisan, 'calisan plan silinmez');

  // ayni tezgahin yeni plani eskisini (bitmis) atar
  const a = plans.create('CNC-03'); a.status = 'bitti';
  const b = plans.create('CNC-03');
  assert.equal(plans.get(a.id, 'CNC-03'), null);
  assert.equal(plans.get(b.id, 'CNC-03'), b);
  for (let i = 0; i < 20; i += 1) plans.create(`CNC-X${i}`);
  assert.ok(plans.plans.size <= 6, 'bellekte en fazla 6 plan');
});

test('classifyIncoming: yeni / ayni / cakisma ve satir sonu esdegeri', () => {
  const lib = new Library(':memory:');
  assert.deepEqual(lib.classifyIncoming({ customer: 'AA', name: 'P1', sha256: sha256(A), content: A }), { kind: 'yeni' });
  ekle(lib, 'AA', 'P1', EOL_CRLF);
  ekle(lib, 'aa', 'P1', Buffer.from('G0 X9.\r\nM99\r\n')); // 2. surum (ad buyuk/kucuk harf duyarsiz)
  const ayni = lib.classifyIncoming({ customer: 'AA', name: 'p1', sha256: sha256(EOL_CRLF), content: EOL_CRLF });
  assert.equal(ayni.kind, 'ayni');
  assert.equal(ayni.versionNo, 1);
  assert.equal(ayni.latestVersion, 2, 'eski surumle ayni: "ayni" (ve son surum 2 oldugu bildirilir)');
  const eol = lib.classifyIncoming({ customer: 'AA', name: 'P1', sha256: sha256(EOL_LF), content: EOL_LF });
  assert.equal(eol.kind, 'cakisma');
  assert.equal(eol.eolOnlyVersion, 1);
  assert.equal(eol.latest.versionNo, 2);
  const baska = lib.classifyIncoming({ customer: 'AA', name: 'P1', sha256: sha256(C), content: C });
  assert.equal(baska.eolOnlyVersion, null);
  lib.close();
});
