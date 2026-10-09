const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium, request } = require("playwright");
const { loadSession } = require("./sessionManager");
const { areAccessTokensExpired, buildApiHeaders, getAuthSummary, hasAuthMarkers, isUsableToken } = require("./webookAuth");
const logger = require("./logger");
const { assertNoSecurityChallenge } = require("./websiteVerification");

const BASE_URL = "https://api.webook.com";
const API_TIMEOUT_MS = Math.max(5000, Number(process.env.WEBBOOK_API_TIMEOUT_MS || 15000));
const FETCH_PAGE_URL = process.env.WEBBOOK_FETCH_PAGE_URL || "https://webook.com/en";
const includePastBookings = String(process.env.WEBBOOK_INCLUDE_PAST_BOOKINGS || "false").toLowerCase() === "true";
const ORDER_DETAIL_CONCURRENCY = Math.max(1, Number(process.env.ORDER_DETAIL_CONCURRENCY || 8));
const TICKET_OWNERSHIP_OVERRIDES_FILE = path.resolve(
  process.cwd(),
  process.env.WEBBOOK_TICKET_OWNERSHIP_OVERRIDES_FILE || "data/ticket-ownership-overrides.json",
);

const BOOKING_ENDPOINTS = [
  "/api/v2/user/bookings?lang=en&event_status=upcoming&page=1&show_payment_link=true&hide_vapps=true",
  "/api/v2/halayalla/booking-history?lang=en&event_status=upcoming&page=1",
  "/api/v2/user/bookings-season?lang=en&season_status=upcoming&page=1",
  ...(includePastBookings
    ? [
        "/api/v2/user/bookings?lang=en&event_status=past&page=1&show_payment_link=true&hide_vapps=true",
        "/api/v2/halayalla/booking-history?lang=en&event_status=past&page=1",
      ]
    : []),
];

const AUX_ENDPOINTS = ["/api/v2/subscriptions/user_subscriptions?lang=en&status=active"];

const ORDER_DETAIL_ENDPOINT_BUILDERS = [
  (id) => `/api/v2/order/${id}/event?lang=en`,
  (id) => `/api/v2/order/${id}?lang=en`,
  (id) => `/api/v2/orders/${id}?lang=en`,
];

const TICKET_PATH_KEYS = new Set(["tickets_details", "ticket_details", "ticketsdetails", "tickets"]);
const LIVE_HEADER_BLOCKLIST = new Set(["cookie", "host", "content-length", "connection"]);

async function mapWithConcurrency(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    return [];
  }

  const limit = Math.max(1, Math.min(Number(concurrency) || 1, list.length));
  const results = new Array(list.length);
  let cursor = 0;

  const runners = Array.from({ length: limit }, () =>
    (async () => {
      while (true) {
        const currentIndex = cursor;
        cursor += 1;
        if (currentIndex >= list.length) {
          return;
        }

        results[currentIndex] = await worker(list[currentIndex], currentIndex);
      }
    })(),
  );

  await Promise.all(runners);
  return results;
}

function walk(value, cb, path = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, cb, [...path, index]));
    return;
  }

  if (value && typeof value === "object") {
    cb(value, path);
    for (const [key, next] of Object.entries(value)) {
      walk(next, cb, [...path, key]);
    }
  }
}

function asText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function normalizeLiveApiHeaders(headers, storageState, options = {}) {
  const normalized = {};
  if (headers && typeof headers === "object" && !Array.isArray(headers)) {
    for (const [rawKey, rawValue] of Object.entries(headers)) {
      const key = asText(rawKey).trim().toLowerCase();
      const value = asText(rawValue).trim();
      if (!key || !value || key.startsWith(":") || LIVE_HEADER_BLOCKLIST.has(key)) {
        continue;
      }

      normalized[key] = value;
    }
  }

  const baseHeaders = buildApiHeaders(storageState, options);
  for (const [key, value] of Object.entries(baseHeaders)) {
    if (!normalized[key] && value) {
      normalized[key] = value;
    }
  }

  if (!normalized.authorization && normalized.token && isUsableToken(normalized.token)) {
    normalized.authorization = /^bearer\s/i.test(normalized.token) ? normalized.token : `Bearer ${normalized.token}`;
  }

  if (normalized.token && normalized.authorization) {
    const rawAuth = normalized.authorization.replace(/^bearer\s+/i, "").trim();
    if (normalized.token === rawAuth) {
      delete normalized.token;
    }
  }

  if (!normalized.authorization) {
    return null;
  }

  return normalized;
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return [value];
  return [];
}

function getFirstValue(obj, keys) {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") {
      return obj[key];
    }
  }
  return undefined;
}

function normalizeField(value) {
  const text = asText(value).trim();
  return text || "-";
}

function normalizeTime(value) {
  if (!value) return "-";

  const text = asText(value).trim();
  if (!text) return "-";

  if (/^\d{10}$/.test(text)) return new Date(Number(text) * 1000).toISOString();
  if (/^\d{13}$/.test(text)) return new Date(Number(text)).toISOString();
  return text;
}

function normalizeEmail(value) {
  const text = asText(value).trim().toLowerCase();
  if (!text) {
    return "";
  }

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text : "";
}

function parseNumberLike(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function parseBooleanLike(value) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  const text = asText(value).trim().toLowerCase();
  if (!text) {
    return null;
  }

  if (["true", "yes", "y", "1", "transferred", "transfered", "resold", "resell", "sold"].includes(text)) {
    return true;
  }

  if (["false", "no", "n", "0", "active", "owned"].includes(text)) {
    return false;
  }

  return null;
}

function looksLikeTransferredStatus(value) {
  if (value === null || value === undefined) {
    return false;
  }

  const text = asText(value).trim().toLowerCase();
  if (!text) {
    return false;
  }

  return (
    /(?:^|[_\s-])(transfer|transferred|transfered|resell|resold|sold|assigned|recipient|for_sale|sale)(?:$|[_\s-])/i.test(
      text,
    ) || ["transfer", "transferred", "transfered", "resell", "resold", "sold", "assigned", "recipient"].includes(text)
  );
}

function collectEmailHints(value, path = [], hints = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectEmailHints(item, [...path, index], hints));
    return hints;
  }

  if (value && typeof value === "object") {
    for (const [key, next] of Object.entries(value)) {
      collectEmailHints(next, [...path, key], hints);
    }
    return hints;
  }

  const email = normalizeEmail(value);
  if (email) {
    hints.push({
      email,
      path: path.map((part) => String(part).toLowerCase()),
    });
  }

  return hints;
}

function analyzeFragmentOwnership(obj, ownerEmail) {
  const normalizedOwnerEmail = normalizeEmail(ownerEmail);
  const hints = collectEmailHints(obj);
  const recipientTokens = ["recipient", "buyer", "assign", "assignee", "shared", "share", "transfer"];
  const ownerTokens = ["owner", "holder", "account", "user", "member", "customer"];
  let hasOwnerMatch = false;
  let hasExplicitOtherOwner = false;
  let hasExplicitOtherRecipient = false;
  let hasTransferFlag = false;

  if (obj && typeof obj === "object") {
    for (const [rawKey, rawValue] of Object.entries(obj)) {
      const key = String(rawKey || "")
        .trim()
        .toLowerCase();
      if (!key) {
        continue;
      }

      if (
        key.includes("transfer") ||
        key.includes("recipient") ||
        key.includes("assign") ||
        key.includes("assignee") ||
        key.includes("shared")
      ) {
        const parsed = parseBooleanLike(rawValue);
        if (parsed === true) {
          hasTransferFlag = true;
        }
      }

      if (key.includes("status")) {
        const statusText = asText(rawValue).trim().toLowerCase();
        if (looksLikeTransferredStatus(statusText)) {
          hasTransferFlag = true;
        }
      }
    }
  }

  for (const hint of hints) {
    const pathText = hint.path.join(".");
    const isRecipientPath = recipientTokens.some((token) => pathText.includes(token));
    const isOwnerPath = ownerTokens.some((token) => pathText.includes(token));

    if (normalizedOwnerEmail && hint.email === normalizedOwnerEmail) {
      hasOwnerMatch = true;
      continue;
    }

    if (isRecipientPath) {
      hasExplicitOtherRecipient = true;
      continue;
    }

    if (isOwnerPath) {
      hasExplicitOtherOwner = true;
    }
  }

  return {
    hasOwnerMatch,
    hasExplicitOtherOwner,
    hasExplicitOtherRecipient,
    hasTransferFlag,
  };
}

function buildSeatKey(section, row, seat) {
  return [normalizeField(section), normalizeField(row), normalizeField(seat)].join("|");
}

function normalizeOverrideSeatKey(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    const text = value.trim();
    if (!text) {
      return "";
    }

    const parts = text.split("|");
    if (parts.length === 3) {
      return buildSeatKey(parts[0], parts[1], parts[2]);
    }

    return text;
  }

  if (typeof value === "object") {
    return buildSeatKey(value.section, value.row, value.seat);
  }

  return "";
}

function normalizeTicketOwnershipOverrideRule(rule, fallbackOrderId = "") {
  if (!rule || typeof rule !== "object") {
    return null;
  }

  const orderId =
    asText(getFirstValue(rule, ["orderId", "bookingId", "order_id", "booking_id"])).trim() || fallbackOrderId;
  if (!orderId) {
    return null;
  }

  const ticketIds = [
    ...new Set(
      toArray(rule.ticketIds || rule.ticket_ids || rule.tickets)
        .map((value) => asText(value).trim())
        .filter(Boolean),
    ),
  ];
  const seatKeys = [
    ...new Set(
      toArray(rule.seatKeys || rule.seat_keys || rule.seats)
        .map(normalizeOverrideSeatKey)
        .filter(Boolean),
    ),
  ];

  if (ticketIds.length === 0 && seatKeys.length === 0) {
    return null;
  }

  return {
    orderId,
    ownerEmail: normalizeEmail(getFirstValue(rule, ["ownerEmail", "email", "owner_email"])),
    ticketIds,
    seatKeys,
  };
}

async function loadTicketOwnershipOverrideRules() {
  try {
    const content = await fs.readFile(TICKET_OWNERSHIP_OVERRIDES_FILE, "utf8");
    const parsed = JSON.parse(content);

    let rawRules = [];
    if (Array.isArray(parsed)) {
      rawRules = parsed;
    } else if (parsed && Array.isArray(parsed.rules)) {
      rawRules = parsed.rules;
    } else if (parsed && parsed.orders && typeof parsed.orders === "object") {
      rawRules = Object.entries(parsed.orders).map(([orderId, value]) => ({
        ...(value && typeof value === "object" ? value : {}),
        orderId,
      }));
    }

    return rawRules.map((rule) => normalizeTicketOwnershipOverrideRule(rule)).filter(Boolean);
  } catch {
    return [];
  }
}

function findTicketOwnershipOverride(rules, ownerEmail, orderId) {
  const normalizedOwnerEmail = normalizeEmail(ownerEmail);

  for (const rule of toArray(rules)) {
    if (!rule || rule.orderId !== orderId) {
      continue;
    }

    if (!rule.ownerEmail || !normalizedOwnerEmail || rule.ownerEmail === normalizedOwnerEmail) {
      return rule;
    }
  }

  return null;
}

function applyTicketOwnershipOverride(rows, override) {
  if (!override) {
    return {
      rows,
      applied: false,
      matchedCount: 0,
    };
  }

  const ticketIds = new Set(
    toArray(override.ticketIds)
      .map((value) => asText(value).trim())
      .filter(Boolean),
  );
  const seatKeys = new Set(toArray(override.seatKeys).map(normalizeOverrideSeatKey).filter(Boolean));
  const matched = rows.filter((row) => {
    if (ticketIds.size > 0 && ticketIds.has(row.data.ticketId)) {
      return true;
    }

    if (seatKeys.size > 0 && seatKeys.has(row.seatKey)) {
      return true;
    }

    return false;
  });

  if (matched.length === 0) {
    return {
      rows,
      applied: false,
      matchedCount: 0,
    };
  }

  return {
    rows: matched,
    applied: true,
    matchedCount: matched.length,
  };
}

function mergeSummarySeatHints(currentHints, nextHints) {
  const merged = [];
  const seen = new Set();

  for (const hint of [...toArray(currentHints), ...toArray(nextHints)]) {
    if (!hint || typeof hint !== "object") {
      continue;
    }

    const section = normalizeField(hint.section);
    const row = normalizeField(hint.row);
    const seat = normalizeField(hint.seat);
    const seatKey = buildSeatKey(section, row, seat);
    if (seatKey === "-|-|-" || seen.has(seatKey)) {
      continue;
    }

    seen.add(seatKey);
    merged.push({ section, row, seat });
  }

  return merged;
}

function normalizeCategory(value) {
  const text = asText(value).trim();
  if (!text) return "-";

  const catMatch = text.match(/cat\s*[-_ ]?\s*(\d+)/i);
  if (catMatch) {
    return `cat${catMatch[1]}`;
  }

  const numericMatch = text.match(/^\d+$/);
  if (numericMatch) {
    return `cat${numericMatch[0]}`;
  }

  return text.replace(/\s+/g, " ");
}

function sortTickets(rows) {
  return [...rows].sort((left, right) => {
    const leftKey = [left.time, left.eventName, left.section, left.row, left.seat, left.ticketId].join("|");
    const rightKey = [right.time, right.eventName, right.section, right.row, right.seat, right.ticketId].join("|");
    return leftKey.localeCompare(rightKey);
  });
}

function mergeBookingMeta(current, next) {
  if (!current) {
    return {
      summarySeatHints: [],
      summaryTicketCount: null,
      detailOwnerEmail: "",
      isTransferredOrder: false,
      ...next,
      summarySeatHints: mergeSummarySeatHints([], next && next.summarySeatHints),
      detailOwnerEmail: normalizeEmail(next && next.detailOwnerEmail),
      isTransferredOrder: next && next.isTransferredOrder === true,
    };
  }

  return {
    orderId: current.orderId || next.orderId,
    eventName:
      current.eventName && current.eventName !== "unknown_event"
        ? current.eventName
        : next.eventName || "unknown_event",
    time: current.time && current.time !== "-" ? current.time : next.time || "-",
    ticketCount:
      Number.isFinite(current.ticketCount) && current.ticketCount >= 0
        ? current.ticketCount
        : Number.isFinite(next.ticketCount) && next.ticketCount >= 0
          ? next.ticketCount
          : null,
    hasTransferredTickets: current.hasTransferredTickets === true || next.hasTransferredTickets === true,
    summarySeatHints: mergeSummarySeatHints(current.summarySeatHints, next.summarySeatHints),
    summaryTicketCount:
      Number.isFinite(current.summaryTicketCount) && current.summaryTicketCount >= 0
        ? current.summaryTicketCount
        : Number.isFinite(next.summaryTicketCount) && next.summaryTicketCount >= 0
          ? next.summaryTicketCount
          : null,
    detailOwnerEmail: normalizeEmail(current.detailOwnerEmail) || normalizeEmail(next.detailOwnerEmail),
    isTransferredOrder: current.isTransferredOrder === true || next.isTransferredOrder === true,
  };
}

function looksLikeBookingObject(obj, path) {
  const lowerKeys = Object.keys(obj).map((key) => key.toLowerCase());
  const lowerPath = path.map((part) => String(part).toLowerCase());
  const endsInsideEvent = lowerPath.includes("event");
  const hasTopLevelEvent = lowerKeys.includes("event");
  const hasDirectBookingKeys =
    lowerKeys.includes("booking_id") ||
    lowerKeys.includes("order_id") ||
    lowerKeys.includes("payment_status") ||
    lowerKeys.includes("event_status") ||
    lowerKeys.includes("tickets_count");
  const hasIdentifier = lowerKeys.includes("_id") || lowerKeys.includes("id") || lowerKeys.includes("order_id");

  return hasIdentifier && !endsInsideEvent && (hasTopLevelEvent || hasDirectBookingKeys);
}

function normalizeBookingMeta(obj) {
  const orderId = asText(getFirstValue(obj, ["order_id", "booking_id", "_id", "id"])).trim();
  if (!orderId) {
    return null;
  }

  const eventObj = obj.event && typeof obj.event === "object" ? obj.event : {};
  const eventName =
    asText(getFirstValue(obj, ["event_title", "event_name", "title", "name"])).trim() ||
    asText(getFirstValue(eventObj, ["title", "event_title", "name"])).trim() ||
    "unknown_event";

  const time = normalizeTime(
    getFirstValue(obj, ["event_time", "start_date_time", "start_time", "date"]) ||
      getFirstValue(eventObj, ["start_date_time", "event_time", "start_time", "date"]),
  );

  const rawPrice = getFirstValue(obj, [
    "price",
    "ticket_price",
    "total_price",
    "total_amount",
    "amount",
    "cost",
  ]);
  const rawCurrency = getFirstValue(obj, ["currency", "currency_code", "ticket_currency"]);
  let bookingPrice = "-";
  if (rawPrice !== null && rawPrice !== undefined && rawPrice !== "") {
    const num = Number(rawPrice);
    bookingPrice = Number.isFinite(num) ? num : String(rawPrice).trim();
  }

  return {
    orderId,
    eventName,
    time,
    price: bookingPrice,
    currency: rawCurrency ? String(rawCurrency).trim().toUpperCase() : "",
    ticketCount: parseNumberLike(
      getFirstValue(obj, ["total_tickets", "tickets_count", "ticket_count", "ticketCount", "ticketsCount"]),
    ),
    hasTransferredTickets:
      parseBooleanLike(getFirstValue(obj, ["has_transfered_tickets", "has_transferred_tickets"])) === true,
    summarySeatHints: [],
    summaryTicketCount: null,
    detailOwnerEmail: "",
    isTransferredOrder: false,
  };
}

function parseOrderDetailMeta(payload, fallbackOrderId) {
  const root = payload && payload.data && typeof payload.data === "object" ? payload.data : payload;
  if (!root || typeof root !== "object") {
    return null;
  }

  const orderId = asText(getFirstValue(root, ["order_id", "booking_id", "_id", "id"])).trim() || fallbackOrderId;
  if (!orderId) {
    return null;
  }

  const summarySeatHints = [];
  let summaryTicketCount = 0;
  let hasSummaryQty = false;

  for (const item of toArray(root.summary)) {
    for (const ticket of toArray(item && item.tickets)) {
      if (!ticket || typeof ticket !== "object") {
        continue;
      }

      const section = getFirstValue(ticket, ["section", "section_name", "zone", "area", "seat_section"]);
      const row = getFirstValue(ticket, ["row", "row_no", "row_number", "seat_row"]);
      const seat = getFirstValue(ticket, ["seat", "seat_no", "seat_number", "seat_label"]);
      if (normalizeField(section) !== "-" || normalizeField(row) !== "-" || normalizeField(seat) !== "-") {
        summarySeatHints.push({ section, row, seat });
      }

      const qty = parseNumberLike(getFirstValue(ticket, ["qty", "quantity", "count", "tickets_count", "ticket_count"]));
      if (Number.isFinite(qty) && qty > 0) {
        summaryTicketCount += qty;
        hasSummaryQty = true;
      }
    }
  }

  return {
    orderId,
    summarySeatHints,
    summaryTicketCount: hasSummaryQty ? summaryTicketCount : null,
    detailOwnerEmail: normalizeEmail(root.user && root.user.email),
    isTransferredOrder: parseBooleanLike(getFirstValue(root, ["is_transfered", "is_transferred"])) === true,
  };
}

function parseBookingMetadata(payload) {
  const metaByOrder = new Map();
  const directCandidates = [
    ...toArray(payload && payload.data),
    ...toArray(payload && payload.items),
    ...toArray(payload && payload.summary),
    ...toArray(payload && payload.data && payload.data.items),
  ];

  for (const item of directCandidates) {
    if (!item || typeof item !== "object" || !looksLikeBookingObject(item, [])) {
      continue;
    }

    const meta = normalizeBookingMeta(item);
    if (meta) {
      metaByOrder.set(meta.orderId, mergeBookingMeta(metaByOrder.get(meta.orderId), meta));
    }
  }

  if (metaByOrder.size > 0) {
    return [...metaByOrder.values()];
  }

  walk(payload, (obj, path) => {
    if (!looksLikeBookingObject(obj, path)) {
      return;
    }

    const meta = normalizeBookingMeta(obj);
    if (meta) {
      metaByOrder.set(meta.orderId, mergeBookingMeta(metaByOrder.get(meta.orderId), meta));
    }
  });

  return [...metaByOrder.values()];
}

function buildTicketFragment(obj, path, fallbackOrderId, options = {}) {
  const lowerPath = path.map((part) => String(part).toLowerCase());
  const sourceRank = lowerPath.includes("tickets_details") || lowerPath.includes("ticket_details") ? 3 : 2;
  const section = normalizeField(getFirstValue(obj, ["section", "section_name", "zone", "area", "seat_section"]));
  const row = normalizeField(getFirstValue(obj, ["row", "row_no", "row_number", "seat_row"]));
  const seat = normalizeField(getFirstValue(obj, ["seat", "seat_no", "seat_number", "seat_label"]));
  const ticketId = normalizeField(getFirstValue(obj, ["ticket_id", "reservation_id", "_id", "id"]));
  const orderId = normalizeField(getFirstValue(obj, ["order_id", "booking_id", "reservation_id"])) || fallbackOrderId;
  const category = normalizeCategory(
    getFirstValue(obj, [
      "ticket_category_en",
      "ticket_category",
      "ticket_category_ar",
      "event_ticket_category_en",
      "event_ticket_category",
      "event_ticket_category_ar",
      "category_title_en",
      "category_title",
      "category_title_ar",
      "event_ticket_title_en",
      "event_ticket_title",
      "event_ticket_title_ar",
      "title_en",
      "title",
      "title_ar",
      "category_name",
      "category",
    ]),
  );
  const eventName = normalizeField(
    getFirstValue(obj, ["event_title", "event_name", "title", "name", "match_name", "season_name"]),
  );
  const time = normalizeTime(
    getFirstValue(obj, ["event_time", "event_date", "start_date_time", "start_time", "date", "datetime"]),
  );

  const rawPrice = getFirstValue(obj, [
    "price",
    "ticket_price",
    "final_price",
    "unit_price",
    "seat_price",
    "original_price",
    "total_price",
    "amount",
    "cost",
    "fee",
  ]);
  const rawCurrency = getFirstValue(obj, [
    "currency",
    "ticket_currency",
    "currency_code",
    "wallet_currency",
  ]);

  let price = "-";
  if (rawPrice !== null && rawPrice !== undefined && rawPrice !== "") {
    const num = Number(rawPrice);
    price = Number.isFinite(num) ? num : String(rawPrice).trim();
  }
  const currency = rawCurrency ? String(rawCurrency).trim().toUpperCase() : "";

  const hasSeatData = section !== "-" || row !== "-" || seat !== "-";
  if (!hasSeatData && ticketId === "-") {
    return null;
  }

  const ownership = analyzeFragmentOwnership(obj, options.ownerEmail);

  return {
    orderId: orderId === "-" ? fallbackOrderId || "-" : orderId,
    ticketId,
    section,
    row,
    seat,
    category,
    price,
    currency,
    eventName: eventName === "-" ? "unknown_event" : eventName,
    time,
    sourcePath: path.join("."),
    sourceRank,
    hasOwnerMatch: ownership.hasOwnerMatch,
    hasExplicitOtherOwner: ownership.hasExplicitOtherOwner,
    hasExplicitOtherRecipient: ownership.hasExplicitOtherRecipient,
    hasTransferFlag: ownership.hasTransferFlag,
  };
}

function dedupeTicketFragments(fragments) {
  const seen = new Set();
  const out = [];

  for (const fragment of fragments) {
    const key = [
      fragment.orderId,
      fragment.ticketId,
      fragment.section,
      fragment.row,
      fragment.seat,
      fragment.category,
      fragment.eventName,
      fragment.time,
    ].join("|");
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    out.push(fragment);
  }

  return out;
}

function shouldIgnoreTicketPath(lowerPath) {
  const hasSummary = lowerPath.includes("summary");
  const hasPlainTickets = lowerPath.includes("tickets");
  const hasDetailTickets =
    lowerPath.includes("tickets_details") ||
    lowerPath.includes("ticket_details") ||
    lowerPath.includes("ticketsdetails");

  return hasSummary && hasPlainTickets && !hasDetailTickets;
}

function collectTicketFragments(payload, fallbackOrderId, requireTicketPath, options = {}) {
  const fragments = [];
  let fragmentIndex = 0;

  walk(payload, (obj, path) => {
    const lowerPath = path.map((part) => String(part).toLowerCase());
    const isInsideTicketPath = lowerPath.some((part) => TICKET_PATH_KEYS.has(part));

    const collectionIndex = lowerPath.findLastIndex((part) => TICKET_PATH_KEYS.has(part));
    if (isInsideTicketPath && lowerPath.length - collectionIndex > 2) {
      return;
    }
    if (requireTicketPath && !isInsideTicketPath) {
      return;
    }
    if (shouldIgnoreTicketPath(lowerPath)) {
      return;
    }

    const fragment = buildTicketFragment(obj, path, fallbackOrderId, options);
    if (!fragment) {
      return;
    }

    if (!requireTicketPath) {
      const hasSeatData = fragment.section !== "-" || fragment.row !== "-" || fragment.seat !== "-";
      if (!hasSeatData) {
        return;
      }
    }

    fragment.firstSeenIndex = fragmentIndex;
    fragmentIndex += 1;
    fragments.push(fragment);
  });

  return dedupeTicketFragments(fragments);
}

function parseOrderTicketFragments(payload, fallbackOrderId, options = {}) {
  const strict = collectTicketFragments(payload, fallbackOrderId, true, options);
  if (strict.length > 0) {
    return strict;
  }

  return collectTicketFragments(payload, fallbackOrderId, false, options);
}

function mergeTicketFragment(current, next) {
  if (!current) {
    return {
      ...next,
      fragmentCount: 1,
    };
  }

  current.fragmentCount += 1;
  if (
    (current.ticketId === "-" && next.ticketId !== "-") ||
    (next.ticketId !== "-" && (next.sourceRank || 0) > (current.sourceRank || 0))
  ) {
    current.ticketId = next.ticketId;
  }
  if (current.section === "-" && next.section !== "-") current.section = next.section;
  if (current.row === "-" && next.row !== "-") current.row = next.row;
  if (current.seat === "-" && next.seat !== "-") current.seat = next.seat;
  if (current.category === "-" && next.category !== "-") current.category = next.category;
  if (current.eventName === "unknown_event" && next.eventName !== "unknown_event") current.eventName = next.eventName;
  if (current.time === "-" && next.time !== "-") current.time = next.time;
  if ((current.price === "-" || !current.price) && next.price && next.price !== "-") {
    current.price = next.price;
  }
  if (!current.currency && next.currency) {
    current.currency = next.currency;
  }
  current.sourceRank = Math.max(current.sourceRank || 0, next.sourceRank || 0);
  current.firstSeenIndex = Math.min(Number(current.firstSeenIndex || 0), Number(next.firstSeenIndex || 0));
  current.hasOwnerMatch = current.hasOwnerMatch || next.hasOwnerMatch;
  current.hasExplicitOtherOwner = current.hasExplicitOtherOwner || next.hasExplicitOtherOwner;
  current.hasExplicitOtherRecipient = current.hasExplicitOtherRecipient || next.hasExplicitOtherRecipient;
  current.hasTransferFlag = current.hasTransferFlag || next.hasTransferFlag;
  return current;
}

function compareTrimCandidates(left, right) {
  const leftOwnerRank = left.hasOwnerMatch ? 1 : 0;
  const rightOwnerRank = right.hasOwnerMatch ? 1 : 0;
  if (leftOwnerRank !== rightOwnerRank) {
    return rightOwnerRank - leftOwnerRank;
  }

  const leftTransferRank = left.hasTransferFlag ? 0 : 1;
  const rightTransferRank = right.hasTransferFlag ? 0 : 1;
  if (leftTransferRank !== rightTransferRank) {
    return rightTransferRank - leftTransferRank;
  }

  const leftSourceRank = Number(left.sourceRank || 0);
  const rightSourceRank = Number(right.sourceRank || 0);
  if (leftSourceRank !== rightSourceRank) {
    return rightSourceRank - leftSourceRank;
  }

  const leftFirstSeen = Number.isFinite(Number(left.firstSeenIndex))
    ? Number(left.firstSeenIndex)
    : Number.MAX_SAFE_INTEGER;
  const rightFirstSeen = Number.isFinite(Number(right.firstSeenIndex))
    ? Number(right.firstSeenIndex)
    : Number.MAX_SAFE_INTEGER;
  if (leftFirstSeen !== rightFirstSeen) {
    return leftFirstSeen - rightFirstSeen;
  }

  const leftKey = [left.data.ticketId, left.data.section, left.data.row, left.data.seat].join("|");
  const rightKey = [right.data.ticketId, right.data.section, right.data.row, right.data.seat].join("|");
  return leftKey.localeCompare(rightKey, undefined, { numeric: true });
}

function isAmbiguousTransferredOrder(rows, meta) {
  const expectedCount =
    meta && Number.isFinite(meta.ticketCount) && meta.ticketCount >= 0 ? Number(meta.ticketCount) : null;
  if (expectedCount === null || rows.length <= expectedCount) {
    return false;
  }

  const transferred = meta && (meta.hasTransferredTickets === true || meta.isTransferredOrder === true);
  if (!transferred) {
    return false;
  }

  return !rows.some((row) => row.hasOwnerMatch || row.hasTransferFlag);
}

function trimExcessDetailRows(rows, meta) {
  const expectedCount =
    meta && Number.isFinite(meta.ticketCount) && meta.ticketCount >= 0 ? Number(meta.ticketCount) : null;
  if (expectedCount === null || rows.length <= expectedCount) {
    return {
      rows,
      trimmedCount: 0,
      ambiguousTransferred: false,
    };
  }

  if (isAmbiguousTransferredOrder(rows, meta)) {
    return {
      rows: [],
      trimmedCount: rows.length,
      ambiguousTransferred: true,
    };
  }

  const shouldTrim =
    meta &&
    (meta.hasTransferredTickets === true ||
      meta.isTransferredOrder === true ||
      (Number.isFinite(meta.summaryTicketCount) && meta.summaryTicketCount === expectedCount));
  if (!shouldTrim) {
    return {
      rows,
      trimmedCount: 0,
      ambiguousTransferred: false,
    };
  }

  const chosen = [];
  const seenKeys = new Set();

  const pushRow = (row) => {
    if (!row || chosen.length >= expectedCount || seenKeys.has(row.internalKey)) {
      return;
    }

    chosen.push(row);
    seenKeys.add(row.internalKey);
  };

  const remainingRows = [...rows].sort(compareTrimCandidates);
  for (const row of remainingRows) {
    pushRow(row);
  }

  return {
    rows: chosen,
    trimmedCount: Math.max(0, rows.length - chosen.length),
    ambiguousTransferred: false,
  };
}

function extractWalletProfileSignals(payload) {
  const merged = {
    walletBalance: null,
    deviceVerified: null,
    walletCurrency: "",
  };
  let balancePriority = -1;

  const getBalancePriority = (key) => {
    const normalized = key.replace(/[^a-z0-9]/g, "");
    if (normalized === "totalbalance") return 100;
    if (normalized === "walletbalance") return 90;
    if (normalized === "availablebalance") return 80;
    if (normalized === "withdrawableamount") return 70;
    if (normalized === "balance") return 60;
    return -1;
  };

  walk(payload, (obj) => {
    if (!obj || typeof obj !== "object") {
      return;
    }

    for (const [rawKey, rawValue] of Object.entries(obj)) {
      const key = String(rawKey || "").trim().toLowerCase();
      if (!key) {
        continue;
      }

      const priority = getBalancePriority(key);
      const numberValue = priority >= 0 ? parseNumberLike(rawValue) : null;
      if (numberValue !== null && priority > balancePriority) {
        merged.walletBalance = numberValue;
        balancePriority = priority;
      }

      if (key === "currency" || key === "wallet_currency") {
        if (typeof rawValue === "string" && rawValue.trim()) {
          merged.walletCurrency = rawValue.trim().toUpperCase();
        }
      }

      if (key.includes("verified") || key.includes("device") || key.includes("auth")) {
        const parsed = parseBooleanLike(rawValue);
        if (parsed !== null) {
          merged.deviceVerified = parsed;
        }
      }
    }
  });

  return merged;
}

function normalizeDetailRows(orderMetaMap, rawFragments, options = {}) {
  const byTicket = new Map();
  const normalizedOwnerEmail = normalizeEmail(options.ownerEmail);
  const ticketOwnershipOverrides = toArray(options.ticketOwnershipOverrides);

  for (const fragment of rawFragments) {
    const hasSeatData = fragment.section !== "-" || fragment.row !== "-" || fragment.seat !== "-";
    const ticketKeyBase = hasSeatData
      ? `seat:${fragment.section}|${fragment.row}|${fragment.seat}`
      : `id:${fragment.ticketId}`;
    const ticketKey = `${fragment.orderId}::${ticketKeyBase}`;
    byTicket.set(ticketKey, mergeTicketFragment(byTicket.get(ticketKey), fragment));
  }

  let mergedRowCount = 0;
  let filteredTransferredCount = 0;
  let trimmedDetailRowCount = 0;
  let trimmedOrderCount = 0;
  let ambiguousTransferredOrderCount = 0;
  let ambiguousTransferredRowCount = 0;
  let ownershipOverrideOrderCount = 0;
  let ownershipOverrideRowCount = 0;
  const detailRows = [];
  const detailRowsByOrder = new Map();

  for (const row of byTicket.values()) {
    mergedRowCount += Math.max(0, row.fragmentCount - 1);
    if (
      normalizedOwnerEmail &&
      (row.hasExplicitOtherRecipient || (!row.hasOwnerMatch && row.hasExplicitOtherOwner) || row.hasTransferFlag)
    ) {
      filteredTransferredCount += 1;
      continue;
    }

    const meta = orderMetaMap.get(row.orderId);
    const ticketRow = {
      internalKey: `${row.orderId}::${buildSeatKey(row.section, row.row, row.seat)}::${row.ticketId || "-"}`,
      seatKey: buildSeatKey(row.section, row.row, row.seat),
      hasOwnerMatch: row.hasOwnerMatch,
      hasTransferFlag: row.hasTransferFlag,
      sourceRank: row.sourceRank || 0,
      firstSeenIndex: Number(row.firstSeenIndex || 0),
      data: {
        orderId: row.orderId,
        ticketId: row.ticketId || "-",
        eventName:
          meta && meta.eventName && meta.eventName !== "unknown_event"
            ? meta.eventName
            : row.eventName || "unknown_event",
        time: meta && meta.time && meta.time !== "-" ? meta.time : row.time || "-",
        section: row.section || "-",
        row: row.row || "-",
        seat: row.seat || "-",
        category: row.category || "-",
        price: row.price !== undefined && row.price !== null && row.price !== "-"
          ? row.price
          : (meta && meta.price !== undefined && meta.price !== null ? meta.price : "-"),
        currency: row.currency || (meta && meta.currency ? meta.currency : ""),
      },
    };

    if (!detailRowsByOrder.has(row.orderId)) {
      detailRowsByOrder.set(row.orderId, []);
    }
    detailRowsByOrder.get(row.orderId).push(ticketRow);
  }

  for (const [orderId, rows] of detailRowsByOrder.entries()) {
    const meta = orderMetaMap.get(orderId);
    const ownershipOverride = findTicketOwnershipOverride(ticketOwnershipOverrides, normalizedOwnerEmail, orderId);
    const overridden = applyTicketOwnershipOverride(rows, ownershipOverride);
    if (overridden.applied) {
      ownershipOverrideOrderCount += 1;
      ownershipOverrideRowCount += overridden.matchedCount;
    }

    const trimmed = trimExcessDetailRows(overridden.rows, meta);
    if (trimmed.ambiguousTransferred) {
      ambiguousTransferredOrderCount += 1;
      ambiguousTransferredRowCount += overridden.rows.length;
    } else if (trimmed.trimmedCount > 0) {
      trimmedDetailRowCount += trimmed.trimmedCount;
      trimmedOrderCount += 1;
    }

    detailRows.push(...trimmed.rows.map((row) => row.data));
  }

  return {
    detailRows: sortTickets(detailRows),
    mergedRowCount,
    filteredTransferredCount,
    trimmedDetailRowCount,
    trimmedOrderCount,
    ambiguousTransferredOrderCount,
    ambiguousTransferredRowCount,
    ownershipOverrideOrderCount,
    ownershipOverrideRowCount,
  };
}

function addPlaceholderRows(orderMetaMap, detailRows) {
  const ordersWithDetails = new Set(detailRows.map((row) => row.orderId).filter(Boolean));
  const placeholders = [];

  for (const [orderId, meta] of orderMetaMap.entries()) {
    if (ordersWithDetails.has(orderId)) {
      continue;
    }

    placeholders.push({
      orderId,
      ticketId: "-",
      eventName: meta.eventName || "unknown_event",
      time: meta.time || "-",
      section: "-",
      row: "-",
      seat: "-",
      category: "-",
      price: meta.price !== undefined && meta.price !== null ? meta.price : "-",
      currency: meta.currency || "",
    });
  }

  return sortTickets([...detailRows, ...placeholders]);
}

async function createBrowserFetchSession(storageState, options = {}) {
  let browser, release;
  try {
    const { getSharedBrowser } = require("./loginQueue");
    const pooled = await getSharedBrowser();
    browser = pooled.browser;
    release = pooled.release;
  } catch {
    browser = await chromium.launch({
      headless: true,
      chromiumSandbox: false,
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
        "--mute-audio",
      ],
    });
    release = async () => browser.close().catch(() => {});
  }

  const browserContextOptions = {
    viewport: { width: 800, height: 600 },
    userAgent:
      process.env.API_CLIENT_USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  };
  try {
    const { getPlaywrightProxy } = require("./apiClient");
    const proxy = getPlaywrightProxy();
    if (proxy) {
      browserContextOptions.proxy = proxy;
    }
  } catch {}
  if (storageState && typeof storageState === "object" && (Array.isArray(storageState.cookies) || Array.isArray(storageState.origins))) {
    browserContextOptions.storageState = storageState;
  }

  let context, page, capturedHeaders;
  try {
    context = await browser.newContext(browserContextOptions);
    page = await context.newPage();
    capturedHeaders = await captureLiveAuthHeaders(page, storageState, options);
  } catch (error) {
    if (context) await context.close().catch(() => {});
    if (typeof release === "function") await release().catch(() => {});
    throw error;
  }

  return {
    mode: "browser",
    liveHeaders: capturedHeaders,
    async get(urlPath) {
      const direct = await fetchJsonFromBrowserContext(context, urlPath, capturedHeaders);
      if (direct && direct.ok) {
        return direct;
      }

      if (page && !page.isClosed()) {
        try {
          const inPage = await page.evaluate(
            async ({ targetUrl, headers }) => {
              try {
                const res = await fetch(targetUrl, {
                  headers,
                  credentials: "include",
                });
                const ok = res.ok;
                const status = res.status;
                let data = null;
                try {
                  data = await res.json();
                } catch {
                  data = null;
                }
                return { ok, status, data, error: ok ? "" : `HTTP ${status}` };
              } catch (err) {
                return { ok: false, status: 0, data: null, error: String(err) };
              }
            },
            { targetUrl: `${BASE_URL}${urlPath}`, headers: capturedHeaders },
          );

          if (inPage && inPage.status > 0) {
            return {
              ...inPage,
              url: `${BASE_URL}${urlPath}`,
            };
          }
        } catch {}
      }

      return direct;
    },
    async dispose() {
      await context.close().catch(() => {});
      if (typeof release === "function") {
        await release().catch(() => {});
      }
    },
  };
}

async function captureLiveAuthHeaders(page, storageState, options = {}) {
  let liveHeaders = null;

  page.on("response", async (response) => {
    if (liveHeaders) {
      return;
    }

    const url = response.url();
    if (!url.includes("api.webook.com")) {
      return;
    }

    try {
      const headers = await response.request().allHeaders();
      const auth = headers.authorization || headers.Authorization;
      if (!auth || !auth.toLowerCase().startsWith("bearer ey")) {
        return;
      }

      const normalized = normalizeLiveApiHeaders(headers, storageState, options);
      if (!normalized) {
        return;
      }

      liveHeaders = normalized;
    } catch {

    }
  });

  try {
    await page.goto(FETCH_PAGE_URL, { waitUntil: "domcontentloaded", timeout: 8000 });
  } catch {}

  await assertNoSecurityChallenge(page);
  const deadline = Date.now() + 1500;
  while (!liveHeaders && Date.now() < deadline) {
    await page.waitForTimeout(100);
  }

  await assertNoSecurityChallenge(page);
  const fallbackHeaders = buildApiHeaders(storageState, options);
  return liveHeaders || fallbackHeaders;
}

async function fetchJsonFromBrowserContext(context, urlPath, headers = {}) {
  let response;
  try {
    response = await context.request.get(`${BASE_URL}${urlPath}`, {
      failOnStatusCode: false,
      headers,
      timeout: API_TIMEOUT_MS,
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: String(error),
      url: `${BASE_URL}${urlPath}`,
    };
  }

  const status = response.status();
  let data = null;

  try {
    data = await response.json();
  } catch {
    data = null;
  }

  return {
    ok: response.ok(),
    status,
    data,
    url: `${BASE_URL}${urlPath}`,
  };
}

async function createApiFetchSession(storageState, options = {}) {
  const normalizedHeaders = normalizeLiveApiHeaders(options.headers, storageState, options);
  const extraHeaders = normalizedHeaders || buildApiHeaders(storageState, options);
  if (!extraHeaders["user-agent"]) {
    extraHeaders["user-agent"] =
      process.env.API_CLIENT_USER_AGENT ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
  }

  if (!extraHeaders.cookie && storageState && Array.isArray(storageState.cookies) && storageState.cookies.length > 0) {
    const cookieHeader = storageState.cookies
      .filter((c) => c && c.name && c.value)
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    if (cookieHeader) {
      extraHeaders.cookie = cookieHeader;
    }
  }

  let effectiveStorageState = storageState;
  if (storageState && Array.isArray(storageState.cookies)) {
    effectiveStorageState = {
      ...storageState,
      cookies: storageState.cookies.map((c) => {
        const domain = String(c.domain || "").toLowerCase();
        if (domain === "webook.com" || domain === ".webook.com") {
          return { ...c, domain: ".webook.com" };
        }
        return c;
      }),
    };
  }

  const contextOptions = {
    baseURL: BASE_URL,
    extraHTTPHeaders: extraHeaders,
    ignoreHTTPSErrors: true,
  };
  try {
    const { getPlaywrightProxy } = require("./apiClient");
    const proxy = getPlaywrightProxy();
    if (proxy) {
      contextOptions.proxy = proxy;
    }
  } catch {}
  if (effectiveStorageState && typeof effectiveStorageState === "object" && (Array.isArray(effectiveStorageState.cookies) || Array.isArray(effectiveStorageState.origins))) {
    contextOptions.storageState = effectiveStorageState;
  }

  const apiContext = await request.newContext(contextOptions);

  return {
    mode: options.mode || (normalizedHeaders ? "api-live-headers" : "api-request"),
    liveHeaders: extraHeaders,
    async get(urlPath) {
      return fetchJsonFromApiContext(apiContext, urlPath);
    },
    async dispose() {
      await apiContext.dispose();
    },
  };
}

async function createFetchSession(storageState) {
  try {
    return await createBrowserFetchSession(storageState);
  } catch {
    return createApiFetchSession(storageState);
  }
}

async function collectTicketsWithSession(fetchSession, authSummary, options = {}) {
  const probed = [];
  const orderMetaMap = new Map();
  const rawDetailFragments = [];
  let bookingAuthFailureCount = 0;
  let bookingOkCount = 0;
  let bookingRequestFailureCount = 0;
  let detailMissingCount = 0;
  let walletBalance = null;
  let walletCurrency = "";
  let deviceVerified = null;

  const bookingResponses = await Promise.all(
    BOOKING_ENDPOINTS.map(async (endpoint) => {
      const res = await fetchSession.get(endpoint);
      return { endpoint, res };
    }),
  );

  for (const { endpoint, res } of bookingResponses) {
    probed.push({ endpoint, status: res.status, ok: res.ok });

    if (res.status === 401 || res.status === 403) {
      bookingAuthFailureCount += 1;
    }

    if (res.ok) {
      bookingOkCount += 1;
    }

    if (res.status === 0) {
      bookingRequestFailureCount += 1;
    }

    if (!res.ok) {
      logger.warn("tickets", "Booking endpoint probe returned non-OK", {
        endpoint,
        status: res.status,
        error: res.error || (res.data && res.data.message) || null,
        mode: fetchSession.mode,
      });
      continue;
    }

    if (!res.data) {
      continue;
    }

    const rows = parseBookingMetadata(res.data);
    for (const row of rows) {
      orderMetaMap.set(row.orderId, mergeBookingMeta(orderMetaMap.get(row.orderId), row));
    }
  }

  const auxResponses = await Promise.all(
    AUX_ENDPOINTS.map(async (endpoint) => {
      const res = await fetchSession.get(endpoint);
      return { endpoint, res };
    }),
  );
  for (const { endpoint, res } of auxResponses) {
    probed.push({ endpoint, status: res.status, ok: res.ok });
  }

  const walletProfileEndpoints = [
    "/api/v2/user/profile?lang=en",
    "/api/v2/wallet/balance-history?lang=en",
    "/api/v2/wallet/balance?lang=en",
  ];
  const walletResponses = await Promise.all(
    walletProfileEndpoints.map(async (endpoint) => {
      const res = await fetchSession.get(endpoint);
      return { endpoint, res };
    }),
  );
  for (const { endpoint, res } of walletResponses) {
    probed.push({ endpoint, status: res.status, ok: res.ok });
    if (!res.ok || !res.data) {
      continue;
    }

    const signals = extractWalletProfileSignals(res.data);
    if (signals.walletBalance !== null && walletBalance === null) {
      walletBalance = signals.walletBalance;
    }
    if (signals.walletCurrency && !walletCurrency) {
      walletCurrency = signals.walletCurrency;
    }
    if (signals.deviceVerified !== null && deviceVerified === null) {
      deviceVerified = signals.deviceVerified;
    }
  }

  const orderIds = [...orderMetaMap.keys()];
  const orderDetailResults = await mapWithConcurrency(orderIds, ORDER_DETAIL_CONCURRENCY, async (orderId) => {
    for (const buildEndpoint of ORDER_DETAIL_ENDPOINT_BUILDERS) {
      const endpoint = buildEndpoint(orderId);
      const res = await fetchSession.get(endpoint);
      if (!res.ok || !res.data) {
        continue;
      }

      const detailMeta = parseOrderDetailMeta(res.data, orderId);
      if (detailMeta) {
        orderMetaMap.set(orderId, mergeBookingMeta(orderMetaMap.get(orderId), detailMeta));
      }

      const fragments = parseOrderTicketFragments(res.data, orderId, {
        ownerEmail: options.ownerEmail,
      });
      if (fragments.length > 0) {
        return { orderId, endpoint, status: res.status, ok: res.ok, fragments };
      }
    }

    return { orderId, endpoint: "", status: 0, ok: false, fragments: [], missing: true };
  });

  for (const item of orderDetailResults) {
    if (!item) {
      continue;
    }

    if (item.endpoint) {
      probed.push({ endpoint: item.endpoint, status: item.status, ok: item.ok });
    }

    if (Array.isArray(item.fragments) && item.fragments.length > 0) {
      rawDetailFragments.push(...item.fragments);
      continue;
    }

    detailMissingCount += 1;
  }

  const {
    detailRows,
    mergedRowCount,
    filteredTransferredCount,
    trimmedDetailRowCount,
    trimmedOrderCount,
    ambiguousTransferredOrderCount,
    ambiguousTransferredRowCount,
    ownershipOverrideOrderCount,
    ownershipOverrideRowCount,
  } = normalizeDetailRows(orderMetaMap, rawDetailFragments, {
    ownerEmail: options.ownerEmail,
    ticketOwnershipOverrides: options.ticketOwnershipOverrides,
  });
  const tickets = addPlaceholderRows(orderMetaMap, detailRows);

  if (filteredTransferredCount > 0) {
    logger.warn("tickets", "Filtered transferred/non-owned ticket fragments", {
      count: filteredTransferredCount,
      ownerEmail: normalizeEmail(options.ownerEmail) || "-",
    });
  }

  if (trimmedDetailRowCount > 0) {
    logger.warn("tickets", "Trimmed excess order detail rows to booking count", {
      trimmedRows: trimmedDetailRowCount,
      trimmedOrders: trimmedOrderCount,
      ownerEmail: normalizeEmail(options.ownerEmail) || "-",
    });
  }

  if (ambiguousTransferredOrderCount > 0) {
    logger.warn("tickets", "Transferred orders remain ambiguous after filtering", {
      orders: ambiguousTransferredOrderCount,
      rows: ambiguousTransferredRowCount,
      ownerEmail: normalizeEmail(options.ownerEmail) || "-",
    });
  }

  if (ownershipOverrideOrderCount > 0) {
    logger.warn("tickets", "Applied ticket ownership overrides", {
      orders: ownershipOverrideOrderCount,
      rows: ownershipOverrideRowCount,
      ownerEmail: normalizeEmail(options.ownerEmail) || "-",
      file: TICKET_OWNERSHIP_OVERRIDES_FILE,
    });
  }

  const status = summarizeStatus({
    authSummary,
    bookingIdsFound: orderIds.length,
    detailMissingCount,
    bookingAuthFailureCount,
    bookingOkCount,
    bookingRequestFailureCount,
  });

  return {
    status,
    ticketCount: status === "linked-but-unauthorized" ? 0 : tickets.length,
    tickets: status === "linked-but-unauthorized" ? [] : tickets,
    walletBalance,
    walletCurrency,
    deviceVerified,
    probed,
    bookingIdsFound: orderIds.length,
    diagnostics: {
      authSummary,
      detailMissingCount,
      mergedRowCount,
      filteredTransferredCount,
      trimmedDetailRowCount,
      trimmedOrderCount,
      ambiguousTransferredOrderCount,
      ambiguousTransferredRowCount,
      ownershipOverrideOrderCount,
      ownershipOverrideRowCount,
      rawDetailFragmentCount: rawDetailFragments.length,
      normalizedDetailRowCount: detailRows.length,
      bookingAuthFailureCount,
      bookingOkCount,
      bookingRequestFailureCount,
      fetchMode: fetchSession.mode,
    },
  };
}

async function fetchJsonFromApiContext(apiContext, urlPath) {
  let response;
  try {
    response = await apiContext.get(urlPath, {
      failOnStatusCode: false,
      timeout: API_TIMEOUT_MS,
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: String(error),
      url: `${BASE_URL}${urlPath}`,
    };
  }

  const status = response.status();
  let data = null;

  try {
    data = await response.json();
  } catch {
    data = null;
  }

  return {
    ok: response.ok(),
    status,
    data,
    url: `${BASE_URL}${urlPath}`,
  };
}

function summarizeStatus({
  authSummary,
  bookingIdsFound,
  detailMissingCount,
  bookingAuthFailureCount,
  bookingOkCount,
  bookingRequestFailureCount,
}) {
  if (bookingOkCount > 0) {
    if (bookingIdsFound === 0) {
      return "no-bookings-found";
    }
    if (detailMissingCount > 0) {
      return "order-detail-endpoint-missing";
    }
    return "ok";
  }

  const baseUnauthorized = bookingAuthFailureCount > 0;
  if (!authSummary.hasAuthMarkers || baseUnauthorized) {
    return "linked-but-unauthorized";
  }

  if (bookingRequestFailureCount > 0) {
    return "request-failed";
  }

  if (bookingIdsFound === 0) {
    return "no-bookings-found";
  }

  if (detailMissingCount > 0) {
    return "order-detail-endpoint-missing";
  }

  return "ok";
}

let activeBrowserFallbacks = 0;
const MAX_CONCURRENT_BROWSER_FALLBACKS = Math.max(
  2,
  Number(process.env.WEBBOOK_BROWSER_FALLBACK_CONCURRENCY || 5),
);
const browserFallbackWaiters = [];

async function acquireBrowserFallbackSlot() {
  if (activeBrowserFallbacks < MAX_CONCURRENT_BROWSER_FALLBACKS) {
    activeBrowserFallbacks += 1;
    return;
  }
  await new Promise((resolve) => browserFallbackWaiters.push(resolve));
  activeBrowserFallbacks += 1;
}

function releaseBrowserFallbackSlot() {
  activeBrowserFallbacks = Math.max(0, activeBrowserFallbacks - 1);
  if (browserFallbackWaiters.length > 0) {
    const next = browserFallbackWaiters.shift();
    if (typeof next === "function") next();
  }
}

async function fetchTicketsForAccount(accountId, options = {}) {
  const startedAt = Date.now();

  const storageState = options.storageState || (await loadSession(accountId));
  const authSummary = getAuthSummary(storageState, options);
  const ticketOwnershipOverrides = await loadTicketOwnershipOverrideRules();

  const expired = areAccessTokensExpired(storageState, options);
  if (expired || !hasAuthMarkers(storageState, options)) {
    const error = expired ? "Webook login token expired. Re-link this account." : "No stored Webook session or token. Re-link this account.";
    logger.warn("tickets", error, { accountId });
    return {
      accountId,
      status: "linked-but-unauthorized",
      error,
      ticketCount: 0,
      tickets: [],
      probed: [],
      bookingIdsFound: 0,
      diagnostics: {
        authFailureReason: expired ? "expired-token" : "missing-auth",
        authSummary,
        detailMissingCount: 0,
        mergedRowCount: 0,
        filteredTransferredCount: 0,
        trimmedDetailRowCount: 0,
        trimmedOrderCount: 0,
        ambiguousTransferredOrderCount: 0,
        ambiguousTransferredRowCount: 0,
        ownershipOverrideOrderCount: 0,
        ownershipOverrideRowCount: 0,
        rawDetailFragmentCount: 0,
        normalizedDetailRowCount: 0,
        bookingAuthFailureCount: 0,
        bookingOkCount: 0,
        bookingRequestFailureCount: 0,
        fetchMode: "none",
      },
    };
  }

  try {
    let result;
    const savedLiveHeaders = normalizeLiveApiHeaders(options.liveHeaders, storageState, options);

    if (savedLiveHeaders) {
      const savedHeaderSession = await createApiFetchSession(storageState, {
        headers: savedLiveHeaders,
        mode: "api-live-headers",
        ...options,
      });

      try {
        result = await collectTicketsWithSession(savedHeaderSession, authSummary, {
          ...options,
          ticketOwnershipOverrides,
        });
      } finally {
        await savedHeaderSession.dispose();
      }
    } else {
      const apiSession = await createApiFetchSession(storageState, options);

      try {
        result = await collectTicketsWithSession(apiSession, authSummary, {
          ...options,
          ticketOwnershipOverrides,
        });
      } finally {
        await apiSession.dispose();
      }
    }

    if (result.status === "linked-but-unauthorized" || result.status === "request-failed") {
      logger.warn("tickets", "API mode needs browser fallback", {
        accountId,
        status: result.status,
        attemptedMode: result.diagnostics.fetchMode,
        probed: result.probed,
      });
      await acquireBrowserFallbackSlot();
      let browserSession = null;
      try {
        browserSession = await createBrowserFetchSession(storageState, options);
        result = await collectTicketsWithSession(browserSession, authSummary, {
          ...options,
          ticketOwnershipOverrides,
        });
        if (
          result.diagnostics.bookingOkCount > 0 && browserSession.liveHeaders &&
          (browserSession.liveHeaders.authorization || browserSession.liveHeaders.token)
        ) {
          result.liveApiHeaders = browserSession.liveHeaders;
          result.liveApiHeadersCapturedAt = new Date().toISOString();
        }
      } finally {
        if (browserSession) {
          await browserSession.dispose();
        }
        releaseBrowserFallbackSlot();
      }
    }

    const failed = result.status === "linked-but-unauthorized" || result.status === "request-failed";
    logger[failed ? "warn" : "success"]("tickets", failed ? "Account ticket check failed" : "Fetched account tickets", {
      accountId,
      status: result.status,
      tickets: result.ticketCount,
      bookings: result.bookingIdsFound,
      mode: result.diagnostics.fetchMode,
      ms: Date.now() - startedAt,
    });

    return {
      accountId,
      ...result,
    };
  } catch (error) {
    logger.error("tickets", "Ticket fetch failed", {
      accountId,
      error: error.message,
      ms: Date.now() - startedAt,
    });
    throw error;
  }
}

module.exports = {
  captureLiveAuthHeaders,
  fetchTicketsForAccount,
  normalizeLiveApiHeaders,
  __private: {
    addPlaceholderRows,
    extractWalletProfileSignals,
    normalizeLiveApiHeaders,
    normalizeDetailRows,
    parseBookingMetadata,
    parseOrderTicketFragments,
    summarizeStatus,
  },
};
