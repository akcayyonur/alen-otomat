/**
 * MAIL'DEN SİPARİŞ GİRİŞİ — PDF ya da e-posta gövdesindeki TABLO olarak gelen siparişleri (yeni ya da
 * revizyon) TASLAK olarak çıkarır; "göster-onayla" (bkz. CLAUDE.md §6 "Mail'den otomatik sipariş girişi").
 *
 * `products`'a MÜŞTERİ ÜRÜN KODU üzerinden eşler (`productsByCustomerCode`, iş emri/sipariş akışıyla AYNI
 * yöntem). Mevcut `order_lines`'a (Mikro/Excel'den senkronize gerçek sipariş aynası) HİÇ YAZMAZ — yalnız
 * REVİZYON KARŞILAŞTIRMASI için OKUR (aynı müşteri sipariş no + Alen stok koduyla eşleşen satırı bulup
 * miktar/teslim tarihi FARKINI gösterir).
 *
 * **Mikro'ya YAZMA bu turda YOK** (kullanıcı kararı, 2026-11-17: "şimdilik mikro kısmını deneme") —
 * `approveLine` yalnız durumu değiştirir, Mikro'ya hiçbir şey göndermez (`SiparisKaydetV2`'nin karşılığı
 * hiç araştırılmadı, bkz. CLAUDE.md). Onaylanan taslaklar Mikro'ya yazma akışı AYRI bir oturumda eklenecek.
 *
 * Girdi biçimleri (gerçek örneklerle bulunan, bkz. CLAUDE.md):
 *   - PDF (Siamp/Ayvaz-HaVana/Konveyör gibi ek dosya): `pdf-text.js` + `pdf-table.js` ile satır/sütun
 *     çıkarılır, başlık anahtar kelimeleriyle müşteri TAHMİN edilir.
 *   - E-posta gövdesinde TABLO (bir müşteri hem yeni siparişi hem revizyonu HTML tablo olarak gönderiyor,
 *     gerçek örnekle doğrulandı): revizyon satırında SARI VURGULU bir hücre (iptal metni / yeni tarih /
 *     yeni miktar) değişikliği işaret eder. **Gerçek ham e-posta HTML'i ile DENENMEDİ** — yalnız ekran
 *     görüntüsündeki gerçek verilerle (değerler, sütun adları) ve genel HTML tablo varsayımıyla kuruldu;
 *     gerçek bir .eml/HTML örneği gelince doğrulanmalı.
 *
 * Fiyat (birim fiyat) 2026-11-18'den beri PDF'lerden de çıkarılır (`pdf-table.js`'teki 'price' alanı +
 * `extractPriceToken`'ın "ilk virgüllü sayıyı al" düzeltmesi) — ama diğer her çıkarılan alan gibi bu da bir
 * TASLAKTIR: `updateLine` ile onaydan ÖNCE düzeltilebilir (qty/deliveryDate/custOrderNo/price/stockCode) —
 * kullanıcı kararı ("fieldlar zaten check edilecek ya onaylanıp mikroya yazılmadan önce, o yüzden her şey
 * düzelenebilir olsun"). E-posta tablosu (`parseEmailTable`) henüz fiyat çıkarmaz (gerçek bir örnekte fiyat
 * sütunu görülmedi), ama `updateLine` o kaynaktan gelen satırlara da aynı şekilde elle fiyat eklemeye izin verir.
 *
 * Müşteri tahmini (`customerGuess`) 2026-11-19'dan beri eşleşen ürünlerin Alen kodu SONUNDAKİ 3 haneden de
 * çıkarılır (`#guessCustomerFromProducts`, Numune Takip'in 19 sabit grubunu — `sample-customer-groups.js` —
 * YENİDEN kullanır): e-posta tablosunda HER ZAMAN denenir (eskiden hep `null`'dı), PDF'te yalnız metinden
 * (`detectPdfCustomer`) bulunamazsa YEDEK olarak. Bkz. CLAUDE.md §6.
 */
import { PlanningError } from './errors.js';
import { extractPdfText } from './pdf-text.js';
import { extractOrderTable, extractDocOrderNo } from './pdf-table.js';
import { ocrPage } from './ocr.js';
import { foldTr, looseKey, parseDate, parseNumber } from './normalize.js';
import { day, number, text } from './fields.js';
import { sampleGroupByCode } from './sample-customer-groups.js';

export const BATCH_SOURCES = Object.freeze(['pdf', 'email-table']);
export const BATCH_KINDS = Object.freeze(['yeni', 'revizyon']);
export const LINE_STATUS = Object.freeze(['bekliyor', 'onaylandi', 'reddedildi']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS incoming_batches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source          TEXT    NOT NULL,
  kind            TEXT    NOT NULL,
  filename        TEXT,
  customer_guess  TEXT,
  page_count      INTEGER,
  warning         TEXT,
  created_at      INTEGER NOT NULL,
  created_by      TEXT
);

CREATE TABLE IF NOT EXISTS incoming_lines (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id            INTEGER NOT NULL REFERENCES incoming_batches(id),
  row_no              INTEGER NOT NULL,
  raw_code            TEXT,
  raw_description     TEXT,
  raw_qty             TEXT,
  raw_delivery_date   TEXT,
  raw_price           TEXT,
  cust_order_no       TEXT,
  qty                 REAL,
  price               REAL,
  delivery_date       INTEGER,
  matched_code_key    TEXT,
  matched_stock_code  TEXT,
  matched_name        TEXT,
  match_status        TEXT    NOT NULL,
  candidate_count     INTEGER NOT NULL DEFAULT 0,
  is_revision         INTEGER NOT NULL DEFAULT 0,
  revision_type       TEXT,
  revision_raw        TEXT,
  existing_line_id    INTEGER,
  existing_qty        REAL,
  existing_due_date   INTEGER,
  status              TEXT    NOT NULL DEFAULT 'bekliyor',
  decided_at          INTEGER,
  decided_by          TEXT
);
CREATE INDEX IF NOT EXISTS idx_incoming_lines_batch ON incoming_lines (batch_id, row_no);
`;

const fold = (s) => foldTr(String(s ?? '')).replace(/\s+/g, '');

/** PDF sayfasının tam metninden (boşluksuz, büyük harf) müşteri TAHMİNİ — gerçek 3 PDF örneğiyle doğrulandı. */
const CUSTOMER_SIGNS = [
  { name: 'Siamp', keys: ['SIAMP'] },
  { name: 'Ayvaz', keys: ['AYVAZ', 'HAVANA'] },
  { name: 'Konveyör', keys: ['KONVEYOR'] },
];
function detectPdfCustomer(flatText) {
  for (const c of CUSTOMER_SIGNS) if (c.keys.some((k) => flatText.includes(k))) return c.name;
  return null;
}

/**
 * Alen ürün kodunun SONUNDAKİ 3 hanesinden (ör. "SR027.013" → "013") müşteri grubunu çıkarır —
 * Numune Takip'in (EYS.FR.012) yeni kod üretme akışıyla PAYLAŞILAN AYNI 19 sabit grup (`sample-customer-groups.js`);
 * ikinci bir liste İCAT EDİLMEDİ. Biçime uymayan (eski/numune kodu, format dışı) kod için `null`.
 */
function customerGroupOfStockCode(stockCode) {
  const m = /\.(\d{3})$/.exec(String(stockCode ?? '').trim());
  return m ? sampleGroupByCode(m[1]) : null;
}

function extractDateToken(text) {
  const m = /\d{1,2}[.\/]\d{1,2}[.\/]\d{4}/.exec(String(text ?? ''));
  return m ? parseDate(m[0]) : null;
}
function extractQtyToken(text) {
  // ONCE gruplanmis bicim ("1.200", "5.000,00" - en az bir bin ayiraci grubu SART), YOKSA duz sayi ("1500", "600").
  // Duz \d{1,3}(?:[.,]\d{3})*  "1500" gibi AYIRICISIZ 4+ haneli sayida yalniz ILK 3 haneyi alirdi (gercek veriyle bulundu).
  const m = /\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/.exec(String(text ?? ''));
  // siparis adetleri hep TAM SAYI: integer:true SART - yoksa "1.200" (bin ikiyuz) "." ONDALIK sanilip 1,2'ye duser
  // (ayni hata bir kez fields.js#number()'da bulunup duzeltilmisti, bkz. CLAUDE.md "Turkce yazim").
  return m ? parseNumber(m[0], { integer: true }) : null;
}

/**
 * Bir hücrenin metninden FİYAT gibi görünen (virgüllü, kuruşlu) İLK sayıyı alır. `pdf-table.js`'teki 'price'
 * alanı bazı belgelerde (ör. gerçek Siamp) birim fiyat + satır toplamını AYNI hücrede art arda verir
 * ("0,5400 2.700,00") — virgül daima ondalık olduğu için (CLAUDE.md "Türkçe yazım") İLK eşleşme her zaman
 * BİRİM fiyattır, ikincisi (satır toplamı) yok sayılır. Tam sayı DEĞİLDİR (`extractQtyToken`'ın aksine):
 * fiyat her zaman kuruşlu bir virgül taşır, bu yüzden regex virgülsüz bir sayıyı (tarih/adet kalıntısı
 * olabilir) eşlemez.
 */
function extractPriceToken(text) {
  const m = /\d{1,3}(?:\.\d{3})*,\d+/.exec(String(text ?? ''));
  return m ? parseNumber(m[0]) : null;
}

/**
 * Sarı vurgulu "revizyon notu" hücresini sınıflar: İPTAL metni / tarih / miktar. Hiçbiri değilse `bilinmiyor`.
 * @param {string} raw @returns {{type: ('iptal'|'tarih'|'miktar'|'bilinmiyor'), value: (number|null), display: string}|null}
 */
export function classifyRevisionNote(raw) {
  const t = String(raw ?? '').trim();
  if (t === '') return null;
  if (foldTr(t) === 'IPTAL') return { type: 'iptal', value: null, display: t };
  const dateMs = extractDateToken(t);
  if (dateMs !== null) return { type: 'tarih', value: dateMs, display: t };
  const qty = extractQtyToken(t);
  if (qty !== null) return { type: 'miktar', value: qty, display: t };
  return { type: 'bilinmiyor', value: null, display: t };
}

/* ============================================================================= e-posta HTML tablosu */

/** `<table>` içindeki satır/hücreleri çıkarır; hücrenin sarı vurgulu olup olmadığını (`style`/`bgcolor`) işaretler. */
function parseHtmlTableRows(html) {
  const rows = [];
  for (const tr of String(html ?? '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [];
    for (const c of tr[1].matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)) {
      const attrs = c[1];
      const text = c[2].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"').replace(/\s+/g, ' ').trim();
      const highlighted = /background(-color)?\s*:\s*#?(FFFF00|FFF200|yellow)/i.test(attrs) || /bgcolor\s*=\s*"?#?(FFFF00|yellow)/i.test(attrs);
      cells.push({ text, highlighted });
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

const EMAIL_HEADER_KEYS = [
  { field: 'deliveryDate', keys: ['TESLIMTARIHI'] },
  { field: 'custOrderNo', keys: ['SIPARISNUMARASI', 'SIPARISNO'] },
  { field: 'code', keys: ['MALZEMEKODU', 'URUNKODU'] },
  { field: 'description', keys: ['MALZEMEACIKLAMASI', 'ACIKLAMA', 'TANIM'] },
  { field: 'qty', keys: ['KALANMIKTAR', 'SIPARISMIKTARI', 'MIKTAR'] },
];

/**
 * E-posta gövdesindeki HTML tabloyu satırlara çözer. Başlık satırı anahtar kelimelerle tanınır (en az 3
 * alan eşleşmeli); tanınmazsa `null`. **Gerçek ham HTML örneğiyle DENENMEDİ** (bkz. dosya başı).
 * @param {string} html @returns {{deliveryDate:string, custOrderNo:string, code:string, description:string, qty:string, revisionNote:(string|null)}[] | null}
 */
export function parseEmailTable(html) {
  const rows = parseHtmlTableRows(html);
  if (rows.length < 2) return null;
  const headerIdx = {};
  rows[0].forEach((cell, i) => {
    const f = fold(cell.text);
    for (const h of EMAIL_HEADER_KEYS) if (h.keys.some((k) => f.includes(k)) && headerIdx[h.field] === undefined) headerIdx[h.field] = i;
  });
  if (Object.keys(headerIdx).length < 3) return null;
  const headerWidth = rows[0].length;
  const get = (row, field) => (headerIdx[field] !== undefined ? row[headerIdx[field]]?.text ?? null : null);
  return rows.slice(1).map((row) => ({
    deliveryDate: get(row, 'deliveryDate'), custOrderNo: get(row, 'custOrderNo'), code: get(row, 'code'),
    description: get(row, 'description'), qty: get(row, 'qty'),
    // Revizyon isareti IKI farkli bicimde gelebilir: sari vurgulu bir hucre (ilk tasarimin varsayimi, bir
    // ekran goruntusunden) YA DA basligin sutun sayisini asan EK bir hucre (GERCEK revizyon e-postasinda
    // gorulen bicim, 2026-11-19: satirin SONUNA eski degerin yanina YENI deger/"iptal" eklenir, ör. "...1.200
    // 1500" -> eski 1200, yeni 1500). Once vurgulu hucre denenir, yoksa tasan son hucre alinir (bos ise
    // falsy, cagiran `if (row.revisionNote)` ile zaten dogru islenir).
    revisionNote: row.find((c) => c.highlighted)?.text ?? (row.length > headerWidth ? row[row.length - 1].text : null),
  }));
}

/* ======================================================================================== ana sınıf */

export class IncomingOrders {
  /** @param {{planning: import('./planning.js').Planning}} deps */
  constructor({ planning }) {
    this.planning = planning;
    this.db = planning.db.db; // ayni sqlite baglantisi
    this.db.exec(SCHEMA);
    this.#migrate();
  }

  /** Eski veritabanlari (fiyat sutunlari eklenmeden once olusanlar): yeni sutunlar bos eklenir. */
  #migrate() {
    const have = new Set(this.db.prepare('PRAGMA table_info(incoming_lines)').all().map((c) => c.name));
    if (!have.has('raw_price')) this.db.exec('ALTER TABLE incoming_lines ADD COLUMN raw_price TEXT');
    if (!have.has('price')) this.db.exec('ALTER TABLE incoming_lines ADD COLUMN price REAL');
  }

  /** Müşteri ürün koduyla (satırın ilk sözcüğü) ürün kartı arar. Birden çok eşleşirse `ambiguous`. */
  #resolveProduct(rawCode) {
    const code = String(rawCode ?? '').trim().split(/\s+/)[0] ?? '';
    if (code === '') return { status: 'yok', candidates: [] };
    const matches = this.planning.db.productsByCustomerCode(code);
    if (matches.length === 1) return { status: 'tam', candidates: matches };
    if (matches.length > 1) return { status: 'belirsiz', candidates: matches };
    return { status: 'yok', candidates: [] };
  }

  /** Aynı (müşteri sipariş no, Alen stok kodu) için GERÇEK sipariş satırı arar (revizyon karşılaştırması). */
  #findExistingLine(custOrderNo, codeKey, deliveryMs) {
    const key = looseKey(custOrderNo);
    if (!key || !codeKey) return null;
    const rows = this.db.prepare('SELECT * FROM order_lines WHERE stale = 0 AND cust_order_key = ? AND code_key = ? ORDER BY due_date').all(key, codeKey);
    if (rows.length === 0) return null;
    if (deliveryMs != null) {
      const exact = rows.find((r) => r.due_date === deliveryMs);
      if (exact) return exact;
    }
    return rows[rows.length - 1];
  }

  /**
   * Eşleşen ürünlerin Alen kodu sonundaki 3 haneden müşteri TAHMİNİ — e-posta tablosunun kendi `customerGuess`'i
   * hep `null`du (2026-11-19, kullanıcı isteği: "mail üzerinden bu şekilde tablo olarak siparişi sadece Berg
   * gönderiyor... bu ürünlerin kodları sonunda 013 olduğunu görüyor oradan da berg olduğunu anlıyoruz") ve
   * PDF'te metinden bulunamayan müşteri (`detectPdfCustomer` → `null`) için bir YEDEK sinyaldir.
   * **Yalnız TÜM eşleşen (match_status='tam') satırlar AYNI gruba çıkarsa** kullanılır; karışık bir taslakta
   * (iki farklı müşterinin kodu bir arada, ya da biri biçime uymayan eski/numune bir kod) ya da hiç eşleşen
   * satır yoksa `null` — CLAUDE.md'nin "asla belirsizken tahmin etme" ilkesiyle aynı.
   */
  #guessCustomerFromProducts(batchId) {
    const rows = this.db.prepare(
      "SELECT DISTINCT matched_stock_code AS c FROM incoming_lines WHERE batch_id = ? AND match_status = 'tam' AND matched_stock_code IS NOT NULL",
    ).all(batchId);
    const names = new Set();
    for (const r of rows) {
      const group = customerGroupOfStockCode(r.c);
      if (!group) return null; // biçime uymayan bir kod varsa karışık sayılır, tahmin yapılmaz
      names.add(group.name);
    }
    return names.size === 1 ? [...names][0] : null;
  }

  #insertBatch({ source, kind, filename, customerGuess, pageCount, warning, by }) {
    const r = this.db.prepare(
      'INSERT INTO incoming_batches (source, kind, filename, customer_guess, page_count, warning, created_at, created_by) VALUES (?,?,?,?,?,?,?,?)',
    ).run(source, kind, filename ?? null, customerGuess ?? null, pageCount ?? null, warning ?? null, Date.now(), by ?? null);
    return Number(r.lastInsertRowid);
  }

  /**
   * Çıkarılmış bir taslak satırı (ortak alanlar) ürün/revizyon bilgisiyle zenginleştirip kaydeder.
   * @param {{code,description,qty,deliveryDate,custOrderNo,revisionNote?}} row
   */
  #insertLine(batchId, rowNo, row, { kind }) {
    let qty = typeof row.qty === 'number' ? row.qty : extractQtyToken(row.qty);
    // Adet sutunu bulunamayan belgelerde (gercek HAVANA formu: "GVA-16 YATAK 500,00Adet" - miktar aciklamanin icinde) "<sayi> Adet" aranir.
    if (qty == null && row.description) {
      const m = /(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?)\s*adet/i.exec(String(row.description));
      if (m) qty = extractQtyToken(m[1]);
    }
    // `baseDeliveryMs`: satirin KENDI "teslim tarihi" sutunundaki deger — revizyon e-postalarinda bu ESKI
    // (mevcut Mikro'daki) tarihtir, yalniz not 'tarih' tipindeyse `deliveryMs` asagida YENI hedefe cevrilir.
    // Var olan siparisi ARARKEN (`#findExistingLine`) her zaman `baseDeliveryMs` kullanilir: Mikro'da henuz
    // guncelleme olmadigi icin gercek kayit hala ESKI tarihi tasir, YENI (henuz onaylanmamis) tarihle aranirsa
    // bulunamaz.
    const baseDeliveryMs = typeof row.deliveryDate === 'number' ? row.deliveryDate : extractDateToken(row.deliveryDate);
    let deliveryMs = baseDeliveryMs;
    let price = typeof row.price === 'number' ? row.price : extractPriceToken(row.price);
    // Bazi belgelerde (gercek HAVANA/SAS0003812: "Tutar" basligi "Giris Tarihi" ile AYNI hucrede birlesiyor,
    // bkz. pdf-table.js) fiyat sutunu hic kendi sinirini bulamaz ve sayisi 'deliveryDate' alaninin ham
    // metninde kalir ("Mal yet 157,55 78.775,006.11.2026") — qty'nin aciklamadan kurtarilmasiyla AYNI ilke.
    if (price == null && row.deliveryDate) price = extractPriceToken(row.deliveryDate);
    const product = this.#resolveProduct(row.code);
    const matched = product.status === 'tam' ? product.candidates[0] : null;

    // NOT: "eslesen urun bulunamadi" VAR OLAN siparisi ARAMAMIZI engellememeli; ikisi BAGIMSIZ kontrol edilir
    // (ilk yazimda 'matched' yoksa not siniflandirmasi hic calismiyordu - gercek test verisiyle bulunup duzeltildi).
    let isRevision = 0; let revisionType = null; let revisionRaw = null;
    let existingLineId = null; let existingQty = null; let existingDueDate = null;
    if (kind === 'revizyon') {
      if (row.revisionNote) {
        const cls = classifyRevisionNote(row.revisionNote);
        if (cls) {
          isRevision = 1; revisionType = cls.type; revisionRaw = cls.display;
          // GERCEK revizyon e-postasinda (2026-11-19, kullanicinin kendi ornegiyle bulundu) "SIPARIS MIKTARI"
          // sutunu ESKI (mevcut) degerdir; satirin SONUNA eklenen bu not YENI HEDEF degerdir ("iptal" haric,
          // o zaman qty ESKI (iptal edilen) adet olarak bilgi amacli kalir). qty/deliveryMs bu yuzden notun
          // degerine CEVRILIR — ilk yazimda yalniz TIP siniflandiriliyordu, stored deger hep ESKI kalıyordu.
          if (cls.type === 'miktar' && cls.value != null) qty = cls.value;
          else if (cls.type === 'tarih' && cls.value != null) deliveryMs = cls.value;
        }
      }
      if (matched) {
        const existing = this.#findExistingLine(row.custOrderNo, matched.codeKey, baseDeliveryMs);
        if (existing) {
          existingLineId = existing.id; existingQty = existing.qty; existingDueDate = existing.due_date;
          if (!row.revisionNote) {
            // vurgulu not YOK (ör. PDF'ten gelen revizyon): var olan degerle karsilastirip CIKARSA
            if (qty != null && existing.qty != null && qty !== existing.qty) { isRevision = 1; revisionType = 'miktar'; }
            else if (deliveryMs != null && existing.due_date != null && deliveryMs !== existing.due_date) { isRevision = 1; revisionType = 'tarih'; }
          }
        }
      }
    }

    this.db.prepare(
      `INSERT INTO incoming_lines (batch_id, row_no, raw_code, raw_description, raw_qty, raw_delivery_date, raw_price, cust_order_no, qty, price, delivery_date,
          matched_code_key, matched_stock_code, matched_name, match_status, candidate_count, is_revision, revision_type, revision_raw,
          existing_line_id, existing_qty, existing_due_date, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'bekliyor')`,
    ).run(
      batchId, rowNo, row.code ?? null, row.description ?? null, row.qty == null ? null : String(row.qty), row.deliveryDate == null ? null : String(row.deliveryDate),
      row.price == null ? null : String(row.price),
      row.custOrderNo ?? null, qty, price, deliveryMs,
      matched?.codeKey ?? null, matched?.stockCode ?? null, matched?.name ?? null, product.status, product.candidates.length,
      isRevision, revisionType, revisionRaw, existingLineId, existingQty, existingDueDate,
    );
  }

  /**
   * PDF dosyasından taslak sipariş satırları çıkarır. Mikro'ya HİÇBİR ŞEY YAZILMAZ (yalnız taslak).
   * Taranmış (fotokopi/tarayıcı) sayfalar önce Tesseract OCR ile denenir (`ocr.js`, Setup.exe `runtime\tesseract\`
   * altına gömer); bulunamazsa ya da OCR başarısız olursa eski "taranmış, okunamadı" davranışına düşer.
   * @param {Buffer} buffer @param {{filename?:string, kind?:('yeni'|'revizyon'), by?:string, ocr?:Function}} [opts]
   *   `ocr`: testlerde sahte OCR enjekte etmek için (`schedule.js#suggest({run})` ile AYNI ilke) — vars. gerçek `ocrPage`.
   */
  importPdf(buffer, { filename = null, kind = 'yeni', by = null, ocr = ocrPage } = {}) {
    if (!BATCH_KINDS.includes(kind)) throw new PlanningError('Geçersiz tür (yeni|revizyon).');
    let extracted;
    try { extracted = extractPdfText(buffer); } catch (err) { throw new PlanningError(`PDF okunamadı: ${err.message}`); }
    const draftRows = [];
    const allRuns = []; // musteri tahmini (detectPdfCustomer) icin: dijital metin + OCR metni BIRLIKTE
    let docOrderNo = null; // belgenin KENDI (tablo DISINDAKI) siparis numarasi - ilk bulunan sayfa kazanir
    let scannedPages = 0; let ocrPages = 0; let noCmapPages = 0; let tablePages = 0;
    // Bir kalem sayfa sonunda yarim kalabilir (ust satirlari 1. sayfada, veri satiri 2. sayfada): `carry` sonraki
    // sayfanin ilk satirinin ONUNE eklenir. Sayfada tablo yoksa tasima birakilir.
    let carry = null;
    const takeTable = (table) => {
      tablePages += 1;
      const rows = table.rows.map((r) => ({ ...r }));
      if (carry && rows.length) {
        for (const [k, v] of Object.entries(carry)) rows[0][k] = rows[0][k] ? `${v} ${rows[0][k]}` : v;
      }
      carry = table.carry ?? null;
      for (const row of rows) {
        // urunu tanimlayan (kod ya da aciklama) hicbir sey okunmamis satir (OCR gurultusu: yalniz tek tuk rakam) taslak degildir
        if (['code', 'description'].every((f) => String(row[f] ?? '').trim() === '')) continue;
        draftRows.push(row);
      }
    };
    for (const p of extracted.pages) {
      if (p.unreadable === 'scanned') {
        const ocrRuns = p.image ? ocr(p.image, p.mediaBox) : null;
        if (ocrRuns && ocrRuns.length) {
          ocrPages += 1;
          allRuns.push(...ocrRuns);
          if (docOrderNo == null) docOrderNo = extractDocOrderNo(ocrRuns);
          const table = extractOrderTable(ocrRuns);
          if (table) takeTable(table); else carry = null;
        } else {
          scannedPages += 1;
        }
        continue;
      }
      if (p.unreadable === 'no-cmap') { noCmapPages += 1; continue; }
      allRuns.push(...p.runs);
      if (docOrderNo == null) docOrderNo = extractDocOrderNo(p.runs);
      const table = extractOrderTable(p.runs);
      if (!table) { carry = null; continue; }
      takeTable(table);
    }
    const flat = fold(allRuns.filter((r) => r.text).map((r) => r.text).join(' '));
    const customerGuess = detectPdfCustomer(flat);
    // Belgenin KENDI siparis numarasi (tablo İÇİNDE tekrar eden bir sütun DEĞİL, sayfa üst metadata
    // bloğunda BİR KEZ yazılan müşteri PO'su — 2026-11-19, kullanıcı isteği: "bu pdflerde sipariş numarası
    // var ya onu da mikroya gönderirken belge numarası kısmına yazacağız") — satırın KENDİ custOrderNo'su
    // (tablo içi "Sipariş No" sütunu, ör. e-posta tablosundaki MÜŞTERİ SİP. NO) varsa ONA DOKUNULMAZ, yalnız
    // boş olan satırlar bununla doldurulur. `custOrderNo` zaten `sip_belgeno` olarak Mikro'ya gönderiliyordu
    // (routes.js'teki mevcut wiring) — eksik olan yalnızca BU ÇIKARIMDI.
    if (docOrderNo) for (const row of draftRows) if (!row.custOrderNo) row.custOrderNo = docOrderNo;

    const warnings = [];
    if (ocrPages > 0) warnings.push(`${ocrPages} sayfa TARANMIŞ GÖRÜNTÜDEN OCR (Tesseract) ile okundu — otomatik çıkarım kesin değildir, elle kontrol edin.`);
    if (scannedPages > 0) warnings.push(`${scannedPages} sayfa taranmış görüntü okunamadı (Tesseract kurulu değil ya da OCR başarısız) — elle girilmeli.`);
    if (noCmapPages > 0) warnings.push(`${noCmapPages} sayfanın yazı tipi çözülemedi.`);
    if (tablePages === 0 && scannedPages === 0 && ocrPages === 0 && noCmapPages === 0) warnings.push('Tabloya benzer bir yapı bulunamadı; elle kontrol edin.');
    const warning = warnings.length ? warnings.join(' ') : null;

    const batchId = this.#insertBatch({ source: 'pdf', kind, filename, customerGuess, pageCount: extracted.pages.length, warning, by });
    draftRows.forEach((row, i) => this.#insertLine(batchId, i + 1, row, { kind }));
    // Metinden musteri bulunamadiysa (detectPdfCustomer -> null) urun kodu sonundaki 3 haneden YEDEK tahmin.
    if (!customerGuess) {
      const guessed = this.#guessCustomerFromProducts(batchId);
      if (guessed) this.db.prepare('UPDATE incoming_batches SET customer_guess = ? WHERE id = ?').run(guessed, batchId);
    }
    return this.getBatch(batchId);
  }

  /**
   * E-posta gövdesindeki HTML tablodan taslak sipariş satırları çıkarır (bkz. dosya başı: gerçek ham
   * HTML ile DENENMEDİ). Mikro'ya HİÇBİR ŞEY YAZILMAZ.
   * @param {string} html @param {{filename?:string, kind?:('yeni'|'revizyon'), by?:string}} [opts]
   */
  importEmailTable(html, { filename = null, kind = 'yeni', by = null } = {}) {
    if (!BATCH_KINDS.includes(kind)) throw new PlanningError('Geçersiz tür (yeni|revizyon).');
    const draftRows = parseEmailTable(html);
    const warning = draftRows === null ? 'Tabloda tanınan bir başlık satırı bulunamadı; elle kontrol edin.' : null;
    const batchId = this.#insertBatch({ source: 'email-table', kind, filename, customerGuess: null, pageCount: null, warning, by });
    (draftRows ?? []).forEach((row, i) => this.#insertLine(batchId, i + 1, row, { kind }));
    // E-posta tablosunun kendi metninden musteri hic cikarilmiyor (CUSTOMER_SIGNS yalniz PDF icin); urun
    // kodu sonundaki 3 haneden tahmin et (bkz. #guessCustomerFromProducts).
    const guessed = this.#guessCustomerFromProducts(batchId);
    if (guessed) this.db.prepare('UPDATE incoming_batches SET customer_guess = ? WHERE id = ?').run(guessed, batchId);
    return this.getBatch(batchId);
  }

  listBatches({ limit = 50 } = {}) {
    const rows = this.db.prepare('SELECT * FROM incoming_batches ORDER BY id DESC LIMIT ?').all(Math.min(Math.max(1, limit), 200));
    return rows.map((b) => {
      const counts = this.db.prepare(
        "SELECT status, COUNT(*) AS n FROM incoming_lines WHERE batch_id = ? GROUP BY status",
      ).all(b.id);
      const byStatus = Object.fromEntries(counts.map((c) => [c.status, Number(c.n)]));
      return this.#batchOut(b, byStatus);
    });
  }

  #batchOut(b, counts = {}) {
    return {
      id: b.id, source: b.source, kind: b.kind, filename: b.filename, customerGuess: b.customer_guess,
      pageCount: b.page_count, warning: b.warning, createdAt: b.created_at, createdBy: b.created_by,
      counts: { bekliyor: counts.bekliyor ?? 0, onaylandi: counts.onaylandi ?? 0, reddedildi: counts.reddedildi ?? 0 },
    };
  }

  #lineOut(r) {
    return {
      id: r.id, rowNo: r.row_no, rawCode: r.raw_code, rawDescription: r.raw_description, rawQty: r.raw_qty, rawDeliveryDate: r.raw_delivery_date,
      rawPrice: r.raw_price, custOrderNo: r.cust_order_no, qty: r.qty, price: r.price, deliveryDate: r.delivery_date,
      matchedCodeKey: r.matched_code_key, matchedStockCode: r.matched_stock_code, matchedName: r.matched_name,
      matchStatus: r.match_status, candidateCount: r.candidate_count,
      isRevision: !!r.is_revision, revisionType: r.revision_type, revisionRaw: r.revision_raw,
      existingLineId: r.existing_line_id, existingQty: r.existing_qty, existingDueDate: r.existing_due_date,
      status: r.status, decidedAt: r.decided_at, decidedBy: r.decided_by,
    };
  }

  /** Tek bir taslak satır (Mikro'ya gönderme önizlemesi gibi, batch'in tamamını çekmeden tek satır gereken yerler için). */
  getLine(id) {
    const r = this.db.prepare('SELECT * FROM incoming_lines WHERE id = ?').get(Number(id));
    if (!r) throw new PlanningError('Satır bulunamadı.', 404);
    return this.#lineOut(r);
  }

  getBatch(id) {
    const b = this.db.prepare('SELECT * FROM incoming_batches WHERE id = ?').get(id);
    if (!b) throw new PlanningError('Taslak bulunamadı.', 404);
    const lines = this.db.prepare('SELECT * FROM incoming_lines WHERE batch_id = ? ORDER BY row_no').all(id).map((r) => this.#lineOut(r));
    const counts = { bekliyor: 0, onaylandi: 0, reddedildi: 0 };
    for (const l of lines) counts[l.status] += 1;
    return { ...this.#batchOut(b, counts), lines };
  }

  /**
   * Bekleyen bir satırın çıkarılmış alanlarını elle düzeltir (onaylamadan/reddetmeden ÖNCE) — "taslak, kesinlik
   * iddia etmez" ilkesinin devamı: hiçbir alan otomatik çıkarımın kalıcı/kesin hali değildir, Mikro'ya gitmeden
   * önce HER ZAMAN düzeltilebilir (özellikle fiyat: PDF'ten çıkarılan değer bazı belgelerde iki sayının art arda
   * gelmesinden ya da hiç bulunamamasından kaynaklı yanlış/boş çıkabilir). Yalnız GÖNDERİLEN alanlar değişir;
   * karara bağlanmış (onaylandı/reddedildi) satır değişmez (409).
   * @param {{qty?, deliveryDate?, custOrderNo?, price?, stockCode?, by?}} patch
   */
  updateLine(id, { qty, deliveryDate, custOrderNo, price, stockCode, by = null } = {}) {
    const r = this.db.prepare('SELECT * FROM incoming_lines WHERE id = ?').get(id);
    if (!r) throw new PlanningError('Satır bulunamadı.', 404);
    if (r.status !== 'bekliyor') throw new PlanningError('Karara bağlanmış bir satır düzenlenemez.', 409);
    const nextQty = qty === undefined ? r.qty : number(qty, 'Adet', { max: 10_000_000, integer: true });
    const nextDelivery = deliveryDate === undefined ? r.delivery_date : day(deliveryDate, 'Teslim tarihi');
    const nextCustOrderNo = custOrderNo === undefined ? r.cust_order_no : text(custOrderNo, 'Müşteri sipariş no', 50);
    const nextPrice = price === undefined ? r.price : number(price, 'Fiyat', { max: 10_000_000, allowZero: true });
    let codeKey = r.matched_code_key; let stock = r.matched_stock_code; let name = r.matched_name;
    let matchStatus = r.match_status; let candidateCount = r.candidate_count;
    if (stockCode !== undefined) {
      if (stockCode) {
        const p = this.planning.db.getProduct(foldTr(stockCode));
        if (!p) throw new PlanningError(`Ürün bulunamadı: ${stockCode}`, 404);
        codeKey = p.codeKey; stock = p.stockCode; name = p.name; matchStatus = 'tam'; candidateCount = 1;
      } else {
        codeKey = null; stock = null; name = null; matchStatus = 'yok'; candidateCount = 0;
      }
    }
    this.db.prepare(
      `UPDATE incoming_lines SET qty=?, delivery_date=?, cust_order_no=?, price=?,
          matched_code_key=?, matched_stock_code=?, matched_name=?, match_status=?, candidate_count=? WHERE id=?`,
    ).run(nextQty, nextDelivery, nextCustOrderNo, nextPrice, codeKey, stock, name, matchStatus, candidateCount, id);
    return this.#lineOut(this.db.prepare('SELECT * FROM incoming_lines WHERE id = ?').get(id));
  }

  /** Eşleşmeyen (`matchStatus !== 'tam'`) ya da belirsiz bir satır elle düzeltilip onaylanabilir. */
  approveLine(id, { stockCode = null, by = null } = {}) {
    const r = this.db.prepare('SELECT * FROM incoming_lines WHERE id = ?').get(id);
    if (!r) throw new PlanningError('Satır bulunamadı.', 404);
    if (r.status !== 'bekliyor') throw new PlanningError('Bu satır zaten karara bağlanmış.', 409);
    let codeKey = r.matched_code_key; let stock = r.matched_stock_code; let name = r.matched_name;
    if (stockCode) {
      const p = this.planning.db.getProduct(foldTr(stockCode));
      if (!p) throw new PlanningError(`Ürün bulunamadı: ${stockCode}`, 404);
      codeKey = p.codeKey; stock = p.stockCode; name = p.name;
    }
    if (!codeKey) throw new PlanningError('Önce bir ürün kartı eşleştirin (stockCode).', 400, 'no-product');
    // stockCode elle verildiyse artik GERCEKTEN eslesmis sayilir ('tam'); yoksa match_status onceki haliyle kalir
    // (ilk yazimda burada hic guncellenmiyordu: elle eslenip onaylanan satir "esmesmedi" cipi ile kaliyordu - tarayicida bulundu).
    const matchStatus = stockCode ? 'tam' : r.match_status;
    this.db.prepare(
      "UPDATE incoming_lines SET status='onaylandi', matched_code_key=?, matched_stock_code=?, matched_name=?, match_status=?, decided_at=?, decided_by=? WHERE id=?",
    ).run(codeKey, stock, name, matchStatus, Date.now(), by ?? null, id);
    return this.#lineOut(this.db.prepare('SELECT * FROM incoming_lines WHERE id = ?').get(id));
  }

  rejectLine(id, { by = null } = {}) {
    const r = this.db.prepare('SELECT * FROM incoming_lines WHERE id = ?').get(id);
    if (!r) throw new PlanningError('Satır bulunamadı.', 404);
    if (r.status !== 'bekliyor') throw new PlanningError('Bu satır zaten karara bağlanmış.', 409);
    this.db.prepare("UPDATE incoming_lines SET status='reddedildi', decided_at=?, decided_by=? WHERE id=?").run(Date.now(), by ?? null, id);
    return this.#lineOut(this.db.prepare('SELECT * FROM incoming_lines WHERE id = ?').get(id));
  }

  /**
   * Bir taslağın ONAYLANMIŞ satırları — "hepsi TEK siparişte Mikro'ya gönder" için (2026-11-19, kullanıcı isteği:
   * "bunların hepsi tek sipariş içinde... tek bir siparişte mikroya yaz"). `mikroOrders.previewCreateOrder()`
   * zaten çok kalemli TEK evrak kuruyordu (`items[]`, bkz. `mikro-order.js` dosya başı — gerçek HAVANA/SAS0003812
   * testinde 4 kalemle doğrulandı); bu yalnız o kapasiteyi BATCH düzeyinde (tek satır değil, taslağın TÜM onaylı
   * satırları) kullanıma açan okuma yardımcısıdır — Mikro'ya hiçbir şey yazmaz.
   * Hiç onaylı satır yoksa ya da onaylı bir satır ürüne eşli DEĞİLSE (olmaması gerekir — `approveLine` zaten
   * ürünsüz onaya izin vermiyor, ama veri bütünlüğü için yine de denetlenir) hata fırlatır.
   */
  approvedLinesForOrder(batchId) {
    const b = this.getBatch(batchId);
    const approved = b.lines.filter((l) => l.status === 'onaylandi');
    if (approved.length === 0) throw new PlanningError('Önce en az bir satırı onaylayın.', 400, 'no-lines');
    const missing = approved.find((l) => !l.matchedStockCode);
    if (missing) throw new PlanningError(`Satır #${missing.rowNo} bir ürüne eşli değil.`, 400, 'no-product');
    return { batch: b, lines: approved };
  }
}
