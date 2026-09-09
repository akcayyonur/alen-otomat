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
