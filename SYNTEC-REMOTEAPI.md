# Syntec RemoteAPI — Adaptör Spesifikasyonu

Kaynak: *RemoteAPI Operation Manual* (Syntec, rev. 2022-05-23).
Bu belge, Edge Agent'ın Syntec 11B tezgahlardan veri okurken kullanacağı API
yüzeyini ve gereksinim belgesinin (CNC-TLM-001) Bölüm 04 veri modeliyle
eşleşmesini tanımlar.

## Mimari

Syntec **Dipole**, insan-makine arayüzünü çekirdekten ayırır; ön uç uygulamalar
kontrolcüye ağ üzerinden bağlanır. Sunucu tarafı kontrolcüde **OCAPIServer**
olarak çalışır.

```
Syntec 11B (OCAPIServer / Dipole)
        │  TCP 5566 · 5568 · 5570 · 5572
        ▼
Edge Agent PC (.NET — RemoteAPI istemcisi)
        │  HTTP POST, normalize JSON
        ▼
backend/  →  dashboard/
```

## Sürüm seçimi

Kontrolcümüz **10.116.54S**. Manual'deki uyumluluk tablosu:

| Kontrolcü sürümü | RemoteAPI | Not |
|---|---|---|
| After 10.116.54.x | 1.2.2 | en yeni |
| After 10.116.54.x | 1.2.1 | "yeni kontrolcülerde kullanım kısıtlamaları kaldırıldı" |
| 10.116.54.x ~ 10.118.60.x | **1.2.0** | `Syntec.OpenCNC.dll` referansı gerekiyor |
| 10.116.54.x ~ 10.118.30.x | **1.1.0** | |

`10.116.54.x` aralığını **açıkça** kapsayan iki sürüm 1.1.0 ve 1.2.0. Pilotta
bunlardan biriyle başlanmalı; 1.2.1/1.2.2 "after 10.116.54.x" diyor, bizim
sürümümüzün o tanıma girip girmediği belirsiz.

## Gereken bileşenler

Projeye referans: `Syntec.RemoteCNC.dll`
Ana programla **aynı klasörde** bulunması gerekenler:

```
Syntec.OpenCNC.dll
Syntec.RemoteCNC.dll
Syntec.RemoteObj.dll
OCAPI.dll
OCUSER.dll
```

Örnek proje: `SyntecRemoteExample` (Syntec tarafından sağlanıyor).

> **Elimizde henüz yok.** Bayiden/ARIX'ten istenecek tek şey bu.

## Ağ gereksinimleri — dikkat

Manual §2.2:

1. **PC tarafında TCP 5568 ve 5570 gelen bağlantıya açılmalı** — *"for the
   controller to connect to the computer"*. Yani kontrolcü de PC'ye bağlantı
   açıyor; akış çift yönlü.
2. PC'de birden fazla ağ kartı varsa, kontrolcüye bağlı olanın **önceliği
   yükseltilmeli**, yoksa bağlantı kurulamıyor.
3. v4 sürümünde ağ kararsızlığında 10 sn sonra yeniden denenmeli.

**Mimari sonucu:** Bölüm 02'deki "tek yönlü, salt-okunur sınır" ilkesi Edge Agent
ile backend arasında geçerliliğini korur, ama **Edge Agent ile tezgah arasında
çift yönlü bağlantı zorunlu.** Bu, Edge Agent'ın atölye (OT) ağında konumlanması
gerektiğini kesinleştiriyor.

## Veri modeli eşlemesi (Bölüm 04)

| Bölüm 04 alanı | Fonksiyon | Dönen alan | Tip |
|---|---|---|---|
| Makine durumu | `READ_status` | `Mode`, `Status` | string (`"MDI"`, `"MEM"` / `"STOP"`, `"START"`) |
| Alarm var mı | `READ_status` | `Alarm`, `EMG` | `"ALARM"` / `"****"`, `"EMG"` / `"****"` |
| Aktif program | `READ_status` | `MainProg`, `CurProg` | string |
| **Spindle devri** | `READ_spindle` | `ActSpindle` | int |
| **İlerleme** | `READ_spindle` | `ActFeed` | float |
| Override oranları | `READ_spindle` | `OvFeed`, `OvSpindle` | float |
| **Parça sayacı** | `READ_part_count` | `part_count`, `Total_part_count`, `require_part_count` | int |
| **Çevrim süresi** | `READ_time` | `CuttingTimePerCycle` | int (sn) |
| Çalışma süreleri | `READ_time` | `PowerOnTime`, `AccumulateCuttingTime`, `WorkTime` | int (sn) |
| Alarm kodu + zamanı | `READ_alm_current` | `IsAlarm`, `AlmMsg[]`, `AlmTime[]` | bool, string[], DateTime[] |
| Duruş nedeni | — | **API'de yok** | operatör girişi |

Alarm mesaj formatı: `("motion" "number" "descriptions")`, dizi yeniden eskiye sıralı.

### Ek olarak kullanılabilecekler

| Fonksiyon | Ne verir |
|---|---|
| `READ_alm_history` | Alarm geçmişi |
| `READ_position` | Eksen koordinatları |
| `READ_plc_sbit` | PLC S bitleri — `S098` (OCAPIServer çalışıyor mu), `S099` (Dipole bağlı mı) |
| `READ_plc_register` | PLC R register'ları |
| `READ_nc_OPLog` | Operasyon logu |
| `DOWNLOAD_work_record` | Uzaktan işleme kaydı dosyası |
| `READ_MakerConfigInfo` | Makine bilgileri |
| `IsDipoleSupported(IPAddr, Timeout)` | Bağlantı ön kontrolü |

Tüm fonksiyonlar `short` döner: **0 = başarılı**, diğerleri hata kodu.

## Adaptör tasarımı

Edge Agent bir döngüde şunları çağırıp `shared/schema.js`'teki sözleşmeye
çevirecek:

```
IsDipoleSupported()  → bağlantı kontrolü
READ_status()        → status, program
READ_spindle()       → spindleRpm, feedRate
READ_part_count()    → partCount
READ_time()          → cycleTimeSec
READ_alm_current()   → alarms[]
        ↓
POST /api/ingest  (normalize JSON)
```

`Status`/`Mode` metinleri şemadaki `RUNNING / IDLE / ALARM / OFF` enum'una
eşlenecek — eşleme tablosu pilot testte gerçek değerler görülünce kesinleşir.

> **Çift kanal:** Tezgah `$1` ve `$2` olmak üzere iki kanallı. API'nin kanal
> bazlı okuma yapıp yapmadığı manual'de netleştirilmeli; şema da kanal başına
> değer tutacak şekilde genişletilmesi gerekebilir.

## Kontrolcü tarafı kurulum

`F5 Maintain → F2 Set Kernel Server → F5 Set Kernel Server` →
**Kernel Server Setting**:

- `Start server while boot` → **açık** olmalı (varsayılan `Close` geliyor)
- `Start Server` ile elle de başlatılabilir
- `Dipole Log` durumu gösterir (`OCAPIServer is not running.` / port listesi)

Yapılandırma dosyası kontrolcüde: `\DiskC\WinCE\Shared\DipoleSettings.xml`

---

## Doğrulama — 2026-09-18, PC Simulator

`tools/syntec-probe` ile 60 saniyelik yakalama yapıldı. Hedef: Syntec'in
**W32 PC Simulator**'ı (`11BLathe_W32_10.116.56Q`), `127.0.0.1`.

Simulator, kontrolcünün çalıştırdığı **aynı `OCAPIServer`'ı** yerelde çalıştırıyor
ve aynı dört portu açıyor (5566/5568/5570/5572). Yani **adaptör makineye gitmeden
geliştirilip test edilebiliyor**; gerçek tezgaha geçiş tek satır IP değişikliği.

### Kontrolcü kimliği (okundu)

```
SeriesNo     : M9A0001          (simulator)
CncType      : 11B
Seri (M/T)   : Lathe
Eksen        : 4  →  X, Y, Z, C
Azami eksen  : 10
NC sürüm     : 10.116.56.17
CncOption    : 4 5
```

### Fonksiyon sonuçları

| Fonksiyon | Sonuç |
|---|---|
| `READ_status` | ✅ 60/60 |
| `READ_spindle` | ✅ 60/60 |
| `READ_part_count` | ✅ 60/60 |
| `READ_time` | ✅ 60/60 |
| `READ_alm_current` | ✅ 60/60 |
| `READ_nc_current_block` | ❌ dönüş kodu **-18** (*Not supported*) |

Bölüm 04 veri modelinin tamamı çalışan beş fonksiyondan karşılanıyor.
`READ_nc_current_block` kritik değildi.

### Gözlenen alan değerleri

```json
"status":    {"MainProg":"", "CurProg":"", "CurSeq":0,
              "Mode":"AUTO", "Status":"READY", "Alarm":"****", "EMG":"****"}
"spindle":   {"OvFeed":100, "OvSpindle":100, "ActFeed":0, "ActSpindle":1000}
"partCount": {"part":0, "required":0, "total":0}
"time":      {"PowerOnTime":782, "AccumulateCuttingTime":0,
              "CuttingTimePerCycle":0, "WorkTime":0}
"alarm":     {"isAlarm":false, "messages":[]}
```

**Verinin canlı olduğunun kanıtı:** `PowerOnTime` her örnekte bir artıyor
(782 → 840 arası 58 sn). `ActSpindle: 1000`, simulator ekranındaki değerle birebir.

| Alan | Gözlenen | Not |
|---|---|---|
| `Mode` | `AUTO` | MDI / JOG / HOME gibi başka değerler de bekleniyor |
| `Status` | `READY` | **çalışırken ne döndüğü henüz bilinmiyor** |
| `Alarm` | `****` | alarm varsa `ALARM` |
| `EMG` | `****` | acil stop varsa `EMG` |

### Açık nokta: `RUNNING` eşlemesi

Yakalama tezgah boştayken yapıldı, elimizde yalnızca `READY` var. Şemadaki
`RUNNING` durumuna hangi `Status` değerinin karşılık geldiği doğrulanmadı.

Kapatma yolu: simulator'da bir program çalıştırıp yakalamayı tekrarlamak, ya da
gerçek tezgahta (Auto/Busy durumdayken) ölçmek.

**Adaptör tasarım kararı:** Tanınmayan bir `Status` değeri sessizce
eşlenmeyecek, **loglanacak**. Beklenmedik bir değer yanlış duruma haritalanmaktansa
görünür olmalı.

### Mimari not: `OFF` durumu API'den gelmez

Kontrolcü kapalıysa bağlantı zaten kurulamaz, dolayısıyla `OFF` bir API cevabı
olarak okunamaz. Şemadaki karşılığı backend'in ayrıca takip ettiği **bağlantı
kopukluğu** (`connected: false`, dashboard'da "Bağlantı yok"). `OFF` enum değeri
şemada kalır ama RemoteAPI üzerinden doldurulmaz.
