import json
import os
import sys
import time
import ctypes
import traceback

from pywinauto import Application
from pywinauto.win32defines import WM_COMMAND


def fail(code, message):
    print(json.dumps({"success": False, "error_code": code, "message": message}))
    sys.exit(1)


def menu_command(window, label):
    # Native menu IDs avoid pywinauto's remote-memory menu reader (WinError
    # 299 on current MT5 builds) and do not need foreground keyboard focus.
    user = ctypes.WinDLL("user32", use_last_error=True)
    user.GetMenu.argtypes = [ctypes.c_void_p]
    user.GetMenu.restype = ctypes.c_void_p
    user.GetSubMenu.argtypes = [ctypes.c_void_p, ctypes.c_int]
    user.GetSubMenu.restype = ctypes.c_void_p
    user.GetMenuItemCount.argtypes = [ctypes.c_void_p]
    user.GetMenuItemID.argtypes = [ctypes.c_void_p, ctypes.c_int]
    user.GetMenuItemID.restype = ctypes.c_uint
    user.GetMenuStringW.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_wchar_p, ctypes.c_int, ctypes.c_uint]
    root = user.GetMenu(window.handle)
    for index in range(user.GetMenuItemCount(root)):
        submenu = user.GetSubMenu(root, index)
        for item in range(user.GetMenuItemCount(submenu)):
            title = ctypes.create_unicode_buffer(256)
            user.GetMenuStringW(submenu, item, title, len(title), 0x400)
            if title.value.replace("&", "").split("\t", 1)[0].casefold() == label.casefold():
                window.post_message(WM_COMMAND, user.GetMenuItemID(submenu, item), 0)
                return
    raise RuntimeError("Required account menu command not found")


pid = int(os.environ["CT_TERMINAL_PID"])
company = os.environ["CT_BROKER_COMPANY"]
server = os.environ["CT_BROKER_SERVER"]
login = os.environ["CT_BROKER_LOGIN"]
password = os.environ["CT_BROKER_PASSWORD"]


def account_connected():
    path = os.environ.get("CT_TERMINAL_EXE")
    if not path:
        return False
    import MetaTrader5 as mt5
    try:
        if not mt5.initialize(path, timeout=2_000, portable=True):
            return False
        account = mt5.account_info()
        info = mt5.terminal_info()
        return bool(account and account.login == int(login) and account.server.casefold() == server.casefold() and info and info.connected)
    except Exception:
        return False
    finally:
        mt5.shutdown()


try:
    step = "connect"
    app = Application(backend="win32").connect(process=pid, timeout=20)
    if account_connected():
        print(json.dumps({"success": True, "server_added": False}))
        sys.exit(0)
    step = "find_window"
    top = app.top_window()
    if top.window_text().startswith("Open an Account"):
        top.child_window(title="Cancel", class_name="Button").click()
        top = app.top_window()
    # A cached account/server in the title does not prove authentication. After
    # a portable restart MT5 may show that title while offline; submit the
    # requested credentials through the real login dialog instead of skipping.
    if top.window_text() != "Login":
        main = app.window(class_name="MetaQuotes::MetaTrader::5.00")
        step = "restore_main"
        main.restore()
        step = "open_login"
        top = app.window(title="Login")
        # MT5 may still be restoring its workspace after SDK startup. Menu
        # commands sent during that interval can be ignored; retry only when
        # the dialog does not exist to avoid toggling an already open dialog.
        for attempt in range(3):
            if not top.exists(timeout=1):
                menu_command(main.wrapper_object(), "Login to Trade Account")
            try:
                top.wait("ready", timeout=15)
                break
            except Exception:
                if attempt == 2:
                    raise
                time.sleep(3)
    if top.window_text() == "Login":
        step = "submit_credentials"
        server_combo = max(top.children(class_name="ComboBox"), key=lambda item: item.rectangle().top)
        if server in server_combo.item_texts():
            server_combo.select(server)
            edits = sorted([item for item in top.children(class_name="Edit") if item.is_visible() and item.is_enabled()], key=lambda item: item.rectangle().top)
            edits[0].set_edit_text(login)
            edits[1].set_edit_text(password)
            save = top.child_window(title="Save password", class_name="Button")
            if save.exists() and not save.get_check_state():
                save.click()
            top.child_window(title="OK", class_name="Button").click()
            time.sleep(5)
            print(json.dumps({"success": True, "server_added": False}))
            sys.exit(0)
        top.child_window(title="Cancel", class_name="Button").click()
        time.sleep(1)

    main = app.window(class_name="MetaQuotes::MetaTrader::5.00")
    step = "discover_company"
    menu_command(main.wrapper_object(), "Open an Account")
    wizard = app.window(title="Open an Account")
    wizard.wait("ready", timeout=15)
    wizard.child_window(class_name="Edit").set_edit_text(server)
    wizard.child_window(title="Find your company", class_name="Button").click()
    time.sleep(12)

    companies = wizard.child_window(class_name="SysListView32").wrapper_object()
    matched = None
    company_count = companies.item_count()
    for index in range(company_count):
        if account_connected():
            print(json.dumps({"success": True, "server_added": True}))
            sys.exit(0)
        companies = wizard.child_window(class_name="SysListView32").wrapper_object()
        companies.get_item(index).click(where="all")
        time.sleep(0.5)
        next_buttons = [button for button in wizard.children(class_name="Button")
                        if button.window_text() == "&Next >" and button.is_visible() and button.is_enabled()]
        if next_buttons:
            next_buttons[0].click()
        time.sleep(2)
        candidate = app.top_window()
        if candidate.class_name() == "MetaQuotes::MetaTrader::5.00":
            # Resolving the company can complete the SDK's pending account
            # login and close the wizard automatically. The caller must still
            # verify the exact account/server and connection through the SDK.
            print(json.dumps({"success": True, "server_added": True}))
            sys.exit(0)
        radios = [item for item in candidate.children(class_name="Button") if item.friendly_class_name() == "RadioButton" and item.is_visible()]
        radios.sort(key=lambda item: item.rectangle().top)
        if len(radios) >= 3:
            radios[2].click()
            time.sleep(1)
            servers = candidate.child_window(class_name="ComboBox").item_texts()
            # The window title varies by platform build. The server list is
            # the authoritative match for companies returned by this search.
            if server in servers:
                matched = candidate
                break
        candidate.child_window(title="< &Back", class_name="Button").click()
        wizard = app.top_window()
        wizard.wait("ready", timeout=10)
    if matched is None:
        fail("SERVER_COMPANY_NOT_FOUND", "Tidak ditemukan perusahaan broker yang menyediakan server yang diminta")

    radios = [item for item in matched.children(class_name="Button") if item.friendly_class_name() == "RadioButton"]
    radios.sort(key=lambda item: item.rectangle().top)
    if len(radios) < 3:
        fail("EXISTING_ACCOUNT_OPTION_MISSING", "Pilihan login akun existing tidak tersedia")
    radios[2].click()
    edits = matched.children(class_name="Edit")
    edits[0].set_edit_text(login)
    edits[1].set_edit_text(password)
    combo = matched.child_window(class_name="ComboBox")
    if server not in combo.item_texts():
        fail("SERVER_NOT_FOUND_AFTER_ADD", "Server yang diminta tidak ditemukan setelah broker ditambahkan")
    combo.select(server)
    matched.child_window(title="Finish", class_name="Button").click()
    time.sleep(12)
    print(json.dumps({"success": True, "server_added": True}))
except Exception as error:
    # MT5 may finish the pending SDK login while the wizard is being inspected,
    # destroying its controls. Recover only with verified account identity,
    # never from the cached main-window title.
    if step == "discover_company" and account_connected():
        print(json.dumps({"success": True, "server_added": True}))
        sys.exit(0)
    frames = traceback.extract_tb(error.__traceback__)
    locations = ",".join(f"{frame.name}@{frame.lineno}" for frame in frames if frame.filename == __file__)
    fail("SERVER_UI_AUTOMATION_FAILED", f"UI step {step}; exception {type(error).__name__}; winerror {getattr(error, 'winerror', None)}; frames {locations}")
