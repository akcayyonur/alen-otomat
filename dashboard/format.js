/**
 * Bicimlendirme ve alan tanimlari.
 *
 * Alan listesi TEK yerde durur ve arayuzun tamami bunu okur: detay panelleri,
 * tablo gorunumu, CSV basliklari hep ayni etiketleri kullanir. Kontrolcuden
 * yeni bir alan okunmaya baslandiginda yalnizca buraya eklenir.
 */

/** Durum gosterimi: renk YALNIZ basina anlam tasimaz, ikon + etiket zorunlu. */
export const STATES = Object.freeze({
  RUNNING: { label: 'Çalışıyor', icon: '▶', cls: 'run' },
  IDLE: { label: 'Boşta', icon: '❙❙', cls: 'idle' },
  ALARM: { label: 'Alarm', icon: '▲', cls: 'alarm' },
  OFF: { label: 'Kapalı', icon: '○', cls: 'off' },
  NO_DATA: { label: 'Veri yok', icon: '⌁', cls: 'nodata' },
});

export function stateOf(key) {
  return STATES[key] ?? { label: key ?? '—', icon: '·', cls: 'none' };
}

const nf0 = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 });

export function num(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return (digits > 0 ? nf1 : nf0).format(value);
}

export function pct(ratio, digits = 0) {
  if (ratio === null || ratio === undefined) return '—';
  return `${num(ratio * 100, digits)}%`;
}

/** Kisa sure: 42 sn / 7 dk 12 sn / 3 sa 05 dk */
export function dur(sec) {
  if (sec === null || sec === undefined || Number.isNaN(sec)) return '—';
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} sn`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} dk ${String(s % 60).padStart(2, '0')} sn`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} sa ${String(m % 60).padStart(2, '0')} dk`;
  return `${Math.floor(h / 24)} gün ${String(h % 24).padStart(2, '0')} sa`;
}

/** Uzun kumulatif sayaclar icin: 1.363.345 sn -> "378 sa" */
export function durLong(sec) {
  if (sec === null || sec === undefined) return '—';
  const h = sec / 3600;
  if (h < 48) return `${num(h, 1)} sa`;
  return `${num(h)} sa (${num(h / 24)} gün)`;
}

export function clock(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleTimeString('tr-TR', { hour12: false });
}

export function dateTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('tr-TR', { hour12: false });
}

/** "3 sn önce" - son veri ne kadar once geldi. */
export function ago(ms, now = Date.now()) {
  if (!ms) return 'hiç';
  const s = Math.round((now - ms) / 1000);
  if (s < 2) return 'şimdi';
  if (s < 60) return `${s} sn önce`;
  return `${dur(s)} önce`;
}

/**
 * Telemetri alanlari - gercek Syntec 11B kontrolcusunden okunan siraya gore
 * gruplanmis. `fmt` degeri metne cevirir, `unit` etiketin yanina yazilir.
 */
export const FIELD_GROUPS = Object.freeze([
  {
    title: 'Program',
    fields: [
      { key: 'program', label: 'Çalışan program', fmt: (v) => v || '—' },
      { key: 'mainProgram', label: 'Ana program', fmt: (v) => v || '—' },
      { key: 'mode', label: 'Mod', fmt: (v) => v || '—' },
      { key: 'blockNo', label: 'Satır no', fmt: (v) => num(v) },
      { key: 'block', label: 'İşlenen NC satırı', fmt: (v) => v || '—', mono: true, wide: true },
    ],
  },
  {
    title: 'İş mili ve ilerleme',
    fields: [
      { key: 'spindleRpm', label: 'Mil devri', unit: 'rpm', fmt: (v) => num(v) },
      { key: 'feedRate', label: 'İlerleme', unit: 'mm/dk', fmt: (v) => num(v) },
      { key: 'spindleOverridePct', label: 'Mil override', unit: '%', fmt: (v) => num(v) },
      { key: 'feedOverridePct', label: 'İlerleme override', unit: '%', fmt: (v) => num(v) },
    ],
  },
  {
    title: 'Parça',
    fields: [
      { key: 'partCount', label: 'Bu partide', fmt: (v) => num(v) },
      { key: 'partTarget', label: 'Hedef', fmt: (v) => num(v) },
      { key: 'partTotal', label: 'Ömür boyu toplam', fmt: (v) => num(v) },
    ],
  },
  {
    title: 'Süreler',
    fields: [
      // Kontrolcu bitmis cevrimin suresini degil, O ANKI cevrimde gecen kesme
      // suresini veriyor (gercek yakalamada 15->26->0 dongusu goruldu).
      { key: 'cycleTimeSec', label: 'Bu çevrimde', fmt: (v) => dur(v) },
      { key: 'cuttingTimeSec', label: 'Toplam kesme', fmt: (v) => durLong(v) },
      { key: 'workTimeSec', label: 'Toplam çalışma', fmt: (v) => durLong(v) },
      { key: 'powerOnTimeSec', label: 'Güç açık', fmt: (v) => durLong(v) },
    ],
  },
]);

/** Detay tablosunda ve CSV'de kullanilan duz alan listesi. */
export const ALL_FIELDS = Object.freeze(FIELD_GROUPS.flatMap((g) => g.fields));

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
