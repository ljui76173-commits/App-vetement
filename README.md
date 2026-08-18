# 📒 Carnet de comptes — prototype V1

Outil de gestion de comptes perso/familiaux qui **remplace un carnet papier**.
Objectif : être *plus rapide que le carnet* (capture + tri), pas « le carnet mais
sur écran ». Une personne saisit, le reste de la famille consulte en lecture seule.

Cette V1 se concentre sur les deux maillons les plus pénibles de la chaîne :
la **capture** de la dépense et le **tri automatique**. La partie
restitution/famille est présente en version simple (bilan + lien lecture seule)
pour boucler le parcours de bout en bout.

---

## Démarrer

```bash
npm install
npm start
```

- App de saisie (éditrice) : http://localhost:3000/
- Vue famille (lecture seule) : http://localhost:3000/view.html

Réinitialiser / réamorcer la base : `npm run reset`.

Aucune base de données à installer : SQLite est intégré à Node (`node:sqlite`,
Node ≥ 22.5). Les données vivent dans `data/comptes.db` (ignoré par git).

---

## Capture — 4 méthodes, une seule base

Toutes convergent vers la même table `expenses` et passent par le même tri auto.

| Méthode | Écran | Ce que fait le prototype |
|---|---|---|
| 📷 **Ticket** | photo d'un ticket/facture | extraction *montant, marchand, date, catégorie probable* → brouillon à confirmer |
| 📖 **Carnet** | photo d'une page manuscrite | extraction **ligne par ligne** → liste à confirmer (transition douce : elle peut continuer à écrire) |
| 🎙️ **Voix** | dire la dépense à voix haute | transcription (navigateur) → analyse FR → montant + marchand + note + catégorie |
| ✍️ **Manuel** | 3 champs | montant, catégorie, note — filet de secours |

### OCR photo — enfichable
L'extraction photo est branchée sur un **fournisseur enfichable** (`server/extract.js`) :

- **Sans clé** (défaut) : la photo est enregistrée et un brouillon *à vérifier*
  est pré-rempli — la personne complète et valide. Le reste marche déjà.
- **Avec `ANTHROPIC_API_KEY`** : lecture réelle par vision Claude
  (ticket → 1 dépense, carnet → N lignes). Aucun autre changement de code.

```bash
export ANTHROPIC_API_KEY=sk-...
export EXTRACT_MODEL=claude-haiku-4-5-20251001   # optionnel
npm start
```

La **voix** utilise la reconnaissance vocale du navigateur (Web Speech API,
`fr-FR`) — aucune clé requise. Sur un navigateur sans support, bascule
automatiquement sur la saisie manuelle.

---

## Tri automatique & apprentissage

`server/categorize.js` classe chaque dépense, du signal le plus fiable au moins
fiable :

1. **Marchand connu** — règle apprise ou amorcée (`carrefour → Alimentation`).
2. **Mots-clés** présents dans marchand + note (score par catégorie).
3. **Repli** `Divers`, marqué *à vérifier*.

- On **reprend les catégories de la personne** (table `categories`, modifiable),
  on n'en invente pas. Le jeu de départ est un foyer type FR — à remplacer par
  **ses** catégories issues du carnet.
- **Correction = apprentissage** : quand elle reclasse une dépense, le marchand
  est mémorisé vers la bonne catégorie → la fois suivante c'est automatique.
  (Vérifié : un marchand inconnu part en *à vérifier*, une fois corrigé il est
  reconnu tout seul.)

---

## Rôles

- **Éditrice** (saisie) : protégée par un jeton (`EDITOR_TOKEN`, défaut `famille`),
  saisi une fois dans ⚙️ Réglages puis mémorisé.
- **Famille** (lecture seule) : `view.html`, aucun jeton, rafraîchi en direct.

> Garde-fou volontairement léger, adapté à un prototype. Pour un déploiement
> réel, remplacer par une vraie authentification et servir en HTTPS.

---

## Bilan / restitution

Vue visuelle (pas un tableau de comptable) : total du mois, répartition par
catégorie (barres), évolution mensuelle (histogramme), dernières dépenses.
Le même bilan alimente l'app éditrice et le lien famille.

---

## Décisions & points ouverts (repris du cadrage)

- **Budget** : V1 = **suivi passif** (voir où part l'argent). Les limites par
  catégorie + alertes seront ajoutées ensuite si le besoin se confirme.
- **Récap automatique périodique** (mail/message) : *pas encore implémenté* —
  la V1 fournit le lien de consultation actif. Le canal et la fréquence
  (hebdo/mensuel) restent à trancher ; l'API `GET /api/stats/summary` est déjà
  prête à alimenter un envoi programmé.
- **Granularité des catégories** : à caler sur le carnet réel de la personne.
- **App dédiée vs simple lien** : ici un lien web partagé (le plus léger à adopter).

---

## API (résumé)

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/categories` | public |
| POST/PATCH | `/api/categories` | éditrice |
| POST | `/api/parse` | éditrice — aperçu voix/texte |
| POST | `/api/capture/photo` | éditrice — ticket/carnet |
| GET | `/api/expenses` | public (lecture) |
| POST/PATCH/DELETE | `/api/expenses[/:id]` | éditrice (PATCH catégorie = apprentissage) |
| GET | `/api/stats/summary` | public — bilan |

## Structure

```
server/   index.js · db.js · categorize.js · parse.js · extract.js
public/   index.html (saisie) · view.html (famille) · app.js · view.js · styles.css
data/     comptes.db + uploads/  (générés, hors git)
```

## Prochaine étape

Prototype V1 (capture + tri) validé de bout en bout. Ensuite : brancher l'OCR
réel en production, caler les catégories sur le carnet existant, puis construire
le **récap automatique périodique** et, si besoin, le **budget actif**.
