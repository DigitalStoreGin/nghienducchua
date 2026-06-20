#!/usr/bin/env bash
# Dong goi ban phat hanh CO SAN Whisper de gui khach. Chay 1 lan tren may ban.
set -e
cd "$(dirname "$0")"
V=2.17.2
B="https://cdn.jsdelivr.net/npm/@xenova/transformers@${V}/dist"
echo "[1/3] Tai thu vien Whisper vao vendor/ ..."
curl -fL "$B/transformers.min.js" -o vendor/transformers.min.js
for f in ort-wasm.wasm ort-wasm-simd.wasm ort-wasm-threaded.wasm ort-wasm-simd-threaded.wasm; do
  curl -fL "$B/$f" -o "vendor/$f" || echo "   (bo qua $f)"
done
echo "[2/3] Don + [3/3] nen ..."
STAGE=$(mktemp -d)
cp -r "$(pwd)" "$STAGE/shadowing-extension"
rm -rf "$STAGE/shadowing-extension/tests" "$STAGE/shadowing-extension/.gitignore" "$STAGE/shadowing-extension/"*.zip
( cd "$STAGE" && zip -rq shadowing-extension-release.zip shadowing-extension )
mv "$STAGE/shadowing-extension-release.zip" ./shadowing-extension-release.zip
echo "XONG -> shadowing-extension-release.zip (gui cho khach / upload Web Store). Khach KHONG can chay script."
