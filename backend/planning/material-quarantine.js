/**
 * HAMMADDE KARANTİNASI — Hammadde ekranında yeni bir sekme (2026-11-10, kullanıcı isteği): tedarikçi yanlış
 * hammadde gönderdiğinde, Merkez depodaki o miktar Karantina depoya (dep_no=5, `quarantine-depot.js`'teki
 * KARANTINA_DEPO_NO ile AYNI) aktarılır — Mikro'nun "Depolar Arası Sevk Fişi"yle AYNI mekanizma (`mikroStock.
 * previewTransfer`). Burada ayrı, kalıcı bir liste olarak izlenir. Tedarikçiye GERİ GÖNDERİLİNCE ("İade") Karantina
 * depodan bir SARF (stok virman, ÇIKAN) fişiyle TAMAMEN düşer (`mikroStock.previewVirman`) — Mikro'nun defterinden
 * çıkar, fiziksel olarak da fabrikadan ayrılıyor.
 *
 * İş emirlerine bağlı Karantina/Hurda akışından (`quarantine.js`/`quarantine-depot.js`) BİLEREK AYRI: o modül
 * ÜRETİMDE fark edilen hurda/uygunsuz PARÇAYI (bitmiş/yarı mamul, adet) izler; bu modül TESLİMATTA fark edilen
 * yanlış HAMMADDEYİ (kg) izler — ikisinin de hedefi aynı Mikro Karantina deposu (dep_no=5) olsa da kayıt/iş akışı
 * tamamen bağımsız, ortak bir tablo/kod PAYLAŞILMAZ (biri iş emrine bağlı parça sayımı, diğeri serbest bir
 * hammadde teslim alımı — ortak soyutlamak yapay olurdu).
 *
 * TEK, SABİT miktarlı kayıt (delta/kısmi gönderim YOK — `product-depot.js`/`quarantine-depot.js`'in "paketleme
 * zamanla artabilir" senaryosundan farklı: burada miktar "Karantinaya aktar" anında bilinir ve bir daha değişmez),
 * bu yüzden kendi ledger tablosu yerine durumu doğrudan kayıt satırında tutar — "her deneme (başarılı/başarısız)
 * kaydedilir, elle yeniden denenebilir" felsefesi AYNI, uygulaması daha basit.
 *
 * Kapı: yalnız `MIKRO_WRITE_ENABLED` (hammaddenin kendi mevcut "Depolar arası sevkiyat (Mikro)" dialoğuyla AYNI
 * kapı) — `PRODUCT_DEPOT_ENABLED` burada KULLANILMAZ: o kapının gerekçesi "fabrika PC'si/paketleme sahada değil",
 * bu özellik paketlemeyle ilgisiz, doğrudan ofisten kullanılan bir Hammadde ekranı özelliği.
 *
 * GERÇEK MİKRO'YA KARŞI HENÜZ DENENMEDİ (yalnız kod + testler) — ilk gerçek deneme yönetici ile birlikte
 * yapılmalı (bu projedeki HER gerçek Mikro yazma özelliğiyle aynı temkinli yaklaşım).
 */
import { PlanningError } from './errors.js';
import { text } from './fields.js';
import { kgAmount, stockCodeOf } from './mikro-stock.js';
import { MERKEZ_DEPO_NO } from './product-depot.js';
import { KARANTINA_DEPO_NO } from './quarantine-depot.js';

export const STATUS = Object.freeze(['aktarilamadi', 'karantinada', 'iade-edildi']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS material_quarantine (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  stock_code          TEXT    NOT NULL,
  stock_name          TEXT,
  kg                  REAL    NOT NULL,
  note                TEXT,
  status              TEXT    NOT NULL,   -- 'aktarilamadi' (henuz Karantinaya gitmedi) | 'karantinada' | 'iade-edildi'
  transfer_status     TEXT    NOT NULL,   -- 'basarili' | 'basarisiz'
  transfer_evrak_seri TEXT,
  transfer_evrak_sira TEXT,
  transfer_error      TEXT,
  transfer_at         INTEGER,
  transfer_by         TEXT,
  return_status       TEXT,               -- null (hic denenmedi) | 'basarili' | 'basarisiz'
  return_evrak_seri   TEXT,
  return_evrak_sira   TEXT,
  return_error        TEXT,
  return_at           INTEGER,
  return_by           TEXT,
  created_at          INTEGER NOT NULL,
  created_by          TEXT
);
`;

const row = (r) => ({
  id: Number(r.id), stockCode: r.stock_code, stockName: r.stock_name, kg: Number(r.kg), note: r.note, status: r.status,
  transfer: { status: r.transfer_status, evrakSeri: r.transfer_evrak_seri, evrakSira: r.transfer_evrak_sira, error: r.transfer_error, at: r.transfer_at == null ? null : Number(r.transfer_at), by: r.transfer_by },
  return: r.return_status == null ? null : { status: r.return_status, evrakSeri: r.return_evrak_seri, evrakSira: r.return_evrak_sira, error: r.return_error, at: r.return_at == null ? null : Number(r.return_at), by: r.return_by },
  createdAt: Number(r.created_at), createdBy: r.created_by,
});

export class MaterialQuarantine {
  /** @param {{planning: import('./planning.js').Planning}} deps */
  constructor({ planning }) {
    this.planning = planning;
    this.db = planning.db.db; // ayni sqlite baglantisi
    this.db.exec(SCHEMA);
  }

  list({ status = '' } = {}) {
    const conds = [];
    const args = [];
    if (STATUS.includes(status)) { conds.push('status = ?'); args.push(status); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM material_quarantine ${where} ORDER BY id DESC`).all(...args).map(row);
  }

  get(id) {
    const r = this.db.prepare('SELECT * FROM material_quarantine WHERE id = ?').get(Number(id));
    if (!r) throw new PlanningError('Kayıt bulunamadı.', 404);
    return row(r);
  }

  /** "Karantinaya aktar": kaydı oluşturur VE Merkez(1)->Karantina(5) sevk fişini hemen dener. Mikro çağrısı
   * başarısız olursa kayıt yine de KALICI oluşur ("Yeniden dene…" ile elle tekrarlanabilir) ve hata fırlatılır
   * (HTTP isteği hata döner — ama bir sonraki `list()` çağrısı yeni kaydı "aktarılamadı" olarak gösterir). */
  async transferIn({ stockCode, stockName, kg, note }, { by = null, now = Date.now() } = {}) {
    const code = stockCodeOf(stockCode);
    const amount = kgAmount(kg);
    const name = text(stockName, 'Hammadde adı', 200);
    const noteV = text(note, 'Not', 300);
    const id = Number(this.db.prepare(
      `INSERT INTO material_quarantine (stock_code, stock_name, kg, note, status, transfer_status, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(code, name, amount, noteV, 'aktarilamadi', 'basarisiz', now, by).lastInsertRowid);
    await this.#sendTransfer(id, { by, now });
    return this.get(id);
  }

  /** Başarısız sevkiyatı elle yeniden dener (otomatik bir tetikleyici YOK — aktarım tek seferlik bir eylem). */
  async retryTransfer(id, { by = null, now = Date.now() } = {}) {
    const r = this.get(id);
    if (r.transfer.status === 'basarili') throw new PlanningError('Bu kayıt zaten Karantina deposuna aktarıldı.', 409, 'already-transferred');
    await this.#sendTransfer(Number(id), { by, now });
    return this.get(id);
  }

  async #sendTransfer(id, { by, now }) {
    const r = this.get(id);
    const preview = this.planning.mikroStock.previewTransfer({
      fromDepotNo: MERKEZ_DEPO_NO, toDepotNo: KARANTINA_DEPO_NO, stockCode: r.stockCode, kg: r.kg,
      note: r.note ? `Hammadde karantinası: ${r.note}` : 'Hammadde karantinası',
    });
    // `preview.writeEnabled` kapıyı GÖNDERMEDEN ÖNCE denetler — ama (product-depot.js/quarantine-depot.js'ten
    // FARKLI: orada ledger'a hiç satır yazılmadan sessizce atlanır, burada kullanıcı az önce bir düğmeye bastı ve
    // sonucu BEKLİYOR) kayıt yine de "neden basarisiz" diye okunabilir olsun diye hata mesajı DB'ye de yazılır.
    if (!preview.writeEnabled) {
      const msg = 'Mikro yazma şu an kapalı (yönetici ile birlikte doğrulanıp MIKRO_WRITE_ENABLED açılmadan hiçbir şey Mikro\'ya gönderilmez).';
      this.db.prepare('UPDATE material_quarantine SET transfer_status=?, transfer_error=?, transfer_at=?, transfer_by=? WHERE id=?').run('basarisiz', msg, now, by, id);
      throw new PlanningError(msg, 409, 'mikro-write-disabled');
    }
    try {
      const result = await this.planning.mikroStock.send(preview);
      const evrak = result?.Data?.list?.[0] ?? {};
      this.db.prepare(
        'UPDATE material_quarantine SET status=?, transfer_status=?, transfer_evrak_seri=?, transfer_evrak_sira=?, transfer_error=NULL, transfer_at=?, transfer_by=? WHERE id=?',
      ).run('karantinada', 'basarili', evrak.evrakno_seri ?? null, evrak.evrakno_sira ?? null, now, by, id);
    } catch (err) {
      this.db.prepare('UPDATE material_quarantine SET transfer_status=?, transfer_error=?, transfer_at=?, transfer_by=? WHERE id=?').run('basarisiz', err.message, now, by, id);
      throw err;
    }
  }

  /** "İade": Karantina depodaki TAM miktarı sarf (stok virman, ÇIKAN) fişiyle düşer — tedarikçiye geri gönderildi,
   * Mikro'nun defterinden tamamen çıkar. Yalnız sevkiyatı BAŞARILI olmuş (gerçekten Karantina'da duran) bir
   * kayıtta anlamlıdır. Kısmi/parçalı iade YOK (kullanıcı kararı: tek seferde tamamı). */
  async returnToSupplier(id, { by = null, now = Date.now() } = {}) {
    const r = this.get(id);
    if (r.status !== 'karantinada') throw new PlanningError('Yalnız Karantina depoya aktarılmış bir kayıt iade edilebilir.', 409, 'bad-status');
    const preview = this.planning.mikroStock.previewVirman({
      depotNo: KARANTINA_DEPO_NO, direction: 'cikan', stockCode: r.stockCode, kg: r.kg,
      note: r.note ? `Hammadde iadesi: ${r.note}` : 'Hammadde iadesi',
    });
    if (!preview.writeEnabled) {
      const msg = 'Mikro yazma şu an kapalı (yönetici ile birlikte doğrulanıp MIKRO_WRITE_ENABLED açılmadan hiçbir şey Mikro\'ya gönderilmez).';
      this.db.prepare('UPDATE material_quarantine SET return_status=?, return_error=?, return_at=?, return_by=? WHERE id=?').run('basarisiz', msg, now, by, id);
      throw new PlanningError(msg, 409, 'mikro-write-disabled');
    }
    try {
      const result = await this.planning.mikroStock.send(preview);
      const evrak = result?.Data?.list?.[0] ?? {};
      this.db.prepare(
        'UPDATE material_quarantine SET status=?, return_status=?, return_evrak_seri=?, return_evrak_sira=?, return_error=NULL, return_at=?, return_by=? WHERE id=?',
      ).run('iade-edildi', 'basarili', evrak.evrakno_seri ?? null, evrak.evrakno_sira ?? null, now, by, id);
    } catch (err) {
      this.db.prepare('UPDATE material_quarantine SET return_status=?, return_error=?, return_at=?, return_by=? WHERE id=?').run('basarisiz', err.message, now, by, id);
      throw err;
    }
    return this.get(id);
  }

  /** Yanlışlıkla açılmış kaydı sil. Karantina'da GERÇEKTEN duran (sevkiyatı başarılı, henüz iade edilmemiş) bir
   * kaydı silmek izin VERMEZ — bu modülün silinmesi, Mikro'daki o stok hareketinin tek takip yerini kaybeder. */
  delete(id) {
    const r = this.get(id);
    if (r.status === 'karantinada') throw new PlanningError('Mikro\'da gerçekten Karantina deposuna aktarılmış bir kayıt silinemez: önce İade edin.', 409, 'has-movement');
    this.db.prepare('DELETE FROM material_quarantine WHERE id = ?').run(Number(id));
    return { ok: true };
  }
}
