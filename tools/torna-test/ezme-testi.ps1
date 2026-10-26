<#
  TORNA FTP "EZME" TESTI - toplu gonderimin gercek tornada dayandigi islemleri GUVENLI sekilde dener.

  Ne yapar: tornanin FTP'sinde, VAR OLAN bir musteri klasorunde yalniz "ZZTEST..." adli kendi dosyalarini olusturur, yeniden adlandirir,
  okur ve siler. Baska hicbir dosyaya DOKUNMAZ (listeleme haricinde). Bitince hepsini siler; silinemeyen olursa adini ve elle silme
  komutunu yazar.

  Neyi olcer (toplu gonderme urunu BUNLARA dayanir):
    1. STOR (yukleme) ve geri okuma                        -> mevcut gonderme zaten bunu kullaniyor
    2. RNFR/RNTO hedef ADI YOKKEN                          -> mevcut gonderme zaten bunu kullaniyor
    3. RNFR/RNTO hedef ADI VARKEN (ezer mi, reddeder mi?) -> URUN buna GUVENMEZ; yalniz bilgi icin olculur
    4. DELE (silme)                                        -> yan adli eski dosyanin silinmesi; GERCEK TORNADA HIC DENENMEDI
    5. Urunun tam sirasi: yeni dosya yukle -> eskiyi yan ada al -> yenisini asil ada koy -> yan adi sil

  Kullanim (fabrika PC'sinde, PowerShell):
      .\ezme-testi.ps1 -TornaIp 192.168.88.97 -Klasor MUSTERI_KLASORU
  -Klasor: tornada ZATEN VAR OLAN bir musteri klasoru (klasor acilmaz). Tornada 22TB icin bir kere, 11TB icin bir kere calistirin.
  Cikti: ekrandaki ozeti ve "ezme-testi-<ip>.log" dosyasini bana gonderin.
  Gereken: Windows 10/11'deki curl.exe (yuklu gelir).
#>
param(
    [Parameter(Mandatory = $true)][string]$TornaIp,
    [Parameter(Mandatory = $true)][string]$Klasor,
    [int]$Port = 21,
    [string]$Kullanici = 'anonymous',
    [string]$Sifre = 'cnc-telemetri@local'
)

$ErrorActionPreference = 'Continue'
$curl = (Get-Command curl.exe -ErrorAction SilentlyContinue).Source
if (-not $curl) { Write-Host 'curl.exe bulunamadi (Windows 10/11 ile gelir).' -ForegroundColor Red; exit 2 }
if ($Klasor -notmatch '^[A-Za-z0-9_.-]{1,40}$') { Write-Host 'Klasor adi yalniz harf, rakam, _ - . icermeli.' -ForegroundColor Red; exit 2 }

$tmp = Join-Path $env:TEMP ("ezme-testi-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $tmp | Out-Null
$logFile = Join-Path (Get-Location) ("ezme-testi-" + ($TornaIp -replace '[^0-9A-Za-z.]', '_') + ".log")
Set-Content -Path $logFile -Value ("EZME TESTI " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + "  torna=$TornaIp klasor=$Klasor") -Encoding ASCII

$base = "ftp://${TornaIp}:${Port}/$Klasor/"
$auth = @('--user', "${Kullanici}:${Sifre}", '--connect-timeout', '10', '--max-time', '60')
$sonuclar = New-Object System.Collections.ArrayList
$olusturulan = New-Object System.Collections.ArrayList   # tornada olusturdugumuz adlar (temizlik icin)

function Log([string]$m) { Add-Content -Path $logFile -Value $m -Encoding ASCII }

# curl'u calistirir; (cikis kodu, tum cikti satirlari) dondurur. -v ile FTP yanitlari ("< 250 ...") da gelir.
function CurlCalistir([string[]]$argumanlar) {
    $out = & $curl @auth -s -v --stderr - @argumanlar
    $kod = $LASTEXITCODE
    $satirlar = @($out | ForEach-Object { "$_" })
    return [pscustomobject]@{ Kod = $kod; Satirlar = $satirlar }
}

# Klasor icinde FTP komutlari (curl -Q "+KOMUT": CWD'den SONRA gonderilir). Yanit satirlarini ("< 550 ...") toplar.
function Komut([string[]]$komutlar) {
    $a = @()
    foreach ($k in $komutlar) { $a += @('-Q', "+$k") }
    $r = CurlCalistir ($a + @('-o', 'NUL', $base))   # komutlar CWD'den sonra gonderilir; klasor listesi NUL'a atilir (kanitlanmis kalip)
    # yalniz bizim komutlarimizin yanitlari: "> RNFR ad" satirini izleyen "< 350 ..." satiri (giris konusmasi gosterilmez)
    $yanit = @()
    $bekleyen = $null
    foreach ($l in $r.Satirlar) {
        if ($l -match '^> (RNFR|RNTO|DELE) (.+)$') { $bekleyen = $Matches[1] }
        elseif ($bekleyen -and $l -match '^< ([0-9]{3}) (.*)$') { $yanit += ('{0} -> {1} {2}' -f $bekleyen, $Matches[1], $Matches[2].Trim()); $bekleyen = $null }
    }
    # cikis kodu 0 = tum komutlar kabul; 21 = bir komut hata dondu (ornegin 550)
    return [pscustomobject]@{ Kod = $r.Kod; Yanit = $yanit }
}

function Liste {
    $r = CurlCalistir @($base)
    $hata = $r.Kod -ne 0
    return [pscustomobject]@{ Hata = $hata; Satirlar = @($r.Satirlar | Where-Object { $_ -notmatch '^[*<>{}]' -and $_ -match '\S' -and $_ -notmatch '^(  % Total|\s+Dload|\s+\d)' }) }
}

function AdVarMi([string]$ad) {
    $l = Liste
    return [bool]($l.Satirlar | Where-Object { $_ -match ('(^|\s)' + [regex]::Escape($ad) + '\s*$') })
}

function Yukle([string]$ad, [byte[]]$icerik) {
    $yerel = Join-Path $tmp ("yukle-" + $ad)
    [IO.File]::WriteAllBytes($yerel, $icerik)
    [void]$olusturulan.Add($ad)
    $r = CurlCalistir @('-T', $yerel, ($base + $ad))
    return $r.Kod -eq 0
}

function Oku([string]$ad) {
    $yerel = Join-Path $tmp ("oku-" + $ad)
    if (Test-Path $yerel) { Remove-Item $yerel -Force }
    $r = CurlCalistir @('-o', $yerel, ($base + $ad))
    if ($r.Kod -ne 0 -or -not (Test-Path $yerel)) { return $null }
    return [IO.File]::ReadAllBytes($yerel)
}

function Esit([byte[]]$a, [byte[]]$b) {
    if ($null -eq $a -or $null -eq $b -or $a.Length -ne $b.Length) { return $false }
    for ($i = 0; $i -lt $a.Length; $i++) { if ($a[$i] -ne $b[$i]) { return $false } }
    return $true
}

function Adim([string]$ad, [bool]$tamam, [string]$ayrinti) {
    $d = if ($tamam) { 'TAMAM ' } else { 'HATA  ' }
    $renk = if ($tamam) { 'Green' } else { 'Red' }
    Write-Host ("  [{0}] {1} {2}" -f $d, $ad, $ayrinti) -ForegroundColor $renk
    Log ("[{0}] {1} {2}" -f $d.Trim(), $ad, $ayrinti)
    [void]$sonuclar.Add([pscustomobject]@{ Ad = $ad; Tamam = $tamam; Ayrinti = $ayrinti })
}

$eski = [Text.Encoding]::ASCII.GetBytes("//ZZTEST ESKI ICERIK`r`nG0 X0.`r`nM99`r`n")
$yeni = [Text.Encoding]::ASCII.GetBytes("//ZZTEST YENI ICERIK`r`nG0 X10.`r`nG1 Z-5. F0.2`r`nM99`r`n")
$s = Get-Random -Minimum 100000 -Maximum 999999
$orijinal = "ZZTESTO$s"   # "tornadaki mevcut program" rolu
$temp = "ZZTESTU$s"      # urunun gecici adi (ZZUP rolu)
$yan = "ZZTESTR$s"       # yan ad (ZZRB rolu)
$deneme = "ZZTESTX$s"    # ezme-semantigi denemesi icin

Write-Host ''
Write-Host "EZME TESTI: $TornaIp  klasor: $Klasor  (yalniz ZZTEST... adli kendi dosyalarimiz)" -ForegroundColor Cyan
Write-Host ''

# 0) on kontrol: klasor var mi, bizim adlarimiz bos mu (YALNIZ OKUMA)
$ilk = Liste
if ($ilk.Hata) {
    Adim '0 Klasor listeleme' $false "klasor listelenemedi (FTP baglantisi ya da klasor adi). Bu klasor tornada VAR olmali: $Klasor"
    Write-Host ''; Write-Host 'Test baslamadi; tornaya hicbir sey yazilmadi.' -ForegroundColor Yellow
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}
Adim '0 Klasor listeleme' $true ("{0} satir; klasor var" -f $ilk.Satirlar.Count)
if (@($ilk.Satirlar | Where-Object { $_ -match 'ZZTEST' }).Count -gt 0) {
    Adim '0 Onceki test artigi' $false 'klasorde ZZTEST... dosyasi var; once elle silin ya da farkli klasor secin'
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}

# 1) yukleme + geri okuma (STOR/RETR)
$ok = Yukle $orijinal $eski
$geri = if ($ok) { Oku $orijinal } else { $null }
Adim '1 Yukleme ve geri okuma (STOR/RETR)' ($ok -and (Esit $geri $eski)) ("{0} adli ESKI icerik tornada ve bayt bayt ayni" -f $orijinal)

# 2) yeniden adlandirma, hedef adi YOK (urunun kullandigi islem)
$ok = Yukle $temp $yeni
$r = Komut @("RNFR $orijinal", "RNTO $yan")
$varmi = (AdVarMi $yan) -and -not (AdVarMi $orijinal)
Adim '2 Yeniden adlandirma, hedef bos (RNFR/RNTO)' ($ok -and $varmi) ("{0} -> {1}; yanit: {2}" -f $orijinal, $yan, ($r.Yanit -join ' | '))

# 3) EZME SEMANTIGI (bilgi amacli: urun buna dayanmaz): hedef adi VARKEN RNTO
$ok = Yukle $deneme $yeni
$r = Komut @("RNFR $deneme", "RNTO $yan")
$ezdi = $r.Kod -eq 0
$icerikYan = Oku $yan
$ezilmis = $ezdi -and (Esit $icerikYan $yeni)
if ($ezdi -and $ezilmis) { Adim '3 Hedef ad VARKEN RNTO (bilgi)' $true "tornada RNTO hedef adi EZER (urun buna dayanmaz; bilgi)" }
elseif ($ezdi) { Adim '3 Hedef ad VARKEN RNTO (bilgi)' $true ("RNTO kabul edildi ama icerik degismedi: " + ($r.Yanit -join ' | ')) }
else { Adim '3 Hedef ad VARKEN RNTO (bilgi)' $true ("RNTO hedef ad varken REDDETTI (beklenen): " + ($r.Yanit -join ' | ')) }

# 4) urunun tam sirasi: yeni (temp) hazir, eski yan adda; yeniyi asil ada koy, dogrula, yan adi sil
$r = Komut @("RNFR $temp", "RNTO $orijinal")
$yeniOkunan = Oku $orijinal
Adim '4 Yeni dosyayi asil ada koyma' (($r.Kod -eq 0) -and (Esit $yeniOkunan $yeni)) ("{0} -> {1}; asil adda YENI icerik; yanit: {2}" -f $temp, $orijinal, ($r.Yanit -join ' | '))

# 5) DELE: yan adli eski dosyayi sil (gercek tornada hic denenmedi)
$r = Komut @("DELE $yan")
$gitti = -not (AdVarMi $yan)
Adim '5 Yan adli dosyayi silme (DELE)' (($r.Kod -eq 0) -and $gitti) ("{0}; yanit: {1}" -f ($(if ($gitti) { 'listeden kalkti' } else { 'LISTEDE DURUYOR' })), ($r.Yanit -join ' | '))

# 6) temizlik: bu calistirmaya ait (adinda ayni rakam dizisi olan) TUM ZZTEST... dosyalarini listeden bulup sil
$desen = '(ZZTEST[A-Z]' + $s + ')\s*$'
$izler = @((Liste).Satirlar | ForEach-Object { if ($_ -match $desen) { $Matches[1] } })
foreach ($ad in $izler) { [void](Komut @("DELE $ad")) }
$kalan = @((Liste).Satirlar | ForEach-Object { if ($_ -match $desen) { $Matches[1] } })
if ($kalan.Count -eq 0) { Adim '6 Temizlik' $true 'tornada ZZTEST... dosyasi kalmadi' }
else {
    Adim '6 Temizlik' $false ("SILINEMEYEN: " + ($kalan -join ', ') + " (icerikleri onemsiz test verisi; panelden ya da FTP ile elle silinebilir)")
    Write-Host ("  Elle silmek icin (PowerShell): curl.exe -Q '+DELE {0}' ftp://{1}:{2}/{3}/" -f $kalan[0], $TornaIp, $Port, $Klasor) -ForegroundColor Yellow
}

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

$hatali = @($sonuclar | Where-Object { -not $_.Tamam })
Write-Host ''
if ($hatali.Count -eq 0) { Write-Host 'SONUC: HEPSI TAMAM. Toplu gonderme bu tornada gerekli islemleri yapabiliyor.' -ForegroundColor Green }
else { Write-Host ("SONUC: {0} adim HATALI. Toplu gonderme bu tornada AKTIF EDILMEMELI; log dosyasini gonderin." -f $hatali.Count) -ForegroundColor Red }
Write-Host "Log: $logFile" -ForegroundColor Cyan
Log ("SONUC: " + $(if ($hatali.Count -eq 0) { 'HEPSI TAMAM' } else { "$($hatali.Count) HATALI ADIM" }))
if ($hatali.Count -gt 0) { exit 1 }
