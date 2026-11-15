/* Lapse hors ligne.
 *
 * Le réseau d'abord, toujours : une mise à jour publiée arrive à la visite
 * suivante sans rien faire. La copie gardée ne sert que quand le réseau ne
 * répond pas. Les bibliothèques venues d'un CDN (polices, PDF.js, Tesseract)
 * ne changent jamais à une adresse donnée : pour elles, la copie d'abord.
 */
var CACHE = "lapse-v4";
var SHELL = ["./", "index.html", "runtime-local.js", "scan-local.js", "manifest.webmanifest",
             "icon.svg", "icon-180.png", "icon-192.png", "icon-512.png", "confidentialite.html"];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(SHELL); })
      .catch(function () { /* hors ligne à l'installation : on réessaiera */ })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function keep(request, response) {
  if (response && (response.ok || response.type === "opaque")) {
    var copy = response.clone();
    caches.open(CACHE).then(function (c) { c.put(request, copy); }).catch(function () {});
  }
  return response;
}

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") return;

  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(req).then(function (res) { return keep(req, res); })
        .catch(function () {
          return caches.match(req, { ignoreSearch: true }).then(function (hit) {
            return hit || (req.mode === "navigate" ? caches.match("index.html") : Response.error());
          });
        })
    );
    return;
  }
  e.respondWith(
    caches.match(req).then(function (hit) {
      return hit || fetch(req).then(function (res) { return keep(req, res); });
    })
  );
});

/* ------------------------------------------------------------ rappels
 * L'application range ici les échéances à venir (titre, date, jours de
 * rappel). À chaque vérification, on prévient pour le seuil franchi le plus
 * proche, une seule fois par seuil.
 */
function notes(mode, run) {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open("lapse-notify", 1);
    req.onupgradeneeded = function () { req.result.createObjectStore("kv"); };
    req.onerror = function () { reject(req.error); };
    req.onsuccess = function () {
      var tx = req.result.transaction("kv", mode);
      var r = run(tx.objectStore("kv"));
      tx.oncomplete = function () { resolve(r && r.result); };
      tx.onerror = function () { reject(tx.error); };
    };
  });
}

function daysTo(iso) {
  var p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!p) return null;
  var now = new Date();
  var a = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((Date.UTC(+p[1], +p[2] - 1, +p[3]) - a) / 86400000);
}

function check() {
  return Promise.all([
    notes("readonly", function (st) { return st.get("schedule"); }),
    notes("readonly", function (st) { return st.get("sent"); })
  ]).then(function (r) {
    var list = r[0] || [], sent = r[1] || {}, out = [];
    list.forEach(function (e) {
      var d = daysTo(e.due);
      if (d === null || d < 0) return;
      var steps = (e.leads || []).concat([0]).filter(function (t) { return t >= d; }).sort(function (a, b) { return a - b; });
      if (!steps.length) return;
      var key = e.id + "|" + e.due + "|" + steps[0];
      if (sent[key]) return;
      steps.forEach(function (t) { sent[e.id + "|" + e.due + "|" + t] = 1; });
      out.push({ e: e, d: d });
    });
    // On oublie ce qui concerne des échéances passées depuis longtemps.
    Object.keys(sent).forEach(function (k) {
      var due = k.split("|")[1];
      var d = daysTo(due);
      if (d !== null && d < -60) delete sent[k];
    });
    return notes("readwrite", function (st) { st.put(sent, "sent"); }).then(function () {
      return Promise.all(out.slice(0, 6).map(function (x) {
        var when = x.d === 0 ? "aujourd'hui" : x.d === 1 ? "demain" : "dans " + x.d + " jours";
        return self.registration.showNotification(x.e.title, {
          body: x.e.what + " " + when,
          tag: "lapse-" + x.e.id,
          icon: "icon-192.png",
          badge: "icon-192.png",
          data: { url: "./" }
        });
      }));
    });
  }).catch(function () { /* rien à prévenir */ });
}

self.addEventListener("message", function (e) {
  if (e.data && e.data.type === "lapse-check") e.waitUntil ? e.waitUntil(check()) : check();
});
self.addEventListener("periodicsync", function (e) {
  if (e.tag === "lapse-check") e.waitUntil(check());
});
self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) if ("focus" in list[i]) return list[i].focus();
      return self.clients.openWindow ? self.clients.openWindow("./") : null;
    })
  );
});
