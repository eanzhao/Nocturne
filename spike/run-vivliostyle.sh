#!/usr/bin/env bash
# Vivliostyle spike — Part 1 of issue #9.
#
# Renders the executive-broadsheet sample to PDF via @vivliostyle/cli as a
# subprocess. Used to decide whether Vivliostyle under Bun's Node-compat layer
# is viable for Nocturne's v0.1 server-side PDF path.
#
# Run from repo root (or from this dir — we resolve paths relative to the script).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

INPUT="${SCRIPT_DIR}/executive-broadsheet-sample.html"
OUTPUT="${SCRIPT_DIR}/out.pdf"

if [[ ! -f "${INPUT}" ]]; then
  echo "ERROR: spike input HTML not found at ${INPUT}" >&2
  exit 1
fi

echo "[spike] input:  ${INPUT}"
echo "[spike] output: ${OUTPUT}"
echo "[spike] cwd:    ${REPO_ROOT}"
echo

cd "${REPO_ROOT}"

# Use bunx so the subprocess expectation matches what the Nocturne server would
# do in v0.1 (spawn a CLI child process, no in-process Vivliostyle import).
bunx --bun @vivliostyle/cli@latest build "${INPUT}" -o "${OUTPUT}"

echo
if [[ -f "${OUTPUT}" ]]; then
  echo "[spike] PDF generated: ${OUTPUT} ($(stat -f%z "${OUTPUT}" 2>/dev/null || stat -c%s "${OUTPUT}") bytes)"
else
  echo "[spike] FAILED — no PDF produced" >&2
  exit 2
fi
