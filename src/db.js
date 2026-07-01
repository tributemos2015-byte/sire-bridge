// src/db.js - Compatible con Node 18+ (usa better-sqlite3)
const path = require("path");
const Database = require("better-sqlite3");
const { encrypt, decrypt } = require("./crypto");

const dbPath = process.env.DB_PATH || path.join(__dirname, "..", "data", "sire.db");
require("fs").mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

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
`);

function upsertTenant({ ruc, razonSocial, solUsuario, clientId, clientSecret, claveSol }) {
  db.prepare(`
    INSERT INTO tenants (ruc, razon_social, sol_usuario, client_id, client_secret_enc, clave_sol_enc, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(ruc) DO UPDATE SET
      razon_social = excluded.razon_social,
      sol_usuario = excluded.sol_usuario,
      client_id = excluded.client_id,
      client_secret_enc = excluded.client_secret_enc,
      clave_sol_enc = excluded.clave_sol_enc,
      updated_at = datetime('now')
  `).run(ruc, razonSocial || null, solUsuario, clientId, encrypt(clientSecret), encrypt(claveSol));
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
  return db.prepare(`INSERT INTO tickets (ruc, libro, periodo, num_ticket) VALUES (?, ?, ?, ?)`).run(ruc, libro, periodo, numTicket).lastInsertRowid;
}

function updateTicket(id, { estado, nombreArchivo }) {
  db.prepare(`UPDATE tickets SET estado = ?, nombre_archivo = ? WHERE id = ?`).run(estado, nombreArchivo || null, id);
}

module.exports = { upsertTenant, getTenant, listTenants, deleteTenant, saveTicket, updateTicket };
