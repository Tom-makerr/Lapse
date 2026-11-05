/* Lapse — lecture de tickets sans modèle de langage
 *
 * Hors de claude.ai, personne ne lit le ticket à notre place. Ce fichier fait
 * le travail dans le navigateur, en deux temps :
 *
 *   1. OCR — Tesseract (WebAssembly), chargé à la demande, sur une image
 *      redressée en noir et blanc contrasté. Un ticket thermique mal imprimé
 *      reste difficile ; le prétraitement change beaucoup le résultat.
 *   2. Analyse — des règles écrites pour les tickets français : repérage de la
 *      date, du total, de l'enseigne, de l'article le plus cher, et déduction
 *      de la catégorie à partir de l'enseigne et du vocabulaire.
 *
 * Le tout est exposé sous la forme d'une capacité `sample`, pour que
 * l'application ne voie aucune différence avec la version claude.ai.
 */
(function () {
  "use strict";

  var TESSERACT = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";

  /* ------------------------------------------------------- enseignes */

  // Enseignes où l'on achète un bien durable : garantie légale de 2 ans.
  var DURABLE = [
    "DARTY", "FNAC", "BOULANGER", "ELECTRO DEPOT", "ELECTRO DÉPÔT", "CONFORAMA",
    "BUT", "IKEA", "LEROY MERLIN", "CASTORAMA", "BRICO DEPOT", "BRICO DÉPÔT",
    "BRICORAMA", "WELDOM", "MR BRICOLAGE", "DECATHLON", "INTERSPORT", "GO SPORT",
    "CULTURA", "MAISONS DU MONDE", "ALINEA", "LAPEYRE", "APPLE STORE",
    "SAMSUNG", "LDLC", "MATERIEL.NET", "CDISCOUNT", "AMAZON", "NORAUTO",
    "FEU VERT", "MIDAS", "DIGITAL", "ICOZA"
  ];

  // Enseignes où il n'y a presque jamais de date à suivre.
  // Jamais de nom ambigu ici : « TOTAL » figure sur tous les tickets du monde.
  var CONSUMABLE = [
    "MCDONALD", "BURGER KING", "KFC", "QUICK", "SUBWAY", "DOMINO", "PIZZA",
    "STARBUCKS", "BRIOCHE DOREE", "BRIOCHE DORÉE", "BOULANGERIE", "PATISSERIE",
    "TOTALENERGIES", "ESSO", "SHELL", "AVIA", "STATION SERVICE",
    "SNCF", "RATP", "UBER", "TABAC", "BRASSERIE", "RESTAURANT", "TRAITEUR",
    "BOUCHERIE", "PRIMEUR", "CREPERIE", "CRÊPERIE", "SUSHI", "KEBAB"
  ];

  // Et quelques mots du corps du ticket qui trahissent un plein ou un repas.
  var CONSUMABLE_WORDS = /\bSP95\b|\bSP98\b|\bE10\b|GAZOLE|GASOIL|SANS PLOMB|CARBURANT|\bMENU\b|FORMULE MIDI|SUR PLACE|A EMPORTER|À EMPORTER/;

  // Enseignes de courses : tout dépend de ce qu'on y a acheté.
  var GROCERY = [
    "CARREFOUR", "LECLERC", "E.LECLERC", "INTERMARCHE", "INTERMARCHÉ", "SUPER U",
    "HYPER U", "U EXPRESS", "AUCHAN", "CASINO", "MONOPRIX", "FRANPRIX", "LIDL",
    "ALDI", "NETTO", "CORA", "GRAND FRAIS", "PICARD", "BIOCOOP", "NATURALIA"
  ];

  // Enseignes où le ticket vaut surtout comme preuve d'échange.
  var KEEPSAKE = [
    "ZARA", "H&M", "H & M", "UNIQLO", "PRIMARK", "KIABI", "CELIO", "JULES",
    "JENNYFER", "PULL&BEAR", "BERSHKA", "MANGO", "GEMO", "GÉMO", "CHAUSSEA",
    "ERAM", "ANDRE", "ANDRÉ", "COURIR", "FOOT LOCKER", "SNIPES", "ACTION",
    "GIFI", "CENTRAKOR", "LA FOIR'FOUILLE", "NOZ", "STOKOMANI"
  ];

  var PHARMA = ["PHARMACIE", "PARAPHARMACIE", "SEPHORA", "NOCIBE", "NOCIBÉ", "MARIONNAUD", "YVES ROCHER", "KIKO"];

  var MONTHS = {
    janvier: 1, janv: 1, jan: 1, fevrier: 2, février: 2, fevr: 2, févr: 2, fev: 2, mars: 3,
    avril: 4, avr: 4, mai: 5, juin: 6, juillet: 7, juil: 7, aout: 8, août: 8,
    septembre: 9, sept: 9, sep: 9, octobre: 10, oct: 10, novembre: 11, nov: 11,
    decembre: 12, décembre: 12, dec: 12, déc: 12
  };

  /* ------------------------------------------------- prétraitement image */

  function toCanvas(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        // Un ticket se lit mal en dessous de ~1200 px de large.
        var target = Math.min(2200, Math.max(1200, img.width));
        var scale = target / img.width;
        if (scale > 3) scale = 3;
        var w = Math.round(img.width * scale);
        var h = Math.round(img.height * scale);
        var cv = document.createElement("canvas");
        cv.width = w;
        cv.height = h;
        var ctx = cv.getContext("2d", { willReadFrequently: true });
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, w, h);
        try {
          contrast(ctx, w, h);
        } catch (e) {
          // Canvas sali (image d'une autre origine) : on garde l'image brute.
        }
        resolve(cv);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("image"));
      };
      img.src = url;
    });
  }

  // Niveaux de gris, puis étirement du contraste sur les 2e et 98e centiles :
  // le gris délavé d'un ticket thermique redevient du noir sur blanc.
  function contrast(ctx, w, h) {
    var img = ctx.getImageData(0, 0, w, h);
    var px = img.data;
    var hist = new Uint32Array(256);
    var i;
    for (i = 0; i < px.length; i += 4) {
      var g = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
      px[i] = px[i + 1] = px[i + 2] = g;
      hist[g]++;
    }
    var total = px.length / 4;
    var lowCut = total * 0.02;
    var highCut = total * 0.02;
    var acc = 0, lo = 0, hi = 255;
    for (i = 0; i < 256; i++) { acc += hist[i]; if (acc >= lowCut) { lo = i; break; } }
    acc = 0;
    for (i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= highCut) { hi = i; break; } }
    if (hi - lo < 24) { lo = 0; hi = 255; }
    var span = hi - lo;
    var lut = new Uint8Array(256);
    for (i = 0; i < 256; i++) {
      var v = Math.round(((i - lo) / span) * 255);
      lut[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    for (i = 0; i < px.length; i += 4) {
      var nv = lut[px[i]];
      px[i] = px[i + 1] = px[i + 2] = nv;
    }
    ctx.putImageData(img, 0, 0);
  }

  /* ----------------------------------------------------------- moteur OCR */

  var loading = null;
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = TESSERACT;
      s.onload = function () {
        if (window.Tesseract) resolve(window.Tesseract);
        else reject(new Error("tesseract"));
      };
      s.onerror = function () { reject(new Error("cdn")); };
      document.head.appendChild(s);
      window.setTimeout(function () { if (!window.Tesseract) reject(new Error("timeout")); }, 45000);
    });
    loading.catch(function () { loading = null; });
    return loading;
  }

  function say(msg) {
    var n = document.getElementById("scanStatus");
    if (n) n.textContent = msg;
  }

  var worker = null;
  function getWorker(T) {
    if (worker) return Promise.resolve(worker);
    say("Préparation du lecteur de texte… (quelques secondes la première fois)");
    return T.createWorker("fra", 1, {
      logger: function (m) {
        if (m.status === "recognizing text") {
          say("Lecture du ticket… " + Math.round((m.progress || 0) * 100) + " %");
        } else if (m.status && m.status.indexOf("loading") === 0) {
          say("Téléchargement du lecteur de texte…");
        }
      }
    }).then(function (w) {
      worker = w;
      return w;
    });
  }

  function ocr(blob) {
    return loadTesseract()
      .then(function (T) {
        return toCanvas(blob).then(function (cv) {
          return getWorker(T).then(function (w) {
            say("Lecture du ticket…");
            return w.recognize(cv);
          });
        });
      })
      .then(function (res) {
        return (res && res.data && res.data.text) || "";
      });
  }

  /* --------------------------------------------------------- utilitaires */

  function strip(s) {
    return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
  }
  function pad(n) { return String(n).padStart(2, "0"); }
  function iso(y, m, d) { return y + "-" + pad(m) + "-" + pad(d); }

  function plausible(y, m, d, future) {
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    var now = new Date();
    var when = new Date(Date.UTC(y, m - 1, d));
    if (isNaN(when.getTime())) return false;
    if (when.getUTCMonth() !== m - 1) return false;
    var ahead = (when.getTime() - now.getTime()) / 86400000;
    if (ahead > (future ? 365 * 3 : 3)) return false;
    return ahead > -365 * 15;
  }

  // Toutes les dates du texte, la plus proche d'un mot-clé d'abord.
  function findDates(text, future) {
    var found = [];
    var re1 = /(\d{1,2})\s*[\/.\-]\s*(\d{1,2})\s*[\/.\-]\s*(\d{2,4})/g;
    var m;
    while ((m = re1.exec(text))) {
      var y = +m[3];
      if (y < 100) y += y > 70 ? 1900 : 2000;
      if (plausible(y, +m[2], +m[1], future)) found.push({ at: m.index, date: iso(y, +m[2], +m[1]) });
    }
    var re2 = /(\d{1,2})\s+([A-Za-zéûôàÉÛÔÀ.]{3,10})\.?\s+(\d{4})/g;
    while ((m = re2.exec(text))) {
      var key = strip(m[2]).toLowerCase().replace(/\./g, "");
      var mo = MONTHS[key] || MONTHS[key.slice(0, 4)] || MONTHS[key.slice(0, 3)];
      if (mo && plausible(+m[3], mo, +m[1], future)) found.push({ at: m.index, date: iso(+m[3], mo, +m[1]) });
    }
    var re3 = /(\d{4})-(\d{2})-(\d{2})/g;
    while ((m = re3.exec(text))) {
      if (plausible(+m[1], +m[2], +m[3], future)) found.push({ at: m.index, date: iso(+m[1], +m[2], +m[3]) });
    }
    return found;
  }

  function todayISO() {
    var n = new Date();
    return iso(n.getFullYear(), n.getMonth() + 1, n.getDate());
  }

  function pickDateNear(text, hints, future) {
    var dates = findDates(text, future);
    if (!dates.length) return "";
    var up = strip(text);
    var now = todayISO();
    var best = null, bestScore = 1e9;
    dates.forEach(function (d) {
      var score = d.at;
      // Une échéance à venir ne peut pas être passée. La date de la facture,
      // elle, l'est toujours : sans ce garde-fou, c'est elle qui gagnait, en
      // haut du document.
      if (future && d.date < now) score += 1e6;
      hints.forEach(function (h) {
        var k = up.lastIndexOf(strip(h), d.at);
        if (k !== -1 && d.at - k < 60) score -= 1000;
      });
      if (score < bestScore) { bestScore = score; best = d; }
    });
    return best ? best.date : dates[0].date;
  }

  function pickDate(text) {
    return pickDateNear(text, ["DATE", "LE ", "ACHAT", "VENTE", "TICKET", "FACTURE", "COMMANDE"], false);
  }

  // Un montant, pas un pourcentage : « TVA 20.00% » n'est pas vingt euros.
  var AMOUNT = /(\d{1,3}(?:[  ]\d{3})*|\d+)[,.](\d{2})(?!\d)(?!\s*%)/g;

  // Lignes qui portent un montant sans être l'article acheté. Sur une facture
  // Fnac, l'éco-participation à 0,20 € ne doit jamais devenir « le produit ».
  var NOT_ARTICLE = /ECO.?PARTICIPATION|ECOPART|ECO.?TAXE|ECOTAXE|\bDEEE\b|\bD3E\b|SORECOP|COPIE PRIVEE|FRAIS DE PORT|FRAIS DE LIVRAISON|FRAIS DE DOSSIER|EMBALLAGE|CONSIGNE|ARRONDI|BON D.ACHAT|ACOMPTE|GARANTIE|ASSURANCE|PIECES DETACHEES/;

  function amountsIn(line) {
    var out = [];
    var m;
    AMOUNT.lastIndex = 0;
    while ((m = AMOUNT.exec(line))) {
      var v = parseFloat(m[1].replace(/[  ]/g, "") + "." + m[2]);
      if (isFinite(v) && v > 0 && v < 100000) out.push(v);
    }
    return out;
  }

  /* Le total payé.
   *
   * Sur une facture française, plusieurs totaux cohabitent : hors taxes, taxes,
   * toutes taxes comprises. Celui qui compte pour une fiche est ce qui a quitté
   * le compte, donc le TTC. On cherche d'abord les mots qui désignent un TTC
   * sans ambiguïté, et on lit le montant écrit **après** le mot — pas le dernier
   * de la ligne, car l'OCR agglutine volontiers plusieurs colonnes sur une seule.
   */
  var TTC_KEYS = ["NET A PAYER", "TOTAL TTC", "MONTANT TTC", "TOTAL GENERAL", "TOTAL A PAYER",
                  "A PAYER", "PAIEMENT", "MONTANT DU", "TOTAL CB", "TOTAL CLIENT", "TOTAL EUR"];
  var WEAK_KEYS = ["TOTAL", "MONTANT"];
  var HT_MARK = /\bHT\b|\bH\.T\b|HORS TAXE|BASE MARCH|TOTAL TAXES|\bTVA\b|TAXES\/|\/MARCH/;
  var NOISE = /RENDU|MONNAIE|REMISE|ECONOMIE|ESPECE|\bDONT\b|SOUS.TOTAL|ACOMPTE|\bAVOIR\b|FIDELITE/;

  // Le premier montant écrit après cette position. Si la ligne n'en porte aucun,
  // on regarde la suivante : les tableaux de facture débordent souvent d'une ligne.
  function amountAfter(lines, i, from) {
    var a = amountsIn(lines[i].slice(from));
    if (a.length) return a[0];
    if (amountsIn(lines[i]).length) return 0;
    if (i + 1 < lines.length) {
      var b = amountsIn(lines[i + 1]);
      if (b.length) return b[0];
    }
    return 0;
  }

  function totalFromKeys(lines, keys, guard) {
    var best = 0;
    for (var i = 0; i < lines.length; i++) {
      var up = strip(lines[i]);
      for (var k = 0; k < keys.length; k++) {
        var at = up.indexOf(keys[k]);
        if (at === -1) continue;
        // « Total HT » porte le même mot que « Total » : on tranche sur ce qui
        // suit immédiatement le mot-clé, pas sur la ligne entière.
        if (guard && (HT_MARK.test(up.slice(at, at + 24)) || NOISE.test(up.slice(at, at + 24)))) continue;
        var v = amountAfter(lines, i, at + keys[k].length);
        if (v > best) best = v;
      }
    }
    return best;
  }

  /* Le client paie la TVA : un sous-total n'est jamais le bon chiffre.
   *
   * Une facture d'abonnement montre volontiers sous-total, TVA et total. Si le
   * montant retenu, additionné à une TVA écrite ailleurs, tombe exactement sur
   * un autre montant du document, c'est ce dernier qui a quitté le compte.
   */
  function addVat(lines, picked) {
    if (!picked) return picked;
    var vat = 0;
    lines.forEach(function (l) {
      if (!/\bTVA\b|\bT\.V\.A\b|\bVAT\b/.test(strip(l))) return;
      amountsIn(l).forEach(function (v) { if (v > vat) vat = v; });
    });
    if (!vat) return picked;
    var target = picked + vat;
    var hit = 0;
    lines.forEach(function (l) {
      amountsIn(l).forEach(function (v) {
        if (Math.abs(v - target) < 0.02 && v > hit) hit = v;
      });
    });
    return hit || picked;
  }

  function pickTotal(lines) {
    var v = totalFromKeys(lines, TTC_KEYS, false);
    if (v) return addVat(lines, v);
    v = totalFromKeys(lines, WEAK_KEYS, true);
    if (v) return addVat(lines, v);
    var all = [];
    lines.forEach(function (l) {
      var up = strip(l);
      if (HT_MARK.test(up) || NOISE.test(up)) return;
      all = all.concat(amountsIn(l));
    });
    all.sort(function (x, y) { return y - x; });
    return all.length ? addVat(lines, all[0]) : 0;
  }

  function matchBrand(text, list) {
    var up = strip(text);
    for (var i = 0; i < list.length; i++) {
      if (up.indexOf(strip(list[i])) !== -1) return list[i];
    }
    return "";
  }

  // Éditeurs de services et d'abonnements. Séparés des enseignes de biens
  // durables : une facture iCloud ne doit pas devenir une garantie de deux ans.
  var SERVICES = [
    "APPLE", "ICLOUD", "GOOGLE", "YOUTUBE", "SPOTIFY", "DEEZER", "NETFLIX",
    "DISNEY", "CANAL+", "CANAL PLUS", "MICROSOFT", "ADOBE", "DROPBOX",
    "ORANGE", "SFR", "BOUYGUES", "SOSH", "NORDVPN", "SURFSHARK", "AUDIBLE",
    "PLAYSTATION", "XBOX", "NINTENDO", "STRAVA", "DUOLINGO", "OPENAI",
    "ANTHROPIC", "NOTION", "FIGMA", "GITHUB", "LINKEDIN"
  ];

  // Mots qui nomment le document, pas celui qui l'a émis.
  var PAPERWORK = /FACTURE|RECU|TICKET|COMMANDE|DEVIS|CLIENT|FACTURATION|PAIEMENT|LIVRAISON|TOTAL|^DATE|MERCI|DOCUMENT|SEQUENCE|COMPTE|ADRESSE|NUMERO|REFERENCE|DUPLICATA|ORIGINAL|\bPAGE\b/;

  // L'enseigne : une marque connue, sinon la première ligne qui ressemble à un nom.
  function pickSeller(lines, text) {
    var known = matchBrand(text, DURABLE.concat(GROCERY, KEEPSAKE, PHARMA, CONSUMABLE));
    if (known) return known.replace(/\s+$/, "");
    known = matchBrand(text, SERVICES);
    if (known) return known;
    for (var i = 0; i < Math.min(lines.length, 6); i++) {
      var l = lines[i].replace(/[^A-Za-zÀ-ÿ0-9'’&. -]/g, "").trim();
      if (l.length < 3 || l.length > 40) continue;
      if (PAPERWORK.test(strip(l))) continue;
      var letters = (l.match(/[A-Za-zÀ-ÿ]/g) || []).length;
      if (letters / l.length > 0.6) return l;
    }
    return "";
  }

  // Le nom de la formule, quand la facture l'écrit entre parenthèses :
  // « iCloud+ avec 200 Go (Mensuel) ».
  function pickPlan(lines) {
    for (var i = 0; i < lines.length; i++) {
      var m = /^(.{3,48}?)\s*\((mensuel|annuel|monthly|yearly)\)\s*$/i.exec(lines[i].trim());
      if (m) return m[1].trim();
    }
    return "";
  }

  // Le libellé, débarrassé des codes-barres, de la quantité et du fabricant
  // répété derrière une barre oblique.
  function cleanLabel(raw) {
    var label = raw
      .replace(AMOUNT, " ")
      .replace(/[€]|EUR\b/gi, " ")
      .replace(/\b\d{6,}\b/g, " ")
      .replace(/\b\d{1,3}\s*\|\s*(?=[A-Za-zÀ-ÿ])/g, " ")
      .replace(/^\s*\d{1,3}\s*[xX*]\s*/, "")
      .replace(/[^\wÀ-ÿ'’&.\/ -]/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    // « Console Sony PS5 Edition Standard / Sony / Sony Computer »
    var cut = label.indexOf(" / ");
    if (cut >= 8) label = label.slice(0, cut).trim();
    return label.slice(0, 60);
  }

  // L'article : la ligne de prix la plus chère, taxes et frais annexes exclus.
  function pickArticle(lines, total) {
    var cands = [];
    lines.forEach(function (raw, idx) {
      var up = strip(raw);
      if (/TOTAL|TVA|PAYER|CARTE|CB |ESPECE|RENDU|MONNAIE|REMISE|TICKET|MERCI|CAISSE|SIRET|TEL|FACTURE|DATE|HEURE|CLIENT|FIDELITE|FIDÉLITÉ/.test(up)) return;
      if (NOT_ARTICLE.test(up)) return;
      var amts = amountsIn(raw);
      if (!amts.length) return;
      // Entre le prix unitaire HT, le prix unitaire TTC et le montant HT d'une
      // même ligne de facture, le plus élevé est le TTC : c'est le prix payé.
      var price = Math.max.apply(null, amts);
      if (price <= 0 || (total && price > total + 0.01)) return;
      var label = cleanLabel(raw);
      var letters = (label.match(/[A-Za-zÀ-ÿ]/g) || []).length;
      if (letters < 4 || label.length < 4) return;
      cands.push({ label: label, price: price, idx: idx });
    });
    if (!cands.length) return null;
    cands.sort(function (a, b) { return b.price - a.price; });
    return cands[0];
  }

  // Les tournures qui disent qu'il n'y aura pas de prochaine échéance.
  var STOPS = /NE SE RENOUVELLE|NE SE RENOUVELLERA|SANS RENOUVELLEMENT|NON RENOUVELABLE|NE SERA PAS RENOUVELE|NE SERA PAS RECONDUIT|SANS RECONDUCTION|DERNIERE ECHEANCE|DERNIER PRELEVEMENT|ABONNEMENT RESILIE|RESILIATION CONFIRMEE|ABONNEMENT ANNULE/;

  function paoFrom(text) {
    var m = /(?:^|[^\d])(\d{1,2})\s*M(?![A-Za-z])/.exec(text);
    if (!m) return "";
    var v = +m[1];
    return [3, 6, 9, 12, 18, 24, 36].indexOf(v) !== -1 ? String(v) : "";
  }

  function warrantyFrom(text) {
    var up = strip(text);
    var m = /GARANTIE\D{0,12}(\d{1,2})\s*(ANS?|MOIS)/.exec(up);
    if (!m) return "";
    var n = +m[1];
    return m[2].indexOf("AN") === 0 ? String(n * 12) : String(n);
  }

  /* ---------------------------------------------------------- l'analyse */

  function analyse(text) {
    var lines = String(text || "")
      .split(/\r?\n/)
      .map(function (l) { return l.replace(/\s{2,}/g, " ").trim(); })
      .filter(function (l) { return l.length > 0; });

    if (lines.length < 2) {
      return { lisible: false, commentaire: "Le texte n'a pas pu être déchiffré sur cette photo." };
    }

    var joined = lines.join("\n");
    var header = lines.slice(0, 6).join("\n");
    var up = strip(joined);
    var total = pickTotal(lines);
    var seller = pickSeller(lines, joined);
    var article = pickArticle(lines, total);
    var date = pickDate(joined);

    var out = {
      type: "aucun", name: "", brand: "", seller: seller, purchaseDate: date,
      price: "", serial: "", warrantyMonths: "", amount: "", period: "", renew: "",
      nextDate: "", paoMonths: "", expiryDate: "", lisible: true, commentaire: ""
    };

    // Abonnement : le vocabulaire du prélèvement l'emporte sur l'enseigne.
    if (/ABONNEMENT|PRELEVEMENT|PRÉLÈVEMENT|RENOUVELLEMENT|MENSUEL|ESSAI GRATUIT|RESILIATION|RÉSILIATION/.test(up)) {
      out.type = "abonnement";
      out.name = pickPlan(lines) || seller || (article ? article.label : "Abonnement");
      out.amount = total ? String(total) : "";
      out.period = /ANNUEL|PAR AN|\/ AN/.test(up) ? "annuel" : "mensuel";
      // Un abonnement se reconduit, sauf mention franche du contraire. On
      // évite « résilier », qui figure sur presque toutes les factures sous
      // forme de lien, et « se termine le », qui désigne souvent un essai.
      out.renew = STOPS.test(up) ? "0" : "1";
      out.nextDate = pickDateNear(joined, ["PROCHAIN", "PRELEVEMENT", "PRÉLÈVEMENT", "RENOUV", "ECHEANCE", "ÉCHÉANCE", "FIN D", "DEBITE", "DÉBITÉ"], true);
      out.purchaseDate = "";
      out.commentaire = "Lu comme un abonnement : vérifie le montant et la date d'échéance.";
      return finish(out, article, total);
    }

    // Péremption : une PAO ou une date limite imprimée.
    var pao = paoFrom(joined);
    var dlu = /DLUO|DLC|A CONSOMMER|À CONSOMMER|EXP\b|PEREMPTION|PÉREMPTION/.test(up);
    if (pao || dlu) {
      out.type = "peremption";
      out.name = article ? article.label : (seller || "Produit");
      out.paoMonths = pao;
      out.commentaire = pao
        ? "Symbole de période après ouverture détecté : " + pao + " mois."
        : "Date limite détectée sur l'étiquette.";
      return finish(out, article, total);
    }

    var durable = matchBrand(header, DURABLE);
    var consumable = matchBrand(header, CONSUMABLE) || (CONSUMABLE_WORDS.test(up) ? "repas ou carburant" : "");
    var keepsake = matchBrand(header, KEEPSAKE);
    var pharma = matchBrand(header, PHARMA);
    var grocery = matchBrand(header, GROCERY);

    if (durable && total >= 25) {
      out.type = "garantie";
      out.warrantyMonths = warrantyFrom(joined) || "24";
      out.name = article ? article.label : "Achat " + durable;
      out.commentaire = "Enseigne de biens durables : garantie légale de 24 mois appliquée par défaut.";
    } else if (consumable) {
      out.type = "aucun";
      out.commentaire = "Repas, carburant ou service : rien à suivre dans le temps.";
    } else if (pharma) {
      out.type = "peremption";
      out.name = article ? article.label : "Produit " + pharma;
      out.commentaire = "Pharmacie ou parfumerie : vérifie la période après ouverture sur le flacon.";
    } else if (grocery) {
      // En supermarché, c'est l'article cher qui trahit le non-alimentaire.
      if (article && article.price >= 25) {
        out.type = "justificatif";
        out.name = article.label;
        out.commentaire = "Article non alimentaire repéré dans des courses : gardé comme preuve d'achat.";
      } else {
        out.type = "aucun";
        out.commentaire = "Courses alimentaires : rien à suivre dans le temps.";
      }
    } else if (keepsake || total >= 15) {
      out.type = "justificatif";
      out.name = article ? article.label : (seller || "Ticket");
      out.commentaire = "Aucune date à suivre, mais le ticket vaut comme preuve d'achat.";
    } else {
      out.type = "aucun";
      out.commentaire = "Rien d'identifiable à suivre sur ce ticket.";
    }
    return finish(out, article, total);
  }

  function finish(out, article, total) {
    if (out.type === "garantie" || out.type === "justificatif") {
      // Quand la ligne d'article et le total ne diffèrent que de quelques
      // centimes, l'écart est de la taxe ou de l'arrondi — c'est le total qui a
      // été payé. Un écart plus large veut dire qu'il y a un deuxième article,
      // et là c'est bien le prix de la ligne qui compte.
      if (article && total && total - article.price <= Math.max(1, total * 0.01)) out.price = String(total);
      else if (article) out.price = String(article.price);
      else out.price = total ? String(total) : "";
    }
    if (out.name) out.name = out.name.replace(/\s+/g, " ").trim().slice(0, 60);
    if (!out.name && out.type !== "aucun") out.name = out.seller || "Ticket";
    return out;
  }

  /* --------------------------------------------- e-mails collés (texte) */

  function analyseEmail(text) {
    var body = String(text || "");
    var cut = body.lastIndexOf("Voici l'e-mail :");
    if (cut !== -1) body = body.slice(cut + 16);
    var res = analyse(body);
    // Un e-mail de confirmation est rarement un ticket de caisse : on insiste
    // sur l'abonnement et la commande.
    var up = strip(body);
    if (res.type === "aucun" && /COMMANDE|FACTURE|RECU|REÇU|PAIEMENT/.test(up)) {
      res.type = "justificatif";
      res.commentaire = "Confirmation de commande : gardée comme preuve d'achat.";
      if (!res.name) res.name = res.seller || "Commande";
    }
    return res;
  }

  /* -------------------------------------------------------- la capacité */

  function run(input, opts) {
    var images = opts && opts.images;
    if (images) {
      var blob = images.length ? images[0] : images;
      return ocr(blob).then(function (text) {
        var res = analyse(text);
        res.commentaire = (res.commentaire ? res.commentaire + " " : "") +
          "Lecture faite par l'OCR du navigateur : relis les champs avant d'enregistrer.";
        return res;
      }).catch(function (err) {
        var code = err && err.message === "cdn" ? "upstream_error" : "upstream_error";
        return Promise.reject({ code: code, message: "OCR indisponible" });
      });
    }
    return Promise.resolve(analyseEmail(typeof input === "string" ? input : ""));
  }

  var sample = function (input, opts) {
    return run(input, opts).then(function (v) { return { text: JSON.stringify(v), truncated: false, modelTierApplied: "quick" }; });
  };
  sample.json = run;
  sample.limits = function () {
    return Promise.resolve({
      maxPromptBytes: 262144,
      images: { maxCount: 1, maxInputBytes: 20971520, mediaTypes: ["image/jpeg", "image/png", "image/webp"] }
    });
  };

  window.__lapseLocalSample = sample;
  // Exposés pour les tests : l'analyse est vérifiable sans OCR, et la
  // lecture d'une image sans passer par l'application.
  window.__lapseAnalyse = analyse;
  window.__lapseAnalyseEmail = analyseEmail;
  window.__lapseOcr = ocr;
})();
