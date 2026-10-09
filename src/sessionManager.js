const fs = require("node:fs/promises");
const path = require("node:path");
const { encryptJson, decryptJson } = require("./crypto");

const DATA_DIR = path.resolve(process.cwd(), "data");
const INDEX_FILE = path.join(DATA_DIR, "accounts.index.enc.json");
const CHAT_PREFS_FILE = path.join(DATA_DIR, "chat-prefs.enc.json");
const ALLOWED_USERS_FILE = path.join(DATA_DIR, "allowed-users.enc.json");
const ALL_EMAILS_FILE = path.join(DATA_DIR, "all-emails.txt");

function accountFile(accountId) {
  return path.join(DATA_DIR, `${accountId}.state.enc.json`);
}

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function saveSession(accountId, storageState) {
  await ensureDataDir();
  const filePath = accountFile(accountId);
  const encrypted = encryptJson(storageState);
  await fs.writeFile(filePath, JSON.stringify(encrypted, null, 2), "utf8");
}

async function loadSession(accountId) {
  const filePath = accountFile(accountId);
  const content = await fs.readFile(filePath, "utf8");
  const encrypted = JSON.parse(content);
  return decryptJson(encrypted);
}

async function hasSession(accountId) {
  try {
    await fs.access(accountFile(accountId));
    return true;
  } catch {
    return false;
  }
}

async function saveLinkedAccountsIndex(accounts) {
  await ensureDataDir();
  const encrypted = encryptJson(accounts);
  await fs.writeFile(INDEX_FILE, JSON.stringify(encrypted, null, 2), "utf8");
}

async function loadLinkedAccountsIndex() {
  try {
    const content = await fs.readFile(INDEX_FILE, "utf8");
    const encrypted = JSON.parse(content);
    const accounts = decryptJson(encrypted);
    return Array.isArray(accounts) ? accounts : [];
  } catch {
    return [];
  }
}

async function loadChatPrefsMap() {
  try {
    const content = await fs.readFile(CHAT_PREFS_FILE, "utf8");
    const encrypted = JSON.parse(content);
    const prefs = decryptJson(encrypted);
    return prefs && typeof prefs === "object" ? prefs : {};
  } catch {
    return {};
  }
}

async function saveChatPrefsMap(prefs) {
  await ensureDataDir();
  const encrypted = encryptJson(prefs);
  await fs.writeFile(CHAT_PREFS_FILE, JSON.stringify(encrypted, null, 2), "utf8");
}

async function getChatLanguage(chatId) {
  if (chatId === null || chatId === undefined) {
    return "ar";
  }

  const prefs = await loadChatPrefsMap();
  const lang = prefs[String(chatId)];
  return lang === "en" ? "en" : "ar";
}

async function saveChatLanguage(chatId, lang) {
  if (chatId === null || chatId === undefined) {
    return;
  }

  const prefs = await loadChatPrefsMap();
  prefs[String(chatId)] = lang === "en" ? "en" : "ar";
  await saveChatPrefsMap(prefs);
}

async function loadAllowedUsers() {
  try {
    const content = await fs.readFile(ALLOWED_USERS_FILE, "utf8");
    const encrypted = JSON.parse(content);
    const users = decryptJson(encrypted);
    return Array.isArray(users) ? users : [];
  } catch {
    return [];
  }
}

async function saveAllowedUsers(users) {
  await ensureDataDir();
  const encrypted = encryptJson(Array.isArray(users) ? users : []);
  await fs.writeFile(ALLOWED_USERS_FILE, JSON.stringify(encrypted, null, 2), "utf8");
}

async function appendKnownEmails(emails) {
  const candidates = Array.isArray(emails) ? emails : [];
  const normalizedIncoming = [];
  const seenIncoming = new Set();

  for (const value of candidates) {
    const email = String(value || "").trim();
    if (!email || !email.includes("@")) {
      continue;
    }

    const key = email.toLowerCase();
    if (seenIncoming.has(key)) {
      continue;
    }

    seenIncoming.add(key);
    normalizedIncoming.push(email);
  }

  if (normalizedIncoming.length === 0) {
    return { added: 0, total: 0, filePath: ALL_EMAILS_FILE };
  }

  await ensureDataDir();

  let existingLines = [];
  try {
    const content = await fs.readFile(ALL_EMAILS_FILE, "utf8");
    existingLines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    existingLines = [];
  }

  const seen = new Set(existingLines.map((line) => line.toLowerCase()));
  let added = 0;
  for (const email of normalizedIncoming) {
    const key = email.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    existingLines.push(email);
    seen.add(key);
    added += 1;
  }

  if (added > 0) {
    await fs.writeFile(ALL_EMAILS_FILE, `${existingLines.join("\n")}\n`, "utf8");
  }

  return {
    added,
    total: existingLines.length,
    filePath: ALL_EMAILS_FILE,
  };
}

module.exports = {
  saveSession,
  loadSession,
  hasSession,
  saveLinkedAccountsIndex,
  loadLinkedAccountsIndex,
  getChatLanguage,
  saveChatLanguage,
  loadAllowedUsers,
  saveAllowedUsers,
  appendKnownEmails,
};
