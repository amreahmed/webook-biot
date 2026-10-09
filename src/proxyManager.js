const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const http = require("node:http");
const logger = require("./logger");

const PROXY_LIST_URL = (process.env.PROXY_LIST_URL || "").trim();
const PROXY_FILE = (process.env.PROXY_FILE || path.resolve(process.cwd(), "data/proxies.txt")).trim();
const PROXY_URL = (process.env.PROXY_URL || "").trim();
const PROXY_LIST = (process.env.PROXY_LIST || "").trim();
const COOLDOWN_MS = Math.max(10000, Number(process.env.PROXY_COOLDOWN_MS || 300000));
const REFRESH_INTERVAL_MS = Math.max(60000, Number(process.env.PROXY_REFRESH_INTERVAL_MS || 900000));

class ProxyManager {
  constructor() {
    this.proxies = [];
    this.currentIndex = 0;
    this.cooldowns = new Map();
    this.failCounts = new Map();
    this.isSyncing = false;
    this.lastSyncAt = 0;
    this.refreshTimer = null;

    this.loadInitial();
    if (PROXY_LIST_URL) {
      this.syncFromUrl().catch(() => {});
      this.startAutoRefresh();
    }
  }

  loadInitial() {
    let list = [];

    if (fs.existsSync(PROXY_FILE)) {
      try {
        const content = fs.readFileSync(PROXY_FILE, "utf8");
        list = this.parseProxyList(content);
      } catch (err) {
        logger.warn("proxyManager", "Failed reading local proxies file", { error: err.message });
      }
    }

    if (list.length === 0) {
      if (PROXY_LIST) {
        list = PROXY_LIST.split(",").map((p) => p.trim()).filter(Boolean);
      } else if (PROXY_URL) {
        list = [PROXY_URL];
      }
    }

    this.setProxies(list);
  }

  parseProxyList(text) {
    if (!text || typeof text !== "string") return [];
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const parsed = [];

    for (const line of lines) {
      if (line.startsWith("#")) continue;
      let formatted = line;

      const parts = line.split(":");
      if (parts.length === 4 && !line.includes("@")) {
        const [ip, port, user, pass] = parts;
        formatted = `http://${user}:${pass}@${ip}:${port}`;
      } else if (!formatted.startsWith("http://") && !formatted.startsWith("https://") && !formatted.startsWith("socks5://")) {
        formatted = `http://${formatted}`;
      }

      try {
        new URL(formatted);
        parsed.push(formatted);
      } catch {}
    }

    return parsed;
  }

  setProxies(list) {
    const valid = Array.from(new Set(list));
    if (valid.length > 0) {
      this.proxies = valid;
      logger.info("proxyManager", `Loaded ${this.proxies.length} proxies into roulette pool`);
    }
  }

  async fetchRemoteUrl(url) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith("https") ? https : http;
      const req = client.get(url, { timeout: 15000 }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP status ${res.statusCode}`));
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timeout"));
      });
    });
  }

  async syncFromUrl() {
    if (!PROXY_LIST_URL || this.isSyncing) return;
    this.isSyncing = true;
    try {
      logger.info("proxyManager", "Fetching fresh proxies from URL...", { url: PROXY_LIST_URL });
      const content = await this.fetchRemoteUrl(PROXY_LIST_URL);
      const list = this.parseProxyList(content);

      if (list.length > 0) {
        this.setProxies(list);
        this.lastSyncAt = Date.now();

        try {
          const dir = path.dirname(PROXY_FILE);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(PROXY_FILE, list.join("\n") + "\n", "utf8");
          logger.success("proxyManager", `Synced and cached ${list.length} proxies from remote URL`);
        } catch (fileErr) {
          logger.warn("proxyManager", "Failed saving proxies cache to file", { error: fileErr.message });
        }
      } else {
        logger.warn("proxyManager", "Remote URL returned 0 valid proxies");
      }
    } catch (err) {
      logger.warn("proxyManager", "Failed syncing proxies from remote URL", { error: err.message });
    } finally {
      this.isSyncing = false;
    }
  }

  startAutoRefresh() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => {
      this.syncFromUrl().catch(() => {});
    }, REFRESH_INTERVAL_MS);
    if (this.refreshTimer.unref) this.refreshTimer.unref();
  }

  getNextProxy() {
    if (this.proxies.length === 0) return null;

    const now = Date.now();
    const total = this.proxies.length;

    for (let attempts = 0; attempts < total; attempts++) {
      const candidate = this.proxies[this.currentIndex % total];
      this.currentIndex = (this.currentIndex + 1) % total;

      const cooldownUntil = this.cooldowns.get(candidate) || 0;
      if (now >= cooldownUntil) {
        return candidate;
      }
    }

    logger.warn("proxyManager", "All proxies in cooldown. Resetting cooldowns for roulette failover.");
    this.cooldowns.clear();
    const fallback = this.proxies[this.currentIndex % total];
    this.currentIndex = (this.currentIndex + 1) % total;

    if (PROXY_LIST_URL && Date.now() - this.lastSyncAt > 60000) {
      this.syncFromUrl().catch(() => {});
    }

    return fallback;
  }

  getPlaywrightProxy() {
    const proxyUrl = this.getNextProxy();
    if (!proxyUrl) return null;

    try {
      const url = new URL(proxyUrl);
      const result = {
        server: `${url.protocol}//${url.hostname}:${url.port || 80}`,
        rawUrl: proxyUrl,
      };
      if (url.username) result.username = decodeURIComponent(url.username);
      if (url.password) result.password = decodeURIComponent(url.password);
      return result;
    } catch {
      return { server: proxyUrl, rawUrl: proxyUrl };
    }
  }

  _resolveKey(proxyCandidate) {
    if (!proxyCandidate) return null;
    if (typeof proxyCandidate === "string") {
      const match = this.proxies.find((p) => p === proxyCandidate);
      if (match) return match;
      try {
        const url = new URL(proxyCandidate);
        if (url.username) {
          const byUser = this.proxies.find((p) => p.includes(url.username));
          if (byUser) return byUser;
        }
      } catch {}
      return this.proxies.find((p) => p.includes(proxyCandidate) || proxyCandidate.includes(p)) || proxyCandidate;
    }

    if (typeof proxyCandidate === "object") {
      if (proxyCandidate.rawUrl) {
        const match = this.proxies.find((p) => p === proxyCandidate.rawUrl);
        if (match) return match;
      }
      if (proxyCandidate.username) {
        const byUser = this.proxies.find((p) => p.includes(proxyCandidate.username));
        if (byUser) return byUser;
      }
      if (proxyCandidate.server) {
        const byServer = this.proxies.find((p) => p === proxyCandidate.server);
        if (byServer) return byServer;
      }
    }

    return null;
  }

  reportProxyFailure(proxyCandidate, error) {
    const key = this._resolveKey(proxyCandidate);
    if (!key) return;

    const currentFails = (this.failCounts.get(key) || 0) + 1;
    this.failCounts.set(key, currentFails);
    this.cooldowns.set(key, Date.now() + COOLDOWN_MS);

    const errText = error ? (error.message || String(error)) : "Unknown failure";
    logger.warn("proxyManager", `Proxy failed (${currentFails}x). Moving to next proxy in roulette.`, {
      proxy: key.replace(/:[^:]*@/, ":***@"),
      error: errText.slice(0, 80),
      cooldownSeconds: Math.round(COOLDOWN_MS / 1000),
    });

    const healthyCount = this.getHealthyCount();
    if (healthyCount < Math.max(3, this.proxies.length * 0.2) && PROXY_LIST_URL) {
      logger.warn("proxyManager", `Healthy proxies low (${healthyCount}/${this.proxies.length}). Triggering URL refresh.`);
      this.syncFromUrl().catch(() => {});
    }
  }

  reportProxySuccess(proxyCandidate) {
    const key = this._resolveKey(proxyCandidate);
    if (!key) return;

    this.cooldowns.delete(key);
    this.failCounts.delete(key);
  }

  getHealthyCount() {
    const now = Date.now();
    return this.proxies.filter((p) => (this.cooldowns.get(p) || 0) <= now).length;
  }

  getStats() {
    return {
      total: this.proxies.length,
      healthy: this.getHealthyCount(),
      inCooldown: this.cooldowns.size,
      lastSyncAt: this.lastSyncAt ? new Date(this.lastSyncAt).toISOString() : null,
    };
  }
}

const instance = new ProxyManager();

module.exports = instance;
