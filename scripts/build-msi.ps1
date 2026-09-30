param(
  [switch]$SkipFrontendBuild,
  [switch]$RenameOnly
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$tauriRoot = Join-Path $projectRoot "src-tauri"
$bundleDir = Join-Path $tauriRoot "target\\release\\bundle\\msi"

# Prefer the repo-local Rust toolchain (.rustup / .cargo inside the checkout)
# when present, so the app can be built without a machine-wide rustup default
# toolchain and without writing to the user profile.
$localCargoHome = Join-Path $projectRoot ".cargo"
if ((Test-Path -LiteralPath (Join-Path $projectRoot ".rustup")) -and (Test-Path -LiteralPath $localCargoHome)) {
  $env:RUSTUP_HOME = Join-Path $projectRoot ".rustup"
  $env:CARGO_HOME = $localCargoHome
  $env:PATH = "$localCargoHome\bin;$env:PATH"
  Write-Host "Using repo-local Rust toolchain: $localCargoHome\bin"
}

if (-not $RenameOnly -and -not $SkipFrontendBuild) {
  & pnpm build
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

if (-not $RenameOnly) {
  & pnpm tauri build --bundles msi
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

if (-not (Test-Path -LiteralPath $bundleDir)) {
  Write-Error "MSI output directory not found: $bundleDir"
}

$renamedAny = $false
Get-ChildItem -LiteralPath $bundleDir -Filter *.msi -File | ForEach-Object {
  $normalizedName = $_.Name -replace '([._-])(en[-_]?us|zh[-_]?cn)(?=\.msi$)', ''
  if ($normalizedName -ne $_.Name) {
    $targetPath = Join-Path $_.DirectoryName $normalizedName
    if (Test-Path -LiteralPath $targetPath) {
      Remove-Item -LiteralPath $targetPath -Force
    }
    Move-Item -LiteralPath $_.FullName -Destination $targetPath -Force
    Write-Host "Renamed MSI:`n$($_.Name)`n-> $normalizedName"
    $renamedAny = $true
  }
}

if (-not $renamedAny) {
  Write-Host "No locale suffix found in MSI filenames."
}
