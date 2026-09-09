# Saha Kontrol Listesi

Gereksinim belgesinin (CNC-TLM-001) **Bölüm 03**'ünü sahada doldurmak için çalışma
listesi. Kutuları işaretleyerek ilerle; öğrenilen bilgileri "Bulgular" bölümüne yaz.

> Öncelik sırası (bilgi değerine göre): **2 → 3 → 1 → 4**
> Ama **1'i bugün gönder** — bayi cevabı günler alır, o saat işlerken diğerlerini yap.

---

## Bilinenler

Tezgahların kendi ekranlarından okundu — doğrulanmış birincil bilgi.

| Alan | Değer |
|---|---|
| CNCModel | SYNTEC 11B (panel üzerinde: 11TB) |
| Tezgah üreticisi | ARIX |
| Product / Server / Client Ver | 10.116.54S |
| Image Ver | 7.68 |
| PLC Ver | 1.01 |
| Platform | Windows CE |
| CPUBoard | AM335x-H (TI Sitara ARM) |
| MachineType | Lathe (torna) |
| Bilinen kontrolcü serileri | M9L4379 · M4L0007 |
| Tezgah modeli | **ARIX T-42CL** |
| Tezgah seri no | 20062108 (hangi kontrolcüye ait olduğu teyit edilmedi) |
| Üretim tarihi | **2020.06** |
| Spindle | 7.5 kW · azami 6000 rpm |
| Besleme | 3 faz 380V · 15 kVA · 3330 kg |
| **ARIX iletişim** | **+886-6-384-1900** · Tainan, Tayvan |

**Filo tek tip:** Birden fazla tezgah var, hepsi aynı kontrolcü ve aynı yapılandırma.
Karma marka filosu riski (Bölüm 12) gerçekleşmedi — bir adaptör yazılıp N tezgaha
kopyalanacak.

**Bu bir legacy tezgah değil** — modern, ağa bağlanabilir kontrolcü. Sensör retrofit
riski gündemden düştü.

### Kapanan sorular

- [x] **LAN portu var mı?** → **VAR.** Panonun arkasında RJ45, "LAN" etiketli,
      şu an boşta. Yanında RS485 (DB9) ve SPINDLE terminal bloğu.
- [x] **Software Option listesinde RemoteAPI lisansı var mı?** → **Yok.** 40 opsiyon
      slotunun tamamı talaşlı imalat / hareket kontrolü özelliği (RTCP, STCP,
      five-axis, CAD/CAM, Vision, Wood…). Tek bir haberleşme/ağ/API kalemi yok.
      Yorum: RemoteAPI bu kontrolcünün opsiyon sisteminde ücretli kalem olarak
      tanımlı değil — lisans gerekme ihtimali düştü, ama kesin kanıt değil.
- [x] **Machine Builder Info bir şey söylüyor mu?** → **Hayır.** Üretici alanları
      boş bırakmış (Machine Model, Serial No, Built Date, Builder Phone). Yalnızca
      Builder Code `6***` ve PLC Ver 1.01 var. Bu yol kapalı — bayi sorusu kritik.

### Açık nokta

Gövde etiketi tek bir tezgahtan alındı (seri 20062108). Bu etiketin hangi
kontrolcüye (M9L4379 mi, M4L0007 mi) ait olduğu teyit edilmedi — diğer
tezgahların etiketleri çekilince eşleştirilecek.

### Bakılacak iki ipucu

Software Option listesindeki tek imalat-dışı kalem **"04. Enabled PlugIn Function"**,
ve alt menüdeki **"Online Service"** butonu. İkisi de eklenti/uzaktan bağlantı
yeteneğine işaret ediyor olabilir — fırsat olursa bu ekranlara da bakılmalı.

---

## 1. Bayiye sorulacaklar

- [ ] Tezgahı satan firmaya aşağıdaki e-posta gönderildi
- [ ] Cevap alındı

<details>
<summary>Gönderilecek metin (kopyala)</summary>

> Elimizde SYNTEC 11B kontrolcülü bir torna var. Kontrolcü bilgileri:
> CNCModel: SYNTEC 11B · CNCSerial: M9L4379 · Product Ver: 10.116.54S ·
> Image Ver: 7.68 · PLC Ver: 1.01 · MachineType: Lathe
>
> Üretim verilerini (çalışma durumu, spindle devri, ilerleme, aktif program,
> parça sayacı, alarmlar) ağ üzerinden okumak istiyoruz. Sorularımız:
>
> 1. Bu kontrolcü ve bu yazılım sürümü RemoteAPI'yi destekliyor mu?
> 2. Destekliyorsa bu ünitede aktif mi, yoksa ayrıca lisans/opsiyon satın
>    almamız mı gerekiyor? Bedeli ve tedarik süresi nedir?
> 3. Bu sürümde Modbus TCP (LAN üzerinden slave) kullanılabiliyor mu?
> 4. Gerekiyorsa yazılım yükseltmesi mümkün mü, bedeli ve riski nedir?
> 5. RemoteAPI dokümanı ve SDK'sını bizimle paylaşabilir misiniz?
> 6. Tezgahın **PLC adres haritasını** paylaşabilir misiniz — parça sayacı,
>    çevrim süresi ve durum bitleri hangi PLC register'larında tutuluyor?
>    Tezgah: ARIX T-42CL, seri 20062108, üretim 2020.06, PLC Ver 1.01.

**Bu 6. madde ayrıca doğrudan ARIX'e de sorulabilir** — gövde etiketinden çıkan
iletişim: **+886-6-384-1900** (ARIX CNC Machines Co., Ltd., Tainan, Tayvan).
Parça sayacı ve çevrim süresi CNC çekirdeğinde değil, ARIX'in yazdığı PLC ladder
programında tutuluyor; bu adresleri yalnızca ARIX bilir.

- [ ] ARIX'e PLC adres haritası soruldu

</details>

Bağımsız ikinci teyit yolu (bayi cevabını beklemeden):

- [ ] EMQX Neuron'a soruldu: SYNTEC sürücüleri 11B / 10.116.54S destekliyor mu

---

## 2. Makine başında — fotoğraflanacak ekranlar

En kritik adım bu. Dördünün de fotoğrafını çek.

- [x] **System Permissions** ekranı — yapıldı, bulgular yukarıda
- [x] **Machine Builder Info** ekranı — yapıldı, alanlar boş çıktı
- [x] **Gövde etiketi** — yapıldı, ARIX T-42CL / 20062108 / 2020.06 okundu
- [ ] Diğer tezgahların gövde etiketleri (her birinin seri no + üretim tarihi)
- [ ] **Online Service** ekranı — alt menüdeki buton, bağlantı ayarı içerebilir
- [ ] **Set Kernel Server** ekranı — `F5 Maintain` → `F2 Set Kernel Server`
      → CNC'nin IP adresi ve ağ ayarları
- [x] **Panonun arkası** — yapıldı, LAN portu var ve boşta

---

## 3. Ağ bağlantı testi

Atölye ağı kurmaya gerek yok: ilk kanıt için laptopu **tek kabloyla doğrudan**
CNC'ye bağlayabilirsin (modern ağ kartları çapraz kablo istemez).

- [ ] Laptopa CNC ile aynı subnet'ten boş bir IP verildi
      (CNC `192.168.1.10` ise laptop `192.168.1.100`, maske `255.255.255.0`)
- [ ] `ping <CNC_IP>` cevap veriyor
- [ ] Port taraması yapıldı, açık portlar not edildi

```powershell
$ip = "192.168.1.10"   # CNC'nin IP adresi
1..10000 | ForEach-Object {
  $c = New-Object System.Net.Sockets.TcpClient
  if ($c.ConnectAsync($ip, $_).Wait(200)) { "AÇIK: $_" }
  $c.Close()
}
```

> **Dikkat:** Tezgah parça kesmezken yap ve işletme sorumlusuna haber ver.
> Salt okunur bir işlemdir, zarar vermez — ama habersiz yapılmaz.
> Windows CE gömülü bir cihaz olduğu için tarama yavaş tutuldu (200 ms).

**Bu testin değeri:** Açık port, lisans tartışmasını teknik olarak bitirir.
Kapalı bir lisans dinleyen port bırakmaz.

---

## 4. Kapsam kararları

Makineyle ilgili değil — proje kapsamıyla ilgili, kod yazılabilmesi için gerekli.

- [x] ~~Hepsi Syntec 11B mi, karma mı?~~ → **Tek tip, hepsi aynı config**
- [ ] Kaç tezgah bağlanacak? (kesin sayı gerekiyor — `config/machines.json`'a işlenecek)
- [ ] Edge Agent PC'si nerede duracak (atölye / ofis)?
- [ ] Atölyede hâlihazırda ağ var mı, yoksa sıfırdan mı kurulacak?
- [ ] Ağ/firewall değişikliğini kim onaylıyor (IT sorumlusu)?

Birden fazla tezgah bağlanacaksa: her makineden PC'ye ayrı kablo **çekilmez**.
Her makineden **switch'e** bir kablo, switch'ten PC'ye tek kablo gider.
Endüstriyel switch (DIN ray, metal kasa), blendajlı Cat6 kablo, segment başına
max 100 m, her CNC'ye sabit IP. Bu ağ ofis ağından ayrı VLAN'da tutulmalı (Bölüm 08).

---

## Bulgular

Öğrendikçe buraya yaz — ikinci PC'den de görürsün.

| Tarih | Konu | Sonuç |
|---|---|---|
| 2026-09-09 | LAN portu | Var, boşta. RJ45, "LAN" etiketli |
| 2026-09-09 | Software Option listesi | 40 slot, hepsi imalat özelliği. Haberleşme/API opsiyonu yok |
| 2026-09-09 | Machine Builder Info | Üretici alanları boş, kullanılabilir bilgi yok |
| 2026-09-09 | Filo yapısı | Birden fazla tezgah, hepsi aynı Syntec 11B config |
| 2026-09-09 | Bilinen seriler | M9L4379, M4L0007 |
|  |  |  |

---

## Sonra ne olacak

Bu liste dolduğunda:

1. Gerçek envanter `config/machines.json`'a işlenecek
2. Her tezgahın `reports` listesi, testte gerçekten okunabilen alanlara göre doldurulacak
3. Syntec adaptörü yazılacak — `Syntec.OpenCNC.dll` bir .NET kütüphanesi olduğu için
   bu tezgahın Edge Agent'ı **C#/.NET** olacak. Adapter yalnızca `/api/ingest`'e
   normalize JSON POST edecek; backend, veritabanı ve dashboard değişmeyecek.
4. Bir pilot tezgahta uçtan uca akış kanıtlanacak, sonra diğerlerine ölçeklenecek

**Not:** RemoteAPI 1.1.0 hedeflenmeli — kontrolcü sürümü desteklenen aralığın alt
ucunda olduğu için bağlantı kurulsa bile her fonksiyon çalışmayabilir. Pilot testte
hangi alanların gerçekten döndüğü tek tek doğrulanmalı.
