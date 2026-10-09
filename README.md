# PDF Page Editor（Chrome拡張機能）

PDFのページを **並べ替え・削除・回転・結合** できる無料のChrome拡張機能です。
処理はすべてブラウザ内で完結し、PDFを外部のサーバーに送信しません。

## インストール（開発者モードで読み込む）

1. Chromeで `chrome://extensions` を開く
2. 右上の「デベロッパー モード」をオンにする
3. 「パッケージ化されていない拡張機能を読み込む」をクリックし、この `04_pdf-editor` フォルダを選ぶ
4. ツールバーのパズルアイコンから「PDF Page Editor」をピン留めしておくと便利

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

## 制限事項

- パスワード保護・暗号化されたPDFは読み込めません
- 元のPDFのしおり（アウトライン）は保存後のファイルに引き継がれません

## 構成

```
manifest.json   Manifest V3
background.js   アイコンクリックで editor.html を開く
editor.html/css/js  編集画面
lib/            同梱ライブラリ（CDNは使わない）
  pdf.min.mjs, pdf.worker.min.mjs, cmaps/, standard_fonts/  … pdf.js 4.10.38（Apache-2.0）サムネイル表示用
  pdf-lib.min.js  … pdf-lib 1.17.1（MIT）PDFの書き出し用
icons/          拡張機能アイコン
```

## 社内配布用ZIPの作成

```bash
./scripts/package.sh
```

`dist/pdf-editor-v<バージョン>.zip` ができる。展開すると `pdf-editor/` フォルダが1つ出てくる構成で、利用者はこのフォルダをChromeで読み込む。

ビルド工程はありません。ファイルを編集したら `chrome://extensions` で再読み込みすれば反映されます。

ローカルで画面だけ確認したい場合は、`python3 -m http.server --directory 04_pdf-editor` で起動して `editor.html` を開いてもかまいません（拡張機能のAPIを使うのは `background.js` だけです）。
