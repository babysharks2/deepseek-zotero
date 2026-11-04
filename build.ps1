param(
  [switch]$Clean
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $root "src"
$dist = Join-Path $root "dist"
$out = Join-Path $dist "zor.xpi"

if (-not (Test-Path $src)) {
  throw "src directory not found: $src"
}

New-Item -ItemType Directory -Force -Path $dist | Out-Null
if ($Clean -and (Test-Path $dist)) {
  Get-ChildItem $dist -Recurse | Remove-Item -Force -Recurse
}
if (Test-Path $out) {
  Remove-Item $out -Force
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

# Build the archive entry by entry so every entry name uses forward slashes.
# ZipFile.CreateFromDirectory writes Windows-style separators for directories,
# which Gecko cannot resolve inside an XPI.
$zip = [System.IO.Compression.ZipFile]::Open($out, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  $files = Get-ChildItem $src -Recurse -File | Sort-Object FullName
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($src.Length + 1).Replace("\", "/")
    $entry = $zip.CreateEntry($relative, [System.IO.Compression.CompressionLevel]::Optimal)
    $target = $entry.Open()
    $source = [System.IO.File]::OpenRead($file.FullName)
    try {
      $source.CopyTo($target)
    }
    finally {
      $source.Dispose()
      $target.Dispose()
    }
  }
}
finally {
  $zip.Dispose()
}

$size = (Get-Item $out).Length
Write-Output ("Built {0} ({1} bytes)" -f $out, $size)
