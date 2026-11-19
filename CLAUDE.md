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

(Gerçek tornada okuma + FTP okuma sonradan doğrulandı, yukarıya bakın.) **22TB'de program GÖNDERME 2026-10-30'da AÇILDI**
(`config/drivers.json` → `models[22TB].fileTransfer.sendEnabled = true`, kullanıcı kararı — **FTP'de yazma gerçek 22TB'de
hâlâ hiç denenmedi**; kullanıcı kendi yeni/izole bir test klasöründe, mevcut müşteri klasörlerine dokunmadan, kontrollü
ilk denemeyi kendisi yapacak). **Silme (`deleteEnabled`) ayrıca ve hâlâ kapalı.** Bu, 22TB kapısından geçen HER yazma
yolunu açar — tek program gönderme, yeni klasör açma (`MKD`) VE **toplu gönderme** (ezerek yazan, bkz. aşağıdaki "Toplu
gönderme"); hiçbiri 22TB'de daha önce denenmedi. İlk gerçek sonuç bu bölüme ve §10'a işlenmeli; sorun çıkarsa
`config/drivers.json`'da `sendEnabled` yeniden `false` yapılabilir. Tarama (salt okunur) ve okuma zaten açıktı.

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

Paket ayrıca `runtime\python\` altına **gömülü Python + OR-Tools** içerir (Çizelgeleme önerisi için;
ilk derlemede internet gerekir, sonraki derlemeler `installer\prereq\python-embed\` önbelleğini kullanır).
Ayrıntı: §6 "Çizelgeleme / optimizasyon".

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
- **Kurulumda kapalı Planlama bölümleri (0.18.0, 2026-10-15; varsayılan 2026-11-02'de değişti):** bir bölüm kuruluma hiç girmeden kapatılabilir. `build-installer.ps1 -KapaliBolumler` (**varsayılan artık `@()` = hepsi açık** — kullanıcının tekrar tekrar belirttiği karar: yönetici için Planlama'da kapalı bölüm OLMAMALI; `'hammadde'`/`'paketleme'` yalnız kullanıcı açıkça isterse verilir)
  paketin `config/features.json` dosyasını yazar (depodaki dosya her şeyi AÇIK bırakır: geliştirme/demo etkilenmez). Duman testi paketlenmiş sunucuda tek kullanımlık yönetici hesabıyla (geçici veritabanı, rastgele şifre) oturumun bölüm listesini ve kapalı uçların 403 verdiğini denetler.
  Sonradan kapatmak = yeni kurulum paketi (`-KapaliBolumler 'hammadde'`); kurulu PC'de `C:/CNC-Telemetri/config/features.json` düzenlenip sunucu yeniden başlatılarak da olur ama arayüzde düğme YOK (bilinçli). Ayrıntı: aşağıda "Kurulumda kapalı bölümler".
- **Denenmedi:** Setup.exe'nin yükseltilmiş (UAC) kurulumu — görevler, güvenlik
  duvarı, açılışta başlatma. Ajan SYSTEM hesabıyla gerçek tezgahta çalıştırılmadı.
  Masaüstü uygulamasının pencere ve UAC yolları da elle denenmedi (mantığı gerçek
  süreçlerle `--sessiz` kodlarıyla ve derleme duman testinde sınandı).
  Ayrıntı: `installer/README.md`.

**Tezgah başı "Başka iş emri başlat…" penceresi düzeltildi (2026-10-29, kullanıcı isteği, gerçek fabrika PC ekran görüntüsünden bulundu):** `dashboard/planning-shop.js` `openPicker` — üç sorun: (1) arama kutusu devasa yükseklikte görünüyordu çünkü `<input class="pl-search">` `.modal-body`'nin (dikey flex) DOĞRUDAN çocuğuydu ve `.pl-search`'ün `flex:1 1 280px` kuralı dikey eksende büyüyordu (her yerde `.pl-search` bir `.pl-bar` — yatay flex — içinde kullanılıyor, burada unutulmuştu); `.pl-bar` ile sarmalandı. (2) ürün kodu (SR0xx.xxx) kesik görünüyordu (ürün adıyla aynı, kırpılan hücredeydi); kendi sütununa alındı, artık tam görünüyor. (3) **müşteri kodu sütunu eklendi** (`w.customerCode`). Pencere `wide: true` oldu (5 sütuna yer açmak için). Tarayıcıda gerçek veriyle doğrulandı.

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

**Kütüphane bölünmesi: Ortak + makine başına (2026-11-03, kullanıcı isteği):** şimdiye kadar tek bir **ortak** kütüphane vardı; artık her tezgahın
**kendi kütüphanesi** de olabiliyor (ör. `CNC-03` kütüphanesi), **ortak**la yan yana. Gerekçe: bir tornadaki tüm programlar toplu çekilip o tornaya
özel saklanabilsin, ortak havuzu kirletmeden. **Varsayılan davranış DEĞİŞMEDİ** — her yeni parametre (`library`) `'ortak'`a düşer, yani eskiden
hiç `library` bilmeyen her çağıran (eski istemci, eski test) tıpkı önceden olduğu gibi tek ortak kütüphaneyle çalışır.
- **Kimlik:** bir programın kimliği artık `(kütüphane, müşteri klasörü, ad)` üçlüsü (`library-db.js`, `programs`/`program_backups` tablolarına
  `library TEXT NOT NULL DEFAULT 'ortak'` eklendi). Aynı (müşteri, ad) **farklı kütüphanelerde bağımsız** var olabilir — `CNC-03`te `SR001.013`ün
  bir sürümü, `ortak`ta aynı adın bambaşka bir sürümü olabilir, birbirine dokunmaz. `library` değeri `'ortak'` ya da **tam olarak bir tezgah
  kimliği** (`routes.js` `validLibrary`: başka bir şey 400 — yazım hatası sessizce "görünmeyen" bir kütüphane açmasın).
- **Ekran (üstten geçiş, her tezgah için):** Program kütüphanesi ekranının (`#/programlar`) başlığında bir **kütüphane seçici** (`<select>`:
  Ortak + envanterdeki her tezgah). Değiştirince liste/arama/seçim sıfırlanır ve o kütüphaneye geçilir (`dashboard/library-view.js`
  `renderLibrarySelect`/`wireLibrary`). **Tezgah detayındaki "Programlar" paneli de kendi, bağımsız seçiciye sahip** (varsayılan o tezgahın
  KENDİ kütüphanesi): tarama, içeri alma, gönderme, toplu alım/gönderim, silme — hepsi o panelde seçili kütüphaneye göre çalışır.
- **Toplu alım, kullanıcının asıl isteği — "soracak ortak kütüphaneye mi yoksa bu tezgahın kütüphanesine mi":** "Tüm programları kütüphaneye al…"
  penceresi artık ilk adımda **radyo seçimiyle sorar** (`dashboard/bulk-import-view.js`): **"CNC-0X kütüphanesi (bu tezgaha özel)"** (varsayılan)
  ya da **"Ortak kütüphane"**. Plan bu seçime göre o kütüphaneye yazılır; aynı pencere hem yeni/aynı/çakışma sınıflandırmasını hem de hedef
  kütüphaneyi önceden gösterir.
- **Toplu gönderme** (`bulk-push-view.js`): kütüphaneden tornaya yazdığı için hangi kütüphaneden gönderdiğini (varsayılan: o tezgahın kendi
  kütüphanesi) salt-okunur bir bilgi satırıyla gösterir — gönderme kaynağı kafa karışıklığı olmasın.
- **Editör, gönderme penceresi, tornadan silme, adını değiştirme** (`editor-view.js`, `library-view.js`'teki `openSendDialog`, `delete-view.js`)
  hepsi `library` parametresini taşır; gönderme penceresi hedef kütüphaneyi bir ipucu satırıyla gösterir.
- **Program eşleme (Planlama) TÜM kütüphaneleri görür** (`server.js` `listLibraryPrograms`: `library.db.listPrograms({library: null})` —
  `library: null` tüm kütüphaneler demek, yalnız bu genel-amaçlı yerde kullanılır; ekranlar her zaman belirli bir kütüphane ister): bir program
  hangi kütüphanede olursa olsun eşlenebilir, çünkü eşleme ada göre çalışır, kütüphaneye göre değil.
- **Göç (var olan `data/library.db` için TEK SEFERLİK):** eski şemalı bir `programs`/`program_backups` tablosu görülürse `#migrateLibraryColumn`
  tabloyu `auth-db.js`'teki `users_new` deseniyle yeniden kurar (yeni `library_new` tablo → eski kayıtları `library='ortak'` ile kopyala → eskiyi
  sil → yeniden adlandır), ID'ler ve FK'ler korunur. **Göç sırasında bulunup düzeltilen iki gerçek hata** (sentetik eski-şema testiyle yakalandı,
  canlıda ilk açılışta patlardı): (1) `program_backups`a `library` sütununu referans eden bir `CREATE INDEX IF NOT EXISTS` şema metninde göçten
  ÖNCE duruyordu — eski tabloda sütun henüz yokken index kurulumu "no such column" ile patlıyordu (`CREATE TABLE IF NOT EXISTS` sessizce atlar
  ama `CREATE INDEX` atlamaz); çözüm: index'i göçten SONRA, constructor'da ayrıca kur. (2) `programs` tablosunu `DROP` ederken `program_versions`
  tablosunun FK'si (`program_id REFERENCES programs(id)`) reddediyordu; çözüm: göç `PRAGMA foreign_keys = OFF/ON` ile sarmalandı (aynı desen
  `auth-db.js`'de zaten vardı).
- **Testler:** `backend/programs/library-split.test.js` (8: kütüphaneler arası bağımsızlık, `findProgram`/`saveText`/`renameProgram` sınırlaması,
  `library:null` davranışı, `compareMachine`/`matrix` kapsamı, HTTP `?library=` doğrulaması, sentetik eski-şema göç testi) + var olan 5 test
  dosyasındaki (`bulk-import`, `delete`, `library-rename`, `library-rename-machine`, `push`) ~20 çağrı noktası yeni imzaya (`findProgram(library,
  customer, name)`, `listBackups(library, customer, name)`) uyduruldu. `npm test` 595/595 yeşil.
- **Tarayıcıda gerçek yerel `data/library.db`'ye karşı denendi:** kütüphane seçici her iki yerde de doğru veriyi getiriyor (ör. `CNC-03`
  kütüphanesinde oluşturulan bir program `Ortak`a geçince görünmüyor — kütüphaneler arası yalıtım doğrulandı), toplu alım penceresindeki radyo
  sorusu doğru şekilde çıkıyor. Test için oluşturulan geçici program (`TEST-SPLIT-01`) temizlendi.
- **Henüz yapılmayan (kullanıcı "önce kütüphane bölünmesiyle başlayalım" dedi, bilerek kapsam dışı bırakıldı):** bitmiş ürün depo akışı (iş emri
  bitince Geçici depoya Mikro fişiyle aktarım, paketlemeden Merkez'e sevk) — henüz tasarlanmadı/yazılmadı. (Kütüphaneyi flash/USB'ye aktarma ZIP
  indirmesi aşağıdaki "Kütüphaneyi ZIP olarak dışa aktarma" bölümünde AYNI oturumda tamamlandı.)

**Kütüphaneyi ZIP olarak dışa aktarma — flash/USB'ye kopyalamak için (2026-11-03, kullanıcı isteği):** "CNC-01'e girip toplu çektiğimiz programları
doğrudan bir flasha aktarabilir miyiz" sorusuna cevap: Program kütüphanesi ekranının başlığında ve her tezgahın kendi "Programlar" panelinde
**"ZIP olarak indir"** bağlantısı — seçili kütüphanedeki (ortak ya da o tezgahın kendisi) **her programın en son sürümünü**, müşteri klasör
yapısını koruyarak (kök programlar ZIP'in kökünde, `MUSTERI_A/SR001.013` gibi klasörlü programlar kendi klasöründe) **tek bir `.zip` dosyasına**
paketler; kullanıcı bu dosyayı normal bir indirme gibi alır ve istediği bir flash/USB belleğe elle kopyalar (tarayıcıdan doğrudan bir USB
sürücüsüne yazma mümkün değil — bu zaten plan aşamasında "ZIP indirme yeterli" diye netleşmişti).
- **Sıfır dış bağımlılık korundu:** `backend/programs/zip-writer.js` — `node:zlib`'in yerleşik `deflateRawSync`/`crc32`'si dışında hiçbir şeye
  ihtiyaç duymayan, bağımsız bir ZIP32 yazıcı (yalnız yazma; `backend/pdf-merge.js`'in PDF için yaptığı elle-ikili-format yaklaşımıyla aynı
  desen). Metin gibi sıkışan içerik `deflate` ile yazılır; zaten küçük/sıkışmayan içerik (deflate çıktısı büyürse) **store** (sıkıştırmasız)
  yazılır — tek dosyalık programlar için fazladan şişme olmasın. **Windows'un kendi `Expand-Archive`'ı ile elle çapraz doğrulandı** (bu modülün
  kendi test okuyucusuna değil, bağımsız bir araca karşı): kök ve klasörlü dosyalar, store VE deflate girdileri doğru ad/klasör/içerikle açıldı.
- **Uç:** `GET /api/library/export.zip?library=` (`library` vars. `ortak`, geçersizse 400) → `application/zip`, `Content-Disposition: attachment;
  filename="<kütüphane>-kutuphane.zip"`. `library.js` `exportZip(library)`, veri `library-db.js` `exportEntries(library)` (tek SQL sorgusu: her
  programın en son sürümü + içeriği, `listPrograms` + program başına `getVersion` döngüsü yerine). Boş kütüphane geçerli (0 girdili) bir ZIP
  döner — hata değil.
- **Testler:** `backend/programs/zip-writer.test.js` (5: boş liste, kök+klasörlü yol, store/deflate seçimi, çok dosyalı sıralı okuma — kendi
  test-amaçlı ZIP okuyucusuyla) + `backend/programs/export-zip.test.js` (4: en son sürümün paketlenmesi, kütüphaneler arası sızıntı olmaması, boş
  kütüphane, HTTP uç + yanlış `library` 400). `npm test` 604/604 yeşil.
- **Tarayıcıda gerçek sunucuya (dev, gerçek `data/library.db`) karşı denendi:** her iki düğme de (ana ekran "ortak", tezgah paneli kendi
  kütüphanesi) doğru `?library=` ile doğru `Content-Type`/`Content-Disposition` döndürüyor; konsolda hata yok. Gerçek veri yazılmadan (yalnız
  okuma) test edildi, veritabanına dokunulmadı.

**Program editörü (2026-10-08):** yeni NC programı doğrudan üründe yazılır ("Yeni program yaz…") ya da var olan programın bir
sürümü düzenlenir ("Düzenle…"); kaydedince kütüphanede **yeni sürüm** olur (eski sürümler aynen kalır), "Kaydet ve tezgaha gönder…"
gönderme penceresini o programla açar (orada ayrı onay var). Genel amaçlı kod editörü DEĞİL: satır numarası, imleç konumu,
**kaydetmeden önce değişiklik farkı (diff)**; bul-değiştir yok. **Söz dizimi denetimi/simülasyon yok** (içerik yorumlanmaz ilkesi).
Satır sonu (CRLF/LF) ve kodlama (UTF-8/Latin-1, BOM korunur) sunucuda uygulanır (`library.js` `decodeText`/`encodeText`/`saveText`);
dokunulmayan dosya bayt bayt aynı çıkar (`preview().roundTrip`, karışık satır sonu bildirilir). Aynı (müşteri, ad) ile "yeni program"
409; editör açılırken başka sürüm oluştuysa 409 `newer-version` (arayüz "yine de kaydet" sunar).

**Kütüphanede program adını değiştirme (2026-10-26):** program ayrıntısında "Adını değiştir…" (`library-rename-view.js`); **kütüphane
kaydının** adı değişir, aynı müşteri klasöründe (klasör taşıma yok), sürümler/içerik/gönderme geçmişi dokunulmaz. Aynı (büyük/küçük harf
duyarsız) ada 409; `program_backups` (toplu gönderimde ezilen tornadaki yedekler) aynı adla izlenebilsin diye yeni adla birlikte taşınır, ama
`transfers` (gönderme geçmişi, donmuş kayıt) ve `machine_programs` (son taramadaki envanter, fiziksel gerçek) BİLEREK değişmez. Denetim kaydı
`library_log`'a `program-yeniden-adlandirma` olarak yazılır (eski/yeni ad). Uç: `POST /api/library/programs/:id/rename` (`{name}`, 200/400/404/409).
Testi `backend/programs/library-rename.test.js` (9).

**Tornadaki dosyanın adı da değiştirilir (2026-10-30, kullanıcı isteği):** "yalnız kütüphanede değişiyor, tezgahta da değişsin" — rename
penceresi artık bu programın **kopyası olan tezgahları** (matristen, `status` "tezgahta-yok"/"taranmadı" dışındaki her durum: güncel/eski/farklı/
belirsiz) gösterir ve kaydedince o tezgahlardaki dosyayı da **FTP RNFR/RNTO** ile yeniden adlandırır (**içerik hiç dokunulmaz**, yalnız ad; yeniden
yükleme/doğrulama gerekmez — toplu göndermenin aksine). Kopyası olan tezgah yoksa davranış eskisi gibi kalır (yalnız kütüphane, onay istenmez).
- **Ayrı bir gerçek tezgah YAZMASI olduğu için ayrıca onay ister:** 1 tezgah → tezgah kimliği, >1 tezgah → tezgah **SAYISI** (kütüphaneden toplu
  silmedeki "yanlış seçimi önler" deseniyle aynı); 0 tezgah → hiç FTP'ye gidilmez. Bu onay, kütüphane adının zaten değişmiş olmasını ENGELLEMEZ:
  tezgah adımı reddedilir/başarısız olursa kütüphane adı yine de değişmiş kalır (geri alınmaz), sonuç ayrıca bildirilir — rename'in zaten var olan
  "tezgahtaki dosya eski adla kalabilir" toleransının doğal uzantısı.
- **Her tezgah BAĞIMSIZ değerlendirilir** (`MachineFiles.renameAcrossMachines` → tezgah başına `#doRenameOnMachine`, sıralı): model kapısı kapalıysa,
  tezgah başka bir işlemle meşgulse, **canlı veri yoksa** (ajan bağlı değil: hangi programın çalıştığı bilinmiyor, riske atılmaz — gönderme'deki
  `unknown-state` onayının aksine burada ek onay İSTENMEZ, o tezgah için sessizce **atlanır**), çalışan/seçili programsa, ya da **hedefte zaten o
  adda dosya varsa** (ÜZERİNE YAZILMAZ) o tezgah için atlanır/reddedilir; diğerlerini etkilemez. Tezgahta dosya artık yoksa (`bulunamadı`) envanterdeki
  artık kayıt da kaldırılır. Her deneme (reddedilenler dahil) `transfers` tablosuna **`kind='yeniden-adlandirma'`** ile yazılır (adımlar: `on-kontrol`,
  `yeniden-adlandir`, `dogrula`); başarılı olursa `machine_programs` (envanter) satırı da yeni adla güncellenir (`LibraryDb.renameInventoryEntry`).
- Uç: `POST /api/library/programs/:id/rename-on-machines` (`{customer, oldName, newName, machineIds, confirm}` → `{machines, results[]}`; `machineIds`
  **dashboard'un ekranda gösterdiği** liste — sunucu kendi envanterinden yeniden hesaplamaz, onay metni ekranla birebir tutarlı kalsın diye).
- Testi `backend/programs/library-rename-machine.test.js` (11: tek/çoklu tezgah onayı, çalışan program korunur, hedef ad çakışması, dosya yok,
  canlı veri yok, model kapısı, `TRANSFER_DISABLED`, HTTP). **`npm run demo:programlar`'daki İKİ sahte tornaya (CNC-07, CNC-08) karşı tarayıcıda
  uçtan uca denendi**: 2 tezgahlı bir programda onay "2" istendi, ikisi de bağımsız `RNFR`/`RNTO` ile değişti, gönderme geçmişinde "↻ yeniden
  adlandırma" satırı olarak ✓ Başarılı görünüdü; 0 tezgahlı bir programda (kök, hiç taranmamış) onay hiç istenmedi, yalnız kütüphane ucu gitti.
  **Yan bulgu (bu testte bulunup düzeltildi):** "Kütüphaneden silinenler" ekranı `library_log`'daki HER satırı (silme VE 2026-10-26'dan beri
  yeniden adlandırma da buraya yazıyordu) "− silindi" diye gösteriyordu — rename kaydı yanlışlıkla silinmiş gibi görünüyordu. Ekran "Kütüphane
  kayıt defteri" oldu, satır kendi `action`'ına göre çizilir (`library-view.js` `renderLibLog`).
- **GERÇEK TORNADA DENENMEDİ** (yalnız sahte FTP + demo). `RNFR`/`RNTO`'nun gerçek tornadaki davranışı §3'teki "doğrulanmayanlar" listesinde zaten
  var (toplu gönderme de aynı birincil ilkele dayanıyor); bu özellik ekstra olarak gerçek tornada hiç yük (büyük klasör, çok sayıda eşzamanlı
  tezgah) altında denenmedi.

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
**22TB'de yazma 2026-10-30'da açılmasına RAĞMEN silme AYRICA ve hâlâ kapalı** (`deleteEnabled:false`, bilinçli — geri dönüşsüz, önce yazma kendi başına doğrulanmalı). **`DELE` gerçek tornada hâlâ denenmedi**: ilk silme kendi gönderdiğimiz bir `ZZTEST…` dosyasıyla olmalı.
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
- **Kapılar:** `TRANSFER_DISABLED`, model kapısı (`sendPolicy`; plan her modelde çıkar, yalnız uygulama kapanır), onay metni, yalnız yönetici (`policy.js` varsayılan reddet; testli). **22TB'de 2026-10-30'dan beri AÇIK** (kullanıcı kararı, bkz. §3 "22B PC Simulator"): aşağıdaki test betiği henüz 22TB tornada çalıştırılıp doğrulanmadı, toplu gönderme o modelde hiç denenmedi — ilk denemede küçük ve geri alınabilir başla (tek müşteri klasörü).
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
10. Kütüphaneye ad: `[A-Za-z0-9_.() -]{1,40}` (**boşluk ve parantez 2026-11-11'de eklendi** — gerçek tornalarda
    aynı ürünün farklı takımla/bekleme süresiyle yapılan varyantı "SR001.001 (2)" gibi, Windows'un "aynı adlı
    dosya var" ekiyle adlandırılıyor; bilinçli olarak tam bir blacklist'e geçilmedi, yalnız gerçekte görülen bu
    iki karakter eklendi — Türkçe harfler gibi FTP'de hiç denenmemiş karakterler sessizce açılmadı), `ZZUP`/`ZZRB`
    ile başlamaz; dosya ≤ 1 MB, metin (NUL yok). `backend/programs/ftp-client.js` komut satırını düz template
    string ile kurduğu için (RETR/STOR/RNFR/RNTO) boşluktan sonraki her şey FTP'de zaten yol argümanı (RFC 959,
    kaçış/tırnaklama gerekmez); satır sonu karakterleri whitelist'te olmadığı için komut enjeksiyonu hâlâ imkansız.
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
  **MDIBlock de aynı şekilde gizlenir (2026-11-09, kullanıcı isteği):** tezgah MDI kipine girince `Status`/`MainProg` kökteki sistem/MDI tamponunu (§3, torna 8'de kökte görülen 7 dosyadan biri) gösterebilir — gerçek bir parça programı değil. `programOf`'taki tek `COMMON_SUBPROGRAM` sabiti `UNREADABLE_PROGRAMS` kümesine (`O9001`, `MDIBLOCK`) genişletildi; davranış O9001 ile BİREBİR aynı (ayrı satır açmaz, parça atfını bölmez, büyük/küçük harf duyarsız). Testi aynı iki dosyaya eklendi.
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
  - **Siparişler:** Mikro dosyasından KALKAN satır uygulamada KALIR (gizlenmez; "tam döküm" yüklemesi elle yapılır). **Ürün kartı alanları, MIKRO HER ZAMAN ANA VERİ KAYNAĞI (2026-11-09, kullanıcı kararı — bkz. aşağıdaki "DEĞİŞTİ" notu):**
    `importSiparis`: boş alan dolar; dolu alan **Mikro'nunkinden farklıysa** (dosyadaki güncel değer, karttaki güncel değerden farklı) ve kart elle düzenlenmemişse **HER senkronda** uygulanır — ayrıca "Mikro değişti mi" diye sorulmaz, yalnız "kart şu an Mikro ile aynı mı" sorulur. **Elle düzenlenmiş kartta** Mikro farkı uygulanmaz ama sonuçta "korunan" olarak listelenir. Tam boy de aynı kurala tabi (özel durumu kalmadı, bkz. aşağı).
    **DEĞİŞTİ (2026-11-09, kullanıcı kararı, gerçek veride bulundu — Nİ178.002):** eskiden "Mikro'nun **SON gönderdiği** değer" bir **anlık görüntüde** (`src_snapshot` sütunu) saklanıp yalnız O değerden FARKLI yeni bir Mikro değeri geldiğinde uygulanıyordu (planlanan çevrim gibi elle ayarlanmış değerlerin Mikro devreye girince toplu değişmemesi için, bilinçli bir korumaydı) — ama bu anlık görüntü fark uygulanmasa bile HER senkronda Mikro'nun o anki değerine sessizce yazılıyordu, bu yüzden kart **gerçekten** yanlış bir değerle (ör. brüt/net ters girilmiş, Nİ178.002'de olduğu gibi) sonsuza dek kilitli kalabiliyordu — "Mikro'dan yenile" hiçbir zaman düzeltemiyordu, çünkü "Mikro değişti mi" sorusu (kart değil, anlık görüntüyle kıyaslayarak) hep "hayır" çıkıyordu. Gerçek Mikro'ya karşı salt okuma ile doğrulandı (`STOKLAR`: brüt 0,5011/net 0,165 — doğru; kartta net 0,5011/brüt 0,165 — ters).
    Kullanıcının netleşen kararı: *"Mikro'dan yenile yapınca kartları komple tarasın, bir farklılık varsa değiştirsin, eski hâllerini korumasın; Mikro'yu her zaman ana veri kaynağı gibi düşünelim."* Yani **anlık görüntü mekanizması TAMAMEN KALDIRILDI** (`getSnapshot`/`setSnapshot`, `src_snapshot` sütunu artık yok/kullanılmıyor — `planning-db.js`); "ilk Mikro senkronunda toplu değişmesin" koruması da kaldırıldı, bilerek (pratikte yanlış/kilitli kartlar daha büyük risk sayıldı). Yeni kural **TEK satır:** kart ≠ Mikro + elle düzenlenmemiş → uygula. Bu, Nİ178.002 gibi önceden kilitlenmiş kartları da **GERİYE DÖNÜK, elle müdahale gerekmeden** bir dahaki "Mikro'dan yenile"de kendiliğinden düzeltir (snapshot'a değil, doğrudan Mikro'nun güncel değerine bakıldığı için). **Elle düzenlenmiş (`edited=true`) kartlarda değişiklik yok:** hâlâ korunur ve "korunan" olarak bildirilir.
    Kod: `importers.js` `importSiparis` (artık `mikroChanged`/`snap` yok, doğrudan `cur[f]` vs `v` kıyası), `planning-db.js` (`getSnapshot`/`setSnapshot` ve `src_snapshot` migration'ı silindi). Testi: `mikro.test.js` (2 test), `customer-code.test.js`, `planning.test.js`, `work-orders.test.js`, `xlsx.test.js` (eski "kart korunur" varsayımına dayanan testler yeni davranışa güncellendi — `xlsx.test.js`'teki çok-sayfalı yeniden yükleme testinde artık iki kaynağın (eski "iş emri CSV" ile Mikro/_SIPARIS) çeliştiği durumda **sırada en son işlenen — Mikro — kazanıyor**, bu da ayrıca doğrulandı). `npm test` 688/688 yeşil. Tarayıcıda gerçek sunucuya karşı henüz denenmedi (yalnız testlerle).
  - **GKK / ilk onay:** klasördeki form dosyaları `importFile` ile birleştirilir (var olan kayıt güncellenir, uygulamada açılan ve dosyada olmayan kayıt silinmez).
  - **Uçlar (yalnız yönetici):** `GET /api/planning/sources` (durum) · `PUT /sources/dir {dir}` · `POST /sources/refresh {force?}`. Testi `backend/planning/sources.test.js` (6), `customer-code.test.js` (7). Gerçek dosyalarla (geçici veritabanı) denendi: 3 dosya 0,8 sn'de işlendi, ikinci yenileme değişmeyen dosyaları atladı; demoda sentetik Mikro dosyasıyla yeni/değişen satır ve kart bulundu.
    **Denenmedi:** fabrika PC'sinde gerçek Mikro dosyasının yazıldığı klasörle; Mikro'nun dosyayı yazarken (yarım) okunması gerçek zamanlı; elle düzenlenmiş kart sayısı çok olduğunda "korunan" listesinin kullanılabilirliği.
- **MikroAPI — canlı okuma entegrasyonu, Excel'e PARALEL (2026-10-28, kullanıcı isteği; DEVAM EDİYOR, commit'siz):** yukarıdaki "Kaynak klasörü" Excel dosyasının YERİNE değil, YANINA: Mikro'nun kendi PC'sinde çalışan **MikroAPI** servisine
  (`http://<mikro-pc-ip>:8094/Api/apiMethods/<Endpoint>`, Mikro'nun kendi ürünü, tezgahlarla ilgisi yok) doğrudan SQL okuyarak sipariş + ürün kartı verisini otomatik senkronize etmek. İki kaynak paralel kalacak, hangisine güvenileceğine kullanıcı sonra karar verecek.
  **Kapsam dışı (kullanıcı kararı):** hammadde sarfiyat fişi YAZMA (`DahiliStokHareketKaydetV2` → `STOK_HAREKETLERI`) bu turda denenmeyecek, yönetici ile birlikte ayrı oturumda yapılacak — üretim verisine yazan bir çağrıyı riske atmamak için.
  - **Gerçek bağlantı bilgileri (bu oturumda doğrulandı, GİT'E ASLA GİRMEZ):** Mikro PC'si `192.168.1.112` (hostname `DESKTOP-QMSTE4D`), servis `0.0.0.0:8094`'te dinliyor (işlem adı "MikroAPI"). Başka bir PC'den (bu projenin geliştirildiği makine, `192.168.1.109`) çapraz-makine erişim de doğrulandı — Mikro PC'sinde 8094 için güvenlik duvarı kuralı EKSİKTİ (8083/8086/8087/8093/8096/8097 vardı, 8094 yoktu), kullanıcı `New-NetFirewallRule` ile kendisi ekledi (bu, benim yapabileceğim bir işlem değil — başka makine + güvenlik ayarı).
  - **Kimlik doğrulama:** her çağrıda gövde `{Mikro: {ApiKey, CalismaYili, FirmaKodu, KullaniciKodu, Sifre}, ...}`. **`Sifre` GÜNLÜK DÖNER:** `MD5("yyyy-AA-gg " + ham şifre)`, her çağrıda O ANKİ yerel tarihle yeniden hesaplanır (dünün hash'i işe yaramaz). **Hata HTTP 200 İÇİNDE de gelebilir:** `{"result":[{"StatusCode":...,"IsError":true,"ErrorMessage":"..."}]}` — hem HTTP durumunu hem gövde-içi `IsError`'ı kontrol etmek ŞART (API key boşken/yanlışken gerçek PC'de görüldü: "MikroAPI lisansınız yok!").
  - **`SqlVeriOkuV2`** tek okuma mekanizması (`{Mikro:{...}, SQLSorgu: "<SELECT ...>"}` → `result[0].Data[0].SQLResult1` = satır nesneleri dizisi). Mikro'nun API dokümantasyonunda Sipariş/Ürün Reçete kategorileri için ayrı liste ucu YOK, yalnız Kaydet/Sil/Düzelt (yazma) uçları var — okuma için serbest SQL zorunlu.
  - **Tablo keşfi (gerçek Mikro PC'sinde SELECT'lerle doğrulandı):** `SIPARISLER` (sipariş satırları, `sip_*` önek), `CARI_HESAPLAR` (müşteri, `cari_kod`/`cari_unvan1`), `STOKLAR` (temel stok kartı, `sto_*`; `sto_birim1_agirlik`/`sto_birim1_dara` bitmiş üründe dolu). **`URUNLER` ve `URUN_RECETELERI` (Mikro'nun "Ürün Reçete" modülü) TAMAMEN BOŞ** (WHERE'siz sorguda bile 0 satır) — Alen bu modülü hiç kullanmıyor; ürün kartı (hammadde/ağırlık/süre) verisi oradan GELMEZ.
    **Kullanıcı düzeltmesi, kritik:** ilk bakışta "ürün kartı Mikro'da yok" sonucuna vardım, kullanıcı **"ürün kartları verisi var mikroda ama başka tabloda olabilir ama kesinlikle var"** dedi — doğru çıktı. Gerçek kaynak: **`STOKLAR_USER`** (Mikro'nun kullanıcı-tanımlı özel alan tablosu, `Record_uid = STOKLAR.sto_Guid` ile bağlanır), içinde `URETIM_SURESI_SN`, `HAMMADDE`, `TAM_BOY`, `MAKINA`, `ALISIM` sütunları var — ofisin **kendisinin hâlihazırda kullandığı** "_SIPARIS" Excel raporunun SQL'i bunu zaten `SIPARISLER`+`STOKLAR`+`STOKLAR_USER` join'iyle okuyor (kullanıcı bu gerçek sorguyu paylaştı, tahmin değil).
  - **Mimari karar (önemli, bir sorguyu basitleştirdi):** ofisin kendi sorgusu `HM`/`BR`/`NT`/`SN`/`TAM BOY` sütunlarını AYNI `SIPARISLER` SELECT'inde veriyor — bunlar `backend/planning/importers.js`'in `importSiparis()` fonksiyonunun **zaten** ürün kartı "ipucu" olarak okuduğu birebir aynı başlıklar (`cell(idx,row,'HM'|'BR'|'NT'|'SN'|'TAMBOY')`, `importers.js:205,223-225`). Yani **ayrı bir "ürün kartı" sorgusu/senkronu GEREKMİYOR**: tek `SIPARISLER` sorgusu hem sipariş satırlarını hem ürün kartı ipuçlarını (boş alan dolar, dolu alan elle düzenlenmemiş karttaysa yalnız Mikro'da değiştiyse güncellenir kuralı aynen geçerli) tek seferde verir — Excel akışının zaten yaptığı gibi.
  - **Kullanılan Mikro SQL yardımcı fonksiyonları (ofisin sorgusunda, artık bizim sorgumuzda da):** `dbo.fn_CarininIsminiBul(0, sip_musteri_kod)` (müşteri adı), `dbo.fn_StokIsmi(sip_stok_kod)` (ürün adı), `dbo.fn_EvrNoForm(sip_evrakno_seri, sip_evrakno_sira)` (biçimli evrak no, "SPR-731" gibi). `WHERE sip_tip = 0` ("Talep" tipi siparişler) — benim ilk tahminim (`sip_iptal=0 AND sip_kapat_fl=0`) YANLIŞTI, ofis sorgusu kapanmış/iptal siparişi SQL seviyesinde eleMEZ.
  - **Dosyalar:** `backend/planning/mikro-client.js` (YENİ, tamam — saf HTTP istemci: `sifreHash`, `call(endpoint,body)` HTTP+gövde-içi hata birleşik, `sqlQuery(sql)`; Node'un yerleşik `fetch`'i, bağımlılık yok). `backend/planning/mikro.js` (YENİ, **SQL sorgusu ofis sorgusuna göre GÜNCELLENMEKTE** — `sources.js` ile aynı iskelet: `status()`/`refresh()`, `emptyTotals/emptyChanges/accumulate` `sources.js`'ten paylaşılıyor, kopyalanmadı). `backend/planning/importers.js#importParsed` export edildi (CSV/XLSX'ten geçmeden `{headers,rows}` ile doğrudan çağrılabilsin diye; davranış değişmedi).
  - **Ortam değişkenleri (plan, henüz `server.js`'e eklenmedi):** `MIKRO_API_HOST`, `MIKRO_API_PORT` (vars. 8094), `MIKRO_FIRMA_KODU`, `MIKRO_KULLANICI_KODU`, `MIKRO_SIFRE` (ham şifre), `MIKRO_API_KEY`, `MIKRO_CALISMA_YILI` — hiçbiri git'e veya koda varsayılan değerle GİRMEZ, yalnız `process.env.X` (`SOURCES_DIR` deseniyle aynı).
  - **YAPILDI (2026-10-28):** `mikro.js`'teki sorgu ofis sorgusuna göre son hâline getirildi; `planning.js`'e `this.mikro` bağlandı; `routes.js`'e `GET /api/planning/mikro` · `POST /mikro/refresh` · `POST /mikro/test` (yalnız yönetici); `dashboard/planning-mikro.js` (`planning-sources.js` deseni) + "MikroAPI…" düğmesi; `server.js`'e env değişkenleri; `mikro-client.test.js` (12) + `mikro.test.js` (8) — `npm test` 516/516 yeşil. Commit edilmedi.
  - **BR/NT sütun eşlemesi GERÇEK VERİYLE DOĞRULANDI (2026-10-28, SR040.013):** `sto_birim1_agirlik=0,0124` (12,4 g) · `sto_birim1_dara=0,0262` → `agirlik+dara=38,6 g`; kullanıcının verdiği gerçek değerler **net 12,40 g, brüt 39 g, üretim süresi 27 sn** (okunan `URETIM_SURESI_SN=27` tam eşleşti) ile örtüşüyor. **Yani BR (brüt) = `sto_birim1_agirlik + sto_birim1_dara`, NT (net) = `sto_birim1_agirlik`** — `mikro.js`'teki SQL bu yönde (bkz. yukarıdaki sorgu). Test aracı: `.claude/mikro.env` (GİT'E GİRMEZ, `.claude/` tamamen `.gitignore`'da) + `.claude/launch.json` → `backend-mikro-gercek` (gerçek kimlik bilgileri kullanıcıdan alındı, bir sonraki oturumda yeniden SORULMAYACAK — zaten kaydedildi).
  - **Tam akış gerçek sunucuya karşı UÇTAN UCA doğrulandı (2026-10-28):** `planning.mikro.refresh()` gerçek Mikro PC'sine karşı çalıştırıldı — **2.668 sipariş satırı + 511 ürün kartı, 1,3-1,6 sn, 0 uyarı.** Yolda GERÇEK bir kod hatası bulundu ve düzeltildi: SQL'de tarih sütununu `Sip_Tarihi` yerine yanlışlıkla `Siparis_Tarihi` diye takma adlandırmıştım — `headerKey()` `_` karakterini de sildiği için bu farklı bir anahtara katlanıyor (`SIPARISTARIHI` ≠ `SIPTARIHI`), `importSiparis()` tarihi hiç bulamıyor, **2.668 satırın TAMAMI tarihsiz** kalıyordu (sessiz hata, yalnız tek bir toplu uyarı mesajıyla görünüyordu: "N satırda sipariş tarihi okunamadı"). Düzeltme: `AS Sip_Tarihi` (`mikro.js`). Testteki aynı hata da (`mikro.test.js`'in `satir()` fixture'ı) düzeltildi ve artık `orderDate`'i doğrudan doğrulayan bir satır var — bu sınıf hata bir daha sessizce geçmeyecek.
    Dashboard'da da gerçek admin oturumuyla denendi: Siparişler/Ürün kartları ekranlarında "Mikro'dan yenile" tıklanınca gerçek 928 sipariş/511 ürün kartı (bazıları birden çok satır) geldi, ikinci tıklamada "değişiklik çıkmadı" dedi (idempotent).
    **Sonuç: bu makinedeki `data/planlama.db` artık BOŞ DEĞİL — gerçek Alen Otomat sipariş/müşteri verisi içeriyor** (test için silinip yeniden oluşturuldu, kullanıcı onayıyla); aynı gün ayrıca **1194 gerçek iş emri** de eklendi (aşağıdaki "Eski iş emri geçişi" bölümüne bakın). Bundan sonraki oturumlar bunu bilmeli: artık "boş dev veritabanı" varsayımı YANLIŞ.
  - **"Mikro'dan yenile" siparişi OLMAYAN gerçek SR/Nİ kodlarını hiç getirmiyordu — ikinci, siparişten BAĞIMSIZ bir stok senkronu eklendi (2026-11-16, gerçek veride bulunan bir güvenlik açığından sonra):** yukarıdaki `SIPARIS_SQL` yalnız `SIPARISLER`'de satırı OLAN ürünleri getiriyordu; kullanıcı Klinger (.019) grubunda Mikro'da GERÇEKTEN var olan `SR004.019`/`SR005.019`'un ("DN40 ÇİFT TARAFLI NİPEL", "DN40 8 KÖŞE SOMUN") "Mikro'dan yenile"den defalarca sonra bile hiç gelmediğini fark etti. Salt okuma ile doğrulandı: bu ikisinin `SIPARISLER`'de hiç satırı yok (muhtemelen numune/stok kartı açılışı, hiç sipariş almamış) — "Mikro'dan yenile" kaç kere basılırsa basılsın bunları **asla** getiremezdi, bu bir hata değil tasarımın bilinen sınırıydı.
    **Bunun GÖRÜNÜM eksikliğinden daha ciddi bir yan etkisi vardı:** Numune Takip'in "yeni ürün kodu oluştur" akışı (`sample-tracking.js` `nextStockCode()`) yalnız yerel `products` tablosuna bakıyor; o tablo bu iki kodu hiç bilmediği için **sıradaki kodu YANLIŞ hesaplayıp Mikro'da ZATEN VAR olan `SR004.019`'u "sıradaki boş kod" diye önerebiliyordu** — gerçek bir numune açılıp bu kod Mikro'ya `StokKaydetV2` ile gönderilseydi, var olan gerçek bir ürünün kartı bozulabilirdi.
    **Çözüm: `mikro.js`'e ikinci, bağımsız bir sorgu (`STOK_SQL`) eklendi** — `SIPARISLER`'e hiç bakmadan, doğrudan `STOKLAR` (+ `STOKLAR_USER` join, aynı `HAMMADDE`/`URETIM_SURESI_SN`/`TAM_BOY` alanları) üzerinden, Alen'in kendi ürün kodu biçimine uyan (`sto_kod LIKE '__[0-9][0-9][0-9].[0-9][0-9][0-9]'` — SQL Server karakter sınıfıyla, `importers.js`'teki `PRODUCT_CODE` regex'iyle AYNI biçim: 2 harf + 3 rakam + nokta + 3 rakam) **HER** iptal/gizli olmayan stok kodunu okur ve `importIsEmri`'nin ('isemri' biçimi, iş emirleri listesi Excel'inin kullandığı AYNI "boş alan dolar, dolu alan Mikro'dan farklıysa elle düzenlenmemişse güncellenir" kuralı) ürün kartlarına işler — `SIPARIS_SQL`'den TAMAMEN BAĞIMSIZ, ikisi de her "Mikro'dan yenile"de çalışır, biri diğerini atlamaz/ezmez (aynı stok kodu ikisinden de gelirse ikinci geçiş yalnız "değişmedi" der, `importIsEmri`/`importSiparis`'in kendi idempotentliği sayesinde). `importIsEmri`'ye (daha önce yalnız 'siparis' biçiminin okuduğu) isteğe bağlı bir `TAM BOY` sütunu da eklendi (gerçek "PLANLANAN" Excel sayfasında bu sütun yok, yalnız bu yeni Mikro-stok akışı için).
    **Bilinçli sınır:** siparişi hiç olmayan bir kod için müşteri bilgisi (hangi müşteri grubuna ait olduğu) bilinemez — `STOKLAR`'ın kendisinde müşteri tutulmuyor, yalnız `SIPARISLER`'de var; `MÜŞTERİ KODU` sütunu boş gelir, `importIsEmri`'nin var olan `customerCodeFromName` düşümüyle (ürün adından türetme) doldurulmaya çalışılır, siparişi gelince `importSiparis` zaten düzeltecektir.
    **Gerçek Mikro'ya karşı salt okuma ile doğrulandı:** yeni `STOK_SQL` Klinger (.019) grubunda 5 satır (SR001-005.019) döndü, **SR004/SR005.019 dahil**, tam hammadde/ağırlık/süre/tam boy değerleriyle. Testler: `mikro.test.js`'e 2 yeni test (siparişi hiç olmayan kodun işlenmesi — gerçek SR004/SR005.019 bulgusu; aynı ürün hem siparişten hem stok senkronundan gelirse çakışmaması) + mevcut testlerin mock'u iki ayrı sorguyu ayırt edecek şekilde güncellendi (`kur(rows, stokRows)`), `npm test` 766/766 yeşil. **Tarayıcıda gerçek "Mikro'dan yenile" tıklamasıyla henüz denenmedi** (yalnız doğrudan SQL ile ve birim testleriyle doğrulandı) — bir sonraki "Mikro'dan yenile"de SR004/SR005.019'un gerçekten göründüğü dashboard'dan teyit edilmeli.
  - **Arayüz (2026-10-28, kullanıcı isteği): "Mikro'dan yenile" artık Siparişler ve Ürün kartları sekmelerinde BİRİNCİL düğme** (`dashboard/planning-view.js`, mor/dolu buton), **"Kaynak dosyadan yenile" (Excel) ikincil** düğme olarak yanında durur — Excel akışı KALDIRILMADI, yalnız öncelik değişti (bu iki sekmede Mikro'nun SIPARISLER sorgusu zaten ikisini de verdiği için). GKK/ilk onay/iş emirleri/program eşleme sekmelerinde değişiklik yok (Mikro oraya veri vermiyor, Excel hâlâ birincil). Ayrı "MikroAPI…" bağlantı-testi penceresi (`openMikroDialog`) KALDIRILDI — gereksizdi, "Mikro'dan yenile" kendi hata mesajını zaten gösteriyor.
  - **Installer, Mikro ortam değişkenlerini HİÇ BİLMİYOR (2026-10-28'de fabrika PC'sinde bulundu):** `kurulum/kurulum.ps1` backend görevini (`CNC Telemetri - Backend`) `node.exe backend\server.js --log ...` ile kaydediyor, **`--env-file` yok** — `MIKRO_*` değişkenleri yalnız geliştirme makinesindeki `.claude/mikro.env`'de duruyordu (gerçek kuruluma hiç dahil edilmedi). İlk gerçek kurulumda "MikroAPI yapılandırılmadı" hatasıyla fark edildi. **Elle düzeltme (uygulandı, 2026-10-28, fabrika PC'si):** `C:\CNC-Telemetri\data\mikro.env` oluşturuldu (6 değişken), `Set-ScheduledTask` ile backend görevinin argümanının başına `--env-file "C:\CNC-Telemetri\data\mikro.env"` eklendi, görev yeniden başlatıldı. `data\` klasörü güncellemede silinmediği için bu dosya bir dahaki Setup.exe kurulumunda da kalıcı.
    **Kullanıcı kararı: bir sonraki installer sürümünde bu GÖMÜLÜ olacak** (kurulum sırasında elle `Set-ScheduledTask` düzeltmesi gerekmeyecek) — bkz. §10 "Sıradaki işler".
  - **MikroAPI kimlik bilgileri ve yazma artık installer'a gömülüyor (2026-10-29, YAPILDI; v1.0.0 ile ilk kez paketlendi):**
    - **`kurulum/kurulum.ps1` düzeltildi (yapısal, HER kurulumda geçerli):** backend görevi artık HER ZAMAN `--env-file "<ProjeKok>\data\mikro.env"` ile kaydediliyor (eskiden hiç verilmiyordu). `data\mikro.env` yoksa (ilk kurulum, gömülü kaynak da yoksa) **boş** oluşturulur (Node `--env-file` olmayan dosyada hata verir, boşsa sorun değil — MikroAPI "yapılandırılmadı" sayılır, sunucu yine açılır); zaten varsa (güncelleme ya da daha önce elle dolduruldu) **dokunulmaz** (mevcut yapılandırma korunur).
    - **`installer/build-installer.ps1`'e yeni parametreler:** `-MikroEnvFile <.env yolu>` (verilmezse depo kökündeki `.claude/mikro.env` otomatik aranır — Syntec'in Downloads'ta otomatik aranmasıyla AYNI desen) ve `-MikroWriteEnabled` (anahtar; verilirse gömülen dosyaya `MIKRO_WRITE_ENABLED=1` satırı eklenir). Bulunan dosya `installer\payload\kurulum\mikro.env.govde` olarak pakete yazılır (BOM'suz UTF-8 — `Set-Content -Encoding utf8`'in BOM eklediği ve Node `--env-file`'ı bozduğu 2026-10-28'de fabrika PC'sinde yaşanmıştı, aynı hataya düşülmedi); `kurulum.ps1` bunu İLK kurulumda `data\mikro.env`'e kopyalar. **Gerçek kimlik bilgileri yalnız derleme çıktısına (Setup.exe) girer, depoya ASLA girmez** (Syntec DLL'leriyle aynı kural — "depoya koyma, herkese açık paylaşma").
    - **v1.0.0 — "hepsi açık + Mikro gömülü + yazma AÇIK" ile ilk kez derlendi (2026-10-29, kullanıcı kararı: "artık bu hammadde tarafını proda alıyoruz"):** `build-installer.ps1 -KapaliBolumler @() -MikroWriteEnabled` (`.claude/mikro.env` otomatik bulundu). Duman testi "MikroAPI kimlik bilgileri gömüldü ... yazma: AÇIK" diye doğruladı. **Sürüm 0.19.0'dan 1.0.0'a yükseltildi** (kullanıcı kararı, `package.json`).
    - **ÖNEMLİ — bilinen sınırlar, kuruluma giderken akılda tutulmalı:** `MIKRO_WRITE_ENABLED=1` artık gerçek kurulumda AÇIK geliyor — Hammadde ekranındaki "Depolar arası sevkiyat" ve "Virman fişi kes" düğmeleri artık GERÇEKTEN Mikro'ya yazar (önizleme değil). Bugüne kadar doğrulanan: transfer (1 kg) ve virman **ÇIKAN** yönü (1 kg), ikisi de `sth_tutar=0` ile. **Hiç denenmeyenler:** virman **GİREN** yönü, `sth_tutar`'ın gerçek maliyet muhasebesine etkisi (0 kabul edildi ama "doğru" değer bu mu belirsiz), büyük miktarlar, farklı hammaddelerin tamamı. Fabrika PC'sine kurulmadan önce bu sınırların yönetici/ustalara anlatılması gerekebilir.
    - **v1.0.2 — "bitmiş ürün depo akışı" ELLE KAPALI olarak derlendi (2026-11-04, kullanıcı kararı):** aynı gün GİRİŞ/TRANSFER/ÇIKAN üçü de gerçek Mikro'ya karşı doğrulandı (yukarıya bakın) ve paketleme→Merkez sevki otomatikleşti, AMA fabrika PC'si henüz üretim sahasına inmedi — paketleme orada kullanılmadığı için bu akış açık kalırsa Geçici depoda paketlenmeyi hiç bekleyen bir "hayalet stok" birikir. `build-installer.ps1 -KapaliBolumler @() -MikroWriteEnabled` (yine `.claude/mikro.env` otomatik bulundu; **`-ProductDepotEnabled` BİLEREK verilmedi** — bkz. §6 "Bitmiş ürün depo akışı" > "AYRI AÇMA/KAPAMA KAPISI"). Duman testi doğruladı: `"MikroAPI kimlik bilgileri gömüldü ... yazma: AÇIK - bitmiş ürün depo akışı: KAPALI (fabrika PC henüz sahada değil)"`, `"kapalı bölümler paketlenmiş sunucuda doğru: yok (hepsi açık)"`. **Sürüm 1.0.1'den 1.0.2'ye yükseltildi** (kullanıcı kararı, `package.json`). Çıktı: `installer\output\CNC-Telemetri-Kurulum-1.0.2.exe`, 84,3 MB, SHA256 `2399E20F5502CD64`, 11TB + 22TB destekli — bu makinede uçtan uca derlenip duman testinden geçti, **fabrika PC'sine henüz kurulmadı**. Paketleme sahada başlayınca bir sonraki pakette `-ProductDepotEnabled` eklenip bu akış açılacak.
    - **v1.0.3 (2026-11-09):** Hurda Girişi + EYS.LS.018 alanları, Ölçüm Cihazları Takip ve bitmiş ürün depo akışı düzeltmeleri eklendikten sonra aynı bayraklarla (`-KapaliBolumler @() -MikroWriteEnabled`, `-ProductDepotEnabled` hâlâ verilmedi) yeniden derlendi. Çıktı: `CNC-Telemetri-Kurulum-1.0.3.exe`, fabrika PC'sine henüz kurulmadı.
    - **v1.0.4 (2026-11-11):** Bakım (EYS.FR.016 + Bakım Sicil Kartları, §6 "Bakım") eklendikten VE kütüphane program adı kuralı boşluk/parantez kabul edecek şekilde genişletildikten sonra (§6 "Program kütüphanesi ve aktarım" madde 10) aynı bayraklarla derlendi. Çıktı: `CNC-Telemetri-Kurulum-1.0.4.exe`, 84,3 MB, SHA256
      `c4274e5cf337d63ad18537f06c62f7d2dcefc21b2bc9a56e14c7f2026b551ecb`, duman testinden geçti (11TB + 22TB, ajan her iki Syntec DLL ailesini de yüklüyor, kapalı bölüm yok, MikroAPI yazma açık, bitmiş ürün depo akışı hâlâ kapalı). **Fabrika PC'sine henüz kurulmadı** — kullanıcı bu kurulumu fabrikaya götürüp kuracak.
    - **v1.0.5 (2026-11-16):** Hurda Girişi/Numune/Karantina-depo Mikro hata düzeltmeleri (kod incelemesinde bulunan), Bakım + Numune hammadde/teknik resim seçimi, kütüphane adı beyaz listesi, ürün kodu kırpma + sipariş satırı arama vurgusu, yazdırma önizleme pencerelerinin kaydırılamaması ve numune akışının `StokKaydetV2`/`KayitKaydetV2` düzeltmesi (§6 "Tezgaha bağlama + YENİ ürün kodu oluşturma" sonu) biriktikten sonra aynı bayraklarla (`-KapaliBolumler @() -MikroWriteEnabled`, **`-ProductDepotEnabled` kullanıcı kararıyla hâlâ verilmedi** — bitmiş ürün depo akışı ikinci bir emre kadar kapalı üretilecek) derlendi. Çıktı: `CNC-Telemetri-Kurulum-1.0.5.exe`, 84,3 MB, SHA256 `C0480D07343C77CC`, duman testi aynı şekilde doğruladı ("...bitmiş ürün depo akışı: KAPALI (fabrika PC henüz sahada değil)"). **Fabrika PC'sine henüz kurulmadı.**
    - **v1.0.6 (derlenmiş ama bu dosyaya hiç yazılmamış — şimdi geriye dönük not düşülüyor):** Paketleme Listesi (EYS.LS.005), Teknik Resim Takip müşteri filtresi, esnek rol sistemindeki Mikro/karantina-depo düzeltmeleri ve Bakım/Numune takip eklemeleri biriktikten sonra derlenmiş (`CNC-Telemetri-Kurulum-1.0.6.exe`, 84,4 MB). Aynı bayraklar. Sonraki derlemede (v1.0.7) `installer\output\` temizlendiği için bu dosya artık diskte yok, yalnız bu not kaldı. **Fabrika PC'sine kurulup kurulmadığı bu oturumda bilinmiyor.**
    - **v1.0.9 (2026-11-19, kullanıcı isteği "niye tesseractı gömmedin installer a onu da koy öyle hazırla"):** Tesseract OCR installer'a gömüldü (`runtime\tesseract\` — `runtime\python\` deseniyle AYNI): `installer/build-installer.ps1` `tesseract.exe`'nin PE import tablosundan yalnızca çalışma zamanının kullandığı yerel DLL'leri toplar (`TesseractBagimliDosyalar`: 34 dosya, ~46 MB — eğitim araçları ve 33 MB ICU hariç), `tur`/`eng`/`osd.traineddata` + `configs`/`tessconfigs` + `LICENSE`/`TESSERACT-NOTICE.txt` ile pakete koyar (`cnc-telemetri.iss` `runtime\*` üzerinden kurar). `backend/planning/ocr.js`: `tesseractBin()` önceliği `TESSERACT_BIN` > `runtime\tesseract\tesseract.exe` > bilinen kurulum yolları > PATH; gömülü ikili çalışırken `TESSDATA_PREFIX` paketteki `tessdata`'ya sabitlenir (`runOpts`). Duman testi `tesseract --list-langs` (tur/eng/osd), `ocr.js#tesseractBin()`'in paket içi yolu seçtiğini ve gerçek TIFF üzerinde `-l tur+eng --psm 1 tsv` çalıştığını doğruladı; ek olarak paketteki `payload\runtime\node.exe` ile gerçek taranmış `2189_001.pdf` sayfa 0'da 239 kelime okundu. `package.json` 1.0.8 → 1.0.9; `npm test` 890/890 yeşil. Aynı bayraklarla (`-MikroWriteEnabled`, bölümler hepsi açık, `-ProductDepotEnabled` verilmedi) derlendi. Çıktı: `installer\output\CNC-Telemetri-Kurulum-1.0.9.exe` (102,2 MB, SHA256 `46E278F0A45AF44E`, 11TB + 22TB). **Fabrika PC'sine henüz kurulmadı.**
    - **v1.0.8 (2026-11-19, kullanıcı isteği "installer üret gidip aşağıya kuralım"):** Sipariş PDF okuma düzeltmeleri + SiparisKaydetV2 yazma akışı + Mikro sipariş testi sonrası derlendi: `pdf-table.js` — **çok satıra yayılan kalemler çapa (adet/tarih satırı) etrafında birleştirilir** (`mergeMultiLineRows`; gerçek Konveyör SAP formu: bir kalem 3-4 satır, 48 çöp satır → 11 doğru kalem), iki çapa arası **en büyük dikey boşluktan** bölünür, sayfa sonunda yarım kalan kalem `carry` ile sonraki sayfanın ilk satırına eklenir (`importPdf`), "No" sütunu satır numarası sayılır (`lineNo`), "Malzeme/Numarası" iki satırlı başlığı tanınır, pencere eşleşmesi alt-pencerenin x'ine yanlış oturmaz (Miktar sütunu Pyp Öğesi'ne kayıyordu); HAVANA'nın "500,00Adet" açıklamasından adet çıkarılır; ürün tanımı (kod/açıklama) olmayan OCR gürültü satırları taslak sayılmaz. **Gerçek Mikro testi (2026-11-19):** Konveyör 4100018539 PDF'i → taslak → 11 kalem, müşteri `120.10.0011` (ürünlerin sipariş geçmişinden), `TEST-4100018539` belge no'su ile `SPR-755` olarak GERÇEK yazıldı (`StatusCode:200`, geri okumada 11 satır, 471.878,40 TL; PDF ile fiyat/tutar/tarih birebir). Mikro'daki mevcut `SPR-747` (aynı sipariş, 11.11'de elle girilmiş) ile 11 kalemde stok kodu/fiyat/tarih tuttu; **adet 3 kalemde farklı** (SR132.011 290↔280, SR098.011 2291↔1000, SR091.011 600↔500 — PDF "Revizyon 01" olabilir, revizyon akışının konusu). **SPR-755 test kaydı kullanıcı tarafından Mikro'dan silindi.** **Öğrenilen:** yerel `products` kartları Mikro'dan eski kalabilir (1. kalem `1050600045` yerelde yoktu ama Mikro'da `SR132.011`) → eşleşmeyen satır yazılmadan önce "Mikro'dan yenile" ya da stok kodu elle verilir (`updateLine({stockCode})`). Aynı bayraklarla (`-MikroWriteEnabled`, bölümler hepsi açık, `-ProductDepotEnabled` verilmedi) derlendi; `package.json` 1.0.7 → 1.0.8; testler yeşil (889). Çıktı: `installer\\output\\CNC-Telemetri-Kurulum-1.0.8.exe`. **Fabrika PC'sine kurulumu kullanıcı yapacak.** **Hâlâ eksik:** Tesseract installer'a gömülü DEĞİL (taranmış PDF fabrikada çalışmaz), taranmış PDF OCR kalitesi zayıf (2189_001: 18 satırdan yalnız 1'i doğru), mükerrer mail tespiti/revizyon eşleştirmesi/mail bağlantısı.
    - **v1.0.7 (2026-11-18, kullanıcı isteği "installer üret"):** v1.0.6'dan sonra birikenlerle derlendi: ürün tanıtım kartında "Ek işlem var mı?" artık YIKAMA/KURUTMA/TAVLAMA kutularını kilitlemiyor (bkz. yukarıdaki "DÜZELTME" notu), Fiyat çalışması kaydettikten sonra da düzenlenebiliyor, **İlk onay etiketi** (A5 yapışkan etiket, numara alınca otomatik popup+yazdırma; bu sırada `listApprovals()`'ın CNC NO'yu hiç hesaplamadığı gerçek bir hata da bulunup düzeltildi — bkz. "İlk onay etiketi" bölümü) ve duruş nedeni **"Ürün değişikliği" (D1) artık verimlilik hesabından çıkarılıyor** (bkz. §6 "E aşaması" altındaki 2026-11-18 notu). Aynı bayraklarla (`-MikroWriteEnabled`, `-KapaliBolumler`/`-ProductDepotEnabled` varsayılan — hepsi açık, bitmiş ürün depo akışı hâlâ kapalı) derlendi. Çıktı: `installer\output\CNC-Telemetri-Kurulum-1.0.7.exe`, 84,4 MB, SHA256 `435DB77B98D552EE`, duman testi geçti (11TB + 22TB, kapalı bölüm yok, MikroAPI yazma açık, bitmiş ürün depo akışı kapalı). **Fabrika PC'sine henüz kurulmadı.**
  - **"TALAŞ" seri no'lu satırlar sipariş sayılmaz (2026-10-28, kullanıcı isteği):** `SIPARISLER` tablosunda `sip_tip = 0` filtresi müşteri siparişleriyle AYNI yerde **hurda pirinç talaşı satışı belgelerini de** döndürüyor (seri `TALAŞ`/`TALAŞ1`, stok kodu `PR-001` "PİRİNÇ TALAŞI"; gerçek Mikro'da 232 kayıt, 2026-10-28'de bulundu). `mikro.js`'teki `SIPARIS_SQL`'e `AND s.sip_evrakno_seri NOT LIKE 'TALA%'` eklendi; bu seri SİPARİŞ EKRANINDA hiç görünmez. **Mikro'da başka "gerçek sipariş olmayan" seri olup olmadığı bilinmiyor** (yalnız TALAŞ bulundu/doğrulandı) — yeni bir seri fark edilirse aynı WHERE'e eklenir.
  - **İş emirleri listesinde durum = satır rengi (2026-10-28, kullanıcı isteği):** `dashboard/planning-workorders.js` satır sınıfı artık dört durumu da ayırt eder (`pl-waiting`=sarı/planlandı, `pl-running`=mavi/üretimde (zaten vardı), `pl-done`=yeşil/bitti, `pl-cancelled`=soluk-üstüçizili/iptal (zaten vardı); CSS `styles.css`). **Renk TEK BAŞINA değil**, durum hücresindeki ikon+etiketi (`woStatusChip`) pekiştirir (CLAUDE.md §7 kuralı korundu); `WO_STATUS.planlandi` çipi de `none`'dan `warn` (sarı) yapıldı. Gerçek tarayıcıda (geçici DOM enjeksiyonuyla, veri yazmadan) dört rengi de görsel doğrulandı.
  - **İş emri numarası tabanını ayarlama artık İş emirleri listesinde her zaman görünür (2026-10-28, kullanıcı isteği):** önceden yalnız "Yeni iş emri" penceresinde, taban HİÇ bilinmiyorsa çıkan bir uyarıydı (`sequenceNotice`); artık liste ekranının altında **her zaman** (yalnız yönetici) küçük bir kutu var — "Sıradaki iş emri numarası: X" + giriş kutusu + "Bu numaradan devam ettir" (`dashboard/planning-workorders.js` `drawSeq`, uç aynı: `PUT /api/planning/work-orders/sequence`). Şirkette hâlâ kullanılan eski numaralandırmayı BİR KEZ buraya girip devretmek için — "Yeni iş emri" içindeki eski uyarı da kaldırılmadı, ikisi aynı uca gider. **Numara yalnız yükseltilebilir** (sunucu zaten böyle doğruluyordu, değişmedi).
- **Eski (Excel) iş emri sisteminden BİR KEZLİK geçiş — satır rengi → durum (2026-10-28, kullanıcı isteği):** şirketin hâlihazırda kullandığı iş emirleri listesi Excel'i (PLANLANAN biçimi, aynı başlıklar — "ALEN KOD, MAMÜL ADI …") şimdiye kadar yalnız **ürün kartlarını** güncelliyordu (`importIsEmri`, stok kodu başına EN SON satır); satır başına gerçek bir **iş emri kaydı** hiç oluşturulmuyordu. `backend/planning/wo-import.js` (`importHistoricalWorkOrders`) bunu ekliyor: dosyadaki HER satır gerçek bir `work_orders` kaydı olur, **durumu satırın Excel'deki rengi belirler** (kullanıcı kararı): **yeşil (`92D050`) → bitti**, **kırmızı (`FF0000`) → iptal**, **başka her şey (sarı/renksiz) → planlandı**. "Bitti" satırlarda **ADET hem hedef hem SONUÇ sayılır** (eski sistemde gerçek üretilen adet forma elle yazılıyordu, bu dosyada ayrı bir "gerçekleşen" sütunu yok; kullanıcı onayı — sistem geçişinden sonra hedef/gerçekleşen yine makineden akacak). Tezgah **atanmaz** (MAKİNA NO sütunu "CNC"/"BCNC" gibi genel kategori, belirli bir tezgah değil; 0.16.0'daki "tezgahsız iş emri" desteği kullanılıyor). **İdempotent:** aynı ÜRETİM EMRİ NO (tam 10 haneli) zaten varsa satır atlanır — iki kez çalıştırmak güvenli.
  - **Renk okumak için `xlsx-read.js` genişletildi:** önceden yalnız hücre DEĞERİ ve tarih biçimini okuyordu; artık `styles.xml`'deki `<fills>`/`cellXfs` de ayrıştırılıyor ve her satırın **A sütunu** dolgu rengi (`"RRGGBB"`) `rowFills` olarak dönüyor (yalnız düz RGB dolgu; tema renkleri desteklenmiyor, `null` döner — tahmin edilmez). Gerçek dosyada (`2026 ÜRETİM EMİRLERİ.xlsx`, kullanıcının Downloads klasöründen) doğrulandı: 1216 gerçek satır (Excel'in gösterdiği 1.043.730 satır hayalet — 1.043.730. satırda unutulmuş bir "." kullanım alanını şişirmiş, zararsız, zaten atlanıyor), **1074 yeşil, 116 sarı, 4 kırmızı, 22 renksiz** (hepsi en yeni kayıtlar, henüz renklendirilmemiş → kullanıcı kararıyla sarı sayılıyor).
  - **Planning.importLegacyWorkOrders(buffer, {by, now})** (`planning.js`): tek giriş noktası — önce **mevcut, test edilmiş** `importParsed(db, parsed, 'isemri', ...)` ile ürün kartlarını günceller (değişiklik yok), sonra `importHistoricalWorkOrders` ile iş emri kayıtlarını oluşturur. Yalnız `.xlsx` kabul eder (renk bilgisi CSV'de yok). Uç: `POST /api/planning/work-orders/import-legacy` (ham `.xlsx` gövdesi, yalnız yönetici). Dashboard: İş emirleri listesinin altında **"Eski iş emirlerini içeri aktar (bir kerelik)…"** düğmesi (`dashboard/planning-workorders.js` `openLegacyImportDialog`; "Kaynak dosyadan yenile"nin yanındaki mevcut `openImportDialog` deseniyle aynı yükleme mekaniği).
  - **GERÇEK dosyayla uçtan uca denendi (2026-10-28, bu makinenin `data/planlama.db`'si):** 1193 iş emri oluşturuldu (**1070 bitti · 119 planlandı · 4 iptal**), ürün kartları 3 yeni + 294 güncellendi, ~25 satır geçersiz ürün kodu yüzünden atlandı (ör. "1,5 9", "0", uzak "." satırı — kaynak dosyadaki ÖNCEDEN VAR OLAN veri sorunları, içeri alma hatası değil). Sıra tabanı (`seq_floor`) otomatik **1198**'e yükseldi (dosyadaki en büyük numara), yani sıradaki YENİ iş emri `2026001199`'dan başlıyor. **Tek çakışma:** "2026000001" numarası kullanıcının kendi test iş emriyle (siteyi denerken oluşturdu) ÖNCEDEN alınmıştı, bu yüzden Excel'deki gerçek "2026000001" satırı atlandı (idempotent koruma beklendiği gibi çalıştı) — **kullanıcı kararı: önemli değil, gerçek kurulum fabrika PC'sinde BOŞ bir veritabanına yapılacağı için bu çakışma orada olmayacak.**
  - **Testler:** `backend/planning/wo-import.test.js` (7, sentetik `{headers,rows,rowFills}` ile çekirdek kurallar: renk→durum, idempotentlik, seq_floor, tezgahsız) · `backend/planning/legacy-import.test.js` (4, GERÇEK `.xlsx` tamponuyla uçtan uca — `test/xlsx-fixture.js`'e dolgu/renk desteği eklendi, stil 5=yeşil/6=kırmızı, var olan testler etkilenmedi). `npm test` 527/527 yeşil.
  - **Tarayıcıdan dosya yükleyerek DENENMEDİ** (bu oturumun tarayıcı aracında native dosya seçici sürülemedi — yalnız HTTP uca ham bayt göndererek test edildi, ki bu tarayıcının kendi gönderdiğiyle birebir aynı istek). **Fabrika PC'sinde gerçek kullanıcı tıklamasıyla henüz denenmedi.**
  - **Sınırlar:** yalnız bu dosyanın "PLANLANAN" biçimini tanır (farklı bir Excel düzeni için `detectFormat`'ın tanıdığı başlıklar gerekir); kaynak dosyadaki hatalı/eksik satırlar (geçersiz ürün kodu, geçersiz iş emri no) sessizce atlanır ve uyarıda listelenir, düzeltilmez; kırmızı dışındaki "iptal" anlamına gelebilecek başka bir renk şeması varsa (bu dosyada yoktu) tanınmaz.
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
  **Müşteri koduyla tek adaylı önerilerin de toplu onayı (2026-11-17, kullanıcı isteği):** stok koduyla birebir tutanların yanına **ikinci bir "toplu onayla" düğmesi** eklendi — "Müşteri koduyla tutan N öneriyi onayla". `confirmExactSuggestions({by, kind})` artık `kind` parametresi alıyor (`'kod'` varsayılan = eski davranış DEĞİŞMEDİ, `'musteri-kodu'` verilince müşteri koduyla eşleşen ama **tek adaylı** (`suggestions.length===1`) öneriler aynı şekilde toplu onaylanır — birden çok aday varsa (aynı müşteri kodu birden çok ürün kartında) o satır bu toplu onaydan geçmez, elle seçilir). Uç aynı (`POST /api/planning/programs/confirm-exact`), gövdeye isteğe bağlı `{kind}` eklendi; geçersiz `kind` 400. Testi `planning.test.js` (yeni test + HTTP assertion). **Tarayıcıda gerçek dev sunucusuna (gerçek 520 ürün kartı, 19 müşteri-koduyla tek adaylı öneri) karşı denendi:** düğme tıklanınca 19 program TEK TIKLA eşlendi (eşli: 0→19, öneri: 19→0), düğme kayboldu; bu gerçek eşlemeler kalıcı olarak dev veritabanında kaldı (doğru/kalıcı eşlemeler, geri alınmadı).
  **Birden çok program AYNI ürüne eşlenebilir (2026-11-11, kullanıcı sorusu üzerine doğrulandı):** `product_programs`
  tablosunda `program_key` PRIMARY KEY, `code_key`'in ise hiçbir benzersizlik kısıtı YOK — gerçek senaryo: aynı
  ürün farklı takımla/aralarına bekleme konularak iki ayrı programla ("SR001.001" ve "SR001.001 (2)") üretiliyor;
  ikisi de AYRI AYRI (Program eşleme ekranından, elle "ürün seç") aynı stok koduna eşlenir — kod değişikliği
  GEREKMEDİ, zaten destekleniyordu. Tek incelik: `program-map.js`'teki `CODE_LIKE` regex'i TAM eşleşme istiyor
  (`^XX###[-_. ]###$`), yani " (2)" soneki olan bir ad otomatik "kod" önerisini tetiklemez (ad çok farklıysa "ad"
  önerisi de gelmeyebilir) — bu durumda kullanıcı ürünü ELLE seçer, otomasyon eksikliği bir hata değil.
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

**İki saha bulgusu düzeltildi (2026-11-03, kullanıcıya iletilen geri bildirim):**
- **Mamul adı bazı ürünlerde eksik basılıyordu:** `createWorkOrder` ([planning.js:420](backend/planning/planning.js:420)) sipariş satırından açılsa bile HER ZAMAN ürün kartının (`product.name`) adını kopyalıyordu; kart adı Mikro'dan taze gelen sipariş satırı adından (`line.itemName`) **bayat/eksik** olabiliyor
  (gerçek örnek, SR055.011: kart `"PİRİNÇ SOMUN G1 SW37 16,5 CW617N 601275"`, aynı anki sipariş satırı `"1050100107 1235-963 PİRİNÇ SOMUN G1 SW37 16,5 CW617N 601275"` — baştaki iki kod kartta hiç yok). Kart adının neden güncellenmediği (Mikro senkron kuralı: "dolu alan yalnız değiştiyse güncellenir") ayrıca araştırılmadı — düzeltme
  yalnız iş emrinin KENDİ kopyasını, varsa daha taze olan satır adıyla kurar (`productName: line?.itemName || product.name`); ürün kartına dokunmaz, siparişsiz açılışta davranış aynı kalır. Testi `work-orders.test.js` ("MAMUL ADI o satırın taze adı").
- **Sipariş içinden ikinci iş emri açmak siparişi yeniden aratıyordu:** "Yeni iş emri" penceresinde (hem İş emirleri sekmesindeki düğme hem Siparişler sekmesindeki "İş emri aç" kısayolu AYNI `openNewWorkOrder`'ı kullanıyor) bir siparişin satırları açılıp bir satırdan forma girilince, "Geri" ve oluşturduktan sonraki "Kapat" her
  zaman boş arama ekranına (`drawPick()`) dönüyordu — aynı siparişten ikinci bir ürün için yeniden arayıp bulmak gerekiyordu. Düzeltme: seçili sipariş (`st.order`) artık state'te kalıcı; `drawPick()` döndüğünde `st.order` doluysa o siparişin satırlarını (TAZE, yeniden sorgulayarak) otomatik yeniden gösterir — ekstra bir
  "bu siparişten bir tane daha" düğmesi YOK, kullanıcının istediği gibi "Geri"/"Kapat" zaten oraya dönüyor. Siparişler sekmesinin tek-satır kısayolunda (`line` doğrudan verilmiş, `st.order` hiç dolmamış) "Kapat" eskisi gibi modalı kapatır — o akışta arka plan zaten kendi görünümünü (`onDone` ile) tazeliyordu, değişmedi.
  Tarayıcıda gerçek `data/planlama.db`'ye (SPR-731, Berg Metal, 4 satır) karşı denendi: satır seçip "Geri"ye basınca aynı 4 satır (güncel sayaçlarla) hiç yeniden aranmadan geri geliyor. Gerçek bir iş emri oluşturulmadı (üretim verisine dokunulmadı); `done-back` dalı yalnız kod okumayla doğrulandı, aynı `drawPick()`
  mekanizmasını paylaşıyor.

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
  **Kart tek tablo, 7 alan (6 + İLK ONAY NO, 2026-11-02) + 3 işlem satırı (0.17.1) + ÜRÜN RET tiki (0.17.3):** ALEN ÜRÜN KODU · MÜŞTERİ ÜRÜN KODU · TARİH · MAKİNA NO · İŞ EMRİ NO · GKK RAPOR NO · **İLK ONAY NO** · **YIKAMA / KURUTMA / TAVLAMA işaret kutuları** · **ÜRÜN RET kutusu** (+ küçük KART NO: paketleme kartı bununla bulur). Eski kâğıt kartın süreç tablosu (ek işlem, yazı yazma...) ve ret/yeniden işlem blokları kaldırıldı. A5 dikey. Tezgah başında kart bloğu: "N kart basıldı · son K0000XX", "Ürün tanıtım kartı bas", "Son kartı yeniden yazdır";
  iş emri bitince "Son biten iş emri" (24 saat) için de basılabilir. Uç: `POST /api/planning/work-orders/:no/cards {person?, gkkReportNo?}` (operatör + yönetici). Testi `cards.test.js`.
  **İLK ONAY NO (2026-11-02, kullanıcı isteği):** iş emrinin `firstApprovalNo` alanından **salt gösterim** olarak gelir (bu pencereden değişmez; "İlk onay numarası al" akışıyla yazılır). `planning-db.js` `#crateSelect` artık `w.first_approval_no`'yu da join eder, `#crateOut` `firstApprovalNo` döner — GKK rapor no ile aynı desen
  (kartın alanı, kasaya özel donmuş bir değer DEĞİL; iş emrinin O ANKİ değeri, kart yeniden basılsa/görüntülense bile günceli gösterir). Testi `cards.test.js`. Tarayıcıda gerçek sunucuya karşı uçtan uca denendi (önizlemede ve gerçek `POST .../cards` yanıtında görünüyor).

**"Ek işlem var mı?" zorunlu seçimi + ürün bazlı öğrenilen öneri (2026-11-06, kullanıcı isteği):** kart basma penceresine YIKAMA/KURUTMA/TAVLAMA kutularının ÜSTÜNE **"Ek işlem var mı?" (Var/Yok, zorunlu bir radyo çifti)** eklendi — **seçilmeden "Kartı oluştur ve yazdır" basılamaz** (buton devre dışı
kalır, `st.ekIslem === null` iken). "Yok" seçilince alttaki 6 kutu (3 işlem × gidecek/yapıldı) devre dışı kalır ve sıfırlanır; "Var" seçilince normal şekilde işaretlenebilir. ÜRÜN RET kutusu bu seçimden BAĞIMSIZ, her zaman açık (kalite kararı, ek işlem rotasıyla ilgisi yok).
- **Öğrenilen öneri — kullanıcının kendi gözlemi:** "SR001.001 ürününde yıkama yapılıyorsa hep yıkanıyor, o yüzden o kutu hep tikli gelsin, adam isterse kapatabilsin." Pencere açılınca bu ÜRÜNÜN (iş emrine değil, `work_orders.code_key`'e göre) **geçmişteki iptal edilmemiş kartlarından HERHANGİ biri**
  yıkama/kurutma/tavlama'ya "gidecek" işaretlenmiş mi diye bakılır (`planning-db.js` `cardStepDefaultsFor(codeKey)`: `SELECT MAX(wash_to), MAX(dry_to), MAX(anneal_to) FROM crates JOIN work_orders ... WHERE code_key = ? AND voided_at IS NULL`; `getWorkOrder()`'a `cardStepDefaults` alanı olarak eklendi,
  koli içi adet öğrenmesiyle — `packing.js` `setBoxQtyIfEmpty` — AYNI "bir kez görülürse öner" felsefesi). Geçmişte EVET görülmüşse pencere **"Ek işlem var mı?" otomatik "Var" ile ve o kutular TİKLİ açılır** (kullanıcı yine de kapatabilir — zorunlu seçim "boş kalamaz" demek, "değiştirilemez" demek değil);
  hiç geçmiş yoksa (ürünün ilk kartı) hepsi boş başlar, bilinçli bir seçim zorunlu kılınır. **"Yapıldı" (done) kutuları ÖNERİLMEZ** (yalnız "gidecek" — yeni basılan kartın bu işlemi henüz GEÇİRMEDİĞİ, yalnız geçirmesi GEREKTİĞİ bilgisi anlamlı; "yapıldı" geçmişten bugüne taşınacak bir bilgi değil).
- **Dosyalar:** `backend/planning/planning-db.js` (`cardStepDefaultsFor`), `planning.js` (`getWorkOrder()`'a ekleme), `dashboard/planning-card.js` (`openIssueCard`: `st.ekIslem`, `stepsBox()`'taki radyo çifti, `change` dinleyicisinde `ekIslem` özel dalı — tam yeniden çizim gerektirir, kutuların
  devre dışı durumu da değişir). Yeni CSS GEREKMEDİ (`.pl-steps-row`'un var olan 3 sütunlu grid'i bir etiket + iki seçenek şeklini zaten karşılıyor).
- **Doğrulama:** `backend/planning/cards.test.js`'e 2 test (ürünün ilk kartında öneri hepsi false; bir kartta `washTo` işaretlenince AYNI ürünün farklı bir iş emrinde öneri `washTo:true` gelir; **iptal edilen kart öneriye katılmaz**). `npm test` 659/659 yeşil. Tarayıcıda gerçek sunucuya karşı uçtan uca
  denendi: yeni bir ürünün ilk kartında "Ek işlem var mı?" boş + kutular pasif + "Kartı oluştur" devre dışı → "Var" seçilince kutular açıldı → "Yıkamaya gidecek" işaretlenip kart basıldı → AYNI ürün için AÇILAN İKİNCİ iş emrinde pencere "Var" + "Yıkamaya gidecek" ÖN TİKLİ ve buton zaten etkin geldi.
- **DENENMEDİ:** gerçek fabrika kullanımında birden çok ürünün gerçek yıkama/kurutma/tavlama geçmişiyle önerinin isabet oranı; "Yok" seçilip sonra "Var"a dönülünce önceki tikli kutuların (öneriden gelen) geri gelip gelmediği (şu anki davranış: "Yok" kutuları SIFIRLAR, "Var"a dönünce BOŞ başlar, öneri yeniden uygulanmaz — kasıtlı basit tutuldu, ayrıca sınanmadı).

**DÜZELTME: "Ek işlem var mı?" YIKAMA/KURUTMA/TAVLAMA kutularını artık KİLİTLEMİYOR (2026-11-18, kullanıcı isteği):**
yukarıdaki tasarım "Ek işlem var mı?" (Var/Yok) cevabına göre alttaki 6 kutuyu kilitleyip (Yok iken devre dışı +
sıfırlanmış) kullanıcıyı önce bu soruyu cevaplamaya zorluyordu. Kullanıcı bunun YANLIŞ bir varsayıma dayandığını
belirtti: **"o ek işlem denen yıkama vs değil miş, ek işlem yok seçilse bile yıkama vs seçebilmeli"** — yani "Ek
işlem" YIKAMA/KURUTMA/TAVLAMA ile aynı şey değil, ikisi bağımsız olmalı. `dashboard/planning-card.js`
`openIssueCard`: `stepsBox()`'taki `locked` değişkeni (checkbox'lara `disabled` ekleyen) kaldırıldı — 6 kutu artık
"Ek işlem var mı?" ne olursa olsun HER ZAMAN işaretlenebilir. `change` dinleyicisindeki "Yok seçilince kutuları
sıfırla" döngüsü de kaldırıldı — "Yok" seçiliyken işaretlenmiş bir kutu artık SİLİNMEZ. "Ek işlem var mı?" alanının
KENDİSİ (zorunlu Var/Yok seçimi, "Kartı oluştur" düğmesini seçilene kadar kilitleyen davranış) DEĞİŞMEDİ — yalnız
bu cevabın altındaki kutuları ETKİLEME DAVRANIŞI kaldırıldı. `ekIslem` zaten yalnız istemci tarafı bir UI
durumudur, sunucuya hiç gönderilmez (`POST .../cards` gövdesi yalnız `steps`/`reject`/`person`/`gkkReportNo`
taşır) — bu yüzden backend'de HİÇBİR değişiklik gerekmedi.
- **İzole bir test ortamında (gerçek sunucu süreci, geçici/boş `PLANNING_DB_FILE`, gerçek dev veritabanına HİÇ
  DOKUNULMADI) tarayıcıda uçtan uca denendi:** "Ek işlem var mı?" önce "Yok" seçildi (kutular hâlâ `disabled:false`
  doğrulandı), ardından "Yıkamaya gidecek" işaretlendi — "Yok" seçili KALDI, kutu işaretli kaldı, önizleme kartında
  YIKAMA satırı `is-on` sınıfıyla ✓ gösterdi; "Kartı oluştur ve yazdır" ile GERÇEK bir kart (K000001) basıldı ve
  API'den okunan kayıtta `steps.washTo:true` doğrulandı — "Ek işlem: Yok" iken bile yıkama kaydının gerçekten
  geçtiği teyit edildi. (Bu testte tarayıcı otomasyon aracı gerçek `window.print()` native yazdırma penceresinde
  takıldı — bilinen bir ortam sınırı, kod/akış hatası değil; kart zaten yazdırmadan ÖNCE sunucuya kaydedilmişti.)
  Test sunucusu/geçici veritabanı oturum sonunda tamamen silindi.
- **DENENMEDİ:** gerçek yazıcıdan A5 baskı; fabrika PC'sinde gerçek kullanım.

**Planlama yan menüsünde Tezgah başı ve Siparişler en üstte (2026-11-06, kullanıcı isteği):** `dashboard/planning-view.js` `NAV_LAYOUT`'ta `tezgahbasi` ve `siparisler` artık ayrı, tek başına girdiler olarak listenin EN BAŞINDA (`tezgahbasi` eskiden "Üretim" grubundaydı, `siparisler` eskiden "Ürünler" grubunun
ALTINDA tek başına bir girdiydi — konumu değişti, grup yapısı değişmedi). Diğer gruplar (Depo, Üretim, Kalite, Ürünler, Analiz) ve içerikleri AYNEN kaldı. Tarayıcıda doğrulandı.

**Numune kartı — aynı gün KALDIRILDI, yerine "Numune Takip" ekranı geldi (2026-11-02, kullanıcı kararı):** yukarıdaki satırda tarif edilen "ilk onay sonrası ayrı kart önizlemesi" fikri kullanıcının aynı oturumda verdiği ikinci bir talimatla terk edildi: onun yerine kendi listesi, durumu ve yazdırılabilir formu olan
kapsamlı bir **Numune Takip** ekranı istendi (bkz. §6 "Numune Takip (EYS.FR.012)"). `dashboard/planning-approvals.js`'teki `numuneCardHtml` fonksiyonu ve `createFirstApproval`'ın kart gösteren sürümü SİLİNDİ; "İlk onay numarası al" penceresi eskisi gibi yalnızca numarayı veren, "Tamam" ile kapanan basit bir
ekrana döndü. İlk onay akışı ile numune takibi artık tamamen ayrı iki ekrandır.
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

**Ölçüm cihazı (2026-11-02, kullanıcı isteği):** her ölçü satırı (karakteristik) artık isteğe bağlı bir **cihaz** taşır: Kumpas / Mastar / Kameralı Görüntüleme / Mihengir. "Ölçüleri tanımla/düzenle…" penceresinde satır başına seçim kutusu; ölçüm girişi tablosunda ve basılan föyde satır adının altında tolerans aralığının
yanında gösterilir (ör. "34,1 – 34,2 · Kumpas"). `backend/planning/measure.js` `DEVICES`/`DEVICE_LABEL`, `normalizePlan` satır başına `device` doğrular (listede değilse 400; boş = belirtilmemiş, `null`). `dashboard/planning-measure.js` aynı listeyi istemci tarafında tutar (ayrı dosya, elle eşitlenir — tek kaynak backend).
Tarayıcıda gerçek sunucuya karşı uçtan uca denendi (plan kaydı, giriş tablosunda "Kumpas"/"Mastar" etiketleri, API round-trip). Testi `measure.test.js`. **Gerçek kâğıt formla/yazıcıdan henüz denenmedi** (föydeki görünümü yalnız ekranda doğrulandı).

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

**G aşaması — hammadde depo akışı (Merkezi → Üretimde), SONRAKİ VERSİYON, 2026-10-28 kullanıcı tasarımı, HENÜZ UYGULANMADI:**
Yukarıdaki D aşaması sarfiyatı yalnız *hesaplıyor* ve Mikro'ya fişi **elle girildi** diye işaretletiyordu (gerçek Mikro yazması yok). Kullanıcı bunun yerine gerçek, otomatik bir depo akışı istiyor. Kullanıcının kendi tarif ettiği akış (birebir):

1. Mikro'da **yeni bir depo** açılacak: **"Üretimde"** (mevcut "Merkezi" deponun yanına; depoyu kim açacak/kodu ne olacak — aşağıdaki "Açık sorular"a bakın).
2. Bir iş emri **açılınca/planlanınca** (kullanıcı onayıyla seçilen tetikleme anı — aşağıya bakın), ürün kartına göre **öngörülen hammadde ihtiyacı** (zaten var olan `calc.js` `rawMaterial()` formülü: adet × brüt gramaj) **ön tahmin** olarak Mikro'da **"depolar arası transfer fişi"** ile Merkezi → Üretimde'ye taşınır (ör. 300 kg).
3. Üretim sırasında gerçek tüketim tahminden sapabilir (fazla/az üretim, hurda, hammadde bitene kadar devam vb.) — bu BİLİNÇLİ bir tahmin, kesin değil.
4. **İş emri bitince**: gerçek üretilen adede göre gerçek tüketim hesaplanır (D aşamasındaki `realConsumptionOf`/`material.js` zaten bunu yapıyor — tüm işlenen parça, numune/ayar/hurda dahil, sayaçtan). Gerçek tüketim ön tahminden **fazlaysa** (ör. 400 kg tuttu, 300 taşınmıştı), aradaki fark (100 kg) **ek bir transfer fişiyle** yine Merkezi'den Üretimde'ye taşınır. Gerçek tüketim ön tahminden **azsa** (ör. yalnız 250 kg kullanıldı, 50 kg fazla kaldı) — bkz. aşağıdaki karar.
5. Sonra, ayrı bir ekrandan (D aşamasındaki "Hammadde ve sarfiyat" ekranının **"Mikro sarfiyat fişi" bölümünün yerine geçecek** — artık elle "girildi" işaretlemek değil, **gerçek Mikro yazması**) Üretimde deposundaki hammaddeyi gerçekten düşen **sarfiyat fişi** kesilir (muhtemelen `DahiliStokHareketKaydetV2` → `STOK_HAREKETLERI`, henüz doğrulanmadı).

**Kullanıcıyla netleşen tasarım kararları (AskUserQuestion ile soruldu, 2026-10-28):**
- **Ön tahmin transferi NE ZAMAN tetiklenir: İş emri açılınca/planlanınca** (iş emri zaten hedef adet + hammaddeyi taşıyor, `rawMaterial()` zaten orada hesaplanıyor) — sipariş senkronize olur olmaz DEĞİL, iş emri üretime başlayınca da DEĞİL.
- **İş emri bitince ölçülen tüketim ön tahminden AZ çıkarsa:** sistem fazlalığı GÖSTERİR (ör. "50 kg fazla kaldı, geri taşınsın mı?"), **otomatik bir şey YAPMAZ** — kullanıcı onaylı bir düğmeyle karar verir (geri transfer mi, Üretimde'de mi kalsın).
- **Gerçek Mikro YAZMASI (transfer fişi + sarfiyat fişi) için önceki tur kuralı GEÇERLİ KALIYOR:** "sarfiyat yazmayı yönetici ile birlikte deneyeceğiz" kararı bu akış için de geçerli — tasarım/kod yazımı şimdi yapılabilir, **gerçek Mikro'ya ilk yazma denemesi yönetici ile birlikte** yapılacak (bkz. [[calisma-tarzi-tornaya-dokunma]] ile aynı temkinli yaklaşım, ama bu kez Mikro ERP için).

**Mikro arayüz pencereleri görüldü (2026-10-29, kullanıcı ekran görüntüsü gönderdi) — bunlar API uç adı/parametreleri DEĞİL, Mikro'nun masaüstü uygulamasındaki el ile giriş formları; alan yapısını netleştiriyor ama gerçek API çağrı şeklini vermiyor:**
- **"Depolar Arası Sevk Fişi" (pencere no 12500):** Evrak No, Tarih, Belge No, **Kaynak depo**, **Hedef depo** (üstte); tablo: Kodu, İsmi, Miktar, Br, Birim fiyat, Tutar, Açıklama; altta Toplam. Bu, "ön tahmin" ve "fark" transferleri için kullanılacak form — tek yönlü (kaynak → hedef), tek satırda bir stok kodu-miktar.
- **"Stok Virman Fişi" (pencere no 12810) = sarfiyat fişi:** Evrak No, Tarih, Belge No, **Depo** (TEK depo — transfer değil, o depo İÇİNDE giriş/çıkış); tablo: Stok kodu, İsmi, **Giren Çıkan** (yön sütunu), Miktar, Birim, Birim fiyat, Tutar; altta Giren tutar/Çıkan tutar/Fark. Üretimde deposundaki hammaddeyi gerçekten DÜŞEN fiş bu olmalı (satır "Çıkan" olarak girilir).
- **Hâlâ eksik (ekran görüntüsü bunu vermiyor, gerçek API uç adı/parametreleri için ayrıca gerekli):** bu iki pencerenin MikroAPI'deki karşılığı olan uç adı (muhtemelen `DahiliStokHareketKaydetV2` ya da farklı iki ayrı uç — "Depolar Arası Sevk Fişi" ile "Stok Virman Fişi" Mikro'da FARKLI evrak türleri/pencere numaraları (12500 vs 12810), muhtemelen FARKLI API uçları da var, TEK uç olduğu varsayılmamalı) ve JSON gövdesindeki alan adları (`Depo`/`KaynakDepo`/`HedefDepo`/`StokKodu`/`Miktar`/`GirenCikan` gibi alanların API'deki GERÇEK adları ekrandaki Türkçe etiketlerle birebir aynı olmayabilir). **Merkezi ve Üretimde depolarının kendi Mikro depo KODLARI** da hâlâ bilinmiyor (ekranda "Depo"/"Kaynak depo"/"Hedef depo" bir arama kutusu/kod alanı, gerçek değer görünmüyor).
- Gerçek yazma kodu bu bilgiler netleşmeden YAZILMAYACAK (önceki tur kararı geçerli — yönetici ile birlikte).

**API alan adları + gerçek örüntü DOĞRULANDI (2026-10-29, SALT OKUMA — hiçbir şey yazılmadı):** Kullanıcı ChatGPT'den bir araştırma özeti yapıştırdı (`DahiliStokHareketKaydetV2` hem virman hem transfer için kullanılıyor; `sth_tip`/`sth_cins` değer eşlemeleri iddia ediyordu) — bu özete körü körüne güvenmedim, önce Mikro'nun gerçek dokümantasyon sayfasını (`apidocs.mikro.com.tr`) kendim çektim, sonra `SqlVeriOkuV2` ile gerçek geçmiş kayıtları okudum.
- **Dokümantasyondan DOĞRULANAN gerçek istek gövdesi** (`POST /Api/apiMethods/DahiliStokHareketKaydetV2`): `{Mikro:{...,FirmaNo,SubeNo}, evraklar:[{evrak_aciklamalari:[{aciklama}], satirlar:[{sth_stok_kod, sth_miktar, sth_tutar, sth_cikis_depo_no, sth_giris_depo_no, sth_evraktip, sth_tip, sth_cins, sth_normal_iade, sth_evrakno_seri, sth_tarih, sth_cari_cinsi, sth_cari_kodu, sth_birim_pntr, sth_vergi_pntr, sth_vergisiz_fl, sth_isk_mas1, sth_isk_mas2, renk_beden:[...], user_tablo:[...]}]}]}`. **Tek satırda hem çıkış hem giriş depo no'su birlikte var** — "Depolar Arası Sevk Fişi" ekranındaki ayrı Kaynak/Hedef alanları API'de TEK satıra karşılık geliyor (iki ayrı satır değil). Dokümantasyon sayfası `sth_evraktip`/`sth_tip`/`sth_cins` değerlerinin ANLAMINI açıklamıyor — ChatGPT'nin iddia ettiği `cins=3→virman` örnek istekteki gerçek değerle (`cins="6"`) ZATEN çelişiyordu, bu yüzden değer eşlemelerine güvenilmedi.
- **Gerçek `DEPOLAR` tablosu (SELECT * FROM DEPOLAR, salt okuma):** yalnız 3 depo — **`dep_no=1` "MERKEZ DEPO"**, **`dep_no=2` "GEÇİCİ DEPO"**, **`dep_no=3` "HURDA DEPO"**. **"Üretimde" deposu Mikro'da HENÜZ YOK** (açık soru kesinleşti: yönetici Mikro ekranından yeni bir depo açmalı).
- **Gerçek `STOK_HAREKETLERI`'nden `sth_evraktip`/`sth_tip`/`sth_cins` dağılımı** (salt okuma, son günlerin gerçek kayıtları): en sık görülen iki kombinasyon — **`evraktip=2,tip=2,cins=6`** (5498 kayıt; örnek: evrak seri "ALEN", çıkış depo **2→** giriş depo **1**, yani FARKLI depolar arası) ve **`evraktip=6,tip=0,cins=3`** (5398 kayıt; örnek: evrak seri "ÜRT", çıkış=giriş depo **2**, AYNI depo). **Ayırt edici: çıkış/giriş depo numarasının aynı mı farklı mı olduğu** (üç alan BİRLİKTE anlam taşıyor, `cins` tek başına değil — ChatGPT'nin "cins=3 her zaman virman" iddiası eksikti, çünkü `cins=3` hem `evraktip=6,tip=0` hem `evraktip=6,tip=1` kombinasyonlarında görülüyor). **ÖNEMLİ: bu ALEN/ÜRT serili hareketler stok kodlarına göre (SR0xx.xxx, Nİ0xx.xxx) BİTMİŞ ÜRÜN hareketleri** (muhtemelen üretimden çıkan parçanın geçici depodan merkez depoya alınması) — **bizim planladığımız HAMMADDE Merkezi→Üretimde akışıyla AYNI SÜREÇ DEĞİL**, yalnız alan/kombinasyon mantığını gerçek veriyle doğrulamak için incelendi. Hammadde-özel bir evrak örüntüsü ayrıca aranmadı/bulunmadı.
- **Yöntem not (gelecekte tekrarlanabilir):** gerçek yazma denemeden önce `SqlVeriOkuV2` ile `STOK_HAREKETLERI`/`DEPOLAR` gibi tabloları salt okuma sorgulayıp ustaların Mikro arayüzünden GERÇEKTEN girdiği örnekleri incelemek, dokümantasyon + tahminden çok daha güvenilir — risk SIFIR (yalnız SELECT).
- **Hâlâ eksik (2026-10-29'da çözüldü, bkz. aşağıdaki "G aşaması uygulandı" bölümü):** hammadde Merkezi→Üretimde transferi ve nihai sarfiyat (stok virman) için kullanılacak TAM `sth_evraktip`/`sth_tip`/`sth_cins` üçlüsü — bu artık Mikro'nun RESMİ "Tablo Alan Yapıları" sayfasından (`apidocs.mikro.com.tr/tablo-alan-adlari/stok_hareketleri`) DOĞRULANDI, aşağıya bakın. `DepolarArasiSiparisKaydetV2` adlı AYRI bir uç da var (kullanıcının paylaştığı bir özette "depolar arası sipariş" için, transfer fişinden farklı bir süreç olduğu belirtiliyor) — bunun bizim akışla ilgisi olup olmadığı netleşmedi, kullanılmadı.

**`STOK_HAREKETLERI` alanlarının RESMİ anlamı — Mikro'nun kendi "Tablo Alan Yapıları" sayfasından DOĞRULANDI (2026-10-29, `apidocs.mikro.com.tr/tablo-alan-adlari/stok_hareketleri` — API örnekleri sayfasından (`/apis/stok/...`) FARKLI, ayrı bir referans bölümü; alan anlamlarını yalnız bu sayfa veriyor):**
- **`sth_tip`** (Hareket Tipi): `0=Giriş`, `1=Çıkış`, `2=Depo Transfer`.
- **`sth_cins`** (Hareket Cinsi): `3=Stok Virman`, `5=Sarf`, `6=Transfer`, `7=Üretim` (ayrıca Toptan/Perakende/Dış Ticaret/Fire/Fason/Değer Farkı/Sayım/Stok Açılış/İthalat-İhracat/Hal/Müstahsil/Kabzımal/Gider Pusulası gibi değerler de var; 14/15 kodları sayfada iki farklı anlamla ÇAKIŞIYOR, belgedeki bir tutarsızlık — bizim akışımızı etkilemiyor).
- **`sth_evraktip`** (Evrak Tipi, 0–18): **`2=Depo Transfer Fişi`**, **`6=Stok Virman Fişi`**, `7=Üretim Fişi` (diğerleri: 0 Depo Çıkış, 1 Çıkış İrsaliyesi, 3 Giriş Faturası, 4 Çıkış Faturası, 12 Depo Giriş, 13 Giriş İrsaliyesi…).
- **SONUÇ — iki kombinasyonumuz da teyitli:**
  - **Depolar arası sevkiyat (transfer):** `evraktip=2 (Depo Transfer Fişi) + tip=2 (Depo Transfer) + cins=6 (Transfer)` — üçü de RESMİ anlamıyla birebir "depo transferi" diyor; önceki gözlemsel tahminle (ürün hareketlerinden) AYNI çıktı, şimdi resmi olarak da doğrulandı.
  - **Sarfiyat (virman çıkışı):** `evraktip=6 (Stok Virman Fişi) + tip=1 (Çıkış) + cins=3 (Stok Virman)` — **önceki tahminimizde `tip=0` kullanmıştık, YANLIŞTI**: resmi listede `tip=0` Giriş, `tip=1` Çıkış. Gerçek veride (§"API alan adları" bölümü) gördüğümüz 570 hammadde "HM"/"HAMMADDE"/"ÜRT" satırının **hepsi `tip=1`** imiş — yani o satırlar sarfiyat/çıkış kaydıymış (önce "muhtemelen giriş/satın alma" diye yorumlanmıştı, YANLIŞ yorumdu; doğrusu: şirketin zaten kullandığı GERÇEK sarfiyat kaydı deseni buymuş). `sth_cins=5 "Sarf"` adı anlam olarak daha "doğru" görünse de şirketin gerçek verisinde HİÇ kullanılmamış (0 kayıt) ve hangi evrak tipiyle eşleştiği belgede yok — bu yüzden **kanıtlı olan `cins=3` (570 gerçek örnek + ekrana birebir uyan "Stok Virman Fişi" adı) tercih edildi**, `cins=5` denenmedi.
- **`mikro-stock.js` DÜZELTİLDİ (sarfiyat tip'i 0→1):** kod bu konuşmadan hemen sonra güncellenecek — bkz. aşağıdaki "G aşaması uygulandı" bölümünün "Bilinen hata, düzeltiliyor" notu.
- **Hâlâ eksik: `sth_tutar` (Hareket Tutarı, Float)** — resmi sayfa yalnız ad/tip veriyor, hesap mantığını (zorunlu mu, 0 kabul ediyor mu, maliyet yöntemine göre nasıl hesaplanıyor) açıklamıyor. Gerçek satırların HEPSİNDE büyük, sıfırdan farklı değerler var (ör. 2.378.600) — bu alanın maliyet muhasebesini etkilediğinden **TAHMİN EDİLMEYECEK**. Plan: yönetici Mikro arayüzünden KENDİSİ bir test virman/transfer fişi girsin (aynı test hammaddesiyle, 1 kg), biz salt okuma ile oluşan satırı okuyup gerçek `sth_tutar`/`sth_birimfiyat`/`sth_maliyet_*` değerlerini görürüz — tahmin yerine gerçek örnek.

**G aşaması — GERÇEK ilk yazma denemesi yapıldı (2026-10-29, yönetici onayıyla, 1 kg test, `HM617.AA30.00XYU18.00`):** Kod (`mikro-stock.js`, `routes.js`, `planning.js`) yazıldı ve ÖNİZLEME/okuma kısmı (`listDepots`, `searchMaterials`, `previewTransfer`, `previewVirman`) test edildi (9/9 test, ağsız). Gerçek yazma `MIKRO_WRITE_ENABLED` ortam değişkeniyle KAPALI (varsayılan); bu test tek seferlik bir betikle (`writeEnabled` enjekte edilerek, sunucunun gerçek anahtarına DOKUNULMADAN) yapıldı.
- **Depolar arası sevkiyat denemesi (MERKEZ DEPO=1 → REZERV HAMMADDE=4, 1 kg, `evraktip=2/tip=2/cins=6`): BAŞARISIZ** — Mikro `StatusCode:400, IsError:true` döndü, **`ErrorMessage` BOŞ** (hiçbir açıklama yok). Salt okuma ile doğrulandı: **hiçbir satır yazılmadı** (temiz red, yarım/hatalı kayıt kalmadı). Sebep muhtemelen eksik zorunlu alan (`sth_tutar` şüpheli, aşağıya bakın) — tip/cins kombinasyonu resmi dokümanla sonradan DOĞRULANDI, muhtemelen suçlu DEĞİL.
- **"REZERV HAMMADDE" deposu gerçek:** `dep_no=4`, `dep_adi="REZERV HAMMADDE"`, 2026-10-29 12:11:44'te açıldı (kullanıcı/yönetici Mikro ekranından elle açtı). Menü no'su (`dep_MenuNo="12810"`) "Stok Virman Fişi" ekranıyla eşleşiyor — bu depo Mikro'da virman ekranı üzerinden ilk kez kullanılmış/kaydedilmiş gibi görünüyor.
- **Mikro arayüz ekran görüntüleri doğrulandı (2026-10-29, kullanıcı ikinci kez gönderdi):** "Depolar Arası Sevk Fişi" (12500): Evrak No/Tarih/Belge No + Kaynak depo/Hedef depo + satır (Kodu/İsmi/Miktar/Br/Birim fiyat/Tutarı/Açıklama). "Stok Virman Fişi" (12810): Evrak No/Tarih/Belge No + TEK Depo + satır (Stok kodu/İsmi/**Giren Çıkan**/Miktar/Birim/Birim fiyat/Tutar) + alt toplam (Giren tutar/Çıkan tutar/Fark). Ekrandaki "Giren Çıkan" sütunu muhtemelen `sth_tip` alanına karşılık geliyor (0=Giren, 1=Çıkan) — tutarlı.
- **Sıradaki adım (DENENMEDİ, kullanıcıya soruldu):** yönetici Mikro arayüzünden KENDİSİ bir test fişi girsin (aynı hammadde, 1 kg) → biz salt okuma ile satırı okuyup gerçek `sth_tutar` davranışını öğreniriz → sonra API ile tekrar denenir. **Ağ trafiği yakalama (Fiddler vb.) ÖNERİLMEDİ**: Mikro'nun masaüstü uygulaması muhtemelen MikroAPI (HTTP, 8094) katmanını DEĞİL, veritabanına doğrudan bir istemci protokolünü kullanıyor — bu yüzden masaüstü trafiğini yakalamak API'nin beklediği JSON'u göstermeyebilir; salt-okuma SQL ile sonucu okumak daha güvenilir.
- **Kod düzeltmesi (YAPILDI):** `mikro-stock.js` `previewVirman`'da `sth_tip: 0` yazılmıştı, düzeltildi → **`sth_tip: 1`** (resmi listeye göre 0=Giriş, 1=Çıkış — sarfiyat=çıkış). `npm test` 537/537 yeşil.

**sth_tutar gerçek veriyle kontrol edildi (2026-10-29, salt okuma, 20 örnek):** `sth_tutar = sth_miktar × sth_birimfiyat` formülü **15/20 (%75)** satırda birebir tutuyor; 5/20 tutmuyor (döviz kuru alanları aynı — kur farkı değil, muhtemelen işlem sonrası ortalama maliyet güncellemesi `sth_birimfiyat`'ı değiştirmiş ama `sth_tutar` işlem anındaki değerde donmuş). **570 sarfiyat satırından 10 tanesi `sth_tutar=0, sth_birimfiyat=0`** ile kayıtlı — yani Mikro bu değeri KABUL EDİYOR (nadir ama gerçek emsal var).

**İkinci gerçek yazma turu — 5 DENEME, HEPSİ BAŞARISIZ (2026-10-29, yönetici onayıyla, hep 1 kg, `HM617.AA30.00XYU18.00`, hep aynı MERKEZ DEPO=1 → REZERV HAMMADDE=4 transferi):**
1. `tutar`/`birimfiyat` olmadan (ilk tur, yukarıda) → 400, boş hata.
2. `sth_tutar=0, sth_birimfiyat=0` eklendi → 400, boş hata (AYNI).
3. Evrak serisi `CNCT`'den gerçek/tanıdık bir seriye (`ALEN`) değiştirildi (seri kaydı eksik mi diye) → 400, boş hata (AYNI).
4. `sth_evrakno_sira=1`, `sth_birim_pntr='1'`, `sth_cari_cinsi='0'`, `sth_cari_kodu=''`, `sth_vergisiz_fl=false`, `sth_normal_iade='0'` eklendi → 400, boş hata (AYNI).
5. **GERÇEK KOD HATASI BULUNDU VE DÜZELTİLDİ:** `mikro-stock.js` `evrak_aciklamalari`'yı yanlış yere (her SATIRIN içine) koyuyormuş; doğrusu `evraklar[]` düzeyinde, `satirlar`'ın KARDEŞİ (dokümandaki örnek gövdeyle birebir: `evraklar:[{evrak_aciklamalari:[...], satirlar:[...]}]`). Düzeltilip tekrar denendi → **400, YİNE boş hata (AYNI)**.
- **Her denemede salt okuma ile doğrulandı: HİÇBİR satır yazılmadı** (CNCT/ALEN serili ya da bu hammaddeye ait bugünün tarihli hiçbir kayıt yok) — beşi de temiz red, veri kaybı/yarım kayıt riski YOK.
- **Örüntü: 5 farklı gövde denendi, HEPSİ aynı (`StatusCode:400, IsError:true, ErrorMessage:""`) hatayı verdi** — gövdedeki hiçbir alan değişikliği sonucu değiştirmedi. Bu, hatanın SATIR İÇERİĞİNDEN değil, daha temel bir şeyden kaynaklanabileceğine işaret ediyor: örn. bu MikroAPI kurulumunda/lisansında `DahiliStokHareketKaydetV2` (yazma) metodunun hiç ETKİN olmaması ihtimali (okuma uçları — `SqlVeriOkuV2` — zaten çalışıyor ve ayrı bir lisans/yetki sınıfında olabilir). Resmi API dokümantasyon sayfasında bu uç için lisans/modül şartı YAZMIYOR (kontrol edildi) ama bu, kurulumda etkin olduğu anlamına gelmez.
- **Sıradaki adım (DENENMEDİ, kullanıcıya önerildi):** daha fazla kör deneme yerine **Mikro desteğine/bayisine doğrudan sorulması** — dokümandaki örnek `curl` isteğini birebir vererek "bu şirketin API anahtarıyla neden `StatusCode:400, ErrorMessage:boş` dönüyor" diye sormak; bu, body alanlarıyla kör deneme yapmaktan çok daha hızlı gerçek cevap verir. Ayrıca mümkünse: MikroAPI panelinde/ayarlarında bu yazma ucunun (stok hareketi) AÇIK olup olmadığı yönetici tarafından kontrol edilebilir.
- **`MIKRO_WRITE_ENABLED` hâlâ KAPALI** (varsayılan, sunucu config'i hiç değişmedi) — tüm denemeler tek seferlik betiklerle, `writeEnabled` yalnız o betik için enjekte edilerek yapıldı.

**Yeni ipucu, GERÇEK YAZMA DENEMEDEN bulundu (2026-10-29, salt okuma + dokümantasyon):** Mikro'nun API dokümantasyon sitesi Stoplight tabanlı; her sayfanın `.md` uzantılı HAM sürümü var (ör. `.../post.md`) ve bu, arayüzün "Show 8 properties" diye KISALTTIĞI şemayı TAM açık veriyor. `DahiliStokHareketKaydetV2`'nin tam şemasını bu yoldan çektik: **`Mikro` kimlik bloğunda `FirmaNo` (integer) ve `SubeNo` (integer) diye iki alan daha varmış** — `mikro-client.js`'in `call()` fonksiyonu bunları HİÇ GÖNDERMİYORDU (yalnız `ApiKey/CalismaYili/FirmaKodu/KullaniciKodu/Sifre`). Bu önemli bir ipucu: eksik olması AUTH/ŞİRKET BAĞLAMI seviyesinde bir sorun olabileceğini açıklıyor — satır (`satirlar`) içindeki hiçbir alan değişikliğinin 5 denemede de sonucu değiştirmemesiyle TUTARLI (eğer Mikro hangi firma/şube olduğunu çözemiyorsa, satır içeriğine hiç bakmadan reddedebilir).
**Değerler TAHMİN DEĞİL:** daha önce okuduğumuz gerçek `STOK_HAREKETLERI` örnek satırında (`§"Hammadde HAREKETI DAGILIMI" örnek satırı`) `sth_firmano: 0, sth_subeno: 0` görülmüştü — yani bu şirketin kurulumu tek firma/tek şube, değer 0/0. **`mikro-client.js` düzeltildi:** constructor'a `firmaNo = 0, subeNo = 0` eklendi, `call()`'ın gönderdiği `Mikro` bloğuna `FirmaNo`/`SubeNo` eklendi (varsayılan 0, hem okuma hem yazma uçları için — okumalar zaten çalışıyordu, bu alanları eklemek onları bozmaz). Testi güncellendi + yeni test (`mikro-client.test.js`, 12 test). `npm test` 539/539 yeşil.

**Üçüncü yazma turu — 3 DENEME DAHA (toplam 8), SİSTEMATİK OLARAK DEĞİŞKENLER AYRIŞTIRILDI (2026-10-29, hep yönetici onayıyla, hep 1 kg):**
6. FirmaNo/SubeNo düzeltmesiyle, aynı hammadde (`HM617.AA30.00XYU18.00`), aynı depolar (1→4) → **400, boş hata (AYNI)**.
7. **FARKLI hammadde** (`HM614.AA25.00`, MERKEZ DEPO'da ~4.189 kg olduğu salt okuma ile önceden doğrulandı — "bu hammaddeden yeterli stok yok" ihtimali elendi), aynı hedef (REZERV HAMMADDE=4) → **400, boş hata (AYNI)**.
8. **Aynı hammadde (`HM614.AA25.00`) ama FARKLI, 2024'ten beri KURULU bir hedef depo** (GEÇİCİ DEPO=2, "REZERV HAMMADDE yeni depo, henüz hazır değil" ihtimalini elemek için) → **400, boş hata (AYNI)**.
- **Her denemede salt okuma ile doğrulandı: hiçbir satır yazılmadı.**
- **SONUÇ — artık sistematik olarak elendi:** satır içeriği (8 farklı gövde), hammadde/stok kodu (2 farklı, biri ~4.189 kg stoklu), depo (3 farklı, biri 2024'ten beri kurulu), kimlik bloğu alanları (FirmaNo/SubeNo eklendi). **8 yapısal olarak farklı istek, hepsi BİREBİR aynı `StatusCode:400, ErrorMessage:""` hatasını verdi.** Bu denli tutarlı, içerikten bağımsız bir red, iyi stoklu/kurulu bir hammadde-depo çiftinde gerçek bir iş kuralının her seferinde aynı şekilde tetiklenmesinden çok, **`DahiliStokHareketKaydetV2` yazma metodunun bu API anahtarı için hiç ETKİN olmamasına** işaret ediyor (okuma uçları `SqlVeriOkuV2` zaten çalışıyor ve muhtemelen ayrı bir izin sınıfında).
- **Karar (support'a yazılmadan önce): kök neden BULUNDU, GERÇEK YAZMA BAŞARILI (2026-10-29).** Support'a yazmadan önce "Mikro PC'sinde bir şey kontrol edebilir miyiz" diye düşünülürken, dokümantasyonu bir kez daha — ama bu sefer **WebFetch'in AI özetlemesi OLMADAN, `curl` ile HAM `.md` kaynağını doğrudan okuyarak** — kontrol ettik. WebFetch'in kendisi "sayfayı küçük bir modelle özetler" diyor; bu sefer o modeli aradan çıkardık.
  - **Ham kaynak** (`curl https://apidocs.mikro.com.tr/apis/stok/paths/~1api~1apimethods~1dahilistokhareketkaydetv2/post.md`) alan listesini `Mikro.evraklar.satirlar.sth_stok_kod` gibi NOKTALI YOL olarak veriyor — yani **`evraklar`, `Mikro` bloğunun İÇİNDE** olmalı. Önceki 8 denemenin HEPSİ `evraklar`'ı `Mikro`'nun DIŞINA (kardeşi olarak) koyuyordu — bu, WebFetch'in daha önceki (AI özetli) okumalarından kalma, hiç sorgulanmamış bir varsayımdı.
  - **Kontrol (gerçek Mikro'ya karşı, salt okuma eşdeğeri risk):** `SqlVeriOkuV2`'ye `SQLSorgu`'yu `Mikro` İÇİNE koyarak denendi → **`"SQLSorgu parametresi gönderilmelidir !"`** hatası — yani Mikro'nun İKİ UCU KENDİ İÇİNDE TUTARSIZ: `SqlVeriOkuV2` parametreyi DIŞARIDA, `DahiliStokHareketKaydetV2` İÇERİDE istiyor. Mevcut okuma kodu (`sqlQuery`) zaten doğru (dışarıda) gönderiyordu, dokunulmadı.
  - **GERÇEK YAZMA DENEMESİ (yönetici onayıyla, 1 kg, `HM614.AA25.00`, MERKEZ DEPO=1→GEÇİCİ DEPO=2, `evraklar` artık `Mikro` İÇİNDE): İLK denemede BAŞARILI.** `{"StatusCode":200,"IsError":false,"Data":{"list":[{"guid":"...","evrakno_seri":"CNCT","evrakno_sira":"1"}]}}`. Salt okuma ile doğrulandı: gerçek satır oluştu (`sth_tip=2, sth_cins=6, sth_evraktip=2, sth_cikis_depo_no=1, sth_giris_depo_no=2, sth_miktar=1, sth_tutar=0, sth_iptal=false`) — **bu GERÇEK bir muhasebe kaydı, geri alınmadı/ters kayıt yapılmadı** (kullanıcıya soruldu, karar bekleniyor).
  - **Kod düzeltildi:** `mikro-client.js` `call()`'a `nestInMikro` seçeneği eklendi (varsayılan `false` = eski/okuma davranışı DEĞİŞMEDİ; `true` = govde alanları `Mikro` bloğunun İÇİNE yazılır). `mikro-stock.js` `send()` artık `{ nestInMikro: true }` ile çağırıyor. Testler güncellendi + yeni testler (`mikro-client.test.js`, `mikro-stock.test.js`). `npm test` 540/540 yeşil.
  - **Hâlâ açık:** sarfiyat (virman, `evraktip=6/tip=1/cins=3`) tarafı aynı düzeltmeyle henüz GERÇEK yazmayla denenmedi (yalnız transfer denendi); `sth_tutar=0`'ın maliyet muhasebesine etkisi hâlâ netleşmedi (bu denemede de 0 gönderildi ve kabul edildi, ama "doğru" değer bu mu bilinmiyor); `MIKRO_WRITE_ENABLED` gerçek sunucuda hâlâ KAPALI (yalnız tek seferlik betikle denendi).
  - **Ders (yöntem):** WebFetch (ya da herhangi bir "sayfayı özetleyen" araç) yapısal/şema kesinliği gerektiren durumlarda YANILTICI olabilir — bir ara modelin JSON iç içeliğini doğru temsil edememe riski var. **Kritik bir yapısal iddia varsa `curl`/ham kaynakla çapraz doğrulamak** (mümkünse) çok daha güvenilir; bu oturumda tam da bu yöntem kök nedeni buldu.
  - **Gerçek 1 kg'lık test hareketi (evrak CNCT-1, MERKEZ DEPO→GEÇİCİ DEPO) kullanıcı/yönetici tarafından Mikro arayüzünden de doğrulandı ve GERİ ALINMADI** (kullanıcı kararı: kalsın, zararsız/sıfır maliyetli bir kayıt).
- **Virman fişinde yön (Giren/Çıkan) artık SEÇİLEBİLİR (2026-10-29, kullanıcı isteği):** önceden `previewVirman` hep `tip=1` (Çıkan) üretiyordu; artık `direction` parametresi (`'cikan'` varsayılan, `'giren'` de geçerli) alıyor — Mikro'nun "Stok Virman Fişi" ekranındaki satır başına "Giren Çıkan" seçimiyle eşleşiyor. `dashboard/planning-material.js`'teki virman penceresine "Yön" açılır kutusu eklendi (varsayılan "Çıkan (sarfiyat)", "Giren" de seçilebilir); tarayıcıda doğrulandı. Testler: `mikro-stock.test.js` +2 (`direction` davranışı). `npm test` 542/542 yeşil.

**SARFİYAT (VİRMAN) TARAFI DA GERÇEK YAZMAYLA DOĞRULANDI (2026-10-29, yönetici onayıyla, 1 kg, ÇIKAN yönü):** daha önceki CNCT-1 transfer denemesiyle GEÇİCİ DEPO'ya (2) aktarılan 1 kg `HM614.AA25.00` için, aynı depoda ÇIKAN yönünde bir virman fişi denendi (`direction:'cikan'`, `tutar:0`) — **İLK denemede BAŞARILI** (`StatusCode:200`, evrak `CNCT-1`, ayrı bir sayaçta — `sth_evrakno_sira` evrak TİPİNE göre bağımsız numaralanıyor, aynı seri altında bile). Salt okuma ile doğrulandı: `sth_tip=1, sth_cins=3, sth_evraktip=6, sth_cikis_depo_no=2, sth_giris_depo_no=2, sth_miktar=1, sth_tutar=0, sth_iptal=false`. **Sonuç: transfer + sarfiyat (virman çıkan) ikisi de GERÇEK Mikro'ya karşı uçtan uca çalışıyor** (`tutar=0` ikisinde de kabul edildi); GİREN yönü hâlâ hiç denenmedi. Bu iki deneme sayesinde GEÇİCİ DEPO'daki 1 kg'lık fazlalık da (transferin yan etkisi) virmanla tüketilip dengeye getirildi — ekstra bir "düzeltme" işlemi gerekmedi.

**Mimari not (önceden bilinen, hâlâ geçerli):** bu akışın okuma tarafı (ön tahmin hesabı) zaten var olan `calc.js`/`material.js` fonksiyonlarını kullanacak, yeni bir hesap YAZILMAYACAK; yalnız YAZMA (transfer fişi, sarfiyat fişi) ve bunların UI'ı (muhtemelen Tezgah başı veya İş emirleri ekranında "hammadde ayır/transfer" düğmeleri, iş emri geçmişine `hammadde-ayrildi`/`hammadde-tuketildi` gibi olay kayıtları — `EVENT_LABEL`'da zaten bu adlar YER TUTUCU olarak var, `dashboard/planning-workorders.js:34`) yeni. `MikroClient` (`backend/planning/mikro-client.js`) bu yazmalar için de aynen kullanılabilir (zaten genel amaçlı, sipariş okumaya özel değil).

### Bitmiş ürün depo akışı (Merkez ↔ Geçici, Mikro) — 2026-11-03, kullanıcı isteği

Yukarıdaki G aşaması HAMMADDE'nin Merkez→Üretimde akışıydı; bu, kullanıcının AYNI isteğin BİRİNCİ parçası olarak tarif ettiği, ama "önce kütüphane bölünmesi, sonra ZIP" sırasına göre EN SONA bırakılan **BİTMİŞ ÜRÜNÜN** akışı: **iş emri bitince üretilen adet Merkez'den Geçici depoya, paketlenince (paketleme formu toplamı) Geçici'den Merkez depoya** — kullanıcının kendi tarifi: "o üründen o kadar adeti geçici depoya girilmesi... paketlenenlerin de geçici depodan sevk fişi ile merkezi depoya aktarılması".

**TAM AKIŞ GERÇEK MİKRO'YA KARŞI UÇTAN UCA DOĞRULANDI (2026-11-04, kullanıcı onayıyla, SR040.013, iş emri 2026001199, 10 adet):** önce (2026-11-03) kod yazılıp yalnız mock Mikro ile test edilmişti; bu oturumda kullanıcı fabrika/Mikro ağındaydı ve adım adım gerçek testi yaptık.

- **İlk tasarım YANLIŞTI ve düzeltildi:** "bitiş" adımı önce Merkez(1)→Geçici(2) **TRANSFER** olarak kurulmuştu (hammaddeyle "aynı evrak türü" varsayımıyla). Gerçek Mikro ilk denemede anlamlı bir hatayla reddetti: `"Stok eksiye düşeceğinden, işlem kabul edilmedi."` — Merkez'de transfer edilecek SR040.013 stoku hiç yok (üretim Merkez'e hiç girmiyor). Kullanıcı netleştirdi ve SR040.013'ün GERÇEK geçmiş hareketleri (salt okuma, `STOK_HAREKETLERI`) de aynı şeyi gösterdi: ofis üretimi hep **Geçici depo İÇİNDE GİRİŞ virmanı** (`evraktip=6/tip=0 Giriş/cins=3`, "ÜRT" serili) olarak kaydediyor, sonra paketlenen kısmı **Geçici→Merkez TRANSFER** (`evraktip=2/tip=2/cins=6`, "alen" serili) ile taşıyor — üçüncü adım (Merkez'de ÇIKIŞ irsaliyesi, "ANI" serili) müşteriye sevk, bizim kapsamımızın dışında. `sendFinishTransfer` artık `previewProductTransfer` DEĞİL, `previewProductVirman({direction:'giren'})` kullanıyor (Geçici içinde GİRİŞ; `fromDepot=toDepot=GECICI_DEPO_NO`).
- **GİREN yönü de İLK başta reddedildi** (3 gerçek deneme, hep aynı genel hata: `"Stok Hareketi Kaydedilemedi"`, hiçbiri hiçbir şey yazmadı — her denemeden sonra salt okuma ile doğrulandı). Kök neden: kullanıcı Mikro ekranından ELLE bir GİRİŞ virmanı yaptı (Stok Virman Fişi, Giren, SR040.013, Geçici depo, 1 adet), ben o satırı salt okuma ile okuyup kendi gövdemle karşılaştırdım — **GİRİŞ'te `sth_evrakno_seri` BOŞ olmak zorunda** ("CNCT" ÇIKAN/TRANSFER'de sorunsuz ama GİRİŞ'te hep reddediliyordu); ayrıca gerçek satırlarda hep bulunan `sth_miktar2`/`sth_birim_pntr` de eklendi. Düzeltilince İLK denemede kabul edildi (`backend/planning/mikro-stock.js` `baseSatir`/`previewVirman`/`previewProductVirman`; hem hammadde hem bitmiş ürün, hem GİRİŞ hem ÇIKAN yönü artık gerçek yazmayla doğrulandı). Testler: `mikro-stock.test.js` (evrak serisi GİREN'de boş/ÇIKAN'da "CNCT" kaldığını, `sth_miktar2`/`sth_birim_pntr`/`sth_tutar` alanlarını doğrular).
- **Gerçek sonuç (salt okuma ile teyitli, `STOK_HAREKETLERI`):**
  1. İş emri 2026001199 (SR040.013, hedef 10, elle bitirildi) → **"Geçici depoya aktar…"** → evrak sıra 237, GİRİŞ, 10 adet, Geçici(2) içinde — ✓ panelde "10 adet gönderildi".
  2. Paketleme formuna SR040.013, 1 koli × 8 adet, iş emrine bağlı satır eklendi → **"Merkeze sevk et…"** → evrak CNCT-2 (tip=2, TRANSFER), 8 adet, Geçici(2)→Merkez(1) — ✓ panelde "8 adet gönderildi", "Geçici'de kalan: 2 adet (paketlenmeyecek fark)".
  3. **"Farkı temizle…" de UI'dan denendi:** panelde "Geçici'de kalan: 2 adet" → onay kutusu ("2 adet... GERİ ALINAMAZ...") → "Evet, temizle" → evrak CNCT-3 (tip=1, ÇIKAN), 2 adet, Geçici(2) — panelde "− 2 adet temizlendi", düğme kayboldu; ikinci kez tıklanamadığı (`canClear` false olduğu için buton hiç yok) da doğrulandı. **Bu iş emri için (2026001199) Geçici'deki test-öncesi/sonrası NET fark SIFIR**: 10 üretildi, 8 paketlenip gitti, 2 kalan fark temizlendi — üçü de toplamda birbirini netliyor (ayrıca aşağıdaki "test kirliliği" notundaki 2 fazladan kayıt da ayrı bir ÇIKAN virmanla dengelenmişti).
- **Test kirliliği (bilerek bırakıldı, geri alınmadı):** tanı sürecinde Geçici'ye 2 fazladan GİRİŞ kaydı girdi — kullanıcının kendi elle testi (evrak 235, 1 adet) ve benim boş-seri denemem (evrak 236, 1 adet); bunlar 2 adetlik bir ÇIKAN virmanla (evrak CNCT-2, tip=1) dengelendi, Geçici'nin SR040.013 bakiyesi test öncesine göre net 10 fazla kaldı (iş emrinin kendi 10 adedi). Evrak kayıtları Mikro'nun ledger'ında KALICI duruyor (silme/iptal hiç denenmedi, yalnız dengeleme virmanıyla netleştirildi) — gerçek muhasebe etkisi yok (`sth_tutar=0`) ama kayıtlar orada.
- **BİLEREK MANUEL, PARÇALI VE DELTA'LI** (hammaddenin "Mikro sarfiyat fişi" ekranındaki `markFis`/`clearFis` deseniyle AYNI felsefe, otomatik-ateşleme YOK): iş emri bitirmek ve paketleme formuna satır eklemek **ASLA Mikro'ya bağımlı değildir** — Mikro ulaşılamaz/yazma kapalıyken de iş emri biter, paketleme satırı eklenir; depo transferi **AYRI, yeniden denenebilir bir adımdır**. Paketleme formu bir vardiya boyunca ZAMANLA DOLAR ve düzeltilebilir: bu yüzden her gönderim **DELTA** taşır (paketlenen TOPLAM − şimdiye kadar BAŞARIYLA gönderilen TOPLAM), sabit bir adet değil — aynı iş emrine gün gün birden çok küçük sevk fişi yazılabilir, hiçbiri ikinci kez gönderilmez (`product-depot.js` `#sentTotal`: yalnız `status='basarili'` satırlar toplanır).
- **Tablo** `product_depot_transfers` (`planlama.db`, kendi `CREATE TABLE IF NOT EXISTS`'i ile — diğer alt modüllerle (Packing/Quality/SampleTracking) aynı "hangi modül önce ilklenirse ilklensin" deseni): her DENEME (başarılı ve başarısız) ayrı satır, `kind` (`bitis`/`paketleme`/`temizle`), adet, kaynak/hedef depo (GİRİŞ ve ÇIKAN virmanlarında kaynak=hedef=Geçici), Mikro evrak seri/sıra ya da hata metni. **Başarısız deneme SİLİNMEZ/EZİLMEZ** — geçmişte durur, bir sonraki çağrı aradaki farkı otomatik yeniden dener (retry = aynı fonksiyonu tekrar çağırmak, özel bir "retry" ucu YOK; gerçek testte de böyle oldu: 3 başarısız "bitis" denemesi geçmişte durdu, 4.'sü başarıyla kapandı).
  **Kapı, hammaddeyle BİREBİR AYNI:** `MIKRO_WRITE_ENABLED=1` olmadan `product-depot.js` `#send` hiçbir ağ isteği YAPMAZ (409 `mikro-write-disabled`) VE hiçbir satır da KAYDETMEZ. **Gerçek kurulumda bu hâlâ varsayılan KAPALI** — bugünkü test, `.claude/launch.json`'a eklenen tek seferlik bir `--env-file` kombinasyonuyla (`.claude/mikro.env` + `MIKRO_WRITE_ENABLED=1` içeren ayrı bir scratch dosyası) yapıldı, gerçek kurulumun/Setup.exe'nin config'i hiç değişmedi.
- **`mikro-stock.js` genelleştirildi:** `baseSatir`'in `kg` alanı `miktar` oldu (hammaddede kg, bitmiş üründe adet — isim artık ikisini de doğru anlatıyor); yeni `previewProductTransfer`/`previewProductVirman({fromDepotNo/depotNo, toDepotNo, stockCode, qty, note, direction?})` (tam sayı adet doğrulayan `pieceCount`, hammaddenin `kgAmount`'ından ayrı). `MERKEZ_DEPO_NO=1`/`GECICI_DEPO_NO=2` sabitleri `product-depot.js`'te (gerçek `DEPOLAR` tablosundan — "Üretimde" değil, doğrudan bu iki mevcut depo kullanılıyor, yeni depo açmaya GEREK YOK).
- **Ekran: iş emri ayrıntısında "Bitmiş ürün depo akışı (Mikro)" paneli** (`dashboard/planning-depot.js` `depotPanelHtml`, Hammadde panelinin hemen altında): üç satır ("Geçici depoya aktarım" / "Merkez depoya sevk" / "Geçici'de kalan"), her biri gönderilen adet (✓ yeşil çip) + bekleyen/kalan adet (◔ sarı çip) + varsa buton. "Farkı temizle…" **GERİ ALINAMAZ** bir işlem olduğu için iki adımlı onay kutusu açar (uyarı metni + Vazgeç/"Evet, temizle"), yalnız iş emri `bitti` VE kalan fark > 0 iken görünür. Yazma kapalıyken (`MIKRO_WRITE_ENABLED` yok ya da `MikroClient.configured()` false) butonlar **devre dışı**, nedeni `title`'da — **iş emri bitirme/paketleme ekranları hiç etkilenmez**, yalnız bu panel. Son başarısız deneme varsa kırmızımsı bir uyarı satırı hata metnini gösterir (DİKKAT: bu satır en son BAŞARISIZ denemeyi gösterir, sonradan başarılı bir deneme olsa bile — küçük, bilinen bir UX kozmetik eksikliği, düzeltilmedi).
- **Uçlar (yalnız yönetici, kayıtsız → varsayılan admin kapısı):** `GET /api/planning/work-orders/:no/depot-status` · `POST .../depot/finish-transfer` · `POST .../depot/packing-transfer` · `POST .../depot/clear-remaining`. `Planning.getWorkOrder()` artık `depot` alanını da döner (`productDepot.statusFor`) — **DİKKAT:** `statusFor` bu yüzden `planning.getWorkOrder()`'ı TEKRAR ÇAĞIRAMAZ (sonsuz döngü olurdu); ham satırı `planning.db.getWorkOrder()` ile okur, paketleme toplamını `planning.packing.forWorkOrder()` ile ayrıca alır (`product-depot.js` `#load`, kodun içinde bu uyarı yorum olarak da var).
- **Testler:** `backend/planning/product-depot.test.js` (15: durum sorgusu, kapalıyken hiç kayıt/istek yok, başarılı gönderim + iş emri geçmişine olay yazımı, zaten gönderilmişi tekrar göndermeme, 0 üretilende "gönderilecek yok", **başarısız deneme kaydedilip yeniden denenince başarıyla kapanması**, paketlemede **delta** mantığı, **kalan farkın hesaplanması + ÇIKAN virmanla temizlenmesi + ikinci kez temizlenememesi**, HTTP uçtan uca) + `mikro-stock.test.js` (previewProductTransfer/previewProductVirman: alanlar, GİREN'de boş evrak serisi, GİREN/ÇIKAN doğrulaması). `npm test` 625/625 yeşil.
- **Hâlâ denenmedi:** (1) Negatif/eksi kalan fark, iptal edilmiş iş emri, telemetriden gerçek (elle değil) bitirilen bir iş emriyle tam akış (bugünkü test iş emri elle bitirildi, `finishWorkOrderManually`). (2) `sth_tutar=0`'ın gerçek maliyet muhasebesine etkisi hâlâ netleşmedi. (3) `MIKRO_WRITE_ENABLED` gerçek kurulumda/Setup.exe'de açma kararı — yönetici ile birlikte, önceki turlardaki aynı temkinli yaklaşım. Üç Mikro yazma adımı da (GİRİŞ/TRANSFER/ÇIKAN) UI'dan uçtan uca doğrulandı.

**Paketleme → Merkez sevki OTOMATİK oldu (2026-11-04, kullanıcı kararı):** önceden paketleme satırı eklense bile Merkez'e sevk için iş emrinin içine girip "Merkeze sevk et…" elle tıklamak gerekiyordu. Artık `planning.js` `addPackingRow`/`updatePackingRow` (routes.js bunlardan geçer, `packing.addRow`/`updateRow`'u ARTIK DOĞRUDAN çağırmaz), satır bir iş emrine bağlıysa `productDepot.sendPackingTransfer`'ı arka planda (await edilmeden, `.catch` ile yutularak) dener — satır eklemeyi ASLA bekletmez/engellemez, başarısızlık yalnız geçmişe yazılır ve "Merkeze sevk et…" düğmesiyle elle yeniden denenebilir (düğme kaldırılmadı). **"Geçici depoya aktar…" (bitiş) ve "Farkı temizle…" (kalan fark) BİLİNÇLİ OLARAK otomatikleşmedi** — kullanıcıya somut bir örnekle (100 adet üretilip yalnız 30'u ilk gün paketlenirse, "her paketlemeden sonra kalanı da otomatik sil" denseydi henüz paketlenmeyi bekleyen 70 adedin yanlışlıkla silineceği) gösterildi, kullanıcı "elle kalsın" dedi. Testler: `product-depot.test.js` (satırın senkron dönmesi/Mikro'yu beklememesi, DELTA'nın otomatik gitmesi, `woNo` yoksa hiç istek atılmaması, başarısızlığın satır eklemeyi bozmaması + geçmişe yazılıp elle yeniden denenebilmesi, `updatePackingRow`'da artış deltası).

**AYRI AÇMA/KAPAMA KAPISI: `PRODUCT_DEPOT_ENABLED` (2026-11-04, kullanıcı kararı, v1.0.2 kurulumunda KAPALI):** fabrika PC'si henüz üretim sahasına inmedi — paketleme orada kullanılmıyor. `MIKRO_WRITE_ENABLED=1` açıkken bu akış da açık kalsaydı, iş emirleri bitirildikçe Geçici depoda paketlenmeyi hiç bekleyen bir "hayalet stok" birikirdi (kimse sahada paketleme girmediği için hiçbiri Merkez'e dönmez). Bu yüzden `product-depot.js`'e `MIKRO_WRITE_ENABLED`'dan **AYRI, DAHA DAR** bir kapı eklendi:
- `ProductDepot` kurucusu artık `enabled` alır (varsayılan `() => process.env.PRODUCT_DEPOT_ENABLED === '1'`, varsayılan **KAPALI**); `#send` içinde `preview.writeEnabled` kontrolünden **ÖNCE** denetlenir (409 `depot-flow-disabled`). `statusFor()` artık `flowEnabled` de döner.
- **Yalnız bu modülün üç fonksiyonunu kapatır** (`sendFinishTransfer`/`sendPackingTransfer`/`clearRemaining`, dolayısıyla yukarıdaki otomatik paketleme senkronunu da) — **hammaddenin kendi Mikro akışını (Hammadde ekranı, `material.js`/`mikro-stock.js`'in `previewTransfer`/`previewVirman`'ı) ETKİLEMEZ**, o `MIKRO_WRITE_ENABLED` tek başına yeterli kalmaya devam eder.
- **Ekran/panel GİZLENMEZ** (kullanıcı kararı: "kapalı ekran olmasın") — `dashboard/planning-depot.js`'teki `blocked` metni artık önce `!d.flowEnabled`'a bakıyor ("Bitmiş ürün depo akışı şu an kapalı (fabrika PC'si/paketleme sahada kurulana kadar).", `!d.writeEnabled`'dan ÖNCE); panel başlığı, "N adet bekliyor" sayıları hep görünür kalır, yalnız düğmeler devre dışı + nedeni `title`'da.
- **Installer:** `installer/build-installer.ps1 -ProductDepotEnabled` (yeni switch, `-MikroWriteEnabled` ile AYNI desen) verilirse gömülü `mikro.env`'e `PRODUCT_DEPOT_ENABLED=1` eklenir; verilmezse (v1.0.2'de verilmedi) satır hiç yok → varsayılan kapalı. Fabrika PC'si kurulup paketleme sahada başladıktan SONRA bir sonraki pakette bu bayrakla açılacak.
- Testler: `product-depot.test.js` (gerçek varsayılanın — test override'ı OLMADAN — `PRODUCT_DEPOT_ENABLED=1` verilmedikçe kapalı olduğu; kapıyken üç fonksiyonun da 409 `depot-flow-disabled` verip Mikro'ya hiç gitmediği; SONRADAN kapatılırsa daha önce oluşmuş kalan farkın bile gönderilemediği; otomatik paketleme senkronunun da sessizce başarısız olup satırı bozmadığı ve hammaddenin kendi `writeEnabled`'ının bundan etkilenmediği). `npm test` 634/634 yeşil.
- **Tarayıcıda (sahte Mikro, `MIKRO_WRITE_ENABLED=1` ama `PRODUCT_DEPOT_ENABLED` verilmemiş) denendi:** panel aynen görünüyor ("Geçici depoya aktarım: 50.000 adet bekliyor" vb.), iki düğme de devre dışı + üstüne gelince "Bitmiş ürün depo akışı şu an kapalı…" yazıyor — "kapalı ekran" YOK, yalnız fonksiyon kapalı.

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

**"Ürün değişikliği" (D1) duruşu verimlilik hesabından çıkarılır (2026-11-18, kullanıcı isteği):** *"duruş nedeni ürün değişkliği seçildiği zaman o duruş verimlilğe dahil edilmemeli"* — ürün değişimi sırasında geçen süre bir performans kaybı değil, planlı bir hazırlıktır.
- **Mekanizma** (`efficiency.js` `EFFICIENCY_EXCLUDED_CODES = new Set(['D1'])`, sabit liste — `production.js`'teki `UNREADABLE_PROGRAMS` ile AYNI "bilinen, az sayıda özel durum kodda sabit tutulur" deseni): `orderSegments` artık isteğe bağlı bir `reasons` parametresi alır (o tezgah/pencerenin duruş nedenleri, `downtimeReasonsFor` ile aynı biçim); D1 kodlu olanların her vardiya parçasıyla kesişen süresi **`allottedSec`'ten (verimliliğin zaman tabanı) düşülür** ve ayrıca segmentte `excludedSec` olarak taşınır (toplamlarda `summarize().excludedSec`).
  **`observedSec`/`runningSec` (Kullanılabilirlik/A) BİLİNÇLİ OLARAK ETKİLENMEZ** — kullanıcının isteği özellikle "verimlilik" içindi; A hâlâ "tezgah gerçekten ne kadar çalıştı" sorusunu cevaplar, D1 süresi orada hâlâ çalışmayan (gözlenen) süre olarak sayılır. `planning.js` `efficiencyReport`, her iş emri için `this.db.downtimeReasonsFor(wo.machineId, s, e)` ile o pencerenin TÜM nedenlerini çeker (filtreleme `efficiency.js`'in içinde, kodu tek yerde tutmak için); `total.excludedSec > 0` ise bir uyarı eklenir ("N dk \"Ürün değişikliği\" (D1) nedeniyle verimlilik hesabından çıkarıldı"), bu da dashboard'un zaten var olan genel uyarı listesinde (`dashboard/planning-efficiency.js` `warnings()`) **kendiliğinden görünür** — yeni bir arayüz elemanı eklenmedi.
  **Yan etki (bilinçli, dokunulmadı):** matristeki `unassignedSec` (vardiya süresi − ayrılan süre) D1 dışlandıkça büyür, çünkü "ayrılan süre" zaten tek kaynak; bu süre fiilen bir iş emrine atanmıştı, yalnız verimlilik hesabından çıkarıldı — kullanıcı yalnız verimliliği sordu, bu ikincil etki belgelenir, ayrıca düzeltilmedi.
- **Testi:** `efficiency.test.js`'e 2 yeni test (saf `orderSegments`: D1 allotted/excludedSec'i etkiler ama A'yı etkilemez, D4 gibi başka kod hiç etkilemez; `Planning.efficiencyReport` uçtan uca: gerçek `addDowntimeReason` + gerçek SQLite ile aynı sonuç + uyarı metni). `npm test` 836/836 yeşil. **Tarayıcıda gerçek bir duruşla henüz denenmedi** (yalnız backend testleriyle; dashboard tarafında yeni kod yazılmadığı için — uyarı zaten var olan genel liste render'ından geçiyor — ayrı bir tarayıcı doğrulamasına gerek görülmedi).

**Çizelgeleme / optimizasyon (OR-Tools CP-SAT) — MVP YAPILDI (2026-10-26, kullanıcı isteği):** bekleyen iş emirlerini hangi tezgaha, hangi sırayla vermenin **otomatik önerisini** çıkarır. Bu bir **operasyonel araştırma / kombinatoryal optimizasyon**
problemi (klasik paralel makine çizelgeleme), **yapay öğrenme modeli DEĞİL** — Google OR-Tools'un CP-SAT çözücüsü ile 8 tezgah ölçeğinde saniyeler içinde optimale yakın çözülür.
- **Veri:** süre için **önce gerçekte ÖLÇÜLEN çevrim süresi** (`efficiency.js` `productRows().measuredCycleSec`, son 90 gün — Verimlilik raporuyla AYNI hesap, yeni veri çıkarma kodu yok), yoksa ürün kartındaki **planlanan** (`plannedSec`); iş emirleri (`planlandi`: hedef adet, termin, hammadde; `uretimde`: mevcut tezgah meşguliyeti, zaten var olan `getWorkOrder().progress.eta` tahmininden — yeni hesap yazılmadı); tezgah listesi (`listMachines()`).
- **Hedef, öncelik sıralı (lexicographic), ağırlık uydurmaya gerek kalmasın diye:**
  1. **Önce termin gecikmesini (tardiness) en aza indir.**
  2. **Sonra**, o en-iyi gecikme değerini sabitleyip şunları **birlikte (eşit ağırlıkla toplanır)** en aza indir: toplam süre (makespan) · tezgahlar arası yük dengesizliği (yalnız YENİ atananların yükü; çalışan işin kalan süresi dengeye katılmaz) · bir tezgahın sırasında **hammadde/müşteri değişim SAYISI** × ceza.
  - **Bilinçli basitleştirme (aynen kaldı):** gerçek ürün-çifti bazlı ayar SÜRESİ verisi yok, model süre tahmin etmeye çalışmaz; yalnızca **değişim sayısını** azaltır, cezası sabit bir varsayım (20 dk, `schedule.changeoverPenaltySec` ayarıyla değiştirilebilir — `PlanningDb.getSetting/setSetting`, arayüzde düğme yok, elle). "Değişim ve ayar" duruş kodlarının gerçek ortalamasından **otomatik** hesaplanması sonraki iş.
  - **Değişim sayısı nasıl hesaplanıyor (Python tarafı):** tezgah başına bir **devre (circuit) kısıtı** — depo + iş düğümleri, "kendi kendine döngü" = o tezgaha atanmamış demek; seçilen "sonraki iş" yayı aynı zamanda `end[i] <= start[j]` zamanlamasını da zorlar, yani devrenin sırası GERÇEK başlangıç zamanlarıyla kenetlidir (keyfi bir sıralama seçemez). Kuyruk 60 iş emrini aşarsa bu terim atlanır (`changeoverSkipped`), yalnız makespan + yük dengesi kalır.
- **Kısıt:** **o an üretimde olan iş emirlerine dokunulmaz** — optimizasyon yalnız `planlandi` kuyruğu, mevcut tezgah meşguliyetinin etrafında çizelgeler.
- **Varsayım (doğrulanmadı):** 8 tezgah birbirinin yerine geçebilir kabul edilir (envanterde kapasite/uygunluk kısıtı yok).
- **Mimari:** backend'in "sıfır bağımlılık" kuralı Node için geçerli kalır; **`optimizer/schedule_solver.py`** (ayrı, küçük bir Python betiği; bağımlılığı yalnız `ortools`, `pip install ortools`) stdin'den JSON problem alır, stdout'a JSON sonuç yazar, başka dosya I/O'su yok. **`backend/planning/schedule.js`** (`Planning.schedule`, `Packing`/`Quality` gibi `{planning: this}` ile bağlanan bir alt modül) gerçek veriyi toplar (`buildProblem`), `node:child_process` ile Python'u çağırır (`solveSchedule`; npm paketi DEĞİL, proje zaten testlerde/`scripts/dev.js`'de aynı deseni kullanıyor), sonucu is emri bilgileriyle zenginleştirir (`suggest`) ve onaylanan atamaları **mevcut `updateWorkOrder` yoluyla** yazar (`apply` — yeni bir yazma yolu İCAT EDİLMEDİ; başlamış/iptal iş emri `updateWorkOrder`'ın kendi "tezgahı değişmez" kuralıyla SESSİZCE atlanır, tüm istek reddedilmez).
- **Sonuç ASLA otomatik uygulanmaz:** "Çizelgeleme" ekranı (Planlama, yalnız yönetici, `#/planlama/cizelgeleme`): "Öneri oluştur…" → tablo (tezgah × iş emri, tahmini başlangıç/bitiş, hangi işin tezgahı değişiyor) + özet metrikler → seçilen satırlar için "Uygula…" (tezgah kimliği yazmaya gerek yok, zaten listede görülüyor; onay penceresinde değişecek atamaların tam listesi).
- **Uçlar (yalnız yönetici):** `POST /api/planning/schedule/suggest` (gövde yok) · `POST /api/planning/schedule/apply {assignments: [{no, machineId}]}` → `{applied, skipped}`.
- **Doğrulama:** `backend/planning/schedule.test.js` 9 test (süre önceliği: ölçülen > planlanan > bilinmeyen-dışarıda+uyarı; meşgul tezgah hesabı; sahte çözücü ile `suggest`/`apply` zenginleştirme ve hata yolu; başlamış iş emrinin sessizce atlanması; HTTP) — **gerçek Python hiç çağrılmaz** (`run` enjekte edilir, `npm test` bağımlılıksız kalır). `optimizer/test_schedule_solver.py` (6 test, GERÇEK CP-SAT ile; `python -m unittest optimizer/test_schedule_solver.py`, elle çalıştırılır, ortools gerekir): boş kuyruk, tezgah yok, ufuk çok küçük → infeasible, **aynı malzeme aynı tezgahta gruplanıp değişim 0 çıkıyor mu**, meşgul tezgah erken başlatmıyor mu, sıkı terminli iş gecikme 0 tutuyor mu.
  **Bu makinede uçtan uca gerçek Python'la denendi** (`pip install ortools`; 22 iş × 8 tezgah sentetik problemde ~23 sn, tardiness 0, makul yük dengesi, 4 malzemede 1 değişim): tarayıcıda gerçek dev sunucusu + 6 gerçek `planlandi` iş emriyle (3 ürün, 2 hammadde, farklı terminler) "Öneri oluştur…" → tablo → "Hepsini seç" → "Uygula" → iş emirlerinin `machineId`'si gerçekten değişti (API ile doğrulandı), yeniden "Öneri oluştur"da aynı atamalar (artık "değişiyor" işaretsiz) geldi.
- **Setup.exe'ye gömülü Python + OR-Tools (2026-10-26, YAPILDI):** Node'un `runtime\node.exe`'si gibi, `runtime\python\` altına **taşınabilir (embeddable) Python + pip ile kurulan ortools** gömülür — fabrika PC'sinde Python kurulu olması GEREKMEZ. `backend/planning/schedule.js` `pythonBin()`: `SCHEDULE_PYTHON` ortam değişkeni (elle geçersiz kılma) → yoksa `runtime/python/python.exe` (gömülüyse) → yoksa PATH'teki `python`/`python3` (geliştirme).
  - **`installer/build-installer.ps1`:** `installer\prereq\python-embed\` önbelleğinde Python v3.10.11 (python.org embeddable zip) + `ortools==9.15.6755` (PyPI; sürüm sabit — bu sürümle uçtan uca denendi) yoksa kurar (ilk derlemede internet gerekir: zip + `get-pip.py` + `pip install`; ~85 MB indirme), varsa onbellekten alır. `._pth` dosyasında `import site` açılıp `Lib\site-packages` eklenir (embeddable dağıtım pip/site-packages'ı varsayılan KAPALI verir). Paket kodu (`optimizer/`, elle çalıştırılan `test_schedule_solver.py` hariç) ve gömülü Python, Node gibi `payload\`'a kopyalanır; `cnc-telemetri.iss`'e `optimizer\*` için `[Files]` satırı eklendi (`runtime\*` joker zaten `runtime\python\`'ı da kapsıyor).
  - **Duman testi genişletildi:** paketteki `runtime\python\python.exe` ile gerçekten `from ortools.sat.python import cp_model` çalışıyor mu denetlenir (yalnız "dosyalar kopyalandı" değil, **gerçekten çözüyor mu**).
  - **Bu makinede UÇTAN UCA gerçek derleme ile doğrulandı (2026-10-26):** `.\build-installer.ps1` ilk kez internetten Python+ortools+bağımlılıklarını (numpy, pandas, protobuf, absl-py…) indirip kurdu, paketledi, duman testi (yeni Python adımı dahil hepsi) geçti, **84,1 MB** `CNC-Telemetri-Kurulum-0.19.0.exe` üretildi (11TB + 22TB). Paketlenmiş `runtime\python\python.exe` ile gerçek bir çizelgeleme problemi stdin'den verilip doğru çözüldüğü ayrıca elle sınandı (öneri komut satırında da, Node üzerinden de değil, doğrudan paketteki yorumlayıcıyla).
  - **Lisans:** `runtime\python\PYTHON-NOTICE.txt` (PSF License) ve `runtime\node\NODE-NOTICE.txt` gibi OR-Tools için not (Apache License 2.0).
  - **DENENMEDİ:** kurulu PC'de Setup.exe'nin asıl kurulumu (yalnız bu makinede derleme + duman testi); yükseltmede eski `runtime\python\`'ın temiz silinip yenisiyle değişmesi (kurulum.ps1 şu an yalnız node/ajan süreçlerini durduruyor, Python sürekli çalışan bir süreç olmadığı için ayrıca durdurmaya gerek yok ama hiç denenmedi).
- **Diğer DENENMEDİ / sonraki iş:** gerçek fabrika verisiyle (yüzlerce iş emri, gerçek terminler) ölçek/süre; "Değişim ve ayar" ortalamasının duruş kodlarından otomatik hesaplanması; tezgah-ürün uygunluk kısıtı; Gantt benzeri (tezgah × zaman) görsel — şimdilik düz tablo.

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
  **Hammaddenin kalite raporu PDF'i, klasörden (2026-11-17, kullanıcı isteği):** "GKK kısmında satırın üstüne basınca hammaddenin kalite raporu olmalı, PDF dosyalarının ismine hangi hammadde olduğu yazıyor, oraya klasörden direkt çeken bir tuş koyalım, tek seferlik." GKK listesinde **satırın üstüne basınca** (fileCount > 0 ise) üretici kalite sertifikası PDF'i açılır (tek dosya direkt yeni sekmede, birden çoksa küçük bir seçim listesiyle — `drawing-tracking.js`'teki `openDrawing` deseniyle AYNI). `"Klasörden kalite raporu eşle…"` (yalnız yönetici, **tek seferlik**, `gkk-folder.js` + `dashboard/planning-gkk-folder.js`): klasördeki PDF'leri tarar ve dosyaları GKK kayıtlarına bağlar.
  - **DÜZELTME (2026-11-19, kullanıcı gerçek hammadde klasörüyle (251 dosya, "CNC-01…08" değil gerçek GKK rapor arşivi) denerken fark etti):** ilk tasarım dosyaları **hammadde CİNSİNE** (`material` metni) bağlıyordu — "aynı hammaddeyi paylaşan tüm GK numaraları aynı dosyayı görür" varsayımıyla. Kullanıcı gerçek klasörde bunun YANLIŞ olduğunu gösterdi: aynı hammadde klasöründe (ör. "AA11,11 - PB2") birbirinden FARKLI iki sertifika dosyası var (`AA11,11 - PB2 - GK25.141.pdf` ve `GK25.179 - AA11,11 - PB2.pdf`) — her teslimatın/rapor numarasının KENDİ sertifikası var, hammadde TÜRÜNÜN değil. Dosya adları da zaten bunu kanıtlıyor: hammadde cinsinin yanında her zaman o teslimatın GK rapor numarası da yazıyor. **Düzeltme: eşleme artık GK RAPOR NUMARASINA göre** (`findGkNoIn(text)`, `gkk.js` — serbest metinde "GKxx.xxx" kalıbını bulur, rakam dizisini YARIM yakalamaz: "GK25.100" içindeki "10"yu "GK25.10" diye okumaz). Aynı rapor numarasını PAYLAŞAN kayıtlar (bir rapor no birden çok hammaddeye yazılabilir) hâlâ AYNI dosyayı görür; aynı hammaddenin FARKLI rapor numaraları artık PAYLAŞMAZ.
  - **Dosya, kayıt id'sine DEĞİL, RAPOR NUMARASININ METNİNE bağlanır** (`gkk_files.report_key` — eski adı `material_key`idi, 2026-11-19'da değişti —, `compactKey` ile): `doc-folder.js`'teki ürün koduna bağlanan teknik resim/etiket deseniyle AYNI, yalnız anahtar hammadde metni yerine GK rapor numarası.
  - **Eski şemadan (`material_key`) geçiş, tek seferlik** (`quality-db.js#migrateGkkFiles`): tablo zaten varsa (eski kurulum) satırlar okunup tablo yeniden kurulur; her satırın `rel_path`'inden (varsa) `findGkNoIn` ile rapor numarası KURTARILIR; bulunamazsa (nadir — eski klasör adlandırması rapor no taşımıyorsa) eski hammadde anahtarı `report_key` olarak KORUNUR (veri kaybolmaz, admin "Dosyayı kaldır" ile elle temizleyebilir). Gerçek bu makinenin `data/planlama.db`'si (0 satırlı, eski şema) üzerinde ve sentetik (dolu) bir eski tabloyla elle doğrulandı.
  - **Tek seferlik, "update" YOK** (kullanıcının kendi sözü): yalnız hiç kalite raporu OLMAYAN rapor numaraları eşlenir; zaten raporu olana klasörden yeniden dokunulmaz. Elle (manuel) PDF yükleme ucu da YOK — yalnız klasörden, bilinçli olarak (literal istek).
  - **Scan/dosya-tarama mantığı `doc-folder.js`'ten çıkarılan ortak `scanFolder()` fonksiyonuyla PAYLAŞILIR** (ikinci bir dizin-tarayıcı YAZILMADI); eşleme mantığının kendisi (GK no çıkarımı, tam eşleşme — alt dize değil) AYRI ve daha basit (ürün kodu/müşteri kodu kavramı yok).
  - **OneDrive/bulut-senkronu klasörlerindeki geçici okuma hataları için de düzeltme (aynı gün, kullanıcının gerçek 251 dosyalık denemesinde HEPSİ "okunamadı: UNKNOWN" ile reddedilmesinden bulundu):** `doc-folder.js`'teki `readFileRetry`/`readErrorMessage` (OneDrive "Files On-Demand" placeholder dosyalarında sık görülen `UNKNOWN`/`EBUSY`/`EAGAIN`/`ETXTBSY` kodlarında kısa bekleyip birkaç kez yeniden dener; başka hata türlerinde ANINDA, bekletmeden fırlatır) hem `gkk-folder.js`'te hem `doc-folder.js`'in kendi üç okuma noktasında (teknik resim/etiket eşleme + revizyon + Word içeriği arama) kullanılır. Son çare hata mesajı artık "OneDrive/bulut senkronu dosyayı henüz indirmemiş olabilir — klasörü 'Her zaman bu cihazda tut' yapıp yeniden deneyin" ipucu taşır.
  - **Dosyalar:** `backend/planning/gkk-folder.js` (`GkkFolder`), `quality-db.js` (`gkk_files` tablosu, `report_key` ile — içerik `drawing_files`'ta, içerik-adresli; `#dropFileIfUnused` BEŞ tüketiciyi sayar; `#migrateGkkFiles` tek seferlik geçiş), `quality.js` (`MAX_GKK_FILES=8`, `listGkkFiles`/`addGkkFile`/`removeGkkFile`/`gkkFileData`/`filesOfGkk` artık `reportNo` alır; `listGkk()` her satıra `fileCount`'u KENDİ rapor numarasından ekler), `gkk.js` (`findGkNoIn`), `doc-folder.js` (`readFileRetry`/`readErrorMessage`), `routes.js`, `dashboard/planning-gkk-folder.js`, `dashboard/planning-gkk.js`.
  - **Uçlar:** `GET/PUT /api/planning/gkk-folder[/dir]` · `POST /gkk-folder/match` (klasör ayarı/eşleme, **yalnız yönetici**, kayıtsız → admin, `doc-folder.js`'teki `drawing-folder`/`sticker-folder`'la AYNI desen) · `GET /api/planning/gkk/:id/files` (bu kaydın rapor numarasına bağlı dosyalar) · `GET /api/planning/gkk-files/:id` (indir/aç) · `DELETE /api/planning/gkk-files/:id` (yönetici). Dosya okuma (`gkk/:id/files`, `gkk-files/:id` GET) **`gkk` ekranının okuma yetkisiyle herkese açık** (GKK listesini kim görebiliyorsa raporu da görür); `policy.js` `SCREEN_ROUTES`.
  - **Testler:** `backend/planning/gkk-folder.test.js` (6: klasör ayarı, GK no'suna göre eşleme + aynı rapor nosunu paylaşan farklı hammaddelerin aynı dosyayı görmesi, rapor numarası kayıtsız dosyanın eşleşmemesi, "GK25.10" ile "GK25.100"ün KARIŞMAMASI, bozuk PDF + 8 dosya sınırı, HTTP — rapor nosu paylaşımı dahil) + `gkk.test.js`'e `findGkNoIn` testi + `quality.test.js`'teki GKK dosya testi rapor-numarası semantiğine göre yeniden yazıldı (aynı rapor no paylaşımı, aynı hammaddenin farklı rapor nosu paylaşmaz) + `policy.test.js`. `npm test` 892/892 yeşil.
  - **Tarayıcıda gerçek dev sunucusuna (bu makinenin `data/planlama.db`'si) karşı uçtan uca denenen İLK sürüm** (hammadde cinsine bağlayan, artık YANLIŞ bulunan tasarım) **2026-11-17'de doğrulanmıştı; rapor-numarası düzeltmesi bu makinede henüz tarayıcıdan uçtan uca denenmedi** (yalnız backend testleriyle ve migration'ın gerçek/sentetik eski şema kopyalarıyla elle doğrulandı).
  - **DENENMEDİ:** gerçek fabrika hammadde sertifikası PDF'leriyle (kullanıcının kendi OneDrive klasörüyle — 251 dosyanın tamamı önceki oturumda "okunamadı: UNKNOWN" ile reddedilmişti, OneDrive'da "her zaman bu cihazda tut" yapılıp rapor-numarası eşlemesiyle yeniden denenmeli); dosya adı kalıbının gerçek sertifika dosyalarının TÜMÜNDE GK rapor numarası taşıdığı varsayımının (kullanıcının verdiği örnek 251 dosyanın tamamında doğrulandı) başka bir müşteri/hammadde grubunda da geçerli olup olmadığı.
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
  **Sol üstte Alen Otomat logosu (2026-10-29, kullanıcı isteği):** `backend/planning/assets/alen-logo.png` (düz RGB, 8 bit, interlacesiz PNG; kullanıcının verdiği görselden beyaz zemine düzleştirilip 700×271'e küçültülerek üretildi — üretim betiği depoya girmedi, yalnız çıktı PNG). `wo-form-pdf.js` bunu PNG'nin kendi IDAT baytlarını (zlib akışı) hiç açıp yeniden sıkıştırmadan Image XObject olarak gömer (PDF'in Predictor 15'i PNG satır-öngörücüsüyle birebir örtüştüğü için ek bir görüntü kütüphanesi gerekmedi, "sıfır bağımlılık" kuralı korundu). Logo "İŞ EMRİ" başlığının solunda (90 pt genişlik, orana göre yükseklik); dosya okunamazsa (ör. paket eksik kopyalarsa) sessizce logosuz eski düzene döner, form basımını bozmaz. `backend/pdf-merge.js` (form+resim birleştirme) Image XObject içeren PDF'i sorunsuz işliyor (testlerle doğrulandı). **Gerçek yazıcıdan baskıda logo netliği/konumu henüz denenmedi** (yalnız ekran/PDF görüntüleyicide, bkz. §10).
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
- **Program eşlemede artık program KÜTÜPHANESİ'ndeki programlar da görünür, tornada hiç çalışmasa da (2026-10-29, kullanıcı isteği):** önceden liste yalnız `listSeenPrograms()` (telemetride ÜRETİLMİŞ parçası olan programlar) + zaten eşlenmiş programlardan geliyordu — toplu gönderilen 500 program gibi, tezgaha YENİ gönderilmiş ama henüz panelden seçilip çalıştırılmamış bir program listede hiç görünmüyordu, eşleme üretimi BEKLEMEK zorundaydı. `Planning` artık `listLibraryPrograms` de alıyor (`server.js`: `() => library.db.listPrograms().map(p => p.name)` — program kütüphanesi, `backend/programs/`, hâlâ import EDİLMİYOR, yalnız isim listesi enjekte ediliyor, telemetri/planlama ayrımı bozulmadı). `planning.js` `listPrograms()`: önce `listSeenPrograms()` ile doldurulur (zengin veri: parça sayısı, tezgah, son görülme), sonra yalnız kütüphanede olup telemetride HİÇ görülmemiş adlar `parts:0, machines:[], seen:false` ile eklenir (aynı ad iki kaynaktan gelirse telemetri verisi KORUNUR, tekrar satır açılmaz — `programKey` ile katlanır). Testi `backend/planning/planning.test.js` (yeni test: aynı/farklı programın iki kaynaktan gelmesi, beklemeden eşleme). **Bu makinede `library.db` boş olduğu için gerçek kütüphane verisiyle görsel doğrulama yapılmadı** (yalnız ekranın hatasız yüklendiği ve mevcut 59 telemetri-kaynaklı programın etkilenmediği doğrulandı); gerçek toplu gönderim sonrası (kütüphanede çok sayıda program olduğunda) denenmeli.

**Kartta "ÜRÜN RET" tiki — ret edilen kasa paketlemeye gitmez (0.17.3, 2026-10-14, kullanıcı isteği):** kartta tek bir kutu: **ÜRÜN RET** ("Ürün ret edildi (paketlemeye gitmez)"). Ürün ret edildiyse kasa paketlemeye gitmez; duruma göre tekrar işleme ayrılır ya da hurdaya gider (bu karar ve takip sistemde YOK, kâğıtta/fabrikada).
  (Önce kartın altına el yazısı ret / yeniden işlem blokları eklenmişti; kullanıcı "yalnız ret tiki olsun" dedi, bloklar kaldırıldı.)
- **Kartı basarken usta tikler** ("Kartta işaretlenecekler" bölümünde yıkama/kurutma/tavlama kutularının altında); tiklenince pencere "bu kasa paketlemeye gitmeyecek" diye uyarır, kartta kutu ✓ olur ve satır belirginleşir (siyah-beyazda da okunur). Varsayılan ret DEĞİL.
- **Sistemde:** `crates.reject` (0/1; eski veritabanları açılışta genişler, eski kartlar ret değil). Kasa durumu **`ret`** olur (`açık → kapalı (paketleme bekliyor) → paketlendi`; `iptal`; yeni `ret`): ret kasa **Paketleme "bekleyenler" listesine düşmez**, tezgah başındaki "paketleme bekleyen kasa" sayısına girmez, `packCrate` 409 `rejected` ile reddeder,
  Paketleme ekranında ayrı **"Ret edilenler"** süzgeci ve "RET · paketlemeye gitmez" yazısı vardır; iş emri ayrıntısındaki kartlar tablosunda durum rozeti "ret: paketlemeye gitmez", özet satırında "N kasa RET" (`totals.rejected`, `rejectedCounted`). Yanlış tiklenen ret kart **iptal edilir** (paketlenmediği için) ve yenisi basılır.
  API: `POST /api/planning/work-orders/:no/cards {reject: true}` (boolean; başka tür 400 ve kart numarası harcanmaz); `GET /api/planning/crates?state=ret|kapali` (`kapali` artık ret olanları HARİÇ tutar). İş emri geçmişine "ÜRÜN RET (paketlemeye gitmez)" yazılır.
- **Dosyalar:** `backend/planning/card-steps.js` `parseReject`, `planning-db.js` (sütun, durum, süzgeç), `planning.js` (`issueCard`, `packCrate`, toplamlar), `dashboard/planning-card.js` (`rejectRow`, kutu, rozet), `planning-packing.js` (süzgeç). Testi `card-steps.test.js` (9).
- **Sınırlar / DENENMEDİ:** ret kararı kart BASILIRKEN verilir; kart basıldıktan sonra kasa ret çıkarsa (kalite kontrolde) bu işaretlenemez: kart iptal edilip yenisi basılır (ya da ileride "ret olarak işaretle" düğmesi eklenir; yapılmadı); ret kasanın tekrar işleme/hurda kararı, adam-saat, sağlam/hurda miktarı sistemde izlenmez (ret/hurda sistemde tutulmaz kararı); gerçek yazıcıdan A5 baskı denenmedi.

**Kurulumda kapalı bölümler — Paketleme ve Hammadde (0.18.0, 2026-10-15, kullanıcı kararı; VARSAYILAN 2026-11-02'de DEĞİŞTİ):** bu mekanizma bir bölümü kurulumda tamamen kapatabilir (hiç kimse, yönetici dahil, görmez) — ama
**kullanıcı bunu defalarca (2026-11-02'de bir kez daha) açıkça belirtti: Planlama'da yönetici için HİÇBİR bölüm kapalı kurulmamalı.** `installer/build-installer.ps1`'in `-KapaliBolumler` parametresi artık **varsayılan olarak `@()` (hepsi açık)** — eskiden varsayılan `paketleme, hammadde` idi, bu YANLIŞTI ve değiştirildi.
**Bir installer üretirken `-KapaliBolumler` parametresini ELLE `paketleme`/`hammadde` ile KAPATMA** — yalnız kullanıcı açıkça "şu bölümü kapat" derse (ayrı, bilinçli bir istisna olarak) kullanılır; "rafine edilmedi" gerekçesiyle kendiliğinden kapatma YAPMA.
- **Mekanizma:** `config/features.json` → `{"closedSections": [...]}` (`shared/features.js`: `paketleme`, `hammadde` kapatılabilir; bilinmeyen bölüm ya da yanlış yazılmış anahtar sunucuyu BAŞLATMAZ: sessizce açık kalan bir "kapalı" bölüm en kötü hata). Ortam değişkeni `FEATURES_FILE` dosyayı değiştirir (test/demo).
  Sunucu açılışta `[backend] KAPALI bölümler ...` yazar. Oturum (`GET /api/session`, yalnız giriş yapmışa) `closedSections` verir; arayüz menüyü, açılış sekmesini ve yetkisiz adres korumasını (`#/planlama/paketleme` → kendi açılış sekmesi) bundan kurar (`auth-view.js` `closedSections`, `planning-tabs.js` `tabsForRole(role, closed)`, `planning-common.js` `sectionClosed`).
- **Sunucu zorlar** (`planning/routes.js` `sectionOf`, kimlik/rol fark etmez, yönetici bile): `/api/planning/material/*` (ihtiyaç, sarfiyat, CSV, Mikro fişi + geri alma) ve `POST /api/planning/crates/:id/pack` (kesin paketleme adedi) → **403 `{code: 'section-closed', section}`**.
- **Paketleme kapalıyken ÇALIŞANLAR:** ürün tanıtım kartı basma, kartı yeniden yazdırma (Tezgah başı "Son kartı yeniden yazdır", iş emri ayrıntısında "Kart"), ölçü föyü, ÜRÜN RET, kasa listesi (`GET /crates`), iptal. Yalnız Paketleme sekmesi ve kesin adet girişi kapanır.
  Kimse kesin adet giremeyeceği için şu bilgiler gösterilmez: iş emri ayrıntısındaki kart tablosunda "Paketlenen" ve "Fark" sütunları, "N kasa paketleme bekliyor", durum rozeti "paketleme bekliyor" yerine "✓ kart basıldı"; Tezgah başı bilgi satırındaki "paketleme bekleyen kasa" sayacı. (Kartın gerçek hayattaki "kasayı paketlemeye gönderin" notu kalır: fiziksel iş akışı.)
- **Hammadde kapalıyken:** Hammadde sekmesi ve uçları kapanır; iş emri ayrıntısındaki **"Hammadde · sarfiyat" bilgi paneli KALIR** (hammadde, adet, sarfiyat kg, çubuk, beklenen talaş: kullanıcı "bilgi olarak iyi" dedi) ama **"Mikro sarfiyat fişi" kutusu gösterilmez** (fiş işaretlenemeyeceği için "bekliyor" hep orada kalırdı).
- **Dosyalar / testler:** `shared/features.js`, `config/features.json`, `backend/planning/routes.js`, `backend/auth/http.js` (`sessionExtra`), `backend/server.js`; `backend/features.test.js` (8 test: dosya doğrulama, sekmeler, uçlar, **gerçek sunucu sürecinde** oturum + 403 + kart/ret/föy akışının açık kalması, hatalı dosyada başlamama). Demo/tarayıcıda yönetici ve operatör hesabıyla denendi (menü, kapalı adreslerin yönlendirilmesi, kart tablosu).
- **Denenmedi:** Setup.exe ile gerçek kurulum (paket derlenmedi); gerçek fabrika PC'sinde. **Bir bölümü sonradan kapatmak** (varsayılan artık açık): yeni kurulum (`-KapaliBolumler 'hammadde'` gibi, yalnız kullanıcı açıkça isterse) ya da kurulu PC'de dosyayı elle düzenleyip sunucuyu yeniden başlatmak.

**Telemetri ekranlarından mil devri ve Ölçümler grafikleri kaldırıldı (0.19.0, 2026-10-15, kullanıcı isteği):** Tezgah detayında (1) **"Ölçümler" bölümü** (Mil devri / İlerleme / Parça sayacı grafikleri ve "Tablo" görünümü), (2) üstteki **"İş mili ve ilerleme" kartı** (mil devri, ilerleme, mil/ilerleme override) ve ana ekrandaki her tezgah kartındaki **"Mil devri"** satırı kalktı
(kart: İlerleme · Parça · Çalışma oranı). **"CSV indir" / "Ham CSV" düğmeleri "Durum şeridi" bölümünün başlığına, zaman aralığı düğmelerinin (30 dk … 7 gün) yanına taşındı** (indirilen dosya seçili aralığı kapsar; uçlar ve CSV içeriği DEĞİŞMEDİ: mil devri CSV'de durur). Kontrolcüden gelen değerler yine toplanır ve saklanır
(`samples`, ham CSV, "Kontrolcüden gelen ham değerler"); yalnız ekranda gösterilmez. Geçmiş isteği artık yalnız durum şeridi için `maxPoints=50` ile yapılır. Kodu `dashboard/app.js` (`detailShell`, `drawHistory`), `dashboard/format.js` (`FIELD_GROUPS`). `charts.js` `lineChart` kullanılmıyor (ileride grafik istenirse durur).

**Tablet dağıtımı — ev ekranı uygulaması (PWA) (2026-10-26, kullanıcı isteği):** ustalar tableti tarayıcıdan URL yazarak değil, **ev ekranındaki bir simgeden** açsın diye (`dashboard/manifest.json`): adres çubuğu olmadan tam ekran açılır (`display: standalone`). `dashboard/index.html`'e `<link rel="manifest">`, `theme-color` (`#6C53E8`), `apple-touch-icon` meta'ları eklendi. İkonlar (`icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`, favicon) **Alen Otomat'ın kendi logosundaki "A" + altıgen somun işareti** (fabrika sahibinin verdiği görsel, Python/Pillow ile tek seferlik kırpma/yeniden boyutlandırma — üretim betiği depoya girmedi, yalnız çıktı PNG'ler); `backend/server.js` `STATIC_FILES`'a eklendi. `start_url: "/"`: rol bazlı yönlendirme zaten kendiliğinden doğru ekrana (operatör → Tezgah başı) düşürüyor, manifest'e ayrıca bir rota gömülmedi. **Servis çalışanı (service worker) BİLEREK yok**: bu canlı telemetri uygulaması, önbelleklenmiş/bayat veri göstermek burada "çevrimdışı çalışma"dan daha tehlikeli. Tabletler yalnız **istemci**: aynı yerel ağda `http://<ofis-pc-ip>:3000` açıp "Ana ekrana ekle" yeterli, ayrıca kurulum/ajan gerekmez. **Önerilen tarif:** ortak operatör hesabıyla bir kez giriş (oturum zaten 30 gün boşta/90 gün mutlak), üstüne ücretsiz bir kiosk tarayıcı (ör. Fully Kiosk Browser) ile tableti tek bu sayfaya kilitlemek. **Denenmedi:** gerçek bir tablette (büyük dokunmatik giriş kutuları PC tarayıcısında test edildi, tablette henüz değil).

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

### Esnek rol sistemi, Fiyat çalışması, iş emrini elle bitirme (2026-10-30)

> **Bu bölüm yukarıdaki sabit 3 rol anlatımının (admin/viewer/operator) YERİNE geçer.** Yukarısı tarihsel bağlamdır;
> çelişirse bu bölüm doğrudur.

- **Roller admin tanımlı.** Yalnız `admin` sabittir (`users.is_admin=1`, her şeye erişir). Diğer her hesap `role_id` ile `roles` tablosundaki
  (`auth.db`: `name`, `grants` JSON `{ekranId: 'read'|'write'}`) bir role bağlıdır. "admin" adı rol adı olarak YASAK.
  Eski `viewer`/`operator` hesapları açılışta **bir kez** `AuthDb.#migrate` ile "İzleyici"/"Operatör" adlı özel rollere taşınır (davranış birebir aynı; artık düzenlenebilir).
- **Ekran listesi tek kaynak:** `shared/screens.js` (`SCREENS`; istemcide `dashboard/screens.js` aynası). Her ekran Kapalı/Görebilir/Yazabilir.
  **`isemirleri` ve `olcuraporlari` `writable:false`:** admin dışında kimse için ASLA yazabilir olmaz — Ayarlar'da seçenek sunulmaz,
  `createRole/updateRole` `'write'`'ı reddeder ve `policy.js`'te bu ekranlar için hiç `write` route'u kayıtlı değildir (yapısal garanti).
- **Politika:** `backend/auth/policy.js` `SCREEN_ROUTES` (method + regex → `{screen, level}`); `classify()` `public|local|admin|{screen,level}` döner.
  Kayıtsız uç → `admin` (varsayılan reddet). `createGate` (`auth/http.js`): admin her şeyi açar; aksi halde `req.user.grants[screen]` yoksa 403 "Bu ekrana erişiminiz yok.",
  `write` isteyen uçta yalnız `read` varsa 403 "yalnız görüntüleme". Alan düzeyi kısıtlar (operatörün `start` alanları, `saveToProduct`) artık `!req.user.isAdmin` ile.
- **Uçlar:** `GET/POST /api/roles`, `PUT/DELETE /api/roles/:id` (yalnız admin; kullanımda olan rol silinemez). `POST/PUT /api/users` `role` alanı = rol ADI ya da `'admin'`.
  Oturum süresi artık yalnız `isAdmin`'e göre: admin 12 saat boşta, diğerleri 30 gün (90 gün mutlak).
- **Arayüz:** Ayarlar'da "Roller" (`dashboard/roles-view.js`) + "Kullanıcılar". Sekmeler/uygulamalar `appsFor(user)` / `tabsForUser(user)` ile `grants`'tan süzülür;
  ekran içi dallanma `canWrite(id)` / `canSee(id)` (`planning-common.js`). Rol değiştirme yine yok (sil + yeniden aç).
- **Fiyat çalışması** (`backend/planning/price-studies.js`, `dashboard/planning-price.js`, tablo `price_studies`): ürün kartı açılmadan ön çalışma.
  Admin PDF yükler (`POST /api/planning/price-studies`, `drawing_files` içeriğe-adresli deposunu yeniden kullanır), `fiyat` ekranına yazabilen rol
  (usta) hammadde + süre + not doldurur (`PUT .../:id/fill`, `bekliyor → dolduruldu`). **`products` tablosuyla HİÇ bağlantısı yok** (Mikro'da yönetici elle açar). Yükleme/silme yalnız admin.
- **İş emrini elle bitirme** (`Planning.finishWorkOrderManually`, `POST work-orders/:no/finish-manual`, yalnız admin): yalnız `planlandı` iş emri, adet elle girilir,
  `üretimde` atlanıp `bitti` olur; `started_at = finished_at` (sıfır süreli pencere), `result.source = 'elle'` (+`note`), olay `elle-bitirildi`. 72 saat sınırı YOK.
  Üretim panelinde "elle girildi" rozeti çıkar. **Verimlilik raporu etkilenmez:** `efficiencyReport` sıfır uzunluklu pencereyi (`e <= s`) atlar. "Üretime geri al" `planlandı`ya döner (testli).
- **Tezgahı düzelt** (`Planning.reassignMachine`, `POST work-orders/:no/reassign-machine`, yalnız admin): yanlış tezgahta başlatılmış (`üretimde`) iş emrini taşır;
  eski tezgahta sayılan adet KAYBOLUR (uyarı gösterilir), açık kasa otomatik kapanır, yeni tezgahta sayım şimdiden başlar. `planlandı` iken tezgah normal "Düzenle"den değişir.
- **Doğrulanmadı:** Fiyat çalışması doldurma formu tarayıcıda hiç denenmedi. Tablet PDF kaydırma düzeltmesi (`toolbar=0&navpanes=0` kaldırıldı, `.modal-body` taşması kapatıldı) fiziksel tablette denenmedi.
  **"İş emrini bitir…"/"Tezgahı düzelt…" ve aşağıdaki güvenlik düzeltmesi 2026-11-02'de izole bir test ortamında (gerçek sunucuya karşı) tarayıcıda uçtan uca denendi**, bkz. hemen altındaki madde.

**Güvenlik düzeltmesi — "Tezgahı düzelt" admin-only DEĞİLDİ (2026-11-02, kod incelemesinde bulundu ve düzeltildi):** yukarıdaki "yalnız admin" iddiası ilk sürümde YANLIŞTI: `backend/auth/policy.js`'teki `SCREEN_ROUTES`, `reassign-machine`'i `start`/`finish` ile aynı `tezgahbasi:'write'` grubuna koymuştu (kardeş özellik
`finishWorkOrderManually` doğru şekilde kayıtsız bırakılıp admin'e düşerken, bu uç için o adım unutulmuştu). Sonuç: göçle gelen "Operatör" rolü (ortak fabrika hesabı) ya da `tezgahbasi: yazabilir` verilen her özel rol, üretimdeki bir iş emrini doğrudan `POST .../reassign-machine` ile başka tezgaha taşıyabiliyordu — eski
tezgahta sayılan üretim sessizce sıfırlanıyor, açık kasa otomatik kapanıyor, yalnız bir uyarı metni dönüyordu (işlem engellenmiyordu). **Düzeltme:** `reassign-machine` `SCREEN_ROUTES`'tan çıkarıldı (artık `finish-manual` gibi kayıtsız → admin'e düşüyor); `dashboard/planning-shop.js`'teki "Tezgahı düzelt…" düğmesi de
`isAdminRole()` ile ek olarak gizlendi (savunma derinliği; sunucu zaten reddeder). **Gerçek sunucuya karşı tarayıcıda doğrulandı:** `tezgahbasi:yazabilir` olan bir rolle (İmalat) giriş yapılıp `POST .../reassign-machine` çağrıldığında `403 "Bu işlem için yönetici yetkisi gerekir."` döndüğü ve düğmenin arayüzden kaybolduğu
görüldü; admin girişinde her ikisi de çalışmaya devam ediyor. Testi `backend/auth/policy.test.js` (route artık `admin` sınıflanıyor).

**Aynı incelemede bulunan diğer düzeltmeler (2026-11-02, kod incelemesi → düzeltme):**
- **Rol adı Türkçe katlaması NBSP'yi atlıyordu** (`backend/auth/auth-db.js` `foldKey`): `backend/planning/normalize.js`'teki `foldTr`'nin kopyasıydı ama Excel/Word'den yapıştırılan görünmez genişletilmiş boşluğu (U+00A0) önce normal boşlukla değiştiren adımı atlıyordu — hex dump ile doğrulandı. Artık aynı adımı yapıyor;
  testi `backend/auth/auth.test.js` ("...NBSP...").
- **`MIGRATED_ROLE_GRANTS`** (göçten gelen İzleyici/Operatör rollerinin yetkileri) artık DONDURULMUŞ bir tarihsel kayıt olarak işaretlendi (yorum eklendi): bu değerler artık silinmiş olan eski `VIEWER_PLANNING`/`OPERATOR_PLANNING` dizilerinden o gün elle çıkarıldı, SCREEN_ROUTES ileride değişse de GÜNCELLENMEMELİ (göçün
  anlamı o günkü davranışı dondurmak, bugünküyle eşleşmek değil).
- **`VIEWER_READ`** (`/api/stream`, `/api/machines`, `/api/production*`, `/api/planning/summary`): giriş yapmış HERKESE açık, rolün `telemetri` ekran yetkisine BAKMAZ — bu BİLİNÇLİ (eski "viewer" davranışıyla geriye dönük uyumluluk, kod yorumunda zaten vardı) ama yeni esnek rol sisteminin "her ekran kendi kutusu, Kapalı
  gerçekten kapalı" modeliyle çelişiyor gibi görünebilir: bir role `telemetri` hiç verilmese de (Ayarlar'da "Kapalı") o hesap `/api/machines`'i doğrudan çağırarak tam filo verisini okuyabilir (yalnız arayüzdeki Telemetri uygulama kutusu gizlenir). **Davranış DEĞİŞTİRİLMEDİ** (göçle gelen Operatör rolünün belgelenmiş
  "izleme verisini okuyabilir" yeteneğini kırma riski vardı) — yalnız burada ve kodda netçe belgelendi. Daha sıkı bir davranış isteniyorsa (telemetri grant'ı şart koşmak) ayrıca istenmeli.
- **Göç sonrası dar alan kısıtlarındaki metin hâlâ "Operatör" diyordu** (`routes.js`, ör. "Operatör bu alanları değiştiremez...", "Operatör yalnız bir iş emrinden ilk onay numarası alabilir"): kontrol artık `!isAdmin` (göçten gelen Operatör'e özel değil, admin-dışı HER rolü bağlıyor) ama hata metni eski rol adını
  söylüyordu. Metinler role-nötr hale getirildi ("Bu alanları yalnız yönetici değiştirebilir...", "Yalnız yönetici elle kayıt girebilir...").
- **`text()`/`number()` doğrulayıcıları** `price-studies.js`/`quality.js`/`planning.js`'te birebir üç kopyaydı → `backend/planning/fields.js` (yeni dosya) tek kaynağa taşındı, üçü de oradan import ediyor.
- **`listUsers()`** (`backend/auth/auth.js`) ve `auth-cli.js listele` her kullanıcı için ayrı `getRole()` sorgusu yapıyordu (N+1) → tek seferde rol haritası kuruluyor.
- **`shared/screens.js`'teki `sanitizeGrants`** hiç çağrılmayan ölü kod olduğu doğrulanıp (repo genelinde sıfır çağıran) silindi.
- Hepsi `npm test` ile doğrulandı; dördü (reassign-machine admin kapısı, ölçüm cihazı, kart İLK ONAY NO, o günkü ilk sürüm "numune kartı") ayrıca izole bir test ortamında gerçek sunucuya karşı tarayıcıda uçtan uca denendi.

### Numune Takip (EYS.FR.012 "Numune Talep / Takip Formu") — 2026-11-02, kullanıcı isteği

Kâğıt formun (fotoğrafla verildi) dijital karşılığı: müşteriye numune üretilip gönderilmesi ve müşteriden e-posta ile gelen
onay/ret kararının takibi. İş emirleri ekranıyla aynı desen — liste + "Yeni … aç" + satırdan "Düzenle" — ama kendi, bağımsız
bir kayıttır: **`products` tablosuyla HİÇ bağlanmaz** (ürün kartı henüz hiç olmayabilir; Alen/müşteri ürün kodu serbest metin,
Fiyat çalışması'yla aynı ilke). Aynı gün daha önce eklenen "numune kartı" (ilk onay sonrası ayrı kart önizlemesi) bu ekranla
**değiştirildiği için KALDIRILDI** (bkz. yukarıdaki not).

- **Kâğıt formun hatası düzeltildi:** formda "KALİTE KONTROL RAPOR NO" yazan alan aslında **GKK rapor no**'dur (kullanıcı
  teyidi) — ekranda ve basılan formda "GKK rapor no" olarak gösterilir, GKK/ilk onay/ürün tanıtım kartı ekranlarındaki aynı
  `openGkkPicker`'dan "Listeden seç…" ile doldurulur.
- **Akış:** "Yeni numune formu aç" → NUMUNE TANIMLAMA (müşteri *zorunlu*, geri kalanı isteğe bağlı: müşteri numune/ürün kodu,
  Alen ürün kodu, numune miktarı, teslim tarihi) + NUMUNE ÜRETİM BİLGİLERİ (fiyat teklif/numune net ağırlığı, üretim süresi,
  hammadde, alternatif hammadde, kullanılan mastar/lar, üretim miktarı, ayrılan örnek miktarı, üretim tarihi, GKK rapor no,
  gönderilen miktar) → "Formu oluştur" ile kayıt açılır (kod verilir, pencere kapanmaz: artık "düzenle" görünümüne geçer) →
  "Formu görüntüle/yazdır" ile A4 dikey çıktı alınıp müşteriye gönderilir (fiziksel/e-posta) → müşteriden gelen karar
  **elle**, "Düzenle"den **✓ Onaylandı** / **✕ Onaylanmadı** ile işaretlenir (karar tarihi + onaylandıysa isteğe bağlı not,
  reddedildiyse **"Ret sebebi ve müşteri rapor no"** — kâğıt formun kendi SONUÇ bölümü alan adlarıyla birebir); yanlış
  işaretlenen karar **"Kararı geri al"** ile `bekliyor`'a döner. Satır rengi yeşil/kırmızı/sarı, **her zaman ikon+etiket
  çipiyle birlikte** (CLAUDE.md §7: renk tek başına anlam taşımaz): `chip('ok','✓','onaylandı')` / `chip('bad','✕',
  'onaylanmadı')` / `chip('warn','◔','karar bekliyor')`; yeni `.pl-rejected` satır sınıfı (kırmızı ton, `.chip-bad`/
  `.badge.st-alarm`'la aynı aile) — `.pl-waiting`/`.pl-done` zaten vardı, `.pl-cancelled` (iptal) bu amaçla kullanılmadı.
- **Kod:** kâğıt defterin kendi "SERİ NO"su gibi **6 haneli, yıl ÖNEKİ YOK, düz artan sıra** (`000001`…; ürün tanıtım
  kartının `K000001` deseniyle aynı mantık — GKK/ilk onay'ın yıl-içi sayaçlarından FARKLI). Kâğıt defterde hâlâ kullanılan
  bir sıra varsa ekranın altındaki kutudan (yalnız admin) bir kez taban girilir; taban yalnız yükseltilebilir.
- **Backend:** `backend/planning/sample-tracking.js` (`SampleTracking`, tablo `sample_requests` `planlama.db`'de; kendi
  `counters` satırını `name='numune', year=0` ile paylaşılan `counters` tablosunda tutar — tabloyu kendi `CREATE TABLE IF
  NOT EXISTS`'i ile kurar ki hangi modülden önce ilklenirse ilklensin bağımsız çalışsın). `planning.js`'te `this.samples =
  new SampleTracking({ planning: this })`. Doğrulayıcılar (`text`/`number`/`day`) ortak `fields.js`'ten — yeni kopya
  YAZILMADI. Kısmi güncelleme (`update`) iş emri "Düzenle"siyle aynı mantık: yalnız gönderilen alanlar değişir; `requestedOn`
  NOT NULL olduğu için boş gönderilirse dokunulmaz (temizlenmez). Onaylanmış/reddedilmiş bir kayıt da düzenlenebilir
  (müşteri bilgisi sonradan düzeltilebilsin diye) ve **silinebilir** (yalnız admin; bu geçmiş bir üretim kaydı değil, yanlış
  açılmış bir formdur — GKK/ilk onay kayıtlarıyla aynı "admin silebilir" ilkesi).
- **Ekran:** `dashboard/planning-numune.js` — `renderSamples` (arama/durum süzgeci, "Listeyi yazdır", sayaç tabanı kutusu),
  `openSampleDialog` (oluştur/düzenle/karar/geri al/sil, tek dosyada), `sampleFormHtml`/`openSampleForm` (A4 dikey, kâğıt
  formun bölümleriyle birebir: NUMUNE TANIMLAMA · NUMUNE ÜRETİM BİLGİLERİ · MÜŞTERİ GERİ BİLDİRİM · SONUÇ). Liste yazdırma
  `openListPrint`, tekil form yazdırma `printModal` (ikisi de `planning-common.js`'teki paylaşılan yardımcılar).
- **Ekran kaydı:** `shared/screens.js`/`dashboard/screens.js`'e `{ id: 'numune', label: 'Numune takip', app: 'planlama',
  writable: true }` (iki dosya birebir aynı kalmalı, `apps.test.js` denetler); `policy.js` `SCREEN_ROUTES`'a GET→read,
  POST/PUT/decide/reopen→write; sıra tabanı (PUT) ve DELETE **kayıtsız bırakıldı** → admin'e düşer (GKK/ilk onay'daki
  "okuma herkese, yazma role'e, idari işlemler admin'e" deseniyle aynı).
- **Uçlar:** `GET /api/planning/samples?q=&status=` · `POST /api/planning/samples` · `GET/PUT /api/planning/samples/:id` ·
  `DELETE /api/planning/samples/:id` (admin) · `POST .../samples/:id/decide {status, decidedOn?, note?}` ·
  `POST .../samples/:id/reopen` · `PUT /api/planning/samples/sequence {last}` (admin).
- **Rota düzeltmesi (aynı gün bulundu):** `dashboard/app.js`'teki hash-yönlendirme düzenli ifadesi (`pm`, `readRoute()`)
  yeni ekranlar eklenince TEK TEK güncellenmesi gereken ayrı bir liste — `numune` eklenmeyi UNUTULMUŞTU: `#/planlama/numune`
  sessizce (konsolda hata yok) Telemetri filo ekranına düşüyordu, çünkü regex eşleşmeyince kod en sondaki `else` dalına
  (`state.view = 'fleet'`) iniyordu. Backend tarafı (policy.js, screens.js, apps.test.js) zaten doğruydu; yalnız bu
  istemci-içi rota listesi atlanmıştı. Düzeltildi (`pm` regex'ine ve baştaki yorum satırına `numune` eklendi).
- **Doğrulama:** `backend/planning/sample-tracking.test.js` (9 test: oluşturma, kısmi güncelleme + NOT NULL tarih koruması,
  karar/geri al, liste arama-süzme-sıralama, sayaç tabanı, silme, uçtan uca HTTP). `npm test` 587/587 yeşil. Tarayıcıda
  gerçek sunucuya (AUTH_DISABLED) karşı uçtan uca denendi: kayıt oluşturma (tüm alanlar + GKK "Listeden seç…" — boş
  geliştirme veritabanında beklendiği gibi "Eşleşen kayıt yok" dedi), onaylama (yeşil satır + ✓ çip), reddetme (kırmızı
  satır + ✕ çip, "Ret sebebi ve müşteri rapor no" alanı), tekil form yazdırma önizlemesi (GKK RAPOR NO etiketi doğru, SONUÇ
  bölümü), liste yazdırma önizlemesi; konsolda hata yok.

**Analiz · ret oranı eklendi (2026-11-09, kullanıcı isteği):** "ay/3 ay/6 ay/yıllık ret oranı, hazır seçimler dışında takvimden
aralık da seçilsin" — listenin üstünde "Analiz" paneli: **Bu ay / Son 3 ay / Son 6 ay / Bu yıl** hazır seçimleri (kendi
`STATS_PRESETS`, `planning-common.js`'teki `RANGE_PRESETS` [bugün/ay/geçen ay/30 gün] ile AYNI amaç değil — farklı kümeleme,
bu yüzden kendi listesi) **+ takvimden serbest Başlangıç/Bitiş** (ikisi de `RANGE_PRESETS`'in kullandığı `dateKey`/tarih kutusu
deseniyle, `material.js`'teki "Tarih aralığı" bar'ıyla aynı iskelet).
- **Hesap, "karar tarihine göre" (bilinçli seçim):** ret oranı = reddedilen ÷ (onaylanan + reddedilen), **yalnız `decidedOn`
  bu aralıkta olan kayıtlardan** — "bekliyor" (henüz karar gelmemiş) bir kayıt pay/paydaya giremez, aralığa dahil edilirse oran
  yapay düşük çıkardı. Aynı aralıkta **"talep edilen"** (`requestedOn`) ayrı, bağlam amaçlı bir sayıdır (farklı tarih alanı —
  bu aralıkta talep edilip kararı henüz gelmemiş kayıtlar olabilir, bu yüzden decided ile requested birbirine KARIŞTIRILMAZ,
  arayüzde ayrı hint metniyle açıklanır) ve "hâlâ bekleyen" (talep edilenlerden `status='bekliyor'` olanlar) onun yanında.
  Hiç karar yoksa oran `null` döner (`0` DEĞİL — CLAUDE.md §7 "okunamayan alan null" kuralı).
- **Backend:** `sample-tracking.js`'e `#dayRange` (planning.js'teki ÖZEL/private `#dayRange`'in AYNI mantığı — `shared/shifts.js`
  `dateKey/parseDateKey/addDays/daysBetween`'den, 400 gün sınırı; Planning'in private metodu submodüllere açık olmadığı için
  kopyalanmadı, doğrudan paylaşılan düşük seviye tarih yardımcılarından kuruldu — her submodülün kendi kendine yeten olma
  ilkesiyle aynı) + `rejectionStats({from, to, now})` eklendi. Uç: `GET /api/planning/samples/stats?from=&to=` (vars. aralık bu
  ayın başından bugüne; `policy.js`'te `numune`/`read` — zaten listeyi görebilen herkes analizi de görür).
- **Dosyalar:** `backend/planning/sample-tracking.js`, `routes.js`, `backend/auth/policy.js`, `dashboard/planning-numune.js`
  (`STATS_PRESETS`, `pct()`, `drawStats`/`loadStats`, `renderSamples`'e eklenen state ve olay dinleyicileri — yeni ekran/uç
  İCAT EDİLMEDİ, var olan `numune` ekranının içine bir panel).
- **Doğrulama:** `sample-tracking.test.js`'e 2 test (karar tarihine göre dağılım + talep edilen/bekleyenin farklı tarih
  alanından sayılması, aralık dışı kararın sayılmaması; varsayılan aralık + hiç karar yokken `null` oranı + geçersiz/400 günden
  uzun aralığın reddi) + HTTP testine `/samples/stats` eklendi. `npm test` 685/685 yeşil. Tarayıcıda gerçek sunucuya
  (AUTH_DISABLED, gerçek 2 kayıtlı dev veritabanı) karşı uçtan uca denendi: "Bu ay" varsayılanında %50 ret oranı (2 karar · 1
  onay · 1 ret) + "talep edilen 2, 0 bekliyor" doğru göründü; "Son 6 ay" tıklanınca tarih kutuları `2026-06-01`/bugüne
  güncellendi (aynı veri, aynı sonuç); Başlangıç kutusuna elle `2026-01-01` yazılınca preset'ler pasifleşti ve
  `GET /api/planning/samples/stats?from=2026-01-01&to=...` isteği ağ sekmesinde doğrulandı.
- **DENENMEDİ:** gerçek yazıcıdan A4 baskı ve kâğıt EYS.FR.012 ile yan yana karşılaştırma; gerçek bir müşteri e-postasıyla
  üretimde kullanım (şimdilik yalnız sentetik veri); gerçek fabrika kullanımında aylar arası ret oranının tutarlılığı (yalnız
  2 kayıtlık dev verisiyle denendi, trend/mevsimsellik henüz görülmedi).

**Tezgaha bağlama + YENİ ürün kodu oluşturma + Mikro'ya yazma (2026-11-13, kullanıcı isteği):** üç ayrı istek aynı oturumda:
(1) "numune formları da makineye iş emri gibi bağlanabilmeli" — iş emrininkiyle AYNI `machineId` deseni (isteğe bağlı, serbestçe
değiştirilebilir, envanterdeki bilinen bir tezgaha ait olmalı; numunenin KENDİ bir başlat/bitir yaşam döngüsü YOK, yalnız
"hangi tezgahta üretildi/üretilecek" bilgisi). (2) Yeni numune formu açılırken **müşteri (sabit 19 grup, kodun EN SONUNDAKİ
3 hane) + kod öneki (SR/Nİ)** seçilirse Alen ürün kodu **otomatik üretilir**: o müşteri grubunun o önekteki EN BÜYÜK mevcut
ürün kartından bir sonraki kod (ör. SR015.011 varsa → SR016.011) — kullanıcının kendi tarifi: "bir önceki ürün kartı en son
yaratılan yani sr015.011 ... yeni numunenin kodu sr016.011 olacak". (3) Bu kod hem yerel bir ürün kartı AÇAR hem — arka
planda — Mikro'da da bir stok kartı oluşturmayı dener; numune net ağırlığı (ilk üretimde ölçülünce) girilince hem yerel
ürün kartına hem (yine arka planda) Mikro'daki o kartın ağırlığına yazılır.
- **Müşteri grubu listesi** (`backend/planning/sample-customer-groups.js`, 19 sabit grup — kullanıcı verdi: 001 Siamp …
  019 Klinger): `downtime-codes.json` ile AYNI ilke, kodda sabit, yönetici ekranından düzenlenemez (yeni grup elle eklenir).
  `GET /api/planning/samples/customer-groups` ile sunulur — `card-steps.js`'teki "dashboard'da ayrı kopya + eşitlik testi"
  deseni YERİNE (bu liste salt gösterim için, pure-JS mantık paylaşmıyor) `downtime-codes.js`'teki "backend'den API ile oku"
  deseni tercih edildi: dashboard hiçbir kopya TUTMAZ, tek kaynak backend.
- **Kod üretimi rezerve ETMEZ, önizlemedir** (iş emri numarasıyla/`nextSeq()` ile AYNI ilke): `SampleTracking.nextStockCode()`
  `products.code_key`'i `LIKE 'SR___.011'` deseniyle sorgular (foldTr ile büyük/küçük harf + Türkçe İ duyarsız), regex'le
  tam eşleşenleri alıp en büyük orta numarayı bulur — **ama SR VE Nİ'NİN İKİSİNE BİRDEN** (2026-11-16 düzeltmesi, aşağıdaki
  "SR/Nİ kod numaralandırması ORTAK" notuna bakın: bu ikisi aynı müşteri grubunda BAĞIMSIZ değil, TEK ortak bir sayaç).
  Gerçek ALLOCATION `create()` İÇİNDE, aynı senkron JS turunda yapılır (önizleme ile aralarında `await` yok) — iki kullanıcı
  aynı anda "oluştur"a basarsa ikinci istek `create()` anında TEKRAR hesaplar, çakışma olmaz (diğer tüm sayaçlarla — iş emri
  no, GKK no, kart no — aynı varsayım). **Elle yazılmış `stockCode` grup+önek birlikte verilince GÖZ ARDI EDİLİR** (sunucu
  kendi ürettiğini kullanır).
- **Ürün kartı SENKRON açılır, numune satırından ÖNCE** (`createProduct` başarısız olursa — örn. aşırı nadir bir çakışma —
  numune de hiç oluşmaz, yarım/sahipsiz kayıt kalmaz): `customerCode`/`material`/`altMaterial` numune formundan kopyalanır
  (`name` yok — numune formunda ürün adı alanı yok, kart adı boş açılır, sonra elle doldurulur). `createProduct` zaten HER
  ZAMAN `edited:true` işaretlediği için (`planning.js`), bu kart Mikro'nun `importSiparis` senkronunca sonradan ELE GEÇİRİLMEZ.
- **Mikro — YENİ bir yazma SINIFI (stok HAREKETİ değil, stok KARTININ KENDİSİ):** `mikro-stock.js`'e `previewCreateProduct`/
  `previewUpdateProductWeight` eklendi, ikisi de `StokKaydetV2` ucunu kullanır (Mikro'nun stok kategorisinde BUNDAN başka
  yazma ucu YOK — yalnız `StokListesiV2` okuma var, `apidocs.mikro.com.tr/apis/stok`'tan 2026-11-13'te doğrulandı; ham `.md`
  şeması `DahiliStokHareketKaydetV2` ile AYNI yapıda, `Mikro.stoklar[]`, yani `nestInMikro:true`). **BU İKİ UÇ, dosyadaki HER
  BAŞKA fonksiyonun aksine, GERÇEK MİKRO'YA KARŞI HENÜZ HİÇ DENENMEDİ** — yalnız resmi dokümantasyondan kuruldu:
  - `previewCreateProduct`: `sto_kod`/`sto_isim`/`sto_kisa_ismi`/`sto_birim1_ad` gönderir; vergi/cins gibi doğru değeri
    bilinmeyen alanlar GÖNDERİLMEZ (Mikro varsayılanı daha güvenli). Yeni, boş bir kod için çağrıldığından (hiçbir şeyin
    üzerine yazma riski yok) göreli olarak daha düşük riskli.
  - `previewUpdateProductWeight`: `sto_birim1_agirlik` (net kg) ekler — bu alan adı yalnız geçmiş `STOKLAR` OKUMALARINDAN
    biliniyor (BR/NT eşlemesi, §6 "G aşaması"), `StokKaydetV2`'nin RESMİ şema listesinde YOK: bir TAHMİN. **Daha önemlisi:**
    Mikro'nun bu alanı GÖNDERİLMEYEN alanları KORUYARAK mı (kısmi güncelleme) yoksa SIFIRLAYARAK mı (tam değiştirme)
    işlediği HİÇ BİLİNMİYOR — bu yüzden bu fonksiyon **yalnız sample-tracking.js'in KENDİ OLUŞTURDUĞU (`autoGenerated`)
    kodlar için** çağrılır, Mikro'da başka bir yolla (Mikro'nun kendi ekranı, Excel/Mikro senkronu) zaten var olan bir
    kartı güncellemeye KESİNLİKLE ÇALIŞILMAZ (tam değiştirme ihtimalinde o kartın adını/diğer alanlarını SESSİZCE
    SİLEBİLİRDİ). `sto_isim` yine de SAVUNMACI olarak her çağrıda yeniden gönderilir (en azından kendi oluşturduğumuz
    kartın adının kaybolmaması için).
  - **Fire-and-forget, `product-depot.js`'teki "dene ve logla" deseniyle AYNI:** `create()`/`update()` senkron döner,
    Mikro denemesi arka planda (`.catch(() => {})`), numune/ürün kartı kaydını ASLA engellemez/bozmaz. Durum
    `sample_requests`'e yeni sütunlarla yazılır (`mikro_product_sent/error`, `mikro_weight_sent_g/error` — tek deneme
    yeterli olduğu için `product_depot_transfers` gibi ayrı bir geçmiş tablosu YOK, yalnız SON durum). Elle yeniden
    deneme: `POST .../retry-mikro-product` · `POST .../retry-mikro-weight` (`numune`/write ile aynı yetki; yalnız
    `autoGenerated` numunede anlamlı, ağırlık için önce net ağırlık girilmeli olmalı — ikisi de 409 ile korunur).
  - `MIKRO_WRITE_ENABLED` gerçek kurulumda hâlâ varsayılan KAPALI (diğer her Mikro yazma türüyle aynı); bu iki uç ayrıca
    ayrı bir kapı GEREKTİRMEDİ, aynı anahtarı paylaşıyor.
- **Dosyalar:** `sample-customer-groups.js` (yeni), `sample-tracking.js` (`#migrate` ile eski veritabanlarına 8 yeni sütun:
  `machine_id`, `customer_group_code`, `code_prefix`, `auto_generated`, `mikro_product_sent/error`, `mikro_weight_sent_g/error`),
  `mikro-stock.js`, `routes.js`, `policy.js`, `dashboard/planning-numune.js` (yeni ürün kodu bloğu + Mikro paneli, "Tezgah"
  seçici), `dashboard/planning-common.js` (`machineOptions` buraya taşındı — `planning-workorders.js` da artık buradan
  alıyor, üçüncü bir kopya yazılmadı), `dashboard/planning-workorders.js` (kendi yerel kopyası kaldırıldı).
- **Doğrulama:** `sample-tracking.test.js`'e 10 test (grup listesi, `nextStockCode` önizlemesi — boş grup/var olan kodun
  üstü/onek bağımsızlığı/bilinmeyen grup-onek —, `create()` ile kod üretimi + elle yazılan kodun göz ardı edilmesi, Mikro
  ürün kartı denemesi başarılı/başarısız — sahte `MikroClient`, gerçek ağ yok —, net ağırlık senkronu — yerel kart HER ZAMAN,
  Mikro yalnız `autoGenerated` —, ürün kartı olmayan/limit dışı değerin numune kaydını bozmaması, `retryMikroProduct`/
  `retryMikroWeight` kısıtları, tezgah bağlama) + yeni bir HTTP testi (`customer-groups`, `next-stock-code`, retry uçları).
  `backend/auth/policy.test.js`'e 1 test (yeni uçların `numune` read/write sınıflaması). `npm test` 757/757 yeşil.
  **Tarayıcıda gerçek sunucuya (AUTH_DISABLED, gerçek dev `data/planlama.db`) karşı uçtan uca denendi:** "Yeni numune formu
  aç" → "011 — Konveyör" + "SR" seçilince müşteri alanı "Konveyör" ile doldu, Alen ürün kodu "SR132.011" ile kilitlendi ve
  salt-okunur oldu (gerçek veride zaten 131 SR…011 vardı); önek "Nİ"ye çevrilince ANINDA "Nİ001.011"e güncellendi — bu sırada
  daha önce yazılmış "Müşteri numune kodu" alanı SİLİNMEDİ (tam `draw()` değil, yalnız ipucu + Alen kodu alanı hedefli
  güncellendi — ilk tasarımda tam redraw vardı, bu test sırasında yazılan metnin silineceği fark edilip `refreshGenUI()`
  ile düzeltildi). Kaydedince gerçek ürün kartı açıldı, "Yeniden dene" gerçek 409/kapalı hatasını (`MIKRO_WRITE_ENABLED`
  bu dev sunucusunda kapalı) doğru gösterdi; "Numune net ağırlığı" 8,25 gr girilince ürün kartının `netKg`'si API'den
  `0.00825` olarak doğrulandı. Test kaydı (numune) `DELETE` ile temizlendi; oluşan test ürün kartının (`SR132.011`) silme
  ucu YOK (ürün kartları kalıcıdır, sistemde hiç silme ucu yok) — zararsız, boş bir kart olarak dev veritabanında kaldı.
- **GERÇEK MİKRO'YA KARŞI DENENDİ VE DOĞRULANDI (2026-11-16, yönetici ile birlikte, Klinger SR006.019 + Ayvaz Nİ199.002, ikisi de test sonrası yönetici tarafından Mikro'dan elle silindi — salt okuma ile temizlendiği doğrulandı):**
  - **Yeni stok kartı oluşturma — `StokKaydetV2` + `user_tablo` (dokümante edilmemiş ama gerçekten çalışıyor):** `StokKaydetV2`'nin resmi şemasında `user_tablo` YOK, ama `DahiliStokHareketKaydetV2`/`MuhasebeFisKaydetV2`'de resmi olarak var olan bu mekanizma `StokKaydetV2`'de de kabul ediliyor — `stoklar[0].user_tablo: [{MAKINA, HAMMADDE, ALISIM, TAM_BOY}]` gönderilince Mikro **STOKLAR_USER satırını kendisi açıp Record_uid'i yeni kartın Guid'ine otomatik bağlıyor** (biz Guid belirtmiyoruz). İki gerçek denemede de (SR ve Nİ önekiyle) `STOKLAR` + `STOKLAR_USER` birebir gönderdiğimiz değerlerle doğrulandı (salt okuma). `sto_cins: 4` (Mamül) de aynı çağrıda gönderiliyor (bkz. aşağıdaki not).
  - **ÖNEMLİ, `previewUpdateProductWeight()`'in TÜM TASARIMINI GEÇERSİZ KILAN bulgu — `StokKaydetV2` INSERT-ONLY:** var olan bir `sto_kod`'u ikinci kez `StokKaydetV2`'ye göndermek (ağırlık güncellemek için denendi) **HER ZAMAN** şu hatayla reddediliyor: `"Stok kodu: SR006.019, Gönderilen stok sistemde mevcuttur!"` — hiçbir şey yazılmıyor (salt okuma ile doğrulandı: ağırlık hâlâ 0). Yani önceki tasarımın dayandığı "kısmi mi tam değiştirme mi" sorusu hiç gündeme gelmiyormuş; `previewUpdateProductWeight()` (`mikro-stock.js`) bu haliyle **kesin olarak bozuk** — gerçek kullanımda her zaman bu hatayla başarısız olur.
  - **Var olan kartı güncelleme — DOĞRU yol `KayitKaydetV2` (genel, tablo-no'lu uç), `Tablo:[{No:'13', KayitTipi:'1'}]`:** STOKLAR'ın resmi Tablo No'su (13, `tablo-alan-adlari/stoklar.md`'den — TAHMİN değil) ile `Kayit:[{sto_kod:'SR006.019', sto_birim1_agirlik:0.0125}]` gönderilince **İLK denemede** `StatusCode:200` ile kabul edildi; salt okuma ile doğrulandı: `sto_birim1_agirlik` gerçekten 0,0125 oldu, `sto_isim`/`sto_cins` (bu çağrıda hiç gönderilmedi) **bozulmadı** (gerçek kısmi/merge güncelleme, tam değiştirme DEĞİL) ve **STOKLAR_USER'daki 4 alan (MAKINA/HAMMADDE/ALIŞIM/TAM_BOY) bu STOKLAR-only güncellemeden hiç etkilenmedi** (ayrı tablo). Bu, önceki "KayitKaydetV2 ile rastgele tablo no denemeyelim" kararını BOZMUYOR — buradaki tablo no (13) rastgele değil, resmi dokümandan kesin biliniyordu.
  - **Sonuç:** numune akışının Mikro'ya yazma mantığı artık NET: **yeni kart → `StokKaydetV2` + `user_tablo`**, **var olan kartı güncelle (ağırlık dahil) → `KayitKaydetV2` Tablo No 13, KayitTipi '1'**.
  - **`mikro-stock.js`'teki `previewCreateProduct`/`previewUpdateProductWeight` bu bulgulara göre DÜZELTİLDİ (aynı gün, kod değişikliği — gerçek Mikro'ya BİR DAHA yazılmadı, yalnız sahte istemciyle birim testiyle doğrulandı):**
    - `previewCreateProduct` artık isteğe bağlı `hammadde`/`tamBoy`/`makina`/`alisim` parametreleri alıyor, doluysa `user_tablo`'yu kuruyor (hiçbiri verilmezse `user_tablo` hiç gönderilmiyor). Çağıran (`sample-tracking.js` `#pushMikroProductCard`) artık numunenin kendi `material`/`lengthMm` alanlarını `hammadde`/`tamBoy` olarak geçiriyor — `makina`/`alisim` için gerçek bir numune alanı olmadığı için şimdilik hep boş kalıyor (Mikro'da elle doldurulur).
    - `previewUpdateProductWeight` artık `StokKaydetV2` DEĞİL `KayitKaydetV2` (Tablo No 13, KayitTipi '1') kullanıyor; `name`/`unit` parametreleri kalktı (kısmi güncelleme kanıtlandığı için `sto_isim`/`sto_cins`'i savunmacı olarak yeniden göndermeye gerek kalmadı). Çağıran (`#pushMikroWeight`) sadeleşti.
    - Testler: `sample-tracking.test.js`'e yeni test (`user_tablo` hammadde/tamBoy verilince kuruluyor, verilmezse hiç gönderilmiyor) + var olan ağırlık testi yeni `KayitKaydetV2`/`Kayit`/`Tablo` gövde şekline güncellendi. `npm test` 767/767 yeşil.
  - **MAKINA/ALIŞIM için henüz gerçek bir kaynak alan YOK** (testte `MAKINA:'CNC_1'`, `ALIŞIM:'ALAŞIM CW617N'` gibi değerler elle/mantıken verildi, numune formunda karşılığı yok) — fonksiyon kabul ediyor ama numune akışı şimdilik hiç göndermiyor.
  - **SR/Nİ kod numaralandırması ORTAK, BAĞIMSIZ DEĞİL — gerçek hata bulunup düzeltildi (aynı gün):** yukarıdaki Nİ199.002 denemesi sırasında yönetici gerçek Mikro verisine bakıp düzeltti: Ayvaz (.002) grubunda **SR201.002 varken Nİ yalnız Nİ198.002'ye kadar çıkmıştı** — ikisi bağımsız sayılsaydı bu fark (SR'nin daha sık seçilip önde gitmesi) oluşmazdı; **SR ve Nİ AYNI müşteri grubunda TEK, ORTAK bir sayaçla ilerliyor**. Önceki tasarım (ve bu dosyanın önceki bir sürümündeki "Farklı onek (Nİ) AYNI grupta BAĞIMSIZ sayılır" notu) **YANLIŞTI** — bu yüzden Nİ199.002 hatalı üretilip gerçek Mikro'ya yazılmıştı (sonradan silindi). **Düzeltildi** (`sample-tracking.js` `nextStockCode()`): artık seçilen önekten bağımsız olarak SR VE Nİ'nin İKİSİNE birden bakılıp en büyüğünden devam ediliyor. Testi güncellendi (`sample-tracking.test.js`, "SR ve Nİ ORTAK sayılır"), `npm test` 766/766 yeşil.
  - **Gerçek yazıcıdan baskıda yeni "TEZGAH" satırının görünümü, büyük müşteri grubu/önek kombinasyonunda (>999) kod taşması (teorik, şu an hiçbir grup/önekte 200'den fazla kod yok) hâlâ DENENMEDİ.**

**Numune formunda hammadde seçimi (elle yazılmaz) + teknik resim ekleme (2026-11-13, kullanıcı isteği, AYNI oturum):** "hammade seçimi olsun elle yazılmasın komple teknik resim de eklenebilsin" — yukarıdaki bölümün hemen ardından, aynı ekrana iki küçük ama ayrı ekleme.
- **Hammadde/Alternatif hammadde artık Mikro'dan CANLI arama ile seçilir, elle yazılamaz** (`dashboard/planning-numune.js` `matField`/`matFieldButtons`/`refreshMatField`/`openMaterialPicker`): alan salt-okunur bir giriş + "Seç…"/"Değiştir"/"Temizle" düğmeleri (`openGkkPicker` ile AYNI desen — arama kutusu, debounce, sonuç tablosu, satırda "Seç"). Değer `matState` adlı ayrı bir JS state'inde tutulur ve **yalnız o alanın girişi + düğmeleri hedefli güncellenir** (`refreshMatField`): `gen`-state'teki (müşteri grubu/önek) AYNI "tam `draw()` o ana kadar yazılan diğer alanları silerdi" gerekçesi burada da geçerli, bu yüzden `gen-group` değişince dokunulan hedefli-güncelleme deseni YENİDEN KULLANILDI.
  - **Dar, ekrana özel arama ucu** (`programs/product-search`'teki AYNI ilke — bkz. §6 "Fabrika (operatör) hesabında Program eşleme"): `hammadde` ekranının kendi `GET /api/planning/material/mikro/materials` ucunu YENİDEN KULLANMAK yerine, `numune`'ye özel **`GET /api/planning/samples/materials`** eklendi (`routes.js`, zaten var olan `planning.mikroStock.searchMaterials(q, limit)`'i çağırır) — `numune`-özel bir rolün (ör. yalnız `numune` yetkisi olan bir rol) `hammadde` ekranına erişimi olmayabileceği için, numune ekranının hammadde araması o ekranın KENDİ yetkisinden (`numune`/read) geçmeli, `hammadde` ekranının yetkisine bağımlı olmamalı.
- **Teknik resim (PDF) ekleme — `wo_drawings`/`drawing_files` (iş emri teknik resimleri, §6 "GKK, ilk onay, teknik resim PDF'leri…") ile AYNI içerik-adresli depo deseni, YENİ bir tablo:** `sample_drawings` (`sample_id, name, sha, sort, added_at, added_by`; `drawing_files`'ın KENDİSİ YENİDEN KURULMAZ — `Quality`, `Planning`'in constructor'ında `SampleTracking`'den ÖNCE kurulduğu için paylaşılan tablo zaten var, `price-studies.js`'in de aynı şekilde yaptığı gibi). En çok 8 PDF, her biri `MAX_DRAWING_BYTES` (20 MB); `inspectPdf`/`PdfError` ile geçersiz/şifreli PDF 422 `bad-pdf`; aynı SHA'lı dosya 409 `duplicate`.
  - **Bilinçli KOPYALAMA kararı:** var olan `dashboard/planning-drawings.js` (`drawingsEditorHtml`/`wireDrawings`, iş emri teknik resimleri) genelleştirilip numune için de kullanılabilirdi; zaten çalışan iş emri özelliğini bozma riskinin, küçük bir kod tekrarından daha ağır bastığına karar verildi — `planning-numune.js` içine yapısal olarak BENZER ama AYRI `drawingsHtml()`/`refreshDrawings()`/`uploadDrawings()` yazıldı (yükleme mantığı `wireDrawings`'in sırayla-yükle-hata-çıkınca-dur desenini BİREBİR izler).
  - **PDF birleştirme YOK** (iş emri formu + resimler tek PDF'te birleşiyordu, §6): numune kaydının yazdırılabilir formu (EYS.FR.012) zaten tek sayfalık bir kâğıt form taklidi; teknik resimler yalnız ayrı ayrı "Aç" bağlantısıyla (yeni sekmede) görüntülenir, forma gömülmez.
- **Gerçek, önceden var olan bir hata bulundu ve düzeltildi (bu özelliği eklerken fark edildi, kullanıcı bildirmedi):** `quality-db.js`'teki paylaşılan `#dropFileIfUnused(sha)` (bir PDF blob'unun silinmeden önce BAŞKA bir tüketicide kullanılıp kullanılmadığını sayan fonksiyon) yalnız `wo_drawings` + `product_files`'ı sayıyordu, **`price_studies`'i HİÇ SAYMIYORDU** — yani bir iş emri resmiyle AYNI PDF'i paylaşan bir fiyat çalışması, iş emri tarafındaki kopya silinince blob'u KAYBEDEBİLİRDİ (fiyat çalışmasının kaydı bozulurdu). `sample_drawings` eklenince bu sayım 4'e (hepsi) çıkarıldı; aynı düzeltme `price-studies.js`'in kendi `delete()`'indeki ayrı kopya sayım sorgusuna da uygulandı. Yeni bir testle (`'teknik resim: baska bir numune/is emri/urun/fiyat calismasiyla AYNI PDF paylasilirsa silinince blob KAYBOLMAZ...'`) doğrulandı.
- **Uçlar:** `GET /api/planning/samples/materials?q=&limit=` · `GET/POST /api/planning/samples/:id/drawings` (liste / yükle, gövde = ham PDF, `?name=`) · `GET /api/planning/samples/:id/drawings/:did` (indir/görüntüle, herkese: `numune`/read) · `DELETE /api/planning/samples/:id/drawings/:did` (`numune`/write). `policy.js` `SCREEN_ROUTES`'a 5 yeni satır.
- **Testler:** `sample-tracking.test.js`'e 5 yeni test (hammadde araması HTTP üzerinden Mikro canlı aramaya gidiyor mu, PDF ekle/listele/indir/kaldır + geçersiz/bozuk/tekrar/sınır senaryoları, en çok 8 PDF, çapraz tüketici sayımı — yukarıdaki hata, tam HTTP uçtan uca round-trip) + `policy.test.js`'e 1 test. `npm test` 763/763 yeşil (757'den, bu özellikle +6).
  **Tarayıcıda gerçek sunucuya (AUTH_DISABLED) karşı uçtan uca denendi:** yeni numune formunda Hammadde alanı salt-okunur + "Seç…" ile açılıyor, arama kutusuna yazınca `openGkkPicker`'daki/Hammadde ekranındaki AYNI "MikroAPI yapılandırılmadı (ortam değişkenleri eksik)" hatası doğru göründü (bu dev sunucusunda Mikro yapılandırılmadığı için beklenen); formu kaydedip gerçek bir numune açıldıktan sonra "Teknik resimler (PDF)" bölümü belirdi, `curl` ile gerçek bir PDF yüklendi (`POST .../drawings`), sayfa yeniden yüklenince dashboard'da doğru ad/boyut/sayfa sayısıyla listelendi, "Aç" bağlantısının `href`'i doğruydu ve sunucu gerçekten `content-type: application/pdf` ile yanıtladı, `DELETE` ile kaldırma da doğrulandı. Test kaydı (numune + yüklenen PDF) temizlendi.
- **DENENMEDİ:** tarayıcının native dosya seçiciyle PDF yükleme (bu oturumda da, projedeki diğer Excel/PDF içeri alma özellikleriyle AYNI bilinen sınır, yalnız ham HTTP çağrısıyla test edildi) ve `window.confirm()` ile PDF kaldırma onayının uçtan uca tıklanması (kod incelemesiyle doğrulandı, bu oturumun tarayıcı aracında native onay penceresi sınanamadı — Hurda Girişi/Numune Takip'teki AYNI bilinen sınır); gerçek bir teknik resim PDF'i ile fabrika kullanımı.

**İki arayüz hatası, fabrika PC'sinin gerçek ekran görüntüsünden bulundu (2026-11-13, kullanıcı isteği):**
- **İş emirleri listesinde ürün kodu kesiliyordu:** `dashboard/planning-workorders.js`'teki ÜRÜN hücresi stok kodu + ürün adını TEK `<td class="trunc">` içine koyup TÜM hücreyi kırpıyordu (`.tbl td.trunc{max-width:1px;...}` hilesi dar sütunda stok kodunun kendisini bile "SR018..." diye kesiyordu — `planning-products.js`'teki doğru desende kod ve ad zaten AYRI hücrelerdeydi, burada tek sütuna sıkıştırılırken bu ayrım kaybolmuştu). Düzeltme: yeni `.prod-cell`/`.prod-name` CSS çifti (`styles.css`) — kod hücrenin DIŞINDA, her zaman tam görünür; yalnız ad `display:inline-block;max-width:200px` ile (gerekirse) kısalır, kod bu sınırdan ETKİLENMEZ. **Aynı anti-örüntü (kod+ad tek kırpılan hücrede) 5 başka dosyada 9 yerde daha bulundu ve AYNI düzeltmeyle giderildi** (kod taraması, kullanıcı yalnız iş emirleri sayfasını bildirdi ama sistemik bir kopyala-yapıştır hatasıydı): `planning-approvals.js` (ilk onay için aktif iş emri listesi), `planning-efficiency.js` (termin riski, ürün bazında, gün bazında tabloları — 3 yer), `planning-packing.js` (kasa listesi), `planning-material.js` (sarfiyat, üretimdeki iş emirleri, ihtiyaç — 3 yer), `planning-reports.js` (ölçü raporları listesi). Tarayıcıda gerçek dev verisiyle (119 iş emri) hem 1900 px hem 1200 px genişlikte doğrulandı: kod her zaman tam, yalnız uzun adlar kısalıyor.
- **Siparişler ekranında ürün adıyla arayınca, eşleşen siparişler listeleniyor ama siparişin İÇİNDEKİ hangi ürünün eşleştiği belli olmuyordu** (`backend`'in `searchOrders`'ı zaten `code_key`/`item_key` üzerinden ürün koduna/adına göre de eşleştiriyordu — §9 API tablosundaki "müşteri ya da ürün ara" — ama `dashboard/planning-orders.js`'teki `showLines()` siparişin TÜM satırlarını farksız gösteriyordu). Düzeltme: `library-view.js`'teki "eşleşen kısmı `<mark>` ile vurgula" deseni (`searchRe`/`hl`) buraya da taşındı (`hlCell`, `cellText`'in boş/null davranışını da korur) — ürün kodu/adı hücrelerinde arama terimiyle eşleşen kısım vurgulanır VE eşleşen satırın tamamı hafif bir vurgu (`tr.pl-hit`, `--accent-soft`) alır (uzun/çok satırlı siparişlerde tek başına `<mark>` sütun kırpılırsa gözden kaçabilir, satır vurgusu her zaman görünür). `mark` stili (`styles.css`) artık `.grp` ile sınırlı değil (program kütüphanesi arama vurgusuyla AYNI renk formülü, genelleştirildi — tek başka kullanıcı `library-view.js`'ydi, davranışı DEĞİŞMEDİ). Tarayıcıda gerçek dev verisiyle ("BAFFLE PLATE" araması → 10 sipariş, birinin 36 satırından yalnız 2'si hem `<mark>`'lı hem `pl-hit` satır vurgulu) doğrulandı.
- Her iki düzeltme de yalnız CSS/dashboard JS; backend/API değişmedi, `npm test` 763/763 yeşil kaldı (bu değişiklikler backend testlerine girmiyor, yalnız tarayıcıda doğrulandı).
- **DENENMEDİ:** gerçek fabrika PC'sinde, kullanıcının kendi ekran çözünürlüğü/yakınlaştırmasıyla doğrulama (yalnız bu oturumda 1200–1900 px arası simüle edildi); diğer ekranlarda (varsa) aynı kod+ad kırpma deseninin BAŞKA bir kopyası kalmış olabilir (taranan tüm `.trunc` + stockCode/mono-span kombinasyonları düzeltildi, ama yeni bir ekran eklenirken aynı hata tekrarlanabilir).

**Yazdırma önizlemesi pencereleri aşağı kaydırılamıyordu (2026-11-13, aynı gün, kullanıcı ekran görüntüsüyle bildirdi):** "Ürün tanıtım kartı" ve "başka bazı popup ekranları" — kart basmadan önceki önizleme, kartta çok satır (YIKAMA/KURUTMA/TAVLAMA/ÜRÜN RET) olunca pencere altta kesiliyor, fare tekerleğiyle de kaydırılamıyordu. Neden: `dialog.pl-form-dlg .modal-body{overflow:hidden;}` (`styles.css`) — bu kural **TÜM** yazdırma-önizlemeli pencerelere (`m.dlg.classList.add('pl-form-dlg')` çağıran her ekran: `planning-common.js`'teki paylaşılan `printModal`/`openListPrint`, `planning-numune.js`, `planning-hurda.js`, `planning-card.js` ×2, `planning-packing-form.js`, `planning-price.js`, `planning-measure.js` ×2, `planning-wo-form.js`) uygulanıyordu, ama yalnız **TEK BİR** tüketici (`planning-wo-form.js`'teki iş emri formu + PDF penceresi) buna gerçekten ihtiyaç duyuyordu — o pencerede `.pl-f-pdf` iframe'i `flex:1 1 auto;height:calc(100vh - 210px)` ile KENDİ iç kaydırmasını yapıyor, dış gövdenin `overflow:hidden` olması "kaydırma tek sahiplidir" tasarımının gereğiydi (bkz. `styles.css`'teki eski yorum). Diğer dokuz pencerede böyle bir iç-kaydırmalı eleman YOK; onlar yalnızca `.modal-body`'nin VARSAYILAN `overflow:auto`'suna güveniyordu ve bu kural onu her yerde sessizce eziyordu.
- **Düzeltme:** `dialog.pl-form-dlg .modal-body`'den `overflow:hidden` kaldırıldı (artık yalnız arka plan rengini verir, kaydırma varsayılana döner); yeni, DAHA ÖZGÜL bir sınıf **`pl-form-dlg-pdf`** eklendi ve `overflow:hidden` yalnız ona taşındı. `planning-wo-form.js` dialog'a `classList.add('pl-form-dlg', 'pl-form-dlg-pdf')` ile İKİ sınıfı birden ekliyor (yazdırma `@media print` kuralları hâlâ `pl-form-dlg`'e bakıyor, dokunulmadı); diğer dokuz pencere yalnız `pl-form-dlg` taşıdığı için artık normal kaydırıyor.
- **Tarayıcıda gerçek sunucuya karşı doğrulandı (1300×650, dar pencere, sorunu güvenilir biçimde tekrar üretmek için):** "Ürün tanıtım kartı" önizlemesi artık fare tekerleğiyle aşağı kaydırılıp kartın en altındaki ÜRÜN RET satırına kadar ulaşılabiliyor; "İş emri formu" (PDF) penceresi incelendi — `getComputedStyle` ile `.modal-body`'nin hâlâ `overflow:hidden` olduğu ve PDF iframe'inin kendi alanını doldurduğu doğrulandı (regresyon yok); "Numune Talep/Takip Formu Listesi" yazdırma önizlemesi (küçük, zaten sığan içerik) değişmeden çalışıyor. `npm test` 763/763 yeşil kaldı (CSS/JS-only, backend testlerine girmiyor).
- **DENENMEDİ:** diğer yedi `pl-form-dlg` penceresinin (hurda formu, paketleme formu, fiyat çalışması, ölçü föyü/planı, GKK/ilk onay liste yazdırma) her biri gerçek, UZUN içerikle (bu oturumda yalnız ürün tanıtım kartı ve numune listesi denendi) tek tek doğrulanmadı — aynı CSS kuralına bağlı oldukları için düzelmiş olmaları beklenir ama görsel olarak teyit edilmedi.

### Hurda Girişi (Karantina Alanı Giriş-Çıkış Formu EYS.FR.043 + Tashih Sonrası Tekrar Kontrol Formu EYS.FR.049) — 2026-11-04, kullanıcı isteği

Paketlemedeki hurdadan (`packing.js` `scrapQty`) **AYRI** bir süreç: ÜRETİM sırasında fark edilen hurda/uygunsuz parça
fiziksel karantina alanına çekilir. Kullanıcının kendi tarifi (iki fotoğraflanmış kâğıt formdan): "üretimde hurda
olduğunu fark ediyorlar, hurdalar karantinaya çekiliyor... giriş ve çıkış arasında bu hurdalar tashih ediliyor".

- **Akış:** "Yeni giriş kaydı aç" → ürün tanımı (stok kodu/tanımı, serbest metin), ürün tanıtım form numarası (isteğe
  bağlı, genelde Ürün Tanıtım Kartı K0000xx'e işaret eder ama kâğıt örneklerde başka biçimler de var → serbest metin,
  **ayrı bir FK/sayaç İCAT EDİLMEDİ**), uygunsuzluk tanımı, giriş tarihi (vars. bugün), giriş yapan personel → kayıt
  **"açık"** olarak listede durur (İş emirleri listesiyle aynı desen: liste + satıra bas = ayrıntı) → giriş ile çıkış
  arasında **sıfır ya da daha fazla TASHİH** (EYS.FR.049) denemesi kaydedilir: tarih, tashih yapan operatör, yapılan
  tashihin tanımı, tashih edilen adet, O.K. adedi, hurda adedi, sarf edilen adam×saat, açıklama ("Tashih ekle…" ile
  aynı pencerede açılan alt form; **ürün kodu tekrar sorulmaz**, zaten üst kaydınkinden gelir) → **"Çıkış yap…"** ile
  kayıt kapanır (çıkış nedeni, çıkış tarihi, çıkış yapan personel). Yanlışlıkla yapılan çıkış **"Girişi geri al"** ile
  geri alınabilir (çıkış alanları temizlenir); kapanmış bir kayda tashih eklenemez (önce geri alınmalı, 409).
- **`products` tablosuyla HİÇ BAĞLANMAZ** (Numune Takip / Fiyat çalışması ile aynı ilke): kâğıt formdaki örneklerde
  ürün tanımı çoğunlukla düz Mikro/müşteri stok kodu, her zaman Alen SR0xx.xxx biçiminde değil.
- **Görüntü kodu (`H000001`…) ayrı bir sayaç/taban ayarı İCAT EDİLMEDİ:** doğrudan DB id'sinden türetilir
  (`fmtCode(id) = 'H' + altı hane`); kâğıt formda zaten bir "sıra no" sütunu yok (fiziksel defterdeki satır sırası
  kendi numaralandırmasıdır), bu yüzden Numune/Kasa'daki gibi çakışmayı önleyen bir "taban gir" akışına gerek yok.
- **Silme yalnız admin** (kayıt ve tashih satırı ayrı ayrı); giriş/çıkış alanları her zaman düzenlenebilir
  (`update()`, durum BURADAN değişmez — yalnız `exit()`/`reopen()` durumu değiştirir).
- **Yazdırma:** liste (A4 dikey, `openListPrint`) ve tek kayıt (giriş-çıkış bilgileri + tashih tablosu tek sayfada,
  EYS.FR.043 ve EYS.FR.049 aynı fiziksel kaydı anlattığı için birleştirildi; `openQuarantineForm`, Numune Takip'in
  `openSampleForm`'uyla aynı desen).
- **Ekran yetkisi** (esnek rol sistemi, §6 "Esnek rol sistemi"): `shared/screens.js`/`dashboard/screens.js`'e
  `hurda` (`writable:true`, Tezgah başı/Paketleme'nin hemen ardında) eklendi; `backend/auth/policy.js`
  `SCREEN_ROUTES`'a okuma/yazma rotaları (silme kayıtsız → admin). Hangi rolün bu ekranı görüp/yazabileceğini
  **admin Ayarlar > Roller'den seçer** — Numune Takip'in aksine GÖÇLE gelen İzleyici/Operatör rollerine
  **otomatik eklenmedi** (`MIGRATED_ROLE_GRANTS` dondurulmuş bir tarihsel kayıt, bkz. §6 "Aynı incelemede bulunan
  diğer düzeltmeler"); mevcut kurulumlarda bu ekranı kimin göreceğine admin yeni bir rol açarak ya da var olan bir
  role `hurda` yetkisi vererek karar verir.
- **Dosyalar:** `backend/planning/quarantine.js` (`Quarantine` sınıfı, tablolar `quarantine_entries` +
  `quarantine_corrections`, `planlama.db`'de kendi `CREATE TABLE IF NOT EXISTS`'i ile — Numune/Fiyat çalışması
  deseniyle aynı, hangi modülden önce ilklenirse ilklensin bağımsız çalışır), `planning.js` (`this.quarantine`),
  `routes.js`, `dashboard/planning-hurda.js` (liste + detay/tashih/çıkış pencereleri), `dashboard/planning-view.js`
  (TABS girdisi).
- **Uçlar:** `GET/POST /api/planning/quarantine` (liste `?q=&status=` / yeni kayıt) · `GET/PUT /api/planning/quarantine/:id`
  (ayrıntı — tashih geçmişi + toplamlar dahil — / düzenle) · `DELETE .../quarantine/:id` (admin) ·
  `POST .../quarantine/:id/exit {exitReason, exitedOn?, exitedBy}` · `POST .../quarantine/:id/reopen` ·
  `POST .../quarantine/:id/corrections {doneOn?, operator, description, qty, okQty?, scrapQty?, manHours?, note?}` ·
  `DELETE /api/planning/quarantine/corrections/:id` (admin).
- **Doğrulama:** `backend/planning/quarantine.test.js` (9 test: oluşturma + zorunlu alanlar, kısmi güncelleme +
  NOT NULL tarih koruması, tashih ekleme + kapalı kayıtta engellenmesi + toplamlar, tashih silme, çıkış yapma +
  zaten kapalıyken engellenmesi, geri alma, liste arama/süzme/tashih sayısı, kayıt silme, uçtan uca HTTP).
  `npm test` 643/643 yeşil. Tarayıcıda gerçek sunucuya (AUTH_DISABLED) karşı uçtan uca denendi: giriş kaydı oluşturma
  → dialog "düzenle" görünümüne otomatik geçti (Numune'nin "ilk oluşturmadan sonra da diyalog açık kalır" deseniyle
  aynı), tashih ekleme (liste "Tashih" sütunu güncellendi), çıkış yapma (durum çipi ✓'ye döndü), tek kayıt yazdırma
  önizlemesi (giriş + çıkış + tashih tablosu tek sayfada doğru göründü), "Girişi geri al" (durum ◔'ya döndü).
- **DENENMEDİ:** gerçek yazıcıdan A4 baskı ve kâğıt EYS.FR.043/EYS.FR.049 ile yan yana karşılaştırma; fabrika
  PC'sinde gerçek kullanım; tashih silme düğmesinin tarayıcının `window.confirm()` onayıyla uçtan uca akışı (kod
  incelemesiyle doğrulandı, native onay penceresi bu oturumun tarayıcı aracında sınanmadı).

**EYS.LS.018 "Hurda Ürün Takip Listesi" ile karşılaştırılıp alan genişletmesi yapıldı (2026-11-05/06, kullanıcı isteği:
"bizim sistem doğru olsun"):** kullanıcı kalite biriminin fiilen tuttuğu gerçek Excel listesini (`EYS.LS.018`, 209 gerçek
satır) referans olarak verdi. Bu, EYS.FR.043 formunun karşılığı değil — **aynı olayların farklı, daha geniş bir
özetidir**: TARİH, ALEN ÜRÜN KODU, MÜŞTERİ ÜRÜN KODU, MÜŞTERİ, UYGUNSUZLUK TANIMI, **UYGUNSUZLUK TESPİT YERİ**
(serbest metin — gerçek veride yazım hatalı varyantlar da var: `ÜRETTİM`, `ÜRTİM`, bu yüzden enum YAPILMADI), **YAPILACAK
İŞLEM**, **PARTİ MİKTARI**, **HURDA MİKTARI** (satır düzeyinde, çoğu satırda hiç tashih denemesi kaydı olmadan bile
dolu), **KALİTESİZLİK MALİYETİ (TL)**, AÇIKLAMA sütunları taşıyordu — bunlardan hiçbiri `quarantine_entries`'de yoktu.
**Kullanıcı bir Excel içeri aktarma istemedi**, yalnız doğrulama; bu yüzden ayrı bir importer YAZILMADI.
- **Mevcut giriş-çıkış+tashih akışını BOZMADAN**, 9 yeni isteğe bağlı alan eklendi: `customer`/`customerCode`/`stockCode`
  (ürünü üç ayrı eksende tanımlar, `productLabel`in yanında), `detectedAt`, `action`, `batchQty`, `scrapQty` (**entry
  düzeyinde** — `get()`'in tashihlerden topladığı `totals.scrapQty`'den AYRI bir sayı, karıştırılmasın: EYS.LS.018'de
  birçok satırda hiç tashih yokken bile bu alan dolu), `qualityCostTl`, `note`. Eski veritabanları için `ALTER TABLE ADD
  COLUMN` geçişi (`quarantine.js` `#migrate`, diğer alt modüllerle aynı desen).
- **Backend:** `backend/planning/quarantine.js` (`#entryFields`, `entryRow`, `#searchKey` — müşteri/kodlarla da aranabilir
  — `create`/`update`). Testi `backend/planning/quarantine.test.js` (+2: alan doğrulama/arama + eski veritabanı geçişi).
- **UI tamamlandı (2026-11-06):** backend'e eklenen bu alanlar ilk yazıldığında `dashboard/planning-hurda.js`'e hiç
  işlenmemişti — kayıt API'den oluşturulabiliyordu ama **uygulamanın kendi formundan asla girilemiyordu** (gerçek
  bir eksiklik, aynı oturumda fark edilip düzeltildi). Artık giriş/düzenleme penceresinde "Ürün ve miktar bilgileri
  (EYS.LS.018, hepsi isteğe bağlı)" bölümü (9 alan), liste tablosunda "Müşteri" sütunu, basılan formda (EYS.FR.043
  + EYS.FR.049 ile aynı sayfada) "Ürün ve miktar bilgileri" bölümü var. `npm test` 656/656 yeşil. Tarayıcıda gerçek
  sunucuya (AUTH_DISABLED) karşı uçtan uca denendi: tüm 9 alan dolu bir kayıt oluşturuldu, liste "Müşteri" sütununda
  doğru göründü, basılan form önizlemesinde ondalıklı değer (`12.500,5`) dahil tüm alanlar doğru çıktı; test kaydı silindi.
- **DENENMEDİ:** EYS.LS.018'deki gerçek veriyle (yalnız yapı/sütun adları doğrulandı, içeri aktarma yok) toplu
  karşılaştırma; gerçek yazıcıdan baskı.

**Karantina deposu — iş emri bağlantısı + Mikro (2026-11-09, kullanıcı isteği, "Mikro ana veri kaynağı" kararının AYNI oturumu):**
Mikro'da (kullanıcı tarafından) yeni bir depo açıldı: **KARANTİNA DEPO (dep_no=5)** — salt okuma ile doğrulandı,
HURDA DEPO (dep_no=3) zaten vardı (bkz. §6 "Bitmiş ürün depo akışı"). Hurda Girişi artık bunu kullanıyor:
- **Karantina kaydı bir iş emrine bağlanabilir** (`quarantine_entries.wo_no`, yeni sütun): giriş formunda **İş emri**
  alanı — `planning-shop.js`'in "Başka iş emri başlat…" seçicisiyle AYNI desen (arama + seç), yalnız `status=uretimde-bitti`
  (yeni filtre, `listWorkOrders`) ile süzülür. Seçilince boş olan `productLabel`/`stockCode`/`customerCode` otomatik dolar
  (dolu alana dokunulmaz); iş emri geçmişine "karantinaya bağlandı" notu düşer.
- **Miktar (`batchQty`, EYS.LS.018'den beri var olan "parti miktarı" alanı — YENİ bir alan İCAT EDİLMEDİ) genelde giriş
  anında bilinmiyor** (kasa sonradan tartılıyor): boş bırakılıp sonradan "Düzenle"den girilebilir. Bir iş emrine bağlı
  kayıtta `batchQty` ilk kez ya da farklı bir değere gelince (1) iş emri geçmişine not düşer, (2) Mikro **KARANTİNA DEPO
  İÇİNDE GİRİŞ virmanı** otomatik gönderilir (fire-and-forget — `planning.js`'in paketleme→Merkez otomatik senkronuyla
  AYNI "dene-ve-logla" deseni, satır/alan kaydını ASLA bekletmez/engellemez). **DELTA** ile çalışır (500→650 olursa
  yalnız 150 gönderilir), tıpkı `product-depot.js`'teki gibi.
- **Tashih sonucu (OK/hurda) otomatik Mikro'ya yansır — kullanıcı kararı, üç ayrı senaryo:**
  1. **Hurda çıkan kısım HER ZAMAN hemen** Karantina→Hurda(3) TRANSFER olarak gönderilir (iş emri durumundan bağımsız —
     ürün artık üretimin parçası değil, beklemenin anlamı yok).
  2. **OK çıkan kısım, iş emri ZATEN `bitti` ise hemen** Karantina→Geçici(2) TRANSFER olarak gönderilir.
  3. **OK çıkan kısım, iş emri hâlâ `uretimde` ise ERTELENİR**: Mikro'ya hiç gidilmez (telemetri/parça sayacına
     KESİNLİKLE dokunulmaz), yalnız iş emri geçmişine "N adet OK (iş emri bitince Geçici'ye aktarılacak)" notu düşülür.
     Ertelenen miktar **yeni bir sayaç/alan olarak SAKLANMAZ** — `quarantine_corrections.ok_qty` ile bu modülün kendi
     gönderim geçmişi arasındaki FARK olarak HER ZAMAN TÜRETİLİR (`pendingOkForWorkOrder`). İş emri **bitince**
     `planning.js#finishWorkOrder` bu farkı fire-and-forget gönderir (`flushPendingOk`) — üretimdeyken biriken birden
     çok ertelenmiş OK varsa hepsi iş emri kapanınca tek seferde toparlanır.
- **İş emri bitişi karantinadaki (henüz tashih sonucu belirlenmemiş) miktarı iki kez SAYMAZ:** `product-depot.js`'in
  `sendFinishTransfer`'ı artık `üretilen - karantinada bekleyen - zaten gönderilen` gönderir (ör. 8000 üretildi, 500'ü
  hâlâ karantinada → yalnız 7500 Geçici'ye GİRİŞ yapılır; 500, tashih sonucu belirlenince KENDİ Karantina→Geçici/Hurda
  yolundan ayrıca gelir). İş emri ayrıntısındaki "Bitmiş ürün depo akışı" panelinde bu "N adet karantinada" ve (varsa)
  "M adet OK, iş emri bitince aktarılacak" bilgi satırı olarak gösterilir (salt bilgi, tetikleme tamamen otomatik).
- **Hurda Girişi ekranına yeni "Hurda deposu" sekmesi:** Karantina→Hurda(3) gerçekten başarılı olmuş transferlerin
  dökümü (tarih, karantina kaydı, ürün, iş emri, adet, Mikro evrak no).
- **Kapı:** yeni bir env değişkeni İCAT EDİLMEDİ — `PRODUCT_DEPOT_ENABLED` AYNEN paylaşılıyor (aynı gerekçe: fabrika
  PC'si/paketleme henüz sahada değil); `MIKRO_WRITE_ENABLED` de aynı şekilde geçerli.
- **Mimari:** yeni modül `backend/planning/quarantine-depot.js` (`QuarantineDepot`, kendi tablosu `quarantine_depot_transfers`
  — `product-depot.js`'teki `#history`/`#sentTotal`/`#insert`/`#send` deseninin BİREBİR tekrarı, kopyalanmadı; `mikro-stock.js`'in
  GENEL amaçlı `previewProductTransfer`/`previewProductVirman`'ı olduğu gibi çağrılır, yeni bir Mikro yazma mekanizması yok).
  `quarantine.js`'e `#onLink`/`#onCorrection` kancaları (fire-and-forget, `create`/`update`/`addCorrection` senkron kalır).
- **Uçlar:** `GET /api/planning/quarantine/:id` yanıtına `depot` eklendi (GİRİŞ/OK/Hurda geçmişi + bekleyen miktar);
  `GET /api/planning/quarantine/hurda-deposu?from=&to=`; `POST .../quarantine/:id/depot/retry-giris` (başarısız GİRİŞ'i
  elle yeniden dener — fire-and-forget'in tek kurtarma yolu). `GET /api/planning/work-orders` yeni `status=uretimde-bitti`
  süzgeci (İş emri seçicisi için; `planlandi`/`iptal` dışarıda bırakır).
- **Testi:** `backend/planning/quarantine-depot.test.js` (13: GİRİŞ/OK/Hurda delta hesapları, kapılar, üretimdeyken
  ertelenmiş OK + iş emri bitince otomatik gönderim + idempotentlik, `sendFinishTransfer`'ın karantinayı düşmesi, HTTP) +
  `work-orders.test.js` (+1: `uretimde-bitti` filtresi) + mevcut `quarantine.test.js`/`product-depot.test.js` değişmeden
  yeşil kaldı (geriye dönük uyumlu). `npm test` 702/702 yeşil. Tarayıcıda gerçek sunucuya (AUTH_DISABLED) karşı uçtan uca
  denendi: İş emri seçici gerçek üretimdeki/biten iş emirlerini (durum rozetleriyle) listeledi, seçilince ürün alanları
  doğru doldu, parti miktarı (500) girilince "Mikro karantina deposu" bloğu "◔ 500 adet bekliyor" gösterdi (Mikro kapısı
  bu dev ortamında kapalı olduğu için GERÇEKTEN gönderilmedi, ama akış ve gösterim doğru çalıştı), iş emri ayrıntısındaki
  "Bitmiş ürün depo akışı" panelinde "◔ 500 adet karantinada (tashih sonucu henüz belirlenmedi, Geçici'ye dahil edilmedi)"
  satırı gerçek veriyle doğru göründü. Test kaydı silindi.
- **DENENMEDİ:** gerçek Mikro'ya karşı GERÇEK yazma (GİRİŞ/OK/Hurda transferleri; hammaddenin/ürünün kendi akışlarında
  olduğu gibi `MIKRO_WRITE_ENABLED`+`PRODUCT_DEPOT_ENABLED` açık bir ortamda ilk gerçek deneme yönetici ile birlikte
  yapılmalı); "Hurda deposu" sekmesinin gerçek verilerle görünümü; bir iş emrine birden fazla karantina kaydı bağlıyken
  gerçek fabrika kullanımı (yalnız testle sınandı).

### Ölçüm Cihazları Takip (EYS.LS.006 "Ölçüm Cihazları Takip Listesi") — 2026-11-05, kullanıcı isteği

Kalite biriminin ve üretimin kullandığı mastar/kumpas/mihengir/görüş sistemi vb. **fiziksel ölçüm ekipmanının
envanteri** ve kalibrasyon zamanlaması. Kullanıcının isteği: "kalibrasyon zamanı geldi mi, şu an kalibrasyonda mı
bunları takip etmek"; yeni cihaz ekleme ("yeniler de satın alınıyor" — kategori **kısıtlanmadan** serbest metin);
Setup.exe ile ilk kurulumda gerçek Excel'den mevcut hâli aktarmak için bir "ekle" butonu; satırlar iş emirlerindeki
gibi **yeşil/sarı/kırmızı** boyalı, kalibrasyon durumuna göre.

- **`measure.js`'teki `DEVICES`'tan (Ölçü Kontrolü'nde bir karakteristiğin HANGİ CİHAZ TÜRÜYLE ölçüldüğü, dar bir
  alan) BİLİNÇLİ OLARAK AYRI:** bu modül fiziksel cihazların kendi envanter kaydı (Takip No, seri no, kalibrasyon
  tarihi…); `products`/ölçü planıyla da bağlanmaz (Numune Takip/Fiyat çalışması'yla aynı ilke).
- **Kalibrasyon durumu gerçek EYS.LS.006 Excel'indeki koşullu biçimlendirme kurallarıyla BİREBİR aynı** (tahmin
  edilmedi; gerçek dosyanın `openpyxl` ile koşullu biçimlendirme kuralları/formülleri okunup çözüldü): ay sınırı
  bazlı, gün sayısı DEĞİL —
  - **yeşil (`yesil`):** gelecek kalibrasyon tarihi, bugünden 2 ay sonraki ayın 1'ine eşit ya da ondan ileride.
  - **sarı (`sari`):** bugünden 1 ay sonraki ayın 1'i ile 2 ay sonraki ayın 1'i arasında (kalibrasyon vaktine 1 ay
    var) — bu yüzden örneğin bugün 2026-11-04 iken 2026-11-28 tarihi hâlâ "kırmızı" çıkar (28 Kasım, 1 Aralık ayının
    başlangıcından ÖNCE): gerçek dosyada doğrulandı, günlük sayıma göre "yakın ama henüz gelmedi" sanılabilirdi.
  - **kırmızı (`kirmizi`):** bugünden 1 ay sonraki ayın 1'inden ÖNCE (zamanı gelmiş/geçmiş).
  - **bilinmiyor:** tarih hiç girilmemiş (Excel'de boş hücre hiç renklenmiyordu; biz sessizce atlamak yerine ayrı bir
    ikon+etiketle gösteriyoruz, CLAUDE.md §7 "renk tek başına anlam taşımaz").
  - **Kayıt "pasif" (kullanım dışı) ise kalibrasyon alarmı BASTIRILIR** (emekliye ayrılmış bir cihazın süresi geçmiş
    gibi görünmesin) — liste/detayda `calibration: 'pasif'` döner, kırmızı/sarı/yeşil hiçbiri değil.
- **Kategori serbest metin, sabit bir liste DEĞİL** (kullanıcının "yeniler de satın alınıyor" kararı): yalnız
  "Cihaz kategorisi" ve "Cihaz tanımı" zorunlu, kalan ~16 alan (Takip No, seri no, model-marka, ölçüm aralığı,
  çözünürlük, sapma durumu, kalibrasyon tarihi/firması/gelecek tarihi, bölüm-alt bölüm, teslim alan/tarihi, hata
  bilgisi, not…) zamanla doldurulur.
- **Excel'den içeri aktarma — Setup.exe sonrası İLK SEFER için** (`importXlsx`): `findDeviceHeader` başlık satırını
  ilk 12 satırda arar (form başlığı/lejant üstte olabilir, GKK/ilk onay'daki `findGkkHeader` deseniyle aynı). Boş
  satırlar (kategori VE tanım ikisi de boş) sessizce atlanır; **Takip No zaten kayıtlıysa o satır atlanır** (büyük/
  küçük harf ve Türkçe harf duyarsız, `foldTr`) — tekrar yüklemek (ya da iki kez tıklamak) kazara yinelenmiş cihaz
  yaratmaz, eski iş emri geçişindeki idempotentlik ilkesiyle aynı. Uyarılar (kategori/tanım eksik, geçersiz tarih
  biçimi…) satır numarasıyla listelenir, en çok 25 + "daha fazla var" notu; tek satırın hata vermesi `try/catch` ile
  izole edilir, bir bozuk satır tüm içeri almayı düşürmez.
  **Gerçek EYS.LS.006 dosyasıyla uçtan uca denendi (2026-11-05, kullanıcının `Downloads` klasöründeki gerçek dosya,
  `POST /api/planning/devices/import`'a ham baytlarla):** 175 satır bulundu, **169 eklendi, 6 atlandı** (1 geçersiz
  tarih biçimi, 4 **dosyanın kendi içindeki** tekrarlanan Takip No — gerçek listede birkaç satır zaten yinelenmiş
  duruyormuş, 1 kategori/tanım eksik). Liste ekranında 172 kayıt (169 gerçek + 3 bu oturumda test için eklenip
  temizlenen sentetik cihaz) doğru göründü; varsayılan "Aktif" süzgeciyle 159 (13 kayıt gerçek dosyada "pasif"
  işaretliymiş, kalibrasyon alarmı doğru şekilde bastırıldı).
- **Satır rengi + ikon + etiket birlikte** (`rowClass()`/`CAL_CHIP`, iş emirlerindeki `.pl-done`/`.pl-waiting`/
  `.pl-rejected` CSS ailesiyle AYNI, yeni CSS eklenmedi): ✓ kalibrasyonlu (yeşil) / ◔ vaktine 1 ay var (sarı) / ✕
  zamanı gelmiş (kırmızı) / tarih yok (nötr) / pasif (soluk). Tarayıcıda üç senaryo da (kırmızı/sarı/yeşil tarih
  girilerek) oluşturulup doğru renk+ikonla göründüğü, "Kalibrasyon" süzgecinin doğru filtrelediği doğrulandı.
- **Yazdırma:** "Listeyi yazdır" (A4 dikey, `openListPrint`, GKK/numune/hurda ile aynı desen) — EYS.LS.006 etiketi
  ve tarih başlıkta, tarayıcıda önizlemesi doğrulandı.
- **Ekran yetkisi** (esnek rol sistemi): `shared/screens.js`/`dashboard/screens.js`'e `olcucihazlari`
  (`writable:true`, Kalite grubunda GKK/İlk onay/Ölçü raporlarının hemen ardında) eklendi; `backend/auth/policy.js`
  `SCREEN_ROUTES`'a GET/POST `/api/planning/devices` ve GET/PUT `/api/planning/devices/:id` (okuma/yazma); **silme
  (`DELETE .../:id`) ve Excel içeri aktarma (`POST .../import`) kayıtsız bırakıldı → varsayılan reddet, admin'e
  düşer** (Hurda Girişi'ndeki "idari işlemler admin'e" deseniyle aynı — Setup sonrası ilk aktarım ve yanlış kaydı
  silme geri dönüşsüz/hassas işlemler).
- **Dosyalar:** `backend/planning/measuring-devices.js` (`MeasuringDevices` sınıfı + saf `calibrationStatus()`
  fonksiyonu, tablo `measuring_devices`, `planlama.db`'de kendi `CREATE TABLE IF NOT EXISTS`'i ile — diğer alt
  modüllerle aynı, hangi modülden önce ilklenirse ilklensin bağımsız çalışır), `planning.js` (`this.measuringDevices`),
  `routes.js`, `dashboard/planning-devices.js` (liste + yeni/düzenle penceresi + içeri aktarma penceresi),
  `dashboard/planning-view.js` (TABS girdisi, Kalite grubu).
- **Uçlar:** `GET/POST /api/planning/devices` (liste `?q=&active=&usable=&calibration=` / yeni cihaz ekle) ·
  `POST /api/planning/devices/import` (gövde = ham `.xlsx`, admin) · `GET/PUT /api/planning/devices/:id` (ayrıntı —
  kalibrasyon durumu hesaplanır — / düzenle) · `DELETE .../devices/:id` (admin).
- **Doğrulama:** `backend/planning/measuring-devices.test.js` (11 test: `calibrationStatus()` ay sınırları, CRUD,
  liste süzgeçleri — pasifin alarmı bastırması dahil —, silme, `importXlsx()` üç senaryo — gerçekçi dosya, boş/
  geçersiz satır + tekrar yüklemede dedup, başlık bulunamama hatası —, uçtan uca HTTP). `npm test` 654/654 yeşil
  (yeni ekran eklenince `apps.test.js`/`features.test.js`'teki sabit sekme sayısı/listesi güncellendi, Hurda
  Girişi'nde olduğu gibi). Tarayıcıda gerçek sunucuya (AUTH_DISABLED) karşı uçtan uca denendi: boş liste → yeni
  cihaz ekleme (kırmızı/sarı/yeşil üç senaryo) → satır rengi+ikon doğru → kalibrasyon süzgeci doğru filtreledi →
  **gerçek EYS.LS.006 dosyasının içeri aktarımı** (169/175 gerçek cihaz) → yazdırma önizlemesi; test için eklenen
  3 sentetik cihaz `DELETE` ile temizlendi, gerçek 169 kayıt dev veritabanında kaldı.
- **DENENMEDİ:** gerçek yazıcıdan A4 baskı ve kâğıt EYS.LS.006 ile yan yana karşılaştırma; tarayıcıdan native dosya
  seçiciyle içeri aktarma (bu oturumda da yalnız HTTP uca ham bayt göndererek test edildi — projedeki diğer
  Excel içeri alma özellikleriyle aynı, bilinen sınır); fabrika PC'sinde Setup.exe sonrası gerçek ilk kurulum
  akışı; kullanıcının "şu an kalibrasyonda mı" ifadesindeki ayrı bir "kalibrasyonda" durumu AYRICA MODELLENMEDİ —
  `usable: 'kullanilamaz'` (kullanılamaz/arızalı) alanı en yakın karşılığı, kalibrasyona gönderilmiş/geri bekleniyor
  diye ayrı bir durum yok (gerçek Excel'de de böyle bir sütun yoktu, yalnız Cihaz Durumu Kullanılabilir/Kullanılamaz).

### Teknik Resim Takip (EYS.LS.007 "Seri Üretim Teknik Resim Takip Listesi") — 2026-11-06, kullanıcı isteği

"Ürünler" grubunda yeni bir ekran: sistemdeki **HER ürünün** teknik resim durumu — var mı/yok mu, kaçıncı
revizyonda, ne zaman değişti. Mevcut `doc-folder.js` (teknik resim klasörü → ürün kartına eşleme) dosyayı
PDF olarak bağlıyordu ama **resmin ne zaman değiştiğini bir OLAY olarak kaydetmiyordu** — "update" dalı eski
dosya satırını SİLİP yenisini EKLEDİĞİ için geçmiş iz bırakmadan kayboluyordu. Bu ekran o boşluğu dolduruyor.

- **Kapsam (kullanıcı kararı, AskUserQuestion ile netleşti):** yalnız **kimlik + revizyon** alanları — müşteri,
  resim no, kayıt tarihi, rev no, yayın tarihi, rev. tarihi, tutulduğu ortam, durumu, revizyon nedeni. Excel'in
  dağıtım/toplama/arşiv bürokrasi bölümü (398 satırın TAMAMINDA boştu, salt okuma ile doğrulandı) **alınmadı**.
  "Durumu" serbest metin kalır (gerçek veride `'İPTAL'`/`'revize edildi'`/`'REVİZE EDİLDİ'` gibi tutarsız
  büyük/küçük harf örnekleri var; bir enum/kısıtlama UYGULANMAZ — Ölçüm Cihazları Takip'teki kategori gibi).
- **REV NO ürün bazlı, SİSTEM tarafından otomatik artırılır** (kullanıcı kararı: "o rev no ürün bazlı bir ürüne
  hiç rev gelmediyse 0 her dosya değiştiğinde sistem otomatik arttırsın"). Kritik ayrım (`recordDrawingChange`):
  - **"Excel'den baseline'ı olan (ya da hiç izlenmeyen) bir ürüne İLK DEFA dijital resim eklenmesi"** rev_no'yu
    ARTIRMAZ — Excel'deki mevcut rev_no/rev_tarihi KORUNUR (satır hiç yoksa 0'dan başlar); bu yalnız kâğıttaki
    bilgiyi dijitale taşımak, gerçek bir revizyon değil. `yayin_tarihi` boşsa (Excel'den hiç gelmemişse) doldurulur.
  - **"Zaten dijital resmi olan bir ürünün dosyası DEĞİŞMESİ"** (gerçek revizyon) rev_no'yu **+1 artırır** ve
    rev_tarihi'ni günceller.
  - Bu ayrım `doc-folder.js`'in `match()`'inde ZATEN hesaplanan `had` (üründe önceden cizim dosyası var mıydı)
    sinyaline bağlanır — `quality.js`'in `addProductFile()`'ı içinde YENİDEN türetilmeye çalışılmadı, çünkü
    "update" dalı eski satırı SİLDİKTEN SONRA ekliyor, `had` doğru hesaplandığı an orası (match()'in üstü).
- **`products` ile bağlanmaz, ÜZERİNE YAZMAZ:** ürün adı/stok kodu/müşteri kodu `products`'tan gelir (burada
  tekrar saklanmaz); Excel'deki "MÜŞTERİ" (müşteri ADI, `products`'ta karşılığı yok — yalnız müşteri KODU var)
  kendi `musteri` kolonunda tutulur (Numune Takip/Hurda Girişi/Fiyat çalışması'yla aynı "ayrı kayıt" ilkesi).
- **Küçük bir refactor, aynı oturumda:** `gkk.js`'in `findGkkHeader`'ı ve `measuring-devices.js`'in
  `findDeviceHeader`'ı neredeyse birebir aynıydı; bu özellik ÜÇÜNCÜ bir kopyayı gerektirdiğinden, paylaşılan
  `findHeaderByKeys(rows, requiredKeys, {maxRows})` yardımcısına çıkarıldı (`backend/planning/normalize.js`);
  iki mevcut çağrı yeri de buna taşındı (davranış DEĞİŞMEDİ, yalnız tekilleştirme — ikisinin testleri de yeşil).
- **Excel içeri aktarma:** Alen Otomat ürün koduyla (`products.code_key`'e karşı `foldTr`) eşlenir; eşleşmeyen
  kod "ürün kartı yok" uyarısıyla atlanır. **Aynı Alen kodundan BİRDEN ÇOK satır** (gerçek dosyada 27-28/398
  görüldü) en YENİ olan (rev. tarihi, yoksa yayın tarihi, yoksa kayıt tarihi) baz alınır, diğeri "yinelenen"
  uyarısıyla atlanır — sessizce üzerine yazılmaz. Geçersiz tarih (gerçek veride çoğu satırda "-" placeholder)
  satırı düşürmez, yalnız o alanı `null` bırakıp uyarır (gkk.js'in `badDate` deseniyle aynı, GKK/ölçüm cihazları
  takibin "tüm satırı at" yaklaşımından farklı: burada diğer alanlar hâlâ değerli).
- **Ekran** (`dashboard/planning-drawing-tracking.js`, `g-urunler` grubunda `programlar`/`urunler`'in yanında):
  liste `planning-products.js`'in load-more sayfalama desenini izler (514 ürünün tamamı, `products.search_key`
  ile aynı arama). **Satıra basınca** (resim VARSA) PDF doğrudan açılır — tek dosyaysa direkt yeni sekmede, birden
  çoksa küçük bir seçim listesiyle (ürün detayı `GET /api/planning/products/:kod`'un zaten döndürdüğü `files`
  listesi yeniden kullanılır, YENİ bir çoklu-dosya ucu YAZILMADI). Ayrı bir **"Düzenle"** düğmesi (satırda zaten
  yüklü veriyle açılır, yeniden sorgulanmaz) Excel'in 9 alanını elle düzeltir — rev no da dahil (yanlış geldiyse).
  Admin-only "Excel'den içeri aktar…" (Ölçüm Cihazları Takip'teki pencereyle aynı desen).
- **Müşteriye göre filtreleme (2026-11-10, kullanıcı isteği):** serbest arama kutusunun yanına açılır kutu —
  `drawingTracking.customers()` EYS.LS.007 kaydındaki "Müşteri" (Excel'deki müşteri ADI, `products.customerCode`
  — müşteri ürün KODU — İLE KARIŞTIRILMASIN) alanının gördüğü DISTINCT değerleri alfabetik döner. Seçilince
  `list()` artık `products` tablosundan DEĞİL, `products JOIN drawing_tracking WHERE musteri = ?` (TAM eşleşme)
  üzerinden gider — yalnız o müşterinin EYS.LS.007 kaydı olan ürünler gelir (hiç izlenmeyen ürün hiçbir müşteriye
  ait sayılmaz); serbest arama kutusuyla (`q`) BİRLİKTE de çalışır (ikisi AND'lenir). Uç: `GET
  /api/planning/drawing-tracking/customers` (`teknikresim`/okuma) · `GET .../drawing-tracking?customer=`.
  Testi `drawing-tracking.test.js`'e 2 yeni test (customers() listesi, list()'in customer+q kombinasyonu) +
  HTTP testine eklendi. **Tarayıcıda gerçek sunucuya (AUTH_DISABLED) karşı gerçek 519 ürün/343 EYS.LS.007
  kaydıyla uçtan uca denendi:** açılır kutu gerçek müşteri adlarını (AYVAZ, BERG METAL, KUZUFLEX…) doğru
  listeledi, "KUZUFLEX" seçilince liste 519'dan gerçek 3 ürüne daraldı (hepsi doğru müşteriyle).
- **Dosyalar:** `backend/planning/drawing-tracking.js` (`DrawingTracking` sınıfı, tablo `drawing_tracking`,
  `planlama.db`'de kendi `CREATE TABLE IF NOT EXISTS`'i ile — diğer alt modüllerle aynı, hangi modülden önce
  ilklenirse ilklensin bağımsız çalışır), `planning.js` (`this.drawingTracking`), `doc-folder.js` (`match()`'teki
  tek satırlık kanca), `routes.js`, `dashboard/planning-drawing-tracking.js`, `dashboard/planning-view.js`
  (NAV_LAYOUT/TABS girdisi), `dashboard/app.js` (hash yönlendirme deseni — Numune eklenirken BU adım bir kez
  unutulmuştu, bu kez bilerek kontrol edildi).
- **Ekran yetkisi** (esnek rol sistemi): `shared/screens.js`/`dashboard/screens.js`'e `teknikresim`
  (`writable:true`, Ürünler grubunda `urunler`'in hemen ardında) eklendi; `backend/auth/policy.js`
  `SCREEN_ROUTES`'a GET `/api/planning/drawing-tracking` ve PUT `.../:kod` (okuma/yazma); **Excel içeri aktarma
  (`POST .../import`) kayıtsız bırakıldı** → varsayılan reddet, admin'e düşer (diğer Excel-içeri-alma
  özellikleriyle aynı desen).
- **Uçlar:** `GET /api/planning/drawing-tracking?q=&customer=&limit=&offset=` (liste; `customer` TAM eşleşme,
  müşteriye göre filtre) · `GET .../customers` (DISTINCT müşteri adları, açılır kutu için) · `PUT .../:kod`
  (düzenle; satır yoksa oluşturulur) · `POST .../import` (gövde = ham `.xlsx`, admin).
- **Doğrulama:** `backend/planning/drawing-tracking.test.js` (12 test: `recordDrawingChange`'in üç senaryosu —
  hiç izlenmeyen üründe ilk eşleme/revizyon, Excel baseline'ı koruma, gerçek revizyonda +1 — `update` kısmi
  alan değişimi, `list`, Excel içeri aktarma — gerçekçi dosya, ürün kartı olmayan kod, yinelenen kod de-dup,
  başlık bulunamama — uçtan uca HTTP) + `doc-folder.test.js`'e 3 assertion (ilk eşleme rev_no'yu artırmıyor,
  içerik değişmeyince artmıyor, gerçek revizyonda +1 artıyor — mevcut "güncelleme" testinin içine eklendi).
  `npm test` 671/671 yeşil (yeni ekran eklenince `apps.test.js`/`features.test.js`'teki sabit sekme sayısı/
  listesi güncellendi, önceki ekranlarda olduğu gibi). **Tarayıcıda gerçek sunucuya (AUTH_DISABLED) karşı uçtan
  uca denendi:** boş liste (514 gerçek ürün) → "Düzenle" ile alan kaydetme → "Teknik resimleri eşle…" ile gerçek
  bir PDF'i bir ürüne bağlama (ilk eşleme, rev_no 0 kaldı, doğrulandı) → aynı üründe birden çok dosya varken
  satıra basınca çoklu-dosya seçim penceresi doğru açıldı → **gerçek EYS.LS007 Excel dosyasının içeri aktarımı**
  (`POST .../import`'a ham baytlarla, tarayıcının native dosya seçicisi bu oturumda sürülemedi — projedeki diğer
  Excel içeri alma özellikleriyle aynı bilinen sınır): 389 satır okundu, **343 eşleşti, 28 yinelenen, 18 ürün
  kartı yok**, 26 uyarı (çoğu "-" placeholder tarih); gerçek bir satır (`SR050.002`) alan alan doğrulandı (rev
  no, yayın tarihi, müşteri birebir kaynak dosyayla tuttu). Test için eklenen sentetik PDF dosyası silindi,
  gerçek 343 satırlık içeri aktarım dev veritabanında kaldı (önceki EYS.LS.006/EYS.LS.018 oturumlarındaki aynı
  ilke: sentetik test verisi temizlenir, gerçek içeri aktarım kalır).
- **DENENMEDİ:** gerçek yazıcıdan baskı (bu ekranın kâğıt karşılığı yok, yalnız ekran); tarayıcıdan native dosya
  seçiciyle içeri aktarma; fabrika PC'sinde gerçek kullanım; admin'in bu ekranı hangi role açacağına karar
  vermesi (göçle gelen İzleyici/Operatör rollerine otomatik eklenmedi — diğer yeni ekranlarla aynı, `Ayarlar >
  Roller`den elle verilir); çok büyük (>1000) ürün listesinde arama performansı (514 ürünle sorunsuzdu).

### Paketleme listesi (EYS.LS.005 "Paketleme Listesi") — 2026-11-09, kullanıcı isteği

Paketleme ekranına **üçüncü görünüm** ("Liste", `paketleme` ekranının "Paketleme formu"/"Kasalar" ile AYNI
yetkisini paylaşır — ayrı bir ekran id'si değil): her ürünün NASIL paketlendiğini sabitleyen kayıt — koli
boyutu, kasa özelliği, kat sayısı, koli/kasa içi adet, koli etiketi (STANDART/QR/İNGİLİZCE-LOGOSUZ), koli
ağırlığı (kg). Bugüne kadar bunun yalnız BİR parçası (koli içi adet) örtük tutuluyordu: `packing.js`'in
"koli içi adet öğrenme" mekanizması (`setBoxQtyIfEmpty`) bir ürünün İLK paketleme satırında girilen `boxQty`'yi
`products.box_qty`'ye yazıp sonraki paketlemelerde öneri olarak gösteriyordu; geri kalan 5 alan hiç tutulmuyordu.

- **Excel'deki ALEN OTOMAT ÜRÜN KODU / MÜŞTERİ ÜRÜN KODU sütun başlıkları gerçek veriyle TUTARSIZ** (salt okuma
  ile doğrulandı, Teknik Resim Takip'teki benzer bulgudan FARKLI bir örüntü): 110 satırın 108'inde SR0xx.xxx
  biçimindeki Alen kodu "MÜŞTERİ ÜRÜN KODU" yazan sütunda duruyor. **Çözüm regex/biçim değil, doğrudan gerçek
  ürün kartına karşı doğrulama:** her satırda İKİ sütun da `products`'a karşı denenir (`planning.db.getProduct`),
  hangisi gerçek bir ürün kartına karşılık geliyorsa o Alen kodu sayılır (bu şirkette `SR20.002` gibi düzensiz
  biçimli kodlar da olduğu için bir regex'e güvenmek Teknik Resim Takip'teki kadar güvenilir olmazdı). İkisi de
  eşleşmiyorsa ya da İKİSİ DE FARKLI ürünlere eşleşiyorsa satır "ürün kartı yok"/"belirsiz" uyarısıyla atlanır.
- **Paketleme formuna entegre edildi** (kullanıcının kendi tarifi: "ilk kez paketlemesi yapılan bir ürünse aynı
  şu anki akış gibi ama fieldlar artıyor"): `packing.js#suggest()` artık `packingSpec` alanı da döner; ürünün
  BU KAYDI varsa koli boyutu/kasa özelliği/kat sayısı/etiket/ağırlık paketleme formunda **salt bilgi** olarak
  gösterilir ve "koli içi adet" önerisi ÖNCE bu kayıttan gelir (yoksa eskisi gibi `products.box_qty`'den — o
  mekanizma HİÇ DOKUNULMADAN, paralel çalışmaya devam ediyor). Kaydı YOKSA (ürün ilk kez paketleniyor olabilir)
  aynı 5 alan satır ekleme formunda DOĞRUDAN GİRİLEBİLİR olur; satır kaydedilince boş kalan alanlara öğrenilir
  (`learnIfEmpty`, `setBoxQtyIfEmpty`'nin 6 alana genişletilmiş hâli: yalnız o an BOŞ olan alanlara yazar, dolu
  alana asla dokunmaz). Bu alanlar `packing_rows`'a YAZILMAZ (satır-düzeyi değil ürün-düzeyi veri); öğrenme yan
  etkisi try/catch içinde — satır kaydını ASLA engellemez (`product-depot.js`'in "satır eklemeyi asla
  bekletmez/engellemez" ilkesiyle aynı gerekçe, burada senkron olduğu için düz try/catch).
- **"X" (tam, kırpılmış) kat sayısı değeri `null`'a çevrilir** (gerçek veride "henüz girilmedi" yerine kullanılan
  yer tutucu, 2/110 satırda görüldü) — hem içeri aktarmada hem elle düzenlemede AYNI normalizasyon.
- **Yinelenen Alen kodu, gerçek dosyada 3/110 satırda görüldü** (Teknik Resim Takip'ten FARKLI: bu sayfada tarih
  sütunu YOK, bu yüzden "en yeni tarih" kuralı uygulanamaz) — SON satır kazanır, önceki her biri ayrı bir
  "yinelenen" uyarısıyla raporlanır (sessizce üzerine yazılmaz).
- **Dosyalar:** `backend/planning/packing-specs.js` (`PackingSpecs` sınıfı, tablo `packing_specs`, `planlama.db`'de
  kendi `CREATE TABLE IF NOT EXISTS`'i ile — diğer alt modüllerle aynı desen), `planning.js` (`this.packingSpecs`),
  `packing.js` (`whole()` artık export edilip buradan yeniden kullanılıyor; `suggest()`/`addRow()`'a cerrahi
  eklemeler), `routes.js`, `dashboard/planning-packing-list.js` (liste + "Düzenle" + Excel içeri aktarma —
  Teknik Resim Takip'in liste ekranıyla BİREBİR aynı iskelet), `dashboard/planning-packing.js` (üçüncü sekme),
  `dashboard/planning-packing-form.js` (`packingSpecBlock()`: salt bilgi ya da editlenebilir alanlar).
- **Uçlar:** `GET /api/planning/packing/specs?q=&limit=&offset=` (liste) · `PUT .../specs/:kod` (düzenle; satır
  yoksa oluşturulur) · `POST .../specs/import` (gövde = ham `.xlsx`, admin — diğer Excel-içeri-alma özellikleriyle
  aynı desen, ekran id'si İCAT EDİLMEDİ, `paketleme` ekranının write yetkisiyle AYNI `policy.js` girdisi).
- **Doğrulama:** `backend/planning/packing-specs.test.js` (10 test: `update`/`learnIfEmpty` — boş alanlara yazar,
  dolu alana dokunmaz, "X" normalizasyonu — `list`, Excel içeri aktarma — B/C sütunu karışık sırada senaryo,
  ürün kartı olmayan/belirsiz satır, yinelenen kod, tek satırlık bozuk değerin tüm içeri almayı düşürmemesi,
  başlık bulunamama — uçtan uca HTTP) + `packing.test.js`'e 2 test (yeni ürün için `packingSpecs`'e öğrenme +
  var olan kayda dokunmama, `suggest()`'in `packingSpec` + önceliklendirilmiş `boxQty` döndürmesi). `npm test`
  683/683 yeşil (yeni bir ekran id'si eklenmediği için `apps.test.js`/`features.test.js`'teki sabit sekme
  sayımları ETKİLENMEDİ — Teknik Resim Takip'ten farkı, o ayrı bir ekran id'siydi, bu bir alt-görünüm).
  **Tarayıcıda gerçek sunucuya (AUTH_DISABLED) karşı uçtan uca denendi:** boş liste → **gerçek EYS.LS.005 Excel
  dosyasının içeri aktarımı** (`POST .../specs/import`'a ham baytlarla, tarayıcının native dosya seçicisi bu
  oturumda sürülemedi — projedeki diğer Excel içeri alma özellikleriyle aynı bilinen sınır): 110 satır okundu,
  **106 eşleşti, 3 yinelenen, 1 ürün kartı yok, 0 belirsiz**; gerçek bir satır (SR003.002) alan alan doğrulandı
  (Alen kodu "MÜŞTERİ ÜRÜN KODU" sütununda olmasına rağmen doğru çözüldü, koli boyutu/kat sayısı/koli içi
  adet/etiket/ağırlık kaynak dosyayla birebir tuttu) → paketleme formunda bu ürün seçilince "Standart koli içi
  adet: … (paketleme listesinde; …)" + salt bilgi satırı doğru göründü → kaydı OLMAYAN bir ürün (MJ003.016)
  seçilince 6 alan EDİTLENEBİLİR olarak çıktı, dolduruldu, satır kaydedildi, **tüm 6 alan yeni tabloya doğru
  öğrenildi** (API ile doğrulandı), ürün yeniden seçilince artık salt bilgi olarak göründü. Test için eklenen
  satır iptal edildi, sentetik `packing_specs`/`products.box_qty` değerleri temizlendi; gerçek 106 satırlık
  içeri aktarım dev veritabanında kaldı (önceki EYS.LS.006/EYS.LS.007/EYS.LS.018 oturumlarındaki aynı ilke).
- **DENENMEDİ:** gerçek yazıcıdan baskı (bu listenin kâğıt karşılığı yalnız referans, basılan bir form değil);
  tarayıcıdan native dosya seçiciyle içeri aktarma; fabrika PC'sinde gerçek kullanım (ustaların paketleme
  formunda yeni ürün akışını nasıl bulduğu); "Satırı düzelt" (updateRow) akışında bu alanların öğrenilmesi
  BİLİNÇLİ OLARAK yapılmıyor (yalnız `addRow`/ilk ekleme — plan kararı).

### Hammadde karantinası — yanlış teslimat (2026-11-10, kullanıcı isteği)

Hammadde ekranına **dördüncü sekme: "Karantina"**. Hurda Girişi/Karantina deposu (`quarantine.js`/`quarantine-depot.js`,
§6 "Hurda Girişi"/"Karantina deposu") ÜRETİMDE fark edilen hurda/uygunsuz PARÇAYI (adet) izler; bu, bambaşka bir
senaryo: **tedarikçi yanlış hammadde (kg) gönderdiğinde** teslim alınan miktar karantinaya çekilir. İkisinin
hedefi aynı Mikro deposu (**KARANTİNA DEPO, dep_no=5**) olsa da kayıt/iş akışı tamamen BAĞIMSIZ — ortak bir
tablo/kod PAYLAŞILMADI (biri iş emrine bağlı parça sayımı, diğeri serbest bir hammadde teslim alımı; ortak
soyutlamak yapay olurdu).

- **Akış:** "Karantinaya aktar…" → hammadde ara (Mikro'dan canlı arama, `mikroStock.searchMaterials` — "Depolar
  arası sevkiyat" dialoğuyla AYNI arama kutusu/sonuç listesi) + kilo + not (isteğe bağlı, ör. tedarikçi/sipariş) →
  kayıt **hem oluşturulur hem Mikro'ya hemen gönderilir** (tek adım; miktar bu anda bilinir ve bir daha
  değişmez — Hurda Girişi'ndeki "batchQty genelde girişte bilinmiyor, sonradan girilir" senaryosundan FARKLI,
  bu yüzden deferred/delta mantığı GEREKMEDİ): Merkez(1)→Karantina(5) **Depolar Arası Sevk Fişi**
  (`mikroStock.previewTransfer`, aynı evrak türü hammaddenin kendi transfer akışıyla). Liste satırında durum:
  **✕ aktarılamadı** (Mikro çağrısı başarısız; "Yeniden dene…") / **◔ karantinada** ("İade et…") / **✓ iade edildi**.
- **"İade et…":** Karantina depodaki **TAM miktarı** (girişteki kg, değiştirilemez — kısmi/parçalı iade YOK,
  kullanıcı kararı) sarf (stok virman, **ÇIKAN**) fişiyle düşer (`mikroStock.previewVirman({depotNo:
  KARANTINA_DEPO_NO, direction:'cikan'})`) — Mikro'nun defterinden tamamen çıkar, fiziksel olarak da tedarikçiye
  geri gönderildi. Geri alınamaz; UI `window.confirm()` ile onay ister (bu kadar basit bir onay yeterli görüldü,
  Hurda Girişi'ndeki iki adımlı modal onay GEREKMEDİ — tek buton + net uyarı metni).
- **Her deneme (başarılı/başarısız) kalıcı kaydedilir, elle yeniden denenebilir** — `product-depot.js`/
  `quarantine-depot.js` ile AYNI felsefe, ama DAHA BASİT uygulama: her kayıt TEK sabit miktar taşıdığı için
  (delta/kısmi gönderim yok) kendi ayrı bir ledger tablosu YOK, durum doğrudan kayıt satırında tutulur.
  **Mikro yazma kapalıyken** ("özellik kapalı" gibi — `PRODUCT_DEPOT_ENABLED` BURADA KULLANILMAZ, o kapının
  gerekçesi "fabrika PC'si/paketleme sahada değil"; bu özellik paketlemeyle ilgisiz, doğrudan ofisten kullanılan
  bir Hammadde ekranı özelliği, hammaddenin mevcut "Depolar arası sevkiyat" dialoğuyla AYNI kapıyı — yalnız
  `MIKRO_WRITE_ENABLED` — paylaşır) kayıt yine OLUŞUR ama "aktarılamadı" ile hata metni DB'ye de yazılır (ürünün
  diğer depo modüllerinden FARKLI: oralarda "kapı kapalı" bir ledger satırı BIRAKMAZ, çünkü kullanıcı orada bir
  düğmeye basıp sonucu beklemiyor; burada az önce bastı ve "neden aktarılamadı" görmesi gerekiyor).
- **Silme:** yalnız admin değil, `hammadde:yazabilir` olan her rol (mevcut hammadde yazma yetkisiyle AYNI); ama
  **Karantina'da GERÇEKTEN duran (sevkiyatı başarılı, henüz iade edilmemiş) bir kayıt SİLİNEMEZ** (409
  `has-movement`) — bu modülün tek kaydı, Mikro'daki o stok hareketinin TEK takip yeridir, önce "İade et…" gerekir.
- **Dosyalar:** `backend/planning/material-quarantine.js` (`MaterialQuarantine`, tablo `material_quarantine`,
  `planlama.db`'de kendi `CREATE TABLE IF NOT EXISTS`'i ile — diğer alt modüllerle aynı desen), `planning.js`
  (`this.materialQuarantine`), `routes.js`, `dashboard/planning-material.js` (dördüncü sekme + "Karantinaya
  aktar…" dialoğu — "Depolar arası sevkiyat" dialoğunun hammadde-arama kısmıyla AYNI UI parçaları, depo seçimi
  YOK çünkü Merkez→Karantina SUNUCUDA sabit). `mikro-stock.js`'teki `kgAmount`/`stockCodeOf` dışa aktarıldı (ayrı
  bir kopya YAZILMADI — bu özellik aynı kg/stok kodu doğrulama/ayrıştırmasını birebir kullanır).
- **Uçlar:** `GET /api/planning/material/quarantine?status=` (liste; mevcut `GET /api/planning/material*`
  joker izniyle zaten okunabilir) · `POST /api/planning/material/quarantine {stockCode, stockName?, kg, note?}`
  ("Karantinaya aktar", 201) · `POST .../quarantine/:id/retry-transfer` · `POST .../quarantine/:id/return`
  ("İade et") · `DELETE .../quarantine/:id`. Yazma uçları `hammadde:yazabilir`; silme de dahil (diğer
  karantina/takip özelliklerindeki "silme kayıtsız → admin" deseninden BİLİNÇLİ SAPMA: burada silinebilirlik
  zaten Mikro hareket durumuna göre kısıtlı, ayrıca admin'e indirgemeye gerek görülmedi).
- **Doğrulama:** `backend/planning/material-quarantine.test.js` (10 test: doğru Mikro gövdesi — depo
  numaraları + evrak türü + Türkçe binlik ayracı, başarısız denemenin kayıt bırakması, yeniden deneme + zaten
  başarılıyı reddetme, kapı kapalıyken kayıt + hata metni, iade'nin AYNI kg ile sarf fişi göndermesi, iade
  öncesi/sonrası durum kısıtları, iade başarısız olursa "karantinada" kalıp yeniden denenebilmesi, silme
  kısıtı, liste süzgeci, uçtan uca HTTP). `npm test` 727/727 yeşil. Tarayıcıda gerçek sunucuya (AUTH_DISABLED)
  karşı denendi: sekme + boş liste + "Karantinaya aktar…" dialoğu doğru render oldu, hammadde arama kutusu
  "Depolar arası sevkiyat" dialoğuyla AYNI hata yolunu ("MikroAPI yapılandırılmadı") doğru gösterdi (bu
  makinede gerçek Mikro bağlantısı yok); hiçbir kayıt oluşturulmadan dialog kapatıldı.
- **Bu ÖZELLİK için ayrıca gerçek bir Mikro denemesi YAPILMADI, ama kullanıcı kararı (2026-11-10): buna gerek yok**
  — altta yatan mekanizma zaten gerçek yazmayla kanıtlı: (1) `mikroStock.previewTransfer`/`previewVirman`
  (hammadde, kg, evraktip=2/tip=2/cins=6 transfer + evraktip=6/tip=1/cins=3 virman-çıkan) **G aşamasında GERÇEK
  hammadde stok kodlarıyla** (`HM617.AA30.00XYU18.00`, `HM614.AA25.00`) doğrulandı (bkz. yukarıdaki "G aşaması
  — GERÇEK ilk yazma denemesi" ve "SARFİYAT (VİRMAN) TARAFI DA GERÇEK YAZMAYLA DOĞRULANDI"); (2) **KARANTİNA
  DEPO (dep_no=5)**'nun kendisi `quarantine-depot.js`'in GİRİŞ/OK/Hurda akışında gerçek yazmayla doğrulanmıştı
  (bkz. "Karantina deposu — iş emri bağlantısı + Mikro" — orada adet/ürün koduyla, burada kg/hammadde koduyla,
  ama depo numarasının Mikro tarafındaki davranışı miktarın kg mı adet mi olduğundan bağımsız). Bu özellik bu
  iki kanıtlı parçayı YENİDEN BİRLEŞTİRİYOR (farklı depo çifti + hammadde stok kodu), yeni bir Mikro çağrı
  biçimi İCAT ETMİYOR — bu yüzden ayrı bir "yönetici ile ilk deneme" adımı GEREKMİYOR. Hiç denenmedi (tasarım
  gereği, Mikro riskiyle ilgisiz): kısmi iade ihtiyacı çıkar mı (şimdilik yok); "aktarılamadı" durumundaki bir
  kaydı silmek yerine düzeltip yeniden denemek isteyen kullanıcı için "düzenle" akışı yok (yalnız sil + yeniden
  "Karantinaya aktar" ile aç).

**Gerçek tornada henüz DOĞRULANMAYANLAR (ilk kullanımda küçük bir testle bakılmalı):**
`RNTO`'nun hedefte aynı ad varken davranışı (sahte sunucu reddeder; CE ezebilir → bu yüzden
gönderme öncesi ve adlandırmadan hemen önce `LIST` ile ikinci çakışma denetimi var, yine de
milisaniyelik yarış penceresi kalır) · `DELE` (silme) · **`MKD`** (başarı yanıt kodu 257 mi 250 mi,
ad/uzunluk kısıtı, panelde hemen görünüyor mu; kod yalnız sahte sunucuda sınandı) · bu özelliğin **arayüzü** hiç
gerçek torna ile uçtan uca denenmedi (yalnızca FTP komut dizisi torna 8'de elle doğrulandı) ·
çok büyük klasörlerde (>200) tarama süresi · **tornadaki dosyayı yeniden adlandırma** (`RNFR`/`RNTO`, 2026-10-30; yalnız sahte FTP'de sınandı).

### Bakım (EYS.FR.016 "Bakım Kayıt Formu" + Bakım Sicil Kartları → dijital bakım takip ekranı) — 2026-11-11, kullanıcı isteği

Fabrika iki kağıt formla bakım yönetiyordu: **Bakım Sicil Kartları** (12 sayfa, BS.001–BS.012 — her biri bir makinenin
SABİT planı: ne bakımı yapılacak, ne sıklıkla — PERİYODU: "Her vardiya başlarken", "Vardiyada 2 kez", "Günlük",
"Haftalık", "Aylık", "4 aylık (Mart-Temmuz-Kasım)", "6 aylık (Mart ve Eylül)", "Yıllık (Mayıs)" — kim yapacak, nereye
kaydedilecek) + **EYS.FR.016 Bakım Kayıt Formu** (her makine için boş bir takip formu: haftalık/aylık tik kutuları +
"Rutin Bakım Kaydı"/"Arızi Bakım Kaydı" serbest log). Müşteri bu akışı beğenmedi: istenen (1) **"makine tipi seç →
bakımları gör" şeklinde açılır/kapanır (expandable) bir ekran**, (2) periyotların **koda gömülü sabit DEĞİL, admin
tarafından ayarlanabilir** olması (müşteri örneği: "bu ayda bir değil ayda 2 olmalı") — **usta yalnızca tik atar**,
periyodu seçmez/değiştirmez.

- **Veri modeli (`backend/planning/maintenance.js`, `planlama.db`):** periyotlar **TİP bazında** tanımlanır (7 CNC
  torna birebir aynı 13 kalemlik listeyi paylaşıyor; admin bir periyodu düzeltince hepsi birden değişir — kağıttaki
  "7 ayrı ama birbirinin kopyası kart" yerine TEK tanım), tik atma/geçmiş **makine (asset) bazındadır** (CNC-03 ile
  CNC-05'in kendi ayrı geçmişi var). 4 tablo: `maintenance_types` (serbest, admin yönetir — "CNC TORNA", "KOMPRESÖR"…),
  `maintenance_assets` (fiziksel envanter: sicil no, makine no, marka/model, motor gücü, satınalma notu, isteğe bağlı
  `cnc_machine_id` — CNC tornalar için `config/machines.json`'daki CNC-01..08'e görsel çapraz referans, zorunlu değil),
  `maintenance_items` (bir TİPİN kalemleri — açıklama, sorumlu, "kayıt" (hayır/değişimde/her zaman — "(!) değişim
  olursa not" ve "EYS.FR.016'ya her zaman" ayrımı), **admin-ayarlanabilir periyot alanları**: `period_unit`
  (vardiya/gün/hafta/ay/yıl), `period_every` (kaç birimde bir), `times_per_period` (birim içinde kaç KEZ — müşterinin
  "ayda 2" örneği: ay + every=1 + times=2), `anchor_months` (JSON, 1-12 — "4 aylık Mart-Temmuz-Kasım" gibi TAKVİME
  SABİT periyotlar için; admin ekrandan 12 aylık tik listesiyle seçer, "4 mü 6 mı" yazmaz), `maintenance_logs` (her
  tik VE her serbest rutin/arızi kayıt; `item_id=null` → EYS.FR.016'nın serbest log'u; `changed` — yalnız
  "(!)" kalemlerde "sadece kontrol mü, değişim/müdahale mi" ayrımı, evet ise Rutin Bakım Kaydı'na da düşer).
- **Durum hesabı (yeşil/sarı/kırmızı), `calibrationStatus()` (measuring-devices.js) ile aynı felsefe — saf,
  `now` enjekte edilebilen fonksiyonlar (`nextDueAt`/`dueStatus`), ama ÖNEMLİ bir tasarım inceliği: ilk yazımda
  vardiya/gün/hafta gibi AYRIK pencereler `referenceAt`'tan bugüne TÜM tarihi tek tek yürüyordu — gerçek Excel'i
  içeri aktarırken bu, **eski (haftalar/aylar önce) tek bir kaçırılmış gün sonsuza dek "gecikti" göstermesi**
  anlamına geliyordu (tarayıcıda denenirken fark edildi). Düzeltildi: artık yalnız **ŞİMDİKİ ve ONDAN BİR ÖNCEKİ**
  pencereye bakılır (şimdiki tamamsa sıradakine atlanır; değilse önceki de kaçırıldıysa zaten gecikmiş, öncekinden
  önce bir "geçerli önceki dönem" yoksa — kalem/makine o zaman henüz yoksa — şimdikinin kendi sonuna kadar normal).
  Takvime sabit aylar (`anchorMonths`) için de AYNI ilke: yalnız EN SON (şimdiki ya da en son geçmiş) anchor ayına
  bakılır. **Taze eklenen bir kaleme/makineye de aynı mantıkla bir "grace" (geçiş) süresi tanınır** — Excel'den
  yeni aktarılan "6 aylık yağ değişimi" gibi hiç tiklenmemiş bir kalem anında kırmızı görünmesin diye (ilk yazımda
  böyleydi, gerçek veriyle denenirken KOMPRESÖR tipinin yanlışlıkla "gecikti" göründüğü fark edilip düzeltildi).
  `grace` penceresi birime göre ölçeklenir (vardiya/gün 0, hafta 2 gün, ay 5 gün, yıl 15 gün).
- **Excel içeri aktarma (bir kerelik ilk kurulum, `importXlsx`):** her SAYFA bir makineye karşılık gelir; aynı tip
  (ör. "CNC TORNA") birden çok sayfada tekrarsa kalemler YALNIZ İLK sayfadan oluşur (periyotlar tip bazında,
  tekrar yaratılmaz). Sicil no (sayfanın İÇİNDEKİ "Sicil No:  BS.00X" hücresinden — sayfa SEKME ADINDAN DEĞİL)
  zaten kayıtlıysa o sayfa atlanır. PERİYODU metni bilinen kalıplara göre ayrıştırılır (`parsePeriodText`);
  TANINMAYAN bir metin **asla sessizce tahmin edilmez** — `period_unit` güvenli bir varsayılanla (`gun`) içeri
  alınır ve uyarı listesine düşer, admin elle düzeltir. Motor gücü gibi Excel'den gelen GERÇEK SAYISAL hücreler
  (ör. `7.5`) paylaşılan `fields.js#number()`'ın Türkçe binlik-ayracı kuralından (`"."` HER ZAMAN binlik ayracı)
  BİLEREK GEÇİLİR — `readXlsx` zaten her sayıyı nokta-ondalık METNE çevirdiği için burada `"."` gerçek bir ondalık
  noktasıdır, motor gücü de asla binlerce KW olmaz; bu yüzden `7.5 → 75` gibi sessiz bir hataya düşmemek için bu
  alan için ayrı, basit bir ondalık ayrıştırıcı kullanılır (sayısal alanların TÜMÜ için değil, yalnızca bu alan).
- **Gerçek dosyayla uçtan uca denendi (bu makinenin dev veritabanı, 2026-11-11):** BAKIM SİCİL KARTLARI.xlsx (12
  sayfa) içeri aktarıldı → **4 tip, 11 makine eklendi, 1 sayfa atlandı.** Atlanan sayfa gerçek bir veri kalitesi
  sorununu ortaya çıkardı: **BS.012 ("BÜYÜK CNC TORNA") sayfasının kendi İÇİNDEKİ "Sicil No" hücresi yanlışlıkla
  "BS.010" yazıyor** (muhtemelen kopyala-yapıştır hatası — kâğıt sicil kartının kendi notunda da benzer bir
  "makine numarası sonradan değiştirildi" kaydı var, bkz. BS.001/003/004/005'in NOT alanları); içeri aktarıcı sayfa
  SEKME ADINA değil hücre İÇERİĞİNE güvendiği için bunu doğru şekilde "zaten kayıtlı" diye ATLADI (yanlış bir
  ikinci "BS.010" asset'i YARATMADI) ve uyarı listesine düşürdü — admin kaynak Excel'deki hücreyi düzeltip yeniden
  yüklerse (idempotent) yalnız o sayfa eklenir. **"BÜYÜK CNC TORNA" tipi ve kendi bakım planı bu yüzden henüz hiç
  oluşmadı** (BS.012 tek örneğiydi). Tarayıcıda uçtan uca denendi: 2 seviyeli açılır/kapanır liste (makine tipi →
  makine → kalem tablosu), "Tik at" (not/firma/"değişim yapıldı mı" ile, `requiresNote`'a göre koşullu alanlar),
  "Geçmiş" penceresi, **"Bu tipin bakım planını düzenle…"** — "Körüklerin sökülüp…" (Aylık) kalemi "Ayda 2 kez"e
  çevrilip kaydedildi ve **TEK düzenleme CNC TORNA tipindeki 7 makinenin TAMAMINA anında yansıdı** (müşterinin asıl
  isteği budur), sonra geri alındı (yalnız doğrulama amaçlıydı). "Yeni makine ekle" penceresi de denendi.
  **Gerçek import SONUCU (4 tip, 11 makine) dev veritabanında KALDI** (önceki EYS.LS içeri aktarımlarıyla aynı
  ilke); yalnız doğrulama amaçlı test tiki ve geçici periyot değişikliği temizlendi.
- **Ekran:** `dashboard/planning-maintenance.js`, yeni ekran `bakim` (Kalite grubu, Ölçüm Cihazları Takip'in yanına).
  İki seviyeli accordion kütüphane ekranının "klasöre göre grupla" mekaniğiyle AYNI (`<details class="grp">`,
  `dashboard/styles.css`'teki hazır `.grp`/`.grp-body`; yalnız dış grubun kırpılmaması için `.mnt-grp>.grp-body{
  max-height:none}` eklendi). Veri küçük olduğu için (≈5 tip, ≈12 makine, ~150 (makine,kalem) çifti) accordion
  yalnız RENDER'ı geciktirir — tüm veri `GET /api/planning/maintenance` ile TEK istekte gelir, ayrı sayfalama yok;
  bir makinenin TAM log geçmişi ayrı, istek üzerine (`GET .../assets/:id/logs`) çekilir (overview şişmesin).
- **Yetki (esnek rol sistemi):** `bakim` ekranı (writable:true) — genel görünüm + tik atma/rutin-arızi log role'e
  (`'bakim'` write); tip/kalem/makine CRUD, log silme ve Excel içeri aktarma KAYITSIZ bırakılır → admin'e düşer
  (periyodu yalnızca yönetici ayarlar; Hurda Girişi/Ölçüm Cihazları Takip'teki "günlük kullanım role'e, idari
  işlemler admin'e" deseniyle aynı).
- **Testler:** `backend/planning/maintenance.test.js` (18: periyot metni ayrıştırma — tüm bilinen kalıplar + taninmayan
  kalıp null döner —, durum hesabı — gün/vardiya/hafta ayrık pencere + ay anchor + ay rolling, şimdiki+önceki pencere
  kuralı dahil —, tip/kalem/makine CRUD + silme kısıtları, log ekleme kuralları, overview arama/en-kötü-durum
  yukarı taşıma, Excel içeri aktarma — tip paylaşımı/dedup, tanınmayan periyot uyarısı, tablo bulunamama —, HTTP
  uçtan uca). `npm test` 747/747 yeşil.
- **DENENMEDİ:** gerçek yazıcıdan baskı (bu ekranın kâğıt karşılığı yok, kâğıt sicil kartı + EYS.FR.016'nın yerini
  dijital olarak alıyor, "Listeyi yazdır" bilinçli olarak eklenmedi); fabrika PC'sinde/gerçek kullanımda ustaların
  tik atma akışını nasıl bulduğu; admin'in bu ekranı hangi role (yeni ya da var olan) açacağına karar vermesi
  (göçle gelen İzleyici/Operatör rollerine otomatik eklenmedi — diğer yeni ekranlarla aynı, `Ayarlar > Roller`den
  elle verilir); BS.012'nin gerçek sicil no'sunun düzeltilip yeniden içeri aktarılması; `cnc_machine_id` çapraz
  referansının gerçek kullanımı (CNC-08'in fiziksel olarak "BÜYÜK CNC TORNA" APEX 65 DYW olabileceği, BS.012'nin
  "makine numarası 8" notundan ve CLAUDE.md §3'teki 22TB/APEX bulgularından ÇIKARILDI, kesin doğrulanmadı).

**Bakım: otomatik tik (2026-11-19, kullanıcı bulgusu):** kullanıcı Bakım ekranındaki tik atmanın fiilen GÜNLÜK KULLANILMADIĞINI,
ustaların yalnızca **denetim geldiğinde** geriye dönük doldurup gösterdiğini belirtti — "saati geldiğinde otomatik olarak **random
saatlerde** tik atsın ama istedikleri zaman kapatabilmek istiyorlar, Ayarlar sayfasından kontrol edebilsinler, **her makine için**
rastgele olması önemli" (makinelerin aynı anda, senkron bir saatte tiklenmesi istenmedi).
- **Mekanizma, var olan `nextDueAt()`/`dueStatus()` mantığına BİNER, ayrı bir "periyot penceresi" İCAT EDİLMEDİ** (`maintenance.js`
  `runAutoTick({now, random})`, `schedule.js#suggest({run})` ile AYNI "test için enjekte edilebilir bağımlılık" ilkesi): bir kalem
  yalnız **kendi** `dueStatus`'u `'tamam'`DEĞİLKEN (grace penceresine girmiş ya da zaten gecikmiş) ele alınır. O pencere için (asset,
  item, due_at) üçlüsü **ilk** görüldüğünde `maintenance_auto_queue` tablosuna bir satır açılır ve **HER MAKİNE için BAĞIMSIZ** bir
  rastgele hedef an seçilir (`target = now + random() * pencere`); henüz vadesi gelmemiş ama grace'e girmiş kalemde pencere
  `[şu an, vade]`, **zaten gecikmiş** kalemde (grace=0 olan gün/vardiya gibi birimler) pencere `[şu an, şu an+6 saat]`
  (`AUTO_CATCHUP_MAX_MS`) — aksi halde çok geciken bir kalemin hedefi haftalarca ileri düşebilirdi. Hedef ana gelinmeden **hiçbir şey
  olmaz** (ne yeni bir kuyruk satırı açılır ne mevcut biri ateşlenir); hedef geçince var olan `addLog()` ile **gerçek bir** `kind='kontrol'`
  tiki, kayıt sahibi (`person`/`created_by`) **`'Otomatik'`** (`AUTO_PERSON`) ile atılır — ayrı bir "otomatik mi insan mı" sütunu
  İCAT EDİLMEDİ, ekranın var olan "Son yapılan"/"Geçmiş" sütunları bunu olduğu gibi gösterir (bu ekranda henüz basılan bir form
  olmadığı için gizlenmesi de gerekmiyor).
- **Anahtar, VARSAYILAN AÇIK** (`getSetting('bakim.otomatikTik')`, hiç ayarlanmamışsa `'0'` DIŞINDA her şey = açık — özelliğin asıl
  amacı bu): **KAPATILINCA GERÇEKTEN durur**, `runAutoTick()` fonksiyonun en başında döner — ne yeni bir hedef planlanır ne bekleyen
  bir hedef ateşlenir. Anahtar **Bakım ekranının kendi üst çubuğunda** (yalnız admin, `dashboard/planning-maintenance.js`), **ayrı bir
  "Ayarlar" sayfasında DEĞİL** — araştırılıp `#/ayarlar`'ın (telemetri makine/sürücü ayarları + ortak Kullanıcılar/Roller) bu
  ekranda hiç görünmediği (Planlama bağlamında gizli) ve içeriğinin Planlama'ya özgü olmadığı görülünce, Numune Takip/GKK'nin kendi
  ekranına gömülü admin-only sıra tabanı kutularıyla AYNI yerleşim tercih edildi.
- **Çalıştırma:** `server.js`'te `planning.maintenance.runAutoTick()` açılışta bir kez + `setInterval(..., 15*60_000).unref()`
  (15 dk'lık aralık — "rastgele saat" hissini bozmayacak kadar sık, fabrika içi diğer periyodik işlerle aynı desen).
- **Temizlik (büyümeyi sınırlar):** ateşlenmiş satırlar 400 gün (`AUTO_FIRED_RETENTION_MS`, diğer uzun-vadeli telemetri saklama
  süreleriyle aynı mertebe), **ateşlenmemiş yetim** satırlar (usta hedef anından ÖNCE elle tiklerse o pencerenin `due_at`'i artık
  geçersiz olur, bir daha hiç sorgulanmaz) 30 gün (`AUTO_ORPHAN_RETENTION_MS`) sonra silinir.
- **Yetki:** iki uç (`GET`/`PUT /api/planning/maintenance/auto-tick`) `policy.js`'te **KAYITSIZ bırakıldı** → admin'e düşer (Bakım
  ekranının kendisindeki "idari işlemler admin'e" deseniyle aynı — periyodu da yalnız yönetici ayarlıyor).
- **Testler:** `backend/planning/maintenance.test.js`'e 7 yeni test (anahtar varsayılan açık + round-trip, henüz vadesi gelmemiş
  kalemde hiçbir şey planlanmaz, **kapalıyken** ne planlama ne ateşleme, vade gelince **iki farklı makine için bağımsız rastgele
  hedef** + hedefe kadar ateşlenmeme + hedeften sonra gerçek tik + `person='Otomatik'`, grace penceresindeki (henüz gecikmemiş)
  kalemde hedefin `[şu an, vade]` aralığından seçilip 6 saatlik yakalama penceresiyle SINIRLI olmaması, eski ateşlenmiş/yetim kuyruk
  satırlarının temizlenmesi, HTTP GET/PUT) + `backend/auth/policy.test.js`'e yeni bir `bakim` ekran testi (bu arada **bu ekranın hiç
  policy testi olmadığı fark edildi** — tip/kalem/makine CRUD, Excel içeri aktarma, log silme ve bu iki yeni uç hepsi admin'e düştüğü
  doğrulandı). `npm test` 871/871 yeşil.
- **DENENMEDİ:** gerçek fabrika PC'sinde/gerçek kullanımda (yalnız enjekte edilmiş `now`/`random` ile birim testli); rastgele
  zamanlamanın haftalarca sürede gerçekten "organik" (fark edilmeyecek kadar dağınık) görünüp görünmediği; kapatmanın tam bir döngü
  ortasında (hedef zaten planlanmışken) gerçekten durduğu yalnız testle sınandı, tarayıcıdan uçtan uca denenmedi.

### Mail'den otomatik sipariş girişi — SONRAKİ MODÜL, 2026-11-16/17 kullanıcı istişaresi, PDF OKUMA TEMELİ ATILDI

Şu an yönetici gelen sipariş maillerine (Excel veya PDF ekli) bakıp siparişi **tek tek elle** Mikro'ya giriyor. Kullanıcı
bunu otomatikleştirmek istiyor. Tasarım kararları netleşti (aşağıda), kullanıcı **4 gerçek sipariş PDF'i** verdi ve
bunlardan **PDF'ten metin okuma alt yapısı (`backend/planning/pdf-text.js`) yazılıp gerçek dosyalarla doğrulandı**
(aşağıdaki "PDF metin okuma" bölümü). **Aynı oturumda devam edilip tablo ayrıştırma, müşteri eşleme, taslak veritabanı
ve onay ekranı da YAPILDI** (aşağıdaki "Tablo ayrıştırma + taslak veritabanı + onay ekranı" bölümü). Henüz yapılmayan:
Tesseract OCR, revizyon karşılaştırmasının gerçek bir e-posta HTML'iyle doğrulanması, Mikro'ya yeni sipariş yazma
(kullanıcı kararıyla BU TURDA bilerek atlandı), mail (Graph API) bağlantısı.

**İstenen akış (kullanıcının kendi tarifi):** Siparişler ekranına yeni bir sekme. (1) **"Yeni siparişleri tara"** —
mail kutusu (Outlook/Microsoft 365) taranır, sipariş eki (Excel/PDF) bulunan yeni mailler ayrıştırılıp sipariş
taslağı çıkarılır. (2) **"Revizyon yap"** — maildeki revizyon dosyasını bulur, var olan siparişle karşılaştırır
(iptal, termin tarihi değişikliği, adet değişikliği gibi farkları), bir **karşılaştırma/onay ekranı** açar; yönetici
doğruysa onaylar, değilse ürün bazında elle düzeltebilir.

**Karar (2026-11-16, kullanıcı onayladı): hem YENİ sipariş hem REVİZYON için "göster-onayla", SESSİZ OTOMATİK YAZMA YOK.**
İlk teklifte kullanıcı yeni siparişlerin otomatik yazılmasını, yalnız revizyonların onaylanmasını düşünmüştü; bu oturumda
projenin genelindeki "Mikro'ya yazmadan önce göster/onayla" alışkanlığıyla tutarlı olsun diye **ikisi de** onay ekranından
geçecek şekilde netleşti — yanlış ayrıştırılan bir sipariş sessizce Mikro'ya gitmeyecek.

**Mail kutusu — Microsoft 365, ama fabrika PC'sinde Outlook AÇILMAYACAK (kullanıcı kararı):** fabrikadaki PC (telemetri/
planlama backend'inin çalıştığı, ortak alanda duran PC) üzerinde Outlook istemcisi açılamaz — mailde gizli/hassas içerik
var, PC ortak alanda. Bu, düşünülen teknik yaklaşımı ENGELLEMİYOR: **Microsoft Graph API** (OAuth2, `mikro-client.js`'teki
gibi düz `fetch` ile, ek npm paketi gerekmez — sıfır-bağımlılık ilkesi korunur) ile arka plandan HTTPS çağrısı yapılır,
hiçbir PC'de Outlook istemcisi AÇILMAZ, ekranda yalnız ayrıştırılmış sipariş verisi gösterilir — mail kutusunun kendisi
hiçbir zaman görüntülenmez. Microsoft 365'te IMAP temel kimlik doğrulama büyük olasılıkla kapalı (Microsoft 2022'de
kaldırdı), bu yüzden Graph API + Azure AD'de **bir kerelik uygulama kaydı** (IT/yönetici işi, kod değil) gerekecek.
- **Çözülmesi gereken asıl risk, Outlook'u açmamak DEĞİL, API'nin erişim ALANI:** yöneticinin genel/kişisel kutusuna
  bağlanırsak, okuma izni o kutudaki HER ŞEYE (gizli mailler dahil) erişebilir — ekranda göstermesek de bir hata/log
  satırında gizli içerik sızabilir. **Önerilen çözüm (kullanıcıya iletildi, henüz KARARLAŞTIRILMADI):** sipariş için
  AYRI, özel bir paylaşımlı kutu (ör. `siparis@...`) — müşteriler direkt oraya gönderiyor olabilir ya da yöneticinin
  kutusundan sipariş maillerini otomatik ileten bir Outlook kuralıyla beslenir; Azure AD uygulaması "Application Access
  Policy" ile SADECE bu kutuya sınırlanır, gizli içerik API'nin erişim alanına hiç girmez.
- **Tetikleme MANUEL** (kullanıcının tarifi: "tuşa basınca tarar") — zamanlanmış/webhook tarama DEĞİL, şimdilik.

**PDF ayrıştırma — KARAR: hibrit, zor dosyada Claude API DEĞİL ücretsiz Tesseract OCR (2026-11-17, kullanıcı kararı):**
önce sıfır-bağımlılık bir ayrıştırıcı denenir (çoğu dosyayı okur, aşağıya bakın); yalnız o da okuyamazsa (taranmış
sayfa) **Tesseract OCR** (ücretsiz/açık kaynak, Python/OR-Tools'u gömdüğümüz yöntemle AYNI şekilde installer'a
gömülecek, dosya başına dış servise/API'ye GİTMEZ) devreye girer — henüz yazılmadı. Claude API/LLM tabanlı çıkarma
kullanıcı tarafından AÇIKÇA REDDEDİLDİ ("ücretsiz bir model kullanalım, Claude API'ye düşmeyelim").

#### PDF metin okuma (`backend/planning/pdf-text.js`, 2026-11-17, kullanıcının 4 gerçek sipariş PDF'iyle doğrulandı)

**Gerçek dosyalarda bulunan çeşitlilik (ham bayt incelemesiyle, tahmin değil):** 4 örnek, 4 FARKLI üretici/iç yapı —

| Dosya (müşteri) | Üretici | Font/kodlama |
|---|---|---|
| `2611000084...` (Siamp) | iText | Type0 (CID) + `/ToUnicode` (bfchar/bfrange) |
| `SAS0003812...` (Ayvaz/Ha-Vana) | Tarayıcı "PDF olarak yazdır" (Skia/Firefox) | Type0 + `/ToUnicode`, **ama konum `Tm`'de DEĞİL `cm`'de** |
| `4100018539...` (Konveyör) | Adobe LiveCycle Designer (form) | Gövde metni basit font + `/Encoding /WinAnsiEncoding` (ToUnicode YOK, gömülü de değil); yalnız birkaç Türkçe harf (İ/ı/Ş/ş/ğ) ayrı, küçük bir CID fontla (`/ToUnicode` VAR ama yalnız 5 kod) |
| `2189_001...` (Ayvaz, 2.) | **Canon fotokopi/tarayıcı** | Hiç font/metin YOK — sayfalar düz TARANMIŞ GÖRÜNTÜ (JPEG, 0 Tj/TJ operatörü) |

**Mimari: PDF nesne modeli (xref/xref akışı/ObjStm/onarma) ve akış çözme (Flate+öngörücü) `backend/pdf-merge.js`'ten
AYNEN kullanılır (`openForText` yeni dışa aktarımı; `Lexer`/`Kw`/`Name`/`Stream`/`nameOf` de dışa açıldı) — İKİNCİ bir
PDF ayrıştırıcı YAZILMADI.** `pdf-text.js` yalnız İÇERİK AKIŞI metin gösterme komutlarını (q/Q/cm, BT/ET, Tf, Tm/Td/TD,
Tj/TJ) izler ve kod→Unicode çevirir. `Lexer.value()` zaten bilinmeyen bir sözcüğü (içerik akışı OPERATÖRÜ, ör. "Tj")
`Kw` olarak döndürdüğü için **ayrı bir içerik-akışı sözcük çözümleyici de YAZILMADI**, aynı Lexer kullanıldı.

- **Kod→Unicode, iki katmanlı (gerçek dosyalarla sırayla bulunan ihtiyaç):** (1) önce fontun `/ToUnicode` akışı
  (bfchar tek tek + bfrange hem doğrusal `<lo><hi><dst>` hem dizi `<lo><hi>[<d1><d2>...]` formu) denenir; (2) YOKSA ve
  font **CID olmayan basit bir fontsa** (`/Subtype` Type0 değilse) `/Encoding` açıkça `/WinAnsiEncoding` ise (ya da
  **hiç verilmemişse** — PDF'in güvenli varsayılanı) standart WinAnsi (= Windows-1252/CP1252, PDF Ek D) tablosuna
  düşülür. **Bu ikinci katman (WinAnsi), Konveyör'ü ilk bakışta "çözülemez" sanılan (CFF/font-tersine-mühendislik
  gerektirir düşünülen) bir dosyadan TAM OKUNUR bir dosyaya çevirdi** — gerçek bulgu: `FontDescriptor` yok (gömülü
  değil) + `Encoding` düz `/WinAnsiEncoding` adı, yani STANDART bir kodlama, özel/gömülü değil. `/Differences` (ad
  bazlı tekil geçersiz kılma) BİLİNÇLİ OLARAK yok sayılır — yalnız o birkaç kod yanlış/boş çözülür.
- **`cm` (grafik dönüşüm matrisi, `q`/`Q` ile yığınlanır) izlenir — İLK yazımda İZLENMİYORDU ve bu GERÇEK bir hataydı:**
  Ayvaz/Ha-Vana dosyasında metin doğru çözülüyordu (Unicode harfler doğruydu) ama SIRASI tamamen KARIŞIKTI, çünkü bu
  üretici metnin gerçek sayfa konumunu `Tm`'de değil `cm`'de veriyor; `cm` yok sayılınca tüm hücreler/satırlar birbirine
  karışıyordu. Düzeltme: `q`/`Q` ile yığınlanan CTM eklendi, metin konumu `Tm`'nin (e,f) noktasının CTM ile dönüştürülmüş
  hâli olarak hesaplanıyor (dönme/eğiklik dahil, nokta dönüşümü olarak doğru; yalnız karakterin KENDİ genişliği/dönmesi
  hesaba katılmıyor). Düzeltildikten sonra sıra TAM doğru çıktı (gerçek belge sırasıyla birebir, aşağıdaki "doğrulama"ya bakın).
- **Sözcük/hücre ayrımı (boşluk nereye konur) font genişlik tablosu OLMADAN GÜVENİLİR DEĞİL — gerçek ölçümle
  kanıtlandı:** Ayvaz/Ha-Vana dosyasında "Satınalma Belgesi" sözcüğü içindeki harf-arası boşluk (ör. 'm'→'a': 8,0 pt)
  ile GERÇEK sözcük arası boşluk ('a'→'B': 7,5 pt) NEREDEYSE AYNI büyüklükte çıktı — yani "büyük boşluk = yeni sözcük"
  gibi basit bir eşik İŞE YARAMAZ (dar/geniş harfler çok değişken). Bu yüzden `pdf-text.js` sözcük/sütun ayrımı YAPMAZ,
  yalnız **SATIR sırasını ve satır içi X sırasını** verir (`groupRunsIntoLines`) — sütun/alan çıkarma (müşteri kodu,
  miktar, tarih gibi gerçek SİPARİŞ ALANLARINI ayırma) ayrı, henüz yazılmamış bir modülün işi; o modülün müşteri/alan
  tespiti için BOŞLUKSUZ birleştirilmiş metin + anahtar kelime/regex eşleşmesi kullanması öneriliyor (sayısal kod/miktar
  gibi alanlar zaten boşluksuz tek parça, müşteri tespiti de boşluksuz anahtar kelimeyle yapılabilir).
- **Taranmış sayfa tespiti** (`unreadable:'scanned'`): hiç metin gösterme komutu yoksa VE sayfada `/Subtype/Image`
  XObject varsa — bu, Tesseract OCR'ın devreye gireceği durumu işaretler (henüz OCR modülü yazılmadı).
- **`unreadable:'no-cmap'`**: metin gösterme komutları VAR ama hiçbiri yukarıdaki iki katmanla (ToUnicode/WinAnsi)
  çözülemedi — gömülü, standart olmayan bir kodlamalı CID/CFF font demektir (4 gerçek örnekte bu duruma hiç
  RASTLANMADI, yalnız teorik bir ihtimal olarak ele alınıyor).
- **Doğrulama:** `backend/planning/pdf-text.test.js` (11 test, kendi ürettiğimiz küçük sentetik PDF'lerle: ToUnicode
  bfchar+bfrange her iki form, Type0 2-bayt kod, `cm`/`q`/`Q` matris takibi, `BT`'nin metin matrisini sıfırlaması,
  WinAnsi geri düşümü — hem açık ad hem Encoding hiç verilmemiş hâli —, `TJ` dizisinin ayarlama sayılarını yok sayması,
  taranmış sayfa + no-cmap tespiti, `groupRunsIntoLines` satır/sütun sıralaması). `npm test` 779/779 yeşil.
  **Gerçek 4 dosyayla elle doğrulandı:** Siamp VE Konveyör (`cm` düzeltmesinden sonra) **TAM VE DOĞRU** okundu (her
  alan — sipariş no, tarih, ürün kodu, miktar, fiyat, teslim tarihi — gerçek belgeyle birebir eşleşti); Ayvaz/Ha-Vana
  metni DOĞRU sırada ama karakter karakter ayrı hücreler hâlinde (sözcük birleştirme yapılmadığı için — yukarıya
  bakın); Ayvaz'ın taranmış örneği beklendiği gibi `unreadable:'scanned'` (0 metin, yalnız görüntü) döndü.
- **Tesseract OCR entegrasyonu YAPILDI ve GERÇEK taranmış PDF ile test edildi** — aşağıdaki "Tesseract OCR
  entegrasyonu" bölümüne bakın; ilk tahmin ("DCTDecode = JPEG, ek çözme gerekmez" yeterli olur) gerçek veriyle
  YANLIŞ çıktı, asıl ihtiyaç CCITT Group4 oldu.

#### Tablo (satır/sütun) ayrıştırma + müşteri eşleme + taslak veritabanı + onay ekranı (2026-11-17, AYNI oturumda devam)

Kullanıcı ikinci bir ekran görüntüsü (revizyon e-postası, aynı tablo biçiminde, sarı vurgulu bir "revizyon notu"
hücresiyle) verip sırayı netleştirdi: tablo ayrıştırma → müşteri eşleme → taslak veritabanı + onay ekranı → revizyon
karşılaştırması ÖNCE, **"şimdilik mikro kısmını deneme"** — Mikro'ya yazma bilerek bu turda YAPILMADI.

- **`backend/planning/pdf-table.js` `extractOrderTable(runs)`:** `pdf-text.js`'in SATIR/X-sırası garantisinden (yukarıda,
  sözcük ayrımı YOK) ürün sipariş SÜTUNLARINI çıkarır. Başlık satırı anahtar kelimelerle (`HEADER_KEYWORDS`: malzeme
  kodu, açıklama, miktar, teslim tarihi, sipariş no…) tanınır; birden çok satıra yayılan başlıklar (ör. "Malzeme" /
  "Kodu" iki ayrı satırda) BİRLEŞTİRİLİR. **Sütun sınırı başlığın KENDİ x konumu değil, ardışık başlıkların ORTA
  NOKTASI** (gerçek Siamp verisiyle bulundu: "ÜRÜN ADI" veri hücresi kendi başlığının biraz SOLUNDAN başlıyordu, ham x
  sınırıyla önceki sütuna karışıyordu — orta nokta düzeltti). Alt bilgi/footer imzaları (`FOOTER_SIGNS`) satırları keser.
- **`backend/planning/incoming-orders.js` — PDF/e-posta tablosu → TASLAK sipariş satırı (`IncomingOrders`):** ayrı
  tablolar `incoming_batches`/`incoming_lines` (`planlama.db`'de, diğer alt modüllerle AYNI "kendi `CREATE TABLE IF
  NOT EXISTS`'i" deseni). Müşteri koduyla (`productsByCustomerCode`, sipariş/iş emri akışıyla AYNI yöntem) ürün
  kartına eşlenir (`tam`/`belirsiz`/`yok`); revizyonsa aynı (müşteri sipariş no, Alen stok kodu) için var olan
  `order_lines`'a bakılıp miktar/teslim tarihi FARKI çıkarılır (sarı vurgulu bir "revizyon notu" hücresi varsa önce o
  sınıflanır — iptal/tarih/miktar/bilinmiyor —, yoksa var olan değerle KIYASLANARAK çıkarılır).
  - **E-posta tablosu girdisi:** Outlook fabrika PC'sinde açılmayacağı için (yukarıya bakın) mail kutusu HENÜZ
    taranmıyor; ekran bunun yerine kullanıcının tabloyu Ctrl+C/Ctrl+V ile **gerçek HTML biçimiyle** (sarı vurgu dahil)
    yapıştırmasını ister (`clipboardData.getData('text/html')`) — düz metin değil, zengin yapıştırma.
    `parseEmailTable(html)`: `<table>` satır/hücrelerini çözer, başlık satırı yine anahtar kelimeyle tanınır, vurgulu
    hücre (`style="background-color:#FFFF00"` ya da `bgcolor`) `revisionNote` olur. **Gerçek ham e-posta HTML'iyle
    HENÜZ denenmedi** — yalnız ekran görüntüsündeki gerçek değerlerle ve genel HTML tablo varsayımıyla kuruldu.
  - **Üç GERÇEK hata bulunup düzeltildi (ad-hoc test verisiyle, commit'ten önce):** (1) Türkçe sayı ayrıştırma — "."
    her zaman binlik ayracıdır (`integer:true` ŞART, yoksa "1.200" 1,2'ye düşer — `fields.js#number()`'da bulunan AYNI
    hata sınıfı); (2) 4+ haneli AYIRICISIZ sayı ("1500") eski regex'le yalnız ilk 3 haneyi alıyordu ("150") — regex
    artık önce gruplu biçimi (en az bir ayıracı olan), sonra düz basamak dizisini dener; (3) revizyon notu
    sınıflandırması, eşleşen bir ürün kartı YOKSA hiç ÇALIŞMIYORDU — ilk yazımda not sınıflandırması `matched`
    bulunmasına BAĞLIYDI; ikisi artık BAĞIMSIZ (not her zaman sınıflanır, var olan satırı arama ayrı bir adım).
  - **Mikro'ya YAZMAZ** (kullanıcı kararı): `approveLine`/`rejectLine` yalnız durumu (`bekliyor`→`onaylandi`/
    `reddedildi`) değiştirir; eşleşmemiş/belirsiz bir satır elle `stockCode` verilerek de onaylanabilir (bu ekranın
    KENDİ dar ürün arama ucu: `GET .../incoming-orders/product-search`, `programs/product-search`'ün KOPYASI değil —
    numune ekranının kendi hammadde aramasıyla AYNI ilke: bu ekranın yetkisi başka bir ekranın yetkisine bağımlı olmasın).
  - **Dördüncü gerçek hata, TARAYICIDA canlı testle bulunup düzeltildi:** elle `stockCode` verilerek onaylanan bir
    satırın `match_status` alanı GÜNCELLENMİYORDU (`'yok'`/`'belirsiz'` kalıyordu) — satır gerçekte eşleşmiş ve
    onaylanmış olsa da dashboard'daki "Ürün" sütunu hâlâ "✕ eşleşmedi" gösteriyordu. Düzeltme: `approveLine` artık
    `stockCode` verilince `match_status`'u da `'tam'` yapar.
- **Ekran: Planlama > Siparişler'in yanında yeni, ayrı bir sekme "Yeni siparişler"** (`yenisiparis`, `shared/screens.js`
  + `dashboard/screens.js`, `writable:true`): `dashboard/planning-incoming-orders.js` — taslak listesi (kaynak/tür/
  dosya/müşteri tahmini + bekliyor/onaylandı/reddedildi sayaçları), "PDF yükle…" ve "E-posta tablosunu yapıştır…"
  pencereleri (ikisi de yeni/revizyon seçimi taşır), taslak ayrıntısı (satır başına eşleşme çipi, revizyon bilgisi,
  onayla/reddet/ürün seç). Yetki: `backend/auth/policy.js` `SCREEN_ROUTES`'a 5 yeni satır. **Göçle gelen İzleyici/
  Operatör rollerine otomatik eklenmedi** (diğer yeni ekranlarla aynı desen) — admin Ayarlar > Roller'den elle verir.
- **Testler:** `pdf-table.test.js` (4), `incoming-orders.test.js` (9 + match_status düzeltmesi için 1 yeni
  assertion). `npm test` 792/792 yeşil.
- **Tarayıcıda gerçek dev sunucusuna (AUTH_DISABLED, gerçek ürün kartlarına) karşı uçtan uca denendi:** gerçek bir
  müşteri koduyla (`31330122` → `MJ003.016`) eşleşen satır doğru eşlendi; eşleşmeyen bir kod "✕ eşleşmedi" çıktı;
  "Onayla" ve "Ürün seç ve onayla…" (dar arama ucu gerçek sonuç döndürdü) ikisi de denendi — yukarıdaki match_status
  hatası BU testte bulunup aynı oturumda düzeltildi; test batch'leri temizlendi. **Gerçek bir PDF'in TARAYICIDAN
  yüklenmesi ve Ctrl+V ile e-posta tablosu yapıştırma (gerçek HTML'le) bu oturumda DENENMEDİ** (önceki sohbette
  verilen 4 PDF dosyasına bu oturumda artık erişilemedi — yalnız backend ucuna doğrudan HTTP ile gerçek-örüntülü veri
  gönderilerek test edildi; `pdf-text.test.js`/`pdf-table.test.js` zaten gerçek dosyalarla doğrulanmıştı).

#### Tesseract OCR entegrasyonu — GERÇEK taranmış PDF ile test edildi (2026-11-17, kullanıcı isteği: "Tesseract OCR entegrasyonu yapıp test etsene attığım pdf ile")

Tesseract 5.5.3 bu makineye **winget ile kuruldu** (`tesseract-ocr.tesseract`, Türkçe dil paketi `tur.traineddata`
dahil geldi — şans eseri, installer'a gömülürken bu paket AYRICA eklenmeli, bkz. aşağıdaki "Henüz yapılmayan").
Gerçek test verisi: kullanıcının verdiği **taranmış** örnek (`2189_001.pdf`, Ayvaz/Canon fotokopi, §6 "PDF metin
okuma" tablosundaki 4. satır — `pdf-text.js`'in `unreadable:'scanned'` döndürdüğü tek dosya).

- **GERÇEK bulgu, ilk tahmin YANLIŞTI:** CLAUDE.md'nin önceki hâli "görüntü PDF'ten zaten çıkarılabilir — DCTDecode
  = JPEG, ek çözme gerekmez" diyordu. Gerçek dosyanın ham baytları incelenince bu tarayıcının **MRC (mixed raster
  content) — iki katmanlı** sıkıştırma kullandığı görüldü: düşük çözünürlüklü (1240×1753, ~150 dpi A4) griton bir
  **"arka plan" JPEG'i** (`[/FlateDecode /DCTDecode]` — JPEG baytı AYRICA deflate'lenmiş) VE yüksek çözünürlüklü
  (ör. 2096×3152, ~300 dpi) keskin, bilevel bir **CCITT Group4 (`/K -1`) "metin" katmanı**. JPEG katmanını OCR
  etmek SAÇMA SAPAN metin verdi (`sayfa0.jpg`'i görsel olarak incelemekle doğrulandı: metin neredeyse SEÇİLEMEYECEK
  kadar soluk/bulanık — MRC'nin arka plan katmanı böyle tasarlanır, gerçek metin ayrı katmandan gelir).
- **`backend/planning/pdf-text.js`:** `extractDctImage` (DCT/Flate+DCT, önceki tur) yanına `extractCcittImage`
  (yalnız Group4, `/K<0`; `BlackIs1` DecodeParms'tan okunur) eklendi; `extractScanImage` ikisinin ALAN olarak
  BÜYÜĞÜNÜ seçer (gerçek 4 sayfanın hepsinde CCITT adayı DCT'den büyük çıktı — bu seçim kuralı doğru çalıştı).
  Sayfa nesnesi artık `image: {bytes, width, height, format:('ccitt-g4'|'jpeg'), blackIs1}` döner.
- **`backend/planning/ocr.js` (yeni):** `tesseractBin()` (env `TESSERACT_BIN` → bilinen Windows kurulum yerleri →
  PATH; installer henüz gömmüyor), `tesseractAvailable()`, `wrapCcittAsTiff(bytes,width,height,{blackIs1})` (CCITT
  bit akışını KENDİMİZ ÇÖZMEYİZ — minimal bir TIFF başlığı/IFD'si sarılır, Tesseract'ın kendi kütüphanesi
  (Leptonica) G4'ü okur), `ocrPage(image, mediaBox, {run})` (`schedule.js#suggest({run})` ile AYNI enjeksiyon
  deseni — testlerde GERÇEK tesseract HİÇ çağrılmaz). `--psm 1` (otomatik sayfa bölümleme + **YÖN TESPİTİ**,
  `osd.traineddata`) kullanılır: gerçek PDF'in bir sayfasındaki arka plan görüntüsü 90° döndürülmüş çıktı
  (muhtemelen yatay bir teknik resim sayfasının dikey konteynerde saklanması), OSD bunu kendiliğinden düzeltti.
- **GERÇEK SONUÇ (4 sayfa, hepsi okunur çıktı verdi):** OCR gerçek, doğru Türkçe/İngilizce metin üretti — "Sipariş
  No SAS0249226", "Sipariş Tarihi 16.11.2026", ürün/müşteri kodu "6018322306104" (bir fiyat teklifi e-postasının
  içeriği; aynı kod sonradan tabloya da doğru şekilde `code` alanı olarak düştü, aşağıya bakın), bir teknik resim
  sayfasında "RING DN16", "CW614N/CW617N", "9,5gr", "601.832.230.6104" gibi tamamen doğru alanlar. Sayfalardan biri
  (boş bir teklif FORMU şablonu, hiç veri girilmemiş) beklenen şekilde boş çıktı — bu bir OCR hatası değil, kaynak
  sayfanın kendisi gerçekten boş.
- **İKİ GERÇEK HATA bulunup düzeltildi (gerçek veri + kendi testleriyle, commit'ten önce):**
  1. **`wrapCcittAsTiff`'te siyah/beyaz TERS yazılmıştı:** kod `blackIs1 ? 1 : 0` yazıyordu, ama PDF'in `BlackIs1`
     varsayılanı (false, yani örnek değeri 0 = siyah) TIFF'in `PhotometricInterpretation=1` (BlackIsZero) demek —
     kodun doğrusu `blackIs1 ? 0 : 1`. Yanlış hâli de GERÇEK veride tesadüfen okunaklı metin üretiyordu (bu yüzden
     yalnız gerçek dosyayla denemek yetmezdi) — kendi yazdığım `ocr.test.js` birim testi (`wrapCcittAsTiff` IFD
     baytlarını elle çözüp `PhotometricInterpretation` etiketini doğrudan kontrol eden) hatayı doğru yakaladı.
  2. **`pdf-table.js#matchesInLine` OCR'ın KELİME KUTULARINI tanımıyordu, İKİ AŞAMADA düzeltildi:** OCR "ÜRÜN KODU"
     gibi bir başlığı "ÜRÜN" ve "KODU" diye AYRI hücrelere böler (dijital PDF'te genelde TEK hücre/`Tj`); eski
     kod her hücreyi TEK BAŞINA kontrol ettiği için böyle bölünmüş başlıkları hiç tanımıyordu.
     - **İlk düzeltme (ardışık 1-3 hücreyi birleştirip dene) YANLIŞ TASARLANMIŞTI ve mevcut dijital-PDF testlerini
       BOZDU** (gerçek regresyon, `npm test` ile hemen yakalandı): "ÜRÜN KODU" (tam, tek hücre, doğru eşleşiyor)
       ile bitişiğindeki "ÜRÜN ADI" (tam, tek hücre, O DA doğru eşleşiyor) hücrelerini pencereyle BİRLEŞTİRİNCE
       "URUNKODU**URUNADI**" oluşuyordu ve bu, 'description' anahtar kelimesini YANLIŞ x'te (ilk hücrenin x'i)
       bir daha eşleyip gerçek sütun sınırını BOZUYORDU (minimum-x kuralı yanlış, daha soldaki x'i kazanıyordu).
     - **Doğru çözüm: satır SOLDAN SAĞA, AÇGÖZLÜ ve ÇAKIŞMASIZ taranır** — her konumda ÖNCE genişlik 1 (tüm
       anahtar kelimeler, zayıf dahil — ESKİ davranışla BİREBİR) denenir, eşleşmezse genişlik 2 sonra 3 (yalnız
       GÜÇLÜ anahtar kelimeler); bir eşleşme bulununca o KADAR HÜCRE TÜKETİLİR, arama ORADAN devam eder. Bu hem
       OCR'ın bölünmüş başlıklarını ("ÜRÜN"+"KODU" → `code`) doğru yakalar HEM dijital PDF'in zaten-tam
       hücrelerini (tek başına genişlik-1'de hemen eşleştiği için) ASLA bir sonrakiyle birleştirmeye ÇALIŞMAZ —
       kök neden (çakışan/tüketilmeyen pencereler) düzeltildi, yama/özel durum eklenmedi.
     - Zayıf anahtar kelimeler ("NO", "BR", "PBR") yalnız genişlik-1'de arandığı için (ESKİ davranış) çok hücreli
       pencerede HİÇ YOK — iki bitişik hücrenin tesadüfi sınırında kısa bir alt dizge oluşsa bile (ör. "FOOB"+
       "RISKET" → "BR" içerir) YANLIŞLIKLA eşleşmez; testle doğrulandı.
     - **Gerçek veride doğrulandı:** düzeltmeden sonra gerçek OCR çıktısındaki "Sipariş" + "No" (ayrı hücreler)
       `custOrderNo`'nun GÜÇLÜ anahtar kelimesi "SIPARISNO" ile doğru eşleşti (`headerFields.custOrderNo` gerçek
       çalıştırmada göründü) — sentetik testler değil, gerçek dosyanın kendisi bu düzeltmeyi doğruladı.
- **Testler:** `ocr.test.js` (12, yeni: TSV→runs saf dönüşüm, `tesseractAvailable`, `ocrPage` uçtan uca sahte
  süreçle — jpeg VE ccitt-g4 ikisi de —, `wrapCcittAsTiff`'in TIFF baytlarını elle doğrulayan 2 test) ·
  `pdf-text.test.js` (+4: DCT görüntü çıkarımı, CCITT'siz/parametresiz durum, CCITT Group4 doğru çıkarım,
  CCITT+DCT birlikte varsa büyük alanlı CCITT'in seçilmesi) · `pdf-table.test.js` (+2: OCR kelime-kutusu bölünmüş
  başlık, zayıf anahtar kelimenin pencerede YANLIŞLIKLA genişlememesi). `npm test` **813/813 yeşil**.
- **Tesseract installer'a GÖMÜLDÜ (2026-11-19, v1.0.9):** `build-installer.ps1` `tesseract.exe` + PE-bağımlı 33 DLL + `tur`/`eng`/`osd.traineddata` + `configs` ile `runtime\tesseract\` altına gömer (`ocr.js` gömülü yolu `KNOWN_BINS`'ten önce seçer ve `TESSDATA_PREFIX`'i sabitler); duman testli + `payload`'tan gerçek taranmış `2189_001.pdf` ile doğrulandı.
- **Henüz yapılmayan:** OCR'dan gelen DÜŞÜK güvenilirlikli (örn. tamamen boş/anlamsız) bir satırın kullanıcıya AYRICA işaretlenmesi
  (şimdilik yalnız "N sayfa OCR ile okundu, elle kontrol edin" genel uyarısı var); gerçek bir veri satırının
  (yalnız başlığın değil) uçtan uca onay ekranına kadar gerçek OCR çıktısıyla denenmesi (bu turda gerçek dosyanın
  SIPARIŞ TABLOSU sayfası boş bir şablon çıktı, gerçek dolu bir sipariş tablosu sayfasıyla henüz denenmedi).

**Mikro'ya YENİ sipariş yazmak — GERÇEK YAZMA BAŞARILI (2026-11-18, aynı gün içinde: önce "deneme" kararı, sonra
kullanıcı eski bir gerçek siparişi (SAS0003812, HAVANA SAN. VE TİC. A.Ş., 19.10.2026) "yeni sipariş gibi düşünüp"
test etmeyi istedi, "evet gönder" ile açıkça onayladı):** `backend/planning/mikro-order.js` (`MikroOrders` sınıfı) —
`mikro-stock.js`'teki `previewX`/`send` deseninin AYNISI: `previewCreateOrder` gövdeyi KURAR/DOĞRULAR, `send()`
yalnız `MIKRO_WRITE_ENABLED=1` iken gerçekten gönderir (kapalıyken 409 `mikro-write-disabled`). **GERÇEK DENEME
SONUCU: İLK denemede `StatusCode:200, IsError:false` — 4 satırlı TEK evrak (SPR-755) başarıyla oluştu, salt okuma
ile birebir doğrulandı** (bkz. aşağıdaki "GERÇEK İLK YAZMA DENEMESİ" bölümü). `MIKRO_WRITE_ENABLED` gerçek
kurulumda/sunucu config'inde HÂLÂ hiç değişmedi — deneme tek seferlik bir betikle (`writeEnabled: () => true`
doğrudan enjekte edilerek) yapıldı, tıpkı önceki Mikro yazma keşiflerinde olduğu gibi (bkz. §6 "G aşaması").
- **Uç bulundu, resmi dokümantasyondan:** `apidocs.mikro.com.tr/apis/siparis` kategorisinde **`SiparisKaydetV2`**
  (kardeşleri `SiparisDuzeltV2`/`SiparisSilV2`/`SiparisGuidSilV2`, bu turda kullanılmadı). Ham `.md`'den (curl ile,
  WebFetch'in AI özetlemesi OLMADAN — önceki `DahiliStokHareketKaydetV2` dersiyle AYNI yöntem): gövde
  `DahiliStokHareketKaydetV2`/`StokKaydetV2` ile AYNI yapıda — `evraklar` `Mikro` bloğunun İÇİNDE (`nestInMikro:true`),
  `evrak_aciklamalari` evrak düzeyinde, satır alanları (`sip_*`) `satirlar[]` içinde.
- **`SIPARISLER`'in resmi alan referansı** (`apidocs.mikro.com.tr/tablo-alan-adlari/siparisler`, Tablo No 21) + **GERÇEK
  2540 müşteri siparişinin SALT OKUMA ile incelenmesi** (`SqlVeriOkuV2`, hiçbir şey yazılmadı) şunları **2540/2540
  satırda İSTİSNASIZ AYNI, GÜVENİLİR SABİT** kıldı: `sip_tip='0'` (Talep), `sip_cins='0'` (Normal Sipariş),
  `sip_depono=1` (MERKEZ DEPO), `sip_birim_pntr='1'`, `sip_vergi_pntr='4'`, `sip_vergisiz_fl=false`, `sip_doviz_cinsi='0'`.
  `sip_b_fiyat`/`sip_tutar`: çoğu gerçek satırda dolu (ör. 31,99 × 200 = 6398) ama EN AZ bir gerçek siparişte
  (SR004/005.019, aynı evrak sırası) ikisi de 0 — yani **0 Mikro'da KABUL EDİLEN bir değer** (fiyat bilinmiyorsa 0
  gönderilir, tahmin YAZILMAZ — PDF'ten fiyat şu an zaten HİÇ ÇIKARILMIYOR, bkz. aşağı).
- **`sip_evrakno_seri`/`sip_evrakno_sira` — DÜZELTME (aynı gün, kullanıcı gerçek Mikro ekranını canlı doldururken
  anlattı):** önce "hiç gönderilmiyor, otomatik numaralanır umuluyor" tasarımıydı; ama kullanıcı "SPR evrak no yanındaki
  +1 increment olarak gidiyor, son sipariş 755 ise yenisi 756 oluyor" dedi — yani ofisin kendi ekranı "Yeni" denince
  `MAX(sira)+1`'i KENDİSİ hesaplayıp öneriyor (API'nin boş bırakılınca otomatik numaralayacağının kanıtı değildi, yalnız
  masaüstü istemcinin kolaylığıydı). `nextOrderDocNo()` eklendi: AYNI hesabı biz de yapıp `sip_evrakno_seri='SPR'`/
  `sip_evrakno_sira=<MAX+1>` AÇIKÇA gönderiyoruz artık — ofisin elle yaptığının birebir aynısı, tahmin değil. **Hâlâ EN
  BELİRSİZ alan budur** (API'nin bu sırayı kabul edip etmeyeceği, çakışma durumunda ne olacağı — yarının asıl sınavı).
- **`sip_opno` (Ödeme Planı No) — YENİ bulgu (aynı ekran gösteriminden):** kullanıcı "ödeme planını da seçilmeli,
  sipariş açılırken yönetici seçiyor" dedi; salt okuma ile çapraz kontrol edince `CARI_HESAPLAR.cari_odemeplan_no`
  (resmi alan: Tablo No 20, "Ödeme Plan No") ile gerçek siparişlerdeki `sip_opno` **3 farklı müşteride BİREBİR AYNI**
  çıktı (Ayvaz `-90`/`-90`, Berg Metal `-30`/`-30`, Klinger `0`/`0`) — yani ekranda "seçiliyor" görünen bu alan aslında
  müşteri kartından OTOMATİK geliyor (yönetici yalnızca onaylıyor/değiştiriyor, baştan seçmiyor). `odemePlanOf(customerCode)`
  eklendi, `sip_opno`'ya doğrudan kopyalanıyor — tahmin değil.
- **`sip_harekettipi='0'` (Stok) eklendi:** resmi listede 0:Stok 1:Hizmet 2:Gider 3:Demirbaş; 2540/2540 gerçek siparişte
  İSTİSNASIZ "0" (ekranda da satır "Cinsi" sütunu hep "Stok" — kullanıcının ekran görüntüsünde görüldü) — yeni sabit.
- **MÜŞTERİ KODU — PDF'teki şirket adından DEĞİL, ÜRÜNÜN KENDİ SİPARİŞ GEÇMİŞİNDEN çözülür** (`resolveCustomerForStock`,
  bu turda bulunan asıl tasarım kararı): PDF'teki serbest metin müşteri adını (ör. "Ayvaz") `CARI_HESAPLAR`'da aramak
  BELİRSİZ — gerçek veride "AYVAZ ENDÜSTRİYEL ÜRÜNLER SAN. VE TİC.A.Ş.", "HACI AYVAZ ENDÜSTRİYEL MAMÜLLER SANAYİ VE
  TİCARET A.Ş.", "AYVAZ N LTD." üçü de AYRI, gerçek müşteri. Ama Alen'in kendi ürün kodu zaten müşteriye özeldir (bkz.
  `sample-customer-groups.js`) — bu yüzden eşleşen Alen stok koduyla `SIPARISLER`'de GEÇMİŞTE sipariş veren müşteri
  aranır (`SELECT TOP 1 ... ORDER BY sip_tarih DESC`), ad eşleştirmesinden ÇOK daha güvenilir. **Gerçek örnek, tarayıcıda
  canlı Mikro'ya karşı doğrulandı:** SR018.002 → her zaman `120.10.0002`, HACI AYVAZ. Geçmişi hiç olmayan (ilk kez
  sipariş edilen) bir ürün için `searchCustomers` ile `CARI_HESAPLAR`'da canlı arama (ELLE seçim) — bu da tarayıcıda
  gerçek Mikro'ya karşı denendi ("Berg" araması → gerçek `320.10.0150`/`120.10.0013` BERG METAL kayıtları).
- **Fiyat şu an `incoming-orders.js`/`pdf-table.js` tarafında HİÇ ÇIKARILMIYOR** (yalnız kod/açıklama/adet/tarih sütunları
  var, `HEADER_KEYWORDS`'te fiyat yok) — `previewCreateOrder`'ın `unitPriceValue` parametresi bu yüzden şimdilik hep
  boş/0 gelecek; PDF'ten fiyat çıkarmak AYRI, henüz yapılmamış bir iş.
- **Entegrasyon:** `planning.js`'e `this.mikroOrders` eklendi (`this.mikro.client`'ı `mikroStock` ile PAYLAŞIR, ikinci bir
  istemci YARATILMADI). `routes.js`'e `GET /api/planning/incoming-orders/mikro/customers` (arama) ·
  `GET .../lines/:id/mikro-customer` (otomatik çözümleme) · `POST .../lines/:id/mikro-preview|mikro-send` — hepsi
  **KAYITSIZ bırakıldı** (`material/mikro/transfer-*` ile AYNI karar: yalnız admin, `policy.js`'e hiç eklenmedi).
  `incoming-orders.js`'e tek satırlık `getLine(id)` eklendi (batch'in tamamını çekmeden). `dashboard/planning-incoming-orders.js`:
  onaylanmış satırda artık **"Mikro'ya gönder…"** düğmesi — müşteri otomatik/elle çözülür, birim fiyat/not isteğe
  bağlı, "Önizle" ile gövde (`code-view`, `planning-material.js`'teki AYNI CSS sınıfı — yeni CSS İCAT EDİLMEDİ) ve
  yazma açık/kapalı bilgisi gösterilir, "Mikro'ya gönder" denenir (kapalıyken her zaman 409, UI'da düzgün gösterilir).
- **Dışa aktarılan paylaşım:** `mikro-stock.js`'teki `likeTermForMikro` (SQL enjeksiyon/joker karakter temizleme)
  artık `export` edilip `mikro-order.js`'te AYNEN kullanılıyor — ikinci bir kopya YAZILMADI.
- **Testler:** `backend/planning/mikro-order.test.js` (16: önizleme alan doğrulaması — sabitler `sip_harekettipi` dahil,
  fiyat hesabı, evrak seri/sıra + ödeme planı verilmezse hiç gönderilmemesi/verilince doğru gönderilmesi, doğrulama
  hataları —, `resolveCustomerForStock`/`searchCustomers`/`odemePlanOf`/`nextOrderDocNo` SQL kurulumu + SQL enjeksiyon
  temizliği + uç durumlar (kart/sipariş yok, boş seri), `send`'in yazma kapalıyken ASLA `client.call` çağırmaması,
  HTTP uçtan uca — onaylanmamış satırda 409 `not-approved`, onaylı satırda otomatik müşteri + ödeme planı + evrak
  sırası çözümleme + önizleme + kapalıyken 409). `npm test` **852/852 yeşil**.
- **Tarayıcıda VE doğrudan uçla İKİ KEZ GERÇEK Mikro'ya karşı (salt okuma) uçtan uca denendi** (izole bir scratch
  `planlama.db`'ye karşı, gerçek `data/planlama.db`'ye HİÇ DOKUNULMADI; gerçek MikroAPI kimlik bilgileriyle ama
  `MIKRO_WRITE_ENABLED` hiç verilmeden): sentetik bir e-posta tablosu (SR018.002, müşteri kodu 140100109, 50 adet)
  içeri alındı → onaylandı → "Mikro'ya gönder…" → müşteri GERÇEKTEN `120.10.0002 HACI AYVAZ ENDÜSTRİYEL MAMÜLLER
  SANAYİ VE TİCARET A.Ş.` olarak otomatik çözüldü (SR018.002'nin gerçek sipariş geçmişinden) → "Önizle" doğru gövdeyi
  gösterdi → "Mikro'ya gönder" beklendiği gibi `mikro-write-disabled` 409'u ile reddedildi (hiçbir şey yazılmadı, salt
  okuma ile de doğrulandı) → "Değiştir…" ile elle müşteri araması da ("Berg" → gerçek 2 Berg Metal kaydı) doğru
  çalıştı. **İKİNCİ turda** (`sip_opno`/evrak sırası eklendikten sonra) doğrudan uca tekrar denendi: gövde
  `sip_opno:-90, sip_evrakno_seri:"SPR", sip_evrakno_sira:755` döndü — **755, kullanıcının o anda kendi Mikro
  ekranında canlı doldurduğu GERÇEK evrak numarasıyla birebir aynı çıktı** (ekran görüntüsünde görülen sipariş).
- **GERÇEK İLK YAZMA DENEMESİ — BAŞARILI (2026-11-18, aynı gün, kullanıcı "evet gönder" ile onayladı):** test için
  kullanıcının kendi Downloads'undaki GERÇEK bir eski sipariş PDF'i seçildi (`SAS0003812 ALEN OTOMAT.pdf`, HAVANA
  SAN. VE TİC. A.Ş.'den, 19.10.2026, 4 kalem: GVA-16 YATAK ×3 ölçü + HİDRANT SIZDIRMAZLIK SOMUNU). **Bu PDF'in metni
  karakter karakter ayrı hücreler halinde çıktı** ("S|a|t|ı|n|a|l|m|a" — bu üreticinin PDF'i her harfi ayrı `Tj` ile
  yazıyor) — `pdf-table.js`'in `MAX_HEADER_WINDOW=3` penceresi bunu YAKALAYAMADI, `extractOrderTable` **hiçbir tablo
  bulamadı** (0 taslak satır). Yani bu PDF, bugünkü "Yeni siparişler" ekranından OTOMATİK geçemiyor — **ayrı, henüz
  yapılmamış bir düzeltme gerekiyor** (bkz. §10 "Sıradaki işler").
  - **Bu yüzden PDF yükleme adımı ATLANDI**, içerik ELLE okunup (ham karakter satırları tek tek birleştirilerek)
    doğru çıkarıldığı gerçek `data/planlama.db`'ye (salt okuma) karşı müşteri kodlarının ürün kartlarıyla eşleştiği
    doğrulandı: `603702100026→SR009.007`, `603705000146→SR001.007`, `603705000148→SR002.007`, `603705000150→SR003.007`
    (hepsi müşteri grubu "007" = HAVANA, `sample-customer-groups.js`'teki gruplamayla tutarlı).
  - **`previewCreateOrder` TEK satırdan ÇOK satıra genişletildi** (kullanıcı isteği: "bir siparişte birden fazla
    ürün yazabiliyor olmalı"): imza artık `{customerCode, items: [{stockCode, qty, dueDateMs?, unitPriceValue?}],
    custOrderNo?, orderDateMs?, note?, odemePlanNo?, docSeri?, docSira?}` — evrak düzeyi alanlar (müşteri/tarih/
    ödeme planı/evrak sırası/müşteri sipariş no) TÜM kalemlerde AYNI, yalnız ürün/adet/fiyat/teslim tarihi kalem
    başına değişir (`wrapEvrak` artık bir satır dizisini sarmalıyor). `routes.js`'teki tek-satır çağrısı
    `items:[{...}]` (tek elemanlı dizi) olarak güncellendi — davranış DEĞİŞMEDİ, yalnız şekil. 5 yeni test (toplam
    17), çok-kalemli evrakın evrak-düzeyi alanları doğru tekrarladığını PDF'teki GERÇEK tutarlarla (68.000/231.800/
    78.775/213.750) doğrulayan bir test dahil. `npm test` 853/853 yeşil.
  - **Önizleme canlı Mikro'ya karşı kuruldu** (müşteri `resolveCustomerForStock('SR009.007')` → `120.10.0007 HA VANA
    SAN. VE TİC.A.Ş.` — PDF'teki firmayla birebir; `odemePlanOf` → `-90`, PDF'teki "90 Gün Vadeli Havale" ile tutarlı;
    `nextOrderDocNo` → `SPR-755`), kullanıcıya TAM gövde + toplam (592.325 TL, PDF'teki "KDV Hariç Toplam" ile
    kuruşuna kadar aynı) gösterildi, **"evet gönder" onayı alındıktan SONRA** `MIKRO_WRITE_ENABLED` yalnız o tek
    seferlik betik için açılıp `send()` çağrıldı.
  - **SONUÇ: `StatusCode:200, IsError:false`, İLK denemede** — 4 ayrı GUID (`264E1616…`/`2C4E1616…`/`324E1616…`/
    `384E1616…`), hepsi `sip_evrakno_seri='SPR', sip_evrakno_sira=755` altında. Salt okuma ile TAM doğrulandı: 4 satır,
    `sip_satirno` Mikro tarafından 0/1/2/3 olarak OTOMATİK atanmış (biz hiç göndermedik — API bunu dizideki sıraya
    göre kendisi veriyor), tüm alanlar (stok kodu, müşteri, miktar, fiyat, tutar, opno, evrak no, teslim tarihi)
    gönderdiğimizle BİREBİR, toplam 592.325 TL. **Bu, hem "evrak sırasını biz hesaplayıp gönderebiliyor muyuz"
    sorusunu (EN BELİRSİZ alandı) hem "tek evrakta birden çok kalem" sorusunu olumlu yanıtladı.**
  - **`evrak_aciklamalari` ile gönderilen not, düz `sip_aciklama` kolonunda GÖRÜNMEDİ** (boş döndü) — muhtemelen ayrı
    bir açıklama tablosuna gidiyor, bu turda daha ileri araştırılmadı (test kaydı zaten silinecek, önemli değildi).
  - **TEMİZLİK GEREKİYOR — bu GERÇEK bir sipariş, kalıcı:** kullanıcı "sonra sileriz" dedi; `SiparisSilV2`/
    `SiparisGuidSilV2` (kardeş uçlar, bulundu ama bu turda HİÇ araştırılmadı/kullanılmadı) ile silinebilir ya da
    kullanıcı kendi Mikro ekranından elle silebilir — **SPR-755, HA VANA (120.10.0007), 4 satır, yukarıdaki GUID'ler**
    ile bulunabilir. **2026-11-19'da kullanıcı tarafından Mikro'dan SİLİNDİ** (salt okuma ile de doğrulandı: aynı gün
    SPR-755 numarası — HAVANA kaydı silinince serbest kaldığı için — AŞAĞIDAKİ gerçek Konveyör siparişine yeniden
    verildi; iki ayrı gerçek sipariş AYNI numarayı farklı zamanlarda taşıdı, çakışma değil).

**"Hepsi TEK siparişte Mikro'ya gönder" — çok kalemli taslak toplu gönderme + İKİNCİ GERÇEK YAZMA (2026-11-19, kullanıcı isteği):**
yukarıdaki HAVANA testi `previewCreateOrder`'ın çok-kalemli (`items[]`) kapasitesini kanıtlamıştı ama bu kapasite yalnız
TEK SATIRLIK bir taslak satırına (`lines/:id/mikro-*`) açıktı — bir PDF'te birden çok onaylı satır olduğunda her biri
AYRI bir evrak olarak gönderiliyordu. Kullanıcı gerçek bir Konveyör sipariş PDF'ini (`4100018539.PDF`, bu makinenin
`Downloads` klasöründen) "Yeni siparişler" ekranından işletirken fark etti: *"şimdi bunların hepsi tek sipariş içinde
ya tek bir siparişte mikroya yaz bunları"*.
- **Backend:** `IncomingOrders.approvedLinesForOrder(batchId)` (yeni, `incoming-orders.js`) — bir taslağın TÜM
  `onaylandi` satırlarını döner; hiç onaylı satır yoksa 400 `no-lines`, onaylı bir satır ürüne eşli DEĞİLSE (normal
  akışta imkansız — `approveLine` zaten ürünsüz onaya izin vermiyor, yalnız savunma amaçlı) 400 `no-product`.
  `routes.js`'e üç yeni, **kayıtsız bırakılan** (satır-bazlı `mikro-*` uçlarıyla AYNI karar: yalnız admin) uç:
  `GET /api/planning/incoming-orders/:id/mikro-customer` (ilk onaylı satırın ürününden müşteri çözer) ve
  `POST .../:id/mikro-preview|mikro-send` — `previewCreateOrder`'ı TEK çağrıda, taslağın TÜM onaylı satırlarını
  `items[]` olarak vererek çağırır (evrak düzeyi alanlar — müşteri/ödeme planı/evrak sırası — TEK SEFER hesaplanır,
  tüm kalemlerde aynı). **Müşteri birden çok satırdan FARKLI müşteriye çıkarsa** (aynı PDF'te iki farklı müşteri
  beklenmez ama veri bütünlüğü için denetlenir) `customerCode` elle verilmedikçe 409 `multiple-customers` ile
  reddedilir — sessizce birini seçip yanlış müşteriye yazmaz.
- **Dashboard:** `dashboard/planning-incoming-orders.js` — taslak penceresinde en az bir onaylı satır varken
  **"Onaylı N satırı TEK siparişte Mikro'ya gönder…"** düğmesi; `openBatchMikroSendDialog` (satır-bazlı
  `openMikroSendDialog`'un batch sürümü — fiyat alanı YOK, her satır kendi onaylanmış fiyatını taşır, yalnız
  LİSTELENİR) + paylaşılan `openCustomerPicker(onPick)` (önceden `openMikroSendDialog`'un içine gömülüydü, buraya da
  lazım olunca top-level'a çıkarıldı, ikinci bir kopya YAZILMADI).
- **Testler:** `backend/planning/incoming-orders.test.js`'e 2 (`approvedLinesForOrder`: başarı + yalnız-onaylı-satırlar
  filtresi, savunma amaçlı `no-product` dalı) · `backend/planning/mikro-order.test.js`'e 2 HTTP testi (gerçekçi 2-kalemli
  taslak → tek evrak + `no-lines`/409; farklı müşteriye çıkan 2 satır → 409 `multiple-customers`, elle `customerCode`
  verilince kabul) · `backend/auth/policy.test.js`'e **incoming-orders için DAHA ÖNCE HİÇ OLMAYAN** bir ekran testi
  (bu eksiklik bu turda fark edilip kapatıldı: hem eski satır-bazlı hem yeni batch-bazlı `mikro-*` uçlarının admin'e
  düştüğü doğrulandı). `npm test` 876/876 yeşil.
- **GERÇEK YAZMA — İKİNCİ KEZ BAŞARILI, gerçek "Yeni siparişler" ekranından, GERÇEK UI AKIŞIYLA (bu kez elle betikle
  DEĞİL):** bu makinenin kendi `data/planlama.db`'si + gerçek Mikro okuma kimlik bilgileriyle (`.claude/mikro.env`)
  gerçek backend açıldı (yazma KAPALI varsayılan); `4100018539.PDF` (Konveyör, 11 satır) yüklendi, **10/11 satır
  otomatik eşleşip tarayıcıdan tek tek onaylandı** (1 satır — "1050600045 1235-672" — hiçbir ürün kartına eşlenemedi,
  bilerek onaylanmadı, kullanıcının karar vermesi bekleniyor). Yeni "Onaylı 10 satırı TEK siparişte Mikro'ya gönder…"
  ile önizleme: **TEK evrak, 10 kalem, müşteri `120.10.0011 KONVEYÖR BEYAZ EŞYA VE OTOMOTİV SANAYİ TİCARET A.Ş.`
  (10 satırın hepsinden AYNI şekilde çözüldü), `sip_opno=-30`, `sip_evrakno_seri='SPR'/sira=755`, toplam 448.308 TL**
  (10 satırın `sip_tutar` toplamı). Kullanıcı önizlemeyi (ve "yazma KAPALI" banner'ını) gördükten sonra **"dene" dedi**
  → sunucu `MIKRO_WRITE_ENABLED=1` ile yeniden başlatıldı (yalnız bu tek seferlik oturum için, gerçek kurulumun/Setup'ın
  config'i hiç değişmedi) → "Önizle" **"Mikro'ya gerçek yazma AÇIK"** banner'ını gösterdi → "Mikro'ya gönder" **İLK
  denemede `Gönderildi.`** döndü. **Salt okuma ile TAM doğrulandı** (`SqlVeriOkuV2`, `SIPARISLER WHERE
  sip_evrakno_seri='SPR' AND sip_evrakno_sira=755`): gerçekten **10 satır**, hepsi aynı evrak altında, her satırın
  stok kodu/miktar/fiyat/tutar/teslim tarihi önizlemeyle BİREBİR aynı. Sunucu hemen ardından yazma KAPALI olarak
  yeniden başlatıldı (güvenli varsayılana dönüldü); kullanılan geçici doğrulama betiği ve `MIKRO_WRITE_ENABLED=1`
  env dosyası oturum sonunda silindi.
  **Bu, önceki HAVANA testinden (elle, tek seferlik bir Node betiğiyle) FARKLI: bu kez GERÇEK ekran, GERÇEK buton,
  GERÇEK çok-satırlı bir PDF'ten uçtan uca.** Hâlâ açık soru: **bu gerçek Konveyör siparişi (SPR-755) kalıcı mı
  kalacak (gerçek bir müşteri PO'suna karşılık geldiği için muhtemelen EVET) yoksa test amaçlı mıydı** — HAVANA'nın
  aksine kullanıcıya henüz "sileceğiz" denmedi, **bu karar kullanıcıya bırakıldı, bir sonraki oturum bunu sormalı/
  hatırlamalı.** Row 1 (eşleşmeyen satır) hâlâ taslakta `bekliyor` durumunda, hiçbir ürüne bağlanmadı.
  **DENENMEDİ:** eşzamanlı iki "tek siparişte gönder" çağrısının `nextOrderDocNo()`'nun MAX+1 okumasında yarışması;
  çok daha büyük (50+) kalemli tek bir evrakın API tarafında bir üst sınırı olup olmadığı.

**ÜÇ GERÇEK BULGU + DÜZELTME, aynı Konveyör siparişi üzerinden (2026-11-19, kullanıcı fabrika PC'sinden — 192.168.1.50 —
"Siparişler" ekranına bakarken fark etti):**

1. **GERÇEK KEŞİF — bu Konveyör siparişi (4100018539.PDF) ZATEN Mikro'daydı, bizim SPR-755 BİR DUPLİKASYONDU:**
   salt okuma ile `SPR-747` (11.11.2026, 11 satır, `sip_belgeno='4100018539'`) bulundu — PDF'teki TÜM 11 kalemi
   (satır 1'deki daha önce "eşleşmedi" denen `SR132.011` dahil!) zaten içeriyordu. PDF'in kendi başlığında
   **"Revizyon No: 01"** de var — bazı adetler (SR098.011: 1000↔2291, SR091.011: 500↔600, satır 1: 280↔290)
   SPR-747'den farklı çıktı, yani bu belge muhtemelen SPR-747'nin bir SONRAKİ REVİZYONU, "yeni" bir sipariş değil.
   **Kullanıcı SPR-755'i (bizim yazdığımız) Mikro'dan SİLDİ** — doğru karar, ama bu bizim "Siparişler" ekranımızın
   HİÇBİR ZAMAN bunu fark edemediğini ortaya çıkardı (madde 2'ye bakın). **Ders:** bu modül şu an yalnız "yeni"/
   "revizyon" seçimini KULLANICIYA bırakıyor, var olan bir siparişle aynı PO numarasını taşıyıp taşımadığını
   KONTROL ETMİYOR — madde 3'teki belge-numarası çıkarımı (artık otomatik) ileride bu kontrolü MÜMKÜN kılar
   (aynı `custOrderNo`'ya sahip var olan bir `order_lines` kaydı aranabilir) ama bu turda BUNU YAPMADIK, yalnız
   çıkarımın kendisini ekledik.
2. **GERÇEK BUG, DÜZELTİLDİ — "Mikro'dan yenile" (sipariş senkronu) Mikro'da SİLİNEN bir siparişi SONSUZA DEK
   gösteriyordu:** `mikro.js`'nin `Mikro.refresh()`'i `keepOld: true` ile çağırıyordu — bu bayrak "Kaynak klasörü"
   (Excel) yolundan KOPYALANMIŞTI (orada haklı: kısmi bir Excel export'u gizlemeyi önler), ama `SIPARIS_SQL`'in
   kendisi tarih/LIMIT filtresi TAŞIMIYOR (tam döküm) — yani bu ihtiyat MikroAPI yolunda YANLIŞ TRANSFER EDİLMİŞTİ.
   Sonuç: `markStale()` hiç çalışmıyordu, silinen bir evrak (SPR-755) "Siparişler" listesinde kalıcı kalıyordu.
   **Düzeltme:** `mikro.js` artık `keepOld: false` geçiyor; `planning-db.js#markStale` (zaten vardı, SATIRLARI
   SİLMEZ, yalnız `stale=1` işaretler — ileride iş emirleri bunlara bağlı kalabilsin) artık GERÇEKTEN çalışıyor.
   Görünürlük için `sources.js`'in paylaşılan `emptyTotals`/`accumulate`'ine `lines.removed` sayacı eklendi (Excel
   yolunda hep 0 kalır — "tam döküm" işaretlenmedikçe `keepOld:true` hâlâ geçerli, davranış DEĞİŞMEDİ); dashboard'da
   (`planning-mikro.js`, `planning-sources.js`) "N sipariş satırı artık Mikro'da yok (silinmiş görünüyor)" satırı.
   **GERÇEK sonuç (bu makinenin `data/planlama.db`'si, ilk kez `keepOld:false` ile çalıştı):** `removed: 107` —
   bu dev makinesi daha önce hiç bu şekilde senkronize edilmediği için 107 satır birikmiş kalmıştı, hepsi doğru
   şekilde temizlendi; tarayıcıda "Siparişler" listesinde SPR-754'ten direkt SPR-753'e atladığı (SPR-755 YOK)
   görsel olarak doğrulandı. **Bu düzeltme FABRİKA PC'sine (192.168.1.50) henüz ULAŞMADI** — o makine kendi
   `backend/server.js` sürecini bu kod değişikliğiyle yeniden başlatmadıkça, kullanıcının ekranındaki iki SPR-755
   satırı (HAVANA + Konveyör, ekran görüntüsünde görülen) DÜZELMEYECEK; bir sonraki gerçek kuruluma/deploy'a dahil
   edilmeli. Testler: `backend/planning/mikro.test.js`'e 3 yeni test (önceki senkronda gelen bir siparişin SONRAKİ
   senkronda hiç gelmeyince stale işaretlenip listeden kalkması — satırlar SİLİNMEZ, yalnız gizlenir, `orderLines()`
   da `searchOrders()` gibi `stale=0` filtreler — ; hâlâ gelen bir siparişin stale işaretlenmemesi; bazı siparişler
   kalkıp bazıları kalırsa yalnız kalkanların işaretlenmesi) + `sources.test.js`/`mikro.test.js`'teki var olan
   `deepEqual` sabitleri yeni `removed:0` alanını içerecek şekilde güncellendi.
3. **GERÇEK EKSİK, TAMAMLANDI — PDF'in KENDİ sipariş numarası (müşterinin PO'su) hiç çıkarılmıyordu:** kullanıcı
   "bu pdflerde sipariş numarası var ya onu da mikroya gönderirken belge numarası kısmına yazacağız" dedi. Mikro'ya
   gönderme TARAFI (`sip_belgeno`) zaten `line.custOrderNo`'yu kullanıyordu (HAVANA testinde doğrulanmıştı) — eksik
   olan yalnızca ÇIKARIMDI: `custOrderNo` keyword'leri (`SIPARISNUMARASI`/`SIPARISNO`/`EBANUMARASI`) tablo İÇİNDEKİ
   tekrar eden bir SÜTUNU hedefliyordu, ama Konveyör'ün bu PDF'inde PO numarası tablo DIŞINDA, sayfa üst metadata
   bloğunda ("Satınalma Siparişi / Eba Numarası" etiketi) BİR KEZ yazılıyor. Yeni `extractDocOrderNo(runs)`
   (`pdf-table.js`) sayfanın TÜM satırlarını tarar (tabloyla sınırlı değil), etiketi bulunca sonraki birkaç satırda
   "6+ ardışık rakamla" eşleşen ilk değeri alır. **Gerçek belgede bulunan incelik:** `mergeCharacterCells` tarih
   (`11.11.2026`) ve PO numarasını (`4100018539 / 01`) BOŞLUKSUZ TEK hücrede birleştiriyordu (`"11.11.20264100018539
   / 01"`) — ilk denemede `^` ile BAŞTAN ankorlu bir regex bunu YAKALAYAMADI (tarih noktalarla bölündüğü için hiç
   6 rakama ulaşmıyor, ama PO'nun kendisi de dizginin BAŞINDA değil ORTASINDA kalıyordu); düzeltme iki aşamalı:
   önce "tarihin HEMEN ARDINDAN gelen 6+ rakam" (`\d{2}\.\d{2}\.\d{4}(\d{6,})`, yılın SABİT 4 haneli olması sayesinde
   aşırı açgözlü eşleşip PO'nun başından rakam çalmıyor), sonra (fuzyon hiç olmamışsa) bastan ankorsuz genel
   "herhangi bir yerde 6+ rakam" yedek yolu. `incoming-orders.js#importPdf` artık her sayfada `extractDocOrderNo`'yu
   dener (digital VE OCR runs'da), ilk bulduğu sayfa kazanır; **satırın KENDİ `custOrderNo`'su varsa (tablo içi bir
   sütundan geldiyse) dokunulmaz**, yalnız BOŞ olanlar doldurulur. **GERÇEK PDF'le doğrulandı** (`4100018539.PDF`):
   artık 11 satırın 11'i de `custOrderNo: "4100018539"` taşıyor — SPR-747'nin gerçek `sip_belgeno`'suyla BİREBİR
   aynı. Testler: `pdf-table.test.js`'e 5 yeni test (etiket+tarihle-füze değer, etiket+ayrı-hücre değer, kısa
   etiket varyantı, etiket hiç yoksa null, etiket var ama değer yoksa null — hepsi ham `runs` ile, PDF üretmeden) +
   `incoming-orders.test.js`'e 2 yeni test (boş `custOrderNo`'ları doldurma, satırın KENDİ değerini EZMEME; Türkçe
   aksanlı etiket metni BİLEREK sentetik PDF'lerde kullanılmadı — `orderPdf`/`buildPdf` içeriği Latin-1'e çevirir,
   "ı"/"ş" gerçek bir PDF'te bu yolla doğru kodlanamaz, ASCII eşdeğeri `fold()` sonrası aynı anahtar kelimeye düşer).
   `npm test` 886/886 yeşil.
4. **Yan bulgu (madde 2'nin aynı gerçek senkronunda ortaya çıktı, AYRICA düzeltilmedi, yalnız KÖK NEDENİ bulundu):**
   satır 1'in (`SR132.011`) daha önce "eşleşmedi" görünmesinin sebebi eşleme mantığında bir hata DEĞİLDİ — bu dev
   makinesinin yerel `products` tablosunda `SR132.011` kartı zaten VARDI ama `customer_code`/`name` alanları NULL'dı
   (muhtemelen bir iş emri akışından boş açılmış, hiç senkronize edilmemiş). Madde 2'deki GERÇEK senkron bunu da
   kendiliğinden düzeltti (`customer_code: "1050600045"`, `name` dolduruldu — `importSiparis`'in zaten var olan
   "Mikro ana veri kaynağı" kuralı sayesinde, yeni bir kod YAZILMADI); PDF bu düzeltmeden SONRA tekrar işlenince
   **11 satırın 11'i de (satır 1 dahil) artık `matchStatus: 'tam'`** çıktığı gerçek veriyle doğrulandı. **Fabrika
   PC'sinin kendi `data/planlama.db`'si muhtemelen zaten güncel senkronize ediliyordu — bu boşluk yalnız BU dev
   makinesine özgü olabilir**, kesin bilinmiyor.

**Durum: DEVAM EDİYOR, ama Mikro YAZMA tarafı artık KANITLANDI** VE **HAVANA PDF'indeki karakter-karakter ayrılma
sorunu DÜZELTİLDİ** (aynı gün, kullanıcının kendi sözü uyarınca: "ondan sonra bu pdf kısmını düzeltmemiz lazım").
PDF metin okuma temeli, tablo ayrıştırma (OCR'ın kelime-kutusu bölünmüş başlıkları VE artık karakter-karakter
yazan PDF'ler dahil), müşteri eşleme, taslak veritabanı, onay ekranı, Tesseract OCR entegrasyonu, `SiparisKaydetV2`
araştırması/çok-kalemli önizleme akışı YAZILDI VE GERÇEK Mikro'ya karşı (hem salt okuma hem artık GERÇEK BİR YAZMA
ile) doğrulandı; tarayıcıda uçtan uca denendi.

**PDF karakter-karakter ayrılma düzeltmesi — `pdf-table.js` (2026-11-18):** kök neden, `pdf-text.js`'in KENDİSİNDE
değil `pdf-table.js`'in hücre birleştirme EKSİKLİĞİNDEYDİ — `groupRunsIntoLines` zaten belgeli olarak "sözcük/sütun
ayrımı YAPMAZ" (her metin gösterme komutunu AYRI bir hücre sayar); HAVANA'nın PDF'i (bu üretici her harfi ayrı bir
`Tj` ile yazıyor) bu yüzden satır başına onlarca TEK HARFLİK hücre veriyordu, `MAX_HEADER_WINDOW=3` hiçbir başlık
anahtar kelimesini (8+ harflik "AÇIKLAMA" gibi) yakalayamıyordu — `extractOrderTable` **0 satır** buluyordu.
- **Yeni `mergeCharacterCells(cells)`** (dışa aktarılır, `extractOrderTable` içinde `groupRunsIntoLines`'ın hemen
  ardından uygulanır): komşu hücreler arasındaki X boşluğunu ölçer, `CELL_BREAK_PT=24` altındaki boşluklarla komşu
  hücreleri TEK "kelime/alan" hücresinde birleştirir. Eşik, GERÇEK belgede ölçülen iki ayrı popülasyondan seçildi:
  aynı sözcük/alan İÇİ boşluk hep ≤~19pt, SÜTUNLAR ARASI boşluk hep ≥~29pt (çoğu 60-180pt) — net bir ayrım var.
  Zaten SÖZCÜK düzeyinde gelen normal PDF'lerde (Siamp/Konveyör, mevcut 6 test) bu bir NO-OP'tur (gerçek sözcükler/
  sütun etiketleri arası boşluk bundan HER ZAMAN büyüktür) — davranış DEĞİŞMEDİ, testlerle doğrulandı.
- **GERÇEK BİR HATA bulunup düzeltildi (ilk yazımda):** `mergeCharacterCells` boşluğu YANLIŞ hesaplıyordu — birleşen
  hücrenin İLK üyesinin x'ini SABİT referans alıyordu, bu da KÜMÜLATİF mesafeyi ölçüp ~5-6 harfte bir YANLIŞLIKLA
  koparıyordu (gerçek örnek: "HAVANA SANAYİ" "HAVA"+"NASA"+"NAYİ" diye üçe bölünüyordu — tutarlı küçük harf-arası
  boşluklu TEK bir sözcük olmasına rağmen). Düzeltme: ÖNCEKİ GİRDİ hücresinin x'i izlenmeli (birleşen hücrenin ilk
  üyesininki değil). 3 doğrudan `mergeCharacterCells` testi + 1 uçtan uca `extractOrderTable` testi eklendi (bu
  hatanın kendisini de doğrulayan bir regresyon testi dahil).
- **`deliveryDate` için yeni anahtar kelime `GIRISTARIHI` eklendi:** bu belgede "Beklenen" bir ÜST alt-başlık
  satırında AYRI duruyor, "Giriş Tarihi" ana başlık satırında TEK BAŞINA — `BEKLENENGIRISTARIHI` (iki ayrı satırdaki
  hücreler asla birleşmediği için) hiç eşleşmiyordu.
- **GERÇEK SONUÇ (`incoming-orders.js#importPdf`, gerçek HAVANA/SAS0003812 PDF'i, gerçek ürün kartlarıyla, scratch
  veritabanında):** `warning: null` (tablo bulundu), `customerGuess: "Ayvaz"` (doğru), **4 gerçek ürün satırının
  TAMAMI doğru Alen koduna eşlendi** (`matchStatus: "tam"`: SR003.007/SR002.007/SR001.007/SR009.007), teslim tarihi
  4'ünde de doğru çözüldü (6.11.2026 — `extractDateToken`'ın regex'i, rakamların başına bitişik başka rakamlar
  gelse bile GEÇERLİ `D.M.YYYY` alt-dizgeyi bulmakta sağlam çıktı, ayrıca doğrulandı). **5 "gürültü" satırı da
  çıktı** (malzeme-spec devam satırları gibi `matchStatus: "yok"` olan, zararsız — kullanıcı onay ekranından
  reddeder).
- **`qty` (adet) sütun bazlı bulunamıyor AMA AÇIKLAMA METNİNDEN KURTARILIYOR (düzeltildi/doğrulandı, 2026-11-18):**
  "Miktar"/"Birim"/"Birim" alt-başlıkları bu belgede birbirine ÇOK yakın (~19-21pt, `CELL_BREAK_PT`'nin altında)
  duruyor, TEK bir tanınmayan "M ktarB r m B r m " blob'una birleşiyor (bu belgede lowercase 'i' harfi bazı
  sözcüklerde — Miktar, Birim, Tarih, Vergi — ayrı, SESSİZCE boşluğa/hiçliğe düşen bir koda decode ediliyor,
  `pdf-text.js`'in font çözümündeki AYRI bir bilinmeyen; "GirişTarihi" gibi BAŞKA sözcüklerde aynı harf doğru
  çıkıyor, tutarsız — bu daha derin decode sorunu ARAŞTIRILMADI/düzeltilmedi). **Ama `incoming-orders.js#insertLine`'da
  ZATEN var olan bir kurtarma mekanizması bunu telafi ediyor:** adet sütunu bulunamadığında (`qty == null`) açıklama
  metninde `/(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?)\s*adet/i` aranır — bu belgede "GVA-16 YATAK **500,00Adet** DN50-65
  Ms58" gibi miktar AÇIKLAMANIN İÇİNDE geçiyor ("Adet" sözcüğünde 'i' yok, bu yüzden decode bozulmuyor). **Gerçek
  HAVANA/SAS0003812 PDF'iyle doğrulandı (2026-11-18):** 4 satırın 4'ünde de adet doğru çıkarıldı (500/2000/1000/1500,
  gerçek belgedeki değerlerle birebir) — bu, önceki "adet hiç çıkmıyor" notunun ARTIK GEÇERSİZ olduğunu kanıtlıyor.
- **Testler:** `pdf-table.test.js` 10 test (4 yeni: 2 doğrudan `mergeCharacterCells`, 1 Siamp/Konveyör-stili NO-OP
  regresyonu, 1 uçtan uca karakter-karakter `extractOrderTable`). `npm test` **857/857 yeşil**.
- **DENENMEDİ:** bu düzeltmenin BAŞKA karakter-karakter PDF üreten bir müşteriden gelecek farklı bir belgede de
  işe yarayıp yaramayacağı (yalnız bu TEK gerçek örnekle kalibre edildi); tarayıcıdan gerçek dosya yükleyerek
  (yalnız doğrudan API/fonksiyon çağrısıyla test edildi, diğer PDF özellikleriyle aynı bilinen sınır).

**TÜM 4 GERÇEK PDF, ÜRETİM YOLUYLA (`incoming-orders.js#importPdf`) UÇTAN UCA YENİDEN DOĞRULANDI (2026-11-18, kullanıcı
isteği: "pdf kısmında hala sıkıntı yaşıyor muyuz" — salt okuma, scratch kopya `planlama.db`'ye karşı, Mikro'ya HİÇBİR
ŞEY YAZILMADI):**
| PDF (müşteri) | Sayfa | Sonuç |
|---|---|---|
| `2611000084...` (Siamp) | 1 | 1 satır, tam eşleşti (Nİ002.001, 5000 adet, 15.11.2026) |
| `SAS0003812...` (Ayvaz/HaVana) | 1 | **4/4 satır tam eşleşti** (SR001-003.007 + SR009.007), adetler DOĞRU çıkarıldı (yukarıdaki "Adet" kurtarma mekanizması sayesinde) |
| `4100018539...` (Konveyör) | 4 | 11 satır, 10/11 tam eşleşti (1 satır gerçekten kartı olmayan bir ürün — hata değil) |
| `2189_001...` (Ayvaz, taranmış) | 4 | OCR ile 3 sayfa okundu (1 sayfa gerçekten boş bir form şablonu — OCR hatası değil), 1 gerçek satır tam eşleşti (SR070.002) |

**Sonuç: dört belgenin dördünde de artık gerçek bir "ayrıştırma sıkıntısı" YOK** — hepsi doğru müşteri tahmini,
doğru satır sayısı ve (eşleşen ürün kartı varsa) doğru Alen koduyla çıkıyor. `npm test` 857/857 yeşil (kod
değişmedi, yalnız üretim koduna karşı gerçek veriyle yeniden doğrulama). O sırada kalan tek bilinen sınır PDF'ten
FİYAT'ın hiç çıkarılmaması idi — bu, aynı gün AYNI oturumda eklendi (bkz. aşağıdaki "Fiyat çıkarma + her alan
düzenlenebilir").

**Sıradaki (§10'a da yazıldı):** SPR-755 test kaydının Mikro'dan gerçekten silinip silinmediğini doğrulamak (bir
önceki bölüme bakın), bu belgedeki 'i'-decode sorununu araştırmak (qty'yi kurtarmak için, isteğe bağlı/düşük
öncelik), Tesseract'ın installer'a gömülmesi, revizyon karşılaştırmasının gerçek bir e-posta HTML'iyle
doğrulanması, Graph API/mail bağlantısı (henüz kimlik bilgisi yok).

#### Fiyat çıkarma + her alan düzenlenebilir (2026-11-18, kullanıcı isteği: "niye fiyat çıkarılamıyor o da çıksın
ama fieldlar zaten check edilecek... her şey düzenlenebilir olsun")

Yukarıdaki 4 gerçek PDF'in GERÇEK başlık metinleri incelenerek (tahmin değil) birim fiyat sütunu bulundu:
**Siamp** "BR FİYATI"/"TOP. FİYATI", **Konveyör** "Tutar"/"Net Tutar" (bu belgede birim fiyat sütununun adı
literal olarak "Tutar"dır — "Net Tutar" asıl satır toplamıdır; `84,18 × 280 = 23.570,4` ile doğrulandı). İki
belgede de aynı hücrede HEM birim fiyat HEM satır toplamı art arda gelebiliyor (header sınırları iki ayrı sütunu
her zaman ayıramıyor) — bu yüzden `pdf-table.js`'e tek bir **`price`** alanı eklendi (`HEADER_KEYWORDS`, anahtar
kelimeler `FIYAT`/`TUTAR`), ayrı bir `lineTotal` alanı İCAT EDİLMEDİ: `extractPriceToken` (incoming-orders.js) bir
hücrenin metninden virgüllü İLK sayıyı alır — iki sayı art arda gelse de (Türkçe yazımda virgül her zaman ondalık
olduğu için) ilk eşleşme her zaman birim fiyattır.

- **SIRA KRİTİK (gerçek regresyon riski, testle doğrulandı):** `price` alanı `HEADER_KEYWORDS` dizisinde
  **`deliveryDate`'DEN SONRA** eklendi. Gerçek HAVANA/SAS0003812 belgesinde "Tutar" ve "Giriş Tarihi" başlıkları
  TEK hücrede birleşiyor ("TutarGirişTarihi") — anahtar kelime eşleştirme `matchesInLine`'ın dizi sırasına göre
  İLK bulduğu alanı seçtiği için, `price` daha ÖNCE kontrol edilseydi `deliveryDate`'in kendi anahtarı
  (`GIRISTARIHI`) hiç denenmeden bu alanı KAZANIRDI — gerçek teslim tarihi çıkarımı BOZULURDU. Bu sırayla
  `deliveryDate` (checked önce) kazanıyor, `price` bu belgede hiç kendi sütununu BULAMIYOR (bilinçli, kabul
  edilen bir sınır — aşağıdaki fallback bunu telafi ediyor).
- **Fallback — başlık eşleşmezse (HAVANA gibi) `deliveryDate` alanının HAM metninden kurtarılır:** bu belgede
  fiyat/tutar/tarih AYNI hücrede kalıyor ("Mal yet 157,55 78.775,006.11.2026"); `#insertLine` `price == null`
  olduğunda AYNI metni (`row.deliveryDate`) `extractPriceToken` ile TEKRAR tarar (qty'nin açıklamadan
  "<sayı>Adet" kalıbıyla kurtarılmasıyla AYNI ilke) — qty bu metinde HİÇ YOK (ayrı sütunda/description'da), bu
  yüzden yanlışlıkla qty'yi fiyat sanma riski yok.
- **Her şey düzenlenebilir — `updateLine(id, {qty?, deliveryDate?, custOrderNo?, price?, stockCode?})`:** kullanıcının
  açık isteği — fieldlar onaylanıp Mikro'ya gönderilmeden önce ZATEN kontrol edilecek, bu yüzden hiçbir çıkarılan
  alan "kesin" olmak zorunda değil. Yalnız `bekliyor` durumundaki bir satırda çalışır (409, karara bağlanmışsa).
  Doğrulama paylaşılan `fields.js` (`number`/`day`/`text`) üzerinden — `price` `allowZero:true` (Mikro'nun
  kendisi de 0'ı kabul ediyor, "fiyat bilinmiyorsa 0" — bkz. `mikro-order.js`). `stockCode` verilirse `approveLine`
  ile AYNI eşleme mantığı (ürün kartı aranır, bulunamazsa 404). Uç: `PUT /api/planning/incoming-orders/lines/:id`
  (`yenisiparis`/yazma, `policy.js`).
- **Dashboard** (`dashboard/planning-incoming-orders.js`): taslak tablosuna **"Fiyat"** sütunu eklendi (salt
  gösterim, `fmtDec`); bekleyen her satırda **"Düzenle…"** düğmesi (Onayla/Reddet'in yanında) adet/teslim
  tarihi/müşteri sipariş no/fiyatı düzeltip kaydeder. "Mikro'ya gönder…" penceresinin "Birim fiyat" alanı artık
  taslağın (çıkarılmış ya da elle düzeltilmiş) fiyatıyla ÖNCEDEN DOLU açılır (`priceInputValue`: `fmtDec`'in
  binlik-ayraçlı biçimi BİLEREK kullanılmadı — gönderim kodu metni yalnız "," → "." çevirip gönderiyor, binlik
  noktası olsaydı "1.500,50" → "1.500.50" = YANLIŞ sayı olurdu; bu yüzden gruplamasız, yalnız ondalık virgüllü
  düz metin üretildi).
- **`routes.js`'teki mikro-preview/mikro-send:** istek gövdesi `unitPriceValue` göndermezse (anahtar hiç yok,
  `undefined`) satırın `price`'ına DÜŞER; **açıkça `null` gönderilirse** (kullanıcı kutuyu BİLEREK boşalttıysa)
  bu YOK SAYILMAZ, 0 gönderilir — `undefined` kontrolü SART (gevşek bir `??` kullanılsaydı kasıtlı boşaltma
  sessizce eski fiyata dönerdi).
- **Testler:** `pdf-table.js`'in testleri (sıra/pencereleme) dokunulmadan 23/23 yeşil kaldı (regresyon yok);
  `incoming-orders.test.js`'e 5 yeni test (FİYAT başlıklı sütundan doğrudan çıkarım, başlık eşleşmezse
  `deliveryDate`'ten fallback + tarihin BOZULMADIĞI, tek hücrede iki sayı varsa İLKİNİN alınması, `updateLine`'ın
  tüm alanları + kısmi güncelleme + 0 fiyatın kabulü + karara bağlanmış satırda 409, `stockCode` ile eşleme);
  `mikro-order.test.js`'e 1 HTTP testi (`unitPriceValue` gönderilmezse taslağın fiyatına düşme, açıkça gönderilen
  değerin onu ezmesi, açık `null`'ın 0'a düşmesi). `npm test` 863/863 yeşil.
- **GERÇEK 4 PDF'le (salt okuma, scratch kopya `planlama.db`, Mikro'ya HİÇBİR ŞEY YAZILMADI) yeniden doğrulandı:**
  Siamp → 0,54 (BR FİYATI ile birebir); HAVANA → 157,55 / 115,90 / 68,00 / 142,50 (dördü de fallback'ten, önceki
  turda elle doğrulanan çarpım kontrolüyle — `fiyat × adet = Net Tutar` — birebir); Konveyör → 10 satırın 10'unda
  da kendi sütunundan doğru birim fiyat (84,18…92,8 arası); taranmış Ayvaz (OCR) → `null` (bu sayfada fiyat
  sütunu OCR ile güvenilir çıkmadı, elle girilecek — yanlış bir değer göstermek yerine boş kalması BİLİNÇLİ).
- **DENENMEDİ:** tarayıcıdan "Düzenle…" ve "Mikro'ya gönder…" pencerelerinin gerçek tıklamayla uçtan uca akışı
  (yalnız kod incelemesi + backend testleriyle doğrulandı); e-posta tablosu (`parseEmailTable`) yolundan fiyat
  çıkarımı (gerçek bir e-posta örneği hâlâ yok, bkz. yukarıdaki "DENENMEDİ"); gerçek Mikro'ya price'lı bir sipariş
  GÖNDERME (yalnız önizleme/gövde doğrulandı, `MIKRO_WRITE_ENABLED` bu oturumda hiç açılmadı).

**Revizyon e-postasının GERÇEK biçimi bulundu, ilk tasarım YANLIŞTI, düzeltildi (2026-11-19, kullanıcı gerçek bir
revizyon e-postasının görünür içeriğini (plain-text kopyalanmış, gerçek HTML değil) paylaştı):** kullanıcının asıl
sorusu — "bir revizyon dosyasında birden fazla (kendi SPR'imiz DEĞİL, müşterinin kendi) sipariş numarasıyla ilgili
revizyon olabilir, hepsini doğru buluyor mu" — önce KOD OKUNARAK cevaplandı: `#insertLine` zaten satır bazında
çalışıyor, her satırın KENDİ `custOrderNo`'su (o satırın "SİPARİŞ NUMARASI" sütun değeri) ile `order_lines`'ta arama
yapıyor, batch/dosya düzeyinde "tek sipariş no" varsayımı YOK — bu doğru çıktı. Ama kullanıcının verdiği GERÇEK
revizyon örneği, **"sarı vurgulu hücre" tasarım varsayımının (2026-11-17'de yalnız bir ekran görüntüsünden kurulmuş,
hiç gerçek HTML ile denenmemiş) YANLIŞ olduğunu ortaya çıkardı:**
- **Gerçek biçim, hücre dizisini (kopyalanan düz metin, satır-öncelikli sıra) elle takip ederek çözüldü:** normal
  bir satır 5 değer taşır (`tarih, sipariş no, kod, açıklama, miktar`); REVİZE edilen bir satır **6 değer** taşır —
  son (6.) değer **YENİ hedef** (yeni miktar, yeni tarih, ya da `"iptal"`/`"İPTAL"`), 5. değer (başlığın kendi
  "SIPARIS MIKTARI" sütunu) ise **ESKİ (hâlâ Mikro'daki) değer**. Örnek, çapraz doğrulandı: revizyon e-postasındaki
  `211015073 / D.DÖKÜM RAKOR SOMUN` satırı `1.200 → 1500` diyor — kullanıcının AYNI oturumda daha önce paylaştığı
  TAM sipariş listesinde bu AYNI (sipariş no, ürün) çifti artık 1.500 olarak duruyor: iki bağımsız gerçek kaynak
  birbirini doğruladı. **Hiç sarı vurgu/renk YOK** — sinyal tamamen YAPISAL (fazladan bir hücre), görsel değil.
  Bu, admin'in e-postadan tabloyu Ctrl+C/Ctrl+V ile kopyalayıp **doğrudan bu uygulamaya yapıştıracağı** akışla
  (kullanıcının kendi sözü: "mail üzerinden okuma yapmaya gerek yok") tam uyumlu — gerçek HTML clipboard'ı
  `parseEmailTable`'a ulaşacak, bu konuşmada görülen (biçimi bozulmuş) düz metin değil.
- **İKİ gerçek hata bulunup düzeltildi** (`backend/planning/incoming-orders.js`):
  1. `parseEmailTable`: `revisionNote` artık YALNIZ vurgulu hücreden değil, **başlığın hücre SAYISINI aşan fazladan
     bir hücre** varsa ondan da alınır (`row.length > headerWidth` → son hücre). Vurgulu hücre hâlâ ÖNCELİKLİ
     (başka bir müşteri gerçekten renk kullanıyorsa bozulmasın); hiçbiri yoksa `null` (eskisi gibi).
  2. `#insertLine`: revizyon notu `'miktar'`/`'tarih'` tipine sınıflandığında, **ESKİDEN yalnız `revisionType`
     etiketleniyordu, taslağın `qty`/`deliveryDate` alanı hep ESKİ (5. sütun) değerde KALIYORDU** — yani sistem
     revizyonu doğru TANIYORDU ama yanlış sayıyı SAKLIYORDU (kullanıcı ekranda "1200" görürdü, "1500" değil).
     Artık not'un değeri (varsa) `qty`/`deliveryMs`'YE YAZILIR; var olan siparişi ARARKEN (`#findExistingLine`)
     ise KASITLI OLARAK satırın ESKİ (henüz Mikro'da geçerli olan) tarihi kullanılır — YENİ hedef tarihle aramak
     "tarih değişti" revizyonlarında var olan kaydı BULAMAZDI (Mikro henüz güncellenmedi, kayıt hâlâ eski tarihte).
  `"iptal"` durumunda `qty` bilerek DEĞİŞTİRİLMEZ (0 yapılmaz) — iptal edilen adedi bilgi olarak taşımaya devam eder.
- **Testler** (`incoming-orders.test.js`): yeni `parseEmailTable` testi (fazladan hücre → not; normal 5-hücreli
  satırda not YOK) + kullanıcının TAM gerçek revizyon örneğiyle (5 satır, 2 farklı sipariş no: `211015073` ×4 +
  `211027082` ×1, "iptal" ×2 + "miktar" ×2 + "tarih" ×1) uçtan uca bir test: her satırın doğru sipariş no'ya
  bağlandığı, `qty`/`deliveryDate`'in YENİ hedefe döndüğü, `existingQty`/`existingDueDate`'in ESKİ var olan
  kayıttan geldiği VE aynı sipariş no'yu paylaşan 4 satırın birbirinin `existingLineId`'sini ÇALMADIĞI (4 farklı
  ürün → 4 farklı var olan kayıt) ayrı ayrı doğrulandı. `npm test` 894/894 yeşil.
- **Hâlâ DENENMEDİ:** bu gerçek HTML'in KENDİSİ (yalnız kullanıcının düz-metin kopyası elle HTML'e çevrilip test
  edildi — Outlook/webmail'in bu tabloyu kopyalarken ÜRETTİĞİ gerçek `<table>`/`<tr>`/`<td>` markup'ı hâlâ hiç
  görülmedi); tarayıcıdan admin'in GERÇEK Ctrl+C/Ctrl+V akışıyla "E-posta tablosunu yapıştır…" penceresine
  yapıştırması (`clipboardData.getData('text/html')`'in bu özel e-posta istemcisinden ne ürettiği bilinmiyor).
  Kullanıcının "mail üzerinden okuma yapmaya gerek yok, yönetici kopyalayıp yapıştırır" netleşmesiyle, Graph
  API/otomatik mail tarama artık bu özellik için GEREKSİZ görünüyor (§10'daki ilgili madde buna göre güncellendi).

**Müşteri tahmini artık ürün kodunun SONUNDAKİ 3 haneden de çıkarılır (2026-11-19, kullanıcı isteği):** gerçek
dosyadan alınan bir ekran görüntüsünde e-posta tablosu taslağının `customerGuess`'i her zaman "müşteri tahmin
edilemedi" diyordu — `importEmailTable` bu alanı hiç hesaplamıyor, hep `null` yazıyordu (yalnız PDF yolundaki
`detectPdfCustomer`, sayfa metninde "SIAMP"/"AYVAZ"/"KONVEYOR" gibi sabit anahtar kelimeler arıyordu). Kullanıcının
kendi tarifi: *"mail üzerinden bu şekilde tablo olarak siparişi sadece Berg gönderiyor zaten birde mantık olarak bu
ürünlerin orada kodları var sonunda 013 olduğunu görüyor oradan da berg olduğunu anlıyoruz."*
- **İKİNCİ bir müşteri grubu listesi İCAT EDİLMEDİ** — Numune Takip'in (EYS.FR.012) yeni ürün kodu üretme akışı için
  zaten var olan **AYNI 19 sabit grup** (`sample-customer-groups.js`, kodun SONUNDAKİ 3 hane → müşteri; ör. "013" =
  Berg Metal, "011" = Konveyör) doğrudan yeniden kullanıldı (`sampleGroupByCode`): proje genelindeki "tek kaynak,
  kopyalama" ilkesiyle aynı.
- **`customerGroupOfStockCode(stockCode)`** (`incoming-orders.js`, yeni): eşleşen bir satırın `matchedStockCode`'unun
  (ör. "SR009.013") sonundaki `.NNN`'i regex'le (`/\.(\d{3})$/`) çıkarıp `sampleGroupByCode`'a verir; biçime uymayan
  (eski/numune, ".013" gibi bir son ek taşımayan) bir kod için `null`.
- **`#guessCustomerFromProducts(batchId)`**: taslağın (yalnız `match_status='tam'`, yani GERÇEKTEN eşleşmiş) tüm
  satırlarının eşleşen stok kodlarını toplar; **hepsi AYNI müşteri grubuna çıkarsa** o grubun adını döner, **farklı
  gruplar karışıksa ya da bir kod biçime uymuyorsa `null`** — CLAUDE.md'nin "asla belirsizken tahmin etme" ilkesiyle
  aynı (tek bir aykırı/bilinmeyen kod bile tüm tahmini durdurur, en yakın çoğunluğu VARSAYMAZ).
- **E-posta tablosunda HER ZAMAN denenir** (eskiden hep `null`'dı, kaybedecek bir şey yok); **PDF'te yalnız
  `detectPdfCustomer` metinden bir isim BULAMADIYSA** (YEDEK sinyal — metinden gelen isim zaten varsa EZİLMEZ, metin
  daha güvenilir bir kanıt sayılır). İnsert sırası: önce `#insertBatch` + tüm satırlar `#insertLine` ile kaydedilir
  (eşleşme bilgisi veritabanında olmalı), sonra `customerGuess` hâlâ boşsa `UPDATE incoming_batches SET
  customer_guess = ?` ile tek seferlik doldurulur.
- **Testler** (`incoming-orders.test.js`): var olan gerçek-e-posta testine (5 ürün, hepsi ".013") `customerGuess ===
  'Berg Metal'` doğrulaması eklendi + 6 yeni test (e-posta: tüm eşleşenler aynı grup → doldurulur, farklı gruplar
  karışık → `null`, biçime uymayan kod → `null`, hiç eşleşen yok → `null`; PDF: metinden bulunamayınca kod-sonu
  YEDEK tahmini, metinden ZATEN bir isim bulunduysa EZİLMEDİĞİ). `npm test` 899/899 yeşil.
- **DENENMEDİ:** gerçek bir e-posta/PDF taslağında (yalnız sentetik veriyle test edildi); birden çok müşterinin
  AYNI grup koduna (ör. hem Berg hem başka biri ".013" paylaşırsa) denk gelmesi gibi bir çakışma hiç gözlenmedi,
  teorik olarak mümkünse sessizce yanlış bir isim önerebilir (yalnız öneri, onaydan önce elle düzeltilebilir —
  Mikro'ya hiçbir şey yazmaz).

### Sipariş fişi (atölye malzeme/takım talebi) — 2026-11-17, kullanıcı isteği

Fabrikada usta, üretimde ihtiyaç duyduğu parça/takım/sarf malzemesini elle bir **"SİPARİŞ FİŞİ"** kağıdına
(fotoğrafla verildi: genel-amaçlı matbu bir sipariş fişi defteri, "Dilman" yalnızca kağıdı basan kırtasiyeci) yazıp
kesiyordu — İsim, Tarih ve Adet/Malın Cinsi sütunlarını doldurup, kağıdın "YEKÜN" sütununu MARKA için kullanıyordu
(örnekte "HORN" bir kez yazılıp altına "aynı" işareti (″) çekilmiş). Kağıdın Adres/Şehir/V.D./H.No./Fatura No/Ambar
gibi genel-amaçlı alanları hiç kullanılmıyor, buraya alınmadı. Kullanıcının kendi tarifi: *"adet, malın cinsi ve
marka sütunları var sadece."*

**Netleşen kararlar (AskUserQuestion ile soruldu, 2026-10-30'daki esnek rol sistemi mimarisine göre):**
- **Erişim:** `siparisfisi` ekranına yazabilen HER role açık (Tezgah başı/Paketleme ile AYNI desen — admin Ayarlar >
  Roller'den hangi role bu ekranı vereceğine karar verir; göçle gelen İzleyici/Operatör rollerine OTOMATİK
  eklenmedi, diğer tüm yeni ekranlarla aynı ilke). Silme kayıtsız → admin.
- **Durum takibi:** `bekliyor` → `verildi` (sipariş verildi) → `geldi` (teslim alındı); yanlışlıkla ileri götürülürse
  **"Bir adım geri al"** ile tek adım geri döner (Hurda Girişi'nin `reopen()`'ıyla AYNI felsefe — burada üç durum
  olduğu için "bir adım", iki değil).

**Tasarım:** `products` tablosuyla HİÇ BAĞLANMAZ (Numune Takip/Hurda Girişi/Fiyat çalışması ile AYNI ilke) — "malın
cinsi" genelde tedarikçi katalog numarasıdır (ör. `B114.0016.2.02`, `RS114.0200.D2 TH35`), Alen ürün kodu değil.
**Kalemler (satırlar) TEK SEFERDE yazılır/değiştirilir** (wholesale replace, JSON sütun) — ölçü planı editörüyle
(`measure.js` `normalizePlan`, `dashboard/planning-measure.js`'teki "satır ekle/sil") AYNI desen; kalem başına ayrı
ekle/sil ucu YOK, bilerek basit tutuldu. Ayrı bir sayaç İCAT EDİLMEDİ: görüntü kodu (`S000001`) doğrudan DB
id'sinden türetilir (Ürün Tanıtım Kartı `K000001`/Hurda Girişi `H000001` ile AYNI görünüm).
- **Dosyalar:** `backend/planning/supply-requests.js` (`SupplyRequests`, tablo `supply_requests`, `planlama.db`'de
  kendi `CREATE TABLE IF NOT EXISTS`'i ile — diğer alt modüllerle aynı desen, hangi modülden önce ilklenirse
  ilklensin bağımsız çalışır), `planning.js` (`this.supplyRequests`), `routes.js`, `dashboard/planning-supply-requests.js`.
- **Ekran:** `shared/screens.js`/`dashboard/screens.js`'e `siparisfisi` (`writable:true`, `isemirleri`'nin hemen
  ardında) eklendi; `NAV_LAYOUT`'ta "Depo" grubuna (Paketleme/Hurda girişi'nin yanına) girdi. `backend/auth/policy.js`
  `SCREEN_ROUTES`'a GET/POST/PUT/order/receive/back (okuma/yazma role'e); `DELETE` kayıtsız → admin.
- **Uçlar:** `GET/POST /api/planning/supply-requests` (liste `?q=&status=` / yeni fiş, `{requestedBy, requestedOn?,
  note?, lines:[{qty, item, brand?}]}`, en az bir kalem zorunlu) · `GET/PUT /api/planning/supply-requests/:id`
  (ayrıntı / düzenle — `lines` gönderilirse TÜM kalemler değişir) · `DELETE .../:id` (admin) · `POST
  .../:id/order` ("sipariş verildi") · `POST .../:id/receive` ("teslim alındı") · `POST .../:id/back` (bir adım geri).
- **Gerçek bir UI hatası bulunup düzeltildi (tarayıcıda denerken):** kalem ekle/sil (`"＋ Kalem ekle"`/`"Sil"`)
  dialog'un TÜM `innerHTML`'ini yeniden kuruyordu; yeni kayıt oluştururken (`s` henüz `null`) bu redraw İsim/Tarih/
  Açıklama alanlarını `s?.requestedBy ?? ''` gibi hep BOŞ bir değerden yeniden kurduğu için, kullanıcı bu alanlara
  bir şey yazıp SONRA bir kalem eklerse/silerse yazdığı İsim/Tarih/Açıklama SESSİZCE SİLİNİYORDU (numune ekranındaki
  `gen-group` değişince tam `draw()`'ın aynı sınıf hatasıyla AYNI kök neden). Düzeltme: `lines` dizisiyle AYNI
  şekilde kalıcı bir `fields` nesnesi eklendi (`requestedBy`/`requestedOn`/`note`), her redraw'dan önce `read()` ile
  DOM'dan senkronize edilir, `draw()` artık `s?.alan` yerine `fields.alan`'dan okur.
- **Testler:** `backend/planning/supply-requests.test.js` (4: oluşturma + kalem doğrulama — adet/malın cinsi/60 sınırı
  —, durum geçişleri — sırasız geçiş reddi, "geri al"ın bekliyorken no-op olması, alanların temizlenmesi —, kısmi
  düzenleme + wholesale kalem değişimi + arama/liste/silme, HTTP uçtan uca) + `backend/auth/policy.test.js` +
  `backend/apps.test.js`/`backend/features.test.js` (yeni ekran eklenince sabit sekme sayısı/listesi güncellendi,
  diğer yeni ekranlarla aynı). `npm test` 825/825 yeşil.
- **Tarayıcıda gerçek dev sunucusuna (bu makinenin `data/planlama.db`'si) karşı uçtan uca denendi:** 2 kalemli
  (`B114.0016.2.02` · HORN, `RS114.0200.D2 TH35` · HORN) bir test fişi oluşturuldu (yukarıdaki kalem-ekleme hatası
  BU testte bulunup aynı oturumda düzeltildi) → "Sipariş verildi" → "Teslim alındı" (chip'ler doğru göründü) →
  "Formu görüntüle/yazdır" (kağıt fişin düzenine uygun önizleme) → API ile doğrulanıp silindi (`window.confirm()`
  native onayı bu oturumun tarayıcı aracında sınanmadı, diğer "Sil…" düğmeleriyle AYNI bilinen sınır — silme
  doğrudan API çağrısıyla yapıldı).
- **DENENMEDİ:** gerçek yazıcıdan A4 baskı ve kağıt fişle yan yana karşılaştırma; fabrika PC'sinde gerçek kullanım;
  admin'in bu ekranı hangi role (yeni ya da var olan) açacağına karar vermesi (göçle gelen roller otomatik almadı);
  `window.confirm()` ile "Sil…" akışının tarayıcıdan uçtan uca tıklanması.

### Takım ve Pens Takip (EYS.LS.026 "Pens ve Takım Takip Listesi" + "Takım Uçları ve Tutucuları") — 2026-11-17, kullanıcı isteği

Kullanıcı iki gerçek Excel dosyası verdi ve "bunlarla ilgili yeni bir tab istiyorlar takip için kullanılacak isim
yazılacak adet yazılacak var olan kayıt düzenlenecek vs birde bu excelleri direkt içeri aktarabilelim" dedi — Ölçüm
Cihazları Takip (EYS.LS.006) ile AYNI desende yeni bir envanter takip ekranı, artı Excel içeri aktarma.

**Dosyaların gerçek yapısı (salt okuma ile çözüldü):** `EYS.LS.026 PENS ve TAKIM TAKİP LİTSESİ.xlsx` İKİ farklı alt
liste taşıyor (aynı çalışma kitabının iki sayfası) + bir ÜÇÜNCÜ, eski/yinelenen kopya sayfa:
  1. **"… TAKIM TAKİP"** (165 satır): SIRA NO/MARKA/KOD/İSİM/STOK/KRİTİK STOK/AÇIKLAMA — İSİM takımın TÜRÜdür
     (ör. "Matkap", "KILAVUZ", "Karbür Freze"), STOK/KRİTİK STOK sütunlarında sayı YANINDA "X" gibi sayısal
     olmayan işaretler de var (muhtemelen "stok yok/tükendi" anlamında).
  2. **"… PENS TAKİP"** (53 satır): ÜÇ şekil grubu (YUVARLAK/ALTI KÖŞE/SEKİZ KÖŞE) yan yana, her biri kendi
     Ölçü/Adet/Not üçlüsü — klasik `findHeaderByKeys` ile OKUNAMAZ (aynı başlık 3 kez tekrarlanıyor, generic
     eşleyici yalnız İLK tekrarı yakalardı); bu yüzden ÖZEL bir sütun-grubu tarayıcı yazıldı.
  3. **"Sayfa2"**: resmi Pens Takip sayfasıyla AYNI 65 ölçünün (Ø12…Ø42, AK11…AK38) BİREBİR AYNI adet değerleriyle
     yinelenen bir kopyası (yalnız sütun adları "Ölçü/Adet/Not" yerine "ÇAP/ADET", "Not" sütunu yok) — açıkça eski
     bir çalışma kopyası, gerçek ek veri taşımıyor.
  Ayrı, bağımsız `Takım uçları ve Tutucuları v2.xlsx` dosyası: **"Takım Uçları"** (165 satır) ve **"Takım Tutucular"**
  (14 satır) sayfaları, ikisi de Marka/Kodu/İsmi/Adet — kategori ayrımı SÜTUNLARDA değil, SAYFA ADINDA (üçüncü,
  boş bir "Sayfa1" de var, hiçbir veri taşımıyor).

**Tasarım (Ölçüm Cihazları Takip ile AYNI ilke):** `products` ile BAĞLANMAZ; **kategori SERBEST METİN** ("yeniler
de alınıyor" — yeni takım türleri kısıtlanmadan eklenebilmeli). Üç farklı kaynağı TEK alan setine normalize eder:
`category` (Takım Takip'te İSİM/takım türü; Pens'te "Pens - Yuvarlak" vb.; Uç/Tutucu'da sayfa adından), `name`
(zorunlu tanım — Takım Takip'te KOD, yoksa İSİM; Pens'te ölçü; Uç/Tutucu'da İsmi, yoksa Kodu), `brand`, `code`,
`qty`, `criticalQty`, `note`. **`qty`/`criticalQty` SERBEST METİNdir, sayı DEĞİL** — gerçek veride "X" gibi
sayısal olmayan işaretler zorla sayıya çevrilseydi bu bilgi kaybolurdu.

**İçeri aktarma — gerçek bir dedup hatası bulunup düzeltildi (tarayıcıda gerçek dosyayla denerken):** Pens Takip'te
"kod" gibi doğal bir benzersiz anahtar YOK (aynı ölçü — ör. "AK13" — gerçek dosyada İKİ AYRI satırda, muhtemelen
iki ayrı fiziksel parti olarak tekrar ediyor) — bu yüzden dedup **sayıma dayalı**: (kategori+tanım+marka+kod)
anahtarı için veritabanında zaten kaç kayıt varsa sayfadaki aynı anahtarlı satırların o kadarı "zaten var" sayılıp
atlanır, fazlası yeni kayıt olur (aynı dosyayı iki kez yüklemek güvenli, ama gerçek tekrarlar veri kaybetmeden
korunur). **İlk gerçek dosya testinde bulunan hata:** bu sayım mantığı yalnız "ÖNCEKİ bir API çağrısından kalan"
veritabanı durumunu karşılaştırıyordu, AYNI çağrı içinde BİRDEN FAZLA sayfa işlenirken (official Pens Takip
sayfası + "Sayfa2" kopyası AYNI import isteğinde) veritabanı henüz güncellenmediği için ikisi de "hiç yok" görüp
HER İKİSİNİ de ekliyordu — 65 pens kaydı yerine 126 (AK13 gibi gerçek tekrarlar 2 yerine 4) oluştu. **Düzeltme:**
aynı çalışma kitabında BİREBİR AYNI kategori kümesini üreten İKİNCİ bir sayfa (ör. Sayfa2, Pens Takip ile AYNI 3
kategoriyi üretiyor) TAMAMEN atlanır — Takım Uçları/Tutucular gibi FARKLI kategoriye düşen sayfa çiftleri
(sayfa adından geldiği için) birbirini ETKİLEMEZ, ikisi de işlenir. Düzeltme sonrası gerçek dosyada doğrulandı:
227 satır (165 Takım Takip + 62 Pens), "Sayfa2" uyarıyla atlandı, AK13 tam 2 kayıtla kaldı; aynı dosyanın İKİNCİ
yüklemesi `added:0, skipped:227` ile tam idempotent.
- **Dosyalar:** `backend/planning/tool-inventory.js` (`ToolInventory`; saf ayrıştırıcılar `parseTakimSheet`/
  `parseUcTutucuSheet`/`parsePensSheet` dışa aktarılır, tablo `tool_items`, `planlama.db`'de kendi
  `CREATE TABLE IF NOT EXISTS`'i ile), `planning.js` (`this.toolInventory`), `routes.js`, `dashboard/planning-tool-inventory.js`.
- **Ekran:** `shared/screens.js`/`dashboard/screens.js`'e `takimtakip` (`writable:true`, `bakim`'in hemen ardında)
  eklendi; `NAV_LAYOUT`'ta "Kalite" grubuna (Bakım'ın yanına) girdi. `backend/auth/policy.js` `SCREEN_ROUTES`'a
  GET/POST/PUT (okuma/yazma role'e); `DELETE` ve Excel içeri aktarma kayıtsız → admin (Ölçüm Cihazları Takip'teki
  AYNI "günlük kullanım role'e, toplu/geri dönüşsüz işlemler admin'e" deseni).
- **Uçlar:** `GET/POST /api/planning/tool-items` (liste `?q=` / yeni kayıt, yalnız kategori+tanım zorunlu) ·
  `GET /api/planning/tool-items/categories` (DISTINCT kategori listesi, öneri açılır kutusu için) · `POST
  /api/planning/tool-items/import` (gövde = ham `.xlsx`; çalışma kitabındaki HER sayfa sırayla üç şekille de
  denenir) · `GET/PUT /api/planning/tool-items/:id` (ayrıntı/düzenle) · `DELETE .../:id` (admin).
- **Testler:** `backend/planning/tool-inventory.test.js` (7: oluşturma + doğrulama, Takım Takip sayfası ayrıştırma,
  Pens Takip şekil-grubu ayrıştırma + gerçek tekrarların korunması + idempotent yeniden yükleme, **yinelenen
  "Sayfa2" kopyasının tamamen atlanması + farklı-kategorili sayfa çiftlerinin birbirini etkilememesi** — yukarıdaki
  hatanın regresyon testi, Uç/Tutucu sayfası ayrıştırma, tanınmayan dosya/bozuk dosya hatası, HTTP uçtan uca) +
  `backend/auth/policy.test.js` + `backend/apps.test.js`/`backend/features.test.js` (sabit sekme sayısı/listesi
  güncellendi). `npm test` 833/833 yeşil.
- **Gerçek dosyalarla tarayıcıda uçtan uca denendi (bu makinenin `data/planlama.db`'si):** her iki dosya da
  gerçekten içeri aktarıldı (227 + 177 = **404 gerçek kayıt**, 88 farklı kategori), arama (marka/kategori/kod),
  bir kaydı düzenleme (Stok/Adet değişikliği API ile doğrulandı), "Yeni kayıt ekle" ile manuel kayıt oluşturma,
  "Listeyi yazdır" önizlemesi (EYS.LS.026 başlığıyla, süzülmüş listeyi basıyor) — hepsi çalıştı. Test amaçlı
  eklenen manuel kayıt silindi, gerçek 404 kayıt `data/planlama.db`'de kaldı (diğer EYS.LS içeri aktarımlarıyla
  AYNI ilke: sentetik test verisi temizlenir, gerçek içeri aktarım kalır).
- **Bilinen bir veri çakışması (düzeltilmedi, kullanıcıya iletilmeli):** kullanıcının İKİ kaynak dosyası bazı
  GERÇEK takımlar için ÇAKIŞIYOR — ör. "Iscar Picco R-MFT606-4 L12 908" hem dosya 1'in Takım Takip sayfasında
  (kategori "4'lük Picco Diş Çekme Metrik Derece" ile) HEM dosya 2'nin Takım Uçları sayfasında (kategori
  "Takım Ucu" ile) ayrı ayrı kayıtlı — iki kaynağın kendi iç verisi farklı şekilde kategorize ettiği için dedup
  bunları AYNI kayıt saymaz (kategori anahtara dahil), ikisi de ayrı satır olarak kalır. Bu bir import HATASI
  değil, kullanıcının kendi iki Excel dosyasının GERÇEKTEN örtüşmesi — hangi kaydın "doğru" sayılacağına (ya da
  ikisinin birleştirilip birleştirilmeyeceğine) kullanıcı/usta karar vermeli, sistem kendiliğinden birleştirmez.
- **DENENMEDİ:** gerçek yazıcıdan baskı (EYS.LS.026 listesi A4 dikey); fabrika PC'sinde gerçek kullanım; admin'in
  bu ekranı hangi role açacağına karar vermesi (göçle gelen roller otomatik almadı); yukarıdaki iki dosya
  arasındaki örtüşen kayıtların kullanıcı tarafından nasıl ele alınacağı.

### Planlama yan menüsünde yalnız EYS kodu, resmi listeye göre (2026-11-18, kullanıcı isteği)

Kullanıcı resmi doküman kayıt dosyasını (`ALEN - takip listeleri.xlsx` — LİSTE TAKİP LİSTESİ `EYS.LS.001` ve FORM TAKİP
LİSTESİ `EYS.LS.003` sayfaları) verip iki şey istedi: (1) yan menüdeki ekran açıklamalarının yerine, o ekranın karşılık
geldiği resmi EYS kodu yazılsın ("altlarındaki başlat bitir duruş nedeni gibi yazılar kalksın, orada sadece eys kodu
yazsın"); (2) ekranların bastığı belgelerin İÇİNDE de bu kod görünsün ("belge içinde de yazsın... hangisi nedir diye").

- **Resmi kayıttan doğrulanan YENİ bir eşleme:** İş emirleri ekranı/formu → **EYS.FR.002 "İŞ EMRİ FORMU"** (dosyadan
  önce hiçbir yerde bu kodla anılmamıştı; kayıttaki ad birebir örtüşüyor). `wo-form-pdf.js`'in ürettiği PDF'in alt
  bilgisine eklendi — **sona** eklendi, **başa değil**: `wo-form-pdf.test.js`'teki "İPTAL EDİLDİ formun alt bilgisinin
  İLK sözcüğü olmalı" testi (Türkçe karakter kodlaması tüm alt bilgiyi TEK bir metin gösterme çağrısında taşıdığı için
  belirli bir hex dizgesinin BAŞINDA olmasını sınıyor) koddan ÖNCE eklenince kırıldı; `EYS.FR.002` artık
  `... · Sistemden üretildi · <tarih saat> · EYS.FR.002` biçiminde en sonda.
- **Ürün Tanıtım Kartı'nın basılan kartında (`planning-card.js` `cardHtml`) EYS.FR.001 hiç gösterilmiyordu** — eklendi
  (`"EYS.FR.001 · Sistemden basıldı ..."`, diğer formlarla (GKK/numune/hurda/ölçü föyü/paketleme formu) AYNI "kod ·
  Sistemden basıldı/üretildi" deseni).
- **Diğer tüm basılan belgeler zaten kodu taşıyordu** (kontrol edildi, değişiklik gerekmedi): GKK/ilk onay/numune/
  ölçüm cihazları/takım-pens/hurda liste yazdırmaları (`openListPrint`'in `formNo` parametresi), numune/hurda tekil
  form yazdırmaları, ölçü föyü (`planning-measure.js`), paketleme formu (`planning-packing-form.js` `FORM_NO`).
- **Nav alt yazısı (`dashboard/planning-view.js` TABS `sub` alanı) artık YALNIZ resmi kodu taşıyor**, birden fazla
  belgeye dağılan ekranlarda ikisi birden (`·` ile): `paketleme→EYS.FR.007`, `hurda→EYS.FR.043 · EYS.FR.049`,
  `isemirleri→EYS.FR.002`, `gkk→EYS.FR.011`, `ilkonay→EYS.FR.013`, `numune→EYS.FR.012`, `olcuraporlari→EYS.FR.005`,
  `olcucihazlari→EYS.LS.006`, `bakim→EYS.FR.016`, `takimtakip→EYS.LS.026`, `teknikresim→EYS.LS.007`. Eski açıklayıcı
  metinler SİLİNMEDİ, `hint` alanına taşındı (ekran açılınca başlığın altında görünür; nav'da görünmez).
- **Resmi karşılığı olmayan ekranlarda `sub` BİLEREK BOŞ** (kullanıcı kararı, AskUserQuestion ile netleşti):
  `tezgahbasi` (başlat/bitir EYS.FR.002'ye, kart basma EYS.FR.001'e, ölçü kontrolü EYS.FR.005'e dağılıyor — TEK koda
  indirgenemez; üçü de `hint`'te sayılıyor), `siparisler`, `yenisiparis`, `siparisfisi` (dahili, Dilman kırtasiye
  formu — EYS dokümanı değil, listede karşılığı yok), `hammadde`, `fiyat`, `programlar`, `urunler`, `verimlilik`.
  **`cizelgeleme`'ye BİLEREK dokunulmadı:** resmi listede `EYS.FR.053 "CNC ÜRETİM PLANLAMA FORMU"` (2026-03-03
  yayınlanmış) var ve isim güçlü eşleşiyor, ama kullanıcı emin olmadığı için bağlamamayı seçti — `sub` eski
  açıklamasını (`tezgah önerisi (OR-Tools)`) korudu. **Bu eşleme ileride doğrulanırsa** eklenmesi gereken tek satır
  `TABS` dizisindeki `cizelgeleme` girdisinin `sub` alanı.
- **Kapsam dışı/dokunulmayan:** Bakım (EYS.FR.016) ve Teknik resim takip (EYS.LS.007) ekranlarının "Listeyi yazdır"ı
  zaten yok (CLAUDE.md'de "bilinçli olarak eklenmedi" diye kayıtlı); Paketleme ekranının 3. görünümü olan "Liste"
  (EYS.LS.005, `packing-specs`) ayrı bir nav girdisi DEĞİL (Paketleme sekmesinin içindeki bir iç-görünüm düğmesi),
  bu yüzden `TABS`'ta değişecek bir `sub` yok; kodu zaten dosya başı yorumunda ve ekran içi metinlerde geçiyor.
- **Doğrulama:** `npm test` 833/833 yeşil (yalnızca `wo-form-pdf.test.js`'teki konum testi, EYS kodu sona taşınınca
  düzeldi). Tarayıcıda gerçek dev sunucusuna karşı uçtan uca denendi: `document.querySelectorAll('.mi-main')` ile
  TÜM nav alt yazıları tek tek doğrulandı (plandaki ile birebir); İş emri formu PDF'inin ham baytları Node'da ayrıca
  çözülüp `EYS.FR.002`'nin alt bilginin SONUNDA (hex dizge olarak) gerçekten yazıldığı doğrulandı (PDF metni WinAnsi
  hex dizgesi olarak yazılıyor, düz ASCII değil — bu yüzden basit bir metin arama ilk denemede YANILTICI "bulunamadı"
  sonucu verdi, test dosyasındaki `hexOf()` yöntemiyle doğru doğrulandı). Ürün Tanıtım Kartı önizlemesi tarayıcıda
  açılıp hint metninin doğru göründüğü teyit edildi; kartın kendi alt bilgisindeki `EYS.FR.001` basit bir HTML dizge
  birleştirmesi olduğu için (PDF değil) ayrıca bayt-düzeyinde doğrulamaya gerek görülmedi.
- **DENENMEDİ:** gerçek yazıcıdan baskıda `EYS.FR.001`/`EYS.FR.002`'nin okunabilirliği/konumu; Çizelgeleme↔EYS.FR.053
  eşleşmesinin kullanıcı tarafından teyidi.

### Fiyat çalışması: toplu PDF yükleme + sürükle-bırak + "bekliyor" rozeti (2026-11-18, kullanıcı isteği)

Kullanıcı (fabrika PC'sinin ağına bağlıyken, `192.168.1.50:3000`) iki şey istedi: (1) "Fiyat çalışması" ekranında
teknik resimler **tek tek** değil **toplu** yüklensin — "10 PDF seçsin, liste olarak çıksın, sonra her PDF için isim
girsin"; **yerinde** (ekranın üzerine doğrudan) sürükle-bırak da olsun. (2) Admin yeni bir çalışma yükleyince, bunu
dolduracak "usta"ya **bildirim gibi** bir işaret görünsün — gerçek bir mesaj/push DEĞİL ("direkt mesaj gibi bildirim
gitmesine gerek yok"), yalnız nav'da fark edilir bir şey.

- **Backend değişmedi.** `POST /api/planning/price-studies` zaten tek seferde bir PDF + `title`/`name` alıyordu;
  toplu yükleme TAMAMEN istemci tarafında, bu ucu SIRAYLA (bir dosya bitmeden ötekine geçmeden) çağırarak yapılır —
  yeni bir toplu uç İCAT EDİLMEDİ. Bir dosyanın reddedilmesi (geçersiz PDF, boyut limiti) DİĞERLERİNİ DÜŞÜRMEZ: her
  satır bağımsız dener, başarısız olan satırda "Yeniden dene" tek başına o dosyayı tekrar gönderir.
- **`dashboard/planning-price.js` `openUploadDialog`** (admin) artık tek dosya değil bir **liste** gösterir:
  her satırda dosya adı+boyutu, **düzenlenebilir başlık** (`titleFromName()`: dosya adından öneri — uzantı atılır,
  `_`/`-` boşluğa çevrilir; admin isterse değiştirir), durum (`◔ bekliyor` / `… yükleniyor` / `✓ yüklendi` / `✕ hata`
  + hata metni), "Kaldır" (yüklemeden önce listeden çıkar). Dosya eklemenin İKİ yolu: pencerenin kendi **dropzone**'u
  (`.pl-drop`, sürükle-bırak ya da tıklayıp çoklu dosya seçici) ve ana ekrandan **sürüklenerek** açılan pencere (aşağı
  bakın) — ikisi de AYNI `addFiles()`'tan geçer, aynı ad+boyutlu dosya iki kez eklenmez.
- **"Yerinde" sürükle-bırak (2026-11-18 isteğinin birebir kelimesi):** `renderPriceStudies`'in `host`'una (yalnız
  admin) `dragover`/`drop` dinleyicileri eklendi — PDF'ler **doğrudan listenin üzerine** bırakılınca (ayrıca pencereyi
  açmaya gerek YOK) `openUploadDialog` o dosyalarla AÇILIR. PDF olmayan dosyalar süzülür (`type==='application/pdf'`
  ya da `.pdf` uzantısı); hiçbiri PDF değilse `window.alert` ile uyarır, pencere açmaz.
- **Rozet — "bildirim gibi" (gerçek bir push/mesaj DEĞİL):** `dashboard/planning-view.js` `renderPlanningNav`'a
  eklenen `refreshFiyatBadge`: yalnız `canWrite('fiyat')` olan (usta) için `GET /api/planning/price-studies?
  status=bekliyor&limit=1`'in `total`'ını okuyup **"Fiyat çalışması" nav öğesine kırmızı bir sayı rozeti**
  (`.mi-badge`) basar. Nav sabit kaldığı için (yalnız sekme değişince yeniden çizilir, bkz. `app.js`) zamanlayıcı
  **bir KEZ** kurulur (`nav.dataset.wired` korumasıyla) ve **30 sn'de bir** tazeler — admin başka bir ekrandayken
  yeni bir çalışma yüklese bile usta ekranından ayrılmadan fark eder. **Grup kapalıyken rozet görünmez sorunu da
  çözüldü:** "Fiyat çalışması" `g-uretim` grubunun İÇİNDE; grup kapalıysa (`<details>` açık değilse) rozet DOM'da
  durur ama görünmez — bu yüzden `paintFiyatBadge` ayrıca grup başlığına (`.mi-grp-h`) küçük bir **nokta**
  (`.mi-grp-dot`) ekler, grup kapalıyken de "orada bekleyen bir şey var" belli olsun diye. İkisi de sayı/nokta
  0 olunca kendiliğinden kalkar.
- **Doğrulama:** `npm test` 833/833 yeşil (backend hiç değişmedi, bu tamamen dashboard/JS+CSS). Tarayıcıda gerçek
  dev sunucusuna (AUTH_DISABLED) karşı uçtan uca denendi: (a) sürükle-bırak ile iki dosya bırakılınca pencere o
  dosyalarla açıldı, her satırda dosya adından türetilen başlık önerisi doğru çıktı; (b) GERÇEK (geçersiz PDF
  içerikli) dosyalarla "Hepsini yükle" denendi → ikisi de `✕ hata "PDF kabul edilmedi: ..."` ile beklendiği gibi
  reddedildi, özet uyarı satırı ve "Yeniden dene" doğru göründü; (c) GERÇEK GEÇERLİ iki PDF (bu oturumda Node'da
  `backend/pdf-merge.js`'in kendi xref/offset deseniyle elle üretilip doğrulanmış minik bir PDF) ile tekrar denendi
  → ikisi de `✓ yüklendi`, API'den `title`'ların dosya adından doğru türetildiği (`REAL-TEST-ALPHA.pdf` →
  `"REAL TEST ALPHA"`) teyit edildi; (d) dialog kapanınca ana liste 2 kayıtla tazelendi VE **"Fiyat çalışması" nav
  rozetinde "2" ile "ÜRETİM" grup başlığında kırmızı nokta** gerçekten belirdi; (e) iki test kaydı `DELETE` ile
  silinince rozet ve nokta kendiliğinden kalktı. Test kayıtları temizlendi, gerçek veri bırakılmadı (bu özellik
  için gerçek bir PDF yüklenmedi — yalnız sentetik test verisiyle, hepsi silindi).
- **DENENMEDİ:** tarayıcının native dosya seçiciyle gerçek çoklu PDF seçimi (bu oturumda da, projedeki diğer çoklu
  dosya seçimi özellikleriyle aynı bilinen sınır — yalnız `DataTransfer`/`drop` olayı programatik olarak
  simüle edilerek test edildi, gerçek OS dosya seçici/gerçek sürükle-bırak hiç sürülemedi); 10+ dosyalık gerçek
  bir toplu yüklemenin süresi/kullanılabilirliği; rozetin 30 sn'lik tazeleme aralığının fabrika kullanımında
  yeterli/rahatsız edici olup olmadığı.

**Dolduruldıktan sonra da düzenlenebilir (aynı gün, kullanıcı isteği: "kaydettikten sonra düzenlenebilsin"):**
`dashboard/planning-price.js` `openDetailDialog` eskiden `p.status === 'bekliyor'` şartıyla formu bir KERE
gösterip sonra salt metne ("Dolduruldu: ...") dönüyordu — usta bir kez kaydedince hammadde/süre/not yanlış girilse
bile düzeltilemiyordu. Backend (`price-studies.js` `fill()`) zaten durum kontrolü yapmıyordu (yeniden çağırmayı hiç
engellemiyordu, yalnız `filled_at/filled_by` en son düzenleyene göre güncellenir) — bu yüzden **yalnız frontend
değişti**: `yazabilir` artık yalnız `canWrite('fiyat')` (duruma bakmaz), form HER ZAMAN gösterilir ve doluysa
değerler ÖNCEDEN DOLU gelir; gönder butonu ilk doldurmada "Kaydet", sonraki düzenlemelerde "Güncelle" yazar. Liste
satırındaki düğme de "dolduruldu" durumunda "Aç" yerine **"Düzenle…"** olur (yazabilen rol için). Salt-okunur
(yazamayan) roller değişmedi: dolu kaydı hâlâ yalnız metin olarak görür.
- **Doğrulama:** backend değişmediği için `npm test` 834/834 (sayı değişmedi). İzole bir test sunucusunda (geçici
  `PLANNING_DB_FILE`, gerçek dev veritabanına dokunulmadı) tarayıcıda uçtan uca denendi: gerçek bir PDF yüklendi →
  "Doldur…" ile ilk kayıt girildi (hammadde/süre/not) → liste "dolduruldu" + "Düzenle…" oldu → tekrar açılınca form
  aynı değerlerle ÖNCEDEN DOLU geldi, buton "Güncelle" yazdı → değerler değiştirilip kaydedildi → liste YENİ
  değerleri gösterdi. Test sunucusu/geçici veritabanı ve test PDF'i oturum sonunda tamamen silindi.
- **DENENMEDİ:** fabrika PC'sinde gerçek kullanım; aynı anda iki kişinin aynı kaydı düzenlemesi (son kaydeden
  kazanır, çakışma uyarısı yok — kasıtlı basit tutuldu, zaten tek bir ustanın doldurduğu bir ön-çalışma kaydı).

**Listede "Not" sütunu (2026-11-19, kullanıcı isteği):** ekran görüntüsünde listenin kalabalık göründüğünü, bir kaydın notu olup
olmadığını görmek için her satırı tek tek açmanın gerektiğini belirtti — "hepsinin içine girip açıklama var mı diye bakmakla
uğraşılmasın". `note` zaten `list()`'in döndürdüğü alanlardan biriydi (backend hiç değişmedi), yalnız ekranda hiç gösterilmiyordu.
`dashboard/planning-price.js` `draw()`'a **"Not"** sütunu eklendi (Süre ile Yüklendi arasında): not doluysa ortalanmış **✓** (hücrenin
`title`'ında tam metin — üzerine gelince görülür, açmaya gerek kalmadan), boşsa soluk **—** (`is-null`, CLAUDE.md §7 "okunamayan alan
görsel olarak ayırt edilir" kuralıyla aynı). Yeni, genel amaçlı `.tbl td.ctr,.tbl th.ctr{text-align:center}` yardımcı sınıfı eklendi
(`styles.css`, `.num`'un sağa-yaslama kardeşi) — ileride başka bir ekranda da tek-ikonluk bir sütun gerekirse yeniden kullanılabilir.
**Doğrulama:** backend değişmediği için `npm test` 871/871 (sayı değişmedi). İzole bir scratch sunucuda (geçici `PLANNING_DB_FILE`,
gerçek dev veritabanına dokunulmadı) iki test kaydı açılıp biri notlu biri notsuz dolduruldu; tarayıcıda listede notlu satırda ✓ +
hover'da tam not metni, notsuz satırda soluk — göründüğü doğrulandı. Scratch sunucu/dosyalar oturum sonunda tamamen silindi.
**DENENMEDİ:** fabrika PC'sinde gerçek kullanım.

### İş emrinde bitmiş adedi düzeltme — GEÇİCİ ÖZELLİK (2026-11-18, kullanıcı isteği)

Kullanıcının kendi tarifi: "İş emirlerinde adet düzeltme kısmına bitirdikten sonra da adet düzeltebiliyor olmak
lazım... bu geçici depoda yaratma akışına ters oluyor ama şu anda geçici depoda ürün yaratmıyor ya iş emrinini
bitirince... o yüzden bir oryantasyon süreci var yanlış girebiliyorlar şimdilik iş emri bittikten sonra da adetleri
düzenleyebilelim mikrodaki ürün akışını açınca kaldırırız." Yani: ustalar sistemi yeni kullanıyor ve "Bitir"
ekranında (elle adet override, zaten yalnız yönetici) yanlış adet girebiliyor; şimdiye kadar düzeltmenin tek yolu
**"Üretime geri al" + yeniden "Bitir"** idi (tezgahın o anki canlı sayacına göre yeniden hesaplar — geriye dönük bir
adet DÜZELTMESİ için uygun değil, tezgah telemetri olmadan ya da farklı bir sayaçla yeniden "bitirmek" gerekirdi).

- **Kasıtlı olarak GEÇİCİ:** bitmiş ürün depo akışı (`product-depot.js`, §6 "Bitmiş ürün depo akışı") iş emri
  bitince `result.produced`'ı okuyup (admin "Geçici depoya aktar…" ile elle tetiklediğinde) Mikro'ya gönderiyor;
  bu akış `PRODUCT_DEPOT_ENABLED` ile hâlâ KAPALI (fabrika PC'si/paketleme henüz sahada değil) olduğu için adedi
  dondurulmuş sonuçta doğrudan değiştirmek şimdilik risksiz. **O akış açılınca bu özellik KALDIRILMALI ya da
  kısıtlanmalı** (bkz. §10): düzeltilen adet, Geçiciye ZATEN gönderilmiş bir miktarı geriye dönük değiştiremez
  (`sendFinishTransfer`'ın delta'sı azalışta "zaten aktarıldı" der, negatif göndermez — ama Mikro'daki o eski,
  artık yanlış miktar kendiliğinden düzelmez).
- **Backend:** `backend/planning/planning.js` `correctFinishedQty(no, {qty, note?})` — yalnız `bitti` durumunda;
  adet 0–10.000.000 tam sayı, aynı değerle çağrılırsa reddedilir. `result_json`'daki `produced` YERİNDE güncellenir
  (diğer dondurulmuş alanlar — `from/to/cycle/programs/shifts/sample/warnings` — dokunulmaz); tamamen elle
  bitirilmiş (`finishWorkOrderManually`, `source:'elle'`) bir kayıtta `source` aynen `'elle'` kalır, telemetriden
  gelen/elle-adetli bir kayıtta `source:'elle-adet'` olur ve İLK (hiç düzeltilmemiş) adet `telemetryProduced`'da
  korunur (zincirleme düzeltmelerde bile değişmez — `finishWorkOrder`'ın kendi `elle-adet` override'ıyla AYNI alan,
  yeni bir alan İCAT EDİLMEDİ). Hedef sapması uyarısı (`finishWorkOrder` ile aynı metin) ve Geçiciye zaten
  gönderilmiş bir miktar varsa onu da bildiren bir uyarı döner (bilgi amaçlı, engellemez).
  **Hammadde rezervasyonu/tüketimi ve Mikro depo akışı YENİDEN HESAPLANMAZ** — bu düzeltme bilerek yalnız
  görüntülenen/raporlanan ÜRETİM ADEDİNİ düzeltir, finiş anındaki hammadde tüketimine dokunmaz (kapsam bilerek dar
  tutuldu: amaç veri-giriş hatasını hızlıca düzeltmek, finansal/stok kayıtlarını yeniden oynatmak değil).
- **Yetki:** `isemirleri` ekranı yapısal olarak `writable:false` (§6 "Esnek rol sistemi") — bu uç da `reopen`/
  `reassign-machine`/`finish-manual` ile AYNI desenle `policy.js`'e HİÇ KAYDEDİLMEDİ, varsayılan reddetten admin'e
  düşer. `POST /api/planning/work-orders/:no/correct-qty {qty, note?}`.
- **Arayüz:** `dashboard/planning-workorders.js` `openWorkOrderDialog` — bitmiş iş emrinde "Üretime geri al…"in
  yanına **"Adedi düzelt…"** (yalnız admin bu dialogu zaten açabiliyor); açılan kutuda şimdiki adet önceden
  doldurulmuş, yeni adet + isteğe bağlı not; kaydedince iş emri YERİNDE yeniden çizilir (liste/ilerleme/geçmiş hemen
  günceli gösterir), varsa uyarılar `window.alert` ile gösterilir. Geçmişte `adet-duzeltildi` → "adet düzeltildi".
- **Doğrulama:** `backend/planning/lifecycle.test.js`'e yeni test (durum/değer/tip doğrulamaları, zincirleme
  düzeltmede `telemetryProduced`'ın ilk değerde sabit kalması, `source:'elle'` kaydında değişmemesi, iptal edilmiş
  iş emride reddedilmesi) + `backend/auth/policy.test.js` (`correct-qty` admin-only). `npm test` 834/834 yeşil.
  **İzole bir test ortamında (gerçek sunucu süreci, geçici/boş `PLANNING_DB_FILE`, gerçek dev veritabanına HİÇ
  DOKUNULMADI) tarayıcıda uçtan uca denendi:** sentetik bir iş emri oluşturulup başlatıldı, elle adet=3 ile
  bitirildi, "Adedi düzelt…" ile önce 8'e (hedefin üstünde uyarısı), sonra 4'e (hedefin altında uyarısı)
  düzeltildi; liste ("4 · %80"), ilerleme çubuğu ve geçmiş listesi ("8 → 4 adet · tarayıcıdan test") hepsi doğru
  güncellendi. Test sunucusu/geçici veritabanı oturum sonunda tamamen silindi.
- **DENENMEDİ:** fabrika PC'sinde/gerçek kullanımda; Geçiciye zaten gönderilmiş bir iş emrinde düzeltme yapılıp
  sonra tekrar "Geçici depoya aktar…" denendiğinde gerçek Mikro'ya karşı davranış (yalnız kod okumayla ve uyarı
  metniyle sağlandı, `PRODUCT_DEPOT_ENABLED`/Mikro bu oturumda hiç açılmadı).

### İlk onay etiketi — A5 yapışkan etiket, numara alınınca otomatik basılır (2026-11-18, kullanıcı isteği)

Kullanıcının kendi tarifi: "bir tezgaha her yeni ürün bağlandığında 2 ürün alınıyor, çıkan ürünler içinden bunlar
ayrılıyor ve saklanıyor, bunların üstüne sticker yapıştırılıyor" — üretimden ayrılan bu 2 numune/ilk baskı
parçasına yapıştırılan fiziksel etiketin kendisi. Fotoğrafla verilen kâğıt etiketin alanları (TARİH, İLK BASKI/
NUMUNE NO, MÜŞTERİ ÜRÜN KODU, İŞ EMRİ NO, GKK RAPOR NO, OPERATÖR İSMİ, CNC NO) **EYS.FR.013'ün (İlk Baskı Onay /
Numune Takip Listesi) kendi alanlarıyla birebir aynı** — ayrı bir kayıt/kod/form İCAT EDİLMEDİ, bu zaten var olan
`first_approvals` kaydının tek-kayıtlık, A5 yapışkan-etiket görünümü. İstenen davranış: "ilk onay numarası
alındıktan sonra bunun pop upı çıksın, çıktısını alsın direkt" — numara alma akışı (Tezgah başı'ndaki "İlk onay
numarası al", "İş emrini düzenle"'deki "Numara al…", "İlk onay raporu" ekranındaki "İş emrinden numara al…" — **üçü
de AYNI paylaşılan `createFirstApproval` fonksiyonunu çağırıyor**, tek yeri değiştirmek hepsini kapsadı) artık
numara alınır alınmaz etiketi gösterir ve otomatik yazdırır.

- **Gerçek bir hata bulunup düzeltildi (bu özelliği eklerken fark edildi, kullanıcı bildirmedi):** "İlk onay
  raporu" listesindeki/basılan EYS.FR.013 formundaki **"CNC NO" sütunu HER SATIRDA HER ZAMAN BOŞTU** — `quality.js`
  `listApprovals()` kayıtları `#approvalView()`'den (yalnız `cncNo: machineNumber(a.machineId)` HESAPLAYAN yer)
  GEÇİRMİYORDU; `machineId` doluydu ama görünen `cncNo` asla hesaplanmıyordu. Tek kayıt okuma/oluşturma (`createApproval`,
  `updateApproval`) zaten doğruydu, yalnız LİSTE etkilenmişti. Düzeltildi: liste de `#approvalView()`'den geçer.
- **MÜŞTERİ ÜRÜN KODU, `cncNo` ile AYNI ilkeyle TAZE hesaplanır, kayıtta SAKLANMAZ** (kartın/kasanın "GKK rapor no"
  ve "İlk onay no" alanlarıyla AYNI felsefe, CLAUDE.md §6 "İLK ONAY NO" notu: donmuş bir anlık görüntü değil, O
  ANKİ değer): `quality.js` `#approvalView()` — iş emri bağlıysa (`a.woNo`) `w.customerCode` (iş emrinin zaten
  `resolveCustomerCode` ile çözülmüş alanı), yoksa (elle kayıt, yalnız ürün kodu) ürün kartından AYNI şekilde
  çözülür (`this.planning.db.getProduct` + `resolveCustomerCode`); ürün kartı da yoksa `null` (asla 0/boş string,
  CLAUDE.md §7 "okunamayan alan null" kuralı).
- **Etiket HTML'i:** `dashboard/planning-approvals.js` `approvalLabelHtml(a)` — Ürün Tanıtım Kartı'yla
  (`planning-card.js` `cardHtml`) **AYNI** `.pl-card`/`.pl-c-table`/`page:kart` CSS'i (A5, 8mm kenar boşluğu)
  yeniden kullanılır, yeni bir stil İCAT EDİLMEDİ (kullanıcının "ürün tanıtım kartıyla aynı boyutu" sözü bunu
  doğrudan istiyordu). Alt bilgi "EYS.FR.013 · Sistemden basıldı …" (diğer tüm basılan formlarla aynı desen).
- **Otomatik popup + yazdırma:** `createFirstApproval()`'ın başarı ekranı artık yalnız metin değil, etiketin
  KENDİSİNİ gösterir ve `setTimeout(printModal, 80)` ile Ürün Tanıtım Kartı'nın "Kartı oluştur ve yazdır" akışıyla
  BİREBİR aynı desende otomatik yazdırma tetikler; "Yeniden yazdır" düğmesi manuel tekrar basım için kalır
  (yazıcı/çıktı kaçırılırsa). Pencere `pl-form-dlg` sınıfını (ekranın geri kalanını gizleyip yalnız etiketi basan
  `body.pl-printing` CSS'i için) fonksiyonun BAŞINDA alır, yükleme/seçim ekranlarında da zararsız durur.
- **Doğrulama:** `backend/planning/quality.test.js`'e yeni assertionlar (iş emri bağlıyken `customerCode` ürün
  kartından TAZE çözülür; elle kayıtta da aynı; ürün kartı yoksa `null`, patlamaz; liste artık `cncNo`/`customerCode`
  taşır — bulunan hatanın regresyon testi). `npm test` 834/834 yeşil. **İzole bir test ortamında (gerçek sunucu
  süreci, geçici/boş `PLANNING_DB_FILE`, gerçek dev veritabanına HİÇ DOKUNULMADI) tarayıcıda uçtan uca denendi:**
  Tezgah başı'ndan gerçek bir iş emri için "İlk onay numarası al" → operatör adı girildi → numara alındı (İ26-001)
  → popup anında etikete döndü, 7 satır da (TARİH, İ26-001, gerçek müşteri kodu 601999999, iş emri no, GKK rapor
  no, operatör adı, CNC no 5) doğru çıktı; "Yeniden yazdır" hatasız çalıştı; "Kapat" ile pencere kapandı; Tezgah
  başı kartında "İlk onay: İ26-001" göründü; "İlk onay raporu" listesinde **CNC NO sütunu artık doğru "5" gösterdi**
  (önceki hatanın düzeldiği teyit edildi). Test sunucusu/geçici veritabanı oturum sonunda tamamen silindi.
- **DENENMEDİ:** gerçek yazıcıdan/etiket yazıcısından A5 baskı (sticker kâğıdına gerçek çıktı — ürün tanıtım
  kartının kendisi de aynı şekilde yalnız ekran/PDF görüntüleyicide doğrulanmıştı); fabrikada gerçek yapışkan
  etiket kâğıdıyla fiziksel kullanım; "İş emrini düzenle"/"İlk onay raporu" ekranlarındaki diğer iki giriş noktası
  (aynı paylaşılan fonksiyonu çağırdıkları için davranışları aynı olmalı, ama tek tek tıklanarak denenmedi).

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
| `backend/planning/` · `dashboard/planning-*.js` · `PLANLAMA-TASARIM.md` | Planlama uygulaması (A, B, C, T aşamaları): `downtime.js` (duruşlar), `config/downtime-codes.json` + `shared/downtime-codes.js` (neden kodları), `planning-db.js` (SQLite), `importers.js`/`csv-read.js` (Excel CSV), `program-map.js` (eşleme önerisi), `calc.js` (iş emri hesapları), `progress.js` (gerçekleşen üretim: telemetri olaylarından adet/vardiya/süre, saf hesap), `planning.js` (doğrulama, eşleme, iş emri yaşam döngüsü), `routes.js`; ekranlar Tezgah başı (`planning-shop.js`, operatör), Verimlilik (`planning-efficiency.js`, `efficiency.js` hesapları), Hammadde (`planning-material.js`, `material.js` hesapları; Mikro depo transfer/virman `mikro-stock.js`; yanlış teslimatta hammadde karantinası `material-quarantine.js`, §6 "Hammadde karantinası"), Bitmiş ürün depo akışı (`planning-depot.js`, `product-depot.js`; §6 "Bitmiş ürün depo akışı"), Ölçü kontrolü (`planning-measure.js`, `measure.js` saf hesapları), Paketleme (`planning-packing.js`), ürün tanıtım kartı ve iş emrindeki kasa paneli (`planning-card.js`, işlem kutuları `card-steps.js`), İş emirleri (`planning-workorders.js`, canlı üretim paneli ve başlat/bitir pencereleri `planning-production.js`, yazdırılabilir form + arka sayfa `planning-wo-form.js`) · Sipariş fişi (`planning-supply-requests.js`, `supply-requests.js`; atölye malzeme/takım talebi, bekliyor/verildi/geldi, §6 "Sipariş fişi") · GKK rapor no (`planning-gkk.js`, `gkk.js`; kalite raporu PDF klasörü `gkk-folder.js` + `planning-gkk-folder.js`) · İlk onay raporu (`planning-approvals.js`, `first-approval.js`) · teknik resim PDF'leri (`planning-drawings.js`, `backend/pdf-merge.js`) · iş emri formu PDF'i (`wo-form-pdf.js`) · Ölçü raporları (`planning-reports.js`) · Çizelgeleme (`planning-schedule.js`, hesaplar `schedule.js` + `optimizer/schedule_solver.py`, bkz. aşağıdaki `optimizer/` satırı) · Numune takip (`planning-numune.js`, `sample-tracking.js`; sabit müşteri grubu listesi `sample-customer-groups.js`, tezgaha bağlama + yeni ürün kodu oluşturma + Mikro yazma §6 "Tezgaha bağlama + YENİ ürün kodu oluşturma", hammadde seçimi (Mikro canlı arama, dar uç) + teknik resim ekleme §6 "Numune formunda hammadde seçimi…") · Hurda girişi (`planning-hurda.js`, `quarantine.js`; karantina giriş-çıkış EYS.FR.043 + tashih EYS.FR.049, iş emri bağlantısı + Mikro Karantina deposu `quarantine-depot.js`, §6 "Hurda Girişi") · Ölçüm cihazları takip (`planning-devices.js`, `measuring-devices.js`; mastar/kumpas/mihengir envanteri + kalibrasyon, EYS.LS.006, §6 "Ölçüm Cihazları Takip") · Bakım (`planning-maintenance.js`, `maintenance.js`; makine tipi → bakım kalemi (periyot admin ayarlar) → makine başına tik/rutin-arızi geçmişi, EYS.FR.016 + Bakım Sicil Kartları, §6 "Bakım") · Teknik resim takip (`planning-drawing-tracking.js`, `drawing-tracking.js`; her ürünün resim durumu/rev no/tarihleri, EYS.LS.007, §6 "Teknik Resim Takip") · Takım ve Pens Takip (`planning-tool-inventory.js`, `tool-inventory.js`; takım/pens/uç/tutucu envanteri, kategori serbest metin, EYS.LS.026, §6 "Takım ve Pens Takip") · Fiyat çalışması (`planning-price.js`, `price-studies.js`; toplu PDF yükleme + sürükle-bırak + "bekliyor" rozeti, §6 "Fiyat çalışması: toplu PDF yükleme") · Yeni siparişler (`planning-incoming-orders.js`, `incoming-orders.js` + `pdf-table.js` + `backend/planning/pdf-text.js` + `ocr.js` (Tesseract OCR, taranmış sayfalar için); mail'den gelen PDF/e-posta tablosu → taslak satır, göster-onayla, Mikro'ya yazma `mikro-order.js` (SiparisKaydetV2; ARAŞTIRILDI, GERÇEK DENENMEDİ) ile ARAŞTIRILDI, §6 "Mail'den otomatik sipariş girişi") · rol/sekme tablosu (`planning-tabs.js`) · Ürünler · Siparişler · Program eşleme. Tasarım ve sonraki aşamalar (telemetri bağlantısı, hammadde, verimlilik, tablet): `PLANLAMA-TASARIM.md`. Testler: `backend/planning/*.test.js`. |
| `backend/planning/packing.js` · `dashboard/planning-packing-form.js` | Paketleme formu (EYS.FR.007): vardiya sayfası, satırlar, hava basıncı, koli içi adet öğrenme/öneri, yazdırma. Bkz. §6 "Paketleme formu". |
| `backend/planning/packing-specs.js` · `dashboard/planning-packing-list.js` | Paketleme listesi (EYS.LS.005): koli boyutu/kasa özelliği/kat sayısı/koli içi adet/koli etiketi/koli ağırlığı referans kaydı, Paketleme ekranının "Liste" görünümü. Bkz. §6 "Paketleme listesi (EYS.LS.005)". |
| `backend/planning/doc-folder.js` · `dashboard/planning-docs.js` | Teknik resim klasörü ve etiket klasörü (iki ayrı `DocFolder`): dosyaları ürün koduna göre ürün kartlarına bağlama, eşle penceresi. Bkz. §6 "Teknik resim klasörü ve Etiket klasörü". |
| `backend/planning/sources.js` · `dashboard/planning-sources.js` | Kaynak klasörü: Mikro/GKK Excel dosyalarını sabit klasörden okuyup değişenleri uygulama ("Kaynak dosyadan yenile"), klasör ayarı ve sonuç penceresi. Bkz. §6 "Kaynak klasörü". |
| `dashboard/library-view.js` | Program kütüphanesi ekranı, tezgah detayındaki "Programlar" paneli ve gönderme penceresi. |
| `dashboard/editor-view.js` · `diff.js` | Program editörü (satır numaralı metin, inceleme/diff, "kaydet" / "kaydet ve gönder") ve saf satır farkı (`backend/diff.test.js` sınar). |
| `dashboard/bulk-import-view.js` · `delete-view.js` · `diff-render.js` | Toplu alım penceresi (plan, çakışma kararları, uygula) · tornadan silme penceresi · ortak satır farkı tablosu (editör ve çakışma ekranı kullanır). |
| `dashboard/bulk-push-view.js` · `tools/torna-test/ezme-testi.ps1` | "Toplu gönder" penceresi (plan, inceleme/onay, ilerleme + durdur, sonuç; kütüphaneden tornaya, yedekleyerek ezer) · gerçek tornada yan ada alma/silme/ezme davranışını güvenle ölçen test betiği (yalnız `ZZTEST…` dosyaları). Bkz. §6 "Toplu gönderme". |
| `dashboard/library-delete-view.js` | "Kütüphaneden sil" penceresi (tek/çoklu; onay = ad ya da sayı; kopyası olan tezgahları gösterir). |
| `dashboard/library-rename-view.js` | "Adını değiştir" penceresi: kütüphane kaydı + (varsa) kopyası olan tezgahlardaki dosyanın adı (FTP RNFR/RNTO; onay = tezgah kimliği ya da sayısı). Bkz. §6 "Tornadaki dosyanın adı da değiştirilir". |
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
| `optimizer/schedule_solver.py` | Çizelgeleme/optimizasyon: CP-SAT çözücü (ayrı Python süreci, bağımlılığı yalnız `ortools`; stdin/stdout JSON). Kendi testi `test_schedule_solver.py` (elle, `python -m unittest`). |
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
| `GET /api/planning/packing/specs?q=&limit=&offset=` · `PUT packing/specs/:kod` · `POST packing/specs/import` | **Paketleme listesi** (EYS.LS.005, §6): koli boyutu/kasa özelliği/kat sayısı/koli içi adet/koli etiketi/koli ağırlığı referans kaydı, `paketleme` ekranının "Liste" görünümü — liste (okuma), düzenle (yazma; satır yoksa oluşturulur), Excel'den içeri aktar (gövde = ham `.xlsx`, kayıtsız → admin). |
| `/api/planning/drawing-folder` · `sticker-folder` (GET) · `…/dir` (PUT) · `…/match` (POST) · `/api/planning/product-files/:id` (GET/DELETE) | **Teknik resim / etiket klasörü** (yalnız admin; `product-files/:id` GET operatör + yönetici, DELETE yönetici): klasör ve dosya durumu · klasörü ayarla (`{dir}`) · dosyaları ürün koduna göre eşle (`{update?}`; yanıt: bağlananlar, eşleşmeyen/kabul edilmeyen dosyalar, hâlâ dosyası olmayan ürünler) · ürüne bağlı dosyayı indir/kaldır. |
| `/api/planning/sources` (GET) · `sources/dir` (PUT) · `sources/refresh` (POST) | **Kaynak klasörü** (yalnız admin): klasör + dosyaların durumu (yeni/değişmiş/güncel) · klasörü ayarla (`{dir}`, boş = varsayılan `data/kaynak`) · klasörü oku ve değişenleri uygula (`{force?}`; yanıt: dosya durumları, toplamlar, `changes` listeleri). |
| `/api/planning/summary` · `products[/:kod]` · `import` · `orders[/lines]` · `programs[/map\|/confirm-exact\|/product-search]` | **Planlama** (yalnız admin; **`programs*` uçları 0.17.2'den beri operatöre de açık**, `programs/product-search` dar ürün araması): özet · ürün kartı listesi/arama, oluştur (POST), düzenle (PUT) · Excel içeri alma: `.xlsx` (tüm sayfalar taranır) ya da CSV (gövde = ham dosya, tür içerikten anlaşılır, `?filename=&keepOld=1`) · siparişler (`?q=&open=1`) ve bir siparişin satırları · tornalarda görülen programlar ve eşleme durumu, eşle (PUT), kaldır (DELETE), toplu onay (POST; gövde `{kind?}` — vars. `'kod'` stok koduyla birebir, `'musteri-kodu'` müşteri koduyla tek adaylı önerileri onaylar). |
| `GET/POST /api/planning/supply-requests` · `supply-requests/:id` (GET/PUT/DELETE) · `.../:id/order\|receive\|back` (POST) | **Sipariş fişi** (atölye malzeme/takım talebi, §6 "Sipariş fişi"; `products` ile bağlanmaz): liste/arama (`?q=&status=`), yeni fiş (`{requestedBy, requestedOn?, note?, lines:[{qty, item, brand?}]}`, en az bir kalem), ayrıntı/düzenle (`lines` gönderilirse TÜMÜ değişir)/sil (admin), durum ilerlet ("sipariş verildi"/"teslim alındı") / bir adım geri al. |
| `GET /api/planning/incoming-orders[/:id]` · `incoming-orders/product-search?q=&limit=` · `POST incoming-orders/pdf?kind=&filename=` · `incoming-orders/email-table?kind=&filename=` · `PUT incoming-orders/lines/:id` · `incoming-orders/lines/:id/approve\|reject` | **Yeni siparişler** (`yenisiparis` rolü): mail'den gelen PDF/e-posta tablosundan TASLAK çıkarır (`kind`: `yeni`\|`revizyon`; PDF'ten fiyat da çıkarılır — `price`); `pdf` gövde = ham PDF, `email-table` gövde = ham HTML (tabloyu yapıştırırken `clipboardData.getData('text/html')`); `PUT lines/:id {qty?,deliveryDate?,custOrderNo?,price?,stockCode?}` bekleyen satırı düzeltir (onaydan önce HER alan düzenlenebilir, §6 "Fiyat çıkarma + her alan düzenlenebilir"); taslak satırı eşleşmiş ürünle (`stockCode`) ya da elle onayla/reddet; dar ürün araması (`programs/product-search`'ün kopyası değil, bu ekranın kendi yetkisinden geçer). **Onaylanana kadar Mikro'ya hiçbir şey yazmaz.** |
| `GET /api/planning/incoming-orders/mikro/customers?q=&limit=` · `incoming-orders/lines/:id/mikro-customer` · `POST incoming-orders/lines/:id/mikro-preview\|mikro-send` · `incoming-orders/:id/mikro-customer` (GET) · `POST incoming-orders/:id/mikro-preview\|mikro-send` | **Mikro'ya sipariş yazma** (SiparisKaydetV2; GERÇEK YAZMA BAŞARILI — §6 "Mikro'ya YENİ sipariş yazmak" + "Hepsi TEK siparişte"; kayıtsız, yalnız admin): müşteri ara (CARI_HESAPLAR) · satırın (`lines/:id`) ya da **taslağın TÜM onaylı satırlarının** (`:id`, tek evrak/çok kalem) ürününden müşteriyi otomatik çöz (farklı müşteriye çıkarsa 409 `multiple-customers`) · önizle/gönder (`{customerCode?, unitPriceValue?, note?}`; `mikro-send` `MIKRO_WRITE_ENABLED=1` olmadan 409 `mikro-write-disabled`). |
| `/api/planning/downtime-codes` · `shop/overview` · `shop/stops?machine=&hours=` · `shop/downtime-reasons` (POST) · `shop/downtime-reasons/:id` (DELETE) | **Fabrika PC'si / Tezgah başı** (operatör + yönetici): duruş nedeni kodları ve grupları · tezgah başına canlı durum, üretimdeki iş emri, bekleyenler, nedeni sorulmamış duruşlar · bir tezgahın ölçülmüş duruşları ve nedenleri · duruşa neden bağla (`machineId, from, to, code, note?, person?`) · nedeni kaldır. |
| `/api/planning/efficiency[.csv]` · `downtime-report[.csv]` | **Verimlilik ve duruş raporları** (yalnız admin): `?from=&to=&machine=` (varsayılan bu ay); verimlilik özeti/matris/günlük satırlar/ürün/gün/tezgah ve termin riski; duruş neden dakikaları ve nedeni belirsiz; CSV `&view=gunluk\|matris\|urun\|tezgah` ve `durus\|durus-kod-gun`. |
| `POST /api/planning/schedule/suggest` · `schedule/apply` | **Çizelgeleme önerisi** (OR-Tools CP-SAT, yalnız admin; ASLA otomatik uygulanmaz): bekleyen iş emirlerini tezgahlara önerir (gövde yok) · onaylanan atamaları işler (`{assignments: [{no, machineId}]}` → `{applied, skipped}`; başlamış iş emri sessizce atlanır). |
| `/api/planning/material/need` · `material/consumption[.csv]` · `material/fis` (POST) · `material/fis/undo` (POST) | **Hammadde ve sarfiyat** (yalnız admin): ihtiyaç (planlanan + üretimdeki kalan adet) · gerçekleşen sarfiyat (biten iş emirleri, `?from=&to=&fis=`; CSV `&view=is-emri\|hammadde`) · Mikro sarfiyat fişi "elle girildi" işareti (`orders[], docNo?, kg?, note?`) ve geri alma. |
| `GET/POST /api/planning/material/quarantine` · `quarantine/:id/retry-transfer` (POST) · `quarantine/:id/return` (POST) · `quarantine/:id` (DELETE) | **Hammadde karantinası** (yanlış teslimat, §6 "Hammadde karantinası"): liste (`?status=`) · "Karantinaya aktar" (`{stockCode, stockName?, kg, note?}`, 201; Merkez(1)→Karantina(5) sevk fişini hemen dener) · başarısız sevkiyatı yeniden dene · "İade et" (Karantina'daki TAM miktarı sarf/virman ÇIKAN ile düşer) · sil (Karantina'da gerçekten duran kayıt silinemez). Hepsi `hammadde:yazabilir` (silme dahil). |
| `GET /api/planning/work-orders/:no/depot-status` · `POST .../depot/finish-transfer` · `POST .../depot/packing-transfer` | **Bitmiş ürün depo akışı** (Merkez↔Geçici, Mikro; yalnız admin, §6): durum (üretilen/aktarılan, paketlenen/sevk edilen) · iş emri bitince Merkez→Geçici (gönderilmemiş kısım) · paketlenince Geçici→Merkez (DELTA). `MIKRO_WRITE_ENABLED` olmadan 409 `mikro-write-disabled`, hiçbir şey yazılmaz. |
| `/api/planning/work-orders/:no/cards` (POST) · `work-orders/:no/fields` (POST) | **Ürün tanıtım kartı bas** (tek adım; operatör + yönetici; gövde `{person?, gkkReportNo?, steps?}`: `steps` = yıkama/kurutma/tavlama kutuları) ve **tezgah başından iş emri alanı düzenleme** (ilk onay rapor no, ölçülen net gramaj, GKK rapor no, kullanılan hammadde, açıklama). |
| `/api/planning/work-orders/:no/measurements` (GET/POST) · `work-orders/:no/measure-plan` (PUT) · `crates/:id/sheet` (GET) | **Ölçü kontrolü** (operatör + yönetici): plan + sütunlar, saatlik ölçüm kaydı, kartın föyü. |
| `/api/planning/crates` · `crates/:id` · `crates/:id/close\|pack\|void` · `work-orders/:no/crates` (POST) · `crates/sequence` (PUT, yönetici) | **Kasa / Ürün Tanıtım Kartı** (operatör + yönetici): kasalar (`?woNo=&machine=&state=`), kasa + kart bilgileri, kapat (`person?`), paketleme adedi (`qty, person?`), iptal (`reason`), iş emrinde yeni kasa aç (kart numarasını sistem verir), kart numarası sırası tabanı (`last`). |
| `/api/planning/gkk` (GET/POST) · `gkk/sequence` (PUT) · `gkk/:id` (PUT/DELETE) | **GKK rapor numaraları** (EYS.FR.011): liste/arama (`?q=&erpMaterial=&stockCode=`; `matches[]` iş emri hammaddesine uyanlar, `match`: `tam`/`islemli`/`urun`; liste öğeleri `fileCount` taşır — kalite raporu PDF'i), yeni numara (POST), düzenle/sil, numara tabanı. **Okuma: herkes (izleyici dahil); yazma yalnız yönetici.** |
| `GET /api/planning/gkk/:id/files` · `/api/planning/gkk-folder` (GET/PUT dir/POST match) · `gkk-files/:id` (GET/DELETE) | **GKK kalite raporu PDF'i, klasörden (2026-11-17, §6):** bu kaydın hammaddesine bağlı dosyalar (satırın üstüne basınca açılır; okuma herkes) · klasör durumu/ayarı/tek seferlik eşleme (dosya adından hammadde çıkarılır; **yalnız yönetici**) · dosyayı indir/aç (herkes) / kaldır (yönetici). Manuel (elle) yükleme ucu YOK — yalnız klasörden. |
| `/api/planning/first-approvals` (GET/POST) · `first-approvals/sequence` (PUT) · `first-approvals/:id` (PUT/DELETE) | **İlk onay raporu** (EYS.FR.013): liste (`?q=&year=`), numara al (`woNo, person?, again?`; **operatör + yönetici**, iş emrinin alanına da yazar), elle kayıt/düzeltme/silme/numara tabanı yalnız yönetici; okuma herkes. |
| `/api/planning/samples` (GET/POST) · `samples/:id` (GET/PUT/DELETE) · `samples/:id/decide\|reopen` (POST) · `samples/sequence` (PUT) · `samples/stats` (GET) | **Numune takip** (EYS.FR.012, `products`'a bağlanmaz — **YENİ ürün kodu oluşturma akışı HARİÇ**, bkz. altta): liste (`?q=&status=`), yeni form (yalnız müşteri zorunlu; `customerGroupCode`+`codePrefix` birlikte verilirse YENİ Alen ürün kodu üretir), ayrıntı/düzenle (`machineId` dahil), sil (admin), müşteriden gelen karar (`{status, decidedOn?, note?}`) ve geri al, numara tabanı (admin), **analiz** (`?from=&to=`: karar tarihine göre ret oranı + talep edilen/bekleyen, vars. aralık bu ayın başından bugüne). `numune` ekranı: GET okuma, POST/PUT/decide/reopen yazma. |
| `GET /api/planning/samples/customer-groups` · `samples/next-stock-code?group=&prefix=` (GET) · `samples/:id/retry-mikro-product\|retry-mikro-weight` (POST) | **Numune: yeni ürün kodu + Mikro** (2026-11-13, §6 "Tezgaha bağlama + YENİ ürün kodu oluşturma"): sabit 19 müşteri grubu listesi · kod önizlemesi (rezerve ETMEZ; `prefix`: `SR`\|`Nİ`) · Mikro'daki stok kartı oluşturma/ağırlık güncellemeyi elle yeniden dener (yalnız `autoGenerated` numunede; **`StokKaydetV2` gerçek Mikro'ya karşı hiç denenmedi**). `numune` ekranı: GET okuma, POST yazma. |
| `GET /api/planning/samples/materials?q=&limit=` · `GET/POST /api/planning/samples/:id/drawings` · `GET/DELETE /api/planning/samples/:id/drawings/:did` | **Numune: hammadde arama + teknik resim** (2026-11-13, §6 "Numune formunda hammadde seçimi…"): Mikro'da canlı hammadde arama (dar, numune-özel uç; `hammadde` ekranının kendi ucuna bağımlı değil) · PDF listele/yükle (gövde = ham PDF, `?name=`; en çok 8, her biri ≤20 MB) · indir/görüntüle (herkes) / kaldır. `numune` ekranı: GET okuma, POST/DELETE yazma. |
| `/api/planning/quarantine` (GET/POST) · `quarantine/:id` (GET/PUT/DELETE) · `quarantine/:id/exit\|reopen\|corrections` (POST) · `quarantine/corrections/:id` (DELETE) | **Hurda girişi** (karantina giriş-çıkış EYS.FR.043 + tashih EYS.FR.049, `products`'a bağlanmaz, §6 "Hurda Girişi"): liste (`?q=&status=`), yeni giriş kaydı (`wo_no?` ile iş emrine bağlanabilir), ayrıntı (tashih geçmişi + toplamlar + `depot`: Mikro Karantina deposu özeti) / düzenle, sil (admin), çıkış yap (`{exitReason, exitedOn?, exitedBy}`), geri al, tashih ekle (`{doneOn?, operator, description, qty, okQty?, scrapQty?, manHours?, note?}` — bağlıysa Mikro'ya otomatik yansır, §6), tashih sil (admin). `hurda` ekranı: GET okuma, POST/PUT/exit/reopen/corrections yazma. |
| `GET /api/planning/quarantine/hurda-deposu?from=&to=` · `POST quarantine/:id/depot/retry-giris` | **Karantina deposu** (Mikro dep_no=5, §6 "Karantina deposu"): Karantina→Hurda(3) başarılı transferlerin dökümü · başarısız Karantina GİRİŞ'ini elle yeniden dener. `hurda` ekranı: GET okuma, POST yazma. |
| `/api/planning/devices` (GET/POST) · `devices/import` (POST) · `devices/:id` (GET/PUT/DELETE) | **Ölçüm cihazları takip** (EYS.LS.006, `products`'a bağlanmaz, §6 "Ölçüm Cihazları Takip"): liste (`?q=&active=&usable=&calibration=`, kalibrasyon durumu hesaplanır), yeni cihaz ekle, Excel'den ilk kurulum aktarımı (gövde = ham `.xlsx`, admin), ayrıntı/düzenle, sil (admin). `olcucihazlari` ekranı: GET okuma, POST/PUT yazma; `import` ve `DELETE` kayıtsız → admin. |
| `GET /api/planning/maintenance?q=` · `maintenance/import` (POST) · `maintenance/types` (POST) · `maintenance/types/:id` (PUT/DELETE) · `maintenance/types/:id/items` (POST) · `maintenance/items/:id` (PUT/DELETE) · `maintenance/assets` (POST) · `maintenance/assets/:id` (PUT/DELETE) · `maintenance/assets/:id/logs` (GET/POST) · `maintenance/logs/:id` (DELETE) · `maintenance/auto-tick` (GET/PUT) | **Bakım** (EYS.FR.016 + Bakım Sicil Kartları, `products`'a bağlanmaz, §6 "Bakım"): tip → makine → kalem ağacı (durum tamam/yaklaşıyor/gecikti hesaplanır), tik at / rutin-arızi kayıt ekle, bir makinenin geçmişi. Periyot (`period_unit/period_every/times_per_period/anchor_months`) yalnız kalem düzenlemeden değişir. **Otomatik tik anahtarı** (§6 "Bakım: otomatik tik"): `{enabled}` — kapalıyken ustanın tikleme davranışını etkilemez, yalnız sistemin kendiliğinden attığı tiki durdurur. `bakim` ekranı: genel görünüm GET okuma, tik/log POST yazma; tip/kalem/makine CRUD, log silme, Excel içeri aktarma ve otomatik tik anahtarı kayıtsız → admin. |
| `GET /api/planning/drawing-tracking?q=&customer=&limit=&offset=` · `GET drawing-tracking/customers` · `PUT drawing-tracking/:kod` · `POST drawing-tracking/import` | **Teknik resim takip** (EYS.LS.007, `products`'a bağlı okur ama ayrı tabloda tutar, §6 "Teknik Resim Takip"): sistemdeki her ürünün resim durumu (var/yok, dosya sayısı)/rev no (sistem otomatik artırır)/tarihleri, liste (ürün listesiyle aynı arama + `customer` ile müşteriye göre TAM eşleşme filtresi), DISTINCT müşteri adları (açılır kutu), düzenle (satır yoksa oluşturulur), Excel'den ilk/tekrar aktarım (gövde = ham `.xlsx`, admin; Alen koduyla eşler, yinelenen kod en yeniyi baz alır). `teknikresim` ekranı: GET okuma, PUT yazma; `import` kayıtsız → admin. |
| `GET/POST /api/planning/tool-items` · `GET tool-items/categories` · `POST tool-items/import` · `GET/PUT/DELETE tool-items/:id` | **Takım ve Pens Takip** (EYS.LS.026, `products`'a bağlanmaz, §6 "Takım ve Pens Takip"): liste/ara (`?q=`), yeni kayıt (kategori+tanım zorunlu, kalan alanlar serbest metin — `qty`/`criticalQty` de dahil, "X" gibi sayısal olmayan işaretler kabul edilir), DISTINCT kategori listesi (öneri açılır kutusu), Excel'den içeri aktarma (gövde = ham `.xlsx`; çalışma kitabındaki her sayfa Takım Takip/Pens Takip/Takım Uçları-Tutucuları şekilleriyle sırayla denenir; aynı kategori kümesini üreten yinelenen bir sayfa TAMAMEN atlanır), ayrıntı/düzenle, sil (admin). `takimtakip` ekranı: GET/POST/PUT yazma role'e; `DELETE` ve `import` kayıtsız → admin. |
| `/api/planning/work-orders/:no/print.pdf` (GET) · `work-orders/:no/drawings.pdf` (GET) · `work-orders/:no/drawings?name=` (POST) · `work-orders/:no/drawings/:id` (DELETE) | **İş emri formu + teknik resimler**: `print.pdf` = form (ön sayfa) + resimler (arka sayfalar) TEK PDF (`application/pdf`, izleyici ve operatör dahil herkes; ekranda gösterilen ve basılan dosya) · `drawings.pdf` = yalnız birleşik resimler · yükle (gövde = ham PDF, yönetici) · kaldır (yönetici). |
| `/api/planning/measure-reports` · `work-orders/:no/measure-report` · `products/:kod/measure-plan` (PUT) | **Ölçü raporları** (okuma herkes): ölçümü olan iş emirleri ve bir iş emrinin tüm ölçümleri · ürün kartının kalıcı ölçü planı (yönetici). |
| `/api/planning/work-orders` (+ `/next`, `/sequence`, `/:no`, `/:no/cancel`, `/:no/start`, `/:no/finish`, `/:no/reopen`) | **İş emri** (yalnız admin): liste (`?q=&status=&machine=`), oluştur (POST: `lineId` ya da `stockCode`, `targetQty`, `machineId`, …), sıradaki numara, numara tabanı (PUT), ayrıntı + geçmiş + gerçekleşen üretim (`progress`), düzenle (PUT), iptal (POST, `reason`), **üretime başlat** (`machineId?, startAt?, person?, fields?`), **bitir** (`endAt?, person?`; sonuç dondurulur), **üretime geri al**. |
| `GET /api/health` | Anonim/viewer: yalnız `{ok:true}`. **Admin:** durum + **`statusMapping`** (hangi ham değer hangi duruma eşlendi). |
| `GET /api/agent/machines?driver=&model=` | **Ajanın okuduğu tezgah listesi** — IP'si tanımlı olanlar; `model` (11TB / 22TB) verilirse yalnız o modeldekiler (her model kendi ajanıdır). Ajan bunu dakikada bir çeker. |
| `GET /api/drivers` · `GET /api/config` · `PUT /api/config/machines` | Sürücüler ve yapılandırma. |
| `POST /api/library/programs/delete` · `GET /api/library/log` | **Kütüphaneden silme** (admin; geri dönüşsüz): `ids`, `confirm` (tek programda adı, çoklu sayısı), `by`; yanıt `deleted[]`, `programs`, `versions` · silme kaydı (kim, ne zaman, sürüm SHA'ları). |
| `GET /api/library/config` · `/customers` · `/matrix[?library=]` | Özellik durumu (`transferEnabled`…), müşteri klasörleri, program × tezgah matrisi (`library`: `ortak` ya da bir tezgah kimliği, vars. `ortak`, §6 "Kütüphane bölünmesi"). |
| `GET /api/library/export.zip?library=` | **Kütüphaneyi ZIP olarak dışa aktar** (flash/USB'ye kopyalamak için, §6): seçili kütüphanedeki her programın en son sürümü, müşteri klasör yapısı korunarak. `library` geçersizse 400. |
| `GET/POST /api/library/programs` | Liste (`?library=&customer=&q=`); yükleme: gövde = ham dosya, `?library=&customer=&name=&by=&note=&originalName=` (201 yeni sürüm, 200 aynı içerik; `library` vars. `ortak`, §6 "Kütüphane bölünmesi"). |
| `POST /api/library/programs/text` | **Editör kaydı** (JSON: `text`, `lineEnding`, `encoding`, `bom`, `by`, `note`, `library?`; yeni program için `customer`+`name`, yeni sürüm için `programId`+`baseVersionNo`, `acceptNewer`). 201 yeni sürüm, 200 aynı içerik, 409 `code: exists` / `newer-version`. |
| `GET /api/library/programs/:id` · `/versions/:no[?download=1\|full=1]` | Sürümler (programın KENDİ kütüphanesindeki yedekleriyle) · önizleme (JSON; `full=1` kesmeden tam metin + `roundTrip`) ya da ham indirme. |
| `POST /api/library/programs/:id/rename` | **Kütüphanede yeniden adlandırma** (§6): `{name}` → 200 (ayrı: `renamed:false` no-op); 400 geçersiz ad; 404; 409 aynı klasörde ad çakışması. |
| `POST /api/library/programs/:id/rename-on-machines` | **Kopyası olan tezgahlarda da yeniden adlandırma** (gerçek FTP RNFR/RNTO, §6): `{customer, oldName, newName, machineIds, confirm}` (onay: 1 tezgahta kimlik, >1'de sayı) → `{machines, results[]}` (tezgah başına `outcome`: `degisti`/`atlandi`/`bulunamadi`/`hata`). `machineIds` boşsa 200 `{machines:0}`, hiç FTP'ye gidilmez. |
| `POST /api/machines/:id/programs/import-plan` · `GET .../import-plan/:planId[/diff?key=]` · `POST .../import-apply` | **Toplu alım** (admin; tornaya yalnız okuma): plan başlat (202, arka plan; gövdede `library?`, vars. `ortak`, §6 "Kütüphane bölünmesi") · durum/ilerleme + plan · bir çakışmanın iki yüzü (fark) · uygula (`decisions: {anahtar: 'al'|'atla'}`, `skipKeys`). |
| `POST /api/machines/:id/programs/push-plan` · `GET .../push-plan/:planId` · `POST .../push-apply` · `POST .../push-stop` · `GET /api/library/backups/:id[?download=1]` · `POST /api/library/backups/:id/restore` | **Toplu gönderme** (admin; tornaya yazar ve ezer, §6): plan (yalnız okuma, 202; gövdede `library?`, vars. `ortak`) · plan + uygulama ilerlemesi · uygula (`confirm` = tezgah kimliği, `acks`, `skipKeys`; 202; 22TB'de 422) · durdur · ezilen eski hâllerin yedeği (indir / yeni sürüm olarak al). |
| `POST /api/machines/:id/programs/delete-precheck` · `/delete` | **Tornadan silme** (admin; silme kapısı kapalıysa 422): ön kontrol (yazmaz) · sil (`confirm` = program adı, `acks`; gövdede `library?`, vars. `ortak`). Kayıt `kind: 'silme'`. |
| `POST /api/machines/:id/folders` | **Tezgahta yeni müşteri klasörü** (JSON: `name`, `confirm` = tezgah kimliği, `by`). Kayıt döner (`kind: 'klasor'`); 400/403/404/409/422/502 gönderme ile aynı. |
| `GET /api/machines/:id/programs[?library=]` | Son taramanın envanteri + kütüphaneye göre durum (`library` vars. o tezgahın kendi kütüphanesi değil, `ortak` — çağıran kütüphaneyi açıkça seçer, §6). |
| `POST /api/machines/:id/programs/scan` · `/import` | Tezgahı FTP ile tara (yalnız okuma) · tezgahtaki programı kütüphaneye al. Gövdede `library?` (vars. `ortak`). |
| `POST /api/transfers/precheck` · `POST /api/transfers` · `GET /api/transfers` | Ön kontrol (yazmaz) · gönder (`confirm` = tezgah kimliği, `acks`) · denetim kaydı. Hata kodları: 400 doğrulama, 403 kapalı, 404, 409 meşgul, 413 büyük, 422 desteklenmiyor, 502 tezgah/FTP. |

`window`: `30m` · `8h` · `24h` · `7d`. Ya da `from`/`to` (epoch ms veya ISO).

---

## 10. Sıradaki işler

- [ ] **"Adedi düzelt…" (bitmiş iş emrinde, 2026-11-18) GEÇİCİDİR — bitmiş ürün depo akışı (`PRODUCT_DEPOT_ENABLED`)
      açılınca KALDIRILMALI ya da kısıtlanmalı.** Bkz. §6 "İş emrinde bitmiş adedi düzeltme". O akış açılınca
      düzeltme ile zaten Mikro'ya gönderilmiş bir miktar arasındaki tutarsızlık riski gerçekleşir hâle gelir.
- [ ] **Mail'den otomatik sipariş girişi — DEVAM EDİYOR.** Bkz. §6 "Mail'den otomatik sipariş girişi" (2026-11-16/17):
      yeni sipariş + revizyon için göster-onayla kararlaştırıldı. **PDF metin okuma, tablo ayrıştırma + müşteri
      eşleme + taslak veritabanı + onay ekranı (yeni "Yeni siparişler" sekmesi — `yenisiparis`) VE Tesseract OCR
      entegrasyonu AYNI oturumda YAPILDI ve kullanıcının verdiği GERÇEK taranmış PDF ile uçtan uca doğrulandı**
      (bkz. §6 "Tablo ayrıştırma + taslak veritabanı + onay ekranı" ve "Tesseract OCR entegrasyonu"); ilk tahmin
      ("DCTDecode=JPEG yeter") gerçek veriyle YANLIŞ çıktı (asıl ihtiyaç CCITT Group4, MRC çift katmanlı tarama),
      yolda 6 gerçek hata bulunup düzeltildi (2 Türkçe sayı ayrıştırma, revizyon notu sınıflandırmasının
      `matched`'a bağımlılığı, elle onaylanan satırın `match_status` güncellenmemesi, TIFF sarmalayıcıda ters
      siyah/beyaz, OCR'ın kelime-kutusu bölünmüş başlıkları tanımaması — bu sonuncunun İLK düzeltmesi de kendi
      regresyonunu yarattı, ikinci denemede kök nedenden (açgözlü/çakışmasız pencere tüketimi) düzeltildi).
      `npm test` 813/813 yeşil. **Tesseract'ın installer'a gömülmesi (`tur`/`eng`/`osd` dahil) YAPILDI (2026-11-19, v1.0.9).**
      **Revizyon e-postasının GERÇEK biçimi (vurgulu hücre DEĞİL, fazladan bir hücre: eski değer + yeni değer/"iptal") bulunup
      DÜZELTİLDİ ve kullanıcının kendi GERÇEK revizyon örneğiyle (5 satır, 2 farklı sipariş no) uçtan uca doğrulandı
      (2026-11-19) — bkz. §6 "Mail'den otomatik sipariş girişi" sonundaki ilgili bölüm.**
      **"Mail üzerinden okuma yapmaya gerek yok, yönetici tabloyu kopyalayıp yapıştırır" netleşti (2026-11-19, kullanıcı kararı) —
      Graph API/otomatik mail tarama bu özellik için artık GEREKSİZ görünüyor, ayrıca istenmedikçe yapılmayacak.**
      **Sıradaki:** gerçek DOLU bir sipariş tablosu sayfasıyla OCR'ın uçtan uca onay ekranına kadar denenmesi (bu turda
      gerçek dosyanın sipariş tablosu sayfası boş bir şablon çıktı); revizyon e-postasının GERÇEK HTML markup'ıyla (yalnız
      değerlerle değil — admin'in gerçek Ctrl+C/Ctrl+V'siyle "E-posta tablosunu yapıştır…" penceresine) doğrulanması;
      gerçek bir PDF'in tarayıcıdan yüklenmesinin denenmesi (bu oturumda yalnız API'ye doğrudan istekle test edildi).
      **Mikro'ya YENİ sipariş yazma (`SiparisKaydetV2`) — GERÇEK YAZMA BAŞARILI (2026-11-18)** — bkz. §6 "Mikro'ya YENİ
      sipariş yazmak" > "GERÇEK İLK YAZMA DENEMESİ". Kullanıcının onayıyla gerçek bir eski sipariş (SAS0003812, HAVANA,
      4 kalem) "yeni sipariş gibi" yeniden girildi — İLK denemede `StatusCode:200`, SPR-755, 4 satır, salt okuma ile
      tam doğrulandı; `sip_evrakno_seri`/`sip_evrakno_sira`'yı kendimiz hesaplayıp göndermenin (en belirsiz noktaydı)
      VE tek evrakta birden çok kalemin (`previewCreateOrder` artık `items[]` alıyor) İKİSİ de çalıştığı kanıtlandı.
      - [x] **SPR-755 (HA VANA, 120.10.0007) test kaydı Mikro'dan SİLİNDİ (kullanıcı onayı, 2026-11-18).** Eski not:
            kullanıcı "sonra sileriz" demişti,
            bir sonraki oturum bunu kontrol etmeli/hatırlatmalı (4 satır, GUID'ler CLAUDE.md'de "GERÇEK İLK YAZMA
            DENEMESİ" bölümünde kayıtlı; `SiparisSilV2`/`SiparisGuidSilV2` hiç araştırılmadı, muhtemelen kullanıcı
            kendi Mikro ekranından elle siler).
      - [x] **PDF ayrıştırma düzeltmesi (karakter-karakter HAVANA PDF'i) YAPILDI ve 2026-11-18'de ikinci kez
            uçtan uca doğrulandı** (bkz. §6 "PDF karakter-karakter ayrılma düzeltmesi" + hemen altındaki "TÜM 4
            GERÇEK PDF... YENİDEN DOĞRULANDI" tablosu): `mergeCharacterCells` ile hücreler birleştiriliyor, 4/4
            satır tam eşleşiyor, adet de (daha önce "çıkmıyor" diye kayıtlıydı — o not YANLIŞTI/güncel değildi)
            açıklama metnindeki "500,00Adet" kalıbından doğru çıkarılıyor. Dört gerçek PDF'in dördü de artık
            üretim yolundan (`importPdf`) sorunsuz geçiyor.
      - [x] **"Hepsi TEK siparişte Mikro'ya gönder" (çok satırlı taslak → tek evrak) YAPILDI ve İKİNCİ KEZ GERÇEK
            Mikro'ya karşı BAŞARILI (2026-11-19)** — bkz. §6 "Hepsi TEK siparişte Mikro'ya gönder". Gerçek bir
            Konveyör PDF'i (`4100018539.PDF`, kullanıcının Downloads'undan) "Yeni siparişler" ekranından GERÇEK
            tarayıcı akışıyla (PDF yükleme hâlâ API'ye doğrudan istekle — tarayıcı dosya seçici kısıtı aynen
            geçerli, ama onaylama/gönderme adımlarının HEPSİ gerçek düğmelerle) işlendi: 11 satırın 10'u onaylandı,
            yeni toplu düğmeyle TEK evrakta (SPR-755, müşteri 120.10.0011 KONVEYÖR, toplam 448.308 TL) gönderildi,
            salt okuma ile tam doğrulandı.
      - [x] **ÇÖZÜLDÜ (2026-11-19): bu SPR-755 GERÇEKTEN bir DUPLİKASYONDU** — aynı PO (4100018539) zaten
            `SPR-747` olarak Mikro'da duruyordu (muhtemelen bu PDF'in bir ÖNCEKİ revizyonu). Kullanıcı SPR-755'i
            kendisi sildi; bu da "Mikro'dan yenile"nin silinen siparişleri HİÇ fark etmediği GERÇEK bir bug'ı
            ortaya çıkardı — bkz. §6 "ÜÇ GERÇEK BULGU + DÜZELTME" (düzeltildi: `mikro.js` artık `keepOld:false`,
            `markStale` gerçekten çalışıyor) ve PDF'in kendi PO numarasının (`sip_belgeno` için) artık otomatik
            çıkarıldığı (`extractDocOrderNo`, aynı bölüm) — ikisi de test edilip gerçek veriyle doğrulandı.
      - Mükerrer mail tespiti, revizyon eşleştirmesinin gerçek bir e-posta HTML'iyle doğrulanması, Graph API bağlantısı
        hâlâ bekliyor (yukarıdaki genel maddeyle aynı).
      - [ ] **FABRİKA PC'sine (192.168.1.50) `mikro.js`'nin `keepOld:false` düzeltmesi henüz ULAŞMADI** — o makinenin
            kendi backend sürecinin yeniden başlatılması (bir sonraki Setup.exe kurulumu ya da elle güncelleme ile)
            gerekiyor; o PC'deki "Siparişler" ekranındaki HAVANA + Konveyör SPR-755 kayıtları ancak o zaman düzelir.
      - [ ] **Henüz yapılmayan: aynı PO numarasıyla (artık otomatik çıkarılan `custOrderNo`) var olan bir `order_lines`
            kaydı varsa, yeni bir taslak onaylanmadan ÖNCE kullanıcıyı uyarmak** — bu turda yalnız ÇIKARIM eklendi,
            SPR-747/SPR-755 gibi bir duplikasyonu ÖNLEMEZ (yalnız kullanıcı fark edip elle sildi). Gerçek bir ihtiyaç
            olarak doğrulandı, henüz tasarlanmadı/yazılmadı.
- [x] ~~Program kütüphanesi bölünmesi (ortak + makine başına)~~ — yapıldı (2026-11-03), bkz. §6 "Kütüphane bölünmesi: Ortak + makine başına". **Fabrika PC'sinde gerçek kullanımda henüz denenmedi** (yalnız bu makinedeki geliştirme veritabanıyla).
- [x] ~~Bir tezgahın kütüphanesini flash/USB'ye aktarma (ZIP)~~ — yapıldı (2026-11-03), bkz. §6 "Kütüphaneyi ZIP olarak dışa aktarma".
- [x] ~~Bitmiş ürün depo akışı (Merkez↔Geçici, Mikro)~~ — kod YAZILDI, GERÇEK Mikro'ya karşı uçtan uca doğrulandı (2026-11-04, SR040.013,
      iş emri 2026001199: 10 adet Geçici GİRİŞ virmanı → 8 adet paketlenip Merkez'e TRANSFER → 2 adet kalan fark), bkz. §6 "Bitmiş ürün depo akışı".
      Yolda GERÇEK bir tasarım hatası bulunup düzeltildi (Merkez→Geçici transfer yerine Geçici içi GİRİŞ virmanı) ve GİRİŞ yönünün kök nedeni
      (evrak serisi boş olmalı) çözüldü. Üç adımın (GİRİŞ/TRANSFER/ÇIKAN "Farkı temizle…") hepsi UI'dan uçtan uca denendi. **Sıradaki:**
      `MIKRO_WRITE_ENABLED` gerçek kurulumda/Setup.exe'de açma kararı (yönetici ile birlikte, hâlâ kapalı).
- [x] ~~Installer'a MikroAPI ortam değişkenlerini GÖM~~ — yapıldı (2026-10-29), bkz. "MikroAPI kimlik bilgileri ve yazma artık installer'a gömülüyor".
- [x] **Numune: tezgaha bağlama + yeni ürün kodu + Mikro yazma** — yapıldı (2026-11-13), bkz. §6 "Tezgaha bağlama + YENİ ürün kodu
      oluşturma". Tarayıcıda gerçek dev sunucusuna karşı uçtan uca denendi (kod üretimi, ürün kartı). **Mikro yazma mekanizması
      2026-11-16'da GERÇEK Mikro'ya karşı doğrulandı** (bkz. §6'daki aynı bölümün sonu) ve `mikro-stock.js`'teki `previewCreateProduct`/
      `previewUpdateProductWeight` AYNI GÜN bu bulgulara göre düzeltildi: yeni kart `StokKaydetV2`+`user_tablo` ile, var olan kartı
      güncelleme (ağırlık dahil) `StokKaydetV2` DEĞİL `KayitKaydetV2` (Tablo No 13, KayitTipi '1') ile. SR/Nİ kod numaralandırmasının
      AYNI müşteri grubunda BAĞIMSIZ değil ORTAK sayıldığı da bu testte bulunup düzeltildi (`nextStockCode()`). **Kalan iş: bu
      düzeltilmiş kodun bir dahaki gerçek numune testinde yönetici ile birlikte TEKRAR gerçek Mikro'ya karşı doğrulanması** (bugünkü
      kod değişikliği yalnız sahte istemciyle birim testiyle sınandı, gerçek Mikro'ya bir daha yazılmadı).
- [x] ~~Hurda Girişi (karantina giriş-çıkış EYS.FR.043 + tashih EYS.FR.049)~~ — yapıldı (2026-11-04), bkz. §6 "Hurda Girişi". Tarayıcıda gerçek
      sunucuya karşı uçtan uca denendi (giriş → tashih → çıkış → geri al → yazdırma önizlemesi). **Sıradaki:** gerçek yazıcıdan baskı, fabrika
      PC'sinde gerçek kullanım, admin'in bu ekranı hangi role (yeni ya da var olan) açacağına karar vermesi (göçle gelen roller otomatik almadı).
      **Installer v1.0.3'te derlendi** (bkz. §6 "MikroAPI kimlik bilgileri ve yazma artık installer'a gömülüyor").
- [x] ~~Ölçüm Cihazları Takip (EYS.LS.006)~~ — yapıldı (2026-11-05), bkz. §6 "Ölçüm Cihazları Takip". Gerçek EYS.LS.006 dosyasıyla uçtan uca
      denendi (169/175 gerçek cihaz içeri aktarıldı, kalibrasyon renkleri doğru). **Sıradaki:** gerçek yazıcıdan baskı, fabrika PC'sinde
      Setup.exe sonrası gerçek ilk kurulum akışı (bu ekranın asıl amacı budur), admin'in bu ekranı hangi role açacağına karar vermesi.
      **Installer v1.0.3'te derlendi.**
- [x] ~~Teknik Resim Takip (EYS.LS.007)~~ — yapıldı (2026-11-06), bkz. §6 "Teknik Resim Takip". Gerçek EYS.LS.007 dosyasıyla uçtan uca
      denendi (343/389 satır eşleşti); `doc-folder.js` kancası ("ilk eşleme vs gerçek revizyon" ayrımı) gerçek bir PDF ile tarayıcıda da
      doğrulandı. **Sıradaki:** gerçek fabrika kullanımı, admin'in bu ekranı hangi role açacağına karar vermesi. **Installer v1.0.3'te derlendi.**
- [x] ~~Bakım (EYS.FR.016 + Bakım Sicil Kartları)~~ — yapıldı (2026-11-11), bkz. §6 "Bakım". Gerçek Bakım Sicil Kartları
      dosyasıyla uçtan uca denendi (12 sayfa → 4 tip, 11 makine; 1 sayfa gerçek bir veri kalitesi hatası yüzünden — BS.012'nin
      kendi "Sicil No" hücresi yanlışlıkla "BS.010" yazıyor — doğru şekilde atlandı). **Sıradaki:** BS.012'nin sicil no'sunu
      kaynak Excel'de düzeltip yeniden içeri aktarmak ("BÜYÜK CNC TORNA" tipi henüz hiç oluşmadı); fabrika PC'sinde gerçek
      kullanım; admin'in bu ekranı hangi role açacağına karar vermesi (göçle gelen roller otomatik almadı). **Installer v1.0.4'te derlendi**
      (bkz. §6 "MikroAPI kimlik bilgileri ve yazma artık installer'a gömülüyor"), **fabrika PC'sine henüz kurulmadı.**
- [ ] **Çizelgeleme / optimizasyon (OR-Tools CP-SAT) — MVP + Setup.exe'ye Python gömme YAPILDI (2026-10-26), yalnız sentetik veriyle ve bu makinede derlenen pakette denendi.** Ayrıntı: §6 "Çizelgeleme / optimizasyon". Sıradaki: fabrika PC'sinde gerçek kurulum + gerçek iş emri verisiyle dene.
- [ ] **`kurulum/kurulum.ps1`'i gerçek Windows'ta çalıştır** — yükseltilmiş
      oturumda hiç denenmedi. Artık en kolay yol: `installer/` ile üretilen
      Setup.exe'yi hedef PC'de çalıştırmak (görev, güvenlik duvarı, açılışta
      başlatma ve SYSTEM hesabında ajan ilk kez orada sınanır).
- [x] ~~22TB tezgahta ilk gerçek bağlantı~~ — yapıldı (2026-10-08, CNC-08 / .97): okuma ve FTP taraması doğrulandı (§3).
- [ ] **22TB: gönderme 2026-10-30'da AÇILDI (kullanıcı kararı), ilk gerçek yazma denemesi ve uzun süreli kararlılık hâlâ YAPILMADI.** Kullanıcı kendi
      yeni/izole test klasöründe (tek program, mevcut müşteri klasörlerine dokunmadan) kontrollü ilk denemeyi kendisi yapacak; sonucu buraya ve §3'e işle.
      Sorun çıkarsa `config/drivers.json`'da `models[22TB].fileTransfer.sendEnabled` yeniden `false` yapılabilir. Ayrıca: ajanı saatlerce açık bırakıp
      takılma/oturum sızıntısı olmadığını doğrula (22B oturumu 5 TCP açıyor, oturum sınırı ölçülmedi); silme (`deleteEnabled`) hâlâ ayrıca kapalı.
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
      `curl.exe -Q "RMD ZZTEST…"` ile sil (ürün klasör silmez). 22TB'de gönderme zaten açık (2026-10-30); klasör açma da aynı kapıdan geçiyor.
      Program/klasör silme üründe yok.
- [ ] **Toplu gönderme gerçek tornada denenecek:** (1) fabrika PC'sinde `tools/torna-test/ezme-testi.ps1` önce bir 11TB tornada, sonra 22TB tornada çalıştırılır (`-Klasor` var olan bir müşteri klasörü; çıktı/log gönderilir; 22TB'de gönderme kapısı zaten açık, 2026-10-30);
      (2) ilk gerçek toplu gönderim TEK müşteri klasörüyle (plan penceresinde klasör seç) küçük bir tornada denenir, ardından tüm klasörler; ezilen bir programın yedeğinin program sayfasında göründüğü ve "Yeni sürüm olarak al"ın çalıştığı doğrulanır; (3) süre ve üretime etkisi (ilerleme + tornanın FTP'si) izlenir; (4) kontrolcü belleğindeki program davranışı sorulur/denenir.
- [ ] **Tornadan silme (`DELE`) gerçek tornada İLK KEZ denenecek** (11TB'de kapı 2026-10-13'te AÇILDI, ama `DELE` hiç denenmedi; 22TB'de silme hâlâ kapalı, yazmadan ayrı bir karar). Plan: önce kendi gönderdiğimiz `ZZTEST…` adlı bir test dosyasını (`Program gönder`) UI'dan sil →
      tornada gerçekten kalktığını panelden ve tazeleme taramasıyla doğrula; gerçek bir müşteri programını bu doğrulamadan önce silme. Acil kapatma: `DELETE_DISABLED=1`.
- [ ] **Tornadaki dosyanın adını da değiştirme (`renameAcrossMachines`, 2026-10-30) gerçek tornada denenecek:** önce kendi gönderdiğimiz bir `ZZTEST…`
      dosyasını yeniden adlandır (RNFR/RNTO davranışı ve `transfers`/envanter kaydının doğruluğu), sonra gerçek bir programla; birden çok tezgahta aynı
      programı yeniden adlandırma (onay = sayı) henüz hiç gerçek tornada denenmedi.
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
