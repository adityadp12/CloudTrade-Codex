import json
import os
import re
import sys
import time

from pywinauto import Application, keyboard


def normalized(value):
    return re.sub(r"[^a-z0-9]", "", value.casefold())


def fail(code, message):
    print(json.dumps({"success": False, "error_code": code, "message": message}))
    sys.exit(1)


pid = int(os.environ["CT_TERMINAL_PID"])
company = os.environ["CT_BROKER_COMPANY"]
server = os.environ["CT_BROKER_SERVER"]
login = os.environ["CT_BROKER_LOGIN"]
password = os.environ["CT_BROKER_PASSWORD"]

try:
    app = Application(backend="win32").connect(process=pid, timeout=20)
    top = app.top_window()
    if top.window_text() != "Login" and server.casefold() in top.window_text().casefold():
        print(json.dumps({"success": True, "server_added": False, "already_connected": True}))
        sys.exit(0)
    if top.window_text() == "Login":
        server_combo = top.children(class_name="ComboBox")[-1]
        if server in server_combo.item_texts():
            server_combo.select(server)
            edits = top.children(class_name="Edit")
            edits[0].set_edit_text(login)
            edits[1].set_edit_text(password)
            save = top.child_window(title="Save password", class_name="Button")
            if save.exists() and not save.get_check_state():
                save.click()
            top.child_window(title="OK", class_name="Button").click()
            print(json.dumps({"success": True, "server_added": False}))
            sys.exit(0)
        top.child_window(title="Cancel", class_name="Button").click()
        time.sleep(1)

    main = app.window(title_re="MetaTrader 5.*")
    main.set_focus()
    keyboard.send_keys("%f")
    keyboard.send_keys("a")
    wizard = app.window(title="Open an Account")
    wizard.wait("ready", timeout=15)
    wizard.child_window(class_name="Edit").set_edit_text(company)
    wizard.child_window(title="Find your company", class_name="Button").click()
    time.sleep(12)

    companies = wizard.child_window(class_name="SysListView32").wrapper_object()
    matched = None
    for index in range(companies.item_count()):
        companies.get_item(index).click()
        wizard.child_window(title="&Next >", class_name="Button").click()
        time.sleep(2)
        candidate = app.window(title_re="Open an Account:.*")
        if candidate.exists():
            title_company = candidate.window_text().split(":", 1)[-1].strip()
            wanted = normalized(company)
            found = normalized(title_company)
            company_root = wanted[: max(3, min(len(wanted), 8))]
            if company_root in found or found in wanted:
                matched = candidate
                break
            candidate.child_window(title="< &Back", class_name="Button").click()
            wizard = app.window(title="Open an Account")
            wizard.wait("ready", timeout=10)
    if matched is None:
        fail("SERVER_COMPANY_NOT_FOUND", "Perusahaan broker tidak ditemukan")

    radios = [item for item in matched.children(class_name="Button") if item.friendly_class_name() == "RadioButton"]
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
    fail("SERVER_UI_AUTOMATION_FAILED", type(error).__name__)
