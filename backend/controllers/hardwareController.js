"use strict";

var Team = require("../schemas/team");
var settingsCache = require("../utils/orgSettingsCache");
var returnBy = require("../utils/hardwareReturnBy");
var mongoose = require("mongoose");
var Item = require("../schemas/hardwareItem");
var Checkout = require("../schemas/hardwareCheckout");
var Facility = require("../schemas/hardwareFacility");
var Application = require("../schemas/application");
var staff = require("./staffController");
var csv = require("../utils/csv");
var parseCsv = require("csv-parse/sync").parse;
var qrCode = require("../utils/qrCode");
var mailer = require("../utils/mailer");

/** @param {*} value - Candidate id. @returns {boolean} Whether it is an ObjectId. */
function validId(value) { return typeof value === "string" && mongoose.isValidObjectId(value); }
/** @param {object} res - Response. @param {Error} err - Failure. @returns {object} Error response. */
function failure(res, err) {
  if (err.name === "ValidationError" || err.name === "CastError" || err.input) return res.status(400).json({ error: err.message });
  console.error("Hardware request failed:", err);
  return res.status(500).json({ error: "Could not complete the hardware request." });
}
/** @param {string} message - Validation message. @returns {Error} Input failure. */
function invalid(message) { var err = new Error(message); err.input = true; return err; }
/** @param {object} body - Input. @param {boolean} partial - Patch mode. @returns {object} Validated inventory fields. */
function itemFields(body, partial) {
  var out = {};
  body = body || {};
  ["name", "category", "description", "link", "location", "imageUrl"].forEach(function field(key) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "string") throw invalid(key + " must be text.");
      out[key] = body[key].trim();
    }
  });
  if ((!partial || out.name !== undefined) && !out.name) throw invalid("Enter an item name.");
  ["link", "imageUrl"].forEach(function url(key) {
    if (out[key] && !/^https?:\/\/[^\s]+$/i.test(out[key])) throw invalid(key + " must be an http or https URL.");
  });
  ["totalQty", "maxPerAttendee"].forEach(function quantity(key) {
    if (body[key] !== undefined || !partial) {
      var n = body[key] === undefined && key === "maxPerAttendee" ? 1 : Number(body[key]);
      if (body[key] === "" || body[key] === null || typeof body[key] === "boolean" || !Number.isSafeInteger(n) || n < (key === "totalQty" ? 0 : 1) || n > 100000) throw invalid(key + " must be a whole number in range.");
      out[key] = n;
    }
  });
  if (body.trackUnits && body.trackUnits !== "false") throw invalid("Individual unit tracking is not enabled.");
  return out;
}
/** @param {object} user - Recipient. @param {object} item - Item. @param {object} loan - Loan. @param {string} key - Template key. @returns {void} */
function email(user, item, loan, key) {
  // Start outside the request promise; throttled SMTP must never hold the desk up.
  Promise.resolve().then(async function send() {
    var settings = await settingsCache.get();
    var fmt = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: process.env.EVENT_TIMEZONE || "America/New_York" });
    return mailer.sendTemplateEmail(user.email, key, {
      name: user.name, itemName: item.name, returnBy: returnBy(settings),
      dueTime: loan.dueAt ? fmt.format(new Date(loan.dueAt)) : "Return to the hardware desk before leaving the event.",
      eventTime: fmt.format(new Date(loan.returnedAt || loan.checkedOutAt))
    });
  }).catch(function mailError(err) { console.error("Hardware email failed:", err); });
}
/** @param {object} req - Request. @returns {Promise<boolean>} Attendee access. */
async function accepted(req) { return Boolean(await Application.exists({ applicant: req.user.id, status: "accepted" })); }

/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<object>} Inventory and facilities. */
async function inventory(req, res) {
  try {
    if (!req.hardwareStaff && !(await accepted(req))) return res.status(400).json({ error: "An accepted application is required." });
    var items = await Item.find({ archived: false }).sort({ name: 1 }).lean();
    var q = String(req.query.q || "").toLowerCase();
    items = items.filter(function match(item) {
      return (!req.query.category || item.category === req.query.category) && (!q || (String(item._id) + " " + item.name + " " + item.description).toLowerCase().includes(q));
    });
    return res.json({ items: items, facilities: await Facility.find({}).sort({ name: 1 }).lean() });
  } catch (err) { return failure(res, err); }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<object>} Own history only. */
async function mine(req, res) {
  try {
    if (!(await accepted(req))) return res.status(400).json({ error: "An accepted application is required." });
    var loans = await Checkout.find({ user: req.user.id }).select("item checkedOutAt dueAt returnedAt").populate("item", "name category location").sort({ checkedOutAt: -1 }).lean();
    return res.json({ checkouts: loans });
  } catch (err) { return failure(res, err); }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<object>} Staff history and borrower lookup. */
async function checkouts(req, res) {
  try {
    var filter = {};
    var attendee = null;
    if (req.query.qrId || req.query.userId) {
      var found = await staff.resolveAttendee(req.query);
      if (found.error) return res.status(found.status).json({ error: found.error });
      attendee = { id: found.user.id, name: found.application.name || found.user.name, email: found.user.email, checkedIn: Boolean(found.user.checkedIn) };
      filter.user = found.user._id;
    }
    if (req.query.itemId) {
      if (!validId(req.query.itemId)) throw invalid("Invalid item id.");
      filter.item = req.query.itemId;
    }
    if (req.query.open === "1" || req.query.overdue === "1") filter.returnedAt = null;
    if (req.query.overdue === "1") filter.dueAt = { $lt: new Date(), $ne: null };
    var loans = await Checkout.find(filter).populate("user", "name email").populate("item", "name location").sort({ dueAt: 1, checkedOutAt: -1 }).lean();
    var ids = loans.filter(function hasUser(loan) { return loan.user; }).map(function borrower(loan) { return loan.user._id; });
    if (attendee) ids.push(attendee.id);
    var teams = await Team.find({ members: { $in: ids } }).select("name members").lean();
    var byUser = {};
    teams.forEach(function mapTeam(team) { team.members.forEach(function member(id) { byUser[String(id)] = { id: String(team._id), name: team.name }; }); });
    loans.forEach(function describe(loan) {
      var snapshot = loan.team ? { id: String(loan.team), name: loan.teamName || "Deleted team" } : null;
      loan.currentTeam = loan.user ? byUser[String(loan.user._id)] || null : null;
      loan.teamChanged = String(snapshot && snapshot.id) !== String(loan.currentTeam && loan.currentTeam.id);
      loan.team = snapshot;
    });
    if (attendee) attendee.team = byUser[String(attendee.id)] || null;
    // Missing deadlines follow dated loans; overdue loans naturally sort first.
    loans.sort(function dueFirst(a, b) { return (a.dueAt ? new Date(a.dueAt).getTime() : Infinity) - (b.dueAt ? new Date(b.dueAt).getTime() : Infinity); });
    return res.json({ checkouts: loans, attendee: attendee });
  } catch (err) { return failure(res, err); }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<object>} Created loan. */
async function checkout(req, res) {
  var stock = null;
  var loan = null;
  try {
    var body = req.body || {};
    if (!validId(body.itemId)) throw invalid("Select an item.");
    if (body.unitId) throw invalid("Individual unit tracking is not enabled.");
    var settings = await settingsCache.get();
    var defaultDue = settings && settings.hardwareReturnBy;
    var dueAt = body.dueAt ? new Date(body.dueAt) : null;
    if (dueAt && (!Number.isFinite(dueAt.getTime()) || dueAt <= new Date())) throw invalid("Return deadline must be in the future.");
    if (!dueAt && defaultDue && new Date(defaultDue) > new Date()) dueAt = new Date(defaultDue);
    if (body.notes !== undefined && (typeof body.notes !== "string" || body.notes.length > 4000)) throw invalid("Notes must be at most 4000 characters.");
    var found = await staff.resolveAttendee(body);
    if (found.error) return res.status(found.status).json({ error: found.error });
    if (!found.user.checkedIn) return res.status(400).json({ error: "Attendee is not checked in to the event." });
    var team = await Team.findOne({ members: found.user._id }).select("name");
    var item = await Item.findOne({ _id: body.itemId, archived: false });
    if (!item) return res.status(404).json({ error: "Item not found." });
    var open = await Checkout.countDocuments({ user: found.user._id, item: item._id, returnedAt: null });
    if (open >= item.maxPerAttendee) return res.status(409).json({ error: "Attendee limit reached." });
    stock = await Item.findOneAndUpdate({ _id: item._id, archived: false, maxPerAttendee: item.maxPerAttendee, availableQty: { $gt: 0 } }, { $inc: { availableQty: -1 } }, { new: true });
    if (!stock) return res.status(409).json({ error: "Item is out of stock or inventory changed. Refresh and try again." });
    for (var slot = 0; slot < item.maxPerAttendee; slot += 1) {
      try {
        loan = await Checkout.create({ team: team ? team._id : null, teamName: team ? team.name : "", user: found.user._id, item: item._id, checkedOutBy: req.user.id, dueAt: dueAt, notes: body.notes || "", slot: slot });
        break;
      } catch (err) { if (err.code !== 11000) throw err; }
    }
    if (!loan) {
      await Item.updateOne({ _id: item._id }, { $inc: { availableQty: 1 } });
      stock = null;
      return res.status(409).json({ error: "Attendee limit reached." });
    }
    email(found.user, item, loan, "hardware_checkout");
    return res.status(201).json({ checkout: Object.assign(loan.toObject(), { team: team ? { id: team.id, name: team.name } : null }) });
  } catch (err) {
    if (stock && !loan) {
      try { await Item.updateOne({ _id: stock._id }, { $inc: { availableQty: 1 } }); }
      catch (restoreError) { console.error("Hardware stock restoration failed:", restoreError); }
    }
    return failure(res, err);
  }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<object>} Idempotent return. */
async function returnCheckout(req, res) {
  try {
    if (!validId(req.params.id)) throw invalid("Invalid checkout id.");
    var loan = await Checkout.findOneAndUpdate({ _id: req.params.id, returnedAt: null }, { $set: { returnedAt: new Date(), returnedTo: req.user.id } }, { new: true });
    if (!loan) {
      var existing = await Checkout.findById(req.params.id);
      return existing ? res.json({ checkout: existing, alreadyReturned: true }) : res.status(404).json({ error: "Checkout not found." });
    }
    try { await Item.updateOne({ _id: loan.item }, { $inc: { availableQty: 1 } }); }
    catch (err) {
      await Checkout.updateOne({ _id: loan._id, returnedAt: loan.returnedAt }, { $set: { returnedAt: null, returnedTo: null } });
      throw err;
    }
    var populated = await Checkout.findById(loan._id).populate("user", "name email").populate("item");
    if (populated.user && populated.item) email(populated.user, populated.item, loan, "hardware_return");
    return res.json({ checkout: loan, alreadyReturned: false });
  } catch (err) { return failure(res, err); }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<object>} Saved inventory. */
async function saveItem(req, res) {
  try {
    var fields = itemFields(req.body, Boolean(req.params.id));
    if (!req.params.id) {
      fields.availableQty = fields.totalQty;
      return res.status(201).json({ item: await Item.create(fields) });
    }
    if (!validId(req.params.id)) throw invalid("Invalid item id.");
    var item = await Item.findOne({ _id: req.params.id, archived: false });
    if (!item) return res.status(404).json({ error: "Item not found." });
    var delta = fields.totalQty === undefined ? 0 : fields.totalQty - item.totalQty;
    if (item.availableQty + delta < 0) throw invalid("Total stock cannot be lower than the quantity on loan.");
    if (fields.maxPerAttendee !== undefined && fields.maxPerAttendee !== item.maxPerAttendee && (item.availableQty !== item.totalQty || await Checkout.exists({ item: item._id, returnedAt: null }))) throw invalid("Return all loans before changing the attendee limit.");
    var updated = await Item.findOneAndUpdate({ _id: item._id, archived: false, availableQty: item.availableQty, totalQty: item.totalQty, maxPerAttendee: item.maxPerAttendee }, { $set: fields, $inc: { availableQty: delta } }, { new: true, runValidators: true });
    if (!updated) return res.status(409).json({ error: "Inventory changed. Refresh and try again." });
    return res.json({ item: updated });
  } catch (err) { return failure(res, err); }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<object>} Archived inventory. */
async function deleteItem(req, res) {
  try {
    if (!validId(req.params.id)) throw invalid("Invalid item id.");
    // Atomic with checkout stock updates: only an item entirely on the shelf can be archived.
    var item = await Item.findOneAndUpdate({ _id: req.params.id, archived: false, $expr: { $eq: ["$availableQty", "$totalQty"] } }, { $set: { archived: true } });
    if (!item) return res.status(409).json({ error: "Item is missing, archived or still on loan." });
    return res.json({ archived: true });
  } catch (err) { return failure(res, err); }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<object>} CSV preview or imported inventory. */
async function importItems(req, res) {
  try {
    if (!req.body || typeof req.body.csv !== "string" || req.body.csv.length > 500000) throw invalid("Provide a CSV file under 500 KB.");
    var rows;
    try { rows = parseCsv(req.body.csv, { columns: true, bom: true, skip_empty_lines: true, trim: true }); }
    catch (_err) { throw invalid("CSV could not be parsed. Check quoting and columns."); }
    if (!rows.length || rows.length > 1000) throw invalid("CSV must contain 1 to 1000 items.");
    var fields = rows.map(function validate(row) { return itemFields(row, false); });
    // Validate the whole batch before any write.
    for (var row of fields) await new Item(Object.assign({}, row, { availableQty: row.totalQty })).validate();
    if (req.body.preview !== false) return res.json({ items: fields, preview: true });
    var items = await Item.insertMany(fields.map(function stock(row) { return Object.assign({}, row, { availableQty: row.totalQty }); }));
    return res.status(201).json({ items: items });
  } catch (err) { return failure(res, err); }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<void>} CSV file. */
async function exportCsv(req, res) {
  var inventoryExport = req.query.kind === "inventory";
  var last = null;
  return csv.sendCsv(res, {
    filename: csv.datedFilename(inventoryExport ? "hardware-inventory" : "hardware-checkouts", "csv"),
    header: inventoryExport ? ["name", "category", "description", "link", "location", "imageUrl", "totalQty", "availableQty", "maxPerAttendee"] : ["item", "name", "email", "team", "checkedOutAt", "dueAt", "returnedAt", "notes"],
    nextRows: async function nextRows() {
      var filter = last ? { _id: { $gt: last } } : {};
      var rows = inventoryExport ? await Item.find(filter).sort({ _id: 1 }).limit(250).lean() : await Checkout.find(filter).populate("item", "name").populate("user", "name email").sort({ _id: 1 }).limit(250).lean();
      if (rows.length) last = rows[rows.length - 1]._id;
      return rows.map(function cells(row) {
        return inventoryExport ? [row.name, row.category, row.description, row.link, row.location, row.imageUrl, row.totalQty, row.availableQty, row.maxPerAttendee] : [row.item && row.item.name, row.user && row.user.name, row.user && row.user.email, row.teamName || "", row.checkedOutAt, row.dueAt, row.returnedAt, row.notes];
      });
    }
  });
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<object>} Printable label data. */
async function labels(req, res) {
  try {
    var items = await Item.find({ archived: false }).sort({ name: 1 }).lean();
    var labels = [];
    for (var item of items) labels.push({ id: item._id, name: item.name, location: item.location, qr: await qrCode.toDataUrl("hardware:" + item._id) });
    return res.json({ labels: labels });
  } catch (err) { return failure(res, err); }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<object>} Queued reminder count. */
async function remind(req, res) {
  try {
    var filter = { returnedAt: null };
    if (req.body && req.body.itemId) {
      if (!validId(req.body.itemId)) throw invalid("Invalid item id.");
      filter.item = req.body.itemId;
    }
    var loans = await Checkout.find(filter).populate("user", "name email").populate("item");
    loans.forEach(function send(loan) { if (loan.user && loan.item) email(loan.user, loan.item, loan, "hardware_reminder"); });
    return res.status(202).json({ queued: loans.length });
  } catch (err) { return failure(res, err); }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<object>} Saved facility. */
async function saveFacility(req, res) {
  try {
    var body = req.body || {};
    var fields = {};
    ["name", "location", "accessNotes"].forEach(function field(key) {
      if (body[key] !== undefined) {
        if (typeof body[key] !== "string") throw invalid(key + " must be text.");
        fields[key] = body[key].trim();
      }
    });
    if ((!req.params.id || fields.name !== undefined) && !fields.name) throw invalid("Enter a facility name.");
    if (!req.params.id) return res.status(201).json({ facility: await Facility.create(fields) });
    if (!validId(req.params.id)) throw invalid("Invalid facility id.");
    var facility = await Facility.findByIdAndUpdate(req.params.id, { $set: fields }, { new: true, runValidators: true });
    return facility ? res.json({ facility: facility }) : res.status(404).json({ error: "Facility not found." });
  } catch (err) { return failure(res, err); }
}
/** @param {object} req - Request. @param {object} res - Response. @returns {Promise<object>} Removed facility. */
async function deleteFacility(req, res) {
  try {
    if (!validId(req.params.id)) throw invalid("Invalid facility id.");
    var facility = await Facility.findByIdAndDelete(req.params.id);
    return facility ? res.json({ deleted: true }) : res.status(404).json({ error: "Facility not found." });
  } catch (err) { return failure(res, err); }
}
module.exports = { inventory: inventory, mine: mine, checkouts: checkouts, checkout: checkout, returnCheckout: returnCheckout, saveItem: saveItem, deleteItem: deleteItem, importItems: importItems, exportCsv: exportCsv, labels: labels, remind: remind, saveFacility: saveFacility, deleteFacility: deleteFacility };
