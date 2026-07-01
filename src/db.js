// src/db.js
// Almacena, por cada empresa/RUC (tenant), las credenciales necesarias para
// llamar a la API del SIRE: client_id/client_secret de "Credenciales de API
// SUNAT" y el usuario secundario SOL + Clave SOL (cifrados).
//
// Usa el módulo SQLite NATIVO de Node.js (node:sqlite, disponible desde
// Node 22+) en vez de better-sqlite3, para no requerir compilación con
// Python/Visual Studio Build Tools en Windows.
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { encrypt, decrypt } = require("./crypto");

const dbPath = process.env.DB_PATH || path.join(__dirname, "..", "data", "sire.db");
require("fs").mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
    ruc TEXT PRIMARY KEY,
    razon_social TEXT,
    sol_usuario TEXT NOT NULL,
    client_id TEXT NOT NULL,
    client_secret_enc TEXT NOT NULL,
    clave_sol_enc TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ruc TEXT NOT NULL,
    libro TEXT NOT NULL,
    periodo TEXT NOT NULL,
    num_ticket TEXT,
    estado TEXT DEFAULT 'pendiente',
    nombre_archivo TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

function upsertTenant({ ruc, razonSocial, solUsuario, clientId, clientSecret, claveSol }) {
  const stmt = db.prepare(`
    INSERT INTO tenants (ruc, razon_social, sol_usuario, client_id, client_secret_enc, clave_sol_enc, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(ruc) DO UPDATE SET
      razon_social = excluded.razon_social,
      sol_usuario = excluded.sol_usuario,
      client_id = excluded.client_id,
      client_secret_enc = excluded.client_secret_enc,
      clave_sol_enc = excluded.clave_sol_enc,
      updated_at = datetime('now')
  `);
  stmt.run(
    ruc,
    razonSocial || null,
    solUsuario,
    clientId,
    encrypt(clientSecret),
    encrypt(claveSol)
  );
}

function getTenant(ruc) {
  const row = db.prepare("SELECT * FROM tenants WHERE ruc = ?").get(ruc);
  if (!row) return null;
  return {
    ruc: row.ruc,
    razonSocial: row.razon_social,
    solUsuario: row.sol_usuario,
    clientId: row.client_id,
    clientSecret: decrypt(row.client_secret_enc),
    claveSol: decrypt(row.clave_sol_enc),
  };
}

function listTenants() {
  return db.prepare("SELECT ruc, razon_social, sol_usuario, updated_at FROM tenants ORDER BY ruc").all();
}

function deleteTenant(ruc) {
  db.prepare("DELETE FROM tenants WHERE ruc = ?").run(ruc);
}

function saveTicket({ ruc, libro, periodo, numTicket }) {
  const stmt = db.prepare(`
    INSERT INTO tickets (ruc, libro, periodo, num_ticket) VALUES (?, ?, ?, ?)
  `);
  const info = stmt.run(ruc, libro, periodo, numTicket);
  return info.lastInsertRowid;
}

function updateTicket(id, { estado, nombreArchivo }) {
  db.prepare(`
    UPDATE tickets SET estado = ?, nombre_archivo = ? WHERE id = ?
  `).run(estado, nombreArchivo || null, id);
}

module.exports = { upsertTenant, getTenant, listTenants, deleteTenant, saveTicket, updateTicket };
