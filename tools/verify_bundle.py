#!/usr/bin/env python3
"""Validate a JS file using esprima (bundled via tools/.venv)."""
import pathlib, sys, os, subprocess


def find_python():
    cands = [
        pathlib.Path(os.environ.get("VENV_PY", "")),
        pathlib.Path(sys.executable).parent / "python.exe",
        pathlib.Path(sys.executable),
    ]
    for p in cands:
        if p.exists():
            return str(p)
    # Fallback: try the project-local venv scripts.
    venv_py = pathlib.Path(__file__).resolve().parent / ".venv" / "Scripts" / "python.exe"
    if venv_py.exists():
        return str(venv_py)
    return None


def main():
    script = pathlib.Path(__file__).resolve()
    bundle = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path("public/js/bundle.js")
    src = bundle.read_text(encoding="utf-8-sig")

    py_exe = find_python()
    if py_exe is None:
        print("NO_PYTHON_EXE", file=sys.stderr)
        sys.exit(2)

    try:
        result = subprocess.run(
            [py_exe, "-c", "import esprima, sys; sys.exit(10 if not hasattr(esprima, 'parseScript') else 0)"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
        )
    except subprocess.CalledProcessError as exc:
        print(f"ESPRIMA_MISSING_OR_FAIL: {exc.returncode}", file=sys.stderr)
        sys.exit(3)

    try:
        import esprima
        esprima.parseScript(src)
        print(f"OK: {bundle}")
        sys.exit(0)
    except Exception as exc:
        print(f"PARSE ERROR in {bundle}: {exc}", file=sys.stderr)
        sys.exit(10)


if __name__ == "__main__":
    main()
