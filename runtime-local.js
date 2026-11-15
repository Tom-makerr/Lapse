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
 *   user       → un compte créé sur cet appareil ; connexion gardée
 *   sample     → l'OCR du navigateur, fourni par scan-local.js
 */
(function () {
  "use strict";

  // Dans claude.ai, le lecteur a déjà posé window.claude : on ne touche à rien.
  if (window.claude && typeof window.claude.use === "function") return;

  var STORE_KEY = "lapse-store-v1";
  var FILE_DB = "lapse-files";
  var FILE_STORE = "blobs";

  /* ------------------------------------------------------------ documents
   *
   * Les documents du compte connecté sont chiffrés en AES-GCM avec une clé
   * dérivée du mot de passe. En mémoire ils sont en clair ; sur le disque il
   * n'y a que du bruit. Ceux des autres comptes sont recopiés tels quels,
   * sans jamais être ouverts.
   */
  var data = {};      // les documents du compte, en clair
  var cipherOf = {};  // les mêmes, scellés, prêts à écrire
  var foreign = {};   // ceux des autres comptes, intouchés
  var watchers = [];
  var writing = null;

  function rawStore() {
    try { return JSON.parse(window.localStorage.getItem(STORE_KEY) || "{}"); }
    catch (e) { return {}; }
  }

  function flush() {
    try {
      var out = {};
      Object.keys(foreign).forEach(function (p) { out[p] = foreign[p]; });
      Object.keys(cipherOf).forEach(function (p) { out[p] = cipherOf[p]; });
      window.localStorage.setItem(STORE_KEY, JSON.stringify(out));
    } catch (e) {
      // Plein ou refusé : la session reste utilisable, sans survie au rechargement.
    }
  }

  // Les abonnés sont prévenus tout de suite ; le scellage et l'écriture
  // suivent, à la queue leu leu pour ne pas se marcher dessus.
  function persist() {
    watchers.slice().forEach(function (w) { w(); });
    var snapshot = Object.keys(data);
    writing = (writing || Promise.resolve()).then(function () {
      Object.keys(cipherOf).forEach(function (p) { if (!(p in data)) delete cipherOf[p]; });
      return Promise.all(snapshot.map(function (p) {
        return seal(data[p]).then(function (box) { cipherOf[p] = box; });
      }));
    }).then(flush, flush);
    return writing;
  }

  /* Ouvrir et sceller un document. */
  function seal(value) {
    if (!cryptoKey) return Promise.resolve({ __plain: value });
    var iv = window.crypto.getRandomValues(new Uint8Array(12));
    return subtle.encrypt({ name: "AES-GCM", iv: iv }, cryptoKey,
      new TextEncoder().encode(JSON.stringify(value)))
      .then(function (buf) { return { __enc: b64(buf), iv: b64(iv) }; });
  }

  function unseal(box) {
    if (!box || typeof box !== "object") return Promise.resolve(box);
    if (box.__plain !== undefined) return Promise.resolve(box.__plain);
    if (!box.__enc) return Promise.resolve(box);          // écrit avant le chiffrement
    if (!cryptoKey) return Promise.reject(new Error("verrouillé"));
    return subtle.decrypt({ name: "AES-GCM", iv: unb64(box.iv) }, cryptoKey, unb64(box.__enc))
      .then(function (buf) { return JSON.parse(new TextDecoder().decode(buf)); });
  }

  /* Au moment de la connexion : on ouvre ce qui est à nous, on met de côté le
     reste, et on rechiffre au passage ce qui serait resté en clair. */
  function loadStore(id) {
    var raw = rawStore(), mine = "data/users/" + id + "/";
    data = {}; cipherOf = {}; foreign = {};
    var aChiffrer = false, jobs = [];
    Object.keys(raw).forEach(function (p) {
      if (p.indexOf(mine) !== 0) { foreign[p] = raw[p]; return; }
      cipherOf[p] = raw[p];
      if (!raw[p] || !raw[p].__enc) aChiffrer = true;
      jobs.push(unseal(raw[p]).then(
        function (v) { data[p] = v; },
        function () { delete cipherOf[p]; }   // illisible : on ne l'écrase pas, on l'ignore
      ));
    });
    return Promise.all(jobs).then(function () {
      if (aChiffrer && cryptoKey) return persist();
      return null;
    });
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
  // Une photo de ticket porte une adresse, un montant, parfois les derniers
  // chiffres d'une carte : elle est scellée comme le reste.
  function sealBlob(blob) {
    if (!cryptoKey) return Promise.resolve(blob);
    var iv = window.crypto.getRandomValues(new Uint8Array(12));
    return blob.arrayBuffer().then(function (buf) {
      return subtle.encrypt({ name: "AES-GCM", iv: iv }, cryptoKey, buf);
    }).then(function (enc) {
      return { enc: enc, iv: iv, type: blob.type || "application/octet-stream" };
    });
  }

  function unsealBlob(rec) {
    if (rec instanceof Blob) return Promise.resolve(rec);   // écrit avant le chiffrement
    if (!rec || !rec.enc) return Promise.reject(new Error("illisible"));
    if (!cryptoKey) return Promise.reject(new Error("verrouillé"));
    return subtle.decrypt({ name: "AES-GCM", iv: rec.iv }, cryptoKey, rec.enc)
      .then(function (buf) { return new Blob([buf], { type: rec.type }); });
  }

  // Les URL d'objet sont préparées au démarrage pour que l'affichage reste
  // synchrone : le déchiffrement a lieu une fois, ici.
  function primeBlobs() {
    return withFiles("readonly", function (s) { return s.getAll ? s.getAll() : null; })
      .then(function (recs) {
        if (!recs) return null;
        return withFiles("readonly", function (s) { return s.getAllKeys ? s.getAllKeys() : null; })
          .then(function (keys) {
            if (!keys) return null;
            return Promise.all(keys.map(function (k, i) {
              var rec = recs[i];
              if (!rec) return null;
              var legacy = rec instanceof Blob;
              return unsealBlob(rec).then(function (blob) {
                window.__lapseBlobs[k] = URL.createObjectURL(blob);
                // Une pièce jointe d'avant le chiffrement : on la scelle.
                if (legacy && cryptoKey) {
                  return sealBlob(blob).then(function (box) {
                    return withFiles("readwrite", function (st) { st.put(box, k); });
                  });
                }
                return null;
              }).catch(function () { return null; });
            }));
          });
      })
      .catch(function () { return null; });
  }

  var files = {
    upload: function (blob) {
      var id = "f" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      return sealBlob(blob).then(function (box) {
        return withFiles("readwrite", function (s) { s.put(box, id); });
      }).then(function () {
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
    // Ici rien ne filtre l'extension : l'app peut proposer un vrai .ics.
    anyType: true,
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

  /* ============================================================= comptes
   *
   * Sur claude.ai, l'identité vient du compte Claude. Ici il n'y a pas de
   * serveur : les comptes vivent dans ce navigateur, et le mot de passe n'est
   * jamais stocké — seulement son empreinte PBKDF2 avec un sel tiré au hasard.
   *
   * Ce que ça protège : quelqu'un qui ouvre l'app sur cet appareil ne voit pas
   * tes fiches sans ton mot de passe, et deux personnes ont chacune les leurs.
   * Ce que ça ne protège pas : les données restent lisibles pour qui sait
   * ouvrir les outils du navigateur. C'est un verrou de confort, pas un coffre.
   */
  var ACC_KEY = "lapse-accounts-v1";
  var SES_KEY = "lapse-session-v1";
  var KEY_SES = "lapse-key-v1";
  var ITER = 150000;
  var cryptoKey = null;

  function readJSON(key, fallback) {
    try { return JSON.parse(window.localStorage.getItem(key)) || fallback; }
    catch (e) { return fallback; }
  }
  function writeJSON(key, value) {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* plein ou refusé */ }
  }

  var subtle = window.crypto && window.crypto.subtle;

  function b64(buf) {
    var b = new Uint8Array(buf), s = "";
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return window.btoa(s);
  }
  function unb64(str) {
    return Uint8Array.from(window.atob(str), function (c) { return c.charCodeAt(0); });
  }

  /* La clé de chiffrement est dérivée du mot de passe, avec un sel distinct de
     celui de l'empreinte : connaître l'un ne donne rien sur l'autre. */
  function deriveKey(password, saltB64) {
    return subtle.importKey("raw", new TextEncoder().encode(password), { name: "PBKDF2" }, false, ["deriveKey"])
      .then(function (k) {
        return subtle.deriveKey(
          { name: "PBKDF2", salt: unb64(saltB64), iterations: ITER, hash: "SHA-256" },
          k, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
      });
  }

  /* Une clé de données tirée au hasard chiffre les fiches. Elle n'est jamais
     écrite en clair à côté du compte : elle y est rangée deux fois, enfermée
     une fois par le mot de passe et une fois par la clé de secours. Changer de
     mot de passe ne touche donc pas aux fiches, et la clé de secours rouvre le
     coffre quand le mot de passe est oublié.

     Les comptes créés avant cette version ont pour clé de données celle que
     donnait le mot de passe ; elle est rangée de la même façon à la première
     connexion, sans rien rechiffrer.

     Où dort la clé une fois le coffre ouvert dépend du verrouillage choisi :
       aucun      → sur l'appareil, on reste connecté ;
       mot de passe ou Face ID → seulement le temps de l'onglet. */
  function kek(secret, saltB64) {
    return subtle.importKey("raw", new TextEncoder().encode(secret), { name: "PBKDF2" }, false, ["deriveKey"])
      .then(function (k) {
        return subtle.deriveKey(
          { name: "PBKDF2", salt: unb64(saltB64), iterations: ITER, hash: "SHA-256" },
          k, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      });
  }
  function enclose(lock, key) {
    var iv = window.crypto.getRandomValues(new Uint8Array(12));
    return subtle.exportKey("raw", key).then(function (raw) {
      return subtle.encrypt({ name: "AES-GCM", iv: iv }, lock, raw);
    }).then(function (buf) { return { iv: b64(iv), data: b64(buf) }; });
  }
  function disclose(lock, box) {
    return subtle.decrypt({ name: "AES-GCM", iv: unb64(box.iv) }, lock, unb64(box.data)).then(importRaw);
  }
  function importRaw(raw) {
    return subtle.importKey("raw", raw, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
  }
  function newDataKey() {
    return subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  }
  function wrapForPassword(acc, password, key) {
    var salt = newSalt();
    return kek(password, salt).then(function (l) { return enclose(l, key); }).then(function (box) {
      acc.wrap = acc.wrap || {};
      acc.wrap.pass = { salt: salt, iv: box.iv, data: box.data };
    });
  }
  function keyFromPassword(acc, password) {
    if (acc.wrap && acc.wrap.pass) {
      return kek(password, acc.wrap.pass.salt).then(function (l) { return disclose(l, acc.wrap.pass); });
    }
    return deriveKey(password, acc.keySalt);
  }

  /* La clé de secours : 32 caractères faciles à recopier, sans 0/O ni 1/I. */
  var ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  function newRecoveryCode() {
    var b = window.crypto.getRandomValues(new Uint8Array(32)), out = "";
    for (var i = 0; i < 32; i++) out += ALPHA.charAt(b[i] % 32);
    return out.match(/.{4}/g).join("-");
  }
  function cleanCode(code) {
    return String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/O/g, "0").replace(/I/g, "1");
  }
  function wrapForRecovery(acc, key) {
    var code = newRecoveryCode(), salt = newSalt();
    return kek(cleanCode(code), salt).then(function (l) { return enclose(l, key); }).then(function (box) {
      acc.wrap = acc.wrap || {};
      acc.wrap.rec = { salt: salt, iv: box.iv, data: box.data, at: new Date().toISOString() };
      return code;
    });
  }

  var KEY_TAB = "lapse-key-tab-v1";
  function lockOf(acc) { return (acc && acc.lock && acc.lock.mode) || "none"; }
  function rememberKey(key, acc) {
    cryptoKey = key;
    return subtle.exportKey("raw", key).then(function (raw) {
      var v = b64(raw), mode = lockOf(acc);
      try { window.sessionStorage.setItem(KEY_TAB, v); } catch (e) { /* ignore */ }
      try {
        // Face ID sans PRF ne fait que barrer l'entrée : la clé reste là.
        if (mode === "none" || (mode === "device" && !acc.lock.wrap)) window.localStorage.setItem(KEY_SES, v);
        else window.localStorage.removeItem(KEY_SES);
      } catch (e) { /* ignore */ }
    }).catch(function () { /* ignore */ });
  }
  function readKey(store) {
    var saved = null;
    try { saved = store.getItem(store === window.sessionStorage ? KEY_TAB : KEY_SES); } catch (e) { saved = null; }
    if (!saved) return Promise.resolve(null);
    return importRaw(unb64(saved)).catch(function () { return null; });
  }
  function recallKey() {
    return readKey(window.sessionStorage).then(function (k) {
      if (k) return { key: k, tab: true };
      return readKey(window.localStorage).then(function (k2) { return k2 ? { key: k2, tab: false } : null; });
    });
  }

  /* ----------------------------------------------- Face ID, Touch ID, Windows Hello
     Une clé d'accès de l'appareil. Quand le navigateur sait en tirer un secret
     (l'extension PRF : Safari 18, Chrome récents), ce secret enferme la clé de
     données, qui ne dort alors plus nulle part en clair. Sinon, la clé d'accès
     ne fait que barrer l'entrée de l'application. */
  function deviceAvailable() {
    if (!window.PublicKeyCredential || !PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) return Promise.resolve(false);
    return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(function () { return false; });
  }
  function rnd(n) { return window.crypto.getRandomValues(new Uint8Array(n)); }
  function prfOf(cred) {
    try {
      var ext = cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
      return ext && ext.prf && ext.prf.results && ext.prf.results.first ? new Uint8Array(ext.prf.results.first) : null;
    } catch (e) { return null; }
  }
  function deviceGet(lock) {
    return navigator.credentials.get({ publicKey: {
      challenge: rnd(32), timeout: 60000, userVerification: "required",
      allowCredentials: [{ type: "public-key", id: unb64(lock.cred) }],
      extensions: { prf: { eval: { first: unb64(lock.prfSalt) } } }
    } });
  }
  function prfLock(bytes) {
    return subtle.importKey("raw", bytes.slice(0, 32), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }
  function enrollDevice(acc, key) {
    var prfSalt = rnd(32);
    return navigator.credentials.create({ publicKey: {
      challenge: rnd(32), timeout: 60000,
      rp: { name: "Lapse" },
      user: { id: new TextEncoder().encode(acc.id).slice(0, 64), name: acc.first + " " + acc.last, displayName: acc.first + " " + acc.last },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "preferred" },
      extensions: { prf: { eval: { first: prfSalt } } }
    } }).then(function (cred) {
      if (!cred) throw new Error("annulé");
      var lock = { mode: "device", cred: b64(cred.rawId), prfSalt: b64(prfSalt) };
      var out = prfOf(cred);
      // Certains navigateurs ne livrent le secret qu'à la première lecture.
      var secret = out ? Promise.resolve(out) : deviceGet(lock).then(prfOf).catch(function () { return null; });
      return secret.then(function (bytes) {
        if (!bytes) return lock;
        return prfLock(bytes).then(function (l) { return enclose(l, key); }).then(function (box) {
          lock.wrap = box;
          return lock;
        });
      });
    });
  }
  function unlockWithDevice(acc) {
    var lock = acc.lock;
    return deviceGet(lock).then(function (cred) {
      if (!cred) throw new Error("annulé");
      if (!lock.wrap) return recallKey().then(function (r) {
        if (!r) throw new Error("clé absente");
        return r.key;
      });
      var bytes = prfOf(cred);
      if (!bytes) throw new Error("prf");
      return prfLock(bytes).then(function (l) { return disclose(l, lock.wrap); });
    });
  }

  function hash(password, saltB64) {
    var enc = new TextEncoder();
    var salt = Uint8Array.from(window.atob(saltB64), function (c) { return c.charCodeAt(0); });
    return subtle.importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveBits"])
      .then(function (key) {
        return subtle.deriveBits({ name: "PBKDF2", salt: salt, iterations: ITER, hash: "SHA-256" }, key, 256);
      })
      .then(b64);
  }

  function newSalt() {
    var s = new Uint8Array(16);
    window.crypto.getRandomValues(s);
    return b64(s);
  }

  function accounts() { return readJSON(ACC_KEY, {}); }
  function slug(first, last) {
    return (first + "-" + last).toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "compte";
  }

  function saveAccount(acc) {
    var all = accounts();
    all[acc.id] = acc;
    writeJSON(ACC_KEY, all);
  }

  function createAccount(first, last, password) {
    var all = accounts();
    var base = slug(first, last), id = base, n = 2;
    while (all[id]) id = base + "-" + (n++);
    var salt = newSalt(), acc = null, key = null, code = null;
    return Promise.all([hash(password, salt), newDataKey()]).then(function (r) {
      acc = { id: id, first: first, last: last, salt: salt, hash: r[0], createdAt: new Date().toISOString() };
      key = r[1];
      return wrapForPassword(acc, password, key);
    }).then(function () {
      return wrapForRecovery(acc, key);
    }).then(function (c) {
      code = c;
      saveAccount(acc);
      return rememberKey(key, acc);
    }).then(function () {
      return { acc: acc, code: code };
    });
  }

  function signIn(id, password) {
    var all = accounts(), acc = all[id];
    if (!acc) return Promise.reject(new Error("inconnu"));
    return hash(password, acc.salt).then(function (h) {
      if (h !== acc.hash) throw new Error("mot de passe");
      // Un compte créé avant le chiffrement n'a pas encore de sel de clé.
      if (!acc.keySalt && !(acc.wrap && acc.wrap.pass)) { acc.keySalt = newSalt(); saveAccount(acc); }
      return keyFromPassword(acc, password).then(function (key) {
        // Compte d'avant la clé de données : on range la clé une fois pour toutes.
        var step = (acc.wrap && acc.wrap.pass) ? Promise.resolve()
          : wrapForPassword(acc, password, key).then(function () { saveAccount(acc); });
        return step.then(function () { return rememberKey(key, acc); });
      }).then(function () { return acc; });
    });
  }

  /* Mot de passe oublié : la clé de secours rouvre le coffre, et on choisit
     un nouveau mot de passe dans la foulée. */
  function recoverAccount(id, code, password) {
    var acc = accounts()[id];
    if (!acc) return Promise.reject(new Error("inconnu"));
    if (!acc.wrap || !acc.wrap.rec) return Promise.reject(new Error("sans secours"));
    var key = null;
    return kek(cleanCode(code), acc.wrap.rec.salt).then(function (l) {
      return disclose(l, acc.wrap.rec);
    }).catch(function () { throw new Error("code"); }).then(function (k) {
      key = k;
      var salt = newSalt();
      return hash(password, salt).then(function (h) { acc.salt = salt; acc.hash = h; });
    }).then(function () {
      return wrapForPassword(acc, password, key);
    }).then(function () {
      // Face ID enfermait la même clé : il reste valable, rien à refaire.
      saveAccount(acc);
      return rememberKey(key, acc);
    }).then(function () { return acc; });
  }

  function initials(acc) {
    return ((acc.first || "?").charAt(0) + (acc.last || "").charAt(0)).toUpperCase();
  }

  function avatarFor(acc) {
    return "data:image/svg+xml;utf8," + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">' +
      '<rect width="48" height="48" rx="24" fill="#0E9FBF"/>' +
      '<text x="24" y="31" text-anchor="middle" font-family="-apple-system,Segoe UI,sans-serif" ' +
      'font-size="19" font-weight="600" fill="#fff">' + initials(acc) + "</text></svg>");
  }

  /* ------------------------------------------------- l'écran de connexion */

  function authStyles() {
    if (document.getElementById("lapseAuthCSS")) return;
    var st = document.createElement("style");
    st.id = "lapseAuthCSS";
    st.textContent = [
      "#lapseAuth{position:fixed;inset:0;height:100%;z-index:90;display:flex;align-items:center;",
      "justify-content:center;padding:max(20px,env(safe-area-inset-top)) 18px max(20px,env(safe-area-inset-bottom));",
      "background:var(--bg,#F1F2F6);overflow-y:auto;font-family:var(--font,-apple-system,sans-serif);color:var(--txt,#0B0C0E)}",
      "@supports (height:100dvh){#lapseAuth{height:100dvh}}",
      "#lapseAuth .box{width:100%;max-width:400px;display:flex;flex-direction:column;gap:18px;",
      "animation:lapseAuthIn .5s cubic-bezier(.22,1,.36,1) both}",
      "@keyframes lapseAuthIn{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}",
      "#lapseAuth h1{margin:0;font-size:28px;font-weight:600;letter-spacing:-.02em}",
      "#lapseAuth p.lead{margin:0;font-size:16px;color:var(--txt-2,#5B6370);line-height:1.45}",
      "#lapseAuth .mark{width:54px;height:54px;display:block}",
      "#lapseAuth label{display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:500;color:var(--txt-2,#5B6370)}",
      "#lapseAuth input{font:inherit;font-size:16px;padding:12px 16px;min-height:48px;border-radius:12px;",
      "border:1px solid var(--hair,rgba(60,60,67,.13));background:var(--surface,#fff);color:var(--txt,#0B0C0E);width:100%}",
      "#lapseAuth input:focus{outline:none;border-color:var(--accent,#0E9FBF)}",
      "#lapseAuth .two{display:grid;grid-template-columns:1fr 1fr;gap:12px}",
      "@media (max-width:420px){#lapseAuth .two{grid-template-columns:1fr}}",
      "#lapseAuth button.go{font:inherit;font-size:16px;font-weight:600;min-height:48px;border:0;border-radius:12px;",
      "background:var(--accent,#0E9FBF);color:var(--accent-ink,#fff);cursor:pointer;",
      "transition:transform .14s cubic-bezier(.22,1,.36,1),filter .2s}",
      "#lapseAuth button.go:active{transform:scale(.97)}",
      "#lapseAuth button.go[disabled]{opacity:.5;cursor:default}",
      "#lapseAuth button.alt{font:inherit;font-size:16px;font-weight:600;min-height:48px;border-radius:12px;cursor:pointer;",
      "background:var(--surface,#fff);color:var(--txt,#0B0C0E);border:1px solid var(--hair,rgba(60,60,67,.13));",
      "transition:transform .14s cubic-bezier(.22,1,.36,1)}",
      "#lapseAuth button.alt:active{transform:scale(.97)}",
      "#lapseAuth .pair{display:flex;flex-direction:column;gap:12px}",
      "#lapseAuth button.link{font:inherit;font-size:14px;font-weight:500;background:none;border:0;cursor:pointer;",
      "color:var(--accent-txt,#06708A);min-height:44px;padding:0}",
      "#lapseAuth .who{display:flex;flex-direction:column;gap:8px}",
      "#lapseAuth .who button{display:flex;align-items:center;gap:12px;font:inherit;text-align:left;cursor:pointer;",
      "background:var(--surface,#fff);border:1px solid var(--hair,rgba(60,60,67,.13));border-radius:12px;",
      "padding:12px 16px;min-height:60px;color:inherit;transition:border-color .18s,transform .14s}",
      "#lapseAuth .who button:active{transform:scale(.98)}",
      "#lapseAuth .who img{width:36px;height:36px;border-radius:50%;flex:0 0 auto}",
      "#lapseAuth .who b{display:block;font-size:16px;font-weight:500}",
      "#lapseAuth .who span{display:block;font-size:13px;color:var(--txt-2,#5B6370)}",
      "#lapseAuth .err{font-size:13px;color:var(--red,#D3362A);min-height:20px}",
      "#lapseAuth .fine{font-size:13px;color:var(--txt-3,#6E7681);line-height:1.45}",
      "#lapseAuth .code{font:600 17px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.04em;",
      "padding:16px;border-radius:12px;background:var(--surface,#fff);border:1px solid var(--hair,rgba(60,60,67,.13));",
      "text-align:center;overflow-wrap:anywhere;user-select:all;-webkit-user-select:all}",
      "#lapseAuth .row{display:flex;gap:24px;justify-content:center}",
      "#lapseAuth label.check{flex-direction:row;align-items:center;gap:12px;font-size:15px;min-height:44px;cursor:pointer}",
      "#lapseAuth label.check input{width:22px;height:22px;min-height:0;padding:0;accent-color:var(--accent,#0E9FBF)}",
      "@media (prefers-reduced-motion:reduce){#lapseAuth .box{animation:none}}"
    ].join("");
    document.head.appendChild(st);
  }

  var MARK = '<svg class="mark" viewBox="0 0 48 48" aria-hidden="true">' +
    '<rect x="1" y="1" width="46" height="46" rx="12.5" fill="var(--surface-3,#EBEDF2)"/>' +
    '<g fill="var(--accent,#0E9FBF)"><path d="M15.5 13.5 H25 V31 H34 l2.3 2 l-2.3 2 l2.3 2 l-2.3 2 H15.5 Z"/>' +
    '<rect x="13" y="8.6" width="14" height="6.3" rx="3.15"/></g></svg>';

  function askAccount(lockedAcc) {
    authStyles();
    return new Promise(function (resolve) {
      var all = accounts();
      var ids = Object.keys(all);
      var host = document.createElement("div");
      host.id = "lapseAuth";
      document.body.appendChild(host);

      function done(acc) {
        try { window.localStorage.setItem(SES_KEY, acc.id); } catch (e) { /* ignore */ }
        host.remove();
        resolve(acc);
      }

      function screenChoose() {
        host.innerHTML = "";
        var box = el("div", "box");
        box.innerHTML = MARK +
          "<h1>Content de te revoir</h1>" +
          '<p class="lead">Choisis ton compte sur cet appareil.</p>';
        var who = el("div", "who");
        ids.forEach(function (id) {
          var a = all[id];
          var b = document.createElement("button");
          b.type = "button";
          b.innerHTML = '<img src="' + avatarFor(a) + '" alt="">' +
            "<span><b>" + esc(a.first + " " + a.last) + "</b>" +
            "<span>Se connecter</span></span>";
          b.addEventListener("click", function () { screenPassword(a); });
          who.appendChild(b);
        });
        box.appendChild(who);
        box.appendChild(backLink(screenWelcome));
        host.appendChild(box);
      }

      function backLink(to, label) {
        var b = document.createElement("button");
        b.type = "button"; b.className = "link";
        b.textContent = label || "Retour";
        b.addEventListener("click", to);
        return b;
      }

      /* L'accueil : se connecter ou créer un compte, toujours les deux. */
      function screenWelcome() {
        host.innerHTML = "";
        var box = el("div", "box");
        box.innerHTML = MARK + "<h1>Bienvenue dans Lapse</h1>" +
          '<p class="lead">Les dates qui coûtent de l\'argent quand on les oublie : garanties, abonnements, péremption, entretien.</p>';
        var pair = el("div", "pair");
        var login = document.createElement("button");
        login.type = "button"; login.className = "go"; login.textContent = "Se connecter";
        login.addEventListener("click", screenSignIn);
        var create = document.createElement("button");
        create.type = "button"; create.className = "alt"; create.textContent = "Créer un compte";
        create.addEventListener("click", screenCreate);
        pair.appendChild(login); pair.appendChild(create);
        box.appendChild(pair);
        host.appendChild(box);
        login.focus();
      }

      function screenSignIn() {
        if (ids.length === 1) return screenPassword(all[ids[0]]);
        if (ids.length > 1) return screenChoose();
        host.innerHTML = "";
        var box = el("div", "box");
        box.innerHTML = MARK + "<h1>Aucun compte ici</h1>";
        box.appendChild(el("p", "lead",
          "Les comptes Lapse vivent sur l'appareil où ils ont été créés : il n'y a pas de serveur pour les retrouver ailleurs. " +
          "Crée un compte, puis restaure ta sauvegarde complète depuis Réglages pour retrouver tes fiches."));
        var go = document.createElement("button");
        go.type = "button"; go.className = "go"; go.textContent = "Créer un compte";
        go.addEventListener("click", screenCreate);
        box.appendChild(go);
        box.appendChild(backLink(screenWelcome));
        host.appendChild(box);
      }

      function screenPassword(acc) {
        host.innerHTML = "";
        var box = el("div", "box");
        box.innerHTML = MARK +
          "<h1>Bonjour " + esc(acc.first) + "</h1>" +
          '<p class="lead">Entre ton mot de passe pour ouvrir tes fiches.</p>';
        var lab = document.createElement("label");
        lab.innerHTML = "<span>Mot de passe</span>";
        var inp = document.createElement("input");
        inp.type = "password";
        inp.autocomplete = "current-password";
        lab.appendChild(inp);
        var err = el("div", "err");
        var go = document.createElement("button");
        go.type = "button"; go.className = "go"; go.textContent = "Se connecter";
        function tenter() {
          err.textContent = "";
          if (!inp.value) { err.textContent = "Il manque le mot de passe"; return; }
          go.disabled = true;
          signIn(acc.id, inp.value).then(done).catch(function () {
            go.disabled = false;
            err.textContent = "Mot de passe incorrect";
            inp.select();
          });
        }
        go.addEventListener("click", tenter);
        inp.addEventListener("keydown", function (e) { if (e.key === "Enter") tenter(); });
        box.appendChild(lab); box.appendChild(err); box.appendChild(go);
        box.appendChild(forgotLink(acc));
        box.appendChild(ids.length > 1 ? backLink(screenChoose, "Changer de compte") : backLink(screenWelcome));
        host.appendChild(box);
        inp.focus();
      }

      function screenCreate() {
        host.innerHTML = "";
        var box = el("div", "box");
        box.innerHTML = MARK +
          "<h1>Créer un compte</h1>" +
          '<p class="lead">Un compte sur cet appareil, pour que tes fiches restent les tiennes.</p>';
        var two = el("div", "two");
        var lf = champ("Prénom", "text", "given-name");
        var ll = champ("Nom", "text", "family-name");
        two.appendChild(lf.label); two.appendChild(ll.label);
        var lp = champ("Mot de passe", "password", "new-password");
        var lp2 = champ("Confirmer", "password", "new-password");
        var err = el("div", "err");
        var go = document.createElement("button");
        go.type = "button"; go.className = "go"; go.textContent = "Créer mon compte";
        function creer() {
          err.textContent = "";
          var f = lf.input.value.trim(), l = ll.input.value.trim();
          var p = lp.input.value, p2 = lp2.input.value;
          if (!f || !l) { err.textContent = "Il manque le prénom ou le nom"; return; }
          if (p.length < 6) { err.textContent = "Le mot de passe doit faire au moins 6 caractères"; return; }
          if (p !== p2) { err.textContent = "Les deux mots de passe ne correspondent pas"; return; }
          go.disabled = true;
          createAccount(f, l, p).then(function (r) {
            screenCode(r.code, function () { done(r.acc); });
          }).catch(function () {
            go.disabled = false;
            err.textContent = "La création a échoué sur cet appareil";
          });
        }
        go.addEventListener("click", creer);
        [lf, ll, lp, lp2].forEach(function (c) {
          c.input.addEventListener("keydown", function (e) { if (e.key === "Enter") creer(); });
        });
        box.appendChild(two); box.appendChild(lp.label); box.appendChild(lp2.label);
        box.appendChild(err); box.appendChild(go);
        box.appendChild(backLink(screenWelcome));
        box.appendChild(el("p", "fine",
          "Le mot de passe n'est enregistré nulle part : seule son empreinte l'est. " +
          "Tes fiches et tes photos sont chiffrées sur cet appareil. À l'étape suivante, " +
          "tu reçois une clé de secours : c'est elle qui rouvre tes fiches si tu oublies le mot de passe."));
        host.appendChild(box);
        lf.input.focus();
      }

      function forgotLink(acc) {
        var b = document.createElement("button");
        b.type = "button"; b.className = "link";
        b.textContent = "Mot de passe oublié ?";
        b.addEventListener("click", function () { screenForgot(acc); });
        return b;
      }

      /* La clé de secours, montrée une seule fois. */
      function screenCode(code, next) {
        host.innerHTML = "";
        var box = el("div", "box");
        box.innerHTML = MARK + "<h1>Ta clé de secours</h1>" +
          '<p class="lead">Si tu oublies ton mot de passe, cette clé est le seul moyen de rouvrir tes fiches. Note-la sur papier ou dans ton gestionnaire de mots de passe.</p>';
        var c = el("div", "code", code);
        c.setAttribute("aria-label", "Clé de secours : " + code.split("").join(" "));
        var row = el("div", "row");
        var copy = document.createElement("button");
        copy.type = "button"; copy.className = "link"; copy.textContent = "Copier";
        copy.addEventListener("click", function () {
          try { navigator.clipboard.writeText(code).then(function () { copy.textContent = "Copiée"; }); } catch (e) { /* ignore */ }
        });
        var save = document.createElement("button");
        save.type = "button"; save.className = "link"; save.textContent = "Enregistrer en fichier";
        save.addEventListener("click", function () {
          downloads.save({ filename: "lapse-cle-de-secours.txt",
            data: "Clé de secours Lapse\n\n" + code + "\n\nElle rouvre tes fiches si tu oublies ton mot de passe. Garde-la à l'abri.\n" });
        });
        row.appendChild(copy); row.appendChild(save);
        var lab = document.createElement("label");
        lab.className = "check";
        var cb = document.createElement("input");
        cb.type = "checkbox";
        lab.appendChild(cb);
        lab.appendChild(el("span", null, "Je l'ai notée en lieu sûr"));
        var go = document.createElement("button");
        go.type = "button"; go.className = "go"; go.textContent = "Continuer"; go.disabled = true;
        cb.addEventListener("change", function () { go.disabled = !cb.checked; });
        go.addEventListener("click", next);
        box.appendChild(c); box.appendChild(row); box.appendChild(lab); box.appendChild(go);
        host.appendChild(box);
      }

      function screenForgot(acc) {
        host.innerHTML = "";
        var box = el("div", "box");
        box.innerHTML = MARK + "<h1>Mot de passe oublié</h1>";
        if (!acc.wrap || !acc.wrap.rec) {
          box.appendChild(el("p", "lead", "Ce compte n'a pas de clé de secours : sans le mot de passe, ses fiches ne peuvent pas être rouvertes. Si tu as une sauvegarde complète, crée un nouveau compte et restaure-la."));
        } else {
          box.appendChild(el("p", "lead", "Entre ta clé de secours, puis choisis un nouveau mot de passe."));
          var lc = champ("Clé de secours", "text", "off");
          lc.input.autocapitalize = "characters"; lc.input.spellcheck = false;
          lc.input.placeholder = "XXXX-XXXX-XXXX-…";
          var lp = champ("Nouveau mot de passe", "password", "new-password");
          var lp2 = champ("Confirmer", "password", "new-password");
          var err = el("div", "err");
          err.setAttribute("role", "alert");
          var go = document.createElement("button");
          go.type = "button"; go.className = "go"; go.textContent = "Rouvrir mes fiches";
          go.addEventListener("click", function () {
            err.textContent = "";
            if (cleanCode(lc.input.value).length !== 32) { err.textContent = "La clé fait 32 caractères"; return; }
            if (lp.input.value.length < 6) { err.textContent = "Le mot de passe doit faire au moins 6 caractères"; return; }
            if (lp.input.value !== lp2.input.value) { err.textContent = "Les deux mots de passe ne correspondent pas"; return; }
            go.disabled = true;
            recoverAccount(acc.id, lc.input.value, lp.input.value).then(done).catch(function (e) {
              go.disabled = false;
              err.textContent = e && e.message === "code" ? "Cette clé ne correspond pas à ce compte" : "La récupération a échoué";
            });
          });
          box.appendChild(lc.label); box.appendChild(lp.label); box.appendChild(lp2.label);
          box.appendChild(err); box.appendChild(go);
        }
        var back = document.createElement("button");
        back.type = "button"; back.className = "link"; back.textContent = "Retour";
        back.addEventListener("click", function () { lockedAcc ? screenUnlock(acc) : screenPassword(acc); });
        box.appendChild(back);
        host.appendChild(box);
      }

      /* L'app est verrouillée : Face ID d'abord quand il est réglé, le mot
         de passe toujours possible. */
      function screenUnlock(acc) {
        host.innerHTML = "";
        var box = el("div", "box");
        box.innerHTML = MARK + "<h1>Lapse est verrouillé</h1>" +
          '<p class="lead">' + esc(acc.first) + ", déverrouille pour ouvrir tes fiches.</p>";
        var err = el("div", "err");
        err.setAttribute("role", "alert");
        if (lockOf(acc) === "device") {
          var dev = document.createElement("button");
          dev.type = "button"; dev.className = "go"; dev.textContent = "Déverrouiller avec Face ID";
          var tryDevice = function (auto) {
            err.textContent = "";
            dev.disabled = true;
            unlockWithDevice(acc).then(function (key) {
              return rememberKey(key, acc);
            }).then(function () { done(acc); }).catch(function () {
              dev.disabled = false;
              // Lancé tout seul, un refus vient souvent du navigateur qui veut
              // un appui : on laisse le bouton, sans parler d'échec.
              err.textContent = auto ? "" : "Non reconnu. Réessaie ou utilise ton mot de passe.";
            });
          };
          dev.addEventListener("click", function () { tryDevice(false); });
          box.appendChild(dev);
          // Dès que l'écran est là, Face ID se lance : pas besoin d'appuyer.
          window.setTimeout(function () {
            if (document.visibilityState === "visible") tryDevice(true);
            else document.addEventListener("visibilitychange", function once() {
              if (document.visibilityState !== "visible") return;
              document.removeEventListener("visibilitychange", once);
              tryDevice(true);
            });
          }, 250);
        }
        var lab = document.createElement("label");
        lab.innerHTML = "<span>Mot de passe</span>";
        var inp = document.createElement("input");
        inp.type = "password"; inp.autocomplete = "current-password";
        lab.appendChild(inp);
        var go = document.createElement("button");
        go.type = "button"; go.className = lockOf(acc) === "device" ? "link" : "go";
        go.textContent = lockOf(acc) === "device" ? "Utiliser le mot de passe" : "Déverrouiller";
        function tenter() {
          err.textContent = "";
          if (!inp.value) { inp.focus(); return; }
          go.disabled = true;
          signIn(acc.id, inp.value).then(done).catch(function () {
            go.disabled = false;
            err.textContent = "Mot de passe incorrect";
            inp.select();
          });
        }
        go.addEventListener("click", tenter);
        inp.addEventListener("keydown", function (e) { if (e.key === "Enter") tenter(); });
        box.appendChild(lab); box.appendChild(err); box.appendChild(go);
        box.appendChild(forgotLink(acc));
        var other = document.createElement("button");
        other.type = "button"; other.className = "link"; other.textContent = "Changer de compte";
        other.addEventListener("click", function () {
          try { window.localStorage.removeItem(SES_KEY); } catch (e) { /* ignore */ }
          if (ids.length > 1) screenChoose(); else screenPassword(acc);
        });
        if (ids.length > 1) box.appendChild(other);
        host.appendChild(box);
        if (lockOf(acc) !== "device") inp.focus();
      }

      if (lockedAcc) screenUnlock(lockedAcc);
      else screenWelcome();
    });
  }

  function champ(nom, type, autocomplete) {
    var label = document.createElement("label");
    var s = document.createElement("span");
    s.textContent = nom;
    var input = document.createElement("input");
    input.type = type;
    input.autocomplete = autocomplete;
    label.appendChild(s); label.appendChild(input);
    return { label: label, input: input };
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /* La session : une promesse unique, attendue par toutes les capacités, pour
     que les fiches soient rangées sous le bon compte dès la première lecture. */
  var account = null;
  var session = null;

  function ready() {
    if (session) return session;
    session = new Promise(function (resolve) {
      // Sans WebCrypto (page ouverte en file://), ni mot de passe ni
      // chiffrement tenables : on reste sur une identité d'appareil plutôt
      // que de faire semblant.
      if (!subtle) {
        account = { id: "local", first: "Cet", last: "appareil" };
        loadStore(account.id).then(function () { resolve(account); });
        return;
      }
      var all = accounts();
      var saved = null;
      try { saved = window.localStorage.getItem(SES_KEY); } catch (e) { saved = null; }

      function finish(acc) {
        account = acc;
        return loadStore(acc.id).then(function () { resolve(acc); });
      }

      var mine = saved && all[saved] ? all[saved] : null;
      var start = function () {
        return document.readyState === "loading"
          ? new Promise(function (ok) { document.addEventListener("DOMContentLoaded", ok); })
          : Promise.resolve();
      };
      (mine ? recallKey() : Promise.resolve(null)).then(function (r) {
        var mode = lockOf(mine);
        if (r && (r.tab || mode === "none")) { cryptoKey = r.key; return finish(mine); }
        cryptoKey = null;
        // Verrouillé : on reconnaît le compte, on demande seulement d'ouvrir.
        if (mine && mode !== "none") return start().then(function () { return askAccount(mine); }).then(finish);
        return start().then(function () { return askAccount(); }).then(finish);
      });
    });
    return session;
  }

  function fullName() {
    return account ? (account.first + " " + account.last).trim() : "Cet appareil";
  }

  var user = {
    id: function () { return ready().then(function (a) { return a.id; }); },
    me: function () {
      return ready().then(function (a) {
        return {
          id: a.id, name: fullName(), avatarUrl: avatarFor(a), color: "#0E9FBF",
          email: null, isOwner: true, canEdit: true,
          role: subtle ? "Compte local, sur cet appareil" : "Cet appareil"
        };
      });
    },
    can: function () { return ready().then(function () { return true; }); },
    isOwner: function () { return ready().then(function () { return true; }); },
    canEdit: function () { return ready().then(function () { return true; }); },
    profiles: function () { return Promise.resolve({}); },
    name: function () { return ready().then(fullName); },
    avatarUrl: function () { return ready().then(function (a) { return avatarFor(a); }); },
    search: function () { return Promise.resolve([]); },
    email: function () { return Promise.resolve(null); },
    // Propre au runtime local : l'app n'affiche le bouton que s'il existe.
    signOut: subtle ? function () {
      cryptoKey = null;
      try {
        window.localStorage.removeItem(SES_KEY);
        window.localStorage.removeItem(KEY_SES);
        window.sessionStorage.removeItem(SES_KEY);
        window.sessionStorage.removeItem(KEY_SES);
        window.sessionStorage.removeItem(KEY_TAB);
      } catch (e) { /* ignore */ }
      window.location.reload();
      return Promise.resolve();
    } : null,

    /* Changer de mot de passe : la clé de données ne bouge pas, seule son
       enveloppe change. Rien n'est rechiffré, rien ne peut rester à moitié. */
    changePassword: subtle ? function (oldPw, newPw) {
      return ready().then(function (a) {
        var acc = accounts()[a.id];
        if (!acc || !cryptoKey) throw new Error("inconnu");
        return hash(oldPw, acc.salt).then(function (h) {
          if (h !== acc.hash) throw new Error("mot de passe");
          var salt = newSalt();
          return hash(newPw, salt).then(function (h2) {
            acc.salt = salt; acc.hash = h2;
            return wrapForPassword(acc, newPw, cryptoKey);
          });
        }).then(function () {
          saveAccount(acc);
          account = acc;
          return rememberKey(cryptoKey, acc);
        });
      });
    } : null,

    /* La clé de secours : savoir s'il y en a une, en faire une nouvelle. */
    recoveryInfo: subtle ? function () {
      return ready().then(function (a) {
        var acc = accounts()[a.id] || a;
        return { has: !!(acc.wrap && acc.wrap.rec), at: acc.wrap && acc.wrap.rec ? acc.wrap.rec.at : null };
      });
    } : null,
    newRecoveryCode: subtle ? function (password) {
      return ready().then(function (a) {
        var acc = accounts()[a.id];
        if (!acc || !cryptoKey) throw new Error("inconnu");
        return hash(password, acc.salt).then(function (h) {
          if (h !== acc.hash) throw new Error("mot de passe");
          var step = (acc.wrap && acc.wrap.pass) ? Promise.resolve() : wrapForPassword(acc, password, cryptoKey);
          return step.then(function () { return wrapForRecovery(acc, cryptoKey); });
        }).then(function (code) {
          saveAccount(acc);
          account = acc;
          return code;
        });
      });
    } : null,

    /* Le verrouillage à l'ouverture : aucun, mot de passe, ou Face ID. */
    lockInfo: subtle ? function () {
      return Promise.all([ready(), deviceAvailable()]).then(function (r) {
        var acc = accounts()[r[0].id] || r[0];
        return { mode: lockOf(acc), device: !!r[1], strong: !!(acc.lock && acc.lock.wrap) };
      });
    } : null,
    setLock: subtle ? function (mode, password) {
      return ready().then(function (a) {
        var acc = accounts()[a.id];
        if (!acc || !cryptoKey) throw new Error("inconnu");
        return hash(password, acc.salt).then(function (h) {
          if (h !== acc.hash) throw new Error("mot de passe");
          var step = (acc.wrap && acc.wrap.pass) ? Promise.resolve() : wrapForPassword(acc, password, cryptoKey);
          return step.then(function () {
            if (mode === "device") return enrollDevice(acc, cryptoKey);
            if (mode === "password") return { mode: "password" };
            return null;
          });
        }).then(function (lock) {
          if (lock) acc.lock = lock; else delete acc.lock;
          saveAccount(acc);
          account = acc;
          return rememberKey(cryptoKey, acc).then(function () {
            return { mode: lockOf(acc), strong: !!(acc.lock && acc.lock.wrap) };
          });
        });
      });
    } : null,

    /* Supprimer le compte : ses documents, ses pièces jointes, puis lui. Les
       autres comptes de l'appareil ne sont pas touchés. */
    deleteAccount: subtle ? function (password, blobIds) {
      return ready().then(function (acc) {
        var all = accounts(), rec = all[acc.id];
        if (!rec) throw new Error("inconnu");
        return hash(password, rec.salt).then(function (h) {
          if (h !== rec.hash) throw new Error("mot de passe");
          return Promise.all((blobIds || []).map(function (id) { return files.delete(id); }));
        }).then(function () {
          return writing || null;
        }).then(function () {
          data = {}; cipherOf = {};
          flush();
          delete all[acc.id];
          writeJSON(ACC_KEY, all);
          return user.signOut();
        });
      });
    } : null
  };

  /* ------------------------------------------------------------- façade */

  // Les images d'abord, puis la session : tant que personne n'est connecté,
  // aucune capacité ne répond, donc l'application attend sagement derrière
  // l'écran de connexion au lieu de lire les fiches de quelqu'un d'autre.
  /* Deux onglets ouverts : quand l'un écrit, l'autre relit. Sans cela, chacun
     réécrivait le magasin entier depuis sa mémoire et effaçait les ajouts de
     l'autre. */
  window.addEventListener("storage", function (e) {
    if (e.key !== STORE_KEY || !account || !cryptoKey) return;
    loadStore(account.id).then(function () {
      watchers.slice().forEach(function (w) { w(); });
    });
  });

  /* Verrouillée par Face ID ou mot de passe, l'app se referme quand on la
     quitte plus de cinq minutes : au retour, Face ID se relance tout seul. */
  var RELOCK_MS = 5 * 60 * 1000, hiddenAt = 0;
  document.addEventListener("visibilitychange", function () {
    if (!account || !subtle) return;
    var acc = accounts()[account.id] || account;
    if (lockOf(acc) === "none") return;
    if (document.visibilityState === "hidden") { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt >= RELOCK_MS) {
      try { window.sessionStorage.removeItem(KEY_TAB); } catch (e) { /* ignore */ }
      window.location.reload();
    }
    hiddenAt = 0;
  });

  var blobsReady = null;

  function afterLogin(value) {
    return ready().then(function () {
      // Après la connexion seulement : avant, la clé n'est pas là et les
      // photos chiffrées restaient sans adresse.
      return blobsReady || (blobsReady = primeBlobs());
    }).then(function () { return value; });
  }

  /* ------------------------------------------------------- notifications
     Les échéances à venir sont confiées au service worker sous une forme
     réduite — titre, date, jours de rappel — dans une base à part, en clair :
     sans cela, il ne pourrait pas prévenir sans ouvrir l'application. C'est
     pourquoi cette option est à activer, jamais active d'office.

     Ce que le navigateur permet : Chrome sur Android, app installée, vérifie
     même app fermée (synchronisation périodique). Safari sur iPhone ne réveille
     pas une app web sans serveur : les rappels y partent à l'ouverture. */
  var NOTE_DB = "lapse-notify";
  function withNotes(mode, run) {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error("indexeddb")); return; }
      var req = window.indexedDB.open(NOTE_DB, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore("kv"); };
      req.onerror = function () { reject(req.error); };
      req.onsuccess = function () {
        var tx = req.result.transaction("kv", mode);
        var r = run(tx.objectStore("kv"));
        tx.oncomplete = function () { resolve(r ? r.result : undefined); };
        tx.onerror = function () { reject(tx.error); };
      };
    });
  }
  function swReg() {
    if (!("serviceWorker" in navigator)) return Promise.resolve(null);
    return navigator.serviceWorker.getRegistration().then(function (r) { return r || null; }).catch(function () { return null; });
  }
  window.__lapseNotify = {
    supported: function () {
      return "Notification" in window && "serviceWorker" in navigator && /^https?:$/.test(window.location.protocol);
    },
    permission: function () { return "Notification" in window ? Notification.permission : "denied"; },
    enable: function () {
      if (!this.supported()) return Promise.resolve(false);
      return Promise.resolve(Notification.requestPermission()).then(function (p) {
        if (p !== "granted") return false;
        return swReg().then(function (reg) {
          if (reg && reg.periodicSync) {
            return reg.periodicSync.register("lapse-check", { minInterval: 12 * 3600 * 1000 })
              .catch(function () { /* pas installée : rappels à l'ouverture */ })
              .then(function () { return true; });
          }
          return true;
        });
      });
    },
    disable: function () {
      return withNotes("readwrite", function (st) { st.put([], "schedule"); }).catch(function () {})
        .then(swReg).then(function (reg) {
          if (reg && reg.periodicSync) return reg.periodicSync.unregister("lapse-check").catch(function () {});
        });
    },
    sync: function (entries) {
      if (!this.supported() || Notification.permission !== "granted") return Promise.resolve();
      return withNotes("readwrite", function (st) { st.put(entries || [], "schedule"); })
        .then(function () { return navigator.serviceWorker.ready; })
        .then(function (reg) { if (reg.active) reg.active.postMessage({ type: "lapse-check" }); })
        .catch(function () { /* sans conséquence */ });
    }
  };

  /* Hors ligne : un service worker garde la dernière version vue de l'app.
     Il préfère toujours le réseau, donc une mise à jour arrive d'elle-même. */
  if ("serviceWorker" in navigator && /^https?:$/.test(window.location.protocol)) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () { /* sans conséquence */ });
    });
  }

  window.claude = {
    use: function (name) {
      if (name === "db") return afterLogin(store);
      if (name === "assets") return afterLogin(files);
      if (name === "downloads") return afterLogin(downloads);
      if (name === "user") return Promise.resolve(user);
      // La lecture des tickets passe par l'OCR du navigateur (scan-local.js).
      if (name === "sample") return Promise.resolve(window.__lapseLocalSample || null);
      return Promise.resolve(null);
    }
  };
})();
