'use strict';

// ---------------------------------------------------------------------------
// État & utilitaires
// ---------------------------------------------------------------------------
const state = {
  token: localStorage.getItem('editorToken') || 'famille',
  categories: [],
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const euro = (n) => n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
const todayISO = () => new Date().toISOString().slice(0, 10);

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

async function api(path, opts = {}) {
  const headers = { 'content-type': 'application/json', 'x-editor-token': state.token, ...(opts.headers || {}) };
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

// ---------------------------------------------------------------------------
// Navigation onglets
// ---------------------------------------------------------------------------
$$('nav.tabs button').forEach((b) =>
  b.addEventListener('click', () => {
    $$('nav.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    const tab = b.dataset.tab;
    ['saisie', 'bilan', 'cats'].forEach((t) => $('#tab-' + t).classList.toggle('hidden', t !== tab));
    if (tab === 'bilan') loadStats();
    if (tab === 'cats') renderCatManager();
  })
);

// ---------------------------------------------------------------------------
// Réglages (jeton éditeur)
// ---------------------------------------------------------------------------
$('#settingsBtn').addEventListener('click', () => {
  $('#tokenInput').value = state.token;
  $('#settingsDialog').showModal();
});
$('#saveToken').addEventListener('click', () => {
  state.token = $('#tokenInput').value.trim() || 'famille';
  localStorage.setItem('editorToken', state.token);
  $('#settingsDialog').close();
  toast('Jeton enregistré');
  refresh();
});

// ---------------------------------------------------------------------------
// Capture — 4 méthodes
// ---------------------------------------------------------------------------
let pendingPhotoType = 'receipt';
$$('.method').forEach((m) =>
  m.addEventListener('click', () => {
    const method = m.dataset.method;
    if (method === 'manual') openManual();
    else if (method === 'voice') startVoice();
    else { pendingPhotoType = method; $('#fileInput').click(); }
  })
);

$('#fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const { base64, mediaType } = await readFile(file);
  const dataUrl = `data:${mediaType};base64,${base64}`;

  // 1) Enregistre la photo (et lit via Claude vision si une clé est configurée).
  let stored;
  try {
    stored = await api('/api/capture/photo', {
      method: 'POST',
      body: JSON.stringify({ type: pendingPhotoType, image: base64, mediaType }),
    });
  } catch (err) {
    return toast(err.message);
  }
  if (stored.provider === 'claude') {
    if (stored.lines) return openNotebookLines(stored.lines, stored.image_path, stored.message);
    return openEntryForm({ ...stored.draft, source: pendingPhotoType, image_path: stored.image_path, hint: stored.message });
  }

  // 2) Mode GRATUIT : OCR dans le navigateur (aucune clé, aucun coût).
  try {
    toast('🔍 Lecture de la photo (gratuit)…');
    const text = await ocrImage(dataUrl);
    const r = await api('/api/parse/ocr', { method: 'POST', body: JSON.stringify({ text, type: pendingPhotoType }) });
    if (r.lines) {
      if (!r.lines.length) { toast('Rien de lisible — saisis à la main'); return openEntryForm({ source: pendingPhotoType, image_path: stored.image_path }); }
      return openNotebookLines(r.lines, stored.image_path, `${r.lines.length} ligne(s) lue(s) — vérifie / corrige`);
    }
    openEntryForm({ ...r.draft, source: pendingPhotoType, image_path: stored.image_path, hint: 'Lu automatiquement (gratuit) — vérifie avant de valider.' });
  } catch (err) {
    // OCR indisponible (hors ligne) -> brouillon manuel, la photo reste jointe.
    openEntryForm({ source: pendingPhotoType, image_path: stored.image_path, hint: 'Lecture auto indisponible — complète à la main.' });
  }
});

// OCR gratuit dans le navigateur (Tesseract.js, chargé à la demande).
let _tesseract;
function ensureTesseract() {
  if (window.Tesseract) return Promise.resolve();
  if (!_tesseract) {
    _tesseract = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('OCR indisponible (hors ligne)'));
      document.head.appendChild(s);
    });
  }
  return _tesseract;
}
async function ocrImage(dataUrl) {
  await ensureTesseract();
  const { data } = await window.Tesseract.recognize(dataUrl, 'fra');
  return data.text || '';
}

function readFile(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const [meta, b64] = reader.result.split(',');
      const mediaType = meta.slice(5).split(';')[0] || 'image/jpeg';
      resolve({ base64: b64, mediaType });
    };
    reader.readAsDataURL(file);
  });
}

// --- Voix : Web Speech API (transcription navigateur) ----------------------
function startVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    toast("Voix non dispo sur ce navigateur — saisie manuelle");
    return openManual();
  }
  const rec = new SR();
  rec.lang = 'fr-FR';
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  toast('🎙️ Parlez… (ex : « 18,50 chez Carrefour, courses »)');
  rec.start();
  rec.onerror = () => toast('Micro indisponible — saisie manuelle');
  rec.onresult = async (ev) => {
    const text = ev.results[0][0].transcript;
    try {
      const r = await api('/api/parse', { method: 'POST', body: JSON.stringify({ text }) });
      openEntryForm({
        amount: r.parsed.amount,
        merchant: r.parsed.merchant,
        note: r.parsed.note || text,
        source: 'voice',
        suggestion: r.suggestion,
        hint: `Entendu : « ${text} »`,
      });
    } catch (err) {
      toast(err.message);
    }
  };
}

// ---------------------------------------------------------------------------
// Formulaire de saisie / confirmation (une dépense)
// ---------------------------------------------------------------------------
function openManual() {
  openEntryForm({ source: 'manual' });
}

function categoryOptions(selectedId) {
  const auto = `<option value="">✨ Auto (tri intelligent)</option>`;
  const opts = state.categories
    .map((c) => `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>${c.emoji} ${c.name}</option>`)
    .join('');
  return auto + opts;
}

function openEntryForm(d = {}) {
  const dlg = $('#entryDialog');
  $('#entryTitle').textContent = { manual: 'Saisie manuelle', voice: 'Dépense vocale', receipt: 'Ticket', notebook: 'Carnet' }[d.source] || 'Nouvelle dépense';

  const sugg = d.suggestion && d.suggestion.category_id
    ? `<div class="suggestion">✨ Suggestion : <b>${catName(d.suggestion.category_id)}</b>
         <span class="muted">(${Math.round((d.suggestion.confidence || 0) * 100)}% — ${d.suggestion.reason || ''})</span></div>`
    : '';

  $('#entryBody').innerHTML = `
    ${d.hint ? `<p class="hint">${escapeHtml(d.hint)}</p>` : ''}
    <div class="row">
      <div>
        <label>Montant (€)</label>
        <input id="fAmount" type="number" inputmode="decimal" step="0.01" value="${d.amount ?? ''}" placeholder="0,00" />
      </div>
      <div>
        <label>Date</label>
        <input id="fDate" type="date" value="${d.date || todayISO()}" />
      </div>
    </div>
    <label>Commerçant</label>
    <input id="fMerchant" value="${escapeAttr(d.merchant || '')}" placeholder="ex : Carrefour" />
    <label>Catégorie</label>
    <select id="fCategory">${categoryOptions(d.suggestion?.category_id)}</select>
    ${sugg}
    <label>Note (facultatif)</label>
    <input id="fNote" value="${escapeAttr(d.note || '')}" placeholder="ex : courses de la semaine" />
    <div class="row mt">
      <button class="ghost" id="fCancel">Annuler</button>
      <button class="primary" id="fSave" style="margin-top:0">Enregistrer</button>
    </div>`;

  dlg.showModal();
  $('#fCancel').onclick = () => dlg.close();
  $('#fSave').onclick = async () => {
    const amount = parseFloat(($('#fAmount').value || '').replace(',', '.'));
    if (!amount || amount <= 0) return toast('Montant manquant');
    const catVal = $('#fCategory').value;
    try {
      await api('/api/expenses', {
        method: 'POST',
        body: JSON.stringify({
          amount,
          category_id: catVal ? Number(catVal) : null,
          merchant: $('#fMerchant').value,
          note: $('#fNote').value,
          spent_at: $('#fDate').value,
          source: d.source || 'manual',
          image_path: d.image_path || null,
        }),
      });
      dlg.close();
      toast('Dépense ajoutée ✓');
      refresh();
    } catch (err) {
      toast(err.message);
    }
  };
  setTimeout(() => $('#fAmount').focus(), 50);
}

// --- Carnet : plusieurs lignes à confirmer ---------------------------------
function openNotebookLines(lines, imagePath, message) {
  const dlg = $('#entryDialog');
  $('#entryTitle').textContent = 'Lignes du carnet';
  $('#entryBody').innerHTML = `
    ${message ? `<p class="hint">${escapeHtml(message)}</p>` : ''}
    <div id="linesWrap"></div>
    <div class="row mt">
      <button class="ghost" id="lCancel">Annuler</button>
      <button class="primary" id="lSave" style="margin-top:0">Tout enregistrer</button>
    </div>`;
  const wrap = $('#linesWrap');
  lines.forEach((ln, i) => {
    const div = document.createElement('div');
    div.className = 'line-item';
    div.innerHTML = `
      <div class="row">
        <input class="l-amt" type="number" step="0.01" inputmode="decimal" placeholder="€" value="${ln.amount ?? ''}" />
        <input class="l-merch" placeholder="commerçant" value="${escapeAttr(ln.merchant || '')}" />
      </div>
      <input class="l-note mt" placeholder="note" value="${escapeAttr(ln.note || '')}" />
      <select class="l-cat mt">${categoryOptions(ln.suggestion?.category_id)}</select>`;
    wrap.appendChild(div);
  });
  dlg.showModal();
  $('#lCancel').onclick = () => dlg.close();
  $('#lSave').onclick = async () => {
    const items = $$('.line-item', wrap);
    let saved = 0;
    for (const it of items) {
      const amount = parseFloat(($('.l-amt', it).value || '').replace(',', '.'));
      if (!amount || amount <= 0) continue;
      const catVal = $('.l-cat', it).value;
      await api('/api/expenses', {
        method: 'POST',
        body: JSON.stringify({
          amount,
          category_id: catVal ? Number(catVal) : null,
          merchant: $('.l-merch', it).value,
          note: $('.l-note', it).value,
          source: 'notebook',
          image_path: imagePath,
        }),
      });
      saved++;
    }
    dlg.close();
    toast(`${saved} ligne(s) enregistrée(s) ✓`);
    refresh();
  };
}

// ---------------------------------------------------------------------------
// Liste des dépenses + correction de catégorie (apprentissage)
// ---------------------------------------------------------------------------
async function loadExpenses() {
  const list = await api('/api/expenses?limit=40');
  const el = $('#expenseList');
  if (!list.length) {
    el.innerHTML = `<p class="muted center">Aucune dépense pour l'instant.</p>`;
    return;
  }
  el.innerHTML = '';
  list.forEach((e) => el.appendChild(renderExpense(e)));
}

function renderExpense(e) {
  const div = document.createElement('div');
  div.className = 'exp' + (e.needs_review ? ' review' : '');
  const sub = [
    e.merchant || e.note || '—',
    e.spent_at.slice(5).replace('-', '/'),
    e.needs_review ? '<span class="flag">à vérifier</span>' : '',
    e.was_corrected ? '<span class="corr">appris ✓</span>' : '',
  ].filter(Boolean).join(' · ');

  div.innerHTML = `
    <div class="emoji">${e.emoji || '❓'}</div>
    <div class="mid">
      <div class="t">${escapeHtml(e.category || 'Non classé')}</div>
      <div class="s">${sub}</div>
    </div>
    <div class="amt">${euro(e.amount)}</div>`;
  div.querySelector('.emoji').onclick = () => pickCategory(e);
  div.querySelector('.mid').onclick = () => pickCategory(e);
  return div;
}

function pickCategory(e) {
  const dlg = $('#entryDialog');
  $('#entryTitle').textContent = 'Bonne catégorie ?';
  $('#entryBody').innerHTML = `
    <p class="hint">${escapeHtml(e.merchant || e.note || 'Dépense')} — ${euro(e.amount)}</p>
    <div class="chips" id="pickChips"></div>
    <p class="hint mt">Le tri retiendra ta correction pour la prochaine fois.</p>
    <div class="row mt">
      <button class="ghost" id="pDel">Supprimer</button>
      <button class="ghost" id="pClose">Fermer</button>
    </div>`;
  const chips = $('#pickChips');
  state.categories.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'chip' + (c.id === e.category_id ? ' on' : '');
    b.innerHTML = `${c.emoji} ${c.name}`;
    b.onclick = async () => {
      await api(`/api/expenses/${e.id}`, { method: 'PATCH', body: JSON.stringify({ category_id: c.id }) });
      dlg.close();
      toast(`Classé dans ${c.name} — appris ✓`);
      refresh();
    };
    chips.appendChild(b);
  });
  $('#pClose').onclick = () => dlg.close();
  $('#pDel').onclick = async () => {
    await api(`/api/expenses/${e.id}`, { method: 'DELETE' });
    dlg.close();
    toast('Supprimée');
    refresh();
  };
  dlg.showModal();
}

// ---------------------------------------------------------------------------
// Bilan
// ---------------------------------------------------------------------------
async function loadStats() {
  const from = todayISO().slice(0, 8) + '01';
  const s = await api(`/api/stats/summary?from=${from}`);
  $('#kpiTotal').textContent = euro(s.total);
  $('#kpiCount').textContent = s.count;
  $('#kpiReview').textContent = s.needs_review;

  const max = Math.max(...s.by_category.map((c) => c.total), 1);
  $('#catBars').innerHTML = s.by_category.length
    ? s.by_category.map((c) => `
        <div class="bar-row">
          <div class="lab">${c.emoji} ${escapeHtml(c.name)}</div>
          <div class="track"><div class="fill" style="width:${(c.total / max) * 100}%"></div></div>
          <div class="val">${euro(c.total)}</div>
        </div>`).join('')
    : '<p class="muted center">Pas encore de dépense ce mois-ci.</p>';

  await loadMonths();
}

async function loadMonths() {
  const s = await api('/api/stats/summary');
  const months = s.by_month.slice(-6);
  const max = Math.max(...months.map((m) => m.total), 1);
  $('#monthChart').innerHTML = months.length
    ? months.map((m) => `
        <div class="m">
          <div class="mv">${Math.round(m.total)}</div>
          <div class="col" style="height:${Math.max((m.total / max) * 100, 3)}%"></div>
          <div class="ml">${fmtMonth(m.month)}</div>
        </div>`).join('')
    : '<p class="muted center">—</p>';
}

function fmtMonth(ym) {
  const [y, m] = ym.split('-');
  return ['jan', 'fév', 'mar', 'avr', 'mai', 'juin', 'juil', 'aoû', 'sep', 'oct', 'nov', 'déc'][+m - 1] + ' ' + y.slice(2);
}

// ---------------------------------------------------------------------------
// Catégories — les siennes (reprises du carnet), modifiables
// ---------------------------------------------------------------------------
async function renderCatManager() {
  state.categories = await api('/api/categories');
  const wrap = $('#catManager');
  wrap.innerHTML = '';
  state.categories.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'exp';
    row.innerHTML = `
      <input class="c-emoji" value="${escapeAttr(c.emoji)}" maxlength="4"
             style="flex:0 0 48px;text-align:center;font-size:1.3rem;padding:8px" />
      <input class="c-name" value="${escapeAttr(c.name)}" style="flex:1" />
      <button class="ghost c-save" title="Enregistrer">✓</button>
      <button class="ghost c-del" title="Retirer">✕</button>`;
    row.querySelector('.c-save').onclick = async () => {
      try {
        await api(`/api/categories/${c.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: row.querySelector('.c-name').value, emoji: row.querySelector('.c-emoji').value }),
        });
        toast('Catégorie mise à jour');
        renderCatManager();
      } catch (e) { toast(e.message); }
    };
    row.querySelector('.c-del').onclick = async () => {
      await api(`/api/categories/${c.id}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) });
      toast('Catégorie retirée');
      renderCatManager();
    };
    wrap.appendChild(row);
  });
}

$('#addCat').addEventListener('click', async () => {
  const name = $('#newCatName').value.trim();
  if (!name) return toast('Nom requis');
  try {
    await api('/api/categories', { method: 'POST', body: JSON.stringify({ name, emoji: $('#newCatEmoji').value.trim() || '📌' }) });
    $('#newCatName').value = ''; $('#newCatEmoji').value = '';
    toast('Catégorie ajoutée');
    renderCatManager();
  } catch (e) { toast(e.message); }
});

$('#importCats').addEventListener('click', async () => {
  const lines = $('#importText').value.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return toast('Colle d’abord ta liste');
  let n = 0;
  for (const line of lines) {
    const m = line.match(/^(\p{Extended_Pictographic}️?)?\s*(.+)$/u);
    const emoji = (m && m[1]) || '📌';
    const name = ((m && m[2]) || line).trim();
    if (!name) continue;
    try { await api('/api/categories', { method: 'POST', body: JSON.stringify({ name, emoji }) }); n++; } catch (e) { /* doublon ignoré */ }
  }
  $('#importText').value = '';
  toast(`${n} catégorie(s) importée(s)`);
  renderCatManager();
});

// ---------------------------------------------------------------------------
// Divers
// ---------------------------------------------------------------------------
function catName(id) {
  const c = state.categories.find((x) => x.id === id);
  return c ? `${c.emoji} ${c.name}` : 'Non classé';
}
function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

async function refresh() {
  await loadExpenses();
  const s = await api('/api/stats/summary').catch(() => ({ needs_review: 0 }));
  const badge = $('#reviewBadge');
  badge.textContent = `${s.needs_review} à vérifier`;
  badge.classList.toggle('hide', !s.needs_review);
}

async function init() {
  try {
    state.categories = await api('/api/categories');
  } catch (e) {
    toast('Serveur injoignable');
  }
  refresh();
}

init();
