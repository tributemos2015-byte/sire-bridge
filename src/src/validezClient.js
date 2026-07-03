// src/validezClient.js
// Cliente de la API de SUNAT "Consulta Integrada de Validez de Comprobante
// de Pago" (distinta de la API del SIRE — usa sus propias credenciales,
// generadas en el menu SUNAT: Empresas / Comprobantes de pago / Consulta
// de Validez de Comprobantes de Pago / Credenciales de API SUNAT).
//
// Flujo (segun Manual de Consulta Integrada de Comprobante de Pago v2.0):
//   1) POST a api-seguridad.sunat.gob.pe -> token OAuth2 (grant_type
//      "client_credentials", NO requiere usuario/clave SOL, solo
//      client_id + client_secret de esta API especifica).
//   2) POST a api.sunat.gob.pe/.../{RUC}/validarcomprobante -> valida un
//      comprobante puntual (emisor, tipo, serie, numero, fecha, monto).
const axios = require("axios");

const SEGURIDAD_BASE = "https://api-seguridad.sunat.gob.pe/v1";
const VALIDEZ_BASE = "https://api.sunat.gob.pe/v1";

function logPaso(paso, info) {
  console.log(`[VALIDEZ-CP] ${paso}`, info !== undefined ? JSON.stringify(info) : "");
}

function logErrorSunat(paso, err) {
  const status = err.response?.status;
  console.error(`[VALIDEZ-CP] FALLO en paso "${paso}" — status: ${status}`);
  console.error(`[VALIDEZ-CP] Body de respuesta SUNAT:`, JSON.stringify(err.response?.data, null, 2));
  console.error(`[VALIDEZ-CP] URL llamada:`, err.config?.url);
}

// Token para esta API especifica (grant_type client_credentials, distinto
// del grant_type "password" que usa el SIRE).
async function obtenerTokenValidez({ clientId, clientSecret }) {
  const url = `${SEGURIDAD_BASE}/clientesextranet/${clientId}/oauth2/token/`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "https://api.sunat.gob.pe/v1/contribuyente/contribuyentes",
    client_id: clientId,
    client_secret: clientSecret,
  });
  logPaso("1) Solicitando token OAuth2 (Validez CP)...", { url });
  try {
    const { data } = await axios.post(url, body.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 20000,
    });
    logPaso("1) Token obtenido OK");
    return data.access_token;
  } catch (err) {
    logErrorSunat("obtenerTokenValidez", err);
    throw err;
  }
}

// Valida UN comprobante puntual.
// rucConsultante: RUC de quien realiza la consulta (nuestro tenant).
// datos: { rucEmisor, codComp, numeroSerie, numero, fechaEmision, monto }
//   codComp: "01" Factura, "03" Boleta, "04" Liq. Compra, "07" NC,
//            "08" ND, "R1" Recibo Honorarios, "R7" NC de Recibos.
//   fechaEmision: formato dd/mm/yyyy (tal como lo exige SUNAT).
async function validarComprobante({ token, rucConsultante, rucEmisor, codComp, numeroSerie, numero, fechaEmision, monto }) {
  const url = `${VALIDEZ_BASE}/contribuyente/contribuyentes/${rucConsultante}/validarcomprobante`;
  const body = {
    numRuc: rucEmisor,
    codComp,
    numeroSerie,
    numero: String(numero),
    fechaEmision,
  };
  if (monto !== undefined && monto !== null && monto !== "") body.monto = Number(monto);
  try {
    const { data } = await axios.post(url, body, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      timeout: 20000,
    });
    return data;
  } catch (err) {
    logErrorSunat(`validarComprobante (${codComp} ${numeroSerie}-${numero})`, err);
    // Devolvemos un objeto de error uniforme en vez de reventar todo el
    // lote: asi un comprobante con problema no detiene los demas.
    return {
      success: false,
      message: err.response?.data?.message || err.message,
      data: null,
      errorCode: err.response?.data?.errorCode || String(err.response?.status || "ERROR"),
    };
  }
}

// Valida una LISTA de comprobantes reutilizando un solo token, con una
// pequeña pausa entre llamadas para no saturar el servicio de SUNAT.
async function validarComprobantesLote({ clientId, clientSecret, rucConsultante, comprobantes }, { esperaMs = 300 } = {}) {
  const token = await obtenerTokenValidez({ clientId, clientSecret });
  const resultados = [];
  for (const c of comprobantes) {
    const resultado = await validarComprobante({ token, rucConsultante, ...c });
    resultados.push({ ref: c.ref, ...resultado });
    if (esperaMs) await new Promise((r) => setTimeout(r, esperaMs));
  }
  return resultados;
}

module.exports = { obtenerTokenValidez, validarComprobante, validarComprobantesLote };
