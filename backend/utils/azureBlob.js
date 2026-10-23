"use strict";

var crypto = require("crypto");
var path = require("path");
var storageBlob = require("@azure/storage-blob");

var BlobServiceClient = storageBlob.BlobServiceClient;
var BlobSASPermissions = storageBlob.BlobSASPermissions;
var SASProtocol = storageBlob.SASProtocol;

// How long a signed resume link stays usable. Anyone holding the link can
// read the file until it expires, so keep it just long enough to open it.
var RESUME_LINK_TTL_MS = 5 * 60 * 1000;

/**
 * Whether Azure Blob Storage is configured for resume uploads.
 * @returns {boolean}
 */
function isAzureConfigured() {
  return Boolean(process.env.AZURE_STORAGE_CONNECTION_STRING);
}

/**
 * Build a client for a container from the env connection string. Purely
 * local: makes no network request.
 * @param {string} [containerName] - Defaults to the resume container.
 * @returns {object} An Azure ContainerClient.
 */
function buildContainerClient(containerName) {
  var connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  var name = containerName || process.env.AZURE_STORAGE_CONTAINER || "resumes";

  var serviceClient = BlobServiceClient.fromConnectionString(connectionString);
  return serviceClient.getContainerClient(name);
}

/**
 * Lazily build a container client and make sure the container exists. A
 * container created here is private (no anonymous read access).
 * @param {string} [containerName] - Defaults to the resume container.
 * @returns {Promise<object>} An Azure ContainerClient.
 */
function getContainerClient(containerName) {
  var containerClient = buildContainerClient(containerName);

  return containerClient.createIfNotExists().then(function afterEnsure() {
    return containerClient;
  });
}

/**
 * Upload a resume file buffer to Azure Blob Storage and return its blob name.
 * The container is private, so the blob's plain URL is useless to a browser;
 * store the name and hand out links with getResumeLink.
 *
 * @param {object} file - A multer file object ({ buffer, originalname, mimetype }).
 * @param {string} userId - Owner's user id, used to namespace the blob.
 * @returns {Promise<string>} The uploaded blob's name within the container.
 */
function uploadResume(file, userId) {
  if (!isAzureConfigured()) {
    return Promise.reject(new Error("Azure Blob Storage is not configured."));
  }

  var ext = path.extname(file.originalname || "") || ".pdf";
  var blobName =
    "resumes/" + userId + "-" + crypto.randomBytes(8).toString("hex") + ext;

  return getContainerClient().then(function afterContainer(containerClient) {
    var blockBlobClient = containerClient.getBlockBlobClient(blobName);
    return blockBlobClient
      .uploadData(file.buffer, {
        blobHTTPHeaders: {
          blobContentType: file.mimetype || "application/octet-stream",
        },
      })
      .then(function afterUpload() {
        return blobName;
      });
  });
}

/**
 * Sign a short-lived, read-only HTTPS link to a stored resume. Signing is done
 * locally with the account key from the connection string, so the connection
 * string must include `AccountKey` (a SAS-based one cannot sign). Callers are
 * responsible for checking the requester may see this resume first.
 *
 * @param {string} blobName - Blob name returned by uploadResume.
 * @returns {Promise<{url: string, expiresAt: Date}>} The signed link and when it stops working.
 */
function getResumeLink(blobName) {
  if (!isAzureConfigured()) {
    return Promise.reject(new Error("Azure Blob Storage is not configured."));
  }

  var expiresAt = new Date(Date.now() + RESUME_LINK_TTL_MS);
  var blobClient = buildContainerClient().getBlobClient(blobName);

  return blobClient
    .generateSasUrl({
      permissions: BlobSASPermissions.parse("r"),
      expiresOn: expiresAt,
      protocol: SASProtocol.Https,
    })
    .then(function afterSign(url) {
      return { url: url, expiresAt: expiresAt };
    });
}

/**
 * Name of the container holding uploaded branding images (logos, favicon).
 * It is separate from the resume container and PRIVATE too: the browser never
 * talks to Azure for these, the API streams them (GET /api/meta/branding/files/:name),
 * so no anonymous blob access has to be enabled on the storage account.
 * @returns {string}
 */
function brandingContainerName() {
  return process.env.AZURE_STORAGE_BRANDING_CONTAINER || "branding";
}

/**
 * Store a branding image. The caller has already checked the bytes are a real
 * PNG/JPEG/WebP/ICO (utils/imageType) and picked the file name.
 * @param {string} fileName - Generated name, e.g. "logo-0011223344556677.png".
 * @param {Buffer} buffer - The image bytes.
 * @param {string} contentType - MIME type derived from the sniffed type.
 * @returns {Promise<void>}
 */
function uploadBrandingImage(fileName, buffer, contentType) {
  if (!isAzureConfigured()) {
    return Promise.reject(new Error("Azure Blob Storage is not configured."));
  }
  return getContainerClient(brandingContainerName()).then(function afterContainer(containerClient) {
    return containerClient
      .getBlockBlobClient(fileName)
      .uploadData(buffer, { blobHTTPHeaders: { blobContentType: contentType } })
      .then(function afterUpload() {
        return undefined;
      });
  });
}

/**
 * Read a branding image back into memory (they are capped at 1 MiB).
 * @param {string} fileName - A validated stored file name.
 * @returns {Promise<Buffer|null>} The bytes, or null when no such image exists.
 */
function downloadBrandingImage(fileName) {
  if (!isAzureConfigured()) {
    return Promise.resolve(null);
  }
  var blobClient = buildContainerClient(brandingContainerName()).getBlobClient(fileName);
  return blobClient.downloadToBuffer().catch(function onError(err) {
    if (err && err.statusCode === 404) {
      return null;
    }
    throw err;
  });
}

/**
 * Delete a branding image; a missing one is not an error.
 * @param {string} fileName - A validated stored file name.
 * @returns {Promise<void>}
 */
function deleteBrandingImage(fileName) {
  if (!isAzureConfigured()) {
    return Promise.resolve();
  }
  return buildContainerClient(brandingContainerName())
    .getBlobClient(fileName)
    .deleteIfExists()
    .then(function afterDelete() {
      return undefined;
    });
}

/**
 * Open a stored resume for reading on the server (the sponsor resume bundle
 * streams these into a ZIP). Callers are responsible for checking the
 * requester may export resumes first.
 *
 * @param {string} blobName - Blob name returned by uploadResume.
 * @returns {Promise<object>} A Node readable stream of the file's bytes.
 */
function downloadResume(blobName) {
  if (!isAzureConfigured()) {
    return Promise.reject(new Error("Azure Blob Storage is not configured."));
  }

  return buildContainerClient()
    .getBlobClient(blobName)
    .download()
    .then(function afterDownload(response) {
      return response.readableStreamBody;
    });
}

module.exports = {
  RESUME_LINK_TTL_MS: RESUME_LINK_TTL_MS,
  isAzureConfigured: isAzureConfigured,
  uploadResume: uploadResume,
  getResumeLink: getResumeLink,
  uploadBrandingImage: uploadBrandingImage,
  downloadBrandingImage: downloadBrandingImage,
  deleteBrandingImage: deleteBrandingImage,
  downloadResume: downloadResume,
};
