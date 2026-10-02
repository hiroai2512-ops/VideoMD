# Plus 向けエージェント設定

対象: ローカル Codex。設定仕様の確認日: 2026-09-29、CLI: 0.145.0。モデルIDの更新確認日: 2026-10-02。本文の Sol は GPT-6.1 Sol（gpt-6.1-sol）を指す。

## 設定の役割

- `config.toml`: メイン Sol / medium、指定のない子 Luna / high、同時に開ける子は2つ。役割を自動で常駐起動する設定ではない。
- `agents/*.toml`: 5つのカスタム役割。各ファイルにモデル・推論量・短い指示を保存。
- `../docs/efficient-development.md`: 工程別の使い分け、昇格条件、計測方法。

AGENTS.md の役割選択・再試行・再委譲禁止ルールは行動指示であり、ハードなトークン予算制御ではない。

| 役割 | モデル | 推論量 | 使用する場面 |
| --- | --- | --- | --- |
| メイン | gpt-6.1-sol | medium | 要件、設計、通常実装、統合、本番準備 |
| scout | gpt-6-luna | low | 限定した事実抽出・ログの切り分け |
| lite_worker | gpt-6-luna | high | 仕様とテストが確定した小さな実装 |
| implementer | gpt-6.1-sol | medium | 独立した一般実装・修正 |
| reviewer | gpt-6.1-sol | high | 重要変更の独立レビュー |
| advisor | gpt-6-astra | low | 重大判断・難解バグの限定相談 |

役割の適用条件・調査の返却物・Astra起動の判定は [効率運用](../docs/efficient-development.md) を正本とする。レビュー後は [開発フロー](../docs/development-workflow.md) に従いP0/P1だけを修正する。推論量の効果は手戻りを含めて評価する。

## 読込と優先順位

公式資料: [Config basics](https://learn.chatgpt.com/docs/config-file/config-basic)、[Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[Config reference](https://learn.chatgpt.com/docs/config-file/config-reference)。

プロジェクト設定は、プロジェクトを信頼したクライアントで読み込まれる。管理ポリシーや明示的な起動設定・UI選択が優先される場合がある。ファイル編集だけでは、この実行中の会話のモデルが切り替わったとは言えない。

カスタム役割の TOML にあるモデル・推論量はその役割の設定として使われる。起動時に異なる推論量を渡せば上書きできるとは仮定しない。たとえば advisor を medium に上げるなら、対応するファイルを変更するか、その役割を使わず明示設定の子として起動する。

起動ツールにカスタム役割を選ぶ引数がない場合は、親が該当 TOML を読み、モデル・推論量・指示を明示して渡す。`task_name` を役割名にしただけでは適用されない。全履歴継承とモデル上書きを併用できないツールでは、対応する `fork_turns="none"` または限定履歴を使い、必要な前提を依頼文に含める。

読み取り専用指定はカスタム役割対応クライアントでの設定である。明示起動で sandbox 引数が使えない場合や親の実行時設定が優先する場合は、隔離が強制されたと主張せず、読み取り専用の指示と実行内容を確認する。

## 使い始めるとき

1. アプリでこのプロジェクトを開き、通常作業のモデルを GPT-6.1 Sol、推論量を「中」、速度を Standard にする。実際の選択表示を確認する。
2. CLI ならリポジトリ内で下記を起動する。CLIを追加で動かすと別セッションになるため、アプリと二重に同じ仕事をさせない。
3. 子の初回使用時に役割、実モデル、推論量を確認する。選べないモデルを再試行し続けない。

```powershell
codex -m gpt-6.1-sol -c 'model_reasoning_effort="medium"'
```

Fast の無効化値はクライアントが対応するものを使う。config.toml は速度を指定していないため、既存設定で Fast が有効なら UI で Standard を選ぶ。

ローカルの静的検証は `python scripts/validate-agent-setup.py`（Python 3.11以上）で実行する。TOML構文、役割の必須項目、使用している設定キー、ローカル文書リンクを確認する。公式スキーマ全体やモデルの利用権限を検証するものではない。

`codex doctor --summary` でも設定の読込状態を確認できる。ただし、プロジェクトが未信頼で読み飛ばされる場合は、成功してもこのファイルの読込証明にはならない。CLI 0.145.0 の `--strict-config` は `debug` / `features` サブコマンドで非対応。アプリでの反映や役割の起動は実際の利用時に確認する。

現在の CLI の `-p` は個人設定ディレクトリの `<name>.config.toml` を選ぶ形式。古い記事にある `[profiles.*]` や `[agents.role].config_file` をこの構成に混在させない。古いクライアントではまず現行仕様との対応を確認する。

## 使用できない場合

- そのアカウント・クライアントで選べるモデルを確認する。カタログへの掲載は契約の利用権限を保証しない。
- Astra が使えない場合は Sol / high で問題を狭めて検証する。Luna が使えない場合は Sol / low または medium で子数を減らす。
- サブエージェントが使えない場合はメイン Sol が同じ役割を順番に行う。
- 外部API、追加クレジット、別サービスの有料契約へ自動移行しない。
- 設定更新前に [調査記録](../docs/research/plus-agent-strategy.md) の確認日と現行公式資料を見直す。
