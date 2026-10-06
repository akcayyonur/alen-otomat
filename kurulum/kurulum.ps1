<#
    CNC Telemetri - izleme PC'si kurulumu.

    Tek seferde: on kosullari denetler, ajani Syntec Bin klasorune derler,
    guvenlik duvarini acar, backend ve ajani acilista baslayacak sekilde
    kaydeder ve calistirir.

    YONETICI olarak calistirilmali (guvenlik duvari ve zamanlanmis gorev icin).

    Kullanim:
        .\kurulum.ps1 -SyntecBin "C:\...\DiskC\OpenCNC\Bin"
        .\kurulum.ps1 -SyntecBin "..." -Port 3000
        .\kurulum.ps1 -Kaldir                 # kurulumu geri al

    Betik tekrar tekrar calistirilabilir; var olani gunceller.

    PAKETLI KURULUM (installer\ ile uretilen Setup.exe): proje kokunde
    runtime\node.exe ve agent\syntec-agent.exe varsa betik bunlari kullanir -
    makinede Node kurulu olmasi, .NET derleyicisi ya da -SyntecBin gerekmez.
    Setup.exe betigi bu yolla cagirir.
#>

[CmdletBinding()]
param(
    # Syntec paketindeki Bin klasoru. Ajan BURADAN calisir - yanindaki native
    # DLL'lere ihtiyaci var, dosyalari ayirmak calismaz. Paketli kurulumda
    # gerekmez: ajan zaten <kok>\agent altinda, DLL'leriyle birlikte.
    [string]$SyntecBin,

    # Dashboard portu.
    [int]$Port = 3000,

    # Dashboard'a baska bilgisayarlardan da bakilacaksa guvenlik duvarinda ac.
    [switch]$AgaAc,

    [switch]$Kaldir,

    # Gorevleri ve kurulum dizininden calisan surecleri durdurur, baska bir sey
    # yapmaz. Setup.exe, dosyalari uzerine yazmadan once bunu cagirir.
    [switch]$Durdur
)

$ErrorActionPreference = 'Stop'

$BackendGorev = 'CNC Telemetri - Backend'
$AjanGorev    = 'CNC Telemetri - Edge Agent'
$FwKural      = 'CNC Telemetri'

$ProjeKok = Split-Path -Parent $PSScriptRoot
$LogDizin = Join-Path $ProjeKok 'logs'

# Paketli kurulumda Setup.exe'nin yerlestirdigi dosyalar.
$PaketliNode = Join-Path $ProjeKok 'runtime\node.exe'
$PaketliAjan = Join-Path $ProjeKok 'agent\syntec-agent.exe'

function Baslik($metin) {
    Write-Host ''
    Write-Host "  $metin" -ForegroundColor Cyan
    Write-Host ('  ' + ('-' * $metin.Length)) -ForegroundColor DarkGray
}
function Tamam($metin)  { Write-Host "  [+] $metin" -ForegroundColor Green }
function Bilgi($metin)  { Write-Host "  [ ] $metin" -ForegroundColor Gray }
function Uyari($metin)  { Write-Host "  [!] $metin" -ForegroundColor Yellow }
function Hata($metin)   { Write-Host "  [X] $metin" -ForegroundColor Red }

function YoneticiMi {
    $kimlik = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal $kimlik).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# ----------------------------------------------------------------- durdurma

function GorevleriDurdur {
    foreach ($g in @($BackendGorev, $AjanGorev)) {
        if (Get-ScheduledTask -TaskName $g -ErrorAction SilentlyContinue) {
            Stop-ScheduledTask -TaskName $g -ErrorAction SilentlyContinue
        }
    }
}

# Kurulum dizininden calisan surecleri YOLA gore durdurur. Ada gore (node.exe)
# oldurmek makinedeki baska Node islerini de vururdu. Calisan node.exe / ajan
# kilitli oldugu icin dosyalar uzerine yazilamaz ve silinemez - Setup.exe bu
# yuzden yukleme ve kaldirmadan once bunu ister.
function KokSurecleriniDurdur {
    $onek = $ProjeKok.TrimEnd('\') + '\'
    Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path.StartsWith($onek, [StringComparison]::OrdinalIgnoreCase) } |
        ForEach-Object {
            try {
                Stop-Process -Id $_.Id -Force -ErrorAction Stop
                Bilgi "durduruldu: $($_.Name)"
            } catch { }
        }
}

if ($Durdur) {
    GorevleriDurdur
    KokSurecleriniDurdur
    return
}

# ---------------------------------------------------------------- kaldirma

if ($Kaldir) {
    Baslik 'Kurulum kaldiriliyor'
    GorevleriDurdur
    KokSurecleriniDurdur
    foreach ($g in @($BackendGorev, $AjanGorev)) {
        if (Get-ScheduledTask -TaskName $g -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $g -Confirm:$false
            Tamam "gorev silindi: $g"
        }
    }
    Get-NetFirewallRule -DisplayName "$FwKural*" -ErrorAction SilentlyContinue |
        ForEach-Object {
            Remove-NetFirewallRule -Name $_.Name
            Tamam "guvenlik duvari kurali silindi: $($_.DisplayName)"
        }
    Write-Host ''
    Write-Host '  Kaldirildi. Veritabani ve loglar DURUYOR:' -ForegroundColor Gray
    Write-Host "    $ProjeKok\data   $LogDizin" -ForegroundColor Gray
    Write-Host ''
    return
}

# ------------------------------------------------------------- on kosullar

Write-Host ''
Write-Host '  CNC TELEMETRI - IZLEME PC KURULUMU' -ForegroundColor White
Write-Host "  proje: $ProjeKok" -ForegroundColor DarkGray

if (-not (YoneticiMi)) {
    Write-Host ''
    Hata 'Bu betik YONETICI olarak calistirilmali.'
    Bilgi 'PowerShell''i sag tik > "Yonetici olarak calistir" ile ac, tekrar dene.'
    Write-Host ''
    exit 1
}

# Setup.exe betigi gizli pencerede calistirir; ekrana yazilanlar kaybolmasin,
# bir sorun cikarsa tek bakilacak yer bu dosya olsun.
New-Item -ItemType Directory -Force -Path $LogDizin | Out-Null
try { Start-Transcript -Path (Join-Path $LogDizin 'kurulum.log') -Force | Out-Null } catch { }

Baslik 'On kosullar'

# --- Node ---
if (Test-Path $PaketliNode) {
    $nodeYol = $PaketliNode
} else {
    $node = (Get-Command node -ErrorAction SilentlyContinue)
    if (-not $node) {
        Hata 'Node.js kurulu degil.'
        Bilgi 'Kurmak icin:   winget install OpenJS.NodeJS.LTS'
        Bilgi 'Sonra bu pencereyi kapatip yeniden ac (PATH tazelensin) ve tekrar calistir.'
        exit 1
    }
    $nodeYol = $node.Source
}
$sv = (& $nodeYol -v) -replace '^v',''
$parcali = $sv.Split('.')
if ([int]$parcali[0] -lt 22 -or ([int]$parcali[0] -eq 22 -and [int]$parcali[1] -lt 5)) {
    Hata "Node surumu yetersiz: v$sv (gereken: v22.5+)"
    Bilgi 'Veritabani icin Node''un gomulu node:sqlite modulu kullaniliyor, 22.5 ile geldi.'
    Bilgi 'Guncelle:   winget upgrade OpenJS.NodeJS.LTS'
    exit 1
}
Tamam "Node v$sv  ($nodeYol)"

# --- .NET Framework (ajan derlemesi icin) ---
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
$ajanDerlenebilir = Test-Path $csc
$paketliAjanVar = Test-Path $PaketliAjan
if ($paketliAjanVar) {
    # Hazir derlenmis ajan var, derleyici gerekmez.
} elseif ($ajanDerlenebilir) { Tamam '.NET Framework 4.0 derleyicisi bulundu' }
else { Uyari '.NET Framework 4.0 yok - ajan derlenemeyecek, backend yine de kurulur' }

# --- Syntec Bin ---
if ($paketliAjanVar) {
    Tamam "Syntec paketi: kurulumla birlikte geldi ($(Split-Path -Parent $PaketliAjan))"
} elseif (-not $SyntecBin) {
    Uyari 'Syntec Bin klasoru verilmedi (-SyntecBin). Yalnizca backend kurulacak.'
    Bilgi 'Ajani sonra kurmak icin betigi -SyntecBin ile tekrar calistir.'
} elseif (-not (Test-Path $SyntecBin)) {
    Hata "Syntec Bin klasoru bulunamadi: $SyntecBin"
    exit 1
} else {
    Tamam "Syntec Bin: $SyntecBin"
}

# ------------------------------------------------------------- ajan kurulumu

$ajanExe = $null
$ajanCalismaDizini = $SyntecBin
if ($paketliAjanVar) {
    Baslik 'Edge Agent'

    # Ajan, DLL'lerinin yanindan calismali: yonetilen sarmalayici native
    # DLL'leri calisma aninda yukluyor. Setup.exe hepsini birlikte yerlestirdi.
    $ajanCalismaDizini = Split-Path -Parent $PaketliAjan
    Get-ChildItem $ajanCalismaDizini -Recurse -ErrorAction SilentlyContinue |
        Unblock-File -ErrorAction SilentlyContinue

    $ajanExe = $PaketliAjan
    Tamam "hazir: $ajanExe"
} elseif ($SyntecBin -and $ajanDerlenebilir) {
    Baslik 'Edge Agent'

    # Zip'ten cikan dosyalar Windows tarafindan bloke gelir (0x80131515).
    $paketKok = Split-Path -Parent (Split-Path -Parent $SyntecBin)
    Bilgi "bloke kaldiriliyor: $paketKok"
    Get-ChildItem $paketKok -Recurse -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue
    Tamam 'bloke kaldirildi'

    $kaynak = Join-Path $ProjeKok 'tools\syntec-agent'
    $cikti  = Join-Path $SyntecBin 'syntec-agent.exe'

    # /platform:x86 ZORUNLU - Syntec dll'leri native 32-bit.
    $argv = @(
        '/nologo', '/target:exe', '/platform:x86', '/optimize+',
        "/out:$cikti",
        (Join-Path $kaynak 'Agent.cs'),
        (Join-Path $kaynak 'SyntecReader.cs')
    )
    & $csc @argv | Out-Null
    if ($LASTEXITCODE -ne 0) { Hata 'ajan derlenemedi'; exit 1 }

    $ajanExe = $cikti
    Tamam "derlendi: $cikti"
}

# --------------------------------------------------------- guvenlik duvari

Baslik 'Guvenlik duvari'

function KuralKur($ad, $portlar, $aciklama) {
    $tam = "$FwKural - $ad"
    Get-NetFirewallRule -DisplayName $tam -ErrorAction SilentlyContinue |
        Remove-NetFirewallRule -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName $tam -Direction Inbound -Protocol TCP `
        -LocalPort $portlar -Action Allow -Profile Any | Out-Null
    Tamam "$aciklama (TCP $($portlar -join ', '))"
}

# Kontrolcu PC'ye GERI baglanti aciyor (manual 2.2) - bu acilmazsa hic baglanmaz.
KuralKur 'RemoteAPI' @(5568, 5570) 'kontrolcu geri baglantisi'

if ($AgaAc) {
    KuralKur 'Dashboard' @($Port) 'dashboard disaridan erisime acildi'
} else {
    Bilgi "dashboard yalnizca bu bilgisayardan (disaridan erisim icin: -AgaAc)"
}

# ------------------------------------------------------------ gorev kaydi

Baslik 'Acilista baslatma'

function GorevKur($ad, $program, $argumanlar, $calismaDizini, $gecikmeSn = 0) {
    if (Get-ScheduledTask -TaskName $ad -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $ad -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $ad -Confirm:$false
    }

    # Program DOGRUDAN calistirilir. Eskiden `cmd /c "... >> log 2>&1"` ile
    # sariyorduk; Defender bu zinciri (gorev -> cmd -> program, URL'li arguman,
    # dosyaya yonlendirme) Trojan:Win32/Dexphot olarak isaretledi. Gunlugu artik
    # programlar kendisi yazar (--log), gorev sade kalir.
    $eylem = New-ScheduledTaskAction -Execute $program -Argument $argumanlar `
        -WorkingDirectory $calismaDizini

    $tetik = New-ScheduledTaskTrigger -AtStartup
    # Acilista iki gorev ayni anda tetiklenir; ajanin backend'den once kalkmamasi
    # icin gecikme. Ajan backend'i zaten bekler (Agent.cs), bu ikinci guvence.
    if ($gecikmeSn -gt 0) { $tetik.Delay = ('PT{0}S' -f $gecikmeSn) }
    $kimlik = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    # Coktugu yerde kalmasin: bir dakika sonra yeniden denesin, suresiz calissin.
    $ayar = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries -StartWhenAvailable `
        -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 99 `
        -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

    Register-ScheduledTask -TaskName $ad -Action $eylem -Trigger $tetik `
        -Principal $kimlik -Settings $ayar | Out-Null
    Tamam "kaydedildi: $ad"
}

$backendLog = Join-Path $LogDizin 'backend.log'
GorevKur $BackendGorev $nodeYol ('backend\server.js --log "{0}"' -f $backendLog) $ProjeKok

if ($ajanExe) {
    $ajanLog = Join-Path $LogDizin 'ajan.log'
    # Tezgah listesi backend'den gelir; ajanin yaninda liste dosyasi tutulmaz.
    # --ingest yalnizca varsayilan olmayan portta verilir: komut satirinda URL
    # yoksa hem sadelesir hem de supheli gorunmez (varsayilan zaten 127.0.0.1:3000).
    $ajanArg = '--log "{0}"' -f $ajanLog
    if ($Port -ne 3000) { $ajanArg = "--ingest http://127.0.0.1:$Port/api/ingest $ajanArg" }
    GorevKur $AjanGorev $ajanExe $ajanArg $ajanCalismaDizini 30
}

# -------------------------------------------------------------- calistirma

Baslik 'Baslatiliyor'

Start-ScheduledTask -TaskName $BackendGorev
Tamam 'backend baslatildi'
Start-Sleep -Seconds 4

$saglik = $null
try {
    $saglik = Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 5
} catch { }

if ($saglik -and $saglik.ok) {
    Tamam "backend yanit veriyor (port $Port)"
} else {
    Uyari 'backend heniz yanit vermiyor'
    Bilgi "log:  $backendLog"
}

if ($ajanExe) {
    Start-ScheduledTask -TaskName $AjanGorev
    Tamam 'ajan baslatildi'
}

# ------------------------------------------------------------------ ozet

Write-Host ''
Write-Host '  KURULUM TAMAM' -ForegroundColor Green
Write-Host ''
Write-Host "    Dashboard   http://localhost:$Port" -ForegroundColor White
if ($AgaAc) {
    $ip = (Get-NetIPAddress -AddressFamily IPv4 |
           Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
           Select-Object -First 1).IPAddress
    if ($ip) { Write-Host "    Agdan       http://${ip}:$Port" -ForegroundColor White }
}
Write-Host ''
Write-Host '    Loglar      ' -NoNewline -ForegroundColor Gray; Write-Host $LogDizin
Write-Host '    Veritabani  ' -NoNewline -ForegroundColor Gray; Write-Host (Join-Path $ProjeKok 'data')
Write-Host ''
Write-Host '  Siradaki adim:' -ForegroundColor Cyan
Write-Host '    1. Dashboard > Ayarlar ekranindan her tezgaha IP gir.'
Write-Host '       Ajan listeyi oradan aliyor; dakikada bir tazeliyor,'
Write-Host '       tezgah eklemek icin yeniden baslatmaya gerek yok.'
Write-Host '    2. Kontrolcude "Start server while boot" ayari ACIK olmali,'
Write-Host '       yoksa reboot sonrasi OCAPIServer kapali gelir.'
Write-Host ''
if (-not $ajanExe) {
    Uyari 'Ajan kurulmadi. Syntec Bin klasoruyle tekrar calistir:'
    Bilgi '  .\kurulum.ps1 -SyntecBin "C:\...\DiskC\OpenCNC\Bin"'
    Write-Host ''
}
Write-Host '  Kaldirmak icin:  .\kurulum.ps1 -Kaldir' -ForegroundColor DarkGray
Write-Host ''
