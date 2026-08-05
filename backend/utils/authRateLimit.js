"use strict";

var rateLimit = require("express-rate-limit");

/**
 * Rate limiter for auth endpoints prone to brute force (login, register,
 * forgot-password, setup-admin). Keyed by IP (express-rate-limit's default).
 * Window/max are env-overridable so tests can tighten them without waiting
 * out a real window.
 */
var authRateLimit = rateLimit({
  windowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again later." },
});

module.exports = authRateLimit;
