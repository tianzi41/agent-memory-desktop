# tray.ps1 - AgentMemory system tray icon (ASCII only, PS 5.1 + WinForms)
# Left-click: open Web UI. Right-click menu: Open / Exit.
# Started/Stopped together with watchdog via the autostart toggle in Web UI.
$ErrorActionPreference = "Continue"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$URL = "http://127.0.0.1:8430"

$ni = New-Object System.Windows.Forms.NotifyIcon
$iconFile = Join-Path $PSScriptRoot "tray.ico"
if (Test-Path $iconFile) { $ni.Icon = New-Object System.Drawing.Icon($iconFile) }
else { $ni.Icon = [System.Drawing.SystemIcons]::Information }
$ni.Text = "AgentMemory Desktop"
$ni.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miOpen = $menu.Items.Add("Open Web UI")
$miOpen.Add_Click({ Start-Process $URL })
$miExit = $menu.Items.Add("Exit")
$miExit.Add_Click({
    $script:ni.Visible = $false
    $script:ni.Dispose()
    [System.Windows.Forms.Application]::Exit()
})
$ni.ContextMenuStrip = $menu

# left click opens the Web UI (right click shows the menu)
$ni.Add_MouseClick({
    if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Start-Process $URL }
})

Write-Host "[AgentMemory tray] running"
[System.Windows.Forms.Application]::Run()
