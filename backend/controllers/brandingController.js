"use strict";

var crypto = require("crypto");

var OrgSettings = require("../schemas/orgSettings");
var azureBlob = require("../utils/azureBlob");
var branding = require("../utils/branding");
var features = require("../utils/features");
var imageType = require("../utils/imageType");
var orgSettingsCache = require("../utils/orgSettingsCache");

// Uploaded logos/favicons are capped at 1 MiB (enforced by multer in routes/admin.js).
var MAX_IMAGE_BYTES = 1024 * 1024;

// How long browsers/CDNs may keep the public branding answer. A change made by
// an admin shows up everywhere within about this long.
var BRANDING_MAX_AGE_SECONDS = 60;

// The few most recently served images, kept in memory. The route is public and
// every logo name is public too (it's in the branding payload), so without this
// anyone could make us download the same blob from Azure over and over. Safe
// to keep: the bytes behind a name never change. At most 8 x 1 MiB.
var IMAGE_CACHE_SIZE = 8;
var imageCache = new Map();

/**
 * @param {string} name - A validated stored file name.
 * @returns {Promise<Buffer|null>} The image bytes (from memory when recent), or null if missing.
 */
function loadImage(name) {
  if (imageCache.has(name)) {
    return Promise.resolve(imageCache.get(name));
  }
  return azureBlob.downloadBrandingImage(name).then(function afterDownload(bytes) {
    if (bytes) {
      imageCache.set(name, bytes);
      if (imageCache.size > IMAGE_CACHE_SIZE) {
        imageCache.delete(imageCache.keys().next().value);
      }
    }
    return bytes;
  });
}

/**
 * The public payload: effective branding plus the module flags.
 * @param {object|null} settings - Settings snapshot (null = nothing stored, all defaults).
 * @returns {{branding: object, features: object}}
 */
function publicPayload(settings) {
  return { branding: branding.resolve(settings), features: features.resolve(settings) };
}

/**
 * GET /api/meta/branding — public, no auth. The effective branding (admin
 * setting, else server env, else default) and the module on/off flags, so the
 * frontend can theme itself and hide disabled modules at runtime without a
 * rebuild.
 *
 * Cheap on purpose: it reads the in-process settings snapshot (a database read
 * at most every few seconds per instance), and is cacheable by browsers and
 * CDNs for 60 s. Express adds an ETag, so revalidations are 304s.
 *
 * @param {object} _req - Express request.
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function getBranding(_req, res) {
  return orgSettingsCache
    .get()
    .then(function afterLoad(settings) {
      res.set("Cache-Control", "public, max-age=" + BRANDING_MAX_AGE_SECONDS);
      res.status(200).json(publicPayload(settings));
    })
    .catch(function onError(err) {
      // Never leave every page without a theme because the database blipped:
      // serve the defaults, but only let them be cached very briefly.
      console.error("getBranding failed:", err);
      res.set("Cache-Control", "public, max-age=5");
      res.status(200).json(publicPayload(null));
    });
}

/**
 * GET /api/meta/branding/files/:file — public. Streams an uploaded logo or
 * favicon out of the private branding container.
 *
 * Why the API serves these instead of a public container: the storage account
 * can keep anonymous blob access OFF (the recommended setting), nothing but the
 * file name pattern below can be requested, and what is sent back is decided
 * here, not by the blob:
 *   - only names we generated ("<slot>-<16 hex>.<png|jpg|webp|ico>");
 *   - the Content-Type comes from that extension and the bytes are re-checked
 *     against it, so a stray blob can't be served as something else;
 *   - SVG never gets this far (uploads are sniffed, SVG is refused), and
 *     `nosniff` + a locked-down CSP stop the browser treating bytes as a page.
 * Each upload gets a fresh random name, so the content behind a name never
 * changes and can be cached "forever".
 *
 * @param {object} req - Express request (req.params.file).
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function getFile(req, res) {
  var name = req.params.file;
  if (typeof name !== "string" || !branding.FILE_NAME.test(name)) {
    res.status(404).json({ error: "Not found." });
    return Promise.resolve();
  }
  var ext = name.slice(name.lastIndexOf(".") + 1);

  return loadImage(name)
    .then(function afterDownload(bytes) {
      if (!bytes || imageType.sniff(bytes) !== ext) {
        imageCache.delete(name);
        res.status(404).json({ error: "Not found." });
        return;
      }
      res.set({
        "Content-Type": imageType.mimeFor(ext),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cross-Origin-Resource-Policy": "cross-origin",
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      res.status(200).send(bytes);
    })
    .catch(function onError(err) {
      console.error("getFile (branding image) failed:", err);
      res.status(502).json({ error: "Could not load this image." });
    });
}

/**
 * Throw-away delete of an image that is no longer referenced; a failure only
 * leaves an unused blob behind, so it is logged, never surfaced.
 * @param {string} fileName - Stored file name ("" or undefined = nothing to delete).
 * @returns {void}
 */
function discardImage(fileName) {
  if (!fileName || !branding.FILE_NAME.test(fileName)) {
    return;
  }
  imageCache.delete(fileName);
  azureBlob.deleteBrandingImage(fileName).catch(function onError(err) {
    console.error("Could not delete old branding image " + fileName + ":", err);
  });
}

/**
 * Look up an image slot from the URL, or answer 404.
 * @param {object} req - Express request (req.params.slot).
 * @param {object} res - Express response.
 * @returns {object|null} The slot config, or null after a 404 was sent.
 */
function slotFromRequest(req, res) {
  var slot = req.params.slot;
  if (!Object.prototype.hasOwnProperty.call(branding.SLOTS, slot)) {
    res.status(404).json({ error: "Unknown image. Use one of: " + branding.SLOT_NAMES.join(", ") + "." });
    return null;
  }
  return branding.SLOTS[slot];
}

/**
 * @param {object} res - Express response.
 * @returns {function} A .then() handler that answers 200 with the fresh settings.
 */
function sendSettings(res) {
  return function send() {
    return OrgSettings.getSingleton().then(function afterLoad(settings) {
      res.status(200).json({ settings: settings, effectiveBranding: branding.resolve(settings) });
    });
  };
}

/**
 * PUT /api/admin/branding/:slot (admin) — upload a logo / dark logo / favicon
 * as multipart field `file`. The type is decided from the file's bytes (PNG,
 * JPEG or WebP; also ICO for the favicon), never from its name or the
 * Content-Type the browser sent. SVG is refused.
 *
 * @param {object} req - Express request (req.file from multer).
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function uploadImage(req, res) {
  var cfg = slotFromRequest(req, res);
  if (!cfg) {
    return Promise.resolve();
  }
  var slot = req.params.slot;
  if (!req.file || !req.file.buffer || !req.file.buffer.length) {
    res.status(400).json({ error: "Choose an image file to upload (form field \"file\")." });
    return Promise.resolve();
  }
  if (!azureBlob.isAzureConfigured()) {
    res.status(501).json({ error: "Image storage is not configured yet. Paste an image URL instead." });
    return Promise.resolve();
  }

  var ext = imageType.sniff(req.file.buffer);
  if (!ext || cfg.types.indexOf(ext) === -1) {
    res.status(400).json({
      error:
        "That file isn't an accepted image. Use " +
        cfg.types
          .map(function upper(t) {
            return t.toUpperCase();
          })
          .join(", ") +
        ". SVG is not allowed.",
    });
    return Promise.resolve();
  }

  var fileName = slot + "-" + crypto.randomBytes(8).toString("hex") + "." + ext;
  var set = {};
  set["branding." + cfg.fileField] = fileName;
  // One source at a time: an upload replaces any pasted URL for the slot.
  set["branding." + cfg.urlField] = "";

  return azureBlob
    .uploadBrandingImage(fileName, req.file.buffer, imageType.mimeFor(ext))
    .then(function afterUpload() {
      return OrgSettings.findOneAndUpdate(
        { key: "default" },
        { $set: set, $setOnInsert: { key: "default" } },
        { new: false, upsert: true, setDefaultsOnInsert: true, runValidators: true }
      ).catch(function undo(err) {
        // The settings write failed, so nothing points at the new blob.
        discardImage(fileName);
        throw err;
      });
    })
    .then(function afterUpdate(previous) {
      orgSettingsCache.clear();
      discardImage(previous && previous.branding && previous.branding[cfg.fileField]);
    })
    .then(sendSettings(res))
    .catch(function onError(err) {
      console.error("uploadImage failed:", err);
      res.status(500).json({ error: "Could not save the image." });
    });
}

/**
 * DELETE /api/admin/branding/:slot (admin) — remove the uploaded image AND any
 * pasted URL for that slot, so it falls back to the server default.
 *
 * @param {object} req - Express request (req.params.slot).
 * @param {object} res - Express response.
 * @returns {Promise<void>}
 */
function removeImage(req, res) {
  var cfg = slotFromRequest(req, res);
  if (!cfg) {
    return Promise.resolve();
  }
  var set = {};
  set["branding." + cfg.fileField] = "";
  set["branding." + cfg.urlField] = "";

  return OrgSettings.findOneAndUpdate({ key: "default" }, { $set: set }, { new: false })
    .then(function afterUpdate(previous) {
      orgSettingsCache.clear();
      discardImage(previous && previous.branding && previous.branding[cfg.fileField]);
    })
    .then(sendSettings(res))
    .catch(function onError(err) {
      console.error("removeImage failed:", err);
      res.status(500).json({ error: "Could not remove the image." });
    });
}

module.exports = {
  MAX_IMAGE_BYTES: MAX_IMAGE_BYTES,
  getBranding: getBranding,
  getFile: getFile,
  uploadImage: uploadImage,
  removeImage: removeImage,
  discardImage: discardImage,
};
