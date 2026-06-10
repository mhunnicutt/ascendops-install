# AscendOps Auto-Start Script
$env:CTX_FRAMEWORK_ROOT = "C:\Users\mhunnicutt_foothills\ascendops-install"
$env:CTX_ROOT = "$env:USERPROFILE\.cortextos\default"
$env:CTX_ORG = "foothills-pm"
$env:CTX_INSTANCE_ID = "default"
Set-Location "C:\Users\mhunnicutt_foothills\ascendops-install"

# Build the TypeScript sources
Write-Host "Building..."
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed. Aborting."
    exit 1
}

# Start the daemon via PM2 (auto-restarts on crash, restarts at 500MB to prevent OOM)
Write-Host "Starting daemon via PM2..."
pm2 start ecosystem.config.js --only cortextos-daemon

# Show status
pm2 list
