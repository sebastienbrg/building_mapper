#!/usr/bin/env bash
# ==============================================================================
# TeZeLoMa — Publish Data Chunks to GitHub Releases
# ==============================================================================
# Usage:
#   export GITHUB_TOKEN="ghp_xxx"  # or run 'gh auth login'
#   ./app/release_data.sh [TAG_NAME]
#
# Default tag: v1.0-data

set -e

TAG="${1:-v1.0-data}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHUNKS_DIR="${ROOT_DIR}/data/chunks"

if [ ! -f "${CHUNKS_DIR}/manifest.json" ]; then
    echo "Error: ${CHUNKS_DIR}/manifest.json not found. Run 'app/chunk_dataset.py' first!"
    exit 1
fi

echo "====================================================================="
echo "Publishing TeZeLoMa data chunks to GitHub Releases (${TAG})"
echo "====================================================================="

if ! command -v gh &> /dev/null; then
    echo "GitHub CLI (gh) not found. Please install gh or upload files via GitHub Web UI."
    echo "Files ready in: ${CHUNKS_DIR}/"
    exit 1
fi

# Check if release exists
if gh release view "${TAG}" &> /dev/null; then
    echo "Release ${TAG} exists. Uploading/updating assets..."
    gh release upload "${TAG}" "${CHUNKS_DIR}"/* --clobber
else
    echo "Creating new release ${TAG}..."
    gh release create "${TAG}" "${CHUNKS_DIR}"/* \
        --title "TeZeLoMa Dataset Release (${TAG})" \
        --notes "Partitioned BDNB Open Data Parquet chunks by postal code (Dept 69 Lyon & Dept 38 Grenoble). Used directly by the standalone static web application."
fi

echo "Done! Data files are available at:"
echo "https://github.com/$(gh repo view --json nameWithOwner -q .nameWithOwner)/releases/download/${TAG}/"
