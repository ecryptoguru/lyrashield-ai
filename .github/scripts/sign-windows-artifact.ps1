param(
  [Parameter(Mandatory = $true)]
  [string]$FilePath
)

$ErrorActionPreference = "Stop"

foreach ($name in @(
  "AZURE_ARTIFACT_SIGNING_ENDPOINT",
  "AZURE_ARTIFACT_SIGNING_ACCOUNT",
  "AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE"
)) {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
    throw "Required Artifact Signing setting $name is missing."
  }
}

if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
  throw "Artifact to sign does not exist."
}

$signTool = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Recurse -Filter signtool.exe |
  Where-Object { $_.FullName -match "\\x64\\signtool\.exe$" } |
  Where-Object { $_.Directory.Parent.Name -as [version] } |
  Sort-Object { $_.Directory.Parent.Name -as [version] } -Descending |
  Select-Object -First 1
if (-not $signTool) {
  throw "Windows SDK signtool.exe was not found."
}

# artifact-signing-cli 0.11 performs its own service-principal login. The release
# job has already authenticated with GitHub OIDC, so this adapter preserves that
# short-lived Azure CLI session and prevents client-secret authentication.
$azureAdapter = Join-Path $env:RUNNER_TEMP "lyrashield-oidc-azure.cmd"
@"
@echo off
if /I not "%1"=="login" exit /b 2
az account show --output none
"@ | Set-Content -LiteralPath $azureAdapter -Encoding ascii

$env:AZURE_CLI_PATH = $azureAdapter
$env:SIGNTOOL_PATH = $signTool.FullName
if ($env:GITHUB_ENV) {
  "SIGNTOOL_PATH=$($signTool.FullName)" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
}

& artifact-signing-cli `
  --azure-client-secret "oidc-session-no-client-secret" `
  --endpoint $env:AZURE_ARTIFACT_SIGNING_ENDPOINT `
  --account $env:AZURE_ARTIFACT_SIGNING_ACCOUNT `
  --certificate $env:AZURE_ARTIFACT_SIGNING_CERTIFICATE_PROFILE `
  --fd SHA256 `
  --tr "http://timestamp.acs.microsoft.com" `
  --td SHA256 `
  --description "LyraShield" `
  $FilePath
if ($LASTEXITCODE -ne 0) {
  throw "Azure Artifact Signing failed."
}
