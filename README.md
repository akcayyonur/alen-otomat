# CNC Telemetri Platformu — İskelet

`cnc-telemetri-gereksinim.html` (CNC-TLM-001) belgesindeki mimarinin çalışan ilk
katmanı: **simülatör → backend → canlı dashboard**.

Sıradaki adımlar: **[KONTROL-LISTESI.md](KONTROL-LISTESI.md)** ·
Makine başında yapılacaklar: **[MAKINE-BASINDA.md](MAKINE-BASINDA.md)**

Belgenin Bölüm 13, adım 4'ünü uygular — *"Donanım beklemeden, sahte veri üreten bir
simülatörle dashboard iskeletini kurmaya başla."* Gerçek tezgah entegrasyonu makine
envanteri (Bölüm 03A) netleştikten sonra eklenecek.

## Çalıştırma

Bağımlılık yok, `npm install` gerekmez. Node.js 20+ yeterli.

```bash
npm run dev          # backend + simülatör birlikte
```

Sonra tarayıcıda: <http://localhost:3000>

Ayrı ayrı çalıştırmak için (gerçek kurulumda ikisi farklı makinede olur):

```bash
npm start            # yalnızca backend  (varsayılan port 3000)
npm run sim          # yalnızca simülatör (Edge Agent yerine geçer)
```

Ortam değişkenleri: `PORT`, `HOST`, `INGEST_URL`, `TICK_MS`.

## Yapı

```
config/machines.json   Makine envanteri (Bölüm 03A) — saha bilgisi gelince güncellenecek TEK yer
shared/schema.js       Normalize telemetri sözleşmesi (Bölüm 04) — mimarinin kilit parçası
shared/inventory.js    Envanteri okuyan ortak yükleyici
simulator/             Sahte Edge Agent: sanal tezgahlar + ingest'e gönderim
backend/               HTTP ingest + bellek içi depo + canlı yayın + dashboard servisi
dashboard/             Bağımlılıksız web arayüzü (SSE ile canlı)
```

### Neden bu şema önemli

`shared/schema.js` içindeki sözleşme, üst katmanları makinenin markasından ve
protokolünden yalıtır. Edge Agent veriyi Syntec RemoteAPI'den de okusa, ileride
başka marka bir tezgah eklense de backend'e aynı biçimde gönderir — backend ve
dashboard farkı bilmez.

Ölçümlerin hepsi `null` olabilir. Bir alan okunamıyorsa `0` değil `null` gelir ve
dashboard bunu "yok" olarak gösterip grafik yerine nedenini yazar. Bu, RemoteAPI
testinde bazı alanların dönmediği ortaya çıkarsa kod değişikliği gerekmemesi için.

## Filo

Envanter: `config/machines.json`. Filo **tek tip** — tüm tezgahlar aynı Syntec 11B
kontrolcü, aynı yazılım sürümü. Bu yüzden ortak ayarlar `defaults` altında tutulur,
her tezgah yalnızca kendi kimliğini (id, ad, seri no) taşır. Yeni tezgah eklemek
`machines` dizisine üç satır yazmak demek.

| Alan | Değer | Kaynak |
|---|---|---|
| Kontrolcü | SYNTEC 11B (panel: 11TB) | About ekranı |
| Yazılım | 10.116.54S | About ekranı |
| Platform | Windows CE / AM335x-H | About ekranı |
| Tezgah | **ARIX T-42CL** (torna) | gövde etiketi |
| Üretim | 2020.06 | gövde etiketi |
| Spindle | 7.5 kW · azami 6000 rpm | gövde etiketi |
| Üretici iletişim | ARIX, +886-6-384-1900 (Tainan/TW) | gövde etiketi |
| LAN portu | **var, boşta** | pano fotoğrafı |
| Haberleşme opsiyonu | Software Option listesinde **yok** | System Permissions |

Bunun pratik sonucu: gereksinim belgesinin Bölüm 12'deki en kötü senaryosu — karma
marka filosu, her marka için ayrı adaptör — gerçekleşmiyor. **Bir adaptör yazılıp
N tezgaha kopyalanacak.** Entegrasyon süresi tezgah sayısıyla doğrusal büyür.

> `reportsVerified: false` — `defaults.reports` listesi henüz doğrulanmadı.
> RemoteAPI bağlantısı kurulup hangi alanların gerçekten okunabildiği görülene
> kadar bu liste bir tahmindir. Pilot testten sonra düzeltilecek.

## API

| Yol | Açıklama |
|---|---|
| `POST /api/ingest` | Edge Agent'ın veri gönderdiği uç. Tekil mesaj ya da dizi kabul eder. Geçersiz mesajlar reddedilir, geçerliler yazılır (`207`). |
| `GET /api/stream` | Canlı yayın (Server-Sent Events), saniyede bir tam anlık görüntü. |
| `GET /api/machines` | Anlık durum (tek seferlik). |
| `GET /api/machines/:id/history` | Son ~15 dakikanın örnekleri. |
| `GET /api/health` | Sağlık kontrolü. |

## Yapılanlar / yapılmayanlar

Yapıldı:
- Normalize telemetri sözleşmesi ve ingest sınırında doğrulama
- Karma yetenekli sanal filo (2000 öncesi tezgah dahil)
- Ağ kesintisinde Edge Agent tarafında tamponlama (veri kaybı yerine gecikmeli teslim)
- Canlı filo görünümü, durum zaman çizelgesi, devir/ilerleme grafikleri, alarm ve duruş nedeni
- Bağlantı kopukluğu tespiti (10 sn veri gelmezse "bağlantı yok")

Henüz yok (bilinçli olarak iskelet dışı):
- **Kalıcılık** — veri bellekte tutuluyor, sunucu yeniden başlayınca sıfırlanır.
  Bölüm 10'daki zaman serisi veritabanı (TimescaleDB/InfluxDB) buranın yerine geçecek.
- **Kimlik doğrulama ve rol bazlı yetkilendirme** (Bölüm 08) — şu an **yok**.
  Sunucu varsayılan olarak tüm arayüzlere (`0.0.0.0`) bağlanır ki dashboard'a başka
  PC'lerden erişilebilsin; bu haliyle `/api/ingest` dahil her uç kimlik doğrulamasızdır.
  Kimlik doğrulama eklenene kadar yalnızca güvenilen bir ağda çalıştırın, internete
  açmayın. Tek makinede denemek için `HOST=127.0.0.1` verin.
- **Tam OEE** — yalnızca "çalışma oranı" var; Performans ve Kalite bileşenleri için
  hedef çevrim süresi ve hurda verisi gerekiyor, ikisi de henüz tanımlı değil.
- **CSV / rapor dışa aktarma** (Bölüm 07).
- **Syntec RemoteAPI adaptörü** — asıl iş bu. `Syntec.OpenCNC.dll` bir .NET
  kütüphanesi olduğu için bu tezgahların Edge Agent'ı **C#/.NET** olacak
  (belgedeki "Python/Node" önerisi bu filo için geçerli değil). Adapter yalnızca
  `/api/ingest`'e normalize JSON POST edecek; backend, veritabanı ve dashboard
  değişmeyecek. Kontrolcü sürümü desteklenen aralığın alt ucunda olduğu için
  **RemoteAPI 1.1.0** hedeflenmeli.

## Notlar

- Yayın için WebSocket yerine **SSE** kullanıldı: veri akışı zaten tek yönlü
  (Bölüm 02'deki sınır ilkesiyle uyumlu), tarayıcıda yeniden bağlanma yerleşik ve
  hiçbir bağımlılık gerekmiyor. Çift yönlü iletişim gerekirse WebSocket'e geçmek
  yalnızca `backend/server.js` içindeki yayın katmanını değiştirir.
- Yazı tipleri Google Fonts'tan yükleniyor. İnternet erişimi olmayan bir atölye ağında
  sistem yazı tipine düşer; kalıcı çözüm için fontları projeye gömmek gerekir.
