/**
 * MikroAPI istemcisi: Mikro ERP'nin tezgahlarla hicbir ilgisi olmayan, Mikro PC'sinin kendi yerel
 * servisi (varsayilan port 8094, `http://<mikro-pc-ip>:8094`). Yalniz iletisim kurallarini bilir
 * (kimlik dogrulama, hata ayirt etme); hangi tabloyu okuyacagini/neye yazacagini BILMEZ - o is
 * cagiranda (mikro.js, ileride sarfiyat yazma). Node'un yerlesik `fetch`'i kullanilir, bagimlilik
 * eklenmez (projenin "sifir bagimlilik" kurali, bkz. CLAUDE.md).
 *
 * Kimlik dogrulama: her istekte {ApiKey, CalismaYili, FirmaKodu, KullaniciKodu, Sifre} gonderilir.
 * Sifre GUNLUK DONER: MD5("yyyy-AA-gg " + ham sifre) - bu oturumda gercek Mikro PC'sine karsi
 * PowerShell'de dogrulanan formulun aynisi.
 */
import { createHash } from 'node:crypto';
import { PlanningError } from './errors.js';

const DEFAULT_PORT = 8094;
const DEFAULT_TIMEOUT_MS = 20_000;

/** yyyy-AA-gg (yerel saat; Mikro PC'siyle ayni gunde kalmak icin UTC degil). */
function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export class MikroClient {
  /**
   * @param {{host?: string|null, port?: number, firmaKodu?: string|null, kullaniciKodu?: string|null,
   *          sifre?: string|null, apiKey?: string|null, calismaYili?: string|null, firmaNo?: number, subeNo?: number, fetchImpl?: typeof fetch}} opts
   * firmaNo/subeNo: okuma uclarinda (SqlVeriOkuV2) gerekmiyor gibi gorunuyor ama yazma uclarinin (DahiliStokHareketKaydetV2)
   * govde semasinda Mikro bloğunun bir parcasi; gercek STOK_HAREKETLERI kayitlarinin hepsinde sth_firmano=0/sth_subeno=0
   * (tek firma/tek sube kurulumu) oldugu icin varsayilan 0 - bu TAHMIN degil, gercek veriden (2026-10-29).
   */
  constructor({
    host = null, port = DEFAULT_PORT, firmaKodu = null, kullaniciKodu = null, sifre = null,
    apiKey = null, calismaYili = String(new Date().getFullYear()), firmaNo = 0, subeNo = 0, fetchImpl = fetch,
  } = {}) {
    this.host = host;
    this.port = port;
    this.firmaKodu = firmaKodu;
    this.kullaniciKodu = kullaniciKodu;
    this.sifre = sifre;
    this.apiKey = apiKey;
    this.calismaYili = calismaYili;
    this.firmaNo = firmaNo;
    this.subeNo = subeNo;
    this.fetchImpl = fetchImpl;
  }

  /** Baglanti icin gereken her sey dolu mu (host dahil - ayar yoksa Mikro kaynagi sessizce "yapilandirilmadi" sayilir). */
  configured() {
    return Boolean(this.host && this.firmaKodu && this.kullaniciKodu && this.sifre && this.apiKey);
  }

  /** O anki (ya da verilen) tarih icin gunluk sifre hash'i. */
  sifreHash(now = new Date()) {
    return createHash('md5').update(`${dateKey(now)} ${this.sifre}`).digest('hex');
  }

  /**
   * `endpoint` ör. "SqlVeriOkuV2"; `body` metodun kendi alanlari (ör. {SQLSorgu}). Hem HTTP hatasini
   * hem govde-ici `IsError:true`'yu (gercek Mikro PC'sinde gorduk: HTTP 200 icinde hata donebiliyor)
   * ayni PlanningError'a cevirir.
   *
   * `nestInMikro`: Mikro'nun uclari KENDI ICINDE TUTARSIZ — `SqlVeriOkuV2` `SQLSorgu`'yu `Mikro`
   * bloğunun DIŞINDA bekliyor (varsayılan, `false`); `DahiliStokHareketKaydetV2` ise `evraklar`'ı
   * `Mikro` bloğunun İÇİNDE bekliyor (`true`) — ikisi de GERÇEK Mikro'ya karşı ölçüldü (2026-10-29):
   * `SqlVeriOkuV2`'ye `SQLSorgu` içeride gönderilince "SQLSorgu parametresi gönderilmelidir!" hatası,
   * `DahiliStokHareketKaydetV2`'ye `evraklar` içeride gönderilince GERÇEK BAŞARILI kayıt (daha önceki
   * 8 deneme hep DIŞARIDA gönderip hep aynı boş `StatusCode:400` hatasını almıştı). Çağıran hangisini
   * istediğini bilmeli; varsayılan `false` okuma yolunu (zaten çalışan) değiştirmez.
   */
  async call(endpoint, body = {}, { now = new Date(), timeoutMs = DEFAULT_TIMEOUT_MS, nestInMikro = false } = {}) {
    if (!this.configured()) throw new PlanningError('MikroAPI yapılandırılmadı (ortam değişkenleri eksik).', 409, 'mikro-not-configured');
    const url = `http://${this.host}:${this.port}/Api/apiMethods/${endpoint}`;
    const auth = {
      ApiKey: this.apiKey, CalismaYili: this.calismaYili, FirmaKodu: this.firmaKodu, FirmaNo: this.firmaNo, SubeNo: this.subeNo,
      KullaniciKodu: this.kullaniciKodu, Sifre: this.sifreHash(now),
    };
    const payload = nestInMikro ? { Mikro: { ...auth, ...body } } : { Mikro: auth, ...body };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: ctrl.signal,
      });
    } catch (err) {
      throw new PlanningError(`MikroAPI'ye ulaşılamadı (${this.host}:${this.port}): ${err.name === 'AbortError' ? `yanıt vermedi (${Math.round(timeoutMs / 1000)} sn)` : err.message}`, 502, 'mikro-unreachable');
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    // Once HTTP durumuna bak: hatali bir yanit (ör. IIS'in 500 sayfasi) sik sik JSON DEGILDIR - JSON.parse'in
    // once calisip "bozuk yanit" demesi gercek HTTP hatasini maskeler.
    if (!res.ok) throw new PlanningError(`MikroAPI hatası (HTTP ${res.status}): ${text.slice(0, 300)}`, 502, 'mikro-http-error');
    let body2;
    try { body2 = JSON.parse(text); } catch { throw new PlanningError(`MikroAPI beklenmeyen yanıt verdi (HTTP ${res.status}).`, 502, 'mikro-bad-response'); }
    const first = Array.isArray(body2.result) ? body2.result[0] : body2;
    if (first?.IsError) throw new PlanningError(`MikroAPI: ${first.ErrorMessage || 'bilinmeyen hata'}`, 502, 'mikro-api-error');
    return first;
  }

  /** `sql` bir SELECT; sonuc satirlarini (nesne dizisi) dondurur. */
  async sqlQuery(sql, opts) {
    const r = await this.call('SqlVeriOkuV2', { SQLSorgu: sql }, opts);
    return r?.Data?.[0]?.SQLResult1 ?? [];
  }
}
