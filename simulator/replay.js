/**
 * Kayitli GERCEK veriyi canli gibi oynatir (demo icin).
 *
 * Simulator sahte veri uretir; bu arac ise daha once gercek bir tezgahtan
 * yakalanip veritabaninda duran ornekleri sirayla backend'e yollar. Degerler
 * gercektir, yalnizca zamanlari "simdi"ye cekilir.
 *
 * Kurallar:
 *  - Oynatilan veri ASLA kaynak veritabanina geri yazilmamali: kaynagi okurken
 *    backend baska bir veritabanina (data/demo.db) yazmali. `npm run demo` bunu
 *    ayarlar.
 *  - Ornekler seyreltilmis kayitlardir (~6 sn arayla). Her saniye son deger
 *    tutulup yollanir; backend'in bosluk esigi asilmaz, durum degisimleri kaydedildigi
 *    anda olur.
 *  - Kayittaki uzun bosluklar (ajan/backend kapali kalmis) kisaltilir.
 *  - Kayit bitince basa doner; birikimli sayaclar (parca, kesme suresi...) geriye
 *    gitmesin diye her turda kayit boyunca artan miktar kadar kaydirilir.
 *
 * Kullanim:
 *   node simulator/replay.js [--kaynak data/gercek.db] [--url http://127.0.0.1:3000/api/ingest]
 *                            [--hiz 1] [--makine CNC-08]
 */
import { DatabaseSync } from 'node:sqlite';

const arg = (ad, varsayilan) => {
  const i = process.argv.indexOf(`--${ad}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : varsayilan;
};

const KAYNAK = arg('kaynak', 'data/gercek.db');
const URL_ = arg('url', 'http://127.0.0.1:3000/api/ingest');
const HIZ = Number(arg('hiz', '1'));
const MAKINE = arg('makine', null);
const TICK_MS = 1000;
/** Kayittaki iki ornek arasi bundan uzunsa oynatirken bu kadar sayilir. */
const ARA_SINIRI_MS = 7000;
/** Gercek tezgahta tek yonlu artan sayaclar (work_time sifirlandigi icin dahil degil). */
const BIRIKIMLI = ['part_count', 'part_total', 'cutting_time', 'power_on_time'];

const json = (metin, yedek) => {
  if (metin == null || metin === '') return yedek;
  try {
    return JSON.parse(metin);
  } catch {
    return yedek;
  }
};

function kaydiYukle() {
  const db = new DatabaseSync(KAYNAK, { readOnly: true });
  const satirlar = MAKINE
    ? db.prepare('SELECT * FROM samples WHERE machine_id = ? ORDER BY ts').all(MAKINE)
    : db.prepare('SELECT * FROM samples ORDER BY machine_id, ts').all();
  db.close();

  const gruplar = new Map();
  for (const s of satirlar) {
    if (!gruplar.has(s.machine_id)) gruplar.set(s.machine_id, []);
    gruplar.get(s.machine_id).push(s);
  }

  const kayitlar = [];
  for (const [id, rows] of gruplar) {
    // Oynatma zamani: bosluklar kisaltilmis birikimli sure.
    let t = 0;
    const zaman = rows.map((r, i) => {
      if (i > 0) t += Math.min(r.ts - rows[i - 1].ts, ARA_SINIRI_MS);
      return t;
    });
    const ilk = rows[0];
    const son = rows[rows.length - 1];
    const kayma = {};
    for (const k of BIRIKIMLI) {
      kayma[k] = ilk[k] != null && son[k] != null ? son[k] - ilk[k] : 0;
    }
    kayitlar.push({ id, rows, zaman, sure: t + TICK_MS, kayma });
  }
  return kayitlar;
}

function mesaj(r, tur, kayma) {
  const k = (alan) => (r[alan] == null ? null : r[alan] + tur * kayma[alan]);
  return {
    machineId: r.machine_id,
    ts: new Date().toISOString(),
    source: r.source,
    status: r.status,
    spindleRpm: r.spindle_rpm,
    feedRate: r.feed_rate,
    spindleOverridePct: r.spindle_ov,
    feedOverridePct: r.feed_ov,
    partCount: k('part_count'),
    partTarget: r.part_target,
    partTotal: k('part_total'),
    cycleTimeSec: r.cycle_time,
    cuttingTimeSec: k('cutting_time'),
    powerOnTimeSec: k('power_on_time'),
    workTimeSec: r.work_time,
    blockNo: r.block_no,
    program: r.program,
    mainProgram: r.main_program,
    mode: r.mode,
    block: r.block,
    alarms: json(r.alarms, []),
    downtimeReason: r.downtime_reason,
    controller: json(r.controller, undefined),
  };
}

const kayitlar = kaydiYukle();
if (kayitlar.length === 0) {
  console.error(`[oynat] ${KAYNAK} icinde oynatilacak ornek yok`);
  process.exit(1);
}
for (const k of kayitlar) {
  console.log(
    `[oynat] ${k.id}: ${k.rows.length} gercek ornek, tur suresi ~${Math.round(k.sure / 1000)} sn (${KAYNAK})`,
  );
}

const baslangic = Date.now();
let cevrimici = null;

async function tick() {
  const gecen = (Date.now() - baslangic) * HIZ;
  const batch = [];
  for (const k of kayitlar) {
    const tur = Math.floor(gecen / k.sure);
    const konum = gecen % k.sure;
    // Konumdan once ya da o anda kaydedilmis son ornek.
    let i = 0;
    while (i + 1 < k.rows.length && k.zaman[i + 1] <= konum) i++;
    batch.push(mesaj(k.rows[i], tur, k.kayma));
  }
  try {
    const res = await fetch(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(batch),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (cevrimici !== true) console.log(`[oynat] backend'e baglandi -> ${URL_}`);
    cevrimici = true;
  } catch (err) {
    if (cevrimici !== false) console.log(`[oynat] backend yok (${err.message}), yeniden denenecek`);
    cevrimici = false;
  }
}

setInterval(tick, TICK_MS);
tick();
