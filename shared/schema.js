/**
 * CNC-TLM-001 Bolum 04 - normalize telemetri sozlesmesi.
 * Edge Agent hangi protokolu konusursa konussun (OPC-UA / MTConnect / FOCAS /
 * Modbus / donanim retrofit), backend'e bu sekilde gonderir. Ust katmanlar
 * makinenin markasini ya da yasini bilmez.
 */

export const MachineStatus = Object.freeze({
  RUNNING: 'RUNNING',
  IDLE: 'IDLE',
  ALARM: 'ALARM',
  OFF: 'OFF',
});

/** Edge Agent'in veriyi hangi yoldan okudugu (Bolum 05). */
export const DataSource = Object.freeze({
  OPCUA: 'opcua',
  MTCONNECT: 'mtconnect',
  FOCAS: 'focas',
  MODBUS: 'modbus',
  RETROFIT_IO: 'retrofit-io',
  SIMULATOR: 'simulator',
});

/**
 * Olcum alanlari. Hepsi opsiyonel: eski bir tezgah yalnizca `status` ve
 * `partCount` uretebilir, bu gecerli bir mesajdir. Okunamayan alan `null`
 * olarak gelir - "0" ile karistirilmamalidir.
 */
const MEASUREMENT_FIELDS = Object.freeze([
  'spindleRpm',
  'feedRate',
  'partCount',
  'cycleTimeSec',
]);

export const TELEMETRY_FIELDS = Object.freeze([
  ...MEASUREMENT_FIELDS,
  'program',
  'alarms',
  'downtimeReason',
]);

const STATUS_VALUES = new Set(Object.values(MachineStatus));
const SOURCE_VALUES = new Set(Object.values(DataSource));

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Ingest sinirindaki dogrulama. Gecerli bir mesaji normalize edip dondurur;
 * eksik olcum alanlarini acikca `null` yapar.
 * @returns {{ok: true, value: object} | {ok: false, errors: string[]}}
 */
export function parseTelemetry(input) {
  const errors = [];

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['mesaj bir nesne olmali'] };
  }

  const machineId = input.machineId;
  if (typeof machineId !== 'string' || machineId.trim() === '') {
    errors.push('machineId zorunlu (bos olmayan metin)');
  }

  const status = input.status;
  if (!STATUS_VALUES.has(status)) {
    errors.push(`status gecersiz: ${JSON.stringify(status)} (beklenen: ${[...STATUS_VALUES].join(' | ')})`);
  }

  const source = input.source ?? DataSource.SIMULATOR;
  if (!SOURCE_VALUES.has(source)) {
    errors.push(`source gecersiz: ${JSON.stringify(source)}`);
  }

  // ts yoksa varis zamani kullanilir; varsa gecerli bir tarih olmali.
  let ts;
  if (input.ts === undefined || input.ts === null) {
    ts = new Date().toISOString();
  } else {
    const parsed = new Date(input.ts);
    if (Number.isNaN(parsed.getTime())) {
      errors.push(`ts gecersiz tarih: ${JSON.stringify(input.ts)}`);
    } else {
      ts = parsed.toISOString();
    }
  }

  const measurements = {};
  for (const field of MEASUREMENT_FIELDS) {
    const raw = input[field];
    if (raw === undefined || raw === null) {
      measurements[field] = null;
    } else if (isFiniteNumber(raw)) {
      measurements[field] = raw;
    } else {
      errors.push(`${field} sayi ya da null olmali`);
    }
  }

  let alarms = [];
  if (input.alarms !== undefined && input.alarms !== null) {
    if (!Array.isArray(input.alarms)) {
      errors.push('alarms bir dizi olmali');
    } else {
      alarms = input.alarms.map((a) => ({
        code: String(a?.code ?? ''),
        text: String(a?.text ?? ''),
      }));
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      machineId,
      ts,
      source,
      seq: isFiniteNumber(input.seq) ? input.seq : null,
      status,
      ...measurements,
      program: input.program == null ? null : String(input.program),
      alarms,
      downtimeReason: input.downtimeReason == null ? null : String(input.downtimeReason),
    },
  };
}
