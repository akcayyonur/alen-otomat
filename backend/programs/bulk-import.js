/**
 * Toplu iceri alma (bir tornadaki TUM programlari kutuphaneye alma) icin yardimcilar.
 *
 * Akis iki asamali (tornaya YALNIZ OKUMA yapilir, hicbir sey yazilmaz):
 *   1. PLAN: torna taranir, her dosya indirilir, kutuphaneye gore siniflanir (yeni / ayni / cakisma / alinamaz).
 *      Indirilen icerikler burada, bellekte, sinirli sure (TTL) tutulur.
 *   2. UYGULA: kullanicinin sectigi kararlara gore kutuphaneye yazilir. Icerik plandan gelir: kullanicinin
 *      farki gorerek karar verdigi baytlar AYNEN alinir ve tornaya ikinci kez baglanilmaz.
 */
import { randomBytes } from 'node:crypto';

/** Plan icerikleri bellekte bu kadar sure kalir; sonra yeniden plan gerekir. */
export const PLAN_TTL_MS = 30 * 60_000;
/** Ayni anda bellekte tutulan plan sayisi (en eskisi atilir). */
const MAX_PLANS = 6;
/** Bir planin indirdigi toplam bayt ust siniri (bellek korumasi). */
export const MAX_PLAN_BYTES = 100_000_000;
/** Bir plan bu sureyi asarsa durdurulur (klasor secerek bolunebilir). */
export const MAX_PLAN_MS = 15 * 60_000;

export const planKey = (customer, name) => `${customer}\\${name}`;

/**
 * Cakisan dosya icin "hangisi daha yeni" ipucu. Tezgah tarihi (FTP LIST, yerel saat, "YYYY-MM-DD HH:MM")
 * ile kutuphanedeki EN SON surumun eklenme tarihi karsilastirilir. YALNIZ ipucu: tezgah saati yanlis olabilir,
 * kutuphaneden gonderilen dosyanin tezgah tarihi gonderme anidir.
 * @returns {'tezgah-yeni'|'kutuphane-yeni'|'ayni-gun'|null}
 */
export function modifiedHint(modified, libraryCreatedAt) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(String(modified ?? ''));
  if (!m || !Number.isFinite(libraryCreatedAt)) return null;
  const lathe = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  if (!Number.isFinite(lathe) || Number(m[1]) < 2000) return null;
  const DAY = 86_400_000;
  if (Math.abs(lathe - libraryCreatedAt) < DAY) return 'ayni-gun';
  return lathe > libraryCreatedAt ? 'tezgah-yeni' : 'kutuphane-yeni';
}

/**
 * Bellek ici plan deposu. Bir plan: {id, machineId, createdAt, status, progress, result, error, contents}.
 * `contents` (anahtar -> Buffer) HICBIR ZAMAN disari verilmez (publicPlan).
 */
export class ImportPlans {
  constructor({ now = Date.now, ttlMs = PLAN_TTL_MS } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    /** @type {Map<string, object>} */
    this.plans = new Map();
  }

  create(machineId) {
    this.purge();
    // Ayni tezgahin onceki planlarini at (yenisi gecerli): bellek ve karisiklik azalir.
    for (const [id, p] of this.plans) if (p.machineId === machineId && p.status !== 'calisiyor') this.plans.delete(id);
    while (this.plans.size >= MAX_PLANS) this.plans.delete(this.plans.keys().next().value);
    const plan = {
      id: randomBytes(9).toString('base64url'),
      machineId,
      createdAt: this.now(),
      status: 'calisiyor',
      progress: { phase: 'baslangic', folder: null, done: 0, total: 0 },
      result: null,
      error: null,
      contents: new Map(),
      bytes: 0,
      applied: false,
    };
    this.plans.set(plan.id, plan);
    return plan;
  }

  /** @returns {object|null} suresi dolmus ya da baska tezgahin plani null */
  get(id, machineId) {
    this.purge();
    const p = this.plans.get(String(id));
    return p && p.machineId === machineId ? p : null;
  }

  purge() {
    const cut = this.now() - this.ttlMs;
    for (const [id, p] of this.plans) if (p.status !== 'calisiyor' && p.createdAt < cut) this.plans.delete(id);
  }
}

/** Planin istemciye giden hali: icerik baytlari yok. */
export function publicPlan(plan) {
  return {
    planId: plan.id,
    machineId: plan.machineId,
    status: plan.status,
    createdAt: plan.createdAt,
    progress: plan.progress,
    error: plan.error,
    applied: plan.applied,
    ...(plan.status === 'bitti' ? { plan: plan.result } : {}),
  };
}
