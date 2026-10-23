"use strict";

// A well-formed but fake storage account. Uploads, downloads and deletes are
// stubbed below, so nothing here touches the network.
process.env.AZURE_STORAGE_CONNECTION_STRING =
  "DefaultEndpointsProtocol=https;AccountName=testacct;AccountKey=" +
  Buffer.alloc(64, 7).toString("base64") +
  ";EndpointSuffix=core.windows.net";

var test = require("node:test");
var assert = require("node:assert/strict");
var request = require("supertest");

var db = require("./helpers/db");
var fixtures = require("./helpers/fixtures");
var app = require("../server");
var azureBlob = require("../utils/azureBlob");
var branding = require("../utils/branding");
var imageType = require("../utils/imageType");
var OrgSettings = require("../schemas/orgSettings");

var BRAND_ENV = [
  "BRAND_PRIMARY",
  "BRAND_SECONDARY",
  "BRAND_ACCENT",
  "BRAND_LOGO_URL",
  "BRAND_LOGO_DARK_URL",
  "BRAND_FAVICON_URL",
  "API_PUBLIC_URL",
];

// Smallest valid-looking files of each type (the checks only read the header).
var PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);
var JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
var WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(24)]);
var ICO = Buffer.concat([Buffer.from([0, 0, 1, 0, 1, 0]), Buffer.alloc(32)]);
var SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>');

function as(who) {
  return { Authorization: "Bearer " + who.token };
}

function patch(admin, body) {
  return request(app).patch("/api/admin/settings").set(as(admin)).send(body);
}

function putImage(admin, slot, buffer, filename, contentType) {
  return request(app)
    .put("/api/admin/branding/" + slot)
    .set(as(admin))
    .attach("file", buffer, { filename: filename || "logo.png", contentType: contentType || "image/png" });
}

/**
 * Stand-in for Azure Blob Storage, scoped to one subtest.
 * @param {object} t - The subtest context.
 * @returns {{store: object, deleted: string[]}}
 */
function fakeStorage(t) {
  var state = { store: {}, deleted: [] };
  t.mock.method(azureBlob, "uploadBrandingImage", function upload(name, buffer, contentType) {
    state.store[name] = { buffer: buffer, contentType: contentType };
    return Promise.resolve();
  });
  t.mock.method(azureBlob, "downloadBrandingImage", function download(name) {
    return Promise.resolve(state.store[name] ? state.store[name].buffer : null);
  });
  t.mock.method(azureBlob, "deleteBrandingImage", function remove(name) {
    state.deleted.push(name);
    delete state.store[name];
    return Promise.resolve();
  });
  return state;
}

/**
 * Set env vars for one subtest and restore them afterwards.
 * @param {object} t - The subtest context.
 * @param {object} vars - name -> value (undefined deletes it).
 * @returns {void}
 */
function withEnv(t, vars) {
  var saved = {};
  Object.keys(vars).forEach(function each(name) {
    saved[name] = process.env[name];
    if (vars[name] === undefined) delete process.env[name];
    else process.env[name] = vars[name];
  });
  t.after(function restore() {
    Object.keys(saved).forEach(function each(name) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    });
  });
}

test("B28: runtime branding", async function runtimeBranding(t) {
  BRAND_ENV.forEach(function clean(name) {
    delete process.env[name];
  });

  // ---- Pure validators ------------------------------------------------------

  await t.test("colours must be exactly #RRGGBB", function () {
    ["#4f46e5", "#4F46E5", "#000000", "#ffffff"].forEach(function (ok) {
      assert.equal(branding.isHexColor(ok), true, ok);
    });
    [
      "",
      "4f46e5",
      "#4f46e",
      "#4f46e55",
      "#4f46e5ff",
      "#fff",
      "#gggggg",
      "red",
      "rgb(1,2,3)",
      "#4f46e5;background:url(//evil)",
      "#4f46e5\n",
      " #4f46e5",
      "var(--x)",
      "url(x)",
      null,
      undefined,
      123456,
      {},
      ["#4f46e5"],
    ].forEach(function (bad) {
      assert.equal(branding.isHexColor(bad), false, JSON.stringify(bad));
    });
  });

  await t.test("URLs must be plain http(s) with no credentials", function () {
    assert.equal(branding.cleanUrl("https://cdn.example.com/logo.png", false), "https://cdn.example.com/logo.png");
    assert.equal(branding.cleanUrl("http://localhost:9000/l.png", true), "http://localhost:9000/l.png");
    assert.equal(branding.cleanUrl("http://cdn.example.com/l.png", false), null, "admins must use https");
    [
      "javascript:alert(1)",
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      "file:///etc/passwd",
      "//cdn.example.com/x.png",
      "/logo.png",
      "https://user:pass@cdn.example.com/x.png",
      "https://cdn.example.com/a b.png",
      "https://",
      "ftp://x.example.com/a.png",
      "https://x.example.com/" + "a".repeat(2100),
      "",
      null,
      42,
    ].forEach(function (bad) {
      assert.equal(branding.cleanUrl(bad, true), null, JSON.stringify(bad).slice(0, 60));
    });
  });

  await t.test("image types are read from the bytes", function () {
    assert.equal(imageType.sniff(PNG), "png");
    assert.equal(imageType.sniff(JPEG), "jpg");
    assert.equal(imageType.sniff(WEBP), "webp");
    assert.equal(imageType.sniff(ICO), "ico");
    assert.equal(imageType.sniff(SVG), null, "SVG is never accepted");
    assert.equal(imageType.sniff(Buffer.from("<html><script>alert(1)</script></html>")), null);
    assert.equal(imageType.sniff(Buffer.from("GIF89a" + "x".repeat(20))), null);
    assert.equal(imageType.sniff(Buffer.alloc(0)), null);
    assert.equal(imageType.sniff(Buffer.alloc(8)), null);
    assert.equal(imageType.sniff(Buffer.concat([Buffer.from([0, 0, 1, 0, 0, 0]), Buffer.alloc(16)])), null, "ICO with no images");
    assert.equal(imageType.mimeFor("png"), "image/png");
    assert.equal(imageType.mimeFor("svg"), null);
    assert.equal(imageType.mimeFor("constructor"), null);
  });

  await db.connect();

  // ---- GET /api/meta/branding -----------------------------------------------

  await t.test("public, no auth, with defaults when nothing is configured", async function () {
    await db.clearDatabase();
    var res = await request(app).get("/api/meta/branding");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.branding, {
      orgName: "Test Org",
      primaryColor: "#4f46e5",
      secondaryColor: "#64748b",
      accentColor: null,
      logoUrl: null,
      logoDarkUrl: null,
      faviconUrl: null,
    });
    assert.equal(res.body.features.meals, true);
  });

  await t.test("cacheable for about 60 seconds, and revalidates with an ETag", async function () {
    await db.clearDatabase();
    var res = await request(app).get("/api/meta/branding");
    assert.equal(res.headers["cache-control"], "public, max-age=60");
    assert.ok(res.headers.etag, "has an ETag");
    var again = await request(app).get("/api/meta/branding").set("If-None-Match", res.headers.etag);
    assert.equal(again.status, 304);
  });

  await t.test("reading branding never writes to the database", async function (t2) {
    await db.clearDatabase();
    t2.mock.method(OrgSettings, "findOneAndUpdate");
    t2.mock.method(OrgSettings, "updateOne");
    t2.mock.method(OrgSettings, "create");
    for (var i = 0; i < 3; i++) {
      assert.equal((await request(app).get("/api/meta/branding")).status, 200);
    }
    assert.equal(OrgSettings.findOneAndUpdate.mock.callCount(), 0, "no upsert on a public read");
    assert.equal(OrgSettings.updateOne.mock.callCount(), 0);
    assert.equal(OrgSettings.create.mock.callCount(), 0);
    assert.equal(await OrgSettings.countDocuments({}), 0);
  });

  await t.test("server env supplies the defaults, read at request time", async function (t2) {
    await db.clearDatabase();
    withEnv(t2, {
      BRAND_PRIMARY: "#112233",
      BRAND_SECONDARY: "#AABBCC",
      BRAND_ACCENT: "#ff8800",
      BRAND_LOGO_URL: "https://cdn.example.com/logo.png",
      BRAND_LOGO_DARK_URL: "https://cdn.example.com/logo-dark.png",
      BRAND_FAVICON_URL: "https://cdn.example.com/favicon.ico",
      ORG_NAME: "Env Hack",
    });
    var res = await request(app).get("/api/meta/branding");
    assert.deepEqual(res.body.branding, {
      orgName: "Env Hack",
      primaryColor: "#112233",
      secondaryColor: "#aabbcc",
      accentColor: "#ff8800",
      logoUrl: "https://cdn.example.com/logo.png",
      logoDarkUrl: "https://cdn.example.com/logo-dark.png",
      faviconUrl: "https://cdn.example.com/favicon.ico",
    });

    // Changing the env needs no restart: the same running app picks it up.
    process.env.BRAND_PRIMARY = "#0000ff";
    var next = await request(app).get("/api/meta/branding");
    assert.equal(next.body.branding.primaryColor, "#0000ff");
  });

  await t.test("a malformed server env value is ignored, never passed through", async function (t2) {
    await db.clearDatabase();
    t2.mock.method(console, "warn", function quiet() {});
    withEnv(t2, {
      BRAND_PRIMARY: "4f46e5",
      BRAND_SECONDARY: "red; background:url(//evil)",
      BRAND_ACCENT: "#fff",
      BRAND_LOGO_URL: "javascript:alert(1)",
      BRAND_FAVICON_URL: "data:image/svg+xml,<svg/>",
    });
    var res = await request(app).get("/api/meta/branding");
    assert.equal(res.body.branding.primaryColor, "#4f46e5");
    assert.equal(res.body.branding.secondaryColor, "#64748b");
    assert.equal(res.body.branding.accentColor, null);
    assert.equal(res.body.branding.logoUrl, null);
    assert.equal(res.body.branding.faviconUrl, null);
  });

  // ---- PATCH /api/admin/settings { branding } --------------------------------

  await t.test("admin settings override the env, and clearing a field falls back to it", async function (t2) {
    await db.clearDatabase();
    withEnv(t2, { BRAND_PRIMARY: "#112233" });
    var admin = await fixtures.createUser({ role: "admin" });

    var res = await patch(admin, {
      branding: { orgName: "  Fancy Hack  ", primaryColor: "#ABCDEF", secondaryColor: "#102030", accentColor: "#FF00AA" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.settings.branding.orgName, "Fancy Hack");
    assert.equal(res.body.settings.branding.primaryColor, "#abcdef", "colours are stored lower-case");
    assert.equal(res.body.effectiveBranding.primaryColor, "#abcdef");

    var pub = await request(app).get("/api/meta/branding");
    assert.equal(pub.body.branding.orgName, "Fancy Hack");
    assert.equal(pub.body.branding.primaryColor, "#abcdef");
    assert.equal(pub.body.branding.secondaryColor, "#102030");
    assert.equal(pub.body.branding.accentColor, "#ff00aa");

    // Partial update: other fields are kept.
    res = await patch(admin, { branding: { secondaryColor: "#000000" } });
    assert.equal(res.body.settings.branding.primaryColor, "#abcdef");
    assert.equal(res.body.settings.branding.secondaryColor, "#000000");

    // "" and null clear a field back to env / default.
    res = await patch(admin, { branding: { primaryColor: "", accentColor: null, orgName: "" } });
    assert.equal(res.status, 200);
    pub = await request(app).get("/api/meta/branding");
    assert.equal(pub.body.branding.primaryColor, "#112233", "back to the env default");
    assert.equal(pub.body.branding.accentColor, null);
    assert.equal(pub.body.branding.orgName, "Test Org");
    assert.equal(pub.body.branding.secondaryColor, "#000000");
  });

  await t.test("strictly rejects anything but #RRGGBB, and saves nothing from a bad request", async function () {
    await db.clearDatabase();
    var admin = await fixtures.createUser({ role: "admin" });
    var bad = [
      "red",
      "#fff",
      "4f46e5",
      "#4f46e5ff",
      "#gggggg",
      "rgb(0,0,0)",
      "#4f46e5;}</style><script>alert(1)</script>",
      "url(//evil.example/x.png)",
      "var(--danger)",
      12,
      true,
      {},
      ["#4f46e5"],
    ];
    for (var value of bad) {
      for (var field of ["primaryColor", "secondaryColor", "accentColor"]) {
        var body = { branding: {} };
        body.branding[field] = value;
        var res = await patch(admin, body);
        assert.equal(res.status, 400, field + " = " + JSON.stringify(value));
        assert.match(res.body.error, new RegExp(field + " must be a colour written as #RRGGBB"));
      }
    }

    // One bad field fails the whole request: the good field is not saved.
    var mixed = await patch(admin, { branding: { orgName: "Saved?", primaryColor: "nope" } });
    assert.equal(mixed.status, 400);
    var settings = await request(app).get("/api/admin/settings").set(as(admin));
    assert.equal(settings.body.settings.branding.orgName, "");
    assert.equal(settings.body.settings.branding.primaryColor, "");
  });

  await t.test("validates the name, URLs and field names", async function () {
    await db.clearDatabase();
    var admin = await fixtures.createUser({ role: "admin" });

    var res = await patch(admin, { branding: { orgName: "x".repeat(81) } });
    assert.equal(res.status, 400);
    res = await patch(admin, { branding: { orgName: "bad\u0000name" } });
    assert.equal(res.status, 400);
    res = await patch(admin, { branding: { orgName: 42 } });
    assert.equal(res.status, 400);
    res = await patch(admin, { branding: { orgName: "Hack <3 & Co" } });
    assert.equal(res.status, 200, "ordinary punctuation is fine (the UI escapes it)");

    for (var url of ["javascript:alert(1)", "http://insecure.example.com/l.png", "data:image/png;base64,AAAA", "/logo.png", "not a url"]) {
      res = await patch(admin, { branding: { logoUrl: url } });
      assert.equal(res.status, 400, url);
      assert.match(res.body.error, /logoUrl must be an https:\/\/ URL/);
    }
    res = await patch(admin, { branding: { logoUrl: "https://cdn.example.com/l.png", faviconUrl: "https://cdn.example.com/f.ico" } });
    assert.equal(res.status, 200);

    // Unknown fields (including the internal file fields) are not settable.
    for (var field of ["logoFile", "colour", "primary", "$set", "__proto__", "constructor"]) {
      var body = JSON.parse('{"branding":{"' + field + '":"#ffffff"}}');
      res = await patch(admin, body);
      assert.equal(res.status, 400, field);
      assert.match(res.body.error, /Unknown branding field/);
    }
    res = await patch(admin, { branding: "#ffffff" });
    assert.equal(res.status, 400);
    res = await patch(admin, { branding: [] });
    assert.equal(res.status, 400);
  });

  await t.test("only admins can change branding", async function () {
    await db.clearDatabase();
    var mod = await fixtures.createUser({ role: "moderator" });
    var applicant = await fixtures.createUser({ role: "applicant" });
    assert.equal((await patch(mod, { branding: { primaryColor: "#000000" } })).status, 403);
    assert.equal((await patch(applicant, { branding: { primaryColor: "#000000" } })).status, 403);
    assert.equal((await request(app).patch("/api/admin/settings").send({ branding: { primaryColor: "#000000" } })).status, 401);
    assert.equal((await request(app).put("/api/admin/branding/logo")).status, 401);
    assert.equal((await putImage(mod, "logo", PNG)).status, 403);
    assert.equal((await request(app).delete("/api/admin/branding/logo").set(as(applicant))).status, 403);
    assert.equal((await request(app).get("/api/meta/branding")).body.branding.primaryColor, "#4f46e5");
  });

  await t.test("junk already in the database is ignored when reading", async function () {
    await db.clearDatabase();
    await OrgSettings.collection.insertOne({
      key: "default",
      branding: {
        orgName: "x".repeat(500),
        primaryColor: "red;}</style>",
        secondaryColor: { $gt: "" },
        logoUrl: "javascript:alert(1)",
        logoDarkUrl: "http://insecure.example.com/l.png",
        faviconUrl: "data:image/svg+xml,<svg/>",
        logoFile: "../resumes/secret.pdf",
      },
    });
    var res = await request(app).get("/api/meta/branding");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.branding, {
      orgName: "Test Org",
      primaryColor: "#4f46e5",
      secondaryColor: "#64748b",
      accentColor: null,
      logoUrl: null,
      logoDarkUrl: null,
      faviconUrl: null,
    });
  });

  await t.test("the admin settings view shows the effective branding and the defaults", async function (t2) {
    await db.clearDatabase();
    withEnv(t2, { BRAND_PRIMARY: "#112233" });
    var admin = await fixtures.createUser({ role: "admin" });
    await patch(admin, { branding: { primaryColor: "#445566" } });
    var res = await request(app).get("/api/admin/settings").set(as(admin));
    assert.equal(res.body.effectiveBranding.primaryColor, "#445566");
    assert.equal(res.body.brandingDefaults.primaryColor, "#112233");
    assert.equal(res.body.imageUploadsEnabled, true);
  });

  await t.test("GET /api/meta/config uses the same organisation name", async function () {
    await db.clearDatabase();
    var admin = await fixtures.createUser({ role: "admin" });
    assert.equal((await request(app).get("/api/meta/config")).body.orgName, "Test Org");
    await patch(admin, { branding: { orgName: "Renamed Hack" } });
    assert.equal((await request(app).get("/api/meta/config")).body.orgName, "Renamed Hack");
  });

  // ---- Logo upload ----------------------------------------------------------

  await t.test("uploads a logo to private storage and serves it through the API", async function (t2) {
    await db.clearDatabase();
    var storage = fakeStorage(t2);
    var admin = await fixtures.createUser({ role: "admin" });

    var res = await putImage(admin, "logo", PNG, "my logo.png", "image/png");
    assert.equal(res.status, 200);
    var url = res.body.effectiveBranding.logoUrl;
    assert.match(url, /^\/api\/meta\/branding\/files\/logo-[0-9a-f]{16}\.png$/);
    var fileName = url.split("/").pop();
    assert.deepEqual(Object.keys(storage.store), [fileName]);
    assert.equal(storage.store[fileName].contentType, "image/png");
    assert.deepEqual(storage.store[fileName].buffer, PNG);
    assert.equal(res.body.settings.branding.logoFile, fileName);
    assert.equal(branding.FILE_NAME.test(fileName), true);

    // It shows up in the public branding payload...
    var pub = await request(app).get("/api/meta/branding");
    assert.equal(pub.body.branding.logoUrl, url);
    assert.equal(pub.body.branding.logoDarkUrl, null);

    // ...and anyone can fetch the file, with safe, long-lived headers.
    var file = await request(app).get(url).buffer(true).parse(binaryParser);
    assert.equal(file.status, 200);
    assert.deepEqual(file.body, PNG);
    assert.equal(file.headers["content-type"], "image/png");
    assert.equal(file.headers["x-content-type-options"], "nosniff");
    assert.equal(file.headers["content-security-policy"], "default-src 'none'; sandbox");
    assert.equal(file.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.equal(file.headers["cross-origin-resource-policy"], "cross-origin");

    // Repeat requests are answered from memory, not by re-downloading from Azure.
    await request(app).get(url);
    await request(app).get(url);
    assert.equal(azureBlob.downloadBrandingImage.mock.callCount(), 1);
  });

  await t.test("uses API_PUBLIC_URL for absolute links when it is set", async function (t2) {
    await db.clearDatabase();
    fakeStorage(t2);
    withEnv(t2, { API_PUBLIC_URL: "https://api.example.com/" });
    var admin = await fixtures.createUser({ role: "admin" });
    var res = await putImage(admin, "logo-dark", JPEG, "d.jpg", "image/jpeg");
    assert.equal(res.status, 200);
    assert.match(res.body.effectiveBranding.logoDarkUrl, /^https:\/\/api\.example\.com\/api\/meta\/branding\/files\/logo-dark-[0-9a-f]{16}\.jpg$/);
  });

  await t.test("replacing an upload deletes the old file; removing falls back to the env default", async function (t2) {
    await db.clearDatabase();
    var storage = fakeStorage(t2);
    withEnv(t2, { BRAND_LOGO_URL: "https://cdn.example.com/default.png" });
    var admin = await fixtures.createUser({ role: "admin" });

    var first = await putImage(admin, "logo", PNG);
    var firstName = first.body.settings.branding.logoFile;
    var second = await putImage(admin, "logo", WEBP, "l.webp", "image/webp");
    var secondName = second.body.settings.branding.logoFile;
    assert.notEqual(firstName, secondName);
    assert.match(secondName, /\.webp$/);
    assert.deepEqual(storage.deleted, [firstName]);
    assert.deepEqual(Object.keys(storage.store), [secondName]);

    var servedUrl = "/api/meta/branding/files/" + secondName;
    assert.equal((await request(app).get(servedUrl)).status, 200, "served (and now cached) before removal");

    var removed = await request(app).delete("/api/admin/branding/logo").set(as(admin));
    assert.equal(removed.status, 200);
    assert.equal((await request(app).get(servedUrl)).status, 404, "a removed image is no longer served from memory either");
    assert.deepEqual(storage.deleted, [firstName, secondName]);
    assert.equal(removed.body.settings.branding.logoFile, "");
    assert.equal(removed.body.effectiveBranding.logoUrl, "https://cdn.example.com/default.png");
    assert.equal((await request(app).get("/api/meta/branding")).body.branding.logoUrl, "https://cdn.example.com/default.png");
  });

  await t.test("pasting an image URL replaces the upload, and uploading replaces the URL", async function (t2) {
    await db.clearDatabase();
    var storage = fakeStorage(t2);
    var admin = await fixtures.createUser({ role: "admin" });

    var up = await putImage(admin, "favicon", ICO, "favicon.ico", "image/x-icon");
    assert.equal(up.status, 200);
    var name = up.body.settings.branding.faviconFile;
    assert.match(name, /^favicon-[0-9a-f]{16}\.ico$/);

    var pasted = await patch(admin, { branding: { faviconUrl: "https://cdn.example.com/f.png" } });
    assert.equal(pasted.status, 200);
    assert.equal(pasted.body.effectiveBranding.faviconUrl, "https://cdn.example.com/f.png");
    assert.equal(pasted.body.settings.branding.faviconFile, "");
    assert.deepEqual(storage.deleted, [name], "the orphaned file is deleted");

    var again = await putImage(admin, "favicon", PNG);
    assert.equal(again.body.settings.branding.faviconUrl, "", "the pasted URL is dropped");
    assert.match(again.body.effectiveBranding.faviconUrl, /\/files\/favicon-[0-9a-f]{16}\.png$/);
  });

  await t.test("only real PNG / JPEG / WebP images are accepted, whatever the name or Content-Type says", async function (t2) {
    await db.clearDatabase();
    var storage = fakeStorage(t2);
    var admin = await fixtures.createUser({ role: "admin" });

    var attempts = [
      ["SVG named .png", SVG, "logo.png", "image/png"],
      ["SVG named .svg", SVG, "logo.svg", "image/svg+xml"],
      ["HTML as an image", Buffer.from("<html><body><script>alert(1)</script></body></html>"), "logo.png", "image/png"],
      ["a PDF", Buffer.from("%PDF-1.4 ".repeat(8)), "logo.png", "image/png"],
      ["a GIF", Buffer.from("GIF89a" + "x".repeat(40)), "logo.gif", "image/gif"],
      ["plain text", Buffer.from("not an image at all"), "logo.png", "image/png"],
      ["an ICO as a logo", ICO, "logo.ico", "image/x-icon"],
    ];
    for (var a of attempts) {
      var res = await putImage(admin, "logo", a[1], a[2], a[3]);
      assert.equal(res.status, 400, a[0]);
      assert.match(res.body.error, /isn't an accepted image/);
    }
    assert.deepEqual(storage.store, {}, "nothing was stored");

    // The type is read from the bytes, so a real PNG with a lying name is fine
    // and is stored (and later served) as a PNG.
    var ok = await putImage(admin, "logo", PNG, "evil.svg", "image/svg+xml");
    assert.equal(ok.status, 200);
    assert.match(ok.body.settings.branding.logoFile, /\.png$/);
  });

  await t.test("enforces the size limit and the upload shape", async function (t2) {
    await db.clearDatabase();
    var storage = fakeStorage(t2);
    var admin = await fixtures.createUser({ role: "admin" });

    var big = Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]);
    var res = await putImage(admin, "logo", big);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /1 MB or smaller/);

    res = await request(app).put("/api/admin/branding/logo").set(as(admin));
    assert.equal(res.status, 400, "no file");
    res = await request(app)
      .put("/api/admin/branding/logo")
      .set(as(admin))
      .attach("image", PNG, { filename: "l.png", contentType: "image/png" });
    assert.equal(res.status, 400, "wrong field name");
    res = await request(app).put("/api/admin/branding/logo").set(as(admin)).attach("file", Buffer.alloc(0), { filename: "l.png" });
    assert.equal(res.status, 400, "empty file");

    res = await putImage(admin, "banner", PNG);
    assert.equal(res.status, 404, "unknown slot");
    res = await request(app).delete("/api/admin/branding/constructor").set(as(admin));
    assert.equal(res.status, 404, "slot names are not looked up on Object.prototype");

    assert.deepEqual(storage.store, {});
  });

  await t.test("answers 501 for uploads when Azure isn't configured", async function (t2) {
    await db.clearDatabase();
    fakeStorage(t2);
    withEnv(t2, { AZURE_STORAGE_CONNECTION_STRING: undefined });
    var admin = await fixtures.createUser({ role: "admin" });
    var res = await putImage(admin, "logo", PNG);
    assert.equal(res.status, 501);
    var settings = await request(app).get("/api/admin/settings").set(as(admin));
    assert.equal(settings.body.imageUploadsEnabled, false);
    // A pasted https URL still works without storage.
    res = await patch(admin, { branding: { logoUrl: "https://cdn.example.com/l.png" } });
    assert.equal(res.status, 200);
  });

  await t.test("failing to save the setting removes the just-uploaded blob", async function (t2) {
    await db.clearDatabase();
    var storage = fakeStorage(t2);
    t2.mock.method(console, "error", function quiet() {});
    var admin = await fixtures.createUser({ role: "admin" });
    t2.mock.method(OrgSettings, "findOneAndUpdate", function failing() {
      return Promise.reject(new Error("write failed"));
    });
    var res = await putImage(admin, "logo", PNG);
    assert.equal(res.status, 500);
    assert.deepEqual(storage.store, {}, "no orphaned blob");
    assert.equal(storage.deleted.length, 1);
  });

  // ---- Serving files --------------------------------------------------------

  await t.test("only names we generated can be fetched; nothing else in storage is reachable", async function (t2) {
    await db.clearDatabase();
    var storage = fakeStorage(t2);
    // Things that exist in storage but must never be served by this route.
    storage.store["resumes/abc-0011223344556677.pdf"] = { buffer: Buffer.from("%PDF secret resume") };
    storage.store["logo-0011223344556677.svg"] = { buffer: SVG };
    storage.store["logo-0011223344556677.png"] = { buffer: PNG };
    storage.store["logo-aaaaaaaaaaaaaaaa.png"] = { buffer: SVG }; // wrong bytes for its name
    storage.store["favicon-bbbbbbbbbbbbbbbb.png"] = { buffer: PNG };

    var good = await request(app).get("/api/meta/branding/files/logo-0011223344556677.png");
    assert.equal(good.status, 200);
    assert.equal((await request(app).get("/api/meta/branding/files/favicon-bbbbbbbbbbbbbbbb.png")).status, 200);

    var refused = [
      "logo-0011223344556677.svg",
      "logo-aaaaaaaaaaaaaaaa.png",
      "logo-ffffffffffffffff.png",
      "resumes%2Fabc-0011223344556677.pdf",
      "..%2Fresumes%2Fabc-0011223344556677.pdf",
      "%2e%2e%2flogo-0011223344556677.png",
      "logo-0011223344556677.png%2F..%2Fx",
      "logo-0011223344556677.PNG",
      "logo-001122334455667.png",
      "logo-00112233445566778.png",
      "banner-0011223344556677.png",
      "constructor",
    ];
    for (var name of refused) {
      var res = await request(app).get("/api/meta/branding/files/" + name);
      assert.equal(res.status, 404, name);
    }
  });

  await t.test("a storage failure while serving is a clean 502, not a crash", async function (t2) {
    t2.mock.method(console, "error", function quiet() {});
    t2.mock.method(azureBlob, "downloadBrandingImage", function boom() {
      return Promise.reject(new Error("storage down"));
    });
    var res = await request(app).get("/api/meta/branding/files/logo-1234123412341234.png");
    assert.equal(res.status, 502);
  });

  await db.closeDatabase();
});

/**
 * supertest parser that keeps the response body as raw bytes.
 * @param {object} res - Response stream.
 * @param {function} callback - (err, body).
 * @returns {void}
 */
function binaryParser(res, callback) {
  var chunks = [];
  res.on("data", function onData(chunk) {
    chunks.push(chunk);
  });
  res.on("end", function onEnd() {
    callback(null, Buffer.concat(chunks));
  });
}
