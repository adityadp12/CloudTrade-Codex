import json
import os
import sys
import time

from pywinauto import Application
from pywinauto.win32defines import WM_COMMAND, WM_KEYDOWN, WM_KEYUP, VK_RETURN


def fail(message):
    print(json.dumps({"success": False, "message": message}))
    sys.exit(1)


try:
    step = "connect terminal"
    pid = int(os.environ["CT_TERMINAL_PID"])
    url = os.environ["CT_WEBREQUEST_URL"].rstrip("/")
    app = Application(backend="win32").connect(process=pid, timeout=20)
    # Broker-branded titles vary; the main MT5 window class is stable.
    main = app.window(class_name="MetaQuotes::MetaTrader::5.00")
    main.restore()
    # Invoke Tools > Options by command ID. This works without mouse focus and
    # therefore also works when repair is initiated from a phone/RDP session.
    main.post_message(WM_COMMAND, 32849, 0)
    step = "open Options"
    options = app.window(title="Options")
    options.wait("ready", timeout=15)
    options.child_window(class_name="SysTabControl32").wrapper_object().select("Experts")
    time.sleep(1)
    step = "enable WebRequest"
    allow = options.child_window(title="Allow WebRequest for listed URL:", class_name="Button")
    if not allow.get_check_state():
        allow.click()
    urls = options.child_window(class_name="SysListView32").wrapper_object()
    step = "edit WebRequest URL"
    if urls.item_count() > 0:
        last = urls.get_item(urls.item_count() - 1).rectangle()
        coords = (min(280, max(20, last.width() // 2)), last.top + max(10, last.height() // 2))
    else:
        # An empty MT5 list has no item rectangle. Double-click its first editable row.
        area = urls.client_rect()
        coords = (min(280, max(40, area.width() // 2)), min(24, max(12, area.height() // 3)))
    urls.double_click(coords=coords)
    time.sleep(0.5)
    editor = options.child_window(class_name="Edit").wrapper_object()
    editor.set_edit_text(url)
    editor.post_message(WM_KEYDOWN, VK_RETURN, 0)
    editor.post_message(WM_KEYUP, VK_RETURN, 0)
    if not allow.get_check_state():
        fail("WebRequest checkbox was not persisted")
    step = "save Options"
    options.child_window(title="OK", class_name="Button").click()
    time.sleep(2)
    print(json.dumps({"success": True}))
except Exception as error:
    fail(f"{step}: {type(error).__name__}")
