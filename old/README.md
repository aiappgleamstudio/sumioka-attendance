# 住岡 勤怠管理システム

Google Apps Script + GitHub Pages で動く勤怠管理ツールです。

## 🔗 アクセス先

| 画面 | URL |
|---|---|
| 🟢 **スタッフ用（打刻）** | [kintai.html](https://gleamstudiotime.github.io/sumioka-attendance/kintai.html) |
| 🔵 **管理者用（Admin）** | [admin.html](https://gleamstudiotime.github.io/sumioka-attendance/admin.html) |

---

## 📁 ファイル構成

```
sumioka-attendance/
├── kintai.html          # スタッフ打刻画面
├── admin.html           # 管理者ダッシュボード
├── manifest.json        # PWA設定
├── service-worker.js    # プッシュ通知・オフライン対応
└── common/
    ├── api.js           # GAS通信共通モジュール
    ├── ui.js            # UI共通モジュール（トースト・ローディング等）
    ├── storage.js       # セッション管理
    └── styles.css       # 共通スタイル
```

## ⚙️ GASファイル構成（Apps Script）

| ファイル | 役割 |
|---|---|
| `Code.gs` | エントリーポイント・定数定義 |
| `AdminServices.gs` | 管理者向けAPI処理 |
| `Admin.gs` | 勤怠・スタッフ管理処理 |
| `Services.gs` | スタッフ向けAPI処理 |
| `Payroll.gs` | 給与計算処理 |
| `Migration.gs` | DB初期化・マイグレーション |
| `Test.gs` | テスト用ユーティリティ |

---

## 🚀 新規環境のセットアップ手順

1. Google スプレッドシートを新規作成
2. `拡張機能` → `Apps Script` で上記GASファイルを全て貼り付け
3. GASエディタで `setupNewSpreadsheet` を実行（シートが自動作成される）
4. GASを `ウェブアプリ` としてデプロイ
5. 発行されたURLを `kintai.html` と `admin.html` の `GAS_URL` に設定
6. GitHubにプッシュして完了

---

## 💴 給与・勤怠ルール

| 項目 | ルール |
|---|---|
| 給与計算単位 | 1分単位 |
| 出勤打刻の丸め | 5分単位切り上げ（例：10:06打刻 → 10:10から給与発生） |
| 残業 | 管理者指示または申請＋承認がある場合のみ・割り増しなし |
| 早出 | 申請タブから申請。補填なし→即時有効、補填あり→承認必要 |
| 補填 | 5分単位・月8時間上限・当月内のみ有効（翌月繰り越し不可） |
