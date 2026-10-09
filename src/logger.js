const LOG_LEVELS = {
  debug: 10,
  info: 20,
  success: 25,
  warn: 30,
  error: 40,
};

const activeLevelName = String(process.env.LOG_LEVEL || "info").toLowerCase();
const activeLevel = LOG_LEVELS[activeLevelName] || LOG_LEVELS.info;
const useColors = process.stdout.isTTY && String(process.env.LOG_COLORS || "true").toLowerCase() !== "false";

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  gray: "\x1b[90m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
};

function colorize(text, color) {
  if (!useColors || !color) {
    return text;
  }

  return `${color}${text}${COLORS.reset}`;
}

function pad(value, length = 2) {
  return String(value).padStart(length, "0");
}

function formatTimestamp(date = new Date()) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("-")
    + " "
    + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join(":")
    + "."
    + pad(date.getMilliseconds(), 3);
}

function normalizeMeta(meta) {
  if (!meta || typeof meta !== "object") {
    return "";
  }

  const parts = [];
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    parts.push(`${key}=${value}`);
  }
  return parts.join(" ");
}

function write(level, scope, message, meta) {
  if ((LOG_LEVELS[level] || LOG_LEVELS.info) < activeLevel) {
    return;
  }

  const levelLabel = level.toUpperCase().padEnd(7, " ");
  const levelColor =
    level === "error"
      ? COLORS.red
      : level === "warn"
        ? COLORS.yellow
        : level === "success"
          ? COLORS.green
          : level === "debug"
            ? COLORS.magenta
            : COLORS.cyan;

  const timestamp = colorize(formatTimestamp(), COLORS.gray);
  const scopeLabel = scope ? colorize(`[${scope}]`, COLORS.blue) : "";
  const metaText = normalizeMeta(meta);
  const line = [timestamp, colorize(levelLabel, levelColor), scopeLabel, message, metaText].filter(Boolean).join(" ");

  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}

function info(scope, message, meta) {
  write("info", scope, message, meta);
}

function success(scope, message, meta) {
  write("success", scope, message, meta);
}

function warn(scope, message, meta) {
  write("warn", scope, message, meta);
}

function error(scope, message, meta) {
  write("error", scope, message, meta);
}

function debug(scope, message, meta) {
  write("debug", scope, message, meta);
}

module.exports = {
  info,
  success,
  warn,
  error,
  debug,
};
