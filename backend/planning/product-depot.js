/**
 * Bitmiş ürün depo akışı (kullanıcının 2026-11-03 isteğinin ikinci parçası; birinci parça program kütüphanesi
 * bölünmesiydi, ayrı commit). Amaç: CNC Telemetri'den yakalanan üretim/paketleme verisiyle Mikro'da iki fiş:
 *
 *   İş emri BİTİNCE   -> Merkez (1) -> Geçici (2)   ÜRETİLEN adet kadar (üretim henüz paketlenmedi, "üretimde" bekliyor)
 *   PAKETLENİNCE      -> Geçici (2) -> Merkez (1)   PAKETLENEN adet kadar (artık sevke hazır, merkez depoya döner)
 *
 * İKİSİ DE "Depolar Arası Sevk Fişi" (evraktip=2/tip=2/cins=6) — hammaddenin Merkez<->Rezerv transferiyle AYNI
 * evrak türü (bkz. mikro-stock.js `previewTransfer`), yalnız stok kodu ÜRÜNÜN kendi Alen kodu ve miktar ADET.
 *
 * BİLEREK MANUEL VE PARÇALI (hammaddenin "Mikro sarfiyat fişi" ekranındaki `markFis`/`clearFis` deseniyle aynı
 * felsefe): iş emri bitirmek ve kasa paketlemek ASLA Mikro'ya bağımlı değildir — Mikro ulaşılamaz/yazma kapalıysa
 * bile iş emri biter, kasa paketlenir; depo transferi AYRI, yeniden denenebilir bir adımdır. Paketleme adedi
 * ZAMANLA ARTABİLİR (paketleme formu bir vardiya boyunca doldurulur) ve DÜZELTİLEBİLİR: bu yüzden "paketlenen
 * toplam - şimdiye kadar gönderilen toplam" farkı (DELTA) gönderilir, tek seferlik sabit bir adet değil — aynı
 * iş emrine birden çok küçük sevk fişi (gün gün paketlendikçe) yazılabilir, hiçbiri ikinci kez gönderilmez.
 *
 * Kaynak miktarlar: üretilen adet = `work_orders.result_json.produced` (telemetriden dondurulmuş SONUÇ, bkz.
 * planning.js `finishWorkOrder`); paketlenen adet = `packing.forWorkOrder(woNo).pieces` (EYS.FR.007 paketleme
 * formu toplamı) — planning.js'in kendi "gerçek tüketim" hesabının (satır ~792) ZATEN kullandığı AYNI kaynak,
 * burada ikinci bir "gerçek paketlenen" tanımı İCAT EDİLMEDİ.
 *
 * GERÇEK AĞA HİÇ YAZILMADI (2026-11-03, aynı ağda değiliz): `mikro-stock.js`'in previewTransfer'ı (hammadde,
 * aynı evrak türü) gerçek Mikro'ya karşı doğrulandı (2026-10-29); bu modül onu bitmiş ürüne uyarlıyor ama kendisi
 * sahada denenmedi. Önceki turlardaki kural geçerli: `MIKRO_WRITE_ENABLED=1` olmadan hiçbir ağ isteği YAPILMAZ.
 */
import { PlanningError } from './errors.js';

/** DEPOLAR (gerçek, SqlVeriOkuV2 ile salt okuma doğrulandı, CLAUDE.md "G aşaması"): 1=MERKEZ DEPO, 2=GEÇİCİ DEPO. */
export const MERKEZ_DEPO_NO = 1;
export const GECICI_DEPO_NO = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS product_depot_transfers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  wo_no      TEXT    NOT NULL,
  kind       TEXT    NOT NULL,   -- 'bitis' (Merkez->Gecici) | 'paketleme' (Gecici->Merkez)
  stock_code TEXT    NOT NULL,
  qty        INTEGER NOT NULL,
  from_depot INTEGER NOT NULL,
  to_depot   INTEGER NOT NULL,
  status     TEXT    NOT NULL,   -- 'basarili' | 'basarisiz'
  evrak_seri TEXT,
  evrak_sira TEXT,
  error      TEXT,
  at         INTEGER NOT NULL,
  by_user    TEXT
);
CREATE INDEX IF NOT EXISTS idx_depot_transfers_wo ON product_depot_transfers (wo_no, kind);
`;

const rowOut = (r) => ({
  id: Number(r.id), kind: r.kind, stockCode: r.stock_code, qty: Number(r.qty), fromDepot: Number(r.from_depot), toDepot: Number(r.to_depot),
  status: r.status, evrakSeri: r.evrak_seri, evrakSira: r.evrak_sira, error: r.error, at: Number(r.at), by: r.by_user,
});

export class ProductDepot {
  /** @param {{planning: import('./planning.js').Planning}} deps */
  constructor({ planning }) {
    this.planning = planning;
    this.db = planning.db.db;
    this.db.exec(SCHEMA);
  }

  #history(woNo, kind) {
    return this.db.prepare('SELECT * FROM product_depot_transfers WHERE wo_no = ? AND kind = ? ORDER BY id').all(woNo, kind).map(rowOut);
  }

  #sentTotal(woNo, kind) {
    return this.#history(woNo, kind).filter((r) => r.status === 'basarili').reduce((s, r) => s + r.qty, 0);
  }

  #insert({ woNo, kind, stockCode, qty, fromDepot, toDepot, status, evrakSeri = null, evrakSira = null, error = null, by, now }) {
    this.db.prepare(
      `INSERT INTO product_depot_transfers (wo_no, kind, stock_code, qty, from_depot, to_depot, status, evrak_seri, evrak_sira, error, at, by_user)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(woNo, kind, stockCode, qty, fromDepot, toDepot, status, evrakSeri, evrakSira, error, now, by ?? null);
  }

  /**
   * HAM iş emri (planning.js `getWorkOrder()`'ın TAMAMI değil — bu sınıf O FONKSİYONUN İÇİNDEN de çağrılır
   * (sonucu `depot` alanı olarak eklenir), bu yüzden `this.planning.getWorkOrder()` çağırmak SONSUZ DÖNGÜ
   * olurdu; yalnız `status`/`result`/`stockCode` ve paketleme toplamı gerekiyor, ikisi de dogrudan erisilebilir.
   */
  #load(woNo) {
    const w = this.planning.db.getWorkOrder(String(woNo));
    if (!w) throw new PlanningError(`İş emri bulunamadı: ${woNo}`, 404);
    return { w, packedTotal: this.planning.packing.forWorkOrder(w.no).pieces };
  }

  /** İş emri için depo akışı durumu: ne kadarı Geçici'ye aktarılmaya, ne kadarı Merkez'e sevk edilmeye hazır. */
  statusFor(woNo) {
    const { w, packedTotal } = this.#load(woNo);
    const produced = w.status === 'bitti' ? (w.result?.produced ?? 0) : 0;
    const bitisSent = this.#sentTotal(w.no, 'bitis');
    const paketlemeSent = this.#sentTotal(w.no, 'paketleme');
    return {
      stockCode: w.stockCode,
      configured: this.planning.mikroStock.configured(),
      writeEnabled: this.planning.mikroStock.writeEnabled(),
      bitis: { history: this.#history(w.no, 'bitis'), produced, sent: bitisSent, pending: w.status === 'bitti' ? Math.max(0, produced - bitisSent) : 0 },
      paketleme: { history: this.#history(w.no, 'paketleme'), packedTotal, sent: paketlemeSent, pending: Math.max(0, packedTotal - paketlemeSent) },
    };
  }

  /** İş emri bitince: Merkez -> Geçici, ÜRETİLEN adedin henüz gönderilmemiş kısmı (normalde tüm adet, tek seferde). */
  async sendFinishTransfer(woNo, { by = null, now = Date.now() } = {}) {
    const { w } = this.#load(woNo);
    if (w.status !== 'bitti') throw new PlanningError('Yalnız biten iş emri için Geçici depoya aktarılabilir.', 409, 'bad-status');
    const produced = w.result?.produced ?? 0;
    const qty = produced - this.#sentTotal(w.no, 'bitis');
    if (qty <= 0) {
      throw new PlanningError(produced === 0 ? 'Hiç parça üretilmedi: aktarılacak adet yok.' : 'Bu iş emrinin üretimi zaten Geçici depoya aktarıldı.', 409, 'nothing-to-send');
    }
    return this.#send({
      woNo: w.no, kind: 'bitis', stockCode: w.stockCode, qty, fromDepot: MERKEZ_DEPO_NO, toDepot: GECICI_DEPO_NO,
      note: `İş emri ${w.no} bitti (${produced} adet üretildi)`, by, now,
    });
  }

  /** Paketlenince: Geçici -> Merkez, paketleme formunda toplanan (henüz gönderilmemiş) DELTA adet. */
  async sendPackingTransfer(woNo, { by = null, now = Date.now() } = {}) {
    const { w, packedTotal } = this.#load(woNo);
    const qty = packedTotal - this.#sentTotal(w.no, 'paketleme');
    if (qty <= 0) {
      throw new PlanningError(packedTotal === 0 ? 'Henüz paketlenmiş adet yok.' : 'Son paketleme bu iş emri için zaten Merkez depoya sevk edildi.', 409, 'nothing-to-send');
    }
    return this.#send({
      woNo: w.no, kind: 'paketleme', stockCode: w.stockCode, qty, fromDepot: GECICI_DEPO_NO, toDepot: MERKEZ_DEPO_NO,
      note: `İş emri ${w.no} paketleme sevki (toplam ${packedTotal} adet paketlendi)`, by, now,
    });
  }

  async #send({ woNo, kind, stockCode, qty, fromDepot, toDepot, note, by, now }) {
    const preview = this.planning.mikroStock.previewProductTransfer({ fromDepotNo: fromDepot, toDepotNo: toDepot, stockCode, qty, note });
    if (!preview.writeEnabled) {
      throw new PlanningError(
        'Mikro yazma şu an kapalı (inceleme/onay aşaması ya da ağ dışı): yönetici ile birlikte doğrulanıp MIKRO_WRITE_ENABLED açılmadan hiçbir şey Mikro\'ya gönderilmez.',
        409, 'mikro-write-disabled',
      );
    }
    try {
      const result = await this.planning.mikroStock.send(preview);
      const evrak = result?.Data?.list?.[0] ?? {};
      this.#insert({ woNo, kind, stockCode, qty, fromDepot, toDepot, status: 'basarili', evrakSeri: evrak.evrakno_seri ?? null, evrakSira: evrak.evrakno_sira ?? null, by, now });
      this.planning.db.addWorkOrderEvent(
        woNo, kind === 'bitis' ? 'gecici-depoya-aktarildi' : 'merkez-depoya-sevk-edildi',
        `${qty} adet${evrak.evrakno_seri ? ` · Mikro ${evrak.evrakno_seri}-${evrak.evrakno_sira}` : ''}`, { by, now },
      );
      return this.statusFor(woNo);
    } catch (err) {
      this.#insert({ woNo, kind, stockCode, qty, fromDepot, toDepot, status: 'basarisiz', error: err.message, by, now });
      throw err;
    }
  }
}
