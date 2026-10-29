import express from "express";
import path from "node:path";
const app = express();
app.use((_req, res, next) => {
  res.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'",
  );
  next();
});
app.use(express.static(path.resolve("public")));
app.get("/terminal/:id", (_req, res) =>
  res.sendFile(path.resolve("public/terminal.html")),
);
app.listen(18191, "127.0.0.1");
