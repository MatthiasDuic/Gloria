from __future__ import annotations

import json
import os
import time
from pathlib import Path

import requests
from dotenv import load_dotenv


def load_env() -> dict[str, str]:
    repo_root = Path(__file__).resolve().parents[1]
    load_dotenv(repo_root / ".env.local", override=False)

    base_url = os.getenv("APP_BASE_URL", "").strip().rstrip("/")
    username = os.getenv("BASIC_AUTH_USERNAME", "").strip()
    password = os.getenv("BASIC_AUTH_PASSWORD", "").strip()

    if not base_url or not username or not password:
        raise RuntimeError("APP_BASE_URL, BASIC_AUTH_USERNAME, BASIC_AUTH_PASSWORD muessen gesetzt sein.")

    return {
        "base_url": base_url,
        "master_username": username,
        "master_password": password,
    }


def expect(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    env = load_env()
    base_url = env["base_url"]

    print("[1] Unauth check for protected API")
    r = requests.get(f"{base_url}/api/learning", allow_redirects=False, timeout=30)
    expect(r.status_code in (307, 401), f"Expected 307/401, got {r.status_code}")

    print("[2] Master login")
    master_session = requests.Session()
    r = master_session.post(
        f"{base_url}/api/auth/login",
        json={
            "username": env["master_username"],
            "password": env["master_password"],
        },
        timeout=30,
    )
    expect(r.status_code == 200, f"Master login failed: {r.status_code} {r.text[:300]}")

    print("[3] Master me/profile")
    r = master_session.get(f"{base_url}/api/auth/me", timeout=30)
    expect(r.status_code == 200, f"auth/me failed: {r.status_code}")
    me = r.json().get("user") or {}
    expect(me.get("role") == "master", f"Expected master role, got {me.get('role')}")

    print("[4] Inbound lookup guard without internal auth")
    r = requests.get(f"{base_url}/api/twilio/inbound/lookup?from=%2B49123456", timeout=30)
    expect(r.status_code == 401, f"Expected 401 for inbound lookup, got {r.status_code}")

    print("[5] Create tenant user (if missing)")
    username = f"py_e2e_{int(time.time())}"
    user_password = "PyE2E!123456"
    r = master_session.post(
        f"{base_url}/api/admin/users",
        json={
            "username": username,
            "realName": "Python E2E",
            "companyName": "Py Tenant GmbH",
            "password": user_password,
            "role": "user",
        },
        timeout=30,
    )
    expect(r.status_code == 200, f"Create user failed: {r.status_code} {r.text[:300]}")
    created_user = (r.json().get("user") or {})
    created_user_id = created_user.get("id")
    expect(bool(created_user_id), "Created user id missing")

    print("[6] Login as tenant user")
    user_session = requests.Session()
    r = user_session.post(
        f"{base_url}/api/auth/login",
        json={"username": username, "password": user_password},
        timeout=30,
    )
    expect(r.status_code == 200, f"User login failed: {r.status_code} {r.text[:300]}")

    print("[7] User denied from admin users")
    r = user_session.get(f"{base_url}/api/admin/users", timeout=30)
    expect(r.status_code == 403, f"Expected 403 for user on admin/users, got {r.status_code}")

    print("[8] Learning endpoint is available for user")
    r = user_session.get(f"{base_url}/api/learning", timeout=30)
    expect(r.status_code == 200, f"User learning failed: {r.status_code} {r.text[:300]}")
    learning_default = r.json()

    print("[9] User cannot override learning scope via userId query")
    r = user_session.get(f"{base_url}/api/learning?userId={created_user_id}", timeout=30)
    expect(r.status_code == 200, f"User learning(userId=...) failed: {r.status_code}")
    learning_override = r.json()
    expect(
        json.dumps(learning_default, sort_keys=True) == json.dumps(learning_override, sort_keys=True),
        "Learning scope override changed payload for non-master user.",
    )

    print("All API checks passed.")


if __name__ == "__main__":
    main()
