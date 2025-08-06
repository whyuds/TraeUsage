# Test build script for Trae Usage Monitor
# Validates automation workflow configuration

Write-Host "Testing Trae Usage Monitor build process..." -ForegroundColor Blue

# Check required files
$requiredFiles = @(
    "package.json",
    "tsconfig.json",
    "src/extension.ts",
    ".github/workflows/build.yml",
    ".vscodeignore"
)

$hasErrors = $false

Write-Host "`nChecking required files..." -ForegroundColor Yellow
foreach ($file in $requiredFiles) {
    if (Test-Path $file) {
        Write-Host "OK $file" -ForegroundColor Green
    } else {
        Write-Host "MISSING $file" -ForegroundColor Red
        $hasErrors = $true
    }
}

# Check package.json configuration
Write-Host "`nChecking package.json configuration..." -ForegroundColor Yellow
try {
    $packageJson = Get-Content "package.json" | ConvertFrom-Json
    
    $requiredFields = @(
        @{name="name"; value=$packageJson.name},
        @{name="version"; value=$packageJson.version},
        @{name="publisher"; value=$packageJson.publisher},
        @{name="main"; value=$packageJson.main},
        @{name="engines.vscode"; value=$packageJson.engines.vscode}
    )
    
    foreach ($field in $requiredFields) {
        if ($field.value) {
            Write-Host "OK $($field.name): $($field.value)" -ForegroundColor Green
        } else {
            Write-Host "MISSING $($field.name)" -ForegroundColor Red
            $hasErrors = $true
        }
    }
    
    # Check scripts
    if ($packageJson.scripts.compile) {
        Write-Host "OK scripts.compile: $($packageJson.scripts.compile)" -ForegroundColor Green
    } else {
        Write-Host "MISSING scripts.compile" -ForegroundColor Red
        $hasErrors = $true
    }
    
} catch {
    Write-Host "ERROR package.json format error" -ForegroundColor Red
    $hasErrors = $true
}

# Test compilation
Write-Host "`nTesting TypeScript compilation..." -ForegroundColor Yellow
try {
    npm run compile
    if (Test-Path "out/extension.js") {
        Write-Host "OK Compilation successful" -ForegroundColor Green
    } else {
        Write-Host "ERROR Compilation failed - output file not found" -ForegroundColor Red
        $hasErrors = $true
    }
} catch {
    Write-Host "ERROR Compilation failed: $($_.Exception.Message)" -ForegroundColor Red
    $hasErrors = $true
}

# Check GitHub Actions workflow
Write-Host "`nChecking GitHub Actions configuration..." -ForegroundColor Yellow
if (Test-Path ".github/workflows/build.yml") {
    $workflow = Get-Content ".github/workflows/build.yml" -Raw
    
    $workflowChecks = @(
        @{name="Trigger condition (tags)"; pattern="tags:"},
        @{name="npm ci"; pattern="npm ci"},
        @{name="npm run compile"; pattern="npm run compile"},
        @{name="vsce package"; pattern="vsce package"},
        @{name="Publish to VSCode Marketplace"; pattern="vsce publish"},
        @{name="Publish to OpenVSX"; pattern="ovsx publish"}
    )
    
    foreach ($check in $workflowChecks) {
        if ($workflow -match $check.pattern) {
            Write-Host "OK $($check.name)" -ForegroundColor Green
        } else {
            Write-Host "MISSING $($check.name)" -ForegroundColor Red
            $hasErrors = $true
        }
    }
} else {
    Write-Host "ERROR GitHub Actions workflow file not found" -ForegroundColor Red
    $hasErrors = $true
}

# Summary
Write-Host "`nTest Results:" -ForegroundColor Blue
if ($hasErrors) {
    Write-Host "ERROR Issues found, please fix and retest" -ForegroundColor Red
    exit 1
} else {
    Write-Host "SUCCESS All checks passed! Automation workflow configured correctly" -ForegroundColor Green
    Write-Host "`nTo release, run:" -ForegroundColor Cyan
    Write-Host "   .\\scripts\\release.ps1 -Version \"x.x.x\"" -ForegroundColor White
}