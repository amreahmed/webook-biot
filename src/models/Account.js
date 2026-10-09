const mongoose = require("mongoose");
const { encryptJson, decryptJson } = require("../crypto");

const ACCOUNT_STATUSES = ["pending", "linking", "linked", "failed", "expired"];

const accountSchema = new mongoose.Schema(
  {
    owner: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      set: (val) =>
        String(val ?? "")
          .replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E\u00A0]/g, "")
          .trim()
          .toLowerCase(),
    },

    password: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ACCOUNT_STATUSES,
      default: "pending",
      index: true,
    },
    jwt: {
      type: String,
      default: "",
    },
    refreshToken: {
      type: String,
      default: "",
    },
    hexToken: {
      type: String,
      default: "",
    },

    sessionData: {
      type: String,
      default: "",
    },

    liveApiHeaders: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    liveApiHeadersCapturedAt: {
      type: String,
      default: "",
    },
    linkedAt: {
      type: Date,
      default: null,
    },
    tokenExpiresAt: {
      type: Date,
      default: null,
    },
    lastCheckAt: {
      type: Date,
      default: null,
    },
    lastError: {
      type: String,
      default: "",
    },
    retryCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    knownTicketKeys: {
      type: [String],
      default: [],
    },
    lastTicketCount: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
    collection: "accounts",
  },
);

accountSchema.index({ owner: 1, email: 1 }, { unique: true });

function encryptToString(value) {
  return JSON.stringify(encryptJson(value));
}

function decryptFromString(value) {
  if (!value) {
    return null;
  }

  let payload;
  try {
    payload = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw new Error("Stored encrypted value is not valid JSON.");
  }

  return decryptJson(payload);
}

accountSchema.methods.setPassword = function setPassword(plainPassword) {
  const plain = String(plainPassword ?? "");
  if (!plain) {
    throw new Error("Password cannot be empty.");
  }

  this.password = encryptToString(plain);
  return this;
};

accountSchema.methods.getPassword = function getPassword() {
  try {
    const value = decryptFromString(this.password);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
};

accountSchema.methods.setSessionData = function setSessionData(storageState) {
  this.sessionData = storageState ? encryptToString(storageState) : "";
  return this;
};

accountSchema.methods.clearSession = function clearSession(reason = "Session expired.") {
  this.sessionData = "";
  this.jwt = "";
  this.hexToken = "";
  this.refreshToken = "";
  this.tokenExpiresAt = null;
  this.liveApiHeaders = null;
  this.liveApiHeadersCapturedAt = "";
  this.lastError = String(reason || "").slice(0, 1000);
  this.status = "expired";
  return this;
};

accountSchema.methods.getSessionData = function getSessionData() {
  try {
    return decryptFromString(this.sessionData);
  } catch {
    return null;
  }
};

accountSchema.methods.hasApiTokens = function hasApiTokens() {
  return Boolean(this.jwt);
};

accountSchema.methods.isTokenExpired = function isTokenExpired() {
  if (!this.tokenExpiresAt) {
    return false;
  }

  return this.tokenExpiresAt.getTime() <= Date.now();
};

accountSchema.statics.upsertCredentials = async function upsertCredentials(owner, email, plainPassword) {
  const ownerId = String(owner ?? "").trim();
  const normalizedEmail = String(email ?? "")
    .replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E\u00A0]/g, "")
    .trim()
    .toLowerCase();
  const plain = String(plainPassword ?? "");

  if (!ownerId) throw new Error("owner is required.");
  if (!normalizedEmail) throw new Error("email is required.");
  if (!plain) throw new Error("password is required.");

  let account = await this.findOne({ owner: ownerId, email: normalizedEmail }).exec();
  if (!account) {
    account = new this({ owner: ownerId, email: normalizedEmail, password: "x" });
  }

  account.setPassword(plain);
  if (account.status === "failed" || account.status === "expired") {
    account.status = "pending";
    account.retryCount = 0;
    account.lastError = "";
  }

  await account.save();
  return account;
};

accountSchema.statics.expireSessionForReauth = async function expireSessionForReauth(
  owner,
  accountId,
  reason = "Session expired.",
) {
  const ownerId = String(owner ?? "").trim();
  const targetId = String(accountId ?? "").trim();

  if (!ownerId || !targetId) {
    return null;
  }

  const account = await this.findOne({ _id: targetId, owner: ownerId }).exec();
  if (!account) {
    return null;
  }

  account.clearSession(reason);
  await account.save();
  return account;
};

accountSchema.statics.markSessionExpired = async function markSessionExpired(owner, accountId, jwt, reason) {
  return this.updateOne(
    { _id: accountId, owner: String(owner), jwt: jwt || "", status: { $in: ["linked", "expired"] } },
    { $set: { status: "expired", lastError: String(reason).slice(0, 1000), lastCheckAt: new Date() } },
  ).exec();
};

accountSchema.statics.removeBannedAccount = async function removeBannedAccount(accountId) {
  if (!accountId) return;
  await this.deleteOne({ _id: accountId }).exec();
  const LoginJob = mongoose.models.LoginJob;
  if (LoginJob) {
    await LoginJob.deleteMany({ accountId }).exec();
  }
};

accountSchema.statics.autoRemoveBannedAccounts = async function autoRemoveBannedAccounts() {
  const bannedPattern = /blocked due to malicious activity|تم حظر الحساب|تم حظرك|account.*blocked|حساب.*محظور|تم إيقاف الحساب|account has been locked/i;
  const banned = await this.find({
    $or: [
      { lastError: bannedPattern },
      { status: "failed", lastError: /blocked|حظر/i },
    ],
  }).select("_id email").exec();

  if (banned.length === 0) return 0;

  const ids = banned.map((a) => a._id);
  await this.deleteMany({ _id: { $in: ids } }).exec();

  const LoginJob = mongoose.models.LoginJob;
  if (LoginJob) {
    await LoginJob.deleteMany({ accountId: { $in: ids } }).exec();
  }

  return banned.length;
};

module.exports = mongoose.models.Account || mongoose.model("Account", accountSchema);
module.exports.ACCOUNT_STATUSES = ACCOUNT_STATUSES;
