param(
  [Parameter(Mandatory = $true)][string]$Owner,
  [Parameter(Mandatory = $true)][string]$Repo,
  [string]$Token = $env:GITHUB_TOKEN,
  [string]$Version = "1.3.5",
  [string]$ReleaseNotes = "Zotero 右侧 DeepSeek 侧栏：历史记录、PDF 划词与全文、图片输入、拖入 PDF"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not $Token) {
  throw "Missing GitHub token. Pass -Token or set GITHUB_TOKEN."
}

$headers = @{
  Authorization          = "Bearer $Token"
  Accept                 = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
  "User-Agent"           = "zor-release-script"
}
$api = "https://api.github.com/repos/$Owner/$Repo"

Write-Output "Checking repository $Owner/$Repo ..."
$repoInfo = Invoke-RestMethod -Uri $api -Headers $headers -Method Get
$branch = $repoInfo.default_branch
Write-Output ("Repository: {0} (default branch: {1})" -f $repoInfo.full_name, $branch)

# Upload the repository files that make up the plugin.
$include = @(
  "README.md",
  "LICENSE",
  ".gitignore",
  "build.ps1"
)
$files = @()
foreach ($name in $include) {
  $path = Join-Path $root $name
  if (Test-Path $path) {
    $files += $path
  }
}
foreach ($dir in @("src", "test")) {
  $dirPath = Join-Path $root $dir
  if (Test-Path $dirPath) {
    $files += (Get-ChildItem $dirPath -Recurse -File | Select-Object -ExpandProperty FullName)
  }
}
$files = $files | Sort-Object -Unique

foreach ($file in $files) {
  $relative = $file.Substring($root.Length + 1).Replace("\", "/")
  $content = [Convert]::ToBase64String([IO.File]::ReadAllBytes($file))
  $body = @{
    message = "Add $relative"
    content = $content
    branch  = $branch
  }

  try {
    $existing = Invoke-RestMethod -Uri "$api/contents/$relative" -Headers $headers -Method Get -ErrorAction Stop
    $body.sha = $existing.sha
    $body.message = "Update $relative"
  }
  catch {
    # File does not exist yet; first commit creates it.
  }

  $json = $body | ConvertTo-Json -Depth 5
  Invoke-RestMethod -Uri "$api/contents/$relative" -Headers $headers -Method Put -Body $json -ContentType "application/json" | Out-Null
  Write-Output "uploaded $relative"
}

# Create (or reuse) a release and attach the built xpi.
$xpi = Join-Path $root "dist\zor.xpi"
if (-not (Test-Path $xpi)) {
  throw "Missing built package: $xpi"
}

$tag = "v$Version"
$release = $null
try {
  $release = Invoke-RestMethod -Uri "$api/releases/tags/$tag" -Headers $headers -Method Get -ErrorAction Stop
  Write-Output "Release $tag already exists, reusing it"
}
catch {
  $releaseBody = @{
    tag_name         = $tag
    target_commitish = $branch
    name             = $tag
    body             = $ReleaseNotes
    draft            = $false
    prerelease       = $false
  } | ConvertTo-Json
  $release = Invoke-RestMethod -Uri "$api/releases" -Headers $headers -Method Post -Body $releaseBody -ContentType "application/json"
  Write-Output "Created release $tag"
}

$assets = Invoke-RestMethod -Uri "$api/releases/$($release.id)/assets" -Headers $headers -Method Get
$existingAsset = $assets | Where-Object { $_.name -eq "zor.xpi" }
if ($existingAsset) {
  Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo/releases/assets/$($existingAsset.id)" -Headers $headers -Method Delete | Out-Null
  Write-Output "Removed previous zor.xpi asset"
}

$uploadUrl = "https://uploads.github.com/repos/$Owner/$Repo/releases/$($release.id)/assets?name=zor.xpi"
Invoke-RestMethod -Uri $uploadUrl -Headers $headers -Method Post -ContentType "application/octet-stream" -InFile $xpi | Out-Null
Write-Output "Uploaded zor.xpi to release $tag"
Write-Output ("Done: https://github.com/{0}/{1}/releases/tag/{2}" -f $Owner, $Repo, $tag)
