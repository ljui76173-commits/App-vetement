'use strict';

/**
 * Extraction depuis une photo.
 *   - receipt  : ticket / facture -> UNE dépense (montant, marchand, date, catégorie probable)
 *   - notebook : page de carnet manuscrite -> PLUSIEURS lignes
 *
 * Fournisseur enfichable :
 *   - Si ANTHROPIC_API_KEY est défini -> vision Claude (extraction réelle).
 *   - Sinon -> repli "brouillon à vérifier" : la photo est conservée, une
 *     dépense est créée en needs_review, la personne complète/confirme.
 *     (Transition douce : elle peut continuer à photographier ses tickets et
 *      son carnet dès la V1, l'OCR réel se branche sans changer le reste.)
 */

const MODEL = process.env.EXTRACT_MODEL || 'claude-haiku-4-5-20251001';
const API_URL = 'https://api.anthropic.com/v1/messages';

function hasProvider() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

const RECEIPT_PROMPT = `Tu extrais les données d'un ticket de caisse ou d'une facture française.
Réponds UNIQUEMENT en JSON strict, sans texte autour :
{"amount": <nombre total TTC en euros>, "merchant": "<nom du commerçant>", "date": "YYYY-MM-DD ou null", "note": "<résumé court ou ''>"}
Si une info manque, mets null.`;

const NOTEBOOK_PROMPT = `Tu lis la photo d'une page de carnet de comptes manuscrit (français).
Extrais chaque ligne de dépense. Réponds UNIQUEMENT en JSON strict :
{"lines": [{"amount": <euros>, "merchant": "<marchand ou ''>", "date": "YYYY-MM-DD ou null", "note": "<libellé écrit>"}]}
Ignore les totaux et sous-totaux. Si illisible, mets amount:null.`;

async function callClaudeVision(prompt, imageBase64, mediaType) {
  const body = {
    model: MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: prompt },
        ],
      },
    ],
  };

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Vision API ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = (data.content || []).map((c) => c.text || '').join('').trim();
  return extractJson(text);
}

function extractJson(text) {
  // Isole le premier objet JSON même si le modèle ajoute du texte.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Réponse non-JSON');
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * @returns {Promise<{ok:boolean, provider:string, draft:object|null, lines:array|null, message:string}>}
 */
async function extractReceipt(imageBase64, mediaType = 'image/jpeg') {
  if (!hasProvider()) {
    return {
      ok: true,
      provider: 'none',
      draft: { amount: null, merchant: '', date: null, note: '' },
      lines: null,
      message: 'Photo enregistrée. OCR non configuré : complète les champs puis valide.',
    };
  }
  try {
    const r = await callClaudeVision(RECEIPT_PROMPT, imageBase64, mediaType);
    return {
      ok: true,
      provider: 'claude',
      draft: {
        amount: numOrNull(r.amount),
        merchant: str(r.merchant),
        date: str(r.date) || null,
        note: str(r.note),
      },
      lines: null,
      message: 'Ticket lu automatiquement — vérifie avant de valider.',
    };
  } catch (e) {
    return degrade(e);
  }
}

async function extractNotebook(imageBase64, mediaType = 'image/jpeg') {
  if (!hasProvider()) {
    return {
      ok: true,
      provider: 'none',
      draft: null,
      lines: [{ amount: null, merchant: '', date: null, note: '' }],
      message: 'Photo de carnet enregistrée. OCR non configuré : saisis les lignes puis valide.',
    };
  }
  try {
    const r = await callClaudeVision(NOTEBOOK_PROMPT, imageBase64, mediaType);
    const lines = Array.isArray(r.lines) ? r.lines : [];
    return {
      ok: true,
      provider: 'claude',
      draft: null,
      lines: lines.map((l) => ({
        amount: numOrNull(l.amount),
        merchant: str(l.merchant),
        date: str(l.date) || null,
        note: str(l.note),
      })),
      message: `${lines.length} ligne(s) lue(s) — vérifie avant de valider.`,
    };
  } catch (e) {
    return degrade(e);
  }
}

function degrade(e) {
  return {
    ok: true,
    provider: 'error',
    draft: { amount: null, merchant: '', date: null, note: '' },
    lines: [{ amount: null, merchant: '', date: null, note: '' }],
    message: `Lecture auto indisponible (${e.message.slice(0, 80)}). Saisie manuelle possible.`,
  };
}

function numOrNull(v) {
  const n = typeof v === 'string' ? parseFloat(v.replace(',', '.')) : v;
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function str(v) {
  return v == null ? '' : String(v).trim();
}

module.exports = { extractReceipt, extractNotebook, hasProvider };
