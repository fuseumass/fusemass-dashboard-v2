"use strict";

require("dotenv").config();

var express = require("express");
var cors = require("cors");
var cookieParser = require("cookie-parser");

var connectDatabase = require("./config/db");
var parseToken = require("./utils/parseToken");
var passportUtil = require("./utils/passport");
var EmailTemplate = require("./schemas/emailTemplate");
var discord = require("./utils/discord");
var outbox = require("./utils/outbox");
var autoAccept = require("./utils/autoAccept");
var clientOrigin = require("./utils/clientOrigin");
var healthController = require("./controllers/healthController");

var authRoutes = require("./routes/auth");
var applicationRoutes = require("./routes/applications");
var adminRoutes = require("./routes/admin");
var metaRoutes = require("./routes/meta");
const staffRoutes = require("./routes/staff");
var teamRoutes = require("./routes/teams");
var publicRoutes = require("./routes/public");

var app = express();

// --- Proxy awareness --------------------------------------------------------
// Behind a reverse proxy (any hosted deployment), req.ip is the proxy's own
// address, so every visitor lands in the same rate-limit bucket and one
// attendee can lock out the whole site. Setting this makes Express read the
// client address from X-Forwarded-For instead.
//
// Off by default, and deliberately not hardcoded to `true`: trusting that
// header when nothing trustworthy sets it lets a client forge its own IP and
// bypass the limiter entirely, which is worse than the bug it fixes. Set
// TRUST_PROXY to the number of proxy hops in front of the app (usually 1), or
// to a value Express accepts such as "loopback".
if (process.env.TRUST_PROXY) {
  var hops = Number(process.env.TRUST_PROXY);
  app.set("trust proxy", Number.isNaN(hops) ? process.env.TRUST_PROXY : hops);
}

// --- Public feeds -----------------------------------------------------------
// Read-only data for the hackathon's own website (e.g. the schedule). Mounted
// before the credentialed CORS below so any site may read it: it carries no
// cookies or tokens, and the routes only ever expose what an admin published.
app.use(
  "/api/public",
  cors({ origin: "*", methods: ["GET", "HEAD", "OPTIONS"], maxAge: 86400 }),
  publicRoutes
);

// --- Core middleware --------------------------------------------------------
app.use(
  cors({
    // CLIENT_ORIGIN may list several frontend addresses, comma-separated.
    origin: clientOrigin.corsOrigin,
    credentials: true,
    // The dashboard names exported files from this header, and browsers hide
    // it from cross-origin pages unless it is listed here.
    exposedHeaders: ["Content-Disposition"],
  })
);
app.use(express.json());
app.use(cookieParser());

// --- Passport (Google OAuth, stateless — we sign our own JWT) ----------------
passportUtil.configurePassport();
app.use(passportUtil.passport.initialize());

// --- Global JWT parsing -----------------------------------------------------
// Mounted at the very top of the middleware stack: every incoming request is
// checked for a JWT, which is handed to jwt.verify to decode. The decoded
// payload is placed on `req.user` (or null when there is no valid token) so
// that downstream routes and the isAuthenticated / isAdmin guards can read it.
app.use(parseToken);

// --- Routes -----------------------------------------------------------------
app.get("/api/health", function health(_req, res) {
  res.status(200).json({ ok: true });
});
// Readiness: also pings the database (503 when it's unreachable).
app.get("/api/health/db", healthController.databaseHealth);

app.use("/api/auth", authRoutes);
app.use("/api/applications", applicationRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/meta", metaRoutes);
app.use("/api/staff", staffRoutes);
app.use("/api/teams", teamRoutes);

// --- Fallback error handler (Express 4 signature: err, req, res, next) ------
app.use(function errorHandler(err, req, res, _next) {
  // req.path leaves out the query string, which can carry tokens.
  console.error("Unhandled error in " + req.method + " " + req.path + ":", err);
  res.status(500).json({ error: "Internal server error." });
});

// --- Startup ----------------------------------------------------------------
// Guarded so requiring this module (e.g. from tests, which manage their own
// disposable database connection and never want a real port bound) doesn't
// also connect to MongoDB and start listening. Only runs for `node server.js`.
if (require.main === module) {
  // Every console.error, unhandled rejection and crash also goes to the
  // DISCORD_ERROR_WEBHOOK_URL channel when that env var is set.
  discord.installErrorReporting();

  var PORT = process.env.PORT || 4000;
  var MONGODB_URI = process.env.MONGODB_URI || "";

  connectDatabase(MONGODB_URI)
    .then(function afterConnect() {
      console.log("Connected to MongoDB.");
      return EmailTemplate.seedDefaults().then(function afterSeed() {
        console.log("Email templates seeded.");
      });
    })
    .then(function afterSeed() {
      app.listen(PORT, function onListen() {
        console.log("HackUMass backend listening on port " + PORT + ".");
        // Retries emails that failed to send (see utils/outbox). Started only
        // here, so requiring this module in tests never starts a timer.
        outbox.startWorker();
        // Domain auto-accept, when an admin switched it on in Settings.
        autoAccept.startWorker();
      });
    })
    .catch(function onError(err) {
      console.error("Failed to start server:", err);
      // Give the error webhook a moment to send before exiting.
      setTimeout(function exit() {
        process.exit(1);
      }, 3000);
    });
}

module.exports = app;
