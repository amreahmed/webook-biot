const { chromium } = require("playwright");

const logger = require("./logger");
const { connectDb } = require("./db");
const Account = require("./models/Account");
const LoginJob = require("./models/LoginJob");
const { LoginControl } = require("./loginControl");
const loginControl = new LoginControl();
const { extractAuthToken, extractRefreshToken, hasAuthMarkers, buildApiHeaders, isUsableToken } = require("./webookAuth");
const { captureLiveAuthHeaders, normalizeLiveApiHeaders } = require("./ticketFetcher");
const proxyManager = require("./proxyManager");
const { getPlaywrightProxy } = require("./apiClient");
const { assertNoSecurityChallenge } = require("./websiteVerification");

const LOGIN_URL = process.env.WEBBOOK_LOGIN_URL || "https://webook.com/login";
const BATCH_SIZE = Math.max(1, Number(process.env.LOGIN_QUEUE_BATCH_SIZE || 10));
const CONCURRENCY = Math.max(1, Number(process.env.LOGIN_QUEUE_CONCURRENCY || 20));
const IDLE_POLL_MS = Math.max(250, Number(process.env.LOGIN_QUEUE_POLL_MS || 2000));
const LOGIN_TIMEOUT_MS = Math.max(5000, Number(process.env.LOGIN_RESULT_TIMEOUT_MS || 25000));
const MAX_PROXY_ATTEMPTS = Math.max(1, Number(process.env.LOGIN_MAX_PROXY_ATTEMPTS || 3));
const CHROMIUM_SANDBOX = String(process.env.PLAYWRIGHT_CHROMIUM_SANDBOX || "false").toLowerCase() === "true";
const BLOCK_HEAVY_RESOURCES = String(process.env.BLOCK_HEAVY_RESOURCES || "true").toLowerCase() === "true";
const STALE_PROCESSING_MS = Math.max(60000, Number(process.env.LOGIN_QUEUE_STALE_MS || 180000));
const NOTIFY_EVERY = Math.max(1, Number(process.env.LOGIN_QUEUE_NOTIFY_EVERY || 5));

function sanitizeAccountUsername(value) {
  return String(value || "")
    .replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E\u00A0]/g, "")
    .trim();
}

const COOKIE_REJECT_SELECTORS = [
  "button:has-text('رفض الكل الغير ضروري')",
  "button:has-text('رفض الكل')",
  "button:has-text('رفض')",
  "button:has-text('Reject all non-essential')",
  "button:has-text('Reject all')",
  "button:has-text('Reject')",
];

const COOKIE_ACCEPT_SELECTORS = [
  "button:has-text('قبول الكل')",
  "button:has-text('قبول')",
  "button:has-text('Accept all')",
  "button:has-text('Accept')",
];

const COOKIE_CONSENT_SELECTORS = [...COOKIE_REJECT_SELECTORS, ...COOKIE_ACCEPT_SELECTORS];

const LOGIN_FAILURE_PATTERNS = [
  {
    code: "account-blocked",
    pattern: /blocked due to malicious activity|تم حظر الحساب|تم حظرك|account.*blocked|حساب.*محظور|تم إيقاف الحساب|account has been locked/i,
    message: "Account is blocked by Webook due to malicious activity.",
  },
  {
    code: "invalid-credentials",
    pattern: /incorrect email or password|invalid credentials|invalid email or password|wrong password|invalid email|invalid password|البريد الإلكتروني أو كلمة المرور غير صحيحة|كلمة المرور غير صحيحة|بيانات الاعتماد غير صالحة|البريد الإلكتروني غير مسجل|خطأ في كلمة المرور/i,
    message: "Incorrect email or password.",
  },
  { code: "temporary", pattern: /something went wrong|حدث خطأ ما|يرجى المحاولة مرة أخرى|please try again/i, message: "Webook returned a temporary error." },
];

const state = {
  running: false,
  stopping: false,
  loopPromise: null,
  activeBrowsers: new Set(),
  activeJobs: 0,
  signalsBound: false,
  notifier: null,
  progressByOwner: new Map(),
};

function createLoginFailure(code, message) {
  const error = new Error(message);
  error.loginFailureCode = code;
  return error;
}

function isPermanentFailureCode(code) {
  return code === "account-blocked" || code === "invalid-credentials";
}

function shouldStopLoginRetry(code) {
  return isPermanentFailureCode(code) || code === "verification-required";
}

async function launchBrowser() {
  const launchOptions = {
    headless: true,
    chromiumSandbox: CHROMIUM_SANDBOX,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-breakpad",
      "--disable-component-update",
      "--disable-features=TranslateUI,BlinkGenPropertyTrees",
      "--disable-ipc-flooding-protection",
      "--disable-renderer-backgrounding",
      "--enable-features=NetworkService,NetworkServiceInProcess",
      "--force-color-profile=srgb",
      "--mute-audio",
      "--no-default-browser-check",
      "--no-first-run",
    ],
  };

  return chromium.launch(launchOptions);
}

async function findFirstVisibleLocator(candidates, timeout = 1200) {
  for (const locator of candidates) {
    try {
      if (await locator.isVisible({ timeout })) {
        return locator;
      }
    } catch {

    }
  }

  return null;
}

function getEmailFieldCandidates(page) {
  return [
    page.locator("input[type='email']").first(),
    page.locator("input[name='email']").first(),
    page.locator("[data-testid='auth_email_input']").first(),
    page.locator("[data-testid='auth_login_email_input']").first(),
    page.locator("form#email-login input[autocomplete='username']").first(),
    page.locator("input[autocomplete='username']").first(),
    page.locator("input[autocomplete='email']").first(),
    page.locator("form#email-login input[name='email']").first(),
    page.locator("[data-testid*='email'] input").first(),
  ];
}

function getPasswordFieldCandidates(page) {
  return [
    page.locator("input[type='password']").first(),
    page.locator("input[name='password']").first(),
    page.locator("[data-testid='auth_login_password_input']").first(),
    page.locator("form#email-login input[autocomplete='current-password']").first(),
    page.locator("input[autocomplete='current-password']").first(),
    page.locator("form#email-login input[name='password']").first(),
    page.locator("[data-testid*='password'] input").first(),
  ];
}

function getEmailStepSubmitCandidates(page) {
  return [
    page.locator("button[type='submit']:has-text('البريد')").first(),
    page.locator("button[type='submit']:has-text('email')").first(),
    page.locator("button[type='submit']").first(),
    page.getByRole("button", { name: /^Continue with email$/i }).first(),
    page.locator("button:has-text('تابع باستخدام البريد')").first(),
    page.locator("button:has-text('Continue with email')").first(),
    page.locator("button:has-text('المتابعة بالبريد')").first(),
  ];
}

function getSubmitCandidates(page) {
  return [
    page.locator("button[type='submit']:has-text('تسجيل الدخول')").first(),
    page.locator("button[type='submit']:has-text('Log in')").first(),
    page.locator("button[type='submit']:has-text('Login')").first(),
    page.locator("button[type='submit']:has-text('Sign in')").first(),
    page.locator("button[type='submit']").first(),
    page.locator("#email-login-button").first(),
    page.locator("form#email-login button[type='submit']").first(),
    page.getByRole("button", { name: /^(Login|Log in|Sign in)$/i }).first(),
    page.locator("button:has-text('تسجيل الدخول')").first(),
    page.locator("button:has-text('Log in')").first(),
  ];
}

async function isLoginFormReady(page) {
  const candidates = [...getEmailFieldCandidates(page), ...getPasswordFieldCandidates(page)];
  return Boolean(await findFirstVisibleLocator(candidates, 250));
}

async function waitForLoginFieldsReady(page, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await assertNoSecurityChallenge(page);
    if (await isLoginFormReady(page)) {
      return true;
    }

    const failure = await getLoginFailureState(page);
    if (failure && failure.code !== "temporary") {
      throw createLoginFailure(failure.code, failure.message);
    }

    await page.waitForTimeout(250);
  }

  return false;
}

async function handleCookieConsent(page, options = {}) {
  const maxWaitMs = Math.max(300, Number(options.maxWaitMs || 1500));
  const startedAt = Date.now();
  const deadline = startedAt + maxWaitMs;
  const combinedSelector = COOKIE_CONSENT_SELECTORS.join(", ");

  while (Date.now() < deadline) {
    try {
      const button = page.locator(combinedSelector).first();
      if (await button.isVisible({ timeout: 150 })) {
        await button.click({ timeout: 1500, force: true }).catch(() => {});
        await page.waitForTimeout(150);
        return true;
      }
    } catch {}

    try {
      const dismissed = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("[role='dialog'] button, [id*='radix'] button, #onetrust-banner-sdk button, [class*='cookie'] button, [id*='cookie'] button"));
        for (const b of btns) {
          const text = (b.innerText || "").trim();
          if (/رفض|قبول|Reject|Accept|Dismiss|agree|close/i.test(text)) {
            b.click();
            return true;
          }
        }
        const dialog = document.querySelector("[role='dialog'], [data-state='open'][class*='fixed']");
        if (dialog) {
          dialog.remove();
          return true;
        }
        return false;
      }).catch(() => false);

      if (dismissed) {
        await page.waitForTimeout(150);
        return true;
      }
    } catch {}

    await page.waitForTimeout(100);
  }

  return false;
}

async function getLoginFailureState(page) {
  for (const entry of LOGIN_FAILURE_PATTERNS) {
    try {
      const node = page.getByText(entry.pattern).first();
      if (await node.isVisible({ timeout: 200 })) {
        return entry;
      }
    } catch {

    }
  }

  return null;
}

async function setInputValue(locator, value, fieldName) {
  try {
    await locator.scrollIntoViewIfNeeded();
  } catch {}

  try {
    await locator.click({ timeout: 2000 });
  } catch {}

  try {
    await locator.fill(value, { timeout: 4000 });
  } catch {
    try {
      await locator.pressSequentially(value, { delay: 10, timeout: 5000 });
    } catch {}
  }

  await locator.evaluate((element, nextValue) => {
    element.value = nextValue;
    const tracker = element._valueTracker;
    if (tracker) {
      tracker.setValue(nextValue);
    }
    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }, value).catch(() => {});

  await locator.dispatchEvent("input").catch(() => {});
  await locator.dispatchEvent("change").catch(() => {});
}

async function clickWithConsentRecovery(page, button, attempts = 3) {
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await handleCookieConsent(page, { maxWaitMs: 800 });

    try {
      if (!(await button.isVisible({ timeout: 1200 }))) {
        continue;
      }

      let disabled = await button.evaluate((el) => Boolean(el.disabled || el.getAttribute("aria-disabled") === "true")).catch(() => false);
      if (disabled) {
        const waitDeadline = Date.now() + 2000;
        while (Date.now() < waitDeadline) {
          await page.waitForTimeout(200);
          disabled = await button.evaluate((el) => Boolean(el.disabled || el.getAttribute("aria-disabled") === "true")).catch(() => false);
          if (!disabled) break;
        }
        if (disabled) {
          continue;
        }
      }

      await button.click({ timeout: 4000 });
      return;
    } catch (error) {
      const msg = String(error && error.message ? error.message : error);
      if (
        msg.includes("Execution context was destroyed") ||
        msg.includes("navigating") ||
        msg.includes("Target page, context or browser has been closed")
      ) {
        return;
      }
      lastError = error;
      if (msg.includes("intercepts pointer events")) {
        await handleCookieConsent(page, { maxWaitMs: 1500 });
      }
      await page.waitForTimeout(300);
    }
  }

  throw lastError || new Error("Could not click the login button.");
}

async function executeTwoStepLogin(page, rawEmail, password, loginApiState = null) {
  const email = sanitizeAccountUsername(rawEmail);
  if (!email || !email.includes("@") || !email.includes(".") || email.endsWith(".")) {
    throw createLoginFailure("invalid-credentials", `Invalid email address format: "${email}"`);
  }

  await waitForLoginFieldsReady(page);
  await handleCookieConsent(page, { maxWaitMs: 1200 });

  let emailInput = await findFirstVisibleLocator(getEmailFieldCandidates(page), 1500);
  let passwordInput = await findFirstVisibleLocator(getPasswordFieldCandidates(page), 1000);

  if (!emailInput && !passwordInput) {
    throw new Error("Could not locate visible login fields (neither email nor password).");
  }

  if (emailInput && !passwordInput) {
    await setInputValue(emailInput, email, "email");
    await page.waitForTimeout(300);

    const continueButton = await findFirstVisibleLocator(getEmailStepSubmitCandidates(page), 2000);
    if (!continueButton) {
      throw new Error("Could not find the email-step submit button.");
    }

    await clickWithConsentRecovery(page, continueButton, 3);

    const step2Deadline = Date.now() + 12000;
    while (Date.now() < step2Deadline) {
      passwordInput = await findFirstVisibleLocator(getPasswordFieldCandidates(page), 400);
      if (passwordInput) {
        break;
      }

      if (loginApiState && loginApiState.error) {
        const code = loginApiState.error.isPermanent ? "invalid-credentials" : "temporary";
        throw createLoginFailure(code, loginApiState.error.message);
      }

      const failure = await getLoginFailureState(page);
      if (failure && failure.code !== "temporary") {
        throw createLoginFailure(failure.code, failure.message);
      }

      await page.waitForTimeout(300);
    }

    if (!passwordInput) {
      if (loginApiState && loginApiState.error) {
        const code = loginApiState.error.isPermanent ? "invalid-credentials" : "temporary";
        throw createLoginFailure(code, loginApiState.error.message);
      }
      throw new Error("Could not locate the password field after submitting email.");
    }
  }

  await page.waitForTimeout(400);
  await setInputValue(passwordInput, password, "password");
  await page.waitForTimeout(300);

  const submitButton = await findFirstVisibleLocator(getSubmitCandidates(page), 2000);
  if (submitButton) {
    await clickWithConsentRecovery(page, submitButton, 3);
  } else {
    await passwordInput.press("Enter").catch(() => {});
  }
}

async function fillLoginForm(page, email, password) {
  return executeTwoStepLogin(page, email, password);
}

async function submitLoginForm(page) {

}

async function waitForAuthenticatedSession(page, context, timeoutMs = LOGIN_TIMEOUT_MS, loginApiState = null, headerCaptureState = null) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await assertNoSecurityChallenge(page);
    if (state.stopping) {
      throw new Error("Worker is shutting down before login completed.");
    }

    if (loginApiState && loginApiState.error) {
      const code = loginApiState.error.isPermanent ? "invalid-credentials" : "temporary";
      throw createLoginFailure(code, loginApiState.error.message);
    }

    if (headerCaptureState && headerCaptureState.jwt && isUsableToken(headerCaptureState.jwt)) {
      return await context.storageState();
    }

    const storageState = await context.storageState();
    const leftLoginPage = !String(page.url()).includes("/login");
    const authToken = extractAuthToken(storageState);

    if (authToken && isUsableToken(authToken) && Array.isArray(storageState.cookies) && storageState.cookies.length > 0) {
      return storageState;
    }

    if (leftLoginPage && hasAuthMarkers(storageState) && Array.isArray(storageState.cookies) && storageState.cookies.length > 0) {
      return storageState;
    }

    const failure = await getLoginFailureState(page);
    if (failure && isPermanentFailureCode(failure.code)) {
      throw createLoginFailure(failure.code, failure.message);
    }

    await page.waitForTimeout(300);
  }

  throw new Error(`Login timed out after ${timeoutMs}ms.`);
}

function decodeJwtExpiry(jwt) {
  const token = String(jwt || "").replace(/^bearer\s+/i, "");
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    if (payload && Number.isFinite(Number(payload.exp))) {
      return new Date(Number(payload.exp) * 1000);
    }
  } catch {

  }

  return null;
}

const MAX_BROWSERS = Math.max(1, Number(process.env.MAX_BROWSER_POOL_SIZE || 4));
const MAX_CONTEXTS_PER_BROWSER = Math.max(1, Number(process.env.MAX_CONTEXTS_PER_BROWSER || 5));
const MAX_USES_PER_BROWSER = Math.max(10, Number(process.env.MAX_USES_PER_BROWSER || 50));

class BrowserPool {
  constructor() {
    this.pool = [];
  }

  async acquire() {

    this.pool = this.pool.filter((entry) => entry.browser && entry.browser.isConnected());

    let selected = null;
    for (const entry of this.pool) {
      if (!entry.closing && entry.activeContexts < MAX_CONTEXTS_PER_BROWSER) {
        if (!selected || entry.activeContexts < selected.activeContexts) {
          selected = entry;
        }
      }
    }

    if (!selected && this.pool.length < MAX_BROWSERS) {
      try {
        const browser = await launchBrowser();
        state.activeBrowsers.add(browser);
        selected = {
          browser,
          activeContexts: 0,
          totalUses: 0,
          closing: false,
        };
        browser.on("disconnected", () => {
          state.activeBrowsers.delete(browser);
          const index = this.pool.indexOf(selected);
          if (index !== -1) this.pool.splice(index, 1);
        });
        this.pool.push(selected);
      } catch (err) {
        logger.error("loginQueue", "Could not launch new browser in pool", { error: err.message });
      }
    }

    if (!selected && this.pool.length > 0) {
      selected = this.pool.reduce((prev, curr) => (curr.activeContexts < prev.activeContexts ? curr : prev));
    }

    if (!selected) {
      const browser = await launchBrowser();
      state.activeBrowsers.add(browser);
      selected = {
        browser,
        activeContexts: 0,
        totalUses: 0,
        closing: false,
      };
      browser.on("disconnected", () => {
        state.activeBrowsers.delete(browser);
        const index = this.pool.indexOf(selected);
        if (index !== -1) this.pool.splice(index, 1);
      });
      this.pool.push(selected);
    }

    selected.activeContexts += 1;
    selected.totalUses += 1;

    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      selected.activeContexts = Math.max(0, selected.activeContexts - 1);

      if (selected.totalUses >= MAX_USES_PER_BROWSER && selected.activeContexts === 0 && !selected.closing) {
        selected.closing = true;
        const index = this.pool.indexOf(selected);
        if (index !== -1) this.pool.splice(index, 1);
        state.activeBrowsers.delete(selected.browser);
        await selected.browser.close().catch(() => {});
      }
    };

    return {
      browser: selected.browser,
      release,
    };
  }

  async closeAll() {
    const entries = [...this.pool];
    this.pool = [];
    for (const entry of entries) {
      state.activeBrowsers.delete(entry.browser);
      await entry.browser.close().catch(() => {});
    }
  }
}

const browserPool = new BrowserPool();

async function getSharedBrowser() {
  return browserPool.acquire();
}

const PREWARMED_POOL_SIZE = Math.max(0, Number(process.env.PREWARMED_POOL_SIZE || 2));
const PREWARMED_MAX_AGE_MS = 90000;
const prewarmedPages = [];
let replenishingPrewarmed = false;

async function setupResourceBlocking(context) {
  await context.route("**/*", (route) => {
    const resourceType = route.request().resourceType();
    const url = route.request().url().toLowerCase();
    if (
      resourceType === "image" ||
      resourceType === "font" ||
      resourceType === "media" ||
      resourceType === "stylesheet" ||
      url.includes("google-analytics") ||
      url.includes("googletagmanager") ||
      url.includes("tiktok") ||
      url.includes("facebook") ||
      url.includes("twitter") ||
      url.includes("clarity") ||
      url.includes("datadog") ||
      url.includes("amplitude") ||
      url.includes("sentry") ||
      url.includes("hotjar") ||
      url.includes("doubleclick") ||
      url.includes("criteo")
    ) {
      return route.abort();
    }

    return route.continue();
  });
}

async function prepareOnePrewarmedPage() {
  const proxy = proxyManager.getPlaywrightProxy();
  const { browser, release } = await browserPool.acquire();
  const contextOptions = {
    viewport: { width: 800, height: 600 },
    serviceWorkers: "block",
  };
  if (proxy) {
    contextOptions.proxy = proxy;
  }

  const context = await browser.newContext(contextOptions);

  if (BLOCK_HEAVY_RESOURCES) {
    await setupResourceBlocking(context);
  }

  const page = await context.newPage();
  page.on("dialog", (dialog) => {
    dialog.dismiss().catch(() => {});
  });

  const headerCaptureState = { headers: null, jwt: "", hexToken: "", refreshToken: "" };

  page.on("request", (request) => {
    try {
      const url = request.url();
      if (!url.includes("api.webook.com") && !url.includes("webook.com")) return;
      const headers = request.headers();
      const auth = String(headers.authorization || headers.Authorization || "").trim();
      if (/^bearer\s+ey/i.test(auth)) {
        const rawJwt = auth.replace(/^bearer\s+/i, "").trim();
        if (isUsableToken(rawJwt)) {
          headerCaptureState.jwt = rawJwt;
          const normalized = normalizeLiveApiHeaders(headers, null);
          if (normalized) {
            headerCaptureState.headers = normalized;
          }
          if (headers.token && isUsableToken(headers.token)) {
            headerCaptureState.hexToken = headers.token;
          }
        }
      }
    } catch {}
  });

  page.on("response", async (response) => {
    const url = response.url();
    if (url.includes("api.webook.com")) {
      try {
        const reqHeaders = await response.request().allHeaders();
        const auth = String(reqHeaders.authorization || reqHeaders.Authorization || "").trim();
        if (/^bearer\s+ey/i.test(auth)) {
          const rawJwt = auth.replace(/^bearer\s+/i, "").trim();
          if (isUsableToken(rawJwt)) {
            headerCaptureState.jwt = rawJwt;
            const normalized = normalizeLiveApiHeaders(reqHeaders, null);
            if (normalized) {
              headerCaptureState.headers = normalized;
            }
            if (reqHeaders.token && isUsableToken(reqHeaders.token)) {
              headerCaptureState.hexToken = reqHeaders.token;
            }
          }
        }
      } catch {}
    }

    if (url.includes("/login") || url.includes("/token") || url.includes("/auth")) {
      try {
        const body = await response.json().catch(() => null);
        if (body) {
          const data = body.data || body;
          const token = data.token || data.access_token || data.jwt || "";
          if (token && isUsableToken(token)) {
            headerCaptureState.jwt = String(token).replace(/^bearer\s+/i, "").trim();
          }
          const hex = data.hex_token || data.token_hex || data.app_token || "";
          if (hex && isUsableToken(hex)) {
            headerCaptureState.hexToken = String(hex).trim();
          }
          const refresh = data.refresh_token || data.refreshToken || "";
          if (refresh && isUsableToken(refresh)) {
            headerCaptureState.refreshToken = String(refresh).trim();
          }
        }
      } catch {}
    }
  });

  try {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: LOGIN_TIMEOUT_MS });
    await assertNoSecurityChallenge(page);
    await handleCookieConsent(page, { maxWaitMs: 1200 });
  } catch (err) {
    if (proxy) {
      proxyManager.reportProxyFailure(proxy, err);
    }
    await context.close().catch(() => {});
    await release().catch(() => {});
    throw err;
  }

  return {
    context,
    page,
    release,
    proxy,
    headerCaptureState,
    createdAt: Date.now(),
  };
}

async function replenishPrewarmedPages() {
  if (replenishingPrewarmed || state.stopping || PREWARMED_POOL_SIZE <= 0) {
    return;
  }
  replenishingPrewarmed = true;

  try {
    while (prewarmedPages.length < PREWARMED_POOL_SIZE && !state.stopping) {
      const item = await prepareOnePrewarmedPage();
      prewarmedPages.push(item);
    }
  } catch (err) {
    logger.warn("loginQueue", "Could not pre-warm login page", { error: err.message });
  } finally {
    replenishingPrewarmed = false;
  }
}

async function acquireLoginPage() {

  while (prewarmedPages.length > 0) {
    const item = prewarmedPages.shift();
    const age = Date.now() - item.createdAt;
    if (age < PREWARMED_MAX_AGE_MS && item.page && !item.page.isClosed()) {
      setTimeout(() => replenishPrewarmedPages().catch(() => {}), 100);
      return { ...item, isPrewarmed: true };
    }

    await item.context.close().catch(() => {});
    await item.release().catch(() => {});
  }

  const item = await prepareOnePrewarmedPage();
  setTimeout(() => replenishPrewarmedPages().catch(() => {}), 100);
  return { ...item, isPrewarmed: false };
}

async function attemptOneLogin(email, password, signal) {
  signal?.throwIfAborted();
  const pageItem = await acquireLoginPage();
  const { context, page, release, headerCaptureState, proxy } = pageItem;
  const abortLogin = () => { void context.close().catch(() => {}); };
  signal?.addEventListener("abort", abortLogin, { once: true });

  const loginApiState = { error: null };
  const onResponse = async (response) => {
    const url = response.url().toLowerCase();
    if (
      url.includes("/login") ||
      url.includes("/auth") ||
      url.includes("/token") ||
      url.includes("/signin")
    ) {
      const status = response.status();
      try {
        const body = await response.json().catch(() => null);
        if (body && (body.status === "error" || body.error || body.errors || (status >= 400 && status < 500))) {
          const rawMsg = body.error || body.errors || body.message || body.msg || "";
          const msg = typeof rawMsg === "object" ? Object.values(rawMsg).flat().join(" ") : String(rawMsg);
          loginApiState.error = {
            status,
            message: msg || `Login request failed with status ${status}`,
            isPermanent: status === 401 || status === 422 || /password|email|credential|غير صحيحة|حظر|blocked/i.test(msg),
          };
        }
      } catch {}
    }
  };
  page.on("response", onResponse);

  try {
    signal?.throwIfAborted();
    try {
      await executeTwoStepLogin(page, email, password, loginApiState);
    } catch (error) {
      signal?.throwIfAborted();
      if (shouldStopLoginRetry(error.loginFailureCode)) {
        throw error;
      }

      logger.warn("loginQueue", "Retrying login submit", { email, error: error.message });
      await handleCookieConsent(page, { maxWaitMs: 800 });
      await executeTwoStepLogin(page, email, password, loginApiState);
    }

    const storageState = await waitForAuthenticatedSession(page, context, LOGIN_TIMEOUT_MS, loginApiState, headerCaptureState);

    const captureDeadline = Date.now() + 2000;
    while (
      (!headerCaptureState || !headerCaptureState.jwt) &&
      Date.now() < captureDeadline
    ) {
      await page.waitForTimeout(100);
    }

    let liveCapturedHeaders = headerCaptureState ? headerCaptureState.headers : null;

    if (!liveCapturedHeaders || !liveCapturedHeaders.authorization || (!headerCaptureState || !headerCaptureState.jwt)) {
      try {
        const captured = await captureLiveAuthHeaders(page, storageState);
        if (captured && (captured.authorization || captured.token)) {
          liveCapturedHeaders = captured;
        }
      } catch (error) {
        logger.warn("loginQueue", "Could not capture live API headers", { email, error: error.message });
      }
    }

    const jwt = (
      (headerCaptureState && headerCaptureState.jwt) ||
      (liveCapturedHeaders && liveCapturedHeaders.authorization && liveCapturedHeaders.authorization.replace(/^bearer\s+/i, "")) ||
      extractAuthToken(storageState) ||
      ""
    ).trim();

    const capturedHex = String(
      (headerCaptureState && headerCaptureState.hexToken) ||
      (liveCapturedHeaders && liveCapturedHeaders.token) ||
      ""
    ).trim();
    const hexToken = capturedHex && capturedHex !== jwt && isUsableToken(capturedHex) ? capturedHex : "";
    const refreshToken = String(
      (headerCaptureState && headerCaptureState.refreshToken) ||
      extractRefreshToken(storageState) ||
      ""
    ).trim();

    let liveHeaders = liveCapturedHeaders || buildApiHeaders(storageState, { jwt, hexToken });
    if (liveHeaders) {
      if (jwt && !liveHeaders.authorization) {
        liveHeaders.authorization = `Bearer ${jwt}`;
      }
      if (hexToken && !liveHeaders.token) {
        liveHeaders.token = hexToken;
      }
    }

    if (!jwt || !isUsableToken(jwt)) {
      throw new Error("Login finished without a usable JWT token.");
    }

    return {
      result: {
        storageState,
        jwt,
        hexToken,
        refreshToken,
        liveHeaders,
        tokenExpiresAt: decodeJwtExpiry(jwt),
      },
      proxy,
    };
  } catch (err) {
    if (proxy) {
      err.proxy = proxy;
    }
    throw err;
  } finally {
    signal?.removeEventListener("abort", abortLogin);
    await context.close().catch(() => {});
    await release().catch(() => {});
  }
}

async function performLogin(email, password, signal) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_PROXY_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted();
    try {
      const { result, proxy } = await attemptOneLogin(email, password, signal);
      if (proxy) {
        proxyManager.reportProxySuccess(proxy);
      }
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      lastError = error;

      if (error.proxy) {
        proxyManager.reportProxyFailure(error.proxy, error);
      }

      if (shouldStopLoginRetry(error.loginFailureCode)) {
        throw error;
      }

      if (attempt < MAX_PROXY_ATTEMPTS) {
        logger.warn("loginQueue", `Login attempt ${attempt}/${MAX_PROXY_ATTEMPTS} failed with IP error. Roulette failover to next proxy...`, {
          email,
          error: error.message,
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  throw lastError;
}

async function queueLoginJob(owner, accountId) {
  return loginControl.run(owner, (signal) => enqueueLoginJob(owner, accountId, signal));
}

async function enqueueLoginJob(owner, accountId, signal) {
  const ownerId = String(owner ?? "").trim();
  if (!ownerId) {
    throw new Error("owner is required to queue a login job.");
  }
  if (!accountId) {
    throw new Error("accountId is required to queue a login job.");
  }

  await connectDb();
  signal.throwIfAborted();

  const account = await Account.findOne({ _id: accountId, owner: ownerId }).exec();
  if (!account) {
    throw new Error(`Account ${accountId} was not found for owner ${ownerId}.`);
  }

  const existing = await LoginJob.findOne({
    accountId: account._id,
    status: { $in: ["queued", "processing"] },
  }).exec();

  if (existing) {
    return existing;
  }

  const job = await LoginJob.create({
    owner: ownerId,
    accountId: account._id,
    status: "queued",
    maxAttempts: Math.max(1, Number(process.env.LOGIN_QUEUE_MAX_ATTEMPTS || 3)),
  });
  signal.throwIfAborted();

  if (account.status !== "linked") {
    account.status = "pending";
    await account.save().catch(() => {});
  }

  logger.info("loginQueue", "Queued login job", { owner: ownerId, email: account.email, jobId: String(job._id) });
  return job;
}

async function getQueueStatus(owner) {
  await connectDb();

  const filter = {};
  const ownerId = String(owner ?? "").trim();
  if (ownerId) {
    filter.owner = ownerId;
  }

  const rows = await LoginJob.aggregate([{ $match: filter }, { $group: { _id: "$status", count: { $sum: 1 } } }]).exec();

  const counts = { queued: 0, processing: 0, done: 0, failed: 0, cancelled: 0 };
  for (const row of rows) {
    if (row && row._id in counts) {
      counts[row._id] = row.count;
    }
  }

  return {
    ...counts,
    total: counts.queued + counts.processing + counts.done + counts.failed + counts.cancelled,
    workerRunning: state.running,
    activeJobs: state.activeJobs,
  };
}

function setLoginNotifier(notifier) {
  state.notifier = typeof notifier === "function" ? notifier : null;
}

async function recordJobOutcome(owner, ok, detail = null) {
  const key = String(owner ?? "").trim();
  if (!key) {
    return;
  }
  if (loginControl.isPaused(key)) return;

  const entry = state.progressByOwner.get(key) || {
    completed: 0,
    succeeded: 0,
    failed: 0,
    notified: 0,
    finalized: false,
    failedAccounts: [],
  };
  entry.completed += 1;
  if (ok) {
    entry.succeeded += 1;
  } else {
    entry.failed += 1;
    if (detail && detail.email) {
      entry.failedAccounts.push({
        email: detail.email,
        error: detail.error || "Login failed",
      });
    }
  }
  state.progressByOwner.set(key, entry);

  let pending = 0;
  try {
    pending = await LoginJob.countDocuments({ owner: key, status: { $in: ["queued", "processing"] } }).exec();
  } catch (error) {
    logger.warn("loginQueue", "Could not count pending jobs", { owner: key, error: error.message });
  }

  const finished = pending === 0;
  const hitMilestone = entry.completed - entry.notified >= NOTIFY_EVERY;
  if (!finished && !hitMilestone) {
    return;
  }

  if (finished) {
    if (entry.finalized) {
      return;
    }
    entry.finalized = true;
  }

  entry.notified = entry.completed;
  const snapshot = {
    owner: key,
    completed: entry.completed,
    succeeded: entry.succeeded,
    failed: entry.failed,
    pending,
    total: entry.completed + pending,
    finished,
    failedAccounts: [...(entry.failedAccounts || [])],
  };

  if (finished) {
    state.progressByOwner.delete(key);
  }

  if (!state.notifier) {
    return;
  }

  Promise.resolve().then(() => state.notifier?.(snapshot)).catch((error) => {
    logger.warn("loginQueue", "Login progress notifier failed", { owner: key, error: error.message });
  });
}

async function claimQueuedJobs(limit = BATCH_SIZE) {
  const claimed = [];

  for (let index = 0; index < limit; index += 1) {
    const job = await LoginJob.findOneAndUpdate(
      { status: "queued" },
      { $set: { status: "processing", startedAt: new Date(), error: "" }, $inc: { attempts: 1 } },
      { sort: { createdAt: 1 }, returnDocument: "after" },
    ).exec();

    if (!job) {
      break;
    }

    claimed.push(job);
  }

  return claimed;
}

async function requeueStaleJobs() {
  const cutoff = new Date(Date.now() - STALE_PROCESSING_MS);
  const result = await LoginJob.updateMany(
    { status: "processing", startedAt: { $lt: cutoff } },
    { $set: { status: "queued", startedAt: null, error: "Requeued after stale processing state." } },
  ).exec();

  if (result && result.modifiedCount) {
    logger.warn("loginQueue", "Requeued stale processing jobs", { count: result.modifiedCount });
  }
}

async function markJobFailed(job, account, message) {
  const error = String(message || "Unknown login error").slice(0, 1000);
  const isBanned =
    /blocked due to malicious activity|تم حظر الحساب|تم حظرك|account.*blocked|حساب.*محظور|تم إيقاف الحساب|account has been locked/i.test(error);

  if (account && isBanned) {
    logger.warn("loginQueue", "Auto-removing banned account from database", {
      email: account.email,
      reason: error,
    });
    job.status = "failed";
    job.error = `Auto-removed: ${error}`;
    job.completedAt = new Date();
    await job.save().catch(() => {});
    await Account.removeBannedAccount(account._id);
    await recordJobOutcome(job.owner, false, {
      email: account.email,
      error: "Auto-removed: Account is blocked by Webook.",
      action: "removed-banned",
    });
    return;
  }

  if (!account) {
    job.status = "failed";
    job.error = error;
    job.completedAt = new Date();
    await job.save().catch((saveError) => {
      logger.error("loginQueue", "Could not persist failed job", { jobId: String(job._id), error: saveError.message });
    });
    return;
  }

  account.retryCount = Number(account.retryCount || 0) + 1;
  account.lastError = error;
  account.lastCheckAt = new Date();

  if (account.retryCount < Number(job.maxAttempts || 3)) {

    job.status = "queued";
    job.startedAt = null;
    job.error = error;
    await job.save().catch((saveError) => {
      logger.error("loginQueue", "Could not requeue existing job", { jobId: String(job._id), error: saveError.message });
    });

    account.status = "pending";
    await account.save().catch(async (saveErr) => {
      if (saveErr.code === 11000 || String(saveErr.message).includes("E11000")) {
        await Account.deleteOne({ _id: account._id }).catch(() => {});
      }
    });
    logger.warn("loginQueue", "Login failed, requeued", {
      email: account.email,
      retryCount: account.retryCount,
      maxAttempts: job.maxAttempts,
      error,
    });
    return;
  }

  job.status = "failed";
  job.error = error;
  job.completedAt = new Date();
  await job.save().catch((saveError) => {
    logger.error("loginQueue", "Could not persist failed job", { jobId: String(job._id), error: saveError.message });
  });

  account.status = "failed";
  await account.save().catch(async (saveError) => {
    if (saveError.code === 11000 || String(saveError.message).includes("E11000")) {
      await Account.deleteOne({ _id: account._id }).catch(() => {});
    } else {
      logger.error("loginQueue", "Could not persist failed account", {
        accountId: String(account._id),
        error: saveError.message,
      });
    }
  });

  logger.error("loginQueue", "Login failed permanently", {
    email: account.email,
    retryCount: account.retryCount,
    error,
  });

  await recordJobOutcome(job.owner, false, {
    email: (account && account.email) || "unknown",
    error,
  });
}

async function processJob(job) {

  if (loginControl.isPaused(job.owner)) return;
  return loginControl.run(job.owner, (signal) => processActiveJob(job, signal));
}

async function processActiveJob(job, signal) {
  state.activeJobs += 1;
  let account = null;

  try {
    account = await Account.findById(job.accountId).exec();
    signal.throwIfAborted();
    const stillProcessing = await LoginJob.exists({ _id: job._id, status: "processing" });
    signal.throwIfAborted();
    if (!stillProcessing) return;
    if (!account) {
      job.status = "failed";
      job.error = "Account no longer exists.";
      job.completedAt = new Date();
      await job.save().catch(() => {});
      await recordJobOutcome(job.owner, false, {
        email: "unknown",
        error: "Account no longer exists.",
      });
      return;
    }

    const cleanEmail = sanitizeAccountUsername(account.email).toLowerCase();
    if (account.email !== cleanEmail) {
      const existing = await Account.findOne({
        owner: account.owner,
        email: cleanEmail,
        _id: { $ne: account._id },
      }).exec();

      if (existing) {
        logger.warn("loginQueue", "Found duplicate account with clean email, merging into existing", {
          dirtyAccountId: String(account._id),
          existingAccountId: String(existing._id),
          cleanEmail,
        });
        await Account.deleteOne({ _id: account._id }).catch(() => {});
        account = existing;
        job.accountId = existing._id;
        await job.save().catch(() => {});
      } else {
        account.email = cleanEmail;
        await account.save().catch((err) => {
          logger.warn("loginQueue", "Could not sanitize email on account", {
            accountId: String(account._id),
            cleanEmail,
            error: err.message,
          });
        });
      }
    }

    if (!cleanEmail || !cleanEmail.includes("@") || !cleanEmail.includes(".") || cleanEmail.endsWith(".") || cleanEmail.length < 5) {
      account.retryCount = Number(job.maxAttempts || 3);
      await markJobFailed(job, account, "Incorrect email or password.");
      return;
    }

    const password = account.getPassword();
    if (!password) {
      account.retryCount = Number(job.maxAttempts || 3);
      await markJobFailed(job, account, "Stored password could not be decrypted.");
      return;
    }

    account.status = "linking";
    account.lastError = "";
    await account.save().catch(() => {});

    signal.throwIfAborted();
    const result = await performLogin(account.email, password, signal);
    signal.throwIfAborted();

    account.jwt = result.jwt;
    account.hexToken = result.hexToken;
    account.refreshToken = result.refreshToken;
    account.tokenExpiresAt = result.tokenExpiresAt;
    if (result.liveHeaders) {
      account.liveApiHeaders = result.liveHeaders;
      account.liveApiHeadersCapturedAt = new Date().toISOString();
    }
    account.setSessionData(result.storageState);
    account.status = "linked";
    account.linkedAt = new Date();
    account.lastCheckAt = new Date();
    account.lastError = "";
    account.retryCount = 0;

    try {
      await account.save();
    } catch (saveErr) {
      if (saveErr.code === 11000 || String(saveErr.message).includes("E11000")) {
        logger.warn("loginQueue", "E11000 duplicate detected on account save, merging into existing", {
          email: account.email,
          owner: account.owner,
        });
        const existing = await Account.findOne({
          owner: account.owner,
          email: account.email,
          _id: { $ne: account._id },
        }).exec();
        if (existing) {
          existing.jwt = account.jwt;
          existing.hexToken = account.hexToken;
          existing.refreshToken = account.refreshToken;
          existing.tokenExpiresAt = account.tokenExpiresAt;
          existing.liveApiHeaders = account.liveApiHeaders;
          existing.liveApiHeadersCapturedAt = account.liveApiHeadersCapturedAt;
          existing.sessionData = account.sessionData;
          existing.status = "linked";
          existing.linkedAt = new Date();
          existing.lastCheckAt = new Date();
          existing.lastError = "";
          existing.retryCount = 0;
          await existing.save();
          await Account.deleteOne({ _id: account._id }).catch(() => {});
          job.accountId = existing._id;
          account = existing;
        } else {
          throw saveErr;
        }
      } else {
        throw saveErr;
      }
    }

    job.status = "done";
    job.error = "";
    job.completedAt = new Date();
    await job.save();

    logger.success("loginQueue", "Account linked", {
      email: account.email,
      owner: job.owner,
      hasHexToken: Boolean(result.hexToken),
    });

    await recordJobOutcome(job.owner, true);
  } catch (error) {

    if (signal.aborted) return;
    const message = (error && error.message) || String(error);

    if (account && shouldStopLoginRetry(error && error.loginFailureCode)) {

      account.retryCount = Math.max(Number(account.retryCount || 0), Number(job.maxAttempts || 3));
    }

    await markJobFailed(job, account, message);
  } finally {
    state.activeJobs -= 1;
  }
}

async function cancelOwnerLoginJobs(owner) {
  const ownerId = String(owner);
  return loginControl.stop(ownerId, async () => {
    await connectDb();
    const jobs = await LoginJob.find({ owner: ownerId, status: { $in: ["queued", "processing"] } })
      .select("accountId").lean().exec();
    await LoginJob.updateMany(
      { owner: ownerId, status: { $in: ["queued", "processing"] } },
      { $set: { status: "cancelled", error: "Cancelled by user.", completedAt: new Date() } },
    ).exec();
    await Account.updateMany(
      { owner: ownerId, _id: { $in: jobs.map((job) => job.accountId) }, status: { $in: ["pending", "linking"] } },
      { $set: { status: "failed", lastError: "Cancelled by user." } },
    ).exec();
    state.progressByOwner.delete(ownerId);
    return jobs.length;
  });
}

async function claimNextQueuedJob() {
  return LoginJob.findOneAndUpdate(
    { status: "queued" },
    { $set: { status: "processing", startedAt: new Date(), error: "" }, $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, returnDocument: "after" },
  ).exec();
}

async function continuousWorker(workerIndex) {
  while (!state.stopping) {
    let job = null;
    try {
      job = await claimNextQueuedJob();
    } catch (err) {
      logger.error("loginQueue", "Error claiming next job", { workerIndex, error: err.message });
    }

    if (!job) {
      await sleep(IDLE_POLL_MS);
      continue;
    }

    try {
      await processJob(job);
    } catch (error) {
      logger.error("loginQueue", "Unhandled job error", { workerIndex, jobId: String(job._id), error: error.message });
    }
  }
}

async function workerLoop() {

  const maintenanceInterval = setInterval(() => {
    if (state.stopping) {
      clearInterval(maintenanceInterval);
      return;
    }
    requeueStaleJobs().catch((err) => {
      logger.warn("loginQueue", "Error during stale jobs check", { error: err.message });
    });
  }, 30000);

  await requeueStaleJobs().catch(() => {});

  logger.info("loginQueue", "Starting persistent worker pool", { concurrency: CONCURRENCY });
  const workerPromises = Array.from({ length: CONCURRENCY }, (_, i) => continuousWorker(i + 1));

  try {
    await Promise.all(workerPromises);
  } finally {
    clearInterval(maintenanceInterval);
    state.running = false;
    logger.info("loginQueue", "Login worker pool stopped");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupDirtyAccountEmails() {
  try {
    const accounts = await Account.find({}).exec();
    for (const acc of accounts) {
      const clean = sanitizeAccountUsername(acc.email).toLowerCase();
      if (acc.email !== clean) {
        const existing = await Account.findOne({ owner: acc.owner, email: clean, _id: { $ne: acc._id } }).exec();
        if (existing) {
          if (acc.jwt && !existing.jwt) {
            existing.jwt = acc.jwt;
            existing.hexToken = acc.hexToken;
            existing.refreshToken = acc.refreshToken;
            existing.sessionData = acc.sessionData;
            existing.liveApiHeaders = acc.liveApiHeaders;
            existing.status = acc.status;
            await existing.save().catch(() => {});
          }
          await LoginJob.updateMany({ accountId: acc._id }, { $set: { accountId: existing._id } }).exec();
          await Account.deleteOne({ _id: acc._id }).exec();
          logger.info("loginQueue", "Merged dirty email account into existing clean account", {
            owner: acc.owner,
            dirty: acc.email,
            clean,
          });
        } else {
          acc.email = clean;
          await acc.save().catch(() => {});
          logger.info("loginQueue", "Sanitized dirty email on account", {
            owner: acc.owner,
            clean,
          });
        }
      }
    }
  } catch (err) {
    logger.warn("loginQueue", "Error cleaning up dirty account emails", { error: err.message });
  }
}

async function startLoginWorker() {
  if (state.running) {
    return { started: false };
  }

  await connectDb();
  await cleanupDirtyAccountEmails().catch(() => {});
  bindShutdownSignals();

  state.running = true;
  state.stopping = false;
  state.loopPromise = workerLoop();

  void replenishPrewarmedPages().catch(() => {});

  logger.success("loginQueue", "Login worker started", {
    concurrency: CONCURRENCY,
    pollMs: IDLE_POLL_MS,
    prewarmedPoolSize: PREWARMED_POOL_SIZE,
  });

  return { started: true };
}

async function stopLoginWorker() {
  if (!state.running && state.activeBrowsers.size === 0) {
    return;
  }

  state.stopping = true;

  const prewarmed = [...prewarmedPages];
  prewarmedPages.length = 0;
  for (const item of prewarmed) {
    await item.context.close().catch(() => {});
    await item.release().catch(() => {});
  }

  await browserPool.closeAll().catch(() => {});

  const browsers = [...state.activeBrowsers];
  state.activeBrowsers.clear();
  await Promise.all(browsers.map((browser) => browser.close().catch(() => {})));

  if (state.loopPromise) {
    await state.loopPromise.catch(() => {});
    state.loopPromise = null;
  }

  state.running = false;
}

function bindShutdownSignals() {
  if (state.signalsBound) {
    return;
  }

  state.signalsBound = true;

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      logger.warn("loginQueue", `Received ${signal}, closing browsers`, { activeBrowsers: state.activeBrowsers.size });
      stopLoginWorker()
        .catch(() => {})
        .finally(() => {
          process.exit(0);
        });
    });
  }
}

module.exports = {
  cancelOwnerLoginJobs,
  loginControl,
  browserPool,
  getQueueStatus,
  getSharedBrowser,
  performLogin,
  queueLoginJob,
  setLoginNotifier,
  startLoginWorker,
  stopLoginWorker,
};
