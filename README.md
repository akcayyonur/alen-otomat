# CNC Telemetri Platformu — İskelet

`cnc-telemetri-gereksinim.html` (CNC-TLM-001) belgesindeki mimarinin çalışan ilk
katmanı: **simülatör → backend → canlı dashboard**.

Sahada doldurulacak sıradaki adımlar: **[KONTROL-LISTESI.md](KONTROL-LISTESI.md)**

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
yaşından yalıtır. Edge Agent veriyi OPC-UA'dan da okusa, 1997 model bir tezgahın
pano röle kontağından da okusa backend'e aynı biçimde gönderir — backend ve
dashboard farkı bilmez.

Bunu göstermek için sahte filoya kasıtlı olarak farklı yetenekte tezgahlar konuldu:

| Tezgah | Yıl | Kaynak | Okunabilen veri |
|---|---|---|---|
| CNC-01 | 2019 | FOCAS | tümü |
| CNC-02 | 2021 | OPC-UA | tümü |
| CNC-03 | 2020 | MTConnect | tümü |
| CNC-04 | 2016 | Modbus TCP | devir/ilerleme **yok** |
| CNC-05 | **1997** | Retrofit I/O | yalnızca durum + parça sayacı |

Her makinenin `reports` listesi neyi üretebildiğini söyler. Üretemediği alan `null`
gelir — dashboard bunu `0` gibi değil, açıkça "yok" olarak gösterir ve grafik yerine
nedenini yazar. Envanterde 2000 öncesi tezgah çıkması bu yüzden mimariyi değiştirmez;
yalnızca o tezgahın Edge Agent tarafındaki okuma yöntemi değişir.

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
- **Gerçek protokol adaptörleri** — envanter sonrası.

## Notlar

- Yayın için WebSocket yerine **SSE** kullanıldı: veri akışı zaten tek yönlü
  (Bölüm 02'deki sınır ilkesiyle uyumlu), tarayıcıda yeniden bağlanma yerleşik ve
  hiçbir bağımlılık gerekmiyor. Çift yönlü iletişim gerekirse WebSocket'e geçmek
  yalnızca `backend/server.js` içindeki yayın katmanını değiştirir.
- Yazı tipleri Google Fonts'tan yükleniyor. İnternet erişimi olmayan bir atölye ağında
  sistem yazı tipine düşer; kalıcı çözüm için fontları projeye gömmek gerekir.
