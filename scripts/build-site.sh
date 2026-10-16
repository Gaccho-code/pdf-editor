#!/bin/sh
# GitHub Pages に公開するサイトを _site/ に組み立てる。
#   /       … docs/ の資料(トップ・導入手順書・要件定義書など)
#   /app/   … Web版のツール本体(拡張機能と同じファイル。拡張機能専用の manifest.json・background.js は除く)
set -eu
cd "$(dirname "$0")/.."

rm -rf _site
mkdir -p _site/app
cp -R docs/. _site/
cp -R editor.html editor.css editor.js compress.js viewer.js cleanup.js drive.js icons lib _site/app/
cp editor.html _site/app/index.html # /app/ だけでも開けるようにする
find _site -name .DS_Store -delete
echo _site
