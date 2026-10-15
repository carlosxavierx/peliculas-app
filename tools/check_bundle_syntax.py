#!/usr/bin/env python3
import pathlib, sys
import esprima

src = pathlib.Path("public/js/bundle.js")
code = src.read_text(encoding="utf-8-sig")
try:
    esprima.parseScript(code)
    print(f"OK: {src}")
    sys.exit(0)
except Exception as exc:
    print(f"PARSE ERROR in {src}: {exc}", file=sys.stderr)
    sys.exit(10)
