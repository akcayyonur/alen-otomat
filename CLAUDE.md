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
```

Gerçek tezgahla:

```bat
REM Windows'ta, DLL klasöründen
syntec-agent.exe --ingest http://OFIS-PC:3000/api/ingest --interval 1000
```

`machines.txt`:
```
CNC-01=192.168.1.101
CNC-02=192.168.1.102
```

Tek tezgah için: `--host 192.168.1.101 --machine-id CNC-01`

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
| `backend/db.js` | SQLite: `samples` (detay, 7 gün) + `spans` (durum aralıkları, 400 gün). Raporlar `spans`'ten gelir, satır sayısından bağımsız hızlı. |
| `backend/store.js` | Canlı durum (bellek) + aralık yönetimi + veri boşluğu tespiti. |
| `backend/server.js` | HTTP API + SSE. |
| `dashboard/app.js` | Yönlendirme, SSE, filo ve detay görünümleri. |
| `dashboard/charts.js` | SVG çizgi grafiği (imleç + balon), durum şeridi. |
| `dashboard/format.js` | Alan tanımları ve etiketler — **arayüzün tek kaynağı**. |
| `dashboard/config-view.js` | Ayarlar ekranı. |
| `tools/syntec-agent/SyntecReader.cs` | **Okuma + durum eşlemesi (tek kaynak).** |
| `tools/syntec-agent/Agent.cs` | Sürekli çalışan servis: tezgah başına iş parçacığı, yeniden bağlanma, tamponlama. |
| `tools/syntec-probe/` | Tek seferlik saha teşhis aracı. |
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
| `GET /api/drivers` · `GET /api/config` · `PUT /api/config/machines` | Sürücüler ve yapılandırma. |

`window`: `30m` · `8h` · `24h` · `7d`. Ya da `from`/`to` (epoch ms veya ISO).

---

## 10. Sıradaki işler

- [ ] **Gerçek tezgahta ajanı çalıştır** — şimdiye kadar yalnızca sahte DLL ile
      uçtan uca test edildi; gerçek donanımda yalnızca probe çalıştı.
- [ ] **Boşta/alarm ham değerlerini gerçek tezgahtan yakala** — `/api/health`
      → `statusMapping` listesine bak, tanınmayan değer çıkıyor mu.
- [ ] 7 tezgaha statik IP + `Start server while boot` (tek ziyarette, bkz. §5).
- [ ] CNC-03…07 kimlik bilgileri (seri no, üretim yılı) — panel başında toplanacak.
- [ ] Ajanı Windows servisi / zamanlanmış görev yap (açılışta başlasın).
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
