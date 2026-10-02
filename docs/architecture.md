# VideoMD 設計・料金比較（草案）

確認日: 2026-10-02。要件は[requirements.md](requirements.md)。取得実証と未決事項の解消後に確定する。

## 構成案

Windows画面 → URL検証 → メタデータ取得 → Vertex AIで文字起こし → 関連タグ・必要な見出し → Markdown検証 → ローカル保存。

- 指定モデルを選べるようにする案。画面のスタックは取得実証後に選定。
- 公開YouTube URLを動画入力の`fileUri`で渡す方式を先に実証する。YouTube入力はプレビュー。非公開等は未決定。
- タイトル・チャンネル・投稿日時はモデルの推測で埋めない。メタデータ取得経路（YouTube Data API等）の利用条件は別途調査する。
- 認証情報をコード・出力・ログに含めない。Google Cloudは指定のヒロ側アカウントを照合して専用プロジェクトを準備する。アルカディア側は使用しない。認証は個人利用のローカルアプリとしてADCを第一候補とし、利用地域と権限を確定してから設定する。
- 字幕なしの日本語動画と外国語混在動画を音声と照合する。本文は意味を保持して整文し、外国語を日本語訳する。
- 日付は日本時間の実行開始日を使う案。保存先選択、禁則文字置換、同名時の連番、既存ファイル保全を設計する。
- 出力項目案: `title`, `source_url`, `channel`, `published_at`, `transcribed_at`, `tags`。投稿日時と処理日時を分ける。タグは完成した全文から5～10個生成。外国語も日本語に訳した本文を保存する。

## 最長2時間の処理案

指定モデルの[3.8 Flash仕様](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-flash)と[3.5 Flash-Lite仕様](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-flash-lite)では、音声付き動画の目安は1入力約45分。2時間を1回で処理できる前提にしない。

[動画処理の公式仕様](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/video-understanding)には`videoMetadata`による開始・終了区間指定がある。約20分の区間に分けて指定する案（2時間なら基本6区間）。YouTube URLとの組み合わせを実証するまでは、この案が動作確認済みとは扱わない。プロンプトで時間帯を指定するだけの処理を入力分割の代わりにしない。

- 分割境界には短い重なりを設け、内部の発話時刻・区間IDで照合し重複と欠落を扱う。表示用タイムスタンプは必須にしない案。
- 区間ごとに文字起こし・整文・翻訳を行い、順序通り結合する。全体の話題から必要な見出しとタグを生成する。全文を再生成して省略する方式は避ける。
- 出力上限到達・拒否・空の応答・取得失敗を成功扱いにしない。失敗区間を表示し、完了区間から再開する。上限付き再試行と使用量記録を設ける。
- URLの区間指定が利用できない場合、許可された手元音声の分割入力等を再検討する。新たな取得方式を独断で採用しない。

## 設定準備の調査結果

2026-10-02確認: Codexの`VideoMD`ローカルプロジェクトのパスは現在の作業フォルダと一致。Gitを初期化し、ユーザーによるGitHub CLI再認証が完了。許可された公開リポジトリを作成。Google Cloud CLIはコマンド検索で見つからなかった。Google Cloudは作成先アカウントの訂正を受け、ヒロ側を確認してから準備し直す。誤った作成先のプロジェクトをアプリの接続先にしない。

- [ローカルADCの公式手順](https://docs.cloud.google.com/docs/authentication/set-up-adc-local-dev-environment)を確認。ログイン情報や認証JSONをチャットへ貼らせず、リポジトリに保存しない。
- [Google Cloud予算](https://docs.cloud.google.com/billing/docs/how-to/budgets)では通知用予算だけで支出は停止しない。停止上限機能は対象サービスへの適用を別途確認し、アプリ側の概算上限と区別する。
- [YouTube Data API](https://developers.google.com/youtube/v3/getting-started)と[動画取得](https://developers.google.com/youtube/v3/docs/videos/list)を確認。`videos.list`は1回1単位、検索せずURLから動画IDを使う案。通常の他エンドポイント合算枠は1日10,000単位。投稿日時・長さの取得フィールドと安全なキー制限は接続準備で具体化する。

## 公式仕様

- [3.8 Flash](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-flash): ID `gemini-3.8-flash`、音声・動画入力。
- [3.5 Flash-Lite](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-flash-lite): ID `gemini-3.5-flash-lite`、音声・動画入力。
- [動画入力](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/video-understanding): 公開動画またはアカウント所有のYouTube動画、1リクエストにYouTube URL1個。プレビューのPre-GA条件が適用される。ユーザー環境での利用と精度は未検証。

## 費用比較

[公式料金](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing)を2026-10-02確認。USD、Standard PayGo・Global・キャッシュなし。専用サーバー・予約容量を使わない案。APIのみの固定月額・初期サービス料金は想定しない。ストレージ等を追加する場合は別途見積もる。税・請求通貨は請求先に依存し、円換算しない。

仮定: 1処理の入力100,000トークン、出力（推論を含む）10,000トークン。通常月30件、2026年12月までは月100～300件。この仮定は動画の分数からの見積もりではない。実際の長さ・解像度・分割・再試行で変わるため、実測して更新する。

| 案 | 入力／出力単価（100万トークン） | 仮の1件／月10件／月100件 | 品質・速度・運用 |
| --- | --- | --- | --- |
| 3.8 Flash | $0.75／$3.75（2026-12-31まで） | $0.1125／$1.125／$11.25 | 指定候補。2027-01-01から$1.50／$7.50で同じ仮定なら費用2倍。精度・速度は実証が必要 |
| 3.5 Flash-Lite | $0.30／$2.50 | $0.055／$0.55／$5.50 | 指定候補。単価は低いが品質・速度の優劣は実証で判断 |
| 外部AIを使わないローカル処理 | 追加API料金0 | API料金0 | 既存PC・電気代・作業時間が必要。音声認識とローカル言語モデルの構築・保守、モデル容量、PC性能による速度・タグ品質の制約あり。手元の音声ファイルと手入力メタデータを使う案。比較用で未採用 |

計算式: 入力数÷1,000,000×入力単価＋出力数÷1,000,000×出力単価。非Globalは別単価。恒久無料枠を前提にしない。試用クレジット・カード要否・予算通知と停止方法はアカウントの準備状態確認後に調査。API呼び出し・課金有効化は未実行。

同じ仮のトークン量なら月30件／100件／200件／300件は、3.8 Flashで$3.375／$11.25／$22.50／$33.75、3.5 Flash-Liteで$1.65／$5.50／$11／$16.50。時間からの確定見積もりではなく、追加サービスと税は別。

## 1,000円ごとの費用通知

停止上限を設定しない。Cloud Billingの通知用予算とPub/Subを使い、ヒロ側専用プロジェクトのVertex AI利用料金だけを対象にする。予算の基準額1,000円は通知連携のための値であり、利用停止・月額上限に使わない。任意の到達額を受信側で判定する。

- [Budget通知の公式仕様](https://docs.cloud.google.com/billing/docs/how-to/budgets-programmatic-notifications)を2026-10-02確認。`costAmount`、`currencyCode`、`costIntervalStart`、budget IDで対象と期間を検証する。`actualSpendAmount`は異常通知の別フィールドなので使用しない。
- 請求通貨JPYを確認してから円で判定する。別通貨の場合は変換の根拠と表示方式を決めるまで円額を断定しない。初期案は月内累計・クレジット適用前のAPI利用料金。最終請求額・税と区別する。
- Pub/Sub更新は1日複数回で初回は数時間かかる場合がある。費用は請求確定まで変動し得る。即時の「処理概算」と遅延する「Cloud Billing利用料金」を分ける。
- 1,000円、2,000円、3,000円…の到達記録を期間・通知元IDごとに保存。重複・順序逆転・訂正データで同じ到達額を再通知しない。まとめて増えた場合も未通知の到達額を履歴に残す。月替わりを期間開始値で扱う。
- アプリ起動中またはトレイ常駐中にWindows通知とアプリ内履歴で知らせる案。完全終了中は通知できないため、次回起動時に未受信分を処理する。常駐の可否はUI設計で明示する。
- [Pub/Sub料金](https://cloud.google.com/pubsub/pricing): 通常配信は請求先アカウント全体で月10 GiB無料、超過$40/TiB。仮に1日8更新・1更新4 KiBで発行と受信を合わせても月約1.9 MiBだが、実サイズ・APIの最低課金単位・再送を実測する。保存と転送の追加料金は設定による。サーバーは常設しない案。
- クラウドを使わない無料比較案はアプリ内のトークン使用量台帳と手設定した円単価による概算通知。即時に出せるがCloud Billingの実際の利用料金と一致を保証できないため、今回の正式料金通知の代替には採用しない。
