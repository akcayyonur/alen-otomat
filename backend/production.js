/**
 * Uretim adedi izleyicisi: kontrolcunun parca sayaci her artisinda bir "uretim olayi" uretir.
 *
 * Neden olay: ornekler seyreltilir ve 7 gun sonra silinir; vardiya/urun raporlari aylarca
 * geriye bakar. Parca basina bir satir (tezgah basina ~25 sn'de bir) cok kucuktur ve 400 gun saklanir.
 *
 * Kurallar (hepsi test edilir, backend/production.test.js):
 *  - Adet, sayac farkidir: once `partTotal` (omur boyu), o kipirdamadiysa `partCount`. Fabrikada operator vardiya
 *    basinda "Parca"yi 0'a ceker (omur boyu sayac akar): sifirlamanin kendisi uretim DEGILDIR. Ama sayac geri gittiyse ve
 *    omur boyu sayac bunu sayamiyorsa (okunamadi / durdu), gorulen yeni deger "sifirlamadan beri yapilan parca" sayilir
 *    (sifirlamayla ayni saniyede biten parca, veri kopuklugunda yapilanlar). Taban her durumda yenilenir.
 *  - Program: parca, o sirada AKTIF olan (ana) programa yazilir. Ayni mesajda program degistiyse parca ESKI
 *    programindir (sayac parca bitince artar, program sonra secilir). Ortak alt program (O9001, ör. cubuk alma)
 *    okunamayan sayilir: ne parcaya ne de "Program gecisleri"ne ayri bir program olarak yazilir (`programOf`).
 *  - Makul olmayan sicrama (gecen surede uretilemeyecek kadar buyuk fark: operator sayaci elle ayarladi)
 *    `suspect` isaretlenir ve toplamlara KATILMAZ; sessizce yutulmaz, raporda ayrica sayilir.
 *  - Veri kopuklugundan sonra gelen adet gercektir (sayac tezgahta artti) ama ZAMANI kesin degildir:
 *    `gapMs` > 0 ile isaretlenir.
 *  - Cevrim suresi: kontrolcunun cevrim sayaci (CycleTime) parca artmadan once tepe noktasindadir, sonra
 *    sifirlanir. Tepe deger kaydedilir (`cycleSec`). Pencere eksik olabilirse (sunucu cevrimin ortasinda
 *    basladi, kopukluk, program degisti) ya da adet 1'den buyukse `null`: tahmin yazilmaz.
 */

/** Gecen surede en fazla bu kadar parca uretilebilir (saniyede 0,5 parca) - alt sinir 3. */
const MAX_PARTS_PER_SEC = 0.5;
const MIN_PLAUSIBLE = 3;

const isCounter = (v) => Number.isInteger(v) && v >= 0;

/**
 * Kok dizindeki ortak alt program (ör. cubuk alma rutini): her parcada kisaca devreye girer, gercek bir parca
 * programi degildir. Kontrolcu bu sirada MainProg'u da O9001 (ya da bos) gosterebilir; ikisinde de okunamayan
 * sayilir ("ortak alt program gecici gecisi aralik/parca atfini bolmez" - ana programin devamidir).
 */
const COMMON_SUBPROGRAM = 'O9001';

/** Parcanin atfedilecegi program: ana program, yoksa calisan program. Ortak alt program (O9001) okunamayan sayilir. */
export function programOf(msg) {
  const raw = msg.mainProgram ?? msg.program ?? null;
  const text = raw == null ? '' : String(raw).trim();
  return text === '' || text.toUpperCase() === COMMON_SUBPROGRAM ? null : text;
}

/**
 * @typedef {object} ProductionEvent
 * @property {string} machineId
 * @property {number} ts           olay zamani (epoch ms; mesajin `ts`'i)
 * @property {string|null} program
 * @property {number} qty          bu olaydaki adet (cogunlukla 1)
 * @property {number|null} partTotal
 * @property {number|null} partCount
 * @property {string|null} status
 * @property {number|null} cycleSec
 * @property {number} gapMs        olaydan once veri kopuklugu (ms); 0 = kesintisiz
 * @property {boolean} suspect
 */

export class PartTracker {
  /**
   * @param {{seed?: (machineId: string, ts: number) => ({ts: number, total: number|null, count: number|null, program: string|null}|null), gapMs?: number}} [opts]
   *   seed: sunucu yeniden basladiktan sonra tezgahin ILK mesajinda taban olarak kullanilacak son kayitli durum
   */
  constructor({ seed = () => null, gapMs = 10_000 } = {}) {
    this.seed = seed;
    this.gapMs = gapMs;
    /** @type {Map<string, object>} */
    this.state = new Map();
  }

  #fresh(seed, ts) {
    const usable = seed && Number.isFinite(seed.ts) && seed.ts <= ts ? seed : null;
    return {
      ts: usable?.ts ?? null,
      total: isCounter(usable?.total) ? usable.total : null,
      count: isCounter(usable?.count) ? usable.count : null,
      program: usable?.program ?? null,
      // Cevrim penceresi: son olaydan beri gorulen en yuksek cevrim suresi.
      peak: 0,
      // Olay aninda cevrim sayaci henuz sifirlanmadiysa, sifirlanana kadar gelen degerler sonraki parcaya ait degildir.
      skipAbove: null,
      cycleValid: false,
    };
  }

  /**
   * @param {object} msg normalize telemetri mesaji
   * @returns {ProductionEvent|null} sayac arttiysa olay
   */
  observe(msg) {
    const ts = Date.parse(msg.ts);
    if (!Number.isFinite(ts)) return null;

    let st = this.state.get(msg.machineId);
    if (!st) {
      st = this.#fresh(this.seed(msg.machineId, ts), ts);
      this.state.set(msg.machineId, st);
    }
    if (st.ts != null && ts < st.ts) return null; // sirasi bozuk (eski) mesaj: tabani bozma

    const program = programOf(msg);
    const elapsedMs = st.ts == null ? null : ts - st.ts;
    const gap = elapsedMs != null && elapsedMs > this.gapMs;

    // Cevrim penceresi: kopukluk ya da program degisimi pencereyi eksik birakir.
    if (gap || (st.program != null && program != null && st.program !== program)) {
      st.cycleValid = false;
      st.peak = 0;
      st.skipAbove = null;
    }
    const cycle = Number.isFinite(msg.cycleTimeSec) ? msg.cycleTimeSec : null;
    if (cycle != null) {
      if (st.skipAbove != null && cycle < st.skipAbove) st.skipAbove = null;
      if (st.skipAbove == null && cycle > st.peak) st.peak = cycle;
    }

    // Adet: omur boyu sayac; o hareket etmediyse parti sayaci.
    const dTotal = isCounter(msg.partTotal) && st.total != null ? msg.partTotal - st.total : null;
    const dCount = isCounter(msg.partCount) && st.count != null ? msg.partCount - st.count : null;
    let qty = dTotal != null && dTotal > 0 ? dTotal : dCount != null && dCount > 0 ? dCount : 0;
    if (qty === 0) {
      // Sayac GERI gitti: operator vardiya basinda sifirladi (fabrikada "Parca" 0'a cekilir). Sifirdan basladigi icin
      // gorulen deger, sifirlamadan beri yapilan parcadir (sifirlamayla ayni saniyede biten parca ya da veri kopuklugunda
      // yapilanlar). Omur boyu sayac akiyorsa zaten yukaridaki fark hepsini sayar; bu yalniz o okunamazsa/durmussa devreye girer.
      if (dTotal != null && dTotal < 0) qty = msg.partTotal;
      else if (!(dTotal > 0) && dCount != null && dCount < 0) qty = msg.partCount;
    }

    /** @type {ProductionEvent|null} */
    let event = null;
    if (qty > 0 && st.ts != null) {
      const limit = Math.max(MIN_PLAUSIBLE, Math.ceil(((elapsedMs ?? 0) / 1000) * MAX_PARTS_PER_SEC));
      const cycleSec = qty === 1 && st.cycleValid && !gap && st.peak > 0 ? st.peak : null;
      event = {
        machineId: msg.machineId,
        ts,
        program: st.program ?? program,
        qty,
        partTotal: isCounter(msg.partTotal) ? msg.partTotal : null,
        partCount: isCounter(msg.partCount) ? msg.partCount : null,
        status: msg.status ?? null,
        cycleSec,
        gapMs: gap ? elapsedMs : 0,
        suspect: qty > limit,
      };
      // Yeni pencere: bu olaydan sonrasi bir sonraki parcaya aittir. Supheli olay (sayac elle oynanmis) gercek bir
      // parca bitisi degildir: pencere gecerli SAYILMAZ, sonraki parcanin cevrim suresi tahmin edilmez.
      st.peak = 0;
      st.cycleValid = !event.suspect;
      st.skipAbove = !event.suspect && cycle != null && cycle > 2 ? cycle : null;
    }

    // Taban her mesajda ilerler (sayac geri gittiyse yeni deger taban olur; okunamayan alan tabani silmez).
    st.ts = ts;
    if (isCounter(msg.partTotal)) st.total = msg.partTotal;
    if (isCounter(msg.partCount)) st.count = msg.partCount;
    if (program != null) st.program = program;
    return event;
  }
}
