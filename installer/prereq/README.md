# Önkoşul: Visual C++ 2005 SP1 (x86) çalışma zamanı

Syntec'in native DLL'leri (`OCApi.dll`, `OCUser.dll`, `OCKrnl.dll`) **Microsoft Visual
C++ 2005 SP1 (8.0.50727.762) çalışma zamanına** bağlı. Bilgisayarda yoksa DLL yüklenmez
(`0x800736B1`, "yan yana yapılandırma doğru olmadığından başlatılamadı") ve ajan tornaya
bağlanamaz. Sahada fabrika PC'sinde yaşandı; geliştirme PC'sinde başka bir yazılım
bunu zaten kurduğu için gözden kaçmıştı.

Setup bu paketi **eksikse sessizce kurar** (`vcredist_x86.exe /q`). Dosya depoda
**yoktur** (`*.exe` ignore'da); her derlemede buradan alınır.

## Dosyayı edinmek

Microsoft İndirme Merkezi, *Microsoft Visual C++ 2005 Service Pack 1 Redistributable
Package MFC Security Update* (id 26347, KB2538242):

<https://www.microsoft.com/en-us/download/details.aspx?id=26347>

Doğrudan adres (sayfanın kendisinden alındı):

```
https://download.microsoft.com/download/8/b/4/8b42259f-5d70-43f4-ac2e-4b208fd8d66a/vcredist_x86.EXE
```

İndirip **`installer\prereq\vcredist_x86.exe`** olarak kaydedin. Yalnızca **x86** olanı;
Syntec DLL'leri 32-bit olduğu için x64 sürümü işe yaramaz.

## Doğrulama

`build-installer.ps1` dosyayı paketlemeden önce kendisi denetler; biri tutmazsa durur:

| Denetim | Beklenen |
|---|---|
| SHA256 | `8648C5FC29C44B9112FE52F9A33F80E7FC42D10F3B5B42B2121542A13E44ADFD` |
| Authenticode imzası | `Valid`, imzalayan **Microsoft Corporation** |
| Boyut | ~2,6 MB (2.710.520 bayt) |

Microsoft dosyayı değiştirirse (yeni sürüm) SHA256 değişir: yeni dosyanın imzasını elle
doğrulayıp `build-installer.ps1` içindeki `$VcRedistSha256` değerini güncelleyin.

## Not

Redistributable'ın uygulamalarla birlikte dağıtılmasına Microsoft izin veriyor. Paket
Microsoft tarafından imzalı; Setup onu değiştirmeden `{tmp}` altına açar, kurar ve siler.
