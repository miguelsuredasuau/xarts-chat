'use strict';

const $ = s => document.querySelector(s);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const store = {
  get: k => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* private mode */ } },
  del: k => { try { sessionStorage.removeItem(k); } catch { /* private mode */ } },
};

const state = {
  conversationId: null,
  busy: false,
  charts: [],       // { runId, conversationId, artifact, chartId, title, svgUrl, rows, warnings, checks, prev }
  opened: new Map(), // runId -> { node, chart }  (replayed saved runs)
  selected: -1,
  spend: 0,
  tab: 'chart',
  budget: null,
};

// ---------------- markdown-lite (escaped first) ----------------
function md(src) {
  const blocks = esc(src.trim()).split(/\n{2,}/);
  return blocks.map(b => {
    const lines = b.split('\n');
    const inline = s => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
    if (lines.every(l => /^\s*[-*] /.test(l))) return `<ul>${lines.map(l => `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`).join('')}</ul>`;
    return `<p>${inline(lines.join('<br>'))}</p>`;
  }).join('');
}

// ---------------- header state ----------------
function renderRelease(r) {
  const box = $('#release');
  box.className = 'release';
  const label = box.querySelector('.release-label');
  if (!r?.ok) {
    box.classList.add('error');
    label.innerHTML = `<strong>No usable release</strong> · ${esc(r?.error?.message ?? 'unknown')}`;
    box.title = r?.error?.message ?? '';
    return;
  }
  const rel = r.release;
  if(rel.kind==='fixture'){ label.textContent='UI SANDBOX · no model or SDK';box.title='Synthetic fixtures. Not release evidence.';return; }
  box.classList.add(rel.kind);
  const count = rel.shims?.length ?? 0;
  const shims = rel.kind === 'promote' || count ? ` · ${count} workaround${count !== 1 ? 's' : ''}` : '';
  label.innerHTML = rel.kind === 'promote'
    ? `<strong>Promote release</strong> ${esc(rel.releaseId)} · <code>${esc(rel.sourceSha.slice(0, 8))}</code>${shims}`
    : `<strong>Baseline</strong> <code>${esc(rel.sourceSha.slice(0, 8))}</code> · not a Promote release${shims}`;
  box.title = [rel.label, `package ${rel.packageHash}`, rel.version, rel.note, ...(rel.shims ?? []).map(s => `Workaround ${s.id}: ${s.reason}`)].filter(Boolean).join('\n\n');
}

async function loadState() {
  let s;
  try { s = await (await fetch('/api/state')).json(); } catch {
    renderRelease({ ok: false, error: { message: 'Server unreachable' } });
    return;
  }
  {
    renderRelease(s.release);
    if (s.dataset) {
      $('#dataset-pill').textContent = `${s.dataset.about.company?.replace(' (fictional)', '') ?? 'Dataset'} · synthetic`;
      const tables = $('#tables');
      if (tables) tables.innerHTML = s.dataset.tables.map(t => `<span>${esc(t.name)} <b>${t.rows}</b></span>`).join('');
    }
    state.budget = s.agent?.budgetUsdPerTurn;
    $('#budget').textContent = state.budget != null ? `$${state.budget.toFixed(2)}` : '—';
    renderHistory(s.runs ?? []);
  }
}

// ---------------- persisted runs ----------------
const outcomeTone = o => o === 'rendered' ? 'green' : /warn|no_chart/.test(o) ? 'amber' : 'red';

function renderHistory(runs) {
  const box = $('#history'); const ul = $('#history-list');
  if (!box || !ul) return;
  ul.innerHTML = '';
  box.hidden = !runs.length;
  for (const r of runs) {
    const li = el('li'); const b = el('button'); b.type = 'button'; b.title = r.runId;
    b.append(el('span', `tag ${outcomeTone(r.outcome)}`, r.outcome.replace(/_/g, ' ')), el('span', 'msg-text', r.message), el('small', null, r.charts?.length ? r.charts.join(', ') : new Date(r.at).toLocaleTimeString()));
    b.onclick = () => openRun(r.runId);
    li.append(b); ul.append(li);
  }
}

async function openRun(runId) {
  if (state.busy) return;
  const seen = state.opened.get(runId);
  if (seen) {
    if (seen.chart >= 0) { setTab('chart'); selectChart(seen.chart); }
    seen.node.scrollIntoView({ block: 'start' });
    return;
  }
  const rec = await fetch(`/runs/${runId}/record.json`).then(r => r.ok ? r.json() : null).catch(() => null);
  if (!rec || state.busy || state.opened.has(runId)) return;
  const user = addUser(rec.request.message);
  const a = newAssistant();
  const entry = { node: user, chart: -1 };
  state.opened.set(runId, entry);
  if (rec.finalText) a.text(rec.finalText);
  let first = -1;
  for (const r of rec.renders) {
    const id = `${runId}/${r.artifact}`;
    a.step(id, 'Render', r.chartId ?? '');
    if (r.ok) {
      const i = addChart(runId, r, null, rec.conversationId);
      state.charts[i].recordReady = true;
      if (first < 0) first = entry.chart = i;
      a.finish(id, (r.checks ?? []).some(c => c.status === 'fail') ? 'err' : r.warnings?.length ? 'warn' : 'ok', `${r.chartId} · ${r.rows} rows · ${r.warnings?.length ? `${r.warnings.length} warning(s)` : 'no warnings'}`, { label: 'View', run: () => { setTab('chart'); selectChart(i); } });
    } else a.finish(id, 'err', `${r.code ?? 'RENDER_FAILED'} — ${String(r.error ?? r.message ?? '').slice(0, 280)}`);
  }
  const tags = [[rec.outcome.replace(/_/g, ' '), outcomeTone(rec.outcome)], [rec.replay ? 'exact replay · same SQL' : 'saved run', null], [rec.release.kind === 'promote' ? `Promote · ${rec.release.sourceSha?.slice(0,8)}` : `Baseline · ${rec.release.sourceSha?.slice(0,8)}`, null]];
  const defects = rec.signals.filter(s => s.kind === 'possible_library_defect').length;
  if (defects) tags.push([`${defects} possible library defect${defects > 1 ? 's' : ''} → Promote`, 'red']);
  if (rec.signals.some(s => s.kind === 'packaging_workaround')) tags.push(['packaging workaround active', 'amber']);
  a.footer(tags);
  a.done();
  if (first >= 0) { setTab('chart'); selectChart(first); }
}

// ---------------- thread ----------------
function scrollThread() { const t = $('#thread'); t.scrollTop = t.scrollHeight; }

function addUser(text) {
  $('#welcome')?.remove();
  const m = el('div', 'msg user');
  m.append(el('div', 'bubble', text));
  $('#thread').append(m);
  scrollThread();
  return m;
}

function newAssistant() {
  const m = el('div', 'msg assistant');
  $('#thread').append(m);
  let textSeg = null; let stepsSeg = null; let raw = '';
  const steps = new Map();
  return {
    node: m,
    text(delta) {
      if (!textSeg) { textSeg = el('div', 'body cursor'); raw = ''; m.append(textSeg); stepsSeg = null; }
      raw += delta;
      textSeg.innerHTML = md(raw);
      scrollThread();
    },
    step(id, name, detail) {
      if (!stepsSeg) { stepsSeg = el('ul', 'steps'); m.append(stepsSeg); textSeg?.classList.remove('cursor'); textSeg = null; }
      const li = el('li', 'step running');
      li.append(el('span', 'name', name), el('span', 'detail', detail ?? ''));
      stepsSeg.append(li);
      steps.set(id, li);
      scrollThread();
      return li;
    },
    finish(id, status, detail, action) {
      const li = steps.get(id); if (!li) return;
      li.className = `step ${status}`;
      if (detail != null) li.querySelector('.detail').textContent = detail;
      if (action) { const b = el('button', 'open', action.label); b.type = 'button'; b.onclick = action.run; li.append(b); }
    },
    footer(tags) {
      textSeg?.classList.remove('cursor');
      const f = el('div', 'footer-line');
      for (const [text, tone] of tags) f.append(el('span', `tag ${tone ?? ''}`, text));
      m.append(f);
      scrollThread();
    },
    error(message) { const b = el('div', 'body'); b.innerHTML = `<p><strong>Could not answer.</strong> ${esc(message)}</p>`; m.append(b); },
    done() { m.querySelectorAll('.cursor').forEach(n => n.classList.remove('cursor')); m.querySelectorAll('.step.running').forEach(n => { n.className = 'step err'; }); },
  };
}

const STEP = {
  data_schema: i => ['Read the dataset', 'tables, units, dictionary'],
  data_query: i => ['Queried', i.sql],
  chart_search: i => ['Searched the catalogue', [i.intent, i.clase, i.text].filter(Boolean).join(' · ') || 'all forms'],
  chart_describe: i => ['Read the contract', i.chartId],
  chart_render: i => ['Render', `${i.spec?.chartId ?? '?'} · ${i.spec?.header?.title ?? ''}`],
};

function resultDetail(name, p, isError) {
  if (isError || p?.ok === false) return ['err', `${p?.code ?? 'ERROR'} — ${String(p?.message ?? p?.text ?? '').slice(0, 280)}`];
  switch (name) {
    case 'data_schema': return ['ok', `${p.tables?.length ?? 0} tables · ${p.about?.nature?.startsWith('SYNTHETIC') ? 'synthetic data' : ''}`];
    case 'data_query': return ['ok', `${p.rowCount} row${p.rowCount === 1 ? '' : 's'}${p.truncated ? ' (truncated)' : ''}`];
    case 'chart_search': return ['ok', `${p.returned} of ${p.total} forms`];
    case 'chart_describe': return ['ok', `${p.id} · ${p.roles?.length ?? 0} roles · ${p.items?.join('–')} items`];
    case 'chart_render': {
      const bad = (p.checks ?? []).filter(c => c.status !== 'pass');
      const tone = bad.some(c => c.status === 'fail') ? 'err' : bad.length ? 'warn' : 'ok';
      return [tone, `${p.chartId} · ${p.rows} rows · ${p.renderMs} ms · ${p.warnings?.length ? `${p.warnings.length} warning(s)` : 'no warnings'}`];
    }
    default: return ['ok', ''];
  }
}

// ---------------- stage ----------------
function selectChart(i) {
  state.selected = i;
  const c = state.charts[i];
  $('#empty-chart').hidden = true;
  $('#figure').hidden = false;
  const img = $('#chart-img');
  img.src = c.svgUrl;
  img.alt = c.title ? `Chart: ${c.title}` : 'Rendered chart';
  $('#stage-eyebrow').textContent = `${c.artifact.toUpperCase()} · ${c.rows} ROWS FROM SQL`;
  $('#stage-title').textContent = c.chartId.replace(/-/g, ' ').replace(/^./, m => m.toUpperCase());
  document.querySelectorAll('.thumb').forEach((t, k) => t.setAttribute('aria-current', String(k === i)));
  renderChecks(c);
  renderFeedback(c, i);
  loadDetails(c);
}

function renderChecks(c) {
  const box = $('#checks'); box.innerHTML = '';
  for (const k of c.checks ?? []) {
    const n = el('span', `check ${k.status}`); n.title = k.detail;
    n.append(el('i'), document.createTextNode(k.id));
    box.append(n);
  }
  box.append(el('span', 'note', 'local observations · not Promote gates'));
}

async function loadDetails(c) {
  const base = `/runs/${c.runId}/${c.artifact}`;
  const [spec, data] = await Promise.all([
    fetch(`${base}.spec.json`).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(`${base}.data.json`).then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  if (state.charts[state.selected] !== c) return;
  $('#spec-panel').textContent = spec ? JSON.stringify(spec, null, 2) : 'Spec not available.';
  const dp = $('#data-panel'); dp.innerHTML = '';
  if (data) {
    const v = el('div', 'verify');
    const vb = el('button', null, 'Open in dataset console'); vb.type = 'button';
    vb.onclick = () => openConsole(data.sql, `Re-running the SQL behind ${c.artifact}. Its data hash was ${data.dataHash.slice(0, 12)}…`, data.dataHash);
    v.append(vb, el('span', null, 'Re-run this exact query and check the rows yourself.'));
    dp.append(v);
    dp.append(el('p', 'section-title', 'SQL EXECUTED BY THE SERVER'), el('pre', 'sql', data.sql));
    dp.append(el('p', 'section-title', `${data.rowCount} ROWS · SHA-256 ${data.dataHash.slice(0, 16)}…`));
    const cols = Object.keys(data.rows[0] ?? {});
    const t = el('table', 'rows');
    t.innerHTML = `<thead><tr>${cols.map(k => `<th>${esc(k)}</th>`).join('')}</tr></thead><tbody>${data.rows.map(r => `<tr>${cols.map(k => {
      const v = r[k]; const num = typeof v === 'number';
      return `<td class="${num ? 'num' : ''}">${esc(num ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : v ?? '—')}</td>`;
    }).join('')}</tr>`).join('')}</tbody>`;
    dp.append(t);
  }
  renderRecord(c);
}

async function renderRecord(c) {
  const rp = $('#record-panel');
  if (!c.recordReady) { rp.innerHTML = '<p class="section-title">RUN RECORD</p><p>Written when this turn finishes.</p>'; return; }
  const rec = await fetch(`/runs/${c.runId}/record.json`).then(r => r.ok ? r.json() : null).catch(() => null);
  if (state.charts[state.selected] !== c) return;
  if (!rec) { rp.innerHTML = '<p class="section-title">RUN RECORD</p><p>Written when the turn finishes.</p>'; return; }
  const rel = rec.release ?? {};
  const u = rec.agent?.usage;
  rp.innerHTML = `
    <p class="section-title">RUN ${esc(rec.runId)}</p>
    <dl class="kv">
      <dt>Outcome</dt><dd><span class="tag ${/^rendered$/.test(rec.outcome) ? 'green' : /warn/.test(rec.outcome) ? 'amber' : 'red'}">${esc(rec.outcome)}</span></dd>
      <dt>Request</dt><dd>${esc(rec.request.message)}</dd>
      <dt>Release</dt><dd>${esc(rel.label ?? rel.kind)}<br><code>${esc(rel.sourceSha ?? '')}</code></dd>
      <dt>Package</dt><dd><code>${esc(rel.packageHash ?? '')}</code><br>${esc(rel.version ?? '')}</dd>
      <dt>Dataset</dt><dd>${esc(rec.dataset.nature)} · <code>${esc(rec.dataset.sha256?.slice(0, 16) ?? '')}…</code></dd>
      <dt>Agent</dt><dd>${esc(rec.agent.runner)} · ${esc(rec.agent.model ?? '')}</dd>
      <dt>Usage</dt><dd>${u ? `${u.costUsd == null ? 'Cost unknown' : '$' + Number(u.costUsd).toFixed(3)} · ${u.turns} turns · ${(u.durationMs / 1000).toFixed(1)} s <br><small>${esc(u.source)}</small>` : 'not reported'}</dd>
      <dt>Renders</dt><dd>${rec.renders.map(r => `${esc(r.artifact)} ${r.ok ? '✓' : '✗'} ${esc(r.chartId ?? '')}${r.code ? ` <code>${esc(r.code)}</code>` : ''}`).join('<br>')}</dd>
    </dl>
    <p class="section-title">SIGNALS FOR PROMOTE</p>
    ${rec.signals.filter(s => s.kind !== 'packaging_workaround').length ? rec.signals.filter(s => s.kind !== 'packaging_workaround').map(s => `<div class="signal ${esc(s.kind)}"><b>${esc(s.kind.replace(/_/g, ' ').toUpperCase())} · ${esc(s.code)}</b>${esc(s.message ?? '')}${s.recovered ? ' <em>(recovered in this run)</em>' : ''}</div>`).join('') : '<p>None.</p>'}
    ${(rel.shims ?? []).map(s => `<div class="signal packaging_workaround"><b>WORKAROUND · ${esc(s.id)}</b>${esc(s.reason)}</div>`).join('')}
    <p class="section-title">PROMOTE HANDOFF</p><p id="promote-receipt">Checking delivery…</p>
    <p class="section-title">HUMAN FEEDBACK</p>
    <div id="record-feedback"><p>Loading…</p></div>
    <p class="section-title">RAW</p><pre class="code">${esc(JSON.stringify(rec, null, 2))}</pre>`;
  const receipt = await fetch(`/api/promote-receipts/${c.runId}.json`).then(r=>r.json()).catch(()=>({status:'unavailable'}));
  const delivery = document.getElementById('promote-receipt');
  if (delivery) delivery.textContent = receipt.status === 'received' ? 'Received by Promote · awaiting triage' : `Promote: ${receipt.status.replace(/_/g,' ')}`;
  const fb = await fetch(`/api/feedback/${c.runId}`).then(r => r.json()).catch(() => ({ feedback: [] }));
  const box = document.getElementById('record-feedback');
  if (box) box.innerHTML = fb.feedback.length
    ? fb.feedback.map(f => `<div class="signal ${f.value === 'down' || f.value === 'previous' ? 'possible_library_defect' : 'input_error'}"><b>${esc(f.kind.toUpperCase())} · ${esc(f.value)}</b>${esc((f.reasons ?? []).join(', '))}${f.note ? ` — “${esc(f.note)}”` : ''}</div>`).join('')
    : '<p>None yet. Rate the chart below the canvas.</p>';
}

function addChart(runId, p, input, conversationId = state.conversationId) {
  const prev = state.charts.findLastIndex(x => x.conversationId === conversationId);
  const c = { runId, conversationId, artifact: p.artifact, chartId: p.chartId, title: input?.spec?.header?.title ?? '', svgUrl: `/runs/${runId}/${p.artifact}.svg`, rows: p.rows, warnings: p.warnings, checks: p.checks, prev: prev >= 0 ? state.charts[prev] : null };
  state.charts.push(c);
  const i = state.charts.length - 1;
  const b = el('button', 'thumb'); b.type = 'button'; b.title = c.title;
  const img = el('img'); img.src = c.svgUrl; img.alt = ''; b.append(img);
  b.onclick = () => { setTab('chart'); selectChart(i); };
  $('#strip').append(b);
  setTab('chart');
  selectChart(i);
  return i;
}

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tabs [role=tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.dataset.panel === tab));
}

// ---------------- chat turn ----------------
async function send(message) {
  if (state.busy || !message.trim()) return;
  state.busy = true;
  $('#composer').classList.add('busy');
  $('#send').setAttribute('aria-label', 'Stop');
  addUser(message);
  const a = newAssistant();
  const inputs = new Map();
  let runId = null;
  $('#canvas').classList.add('loading');
  try {
    const res = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, conversationId: state.conversationId }) });
    if (!res.ok || !res.body) { a.error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`); return; }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let k;
      while ((k = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, k); buf = buf.slice(k + 2);
        const line = chunk.split('\n').find(l => l.startsWith('data: '));
        if (!line) continue;
        const ev = JSON.parse(line.slice(6));
        switch (ev.t) {
          case 'run': runId = ev.runId; state.conversationId = ev.conversationId; store.set('xc-conv', ev.conversationId); break;
          case 'release': renderRelease({ ok: true, release: ev.release }); break;
          case 'text': a.text(ev.text); break;
          case 'tool-start': { inputs.set(ev.id, ev.input); const [n, d] = (STEP[ev.name] ?? (() => [ev.name, '']))(ev.input ?? {}); a.step(ev.id, n, d); break; }
          case 'tool-result': {
            const [tone, detail] = resultDetail(ev.name, ev.payload, ev.isError);
            let action = null;
            if (ev.name === 'chart_render' && ev.payload?.ok) {
              const i = addChart(runId, ev.payload, inputs.get(ev.id));
              action = { label: 'View', run: () => { setTab('chart'); selectChart(i); } };
            }
            a.finish(ev.id, tone, detail, action);
            break;
          }
          case 'record': {
            const u = ev.usage?.costUsd;
            if (typeof u === 'number') { state.spend += u; $('#spend-pill').innerHTML = `$${state.spend.toFixed(2)} <small>reported</small>`; }
            const tone = ev.outcome === 'rendered' ? 'green' : /warn|no_chart/.test(ev.outcome) ? 'amber' : 'red';
            const tags = [[ev.outcome.replace(/_/g, ' '), tone]];
            if (typeof u === 'number') tags.push([`$${u.toFixed(3)} · ${(ev.usage.durationMs / 1000).toFixed(0)} s`]);
            const defects = ev.signals.filter(s => s.kind === 'possible_library_defect').length;
            if (defects) tags.push([`${defects} possible library defect${defects > 1 ? 's' : ''} → Promote`, 'red']);
            if (ev.signals.some(s => s.kind === 'packaging_workaround')) tags.push(['packaging workaround active', 'amber']);
            a.footer(tags);
            state.charts.forEach(ch => { if (ch.runId === ev.runId) ch.recordReady = true; });
            const c = state.charts[state.selected];
            if (c && c.runId === ev.runId) { renderRecord(c); renderFeedback(c, state.selected); }
            break;
          }
          case 'error': a.error(`${ev.code}: ${ev.message}`); break;
          default: break;
        }
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') a.error(e.message);
  } finally {
    a.done();
    state.busy = false;
    $('#composer').classList.remove('busy');
    $('#send').setAttribute('aria-label', 'Send');
    $('#canvas').classList.remove('loading');
    loadState();
  }
}

// ---------------- feedback ----------------
const fbState = new Map(); // `${runId}/${artifact}` -> { rating, reasons:Set, pref }
function fbKey(c) { return `${c.runId}/${c.artifact}`; }

function renderFeedback(c, i) {
  const box = $('#feedback'); box.hidden = !c.recordReady;
  const st = fbState.get(fbKey(c)) ?? { rating: null, reasons: new Set(), pref: null };
  fbState.set(fbKey(c), st);
  box.querySelectorAll('[data-rate]').forEach(b => b.setAttribute('aria-pressed', String(st.rating === b.dataset.rate)));
  box.querySelectorAll('[data-reason]').forEach(b => b.setAttribute('aria-pressed', String(st.reasons.has(b.dataset.reason))));
  $('#fb-detail').hidden = st.rating !== 'down' || st.sent;
  $('#fb-note').value = st.note ?? '';
  $('#fb-state').textContent = st.sent ? 'Saved for Promote · thank you' : '';
  const prev = c.prev;
  const cmp = $('#fb-compare');
  cmp.hidden = !prev || !c.recordReady || !prev.recordReady;
  cmp.querySelectorAll('[data-pref]').forEach(b => b.setAttribute('aria-pressed', String(st.pref === b.dataset.pref)));
}

async function sendFeedback(c, payload) {
  const res = await fetch('/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: c.conversationId, ...payload }) });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

function currentChart() { return state.charts[state.selected]; }

$('#feedback').addEventListener('click', async e => {
  const c = currentChart(); if (!c) return;
  const st = fbState.get(fbKey(c));
  const rate = e.target.closest('[data-rate]')?.dataset.rate;
  const reason = e.target.closest('[data-reason]')?.dataset.reason;
  const pref = e.target.closest('[data-pref]')?.dataset.pref;
  try {
    if (rate === 'up') {
      st.rating = 'up'; st.sent = true;
      await sendFeedback(c, { kind: 'rating', runId: c.runId, artifact: c.artifact, value: 'up' });
    } else if (rate === 'down') {
      st.rating = 'down'; st.sent = false;
    } else if (reason) {
      st.reasons.has(reason) ? st.reasons.delete(reason) : st.reasons.add(reason);
    } else if (pref) {
      const prev = c.prev; if (!prev) return;
      st.pref = pref;
      await sendFeedback(c, { kind: 'preference', runId: c.runId, artifact: c.artifact, value: pref, vs: { runId: prev.runId, artifact: prev.artifact } });
      $('#fb-state').textContent = 'Preference saved for Promote';
      renderFeedback(c, state.selected);
      return;
    } else return;
    renderFeedback(c, state.selected);
  } catch (err) { $('#fb-state').textContent = `Not saved: ${err.message}`; }
});

$('#fb-detail').addEventListener('submit', async e => {
  e.preventDefault();
  const c = currentChart(); if (!c) return;
  const st = fbState.get(fbKey(c));
  st.note = $('#fb-note').value;
  try {
    await sendFeedback(c, { kind: 'rating', runId: c.runId, artifact: c.artifact, value: 'down', reasons: [...st.reasons], note: st.note });
    st.sent = true;
    renderFeedback(c, state.selected);
  } catch (err) { $('#fb-state').textContent = `Not saved: ${err.message}`; }
});

// ---------------- dataset view ----------------
const ds = { schema: null, table: null, offset: 0, limit: 100, lastHash: null };

function setView(view) {
  document.querySelectorAll('.views [data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  $('#chat-view').hidden = view !== 'chat';
  $('#dataset-view').hidden = view !== 'dataset';
  if (view === 'dataset' && !ds.schema) loadDataset();
}

function unitOf(table, col) {
  const t = ds.schema?.tables.find(x => x.name === table);
  return t?.columns.find(c => c.name === col)?.unit ?? null;
}

function renderGrid(rows, { table = null, columns = null } = {}) {
  const grid = $('#ds-grid');
  if (!rows.length) { grid.innerHTML = '<p class="empty">No rows.</p>'; return; }
  const cols = columns ?? Object.keys(rows[0]).map(name => ({ name }));
  grid.innerHTML = `<table class="rows"><thead><tr>${cols.map(c => {
    const unit = c.unit ?? (table ? unitOf(table, c.name) : null);
    return `<th title="${esc(c.description ?? '')}">${esc(c.name)}${unit ? `<small>${esc(unit)}</small>` : ''}</th>`;
  }).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${cols.map(c => {
    const v = r[c.name]; const num = typeof v === 'number';
    return `<td class="${num ? 'num' : ''}">${esc(v == null ? '—' : num ? v.toLocaleString('en-GB', { maximumFractionDigits: 6 }) : v)}</td>`;
  }).join('')}</tr>`).join('')}</tbody></table>`;
}

async function loadDataset() {
  ds.schema = await fetch('/api/dataset').then(r => r.json());
  $('#ds-about').textContent = `${ds.schema.about?.nature ?? ''} ${ds.schema.about?.period ? `Period ${ds.schema.about.period}.` : ''}`;
  const ul = $('#ds-tables'); ul.innerHTML = '';
  for (const t of ds.schema.tables) {
    const li = el('li'); const b = el('button'); b.type = 'button'; b.dataset.table = t.name;
    b.innerHTML = `<b>${esc(t.name)}</b><span>${t.rows.toLocaleString('en-GB')} rows · ${t.columns.length} columns</span>`;
    b.onclick = () => browseTable(t.name, 0);
    li.append(b); ul.append(li);
  }
  if (!ds.pendingSql) browseTable(ds.schema.tables[0].name, 0);
}

async function browseTable(name, offset) {
  ds.table = name; ds.offset = offset;
  const status = $('#ds-status'); status.className = 'ds-status'; status.textContent = '';
  document.querySelectorAll('#ds-tables button').forEach(b => b.setAttribute('aria-current', String(b.dataset.table === name)));
  const page = await fetch(`/api/dataset/${encodeURIComponent(name)}?offset=${offset}&limit=${ds.limit}`).then(r => r.json());
  $('#ds-grid-title').textContent = `TABLE ${name.toUpperCase()}`;
  renderGrid(page.rows, { table: name, columns: page.columns });
  const pager = $('#ds-pager'); pager.innerHTML = '';
  const prev = el('button', null, '← Prev'); prev.type = 'button'; prev.disabled = offset === 0; prev.onclick = () => browseTable(name, Math.max(0, offset - ds.limit));
  const next = el('button', null, 'Next →'); next.type = 'button'; next.disabled = offset + ds.limit >= page.total; next.onclick = () => browseTable(name, offset + ds.limit);
  pager.append(prev, el('span', null, `${page.total ? offset + 1 : 0}–${Math.min(offset + ds.limit, page.total)} of ${page.total}`), next);
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function runConsole() {
  const sql = $('#ds-sql').value;
  const status = $('#ds-status'); status.className = 'ds-status'; status.textContent = 'Running…';
  const r = await fetch('/api/sql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql }) }).then(x => x.json());
  $('#ds-pager').innerHTML = '';
  document.querySelectorAll('#ds-tables button').forEach(b => b.setAttribute('aria-current', 'false'));
  if (!r.ok) { status.className = 'ds-status err'; status.textContent = `${r.code}: ${r.message}`; $('#ds-grid').innerHTML = ''; return; }
  $('#ds-grid-title').textContent = `RESULT · ${r.rowCount} ROW${r.rowCount === 1 ? '' : 'S'}${r.truncated ? ' (TRUNCATED)' : ''}`;
  renderGrid(r.rows);
  let msg = `${r.rowCount} rows in ${r.ms} ms.`;
  if (ds.lastHash) {
    // Same serialisation as the server's dataHash: JSON of the row objects, in order.
    const h = await sha256Hex(JSON.stringify(r.rows));
    msg += h === ds.lastHash ? ' ✓ Identical to the rows the chart was drawn from (data hash matches).' : ' ✗ Rows differ from what the chart was drawn from (data hash does not match).';
    ds.lastHash = null;
  }
  status.textContent = msg;
}

function openConsole(sql, note, dataHash) {
  ds.pendingSql = true;
  setView('dataset');
  $('#ds-sql').value = sql;
  ds.lastHash = dataHash ?? null;
  $('#ds-status').textContent = note ?? '';
  runConsole();
}

$('#ds-run').addEventListener('click', runConsole);
$('#ds-sql').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runConsole(); } });
$('#ds-snippets').addEventListener('click', e => { const b = e.target.closest('[data-sql]'); if (b) { $('#ds-sql').value = b.dataset.sql; runConsole(); } });
document.querySelectorAll('.views [data-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));

// ---------------- wiring ----------------
const input = $('#composer-input');
const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; };
input.addEventListener('input', grow);
input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); } });
$('#composer').addEventListener('submit', e => {
  e.preventDefault();
  if (state.busy) { fetch('/api/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: state.conversationId }) }); return; }
  const v = input.value; input.value = ''; grow(); send(v);
});
$('#suggestions').addEventListener('click', e => { if (e.target.matches('button')) send(e.target.textContent); });
document.querySelectorAll('.tabs [role=tab]').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
$('#new-chat').addEventListener('click', () => { store.del('xc-conv'); location.reload(); });

loadState().then(() => {
  const savedRun = new URLSearchParams(location.search).get('run');
  if (savedRun && /^[0-9TZ]+-[a-f0-9]{8}$/.test(savedRun)) return openRun(savedRun);
});
input.focus();
