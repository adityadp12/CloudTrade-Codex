from __future__ import annotations

import json
from pathlib import Path

import MetaTrader5 as mt5


ROOT = Path(__file__).resolve().parent
TERMINAL = ROOT / "HM" / "terminal64.exe"
LOGIN_FILE = ROOT / "login.txt"


def read_credentials() -> tuple[int, str, str]:
    lines = [line.strip() for line in LOGIN_FILE.read_text(encoding="utf-8-sig").splitlines() if line.strip()]
    values: dict[str, str] = {}
    index = 0
    while index < len(lines):
        line = lines[index]
        if ":" in line:
            label, inline_value = line.split(":", 1)
            value = inline_value.strip()
            if not value and index + 1 < len(lines):
                index += 1
                value = lines[index]
            values[label.strip().lower()] = value
        index += 1

    login = values.get("metatrader login", "")
    password = values.get("metatrader password", "")
    server = values.get("metatrader server", "")
    if not login.isdigit() or not password or not server:
        raise ValueError("login.txt does not contain complete MetaTrader credentials")
    return int(login), password, server


def main() -> int:
    login, password, server = read_credentials()
    initialized = mt5.initialize(
        str(TERMINAL),
        login=login,
        password=password,
        server=server,
        timeout=60_000,
        portable=True,
    )
    if not initialized:
        code, message = mt5.last_error()
        print(json.dumps({"success": False, "stage": "initialize", "error_code": code, "message": message}))
        return 1

    try:
        account = mt5.account_info()
        terminal = mt5.terminal_info()
        success = account is not None and account.login == login
        result = {
            "success": success,
            "account_matches": success,
            "server_matches": bool(account and account.server.casefold() == server.casefold()),
            "terminal_connected": bool(terminal and terminal.connected),
            "trade_allowed": bool(account and account.trade_allowed),
        }
        if not success:
            code, message = mt5.last_error()
            result.update({"error_code": code, "message": message})
        print(json.dumps(result))
        return 0 if success else 2
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    raise SystemExit(main())
