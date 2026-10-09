const mongoose = require("mongoose");

const JOB_STATUSES = ["queued", "processing", "done", "failed", "cancelled"];

const loginJobSchema = new mongoose.Schema(
  {
    owner: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: JOB_STATUSES,
      default: "queued",
    },
    attempts: {
      type: Number,
      default: 0,
      min: 0,
    },
    maxAttempts: {
      type: Number,
      default: 3,
      min: 1,
    },
    error: {
      type: String,
      default: "",
    },
    startedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    collection: "loginjobs",
  },
);

loginJobSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.models.LoginJob || mongoose.model("LoginJob", loginJobSchema);
module.exports.JOB_STATUSES = JOB_STATUSES;
