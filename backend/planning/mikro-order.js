/**
 * Mikro'ya YENİ SATIŞ SİPARİŞİ yazma (`SiparisKaydetV2`) — ARAŞTIRILDI (2026-11-18), GERÇEK YAZMA BAŞARILI (2026-11-18
 * HAVANA/SAS0003812 — 4 kalem, elle bir betikle; 2026-11-19 Konveyör/4100018539 — 10 kalem, GERÇEK "Yeni siparişler"
 * ekranından, tek evrakta çoklu kalem: evrak SPR-755, salt okuma ile tüm alanlar önizlemeyle birebir doğrulandı).
 * Bu dosya yalnız gönderilecek gövdeyi KURAR/DOĞRULAR (`previewCreateOrder`) — `send()` çağrılmadıkça hiçbir
 * ağ isteği yapılmaz, `send()` de `MIKRO_WRITE_ENABLED=1` olmadan 409 ile reddeder (`mikro-stock.js`'teki AYNI
 * kapı/desen; gerçek kurulumda hâlâ varsayılan KAPALI).
 *
 * UÇ RESMİ DOĞRULANDI (apidocs.mikro.com.tr/apis/siparis, `SiparisKaydetV2` ham `.md`, 2026-11-18): kardeşleri
 * `SiparisDuzeltV2`/`SiparisSilV2`/`SiparisGuidSilV2` de var (bu turda kullanılmadı). Gövde `DahiliStokHareketKaydetV2`/
 * `StokKaydetV2` ile AYNI yapıda — `evraklar` `Mikro` bloğunun İÇİNDE (`nestInMikro:true`), `evrak_aciklamalari`
 * evrak düzeyinde, satır alanları `satirlar[]` içinde (`sip_*` önekli).
 *
 * SIPARISLER'İN RESMİ ALAN REFERANSI (apidocs.mikro.com.tr/tablo-alan-adlari/siparisler, Tablo No 21) + GERÇEK
 * 2540 müşteri siparişinin SALT OKUMA ile incelenmesi (2026-11-18, `SqlVeriOkuV2`, hiçbir şey yazılmadı) şunları
 * SABİT/GÜVENİLİR kıldı — 2540/2540 satırda İSTİSNASIZ AYNI:
 *   sip_tip='0' (Talep), sip_cins='0' (Normal Sipariş), sip_depono=1 (MERKEZ DEPO), sip_birim_pntr='1',
 *   sip_vergi_pntr='4', sip_vergisiz_fl=false, sip_doviz_cinsi='0'.
 * `sip_b_fiyat`/`sip_tutar`: çoğu gerçek satırda dolu (ör. 31,99 × 200 = 6398) ama EN AZ bir gerçek siparişte
 * (SR004/005.019) ikisi de 0 — yani 0 Mikro'da KABUL EDİLEN, gerçekte görülen bir değer (fiyat bilinmiyorsa 0
 * gönderilir, tahmin YAZILMAZ).
 *
 * `sip_evrakno_seri`/`sip_evrakno_sira` — DÜZELTME (2026-11-18, kullanıcının GERÇEK Mikro ekranını canlı doldururken
 * anlattığı akıştan): önceki tasarım bu alanı hiç göndermiyordu ("boş bırakınca otomatik numaralanır" varsayımıyla).
 * Ama gerçek ekranda "Yeni" denince Mikro'nun KENDİSİ bir sonraki SPR sırasını (son sıra + 1) öneriyor — bu, API'nin
 * boş bırakılınca otomatik numaralayacağının kanıtı DEĞİL, yalnızca MASAÜSTÜ İSTEMCİNİN kendi kolaylığı olabilir.
 * Bu yüzden artık AYNI mantığı biz de uyguluyoruz: `nextOrderDocNo()` ile `MAX(sip_evrakno_sira) WHERE seri='SPR'` + 1
 * okunup `sip_evrakno_seri='SPR'`/`sip_evrakno_sira=<bulunan>` AÇIKÇA gönderiliyor — tahmin değil, ofisin kendi elle
 * yaptığı işlemin birebir aynısı. **Hâlâ EN BELİRSİZ alan budur** (API'nin bu sırayı kabul edip etmeyeceği, çakışma
 * olursa ne olacağı — düşük hacimli, elle süreçte gerçek bir risk değil ama yarının asıl sınavı).
 *
 * `sip_opno` (Ödeme Planı No) — YENİ (2026-11-18, aynı canlı ekran gösteriminden): müşterinin KENDİ kartındaki
 * `CARI_HESAPLAR.cari_odemeplan_no` ile GERÇEK siparişlerdeki `sip_opno` BİREBİR AYNI çıktı (3 farklı müşteride
 * salt okuma ile doğrulandı: Ayvaz -90/-90, Berg Metal -30/-30, Klinger 0/0) — yani ekranda "yönetici seçiyor"
 * görünen bu alan aslında müşteri kartından OTOMATİK geliyor, biz de `odemePlanOf(customerCode)` ile AYNI şekilde
 * okuyup geçiyoruz (tahmin değil, doğrudan kopya).
 *
 * `sip_harekettipi='0'` (Stok) — RESMİ listede 0:Stok 1:Hizmet 2:Gider 3:Demirbaş; 2540/2540 gerçek siparişte
 * İSTİSNASIZ "0" (ekranda da satır "Cinsi" sütunu hep "Stok") — sabit eklendi.
 *
 * MÜŞTERİ KODU — PDF'teki şirket adından DEĞİL, EŞLEŞEN ÜRÜNÜN KENDİ SİPARİŞ GEÇMİŞİNDEN çözülür
 * (`resolveCustomerForStock`, 2026-11-18 bulgusu): PDF'teki serbest metin müşteri adını (ör. "Ayvaz")
 * CARI_HESAPLAR'da aramak BELİRSİZ — gerçek veride "AYVAZ ENDÜSTRİYEL ÜRÜNLER", "HACI AYVAZ ENDÜSTRİYEL
 * MAMÜLLER", "AYVAZ N LTD" üçü de AYRI, gerçek müşteri. Ama Alen'in kendi ürün kodu zaten müşteriye özeldir
 * (bkz. `sample-customer-groups.js`: kodun son 3 hanesi müşteri grubunu gösterir) — bu yüzden eşleşen Alen stok
 * koduyla SIPARISLER'de GEÇMİŞTE sipariş veren müşteri aranır, ad eşleştirmesinden ÇOK daha güvenilir (gerçek
 * örnek: SR018.002 → her zaman "120.10.0002", HACI AYVAZ). Geçmişi hiç olmayan (ilk kez sipariş edilen) bir
 * ürün için `searchCustomers` ile ELLE seçim yapılabilir (CARI_HESAPLAR'da canlı arama).
 *
 * Fiyat 2026-11-18'den beri `incoming-orders.js`/`pdf-table.js` tarafında da ÇIKARILIYOR (`price` alanı; bkz.
 * CLAUDE.md "Fiyat çıkarma") — ama bu da diğer her şey gibi yalnız bir TASLAK değeridir, kesinlik iddia etmez
 * ve onaydan önce `PUT .../lines/:id` ile düzeltilebilir. `previewCreateOrder`'ın `unitPriceValue` parametresi
 * bu çıkarılan (ya da elle düzeltilmiş) değerle doldurulur; hiçbir yerde bulunamazsa hâlâ boş/0 gelir.
 */
import { PlanningError } from './errors.js';
import { stockCodeOf, likeTermForMikro } from './mikro-stock.js';
import { text } from './fields.js';

const SIP_TIP_TALEP = '0';
const SIP_CINS_NORMAL = '0';
const MERKEZ_DEPO_NO = 1;
const SIP_VERGI_PNTR = '4';
const SIP_BIRIM_PNTR = '1';
const SIP_HAREKETTIPI_STOK = '0';
const ORDER_SERI = 'SPR';
const MAX_QTY = 1_000_000;
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

function isoDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function orderQty(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_QTY) throw new PlanningError(`Miktar 0 ile ${MAX_QTY.toLocaleString('tr-TR')} arasında bir sayı olmalı.`, 400, 'bad-qty');
  return n;
}

function customerCodeOf(v) {
  const s = String(v ?? '').trim();
  if (s === '' || s.length > 25) throw new PlanningError('Müşteri kodu seçilmeli.', 400, 'bad-customer-code');
  return s;
}

function unitPrice(v) {
  if (v == null || v === '') return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new PlanningError('Birim fiyat negatif olmayan bir sayı olmalı.', 400, 'bad-price');
  return round(n, 2);
}

/**
 * `evraklar[]` sarmalayıcısı — `mikro-stock.js#wrapEvrak` ile AYNI şekil (evrak_aciklamalari evrak düzeyinde),
 * ayrı bir kopya değil (yalnız bu dosyada `sth_*` yerine `sip_*` alanları taşıdığı için paylaşılan bir yardımcı
 * anlamlı olmazdı). `satirlar`: BİRDEN ÇOK kalem olabilir (2026-11-18, kullanıcı isteği — "bir siparişte birden
 * fazla ürün yazabiliyor olmalı"): gerçek `SIPARISLER`'de aynı (seri, sıra) birden çok satıra yayılabiliyor
 * (ör. SR004/005.019'un aynı evrak sırasını paylaştığı gerçek örnek, bkz. dosya başı) — tek evrak, çok kalem.
 */
function wrapEvrak(satirlar, note) {
  return { evraklar: [{ evrak_aciklamalari: note ? [{ aciklama: note }] : [], satirlar }] };
}

export class MikroOrders {
  /** @param {{client: import('./mikro-client.js').MikroClient, writeEnabled?: () => boolean}} deps */
  constructor({ client, writeEnabled = () => process.env.MIKRO_WRITE_ENABLED === '1' } = {}) {
    this.client = client;
    this.writeEnabled = writeEnabled;
  }

  configured() { return this.client.configured(); }

  /**
   * Bu Alen stok kodunu EN SON sipariş eden gerçek müşteri — SIPARISLER geçmişinden, GÜVENİLİR kaynak
   * (bkz. dosya başı). Hiç sipariş geçmişi yoksa `null` döner (ilk kez sipariş edilen ürün): çağıran
   * `searchCustomers` ile elle seçime düşer.
   */
  async resolveCustomerForStock(stockCode) {
    const code = stockCodeOf(stockCode);
    const safe = likeTermForMikro(code);
    const rows = await this.client.sqlQuery(
      `SELECT TOP 1 sip_musteri_kod, dbo.fn_CarininIsminiBul(0, sip_musteri_kod) AS ad FROM SIPARISLER ` +
      `WHERE sip_stok_kod = '${safe}' AND sip_tip = 0 ORDER BY sip_tarih DESC`,
    );
    if (rows.length === 0) return null;
    return { customerCode: String(rows[0].sip_musteri_kod), name: String(rows[0].ad ?? '').trim() };
  }

  /** Müşteri adıyla CANLI arama (CARI_HESAPLAR) — `resolveCustomerForStock` hiçbir şey bulamazsa ELLE seçim için. */
  async searchCustomers(q, limit = 20) {
    const query = likeTermForMikro(q);
    const top = Math.min(Math.max(Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : 20, 1), 50);
    const sql =
      `SELECT TOP ${top} cari_kod, cari_unvan1 FROM CARI_HESAPLAR WHERE cari_iptal = 0 AND cari_hidden = 0` +
      (query ? ` AND cari_unvan1 LIKE '%${query}%'` : '') +
      ' ORDER BY cari_unvan1';
    const rows = await this.client.sqlQuery(sql);
    return rows.map((r) => ({ customerCode: String(r.cari_kod), name: String(r.cari_unvan1 ?? '').trim() }));
  }

  /**
   * Müşterinin KENDİ kartındaki ödeme planı (`CARI_HESAPLAR.cari_odemeplan_no`) — gerçek siparişlerdeki `sip_opno`
   * ile BİREBİR aynı çıktığı doğrulandı (bkz. dosya başı); tahmin değil, doğrudan kopya. Kart bulunamazsa `null`
   * (çağıran `sip_opno`'yu hiç göndermez — Mikro kendi varsayılanını uygulasın).
   */
  async odemePlanOf(customerCode) {
    const safe = likeTermForMikro(customerCodeOf(customerCode));
    const rows = await this.client.sqlQuery(`SELECT cari_odemeplan_no FROM CARI_HESAPLAR WHERE cari_kod = '${safe}'`);
    if (rows.length === 0 || rows[0].cari_odemeplan_no == null) return null;
    return Number(rows[0].cari_odemeplan_no);
  }

  /**
   * Sıradaki sipariş evrak numarası ("SPR" serisi) — gerçek ekranda "Yeni" denince Mikro'nun önerdiği AYNI
   * mantık (son sıra + 1); bkz. dosya başı. Bu, API'nin boş bırakılınca otomatik numaralayacağının KANITI
   * DEĞİL — yalnızca masaüstü istemcinin yaptığını biz de elle yapıyoruz.
   */
  async nextOrderDocNo() {
    const rows = await this.client.sqlQuery(`SELECT MAX(sip_evrakno_sira) AS son FROM SIPARISLER WHERE sip_evrakno_seri = '${ORDER_SERI}'`);
    const son = Number(rows[0]?.son);
    return { seri: ORDER_SERI, sira: (Number.isFinite(son) ? son : 0) + 1 };
  }

  /**
   * Yeni sipariş evrakının gövdesini hazırlar — GÖNDERMEZ, yalnız kurar/doğrular. `items`: BİRDEN ÇOK kalem
   * olabilir (2026-11-18, kullanıcı isteği) — hepsi AYNI evrakta (`customerCode`/`custOrderNo`/tarih/ödeme
   * planı/evrak sırası EVRAK düzeyinde, tüm kalemlerde AYNI; yalnız `stockCode`/`qty`/`dueDateMs`/`unitPriceValue`
   * kalem başına değişir) — gerçek `SIPARISLER`'de aynı (seri, sıra) birden çok satıra yayıldığı doğrulanmıştı
   * (bkz. dosya başı).
   * @param {{customerCode, items: {stockCode, qty, dueDateMs?, unitPriceValue?}[], custOrderNo?, orderDateMs?, note?, odemePlanNo?, docSeri?, docSira?}} input
   *   odemePlanNo: `odemePlanOf()`'tan (müşteri kartından, sip_opno); docSeri/docSira: `nextOrderDocNo()`'tan
   *   (ikisi de isteğe bağlı — verilmezse o alan hiç gönderilmez, Mikro'nun varsayılanına bırakılır).
   */
  previewCreateOrder({ customerCode, items, custOrderNo, orderDateMs, note, odemePlanNo, docSeri, docSira } = {}, { now = Date.now() } = {}) {
    if (!Array.isArray(items) || items.length === 0) throw new PlanningError('En az bir kalem (ürün) olmalı.', 400, 'no-items');
    const musteri = customerCodeOf(customerCode);
    const belgeno = custOrderNo ? text(custOrderNo, 'Müşteri sipariş no', 50) : undefined;
    const tarih = isoDate(orderDateMs ?? now);
    const opno = odemePlanNo != null ? Number(odemePlanNo) : undefined;
    const seri = docSeri || undefined;
    const sira = docSira != null ? Number(docSira) : undefined;
    const satirlar = items.map((it) => {
      const fiyat = unitPrice(it.unitPriceValue);
      const miktar = orderQty(it.qty);
      return {
        sip_stok_kod: stockCodeOf(it.stockCode),
        sip_musteri_kod: musteri,
        sip_miktar: miktar,
        sip_birim_pntr: SIP_BIRIM_PNTR,
        sip_tip: SIP_TIP_TALEP,
        sip_cins: SIP_CINS_NORMAL,
        sip_harekettipi: SIP_HAREKETTIPI_STOK,
        sip_depono: MERKEZ_DEPO_NO,
        sip_vergi_pntr: SIP_VERGI_PNTR,
        sip_vergisiz_fl: false,
        sip_doviz_cinsi: '0',
        sip_tarih: tarih,
        sip_teslim_tarih: it.dueDateMs != null ? isoDate(it.dueDateMs) : undefined,
        sip_belgeno: belgeno,
        sip_b_fiyat: fiyat,
        sip_tutar: round(fiyat * miktar, 2),
        sip_opno: opno,
        sip_evrakno_seri: seri,
        sip_evrakno_sira: sira,
      };
    });
    const body = wrapEvrak(satirlar, text(note, 'Not', 200));
    return {
      kind: 'siparis-olustur', endpoint: 'SiparisKaydetV2', body, writeEnabled: this.writeEnabled(),
      assumed: [
        'sip_evrakno_seri/sip_evrakno_sira: nextOrderDocNo() okuyup göndermek ile GERÇEKTEN yazmak arasındaki kısa pencerede aynı anda iki gönderim olursa (ikisi de ayni MAX+1\'i okursa) çakışma hiç denenmedi — düşük hacimli, elle onaylı süreçte gerçek bir risk değil.',
      ],
    };
  }

  /** Önceden kurulmuş bir önizlemeyi GERÇEKTEN Mikro'ya yazar — yalnız `MIKRO_WRITE_ENABLED=1` iken. */
  async send(preview) {
    if (!this.writeEnabled()) {
      throw new PlanningError(
        'Mikro yazma şu an kapalı (inceleme/onay aşaması): yönetici ile birlikte doğrulanıp MIKRO_WRITE_ENABLED açılmadan hiçbir şey Mikro\'ya gönderilmez.',
        409,
        'mikro-write-disabled',
      );
    }
    return this.client.call(preview.endpoint, preview.body, { nestInMikro: true });
  }
}
