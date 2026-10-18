"use strict";

const express = require("express");
const router = express.Router();

const qrScanController = require("../controllers/qrScanController");

const isAuthenticated = require("../utils/isAuthenticated");
const isModerator = require("../utils/isModerator");

// Only authenticated admins or moderators may use the QR scanner to check in a participant.

const {
  isAuthenticated,
  isAdmin,
} = require("../utils/auth");

router.post(
  "/scan",
  isAuthenticated,
  isAdmin,
  scanCheckIn
);

module.exports = router;