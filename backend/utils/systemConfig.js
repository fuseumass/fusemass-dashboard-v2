"use strict";

// Technical settings: every environment variable the backend reads, with how
// it is shown, validated and applied, and the storage of dashboard overrides.
//
// Precedence: dashboard value (SystemSetting collection) > .env value > the
// built-in default in the code that reads it. Overrides are loaded into
// process.env right after the database connects (see server.js), before
// anything that reads env at startup is set up. The original .env values are
// remembered so "reset" can put them back.
//
// Secrets are encrypted at rest with AES-256-GCM. The key is derived (HKDF)
// from CONFIG_ENCRYPTION_KEY when set, otherwise from JWT_SECRET. Values are
// never logged and never returned by the API.

var crypto = require("crypto");
var SystemSetting = require("../schemas/systemSetting");

var GROUPS = [
  "Server",
  "Sign-in",
  "Google",
  "Email",
  "Email outbox",
  "Discord",
  "File storage (Azure)",
  "Organization",
  "Rate limits",
  "Database and security",
];

var SET_ON_SERVER = "Set in the server's .env file or service settings.";

// ---- Validators ------------------------------------------------------------
// Each takes the trimmed string and returns an error message, or null.

/**
 * @param {number} max - Longest allowed value.
 * @returns {function(string): (string|null)}
 */
function text(max) {
  return function checkText(value) {
    if (value.length > max) {
      return "Use at most " + max + " characters.";
    }
    if (/[\u0000-\u001f\u007f]/.test(value)) {
      return "Remove line breaks and control characters.";
    }
    return null;
  };
}

/**
 * @param {boolean} httpsOnly - Require https.
 * @returns {function(string): (string|null)}
 */
function url(httpsOnly) {
  return function checkUrl(value) {
    if (value === "") {
      return null;
    }
    var parsed;
    try {
      parsed = new URL(value);
    } catch (_err) {
      return "Enter a full web address, like https://example.com.";
    }
    if (httpsOnly ? parsed.protocol !== "https:" : ["http:", "https:"].indexOf(parsed.protocol) === -1) {
      return httpsOnly ? "The address must start with https://." : "The address must start with http:// or https://.";
    }
    return null;
  };
}

/**
 * @param {number} min - Lowest allowed value.
 * @param {number} max - Highest allowed value.
 * @returns {function(string): (string|null)}
 */
function integer(min, max) {
  return function checkInteger(value) {
    if (!/^-?\d+$/.test(value) || Number(value) < min || Number(value) > max) {
      return "Enter a whole number from " + min + " to " + max + ".";
    }
    return null;
  };
}

/**
 * @param {string} value - Candidate.
 * @returns {string|null}
 */
function bool(value) {
  return value === "true" || value === "false" ? null : "Choose true or false.";
}

/**
 * @param {Array<string>} options - Allowed values.
 * @returns {function(string): (string|null)}
 */
function oneOf(options) {
  return function checkEnum(value) {
    return options.indexOf(value) === -1 ? "Choose one of: " + options.join(", ") + "." : null;
  };
}

/**
 * @param {string} value - Candidate.
 * @returns {string|null}
 */
function hexColor(value) {
  return value === "" || /^#[0-9a-fA-F]{6}$/.test(value) ? null : "Use a colour written as #RRGGBB.";
}

/**
 * "Name <a@b.com>" or a bare address.
 * @param {string} value - Candidate.
 * @returns {string|null}
 */
function mailFrom(value) {
  if (value === "") {
    return null;
  }
  var bare = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
  var named = /^[^<>]{1,100}<[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>$/;
  return bare.test(value) || named.test(value) ? null : "Use an address like no-reply@example.com or Name <no-reply@example.com>.";
}

/**
 * Comma-separated web addresses (CLIENT_ORIGIN).
 * @param {string} value - Candidate.
 * @returns {string|null}
 */
function originList(value) {
  var parts = value.split(",").map(function trim(p) {
    return p.trim();
  });
  if (!parts.length || parts.some(function empty(p) {
    return !p;
  })) {
    return "Enter at least one address, separated by commas.";
  }
  for (var i = 0; i < parts.length; i++) {
    var problem = url(false)(parts[i]);
    if (problem) {
      return problem;
    }
  }
  return null;
}

/**
 * Express "trust proxy": a hop count, or loopback / linklocal / uniquelocal.
 * @param {string} value - Candidate.
 * @returns {string|null}
 */
function trustProxy(value) {
  if (/^\d+$/.test(value) && Number(value) <= 32) {
    return null;
  }
  var names = ["loopback", "linklocal", "uniquelocal"];
  var ok = value.split(",").every(function known(p) {
    return names.indexOf(p.trim()) !== -1;
  });
  return ok ? null : "Use a number of proxies (like 1), or loopback, linklocal or uniquelocal.";
}

/**
 * @param {string} value - Candidate.
 * @returns {string|null}
 */
function timeZone(value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return null;
  } catch (_err) {
    return "Use a time zone name like America/New_York.";
  }
}

/**
 * @param {string} value - Candidate.
 * @returns {string|null}
 */
function azureConnectionString(value) {
  if (value.length > 2000 || !/=/.test(value) || !/;/.test(value) || /\s/.test(value)) {
    return "Paste the whole connection string from the Azure portal (no spaces).";
  }
  return null;
}

/**
 * @param {string} value - Candidate.
 * @returns {string|null}
 */
function containerName(value) {
  return /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62}$/.test(value)
    ? null
    : "Use 3 to 63 lowercase letters, numbers and single hyphens.";
}

/**
 * @param {string} value - Candidate.
 * @returns {string|null}
 */
function nonEmptyText(value) {
  return value === "" ? "This cannot be empty. Use reset to go back to the .env value." : text(200)(value);
}

// ---- Registry --------------------------------------------------------------

/**
 * @typedef {object} ConfigDef
 * @property {string} key - Env var name.
 * @property {string} label - Short name for the page.
 * @property {string} group - One of GROUPS.
 * @property {string} help - One plain sentence.
 * @property {boolean} secret - Value is never shown or returned.
 * @property {boolean} editable - Can be changed from the dashboard.
 * @property {boolean} restartRequired - Only read at startup.
 * @property {function} [validate] - (trimmedString, ctx) => error message or null.
 * @property {boolean} [allowEmpty] - An empty string is a valid override.
 * @property {string} [defaultValue] - Built-in default, for display.
 * @property {string} [type] - "text" | "url" | "number" | "boolean" | "enum"; a UI hint.
 * @property {Array<string>} [options] - For "enum"/"boolean".
 */

/**
 * @param {string} key - Env var name.
 * @param {string} label - Short name.
 * @param {string} group - Group.
 * @param {string} help - One sentence.
 * @param {object} [o] - Extra fields (secret, restartRequired, validate, ...).
 * @returns {ConfigDef}
 */
function def(key, label, group, help, o) {
  return Object.assign(
    { key: key, label: label, group: group, help: help, secret: false, editable: true, restartRequired: false, type: "text" },
    o || {}
  );
}

/**
 * A setting that can only be changed on the server.
 * @param {string} key - Env var name.
 * @param {string} label - Short name.
 * @param {string} help - Why it is read-only.
 * @param {object} [o] - Extra fields.
 * @returns {ConfigDef}
 */
function fixed(key, label, help, o) {
  return def(key, label, "Database and security", help + " " + SET_ON_SERVER, Object.assign({ editable: false, restartRequired: true }, o || {}));
}

var RATE_KEYS = [
  ["LOGIN", "Sign-in attempts"],
  ["REGISTER", "New accounts"],
  ["FORGOT_PASSWORD", "Password reset requests"],
  ["SETUP_ADMIN", "First admin setup"],
  ["RESEND_VERIFICATION", "Verification email resends"],
  ["PUBLIC_APPLY", "Applications without an account"],
  ["TEAM_INVITE", "Team invites"],
  ["UNSUBSCRIBE", "Unsubscribe links"],
];

var REGISTRY = [
  // Server
  def("CLIENT_ORIGIN", "Frontend address", "Server", "The dashboard website address (or several, separated by commas) that may call this server and that emailed links point to.", {
    validate: originList,
    defaultValue: "http://localhost:3000",
  }),
  def("API_PUBLIC_URL", "Public API address", "Server", "The public address of this server, used to build links to uploaded logos. Leave empty for relative links.", {
    validate: url(false),
    type: "url",
    allowEmpty: true,
  }),
  def("TRUST_PROXY", "Proxies in front of the server", "Server", "How many reverse proxies sit in front of the server, so rate limits see each visitor's real address.", {
    validate: trustProxy,
    restartRequired: true,
  }),
  def("SETTINGS_CACHE_TTL_MS", "Settings cache time (ms)", "Server", "How long each server keeps the organization settings in memory. 0 turns the cache off.", {
    validate: integer(0, 3600000),
    type: "number",
    defaultValue: "10000",
  }),
  def("EVENT_TIMEZONE", "Event time zone", "Server", "The time zone the schedule is written in for calendar invites and emails.", {
    validate: timeZone,
    defaultValue: "America/New_York",
  }),

  // Google
  def("GOOGLE_AUTH_ENABLED", "Google sign-in switch", "Google", "Set to false to turn Google sign-in off even when the credentials below are present.", {
    validate: bool,
    type: "boolean",
    defaultValue: "true",
  }),
  def("GOOGLE_CLIENT_ID", "Google client ID", "Google", "The OAuth client ID from the Google Cloud console.", {
    validate: text(300),
    restartRequired: true,
    allowEmpty: true,
  }),
  def("GOOGLE_CLIENT_SECRET", "Google client secret", "Google", "The OAuth client secret from the Google Cloud console.", {
    validate: text(300),
    secret: true,
    restartRequired: true,
  }),
  def("GOOGLE_CALLBACK_URL", "Google callback address", "Google", "Where Google sends people after sign-in. It must match the address registered with Google exactly.", {
    validate: url(false),
    type: "url",
    restartRequired: true,
    defaultValue: "http://localhost:4000/api/auth/google/callback",
  }),

  // Email
  def("SMTP_HOST", "SMTP host", "Email", "The mail server used to send email. Email is off while this or the user is empty.", {
    validate: text(255),
    allowEmpty: true,
  }),
  def("SMTP_PORT", "SMTP port", "Email", "The mail server port, usually 587, or 465 with a secure connection.", {
    validate: integer(1, 65535),
    type: "number",
    defaultValue: "587",
  }),
  def("SMTP_SECURE", "SMTP secure connection", "Email", "Use true for port 465. Use false for port 587, which upgrades the connection itself.", {
    validate: bool,
    type: "boolean",
    defaultValue: "false",
  }),
  def("SMTP_USER", "SMTP user", "Email", "The mail account name, often the full email address.", {
    validate: text(255),
    allowEmpty: true,
  }),
  def("SMTP_PASS", "SMTP password", "Email", "The mail account password or app password.", {
    validate: text(500),
    secret: true,
  }),
  def("MAIL_FROM", "Sender address", "Email", "The From line on outgoing email. Falls back to the SMTP user.", {
    validate: mailFrom,
    allowEmpty: true,
  }),

  // Email outbox
  def("EMAIL_DAILY_LIMIT", "Emails per day", "Email outbox", "How many emails the sending account allows per 24 hours. Bulk sends stop at this number. 0 turns the check off.", {
    validate: integer(0, 1000000),
    type: "number",
    defaultValue: "500",
  }),
  def("EMAIL_RETRY_INTERVAL_MS", "Retry interval (ms)", "Email outbox", "How often failed emails are retried.", {
    validate: integer(1000, 3600000),
    type: "number",
    restartRequired: true,
    defaultValue: "30000",
  }),
  def("EMAIL_LOG_RETENTION_DAYS", "Email log retention (days)", "Email outbox", "How long the email log is kept before it is deleted.", {
    validate: integer(1, 3650),
    type: "number",
    defaultValue: "90",
  }),

  // Discord
  def("DISCORD_ERROR_WEBHOOK_URL", "Error webhook", "Discord", "A Discord webhook that receives every server error, with personal details removed.", {
    validate: url(true),
    secret: true,
    type: "url",
  }),
  def("DISCORD_APPLICATIONS_WEBHOOK_URL", "Applications webhook", "Discord", "A Discord webhook that receives a post for every submitted application.", {
    validate: url(true),
    secret: true,
    type: "url",
  }),

  // File storage (Azure)
  def("AZURE_STORAGE_CONNECTION_STRING", "Storage connection string", "File storage (Azure)", "The Azure storage account connection string. Resume and logo uploads are off without it.", {
    validate: azureConnectionString,
    secret: true,
  }),
  def("AZURE_STORAGE_CONTAINER", "Resume container", "File storage (Azure)", "The private container that holds resumes. Changing it hides resumes saved in the old one.", {
    validate: containerName,
    defaultValue: "resumes",
  }),
  def("AZURE_STORAGE_BRANDING_CONTAINER", "Branding container", "File storage (Azure)", "The private container that holds uploaded logos and the favicon.", {
    validate: containerName,
    defaultValue: "branding",
  }),

  // Organization
  def("ORG_NAME", "Organization name", "Organization", "The hackathon name used in emails and as the default shown on the site.", {
    validate: text(80),
    defaultValue: "Hackathon",
    allowEmpty: true,
  }),
  def("ORG_WEBSITE_URL", "Website address", "Organization", "The main website, linked from emails.", { validate: url(false), type: "url", allowEmpty: true }),
  def("ORG_DISCORD_URL", "Discord invite", "Organization", "The Discord invite link, shown to attendees and in emails.", { validate: url(false), type: "url", allowEmpty: true }),
  def("ORG_DISCORD_MENTORSHIP_URL", "Mentorship link", "Organization", "The Discord mentorship channel or ticket link shown on the attendee home page.", {
    validate: url(false),
    type: "url",
    allowEmpty: true,
  }),
  def("BRAND_PRIMARY", "Primary colour", "Organization", "The default main colour, written as #RRGGBB. Branding set in Settings wins over this.", {
    validate: hexColor,
    allowEmpty: true,
  }),
  def("BRAND_SECONDARY", "Secondary colour", "Organization", "The default secondary colour, written as #RRGGBB.", { validate: hexColor, allowEmpty: true }),
  def("BRAND_ACCENT", "Accent colour", "Organization", "The default accent colour, written as #RRGGBB.", { validate: hexColor, allowEmpty: true }),
  def("BRAND_LOGO_URL", "Default logo", "Organization", "Address of the default logo image.", { validate: url(false), type: "url", allowEmpty: true }),
  def("BRAND_LOGO_DARK_URL", "Default dark logo", "Organization", "Address of the default logo for dark mode.", { validate: url(false), type: "url", allowEmpty: true }),
  def("BRAND_FAVICON_URL", "Default favicon", "Organization", "Address of the default favicon image.", { validate: url(false), type: "url", allowEmpty: true }),

  // Rate limits (all built when the server starts)
  def("AUTH_RATE_LIMIT_WINDOW_MS", "Window length (ms)", "Rate limits", "How long each rate limit window lasts. All limits below count requests per visitor address inside this window.", {
    validate: integer(1000, 86400000),
    type: "number",
    restartRequired: true,
    defaultValue: "900000",
  }),
  def("AUTH_RATE_LIMIT_MAX", "Default limit per window", "Rate limits", "How many requests one address may make per window to each limited endpoint, unless a specific limit below is set.", {
    validate: integer(1, 100000),
    type: "number",
    restartRequired: true,
    defaultValue: "20",
  }),
]
  .concat(
    RATE_KEYS.map(function rateDef(pair) {
      return def("AUTH_RATE_LIMIT_MAX_" + pair[0], pair[1] + " limit", "Rate limits", "Requests per window for " + pair[1].toLowerCase() + ". Empty uses the default limit.", {
        validate: integer(1, 100000),
        type: "number",
        restartRequired: true,
      });
    })
  )
  .concat([
    // Read-only
    fixed("MONGODB_URI", "Database connection", "Where the database is. This config is stored in that database, so it cannot be changed from here.", { secret: true }),
    fixed("PORT", "Server port", "The port the server listens on. Changing it live would cut off the dashboard.", { defaultValue: "4000" }),
    fixed("NODE_ENV", "Environment mode", "Whether the server runs in production mode. It changes behaviour across the whole server.", {}),
    fixed("JWT_SECRET", "Sign-in token secret", "Signs login tokens and protects these encrypted settings. A wrong value signs everyone out and locks admins out.", { secret: true }),
    fixed("JWT_EXPIRES_IN", "Sign-in token lifetime", "How long a login lasts. A bad value would stop everyone, admins included, from signing in.", { defaultValue: "7d" }),
    fixed("SETUP_ADMIN", "First admin setup", "Allows creating the first admin. It is a startup switch and should stay off once an admin exists.", {}),
    fixed("CONFIG_ENCRYPTION_KEY", "Settings encryption key", "Encrypts secret values saved here. If it changed, saved secrets could no longer be read.", { secret: true }),
    fixed("ALLOW_SELF_RESTART", "Allow restart from the dashboard", "Lets the Restart button stop the server so the service manager starts it again. Only set it when the server runs under one.", {}),
  ]);

var BY_KEY = {};
REGISTRY.forEach(function index(item) {
  BY_KEY[item.key] = item;
});

// The .env values as they were when the server started, so reset can restore
// them. A key missing here was unset.
var ORIGINAL = {};

/**
 * Remember each registered variable's value before any dashboard override is
 * applied. Safe to call repeatedly: a key already remembered is kept.
 * @returns {void}
 */
function captureOriginals() {
  REGISTRY.forEach(function remember(item) {
    if (!Object.prototype.hasOwnProperty.call(ORIGINAL, item.key)) {
      ORIGINAL[item.key] = process.env[item.key];
    }
  });
}
captureOriginals();

// ---- Encryption ------------------------------------------------------------

/**
 * @returns {Buffer} A 32 byte AES key derived from CONFIG_ENCRYPTION_KEY, or
 *   JWT_SECRET when that is not set.
 */
function deriveKey() {
  var material = process.env.CONFIG_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!material) {
    throw new Error("Neither CONFIG_ENCRYPTION_KEY nor JWT_SECRET is set, so secret settings cannot be stored.");
  }
  return Buffer.from(crypto.hkdfSync("sha256", material, "hackdash-system-config-salt", "hackdash-system-config-v1", 32));
}

/**
 * Encrypt a secret with AES-256-GCM, bound to its key name.
 * @param {string} key - Env var name (authenticated, not secret).
 * @param {string} plain - The secret.
 * @returns {string} "v1:<iv>:<tag>:<ciphertext>", each base64.
 */
function encrypt(key, plain) {
  var iv = crypto.randomBytes(12);
  var cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(), iv);
  cipher.setAAD(Buffer.from(key));
  var data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

/**
 * @param {string} key - Env var name it was encrypted for.
 * @param {string} stored - Output of encrypt().
 * @returns {string} The secret.
 * @throws {Error} When the data was altered or the key changed.
 */
function decrypt(key, stored) {
  var parts = String(stored).split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Unrecognised encrypted value.");
  }
  var decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(), Buffer.from(parts[1], "base64"));
  decipher.setAAD(Buffer.from(key));
  decipher.setAuthTag(Buffer.from(parts[2], "base64"));
  return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64")), decipher.final()]).toString("utf8");
}

// ---- Validation ------------------------------------------------------------

/**
 * Check one proposed value.
 * @param {ConfigDef} item - The registry entry.
 * @param {*} raw - Proposed value from the request.
 * @param {object} [ctx] - { requestOrigin } for lock-out checks.
 * @returns {{value: string}|{error: string}}
 */
function validateValue(item, raw, ctx) {
  if (typeof raw === "number" || typeof raw === "boolean") {
    raw = String(raw);
  }
  if (typeof raw !== "string") {
    return { error: "Send the value as text, or null to reset it." };
  }
  var value = raw.trim();
  if (value === "") {
    if (!item.allowEmpty) {
      return { error: "Enter a value, or reset to use the .env value." };
    }
    return { value: "" };
  }
  var problem = item.validate ? item.validate(value) : nonEmptyText(value);
  if (problem) {
    return { error: problem };
  }
  if (item.key === "CLIENT_ORIGIN" && ctx && ctx.requestOrigin) {
    var listed = value.split(",").map(function clean(o) {
      return o.trim().replace(/\/+$/, "");
    });
    if (listed.indexOf(String(ctx.requestOrigin).replace(/\/+$/, "")) === -1) {
      return { error: "This list must include " + ctx.requestOrigin + ", the address you are using now, or you would be locked out." };
    }
  }
  return { value: value };
}

// ---- Applying and loading --------------------------------------------------

/**
 * Put a value into process.env, or remove it (undefined).
 * @param {string} key - Env var name.
 * @param {string|undefined} value - New value.
 * @returns {void}
 */
function setEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

/**
 * Load every saved dashboard override into process.env. Call right after the
 * database connects and before anything reads env at startup. A value that
 * cannot be decrypted is skipped (the .env value stays), with a warning that
 * names only the key.
 * @returns {Promise<number>} How many overrides were applied.
 */
function loadOverrides() {
  captureOriginals();
  return SystemSetting.find({})
    .lean()
    .then(function apply(docs) {
      var applied = 0;
      docs.forEach(function each(doc) {
        var item = BY_KEY[doc.key];
        if (!item || !item.editable) {
          return;
        }
        try {
          setEnv(doc.key, doc.encrypted ? decrypt(doc.key, doc.value) : doc.value);
          applied += 1;
        } catch (_err) {
          console.warn("Technical settings: could not read the saved value for " + doc.key + "; using the .env value.");
        }
      });
      return applied;
    });
}

/**
 * Where the effective value of a key comes from.
 * @param {ConfigDef} item - Registry entry.
 * @param {object} overrides - Map of key to true for keys with a saved override.
 * @returns {string} "dashboard" | "env" | "default" | "unset"
 */
function sourceOf(item, overrides) {
  if (overrides[item.key]) {
    return "dashboard";
  }
  var original = ORIGINAL[item.key];
  if (original !== undefined && original !== "") {
    return "env";
  }
  return item.defaultValue !== undefined ? "default" : "unset";
}

/**
 * The page model: every setting with its source, never with secret values.
 * @returns {Promise<{groups: Array<string>, settings: Array<object>, selfRestart: boolean}>}
 */
function describeAll() {
  return SystemSetting.find({})
    .select("key")
    .lean()
    .then(function build(docs) {
      var overrides = {};
      docs.forEach(function mark(doc) {
        overrides[doc.key] = true;
      });
      var settings = REGISTRY.map(function describe(item) {
        var current = process.env[item.key];
        var isSet = current !== undefined && current !== "";
        var out = {
          key: item.key,
          label: item.label,
          group: item.group,
          help: item.help,
          secret: item.secret,
          editable: item.editable,
          restartRequired: item.restartRequired,
          type: item.type,
          allowEmpty: Boolean(item.allowEmpty),
          source: item.editable ? sourceOf(item, overrides) : isSet ? "env" : item.defaultValue !== undefined ? "default" : "unset",
          isSet: isSet,
        };
        if (item.secret) {
          if (item.editable && isSet && current.length >= 12) {
            out.hint = current.slice(-4);
          }
        } else {
          out.value = isSet ? current : item.defaultValue !== undefined ? item.defaultValue : "";
        }
        return out;
      });
      return { groups: GROUPS.slice(), settings: settings, selfRestart: selfRestartAllowed() };
    });
}

/**
 * Validate and save a batch of changes. Nothing is saved unless all are valid.
 * @param {object} values - { KEY: "value" | null }.
 * @param {string|null} userId - The admin making the change.
 * @param {object} [ctx] - { requestOrigin }.
 * @returns {Promise<{errors: object}|{changed: Array<string>, restartRequired: Array<string>}>}
 */
function applyChanges(values, userId, ctx) {
  var errors = {};
  var plan = [];
  Object.keys(values).forEach(function check(key) {
    var item = BY_KEY[key];
    if (!item) {
      errors[key] = "This is not a known setting.";
      return;
    }
    if (!item.editable) {
      errors[key] = "This setting cannot be changed from the dashboard.";
      return;
    }
    if (values[key] === null) {
      plan.push({ item: item, reset: true });
      return;
    }
    var result = validateValue(item, values[key], ctx);
    if (result.error) {
      errors[key] = result.error;
    } else {
      plan.push({ item: item, value: result.value });
    }
  });
  if (Object.keys(errors).length) {
    return Promise.resolve({ errors: errors });
  }

  var changed = [];
  var chain = Promise.resolve();
  plan.forEach(function step(entry) {
    chain = chain.then(function run() {
      var key = entry.item.key;
      if (entry.reset) {
        return SystemSetting.deleteOne({ key: key }).then(function afterDelete(res) {
          if (res.deletedCount) {
            setEnv(key, ORIGINAL[key]);
            changed.push(key);
          }
        });
      }
      return SystemSetting.findOne({ key: key })
        .lean()
        .then(function compare(existing) {
          if (existing && process.env[key] === entry.value) {
            return undefined;
          }
          if (!existing && process.env[key] === entry.value) {
            // Same as the .env value: nothing to override.
            return undefined;
          }
          var stored = entry.item.secret ? encrypt(key, entry.value) : entry.value;
          return SystemSetting.updateOne(
            { key: key },
            { $set: { value: stored, encrypted: entry.item.secret, updatedBy: userId || undefined, updatedAt: new Date() } },
            { upsert: true }
          ).then(function afterSave() {
            setEnv(key, entry.value);
            changed.push(key);
          });
        });
    });
  });

  return chain.then(function done() {
    if (changed.length) {
      // Keys only, never values.
      console.log("Technical settings changed by " + (userId || "unknown") + ": " + changed.join(", "));
    }
    return {
      changed: changed,
      restartRequired: changed.filter(function needs(key) {
        return BY_KEY[key].restartRequired;
      }),
    };
  });
}

// ---- Restart ---------------------------------------------------------------

var restartHooks = {
  exit: function realExit(code) {
    process.exit(code);
  },
  delayMs: 500,
  forceAfterMs: 5000,
};
var httpServer = null;

/**
 * @returns {boolean} Whether the Restart button may stop the server.
 */
function selfRestartAllowed() {
  return String(process.env.ALLOW_SELF_RESTART) === "true";
}

/**
 * Tell this module which HTTP server to close before restarting.
 * @param {object} server - The Node http.Server from app.listen.
 * @returns {void}
 */
function registerServer(server) {
  httpServer = server;
}

/**
 * Override how the process exits (tests).
 * @param {object} hooks - Any of { exit, delayMs, forceAfterMs }.
 * @returns {void}
 */
function setRestartHooks(hooks) {
  Object.assign(restartHooks, hooks);
}

/**
 * Schedule a clean stop: close the HTTP server, then exit with code 0 so the
 * service manager (systemd Restart=always) starts the process again.
 * @returns {void}
 */
function scheduleRestart() {
  var exited = false;
  function finish() {
    if (!exited) {
      exited = true;
      restartHooks.exit(0);
    }
  }
  setTimeout(function stop() {
    if (httpServer) {
      httpServer.close(finish);
      if (httpServer.closeIdleConnections) {
        httpServer.closeIdleConnections();
      }
    } else {
      finish();
    }
    setTimeout(finish, restartHooks.forceAfterMs);
  }, restartHooks.delayMs);
}

module.exports = {
  GROUPS: GROUPS,
  REGISTRY: REGISTRY,
  getDef: function getDef(key) {
    return BY_KEY[key] || null;
  },
  encrypt: encrypt,
  decrypt: decrypt,
  validateValue: validateValue,
  loadOverrides: loadOverrides,
  describeAll: describeAll,
  applyChanges: applyChanges,
  selfRestartAllowed: selfRestartAllowed,
  registerServer: registerServer,
  setRestartHooks: setRestartHooks,
  scheduleRestart: scheduleRestart,
};
