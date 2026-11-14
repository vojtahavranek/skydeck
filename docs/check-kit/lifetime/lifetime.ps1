# OPTIONAL. On a managed company PC, run this script only with the agreement of the PC's owner: it
# imports a WSL distribution and removes it again. No check of skydeck requires it: W14's first
# form in docs/manual-checks.md needs no script. Do not bypass or change PowerShell's execution
# policy for it (no -ExecutionPolicy Bypass, no Set-ExecutionPolicy, no Unblock-File): when
# PowerShell refuses to run scripts on this PC, leave this script out.
#
# Run in Windows PowerShell (not as administrator). About 4 minutes.
# It imports a throwaway 4 MB Alpine distro called "skydeck-test", so your real distro and the
# sessions in it are never touched, measures the instance idle rules, and removes the throwaway
# distro again. Note: the VM is shared, so this tests the per-distro rule, not the VM rule.
# The Alpine tarball is not in skydeck's repository: docs/manual-checks.md (W14) names it, its
# address and its sha256; put it beside this script.
#   powershell.exe -NoProfile -File lifetime.ps1
param([string]$Tar = (Join-Path $PSScriptRoot 'alpine-minirootfs-3.24.4-x86_64.tar.gz'))
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::Unicode   # wsl.exe -l prints UTF-16
$name = 'skydeck-test'
$dir = Join-Path $env:LOCALAPPDATA 'skydeck-check\wsl-test'
$t0 = Get-Date

function Running { return ((& wsl.exe -l --running) -join "`n") -match [regex]::Escape($name) }
function Stamp { param($msg) Write-Host ('[{0,5:N1}s] {1}' -f ((Get-Date) - $t0).TotalSeconds, $msg) }
function WaitList {
  param([int]$Seconds, [bool]$Expect)
  $end = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $end) {
    $r = Running
    if ($r -eq $Expect) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

Stamp 'import throwaway distro'
# PowerShell does not stop on a program's exit code: without these checks A-D would measure a
# distro that does not exist and print an answer that looks like a result.
if (-not (Test-Path -LiteralPath $Tar -PathType Leaf)) {
  throw "the tarball $Tar is not there: the check has not been run"
}
& wsl.exe --import $name $dir $Tar --version 2
if ($LASTEXITCODE -ne 0) {
  throw "wsl.exe --import failed (exit $LASTEXITCODE; its message is above): the check has not been run"
}

try {
  # A. background process only, no wsl.exe session left open
  Stamp 'A: start a background sleep inside the distro, then let the launching wsl.exe exit'
  & wsl.exe -d $name --exec sh -c 'nohup sleep 3600 >/dev/null 2>&1 &'
  Stamp ('A: right after launch, listed as running: ' + (Running))
  $gone = WaitList -Seconds 90 -Expect $false
  Stamp ('A: left the running list within 90 s: ' + $gone + '   (source says: about 15 s after the last wsl.exe client exits)')

  # B. hidden wsl.exe child as keep-alive
  Stamp 'B: hidden wsl.exe child holding the distro'
  $p = Start-Process -FilePath 'wsl.exe' -ArgumentList @('-d', $name, '--exec', 'sleep', 'infinity') -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 60
  Stamp ('B: still listed as running after 60 s: ' + (Running) + '   child exited: ' + $p.HasExited)

  # C. how fast does the Windows side learn that the distro stopped?
  Stamp 'C: wsl --terminate, measure how fast the child process exits'
  $sw = [Diagnostics.Stopwatch]::StartNew()
  & wsl.exe --terminate $name
  $exited = $p.WaitForExit(15000)
  Stamp ('C: child exited: {0} after {1} ms, exit code {2}' -f $exited, $sw.ElapsedMilliseconds, $(if ($exited) { $p.ExitCode } else { 'n/a' }))

  # D. kill the child instead: does the distro go idle 15 s later?
  Stamp 'D: start a keep-alive again, then kill only the Windows child'
  $p2 = Start-Process -FilePath 'wsl.exe' -ArgumentList @('-d', $name, '--exec', 'sleep', 'infinity') -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 5
  Stamp ('D: listed as running with child alive: ' + (Running))
  $p2.Kill()
  $sw2 = [Diagnostics.Stopwatch]::StartNew()
  $gone2 = WaitList -Seconds 60 -Expect $false
  Stamp ('D: left the list: {0} after {1} s' -f $gone2, [math]::Round($sw2.Elapsed.TotalSeconds, 1))
}
finally {
  Stamp 'cleanup: unregister throwaway distro'
  & wsl.exe --unregister $name | Out-Null
  Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
}
Stamp 'done - paste the lines above'
