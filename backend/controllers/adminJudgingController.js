"use strict";
var mongoose = require("mongoose");
var parse = require("csv-parse/sync").parse;
var Room = require("../schemas/judgingRoom");
var Project = require("../schemas/project");
var JudgingTable = require("../schemas/judgingTable");
var ProjectImport = require("../schemas/projectImport");
var Team = require("../schemas/team");
var User = require("../schemas/user");
var normalizeUrl = require("./teamController").normalizeDevpostUrl;
var overrideFields = ["category", "hardware", "needsPower", "withdrawn", "team"];

function fail(res, err) {
  var bad = err.name === "ValidationError" || err.name === "CastError";
  res.status(err.status || (err.code === 11000 ? 409 : bad ? 400 : 500)).json({
    error:
      err.code === 11000
        ? "That project or table already exists."
        : bad
          ? "Check the submitted values."
          : err.status ? err.message : "Could not save judging data. Try again.",
  });
}
function validId(req, res) {
  if (mongoose.isValidObjectId(req.params.id)) return true;
  res.status(404).json({ error: "Record not found." });
  return false;
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} */
async function listRooms(req, res) {
  try {
    res.json({ rooms: await Room.find({}).sort({ order: 1, name: 1 }).lean() });
  } catch (err) {
    fail(res, err);
  }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} */
async function saveRoom(req, res) {
  if (req.params.id && !validId(req, res)) return;
  var body = req.body || {};
  var values = {};
  for (var field of ["name", "order", "capacity", "hardware"]) {
    if (body[field] !== undefined) values[field] = body[field];
  }
  if (
    (values.name !== undefined &&
      (typeof values.name !== "string" ||
        !values.name.trim() ||
        values.name.length > 100)) ||
    ["order", "capacity"].some(function invalid(key) {
      return (
        values[key] !== undefined &&
        (!Number.isInteger(values[key]) || values[key] < 0)
      );
    }) ||
    (values.hardware !== undefined && typeof values.hardware !== "boolean") ||
    (!req.params.id && (!values.name || values.capacity === undefined))
  ) {
    res.status(400).json({
      error:
        "Enter a name, whole nonnegative order and capacity, and a hardware flag.",
    });
    return;
  }
  try {
    if (await JudgingTable.exists({}) || await Project.exists({ tableNumber: { $type: "number" } })) {
      return res.status(409).json({ error: "Room layout is locked after table signs or assignments are created." });
    }
    var room = req.params.id
      ? await Room.findByIdAndUpdate(
          req.params.id,
          { $set: values },
          { new: true, runValidators: true },
        )
      : await Room.create(values);
    if (!room) {
      res.status(404).json({ error: "Room not found." });
      return;
    }
    res.status(req.params.id ? 200 : 201).json({ room: room });
  } catch (err) {
    fail(res, err);
  }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} */
async function deleteRoom(req, res) {
  if (!validId(req, res)) return;
  try {
    if (await JudgingTable.exists({}) || await Project.exists({ tableNumber: { $type: "number" } })) return res.status(409).json({ error: "Room layout is locked after table signs or assignments are created." });
    if (
      await Project.exists({
        room: req.params.id,
        tableNumber: { $type: "number" },
      })
    ) {
      res.status(409).json({ error: "This room has projects at tables." });
      return;
    }
    var room = await Room.findByIdAndDelete(req.params.id);
    if (!room) {
      res.status(404).json({ error: "Room not found." });
      return;
    }
    await Project.updateMany({ room: req.params.id }, { $unset: { room: 1 } });
    res.json({ ok: true });
  } catch (err) {
    fail(res, err);
  }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} */
async function listProjects(req, res) {
  var filter = {};
  if (req.query.room) {
    if (!mongoose.isValidObjectId(req.query.room)) {
      res.status(400).json({ error: "Invalid room." });
      return;
    }
    filter.room = req.query.room;
  }
  if (req.query.category !== undefined) {
    if (typeof req.query.category !== "string") {
      res.status(400).json({ error: "Invalid category." });
      return;
    }
    filter.category = req.query.category;
  }
  for (var key of ["hardware", "unmatchedMembers"]) {
    if (
      req.query[key] !== undefined &&
      !["true", "false"].includes(req.query[key])
    ) {
      res.status(400).json({ error: "Filters must be true or false." });
      return;
    }
  }
  if (req.query.hardware !== undefined)
    filter.hardware = req.query.hardware === "true";
  if (req.query.unmatchedMembers !== undefined)
    filter["unmatchedMembers.0"] = {
      $exists: req.query.unmatchedMembers === "true",
    };
  try {
    res.json({
      projects: await Project.find(filter)
        .populate("room", "name")
        .sort({ name: 1 })
        .lean(),
    });
  } catch (err) {
    fail(res, err);
  }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} */
async function updateProject(req, res) {
  if (!validId(req, res)) return;
  var values = {};
  for (var field of overrideFields) {
    if (field === "team") continue;
    if (req.body && req.body[field] !== undefined) {
      if (
        typeof req.body[field] !== (field === "category" ? "string" : "boolean")
      ) {
        res.status(400).json({ error: "Invalid " + field + "." });
        return;
      }
      values[field] = req.body[field];
    }
  }
  try {
    var control = require("../utils/judging/state");
    var project = await control.locked(async function update(state) {
      if (req.body && req.body.team !== undefined) {
        if (req.body.team === null || req.body.team === "") values.team = null;
        else {
          if (!mongoose.isValidObjectId(req.body.team)) throw control.problem(400, "Invalid team.");
          var selectedTeam = await Team.findById(req.body.team);
          if (!selectedTeam) throw control.problem(400, "Team not found.");
          values.team = selectedTeam._id;
          values.members = selectedTeam.members;
        }
      }
      var previous = await Project.findById(req.params.id);
      if (!previous) return null;
      if (values.team && await Project.exists({ team: values.team, _id: { $ne: previous._id } })) throw control.problem(409, "This team already has a project.");
      var clearTeam = values.team === null;
      if (clearTeam) delete values.team;
      var updated = await Project.findByIdAndUpdate(
        req.params.id,
        {
          $set: values,
          ...(clearTeam ? { $unset: { team: 1 } } : {}),
          $addToSet: { overriddenFields: { $each: Object.keys(values).filter(function override(key) { return overrideFields.includes(key); }).concat(clearTeam ? ["team"] : []) } },
        },
        { new: true, runValidators: true },
      );
      if (updated && req.body && req.body.team !== undefined && previous.deskCheckedInAt) {
        if (previous.team && String(previous.team) !== String(updated.team)) await Team.updateOne({ _id: previous.team }, { $unset: { lockedAt: 1, lockedBy: 1 } });
        if (updated.team) await Team.updateOne({ _id: updated.team, lockedAt: null }, { $set: { lockedAt: previous.deskCheckedInAt, lockedBy: req.user.id } });
      }
      if (updated && updated.withdrawn) await control.removeProject(updated._id, state);
      return updated;
    });
    if (!project) {
      res.status(404).json({ error: "Project not found." });
      return;
    }
    res.json({ project: project });
  } catch (err) {
    fail(res, err);
  }
}

// Explicit aliases only. Unknown columns are reported, never inferred from values.
var aliases = {
  name: ["teamname", "project title", "project name"],
  devpostUrl: ["suburl", "submission url", "submission link", "project url"],
  first: ["leadfirst", "submitter first name"],
  last: ["leadlast", "submitter last name"],
  submitterEmail: ["projectemail", "submitter email"],
  category: ["categoryapplied", "category", "judging category"],
  optInPrizes: ["opt-in prizes", "opt in prizes"],
  mlhTracks: ["mlh", "mlh tracks"],
  hardware: ["hardwarejudge", "hardware judging", "hardware"],
  needsPower: ["needs power"],
};
function column(header) {
  var name = header.trim().toLowerCase();
  for (var key of Object.keys(aliases))
    if (aliases[key].includes(name)) return key;
  var member =
    /^(?:teammem\d+|team member \d+ )(first|last|email)(?: name)?$/.exec(name);
  return member ? "member:" + member[1] : null;
}
function split(value) {
  return String(value || "")
    .split(/[;,|]/)
    .map(function trim(s) {
      return s.trim();
    })
    .filter(Boolean);
}
function bool(value) {
  return /^(yes|true|1|y)$/i.test(String(value || "").trim());
}
function comparable(value) {
  return JSON.stringify(value, function ids(key, v) {
    return key === "_id" ? undefined : v;
  });
}

/**
 * Parse positional CSV without collapsing repeated headers. No database writes.
 * @param {Buffer} buffer - CSV bytes.
 * @returns {object} Header mappings and records.
 */
function parseCsv(buffer) {
  var text = buffer.toString("utf8");
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffd]/.test(text))
    throw new Error("Upload a UTF-8 CSV file.");
  var records = parse(text, {
    bom: true,
    skip_empty_lines: true,
    info: true,
    max_record_size: 2 * 1024 * 1024,
  });
  if (!records.length || records.length > 2001)
    throw new Error("CSV must contain a header and at most 2000 project rows.");
  var headers = records.shift().record;
  var columns = headers.map(column);
  if (!columns.includes("name") || !columns.includes("devpostUrl"))
    throw new Error(
      "CSV needs recognized project name and submission URL columns.",
    );
  return {
    records: records,
    columns: columns,
    unrecognizedColumns: headers.filter(function unknown(h, i) {
      return !columns[i];
    }),
  };
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} */
async function previewImport(req, res) {
  if (!req.file) {
    res.status(400).json({ error: "Upload a CSV using the file field." });
    return;
  }
  var csv;
  try {
    csv = parseCsv(req.file.buffer);
  } catch (err) {
    res.status(400).json({ error: err.message });
    return;
  }
  try {
    var users = await User.find({}).select("_id email").lean();
    var byEmail = Object.create(null);
    users.forEach(function index(user) {
      byEmail[user.email.toLowerCase()] = String(user._id);
    });
    var preview = {
      counts: { new: 0, updated: 0, unchanged: 0, errors: 0 },
      rows: [],
      errors: [],
      unrecognizedColumns: csv.unrecognizedColumns,
    };
    var seen = Object.create(null);
    var teams = await Team.find({}).lean();
    var teamRows = new Map();
    var linkedProjects = await Project.find({ team: { $exists: true } }).select("team devpostUrl name").lean();
    for (var record of csv.records) {
      var data = {};
      var people = [];
      var person = null;
      record.record.forEach(function read(value, i) {
        var key = csv.columns[i];
        value = value.trim();
        if (!key) return;
        if (key.indexOf("member:") === 0) {
          var part = key.slice(7);
          if (!person || part === "first" || person[part] !== undefined) {
            person = {};
            people.push(person);
          }
          person[part] = value;
        } else data[key] = value;
      });
      var rowNumber = record.info.lines;
      var url = /^https:\/\//i.test(data.devpostUrl || "")
        ? normalizeUrl(data.devpostUrl)
        : null;
      if (!data.name || !url || seen[url]) {
        preview.errors.push({
          rowNumber: rowNumber,
          reason: !data.name
            ? "Project name is required."
            : !url
              ? "Use an https devpost.com/software project URL."
              : "Duplicate project URL in this CSV.",
        });
        preview.counts.errors++;
        continue;
      }
      seen[url] = true;
      people.unshift({
        first: data.first,
        last: data.last,
        email: data.submitterEmail,
      });
      var existing = await Project.findOne({ devpostUrl: url }).lean();
      var members = [];
      var unmatched = [];
      var emails = Object.create(null);
      people.forEach(function match(p) {
        var email = String(p.email || "").trim().toLowerCase();
        if (!email || emails[email]) return;
        emails[email] = true;
        if (byEmail[email]) {
          if (!members.includes(byEmail[email])) members.push(byEmail[email]);
        } else unmatched.push({ name: [p.first, p.last].filter(Boolean).join(" "), email: email });
      });
      var emailTeams = teams.filter(function contains(t) {
        return t.members.some(function member(id) { return members.includes(String(id)); });
      });
      var team = teams.find(function linked(t) { return t.devpostUrl === url; }) || members.map(function memberTeam(id) { return emailTeams.find(function includes(t) { return t.members.map(String).includes(id); }); }).find(Boolean);
      if (existing && existing.team) team = teams.find(function linked(t) { return String(t._id) === String(existing.team); });
      if (existing && (existing.overriddenFields || []).includes("team") && !existing.team) team = null;
      var warnings = emailTeams.length > 1 ? ["Member emails belong to multiple teams: " + emailTeams.map(function name(t) { return t.name; }).join(", ")] : [];
      var matchedUsers = members.slice();
      if (team) members = Array.from(new Set(team.members.map(String).concat(members)));
      var values = {
        name: data.name,
        devpostUrl: url,
        submitterEmail: String(data.submitterEmail || "").toLowerCase(),
        members: members,
        unmatchedMembers: unmatched,
        category: data.category || "",
        optInPrizes: split(data.optInPrizes),
        mlhTracks: split(data.mlhTracks),
        hardware: bool(data.hardware),
        needsPower: bool(data.needsPower),
      };
      if (team) values.team = String(team._id);
      var effective = Object.assign({}, values);
      if (existing)
        (existing.overriddenFields || []).forEach(function preserve(key) {
          delete values[key];
          effective[key] = existing[key];
        });
      var status = !existing
        ? "new"
        : Object.keys(values).some(function changed(key) {
              return comparable(existing[key]) !== comparable(values[key]);
            })
          ? "updated"
          : "unchanged";
      preview.counts[status]++;
      var previewRow = {
        matchedUsers: matchedUsers,
        matchedTeam: team ? { id: team._id, name: team.name } : null,
        warnings: warnings,
        rowNumber: rowNumber,
        status: status,
        project: effective,
        values: values,
        unmatchedMembers: unmatched,
      };
      var conflict = team && linkedProjects.find(function other(p) { return String(p.team) === String(team._id) && p.devpostUrl !== url; });
      if (conflict) {
        preview.counts[status]--;
        previewRow.status = "error";
        preview.counts.errors++;
        preview.errors.push({ rowNumber: rowNumber, reason: "Team " + team.name + " has two submissions: " + conflict.name + " and " + data.name });
      }
      preview.rows.push(previewRow);
      if (team) {
        var key = String(team._id);
        if (!teamRows.has(key)) teamRows.set(key, []);
        teamRows.get(key).push(previewRow);
      }
    }
    teamRows.forEach(function duplicates(rows) {
      if (rows.length < 2) return;
      var reason = "Team " + rows[0].matchedTeam.name + " has two submissions: " + rows.map(function title(row) { return row.project.name; }).join(" and ");
      rows.forEach(function reject(row) {
        if (row.status !== "error") {
          preview.counts[row.status]--;
          row.status = "error";
          preview.counts.errors++;
        }
        var existingError = preview.errors.find(function same(error) { return error.rowNumber === row.rowNumber; });
        if (existingError) existingError.reason = reason;
        else preview.errors.push({ rowNumber: row.rowNumber, reason: reason });
      });
    });
    var stored = await ProjectImport.create({
      createdBy: req.user.id,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      preview: preview,
    });
    res.json({ id: stored._id, expiresAt: stored.expiresAt, preview: preview });
  } catch (err) {
    fail(res, err);
  }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} */
async function confirmImport(req, res) {
  if (!validId(req, res)) return;
  try {
    // Claim before applying, including on standalone MongoDB. A failed apply is
    // never replayed blindly; upload again to preview the remaining differences.
    var stored = await ProjectImport.findOneAndUpdate(
      {
        _id: req.params.id,
        createdBy: req.user.id,
        expiresAt: { $gt: new Date() },
        consumedAt: { $exists: false },
      },
      { $set: { consumedAt: new Date() } },
      { new: true },
    );
    if (!stored) {
      res.status(409).json({
        error:
          "Preview expired, already confirmed, or belongs to another uploader. Upload again.",
      });
      return;
    }
    for (var row of stored.preview.rows) {
      if (row.status === "error") continue;
      await require("../utils/judging/state").locked(async function applyRow() {
        var values = Object.assign({}, row.values);
        var live = await Project.findOne({ devpostUrl: values.devpostUrl }).lean();
        if (live && live.team) values.team = live.team;
        if (live && !live.team && (live.overriddenFields || []).includes("team")) delete values.team;
        if (values.team) {
          var currentTeam = await Team.findById(values.team).lean();
          if (!currentTeam) throw new Error("Team no longer exists.");
          values.members = Array.from(new Set(currentTeam.members.map(String).concat(row.matchedUsers || values.members)));
          values.team = new mongoose.Types.ObjectId(values.team);
          if (live && live.deskCheckedInAt) await Team.updateOne({ _id: values.team, lockedAt: null }, { $set: { lockedAt: live.deskCheckedInAt, lockedBy: req.user.id } });
        }
        // Pipeline evaluates overrides atomically, including edits since preview.
        var set = {};
        Object.keys(values).forEach(function field(key) {
          set[key] = overrideFields.includes(key)
            ? {
                $cond: [
                  { $in: [key, { $ifNull: ["$overriddenFields", []] }] },
                  "$" + key,
                  { $literal: values[key] },
                ],
              }
            : {
                $literal:
                  key === "members"
                    ? values[key].map(function id(v) {
                        return new mongoose.Types.ObjectId(v);
                      })
                    : values[key],
              };
        });
        set.updatedAt = new Date();
        await Project.updateOne(
          { devpostUrl: values.devpostUrl },
          [
            {
              $set: {
                withdrawn: { $ifNull: ["$withdrawn", false] },
                overriddenFields: { $ifNull: ["$overriddenFields", []] },
                createdAt: { $ifNull: ["$createdAt", new Date()] },
              },
            },
            { $set: set },
          ],
          { upsert: true },
        );
      });
    }
    res.json({ ok: true, counts: stored.preview.counts });
  } catch (err) {
    res.status(err.code === 11000 ? 409 : 500).json({
      error:
        "Import could not finish. Some rows may have been applied. Upload the CSV again to preview the remaining changes.",
    });
  }
}
module.exports = {
  listRooms: listRooms,
  saveRoom: saveRoom,
  deleteRoom: deleteRoom,
  listProjects: listProjects,
  updateProject: updateProject,
  previewImport: previewImport,
  confirmImport: confirmImport,
  parseCsv: parseCsv,
};
