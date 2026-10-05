/**
 * Yeniden baslama sonrasi zaman cizelgesi: PC (ve onunla birlikte backend ile
 * ajan) kapaliyken gecen sure NO_DATA olmali, kapanmadan onceki son durum
 * OLMAMALI. Aksi halde RUNNING iken kapanan bir PC'nin kapali kaldigi saatler
 * "calisiyor" sayilir ve calisma orani sisirilir.
 *
 * Calistirma:  npm test      (Node'un gomulu test calistiricisi, bagimlilik yok)
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTelemetry } from '../shared/schema.js';
import { TelemetryStore } from './store.js';

const SN = 1000;
const SA = 3_600_000;
const T0 = Date.UTC(2026, 9, 5, 8, 0, 0);

/** Gecici veritabani + sahte saat; bitince hepsini temizler. */
async function senaryo(govde) {
  const dir = mkdtempSync(join(tmpdir(), 'cnc-test-'));
  const file = join(dir, 'telemetry.db');
  const acik = [];
  mock.timers.enable({ apis: ['Date'], now: T0 });
  try {
    const ac = () => {
      const store = new TelemetryStore(file);
      acik.push(store);
      return store;
    };
    await govde({ ac, file, ilerlet: (ms) => mock.timers.tick(ms) });
  } finally {
    mock.timers.reset();
    for (const s of acik) {
      clearInterval(s.db.flushTimer);
      try { s.db.db.close(); } catch { /* ani kapanista zaten kapatilmis */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

function mesaj(status, machineId = 'CNC-01') {
  const r = parseTelemetry({ machineId, status, ts: new Date().toISOString(), partCount: 1 });
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.value;
}

/** Ani kapanis: kayit kapatilmaz, bekleyen ornekler yazilmaz - surec olmus gibi. */
function aniKapat(store) {
  clearInterval(store.db.flushTimer);
  store.db.db.close();
}

/**
 * Pencerenin ucu "simdi + 1 sn": hala ACIK olan son aralik pencereye girsin
 * (spans() baslangici ucundan kucuk olanlari alir) ve suresi 1 sn gorunsun.
 */
const pencereSonu = () => Date.now() + SN;
const araliklar = (store, id = 'CNC-01') =>
  store.db.spans(id, T0 - SA, pencereSonu()).map((s) => [s.state, s.endedAt - s.startedAt]);

test('ani kapanis: kapali kalinan sure NO_DATA, son duruma yazilmaz', async () => {
  await senaryo(async ({ ac, ilerlet }) => {
    const a = ac();
    a.ingest(mesaj('RUNNING'));
    ilerlet(5 * SN);
    a.ingest(mesaj('RUNNING'));
    a.db.flush(); // zamanlayici bu ornekleri diske yazmis olurdu
    aniKapat(a);

    ilerlet(2 * SA); // PC iki saat kapali kaldi
    const b = ac();
    ilerlet(10 * SN); // acildi, ajan ilk ornegi 10 sn sonra gonderdi
    b.ingest(mesaj('IDLE'));

    assert.deepEqual(araliklar(b), [
      ['RUNNING', 5 * SN], // yalnizca gercekten olculen sure
      ['NO_DATA', 2 * SA + 10 * SN], // son orneginden ilk yeni ornege kadar
      ['IDLE', SN],
    ]);

    const ozet = b.db.summary('CNC-01', T0 - SA, pencereSonu());
    assert.equal(ozet.totals.RUNNING, 5 * SN);
    assert.equal(ozet.gapCount, 1);
  });
});

test('duzgun kapanis: kapali kalinan sure yine NO_DATA', async () => {
  await senaryo(async ({ ac, ilerlet }) => {
    const a = ac();
    a.ingest(mesaj('RUNNING'));
    ilerlet(5 * SN);
    a.close(); // aciklari kapatir, veritabanini kapatir

    ilerlet(3 * SA);
    const b = ac();
    b.ingest(mesaj('IDLE'));

    assert.deepEqual(araliklar(b), [
      ['RUNNING', 5 * SN],
      ['NO_DATA', 3 * SA],
      ['IDLE', SN],
    ]);
  });
});

test('zaten NO_DATA olan tezgah: yeniden baslama boslugu ikiye bolmez', async () => {
  await senaryo(async ({ ac, ilerlet }) => {
    const a = ac();
    a.ingest(mesaj('RUNNING'));
    ilerlet(5 * SN);
    a.ingest(mesaj('RUNNING'));
    ilerlet(60 * SN); // sessizlik esigini (10 sn) asti
    a.sweep(); // NO_DATA aralığı acilir
    a.db.flush();
    aniKapat(a);

    ilerlet(SA);
    const b = ac();
    ilerlet(2 * SN);
    b.ingest(mesaj('IDLE'));

    const nodata = araliklar(b).filter(([durum]) => durum === 'NO_DATA');
    assert.equal(nodata.length, 1, 'tek, kesintisiz bir bosluk olmali');
    // Bosluk, son orneginden (t=5 sn) ilk yeni ornege kadar: 60 sn sessizlik
    // + 1 saat kapali + 2 sn.
    assert.equal(nodata[0][1], 60 * SN + SA + 2 * SN);
  });
});

test('hic veri gelmemis tezgah icin sahte bosluk uretilmez', async () => {
  await senaryo(async ({ ac, ilerlet }) => {
    const a = ac();
    a.ingest(mesaj('RUNNING'));
    aniKapat(a);
    ilerlet(SA);
    const b = ac();
    assert.deepEqual(araliklar(b, 'CNC-03'), []);
  });
});

test('envanterde olmayan tezgah: acik aralik kapanir, NO_DATA acilmaz', async () => {
  await senaryo(async ({ ac, ilerlet }) => {
    const a = ac();
    a.ingest(mesaj('RUNNING', 'XYZ-99'));
    ilerlet(5 * SN);
    a.ingest(mesaj('RUNNING', 'XYZ-99'));
    a.db.flush();
    aniKapat(a);

    ilerlet(SA);
    const b = ac();

    assert.deepEqual(araliklar(b, 'XYZ-99'), [['RUNNING', 5 * SN]]);
    const acik = b.db.db.prepare('SELECT COUNT(*) AS n FROM spans WHERE ended_at IS NULL AND machine_id = ?').get('XYZ-99').n;
    assert.equal(Number(acik), 0, 'sonsuza dek acik bosluk kalmamali');
  });
});

test('iki kez ust uste yeniden baslama: bosluk kesintisiz tek aralik', async () => {
  await senaryo(async ({ ac, ilerlet }) => {
    const a = ac();
    a.ingest(mesaj('RUNNING'));
    ilerlet(5 * SN);
    a.ingest(mesaj('RUNNING'));
    a.db.flush();
    aniKapat(a);

    ilerlet(SA);
    const b = ac();
    b.close(); // acilir acilmaz duzgun kapanir, hic veri gelmedi

    ilerlet(SA);
    const c = ac();
    ilerlet(SN);
    c.ingest(mesaj('IDLE'));

    const nodata = araliklar(c).filter(([durum]) => durum === 'NO_DATA');
    assert.equal(nodata.length, 1);
    assert.equal(nodata[0][1], 2 * SA + SN);
  });
});
