/**
 * ÖLÇÜM CİHAZLARI TAKİP (EYS.LS.006 "Ölçüm Cihazları Takip Listesi"): kalite biriminin ve üretimin kullandığı
 * mastar/kumpas/mihengir/görüş sistemi vb. ÖLÇÜM EKİPMANININ envanteri ve kalibrasyon zamanlaması.
 *
 * Tezgah başındaki "Ölçü kontrolü"nün (`measure.js` `DEVICES`: Kumpas/Mastar/Kameralı Görüntüleme/Mihengir — hangi
 * cihazla ölçüldüğü, ölçü PLANINDA bir alan) ile KARIŞTIRILMASIN: o, bir ürün karakteristiğinin ölçüldüğü cihaz
 * TÜRÜNÜ seçen dar bir alan; bu modül ise fiziksel cihazların KENDİ ENVANTER KAYDI (Takip No, seri no, kalibrasyon
 * tarihi...) — BİLİNÇLİ OLARAK birbirine bağlanmadı (Numune Takip/Fiyat çalışması'nın `products`'a bağlanmaması
 * ile aynı ilke): kategori burada SERBEST METİN (kullanıcı "yeniler de satın alınıyor" dedi — yeni cihaz türleri
 * sisteme KISITLANMADAN eklenebilmeli).
 *
 * **Kalibrasyon durumu (yeşil/sarı/kırmızı) gerçek EYS.LS.006 Excel'indeki KOŞULLU BİÇİMLENDİRME kurallarıyla
 * BİREBİR aynı** (salt okuma ile çözülüp doğrulandı, 2026-11-05): "Gelecek Kalib.Tarihi" sütunundaki üç kural —
 *   yeşil:  N >= bugünden 2 ay sonraki ayın 1'i   (güvenli)
 *   sarı:   bugünden 1 ay sonraki ayın 1'i <= N < 2 ay sonraki ayın 1'i   (kalibrasyon vaktine 1 ay var)
 *   kırmızı: N < bugünden 1 ay sonraki ayın 1'i   (kalibrasyon zamanı gelmiş/geçmiş)
 * Tarih hiç girilmemişse (boş) ayrı bir "bilinmiyor" durumu — Excel'de boş hücre hiç renklenmiyordu, biz bunu
 * sessizce atlamak yerine ayrı bir ikon+etiketle gösteriyoruz (CLAUDE.md §7: renk tek başına anlam taşımaz).
 * Kayıt "pasif" (kullanım dışı/hurdaya ayrılmış) ise kalibrasyon alarmı BASTIRILIR (emekliye ayrılmış bir cihazın
 * süresi geçmiş gibi görünmesin).
 */
import { PlanningError } from './errors.js';
import { findHeaderByKeys, foldTr } from './normalize.js';
import { text, number, day } from './fields.js';
import { XlsxError, readXlsx } from './xlsx-read.js';

export const USABLE = Object.freeze(['kullanilabilir', 'kullanilamaz']);
export const ACTIVE = Object.freeze(['aktif', 'pasif']);
/** Liste/detaydaki hesaplanan alan (`calibration`): tabloda saklanmaz. */
export const CAL_STATUS = Object.freeze(['yesil', 'sari', 'kirmizi', 'bilinmiyor', 'pasif']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS measuring_devices (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  category             TEXT    NOT NULL,
  tracking_no          TEXT,
  name                 TEXT    NOT NULL,
  gauge_type           TEXT,
  interim_check        TEXT,
  serial_no            TEXT,
  model_brand          TEXT,
  measure_range        TEXT,
  resolution_mm        REAL,
  deviation_note       TEXT,
  usable               TEXT    NOT NULL DEFAULT 'kullanilabilir',
  last_calibrated_on   INTEGER,
  calibration_company  TEXT,
  next_calibration_on  INTEGER,
  department           TEXT,
  held_by              TEXT,
  delivered_on         INTEGER,
  active               TEXT    NOT NULL DEFAULT 'aktif',
  issue_note           TEXT,
  note                 TEXT,
  search_key           TEXT    NOT NULL,
  created_at           INTEGER NOT NULL,
  created_by           TEXT,
  updated_at           INTEGER NOT NULL,
  updated_by           TEXT
);
CREATE INDEX IF NOT EXISTS idx_devices_active ON measuring_devices (active, id DESC);
CREATE INDEX IF NOT EXISTS idx_devices_search ON measuring_devices (search_key);
`;

/**
 * Kalibrasyon durumu: EYS.LS.006'daki üç koşullu-biçimlendirme kuralıyla BİREBİR (ay sınırı bazlı, gün sayısı
 * DEĞİL — gerçek Excel'den okunan formüllerle doğrulandı). `active==='pasif'` çağıran tarafından ayrıca ele alınır.
 * @param {number|null} nextCalibrationOn @param {number} [now]
 */
export function calibrationStatus(nextCalibrationOn, now = Date.now()) {
  if (nextCalibrationOn == null) return 'bilinmiyor';
  const n = new Date(now);
  const nextMonthStart = new Date(n.getFullYear(), n.getMonth() + 1, 1).getTime();
  const monthAfterStart = new Date(n.getFullYear(), n.getMonth() + 2, 1).getTime();
  if (nextCalibrationOn < nextMonthStart) return 'kirmizi';
  if (nextCalibrationOn < monthAfterStart) return 'sari';
  return 'yesil';
}

const row = (r) => (r == null ? null : {
  id: Number(r.id), category: r.category, trackingNo: r.tracking_no, name: r.name, gaugeType: r.gauge_type,
  interimCheck: r.interim_check, serialNo: r.serial_no, modelBrand: r.model_brand, measureRange: r.measure_range,
  resolutionMm: r.resolution_mm == null ? null : Number(r.resolution_mm), deviationNote: r.deviation_note,
  usable: r.usable, lastCalibratedOn: r.last_calibrated_on == null ? null : Number(r.last_calibrated_on),
  calibrationCompany: r.calibration_company, nextCalibrationOn: r.next_calibration_on == null ? null : Number(r.next_calibration_on),
  department: r.department, heldBy: r.held_by, deliveredOn: r.delivered_on == null ? null : Number(r.delivered_on),
  active: r.active, issueNote: r.issue_note, note: r.note,
  createdAt: Number(r.created_at), createdBy: r.created_by, updatedAt: Number(r.updated_at), updatedBy: r.updated_by,
});

/** EYS.LS.006 sayfasında başlık satırını bulur (form başlığı + lejant başlığın ÜSTÜNDE, ilk ~12 satırda aranır). */
function findDeviceHeader(rows) {
  return findHeaderByKeys(rows, ['TAKIPNO', 'CIHAZTANIMI', 'GELECEKKALIBTARIHI']);
}

export class MeasuringDevices {
  /** @param {{planning: import('./planning.js').Planning}} deps */
  constructor({ planning }) {
    this.planning = planning;
    this.db = planning.db.db; // ayni sqlite baglantisi
    this.db.exec(SCHEMA);
  }

  #searchKey(f) {
    return foldTr([f.category, f.trackingNo, f.name, f.serialNo, f.modelBrand].filter(Boolean).join(' '));
  }

  #fields(input, { partial = false } = {}) {
    const out = {};
    const has = (k) => Object.hasOwn(input, k);
    if (!partial || has('category')) {
      const v = text(input.category, 'Cihaz kategorisi', 80);
      if (!v) throw new PlanningError('Cihaz kategorisi gerekli.');
      out.category = v;
    }
    if (!partial || has('name')) {
      const v = text(input.name, 'Cihaz tanımı', 200);
      if (!v) throw new PlanningError('Cihaz tanımı gerekli.');
      out.name = v;
    }
    if (has('trackingNo')) out.trackingNo = text(input.trackingNo, 'Takip no', 60);
    if (has('gaugeType')) out.gaugeType = text(input.gaugeType, 'Mastar özelliği', 40);
    if (has('interimCheck')) out.interimCheck = text(input.interimCheck, 'Ara kontrol', 40);
    if (has('serialNo')) out.serialNo = text(input.serialNo, 'Seri no', 80);
    if (has('modelBrand')) out.modelBrand = text(input.modelBrand, 'Model-marka', 80);
    if (has('measureRange')) out.measureRange = text(input.measureRange, 'Ölçüm aralığı', 80);
    if (has('resolutionMm')) out.resolutionMm = number(input.resolutionMm, 'Çözünürlük (mm)', { max: 1000 });
    if (has('deviationNote')) out.deviationNote = text(input.deviationNote, 'Sapma durumu', 300);
    if (has('usable')) {
      const v = String(input.usable ?? '').trim();
      if (v !== '' && !USABLE.includes(v)) throw new PlanningError('Cihaz durumu "kullanilabilir" ya da "kullanilamaz" olmalı.');
      out.usable = v || 'kullanilabilir';
    }
    if (has('lastCalibratedOn')) out.lastCalibratedOn = day(input.lastCalibratedOn, 'Kalibrasyon tarihi');
    if (has('calibrationCompany')) out.calibrationCompany = text(input.calibrationCompany, 'Kalibrasyon firması', 120);
    if (has('nextCalibrationOn')) out.nextCalibrationOn = day(input.nextCalibrationOn, 'Gelecek kalibrasyon tarihi');
    if (has('department')) out.department = text(input.department, 'Bölüm-alt bölüm', 120);
    if (has('heldBy')) out.heldBy = text(input.heldBy, 'Teslim alan', 120);
    if (has('deliveredOn')) out.deliveredOn = day(input.deliveredOn, 'Teslim tarihi');
    if (has('active')) {
      const v = String(input.active ?? '').trim();
      if (v !== '' && !ACTIVE.includes(v)) throw new PlanningError('Kayıt durumu "aktif" ya da "pasif" olmalı.');
      out.active = v || 'aktif';
    }
    if (has('issueNote')) out.issueNote = text(input.issueNote, 'Hata bilgisi', 500);
    if (has('note')) out.note = text(input.note, 'Not', 500);
    return out;
  }

  #withStatus(r, now) {
    if (!r) return r;
    return { ...r, calibration: r.active === 'pasif' ? 'pasif' : calibrationStatus(r.nextCalibrationOn, now) };
  }

  /** @param {{q?: string, active?: string, usable?: string, calibration?: string, limit?: number, offset?: number, now?: number}} [f] */
  list({ q = '', active = '', usable = '', calibration = '', limit = 200, offset = 0, now = Date.now() } = {}) {
    const conds = [];
    const args = [];
    if (q.trim() !== '') { conds.push("search_key LIKE ? ESCAPE '\\'"); args.push(`%${foldTr(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`); }
    if (ACTIVE.includes(active)) { conds.push('active = ?'); args.push(active); }
    if (USABLE.includes(usable)) { conds.push('usable = ?'); args.push(usable); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const all = this.db.prepare(`SELECT * FROM measuring_devices ${where} ORDER BY category, name`).all(...args).map(row).map((r) => this.#withStatus(r, now));
    const filtered = CAL_STATUS.includes(calibration) ? all.filter((r) => r.calibration === calibration) : all;
    return { total: filtered.length, items: filtered.slice(offset, offset + limit) };
  }

  get(id, { now = Date.now() } = {}) {
    const r = this.db.prepare('SELECT * FROM measuring_devices WHERE id = ?').get(Number(id));
    if (!r) throw new PlanningError('Ölçüm cihazı bulunamadı.', 404);
    return this.#withStatus(row(r), now);
  }

  /** Yeni ölçüm cihazı ekle. Yalnız kategori ve cihaz tanımı zorunlu; kalan EYS.LS.006 alanları zamanla doldurulur. */
  create(input = {}, { by = null, now = Date.now() } = {}) {
    const f = this.#fields(input);
    const usable = f.usable ?? 'kullanilabilir';
    const active = f.active ?? 'aktif';
    const id = Number(this.db.prepare(
      `INSERT INTO measuring_devices (category, tracking_no, name, gauge_type, interim_check, serial_no, model_brand, measure_range,
        resolution_mm, deviation_note, usable, last_calibrated_on, calibration_company, next_calibration_on, department, held_by,
        delivered_on, active, issue_note, note, search_key, created_at, created_by, updated_at, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      f.category, f.trackingNo ?? null, f.name, f.gaugeType ?? null, f.interimCheck ?? null, f.serialNo ?? null, f.modelBrand ?? null,
      f.measureRange ?? null, f.resolutionMm ?? null, f.deviationNote ?? null, usable, f.lastCalibratedOn ?? null,
      f.calibrationCompany ?? null, f.nextCalibrationOn ?? null, f.department ?? null, f.heldBy ?? null, f.deliveredOn ?? null,
      active, f.issueNote ?? null, f.note ?? null, this.#searchKey({ ...f, usable, active }), now, by, now, by,
    ).lastInsertRowid);
    return this.get(id, { now });
  }

  /** Alanları düzenler (yalnız gönderilen alanlar değişir; kayıt oluşturulduktan sonra kategori/tanım dahil her şey düzeltilebilir). */
  update(id, input = {}, { by = null, now = Date.now() } = {}) {
    const cur = this.get(id);
    const f = this.#fields(input, { partial: true });
    if (Object.keys(f).length === 0) return cur;
    const next = { ...cur, ...f };
    const cols = [];
    const args = [];
    const map = {
      category: 'category', trackingNo: 'tracking_no', name: 'name', gaugeType: 'gauge_type', interimCheck: 'interim_check',
      serialNo: 'serial_no', modelBrand: 'model_brand', measureRange: 'measure_range', resolutionMm: 'resolution_mm',
      deviationNote: 'deviation_note', usable: 'usable', lastCalibratedOn: 'last_calibrated_on', calibrationCompany: 'calibration_company',
      nextCalibrationOn: 'next_calibration_on', department: 'department', heldBy: 'held_by', deliveredOn: 'delivered_on',
      active: 'active', issueNote: 'issue_note', note: 'note',
    };
    for (const [k, col] of Object.entries(map)) { if (Object.hasOwn(f, k)) { cols.push(`${col} = ?`); args.push(f[k] ?? null); } }
    cols.push('search_key = ?'); args.push(this.#searchKey(next));
    cols.push('updated_at = ?', 'updated_by = ?'); args.push(now, by);
    this.db.prepare(`UPDATE measuring_devices SET ${cols.join(', ')} WHERE id = ?`).run(...args, Number(id));
    return this.get(id);
  }

  /** Yanlış açılmış kaydı sil. Yalnız yönetici (kayıtsız uç → admin). */
  delete(id) {
    this.get(id);
    this.db.prepare('DELETE FROM measuring_devices WHERE id = ?').run(Number(id));
    return { ok: true };
  }

  /**
   * Setup.exe kurulumunda İLK SEFER için: gerçek EYS.LS.006 Excel'inin ("Ölçüm Cihazları Takip Liste") mevcut
   * hâlini içeri aktarır. Boş satırlar atlanır; Takip No (varsa) zaten kayıtlıysa o satır atlanır — tekrar
   * yüklemek kazara yinelenmiş cihaz yaratmaz (iki kez tıklamak güvenlidir, eski iş emri geçişindeki aynı ilke).
   * @returns {{total: number, added: number, skipped: number, warnings: string[]}}
   */
  importXlsx(buffer, { by = null, now = Date.now() } = {}) {
    let book;
    try { book = readXlsx(buffer); } catch (err) { throw err instanceof XlsxError ? new PlanningError(err.message) : err; }

    let found = null; let sheetRows = null; let rowNumbers = null;
    for (const sheet of book.sheets) {
      const f = findDeviceHeader(sheet.rows);
      if (f) { found = f; sheetRows = sheet.rows; rowNumbers = sheet.rowNumbers; break; }
    }
    if (!found) throw new PlanningError('Bu dosyada Ölçüm Cihazları Takip Listesi (EYS.LS.006) başlıkları bulunamadı.');
    const { index, headerRow } = found;
    const get = (r, key) => (index.has(key) ? String(r[index.get(key)] ?? '').trim() : '');

    const known = new Set(
      this.db.prepare("SELECT tracking_no FROM measuring_devices WHERE tracking_no IS NOT NULL AND tracking_no <> ''")
        .all().map((r) => foldTr(r.tracking_no)),
    );

    let total = 0;
    let added = 0;
    let skipped = 0;
    const warnings = [];
    const warn = (m) => { if (warnings.length < 25) warnings.push(m); else if (warnings.length === 25) warnings.push('… ve daha fazla uyarı var'); };

    for (let r = headerRow + 1; r < sheetRows.length; r += 1) {
      const rowVals = sheetRows[r];
      const category = get(rowVals, 'CIHAZKATEGORISI');
      const name = get(rowVals, 'CIHAZTANIMI');
      if (category === '' && name === '') continue; // bos satir (Excel'deki bos sablon satirlari)
      total += 1;
      const excelRow = rowNumbers[r];
      const trackingNo = get(rowVals, 'TAKIPNO');
      if (trackingNo !== '' && known.has(foldTr(trackingNo))) {
        skipped += 1;
        warn(`Satır ${excelRow}: Takip No "${trackingNo}" zaten kayıtlı, atlandı.`);
        continue;
      }
      if (category === '' || name === '') {
        skipped += 1;
        warn(`Satır ${excelRow}: kategori ya da cihaz tanımı eksik, atlandı.`);
        continue;
      }
      const usableRaw = foldTr(get(rowVals, 'CIHAZDURUMU'));
      const activeRaw = foldTr(get(rowVals, 'KALIBRASYONDURUMU'));
      const input = {
        category, name,
        trackingNo, gaugeType: get(rowVals, 'MASTAROZELLIGI'), interimCheck: get(rowVals, 'ARAKONTROL'),
        serialNo: get(rowVals, 'SERINO'), modelBrand: get(rowVals, 'MODELMARKA'), measureRange: get(rowVals, 'OLCUMARALIGIMM'),
        resolutionMm: get(rowVals, 'COZUNURLUKMM'), deviationNote: get(rowVals, 'SAPMADURUMU'),
        usable: usableRaw === 'KULLANILAMAZ' ? 'kullanilamaz' : 'kullanilabilir',
        lastCalibratedOn: get(rowVals, 'KALIBRASYONDURUMUTARIH'), calibrationCompany: get(rowVals, 'KALIBRASYONFIRMASI'),
        nextCalibrationOn: get(rowVals, 'GELECEKKALIBTARIHI'), department: get(rowVals, 'BOLUMALTBOLUM'),
        heldBy: get(rowVals, 'TESLIMALANADSOYADIMZA'), deliveredOn: get(rowVals, 'TESLIMTARIHI'),
        active: activeRaw === 'PASIF' ? 'pasif' : 'aktif',
        issueNote: get(rowVals, 'HATABILGISI'), note: get(rowVals, 'GUNCEL'),
      };
      try {
        this.create(input, { by, now });
      } catch (err) {
        skipped += 1;
        warn(`Satır ${excelRow}: ${err.message}`);
        continue;
      }
      if (trackingNo !== '') known.add(foldTr(trackingNo));
      added += 1;
    }
    return { total, added, skipped, warnings };
  }
}
