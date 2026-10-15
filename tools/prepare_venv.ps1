$venvDir = Join-Path $PSScriptRoot ".venv"
$pythonExe = Join-Path $venvDir "Scripts\python.exe"

if (-not (Test-Path $pythonExe)) {
    $root = Split-Path $PSScriptRoot -Parent
    py -m venv (Join-Path $root "tools\.venv")
}

& $pythonExe -m pip install --quiet --disable-pip-version-check esprima2
