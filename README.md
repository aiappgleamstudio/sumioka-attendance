# 住岡 勤怠管理システム

A型事業所向け運営プラットフォーム。  
勤怠管理を起点に、タスク・案件・相談・日報・工数・利益管理を統合する業務基盤。

---

## ウェブアプリ URL

| 画面 | URL | 対象 | 状態 |
|------|-----|------|------|
| 利用者ホーム | [user.html](https://aiappgleamstudio.github.io/sumioka-attendance/user.html) | 利用者・職員・管理者（打刻） | ✅ 開発中 |
| 管理者ダッシュボード | [admin.html](https://aiappgleamstudio.github.io/sumioka-attendance/admin.html) | 職員・管理者 | ✅ 稼働中 |
| 職員ダッシュボード | [staff.html](https://aiappgleamstudio.github.io/sumioka-attendance/staff.html) | 職員 | 🔧 未実装 |
| 旧打刻画面 | [kintai.html](https://aiappgleamstudio.github.io/sumioka-attendance/kintai.html) | 全員 | ⚠️ 移行中（削除予定） |

> **補足:**  
> `user.html` が `kintai.html` の全機能を引き継いだ時点で `kintai.html` を削除予定。

---

## システム概要

```
利用者    → user.html    出勤・タスク確認・相談・退勤・日報
職員      → staff.html   タスク管理・レビュー・案件・相談対応    （実装予定）
管理者    → admin.html   ダッシュボード・全管理機能・給与計算
```

---

## ファイル構成

```
sumioka-attendance/
├── user.html              利用者ホーム（ATM型打刻 + タスク + 相談）
├── admin.html             管理者ダッシュボード
├── kintai.html            旧打刻画面（移行中・削除予定）
├── api.js                 GAS通信共通モジュール
├── ui.js                  UI共通ユーティリティ
├── storage.js             ローカルストレージ管理
├── styles.css             共通スタイル
├── manifest.json          PWA設定
├── service-worker.js      PWAオフライン対応
│
└── GAS（Google Apps Script）
    ├── Code.gs            エントリポイント・ルーティング・出退勤CRUD
    ├── Shared.gs          新規シート定数・初期化・行変換ユーティリティ
    ├── TaskService.gs     タスク3階層・レビュー・差戻・履歴
    ├── ProjectService.gs  顧客・案件・メンバー・相談・通知・ダッシュボード
    ├── AdminServices.gs   勤怠管理（Admin）・申請・カレンダー・給与
    ├── Services.gs        月次集計・ビューシート生成
    └── Payroll.gs         給与計算
```

---

## スプレッドシート構成

### 既存シート

| シート名 | 用途 |
|----------|------|
| 出退勤記録 | 日次出退勤データ |
| 人員マスタ | 職員・利用者マスタ |
| 申請管理 | 休み・遅刻・早退・補填申請 |
| 会社カレンダー | 会社休日・行事 |
| タスク管理 | 旧個人タスク（AdminServices使用） |
| 給与設定 | 社保率・残業率・弁当代 |
| インセンティブ | 月次インセンティブ |
| 操作ログ | 管理者操作の監査ログ |
| _バックアップ | 変更前データの自動保存 |

### 新規シート（v2 プラットフォーム）

| シート名 | 用途 |
|----------|------|
| tasks | タスク（3階層・自己参照・本システムの中心エンティティ） |
| task_assignments | タスク担当者（多対多） |
| task_histories | タスク変更履歴・差戻記録 |
| task_comments | タスク別作業コメント・日報 |
| project_members | 案件メンバー（利用者の閲覧制御） |
| daily_reports | 日報（全体コメント・引継ぎ） |
| work_logs | 工数記録（分単位） |
| consultation_recipients | 相談送信先・既読管理 |
| 顧客マスタ | 顧客情報 |
| 案件 | 案件管理 |
| 相談スレッド | 相談（v2・送信先対応） |
| 通知 | 画面内通知 |
| フェーズテンプレート | タスクフェーズテンプレート |

---

## ユーザー区分と権限

| ロール | 判定条件 | 利用可能機能 |
|--------|----------|-------------|
| 管理者 | `admin_role === '管理者'` | 全機能 |
| 職員 | `employment_type === '職員'` | タスク・案件・レビュー・相談 |
| 利用者 | `employment_type === '利用者'` | 打刻・自分のタスク・相談・日報 |

---

## タスクのレビューフロー

```
review_required = false（レビュー不要）
  未着手 → 進行中 → 完了

review_required = true（レビュー必須）
  未着手 → 進行中 → レビュー待ち → 完了（職員が承認）
                              └→ 差戻（理由必須） → 進行中
```

---

## 開発フェーズ

| Phase | 内容 | 状態 |
|-------|------|------|
| Phase 1 | DB設計・Shared.gs・TaskService.gs | ✅ 完了 |
| Phase 2 | ProjectService.gs リファクタリング・案件メンバー権限 | ✅ 完了 |
| Phase 3 | user.html（ATM型打刻・タスク・相談・通知） | ✅ 完了 |
| Phase 4 | staff.html（タスク管理・レビュー・案件） | 🔧 未着手 |
| Phase 5 | admin.html 新版（ダッシュボード・全管理機能） | 🔧 未着手 |
| Phase 6 | デザイン統一・PWA最適化 | 🔧 未着手 |

---

## セットアップ

### GAS 初回デプロイ手順

```
1. GAS プロジェクトに以下を追加（新規ファイルとして貼り付け）
     Shared.gs / TaskService.gs / ProjectService.gs

2. 既存ファイルを更新
     Code.gs → 修正版に全置換
     ProjectServices.gs → 削除（または _DEPRECATED にリネーム）

3. GAS エディタで setupAllNewSheets() を1回手動実行
   → 新規シート8種が自動作成される

4. GAS をウェブアプリとしてデプロイ
   → 「全員」アクセス可・「自分として実行」

5. デプロイ URL を user.html / admin.html の GAS_URL に設定
```

### GitHub Pages

```
リポジトリ設定 → Pages → ブランチ: main / root
```

---

## 認証

- PIN（4桁）＋ パスワードによる照合
- セッションは `localStorage` に保存（ブラウザを閉じても維持）
- `user.html` → `kintai_authenticate`（全ロール共通）
- `admin.html` → `authenticate`（職員かつ admin_role が空でない場合のみ）

---

## 注意事項

- GAS の実行上限: 6分 / リクエスト
- スプレッドシートへの書き込みは `SpreadsheetApp.flush()` で即時反映
- 日付はシート保存時 `YYYY/MM/DD`、API送受信時 `YYYY-MM-DD` で統一
- PIN・時刻列は `setNumberFormat('@')` でテキスト形式を強制
