'use strict';

/**
 * Analyse d'une phrase FR en dépense structurée.
 * Utilisé par la saisie vocale (transcription navigateur) et la saisie rapide.
 *
 * Exemples gérés :
 *   "18,50 chez Carrefour courses"
 *   "essence 60 euros à Total"
 *   "quinze euros cinquante de pain à la boulangerie"
 *   "cantine 4 euros 20"
 */

const UNITS = {
  zero: 0, un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6,
  sept: 7, huit: 8, neuf: 9, dix: 10, onze: 11, douze: 12, treize: 13,
  quatorze: 14, quinze: 15, seize: 16,
  vingt: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60,
  cent: 100, cents: 100,
};

const STOP_MERCHANT = new Set(['le', 'la', 'les', "l'", 'un', 'une', 'du', 'de', 'des']);

function wordsToNumber(tokens) {
  // Additionne une petite suite de mots-nombres FR (jusqu'à ~cent nonante-neuf).
  let total = 0;
  let current = 0;
  let matched = 0;
  for (const t of tokens) {
    const w = t.replace(/-/g, ' ');
    if (w === 'et') { matched++; continue; }
    if (UNITS[w] != null) {
      const v = UNITS[w];
      if (v === 100) { current = (current || 1) * 100; }
      else current += v;
      matched++;
    } else break;
  }
  total = current;
  return matched > 0 ? { value: total, consumed: matched } : null;
}

/**
 * @param {string} raw
 * @returns {{amount:number|null, merchant:string, note:string, raw:string}}
 */
function parseExpense(raw) {
  const text = (raw || '').trim();
  if (!text) return { amount: null, merchant: '', note: '', raw };

  let amount = null;
  let working = ` ${text} `;

  // 1) Montant chiffré : "18,50", "18.50", "60 euros", "4 euros 20", "12€".
  //    a) "X euros Y" (Y = centimes)
  let m = working.match(/(\d{1,6})\s*(?:euros?|€)\s*(\d{1,2})\b/i);
  if (m) {
    amount = parseInt(m[1], 10) + parseInt(m[2].padEnd(2, '0'), 10) / 100;
    working = working.replace(m[0], ' ');
  }
  //    b) "18,50" / "18.50" / "60" (+ euros/€ éventuel)
  if (amount == null) {
    m = working.match(/(\d{1,6}(?:[.,]\d{1,2})?)\s*(?:euros?|€)?/i);
    if (m && /\d/.test(m[1])) {
      amount = parseFloat(m[1].replace(',', '.'));
      working = working.replace(m[0], ' ');
    }
  }

  // 2) Montant en toutes lettres (repli si pas de chiffres).
  if (amount == null) {
    const toks = normalizeTokens(working);
    for (let i = 0; i < toks.length; i++) {
      if (UNITS[toks[i]] != null) {
        const euros = wordsToNumber(toks.slice(i));
        if (euros) {
          let val = euros.value;
          let j = i + euros.consumed;
          // "... euros <centimes en lettres>"
          if (toks[j] === 'euros' || toks[j] === 'euro') {
            const cents = wordsToNumber(toks.slice(j + 1));
            if (cents && cents.value < 100) val += cents.value / 100;
          }
          amount = val;
          break;
        }
      }
    }
    // On retire les mots-nombres et "euros" de la note.
    working = ` ${normalizeTokens(working)
      .filter((t) => UNITS[t] == null && t !== 'euros' && t !== 'euro' && t !== 'et')
      .join(' ')} `;
  }

  // 3) Marchand : après "chez" / "à" / "au" / "@".
  let merchant = '';
  const mm = working.match(/(?:^|\s)(?:chez|aux?|à|@)\s+([^,.;]+)/i);
  if (mm) {
    let cand = mm[1].trim().split(/\s+/);
    while (cand.length && STOP_MERCHANT.has(cand[0].toLowerCase())) cand.shift();
    // Marchand = 1 à 3 mots.
    merchant = cand.slice(0, 3).join(' ').trim();
    working = working.replace(mm[0], ' ');
  }

  // 4) Note = le reste nettoyé.
  const note = working
    .replace(/\b(euros?|€|de|d'|du|des|pour|le|la|les)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    amount: amount != null ? Math.round(amount * 100) / 100 : null,
    merchant: titleCase(merchant),
    note,
    raw: text,
  };
}

function normalizeTokens(s) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function titleCase(s) {
  return s
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Analyse le TEXTE BRUT d'un ticket (issu d'un OCR navigateur gratuit).
 * Heuristiques : marchand = 1re ligne parlante, date = jj/mm/aaaa,
 * total = ligne « total » sinon plus gros montant trouvé.
 * @returns {{amount:number|null, merchant:string, date:string|null, note:string}}
 */
function parseReceiptText(raw) {
  const lines = (raw || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return { amount: null, merchant: '', date: null, note: '' };

  // Marchand : 1re ligne d'au moins 2 lettres, sans montant ni date.
  let merchant = '';
  for (const l of lines) {
    if (/\d{1,2}[\/.]\d{1,2}/.test(l)) continue;
    const letters = l.replace(/[^a-zA-ZÀ-ÿ]/g, '');
    if (letters.length >= 2) { merchant = titleCase(l.replace(/\s{2,}/g, ' ')).slice(0, 40); break; }
  }

  // Date jj/mm/aaaa ou jj/mm/aa -> ISO.
  let date = null;
  for (const l of lines) {
    const m = l.match(/\b(\d{1,2})[\/.](\d{1,2})[\/.](\d{2,4})\b/);
    if (m) {
      let [, dd, mm, yy] = m;
      if (yy.length === 2) yy = '20' + yy;
      date = `${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
      break;
    }
  }

  // Montant : priorité aux lignes « total » (mais pas « sous-total »).
  const amountRe = /(\d{1,4}(?:[.,]\d{2}))/g;
  const money = (l) => {
    const nums = (l.match(amountRe) || []).map((s) => parseFloat(s.replace(',', '.')));
    return nums.length ? Math.max(...nums) : null;
  };
  let amount = null;
  const totalLines = lines.filter((l) => /total/i.test(l) && !/sous[- ]?total/i.test(l));
  const prioritized = [
    ...totalLines.filter((l) => /ttc|total\b/i.test(l)),
    ...totalLines,
  ];
  for (const l of prioritized) { const v = money(l); if (v) { amount = v; break; } }
  if (amount == null) {
    const all = lines.map(money).filter((v) => v != null);
    if (all.length) amount = Math.max(...all); // repli : plus gros montant du ticket
  }

  return { amount: amount != null ? Math.round(amount * 100) / 100 : null, merchant, date, note: '' };
}

/**
 * Découpe un texte multi-lignes (page de carnet OCRisée) en dépenses.
 * @returns {Array<{amount,merchant,note}>}
 */
function parseLines(raw) {
  return (raw || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /\d/.test(l)) // garde les lignes contenant un montant
    .map(parseExpense)
    .filter((p) => p.amount != null);
}

module.exports = { parseExpense, parseReceiptText, parseLines };
