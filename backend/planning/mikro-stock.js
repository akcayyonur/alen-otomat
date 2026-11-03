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
 * Depo listesi ve hammadde arama CANLI Mikro okumasıdır (SqlVeriOkuV2, salt okuma, risksiz — zaten doğrulanmış
 * yöntem, bkz. mikro.js). Yazılacak fişin alan DEĞERLERİ (sth_evraktip/sth_tip/sth_cins, evrak serisi) gerçek
 * geçmiş STOK_HAREKETLERI kayıtlarından GÖZLENEN bir örüntüye dayanıyor VE artık en azından transfer için
 * gerçek bir yazmayla da doğrulandı; `assumed` alanı hâlâ `sth_tutar`'ı işaretliyor (maliyet muhasebesi etkisi
 * netleşmedi, 0 kabul edildi ama doğru değer bu mu bilmiyoruz).
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

function kgAmount(v) {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim().replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0 || n > MAX_KG) throw new PlanningError(`Kilo 0 ile ${MAX_KG} arasında bir sayı olmalı.`, 400, 'bad-kg');
  return round(n, 3);
}

function stockCodeOf(v) {
  const s = String(v ?? '').trim();
  if (s === '' || s.length > 40) throw new PlanningError('Hammadde (Mikro stok kodu) seçilmeli.', 400, 'bad-stock-code');
  return s;
}

const MAX_QTY = 1_000_000;
/** Bitmiş ürün (adet) miktarı: kg'dan farklı olarak her zaman tam sayı. */
function pieceCount(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > MAX_QTY) throw new PlanningError(`Adet 1 ile ${MAX_QTY.toLocaleString('tr-TR')} arasında bir tam sayı olmalı.`, 400, 'bad-qty');
  return n;
}

function noteOf(v) {
  const s = String(v ?? '').trim();
  if (s.length > 200) throw new PlanningError('Not en fazla 200 karakter olabilir.', 400, 'bad-note');
  return s || null;
}

/** DahiliStokHareketKaydetV2'nin bir tek satırı (ortak alanlar; evraktip/tip/cins çağıran ekler). `miktar`: hammaddede kg, bitmiş üründe adet. */
function baseSatir({ stockCode, miktar, cikisDepoNo, girisDepoNo, now }) {
  return {
    sth_stok_kod: stockCode,
    sth_miktar: miktar,
    sth_cikis_depo_no: cikisDepoNo,
    sth_giris_depo_no: girisDepoNo,
    sth_evrakno_seri: EVRAK_SERI,
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
    const query = String(q ?? '').trim().replace(/[%_[\]']/g, '');
    const top = Math.min(Math.max(Number(limit) || 30, 1), 50);
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
   * cins=3 "Stok Virman". ÇIKAN (tip=1) GERÇEK bir yazmayla da doğrulandı (2026-10-29, bkz. yukarıdaki not) —
   * GİREN (tip=0) henüz gerçek yazmayla denenmedi, yalnız resmi alan listesinden ve 570 hammadde satırından 1
   * tanesinin bu değeri taşımasından biliniyor. `sth_tutar` (maliyet) HÂLÂ doğrulanmadı.
   */
  previewVirman({ depotNo, stockCode, kg, note, direction = 'cikan' } = {}, { now = Date.now() } = {}) {
    const dep = positiveInt(depotNo, 'Depo');
    if (direction !== 'cikan' && direction !== 'giren') throw new PlanningError('Yön "çıkan" ya da "giren" olmalı.', 400, 'bad-direction');
    const satir = { ...baseSatir({ stockCode: stockCodeOf(stockCode), miktar: kgAmount(kg), cikisDepoNo: dep, girisDepoNo: dep, now }), sth_evraktip: 6, sth_tip: direction === 'cikan' ? 1 : 0, sth_cins: 3 };
    const body = wrapEvrak(satir, noteOf(note));
    return { kind: 'virman', direction, endpoint: 'DahiliStokHareketKaydetV2', body, writeEnabled: this.writeEnabled(), assumed: ['sth_tutar'] };
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
