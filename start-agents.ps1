# AscendOps Auto-Start Script
$env:CTX_FRAMEWORK_ROOT = "C:\Users\mhunnicutt_foothills\ascendops-install"
$env:CTX_ROOT = "$env:USERPROFILE\.cortextos\default"
$env:CTX_ORG = "foothills-pm"
$env:CTX_INSTANCE_ID = "default"
Set-Location "C:\Users\mhunnicutt_foothills\ascendops-install"

# Start the build watcher in background
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd C:\Users\mhunnicutt_foothills\ascendops-install; npm run dev"

# Wait for build to complete
Start-Sleep -Seconds 15

# Start the daemon
node dist/daemon.js