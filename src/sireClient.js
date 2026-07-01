// src/sireClient.js
// Cliente de los Web Services API del SIRE (Compras y Ventas) de SUNAT.
//
// Flujo real (según Manual de Servicios Web Api SIRE Compras v25):
//   1) POST a api-seguridad.sunat.gob.pe -> token OAuth2
//   2) GET "Descargar propuesta" -> SUNAT responde con numTicket
//   3) GET "Consultar estado ticket" -> repetir hasta "Terminado"
//   4) GET "Descargar archivo" -> ZIP con el TXT de la propuesta
//      Parametros obligatorios segun manual v25 seccion 5.32:
//      nomArchivoReporte, codTipoArchivoReporte, codLibro,
//      perTributario, codProceso, numTicket
const axios = require("axios");

const SEGURIDAD_BASE = "https://api-seguridad.sunat.gob.pe/v1";
const SIRE_BASE = "https://api-sire.sunat.gob.pe/v1";

const COD_LIBRO = { compras: "080000", ventas: "140000" };

const ENDPOINTS = {
  compras: {
    descargarPropuesta: (perTributario) =>
      `${SIRE_BASE}/contribuyente/migeigv/libros/rce/propuesta/web/propuesta/${perTributario}/exportacioncomprobantepropuesta`,
    consultarTicket: `${SIRE_BASE}/contribuyente/migeigv/libros/rvierce/gestionprocesosmasivos/web/masivo/consultaestadotickets`,
    descargarArchivo: `${SIRE_BASE}/contribuyente/migeigv/libros/rvierce/gestionprocesosmasivos/web/masivo/archivoreporte`,
    consultarPeriodos: `${SIRE_BASE}/contribuyente/migeigv/libros/rvierce/padron/web/omisos/${COD_LIBRO.compras}/periodos`,
  },
  ventas: {
    // Segun Manual de Servicios Web Api SIRE Ventas v22, seccion 5.18
    // "Servicio Web Api descargar propuesta" (RVIE), el nombre del
    // endpoint es "exportapropuesta" (distinto al de compras/RCE, que
    // usa "exportacioncomprobantepropuesta").
    descargarPropuesta: (perTributario) =>
      `${SIRE_BASE}/contribuyente/migeigv/libros/rvie/propuesta/web/propuesta/${perTributario}/exportapropuesta`,
    consultarTicket: `${SIRE_BASE}/contribuyente/migeigv/libros/rvierce/gestionprocesosmasivos/web/masivo/consultaestadotickets`,
    descargarArchivo: `${SIRE_BASE}/contribuyente/migeigv/libros/rvierce/gestionprocesosmasivos/web/masivo/archivoreporte`,
    consultarPeriodos: `${SIRE_BASE}/contribuyente/migeigv/libros/rvierce/padron/web/omisos/${COD_LIBRO.ventas}/periodos`,
  },
};

function logPaso(paso, info) {
  console.log(`[SIRE] ${paso}`, info !== undefined ? JSON.stringify(info) : "");
}

function logErrorSunat(paso, err) {
  const status = err.response?.status;
  let body = err.response?.data;
  if (body && (Buffer.isBuffer(body) || body instanceof ArrayBuffer || body?.type === "Buffer")) {
    try {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body.data || body);
      const texto = buf.toString("utf8");
      body = JSON.parse(texto);
    } catch (e) {}
  }
  console.error(`[SIRE] FALLO en paso "${paso}" — status: ${status}`);
  console.error(`[SIRE] Body de respuesta SUNAT:`, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  console.error(`[SIRE] URL llamada:`, err.config?.url);
}

async function obtenerToken({ ruc, solUsuario, claveSol, clientId, clientSecret }) {
  const url = `${SEGURIDAD_BASE}/clientessol/${clientId}/oauth2/token/`;
  const body = new URLSearchParams({
    grant_type: "password",
    scope: "https://api-sire.sunat.gob.pe",
    client_id: clientId,
    client_secret: clientSecret,
    username: `${ruc}${solUsuario}`,
    password: claveSol,
  });
  logPaso("1) Solicitando token OAuth2...", { url, username: `${ruc}${solUsuario}` });
  try {
    const { data } = await axios.post(url, body.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 20000,
    });
    logPaso("1) Token obtenido OK");
    return data.access_token;
  } catch (err) {
    logErrorSunat("obtenerToken", err);
    throw err;
  }
}

async function solicitarDescargaPropuesta({ token, libro, periodo }) {
  const url = ENDPOINTS[libro].descargarPropuesta(periodo);
  const paramsCompletos = {
    codTipoArchivo: 0,
    codOrigenEnvio: 2,
    numSerieCDP: "",
    numCDP: "",
    codInconsistencia: "",
    codCar: "",
    numDocAdquiriente: "",
    mtoDesde: "",
    mtoHasta: "",
  };
  const params = Object.fromEntries(
    Object.entries(paramsCompletos).filter(([, v]) => v !== "" && v !== undefined && v !== null)
  );
  logPaso("2) Solicitando descarga de propuesta...", { url, periodo, params });
  try {
    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      params,
      timeout: 20000,
    });
    logPaso("2) Respuesta de solicitud de propuesta:", data);
    return data.numTicket;
  } catch (err) {
    logErrorSunat("solicitarDescargaPropuesta", err);
    throw err;
  }
}

async function consultarEstadoTicket({ token, libro, numTicket, periodo }) {
  const url = ENDPOINTS[libro].consultarTicket;
  try {
    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        perIni: periodo,
        perFin: periodo,
        page: 1,
        perPage: 20,
        numTicket,
      },
      timeout: 20000,
    });
    return data?.registros?.[0] || data;
  } catch (err) {
    logErrorSunat("consultarEstadoTicket", err);
    throw err;
  }
}

// Retorna { archivo, codProceso, numTicket, perTributario } — todos los campos
// que el manual v25 (seccion 5.32) exige para llamar a descargarArchivo.
async function esperarTicket({ token, libro, numTicket, periodo }, { intentos = 15, esperaMs = 4000 } = {}) {
  logPaso("3) Esperando que el ticket termine...", { numTicket });
  for (let i = 0; i < intentos; i++) {
    const registro = await consultarEstadoTicket({ token, libro, numTicket, periodo });
    logPaso(`3) Intento ${i + 1}/${intentos} — registro del ticket:`, registro);
    const detalle = registro?.detalleTicket?.[0] || registro;
    const estadoTexto = (detalle?.desEstadoEnvio || registro?.desEstadoProceso || "").toLowerCase();
    const terminado = estadoTexto.includes("termin");
    if (terminado) {
      const archivo = detalle?.archivoReporte?.[0] || registro?.archivoReporte?.[0];
      if (!archivo) throw new Error("Ticket terminado pero sin archivo de reporte.");
      logPaso("3) Archivo de reporte encontrado:", archivo);
      // Extraer codProceso y perTributario del registro segun manual v25
      const codProceso = registro?.codProceso ?? detalle?.codProceso ?? "10";
      const perTributario = registro?.perTributario ?? periodo;
      return { archivo, codProceso, perTributario, numTicket };
    }
    await new Promise((r) => setTimeout(r, esperaMs));
  }
  throw new Error("Tiempo de espera agotado consultando el ticket SUNAT.");
}

// Segun manual v25 seccion 5.32, los parametros obligatorios son:
// nomArchivoReporte, codTipoArchivoReporte, codLibro, perTributario, codProceso, numTicket
async function descargarArchivo({ token, libro, nombreArchivo, codTipoArchivoReporte, periodo, codProceso, numTicket, intentos = 4, esperaMs = 5000 }) {
  const url = ENDPOINTS[libro].descargarArchivo;
  const codLibro = COD_LIBRO[libro];
  const params = {
    nomArchivoReporte: nombreArchivo,
    codTipoArchivoReporte,
    codLibro,
    perTributario: periodo,
    codProceso,
    numTicket,
  };
  const qs = new URLSearchParams(params).toString();
  logPaso("4) Descargando archivo final...", { urlCompleta: `${url}?${qs}` });

  for (let i = 0; i < intentos; i++) {
    try {
      const { data } = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
        params,
        responseType: "arraybuffer",
        timeout: 30000,
      });
      logPaso("4) Archivo descargado OK, tamaño bytes:", data.length);
      return data;
    } catch (err) {
      const status = err.response?.status;
      logErrorSunat(`descargarArchivo (intento ${i + 1}/${intentos})`, err);
      if (status === 422 && i < intentos - 1) {
        logPaso("4) Reintentando descarga tras espera...", { esperaMs });
        await new Promise((r) => setTimeout(r, esperaMs));
        continue;
      }
      throw err;
    }
  }
}

async function consultarPeriodosHabilitados({ token, libro }) {
  const url = ENDPOINTS[libro].consultarPeriodos;
  logPaso("0) Consultando periodos habilitados...", { url });
  try {
    const { data } = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 20000,
    });
    logPaso("0) Periodos habilitados:", data);
    return data;
  } catch (err) {
    logErrorSunat("consultarPeriodosHabilitados", err);
    throw err;
  }
}

/**
 * Orquesta el flujo completo: token -> solicitar -> esperar ticket -> descargar.
 * @param {{ruc,solUsuario,claveSol,clientId,clientSecret}} credenciales
 * @param {'compras'|'ventas'} libro
 * @param {string} periodo formato AAAAMM
 */
async function descargarPropuestaCompleta(credenciales, libro, periodo) {
  if (!ENDPOINTS[libro]) throw new Error(`Libro invalido: ${libro}`);
  const token = await obtenerToken(credenciales);
  const numTicket = await solicitarDescargaPropuesta({ token, libro, periodo });
  // esperarTicket ahora devuelve { archivo, codProceso, perTributario, numTicket }
  const { archivo, codProceso, perTributario } = await esperarTicket({ token, libro, numTicket, periodo });
  const zipBuffer = await descargarArchivo({
    token,
    libro,
    nombreArchivo: archivo.nomArchivoReporte,
    codTipoArchivoReporte: archivo.codTipoAchivoReporte ?? archivo.codTipoArchivoReporte,
    periodo: perTributario,
    codProceso,
    numTicket,
  });

  const AdmZip = require("adm-zip");
  const zip = new AdmZip(Buffer.from(zipBuffer));
  const entries = zip.getEntries();
  logPaso("5) Contenido del ZIP:", entries.map((e) => e.entryName));
  const txtEntry =
    entries.find((e) => e.entryName === archivo.nomArchivoContenido) ||
    entries.find((e) => e.entryName.toLowerCase().endsWith(".txt"));
  if (!txtEntry) throw new Error("El ZIP descargado no contiene un archivo .txt reconocible.");
  const contenidoTxt = txtEntry.getData().toString("latin1");

  return { numTicket, nombreArchivo: archivo.nomArchivoContenido || txtEntry.entryName, contenidoTxt };
}

module.exports = {
  obtenerToken,
  solicitarDescargaPropuesta,
  consultarEstadoTicket,
  esperarTicket,
  descargarArchivo,
  descargarPropuestaCompleta,
  consultarPeriodosHabilitados,
};
