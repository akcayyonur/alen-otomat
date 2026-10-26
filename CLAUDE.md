# CNC Telemetri Platformu — proje kılavuzu

Fabrikadaki CNC tezgahlardan canlı üretim verisi okuyup gerçek zamanlı bir
dashboard'da gösteren uygulama. Gereksinim belgesi: `cnc-telemetri-gereksinim.html`
(CNC-TLM-001). Bu dosya, projeye sıfırdan giren bir oturumun ihtiyacı olan her
şeyi içerir.

---

## 1. Fabrikanın durumu

- **7 adet CNC torna**, hepsi aynı: ARIX T-42CL gövde, **SYNTEC 11B** kontrolcü,
  yazılım **10.116.54S**, Windows CE / AM335x ARM.
- **IP planı (2026-10-07, `config/machines.json`):** CNC-01..08 = 192.168.88.**91 · 92 · 93 · 94 · 98 · 96 · 99 · 97**.
  Şu an yalnız **.98 = CNC-05** ve **.99 = CNC-07** tornalarda verildi, diğerleri atanacak. Bu belgenin eski bölümlerinde
  .98 tornası "CNC-08" (ve .99 "1. torna") diye geçer: IP'ler doğru, numaralandırma o gün öyle anılmıştı; gerçek tezgahtan
  alınan kayıtlar (`gercek.db`, kütüphane taramaları, aktarım kayıtları) eski adıyla (CNC-08) duruyor. CNC seri
  numaraları IP'ye bağlı kanıtla taşındı: M4L0007 (.98 → CNC-05), M9L4379 (.99 → CNC-07).
- **Sonradan öğrenildi (2026-10-07): 8 tezgahın biri farklı kontrolcü ailesi, SYNTEC 22TB** (model 22B, yazılım
  10.118.88T). Ayarlar ekranında her tezgaha model (11TB / 22TB) seçilir. Bkz. §3 "22TB ailesi".
- Tezgahlar ofisten uzakta. **Sık sık makine başına gidilemiyor** — bu kısıt
  mimariyi belirledi (aşağıda "makineye gitmeden doğrulama").
- Kablolama kararı: her panelden ofise Ethernet çekilecek, ofiste switch'te
  birleşecek, tek PC'ye bağlanacak. (WiFi köprü seçeneği değerlendirildi ve
  elendi: 2.4 GHz'de VFD gürültüsü, kopma = veri boşluğu.)

---

## 2. Mimari — en önemli kısım

```
[ Tezgah ]
   │  Syntec RemoteAPI / Dipole, TCP 5566·5568·5570·5572
   │  ← Syntec DLL'leri YALNIZCA burada
   ▼
[ Edge Agent ]  tools/syntec-agent/  (C#, .NET 4.0, x86, Windows)
   │
   │  HTTP POST, düz JSON  →  /api/ingest
   ▼
[ Backend ]  backend/  (Node, sıfır bağımlılık)  →  SQLite
   │
   │  SSE  →  /api/stream
   ▼
[ Dashboard ]  dashboard/  (vanilla JS, build yok)
```

**Sınır kuralı:** DLL'ler ve marka bilgisi ajanda kalır. Backend hangi marka
panel olduğunu bilmez; yalnızca `shared/schema.js`'teki normalize sözleşmeyi
görür. Yarın bir Fanuc tezgah gelirse FOCAS ajanı yazılır, backend'de tek satır
değişmez. Bu, gereksinim belgesi Bölüm 02/05'in gereği.

**Sürücü kaydı:** `config/drivers.json` hangi protokollerin desteklendiğini
`supported` / `experimental` / `planned` olarak tutar. Ayarlar ekranı `planned`
olanı **seçtirmez** — ajanı yazılmamış bir protokol için müşteriye söz verilmez.

**Kontrolcü modeli (11TB / 22TB):** aynı sürücü (`syntec-remoteapi`) iki Syntec ailesinin RemoteAPI'sini konuşur;
fark Syntec'in istemci paketidir (§3 "22TB ailesi"). `config/drivers.json` sürücüye `models` ekler
(`clientDll`, `agentDir`, `status`, `fileTransfer.sendEnabled`); envanterde tezgah başına isteğe bağlı
`controllerModel` ("11TB" / "22TB"; boş = sürücünün `defaultModel`'i, yani 11TB). Model seçilince
`controller` / `controllerPanel` / `softwareVersion` kimlik alanları modelden gelir (tezgahın kendi değeri ezer).
Her model için **ayrı ajan süreci** çalışır ve yalnız kendi modelindeki tezgahları okur.

**Program kütüphanesi ve tezgaha aktarım (yazma yolu):** telemetri yolundan (ajan →
ingest → dashboard, tek yönlü, salt okunur) **tamamen ayrı** bir yol: `backend/programs/`,
`/api/library/*`, `/api/transfers/*`, `/api/machines/:id/programs*`, ayrı veritabanı
(`data/library.db`). Telemetri kodu bu modülü import etmez. Taşıma **FTP**'dir
(Syntec SDK'nın dosya yolu klasöre yazamıyor, bkz. §3); backend tezgahın Windows CE FTP
sunucusuna doğrudan bağlanır, Syntec DLL'i gerekmez. Gereksinim belgesindeki "salt okunur
sınır" bu özellik için **bilinçli olarak** gevşetildi (fabrika sahibi kararı, 2026-10-07).
Ayrıntı ve güvenlik kuralları: §6 "Program kütüphanesi ve aktarım".

---

## 3. Doğrulanmış olanlar (ve olmayanlar)

### ✅ Gerçek tezgahta doğrulandı — 2026-09-18, 192.168.88.99

`ornek-veri/syntec-192.168.88.99-20260918-163538.csv` — tezgah **keserken**
alınmış 104 örnek, 2 dakika. Bu dosya projenin referans gerçeğidir.

| Alan | Gözlenen |
|---|---|
| `Status` | **`START`** (104/104, çalışırken) → `RUNNING` eşlemesi **doğrulandı** |
| `Mode` | `AUTO` |
| `Alarm` / `EMG` | `****` (olay yokken); olay varsa `ALARM` / `EMG` |
| `MainProg` / `CurProg` | `140100187` — `O1234.NC` değil, düz numara |
| `ActSpindle` | 600–2000 rpm, **çevrim içinde değişiyor** |
| `ActFeed` | 0–18057 mm/dk (kesme düşük, G00 çok yüksek) |
| `Parca` | 1298 → 1303 (2 dakikada 5 parça, ~24 sn/parça) |
| `ToplamParca` | 11400 → 11405 (ömür boyu sayaç) |
| `GerekenParca` | **hep 0** — hedef tanımlı değil, `null` olarak gönderilir |
| `CycleTime` | 15→26→0 döngüsü — **o anki çevrimde geçen süre**, biten çevrimin süresi DEĞİL |
| `PowerOnTime`/`AccumCutTime`/`WorkTime` | saniyede 1 artıyor |

### ✅ PC Simulator'da doğrulandı
Tezgah boştayken `Status` = `READY` → `IDLE` eşlemesi.

### ❌ Desteklenmiyor
`READ_nc_current_block` → dönüş kodu **-18 (Not supported)**. İşlenen NC satırı
okunamıyor; `block` alanı her zaman `null`. Sürücü kaydında "okunuyor" diye
sayılmaz.

### ⚠️ Henüz bilinmiyor
- Gerçek tezgahta **boşta/alarm** durumunda ne döndüğü (yakalama hep RUNNING'di).
- `OFF` durumunun nasıl görüneceği (muhtemelen bağlantı kopar → `NO_DATA`).

### 🔑 Syntec API sunucusunun oturum kuralları (simülatörde ÖLÇÜLDÜ, 2026-10-06)

- **Bir sunucu AYNI ANDA EN FAZLA 4 OTURUM taşır.** Her oturum 5566/5568/5570/5572'ye
  **birer TCP bağlantısı** açar (= 4 bağlantı; portlar bu yüzden 4). 4 oturum açıkken 5.
  oturum (ister aynı süreçten ister başka süreçten) **bağlanamaz**. Torna başına 1 ajan
  oturumu yeterli → 7 tornayı tek süreçte yönetmek sorun değil (her torna ayrı sunucu).
- Süreç ani öldürülünce (TCP kapanınca) sunucu oturumu serbest bırakır (8 süreç denendi).
  **Kablo oturum açıkken çekilirse FIN gitmez** → torna oturumu "açık" sanıyor olabilir
  (`TimeOut=0`); yuvalar dolarsa yeni oturumlar hizmet almaz. **Oturum açıkken kablo çekme.**
- `SyntecRemoteCNC` **IDisposable**: oturum yalnızca `Close()`/`Dispose()` ile kapanır.
  Eski `YenidenBaglan` var olmayan `DisConnect` arıyordu → **eski oturum hiç kapanmıyor,
  her yeniden bağlanmada bir yuva sızıyordu** (4'te sunucu kapanır). Düzeltildi:
  `SyntecReader.Kapat()` + `Agent.KapatArkaPlanda` (zaman aşımlı), yeniden bağlanma
  geri çekilmeli (10→20→40→60 sn), kapanışta `KapatHepsi`.
- `Close()` bazen **takılıyor** (bir süreçte global kilit tutar, sonraki nesneler de bekler)
  ve süreç **çıkışta kilitleniyor** (probe sağlıklı tornada bile 5 dk "çalışıyor" kaldı,
  Ctrl+C ölmedi) → ajan/probe işini bitirince `TerminateProcess` ile çıkar (`SertCikis`).
- Takılan okumadan sonra yeni oturum açmak yuva yer: `MaksTakili = 3` (4 değil).
- **Aynı torna için aynı anda en çok 2 istemci: telemetri ajanı + (varsa) aktarım servisi.** Her süreç
  kendi oturumunu (4 TCP) açar. Ajan + probe/test aracı gibi başka istemcileri aynı anda açma: yuva yer.
  Aktarım servisi oturumu yalnızca iş sırasında açar, zaman aşımlı kapatır ve sert çıkar.

### 📁 NC program aktarımı (SDK) — PC Simulator'da ÖLÇÜLDÜ, 2026-10-07

Henüz gerçek tornada denenmedi. Ortam: PC Simulator'ı **kısa yoldan** çalıştır (`C:\Users\akcay\simtest`);
`OCAPIServer`/`CncMon32` uzun yolda (scratchpad) `MSVCR80.dll` içinde `0xC000000D` ile çöker.

- `READ_nc_mem_list(out string[][])`: yalnız **kök** dizin. Satır = `[ad, boyut, zaman, FILE|DIRECTORY]`.
  Klasörler satır olarak görünür ama **içi listelenemez**. `READ_nc_freespace(out long)` bayt cinsinden.
- `UPLOAD_nc_mem(yerelYol)` = **PC→tezgah**. Dosya her zaman `NcFiles` **köküne**, yerel dosya adıyla düşer;
  **klasör korunmaz** (yerel `ZZMUSTERI\ZZT002` → kökte `ZZT002`). **Aynı ad varsa SESSİZCE EZER**
  (rc=0, hata=0). Klasör yolu verilirse yerel kütüphane **çöker**, tezgahta değişiklik olmaz.
  Tamamlanma: `isFileUploadDone`, `FileUploadErrorCode`, ilerleme (`Current/Total`).
- `DOWNLOAD_nc_mem(ad, yerelKlasör\)` = **tezgah→PC**. Hedef **klasör olmalı ve `\` ile bitmeli**; dosya
  yolu verilirse süreç **çöker** (MSVCR80 `0xC000000D`). Alt klasördeki dosya okunamıyor: `ZZMUSTERI\ZZT009`
  çöker, `\ZZMUSTERI\ZZT009` / `/…` / `NcFiles\…` hata `-16` (olmayan dosyayla aynı).
- **Gidiş-dönüş bayt bayt eşit** (122 bayt, aynı SHA-256; CRLF, satır sonu boşlukları ve sondaki boş
  satırlar korunuyor).
- `DEL_nc_mem(ad)`: kök dosyayı siler; **olmayan dosyada da `rc=0`** (varlık dönüş kodundan anlaşılmaz).
- Ad kuralları: `ZZ-T-003` (harf+tire), yalnız rakam, boşluklu, 41 karakter kabul edildi (simülatör NTFS;
  Windows CE daha kısıtlı olabilir, gerçek tornada denenmeli).
- **Herkese açık API (`SyntecRemoteCNC`) tek başına yetmez** (klasör yok, kök dizin). **AMA** aynı DLL'in
  içinde, klasörleri destekleyen **gizli** işlevler var; `SyntecRemoteCNC` onları gizli `m_RemoteObj`
  (`Syntec.Remote.SyntecRemoteObj`, `internal`) alanında tutuyor ve `Syntec.OpenCNC.OcApiTCP` içindeki
  tutamaçlı `MultiTCP…` işlevleri aynı oturumun `m_TCPClientLink` tutamacıyla çağrılabiliyor
  (yansıma, ek oturum açmaz). Simülatörde **uçtan uca çalıştı** (hepsi 2026-10-07):
  - `RemoteObj.GetCncDirFilesInfo(dir, out string[][])`: **klasör içini listeler** (`""`=kök,
    `"MUSTERI_A"`=müşteri klasörü; olmayan klasörde `-1` → klasör varlığı da buradan anlaşılır).
    `NcGetDirs("NcFiles")` kök yolunu verir (simülatörde `…\Bin\..\NcFiles`).
  - **Yazma = köke yükle → doğrula → klasöre taşı:** `UPLOAD_nc_mem` (kök) → `DOWNLOAD_nc_mem` (kökten
    geri oku, SHA-256 kıyas) → `OcApiTCP.MultiTCPFileMove(link, kaynak, hedef, ref int ok, ref ErrorCode)`
    (`NcDir\ad` → `NcDir\MUSTERI\ad`). Taşıma **hedefte aynı ad varsa REDDEDER** (`IsSuccess=0`, ezmez).
    Taşıma aynı zamanda yeniden adlandırır: önce **benzersiz geçici adla** yükleyip doğrulayıp
    sonra nihai ada taşımak, kökte ad çakışmasını ve "yarım dosya nihai adla görünür" sorununu çözer.
  - **Klasörden okuma = tezgahta köke geçici kopya → indir → geçici kopyayı sil:** `MultiTCPFileCopy`,
    `DOWNLOAD_nc_mem`, `MultiTCPFileDelete`. (`DownloadNCFile("KLASOR\ad", …)` doğrudan **çöker**.)
  - `MultiTCPFileNew(yol)` boş **dosya** yaratır, klasör YARATMAZ → **yeni müşteri klasörü SDK ile
    açılamaz** (panelden ya da FTP ile açılmalı). `FileUpload`'a klasörlü hedef verilirse `-16`.
  - Tutamaçsız `OcApiTCP.TCPFileExists/TCPDirExists/TCPFileMove` oturuma bağlı değil, hep `False`.
  - Mekanizma (IL'den): `UploadNCFile` yalnızca `Path.GetFileName(kaynak)` kullanır (klasör bu yüzden
    düşer), dosyayı sunucunun `…\ServerTmp\Tmp\NcFiles\` dizinine yollar, sonra `MultiTCPInstall(link,
    TModifyMethods)` sunucuya "bayrağa göre kur" der. **`TModifyMethods` bayrakları: `NCFILE=32` ama
    `SOFTWARE`, `PLC`, `PARAMETER`, `SYSDATA`, `MACRO`, `REGISTRY`… da var: yalnızca `NCFILE`; ASLA
    başkası.** `UploadNCFile`/`DelCncFile` kendi içinde `Status=="START"` + `CurProg` koruması taşır,
    `MultiTCPFileMove/Copy/Delete` taşımaz: çalışan/seçili programa dokunmama kuralı bize ait.
  - **Hepsi yansımayla gizli üyelere dayanır** (DLL sürümü 10.116.56.17'ye bağlı; DLL'leri biz
    paketlediğimiz için sabit). **Gerçek torna 8'de (192.168.88.98, 10.116.54S) salt okunur
    `GetCncDirFilesInfo` ÇALIŞTI** (2026-10-07, 6 sn, takılma yok, işlem sonunda açık bağlantı 0):
    `NcGetDirs("NcFiles")` = `\DiskA\OpenCNC\NcFiles`; kökte 10 müşteri klasörü + 7 dosya
    (`MDIBlock` sistem/MDI tamponu, kökte `O9001` 244 bayt ortak alt program, 5 müşterisiz program).
    Müşteri adları ve klasör başına sayılar **bu belgeye yazılmadı (depo herkese açık)**.
    Program adı kalıpları: `SR001-018`, `NI002-001`, `O0179`, `140100187`, `MUSTERI-001` (en çok ~2,3 KB).
    **`rc=-1` ÇÖZÜLDÜ (klasörler boş DEĞİL):** `-1` dönen 5 klasörün 4'ü 44-98 dosya, biri >100 dosya
    içeriyor; küçük klasörler (1-9 dosya) sorunsuz listelendi. Sebep sınıflandırması:
    - **Bozuk zaman damgası:** bu klasörlerdeki dosyaların `ftLastWriteTime` değeri çoğunlukla
      geçersiz/anlamsız (yıl 3125…9279; bir klasörde 44/44, bir başkasında 87/88 geçersiz). Gizli sarmalayıcı
      `SyntecRemoteObj.GetCncDirFilesInfo` `DateTime.FromFileTimeUtc`'de patlayıp **`-1`** döndürüyor.
      Çözüm: sarmalayıcıyı atla, **`CKrnlAPI.MultiTCPNcGetDirFilesInfo(link, nLength, yol)`**'u doğrudan
      çağır (`yol = NcGetDirs("NcFiles") + "\" + klasör`) ve `TMyFileInfo` alanlarını (`cFileName`,
      `nFileSizeLow/High`, `dwFileAttributes` 0x10=klasör, `FileDescription`) kendin çöz. **Gerçek
      tornada dosya zamanına GÜVENME**, yalnız ad/boyut/içerik SHA'sı.
    - `nLength` bir **üst sınırdır** (kesilir, hata vermez): 5 istenince 5 kayıt döner. Wrapper 800 verir.
    - **Yanıt boyutu sınırı (~64 KB, ≈100-120 kayıt):** en büyük klasörde `nLength=100` geldi, `200` **`null`**
      döndü ve ardından oturumdaki sonraki çağrılar da anında `null` (oturum bozuluyor → kapatıp yeniden
      aç). İsim-yalnız `MultiTCPNcGetDirFiles` çıktıyı **1024 karakterde keser**. Dizin yoluna joker
      (`KLASOR\1*`) **işe yaramıyor**. Yani **~100'den büyük klasör API ile tam listelenemiyor**; büyük
      klasörler için FTP `NLST/LIST` (kök=`NcFiles`) gerekecek (henüz torna 8'de denenmedi).
    **İlk gerçek yazma denemesi (torna 8, ÜRETİM SIRASINDA, kullanıcı izniyle, 2026-10-07, 2 deneme):
    BAŞARISIZ, tornada değişiklik YOK.** Tüm ön kontroller geçti (durum `START`/`AUTO`, alarm yok, boş
    yer 3,7 MB, hedef klasör var, ad çakışması yok). `UPLOAD_nc_mem` `rc=0` döndü ama aktarım hiç
    başlamadı (`isFileUploadDone=False`, ilerleme `0/0`); kütüphane ilk 4 bağlantıdan sonra
    **5572'ye (FileTransfer) ~1-2 sn'de bir yeni TCP bağlantısı açıp bırakıyor** (45 sn'de ~35 kez):
    torna bağlantıyı kabul ediyor ama aktarım başlamıyor. Kalıntı yok (salt okunur kök listesiyle
    doğrulandı). Sebep bilinmiyor: (1) sunucu üretim sırasında (`START`) dosya aktarımını reddediyor
    olabilir, (2) tornada hazırlık dizini `\DiskC\ServerTmp\Tmp\NcFiles` olmayabilir, (3) başka.
    **Boştayken (`READY/STOP`) henüz denenmedi**, bu iki ihtimali ayırır. `UploadNCFile`'ın kendi
    koruması yalnızca "START iken ÇALIŞAN programın adıyla yükleme"yi reddeder (`return 17`), başka
    adla yüklemeyi engellemez (IL'den). Gerçek tornada `DEL_nc_mem` **olmayan dosyada zaman aşımına
    uğrar** (simülatörde `rc=0` idi): silmeden önce listeyle varlığı doğrula. Taşıma/kopyalama
    gerçek tornada henüz denenmedi (yükleme geçmediği için). Araç: `TornaYaz.cs` (`kontrol` /
    `gonder` / `gonder-calisirken`; ön kontroller + geçici ad + SHA + taşıma + son yerinde doğrulama).
    **FTP (torna 8, 2026-10-07, YALNIZ OKUMA ile yoklandı, yazma denenmedi):** port 21 açık, anonim giriş
    (`331`/`230`), sunucu `Windows_CE version 7.0`, kök = `NcFiles` (`CWD AA` çalışır). `HELP` komutları:
    `USER PASS QUIT PORT PASV TYPE RETR STOR RNFR RNTO DELE CWD XCWD LIST NLST SYST HELP NOOP MKD XMKD
    RMD XRMD PWD XPWD CDUP XCUP MODE STRU` (SIZE/MDTM/FEAT/APPE/REST YOK). `LIST` biçimi DOS tipi
    (`MM-DD-YY HH:MM <DIR>|boyut ad`). **FTP, API'nin başaramadığını yapıyor:** 207 dosyalı klasör
    tam listelendi (API ~100'de takılıyordu), dosya tarihleri GEÇERLİ (API'de bozuktu), boş klasör
    `LIST` ile 0 satır, `MKD` ile yeni müşteri klasörü açılabilir, `STOR` + `RNFR/RNTO` ile geçici
    adla yükleyip nihai ada çevirmek mümkün. SMB (445/139) torna 8'de KAPALI.
    **FTP YAZMA UÇTAN UCA ÇALIŞTI (torna 8, ÜRETİM SIRASINDA, 2026-10-07, ilk denemede):** anonim
    kullanıcı yazabiliyor. `curl.exe -T kaynak ftp://IP/KLASOR/ZZUPxxxxxx` (`TYPE I` + `STOR`, `226`)
    → `LIST` (boyut doğru) → `RETR` ile geri oku, SHA-256 ESIT → `-Q "+RNFR ZZUPxxxxxx" -Q "+RNTO NIHAIAD"`
    (`350`/`250`; `+` öneki komutu `CWD`'den SONRA gönderir) → `LIST` (nihai ad var, geçici yok) → `RETR`
    ile son yerinde SHA-256 ESIT. 1555 bayt, ~birkaç sn, API yuvası kullanmadı, tornada kalıntı yok.
    **Bu yüzden aktarım yolu FTP; SDK yalnız durum okuma için.** Denenmedi: `RNTO`'nun hedefte aynı ad
    varken ezip ezmediği (öncesinde `LIST` ile çakışma denetimi ŞART, ezme varsayılması yasak), `MKD`/`RMD`,
    `DELE`. SDK'yı atladığı için kontrolcü korumaları (çalışan programı koruma) yoktur: durum, seçili
    program ve ad çakışması denetimi bizde. Yükleme `TYPE I` (ikili) ile yapılmalı. FTP, API oturum
    yuvası (4 sınırı) tüketmez. Klasöre düşen program AKTİF olmaz; operatör panelden seçer.
  - Yerel kütüphane yanlış argümanda **try/catch'in yakalayamadığı şekilde süreci düşürür**
    (`MSVCR80 0xC000000D`): aktarım ayrı süreçte çalışmalı, yalnızca burada doğrulanan çağrı biçimleri
    kullanılmalı. Aktarım kodunda `WRITE_nc_main`, `RemoteProgExecute`, `UPLOAD_software/plc_file/
    param_file`, `WRITE_macro_*`, `FileUpload` (gizli) ve `MultiTCPInstall` ASLA geçmemeli.

### 🆕 22TB ailesi (SYNTEC 22B, yazılım 10.118.88) — PC Simulator (2026-10-07) + GERÇEK tornada okuma (2026-10-08)

**GERÇEK 22TB tornası (CNC-08, 192.168.88.97), 2026-10-08, ~4 dk, ajan `--model 22TB`, tek istemci, YALNIZ OKUMA:**
- **Kimlik:** `SeriesNo M1R11926`, `MainBoardPlatformName i.MX6-H` (11TB'de `AM335x-H`: farklı donanım), `CncType 22B`,
  `NcSurum 10.118.88.20`, `CncOption 5 32 45 52 54`, 4 eksen (azami 6), `Seri Lathe`. İlk oturumda tam geldi (restart gerekmedi).
- **Portlar:** 21 (FTP), 5566, 5568, 5570, 5572 açık. **Bir oturum 5 TCP açıyor** (5566, 5568, **5570 ×2**, 5572); 11TB'de 4.
  Sunucunun oturum sınırı (11TB'de 4 oturum) 22B'de ÖLÇÜLMEDİ: torna başına tek ajan istemcisi kuralı aynen geçerli.
- **Okuma:** 193 okuma = 193 gönderim, 0 düşen, takılma yok. Ham `Status=START` → RUNNING (11TB ile aynı sözlük,
  `/api/health` `statusMapping: RUNNING<-START`), `Mode=AUTO`, `Alarm/EMG=****`. Program adı 12 haneli (`6014…`),
  mil 0…2000 arasında değişiyor (işlem arasında 0), ilerleme değişiyor, `partTarget` null, parça sayacı 212 → 213
  (çevrim süresi 75 → 4'e sıfırlandı, ~80 sn/parça), güç/kesme süreleri artıyor.
- **FTP:** 11TB ile AYNI diyalog (anonim `331`/`230`, `EPSV`, `125`/`226`); kök 9 girdi (3 klasör), kendi istemcimizle `LIST` 73 ms,
  ürünün "Tezgahtaki programları tara"sı 1,1 sn, 38 girdi, uyarı yok. **Yazma (STOR/RNFR/RNTO) denenmedi.**
- **Hâlâ bilinmeyenler:** uzun süreli kararlılık (yalnız ~4 dk), boşta/alarm ham değerleri, FTP'de yazma ve aynı ada `RNTO`
  davranışı. Bu yüzden 22TB'de gönderme KAPALI kalır (aşağıda); durum `experimental`.

*(Aşağıdaki simülatör bulguları geçerlidir.)*

### 22TB ailesi — PC Simulator ayrıntıları, 2026-10-07

8 tezgahın biri farklı bir kontrolcü ailesi: panelde **SYNTEC 22TB** (System Data ekranı: kontrolcü modeli
**22B**, yazılım **10.118.88T**). Syntec paketi `22BLathe_W32_10.118.88Z` (11TB'ninki: `11BLathe_W32_10.116.56Q`).
Ayarlar ekranında her tezgaha **model** (11TB / 22TB) seçilir; sürücü aynı (`syntec-remoteapi`).

**Paket farkları (ikilide ve yansımayla ölçüldü, kod çalıştırmadan):**
- 22B paketinde **`Syntec.RemoteCNC.Win32.dll` YOK.** Aynı `Syntec.Remote.SyntecRemoteCNC` sınıfı
  **`Syntec.OpenCNC.dll`'in içine taşınmış** (sürüm 10.118.88.26). 11B paketinde de bir `Syntec.OpenCNC.dll` var
  ama bu sınıfı İÇERMEZ: DLL'in varlığı değil, içindeki sınıf ayırt eder.
- `READ_status/spindle/part_count/time/alm_current/nc_current_block/information`, `isConnected`, `Close`, `Dispose`,
  kurucu(`string`) ve `SeriesNo/MainBoardPlatformName/CncOption` imzaları **birebir aynı** → ajanın okuma
  kodu (`SyntecReader`) değişmedi; yalnız yüklenen DLL'in adı değişir (`--model` / klasörden).
- 22B yerel DLL'leri (OCApi/OCUser) yalnız sistem DLL'lerine bağlı: **Visual C++ 2005 gerekmiyor** (11B'de gerekiyordu).
- İki paketin yerel DLL'leri **aynı adı taşır** → aynı süreçte yüklenemez → **model başına ayrı ajan süreci**,
  kendi paketinin klasöründen (`agent\` = 11TB, `agent22\` = 22TB); ajan `--model` ile yalnız kendi modelindeki
  tezgahları backend'den alır (`/api/agent/machines?driver=&model=`).

**22B PC Simulator'da (`C:\Users\akcay\simtest22`, kısa yol; `cnc.bat` ile CncMon32, sonra Bin'den `OCAPIServer.exe`
elle):** kimlik `CncType 22B`, NC sürüm `10.118.88.26`, `Seri Lathe`, 4 eksen (X,Y,Z,C), azami 6; 5 okuma
fonksiyonu çalıştı, `READ_nc_current_block` **-18** (11B ile aynı); ham değerler `Status=READY`, `Mode=AUTO`,
`Alarm/EMG=****` (11B sözlüğüyle aynı). Ajan (`--model 22TB`) + gerçek backend + dashboard uçtan uca: 38 okuma = 38
gönderim, 0 düşen, çıkış kodu 0, kapanışta açık bağlantı 0, dashboard'da `SYNTEC 22B · 10.118.88T`, durum IDLE.

(Gerçek tornada okuma + FTP okuma sonradan doğrulandı, yukarıya bakın.) **22TB'de program GÖNDERME kapalıdır**
(`config/drivers.json` → `models[22TB].fileTransfer.sendEnabled = false`): FTP'de yazma gerçek 22TB'de denenmedi.
Tarama (salt okunur) ve okuma açıktır. Sıradaki: tek kontrollü gönderme testi (yeni test adı, boş/yeni klasör), sonra
`sendEnabled` true.

### ✅ İkinci gerçek tezgahta doğrulandı — 2026-10-06, 192.168.88.98

Aynı PC, kablo, DLL'ler ve probe ile **60 sn'de 52 örnek, hiç takılma**: ort. 1,16 sn
aralık, `Status=START`/`Mode=AUTO`→`RUNNING`, 2000 rpm, parça 1402→1405 (toplam 18042→
18045), `CycleTime` 21→26→1. Yani kod/DLL/PC/kablo/ağ sağlam; aşağıdaki sorun **yalnızca
ilk tornaya (M9L4379, .99) özgü**.

### ✅ Ajan + backend + dashboard uçtan uca — 2026-10-06, 192.168.88.98 (CNC-08, seri M4L0007)

Fabrika numarası **8** (envanterde `CNC-08`). Paketlenmiş ajan 0.1.5 (`--host 192.168.88.98
--machine-id CNC-08`, 4 dk): kimlik alanları tam (11B, NcSurum 10.116.54.19, 6 eksen),
tornaya **tam 4 TCP (1 oturum)**, ~1,2 sn/okuma, 198 okuma = 198 gönderim, 0 düşen,
`--duration` sonunda çıkış kodu 0 ve bağlantılar düzgün kapandı. Dashboard: `RUNNING`,
mil/ilerleme/parça/süre alanları doğru, `START`→`RUNNING` eşlemesi `/api/health`'te.
Ajan durunca zaman şeridi `NO_DATA` (OFF değil) oldu. Backend 40 sn kapatılıp açılınca
ajan çökmedi, tamponladı ve tamponu geri yükledi.

**Bilinen eksik:** backend olay zamanını mesajın `ts`'inden değil geliş anından alır
(`store.js ingest`); tampon geri yüklense bile o aralık zaman şeridinde `NO_DATA` kalır
ve kapsama düşer (örnekler kayıtlı ama durum aralığı geç kalır).

### ⚠️ ÇÖZÜLMEMİŞ — ilk tornada (M9L4379, 192.168.88.99) oturum takılıyor (2026-10-06)

Aynı tornada (192.168.88.99, 10.116.54S) **18 Eylül'de 104 örnek alınmıştı; 6 Ekim'de
hem probe hem ajan 3–6 çağrıdan sonra takılıyor**:
- Bağlantı kuruluyor (`isConnected` true), ama kontrolcü çekirdeğinden gelen kimlik
  alanları **boş** (`CncType`, `NcSurum`, `EksenSayisi`; bazen `SeriesNo` da). İlk
  çağrılar yarım/varsayılan değer dönüyor, sonra bir çağrı **sonsuza dek bekliyor**
  (hangi fonksiyon olduğu fark etmiyor; fonksiyonlar tek tek ayrı oturumda 60–200 ms).
- **Elenenler (kanıtlı):** kod (18 Eylül'de çalışan probe aynı sonucu veriyor), PC
  (iki ayrı PC'de aynı), **simülatör** (aynı probe PC Simulator'a karşı 40 sn / 39 örnek
  sorunsuz, kimlik tam), Visual C++ (yüklü), ağ (ping, 1472 B DF, tam dubleks, 4 port
  açık), **güvenlik duvarı (tamamen kapalıyken de takıldı)**, eski oturumlar (torna
  yeniden başlatıldı), `SYSTEM` hesabı (yönetici kullanıcıyla da takıldı). Ajanın
  dinleme soketi yok → "geri kanal 5568/5570" teorisi zayıf.
- **Ek bulgu:** torna **üretim yaparken** (parça sayacı artıyor: 808 → 863) API
  `Status=NOTREADY`, `Mode=NULL` döndürüyor, ActSpindle/ActFeed 0, kimlik boş; sayaçlar
  (parça, güç süresi) gerçek. Yani sunucu çekirdekle **yarım eşleşmiş**. Ayrıca probe
  `Ctrl+C` ile ölmüyor (native iş parçacıkları ağ beklemesinde kilitli): `Stop-Process -Force`.
  **Not:** `SyntecReader.DurumEsle` `Contains("READY")` ile baktığı için `NOTREADY`
  `IDLE`'a sessizce eşleniyordu; düzeltildi (`NOT…` ile başlayan değer tanımsız sayılır:
  `BilinmeyenDurum`'a yazılır, loga ve `controller.rawStatus`'a düşer, durum yine IDLE).
  0.1.6 paketinde (paketlenen ajanda eşleme doğrudan denendi).
- **Elenen hipotezler (ek):** "sunucu açılışta başlıyor" (18 Eylül'de de `Start server
  while boot` açıktı), "torna boşta" (üretim yapıyor: HMI `Auto`+`Busy`, iki kanalda da
  program çalışıyor), "torna hazır değil", **"HMI ayar sayfasındayken API veri vermiyor"**
  (ana ekrana (F1 Coord.) geçince de aynı: örnek yok, `SeriesNo` bile boş).
- **Gidiş kötüleşiyor** (denemeler arttıkça): 6 → 2 → 1 → 0 örnek, sonra kimlik
  aşamasında takılma, sonra `SeriesNo` boş. Torna yeniden başlatıldıktan sonraki İLK oturum
  da 1 örnekle takıldı, yani yalnızca "bizim oturumlarımız sunucuyu bozuyor" değil. Her
  başarısız deneme tornayı daha fazla yoruyor olabilir: gereksiz yere tekrarlama.
- **Torna ekranındaki `Dipole Log` boş (beyaz)** — oradan kanıt alınamıyor. Tornanın
  FTP'si (21, anonim) açık AMA kökü yalnızca `DiskA\OpenCNC\NcFiles` (NC program
  klasörleri); `DiskC`/`DiskA` geçişi reddediliyor → sunucu günlüğü FTP'den okunamaz.
- **Kablo elendi:** 3000 ardışık 1400 B ping 2999 cevap, ort. 0,58 ms, kart hata sayaçları 0.
- **Sıradaki:** tornanın günlüklerini FTP'den okumak; ARIX/Syntec'e rapor (simülatör
  tamam, torna 10.116.54S bağlanıyor ama yarım veri + takılma).
- Teşhis araçları: `syntec-probe` (kontrol), ajanın `--log`'u. Ajan artık takılan çağrıyı
  zaman aşımıyla yakalar ve `Status` boşsa sahte IDLE yaymaz (0.1.5'ten beri paketli).

**Kural:** Tanınmayan ham değer **sessizce eşlenmez**. `SyntecReader.DurumEsle`
onu `BilinmeyenDurum`'a yazar, ajan loga basar, ham değer her mesajda
`controller.rawStatus` olarak taşınır ve dashboard'da "Kontrolcüden gelen ham
değerler" bölümünde görünür. Böylece eşleme **makineye gitmeden** doğrulanır.

---

## 4. DLL'ler — ajan nereden çalışır

**Dosya seçip taşıma. Ajanı Syntec'in `Bin` klasörünün İÇİNE koy ve oradan
çalıştır.** Gerçek tezgahtan alınan yakalama (`ornek-veri/`) tam olarak böyle
yapıldı; kanıtlanmış yol budur.

```
...\11BLathe_W32_10.116.56Q\DiskC\OpenCNC\Bin\
    syntec-agent.exe        ← build.bat buraya kopyalar
    machines.txt            ← tezgah listesi
    Syntec.RemoteCNC.Win32.dll
    OCApi.dll  OCUser.dll  MMICommon32.dll  ...   ← paketle birlikte gelir
```

```bat
cd tools\syntec-agent
build.bat "C:\...\11BLathe_W32_10.116.56Q\DiskC\OpenCNC\Bin"
```

**22TB ailesi (ikinci paket):** `22BLathe_W32_10.118.88Z\DiskC\OpenCNC\Bin` — yönetilen istemci `Syntec.OpenCNC.dll`
içinde (ayrı `Syntec.RemoteCNC.Win32.dll` yok). Ajan aynı exe'dir; o paketin `Bin` klasöründen çalıştırılır:
`syntec-agent.exe --model 22TB`. **İki paketi aynı klasörde ya da aynı süreçte birleştirme** (yerel DLL'ler aynı adı
taşır). `--model` verilmezse model klasördeki pakete bakılarak seçilir.

> **Neden dosya listesi vermiyoruz:** `Syntec.RemoteCNC.Win32.dll` yönetilen bir
> sarmalayıcı; arkasında bir dizi **native** DLL'i çalışma anında yüklüyor
> (`OCApi.dll`, `OCUser.dll`, `MMICommon32.dll` ve başkaları). Bunlar yansımayla
> değil, işletim sistemi yükleyicisiyle çözülüyor ve eksik olan ancak o yolu
> çağıran bir fonksiyonda patlıyor — yani elle seçilen liste ilk denemede çalışıp
> saatler sonra bozulabilir. Syntec'in manual'indeki beş dosyalık liste
> (`Syntec.OpenCNC.dll`, `Syntec.RemoteCNC.dll`, `Syntec.RemoteObj.dll`,
> `OCAPI.dll`, `OCUSER.dll`) bu pakete **uymuyor**: ad ve büyük/küçük harfler
> farklı, `Syntec.RemoteObj.dll` pakette hiç yok. Klasörü bölme.

### Tuzaklar — hepsi sahada yaşandı

1. **`/platform:x86` zorunlu.** Syntec DLL'leri native 32-bit. 64-bit derlenirse
   çalışma anında `BadImageFormatException` gelir. `build.bat` bunu ayarlı
   getiriyor.
2. **İndirilen dosyalar Windows tarafından bloke gelir** (`0x80131515`).
   Paketin tamamında bir kez:
   `Get-ChildItem "C:\...\11BLathe_W32_10.116.56Q" -Recurse | Unblock-File`
3. **PC güvenlik duvarında TCP 5568 ve 5570 GELEN bağlantıya açık olmalı.**
   Manual §2.2: kontrolcü PC'ye **geri bağlantı açıyor**, akış çift yönlü.
   Bu açılmazsa bağlantı hiç kurulmaz.
4. **PC'de birden fazla ağ kartı varsa**, tezgaha bakan kartın önceliği
   yükseltilmeli (§2.2), yoksa bağlantı kurulamaz.
5. **PowerShell'de `.\` gerekir:** `.\syntec-agent.exe` (çıplak isim çalışmaz).
6. **Hedef PC'de Visual C++ 2005 SP1 (x86) çalışma zamanı kurulu olmalı.**
   `OCApi.dll`, `OCUser.dll`, `OCKrnl.dll` (manifest: `Microsoft.VC80.CRT/MFC`
   8.0.50727.762) buna bağlı. Yoksa DLL yüklenmez (**`0x800736B1`**, "yan yana
   yapılandırma doğru olmadığından başlatılamadı"), Syntec kütüphanesi **hata
   fırlatmaz**, yalnızca `isConnected()` false döner → ajan sebepsiz `KOPUK` der.
   Kablo/IP/port doğru olduğu hâlde veri gelmiyorsa ilk bakılacak yerlerden biri.
   (Geliştirme PC'sinde başka bir yazılım kurduğu için gözden kaçmıştı; fabrika
   PC'sinde yaşandı, 2026-10-06.) Ajan artık `SyntecReader.NativeKontrol` ile bunu
   önceden denetleyip nedenini loga yazar; **Setup eksikse kendisi kurar**
   (`installer/prereq/`). Elle: Microsoft İndirme Merkezi id 26347, `vcredist_x86.exe`.

## 5. Kontrolcü tarafı — her tezgahta bir kez

Bunlar **tek ziyarette** yapılmalı, çünkü IP değişikliği reboot gerektiriyor.

1. **Statik IP ver** (ofis ağının subneti).
2. **`Start server while boot` → AÇIK.** Varsayılan `Close` geliyor ve o haldeyken
   OCAPIServer hiç çalışmıyor — projenin en uzun tıkanıklığı buydu, lisans ya da
   opsiyon sorunu değildi. Ayarı açmadan reboot edilirse sunucu kapalı gelir.
3. **Reboot.** Syntec 11B ağ ayarını **yalnızca açılışta** uyguluyor; kaydetmek
   yetmiyor.
4. Açılışta Kernel Server ekranında sunucunun çalıştığını **doğrula**.
5. Ofisten port taraması: 5566/5568/5570/5572 açık mı.

> Lisans ya da opsiyon kodu **gerekmiyor**. Bu teyit edildi.

---

## 6. Çalıştırma

```bash
npm run dev     # backend + simülatör birlikte
npm start       # yalnız backend  → http://localhost:3000
npm run sim     # yalnız simülatör
npm run demo    # backend + data/gercek.db'deki GERÇEK kaydı canlı gibi oynatır (demo için)
npm run demo:programlar  # program kütüphanesi demosu: sahte tornalar (FTP :2121/:2122), gerçek tornaya dokunmaz
npm test        # backend testleri (node:test, bağımlılık yok)
```

Gerçek tezgahla:

```bat
REM Windows'ta, DLL klasöründen
syntec-agent.exe --ingest http://OFIS-PC:3000/api/ingest --interval 1000
REM 22TB ailesi: kendi paketinin Bin klasöründen, ayrı süreç
syntec-agent.exe --model 22TB --ingest http://OFIS-PC:3000/api/ingest
```

**Ajan tezgah listesini backend'den alır** (`GET /api/agent/machines`) ve
dakikada bir tazeler. Tek gerçek kaynak ayarlar ekranının yazdığı
`config/machines.json`; ajan kendi kopyasını tutmaz. Tezgah eklendiğinde ya da
IP değiştiğinde ajan kendiliğinden yakalar, yeniden başlatma gerekmez.
**Backend hazır değilse ajan çıkmaz, bekler** (hazır olana ya da liste dolana kadar 5
sn'de bir, sonra dakikada bir dener): açılışta ikisi aynı anda kalkar ve çıkan bir
ajanı kimse yeniden başlatmaz. Görev ayrıca 30 sn gecikmeyle tetiklenir.

**Demo (`npm run demo`):** `simulator/replay.js` gerçek tezgahtan yakalanıp `gercek.db`'de
duran örnekleri her saniye son değeri tutarak backend'e yollar (kayıt bitince başa döner,
birikimli sayaçlar geriye gitmesin diye kaydırılır). Backend **ayrı** `data/demo.db`'ye
yazar ve her başlatmada sıfırlar; böylece oynatılan veri gerçek kaydı kirletmez. Ekranda
"oynatma" olduğunu gösteren bir işaret YOK — sunumda söylenmeli.

Geçersiz kılmak gerekirse:
- tek tezgah: `--host 192.168.1.101 --machine-id CNC-01`
- yerel dosya: ajanın yanında `machines.txt` (`CNC-01=192.168.1.101`)

### İzleme PC'sine kurulum

`kurulum/` klasörü tek seferlik kurulum yapar: ön koşulları denetler, ajanı
Syntec `Bin` klasörüne x86 derler, güvenlik duvarını açar, backend ve ajanı
açılışta başlayacak şekilde kaydeder.

```powershell
# YONETICI PowerShell
cd kurulum
.\kurulum.ps1 -SyntecBin "C:\...\DiskC\OpenCNC\Bin"
```

Ayrıntı ve sorun giderme: `kurulum/KURULUM.md`.
**Not:** betik gerçek bir yönetici oturumunda henüz çalıştırılmadı (söz dizimi ve
yönetici-denetimi/`-Durdur` yolları denendi).

#### Setup.exe — ileri-ileri kurulum (`installer/`)

Tek dosyalık sihirbaz kurulum: proje kodu + **gömülü Node** + **Syntec DLL'leri** +
x86 ajan. Hedef PC'ye ayrıca bir şey kurmak gerekmez. Üretmek:

```powershell
cd installer
.\build-installer.ps1 -SyntecBin   "C:\...\11BLathe_W32_10.116.56Q\DiskC\OpenCNC\Bin" `
                      -SyntecBin22 "C:\...\22BLathe_W32_10.118.88Z\DiskC\OpenCNC\Bin"
# → installer\output\CNC-Telemetri-Kurulum-<sürüm>.exe   (-SyntecBin22 yoksa 22TB desteği paketlenmez)
```

İki kontrolcü ailesi = iki ajan: kurulumda `agent\` (11TB) ve `agent22\` (22TB) klasörleri, iki görev
(`CNC Telemetri - Edge Agent` ve `CNC Telemetri - Edge Agent (22TB)`; ikisi de `--model` ile başlar, günlükler
`ajan.log` / `ajan22.log`). 22TB tezgah tanımlı değilse 22TB ajanı boş listeyle bekler, kaynak tüketimi ihmal edilebilir.

- Setup.exe dosyaları `C:\CNC-Telemetri` altına koyar ve **`kurulum.ps1`'i
  çağırır**; görev/güvenlik duvarı mantığı tek yerde (yineleme yok). `kurulum.ps1`,
  proje kökünde `runtime\node.exe` ve `agent\syntec-agent.exe` varsa bunları
  kullanır (derleme/Node kurulumu gerekmez), yoksa eski davranışa düşer.
- **Syntec DLL'leri depoya girmez.** `installer/payload/`, `installer/output/`,
  `*.exe`, `*.dll` `.gitignore`'da; DLL'ler her derlemede `-SyntecBin`'den alınır.
  Paket yalnızca kendi izleme PC'lerine dağıtılır (DLL'ler Syntec'in).
- `build-installer.ps1` Setup.exe üretmeden önce **duman testi** yapar: paketlenmiş
  `node.exe` ile backend açılıyor mu, ajan Syntec DLL'lerini kendi klasöründen
  yükleyebiliyor mu. Tutmazsa paket üretilmez.
- **Masaüstü uygulaması** (`installer/launcher/Baslatici.cs` → `CNC Telemetri.exe`):
  açınca backend + ajan ayakta mı bakar, değilse Görev Zamanlayıcı görevlerini
  başlatır (gerektiğinde UAC ile; görevler SYSTEM'de), hazır olunca dashboard'u
  açar. İkisi de çalışıyorsa pencere/UAC olmadan doğrudan dashboard. Simgesi
  `make-icon.ps1` ile çizilir. Bayraklar: `--sessiz`, `--denetle`, `--port N`.
- **Defender uyarısı (2026-10-06):** kurulu PC'de `Trojan:Win32/Dexphot.CB`
  ("Ciddi, Etkin") çıktı; işaretlenen öğe dosya değil, görevin komut satırıydı:
  `cmd.exe /c "ajan --ingest http://127.0.0.1:3000/api/ingest >> ajan.log 2>&1"`.
  Dexphot gerçek bir kötü amaçlı yazılım ailesi ve zamanlanmış görev + meşru Windows
  süreçleriyle kalıcılık kuruyor; Defender davranışa dayalı tespit yapıyor. Hangi
  özelliğin tetiklediği **kesin bilinmiyor** (yanlış pozitif olduğu kanıtlanmadı).
  Şekli ortadan kaldırmak için (0.1.3): görevler artık `cmd /c … >> log` olmadan
  **programı doğrudan** çalıştırır (`--log` bayrağı: ajan ve backend günlüğü kendisi
  yazar, 5/10 MB'ta döner), komut satırında URL yok, exe'lerde yayıncı/sürüm bilgisi
  var. **Hâlâ imzasız** — asıl çözüm gerçek bir kod imzalama sertifikası (ücretli).
  0.1.3 de işaretlenirse sıradaki adım: görevleri Windows Hizmeti'ne taşımak.
- Güncellemede `config/machines.json` **ezilmez** (ayarlar ekranının yazdığı liste),
  `data/` ve `logs/` kaldırmada silinmez.
- **`config/` dosyalarının hepsi kurulur (2026-10-15 düzeltmesi):** `cnc-telemetri.iss` önceden yalnız `drivers.json` ve `machines.json`'ı tek tek listeliyordu; **`downtime-codes.json` listede yoktu**,
  yani Setup ile kurulan/güncellenen PC'de sunucu açılışta duruş kodlarını okuyamayıp BAŞLAMAZDI (0.11.0'dan beri gizli hata; duman testi pakete bakıp kuruluma bakmadığı için yakalamıyordu). Artık `config/*` jokeriyle (`Excludes: machines.json`) alınır;
  `machines.json` kendi satırında (`onlyifdoesntexist`) kalır. Inno Setup'la sahte paketle derlenerek doğrulandı (jokerin `machines.json`'ı dışarıda bıraktığı ve `downtime-codes.json`/`features.json`'ı aldığı).
- **Kurulumda kapalı Planlama bölümleri (0.18.0, 2026-10-15, kullanıcı kararı):** henüz rafine edilmeyen bölümler bir kuruluma girmeden kapatılır. `build-installer.ps1 -KapaliBolumler` (**varsayılan `paketleme, hammadde`**; `@()` = hepsi açık; geçerli: `paketleme`, `hammadde`)
  paketin `config/features.json` dosyasını yazar (depodaki dosya her şeyi AÇIK bırakır: geliştirme/demo etkilenmez). Duman testi paketlenmiş sunucuda tek kullanımlık yönetici hesabıyla (geçici veritabanı, rastgele şifre) oturumun bölüm listesini ve kapalı uçların 403 verdiğini denetler.
  Yeniden açmak = yeni kurulum paketi (`-KapaliBolumler @()`); kurulu PC'de `C:/CNC-Telemetri/config/features.json` düzenlenip sunucu yeniden başlatılarak da olur ama arayüzde düğme YOK (bilinçli). Ayrıntı: aşağıda "Kurulumda kapalı bölümler".
- **Denenmedi:** Setup.exe'nin yükseltilmiş (UAC) kurulumu — görevler, güvenlik
  duvarı, açılışta başlatma. Ajan SYSTEM hesabıyla gerçek tezgahta çalıştırılmadı.
  Masaüstü uygulamasının pencere ve UAC yolları da elle denenmedi (mantığı gerçek
  süreçlerle `--sessiz` kodlarıyla ve derleme duman testinde sınandı).
  Ayrıntı: `installer/README.md`.

#### Ajan bekçisi (`--supervise`, ajan 0.4.2, 2026-10-14)

**Olay (fabrika PC'si, 2026-10-14 04:21:38):** 11TB ajanı (7 torna) SESSİZCE durdu: ajan günlüğüne o andan sonra tek satır yazılmadı (22TB ajanı ve backend aynı PC'de sabaha kadar yazdı), Görev Zamanlayıcı
yeniden başlatmadı; kullanıcı gelip elle başlatana dek ~7 saat 1–7 numaralı tornalardan veri gelmedi (yalnız CNC-08). Günlükten görünenler: ajan 04:19'da başlamış ve 2 dk sorunsuz okumuş; 04:21'de PC genelinde kısa bir duraklama olmuş
(22TB ajanında backend 70 sn yanıt vermedi, CNC-08 okumaları yavaşladı); 7 tornanın okuması aynı anda 15 sn aşımına uğradı, ajan yedi eski oturumu kapatmaya çalıştı ("eski oturum 3 sn içinde kapanmadı" ×7) ve günlük orada BİTTİ.
Aynı "hepsi birden takıldı" duraklaması daha önce 4 kez olmuş ve ajan kendiliğinden toparlanmıştı (9 Ekim 16:49, 23:54; 14 Ekim 03:45); bu sefer toparlanamadı. Günlükteki öteki susmalar PC'nin kapanıp açılmasıdır (iki ajan aynı saniyede susar).
**Mekanizma KANITLANMADI:** süreç çökmüş mü, dışarıdan öldürülmüş mü (Defender dahil), donmuş mu, günlük yazımı mı tıkanmış, günlükten ayırt edilemiyor (kullanıcı süreci incelemeden kapattı). Windows olay günlüğü (Application/System/Defender, 04:19–04:40) istendi.
Not: Görev Zamanlayıcı'nın "hata olursa yeniden başlat" ayarı yalnız süreç HATA KODUYLA çıkarsa işler; donmuş (çalışıyor görünen) süreç için hiçbir şey yapmaz.

**Çözüm: bekçi.** `syntec-agent.exe --supervise --log <dosya> [--model ...]` (`Bekci.cs`): bu süreç ajan DEĞİL, ajanın bekçisi; asıl ajanı AYNI exe'yi `--supervise` OLMADAN alt süreç olarak başlatır ve izler.
- Alt süreç çıkarsa (çökme, `SertCikis`, dışarıdan öldürülme; çıkış kodu fark etmez, kod bekçi günlüğüne yazılır) 5 sn sonra yeniden başlatır (hızlı tekrarlarsa 10/20/40/60 sn; en az 60 sn çalışmışsa sayaç sıfırlanır).
- Alt süreç DONARSA yeniden başlatır: kalp atışı = ajanın günlük dosyasının son yazım zamanı (ajan her dakika özet satırı yazar); `--stale-sec` (varsayılan 240 sn) değişmezse süreç donmuş sayılır. Öldürmeden önce **iş parçacığı dökümü** bekçi günlüğüne yazılır
  (iş parçacığı durumları/bekleme nedenleri, 2 sn arayla CPU farkı: kilitlenme mi, döngü mü): bir sonraki olayda nedeni gösteren tek ipucu bu.
- **Sistem duraklaması izleyicisi (0.4.1):** bekçinin ayrı bir iş parçacığı her saniye uyanır; iki uyanış arası 8 sn'yi aşarsa `ajan.bekci.log`'a "SISTEM DURAKLAMASI: bekçi N sn çalışamadı ... işlemci %X meşguldu; N MB boş bellek" yazar.
  Neden: fabrikada **neredeyse her gün ~2 dk veri yok** olayları var ve günlükte ortak nedene işaret ediyor (aşağıdaki "2 dakikalık kesintiler"); bu satır duraklamanın PC çapında olup olmadığını (bekçi de çalışamadıysa evet) ve işlemcinin mi yoksa disk/ağın mı beklediğini (işlemci ~%100 / ~%0) söyler. PC uykuya geçse de görünür.
- **Günlük satırları tarih-saatli (0.4.2):** `--log` ile yazılan HER satırın başına `yyyy-AA-gg SS:dd:ss` eklenir (ajan ve bekçi günlüğü). Eskiden olay satırları ("okuma takıldı", "bağlandı") zamansızdı ve kesintiler yalnız dakikalık özet satırlarından tahmin edilebiliyordu.
- Bekçi Syntec DLL'lerine dokunmaz (kendisi donabilecek bir şey yüklemez). Alt süreç bir job nesnesine (`KILL_ON_JOB_CLOSE`) bağlanır: bekçi öldürülürse (görev durdurulunca) alt süreç de ölür, torna oturumları TCP kapanınca serbest kalır.
- Bekçinin kendi kaydı ajanın günlüğünden AYRI: `<log>.bekci.log` (`ajan.bekci.log`, `ajan22.log` → `ajan22.bekci.log`). `kurulum.ps1` iki görevi de `--supervise` ile kaydeder (yeni kurulumlarda otomatik).
- **Mevcut kurulumu elle geçirme (Setup derlemeden):** yeni `syntec-agent.exe`'yi iki ajan klasörüne (`agent\`, `agent22\`) kopyala (çalışırken kopyalanamaz: önce iki ajan görevini durdur) ve her görevin argümanının başına `--supervise` ekle
  (`Set-ScheduledTask`; komutlar sohbette verildi). Ajanın kendisi ve backend değişmedi: ajan `--supervise`siz eskisi gibi çalışır.
- **Test:** `tools/syntec-agent/test/bekci-test.ps1` (sahte Syntec DLL'iyle; 17 kontrol: günlük satırlarında tarih-saat, alt süreç olarak başlatma, öldürülünce yeniden başlama, DONDURULUNCA (NtSuspendProcess) öldürüp yeniden başlama + dökümün yazılması, bekçinin kendisi durunca "SISTEM DURAKLAMASI" satırı, bekçi ölünce alt sürecin ölmesi, kod 0 çıkışında yeniden başlama). ~3 dk. Gerçek tornada/fabrika PC'sinde denenmedi.
- **2 dakikalık kesintiler (günlük analizi, 2026-10-09..14, ~4,8 gün):** kesinti kümeleri ~günde 1–2, her biri ~2 dk. Ajan tamponu sebep DEĞİL: `bekleyen` en çok 10 (kapasite 20.000), hiç `DUSEN` (taşan mesaj) yok. Üç küme **iki ajanı ve backend'i aynı dakikada** vurdu
  (9 Ekim 16:49 ve 23:54 — 23:54'te 8 tornanın hepsi aynı anda "yanıt yok" —, 14 Ekim 04:21); backend'in kendisi de (`localhost`) yanıt vermedi (14 Ekim 04:21, 03:45, 00:38). Bu, tek tek tornaların ya da ajanın değil **PC/ağ çapında ~1–2 dk duraklamanın** işareti. Bazıları tek tornaya özel
  (CNC-08: 13:22 ve 13:32'de 2'şer dk; CNC-04 11:01). Ek bulgular (aynı gün): (a) iki günlükte ~12.000 özet aralığının hepsi 60–61 sn: **saat sıçraması yok** (saat senkronu sebep değil); (b) 9 Ekim 23:54'te iki ajanın ana döngüsü tam zamanında çalıştı yani **PC donmamış**, 8 torna aynı anda yanıtsız kaldı → torna ağı (anahtar/kablo/torna tarafı) şüphesi;
  16:49 ve 04:21'de ise `localhost` backend de ≥10 sn yanıt vermedi (22TB ajanının ana döngüsü 70 ve 103 sn'ye uzadı: liste isteği zaman aşımına uğradı); (c) fabrika PC'sinin System olay günlüğü (hata/uyarı, 6 gün) temiz: disk, NTFS, ağ kartı, Kernel-Power hatası YOK; yalnız
  DistributedCOM 10016 (24), BitLocker 24641 (13), TPM-WMI 1800/1801 (gürültü), **Time-Service 134/36, DNS-Client 1014/1023/1012, NetBT 4300** (DNS çözümleme ve saat senkronu zaman aşımları: ağ katmanında ara sıra tıkanma). Bilgi düzeyindeki ağ kartı bağlantı kopma/uyku olayları bu sorguda yoktu
  (yalnız Level 1–3 sorgulandı); `Microsoft-Windows-NetworkProfile/Operational` 10000/10001 ve NIC 27/32 ile zaman damgalı karşılaştırma bekleniyor. Backend'de "başladıktan 3 dk sonra" tetiklenen bir iş yok (temizlik yalnız açılışta). Nedeni henüz kesin değil.
  **Ağ/olay günlüğü karşılaştırması (aynı gün, `NetworkProfile` 10000/10001 + `Kernel-Boot`):** 9 Ekim 23:55:05 Windows "ağ bağlantısı koptu", 23:55:08–11 yeniden bağlandı (~6 sn) = 23:54 kümesiyle birebir örtüşüyor (8 torna aynı anda yanıtsız): bu küme PC'nin ağ kesintisi. 9 Ekim 16:49, 14 Ekim 03:45 ve 04:21 ile CNC-08'in 13:22/13:32 kesintileriyle örtüşen ağ olayı YOK.
  PC 14 Ekim 04:16:06, 04:17:29 ve 04:17:59'da üç kez açılmış (son açılıştan 3,5 dk sonra 04:21 donması); 10 Ekim 00:16, 01:16, 01:18 (×2) ve 13 Ekim 09:11 de açılış. Not: ajan olay satırlarında zaman damgası olmadığı için olayların günleri backend günlüğünden çıkarıldı.
- **Bekçinin ÇÖZMEDİKLERİ:** (1) kök neden hâlâ bilinmiyor (yukarıdaki olay günlüğü + bir sonraki olaydaki iş parçacığı dökümü gerekir); (2) ajanın `PARK EDİLDİ` durumu (bir tezgahın okuması art arda 3 kez takılınca o tezgah için çağrı açılmaz, "ajan görevini yeniden başlatın") bekçi tarafından yakalanmaz,
  çünkü ajan sağlıklı görünür ve özet yazmaya devam eder; (3) yeniden başlatma, ajanın bellekteki tamponunu (en çok 20.000 mesaj) siler. Donma sırasında geçen süre durum şeridinde `NO_DATA` kalır, parça sayaçlarındaki artış ajan dönünce sayılır ("vardiyası yaklaşık" işareti).

#### Torna başına süreç (ajan 0.5.0, 2026-10-15) — bekçinin ikinci olayı

**Olay (fabrika PC'si, 2026-10-14 akşamı; elektrik kesintisi sonrası):** PC 15:57'de açıldı, tornalar tek tek bağlandı (16:10'da CNC-04, sonra 03/06/07). **16:50'de 11TB ajanının dört tornası (03, 04, 06, 07) AYNI SANİYEDE takıldı**; o sırada 01 ve 02 yeni bağlanıp kimlik okumuştu.
Sonrasında **17,5 saat tek okuma olmadı** (`okunan=2059` sabit; yalnız CNC-08 = 22TB ajanı veri verdi, 55.530 okuma, 0 düşen). Ajanın **ana döngüsü yaşıyordu** (her dakika özet satırı yazıyordu), bu yüzden bekçinin "günlük dosyası değişmedi" kalp atışı hiç tetiklenmedi (bekçi günlüğünde yalnız iki başlangıç var). Günlükte:
takılan dört torna için `[1/3]` satırı bir kez çıktı, sonra HİÇ ek satır yok ("PARK EDİLDİ" bile yok), özet satırı "KOPUK (okuma 15 sn'dir yanıt vermiyor)" demeye devam etti; 01 ve 02 için `baglandi` + kimlik satırları var ama sonrasında hiçbir okuma/uyarı yok; CNC-05 (.98) bu çalışmada hiç bağlanmadı.
**Kesin mekanizma KANITLANMADI** (aday: takılan native çağrı sürecin başka çağrılarını da bekletiyor; kurtarma yolunda `Baglan`/`new Thread` zaman aşımsız, yani toparlanma sürecin kendi içinde güvenilmez; torna tarafı bilinmiyor). Aynı "hepsi birden takıldı" örüntüsü 9 Ekim 23:54, 14 Ekim 04:21'de de vardı.
**Tasarım ilkesi: tek güvenilir toparlanma sürecin ölmesidir** (TCP kapanınca tornadaki oturumlar da serbest kalır) ve bir tornanın takılması diğerlerini etkilememeli.

**Çözüm (varsayılan kip): bekçi HER TORNA İÇİN AYRI ajan süreci açar** (`syntec-agent.exe --supervise --log <dosya> [--model ...]`; görev argümanları DEĞİŞMEDİ, kurulum/Görev Zamanlayıcı aynı). `Bekci.cs` `IsciKipi`:
- Tezgah listesini backend'den alır (`/api/agent/machines`; model `--model`, yoksa klasördeki Syntec paketinden: ajanla aynı kural) ve `--list-sec` (60) sn'de bir eşitler: yeni tornaya süreç açar (1,5 sn arayla), listeden çıkanın sürecini kapatır, **IP değişirse** yeniden başlatır; backend yokken çalışan süreçlere dokunmaz.
  Her süreç `ajan --host <ip> --machine-id <id>` ile açılır (tek tornalı eski kip); çıktısı (stdout/stderr) bekçiye borulanır ve **ortak ajan günlüğüne (`--log`) tek dosyada, her satır tarih-saatli ve `[CNC-xx]` etiketli** yazılır (eskisi gibi tek dosya gönderilir). Bekçi kaydı ayrı: `<log>.bekci.log`.
- **Üç yeniden başlatma nedeni (yalnız o süreç):** (1) süreç çıktı (5→10→20→40→60 sn geri çekilme); (2) **DONMUŞ**: `--stale-sec` (240) sn hiç çıktı yok; (3) **İLERLEME YOK**: `--idle-sec` (300) sn ajan özet satırındaki `okunan=` sayacı artmadı (süreç yaşıyor, günlük yazıyor ama tornadan okuyamıyor: 14 Ekim olayı). Öldürmeden önce **iş parçacığı dökümü** ve ajanın son bildirdiği KOPUK nedeni bekçi günlüğüne yazılır.
  İlerlemesiz yeniden başlatmalar üst üste olursa eşik büyür (300→600→1200→1800 sn tavan; ilerleme görülünce sıfırlanır): kapalı/ulaşılamayan torna (ör. CNC-05) bosuna zorlanmaz.
- **5 dakikada bir tek satır** `isciler: CNC-01 okuyor (okunan N, yeniden baslatma M) | CNC-02 OKUMA YOK 7 dk ...` (`ajan.bekci.log`): uzaktan teşhis için hangi tornanın ne zamandır okumadığı tek bakışta görünür.
- Bekçi öldürülürse (görev durdurulunca) tüm torna süreçleri job nesnesiyle ölür. Eski kip: `--tek-surec` ya da `--host/--machines`/`machines.txt` varsa (tüm tornalar tek ajan sürecinde, eski bekçi kuralları).
- **Test (buradan, SAHTE DLL ile; gerçek torna/fabrika PC'sine bağlanılamaz):** `tools/syntec-agent/test/bekci-isci-test.ps1` (24 kontrol: torna başına süreç, `MOCK_HANG_HOST` ile tamamen cevap vermeyen tornada İLERLEME YOK ve YALNIZ o sürecin yeniden başlaması / sağlam tornanın pid'sinin değişmemesi, liste ekleme/çıkarma/IP değişimi, dışarıdan öldürülen sürecin yeniden başlaması, bekçi ölünce hepsinin ölmesi, `--model` olmadan model çıkarımı) ~3 dk; eski kip testi `bekci-test.ps1` (`--tek-surec`, 17 kontrol) aynen geçiyor.
  `--summary-sec` (ajan özet aralığı, varsayılan 60) yalnız testlerde kısaltılır.
  **Devreye alındı (2026-10-15, fabrika PC'si, iki ajan klasörüne elle kopyalanan exe): 8 tornanın HEPSİNDEN veri akıyor; eski ajanda "bağlanmıyor" görünen CNC-05 (.98) taze süreçte sorunsuz bağlandı** (yani sorun tornada/ağda değil, kilitlenmiş eski ajan sürecindeydi). **Henüz görülmeyen:** gerçek bir takılmada bekçinin davranışı ve elektrik kesintisi sonrası tornaların tek tek açılırken davranışı (asıl sınav).
  Zaman çizelgesi ipucu (14 Ekim günlüğü): CNC-04 16:10'dan beri tek başına sorunsuz okundu; 03/06/07 16:49'da, 01/02 16:50'de bağlandı ve **dört torna ~30 sn sonra aynı saniyede takıldı** (yeni oturumlar çalışan oturumların bulunduğu süreçte açılırken kilitlenme: torna başına süreç bunu ortadan kaldırmak için).
- **Devreye alma (fabrika PC'si, yönetici PowerShell; dosya bu PC'den taşınır, `*.exe` depoya girmez):** iki ajan görevini durdur (`Stop-ScheduledTask`), yeni `syntec-agent.exe`'yi `C:\CNC-Telemetri\agent\` ve `agent22\` klasörlerine kopyala, görevleri başlat; `ajan.bekci.log`'da `kip: TORNA BASINA SUREC` ve 5 dk sonra `isciler:` satırı görünmeli; Görev Yöneticisi'nde 11TB için bekçi + torna başına süreç, 22TB için bekçi + 1 süreç.
- **Hâlâ bilinmeyen:** 16:50 olayının kök nedeni (bu sürüm toparlar ve bir sonraki olayda `ILERLEME YOK` satırının dökümü + "ajanın son bildirdiği durum" ipucu bırakır; aynı anda birden çok torna `OKUMA YOK` oluyorsa ortak neden (ağ/PC) güçlenir, yalnız biri oluyorsa o tornadır); CNC-05 (.98) neden bağlanmıyor (torna kapalı mı, IP doğru mu).

### Derleme (Windows)
```bat
cd tools\syntec-agent
build.bat                          REM syntec-agent.exe üretir
build.bat "C:\cnc-ajan"            REM üretir ve kopyalar
```

### Saha teşhis aracı
`tools/syntec-probe` — tek seferlik yakalama (60 sn oku, JSONL + Excel CSV yaz,
hangi fonksiyonun çalıştığını raporla). Bağlantı sorununu teşhis etmek için.
Ajanla **aynı** `SyntecReader.cs`'i derler, böylece durum eşlemesi ikisinde
ayrışamaz.

### Program kütüphanesi ve aktarım (`backend/programs/`)

**Ne yapar:** programcının hazırladığı NC dosyası arayüze sürüklenip bırakılır, kütüphanede
(müşteri klasörü + ad kimliğiyle, sürümlü, SHA-256'lı) saklanır; tezgahın müşteri klasörüne
gönderilir; hangi program hangi tezgahta ve hangi sürümde görünür (matris ve tezgah detayı).
**İçerik yorumlanmaz**, dosya aynen taşınır. Gönderilen program tezgahta **aktif olmaz**
(panelden seçilmesi gerekir).

**Program editörü (2026-10-08):** yeni NC programı doğrudan üründe yazılır ("Yeni program yaz…") ya da var olan programın bir
sürümü düzenlenir ("Düzenle…"); kaydedince kütüphanede **yeni sürüm** olur (eski sürümler aynen kalır), "Kaydet ve tezgaha gönder…"
gönderme penceresini o programla açar (orada ayrı onay var). Genel amaçlı kod editörü DEĞİL: satır numarası, imleç konumu,
**kaydetmeden önce değişiklik farkı (diff)**; bul-değiştir yok. **Söz dizimi denetimi/simülasyon yok** (içerik yorumlanmaz ilkesi).
Satır sonu (CRLF/LF) ve kodlama (UTF-8/Latin-1, BOM korunur) sunucuda uygulanır (`library.js` `decodeText`/`encodeText`/`saveText`);
dokunulmayan dosya bayt bayt aynı çıkar (`preview().roundTrip`, karışık satır sonu bildirilir). Aynı (müşteri, ad) ile "yeni program"
409; editör açılırken başka sürüm oluştuysa 409 `newer-version` (arayüz "yine de kaydet" sunar).

**Kütüphanede program adını değiştirme (2026-10-26):** program ayrıntısında "Adını değiştir…" (`library-rename-view.js`); yalnız **kütüphane
kaydının** adı değişir, aynı müşteri klasöründe (klasör taşıma yok), sürümler/içerik/gönderme geçmişi dokunulmaz. Tezgaha HİÇ YAZILMAZ: bu
yüzden "Program gönder" gibi tezgah kimliğini yazarak onay istemez, Kaydet yeterlidir. Tezgahtaki dosya **eski adıyla kalır** (yeniden
gönderilene kadar): rename sonrası matris/karşılaştırmada eski ad "kütüphanede yok", yeni ad o tezgahta "tezgahta yok" görünür — bu pencerede
söylenir. Aynı (büyük/küçük harf duyarsız) ada 409; `program_backups` (toplu gönderimde ezilen tornadaki yedekler) aynı adla izlenebilsin diye
yeni adla birlikte taşınır, ama `transfers` (gönderme geçmişi, donmuş kayıt) ve `machine_programs` (son taramadaki envanter, fiziksel gerçek)
BİLEREK değişmez. Denetim kaydı `library_log`'a `program-yeniden-adlandirma` olarak yazılır (eski/yeni ad). Uç: `POST /api/library/programs/:id/rename`
(`{name}`, 200/400/404/409). Testi `backend/programs/library-rename.test.js` (9). **`npm run demo:programlar` sahte tornalarıyla uçtan uca
denendi** (ad değişti, sürümler aynı kaldı, çakışan ada 409, tezgahlardaki durumu doğru "yok" gösterdi); gerçek tornaya hiç dokunmaz.

**Tezgahta yeni müşteri klasörü (2026-10-08):** gönderme klasör AÇMAZ; klasör ayrı, onaylı bir işlemle açılır
(`MachineFiles.createFolder`, FTP `MKD`; tek tezgah, tezgah kimliğini yazarak onay, denetim kaydı `kind='klasor'`). Ad: yalnız
ASCII `[A-Za-z0-9_.-]` ≤40 (Türkçe karakter yok: CE kod sayfası doğrulanmadı). Var olan klasör/dosya adıyla açılmaz; açılan klasör
LIST + CWD ile doğrulanır. **Klasör silme (RMD) üründe YOKTUR.** Gönderme ile aynı kapılar: `TRANSFER_DISABLED`, model kapısı (22TB).
**Yalnız sahte FTP sunucusunda denendi (MKD yanıtı 257 varsayımı); gerçek tornada henüz denenmedi.**

**Toplu içeri alma (2026-10-12):** tezgah panelinde "Tüm programları kütüphaneye al…" bir tornadaki TÜM programları tek akışla alır;
tornaya **yalnız okuma** yapılır (TRANSFER_DISABLED ve 22TB kapısı engellemez). İki aşama (`backend/programs/bulk-import.js`,
`MachineFiles.startImportPlan/getImportPlan/importPlanDiff/applyImport`): (1) **Plan** arka planda çalışır (ilerleme gösterilir, tezgah kilitli,
dosyalar sıralı ve `pauseMs` aralıklı okunur): her dosya indirilir ve kütüphaneye göre sınıflanır — **yeni** (kütüphanede yok), **ayni** (içerik bir
sürümle aynı), **çakışma** (aynı ad, hiçbir sürümle tutmayan içerik; yalnız CRLF/LF farkıysa `eolOnlyVersion` işaretlenir; tarih ipucu
`modifiedHint`), **alınamayan** (ad kuralına uymayan, >1 MB, boş, ikili, `ZZUP/ZZRB` artığı). İndirilen içerik bellekte 30 dk tutulur (en fazla 100 MB,
15 dk). Plan sonunda tezgah envanteri de tazelenir. (2) **Uygula**: yeniler alınır (klasör bazında çıkarılabilir); **çakışmalar OTOMATİK alınmaz** —
her biri için fark gösterilir ve "yeni sürüm olarak al" / "atla" seçilir (toplu düğmeler: hepsini al / hepsini atla / yalnız satır sonu farklıları al).
İçerik plandan gelir (kullanıcının farkını gördüğü baytlar AYNEN), uygulama tornaya bağlanmaz, aynı plan tekrar uygulanırsa yeni sürüm açılmaz.
Alınan sürümlerin `source=tezgah-tarama`, `created_by` = kullanıcı, `note` = "<tezgah> toplu alım".

**Tornadan program silme (2026-10-12, FTP `DELE`):** tezgah panelinde dosya satırında "Sil…". **Geri dönüşsüz**, bu yüzden: (a) **silme kapısı** — yazma kapısından
(`sendPolicy`) geçer VE modelin `fileTransfer.deleteEnabled` değeri true olmalı. **11TB için 2026-10-13'te fabrika sahibi kararıyla AÇILDI** (`config/drivers.json`);
**22TB kapalı** (önce yazma kapısı `sendEnabled` açılmalı). **`DELE` gerçek tornada hâlâ denenmedi**: ilk silme kendi gönderdiğimiz bir `ZZTEST…` dosyasıyla olmalı.
**Acil kapatma: sunucuyu `DELETE_DISABLED=1` ile başlat** (yapılandırma açık olsa da silme kapanır; `DELETE_ENABLED=1` (eski doğrulama bayrağı, artık gerekmez) acil anahtardan zayıftır;
`scripts/demo-programlar.js` sahte tornalar için verir); (b) onay metni = **program adı** (birebir);
(c) ön kontrol (tornaya yalnız okuma): çalışan/seçili program silinmez, sistem dosyası (`MDIBlock`) ve klasör silinmez, kök dizin dosyası `root-target` onayı ister,
canlı veri yoksa `unknown-state`, **kütüphanede aynı içerikli (SHA) kopya yoksa `no-backup` onayı** (kopya varsa sorusuz: silinen dosya oradan yeniden gönderilebilir);
(d) `DELE`'den hemen önce dosyanın hâlâ aynı boyutta olduğu yeniden doğrulanır (operatör panelden değiştirmiş olabilir), sonra listeden kalktığı doğrulanır;
(e) her deneme (reddedilenler dahil) `transfers` tablosuna `kind='silme'` ile, silinen içeriğin SHA-256'sıyla yazılır; (f) yalnız tek dosya, **klasör silinmez**.
Uçlar: `POST /api/machines/:id/programs/delete-precheck` · `/delete`.

**Kütüphane listesi klasörlere göre gruplu (2026-10-13):** "Programlar ve tezgahlardaki durumu" artık düz tablo değil, **klasör (müşteri) başına açılır grup**: programlar çekildikleri/yüklendikleri
klasörün altında görünür; **kök (ortak alan) yalnızca tezgahın kök dizinindeki programlardır ve listenin EN SONUNDA** ayrı grupta durur. İçeri alma (tek ve toplu) zaten klasörü korur (`customer` = tezgahtaki klasör;
`backend/programs/machine-files.js` `importFromMachine`/`applyImport`); gerçek tornadaki "kök" dosyalar (`O9001` gibi) kökte kalır. 3 klasörden azsa gruplar açık gelir; açık/kapalı durum liste yenilense de hatırlanır; arama eşleşen grupları açar.
**Kütüphaneden silme (2026-10-13, geri dönüşsüz):** program (tüm sürümleriyle) kütüphaneden silinir; satırın başındaki kutuyla tek ya da çoklu seçilir ("Bu klasörün tümünü seç", "Seçilenleri kütüphaneden sil…"), program ayrıntısında "Kütüphaneden sil…".
Onay: **tek programda program adı, birden çok programda program sayısı** yazılır (sunucu da denetler; yanlışsa hiçbir şey silinmez); tek seferde en çok 500; hepsi ya da hiçbiri (tek işlem). Pencere programın hangi tezgahlarda
kopyası olduğunu gösterir ve uyarır: **tezgahlardaki dosyalara dokunulmaz ama kütüphane yedeği gidince tornadan silerken "kütüphanede kopyası var" güvencesi kalmaz**. Her silme `library_log` tablosuna yazılır
(kim, ne zaman, kaç sürüm, sürümlerin SHA-256'sı; ekranda "Kütüphaneden silinenler"). Silinen ad yeniden eklenebilir (yeni program, v1). Uçlar: `POST /api/library/programs/delete` (`ids`, `confirm`, `by`) · `GET /api/library/log`.
**Tezgahta program arama (2026-10-13):** tezgah detayındaki "Programlar" panelinde arama kutusu: program kodunu (ya da `KLASÖR\ad`) yazınca eşleşen klasörler açılır, eşleşen kısım vurgulanır, "kütüphanede var, bu tezgahta yok" listesi de aranır;
yazarken yalnız klasör listesi yenilenir (odak kaybolmaz). Kök grup burada da en sonda.

**Toplu gönderme — kütüphaneden tornaya, YEDEKLEYEREK ezer (2026-10-16, kullanıcı kararı; gerçek tornada henüz DENENMEDİ):** Amaç: tüm tornalarda aynı programlar, aynı içerik. İş akışı: bir tornadaki tüm programlar kütüphaneye alınır (toplu alım) →
ustalar editörde 500 programı tek tek düzenler (ör. yorum satırı ekler; her kayıt yeni sürüm) → tezgah panelindeki **"Toplu gönder…"** ile kütüphanenin SON sürümleri o tornaya yazılır → aynısı sıradaki tornalara (her torna ayrı plan ve ayrı onay). Tornada olup kütüphanede olmayan
programlara DOKUNULMAZ: usta onları sonra "Tüm programları kütüphaneye al…" ile çekip düzenler ve her yere gönderir; böylece kütüphane tüm tornaların birleşimi olur. Kapsam kararları: **8 tornanın hepsi** (22TB kapısı aşağıda), bir tornada eksik programlar da EKLENİR, **kök dizin (ortak alt programlar, ör. O9001) toplu gönderime GİRMEZ**
(tek tek gönderilir), **müşteri klasörü tornada yoksa program atlanır, klasör AÇILMAZ** (her klasör her tornada var), çalışan/seçili program atlanıp raporlanır (sonra yeni planla tamamlanır), üretim sırasında yapılabilir (aralıklı yazılır).
- **Plan** (`MachineFiles.startPushPlan`, arka plan, tornaya YALNIZ OKUMA, model kapısı kapalı olsa da çıkar): her kütüphane programı için `yeni` / `ezilecek` (tornadaki hâl kütüphanedeki bir sürümle aynıysa `eski`: ayrıca yedek gerekmez; hiçbirle tutmuyorsa `farkli`: `needsBackup`) / `ayni` / `atlanan` (klasör yok, çalışıyor, aynı adlı klasör);
  tornada olup kütüphanede olmayanlar `tornadaOzel` (yalnız listelenir). Boyutu bir sürümle tutmayan dosya indirilmeden "farklı" sayılır, tutanlar SHA için indirilir. Canlı veri yoksa `unknownState`: uygulama `unknown-state` onayı ister.
- **Uygulama** (`startPushApply`, arka plan; ilerleme, **durdurulabilir** (`push-stop`: o anki program biter), pencere kapansa da sürer; **onay metni = tornanın kimliği**, plan ikinci kez uygulanamaz, kaldığı yerden devam = yeni plan çıkarmak: aynı olanlar atlanır). Program başına sıra (`#pushOne`):
  1) çalışan/seçili program mı, kütüphanede plandan sonra yeni sürüm oluştu mu (oluştuysa ATLANIR: onaylanan sürüm gider); 2) geçici adla (`ZZUP`) yükle, boyut + geri okunan SHA-256 doğrula (bozuk iletim tornadaki dosyaya hiç dokunmaz); 3) varsa **eski dosyayı yan ada al** (`ZZRB`, RNFR/RNTO: hedef bos, ezme semantiğine GÜVENİLMEZ);
  4) yan adlı dosyayı OKU ve kütüphaneye yedekle (`program_backups`; kütüphanedeki bir sürümle aynıysa ayrıca yedek yok) — yedek yazılamazsa eski hâl geri konur ve yazılmaz; 5) geçici dosyayı nihai ada çevir, geri oku, doğrula; 6) yan adlı dosyayı sil (`DELE`; silinemezse KALIR ve raporlanır, yazma başarılı sayılır).
  **Her hatada geri alma** (yeni FTP oturumuyla): geçici dosya silinir, yan adlı eski hâl asıl adına konur, doğrulanamayan yeni dosya silinir; geri alma da başarısız olursa durum `dogrulanamadi` ve hata metni eski hâlin tornadaki yan adını yazar (veri kaybı yok). Silme yalnız kendi ürettiğimiz `ZZUP`/`ZZRB` adları ve kendi yeni dosyamız içindir (testle zorlanır).
  Operatör dosyayı plandan sonra değiştirdiyse yedeklenen PLAN ANINDAKİ değil O ANKİ hâldir (yan ada alıp sonra okumak yarışı kapatır). Bağlantı kopması 3 yeniden bağlanmaya kadar denenir, sonra kalanlar `hata` olur; tornadaki dosyalar eski hâlinde kalır.
- **Yedekler** (`program_backups`, `library.db`): sürüm DEĞİL (sürüm numaralarını ve "güncel sürüm" mantığını bozmaz; aynı (klasör, ad, SHA) bir kez saklanır). Program sayfasında "Tornalardan alınan yedekler": indir ve **"Yeni sürüm olarak al"** (`POST /api/library/backups/:id/restore`; kaynak `yedek`).
- **Denetim:** her program için `transfers` tablosunda `kind='toplu'` kaydı (kim, ne zaman, SHA, adımlar `yedek`/`yedek-temizle`/`geri-al`...); atlananlar `reddedildi` olarak yazılır, "zaten aynı" olanlar yazılmaz (gürültü).
- **Kapılar:** `TRANSFER_DISABLED`, model kapısı (`sendPolicy`: **22TB'de `sendEnabled:false`, uygulama 422**; plan çıkar), onay metni, yalnız yönetici (`policy.js` varsayılan reddet; testli). **22TB'yi açmak için** önce aşağıdaki test betiği 22TB tornada çalıştırılıp çıktısı doğrulanmalı, sonra `config/drivers.json` `models[22TB].fileTransfer.sendEnabled = true`.
- **Uçlar:** `POST /api/machines/:id/programs/push-plan {folders?}` (202 `planId`) · `GET .../push-plan/:planId` (plan + `apply` ilerleme/sonuç) · `POST .../push-apply {planId, confirm, acks?, skipKeys?}` (202) · `POST .../push-stop {planId}` · `GET /api/library/programs/:id` artık `backups` döner · `GET /api/library/backups/:id[?download=1]` · `POST /api/library/backups/:id/restore`.
- **Dosyalar:** `backend/programs/machine-files.js` (plan/uygulama/geri alma), `library-db.js` (`program_backups`), `library.js` (`restoreBackup`, `ROLLBACK_PREFIX`), `bulk-import.js` (plan deposu: uygulaması süren plan atılmaz, `publicPushPlan`), `routes.js`, `dashboard/bulk-push-view.js` (plan → inceleme/onay → ilerleme → sonuç), `dashboard/library-view.js`.
  **Testi:** `backend/programs/push.test.js` (18: sınıflandırma, yedekleyerek ezme, kapılar, bozuk iletim, RNTO/DELE hataları, geri alma ve geri almanın da başarısız olması, yarış (operatör düzeltmesi, çalışan program, yeni sürüm), bağlantı kopması, durdurma, yedek geri alma, HTTP); kritik davranışlar kasıtlı bozularak testlerin yakaladığı doğrulandı (mutasyon). Sahte FTP: `failRntoWhen`, `failDeleWhen`.
  **GERÇEK TORNADA DENENMEDİ:** yalnız sahte FTP + demo (`npm run demo:programlar`, CNC-07/CNC-08 sahte). Ürünün dayandığı ve gerçek tornada ölçülmemiş işlemler: yan ada alma sonrası okuma, `DELE` (hiç denenmedi), 22TB'ye yazma. **`tools/torna-test/ezme-testi.ps1`** (fabrika PC'sinde: `.\ezme-testi.ps1 -TornaIp <ip> -Klasor <var olan klasör>`) tornada yalnız `ZZTEST…` adlı kendi dosyalarını oluşturup
  sıra ile dener (STOR/RETR, RNTO hedef boşken, RNTO hedef doluyken (bilgi), ürünün tam sırası, DELE) ve temizler; sahte tornada dört senaryoyla doğrulandı. **Önce 11TB'de bir tornada, sonra 22TB'de çalıştırılmalı.** Yan ada alma/silme çalışmazsa toplu gönderme o tornada kullanılmamalı.
  **Bilinmeyen / risk:** kontrolcünün belleğine yüklenmiş bir programın dosyasını diskte değiştirmek kontrolcüyü etkiler mi (şimdilik yazılan program aktif olmaz, operatör panelden yeniden seçer); 500 programın tornaya yazılma süresi (tahmin 15–60 dk, ölçülmedi).

**Ekranlar:** sol menü "Program kütüphanesi" (`#/programlar`, `#/programlar/<id>`): yükleme,
program × tezgah matrisi (✓ güncel, ▼ eski, ≠ farklı, ? doğrulanmadı, — yok, · taranmadı),
sürümler/önizleme/indirme, gönderme geçmişi. Tezgah detayında "Programlar" paneli: tara,
klasörlere göre liste, "Kütüphaneye al", "Program gönder…". Gönderme penceresi:
program/sürüm/hedef klasör → **ön kontrol** → (uyarılar için onay) → **tezgah kimliğini yazarak
onay** → sonuç ve adım adım kayıt. Kütüphane ekranında "Yeni program yaz…", program ayrıntısında "Düzenle…" (editör);
gönderme penceresinde ve tezgah panelinde "Yeni klasör…" (hedef klasör tezgahta yoksa).

**Dosyalar:** `ftp-client.js` (`node:net`, sıfır bağımlılık; yalnızca gereken FTP komutları, `MKD` var, klasör silme
`RMD` bilerek YOK; komut enjeksiyonu/yol gezinmesi reddedilir) · `list-parse.js` (DOS ve UNIX LIST) ·
`library-db.js` (SQLite; `transfers.kind`) · `library.js` (doğrulama, karşılaştırma, matris, editör metin çevirisi) ·
`machine-files.js` (**tüm güvenlik denetimi burada**: tarama, içeri alma, ön kontrol, gönderme, klasör açma)
· `routes.js` (HTTP) · `test/mock-ftp.js` (Windows CE FTP'yi taklit eden **sahte sunucu**;
gerçek torna 8'in 2026-10-07 protokol diyaloğundan) · `test/harness.js`.

**Gönderme kuralları (kodda zorlanır, testleri `transfer.test.js`):**
1. Dosya **gönderilir, asla çalıştırılmaz/seçilmez**.
2. Hedefte aynı ad varsa **ÜZERİNE YAZILMAZ** (büyük/küçük harf duyarsız: CE öyle). Üzerine yazma
   modu **yok** (`overwriteEnabled: false`); gerçek tornada `RNTO`/`DELE` ezme semantiği ölçülmeden
   açılmamalı. **TEK İSTİSNA: "Toplu gönder"** (aşağıda): kullanıcının planda onayladığı dosyaların üzerine, tornadaki eski hâl ÖNCE kütüphaneye
   yedeklenerek ve **ezme semantiğine dayanmadan** (eski dosya yan ada alınır) yazılır.
3. Tezgahta **çalışan/seçili programın adıyla** gönderilmez. Canlı veri yoksa (ajan kapalı)
   çalışan program bilinmez → kullanıcı açıkça onaylamadan gönderilmez (`unknown-state`).
   Kök dizine (müşterisiz, ortak alan) gönderme de ayrıca onay ister (`root-target`).
4. Önce **geçici adla** (`ZZUP` + 6 rakam) yüklenir → boyut ve **geri okunup SHA-256** doğrulanır →
   `RNFR/RNTO` ile nihai ada çevrilir → yine doğrulanır. Yarım dosya nihai adla görünmez.
5. Doğrulama tutmazsa kendi oluşturduğumuz dosya silinir; **başkasının dosyasına dokunulmaz**
   (`DELE` yalnızca `ZZUP…` geçici adı ve SHA'sı tutmayan kendi nihai dosyamız için; testle denetlenir. **İstisna: kullanıcının
   açıkça başlattığı "Tornadan program silme"**, yukarıdaki kapılarla; silme akışı `transfer.test.js`'in bu kuralından ayrı `delete.test.js`'te sınanır.)
6. **Onay metni = tezgah kimliği** (`CNC-08`); sunucu da denetler. Genel "onaylıyorum" kabul edilmez.
7. Her gönderme (reddedilenler dahil) `transfers` tablosuna yazılır: kim (`by` + istemci IP), ne zaman,
   hangi program/sürüm/tezgah/klasör, SHA, adımlar, sonuç.
8. Bir tezgaha aynı anda **tek işlem** (tarama/gönderme/içeri alma); ikincisi `409`.
9. **Gönderme klasör açmaz**: hedef klasör tezgahta yoksa ön kontrol engeller. Yeni müşteri klasörü yalnızca `createFolder` ile
   (ayrı, tezgah kimliğiyle onaylı işlem, bkz. yukarıdaki "Tezgahta yeni müşteri klasörü"); klasör SİLME yoktur.
10. Kütüphaneye ad: `[A-Za-z0-9_.-]{1,40}`, `ZZUP`/`ZZRB` ile başlamaz; dosya ≤ 1 MB, metin (NUL yok).
11. **Kontrolcü modeline göre kapı:** sürücü kaydında modelin `fileTransfer.sendEnabled` değeri açıkça `false` ise
    (şu an **22TB**: gerçek tezgahta hiç denenmedi) ön kontrol "engel" verir, `send` 422 ile reddeder ve **FTP'ye hiç
    bağlanılmaz**; tarama/içeri alma (salt okunur) çalışır. Gerçek tezgahta doğrulanınca `true` yapılır
    (`sendPolicy()` in `machine-files.js`; testi `backend/models.test.js`). Aynı kapı **klasör açmayı** da kapatır (tornaya yazma).

**Ayarlar / ortam değişkenleri:** `DELETE_DISABLED=1` tornadan silmeyi (FTP `DELE`) her durumda kapatan acil anahtar · `PLANNING_DB_FILE` (varsayılan `data/planlama.db`; planlama: ürün kartları, siparişler, eşlemeler; **ayrıca yedeklenmeli**) · `AUTH_DB_FILE` (varsayılan `data/auth.db`, **ayrıca yedeklenmeli**) · `AUTH_DISABLED=1` (aşağıda) · `TRANSFER_DISABLED=1` gönderme tamamen kapanır (kütüphane,
tarama, ön kontrol çalışır) · `LIBRARY_DB_FILE` (varsayılan `data/library.db`; telemetri DB'sinden
**ayrı**, budanmaz, **ayrıca yedeklenmeli**) · `MACHINES_FILE` (envanter dosyasını değiştirir:
demo/test) · tezgah başına isteğe bağlı `ftpPort` (envanter) · sürücü kaydında `fileTransfer`
(`config/drivers.json`: protokol, port, kullanıcı, kök).

### Üretim adedi ve vardiya raporu (0.7.0, 2026-10-12)

Tezgahın parça sayacından **kaç adet, hangi programdan, hangi vardiyada, kaç saniyede** üretildiği sayılır ve gösterilir. Telemetri yolunun parçasıdır
(salt okunur; ajan/protokol değişmedi, backend mevcut `partCount/partTotal/cycleTimeSec/program` alanlarını kullanır).
- **Üretim olayı** (`backend/production.js` `PartTracker`, tablo `production` in `telemetry.db`): her mesajda sayaç izlenir, **sayaç arttığında bir satır**
  (zaman, program, adet, durum, çevrim süresi). Örnekler 7 günde silinir, bu satırlar **400 gün** saklanır; raporlar buradan gelir. Gerçek kayıtla doğrulandı:
  26 olay / 30 adet = tezgah sayacı farkı (18104 → 18134).
  - Adet = `partTotal` farkı (o kıpırdamadıysa `partCount`). **Fabrikada operatör vardiya başında "Parça"yı 0'a çeker** (ÖMÜR BOYU sayaç `ToplamParça` akmaya devam eder, 2026-10-12 kullanıcı teyidi): sıfırlamanın kendisi üretim sayılmaz ve ToplamParça farkı sıfırlamayla aynı saniyede biten parçayı ve veri kopukluğunda yapılanları da sayar (kayıp yok; simülasyonla sınandı). Ömür boyu sayaç okunamıyorsa/durmuşsa sayaç geri gidince görülen yeni değer "sıfırlamadan beri yapılan parça" sayılır (makul sınırı aşarsa `suspect`); taban her durumda yenilenir.
  - **Program** = ana program (`mainProgram`, yoksa `program`); alt program geçici geçişi parçayı bölmez. Aynı mesajda program değiştiyse parça ESKİ programındır.
  - **Çevrim süresi** (`cycle_sec`) = kontrolcünün çevrim sayacının parça artmadan önceki **tepe değeri** (gerçek tezgahta 22–27 sn, temiz). İki parça arası fark KULLANILMAZ:
    duruşları (157 sn, 43 sn…) içerir ve şişer. Pencere eksik olabilirse (sunucu çevrimin ortasında başladı, veri kopukluğu, program değişti) ya da adet 1'den büyükse
    **`NULL`** (tahmin yazılmaz); ortalama yalnız süresi bilinen olaylardan hesaplanır, hiç yoksa ekranda süre görünmez.
  - **Makul olmayan sıçrama** (geçen sürede üretilemeyecek fark: sayaç elle ayarlanmış) `suspect` işaretlenir ve **toplamlara katılmaz**; raporda "N sayaç sıçraması sayılmadı" diye ayrıca yazılır.
  - **Veri kopukluğundan / sunucu kapalıyken** artan adet gerçektir (tezgah sayacı arttı) ve sayılır, ama **zamanı kesin değildir** (`gap_ms` > 0): raporda `*` ile "vardiyası yaklaşık" notu.
    Yeniden başlamada taban, tezgahın son kayıtlı örneğidir (`lastCounters`).
  - **Geriye doldurma:** ilk açılışta (`meta` bayrağı, bir kez) mevcut 7 günlük örneklerden olaylar çıkarılır; böylece güncellemeden hemen sonra "bu vardiya" boş görünmez
    (bu olayların çevrim süresi yoktur: örnekler seyreltilmiş, uydurulmaz).
- **Vardiyalar** (`shared/shifts.js`, yerel saat): **Gündüz 07–19, Gece 19–07**. **Üretim günü = vardiyanın başladığı gün** (13 Ekim 03:00 = 12 Ekim gecesi). Vardiya değişirse yalnız `SHIFTS` listesi değişir.
- **Tezgah detayında "Üretim · vardiya adetleri" paneli** (`dashboard/production-view.js`): seçili üretim günü/aralığı için program başına Gündüz / Gece / Toplam, **adedin yanında parça süresi**
  ("120 adet · 24 sn"); **tarih seçimi (2026-10-13):** takvim (başlangıç/bitiş kutuları: tek gün ya da aralık, en çok 93 gün), hazır seçimler (Bugün / Dün / Son 7 gün / Son 30 gün), ◀ ▶ ile **aynı uzunlukta** önceki/sonraki aralık
  (sunucu `prevRange`/`nextRange` verir; sonraki bugünün üretim gününü aşmaz); aralıkta **"Gün gün"** tablosu; şu an süren vardiya işaretli; viewer de görür. Tarih kutuları bir kez kurulur, yalnız gövde yenilenir (seçim yaparken bozulmaz).
- **Program geçişleri (2026-10-13): "hangi programa hangi saatte geçildi, hangisi ne zaman bitti"** (`backend/program-runs.js`, tablo `program_runs` in `telemetry.db`, 400 gün): panelde ve "Üretim raporu"nda ("Program geçişleri" görünümü) satır = bir program çalışma aralığı:
  başladı, bitti (ya da "devam ediyor"), süre, **o aralıkta üretilen adet**, vardiya (başlangıç → bitiş vardiyası), ◂ ▸ = aralık seçilen tarihlerin dışına taşıyor (adet yalnız seçilen aralıktan sayılır). CSV: `/api/production/runs.csv`.
  Kurallar: program = ana program (`programOf`, adetle aynı kaynak); **okunamayan program (null) değişiklik sayılmaz**; program değişince eski aralık yenisinin başladığı anda biter; **10 dk'dan uzun sessizlikte** (tezgah kapandı / ajan durdu) aralık son görüldüğü anda biter ve
  veri gelince (aynı program bile olsa) yeni aralık açılır; sunucu yeniden başlarsa önceki aralık tezgahın son kayıtlı örneğinde kapanır ama **aynı program 10 dk içinde dönerse aynı aralık sürer**; ilk açılışta mevcut 7 günlük örneklerden geriye doldurulur.
  Zaman = mesajın kendi zamanı (gelecekte olamaz, geri gidemez). Adet = o aralıktaki `production` olayları (program eşleşir; sınır parçası eski programındır; şüpheli sıçramalar sayılmaz). Doğrulama: `backend/program-runs.test.js` 11 test + tarayıcıda sentetik geçmişle.
  **Ortak alt program O9001 gizlenir (2026-10-26, kullanıcı isteği):** kökteki `O9001` (§3, "çubuk alma" rutini) her parçada kısaca devreye girer; kontrolcü bu sırada `MainProg`'u da `O9001` (bazen boş) gösterdiği için eskiden her çevrimde **ayrı, gürültü dolu bir satır** açılıyordu. `programOf` (`backend/production.js`) artık O9001'i (büyük/küçük harf duyarsız) **okunamayan** sayar: ne "Program geçişleri"nde ayrı satır açar ne de parça atfını böler (ana programın devamı sayılır) — mevcut "ortak alt program parçayı bölmez" kuralının doğal uzantısı. Yan etki: program değişimiyle aynı mesajda sıfırlanan çevrim-süresi penceresi artık O9001 blip'inde bozulmuyor, `cycleSec` daha az `null` çıkar. Testi `backend/production.test.js` + `backend/program-runs.test.js` (uçtan uca, gerçek `TelemetryStore.ingest` ile).
- **"Üretim raporu" ekranı** (`#/uretim`, sol menü; viewer de görür): hazır aralıklar (bugün/dün/7/30 gün) ve tarih seçimi (en çok 93 gün), tezgah süzgeci,
  üç görünüm — **Makine bazlı** (tezgah → program), **Ürün (program) bazlı** (hangi tezgahlarda kaç adet), **Günlük**. Toplamlar sunucuda bir kez hesaplanır
  (`backend/production-report.js`), ekran ve CSV aynı sayıları kullanır. "Ürün" şimdilik = program adı; program adı ↔ müşteri ürün kodu eşlemesi (Mikro/iş emri) ayrı iştir.
- **CSV:** tezgah detayında **"CSV indir" artık ÖZET**: saniyelik satırlar yok; yalnız her üretilen parça (zaman, program, adet, sayaçlar, çevrim_sn) ve durum / program / alarm
  değişimleri (`compactMachineCsv`). Eski her-örnek dökümü **"Ham CSV"** (`export.csv?format=ham`). Üretim raporu CSV'leri: `view=makine|urun|gunluk` (günlük = tarih × vardiya × tezgah × program, Excel özet tablosu için).

### Planlama modülü (A: ürünler, siparişler, program eşleme — 0.8.0; B: iş emri — 0.9.0; C: üretim yaşam döngüsü — 0.10.0; T: fabrika PC'si operatör ekranı — 0.11.0; K: ürün tanıtım kartı ve kasa — 0.12.0; D: hammadde ve sarfiyat — 0.13.0; E: verimlilik ve duruş raporları — 0.14.0; GKK, ilk onay, teknik resim PDF'leri, ürüne göre ölçü ve izleyici erişimi — 0.17.0)

İkinci ürün (Mikro / iş emri / hammadde / verimlilik) için temel. **Tasarım ve aşamalar: `PLANLAMA-TASARIM.md`** (A–G ve T/K; A, B, C, T, D, E ve K'nın ilk kısmı — ürün tanıtım kartı/kasa — yapıldı). Telemetriden **ayrı modül**
(`backend/planning/`, ayrı veritabanı `data/planlama.db`, **ayrıca yedeklenmeli**; `PLANNING_DB_FILE`). Telemetri kodunu import etmez: tornalarda görülen program adları
`TelemetryDb.productionPrograms()` ile dışarıdan verilir. Uçlar `/api/planning/*` **çoğu yalnız admin** (izin tablosunda varsayılan reddet; okuma uçlarından bir kısmı 0.17.0'dan beri izleyiciye (viewer) de açık, bkz. aşağıdaki 0.17.0 bölümü). **Ayrı uygulama (0.9.1, 2026-10-12 kullanıcı kararı):** girişten sonra **uygulama seçim ekranı** (`#/uygulamalar`, `dashboard/apps.js`) çıkar: **CNC Telemetri** ya da **Planlama**. Telemetri'nin menüsünde Planlama yoktur; Planlama'nın kendi yan menüsü (`renderPlanningNav`: İş emirleri · Ürün kartları · Siparişler · Program eşleme), kendi üst çubuk yazısı vardır, tezgah listesi, canlı bağlantı göstergesi ve alt bilgi (mesaj sayısı) görünmez. Üst çubuktaki "Uygulamalar" düğmesi seçime döner. Adres boşsa admin seçim ekranını görür; **tek uygulamalı kullanıcı (operatör: yalnız Planlama) seçim ekranını hiç görmez**, doğrudan girer; izleyici (viewer) 0.17.0'dan beri iki uygulamayı da görür (Planlama'da yalnız okuma). Hangi rolün hangi uygulamayı göreceği `apps.js` `APPS[].roles` içinde yalnız kolaylıktır; yetkiyi sunucu verir (`policy.js`). Testi `backend/apps.test.js`. **Gerçek kurulumda ve gerçek viewer oturumuyla tarayıcıda denenmedi** (mantık birim testli, admin akışı demo'da denendi).
- **Ürün kartı** (`products`): anahtar katlanmış stok kodu (`Nİ002.001` = `NI002.001`); ad, müşteri ürün kodu, hammadde, alternatif hammadde, **tam boy (mm)**, net/brüt ağırlık, planlanan çevrim sn, not.
  **Birimler:** ağırlık **kg** (Excel'deki "BRÜT GR/NET GR" kolonları aslında kg: 0,0179 = 17,9 g; ekranda gram), uzunluk mm, süre sn. Net > brüt reddedilir (dara = brüt − net = talaş; Mikro stok kartıyla doğrulandı).
  Elle düzenlenen kart (`edited`) CSV içeri almada **ezilmez**, yalnız boş alanları dolar.
- **Excel'den CSV içeri alma** (`importers.js`, `csv-read.js`; bağımlılık yok): "CSV UTF-8" ya da eski Windows-1254, `;`/`,`/sekme, Türkçe ondalık virgül ve `gg.aa.yyyy`; **boş satırlar atlanır**
  (Excel biçimli boş alanı yüz binlerce satır olarak dışa aktarabilir; sınır 64 MB). Dosya türü **başlıklardan** tanınır: *iş emirleri listesi* (PLANLANAN: ALEN KOD, MAMÜL ADI …) → ürün kartları
  (her ürün için **en son iş emri**); *sipariş dosyası* (_SIPARIS: Mamul_Kodu, Evrak_No, Must_Sip_No …) → sipariş satırları + ürün kartında eksik alanlar (tam boy gelir, diğerleri yalnız boşsa).
  Tekrar yükleme güvenli (idempotent, `line_key`). **Bozuk veri sessizce yutulmaz** (uyarı): bilimsel gösterimli müşteri kodu (12 haneli kodlar Excel'de `6,01E+11` olup değer kaybeder), geçersiz ürün kodu, boş süre.
  "Tam döküm" kutusu işaretliyse dosyada olmayan eski sipariş satırları gizlenir (varsayılan KAPALI; tam dosyayı yeniden yüklemek geri getirir).
- **Doğrudan `.xlsx` içeri alma (2026-10-15):** "Excel içeri al…" artık Excel çalışma kitabını olduğu gibi alır (`backend/planning/xlsx-read.js`, bağımlılıksız: ZIP + XML; `importers.js` `importXlsx`/`importFile`). Dosya türü **içerikten** anlaşılır (ZIP imzası; uzantıya/Content-Type'a bakılmaz),
  **tüm sayfalar** taranır: tanınan sayfalar (iş emirleri, sipariş, GKK, ilk onay) ayrı toplu içeri alma kaydı olarak alınır (`dosya.xlsx › SAYFA`), tanınmayanlar (kâğıt form şablonu `İŞ EMRİ`, `_SEVKIYAT`) sebebiyle birlikte "atlanan sayfalar" olarak listelenir; hiçbir sayfa tanınmazsa 400.
  Yanıt `{format:'xlsx', sheets:[{sheet, ...sayfa sonucu}], skippedSheets, warnings}`. Neden CSV'ye üstün: değerler tam hassasiyetle gelir (12 haneli müşteri kodu sayı hücresinden `601000000123`, `6,01E+11` sorunu yok), tarih hücreleri stilinden tanınıp `gg.aa.yyyy` olur,
  boş biçimli satırlar (PLANLANAN sayfasının 1.043.348. satırında unutulmuş `.` vardı) sorun değil, çok sayfa tek yüklemede. **Uyarılardaki "Satır N" Excel'deki gerçek satır numarasıdır** (`normalize.js` `sheetRow`; CSV'de boş satırlar atıldığı için dizi sırası). Aynı kitapta ikinci siparis sayfası birincinin satırlarını gizlemez.
  Okunamayanlar açık iletiyle reddedilir: eski `.xls` ve şifreli dosya (OLE2), bozuk/kesik ZIP (CRC denetlenir), şifreli ZIP girdisi. Formül hücrelerinde Excel'in kaydettiği SON hesaplanmış değer okunur. Kullanıcının gerçek dosyalarıyla denendi (iş emirleri çalışma kitabı, sipariş/sevkiyat çalışma kitabı,
  EYS.FR.011, EYS.FR.013; geçici bellek veritabanına): CSV ile aynı sayılar (281 ürün kartı, 2.550 sipariş satırı, 165 GKK kaydı) ve doğru sayfa seçimi. Testi `backend/planning/xlsx.test.js` (9, sentetik kitaplar). **Excel'in kendi CSV çıktısıyla ve alt PC'de denenmedi** (CSV yolu da aynen duruyor).
- **Tezgah başında çalışan program, iş emri bağlı olmasa da (0.19.0, 2026-10-15, kullanıcı isteği):** deneme aşamasında ustalar sisteme dokunmaz, programı çalıştırır; **iş emri ofisten (yukarıdan) bağlanır**. Her Tezgah başı kartı canlı programı gösterir:
  ad (ana program; alt program farklıysa ayrıca), **ne zamandır ve kaç parça** (telemetrinin açık program aralığından: `programRuns` enjeksiyonu = `store.db.programRuns`; aralık yoksa/başka programınsa süre ve adet BOŞ, uydurulmaz), **hangi ürün** (program eşlemesi kesin;
  yoksa kural önerisi: stok kodu / müşteri ürün kodu (programın adı müşteri ürün kodudur) / ad; birden çok aday → "belirsiz") ve veri gelmiyorsa/program okunamıyorsa bunu söyler. **İş emri bağlı DEĞİLSE** kart "İş emri bağlı değil, program çalışıyor" der ve programa uyan **bekleyen iş emirlerini**
  önerir (bu tezgaha atanmış olanlar önce); **"İş emrini bağla"** Üretime başlat penceresini açar ve başlangıcı **programın başladığı ana** doldurur (sayım o andan itibaren, en fazla 72 saat geriye; sunucu sınırı; değiştirilebilir). İş emri bağlıyken program başka ürüne eşliyse "program başka ürüne ait" uyarısı (çapraz denetim).
  Yetki: bağla düğmesi başlat ile aynı (operatör + yönetici; izleyici yalnız görür). Kodu: `planning.js` `#programInfo` (`shopOverview().machines[].program`), `dashboard/planning-shop.js` `programBlock`/`waitingBlock`, `planning-production.js` `openStartDialog({startAt, startNote})`. Testi `backend/planning/shop-program.test.js` (7). Demoda
  gerçek kayıt oynatmasıyla denendi (program bloğu, öneri, bağlama, kartın aktif iş emrine dönmesi). **Gerçek tezgahta ve fabrika PC'sinde denenmedi.**
- **Kaynak klasörü ve "Kaynak dosyadan yenile" (0.19.0, 2026-10-15, kullanıcı isteği):** Mikro sipariş girilince Excel dosyasını kendisi güncelliyor; her seferinde dosya yüklemek yerine dosya **sabit bir klasöre** konur ve düğme klasörü okur
  (`backend/planning/sources.js`, `dashboard/planning-sources.js`). Düğmeler Ürün kartları / Siparişler / GKK rapor no / İlk onay (ve İş emirleri, Program eşleme) başlığında, yalnız yönetici: **"Kaynak dosyadan yenile"** (dosya değiştiyse etiket "(N değişiklik)" olur, durum satırı dakikada bir tazelenir),
  **"Kaynak klasörü…"** (yol ayarı + dosya durumu) ve eskisi gibi "Excel içeri al…".
  - **Klasör:** yönetici ayarlar (`settings` tablosu `sources.dir`, mutlak yol, var olan dizin; ayarlı klasör ASLA oluşturulmaz); ayar yoksa varsayılan **`data/kaynak`** (`SOURCES_DIR` ortam değişkeni değiştirir; yoksa ilk bakışta oluşturulur). Kurulu PC'de `C:/CNC-Telemetri/data/kaynak`.
    Yalnız `.xlsx`/`.csv`, alt klasör yok, `~$` kilit dosyaları ve `.` ile başlayanlar atlanır. **Sunucu SYSTEM hesabıyla çalışır: ağ paylaşımı (`\\sunucu\paylaşım`) ona kapalı olabilir; Mikro dosyasını YEREL klasöre yazdırın/kopyalayın** (arayüzde de uyarılır).
  - **Değişiklik tespiti:** her dosya için son içeri alınan boyut + değiştirilme zamanı + SHA-256 saklanır (`source_files`). Aynıysa dokunulmaz; zaman değişmiş ama içerik özeti aynıysa (dosya yeniden kaydedilmiş) işlenmez; farklıysa `importFile` ile işlenir (eskiden yeniye: aynı türde en yeni dosya kazanır).
    Okunamayan/yarım yazılmış dosya `okunamadı` olur ve KAYDEDİLMEZ (bir sonraki yenilemede yeniden denenir); hiçbir biçime uymayan dosya/sayfa bir kez `atlandı` der ve değişmedikçe yeniden denenmez. Sonuç: dosya başına durum + toplamlar + **ne değişti listeleri**
    (yeni/güncellenen sipariş satırları, yeni/güncellenen ürün kartları ve alanları, yeni GKK/ilk onay kayıtları; her liste en çok 40). Aynı anda tek yenileme (`409 busy`).
  - **Siparişler:** Mikro dosyasından KALKAN satır uygulamada KALIR (gizlenmez; "tam döküm" yüklemesi elle yapılır). **Ürün kartı alanları** (`importSiparis`): bos alan dolar; DOLU alan yalnız **Mikro'da değiştiyse** (dosyadaki değer, o kartın `src_snapshot` sütunundaki "Mikro'dan en son gelen" değerden farklıysa) ve kart elle düzenlenmemişse güncellenir.
    İlk Mikro içeri almasında anlık görüntü yoktur: karttaki değerler (planlama Excel'inden ya da elle gelmiş olsa da) EZİLMEZ, yalnız boşlar dolar ve anlık görüntü yazılır; böylece planlanan çevrim gibi verimlilik hesabına giren değerler toplu değişmez. **Elle düzenlenmiş kartta** Mikro farkı uygulanmaz ama sonuçta "korunan" olarak listelenir.
    Tam boy eskisi gibi düzenlenmemiş kartta her zaman Mikro'dan gelir.
  - **GKK / ilk onay:** klasördeki form dosyaları `importFile` ile birleştirilir (var olan kayıt güncellenir, uygulamada açılan ve dosyada olmayan kayıt silinmez).
  - **Uçlar (yalnız yönetici):** `GET /api/planning/sources` (durum) · `PUT /sources/dir {dir}` · `POST /sources/refresh {force?}`. Testi `backend/planning/sources.test.js` (6), `customer-code.test.js` (7). Gerçek dosyalarla (geçici veritabanı) denendi: 3 dosya 0,8 sn'de işlendi, ikinci yenileme değişmeyen dosyaları atladı; demoda sentetik Mikro dosyasıyla yeni/değişen satır ve kart bulundu.
    **Denenmedi:** fabrika PC'sinde gerçek Mikro dosyasının yazıldığı klasörle; Mikro'nun dosyayı yazarken (yarım) okunması gerçek zamanlı; elle düzenlenmiş kart sayısı çok olduğunda "korunan" listesinin kullanılabilirliği.
- **Müşteri ürün kodu = ilk sözcük (0.19.0):** kod, değerin boşluğa kadar olan ilk sözcüğüdür; tire/nokta/alt çizgi kodun parçasıdır (`normalize.js` `firstToken`, `customerCodeFromName`, `resolveCustomerCode`). **İş emri formunda MÜŞTERİ ÜRÜN KODU boş geliyordu** (kartta kod yoktu); Mikro ürün adları `140100188 DAİKİN ... SOMUN 5/8"` diye başlar.
  Kural: PLANLANAN'ın "MÜŞTERİ KODU" sütunu doluysa ilk sözcüğü (96 üründe `140100188 1234-567` gibi iki parçalıydı); boş/bozuksa **ürün adının ilk sözcüğü, ancak kod sayılırsa**: en az 5 rakam, yalnız harf/rakam/`-`/`.`/`_` (ölçü ve diş yazımları `1/2"`, `G1/2"`, `M10`, `99,9/99` kod DEĞİLDİR).
  Gerçek Mikro listesinde 500 üründen 459'unda kod çıkıyor (kalan 41'in adı bir sözcükle ya da ölçüyle başlıyor). Bir kerelik geçiş (ayar bayrağı `gecis.musteri-urun-kodu-v1`): düzenlenmemiş kartlarda iki parçalı kodlar ilk sözcüğe iner, boş kodlar adın başından dolar; **iş emirlerinin kopya değerleri de** düzeltilir; elle düzenlenmiş karta dokunulmaz.
  İş emri/kasa/kart çıktısı kodu `resolveCustomerCode` ile verir (kartta yoksa adın başından). Elle açılan karta kod kendiliğinden yazılmaz.
- **Paketleme formu (EYS.FR.007) ve koli içi adet öğrenme (0.19.0, 2026-10-15, kullanıcı isteği):** Paketleme sekmesi artık iki görünümdür: **"Paketleme formu"** (varsayılan) ve eski **"Kasalar (kart no ile)"** (kesin adet girişi, değişmedi). Form, kâğıt PAKETLEME FORMU'nun dijital karşılığıdır
  (`backend/planning/packing.js`, `dashboard/planning-packing-form.js`): **her şey Alen Otomat ürün koduyla** yürür; vardiya sayfası = tarih + vardiya (Gündüz/Gece, `shared/shifts.js`) + hava basıncı (bar, 0–20); satır = operatör ismi, ürün, iş emri (isteğe bağlı), koli sayısı, koli içi adet,
  yarım koli adedi, %100 görsel kontrol, hurda adedi, not. **Toplam = koli × koli içi adet + yarım koli** (hurda ayrı gösterilir, toplamdan düşülmez). Ürün kartı yoksa satır eklenmez (`no-product`); iş emri başka ürüne aitse 409 (`wo-mismatch`). Hava basıncı sayfa başına bir kez girilir.
  - **Koli içi adet öğrenme:** bir ürünün koli içi adedi genelde sabittir (bazen kutuya 10–15 fazla sıkıştırılır, fazlası yarım koli olur). Ürünün **ilk** paketleme satırı kaydedilince adet ürün kartına **standart koli içi adet** (`products.box_qty`) olarak yazılır (`setBoxQtyIfEmpty`; yalnız boşsa; kart "elle düzenlendi" SAYILMAZ), sonraki seçimde **öneri** gelir ve alana otomatik dolar.
    Satırdaki adet serbestçe değiştirilir, standart DEĞİŞMEZ (ürün kartından elle düzeltilir: "Koli içi" sütunu); son paketlemelerde sık görülen değerler ("500 × 3", "510 × 1") ayrıca tıklanabilir öneridir. Önerinin yanında ürüne ait iş emirleri (tek üretimdeki iş emri otomatik seçilir) ve ürünün **kutu etiketi dosyaları** (indirme bağlantısı; her dosyanın yanında geldiği müşteri klasörü: aynı ürünün farklı müşteri klasörlerinde aynı adlı iki etiketi olabilir) görünür.
  - **Satır silinmez:** düzenlenir (`PUT /packing/rows/:id`) ya da **iptal edilir** (neden, kim, ne zaman kayıtlı; sayfa ve toplamda görünmez, tabloda kalır). İş emri ayrıntısı ve kasa paneli o iş emrine bağlı satırların toplamını gösterir (`getWorkOrder().packing`: koli, adet, satır, hurda).
  - **Yazdırma:** "Formu yazdır…" kâğıt formun düzeninde A4 yatay (`@page paket`, 14 satıra tamamlanan boş satırlar elle doldurulur; altta EYS.FR.007 yayın tarihi, toplam).
  - **Yetki:** sayfa/öneri/satır ekle-düzenle-iptal/hava basıncı **operatör + yönetici** (`policy.js` `OPERATOR_PLANNING`); izleyici göremez. **Bölüm kapısı:** `/api/planning/packing/*` `paketleme` bölümüne bağlıdır (`config/features.json`; kapalı kurulumda 403 `section-closed`). Ürün arama operatörün zaten sahip olduğu dar `programs/product-search`'tür.
  - **Uçlar:** `GET /api/planning/packing/sheet?day=&shift=` · `PUT /packing/sheet/air {day,shift,airBar}` · `GET /packing/suggest?stockCode=` · `POST /packing/rows` (yanıt `learned`, `standardBoxQty`) · `PUT|DELETE /packing/rows/:id` (`DELETE ?reason=`). Tablolar `packing_sheets`, `packing_rows` (`planlama.db`, eski veritabanları açılışta genişler). Testi `packing.test.js` (9).
- **Teknik resim klasörü ve Etiket klasörü — iki AYRI klasör, ürün koduna göre eşleme (0.19.0, 2026-10-15, kullanıcı isteği):** teknik resim PDF'leri ve kutu etiketi dosyaları (Word) fabrikada bilgisayarda dosya adında Alen Otomat ürün koduyla durur; iş emri açarken tek tek PDF yüklemek yerine dosyalar klasöre konur,
  Ürün kartları başlığındaki **"Teknik resimleri eşle…"** ve **"Etiketleri eşle…"** düğmeleri (yalnız yönetici) klasörü tarar ve dosyaları ürün kartlarına bağlar (`backend/planning/doc-folder.js` `DocFolder`; her tür için ayrı örnek: `planning.drawingFolder`, `planning.stickerFolder`; `dashboard/planning-docs.js`).
  - **İki klasör:** teknik resim (`.pdf`; ayar `docs.cizim.dir`, varsayılan `data/teknik-resim`, `DRAWINGS_DIR`) ve etiket (`.docx`/`.doc`/`.pdf`; `docs.etiket.dir`, varsayılan `data/etiket`, `STICKERS_DIR`). Klasör yolu düğmenin penceresinden ayarlanır (mutlak yol, var olan dizin; ayarlı klasör ASLA oluşturulmaz). Kurulu PC'de `C:/CNC-Telemetri/data/teknik-resim` ve `.../etiket`.
    **Sunucu SYSTEM hesabıyla çalışır: ağ paylaşımı ona kapalı olabilir, YEREL klasör kullanın** (pencerede de uyarılır). Alt klasörler taranır (en çok 4 derinlik, 20.000 girdi); `~$` kilit dosyaları ve `.` ile başlayanlar atlanır.
  - **Kod bulma (ilk bulan kazanır):** (1) dosya adında ya da klasör yolunda **Alen ürün kodu** (`SR002.013 DAIKIN.pdf`, `SR002-013.pdf`, `SR 002 013.docx`, klasör adı `SR002.013`; ayırıcı nokta/tire/alt çizgi/boşluk ya da hiç olmayabilir); (2) **dosya adındaki müşteri ürün kodu**: adın tamamı ve her sözcüğü kartlardaki müşteri koduyla
    karşılaştırılır (`headerKey`: büyük/küçük harf, nokta/tire/boşluk fark etmez; en az 5 karakter ve bir rakam; `601037100010 N.doc` → `N` kod sayılmaz, `Nİ049.002 - 601.SMN.613.001.pdf` Alen koduyla eşlenir). **Aynı müşteri kodu birden çok kartta varsa BAĞLANMAZ** (sebep "müşteri kodu birden çok ürün kartında (…)" ile listelenir);
    (3) yalnız etiket klasöründe, adda kod yoksa **Word dosyasının İÇİNDEKİ yazı** (`.docx` metni, kod birden çok parçaya bölünmüş olsa da; `.doc`'ta ham bayt taraması: 8 bit + UTF-16, iki hizalama): önce Alen kodu, sonra karttaki bir müşteri kodu. Sonuç penceresi hangi yoldan eşlendiğini yazar ("müşteri koduyla", "dosyanın içindeki koddan").
    Bir dosyada birden çok Alen kodu varsa hepsine bağlanır. Ürün kartı olmayan kod "eşleşmedi" listelenir (karta bağlanmaz, kart açılmaz): ürünler önce Mikro dosyasıyla (Kaynak dosyadan yenile) gelmeli, **sonra** eşleme yapılmalı.
  - **Varsayılan: yalnız resmi/etiketi OLMAYAN ürünler eşlenir**; olan ürüne dokunulmaz (elle yüklenmiş eski resimler ve iş emri resimleri de "var" sayılır). "Yeni sürümleri de güncelle": klasörden eşlenmiş dosya değiştiyse (içerik SHA'sı) yenisiyle değiştirilir, elle eklenenlere dokunulmaz. Ürün başına en çok 8 dosya; resim ≤ 20 MB (`inspectPdf` ile doğrulanır, şifreli/bozuk reddedilir), etiket ≤ 10 MB.
    Sonuç penceresi: bağlananlar, eşleşmeyen dosyalar (ürün kodu bulunamadı / ürün kartı yok), kabul edilmeyenler ve **hâlâ resmi/etiketi olmayan ürünler** (liste en çok 60).
  - **İş emri teknik resmi devralır:** yeni iş emri açılınca ürünün klasörden/elle bağlı teknik resimleri kendiliğinden iş emrine bağlanır (önce ürün resimleri, yoksa aynı ürünün son iş emri resimleri); klasörden yeni bağlanan resimler ürünün **bitmemiş ve resimsiz** iş emirlerine de bağlanır. İş emri PDF'i (form + resimler) eskisi gibi.
  - **Etiket:** ürün kartında ve **paketleme ekranında ürün seçilince** etiket dosyası görünür (Word dosyası indirilir; PDF tarayıcıda açılır). Etiket tasarımı ürün bazındadır ve ürün kodu dosyadadır; **sistem etiketi kendisi basmaz** (Word dosyasını açıp bastırmak ustaya kalır).
  - **Saklama:** `product_files` tablosu (tür `cizim`/`etiket`, kaynak `klasor`/`elle`, göreli yol) + içerik adresli `drawing_files` (aynı dosya tek kez). Ürün kartı penceresinde "Dosyalar" bölümü (bağlantılar, yönetici "Kaldır"), ürün listesinde Resim/Etiket sütunları. Uçlar: `GET|PUT /api/planning/drawing-folder[/dir]` · `POST /drawing-folder/match {update?}` ·
    aynıları `sticker-folder` · `GET /api/planning/product-files/:id` (operatör + yönetici; PDF satır içi, Word indirme) · `DELETE /product-files/:id` (yönetici). Testi `doc-folder.test.js` (13). Demoda sentetik dosyalarla tarayıcıda uçtan uca denendi (eşleme, Word içi kod, paketleme formu, öneri, düzenle/iptal, yazdırma, iş emrine devralma, operatör/izleyici sınırları).
  - **Gerçek etiket klasörüyle denendi (2026-10-15, fabrika sahibinin etiket şablonları klasörü, demo veritabanında 502 gerçek ürün kartıyla):** 379 dosya (378 eski `.doc`, 1 `.docx`; 17 müşteri klasörü + kökte genel şablonlar), 1,2 sn'de taranıp **339 ürün kartına 377 etiket dosyası** bağlandı (302 üründe 1, 36'sında 2, 1'inde 3 dosya; ikinci çalıştırma
    yeni bir şey eklemez); **15 dosya eşleşmedi**: 5 genel şablon (Alen etiket şablonu, logo/mastar, hammadde, ilk onay), 1 kartı olmayan Alen kodu, 2 kartı olmayan müşteri kodu, 7 ürün adıyla adlandırılmış ve içinde karta uyan kod olmayan dosya (elle bağlanır). Dosya içinden eşlenen 109 dosyanın hepsinde karttaki kod gerçekten geçiyor (bağımsız denetim).
    **Etiket dosyalarının yapısı (karar için):** her `.doc` bir müşteri-ürün etiketidir, sayfada aynı etiket 6 kez tekrarlanır; etikette müşteri sipariş/kalem no, **müşteri ürün kodu**, ürün adı, ölçü ve elle yazılan iki alan vardır: **`QTY : 156` (koli içi adet) ve `PACKING DATE : 26.01.2026` (paketleme tarihi)**; müşteriye göre biçim/dil/logo değişir (başka şablonda `KOLİ İÇİ ADET`, `PAKETLEME TARİHİ`).
    Usta Word'de bu iki alanı değiştirip basar (yarım koli olursa adet farklıdır; nadiren adetler boş basılır). Sistem şimdilik **yalnız doğru dosyayı bulur ve indirtir**; adet/tarihi doldurmaz (.doc ikili biçimi, uzunluğu değişen metni güvenle yazmaya elvermiyor). Gerçek teknik resimlerden yalnız 1 PDF vardı (`Nİ049.002 - …pdf`, Alen koduyla bağlandı).
  - **DENENMEDİ:** fabrikanın gerçek teknik resim klasörüyle (tek örnek PDF dışında); fabrika PC'sinde etiket klasörüyle; kâğıt formla yan yana A4 yatay baskı; paketleme formunun ustalarla gerçek vardiyada kullanımı; koli içi adedin ürün kartında gerçekten sabit kalıp kalmadığı.
- **Siparişler:** müşteri sipariş no + evrak no + müşteri ile gruplu arama (tam eşleşme önde). **Müşteri sipariş no benzersiz değil** (birden çok evrağa/müşteriye yayılır, "NUMUNE" gibi tekrar eden değerler): tek sonuç varsayılmaz.
  Bir siparişte çoğunlukla birden çok ürün satırı; aynı evrakta aynı ürün birden çok satır olabilir.
- **Program ↔ ürün eşlemesi:** tornalarda parça üretmiş programlar listelenir; **öneri** kuralları: stok koduyla birebir (`SR001-013` → `SR001.013`, `NI002-001` → `Nİ002.001`), müşteri koduyla, ürün adı bu kodla başlıyorsa
  (ad ilk sözcüğü müşteri koduyla yalnız ~%65 örtüştüğü için en zayıf kanıt). **Öneri kendiliğinden uygulanmaz**; "birebir stok koduyla tutanları toplu onayla" yalnız tek ve kesin olanları onaylar.
- **Doğrulama (A):** 25 test (`backend/planning/planning.test.js`, hepsi sentetik veri), yetki testleri (viewer 403, anonim 401), ayrıca gerçek dosyalar geçici veritabanına alınıp tarayıcıda denendi
  (281 ürün kartı, 2.550 sipariş satırı; bir ürün kartının net/brüt değerleri Mikro stok kartındaki net + dara ile birebir tuttu). **Gerçek kurulumda (alt PC) ve Excel'in kendi CSV çıktısıyla henüz denenmedi.**

**B aşaması — iş emri (0.9.0):** Excel'deki "PLANLANAN" sayfasının yerine; sipariş → satır → ürün akışıyla uygulamada açılır. Yalnız admin. Sekme: Planlama › **İş emirleri** (varsayılan sekme).
- **Akış:** "Yeni iş emri" → *Siparişten* (müşteri sipariş no / evrak no / müşteri / ürün ara → sipariş → satır; satırda sipariş, kalan, **iş emrinde**, **planlanmamış** adet; ürün kartı olmayan satır seçilemez)
  ya da *Siparişsiz* (stok/numune; ürün ara). Sonra **hedef adet** (varsayılan = satırın planlanmamış adedi; tamamı zaten planlıysa boş), termin (satırın termini), **tezgah** (envanterden: CNC-01…08 = kâğıttaki tezgah no 1–8,
  eski CNC/BCNC ayrımının yerine), numune adedi (isteğe bağlı), açıklama. Ürün kartının hammadde/ağırlık/boy/süre değerleri iş emrine **KOPYALANIR** (kart sonradan değişse iş emri değişmez; iş emri
  ekranında o iş emrine özel düzeltilebilir). Siparişler sekmesinde de satır başına "İş emri aç".
- **Hesaplar** (`backend/planning/calc.js` = tek doğru; ekrandaki canlı önizleme `dashboard/planning-common.js`'teki aynı formüller, **`calc-sync.test.js` ikisinin eşitliğini sınar**): hammadde kg = adet × brüt;
  planlanan süre saat = adet × planlanan sn / 3600; **çubuk (BOY) = adet × (tam boy + 2 mm) / 2900** (kullanıcı onayladı; 3 m çubuk, faydalı 2900 mm). Bilinmeyen girdi → `null` (0 değil).
- **Numara:** yıl + 6 hane (`2026001110`). Taban: Excel'den içeri alınan iş emri numaralarının en büyüğü (`seq_floor`) ya da elle girilen "en son verilen no" (`PUT /api/planning/work-orders/sequence`);
  taban hiç bilinmiyorsa iş emri penceresi uyarır ve ayarlatır (Excel ile numara çakışmasın). Yıl değişince sıra 1'den başlar.
- **Uyarılar** (engellemez): hedef adet satırın planlanmamış kalanından fazla; ürün kartında eksik değer (hammadde/brüt/boy/süre) → ilgili hesap boş kalır.
- **Yaşam döngüsü:** `planlandi` → `iptal` (neden en az 3 karakter, geri alınamaz; iptal edilen salt okunur). Düzenleme yalnız planlı iş emrinde; her değişiklik **geçmişe** Türkçe etiket ve gram ile yazılır
  (`work_order_events`: oluşturuldu / güncellendi / iptal edildi, kim, ne zaman). Sonraki aşamalar durumları genişletir (üretimde, bitti: C).
- **Yazdırılabilir form** (`planning-wo-form.js`; **0.17.0'dan beri sunucuda PDF olarak üretilir ve teknik resimlerle birleştirilir, bkz. 0.17.0**; aşağıdaki açıklama düzen içindir): bugünkü kâğıt İŞ EMRİ formunun düzeni (A4 dikey); sistemde bilinenler dolu, el ile yazılanlar (üretim gramajı, gerçek süre, yetkili, alttaki
  TARİH/VARDİYA/ADET tablosu) boş. Yazdır = tarayıcı yazdır penceresi (`body.pl-printing` + `@media print`).
- **Uçlar:** `GET/POST /api/planning/work-orders` (`?q=&status=aktif|iptal|tumu&machine=&limit=&offset=`), `GET /work-orders/next`, `PUT /work-orders/sequence`, `GET/PUT /work-orders/:no`, `POST /work-orders/:no/cancel`.
- **Doğrulama (B):** 11 backend testi (`work-orders.test.js`: numara/taban/yıl, kopya, uyarılar, düzenleme, iptal, HTTP) + `calc-sync.test.js`; tarayıcıda gerçek dosyalarla (geçici demo veritabanı) sipariş → satır → iş emri → form, siparişsiz,
  düzenleme, iptal sonrası salt okunur denendi. **Gerçek kurulumda ve gerçek kâğıt formla yan yana karşılaştırma yapılmadı; yazıcıdan gerçek baskı denenmedi** (yalnız ekran).

**C aşaması — üretim yaşam döngüsü ve telemetri bağlantısı (0.10.0):**
- **Durumlar:** `planlandı → üretimde → bitti` (+ `iptal`). **Başlat/bitir bir insan eylemidir** (fabrikadaki PC'de ortak hesapla; şimdilik yönetici ekranında), **adet telemetriden gelir:** iş emrinin penceresi
  [başlangıç, bitiş] ve tezgahı için `production` olayları sayılır (şüpheli sayaç sıçramaları sayılmaz; veri kopukluğundan sonra sayılanlar "yaklaşık" işaretlenir). **Program ↔ ürün eşlemesi adedi belirlemez**, yalnız çapraz denetimdir
  (başka ürüne eşli program çalışıyor / eşlenmemiş program / eşleme yok uyarıları).
- **Başlat:** tezgah (varsayılan iş emrindeki; operatör "bu tezgahta başlatıyorum" diye değiştirebilir), başlangıç zamanı (boş = şimdi; en fazla 72 saat geriye alınabilir, adet başlangıçtan itibaren sayılır), yapan kişi
  (isteğe bağlı serbest metin: ortak hesap kullanıldığı için), elle doldurulan alanlar (gerçek hammadde, GKK no, ilk onay no: hepsi isteğe bağlı). **Bir tezgahta aynı anda tek `üretimde` iş emri**; başlangıç, aynı tezgahta önce biten iş emrinin
  bitişinden önce olamaz (409 `machine-busy` / `overlap`). Şimdi başlatılırsa tezgahın o anki ömür boyu sayacı kaydedilir (geriye alınmış başlangıçta bilinmez, `null`). Baslamış iş emrinin tezgahı değiştirilemez.
- **Canlı ilerleme** (`progress.js`, saf hesap; 10 sn'de bir tazelenir): üretilen / kalan / yüzde, **vardiya kırılımı** (Gündüz/Gece), **üç süre ayrı gösterilir** (planlanan çevrim · ölçülen çevrim = kontrolcü çevrim sayacı tepe değeri · parçalar arası süre;
  fark gizlenmez), program tablosu, **tahmini bitiş** (mevcut hızla; vardiya ve duruşları hesaba katmaz) ve **termin riski** rozeti, tezgahın şu anki durumu/programı.
- **Bitir:** sonuç **dondurulur** (`work_orders.result_json`): sonradan telemetri verisi gelse ya da silinse değişmez; hedefin altı/üstü ve "hiç parça sayılmadı" uyarılır. Yanlışlıkla bitirilen **"Üretime geri al"**
  (donmuş sonuç silinir; sonrasında aynı tezgahta başka iş emri çalışmışsa reddedilir). **İptal:** üretimdeki iş emrinde o ana kadarki adet dondurulur; biten iş emri iptal edilmez (önce geri alınır).
- **Numune:** iş emrinde numune adedi girildiyse ilk N adedin ölçülen ortalama çevrimi gösterilir; N tamamlanınca ve planlanandan ≥ %2 farklıysa **"Ürün kartına yaz"** önerisi (onaylı düğme; kendiliğinden yazılmaz).
- **Form:** kâğıt iş emri formunun alt TARİH/VARDİYA/ADET tablosu, üretime başlamış iş emrinde vardiya adetleriyle dolar (sütun sütun; kalanı elle yazılır).
- **Telemetri bağlantısı enjeksiyonla** (planlama telemetriyi import etmez): `server.js` `productionEvents` (= `store.db.productionEvents`) ve `liveMachine` (= `store.liveInfo`, ömür boyu/vardiya parça sayacı `partTotal/partCount` eklendi) verir.
  Eski `planlama.db` dosyaları açılışta yeni sütunlarla genişler (`#migrate`).
- **Uçlar:** `POST /api/planning/work-orders/:no/start` (`machineId?, startAt?, person?, fields?`) · `/finish` (`endAt?, person?`) · `/reopen`; liste `?status=aktif|planlandi|uretimde|bitti|iptal|tumu` (üretimdekiler en üstte;
  `aktif` = planlandı + üretimde). Dosyalar: `backend/planning/progress.js`, `planning.js`, `dashboard/planning-production.js`, `planning-workorders.js`.
- **Doğrulama (C):** `lifecycle.test.js` 12 test (sentetik olaylarla saf hesap, vardiya sınırı 19:00, durum geçişleri, çakışma, dondurma, geri alma, eski veritabanı geçişi, HTTP); demo'da (gerçek kayıt oynatması, CNC-08)
  başlat → canlı adet → bitir → form denendi. **Gerçek tezgahta, gerçek vardiya geçişinde ve fabrika PC'sinde denenmedi.**
- **Sınırlar:** kasa kartı (K) ve sarfiyat (D) sonraki aşamalar; tahmini bitiş vardiya/duruşları hesaba katmaz.

**T aşaması — fabrika bilgisayarında operatör ekranı ve duruş nedeni (0.11.0, 2026-10-12):** Kullanıcı kararları: tablet donanımı beklenmez (aşağıdaki PC yeterli), **ortak hesap**, **ret/hurda/fire tutulmaz**.
- **`operator` rolü** (ortak hesap, ör. "fabrika"): yalnız Planlama uygulamasının **"Tezgah başı"** bölümünü görür (Telemetri, Ürün/Sipariş/İş emirleri listesi yönetimi, Ayarlar, Program kütüphanesi YOK; seçim ekranı yok, girişte doğrudan Tezgah başı).
  Sunucuda yeni yetki sınıfı `operator` (`policy.js` `OPERATOR_PLANNING`, TEK yerde): `GET summary | downtime-codes | shop/overview | shop/stops | work-orders[/:no]`, `POST work-orders/:no/start|finish`, `POST|DELETE shop/downtime-reasons`;
  bunlar operator ve yöneticiye açık, **viewer'a kapalı**; geri kalan her planlama ucu (ürün, sipariş, içe aktarma, program eşleme, iş emri açma/düzenleme/iptal/geri alma) yöneticiye özel. Operatör ayrıca viewer gibi izleme verisini okuyabilir (IP/port görmez).
  **Başlatırken operatör yalnız şu alanları yazabilir:** gerçek hammadde, GKK no, ilk onay no, ölçülen net gramaj, not (`routes.js` `OPERATOR_START_FIELDS`; hedef adet/ağırlık/boy/hammadde kodu gibi planlama alanları 403). Oturum viewer gibi uzun (30 gün boşta / 90 gün mutlak): fabrika PC'si sürekli açık.
  `auth.db` `users` tablosunun CHECK kısıtı yeni rolü almadığı için **açılışta tablo yeniden kurulur** (`AuthDb.#migrate`; kullanıcılar ve oturumlar korunur, testli). Hesap: Ayarlar > Kullanıcılar (rol "Operatör") ya da `auth-cli.js ekle <ad> operator`.
- **Tezgah başı ekranı** (`dashboard/planning-shop.js`; yönetici de görür): tezgah başına kart — canlı durum, üretimdeki iş emri ve ilerleme çubuğu, tahmini bitiş/termin riski, **"İş emrini bitir"**; üretimde değilse tezgaha atanmış bekleyen iş emirleri için **"Başlat"**
  (başlat penceresi tezgahı kartınkine ayarlar) ve "Başka iş emri başlat…" (bekleyen tüm iş emirlerinde ara). Büyük dokunmatik düğmeler, 10 sn'de bir tazelenir. "Yapan kişi" serbest metindir (ortak hesap yüzünden kimlik doğrulama DEĞİL), tarayıcıda hatırlanır; kayıtta işlemi yapan hesap + bu metin ayrı tutulur.
- **Duruş nedeni:** süre **telemetriden** (`spans`), neden insandan. **Duruş** = art arda BOŞTA/ALARM/KAPALI aralıkların birleşimi; **VERİ YOK (NO_DATA) duruş değildir ve duruşu böler** ("veri gelmedi" ≠ "tezgah durdu"); eşik (`DEFAULT_MIN_STOP_MS` = 3 dk) altındakiler sorulmaz.
  Operatör kartta "N duruşun nedeni bekliyor" düğmesinden son 24 saatin duruşlarını görür, **dakika yazmaz**: iki adımda neden seçer (sık kullanılanlar + 7 grup; kod → süre/not/kişi → kaydet). Bir duruş **birden çok nedene bölünebilir** (alt aralıklar, çakışamaz: 409); neden duruşun
  sınırına ±60 sn hoşgörüyle kırpılır, ölçülmüş bir duruşun dışına neden bağlanamaz (`no-stop`); en fazla 7 gün geriye. Neden atanmamış kısım ≤ 60 sn kalınca duruş "cevaplandı" sayılır. Kayıt, o an açık iş emrine (varsa) bağlanır (`wo_no`; sonraki verimlilik raporu için). Silme yumuşaktır (kim/ne zaman kayıtlı).
- **Kod listesi:** `config/downtime-codes.json` (Excel DURUŞ sayfasından: **D1–D46, Z1–Z4**; D21/D22 Excel'de yok; kâğıt kart D21'den itibaren 2 kayık, sistem Excel listesini kullanır), `shared/downtime-codes.js` doğrular (hatalı dosya sunucuyu başlatmaz); açılışta veritabanıyla eşitlenir
  (kod silinmez, kaldırılan kod pasifleşir). Ekranda gruplar: Değişim ve ayar · Bekleme ve yok · Kalite · Arıza ve bakım · Mola ve planlı · Devir düşüklüğü · Diğer.
- **Dosyalar:** `backend/planning/downtime.js` (saf: `buildStops`, `attachReasons`), `planning.js` (`machineStops`, `shopOverview`, `addDowntimeReason`, `removeDowntimeReason`), `routes.js`, `dashboard/planning-shop.js`; telemetri enjeksiyonu `server.js` `spans`.
  Tablolar `downtime_codes`, `downtime_reasons` (`planlama.db`). Rol bazlı sekmeler: `planning-view.js` `TABS[].roles`; yönlendirme/yetkisiz ekran koruması `app.js` `readRoute`.
- **Doğrulama (T):** `downtime.test.js` 7 test (durum birleşimi, NO_DATA bölmesi, eşik, bölünmüş nedenler, çakışma, kırpma, ana ekran, kod doğrulaması, HTTP + operatör alan sınırı), `auth` testleri (operatör sınıfı, `auth.db` geçişi, **gerçek sunucuda uçtan uca operatör/viewer/anonim matrisi**);
  tarayıcıda gerçek giriş (operatör hesabı) ile: giriş → doğrudan Tezgah başı, yetkisiz adreslerin yönlendirilmesi, başlat/bitir, sentetik telemetriyle duruş + neden. **Gerçek tezgahta, gerçek fabrika PC'sinde ve gerçek operatörle denenmedi.**
- **Sınırlar:** ölçülmemiş (telemetrinin görmediği) kayıp için elle dakika girişi yok (E aşamasında); duruş nedeni raporu/verimlilik (E) henüz yok; eşik (3 dk) Ayarlar'dan değiştirilemez; kod listesi yönetici ekranından düzenlenemez (dosyadan).

**K aşaması — ürün tanıtım kartı ve kasa (0.12.0, 2026-10-13):** Kullanıcı kararları: kartı **sistem basar** (kendi numarasıyla, düz kâğıda), kasa dolarken **adet bilinmez**, ret/hurda sistemde tutulmaz.
- **Akış:** operatör, Tezgah başı kartında üretimdeki iş emri için **"Yeni kasa aç"** der → sistem **`K000001`** gibi kart numarası verir, tezgahın o anki parça sayacını kaydeder ve kartı gösterir ("Yazdır"). Kasa dolunca **"Kasayı kapat"**
  (**sayılan adet** = açma–kapama aralığında o tezgahta telemetrinin saydığı adet = TAHMİN; bitiş sayacı); kapatınca "Kartı yazdır" / "Yeni kasa aç" kısayolu. Kasa paketlemeye gidince **Paketleme** bölümünde **kesin adet** girilir (düzeltilebilir; geçmişe önceki değerle yazılır).
- **Durumlar:** `açık → kapalı (paketleme bekliyor) → paketlendi`; `iptal` (nedenli; paketlenmiş kasa iptal edilemez; numara yeniden verilmez). Kasa yalnız **üretimdeki** iş emrinde açılır, iş emrinde aynı anda tek açık kasa. **İş emri bitince ya da iptal edilince açık kasa otomatik kapanır**
  (bitiş anına kadar sayılır). Sayılan adet (açma, kapama] aralığıdır: başlangıç dışlanır, bitiş dahil (ardışık kasalar aynı parçayı iki kez saymaz); şüpheli sayaç sıçramaları sayılmaz.
- **İş emri toplamları** (`crates.totals`): kasa sayısı, sayılan, paketlenen, paketleme bekleyen kasa, **kasaya atanmayan** adet (kasa açık değilken üretilen); `paketlenen − sayılan` farkı gizlenmez. İş emri ayrıntısında **"Kasalar"** paneli; Tezgah başı üstünde "paketleme bekleyen kasa: N".
- **Kart** (`dashboard/planning-card.js`): kâğıt kartın düzeni (EYS.FR.001, yayın 18.09.2024) — KART NO, TARİH/VARDİYA (kasanın açıldığı vardiya), MAKİNA NO (CNC-08 → 8), İŞ EMRİ NO, GKK RAPOR NO, ALEN/MÜŞTERİ ÜRÜN KODU, ÜRÜN TANIMI; süreç tablosunda CNC ÜRETİM satırında **SAYAÇ BŞL./BTŞ.** ve operatör,
  **MİKTAR boş**, PAKETLEME satırı paketlenen adet bilinince dolar (kart yeniden basılırsa); ret ve yeniden işlem blokları **boş** (el yazısı, sistem tutmaz). A5 dikey (`@page kart`), her temada beyaz zemin. Logo basılmaz.
  Numara `K` + 6 hane tek sıra (kâğıt defterin 6 haneli numaralarıyla karışmasın); `PUT /api/planning/crates/sequence` (yönetici) tabanı yükseltir.
- **Yetki:** kasa aç/kapat/paketleme adedi/iptal/okuma **operatör + yönetici** (`policy.js` `OPERATOR_PLANNING`'e eklendi; viewer'a kapalı); kart sırası tabanı yalnız yönetici. Operatör hesabı artık iki bölüm görür: **Tezgah başı** ve **Paketleme**.
- **Uçlar:** `GET /api/planning/crates?woNo=&machine=&state=aktif|acik|kapali|paketlendi|iptal|tumu` · `GET /crates/:id` · `POST /work-orders/:no/crates` (aç) · `POST /crates/:id/close|pack|void` · `PUT /crates/sequence`.
  Dosyalar: `planning-db.js` (`crates` tablosu), `planning.js` (`openCrate/closeCrate/packCrate/voidCrate/listCrates/setCrateSequence`), `routes.js`, `dashboard/planning-card.js` · `planning-packing.js` · `planning-shop.js`.
- **Doğrulama (K):** `crates.test.js` 8 test (sayaç/telemetri sayımı, sınır parçası, paketleme düzeltmesi, iptal, toplamlar, otomatik kapanma, numara sırası, HTTP) + `policy`/`e2e` (operatör kasa akışı, viewer 403, sıra tabanı yalnız yönetici);
  demo'da (gerçek kayıt oynatması, CNC-08): kasa aç → kart → kapat → yeni kasa → paketleme (+ düzeltme) → iş emri bitince otomatik kapanma. **Gerçek yazıcıda A5 baskı, kartın kâğıt kartla yan yana karşılaştırması ve gerçek kasalarla denenmedi.**
- **Sınırlar:** adet **kasa başına** girilir (paketleme birden çok kasayı birleştirebilir ya da bir kasa birden çok pakete bölünebilir: şimdilik izlenmez); sonraki istasyonlar (ek işlem, yıkama, yazı yazma, kurutma) kartta elle yazılır; kasa açma/kapama bir insan eylemi olduğu için sayılan adet yaklaşıktır.

**Tek adımlı kart akışı, iş emri alanları ve Ölçü Kontrolü (0.16.0, 2026-10-13, kullanıcı istekleri):**
- **Ürün tanıtım kartı artık TEK ADIM (yukarıdaki K aşamasının "Yeni kasa aç → kapat" akışının yerine geçer):** kasa dolunca usta o üretimin iş emrinden **"Ürün tanıtım kartı bas"** der (önizleme → "Kartı oluştur ve yazdır"), kartı kasaya atıp kasayı paketlemeye yollar.
  Her basış bir **kapalı kasa kaydı**dır (`planning.js` `issueCard`): önceki kartın basıldığı andan (ilk kartta iş emri başlangıcından) şimdiye tezgahın saydığı adet (tahmin) ve sayaç zinciri tutulur; kesin adet Paketleme'de girilir. Üretimdeki **ya da bitmiş** (son kasa bitişten sonra da dolabilir) iş emrinde basılır;
  eski akıştan kalma açık kasa varsa kapanıp kart olur. Uyarılar: hiç parça sayılmadı / az önce başka kart basıldı / tezgahtan veri yok. Kartta GKK rapor no boşsa basarken yazılabilir (iş emrine işlenir). Yanlış basılan kart iptal edilir (numara yeniden verilmez).
  **Kart tek tablo, 6 alan + 3 işlem satırı (0.17.1) + ÜRÜN RET tiki (0.17.3):** ALEN ÜRÜN KODU · MÜŞTERİ ÜRÜN KODU · TARİH · MAKİNA NO · İŞ EMRİ NO · GKK RAPOR NO · **YIKAMA / KURUTMA / TAVLAMA işaret kutuları** · **ÜRÜN RET kutusu** (+ küçük KART NO: paketleme kartı bununla bulur). Eski kâğıt kartın süreç tablosu (ek işlem, yazı yazma...) ve ret/yeniden işlem blokları kaldırıldı. A5 dikey. Tezgah başında kart bloğu: "N kart basıldı · son K0000XX", "Ürün tanıtım kartı bas", "Son kartı yeniden yazdır";
  iş emri bitince "Son biten iş emri" (24 saat) için de basılabilir. Uç: `POST /api/planning/work-orders/:no/cards {person?, gkkReportNo?}` (operatör + yönetici). Testi `cards.test.js`.
- **İş emri alan değişiklikleri:** (1) oluştururken **alternatif hammadde** girilebilir (ürün kartındakini ezer). (2) **Tezgah seçmeden iş emri oluşturulabilir**; başlatırken seçilir (`machine_id` sütunu NOT NULL olduğu için atanmamış = `''`, API'de `null`; başlatırken tezgah ZORUNLU: `400 no-machine`; tezgahsız bekleyen iş emri
  Tezgah başında hiçbir tezgahın sırasında görünmez, "Başka iş emri başlat…" ile seçilir). (3) **"Hammadde GK no" kaldırıldı** (GKK rapor no ile aynı şey; eski sütun veritabanında durur, kullanılmaz). (4) İş emri formunda **BRÜT GRAMAJ tek kutu** (maliyet ve üretim brüt gramajı aynı). (5) **İlk onay rapor no olmadan da başlatılabilir** (zaten isteğe bağlıydı; başlatma penceresi bunu yazar).
  (6) **Tezgah başında "İş emrini düzenle"**: ilk parça yapılıp ölçülünce **ilk onay rapor no, ölçülen net gramaj**, GKK rapor no, kullanılan hammadde ve açıklama operatörce girilir (`POST /api/planning/work-orders/:no/fields {fields}`; yalnız bu 5 alan, planlama alanları 403; geçmişe "güncellendi" yazılır; `OPERATOR_EDIT_FIELDS`). Testi `wo-fields.test.js`.
- **ÖLÇÜ KONTROLÜ (EYS.FR.005):** iş emrinde üretilen ürünlerin **saatlik ölçümleri**; ürün tanıtım kartına (kasaya) bağlı **föy** olarak basılır. Kâğıt formun düzeni: gündüz bloğu 07:30–19:00 + gece bloğu 19:30–07:00 (30 dk'lık 24+24 sütun), satırlar 1…10 (ölçülen özellik) ve
  Görsel Kontrol / Geçer Mastarlar / Geçmez Mastarlar. **Ölçü satırları** (ad, nominal, alt/üst sapma; ör. Ø34,2 −0,1/+0) iş emrinde bir kez tanımlanır ve **aynı ürünün sonraki iş emrine otomatik kopyalanır** (en son DÜZENLENEN plan; `measure_plan`, `measure_plan_at`). Tezgah başında "Ölçü kontrolü":
  sütun (varsayılan şimdi; 72 saate kadar geri) için değerleri yaz (34,13), üç kontrolü işaretle; **tolerans dışı** ▲/▼ ile işaretlenir ve uyarı çıkar ("makine durdurulur, bölüm sorumlusuna bilgi verilir": formun notu); aynı sütun yeniden kaydedilirse güncellenir, boş değer siler. **Kart bağlantısı:**
  ölçüm girişinin gerçek zamanı (`measured_at`) kartın aralığına (önceki kartın basıldığı an, bu kartın basıldığı an] düşerse o kartın föyündedir; kart basılmadan girilenler "kart bekliyor"dur; biten iş emrinin son kartı bitişten sonraki girişleri de alır. Föy: kartta/iş emrinde/Paketleme'de **"Ölçü föyü"**, A4 yatay baskı, ▲/▼ siyah-beyazda da okunur.
  Uçlar (operatör + yönetici): `GET /api/planning/work-orders/:no/measurements` · `PUT .../:no/measure-plan {rows}` · `POST .../:no/measurements {slot?, values, checks, person?}` · `GET /api/planning/crates/:id/sheet`. Dosyalar: `backend/planning/measure.js` (saf: sütun yuvarlama, formdaki konum, plan doğrulama, tolerans),
  `planning.js` (`setMeasurePlan/saveMeasurements/getMeasurements/measureSheet`), tablo `measurements` (`planlama.db`), `dashboard/planning-measure.js`. Testi `measure.test.js` 13 test. **Gerçek kâğıt formla yan yana karşılaştırılmadı; yazıcıdan A4 yatay baskı denenmedi.**
  Sınırlar: (0.17.0'da ürün kartında kalıcı ölçü planı eklendi, aşağıya bakın); kontrol sıklığı hatırlatması/uyarısı yok (yalnız "son ölçü" bilgisi); ölçüm silme ekranı yok (aynı sütunu boş değerle kaydederek silinir).

**D aşaması — hammadde ve sarfiyat (0.13.0, 2026-10-13):** Planlama › **Hammadde** (yalnız yönetici). Kullanıcı kararları: sarfiyat **kg** olarak (Mikro'ya kg yazılır), işlenen **tüm** parça (sayaç) × brüt gramaj; ret/hurda/fire izlenmez.
- **Hesap** (`backend/planning/material.js`, saf; testli): **kg = adet × brüt ağırlık** (adet = tezgahın işlediği TÜM parça: numune/ayar/bozuk dahil; iş emri bitince dondurulan sayaç adedi); **çubuk (BOY)** bilgi olarak `calc.js` formülüyle; **beklenen talaş = adet × (brüt − net)** (çıktıdır, sarfiyatı değiştirmez).
  Bilinmeyen girdi `null` (0 değil): brüt ağırlık yoksa kg `null`, toplama girmez ve ayrıca "ağırlıksız" diye sayılır; hiç üretilmediyse bilinen 0. **Sarfiyat TEORİKTİR** (sayaç hatalı parçayı ayıramaz; çubuk tartımı değil).
- **Hangi hammadde:** operatörün başlatırken yazdığı **gerçek hammadde** (`usedMaterial`), yoksa iş emrindeki planlı hammadde. Planlıdan farklıysa "planlıdan farklı" uyarısı, alternatif hammaddeyse "alternatif hammadde" bilgisi; kodlar büyük/küçük harf ve Türkçe harf duyarsız gruplanır.
- **İhtiyaç:** planlanan (hedef) + üretimdeki (**kalan** adet) iş emirleri, hammadde bazında kg ve çubuk (+ iş emri bazında liste; termin, alternatif hammadde). Depo bakiyesiyle karşılaştırma ve eksik uyarısı Mikro okuma (F) ile gelecek.
- **Sarfiyat ve fiş:** bitiş tarihi seçilen aralıkta (Bugün / Bu ay / Geçen ay / Son 30 gün / tarih seçimi; varsayılan bu ay) olan **biten** iş emirleri; hammadde bazında ve iş emri bazında kg, çubuk, talaş, fişi bekleyen kg; üretimdeki iş emirleri ayrı ("henüz fiş yok", bilgi).
  **Mikro sarfiyat fişi (API doğrulanana kadar ELLE):** sistem kesilecek fişi listeler, ofis Mikro'ya kendisi girer ve **"girildi" işaretler** (tek ya da toplu; evrak no, not; tek iş emrinde fişe yazılan fiili kg elle düzeltilebilir). Girilen iş emri **tekrar işaretlenemez** (çift fiş olmasın, 409) ama geri alınabilir (Mikro'daki fişi silmez, yalnız işareti kaldırır);
  brüt ağırlığı olmayan iş emrinde kg elle girilmeden fiş işaretlenmez. İşaretler iş emri geçmişine yazılır. **Excel CSV** (BOM, `sep=;`, ondalık virgül): iş emri bazlı ve hammadde bazlı (ay sonu fişi hazırlamak için).
- **İş emri ayrıntısında "Hammadde · sarfiyat" paneli** (`consumption` alanı; `material` alanı iş emrinin kendi hammadde metni olduğu için adı ayrı).
- **Uçlar (yalnız yönetici):** `GET /api/planning/material/need` · `GET /material/consumption?from=&to=&fis=bekleyen|girildi|tumu` · `GET /material/consumption.csv?...&view=is-emri|hammadde` · `POST /material/fis` (`orders[], docNo?, kg?, note?`) · `POST /material/fis/undo`.
  Dosyalar: `material.js`, `planning.js` (`materialNeed/materialConsumption/materialCsv/markFis/clearFis`), `routes.js`, `dashboard/planning-material.js`. `planlama.db` `work_orders` tablosuna `fis_*` sütunları eklendi (eski veritabanları açılışta genişler).
- **Doğrulama (D):** `material.test.js` 7 test (hesap, gruplama, ihtiyaç, aralık/dondurulmuş adet, fiş kuralları, CSV, HTTP) + policy/e2e (operatör ve viewer 403); demo'da (gerçek kayıt oynatması) bitmiş iş emri → sarfiyat → fiş işareti → ihtiyaç görünümü denendi.
  **Gerçek Mikro fişiyle karşılaştırılmadı** (brüt gramaj/çubuk formülü ürün kartı verisine güvenir; ürün kartında ağırlık eksikse sarfiyat hesaplanamaz). Sonraki: Mikro'ya yazma doğrulanınca (G) aynı kayıt otomatik gönderilir.
- **Sınırlar:** fiş iş emri bazında (ay sonu birleşik fiş için toplu işaretleme var; ay sınırını aşan iş emri bölünmez); sarfiyat çubuk tartımıyla doğrulanmaz; "satılan talaş" karşılaştırması yok (beklenen talaş bilgidir).

**E aşaması — verimlilik ve duruş raporları (0.14.0, 2026-10-13):** Planlama › **Verimlilik** (yalnız yönetici): bugünkü "Üretim Kartı Verileri" Excel'inin (verimlilik, duruş, aylık özet sayfaları) otomatik karşılığı.
- **Tanım (Excel'le aynı):** **verimlilik % = kazanılan süre ÷ ayrılan süre**; kazanılan = adet × planlanan çevrim (= gerçek adet ÷ (ayrılan süre ÷ planlanan sn)). **Ayrılan süre = iş emrinin penceresi ∩ vardiya** (Excel'de elle bölünen "ürün değişince 6 sa + 6 sa" otomatiktir;
  ayrı bir telemetri tablosu gerekmedi: başlat/bitir pencereleri). **Toplamlar süre ağırlıklıdır** (10 sa %96 + 2 sa %50 → %88,3). **Kullanılabilirlik (A)** = RUNNING süresi ÷ ölçülen süre (veri yok payda dışı); **Performans (P)** = planlanan ÷ ölçülen çevrim (kontrolcü çevrim sayacı); verimlilik ≈ A × P (yaklaşık, fark gizlenmez).
  Vardiyada iş emri atanmamış süre (vardiya − ayrılan) matriste ayrı verilir. **Kalite (fire) yok.**
- **Hesap** (`backend/planning/efficiency.js`, saf, testli): iş emri × vardiya parçaları (`orderSegments`), toplamlar (`summarize`), tezgah × gün × vardiya matrisi, ürün ve gün satırları. Adet olayları vardiya sınırında yarı açıktır [başlangıç, bitiş) (üretim raporuyla aynı),
  pencerenin bitişi dahil; iş emri başlangıcında aynı anda biten parça önceki işe aittir; şüpheli sayaç sıçramaları sayılmaz. Planlanan çevrimi olmayan iş emri verimliliğe katılmaz (uyarı + sayılır). Üretimdeki iş emri "şimdiye kadar", üretimdeyken iptal edilen iş emri iptale kadar dahil.
- **Görünümler:** **Özet** (KPI: verimlilik/A/P/adet/brüt-net/talaş; termin riski listesi; tezgah, ürün ve gün bazında) · **Matris** (tezgah × gün × vardiya; tek ton vurgu rengi, koyu = yüksek, **▼ %80 altı / ▲ %105 üstü** işaretli: renk tek başına anlam taşımaz; hücre üstünde adet ve süre) ·
  **Günlük kartlar** (tezgah × vardiya × ürün satırları: ayrılan süre, hedef, adet, verimlilik, A, P, brüt/net/talaş kg) · **Duruşlar** (neden kodu dakikaları, tezgah bazında ölçülen/nedeni girilen/belirsiz ve kapsama, kod × gün tablosu).
  **Excel CSV'leri** (BOM, `sep=;`, ondalık virgül; PivotTable için uzun biçim): `gunluk`, `matris`, `urun`, `tezgah`, `durus`, `durus-kod-gun` (Excel DURUŞ sayfasının kod × gün düzeni).
- **Öneri:** ürün bazında verimlilik %105'in üstündeyse (en az 1 sa ve 20 adet) "planlanan süre fazla temkinli olabilir": düğme ürün kartına ölçülen çevrimi yazar (onaylı; kendiliğinden değişmez, açık iş emirleri ve geçmiş raporlar etkilenmez).
- **Duruş raporu:** nedenler kod × tezgah × **üretim günü** (gece vardiyası başladığı güne yazılır; vardiya sınırında bölünür); ölçülmüş ama kodlanmamış duruş "nedeni belirsiz" (Tezgah başı › Duruşlar'dan girilir); kapsama = neden girilen ÷ ölçülen.
- **Uçlar (yalnız yönetici):** `GET /api/planning/efficiency[.csv]?from=&to=&machine=` · `GET /downtime-report[.csv]?from=&to=&machine=` (CSV'de `&view=`). Dosyalar: `efficiency.js`, `planning.js` (`efficiencyReport/downtimeReport/efficiencyCsv`), `routes.js`, `dashboard/planning-efficiency.js`.
- **Doğrulama (E):** `efficiency.test.js` 9 test (vardiya bölme, A/P/verimlilik, süre ağırlıklı toplam, atanmamış süre, ürün önerisi, tezgah × vardiya matrisi, süren/iptal iş emri, duruş dakikaları ve belirsiz, CSV, HTTP) + policy/e2e (operatör/viewer 403);
  tarayıcıda sentetik telemetri + gerçek kayıt oynatmasıyla (iş emri başlat/bitir, duruş nedeni) tüm görünümler denendi. **Gerçek bir ayın Excel sonuçlarıyla karşılaştırılmadı.**
- **Sınırlar:** planlı duruşlar (yemek, tatil) ayrılan süreden düşülmez; ayrılan süre iş emri penceresidir (operatör başlat/bitir'i geç basarsa süre sapar: başlangıç geriye alınabilir); haftalık/aylık ortalama sayfalarının biçimi Excel'le birebir değil (CSV uzun biçim); OEE'nin kalite ayağı yok.

**GKK rapor no, ilk onay raporu, teknik resim PDF'leri, ürüne göre değişen ölçü ve izleyici (viewer) erişimi (0.17.0, 2026-10-14, kullanıcı istekleri; kaynak formlar EYS.FR.011 ve EYS.FR.013):**
- **Planlama'da izleyici (viewer) rolü — YALNIZ OKUMA.** Giriş sonrası seçim ekranında Telemetri + Planlama görünür. Planlama sekmeleri rol tablosu `dashboard/planning-tabs.js` `TAB_ROLES` (menü ve açılış sekmesi yalnız kolaylık; yetkiyi sunucu verir, testi `backend/apps.test.js`):
  **yönetici** hepsi · **operatör** Tezgah başı, Paketleme, **İş emirleri (yalnız okur: liste + form)**, GKK rapor no, İlk onay raporu, Ölçü raporları, **Program eşleme (okur + eşler, 0.17.2)** · **izleyici** Tezgah başı, İş emirleri, GKK rapor no, İlk onay raporu, Ölçü raporları (hiçbir yazma düğmesi görmez: başlat/bitir/düzenle/numara al/ölçü girişi/kart bas yok;
  Tezgah başında "Ölçü raporu" ve "Son kartı göster" vardır, duruşlar salt okunurdur). Sunucuda `policy.js` `VIEWER_PLANNING` (yalnız `GET`, tek yerde, açık liste): `summary`, `downtime-codes`, `gkk`, `first-approvals`, `measure-reports`, `crates[/:id[/sheet]]`, `shop/overview|stops`,
  `work-orders` (liste, ayrıntı), `work-orders/:no/(measurements|measure-report|drawings.pdf|print.pdf)`. **Ürün kartı, sipariş, verimlilik, hammadde, içeri aktarma, program eşleme ve HER yazma yönetici/operatöre özel kalır** (demo'da izleyici oturumuyla 17 uç denendi: 5 okuma 200, geri kalanı 403).
  **Bilinen taviz:** iş emri ayrıntısı müşteri adını/sipariş özetini taşır; Tailscale ile giren dış izleyiciler de görür. Gizli olması gerekiyorsa viewer'a giden iş emri ayrıntısından müşteri alanları çıkarılmalı (yapılmadı).
- **GKK rapor numaraları (EYS.FR.011, sekme "GKK rapor no"):** ustalar iş emrine yazılacak numarayı bu listeden bulur. Kayıt = hammadde cinsi (kâğıttaki "ÜRÜN", ör. `AA24 X 13 - PB3`) + rapor no (`GK26.291`) + üretici rapor tarihi + açıklama (`backend/planning/gkk.js`, `quality-db.js`).
  **Aynı rapor no birden çok hammaddeye yazılabilir** (UNIQUE: rapor no + hammadde). Sıradaki numara `GK{yy}.{sıra 3 hane}`: yıldaki en büyük sıra ile numara tabanının büyüğü + 1 (`PUT /api/planning/gkk/sequence` tabanı yükseltir; küçültülemez). **Kâğıtta önceden basılmış BOŞ numaralar kayıt sayılmaz** (içeri alma "N önceden basılmış boş numara atlandı" der).
  **İş emri hammaddesi ↔ kayıt eşleme** (`gkk.js`; öneri, kendiliğinden yazmaz): Mikro hammadde kodundaki şekil/ölçü/alaşım kayıttakine çevrilir (`YU`→`YUV`, `AA`, `SK`→`8 KÖŞE`; alaşım `614`→`PB3`, `617`→`PB2`, `602`→`602N`, `603`→`CW603N`, `3604`→`C3604BD`);
  ek sözcük (`HB`, `ISIL İŞLEMLİ`) varsa **"aynı ölçü, işlem farklı" (▲)** uyarısıyla önerilir ("tam eşleşme" ✓ değil); dövme ürünler stok koduyla (`◆ dövme ürün`). "Listeden seç…" iş emrini düzenle, başlat ve Tezgah başı "İş emrini düzenle" pencerelerinde (`openGkkPicker`); altta tüm kayıtlarda arama.
  Yazma (yeni numara al/düzelt/sil/numara tabanı/CSV içeri al) **yalnız yönetici**; okuma herkes. Uçlar: `GET/POST /api/planning/gkk` · `PUT /gkk/sequence` · `PUT|DELETE /gkk/:id`. Liste "Listeyi yazdır" ile A4 dikey kâğıt formun düzeninde basılır.
- **İlk onay raporu (EYS.FR.013, sekme "İlk onay raporu"):** ilk parça üretilip ölçülünce numara alınır: `İ{yy}-{sıra, en az 3 hane}` (`İ26-1281`). Kayıt: kod, ürün kodu, GK kodu (iş emrindeki GKK rapor no), iş emri no, tarih, operatör, CNC no (`first-approval.js`).
  **Numara alma operatör + yönetici** (Tezgah başında "İlk onay numarası al", iş emrini düzenle penceresinde "Numara al…", sekmede "İş emrinden numara al…"): sunucu numarayı iş emrinin "ilk onay rapor no" alanına da yazar; o iş emri için daha önce numara verilmişse uyarır ve yalnız `again` ile yeni numara verir
  (ör. takım/ayar değişimi sonrası yeniden onay). Düzeltme/silme/elle kayıt/numara tabanı **yönetici**. Sıradaki numara = en büyük sıra ile taban; içeri alma tabanı `max(doluların en büyüğü, ilk boş basılı kod − 1)` yapar (kâğıtta önceden basılmış boş kodlar kayıt değildir).
  Uçlar: `GET/POST /api/planning/first-approvals` · `PUT /first-approvals/sequence` · `PUT|DELETE /first-approvals/:id`. Liste yazdırılabilir (A4 dikey).
- **Excel/CSV içeri alma:** iki kâğıt form da "CSV içeri al…" ile yüklenir; `importers.js` `detectForm` başlıklardan tanır (başlık satırı unvanın birkaç satır altında olabilir; normal başlık tanımadan ÖNCE çalışır). Biçimler `import_batches`'e `gkk` / `ilkonay` yazılır; sonuç penceresi sıradaki numarayı gösterir. Tekrar yükleme güvenli (aynı rapor no + hammadde güncellenir).
- **İş emri formu + teknik resimler TEK PDF'te (iş emri formunun arka sayfası):** yönetici "İş emrini düzenle" penceresinde PDF yükler (en çok 8 dosya × 20 MB; şifreli PDF reddedilir). **Satıra basınca (ya da "Formu aç") açılan pencere tek bir PDF gösterir: ön sayfa = iş emri formu, arka sayfalar = teknik resimler** (`planning-wo-form.js`, `<iframe>`; sunucu `application/pdf` + `X-Frame-Options: SAMEORIGIN`).
  **Form artık sunucuda PDF olarak üretilir** (`backend/planning/wo-form-pdf.js`: kâğıt formun düzeni, A4, bağımlılıksız; standart Helvetica, Ğ ğ Ş ş İ ı için kodlamaya Differences eklenir = iText "Cp1254" yöntemi; el ile yazılanlar boş, vardiya adetleri telemetriden dolar) ve `Planning.workOrderPrintPdf` resimlerle birleştirir.
  **Neden:** tarayıcı sayfaya gömülü PDF'i `window.print()` ile basmıyordu (eski HTML formda "Yazdır" yalnız ön sayfayı basıyordu, resimler ayrıydı); tek dosya olunca form + resimler **tek yazdırma işinde** çıkar (çift taraflı baskı uygun) ve görünen = basılan. **"Yazdır" düğmesi** PDF görüntüleyicisinin kendi yazdırmasını çağırır (`iframe.contentWindow.print()`; izin vermezse PDF yeni sekmede açılır), "Yeni sekmede aç" ve görüntüleyicinin kendi yazıcı simgesi de vardır.
  Birleştirme bağımlılıksız yazıldı (`backend/pdf-merge.js`: xref tablosu/akışı, nesne akışları, yüklem (predictor) sıkıştırması, bozuk dosyada yeniden kurma; **ekler sırayla art arda eklenir, tek sayfaya dizilmez**; `/Annots` (bağlantı/açıklama) atılır). Depolama içerik adresli (`drawing_files` SHA-256 BLOB, `wo_drawings` bağlantı; aynı dosya tek kez saklanır).
  **Aynı ürünün sonraki iş emri çizimleri otomatik devralır.** İş emri geçmişine "teknik resim eklendi/kaldırıldı" yazılır.
  Uçlar: `GET /api/planning/work-orders/:no/print.pdf` (**form + resimler**, izleyici/operatör dahil herkes) · `GET .../drawings.pdf` (yalnız resimler) · `POST /work-orders/:no/drawings?name=` (gövde = ham PDF, yönetici) · `DELETE /work-orders/:no/drawings/:id` (yönetici). Testleri `backend/pdf-merge.test.js` (13), `backend/planning/wo-form-pdf.test.js` (7).
- **Ölçü satırları ürüne göre değişir ve kalıcıdır:** her ürünün ölçü SAYISI farklıdır (biri 3, biri 5; 0–10). Plan **ürün kartında kalıcı** durur (`products.measure_plan`, "Ürün kartları › Ölçü satırlarını tanımla / düzenle…", `PUT /api/planning/products/:kod/measure-plan`, yönetici);
  yeni iş emri **ürün planı ile aynı ürünün son iş emri planından hangisi daha yeni DÜZENLENDIYSE onu** kopyalar. İş emrinde "Ölçü satırlarını tanımla…" (yönetici/operatör) iş emrine kaydeder; yönetici "Ürün kartına da kaydet" ile kalıcı yapar (`PUT .../measure-plan {rows, saveToProduct}`, `saveToProduct` yalnız yönetici).
  **Ölçü föyü yalnız tanımlı satırları basar** (3 ölçü → 3 satır; hiç tanımlı değilse kâğıttaki gibi 10 boş satır).
- **Ölçü raporları (sekme "Ölçü raporları", herkes görür):** ölçümü olan iş emirleri (ölçü sayısı, sütun sayısı, tolerans dışı sütun, karta bağlanmamış "kart bekleyen" sütun), **"Tüm ölçümler"** iş emrinin tüm saatlik ölçümlerini tek raporda açar (A4 yatay, kalite kontrole ve paketlemeye giden rapor; üstte hangi kartta kaç sütun olduğu),
  her ürün tanıtım kartı kendi föyünü açar. Ölçümler `measurements` tablosunda kalıcıdır (iş emrine bağlı). Uçlar: `GET /api/planning/measure-reports?q=` · `GET /work-orders/:no/measure-report` · `GET /crates/:id/sheet`.
- **İş emirleri ekranı:** satıra basınca FORM açılır, "Form" düğmesinin yerine **"Düzenle"** vardır (form penceresinde de "Düzenle…" var); izleyicide ve operatörde yeni/başlat/bitir/düzenle yok (yalnız liste + form).
- **Tezgah başında "İş emri formu" düğmesi** (üretimdeki iş emri kartında, bekleyen iş emirlerinde "Form", son biten iş emrinde): herkes (izleyici, operatör, yönetici) formu + resimleri açar ve basar.
- **Dosyalar:** `backend/pdf-merge.js`, `backend/planning/wo-form-pdf.js` (iş emri formu PDF'i), `backend/planning/{errors,gkk,first-approval,quality-db,quality}.js` (`Quality`: GKK + ilk onay + resim; `Planning.quality`) ; `dashboard/planning-{gkk,approvals,drawings,reports,tabs}.js`; `planning-common.js` (rol yardımcıları `planningRole/isViewer/isAdminRole`, `printModal`, `openListPrint`). Yeni dashboard dosyaları `server.js` `STATIC_FILES`'ta.
  Veritabanı: `planlama.db` yeni tablolar `gkk_reports`, `first_approvals`, `counters`, `drawing_files`, `wo_drawings` ve `products.measure_plan(_at)` (eski veritabanları açılışta genişler). **Yedeklenmesi gerekenler artık bu tabloları da içerir (`planlama.db`).**
- **Doğrulama:** `npm test` 377 test (yeni: `gkk.test.js` 8, `quality.test.js` 11, `pdf-merge.test.js` 13, `wo-form-pdf.test.js` 7; `policy`/`e2e`/`apps` testleri izleyici ve operatör sınırlarıyla güncellendi). Girişli demo'da (yönetici/izleyici/operatör hesapları; kullanıcının iki Excel formu + sentetik resim PDF'leri) tarayıcıda denendi: form + arka sayfa birleşik PDF, GKK seçimi
  (`HM614.AA24.00XYU13.00` → `AA24 X 13 - PB3` tam eşleşme) ve kaydı, ilk onay numarası alma (operatör), ürün ve iş emri ölçü planı (3/4/5 ölçü), ölçü raporu (tolerans dışı işareti), liste yazdırma önizlemesi, izleyici/operatör düğme ve uç sınırları.
  **DENENMEDİ:** gerçek yazıcıdan baskı (A4 dikey GKK/ilk onay listesi ve **form + resimler tek iş**, A4 yatay ölçü raporu/föy); form PDF'inin düzeni elle çizilmiş bir PDF'tir (Chrome PDF görüntüleyicisinde açıldığı ve metin çıkarımı Türkçe karakterleri doğru verdiği sınandı, kâğıt formla yan yana karşılaştırılmadı); fabrikanın gerçek (CAD çıktısı) teknik resim PDF'leri (birleştirici sentetik ve yapı çeşitleriyle sınandı: şifreli/bozuk dosya reddi var); gerçek kurulumda ve gerçek izleyici/Tailscale oturumuyla; GKK eşleme kuralları yalnız verilen kayıt listesiyle (başka alaşım/şekil çıkarsa eşleşmez, elle aranır).
- **Sınırlar:** GKK kaydı ile fiili hammadde lotu otomatik eşlenmez (öneri; usta seçer); ilk onay numarası bir insan eylemidir (ölçüm sonucuna bağlı değil); resimler sıralı eklenir (sayfa düzeni/küçültme yok); kontrol sıklığı hatırlatması yok.

**Kartta yıkama / kurutma / tavlama işaretleri (0.17.1, 2026-10-14, kullanıcı isteği):** ürün tanıtım kartında üç işlem satırı vardır; her satırın iki kutusu: **YIKAMA** (☐ Yıkamaya gidecek · ☐ Yıkandı), **KURUTMA** (☐ Kurutmaya gidecek · ☐ Kurutuldu), **TAVLAMA** (☐ Tavlamaya gidecek · ☐ Tavlandı).
- **Kartı basarken usta tikler:** "Ürün tanıtım kartı bas" penceresinde ("Kartta işaretlenecek işlemler", büyük dokunmatik kutular) tikler, aşağıdaki kart önizlemesi anında güncellenir, "Kartı oluştur ve yazdır" ile kasa kaydına yazılır ve kartta basılır (işaretli kutuda ✓, boş kutu çerçeveli: siyah-beyaz baskıda da ayırt edilir).
  Kutular bağımsızdır (biri diğerini zorlamaz); aynı işlem için ikisi birden işaretliyse pencere yalnız uyarır ("doğru mu?"), engellemez. **Varsayılan her kartta işaretsiz** (önceki karttan devralınmaz: yanlış "yıkandı" basılmasın); işaret verilmezse hiçbiri işaretli değil.
- **Saklama:** `crates` tablosunda 6 sütun (`wash_to/wash_done/dry_to/dry_done/anneal_to/anneal_done`, 0/1; eski veritabanları açılışta genişler, eski kartlar işaretsiz). API: `POST /api/planning/work-orders/:no/cards {steps: {washTo, washDone, dryTo, dryDone, annealTo, annealDone}}` (boolean; bilinmeyen anahtar / boolean olmayan değer 400 ve kart numarası HARCANMAZ);
  yanıtta ve `GET /api/planning/crates[/:id]` çıktısında `steps`. İşaretler kartın yeniden basımında aynen çıkar; iş emri geçmişindeki "kart basıldı" kaydına da yazılır. **Kartı bastıktan sonra işaret değiştirilemez** (kâğıt basıldı): yanlışsa kart iptal edilip yenisi basılır.
- **Görünürlük:** iş emri ayrıntısındaki "Ürün tanıtım kartları" tablosunda ve Paketleme listesinde "İşlem" sütunu (ör. "Yıkamaya gidecek · Kurutuldu"): paketleme hangi kasanın nereye gideceğini görür.
- **Dosyalar:** `backend/planning/card-steps.js` (tanım, doğrulama, metin; **tek tanım**), `dashboard/planning-card.js` (aynı liste; `card-steps.test.js` eşitliği sınar), `planning-db.js` (sütunlar + geçiş), `planning.js` `issueCard`. Testi `backend/planning/card-steps.test.js` (7).
- **Sınırlar / DENENMEDİ:** gerçek yazıcıdan A5 baskı ve kutuların kâğıt kartla yan yana karşılaştırması yapılmadı (yalnız ekranda önizleme); "yapıldı" kutusu için kasa sonradan hangi aşamada olduğu izlenmez (işaret kart basılırkenki durumdur); işlem yerine gönderme/dönüş zamanı ya da firma bilgisi tutulmaz.

**Fabrika (operatör) hesabında Program eşleme (0.17.2, 2026-10-14, kullanıcı isteği):** operatör "Program eşleme" sekmesini görür ve **kullanır**: tornalarda parça üretmiş programları görür, önerileri onaylar, ürünü kendisi seçer, eşlemeyi kaldırır ve "stok koduyla birebir tutan önerileri onayla" der (ustalar hangi programın hangi ürünü ürettiğini bilir).
- **Sunucuda** (`policy.js` `OPERATOR_PLANNING`, tek yerde): `GET /api/planning/programs`, `PUT|DELETE /programs/map`, `POST /programs/confirm-exact` ve yeni **dar ürün araması** `GET /api/planning/programs/product-search?q=&limit=` (yanıt yalnız `{stockCode, name, customerCode}`: ürün kartı, ağırlık, hammadde YOK). Operatör **ürün kartı listesine (`GET /products`) ve siparişlere hâlâ erişemez**; izleyici (viewer) program eşlemeyi hiç görmez.
  Ürün seçme penceresi (`planning-programs.js`) yönetici için de bu dar aramayı kullanır. Eşleme adedi belirlemez (yalnız iş emri ve raporlarda doğru ürünü gösterir, program çapraz denetimi); yanlış eşleme "Kaldır" ile geri alınır.
- **Sınırlar:** operatör eşlemeyi kimin yaptığını ayırt ettirmez (ortak hesap; kayıtta hesap adı `fabrika` görünür); ürün kartı yoksa operatör kart açamaz, yöneticiye bildirir.

**Kartta "ÜRÜN RET" tiki — ret edilen kasa paketlemeye gitmez (0.17.3, 2026-10-14, kullanıcı isteği):** kartta tek bir kutu: **ÜRÜN RET** ("Ürün ret edildi (paketlemeye gitmez)"). Ürün ret edildiyse kasa paketlemeye gitmez; duruma göre tekrar işleme ayrılır ya da hurdaya gider (bu karar ve takip sistemde YOK, kâğıtta/fabrikada).
  (Önce kartın altına el yazısı ret / yeniden işlem blokları eklenmişti; kullanıcı "yalnız ret tiki olsun" dedi, bloklar kaldırıldı.)
- **Kartı basarken usta tikler** ("Kartta işaretlenecekler" bölümünde yıkama/kurutma/tavlama kutularının altında); tiklenince pencere "bu kasa paketlemeye gitmeyecek" diye uyarır, kartta kutu ✓ olur ve satır belirginleşir (siyah-beyazda da okunur). Varsayılan ret DEĞİL.
- **Sistemde:** `crates.reject` (0/1; eski veritabanları açılışta genişler, eski kartlar ret değil). Kasa durumu **`ret`** olur (`açık → kapalı (paketleme bekliyor) → paketlendi`; `iptal`; yeni `ret`): ret kasa **Paketleme "bekleyenler" listesine düşmez**, tezgah başındaki "paketleme bekleyen kasa" sayısına girmez, `packCrate` 409 `rejected` ile reddeder,
  Paketleme ekranında ayrı **"Ret edilenler"** süzgeci ve "RET · paketlemeye gitmez" yazısı vardır; iş emri ayrıntısındaki kartlar tablosunda durum rozeti "ret: paketlemeye gitmez", özet satırında "N kasa RET" (`totals.rejected`, `rejectedCounted`). Yanlış tiklenen ret kart **iptal edilir** (paketlenmediği için) ve yenisi basılır.
  API: `POST /api/planning/work-orders/:no/cards {reject: true}` (boolean; başka tür 400 ve kart numarası harcanmaz); `GET /api/planning/crates?state=ret|kapali` (`kapali` artık ret olanları HARİÇ tutar). İş emri geçmişine "ÜRÜN RET (paketlemeye gitmez)" yazılır.
- **Dosyalar:** `backend/planning/card-steps.js` `parseReject`, `planning-db.js` (sütun, durum, süzgeç), `planning.js` (`issueCard`, `packCrate`, toplamlar), `dashboard/planning-card.js` (`rejectRow`, kutu, rozet), `planning-packing.js` (süzgeç). Testi `card-steps.test.js` (9).
- **Sınırlar / DENENMEDİ:** ret kararı kart BASILIRKEN verilir; kart basıldıktan sonra kasa ret çıkarsa (kalite kontrolde) bu işaretlenemez: kart iptal edilip yenisi basılır (ya da ileride "ret olarak işaretle" düğmesi eklenir; yapılmadı); ret kasanın tekrar işleme/hurda kararı, adam-saat, sağlam/hurda miktarı sistemde izlenmez (ret/hurda sistemde tutulmaz kararı); gerçek yazıcıdan A5 baskı denenmedi.

**Kurulumda kapalı bölümler — Paketleme ve Hammadde (0.18.0, 2026-10-15, kullanıcı kararı):** bu iki bölüm rafine edilene kadar kurulumlarda KAPALI; **hiç kimse (yönetici ve fabrika operatörü dahil) görmez**.
- **Mekanizma:** `config/features.json` → `{"closedSections": [...]}` (`shared/features.js`: `paketleme`, `hammadde` kapatılabilir; bilinmeyen bölüm ya da yanlış yazılmış anahtar sunucuyu BAŞLATMAZ: sessizce açık kalan bir "kapalı" bölüm en kötü hata). Ortam değişkeni `FEATURES_FILE` dosyayı değiştirir (test/demo).
  Sunucu açılışta `[backend] KAPALI bölümler ...` yazar. Oturum (`GET /api/session`, yalnız giriş yapmışa) `closedSections` verir; arayüz menüyü, açılış sekmesini ve yetkisiz adres korumasını (`#/planlama/paketleme` → kendi açılış sekmesi) bundan kurar (`auth-view.js` `closedSections`, `planning-tabs.js` `tabsForRole(role, closed)`, `planning-common.js` `sectionClosed`).
- **Sunucu zorlar** (`planning/routes.js` `sectionOf`, kimlik/rol fark etmez, yönetici bile): `/api/planning/material/*` (ihtiyaç, sarfiyat, CSV, Mikro fişi + geri alma) ve `POST /api/planning/crates/:id/pack` (kesin paketleme adedi) → **403 `{code: 'section-closed', section}`**.
- **Paketleme kapalıyken ÇALIŞANLAR:** ürün tanıtım kartı basma, kartı yeniden yazdırma (Tezgah başı "Son kartı yeniden yazdır", iş emri ayrıntısında "Kart"), ölçü föyü, ÜRÜN RET, kasa listesi (`GET /crates`), iptal. Yalnız Paketleme sekmesi ve kesin adet girişi kapanır.
  Kimse kesin adet giremeyeceği için şu bilgiler gösterilmez: iş emri ayrıntısındaki kart tablosunda "Paketlenen" ve "Fark" sütunları, "N kasa paketleme bekliyor", durum rozeti "paketleme bekliyor" yerine "✓ kart basıldı"; Tezgah başı bilgi satırındaki "paketleme bekleyen kasa" sayacı. (Kartın gerçek hayattaki "kasayı paketlemeye gönderin" notu kalır: fiziksel iş akışı.)
- **Hammadde kapalıyken:** Hammadde sekmesi ve uçları kapanır; iş emri ayrıntısındaki **"Hammadde · sarfiyat" bilgi paneli KALIR** (hammadde, adet, sarfiyat kg, çubuk, beklenen talaş: kullanıcı "bilgi olarak iyi" dedi) ama **"Mikro sarfiyat fişi" kutusu gösterilmez** (fiş işaretlenemeyeceği için "bekliyor" hep orada kalırdı).
- **Dosyalar / testler:** `shared/features.js`, `config/features.json`, `backend/planning/routes.js`, `backend/auth/http.js` (`sessionExtra`), `backend/server.js`; `backend/features.test.js` (8 test: dosya doğrulama, sekmeler, uçlar, **gerçek sunucu sürecinde** oturum + 403 + kart/ret/föy akışının açık kalması, hatalı dosyada başlamama). Demo/tarayıcıda yönetici ve operatör hesabıyla denendi (menü, kapalı adreslerin yönlendirilmesi, kart tablosu).
- **Denenmedi:** Setup.exe ile gerçek kurulum (paket derlenmedi); gerçek fabrika PC'sinde. **Yeniden açma:** yalnız yeni kurulum (`-KapaliBolumler @()` ya da yalnız biri) ya da kurulu PC'de dosyayı elle düzenleyip sunucuyu yeniden başlatmak.

**Telemetri ekranlarından mil devri ve Ölçümler grafikleri kaldırıldı (0.19.0, 2026-10-15, kullanıcı isteği):** Tezgah detayında (1) **"Ölçümler" bölümü** (Mil devri / İlerleme / Parça sayacı grafikleri ve "Tablo" görünümü), (2) üstteki **"İş mili ve ilerleme" kartı** (mil devri, ilerleme, mil/ilerleme override) ve ana ekrandaki her tezgah kartındaki **"Mil devri"** satırı kalktı
(kart: İlerleme · Parça · Çalışma oranı). **"CSV indir" / "Ham CSV" düğmeleri "Durum şeridi" bölümünün başlığına, zaman aralığı düğmelerinin (30 dk … 7 gün) yanına taşındı** (indirilen dosya seçili aralığı kapsar; uçlar ve CSV içeriği DEĞİŞMEDİ: mil devri CSV'de durur). Kontrolcüden gelen değerler yine toplanır ve saklanır
(`samples`, ham CSV, "Kontrolcüden gelen ham değerler"); yalnız ekranda gösterilmez. Geçmiş isteği artık yalnız durum şeridi için `maxPoints=50` ile yapılır. Kodu `dashboard/app.js` (`detailShell`, `drawHistory`), `dashboard/format.js` (`FIELD_GROUPS`). `charts.js` `lineChart` kullanılmıyor (ileride grafik istenirse durur).

**Tablet dağıtımı — ev ekranı uygulaması (PWA) (2026-10-26, kullanıcı isteği):** ustalar tableti tarayıcıdan URL yazarak değil, **ev ekranındaki bir simgeden** açsın diye (`dashboard/manifest.json`): adres çubuğu olmadan tam ekran açılır (`display: standalone`). `dashboard/index.html`'e `<link rel="manifest">`, `theme-color` (`#6C53E8`), `apple-touch-icon` meta'ları eklendi. İkonlar (`icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`) favicon'daki aynı işaretten (halka + nokta + yeşil çizgi) **bağımlılıksız** üretildi (node:zlib ile elle PNG kodlama, üretim betiği depoya girmedi); `backend/server.js` `STATIC_FILES`'a eklendi. `start_url: "/"`: rol bazlı yönlendirme zaten kendiliğinden doğru ekrana (operatör → Tezgah başı) düşürüyor, manifest'e ayrıca bir rota gömülmedi. **Servis çalışanı (service worker) BİLEREK yok**: bu canlı telemetri uygulaması, önbelleklenmiş/bayat veri göstermek burada "çevrimdışı çalışma"dan daha tehlikeli. Tabletler yalnız **istemci**: aynı yerel ağda `http://<ofis-pc-ip>:3000` açıp "Ana ekrana ekle" yeterli, ayrıca kurulum/ajan gerekmez. **Önerilen tarif:** ortak operatör hesabıyla bir kez giriş (oturum zaten 30 gün boşta/90 gün mutlak), üstüne ücretsiz bir kiosk tarayıcı (ör. Fully Kiosk Browser) ile tableti tek bu sayfaya kilitlemek. **Denenmedi:** gerçek bir tablette (büyük dokunmatik giriş kutuları PC tarayıcısında test edildi, tablette henüz değil).

### Kimlik doğrulama (0.5.0, 2026-10-12): admin ve viewer

Dashboard ve API giriş ister (`backend/auth/`, ayrı veritabanı `data/auth.db`, bağımlılık yok). Üç rol (üçüncüsü `operator`, 0.11.0: fabrika PC'sinin ortak hesabı, bkz. yukarıdaki "T aşaması"):
- **admin** — her şey (program kütüphanesi, editör, gönderme, klasör açma, Ayarlar, kullanıcılar).
- **viewer** — YALNIZ izleme: filo, tezgah detayı, raporlar/CSV. Program kütüphanesi, Ayarlar ve tezgah detayındaki
  "Programlar" paneli arayüzden gizlenir **ve sunucu bu uçları 403 ile reddeder**. Viewer'a giden veriden tezgah
  IP/port gibi iç ağ bilgisi çıkarılır (`redactMachine`). **Planlama'da (0.17.0) yalnız OKUR:** Tezgah başı, İş emirleri (form + teknik resimler), GKK rapor no, İlk onay raporu, Ölçü raporları.
- **operator** — YALNIZ Planlama > Tezgah başı, Paketleme, İş emirleri (yalnız okur), GKK rapor no (okur), İlk onay raporu (numara alır), Ölçü raporları (okur), Program eşleme (okur + eşler): iş emri başlat/bitir (sınırlı alanlarla), duruş nedeni, kasa aç/kapat ve paketleme adedi, ölçü girişi, ilk onay numarası; izleme verisini okur (IP/port görmez).
Uzaktan (şirket dışından, Tailscale ile) girenler de aynı rol modeliyle girer; ağ kaynağına göre ayrı kısıt YOK.

- **İzin tablosu tek yerde:** `backend/auth/policy.js` `classify()`; kural **varsayılan reddet** — listede olmayan her
  `/api` yolu admin'dir. viewer'a açık olanlar: `GET /api/stream`, `/api/machines`, `/api/machines/:id[/history|spans|summary|downtimes|export.csv]`, `GET /api/production[/export.csv]` ve `/api/production/runs[.csv]` (vardiya adetleri, program geçişleri),
  `GET` planlama okumaları için `VIEWER_PLANNING` (bkz. 0.17.0), `POST /api/auth/logout|password`. `public`: statik dosyalar, `/api/session`, `/api/auth/login|setup`, `/api/health` (anonim yalnız `{ok:true}`).
  `local` (yalnız sunucu bilgisayarı): `POST /api/ingest`, `GET /api/agent/machines` — **ajan ve backend aynı bilgisayarda olmalı**
  (çok bilgisayarlı ajan için ajan anahtarı henüz YOK). "Yerel" = bağlantı loopback'ten + `Host` localhost + vekil/tünel başlığı yok
  (`X-Forwarded-For`, `CF-Connecting-IP`…; cloudflared gibi yerel vekil dış isteği yerel gösterir).
- **İlk kurulum:** hesap yokken dashboard "yönetici hesabını oluştur" ekranı gösterir; `POST /api/auth/setup` yalnız
  `localhost` üzerinden (başka bilgisayardan 403). Sonra Ayarlar > Kullanıcılar'dan viewer hesapları açılır.
- **Oturum:** çerez `cnc_sid` (HttpOnly, SameSite=Strict, HTTPS arkasında Secure); veritabanında yalnız SHA-256 özeti.
  Boşta kalma: admin 12 saat, viewer 30 gün (mutlak sınır 7 / 90 gün). Şifre scrypt. Başarısız giriş: (adres, kullanıcı) başına
  15 dk'da 5, adres başına 20 deneme → 429 + `Retry-After`. Şifre değişince/hesap silinince o kullanıcının oturumları kapanır;
  açık SSE akışları da 30 sn'de bir denetlenip kesilir. Durum değiştiren isteklerde `Origin`/`Sec-Fetch-Site` denetimi (CSRF).
  Tüm yanıtlarda `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`.
- **Denetim:** işlemi yapan kişi (`transfers.requested_by`, sürüm `created_by`) artık oturumdaki kullanıcı adıdır, istemcinin
  yazdığı "adınız" alanına güvenilmez. Giriş/çıkış/hesap olayları `audit` tablosunda (Ayarlar > Kullanıcılar'da son 15).
- **Kurtarma:** `runtime\node.exe backend\auth-cli.js listele|sifre <kullanici>|ekle <kullanici> <admin|viewer|operator>|sil <kullanici>`
  (sunucu bilgisayarında; boru ile şifre okur, terminalde gizli sorar). Son yönetici silinemez.
- **`AUTH_DISABLED=1`** her şeyi açık bırakır (herkes admin). YALNIZ geliştirme/demo: `scripts/dev.js`, `demo.js`, `demo-programlar.js`
  bunu kendisi verir; gerçek kurulumda ASLA. Başlangıçta konsola uyarı yazar, arayüzde "giriş kapalı" işareti çıkar.
- **Bilinen sınırlar:** HTTP üzerinde (ofis ağında) şifre düz metin gider (Tailscale tüneli şifreli); HTTPS için `tailscale serve` ya da vekil
  gerekir. İki adımlı doğrulama (TOTP) yok. Rol değiştirme yok (sil + yeniden aç). `auth-cli`'nin terminal (TTY) kipi elle denenmedi,
  boru kipi testli.

**Gerçek tornada henüz DOĞRULANMAYANLAR (ilk kullanımda küçük bir testle bakılmalı):**
`RNTO`'nun hedefte aynı ad varken davranışı (sahte sunucu reddeder; CE ezebilir → bu yüzden
gönderme öncesi ve adlandırmadan hemen önce `LIST` ile ikinci çakışma denetimi var, yine de
milisaniyelik yarış penceresi kalır) · `DELE` (silme) · **`MKD`** (başarı yanıt kodu 257 mi 250 mi,
ad/uzunluk kısıtı, panelde hemen görünüyor mu; kod yalnız sahte sunucuda sınandı) · bu özelliğin **arayüzü** hiç
gerçek torna ile uçtan uca denenmedi (yalnızca FTP komut dizisi torna 8'de elle doğrulandı) ·
çok büyük klasörlerde (>200) tarama süresi.

---

## 7. Kod kuralları

- **Sıfır dış bağımlılık.** Backend yalnızca Node gömülü modülleri (`node:sqlite`
  dahil), dashboard build'siz vanilla JS. `npm install` gerektirmez. Bunu bozma.
- **Türkçe:** kullanıcıya görünen her metin ve yorumlar Türkçe. Kod tanımlayıcıları
  İngilizce.
- **Okunamayan alan `null`, asla `0`.** `0` gerçek bir ölçümdür. Dashboard
  `null`'ı soluk tire olarak gösterir (`.is-null`).
- **`NO_DATA` ≠ `OFF`.** "Veri gelmedi" ile "tezgah kapalı" ayrı durumlar;
  karıştırılırsa duruş raporu yanlış çıkar. `NO_DATA`'yı her zaman sunucu üretir,
  ajan göndermez. Zaman şeridinde **taramalı desenle** çizilir — renk tek başına
  ayırt edici değil.
- **Durum rengi tek başına anlam taşımaz.** Her gösterge ikon + etiket + renk.
- **Çalışma oranı veri kaybından etkilenmez:** `runRatio` paydası yalnızca ölçüm
  yapılan süre. Kapsama ayrı raporlanır (`coverage`).
- Grafik/dashboard işine girmeden önce **`dataviz` skill'ini oku**.

---

## 8. Dosya haritası

| Yol | İş |
|---|---|
| `shared/schema.js` | Normalize telemetri sözleşmesi + ingest doğrulaması. Alan eklemek buradan başlar. |
| `shared/drivers.js` · `config/drivers.json` | Sürücü kaydı (hangi protokol destekleniyor) ve kontrolcü modelleri (`models`: 11TB / 22TB). |
| `shared/features.js` · `config/features.json` | Kurulumda KAPALI Planlama bölümleri (paketleme, hammadde): doğrulama + yükleme; sunucu uçları reddeder, oturum arayüze bildirir. Bkz. §6 "Kurulumda kapalı bölümler". |
| `shared/inventory.js` · `config/machines.json` | Tezgah envanteri (model çözümü, `agentMachines` süzgeci); ayarlar ekranı buraya yazar. |
| `backend/db.js` | SQLite: `samples` (detay, 7 gün) + `spans` (durum aralıkları, 400 gün). Raporlar `spans`'ten gelir, satır sayısından bağımsız hızlı. **Yeniden başlamada** (`resumeTimelines`) PC'nin kapalı kaldığı süre `NO_DATA` yazılır — ani kapanışta açık kalan aralık yeniden başlama anında değil, tezgahın son kaydedilen örneğinde biter; testi `backend/restart.test.js`. |
| `backend/store.js` | Canlı durum (bellek) + aralık yönetimi + veri boşluğu tespiti; her mesajda `PartTracker` ile üretim olayı yazar. |
| `backend/production.js` · `production-report.js` · `program-runs.js` · `csv.js` · `shared/shifts.js` | Üretim adedi: parça sayacı izleyicisi (`PartTracker`) · vardiya × tezgah × program raporu ve CSV'ler (özet/ham tezgah dökümü, program geçişleri dahil) · program çalışma aralıkları izleyicisi (`ProgramRunTracker`) · ortak CSV biçimi · vardiya tanımı (07–19 / 19–07). Testler: `backend/production.test.js`, `backend/program-runs.test.js`. |
| `backend/server.js` | HTTP API + SSE. |
| `dashboard/app.js` · `apps.js` | Yönlendirme, SSE, filo ve detay görünümleri; **yan menüler pencereye sığar ve KENDİ kaydırma çubuğuyla kayar** (0.18.1; `fitSidebars`: sticky menünün yüksekliği pencere − menünün üstü − 14 px olarak ölçülür, kaydırma/yeniden boyutlandırmada güncellenir; dar ekranda menü sayfa akışında, sınır yok); **uygulama kabuğu** (`syncChrome`: Telemetri / Planlama / uygulama seçimi için menü, üst çubuk yazısı, bağlantı göstergesi, alt bilgi) · uygulama seçim ekranı ve hangi rolün hangi uygulamayı göreceği. |
| `dashboard/charts.js` | SVG durum şeridi (`timeline`) ve çizgi grafiği (`lineChart`: imleç + balon; **tezgah detayında artık kullanılmıyor**, bkz. aşağıdaki not). |
| `dashboard/format.js` | Alan tanımları ve etiketler — **arayüzün tek kaynağı**. |
| `dashboard/config-view.js` | Ayarlar ekranı. |
| `dashboard/production-view.js` | Tezgah detayındaki vardiya adetleri paneli ve "Üretim raporu" ekranı (makine / ürün / günlük görünümü). |
| `backend/planning/` · `dashboard/planning-*.js` · `PLANLAMA-TASARIM.md` | Planlama uygulaması (A, B, C, T aşamaları): `downtime.js` (duruşlar), `config/downtime-codes.json` + `shared/downtime-codes.js` (neden kodları), `planning-db.js` (SQLite), `importers.js`/`csv-read.js` (Excel CSV), `program-map.js` (eşleme önerisi), `calc.js` (iş emri hesapları), `progress.js` (gerçekleşen üretim: telemetri olaylarından adet/vardiya/süre, saf hesap), `planning.js` (doğrulama, eşleme, iş emri yaşam döngüsü), `routes.js`; ekranlar Tezgah başı (`planning-shop.js`, operatör), Verimlilik (`planning-efficiency.js`, `efficiency.js` hesapları), Hammadde (`planning-material.js`, `material.js` hesapları), Ölçü kontrolü (`planning-measure.js`, `measure.js` saf hesapları), Paketleme (`planning-packing.js`), ürün tanıtım kartı ve iş emrindeki kasa paneli (`planning-card.js`, işlem kutuları `card-steps.js`), İş emirleri (`planning-workorders.js`, canlı üretim paneli ve başlat/bitir pencereleri `planning-production.js`, yazdırılabilir form + arka sayfa `planning-wo-form.js`) · GKK rapor no (`planning-gkk.js`, `gkk.js`) · İlk onay raporu (`planning-approvals.js`, `first-approval.js`) · teknik resim PDF'leri (`planning-drawings.js`, `backend/pdf-merge.js`) · iş emri formu PDF'i (`wo-form-pdf.js`) · Ölçü raporları (`planning-reports.js`) · rol/sekme tablosu (`planning-tabs.js`) · Ürünler · Siparişler · Program eşleme. Tasarım ve sonraki aşamalar (telemetri bağlantısı, hammadde, verimlilik, tablet): `PLANLAMA-TASARIM.md`. Testler: `backend/planning/*.test.js`. |
| `backend/planning/packing.js` · `dashboard/planning-packing-form.js` | Paketleme formu (EYS.FR.007): vardiya sayfası, satırlar, hava basıncı, koli içi adet öğrenme/öneri, yazdırma. Bkz. §6 "Paketleme formu". |
| `backend/planning/doc-folder.js` · `dashboard/planning-docs.js` | Teknik resim klasörü ve etiket klasörü (iki ayrı `DocFolder`): dosyaları ürün koduna göre ürün kartlarına bağlama, eşle penceresi. Bkz. §6 "Teknik resim klasörü ve Etiket klasörü". |
| `backend/planning/sources.js` · `dashboard/planning-sources.js` | Kaynak klasörü: Mikro/GKK Excel dosyalarını sabit klasörden okuyup değişenleri uygulama ("Kaynak dosyadan yenile"), klasör ayarı ve sonuç penceresi. Bkz. §6 "Kaynak klasörü". |
| `dashboard/library-view.js` | Program kütüphanesi ekranı, tezgah detayındaki "Programlar" paneli ve gönderme penceresi. |
| `dashboard/editor-view.js` · `diff.js` | Program editörü (satır numaralı metin, inceleme/diff, "kaydet" / "kaydet ve gönder") ve saf satır farkı (`backend/diff.test.js` sınar). |
| `dashboard/bulk-import-view.js` · `delete-view.js` · `diff-render.js` | Toplu alım penceresi (plan, çakışma kararları, uygula) · tornadan silme penceresi · ortak satır farkı tablosu (editör ve çakışma ekranı kullanır). |
| `dashboard/bulk-push-view.js` · `tools/torna-test/ezme-testi.ps1` | "Toplu gönder" penceresi (plan, inceleme/onay, ilerleme + durdur, sonuç; kütüphaneden tornaya, yedekleyerek ezer) · gerçek tornada yan ada alma/silme/ezme davranışını güvenle ölçen test betiği (yalnız `ZZTEST…` dosyaları). Bkz. §6 "Toplu gönderme". |
| `dashboard/library-delete-view.js` | "Kütüphaneden sil" penceresi (tek/çoklu; onay = ad ya da sayı; kopyası olan tezgahları gösterir). |
| `dashboard/folder-view.js` · `lib-common.js` | "Yeni müşteri klasörü" penceresi · kütüphane ekranlarının ortak yardımcıları. **Yeni dashboard dosyası `backend/server.js` `STATIC_FILES` listesine eklenmeli** (`backend/static-files.test.js` unutulursa uyarır). |
| `backend/programs/` | Program kütüphanesi + FTP ile tezgaha aktarım (yazma yolu; telemetriden ayrı). Bkz. §6. |
| `backend/auth/` · `backend/auth-cli.js` | Kimlik doğrulama: `policy.js` (izin tablosu, varsayılan reddet), `auth.js` (hesap/oturum/kilitleme), `http.js` (kapı + uçlar), `password.js` (scrypt), `auth-db.js` (SQLite); kurtarma aracı. Testler: `backend/auth/*.test.js` (`e2e.test.js` gerçek backend sürecini başlatır). |
| `dashboard/auth-view.js` · `users-view.js` | Giriş/ilk kurulum ekranı, oturum, üst çubuk (kullanıcı/çıkış), 401 koruması · Ayarlar > Kullanıcılar (yalnız admin). |
| `tools/syntec-agent/SyntecReader.cs` | **Okuma + durum eşlemesi (tek kaynak).** |
| `tools/syntec-agent/Agent.cs` | Sürekli çalışan servis: tezgah başına iş parçacığı, yeniden bağlanma, tamponlama. |
| `tools/syntec-agent/Bekci.cs` | **Ajan bekçisi** (`--supervise`): VARSAYILAN olarak her torna için ayrı ajan süreci açıp izler (çıktı/ilerleme/donma, yalnız takılan süreci yeniden başlatır); `--tek-surec` eski kip; testleri `tools/syntec-agent/test/bekci-isci-test.ps1` ve `bekci-test.ps1`. Bkz. §6 "Ajan bekçisi" ve "Torna başına süreç". |
| `tools/syntec-probe/` | Tek seferlik saha teşhis aracı. |
| `kurulum/` | İzleme PC'si kurulum betiği (`kurulum.ps1`) ve belgesi. |
| `installer/` | Setup.exe üretimi (Inno Setup): `build-installer.ps1`, `cnc-telemetri.iss`. DLL'ler pakete derleme anında girer, depoda yok. |
| `ornek-veri/` | **Gerçek tezgah yakalaması** — referans gerçek. |
| `SYNTEC-REMOTEAPI.md` | Protokol notları, saha bulguları. |
| `MAKINE-BASINDA.md` | Makine başında izlenecek adımlar. |

## 9. API

| Uç nokta | İş |
|---|---|
| `GET /api/session` · `POST /api/auth/login` · `/setup` · `/logout` · `/password` | Oturum durumu (giriş yapmışsa `closedSections`: kurulumda kapalı Planlama bölümleri; kapalı bölümün uçları 403 `section-closed`) · giriş · ilk yönetici (yalnız localhost) · çıkış · kendi şifreni değiştir. |
| `GET/POST /api/users` · `DELETE /api/users/:id` · `PUT /api/users/:id/password` · `GET /api/auth/audit` | **Yalnız admin:** hesap yönetimi ve giriş olayları. |
| `POST /api/ingest` | **Yalnız sunucu bilgisayarından (giriş gerekmez).** Ajandan telemetri (tek mesaj ya da dizi). Kısmi kabul: geçerliler yazılır, geçersizler 207 ile raporlanır. **Gövde sınırı 40 MB** (diğer uçlarda 1 MB): ajan backend kapalıyken en çok 20.000 mesajı tamponlar ve geri gelince HEPSİNİ tek istekte yollar; eski 1 MB sınır ~2.500 mesajda (7 tezgahta birkaç dakikalık kesinti) paketi reddediyor, ajan aynı paketi sonsuza dek yeniden deniyor ve veri kalıcı kayboluyordu (2026-10-13'te bulundu, düzeltildi; 20.000 mesaj ≈ 8 MB ≈ 0,3 sn). **Tek mesajın yazılamaması paketi düşürmez** (o mesaj reddedilir + günlüğe yazılır; hiçbiri yazılamazsa 500 ve ajan tamponu korur). |
| `GET /api/stream` | SSE, saniyede bir filo anlık görüntüsü. |
| `GET /api/machines` | Anlık görüntü. |
| `GET /api/machines/:id?window=8h` | Detay + vardiya özeti + aralıklar + duruşlar. |
| `GET /api/machines/:id/history?window=30m` | Seyreltilmiş zaman serisi. |
| `GET /api/machines/:id/export.csv?window=24h[&format=ham]` | Türkçe Excel CSV (BOM + `sep=;` + ondalık virgül). Varsayılan **özet** (üretilen parçalar + durum/program/alarm değişimleri); `format=ham` her kaydedilen örnek. |
| `GET /api/production?from=&to=&machine=` · `/api/production/export.csv?...&view=makine\|urun\|gunluk` | **Üretim raporu** (izleme verisi: viewer de görür). `from/to` = üretim günü `YYYY-AA-GG` (varsayılan bugünün üretim günü, en çok 93 gün). Yanıt: `rows`, `byMachine`, `byProduct`, `days`, `totals`, `suspect`, `shifts`, `current`, `prevDate/nextDate`, `prevRange/nextRange`, `presets`. |
| `GET /api/production/runs?from=&to=&machine=` · `/api/production/runs.csv?...` | **Program geçişleri** (izleme verisi: viewer de görür): aralığın program çalışma aralıkları (`runs[]`: `program`, `startedAt`, `endedAt`/`ongoing`, `durationMs`, `qty`, `startsBefore/endsAfter`, `startShift/endShift`). |
| `/api/planning/packing/sheet` (GET) · `packing/sheet/air` (PUT) · `packing/suggest` (GET) · `packing/rows` (POST) · `packing/rows/:id` (PUT/DELETE) | **Paketleme formu** (operatör + yönetici; `paketleme` bölümü kapalıysa 403): vardiya sayfası (`?day=&shift=`), hava basıncı, ürün için koli içi adet önerisi/iş emirleri/etiket, satır ekle (yanıt `learned`) / düzenle / iptal (`?reason=`). |
| `/api/planning/drawing-folder` · `sticker-folder` (GET) · `…/dir` (PUT) · `…/match` (POST) · `/api/planning/product-files/:id` (GET/DELETE) | **Teknik resim / etiket klasörü** (yalnız admin; `product-files/:id` GET operatör + yönetici, DELETE yönetici): klasör ve dosya durumu · klasörü ayarla (`{dir}`) · dosyaları ürün koduna göre eşle (`{update?}`; yanıt: bağlananlar, eşleşmeyen/kabul edilmeyen dosyalar, hâlâ dosyası olmayan ürünler) · ürüne bağlı dosyayı indir/kaldır. |
| `/api/planning/sources` (GET) · `sources/dir` (PUT) · `sources/refresh` (POST) | **Kaynak klasörü** (yalnız admin): klasör + dosyaların durumu (yeni/değişmiş/güncel) · klasörü ayarla (`{dir}`, boş = varsayılan `data/kaynak`) · klasörü oku ve değişenleri uygula (`{force?}`; yanıt: dosya durumları, toplamlar, `changes` listeleri). |
| `/api/planning/summary` · `products[/:kod]` · `import` · `orders[/lines]` · `programs[/map\|/confirm-exact\|/product-search]` | **Planlama** (yalnız admin; **`programs*` uçları 0.17.2'den beri operatöre de açık**, `programs/product-search` dar ürün araması): özet · ürün kartı listesi/arama, oluştur (POST), düzenle (PUT) · Excel içeri alma: `.xlsx` (tüm sayfalar taranır) ya da CSV (gövde = ham dosya, tür içerikten anlaşılır, `?filename=&keepOld=1`) · siparişler (`?q=&open=1`) ve bir siparişin satırları · tornalarda görülen programlar ve eşleme durumu, eşle (PUT), kaldır (DELETE), toplu onay (POST). |
| `/api/planning/downtime-codes` · `shop/overview` · `shop/stops?machine=&hours=` · `shop/downtime-reasons` (POST) · `shop/downtime-reasons/:id` (DELETE) | **Fabrika PC'si / Tezgah başı** (operatör + yönetici): duruş nedeni kodları ve grupları · tezgah başına canlı durum, üretimdeki iş emri, bekleyenler, nedeni sorulmamış duruşlar · bir tezgahın ölçülmüş duruşları ve nedenleri · duruşa neden bağla (`machineId, from, to, code, note?, person?`) · nedeni kaldır. |
| `/api/planning/efficiency[.csv]` · `downtime-report[.csv]` | **Verimlilik ve duruş raporları** (yalnız admin): `?from=&to=&machine=` (varsayılan bu ay); verimlilik özeti/matris/günlük satırlar/ürün/gün/tezgah ve termin riski; duruş neden dakikaları ve nedeni belirsiz; CSV `&view=gunluk\|matris\|urun\|tezgah` ve `durus\|durus-kod-gun`. |
| `/api/planning/material/need` · `material/consumption[.csv]` · `material/fis` (POST) · `material/fis/undo` (POST) | **Hammadde ve sarfiyat** (yalnız admin): ihtiyaç (planlanan + üretimdeki kalan adet) · gerçekleşen sarfiyat (biten iş emirleri, `?from=&to=&fis=`; CSV `&view=is-emri\|hammadde`) · Mikro sarfiyat fişi "elle girildi" işareti (`orders[], docNo?, kg?, note?`) ve geri alma. |
| `/api/planning/work-orders/:no/cards` (POST) · `work-orders/:no/fields` (POST) | **Ürün tanıtım kartı bas** (tek adım; operatör + yönetici; gövde `{person?, gkkReportNo?, steps?}`: `steps` = yıkama/kurutma/tavlama kutuları) ve **tezgah başından iş emri alanı düzenleme** (ilk onay rapor no, ölçülen net gramaj, GKK rapor no, kullanılan hammadde, açıklama). |
| `/api/planning/work-orders/:no/measurements` (GET/POST) · `work-orders/:no/measure-plan` (PUT) · `crates/:id/sheet` (GET) | **Ölçü kontrolü** (operatör + yönetici): plan + sütunlar, saatlik ölçüm kaydı, kartın föyü. |
| `/api/planning/crates` · `crates/:id` · `crates/:id/close\|pack\|void` · `work-orders/:no/crates` (POST) · `crates/sequence` (PUT, yönetici) | **Kasa / Ürün Tanıtım Kartı** (operatör + yönetici): kasalar (`?woNo=&machine=&state=`), kasa + kart bilgileri, kapat (`person?`), paketleme adedi (`qty, person?`), iptal (`reason`), iş emrinde yeni kasa aç (kart numarasını sistem verir), kart numarası sırası tabanı (`last`). |
| `/api/planning/gkk` (GET/POST) · `gkk/sequence` (PUT) · `gkk/:id` (PUT/DELETE) | **GKK rapor numaraları** (EYS.FR.011): liste/arama (`?q=&erpMaterial=&stockCode=`; `matches[]` iş emri hammaddesine uyanlar, `match`: `tam`/`islemli`/`urun`), yeni numara (POST), düzenle/sil, numara tabanı. **Okuma: herkes (izleyici dahil); yazma yalnız yönetici.** |
| `/api/planning/first-approvals` (GET/POST) · `first-approvals/sequence` (PUT) · `first-approvals/:id` (PUT/DELETE) | **İlk onay raporu** (EYS.FR.013): liste (`?q=&year=`), numara al (`woNo, person?, again?`; **operatör + yönetici**, iş emrinin alanına da yazar), elle kayıt/düzeltme/silme/numara tabanı yalnız yönetici; okuma herkes. |
| `/api/planning/work-orders/:no/print.pdf` (GET) · `work-orders/:no/drawings.pdf` (GET) · `work-orders/:no/drawings?name=` (POST) · `work-orders/:no/drawings/:id` (DELETE) | **İş emri formu + teknik resimler**: `print.pdf` = form (ön sayfa) + resimler (arka sayfalar) TEK PDF (`application/pdf`, izleyici ve operatör dahil herkes; ekranda gösterilen ve basılan dosya) · `drawings.pdf` = yalnız birleşik resimler · yükle (gövde = ham PDF, yönetici) · kaldır (yönetici). |
| `/api/planning/measure-reports` · `work-orders/:no/measure-report` · `products/:kod/measure-plan` (PUT) | **Ölçü raporları** (okuma herkes): ölçümü olan iş emirleri ve bir iş emrinin tüm ölçümleri · ürün kartının kalıcı ölçü planı (yönetici). |
| `/api/planning/work-orders` (+ `/next`, `/sequence`, `/:no`, `/:no/cancel`, `/:no/start`, `/:no/finish`, `/:no/reopen`) | **İş emri** (yalnız admin): liste (`?q=&status=&machine=`), oluştur (POST: `lineId` ya da `stockCode`, `targetQty`, `machineId`, …), sıradaki numara, numara tabanı (PUT), ayrıntı + geçmiş + gerçekleşen üretim (`progress`), düzenle (PUT), iptal (POST, `reason`), **üretime başlat** (`machineId?, startAt?, person?, fields?`), **bitir** (`endAt?, person?`; sonuç dondurulur), **üretime geri al**. |
| `GET /api/health` | Anonim/viewer: yalnız `{ok:true}`. **Admin:** durum + **`statusMapping`** (hangi ham değer hangi duruma eşlendi). |
| `GET /api/agent/machines?driver=&model=` | **Ajanın okuduğu tezgah listesi** — IP'si tanımlı olanlar; `model` (11TB / 22TB) verilirse yalnız o modeldekiler (her model kendi ajanıdır). Ajan bunu dakikada bir çeker. |
| `GET /api/drivers` · `GET /api/config` · `PUT /api/config/machines` | Sürücüler ve yapılandırma. |
| `POST /api/library/programs/delete` · `GET /api/library/log` | **Kütüphaneden silme** (admin; geri dönüşsüz): `ids`, `confirm` (tek programda adı, çoklu sayısı), `by`; yanıt `deleted[]`, `programs`, `versions` · silme kaydı (kim, ne zaman, sürüm SHA'ları). |
| `GET /api/library/config` · `/customers` · `/matrix` | Özellik durumu (`transferEnabled`…), müşteri klasörleri, program × tezgah matrisi. |
| `GET/POST /api/library/programs` | Liste (`?customer=&q=`); yükleme: gövde = ham dosya, `?customer=&name=&by=&note=&originalName=` (201 yeni sürüm, 200 aynı içerik). |
| `POST /api/library/programs/text` | **Editör kaydı** (JSON: `text`, `lineEnding`, `encoding`, `bom`, `by`, `note`; yeni program için `customer`+`name`, yeni sürüm için `programId`+`baseVersionNo`, `acceptNewer`). 201 yeni sürüm, 200 aynı içerik, 409 `code: exists` / `newer-version`. |
| `GET /api/library/programs/:id` · `/versions/:no[?download=1\|full=1]` | Sürümler · önizleme (JSON; `full=1` kesmeden tam metin + `roundTrip`) ya da ham indirme. |
| `POST /api/library/programs/:id/rename` | **Kütüphanede yeniden adlandırma** (tezgaha yazmaz, §6): `{name}` → 200 (ayrı: `renamed:false` no-op); 400 geçersiz ad; 404; 409 aynı klasörde ad çakışması. |
| `POST /api/machines/:id/programs/import-plan` · `GET .../import-plan/:planId[/diff?key=]` · `POST .../import-apply` | **Toplu alım** (admin; tornaya yalnız okuma): plan başlat (202, arka plan) · durum/ilerleme + plan · bir çakışmanın iki yüzü (fark) · uygula (`decisions: {anahtar: 'al'|'atla'}`, `skipKeys`). |
| `POST /api/machines/:id/programs/push-plan` · `GET .../push-plan/:planId` · `POST .../push-apply` · `POST .../push-stop` · `GET /api/library/backups/:id[?download=1]` · `POST /api/library/backups/:id/restore` | **Toplu gönderme** (admin; tornaya yazar ve ezer, §6): plan (yalnız okuma, 202) · plan + uygulama ilerlemesi · uygula (`confirm` = tezgah kimliği, `acks`, `skipKeys`; 202; 22TB'de 422) · durdur · ezilen eski hâllerin yedeği (indir / yeni sürüm olarak al). |
| `POST /api/machines/:id/programs/delete-precheck` · `/delete` | **Tornadan silme** (admin; silme kapısı kapalıysa 422): ön kontrol (yazmaz) · sil (`confirm` = program adı, `acks`). Kayıt `kind: 'silme'`. |
| `POST /api/machines/:id/folders` | **Tezgahta yeni müşteri klasörü** (JSON: `name`, `confirm` = tezgah kimliği, `by`). Kayıt döner (`kind: 'klasor'`); 400/403/404/409/422/502 gönderme ile aynı. |
| `GET /api/machines/:id/programs` | Son taramanın envanteri + kütüphaneye göre durum. |
| `POST /api/machines/:id/programs/scan` · `/import` | Tezgahı FTP ile tara (yalnız okuma) · tezgahtaki programı kütüphaneye al. |
| `POST /api/transfers/precheck` · `POST /api/transfers` · `GET /api/transfers` | Ön kontrol (yazmaz) · gönder (`confirm` = tezgah kimliği, `acks`) · denetim kaydı. Hata kodları: 400 doğrulama, 403 kapalı, 404, 409 meşgul, 413 büyük, 422 desteklenmiyor, 502 tezgah/FTP. |

`window`: `30m` · `8h` · `24h` · `7d`. Ya da `from`/`to` (epoch ms veya ISO).

---

## 10. Sıradaki işler

- [ ] **`kurulum/kurulum.ps1`'i gerçek Windows'ta çalıştır** — yükseltilmiş
      oturumda hiç denenmedi. Artık en kolay yol: `installer/` ile üretilen
      Setup.exe'yi hedef PC'de çalıştırmak (görev, güvenlik duvarı, açılışta
      başlatma ve SYSTEM hesabında ajan ilk kez orada sınanır).
- [x] ~~22TB tezgahta ilk gerçek bağlantı~~ — yapıldı (2026-10-08, CNC-08 / .97): okuma ve FTP taraması doğrulandı (§3).
- [ ] **22TB: gönderme testi ve uzun süreli kararlılık.** Tek kontrollü gönderme (yeni test adı, yeni/boş klasör) → başarılıysa
      `config/drivers.json`'da `models[22TB].fileTransfer.sendEnabled = true`; ajanı saatlerce açık bırakıp takılma/oturum
      sızıntısı olmadığını doğrula (22B oturumu 5 TCP açıyor, oturum sınırı ölçülmedi).
- [ ] **Ajan 0.5.0 (torna başına süreç) gözlenecek** (bkz. §6 "Torna başına süreç"; 2026-10-15'te fabrika PC'sinde devreye alındı, 8/8 tornadan veri akıyor): uzun süreli kararlılık ve ilk gerçek takılma / elektrik kesintisi sonrası davranış. `ajan.bekci.log`'da `isciler:` satırlarına, `ILERLEME YOK` / `ISCI CIKTI` olaylarına ve
      iş parçacığı dökümlerine bak: 16:50 olayının kök nedeni (14 Ekim) ve 04:21 / 23:54 duraklamaları için ipucu. `PARK EDİLDİ` artık tek tornaya özel süreçte (bekçi `ILERLEME YOK` ile o süreci yeniden başlatır).
- [ ] **Kaynak klasörü (0.19.0) fabrika PC'sinde:** Mikro'nun Excel çıktısının yazıldığı yerel klasörü "Kaynak klasörü…" ile göster (ya da dosyayı `C:/CNC-Telemetri/data/kaynak`'a kopyala), ilk yenilemeyi bir iş emri/sipariş sorgusuyla karşılaştır; Mikro dosyayı yazarken yenileme (yarım dosya) ve elle düzenlenmiş kartlardaki "korunan" farklar sahada nasıl, bak.
- [ ] **Paketleme formu, teknik resim klasörü ve etiket klasörü (0.19.0) gerçek veriyle:** fabrikadaki gerçek teknik resim PDF'lerini ve etiket Word dosyalarını iki ayrı yerel klasöre koyup "Teknik resimleri eşle…" / "Etiketleri eşle…" ile dene (kaç ürün bağlandı, "eşleşmeyen dosyalar" listesi dosya adı kalıbı hakkında ne söylüyor); bir iş emri aç, resimlerin kendiliğinden geldiğini doğrula.
      Paketleme formunu bir vardiya boyunca ustalarla kullan (operatör hesabıyla): koli içi adet önerisi doğru mu, +10–15 fazla sıkıştırma ve yarım koli akışı kâğıt formla uyuşuyor mu, A4 yatay baskı kâğıt EYS.FR.007 ile yan yana nasıl duruyor. **Etiket:** şimdilik yalnız ürüne bağlanıp indirilir; adet (QTY / koli içi adet) ve paketleme tarihini Word'de usta yazar. Sistemin bunları doldurması için karar bekliyor: (a) .doc dosyalarını bir kerelik .docx'e toplu dönüştürüp sistemin doldurması, (b) sistemin kendi etiketini basması.
      Paketleme/Hammadde bölümleri Setup.exe'de varsayılan KAPALI (`-KapaliBolumler`); açmaya karar verilince yeni paket `build-installer.ps1 -KapaliBolumler @()`.
- [ ] **Setup.exe (0.18.0) fabrika PC'sinde ilk kurulum/güncelleme:** `C:/CNC-Telemetri/data` yedeği al; sessiz saatte kur; açılışta `[backend] KAPALI bölümler: hammadde` satırını (0.19.0 paketi: **Paketleme AÇIK, yalnız Hammadde kapalı**; `build-installer.ps1 -KapaliBolumler 'hammadde'`) ve `config/downtime-codes.json`'ın kurulduğunu doğrula (önceki Setup'lar bu dosyayı kurmuyordu);
      menüde Paketleme/Hammadde yok, kart basma/ölçü föyü/ret çalışıyor mu bak. Bölümleri açmaya hazır olunca yeni paket: `build-installer.ps1 -KapaliBolumler @()`.
- [ ] **İki ajanlı kurulum (agent\ + agent22\) yükseltilmiş oturumda denenmedi**: iki görev, SYSTEM hesabı, ikinci
      ajanın log/bellek davranışı. Yalnız paket duman testi (iki ajan da kendi DLL'ini yüklüyor) yapıldı.
- [ ] **Gerçek tezgahta ajanı çalıştır** — şimdiye kadar yalnızca sahte DLL ile
      uçtan uca test edildi; gerçek donanımda yalnızca probe çalıştı.
- [ ] **Boşta/alarm ham değerlerini gerçek tezgahtan yakala** — `/api/health`
      → `statusMapping` listesine bak, tanınmayan değer çıkıyor mu.
- [ ] 7 tezgaha statik IP + `Start server while boot` (tek ziyarette, bkz. §5).
- [ ] CNC-03…07 kimlik bilgileri (seri no, üretim yılı) — panel başında toplanacak.
- [x] ~~Kimlik doğrulama~~ — yapıldı (0.5.0): admin/viewer, bkz. §6. **Gerçek kurulumda henüz denenmedi** (Setup ile yükseltme, ilk
      hesap, alt PC'de oturum). Açık: uzaktan erişim için **Tailscale** kurulumu (alt PC + 2 dış kişi), HTTPS (`tailscale serve`),
      iki adımlı doğrulama, çok bilgisayarlı ajan için ajan anahtarı.
- [ ] **Program aktarımının ilk gerçek tornada denemesi** (§6 "doğrulanmayanlar"): önce
      "Tezgahtaki programları tara" (salt okunur), sonra yeni bir test adıyla tek program; `library.db`
      yedeği; Setup.exe ile kurulu PC'de FTP erişimi (güvenlik duvarı çıkış kuralı yeterli).
- [ ] Üzerine yazma (yeni sürümü aynı adla gönderme): `RNTO`/`DELE` ezme semantiği gerçek
      tornada ölçüldükten sonra, mevcut içeriği önce kütüphaneye yedekleyerek.
- [ ] **Yeni müşteri klasörü açma (`MKD`) — gerçek tornada (11TB ve 22TB) denenecek.** Kod ve arayüz hazır, sahte FTP'de sınandı
      (2026-10-08). Plan: `ZZTEST…` adlı boş klasör aç (ürünün kendi akışıyla) → LIST/CWD doğrula → panelde göründüğüne bak →
      `curl.exe -Q "RMD ZZTEST…"` ile sil (ürün klasör silmez). Sonra 22TB'de tek kontrollü gönderme ve `sendEnabled: true`.
      Program/klasör silme üründe yok.
- [ ] **Toplu gönderme gerçek tornada denenecek (2026-10-16):** (1) fabrika PC'sinde `tools/torna-test/ezme-testi.ps1` önce bir 11TB tornada, sonra 22TB tornada çalıştırılır (`-Klasor` var olan bir müşteri klasörü; çıktı/log gönderilir); (2) hepsi TAMAM ise 22TB için `config/drivers.json` `sendEnabled: true`;
      (3) ilk gerçek toplu gönderim TEK müşteri klasörüyle (plan penceresinde klasör seç) küçük bir tornada denenir, ardından tüm klasörler; ezilen bir programın yedeğinin program sayfasında göründüğü ve "Yeni sürüm olarak al"ın çalıştığı doğrulanır; (4) süre ve üretime etkisi (ilerleme + tornanın FTP'si) izlenir; (5) kontrolcü belleğindeki program davranışı sorulur/denenir.
- [ ] **Tornadan silme (`DELE`) gerçek tornada İLK KEZ denenecek** (11TB'de kapı 2026-10-13'te AÇILDI, ama `DELE` hiç denenmedi). Plan: önce kendi gönderdiğimiz `ZZTEST…` adlı bir test dosyasını (`Program gönder`) UI'dan sil →
      tornada gerçekten kalktığını panelden ve tazeleme taramasıyla doğrula; gerçek bir müşteri programını bu doğrulamadan önce silme. Acil kapatma: `DELETE_DISABLED=1`. 22TB'de önce gönderme (`sendEnabled`) doğrulanmalı.
      Denenecekler: DELE yanıt kodu (250?), çalışan/açık dosyada davranış, büyük/küçük harf.
- [ ] **Ajan: uzun backend kesintisi gerçek kurulumda denenmeli** (gece boyu kapalı bırak, geri aç): tampon (20.000 mesaj) geri gelince tek istekte gidiyor (backend artık kabul ediyor); ajan tarafında paketleri parçalamak (ör. 1.000'er mesaj) daha güvenli olurdu ama C# değişikliği ajanın yeniden derlenmesini gerektirir (yapılmadı). Kesinti sonrası geri yüklenen aralığın durum şeridinde `NO_DATA` kalması bilinen eksik (aşağıdaki `ts` maddesi).
- [ ] **Program geçişleri ve tarih aralığı gerçek tezgahta doğrulanacak:** bir vardiyada tezgahta program değiştirilince "Program geçişleri"nde saat ve adet panel/kâğıtla uyuşuyor mu; ana program adı geçişte kısa süre boş/başka dönüyor mu (parçalı aralık çıkıyor mu); 10 dk sessizlik eşiği uygun mu.
- [ ] **Kütüphane klasör görünümü gerçek veriyle:** gerçek bir toplu alımdan sonra programlar beklenen klasörlerde mi, kökte yalnız gerçek ortak programlar mı; eskiden yanlış klasöre/köke yüklenmiş programlar kütüphaneden silinip yeniden alınabilir (klasör taşıma özelliği YOK).
- [ ] **Toplu alım gerçek tornada denenecek** (yalnız okuma): büyük klasörde (200+ dosya) süre ve FTP'nin üretim sırasında davranışı; plan 15 dk / 100 MB sınırları yeterli mi.
- [ ] **Fabrika PC'sinde operatör ekranı (T) gerçek kullanımda:** "fabrika" operatör hesabını aç, aşağıdaki PC'de giriş yap (oturum sürekli açık kalmalı), bir iş emrini gerçek tezgahta başlat/bitir, gerçek bir duruşa neden bağla (ölçülen süre ile kâğıt karttaki saat uyuşuyor mu); 3 dk eşiği ve kod gruplandırması ustalara uygun mu.
- [ ] **Ölçü kontrolü ve tek adımlı kart gerçek kullanımda:** gerçek bir ürünün ölçü satırlarını tanımla (adı/nominal/sapma kâğıt formla uyuşuyor mu); bir vardiya boyunca saatlik ölçüm gir; kartın föyünü **A4 yatay** yazıcıdan bas ve kâğıt EYS.FR.005 ile yan yana koy (sütun genişliği, ▲/▼ okunabilirliği);
      tablette giriş rahatlığı (büyük giriş kutuları); kartı kasaya atma sırası (kart kasa dolunca basılıyor: ölçümler kasaya doğru karta düşüyor mu).
- [ ] **Verimlilik (E) gerçek vardiyalarla doğrulanacak:** bir haftanın Excel verimlilik sayfasını sistemle yan yana koy (aynı tezgah/ürün/vardiya): ayrılan süre (başlat/bitir saatleri vardiya ile uyuşuyor mu), adet, %; Excel'de %100 üstü çıkan ürünlerin sistemde ölçülen çevrimle uyumu; planlı duruşların (yemek molası) ayrılan süreden düşülmesi gerekiyor mu karar ver.
- [ ] **Hammadde ve sarfiyat (D) gerçek veriyle doğrulanacak:** bir ayın biten iş emirleri için sistemin kg'ını Mikro'daki gerçek sarfiyat fişleriyle karşılaştır (brüt gramaj ürün kartında doğru mu, çubuk uçları/fire farkı kaç %); ürün kartında brüt ağırlığı olmayanlar tamamlansın; Mikro'ya yazma API'si (bayi) doğrulanınca fiş otomatik gönderilecek (G).
- [ ] **Ürün tanıtım kartı (K) gerçek kullanımda:** kartı gerçek yazıcıda A5 bas, kâğıt kartla yan yana koy (alan sırası/boyutları); bir kasa aç/kapat, paketlemede kesin adedi gir, "sayılan" tahminin kesin adetten ne kadar saptığına bak; kasa açma/kapatmayı ustalar unutuyor mu (kasaya atanmayan adet).
- [ ] **GKK, ilk onay, teknik resim ve ölçü raporları (0.17.0) gerçek kullanımda:** (a) GKK ve ilk onay listesini **gerçek yazıcıdan** A4 dikey bas, kâğıt EYS.FR.011/EYS.FR.013 ile yan yana koy; (b) ölçü raporunu A4 yatay bas; (c) fabrikanın **gerçek teknik resim PDF'lerini** bir iş emrine yükle, iş emri penceresinde form + resimlerin doğru sırayla ve okunur göründüğünü, **"Yazdır" ile form ve resimlerin tek işte (çift taraflı) çıktığını** doğrula (fabrika PC'sinin tarayıcısında `iframe.contentWindow.print()` çalışmazsa PDF yeni sekmede açılır) (CAD çıktısı PDF'lerde birleştirici hata verirse dosyayı sakla);
      (d) GKK eşleme önerilerini gerçek iş emri hammaddeleriyle dene (hiç eşleşmeyen hammaddeler listelenip kural eklenebilir); (e) izleyici hesabını (Tailscale'li dış kişi) gerçek oturumla dene: müşteri adı iş emri ayrıntısında görünür, kabul edilebilir mi karar ver.
- [ ] **Üretim adedi gerçek tezgahlarda doğrulanacak:** bir vardiya sonunda raporun toplamı ile tezgahın `ToplamParca` farkını karşılaştır; çevrim süresinin parça başına
      gerçek süreyle uyumunu panelden kontrol et; sayaç elle sıfırlanınca / tezgah kapanıp açılınca davranış (`suspect`, `*` notu). Birden çok programı art arda çalıştıran tezgahta program atfı.
- [ ] Vardiya saatleri sabit (`shared/shifts.js`: 07–19 / 19–07); fabrika değiştirirse Ayarlar'dan düzenlenebilir hâle getirilebilir. Üç vardiya gerekirse yalnız liste uzar.
- [ ] Program adı ↔ müşteri ürün kodu eşlemesi (üretim raporunda "ürün" şimdilik program adı; ikinci ürün: Mikro / iş emri ile birlikte ele alınacak).
- [ ] **Planlama A aşaması gerçek kullanımda:** alt PC'de Excel'in kendi "CSV UTF-8" çıktısıyla iş emirleri listesi ve sipariş dosyası içeri alınacak (başlık/ondalık/tarih biçimleri, bilimsel gösterimli müşteri kodu uyarısı, dosya boyutu).
      Program eşlemesinde `O0179` / `SR001-018` gibi kurala uymayan adlar elle seçilecek. Aynı gün **B** (iş emri) de denenecek: numara tabanı Excel'deki son numarayla örtüşüyor mu, yazıcıdan çıkan form kâğıt formla yan yana nasıl duruyor; **C** için: bir iş emrini gerçek tezgahta başlat/bitir, sonucu tezgahın `ToplamParça` farkıyla karşılaştır, vardiya geçişinde (19:00) adet kırılımını kontrol et.
      Sonraki: **T** (fabrika PC'sinde operatör ekranı + duruş nedeni), **K** (ürün tanıtım kartı / kasa), **D** hammadde ve sarfiyat, **E** verimlilik ve duruş nedeni (kod listesi **Excel'deki** D1–D46, Z1–Z4), bkz. `PLANLAMA-TASARIM.md`.
- [ ] Program editörü gerçek kullanımda: yazılan programın tornada çalışıp çalışmadığı (söz dizimi) bizim kontrolümüzde değil.
- [ ] Backend, olay zamanını mesajın `ts`'inden değil geliş anından alır (`store.js ingest`):
      ajan tamponu geri yükleyince kesinti aralığı `NO_DATA` kalır.

---

## 11. Yanlış çıkmış varsayımlar — tekrarlanmasın

- "Portlar 5678/8080 RemoteAPI olabilir" → **yanlış.** Gerçek portlar
  5566/5568/5570/5572.
- "10.116.54S RemoteAPI için eski olabilir" → **yanlış.** Resmi sürüm tablosu
  10.116.54.x'i açıkça kapsıyor (1.1.0 ve 1.2.0).
- "Lisans/opsiyon gerekebilir" → **gerekmiyor.** Sorun yalnızca
  `Start server while boot` ayarıydı.
- "`Net Status: Code 1222` ağ sorunu" → **hayır**, SMB paylaşım bağlantısını
  gösteriyor, teşhisi saptırdı.
- "Parça sayacı için ARIX PLC adres haritası gerekli" → **gerekmedi**,
  `READ_part_count` doğrudan veriyor.
