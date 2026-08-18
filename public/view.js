'use strict';

// Vue famille — lecture seule. Aucun jeton : uniquement les endpoints publics.
const $ = (s) => document.querySelector(s);
const euro = (n) => n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
const todayISO = () => new Date().toISOString().slice(0, 10);
const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

async function get(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error('Erreur ' + res.status);
  return res.json();
}

function fmtMonth(ym) {
  const [y, m] = ym.split('-');
  return ['jan', 'fév', 'mar', 'avr', 'mai', 'juin', 'juil', 'aoû', 'sep', 'oct', 'nov', 'déc'][+m - 1] + ' ' + y.slice(2);
}

async function load() {
  const from = todayISO().slice(0, 8) + '01';
  const [month, all, expenses] = await Promise.all([
    get(`/api/stats/summary?from=${from}`),
    get('/api/stats/summary'),
    get('/api/expenses?limit=15'),
  ]);

  $('#kpiTotal').textContent = euro(month.total);
  $('#kpiCount').textContent = month.count;

  const max = Math.max(...month.by_category.map((c) => c.total), 1);
  $('#catBars').innerHTML = month.by_category.length
    ? month.by_category.map((c) => `
        <div class="bar-row">
          <div class="lab">${c.emoji} ${escapeHtml(c.name)}</div>
          <div class="track"><div class="fill" style="width:${(c.total / max) * 100}%"></div></div>
          <div class="val">${euro(c.total)}</div>
        </div>`).join('')
    : '<p class="muted center">Pas encore de dépense ce mois-ci.</p>';

  const months = all.by_month.slice(-6);
  const mmax = Math.max(...months.map((m) => m.total), 1);
  $('#monthChart').innerHTML = months.length
    ? months.map((m) => `
        <div class="m">
          <div class="mv">${Math.round(m.total)}</div>
          <div class="col" style="height:${Math.max((m.total / mmax) * 100, 3)}%"></div>
          <div class="ml">${fmtMonth(m.month)}</div>
        </div>`).join('')
    : '<p class="muted center">—</p>';

  $('#expenseList').innerHTML = expenses.length
    ? expenses.map((e) => `
        <div class="exp">
          <div class="emoji">${e.emoji || '❓'}</div>
          <div class="mid">
            <div class="t">${escapeHtml(e.category || 'Non classé')}</div>
            <div class="s">${escapeHtml(e.merchant || e.note || '—')} · ${e.spent_at.slice(5).replace('-', '/')}</div>
          </div>
          <div class="amt">${euro(e.amount)}</div>
        </div>`).join('')
    : '<p class="muted center">Aucune dépense.</p>';
}

load().catch(() => { $('#catBars').innerHTML = '<p class="muted center">Serveur injoignable.</p>'; });
setInterval(() => load().catch(() => {}), 30000); // rafraîchit toutes les 30 s
