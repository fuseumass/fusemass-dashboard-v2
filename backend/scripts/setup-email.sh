#!/usr/bin/env bash
# Set up the backend's outgoing email (password resets, application, decision
# and check-in emails) with a Gmail account and an app password. See the
# "Setting up email" section of backend/README.md.
#
#   npm run setup-email          (from backend/)
#
# Optional environment variables:
#   ENV_FILE=/path/to/.env       edit this file instead of backend/.env
#   SMTP_HOST=... SMTP_PORT=...  another provider's SMTP server (default: Gmail, 587)
#   RESTART_CMD="..."            run this afterwards to restart the backend
#
# The password is read without echoing it, so it never lands in shell history.
# The login (and the optional test email) is checked before anything is
# written, so a typo can't break email that already works.
set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$BACKEND_DIR/.env}"
SMTP_HOST="${SMTP_HOST:-smtp.gmail.com}"
SMTP_PORT="${SMTP_PORT:-587}"

if [ ! -f "$ENV_FILE" ]; then
  echo "No $ENV_FILE yet. Copy .env.example to .env and fill in the basics first." >&2
  exit 1
fi
if [ ! -d "$BACKEND_DIR/node_modules/nodemailer" ]; then
  echo "Run npm install in $BACKEND_DIR first." >&2
  exit 1
fi

# Current value of a key in the .env file (surrounding quotes removed), used
# as the default answer so re-running the script only asks for what changes.
current() {
  grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true
}

# ask VAR "Question" "default": prompt, falling back to the default on Enter.
ask() {
  local answer
  if [ -n "$3" ]; then
    read -r -p "$2 [$3]: " answer
  else
    read -r -p "$2: " answer
  fi
  printf -v "$1" '%s' "${answer:-$3}"
}

ask SMTP_USER "Gmail address to send from" "$(current SMTP_USER)"
case "$SMTP_USER" in
  *@*.*) ;;
  *)
    echo "\"$SMTP_USER\" doesn't look like an email address; nothing changed." >&2
    exit 1
    ;;
esac
ask FROM_NAME "Sender name recipients see" "$(current ORG_NAME)"

read -r -s -p "App password for $SMTP_USER (hidden): " SMTP_PASS
echo
SMTP_PASS="${SMTP_PASS// /}" # Google shows it in groups of four; the spaces aren't part of it.
if [ -z "$SMTP_PASS" ]; then
  echo "No password entered; nothing changed." >&2
  exit 1
fi

ask TEST_TO "Send a test email to (blank to skip)" ""

if [ -n "$FROM_NAME" ]; then
  MAIL_FROM="$FROM_NAME <$SMTP_USER>"
else
  MAIL_FROM="$SMTP_USER"
fi

export ENV_FILE SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS MAIL_FROM TEST_TO
cd "$BACKEND_DIR"

node - <<'EOF'
"use strict";

var fs = require("fs");
var nodemailer = require("nodemailer");

var env = process.env;
var secure = Number(env.SMTP_PORT) === 465;
var transport = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: Number(env.SMTP_PORT),
  secure: secure,
  auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
});

function sendTest() {
  if (!env.TEST_TO) {
    return Promise.resolve();
  }
  return transport
    .sendMail({
      from: env.MAIL_FROM,
      to: env.TEST_TO,
      subject: "Test email from your hackathon dashboard",
      text: "Email sending works. Dashboard emails will come from " + env.MAIL_FROM + ".",
    })
    .then(function afterSend() {
      console.log("Test email sent to " + env.TEST_TO + ".");
    });
}

// Replace each key's line in place (or append it), leaving the rest of the
// file, its comments and its permissions untouched.
function saveEnv() {
  var values = {
    SMTP_HOST: env.SMTP_HOST,
    SMTP_PORT: env.SMTP_PORT,
    SMTP_SECURE: String(secure),
    SMTP_USER: env.SMTP_USER,
    SMTP_PASS: env.SMTP_PASS,
    MAIL_FROM: '"' + env.MAIL_FROM.replace(/"/g, "") + '"',
  };
  var seen = {};
  var lines = fs.readFileSync(env.ENV_FILE, "utf8").split("\n").map(function (line) {
    var key = line.split("=")[0];
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      seen[key] = true;
      return key + "=" + values[key];
    }
    return line;
  });
  Object.keys(values).forEach(function (key) {
    if (!seen[key]) {
      lines.push(key + "=" + values[key]);
    }
  });
  fs.writeFileSync(env.ENV_FILE, lines.join("\n"));
  console.log("Saved email settings to " + env.ENV_FILE + ".");
}

transport
  .verify()
  .then(function afterLogin() {
    console.log("Logged in to " + env.SMTP_HOST + " as " + env.SMTP_USER + ".");
  })
  .then(sendTest)
  .then(saveEnv)
  .catch(function onError(err) {
    console.error("Email setup failed; nothing was saved. " + err.message);
    if (err.code === "EAUTH") {
      console.error("Check the address, and that you pasted an app password (not the account's normal password).");
    }
    process.exit(1);
  });
EOF

if [ -n "${RESTART_CMD:-}" ]; then
  echo "Restarting the backend: $RESTART_CMD"
  sh -c "$RESTART_CMD"
else
  echo "Restart the backend so it picks up the new settings."
fi
