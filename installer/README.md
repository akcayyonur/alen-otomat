# Kurulum paketi (Setup.exe)

İzleme PC'sine **ileri-ileri** ile kurulan tek dosya. İçinde proje kodu, gömülü
Node ve Syntec DLL'leri var; hedef PC'ye ayrıca hiçbir şey kurmak gerekmez.

## Paketi üretmek (geliştirme PC'sinde)

```powershell
cd installer
.\build-installer.ps1 -SyntecBin "C:\...\11BLathe_W32_10.116.56Q\DiskC\OpenCNC\Bin"
```

Çıktı: `installer\output\CNC-Telemetri-Kurulum-<sürüm>.exe` (~24 MB).

Gereken: Inno Setup 6 (`winget install JRSoftware.InnoSetup`), Node 22.5+ x64.
`-SyntecBin` verilmezse `CNC_SYNTEC_BIN` ortam değişkenine, o da yoksa
İndirilenler klasörüne bakılır.

Betik sırasıyla: kodu `payload\` altına toplar → ajanı **x86** derler ve PE
başlığından doğrular → **duman testi** yapar → Setup.exe'yi derler. Duman testi
paketlenmiş `node.exe` ile backend'i (node:sqlite dahil) açar, dashboard'u ve
`/api/agent/machines`'i çağırır, ajanın Syntec DLL'lerini kendi klasöründen
yüklediğini doğrular. Bunlardan biri tutmazsa Setup.exe üretilmez.

## Hedef PC'de kurmak

1. `Setup.exe`'yi çalıştırın. **"Windows bilgisayarınızı korudu"** (SmartScreen)
   çıkarsa: *Ek bilgi → Yine de çalıştır*. Paket imzasız olduğu için çıkması normal.
2. Yönetici onayı (UAC) isteyecek. Yönetici hesabı gerekir.
3. İleri → klasör (varsayılan `C:\CNC-Telemetri`) → ağ erişimi/kısayol seçenekleri →
   Kur.

Kurulum: dosyaları yerleştirir, güvenlik duvarında **TCP 5568/5570**'i (kontrolcünün
geri bağlantısı) açar, backend ve ajanı **Windows açılışında başlayacak** görevler
olarak kaydeder, ikisini başlatır. Dashboard: `http://localhost:3000`.

**Masaüstü uygulaması "CNC Telemetri"** (kısayol seçeneği işaretliyse masaüstünde,
Başlat menüsünde her zaman): açınca backend ve ajanın çalışıp çalışmadığına bakar,
çalışmıyorsa başlatır, dashboard'u tarayıcıda açar. Her şey çalışıyorsa pencere ve
yönetici izni olmadan doğrudan dashboard açılır. Hizmetler durmuşsa başlatmak için
Windows yönetici onayı (UAC) ister. Görevler zaten açılışta kendiliğinden başlar;
uygulama durmuş ya da elle kapatılmış hizmetleri tek tıkla kaldırmak içindir.

"Dashboard'a ağdaki diğer bilgisayarlardan erişime izin ver" seçiliyse 3000 portu da
açılır, dashboard `http://<bu-pc-ip>:3000` ile başka bilgisayardan görülür.
**Giriş şifresi yoktur** (CLAUDE.md §10) — yalnızca güvenilir ofis ağında.

## Kurulumdan sonra

- Dashboard → **Ayarlar**'dan her tezgahın IP'sini girin; ajan listeyi oradan alır.
- Kontrolcüde `Start server while boot` açık olmalı, statik IP + reboot (CLAUDE.md §5).
- Loglar: `C:\CNC-Telemetri\logs\` (`ajan.log`, `backend.log`, `kurulum.log`).

## Güncelleme ve kaldırma

- Yeni Setup.exe aynı klasöre kurulursa **üzerine yazar**: önce görevleri ve
  klasördeki süreçleri durdurur. **`config\machines.json`'a dokunmaz** (ayarlar
  ekranının yazdığı tezgah listesi), `data\` ve `logs\` da korunur.
- Kaldırma: Ayarlar → Uygulamalar → CNC Telemetri. Görevleri ve güvenlik duvarı
  kurallarını siler; **veritabanı, loglar ve tezgah listesi kalır**.

## Dikkat

- **Syntec DLL'leri paketin içinde.** `Setup.exe` ve `payload\` depoya girmez
  (`.gitignore`'da) ve herkese açık yere konmamalı: DLL'ler Syntec'in, `syntecclub`
  üyeliğiyle alındı. Yalnızca kendi izleme PC'lerinize dağıtın.
- Hedef PC: **Windows 10/11, 64-bit**. (Gömülü Node x64; Syntec DLL'leri 32-bit ve
  64-bit Windows'ta sorunsuz çalışır.)
- Görevler **SYSTEM** hesabıyla çalışır. Syntec DLL'leri bundan rahatsız olursa
  `kurulum\KURULUM.md` sonundaki "Ajan SYSTEM olarak çalışamıyor" notuna bakın.
- `payload\agent\` içindeki dosyalar Syntec paketinin `Bin` klasörünün bire bir
  kopyasıdır (alt klasörleriyle); bizim ürettiğimiz yakalama dosyaları hariç.
  Klasörü bölmeyin: yönetilen sarmalayıcı native DLL'leri çalışma anında yüklüyor.
