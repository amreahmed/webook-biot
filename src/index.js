require("dotenv").config();

const { Input, Markup, Telegraf } = require("telegraf");
const { getChatLanguage, saveChatLanguage, appendKnownEmails } = require("./sessionManager");
const { fetchTicketsForAccount } = require("./ticketFetcher");
const logger = require("./logger");
const { connectDb } = require("./db");
const User = require("./models/User");
const Account = require("./models/Account");
const LoginJob = require("./models/LoginJob");
const { queueLoginJob, startLoginWorker, setLoginNotifier, getQueueStatus, browserPool, cancelOwnerLoginJobs, loginControl } = require("./loginQueue");
const apiClient = require("./apiClient");
const { deleteSavedAccounts } = require("./accountActions");
const { checkEligibility, isTokenValid, getRateLimitStats } = apiClient;
const {
  buildGeneralInfoText,
  buildAdjacentSeatRows,
  buildScatteredSeatRows,
  createAdjacentSeatsWorkbook,
  createScatteredSeatsWorkbook,
  createOrganizedTicketsWorkbook,
  createTicketsBySectionWorkbooks,
  summarizeReport,
} = require("./reportExports");
const { getAuthSummary, isUsableToken } = require("./webookAuth");

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is missing in environment variables.");
}

const linkConcurrency = Math.max(1, Number(process.env.LINK_CONCURRENCY || 2));
const blockHeavyResources = String(process.env.BLOCK_HEAVY_RESOURCES || "true").toLowerCase() === "true";
const defaultLinkPassword = (process.env.DEFAULT_LINK_PASSWORD || "").trim();
const telegramHandlerTimeoutMs = Math.max(90000, Number(process.env.TELEGRAM_HANDLER_TIMEOUT_MS || 600000));
const ticketFetchConcurrency = Math.max(1, Number(process.env.TICKET_FETCH_CONCURRENCY || 12));
const bulkInputIdleMs = Math.max(1000, Number(process.env.BULK_INPUT_IDLE_MS || 3500));
const botOwnerId = String(process.env.BOT_OWNER_ID || "").trim();
const eventCheckConcurrency = Math.max(1, Number(process.env.EVENT_CHECK_CONCURRENCY || 30));

const bot = new Telegraf(token, {
  handlerTimeout: telegramHandlerTimeoutMs,
});
const pendingBulkInputsByChat = new Map();
const activeTicketChecksByChat = new Map();
const reportCacheByChat = new Map();
const pendingEventCheckByChat = new Map();
const accountRevisionByChat = new Map();
const pendingAccountDeletionByChat = new Map();
const deletingAccountsByChat = new Set();

const MENU_BUTTONS = {
  link: { ar: "🔗 ربط الحسابات", en: "🔗 Link Accounts" },
  tickets: { ar: "🎫 التذاكر", en: "🎫 Tickets" },
  moneyAccounts: { ar: "💰 الحسابات ذات الرصيد", en: "💰 Accounts with Money" },
  stopChecking: { ar: "🛑 إيقاف الربط", en: "🛑 Stop Linking" },
  linkedAccounts: { ar: "📂 الحسابات المرتبطة", en: "📂 Linked Accounts" },
  deleteAccounts: { ar: "🗑 حذف الحسابات المرتبطة", en: "🗑 Delete Linked Accounts" },
  status: { ar: "📊 الحالة", en: "📊 Status" },
  language: { ar: "🌐 اللغة", en: "🌐 Language" },
  help: { ar: "❓ المساعدة", en: "❓ Help" },
  cancel: { ar: "❌ إلغاء", en: "❌ Cancel" },
  admin: { ar: "👑 الإدارة", en: "👑 Admin" },
  support: { ar: "💬 الدعم", en: "💬 Support" },
  relink: { ar: "🔄 إعادة ربط المنتهية", en: "🔄 Re-link Expired" },
};

const REPORT_BUTTONS = {
  general: { ar: "📊 المعلومات العامة", en: "📊 General Info" },
  accountsWithTickets: { ar: "📧 الحسابات التي لديها تذاكر", en: "📧 Accounts With Tickets" },
  newTickets: { ar: "🆕 التذاكر الجديدة", en: "🆕 New Tickets" },
  organized: { ar: "🧾 تفاصيل التذاكر - منظم", en: "🧾 Organized Tickets" },
  bySection: { ar: "📑 التذاكر حسب القسم", en: "📑 Tickets by Section" },
  adjacent: { ar: "📍 المقاعد المتجاورة", en: "📍 Adjacent Seats" },
  scattered: { ar: "📌 المقاعد المتفرقة", en: "📌 Scattered Seats" },
  checkEvent: { ar: "🔍 فحص فعالية", en: "🔍 Check Event" },
  errors: { ar: "⚠️ تفاصيل الأخطاء", en: "⚠️ Error Details" },
  rerun: { ar: "🔄 إعادة الفحص", en: "🔄 Run Again" },
  back: { ar: "◀️ العودة للقائمة الرئيسية", en: "◀️ Back To Main Menu" },
};

const hasDefaultLinkPassword = Boolean(defaultLinkPassword);

function getLinkInputDescription(lang = "ar") {
  if (hasDefaultLinkPassword) {
    return lang === "en" ? "one email per line or email,password" : "كل حساب في سطر كبريد فقط أو email,password";
  }

  return lang === "en" ? "one account per line as email,password" : "كل حساب في سطر بالشكل email,password";
}

function getLinkExampleLines(lang = "ar") {
  if (hasDefaultLinkPassword) {
    return lang === "en"
      ? ["1- a@mail.com", "2- b@mail.com", "or:", "3- c@mail.com,anotherPass"]
      : ["1- a@mail.com", "2- b@mail.com", "أو:", "3- c@mail.com,anotherPass"];
  }

  return ["1- a@mail.com,pass1", "2- b@mail.com,pass2"];
}

const MESSAGES = {
  help: {
    ar: () =>
      [
        "بوت Webook جاهز.",
        `استخدم ${getButtonLabel("ar", "link")} ثم أرسل الحسابات.`,
        "بعد الربط سيجلب البوت التذاكر تلقائيا ويعرض لك خيارات التقارير.",
        `استخدم ${getButtonLabel("ar", "language")} لتغيير اللغة.`,
      ].join("\n"),
    en: () =>
      [
        "Webook bot is ready.",
        `Use ${getButtonLabel("en", "link")} and send the accounts.`,
        "After linking, the bot will fetch tickets automatically and show report options.",
        `Use ${getButtonLabel("en", "language")} to switch language.`,
      ].join("\n"),
  },
  start: {
    ar: ({ speed }) => `بوت Webook يعمل.\n\n${translate("ar", "help")}\n\n${speed}`,
    en: ({ speed }) => `Webook bot is running.\n\n${translate("en", "help")}\n\n${speed}`,
  },
  speedProfile: {
    ar: ({ concurrency, blockHeavyResources: block }) =>
      `إعداد السرعة: concurrency=${concurrency}, blockHeavyResources=${block}`,
    en: ({ concurrency, blockHeavyResources: block }) =>
      `Speed profile: concurrency=${concurrency}, blockHeavyResources=${block}`,
  },
  startLinking: {
    ar: ({ count, concurrency }) => `بدء ربط ${count} حساب${count === 1 ? "" : ""}. concurrency=${concurrency}`,
    en: ({ count, concurrency }) => `Starting automatic linking for ${count} account(s). concurrency=${concurrency}`,
  },
  linkProgress: {
    ar: ({ success, total, failed, processed }) =>
      [
        "جارٍ ربط الحسابات ⏳",
        `نجاح: ${success}/${total}`,
        `أخطاء: ${failed}/${total}`,
        `تمت المعالجة: ${processed}/${total}`,
      ].join("\n"),
    en: ({ success, total, failed, processed }) =>
      [
        "Linking accounts ⏳",
        `Success: ${success}/${total}`,
        `Errors: ${failed}/${total}`,
        `Processed: ${processed}/${total}`,
      ].join("\n"),
  },
  linkProgressDone: {
    ar: ({ success, total, failed, took }) =>
      ["اكتمل ربط الحسابات ✅", `نجاح: ${success}/${total}`, `أخطاء: ${failed}/${total}`, `المدة: ${took}ms`].join(
        "\n",
      ),
    en: ({ success, total, failed, took }) =>
      [
        "Account linking completed ✅",
        `Success: ${success}/${total}`,
        `Errors: ${failed}/${total}`,
        `Duration: ${took}ms`,
      ].join("\n"),
  },
  completedLinking: {
    ar: ({ success, failed, took }) => `اكتمل الربط. success=${success}, failed=${failed}, took=${took}ms`,
    en: ({ success, failed, took }) => `Completed. success=${success}, failed=${failed}, took=${took}ms`,
  },
  linkedLine: {
    ar: ({ accountId, username, cookiesCount, originsCount }) =>
      `${accountId} ${username}: تم الربط (cookies=${cookiesCount}, origins=${originsCount}, session=saved)`,
    en: ({ accountId, username, cookiesCount, originsCount }) =>
      `${accountId} ${username}: linked (cookies=${cookiesCount}, origins=${originsCount}, session=saved)`,
  },
  failedLine: {
    ar: ({ accountId, username, error }) => `${accountId} ${username}: فشل (${error})`,
    en: ({ accountId, username, error }) => `${accountId} ${username}: failed (${error})`,
  },
  failedBlockedLine: {
    ar: ({ username }) => `${username}: فشل تسجيل الدخول لأن الحساب محظور أو موقوف من Webook.`,
    en: ({ username }) => `${username}: failed to login because the account is blocked/banned by Webook.`,
  },
  noLinkedForLink: {
    ar: () =>
      `لا توجد حسابات مرتبطة بعد.\nاستخدم 🔗 ربط الحسابات وأرسل ${hasDefaultLinkPassword ? "البريد فقط أو email,password" : "email,password"} في كل سطر.`,
    en: () =>
      `No linked accounts yet.\nUse 🔗 Link Accounts and send ${hasDefaultLinkPassword ? "email only or email,password" : "email,password"} per line.`,
  },
  noLinkedForAccounts: {
    ar: "لا توجد حسابات مرتبطة بعد.\nاستخدم 🔗 ربط الحسابات لإضافتها.",
    en: "No linked accounts yet.\nUse 🔗 Link Accounts to add them.",
  },
  noLinkedForTickets: {
    ar: "لا توجد حسابات مرتبطة بعد.\nاستخدم 🔗 ربط الحسابات أولا.",
    en: "No linked accounts yet.\nUse 🔗 Link Accounts first.",
  },
  statusHeader: { ar: "📊 حالة الجلسات المحفوظة", en: "📊 Saved Session Status" },
  linkedAccountsHeader: { ar: "📂 الحسابات المرتبطة", en: "📂 Linked Accounts" },
  fetchingTickets: {
    ar: ({ count }) => `جارٍ جلب تفاصيل التذاكر لـ ${count} حساب...`,
    en: ({ count }) => `Fetching ticket details for ${count} account(s)...`,
  },
  ticketProgress: {
    ar: ({ success, total, failed, tickets, processed }) =>
      [
        "جارٍ فحص التذاكر ⏳",
        `نجاح: ${success}/${total}`,
        `أخطاء: ${failed}/${total}`,
        `إجمالي التذاكر: ${tickets}`,
        `تمت المعالجة: ${processed}/${total}`,
      ].join("\n"),
    en: ({ success, total, failed, tickets, processed }) =>
      [
        "Checking tickets ⏳",
        `Success: ${success}/${total}`,
        `Errors: ${failed}/${total}`,
        `Total tickets: ${tickets}`,
        `Processed: ${processed}/${total}`,
      ].join("\n"),
  },
  linkingAlreadyRunning: {
    ar: "يوجد ربط حسابات جارٍ بالفعل لهذا الحوار.",
    en: "Account linking is already running for this chat.",
  },
  linkProgressStopped: {
    ar: ({ success, total, failed, processed, took }) =>
      [
        "تم إيقاف ربط الحسابات ⏹️",
        `تمت المعالجة: ${processed}/${total}`,
        `نجاح: ${success}/${total}`,
        `أخطاء: ${failed}/${total}`,
        `المدة: ${took}ms`,
      ].join("\n"),
    en: ({ success, total, failed, processed, took }) =>
      [
        "Account linking stopped ⏹️",
        `Processed: ${processed}/${total}`,
        `Success: ${success}/${total}`,
        `Errors: ${failed}/${total}`,
        `Duration: ${took}ms`,
      ].join("\n"),
  },
  linkingStoppedNotice: {
    ar: "تم إيقاف ربط الحسابات. يمكنك تشغيل فحص التذاكر يدويا للحسابات التي تم ربطها.",
    en: "Account linking was stopped. You can run ticket checking manually for the accounts that were linked.",
  },
  stopCheckingHint: {
    ar: "يمكنك استخدام زر 🛑 إيقاف الربط لإيقاف بدء ربط الحسابات الجديدة.",
    en: "You can use 🛑 Stop Linking to stop starting new account links.",
  },
  stopCheckingRequested: {
    ar: "سيتم ايقاف ربط الحسابات الان",
    en: "Stop requested. The bot will stop the current linking operations now and will not start new accounts.",
  },
  stopCheckingAlreadyRequested: {
    ar: "تم طلب إيقاف ربط الحسابات بالفعل. انتظر حتى تنتهي العمليات الجارية.",
    en: "Stop has already been requested. Wait for the in-flight link requests to finish.",
  },
  stopCheckingNotRunning: {
    ar: "لا يوجد ربط حسابات جارٍ حاليا.",
    en: "There is no active account-linking run right now.",
  },
  ticketCheckAlreadyRunning: {
    ar: "يوجد فحص تذاكر جارٍ بالفعل لهذا الحوار.",
    en: "A ticket check is already running for this chat.",
  },
  reportStopped: {
    ar: ({ success, total, failed, tickets, processed }) =>
      [
        "تم إيقاف الفحص ⏹️",
        `تمت المعالجة: ${processed}/${total}`,
        `نجاح: ${success}/${total}`,
        `أخطاء: ${failed}/${total}`,
        `إجمالي التذاكر: ${tickets}`,
        "",
        "اختر كيف تريد عرض النتائج الحالية:",
      ].join("\n"),
    en: ({ success, total, failed, tickets, processed }) =>
      [
        "Check stopped ⏹️",
        `Processed: ${processed}/${total}`,
        `Success: ${success}/${total}`,
        `Errors: ${failed}/${total}`,
        `Total tickets: ${tickets}`,
        "",
        "Choose how you want to view the current results:",
      ].join("\n"),
  },
  promptAccountsInput: {
    ar: () =>
      [
        "أرسل الحسابات في الرسالة التالية.",
        `الصيغة: ${getLinkInputDescription("ar")}`,
        "يمكنك استخدام الترقيم مثل 1- email.",
        "إذا قسم تيليجرام القائمة إلى عدة رسائل متتالية فسيتم جمعها تلقائيا.",
        "مثال:",
        ...getLinkExampleLines("ar"),
      ].join("\n"),
    en: () =>
      [
        "Send accounts in the next message.",
        `Format: ${getLinkInputDescription("en")}`,
        "You can use numbering like 1- email.",
        "If Telegram splits the list into consecutive messages, the bot will combine them automatically.",
        "Example:",
        ...getLinkExampleLines("en"),
      ].join("\n"),
  },
  pendingCancelled: {
    ar: "تم إلغاء انتظار إدخال الحسابات.",
    en: "Pending account input cancelled.",
  },
  nothingPending: {
    ar: "لا يوجد شيء قيد الانتظار الآن.",
    en: "Nothing is pending right now.",
  },
  helpChangedToArabic: {
    ar: "تم تغيير اللغة إلى العربية.",
    en: "Language changed to Arabic.",
  },
  helpChangedToEnglish: {
    ar: "تم تغيير اللغة إلى الإنجليزية.",
    en: "Language changed to English.",
  },
  authOtpRequested: {
    ar: "تم إنشاء رمز تحقق مؤقت في كونسول السيرفر. أرسل الرمز هنا لإكمال الدخول.",
    en: "A one-time verification code was generated in the server console. Send it here to continue.",
  },
  authOtpStillPending: {
    ar: ({ seconds }) => `يوجد رمز تحقق نشط بالفعل. أرسل الرمز الحالي خلال ${seconds} ثانية.`,
    en: ({ seconds }) => `A verification code is already active. Send the current code within ${seconds} seconds.`,
  },
  authOtpInvalid: {
    ar: "رمز التحقق غير صحيح. أعد المحاولة باستخدام الرمز الموجود في الكونسول.",
    en: "The verification code is incorrect. Try again with the code shown in the console.",
  },
  authOtpExpired: {
    ar: "انتهت صلاحية رمز التحقق. أرسل أي رسالة ليتم إنشاء رمز جديد.",
    en: "The verification code expired. Send any message to generate a new one.",
  },
  authOtpApproved: {
    ar: "تم اعتماد هذا المستخدم بنجاح. يمكنك الآن استخدام البوت.",
    en: "This user has been approved successfully. You can use the bot now.",
  },
  unexpectedError: {
    ar: "حدث خطأ غير متوقع. راجع السجلات.",
    en: "Unexpected error occurred. Check logs.",
  },
  bulkLinkFailed: {
    ar: ({ error }) => `فشل ربط الحسابات: ${error}`,
    en: ({ error }) => `Bulk link failed: ${error}`,
  },
  accountStatusNoSession: {
    ar: ({ accountId, username }) => `⚪ ${accountId} • ${username}\nلا يوجد ملف جلسة محفوظ.`,
    en: ({ accountId, username }) => `⚪ ${accountId} • ${username}\nNo saved session file.`,
  },
  accountStatusUnreadable: {
    ar: ({ accountId, username }) => `⚠️ ${accountId} • ${username}\nملف الجلسة موجود لكن تعذر قراءته.`,
    en: ({ accountId, username }) => `⚠️ ${accountId} • ${username}\nSession file exists but could not be read.`,
  },
  linkedAccountLine: {
    ar: ({ accountId, username, parts }) => `📂 ${accountId} • ${username}\n${parts.join(" • ")}`,
    en: ({ accountId, username, parts }) => `📂 ${accountId} • ${username}\n${parts.join(" • ")}`,
  },
  noBookings: {
    ar: "لا توجد حجوزات لهذا الحساب.",
    en: "No bookings were found for this account.",
  },
  unauthorized: {
    ar: ({ error }) =>
      error
        ? `الجلسة المحفوظة غير مصرح بها. فشلت إعادة تسجيل الدخول التلقائي: ${error}`
        : "الجلسة المحفوظة غير مصرح بها. أعد الربط إذا استمرت المشكلة.",
    en: ({ error }) =>
      error
        ? `Saved session is unauthorized. Auto refresh failed: ${error}`
        : "Saved session is unauthorized. Link again if this keeps happening.",
  },
  autoRefreshed: {
    ar: "تم تحديث الجلسة تلقائيا قبل جلب التذاكر.",
    en: "Session refreshed automatically before fetching.",
  },
  detailMissing: {
    ar: ({ count }) => `بعض تفاصيل الطلبات غير متوفرة (${count}) وتم عرض الباقي.`,
    en: ({ count }) => `Some order details were missing (${count}), showing the rest.`,
  },
  requestFailed: {
    ar: "فشل الاتصال بخوادم Webook لهذا الحساب. حاول مرة أخرى بعد قليل.",
    en: "Webook requests failed for this account. Try again in a moment.",
  },
  fetchFailed: {
    ar: ({ accountId, username, error }) => `❌ ${accountId} • ${username}\nفشل الجلب: ${error}`,
    en: ({ accountId, username, error }) => `❌ ${accountId} • ${username}\nFetch failed: ${error}`,
  },
  moreTickets: {
    ar: ({ count }) => `... ويوجد ${count} تذكرة إضافية`,
    en: ({ count }) => `... and ${count} more tickets`,
  },
  reportReady: {
    ar: ({ success, total, failed, tickets }) => {
      const lines = [
        "اكتمل الفحص ✅",
        `نجاح: ${success}/${total}`,
        `أخطاء: ${failed}/${total}`,
        `إجمالي التذاكر: ${tickets}`,
      ];
      if (failed > 0) {
        lines.push("");
        lines.push("⚠️ يوجد حسابات بها أخطاء أو جلسات منتهية.");
        lines.push("💡 لمعرفة السبب اضغط '⚠️ تفاصيل الأخطاء'، أو أعد تسجيل الدخول فوراً عبر '🔄 إعادة ربط المنتهية'.");
      }
      lines.push("");
      lines.push("اختر كيف تريد عرض النتائج:");
      return lines.join("\n");
    },
    en: ({ success, total, failed, tickets }) => {
      const lines = [
        "Check completed ✅",
        `Success: ${success}/${total}`,
        `Errors: ${failed}/${total}`,
        `Total tickets: ${tickets}`,
      ];
      if (failed > 0) {
        lines.push("");
        lines.push("⚠️ Some accounts had errors or expired sessions.");
        lines.push("💡 Click '⚠️ Error Details' to see reasons, or '🔄 Re-link Expired' to re-login.");
      }
      lines.push("");
      lines.push("Choose how you want to view the results:");
      return lines.join("\n");
    },
  },
  reportCacheMissing: {
    ar: "لا يوجد تقرير محفوظ حاليا. نفذ فحص التذاكر أولا.",
    en: "No saved report is available yet. Run ticket check first.",
  },
  reportSent: {
    ar: ({ label }) => `تم إرسال ${label} ✅\nهل ترغب في مشاهدة تنسيق آخر؟`,
    en: ({ label }) => `${label} sent ✅\nDo you want another format?`,
  },
  accountsWithTicketsTitle: {
    ar: "📧 الحسابات التي لديها تذاكر",
    en: "📧 Accounts With Tickets",
  },
  noAccountsWithTickets: {
    ar: "لا توجد حسابات تحتوي على تذاكر في آخر فحص.",
    en: "There are no accounts with tickets in the last check.",
  },
  reportMenuAttached: {
    ar: "اختر من الأزرار بالأسفل.",
    en: "Choose from the buttons below.",
  },
  noAdjacentSeats: {
    ar: "لا توجد مقاعد متجاورة فعلية في آخر فحص، لذلك لم يتم إنشاء ملف.",
    en: "There are no actual adjacent seats in the last check, so no file was generated.",
  },
  noScatteredSeats: {
    ar: "لا توجد مقاعد متفرقة في آخر فحص، لأن كل التذاكر تقع ضمن مجموعات متجاورة.",
    en: "There are no scattered seats in the last check because every ticket is part of an adjacent group.",
  },
  returnedToMain: {
    ar: "تمت العودة إلى القائمة الرئيسية.",
    en: "Returned to the main menu.",
  },
  reportSummaryTitle: {
    ar: "📊 ملخص الفحص",
    en: "📊 Check Summary",
  },
};

function maskUser(username) {
  if (!username) return "unknown";
  const atIdx = username.indexOf("@");
  if (atIdx > 1) {
    return `${username.slice(0, 2)}***${username.slice(atIdx)}`;
  }

  return `${username.slice(0, 2)}***`;
}

function getButtonLabel(lang, key) {
  const record = MENU_BUTTONS[key];
  return record ? record[lang === "en" ? "en" : "ar"] : key;
}

function getReportButtonLabel(lang, key) {
  const record = REPORT_BUTTONS[key];
  return record ? record[lang === "en" ? "en" : "ar"] : key;
}

function getAllButtonTexts(key) {
  const record = MENU_BUTTONS[key];
  return record ? [record.ar, record.en] : [];
}

function getAllReportButtonTexts(key) {
  const record = REPORT_BUTTONS[key];
  return record ? [record.ar, record.en] : [];
}

function translate(lang, key, vars = {}) {
  const record = MESSAGES[key];
  const value = record ? record[lang === "en" ? "en" : "ar"] : "";
  if (typeof value === "function") {
    return value(vars);
  }

  return value || "";
}

async function getContextLanguage(ctx) {
  return getChatLanguage(ctx && ctx.chat ? ctx.chat.id : undefined);
}

function mainMenuKeyboard(lang = "ar", hasLinkedAccounts = false, isOwner = false) {
  const rows = [];
  if (hasLinkedAccounts) {
    rows.push([getButtonLabel(lang, "link"), getButtonLabel(lang, "tickets")]);
    rows.push([getButtonLabel(lang, "relink"), getButtonLabel(lang, "linkedAccounts")]);
    rows.push([getButtonLabel(lang, "language"), getButtonLabel(lang, "support")]);
  } else {
    rows.push([getButtonLabel(lang, "link"), getButtonLabel(lang, "relink")]);
    rows.push([getButtonLabel(lang, "language"), getButtonLabel(lang, "support")]);
  }
  rows.push([getButtonLabel(lang, "stopChecking"), getButtonLabel(lang, "deleteAccounts")]);
  if (isOwner) {
    rows.push([getButtonLabel(lang, "admin")]);
  }
  return Markup.keyboard(rows).resize();
}

function adminPanelKeyboard(lang = "ar") {
  return Markup.inlineKeyboard([
    [Markup.button.callback(lang === "en" ? "➕ Add Member" : "➕ إضافة عضو", "admin:add")],
    [Markup.button.callback(lang === "en" ? "➖ Remove Member" : "➖ إزالة عضو", "admin:remove")],
    [Markup.button.callback(lang === "en" ? "👥 Members" : "👥 الأعضاء", "admin:members")],
    [Markup.button.callback(lang === "en" ? "📋 Subscriptions" : "📋 الاشتراكات", "admin:subs")],
    [Markup.button.callback(lang === "en" ? "⚙️ Manage Subscriptions" : "⚙️ التحكم بالعضويات", "admin:manage")],
    [Markup.button.callback(lang === "en" ? "◀️ Back" : "◀️ رجوع", "admin:back")],
  ]);
}

function subPlanKeyboard(lang = "ar", targetId = "") {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("📅 1 Week", `admin:sub:${targetId}:1week`),
      Markup.button.callback("📅 1 Month", `admin:sub:${targetId}:1month`),
    ],
    [
      Markup.button.callback("📅 3 Months", `admin:sub:${targetId}:3months`),
      Markup.button.callback("♾️ Lifetime", `admin:sub:${targetId}:lifetime`),
    ],
    [Markup.button.callback(lang === "en" ? "◀️ Cancel" : "◀️ إلغاء", "admin:panel")],
  ]);
}

function manageSubKeyboard(lang = "ar", targetId = "") {
  return Markup.inlineKeyboard([
    [Markup.button.callback(lang === "en" ? "🔄 Change Plan" : "🔄 تغيير الخطة", `admin:chplan:${targetId}`)],
    [Markup.button.callback(lang === "en" ? "➕ Extend" : "➕ تمديد", `admin:extend:${targetId}`)],
    [Markup.button.callback(lang === "en" ? "🚫 Revoke" : "🚫 إلغاء الاشتراك", `admin:revoke:${targetId}`)],
    [Markup.button.callback(lang === "en" ? "◀️ Back" : "◀️ رجوع", "admin:panel")],
  ]);
}

function checkingMenuKeyboard(lang = "ar") {
  return Markup.keyboard([[getButtonLabel(lang, "stopChecking")]]).resize();
}

function reportMenuKeyboard(lang = "ar") {
  return Markup.keyboard([
    [getReportButtonLabel(lang, "general"), getReportButtonLabel(lang, "accountsWithTickets")],
    [getReportButtonLabel(lang, "newTickets"), getReportButtonLabel(lang, "checkEvent")],
    [getButtonLabel(lang, "moneyAccounts"), getReportButtonLabel(lang, "organized")],
    [getReportButtonLabel(lang, "adjacent"), getReportButtonLabel(lang, "bySection")],
    [getReportButtonLabel(lang, "scattered"), getReportButtonLabel(lang, "errors")],
    [getButtonLabel(lang, "relink"), getReportButtonLabel(lang, "rerun")],
    [getReportButtonLabel(lang, "back"), getButtonLabel(lang, "deleteAccounts")],
    [getButtonLabel(lang, "stopChecking")],
  ]).resize();
}

async function replyWithMenu(ctx, text, langOverride) {
  const lang = langOverride || (await getContextLanguage(ctx));
  const owner = getOwnerId(ctx);
  let hasLinked = false;
  try {
    hasLinked = (await Account.countDocuments({ owner, status: "linked" })) > 0;
  } catch {}
  const identity = getAuthIdentity(ctx);
  const ownerFlag = await isOwnerUser(identity.userId);
  await ctx.reply(text, mainMenuKeyboard(lang, hasLinked, ownerFlag));
}

async function replyWithReportMenu(ctx, text, langOverride) {
  const lang = langOverride || (await getContextLanguage(ctx));
  await ctx.reply(text, reportMenuKeyboard(lang));
}

async function replyWithCheckingMenu(ctx, text, langOverride) {
  const lang = langOverride || (await getContextLanguage(ctx));
  await ctx.reply(text, checkingMenuKeyboard(lang));
}

const telegramCooldowns = new Map();

function getTelegramCooldownMs(chatId) {
  if (!chatId) return 0;
  const until = telegramCooldowns.get(String(chatId)) || 0;
  return Math.max(0, until - Date.now());
}

function recordTelegramRateLimit(chatId, error) {
  const errText = String(error && error.message ? error.message : error);
  let retrySeconds = 5;
  const match = errText.match(/retry after (\d+)/i);
  if (match) {
    retrySeconds = Number(match[1]);
  } else if (error && error.parameters && typeof error.parameters.retry_after === "number") {
    retrySeconds = error.parameters.retry_after;
  }
  const cooldownUntil = Date.now() + (retrySeconds + 1) * 1000;
  telegramCooldowns.set(String(chatId), cooldownUntil);
  logger.warn("bot", "Telegram 429 rate limit recorded", {
    chatId: String(chatId),
    retrySeconds,
    cooldownUntil: new Date(cooldownUntil).toISOString(),
  });
  return retrySeconds;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createMessageEditor(ctx, initialText) {
  const chatId = ctx && ctx.chat ? String(ctx.chat.id) : undefined;
  let message = null;
  let lastSentText = "";
  let pendingText = "";
  let lastEditTime = 0;
  let timer = null;
  let isEditing = false;
  const MIN_INTERVAL_MS = 2500;

  async function flush() {
    if (isEditing) return;
    const now = Date.now();
    const elapsed = now - lastEditTime;

    if (elapsed < MIN_INTERVAL_MS) {
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          flush();
        }, MIN_INTERVAL_MS - elapsed);
      }
      return;
    }

    if (!message || !chatId || !pendingText || pendingText === lastSentText) {
      return;
    }

    const textToSend = pendingText;
    pendingText = "";

    const waitMs = getTelegramCooldownMs(chatId);
    if (waitMs > 0) {
      return;
    }

    isEditing = true;
    try {
      await ctx.telegram.editMessageText(chatId, message.message_id, undefined, textToSend);
      lastSentText = textToSend;
      lastEditTime = Date.now();
    } catch (error) {
      const errText = String(error && error.message ? error.message : error);
      if (errText.includes("429") || errText.includes("Too Many Requests")) {
        recordTelegramRateLimit(chatId, error);
      } else if (!errText.includes("message is not modified")) {
        logger.warn("bot", "Could not edit progress message", { error: errText });
      }
    } finally {
      isEditing = false;
      if (pendingText && pendingText !== lastSentText) {
        const remaining = MIN_INTERVAL_MS - (Date.now() - lastEditTime);
        if (!timer) {
          timer = setTimeout(() => {
            timer = null;
            flush();
          }, Math.max(0, remaining));
        }
      }
    }
  }

  function scheduleEdit(text) {
    pendingText = text;
    flush();
  }

  return {
    async send() {
      const waitMs = getTelegramCooldownMs(chatId);
      if (waitMs > 0) {
        await sleep(Math.min(waitMs, 10000));
      }
      try {
        message = await ctx.reply(initialText);
        lastSentText = initialText;
        lastEditTime = Date.now();
      } catch (error) {
        const errText = String(error && error.message ? error.message : error);
        if (errText.includes("429") || errText.includes("Too Many Requests")) {
          recordTelegramRateLimit(chatId, error);
        }
        throw error;
      }
      return message;
    },

    update(nextText) {
      if (!message || !chatId || !nextText || nextText === lastSentText) {
        return;
      }
      scheduleEdit(nextText);
    },

    async finish(nextText) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pendingText = "";

      const textToSend = nextText || lastSentText;
      if (!chatId || !textToSend) {
        return message;
      }

      let waitMs = getTelegramCooldownMs(chatId);
      if (waitMs > 0) {
        logger.info("bot", "Waiting for Telegram cooldown before sending final report", {
          chatId,
          waitMs,
        });
        await sleep(Math.min(waitMs, 10000));
      }

      const timeSinceLast = Date.now() - lastEditTime;
      if (timeSinceLast < MIN_INTERVAL_MS) {
        await sleep(MIN_INTERVAL_MS - timeSinceLast);
      }

      if (message && message.message_id) {
        try {
          await ctx.telegram.editMessageText(chatId, message.message_id, undefined, textToSend);
          lastSentText = textToSend;
          return message;
        } catch (error) {
          const errText = String(error && error.message ? error.message : error);
          if (errText.includes("message is not modified")) {
            return message;
          }
          if (errText.includes("429") || errText.includes("Too Many Requests")) {
            recordTelegramRateLimit(chatId, error);
            return message;
          }
          try {
            message = await ctx.reply(textToSend);
            return message;
          } catch {}
        }
      } else {
        try {
          message = await ctx.reply(textToSend);
        } catch {}
      }

      return message;
    },
  };
}

function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function getAuthIdentity(ctx) {
  const from = ctx && ctx.from ? ctx.from : {};
  return {
    userId: Number(from.id || 0),
    chatId: ctx && ctx.chat ? Number(ctx.chat.id || 0) : 0,
    username: from.username ? String(from.username) : "",
    firstName: from.first_name ? String(from.first_name) : "",
    lastName: from.last_name ? String(from.last_name) : "",
  };
}

async function getAllowedUserEntries() {
  await connectDb();
  return User.find({ $or: [{ isAllowed: true }, { isOwner: true }] })
    .sort({ createdAt: 1 })
    .lean()
    .exec();
}

async function isAllowedUser(userId) {
  const id = String(userId ?? "").trim();
  if (!id) {
    return false;
  }

  if (botOwnerId && id === botOwnerId) {
    return true;
  }

  await connectDb();
  return User.isAllowedUser(id);
}

async function isOwnerUser(userId) {
  const id = String(userId ?? "").trim();
  if (!id) {
    return false;
  }

  if (botOwnerId && id === botOwnerId) {
    return true;
  }

  await connectDb();
  const user = await User.findOne({ telegramId: id }).select("isOwner").lean().exec();
  return Boolean(user && user.isOwner);
}

async function authorizeUser(identity) {
  await connectDb();
  const telegramId = String(identity.userId || identity.telegramId || "").trim();
  if (!telegramId) {
    throw new Error("telegramId is required to authorize a user.");
  }

  return User.findOneAndUpdate(
    { telegramId },
    {
      $setOnInsert: { telegramId },
      $set: {
        isAllowed: true,
        username: identity.username || "",
        firstName: identity.firstName || "",
      },
    },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true },
  ).exec();
}

async function revokeUser(telegramId) {
  await connectDb();
  const id = String(telegramId ?? "").trim();
  if (!id) {
    return null;
  }

  return User.findOneAndUpdate({ telegramId: id }, { $set: { isAllowed: false } }, { returnDocument: "after" }).exec();
}

async function ensureBotOwner() {
  if (!botOwnerId) {
    logger.warn("auth", "BOT_OWNER_ID is not set; owner commands are disabled");
    return null;
  }

  await connectDb();
  const owner = await User.findOneAndUpdate(
    { telegramId: botOwnerId },
    { $setOnInsert: { telegramId: botOwnerId }, $set: { isOwner: true, isAllowed: true } },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true },
  ).exec();

  logger.success("auth", "Bot owner ensured", { telegramId: botOwnerId });
  return owner;
}

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

function normalizeStoredLiveApiHeaders(headers) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return null;
  }

  const normalized = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = String(rawKey || "")
      .trim()
      .toLowerCase();
    const value = String(rawValue || "").trim();
    if (!key || !value) {
      continue;
    }

    normalized[key] = value;
  }

  return Object.keys(normalized).length > 0 ? normalized : null;
}

function areHeaderMapsEqual(left, right) {
  const leftHeaders = normalizeStoredLiveApiHeaders(left) || {};
  const rightHeaders = normalizeStoredLiveApiHeaders(right) || {};
  const leftKeys = Object.keys(leftHeaders).sort();
  const rightKeys = Object.keys(rightHeaders).sort();

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  for (let index = 0; index < leftKeys.length; index += 1) {
    const key = leftKeys[index];
    if (key !== rightKeys[index] || leftHeaders[key] !== rightHeaders[key]) {
      return false;
    }
  }

  return true;
}

function applyLiveApiHeadersToAccount(account, liveApiHeaders, capturedAt = "") {
  if (liveApiHeaders === undefined) {
    return false;
  }

  const normalizedHeaders = normalizeStoredLiveApiHeaders(liveApiHeaders);
  if (!normalizedHeaders) {
    if (account.liveApiHeaders || account.liveApiHeadersCapturedAt) {
      account.liveApiHeaders = null;
      account.liveApiHeadersCapturedAt = "";
      return true;
    }

    return false;
  }

  const nextCapturedAt = typeof capturedAt === "string" && capturedAt.trim() ? capturedAt.trim() : "";
  const headersChanged = !areHeaderMapsEqual(account.liveApiHeaders, normalizedHeaders);
  const capturedAtChanged = account.liveApiHeadersCapturedAt !== nextCapturedAt;

  account.liveApiHeaders = normalizedHeaders;
  account.liveApiHeadersCapturedAt = nextCapturedAt;
  let tokenChanged = false;
  if (normalizedHeaders && normalizedHeaders.token && isUsableToken(normalizedHeaders.token)) {
    if (account.hexToken !== normalizedHeaders.token) {
      account.hexToken = normalizedHeaders.token;
      tokenChanged = true;
    }
  }
  return headersChanged || capturedAtChanged || tokenChanged;
}

async function getLinkedAccounts(ownerId) {
  const owner = normalizeOwnerId(ownerId);
  if (!owner) {
    return [];
  }

  await connectDb();
  const docs = await Account.find({ owner, status: "linked" }).sort({ createdAt: 1, email: 1 }).exec();
  return docs.map((doc, index) => toAccountRecord(doc, index));
}

async function getAllOwnerAccounts(ownerId) {
  const owner = normalizeOwnerId(ownerId);
  if (!owner) {
    return [];
  }

  await connectDb();
  const docs = await Account.find({ owner }).sort({ createdAt: 1, email: 1 }).exec();
  return docs.map((doc, index) => toAccountRecord(doc, index));
}

function normalizeOwnerId(ownerId) {
  if (ownerId === null || ownerId === undefined) {
    return "";
  }

  return String(ownerId).trim();
}

function getOwnerId(ctx) {
  return normalizeOwnerId(ctx && ctx.chat ? ctx.chat.id : "");
}

function toAccountRecord(doc, index = 0) {
  const record = {
    accountId: `account${index + 1}`,
    docId: String(doc._id),
    owner: doc.owner,
    username: doc.email || "",
    usernameMasked: maskUser(doc.email || ""),
    password: "",
    status: doc.status || "pending",
    jwt: doc.jwt || "",
    hexToken: doc.hexToken || "",
    lastLinkedAt: doc.linkedAt ? new Date(doc.linkedAt).toISOString() : "",
    lastAutoRefreshAt: doc.lastCheckAt ? new Date(doc.lastCheckAt).toISOString() : "",
    lastError: doc.lastError || "",
    liveApiHeaders: normalizeStoredLiveApiHeaders(doc.liveApiHeaders),
    liveApiHeadersCapturedAt:
      typeof doc.liveApiHeadersCapturedAt === "string" ? doc.liveApiHeadersCapturedAt.trim() : "",
    hasSessionData: Boolean(doc.sessionData),
    knownTicketKeys: Array.isArray(doc.knownTicketKeys) ? [...doc.knownTicketKeys] : [],
    lastTicketCount: Number(doc.lastTicketCount || 0),
  };

  Object.defineProperty(record, "getPassword", {
    enumerable: false,
    value: () => {
      try {
        return doc.getPassword();
      } catch {
        return "";
      }
    },
  });
  Object.defineProperty(record, "doc", { enumerable: false, value: doc });

  return record;
}

async function loadAccountSession(record) {
  if (!record) {
    return null;
  }

  if (record.doc) {
    return record.doc.getSessionData();
  }

  await connectDb();
  const doc = await Account.findById(record.docId).exec();
  return doc ? doc.getSessionData() : null;
}

async function accountHasSession(record) {
  if (!record || !record.docId) {
    return false;
  }

  if (record.doc) {
    return record.status === "linked" && Boolean(record.doc.sessionData);
  }

  await connectDb();
  const doc = await Account.findById(record.docId).select("status sessionData").lean().exec();
  return Boolean(doc && doc.status === "linked" && doc.sessionData);
}

async function persistAccountRecord(record) {
  if (!record || !record.docId) {
    return;
  }

  try {
    await connectDb();
    await Account.updateOne(
      { _id: record.docId },
      {
        $set: {
          liveApiHeaders: normalizeStoredLiveApiHeaders(record.liveApiHeaders),
          liveApiHeadersCapturedAt: record.liveApiHeadersCapturedAt || "",
          lastCheckAt: new Date(),
        },
      },
    ).exec();
  } catch (error) {
    logger.warn("accounts", "Could not persist account headers", {
      accountId: record.accountId,
      error: error.message,
    });
  }
}

function isMenuButtonText(text) {
  return Object.values(MENU_BUTTONS)
    .flatMap((value) => [value.ar, value.en])
    .includes((text || "").trim());
}

function getDisplayedUsername(account) {
  return account.username || account.usernameMasked || account.accountId;
}

function formatShortTimestamp(value, lang = "ar") {
  if (!value) {
    return lang === "en" ? "unknown" : "غير معروف";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(lang === "en" ? "en-GB" : "ar-EG", {
    numberingSystem: lang === "en" ? "latn" : "latn",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

function buildTicketBlock(row, account, lang, index, totalCount) {
  const lines = [
    `${lang === "en" ? "Account" : "الحساب"}: ${getDisplayedUsername(account)}`,
    `${lang === "en" ? "Event" : "اسم الفعالية"}: ${row.eventName}`,
    `${lang === "en" ? "Section" : "القسم"}: ${row.section || "-"}`,
    `${lang === "en" ? "Row" : "الصف"}: ${row.row || "-"}`,
    `${lang === "en" ? "Seat" : "المقعد"}: ${row.seat}`,
    `${lang === "en" ? "Category" : "الفئة"}: ${row.category || "-"}`,
    `${lang === "en" ? "Event Date" : "تاريخ الفعالية"}: ${formatShortTimestamp(row.time, lang)}`,
  ];

  if (totalCount > 1) {
    lines.unshift(`${lang === "en" ? "Ticket" : "التذكرة"}: ${index + 1}`);
  }

  return lines.join("\n");
}

function getStatusMessage(lang, result, refreshInfo) {
  if (result.status === "linked-but-unauthorized") {
    return translate(lang, "unauthorized", { error: refreshInfo && refreshInfo.error ? refreshInfo.error : "" });
  }

  if (refreshInfo && refreshInfo.refreshed) {
    return translate(lang, "autoRefreshed");
  }

  if (result.status === "no-bookings-found") {
    return translate(lang, "noBookings");
  }

  if (result.status === "order-detail-endpoint-missing") {
    const missingCount = result.diagnostics ? result.diagnostics.detailMissingCount : 0;
    return translate(lang, "detailMissing", { count: missingCount });
  }

  if (result.status === "request-failed") {
    return translate(lang, "requestFailed");
  }

  return "";
}

function buildAccountTicketSummary(account, result, lang, refreshInfo = { refreshed: false, error: "" }) {
  const blocks = [];

  const statusMessage = getStatusMessage(lang, result, refreshInfo);
  if (statusMessage) {
    blocks.push(`${lang === "en" ? "Account" : "الحساب"}: ${getDisplayedUsername(account)}\n${statusMessage}`);
  }

  for (const [index, row] of result.tickets.slice(0, 20).entries()) {
    blocks.push(buildTicketBlock(row, account, lang, index, result.tickets.length));
  }

  if (result.tickets.length > 20) {
    blocks.push(translate(lang, "moreTickets", { count: result.tickets.length - 20 }));
  }

  if (blocks.length === 0) {
    blocks.push(
      `${lang === "en" ? "Account" : "الحساب"}: ${getDisplayedUsername(account)}\n${translate(lang, "noBookings")}`,
    );
  }

  return blocks.join("\n\n");
}

function splitReplyBlocks(blocks, maxLength = 3400) {
  const chunks = [];
  let current = "";

  for (const block of blocks) {
    const next = current ? `${current}\n\n${block}` : block;
    if (next.length <= maxLength) {
      current = next;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    if (block.length <= maxLength) {
      current = block;
      continue;
    }

    for (let start = 0; start < block.length; start += maxLength) {
      chunks.push(block.slice(start, start + maxLength));
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function splitReplyLines(lines, maxLength = 3400) {
  const chunks = [];
  let current = "";

  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= maxLength) {
      current = next;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    if (line.length <= maxLength) {
      current = line;
      continue;
    }

    for (let start = 0; start < line.length; start += maxLength) {
      chunks.push(line.slice(start, start + maxLength));
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function getPendingBulkInputKey(chatId) {
  return String(chatId);
}

function resetPendingBulkInput(chatId) {
  clearPendingBulkInput(chatId);
  const entry = {
    parts: [],
    timer: null,
    ctx: null,
  };
  pendingBulkInputsByChat.set(getPendingBulkInputKey(chatId), entry);
  return entry;
}

function getPendingBulkInput(chatId) {
  return pendingBulkInputsByChat.get(getPendingBulkInputKey(chatId)) || null;
}

function clearPendingBulkInput(chatId) {
  const key = getPendingBulkInputKey(chatId);
  const existing = pendingBulkInputsByChat.get(key);
  if (existing && existing.timer) {
    clearTimeout(existing.timer);
  }
  const existed = Boolean(existing);
  pendingBulkInputsByChat.delete(key);
  return existed;
}

function schedulePendingBulkInputProcessing(chatId) {
  const entry = getPendingBulkInput(chatId);
  if (!entry) {
    return;
  }

  if (entry.timer) {
    clearTimeout(entry.timer);
  }

  entry.timer = setTimeout(() => {
    const latest = getPendingBulkInput(chatId);
    if (!latest || !latest.ctx || latest.parts.length === 0) {
      clearPendingBulkInput(chatId);
      return;
    }

    const finalCtx = latest.ctx;
    const combinedText = latest.parts.join("\n");
    clearPendingBulkInput(chatId);

    void (async () => {
      const lang = await getContextLanguage(finalCtx);
      try {
        await handleBulkLinkRequest(finalCtx, combinedText);
      } catch (error) {
        logger.error("link", "Bulk link background task failed", {
          error: error.message,
        });
        await replyWithMenu(finalCtx, translate(lang, "bulkLinkFailed", { error: error.message }), lang);
      }
    })();
  }, bulkInputIdleMs);

  if (typeof entry.timer.unref === "function") {
    entry.timer.unref();
  }
}

function sanitizeAccountUsername(value) {
  return String(value || "")
    .replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E\u00A0]/g, "")
    .trim();
}

function normalizeBulkAccountLine(line) {
  return sanitizeAccountUsername(line)
    .replace(/^\s*\d+\s*[-.)]\s*/, "")
    .replace(/^\s*[-*]\s*/, "")
    .trim();
}

function getBulkAccountLineOrder(line) {
  const match = String(line || "").match(/^\s*(\d+)\s*[-.)]\s*/);
  return match ? Number(match[1]) : null;
}

async function queuePendingBulkInputText(ctx, text) {
  const chatId = ctx && ctx.chat ? ctx.chat.id : undefined;
  if (chatId === undefined || chatId === null) {
    return false;
  }

  const chunk = String(text || "").trim();
  if (!chunk) {
    return false;
  }

  const entry = getPendingBulkInput(chatId) || resetPendingBulkInput(chatId);
  entry.parts.push(chunk);
  entry.ctx = ctx;
  schedulePendingBulkInputProcessing(chatId);

  return true;
}

function buildAccountsWithTicketsRows(report) {
  const accounts = Array.isArray(report && report.accounts) ? report.accounts : [];

  return accounts
    .filter((entry) => entry && entry.ok && entry.result && Number(entry.result.ticketCount || 0) > 0)
    .map((entry) => ({
      accountName:
        (entry.account && (entry.account.username || entry.account.usernameMasked || entry.account.accountId)) ||
        "unknown",
      ticketCount: Number(entry.result.ticketCount || 0),
    }));
}

function parseBulkAccounts(text, lang = "ar") {
  const normalized = (text || "")
    .replace(/\r/g, "")
    .replace(/\n+/g, "\n")
    .replace(/\s*;\s*/g, "\n");

  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    throw new Error(
      lang === "en"
        ? `Usage: /linklist then ${getLinkInputDescription("en")}`
        : `الاستخدام: /linklist ثم ${getLinkInputDescription("ar")}`,
    );
  }

  const dataLines = lines[0].startsWith("/") ? lines.slice(1) : lines;
  if (dataLines.length === 0) {
    throw new Error(
      lang === "en"
        ? `Send accounts after /linklist. Format: ${getLinkInputDescription("en")}.`
        : `أرسل الحسابات بعد /linklist. الصيغة: ${getLinkInputDescription("ar")}.`,
    );
  }

  const parsed = [];
  for (let i = 0; i < dataLines.length; i += 1) {
    const rawLine = dataLines[i];
    const orderIndex = getBulkAccountLineOrder(rawLine);
    const line = normalizeBulkAccountLine(rawLine);
    const separatorIdx = line.indexOf(",");
    const username = sanitizeAccountUsername(separatorIdx === -1 ? line.trim() : line.slice(0, separatorIdx).trim());
    let password = separatorIdx === -1 ? "" : line.slice(separatorIdx + 1).trim();

    if (separatorIdx === -1 && hasDefaultLinkPassword) {
      password = defaultLinkPassword;
    } else if (!password && hasDefaultLinkPassword) {
      password = defaultLinkPassword;
    }

    if (separatorIdx === -1 && !hasDefaultLinkPassword) {
      throw new Error(
        lang === "en"
          ? `Line ${i + 1}: invalid format. Use email,password`
          : `السطر ${i + 1}: صيغة غير صحيحة. استخدم email,password`,
      );
    }

    if (!username || !password) {
      throw new Error(
        lang === "en"
          ? `Line ${i + 1}: both email/username and password are required`
          : `السطر ${i + 1}: البريد الإلكتروني أو اسم المستخدم وكلمة المرور مطلوبان`,
      );
    }

    parsed.push({ username, password, orderIndex, inputIndex: i });
  }

  if (parsed.length > 0 && parsed.every((entry) => Number.isFinite(entry.orderIndex))) {
    parsed.sort((left, right) => {
      if (left.orderIndex !== right.orderIndex) {
        return left.orderIndex - right.orderIndex;
      }

      return left.inputIndex - right.inputIndex;
    });
  }

  return parsed.map(({ username, password }) => ({ username, password }));
}

async function handleBulkLinkRequest(ctx, inputText) {
  const owner = getOwnerId(ctx);
  loginControl.resume(owner);
  return loginControl.run(owner, (signal) => submitBulkLinkRequest(ctx, inputText, signal));
}

async function submitBulkLinkRequest(ctx, inputText, signal) {
  const lang = await getContextLanguage(ctx);
  const owner = getOwnerId(ctx);
  const credsList = parseBulkAccounts(inputText || "", lang);

  try {
    const emailArchive = await appendKnownEmails(credsList.map((entry) => entry.username));
    logger.info("link", "Archived submitted emails", {
      submitted: credsList.length,
      added: emailArchive.added,
      total: emailArchive.total,
      file: emailArchive.filePath,
    });
  } catch (error) {
    logger.warn("link", "Could not archive submitted emails", {
      error: error.message,
    });
  }

  logger.info("link", "Bulk link requested", { owner, accounts: credsList.length });
  await connectDb();

  let queued = 0;
  const failures = [];

  let skipped = 0;
  for (const entry of credsList) {
    if (signal.aborted) break;
    try {
      const account = await Account.upsertCredentials(owner, entry.username, entry.password);
      if (signal.aborted) break;

      if (account.status === "linked" && account.jwt && account.hexToken) {
        skipped += 1;
        continue;
      }
      await queueLoginJob(owner, account._id);
      queued += 1;
    } catch (error) {
      logger.error("link", "Could not queue account", {
        owner,
        user: entry.username,
        error: error.message,
      });
      failures.push({ username: entry.username, error: error.message });
    }
  }

  if (signal.aborted) return;

  let acceptedText;
  if (skipped > 0 && queued === 0) {
    acceptedText =
      lang === "en" ? `✅ All ${skipped} account(s) are already linked.` : `✅ كل ${skipped} حساب مربوط بالفعل.`;
  } else if (skipped > 0) {
    acceptedText =
      lang === "en"
        ? `✅ Received ${queued} new account(s). ${skipped} already linked. Linking in background...`
        : `✅ تم استلام ${queued} حساب جديد. ${skipped} مربوط بالفعل. جاري الربط في الخلفية...`;
  } else {
    acceptedText =
      lang === "en"
        ? `✅ Received ${queued} account(s). Linking in the background...`
        : `✅ تم استلام ${queued} حساب. جاري الربط في الخلفية...`;
  }
  await replyWithMenu(ctx, acceptedText, lang);

  if (failures.length > 0) {
    const header = lang === "en" ? "⚠️ Could not queue:" : "⚠️ لم يتم إضافة:";
    const lines = [header, ...failures.map((row) => `• ${maskUser(row.username)}: ${row.error}`)];
    for (const chunk of splitReplyLines(lines)) {
      await replyWithMenu(ctx, chunk, lang);
    }
  }
}

const loginProgressState = new Map();

function categorizeLoginError(rawError, lang = "ar") {
  const err = String(rawError || "").toLowerCase();

  if (
    err.includes("password") ||
    err.includes("credential") ||
    err.includes("غير صحيحة") ||
    err.includes("invalid-credentials") ||
    err.includes("incorrect email")
  ) {
    return {
      key: "credentials",
      label: lang === "en" ? "🔴 Wrong password / email" : "🔴 كلمة المرور أو البريد غير صحيح",
      cause: lang === "en" ? "Incorrect password or unregistered email." : "كلمة المرور غير صحيحة أو البريد غير مسجل.",
    };
  }

  if (
    err.includes("blocked") ||
    err.includes("حظر") ||
    err.includes("locked") ||
    err.includes("malicious") ||
    err.includes("account-blocked")
  ) {
    return {
      key: "blocked",
      label: lang === "en" ? "🚫 Account blocked / locked" : "🚫 الحساب محظور أو مقيد",
      cause: lang === "en" ? "Webook blocked this account due to suspicious activity." : "تم حظر الحساب من Webook لأسباب أمنية.",
    };
  }

  if (err.includes("decrypt") || err.includes("stored password")) {
    return {
      key: "decrypt",
      label: lang === "en" ? "🔑 Saved password corrupted" : "🔑 تعذر قراءة كلمة المرور المخزنة",
      cause: lang === "en" ? "Stored password cannot be decrypted." : "تعذر فك تشفير كلمة المرور المخزنة.",
    };
  }

  if (err.includes("timeout") || err.includes("مهلة") || err.includes("exceeded")) {
    return {
      key: "timeout",
      label: lang === "en" ? "⏳ Timeout / Slow response" : "⏳ انتهاء المهلة (بطء استجابة الموقع)",
      cause: lang === "en" ? "Webook took too long to respond." : "استغرق موقع Webook وقتاً طويلاً وانتهت المهلة.",
    };
  }

  if (err.includes("jwt") || err.includes("token")) {
    return {
      key: "token",
      label: lang === "en" ? "⚠️ Session token missing" : "⚠️ فشل استخراج جلسة الدخول",
      cause: lang === "en" ? "Login finished without auth token." : "اكتمل الدخول ولكن لم يُصدر الموقع رمز الجلسة.",
    };
  }

  if (err.includes("field") || err.includes("locator") || err.includes("submit button")) {
    return {
      key: "page",
      label: lang === "en" ? "🌐 Page loading issue" : "🌐 تعذر تحميل صفحة الدخول",
      cause: lang === "en" ? "Login form elements did not render." : "لم تظهر عناصر صفحة تسجيل الدخول.",
    };
  }

  if (err.includes("temporary") || err.includes("something went wrong") || err.includes("حدث خطأ")) {
    return {
      key: "temporary",
      label: lang === "en" ? "🟡 Temporary server error" : "🟡 خطأ مؤقت من سيرفر Webook",
      cause: lang === "en" ? "Webook returned a temporary error." : "أظهر سيرفر Webook خطأ مؤقتاً.",
    };
  }

  const clean = String(rawError || "").split("\n")[0].trim().slice(0, 50);
  return {
    key: "other",
    label: clean ? `⚪ ${clean}` : (lang === "en" ? "⚪ Other error" : "⚪ خطأ غير محدد"),
    cause: clean || "Unknown error",
  };
}

function formatFailedAccountsSummary(failedAccounts, lang = "ar") {
  if (!Array.isArray(failedAccounts) || failedAccounts.length === 0) {
    return "";
  }

  const count = failedAccounts.length;
  const header =
    lang === "en"
      ? `\n\n⚠️ Failed Accounts Details (${count}):`
      : `\n\n⚠️ تفاصيل أسباب فشل الربط (${count} حساب):`;

  if (count <= 15) {
    const lines = failedAccounts.map((item) => {
      const email = item.email || item.username || "unknown";
      const cat = categorizeLoginError(item.error, lang);
      const cleanLabel = cat.label.replace(/^[🔴🚫🔑⏳⚠️🌐🟡⚪]\s*/, "");
      return `• ${email}\n  ↳ ${cleanLabel}`;
    });
    return `${header}\n${lines.join("\n")}`;
  }

  const grouped = new Map();
  for (const item of failedAccounts) {
    const email = item.email || item.username || "unknown";
    const cat = categorizeLoginError(item.error, lang);
    if (!grouped.has(cat.key)) {
      grouped.set(cat.key, { label: cat.label, emails: [] });
    }
    grouped.get(cat.key).emails.push(email);
  }

  const groupLines = [];
  for (const [, group] of grouped) {
    const totalInGroup = group.emails.length;
    const preview = group.emails.slice(0, 6).join(", ");
    const remaining = totalInGroup > 6 ? ` ... (+${totalInGroup - 6})` : "";
    groupLines.push(`• ${group.label} (${totalInGroup}):\n  ${preview}${remaining}`);
  }

  return `${header}\n${groupLines.join("\n\n")}`;
}

async function notifyLoginProgress(progress) {
  const owner = String(progress && progress.owner ? progress.owner : "").trim();
  if (!owner) {
    return;
  }

  const lang = await getChatLanguage(owner);
  if (loginControl.isPaused(owner)) return;
  const { succeeded, failed, completed, total, finished, failedAccounts = [] } = progress;

  let text;
  if (finished) {
    const baseText =
      lang === "en"
        ? `🏁 Linking finished: ✅ ${succeeded} linked, ❌ ${failed} failed (of ${total}).`
        : `🏁 اكتمل الربط: ✅ ${succeeded} مرتبط، ❌ ${failed} فاشل (من ${total}).`;

    let failureDetails = failedAccounts || [];
    if (failed > 0 && failureDetails.length === 0) {
      try {
        const dbFailed = await Account.find({ owner, status: "failed" })
          .sort({ updatedAt: -1 })
          .limit(Math.min(failed, 50))
          .exec();
        failureDetails = dbFailed.map((a) => ({
          email: a.email,
          error: a.lastError || "Login failed",
        }));
      } catch {}
    }

    const failureSummary = failed > 0 ? formatFailedAccountsSummary(failureDetails, lang) : "";
    text = `${baseText}${failureSummary}`;
    if (text.length > 3900) {
      text = text.slice(0, 3850) + (lang === "en" ? "\n\n... (truncated)" : "\n\n... (تم اختصار القائمة لتناسب الرسالة)");
    }
  } else {
    text =
      lang === "en"
        ? `⏳ Linking accounts...\n✅ Success: ${succeeded}/${total}\n❌ Errors: ${failed}/${total}\n📦 Processed: ${completed}/${total}`
        : `⏳ جارٍ ربط الحسابات...\n✅ نجاح: ${succeeded}/${total}\n❌ أخطاء: ${failed}/${total}\n📦 تمت المعالجة: ${completed}/${total}`;
  }

  let ownerState = loginProgressState.get(owner);
  if (!ownerState) {
    ownerState = {
      msgId: null,
      lastSentText: "",
      lastEditTime: 0,
      pendingText: "",
      timer: null,
      isEditing: false,
    };
    loginProgressState.set(owner, ownerState);
  }

  if (finished) {
    if (ownerState.timer) {
      clearTimeout(ownerState.timer);
      ownerState.timer = null;
    }

    const waitMs = getTelegramCooldownMs(owner);
    if (waitMs > 0) {
      await sleep(Math.min(waitMs, 10000));
    }

    const timeSinceLast = Date.now() - ownerState.lastEditTime;
    if (timeSinceLast < 2500) {
      await sleep(2500 - timeSinceLast);
    }

    if (ownerState.msgId) {
      try {
        await bot.telegram.editMessageText(owner, ownerState.msgId, undefined, text);
      } catch (editErr) {
        const errMsg = String(editErr && editErr.message ? editErr.message : editErr);
        if (errMsg.includes("429") || errMsg.includes("Too Many Requests")) {
          const cooldownSec = recordTelegramRateLimit(owner, editErr);
          if (cooldownSec > 0 && cooldownSec <= 30) {
            await sleep(cooldownSec * 1000 + 500);
            await bot.telegram.editMessageText(owner, ownerState.msgId, undefined, text).catch(async () => {
              await bot.telegram.sendMessage(owner, text).catch(() => {});
            });
          }
        } else if (!errMsg.includes("message is not modified")) {
          try {
            await bot.telegram.sendMessage(owner, text);
          } catch {}
        }
      }
    } else {
      try {
        await bot.telegram.sendMessage(owner, text);
      } catch (err) {
        const errMsg = String(err && err.message ? err.message : err);
        if (errMsg.includes("429") || errMsg.includes("Too Many Requests")) {
          const cooldownSec = recordTelegramRateLimit(owner, err);
          if (cooldownSec > 0 && cooldownSec <= 30) {
            await sleep(cooldownSec * 1000 + 500);
            await bot.telegram.sendMessage(owner, text).catch(() => {});
          }
        }
      }
    }

    loginProgressState.delete(owner);

    if (loginControl.isPaused(owner)) return;

    try {
      const accounts = await getLinkedAccounts(owner);
      if (accounts.length === 0) {
        return;
      }

      if (getActiveTicketCheck(owner)) {
        logger.info("link", "Skipping post-link report; one is already running", { owner });
        return;
      }

      const postWait = getTelegramCooldownMs(owner);
      if (postWait > 0) {
        logger.info("link", "Waiting for Telegram cooldown before starting ticket report", { owner, postWait });
        await sleep(postWait);
      }

      const reportCtx = createOwnerContext(owner);
      if (loginControl.isPaused(owner)) return;
      const reportLang = await getChatLanguage(owner);
      try {
        await replyWithMenu(reportCtx, translate(reportLang, "fetchingTickets", { count: accounts.length }), reportLang);
      } catch (menuErr) {
        const errStr = String(menuErr && menuErr.message ? menuErr.message : menuErr);
        if (errStr.includes("429") || errStr.includes("Too Many Requests")) {
          const waitSec = recordTelegramRateLimit(owner, menuErr);
          await sleep(waitSec * 1000 + 1000);
          await replyWithMenu(reportCtx, translate(reportLang, "fetchingTickets", { count: accounts.length }), reportLang).catch(() => {});
        }
      }
      if (loginControl.isPaused(owner)) return;
      await runTicketReportFlow(reportCtx, accounts, reportLang);
    } catch (error) {
      logger.error("link", "Post-link ticket report failed", { owner, error: error.message });
    }
    return;
  }

  ownerState.pendingText = text;

  async function flushOwnerProgress() {
    if (loginControl.isPaused(owner)) return;
    if (ownerState.isEditing) return;
    const now = Date.now();
    const elapsed = now - ownerState.lastEditTime;

    if (elapsed < 2500) {
      if (!ownerState.timer) {
        ownerState.timer = setTimeout(() => {
          ownerState.timer = null;
          flushOwnerProgress();
        }, 2500 - elapsed);
      }
      return;
    }

    if (!ownerState.pendingText || ownerState.pendingText === ownerState.lastSentText) {
      return;
    }

    const currentText = ownerState.pendingText;
    ownerState.pendingText = "";

    if (getTelegramCooldownMs(owner) > 0) {
      return;
    }

    ownerState.isEditing = true;
    try {
      if (ownerState.msgId) {
        await bot.telegram.editMessageText(owner, ownerState.msgId, undefined, currentText);
      } else {
        const sent = await bot.telegram.sendMessage(owner, currentText);
        ownerState.msgId = sent.message_id;
      }
      ownerState.lastSentText = currentText;
      ownerState.lastEditTime = Date.now();
    } catch (err) {
      const errText = String(err && err.message ? err.message : err);
      if (errText.includes("429") || errText.includes("Too Many Requests")) {
        recordTelegramRateLimit(owner, err);
      } else if (errText.includes("message to edit not found")) {
        ownerState.msgId = null;
      } else if (!errText.includes("message is not modified")) {
        logger.warn("link", "Could not deliver login progress", { owner, error: errText });
      }
    } finally {
      ownerState.isEditing = false;
      if (ownerState.pendingText && ownerState.pendingText !== ownerState.lastSentText) {
        const remaining = 2500 - (Date.now() - ownerState.lastEditTime);
        if (!ownerState.timer) {
          ownerState.timer = setTimeout(() => {
            ownerState.timer = null;
            flushOwnerProgress();
          }, Math.max(0, remaining));
        }
      }
    }
  }

  flushOwnerProgress();
}

function createOwnerContext(owner) {
  const chatId = String(owner);
  return {
    chat: { id: chatId },
    from: { id: Number(chatId) || 0 },
    telegram: bot.telegram,
    reply: (text, extra) => bot.telegram.sendMessage(chatId, text, extra),
    replyWithDocument: (document, extra) => bot.telegram.sendDocument(chatId, document, extra),
  };
}

async function getSessionStatusInfo(account) {
  const exists = await accountHasSession(account);
  const credentialsSaved = Boolean(account.username && account.getPassword && account.getPassword());

  if (!exists) {
    return {
      accountId: account.accountId,
      exists: false,
      decryptOk: false,
      auth: null,
      credentialsSaved,
      lastLinkedAt: account.lastLinkedAt || "",
      lastAutoRefreshAt: account.lastAutoRefreshAt || "",
    };
  }

  try {
    const state = await loadAccountSession(account);
    if (!state) {
      throw new Error("Session data could not be decrypted.");
    }

    return {
      accountId: account.accountId,
      exists: true,
      decryptOk: true,
      auth: getAuthSummary(state),
      credentialsSaved,
      lastLinkedAt: account.lastLinkedAt || "",
      lastAutoRefreshAt: account.lastAutoRefreshAt || "",
    };
  } catch (error) {
    return {
      accountId: account.accountId,
      exists: true,
      decryptOk: false,
      auth: null,
      credentialsSaved,
      lastLinkedAt: account.lastLinkedAt || "",
      lastAutoRefreshAt: account.lastAutoRefreshAt || "",
      error: error.message,
    };
  }
}

async function logoutAndRequeueAccount(account, reason = "Session expired.") {
  if (!account || !account.docId || !account.owner) {
    return { ok: false, error: "no saved credentials" };
  }

  try {
    await Account.expireSessionForReauth(account.owner, account.docId, reason);
  } catch (error) {
    logger.warn("link", "Could not clear stale account session before re-login", {
      accountId: account.accountId,
      owner: account.owner,
      error: error.message,
    });
  }

  try {
    await queueLoginJob(account.owner, account.docId);
    logger.info("link", "Logged out stale session and requeued account for re-login", {
      accountId: account.accountId,
      owner: account.owner,
      reason,
    });
    return { ok: true, queued: true, error: "re-login queued" };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function refreshSavedSession(account) {
  return logoutAndRequeueAccount(account, "Session expired while refreshing saved login.");
}

async function fetchTicketsWithRecovery(account) {
  const storageState = await loadAccountSession(account);
  if (!storageState && !account.jwt) {
    return {
      result: {
        accountId: account.accountId,
        status: "linked-but-unauthorized",
        ticketCount: 0,
        tickets: [],
        walletBalance: null,
        walletCurrency: "",
        deviceVerified: null,
        probed: [],
        bookingIdsFound: 0,
        diagnostics: {},
      },
      refreshed: false,
      refreshError: "No stored session or token.",
      accountUpdated: false,
    };
  }

  const result = await fetchTicketsForAccount(account.accountId, {
    storageState,
    jwt: account.jwt,
    hexToken: account.hexToken,
    liveHeaders: account.liveApiHeaders,
    liveHeadersCapturedAt: account.liveApiHeadersCapturedAt,
    browserPool,
    ownerEmail: account.username,
  });
  const accountUpdated = applyLiveApiHeadersToAccount(account, result.liveApiHeaders, result.liveApiHeadersCapturedAt);

  if (accountUpdated) {
    await persistAccountRecord(account);
  }

  const isBanned = /blocked due to malicious activity|تم حظر الحساب|تم حظرك|account.*blocked|حساب.*محظور|تم إيقاف الحساب|account has been locked/i.test(
    (result && result.error) || "",
  );

  if (isBanned) {
    logger.warn("tickets", "Auto-removing banned account during ticket check", {
      email: account.username,
      error: result.error,
    });
    await Account.removeBannedAccount(account.docId);
    account.status = "failed";
    account.lastError = `Auto-removed: ${result.error}`;
  } else if (result.status === "linked-but-unauthorized") {
    account.status = "expired";
    account.lastError = result.error || "Webook session is no longer authorized. Re-link this account.";
    account.lastCheckAt = new Date();
    await Account.markSessionExpired(account.owner, account.docId, account.jwt, account.lastError);
  }

  const newlyBoughtTickets = [];
  if (Array.isArray(result && result.tickets) && result.tickets.length > 0) {
    const knownSet = new Set(account.knownTicketKeys || []);
    const currentTicketKeys = [];

    for (const ticket of result.tickets) {
      const seatKey = `${ticket.section || "-"}|${ticket.row || "-"}|${ticket.seat || "-"}`;
      const ticketIdKey = ticket.ticketId && ticket.ticketId !== "-" ? ticket.ticketId : seatKey;
      const key = `${ticket.orderId || "-"}::${ticketIdKey}`;
      currentTicketKeys.push(key);

      if (knownSet.size > 0 && !knownSet.has(key)) {
        ticket.isNew = true;
        newlyBoughtTickets.push(ticket);
      }
    }

    const updatedKeys = Array.from(new Set([...knownSet, ...currentTicketKeys]));
    account.knownTicketKeys = updatedKeys;
    account.lastTicketCount = result.tickets.length;

    await Account.updateOne(
      { _id: account.docId },
      { $set: { knownTicketKeys: updatedKeys, lastTicketCount: result.tickets.length } },
    ).catch(() => {});
  }

  return {
    result,
    newlyBoughtTickets,
    refreshed: false,
    refreshError: "",
    accountUpdated,
  };
}

function setCachedReport(chatId, report) {
  if (chatId === null || chatId === undefined) {
    return;
  }

  reportCacheByChat.set(String(chatId), report);
}

function getCachedReport(chatId) {
  if (chatId === null || chatId === undefined) {
    return null;
  }

  return reportCacheByChat.get(String(chatId)) || null;
}

function getActiveTicketCheckKey(chatId) {
  return String(chatId);
}

function getActiveTicketCheck(chatId) {
  return activeTicketChecksByChat.get(getActiveTicketCheckKey(chatId)) || null;
}

function startActiveTicketCheck(chatId) {
  const check = {
    stopRequested: false,
    startedAt: Date.now(),
  };
  activeTicketChecksByChat.set(getActiveTicketCheckKey(chatId), check);
  return check;
}

function clearActiveTicketCheck(chatId) {
  activeTicketChecksByChat.delete(getActiveTicketCheckKey(chatId));
}

function requestStopActiveTicketCheck(chatId) {
  const check = getActiveTicketCheck(chatId);
  if (!check) {
    return { found: false, alreadyRequested: false };
  }

  if (check.stopRequested) {
    return { found: true, alreadyRequested: true };
  }

  check.stopRequested = true;
  check.stopRequestedAt = Date.now();
  return { found: true, alreadyRequested: false };
}

function summarizeTicketProgress(entries, totalCount) {
  const completed = Array.isArray(entries) ? entries.filter(Boolean) : [];
  const summary = summarizeReport({ accounts: completed });

  return {
    totalCount: Math.max(0, Number(totalCount) || 0),
    processedCount: completed.length,
    successCount: summary.successCount,
    failedCount: summary.failedCount,
    totalTickets: summary.totalTickets,
  };
}

function triggerProgressUpdate(onProgress, payload, scope) {
  if (typeof onProgress !== "function") {
    return;
  }

  Promise.resolve(onProgress(payload)).catch((error) => {
    logger.warn(scope || "bot", "Progress update failed", {
      error: error.message,
    });
  });
}

async function buildTicketCheckReport(accounts, options = {}) {
  const startedAt = Date.now();
  let accountsDirty = false;
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const shouldStop = typeof options.shouldStop === "function" ? options.shouldStop : () => false;
  const progressEntries = new Array(accounts.length);

  logger.info("report", "Starting ticket report fetch", {
    accounts: accounts.length,
    concurrency: Math.min(ticketFetchConcurrency, accounts.length),
  });

  let cursor = 0;
  const workersCount = Math.max(1, Math.min(ticketFetchConcurrency, accounts.length));
  const workers = Array.from({ length: workersCount }, () =>
    (async () => {
      while (true) {
        if (shouldStop()) {
          return;
        }

        const index = cursor;
        cursor += 1;
        if (index >= accounts.length) {
          return;
        }

        const account = accounts[index];
        const accountStartedAt = Date.now();
        logger.info("report", "Fetching account", {
          accountId: account.accountId,
          index: `${index + 1}/${accounts.length}`,
        });

        try {
          const ticketResult = await fetchTicketsWithRecovery(account);
          if (ticketResult.refreshed || ticketResult.accountUpdated) {
            accountsDirty = true;
          }

          const failed = ["linked-but-unauthorized", "request-failed"].includes(ticketResult.result.status);
          logger[failed ? "warn" : "success"]("report", failed ? "Account ticket check failed" : "Fetched account", {
            accountId: account.accountId,
            tickets: ticketResult.result.ticketCount,
            status: ticketResult.result.status,
            ms: Date.now() - accountStartedAt,
          });

          progressEntries[index] = {
            account,
            ok: true,
            refreshed: ticketResult.refreshed,
            refreshError: ticketResult.refreshError,
            result: ticketResult.result,
            newlyBoughtTickets: ticketResult.newlyBoughtTickets || [],
            error: "",
          };
        } catch (error) {
          logger.error("report", "Failed account fetch", {
            accountId: account.accountId,
            error: error.message,
            ms: Date.now() - accountStartedAt,
          });

          progressEntries[index] = {
            account,
            ok: false,
            refreshed: false,
            refreshError: "",
            result: null,
            newlyBoughtTickets: [],
            error: error.message,
          };
        }

        if (onProgress) {
          triggerProgressUpdate(onProgress, summarizeTicketProgress(progressEntries, accounts.length), "report");
        }
      }
    })(),
  );

  await Promise.all(workers);
  const reportAccounts = progressEntries.filter(Boolean);
  const stopped = shouldStop() && reportAccounts.length < accounts.length;

  logger.success("report", "Finished ticket report fetch", {
    accounts: reportAccounts.length,
    stopped,
    ms: Date.now() - startedAt,
  });

  return {
    fetchedAt: new Date().toISOString(),
    accounts: reportAccounts,
    totalAccounts: accounts.length,
    accountsDirty,
    stopped,
  };
}

async function runTicketReportFlow(ctx, accounts, lang) {
  const currentLang = lang || (await getContextLanguage(ctx));
  if (!accounts || accounts.length === 0) {
    await replyWithMenu(ctx, translate(currentLang, "noLinkedForTickets"), currentLang);
    return;
  }

  const check = startActiveTicketCheck(ctx.chat.id);
  const revision = accountRevisionByChat.get(getOwnerId(ctx)) || 0;

  const ticketProgressEditor = createMessageEditor(
    ctx,
    translate(currentLang, "ticketProgress", {
      success: 0,
      total: accounts.length,
      failed: 0,
      tickets: 0,
      processed: 0,
    }),
  );
  await ticketProgressEditor.send();

  try {
    const report = await buildTicketCheckReport(accounts, {
      shouldStop: () => check.stopRequested,
      onProgress: async (progress) => {
        await ticketProgressEditor.update(
          translate(currentLang, "ticketProgress", {
            success: progress.successCount,
            total: progress.totalCount,
            failed: progress.failedCount,
            tickets: progress.totalTickets,
            processed: progress.processedCount,
          }),
        );
      },
    });
    if (revision !== (accountRevisionByChat.get(getOwnerId(ctx)) || 0)) return;
    if (report.accountsDirty) {
      await Promise.all(accounts.map((account) => persistAccountRecord(account)));
    }

    setCachedReport(ctx.chat.id, report);

    const summary = summarizeReport(report);
    logger.success("report", "Prepared report summary", {
      success: summary.successCount,
      failed: summary.failedCount,
      tickets: summary.totalTickets,
      stopped: report.stopped,
    });
    await ticketProgressEditor.finish(
      report.stopped
        ? translate(currentLang, "reportStopped", {
            success: summary.successCount,
            total: report.totalAccounts,
            failed: summary.failedCount,
            tickets: summary.totalTickets,
            processed: report.accounts.length,
          })
        : translate(currentLang, "reportReady", {
            success: summary.successCount,
            total: report.totalAccounts,
            failed: summary.failedCount,
            tickets: summary.totalTickets,
          }),
    );

    const allNewTickets = [];
    for (const entry of report.accounts) {
      if (entry && Array.isArray(entry.newlyBoughtTickets) && entry.newlyBoughtTickets.length > 0) {
        for (const t of entry.newlyBoughtTickets) {
          allNewTickets.push({
            ...t,
            accountEmail: entry.account?.username || entry.account?.accountId || "",
          });
        }
      }
    }

    if (allNewTickets.length > 0) {
      const isAr = currentLang !== "en";
      const header = isAr
        ? `🆕 تم اكتشاف شراء ${allNewTickets.length} تذكرة جديدة!`
        : `🆕 Detected ${allNewTickets.length} newly bought ticket(s)!`;

      const lines = [header, ""];
      for (const t of allNewTickets.slice(0, 30)) {
        const email = t.accountEmail || "-";
        const event = t.eventName || "-";
        const seatParts = [
          t.section && t.section !== "-" ? t.section : "",
          t.row && t.row !== "-" ? (isAr ? `صف ${t.row}` : `Row ${t.row}`) : "",
          t.seat && t.seat !== "-" ? (isAr ? `مقعد ${t.seat}` : `Seat ${t.seat}`) : "",
        ].filter(Boolean);
        const seatStr = seatParts.join(" | ") || "-";
        const priceStr =
          t.price !== undefined && t.price !== null && t.price !== "" && t.price !== "-"
            ? `${t.price} ${t.currency || "SAR"}`
            : "-";

        if (isAr) {
          lines.push(`• الحساب: ${email}`);
          lines.push(`  الفعالية: ${event}`);
          lines.push(`  المقعد: ${seatStr}`);
          lines.push(`  السعر: ${priceStr}`);
        } else {
          lines.push(`• Account: ${email}`);
          lines.push(`  Event: ${event}`);
          lines.push(`  Seat: ${seatStr}`);
          lines.push(`  Price: ${priceStr}`);
        }
        lines.push("");
      }

      if (allNewTickets.length > 30) {
        lines.push(isAr ? `... و ${allNewTickets.length - 30} تذكرة أخرى` : `... and ${allNewTickets.length - 30} more`);
        lines.push("");
      }

      lines.push(
        isAr
          ? `💡 تم إضافة صفحة مخصصة "🆕 التذاكر الجديدة" في تقرير الإكسل لتفاصيلها بالكامل مع الأسعار.`
          : `💡 A dedicated "🆕 New Tickets" sheet has been included in your Excel export with full details and prices.`,
      );

      for (const chunk of splitReplyLines(lines)) {
        await ctx.reply(chunk);
      }
    }

    await replyWithReportMenu(ctx, translate(currentLang, "reportMenuAttached"), currentLang);
  } finally {
    clearActiveTicketCheck(ctx.chat.id);
  }
}

async function getRequiredCachedReport(ctx) {
  const lang = await getContextLanguage(ctx);
  const report = getCachedReport(ctx.chat.id);
  if (!report) {
    await replyWithMenu(ctx, translate(lang, "reportCacheMissing"), lang);
    return null;
  }

  return report;
}

async function sendWorkbookReport(ctx, fileFactory, labelKey) {
  const lang = await getContextLanguage(ctx);
  const report = await getRequiredCachedReport(ctx);
  if (!report) {
    return;
  }

  const result = await fileFactory(report, lang);
  const files = Array.isArray(result) ? result : [result];
  if (!files.length) {
    await replyWithReportMenu(ctx, lang === "en" ? "No event tickets to export." : "لا توجد تذاكر فعاليات للتصدير.", lang);
    return;
  }
  for (const file of files) {
    logger.info("report", "Sending workbook report", { type: labelKey, file: file.fileName });
    await ctx.replyWithDocument(Input.fromLocalFile(file.filePath, file.fileName),
      file.eventName ? { caption: `${file.eventName}\n${file.eventTime || ""}`.slice(0, 1024) } : {});
  }
  await replyWithReportMenu(ctx, translate(lang, "reportSent", { label: getReportButtonLabel(lang, labelKey) }), lang);
}

function formatStatusInfo(account, info, lang) {
  if (!info.exists) {
    return translate(lang, "accountStatusNoSession", {
      accountId: account.accountId,
      username: getDisplayedUsername(account),
    });
  }

  if (!info.decryptOk) {
    return translate(lang, "accountStatusUnreadable", {
      accountId: account.accountId,
      username: getDisplayedUsername(account),
    });
  }

  const auth = info.auth;
  const statusBits =
    lang === "en"
      ? [
          `cookies=${auth.cookieCount}`,
          `origins=${auth.originCount}`,
          `auth=${auth.hasAuthMarkers ? "ready" : "missing"}`,
          `auto-relogin=${info.credentialsSaved ? "on" : "off"}`,
        ]
      : [
          `الكوكيز=${auth.cookieCount}`,
          `المصادر=${auth.originCount}`,
          `المصادقة=${auth.hasAuthMarkers ? "جاهزة" : "مفقودة"}`,
          `إعادة الدخول التلقائية=${info.credentialsSaved ? "مفعلة" : "غير مفعلة"}`,
        ];

  if (info.lastLinkedAt) {
    statusBits.push(`${lang === "en" ? "linked" : "آخر ربط"}=${formatShortTimestamp(info.lastLinkedAt, lang)}`);
  }

  if (info.lastAutoRefreshAt) {
    statusBits.push(
      `${lang === "en" ? "refreshed" : "آخر تحديث"}=${formatShortTimestamp(info.lastAutoRefreshAt, lang)}`,
    );
  }

  return `✅ ${account.accountId} • ${getDisplayedUsername(account)}\n${statusBits.join(" • ")}`;
}

function formatLinkedAccountInfo(account, hasSessionFile, lang) {

  const canRelogin = Boolean(account.username && account.getPassword && account.getPassword());
  const parts =
    lang === "en"
      ? [
          hasSessionFile ? "session saved" : "no session file",
          canRelogin ? "auto relogin ready" : "no saved credentials",
        ]
      : [
          hasSessionFile ? "الجلسة محفوظة" : "لا يوجد ملف جلسة",
          canRelogin ? "إعادة الدخول التلقائية جاهزة" : "لا توجد بيانات دخول محفوظة",
        ];

  if (account.lastLinkedAt) {
    parts.push(`${lang === "en" ? "linked" : "آخر ربط"} ${formatShortTimestamp(account.lastLinkedAt, lang)}`);
  }

  return translate(lang, "linkedAccountLine", {
    accountId: account.accountId,
    username: getDisplayedUsername(account),
    parts,
  });
}

async function handleStartCommand(ctx) {
  const lang = await getContextLanguage(ctx);
  logger.info("bot", "Bot started", {
    linkConcurrency,
    ticketFetchConcurrency,
    handlerTimeoutMs: telegramHandlerTimeoutMs,
  });
  await replyWithMenu(
    ctx,
    translate(lang, "start", {
      speed: translate(lang, "speedProfile", {
        concurrency: linkConcurrency,
        blockHeavyResources,
      }),
    }),
    lang,
  );
}

async function handleStatusCommand(ctx) {
  const lang = await getContextLanguage(ctx);
  const accounts = await getAllOwnerAccounts(getOwnerId(ctx));
  if (accounts.length === 0) {
    await replyWithMenu(ctx, translate(lang, "noLinkedForLink"), lang);
    return;
  }

  const blocks = [translate(lang, "statusHeader")];
  for (const account of accounts) {
    const info = await getSessionStatusInfo(account);
    blocks.push(formatStatusInfo(account, info, lang));
  }

  const queue = await getQueueStatus(getOwnerId(ctx));
  blocks.push(
    lang === "en"
      ? `⚙️ Queue: ${queue.queued} waiting • ${queue.processing} running • ${queue.done} done • ${queue.failed} failed`
      : `⚙️ الطابور: ${queue.queued} انتظار • ${queue.processing} جاري • ${queue.done} مكتمل • ${queue.failed} فاشل`,
  );

  for (const chunk of splitReplyBlocks(blocks)) {
    await replyWithMenu(ctx, chunk, lang);
  }
}

async function handleLinkedAccountsCommand(ctx) {
  const lang = await getContextLanguage(ctx);
  const accounts = await getLinkedAccounts(getOwnerId(ctx));
  if (accounts.length === 0) {
    await replyWithMenu(ctx, translate(lang, "noLinkedForAccounts"), lang);
    return;
  }

  const blocks = [translate(lang, "linkedAccountsHeader")];
  for (const account of accounts) {
    blocks.push(formatLinkedAccountInfo(account, await accountHasSession(account), lang));
  }

  for (const chunk of splitReplyBlocks(blocks)) {
    await replyWithMenu(ctx, chunk, lang);
  }
}

async function handleTicketsCommand(ctx) {
  const lang = await getContextLanguage(ctx);
  const existingCheck = getActiveTicketCheck(ctx.chat.id);
  if (existingCheck) {
    await replyWithMenu(ctx, translate(lang, "ticketCheckAlreadyRunning"), lang);
    return;
  }

  const accounts = await getLinkedAccounts(getOwnerId(ctx));
  if (accounts.length === 0 && await Account.exists({ owner: getOwnerId(ctx), status: "expired" })) {
    await replyWithReportMenu(ctx, lang === "en"
      ? "Your saved Webook sessions have expired. Use '🔄 Re-link Expired' before checking tickets again."
      : "انتهت صلاحية جلسات Webook المحفوظة. اضغط '🔄 إعادة ربط المنتهية' قبل فحص التذاكر مجدداً.", lang);
    return;
  }
  void runTicketReportFlow(ctx, accounts, lang).catch(async (error) => {
    logger.error("report", "Ticket report background task failed", {
      error: error.message,
    });
    const currentLang = await getContextLanguage(ctx);
    await replyWithMenu(ctx, translate(currentLang, "unexpectedError"), currentLang);
  });
}

async function handleMoneyAccountsCommand(ctx) {
  const lang = await getContextLanguage(ctx);

  const cachedReport = getCachedReport(ctx.chat.id);
  if (cachedReport) {

    await displayMoneyAccountsFromReport(ctx, cachedReport, lang);
    return;
  }

  const existingCheck = getActiveTicketCheck(ctx.chat.id);
  if (existingCheck) {
    await replyWithMenu(ctx, translate(lang, "ticketCheckAlreadyRunning"), lang);
    return;
  }

  const accounts = await getLinkedAccounts(getOwnerId(ctx));

  void runMoneyAccountsReportFlow(ctx, accounts, lang).catch(async (error) => {
    logger.error("report", "Money accounts report background task failed", {
      error: error.message,
    });
    const currentLang = await getContextLanguage(ctx);
    await replyWithMenu(ctx, translate(currentLang, "unexpectedError"), currentLang);
  });
}

async function displayMoneyAccountsFromReport(ctx, report, lang) {
  const currentLang = lang || (await getContextLanguage(ctx));
  if (!report || !report.accounts) {
    await replyWithMenu(ctx, translate(currentLang, "noLinkedForTickets"), currentLang);
    return;
  }

  const accountsWithMoney = report.accounts.filter((entry) => {
    return entry && entry.result && typeof entry.result.walletBalance === "number" && entry.result.walletBalance > 0;
  });

  if (accountsWithMoney.length === 0) {
    await replyWithMenu(
      ctx,
      currentLang === "en" ? "No accounts with available balance found." : "لم يتم العثور على حسابات برصيد متاح.",
      currentLang,
    );
    return;
  }

  const moneyRows = accountsWithMoney
    .map((entry) => {
      const username =
        (entry &&
          entry.account &&
          (entry.account.username || entry.account.usernameMasked || entry.account.accountId)) ||
        "unknown";
      const balance = Number(
        entry && entry.result && typeof entry.result.walletBalance === "number" ? entry.result.walletBalance : 0,
      );
      return { username, balance };
    })
    .sort((left, right) => {
      if (Number(right.balance) !== Number(left.balance)) {
        return Number(right.balance) - Number(left.balance);
      }
      return String(left.username).localeCompare(String(right.username));
    });

  const moneyHeader =
    currentLang === "en" ? `Accounts with money (${moneyRows.length}):` : `الحسابات ذات الرصيد (${moneyRows.length}):`;
  const moneyLines = [
    moneyHeader,
    "",
    ...moneyRows.map(({ username, balance }) =>
      currentLang === "en" ? `${username}\nBalance: ${balance}` : `${username}\nالرصيد: ${balance}`,
    ),
  ];

  for (const chunk of splitReplyLines(moneyLines)) {
    await replyWithReportMenu(ctx, chunk, currentLang);
  }
  await replyWithReportMenu(ctx, translate(currentLang, "reportMenuAttached"), currentLang);
}

async function runMoneyAccountsReportFlow(ctx, accounts, lang) {
  const currentLang = lang || (await getContextLanguage(ctx));
  if (!accounts || accounts.length === 0) {
    await replyWithMenu(ctx, translate(currentLang, "noLinkedForTickets"), currentLang);
    return;
  }

  const check = startActiveTicketCheck(ctx.chat.id);
  const revision = accountRevisionByChat.get(getOwnerId(ctx)) || 0;

  const ticketProgressEditor = createMessageEditor(
    ctx,
    translate(currentLang, "ticketProgress", {
      success: 0,
      total: accounts.length,
      failed: 0,
      tickets: 0,
      processed: 0,
    }),
  );
  await ticketProgressEditor.send();

  try {
    const report = await buildTicketCheckReport(accounts, {
      shouldStop: () => check.stopRequested,
      onProgress: async (progress) => {
        await ticketProgressEditor.update(
          translate(currentLang, "ticketProgress", {
            success: progress.successCount,
            total: progress.totalCount,
            failed: progress.failedCount,
            tickets: progress.totalTickets,
            processed: progress.processedCount,
          }),
        );
      },
    });
    if (revision !== (accountRevisionByChat.get(getOwnerId(ctx)) || 0)) return;
    if (report.accountsDirty) {
      await Promise.all(accounts.map((account) => persistAccountRecord(account)));
    }

    const accountsWithMoney = report.accounts.filter((entry) => {
      return entry && entry.result && typeof entry.result.walletBalance === "number" && entry.result.walletBalance > 0;
    });

    if (accountsWithMoney.length === 0) {
      await ticketProgressEditor.finish(
        currentLang === "en" ? "No accounts with available balance found." : "لم يتم العثور على حسابات برصيد متاح.",
      );
      await replyWithMenu(ctx, translate(currentLang, "noLinkedForTickets"), currentLang);
      return;
    }

    const filteredReport = {
      ...report,
      accounts: accountsWithMoney,
    };

    setCachedReport(ctx.chat.id, filteredReport);

    const summary = summarizeReport(filteredReport);
    logger.success("report", "Prepared money accounts report summary", {
      success: summary.successCount,
      failed: summary.failedCount,
      tickets: summary.totalTickets,
      accountsWithMoney: accountsWithMoney.length,
      totalAccounts: report.totalAccounts,
    });

    const moneyRows = accountsWithMoney
      .map((entry) => {
        const username =
          (entry &&
            entry.account &&
            (entry.account.username || entry.account.usernameMasked || entry.account.accountId)) ||
          "unknown";
        const balance = Number(
          entry && entry.result && typeof entry.result.walletBalance === "number" ? entry.result.walletBalance : 0,
        );
        return { username, balance };
      })
      .sort((left, right) => {
        if (Number(right.balance) !== Number(left.balance)) {
          return Number(right.balance) - Number(left.balance);
        }
        return String(left.username).localeCompare(String(right.username));
      });

    const moneyHeader =
      currentLang === "en"
        ? `Accounts with money (${moneyRows.length}):`
        : `الحسابات ذات الرصيد (${moneyRows.length}):`;
    const moneyLines = [
      moneyHeader,
      "",
      ...moneyRows.map(({ username, balance }) =>
        currentLang === "en" ? `${username}\nBalance: ${balance}` : `${username}\nالرصيد: ${balance}`,
      ),
    ];

    await ticketProgressEditor.finish(
      report.stopped
        ? translate(currentLang, "reportStopped", {
            success: summary.successCount,
            total: accountsWithMoney.length,
            failed: summary.failedCount,
            tickets: summary.totalTickets,
            processed: accountsWithMoney.length,
          })
        : currentLang === "en"
          ? `Found ${accountsWithMoney.length} account(s) with money.`
          : `تم العثور على ${accountsWithMoney.length} حساب(ات) برصيد.`,
    );

    for (const chunk of splitReplyLines(moneyLines)) {
      await replyWithReportMenu(ctx, chunk, currentLang);
    }
    await replyWithReportMenu(ctx, translate(currentLang, "reportMenuAttached"), currentLang);
  } finally {
    clearActiveTicketCheck(ctx.chat.id);
  }
}

async function handleStopCheckingCommand(ctx) {
  const lang = await getContextLanguage(ctx);
  const owner = getOwnerId(ctx);
  resetPendingBulkInput(ctx.chat.id);
  const progress = loginProgressState.get(owner);
  if (progress?.timer) clearTimeout(progress.timer);
  loginProgressState.delete(owner);
  const stopping = cancelOwnerLoginJobs(owner);
  await ctx.reply(lang === "en" ? "🛑 Stopping account login..." : "🛑 جارٍ إيقاف تسجيل دخول الحسابات...");
  const cancelled = await stopping;
  await replyWithMenu(ctx, lang === "en"
    ? `🛑 Account login stopped. Cancelled ${cancelled} waiting or running login(s). Use Link Accounts or Re-link to start again.`
    : `🛑 تم إيقاف تسجيل الدخول وإلغاء ${cancelled} عملية معلقة أو جارية. استخدم ربط الحسابات أو إعادة الربط للبدء من جديد.`, lang);
}

async function handleDeleteAccountsCommand(ctx, page = 0) {
  const lang = await getContextLanguage(ctx);
  const owner = getOwnerId(ctx);
  await connectDb();
  const accounts = await Account.find({ owner }).select("email").sort({ createdAt: 1 }).lean().exec();
  if (!accounts.length) {
    await replyWithMenu(ctx, translate(lang, "noLinkedForAccounts"), lang);
    return;
  }
  const pageSize = 8;
  const currentPage = Math.max(0, Math.min(Number(page) || 0, Math.ceil(accounts.length / pageSize) - 1));
  const buttons = accounts.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map((account) => [
    Markup.button.callback(`🗑 ${account.email}`, `accounts:delete:${account._id}`),
  ]);
  const navigation = [];
  if (currentPage > 0) navigation.push(Markup.button.callback("◀️", `accounts:page:${currentPage - 1}`));
  if ((currentPage + 1) * pageSize < accounts.length) navigation.push(Markup.button.callback("▶️", `accounts:page:${currentPage + 1}`));
  if (navigation.length) buttons.push(navigation);
  buttons.push([Markup.button.callback(lang === "en" ? `🗑 Delete all (${accounts.length})` : `🗑 حذف الكل (${accounts.length})`, "accounts:delete:all")]);
  await ctx.reply(lang === "en" ? "Choose a saved account to delete, or delete all:" : "اختر حساباً محفوظاً لحذفه، أو احذف الكل:", Markup.inlineKeyboard(buttons));
}

async function promptDeleteAccounts(ctx, target) {
  const lang = await getContextLanguage(ctx);
  const owner = getOwnerId(ctx);
  const filter = target === "all" ? { owner } : { owner, _id: target };
  const accounts = await Account.find(filter).select("email").lean().exec();
  if (!accounts.length) return;
  const nonce = require("node:crypto").randomBytes(8).toString("hex");
  pendingAccountDeletionByChat.set(owner, { nonce, ids: accounts.map((account) => account._id), expiresAt: Date.now() + 5 * 60 * 1000 });
  const label = target === "all" ? `${accounts.length}` : accounts[0].email;
  await ctx.reply(lang === "en"
    ? `Delete ${label} from this bot? This removes saved credentials and sessions and stops account login. Your Webook accounts and tickets are unaffected.`
    : `حذف ${label} من البوت؟ سيتم حذف بيانات الدخول والجلسات المحفوظة وإيقاف الربط. لن تتأثر حسابات Webook أو التذاكر.`,
    Markup.inlineKeyboard([[
      Markup.button.callback(lang === "en" ? "🗑 Confirm deletion" : "🗑 تأكيد الحذف", `accounts:confirm:${nonce}`),
      Markup.button.callback(lang === "en" ? "Cancel" : "إلغاء", `accounts:cancel:${nonce}`),
    ]]));
}

async function confirmDeleteAccounts(ctx, nonce) {
  const lang = await getContextLanguage(ctx);
  const owner = getOwnerId(ctx);
  if (deletingAccountsByChat.has(owner)) {
    await ctx.reply(lang === "en" ? "Account deletion is already in progress." : "جارٍ حذف الحسابات بالفعل.");
    return;
  }
  const pending = pendingAccountDeletionByChat.get(owner);
  if (!pending || pending.nonce !== nonce || pending.expiresAt < Date.now()) {
    await ctx.reply(lang === "en" ? "This confirmation expired. Choose the accounts again." : "انتهت صلاحية التأكيد. اختر الحسابات مرة أخرى.");
    return;
  }
  pendingAccountDeletionByChat.delete(owner);
  resetPendingBulkInput(ctx.chat.id);
  accountRevisionByChat.set(owner, (accountRevisionByChat.get(owner) || 0) + 1);
  requestStopActiveTicketCheck(ctx.chat.id);
  reportCacheByChat.delete(owner);
  pendingEventCheckByChat.delete(ctx.chat.id);
  const progress = loginProgressState.get(owner);
  if (progress?.timer) clearTimeout(progress.timer);
  loginProgressState.delete(owner);
  deletingAccountsByChat.add(owner);
  let deleted;
  try {
    deleted = await deleteSavedAccounts(owner, pending.ids);
  } finally {
    deletingAccountsByChat.delete(owner);
    accountRevisionByChat.set(owner, (accountRevisionByChat.get(owner) || 0) + 1);
    reportCacheByChat.delete(owner);
  }
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await replyWithMenu(ctx, lang === "en" ? `🗑 Deleted ${deleted} saved account(s).` : `🗑 تم حذف ${deleted} حساب محفوظ.`, lang);
}

async function promptForBulkLinkInput(ctx) {
  const lang = await getContextLanguage(ctx);
  resetPendingBulkInput(ctx.chat.id);
  await replyWithMenu(ctx, translate(lang, "promptAccountsInput"), lang);
}

async function handleLinkListCommand(ctx) {
  const lang = await getContextLanguage(ctx);
  try {
    const text = ctx.message?.text || "";
    const inlineData = text.split("\n").slice(1).join("\n").trim();
    const hasInlineData = inlineData.length > 0;

    if (!hasInlineData) {
      await promptForBulkLinkInput(ctx);
      return;
    }

    resetPendingBulkInput(ctx.chat.id);
    await queuePendingBulkInputText(ctx, inlineData);
  } catch (error) {
    await replyWithMenu(ctx, translate(lang, "bulkLinkFailed", { error: error.message }), lang);
  }
}

async function handleRelinkCommand(ctx) {
  const owner = getOwnerId(ctx);
  loginControl.resume(owner);
  return loginControl.run(owner, (signal) => submitRelinkCommand(ctx, signal));
}

async function submitRelinkCommand(ctx, signal) {
  const lang = await getContextLanguage(ctx);
  const owner = getOwnerId(ctx);
  await connectDb();

  const arg = (parseCommandArgument(ctx) || "").trim().toLowerCase();
  const relinkAll = arg === "all" || arg === "الكل";

  let accountsToRelink = [];

  if (relinkAll) {
    accountsToRelink = await Account.find({ owner }).exec();
  } else {

    const dbCandidates = await Account.find({
      owner,
      $or: [
        { status: { $in: ["expired", "failed", "pending"] } },
        { tokenExpiresAt: { $lte: new Date() } },
        { jwt: { $in: ["", null, "false", "null", "undefined"] } },
      ],
    }).exec();

    const targetIds = new Set(dbCandidates.map((a) => String(a._id)));

    const cachedReport = getCachedReport(ctx.chat.id);
    if (cachedReport && Array.isArray(cachedReport.accounts)) {
      const errorDocIds = cachedReport.accounts
        .filter(
          (entry) =>
            !entry.ok ||
            (entry.result &&
              (entry.result.status === "linked-but-unauthorized" || entry.result.status === "request-failed")),
        )
        .map((entry) => entry.account && entry.account.docId)
        .filter(Boolean);

      for (const id of errorDocIds) {
        targetIds.add(String(id));
      }
    }

    if (targetIds.size > 0) {
      accountsToRelink = await Account.find({ owner, _id: { $in: [...targetIds] } }).exec();
    }
  }

  if (accountsToRelink.length === 0) {
    await replyWithMenu(
      ctx,
      lang === "en"
        ? "✅ No expired or failed accounts found to re-link."
        : "✅ لا توجد حسابات منتهية أو فاشلة لإعادة ربطها.",
      lang,
    );
    return;
  }

  let queued = 0;
  for (const account of accountsToRelink) {
    if (signal.aborted) break;
    try {
      account.status = "pending";
      account.retryCount = 0;
      account.lastError = "";
      await account.save();
      await queueLoginJob(owner, account._id);
      queued += 1;
    } catch (err) {
      logger.error("link", "Could not requeue account for re-link", {
        owner,
        email: account.email,
        error: err.message,
      });
    }
  }

  if (signal.aborted) return;
  await replyWithMenu(
    ctx,
    lang === "en"
      ? `🔄 Re-queued ${queued} account(s) for login in the background...`
      : `🔄 تم وضع ${queued} حساب في طابور إعادة الربط في الخلفية...`,
    lang,
  );
}

async function handleHelpCommand(ctx) {
  const lang = await getContextLanguage(ctx);
  await replyWithMenu(ctx, translate(lang, "help"), lang);
}

async function handleReportGeneralInfo(ctx) {
  const lang = await getContextLanguage(ctx);
  const report = await getRequiredCachedReport(ctx);
  if (!report) {
    return;
  }

  const title = translate(lang, "reportSummaryTitle");
  const body = buildGeneralInfoText(report, lang);
  for (const chunk of splitReplyBlocks([`${title}\n\n${body}`])) {
    await replyWithReportMenu(ctx, chunk, lang);
  }
}

async function handleReportAccountsWithTickets(ctx) {
  const lang = await getContextLanguage(ctx);
  const report = await getRequiredCachedReport(ctx);
  if (!report) {
    return;
  }

  const rows = buildAccountsWithTicketsRows(report);
  if (rows.length === 0) {
    await replyWithReportMenu(ctx, translate(lang, "noAccountsWithTickets"), lang);
    return;
  }

  const lines = [
    translate(lang, "accountsWithTicketsTitle"),
    "",
    ...rows.map((row) => `${row.accountName} - ${row.ticketCount}`),
  ];
  for (const chunk of splitReplyLines(lines)) {
    await replyWithReportMenu(ctx, chunk, lang);
  }
}

async function handleReportNewTickets(ctx) {
  const lang = await getContextLanguage(ctx);
  const report = await getRequiredCachedReport(ctx);
  if (!report) {
    return;
  }

  const allNewTickets = [];
  const accounts = Array.isArray(report && report.accounts) ? report.accounts : [];
  for (const entry of accounts) {
    if (entry && entry.ok && entry.result && Array.isArray(entry.result.tickets)) {
      for (const t of entry.result.tickets) {
        if (t.isNew === true) {
          allNewTickets.push({
            ...t,
            accountEmail: entry.account?.username || entry.account?.accountId || "",
          });
        }
      }
    }
  }

  if (allNewTickets.length === 0) {
    await replyWithReportMenu(
      ctx,
      lang === "en"
        ? "ℹ️ No newly bought tickets detected in the last check."
        : "ℹ️ لا توجد تذاكر جديدة تم شراؤها في آخر فحص.",
      lang,
    );
    return;
  }

  const isAr = lang !== "en";
  const header = isAr
    ? `🆕 التذاكر الجديدة المكتشفة (${allNewTickets.length}):`
    : `🆕 Newly Bought Tickets (${allNewTickets.length}):`;

  const lines = [header, ""];
  for (const t of allNewTickets.slice(0, 30)) {
    const email = t.accountEmail || "-";
    const event = t.eventName || "-";
    const seatParts = [
      t.section && t.section !== "-" ? t.section : "",
      t.row && t.row !== "-" ? (isAr ? `صف ${t.row}` : `Row ${t.row}`) : "",
      t.seat && t.seat !== "-" ? (isAr ? `مقعد ${t.seat}` : `Seat ${t.seat}`) : "",
    ].filter(Boolean);
    const seatStr = seatParts.join(" | ") || "-";
    const priceStr =
      t.price !== undefined && t.price !== null && t.price !== "" && t.price !== "-"
        ? `${t.price} ${t.currency || "SAR"}`
        : "-";

    if (isAr) {
      lines.push(`• الحساب: ${email}`);
      lines.push(`  الفعالية: ${event}`);
      lines.push(`  المقعد: ${seatStr}`);
      lines.push(`  السعر: ${priceStr}`);
    } else {
      lines.push(`• Account: ${email}`);
      lines.push(`  Event: ${event}`);
      lines.push(`  Seat: ${seatStr}`);
      lines.push(`  Price: ${priceStr}`);
    }
    lines.push("");
  }

  if (allNewTickets.length > 30) {
    lines.push(isAr ? `... و ${allNewTickets.length - 30} تذكرة أخرى` : `... and ${allNewTickets.length - 30} more`);
    lines.push("");
  }

  lines.push(
    isAr
      ? `💡 تم إنشاء صفحة مخصصة "🆕 التذاكر الجديدة" في ملف الإكسل (تفاصيل التذاكر - منظم).`
      : `💡 A dedicated "🆕 New Tickets" sheet is also included in your Excel export.`,
  );

  for (const chunk of splitReplyLines(lines)) {
    await replyWithReportMenu(ctx, chunk, lang);
  }
}

async function handleReportOrganizedDetails(ctx) {
  await sendWorkbookReport(ctx, createOrganizedTicketsWorkbook, "organized");
}

async function handleReportTicketsBySection(ctx) {
  await sendWorkbookReport(ctx, createTicketsBySectionWorkbooks, "bySection");
}

async function handleReportAdjacentSeats(ctx) {
  const lang = await getContextLanguage(ctx);
  const report = await getRequiredCachedReport(ctx);
  if (!report) {
    return;
  }

  const rows = buildAdjacentSeatRows(report, lang);
  if (rows.length === 0) {
    await replyWithReportMenu(ctx, translate(lang, "noAdjacentSeats"), lang);
    return;
  }

  const file = await createAdjacentSeatsWorkbook(report, lang);
  logger.info("report", "Sending adjacent seats workbook", {
    file: file.fileName,
    rows: rows.length,
  });
  await ctx.replyWithDocument(Input.fromLocalFile(file.filePath, file.fileName));
  await replyWithReportMenu(
    ctx,
    translate(lang, "reportSent", { label: getReportButtonLabel(lang, "adjacent") }),
    lang,
  );
}

async function handleReportScatteredSeats(ctx) {
  const lang = await getContextLanguage(ctx);
  const report = await getRequiredCachedReport(ctx);
  if (!report) {
    return;
  }

  const rows = buildScatteredSeatRows(report, lang);
  if (rows.length === 0) {
    await replyWithReportMenu(ctx, translate(lang, "noScatteredSeats"), lang);
    return;
  }

  const file = await createScatteredSeatsWorkbook(report, lang);
  logger.info("report", "Sending scattered seats workbook", {
    file: file.fileName,
    rows: rows.length,
  });
  await ctx.replyWithDocument(Input.fromLocalFile(file.filePath, file.fileName));
  await replyWithReportMenu(
    ctx,
    translate(lang, "reportSent", { label: getReportButtonLabel(lang, "scattered") }),
    lang,
  );
}

async function handleReportErrorsDetails(ctx) {
  const lang = await getContextLanguage(ctx);
  const report = await getRequiredCachedReport(ctx);
  if (!report) {
    return;
  }

  const accounts = Array.isArray(report.accounts) ? report.accounts : [];
  const failedAccounts = accounts.filter((entry) => {
    if (!entry.ok) return true;
    const status = entry.result && entry.result.status;
    return status === "linked-but-unauthorized" || status === "request-failed" || status === "failed";
  });

  if (failedAccounts.length === 0) {
    await replyWithReportMenu(
      ctx,
      lang === "en" ? "✅ No errors found! All accounts were checked successfully." : "✅ لا توجد أخطاء! تم فحص جميع الحسابات بنجاح.",
      lang,
    );
    return;
  }

  const groups = {
    credentials: [],
    blocked: [],
    unauthorized: [],
    network: [],
    other: [],
  };

  for (const entry of failedAccounts) {
    const username = getDisplayedUsername(entry.account);
    const status = entry.result ? entry.result.status : "";
    const errText = String(entry.error || entry.refreshError || (entry.account && entry.account.lastError) || "").toLowerCase();

    if (errText.includes("password") || errText.includes("credential") || errText.includes("غير صحيحة")) {
      groups.credentials.push(username);
    } else if (errText.includes("blocked") || errText.includes("حظر") || errText.includes("locked") || errText.includes("malicious")) {
      groups.blocked.push(username);
    } else if (status === "linked-but-unauthorized" || errText.includes("unauthorized") || errText.includes("session") || errText.includes("jwt")) {
      groups.unauthorized.push(username);
    } else if (status === "request-failed" || errText.includes("timeout") || errText.includes("network") || errText.includes("connect") || errText.includes("مهلة")) {
      groups.network.push(username);
    } else {
      const summaryMsg = entry.error || entry.refreshError || (entry.account && entry.account.lastError) || status || "error";
      groups.other.push(`${username} (${String(summaryMsg).slice(0, 40)})`);
    }
  }

  const lines = [
    lang === "en"
      ? `⚠️ Error Details (${failedAccounts.length} accounts):`
      : `⚠️ تفاصيل أسباب الأخطاء (${failedAccounts.length} حساب):`,
    "",
  ];

  if (groups.credentials.length > 0) {
    lines.push(
      lang === "en"
        ? `🔴 Wrong Password / Email (${groups.credentials.length} account(s)):`
        : `🔴 كلمة المرور أو البريد غير صحيح (${groups.credentials.length} حساب):`,
    );
    lines.push(
      lang === "en"
        ? "   • Cause: Password was changed or incorrect on Webook."
        : "   • السبب: كلمة المرور غير صحيحة أو تم تغييرها في Webook.",
    );
    const preview = groups.credentials.slice(0, 15).join(", ");
    const remainder = groups.credentials.length > 15 ? ` ... (+${groups.credentials.length - 15})` : "";
    lines.push(`   • الحسابات: ${preview}${remainder}`);
    lines.push("");
  }

  if (groups.blocked.length > 0) {
    lines.push(
      lang === "en"
        ? `🚫 Blocked Accounts (${groups.blocked.length} account(s)):`
        : `🚫 حسابات محظورة أو مقيدة (${groups.blocked.length} حساب):`,
    );
    lines.push(
      lang === "en"
        ? "   • Cause: Webook blocked the account due to suspicious activity."
        : "   • السبب: تم حظر الحساب من Webook لأسباب أمنية.",
    );
    const preview = groups.blocked.slice(0, 15).join(", ");
    const remainder = groups.blocked.length > 15 ? ` ... (+${groups.blocked.length - 15})` : "";
    lines.push(`   • الحسابات: ${preview}${remainder}`);
    lines.push("");
  }

  if (groups.unauthorized.length > 0) {
    lines.push(
      lang === "en"
        ? `🔴 Expired/Unauthorized Session (${groups.unauthorized.length} account(s)):`
        : `🔴 جلسة منتهية أو غير مصرحة (${groups.unauthorized.length} حساب):`,
    );
    lines.push(
      lang === "en"
        ? "   • Cause: The login session/JWT is expired on Webook."
        : "   • السبب: انتهت صلاحية الجلسة أو لم يتم تسجيل الدخول بعد في Webook.",
    );
    const preview = groups.unauthorized.slice(0, 15).join(", ");
    const remainder = groups.unauthorized.length > 15 ? ` ... (+${groups.unauthorized.length - 15})` : "";
    lines.push(`   • الحسابات: ${preview}${remainder}`);
    lines.push("");
  }

  if (groups.network.length > 0) {
    lines.push(
      lang === "en"
        ? `🟡 Network / Timeout Error (${groups.network.length} account(s)):`
        : `🟡 خطأ اتصال بالشبكة أو مهلة (${groups.network.length} حساب):`,
    );
    lines.push(
      lang === "en"
        ? "   • Cause: Webook API did not respond in time or request timed out."
        : "   • السبب: تعذر استلام رد من سيرفر Webook في الوقت المحدد.",
    );
    const preview = groups.network.slice(0, 15).join(", ");
    const remainder = groups.network.length > 15 ? ` ... (+${groups.network.length - 15})` : "";
    lines.push(`   • الحسابات: ${preview}${remainder}`);
    lines.push("");
  }

  if (groups.other.length > 0) {
    lines.push(
      lang === "en"
        ? `⚪ Other Errors (${groups.other.length} account(s)):`
        : `⚪ أخطاء أخرى (${groups.other.length} حساب):`,
    );
    const preview = groups.other.slice(0, 15).join(", ");
    const remainder = groups.other.length > 15 ? ` ... (+${groups.other.length - 15})` : "";
    lines.push(`   • الحسابات: ${preview}${remainder}`);
    lines.push("");
  }

  lines.push(
    lang === "en"
      ? "💡 Solution: Click [🔄 Re-link Expired] below to automatically log in to all failed accounts without re-entering passwords."
      : "💡 الحل: اضغط على زر [🔄 إعادة ربط المنتهية] بالأسفل لإعادة تسجيل الدخول لجميع الحسابات الفاشلة تلقائياً بدون إعادة كتابة كلمات المرور.",
  );

  for (const chunk of splitReplyLines(lines)) {
    await replyWithReportMenu(ctx, chunk, lang);
  }
}

async function handleCancelCommand(ctx) {
  const lang = await getContextLanguage(ctx);
  const cancelled = clearPendingBulkInput(ctx.chat.id);
  await replyWithMenu(ctx, cancelled ? translate(lang, "pendingCancelled") : translate(lang, "nothingPending"), lang);
}

async function handleLanguageCommand(ctx) {
  const currentLang = await getContextLanguage(ctx);
  const nextLang = currentLang === "en" ? "ar" : "en";
  await saveChatLanguage(ctx.chat.id, nextLang);
  await replyWithMenu(
    ctx,
    nextLang === "en" ? translate("en", "helpChangedToEnglish") : translate("ar", "helpChangedToArabic"),
    nextLang,
  );
}

async function handleBackToMainMenu(ctx) {
  const lang = await getContextLanguage(ctx);
  await replyWithMenu(ctx, translate(lang, "returnedToMain"), lang);
}

bot.use(async (ctx, next) => {
  const identity = getAuthIdentity(ctx);
  if (!identity.userId) {
    return next();
  }

  try {
    await User.upsertFromTelegram({
      id: identity.userId,
      username: identity.username,
      firstName: identity.firstName,
    });
  } catch (error) {
    logger.warn("auth", "Could not upsert telegram user", { userId: identity.userId, error: error.message });
  }

  if (await isAllowedUser(identity.userId)) {
    return next();
  }

  const existingUser = await User.findOne({ telegramId: String(identity.userId) })
    .select("isAllowed isOwner subscription")
    .lean()
    .exec();
  let rejectMsg;
  if (!existingUser) {
    rejectMsg = "⛔ غير مصرح لك باستخدام البوت.";
  } else {
    const sub = existingUser.subscription || {};
    if (sub.plan && sub.plan !== "none" && sub.expiresAt && new Date(sub.expiresAt) < new Date()) {
      rejectMsg = "⛔ اشتراكك انتهى. تواصل مع الأدمن لتجديد الاشتراك.";
    } else if (!sub.plan || sub.plan === "none") {
      rejectMsg = "⛔ محتاج اشتراك عشان تستخدم البوت. تواصل مع الأدمن.";
    } else {
      rejectMsg = "⛔ غير مصرح لك باستخدام البوت.";
    }
  }

  logger.warn("auth", "Rejected unauthorized user", {
    userId: identity.userId,
    chatId: identity.chatId,
    username: identity.username || "-",
    name: [identity.firstName, identity.lastName].filter(Boolean).join(" ") || "-",
  });
  await ctx.reply(rejectMsg);
  return undefined;
});

async function requireOwner(ctx) {
  const identity = getAuthIdentity(ctx);
  if (await isOwnerUser(identity.userId)) {
    return true;
  }

  await ctx.reply("⛔ هذا الأمر للمالك فقط");
  return false;
}

function parseCommandArgument(ctx) {
  const text = typeof ctx.message?.text === "string" ? ctx.message.text : "";
  const parts = text.trim().split(/\s+/).slice(1);
  return parts.join(" ").trim();
}

async function handleAddUserCommand(ctx) {
  if (!(await requireOwner(ctx))) {
    return;
  }

  const target = parseCommandArgument(ctx);
  if (!/^\d+$/.test(target)) {
    await ctx.reply("الاستخدام: /adduser <telegram_id>");
    return;
  }

  const user = await authorizeUser({ userId: target });
  logger.success("auth", "User authorized by owner", { telegramId: target });
  await ctx.reply(`✅ تم السماح للمستخدم ${user.telegramId}`);
}

async function handleRemoveUserCommand(ctx) {
  if (!(await requireOwner(ctx))) {
    return;
  }

  const target = parseCommandArgument(ctx);
  if (!/^\d+$/.test(target)) {
    await ctx.reply("الاستخدام: /removeuser <telegram_id>");
    return;
  }

  if (botOwnerId && target === botOwnerId) {
    await ctx.reply("⚠️ لا يمكن إزالة المالك");
    return;
  }

  const user = await revokeUser(target);
  if (!user) {
    await ctx.reply(`❌ لا يوجد مستخدم بالمعرف ${target}`);
    return;
  }

  logger.warn("auth", "User revoked by owner", { telegramId: target });
  await ctx.reply(`🚫 تم إلغاء صلاحية المستخدم ${target}`);
}

async function handleUsersCommand(ctx) {
  if (!(await requireOwner(ctx))) {
    return;
  }

  const users = await getAllowedUserEntries();
  if (users.length === 0) {
    await ctx.reply("لا يوجد مستخدمون مصرح لهم.");
    return;
  }

  const lines = [`👥 المستخدمون المصرح لهم (${users.length}):`, ""];
  for (const user of users) {
    const name = [user.firstName, user.username ? `@${user.username}` : ""].filter(Boolean).join(" ") || "-";
    lines.push(`• ${user.telegramId} — ${name}${user.isOwner ? " (المالك)" : ""}`);
  }

  for (const chunk of splitReplyLines(lines)) {
    await ctx.reply(chunk);
  }
}

async function handleOwnerPanelCommand(ctx) {
  if (!(await requireOwner(ctx))) {
    return;
  }

  await connectDb();
  const owner = getOwnerId(ctx);
  const [userCount, allowedCount, accountTotals, queue, rate] = await Promise.all([
    User.countDocuments({}).exec(),
    User.countDocuments({ $or: [{ isAllowed: true }, { isOwner: true }] }).exec(),
    Account.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]).exec(),
    getQueueStatus(),
    Promise.resolve(getRateLimitStats()),
  ]);

  const byStatus = { pending: 0, linking: 0, linked: 0, failed: 0, expired: 0 };
  for (const row of accountTotals) {
    if (row && row._id in byStatus) {
      byStatus[row._id] = row.count;
    }
  }

  const myAccounts = await Account.countDocuments({ owner }).exec();

  const lines = [
    "🛠️ لوحة المالك",
    "",
    `👥 المستخدمون: ${userCount} (مصرح: ${allowedCount})`,
    `📂 الحسابات: ${Object.values(byStatus).reduce((sum, value) => sum + value, 0)}`,
    `   • مرتبطة: ${byStatus.linked}`,
    `   • قيد الانتظار: ${byStatus.pending}`,
    `   • جاري الربط: ${byStatus.linking}`,
    `   • فاشلة: ${byStatus.failed}`,
    `   • منتهية: ${byStatus.expired}`,
    `   • حساباتك: ${myAccounts}`,
    "",
    `⚙️ طابور الدخول: انتظار ${queue.queued} • تنفيذ ${queue.processing} • تم ${queue.done} • فشل ${queue.failed}`,
    `   العامل: ${queue.workerRunning ? "يعمل" : "متوقف"} (مهام نشطة: ${queue.activeJobs})`,
    "",
    `🌐 طلبات API اليوم: ${rate.dailyRequestCount}/${rate.dailyLimit}`,
    `   التهدئة الحالية: ${rate.currentBackoffMs}ms`,
  ];

  for (const chunk of splitReplyLines(lines)) {
    await ctx.reply(chunk);
  }
}

async function handleSupportCommand(ctx) {
  const lang = await getContextLanguage(ctx);
  const supportUrl = "tg://user?id=8416210832";
  const text =
    lang === "en"
      ? `💬 For technical support and assistance, contact us directly:\n[Open Chat with Support](${supportUrl})`
      : `💬 للتواصل مع الدعم الفني والاستفسارات:\n[فتح محادثة الدعم الفني](${supportUrl})`;

  await ctx.reply(text, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [Markup.button.url(lang === "en" ? "💬 Contact Support" : "💬 تواصل مع الدعم", supportUrl)],
    ]),
  });
}

bot.start(handleStartCommand);
bot.command("status", handleStatusCommand);
bot.command("accounts", handleLinkedAccountsCommand);
bot.command("stop", handleStopCheckingCommand);
bot.command("deleteaccounts", (ctx) => handleDeleteAccountsCommand(ctx));
bot.action(/^accounts:page:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await handleDeleteAccountsCommand(ctx, Number(ctx.match[1]));
});
bot.action(/^accounts:delete:(all|[a-f0-9]{24})$/, async (ctx) => {
  await ctx.answerCbQuery();
  await promptDeleteAccounts(ctx, ctx.match[1]);
});
bot.action(/^accounts:confirm:([a-f0-9]{16})$/, async (ctx) => {
  await ctx.answerCbQuery();
  await confirmDeleteAccounts(ctx, ctx.match[1]);
});
bot.action(/^accounts:cancel:([a-f0-9]{16})$/, async (ctx) => {
  await ctx.answerCbQuery();
  const owner = getOwnerId(ctx);
  if (pendingAccountDeletionByChat.get(owner)?.nonce === ctx.match[1]) pendingAccountDeletionByChat.delete(owner);
  const lang = await getContextLanguage(ctx);
  await ctx.editMessageText(lang === "en" ? "Deletion cancelled." : "تم إلغاء الحذف.");
});
bot.command("tickets", handleTicketsCommand);
bot.command("newtickets", handleReportNewTickets);
bot.command("linklist", handleLinkListCommand);
bot.command("relink", handleRelinkCommand);
bot.command("help", handleHelpCommand);
bot.command("support", handleSupportCommand);
bot.command("language", handleLanguageCommand);
bot.command("lang", handleLanguageCommand);
bot.command("adduser", handleAddUserCommand);
bot.command("removeuser", handleRemoveUserCommand);
bot.command("users", handleUsersCommand);
bot.command("owner", handleOwnerPanelCommand);

const pendingAdminActionByChat = new Map();

async function handleAdminPanel(ctx) {
  const identity = getAuthIdentity(ctx);
  if (!(await isOwnerUser(identity.userId))) {
    const lang = await getContextLanguage(ctx);
    await ctx.reply(lang === "en" ? "⛔ Admin only" : "⛔ للمالك فقط");
    return;
  }
  const lang = await getContextLanguage(ctx);
  await ctx.reply(
    lang === "en"
      ? "👑 Admin Panel\n\nManage members and subscriptions:"
      : "👑 لوحة الإدارة\n\nإدارة الأعضاء والاشتراكات:",
    adminPanelKeyboard(lang),
  );
}

bot.action("admin:panel", async (ctx) => {
  await ctx.answerCbQuery();
  const identity = getAuthIdentity(ctx);
  if (!(await isOwnerUser(identity.userId))) return;
  const lang = await getContextLanguage(ctx);
  try {
    await ctx.deleteMessage();
  } catch {}
  await ctx.reply(
    lang === "en"
      ? "👑 Admin Panel\n\nManage members and subscriptions:"
      : "👑 لوحة الإدارة\n\nإدارة الأعضاء والاشتراكات:",
    adminPanelKeyboard(lang),
  );
});

bot.action("admin:add", async (ctx) => {
  await ctx.answerCbQuery();
  const identity = getAuthIdentity(ctx);
  if (!(await isOwnerUser(identity.userId))) return;
  const lang = await getContextLanguage(ctx);
  const chatId = ctx.chat ? ctx.chat.id : ctx.callbackQuery?.message?.chat?.id;
  pendingAdminActionByChat.set(String(chatId), { action: "add" });
  await ctx.reply(
    lang === "en" ? "➕ Send the Telegram ID of the new member:" : "➕ أرسل الـ Telegram ID للعضو الجديد:",
    Markup.keyboard([[getButtonLabel(lang, "cancel")]]).resize(),
  );
});

bot.action("admin:remove", async (ctx) => {
  await ctx.answerCbQuery();
  const identity = getAuthIdentity(ctx);
  if (!(await isOwnerUser(identity.userId))) return;
  const lang = await getContextLanguage(ctx);

  const users = await getAllowedUserEntries();
  const removable = users.filter((u) => !(botOwnerId && u.telegramId === botOwnerId));
  if (removable.length === 0) {
    await ctx.reply(lang === "en" ? "✅ No members to remove." : "✅ لا يوجد أعضاء لإزالتهم.");
    return;
  }

  const buttons = removable.map((u) => {
    const name = [u.firstName, u.username ? `@${u.username}` : ""].filter(Boolean).join(" ") || u.telegramId;
    return [Markup.button.callback(`❌ ${name} (${u.telegramId})`, `admin:rm:${u.telegramId}`)];
  });
  buttons.push([Markup.button.callback(lang === "en" ? "◀️ Back" : "◀️ رجوع", "admin:panel")]);

  await ctx.reply(
    lang === "en" ? "➖ Select member to remove:" : "➖ اختر العضو لإزالته:",
    Markup.inlineKeyboard(buttons),
  );
});

bot.action(/^admin:rm:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const identity = getAuthIdentity(ctx);
  if (!(await isOwnerUser(identity.userId))) return;
  const lang = await getContextLanguage(ctx);
  const target = ctx.match[1];

  if (botOwnerId && target === botOwnerId) {
    await ctx.reply(lang === "en" ? "⚠️ Cannot remove the owner." : "⚠️ لا يمكن إزالة المالك.");
    return;
  }

  const user = await revokeUser(target);
  if (!user) {
    await ctx.reply(lang === "en" ? `❌ User ${target} not found.` : `❌ العضو ${target} غير موجود.`);
  } else {
    logger.warn("auth", "User revoked via admin panel", { telegramId: target });
    await ctx.reply(lang === "en" ? `🚫 ${target} removed successfully.` : `🚫 تم إزالة العضو ${target} بنجاح.`);
  }
  try {
    await ctx.deleteMessage();
  } catch {}
  await ctx.reply(lang === "en" ? "👑 Admin Panel" : "👑 لوحة الإدارة", adminPanelKeyboard(lang));
});

bot.action("admin:members", async (ctx) => {
  await ctx.answerCbQuery();
  const identity = getAuthIdentity(ctx);
  if (!(await isOwnerUser(identity.userId))) return;
  const lang = await getContextLanguage(ctx);

  const users = await getAllowedUserEntries();
  if (users.length === 0) {
    await ctx.reply(lang === "en" ? "No members yet." : "لا يوجد أعضاء بعد.");
    return;
  }

  const lines = [
    lang === "en" ? `👥 Members (${users.length}):` : `👥 الأعضاء (${users.length}):`,
    "────────────────────",
  ];
  for (const user of users) {
    const name = [user.firstName, user.username ? `@${user.username}` : ""].filter(Boolean).join(" ") || "-";
    const sub = user.subscription || {};
    let badge = "";
    if (user.isOwner) badge = "👑";
    else if (sub.plan === "lifetime") badge = "♾️";
    else if (sub.plan && sub.plan !== "none" && sub.expiresAt && new Date(sub.expiresAt) >= new Date()) badge = "✅";
    else if (sub.expiresAt && new Date(sub.expiresAt) < new Date()) badge = "⚠️";
    else badge = "❌";
    lines.push(`${badge} ${user.telegramId} — ${name}`);
  }
  for (const chunk of splitReplyLines(lines)) {
    await ctx.reply(chunk);
  }
});

bot.action("admin:subs", async (ctx) => {
  await ctx.answerCbQuery();
  const identity = getAuthIdentity(ctx);
  if (!(await isOwnerUser(identity.userId))) return;
  const lang = await getContextLanguage(ctx);

  const users = await getAllowedUserEntries();
  if (users.length === 0) {
    await ctx.reply(lang === "en" ? "No members yet." : "لا يوجد أعضاء بعد.");
    return;
  }

  const lines = [
    lang === "en" ? `📋 Subscriptions (${users.length}):` : `📋 الاشتراكات (${users.length}):`,
    "────────────────────",
  ];
  for (const user of users) {
    const name = [user.firstName, user.username ? `@${user.username}` : ""].filter(Boolean).join(" ") || "-";
    const sub = user.subscription || {};
    let status, expiry;
    if (user.isOwner) {
      status = "👑 Owner";
      expiry = lang === "en" ? "Unlimited" : "غير محدود";
    } else if (!sub.plan || sub.plan === "none") {
      status = "❌ " + (lang === "en" ? "No subscription" : "بدون اشتراك");
      expiry = "-";
    } else if (sub.plan === "lifetime") {
      status = "♾️ Lifetime";
      expiry = lang === "en" ? "Never expires" : "لا ينتهي";
    } else if (sub.expiresAt && new Date(sub.expiresAt) < new Date()) {
      status = `⚠️ ${sub.plan} (` + (lang === "en" ? "EXPIRED" : "منتهي") + ")";
      expiry = new Date(sub.expiresAt).toLocaleDateString("en-GB");
    } else {
      status = `✅ ${sub.plan}`;
      expiry = sub.expiresAt ? new Date(sub.expiresAt).toLocaleDateString("en-GB") : "?";
    }
    lines.push(`• ${name} (${user.telegramId})`);
    lines.push(`  ${status} — ${lang === "en" ? "Expires" : "ينتهي"}: ${expiry}`);
    lines.push("");
  }
  for (const chunk of splitReplyLines(lines)) {
    await ctx.reply(chunk);
  }
});

bot.action("admin:manage", async (ctx) => {
  await ctx.answerCbQuery();
  const identity = getAuthIdentity(ctx);
  if (!(await isOwnerUser(identity.userId))) return;
  const lang = await getContextLanguage(ctx);

  const users = await getAllowedUserEntries();
  const manageable = users.filter((u) => !(botOwnerId && u.telegramId === botOwnerId));
  if (manageable.length === 0) {
    await ctx.reply(lang === "en" ? "No members to manage." : "لا يوجد أعضاء لإدارتهم.");
    return;
  }

  const buttons = manageable.map((u) => {
    const name = [u.firstName, u.username ? `@${u.username}` : ""].filter(Boolean).join(" ") || u.telegramId;
    const sub = u.subscription || {};
    let badge = "❌";
    if (sub.plan === "lifetime") badge = "♾️";
    else if (sub.plan && sub.plan !== "none" && sub.expiresAt && new Date(sub.expiresAt) >= new Date()) badge = "✅";
    else if (sub.expiresAt && new Date(sub.expiresAt) < new Date()) badge = "⚠️";
    return [Markup.button.callback(`${badge} ${name}`, `admin:mng:${u.telegramId}`)];
  });
  buttons.push([Markup.button.callback(lang === "en" ? "◀️ Back" : "◀️ رجوع", "admin:panel")]);

  await ctx.reply(
    lang === "en" ? "⚙️ Select member to manage:" : "⚙️ اختر العضو لإدارته:",
    Markup.inlineKeyboard(buttons),
  );
});

bot.action(/^admin:mng:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const identity = getAuthIdentity(ctx);
  if (!(await isOwnerUser(identity.userId))) return;
  const lang = await getContextLanguage(ctx);
  const targetId = ctx.match[1];

  const user = await User.findOne({ telegramId: targetId }).lean().exec();
  const sub = (user && user.subscription) || {};
  const name = user
    ? [user.firstName, user.username ? `@${user.username}` : ""].filter(Boolean).join(" ") || targetId
    : targetId;
  let statusText;
  if (!sub.plan || sub.plan === "none") {
    statusText = "❌ " + (lang === "en" ? "No subscription" : "بدون اشتراك");
  } else if (sub.plan === "lifetime") {
    statusText = "♾️ Lifetime";
  } else if (sub.expiresAt && new Date(sub.expiresAt) < new Date()) {
    statusText =
      `⚠️ ${sub.plan} (` +
      (lang === "en"
        ? `expired ${new Date(sub.expiresAt).toLocaleDateString("en-GB")}`
        : `انتهى ${new Date(sub.expiresAt).toLocaleDateString("en-GB")}`) +
      ")";
  } else {
    const exp = sub.expiresAt ? new Date(sub.expiresAt).toLocaleDateString("en-GB") : "?";
    statusText = `✅ ${sub.plan} — ${lang === "en" ? "until" : "حتى"} ${exp}`;
  }

  try {
    await ctx.deleteMessage();
  } catch {}
  await ctx.reply(
    lang === "en"
      ? `⚙️ Manage: ${name}\n🆔 ID: ${targetId}\n📋 Status: ${statusText}`
      : `⚙️ إدارة: ${name}\n🆔 المعرف: ${targetId}\n📋 الحالة: ${statusText}`,
    manageSubKeyboard(lang, targetId),
  );
});

bot.action(/^admin:chplan:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const identity = getAuthIdentity(ctx);
  if (!(await isOwnerUser(identity.userId))) return;
  const lang = await getContextLanguage(ctx);
  const targetId = ctx.match[1];
  try {
    await ctx.deleteMessage();
  } catch {}
  await ctx.reply(
    lang === "en" ? `🔄 Choose new plan for ${targetId}:` : `🔄 اختر خطة جديدة لـ ${targetId}:`,
    subPlanKeyboard(lang, targetId),
  );
});

bot.action(/^admin:extend:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const identity = getAuthIdentity(ctx);
  if (!(await isOwnerUser(identity.userId))) return;
  const lang = await getContextLanguage(ctx);
  const targetId = ctx.match[1];
  try {
    await ctx.deleteMessage();
  } catch {}
  await ctx.reply(
    lang === "en" ? `➕ Extend by how long for ${targetId}?` : `➕ مدد بكام لـ ${targetId}؟`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback("📅 +1 Week", `admin:ext:${targetId}:1week`),
        Markup.button.callback("📅 +1 Month", `admin:ext:${targetId}:1month`),
      ],
      [Markup.button.callback("📅 +3 Months", `admin:ext:${targetId}:3months`)],
      [Markup.button.callback(lang === "en" ? "◀️ Back" : "◀️ رجوع", `admin:mng:${targetId}`)],
    ]),
  );
});

bot.action(/^admin:ext:(\d+):(\w+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const identity = getAuthIdentity(ctx);
  if (!(await isOwnerUser(identity.userId))) return;
  const lang = await getContextLanguage(ctx);
  const targetId = ctx.match[1];
  const period = ctx.match[2];

  const durations = { "1week": 7 * 86400000, "1month": 30 * 86400000, "3months": 90 * 86400000 };
  const addMs = durations[period];
  if (!addMs) {
    await ctx.reply("❌ Invalid period");
    return;
  }

  const user = await User.findOne({ telegramId: targetId }).exec();
  if (!user) {
    await ctx.reply(`❌ ${targetId} not found.`);
    return;
  }

  const sub = user.subscription || {};
  const now = new Date();

  const base = sub.expiresAt && new Date(sub.expiresAt) > now ? new Date(sub.expiresAt) : now;
  const newExpiry = new Date(base.getTime() + addMs);

  await User.updateOne(
    { telegramId: targetId },
    { $set: { isAllowed: true, "subscription.expiresAt": newExpiry, "subscription.plan": sub.plan || "1month" } },
  ).exec();

  try {
    await ctx.deleteMessage();
  } catch {}
  await ctx.reply(
    lang === "en"
      ? `✅ Extended ${targetId} by ${period}.\n📅 New expiry: ${newExpiry.toLocaleDateString("en-GB")}`
      : `✅ تم تمديد ${targetId} بـ ${period}.\n📅 ينتهي: ${newExpiry.toLocaleDateString("en-GB")}`,
  );
  await ctx.reply(lang === "en" ? "👑 Admin Panel" : "👑 لوحة الإدارة", adminPanelKeyboard(lang));
});

bot.action(/^admin:revoke:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const identity = getAuthIdentity(ctx);
  if (!(await isOwnerUser(identity.userId))) return;
  const lang = await getContextLanguage(ctx);
  const targetId = ctx.match[1];

  await User.removeSubscription(targetId);
  logger.warn("auth", "Subscription revoked via admin", { telegramId: targetId });

  try {
    await ctx.deleteMessage();
  } catch {}
  await ctx.reply(lang === "en" ? `🚫 Subscription revoked for ${targetId}.` : `🚫 تم إلغاء اشتراك ${targetId}.`);
  await ctx.reply(lang === "en" ? "👑 Admin Panel" : "👑 لوحة الإدارة", adminPanelKeyboard(lang));
});

bot.action(/^admin:sub:(\d+):(\w+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const identity = getAuthIdentity(ctx);
  if (!(await isOwnerUser(identity.userId))) return;
  const lang = await getContextLanguage(ctx);
  const targetId = ctx.match[1];
  const plan = ctx.match[2];

  try {
    const user = await User.setSubscription(targetId, plan);
    const exp =
      user.subscription && user.subscription.expiresAt
        ? new Date(user.subscription.expiresAt).toLocaleDateString("en-GB")
        : "♾️";
    try {
      await ctx.deleteMessage();
    } catch {}
    await ctx.reply(
      lang === "en"
        ? `✅ Done!\n\n👤 User: ${targetId}\n📋 Plan: ${plan}\n📅 Expires: ${exp}`
        : `✅ تم!\n\n👤 العضو: ${targetId}\n📋 الخطة: ${plan}\n📅 ينتهي: ${exp}`,
    );
  } catch (err) {
    await ctx.reply(`❌ Error: ${err.message}`);
  }
  await ctx.reply(lang === "en" ? "👑 Admin Panel" : "👑 لوحة الإدارة", adminPanelKeyboard(lang));
});

bot.action("admin:back", async (ctx) => {
  await ctx.answerCbQuery();
  const lang = await getContextLanguage(ctx);
  try {
    await ctx.deleteMessage();
  } catch {}
  await replyWithMenu(ctx, lang === "en" ? "Returned to main menu." : "تمت العودة للقائمة الرئيسية.", lang);
});

bot.on("text", async (ctx, next) => {
  const messageText = (ctx.message?.text || "").trim();
  if (messageText.startsWith("/")) {
    return next();
  }

  if (getAllButtonTexts("admin").includes(messageText)) {
    await handleAdminPanel(ctx);
    return undefined;
  }

  const chatId = ctx.chat ? ctx.chat.id : undefined;
  const pendingAdmin = chatId ? pendingAdminActionByChat.get(String(chatId)) : null;
  if (pendingAdmin && pendingAdmin.action === "add") {
    if (getAllButtonTexts("cancel").includes(messageText)) {
      pendingAdminActionByChat.delete(String(chatId));
      await replyWithMenu(ctx, (await getContextLanguage(ctx)) === "en" ? "Cancelled." : "تم الإلغاء.");
      return undefined;
    }
    if (/^\d+$/.test(messageText)) {
      pendingAdminActionByChat.delete(String(chatId));
      const lang = await getContextLanguage(ctx);

      await authorizeUser({ userId: messageText });
      logger.success("auth", "User added via admin panel", { telegramId: messageText });
      await ctx.reply(
        lang === "en"
          ? `✅ Member ${messageText} added.\n\nNow choose their subscription plan:`
          : `✅ تم إضافة العضو ${messageText}.\n\nاختر خطة الاشتراك:`,
        subPlanKeyboard(lang, messageText),
      );
      return undefined;
    }
    const lang = await getContextLanguage(ctx);
    await ctx.reply(
      lang === "en" ? "⚠️ Send a valid Telegram ID (numbers only)." : "⚠️ أرسل Telegram ID صحيح (أرقام فقط).",
    );
    return undefined;
  }

  if (pendingAdmin && pendingAdmin.action === "givesub") {
    if (getAllButtonTexts("cancel").includes(messageText)) {
      pendingAdminActionByChat.delete(String(chatId));
      await replyWithMenu(ctx, (await getContextLanguage(ctx)) === "en" ? "Cancelled." : "تم الإلغاء.");
      return undefined;
    }
    if (/^\d+$/.test(messageText)) {
      pendingAdminActionByChat.delete(String(chatId));
      const lang = await getContextLanguage(ctx);
      await ctx.reply(
        lang === "en" ? `Choose plan for user ${messageText}:` : `اختر الخطة للمستخدم ${messageText}:`,
        subPlanKeyboard(lang, messageText),
      );
      return undefined;
    }
    const lang = await getContextLanguage(ctx);
    await ctx.reply(
      lang === "en" ? "⚠️ Send a valid Telegram ID (numbers only)." : "⚠️ أرسل Telegram ID صحيح (أرقام فقط).",
    );
    return undefined;
  }

  if (getAllButtonTexts("link").includes(messageText)) {
    await promptForBulkLinkInput(ctx);
    return undefined;
  }

  if (getAllButtonTexts("tickets").includes(messageText)) {
    await handleTicketsCommand(ctx);
    return undefined;
  }

  if (getAllButtonTexts("moneyAccounts").includes(messageText)) {
    await handleMoneyAccountsCommand(ctx);
    return undefined;
  }

  if (getAllButtonTexts("stopChecking").includes(messageText)) {
    await handleStopCheckingCommand(ctx);
    return undefined;
  }

  if (getAllButtonTexts("deleteAccounts").includes(messageText)) {
    await handleDeleteAccountsCommand(ctx);
    return undefined;
  }

  if (getAllButtonTexts("linkedAccounts").includes(messageText)) {
    await handleLinkedAccountsCommand(ctx);
    return undefined;
  }

  if (getAllButtonTexts("status").includes(messageText)) {
    await handleStatusCommand(ctx);
    return undefined;
  }

  if (getAllButtonTexts("help").includes(messageText)) {
    await handleHelpCommand(ctx);
    return undefined;
  }

  if (getAllButtonTexts("support").includes(messageText)) {
    await handleSupportCommand(ctx);
    return undefined;
  }

  if (getAllReportButtonTexts("general").includes(messageText)) {
    await handleReportGeneralInfo(ctx);
    return undefined;
  }

  if (getAllReportButtonTexts("accountsWithTickets").includes(messageText)) {
    await handleReportAccountsWithTickets(ctx);
    return undefined;
  }

  if (getAllReportButtonTexts("newTickets").includes(messageText)) {
    await handleReportNewTickets(ctx);
    return undefined;
  }

  if (getAllReportButtonTexts("organized").includes(messageText)) {
    await handleReportOrganizedDetails(ctx);
    return undefined;
  }

  if (getAllReportButtonTexts("bySection").includes(messageText)) {
    await handleReportTicketsBySection(ctx);
    return undefined;
  }

  if (getAllReportButtonTexts("adjacent").includes(messageText)) {
    await handleReportAdjacentSeats(ctx);
    return undefined;
  }

  if (getAllReportButtonTexts("scattered").includes(messageText)) {
    await handleReportScatteredSeats(ctx);
    return undefined;
  }

  if (getAllReportButtonTexts("checkEvent").includes(messageText)) {
    await handleCheckEventCommand(ctx);
    return undefined;
  }

  if (getAllButtonTexts("relink").includes(messageText)) {
    await handleRelinkCommand(ctx);
    return undefined;
  }

  if (getAllReportButtonTexts("errors").includes(messageText)) {
    await handleReportErrorsDetails(ctx);
    return undefined;
  }

  if (getAllReportButtonTexts("rerun").includes(messageText)) {
    await handleTicketsCommand(ctx);
    return undefined;
  }

  if (getAllReportButtonTexts("back").includes(messageText)) {
    await handleBackToMainMenu(ctx);
    return undefined;
  }

  if (getAllButtonTexts("cancel").includes(messageText)) {
    await handleCancelCommand(ctx);
    return undefined;
  }

  if (getAllButtonTexts("language").includes(messageText)) {
    await handleLanguageCommand(ctx);
    return undefined;
  }

  if (!getPendingBulkInput(ctx.chat.id)) {

    const pendingEvent = pendingEventCheckByChat.get(ctx.chat.id);
    if (pendingEvent && messageText.includes("webook.com")) {
      pendingEventCheckByChat.delete(ctx.chat.id);
      void checkEventEligibility(ctx, messageText, pendingEvent.accounts, pendingEvent.lang).catch(async (err) => {
        logger.error("eventCheck", "Event eligibility check failed", { error: err.message });
        await replyWithReportMenu(
          ctx,
          pendingEvent.lang === "en" ? "❌ Error: " + err.message : "❌ خطأ: " + err.message,
          pendingEvent.lang,
        );
      });
      return undefined;
    }
    return next();
  }

  await queuePendingBulkInputText(ctx, ctx.message?.text || "");
  return undefined;
});

bot.catch(async (error, ctx) => {
  console.error("Bot handler error:", error);
  if (ctx) {
    const lang = await getContextLanguage(ctx);
    await replyWithMenu(ctx, translate(lang, "unexpectedError"), lang);
  }
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});

async function bootstrap() {
  await connectDb();
  await ensureBotOwner();

  try {
    const bannedPurged = await Account.autoRemoveBannedAccounts();
    if (bannedPurged > 0) {
      logger.success("bot", `Auto-purged ${bannedPurged} banned accounts on startup`);
      console.log(`Auto-purged ${bannedPurged} banned accounts on startup.`);
    }
  } catch (err) {
    logger.warn("bot", "Failed to auto-purge banned accounts on startup", { error: err.message });
  }

  setLoginNotifier(notifyLoginProgress);
  await startLoginWorker();

  await bot.launch();
  logger.success("bot", "Bot started", {
    owner: botOwnerId || "(unset)",
    eventCheckConcurrency,
  });
  console.log("Bot started.");
}

bootstrap().catch((error) => {
  logger.error("bot", "Startup failed", { error: (error && error.message) || String(error) });
  process.exitCode = 1;
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

function extractEventSlug(eventUrl) {
  const raw = String(eventUrl || "").trim();
  if (!raw) {
    return "";
  }

  let pathname = raw;
  try {
    pathname = new URL(raw).pathname;
  } catch {
    pathname = raw.replace(/^https?:\/\/[^/]+/i, "");
  }

  const segments = pathname
    .split("?")[0]
    .split("#")[0]
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((segment) => segment !== "book");

  if (segments.length === 0) {
    return "";
  }

  const eventsIdx = segments.lastIndexOf("events");
  if (eventsIdx !== -1 && segments[eventsIdx + 1]) {
    return segments[eventsIdx + 1];
  }

  return segments[segments.length - 1];
}

async function handleCheckEventCommand(ctx) {
  const lang = await getContextLanguage(ctx);
  const accounts = await getLinkedAccounts(getOwnerId(ctx));
  if (!accounts || accounts.length === 0) {
    await replyWithReportMenu(
      ctx,
      lang === "en"
        ? "❌ No linked accounts found. Link accounts first."
        : "❌ لا توجد حسابات مربوطة. اربط الحسابات أولاً.",
      lang,
    );
    return;
  }
  pendingEventCheckByChat.set(ctx.chat.id, { lang, accounts });
  await ctx.reply(
    lang === "en"
      ? "🔗 Send the event URL (e.g. https://webook.com/ar/events/...)"
      : "🔗 أرسل رابط الفعالية (مثال: https://webook.com/ar/events/...)",
    Markup.keyboard([[getReportButtonLabel(lang, "back")]]).resize(),
  );
}

async function checkEventEligibility(ctx, eventUrl, accounts, lang) {
  const slug = extractEventSlug(eventUrl);
  if (!slug) {
    await replyWithReportMenu(
      ctx,
      lang === "en" ? "❌ Could not read the event slug from that URL." : "❌ لم أستطع قراءة معرف الفعالية من الرابط.",
      lang,
    );
    return;
  }

  const totalCount = accounts.length;
  const progressMsg = await ctx.reply(
    lang === "en" ? `⏳ Checking eligibility for ${totalCount} accounts...` : `⏳ جاري فحص ${totalCount} حساب...`,
  );
  const chatId = ctx.chat.id;

  logger.info("eventCheck", "Starting API eligibility check", {
    slug,
    accounts: totalCount,
    concurrency: eventCheckConcurrency,
  });

  const eligible = [];
  const notEligible = [];
  const errors = [];
  let checked = 0;

  async function checkAccount(account) {
    try {
      if (!account.jwt) {
        errors.push({ account, reason: "no API token" });
        return;
      }

      const verdict = await checkEligibility(
        { jwt: account.jwt, hexToken: account.hexToken, email: account.username },
        slug,
      );

      if (verdict.status === 401 || verdict.status === 403) {

        const stillValid = await isTokenValid({
          jwt: account.jwt,
          hexToken: account.hexToken,
          email: account.username,
        });

        if (stillValid) {
          errors.push({ account, reason: `blocked (HTTP ${verdict.status})` });
          return;
        }

        errors.push({ account, reason: "token expired" });
        await refreshSavedSession(account).catch(() => {});
        return;
      }

      if (verdict.eligible) {
        eligible.push(account);
      } else {
        notEligible.push(account);
      }
    } catch (error) {
      errors.push({ account, reason: error.message });
    } finally {
      checked += 1;
      if (checked % 10 === 0 || checked === totalCount) {
        try {
          await ctx.telegram.editMessageText(
            chatId,
            progressMsg.message_id,
            null,
            lang === "en"
              ? `⏳ Checked ${checked}/${totalCount}... (✅ ${eligible.length} eligible)`
              : `⏳ تم فحص ${checked}/${totalCount}... (✅ ${eligible.length} مؤهل)`,
          );
        } catch {}
      }
    }
  }

  await mapWithConcurrency(accounts, eventCheckConcurrency, checkAccount);

  logger.success("eventCheck", "Eligibility check finished", {
    slug,
    eligible: eligible.length,
    notEligible: notEligible.length,
    errors: errors.length,
  });

  let header = "";
  if (lang === "en") {
    header += `✅ Event Check Complete\n\n`;
    header += `📊 Total: ${totalCount} | Eligible: ${eligible.length} | Not Eligible: ${notEligible.length} | Errors: ${errors.length}`;
  } else {
    header += `✅ اكتمل فحص الفعالية\n\n`;
    header += `📊 الإجمالي: ${totalCount} | مؤهل: ${eligible.length} | غير مؤهل: ${notEligible.length} | أخطاء: ${errors.length}`;
  }

  try {
    await ctx.telegram.editMessageText(chatId, progressMsg.message_id, null, header);
  } catch {
    await ctx.reply(header);
  }

  if (eligible.length > 0) {
    const eligibleHeader = lang === "en" ? "✅ Eligible accounts:" : "✅ الحسابات المؤهلة:";
    const eligibleLines = [eligibleHeader, ...eligible.map((a) => `• ${getDisplayedUsername(a)}`)];
    for (const chunk of splitReplyLines(eligibleLines, 3800)) {
      await ctx.reply(chunk);
    }
  } else {
    await ctx.reply(lang === "en" ? "❌ No eligible accounts found." : "❌ لا توجد حسابات مؤهلة.");
  }

  if (errors.length > 0 && errors.length <= 20) {
    const errHeader = `\n⚠️ ${lang === "en" ? "Errors" : "أخطاء"}:`;
    const errLines = [
      errHeader,
      ...errors.map((e) => `• ${getDisplayedUsername(e.account)}: ${String(e.reason).slice(0, 50)}`),
    ];
    for (const chunk of splitReplyLines(errLines, 3800)) {
      await ctx.reply(chunk);
    }
  }

  await replyWithReportMenu(ctx, lang === "en" ? "Choose another option:" : "اختر خيار آخر:", lang);
}
