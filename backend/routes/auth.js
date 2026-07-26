"use strict";

var express = require("express");
var authController = require("../controllers/authController");
var isAuthenticated = require("../utils/isAuthenticated");

var router = express.Router();

// Public: create an account / log in.
router.post("/register", authController.register);
router.post("/login", authController.login);

// Requires a valid token.
router.get("/me", isAuthenticated, authController.me);

module.exports = router;
