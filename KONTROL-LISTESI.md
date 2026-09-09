# Saha Kontrol Listesi

Gereksinim belgesinin (CNC-TLM-001) **Bölüm 03**'ünü sahada doldurmak için çalışma
listesi. Kutuları işaretleyerek ilerle; öğrenilen bilgileri "Bulgular" bölümüne yaz.

> Öncelik sırası (bilgi değerine göre): **2 → 3 → 1 → 4**
> Ama **1'i bugün gönder** — bayi cevabı günler alır, o saat işlerken diğerlerini yap.

---

## Bilinenler

Aşağıdakiler tezgahın kendi About ekranından okundu — doğrulanmış birincil bilgi.

| Alan | Değer |
|---|---|
| CNCModel | SYNTEC 11B |
| CNCSerial | M9L4379 |
| Product / Server / Client Ver | 10.116.54S |
| Image Ver | 7.68 |
| PLC Ver | 1.01 |
| Platform | Windows CE |
| CPUBoard | AM335x-H (TI Sitara ARM) |
| MachineType | Lathe (torna) |

**Sonuç:** Bu bir legacy tezgah değil — modern, ağa bağlanabilir bir kontrolcü.
Sensör retrofit riski (Bölüm 12) bu makine için gündemden düştü.

**Açık olan iki soru:** RemoteAPI bu ünitede etkin mi, ve ücretli lisans gerekiyor mu.
Aşağıdaki adımlar bu ikisini kapatmak için.

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

</details>

Bağımsız ikinci teyit yolu (bayi cevabını beklemeden):

- [ ] EMQX Neuron'a soruldu: SYNTEC sürücüleri 11B / 10.116.54S destekliyor mu

---

## 2. Makine başında — fotoğraflanacak ekranlar

En kritik adım bu. Dördünün de fotoğrafını çek.

- [ ] **System Permissions** ekranı — About ekranının altındaki buton
      → RemoteAPI opsiyonu açık mı görünüyor mu
- [ ] **Machine Builder Info** ekranı — yanındaki buton
      → tezgah hangi opsiyonlarla sipariş edilmiş
- [ ] **Set Kernel Server** ekranı — `F5 Maintain` → `F2 Set Kernel Server`
      → CNC'nin IP adresi ve ağ ayarları
- [ ] **Panonun arkası / yanı** — fiziksel
      → RJ45 portu var mı, kablo takılı mı

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

- [ ] Kaç tezgah bağlanacak? Hepsi Syntec 11B mi, karma mı?
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
