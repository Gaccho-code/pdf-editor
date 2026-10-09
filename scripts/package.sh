#!/bin/sh
# 社内配布用のZIPを dist/ に作成する。
# ZIPを展開すると pdf-editor/ フォルダが1つできる構成にする(利用者はこのフォルダをChromeで選ぶ)。
set -eu
cd "$(dirname "$0")/.."

version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json)
out="dist/pdf-editor-v${version}.zip"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

mkdir -p "$stage/pdf-editor" dist
cp -R manifest.json background.js editor.html editor.css editor.js compress.js icons lib "$stage/pdf-editor/"
find "$stage" -name .DS_Store -delete
rm -f "$out"
(cd "$stage" && zip -qr -X - pdf-editor) > "$out"
echo "$out"
