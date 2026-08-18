'use strict';

/**
 * Tri automatique — catégorisation intelligente.
 *
 * Signaux, du plus fiable au moins fiable :
 *   1. Règle marchand apprise/amorcée  (ex: "carrefour" -> Alimentation)
 *   2. Mots-clés présents dans marchand + note
 *   3. Repli "Divers" avec drapeau needs_review
 *
 * Le moteur REPREND les catégories de la personne (celles en base) et
 * APPREND de chaque correction manuelle (mémorise le marchand corrigé).
 */

const { db, normalize } = require('./db');

function categoriesById() {
  const map = new Map();
  for (const c of db.prepare('SELECT * FROM categories WHERE archived = 0').all()) {
    map.set(c.id, c);
  }
  return map;
}

/**
 * @returns {{category_id:number|null, confidence:number, needs_review:boolean, reason:string}}
 */
function categorize({ merchant = '', note = '', amount = null } = {}) {
  const nMerchant = normalize(merchant);
  const text = normalize(`${merchant} ${note}`);

  // 1) Règle marchand : correspondance exacte ou sous-chaîne.
  if (nMerchant) {
    const rules = db
      .prepare('SELECT * FROM merchant_rules ORDER BY LENGTH(pattern) DESC, hits DESC')
      .all();
    for (const r of rules) {
      if (nMerchant === r.pattern || nMerchant.includes(r.pattern)) {
        // Confiance croît avec le nb d'observations (marchand déjà vu).
        const conf = Math.min(0.98, 0.75 + Math.log2(r.hits + 1) * 0.06);
        return {
          category_id: r.category_id,
          confidence: round(conf),
          needs_review: false,
          reason: `marchand connu « ${r.pattern} »`,
        };
      }
    }
  }

  // 2) Mots-clés : score par catégorie.
  const scores = new Map();
  const hitWords = new Map();
  if (text) {
    for (const kw of db.prepare('SELECT * FROM keyword_rules').all()) {
      if (!kw.keyword) continue;
      if (containsWord(text, kw.keyword)) {
        scores.set(kw.category_id, (scores.get(kw.category_id) || 0) + kw.weight);
        if (!hitWords.has(kw.category_id)) hitWords.set(kw.category_id, kw.keyword);
      }
    }
  }

  if (scores.size > 0) {
    let bestCat = null;
    let best = 0;
    let total = 0;
    for (const [cid, sc] of scores) {
      total += sc;
      if (sc > best) { best = sc; bestCat = cid; }
    }
    // Confiance = force du meilleur score, atténuée si plusieurs catégories rivalisent.
    const share = best / total;
    const conf = Math.min(0.9, 0.45 + share * 0.4);
    return {
      category_id: bestCat,
      confidence: round(conf),
      needs_review: conf < 0.6,
      reason: `mot-clé « ${hitWords.get(bestCat)} »`,
    };
  }

  // 3) Repli.
  const fallback = db
    .prepare("SELECT id FROM categories WHERE name = 'Divers' AND archived = 0")
    .get();
  return {
    category_id: fallback ? fallback.id : null,
    confidence: 0,
    needs_review: true,
    reason: 'aucun indice — à vérifier',
  };
}

/**
 * Apprentissage : quand la personne corrige la catégorie d'une dépense, on
 * mémorise le marchand -> nouvelle catégorie pour que ça colle la prochaine fois.
 */
function learnFromCorrection({ merchant, note, categoryId }) {
  const nMerchant = normalize(merchant);
  if (nMerchant && nMerchant.length >= 2) {
    const existing = db
      .prepare('SELECT * FROM merchant_rules WHERE pattern = ?')
      .get(nMerchant);
    if (existing) {
      if (existing.category_id === categoryId) {
        db.prepare('UPDATE merchant_rules SET hits = hits + 1 WHERE id = ?')
          .run(existing.id);
      } else {
        // La personne a le dernier mot : on rebascule la règle + on repart le compteur.
        db.prepare(
          "UPDATE merchant_rules SET category_id = ?, hits = 2, source = 'learned' WHERE id = ?"
        ).run(categoryId, existing.id);
      }
    } else {
      db.prepare(
        "INSERT INTO merchant_rules (pattern, category_id, hits, source) VALUES (?, ?, 2, 'learned')"
      ).run(nMerchant, categoryId);
    }
  }

  // Bonus : renforce les mots significatifs de la note (>= 4 lettres).
  const words = new Set(normalize(note).split(' ').filter((w) => w.length >= 4));
  const insKw = db.prepare(
    'INSERT INTO keyword_rules (keyword, category_id, weight) VALUES (?, ?, 0.6) ' +
    'ON CONFLICT(keyword, category_id) DO UPDATE SET weight = MIN(weight + 0.3, 3.0)'
  );
  for (const w of words) insKw.run(w, categoryId);
}

function containsWord(text, phrase) {
  // phrase peut contenir des espaces (ex: "super u") -> match sous-chaîne sur limites de mots.
  if (phrase.includes(' ')) return text.includes(phrase);
  const re = new RegExp(`(^| )${escapeRe(phrase)}( |$)`);
  return re.test(text);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function round(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { categorize, learnFromCorrection, categoriesById };
