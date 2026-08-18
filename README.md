# 📒 Carnet de comptes — prototype V1 · **100 % gratuit**

Outil de gestion de comptes perso/familiaux qui **remplace un carnet papier**.
Objectif : être *plus rapide que le carnet* (capture + tri), pas « le carnet mais
sur écran ». Une personne saisit, le reste de la famille consulte en lecture seule.

Cette V1 couvre la chaîne complète : **capture** multi-méthodes → **tri
automatique** qui apprend → **bilan** visuel → **récap automatique** envoyé à la
famille. Tout tourne **sans aucun service payant**.

---

## Démarrer

```bash
npm install
npm start
```

- App de saisie (éditrice) : http://localhost:3000/
- Vue famille (lecture seule) : http://localhost:3000/view.html
- Récap partageable : http://localhost:3000/recap

Réinitialiser / réamorcer : `npm run reset`. Base SQLite intégrée à Node
(`node:sqlite`, Node ≥ 22.5) — rien à installer. Données dans `data/` (hors git).

---

## C'est gratuit, vraiment

| Brique | Comment | Coût |
|---|---|---|
| Serveur + base | Node + Express + `node:sqlite` (intégré) | 0 € |
| Saisie vocale | reconnaissance vocale du **navigateur** (Web Speech, fr-FR) | 0 € |
| Lecture des photos (OCR) | **Tesseract.js dans le navigateur** (aucune clé) | 0 € |
| Tri des dépenses | moteur de règles maison (pas d'IA facturée) | 0 € |
| Récap famille | HTML généré + webhook optionnel | 0 € |

> Option payante, **totalement facultative** : brancher la vision Claude pour une
> lecture photo plus précise (`ANTHROPIC_API_KEY`). Sans clé, l'OCR gratuit du
> navigateur prend le relais. Rien d'autre n'est payant.
>
> **Hébergement gratuit possible** : la machine de la maison, un vieux PC, ou un
> hébergeur à offre gratuite. (Attention aux offres à disque éphémère qui
> effacent `data/` : préférer une machine perso ou un volume persistant.)

---

## Capture — 4 méthodes, une seule base

Toutes convergent vers la même table `expenses` et passent par le même tri auto.

| Méthode | Écran | Ce que fait le prototype |
|---|---|---|
| 📷 **Ticket** | photo d'un ticket | OCR navigateur → *montant (total), marchand, date* → brouillon à confirmer |
| 📖 **Carnet** | photo d'une page | OCR navigateur → **ligne par ligne** → liste à confirmer |
| 🎙️ **Voix** | dire à voix haute | transcription navigateur → analyse FR (« *18,50 chez Carrefour courses* ») |
| ✍️ **Manuel** | 3 champs | montant, catégorie, note — filet de secours |

L'OCR photo tourne **côté navigateur** : le serveur ne reçoit que du texte, jamais
une facturation. Sur un appareil hors ligne, la photo est quand même jointe et la
saisie se fait à la main.

---

## Tri automatique & apprentissage

`server/categorize.js`, du signal le plus fiable au moins fiable :

1. **Marchand connu** — règle apprise ou amorcée (`carrefour → Alimentation`).
2. **Mots-clés** dans marchand + note (score par catégorie).
3. **Repli** `Divers`, marqué *à vérifier*.

**Correction = apprentissage** : reclasser une dépense mémorise le marchand vers
la bonne catégorie → la fois suivante c'est automatique. *(Vérifié en test.)*

---

## Tes catégories (onglet 🏷️)

On **reprend TES catégories** (celles du carnet), on n'en impose pas. Depuis
l'onglet Catégories, l'éditrice peut :

- **renommer** / changer l'emoji / **retirer** une catégorie (l'historique reste) ;
- **ajouter** une catégorie ;
- **importer d'un coup** la liste du carnet (coller une catégorie par ligne, emoji
  optionnel en tête de ligne).

Le jeu de départ est un foyer type FR, à remplacer par le sien.

---

## Bilan & récap famille

- **Bilan** (onglet 📊 et `view.html`) : total du mois, répartition par catégorie
  (barres), évolution mensuelle. Visuel, pas un tableau de comptable.
- **Récap automatique** (`server/recap.js`) : résumé périodique pour ceux qui ne
  vont pas cliquer. Page HTML prête à partager (`/recap`), comparaison avec la
  période précédente, et **envoi programmé** :
  - `RECAP_PERIOD=month` (défaut) ou `week` ;
  - `RECAP_WEBHOOK_URL=…` → pousse le récap (compatible Slack/Discord/relais
    mail-message). Sans webhook, le dernier récap reste consultable sur `/recap`.
  - Le planificateur envoie le 1er du mois (ou le lundi en hebdo), sans doublon.
  - Test manuel : `POST /api/recap/send`.

> **À trancher avec l'utilisatrice** : canal exact (mail ? message ?) et fréquence
> (hebdo ? mensuel ?). Le code est prêt pour les deux ; il suffit de fixer
> `RECAP_PERIOD` et de brancher le webhook du canal choisi.

---

## Rôles

- **Éditrice** (saisie) : jeton `EDITOR_TOKEN` (défaut `famille`), saisi une fois
  dans ⚙️ Réglages.
- **Famille** (lecture seule) : `view.html` et `/recap`, sans jeton.

> Garde-fou léger, adapté à un prototype. Pour un vrai déploiement : authentification
> réelle + HTTPS.

---

## Décisions & points ouverts (cadrage)

- **Budget** : V1 = **suivi passif**. Limites + alertes à ajouter ensuite si besoin.
- **Récap** : implémenté avec des défauts ; canal/fréquence à confirmer.
- **Granularité des catégories** : éditable en direct, à caler sur le carnet réel.
- **App dédiée vs lien** : lien web partagé (le plus léger à adopter).

---

## API (résumé)

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/categories` | public |
| POST/PATCH | `/api/categories[/:id]` | éditrice |
| POST | `/api/parse` | éditrice — aperçu voix/texte |
| POST | `/api/parse/ocr` | éditrice — texte OCR navigateur → dépense(s) |
| POST | `/api/capture/photo` | éditrice — stocke la photo (+ vision Claude si clé) |
| GET | `/api/expenses` | public (lecture) |
| POST/PATCH/DELETE | `/api/expenses[/:id]` | éditrice (PATCH catégorie = apprentissage) |
| GET | `/api/stats/summary` | public — bilan |
| GET | `/api/recap` · `/recap` | public — récap JSON / HTML |
| POST | `/api/recap/send` | éditrice — envoi manuel |

## Structure

```
server/   index.js · db.js · categorize.js · parse.js · extract.js · recap.js
public/   index.html (saisie) · view.html (famille) · app.js · view.js · styles.css
data/     comptes.db · uploads/ · recaps/   (générés, hors git)
```
