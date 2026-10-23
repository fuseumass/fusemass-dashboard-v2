"use strict";

/**
 * List every route mounted on an Express 4 app by walking its router stack,
 * so tests can check "every route" without a hand-kept list that rots.
 *
 * Handles `app.get(...)`, routers mounted with `app.use("/prefix", router)`
 * (nested to any depth) and `router.route(...)`. Trailing slashes are dropped
 * (`router.post("/")` under `/api/teams` is `/api/teams`). Mount paths with `:params`
 * in them aren't supported (nothing here uses them) and throw, so a new kind
 * of mount can't silently hide routes from the tests.
 *
 * @param {object} app - The Express app (require("../server")).
 * @returns {Array<{method: string, path: string}>} One entry per method +
 *   path, e.g. { method: "PATCH", path: "/api/admin/rounds/:id" }, sorted.
 */
function listRoutes(app) {
  var found = [];
  walk(app._router.stack, "");

  found.sort(function byKey(a, b) {
    return routeKey(a.method, a.path) < routeKey(b.method, b.path) ? -1 : 1;
  });
  return found;

  function walk(stack, prefix) {
    stack.forEach(function visit(layer) {
      if (layer.route) {
        addRoute(layer.route, prefix);
      } else if (layer.name === "router" && layer.handle && layer.handle.stack) {
        walk(layer.handle.stack, prefix + mountPath(layer));
      }
    });
  }

  // router.post("/") mounted at /api/teams is "/api/teams/": same route.
  function normalize(path) {
    return path.length > 1 ? path.replace(/\/+$/, "") : path;
  }

  function addRoute(route, prefix) {
    if (typeof route.path !== "string") {
      throw new Error("listRoutes: only string route paths are supported, got " + String(route.path));
    }
    Object.keys(route.methods).forEach(function addMethod(method) {
      if (route.methods[method]) {
        found.push({ method: method.toUpperCase(), path: normalize(prefix + route.path) });
      }
    });
  }
}

/**
 * The path a router layer is mounted at, recovered from the regexp Express 4
 * builds for `app.use("/api/auth", router)` (`/^\/api\/auth\/?(?=\/|$)/i`).
 * @param {object} layer - An Express router stack layer.
 * @returns {string} The mount path ("" when mounted at the root).
 */
function mountPath(layer) {
  if (layer.keys && layer.keys.length) {
    throw new Error("listRoutes: mount paths with parameters are not supported.");
  }
  if (layer.regexp && layer.regexp.fast_slash) {
    return "";
  }
  return layer.regexp.source
    .replace("\\/?(?=\\/|$)", "")
    .replace(/^\^/, "")
    .replace(/\\\//g, "/");
}

/**
 * @param {string} method - HTTP method.
 * @param {string} path - Route path, e.g. "/api/admin/rounds/:id".
 * @returns {string} "METHOD /path", the key used to compare route lists.
 */
function routeKey(method, path) {
  return method.toUpperCase() + " " + path;
}

module.exports = { listRoutes: listRoutes, routeKey: routeKey };
