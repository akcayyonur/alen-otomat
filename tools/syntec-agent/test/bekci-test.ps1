# Ajan bekcisi (--supervise) testi: ajan + bekci SAHTE Syntec DLL'iyle derlenir, gercek torna gerekmez.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\syntec-agent\test\bekci-test.ps1
#
# Senaryolar (her biri PASS/FAIL yazar, hata varsa cikis kodu 1):
#   A  bekci ajani ALT SUREC olarak baslatir (--supervise alt surece gecmez)
#   B  alt surec zorla oldurulur          -> yeniden baslar, cikis kodu bekci gunlugunde
#   C  alt surec DONDURULUR (NtSuspendProcess; gunluk yazmaz) -> bekci oldurup yeniden baslatir,
#      is parcacigi dokumunu yazar
#   F  bekcinin kendisi 12 sn dondurulur (PC duraklamasi taklidi) -> "SISTEM DURAKLAMASI" satiri (islemci/bellek ile)
#   D  bekci oldurulur                    -> job nesnesi alt sureci de oldurur
#   E  ajan normal cikar (--duration, kod 0) -> bekci yine yeniden baslatir
# Sure ~3 dk (C: donma siniri 75 sn, ajan her dakika ozet yazar). Gercek tezgaha/Syntec DLL'ine dokunmaz.

$ErrorActionPreference = 'Stop'
$kok = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$kaynak = Join-Path $kok 'tools\syntec-agent'
$sahte = Join-Path $kok 'tools\syntec-probe\test\MockSyntec.cs'
$d = Join-Path $env:TEMP ('cnc-bekci-test-' + (Get-Random -Maximum 99999))
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
# Bu test ESKI (tek surec) kipi dener; torna basina surec kipi bekci-isci-test.ps1'de
$baslangicArgs = @('--supervise', '--tek-surec', '--model', '11TB', '--ingest', $ingest, '--log', $log, '--stale-sec', '75')

Add-Type -Namespace NtK -Name P -MemberDefinition '[System.Runtime.InteropServices.DllImport("ntdll.dll")] public static extern int NtSuspendProcess(System.IntPtr h); [System.Runtime.InteropServices.DllImport("ntdll.dll")] public static extern int NtResumeProcess(System.IntPtr h);'

$script:hata = 0
function Sonuc($ad, $kosul, $ayrinti) {
    if ($kosul) { Write-Host "  PASS  $ad" } else { Write-Host "  FAIL  $ad  $ayrinti"; $script:hata++ }
}
function Surecler {
    Get-CimInstance Win32_Process -Filter "Name='syntec-agent.exe'" |
        Where-Object { $_.ExecutablePath -eq $exe } |
        Select-Object ProcessId, ParentProcessId, @{ n = 'Kipi'; e = { if ($_.CommandLine -like '*--supervise*') { 'BEKCI' } else { 'AJAN' } } }
}
function Ajan { (Surecler | Where-Object { $_.Kipi -eq 'AJAN' } | Select-Object -First 1).ProcessId }
function Bekci { (Surecler | Where-Object { $_.Kipi -eq 'BEKCI' } | Select-Object -First 1).ProcessId }
function BekciGunlugu { if (Test-Path $bekciLog) { Get-Content $bekciLog -Raw } else { '' } }
function Bekle($sn, $kosulBlogu) {
    $bitis = (Get-Date).AddSeconds($sn)
    while ((Get-Date) -lt $bitis) { if (& $kosulBlogu) { return $true }; Start-Sleep -Milliseconds 500 }
    return $false
}

$sink = Start-Process node -ArgumentList (Join-Path $PSScriptRoot 'bekci-sink.mjs'), $port -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 1

try {
    Write-Host 'A) bekci ajani alt surec olarak baslatir'
    $bek = Start-Process $exe -ArgumentList $baslangicArgs -WorkingDirectory $d -PassThru -WindowStyle Hidden
    $acildi = Bekle 15 { (Ajan) -and (Bekci) }
    $a = Surecler | Where-Object { $_.Kipi -eq 'AJAN' } | Select-Object -First 1
    Sonuc 'bekci ve ajan sureci var' $acildi ''
    Sonuc 'ajanin ebeveyni bekci' ($a -and $a.ParentProcessId -eq (Bekci)) ''
    Sonuc "ajan calisiyor, backend'e veri gidiyor" (Bekle 15 { [int](Invoke-RestMethod "http://127.0.0.1:$port/count") -gt 0 }) ''
    Sonuc '--supervise alt surece gecmedi' ((BekciGunlugu) -notmatch 'alt surec:.*--supervise') ''
    Sonuc 'ajan gunlugunde olay satirlari tarih-saatli' (@((Get-Content $log) -match '^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \[CNC-01\] baglandi').Count -gt 0) ''
    Sonuc 'bekci gunlugu satirlari tarih-saatli (cift degil)' (@((Get-Content $bekciLog) -match '^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \[bekci\] bekci basladi').Count -eq 1) ''

    Write-Host 'B) alt surec zorla oldurulur -> yeniden baslar'
    $eski = Ajan
    Stop-Process -Id $eski -Force
    $yenilendi = Bekle 30 { $x = Ajan; $x -and $x -ne $eski }
    Sonuc 'ajan yeniden baslatildi' $yenilendi ''
    Sonuc 'cikis kodu bekci gunlugunde' ((BekciGunlugu) -match 'AJAN CIKTI: cikis kodu 0x') ''

    Write-Host 'C) alt surec dondurulur (gunluk durur) -> bekci oldurup yeniden baslatir'
    Start-Sleep -Seconds 3
    $eski = Ajan
    $p = [System.Diagnostics.Process]::GetProcessById($eski)
    [void][NtK.P]::NtSuspendProcess($p.Handle)
    $degisti = Bekle 150 { $x = Ajan; $x -and $x -ne $eski }
    Sonuc 'donmus ajan degistirildi' $degisti 'bekci 150 sn icinde yeniden baslatmadi'
    $g = BekciGunlugu
    Sonuc 'donma gunluge yazildi' ($g -match 'AJAN DONMUS') ''
    Sonuc 'is parcacigi dokumu yazildi' ($g -match 'durum dagilimi:') ''

    Write-Host 'F) bekci surecinin kendisi 12 sn durdurulur (PC duraklamasi taklidi) -> SISTEM DURAKLAMASI satiri'
    Start-Sleep -Seconds 3
    $bp = [System.Diagnostics.Process]::GetProcessById((Bekci))
    [void][NtK.P]::NtSuspendProcess($bp.Handle)
    Start-Sleep -Seconds 12
    [void][NtK.P]::NtResumeProcess($bp.Handle)
    Sonuc 'duraklama bekci gunlugune yazildi' (Bekle 10 { (BekciGunlugu) -match 'SISTEM DURAKLAMASI' }) ''
    Sonuc 'duraklama satirinda islemci ve bellek bilgisi var' ((BekciGunlugu) -match 'SISTEM DURAKLAMASI.*islemci \d+% mesguldu.*MB bos') ''

    Write-Host 'D) bekci oldurulur -> alt surec de olur (job)'
    Start-Sleep -Seconds 3
    Stop-Process -Id (Bekci) -Force
    $bitti = Bekle 10 { @(Surecler).Count -eq 0 }
    Sonuc 'bekci ve ajan birlikte bitti' $bitti ('kalan: ' + ((Surecler | ForEach-Object { $_.Kipi }) -join ','))

    Write-Host 'E) ajan normal cikar (kod 0) -> bekci yine baslatir'
    Remove-Item $bekciLog -Force -ErrorAction SilentlyContinue
    $bek = Start-Process $exe -ArgumentList ($baslangicArgs + @('--duration', '6')) -WorkingDirectory $d -PassThru -WindowStyle Hidden
    $iki = Bekle 40 { ([regex]::Matches((BekciGunlugu), 'ajan baslatildi')).Count -ge 2 }
    Sonuc 'kod 0 cikisindan sonra yeniden baslatildi' $iki ''
    Sonuc 'cikis kodu 0 kaydedildi' ((BekciGunlugu) -match 'cikis kodu 0x00000000') ''
}
finally {
    Get-Process syntec-agent -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $sink.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue
}

if ($script:hata -gt 0) { Write-Host "`n$($script:hata) kontrol BASARISIZ"; exit 1 }
Write-Host "`nHepsi gecti"
