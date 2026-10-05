<#
    Masaustu uygulamasinin simgesini (.ico) cizer - dis dosya ya da resim
    gerekmez, System.Drawing yeterli. build-installer.ps1 cagirir.

    Koyu zemin uzerinde bir nabiz cizgisi: "canli veri". Renkler dashboard'un
    koyu temasindan (styles.css).

    256 / 64 / 48 / 32 / 16 px, hepsi PNG olarak gomulu (Vista ve sonrasi).
#>
param([Parameter(Mandatory)][string]$Out)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function Renk([string]$hex) {
    [System.Drawing.ColorTranslator]::FromHtml($hex)
}

# Verilen boyutta PNG baytlarini dondurur.
function Ciz([int]$n) {
    $bmp = New-Object System.Drawing.Bitmap $n, $n, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    # Yuvarlatilmis kare zemin.
    $m = $n * 0.03
    $w = $n - 2 * $m
    $d = $n * 0.36
    $yol = New-Object System.Drawing.Drawing2D.GraphicsPath
    $yol.AddArc($m, $m, $d, $d, 180, 90)
    $yol.AddArc($m + $w - $d, $m, $d, $d, 270, 90)
    $yol.AddArc($m + $w - $d, $m + $w - $d, $d, $d, 0, 90)
    $yol.AddArc($m, $m + $w - $d, $d, $d, 90, 90)
    $yol.CloseFigure()
    $alan = New-Object System.Drawing.RectangleF 0, 0, $n, $n
    $zemin = New-Object System.Drawing.Drawing2D.LinearGradientBrush $alan, (Renk '#26343E'), (Renk '#10171C'), 90
    $g.FillPath($zemin, $yol)

    # Nabiz cizgisi.
    $noktalar = @(
        @(0.15, 0.56), @(0.33, 0.56), @(0.42, 0.30), @(0.53, 0.76),
        @(0.61, 0.42), @(0.67, 0.56), @(0.85, 0.56)
    ) | ForEach-Object { New-Object System.Drawing.PointF ([single]($_[0] * $n)), ([single]($_[1] * $n)) }
    $kalem = New-Object System.Drawing.Pen (Renk '#6FA9D2'), ([single]([math]::Max(1.5, $n * 0.06)))
    $kalem.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $kalem.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $kalem.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawLines($kalem, [System.Drawing.PointF[]]$noktalar)

    # Cizginin ucunda "simdiki an" noktasi.
    $r = $n * 0.055
    $son = $noktalar[-1]
    $g.FillEllipse((New-Object System.Drawing.SolidBrush (Renk '#E7EBEC')), $son.X - $r, $son.Y - $r, 2 * $r, 2 * $r)

    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    return , $ms.ToArray()
}

$boyutlar = 256, 64, 48, 32, 16
$png = New-Object System.Collections.ArrayList
foreach ($b in $boyutlar) { [void]$png.Add((Ciz $b)) }

# ICO: baslik + her boyut icin 16 baytlik dizin girdisi + PNG verileri.
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $ms
$bw.Write([uint16]0)
$bw.Write([uint16]1)
$bw.Write([uint16]$boyutlar.Count)
$ofset = 6 + 16 * $boyutlar.Count
for ($i = 0; $i -lt $boyutlar.Count; $i++) {
    $b = $boyutlar[$i]
    $dim = if ($b -ge 256) { 0 } else { $b }   # 0, 256 anlamina gelir
    $bw.Write([byte]$dim); $bw.Write([byte]$dim)
    $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$png[$i].Length)
    $bw.Write([uint32]$ofset)
    $ofset += $png[$i].Length
}
foreach ($p in $png) { $bw.Write([byte[]]$p) }
$bw.Flush()
[System.IO.File]::WriteAllBytes($Out, $ms.ToArray())
