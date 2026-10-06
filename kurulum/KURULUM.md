# İzleme PC'si kurulumu

Fabrikadaki toplayıcı bilgisayara kurulum. **Fabrika başına bir kez** —
dashboard'a bakan kişilerin bilgisayarına hiçbir şey kurulmaz, tarayıcıdan
girerler.

## Gereken

| | |
|---|---|
| Windows | 10 / 11 (veya Server) |
| Node.js | **22.5 veya üstü** — `winget install OpenJS.NodeJS.LTS` |
| .NET Framework | 4.0 — Windows'ta hazır gelir |
| Syntec paketi | `11BLathe_W32_10.116.56Q` klasörü, PC'de bir yerde |

## Kurulum

PowerShell'i **yönetici olarak** aç:

```powershell
cd C:\cnc-telemetri\kurulum
.\kurulum.ps1 -SyntecBin "C:\syntec\11BLathe_W32_10.116.56Q\DiskC\OpenCNC\Bin"
```

Dashboard'a başka bilgisayarlardan da bakılacaksa:

```powershell
.\kurulum.ps1 -SyntecBin "..." -AgaAc
```

Betik şunları yapar:

1. Node sürümünü ve .NET'i denetler
2. Syntec paketindeki **blokeyi kaldırır** (`Unblock-File`)
3. Ajanı **x86** olarak Syntec `Bin` klasörüne derler
4. Güvenlik duvarında **TCP 5568 ve 5570**'i gelen bağlantıya açar
5. Backend ve ajanı **açılışta başlayacak** şekilde kaydeder
6. İkisini başlatır, backend'in yanıt verdiğini doğrular

Tekrar tekrar çalıştırılabilir — var olanı günceller.

Kaldırmak: `.\kurulum.ps1 -Kaldir` (veritabanı ve loglar kalır)

## Kurulumdan sonra

**1. Tezgahlara IP gir.** Dashboard → **Ayarlar** ekranı.

Ajan tezgah listesini backend'den alıyor ve dakikada bir tazeliyor. Tezgah
eklemek veya IP değiştirmek için ajanı yeniden başlatmana gerek yok; logda
`yeni tezgah: CNC-03 (192.168.1.103)` satırını görürsün.

**2. Kontrolcü tarafı.** Her tezgahta bir kez, **tek ziyarette**:
- Statik IP ver
- **`Start server while boot` → AÇIK** (varsayılan `Close` geliyor ve o haldeyken
  OCAPIServer hiç çalışmaz)
- Reboot — Syntec 11B ağ ayarını yalnızca açılışta uyguluyor

## Nerede ne var

```
logs\backend.log      backend çıktısı
logs\ajan.log         ajan çıktısı — bağlantı sorunları burada
data\telemetry.db     veritabanı (yedeklenecek tek dosya)
```

Görevler Görev Zamanlayıcı'da **CNC Telemetri** adıyla görünür.

## Sorun giderme

**Dashboard açılmıyor**
`logs\backend.log`'a bak. Node sürümü düşükse orada yazar.

**Ajan bağlanamıyor**
`logs\ajan.log`. Sırasıyla:
1. `ping <tezgah-ip>` — ağ var mı
2. Kontrolcüde Kernel Server çalışıyor mu (`Start server while boot`)
3. Güvenlik duvarı: 5568/5570 gelen bağlantıya açık mı — kontrolcü PC'ye
   **geri bağlantı açıyor**, bu kapalıysa hiç bağlanmaz

**Ajan `KOPUK` diyor, hata yok; ping ve `5566` portu tamam**
Ajan logunda (`logs\ajan.log`) `Syntec DLL'i (OCApi.dll) yuklenemedi ... hata 14001`
yazıyorsa: bilgisayarda **Visual C++ 2005 SP1 (x86)** çalışma zamanı yok
(`0x800736B1`, "yan yana yapılandırma"). Syntec'in native DLL'leri buna bağlı.
Kurulum (Setup.exe) bunu kendisi kurar; elle kurmak için Microsoft İndirme Merkezi
id 26347, `vcredist_x86.exe`, sonra ajan görevini yeniden başlatın.

**`BadImageFormatException`**
Ajan 64-bit derlenmiş. Betik `/platform:x86` kullanıyor; elle derlediysen onu ekle.

**`0x80131515`**
DLL'ler bloke. `Get-ChildItem <paket> -Recurse | Unblock-File`

**Ajan SYSTEM olarak çalışamıyor**
Zamanlanmış görev ajanı SYSTEM hesabıyla çalıştırıyor. Syntec DLL'leri bundan
rahatsız olursa Görev Zamanlayıcı'da görevi aç, **Genel** sekmesinde hesabı
kendi kullanıcına çevir ve "Kullanıcı oturum açmasa da çalıştır"ı işaretle.

> Betik Windows'ta **henüz çalıştırılmadı** — bu ortamda PowerShell yok, yalnızca
> elle gözden geçirildi. İlk çalıştırmada bir hata çıkarsa çıktıyı paylaş,
> düzeltelim.

## Elle çalıştırma (kurulum olmadan)

Denemek ya da teşhis için, iki ayrı pencerede:

```powershell
# pencere 1 - proje klasorunde
npm start

# pencere 2 - Syntec Bin klasorunde
.\syntec-agent.exe --ingest http://127.0.0.1:3000/api/ingest
```

Tek tezgahı denemek için: `--host 192.168.88.99 --machine-id CNC-01`
