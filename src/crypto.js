// src/crypto.js
const crypto = require("crypto");

const ALGO = "aes-256-gcm";

function getMasterKey() {
  const raw = process.env.MASTER_KEY;
  if (!raw || raw.length < 32) {
    throw new Error(
      "MASTER_KEY no definida o demasiado corta. Define una variable de entorno " +
      "MASTER_KEY de al menos 32 caracteres."
    );
  }
  return crypto.createHash("sha256").update(raw).digest();
}

function encrypt(plainText) {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

function decrypt(packedBase64) {
  const key = getMasterKey();
  const buf = Buffer.from(packedBase64, "base64");
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

module.exports = { encrypt, decrypt };
