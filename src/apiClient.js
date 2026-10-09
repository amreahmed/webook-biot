const logger = require("./logger");

const API_BASE_URL = String(process.env.WEBBOOK_API_BASE || "https://api.webook.com").replace(/\/+$/, "");
const REQUEST_TIMEOUT_MS = Math.max(3000, Number(process.env.API_CLIENT_TIMEOUT_MS || 20000));
const MIN_ELIGIBLE_BYTES = Math.max(0, Number(process.env.ELIGIBILITY_MIN_BYTES || 20000));
const MIN_ELIGIBLE_TICKETS = Math.max(0, Number(process.env.ELIGIBILITY_MIN_TICKETS || 10));
const USER_AGENT =
  process.env.API_CLIENT_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const proxyManager = require("./proxyManager");

function getNextProxy() {
  return proxyManager.getNextProxy();
}

function getProxyAgent() {
  const proxyUrl = proxyManager.getNextProxy();
  if (!proxyUrl) return null;
  try {
    const { HttpsProxyAgent } = require("https-proxy-agent");
    return new HttpsProxyAgent(proxyUrl);
  } catch {
    try {
      const { SocksProxyAgent } = require("socks-proxy-agent");
      return new SocksProxyAgent(proxyUrl);
    } catch {
      logger.warn("proxy", "No proxy agent package available. Install https-proxy-agent or socks-proxy-agent.");
      return null;
    }
  }
}

function getPlaywrightProxy() {
  return proxyManager.getPlaywrightProxy();
}

module.exports.getNextProxy = getNextProxy;
module.exports.getProxyAgent = getProxyAgent;
module.exports.getPlaywrightProxy = getPlaywrightProxy;
module.exports.proxyManager = proxyManager;
module.exports.proxyPool = proxyManager.proxies;
module.exports.reportProxyFailure = (...args) => proxyManager.reportProxyFailure(...args);
module.exports.reportProxySuccess = (...args) => proxyManager.reportProxySuccess(...args);

const RATE_MIN_DELAY_MS = Math.max(50, Number(process.env.API_RATE_MIN_DELAY_MS || 200));
const RATE_MAX_DELAY_MS = Math.max(RATE_MIN_DELAY_MS, Number(process.env.API_RATE_MAX_DELAY_MS || 500));
const RATE_DAILY_LIMIT = Math.max(100, Number(process.env.API_RATE_DAILY_LIMIT || 50000));
const RATE_BACKOFF_MULTIPLIER = Number(process.env.API_RATE_BACKOFF_MULTIPLIER || 2);
const RATE_MAX_BACKOFF_MS = Math.max(1000, Number(process.env.API_RATE_MAX_BACKOFF_MS || 30000));
const RATE_PER_ACCOUNT_COOLDOWN_MS = Math.max(0, Number(process.env.API_RATE_ACCOUNT_COOLDOWN_MS || 30000));

let dailyRequestCount = 0;
let dailyResetDate = new Date().toDateString();
let currentBackoffMs = 0;
let lastRequestAt = 0;
const accountLastCallAt = new Map();

function resetDailyCounterIfNeeded() {
  const today = new Date().toDateString();
  if (today !== dailyResetDate) {
    dailyRequestCount = 0;
    dailyResetDate = today;
  }
}

function randomDelay(min, max) {
  return min + Math.random() * (max - min);
}

async function rateLimitWait(accountKey) {
  resetDailyCounterIfNeeded();

  if (dailyRequestCount >= RATE_DAILY_LIMIT) {
    throw new Error(`Daily API limit reached (${RATE_DAILY_LIMIT}). Try again tomorrow.`);
  }

  if (accountKey) {
    const lastCall = accountLastCallAt.get(accountKey) || 0;
    const elapsed = Date.now() - lastCall;
    if (elapsed < RATE_PER_ACCOUNT_COOLDOWN_MS) {
      const waitMs = RATE_PER_ACCOUNT_COOLDOWN_MS - elapsed;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  if (currentBackoffMs > 0) {
    logger.info("api", `Rate limit backoff: waiting ${currentBackoffMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, currentBackoffMs));
  }

  const lastCall = accountKey ? (accountLastCallAt.get(accountKey) || 0) : lastRequestAt;
  const sinceLast = Date.now() - lastCall;
  const minGap = randomDelay(RATE_MIN_DELAY_MS, RATE_MAX_DELAY_MS);
  if (sinceLast < minGap) {
    await new Promise((resolve) => setTimeout(resolve, minGap - sinceLast));
  }

  const now = Date.now();
  lastRequestAt = now;
  dailyRequestCount++;
  if (accountKey) {
    accountLastCallAt.set(accountKey, now);
  }
}

function handleRateResponse(status) {
  if (status === 429) {
    currentBackoffMs = currentBackoffMs === 0 ? 1000 : Math.min(currentBackoffMs * RATE_BACKOFF_MULTIPLIER, RATE_MAX_BACKOFF_MS);
    logger.warn("api", `Got 429. Backoff increased to ${currentBackoffMs}ms`);
  } else if (status >= 200 && status < 400) {

    if (currentBackoffMs > 0) {
      currentBackoffMs = Math.max(0, currentBackoffMs - 500);
    }
  }
}

function getRateLimitStats() {
  return {
    dailyRequestCount,
    dailyLimit: RATE_DAILY_LIMIT,
    currentBackoffMs,
    accountsCached: accountLastCallAt.size,
  };
}

function buildHeaders(account = {}) {
  const jwt = String(account.jwt || "").trim();
  const hexToken = String(account.hexToken || "").trim();

  if (!jwt) {
    throw new Error("Account is missing a JWT token.");
  }

  const headers = {
    Authorization: /^bearer\s/i.test(jwt) ? jwt : `Bearer ${jwt}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    Origin: "https://webook.com",
    Referer: "https://webook.com/",
    "User-Agent": USER_AGENT,
  };

  if (hexToken) {
    headers.token = hexToken;
  }

  return headers;
}

async function apiGet(account, path, options = {}) {
  const url = `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
  const accountKey = options.accountKey || (account && account.email) || null;
  const skipRateLimit = options.skipRateLimit === true;
  let headers;

  try {
    headers = buildHeaders(account);
  } catch (error) {
    return { ok: false, status: 0, data: null, bytes: 0, error: error.message, url };
  }

  if (!skipRateLimit) {
    try {
      await rateLimitWait(accountKey);
    } catch (error) {
      return { ok: false, status: 429, data: null, bytes: 0, error: error.message, url };
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const fetchOptions = {
      method: "GET",
      headers,
      signal: controller.signal,
      redirect: "follow",
    };

    const agent = getProxyAgent();
    if (agent) {
      fetchOptions.agent = agent;
    }

    const response = await fetch(url, fetchOptions);

    handleRateResponse(response.status);

    const text = await response.text();
    const bytes = Buffer.byteLength(text, "utf8");
    let data = null;
    let parseError = "";

    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        parseError = "Response body was not valid JSON.";
      }
    }

    if (response.status === 403) {
      logger.warn("api", "Got 403 — possible IP block or invalid token", { url, accountKey });
    }

    return {
      ok: response.ok,
      status: response.status,
      data,
      bytes,
      error: response.ok ? parseError : `HTTP ${response.status}`,
      url,
    };
  } catch (error) {
    const aborted = error && (error.name === "AbortError" || error.name === "TimeoutError");
    return {
      ok: false,
      status: 0,
      data: null,
      bytes: 0,
      error: aborted ? `Request timed out after ${REQUEST_TIMEOUT_MS}ms` : String((error && error.message) || error),
      url,
    };
  } finally {
    clearTimeout(timer);
  }
}

function eventDetailPath(eventSlug) {
  const slug = String(eventSlug || "").trim();
  if (!slug) {
    throw new Error("eventSlug is required.");
  }

  return `/api/v2/event-detail/${encodeURIComponent(slug)}?lang=ar&visible_in=rs`;
}

async function fetchEventDetail(account, slug) {
  let path;
  try {
    path = eventDetailPath(slug);
  } catch (error) {
    return { ok: false, status: 0, data: null, bytes: 0, error: error.message, url: "" };
  }

  return apiGet(account, path);
}

async function fetchUserProfile(account) {
  return apiGet(account, "/api/v2/user/profile?lang=ar");
}

async function isTokenValid(account) {
  try {
    const result = await fetchUserProfile(account);
    return result.status === 200 && result.ok;
  } catch (error) {
    logger.warn("api", "Token validity check failed", { error: error.message });
    return false;
  }
}

function countEventTickets(payload) {
  const tickets = payload && payload.event_tickets;
  if (Array.isArray(tickets)) {
    return tickets.length;
  }

  if (tickets && typeof tickets === "object") {
    return Object.keys(tickets).length;
  }

  return 0;
}

async function checkEligibility(account, eventSlug) {
  const result = await fetchEventDetail(account, eventSlug);

  const base = {
    eligible: false,
    status: result.status,
    bytes: result.bytes,
    ticketCount: 0,
    earlyBirdQualifiers: null,
  };

  if (!result.ok) {
    const isAuthError = result.status === 401 || result.status === 403;
    return {
      ...base,
      reason: isAuthError ? `Authentication rejected (HTTP ${result.status})` : result.error || "Request failed",
    };
  }

  const payload = result.data && typeof result.data === "object" ? result.data.data || result.data : null;
  if (!payload || typeof payload !== "object") {
    return { ...base, reason: "Event detail payload was empty or unreadable" };
  }

  const earlyBird = payload.early_bird_qualifiers;
  const ticketCount = countEventTickets(payload);
  const enriched = { ...base, ticketCount, earlyBirdQualifiers: earlyBird === undefined ? null : earlyBird };

  if (earlyBird === true) {
    return { ...enriched, reason: "early_bird_qualifiers is true (queue/lottery required)" };
  }

  if (result.bytes < MIN_ELIGIBLE_BYTES) {
    return {
      ...enriched,
      reason: `Response too small (${result.bytes} bytes < ${MIN_ELIGIBLE_BYTES}) — no ticket inventory exposed`,
    };
  }

  if (earlyBird !== false) {
    return { ...enriched, reason: "early_bird_qualifiers missing from response" };
  }

  if (ticketCount <= MIN_ELIGIBLE_TICKETS) {
    return {
      ...enriched,
      reason: `Only ${ticketCount} ticket entries (needs more than ${MIN_ELIGIBLE_TICKETS})`,
    };
  }

  return {
    ...enriched,
    eligible: true,
    reason: `Eligible — ${ticketCount} ticket entries, no early-bird qualifier`,
  };
}

module.exports = {
  API_BASE_URL,
  apiGet,
  buildHeaders,
  checkEligibility,
  fetchEventDetail,
  fetchUserProfile,
  getRateLimitStats,
  isTokenValid,
  getNextProxy,
  getProxyAgent,
  getPlaywrightProxy,
  proxyManager,
  proxyPool: proxyManager.proxies,
  reportProxyFailure: (...args) => proxyManager.reportProxyFailure(...args),
  reportProxySuccess: (...args) => proxyManager.reportProxySuccess(...args),
};
