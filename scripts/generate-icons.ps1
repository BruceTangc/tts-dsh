# Generates the Tauri icon set (PNGs + a multi-size .ico) from a simple
# programmatic "DSH" tile. No external image is required.
# Usage: .\generate-icons.ps1
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$iconsDir = Join-Path $root "src-tauri\icons"
New-Item -ItemType Directory -Force -Path $iconsDir | Out-Null

function New-BaseBitmap([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

    # Background
    $g.Clear([System.Drawing.Color]::FromArgb(255, 15, 17, 21))

    # Rounded accent tile
    $pad = [int]($size * 0.06)
    $radius = [int]($size * 0.18)
    $rect = New-Object System.Drawing.Rectangle($pad, $pad, ($size - 2 * $pad), ($size - 2 * $pad))
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $radius * 2
    $path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
    $path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
    $path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
    $path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
    $path.CloseFigure()

    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 79, 140, 255))
    $g.FillPath($brush, $path)

    # Centered "DSH" text
    $fontSize = [float]($size * 0.40)
    $font = New-Object System.Drawing.Font("Segoe UI", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $white = [System.Drawing.Brushes]::White
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = [System.Drawing.StringAlignment]::Center
    $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
    $textRect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
    $g.DrawString("DSH", $font, $white, $textRect, $fmt)

    $g.Dispose()
    $path.Dispose()
    $brush.Dispose()
    $font.Dispose()
    $fmt.Dispose()
    return $bmp
}

function Save-Png([System.Drawing.Bitmap]$bmp, [string]$path) {
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output "  wrote $path ($($bmp.Width)x$($bmp.Height))"
}

function Get-PngBytes([System.Drawing.Bitmap]$bmp) {
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $ms.ToArray()
    $ms.Dispose()
    return $bytes
}

function Resize([System.Drawing.Bitmap]$src, [int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($src, 0, 0, $size, $size)
    $g.Dispose()
    return $bmp
}

Write-Output "Generating DSH icons into $iconsDir"

$base = New-BaseBitmap 512

# PNGs
Save-Png (Resize $base 32) (Join-Path $iconsDir "32x32.png")
Save-Png (Resize $base 128) (Join-Path $iconsDir "128x128.png")
Save-Png (Resize $base 256) (Join-Path $iconsDir "128x128@2x.png")
Save-Png (Resize $base 512) (Join-Path $iconsDir "icon.png")

# Multi-size .ico (PNG-encoded entries: 16,24,32,48,64,128,256).
# PNG bytes are held in a strongly-typed List[byte[]] so PowerShell does not
# unroll the byte arrays through the pipeline.
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$pngList = New-Object 'System.Collections.Generic.List[byte[]]'
$wList = New-Object 'System.Collections.Generic.List[int]'
foreach ($s in $sizes) {
    $srcBmp = Resize $base $s
    $png = Get-PngBytes $srcBmp
    $srcBmp.Dispose()
    $pngList.Add($png)
    $wList.Add($(if ($s -ge 256) { 0 } else { $s }))
}

$icoPath = Join-Path $iconsDir "icon.ico"
$fs = New-Object System.IO.FileStream($icoPath, [System.IO.FileMode]::Create)
$bw = New-Object System.IO.BinaryWriter($fs)

$count = $pngList.Count
$bw.Write([UInt16]0)      # reserved
$bw.Write([UInt16]1)      # type: icon
$bw.Write([UInt16]$count) # count

$offset = 6 + 16 * $count
for ($i = 0; $i -lt $count; $i++) {
    $w = $wList[$i]
    $len = $pngList[$i].Length
    $bw.Write([byte]$w)   # width (0 = 256)
    $bw.Write([byte]$w)   # height
    $bw.Write([byte]0)    # color count
    $bw.Write([byte]0)    # reserved
    $bw.Write([UInt16]1)  # planes
    $bw.Write([UInt16]32) # bit count
    $bw.Write([UInt32]$len)
    $bw.Write([UInt32]$offset)
    $offset += $len
}
for ($i = 0; $i -lt $count; $i++) {
    $bw.Write($pngList[$i])
}
$bw.Close()

$base.Dispose()
Write-Output "  wrote $icoPath (multi-size .ico)"
Write-Output "Done."
