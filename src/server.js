// src/server.js
try { require("dotenv").config(); } catch (e) { console.log("dotenv no disponible, usando variables de entorno del sistema."); }
const express = require("express");
const cors = require("cors");
const db = require("./db");
const sire = require("./sireClient");

const app = express();
app.use(express.json({ limit: "1mb" }));

// Restringe el origen al dominio donde sirvas el HTML de ContaSol.
// En desarrollo local puedes dejar '*' temporalmente.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
app.use(cors({ origin: ALLOWED_ORIGIN }));

// Limite de tasa: estas rutas tocan credenciales sensibles y la API de SUNAT.
// Implementacion propia simple (sin dependencias externas) para evitar
// problemas de instalacion en el entorno de despliegue.
function limiter(req, res, next) {
  const key = req.ip || "global";
  const now = Date.now();
  if (!limiter._hits) limiter._hits = new Map();
  const entry = limiter._hits.get(key) || { count: 0, start: now };
  if (now - entry.start > 60000) { entry.count = 0; entry.start = now; }
  entry.count++;
  limiter._hits.set(key, entry);
  if (entry.count > 30) return res.status(429).json({ error: "Demasiadas solicitudes, intenta mas tarde." });
  next();
}
app.use("/api", limiter);

// Endpoint publico de salud (no requiere API key) — solo confirma que el
// servidor esta vivo, no expone informacion sensible.
app.get("/api/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

// ---------- Autenticacion del propio backend (multi-gestoria) ----------
// Cada
