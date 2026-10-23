"use strict";

var express = require("express");
var controller = require("../controllers/hardwareController");
var requireFeature = require("../utils/requireFeature");
var isAuthenticated = require("../utils/isAuthenticated");
var isModerator = require("../utils/isModerator");
var isAdmin = require("../utils/isAdmin");
var attendee = express.Router();
var staff = express.Router();
var admin = express.Router();

/** @param {object} req - Request. @param {object} res - Response. @param {function} next - Next middleware. @returns {void} */
function staffInventory(req, res, next) { req.hardwareStaff = true; next(); }

attendee.use(requireFeature("hardware"), isAuthenticated);
attendee.get("/", controller.inventory);
attendee.get("/mine", controller.mine);
staff.use(requireFeature("hardware"), isAuthenticated, isModerator, staffInventory);
staff.get("/", controller.inventory);
staff.get("/checkouts", controller.checkouts);
staff.post("/checkouts", controller.checkout);
staff.post("/checkouts/:id/return", controller.returnCheckout);
staff.get("/export.csv", controller.exportCsv);
staff.post("/reminders", controller.remind);
admin.use(requireFeature("hardware"), isAuthenticated, isAdmin, staffInventory);
admin.get("/", controller.inventory);
admin.post("/items", controller.saveItem);
admin.patch("/items/:id", controller.saveItem);
admin.delete("/items/:id", controller.deleteItem);
admin.post("/import", controller.importItems);
admin.get("/labels", controller.labels);
admin.post("/facilities", controller.saveFacility);
admin.patch("/facilities/:id", controller.saveFacility);
admin.delete("/facilities/:id", controller.deleteFacility);
module.exports = { attendee: attendee, staff: staff, admin: admin };
