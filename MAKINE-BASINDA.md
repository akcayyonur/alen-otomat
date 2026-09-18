# Makine Başında Yapılacaklar

Tek ziyarette bitecek şekilde sıralandı — ikinci kez gitmek zorunda kalma.
Telefonu yanına al, fotoğraf çekilecek yerler işaretli.

**Başlamadan:** operatöre/bakımcıya haber ver. A ve D adımları tezgah çalışırken
yapılabilir; B ve C için tezgahın parça kesmiyor olması iyi olur.

---

## A. Ekranlarda bakılacaklar (risksiz, tezgah çalışırken yapılabilir)

### A1. Parça sayacı ekranda var mı? ⭐ EN ÖNEMLİ

- [ ] Operatör ekranında **parça sayacı / workpiece count / üretilen adet**
      gösteriliyor mu? 📷

**Neden önemli:** Ekranda görünüyorsa CNC'nin kendisi biliyor demektir; RemoteAPI
muhtemelen doğrudan okur ve tezgah üreticisinin PLC adres haritasına hiç ihtiyacımız
kalmaz. Görünmüyorsa o veri PLC'de tutuluyordur ve ARIX'ten adres istememiz gerekir.

Bakılacak yerler: ana çalışma ekranı, program çalışma ekranı, varsa "üretim /
production / counter" sekmesi.

### A2. Ağ ayarları

- [ ] `F5 Maintain` → `F2 Set Kernel Server` ekranı 📷
- [ ] CNC'nin IP adresi: `________________`
- [ ] Alt ağ maskesi: `________________`
- [ ] DHCP mi sabit IP mi: `________________`

> Değer girmeden önce mevcut hâlini fotoğrafla. Hiçbir ayarı değiştirme —
> sadece oku. (IP yoksa aşağıda C4'e bak.)

### A3. Online Service ekranı

- [ ] About menüsündeki **Online Service** butonuna gir 📷

Uzaktan bağlantı / servis ayarları içerebilir. Ne çıktığını bilmiyoruz, bakmaya değer.

---

## B. Fiziksel bağlantı

- [ ] Panonun arkasındaki **LAN** portuna Ethernet kablosu tak
- [ ] Kablonun diğer ucunu laptopa tak
- [ ] Portun üzerindeki **link ışığı yanıyor mu?** (yeşil/sarı LED)

Işık yanmıyorsa: kabloyu değiştir, laptopun ağ kartının açık olduğundan emin ol.
Işık yanıyorsa fiziksel katman tamam.

---

## C. Laptop testi

### C1. Laptopu aynı ağa al

Windows → Ağ Bağlantıları → Ethernet → Özellikler → IPv4 → Aşağıdaki IP'yi kullan:

| Alan | Değer |
|---|---|
| IP adresi | CNC `192.168.1.10` ise → `192.168.1.100` (son hane farklı olsun) |
| Alt ağ maskesi | CNC'dekiyle aynı, genelde `255.255.255.0` |
| Ağ geçidi | boş bırak |

> **Not:** Laptopun mevcut ayarlarını önce not et, test sonrası geri al.

### C2. Bağlantı var mı

```powershell
ping 192.168.1.10
```

- [ ] Cevap geliyor mu? `EVET / HAYIR`

### C3. Hangi servisler dinliyor ⭐

```powershell
$ip = "192.168.1.10"   # CNC'nin IP adresi
1..10000 | ForEach-Object {
  $c = New-Object System.Net.Sockets.TcpClient
  if ($c.ConnectAsync($ip, $_).Wait(200)) { "AÇIK: $_" }
  $c.Close()
}
```

- [ ] Açık portlar: `________________________________`

Birkaç dakika sürer. **Bu listenin tamamını yaz** — hangi arayüzlerin gerçekten
aktif olduğunu bu söyler. Açık port varsa RemoteAPI lisans tartışması biter.

### C4. Ping çalışmazsa

Sırasıyla dene:

1. Laptop IP'si CNC ile **aynı subnet'te** mi? (ilk üç hane aynı olmalı)
2. `arp -a` → CNC'nin MAC adresi listede görünüyor mu (bağlantı var ama IP yanlış demektir)
3. CNC'de IP hiç tanımlı değilse: A2'deki ekrandan sabit IP verilmesi gerekir.
   **Bunu tek başına yapma** — üretim makinesinde ayar değişikliği, bakımcıyla birlikte yap.
   Değiştirmeden önce eski değeri fotoğrafla.

---

## D. Envanteri tamamla — HER TEZGAH İÇİN

Kaç tezgah varsa hepsi için tekrarla. Tablo boş bırakılan yerleri doldur.

| # | Kontrolcü seri (About ekranı) | Gövde etiketi: model | Gövde etiketi: seri | Üretim tarihi |
|---|---|---|---|---|
| 1 | M9L4379 | ? | ? | ? |
| 2 | M4L0007 | ? | ? | ? |
| 3 |  |  |  |  |
| 4 |  |  |  |  |
| 5 |  |  |  |  |

- [ ] **Toplam tezgah sayısı:** `______`
- [ ] Her tezgahın About ekranı 📷
- [ ] Her tezgahın gövde etiketi 📷

> Şu an elimizde 2 kontrolcü serisi (M9L4379, M4L0007) ve 1 gövde etiketi
> (ARIX T-42CL, 20062108, 2020.06) var — ama etiketin hangi kontrolcüye ait
> olduğu belli değil. Bu tablo o eşleşmeyi kuracak.

---

## Dönüşte paylaşılacaklar

1. A1 — parça sayacı ekranda var mı 📷
2. A2 — ağ ayarları ekranı 📷
3. C2/C3 — ping sonucu ve açık port listesi
4. D — doldurulmuş tablo + toplam tezgah sayısı

Bu dördü gelince: envanter `config/machines.json`'a işlenir, `reports` listesi
gerçeğe göre düzeltilir ve Syntec RemoteAPI adaptörünü yazmaya başlayabiliriz.

---

## 2026-09-18 saha ziyareti — CNC-01 (M9L4379 / BERG\140100187)

### Yapılanlar

- [x] **Online Service** ekranı → **elendi.** Yalnızca Syntec müşteri hizmetlerini
      arama sihirbazı (WeChat / Common User seçimi). Veri entegrasyonuyla ilgisi yok.
- [x] **LAN kablosu takıldı** → link kuruldu, laptopta `Status: Up, 100 Mbps`.
      **Port fiziksel olarak çalışıyor.**
- [x] **Ağ ayarları okundu ve değiştirildi** (aşağıda)
- [x] **Ping / ARP testi** → cevap yok
- [ ] Port taraması — bağlantı kurulamadığı için yapılamadı
- [ ] Parça sayacı ekranda var mı — bakılmadı, sonraki ziyarette
- [ ] Diğer tezgahların envanteri — bakılmadı

### Değiştirilen ayar — geri almak gerekirse

`F5 Maintain` → `F2 Set Kernel Server`

| Alan | ÖNCE (orijinal) | SONRA (şu anki) |
|---|---|---|
| IP Address Setting | `Obtain an IP Address via DHCP` | `Specify an IP Address` |
| IP Address | 192.168.24.107 *(DHCP altında görünen, bağlı değildi)* | **192.168.88.99** |
| Subnet Mask | 255.255.255.0 | 255.255.255.0 |
| Default Gateway | 192.168.24.1 | **192.168.88.1** |
| Primary DNS | 192.168.24.1 | 0.0.0.0 |

> "Specify an IP Address" seçilince kontrolcüde eskiden kayıtlı statik profil çıktı:
> IP `192.168.88.99`, Gateway `10.10.65.1` (tutarsız, subnet dışı). Gateway
> `192.168.88.1` yapılarak tutarlı hale getirildi.

### Sonuç: kontrolcü IP'yi devreye almadı

Ayar kaydedildi ve ekranlar arasında kalıcı — yani yazma çalışıyor. Ama:

- `ping 192.168.88.99` → cevap yok
- `arp -d *` sonrası `arp -a` → `.99` için MAC adresi yok

ARP seviyesinde bile cevap yoksa cihaz o adreste değildir; TCP de çalışmaz.
**Kontrolcü IP yapılandırmasını yalnızca açılışta uyguluyor** (gömülü sistemlerde
standart davranış). Yapılabilecek ayar kalmadı.

### Öğrenilen: `Net Status` satırı yanıltıcı

`Net Status: Code 1222 The network is unreachable`, **genel ağ durumu değil** —
"Network Disk Remote Host Path" bölümünün altında ve CNC'nin `\\SYNTECCNC\PUBLIC`
paylaşımına bağlanma durumunu gösteriyor. Ağda o isimde bir PC olmadığı için IP
ayarı düzelse bile bu satır "unreachable" kalır. **Gösterge olarak kullanma.**

### Yan bulgu: SMB paylaşımı var

`Resource Shared → Shared Folder Path: \DiskA\OpenCNC\NcFiles`
Kontrolcü kendi klasörünü ağa paylaşabiliyor, ayrıca uzak bir Windows paylaşımını
(`SYNTECCNC` / `PUBLIC`) bağlayabiliyor. Yol adındaki **OpenCNC**, RemoteAPI'nin
kütüphanesi `Syntec.OpenCNC.dll` ile aynı isim. RemoteAPI çıkmazsa yedek yol.

---

## SONRAKİ ZİYARET — buradan devam et

### 1. Kontrolcüyü yeniden başlat

Operatörle birlikte, tezgah parça ortasında değilken kapat-aç.

### 2. Laptopu hazırla

```powershell
$eth = "Ethernet"
Set-NetIPInterface -InterfaceAlias $eth -Dhcp Disabled
Remove-NetIPAddress -InterfaceAlias $eth -AddressFamily IPv4 -Confirm:$false -ErrorAction SilentlyContinue
New-NetIPAddress -InterfaceAlias $eth -IPAddress 192.168.88.100 -PrefixLength 24
```

### 3. Bağlantıyı test et

```powershell
ping 192.168.88.99
arp -a | Select-String "192.168.88"
```

### 4. Cevap gelirse: port taraması ⭐

```powershell
$ip = "192.168.88.99"
$liste = 21,22,23,25,53,80,102,135,139,443,445,502,548,990,1024,1025,1433,2000,2001,3000,3389,4000,4840,5000,5001,5050,5051,5060,5555,6000,7000,8000,8080,8081,8090,9000,9100,10000,20000,44818
$acik = @()
foreach ($p in $liste) {
  $c = New-Object System.Net.Sockets.TcpClient
  try { if ($c.ConnectAsync($ip,$p).Wait(300)) { $acik += $p; Write-Host "ACIK: $p" -ForegroundColor Green } } catch {}
  $c.Close()
}
Write-Host "`nHizli tarama: $($acik -join ', ')"
```

### 5. Reboot sonrası da cevap yoksa

Kontrolcünün ağ arayüzü donanımsal ya da yazılımsal olarak pasif olabilir.
O noktada bayiye/ARIX'e sorulacak soru netleşir: *"LAN portu etkin mi, etkinleştirmek
için bir parametre veya opsiyon gerekiyor mu?"*

### 6. Laptopu geri al

```powershell
Remove-NetIPAddress -InterfaceAlias $eth -AddressFamily IPv4 -Confirm:$false -ErrorAction SilentlyContinue
Set-NetIPInterface -InterfaceAlias $eth -Dhcp Enabled
Set-DnsClientServerAddress -InterfaceAlias $eth -ResetServerAddresses
```

---

## 2026-09-18 — reboot sonrası: BAĞLANTI KURULDU ✅

Kontrolcü yeniden başlatıldı ve IP ayarı devreye girdi. Teşhis doğruymuş:
**Syntec 11B ağ yapılandırmasını yalnızca açılışta uyguluyor.**

```
ping 192.168.88.99  →  4/4 cevap, TTL=128, ort. 2 ms
ARP                 →  00-35-ff-74-b7-5f
```

### Açık portlar (1-10000 tam tarama)

| Port | Servis | Durum |
|---|---|---|
| 21 | FTP | `220 Service ready for new user.` — **anonim giriş açık** (`230 User logged in`) |
| 23 | Telnet | Canlı, IAC anlaşma baytları gönderiyor |
| 80 | HTTP | Windows CE fabrika web sunucusu, kökte placeholder sayfa |
| 443 | HTTPS | İstek bekliyor |
| **5678** | **bilinmiyor — ikili protokol** | Sessiz, HTTP'ye cevap vermiyor |
| **8080** | **bilinmiyor — ikili protokol** | Sessiz, HTTP'ye cevap vermiyor |

### 5678 ve 8080 — RemoteAPI adayları

Ham TCP üzerinden `GET / HTTP/1.1` gönderildi, ikisi de **cevapsız** kaldı.
Bağlantıyı kabul ediyor ama HTTP anlamıyorlar → üreticiye özel ikili protokol.
Bir API endpoint'inin tipik davranışı: istemcinin kendi protokolüyle konuşmasını
bekliyor.

> Tarayıcıda 8080'e giderken alınan "502 Bad Gateway" CNC'den değil, laptoptaki
> kurumsal proxy'den geliyordu. Ham soket testi bunu ayırt etti.

### Bunun anlamı: lisans sorusu fiilen kapandı

Kontrolcüde çalışan ve dışarıya port açan servisler var. **Kapalı bir opsiyon
dinleyen port bırakmaz.** Geriye kalan soru "lisansımız var mı" değil, "bu
portlarla nasıl konuşulur" — yani **RemoteAPI SDK ve dokümanı**.

### Sıradaki adım: SDK'yı almak

Bayiye/ARIX'e gidilecek soru artık çok daha güçlü ve somut:

> Kontrolcü ağa bağlandı (Syntec 11B, 10.116.54S). TCP 5678 ve 8080 portları
> açık ve ikili bir protokol konuşuyor. Bu portlarda hangi servis çalışıyor?
> RemoteAPI dokümanını ve SDK'sını (`Syntec.OpenCNC.dll`) paylaşabilir misiniz?

### Kalan saha işleri

- [ ] FTP kök dizin listesi (anonim giriş çalışıyor) — dosya sistemini görmek için
- [ ] Parça sayacı operatör ekranında var mı — hâlâ bakılmadı
- [ ] Diğer tezgahların envanteri (About + gövde etiketi) ve toplam sayı
- [ ] Diğer tezgahlara da statik IP + reboot (aynı prosedür, IP'ler farklı olmalı)
