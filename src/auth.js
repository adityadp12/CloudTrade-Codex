import jwt from "jsonwebtoken";
import { config } from "./config.js";
import { query } from "./db.js";

export const issueSession = (user) =>
  jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, {
    algorithm: "HS256",
    expiresIn: "7d",
    issuer: "cloudtrade",
    audience: "cloudtrade-web",
  });

export async function requireAuth(req, res, next) {
  try {
    const payload = jwt.verify(
      req.cookies.cloudtrade_session ?? "",
      config.jwtSecret,
      {
        algorithms: ["HS256"],
        issuer: "cloudtrade",
        audience: "cloudtrade-web",
      },
    );
    const result = await query(
      "SELECT id,email,display_name,role,status FROM users WHERE id=$1",
      [payload.sub],
    );
    if (!result.rows[0] || result.rows[0].status !== "active")
      throw new Error("invalid user");
    req.user = result.rows[0];
    next();
  } catch {
    res.status(401).json({ error: "authentication_required" });
  }
}
