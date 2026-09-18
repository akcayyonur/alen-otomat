/**
 * Modbus register kesfi: bir araligi periyodik okur, JSONL olarak kaydeder ve
 * sonunda iki analiz yapar:
 *   1. Hangi register'lar degisti  - sabit olanlar ayar, degisenler canli veri
 *   2. Bilinen degerler nerede     - ekrandaki parca sayaci/devir hangi adreste
 *
 * Kullanim:
 *   node tools/modbus-dump.js --host 192.168.88.99 --start 0 --count 600 \
 *        --seconds 60 --find 962,11064,1977
 */
import { writeFileSync, appendFileSync } from 'node:fs';
import { ModbusClient, combine32 } from './modbus.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    args[key] = next && !next.startsWith('--') ? (i += 1, next) : 'true';
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const host = args.host;
if (!host) {
  console.error('kullanim: node tools/modbus-dump.js --host <ip> [--start 0] [--count 600] [--seconds 60] [--interval 1000] [--unit 1] [--port 502] [--find 962,1977] [--input] [--out dosya.jsonl]');
  process.exit(1);
}

const start = Number(args.start ?? 0);
const count = Number(args.count ?? 200);
const seconds = Number(args.seconds ?? 60);
const intervalMs = Number(args.interval ?? 1000);
const unitId = Number(args.unit ?? 1);
const port = Number(args.port ?? 502);
const useInput = args.input === 'true';
const outFile = args.out ?? `modbus-${host.replace(/\./g, '_')}-${Date.now()}.jsonl`;
const known = (args.find ?? '').split(',').map((v) => Number(v.trim())).filter(Number.isFinite);

const client = new ModbusClient({ host, port, unitId });

console.log(`[dump] ${host}:${port}  unit=${unitId}  ${useInput ? 'input' : 'holding'} register ${start}..${start + count - 1}`);
console.log(`[dump] ${seconds} sn boyunca ${intervalMs}ms araliklarla -> ${outFile}\n`);

try {
  await client.connect();
  console.log('[dump] baglandi\n');
} catch (err) {
  console.error(`[dump] BAGLANTI BASARISIZ: ${err.message}`);
  console.error('[dump] Kontrolcude Modbus slave acik mi (Pr3234=9)? Slave ID dogru mu (Pr3235)?');
  process.exit(1);
}

writeFileSync(outFile, '');

/** Her register icin gorulen farkli degerler - degisenleri bulmak icin. */
const seen = new Map();
const samples = [];
const deadline = Date.now() + seconds * 1000;
let errorCount = 0;

while (Date.now() < deadline) {
  const ts = new Date().toISOString();
  try {
    const values = await client.readRange(start, count, { input: useInput });
    samples.push(values);
    appendFileSync(outFile, JSON.stringify({ ts, start, values }) + '\n');

    values.forEach((v, i) => {
      const set = seen.get(i) ?? new Set();
      set.add(v);
      seen.set(i, set);
    });

    const degisen = [...seen.values()].filter((s) => s.size > 1).length;
    process.stdout.write(`\r[dump] ${samples.length} ornek · degisen register: ${degisen}   `);
  } catch (err) {
    errorCount += 1;
    process.stdout.write(`\r[dump] okuma hatasi: ${err.message}   `);
    if (errorCount > 5) { console.error('\n[dump] cok fazla hata, duruluyor'); break; }
  }
  await new Promise((r) => setTimeout(r, intervalMs));
}

client.close();
console.log(`\n\n[dump] bitti - ${samples.length} ornek, ${outFile}\n`);

if (samples.length === 0) process.exit(1);

/* ---------- analiz 1: degisen register'lar ---------- */

const degisenler = [...seen.entries()]
  .filter(([, set]) => set.size > 1)
  .map(([i, set]) => {
    const degerler = [...set];
    return {
      adres: start + i,
      farkliDeger: set.size,
      min: Math.min(...degerler),
      max: Math.max(...degerler),
      son: samples.at(-1)[i],
    };
  })
  .sort((a, b) => b.farkliDeger - a.farkliDeger);

console.log(`=== DEGISEN REGISTER'LAR (${degisenler.length} adet) ===`);
if (degisenler.length === 0) {
  console.log('Hicbiri degismedi. Tezgah calisiyor muydu? Arastirilan aralik dogru mu?');
} else {
  console.log('adres      farkli  min         max         son');
  for (const d of degisenler.slice(0, 40)) {
    console.log(
      String(d.adres).padStart(6) + '  ' +
      String(d.farkliDeger).padStart(6) + '  ' +
      String(d.min).padStart(10) + '  ' +
      String(d.max).padStart(10) + '  ' +
      String(d.son).padStart(10)
    );
  }
  if (degisenler.length > 40) console.log(`... ve ${degisenler.length - 40} tane daha (dosyada)`);
}

/* ---------- analiz 2: bilinen degerleri ara ---------- */

if (known.length > 0) {
  console.log(`\n=== BILINEN DEGER ARAMASI: ${known.join(', ')} ===`);
  console.log('(tum ornekler taranir - yakalama sirasinda degisen degerler de bulunur)\n');

  for (const hedef of known) {
    /** adres -> kac orenekte gorulduyse */
    const onaltiBit = new Map();
    const otuzIkiBit = new Map();

    for (const values of samples) {
      values.forEach((v, i) => {
        if (v === hedef) onaltiBit.set(start + i, (onaltiBit.get(start + i) ?? 0) + 1);
      });
      for (let i = 0; i + 1 < values.length; i += 1) {
        if (combine32(values[i], values[i + 1]) === hedef) {
          const key = `${start + i}+${start + i + 1}`;
          otuzIkiBit.set(key, (otuzIkiBit.get(key) ?? 0) + 1);
        }
      }
    }

    const satirlar = [];
    for (const [adres, kez] of [...onaltiBit].sort((a, b) => b[1] - a[1])) {
      satirlar.push(`  16-bit  adres ${adres}  (${kez}/${samples.length} ornekte)`);
    }
    for (const [cift, kez] of [...otuzIkiBit].sort((a, b) => b[1] - a[1])) {
      const r = Math.floor(Number(cift.split('+')[0]) / 2);
      satirlar.push(`  32-bit  adres ${cift}  (R${r} olabilir, ${kez}/${samples.length} ornekte)`);
    }

    console.log(satirlar.length > 0 ? `${hedef}:\n${satirlar.join('\n')}` : `${hedef}: bulunamadi`);
  }
}

console.log(`\nHam veri: ${outFile}`);
