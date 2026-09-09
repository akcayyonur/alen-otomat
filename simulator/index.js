/**
 * Sahte Edge Agent (CNC-TLM-001 Bolum 09, adim 4).
 * Gercek Edge Agent ile ayni ingest sozlesmesini konusur; tek farki veriyi
 * tezgahtan degil VirtualMachine'den okumasi. Gercek agent yazildiginda
 * backend tarafinda hicbir sey degismez.
 */
import { PROFILES } from './profiles.js';
import { VirtualMachine } from './machine.js';

const INGEST_URL = process.env.INGEST_URL ?? 'http://127.0.0.1:3000/api/ingest';
const TICK_MS = Number(process.env.TICK_MS ?? 1000);
/** Baglanti koptugunda tutulacak azami mesaj (gercekte: yerel SQLite). */
const MAX_BUFFER = 5000;

const machines = PROFILES.map((p) => new VirtualMachine(p));
const buffer = [];
let online = null; // ilk denemede log basabilmek icin null

async function flush() {
  if (buffer.length === 0) return;
  const batch = buffer.splice(0, buffer.length);

  try {
    const res = await fetch(INGEST_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(batch),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    if (online !== true) {
      console.log(`[sim] backend'e baglandi -> ${INGEST_URL}`);
      online = true;
    }
  } catch (err) {
    // Veri kaybi yerine gecikmeli teslim: mesajlari basa geri koy.
    buffer.unshift(...batch);
    if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);

    if (online !== false) {
      console.warn(`[sim] backend'e ulasilamiyor (${err.message}) - veri yerelde tamponlaniyor`);
      online = false;
    }
  }
}

console.log(`[sim] ${machines.length} sanal tezgah, ${TICK_MS}ms araliklarla uretiliyor`);
for (const m of machines) {
  console.log(`[sim]   ${m.profile.id}  ${m.profile.vendor} ${m.profile.controller} (${m.profile.year}) via ${m.profile.source}`);
}

setInterval(() => {
  const dtSec = TICK_MS / 1000;
  for (const m of machines) buffer.push(m.tick(dtSec));
  void flush();
}, TICK_MS);
