"""エージェント設定と文書の静的検証。モデル呼び出し・ネットワーク・書込なし。"""

from pathlib import Path
import re
import sys
import tomllib


ROOT = Path(__file__).resolve().parents[1]
errors: list[str] = []


def check(condition: bool, message: str) -> None:
    if not condition:
        errors.append(message)


def read_toml(path: Path) -> dict:
    try:
        return tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        errors.append(f"{path.relative_to(ROOT)}: {exc}")
        return {}


config = read_toml(ROOT / ".codex/config.toml")
check(set(config) <= {"model", "model_reasoning_effort", "agents"},
      "config.toml: この検証器が対応していない設定キー")
models = {"gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"}
efforts = {"low", "medium", "high"}
check(config.get("model") in models, "メインモデルの指定を確認")
check(config.get("model_reasoning_effort") in efforts, "メイン推論量の指定を確認")
agents = config.get("agents", {})
check(set(agents) <= {"enabled", "default_subagent_model",
                      "default_subagent_reasoning_effort", "max_concurrent_threads_per_session"},
      "agents: この検証器が対応していない設定キー")
check(agents.get("enabled") is True, "サブエージェント有効化の指定を確認")
check(agents.get("default_subagent_model") in models, "子の既定モデルを確認")
check(agents.get("default_subagent_reasoning_effort") in efforts, "子の既定推論量を確認")
check(agents.get("max_concurrent_threads_per_session") == 2, "Plus運用の子数上限2と不一致")

role_files = sorted((ROOT / ".codex/agents").glob("*.toml"))
names: set[str] = set()
for path in role_files:
    role = read_toml(path)
    for key in ("name", "description", "developer_instructions", "model", "model_reasoning_effort"):
        check(isinstance(role.get(key), str) and bool(role.get(key)), f"{path.name}: {key} が不正")
    name = role.get("name")
    check(name == path.stem and name not in names, f"{path.name}: 役割名の重複または不一致")
    names.add(name)
    check(role.get("model") in models, f"{path.name}: モデルを確認")
    check(role.get("model_reasoning_effort") in efforts, f"{path.name}: 推論量を確認")
    check(set(role) <= {"name", "description", "developer_instructions", "model",
                       "model_reasoning_effort", "sandbox_mode"}, f"{path.name}: 未対応キー")
    if name in {"scout", "reviewer", "advisor"}:
        check(role.get("sandbox_mode") == "read-only", f"{path.name}: 読取専用指定を確認")
check(names == {"scout", "lite_worker", "implementer", "reviewer", "advisor"}, "役割一覧が不一致")

documents = [ROOT / "AGENTS.md", ROOT / ".codex/README.md", *sorted((ROOT / "docs").rglob("*.md"))]
for path in documents:
    content = path.read_text(encoding="utf-8")
    check("\ufffd" not in content, f"{path.name}: 置換文字を検出")
    check(sum(line.startswith("```") for line in content.splitlines()) % 2 == 0,
          f"{path.name}: コードフェンスの不整合")
    for target in re.findall(r"\[[^\]]+\]\(([^)]+)\)", content):
        if re.match(r"[a-zA-Z]+://", target) or target.startswith("#"):
            continue
        check((path.parent / target.split("#", 1)[0]).exists(), f"{path.name}: リンク切れ {target}")

if errors:
    print("\n".join(errors))
    sys.exit(1)
print(f"OK: config + {len(role_files)} roles + {len(documents)} documents")
print("Static checks only; runtime application and account model access are not verified.")
