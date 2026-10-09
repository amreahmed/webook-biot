function normalizeText(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function getCookies(storageState) {
  return Array.isArray(storageState && storageState.cookies) ? storageState.cookies : [];
}

function getOrigins(storageState) {
  return Array.isArray(storageState && storageState.origins) ? storageState.origins : [];
}

const JWT_REGEX = /^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+$/;

function isUsableToken(value) {
  if (!value) return false;
  const clean = String(value).replace(/^bearer\s+/i, "").trim();
  if (!clean) return false;
  const lower = clean.toLowerCase();
  if (lower === "false" || lower === "null" || lower === "undefined" || lower === "none" || lower === "true") {
    return false;
  }
  if (clean.startsWith("ey") && clean.includes(".")) {
    return JWT_REGEX.test(clean);
  }
  return clean.length >= 20;
}

function findCookieValue(storageState, names) {
  const wanted = new Set(names.map((name) => String(name).toLowerCase()));
  for (const cookie of getCookies(storageState)) {
    const name = normalizeText(cookie && cookie.name).toLowerCase();
    if (!wanted.has(name)) {
      continue;
    }

    const value = normalizeText(cookie && cookie.value);
    if (value) {
      return value;
    }
  }

  return "";
}

function findLocalStorageValue(storageState, names) {
  const wanted = new Set(names.map((name) => String(name).toLowerCase()));
  for (const origin of getOrigins(storageState)) {
    if (!normalizeText(origin && origin.origin).includes("webook.com")) {
      continue;
    }

    const localStorage = Array.isArray(origin && origin.localStorage) ? origin.localStorage : [];
    for (const item of localStorage) {
      const name = normalizeText(item && item.name).toLowerCase();
      if (!wanted.has(name)) {
        continue;
      }

      const value = normalizeText(item && item.value);
      if (value) {
        return value;
      }
    }
  }

  return "";
}

const JWT_INSIDE_REGEX = /ey[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]+/;

function scanForJwtValue(storageState) {
  for (const origin of getOrigins(storageState)) {
    const localStorage = Array.isArray(origin && origin.localStorage) ? origin.localStorage : [];
    for (const item of localStorage) {
      const raw = normalizeText(item && item.value);
      const match = raw.match(JWT_INSIDE_REGEX);
      if (match && isUsableToken(match[0])) {
        return match[0];
      }
    }
  }

  for (const cookie of getCookies(storageState)) {
    const raw = normalizeText(cookie && cookie.value);
    const match = raw.match(JWT_INSIDE_REGEX);
    if (match && isUsableToken(match[0])) {
      return match[0];
    }
  }

  return "";
}

const TOKEN_KEYS = [
  "token",
  "access_token",
  "auth_token",
  "auth._token.local",
  "auth._token",
  "_token.local",
  "jwt",
  "jwt_token",
  "authorization",
];

function extractAuthToken(storageState) {
  const jwt = scanForJwtValue(storageState);
  if (jwt && isUsableToken(jwt)) {
    return jwt;
  }

  const localVal = findLocalStorageValue(storageState, TOKEN_KEYS);
  if (localVal && isUsableToken(localVal)) {
    return localVal.replace(/^bearer\s+/i, "").trim();
  }

  const cookieVal = findCookieValue(storageState, TOKEN_KEYS);
  if (cookieVal && isUsableToken(cookieVal)) {
    return cookieVal.replace(/^bearer\s+/i, "").trim();
  }

  return "";
}

function extractRefreshToken(storageState) {
  const cookieVal = findCookieValue(storageState, ["refresh_token", "refreshToken", "refresh"]);
  if (cookieVal && isUsableToken(cookieVal)) {
    return cookieVal;
  }

  const localVal = findLocalStorageValue(storageState, ["refresh_token", "refreshToken", "refresh"]);
  if (localVal && isUsableToken(localVal)) {
    return localVal;
  }

  return "";
}

function getPreferredLang(storageState) {
  const fromCookie = findCookieValue(storageState, ["lang", "locale"]);
  if (fromCookie) {
    return fromCookie;
  }

  const fromStorage = findLocalStorageValue(storageState, ["lang", "locale", "language"]);
  if (fromStorage) {
    return fromStorage;
  }

  return "en";
}

function hasAuthMarkers(storageState, options = {}) {
  const customToken = options && (options.jwt || options.hexToken);
  const hasCustom = customToken && isUsableToken(customToken);
  const token = extractAuthToken(storageState);
  const refreshToken = extractRefreshToken(storageState);
  return Boolean(hasCustom || (token && isUsableToken(token)) || (refreshToken && isUsableToken(refreshToken)));
}

function getAuthSummary(storageState, options = {}) {
  const customToken = options && (options.jwt || options.hexToken);
  const validCustom = customToken && isUsableToken(customToken) ? customToken : "";
  const token = validCustom || extractAuthToken(storageState);
  const refreshToken = extractRefreshToken(storageState);

  return {
    hasAuthMarkers: Boolean((token && isUsableToken(token)) || (refreshToken && isUsableToken(refreshToken))),
    hasToken: Boolean(token && isUsableToken(token)),
    hasRefreshToken: Boolean(refreshToken && isUsableToken(refreshToken)),
    cookieCount: getCookies(storageState).length,
    originCount: getOrigins(storageState).length,
  };
}

function buildApiHeaders(storageState, options = {}) {
  const { includeOriginHeaders = true, jwt: customJwt, hexToken: customHexToken } = options;
  const tokenCandidate = customJwt || extractAuthToken(storageState);
  const token = isUsableToken(tokenCandidate) ? tokenCandidate : "";
  const preferredLang = getPreferredLang(storageState).toLowerCase() || "en";
  const lang = preferredLang.split("-")[0] || "en";
  const headers = {
    accept: "application/json, text/plain, */*",
    "accept-language": preferredLang,
    lang,
    app_source: process.env.WEBBOOK_APP_SOURCE || "rs",
  };

  if (includeOriginHeaders) {
    headers.origin = "https://webook.com";
    headers.referer = `https://webook.com/${lang}`;
  }

  if (process.env.WEBBOOK_X_APP_VERSION) {
    headers["x-app-version"] = process.env.WEBBOOK_X_APP_VERSION;
  }

  const rawToken = token ? String(token).replace(/^bearer\s+/i, "").trim() : "";
  if (rawToken) {
    headers.authorization = `Bearer ${rawToken}`;
  }

  if (customHexToken && customHexToken !== rawToken && isUsableToken(customHexToken)) {
    headers.token = customHexToken;
  }

  headers["user-agent"] =
    process.env.API_CLIENT_USER_AGENT ||
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

  return headers;
}

function getJwtExpiry(token) {
  try {
    const raw = String(token || "").replace(/^bearer\s+/i, "").trim();
    if (!JWT_REGEX.test(raw)) return null;
    const payload = JSON.parse(Buffer.from(raw.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function areAccessTokensExpired(storageState, options = {}, now = Date.now()) {
  const tokens = [
    options.jwt,
    options.liveHeaders && (options.liveHeaders.authorization || options.liveHeaders.Authorization),
    extractAuthToken(storageState),
  ].filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => {
    const expiry = getJwtExpiry(token);
    return expiry !== null && expiry <= now;
  });
}

module.exports = {
  areAccessTokensExpired,
  buildApiHeaders,
  extractAuthToken,
  extractRefreshToken,
  getAuthSummary,
  getJwtExpiry,
  getPreferredLang,
  hasAuthMarkers,
  isUsableToken,
};
