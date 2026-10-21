"use strict";

var path = require("path");

var Application = require("../schemas/application");
var ApplicationRound = require("../schemas/applicationRound");
var CheckIn = require("../schemas/checkin");
var MealService = require("../schemas/mealService");
var MealCheckIn = require("../schemas/mealCheckin");
var User = require("../schemas/user");
var applicationScope = require("../utils/applicationScope");
var azureBlob = require("../utils/azureBlob");
var csv = require("../utils/csv");
var zipStream = require("../utils/zipStream");

// Admin data exports (mounted at /api/admin/exports behind isAdmin). They hold
// personal data, so they are admin-only, never cached, and never include
// password hashes, tokens or resume blob names. Big collections are read in
// batches by _id and written to the response as they go, so memory stays flat
// however many applicants there are (and no long-lived database cursor is held
// open while a slow download drains).

// Documents read per round trip.
var BATCH_SIZE = 500;

/**
 * Read a collection in _id order, one batch per call.
 * @param {object} model - Mongoose model.
 * @param {object} filter - Query filter (must not constrain _id).
 * @param {string} select - Fields to load; nothing else is read.
 * @returns {function(): Promise<Array<object>>} Next batch of plain documents;
 *   an empty list once everything has been read.
 */
function batchReader(model, filter, select) {
  var lastId = null;
  var finished = false;

  return function nextBatch() {
    if (finished) {
      return Promise.resolve([]);
    }
    var query = Object.assign({}, filter);
    if (lastId) {
      query._id = { $gt: lastId };
    }
    return model
      .find(query)
      .select(select)
      .sort({ _id: 1 })
      .limit(BATCH_SIZE)
      .lean()
      .then(function afterFind(docs) {
        if (docs.length < BATCH_SIZE) {
          finished = true;
        }
        if (docs.length) {
          lastId = docs[docs.length - 1]._id;
        }
        return docs;
      });
  };
}

/**
 * Wrap a batch reader as the row source csv.sendCsv wants.
 * @param {function(): Promise<Array<object>>} nextBatch - From batchReader.
 * @param {function(Array<object>): Promise<Array<Array>>} toRows - Turns a
 *   batch into CSV rows (one row per document, so a batch is never empty).
 * @returns {function(): Promise<Array<Array>>}
 */
function csvRows(nextBatch, toRows) {
  return function nextRows() {
    return nextBatch().then(function afterBatch(docs) {
      return docs.length ? toRows(docs) : [];
    });
  };
}

/**
 * Index users by id.
 * @param {Array<*>} ids - User ids (duplicates and nulls are fine).
 * @param {string} select - User fields to load.
 * @returns {Promise<object>} Map of id string to plain user.
 */
function usersById(ids, select) {
  var unique = [];
  var seen = {};
  ids.forEach(function add(id) {
    if (id && !seen[String(id)]) {
      seen[String(id)] = true;
      unique.push(id);
    }
  });
  if (!unique.length) {
    return Promise.resolve({});
  }
  return User.find({ _id: { $in: unique } })
    .select(select)
    .lean()
    .then(function toMap(users) {
      var map = {};
      users.forEach(function add(user) {
        map[String(user._id)] = user;
      });
      return map;
    });
}

/**
 * @param {*} value - Any truthy/falsy value.
 * @returns {string} "Yes" or "No".
 */
function yesNo(value) {
  return value ? "Yes" : "No";
}

/**
 * How one custom answer reads in a cell: checkboxes Yes/No, lists joined.
 * @param {*} value - Stored answer.
 * @returns {*} A value csv.formatCell accepts.
 */
function answerCell(value) {
  if (value === true) return "Yes";
  if (value === false) return "No";
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return JSON.stringify(value);
  return value;
}

// The fixed columns of the applications export, in order. Each `value`
// reads one application (with its user, and its round's name).
var APPLICATION_COLUMNS = [
  { header: "Round", value: function (a, ctx) { return ctx.roundName; } },
  { header: "Status", value: function (a) { return a.status; } },
  { header: "Name", value: function (a, ctx) { return a.name || (ctx.user && ctx.user.name); } },
  { header: "Email", value: function (a, ctx) { return ctx.user && ctx.user.email; } },
  { header: "Phone", value: function (a) { return a.phone; } },
  { header: "Age", value: function (a) { return a.age; } },
  { header: "Gender", value: function (a) { return a.gender; } },
  { header: "Pronouns", value: function (a) { return a.pronouns; } },
  { header: "Education level", value: function (a) { return a.education; } },
  { header: "University", value: function (a) { return a.university; } },
  { header: "Major", value: function (a) { return a.major; } },
  { header: "Dietary restrictions / allergies", value: function (a) { return a.allergies; } },
  { header: "T-shirt size", value: function (a) { return a.tshirtSize; } },
  { header: "Programming skills", value: function (a) { return a.programmingSkills; } },
  { header: "Hardware skills", value: function (a) { return a.hardwareSkills; } },
  { header: "Other skills", value: function (a) { return a.otherSkills; } },
  { header: "LinkedIn", value: function (a) { return a.socials && a.socials.linkedin; } },
  { header: "GitHub", value: function (a) { return a.socials && a.socials.github; } },
  { header: "Website", value: function (a) { return a.socials && a.socials.website; } },
  {
    header: "Other links",
    value: function (a) {
      return ((a.socials && a.socials.other) || []).map(function toText(link) {
        return (link.label ? link.label + ": " : "") + (link.url || "");
      });
    },
  },
  { header: "Attended hackathons before", value: function (a) { return yesNo(a.experience && a.experience.attendedBefore); } },
  { header: "Hackathons attended", value: function (a) { return a.experience && a.experience.hackathonsAttended; } },
  { header: "Attended this event before", value: function (a) { return yesNo(a.experience && a.experience.attendedThisBefore); } },
  { header: "Has resume", value: function (a) { return yesNo(a.resumeBlobName); } },
  { header: "Checked in", value: function (a, ctx) { return yesNo(ctx.user && ctx.user.checkedIn); } },
  { header: "Created", value: function (a) { return a.createdAt; } },
  { header: "Last updated", value: function (a) { return a.updatedAt; } },
];

// Application fields the export reads. resumeBlobName is only used to say
// whether there is a resume; the name itself is never written out.
var APPLICATION_SELECT =
  "applicant round status name phone age gender pronouns education university major allergies tshirtSize " +
  "resumeBlobName socials experience programmingSkills hardwareSkills otherSkills answers createdAt updatedAt";

/**
 * The custom-question columns for a set of rounds: one per distinct question
 * key (a later round's wording wins), headed by its label. File uploads are
 * left out (the resume is not exported here), and a label that repeats a
 * built-in column or another question gets its key added so headings stay
 * unique.
 * @param {Array<object>} rounds - Rounds with a formConfig.
 * @param {Array<string>} taken - Headings already in use.
 * @returns {Array<{key: string, header: string}>}
 */
function customColumns(rounds, taken) {
  var byKey = {};
  var order = [];
  rounds.forEach(function eachRound(round) {
    (Array.isArray(round.formConfig) ? round.formConfig : []).forEach(function eachField(field) {
      if (!field || typeof field.key !== "string" || !field.key || field.type === "resume") {
        return;
      }
      if (!Object.prototype.hasOwnProperty.call(byKey, field.key)) {
        order.push(field.key);
      }
      byKey[field.key] = applicationScope.plainLabel(field.label || field.key);
    });
  });

  var used = {};
  taken.forEach(function mark(header) {
    used[header.toLowerCase()] = true;
  });
  return order.map(function toColumn(key) {
    var header = byKey[key];
    if (used[header.toLowerCase()]) {
      header = header + " (" + key + ")";
    }
    used[header.toLowerCase()] = true;
    return { key: key, header: header };
  });
}

/**
 * GET /api/admin/exports/applications.csv[?round=<id>][&status=<status>]
 * Every submitted application (drafts only with ?status=draft), with the
 * round's custom answers as extra columns.
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function exportApplications(req, res) {
  var scope = applicationScope.parseScope(req.query);
  if (scope.error) {
    res.status(400).json({ error: scope.error });
    return Promise.resolve();
  }

  return ApplicationRound.find({})
    .select("name formConfig")
    .sort({ order: 1, createdAt: 1 })
    .lean()
    .then(function afterRounds(rounds) {
      var roundNames = {};
      rounds.forEach(function name(round) {
        roundNames[String(round._id)] = round.name;
      });
      var formRounds = scope.round
        ? rounds.filter(function inScope(round) {
            return String(round._id) === scope.round;
          })
        : rounds;

      var fixedHeaders = APPLICATION_COLUMNS.map(function toHeader(column) {
        return column.header;
      });
      var custom = customColumns(formRounds, fixedHeaders);

      function toRows(applications) {
        return usersById(
          applications.map(function toApplicant(a) {
            return a.applicant;
          }),
          "name email checkedIn"
        ).then(function afterUsers(users) {
          return applications.map(function toRow(application) {
            var ctx = {
              user: users[String(application.applicant)],
              roundName: application.round ? roundNames[String(application.round)] || "" : "",
            };
            var answers = application.answers && typeof application.answers === "object" ? application.answers : {};
            return APPLICATION_COLUMNS.map(function fixed(column) {
              return column.value(application, ctx);
            }).concat(
              custom.map(function answer(column) {
                return answerCell(answers[column.key]);
              })
            );
          });
        });
      }

      return csv.sendCsv(res, {
        filename: csv.datedFilename("applications", "csv"),
        header: fixedHeaders.concat(
          custom.map(function toHeader(column) {
            return column.header;
          })
        ),
        nextRows: csvRows(batchReader(Application, scope.match, APPLICATION_SELECT), toRows),
      });
    })
    .catch(function onError(err) {
      console.error("exportApplications failed:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Could not build the export." });
      }
    });
}

/**
 * GET /api/admin/exports/checkins.csv
 * Everyone who has checked in to the event: when, who scanned them, and the
 * reason for any forced check-in.
 * @param {object} _req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function exportCheckIns(_req, res) {
  function toRows(checkIns) {
    var ids = [];
    checkIns.forEach(function collect(checkIn) {
      ids.push(checkIn.user, checkIn.checkedInBy);
    });
    return usersById(ids, "name email").then(function afterUsers(users) {
      return checkIns.map(function toRow(checkIn) {
        var attendee = users[String(checkIn.user)] || {};
        var staff = users[String(checkIn.checkedInBy)] || {};
        return [
          attendee.name,
          attendee.email,
          checkIn.checkedInAt,
          staff.name,
          yesNo(checkIn.forced),
          checkIn.forcedReason,
          checkIn.applicationStatus,
        ];
      });
    });
  }

  return csv.sendCsv(res, {
    filename: csv.datedFilename("check-ins", "csv"),
    header: ["Name", "Email", "Checked in at", "Checked in by", "Forced check-in", "Forced reason", "Application status at check-in"],
    nextRows: csvRows(batchReader(CheckIn, {}, "user checkedInAt checkedInBy forced forcedReason applicationStatus"), toRows),
  });
}

/**
 * GET /api/admin/exports/meals.csv
 * Every meal service with how many attendees were served (for catering).
 * @param {object} _req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function exportMeals(_req, res) {
  var sent = false;

  function nextRows() {
    if (sent) {
      return Promise.resolve([]);
    }
    sent = true;
    return Promise.all([
      MealService.find({}).select("name createdFor startsAt endsAt active").sort({ startsAt: 1, createdAt: 1 }).lean(),
      MealCheckIn.countsByMeal(),
    ]).then(function toRows(results) {
      return results[0].map(function toRow(meal) {
        return [meal.name, meal.createdFor, meal.startsAt, meal.endsAt, yesNo(meal.active), results[1][String(meal._id)] || 0];
      });
    });
  }

  return csv.sendCsv(res, {
    filename: csv.datedFilename("meals", "csv"),
    header: ["Meal", "Only for (email)", "Starts", "Ends", "Active", "Served"],
    nextRows: nextRows,
  });
}

/**
 * A file-system-safe name for a resume inside the bundle: the applicant's
 * name (ASCII letters and digits only) plus a short id so two applicants with
 * the same name never collide.
 * @param {object} application - { _id, name, resumeBlobName }.
 * @returns {string} e.g. "Ada-Lovelace_3f9a1c.pdf"
 */
function resumeFileName(application) {
  var slug = String(application.name || "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  var extension = path.extname(String(application.resumeBlobName || "")).toLowerCase();
  if (!/^\.[a-z0-9]{1,5}$/.test(extension)) {
    extension = ".bin";
  }
  return (slug || "resume") + "_" + String(application._id).slice(-6) + extension;
}

/**
 * GET /api/admin/exports/resumes.zip?consentKey=<key>[&round=<id>]
 *
 * A ZIP of the resumes of accepted applicants who agreed to share them with
 * sponsors, plus an index.csv (name, education, university, major, file).
 * "Agreed" means they ticked a checkbox question on the application form;
 * `consentKey` is that question's key. Nobody is included without it, so a
 * missing or wrong key never exports more than intended. Resumes are streamed
 * from private storage one at a time.
 *
 * @param {object} req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function exportResumes(req, res) {
  var consentKey = req.query && req.query.consentKey ? String(req.query.consentKey).trim() : "";
  var round = req.query && req.query.round ? String(req.query.round) : "";

  if (!consentKey) {
    res.status(400).json({
      error: "consentKey is required: the key of the checkbox question applicants tick to share their resume with sponsors.",
    });
    return Promise.resolve();
  }
  // `round` is validated by parseScope; its status limit is replaced below.
  var scope = applicationScope.parseScope({ round: round });
  if (scope.error) {
    res.status(400).json({ error: scope.error });
    return Promise.resolve();
  }
  if (!azureBlob.isAzureConfigured()) {
    res.status(501).json({ error: "Resume storage is not configured yet." });
    return Promise.resolve();
  }

  return ApplicationRound.find(round ? { _id: round } : {})
    .select("formConfig")
    .lean()
    .then(function afterRounds(rounds) {
      var isConsentQuestion = rounds.some(function hasQuestion(r) {
        return (Array.isArray(r.formConfig) ? r.formConfig : []).some(function matches(field) {
          return field && field.key === consentKey && field.type === "checkbox";
        });
      });
      // Only a real checkbox question's key reaches the query below, so it
      // can't be used to probe other fields.
      if (!isConsentQuestion || !/^[A-Za-z0-9_-]+$/.test(consentKey)) {
        res.status(400).json({ error: "consentKey must be the key of a checkbox question on the application form." });
        return undefined;
      }

      var filter = { status: "accepted", resumeBlobName: { $exists: true, $nin: ["", null] } };
      filter["answers." + consentKey] = true;
      if (scope.round) {
        filter.round = scope.match.round;
      }
      var nextBatch = batchReader(Application, filter, "name education university major resumeBlobName");

      return nextBatch().then(function afterFirst(first) {
        if (!first.length) {
          res.status(404).json({ error: "No accepted applicants with a resume have agreed to share it." });
          return undefined;
        }
        return writeResumeZip(res, first, nextBatch);
      });
    })
    .catch(function onError(err) {
      console.error("exportResumes failed:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Could not build the resume bundle." });
      } else {
        res.destroy(err);
      }
    });
}

/**
 * Stream the resume bundle: each resume, then index.csv.
 * @param {object} res - Express response.
 * @param {Array<object>} first - First batch of applications.
 * @param {function(): Promise<Array<object>>} nextBatch - Reader for the rest.
 * @returns {Promise<void>}
 */
async function writeResumeZip(res, first, nextBatch) {
  csv.setDownloadHeaders(res, "application/zip", csv.datedFilename("resumes", "zip"));
  var zip = zipStream.createZipWriter(res);
  var index = [];

  var batch = first;
  while (batch.length) {
    for (var i = 0; i < batch.length; i++) {
      var application = batch[i];
      var fileName = resumeFileName(application);
      var row = [application.name, application.education, application.university, application.major];
      var source = null;
      try {
        source = await azureBlob.downloadResume(application.resumeBlobName);
      } catch (err) {
        // A missing blob must not sink the whole bundle; say so in the index.
        console.error("Resume export skipped " + String(application._id) + ":", err.message);
      }
      if (!source) {
        index.push(row.concat(["(file not available)"]));
        continue;
      }
      // A failure from here on leaves a half-written entry, so it ends the download.
      await zip.addStream("resumes/" + fileName, source);
      index.push(row.concat(["resumes/" + fileName]));
    }
    batch = await nextBatch();
  }

  var indexText =
    csv.BOM + csv.formatRow(["Name", "Education level", "University", "Major", "File"]) + index.map(csv.formatRow).join("");
  await zip.addBuffer("index.csv", indexText);
  await zip.finish();
}

module.exports = {
  exportApplications: exportApplications,
  exportCheckIns: exportCheckIns,
  exportMeals: exportMeals,
  exportResumes: exportResumes,
  resumeFileName: resumeFileName,
};
