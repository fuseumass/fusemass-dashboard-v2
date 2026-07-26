"use strict";

var mongoose = require("mongoose");

/**
 * Connect to MongoDB using the connection string from the environment.
 *
 * Called once at startup, before the server begins listening. Kept as a plain
 * function that returns the Mongoose connection promise so the caller can decide
 * how to handle failure.
 *
 * @param {string} uri - MongoDB connection string (e.g. process.env.MONGODB_URI)
 * @returns {Promise<typeof mongoose>} Resolves with the connected mongoose instance.
 */
function connectDatabase(uri) {
  if (!uri) {
    throw new Error("MONGODB_URI is not set. Copy .env.example to .env.");
  }

  // Fail fast if the database is unreachable instead of buffering commands.
  mongoose.set("bufferCommands", false);

  return mongoose.connect(uri);
}

module.exports = connectDatabase;
