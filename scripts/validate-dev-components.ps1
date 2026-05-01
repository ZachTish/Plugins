param(
    [switch]$SkipBuild,
    [switch]$SkipTests,
    [switch]$FailFast
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$devDirs = Get-ChildItem $repoRoot -Directory | Where-Object { $_.Name -like '*(Dev)' } | Sort-Object Name

if (-not $devDirs) {
    throw "No dev plugin directories were found under $repoRoot"
}

$results = New-Object System.Collections.Generic.List[object]

foreach ($dir in $devDirs) {
    $packageJsonPath = Join-Path $dir.FullName 'package.json'
    if (-not (Test-Path $packageJsonPath)) {
        continue
    }

    $packageJson = Get-Content $packageJsonPath -Raw | ConvertFrom-Json
    $buildScript = [string]$packageJson.scripts.build
    $testScript = [string]$packageJson.scripts.test

    $buildStatus = 'not-run'
    $testStatus = 'not-run'
    $notes = New-Object System.Collections.Generic.List[string]

    Push-Location $dir.FullName
    try {
        if (-not (Test-Path 'node_modules')) {
            throw "Missing node_modules in $($dir.Name). Run npm install before validation."
        }

        if ($SkipTests) {
            $testStatus = 'skipped'
        } elseif ($testScript) {
            & npm run test
            if ($LASTEXITCODE -ne 0) {
                $testStatus = 'failed'
                $notes.Add("npm run test failed in $($dir.Name)") | Out-Null
            } else {
                $testStatus = 'passed'
            }
        } else {
            $testStatus = 'skipped'
            $notes.Add('no test script') | Out-Null
        }

        if ($SkipBuild) {
            $buildStatus = 'skipped'
        } elseif ($buildScript) {
            & npm run build
            if ($LASTEXITCODE -ne 0) {
                $buildStatus = 'failed'
                $notes.Add("npm run build failed in $($dir.Name)") | Out-Null
            } else {
                $buildStatus = 'passed'
            }
        } else {
            $buildStatus = 'skipped'
            $notes.Add('no build script') | Out-Null
        }
    } catch {
        $notes.Add($_.Exception.Message) | Out-Null

        $results.Add([pscustomobject]@{
            Name = $dir.Name
            Test = $testStatus
            Build = $buildStatus
            Notes = ($notes -join '; ')
        }) | Out-Null

        Pop-Location
        if ($FailFast) {
            break
        }
        continue
    }
    Pop-Location

    $results.Add([pscustomobject]@{
        Name = $dir.Name
        Test = $testStatus
        Build = $buildStatus
        Notes = ($notes -join '; ')
    }) | Out-Null
}

$results | Format-Table -AutoSize

$failures = $results | Where-Object { $_.Test -eq 'failed' -or $_.Build -eq 'failed' }
if ($failures) {
    throw "Validation failed for one or more dev plugins."
}