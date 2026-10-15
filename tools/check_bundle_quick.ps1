$root = "C:\Users\hector.lopez-pedrosa\Desktop\Proyecto-Peliculas\series-peliculas-app"
$venv = Join-Path $root "tools\.venv"
$python = Join-Path $venv "Scripts\python.exe"

if (-not (Test-Path $python)) {
    py -m venv (Join-Path $root "tools\.venv") -quiet
}
& $python -m pip install --quiet --disable-pip-version-check esprima2
& $python (Join-Path $root "tools\check_bundle_syntax.py")
exit $LASTEXITCODE
