"use strict";
// Copies applicant resumes from private storage into a folder, named like the
// dashboard's resume export (Name_abc123.pdf), plus index.csv.
// Runs on the server from the backend folder (it uses the backend's .env,
// schemas and storage helper):
//   cd /opt/hackdash/backend && node export-resumes.js <outDir> [--all] [--limit N]
// Default: accepted applicants with a resume. --all: every active application
// with a resume. Removed (duplicate/test) applications are never included.
require("dotenv").config();
var fs = require("fs");
var path = require("path");
var mongoose = require("mongoose");
var Application = require("./schemas/application");
var activeApplications = require("./utils/activeApplications");
var azureBlob = require("./utils/azureBlob");
var csv = require("./utils/csv");

var args = process.argv.slice(2);
var outDir = args.find(function positional(a) { return !a.startsWith("--") && !/^\d+$/.test(a); });
var all = args.includes("--all");
var limitAt = args.indexOf("--limit");
var limit = limitAt >= 0 ? Number(args[limitAt + 1]) : 0;
if (!outDir) {
  console.error("Usage: node export-resumes.js <outDir> [--all] [--limit N]");
  process.exit(2);
}

/** @param {object} a - Application. @returns {string} Safe, unique file name. */
function fileName(a) {
  var slug = String(a.name || "").normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  var ext = path.extname(String(a.resumeBlobName || "")).toLowerCase();
  if (!/^\.[a-z0-9]{1,5}$/.test(ext)) ext = ".bin";
  return (slug || "resume") + "_" + String(a._id).slice(-6) + ext;
}

/** @param {object} stream - Readable. @param {string} file - Destination. @returns {Promise<void>} */
function save(stream, file) {
  return new Promise(function write(resolve, reject) {
    var out = fs.createWriteStream(file);
    stream.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
    stream.pipe(out);
  });
}

(async function main() {
  if (!azureBlob.isAzureConfigured()) throw new Error("Resume storage is not configured on this server.");
  await mongoose.connect(process.env.MONGODB_URI);
  var filter = activeApplications.active({ resumeBlobName: { $exists: true, $nin: ["", null] } });
  if (!all) filter.status = "accepted";
  var query = Application.find(filter).select("name status education university major resumeBlobName").sort({ name: 1 }).lean();
  if (limit > 0) query = query.limit(limit);
  var apps = await query;
  fs.mkdirSync(path.join(outDir, "resumes"), { recursive: true });
  var index = [], saved = 0, missing = 0;
  for (var a of apps) {
    var name = fileName(a);
    var row = [a.name, a.status, a.education, a.university, a.major];
    try {
      var source = await azureBlob.downloadResume(a.resumeBlobName);
      if (!source) throw new Error("not found");
      await save(source, path.join(outDir, "resumes", name));
      index.push(row.concat(["resumes/" + name]));
      saved++;
    } catch (err) {
      index.push(row.concat(["(file not available)"]));
      missing++;
    }
    if ((saved + missing) % 50 === 0) console.error("  " + (saved + missing) + " / " + apps.length);
  }
  fs.writeFileSync(path.join(outDir, "index.csv"),
    csv.BOM + csv.formatRow(["Name", "Status", "Education level", "University", "Major", "File"]) + index.map(csv.formatRow).join(""));
  console.log(JSON.stringify({ applications: apps.length, saved: saved, missing: missing, scope: all ? "all" : "accepted" }));
  await mongoose.disconnect();
})().catch(function fail(err) {
  console.error("Export failed: " + err.message);
  process.exit(1);
});
