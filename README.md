# PDF Page Editor（Chrome拡張機能）

PDFのページを **並べ替え・削除・回転・結合** し、**ファイルサイズを圧縮** できる無料のChrome拡張機能です。
処理はすべてブラウザ内で完結し、PDFを外部のサーバーに送信しません。

- 導入手順・ダウンロード：https://gaccho-code.github.io/pdf-editor/install.html
- 要件定義書：https://gaccho-code.github.io/pdf-editor/requirements.html
- 最新版のZIP：https://github.com/Gaccho-code/pdf-editor/releases/latest/download/pdf-editor.zip

## インストール（開発者モードで読み込む）

利用者向けの詳しい手順は[導入手順書](https://gaccho-code.github.io/pdf-editor/install.html)を参照。以下は開発者向けの要約。

1. 最新版のZIPをダウンロードして展開する（ソースから使う場合はリポジトリをクローンする）
2. Chromeで `chrome://extensions` を開く
3. 右上の「デベロッパー モード」をオンにする
4. 「パッケージ化されていない拡張機能を読み込む」をクリックし、`manifest.json` のあるフォルダを選ぶ
5. ツールバーのパズルアイコンから「PDF Page Editor」をピン留めしておくと便利

## 使い方

ツールバーのアイコンをクリックすると、編集画面が新しいタブで開きます。

| 操作 | 方法 |
|---|---|
| PDFを開く | 画面にドラッグ＆ドロップ、または「PDFを開く」 |
| 結合 | 開いた後にさらにPDFを追加すると末尾に足される |
| 並べ替え | サムネイルをドラッグ＆ドロップ（選択中の複数ページはまとめて移動） |
| 選択 | クリック／⌘(Ctrl)+クリックで追加／Shift+クリックで範囲／⌘(Ctrl)+A で全選択 |
| 削除 | カード右上の ✕、または選択して Delete キー |
| 回転 | カード右上の ⟲ ⟳、または選択してツールバーの回転ボタン |
| 表示倍率 | ツールバーの －／＋ ボタンかスライダー、または ＋／－ キー（60〜300%。次回も同じ倍率で開く） |
| 元に戻す／やり直す | ⌘(Ctrl)+Z ／ ⌘(Ctrl)+Shift+Z |
| 保存 | 「PDFを保存」または ⌘(Ctrl)+S → `元の名前_edited.pdf`（結合時は `_merged.pdf`） |
| 圧縮して保存 | 「圧縮して保存」で軽め／標準／最大を選ぶ → 圧縮後のサイズを確認してダウンロード（`元の名前_compressed.pdf`） |

## 制限事項

- パスワード保護・暗号化されたPDFは読み込めません
- 元のPDFのしおり（アウトライン）は保存後のファイルに引き継がれません
- 圧縮の「軽め」「標準」で小さくなるのはJPEG形式の画像（写真・スキャン画像の多く）だけです。PNG形式の画像や文字は圧縮しません
- 圧縮の「最大」はページ全体を画像にするため、文字の選択・検索ができなくなります

## 構成

```
manifest.json   Manifest V3
background.js   アイコンクリックで editor.html を開く
editor.html/css/js  編集画面
compress.js     ファイルサイズの圧縮（画像の再圧縮・ページの画像化）
lib/            同梱ライブラリ（CDNは使わない）
  pdf.min.mjs, pdf.worker.min.mjs, cmaps/, standard_fonts/  … pdf.js 4.10.38（Apache-2.0）サムネイル表示用
  pdf-lib.min.js  … pdf-lib 1.17.1（MIT）PDFの書き出し用
icons/          拡張機能アイコン
scripts/package.sh  配布用ZIPを dist/ に作成
docs/           GitHub Pages で公開する資料（トップ・導入手順書・要件定義書）
.github/workflows/release.yml  タグのプッシュでZIPを作り Releases に登録
```

## リリース手順

1. `manifest.json` の `version` を上げてコミットし、プッシュする
2. 同じ版のタグを付けてプッシュする

```bash
git tag v1.2.0 && git push origin v1.2.0
```

GitHub Actions がZIPを作り、`pdf-editor.zip` という名前で Releases に登録する（タグと `manifest.json` の版が違うと失敗する）。導入手順書のダウンロードボタンは常に最新リリースを指すので、手順書の修正は不要。

手元でZIPだけ作る場合は `./scripts/package.sh` を実行する（`dist/pdf-editor-v<版>.zip` ができる）。

## 資料（GitHub Pages）

`docs/` の内容が、`main` ブランチへのプッシュで https://gaccho-code.github.io/pdf-editor/ に反映される。リポジトリは公開なので、秘密情報・個人名・連絡先・社内URLは載せないこと。

ビルド工程はありません。ファイルを編集したら `chrome://extensions` で再読み込みすれば反映されます。

ローカルで画面だけ確認したい場合は、`python3 -m http.server --directory 04_pdf-editor` で起動して `editor.html` を開いてもかまいません（拡張機能のAPIを使うのは `background.js` だけです）。

## ライセンス

MIT License（[LICENSE](LICENSE)）。同梱ライブラリはそれぞれのライセンスに従う（pdf.js：Apache-2.0、pdf-lib：MIT。`lib/` 内のライセンス文書を参照）。
