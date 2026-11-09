/**
 * KARANTİNA DEPOSU — Mikro entegrasyonu (2026-11-09, kullanıcı isteği). Hurda Girişi'ndeki (quarantine.js) bir
 * karantina kaydı bir iş emrine bağlıysa, bu modül Mikro'daki **KARANTİNA DEPO (dep_no=5)** ile olan hareketleri
 * yönetir — "Bitmiş ürün depo akışı" (`product-depot.js`) ile BİREBİR AYNI felsefe ve altyapı (`mikro-stock.js`'in
 * `previewProductTransfer`/`previewProductVirman`'ı, aynı iki kapı — `PRODUCT_DEPOT_ENABLED` + `MIKRO_WRITE_ENABLED`
 * — "başarısız deneme geçmişe yazılır, delta ile yeniden denenir" deseni); yeni bir Mikro yazma mekanizması İCAT
 * EDİLMEDİ, yalnız KARANTİNA DEPO'yu içine katan kardeş bir tablo/sınıf.
 *
 *   Miktar netleşince (tartılınca)  -> Karantina (5) İÇİNDE GİRİŞ virmanı   (fiziksel: parça karantinaya "girdi")
 *   Tashih: hurda çıkan kısım       -> Karantina (5) -> Hurda (3) TRANSFER  (iş emri durumundan BAĞIMSIZ, HER ZAMAN)
 *   Tashih: OK çıkan kısım          -> Karantina (5) -> Geçici (2) TRANSFER (yalnız iş emri ZATEN `bitti` ise HEMEN;
 *                                                                            üretimdeyken ERTELENİR, bkz. `pendingOkForWorkOrder`/`flushPendingOk`)
 *
 * ERTELEME (kullanıcı kararı): iş emri hâlâ `uretimde` iken tashih OK sonucu gelirse Mikro'ya HEMEN gidilmez —
 * telemetri/parça sayacına (salt okunur boru hattı) KESİNLİKLE dokunulmaz, yalnız iş emri geçmişine not düşülür.
 * Bu "ertelenmiş OK" miktarı YENİ bir sayaç/alan olarak SAKLANMAZ: `quarantine_corrections.ok_qty` (zaten var) ile
 * bu modülün kendi gönderim geçmişi arasındaki FARK olarak HER ZAMAN TÜRETİLİR (`pendingOkForWorkOrder`) — aynı
 * `product-depot.js`'in "paketlenen - gönderilen" delta felsefesi. İş emri bitince `planning.js`'in
 * `finishWorkOrder()`'ı `flushPendingOk`'u fire-and-forget çağırır; bitmiş bir iş emrine sonradan eklenen tashih
 * zaten `addCorrection`'ın kendi "iş emri bitti mi" kontrolünden HEMEN geçer, ayrı bir yakalama GEREKMEZ.
 *
 * `pendingQtyForWorkOrder`: iş emrine bağlı karantina kayıtlarının HİÇ tashih sonucu belirlenmemiş (ne OK ne hurda)
 * kısmı — `product-depot.js`'in `sendFinishTransfer`'ı bunu üretilen adetten DÜŞER (karantinadaki parçalar henüz
 * Geçici'ye "doğmaz"; Karantina'dan ayrı bir TRANSFER'le gelirler, iki kez sayılmasınlar diye).
 */
import { PlanningError } from './errors.js';
import { GECICI_DEPO_NO } from './product-depot.js';

/** DEPOLAR (gerçek, SqlVeriOkuV2 ile salt okuma doğrulandı, 2026-11-09): 3=HURDA DEPO, 5=KARANTİNA DEPO. */
export const HURDA_DEPO_NO = 3;
export const KARANTINA_DEPO_NO = 5;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS quarantine_depot_transfers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  quarantine_id  INTEGER NOT NULL REFERENCES quarantine_entries(id),
  wo_no          TEXT,
  kind           TEXT    NOT NULL,   -- 'giris' (Karantina icinde GIRIS virmani) | 'ok' (Karantina->Gecici TRANSFER) | 'hurda' (Karantina->Hurda TRANSFER)
  stock_code     TEXT    NOT NULL,
  qty            INTEGER NOT NULL,
  from_depot     INTEGER NOT NULL,
  to_depot       INTEGER NOT NULL,
  status         TEXT    NOT NULL,   -- 'basarili' | 'basarisiz'
  evrak_seri     TEXT,
  evrak_sira     TEXT,
  error          TEXT,
  at             INTEGER NOT NULL,
  by_user        TEXT
);
CREATE INDEX IF NOT EXISTS idx_qdt_entry ON quarantine_depot_transfers (quarantine_id, kind);
CREATE INDEX IF NOT EXISTS idx_qdt_wo ON quarantine_depot_transfers (wo_no, kind);
`;

const rowOut = (r) => ({
  id: Number(r.id), kind: r.kind, stockCode: r.stock_code, qty: Number(r.qty), fromDepot: Number(r.from_depot), toDepot: Number(r.to_depot),
  status: r.status, evrakSeri: r.evrak_seri, evrakSira: r.evrak_sira, error: r.error, at: Number(r.at), by: r.by_user,
});

export class QuarantineDepot {
  /** @param {{planning: import('./planning.js').Planning, enabled?: () => boolean}} deps `enabled`: product-depot.js ile AYNI kapı (ayrı env değişkeni İCAT EDİLMEDİ). */
  constructor({ planning, enabled = () => process.env.PRODUCT_DEPOT_ENABLED === '1' }) {
    this.planning = planning;
    this.enabled = enabled;
    this.db = planning.db.db;
    this.db.exec(SCHEMA);
  }

  #entry(quarantineId) {
    const r = this.db.prepare('SELECT id, wo_no, stock_code, product_label, batch_qty FROM quarantine_entries WHERE id = ?').get(Number(quarantineId));
    if (!r) throw new PlanningError('Karantina kaydı bulunamadı.', 404);
    return { id: Number(r.id), woNo: r.wo_no, stockCode: r.stock_code || r.product_label, batchQty: r.batch_qty == null ? null : Number(r.batch_qty) };
  }

  #history(quarantineId, kind) {
    return this.db.prepare('SELECT * FROM quarantine_depot_transfers WHERE quarantine_id = ? AND kind = ? ORDER BY id').all(Number(quarantineId), kind).map(rowOut);
  }

  #sentTotal(quarantineId, kind) {
    return this.#history(quarantineId, kind).filter((r) => r.status === 'basarili').reduce((s, r) => s + r.qty, 0);
  }

  #insert({ quarantineId, woNo, kind, stockCode, qty, fromDepot, toDepot, status, evrakSeri = null, evrakSira = null, error = null, by, now }) {
    this.db.prepare(
      `INSERT INTO quarantine_depot_transfers (quarantine_id, wo_no, kind, stock_code, qty, from_depot, to_depot, status, evrak_seri, evrak_sira, error, at, by_user)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(Number(quarantineId), woNo ?? null, kind, stockCode, qty, fromDepot, toDepot, status, evrakSeri, evrakSira, error, now, by ?? null);
  }

  /** Hurda Girişi ekranının "Hurda deposu" sekmesi: Karantina'dan Hurda'ya GERÇEKTEN gönderilmiş (başarılı) transferler. `from`/`to`: 'yyyy-aa-gg'. */
  listHurda({ from = '', to = '', limit = 300 } = {}) {
    const conds = ["t.kind = 'hurda'", "t.status = 'basarili'"];
    const args = [];
    if (from) { conds.push('t.at >= ?'); args.push(new Date(`${from}T00:00:00`).getTime()); }
    if (to) { conds.push('t.at <= ?'); args.push(new Date(`${to}T23:59:59.999`).getTime()); }
    const rows = this.db.prepare(
      `SELECT t.*, e.product_label, e.issue FROM quarantine_depot_transfers t
       LEFT JOIN quarantine_entries e ON e.id = t.quarantine_id
       WHERE ${conds.join(' AND ')} ORDER BY t.id DESC LIMIT ?`,
    ).all(...args, Math.min(Math.max(Number(limit) || 300, 1), 1000));
    return rows.map((r) => ({ ...rowOut(r), quarantineId: Number(r.quarantine_id), productLabel: r.product_label, issue: r.issue }));
  }

  /** Karantina kaydının detay ekranında gösterilecek özet: GİRİŞ/OK/Hurda geçmişi + bekleyen miktarlar. */
  statusFor(quarantineId) {
    const e = this.#entry(quarantineId);
    const girisSent = this.#sentTotal(e.id, 'giris');
    const okSent = this.#sentTotal(e.id, 'ok');
    const hurdaSent = this.#sentTotal(e.id, 'hurda');
    const resolved = this.#resolvedQty(e.id); // tashih ile OK+hurda olarak belirlenen toplam (qdt'den bagimsiz, corrections'tan)
    return {
      configured: this.planning.mikroStock.configured(),
      writeEnabled: this.planning.mikroStock.writeEnabled(),
      flowEnabled: this.enabled(),
      giris: { history: this.#history(e.id, 'giris'), batchQty: e.batchQty, sent: girisSent, pending: Math.max(0, (e.batchQty ?? 0) - girisSent) },
      ok: { history: this.#history(e.id, 'ok'), sent: okSent },
      hurda: { history: this.#history(e.id, 'hurda'), sent: hurdaSent },
      stillInQuarantine: Math.max(0, girisSent - resolved.ok - resolved.hurda),
    };
  }

  /** Bu karantina kaydının tashih denemelerinden (quarantine_corrections) toplanan OK/hurda toplamı — Mikro'ya ne kadar gönderildiğinden BAĞIMSIZ, yalnız tashih sonucudur. */
  #resolvedQty(quarantineId) {
    const r = this.db.prepare('SELECT COALESCE(SUM(ok_qty),0) AS ok, COALESCE(SUM(scrap_qty),0) AS hurda FROM quarantine_corrections WHERE quarantine_id = ?').get(Number(quarantineId));
    return { ok: Number(r.ok), hurda: Number(r.hurda) };
  }

  /**
   * Miktar netleşince (`batchQty` set/değişince, `quarantine.js`'ten çağrılır): Karantina'ya henüz GİRİŞ
   * yapılmamış delta'yı gönderir. `batchQty` boş/0 ya da delta ≤0 ise sessizce no-op (hata FIRLATMAZ — otomatik
   * tetiklendiği için başarısızlık beklenmedik bir yerde patlamamalı; çağıran zaten try/catch ile sarıyor ama
   * "gönderilecek bir şey yok" durumu hata değildir).
   */
  async sendGiris(quarantineId, { by = null, now = Date.now() } = {}) {
    const e = this.#entry(quarantineId);
    if (!e.woNo || e.batchQty == null || e.batchQty <= 0) return null;
    const qty = e.batchQty - this.#sentTotal(e.id, 'giris');
    if (qty <= 0) return null;
    return this.#send({
      quarantineId: e.id, woNo: e.woNo, kind: 'giris', stockCode: e.stockCode, qty, fromDepot: KARANTINA_DEPO_NO, toDepot: KARANTINA_DEPO_NO,
      preview: this.planning.mikroStock.previewProductVirman({ depotNo: KARANTINA_DEPO_NO, stockCode: e.stockCode, qty, direction: 'giren', note: `Karantina girişi (iş emri ${e.woNo})` }),
      by, now,
    });
  }

  /** Tashih sonucu OK çıkan kısım: Karantina -> Geçici TRANSFER. `qty` sabit (tashih satırından gelen okQty). */
  async sendOk(quarantineId, qty, { by = null, now = Date.now() } = {}) {
    const e = this.#entry(quarantineId);
    if (!(qty > 0)) return null;
    return this.#send({
      quarantineId: e.id, woNo: e.woNo, kind: 'ok', stockCode: e.stockCode, qty, fromDepot: KARANTINA_DEPO_NO, toDepot: GECICI_DEPO_NO,
      preview: this.planning.mikroStock.previewProductTransfer({ fromDepotNo: KARANTINA_DEPO_NO, toDepotNo: GECICI_DEPO_NO, stockCode: e.stockCode, qty, note: `Tashih OK (iş emri ${e.woNo})` }),
      by, now,
    });
  }

  /** Tashih sonucu hurda çıkan kısım: Karantina -> Hurda TRANSFER. İş emri durumundan BAĞIMSIZ, her zaman çağrılır. */
  async sendHurda(quarantineId, qty, { by = null, now = Date.now() } = {}) {
    const e = this.#entry(quarantineId);
    if (!(qty > 0)) return null;
    return this.#send({
      quarantineId: e.id, woNo: e.woNo, kind: 'hurda', stockCode: e.stockCode, qty, fromDepot: KARANTINA_DEPO_NO, toDepot: HURDA_DEPO_NO,
      preview: this.planning.mikroStock.previewProductTransfer({ fromDepotNo: KARANTINA_DEPO_NO, toDepotNo: HURDA_DEPO_NO, stockCode: e.stockCode, qty, note: `Tashih hurda (iş emri ${e.woNo})` }),
      by, now,
    });
  }

  /** Bu iş emrine bağlı karantina kayıtlarının HİÇ tashih sonucu belirlenmemiş (ne OK ne hurda) kısmı. `product-depot.js`'in `sendFinishTransfer`'ı bunu üretilen adetten düşer. */
  pendingQtyForWorkOrder(woNo) {
    const entries = this.db.prepare('SELECT id, batch_qty FROM quarantine_entries WHERE wo_no = ?').all(String(woNo));
    let pending = 0;
    for (const e of entries) {
      if (e.batch_qty == null) continue;
      const resolved = this.#resolvedQty(e.id);
      pending += Math.max(0, Number(e.batch_qty) - resolved.ok - resolved.hurda);
    }
    return pending;
  }

  /** Bu iş emrine bağlı kayıtların tashihle OK çıkmış AMA henüz Karantina->Geçici gönderilmemiş kısmı (üretimdeyken OK çıkıp ertelenen). */
  pendingOkForWorkOrder(woNo) {
    const entries = this.db.prepare('SELECT id FROM quarantine_entries WHERE wo_no = ?').all(String(woNo));
    let pending = 0;
    for (const e of entries) pending += Math.max(0, this.#resolvedQty(e.id).ok - this.#sentTotal(e.id, 'ok'));
    return pending;
  }

  /**
   * İş emri `bitti` olur olmaz `planning.js#finishWorkOrder`'dan fire-and-forget çağrılır: üretimdeyken OK çıkıp
   * ertelenmiş (henüz Mikro'ya gönderilmemiş) her karantina kaydının kendi deltasını Karantina->Geçici gönderir.
   * Entry bazında çalışır (aynı iş emrine birden çok karantina kaydı bağlı olabilir, her biri kendi stok koduyla).
   */
  async flushPendingOk(woNo, { by = null, now = Date.now() } = {}) {
    const entries = this.db.prepare('SELECT id FROM quarantine_entries WHERE wo_no = ?').all(String(woNo));
    for (const e of entries) {
      const pending = Math.max(0, this.#resolvedQty(e.id).ok - this.#sentTotal(e.id, 'ok'));
      if (pending > 0) await this.sendOk(e.id, pending, { by, now }).catch(() => { /* gecmise zaten yazildi, bir sonraki cagri farki toplar */ });
    }
  }

  async #send({ quarantineId, woNo, kind, stockCode, qty, fromDepot, toDepot, preview, by, now }) {
    if (!this.enabled()) throw new PlanningError('Bitmiş ürün depo akışı (Karantina dahil) şu an kapalı: fabrika PC\'si/paketleme sahada kurulana kadar devre dışı bırakıldı.', 409, 'depot-flow-disabled');
    if (!preview.writeEnabled) throw new PlanningError('Mikro yazma şu an kapalı (inceleme/onay aşaması ya da ağ dışı): MIKRO_WRITE_ENABLED açılmadan hiçbir şey Mikro\'ya gönderilmez.', 409, 'mikro-write-disabled');
    try {
      const result = await this.planning.mikroStock.send(preview);
      const evrak = result?.Data?.list?.[0] ?? {};
      this.#insert({ quarantineId, woNo, kind, stockCode, qty, fromDepot, toDepot, status: 'basarili', evrakSeri: evrak.evrakno_seri ?? null, evrakSira: evrak.evrakno_sira ?? null, by, now });
      if (woNo) {
        const evrakRef = evrak.evrakno_sira != null && evrak.evrakno_sira !== '' ? ` · Mikro ${evrak.evrakno_seri ? `${evrak.evrakno_seri}-` : ''}${evrak.evrakno_sira}` : '';
        const label = kind === 'giris' ? 'karantina-girisi' : kind === 'ok' ? 'karantina-ok-aktarildi' : 'karantina-hurda-aktarildi';
        this.planning.db.addWorkOrderEvent(woNo, label, `${qty} adet${evrakRef}`, { by, now });
      }
      return this.statusFor(quarantineId);
    } catch (err) {
      this.#insert({ quarantineId, woNo, kind, stockCode, qty, fromDepot, toDepot, status: 'basarisiz', error: err.message, by, now });
      throw err;
    }
  }
}
