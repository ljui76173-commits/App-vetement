'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');

const { db, isSeeded, seed, DATA_DIR } = require('./db');
const { categorize, learnFromCorrection } = require('./categorize');
const { parseExpense, parseReceiptText, parseLines } = require('./parse');
const { extractReceipt, extractNotebook, hasProvider } = require('./extract');
const { buildRecap, renderHtml, sendRecap, startScheduler, period } = require('./recap');

if (!isSeeded()) seed();

const app = express();
app.use(express.json({ limit: '20mb' }));

const PORT = process.env.PORT || 3000;
const EDITOR_TOKEN = process.env.EDITOR_TOKEN || 'famille';
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// --- Rôles : une seule éditrice (saisie), la famille en lecture seule. -------
function requireEditor(req, res, next) {
  const token = req.get('x-editor-token') || req.query.token;
  if (token !== EDITOR_TOKEN) {
    return res.status(401).json({ error: 'Édition réservée. Jeton éditeur requis.' });
  }
  next();
}

// --- Helpers -----------------------------------------------------------------
const toEuros = (cents) => Math.round(cents) / 100;
const toCents = (euros) => Math.round(Number(euros) * 100);
const today = () => new Date().toISOString().slice(0, 10);

function expenseView(row) {
  return {
    id: row.id,
    amount: toEuros(row.amount_cents),
    category_id: row.category_id,
    category: row.category_name || null,
    emoji: row.emoji || null,
    merchant: row.merchant,
    note: row.note,
    spent_at: row.spent_at,
    source: row.source,
    confidence: row.confidence,
    needs_review: !!row.needs_review,
    was_corrected: !!row.was_corrected,
    has_image: !!row.image_path,
    created_at: row.created_at,
  };
}

const EXPENSE_SELECT = `
  SELECT e.*, c.name AS category_name, c.emoji AS emoji
  FROM expenses e LEFT JOIN categories c ON c.id = e.category_id`;

function saveImage(base64, mediaType) {
  const ext = (mediaType && mediaType.split('/')[1]) || 'jpg';
  const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  const rel = path.join('uploads', name);
  fs.writeFileSync(path.join(UPLOAD_DIR, name), Buffer.from(base64, 'base64'));
  return rel;
}

// =============================================================================
//  Meta
// =============================================================================
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ocr: hasProvider() ? 'claude' : 'manuel', date: today() });
});

// =============================================================================
//  Catégories (celles de la personne — reprises, pas imposées)
// =============================================================================
app.get('/api/categories', (req, res) => {
  const rows = db
    .prepare('SELECT id, name, emoji, sort_order FROM categories WHERE archived = 0 ORDER BY sort_order, name')
    .all();
  res.json(rows);
});

app.post('/api/categories', requireEditor, (req, res) => {
  const { name, emoji } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom requis.' });
  try {
    const info = db
      .prepare('INSERT INTO categories (name, emoji, sort_order) VALUES (?, ?, 500)')
      .run(name.trim(), (emoji || '📌').trim());
    res.status(201).json(db.prepare('SELECT * FROM categories WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) {
    res.status(409).json({ error: 'Cette catégorie existe déjà.' });
  }
});

app.patch('/api/categories/:id', requireEditor, (req, res) => {
  const { name, emoji, archived } = req.body || {};
  const cur = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Introuvable.' });
  db.prepare('UPDATE categories SET name = ?, emoji = ?, archived = ? WHERE id = ?').run(
    name != null ? name.trim() : cur.name,
    emoji != null ? emoji.trim() : cur.emoji,
    archived != null ? (archived ? 1 : 0) : cur.archived,
    cur.id
  );
  res.json(db.prepare('SELECT * FROM categories WHERE id = ?').get(cur.id));
});

// =============================================================================
//  Aperçu du tri (sans enregistrer) — utile après voix/saisie rapide
// =============================================================================
app.post('/api/parse', requireEditor, (req, res) => {
  const { text } = req.body || {};
  const parsed = parseExpense(text || '');
  const guess = categorize({ merchant: parsed.merchant, note: parsed.note, amount: parsed.amount });
  const cat = guess.category_id
    ? db.prepare('SELECT name, emoji FROM categories WHERE id = ?').get(guess.category_id)
    : null;
  res.json({ parsed, suggestion: { ...guess, category: cat } });
});

// Texte OCR gratuit (Tesseract navigateur) -> dépense(s) + suggestion.
// Aucun service payant : l'OCR tourne côté navigateur, on ne reçoit que le texte.
app.post('/api/parse/ocr', requireEditor, (req, res) => {
  const { text = '', type = 'receipt' } = req.body || {};
  const withSuggestion = (d) => ({ ...d, suggestion: categorize({ merchant: d.merchant, note: d.note, amount: d.amount }) });
  if (type === 'notebook') {
    return res.json({ lines: parseLines(text).map(withSuggestion) });
  }
  const parsed = parseReceiptText(text);
  res.json({ draft: withSuggestion(parsed) });
});

// =============================================================================
//  Capture photo — ticket / carnet
// =============================================================================
app.post('/api/capture/photo', requireEditor, async (req, res) => {
  const { type = 'receipt', image, mediaType = 'image/jpeg' } = req.body || {};
  if (!image) return res.status(400).json({ error: 'Image (base64) requise.' });

  let imagePath = null;
  try {
    imagePath = saveImage(image, mediaType);
  } catch (e) {
    return res.status(400).json({ error: 'Image invalide.' });
  }

  const result =
    type === 'notebook'
      ? await extractNotebook(image, mediaType)
      : await extractReceipt(image, mediaType);

  // Enrichit chaque brouillon d'une suggestion de catégorie.
  const enrich = (d) => {
    const g = categorize({ merchant: d.merchant, note: d.note, amount: d.amount });
    return { ...d, suggestion: g };
  };

  res.json({
    provider: result.provider,
    message: result.message,
    image_path: imagePath,
    draft: result.draft ? enrich(result.draft) : null,
    lines: result.lines ? result.lines.map(enrich) : null,
  });
});

// =============================================================================
//  Dépenses
// =============================================================================
app.get('/api/expenses', (req, res) => {
  const { from, to, category, limit = 200, review } = req.query;
  const where = [];
  const params = [];
  if (from) { where.push('e.spent_at >= ?'); params.push(from); }
  if (to) { where.push('e.spent_at <= ?'); params.push(to); }
  if (category) { where.push('e.category_id = ?'); params.push(Number(category)); }
  if (review === '1') where.push('e.needs_review = 1');
  const sql =
    EXPENSE_SELECT +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ' ORDER BY e.spent_at DESC, e.id DESC LIMIT ?';
  params.push(Math.min(Number(limit) || 200, 1000));
  res.json(db.prepare(sql).all(...params).map(expenseView));
});

app.post('/api/expenses', requireEditor, (req, res) => {
  let { amount, category_id, merchant = '', note = '', spent_at, source = 'manual', image_path = null } =
    req.body || {};

  if (amount == null || isNaN(Number(amount)) || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Montant invalide.' });
  }
  spent_at = /^\d{4}-\d{2}-\d{2}$/.test(spent_at || '') ? spent_at : today();

  // Tri automatique si la catégorie n'est pas imposée.
  let confidence = 1;
  let needs_review = 0;
  if (!category_id) {
    const g = categorize({ merchant, note, amount });
    category_id = g.category_id;
    confidence = g.confidence;
    needs_review = g.needs_review ? 1 : 0;
  }

  const info = db
    .prepare(
      `INSERT INTO expenses (amount_cents, category_id, merchant, note, spent_at, source, confidence, needs_review, image_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(toCents(amount), category_id || null, merchant.trim(), note.trim(), spent_at, source, confidence, needs_review, image_path);

  const row = db.prepare(EXPENSE_SELECT + ' WHERE e.id = ?').get(info.lastInsertRowid);
  res.status(201).json(expenseView(row));
});

app.patch('/api/expenses/:id', requireEditor, (req, res) => {
  const cur = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Introuvable.' });

  const { amount, category_id, merchant, note, spent_at } = req.body || {};
  const newCat = category_id != null ? Number(category_id) : cur.category_id;
  const newMerchant = merchant != null ? merchant.trim() : cur.merchant;
  const newNote = note != null ? note.trim() : cur.note;

  // Correction de catégorie -> le système apprend.
  const corrected = category_id != null && Number(category_id) !== cur.category_id;
  if (corrected && newCat) {
    learnFromCorrection({ merchant: newMerchant, note: newNote, categoryId: newCat });
  }

  db.prepare(
    `UPDATE expenses SET amount_cents = ?, category_id = ?, merchant = ?, note = ?, spent_at = ?,
       needs_review = 0, was_corrected = ?, confidence = ? WHERE id = ?`
  ).run(
    amount != null ? toCents(amount) : cur.amount_cents,
    newCat || null,
    newMerchant,
    newNote,
    /^\d{4}-\d{2}-\d{2}$/.test(spent_at || '') ? spent_at : cur.spent_at,
    corrected ? 1 : cur.was_corrected,
    corrected ? 1 : cur.confidence,
    cur.id
  );

  res.json(expenseView(db.prepare(EXPENSE_SELECT + ' WHERE e.id = ?').get(cur.id)));
});

app.delete('/api/expenses/:id', requireEditor, (req, res) => {
  const row = db.prepare('SELECT image_path FROM expenses WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
  if (row && row.image_path) {
    fs.rm(path.join(DATA_DIR, row.image_path), () => {});
  }
  res.json({ ok: true });
});

// =============================================================================
//  Bilan / restitution
// =============================================================================
app.get('/api/stats/summary', (req, res) => {
  const { from, to } = req.query;
  const where = [];
  const params = [];
  if (from) { where.push('e.spent_at >= ?'); params.push(from); }
  if (to) { where.push('e.spent_at <= ?'); params.push(to); }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';

  const byCategory = db
    .prepare(
      `SELECT c.id, c.name, c.emoji, SUM(e.amount_cents) AS cents, COUNT(*) AS n
       FROM expenses e LEFT JOIN categories c ON c.id = e.category_id
       ${clause} GROUP BY e.category_id ORDER BY cents DESC`
    )
    .all(...params)
    .map((r) => ({ id: r.id, name: r.name || 'Non classé', emoji: r.emoji || '❓', total: toEuros(r.cents || 0), count: r.n }));

  const byMonth = db
    .prepare(
      `SELECT substr(e.spent_at, 1, 7) AS month, SUM(e.amount_cents) AS cents, COUNT(*) AS n
       FROM expenses e ${clause} GROUP BY month ORDER BY month`
    )
    .all(...params)
    .map((r) => ({ month: r.month, total: toEuros(r.cents || 0), count: r.n }));

  const totals = db.prepare(`SELECT SUM(amount_cents) AS cents, COUNT(*) AS n FROM expenses e ${clause}`).get(...params);
  const review = db.prepare(`SELECT COUNT(*) AS n FROM expenses e ${clause}${clause ? ' AND' : ' WHERE'} needs_review = 1`).get(...params);

  res.json({
    total: toEuros(totals.cents || 0),
    count: totals.n || 0,
    needs_review: review.n || 0,
    by_category: byCategory,
    by_month: byMonth,
  });
});

// =============================================================================
//  Récap automatique périodique
// =============================================================================
// Aperçu JSON (public — c'est un résumé destiné à la famille).
app.get('/api/recap', (req, res) => {
  const kind = req.query.period === 'week' ? 'week' : req.query.period === 'month' ? 'month' : period();
  res.json(buildRecap(kind));
});

// Page HTML du récap (celle qu'on partage / colle dans un mail).
app.get('/recap', (req, res) => {
  const kind = req.query.period === 'week' ? 'week' : req.query.period === 'month' ? 'month' : period();
  res.type('html').send(renderHtml(buildRecap(kind)));
});

// Déclenchement manuel de l'envoi (éditrice) — utile pour tester le canal.
app.post('/api/recap/send', requireEditor, async (req, res) => {
  const result = await sendRecap({ force: true, kind: req.body?.period === 'week' ? 'week' : req.body?.period === 'month' ? 'month' : period() });
  res.json(result);
});

// --- Fichiers statiques ------------------------------------------------------
app.use('/uploads', requireEditor, express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
  console.log(`\n  Carnet de comptes — prototype V1  (100% gratuit)`);
  console.log(`  ▸ App éditrice   : http://localhost:${PORT}/`);
  console.log(`  ▸ Vue famille    : http://localhost:${PORT}/view.html`);
  console.log(`  ▸ Récap          : http://localhost:${PORT}/recap  (envoi ${period()})`);
  console.log(`  ▸ Jeton éditeur  : "${EDITOR_TOKEN}"  (env EDITOR_TOKEN pour changer)`);
  console.log(`  ▸ OCR photo      : ${hasProvider() ? 'Claude vision (payant, clé détectée)' : 'gratuit — dans le navigateur'}\n`);
  startScheduler();
});
