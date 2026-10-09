const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    telegramId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    username: {
      type: String,
      default: "",
      trim: true,
    },
    firstName: {
      type: String,
      default: "",
      trim: true,
    },
    isAllowed: {
      type: Boolean,
      default: false,
    },
    isOwner: {
      type: Boolean,
      default: false,
    },

    subscription: {
      plan: {
        type: String,
        enum: ["none", "1week", "1month", "3months", "lifetime"],
        default: "none",
      },
      startedAt: {
        type: Date,
        default: null,
      },
      expiresAt: {
        type: Date,
        default: null,
      },
      autoRenew: {
        type: Boolean,
        default: false,
      },
    },
  },
  {
    timestamps: true,
    collection: "users",
  },
);

userSchema.statics.upsertFromTelegram = async function upsertFromTelegram(identity = {}) {
  const telegramId = String(identity.id ?? identity.telegramId ?? "").trim();
  if (!telegramId) {
    throw new Error("telegramId is required to upsert a user.");
  }

  const update = {
    $setOnInsert: { telegramId },
    $set: {},
  };

  const username = String(identity.username ?? "").trim();
  const firstName = String(identity.firstName ?? identity.first_name ?? "").trim();
  if (username) {
    update.$set.username = username;
  }
  if (firstName) {
    update.$set.firstName = firstName;
  }
  if (Object.keys(update.$set).length === 0) {
    delete update.$set;
  }

  return this.findOneAndUpdate({ telegramId }, update, {
    returnDocument: "after",
    upsert: true,
    setDefaultsOnInsert: true,
  }).exec();
};

userSchema.statics.isAllowedUser = async function isAllowedUser(telegramId) {
  const id = String(telegramId ?? "").trim();
  if (!id) {
    return false;
  }

  const user = await this.findOne({ telegramId: id }).select("isAllowed isOwner subscription").lean().exec();
  if (!user) return false;
  if (user.isOwner) return true;
  if (!user.isAllowed) return false;

  const sub = user.subscription;
  if (!sub || !sub.plan || sub.plan === "none") {
    return false;
  }
  if (sub.plan === "lifetime") {
    return true;
  }

  if (sub.expiresAt && new Date(sub.expiresAt) < new Date()) {
    return false;
  }

  return true;
};

userSchema.statics.getSubscriptionStatus = async function getSubscriptionStatus(telegramId) {
  const id = String(telegramId ?? "").trim();
  if (!id) return null;
  const user = await this.findOne({ telegramId: id }).select("subscription isOwner isAllowed").lean().exec();
  if (!user) return null;
  if (user.isOwner) return { active: true, plan: "lifetime", reason: "owner" };

  const sub = user.subscription || {};
  if (!sub.plan || sub.plan === "none") {
    return { active: user.isAllowed, plan: "none", reason: user.isAllowed ? "manual" : "no-sub" };
  }
  if (sub.plan === "lifetime") {
    return { active: true, plan: "lifetime", reason: "lifetime" };
  }
  if (sub.expiresAt && new Date(sub.expiresAt) < new Date()) {
    return { active: false, plan: sub.plan, reason: "expired", expiresAt: sub.expiresAt };
  }
  return { active: true, plan: sub.plan, reason: "active", expiresAt: sub.expiresAt, startedAt: sub.startedAt };
};

userSchema.statics.setSubscription = async function setSubscription(telegramId, plan) {
  const id = String(telegramId ?? "").trim();
  if (!id) throw new Error("telegramId required");

  const durations = {
    "1week": 7 * 24 * 60 * 60 * 1000,
    "1month": 30 * 24 * 60 * 60 * 1000,
    "3months": 90 * 24 * 60 * 60 * 1000,
    "lifetime": null,
  };

  if (!(plan in durations)) {
    throw new Error(`Invalid plan: ${plan}. Valid: ${Object.keys(durations).join(", ")}`);
  }

  const now = new Date();
  const expiresAt = durations[plan] ? new Date(now.getTime() + durations[plan]) : null;

  return this.findOneAndUpdate(
    { telegramId: id },
    {
      $setOnInsert: { telegramId: id },
      $set: {
        isAllowed: true,
        "subscription.plan": plan,
        "subscription.startedAt": now,
        "subscription.expiresAt": expiresAt,
      },
    },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true },
  ).exec();
};

userSchema.statics.removeSubscription = async function removeSubscription(telegramId) {
  const id = String(telegramId ?? "").trim();
  if (!id) return null;

  return this.findOneAndUpdate(
    { telegramId: id },
    {
      $set: {
        isAllowed: false,
        "subscription.plan": "none",
        "subscription.expiresAt": null,
      },
    },
    { returnDocument: "after" },
  ).exec();
};

module.exports = mongoose.models.User || mongoose.model("User", userSchema);
