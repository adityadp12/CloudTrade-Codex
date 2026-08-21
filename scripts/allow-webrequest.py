import json
import os
import sys
import time

from pywinauto import Application, keyboard


def fail(message):
    print(json.dumps({"success": False, "message": message}))
    sys.exit(1)


try:
    pid = int(os.environ["CT_TERMINAL_PID"])
    url = os.environ["CT_WEBREQUEST_URL"].rstrip("/")
    app = Application(backend="win32").connect(process=pid, timeout=20)
    main = app.window(title_re="MetaTrader 5.*|.*Demo Account.*|.*Real Account.*")
    main.set_focus()
    keyboard.send_keys("^o")
    options = app.window(title="Options")
    options.wait("ready", timeout=15)
    options.child_window(class_name="SysTabControl32").wrapper_object().select("Experts")
    time.sleep(1)
    allow = options.child_window(title="Allow WebRequest for listed URL:", class_name="Button")
    if not allow.get_check_state():
        allow.click()
    urls = options.child_window(class_name="SysListView32").wrapper_object()
    last = urls.get_item(max(0, urls.item_count() - 1)).rectangle()
    urls.double_click_input(
        coords=(min(280, max(20, last.width() // 2)), last.top + max(10, last.height() // 2))
    )
    time.sleep(0.5)
    keyboard.send_keys("^a")
    keyboard.send_keys(url, with_spaces=True)
    keyboard.send_keys("{ENTER}")
    if not allow.get_check_state():
        fail("WebRequest checkbox was not persisted")
    options.child_window(title="OK", class_name="Button").click()
    time.sleep(2)
    print(json.dumps({"success": True}))
except Exception as error:
    fail(type(error).__name__)
