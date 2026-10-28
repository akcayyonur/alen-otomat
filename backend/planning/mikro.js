/**
 * MIKRO API KAYNAGI: "Kaynak klasoru" (sources.js, Excel dosyalari) ile AYNI is - ayni iceri alma
 * kurallari (importers.js importParsed), ayni sonuc sekli - ama dosya yerine MikroAPI'den canli SQL
 * okuyarak. Iki kaynak PARALEL calisir: biri digerini devre disi birakmaz, kullanici ikisini de
 * deneyip hangisine guvenecegine kendisi karar verir (bkz. CLAUDE.md "Kurulum sonra yapilacak").
 *
 * SIPARIS + URUN KARTI TEK SORGUDA: URUNLER/URUN_RECETELERI (Mikro'nun "Urun Recete" modulu)
 * bu kurulumda tamamen BOS - Alen o modulu hic kullanmiyor. Ama hammadde/agirlik/uretim suresi
 * verisi baska bir yerde YASIYOR: `STOKLAR_USER` (Mikro'nun kullanici-tanimli ozel alan tablosu,
 * `Record_uid = STOKLAR.sto_Guid` ile baglanir) icinde `HAMMADDE`, `TAM_BOY`, `URETIM_SURESI_SN`
 * sutunlari var - Alen ofisinin HALIHAZIRDA kullandigi "_SIPARIS" Excel raporunun SQL'i (kullanici
 * verdi) bunu zaten SIPARISLER+STOKLAR+STOKLAR_USER join'iyle okuyor. Asagidaki sorgu o raporun
 * BIREBIR AYNISI (yalniz bizim importSiparis()'in kullanmadigi raporlama-amacli sutunlar - Mk,
 * ALISIM, FIILI STOK, BIRIM FIYAT, Acik_0 vb. - cikarildi); gercek Mikro PC'sinde dogrulandi
 * (gercek musteri/urun/HM/BR/NT/SN degerleriyle). Tek sorgu hem siparis satirlarini hem urun
 * kartinin hammadde/agirlik/sure ipuclarini verir - importSiparis() bunlari zaten ayni Excel
 * basliklariyla (HM, BR, NT, SN, TAM BOY) okuyordu, burada da degismedi.
 */
import { importParsed } from './importers.js';
import { emptyTotals, emptyChanges, accumulate } from './sources.js';
import { PlanningError } from './errors.js';

const SETTING_LAST = 'mikro.last-refresh';

/** Mikro satirlarini (nesne dizisi) importParsed'in bekledigi {headers, rows} seklime cevirir. */
function toParsed(mikroRows) {
  if (mikroRows.length === 0) return { headers: [], rows: [] };
  const headers = Object.keys(mikroRows[0]);
  const rows = mikroRows.map((r) => headers.map((h) => (r[h] == null ? '' : String(r[h]))));
  return { headers, rows };
}

// Alen ofisinin HALIHAZIRDA kullandigi "_SIPARIS" Excel raporunun SQL'i (kullanici verdi, tahmin degil); yalniz
// bizim importSiparis()'in okumadigi raporlama-amacli sutunlar (Mk, ALISIM, FIILI STOK, GECICI STOK, BIRIM FIYAT,
// TUTAR, Acik_0, "gün top", "brüt toplam", "net toplam") cikarildi. Basliklar (Mamul_Kodu, Evrak_No, HM, BR, NT,
// SN, TAM BOY...) importSiparis()'in zaten bekledigi basliklarla BIREBIR AYNI - bu kasitli, ayri bir eslestirme
// kurali icat edilmedi.
const SIPARIS_SQL =
  "SELECT s.sip_stok_kod AS Mamul_Kodu, dbo.fn_StokIsmi(s.sip_stok_kod) AS Mamul_Adi, " +
  "dbo.fn_EvrNoForm(s.sip_evrakno_seri, s.sip_evrakno_sira) AS Evrak_No, " +
  "s.sip_belgeno AS Must_Sip_No, s.sip_miktar AS Miktar, s.sip_teslim_miktar AS Sevk_Edilen_Miktar, " +
  "(s.sip_miktar - s.sip_teslim_miktar) AS Kalan_Miktar, dbo.fn_CarininIsminiBul(0, s.sip_musteri_kod) AS Musteri, " +
  "CONVERT(varchar, s.sip_tarih, 104) AS Sip_Tarihi, CONVERT(varchar, s.sip_teslim_tarih, 104) AS Teyit_Edilen_Tarih, " +
  "su.HAMMADDE AS HM, (st.sto_birim1_agirlik + st.sto_birim1_dara) AS BR, st.sto_birim1_agirlik AS NT, " +
  "su.URETIM_SURESI_SN AS SN, su.TAM_BOY AS [TAM BOY] " +
  "FROM SIPARISLER s " +
  "LEFT JOIN STOKLAR st ON st.sto_kod = s.sip_stok_kod " +
  "LEFT JOIN STOKLAR_USER su ON su.Record_uid = st.sto_Guid " +
  // "TALAŞ"/"TALAŞ1" serisi gercek musteri siparisi DEGIL - hurda pirinc talasi satisi belgesi (stok PR-001,
  // "PİRİNÇ TALAŞI"; gercek Mikro'da 2026-10-28'de dogrulandi, 231+1 kayit). Sipariş ekraninda gorunmemeli.
  "WHERE s.sip_tip = 0 AND s.sip_evrakno_seri NOT LIKE 'TALA%'";

export class Mikro {
  /** @param {{planning: import('./planning.js').Planning, client: import('./mikro-client.js').MikroClient}} deps */
  constructor({ planning, client }) {
    this.planning = planning;
    this.client = client;
    this.busy = false;
  }

  get #db() { return this.planning.db; }

  configured() { return this.client.configured(); }

  #last() {
    const v = this.#db.getSetting(SETTING_LAST);
    return v ? JSON.parse(v) : null;
  }

  /** Yenilemeden bakilan durum - dosya listesi yerine yalniz yapilandirma + son calismanin ozeti. */
  status() {
    return { configured: this.configured(), host: this.client.host, port: this.client.port, last: this.#last() };
  }

  /** `SELECT TOP 1 ...` ile baglantiyi dener; kurulumda "calisiyor mu" diye hizli kontrol. */
  async test() {
    await this.client.sqlQuery('SELECT TOP 1 sto_kod FROM STOKLAR');
    return { ok: true };
  }

  /**
   * Siparisleri MikroAPI'den okuyup iceri alir (Kaynak klasorundeki ayni importParsed/'siparis' yolu).
   * @param {{by?: string|null, force?: boolean, now?: number}} [opts] force: "Kaynak klasoru"ndeki ile ayni anlamda degil
   *   (burada dosya degisim tespiti yok, her cagri taze SQL okur) - yalniz API ile tutarli imza icin tutuluyor.
   */
  async refresh({ by = null, now = Date.now() } = {}) {
    if (this.busy) throw new PlanningError('Bir Mikro senkronu zaten sürüyor, bitmesini bekleyin.', 409, 'busy');
    if (!this.configured()) throw new PlanningError('MikroAPI yapılandırılmadı (ortam değişkenleri eksik).', 409, 'mikro-not-configured');
    this.busy = true;
    try {
      const totals = emptyTotals();
      const changes = emptyChanges();
      const mikroRows = await this.client.sqlQuery(SIPARIS_SQL, { now: new Date(now) });
      const parsed = toParsed(mikroRows);
      // importParsed kendi beginBatch/finishBatch'ini yapar (importers.js) - burada ikinci kez acilmaz.
      const result = importParsed(this.#db, parsed, 'siparis', { filename: 'MikroAPI · SIPARISLER', by, now, keepOld: true }, { encoding: 'mikro-api', delimiter: null });
      accumulate(totals, changes, result);

      const last = { at: now, by, rows: mikroRows.length, totals };
      this.#db.setSetting(SETTING_LAST, JSON.stringify(last));
      return { source: 'mikro', at: now, totals, changes, rows: mikroRows.length, warnings: result.warnings };
    } finally {
      this.busy = false;
    }
  }
}
