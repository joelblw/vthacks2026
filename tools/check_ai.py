"""Run a minimal provider test; never print credentials or terminal history."""
import json
from pathlib import Path
import runpy
import urllib.error

module = runpy.run_path(str(Path(__file__).resolve().parents[1] / "server.py"), run_name="diagnostic")
try:
    module["plan"]("Connection test only. Return an empty command and a short greeting.", "")
    print("AI connection successful.")
except urllib.error.HTTPError as error:
    try:
        provider_error = json.loads(error.read()).get("error", {})
        message = provider_error.get("message", "Provider error")
    except (ValueError, AttributeError):
        message = "Provider returned an unreadable error"
    key = module["settings"]()["key"]
    print(f"HTTP {error.code}: {message.replace(key, '[redacted]') if key else message}")
    for detail in provider_error.get("details", []) if isinstance(locals().get('provider_error'), dict) else []:
        if isinstance(detail, dict):
            for violation in detail.get("violations", []):
                quota_id = str(violation.get("quotaId", "Unknown quota"))
                print("Quota ID: " + (quota_id.replace(key, '[redacted]') if key else quota_id))
except (OSError, ValueError):
    print("Connection or configuration error. Check the server settings and network access.")
