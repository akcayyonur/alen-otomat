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
#>

[CmdletBinding()]
param(
    # Syntec paketindeki Bin klasoru. Ajan BURADAN calisir - yanindaki native
    # DLL'lere ihtiyaci var, dosyalari ayirmak calismaz.
    [string]$SyntecBin,

    # Dashboard portu.
    [int]$Port = 3000,

    # Dashboard'a baska bilgisayarlardan da bakilacaksa guvenlik duvarinda ac.
    [switch]$AgaAc,

    [switch]$Kaldir
)

$ErrorActionPreference = 'Stop'

$BackendGorev = 'CNC Telemetri - Backend'
$AjanGorev    = 'CNC Telemetri - Edge Agent'
$FwKural      = 'CNC Telemetri'

$ProjeKok = Split-Path -Parent $PSScriptRoot
$LogDizin = Join-Path $ProjeKok 'logs'

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

# ---------------------------------------------------------------- kaldirma

if ($Kaldir) {
    Baslik 'Kurulum kaldiriliyor'
    foreach ($g in @($BackendGorev, $AjanGorev)) {
        if (Get-ScheduledTask -TaskName $g -ErrorAction SilentlyContinue) {
            Stop-ScheduledTask -TaskName $g -ErrorAction SilentlyContinue
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

Baslik 'On kosullar'

# --- Node ---
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) {
    Hata 'Node.js kurulu degil.'
    Bilgi 'Kurmak icin:   winget install OpenJS.NodeJS.LTS'
    Bilgi 'Sonra bu pencereyi kapatip yeniden ac (PATH tazelensin) ve tekrar calistir.'
    exit 1
}
$nodeYol = $node.Source
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
if ($ajanDerlenebilir) { Tamam '.NET Framework 4.0 derleyicisi bulundu' }
else { Uyari '.NET Framework 4.0 yok - ajan derlenemeyecek, backend yine de kurulur' }

# --- Syntec Bin ---
if (-not $SyntecBin) {
    Uyari 'Syntec Bin klasoru verilmedi (-SyntecBin). Yalnizca backend kurulacak.'
    Bilgi 'Ajani sonra kurmak icin betigi -SyntecBin ile tekrar calistir.'
} elseif (-not (Test-Path $SyntecBin)) {
    Hata "Syntec Bin klasoru bulunamadi: $SyntecBin"
    exit 1
} else {
    Tamam "Syntec Bin: $SyntecBin"
}

New-Item -ItemType Directory -Force -Path $LogDizin | Out-Null

# ------------------------------------------------------------- ajan kurulumu

$ajanExe = $null
if ($SyntecBin -and $ajanDerlenebilir) {
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

function GorevKur($ad, $program, $argumanlar, $calismaDizini, $log) {
    if (Get-ScheduledTask -TaskName $ad -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $ad -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $ad -Confirm:$false
    }

    # cmd /c ile sariyoruz: zamanlanmis gorevin konsolu yok, cikti log dosyasina
    # yonlendirilmeli - yoksa bir sorun ciktiginda hicbir iz kalmaz.
    #
    # DIS TIRNAK sart: `cmd /c "..."` biciminde, icerideki yollar da tirnakliyken
    # cmd ilk ve son tirnagi soyup geri kalani komut olarak alir. Dis tirnak
    # olmazsa bosluklu yollarda (Program Files gibi) sessizce bozulur.
    $komut = "`"`"$program`" $argumanlar >> `"$log`" 2>&1`""
    $eylem = New-ScheduledTaskAction -Execute 'cmd.exe' `
        -Argument "/c $komut" -WorkingDirectory $calismaDizini

    $tetik = New-ScheduledTaskTrigger -AtStartup
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
GorevKur $BackendGorev $nodeYol 'backend\server.js' $ProjeKok $backendLog

if ($ajanExe) {
    $ajanLog = Join-Path $LogDizin 'ajan.log'
    # Tezgah listesi backend'den gelir; ajanin yaninda liste dosyasi tutulmaz.
    $ajanArg = "--ingest http://127.0.0.1:$Port/api/ingest"
    GorevKur $AjanGorev $ajanExe $ajanArg $SyntecBin $ajanLog
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
