param(
    [Parameter(Mandatory = $true)]
    [string]$Udid
)

$ErrorActionPreference = 'Stop'

function Get-SimulatorState {
    $json = & xcrun simctl list devices --json
    if ($LASTEXITCODE -ne 0) { throw 'Could not query simulator state' }
    $devices = ($json -join "`n" | ConvertFrom-Json).devices
    $selectedDevices = @($devices.PSObject.Properties |
        ForEach-Object { $_.Value } |
        Where-Object { $_.udid -eq $Udid })
    if ($selectedDevices.Count -ne 1) { throw "Cannot locate simulator $Udid" }
    return $selectedDevices[0].state
}

if ((Get-SimulatorState) -eq 'Shutdown') {
    Write-Host "Simulator $Udid is already shut down; skipping."
    exit 0
}

& xcrun simctl shutdown $Udid
$shutdownExit = $LASTEXITCODE
if ($shutdownExit -ne 0) {
    # It may have shut down between the state query and the shutdown command.
    if ((Get-SimulatorState) -ne 'Shutdown') {
        throw "Could not shut down simulator $Udid (exit $shutdownExit)"
    }
    Write-Host "Simulator $Udid is now shut down."
}
exit 0
