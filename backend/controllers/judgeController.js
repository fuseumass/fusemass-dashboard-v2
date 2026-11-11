"use strict";

var crypto = require("crypto");
var mongoose = require("mongoose");
var parse = require("csv-parse/sync").parse;
var isEmail = require("validator/lib/isEmail");
var User = require("../schemas/user");
var JudgeProfile = require("../schemas/judgeProfile");
var passwordToken = require("../utils/passwordToken");
var primaryClientOrigin = require("../utils/clientOrigin").primaryClientOrigin;
var mailer = require("../utils/mailer");
var signToken = require("../utils/signToken");

function validate(row) {
  if (!row || typeof row.name !== "string" || !row.name.trim())
    return "Enter a name.";
  if (typeof row.email !== "string" || !isEmail(row.email.trim()))
    return "Enter a valid email.";
  if (typeof row.hardware !== "boolean")
    return "Hardware must be true or false.";
  return null;
}

function parseCsv(csv) {
  if (typeof csv !== "string" || csv.length > 100000)
    throw new Error("Upload a CSV smaller than 100 KB.");
  var records = parse(csv, { bom: true, skip_empty_lines: true, trim: true });
  if (!records.length || records.shift().join(",") !== "name,email,hardware")
    throw new Error("Use the CSV header name,email,hardware.");
  if (!records.length || records.length > 500)
    throw new Error("Include between 1 and 500 judges.");
  var seen = {};
  return records.map(function toRow(record, index) {
    var row = {
      name: record[0],
      email: String(record[1] || "").toLowerCase(),
      hardware: record[2] === "true",
    };
    var error = validate(row);
    if (record.length !== 3 || ["true", "false"].indexOf(record[2]) === -1)
      error = "Use three columns and true or false for hardware.";
    if (seen[row.email]) error = "Duplicate email in CSV.";
    seen[row.email] = true;
    return Object.assign({ row: index + 2, error: error }, row);
  });
}

async function sendInvite(user, requestedBy) {
  user.judgeInvitePending = true;
  var raw = await passwordToken.issuePasswordToken(
    user,
    passwordToken.SETUP_TTL_MS,
  );
  await mailer.sendTemplateEmail(
    user.email,
    "judge_invite",
    {
      name: user.name,
      inviteUrl: primaryClientOrigin() + "/judge/accept?token=" + raw,
    },
    { retry: false, userId: user._id, requestedBy: requestedBy },
  );
}

async function inviteOne(row, requestedBy) {
  var email = row.email.trim().toLowerCase();
  var user = await User.findOne({ email: email });
  // Inviting must not silently demote an organizer or administrator.
  if (user && ["admin", "moderator"].indexOf(user.role) !== -1)
    throw new Error(
      "Change this staff account's role on the Users page first.",
    );
  if (!user) user = new User({ name: row.name.trim(), email: email });
  user.role = "judge";
  await user.save();
  await JudgeProfile.findOneAndUpdate(
    { user: user._id },
    { $set: { hardware: row.hardware, active: true } },
    { upsert: true, new: true },
  );
  await sendInvite(user, requestedBy);
  return user;
}

/**
 * @param {object} req - Request.
 * @param {object} res - Response.
 * @param {function} next - Error callback.
 * @returns {Promise<void>}
 */
async function invite(req, res, next) {
  var error = validate(req.body);
  if (error) {
    res.status(400).json({ error: error });
    return;
  }
  try {
    var existing = await User.findOne({
      email: req.body.email.trim().toLowerCase(),
      role: { $in: ["admin", "moderator"] },
    });
    if (existing) {
      res
        .status(409)
        .json({
          error: "Change this staff account's role on the Users page first.",
        });
      return;
    }
    var user = await inviteOne(req.body, req.user.id);
    res.status(201).json({ user: user.toJSON() });
  } catch (err) {
    next(err);
  }
}

/**
 * @param {object} req - Request.
 * @param {object} res - Response.
 * @param {function} next - Error callback.
 * @returns {Promise<void>}
 */
async function list(req, res, next) {
  try {
    var users = await User.find({ role: "judge" }).sort({ name: 1 });
    var profiles = await JudgeProfile.find({
      user: {
        $in: users.map(function id(user) {
          return user._id;
        }),
      },
    }).lean();
    res.json({
      judges: users.map(function serialize(user) {
        var profile = profiles.find(function match(p) {
          return String(p.user) === String(user._id);
        });
        return serializeJudge(user, profile);
      }),
    });
  } catch (err) {
    next(err);
  }
}

// One judge as the Judges page lists them.
function serializeJudge(user, profile) {
  return Object.assign(user.toJSON(), {
    hardware: Boolean(profile && profile.hardware),
    calibrationDone: Boolean(profile && profile.calibrationDone),
    inviteStatus: !user.judgeInvitePending
      ? "accepted"
      : user.resetPasswordExpires > new Date()
        ? "pending"
        : "expired",
  });
}

var EDITABLE_JUDGE_KEYS = ["name", "email", "hardware"];

// Check a PATCH body; returns { error } or { changes }.
function cleanJudgeEdit(body) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return { error: "Send { name, email, hardware }." };
  var unknown = Object.keys(body).filter(function notEditable(key) {
    return EDITABLE_JUDGE_KEYS.indexOf(key) === -1;
  });
  if (unknown.length)
    return {
      error: "Only name, email and hardware can be changed here.",
    };
  var changes = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim())
      return { error: "Enter a name.", field: "name" };
    if (body.name.trim().length > 200)
      return { error: "Use a name of 200 characters or fewer.", field: "name" };
    changes.name = body.name.trim();
  }
  if (body.email !== undefined) {
    var email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!isEmail(email)) return { error: "Enter a valid email.", field: "email" };
    changes.email = email;
  }
  if (body.hardware !== undefined) {
    if (typeof body.hardware !== "boolean")
      return { error: "Hardware must be true or false.", field: "hardware" };
    changes.hardware = body.hardware;
  }
  return { changes: changes };
}

var JUDGE_EMAIL_TAKEN = {
  error: "Another account already uses this email.",
  field: "email",
};

/**
 * PATCH /api/admin/judges/:id
 * Change a judge's name, email or hardware flag. Body: { name?, email?,
 * hardware? }. A new email drops the pending invite link sent to the old
 * address (the admin resends it from the list when ready). Changing hardware
 * while an assignment version is active returns a `warning`: queues only
 * pick it up when assignments are regenerated.
 * @param {object} req - Request.
 * @param {object} res - Response.
 * @param {function} next - Error callback.
 * @returns {Promise<void>}
 */
async function update(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400).json({ error: "Invalid judge id." });
    return;
  }
  var cleaned = cleanJudgeEdit(req.body);
  if (cleaned.error) {
    res.status(400).json({ error: cleaned.error, field: cleaned.field });
    return;
  }
  var changes = cleaned.changes;
  try {
    var user = await User.findOne({ _id: req.params.id, role: "judge" });
    if (!user) {
      res.status(404).json({ error: "Judge not found." });
      return;
    }
    var emailChanged = changes.email !== undefined && changes.email !== user.email;
    if (emailChanged) {
      var taken = await User.exists({
        email: changes.email,
        _id: { $ne: user._id },
      });
      if (taken) {
        res.status(409).json(JUDGE_EMAIL_TAKEN);
        return;
      }
      user.email = changes.email;
      // Links mailed to the old (wrong) address must not work any more.
      user.resetPasswordToken = undefined;
      user.resetPasswordExpires = undefined;
      user.emailVerificationToken = undefined;
      user.emailVerificationExpires = undefined;
      user.emailVerificationSentAt = undefined;
    }
    if (changes.name !== undefined) user.name = changes.name;
    if (user.isModified()) await user.save();

    var profile = await JudgeProfile.findOne({ user: user._id });
    var warning = null;
    if (
      changes.hardware !== undefined &&
      Boolean(profile && profile.hardware) !== changes.hardware
    ) {
      profile = await JudgeProfile.findOneAndUpdate(
        { user: user._id },
        { $set: { hardware: changes.hardware } },
        { upsert: true, new: true },
      );
      var state = await require("../schemas/judgingState")
        .findById("judging")
        .lean();
      if (state && state.activeVersion)
        warning = "Regenerate assignments for this to affect queues.";
    }
    res.json({
      judge: serializeJudge(user, profile),
      emailChanged: emailChanged,
      inviteNeedsResend: emailChanged && Boolean(user.judgeInvitePending),
      warning: warning,
    });
  } catch (err) {
    if (err && err.code === 11000) {
      res.status(409).json(JUDGE_EMAIL_TAKEN);
      return;
    }
    next(err);
  }
}

/**
 * @param {object} req - Request.
 * @param {object} res - Response.
 * @returns {void}
 */
function preview(req, res) {
  try {
    res.json({ rows: parseCsv(req.body.csv) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

/**
 * @param {object} req - Request.
 * @param {object} res - Response.
 * @param {function} next - Error callback.
 * @returns {Promise<void>}
 */
async function bulk(req, res, next) {
  var rows;
  try {
    rows = parseCsv(req.body.csv);
  } catch (err) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (
    req.body.confirm !== true ||
    rows.some(function invalid(row) {
      return row.error;
    })
  ) {
    res
      .status(400)
      .json({
        error: "Preview a valid CSV and confirm sending invites.",
        rows: rows,
      });
    return;
  }
  try {
    var staff = await User.exists({
      email: {
        $in: rows.map(function email(row) {
          return row.email;
        }),
      },
      role: { $in: ["admin", "moderator"] },
    });
    if (staff) {
      res
        .status(409)
        .json({
          error:
            "CSV contains staff accounts. Change their roles on the Users page first.",
        });
      return;
    }
    var results = [];
    for (var row of rows) {
      try {
        await inviteOne(row, req.user.id);
        results.push({ email: row.email, sent: true });
      } catch (_err) {
        results.push({
          email: row.email,
          sent: false,
          error: "Invite failed. Resend from the judges list.",
        });
      }
    }
    res.json({ results: results });
  } catch (err) {
    next(err);
  }
}

/**
 * @param {object} req - Request.
 * @param {object} res - Response.
 * @param {function} next - Error callback.
 * @returns {Promise<void>}
 */
async function resend(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400).json({ error: "Invalid judge id." });
    return;
  }
  try {
    var user = await User.findOne({ _id: req.params.id, role: "judge" });
    if (!user) {
      res.status(404).json({ error: "Judge not found." });
      return;
    }
    await sendInvite(user, req.user.id);
    res.json({ sent: true });
  } catch (err) {
    next(err);
  }
}

/**
 * @param {object} req - Request.
 * @param {object} res - Response.
 * @param {function} next - Error callback.
 * @returns {Promise<void>}
 */
async function remove(req, res, next) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400).json({ error: "Invalid judge id." });
    return;
  }
  try {
    var user = await User.findOneAndUpdate(
      { _id: req.params.id, role: "judge" },
      {
        $set: { role: "applicant", judgeInvitePending: false },
        $unset: { resetPasswordToken: "", resetPasswordExpires: "" },
      },
      { new: true },
    );
    if (!user) {
      res.status(404).json({ error: "Judge not found." });
      return;
    }
    await JudgeProfile.updateOne(
      { user: user._id },
      { $set: { active: false } },
    );
    await require("../utils/judging/state").removeJudge(user._id);
    res.json({ user: user.toJSON() });
  } catch (err) {
    next(err);
  }
}

/**
 * @param {object} req - Request.
 * @param {object} res - Response.
 * @param {function} next - Error callback.
 * @returns {Promise<void>}
 */
async function accept(req, res, next) {
  var body = req.body || {};
  if (
    typeof body.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(body.token) ||
    typeof body.password !== "string" ||
    body.password.length < 8
  ) {
    res
      .status(400)
      .json({
        error:
          "Use a valid invite link and a password of at least 8 characters. Ask an organizer to resend your invite.",
      });
    return;
  }
  try {
    var hash = await User.hashPassword(body.password);
    // Atomic consumption prevents two concurrent requests using one credential.
    var user = await User.findOneAndUpdate(
      {
        role: "judge",
        judgeInvitePending: true,
        resetPasswordToken: crypto
          .createHash("sha256")
          .update(body.token)
          .digest("hex"),
        resetPasswordExpires: { $gt: new Date() },
      },
      {
        $set: {
          passwordHash: hash,
          emailVerified: true,
          judgeInvitePending: false,
        },
        $unset: {
          resetPasswordToken: "",
          resetPasswordExpires: "",
          emailVerificationToken: "",
          emailVerificationExpires: "",
        },
      },
      { new: true },
    );
    if (!user) {
      res
        .status(400)
        .json({
          error:
            "This invite link has expired or has already been used. Ask an organizer to resend your invite.",
        });
      return;
    }
    res.json({
      token: signToken({
        id: String(user._id),
        email: user.email,
        role: user.role,
      }),
      user: user.toJSON(),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * @param {object} req - Request.
 * @param {object} res - Response.
 * @returns {void}
 */
function status(req, res) {
  res.json({ message: "Judging opens when organizers start it." });
}

module.exports = {
  invite: invite,
  list: list,
  preview: preview,
  bulk: bulk,
  resend: resend,
  remove: remove,
  update: update,
  accept: accept,
  status: status,
};
