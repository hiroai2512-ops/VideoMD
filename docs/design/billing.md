# S3-04 Cloud Billing料金通知

2026-10-02確認。[予算通知の公式仕様](https://docs.cloud.google.com/billing/docs/how-to/budgets-programmatic-notifications)、[REST pull](https://docs.cloud.google.com/pubsub/docs/reference/rest/v1/projects.subscriptions/pull)。対象の専用プロジェクト・Vertex AI・月次・クレジット適用前はクラウド側の予算フィルターで設定する。受信処理は予算ID・JPYを厳密に照合する。予算は停止上限ではない。

`src/billing.cjs`はCommonJSの`BillingMonitor`と`applyBillingMessage`を公開する。reducerは`(state, payload, {budgetId, currency:'JPY'})`から`{state, notifications}`を返し、引数を変更しない。`budgetId`はPub/Subの`message.attributes`、金額等はbase64 UTF-8 JSONのdataから取得する。`actualSpendAmount`を代用しない。

状態は`budgetId,currency,period,cost,receivedAt,notifiedMilestones,periods,history`。`periods`は正規化した期間開始日時をキーにした台帳（`cost,notifiedMilestones,receivedAt,publishedAt`）。最新期間をトップレベルに表示し、旧期間の再送でも表示期間を巻き戻さない。発行日時がある場合は古い発行の料金を現在値へ反映しない。後から発行された訂正は反映するが到達履歴を削除しない。通知はまとめても履歴には未通知の1,000円単位の全到達額を記録する。台帳の予算ID変更時は別の保存先または空状態が必要。

1メッセージ当たりの到達判定上限は10,000件（累計1,000万円未満またはちょうど1,000万円）。上限超過は全履歴の欠落を避けるため拒否しackしない。デコード前dataは64KiB以内。履歴と月別台帳は自動削除しない。

`BillingMonitor`のコンストラクターは`subscription,budgetId,getToken,loadState,saveState,onUpdate,onNotify,fetchImpl`。`getToken`はアクセストークン文字列を返す。状態保存は呼び出し側が原子的・永続的に行い、秘密情報と一緒に公開リポジトリへ入れない。`poll()`は最大10件pullし、各メッセージを検証→保存→`onUpdate(state)`→`onNotify({title,body,kind,period,cost,milestones,...})`→ackする。並行pollは同じPromiseに合流する。呼び出し側が定期実行と停止を担当する。トークン・外部エラー本文を状態やエラーメッセージへ保存しない。

保存失敗・不正メッセージ・受信失敗はackしない。保存後のプロセス終了やOS通知障害では、到達履歴は残るがOS通知を再表示しない場合がある。アプリ内履歴で補う。異常メッセージが連続する場合は受信エラーを表示し、設定とクラウド側のデッドレター運用を確認する。

表示種別は`cloud-billing`（Cloud Billing利用料金）。概算通知とは別に扱い、最終請求額・税や即時反映を保証しない。クラウド側の対象フィルターと実際のWindows通知はローカル単体テストの対象外。

検証: `node --test tests/billing.test.cjs`。sandboxで子プロセス起動がEPERMになる場合は`node --test --test-isolation=none tests/billing.test.cjs`で同じケースを実行する。999/1000/3100円、重複・順序逆転・訂正・再起動、月替わりと旧月再送、入力検証、保存前ack防止、ack失敗後の再送、認証エラーの秘匿を確認。
