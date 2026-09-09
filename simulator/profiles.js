import { loadInventory } from '../shared/inventory.js';

/**
 * Simulasyona ozgu parametreler - gercek envanterin parcasi degil, yalnizca
 * sahte veri uretmek icin. Filo tek tip oldugu icin tum tezgahlar ayni profili
 * kullanir; tek bir makine farkli davranacaksa PER_MACHINE'e eklenir.
 */
const LATHE_DEFAULTS = {
  // Govde etiketi: 7.5 kW, azami 6000 rpm. Tornalamada tipik calisma devri
  // azaminin yarisi civarindadir.
  spindleTarget: 3000,
  feedTarget: 320,
  cycleSec: [120, 240],
  alarmCodes: [
    ['MOT-1023', 'Mil aşırı yük'],
    ['TUR-0311', 'Torete konumlanma hatası'],
    ['LUB-0140', 'Yağlama basıncı düşük'],
    ['DOR-0075', 'Koruma kapağı açık'],
  ],
};

/** @type {Record<string, Partial<typeof LATHE_DEFAULTS>>} */
const PER_MACHINE = {};

export const PROFILES = loadInventory().map((machine) => ({
  ...machine,
  ...LATHE_DEFAULTS,
  ...PER_MACHINE[machine.id],
}));
