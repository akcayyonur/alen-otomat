/**
 * Bitmiş ürün depo akışı (kullanıcının 2026-11-03 isteğinin ikinci parçası; birinci parça program kütüphanesi
 * bölünmesiydi, ayrı commit). Amaç: CNC Telemetri'den yakalanan üretim/paketleme verisiyle Mikro'da fişler:
 *
 *   İş emri BİTİNCE   -> Geçici (2) İÇİNDE GİRİŞ (virman)   ÜRETİLEN adet kadar (üretim doğrudan Geçici'de "doğar")
 *   PAKETLENİNCE      -> Geçici (2) -> Merkez (1) TRANSFER  PAKETLENEN adet kadar (artık sevke hazır, merkez depoya döner)
 *   KALAN FARK (elle) -> Geçici (2) ÇIKAN (virman)          üretilenin asla paketlenmeyecek kısmı (sayım/hurda; bkz. aşağıda)
 *
 * **DÜZELTME (2026-11-04, gerçek Mikro'ya karşı İLK deneme, SR040.013, yönetici onayıyla):** ilk tasarım "bitiş"
 * adımını da Merkez(1)->Geçici(2) TRANSFER olarak kurmuştu — Mikro bunu GERÇEK ve ANLAMLI bir hatayla reddetti:
 * `"Stok eksiye düşeceğinden, işlem kabul edilmedi."` Sebep: Merkez depoda transfer edilecek SR040.013 stoku hiç
 * YOK — üretim Merkez'e hiç girmiyor ki. Salt okuma ile SR040.013'ün GERÇEK geçmiş hareketleri incelenince
 * (`STOK_HAREKETLERI`, üç ayrı tarihte AYNI üçlü desen) ofisin bunu hep şöyle yaptığı görüldü: (1) **"ÜRT" evrak,
 * Geçici(2) İÇİNDE GİRİŞ virmanı** (`evraktip=6/tip=0 Giriş/cins=3, çıkış=giriş=2`) — üretim doğrudan Geçici'de
 * GİRİŞ olarak kaydediliyor; (2) **"alen"/"ALEN" evrak, Geçici(2)->Merkez(1) TRANSFER** (`evraktip=2/tip=2/cins=6`)
 * — AYNEN `sendPackingTransfer`'ın zaten yaptığı; (3) **"ANI" evrak, Merkez içinde ÇIKIŞ** (irsaliye, müşteriye
 * sevk) — bizim kapsamımızın dışında. Kullanıcı bunu doğruladı ("zaten merkeziden geçiciye transfer olarak değil
 * direkt geçici depo içinde üretelim demiştim"): `sendFinishTransfer` artık `previewProductTransfer` DEĞİL,
 * `previewProductVirman({depotNo: GECICI_DEPO_NO, direction: 'giren'})` kullanıyor (aşağıya bakın). `fromDepot`/
 * `toDepot` kayıtları da bu yüzden `GECICI_DEPO_NO`/`GECICI_DEPO_NO` (virman: çıkış=giriş=aynı depo; `temizle`
 * kindiyle AYNI desen). `MERKEZ_DEPO_NO` artık yalnız `sendPackingTransfer`'ın hedefi.
 *
 * KALAN FARK (kullanıcı isteği, 2026-11-04): üretim sayacı (ham, numune/ayar/hurda dahil) ile paketleme formunun
 * (görsel kontrolden geçmiş, güvenilir) verdiği adet arasında her zaman bir fark olabilir (ör. 50.000 üretildi,
 * 49.800 paketlendi). Bu fark Geçici depoya İş emri bitince GİRİŞ yapılmış ama HİÇ Merkez'e dönmeyecektir — kalıcı
 * olarak orada "hayalet stok" gibi birikmemesi için ayrı, ELLE onaylanan bir adımla (`clearRemaining`) Geçici
 * depodan ÇIKAN stok virman fişiyle (aynı `previewProductVirman`, yön `cikan`) düşülür. BİLEREK OTOMATİK DEĞİL
 * (hammaddenin G aşamasındaki "sistem fazlalığı gösterir, otomatik bir şey yapmaz" kararıyla aynı ilke): paketleme
 * bir iş emri `bitti` olduktan GÜNLER sonra bile eklenebiliyor (kasa/paketleme formu iş emri durumuna bağlı
 * değil), bu yüzden "kalan fark" kalıcı/kesin değildir — yalnız admin, paketlemenin GERÇEKTEN bittiğinden emin
 * olunca temizler. Temizlendikten SONRA o iş emrine yeni paketleme satırı eklenirse Geçici depo bakiyesi yanlış
 * olur: sistem bunu ENGELLEMEZ, işletme disiplini gerektirir.
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
 * DÜZELTMEDEN SONRA gerçek Mikro'ya karşı YENİDEN denendi ve BAŞARILI (2026-11-04, aynı test iş emri, SR040.013,
 * 2026001199): GİRİŞ (10 adet), TRANSFER (8 adet paketlenip Merkez'e), ÇIKAN (kalan 2 adet temizlendi) üçü de
 * UI'dan uçtan uca doğrulandı. Önceki turlardaki kural geçerli: `MIKRO_WRITE_ENABLED=1` olmadan hiçbir ağ isteği
 * YAPILMAZ.
 *
 * PAKETLEME → MERKEZ SEVKİ OTOMATİK (2026-11-04, kullanıcı kararı): `planning.js` `addPackingRow`/`updatePackingRow`
 * paketleme satırı eklenince/düzenlenince `sendPackingTransfer`i arka planda (await edilmeden) KENDİLİĞİNDEN
 * dener — artık "Merkeze sevk et…" ELLE tıklanmak ZORUNDA değil (düğme hâlâ var, yalnız başarısız/kapalıyken
 * elle yeniden deneme için). "Geçici depoya aktar…" (bitiş) ve "Farkı temizle…" (kalan fark) BİLEREK otomatik
 * YAPILMADI — ikisi de admin'in bir şeyi (üretimin/paketlemenin GERÇEKTEN bittiğini) kesinleştirdiği anlardır.
 *
 * TÜM AKIŞ İÇİN AYRI AÇMA/KAPAMA KAPISI (`PRODUCT_DEPOT_ENABLED`, 2026-11-04, kullanıcı kararı — v1.0.2
 * kurulumunda KAPALI): fabrika PC'si henüz aşağıya (üretim sahasına) inmedi, yani paketleme orada kullanılmıyor.
 * `MIKRO_WRITE_ENABLED=1` açıkken bu akış da açık kalırsa, iş emirleri bitirildikçe Geçici depoda paketlenmeyi
 * hiç bekleyen bir "hayalet stok" yığını birikir (paketleme sahada yapılmadığı için Merkez'e hiç dönmez).
 * `MIKRO_WRITE_ENABLED`'dan AYRI, DAHA DAR bir kapı: hammaddenin kendi Mikro akışını (transfer/virman, "Hammadde"
 * ekranı) ETKİLEMEZ, yalnız BU modülün üç fonksiyonunu (`sendFinishTransfer`/`sendPackingTransfer`/`clearRemaining`,
 * dolayısıyla otomatik paketleme senkronunu da) kapatır. Panel (ekran) GİZLENMEZ — yalnız butonlar devre dışı,
 * nedeni görünür (kullanıcı kararı: "kapalı ekran olmasın"). Fabrika PC'si kurulup paketleme sahada başlayınca
 * `installer/build-installer.ps1 -ProductDepotEnabled` ile bir sonraki pakette açılacak.
 */
import { PlanningError } from './errors.js';

/** DEPOLAR (gerçek, SqlVeriOkuV2 ile salt okuma doğrulandı, CLAUDE.md "G aşaması"): 1=MERKEZ DEPO, 2=GEÇİCİ DEPO. */
export const MERKEZ_DEPO_NO = 1;
export const GECICI_DEPO_NO = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS product_depot_transfers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  wo_no      TEXT    NOT NULL,
  kind       TEXT    NOT NULL,   -- 'bitis' (Gecici icinde GIRIS virmani) | 'paketleme' (Gecici->Merkez transfer) | 'temizle' (Gecici'de kalan fark, virman CIKAN)
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
  /** İş emri başına eşzamanlı gönderimi engeller (`sources.js`/`mikro.js`/`doc-folder.js`'teki `this.busy` deseniyle aynı, yalnız global değil İŞ EMRİ başına):
   * `addPackingRow`/`updatePackingRow` arka planda (await edilmeden) `sendPackingTransfer` tetikliyor; aynı iş emri için üst üste gelen iki çağrı
   * (hızlı art arda satır ekleme, iki sekme, ya da elle "Merkeze sevk et…" ile aynı anda çakışan otomatik senkron) `await mikroStock.send(...)`
   * noktasına kadar SENKRON aynı (eski) `#sentTotal`'i okur ve AYNI delta'yı iki kez Mikro'ya gönderebilirdi. Reddedilen çağrı veri KAYBETMEZ:
   * delta hâlâ oradadır, bir sonraki çağrı (elle yeniden deneme ya da bir sonraki otomatik senkron) alır — `#send`'in zaten var olan
   * "başarısız deneme geçmişe yazılır, bir sonraki çağrı farkı toplar" ilkesiyle aynı. */
  #busy = new Set();

  /** @param {{planning: import('./planning.js').Planning, enabled?: () => boolean}} deps `enabled`: MIKRO_WRITE_ENABLED'dan AYRI, bu modüle özel kapı (bkz. dosya başı). */
  constructor({ planning, enabled = () => process.env.PRODUCT_DEPOT_ENABLED === '1' }) {
    this.planning = planning;
    this.enabled = enabled;
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

  /** İş emri için depo akışı durumu: ne kadarı Geçici'ye aktarılmaya, ne kadarı Merkez'e sevk edilmeye, ne kadarı (kalan fark) temizlenmeye hazır. */
  statusFor(woNo) {
    const { w, packedTotal } = this.#load(woNo);
    const produced = w.status === 'bitti' ? (w.result?.produced ?? 0) : 0;
    const bitisSent = this.#sentTotal(w.no, 'bitis');
    const paketlemeSent = this.#sentTotal(w.no, 'paketleme');
    const temizleSent = this.#sentTotal(w.no, 'temizle');
    const remaining = Math.max(0, bitisSent - paketlemeSent - temizleSent);
    return {
      stockCode: w.stockCode,
      configured: this.planning.mikroStock.configured(),
      writeEnabled: this.planning.mikroStock.writeEnabled(),
      // MIKRO_WRITE_ENABLED'dan AYRI kapı: bu modüle özel, "fabrika PC'si/paketleme sahada kuruluncaya kadar kapalı" (bkz. dosya başı).
      flowEnabled: this.enabled(),
      bitis: { history: this.#history(w.no, 'bitis'), produced, sent: bitisSent, pending: w.status === 'bitti' ? Math.max(0, produced - bitisSent) : 0 },
      paketleme: { history: this.#history(w.no, 'paketleme'), packedTotal, sent: paketlemeSent, pending: Math.max(0, packedTotal - paketlemeSent) },
      // "remaining": Gecici'de bu is emrinden kalan, hic Merkez'e donmemis adet (= paketlenmeyecek fark); yalniz is emri
      // bittiyse ve hala temizlenmemis bir sey varsa elle temizlenebilir (bkz. clearRemaining, dosya basindaki not).
      temizle: { history: this.#history(w.no, 'temizle'), sent: temizleSent, remaining, canClear: w.status === 'bitti' && remaining > 0 },
    };
  }

  /**
   * İş emri bitince: ÜRETİLEN adedin henüz gönderilmemiş kısmı Geçici depo İÇİNDE GİRİŞ virmanıyla "doğar"
   * (Merkez'den TRANSFER DEĞİL — dosya başındaki 2026-11-04 düzeltme notuna bakın: Merkez'de transfer edilecek
   * stok hiç yok, ofis üretimi hep doğrudan Geçici'ye GİRİŞ virmanıyla kaydediyor).
   */
  async sendFinishTransfer(woNo, { by = null, now = Date.now() } = {}) {
    const { w } = this.#load(woNo);
    if (w.status !== 'bitti') throw new PlanningError('Yalnız biten iş emri için Geçici depoya aktarılabilir.', 409, 'bad-status');
    const produced = w.result?.produced ?? 0;
    const qty = produced - this.#sentTotal(w.no, 'bitis');
    if (qty <= 0) {
      throw new PlanningError(produced === 0 ? 'Hiç parça üretilmedi: aktarılacak adet yok.' : 'Bu iş emrinin üretimi zaten Geçici depoya aktarıldı.', 409, 'nothing-to-send');
    }
    return this.#send({
      woNo: w.no, kind: 'bitis', stockCode: w.stockCode, qty, fromDepot: GECICI_DEPO_NO, toDepot: GECICI_DEPO_NO,
      preview: this.planning.mikroStock.previewProductVirman({ depotNo: GECICI_DEPO_NO, stockCode: w.stockCode, qty, direction: 'giren', note: `İş emri ${w.no} bitti (${produced} adet üretildi)` }),
      eventType: 'gecici-depoya-aktarildi', by, now,
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
      preview: this.planning.mikroStock.previewProductTransfer({ fromDepotNo: GECICI_DEPO_NO, toDepotNo: MERKEZ_DEPO_NO, stockCode: w.stockCode, qty, note: `İş emri ${w.no} paketleme sevki (toplam ${packedTotal} adet paketlendi)` }),
      eventType: 'merkez-depoya-sevk-edildi', by, now,
    });
  }

  /**
   * ELLE: bu iş emrinin üretilip Geçici'ye aktarılmış ama hiç paketlenmeyecek (ve paketlenmeyen) kalan farkını
   * Geçici depodan ÇIKAN stok virman fişiyle düşer. Yalnız biten iş emrinde ve admin AÇIKÇA onayladığında — dosya
   * başındaki not: paketleme sonradan da eklenebildiği için bu GERİ ALINAMAZ adımı admin, paketlemenin GERÇEKTEN
   * bittiğinden emin olunca tetikler; sistem "paketleme kapandı" diye bir durum TUTMAZ, kendiliğinden ateşlenmez.
   */
  async clearRemaining(woNo, { by = null, now = Date.now() } = {}) {
    const { w } = this.#load(woNo);
    if (w.status !== 'bitti') throw new PlanningError('Yalnız biten iş emrinde Geçici depoda kalan fark temizlenebilir.', 409, 'bad-status');
    const remaining = this.#sentTotal(w.no, 'bitis') - this.#sentTotal(w.no, 'paketleme') - this.#sentTotal(w.no, 'temizle');
    if (remaining <= 0) throw new PlanningError('Temizlenecek fark yok (paketlenen adet Geçici\'ye aktarılanı karşılıyor).', 409, 'nothing-to-clear');
    return this.#send({
      woNo: w.no, kind: 'temizle', stockCode: w.stockCode, qty: remaining, fromDepot: GECICI_DEPO_NO, toDepot: GECICI_DEPO_NO,
      preview: this.planning.mikroStock.previewProductVirman({ depotNo: GECICI_DEPO_NO, stockCode: w.stockCode, qty: remaining, direction: 'cikan', note: `İş emri ${w.no}: paketlenmeyen fark temizlendi (${remaining} adet)` }),
      eventType: 'gecici-depo-farki-temizlendi', by, now,
    });
  }

  async #send({ woNo, kind, stockCode, qty, fromDepot, toDepot, preview, eventType, by, now }) {
    if (!this.enabled()) {
      throw new PlanningError(
        'Bitmiş ürün depo akışı (Geçici↔Merkez) şu an kapalı: fabrika PC\'si/paketleme sahada kurulana kadar devre dışı bırakıldı.',
        409, 'depot-flow-disabled',
      );
    }
    if (!preview.writeEnabled) {
      throw new PlanningError(
        'Mikro yazma şu an kapalı (inceleme/onay aşaması ya da ağ dışı): yönetici ile birlikte doğrulanıp MIKRO_WRITE_ENABLED açılmadan hiçbir şey Mikro\'ya gönderilmez.',
        409, 'mikro-write-disabled',
      );
    }
    // Ayni is emri icin eszamanli gonderimi engelle (bkz. #busy alanindaki not): `qty` zaten SENKRON hesaplanmisti,
    // asagidaki await'ten once; iki esanli cagri ayni (eski) sentTotal'i gorup ayni delta'yi iki kez gonderebilirdi.
    if (this.#busy.has(woNo)) throw new PlanningError('Bu iş emri için Mikro gönderimi zaten sürüyor, bitmesini bekleyin.', 409, 'busy');
    this.#busy.add(woNo);
    try {
      const result = await this.planning.mikroStock.send(preview);
      const evrak = result?.Data?.list?.[0] ?? {};
      this.#insert({ woNo, kind, stockCode, qty, fromDepot, toDepot, status: 'basarili', evrakSeri: evrak.evrakno_seri ?? null, evrakSira: evrak.evrakno_sira ?? null, by, now });
      // evrakno_sira her zaman anlamlidir; evrakno_seri GIRIS'te BILEREK bos gelir (bkz. mikro-stock.js) - bu yuzden
      // seri'nin DOLU olmasina degil, sira'nin VAR olmasina gore gosterilir (eskiden `evrak.evrakno_seri ?` ile
      // GIRIS'in evrak numarasi geçmişten hiç görünmüyordu).
      const evrakRef = evrak.evrakno_sira != null && evrak.evrakno_sira !== ''
        ? ` · Mikro ${evrak.evrakno_seri ? `${evrak.evrakno_seri}-` : ''}${evrak.evrakno_sira}` : '';
      this.planning.db.addWorkOrderEvent(woNo, eventType, `${qty} adet${evrakRef}`, { by, now });
      return this.statusFor(woNo);
    } catch (err) {
      this.#insert({ woNo, kind, stockCode, qty, fromDepot, toDepot, status: 'basarisiz', error: err.message, by, now });
      throw err;
    } finally {
      this.#busy.delete(woNo);
    }
  }
}
