# Lapse

**Les dates qui coûtent de l'argent quand on les oublie.** Fin de garantie,
renouvellement d'abonnement, péremption d'un produit entamé, remplacement d'un
filtre — et les tickets qu'on garde juste comme preuve d'achat.

Une seule page, aucune dépendance à installer, aucun compte à créer.

👉 **[Essayer Lapse](https://VOTRE-NOM.github.io/lapse/)**

---

## Ce que ça fait

Tu enregistres ce qui est écrit sur le ticket ; l'app en déduit la date qui compte
et te prévient pendant qu'il est encore temps d'agir.

| Famille | Ce que tu enregistres | Date calculée | Préavis par défaut |
| --- | --- | --- | --- |
| Garantie | Date d'achat, durée, prix, vendeur, n° de série | Achat + durée (24 mois par défaut, garantie légale française) | 30 jours |
| Abonnement | Prochaine échéance, montant, périodicité, lien de résiliation | L'échéance, avancée d'une période à chaque paiement noté | 7 jours |
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

## Démarrer

Ouvre `index.html`. C'est tout.

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
| Fiches | `localStorage`, dans ce navigateur | Espace privé lié au compte |
| Photos et PDF | `IndexedDB`, dans ce navigateur | Stockage de fichiers de l'app |
| Export CSV, PDF | Oui | Oui |
| Lecture automatique des tickets | **Non** | Oui |
| Import d'e-mail | **Non** | Oui |
| Synchronisation entre appareils | Non | Oui |

`runtime-local.js` fournit les quatre premières lignes du tableau hors de
claude.ai, en se faisant passer pour le runtime d'artifact : il installe
`window.claude.use(nom)` et rend un stockage, un magasin de fichiers, un
enregistreur et une identité d'appareil. Si `window.claude` existe déjà, il ne
touche à rien.

Ce qui manque sur GitHub Pages demande un modèle de langage — donc une clé d'API
et un serveur. Sans ça, scanner un ticket garde la photo comme preuve d'achat et
te laisse saisir les champs. Le reste de l'app est identique, **conversion des PDF
comprise** : PDF.js rend la première page dans le navigateur.

---

## Confidentialité

Rien ne part. Pas de compte, pas de télémétrie, pas d'appel réseau en dehors des
polices Google et de PDF.js, chargés depuis leur CDN. Tes fiches et tes photos
restent dans ton navigateur ; vider les données du site les efface. L'export CSV
est là pour partir avec.

---

## Dans le dépôt

| Fichier | À quoi il sert |
| --- | --- |
| `index.html` | L'application. Tout est dedans : HTML, CSS, JavaScript. |
| `runtime-local.js` | Le stockage navigateur, chargé avant l'app. |
| `serve.py` | Un serveur statique, si `file://` coince. |
| `icon.svg` | L'icône : un ticket de caisse qui retombe en L. |
| `manifest.webmanifest` | De quoi l'installer sur l'écran d'accueil d'un téléphone. |
| `artifact/page.html` | La source telle que publiée sur claude.ai, sans l'enveloppe HTML. |

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

- **Pas de notification système.** Les rappels décident du moment où une fiche
  remonte en priorité dans l'app ; ils ne font pas sonner le téléphone.
- **Pas d'ajout automatique à l'agenda.** Le bouton génère l'événement iCalendar
  à copier.
- **Une seule page de PDF lue**, la première.
- **Pas de scan de code-barres.**

---

## Licence

MIT.
