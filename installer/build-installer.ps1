<#
    CNC Telemetri - kurulum paketi (Setup.exe) uretir.

    Ne yapar:
      1. Yuklenecek her seyi installer\payload\ altinda toplar:
           proje kodu + gomulu Node + Syntec Bin klasoru (DLL'ler) + x86 ajan
           + masaustu uygulamasi (CNC Telemetri.exe)
      2. Paketi duman testinden gecirir (backend ve ajan paketten acilir mi)
      3. Inno Setup ile tek bir Setup.exe derler  ->  installer\output\

    Syntec DLL'leri DEPOYA GIRMEZ: her derlemede dis bir klasorden (-SyntecBin)
    alinip payload'a konur. payload\ ve output\ .gitignore'da.

    Kullanim:
        .\build-installer.ps1 -SyntecBin "C:\...\11BLathe_W32_10.116.56Q\DiskC\OpenCNC\Bin"

    -SyntecBin verilmezse CNC_SYNTEC_BIN ortam degiskenine, o da yoksa
    Indirilenler klasorune bakar.

    Gereken: Inno Setup 6 (winget install JRSoftware.InnoSetup), Node 22.5+ (x64),
             .NET Framework 4.0 derleyicisi (Windows'ta hazir gelir).
#>

[CmdletBinding()]
param(
    [string]$SyntecBin = $env:CNC_SYNTEC_BIN,

    # Pakete gomulecek node.exe. Verilmezse PATH'teki Node kullanilir.
    [string]$NodeExe,

    # Duman testini atla (onerilmez).
    [switch]$TestAtla
)

$ErrorActionPreference = 'Stop'

$Kok      = Split-Path -Parent $PSScriptRoot
$Payload  = Join-Path $PSScriptRoot 'payload'
$CiktiDiz = Join-Path $PSScriptRoot 'output'

function Adim($m)  { Write-Host ''; Write-Host "  $m" -ForegroundColor Cyan }
function Tamam($m) { Write-Host "  [+] $m" -ForegroundColor Green }
function Bilgi($m) { Write-Host "  [ ] $m" -ForegroundColor Gray }
function Hata($m)  { Write-Host "  [X] $m" -ForegroundColor Red }

function Vazgec($m) {
    Write-Host ''
    Hata $m
    Write-Host ''
    exit 1
}

# ------------------------------------------------------------- on kosullar

Adim 'On kosullar'

# --- Syntec Bin ---
if (-not $SyntecBin) {
    Bilgi 'Syntec Bin verilmedi, Indirilenler araniyor...'
    $bulunan = Get-ChildItem (Join-Path $env:USERPROFILE 'Downloads') -Recurse `
        -Filter 'Syntec.RemoteCNC.Win32.dll' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($bulunan) { $SyntecBin = $bulunan.DirectoryName }
}
if (-not $SyntecBin) {
    Vazgec 'Syntec Bin klasoru bulunamadi. -SyntecBin "C:\...\DiskC\OpenCNC\Bin" ver.'
}
if (-not (Test-Path $SyntecBin)) { Vazgec "Syntec Bin klasoru yok: $SyntecBin" }

# Ajanin calismasi icin sart olan cekirdek DLL'ler. Eksikse paket calismaz.
foreach ($dll in 'Syntec.RemoteCNC.Win32.dll', 'OCApi.dll', 'OCUser.dll', 'MMICommon32.dll') {
    if (-not (Test-Path (Join-Path $SyntecBin $dll))) {
        Vazgec "Syntec Bin klasorunde $dll yok: $SyntecBin"
    }
}
Tamam "Syntec Bin: $SyntecBin"

# --- Node ---
if (-not $NodeExe) { $NodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $NodeExe -or -not (Test-Path $NodeExe)) { Vazgec 'node.exe bulunamadi (-NodeExe ile ver).' }

$nodeSurum = (& $NodeExe -v).TrimStart('v')
$nodeMimari = (& $NodeExe -p 'process.arch').Trim()
$sp = $nodeSurum.Split('.')
if ([int]$sp[0] -lt 22 -or ([int]$sp[0] -eq 22 -and [int]$sp[1] -lt 5)) {
    Vazgec "Node v$nodeSurum yetersiz (backend node:sqlite icin 22.5+ ister)."
}
if ($nodeMimari -ne 'x64') { Vazgec "Node mimarisi $nodeMimari - paket x64 bekliyor." }
Tamam "Node v$nodeSurum ($nodeMimari): $NodeExe"

# --- derleyiciler ---
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { Vazgec '.NET Framework 4.0 derleyicisi (csc.exe) yok.' }

$iscc = @(
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { Vazgec 'Inno Setup 6 yok.  winget install JRSoftware.InnoSetup' }
Tamam "Inno Setup: $iscc"

$surum = (Get-Content (Join-Path $Kok 'package.json') -Raw | ConvertFrom-Json).version
Tamam "surum: $surum"

# --- Visual C++ 2005 SP1 (x86) calisma zamani ---
# Syntec'in native DLL'leri (OCApi.dll vb.) buna bagimli; yoksa DLL yuklenmez
# (0x800736B1) ve ajan tornaya baglanamaz. Setup eksikse sessizce kurar. Dosya
# depoda yok (*.exe ignore'da); bkz. installer\prereq\README.md.
$VcRedist = Join-Path $PSScriptRoot 'prereq\vcredist_x86.exe'
$VcRedistSha256 = '8648C5FC29C44B9112FE52F9A33F80E7FC42D10F3B5B42B2121542A13E44ADFD'
if (-not (Test-Path $VcRedist)) {
    Vazgec ("vcredist_x86.exe yok: $VcRedist`n" +
            "  Microsoft'tan indirin ve oraya koyun (adres ve dogrulama: installer\prereq\README.md):`n" +
            "  https://www.microsoft.com/en-us/download/details.aspx?id=26347")
}
$vcHash = (Get-FileHash $VcRedist -Algorithm SHA256).Hash
if ($vcHash -ne $VcRedistSha256) {
    Vazgec "vcredist_x86.exe beklenen dosya degil (SHA256 $vcHash). Imzasini dogrulayip prereq\README.md'deki degeri guncelleyin."
}
$vcImza = Get-AuthenticodeSignature $VcRedist
if ($vcImza.Status -ne 'Valid' -or $vcImza.SignerCertificate.Subject -notmatch 'CN=Microsoft Corporation') {
    Vazgec "vcredist_x86.exe Microsoft imzali degil (durum: $($vcImza.Status))."
}
Tamam 'Visual C++ 2005 SP1 (x86): SHA256 dogru, Microsoft imzasi gecerli'

# ------------------------------------------------------------ paketi topla

Adim 'Paket hazirlaniyor'

if (Test-Path $Payload) { Remove-Item $Payload -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Payload | Out-Null

# Proje kodu. Simulator, saha araclari ve belgeler uretimde gerekmez.
foreach ($d in 'backend', 'shared', 'dashboard', 'config') {
    Copy-Item (Join-Path $Kok $d) (Join-Path $Payload $d) -Recurse
}
# data\ ve logs\ kurulumda olusur, kaynak agacindan GELMEMELI.
foreach ($sil in 'data', 'logs') {
    $y = Join-Path $Payload "backend\$sil"
    if (Test-Path $y) { Remove-Item $y -Recurse -Force }
}
# Testler gelistirme icindir (npm test); uretim paketine girmez.
Get-ChildItem (Join-Path $Payload 'backend') -Recurse -Filter '*.test.js' | Remove-Item -Force
# Test yardimcilari (sahte FTP sunucusu, kurulum) da gelistirme icindir.
$testYard = Join-Path $Payload 'backend\programs\test'
if (Test-Path $testYard) { Remove-Item $testYard -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $Payload 'kurulum') | Out-Null
Copy-Item (Join-Path $Kok 'kurulum\kurulum.ps1') (Join-Path $Payload 'kurulum')
Copy-Item (Join-Path $Kok 'kurulum\KURULUM.md')   (Join-Path $Payload 'kurulum')
# package.json: "type": "module" - bu olmadan .js dosyalari ES modulu sayilmaz.
Copy-Item (Join-Path $Kok 'package.json') $Payload
Tamam 'proje kodu'

# Visual C++ 2005 SP1 (x86): Setup eksikse kurar, sonra siler.
New-Item -ItemType Directory -Force -Path (Join-Path $Payload 'prereq') | Out-Null
Copy-Item $VcRedist (Join-Path $Payload 'prereq')
Tamam 'Visual C++ 2005 SP1 (x86) onkosulu'

# Gomulu Node.
$rt = Join-Path $Payload 'runtime'
New-Item -ItemType Directory -Force -Path $rt | Out-Null
Copy-Item $NodeExe (Join-Path $rt 'node.exe')
@"
Bu klasordeki node.exe, Node.js'tir (https://nodejs.org).
Surum: v$nodeSurum
Lisans: MIT - https://github.com/nodejs/node/blob/main/LICENSE
"@ | Set-Content (Join-Path $rt 'NODE-NOTICE.txt') -Encoding UTF8
Tamam "gomulu Node v$nodeSurum"

# Syntec Bin: alt klasorleriyle (Windows CE\ ...) birlikte, BUTUN paket - ajan
# yalnizca DLL'lerin yanindan calisir, secip tasimak ilk denemede calisip sonra
# bozulur (bkz. CLAUDE.md). Bizim urettigimiz yakalama dosyalari haric.
$ajanDizin = Join-Path $Payload 'agent'
New-Item -ItemType Directory -Force -Path $ajanDizin | Out-Null
# Bizim yakalama dosyalarimiz VE Syntec sunucusunun (OCAPIServer, PC simulatoru ile
# calistirilinca) Bin'e yazdigi calisma artiklari (DipoleSettings.xml, ServLOG*.txt):
# bunlar paketin parcasi degil, hedef PC'ye gitmemeli.
$haric = { param($f) $f.Name -like 'syntec-*.exe' -or $f.Extension -in '.jsonl', '.csv' -or $f.Name -eq 'machines.txt' -or $f.Name -eq 'DipoleSettings.xml' -or $f.Name -like 'ServLOG*.txt' }

Get-ChildItem $SyntecBin -File | Where-Object { -not (& $haric $_) } |
    Copy-Item -Destination $ajanDizin
foreach ($alt in Get-ChildItem $SyntecBin -Directory) {
    Copy-Item $alt.FullName (Join-Path $ajanDizin $alt.Name) -Recurse
}
$dllSayi = (Get-ChildItem $ajanDizin -Recurse -File).Count
Tamam "Syntec paketi: $dllSayi dosya"

# Ajan: kaynaktan, x86 - paketteki exe her zaman depodaki kodla ayni olsun.
$ajanExe = Join-Path $ajanDizin 'syntec-agent.exe'
$kaynak  = Join-Path $Kok 'tools\syntec-agent'
$cikti = & $csc /nologo /target:exe /platform:x86 /optimize+ "/out:$ajanExe" `
    (Join-Path $kaynak 'Agent.cs') (Join-Path $kaynak 'SyntecReader.cs') 2>&1
if ($LASTEXITCODE -ne 0) { $cikti | ForEach-Object { Bilgi $_ }; Vazgec 'ajan derlenemedi' }

# /platform:x86 sessizce atlanirsa calisma aninda BadImageFormatException gelir;
# derleme sonrasi PE basligindan dogrula.
$b = [IO.File]::ReadAllBytes($ajanExe)
$makine = [BitConverter]::ToUInt16($b, [BitConverter]::ToInt32($b, 0x3C) + 4)
if ($makine -ne 0x014C) { Vazgec ('ajan x86 degil (PE makine kodu 0x{0:X})' -f $makine) }
Tamam 'ajan derlendi (x86)'

# Masaustu uygulamasi: acinca backend ve ajani ayaga kaldirir, dashboard'u acar.
# Simgesi de burada cizilir (launcher\make-icon.ps1) - dis resim dosyasi yok.
# Syntec DLL'i yuklemez, bu yuzden x86 olmasi gerekmez.
$ara = Join-Path $Payload '_ara'
New-Item -ItemType Directory -Force -Path $ara | Out-Null
$simge = Join-Path $ara 'uygulama.ico'
& (Join-Path $PSScriptRoot 'launcher\make-icon.ps1') -Out $simge
$baslatici = Join-Path $Payload 'CNC Telemetri.exe'
$cikti = & $csc /nologo /target:winexe /optimize+ "/win32icon:$simge" "/out:$baslatici" `
    /r:System.Windows.Forms.dll /r:System.Drawing.dll (Join-Path $PSScriptRoot 'launcher\Baslatici.cs') 2>&1
if ($LASTEXITCODE -ne 0) { $cikti | ForEach-Object { Bilgi $_ }; Vazgec 'masaustu uygulamasi derlenemedi' }
Remove-Item $ara -Recurse -Force
Tamam 'masaustu uygulamasi derlendi (CNC Telemetri.exe)'

# ------------------------------------------------------------- duman testi

if (-not $TestAtla) {
    Adim 'Duman testi'

    # Backend: paketteki node.exe ile, paketteki kodla. Ayri port ve gecici
    # veritabani - gercek kurulumun ya da gelistirme verisinin yerine gecmesin.
    $port = 39000 + (Get-Random -Maximum 900)
    $db = Join-Path $env:TEMP "cnc-duman-$port.db"
    $kutuphaneDb = Join-Path $env:TEMP "cnc-duman-$port-kutuphane.db"
    $env:PORT = "$port"; $env:HOST = '127.0.0.1'; $env:DB_FILE = $db; $env:LIBRARY_DB_FILE = $kutuphaneDb
    $sunucu = $null
    try {
        $sunucu = Start-Process (Join-Path $rt 'node.exe') -ArgumentList 'backend\server.js' `
            -WorkingDirectory $Payload -PassThru -WindowStyle Hidden
        $saglik = $null
        foreach ($i in 1..20) {
            Start-Sleep -Milliseconds 500
            try { $saglik = Invoke-RestMethod "http://127.0.0.1:$port/api/health" -TimeoutSec 2; break } catch { }
        }
        if (-not ($saglik -and $saglik.ok)) { Vazgec 'paketlenmis backend acilmadi' }
        Tamam 'backend paketten aciliyor (node:sqlite dahil)'

        $sayfa = Invoke-WebRequest "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 5
        if ($sayfa.StatusCode -ne 200) { Vazgec 'dashboard sayfasi servis edilmedi' }
        Tamam 'dashboard sayfasi servis ediliyor'

        $liste = Invoke-RestMethod "http://127.0.0.1:$port/api/agent/machines" -TimeoutSec 5
        Tamam "ajan listesi uc noktasi cevap veriyor ($(@($liste.machines).Count) tezgah)"

        # Program kutuphanesi: modul paketten yukleniyor mu, ayri veritabani acildi mi.
        $kut = Invoke-RestMethod "http://127.0.0.1:$port/api/library/config" -TimeoutSec 5
        if ($kut.authRequired -ne $false -or $null -eq $kut.stats) { Vazgec 'program kutuphanesi uc noktasi beklenmedik cevap verdi' }
        Tamam "program kutuphanesi uc noktasi cevap veriyor (gonderme $(if ($kut.transferEnabled) { 'acik' } else { 'kapali' }))"
        $kutJs = Invoke-WebRequest "http://127.0.0.1:$port/library-view.js" -UseBasicParsing -TimeoutSec 5
        if ($kutJs.StatusCode -ne 200) { Vazgec 'kutuphane arayuz dosyasi servis edilmedi' }

        # Masaustu uygulamasi: --denetle yalniz bakar, hicbir gorev baslatmaz.
        $u = Start-Process $baslatici -ArgumentList '--denetle', '--port', "$port" -Wait -PassThru -WindowStyle Hidden
        if ($u.ExitCode -ne 0) { Vazgec 'masaustu uygulamasi calisan backend''i goremedi' }
        Tamam 'masaustu uygulamasi acik backend''i taniyor'
    } finally {
        if ($sunucu -and -not $sunucu.HasExited) { Stop-Process -Id $sunucu.Id -Force }
        Remove-Item "$db*", "$kutuphaneDb*" -Force -ErrorAction SilentlyContinue
        Remove-Item Env:PORT, Env:HOST, Env:DB_FILE, Env:LIBRARY_DB_FILE -ErrorAction SilentlyContinue
    }

    # Backend kapandi: ayni denetim simdi "yok" demeli.
    $u = Start-Process $baslatici -ArgumentList '--denetle', '--port', "$port" -Wait -PassThru -WindowStyle Hidden
    if ($u.ExitCode -ne 1) { Vazgec 'masaustu uygulamasi kapali backend''i fark etmedi' }
    Tamam 'masaustu uygulamasi kapali backend''i de dogru ayirt ediyor'

    # Ajan: DLL'leri yanindaki klasorden gercekten yukleyebiliyor mu. Ulasilamaz
    # bir adrese baglanmaya calistirip ilk saniyelerin ciktisina bakiyoruz;
    # yukleme hatasi (BadImageFormat, eksik native DLL) hemen yazilir.
    # Ciktiyi --log ile alip kontrol ediyoruz: gorevlerin kullanacagi yol bu
    # (kabuk yonlendirmesi yok), yani gunluk ozelligi de ayni anda sinanir.
    $log = Join-Path $env:TEMP 'cnc-duman-ajan.txt'
    Remove-Item "$log*" -Force -ErrorAction SilentlyContinue
    $ajan = Start-Process $ajanExe -ArgumentList '--host', '127.0.0.1', '--machine-id', 'DUMAN', '--log', "`"$log`"" `
        -WorkingDirectory $ajanDizin -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 6
    if (-not $ajan.HasExited) { Stop-Process -Id $ajan.Id -Force }
    $metin = if (Test-Path $log) { Get-Content $log -Raw } else { '' }
    Remove-Item "$log*" -Force -ErrorAction SilentlyContinue
    if (-not $metin) { Vazgec 'ajan --log ile gunluk dosyasi yazmadi' }

    if ($metin -match 'DLL yuklenemedi|nesne olusturulamadi|tipi bulunamadi|BadImageFormat') {
        Hata 'Syntec DLL yuklenemedi:'
        Write-Host $metin
        exit 1
    }
    if ($metin -notmatch 'Syntec Edge Agent') { Vazgec "ajan beklenen ciktiyi vermedi:`n$metin" }
    Tamam 'ajan DLL''leri yukleyebiliyor (x86)'
}

# ----------------------------------------------------------------- derleme

Adim 'Setup.exe derleniyor'

New-Item -ItemType Directory -Force -Path $CiktiDiz | Out-Null
Get-ChildItem $CiktiDiz -Filter 'CNC-Telemetri-Kurulum-*.exe' -ErrorAction SilentlyContinue | Remove-Item -Force

Push-Location $PSScriptRoot
try {
    & $iscc /Qp "/DSurum=$surum" 'cnc-telemetri.iss'
    if ($LASTEXITCODE -ne 0) { Vazgec 'Inno Setup derlemesi basarisiz' }
} finally {
    Pop-Location
}

$setup = Get-ChildItem $CiktiDiz -Filter 'CNC-Telemetri-Kurulum-*.exe' | Select-Object -First 1
if (-not $setup) { Vazgec 'Setup.exe uretilemedi' }
$hash = (Get-FileHash $setup.FullName -Algorithm SHA256).Hash

Write-Host ''
Write-Host '  HAZIR' -ForegroundColor Green
Write-Host ''
Write-Host "    $($setup.FullName)" -ForegroundColor White
Write-Host ('    {0:N1} MB   SHA256 {1}' -f ($setup.Length / 1MB), $hash.Substring(0, 16)) -ForegroundColor Gray
Write-Host ''
Write-Host '  NOT: bu dosya Syntec DLL''lerini icerir. Depoya koyma, herkese acik paylasma.' -ForegroundColor Yellow
Write-Host ''
