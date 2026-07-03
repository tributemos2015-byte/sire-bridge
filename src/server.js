// src/server.js
try { require("dotenv").config(); } catch (e) { console.log("dotenv no disponible, usando variables de entorno del sistema."); }
const express = require("express");
const cors = require("cors");
const db = require("./db");
const sire = require("./sireClient");
const validezCP = require("./validezClient");

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
// Cada gestoria/cliente que consume este bridge debe enviar una API key
// valida en el header 'x-api-key'. Las keys validas viven en la variable
// de entorno API_KEYS (separadas por coma si hay mas de una).
function requireApiKey(req, res, next) {
  const validKeys = (process.env.API_KEYS || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  const provided = req.header("x-api-key");
  if (!provided || !validKeys.includes(provided)) {
    return res.status(401).json({ error: "API key invalida o faltante. Envia el header 'x-api-key'." });
  }
  next();
}
app.use("/api", requireApiKey);

// ---------- Utilidades ----------
const LIBROS_VALIDOS = ["compras", "ventas"];
function validarLibro(req, res, next) {
  if (!LIBROS_VALIDOS.includes(req.params.libro)) {
    return res.status(400).json({ error: `Libro invalido. Usa: ${LIBROS_VALIDOS.join(" o ")}.` });
  }
  next();
}
// Nunca devolvemos client_secret ni clave_sol descifrados por HTTP.
function tenantSeguro(t) {
  if (!t) return null;
  return {
    ruc: t.ruc,
    razonSocial: t.razonSocial,
    solUsuario: t.solUsuario,
    clientId: t.clientId,
    tieneValidacionCP: !!(t.clientIdValidacion && t.clientSecretValidacion),
  };
}

// ---------- Tenants (empresas/RUC registrados) ----------
app.post("/api/tenants", (req, res) => {
  const { ruc, razonSocial, solUsuario, clientId, clientSecret, claveSol, clientIdValidacion, clientSecretValidacion } = req.body || {};
  if (!ruc || !solUsuario || !clientId || !clientSecret || !claveSol) {
    return res.status(400).json({ error: "Campos requeridos: ruc, solUsuario, clientId, clientSecret, claveSol." });
  }
  try {
    db.upsertTenant({ ruc, razonSocial, solUsuario, clientId, clientSecret, claveSol, clientIdValidacion, clientSecretValidacion });
    res.json({ ok: true, ruc });
  } catch (err) {
    console.error("Error guardando tenant:", err);
    res.status(500).json({ error: "No se pudo guardar el tenant." });
  }
});

app.get("/api/tenants", (req, res) => {
  try {
    res.json(db.listTenants());
  } catch (err) {
    console.error("Error listando tenants:", err);
    res.status(500).json({ error: "No se pudo listar los tenants." });
  }
});

app.get("/api/tenants/:ruc", (req, res) => {
  try {
    const tenant = db.getTenant(req.params.ruc);
    if (!tenant) return res.status(404).json({ error: "Tenant no encontrado." });
    res.json(tenantSeguro(tenant));
  } catch (err) {
    console.error("Error obteniendo tenant:", err);
    res.status(500).json({ error: "No se pudo obtener el tenant." });
  }
});

app.delete("/api/tenants/:ruc", (req, res) => {
  try {
    db.deleteTenant(req.params.ruc);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error eliminando tenant:", err);
    res.status(500).json({ error: "No se pudo eliminar el tenant." });
  }
});

// ---------- Integracion con SIRE / SUNAT ----------
app.get("/api/sire/:ruc/:libro/periodos", validarLibro, async (req, res) => {
  const tenant = db.getTenant(req.params.ruc);
  if (!tenant) return res.status(404).json({ error: "Tenant no encontrado." });
  try {
    const token = await sire.obtenerToken(tenant);
    const periodos = await sire.consultarPeriodosHabilitados({ token, libro: req.params.libro });
    res.json(periodos);
  } catch (err) {
    console.error("Error consultando periodos:", err.message);
    res.status(502).json({ error: "No se pudo consultar periodos en SUNAT." });
  }
});

// Contrato esperado por el frontend de ContaSol (ver sireBridgeConfig /
// obtenerPropuestaDeSunat en el HTML): POST /api/sire/:libro/propuesta con
// { ruc, periodo } en el body, y respuesta JSON { contenidoTxt, nombreArchivo }.
app.post("/api/sire/:libro/propuesta", validarLibro, async (req, res) => {
  const { libro } = req.params;
  const { ruc, periodo } = req.body || {};
  if (!ruc || !/^\d{11}$/.test(ruc)) {
    return res.status(400).json({ error: "RUC invalido, debe tener 11 digitos." });
  }
  if (!periodo || !/^\d{6}$/.test(periodo)) {
    return res.status(400).json({ error: "Periodo invalido. Formato esperado: AAAAMM (ej. 202506)." });
  }

  const tenant = db.getTenant(ruc);
  if (!tenant) return res.status(404).json({ error: "Tenant no encontrado. Registra primero sus credenciales." });

  const ticketId = db.saveTicket({ ruc, libro, periodo, numTicket: null });
  try {
    const resultado = await sire.descargarPropuestaCompleta(tenant, libro, periodo);
    db.updateTicket(ticketId, { estado: "terminado", nombreArchivo: resultado.nombreArchivo });
    res.json({ contenidoTxt: resultado.contenidoTxt, nombreArchivo: resultado.nombreArchivo });
  } catch (err) {
    console.error("Error descargando propuesta:", err.message);
    db.updateTicket(ticketId, { estado: "error" });
    res.status(502).json({ error: "No se pudo completar la descarga desde SUNAT.", detalle: err.message });
  }
});

// ---------- Validez de Comprobante de Pago (API distinta al SIRE) ----------
// Contrato: POST /api/sunat/:ruc/validar-comprobantes con
// { comprobantes: [{ ref, rucEmisor, codComp, numeroSerie, numero, fechaEmision, monto }, ...] }
// Requiere que el tenant tenga configuradas sus credenciales de la API de
// "Consulta de Validez de Comprobantes de Pago" (distintas a las del SIRE).
app.post("/api/sunat/:ruc/validar-comprobantes", async (req, res) => {
  const { ruc } = req.params;
  const { comprobantes } = req.body || {};
  if (!Array.isArray(comprobantes) || comprobantes.length === 0) {
    return res.status(400).json({ error: "Envia un array 'comprobantes' con al menos un elemento." });
  }
  if (comprobantes.length > 100) {
    return res.status(400).json({ error: "Maximo 100 comprobantes por lote." });
  }
  const tenant = db.getTenant(ruc);
  if (!tenant) return res.status(404).json({ error: "Tenant no encontrado. Registra primero sus credenciales." });
  if (!tenant.clientIdValidacion || !tenant.clientSecretValidacion) {
    return res.status(400).json({
      error: "Este RUC no tiene configuradas las credenciales de la API de Validez de Comprobante de Pago (son distintas a las del SIRE). Registralas primero en 'Credenciales SUNAT'.",
    });
  }
  try {
    const resultados = await validezCP.validarComprobantesLote({
      clientId: tenant.clientIdValidacion,
      clientSecret: tenant.clientSecretValidacion,
      rucConsultante: ruc,
      comprobantes,
    });
    res.json({ resultados });
  } catch (err) {
    console.error("Error validando comprobantes:", err.message);
    res.status(502).json({ error: "No se pudo completar la validacion con SUNAT.", detalle: err.message });
  }
});

// ---------- Manejo de rutas no encontradas y errores ----------
app.use((req, res) => res.status(404).json({ error: "Ruta no encontrada." }));
app.use((err, req, res, next) => {
  console.error("Error no manejado:", err);
  res.status(500).json({ error: "Error interno del servidor." });
});

// ---------- Arranque del servidor ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`sire-bridge escuchando en el puerto ${PORT}`);
});
