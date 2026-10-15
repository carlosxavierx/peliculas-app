$venvPython = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    throw "venv python not found at $venvPython. Run: py -m venv .venv; .\.venv\Scripts\python -m pip install esprima2"
}
& $venvPython (Join-Path $PSScriptRoot "check_bundle_syntax.py")
exit $LASTEXITCODE
