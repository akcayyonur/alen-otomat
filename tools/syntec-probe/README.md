# Syntec RemoteAPI Yakalama Aracı

Kontrolcüye bağlanır, veri okuma fonksiyonlarını periyodik çağırır ve
**hangilerinin gerçekten çalıştığını** raporlar.

Amacı iki tane: `config/machines.json`'daki `reports` listesini gerçek ölçümle
kesinleştirmek, ve Edge Agent'ın iskeletini oluşturmak.

## Ön koşullar

- Windows (Syntec DLL'leri 32-bit yerel kod içeriyor)
- .NET Framework 4.x — Windows'ta hazır gelir, kurulum gerekmez
- Syntec `Bin` klasörü: ya PC Simulator'dan (`DiskC\OpenCNC\Bin`), ya kontrolcüden

## Derleme

```bat
build.bat "C:\...\11BLathe_W32_10.116.56Q\DiskC\OpenCNC\Bin"
```

Parametre olarak verilen klasöre `syntec-probe.exe` kopyalanır.
**Bin klasöründen çalıştırmak şart** — yanındaki native DLL'lere
(`OCApi.dll`, `OCUser.dll`, `MMICommon32.dll`…) ihtiyaç var.

> Zip'ten çıkan dosyalar Windows tarafından engellenmiş olabilir. Bir kez:
> ```powershell
> Get-ChildItem "C:\...\11BLathe_W32_10.116.56Q" -Recurse | Unblock-File
> ```

## Kullanım

```bat
cd "C:\...\DiskC\OpenCNC\Bin"

rem Simulator'a karsi (once cnc.bat ve OCAPIServer.exe calisiyor olmali)
syntec-probe.exe --host 127.0.0.1 --seconds 60

rem Gercek tezgaha karsi
syntec-probe.exe --host 192.168.88.99 --seconds 60
```

| Parametre | Varsayılan | Açıklama |
|---|---|---|
| `--host` | `127.0.0.1` | Kontrolcü IP |
| `--seconds` | `60` | Yakalama süresi |
| `--interval` | `1000` | Örnekleme aralığı (ms) |
| `--out` | otomatik | JSONL dosya adı |
| `--dll` | `Syntec.RemoteCNC.Win32.dll` | İstemci kütüphanesi |
| `--ingest` | yok | Verilirse her örnek bu adrese POST edilir |
| `--machine-id` | `CNC-01` | `config/machines.json`'daki tezgah kimliği |

`--seconds 0` verilirse süresiz çalışır — Edge Agent olarak kullanım şekli budur.

## Edge Agent olarak çalıştırma

```bat
syntec-probe.exe --host 192.168.88.99 --seconds 0 --interval 1000 ^
                 --machine-id CNC-01 --ingest http://SUNUCU:3000/api/ingest
```

Okuduğu veriyi `shared/schema.js`'teki sözleşmeye çevirip backend'e gönderir.
Durum eşlemesi:

| Syntec | Şema |
|---|---|
| `EMG = "EMG"` veya `Alarm = "ALARM"` | `ALARM` |
| `Status` içinde RUN / START / BUSY / CYCLE | `RUNNING` |
| `Status` içinde READY / STOP / PAUSE / HOLD / IDLE / RESET | `IDLE` |
| tanınmayan | `IDLE` + **özette uyarı** |

Tanınmayan bir değer sessizce eşlenmez; özette listelenir ki eşleme düzeltilebilsin.
`OFF` durumu API'den gelmez — kontrolcü kapalıysa bağlantı kurulamaz, onu backend
bağlantı kopukluğu olarak zaten takip ediyor.

## Çıktı

Ekranda kontrolcü kimliği, sonra örnekleme, sonunda özet:

```
=== SONUC (60 ornek) ===
  READ_status             CALISTI
  READ_spindle            CALISTI
  READ_part_count         CALISTI
  READ_time               CALISTI
  READ_alm_current        CALISTI
  READ_nc_current_block   CALISMADI  - donus kodu -18
```

Her örnek JSONL olarak kaydedilir; ham veri sonradan tekrar incelenebilir.

## Bağlantı kurulamazsa

1. Kontrolcüde **Kernel Server çalışıyor mu** — 5566/5568/5570/5572 portları açık mı
2. PC güvenlik duvarında **5568 ve 5570 GELEN bağlantıya açık mı**
   (manual §2.2: kontrolcü de PC'ye bağlanıyor, akış çift yönlü)
3. PC'de birden fazla ağ kartı varsa, kontrolcüye bağlı olanın önceliği yüksek olmalı

## Notlar

Metotlar yansımayla çağrılıyor. `ByRef` parametrelerin `out` mu `ref` mi olduğu
assembly metadata'sından ayırt edilemiyor ve sürümler arası imza değişebiliyor;
yansıma ikisinde de çalışır ve derleme zamanı bağımlılığı yaratmaz.
