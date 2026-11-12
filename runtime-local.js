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

  /* La clé reste sur cet appareil : une fois connecté, on le reste, et le mot
     de passe n'est redemandé que pour changer de compte ou après déconnexion.
     Le revers est net : la clé dort à côté des données qu'elle chiffre. Le
     chiffrement protège donc d'un regard de passage, pas de quelqu'un qui
     saurait fouiller le stockage de ce navigateur. */
  function rememberKey(key) {
    cryptoKey = key;
    return subtle.exportKey("raw", key).then(function (raw) {
      try { window.localStorage.setItem(KEY_SES, b64(raw)); } catch (e) { /* ignore */ }
    }).catch(function () { /* ignore */ });
  }

  function recallKey() {
    var saved = null;
    try { saved = window.localStorage.getItem(KEY_SES); } catch (e) { saved = null; }
    if (!saved) return Promise.resolve(null);
    return subtle.importKey("raw", unb64(saved), { name: "AES-GCM" }, true, ["encrypt", "decrypt"])
      .then(function (k) { cryptoKey = k; return k; })
      .catch(function () { return null; });
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

  function createAccount(first, last, password) {
    var all = accounts();
    var base = slug(first, last), id = base, n = 2;
    while (all[id]) id = base + "-" + (n++);
    var salt = newSalt(), keySalt = newSalt();
    return hash(password, salt).then(function (h) {
      all[id] = { id: id, first: first, last: last, salt: salt, keySalt: keySalt,
                  hash: h, createdAt: new Date().toISOString() };
      writeJSON(ACC_KEY, all);
      return deriveKey(password, keySalt).then(rememberKey).then(function () { return all[id]; });
    });
  }

  function signIn(id, password) {
    var all = accounts(), acc = all[id];
    if (!acc) return Promise.reject(new Error("inconnu"));
    return hash(password, acc.salt).then(function (h) {
      if (h !== acc.hash) throw new Error("mot de passe");
      // Un compte créé avant le chiffrement n'a pas encore de sel de clé.
      if (!acc.keySalt) { acc.keySalt = newSalt(); all[id] = acc; writeJSON(ACC_KEY, all); }
      return deriveKey(password, acc.keySalt).then(rememberKey).then(function () { return acc; });
    });
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
      "animation:lapseAuthIn .5s cubic-bezier(.32,.72,0,1) both}",
      "@keyframes lapseAuthIn{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}",
      "#lapseAuth h1{margin:0;font-size:28px;font-weight:700;letter-spacing:-.025em}",
      "#lapseAuth p.lead{margin:0;font-size:15.5px;color:var(--txt-2,#5B6370);line-height:1.45}",
      "#lapseAuth .mark{width:54px;height:54px;display:block}",
      "#lapseAuth label{display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:500;color:var(--txt-2,#5B6370)}",
      "#lapseAuth input{font:inherit;font-size:16px;padding:12px 14px;min-height:46px;border-radius:12px;",
      "border:1px solid var(--hair,rgba(60,60,67,.13));background:var(--surface,#fff);color:var(--txt,#0B0C0E);width:100%}",
      "#lapseAuth input:focus{outline:none;border-color:var(--accent,#0E9FBF)}",
      "#lapseAuth .two{display:grid;grid-template-columns:1fr 1fr;gap:10px}",
      "@media (max-width:420px){#lapseAuth .two{grid-template-columns:1fr}}",
      "#lapseAuth button.go{font:inherit;font-size:16px;font-weight:600;min-height:50px;border:0;border-radius:14px;",
      "background:var(--accent,#0E9FBF);color:var(--accent-ink,#fff);cursor:pointer;",
      "transition:transform .14s cubic-bezier(.32,.72,0,1),filter .2s}",
      "#lapseAuth button.go:active{transform:scale(.97)}",
      "#lapseAuth button.go[disabled]{opacity:.5;cursor:default}",
      "#lapseAuth button.link{font:inherit;font-size:14.5px;font-weight:600;background:none;border:0;cursor:pointer;",
      "color:var(--accent-txt,#06708A);min-height:44px;padding:0}",
      "#lapseAuth .who{display:flex;flex-direction:column;gap:8px}",
      "#lapseAuth .who button{display:flex;align-items:center;gap:12px;font:inherit;text-align:left;cursor:pointer;",
      "background:var(--surface,#fff);border:1px solid var(--hair,rgba(60,60,67,.13));border-radius:14px;",
      "padding:12px 14px;min-height:60px;color:inherit;transition:border-color .18s,transform .14s}",
      "#lapseAuth .who button:active{transform:scale(.98)}",
      "#lapseAuth .who img{width:36px;height:36px;border-radius:50%;flex:0 0 auto}",
      "#lapseAuth .who b{display:block;font-size:15.5px;font-weight:600}",
      "#lapseAuth .who span{display:block;font-size:12.5px;color:var(--txt-2,#5B6370)}",
      "#lapseAuth .err{font-size:13.5px;color:var(--red,#D3362A);min-height:18px}",
      "#lapseAuth .fine{font-size:12.5px;color:var(--txt-3,#6E7681);line-height:1.45}",
      "@media (prefers-reduced-motion:reduce){#lapseAuth .box{animation:none}}"
    ].join("");
    document.head.appendChild(st);
  }

  var MARK = '<svg class="mark" viewBox="0 0 48 48" aria-hidden="true">' +
    '<rect x="1" y="1" width="46" height="46" rx="12.5" fill="var(--surface-3,#EBEDF2)"/>' +
    '<g fill="var(--accent,#0E9FBF)"><path d="M15.5 13.5 H25 V31 H34 l2.3 2 l-2.3 2 l2.3 2 l-2.3 2 H15.5 Z"/>' +
    '<rect x="13" y="8.6" width="14" height="6.3" rx="3.15"/></g></svg>';

  function askAccount() {
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
        var nouveau = document.createElement("button");
        nouveau.type = "button";
        nouveau.className = "link";
        nouveau.textContent = "Créer un autre compte";
        nouveau.addEventListener("click", screenCreate);
        box.appendChild(nouveau);
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
          if (!inp.value) { err.textContent = "Il manque le mot de passe."; return; }
          go.disabled = true;
          signIn(acc.id, inp.value).then(done).catch(function () {
            go.disabled = false;
            err.textContent = "Mot de passe incorrect.";
            inp.select();
          });
        }
        go.addEventListener("click", tenter);
        inp.addEventListener("keydown", function (e) { if (e.key === "Enter") tenter(); });
        box.appendChild(lab); box.appendChild(err); box.appendChild(go);
        if (ids.length > 1 || true) {
          var back = document.createElement("button");
          back.type = "button"; back.className = "link";
          back.textContent = ids.length > 1 ? "Changer de compte" : "Créer un compte";
          back.addEventListener("click", ids.length > 1 ? screenChoose : screenCreate);
          box.appendChild(back);
        }
        host.appendChild(box);
        inp.focus();
      }

      function screenCreate() {
        host.innerHTML = "";
        var box = el("div", "box");
        box.innerHTML = MARK +
          "<h1>Bienvenue dans Lapse</h1>" +
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
          if (!f || !l) { err.textContent = "Il manque le prénom ou le nom."; return; }
          if (p.length < 6) { err.textContent = "Le mot de passe doit faire au moins 6 caractères."; return; }
          if (p !== p2) { err.textContent = "Les deux mots de passe ne correspondent pas."; return; }
          go.disabled = true;
          createAccount(f, l, p).then(done).catch(function () {
            go.disabled = false;
            err.textContent = "La création a échoué sur cet appareil.";
          });
        }
        go.addEventListener("click", creer);
        [lf, ll, lp, lp2].forEach(function (c) {
          c.input.addEventListener("keydown", function (e) { if (e.key === "Enter") creer(); });
        });
        box.appendChild(two); box.appendChild(lp.label); box.appendChild(lp2.label);
        box.appendChild(err); box.appendChild(go);
        if (ids.length) {
          var back = document.createElement("button");
          back.type = "button"; back.className = "link";
          back.textContent = "J'ai déjà un compte";
          back.addEventListener("click", screenChoose);
          box.appendChild(back);
        }
        box.appendChild(el("p", "fine",
          "Le mot de passe n'est enregistré nulle part : seule son empreinte l'est. " +
          "Il sert aussi de clé — tes fiches et tes photos sont chiffrées avec. " +
          "Tu restes connecté d'une fois sur l'autre, donc la clé est gardée sur cet appareil : " +
          "le chiffrement met le contenu à l'abri d'un regard de passage, pas de quelqu'un qui " +
          "sait fouiller un navigateur. Oublié, le mot de passe n'est pas récupérable."));
        host.appendChild(box);
        lf.input.focus();
      }

      if (ids.length) screenChoose(); else screenCreate();
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

      var reprise = (saved && all[saved])
        ? recallKey().then(function (k) { return k ? all[saved] : null; })
        : Promise.resolve(null);

      reprise.then(function (acc) {
        if (acc) return finish(acc);
        var start = document.readyState === "loading"
          ? new Promise(function (ok) { document.addEventListener("DOMContentLoaded", ok); })
          : Promise.resolve();
        return start.then(askAccount).then(finish);
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
      } catch (e) { /* ignore */ }
      window.location.reload();
      return Promise.resolve();
    } : null
  };

  /* ------------------------------------------------------------- façade */

  // Les images d'abord, puis la session : tant que personne n'est connecté,
  // aucune capacité ne répond, donc l'application attend sagement derrière
  // l'écran de connexion au lieu de lire les fiches de quelqu'un d'autre.
  var blobsReady = primeBlobs();

  function afterLogin(value) {
    return ready().then(function () { return blobsReady; }).then(function () { return value; });
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
