# Test sahtesi

`MockSyntec.cs`, gerçek `Syntec.RemoteCNC.Win32.dll`'in sınıf ve metot imzalarını
birebir taklit eder (imzalar gerçek DLL'den yansımayla çıkarıldı) ve çalışan bir
tezgahı simüle eder.

Amacı: **adaptörü donanım olmadan uçtan uca test edebilmek.** Bu projede makineye
erişim pahalı; durum eşlemesi ya da ingest tarafında bir değişiklik yapıldığında
tezgaha gitmeden doğrulanabilmeli.

Sahte tezgah bilerek üç durumu da üretir:

| Örnek | Status | Alarm | Beklenen eşleme |
|---|---|---|---|
| 1-3 | `RUN` | `****` | `RUNNING` |
| 4 | `RUN` | `ALARM` | `ALARM` (alarm önceliği) |
| 5+ | `WHATEVER` | `****` | `IDLE` + "tanınmayan" uyarısı |

## Çalıştırma (Linux/mono)

```bash
mcs -target:library -out:Syntec.RemoteCNC.Win32.dll MockSyntec.cs
mcs -target:exe -out:syntec-probe.exe ../Program.cs
node ../../../backend/server.js &
mono syntec-probe.exe --host 127.0.0.1 --seconds 6 \
     --machine-id CNC-01 --ingest http://127.0.0.1:3000/api/ingest
```

## Çalıştırma (Windows)

```bat
set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
%CSC% /target:library /out:Syntec.RemoteCNC.Win32.dll MockSyntec.cs
%CSC% /platform:x86 /out:syntec-probe.exe ..\Program.cs
```

> Sahte DLL'i **gerçek Bin klasörüne koyma** — orada aynı isimli gerçek dosya var.
> Ayrı bir klasörde çalıştır.

Beklenen sonuç: 5 fonksiyon `CALISTI`, `READ_nc_current_block` dönüş kodu `-18`,
ve özette `WHATEVER` tanınmayan durum olarak raporlanmış olmalı.
