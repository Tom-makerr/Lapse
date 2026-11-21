# Lapse

**Les dates qui coûtent de l'argent quand on les oublie.** Fin de garantie,
renouvellement d'abonnement, péremption d'un produit entamé, remplacement d'un
filtre — et les tickets qu'on garde juste comme preuve d'achat.

Une seule page, aucune dépendance à installer, aucun serveur : le compte et les
fiches restent sur l'appareil.

**[Essayer Lapse](https://VOTRE-NOM.github.io/lapse/)**

---

## Ce que ça fait

Tu enregistres ce qui est écrit sur le ticket ; l'app en déduit la date qui compte
et te prévient pendant qu'il est encore temps d'agir.

| Famille | Ce que tu enregistres | Date calculée | Préavis par défaut |
| --- | --- | --- | --- |
| Garantie | Date d'achat, durée, prix, vendeur, n° de série | Achat + durée (24 mois par défaut, garantie légale française) | 30 jours |
| Abonnement | Prochaine échéance, montant, périodicité, prélèvement récurrent ou non, lien de résiliation | L'échéance. Un prélèvement récurrent se reporte tout seul à chaque période, et les prélèvements sont comptés ; sinon la date est la dernière | 7 jours |
| Péremption | Date d'ouverture + PAO, ou date limite imprimée | La plus proche des deux | 30 jours |
| Entretien | Dernier remplacement, intervalle | Dernier + intervalle | 14 jours |
| À garder | Date d'achat, prix, vendeur | Aucune — le ticket est gardé comme preuve | — |

L'accueil ne montre pas des chiffres à interpréter : il met en tête la seule chose
à faire maintenant, avec le bouton qui la fait. Résilier un essai, noter un
prélèvement, marquer un filtre remplacé, jeter un produit périmé. Les garanties,
elles, ne portent aucun bouton : faire jouer le SAV ou revendre, c'est ta décision.

Dans la fiche d'une garantie, deux générateurs : une **lettre de mise en œuvre de
la garantie légale de conformité**, préremplie et appuyée sur les articles L.217-3
et L.217-7 du code de la consommation ; et une **annonce de revente** qui met en
avant la garantie restante et la preuve d'achat.

---

Un **guide d'utilisation** complet, chapitre par chapitre et avec des exemples,
est dans l'app : Réglages → Guide d'utilisation.

## Démarrer

Ouvre `index.html`. C'est tout.

Sur téléphone, depuis la version en ligne : **Partager → Sur l'écran d'accueil**
(Safari) ou **Installer l'application** (Chrome). Lapse s'ouvre alors comme une
app, y compris sans réseau.

Si ton navigateur refuse IndexedDB sur `file://` — les photos de tickets ne
s'enregistrent alors pas — sers le dossier :

```bash
python3 serve.py
```

Puis va sur http://localhost:8000.

### Publier sur GitHub Pages

Dans les réglages du dépôt : **Settings → Pages → Source : Deploy from a branch →
`main` / `(root)`**. Le site est en ligne une minute plus tard, et le lien se
partage à n'importe qui.

---

## Deux versions, un seul code

Lapse tourne dans deux mondes. Le code applicatif est strictement le même ; seule
la couche de stockage change, et elle expose la même interface des deux côtés.

| | Sur GitHub Pages | Sur claude.ai |
| --- | --- | --- |
| Fiches | `localStorage`, séparées par compte local | Espace privé lié au compte Claude |
| Photos et PDF | `IndexedDB`, dans ce navigateur | Stockage de fichiers de l'app |
| Export CSV, PDF | Oui | Oui |
| Sauvegarde complète et restauration (JSON, photos comprises) | Oui | Oui |
| Export vers l'agenda | Fichier `.ics` avec rappels | Texte iCalendar à copier |
| Hors ligne, installable sur l'écran d'accueil | Oui | Non |
| Notifications | Oui — en arrière-plan sur Android (app installée), à l'ouverture sur iPhone | Non |
| Question secrète, verrouillage par Face ID ou mot de passe | Oui | Le compte Claude |
| Vérification des rappels de produits (RappelConso) | Oui | Non |
| Lecture automatique des tickets | Oui — OCR du navigateur | Oui — par Claude |
| Import d'e-mail | Oui — analyse du texte | Oui — par Claude |
| Synchronisation entre appareils | Non | Oui |
| Comptes | Oui — créés sur cet appareil, avec mot de passe modifiable et suppression | Le compte Claude |
| Chiffrement au repos | Oui — AES-GCM, clé dérivée du mot de passe | Stockage de la plateforme |

`runtime-local.js` se fait passer pour le runtime d'artifact : il installe
`window.claude.use(nom)` et rend un stockage, un magasin de fichiers, un
enregistreur et une identité d'appareil. Si `window.claude` existe déjà, il ne
touche à rien.

### Les comptes, hors de claude.ai

À l'ouverture, et après chaque déconnexion, Lapse propose de se connecter ou de
créer un compte (prénom, nom, mot de passe).
Le compte vit dans ce navigateur : chacun a ses fiches, rangées sous
`data/users/<compte>/`, et on passe de l'un à l'autre en se déconnectant.

Le mot de passe n'est enregistré nulle part. Seule son empreinte l'est —
PBKDF2-SHA256, 150 000 itérations, avec un sel tiré au hasard par compte.

**Le mot de passe est aussi la clé.** Une seconde dérivation, avec un sel
distinct, produit une clé AES-GCM 256 bits. Chaque fiche et chaque pièce
jointe est chiffrée avec elle avant d'être écrite : `localStorage` et
`IndexedDB` ne contiennent que du bruit. En mémoire, pendant que tu es
connecté, les fiches sont en clair — c'est ce qui permet de les afficher.

**La clé de données** est tirée au hasard à la création du compte. Elle est
enfermée par le mot de passe, et une seconde fois par la réponse à une
**question secrète** choisie à la création du compte (dans une liste, ou écrite
par l'utilisateur). La réponse n'est enregistrée nulle part ; majuscules,
accents, espaces et ponctuation ne comptent pas.
**Mot de passe oublié** : on répond à la question, la clé de données se rouvre,
et on choisit un nouveau mot de passe. Cinq mauvaises réponses de suite
imposent cinq minutes d'attente. Changer de mot de passe ne rechiffre rien,
seule l'enveloppe change. La question se change dans Réglages. Les comptes
créés avec l'ancienne clé de secours peuvent toujours s'en servir.

Ce que la question ne protège pas : quelqu'un qui connaît ou devine la réponse.
Mieux vaut une réponse que personne d'autre ne connaît.

**Le verrouillage à l'ouverture** se règle dans Réglages :

- *Aucun* : on reste connecté, la clé dort sur l'appareil, à côté des données.
- *Mot de passe* : la clé ne vit que le temps de l'onglet.
- *Face ID ou Touch ID* : une clé d'accès de l'appareil. Quand le navigateur
  sait en tirer un secret (extension PRF : Safari 18, Chrome récents), ce secret
  enferme la clé de données, qui ne dort plus nulle part en clair. Sinon, Face ID
  ne fait que barrer l'entrée. Face ID se lance tout seul à l'ouverture, sans
  appuyer sur un bouton ; le mot de passe reste toujours possible.

Avec un verrouillage, l'app se referme quand on la quitte plus de cinq minutes.

Les comptes créés avec une version précédente s'ouvrent comme avant ; l'app
leur propose de choisir une question secrète.

**Ce que ça protège :** les fiches ne sont pas lisibles en clair, et deux
comptes sur le même appareil ne se voient pas. Avec un verrouillage, quelqu'un
qui prend l'appareil tombe sur l'écran de déverrouillage.
**Ce que ça ne protège pas :** sans verrouillage, quelqu'un qui sait fouiller le
stockage du navigateur trouve la clé à côté du coffre. Et sans question
secrète, un mot de passe oublié reste irrécupérable. D'où aussi la
**sauvegarde complète** dans Réglages : un fichier JSON avec les fiches, les
réglages et les photos, à restaurer sur n'importe quel appareil.

Dans Réglages, on peut aussi **changer de mot de passe** — tout est rechiffré
avec la nouvelle clé — et **supprimer le compte**, ce qui efface ses fiches et
ses photos de l'appareil sans toucher aux autres comptes.

Ouverte en `file://`, la page n'a pas accès à WebCrypto : Lapse reste alors
sur une identité d'appareil, sans mot de passe ni chiffrement, plutôt que de
faire semblant.

`scan-local.js` lit les tickets sans modèle de langage, en deux temps : **Tesseract**
(WebAssembly, chargé à la demande) sur une image redressée en noir et blanc
contrasté, puis un analyseur écrit pour les tickets français — date, total,
enseigne, article le plus cher, et déduction de la catégorie. Il reconnaît une
centaine d'enseignes, le vocabulaire de l'abonnement, le symbole de période après
ouverture et les durées de garantie annoncées.

### Les abonnements qui augmentent

Importer la nouvelle facture d'un abonnement déjà suivi propose de **mettre à
jour la fiche** plutôt que d'en créer une seconde. Si le montant a changé, la
hausse est datée et gardée : la fiche affiche le prix d'origine, chaque
changement, et ce que ça coûte de plus sur un an.

### Rappels de produits

Dans Réglages → Rappels de produits, Lapse compare la marque et le modèle de tes
fiches avec **RappelConso**, la base officielle des rappels. Seule la marque est
envoyée à data.economie.gouv.fr ; la comparaison avec le modèle se fait sur
l'appareil. Une correspondance reste un « peut-être » : la fiche officielle, avec
ses numéros de lot, tranche. La vérification peut tourner seule une fois par mois.

### Ce que l'OCR fait moins bien que Claude

L'OCR lit des caractères, il ne comprend pas le ticket. En pratique :

- **le nom de l'article** est le point faible — une ligne de caisse abrégée
  (« TV LED TCL 55C645 ») passe, un libellé tronqué ou mal imprimé donne du
  charabia ;
- **un ticket thermique pâli, froissé ou photographié de biais** descend vite en
  qualité ; à plat, bien éclairé, ça tient ;
- **les cas ambigus** — un gros achat non alimentaire noyé dans des courses — sont
  tranchés par des règles de seuil, pas par du jugement.

Une facture qui porte plusieurs articles (une télé et une barre de son, par
exemple) les liste tous : on coche ceux à suivre, une fiche est créée pour
chacun, avec le même justificatif. Un PDF est lu sur ses quatre premières
pages, et quand il porte du texte (une facture reçue par mail, pas un scan),
ce texte est lu directement, sans passer par l'OCR.

L'écran de vérification existe pour ça : rien n'est enregistré sans que tu aies
relu les champs. La première lecture télécharge le modèle de langue (~2 Mo), puis
il reste en cache.

---

## Confidentialité

Rien ne part. Pas de serveur, pas de télémétrie, pas d'appel réseau en dehors des
polices Google, de PDF.js et de Tesseract, chargés depuis leur CDN, et de
RappelConso si tu lances la vérification (seules les marques sont envoyées).
Le détail est dans `confidentialite.html` ; **avant de publier, remplace les
deux champs entre crochets des mentions légales** par ton nom et une adresse
de contact. Tes fiches et tes photos
restent dans ton navigateur ; vider les données du site les efface. La
sauvegarde complète est là pour partir avec.

---

## Dans le dépôt

| Fichier | À quoi il sert |
| --- | --- |
| `index.html` | L'application. Tout est dedans : HTML, CSS, JavaScript. |
| `runtime-local.js` | Le stockage navigateur, chargé avant l'app. |
| `scan-local.js` | L'OCR et l'analyse des tickets, sans modèle de langage. |
| `sw.js` | Le service worker : l'app s'ouvre hors ligne, réseau d'abord quand il répond. |
| `build.py` | Reconstruit `index.html` à partir de `artifact/page.html`. |
| `confidentialite.html` | La politique de confidentialité et les mentions légales. |
| `tests/` | Les tests de l'analyseur de tickets, sur des tickets fictifs. |
| `serve.py` | Un serveur statique, si `file://` coince. |
| `icon.svg` | Le favicon : le ticket de caisse qui retombe en L, noir ou blanc selon le thème. |
| `logo/` | Le logo : le L seul (symbole) et le nom complet, une seule couleur, fond transparent. Le « APSE » est en Playfair Display (licence OFL). |
| `icon-180.png`, `icon-192.png`, `icon-512.png` | L'icône pleine, pour l'écran d'accueil. |
| `manifest.webmanifest` | De quoi l'installer sur l'écran d'accueil d'un téléphone. |
| `artifact/page.html` | La source telle que publiée sur claude.ai, sans l'enveloppe HTML. |

Après une modification de `artifact/page.html`, `python3 build.py` régénère
`index.html`.

Les tests de l'analyseur de tickets tournent sans navigateur :

```bash
sh tests/run.sh
```

Sur Mac, ils utilisent JavaScriptCore, livré avec le système ; ailleurs, Node.
Les tickets de `tests/fixtures.js` sont fictifs.

### Où regarder pour modifier

| Pour changer… | Cherche dans `index.html` |
| --- | --- |
| Couleurs, rayons, ombres | le bloc `:root` en haut du `<style>` |
| Le calcul d'une échéance | `function dueDate` |
| Le classement par urgence | `severity`, `rankOf`, `byPriority` |
| Les phrases affichées | `advice` et `shortPhrase` |
| La lettre SAV | `function savLetter` |
| L'annonce de revente | `function resaleListing` |
| Les consignes de lecture des tickets | les variables `RULES` et `SHAPE` |

---

## Limites connues

- **Notifications limitées sur iPhone.** Safari ne réveille pas une app web sans
  serveur d'envoi : sur iPhone, les rappels partent à l'ouverture de l'app. Sur
  Android, Chrome vérifie en arrière-plan quand l'app est installée. Pour que
  l'iPhone sonne à coup sûr, exporte les échéances vers l'agenda : chaque
  événement porte ses alarmes, à 9 h.
- **Pas de partage entre plusieurs personnes**, ni de synchronisation entre
  appareils : il faudrait un serveur.
- **L'agenda n'est pas synchronisé.** Le fichier `.ics` est une photo à l'instant
  de l'export ; une fiche modifiée ensuite se réexporte.
- **Quatre pages de PDF lues** au plus.
- **Pas de scan de code-barres.**
- **L'OCR local ne vaut pas la lecture par Claude** sur un ticket abîmé : voir
  plus haut.

---

## Licence

MIT.
