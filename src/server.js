// src/server.js
try { require("dotenv").config(); } catch (e) { console.log("dotenv no disponible, usando variables de entorno del sistema."); }
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const db = require("./db");
const sire = require("./sireClient");

const app = express();
app.use(express.json({ limit: "1mb" }));

// Restringe el origen al dominio donde sirvas el HTML de ContaSol.
// En desarrollo local puedes dejar '*' temporalmente.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
app.use(cors({ origin: ALLOWED_ORIGIN }));

// Limite de tasa: estas rutas tocan credenciales sensibles y la API de SUNAT.
const limiter = rateLimit({ windowMs: 60_000, max: 30 });
app.use("/api", limiter);

// Endpoint publico de salud (no requiere API key) — solo confirma que el
// servidor esta vivo, no expone informacion sensible.
app.get("/api/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

// ---------- Autenticacion del propio backend (multi-gestoria) ----------
// Cada usuario de la gestoria (no cada RUC cliente) usa una API key fija
// para hablar con este backend. Genera una por persona/integracion con:
//   openssl rand -hex 24
function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"];
  const validKeys = (process.env.API_KEYS || "").split(",").map((k) => k.trim()).filter(Boolean);
  if (!key || !validKeys.includes(key)) {
    return res.status(401).json({ error: "API key invalida o ausente (header X-Api-Key)." });
  }
  next();
}
app.use("/api", requireApiKey);

// ---------- Gestion de tenants (empresas/RUC) ----------

// Registrar o actualizar las credenciales SUNAT de un RUC.
// El usuario y Clave SOL deben ser los del USUARIO SECUNDARIO con permiso SIRE,
// nunca el principal/administrador.
app.post("/api/tenants", (req, res) => {
  const { ruc, razonSocial, solUsuario, claveSol, clientId, clientSecret } = req.body || {};
  if (!ruc || !solUsuario || !claveSol || !clientId || !clientSecret) {
    return res.status(400).json({
      error: "Campos requeridos: ruc, solUsuario, claveSol, clientId, clientSecret.",
    });
  }
  if (!/^\d{11}$/.test(ruc)) {
    return res.status(400).json({ error: "ruc debe tener 11 digitos." });
  }
  db.upsertTenant({ ruc, razonSocial, solUsuario, claveSol, clientId, clientSecret });
  res.json({ ok: true });
});

// Lista de empresas configuradas (nunca devuelve la clave).
app.get("/api/tenants", (req, res) => {
  res.json(db.listTenants());
});

app.delete("/api/tenants/:ruc", (req, res) => {
  db.deleteTenant(req.params.ruc);
  res.json({ ok: true });
});

// ---------- Diagnostico: periodos habilitados (5.33 RCE / 5.2 RVIE) ----------
// Util para confirmar si SUNAT tiene un periodo "habilitado" antes de
// intentar descargar su propuesta.
app.get("/api/sire/:libro/periodos", async (req, res) => {
  const { libro } = req.params;
  const { ruc } = req.query;
  if (!["compras", "ventas"].includes(libro)) {
    return res.status(400).json({ error: "libro debe ser 'compras' o 'ventas'." });
  }
  if (!ruc || !/^\d{11}$/.test(ruc)) {
    return res.status(400).json({ error: "ruc invalido (usar ?ruc=...)." });
  }
  const tenant = db.getTenant(ruc);
  if (!tenant) {
    return res.status(404).json({ error: `No hay credenciales para el RUC ${ruc}.` });
  }
  try {
    const token = await sire.obtenerToken(tenant);
    const data = await sire.consultarPeriodosHabilitados({ token, libro });
    res.json({ ok: true, ruc, libro, data });
  } catch (err) {
    const sunatBody = err.response?.data;
    res.status(502).json({
      error: "No se pudo consultar periodos habilitados.",
      detalle: sunatBody?.msg || err.message,
      bodySunat: sunatBody || null,
    });
  }
});

// ---------- Descarga de propuesta SIRE ----------

// POST /api/sire/:libro/propuesta
// body: { ruc, periodo }  -> periodo formato "AAAAMM", ej "202506"
// Devuelve el TXT plano de la propuesta, listo para que el HTML lo parsee
// con la misma logica que ya usa para archivos subidos manualmente.
app.post("/api/sire/:libro/propuesta", async (req, res) => {
  const { libro } = req.params;
  const { ruc, periodo } = req.body || {};

  if (!["compras", "ventas"].includes(libro)) {
    return res.status(400).json({ error: "libro debe ser 'compras' o 'ventas'." });
  }
  if (!ruc || !/^\d{11}$/.test(ruc)) {
    return res.status(400).json({ error: "ruc invalido." });
  }
  if (!periodo || !/^\d{6}$/.test(periodo)) {
    return res.status(400).json({ error: "periodo invalido, formato esperado AAAAMM." });
  }

  const tenant = db.getTenant(ruc);
  if (!tenant) {
    return res.status(404).json({
      error: `No hay credenciales SUNAT configuradas para el RUC ${ruc}. Registralo primero en /api/tenants.`,
    });
  }

  let ticketId;
  try {
    ticketId = db.saveTicket({ ruc, libro, periodo, numTicket: null });
    const resultado = await sire.descargarPropuestaCompleta(tenant, libro, periodo);
    db.updateTicket(ticketId, { estado: "terminado", nombreArchivo: resultado.nombreArchivo });

    res.json({
      ok: true,
      ruc,
      libro,
      periodo,
      nombreArchivo: resultado.nombreArchivo,
      contenidoTxt: resultado.contenidoTxt,
    });
  } catch (err) {
    if (ticketId) db.updateTicket(ticketId, { estado: "error" });
    const sunatBody = err.response?.data;
    const sunatMsg = sunatBody?.msg || sunatBody?.error_description || err.message;
    console.error("[SIRE] Error descargando propuesta:", sunatMsg);
    res.status(502).json({
      error: "No se pudo descargar la propuesta desde SUNAT.",
      detalle: sunatMsg,
      statusSunat: err.response?.status || null,
      bodySunat: sunatBody || null,
    });
  }
});

const PORT = process.env.PORT || 4100;
app.listen(PORT, () => {
  console.log(`SIRE bridge escuchando en puerto ${PORT}`);
});
