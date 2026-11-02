/* Lapse — runtime local
 *
 * Hors de claude.ai, les capacités du lecteur d'artifact n'existent pas.
 * Ce fichier les remplace par des équivalents qui vivent dans le navigateur,
 * en exposant exactement la même interface : window.claude.use(nom).
 * L'application n'a pas une ligne de différence entre les deux mondes.
 *
 *   db         → localStorage, avec abonnements façon onSnapshot
 *   assets     → IndexedDB, et des URL d'objet pour l'affichage
 *   downloads  → un lien <a download>
 *   user       → une identité d'appareil ; les données restent sur ce navigateur
 *   sample     → absent : la lecture automatique des tickets demande claude.ai
 */
(function () {
  "use strict";

  // Dans claude.ai, le lecteur a déjà posé window.claude : on ne touche à rien.
  if (window.claude && typeof window.claude.use === "function") return;

  var STORE_KEY = "lapse-store-v1";
  var FILE_DB = "lapse-files";
  var FILE_STORE = "blobs";

  /* ------------------------------------------------------------ documents */

  var data = {};
  try {
    data = JSON.parse(window.localStorage.getItem(STORE_KEY) || "{}");
  } catch (e) {
    data = {};
  }
  var watchers = [];

  function persist() {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(data));
    } catch (e) {
      // Stockage plein ou refusé : la session reste utilisable, sans survie au rechargement.
    }
    watchers.slice().forEach(function (w) { w(); });
  }

  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function meta() { return { fromCache: false, hasPendingWrites: false }; }

  function docSnapshot(path) {
    var present = Object.prototype.hasOwnProperty.call(data, path);
    return {
      id: path.slice(path.lastIndexOf("/") + 1),
      exists: present,
      data: function () { return present ? data[path] : undefined; },
      metadata: meta()
    };
  }

  function subscribe(fire) {
    watchers.push(fire);
    // Comme onSnapshot : une première livraison immédiate, puis à chaque écriture.
    window.setTimeout(fire, 0);
    return function () {
      watchers = watchers.filter(function (w) { return w !== fire; });
    };
  }

  function newId() {
    return "l" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function docRef(path) {
    return {
      id: path.slice(path.lastIndexOf("/") + 1),
      path: path,
      get: function () { return Promise.resolve(docSnapshot(path)); },
      set: function (value) {
        data[path] = clone(value);
        persist();
        return Promise.resolve();
      },
      update: function (fields) {
        var base = data[path] || {};
        Object.keys(fields).forEach(function (k) { base[k] = fields[k]; });
        data[path] = base;
        persist();
        return Promise.resolve();
      },
      delete: function () {
        delete data[path];
        persist();
        return Promise.resolve();
      },
      onSnapshot: function (next) {
        return subscribe(function () { next(docSnapshot(path)); });
      },
      collection: function (name) { return collectionRef(path + "/" + name); }
    };
  }

  function collectionRef(path) {
    return {
      path: path,
      doc: function (id) { return docRef(path + "/" + (id || newId())); },
      add: function (value) {
        var ref = docRef(path + "/" + newId());
        return ref.set(value).then(function () { return ref; });
      },
      get: function () { return Promise.resolve(querySnapshot(path)); },
      onSnapshot: function (next) {
        return subscribe(function () { next(querySnapshot(path)); });
      }
    };
  }

  function querySnapshot(path) {
    var prefix = path + "/";
    var docs = Object.keys(data)
      .filter(function (p) {
        // Enfants directs seulement : pas les sous-collections.
        return p.indexOf(prefix) === 0 && p.slice(prefix.length).indexOf("/") === -1;
      })
      .sort()
      .map(function (p) { return docSnapshot(p); });
    return {
      docs: docs,
      size: docs.length,
      empty: docs.length === 0,
      docChanges: function () { return []; },
      metadata: meta()
    };
  }

  var store = { doc: docRef, collection: collectionRef };

  /* -------------------------------------------------------------- fichiers */

  window.__lapseBlobs = {};

  function openFiles() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error("indexeddb")); return; }
      var req = window.indexedDB.open(FILE_DB, 1);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(FILE_STORE)) req.result.createObjectStore(FILE_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function withFiles(mode, run) {
    return openFiles().then(function (idb) {
      return new Promise(function (resolve, reject) {
        var tx = idb.transaction(FILE_STORE, mode);
        var request = run(tx.objectStore(FILE_STORE));
        tx.oncomplete = function () { resolve(request ? request.result : undefined); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error); };
      });
    });
  }

  // Les URL d'objet sont préparées au démarrage pour que l'affichage reste synchrone.
  function primeBlobs() {
    return withFiles("readonly", function (s) { return s.getAll ? s.getAll() : null; })
      .then(function (blobs) {
        if (!blobs) return null;
        return withFiles("readonly", function (s) { return s.getAllKeys ? s.getAllKeys() : null; })
          .then(function (keys) {
            if (!keys) return null;
            keys.forEach(function (k, i) {
              if (blobs[i]) window.__lapseBlobs[k] = URL.createObjectURL(blobs[i]);
            });
            return null;
          });
      })
      .catch(function () { return null; });
  }

  var files = {
    upload: function (blob) {
      var id = "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      return withFiles("readwrite", function (s) { s.put(blob, id); }).then(function () {
        window.__lapseBlobs[id] = URL.createObjectURL(blob);
        return {
          id: id,
          url: window.__lapseBlobs[id],
          sizeBytes: blob.size,
          contentType: blob.type || "application/octet-stream"
        };
      }).catch(function () {
        return Promise.reject({ code: "store_unavailable", message: "IndexedDB indisponible" });
      });
    },
    list: function () {
      return withFiles("readonly", function (s) { return s.getAllKeys ? s.getAllKeys() : null; })
        .then(function (keys) {
          keys = keys || [];
          var bytes = 0;
          return {
            assets: keys.map(function (k) { return { id: k, url: window.__lapseBlobs[k] || "" }; }),
            usage: { files: keys.length, bytes: bytes, maxFiles: 0, maxBytes: 0 }
          };
        })
        .catch(function () {
          return { assets: [], usage: { files: 0, bytes: 0, maxFiles: 0, maxBytes: 0 } };
        });
    },
    delete: function (id) {
      if (window.__lapseBlobs[id]) {
        URL.revokeObjectURL(window.__lapseBlobs[id]);
        delete window.__lapseBlobs[id];
      }
      return withFiles("readwrite", function (s) { s.delete(id); })
        .then(function () { return { deleted: true }; })
        .catch(function () { return { deleted: false }; });
    }
  };

  /* ---------------------------------------------------- enregistrement */

  var downloads = {
    save: function (request) {
      var blob = request.data instanceof Blob
        ? request.data
        : new Blob([request.data], { type: "text/plain;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = request.filename || "lapse";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      return Promise.resolve({ status: "saved" });
    }
  };

  /* --------------------------------------------------------- identité */

  var AVATAR =
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">' +
      '<rect width="48" height="48" rx="24" fill="#0E9FBF"/>' +
      '<path d="M24 25a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm0 3c-7 0-13 4-13 9v3h26v-3c0-5-6-9-13-9Z" fill="#fff"/>' +
      "</svg>"
    );

  var user = {
    id: function () { return Promise.resolve("local"); },
    me: function () {
      return Promise.resolve({
        id: "local",
        name: "Cet appareil",
        avatarUrl: AVATAR,
        color: "#0E9FBF",
        email: null,
        isOwner: true,
        canEdit: true
      });
    },
    can: function () { return Promise.resolve(true); },
    isOwner: function () { return Promise.resolve(true); },
    canEdit: function () { return Promise.resolve(true); },
    profiles: function () { return Promise.resolve({}); },
    name: function () { return Promise.resolve("Cet appareil"); },
    avatarUrl: function () { return Promise.resolve(AVATAR); },
    search: function () { return Promise.resolve([]); },
    email: function () { return Promise.resolve(null); }
  };

  /* ------------------------------------------------------------- façade */

  var ready = primeBlobs();

  window.claude = {
    use: function (name) {
      if (name === "db") return ready.then(function () { return store; });
      if (name === "assets") return ready.then(function () { return files; });
      if (name === "downloads") return Promise.resolve(downloads);
      if (name === "user") return Promise.resolve(user);
      // sample : la lecture d'un ticket par Claude n'existe que dans la version claude.ai.
      return Promise.resolve(null);
    }
  };
})();
