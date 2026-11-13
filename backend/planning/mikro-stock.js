/**
 * Depolar arası sevkiyat (transfer) ve sarfiyat (virman) fişi — MikroAPI YAZMA (DahiliStokHareketKaydetV2).
 *
 * GERÇEK YAZMA DOĞRULANDI (2026-10-29): 8 başarısız denemeden sonra (hep aynı boş `StatusCode:400` hatası,
 * hiçbiri hiçbir şey yazmadı) kök neden bulundu — `evraklar` `Mikro` bloğunun DIŞINDA değil, İÇİNDE
 * gönderilmeli (`MikroClient.call(..., {nestInMikro:true})`; `SqlVeriOkuV2`'nin tam tersi, bkz. mikro-client.js).
 * Düzeltilince İLK denemede gerçek bir kayıt oluştu (evrak CNCT-1, 1 kg, MERKEZ DEPO→GEÇİCİ DEPO, salt okuma ile
 * doğrulandı). `sth_evraktip=2/tip=2/cins=6` (transfer) ve `sth_tutar=0` ikisi de GERÇEKTEN kabul edildi.
 * Sarfiyat (virman, `evraktip=6/tip=1/cins=3`) tarafı henüz gerçek bir yazmayla denenmedi ama aynı düzeltme
 * (nestInMikro) geçerli olmalı.
 *
 * KULLANICI KARARI (2026-10-29): bu başarıdan SONRA bile, `MIKRO_WRITE_ENABLED=1` verilmeden `send()` hiçbir
 * ağ isteği yapmaz (409 `mikro-write-disabled`) — gerçek kurulumda varsayılan hâlâ KAPALI; yukarıdaki başarılı
 * deneme tek seferlik bir betikle, `writeEnabled` yalnız o betik için enjekte edilerek yapıldı, sunucu config'i
 * hiç değişmedi (bkz. CLAUDE.md "G aşaması").
 *
 * GİRİŞ (tip=0) YÖNÜ DE GERÇEK YAZMAYLA DOĞRULANDI (2026-11-04, SR040.013, bitmiş ürün depo akışının "iş emri
 * bitince Geçici'ye GİRİŞ" adımını denerken, bkz. product-depot.js): önce 3 kez aynı genel hatayla ("Stok
 * Hareketi Kaydedilemedi") reddedildi; kullanıcı Mikro ekranından ELLE bir GİRİŞ virmanı yapıp sonucu salt
 * okuma ile karşılaştırınca kök neden bulundu — GİRİŞ'te `sth_evrakno_seri` BOŞ olmalı ("CNCT" ÇIKAN/TRANSFER'de
 * çalışıyor ama GİRİŞ'te reddediliyordu); `sth_miktar2`/`sth_birim_pntr` de eklendi (gerçek satırlarda hep var,
 * zararsız). Düzeltilince İLK denemede kabul edildi (bkz. `baseSatir` ve `previewVirman`/`previewProductVirman`
 * içindeki notlar). Artık her iki yön (GİRİŞ + ÇIKAN) ve hem hammadde hem bitmiş ürün gerçek yazmayla doğrulandı.
 *
 * Depo listesi ve hammadde arama CANLI Mikro okumasıdır (SqlVeriOkuV2, salt okuma, risksiz — zaten doğrulanmış
 * yöntem, bkz. mikro.js). Yazılacak fişin alan DEĞERLERİ (sth_evraktip/sth_tip/sth_cins, evrak serisi) gerçek
 * geçmiş STOK_HAREKETLERI kayıtlarından GÖZLENEN bir örüntüye dayanıyor VE artık transfer + her iki virman yönü
 * için de gerçek bir yazmayla doğrulandı; `assumed` alanı hâlâ `sth_tutar`'ı işaretliyor (maliyet muhasebesi
 * etkisi netleşmedi, 0 kabul edildi ama doğru değer bu mu bilmiyoruz).
 *
 * `previewCreateProduct`/`previewUpdateProductWeight` (2026-11-13): YENİ bir Mikro yazma SINIFI — stok
 * HAREKETİ değil, stok KARTININ KENDİSİ (`StokKaydetV2`, resmi dokümantasyondan kuruldu). Bu ikisi, buradaki
 * diğer her fonksiyonun aksine, **GERÇEK MİKRO'YA KARŞI HİÇ DENENMEDİ** — ayrıntı kendi doc-comment'lerinde.
 */
import { PlanningError } from './errors.js';

const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
const MAX_KG = 10_000;
/** Bizim sistemimizin ürettiği fişleri Mikro'nun kendi ekranlarından (ALEN, ÜRT, ANI…) ayırt etmek için. DOĞRULANMAMIŞ: Mikro bu seriyi kabul ediyor mu, numarayı kendisi mi veriyor, test edilmedi. */
const EVRAK_SERI = 'CNCT';

function isoDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function positiveInt(v, label) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new PlanningError(`${label} geçerli bir depo numarası olmalı.`, 400, 'bad-depot');
  return n;
}

/** Türkçe yazım: "." HER ZAMAN binlik ayracıdır (atılır), "," ondalık ayracıdır — `quarantine.js`'teki EYS.LS.018
 * düzeltmesiyle AYNI kural (2026-11-06'da bulunan "12.500" → 12,5 yerine 12500 hatasının aynısı, burada GERÇEK
 * Mikro yazma miktarını besliyor: 2026-11-10'da kod incelemesinde bulundu, hiç gerçek yazmada denenmemişti). */
function parseTrNumber(v) {
  return typeof v === 'number' ? v : Number(String(v ?? '').trim().replace(/\./g, '').replace(',', '.'));
}

/** Dışa aktarılır: `material-quarantine.js` (hammadde karantinası) kg'yı kendi kaydında saklamadan önce AYNI
 * ayrıştırma/doğrulamayı kullanır (ayrı bir kopya YAZILMADI — 2026-11-10). */
export function kgAmount(v) {
  const n = parseTrNumber(v);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_KG) throw new PlanningError(`Kilo 0 ile ${MAX_KG} arasında bir sayı olmalı.`, 400, 'bad-kg');
  return round(n, 3);
}

/** Dışa aktarılır: `material-quarantine.js` aynı stok kodu doğrulamasını kullanır. */
export function stockCodeOf(v) {
  const s = String(v ?? '').trim();
  if (s === '' || s.length > 40) throw new PlanningError('Hammadde (Mikro stok kodu) seçilmeli.', 400, 'bad-stock-code');
  return s;
}

const MAX_QTY = 1_000_000;
/** Bitmiş ürün (adet) miktarı: kg'dan farklı olarak her zaman tam sayı. */
function pieceCount(v) {
  const n = parseTrNumber(v);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_QTY) throw new PlanningError(`Adet 1 ile ${MAX_QTY.toLocaleString('tr-TR')} arasında bir tam sayı olmalı.`, 400, 'bad-qty');
  return n;
}

/**
 * MikroAPI'nin `SqlVeriOkuV2` ucu bağlı (parametreli) sorgu DESTEKLEMEZ — gönderilen `SQLSorgu` metni harfi
 * harfine SQL olarak çalışır (bkz. dosya başı ve `mikro.js`). Bu yüzden kullanıcı girdisi doğrudan `LIKE '%…%'`
 * içine gömülmeden önce SQL metnini KAPATABİLECEK/BOZABİLECEK her karakter (tek tırnak) ve LIKE joker
 * karakterleri (`%`, `_`, `[`, `]`) ATILIR — tutulmaz/kaçırılmaz, çünkü kaçırma (escape) biçimi MikroAPI'nin SQL
 * lehçesine göre değişebilir ve burada doğrulanmadı; atmak (strip) hem basit hem her durumda güvenli. Adını taşıyan
 * tek bir fonksiyonda tutulur ki bu desen ileride başka bir Mikro SQL sorgusuna kopyalanırken karakter kümesi
 * unutulmasın/yanlış kopyalanmasın (2026-11-10, kod incelemesinde bulundu).
 */
function likeTermForMikro(q) {
  return String(q ?? '').trim().replace(/[%_[\]']/g, '');
}

function noteOf(v) {
  const s = String(v ?? '').trim();
  if (s.length > 200) throw new PlanningError('Not en fazla 200 karakter olabilir.', 400, 'bad-note');
  return s || null;
}

/**
 * DahiliStokHareketKaydetV2'nin bir tek satırı (ortak alanlar; evraktip/tip/cins çağıran ekler). `miktar`: hammaddede kg, bitmiş üründe adet.
 *
 * `sth_tutar: 0`, `sth_miktar2` (= miktar), `sth_birim_pntr: '1'` ARTIK AÇIKÇA gönderiliyor (2026-11-04, SR040.013
 * GİRİŞ denemesi — gerçek, kullanıcının Mikro ekranından elle girdiği bir GİRİŞ virmanı satırıyla karşılaştırılarak
 * bulundu, bkz. product-depot.js başındaki not): ÇIKAN/TRANSFER bu alanlar OLMADAN da kabul ediliyordu (Mikro
 * örtük varsayıyor gibiydi) ama bunları eklemek onları BOZMAZ (gerçek satırların hepsinde zaten bu değerlerle
 * duruyorlar) — üç yöne de (GİRİŞ/ÇIKAN/TRANSFER) eklendi.
 *
 * `evrakSeri` (varsayılan `EVRAK_SERI`="CNCT"): GİRİŞ (tip=0) virman için BOŞ ("") olmak ZORUNDA — bu asıl kök
 * nedendi. "CNCT" ÇIKAN/TRANSFER'de sorunsuz kabul ediliyor (2026-10-29'da gerçek yazmayla doğrulandı) ama
 * GİRİŞ'te hep aynı genel "Stok Hareketi Kaydedilemedi" hatasıyla reddediliyordu; kullanıcının Mikro ekranından
 * elle girdiği GİRİŞ satırında `sth_evrakno_seri=""` idi (ekran boş bırakılınca otomatik numaralıyor), "CNCT"
 * ile DENENMEDEN aynen kopyalanıp denenince İLK seferde kabul edildi (2026-11-04, SR040.013, evrak sıra 236,
 * salt okuma ile doğrulandı). Neden yalnız GİRİŞ'in böyle davrandığı bilinmiyor (muhtemelen Mikro'nun evrak-seri
 * tanım listesi evrak tipine/yönüne göre ayrı tutuluyor) — yalnız GİRİŞ için boş gönderiliyor, ÇIKAN/TRANSFER
 * kanıtlanmış "CNCT"yi korur (kendi yazdığımız kayıtları ayırt etmeye yarıyor).
 */
function baseSatir({ stockCode, miktar, cikisDepoNo, girisDepoNo, now, evrakSeri = EVRAK_SERI }) {
  return {
    sth_stok_kod: stockCode,
    sth_miktar: miktar,
    sth_miktar2: miktar,
    sth_birim_pntr: '1',
    sth_tutar: 0,
    sth_cikis_depo_no: cikisDepoNo,
    sth_giris_depo_no: girisDepoNo,
    sth_evrakno_seri: evrakSeri,
    sth_tarih: isoDate(now),
  };
}

/** `evraklar[]` sarmalayıcısı: `evrak_aciklamalari` EVRAK düzeyinde (satırın İÇİNDE değil) — dokümandaki örnek gövdeyle birebir. */
function wrapEvrak(satir, note) {
  return { evraklar: [{ evrak_aciklamalari: note ? [{ aciklama: note }] : [], satirlar: [satir] }] };
}

export class MikroStock {
  /** @param {{client: import('./mikro-client.js').MikroClient, writeEnabled?: () => boolean}} deps */
  constructor({ client, writeEnabled = () => process.env.MIKRO_WRITE_ENABLED === '1' } = {}) {
    this.client = client;
    this.writeEnabled = writeEnabled;
  }

  configured() { return this.client.configured(); }

  /** Gerçek (iptal/gizli olmayan) depo listesi — canlı okuma, salt SELECT. */
  async listDepots() {
    const rows = await this.client.sqlQuery('SELECT dep_no, dep_adi FROM DEPOLAR WHERE dep_iptal = 0 AND dep_hidden = 0 ORDER BY dep_no');
    return rows.map((r) => ({ depotNo: Number(r.dep_no), name: String(r.dep_adi ?? '').trim() }));
  }

  /** Hammadde (HM%) arama — canlı okuma, salt SELECT; `q` kod ya da isimde geçebilir. */
  async searchMaterials(q, limit = 30) {
    const query = likeTermForMikro(q);
    const top = Math.min(Math.max(Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : 30, 1), 50);
    const sql =
      `SELECT TOP ${top} sto_kod, sto_isim, sto_birim1_ad FROM STOKLAR ` +
      "WHERE sto_kod LIKE 'HM%' AND sto_iptal = 0 AND sto_hidden = 0" +
      (query ? ` AND (sto_kod LIKE '%${query}%' OR sto_isim LIKE '%${query}%')` : '') +
      ' ORDER BY sto_kod';
    const rows = await this.client.sqlQuery(sql);
    return rows.map((r) => ({ stockCode: String(r.sto_kod), name: String(r.sto_isim ?? '').trim(), unit: String(r.sto_birim1_ad ?? '').trim() }));
  }

  /**
   * Depolar arası sevkiyat (transfer) fişinin gönderilecek tam gövdesini hazırlar — GÖNDERMEZ, yalnız kurar/doğrular.
   * RESMİ DOĞRULANDI (Mikro "Tablo Alan Yapıları", 2026-10-29): evraktip=2 "Depo Transfer Fişi", tip=2 "Depo
   * Transfer", cins=6 "Transfer" — üçü de adıyla birebir "depo transferi" anlamına geliyor. Gerçek ilk deneme
   * (2026-10-29, 1 kg, yönetici onayıyla) yine de 400 (boş hata mesajıyla) reddedildi — tip/cins kombinasyonu
   * DOĞRU görünüyor, şüpheli olan eksik bir zorunlu alan (`sth_tutar`, aşağıya bakın).
   */
  previewTransfer({ fromDepotNo, toDepotNo, stockCode, kg, note } = {}, { now = Date.now() } = {}) {
    const from = positiveInt(fromDepotNo, 'Kaynak depo');
    const to = positiveInt(toDepotNo, 'Hedef depo');
    if (from === to) throw new PlanningError('Kaynak ve hedef depo aynı olamaz.', 400, 'same-depot');
    const satir = { ...baseSatir({ stockCode: stockCodeOf(stockCode), miktar: kgAmount(kg), cikisDepoNo: from, girisDepoNo: to, now }), sth_evraktip: 2, sth_tip: 2, sth_cins: 6 };
    const body = wrapEvrak(satir, noteOf(note));
    return { kind: 'transfer', endpoint: 'DahiliStokHareketKaydetV2', body, writeEnabled: this.writeEnabled(), assumed: ['sth_tutar'] };
  }

  /**
   * Bitmiş ürün depo transferi (Merkez <-> Geçici) — hammadde transferiyle AYNI evrak türü (evraktip=2/tip=2/cins=6),
   * yalnız stok kodu ürünün kendi Alen stok kodu ve miktar KG değil ADET (tam sayı). İş emri bitince (Merkez->Geçici)
   * ve paketlenince (Geçici->Merkez) `product-depot.js` tarafından çağrılır; bkz. CLAUDE.md "Bitmiş ürün depo akışı".
   * GERÇEK BİR ÜRÜN STOK KODUYLA HENÜZ DENENMEDİ (yalnız hammadde stok koduyla, 2026-10-29) — evrak türü resmi
   * olarak doğrulandı ve mekanik olarak hammaddeyle birebir aynı, ama ürün stok kartlarının STOKLAR'daki gerçek
   * davranışı (varsa farklı bir kısıt) sahada ilk denemede görülecek.
   */
  previewProductTransfer({ fromDepotNo, toDepotNo, stockCode, qty, note } = {}, { now = Date.now() } = {}) {
    const from = positiveInt(fromDepotNo, 'Kaynak depo');
    const to = positiveInt(toDepotNo, 'Hedef depo');
    if (from === to) throw new PlanningError('Kaynak ve hedef depo aynı olamaz.', 400, 'same-depot');
    const satir = { ...baseSatir({ stockCode: stockCodeOf(stockCode), miktar: pieceCount(qty), cikisDepoNo: from, girisDepoNo: to, now }), sth_evraktip: 2, sth_tip: 2, sth_cins: 6 };
    const body = wrapEvrak(satir, noteOf(note));
    return { kind: 'urun-transfer', endpoint: 'DahiliStokHareketKaydetV2', body, writeEnabled: this.writeEnabled(), assumed: ['sth_tutar'] };
  }

  /**
   * Sarfiyat (stok virman) fişinin gönderilecek tam gövdesini hazırlar — GÖNDERMEZ. Tek depoda GİREN ya da ÇIKAN
   * hareket (çıkış depo = giriş depo = `depotNo`; Mikro'nun "Stok Virman Fişi" ekranı da tek depo alanı + satır
   * başına "Giren Çıkan" seçimi kullanıyor, bkz. CLAUDE.md "Mikro arayüz pencereleri görüldü") — `direction`
   * kullanıcı seçimi, varsayılan `'cikan'` (asıl kullanım alanı sarfiyat) ama `'giren'` de seçilebilmeli.
   * RESMİ DOĞRULANDI (Mikro "Tablo Alan Yapıları", 2026-10-29): evraktip=6 "Stok Virman Fişi", tip 0=Giriş/1=Çıkış,
   * cins=3 "Stok Virman". ÇIKAN (tip=1) GERÇEK bir yazmayla doğrulandı (2026-10-29). GİREN (tip=0) de artık GERÇEK
   * yazmayla doğrulandı (2026-11-04, bitmiş ürün stok koduyla — `previewProductVirman`, bkz. dosya başı ve
   * `baseSatir`): GİREN'de evrak serisi BOŞ olmalı, bu fonksiyon da aynı kuralı uygular. `sth_tutar` (maliyet)
   * HÂLÂ doğrulanmadı (0 kabul ediliyor, "doğru" değer bu mu bilinmiyor).
   */
  previewVirman({ depotNo, stockCode, kg, note, direction = 'cikan' } = {}, { now = Date.now() } = {}) {
    const dep = positiveInt(depotNo, 'Depo');
    if (direction !== 'cikan' && direction !== 'giren') throw new PlanningError('Yön "çıkan" ya da "giren" olmalı.', 400, 'bad-direction');
    // GIRIS'te evrak serisi BOS olmali (bkz. baseSatir'deki not, 2026-11-04 kok neden bulgusu); CIKAN kanitlanmis "CNCT"yi korur.
    const satir = { ...baseSatir({ stockCode: stockCodeOf(stockCode), miktar: kgAmount(kg), cikisDepoNo: dep, girisDepoNo: dep, now, evrakSeri: direction === 'giren' ? '' : undefined }), sth_evraktip: 6, sth_tip: direction === 'cikan' ? 1 : 0, sth_cins: 3 };
    const body = wrapEvrak(satir, noteOf(note));
    return { kind: 'virman', direction, endpoint: 'DahiliStokHareketKaydetV2', body, writeEnabled: this.writeEnabled(), assumed: ['sth_tutar'] };
  }

  /**
   * Bitmiş ürün için stok virman fişi — `previewVirman` ile AYNI evrak türü, yalnız adet (tam sayı). İKİ kullanım
   * alanı: GİREN — iş emri bitince üretilen adet Geçici depoda "doğar" (`product-depot.js` `sendFinishTransfer`,
   * GERÇEK yazmayla doğrulandı: 2026-11-04, SR040.013, 1 adet, evrak sıra 236); ÇIKAN — paketleme formuna HİÇ
   * yansımayacak kalan farkı (sayım/hurda) Geçici depodan düşmek (`clearRemaining`, henüz gerçek üründe
   * denenmedi ama hammaddede 2026-10-29'da ÇIKAN yönüyle doğrulanmış AYNI mekanizma).
   */
  previewProductVirman({ depotNo, stockCode, qty, note, direction = 'cikan' } = {}, { now = Date.now() } = {}) {
    const dep = positiveInt(depotNo, 'Depo');
    if (direction !== 'cikan' && direction !== 'giren') throw new PlanningError('Yön "çıkan" ya da "giren" olmalı.', 400, 'bad-direction');
    // GIRIS'te evrak serisi BOS olmali (bkz. baseSatir'deki not, 2026-11-04 kok neden bulgusu, SR040.013 ile GERCEK yazmayla dogrulandi).
    const satir = { ...baseSatir({ stockCode: stockCodeOf(stockCode), miktar: pieceCount(qty), cikisDepoNo: dep, girisDepoNo: dep, now, evrakSeri: direction === 'giren' ? '' : undefined }), sth_evraktip: 6, sth_tip: direction === 'cikan' ? 1 : 0, sth_cins: 3 };
    const body = wrapEvrak(satir, noteOf(note));
    return { kind: 'urun-virman', direction, endpoint: 'DahiliStokHareketKaydetV2', body, writeEnabled: this.writeEnabled(), assumed: ['sth_tutar'] };
  }

  /**
   * YENİ bir stok kartı oluşturur (`StokKaydetV2`) — numune takibin (`sample-tracking.js`) otomatik ürün kodu
   * oluşturma akışında, oluşturulan Alen kodunun Mikro'da da karşılığı olsun diye (2026-11-13, kullanıcı isteği).
   *
   * RESMİ DOĞRULANDI (apidocs.mikro.com.tr/apis/stok, `StokKaydetV2` ham `.md`, 2026-11-13): `Mikro.stoklar` bir
   * dizi, her öğe `sto_kod`/`sto_isim`/`sto_kisa_ismi`/`sto_birim1_ad`/`sto_cins`/`sto_doviz_cinsi`/
   * `sto_perakende_vergi`/`sto_toptan_vergi` (+ `barkodlar`/`satis_fiyatlari` dizileri) taşıyabilir. Mikro'nun
   * stok kategorisinde bu YAZMA ucu için TEK alternatif yok (`StokListesiV2` salt okuma) — `DahiliStokHareketKaydetV2`
   * ile AYNI yapıda (`stoklar` `Mikro` bloğunun İÇİNDE, `nestInMikro:true`).
   *
   * Vergi/cins gibi doğru değeri bilinmeyen alanlar GÖNDERİLMEZ (Mikro kendi varsayılanını uygulasın; yanlış bir
   * vergi/cins kodu girmekten daha güvenli). **BU UÇ GERÇEK MİKRO'YA KARŞI HENÜZ HİÇ DENENMEDİ** (yalnız resmi
   * dokümantasyondan kuruldu, diğer her yeni yazma türünde olduğu gibi ilk gerçek deneme yönetici ile birlikte
   * yapılmalı — `stoklar` dizisinin gerçekten `StokKaydetV2`'nin beklediği şema olup olmadığı dahil).
   */
  previewCreateProduct({ stockCode, name, unit = 'AD' } = {}) {
    const code = stockCodeOf(stockCode);
    const isim = (String(name ?? '').trim() || code).slice(0, 50);
    const body = { stoklar: [{ sto_kod: code, sto_isim: isim, sto_kisa_ismi: isim.slice(0, 20), sto_birim1_ad: unit }] };
    return {
      kind: 'stok-kart-olustur', endpoint: 'StokKaydetV2', body, writeEnabled: this.writeEnabled(),
      assumed: ['stoklar[] şeması (resmi .md\'den, hiç gerçek yazmayla denenmedi)', 'sto_cins/sto_doviz_cinsi/vergi alanları (gönderilmedi, Mikro varsayılanı)'],
    };
  }

  /**
   * VAR OLAN bir stok kartının net ağırlığını günceller — Mikro'nun stok kategorisinde ayrı bir "güncelle" ucu
   * YOK (yalnız `StokKaydetV2` + okuma ucu `StokListesiV2`, 2026-11-13 doğrulandı), bu yüzden AYNI uç yeniden
   * çağrılır. `sto_birim1_agirlik` alan adı `STOKLAR` okumalarından biliniyor (BR/NT eşlemesi, CLAUDE.md "G
   * aşaması") ama `StokKaydetV2`'nin RESMİ alan listesinde YOK — bu bir TAHMİN.
   *
   * **ÇOK ÖNEMLİ KISIT — yalnız BİZİM OLUŞTURDUĞUMUZ (`sample-tracking.js`'in `auto_generated` kartları) stok
   * kodları için çağrılmalı, Mikro'da BAŞKA bir yolla (Mikro'nun kendi ekranı, Excel/Mikro senkronu) zaten var
   * olan bir kartı GÜNCELLEMEYE ÇALIŞMA:** `StokKaydetV2`'nin gönderilmeyen alanları KORUYUP KORUMADIĞI (kısmi
   * güncelleme) yoksa TAM DEĞİŞTİRME mi yaptığı (gönderilmeyen alanları sıfırlayıp) HİÇ BİLİNMİYOR — tam
   * değiştirme ise, bizim bilmediğimiz bir kartı burada güncellemeye çalışmak onun adını/diğer alanlarını
   * SESSİZCE SİLEBİLİR. `sto_isim`/`sto_kisa_ismi` bu yüzden SAVUNMACI olarak yeniden gönderilir (en azından
   * KENDİ oluşturduğumuz kart için adın kaybolmaması için) ama bu, başka bir kart için güvenli olduğu anlamına
   * gelmez. **BU UÇ GERÇEK MİKRO'YA KARŞI HENÜZ HİÇ DENENMEDİ**; ilk deneme yönetici ile birlikte, kendi
   * oluşturduğumuz bir test numunesiyle yapılmalı.
   */
  previewUpdateProductWeight({ stockCode, name, netKg, unit = 'AD' } = {}) {
    const code = stockCodeOf(stockCode);
    const kg = Number(netKg);
    if (!Number.isFinite(kg) || kg <= 0 || kg > 100) throw new PlanningError('Net ağırlık 0 ile 100 kg arasında bir sayı olmalı.', 400, 'bad-weight');
    const isim = (String(name ?? '').trim() || code).slice(0, 50);
    const body = { stoklar: [{ sto_kod: code, sto_isim: isim, sto_kisa_ismi: isim.slice(0, 20), sto_birim1_ad: unit, sto_birim1_agirlik: round(kg, 4) }] };
    return {
      kind: 'stok-kart-agirlik', endpoint: 'StokKaydetV2', body, writeEnabled: this.writeEnabled(),
      assumed: ['sto_birim1_agirlik (STOKLAR okumasından; StokKaydetV2 resmi şemasında YOK)', 'StokKaydetV2 kısmi mi tam değiştirme mi — bilinmiyor'],
    };
  }

  /** Önceden kurulmuş bir önizlemeyi GERÇEKTEN Mikro'ya yazar — yalnız `MIKRO_WRITE_ENABLED=1` iken (anlık kontrol, önizleme anındaki değil). */
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
