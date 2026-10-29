"""Read-only market data. Never logs in, sends orders, or changes EA settings."""
import ctypes
import json
import os
import sys
import time
from pathlib import Path


def main():
    request = json.loads(sys.stdin.read())
    terminal = Path(request["terminalExe"]).resolve()
    if os.name != "nt" or not terminal.is_file():
        return {"status": "unavailable", "reason": "terminal_not_running", "symbols": []}
    # Only attach when that exact executable is already running. Checking the
    # path also avoids attaching to another tenant after Windows recycles a PID.
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.QueryFullProcessImageNameW.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_ulong)]
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel.OpenProcess(0x1000, False, int(request.get("processId") or 0))
    if not handle:
        return {"status": "unavailable", "reason": "terminal_not_running", "symbols": []}
    try:
        size = ctypes.c_ulong(32768)
        image = ctypes.create_unicode_buffer(size.value)
        if not kernel.QueryFullProcessImageNameW(handle, 0, image, ctypes.byref(size)) or Path(image.value).resolve() != terminal:
            return {"status": "unavailable", "reason": "terminal_process_mismatch", "symbols": []}
    finally:
        kernel.CloseHandle(handle)
    import MetaTrader5 as mt5
    if not mt5.initialize(str(terminal), timeout=5000, portable=True):
        return {"status": "unavailable", "reason": "mt5_connection_unavailable", "symbols": []}
    try:
        info = mt5.terminal_info()
        if not info or not info.connected:
            return {"status": "unavailable", "reason": "broker_disconnected", "symbols": []}
        available = [symbol.name for symbol in (mt5.symbols_get() or []) if symbol.visible]
        wanted = request.get("symbols") or available[:6]
        snapshots = []
        for name in wanted[:12]:
            if name not in available:
                continue
            tick = mt5.symbol_info_tick(name)
            frames = {}
            for label in ("M5", "M15", "H1", "H4"):
                rates = mt5.copy_rates_from_pos(name, getattr(mt5, "TIMEFRAME_" + label), 1, 80)
                frames[label] = [] if rates is None else [{
                    "time": int(bar["time"]), "open": float(bar["open"]), "high": float(bar["high"]),
                    "low": float(bar["low"]), "close": float(bar["close"]),
                    "tickVolume": float(bar["tick_volume"]), "realVolume": float(bar["real_volume"]),
                } for bar in rates]
            book = []
            if mt5.market_book_add(name):
                try:
                    book = [{"side": "ask" if level.type == mt5.BOOK_TYPE_SELL else "bid",
                             "price": level.price, "volume": float(level.volume_dbl)}
                            for level in (mt5.market_book_get(name) or [])
                            if level.type in (mt5.BOOK_TYPE_SELL, mt5.BOOK_TYPE_BUY)]
                finally:
                    mt5.market_book_release(name)
            snapshots.append({"symbol": name, "frames": frames, "book": book,
                              "tick": {"time": tick.time, "bid": tick.bid, "ask": tick.ask} if tick else None})
        return {"status": "ready", "symbols": snapshots, "availableSymbols": available[:250], "capturedAt": int(time.time())}
    finally:
        mt5.shutdown()


try:
    print(json.dumps(main(), allow_nan=False))
except Exception:
    print(json.dumps({"status": "unavailable", "reason": "market_reader_unavailable", "symbols": []}))
