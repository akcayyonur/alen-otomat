/**
 * NUMUNE TAKİP (EYS.FR.012 "Numune Talep / Takip Formu"): müşteriye numune üretilip gönderilmesi ve müşteriden
 * gelen onay/ret geri bildiriminin takibi. Ürün kartı (ya da hatta Alen ürün kodu) genelde HİÇ olmayabilir — bu
 * BİLİNÇLİ: `products` tablosuyla temelde HİÇ BAĞLANMAZ (Fiyat çalışması ile aynı ilke: ürün kartı sonra, elle
 * açılır) — **TEK İSTİSNA aşağıdaki "yeni ürün kodu oluştur" akışı** (2026-11-13, kullanıcı isteği): numune
 * formu müşteri + kod öneki (SR/Nİ) seçilerek YENİ bir Alen ürün kodu ÜRETEBİLİR; bu durumda (yalnız bu
 * durumda) numune, kendi ürettiği ürün kartına BAĞLANIR (`auto_generated=1`).
 *
 * Kâğıt formdaki "KALİTE KONTROL RAPOR NO" alanı yanlış adlandırılmış: aslında GKK rapor no'dur (kullanıcı
 * teyidi, 2026-11-02) — burada `gkkReportNo` olarak tutulur, openGkkPicker ile aynı listeden seçilebilir.
 *
 * Akış: "Yeni numune formu aç" → NUMUNE TANIMLAMA + NUMUNE ÜRETİM BİLGİLERİ alanları girilir (çoğu isteğe bağlı,
 * zamanla doldurulur: usta üretip gönderince üretim/gönderim alanlarını siz ya da usta doldurur) → form basılıp
 * müşteriye gönderilir (fiziksel; e-posta ile gelen müşteri geri bildirimi SONRADAN elle girilir) → "Düzenle"den
 * MÜŞTERİ GERİ BİLDİRİM + onaylandı/onaylanmadı işaretlenir → satır rengi yeşil/kırmızı (ikon+etiket de var, renk
 * tek başına değil).
 *
 * **Tezgaha bağlama (2026-11-13, kullanıcı isteği "numune formları da makineye iş emri gibi bağlanabilmeli"):**
 * iş emrinin `machineId`'siyle AYNI mantık — isteğe bağlı, serbestçe değiştirilebilir, envanterdeki bilinen bir
 * tezgaha ait olmalı (envanter boşsa — testte olduğu gibi — herhangi bir metin kabul edilir). Numunenin KENDİ bir
 * yaşam döngüsü (başlat/bitir) YOK; bu yalnızca "bu numune hangi tezgahta üretildi/üretilecek" bilgisidir.
 *
 * **Yeni ürün kodu oluşturma + Mikro'ya yazma (2026-11-13, kullanıcı isteği):** "Yeni numune formu aç"ta müşteri
 * (sabit 19 gruptan, `sample-customer-groups.js`) VE kod öneki (SR/Nİ) seçilirse sunucu `nextStockCode()` ile
 * bu müşteri grubunun (kodun EN SONUNDAKİ üç hane) o önekteki EN BÜYÜK mevcut ürün kartından bir SONRAKİ kodu
 * üretir (ör. SR015.011 varsa → SR016.011) ve HEM yerel bir ürün kartı (`Planning.createProduct`) HEM —
 * arka planda, `MIKRO_WRITE_ENABLED` açıksa — Mikro'da YENİ bir stok kartı (`MikroStock.previewCreateProduct`,
 * **gerçek Mikro'ya karşı hiç denenmedi**, bkz. mikro-stock.js) oluşturur. Sonra, "Numune net ağırlığı" alanı
 * (ilk kez üretilip ölçülünce) `update()`'te değişince aynı ürün kartına VE (yine arka planda, yalnız bu akışın
 * ürettiği — `auto_generated` — kodlar için) Mikro'daki o kartın ağırlığına (`previewUpdateProductWeight`,
 * **o da gerçek Mikro'ya karşı hiç denenmedi**) yazılır. İki Mikro adımı da BAŞARISIZ olursa numune/ürün kartı
 * kaydı ETKİLENMEZ (fire-and-forget, `product-depot.js`'teki "dene ve logla" deseniyle AYNI); durum ve hata
 * `mikroProductSent`/`mikroProductError`/`mikroWeightSentG`/`mikroWeightError` olarak numunede görünür, elle
 * yeniden denenebilir (`retryMikroProduct`/`retryMikroWeight`).
 *
 * **Hammadde seçimi (Mikro'dan canlı arama) + teknik resim ekleme (2026-11-13, kullanıcı isteği "hammadde seçimi
 * olsun elle yazılmasın, komple teknik resim de eklenebilsin"):**
 * - `material`/`altMaterial` alanları hâlâ düz metin SÜTUNUDUR (serbest metin olan eski kayıtlarla geriye dönük
 *   uyumlu — değer hâlâ `text(...)`), ama arayüz artık bunu Mikro hammadde aramasından (`mikroStock.searchMaterials`,
 *   hammaddenin kendi "Depolar arası sevkiyat" aramasıyla AYNI canlı Mikro okuması) SEÇTİRİR, elle yazdırmaz —
 *   seçilen hammaddenin Mikro stok kodu (ör. `HM614.AA25.00`) metin olarak yazılır. Bu sunucuda YENİ bir
 *   doğrulama/kısıt GETİRMEZ (dar bir arama ucu, `GET /api/planning/samples/materials`, yalnızca
 *   `mikroStock.searchMaterials`'ı `numune`/read yetkisiyle sarar — hammadde ekranının kendi `material/mikro/
 *   materials` ucunu ÇAĞIRMAZ, çünkü o `hammadde` ekranına bağlıdır ve numune-only bir rol o ekranı göremeyebilir;
 *   `programs/product-search`'teki "dar, ekrana özel arama ucu" deseniyle AYNI).
 * - **Teknik resim** (`sample_drawings`, iş emrinin `wo_drawings`'iyle BİREBİR AYNI yapı — içerik adresli
 *   `drawing_files` blob deposu `quality-db.js`'te zaten kurulu; `price-studies.js` gibi burada YENİDEN
 *   DECLARE EDİLMEZ, `planning.js`'te `this.quality` `this.samples`'TAN ÖNCE kurulduğu için tablo zaten var):
 *   bir numuneye en çok `MAX_DRAWINGS` (quality.js'ten, aynı sabit) PDF eklenebilir, her biri en çok
 *   `MAX_DRAWING_BYTES`. Aynı PDF (SHA) bir numuneye iki kez eklenmez; dosya SİLİNİNCE başka bir iş emri/ürün/
 *   fiyat çalışması/numune AYNI içeriği kullanmıyorsa blob da silinir (`#dropFileIfUnused`'daki ref-sayımına
 *   `sample_drawings` da eklendi — bu yeni dördüncü tüketiciyi EKLEMEK, mevcut üç tüketicinin (iş emri/ürün/
 *   fiyat çalışması) kendi silme yollarının da bunu SAYMASINI gerektiriyordu, aksi hâlde bir numune resmiyle
 *   AYNI PDF'i paylaşan bir iş emri resmi silinince numunenin blob'u da yanlışlıkla silinebilirdi — bu, kod
 *   incelemesinde bulunup `quality-db.js`/`price-studies.js`'te de düzeltildi).
 */
import { createHash } from 'node:crypto';
import { PlanningError } from './errors.js';
import { foldTr } from './normalize.js';
import { text, number, day } from './fields.js';
import { dateKey, parseDateKey, addDays, daysBetween } from '../../shared/shifts.js';
import { SAMPLE_CUSTOMER_GROUPS, SAMPLE_CODE_PREFIXES, sampleGroupByCode } from './sample-customer-groups.js';
import { inspectPdf, PdfError } from '../pdf-merge.js';
import { MAX_DRAWINGS, MAX_DRAWING_BYTES } from './quality.js';

export const STATUS = Object.freeze(['bekliyor', 'onaylandi', 'reddedildi']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sample_requests (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  seq                  INTEGER NOT NULL UNIQUE,
  code                 TEXT    NOT NULL UNIQUE,
  requested_on         INTEGER NOT NULL,
  customer             TEXT    NOT NULL,
  customer_sample_code TEXT,
  customer_code        TEXT,
  stock_code           TEXT,
  sample_qty           TEXT,
  due_date             INTEGER,
  quote_net_g          REAL,
  sample_net_g         REAL,
  production_sec       REAL,
  material             TEXT,
  alt_material         TEXT,
  length_mm            REAL,
  gauges               TEXT,
  produced_qty         INTEGER,
  sample_set_qty       INTEGER,
  produced_on          INTEGER,
  gkk_report_no        TEXT,
  sent_qty             INTEGER,
  customer_feedback    TEXT,
  status               TEXT    NOT NULL DEFAULT 'bekliyor',
  decided_on           INTEGER,
  decision_note        TEXT,
  note                 TEXT,
  machine_id           TEXT,
  customer_group_code  TEXT,
  code_prefix          TEXT,
  auto_generated       INTEGER NOT NULL DEFAULT 0,
  mikro_product_sent   INTEGER NOT NULL DEFAULT 0,
  mikro_product_error  TEXT,
  mikro_weight_sent_g  REAL,
  mikro_weight_error   TEXT,
  search_key           TEXT    NOT NULL,
  created_at           INTEGER NOT NULL,
  created_by           TEXT,
  updated_at           INTEGER NOT NULL,
  updated_by           TEXT
);
CREATE INDEX IF NOT EXISTS idx_samples_status ON sample_requests (status, id DESC);
CREATE INDEX IF NOT EXISTS idx_samples_search ON sample_requests (search_key);

-- counters: quality-db.js'teki AYNI tablo (ayni veritabani baglantisi); burada da IF NOT EXISTS ile kurulur ki
-- bu modul hangi sirada ilklendirilirse ilklendirilsin kendi basina calissin (baska bir modulun init sirasina bagli olmasin).
CREATE TABLE IF NOT EXISTS counters (
  name  TEXT    NOT NULL,
  year  INTEGER NOT NULL,
  floor INTEGER NOT NULL,
  PRIMARY KEY (name, year)
);

-- numuneye yuklenen teknik resimler: wo_drawings (quality-db.js) ile BIREBIR AYNI yapi. Icerik drawing_files'ta
-- (quality.js'teki Quality, sample-tracking.js'ten ONCE kuruldugu icin planning.js constructor sirasina gore bu
-- tablo zaten var; price-studies.js'teki AYNI varsayimla, drawing_files burada YENIDEN DECLARE EDILMEZ).
CREATE TABLE IF NOT EXISTS sample_drawings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sample_id  INTEGER NOT NULL,
  name       TEXT    NOT NULL,
  sha        TEXT    NOT NULL,
  sort       INTEGER NOT NULL,
  added_at   INTEGER NOT NULL,
  added_by   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sample_drawings_sample ON sample_drawings (sample_id, sort);
`;

const n = (v) => (v == null ? null : Number(v));
const fmtCode = (seq) => String(seq).padStart(6, '0');
const localMidnight = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };

const row = (r) => (r == null ? null : {
  id: Number(r.id), seq: Number(r.seq), code: r.code, requestedOn: Number(r.requested_on), customer: r.customer,
  customerSampleCode: r.customer_sample_code, customerCode: r.customer_code, stockCode: r.stock_code, sampleQty: r.sample_qty,
  dueDate: n(r.due_date), quoteNetG: n(r.quote_net_g), sampleNetG: n(r.sample_net_g), productionSec: n(r.production_sec),
  material: r.material, altMaterial: r.alt_material, lengthMm: n(r.length_mm), gauges: r.gauges, producedQty: n(r.produced_qty), sampleSetQty: n(r.sample_set_qty),
  producedOn: n(r.produced_on), gkkReportNo: r.gkk_report_no, sentQty: n(r.sent_qty), customerFeedback: r.customer_feedback,
  status: r.status, decidedOn: n(r.decided_on), decisionNote: r.decision_note, note: r.note, machineId: r.machine_id || null,
  customerGroupCode: r.customer_group_code, codePrefix: r.code_prefix, autoGenerated: Boolean(r.auto_generated),
  mikroProductSent: Boolean(r.mikro_product_sent), mikroProductError: r.mikro_product_error,
  mikroWeightSentG: n(r.mikro_weight_sent_g), mikroWeightError: r.mikro_weight_error,
  createdAt: Number(r.created_at), createdBy: r.created_by, updatedAt: Number(r.updated_at), updatedBy: r.updated_by,
});

export class SampleTracking {
  /** @param {{planning: import('./planning.js').Planning}} deps */
  constructor({ planning }) {
    this.planning = planning;
    this.db = planning.db.db; // ayni sqlite baglantisi
    this.db.exec(SCHEMA);
    this.#migrate();
  }

  /** Eski veritabanlari (tezgah baglantisi + yeni urun kodu olusturma eklenmeden once olusanlar): yeni sutunlar bos/0 eklenir. */
  #migrate() {
    const have = new Set(this.db.prepare('PRAGMA table_info(sample_requests)').all().map((c) => c.name));
    const add = [
      ['machine_id', 'TEXT'], ['customer_group_code', 'TEXT'], ['code_prefix', 'TEXT'],
      ['auto_generated', 'INTEGER NOT NULL DEFAULT 0'], ['mikro_product_sent', 'INTEGER NOT NULL DEFAULT 0'],
      ['mikro_product_error', 'TEXT'], ['mikro_weight_sent_g', 'REAL'], ['mikro_weight_error', 'TEXT'],
      ['length_mm', 'REAL'],
    ];
    for (const [name, type] of add) if (!have.has(name)) this.db.exec(`ALTER TABLE sample_requests ADD COLUMN ${name} ${type}`);
  }

  /** Sabit müşteri grubu listesi (yeni kod oluşturma ekranı için; yönetici ekranından düzenlenemez — `downtime-codes.json`'la aynı ilke). */
  customerGroups() {
    return SAMPLE_CUSTOMER_GROUPS;
  }

  /* --------------------------------------------------------------------------- numaralandirma */

  /** Siradaki numune kodu (kagit formdaki "SERI NO": 6 haneli, yil YOK - K000001 tarzi duz sira). */
  nextSeq() {
    const floor = Number(this.db.prepare('SELECT floor FROM counters WHERE name = ? AND year = 0').get('numune')?.floor ?? 0);
    const max = Number(this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM sample_requests').get().m);
    const next = Math.max(floor, max) + 1;
    return { floor, max, next, nextCode: fmtCode(next) };
  }

  /** "En son verilen numara" tabani (kagitta onceden basilmis numaralarla cakismasin); yalniz yukseltilebilir. */
  setSequence(last) {
    const seq = Number(String(last ?? '').trim());
    if (!Number.isInteger(seq) || seq < 0 || seq > 999_999) throw new PlanningError('Sıra 0 ile 999999 arasında bir tam sayı olmalı.');
    const { max } = this.nextSeq();
    if (seq < max) throw new PlanningError(`${fmtCode(max)} numarasına kadar zaten kayıt var.`, 409);
    this.db.prepare('INSERT INTO counters (name, year, floor) VALUES (?,0,?) ON CONFLICT(name, year) DO UPDATE SET floor = MAX(floor, excluded.floor)').run('numune', seq);
    return this.nextSeq();
  }

  /** "SR" / "Nİ" (büyük/küçük harf ve Türkçe harf duyarsız) -> kanonik görünen biçim; aksi hâlde hata. */
  #normalizePrefix(raw) {
    const folded = foldTr(raw);
    const found = SAMPLE_CODE_PREFIXES.find((p) => foldTr(p) === folded);
    if (!found) throw new PlanningError(`Kod öneki "${SAMPLE_CODE_PREFIXES.join('" ya da "')}" olmalı.`, 400, 'bad-prefix');
    return found;
  }

  /**
   * Yeni ürün kodu ÖNİZLEMESİ (rezerve ETMEZ — iş emri numarasındaki `nextSeq()`/`nextWorkOrderNo()` ile AYNI
   * ilke): seçilen müşteri grubunun (kodun SONUNDAKİ 3 hane) EN BÜYÜK mevcut ürün kartından bir SONRAKİ kodu
   * hesaplar. `products` tablosu AYNI SQLite dosyasında (`planlama.db`), ayrı bir bağlantı/sorgu gerekmez.
   * Gerçek allocation `create()` İÇİNDE, aynı senkron JS tur'unda (bu önizlemeyle aynı sorguyla) yapılır —
   * iki ayrı HTTP isteği arasında yarış penceresi olabilir (iki kullanıcı aynı anda "oluştur"a basarsa ikinci
   * istek daha güncel bir sayı görür, çakışma OLMAZ çünkü sayı `create()` anında YENİDEN hesaplanır, bu
   * fonksiyonun döndürdüğü deger yalnız gösterimdir).
   *
   * **SR ve Nİ AYNI müşteri grubunda ORTAK bir sayaçla ilerliyor (2026-11-16, yöneticinin düzeltmesi, gerçek
   * Mikro verisiyle doğrulandı):** Ayvaz (.002) grubunda SR201.002 varken Nİ yalnız Nİ198.002'ye kadar
   * çıkmıştı — ikisi birbirinden BAĞIMSIZ sayılsaydı bu fark (SR'nin daha sık seçilip önde gitmesi) hiç
   * oluşmazdı. **Önceki tasarım YANLIŞTI** (yalnız seçilen önekin kendi serisine bakıyordu, CLAUDE.md'de de
   * "bağımsız sayılır" diye hatalı belgelenmişti) — o tasarımla "sıradaki Nİ kodu" diye Nİ199.002 üretilip
   * gerçek Mikro'ya yazılmıştı, oysa ortak sayaç zaten 201'i geçmişti (bu test kaydı sonradan silindi).
   * Artık SR ve Nİ'nin İKİSİNE BİRDEN bakılıp en büyüğünden devam ediliyor — hangi önek seçilirse seçilsin.
   */
  nextStockCode({ customerGroupCode, codePrefix } = {}) {
    const group = sampleGroupByCode(customerGroupCode);
    if (!group) throw new PlanningError('Bilinmeyen müşteri grubu.', 400, 'bad-group');
    const prefix = this.#normalizePrefix(codePrefix);
    let max = 0;
    for (const p of SAMPLE_CODE_PREFIXES) {
      const foldedPrefix = foldTr(p);
      const pattern = `${foldedPrefix}___.${group.code}`; // LIKE: '_' = tek karakter, '%'/'_' baska yerde yok (prefix/kod sabit, guvenli)
      const re = new RegExp(`^${foldedPrefix}(\\d{3})\\.${group.code}$`);
      for (const r of this.db.prepare('SELECT code_key FROM products WHERE code_key LIKE ?').all(pattern)) {
        const m = re.exec(r.code_key);
        if (m) max = Math.max(max, Number(m[1]));
      }
    }
    const stockCode = `${prefix}${String(max + 1).padStart(3, '0')}.${group.code}`;
    return { stockCode, customerGroupCode: group.code, customerGroupName: group.name, codePrefix: prefix };
  }

  /* --------------------------------------------------------------------------------- liste / kayit */

  /** @param {{q?: string, status?: string, limit?: number, offset?: number}} [f] */
  list({ q = '', status = '', limit = 200, offset = 0 } = {}) {
    const conds = [];
    const args = [];
    if (q.trim() !== '') { conds.push("search_key LIKE ? ESCAPE '\\'"); args.push(`%${foldTr(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`); }
    if (STATUS.includes(status)) { conds.push('status = ?'); args.push(status); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM sample_requests ${where}`).get(...args).n);
    const items = this.db.prepare(`SELECT * FROM sample_requests ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset).map(row);
    return { total, items, next: this.nextSeq() };
  }

  /* --------------------------------------------------------------------------------- analiz (ret orani) */

  /** 'yyyy-aa-gg' -> gun araligi [fromMs, toMs); vars. bu ayin basindan bugune. `planning.js`'teki ozel #dayRange'in AYNI mantigi (yillik + pay icin ayni 400 gun siniri). */
  #dayRange(from, to, now) {
    const today = dateKey(new Date(now));
    const toKey = to ? String(to) : today;
    const fromKey = from ? String(from) : `${today.slice(0, 8)}01`;
    const p = parseDateKey(fromKey);
    const q = parseDateKey(toKey);
    if (!p || !q) throw new PlanningError('Tarih yyyy-aa-gg biçiminde olmalı.');
    if (fromKey > toKey) throw new PlanningError('Başlangıç tarihi bitişten sonra olamaz.');
    if (daysBetween(fromKey, toKey) > 400) throw new PlanningError('Aralık en fazla 400 gün olabilir.');
    const next = parseDateKey(addDays(toKey, 1));
    return { fromKey, toKey, fromMs: new Date(p.y, p.m - 1, p.d).getTime(), toMs: new Date(next.y, next.m - 1, next.d).getTime() };
  }

  /**
   * Ret analizi: belirtilen aralıkta MÜŞTERİDEN KARAR GELMİŞ (`decidedOn` bu aralıkta) kayıtların onay/ret
   * dağılımı — "ret oranı" bu sayıdan hesaplanır, çünkü henüz karar verilmemiş ("bekliyor") bir kayıt onaylandı
   * ya da reddedildi sayılamaz. Aynı aralıkta TALEP EDİLEN (`requestedOn`) kayıt sayısı ve hâlâ bekleyenler
   * bağlam için ayrıca döner (farklı bir tarih alanına göre, karıştırılmasın diye ayrı sayılar).
   */
  rejectionStats({ from = '', to = '', now = Date.now() } = {}) {
    const range = this.#dayRange(from, to, now);
    const decided = this.db.prepare(
      'SELECT status, COUNT(*) AS n FROM sample_requests WHERE decided_on >= ? AND decided_on < ? GROUP BY status',
    ).all(range.fromMs, range.toMs);
    const approved = Number(decided.find((r) => r.status === 'onaylandi')?.n ?? 0);
    const rejected = Number(decided.find((r) => r.status === 'reddedildi')?.n ?? 0);
    const decidedTotal = approved + rejected;
    const requested = Number(this.db.prepare(
      'SELECT COUNT(*) AS n FROM sample_requests WHERE requested_on >= ? AND requested_on < ?',
    ).get(range.fromMs, range.toMs).n);
    const pending = Number(this.db.prepare(
      "SELECT COUNT(*) AS n FROM sample_requests WHERE requested_on >= ? AND requested_on < ? AND status = 'bekliyor'",
    ).get(range.fromMs, range.toMs).n);
    return {
      from: range.fromKey, to: range.toKey,
      decided: decidedTotal, approved, rejected, rejectionRate: decidedTotal > 0 ? rejected / decidedTotal : null,
      requested, pending,
    };
  }

  get(id) {
    const r = this.db.prepare('SELECT * FROM sample_requests WHERE id = ?').get(Number(id));
    if (!r) throw new PlanningError('Numune kaydı bulunamadı.', 404);
    return row(r);
  }

  #searchKey(f) {
    return foldTr([f.customer, f.customerSampleCode, f.customerCode, f.stockCode, f.code].filter(Boolean).join(' '));
  }

  /** Alanları doğrular (kısmi: yalnız gönderilen anahtarlar). @param {boolean} partial */
  #fields(input, { partial = false, now = Date.now() } = {}) {
    const out = {};
    const has = (k) => Object.hasOwn(input, k);
    if (!partial || has('customer')) {
      const customer = text(input.customer, 'Müşteri', 120);
      if (!customer) throw new PlanningError('Müşteri gerekli.');
      out.customer = customer;
    }
    if (!partial || has('requestedOn')) {
      const d = day(input.requestedOn, 'Tarih');
      if (partial) { if (d != null) out.requestedOn = d; } // bos gonderilirse dokunulmaz (NOT NULL alan temizlenemez)
      else out.requestedOn = d ?? localMidnight(now);
    }
    if (has('customerSampleCode')) out.customerSampleCode = text(input.customerSampleCode, 'Müşteri numune kodu', 60);
    if (has('customerCode')) out.customerCode = text(input.customerCode, 'Müşteri ürün kodu', 60);
    if (has('stockCode')) out.stockCode = text(input.stockCode, 'Alen ürün kodu', 40);
    if (has('sampleQty')) out.sampleQty = text(input.sampleQty, 'Numune miktarı', 40);
    if (has('dueDate')) out.dueDate = day(input.dueDate, 'Teslim tarihi');
    if (has('quoteNetG')) out.quoteNetG = number(input.quoteNetG, 'Fiyat teklif net ağırlığı', { max: 100_000 });
    if (has('sampleNetG')) out.sampleNetG = number(input.sampleNetG, 'Numune net ağırlığı', { max: 100_000 });
    if (has('productionSec')) out.productionSec = number(input.productionSec, 'Üretim süresi', { max: 36_000 });
    if (has('material')) out.material = text(input.material, 'Hammadde', 80);
    if (has('altMaterial')) out.altMaterial = text(input.altMaterial, 'Alternatif hammadde', 80);
    if (has('lengthMm')) out.lengthMm = number(input.lengthMm, 'Tam boy (mm)', { max: 10_000 });
    if (has('gauges')) out.gauges = text(input.gauges, 'Kullanılan mastar/lar', 120);
    if (has('producedQty')) out.producedQty = input.producedQty === null || input.producedQty === '' ? null : intOrThrow(input.producedQty, 'Üretim miktarı');
    if (has('sampleSetQty')) out.sampleSetQty = input.sampleSetQty === null || input.sampleSetQty === '' ? null : intOrThrow(input.sampleSetQty, 'Ayrılan örnek miktarı');
    if (has('producedOn')) out.producedOn = day(input.producedOn, 'Üretim tarihi');
    if (has('gkkReportNo')) out.gkkReportNo = text(input.gkkReportNo, 'GKK rapor no', 40);
    if (has('sentQty')) out.sentQty = input.sentQty === null || input.sentQty === '' ? null : intOrThrow(input.sentQty, 'Gönderilen miktar');
    if (has('customerFeedback')) out.customerFeedback = text(input.customerFeedback, 'Müşteri geri bildirim', 2000);
    if (has('note')) out.note = text(input.note, 'Not', 500);
    if (has('machineId')) out.machineId = this.#machineOrNull(input.machineId);
    return out;
  }

  /** İş emrinin `#machine()`'iyle AYNI mantık ama NUMUNE İÇİN İSTEĞE BAĞLI: boş -> null, doluysa envanterde bilinen bir tezgah olmalı. */
  #machineOrNull(value) {
    const id = String(value ?? '').trim();
    if (id === '') return null;
    const known = this.planning.listMachines().map((m) => m.id);
    if (known.length > 0 && !known.includes(id)) throw new PlanningError(`Bilinmeyen tezgah: ${id}`, 400, 'bad-machine');
    return id;
  }

  /**
   * Yeni numune formu ("Yeni numune formu aç"). Yalnız müşteri zorunlu; geri kalan alanlar sonradan doldurulabilir.
   *
   * `customerGroupCode` + `codePrefix` İKİSİ BİRLİKTE verilirse (2026-11-13): sunucu `stockCode`'u KENDİSİ üretir
   * (elle yazılmış `stockCode` varsa bile GÖZ ARDI EDİLİR) ve senkron olarak bir ürün kartı açar (`createProduct`
   * başarısız olursa — örn. aşırı nadir bir çakışma — numune de hiç oluşmaz, yarım/sahipsiz kayıt kalmaz). Ürün
   * kartı oluştuktan SONRA numune satırı yazılır, ondan sonra Mikro'ya stok kartı oluşturma arka planda denenir
   * (`#pushMikroProductCard`, hiç bloklamaz — başarısız olursa `mikroProductError`'da görünür, elle yeniden
   * denenebilir).
   */
  create(input = {}, { by = null, now = Date.now() } = {}) {
    const groupRaw = input.customerGroupCode != null ? String(input.customerGroupCode).trim() : '';
    const prefixRaw = input.codePrefix != null ? String(input.codePrefix).trim() : '';
    if ((groupRaw === '') !== (prefixRaw === '')) {
      throw new PlanningError('Yeni ürün kodu oluşturmak için müşteri grubu VE kod öneki birlikte seçilmeli.', 400, 'bad-generate');
    }
    const generated = groupRaw !== '' ? this.nextStockCode({ customerGroupCode: groupRaw, codePrefix: prefixRaw }) : null;
    const f = this.#fields({ ...input, ...(generated ? { stockCode: generated.stockCode } : {}) }, { now });
    if (generated) {
      this.planning.createProduct(
        {
          stockCode: generated.stockCode, customerCode: f.customerCode ?? undefined, material: f.material ?? undefined,
          altMaterial: f.altMaterial ?? undefined, lengthMm: f.lengthMm ?? undefined,
        },
        { by },
      );
    }
    const { next, nextCode } = this.nextSeq();
    const id = Number(this.db.prepare(
      `INSERT INTO sample_requests (seq, code, requested_on, customer, customer_sample_code, customer_code, stock_code, sample_qty, due_date,
        quote_net_g, sample_net_g, production_sec, material, alt_material, length_mm, gauges, produced_qty, sample_set_qty, produced_on, gkk_report_no,
        sent_qty, customer_feedback, status, note, machine_id, customer_group_code, code_prefix, auto_generated,
        search_key, created_at, created_by, updated_at, updated_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'bekliyor',?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      next, nextCode, f.requestedOn, f.customer, f.customerSampleCode ?? null, f.customerCode ?? null, f.stockCode ?? null, f.sampleQty ?? null,
      f.dueDate ?? null, f.quoteNetG ?? null, f.sampleNetG ?? null, f.productionSec ?? null, f.material ?? null, f.altMaterial ?? null, f.lengthMm ?? null,
      f.gauges ?? null, f.producedQty ?? null, f.sampleSetQty ?? null, f.producedOn ?? null, f.gkkReportNo ?? null, f.sentQty ?? null,
      f.customerFeedback ?? null, f.note ?? null, f.machineId ?? null, generated?.customerGroupCode ?? null, generated?.codePrefix ?? null,
      generated ? 1 : 0, this.#searchKey({ ...f, code: nextCode }), now, by, now, by,
    ).lastInsertRowid);
    if (generated) this.#pushMikroProductCard(id).catch(() => {});
    return this.get(id);
  }

  /**
   * Alanları günceller (iş emri "Düzenle"siyle aynı mantık: yalnız gönderilen alanlar değişir). Onaylandı/reddedildi
   * olmuş kayıt da düzenlenebilir (müşteri bilgisi düzeltmek için). `sampleNetG` değişip DOLU bir değer alırsa
   * (numune ilk kez üretilip ölçülünce) bağlı ürün kartının net ağırlığı — varsa — eşitlenir; ürün kartı BU
   * AKIŞIN ürettiği (`autoGenerated`) bir koda bağlıysa Mikro'daki ağırlık da arka planda denenir (bkz. dosya başı).
   */
  update(id, input = {}, { by = null, now = Date.now() } = {}) {
    const cur = this.get(id);
    const f = this.#fields(input, { partial: true });
    if (Object.keys(f).length === 0) return cur;
    const next = { ...cur, ...f };
    const cols = [];
    const args = [];
    const map = {
      requestedOn: 'requested_on', customer: 'customer', customerSampleCode: 'customer_sample_code', customerCode: 'customer_code',
      stockCode: 'stock_code', sampleQty: 'sample_qty', dueDate: 'due_date', quoteNetG: 'quote_net_g', sampleNetG: 'sample_net_g',
      productionSec: 'production_sec', material: 'material', altMaterial: 'alt_material', lengthMm: 'length_mm', gauges: 'gauges', producedQty: 'produced_qty',
      sampleSetQty: 'sample_set_qty', producedOn: 'produced_on', gkkReportNo: 'gkk_report_no', sentQty: 'sent_qty',
      customerFeedback: 'customer_feedback', note: 'note', machineId: 'machine_id',
    };
    for (const [k, col] of Object.entries(map)) { if (Object.hasOwn(f, k)) { cols.push(`${col} = ?`); args.push(f[k] ?? null); } }
    cols.push('search_key = ?'); args.push(this.#searchKey(next));
    cols.push('updated_at = ?', 'updated_by = ?'); args.push(now, by);
    this.db.prepare(`UPDATE sample_requests SET ${cols.join(', ')} WHERE id = ?`).run(...args, Number(id));
    const updated = this.get(id);
    if (Object.hasOwn(f, 'sampleNetG') && f.sampleNetG != null && updated.stockCode) this.#syncNetWeight(updated, { by });
    return updated;
  }

  /** Numune net ağırlığı değişince (LOKAL, senkron): bağlı ürün kartının net ağırlığını eşitler — ürün kartı yoksa sessizce atlar (numune hâlâ `products`'a bağlı olmak ZORUNDA değil, bkz. dosya başı). */
  #syncNetWeight(sample, { by }) {
    let product;
    try { product = this.planning.getProduct(sample.stockCode); } catch { return; } // bagli urun karti yok - sessizce atla
    try { this.planning.updateProduct(sample.stockCode, { netKg: sample.sampleNetG / 1000 }, { by }); } catch { /* agirlik siniri vs. - numune kaydi yine de guncellendi */ }
    if (sample.autoGenerated) this.#pushMikroWeight(sample.id).catch(() => {});
  }

  /** Mikro'da YENİ stok kartı oluşturma denemesi (arka plan; `create()`'in `auto_generated` akışından çağrılır). Asla fırlatmaz — durum satıra yazılır.
   * `hammadde`/`tamBoy`: numunenin kendi `material`/`lengthMm` alanlarından - STOKLAR_USER'a `user_tablo` ile yazılır (bkz. mikro-stock.js). */
  async #pushMikroProductCard(id) {
    const s = this.get(id);
    if (s.mikroProductSent) return;
    try {
      const preview = this.planning.mikroStock.previewCreateProduct({
        stockCode: s.stockCode, name: s.customerCode || s.customerSampleCode || null,
        hammadde: s.material || undefined, tamBoy: s.lengthMm ?? undefined,
      });
      await this.planning.mikroStock.send(preview);
      this.db.prepare('UPDATE sample_requests SET mikro_product_sent = 1, mikro_product_error = NULL WHERE id = ?').run(id);
    } catch (err) {
      this.db.prepare('UPDATE sample_requests SET mikro_product_sent = 0, mikro_product_error = ? WHERE id = ?').run(err.message, id);
    }
  }

  /** Mikro'daki stok kartının ağırlığını güncelleme denemesi (arka plan). Asla fırlatmaz — durum satıra yazılır. */
  async #pushMikroWeight(id) {
    const s = this.get(id);
    if (s.sampleNetG == null) return;
    if (s.mikroWeightSentG === s.sampleNetG) return; // zaten gonderilmis, degismedi
    try {
      const preview = this.planning.mikroStock.previewUpdateProductWeight({ stockCode: s.stockCode, netKg: s.sampleNetG / 1000 });
      await this.planning.mikroStock.send(preview);
      this.db.prepare('UPDATE sample_requests SET mikro_weight_sent_g = ?, mikro_weight_error = NULL WHERE id = ?').run(s.sampleNetG, id);
    } catch (err) {
      this.db.prepare('UPDATE sample_requests SET mikro_weight_error = ? WHERE id = ?').run(err.message, id);
    }
  }

  /** "Yeniden dene" (ürün kartı): yalnız bu akışın ürettiği (autoGenerated) numunelerde anlamlı. */
  async retryMikroProduct(id) {
    const s = this.get(id);
    if (!s.autoGenerated) throw new PlanningError('Bu numune yeni bir ürün kodu oluşturmadı; Mikro ürün kartı gönderilemez.', 409, 'not-generated');
    await this.#pushMikroProductCard(id);
    return this.get(id);
  }

  /** "Yeniden dene" (ağırlık): yalnız autoGenerated VE net ağırlık girilmişse anlamlı. */
  async retryMikroWeight(id) {
    const s = this.get(id);
    if (!s.autoGenerated) throw new PlanningError('Bu numune yeni bir ürün kodu oluşturmadı; Mikro\'da güncellenecek bir stok kartı yok.', 409, 'not-generated');
    if (s.sampleNetG == null) throw new PlanningError('Önce numune net ağırlığı girilmeli.', 409, 'no-weight');
    await this.#pushMikroWeight(id);
    return this.get(id);
  }

  /* -------------------------------------------------------------------------------- teknik resimler (PDF) */

  #drawingsRaw(id) {
    return this.db.prepare(
      `SELECT d.id, d.name, d.sha, d.sort, d.added_at, d.added_by, f.size, f.pages
         FROM sample_drawings d JOIN drawing_files f ON f.sha = d.sha WHERE d.sample_id = ? ORDER BY d.sort, d.id`,
    ).all(Number(id)).map((r) => ({
      id: Number(r.id), name: r.name, sha: r.sha, sort: Number(r.sort), size: Number(r.size), pages: Number(r.pages),
      addedAt: Number(r.added_at), addedBy: r.added_by,
    }));
  }

  /** Numuneye yüklenen PDF'ler (içerik olmadan). */
  listDrawings(id) {
    this.get(id); // 404 yoksa
    return this.#drawingsRaw(id).map(({ sha, ...d }) => d);
  }

  /**
   * Numuneye PDF ekler. Geçerli, şifresiz, sayfası olan PDF olmalı; aynı dosya aynı numuneye ikinci kez eklenmez.
   * @param {number} id @param {{name?: string, data: Buffer}} file
   */
  addDrawing(id, { name, data }, { by = null, now = Date.now() } = {}) {
    this.get(id);
    if (!Buffer.isBuffer(data) || data.length === 0) throw new PlanningError('Dosya boş.');
    if (data.length > MAX_DRAWING_BYTES) throw new PlanningError(`PDF çok büyük (en fazla ${Math.round(MAX_DRAWING_BYTES / 1048576)} MB).`, 413);
    const have = this.#drawingsRaw(id);
    if (have.length >= MAX_DRAWINGS) throw new PlanningError(`Bir numuneye en çok ${MAX_DRAWINGS} PDF eklenebilir.`, 409, 'too-many');
    let info;
    try { info = inspectPdf(data); } catch (err) {
      if (err instanceof PdfError) throw new PlanningError(`PDF kabul edilmedi: ${err.message}`, 422, 'bad-pdf');
      throw err;
    }
    const sha = createHash('sha256').update(data).digest('hex');
    if (have.some((d) => d.sha === sha)) throw new PlanningError('Bu PDF zaten ekli.', 409, 'duplicate');
    this.db.prepare('INSERT OR IGNORE INTO drawing_files (sha, size, pages, data, created_at) VALUES (?,?,?,?,?)').run(sha, data.length, info.pages, data, now);
    const clean = (String(name ?? '').split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120) || 'teknik-resim.pdf';
    const sort = Number(this.db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM sample_drawings WHERE sample_id = ?').get(Number(id)).s);
    this.db.prepare('INSERT INTO sample_drawings (sample_id, name, sha, sort, added_at, added_by) VALUES (?,?,?,?,?,?)').run(Number(id), clean, sha, sort, now, by);
    return this.listDrawings(id);
  }

  /** Dosyayı numuneden kaldırır; başka hiçbir iş emri/ürün/fiyat çalışması/numune aynı içeriği kullanmıyorsa blob da silinir. */
  deleteDrawing(id, drawingId) {
    const d = this.db.prepare('SELECT * FROM sample_drawings WHERE id = ? AND sample_id = ?').get(Number(drawingId), Number(id));
    if (!d) throw new PlanningError('Çizim bulunamadı.', 404);
    this.db.prepare('DELETE FROM sample_drawings WHERE id = ?').run(d.id);
    const used = Number(this.db.prepare(
      `SELECT (SELECT COUNT(*) FROM wo_drawings WHERE sha=?) + (SELECT COUNT(*) FROM product_files WHERE sha=?) +
              (SELECT COUNT(*) FROM price_studies WHERE sha=?) + (SELECT COUNT(*) FROM sample_drawings WHERE sha=?) AS n`,
    ).get(d.sha, d.sha, d.sha, d.sha).n);
    if (used === 0) this.db.prepare('DELETE FROM drawing_files WHERE sha = ?').run(d.sha);
    return this.listDrawings(id);
  }

  /** PDF içeriği (görüntüleme için; sendProductFile ile aynı biçimde kullanılır). */
  drawingData(drawingId) {
    const r = this.db.prepare('SELECT name, sha FROM sample_drawings WHERE id = ?').get(Number(drawingId));
    if (!r) throw new PlanningError('Çizim bulunamadı.', 404);
    const f = this.db.prepare('SELECT data FROM drawing_files WHERE sha = ?').get(r.sha);
    return { name: r.name, data: Buffer.from(f.data) };
  }

  /** Müşteriden gelen karar (e-posta ile gelir, elle girilir): onaylandı ya da onaylanmadı. @param {{status: 'onaylandi'|'reddedildi', decidedOn?: any, note?: string}} input */
  decide(id, input = {}, { by = null, now = Date.now() } = {}) {
    this.get(id);
    if (input.status !== 'onaylandi' && input.status !== 'reddedildi') throw new PlanningError('Durum "onaylandi" ya da "reddedildi" olmalı.');
    const decidedOn = day(input.decidedOn, 'Karar tarihi') ?? localMidnight(now);
    const note = text(input.note, 'Açıklama', 1000);
    this.db.prepare('UPDATE sample_requests SET status = ?, decided_on = ?, decision_note = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .run(input.status, decidedOn, note, now, by, Number(id));
    return this.get(id);
  }

  /** Yanlışlıkla işaretlenen kararı geri al (yeniden "bekliyor" olur). */
  reopen(id, { by = null, now = Date.now() } = {}) {
    const cur = this.get(id);
    if (cur.status === 'bekliyor') return cur;
    this.db.prepare('UPDATE sample_requests SET status = ?, decided_on = NULL, decision_note = NULL, updated_at = ?, updated_by = ? WHERE id = ?')
      .run('bekliyor', now, by, Number(id));
    return this.get(id);
  }

  /** Yanlış açılmış kaydı sil (yalnız yönetici; onay/ret kararı verilmiş bir kayıt da silinebilir - geçmiş kayıt değil, bu bir form). */
  delete(id) {
    this.get(id);
    this.db.prepare('DELETE FROM sample_requests WHERE id = ?').run(Number(id));
    return { ok: true };
  }
}

function intOrThrow(value, label) {
  const n2 = Number(String(value).trim().replace(/\./g, '').replace(',', '.'));
  if (!Number.isInteger(n2) || n2 < 0 || n2 > 10_000_000) throw new PlanningError(`${label} 0 ile 10.000.000 arasında bir tam sayı olmalı.`);
  return n2;
}
