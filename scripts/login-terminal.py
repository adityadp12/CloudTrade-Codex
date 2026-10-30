import json
import os
import sys
import time
from pathlib import Path

import MetaTrader5 as mt5

terminal = Path(os.environ["CT_TERMINAL_EXE"])
login = int(os.environ["CT_BROKER_LOGIN"])
password = os.environ["CT_BROKER_PASSWORD"]
server = os.environ["CT_BROKER_SERVER"]

ok = mt5.initialize(str(terminal), login=login, password=password, server=server, timeout=20_000, portable=True)
if not ok:
    code, message = mt5.last_error()
    print(json.dumps({"success": False, "stage": "AUTHENTICATING", "error_code": code, "message": message}))
    mt5.shutdown()
    sys.exit(1)

try:
    account = mt5.account_info()
    terminal_info = mt5.terminal_info()

    def discover(base):
        candidates = [symbol.name for symbol in (mt5.symbols_get() or []) if base in symbol.name.upper()]
        candidates.sort(key=lambda name: (name.upper() != base, len(name), name))
        for name in candidates:
            mt5.symbol_select(name, True)
            for _ in range(10):
                tick = mt5.symbol_info_tick(name)
                if tick and tick.time and tick.bid > 0 and tick.ask > 0:
                    return name
                time.sleep(0.25)
        return None

    eurusd = discover("EURUSD")
    xauusd = discover("XAUUSD")
    result = {
        "success": bool(account and account.login == login and terminal_info and terminal_info.connected),
        "account_matches": bool(account and account.login == login),
        "server_matches": bool(account and account.server.casefold() == server.casefold()),
        "terminal_connected": bool(terminal_info and terminal_info.connected),
        "trade_allowed": bool(account and account.trade_allowed),
        "eurusd_symbol": eurusd,
        "xauusd_symbol": xauusd,
        "eurusd_tick": bool(eurusd),
        "xauusd_tick": bool(xauusd),
    }
    print(json.dumps(result))
    checks = [result[key] for key in ("success", "account_matches", "server_matches", "terminal_connected", "trade_allowed", "eurusd_tick", "xauusd_tick")]
    sys.exit(0 if all(checks) else 2)
finally:
    mt5.shutdown()
