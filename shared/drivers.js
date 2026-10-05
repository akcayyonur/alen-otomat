import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Surucu kaydi (CNC-TLM-001 Bolum 05).
 *
 * Bir surucu, bir markanin protokolunu konusan Edge Agent'i tanimlar. Hangi
 * alanlarin okunabildigi makinenin degil SURUCUNUN ozelligidir - ayni Syntec
 * surucusu filodaki yedi tezgahin hepsi icin ayni alanlari verir.
 *
 * `status` alani urunun ne vaat ettigini belirler:
 *   supported    - ajan yazilmis ve gercek donanimda dogrulanmis
 *   experimental - ajan var, sahada dogrulanmadi
 *   planned      - ajan HENUZ YOK, ayarlar ekraninda secilemez
 */
const CONFIG_URL = new URL('../config/drivers.json', import.meta.url);

function stripNotes(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([key]) => !key.startsWith('_')));
}

let cache = null;

export function loadDrivers() {
  if (cache) return cache;
  const raw = readFileSync(fileURLToPath(CONFIG_URL), 'utf8');
  const { drivers } = JSON.parse(raw);
  cache = drivers.map((d) => ({
    ...stripNotes(d),
    reads: [...(d.reads ?? [])],
    requires: [...(d.requires ?? [])],
    /** Ayarlar ekraninda secilebilir mi - ajani olmayan surucu secilemez. */
    selectable: d.status === 'supported' || d.status === 'experimental',
  }));
  return cache;
}

export function getDriver(id) {
  return loadDrivers().find((d) => d.id === id) ?? null;
}

/** Bir tezgaha surucu atanmamissa ya da bilinmeyen bir id yazilmissa. */
export const FALLBACK_DRIVER = Object.freeze({
  id: 'unknown',
  label: 'Tanımsız sürücü',
  vendor: '—',
  status: 'planned',
  protocol: '—',
  transport: '—',
  defaultPort: null,
  agent: null,
  reads: [],
  requires: [],
  selectable: false,
  notes: 'Bu tezgaha geçerli bir sürücü atanmadı; veri gelmeyecek.',
});
