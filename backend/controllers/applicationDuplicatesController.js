"use strict";

var mongoose = require("mongoose");

var Application = require("../schemas/application");
var DuplicateDismissal = require("../schemas/duplicateDismissal");
var HardwareCheckout = require("../schemas/hardwareCheckout");
var Team = require("../schemas/team");
var User = require("../schemas/user");
var WorkshopSignup = require("../schemas/workshopSignup");
var activeApplications = require("../utils/activeApplications");
var applicationDuplicates = require("../utils/applicationDuplicates");
var applicationFlags = require("../utils/applicationFlags");
var applicationEditController = require("./applicationEditController");

var MAX_REASON_LENGTH = 300;
var MAX_SEARCH_RESULTS = 10;
var MAX_GROUPS = 200;
var MAX_DISMISS_IDS = 10;
var ANSWER_FIELD = /^answers\.[A-Za-z0-9_-]+$/;

// The review table's columns, for search results and suggestion groups.
var ROW_FIELDS = "name university status round applicant phone phoneKey flagged createdAt";

/**
 * @param {*} value - Anything.
 * @returns {boolean} Whether it is a well-formed ObjectId string.
 */
function validId(value) {
  return typeof value === "string" && mongoose.isValidObjectId(value);
}

/**
 * Whether a string looks like a valid choice side for the merge request.
 * @param {*} value - Anything.
 * @returns {boolean}
 */
function isSide(value) {
  return value === "this" || value === "other";
}

/**
 * Escape text for use inside a regular expression.
 * @param {string} text - Plain text.
 * @returns {string}
 */
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Everything that hangs off an application's account and is NOT moved by a
 * merge: team, check-in, workshop sign-ups, hardware loans.
 *
 * @param {object} application - Application document (with `applicant` an id).
 * @returns {Promise<object>} `{ checkedIn, checkedInAt, team, workshopSignups,
 *   hardwareLoans, hardwareLoansOpen }`.
 */
function attachmentsFor(application) {
  var userId = application.applicant;
  return Promise.all([
    User.findById(userId).select("checkedIn checkedInAt").lean(),
    Team.findOne({ members: userId }).select("name leader").lean(),
    WorkshopSignup.countDocuments({ user: userId }),
    HardwareCheckout.countDocuments({ user: userId }),
    HardwareCheckout.countDocuments({ user: userId, returnedAt: null }),
  ]).then(function toAttachments(found) {
    var user = found[0] || {};
    var team = found[1];
    return {
      checkedIn: Boolean(user.checkedIn),
      checkedInAt: user.checkedInAt || null,
      team: team ? { _id: team._id, name: team.name, isLeader: String(team.leader) === String(userId) } : null,
      workshopSignups: found[2],
      hardwareLoans: found[3],
      hardwareLoansOpen: found[4],
    };
  });
}

/**
 * Plain-words warnings about what is attached to an application's account,
 * shown when that application is the one being removed.
 *
 * @param {object} application - Application document.
 * @param {object} attachments - From attachmentsFor.
 * @returns {Array<string>}
 */
function warningsFor(application, attachments) {
  var out = [];
  if (application.status === "accepted") {
    out.push("This application is accepted. Its account will stop counting as accepted, so it will not be admitted at check-in.");
  }
  if (attachments.checkedIn) {
    out.push("This account is checked in.");
  }
  if (attachments.team) {
    out.push("This account is on team " + attachments.team.name + (attachments.team.isLeader ? " (as leader)." : "."));
  }
  if (attachments.workshopSignups) {
    out.push("This account has " + attachments.workshopSignups + " workshop sign-up" + (attachments.workshopSignups === 1 ? "." : "s."));
  }
  if (attachments.hardwareLoans) {
    out.push(
      "This account has " +
        attachments.hardwareLoans +
        " hardware loan" +
        (attachments.hardwareLoans === 1 ? "" : "s") +
        (attachments.hardwareLoansOpen ? " (" + attachments.hardwareLoansOpen + " not returned yet)." : ".")
    );
  }
  return out;
}

/**
 * The removal fields and audit entry for marking an application removed.
 *
 * @param {object} options
 * @param {*} options.by - User id of the staff member.
 * @param {string} options.reason - Why.
 * @param {*} [options.duplicateOf] - Application id it duplicates.
 * @param {string} options.kind - "remove" or "merge".
 * @param {*} [options.other] - The other application, for a merge.
 * @returns {{set: object, edit: object}}
 */
function removalUpdate(options) {
  var now = new Date();
  var set = { removedAt: now, removedBy: options.by, removedReason: options.reason };
  if (options.duplicateOf) {
    set.duplicateOf = options.duplicateOf;
  }
  var edit = { by: options.by, at: now, fields: [], kind: options.kind, note: options.reason };
  if (options.other) {
    edit.other = options.other;
  }
  return { set: set, edit: edit };
}

/**
 * POST /api/admin/applications/:id/remove
 * Mark an application as removed (a duplicate, a test entry) with a required
 * reason. Nothing is deleted: the application and the applicant's account
 * stay, and Restore undoes it. Recorded in `edits`.
 *
 * Body: { reason: string, duplicateOf?: <application id> }
 *
 * @param {object} req - Express request (req.user set by the moderator guard).
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function removeApplication(req, res) {
  var id = req.params.id;
  var reason = applicationFlags.cleanReason(req.body && req.body.reason).slice(0, MAX_REASON_LENGTH);
  var duplicateOf = req.body && req.body.duplicateOf;
  if (!validId(id)) {
    res.status(404).json({ error: "Application not found." });
    return Promise.resolve();
  }
  if (!reason) {
    res.status(400).json({ error: "A reason is required to remove an application." });
    return Promise.resolve();
  }
  if (duplicateOf !== undefined && duplicateOf !== null && duplicateOf !== "") {
    if (!validId(duplicateOf) || String(duplicateOf) === String(id)) {
      res.status(400).json({ error: "duplicateOf must be the id of a different application." });
      return Promise.resolve();
    }
  } else {
    duplicateOf = null;
  }

  var update = removalUpdate({ by: req.user.id, reason: reason, duplicateOf: duplicateOf, kind: "remove" });
  return Promise.resolve(duplicateOf ? Application.exists({ _id: duplicateOf }) : true)
    .then(function afterCheck(exists) {
      if (!exists) {
        res.status(400).json({ error: "The application it duplicates was not found." });
        return null;
      }
      // The filter is the guard: of two clicks only one marks it removed.
      return Application.findOneAndUpdate(
        activeApplications.active({ _id: id }),
        { $set: update.set, $push: { edits: update.edit } },
        { new: true }
      ).then(function afterUpdate(application) {
        if (application) {
          return applicationEditController.loadForReview(application._id).then(function respond(fresh) {
            res.status(200).json({ application: fresh.toJSON({ includeFlags: true }) });
          });
        }
        return Application.exists({ _id: id }).then(function afterExists(found) {
          if (found) {
            res.status(409).json({ error: "This application is already removed." });
          } else {
            res.status(404).json({ error: "Application not found." });
          }
        });
      });
    })
    .catch(function onError(err) {
      console.error("removeApplication failed:", err);
      res.status(500).json({ error: "Could not remove the application." });
    });
}

/**
 * POST /api/admin/applications/:id/restore
 * Undo a removal. Recorded in `edits`.
 *
 * @param {object} req - Express request (req.user set by the moderator guard).
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function restoreApplication(req, res) {
  var id = req.params.id;
  if (!validId(id)) {
    res.status(404).json({ error: "Application not found." });
    return Promise.resolve();
  }
  var edit = { by: req.user.id, at: new Date(), fields: [], kind: "restore" };
  return Application.findOneAndUpdate(
    { _id: id, removedAt: { $ne: null } },
    {
      $set: { removedAt: null },
      $unset: { removedBy: "", removedReason: "", duplicateOf: "" },
      $push: { edits: edit },
    },
    { new: true }
  )
    .then(function afterUpdate(application) {
      if (application) {
        return applicationEditController.loadForReview(application._id).then(function respond(fresh) {
          res.status(200).json({ application: fresh.toJSON({ includeFlags: true }) });
        });
      }
      return Application.exists({ _id: id }).then(function afterExists(found) {
        if (found) {
          res.status(409).json({ error: "This application is not removed." });
        } else {
          res.status(404).json({ error: "Application not found." });
        }
      });
    })
    .catch(function onError(err) {
      console.error("restoreApplication failed:", err);
      res.status(500).json({ error: "Could not restore the application." });
    });
}

/**
 * GET /api/admin/applications/search?q=...
 * Find active applications by applicant name or account email, to pick the
 * other half of a merge. Up to 10 matches.
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function searchApplications(req, res) {
  var q = req.query && typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (q.length < 2) {
    res.status(200).json({ applications: [] });
    return Promise.resolve();
  }
  var rx = new RegExp(escapeRegex(q), "i");
  return User.find({ $or: [{ email: rx }, { name: rx }] })
    .select("_id")
    .limit(50)
    .lean()
    .then(function afterUsers(users) {
      var filter = activeApplications.active({
        status: { $ne: "draft" },
        $or: [
          { name: rx },
          {
            applicant: {
              $in: users.map(function toId(user) {
                return user._id;
              }),
            },
          },
        ],
      });
      if (validId(req.query.exclude)) {
        filter._id = { $ne: req.query.exclude };
      }
      return Application.find(filter)
        .select(ROW_FIELDS)
        .populate("applicant", "name email")
        .populate("round", "name")
        .sort({ createdAt: -1 })
        .limit(MAX_SEARCH_RESULTS)
        .lean();
    })
    .then(function respond(applications) {
      res.status(200).json({ applications: applications });
    })
    .catch(function onError(err) {
      console.error("searchApplications failed:", err);
      res.status(500).json({ error: "Could not search applications." });
    });
}

/**
 * Load the two applications of a compare or merge, in full.
 *
 * @param {string} id - First application id.
 * @param {string} otherId - Second application id.
 * @returns {Promise<Array<object>|null>} [first, second] documents, or null
 *   when either does not exist.
 */
function loadPair(id, otherId) {
  return Promise.all([
    applicationEditController.loadForReview(id),
    applicationEditController.loadForReview(otherId),
  ]).then(function check(pair) {
    return pair[0] && pair[1] ? pair : null;
  });
}

/**
 * GET /api/admin/applications/:id/compare?otherId=...
 * Both applications side by side with what hangs off each account (check-in,
 * team, workshop sign-ups, hardware loans), the fields a merge can choose
 * between, which application a merge keeps by default, and the warnings
 * shown for whichever one would be removed.
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function compareApplications(req, res) {
  var id = req.params.id;
  var otherId = req.query && req.query.otherId;
  if (!validId(id) || !validId(otherId)) {
    res.status(404).json({ error: "Application not found." });
    return Promise.resolve();
  }
  if (String(id) === String(otherId)) {
    res.status(400).json({ error: "Pick a different application to merge with." });
    return Promise.resolve();
  }
  return loadPair(id, otherId)
    .then(function afterLoad(pair) {
      if (!pair) {
        res.status(404).json({ error: "Application not found." });
        return null;
      }
      var one = pair[0];
      var two = pair[1];
      return Promise.all([
        attachmentsFor({ applicant: one.applicant._id }),
        attachmentsFor({ applicant: two.applicant._id }),
      ]).then(function respond(attachments) {
        var keepDefault = applicationDuplicates.defaultKept(one, two) === one ? "this" : "other";
        var blocked = [one, two].some(function removed(application) {
          return Boolean(application.removedAt);
        });
        res.status(200).json({
          this: { application: one.toJSON({ includeFlags: true }), attachments: attachments[0] },
          other: { application: two.toJSON({ includeFlags: true }), attachments: attachments[1] },
          fields: applicationDuplicates.mergeFieldList(one, two),
          defaultKeep: keepDefault,
          removed: blocked,
          bothCheckedIn:
            one.status === "accepted" && two.status === "accepted" && attachments[0].checkedIn && attachments[1].checkedIn,
          warnings: {
            this: warningsFor(one, attachments[0]),
            other: warningsFor(two, attachments[1]),
          },
        });
        return null;
      });
    })
    .catch(function onError(err) {
      console.error("compareApplications failed:", err);
      res.status(500).json({ error: "Could not compare the applications." });
    });
}

/**
 * Check the merge request's `fields` choices against the fields on offer.
 *
 * @param {*} choices - Body `fields`.
 * @param {Array<string>} allowed - From mergeFieldList.
 * @returns {string|null} A problem, or null when fine.
 */
function choicesProblem(choices, allowed) {
  if (choices === undefined) {
    return null;
  }
  if (!choices || typeof choices !== "object" || Array.isArray(choices)) {
    return "fields must be an object of field to \"this\" or \"other\".";
  }
  var bad = Object.keys(choices).filter(function invalid(field) {
    return allowed.indexOf(field) === -1 || !isSide(choices[field]);
  });
  return bad.length ? "Unknown field or choice: " + bad.join(", ") + "." : null;
}

/**
 * A MongoDB update for the kept application from the resolved merge changes.
 *
 * @param {Array<{field: string, value: *}>} changes - From resolveMerge.
 * @param {object} gone - The removed Application document (for the resume).
 * @returns {{$set: object, $unset: object}}
 */
function keptUpdate(changes, gone) {
  var set = {};
  var unset = {};
  changes.forEach(function apply(change) {
    if (change.field === "resume") {
      set.resumeBlobName = gone.resumeBlobName;
      set.resumeHash = gone.resumeHash;
    } else if (change.value === undefined) {
      unset[change.field] = "";
    } else {
      set[change.field] = change.value;
    }
    if (change.field === "phone") {
      set.phoneKey = applicationFlags.phoneKey(change.value) || undefined;
    }
  });
  if (set.phoneKey === undefined && "phoneKey" in set) {
    delete set.phoneKey;
    unset.phoneKey = "";
  }
  return { $set: set, $unset: unset };
}

/**
 * POST /api/admin/applications/:id/merge
 * Merge two duplicate applications into one. The kept application takes the
 * chosen values (by default its own, filling blanks from the other); the other
 * is marked removed ("Merged into ...", duplicateOf = kept). Both audit
 * trails record the merge. Accounts, check-ins, teams, workshop sign-ups and
 * hardware loans are not moved: compare lists what is attached.
 *
 * Refused (409) when both are accepted and both checked in, unless an admin
 * sends `confirmBothCheckedIn: true`.
 *
 * Body: { otherId, keep: "this"|"other", fields?: { <field>: "this"|"other" },
 *         confirmBothCheckedIn?: boolean }
 *
 * @param {object} req - Express request (req.user set by the moderator guard).
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function mergeApplications(req, res) {
  var id = req.params.id;
  var body = req.body || {};
  if (!validId(id) || !validId(body.otherId)) {
    res.status(validId(id) ? 400 : 404).json({ error: validId(id) ? "otherId must be an application id." : "Application not found." });
    return Promise.resolve();
  }
  if (String(id) === String(body.otherId)) {
    res.status(400).json({ error: "Pick a different application to merge with." });
    return Promise.resolve();
  }
  if (!isSide(body.keep)) {
    res.status(400).json({ error: "keep must be \"this\" or \"other\"." });
    return Promise.resolve();
  }

  var state = {};
  return loadPair(id, body.otherId)
    .then(function afterLoad(pair) {
      if (!pair) {
        res.status(404).json({ error: "Application not found." });
        return null;
      }
      var fields = applicationDuplicates.mergeFieldList(pair[0], pair[1]).filter(function safe(field) {
        return field.indexOf("answers.") !== 0 || ANSWER_FIELD.test(field);
      });
      var problem = choicesProblem(body.fields, fields);
      if (problem) {
        res.status(400).json({ error: problem });
        return null;
      }
      if (pair[0].removedAt || pair[1].removedAt) {
        res.status(409).json({ error: "One of these applications is already removed. Restore it first, or pick another." });
        return null;
      }

      var keepThis = body.keep === "this";
      state.kept = keepThis ? pair[0] : pair[1];
      state.gone = keepThis ? pair[1] : pair[0];
      // The request names sides relative to :id; the merge works in kept/gone.
      var choices = {};
      Object.keys(body.fields || {}).forEach(function translate(field) {
        var thisSide = body.fields[field] === "this";
        choices[field] = thisSide === keepThis ? "kept" : "gone";
      });
      state.changes = applicationDuplicates.resolveMerge(state.kept, state.gone, choices, fields);

      return Promise.all([attachmentsFor({ applicant: pair[0].applicant._id }), attachmentsFor({ applicant: pair[1].applicant._id })]).then(
        function afterAttachments(attachments) {
          var bothCheckedIn =
            pair[0].status === "accepted" && pair[1].status === "accepted" && attachments[0].checkedIn && attachments[1].checkedIn;
          if (bothCheckedIn && !(req.user.role === "admin" && body.confirmBothCheckedIn === true)) {
            res.status(409).json({
              error:
                "Both applications are accepted and both people are checked in. Merging may be a mistake. An admin can confirm it explicitly.",
              code: "both_checked_in",
            });
            return null;
          }
          return performMerge(req, res, state, attachments[keepThis ? 1 : 0]);
        }
      );
    })
    .then(function respond(result) {
      if (!result) {
        return null;
      }
      return applicationEditController.loadForReview(state.kept._id).then(function reload(fresh) {
        res.status(200).json({
          application: fresh.toJSON({ includeFlags: true }),
          changed: state.changes.map(function field(change) {
            return change.field;
          }),
          warnings: result.warnings,
        });
        return null;
      });
    })
    .catch(function onError(err) {
      if (res.headersSent) {
        console.error("mergeApplications failed after responding:", err);
        return;
      }
      console.error("mergeApplications failed:", err);
      res.status(500).json({ error: "Could not merge the applications." });
    });
}

/**
 * Do the merge writes. Marking the removed application claims the merge: its
 * filter only matches while it is still active, so a double click (or two
 * staff merging the same pair) can only succeed once. If the kept application
 * changed under us, the claim is undone.
 *
 * Sends the 409 itself when the merge was lost; returns null then.
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @param {{kept: object, gone: object, changes: Array}} state - Resolved merge.
 * @param {object} goneAttachments - attachmentsFor the removed application.
 * @returns {Promise<{warnings: Array<string>}|null>}
 */
function performMerge(req, res, state, goneAttachments) {
  var kept = state.kept;
  var gone = state.gone;
  var by = req.user.id;
  var keptLabel = (kept.name || "unnamed") + " (" + (kept.applicant && kept.applicant.email) + ")";
  var goneLabel = (gone.name || "unnamed") + " (" + (gone.applicant && gone.applicant.email) + ")";

  var removal = removalUpdate({
    by: by,
    reason: ("Merged into " + keptLabel).slice(0, MAX_REASON_LENGTH),
    duplicateOf: kept._id,
    kind: "merge",
    other: kept._id,
  });
  removal.edit.fields = [];

  return Application.findOneAndUpdate(
    activeApplications.active({ _id: gone._id }),
    { $set: removal.set, $push: { edits: removal.edit } },
    { new: true }
  ).then(function afterClaim(claimed) {
    if (!claimed) {
      res.status(409).json({ error: "These applications were already merged or one was removed." });
      return null;
    }
    var update = keptUpdate(state.changes, gone);
    var keptEdit = {
      by: by,
      at: new Date(),
      kind: "merge",
      other: gone._id,
      note: "Merged " + goneLabel + " into this application.",
      fields: state.changes.map(function describe(change) {
        return change.field + " (from the other application)";
      }),
    };
    var operations = { $push: { edits: keptEdit } };
    if (Object.keys(update.$set).length) operations.$set = update.$set;
    if (Object.keys(update.$unset).length) operations.$unset = update.$unset;

    return Application.findOneAndUpdate(activeApplications.active({ _id: kept._id }), operations, { new: true }).then(
      function afterKept(updated) {
        if (updated) {
          return { warnings: warningsFor(gone, goneAttachments) };
        }
        // The kept application was removed in the meantime: undo the claim.
        return Application.updateOne(
          { _id: gone._id },
          {
            $set: { removedAt: null },
            $unset: { removedBy: "", removedReason: "", duplicateOf: "" },
            $pull: { edits: { at: removal.edit.at, kind: "merge" } },
          }
        ).then(function afterUndo() {
          res.status(409).json({ error: "The application to keep was removed while merging. Nothing was changed." });
          return null;
        });
      }
    );
  });
}

/**
 * GET /api/admin/applications/duplicates?round=...
 * Groups of active, submitted applications that look like the same person:
 * the same phone number, the same full name, or Gmail-equivalent emails
 * (dots and +tags). Pairs staff dismissed are not suggested again.
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function listDuplicates(req, res) {
  var filter = activeApplications.active({ status: { $ne: "draft" } });
  if (req.query && req.query.round) {
    if (!validId(req.query.round)) {
      res.status(400).json({ error: "round is not a valid id." });
      return Promise.resolve();
    }
    filter.round = req.query.round;
  }
  var state = {};
  return Application.find(filter)
    .select(ROW_FIELDS)
    .populate("applicant", "name email")
    .populate("round", "name")
    .lean()
    .then(function afterFind(applications) {
      state.applications = applications;
      var ids = applications.map(function toId(application) {
        return application._id;
      });
      return DuplicateDismissal.find({ a: { $in: ids }, b: { $in: ids } }).lean();
    })
    .then(function respond(dismissals) {
      var pairs = dismissals.map(function toPair(dismissal) {
        return applicationDuplicates.sortedPair(dismissal.a, dismissal.b);
      });
      var groups = applicationDuplicates.suggestGroups(state.applications, pairs);
      res.status(200).json({ groups: groups.slice(0, MAX_GROUPS), total: groups.length });
    })
    .catch(function onError(err) {
      console.error("listDuplicates failed:", err);
      res.status(500).json({ error: "Could not look for duplicates." });
    });
}

/**
 * POST /api/admin/applications/duplicates/dismiss
 * Remember that these applications are not duplicates of each other, so the
 * suggestions stop showing every pair among them.
 *
 * Body: { ids: [<application id>, ...] } (2 to 10 ids)
 *
 * @param {object} req - Express request (req.user set by the moderator guard).
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function dismissDuplicates(req, res) {
  var ids = req.body && req.body.ids;
  if (!Array.isArray(ids) || ids.length < 2 || ids.length > MAX_DISMISS_IDS || !ids.every(validId)) {
    res.status(400).json({ error: "ids must list 2 to " + MAX_DISMISS_IDS + " application ids." });
    return Promise.resolve();
  }
  var pairs = [];
  for (var i = 0; i < ids.length; i += 1) {
    for (var j = i + 1; j < ids.length; j += 1) {
      if (String(ids[i]) !== String(ids[j])) {
        pairs.push(applicationDuplicates.sortedPair(ids[i], ids[j]));
      }
    }
  }
  return Promise.all(
    pairs.map(function save(pair) {
      return DuplicateDismissal.updateOne(
        { a: pair[0], b: pair[1] },
        { $setOnInsert: { a: pair[0], b: pair[1], by: req.user.id } },
        { upsert: true }
      );
    })
  )
    .then(function respond() {
      res.status(200).json({ dismissed: pairs.length });
    })
    .catch(function onError(err) {
      console.error("dismissDuplicates failed:", err);
      res.status(500).json({ error: "Could not save that." });
    });
}

module.exports = {
  removeApplication: removeApplication,
  restoreApplication: restoreApplication,
  searchApplications: searchApplications,
  compareApplications: compareApplications,
  mergeApplications: mergeApplications,
  listDuplicates: listDuplicates,
  dismissDuplicates: dismissDuplicates,
};
