$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath "$PSScriptRoot/../..").Path
$testRoot = Join-Path $root ("out/dotnet/ci-script-tests/" + [guid]::NewGuid().ToString('N'))
$savedOutput = $env:GITHUB_OUTPUT
$savedSummary = $env:GITHUB_STEP_SUMMARY
$script:cases = 0
$global:StarDotnetCiTestState = $null

function Assert-True([bool]$Condition, [string]$Message) {
    if (!$Condition) { throw $Message }
}

# Exercise orchestration only. Real archive checks and runtime execution are
# covered separately by the packaged-SDK consumer, not by these fake archives.
function global:cmake {
    $state = $global:StarDotnetCiTestState
    $global:LASTEXITCODE = 0
    if ($args -contains 'scripts/build-dotnet.cmake') {
        $state.Builds++
        if ($state.FailBuild) { $global:LASTEXITCODE = 1; return }
        $output = Join-Path $state.Root 'out/dotnet/x64-windows-star/Release'
        New-Item -ItemType Directory -Force $output | Out-Null
        Set-Content -LiteralPath (Join-Path $output $state.ArchiveName) 'fake archive'
        Set-Content -LiteralPath (Join-Path $output "$($state.ArchiveName).sha256") 'fake checksum'
    } elseif ($args -contains 'scripts/dotnet/validate-archive.cmake') {
        $state.Validations++
        if ($state.FailValidation) { $global:LASTEXITCODE = 1; return }
        $resultArgument = @($args | Where-Object { $_ -like '-DSDK_ROOT_FILE=*' })
        Assert-True ($resultArgument.Count -eq 1) 'SDK root output argument missing'
        $sdk = Join-Path $state.Root 'validated sdk'
        New-Item -ItemType Directory -Force $sdk | Out-Null
        Set-Content -LiteralPath $resultArgument[0].Substring('-DSDK_ROOT_FILE='.Length) $sdk
    } else {
        throw "Unexpected CMake invocation: $args"
    }
}

function Run-Case([string]$Name, [bool]$Cached, [bool]$FailBuild, [bool]$FailValidation, [bool]$ExtraFile) {
    $caseRoot = Join-Path $testRoot $Name
    $scriptDir = Join-Path $caseRoot 'scripts/dotnet'
    $cache = Join-Path $caseRoot 'out/dotnet/full-sdk/x64-windows-star'
    New-Item -ItemType Directory -Force $scriptDir, $cache | Out-Null
    Copy-Item -LiteralPath "$root/scripts/dotnet/prepare-ci-sdk.ps1" -Destination $scriptDir
    $state = @{
        Root = $caseRoot; ArchiveName = 'star-dotnet-test-x64-windows-star-release-sdk.zip'
        Builds = 0; Validations = 0; FailBuild = $FailBuild; FailValidation = $FailValidation
    }
    $global:StarDotnetCiTestState = $state
    if ($Cached) {
        Set-Content -LiteralPath (Join-Path $cache $state.ArchiveName) 'fake archive'
        Set-Content -LiteralPath (Join-Path $cache "$($state.ArchiveName).sha256") 'fake checksum'
    }
    if ($ExtraFile) { Set-Content -LiteralPath (Join-Path $cache 'unexpected.txt') 'unexpected' }
    $env:GITHUB_OUTPUT = Join-Path $caseRoot 'outputs.txt'
    $failure = $null
    $pathBefore = $env:PATH
    try { & "$scriptDir/prepare-ci-sdk.ps1" -Triplet x64-windows-star } catch { $failure = $_ }
    Assert-True ($env:PATH -ceq $pathBefore) "$Name changed the caller's PATH"
    $shouldFail = $FailBuild -or $FailValidation -or $ExtraFile
    Assert-True (($null -ne $failure) -eq $shouldFail) "$Name returned an unexpected result: $failure"
    Assert-True ($state.Builds -eq $(if ($Cached) { 0 } else { 1 })) "$Name rebuilt unexpectedly"
    Assert-True ($state.Validations -eq $(if ($FailBuild -or $ExtraFile) { 0 } else { 1 })) "$Name validation count differs"
    if ($shouldFail) {
        Assert-True (!(Test-Path -LiteralPath $env:GITHUB_OUTPUT)) "$Name published outputs after failure"
        if (!$Cached) {
            Assert-True (@(Get-ChildItem -LiteralPath $cache -File).Count -eq 0) "$Name cached an unvalidated SDK"
        }
    } else {
        $outputs = Get-Content -LiteralPath $env:GITHUB_OUTPUT -Raw
        $expectedBuilt = (!$Cached).ToString().ToLowerInvariant()
        Assert-True ($outputs.Contains("built=$expectedBuilt")) "$Name did not report its build decision"
        Assert-True ($outputs.Contains('sdk_root=')) "$Name did not publish the validated SDK root"
        Assert-True (@(Get-ChildItem -LiteralPath $cache -File).Count -eq 2) "$Name did not preserve the archive and checksum"
    }
    $script:cases++
}

try {
    # Keep the real OS so Windows also verifies orchestration needs no VS shell.
    # Do not write to the enclosing GitHub step.
    $env:GITHUB_STEP_SUMMARY = ''
    Run-Case 'cache-miss' $false $false $false $false
    Run-Case 'cache-hit' $true $false $false $false
    Run-Case 'invalid-cache' $true $false $true $false
    Run-Case 'extra-cache-file' $true $false $false $true
    Run-Case 'build-failure' $false $true $false $false
    Run-Case 'built-archive-failure' $false $false $true $false
    Write-Host "CI SDK orchestration checks passed ($script:cases)."
    $global:LASTEXITCODE = 0
} finally {
    $env:GITHUB_OUTPUT = $savedOutput
    $env:GITHUB_STEP_SUMMARY = $savedSummary
    Remove-Item -LiteralPath Function:\cmake
    Remove-Variable -Name StarDotnetCiTestState -Scope Global
}
