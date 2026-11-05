param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Notes = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = "babysharks2/deepseek-zotero"
$tag = "v$Version"

$git = "D:\install\git\Git\cmd\git.exe"
if (-not (Test-Path $git)) {
  $git = (Get-Command git -ErrorAction SilentlyContinue).Source
}
if (-not $git) {
  throw "git not found. Install Git or set the path in this script."
}

Set-Location $root

$branch = (& $git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne "main") {
  throw "Release must be cut from 'main' (current branch: $branch)."
}

$existingTag = & $git tag --list $tag
if ($existingTag) {
  throw "Tag $tag already exists. Bump the version instead of reusing it."
}

# 1. Bump the version in manifest.json and updates.json.
# IMPORTANT: write UTF-8 without BOM. Zotero's JSON parser rejects a BOM, and
# PowerShell 5.1's Set-Content -Encoding UTF8 always adds one.
function Write-Utf8NoBom([string]$path, [string]$text) {
  [IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

$manifestPath = Join-Path $root "src\manifest.json"
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$manifest.version = $Version
Write-Utf8NoBom $manifestPath ($manifest | ConvertTo-Json -Depth 8)

$updatesPath = Join-Path $root "updates.json"
$updates = Get-Content $updatesPath -Raw | ConvertFrom-Json
$updates.addons.'zor@deepseek.local'.updates[0].version = $Version
$updates.addons.'zor@deepseek.local'.updates[0].update_link = "https://github.com/$repo/releases/download/$tag/zor.xpi"
Write-Utf8NoBom $updatesPath ($updates | ConvertTo-Json -Depth 10)

# 2. Build the xpi.
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "build.ps1")

# 3. Commit, tag and push.
& $git add -A
& $git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  & $git commit -m "Release v$Version"
}
& $git tag $tag
& $git push origin main
& $git push origin $tag

# 4. Create the GitHub release and attach the xpi.
$input = "protocol=https`nhost=github.com`n`n"
$raw = $input | & $git credential fill 2>&1
$token = (($raw -split "`n") | Where-Object { $_ -match "^password=" }) -replace "^password=", ""
if (-not $token) {
  throw "No cached GitHub credential found. Run 'git push' once to authenticate."
}

$headers = @{
  Authorization          = "token $token"
  Accept                 = "application/vnd.github+json"
  "User-Agent"           = "zor-release"
  "X-GitHub-Api-Version" = "2022-11-28"
}
$api = "https://api.github.com/repos/$repo"

$release = $null
try {
  $release = Invoke-RestMethod -Uri "$api/releases/tags/$tag" -Headers $headers -Method Get -ErrorAction Stop
}
catch {
  $body = @{
    tag_name         = $tag
    target_commitish = "main"
    name             = $tag
    body             = if ($Notes) { $Notes } else { "Zor $Version" }
    draft            = $false
    prerelease       = $false
  } | ConvertTo-Json -Depth 5
  # PowerShell 5.1 encodes a string body as ISO-8859-1, which turns Chinese into
  # '?'. Send raw UTF-8 bytes instead.
  $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  $release = Invoke-RestMethod -Uri "$api/releases" -Headers $headers -Method Post -Body $bodyBytes -ContentType "application/json; charset=utf-8"
}

$assets = Invoke-RestMethod -Uri "$api/releases/$($release.id)/assets" -Headers $headers -Method Get
foreach ($asset in $assets) {
  if ($asset.name -eq "zor.xpi") {
    Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/assets/$($asset.id)" -Headers $headers -Method Delete | Out-Null
  }
}

$xpi = Join-Path $root "dist\zor.xpi"
$uploadUrl = "https://uploads.github.com/repos/$repo/releases/$($release.id)/assets?name=zor.xpi"
Invoke-RestMethod -Uri $uploadUrl -Headers $headers -Method Post -ContentType "application/octet-stream" -InFile $xpi | Out-Null

# 5. Flush the jsDelivr edge cache so Zotero sees the new updates.json quickly.
try {
  Invoke-RestMethod -Uri "https://purge.jsdelivr.net/gh/$repo@main/updates.json" -TimeoutSec 30 | Out-Null
  Write-Output "CDN cache purged"
}
catch {
  Write-Output ("CDN purge failed (not fatal): " + $_.Exception.Message)
}

Write-Output ("Release {0} published: https://github.com/{1}/releases/tag/{0}" -f $tag, $repo)
Write-Output ("Download: https://github.com/{0}/releases/download/{1}/zor.xpi" -f $repo, $tag)
