# CNC Telemetri Platformu — proje kılavuzu

Fabrikadaki CNC tezgahlardan canlı üretim verisi okuyup gerçek zamanlı bir
dashboard'da gösteren uygulama. Gereksinim belgesi: `cnc-telemetri-gereksinim.html`
(CNC-TLM-001). Bu dosya, projeye sıfırdan giren bir oturumun ihtiyacı olan her
şeyi içerir.

---

## 1. Fabrikanın durumu

- **7 adet CNC torna**, hepsi aynı: ARIX T-42CL gövde, **SYNTEC 11B** kontrolcü,
  yazılım **10.116.54S**, Windows CE / AM335x ARM.
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
npm test        # backend testleri (node:test, bağımlılık yok)
```

Gerçek tezgahla:

```bat
REM Windows'ta, DLL klasöründen
syntec-agent.exe --ingest http://OFIS-PC:3000/api/ingest --interval 1000
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
.\build-installer.ps1 -SyntecBin "C:\...\DiskC\OpenCNC\Bin"   # → installer\output\CNC-Telemetri-Kurulum-<sürüm>.exe
```

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
- **Denenmedi:** Setup.exe'nin yükseltilmiş (UAC) kurulumu — görevler, güvenlik
  duvarı, açılışta başlatma. Ajan SYSTEM hesabıyla gerçek tezgahta çalıştırılmadı.
  Masaüstü uygulamasının pencere ve UAC yolları da elle denenmedi (mantığı gerçek
  süreçlerle `--sessiz` kodlarıyla ve derleme duman testinde sınandı).
  Ayrıntı: `installer/README.md`.

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
| `shared/drivers.js` · `config/drivers.json` | Sürücü kaydı (hangi protokol destekleniyor). |
| `shared/inventory.js` · `config/machines.json` | Tezgah envanteri; ayarlar ekranı buraya yazar. |
| `backend/db.js` | SQLite: `samples` (detay, 7 gün) + `spans` (durum aralıkları, 400 gün). Raporlar `spans`'ten gelir, satır sayısından bağımsız hızlı. **Yeniden başlamada** (`resumeTimelines`) PC'nin kapalı kaldığı süre `NO_DATA` yazılır — ani kapanışta açık kalan aralık yeniden başlama anında değil, tezgahın son kaydedilen örneğinde biter; testi `backend/restart.test.js`. |
| `backend/store.js` | Canlı durum (bellek) + aralık yönetimi + veri boşluğu tespiti. |
| `backend/server.js` | HTTP API + SSE. |
| `dashboard/app.js` | Yönlendirme, SSE, filo ve detay görünümleri. |
| `dashboard/charts.js` | SVG çizgi grafiği (imleç + balon), durum şeridi. |
| `dashboard/format.js` | Alan tanımları ve etiketler — **arayüzün tek kaynağı**. |
| `dashboard/config-view.js` | Ayarlar ekranı. |
| `tools/syntec-agent/SyntecReader.cs` | **Okuma + durum eşlemesi (tek kaynak).** |
| `tools/syntec-agent/Agent.cs` | Sürekli çalışan servis: tezgah başına iş parçacığı, yeniden bağlanma, tamponlama. |
| `tools/syntec-probe/` | Tek seferlik saha teşhis aracı. |
| `kurulum/` | İzleme PC'si kurulum betiği (`kurulum.ps1`) ve belgesi. |
| `installer/` | Setup.exe üretimi (Inno Setup): `build-installer.ps1`, `cnc-telemetri.iss`. DLL'ler pakete derleme anında girer, depoda yok. |
| `ornek-veri/` | **Gerçek tezgah yakalaması** — referans gerçek. |
| `SYNTEC-REMOTEAPI.md` | Protokol notları, saha bulguları. |
| `MAKINE-BASINDA.md` | Makine başında izlenecek adımlar. |

## 9. API

| Uç nokta | İş |
|---|---|
| `POST /api/ingest` | Ajandan telemetri (tek mesaj ya da dizi). Kısmi kabul: geçerliler yazılır, geçersizler 207 ile raporlanır. |
| `GET /api/stream` | SSE, saniyede bir filo anlık görüntüsü. |
| `GET /api/machines` | Anlık görüntü. |
| `GET /api/machines/:id?window=8h` | Detay + vardiya özeti + aralıklar + duruşlar. |
| `GET /api/machines/:id/history?window=30m` | Seyreltilmiş zaman serisi. |
| `GET /api/machines/:id/export.csv?window=24h` | Türkçe Excel CSV (BOM + `sep=;` + ondalık virgül). |
| `GET /api/health` | Durum + **`statusMapping`**: hangi ham değer hangi duruma eşlendi. |
| `GET /api/agent/machines` | **Ajanın okuduğu tezgah listesi** — IP'si tanımlı olanlar. Ajan bunu dakikada bir çeker. |
| `GET /api/drivers` · `GET /api/config` · `PUT /api/config/machines` | Sürücüler ve yapılandırma. |

`window`: `30m` · `8h` · `24h` · `7d`. Ya da `from`/`to` (epoch ms veya ISO).

---

## 10. Sıradaki işler

- [ ] **`kurulum/kurulum.ps1`'i gerçek Windows'ta çalıştır** — yükseltilmiş
      oturumda hiç denenmedi. Artık en kolay yol: `installer/` ile üretilen
      Setup.exe'yi hedef PC'de çalıştırmak (görev, güvenlik duvarı, açılışta
      başlatma ve SYSTEM hesabında ajan ilk kez orada sınanır).
- [ ] **Gerçek tezgahta ajanı çalıştır** — şimdiye kadar yalnızca sahte DLL ile
      uçtan uca test edildi; gerçek donanımda yalnızca probe çalıştı.
- [ ] **Boşta/alarm ham değerlerini gerçek tezgahtan yakala** — `/api/health`
      → `statusMapping` listesine bak, tanınmayan değer çıkıyor mu.
- [ ] 7 tezgaha statik IP + `Start server while boot` (tek ziyarette, bkz. §5).
- [ ] CNC-03…07 kimlik bilgileri (seri no, üretim yılı) — panel başında toplanacak.
- [ ] **Kimlik doğrulama yok.** Ayarlar ekranı ofis ağındaki herkese açık.
      Ofis ağı dışına açılacaksa önce bu çözülmeli; geçici olarak
      `CONFIG_READONLY=1` yazımı kapatır.

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
