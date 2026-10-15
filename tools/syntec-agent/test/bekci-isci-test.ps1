# Ajan bekcisi, TORNA BASINA SUREC kipi (varsayilan) testi: ajan + bekci SAHTE Syntec DLL'iyle derlenir, gercek torna gerekmez.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\syntec-agent\test\bekci-isci-test.ps1
#
# Fabrikada 2026-10-14 16:50'de dort tornanin okumasi AYNI SANIYEDE takildi, ajanin ana dongusu yasadigi icin (ozet satiri yaziyordu)
# bekci "donmadi" saydi ve 17,5 saat veri gelmedi. Bu test o durumu taklit eder: CNC-02 (127.0.0.2) sahte DLL'de HIC cevap vermez
# (MOCK_HANG_HOST), CNC-01 saglamdir.
#
# Senaryolar (her biri PASS/FAIL yazar, hata varsa cikis kodu 1):
#   G  her torna icin AYRI alt surec acilir (--host/--machine-id), ciktilari ortak ajan gunlugune [CNC-xx] etiketiyle ve tarih-saatle yazilir
#   H  CNC-02 takilir: gunluk yazilmaya DEVAM ettigi halde "ILERLEME YOK" -> yalniz CNC-02 sureci yeniden baslatilir (is parcacigi dokumuyle);
#      CNC-01 sureci DOKUNULMAZ, okumaya devam eder
#   I  tezgah listesi degisir: yeni torna icin surec acilir, cikarilanin sureci kapanir, IP degisen yeniden baslar
#   J  bir torna sureci disaridan oldurulur -> yeniden baslar
#   K  bekci oldurulur -> butun torna surecleri de olur (job)
# Sure ~3 dk. Gercek tezgaha/Syntec DLL'ine dokunmaz.

$ErrorActionPreference = 'Stop'
$kok = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$kaynak = Join-Path $kok 'tools\syntec-agent'
$sahte = Join-Path $kok 'tools\syntec-probe\test\MockSyntec.cs'
$d = Join-Path $env:TEMP ('cnc-bekci-isci-test-' + (Get-Random -Maximum 99999))
$port = 39000 + (Get-Random -Maximum 900)
New-Item -ItemType Directory -Force $d | Out-Null

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
& $csc /nologo /target:library "/out:$d\Syntec.RemoteCNC.Win32.dll" $sahte
if ($LASTEXITCODE -ne 0) { throw 'sahte DLL derlenemedi' }
& $csc /nologo /target:exe /platform:x86 /optimize+ "/out:$d\syntec-agent.exe" `
    (Join-Path $kaynak 'Agent.cs') (Join-Path $kaynak 'Bekci.cs') (Join-Path $kaynak 'SyntecReader.cs')
if ($LASTEXITCODE -ne 0) { throw 'ajan derlenemedi' }

$exe = Join-Path $d 'syntec-agent.exe'
$log = Join-Path $d 'ajan.log'
$bekciLog = Join-Path $d 'ajan.bekci.log'
$ingest = "http://127.0.0.1:$port/api/ingest"
# --model YOK (fabrikadaki 11TB gorevi gibi): bekci modeli klasordeki Syntec paketinden cikarmali
$baslangicArgs = @('--supervise', '--ingest', $ingest, '--log', $log,
                   '--stale-sec', '60', '--idle-sec', '30', '--list-sec', '5', '--summary-sec', '5')

$script:hata = 0
function Sonuc($ad, $kosul, $ayrinti) {
    if ($kosul) { Write-Host "  PASS  $ad" } else { Write-Host "  FAIL  $ad  $ayrinti"; $script:hata++ }
}
function Surecler {
    Get-CimInstance Win32_Process -Filter "Name='syntec-agent.exe'" |
        Where-Object { $_.ExecutablePath -eq $exe } |
        Select-Object ProcessId, ParentProcessId, CommandLine, @{ n = 'Kipi'; e = { if ($_.CommandLine -like '*--supervise*') { 'BEKCI' } else { 'ISCI' } } }
}
function Bekci { (Surecler | Where-Object { $_.Kipi -eq 'BEKCI' } | Select-Object -First 1).ProcessId }
# --host <ip> ile baslayan torna sureci
function Isci($ip) { (Surecler | Where-Object { $_.Kipi -eq 'ISCI' -and $_.CommandLine -match ('--host ' + [regex]::Escape($ip) + '( |$)') } | Select-Object -First 1).ProcessId }
function Isciler { @(Surecler | Where-Object { $_.Kipi -eq 'ISCI' }) }
function BekciGunlugu { if (Test-Path $bekciLog) { Get-Content $bekciLog -Raw } else { '' } }
function AjanGunlugu { if (Test-Path $log) { Get-Content $log -Raw } else { '' } }
# ajan gunlugunde bir tornanin en son okunan= degeri
function SonOkunan($id) {
    $m = [regex]::Matches((AjanGunlugu), ('\[' + $id + '\] \[ajan\] [\d:]+\s+okunan=(\d+)'))
    if ($m.Count -eq 0) { return -1 }
    [int]$m[$m.Count - 1].Groups[1].Value
}
function Bekle($sn, $kosulBlogu) {
    $bitis = (Get-Date).AddSeconds($sn)
    while ((Get-Date) -lt $bitis) { if (& $kosulBlogu) { return $true }; Start-Sleep -Milliseconds 500 }
    return $false
}
function Liste($metin) { Invoke-RestMethod "http://127.0.0.1:$port/set?list=$metin" | Out-Null }

$sink = Start-Process node -ArgumentList (Join-Path $PSScriptRoot 'bekci-sink.mjs'), $port -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 1
$env:MOCK_HANG_HOST = '127.0.0.2'

try {
    Write-Host 'G) her torna icin ayri alt surec'
    $bek = Start-Process $exe -ArgumentList $baslangicArgs -WorkingDirectory $d -PassThru -WindowStyle Hidden
    Sonuc 'iki torna sureci acildi' (Bekle 25 { (Isci '127.0.0.1') -and (Isci '127.0.0.2') }) ''
    $b = Bekci
    $s1 = Surecler | Where-Object { $_.CommandLine -match '--host 127\.0\.0\.1 ' } | Select-Object -First 1
    Sonuc 'surecler bekcinin cocugu' ($s1 -and $s1.ParentProcessId -eq $b) ''
    Sonuc 'surec --machine-id ile aciliyor, --supervise ve --log gecmiyor' (($s1.CommandLine -match '--machine-id CNC-01') -and ($s1.CommandLine -notmatch '--supervise') -and ($s1.CommandLine -notmatch '--log')) $s1.CommandLine
    Sonuc "CNC-01 backend'e veri gonderiyor" (Bekle 20 { [int](Invoke-RestMethod "http://127.0.0.1:$port/count") -gt 0 }) ''
    Sonuc 'ortak ajan gunlugunde [CNC-01] ve [CNC-02] satirlari tarih-saatli' (Bekle 15 {
        $g = AjanGunlugu
        ($g -match '(?m)^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \[CNC-01\] baglandi') -and ($g -match '(?m)^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \[CNC-02\] baglandi') }) ''
    Sonuc 'bekci gunlugunde kip ve surum' ((BekciGunlugu) -match 'kip: TORNA BASINA SUREC' -and (BekciGunlugu) -match 'surum 0\.5\.') ''
    Sonuc 'model klasordeki pakete bakilarak bulundu (--model yok)' ((BekciGunlugu) -match 'model: 11TB; tezgah listesi:') ''

    Write-Host 'H) CNC-02 hic cevap vermiyor (ana dongusu yasiyor): yalniz o surec yeniden baslatilir'
    $p1 = Isci '127.0.0.1'
    $p2 = Isci '127.0.0.2'
    $o1 = SonOkunan 'CNC-01'
    Sonuc 'CNC-02 ILERLEME YOK ile yeniden baslatildi' (Bekle 90 { ($x = Isci '127.0.0.2') -and $x -ne $p2 }) 'bekci 90 sn icinde yeniden baslatmadi'
    $g = BekciGunlugu
    Sonuc 'neden gunluge yazildi (ILERLEME YOK)' ($g -match 'CNC-02: ILERLEME YOK') ''
    Sonuc 'is parcacigi dokumu yazildi' ($g -match 'durum dagilimi:') ''
    Sonuc 'CNC-01 sureci DOKUNULMADI (ayni pid)' ((Isci '127.0.0.1') -eq $p1) ''
    Sonuc 'CNC-01 icin yeniden baslatma yok' ($g -notmatch 'CNC-01: ILERLEME YOK' -and $g -notmatch 'CNC-01: ISCI') ''
    $o2 = SonOkunan 'CNC-01'
    Sonuc 'CNC-01 okumaya devam ediyor' ($o2 -gt $o1) "once $o1 sonra $o2"

    Write-Host 'I) tezgah listesi degisir'
    Liste 'CNC-01:127.0.0.1,CNC-03:127.0.0.3'
    Sonuc 'yeni torna (CNC-03) icin surec acildi' (Bekle 25 { Isci '127.0.0.3' }) ''
    Sonuc 'cikarilan torna (CNC-02) sureci kapandi' (Bekle 25 { -not (Isci '127.0.0.2') }) ''
    Sonuc 'cikarma gunluge yazildi' ((BekciGunlugu) -match 'CNC-02: yapilandirmadan cikarildi') ''
    $p1 = Isci '127.0.0.1'
    Liste 'CNC-01:127.0.0.9,CNC-03:127.0.0.3'
    Sonuc 'IP degisen torna yeniden baslatildi (yeni --host)' (Bekle 25 { (Isci '127.0.0.9') }) ''
    Sonuc 'eski IP ile surec kalmadi' (-not (Isci '127.0.0.1')) ''
    Sonuc 'IP degisimi gunluge yazildi' ((BekciGunlugu) -match 'CNC-01: IP degisti: 127\.0\.0\.1 -> 127\.0\.0\.9') ''

    Write-Host 'J) torna sureci disaridan oldurulur -> yeniden baslar'
    $eski = Isci '127.0.0.3'
    Stop-Process -Id $eski -Force
    Sonuc 'CNC-03 sureci yeniden baslatildi' (Bekle 30 { ($x = Isci '127.0.0.3') -and $x -ne $eski }) ''
    Sonuc 'cikis kodu bekci gunlugunde' ((BekciGunlugu) -match 'CNC-03: ISCI CIKTI: cikis kodu 0x') ''

    Write-Host 'K) bekci oldurulur -> butun torna surecleri de olur (job)'
    Start-Sleep -Seconds 3
    Sonuc 'olmadan once surecler var' ((Isciler).Count -ge 2) ''
    Stop-Process -Id (Bekci) -Force
    $bitti = Bekle 15 { @(Surecler).Count -eq 0 }
    Sonuc 'bekci ve torna surecleri birlikte bitti' $bitti ('kalan: ' + ((Surecler | ForEach-Object { $_.Kipi }) -join ','))
}
finally {
    Remove-Item Env:MOCK_HANG_HOST -ErrorAction SilentlyContinue
    Get-Process syntec-agent -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $sink.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    if ($script:hata -gt 0) { Write-Host "`n(test dizini ayrinti icin saklandi: $d)" } else { Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($script:hata -gt 0) { Write-Host "`n$($script:hata) kontrol BASARISIZ"; exit 1 }
Write-Host "`nHepsi gecti"
