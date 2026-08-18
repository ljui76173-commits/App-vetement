'use strict';

/**
 * Persistance — SQLite intégré à Node (node:sqlite, aucune compilation native).
 * Toutes les méthodes de capture (photo, voix, manuelle) convergent ici.
 */

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

// DATA_DIR peut pointer vers un disque persistant (hébergement) via l'env.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'comptes.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE,
      emoji       TEXT NOT NULL DEFAULT '📌',
      sort_order  INTEGER NOT NULL DEFAULT 100,
      archived    INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS merchant_rules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern     TEXT NOT NULL UNIQUE,      -- marchand normalisé
      category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      hits        INTEGER NOT NULL DEFAULT 1,
      source      TEXT NOT NULL DEFAULT 'learned' -- 'seed' | 'learned'
    );

    CREATE TABLE IF NOT EXISTS keyword_rules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      keyword     TEXT NOT NULL,
      category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      weight      REAL NOT NULL DEFAULT 1.0,
      UNIQUE(keyword, category_id)
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      amount_cents INTEGER NOT NULL,
      category_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      merchant     TEXT NOT NULL DEFAULT '',
      note         TEXT NOT NULL DEFAULT '',
      spent_at     TEXT NOT NULL,            -- YYYY-MM-DD
      source       TEXT NOT NULL DEFAULT 'manual',
      confidence   REAL NOT NULL DEFAULT 0,  -- 0..1 confiance du tri auto
      needs_review INTEGER NOT NULL DEFAULT 0,
      was_corrected INTEGER NOT NULL DEFAULT 0,
      image_path   TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_expenses_spent_at ON expenses(spent_at);
    CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category_id);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

/**
 * Catégories de départ. Dans la vraie vie elles sont REPRISES du carnet de la
 * personne (pas inventées) — ici on part d'un jeu type foyer français que
 * l'éditrice peut renommer / archiver / compléter depuis l'app.
 */
const SEED_CATEGORIES = [
  { name: 'Alimentation', emoji: '🛒', sort_order: 10 },
  { name: 'Restaurant', emoji: '🍽️', sort_order: 20 },
  { name: 'Transport', emoji: '🚗', sort_order: 30 },
  { name: 'Logement', emoji: '🏠', sort_order: 40 },
  { name: 'Santé', emoji: '💊', sort_order: 50 },
  { name: 'Loisirs', emoji: '🎉', sort_order: 60 },
  { name: 'Vêtements', emoji: '👕', sort_order: 70 },
  { name: 'Enfants / École', emoji: '🎓', sort_order: 80 },
  { name: 'Factures / Abos', emoji: '💡', sort_order: 90 },
  { name: 'Divers', emoji: '💳', sort_order: 999 },
];

// Mots-clés amorce (marchands & termes FR). Le moteur apprend ensuite tout seul.
const SEED_KEYWORDS = {
  'Alimentation': ['carrefour', 'leclerc', 'lidl', 'aldi', 'auchan', 'intermarche',
    'monoprix', 'franprix', 'super u', 'casino', 'picard', 'grand frais', 'courses',
    'boulangerie', 'boucherie', 'marche', 'epicerie', 'primeur'],
  'Restaurant': ['restaurant', 'resto', 'mcdo', 'mcdonald', 'kfc', 'burger', 'pizza',
    'brasserie', 'cafe', 'bar', 'kebab', 'sushi', 'traiteur'],
  'Transport': ['essence', 'carburant', 'gazole', 'diesel', 'sp95', 'sncf', 'ratp',
    'metro', 'bus', 'tram', 'peage', 'parking', 'uber', 'taxi', 'total energies',
    'esso', 'station', 'train', 'blablacar', 'garage', 'vidange'],
  'Logement': ['loyer', 'edf', 'engie', 'gaz', 'electricite', 'eau', 'veolia', 'suez',
    'charges', 'syndic', 'assurance habitation', 'ikea', 'bricolage', 'leroy merlin',
    'castorama'],
  'Santé': ['pharmacie', 'medecin', 'docteur', 'dentiste', 'mutuelle', 'hopital',
    'clinique', 'opticien', 'laboratoire', 'kine', 'osteo', 'radiologie'],
  'Loisirs': ['cinema', 'netflix', 'spotify', 'disney', 'concert', 'musee', 'sport',
    'piscine', 'jeux', 'fnac', 'livre', 'theatre', 'salle de sport', 'club'],
  'Vêtements': ['zara', 'h&m', 'hm', 'kiabi', 'decathlon', 'uniqlo', 'chaussures',
    'vetements', 'gemo', 'celio', 'jules', 'zalando'],
  'Enfants / École': ['cantine', 'ecole', 'college', 'lycee', 'fournitures', 'creche',
    'garderie', 'centre de loisirs', 'peri scolaire', 'activite', 'nounou'],
  'Factures / Abos': ['abonnement', 'forfait', 'internet', 'mobile', 'orange', 'sfr',
    'free', 'bouygues', 'canal', 'assurance', 'impots', 'box'],
  'Divers': [],
};

// Marchands connus -> règle marchand directe (tri le plus fiable).
const SEED_MERCHANTS = {
  'Alimentation': ['carrefour', 'leclerc', 'lidl', 'aldi', 'auchan', 'intermarche',
    'monoprix', 'franprix', 'picard'],
  'Transport': ['total', 'total energies', 'esso', 'sncf', 'ratp', 'uber'],
  'Loisirs': ['netflix', 'spotify', 'fnac'],
  'Factures / Abos': ['orange', 'sfr', 'free', 'bouygues'],
  'Vêtements': ['zara', 'decathlon', 'kiabi'],
};

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // enlève accents
    .replace(/[^a-z0-9& ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function seed() {
  const catByName = new Map();
  const insCat = db.prepare(
    'INSERT OR IGNORE INTO categories (name, emoji, sort_order) VALUES (?, ?, ?)'
  );
  for (const c of SEED_CATEGORIES) insCat.run(c.name, c.emoji, c.sort_order);
  for (const row of db.prepare('SELECT id, name FROM categories').all()) {
    catByName.set(row.name, row.id);
  }

  const insKw = db.prepare(
    'INSERT OR IGNORE INTO keyword_rules (keyword, category_id, weight) VALUES (?, ?, ?)'
  );
  for (const [cat, words] of Object.entries(SEED_KEYWORDS)) {
    const cid = catByName.get(cat);
    if (!cid) continue;
    for (const w of words) insKw.run(normalize(w), cid, 1.0);
  }

  const insMr = db.prepare(
    "INSERT OR IGNORE INTO merchant_rules (pattern, category_id, hits, source) VALUES (?, ?, 3, 'seed')"
  );
  for (const [cat, merchants] of Object.entries(SEED_MERCHANTS)) {
    const cid = catByName.get(cat);
    if (!cid) continue;
    for (const m of merchants) insMr.run(normalize(m), cid);
  }
}

function isSeeded() {
  return db.prepare('SELECT COUNT(*) AS n FROM categories').get().n > 0;
}

function reset() {
  db.exec(`
    DROP TABLE IF EXISTS expenses;
    DROP TABLE IF EXISTS merchant_rules;
    DROP TABLE IF EXISTS keyword_rules;
    DROP TABLE IF EXISTS categories;
  `);
  migrate();
  seed();
}

migrate();

module.exports = { db, migrate, seed, reset, isSeeded, normalize, getSetting, setSetting, DATA_DIR };

// CLI: node server/db.js --seed | --reset
if (require.main === module) {
  const arg = process.argv[2];
  if (arg === '--reset') {
    reset();
    console.log('Base réinitialisée et amorcée.');
  } else if (arg === '--seed') {
    if (isSeeded()) console.log('Déjà amorcée — rien à faire.');
    else { seed(); console.log('Catégories & règles amorcées.'); }
  } else {
    console.log('Usage: node server/db.js --seed | --reset');
  }
}
