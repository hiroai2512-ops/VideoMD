# VideoMD

WindowsでYouTube動画を日本語のMarkdownに保存する、個人の学習・ナレッジ収集用アプリです。

## 予定する機能

- 日本語中心・外国語混在・字幕なしの動画を対象に、通常20分、最長2時間を処理
- Vertex経由のGemini 3.8 Flash／Gemini 3.5 Flash-Liteによる文字起こし、整文、日本語訳
- `YYYY-MM-DD-動画タイトル.md`でローカル保存（日付は文字起こし実行日）
- フロントマターに元タイトル、URL、公開日時、チャンネル、処理日時、関連タグ5～10個
- 必要な場所だけ簡潔なH2／H3見出しを追加
- API利用料金の1,000円ごとの到達通知（利用停止上限なし）

## 開発状況

要件・設計と接続準備の段階です。アプリ本体と実際の起動コマンドはまだありません。Google Cloudは指定アカウントを照合して設定します。認証情報・処理した動画・出力・料金履歴は公開リポジトリに含めません。

- [要件](docs/requirements.md)
- [設計と料金比較](docs/architecture.md)
- [画面](docs/design/ui.md)
- [データと出力](docs/design/data.md)
- [実装計画と進捗](docs/Plan.md)

## 現在実行できる検証

Python 3.11以降で、開発ルール・設定・文書参照の静的検証を行います。アプリ動作の検証ではありません。

```powershell
python scripts/validate-agent-setup.py
```

動画APIの診断には `scripts/probe-video.ps1` を使えます。Google Cloud CLIのローカルADC認証が必要で、実行にはAPIの従量料金がかかります。`ProjectId`、`ExpectedAccount`、正規化した `VideoUrl`、Git対象外の `runtime/` 内に置く `OutputPath` を指定します。指定アカウントと認証情報が一致しない場合は中止します。秘密値を引数に渡す必要はありません。

`Model` は指定2モデルから選択でき、`StartSecond`・`EndSecond` で区間、`FramesPerSecond` で映像のサンプリングを指定できます。既定値はFlash-Lite・全編・1 FPSです。これは開発用の接続診断で、アプリの起動コマンドや精度保証された文字起こし機能ではありません。応答の完了申告とは別に、動画長・音声・誤認識を確認します。

開発ルールは[AGENTS.md](AGENTS.md)。Codex Coreから引き継いだ工程資料は[開発フロー](docs/development-workflow.md)、[モード運用](docs/work-modes.md)、[文書管理](docs/documentation.md)を参照してください。
