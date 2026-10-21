"use strict";

require("./testEnv");

var mongoose = require("mongoose");

/**
 * Connect to the disposable test database (MONGODB_URI from testEnv), and wait
 * until every model's collection and indexes exist. Mongoose builds them in the
 * background after connecting; left alone, the first query of a test can land
 * in the middle of that (slow on a busy machine) and trip a test's short wait
 * for a fire-and-forget email.
 * @returns {Promise<void>}
 */
function connect() {
  return mongoose.connect(process.env.MONGODB_URI).then(function afterConnect() {
    return Promise.all(
      Object.keys(mongoose.models).map(function initModel(name) {
        return mongoose.models[name].init();
      })
    ).then(function done() {
      return undefined;
    });
  });
}

/**
 * Delete every document from every collection so each test file starts from
 * a clean slate without needing a fresh database per file.
 * @returns {Promise<void>}
 */
function clearDatabase() {
  var collections = mongoose.connection.collections;
  return Promise.all(
    Object.keys(collections).map(function dropCollection(key) {
      return collections[key].deleteMany({});
    })
  );
}

/**
 * Drop the whole disposable test database and close the connection. Call
 * once a test file is fully done with the database.
 * @returns {Promise<void>}
 */
function closeDatabase() {
  return mongoose.connection.dropDatabase().then(function afterDrop() {
    return mongoose.connection.close();
  });
}

module.exports = {
  connect: connect,
  clearDatabase: clearDatabase,
  closeDatabase: closeDatabase,
};
