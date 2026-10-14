/**
 * Ürün tanıtım kartındaki İŞLEM İŞARETLERİ: YIKAMA, KURUTMA, TAVLAMA. Her işlem için iki kutu vardır: "gidecek" (kasa o işleme gidecek)
 * ve "yapıldı" (işlem zaten yapıldı). Kartı basarken usta tikler; işaretler kasa kaydıyla saklanır ve kartta basılır.
 *
 * Tek tanım: dashboard/planning-card.js aynı listeyi kullanır (`card-steps.test.js` ikisinin eşitliğini sınar).
 */
import { PlanningError } from './errors.js';

export const CARD_STEPS = Object.freeze([
  Object.freeze({ key: 'wash', label: 'YIKAMA', to: 'Yıkamaya gidecek', done: 'Yıkandı' }),
  Object.freeze({ key: 'dry', label: 'KURUTMA', to: 'Kurutmaya gidecek', done: 'Kurutuldu' }),
  Object.freeze({ key: 'anneal', label: 'TAVLAMA', to: 'Tavlamaya gidecek', done: 'Tavlandı' }),
]);

/** API/ekran anahtarı (`washTo`, `washDone` ...). */
export const STEP_KEYS = Object.freeze(CARD_STEPS.flatMap((s) => [`${s.key}To`, `${s.key}Done`]));

/** Veritabanı sütunu (`wash_to`, `wash_done` ...). */
export const CRATE_STEP_COLUMNS = Object.freeze(CARD_STEPS.flatMap((s) => [`${s.key}_to`, `${s.key}_done`]));

const columnOf = (apiKey) => apiKey.replace(/To$/, '_to').replace(/Done$/, '_done');

/**
 * İstekteki `steps` nesnesini doğrular. Yoksa `undefined` (işaretlere dokunulmaz); verilen anahtarlar boolean olmalı, bilinmeyen anahtar reddedilir.
 * Verilmeyen anahtarlar işaretsiz (false) sayılır.
 * @returns {Record<string, boolean>|undefined}
 */
export function parseSteps(input) {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'object' || Array.isArray(input)) throw new PlanningError('İşlem işaretleri (steps) bir nesne olmalı.', 400);
  const out = Object.fromEntries(STEP_KEYS.map((k) => [k, false]));
  for (const [k, v] of Object.entries(input)) {
    if (!STEP_KEYS.includes(k)) throw new PlanningError(`Bilinmeyen işlem işareti: ${String(k).slice(0, 30)}.`, 400);
    if (typeof v !== 'boolean') throw new PlanningError(`İşlem işareti "${k}" doğru/yanlış (true/false) olmalı.`, 400);
    out[k] = v;
  }
  return out;
}

/**
 * Kartın "ÜRÜN RET" kutusu: yoksa false; verilmişse boolean olmalı (aksi 400). Ret edilen kasa PAKETLEMEYE GİTMEZ (tekrar işleme ya da hurdaya ayrılır).
 * @returns {boolean}
 */
export function parseReject(input) {
  if (input === undefined || input === null) return false;
  if (typeof input !== 'boolean') throw new PlanningError('Ürün ret işareti (reject) doğru/yanlış (true/false) olmalı.', 400);
  return input;
}

/** `{washTo: true, ...}` -> `{wash_to: 1, ...}` (sütun adlarıyla). */
export const stepsToColumns = (steps) => Object.fromEntries(STEP_KEYS.map((k) => [columnOf(k), steps[k] ? 1 : 0]));

/** İşaretli kutuların okunur metni: "Yıkamaya gidecek · Kurutuldu" (hiçbiri işaretli değilse boş). */
export function stepsText(steps) {
  if (!steps) return '';
  return CARD_STEPS.flatMap((s) => [steps[`${s.key}To`] ? s.to : null, steps[`${s.key}Done`] ? s.done : null]).filter(Boolean).join(' · ');
}
