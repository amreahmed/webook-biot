const fs = require("node:fs/promises");
const path = require("node:path");
const XLSX = require("xlsx");

const REPORTS_DIR = path.resolve(process.cwd(), "data", "reports");

function getPlacementValues(section, row, lang = "ar") {
  return {
    sectionValue: section || "-",
    rowValue: row || "-",
  };
}

function formatDateTime(value, lang = "ar") {
  if (!value || value === "-") {
    return lang === "en" ? "-" : "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(lang === "en" ? "en-GB" : "ar-EG", {
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

function sanitizeFileNamePart(value) {
  return String(value || "report")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
}

function sanitizeWorksheetName(value, fallback = "Section") {
  const sanitized = String(value || fallback)
    .trim()
    .replace(/[\\/?*:[\]]+/g, "_")
    .replace(/^'+|'+$/g, "")
    .slice(0, 31);

  return sanitized || fallback;
}

function getUniqueWorksheetName(value, usedNames) {
  const baseName = sanitizeWorksheetName(value);
  let name = baseName;
  let suffix = 2;

  while (usedNames.has(name.toLowerCase())) {
    const suffixText = `_${suffix}`;
    name = `${baseName.slice(0, 31 - suffixText.length)}${suffixText}`;
    suffix += 1;
  }

  usedNames.add(name.toLowerCase());
  return name;
}

function getCellDisplayLength(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return text.length;
}

function normalizeSortText(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

function compareAlphaNumeric(left, right) {
  const leftText = normalizeSortText(left).toLowerCase();
  const rightText = normalizeSortText(right).toLowerCase();
  if (!leftText && !rightText) {
    return 0;
  }
  if (!leftText) {
    return -1;
  }
  if (!rightText) {
    return 1;
  }

  const leftMatch = leftText.match(/([a-z]+)|([0-9]+)/gi) || [leftText];
  const rightMatch = rightText.match(/([a-z]+)|([0-9]+)/gi) || [rightText];
  const leftParts = leftMatch.map((part) => (/[0-9]/.test(part) ? Number(part) : part.toLowerCase()));
  const rightParts = rightMatch.map((part) => (/[0-9]/.test(part) ? Number(part) : part.toLowerCase()));

  const maxLength = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];

    if (leftPart === undefined) {
      return -1;
    }
    if (rightPart === undefined) {
      return 1;
    }

    if (typeof leftPart === "number" && typeof rightPart === "number") {
      if (leftPart !== rightPart) {
        return leftPart - rightPart;
      }
      continue;
    }

    const comparison = String(leftPart).localeCompare(String(rightPart), undefined, { numeric: true });
    if (comparison !== 0) {
      return comparison;
    }
  }

  return leftText.localeCompare(rightText, undefined, { numeric: true });
}

function applyWorksheetLayout(worksheet, rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const keys = safeRows.length > 0 ? Object.keys(safeRows[0]) : [];

  if (keys.length === 0) {
    return;
  }

  worksheet["!cols"] = keys.map((key) => {
    let columnMax = getCellDisplayLength(key);

    for (const row of safeRows) {
      columnMax = Math.max(columnMax, getCellDisplayLength(row[key]));
    }

    return {

      wch: Math.min(Math.max(columnMax + 1, 4), 80),
    };
  });
}

function widenWorksheetColumns(worksheet, footerMatrix) {
  if (!Array.isArray(footerMatrix) || footerMatrix.length === 0) {
    return;
  }

  const cols = Array.isArray(worksheet["!cols"]) ? [...worksheet["!cols"]] : [];
  const maxByColumn = [];

  for (const row of footerMatrix) {
    const cells = Array.isArray(row) ? row : [];
    for (let index = 0; index < cells.length; index += 1) {
      maxByColumn[index] = Math.max(maxByColumn[index] || 0, getCellDisplayLength(cells[index]));
    }
  }

  for (let index = 0; index < maxByColumn.length; index += 1) {
    const currentWidth = cols[index] && Number(cols[index].wch) ? Number(cols[index].wch) : 0;
    cols[index] = {
      wch: Math.min(Math.max(currentWidth, maxByColumn[index] + 1, 4), 80),
    };
  }

  worksheet["!cols"] = cols;
}

function getStatusLabel(status, lang = "ar") {
  const labels = {
    ok: { ar: "سليم", en: "ok" },
    "no-bookings-found": { ar: "لا توجد حجوزات", en: "no bookings" },
    "linked-but-unauthorized": { ar: "غير مصرح", en: "unauthorized" },
    "order-detail-endpoint-missing": { ar: "تفاصيل ناقصة", en: "missing order details" },
    "request-failed": { ar: "فشل الطلب", en: "request failed" },
    failed: { ar: "فشل", en: "failed" },
  };

  const entry = labels[status] || { ar: status || "-", en: status || "-" };
  return entry[lang === "en" ? "en" : "ar"];
}

function summarizeReport(report) {
  const accounts = Array.isArray(report && report.accounts) ? report.accounts : [];
  let successCount = 0;
  let failedCount = 0;
  let unauthorizedCount = 0;
  let noBookingsCount = 0;
  let totalTickets = 0;

  for (const entry of accounts) {
    if (!entry.ok) {
      failedCount += 1;
      continue;
    }

    totalTickets += Number(entry.result && entry.result.ticketCount ? entry.result.ticketCount : 0);

    if (entry.result && entry.result.status === "linked-but-unauthorized") {
      unauthorizedCount += 1;
      failedCount += 1;
      continue;
    }

    if (entry.result && entry.result.status === "request-failed") {
      failedCount += 1;
      continue;
    }

    if (entry.result && entry.result.status === "no-bookings-found") {
      noBookingsCount += 1;
    }

    successCount += 1;
  }

  return {
    totalAccounts: accounts.length,
    successCount,
    failedCount,
    unauthorizedCount,
    noBookingsCount,
    totalTickets,
  };
}

function collectWorkbookStats(report, lang = "ar") {
  const accounts = Array.isArray(report && report.accounts) ? report.accounts : [];
  const accountsWithTickets = new Set();
  let totalTickets = 0;

  for (const entry of accounts) {
    if (!entry || !entry.ok || !entry.result || !Array.isArray(entry.result.tickets)) {
      continue;
    }

    if (entry.result.tickets.length > 0) {
      accountsWithTickets.add(
        entry.account && (entry.account.username || entry.account.usernameMasked || entry.account.accountId || "-"),
      );
    }

    totalTickets += entry.result.tickets.length;
  }

  return {
    totalTickets,
    totalAccounts: accountsWithTickets.size,
    adjacentGroups: buildAdjacentSeatRows(report, lang).length,
  };
}

function buildFooterMatrix(report, lang = "ar") {
  const stats = collectWorkbookStats(report, lang);

  if (lang === "en") {
    return [
      ["", ""],
      ["Event Summary", ""],
      ["Total Tickets", stats.totalTickets],
      ["Total Accounts", stats.totalAccounts],
      ["Adjacent Groups", stats.adjacentGroups],
    ];
  }

  return [
    ["", ""],
    ["ملخص الفعالية", ""],
    ["إجمالي التذاكر", stats.totalTickets],
    ["إجمالي الحسابات", stats.totalAccounts],
    ["المجموعات المتجاورة", stats.adjacentGroups],
  ];
}

function getAccountWalletBalance(entry) {
  const result = entry && entry.result ? entry.result : {};
  const account = entry && entry.account ? entry.account : {};
  const values = [
    result.walletBalance,
    result.wallet_balance,
    result.balance,
    result.wallet,
    account.walletBalance,
    account.wallet_balance,
    account.balance,
    account.wallet,
  ];

  for (const value of values) {
    if (value === null || value === undefined || value === "") {
      continue;
    }
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function getAccountWalletCurrency(entry) {
  const result = entry && entry.result ? entry.result : {};
  const account = entry && entry.account ? entry.account : {};
  const values = [
    result.walletCurrency,
    result.wallet_currency,
    result.currency,
    account.walletCurrency,
    account.wallet_currency,
  ];

  for (const value of values) {
    const currency = String(value || "")
      .trim()
      .toUpperCase();
    if (currency) {
      return currency;
    }
  }

  return "";
}

function getAccountDeviceVerified(entry) {
  const result = entry && entry.result ? entry.result : {};
  const account = entry && entry.account ? entry.account : {};
  const values = [
    result.deviceVerified,
    result.device_verified,
    result.isDeviceVerified,
    result.is_device_verified,
    result.verifiedDevice,
    account.deviceVerified,
    account.device_verified,
    account.isDeviceVerified,
    account.verifiedDevice,
  ];

  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const text = value.trim().toLowerCase();
      if (["true", "yes", "y", "1", "verified"].includes(text)) {
        return true;
      }
      if (["false", "no", "n", "0", "not_verified", "unverified"].includes(text)) {
        return false;
      }
    }
    if (typeof value === "number") {
      return value !== 0;
    }
  }

  return false;
}

function getAccountSortPriority(entry) {
  const walletBalance = getAccountWalletBalance(entry);
  const deviceVerified = getAccountDeviceVerified(entry);
  let score = 0;

  if (walletBalance > 0) {
    score += 2;
  }
  if (deviceVerified) {
    score += 1;
  }

  return score;
}

function buildAccountSummaryRows(report, lang = "ar") {
  const accounts = Array.isArray(report && report.accounts) ? report.accounts : [];

  return [...accounts]
    .sort((left, right) => {
      const leftPriority = getAccountSortPriority(left);
      const rightPriority = getAccountSortPriority(right);
      if (leftPriority !== rightPriority) {
        return rightPriority - leftPriority;
      }

      const leftAccount = String(
        (left && left.account && (left.account.username || left.account.usernameMasked || left.account.accountId)) ||
          "",
      )
        .trim()
        .toLowerCase();
      const rightAccount = String(
        (right &&
          right.account &&
          (right.account.username || right.account.usernameMasked || right.account.accountId)) ||
          "",
      )
        .trim()
        .toLowerCase();

      return leftAccount.localeCompare(rightAccount, undefined, { numeric: true });
    })
    .map((entry) => {
      const result = entry.result || {};
      const accountName =
        entry.account && (entry.account.username || entry.account.usernameMasked || entry.account.accountId);
      const walletBalance = getAccountWalletBalance(entry);
      const walletCurrency = getAccountWalletCurrency(entry);

      if (lang === "en") {
        return {
          account_id: entry.account.accountId,
          account: accountName,
          status: getStatusLabel(entry.ok ? result.status || "ok" : "failed", lang),
          tickets: Number(result.ticketCount || 0),
          booking_ids: Number(result.bookingIdsFound || 0),
          wallet_balance: walletBalance,
          wallet_currency: walletCurrency,
        };
      }

      return {
        معرف_الحساب: entry.account.accountId,
        الحساب: accountName,
        الحالة: getStatusLabel(entry.ok ? result.status || "ok" : "failed", lang),
        عدد_التذاكر: Number(result.ticketCount || 0),
        عدد_الحجوزات: Number(result.bookingIdsFound || 0),
        رصيد_المحفظة: walletBalance,
        عملة_المحفظة: walletCurrency,
      };
    });
}

function buildTicketRows(report, lang = "ar") {
  const accounts = Array.isArray(report && report.accounts) ? report.accounts : [];
  const rows = [];

  for (const entry of accounts) {
    if (!entry.ok || !entry.result || !Array.isArray(entry.result.tickets)) {
      continue;
    }

    const accountName =
      entry.account && (entry.account.username || entry.account.usernameMasked || entry.account.accountId);
    const walletBalance = getAccountWalletBalance(entry);
    const walletCurrency = getAccountWalletCurrency(entry);

    for (const ticket of entry.result.tickets) {
      const placement = getPlacementValues(ticket.section, ticket.row, lang);
      const isNew = ticket.isNew === true;
      const isNewLabel = isNew
        ? (lang === "en" ? "🆕 NEW" : "🆕 جديدة")
        : (lang === "en" ? "Existing" : "مسجلة");
      const priceVal = ticket.price !== undefined && ticket.price !== null && ticket.price !== "" ? ticket.price : "-";
      const currencyVal = ticket.currency || walletCurrency || "";

      const base = {
        accountId: entry.account.accountId,
        account: accountName,
        status: getStatusLabel(entry.result.status || "ok", lang),
        walletBalance,
        walletCurrency,
        eventName: ticket.eventName || "-",
        eventDate: formatDateTime(ticket.time, lang),
        category: ticket.category || "-",
        price: priceVal,
        currency: currencyVal,
        section: placement.sectionValue,
        row: placement.rowValue,
        seat: ticket.seat || "-",
        isNew: isNewLabel,
        orderId: ticket.orderId || "-",
        ticketId: ticket.ticketId || "-",
      };

      if (lang === "en") {
        rows.push({
          account_id: base.accountId,
          account: base.account,
          status: base.status,
          wallet_balance: base.walletBalance,
          wallet_currency: base.walletCurrency,
          event_name: base.eventName,
          event_date: base.eventDate,
          category: base.category,
          price: base.price,
          currency: base.currency,
          section: base.section,
          row: base.row,
          seat: base.seat,
          is_new: base.isNew,
          order_id: base.orderId,
          ticket_id: base.ticketId,
        });
      } else {
        rows.push({
          معرف_الحساب: base.accountId,
          الحساب: base.account,
          الحالة: base.status,
          رصيد_المحفظة: base.walletBalance,
          عملة_المحفظة: base.walletCurrency,
          اسم_الفعالية: base.eventName,
          تاريخ_الفعالية: base.eventDate,
          الفئة: base.category,
          السعر: base.price,
          العملة: base.currency,
          القسم: base.section,
          الصف: base.row,
          المقعد: base.seat,
          جديدة: base.isNew,
          رقم_الطلب: base.orderId,
          رقم_التذكرة: base.ticketId,
        });
      }
    }
  }

  const accountKey = lang === "en" ? "account" : "الحساب";
  const eventDateKey = lang === "en" ? "event_date" : "تاريخ_الفعالية";
  const eventNameKey = lang === "en" ? "event_name" : "اسم_الفعالية";
  const sectionKey = lang === "en" ? "section" : "القسم";
  const rowKey = lang === "en" ? "row" : "الصف";
  const seatKey = lang === "en" ? "seat" : "المقعد";
  const orderIdKey = lang === "en" ? "order_id" : "رقم_الطلب";
  const ticketIdKey = lang === "en" ? "ticket_id" : "رقم_التذكرة";

  return rows.sort((left, right) => {
    const leftSortKey = [
      left[sectionKey],
      left[eventDateKey],
      left[eventNameKey],
      left[rowKey],
      left[seatKey],
      left[accountKey],
      left[orderIdKey],
      left[ticketIdKey],
    ]
      .map((value) => String(value || ""))
      .join("|");
    const rightSortKey = [
      right[sectionKey],
      right[eventDateKey],
      right[eventNameKey],
      right[rowKey],
      right[seatKey],
      right[accountKey],
      right[orderIdKey],
      right[ticketIdKey],
    ]
      .map((value) => String(value || ""))
      .join("|");

    return leftSortKey.localeCompare(rightSortKey, undefined, { numeric: true });
  });
}

function buildOrganizedSummaryRows(report, lang = "ar") {
  const accounts = Array.isArray(report && report.accounts) ? report.accounts : [];
  const grouped = new Map();

  for (const entry of accounts) {
    if (!entry.ok || !entry.result || !Array.isArray(entry.result.tickets)) {
      continue;
    }

    const accountName =
      entry.account && (entry.account.username || entry.account.usernameMasked || entry.account.accountId);
    const walletBalance = getAccountWalletBalance(entry);
    const walletCurrency = getAccountWalletCurrency(entry);
    for (const ticket of entry.result.tickets) {
      const key = [
        accountName || "-",
        ticket.eventName || "-",
        ticket.time || "-",
        ticket.category || "-",
        ...Object.values(getPlacementValues(ticket.section, ticket.row, lang)),
      ].join("|");

      const placement = getPlacementValues(ticket.section, ticket.row, lang);
      const current = grouped.get(key) || {
        eventName: ticket.eventName || "-",
        eventDate: formatDateTime(ticket.time, lang),
        category: ticket.category || "-",
        section: placement.sectionValue,
        row: placement.rowValue,
        seats: [],
        account: accountName || "-",
        walletBalance,
        walletCurrency,
      };

      current.seats.push(ticket.seat || "-");
      grouped.set(key, current);
    }
  }

  const rows = [];
  for (const item of grouped.values()) {
    const orderedSeats = sortSeatValues(item.seats);
    if (lang === "en") {
      rows.push({
        event_name: item.eventName,
        event_date: item.eventDate,
        category: item.category,
        section: item.section,
        row: item.row,
        tickets_count: orderedSeats.length,
        seats: orderedSeats.join(", "),
        accounts: item.account,
        wallet_balance: item.walletBalance,
        wallet_currency: item.walletCurrency,
      });
    } else {
      rows.push({
        اسم_الفعالية: item.eventName,
        تاريخ_الفعالية: item.eventDate,
        الفئة: item.category,
        القسم: item.section,
        الصف: item.row,
        عدد_التذاكر: orderedSeats.length,
        المقاعد: orderedSeats.join(", "),
        الحسابات: item.account,
        رصيد_المحفظة: item.walletBalance,
        عملة_المحفظة: item.walletCurrency,
      });
    }
  }

  const accountKey = lang === "en" ? "accounts" : "الحسابات";
  const eventDateKey = lang === "en" ? "event_date" : "تاريخ_الفعالية";
  const eventNameKey = lang === "en" ? "event_name" : "اسم_الفعالية";
  const categoryKey = lang === "en" ? "category" : "الفئة";
  const sectionKey = lang === "en" ? "section" : "القسم";
  const rowKey = lang === "en" ? "row" : "الصف";

  return rows.sort((left, right) => {
    const leftSortKey = [
      left[sectionKey],
      left[eventDateKey],
      left[eventNameKey],
      left[categoryKey],
      left[rowKey],
      left[accountKey],
    ]
      .map((value) => String(value || ""))
      .join("|");
    const rightSortKey = [
      right[sectionKey],
      right[eventDateKey],
      right[eventNameKey],
      right[categoryKey],
      right[rowKey],
      right[accountKey],
    ]
      .map((value) => String(value || ""))
      .join("|");

    return leftSortKey.localeCompare(rightSortKey, undefined, { numeric: true });
  });
}

function parseSeatSortToken(value) {
  const text = normalizeSortText(value).toLowerCase();
  if (!text || text === "-") {
    return { kind: "empty", text: "" };
  }

  const alphaOnly = text.match(/^([a-z]+)$/);
  if (alphaOnly) {
    return { kind: "alpha", text: alphaOnly[1], rank: alphaOnly[1].charCodeAt(0) - 96 };
  }

  const numberOnly = text.match(/^(\d+)$/);
  if (numberOnly) {
    return { kind: "number", text: numberOnly[1], rank: Number(numberOnly[1]) };
  }

  const alphaNumeric = text.match(/^([a-z]+)(\d+)$/);
  if (alphaNumeric) {
    return {
      kind: "alpha-number",
      text: alphaNumeric[1],
      rank: Number(alphaNumeric[2]),
      alphaRank: alphaNumeric[1].charCodeAt(0) - 96,
    };
  }

  return { kind: "text", text };
}

function sortSeatValues(values) {
  return [...values].sort((left, right) => {
    const leftToken = parseSeatSortToken(left);
    const rightToken = parseSeatSortToken(right);

    if (leftToken.kind === "empty" && rightToken.kind === "empty") {
      return 0;
    }
    if (leftToken.kind === "empty") {
      return -1;
    }
    if (rightToken.kind === "empty") {
      return 1;
    }

    const kindOrder = { alpha: 0, "alpha-number": 1, number: 2, text: 3, empty: 4 };
    const kindCompare = (kindOrder[leftToken.kind] ?? 99) - (kindOrder[rightToken.kind] ?? 99);
    if (kindCompare !== 0) {
      return kindCompare;
    }

    if (leftToken.kind === "alpha" && rightToken.kind === "alpha") {
      return leftToken.text.localeCompare(rightToken.text, undefined, { numeric: true });
    }

    if (leftToken.kind === "number" && rightToken.kind === "number") {
      return leftToken.rank - rightToken.rank;
    }

    if (leftToken.kind === "alpha-number" && rightToken.kind === "alpha-number") {
      const alphaCompare = leftToken.alphaRank - rightToken.alphaRank;
      if (alphaCompare !== 0) {
        return alphaCompare;
      }
      return leftToken.rank - rightToken.rank;
    }

    if (leftToken.kind === "text" && rightToken.kind === "text") {
      return leftToken.text.localeCompare(rightToken.text, undefined, { numeric: true });
    }

    return leftToken.text.localeCompare(rightToken.text, undefined, { numeric: true });
  });
}

function getSeatNumericValue(seat) {
  const text = String(seat || "").trim();
  return /^\d+$/.test(text) ? Number(text) : null;
}

function formatSeatOwnership(seatOwners) {
  const segments = [];
  const orderedSeats = sortSeatValues([...seatOwners.keys()]);

  for (const seat of orderedSeats) {
    const accounts = [...(seatOwners.get(seat) || [])].sort();
    if (accounts.length === 0) {
      continue;
    }

    segments.push(`${seat}: ${accounts.join(" / ")}`);
  }

  return segments.join(" | ");
}

function getPrimaryAccountFromOwnershipText(value) {
  const text = String(value || "");
  const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  if (matches.length === 0) {
    return "";
  }

  return matches
    .map((item) => item.trim().toLowerCase())
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))[0];
}

function buildAdjacentSeatRows(report, lang = "ar") {
  const accounts = Array.isArray(report && report.accounts) ? report.accounts : [];
  const grouped = new Map();

  for (const entry of accounts) {
    if (!entry.ok || !entry.result || !Array.isArray(entry.result.tickets)) {
      continue;
    }

    const accountName =
      entry.account && (entry.account.username || entry.account.usernameMasked || entry.account.accountId);
    for (const ticket of entry.result.tickets) {
      if (!ticket || !ticket.section || ticket.section === "-" || !ticket.seat || ticket.seat === "-") {
        continue;
      }

      const groupKey = [
        ticket.eventName || "-",
        ticket.time || "-",
        ticket.category || "-",
        ...Object.values(getPlacementValues(ticket.section, ticket.row, lang)),
      ].join("|");

      const placement = getPlacementValues(ticket.section, ticket.row, lang);
      const list = grouped.get(groupKey) || [];
      list.push({
        eventName: ticket.eventName || "-",
        eventDate: formatDateTime(ticket.time, lang),
        section: placement.sectionValue,
        row: placement.rowValue,
        seat: String(ticket.seat || "-").trim(),
        seatNum: getSeatNumericValue(ticket.seat),
        account: accountName,
        category: ticket.category || "-",
      });
      grouped.set(groupKey, list);
    }
  }

  const rows = [];

  for (const list of grouped.values()) {
    const ordered = [...list].sort((left, right) => {
      if (left.seatNum !== null && right.seatNum !== null) {
        return left.seatNum - right.seatNum;
      }
      if (left.seatNum !== null) return -1;
      if (right.seatNum !== null) return 1;
      return left.seat.localeCompare(right.seat, undefined, { numeric: true });
    });

    let run = null;

    const pushRun = () => {
      if (!run) return;
      if (run.count < 2) {
        run = null;
        return;
      }

      const seatRange = run.startSeat === run.endSeat ? run.startSeat : `${run.startSeat}-${run.endSeat}`;
      const fromSeat = `${run.section}-${run.row}-${run.startSeat}`;
      const toSeat = `${run.section}-${run.row}-${run.endSeat}`;
      const accountsText = formatSeatOwnership(run.seatOwners);

      if (lang === "en") {
        rows.push({
          event_name: run.eventName,
          section: run.section,
          row: run.row,
          adjacent_seats: seatRange,
          from: fromSeat,
          to: toSeat,
          count: run.count,
          accounts: accountsText,
        });
      } else {
        rows.push({
          الفعالية: run.eventName,
          القسم: run.section,
          الصف: run.row,
          المقاعد_المتجاورة: seatRange,
          من: fromSeat,
          إلى: toSeat,
          العدد: run.count,
          الحسابات: accountsText,
        });
      }

      run = null;
    };

    for (const seatRow of ordered) {
      if (!run) {
        run = {
          eventName: seatRow.eventName,
          eventDate: seatRow.eventDate,
          section: seatRow.section,
          row: seatRow.row,
          category: seatRow.category,
          startSeat: seatRow.seat,
          endSeat: seatRow.seat,
          lastSeatNum: seatRow.seatNum,
          count: 1,
          accounts: new Set([seatRow.account]),
          seatOwners: new Map([[seatRow.seat, new Set([seatRow.account])]]),
        };
        continue;
      }

      const isAdjacentNumeric =
        run.lastSeatNum !== null && seatRow.seatNum !== null && seatRow.seatNum === run.lastSeatNum + 1;

      if (isAdjacentNumeric) {
        run.endSeat = seatRow.seat;
        run.lastSeatNum = seatRow.seatNum;
        run.count += 1;
        run.accounts.add(seatRow.account);
        const owners = run.seatOwners.get(seatRow.seat) || new Set();
        owners.add(seatRow.account);
        run.seatOwners.set(seatRow.seat, owners);
        continue;
      }

      pushRun();
      run = {
        eventName: seatRow.eventName,
        eventDate: seatRow.eventDate,
        section: seatRow.section,
        row: seatRow.row,
        category: seatRow.category,
        startSeat: seatRow.seat,
        endSeat: seatRow.seat,
        lastSeatNum: seatRow.seatNum,
        count: 1,
        accounts: new Set([seatRow.account]),
        seatOwners: new Map([[seatRow.seat, new Set([seatRow.account])]]),
      };
    }

    pushRun();
  }

  const accountKey = lang === "en" ? "accounts" : "الحسابات";
  const eventKey = lang === "en" ? "event_name" : "الفعالية";
  const sectionKey = lang === "en" ? "section" : "القسم";
  const rowKey = lang === "en" ? "row" : "الصف";
  const fromKey = lang === "en" ? "from" : "من";

  return rows.sort((left, right) => {
    const leftAccount = getPrimaryAccountFromOwnershipText(left[accountKey]);
    const rightAccount = getPrimaryAccountFromOwnershipText(right[accountKey]);
    const accountCompare = leftAccount.localeCompare(rightAccount, undefined, { numeric: true });
    if (accountCompare !== 0) {
      return accountCompare;
    }

    const leftSortKey = [left[eventKey], left[sectionKey], left[rowKey], left[fromKey]]
      .map((value) => String(value || ""))
      .join("|");
    const rightSortKey = [right[eventKey], right[sectionKey], right[rowKey], right[fromKey]]
      .map((value) => String(value || ""))
      .join("|");

    return leftSortKey.localeCompare(rightSortKey, undefined, { numeric: true });
  });
}

async function ensureReportsDir() {
  await fs.mkdir(REPORTS_DIR, { recursive: true });
}

async function writeWorkbook(baseName, sheets) {
  await ensureReportsDir();
  const workbook = XLSX.utils.book_new();
  const usedSheetNames = new Set();

  for (const sheet of sheets) {
    const rows = Array.isArray(sheet.rows) && sheet.rows.length > 0 ? sheet.rows : [{}];
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const footerMatrix = Array.isArray(sheet.footerMatrix) ? sheet.footerMatrix : [];
    const existingRange = worksheet["!ref"] ? XLSX.utils.decode_range(worksheet["!ref"]) : null;
    const footerTitleRowIndex = existingRange ? existingRange.e.r + 2 : 1;

    if (footerMatrix.length > 0) {
      XLSX.utils.sheet_add_aoa(worksheet, footerMatrix, { origin: -1 });
      worksheet["!merges"] = Array.isArray(worksheet["!merges"]) ? worksheet["!merges"] : [];
      worksheet["!merges"].push({
        s: { r: footerTitleRowIndex, c: 0 },
        e: { r: footerTitleRowIndex, c: 1 },
      });
    }

    applyWorksheetLayout(worksheet, rows);
    widenWorksheetColumns(worksheet, footerMatrix);
    XLSX.utils.book_append_sheet(workbook, worksheet, getUniqueWorksheetName(sheet.name, usedSheetNames));
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${sanitizeFileNamePart(baseName)}_${stamp}.xlsx`;
  const filePath = path.join(REPORTS_DIR, fileName);
  XLSX.writeFile(workbook, filePath, { compression: true });

  return { filePath, fileName };
}

function buildNewTicketRows(report, lang = "ar") {
  const accounts = Array.isArray(report && report.accounts) ? report.accounts : [];
  const filteredAccounts = accounts
    .map((entry) => {
      if (!entry.ok || !entry.result || !Array.isArray(entry.result.tickets)) {
        return null;
      }
      const newTickets = entry.result.tickets.filter((t) => t.isNew === true);
      if (newTickets.length === 0) return null;
      return {
        ...entry,
        result: {
          ...entry.result,
          tickets: newTickets,
          ticketCount: newTickets.length,
        },
      };
    })
    .filter(Boolean);

  if (filteredAccounts.length === 0) return [];
  return buildTicketRows({ ...report, accounts: filteredAccounts }, lang);
}

async function createFullTicketsWorkbook(report, lang = "ar") {
  const footerMatrix = buildFooterMatrix(report, lang);
  const newTicketRows = buildNewTicketRows(report, lang);
  const sheets = [];

  if (newTicketRows.length > 0) {
    sheets.push({
      name: lang === "en" ? "🆕 New Tickets" : "🆕_التذاكر_الجديدة",
      rows: newTicketRows,
    });
  }

  sheets.push(
    {
      name: lang === "en" ? "Accounts" : "الحسابات",
      rows: buildAccountSummaryRows(report, lang),
      footerMatrix,
    },
    {
      name: lang === "en" ? "Tickets" : "التذاكر",
      rows: buildTicketRows(report, lang),
      footerMatrix,
    },
  );

  return writeWorkbook(lang === "en" ? "ticket_details" : "تفاصيل_التذاكر", sheets);
}

async function createOrganizedTicketsWorkbook(report, lang = "ar") {
  const footerMatrix = buildFooterMatrix(report, lang);
  const newTicketRows = buildNewTicketRows(report, lang);
  const sheets = [];

  if (newTicketRows.length > 0) {
    sheets.push({
      name: lang === "en" ? "🆕 New Tickets" : "🆕_التذاكر_الجديدة",
      rows: newTicketRows,
    });
  }

  sheets.push(
    {
      name: lang === "en" ? "Account Summary" : "ملخص_الحسابات",
      rows: buildAccountSummaryRows(report, lang),
      footerMatrix,
    },
    {
      name: lang === "en" ? "By Event" : "حسب_الفعالية",
      rows: buildOrganizedSummaryRows(report, lang),
      footerMatrix,
    },
    {
      name: lang === "en" ? "Tickets Sorted" : "التذاكر_مرتبة",
      rows: buildTicketRows(report, lang),
      footerMatrix,
    },
  );

  return writeWorkbook(lang === "en" ? "organized_ticket_details" : "تفاصيل_التذاكر_منظم", sheets);
}

async function createTicketsBySectionWorkbook(report, lang = "ar") {
  const sheets = buildTicketsBySectionSheets(report, lang);
  const summaryName = lang === "en" ? "Section Summary" : "ملخص_الأقسام";
  const fallbackSheets = [{ name: summaryName, rows: [] }];
  return writeWorkbook(
    lang === "en" ? "tickets_by_section" : "التذاكر_حسب_القسم",
    sheets.length > 0 ? sheets : fallbackSheets,
  );
}

function splitReportByEvent(report) {
  const events = new Map();
  for (const entry of report.accounts || []) {
    if (!entry?.ok || !Array.isArray(entry.result?.tickets)) continue;
    for (const ticket of entry.result.tickets) {

      const key = JSON.stringify([ticket.eventId || ticket.eventName || "unknown_event", ticket.time || "-"]);
      if (!events.has(key)) {
        events.set(key, { eventName: ticket.eventName || "unknown_event", time: ticket.time || "-", accounts: new Map() });
      }
      const event = events.get(key);
      if (!event.accounts.has(entry)) {
        event.accounts.set(entry, { ...entry, result: { ...entry.result, tickets: [], ticketCount: 0 } });
      }
      const result = event.accounts.get(entry).result;
      result.tickets.push(ticket);
      result.ticketCount += 1;
    }
  }
  return [...events.values()].map((event) => ({
    ...report,
    eventName: event.eventName,
    eventTime: event.time,
    accounts: [...event.accounts.values()],
    totalAccounts: event.accounts.size,
  }));
}

async function createTicketsBySectionWorkbooks(report, lang = "ar") {
  const files = [];
  const prefix = lang === "en" ? "tickets_by_section" : "التذاكر_حسب_القسم";
  for (const eventReport of splitReportByEvent(report)) {
    const file = await writeWorkbook(
      `${prefix}_${files.length + 1}_${eventReport.eventName}_${eventReport.eventTime}`,
      buildTicketsBySectionSheets(eventReport, lang),
    );
    files.push({ ...file, eventName: eventReport.eventName, eventTime: eventReport.eventTime });
  }
  return files;
}

async function createAdjacentSeatsWorkbook(report, lang = "ar") {
  const footerMatrix = buildFooterMatrix(report, lang);
  return writeWorkbook(lang === "en" ? "adjacent_seats" : "المقاعد_المتجاورة", [
    {
      name: lang === "en" ? "Adjacent Seats" : "المقاعد_المتجاورة",
      rows: buildAdjacentSeatRows(report, lang),
      footerMatrix,
    },
  ]);
}

async function createScatteredSeatsWorkbook(report, lang = "ar") {
  const footerMatrix = buildFooterMatrix(report, lang);
  return writeWorkbook(lang === "en" ? "scattered_seats" : "المقاعد_المتفرقة", [
    {
      name: lang === "en" ? "Scattered Seats" : "المقاعد_المتفرقة",
      rows: buildScatteredSeatRows(report, lang),
      footerMatrix,
    },
  ]);
}

function buildTicketsBySectionSheets(report, lang = "ar") {
  const accounts = Array.isArray(report && report.accounts) ? report.accounts : [];
  const sections = new Map();
  const summarySectionLabel = lang === "en" ? "Unassigned" : "غير_محدد";

  for (const entry of accounts) {
    if (!entry || !entry.ok || !entry.result || !Array.isArray(entry.result.tickets)) {
      continue;
    }

    const accountName =
      entry.account && (entry.account.username || entry.account.usernameMasked || entry.account.accountId);

    for (const ticket of entry.result.tickets) {
      const section = normalizeSortText(ticket && ticket.section) || summarySectionLabel;
      const row = normalizeSortText(ticket && ticket.row) || "-";
      const seat = normalizeSortText(ticket && ticket.seat) || "-";
      const groupKey = [
        accountName || "-",
        row,
        ticket.eventName || "-",
        ticket.time || "-",
        ticket.category || "-",
      ].join("|");
      const sectionEntry = sections.get(section) || { section, groups: new Map() };
      const group = sectionEntry.groups.get(groupKey) || { Row: row, Seats: [], Account: accountName || "-" };

      group.Seats.push(seat);
      sectionEntry.groups.set(groupKey, group);
      sections.set(section, sectionEntry);
    }
  }

  const sectionSheets = [...sections.values()]
    .sort((left, right) => compareAlphaNumeric(left.section, right.section))
    .map((sectionEntry) => ({
      name: sectionEntry.section,
      rows: [...sectionEntry.groups.values()]
        .map((group) => {
          const seats = sortSeatValues(group.Seats);
          return { Row: group.Row, Seats: seats.join(","), Count: seats.length, Account: group.Account };
        })
        .sort((left, right) => {
          const rowCompare = compareAlphaNumeric(left.Row, right.Row);
          if (rowCompare !== 0) return rowCompare;
          const seatCompare = compareAlphaNumeric(left.Seats.split(",")[0], right.Seats.split(",")[0]);
          if (seatCompare !== 0) return seatCompare;
          return compareAlphaNumeric(left.Account, right.Account);
        }),
    }));

  const summaryRows = sectionSheets.map((sheet) => {
    const totalTickets = sheet.rows.reduce((sum, row) => sum + (Number(row.Count) || 0), 0);
    if (lang === "en") {
      return { Section: sheet.name, "Ticket Count": totalTickets };
    }

    return { Section: sheet.name, عدد_التذاكر: totalTickets };
  });

  const sheets = [];
  if (summaryRows.length > 0) {
    sheets.push({
      name: lang === "en" ? "Section Summary" : "ملخص_الأقسام",
      rows: summaryRows,
    });
  }

  return sheets.concat(sectionSheets);
}

function buildGeneralInfoText(report, lang = "ar") {
  const summary = summarizeReport(report);
  const lines = [
    lang === "en" ? "Check completed" : "اكتمل الفحص",
    lang === "en"
      ? `Success: ${summary.successCount}/${summary.totalAccounts}`
      : `نجاح: ${summary.successCount}/${summary.totalAccounts}`,
    lang === "en"
      ? `Errors: ${summary.failedCount}/${summary.totalAccounts}`
      : `أخطاء: ${summary.failedCount}/${summary.totalAccounts}`,
    lang === "en" ? `Total tickets: ${summary.totalTickets}` : `إجمالي التذاكر: ${summary.totalTickets}`,
  ];

  if (summary.unauthorizedCount > 0) {
    lines.push(
      lang === "en"
        ? `Unauthorized accounts: ${summary.unauthorizedCount}`
        : `حسابات غير مصرح بها: ${summary.unauthorizedCount}`,
    );
  }

  if (summary.noBookingsCount > 0) {
    lines.push(
      lang === "en"
        ? `Accounts with no bookings: ${summary.noBookingsCount}`
        : `حسابات بدون حجوزات: ${summary.noBookingsCount}`,
    );
  }

  lines.push("");

  const accounts = Array.isArray(report && report.accounts) ? report.accounts : [];
  for (const entry of accounts) {
    const result = entry.result || {};
    const accountName =
      entry.account && (entry.account.username || entry.account.usernameMasked || entry.account.accountId);
    const status = getStatusLabel(entry.ok ? result.status || "ok" : "failed", lang);

    if (lang === "en") {
      lines.push(`${entry.account.accountId} • ${accountName}`);
      lines.push(`Status: ${status}`);
      lines.push(`Tickets: ${Number(result.ticketCount || 0)}`);
      lines.push(`Bookings: ${Number(result.bookingIdsFound || 0)}`);
      if (entry.error) {
        lines.push(`Fetch error: ${entry.error}`);
      }
    } else {
      lines.push(`${entry.account.accountId} • ${accountName}`);
      lines.push(`الحالة: ${status}`);
      lines.push(`عدد التذاكر: ${Number(result.ticketCount || 0)}`);
      lines.push(`عدد الحجوزات: ${Number(result.bookingIdsFound || 0)}`);
      if (entry.error) {
        lines.push(`خطأ الجلب: ${entry.error}`);
      }
    }

    lines.push("");
  }

  return lines.join("\n").trim();
}

function buildSeatRowKey(seatRow) {
  return [
    seatRow.accountId || "-",
    seatRow.orderId || "-",
    seatRow.ticketId || "-",
    seatRow.eventName || "-",
    seatRow.eventDateRaw || "-",
    seatRow.category || "-",
    seatRow.section || "-",
    seatRow.row || "-",
    seatRow.seat || "-",
  ].join("|");
}

function collectSeatRows(report, lang = "ar") {
  const accounts = Array.isArray(report && report.accounts) ? report.accounts : [];
  const seatRows = [];

  for (const entry of accounts) {
    if (!entry.ok || !entry.result || !Array.isArray(entry.result.tickets)) {
      continue;
    }

    const account = entry.account || {};
    const accountName = account.username || account.usernameMasked || account.accountId || "-";
    for (const ticket of entry.result.tickets) {
      if (!ticket || !ticket.section || ticket.section === "-" || !ticket.seat || ticket.seat === "-") {
        continue;
      }

      const placement = getPlacementValues(ticket.section, ticket.row, lang);
      const seatRow = {
        accountId: account.accountId || "-",
        account: accountName,
        eventName: ticket.eventName || "-",
        eventDate: formatDateTime(ticket.time, lang),
        eventDateRaw: ticket.time || "-",
        category: ticket.category || "-",
        section: placement.sectionValue,
        row: placement.rowValue,
        seat: String(ticket.seat || "-").trim(),
        seatNum: getSeatNumericValue(ticket.seat),
        orderId: ticket.orderId || "-",
        ticketId: ticket.ticketId || "-",
      };
      seatRow.key = buildSeatRowKey(seatRow);
      seatRows.push(seatRow);
    }
  }

  return seatRows;
}

function groupSeatRows(seatRows) {
  const grouped = new Map();

  for (const seatRow of seatRows) {
    const groupKey = [
      seatRow.eventName || "-",
      seatRow.eventDateRaw || "-",
      seatRow.category || "-",
      seatRow.section || "-",
      seatRow.row || "-",
    ].join("|");
    const list = grouped.get(groupKey) || [];
    list.push(seatRow);
    grouped.set(groupKey, list);
  }

  return grouped;
}

function findAdjacentSeatKeys(report, lang = "ar") {
  const grouped = groupSeatRows(collectSeatRows(report, lang));
  const adjacentKeys = new Set();

  for (const list of grouped.values()) {
    const ordered = [...list].sort((left, right) => {
      if (left.seatNum !== null && right.seatNum !== null) {
        return left.seatNum - right.seatNum;
      }
      if (left.seatNum !== null) return -1;
      if (right.seatNum !== null) return 1;
      return left.seat.localeCompare(right.seat, undefined, { numeric: true });
    });

    let run = [];
    for (const seatRow of ordered) {
      if (run.length === 0) {
        run = [seatRow];
        continue;
      }

      const previous = run[run.length - 1];
      const isAdjacentNumeric =
        previous.seatNum !== null && seatRow.seatNum !== null && seatRow.seatNum === previous.seatNum + 1;

      if (isAdjacentNumeric) {
        run.push(seatRow);
        continue;
      }

      if (run.length >= 2) {
        for (const item of run) {
          adjacentKeys.add(item.key);
        }
      }
      run = [seatRow];
    }

    if (run.length >= 2) {
      for (const item of run) {
        adjacentKeys.add(item.key);
      }
    }
  }

  return adjacentKeys;
}

function buildScatteredSeatRows(report, lang = "ar") {
  const adjacentKeys = findAdjacentSeatKeys(report, lang);
  const scatteredRows = collectSeatRows(report, lang).filter((seatRow) => !adjacentKeys.has(seatRow.key));

  return scatteredRows
    .sort((left, right) =>
      [
        String(left.account || "")
          .trim()
          .toLowerCase(),
        left.eventName,
        left.eventDateRaw,
        left.category,
        left.section,
        left.row,
        left.seatNum !== null ? left.seatNum : left.seat,
      ]
        .join("|")
        .localeCompare(
          [
            String(right.account || "")
              .trim()
              .toLowerCase(),
            right.eventName,
            right.eventDateRaw,
            right.category,
            right.section,
            right.row,
            right.seatNum !== null ? right.seatNum : right.seat,
          ].join("|"),
          undefined,
          { numeric: true },
        ),
    )
    .map((seatRow) => {
      if (lang === "en") {
        return {
          event_name: seatRow.eventName,
          event_date: seatRow.eventDate,
          category: seatRow.category,
          section: seatRow.section,
          row: seatRow.row,
          seat: seatRow.seat,
          account: seatRow.account,
          order_id: seatRow.orderId,
          ticket_id: seatRow.ticketId,
        };
      }

      return {
        الفعالية: seatRow.eventName,
        تاريخ_الفعالية: seatRow.eventDate,
        الفئة: seatRow.category,
        القسم: seatRow.section,
        الصف: seatRow.row,
        المقعد: seatRow.seat,
        الحساب: seatRow.account,
        رقم_الطلب: seatRow.orderId,
        رقم_التذكرة: seatRow.ticketId,
      };
    });
}

module.exports = {
  buildGeneralInfoText,
  buildAccountSummaryRows,
  buildTicketRows,
  buildNewTicketRows,
  buildAdjacentSeatRows,
  buildScatteredSeatRows,
  buildOrganizedSummaryRows,
  buildTicketsBySectionSheets,
  createAdjacentSeatsWorkbook,
  createScatteredSeatsWorkbook,
  createFullTicketsWorkbook,
  createOrganizedTicketsWorkbook,
  createTicketsBySectionWorkbook,
  createTicketsBySectionWorkbooks,
  splitReportByEvent,
  sortSeatValues,
  summarizeReport,
};
