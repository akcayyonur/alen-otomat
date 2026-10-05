import { loadInventory } from '../shared/inventory.js';

/**
 * Simulasyona ozgu parametreler - gercek envanterin parcasi degil, yalnizca
 * sahte veri uretmek icin. Filo tek tip oldugu icin tum tezgahlar ayni profili
 * kullanir; tek bir makine farkli davranacaksa PER_MACHINE'e eklenir.
 */
const LATHE_DEFAULTS = {
  // Govde etiketi: 7.5 kW, azami 6000 rpm. Gercek yakalamada devir 600-2000
  // arasinda gezdi (her operasyonun kendi devri var), ust sinir 2000 alindi.
  spindleTarget: 2000,
  feedTarget: 200,
  // Gercek tezgah 2 dakikada 5 parca yapti -> ~24 sn/parca.
  cycleSec: [20, 30],
  // Hedef tanimli degil (gercek tezgahta RequiredPart=0); PER_MACHINE ezer.
  partTarget: null,
  programPrefix: null,
  alarmCodes: [
    ['MOT-1023', 'Mil aşırı yük'],
    ['TUR-0311', 'Torete konumlanma hatası'],
    ['LUB-0140', 'Yağlama basıncı düşük'],
    ['DOR-0075', 'Koruma kapağı açık'],
  ],
};

/**
 * Tezgaha ozel sapmalar.
 *
 * Gercek tezgahta (192.168.88.99, 2026-09-18) `RequiredPart` hep 0 geldi -
 * yani hedef tanimli degil. Filonun cogunda oyle birakiyoruz ki gelistirme
 * uretimle ayni davransin; ikisinde hedef tanimli olsun ki arayuzun o yolu da
 * bos kalmasin.
 *
 * @type {Record<string, Partial<typeof LATHE_DEFAULTS> & {partTarget?: number, programPrefix?: string}>}
 */
const PER_MACHINE = {
  'CNC-01': { programPrefix: 'BERG' },
  'CNC-03': { partTarget: 500 },
  'CNC-06': { partTarget: 200 },
};

export const PROFILES = loadInventory().map((machine) => ({
  ...machine,
  ...LATHE_DEFAULTS,
  ...PER_MACHINE[machine.id],
}));
