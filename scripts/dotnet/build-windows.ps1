param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$VersionSuffix,
    [Parameter(Mandatory = $true)][string]$Revision,
    [Parameter(Mandatory = $true)][string]$Subsets,
    [int]$Jobs = 4
)
$ErrorActionPreference = 'Stop'
$sourcePath = (Resolve-Path -LiteralPath $Source).Path
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vsPath = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or !$vsPath) { throw 'Visual Studio C++ x64 build tools are required.' }
& "$vsPath\Common7\Tools\Launch-VsDevShell.ps1" -Arch amd64 -HostArch amd64 -SkipAutomaticLocation
foreach ($tool in @('cmake', 'ninja', 'python', 'git')) {
    Get-Command $tool -ErrorAction Stop | Out-Null
}
& python --version
if ($LASTEXITCODE -ne 0) { throw 'A working Python installation is required by CoreCLR.' }
$env:CMAKE_BUILD_PARALLEL_LEVEL = "$Jobs"
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
$env:DOTNET_GENERATE_ASPNET_CERTIFICATE = 'false'
$env:DOTNET_ADD_GLOBAL_TOOLS_TO_PATH = 'false'
Push-Location -LiteralPath $sourcePath
try {
    & .\build.cmd -subset $Subsets -configuration Release -arch x64 -os windows -ci `
        "/p:VersionSuffix=$VersionSuffix" /p:GenerateInstallers=false `
        /p:GenerateVSInsertionPackages=false /p:SkipInstallerBuild=true `
        /p:IncludeSourceRevisionInInformationalVersion=true `
        "/p:SourceRevisionId=$Revision" "/maxcpucount:$Jobs"
    if ($LASTEXITCODE -ne 0) { throw "CoreCLR source build failed: $LASTEXITCODE" }
} finally {
    Pop-Location
}
