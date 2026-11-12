# テスト

`general-mode.js` はモードの分離とデータ移行の安全性、`general-docs.js` は見積書・請求書・税計算・設定の確認です。使う数字はすべて架空です。本物の単価は出力しません。

```bash
# puppeteer-core と Chrome がある環境で
NODE_PATH=/path/to/node_modules node tests/general-mode.js
```


`data-sync.cjs` / `app-storage.cjs` / `drive-adapter.cjs` は Googleドライブ同期（架空データ・偽のDrive。本番の価格や実ログインは使いません）。

```bash
node --test tests/data-sync.cjs tests/app-storage.cjs tests/drive-adapter.cjs
```
