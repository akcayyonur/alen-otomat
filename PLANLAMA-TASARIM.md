# Planlama modülü — tasarım önerisi (iş emri, hammadde, verimlilik)

**Durum: ÖNERİ, kullanıcı onayı bekliyor, kod yok.** Telemetri uygulamasına bağlı ikinci ürün. Bu belge müşteri
verisi içermez (depo herkese açık); sayılar yalnızca yapıyı göstermek için, adlar yok.

## 1. Amaç

Siparişten iş emrine, iş emrinden tezgahtaki gerçek üretime ve hammadde tüketimine kadar tek akış:
- **İş emri:** Mikro'daki siparişten ürün seçilerek oluşturulur; Excel (PLANLANAN + İŞ EMRİ sayfaları) emekli olur.
- **Hammadde:** planlanan ihtiyaç, gerçekleşen (teorik) sarfiyat, talaş, ay sonu sarfiyat listesi.
- **Verimlilik:** planlanan süre ile tezgahta ölçülen süre, plan sapması, termin riski.

## 2. İlkeler

1. **Mikro siparişin, stoğun ve deponun sahibi** (şimdilik yalnız okunur). Biz üretim planını, iş emrini ve gerçekleşeni tutarız.
2. **Telemetri gerçekleşenin tek kaynağı:** adet, süre, vardiya kırılımı elle yazılmaz (formun alt tablosu otomatik dolar).
3. **İş emri değerleri anlık kopyadır:** ürün kartı sonradan değişse eski iş emri değişmez (gerçek veride brüt gramaj
   ve planlanan süre zamanla değişmiş).
4. **Tahmin yazılmaz, öneri sunulur:** ölçülen süre ürün kartını kendiliğinden ezmez, "güncelle" önerisi çıkar.
5. **Müşteri verisi `data/` içinde** (git dışı). Mikro'ya yazma en son, test veritabanı ve bayi onayıyla.

## 3. Veri modeli (yeni SQLite: `data/planlama.db`, ayrı yedeklenir)

| Tablo | İçerik |
|---|---|
| `order_lines` | Sipariş satırı: kaynak (`csv`/`mikro`), evrak no, satır sırası, müşteri, **müşteri sipariş no**, mamul kodu, mamul adı, sipariş tarihi, miktar, sevk edilen, kalan, termin, **hammadde kodu** (sipariş satırında belirtilir; Mikro'daki ürün reçetesinden gelir). |
| `products` | **Ürün kartı** (stok kodu anahtar): ad, müşteri ürün kodu, hammadde kodu, alternatif hammadde, **tam boy (mm, teknik resimden)**, net gr, brüt gr, planlanan çevrim sn, notlar. Brüt gramaj ve çubuk sayısı (BOY) tam boydan hesaplanır (bkz. §6). Değişiklik geçmişi ayrı tutulur. |
| `product_programs` | Program adı → stok kodu eşlemesi (büyük/küçük harf duyarsız), kaynak (öneri / elle), onaylayan. |
| `materials` | Hammadde: kod, ad/alaşım, çubuk (boy) bilgisi, (Mikro okuma gelince) merkezi depo bakiyesi. |
| `work_orders` | İş emri: no (yıl + 6 haneli sıra, ör. 2026001055), durum, **tezgah (CNC-01..08)**, stok kodu, sipariş bağı (evrak no, müşteri sip. no, satır), hedef adet, termin, **numune adedi** (boş/0 = numune yapılmaz; siparişe göre değişir), **anlık kopya alanları** (ad, müşteri kodu, hammadde, alt. hammadde, tam boy, net/brüt gr, planlanan sn), kullanılan hammadde (gerçek: asıl/alt./diğer), **hammadde GK no** (giriş kalite kontrol, izlenebilirlik), GKK rapor no, ilk onay rapor no, **ölçülen net gramaj**, açıklama, başlangıç/bitiş, kapanış kopyası (gerçekleşen adet, ölçülen sn). |
| `downtime_codes` · `downtime_reasons` | Duruş kodu listesi (D1–D46, Z1–Z4) ve ölçülen duruşlara atanan nedenler (bkz. 7.1). |
| `work_order_events` | Denetim: kim, ne zaman, ne yaptı (oluşturma, durum geçişi, düzenleme). |

Gerçek veriden gelen kısıtlar (sipariş dosyasında ölçüldü):
- Müşteri sipariş no **benzersiz değil:** bir kısmı birden çok Mikro siparişine yayılıyor, birkaçı birden çok müşteride geçiyor,
  "NUMUNE" gibi tekrar eden metinler var. Arama sonuçta **liste** gösterir (müşteri, evrak no, tarih); tek sonuç varsayılmaz.
- Bir siparişte **çoğunlukla birden çok ürün** var; aynı evrakta aynı ürün **birden çok satır** olabilir (satır sırası anahtara girer).
- Açık satırların hepsinde müşteri sipariş no dolu; eski satırlarda boş olabilir (evrak no ile aranır).
- Aynı ürüne çok iş emri açılıyor (parti parti): sipariş satırına **birden çok iş emri** bağlanabilir.

## 4. İş emri oluşturma akışı

1. **Müşteri sipariş no** yazılır (ya da evrak no); eşleşen siparişler listelenir, seçilir.
2. Siparişin **ürün satırları** tablo olur: mamul kodu, ad, sipariş, sevk edilen, kalan, "iş emrine bağlanan", "planlanmamış kalan".
3. Bir satır seçilir; **ürün kartından** hammadde, brüt/net gramaj, planlanan süre, müşteri ürün kodu gelir.
   Ürün kartı yoksa "yeni ürün kartı" açılır (ölçüler → tahmini brüt, usta süre tahmini).
4. Girilenler: **hedef adet** (öneri: planlanmamış kalan), **termin** (öneri: sipariş termini), **tezgah 1–8**, **numune adedi** (isteğe bağlı), açıklama.
   Hammadde sipariş satırından (reçeteden) gelir.
   Ekranda hesap görünür: planlanan toplam süre (adet × sn), toplam hammadde (kg).
5. **Kaydet:** numara otomatik verilir (mevcut biçim), **yazdırılabilir form** (mevcut formla aynı düzen) açılır. Formda
   GKK ve ilk onay rapor no elle girilir; alt TARİH/VARDİYA/ADET tablosu telemetriden dolar.

## 5. İş emri yaşam döngüsü ve telemetri bağlantısı

`Planlandı → Üretimde → Bitti` (ya da `İptal`). **(Uygulandı, 0.10.0; aşağıdaki "otomatik başlama" yerine başlat/bitir insan eylemi oldu, bkz. 7.2: pencere ve tezgah belli, adet telemetriden; numune ayrı bir durum değil, ilk N adet üzerinden öneri.)**

- **Eşleştirme kuralı:** tezgahtaki üretim olayı (zaten saklanıyor: tezgah, program, adet, zaman, çevrim süresi) şu üç koşulla iş emrine yazılır:
  aynı **tezgah** + program eşlemesi o **ürüne** gidiyor + zaman iş emrinin açık penceresinde.
- **Aynı tezgahta aynı ürün için aynı anda tek açık iş emri.** Başka ürün çalışırsa o iş emrine yazılmaz.
- **Eşlenmemiş program** çalışırsa uyarı: "CNC-03'te eşlenmemiş program çalışıyor" (eşleme ekranına kısayol).
- **Otomatik başlama:** ilk eşleşen parçada iş emri başlar. **Numune adedi iş emrinde girilir** (her siparişte numune yapılmaz,
  adet değişir): girildiyse ilk N adet "Numune" sayılır ve bitince ölçülen ortalama süre **"ürün kartına yaz" önerisi** olarak
  çıkar (kendiliğinden yazılmaz). Girilmediyse numune aşaması yoktur; ölçülen süre yine iş emri kapanışında planlananla karşılaştırılır.
- **Bitirme elle** (hedefe ulaşınca öneri çıkar). Bitince gerçekleşenler **dondurulur** (sonradan veri değişse rapor değişmez).
- **Program ↔ ürün eşlemesi:** öneri kuralları `SR001-013 → SR001.013` (tire/nokta, Türkçe İ), ya da müşteri koduyla adlanan programlar;
  belirsizler (bir koda birden çok ürün) ve kurala uymayanlar elle seçilir. Telemetride görülen ama eşlenmemiş program adları listelenir.

## 6. Hammadde

- **İhtiyaç (planlama):** açık/planlanan iş emirleri hammadde koduna göre toplanır: kg (ve çubuk sayısı). Alternatif hammadde varsa
  iş emrinde hangisinin kullanılacağı seçilir. (Mikro okuma gelince merkezi depo bakiyesiyle karşılaştırılıp **eksik uyarısı**.)
- **Gerçekleşen sarfiyat (teorik):** üretilen adet × brüt gramaj, kullanılan hammaddeye göre. Numune dahil.
- **Çubuk sayısı (BOY):** gerçek veride iş emirlerinin %86'sında **adet × (tam boy + 2 mm) ÷ 2900 mm** ile birebir tutuyor
  (çubuk 3 m, faydalı 2900 mm; 2 mm kesim payı). **Kullanıcı onayladı (2026-10-12)**; sabitler (2900, 2) Ayarlar'da değiştirilebilir olur.
- **Talaş:** (brüt − net) × adet = beklenen talaş kg. Talaş çıktısı zaten bekleniyor ve satılıyor; biz iş emri ve ay bazında
  beklenen talaşı hesaplayıp satılan talaşla karşılaştırmaya yarar bilgi veririz. **Fire (hatalı parça adedi) tutulmaz.**
- **Ay sonu raporu:** hammadde bazında kg + iş emri kırılımı + CSV → sarfiyat fişinin hazırlanması için liste.
  Fişin Mikro'ya yazılması **en son aşama** (önce rapor).
- **Sınırlar (dürüst olalım):** sarfiyat teoriktir (çubuk tartımı değil); sayaç **hatalı parçayı ayıramaz** (bozuk parça da sayılır).
- **Reçete:** Mikro'da ürün reçeteleri tanımlı. İlk aşamalarda hammadde sipariş satırından/ürün kartından gelir; Mikro okuma (F)
  gelince reçeteden okunur.

## 7. Verimlilik ve duruş (bugünkü "Üretim Kartı Verileri" Excel'inin otomatikleşmesi)

**Bugünkü hesap (Excel'den çıkarıldı):**
- **Verimlilik % = gerçek üretim adedi ÷ hedef adet**, tezgah × ürün × vardiya için. **Hedef adet = ürüne ayrılan süre (sn) ÷ planlanan çevrim (sn)**.
  Ayrılan süre çoğunlukla vardiyanın tamamı (12 saat = 43200 sn); vardiyada ürün değişince **elle** bölünüyor (6 sa, 2 sa …).
- Aynı vardiyada birden çok ürün varsa tezgahın vardiya verimliliği **ürünlerin süre ağırlıklı ortalaması** (ör. 10 sa × %96 + 2 sa × %50 → ÷ 12).
- Üstüne: günlük vardiya ortalaması (tezgahlar arası), günlük, haftalık ve aylık ortalama.
- Her satırda brüt/net birim ağırlık, **dara (= brüt − net, talaş)**, brüt/net toplam ve talaş kg.
- **Duruş sayfası:** tezgah × gün için dakika, **46 duruş kodu (D1–D46)** + **4 kayıp kodu (Z1–Z4)** (ürün değişikliği, çubuk değişimi,
  günlük temizlik, hava yok, barfeeder arızası, hammadde yok, iş emri yok …). Çubuk değişimi ve temizlik gibi bazıları her gün sabit dakika.
- **Aylık özet sayfası bozuk:** formüller `#REF!`, tarihler 2021 şablonundan, aylık ortalama `#DIV/0!`.
- Mevcut verimlilik değerlerinin **%36–39'u %100'ün üstünde, %7'si %150'nin üstünde**: planlanan süreler fazla temkinli ya da
  ayrılan süreler tutarsız. Elle girilen süre ve adet bu hatanın kaynağı.

**Otomatik hesap (aynı formül, el emeği yok):**

| Gösterge | Tanım | Kaynak |
|---|---|---|
| **Verimlilik %** | gerçek adet ÷ (ayrılan süre ÷ planlanan sn) — bugünkü tanımla aynı | telemetri adet + ürün kartı |
| **Ayrılan süre** | vardiyada o ürünün tezgahta fiilen çalıştığı süre (program çalışma aralıkları); elle düzeltilebilir | telemetri (yeni: program çalışma aralıkları) |
| **Kullanılabilirlik (A)** | tezgahın RUNNING süresi ÷ ayrılan süre | durum aralıkları |
| **Performans (P)** | planlanan çevrim ÷ ölçülen çevrim | telemetri çevrim süresi |
| **Plan sapması** | planlanan toplam süre ile ölçülen toplam süre | iş emri kapanışı |
| **Termin riski** | kalan adet × ölçülen çevrim ile termin | canlı |

**Verimlilik = A × P** (yaklaşık, tezgah çalışırken sürekli parça üretiyorsa): ekran %93 diyorsa nedenini ayırır —
"%95 kullanılabilirlik × %98 hız". Düşükse sorun duruş mu yavaşlık mı belli olur. %100'ü aşan ürünler "planlanan süreyi
güncelle" önerisi olarak listelenir (otomatik değiştirilmez).

**Üç süre ayrı gösterilir:** planlanan (ör. 25 sn), ölçülen çevrim (ör. 24,3 sn) ve parçalar arası süre (ör. ≈ 26,5 sn). Gerçek tezgah
kaydında aralarında ~%6–10 fark var: çevrimler arası kayıp (besleme/yükleme). Bugünkü Excel'de ortalama verimlilik %93–96 çıkması
bununla uyumlu (25 ÷ 26,5 ≈ %94). Fark gizlenmez, "çevrimler arası kayıp" olarak ayrı gösterilir.

**Kalite (fire) ölçülmez:** hatalı parça adedi hiçbir belgede tutulmuyor ve sayaç onu ayıramaz; OEE'nin kalite ayağı yok. **(Teyit, 2026-10-12 akşam: ürün tanıtım kartındaki ret/hurda/yeniden işlem alanları da sistemde TUTULMAZ; bkz. 7.2.)**

**Duruş kayıtları:**
- Duruşlar telemetriden **ölçülür** (boşta/alarm aralıkları). Ayarlar'da **duruş kodu listesi** (bugünkü D1–D46, Z1–Z4 aynen aktarılır).
- Her duruş aralığına **neden kodu atanır** (admin); atanmamış duruşlar "nedeni belirsiz" olarak görünür.
- Ölçülemeyen/sabit kalemler (ör. çubuk değişimi, günlük temizlik) için **gün/tezgah/kod/dakika elle giriş** de açık kalır.
- Aylık duruş tablosu bugünkü sayfanın aynı düzeninde (tezgah × gün × kod) çıkar.

**Aylık Üretim Kartı (raporlar):** bugünkü dört sayfanın otomatik karşılığı, ay ve CSV/Excel çıktısı olarak:
günlük tezgah × ürün satırları (adet, hedef, verimlilik, ağırlıklar, talaş) · verimlilik matrisi (tezgah × gün × vardiya) ·
duruş tablosu · aylık özet (toplam adet, brüt/net kg, talaş kg, günlük ortalama, ortalama verimlilik). Ek olarak ürün bazlı
(planlanan ↔ ölçülen çevrim), tezgah bazlı (A, P, adet) ve termin riski listeleri.

**Telemetriye eklenecek tek şey:** program çalışma aralıkları (`program_runs`: tezgah, program, başlangıç, bitiş). Ayrılan süre
ve ürün değişimi bundan hesaplanır; üretim olaylarından farkı, parça üretmeyen çalışmayı da kapsamasıdır.

### 7.1 Tezgah tableti (usta ekranı) — duruş nedeni ve iş emri girişi

**Bugün:** tezgah başında tablet ya da ağ YOK. Usta makine durunca nedenini kâğıt **üretim kontrol kartına** yazıyor, gün sonunda biri
bunu Excel'e (ÜRETİM KARTI VERİLERİ) giriyor. Tablet yalnızca bir plan; donanım (tablet + tezgah başı Wi‑Fi) alınana kadar iki aşamalı gidilir:

- **Aşama 1 (donanım gerekmez):** kâğıt kart sürer. Gün sonunda bir kişi **admin ekranında** (Excel yerine) tezgah × gün için
  **ölçülmüş duruşları** görür ve kartta yazan nedenlere göre kod seçer. Adet ve süre zaten telemetriden geldiği için elle yazılmaz;
  yalnızca neden ve not girilir. Ürün değişince "ürün değişikliği" önerisi hazır gelir.

**Kâğıt "Üretim Kontrol Kartı" (fotoğraftan okundu):** tezgah × gün için bir sayfa. Üstte tarih ve makine no; **4 ürün bloğu** ve **4 vardiya
bloğu** (Gündüz/Gece + 2 yedek). Ürün bloğu alanları: hammadde GK no, ilk onay rapor no, ürün adı (stok kodu), ürün kodu (müşteri),
vardiya hedef adedi, sipariş no, iş emri no, **kullanılan hammadde** (gerçek) ve **iş emri hammaddesi** (plan), **üretim saniyesi** (gerçek) ve
**iş emri sn.** (plan), **net gramaj** (gerçek) ve **iş emri gr.** (plan), **makine üretim sayacı** (adet). Vardiya bloğu: vardiya, **operatör adı**
ve en çok 7 duruş satırı (kod, neden, baş./bit. saati). Sağ kenarda duruş kodu listesi (D1–D44) ve Z1–Z4.
- Ürün bloğundaki iş emri alanlarının çoğu **iş emrinden kopyalanan** bilgi (ürün, kod, iş emri no, plan değerleri). Sistem bunları
  **önceden doldurulmuş basılı kart** olarak verebilir: tarih, makine, iş emri bilgileri, hedef adet hazır; usta yalnızca gerçek
  hammadde, net gramaj ve duruşları yazar. (Donanım gerekmez.)
- Gün sonu giriş ekranı kartı **birebir izler** (tezgah × gün; vardiya başına operatör ve duruşlar; ürün başına hammadde GK no, ilk onay
  no, gerçek hammadde, ölçülen net gramaj). Adet ve gerçek süre telemetriden gelir. Kartta yazan **sayaç değeri isteğe bağlı girilir ve
  ölçülenle karşılaştırılır** (sistemin doğrulanması için; fark varsa işaretlenir).
- Z1–Z4 aslında **devir düşümü** nedenleri ("…kaynaklı dev. düş."). Telemetri mil devrini ve override'ı okuyor; ileride devir düşen
  aralıklar otomatik bulunup Z kodu önerilebilir (şimdi kapsamda değil).
- Kartta **kodlar yazılı ama saat yok:** duruş süresi "10 dk" olarak baş. saati sütununa yazılmış. Ölçülen duruş aralıkları bu boşluğu kapatır.
- **Kod listeleri uyuşmuyor ve karar verildi:** kâğıt kartta kalite ve arıza kodları D21'den itibaren (D21 kalite üretimi durdurdu … D44 diğer),
  Excel'in duruş sayfasında aynı kalemler **2 numara kaymış** (D21/D22 yok, D23 … D46). D1–D20 aynı. **Karar (2026-10-12): Excel listesi esas**
  (D1–D46, Z1–Z4). Sistem **basılı kartın** sağ kenar listesini bu numaralarla basar; böylece kâğıt ve sistem aynı kodu kullanır.
  Eski (D21–D44 numaralı) kâğıt kartlar tükenene kadar gün sonu ekranında neden **adıyla** seçilir (kod yalnızca etiket), yanlış kod girişi önlenir.
- **Ürün bloğu tek satır:** kâğıtta aynı ürün Gündüz ve Gece için iki blok yazılıyor; Excel'de ve sistemde **tek satır**: ürün × (Gündüz adedi,
  Gece adedi), günün ortak kaydı olarak. Basılı kartta ürün başına tek blok, makine üretim sayacı vardiya başına iki alan.

Telemetri duruşu zaten ölçtüğü için nedeni seçen kişi (usta ya da gün sonu giren) **dakika yazmaz**; kayıt ölçülen duruş aralığıyla
otomatik eşleşir.

**Ekran (tablet, tam ekran, büyük dokunmatik düğmeler, tek tezgah):**
- Üstte tezgah, durum (çalışıyor/boşta/alarm), süre.
- **İş emri kartı:** ürün, hedef, yapılan, kalan, termin, planlanan ve ölçülen çevrim. Altında "yeni iş emri başlat" (o tezgaha
  atanmış planlı iş emirlerinden seçilir), "iş emrini bitir", numune adedi ve formdaki elle yazılan alanlar (GKK rapor no, ilk onay
  rapor no, gerçek gramaj, açıklama).
- **Duruş sorusu:** tezgah eşik süreden (varsayılan 3 dk, ayarlanabilir) uzun durunca ekranda "Tezgah N dk durdu, neden?" çıkar.
  46 kod tek ekrana sığmaz: **gruplar** (değişim/ayar · bekleme/yok · kalite · arıza/bakım · mola/planlı · diğer) → grup içinde kodlar;
  en sık kullanılanlar üstte kısayol. Seçim tek dokunuş; isteğe bağlı kısa not.
- Cevaplanmayan duruşlar "nedeni belirsiz" kalır ve **gün sonu listesinde** (admin ekranı) tamamlanır.
- Bir duruş birden çok nedene bölünebilir (ör. 40 dk çubuk değişimi + 20 dk ayarcı bekleme).

**Veri:** `downtime_codes` (kod, ad, grup, D/Z türü, sık kullanılan) ve `downtime_reasons` (tezgah, başlangıç, bitiş, kod, not, giren
kişi, giriş zamanı, kaynak: tablet/admin). Duruş = art arda gelen boşta/alarm/kapalı aralıkların birleşimi (NO_DATA duruş değildir).
Kayıtlar ölçülen aralıkla eşleşir, bu yüzden dakika hesabı telemetriden, **neden** insandan gelir.

**Kimlik ve yetki:** tabletler fabrika ağında ve herkesin erişebileceği yerde; admin hesabı **kullanılmaz**. Yeni rol **`operator`**
(tablet hesabı) **tek bir tezgaha bağlı**: yalnız o tezgahı görür; yalnız duruş nedeni atayabilir, o tezgahın iş emri başlat/bitir ve
form alanlarını girebilir; program kütüphanesi, ayarlar, başka tezgah, rapor yok. Tablet hesabını admin Ayarlar'da açar (tezgah
seçerek). Oturum uzun ömürlü (tablet sürekli açık). İsteğe bağlı: tablette **usta seçimi / PIN**, kayıtta kim girdi görünsün.
Teknik not: roller `auth.db`'de `CHECK (role IN ('admin','viewer'))` ile sabit; yeni rol için şema geçişi (tablo yeniden kurulumu +
`machine_id` kolonu) ve `policy.js` içinde yeni yol sınıfı gerekir (varsayılan reddet korunur; testleri eklenir).

**Ağ:** tabletler fabrika ağındaki (modem, 192.168.1.x) Wi‑Fi'dan alt PC'ye `http://<alt PC>:3000` ile bağlanır; torna ağına (192.168.88.x)
girmezler. Her tezgah başında Wi‑Fi çekmesi gerekir. Bağlantı koparsa tablet "bağlantı yok" uyarısı gösterir; girişler **sunucuya
ulaşana kadar tablette bekletilir** ve sıra bozulmadan gönderilir.

**Donanım (öneri):** 8–10" Android tablet, toz/yağa dayanıklı kılıf ve sabit tutucu, sürekli şarj, tam ekran (kiosk) tarayıcı.
Kurulumda yazılım yok, yalnız adres ve tablet hesabı.

**Yayılım:** önce 1–2 tezgahta **pilot**; kâğıt form bir süre paralel kalır. Benimsenme (ustaların gerçekten kullanması) en büyük risk:
ekran en az dokunuşla çalışmalı.

### 7.2 Uçtan uca akış ve "Ürün Tanıtım Kartı" (kullanıcı tarifi, 2026-10-12)

**Akış (yukarı = ofis/planlama, aşağı = fabrika PC'si; ikisi aynı sisteme tarayıcıdan girer):**

1. **Ofis** iş emrini açar (B, yapıldı) — sipariş/ürün kartı/hammadde bilgileri elle girilir ya da CSV'den gelir.
2. **Aşağıdaki PC'de** usta/operatör iş emrini seçip **"bu tezgahta başlatıyorum"** der (iş emrini doldurur: gerçek hammadde, GK no, ilk onay no…).
   Başlatma anı, tezgah ve o andaki **parça sayacı** kaydedilir; ofiste iş emri "üretimde — CNC-0N" görünür.
3. Üretim sürerken operatör **kontrol kartındaki** duruşları ekrana işler ("saat X–Y arası şu nedenle durdu"); bu Excel'deki duruş kaydının yerini alır
   ve verimlilik hesabına girer. Telemetri duruş aralıklarını zaten ölçtüğü için ekran **ölçülmüş duruşları listeler, operatör yalnız nedeni seçer**.
4. Kasa dolunca **Ürün Tanıtım Kartı** basılır ve kasaya konur (karışmasın diye); kasalar paketlemeye gider. İş emri bitince **"bitir"** (bitiş sayacı).
5. **Hammadde sarfiyatı** hesaplanır (üretilen adet × brüt gramaj) ve **Mikro'ya sarfiyat fişi** kesilerek hammadde deposundan düşülür.

**Tasarım kararları (öneri):**
- **Başlat/bitir açık bir insan eylemidir; adet telemetriden gelir.** İş emrinin penceresi (başlat–bitir) ve tezgah bellidir; adet = o aralıkta o tezgahta
  sayılan parçalar (`production` olayları, vardiya kırılımıyla). Bu yüzden iş emri için **program ↔ ürün eşlemesi şart değil**: eşleme yalnızca çapraz denetim
  ("tezgahta çalışan program bu ürüne eşli değil" uyarısı). Aynı tezgahta vardiya içinde art arda iki iş emri de açık pencerelerle ayrışır; iki açık iş emri aynı tezgaha atanamaz.
- **Hammadde sarfiyatı için sayaç (tezgahın işlediği TÜM parça) kullanılır**, "sağlam miktarı" değil: ayar/numune/bozuk parça da hammaddeyi tüketmiştir (ret ve hurda ayrıca izlenmediği için sayaç tek ölçüdür).
  Hesap: kg = adet × brüt (D aşaması). Çubuk uç artığı ve çubuk bazlı (BOY) fark ayrıca gösterilir; hangisinin Mikro'ya yazılacağı (kg mı, çubuk mu) **açık soru**.
- **Operatör ekranı mevcut PC'den çalışır**: tablet donanımı beklenmez (aşağıdaki PC yeterli); yeni `operator` rolü 7.1'deki gibi (tek tezgah ya da tezgah seçimi, yalnız
  başlat/bitir, duruş nedeni, kart basma). Tablet sonradan aynı ekranla gelir.
- **Sarfiyat fişi iki adımda:** önce sistem **kesilecek fişi hesaplayıp listeler** (iş emri, hammadde kodu, kg, depo) ve ofis Mikro'ya elle girer, "Mikro'ya girildi" işaretler
  (API'siz de değer üretir). Mikro yazma API'si doğrulanınca (G) aynı kayıt otomatik gönderilir: **iki kez fiş kesilmesin diye** kayıtta durum ve Mikro evrak no tutulur.

**Ürün Tanıtım Kartı** (kâğıt: delikli sürekli form, sarı, kopyalı görünümlü; kart numarası basılı; fotoğraftan okundu, nüsha sayısı bilinmiyor; alt bilgi `EYS.FR.001`, yayın 18.09.2024, rev. yok):
- Üst blok: **KART NO** (önceden basılı seri), **TARİH/VARDİYA**, **MAKİNA NO**, **İŞ EMRİ NO**, **GKK RAPOR NO**; **ALEN ÜRÜN KODU**, **MÜŞTERİ ÜRÜN KODU**, **ÜRÜN TANIMI**.
  Elle yazılan iş emri numarası kısadır (`1021`); sistemde yıl + 6 hane (`2026001021`): basılı kartta tam numara hazır gelir, aramada son haneler yeter.
- **Süreç tablosu** (satır = istasyon): CNC ÜRETİM · EK İŞLEM · YIKAMA · YAZI YAZMA · KURUTMA · PAKETLEME; sütunlar **SAYAÇ BŞL. · SAYAÇ BTŞ. · MİKTAR · OPERATÖR · KONTR. SONUCU**.
  CNC üretim satırındaki **sayaç başlangıç/bitiş tezgahın parça sayacıdır** → sistem kasa başına bunları ölçülen değerle otomatik doldurabilir; kasa miktarı = fark.
  Sonraki istasyonlar (ek işlem … paketleme) elle yazılır; ilk aşamada boş basılır.
- **ÜRÜN RET OLMUŞSA:** uygunsuzluk tespit yeri · tespit edilen uygunsuzluk · yapılacak işlem. **YENİDEN İŞLEM BİLGİLERİ:** harcanan adam saat · sağlam miktarı · hurda miktarı. Elle yazılır.
- Her **kasa** bir kart taşır → bir iş emrinin **birden çok kartı** olur (kasa sayısı kadar).

**Kararlar (2026-10-12 akşam, kullanıcı cevapları):**
1. **Kartı sistem basar** (kendi sıra numarasını verir, düz kâğıda). Basılı deftere paralel geçiş yok.
2. **Kasa dolarken adet bilinmez; sayı paketlemede belli olur** (belli bir adetle paketlenir). Bu yüzden kasa kaydı iki kaynaktan beslenir:
   (a) **telemetri sayaç aralığı** — kasa açılırken başlangıç sayacı, kasa kapanırken bitiş sayacı kaydedilir; fark kimse saymasa da kasa miktarı tahminini verir (kâğıttaki "SAYAÇ BŞL./BTŞ."
   alanları); (b) **paketleme sayımı** — paketlemede girilen kesin adet. İkisi arasındaki fark görünür. Kasa açma/kapama bir insan eylemi olduğu için sayaç aralığı yaklaşıktır; kesin sayı paketlemedendir.
   Kartta miktar alanı basılırken boş kalır.
3. **Ret ve hurda sistemde TUTULMAZ** (kullanıcı önce "tutulsun" dedi, aynı akşam vazgeçti; "fire/kalite tutulmaz" kararı geçerli). Kartın "ürün ret olmuşsa" ve "yeniden işlem bilgileri" blokları
   basılı kartta **boş, el yazısı için** kalır (kâğıttaki uygulama sürer); sistem bu alanları kaydetmez, kalite oranı/OEE kalite ayağı yoktur.
   Sarfiyat sayaç (işlenen tüm parça) üzerinden hesaplanır.
4. **Sarfiyat kg olarak** (Mikro'ya kg yazılır): kg = işlenen adet × brüt gramaj. Çubuk (BOY) bilgi olarak ayrıca gösterilir.
5. **İş emrini aşağıdaki PC'de ortak hesapla başlatırız** (kişi başı hesap yok). Kayıtta kim yaptığı bu yüzden görünmez; öneri: kâğıttaki "operatör" alanı gibi, başlat/bitir ve kasa kapama adımlarında
   isteğe bağlı serbest metin **"yapan kişi"** alanı (kimlik doğrulama değil, bilgi amaçlı).

**Uygulama ayrımı (karar, 2026-10-12 akşam):** iki ürün ayrı uygulama olarak ilerliyor. Girişten sonra **uygulama seçim ekranı** (CNC Telemetri · Planlama) gelir; Telemetri'nin menüsünde
Planlama yoktur, Planlama'nın kendi yan menüsü (İş emirleri · Ürün kartları · Siparişler · Program eşleme; sonra hammadde, verimlilik…) ve ayrı üst çubuk yazısı vardır. Tek uygulamalı kullanıcı
(izleyici: yalnız Telemetri; ileride operatör: yalnız Planlama'nın operatör ekranı) seçim ekranını görmez, doğrudan girer. Yetkiyi sunucu verir (`policy.js`); seçim ekranı yalnız kolaylıktır.

## 8. Mimari ve güvenlik

- `backend/planning/` ayrı modül + ayrı veritabanı; telemetri kodu bu modülü **import etmez**, planlama telemetri verisini
  enjekte edilen fonksiyonlarla okur (program kütüphanesiyle aynı ayrım).
- **Veri kaynağı arayüzü iki uygulama:** (1) **CSV içe aktarma** (Excel'den "CSV UTF-8"; bağımlılık eklemeden) · (2) **Mikro API okuma** (sonra). Aynı model, kaynak değişir.
- Uçlar `/api/planning/*`: **yalnız admin** (izin tablosunda varsayılan reddet). Viewer göremez. Planlamacı için ayrı rol yok; **tablet hesabı için yeni `operator` rolü** (tek tezgaha bağlı, bkz. 7.1).
- Yeni dashboard dosyaları `STATIC_FILES` listesine eklenir; ayrı uygulama olarak (girişten sonra uygulama seçimi): Planlama yan menüsü İş emirleri · Ürün kartları · Siparişler · Program eşleme (sonra Hammadde · Verimlilik).
- Telemetri kod kuralları geçerli: okunamayan alan `null`, tahmin yok, her gösterge ikon + etiket.

## 9. Aşamalar (her biri testli ve ayrı gösterilir)

| | İçerik |
|---|---|
| **A** | Altyapı + Ürünler (CSV içe aktarma) + program eşleme ekranı + Siparişler (CSV içe aktarma) — **YAPILDI (0.8.0)**, gerçek kurulumda denenmedi; ayrıntı CLAUDE.md §6 "Planlama modülü" |
| **B** | İş emri: sipariş → satır → ürün akışı, numara, form çıktısı, tezgah atama — **YAPILDI (0.9.0)**, gerçek kurulumda denenmedi; ayrıntı CLAUDE.md §6 "Planlama modülü" |
| **C** | İş emri yaşam döngüsü + telemetri bağlantısı: `planlandı → üretimde → bitti` (+ iptal); başlat / bitir; gerçekleşen adet = başlat–bitir aralığında o tezgahta sayılan parçalar (vardiya kırılımlı), canlı ilerleme, çapraz denetim uyarıları, numune önerisi, kapanışta dondurma — **YAPILDI (0.10.0)**, gerçek tezgahta denenmedi; ayrıntı CLAUDE.md §6 "Planlama modülü" |
| **D** | Hammadde ve sarfiyat: ihtiyaç, teorik sarfiyat (sayaç × brüt, kg), çubuk, beklenen talaş, ay sonu dökümü, **kesilecek sarfiyat fişi listesi** (ofis Mikro'ya elle girer, "girildi" işaretler; çift fiş önlenir) — **YAPILDI (0.13.0)**, gerçek Mikro fişiyle karşılaştırılmadı; ayrıntı CLAUDE.md §6 "Planlama modülü" |
| **E** | Verimlilik: otomatik verimlilik/A/P (ayrılan süre = iş emri penceresi ∩ vardiya; süre ağırlıklı toplam), tezgah × gün × vardiya matrisi, günlük üretim kartları, duruş nedeni dakikaları (kod × gün), ürün bazında planlanan süre önerisi, Excel CSV — **YAPILDI (0.14.0)**, gerçek vardiya verisiyle Excel'e karşı doğrulanmadı; ayrıntı CLAUDE.md §6 "Planlama modülü" |
| **T** | **Fabrika PC'sinde operatör ekranı** (tablet donanımı beklenmedi; tablet gelince aynı ekran): `operator` rolü (ortak hesap), Planlama > **Tezgah başı** (iş emri başlat/bitir, **duruş nedeni**: ölçülmüş duruşa neden bağla, bölerek), Excel kod listesi (D1–D46, Z1–Z4) — **YAPILDI (0.11.0)**, gerçek fabrika PC'sinde denenmedi; ayrıntı CLAUDE.md §6 "Planlama modülü" |
| **K** | **Ürün Tanıtım Kartı** (7.2): kasa kartı basımı (sistem basar), iş emrine bağlı kasa kayıtları (kasa açılırken/kapanırken tezgah sayacı, sayılan adet = tahmin), paketlemede kesin adet, fark görünür — **YAPILDI (0.12.0)**, gerçek yazıcıda/kasalarla denenmedi; ayrıntı CLAUDE.md §6 "Planlama modülü" |
| **F** | Mikro'dan okuma (sipariş, stok kartı, depo bakiyesi) |
| **G** | Mikro'ya yazma (iş emri, **sarfiyat fişi**): test DB + bayi onayı olmadan yapılmaz; çift fiş önlenir (durum + Mikro evrak no) |

## 10. Kararlar ve açık sorular

**Karar verildi (2026-10-12):**
- Vardiya sabit 12 saat. İş emri bitince vardiya içinde yeni program/ürüne geçilebilir: **ayrılan süre otomatik** hesaplanır (ürünün o vardiyada çalıştığı aralık, program değişiminden programa kadar); elle düzeltme açık kalır. Ürün değişim kurulumu yeni ürünün süresine yazılır ve duruş olarak (D1) görünür.
- Çubuk sayısı (BOY) formülü onaylandı.
- Fire/kalite tutulmaz (ret ve hurda da dahil; 2026-10-12 akşam teyit); numune adedi iş emrinde isteğe bağlı; iş emirleri yalnız admin.
- Duruş kodu listesi Excel'deki (D1–D46, Z1–Z4); ürün günlük tek satırda Gündüz + Gece adedi.

**Karar verildi (2026-10-12, akşam):** uçtan uca akış 7.2'deki gibi: ofis iş emri açar → aşağıdaki PC'de operatör "bu tezgahta başlatıyorum" → duruş nedenleri ekrana işlenir → kasa kartı basılır → sarfiyat hesaplanıp Mikro'da fiş kesilir. Önerilen sıra: **C → T → K → D (+ elle fiş listesi) → E → F/G**.

**Açık:**
0. ~~7.2'deki 5 soru~~ — cevaplandı (7.2 "Kararlar"). Açık kalan ayrıntı: kasa açma/kapama akışı (kim, hangi ekranda, kasa numarası) ve paketleme kaydının ekranı (K aşaması tasarlanırken).
1. **Brüt gramaj hesabı:** kullanıcı hesabı hammaddeye göre yapan Excel'i gönderebilir. Hammadde kodundan (kesit × boy × yoğunluk) çıkarmayı denedim: yoğunluk 8,3–9,8 g/cm³ arasında dağıldı (pirinç ≈ 8,5), yani hesapta başka etkenler var. Gelene kadar brüt gramaj ürün kartına mevcut değerlerle aktarılır; hesaplayıcı sonra.
2. **Geçmiş Excel verisi** (duruş ve üretim kartı, önceki aylar) sisteme alınacak mı? Alınırsa kodlar Excel listesiyle zaten aynı; yalnızca D21+ kâğıt kartlardan girilmiş olabilecek satırların doğruluğu sorulur.
3. **Tablet ve tezgah başı Wi‑Fi:** alınacak mı, ne zaman? (Aşama 2 buna bağlı; kaç tablet, usta kimliği/PIN, 3 dk eşiği o zaman kararlaştırılır.)
4. **Mikro'ya iş emri yazma API'si** var mı? (bayi cevabı bekleniyor, doğrulanmadı)
