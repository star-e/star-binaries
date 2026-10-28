param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('x64-windows-star', 'arm64-osx-star')][string]$Triplet,
    [ValidateRange(1, 64)][int]$Jobs = 4
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath "$PSScriptRoot/../..").Path
$cache = Join-Path $root "out/dotnet/full-sdk/$Triplet"
$validation = Join-Path $root "out/dotnet/ci/$Triplet"
$resultFile = Join-Path $validation 'sdk-root.txt'

function Invoke-CMake([string]$FailureMessage, [string[]]$Arguments) {
    # Windows PowerShell wraps native stderr as ErrorRecord when redirected.
    # Treat the native exit status as authoritative, including for CMake warnings.
    $savedPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & cmake @Arguments
        $status = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $savedPreference
    }
    if ($status -ne 0) { throw $FailureMessage }
}

# The source-build child initializes its own VS environment. Consumer validation
# uses CMake's Visual Studio generator, which locates MSVC without a developer shell.
New-Item -ItemType Directory -Force $cache, $validation | Out-Null
$cachedFiles = @(Get-ChildItem -LiteralPath $cache -File)
$built = $cachedFiles.Count -eq 0
Push-Location -LiteralPath $root
try {
    if ($built) {
        Write-Host 'No matching full SDK cache; building from the pinned source.'
        Invoke-CMake -FailureMessage 'CoreCLR build or full SDK validation failed' -Arguments @(
            "-DTRIPLET=$Triplet", "-DJOBS=$Jobs", '-P', 'scripts/build-dotnet.cmake')
        $directory = Join-Path $root "out/dotnet/$Triplet/Release"
    } else {
        Write-Host 'Reusing a full SDK cache; revalidating with the current consumer.'
        $directory = $cache
    }
    $archives = @(Get-ChildItem -LiteralPath $directory -File | Where-Object {
        $_.Name -match "^star-dotnet-.+-$([regex]::Escape($Triplet))-release-sdk\.(zip|tar\.gz)$"
    })
    if ($archives.Count -ne 1) { throw 'Expected exactly one full CoreCLR SDK archive' }
    $archive = $archives[0].FullName
    if (!$built -and $cachedFiles.Count -ne 2) { throw 'Full SDK cache must contain only an archive and checksum' }
    Invoke-CMake -FailureMessage 'Full SDK archive validation failed; cached failures are not hidden by rebuilding' -Arguments @(
        "-DARCHIVE=$archive", "-DTRIPLET=$Triplet", '-DPROFILE=full',
        "-DBUILD_DIR=$validation", "-DSDK_ROOT_FILE=$resultFile", '-P', 'scripts/dotnet/validate-archive.cmake')
    $sdk = (Get-Content -LiteralPath $resultFile -Raw).Trim()
    if (!(Test-Path -LiteralPath $sdk -PathType Container)) { throw 'Validated SDK root is missing' }
    if ($built) {
        Copy-Item -LiteralPath $archive, "$archive.sha256" -Destination $cache
    }
    $builtText = $built.ToString().ToLowerInvariant()
    if ($env:GITHUB_OUTPUT) {
        "sdk_root=$sdk" | Out-File -LiteralPath $env:GITHUB_OUTPUT -Append -Encoding utf8
        "built=$builtText" | Out-File -LiteralPath $env:GITHUB_OUTPUT -Append -Encoding utf8
    }
    if ($env:GITHUB_STEP_SUMMARY) {
        $operation = if ($built) { 'Built from source' } else { 'Reused cached SDK' }
        "- ${Triplet}: $operation; full SDK validated. Base SDK packaging follows." |
            Out-File -LiteralPath $env:GITHUB_STEP_SUMMARY -Append -Encoding utf8
    }
    Write-Host "Validated full SDK: $sdk"
} finally {
    Pop-Location
}
