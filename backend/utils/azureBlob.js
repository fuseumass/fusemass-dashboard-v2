"use strict";

var crypto = require("crypto");
var path = require("path");
var storageBlob = require("@azure/storage-blob");

var BlobServiceClient = storageBlob.BlobServiceClient;

/**
 * Whether Azure Blob Storage is configured for resume uploads.
 * @returns {boolean}
 */
function isAzureConfigured() {
  return Boolean(process.env.AZURE_STORAGE_CONNECTION_STRING);
}

/**
 * Lazily build a container client and make sure the container exists.
 * @returns {Promise<object>} An Azure ContainerClient.
 */
function getContainerClient() {
  var connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  var containerName = process.env.AZURE_STORAGE_CONTAINER || "resumes";

  var serviceClient = BlobServiceClient.fromConnectionString(connectionString);
  var containerClient = serviceClient.getContainerClient(containerName);

  return containerClient.createIfNotExists().then(function afterEnsure() {
    return containerClient;
  });
}

/**
 * Upload a resume file buffer to Azure Blob Storage and return its URL.
 *
 * @param {object} file - A multer file object ({ buffer, originalname, mimetype }).
 * @param {string} userId - Owner's user id, used to namespace the blob.
 * @returns {Promise<string>} The uploaded blob's URL.
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
        return blockBlobClient.url;
      });
  });
}

module.exports = {
  isAzureConfigured: isAzureConfigured,
  uploadResume: uploadResume,
};
