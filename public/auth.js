const $ = (s) => document.querySelector(s),
  register = location.pathname === "/register";
if (register) {
  $("#authTitle").textContent = "Buat akun TradeCloud";
  $("#nameLabel").hidden = false;
  $("#displayName").required = true;
  $("#authSwitch").innerHTML = 'Sudah punya akun? <a href="/login">Masuk</a>';
}
$("#authForm").onsubmit = async (e) => {
  e.preventDefault();
  $("#authMessage").textContent = "";
  const body = {
    email: $("#email").value,
    password: $("#password").value,
    ...(register ? { displayName: $("#displayName").value } : {}),
  };
  const r = await fetch(register ? "/api/auth/register" : "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (r.ok) location.href = "/dashboard";
  else $("#authMessage").textContent = d.error || `HTTP ${r.status}`;
};
