#!/usr/bin/env bash
#
# Export the Qoder Repo Wiki (.qoder/repowiki) to a single PDF at the repo root.
#
#   ./export-wiki-pdf.sh                 # normal re-export
#   ./export-wiki-pdf.sh --clean-cache   # force every Mermaid diagram to re-render
#   ./export-wiki-pdf.sh --verbose       # per-document progress
#
# Extra arguments are passed straight through to the Python converter
# (see: ./export-wiki-pdf.sh --help).
#
# Source files under .qoder/repowiki/ are only ever read, never modified.
# Everything else lives in .qoder/temp/ and is disposable.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMP_DIR="$ROOT/.qoder/temp"
VENV="$TEMP_DIR/venv"
SCRIPT="$TEMP_DIR/convert_wiki_to_pdf.py"
MERMAID_JS="$TEMP_DIR/assets/mermaid.min.js"
MERMAID_CDN="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"

if [[ ! -f "$SCRIPT" ]]; then
  echo "error: converter missing at $SCRIPT" >&2
  exit 1
fi

# --- pick a python -----------------------------------------------------------
PYBIN=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then PYBIN="$candidate"; break; fi
done
if [[ -z "$PYBIN" ]]; then
  echo "error: python3 not found on PATH" >&2
  exit 1
fi

# --- virtualenv --------------------------------------------------------------
# Homebrew/system pythons are PEP 668 "externally managed", so a venv is not
# optional here: pip refuses to install into them.
if [[ ! -x "$VENV/bin/python" ]]; then
  echo "==> creating virtualenv in .qoder/temp/venv"
  "$PYBIN" -m venv "$VENV"
  "$VENV/bin/python" -m pip install --quiet --upgrade pip
fi
PY="$VENV/bin/python"

# --- python dependencies -----------------------------------------------------
if ! "$PY" - <<'PYCHECK' >/dev/null 2>&1
import markdown_it, mdit_py_plugins, pygments, playwright, pypdf, reportlab
PYCHECK
then
  echo "==> installing Python dependencies"
  "$VENV/bin/pip" install --quiet --upgrade \
    markdown-it-py mdit-py-plugins pygments playwright pypdf reportlab
fi

# --- headless chromium (used for Mermaid + PDF rendering) --------------------
if ! "$PY" - <<'PYCHECK' >/dev/null 2>&1
from playwright.sync_api import sync_playwright
with sync_playwright() as pw:
    pw.chromium.launch(headless=True).close()
PYCHECK
then
  echo "==> installing Playwright Chromium (one-time, ~150 MB)"
  "$PY" -m playwright install chromium
fi

# --- vendored mermaid --------------------------------------------------------
if [[ ! -s "$MERMAID_JS" ]]; then
  echo "==> downloading mermaid.js (one-time)"
  mkdir -p "$(dirname "$MERMAID_JS")"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time 120 -o "$MERMAID_JS" "$MERMAID_CDN"
  else
    wget -q -O "$MERMAID_JS" "$MERMAID_CDN"
  fi
fi

exec "$PY" "$SCRIPT" --project-root "$ROOT" "$@"
