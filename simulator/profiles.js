import { loadInventory } from '../shared/inventory.js';

/**
 * Simulasyona ozgu parametreler (gercek envanterin parcasi degil - yalnizca
 * sahte veri uretmek icin). Envanter bilgisi config/machines.json'dan gelir.
 */
const SIM_PARAMS = {
  'CNC-01': {
    spindleTarget: 8000,
    feedTarget: 1200,
    cycleSec: [95, 150],
    alarmCodes: [
      ['SP1241', 'Spindle aşırı yük'],
      ['SV0401', 'Eksen servo alarmı'],
      ['OT0501', 'Yazılım limit aşımı'],
    ],
  },
  'CNC-02': {
    spindleTarget: 12000,
    feedTarget: 2000,
    cycleSec: [60, 110],
    alarmCodes: [
      ['700012', 'Soğutma sıvısı basıncı düşük'],
      ['025000', 'Mil sıcaklığı yüksek'],
      ['380500', 'Profibus haberleşme hatası'],
    ],
  },
  'CNC-03': {
    spindleTarget: 3500,
    feedTarget: 450,
    cycleSec: [140, 220],
    alarmCodes: [
      ['A-231', 'Torete konumlanma hatası'],
      ['A-118', 'Kapı kilidi açık'],
    ],
  },
  'CNC-04': {
    spindleTarget: 7500,
    feedTarget: 900,
    cycleSec: [80, 130],
    alarmCodes: [
      ['102', 'Servo hazır değil'],
      ['163', 'Düşük hava basıncı'],
    ],
  },
  'CNC-05': {
    spindleTarget: 1800,
    feedTarget: 200,
    cycleSec: [180, 320],
    alarmCodes: [],
  },
};

export const PROFILES = loadInventory().map((machine) => ({
  ...machine,
  ...SIM_PARAMS[machine.id],
}));
