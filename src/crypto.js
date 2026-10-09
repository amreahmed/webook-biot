const crypto = require("node:crypto");

function getMasterKey() {
  const raw = process.env.MASTER_KEY;
  if (!raw || raw.length < 32) {
    throw new Error("MASTER_KEY must be set and at least 32 chars long.");
  }

  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

function encryptJson(value) {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    v: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: encrypted.toString("base64"),
  };
}

function decryptJson(payload) {
  if (!payload || payload.v !== 1) {
    throw new Error("Invalid encrypted payload format.");
  }

  const key = getMasterKey();
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const encrypted = Buffer.from(payload.data, "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8"));
}

module.exports = {
  encryptJson,
  decryptJson,
};
