/**
 * CNC-TLM-001 Bolum 04 - normalize telemetri sozlesmesi.
 *
 * Edge Agent hangi protokolu konusursa konussun (OPC-UA / MTConnect / FOCAS /
 * Modbus / Syntec RemoteAPI / donanim retrofit), backend'e bu sekilde gonderir.
 * Ust katmanlar makinenin markasini ya da yasini bilmez.
 *
 * Alan secimi 2026-09-18'de gercek Syntec 11B kontrolcusunden okunan verilere
 * gore yapildi (bkz. SYNTEC-REMOTEAPI.md "Veri modeli eslemesi"). Her alan
 * marka-notr: FOCAS ve MTConnect'te de dogrudan karsiligi var.
 */

/**
 * Edge Agent'in bildirebilecegi durumlar. NO_DATA burada YOK - onu ajan
 * bildirmez, sunucu ornek gelmedigi icin kendisi tureter (bkz. TimelineState).
 */
export const MachineStatus = Object.freeze({
  RUNNING: 'RUNNING',
  IDLE: 'IDLE',
  ALARM: 'ALARM',
  OFF: 'OFF',
});

/**
 * Zaman serisi ve raporlarda kullanilan durum kumesi. MachineStatus'a ek olarak
 * NO_DATA tasir: "ornek gelmedi" ile "tezgah kapali" ayri seylerdir ve
 * karistirilirsa durus raporu yanlis cikar. NO_DATA'yi her zaman sunucu uretir.
 */
export const TimelineState = Object.freeze({
  ...MachineStatus,
  NO_DATA: 'NO_DATA',
});

/** Edge Agent'in veriyi hangi yoldan okudugu (Bolum 05). */
export const DataSource = Object.freeze({
  OPCUA: 'opcua',
  MTCONNECT: 'mtconnect',
  FOCAS: 'focas',
  MODBUS: 'modbus',
  SYNTEC_REMOTEAPI: 'syntec-remoteapi',
  RETROFIT_IO: 'retrofit-io',
  SIMULATOR: 'simulator',
});

/**
 * Sayisal olcumler. Hepsi opsiyonel: eski bir tezgah yalnizca `status` ve
 * `partCount` uretebilir, bu gecerli bir mesajdir. Okunamayan alan `null`
 * olarak gelir - "0" ile karistirilmamalidir.
 *
 * Syntec karsiliklari (RemoteAPI fonksiyonu -> donen alan):
 *   spindleRpm          READ_spindle    ActSpindle
 *   feedRate            READ_spindle    ActFeed
 *   spindleOverridePct  READ_spindle    OvSpindle
 *   feedOverridePct     READ_spindle    OvFeed
 *   partCount           READ_part_count part
 *   partTarget          READ_part_count required  (0 = hedef tanimli degil ->
 *                                       ajan null gonderir)
 *   partTotal           READ_part_count total
 *   cycleTimeSec        READ_time       CuttingTimePerCycle  (O ANKI cevrimde
 *                                       gecen kesme suresi; bitmis cevrimin
 *                                       suresi DEGIL - her saniye artar ve
 *                                       parca bitince sifirlanir)
 *   cuttingTimeSec      READ_time       AccumulateCuttingTime
 *   powerOnTimeSec      READ_time       PowerOnTime
 *   workTimeSec         READ_time       WorkTime
 *   blockNo             READ_status     CurSeq
 */
const NUMERIC_FIELDS = Object.freeze([
  'spindleRpm',
  'feedRate',
  'spindleOverridePct',
  'feedOverridePct',
  'partCount',
  'partTarget',
  'partTotal',
  'cycleTimeSec',
  'cuttingTimeSec',
  'powerOnTimeSec',
  'workTimeSec',
  'blockNo',
]);

/**
 * Metin alanlari.
 *   program       calisan parca programi (CurProg, yoksa MainProg)
 *   mainProgram   ana program (MainProg) - alt program cagrildiginda ayrisir
 *   mode          tezgah modu (AUTO / MDI / JOG / HOME ...)
 *   block         o an islenen NC satiri (READ_nc_current_block)
 */
const TEXT_FIELDS = Object.freeze(['program', 'mainProgram', 'mode', 'block']);

/** Dashboard'da "hangi alanlar okunabiliyor" rozetleri icin tam liste. */
export const TELEMETRY_FIELDS = Object.freeze([
  ...NUMERIC_FIELDS,
  ...TEXT_FIELDS,
  'alarms',
  'downtimeReason',
]);

/**
 * Kontrolcuye ozgu, normalize edilemeyen ham degerler. Sozlesmeyi marka-notr
 * tutmak icin ayri bir ad alaninda durur; ust katmanlar bunlari yorumlamaz,
 * yalnizca gosterir.
 *
 * Asil isi: ham `Status` degerini ofise kadar tasimak. Durum eslemesi
 * (DurumEsle) RUNNING icin HENUZ DOGRULANMADI - tezgah kesme yaparken donen
 * gercek metni dashboard'dan gorup eslemeyi makineye gitmeden kapatabilmek
 * icin ham deger yaninda saklanir.
 */
const CONTROLLER_MAX_KEYS = 40;
const CONTROLLER_MAX_VALUE_LEN = 200;

const STATUS_VALUES = new Set(Object.values(MachineStatus));
const SOURCE_VALUES = new Set(Object.values(DataSource));

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Ham degerleri metne cevirir; hatali bir ajan bellegi sismesin diye sinirli. */
function parseController(raw, errors) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('controller bir nesne olmali');
    return {};
  }

  const out = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (count >= CONTROLLER_MAX_KEYS) break;
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') continue; // ic ice yapi tasimayiz
    out[key] = String(value).slice(0, CONTROLLER_MAX_VALUE_LEN);
    count += 1;
  }
  return out;
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
    const beklenen = [...STATUS_VALUES].join(' | ');
    errors.push(
      status === TimelineState.NO_DATA
        ? 'status NO_DATA olamaz - bu durumu sunucu kendisi uretir'
        : `status gecersiz: ${JSON.stringify(status)} (beklenen: ${beklenen})`,
    );
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

  const numeric = {};
  for (const field of NUMERIC_FIELDS) {
    const raw = input[field];
    if (raw === undefined || raw === null) {
      numeric[field] = null;
    } else if (isFiniteNumber(raw)) {
      numeric[field] = raw;
    } else {
      errors.push(`${field} sayi ya da null olmali`);
    }
  }

  const text = {};
  for (const field of TEXT_FIELDS) {
    const raw = input[field];
    text[field] = raw == null ? null : String(raw);
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

  const controller = parseController(input.controller, errors);

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      machineId,
      ts,
      source,
      seq: isFiniteNumber(input.seq) ? input.seq : null,
      status,
      ...numeric,
      ...text,
      alarms,
      downtimeReason: input.downtimeReason == null ? null : String(input.downtimeReason),
      controller,
    },
  };
}
