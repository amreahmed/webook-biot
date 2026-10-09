const mongoose = require("mongoose");
const logger = require("./logger");

const DEFAULT_URI = "mongodb://127.0.0.1:27017/webook_bot";

const mongoUri = String(process.env.MONGODB_URI || DEFAULT_URI).trim() || DEFAULT_URI;
const serverSelectionTimeoutMs = Math.max(1000, Number(process.env.MONGODB_TIMEOUT_MS || 10000));

let connectPromise = null;
let listenersBound = false;

function bindConnectionListeners() {
  if (listenersBound) {
    return;
  }

  listenersBound = true;
  const connection = mongoose.connection;

  connection.on("connected", () => {
    logger.success("db", "MongoDB connected", { db: connection.name });
  });

  connection.on("disconnected", () => {
    logger.warn("db", "MongoDB disconnected");
  });

  connection.on("reconnected", () => {
    logger.info("db", "MongoDB reconnected");
  });

  connection.on("error", (error) => {
    logger.error("db", "MongoDB connection error", { error: error && error.message });
  });
}

async function connectDb() {
  if (mongoose.connection.readyState === 1) {
    return mongoose;
  }

  if (connectPromise) {
    return connectPromise;
  }

  bindConnectionListeners();
  mongoose.set("strictQuery", true);

  connectPromise = mongoose
    .connect(mongoUri, {
      serverSelectionTimeoutMS: serverSelectionTimeoutMs,
      maxPoolSize: Math.max(5, Number(process.env.MONGODB_POOL_SIZE || 100)),
    })
    .then((instance) => instance)
    .catch((error) => {
      connectPromise = null;
      logger.error("db", "Could not connect to MongoDB", { uri: maskUri(mongoUri), error: error.message });
      throw error;
    });

  return connectPromise;
}

async function disconnectDb() {
  connectPromise = null;
  if (mongoose.connection.readyState === 0) {
    return;
  }

  try {
    await mongoose.disconnect();
  } catch (error) {
    logger.warn("db", "Error while disconnecting MongoDB", { error: error.message });
  }
}

function isConnected() {
  return mongoose.connection.readyState === 1;
}

function maskUri(uri) {
  return String(uri).replace(/\/\/([^@]+)@/, "//***@");
}

module.exports = {
  connectDb,
  disconnectDb,
  isConnected,
  mongoUri,
  mongoose,
};
