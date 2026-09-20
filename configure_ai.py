"""Interactive local setup: credentials are never sent to the browser."""
import getpass
import json
import secrets
import re
from pathlib import Path

CONFIG = Path(__file__).resolve().parent / "linuxlink.local.json"


def main():
    previous = json.loads(CONFIG.read_text(encoding="utf-8")) if CONFIG.exists() else {}
    print("LinuxLink AI setup\nGemini offers a limited free API tier. Use a free-tier project to avoid charges.")
    print("Create a key at https://aistudio.google.com/apikey. Do not paste it into chat.")
    provider = input(f"Provider [gemini/openai] ({previous.get('provider', 'gemini')}): ").strip() or previous.get("provider", "gemini")
    if provider not in ("gemini", "openai"):
        raise SystemExit("Choose gemini or openai.")
    same_provider = previous.get("provider") == provider
    default_model = previous.get("model", "") if same_provider else "gemini-3.6-flash" if provider == "gemini" else ""
    model = input(f"Model ({default_model}): ").strip() or default_model
    key = getpass.getpass("API key (hidden; blank keeps an existing key for this provider): ").strip()
    key = key or (previous.get("api_key", "") if same_provider else "")
    if not model or not key:
        raise SystemExit("A model and API key are required. Configuration was not changed.")
    if not re.fullmatch(r"[A-Za-z0-9._-]+", model):
        raise SystemExit("Invalid model ID. Configuration was not changed.")
    token = previous.get("access_token") or secrets.token_urlsafe(24)
    value = {"provider": provider, "model": model, "api_key": key, "access_token": token}
    CONFIG.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    print(f"Saved locally to {CONFIG.name} (gitignored). Keep this file private.")
    print("When using localhost / adb reverse, the phone app needs no companion token.")
    print("For HTTPS/LAN hosting only, use the access_token saved in this configuration file.")
    print("Then tap Test AI connection. No server restart is needed after changing configuration.")


if __name__ == "__main__":
    main()
