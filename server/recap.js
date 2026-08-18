'use strict';

/**
 * Récap automatique — résumé périodique des dépenses pour la famille.
 *
 * Deux accès prévus dans le cadrage :
 *   1. Lien de consultation (déjà là : /view.html)
 *   2. Envoi automatique périodique pour ceux qui ne cliquent pas -> CE module.
 *
 * Fréquence & canal restaient à trancher. Défauts prototype (surchargables) :
 *   - RECAP_PERIOD = 'month' | 'week'        (défaut: month)
 *   - RECAP_WEBHOOK_URL = https://...        (Slack/Discord/relais mail/message)
 * Sans webhook : le récap est quand même généré et consultable en HTML
 * (/recap) — prêt à être copié dans un mail ou branché sur un canal réel.
 */

const path = require('node:path');
const fs = require('node:fs');
const { db, getSetting, setSetting, DATA_DIR } = require('./db');

const RECAP_DIR = path.join(DATA_DIR, 'recaps');
fs.mkdirSync(RECAP_DIR, { recursive: true });

const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet',
  'août', 'septembre', 'octobre', 'novembre', 'décembre'];

const toEuros = (c) => Math.round(c || 0) / 100;
const eur = (n) => n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });

function period() {
  return (process.env.RECAP_PERIOD || 'month').toLowerCase() === 'week' ? 'week' : 'month';
}

// --- Bornes de la période courante ------------------------------------------
function bounds(kind, ref = new Date()) {
  const d = new Date(ref);
  if (kind === 'week') {
    const day = (d.getDay() + 6) % 7; // lundi = 0
    const start = new Date(d); start.setDate(d.getDate() - day);
    const end = new Date(start); end.setDate(start.getDate() + 6);
    return { from: iso(start), to: iso(end), key: isoWeekKey(start), label: `semaine du ${start.getDate()} ${MONTHS_FR[start.getMonth()]}` };
  }
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return { from: iso(start), to: iso(end), key: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}`,
    label: `${MONTHS_FR[start.getMonth()]} ${start.getFullYear()}` };
}

function iso(d) { return d.toISOString().slice(0, 10); }
function isoWeekKey(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((t - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${t.getUTCFullYear()}-S${String(week).padStart(2, '0')}`;
}

/**
 * Construit le récap d'une période ('month' | 'week').
 */
function buildRecap(kind = period(), ref = new Date()) {
  const b = bounds(kind, ref);
  const byCat = db
    .prepare(
      `SELECT c.name, c.emoji, SUM(e.amount_cents) AS cents, COUNT(*) AS n
       FROM expenses e LEFT JOIN categories c ON c.id = e.category_id
       WHERE e.spent_at >= ? AND e.spent_at <= ?
       GROUP BY e.category_id ORDER BY cents DESC`
    )
    .all(b.from, b.to)
    .map((r) => ({ name: r.name || 'Non classé', emoji: r.emoji || '❓', total: toEuros(r.cents), count: r.n }));

  const totals = db
    .prepare('SELECT SUM(amount_cents) AS cents, COUNT(*) AS n FROM expenses WHERE spent_at >= ? AND spent_at <= ?')
    .get(b.from, b.to);

  // Comparaison avec la période précédente.
  const prevRef = new Date(ref);
  if (kind === 'week') prevRef.setDate(prevRef.getDate() - 7);
  else prevRef.setMonth(prevRef.getMonth() - 1);
  const pb = bounds(kind, prevRef);
  const prev = db
    .prepare('SELECT SUM(amount_cents) AS cents FROM expenses WHERE spent_at >= ? AND spent_at <= ?')
    .get(pb.from, pb.to);

  const total = toEuros(totals.cents);
  const prevTotal = toEuros(prev.cents);
  const delta = prevTotal ? Math.round(((total - prevTotal) / prevTotal) * 100) : null;

  return {
    kind, label: b.label, key: b.key, from: b.from, to: b.to,
    total, count: totals.n || 0,
    prev_total: prevTotal, delta_pct: delta,
    by_category: byCat,
    top: byCat[0] || null,
    generated_at: new Date().toISOString(),
  };
}

// --- Rendus -----------------------------------------------------------------
function renderText(r) {
  const lines = [
    `Comptes de la famille — ${r.label}`,
    ``,
    `Total dépensé : ${eur(r.total)}  (${r.count} dépense${r.count > 1 ? 's' : ''})`,
  ];
  if (r.delta_pct != null) {
    const s = r.delta_pct >= 0 ? '+' : '';
    lines.push(`Par rapport à la période précédente : ${s}${r.delta_pct}%`);
  }
  lines.push('', 'Où est parti l’argent :');
  for (const c of r.by_category) lines.push(`  ${c.emoji} ${c.name} — ${eur(c.total)}`);
  lines.push('', 'Détail : /view.html');
  return lines.join('\n');
}

function renderHtml(r) {
  const max = Math.max(...r.by_category.map((c) => c.total), 1);
  const rows = r.by_category
    .map(
      (c) => `<tr>
        <td style="padding:6px 0">${c.emoji} ${escapeHtml(c.name)}</td>
        <td style="padding:6px 0;width:50%">
          <div style="background:#f3e5d4;border-radius:9px;height:14px">
            <div style="background:#b5651d;height:14px;border-radius:9px;width:${(c.total / max) * 100}%"></div>
          </div></td>
        <td style="padding:6px 0;text-align:right;font-variant-numeric:tabular-nums">${eur(c.total)}</td>
      </tr>`
    )
    .join('');
  const deltaTxt =
    r.delta_pct == null ? '' :
    `<p style="color:${r.delta_pct >= 0 ? '#b4443a' : '#4f7a4a'};margin:4px 0 0">
       ${r.delta_pct >= 0 ? '▲' : '▼'} ${Math.abs(r.delta_pct)}% vs période précédente</p>`;

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Récap — ${escapeHtml(r.label)}</title></head>
<body style="margin:0;background:#faf6ef;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#2b2622">
<div style="max-width:520px;margin:0 auto;padding:24px">
  <div style="background:#fff;border:1px solid #e7ded0;border-radius:16px;padding:22px">
    <div style="font-size:.8rem;color:#6d655c;text-transform:uppercase;letter-spacing:.05em">📒 Comptes de la famille</div>
    <h1 style="margin:6px 0 2px;font-size:1.35rem">Récap — ${escapeHtml(r.label)}</h1>
    <p style="font-size:2rem;font-weight:800;margin:14px 0 0">${eur(r.total)}</p>
    <p style="color:#6d655c;margin:2px 0">${r.count} dépense${r.count > 1 ? 's' : ''}${r.top ? ` · surtout ${r.top.emoji} ${escapeHtml(r.top.name)}` : ''}</p>
    ${deltaTxt}
    <table style="width:100%;border-collapse:collapse;margin-top:18px">${rows || '<tr><td>Aucune dépense sur la période.</td></tr>'}</table>
    <p style="margin-top:20px"><a href="/view.html" style="color:#b5651d;font-weight:600">Voir le détail →</a></p>
  </div>
  <p style="text-align:center;color:#6d655c;font-size:.75rem;margin-top:14px">Récap automatique · comptes tenus à la main, résumés tout seuls</p>
</div></body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// --- Envoi (canal enfichable) -----------------------------------------------
async function deliver(r) {
  const html = renderHtml(r);
  const text = renderText(r);

  // Toujours : on écrit le dernier récap sur disque (consultable, copiable).
  fs.writeFileSync(path.join(RECAP_DIR, 'latest.html'), html);
  fs.writeFileSync(path.join(RECAP_DIR, `${r.key}.html`), html);

  const hook = process.env.RECAP_WEBHOOK_URL;
  if (hook) {
    try {
      await fetch(hook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Format compatible Slack/Discord ("text") + charge utile complète.
        body: JSON.stringify({ text, recap: r }),
      });
      return { channel: 'webhook', ok: true };
    } catch (e) {
      return { channel: 'webhook', ok: false, error: e.message };
    }
  }
  return { channel: 'file', ok: true };
}

/**
 * Envoi effectif + mémorisation pour ne pas ré-envoyer la même période.
 */
async function sendRecap({ force = false, kind = period() } = {}) {
  const r = buildRecap(kind);
  const lastKey = getSetting('recap_last_key');
  if (!force && lastKey === r.key) return { skipped: true, reason: 'déjà envoyé', key: r.key };
  const res = await deliver(r);
  setSetting('recap_last_key', r.key);
  setSetting('recap_last_at', new Date().toISOString());
  return { skipped: false, key: r.key, label: r.label, delivery: res };
}

/**
 * Planificateur léger : tourne tant que le serveur est allumé.
 * - mensuel : envoie le 1er du mois
 * - hebdo   : envoie le lundi
 * Vérifie chaque heure ; la mémorisation par clé évite les doublons.
 */
function startScheduler() {
  const check = () => {
    const kind = period();
    const now = new Date();
    const due = kind === 'week' ? now.getDay() === 1 : now.getDate() === 1;
    if (due) sendRecap({ kind }).catch(() => {});
  };
  check();
  setInterval(check, 60 * 60 * 1000);
}

module.exports = { buildRecap, renderHtml, renderText, sendRecap, startScheduler, period };
