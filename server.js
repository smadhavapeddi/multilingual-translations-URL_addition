#!/usr/bin/env node
/**
 * Multilingual Support / Content Translation Demo — DigitalOcean App Platform
 *
 * Pitch: paste an inbound support email or a product description written in
 * English (or any language), pick target languages, and get instant
 * side-by-side translations powered by DigitalOcean Serverless Inference.
 * An obvious win for any SMB or SaaS expanding internationally.
 *
 * No external dependencies — Node.js 18+ standard library + built-in fetch
 * only. Listens on process.env.PORT (App Platform sets this).
 *
 * Env vars:
 *   MODEL_ACCESS_KEY   DigitalOcean Serverless Inference model access key.
 *                      Required unless DRY_RUN=true.
 *   MODEL_ID           Model used for translation (default: openai-gpt-oss-120b).
 *                      Swap in a stronger model (e.g. anthropic-claude-5-sonnet)
 *                      for higher translation quality at a higher per-token cost.
 *   DRY_RUN            Set to "true" to use canned mock translations instead
 *                      of calling the live API — good for a first deploy
 *                      before you've added a real key or balance.
 *   PORT               HTTP port to listen on (App Platform sets this).
 */

'use strict';

const http = require('http');
const dns = require('dns');
const net = require('net');

const BASE_URL = 'https://inference.do-ai.run';
const CHAT_COMPLETIONS_PATH = '/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 25000;

const MAX_TEXT_LEN = 3000;
const MAX_TARGET_LANGS = 6;
const MAX_BODY_BYTES = 32 * 1024;

// Web-page translation mode
const MAX_URL_TEXT_LEN = 6000; // extracted text is capped before translation
const MAX_URL_FETCH_BYTES = 2 * 1024 * 1024; // raw HTML download cap (2MB)
const URL_FETCH_TIMEOUT_MS = 10000;

// A user-facing error (400) vs. an unexpected failure (500).
class DemoError extends Error {}

// ---------------------------------------------------------------------------
// Supported target languages. Codes are only used client-side / as mock keys;
// the actual translation request just sends the human-readable label to the
// model ("Translate into Japanese"), so adding a language here is enough.
// ---------------------------------------------------------------------------
const LANGUAGES = [
  { code: 'es', label: 'Spanish' },
  { code: 'ja', label: 'Japanese' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'zh', label: 'Chinese (Simplified)' },
  { code: 'ko', label: 'Korean' },
  { code: 'ar', label: 'Arabic' },
  { code: 'hi', label: 'Hindi' },
  { code: 'it', label: 'Italian' },
];
const LANGUAGE_BY_CODE = Object.fromEntries(LANGUAGES.map((l) => [l.code, l]));
const DEFAULT_TARGET_CODES = ['es', 'ja'];

const PRESET_EXAMPLES = {
  support_email: {
    label: 'Inbound support email',
    text:
      'Subject: Unable to access my account after password reset\n\n' +
      "Hi team,\n\nI reset my password yesterday but I still can't log in — it keeps " +
      'saying "invalid credentials" even though I just reset it twice. I have an ' +
      'important client demo in two hours and need access to my dashboard. Can ' +
      'someone please help urgently?\n\nThanks,\nJordan',
  },
  product_description: {
    label: 'Product description',
    text:
      'CloudSync Pro automatically backs up your files across every device in ' +
      'real time, with bank-level encryption and one-click restore. Built for ' +
      "small teams who can't afford downtime, it syncs in seconds and works " +
      'seamlessly with the tools you already use — no IT department required.',
  },
};

// ---------------------------------------------------------------------------
// Translation call
// ---------------------------------------------------------------------------
async function translateOne({ modelAccessKey, baseUrl, modelId, text, targetLabel }) {
  const url = baseUrl.replace(/\/$/, '') + CHAT_COMPLETIONS_PATH;
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${modelAccessKey}` },
      body: JSON.stringify({
        model: modelId,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content:
              `You are a professional translator. Translate the user's message into ${targetLabel}. ` +
              'Preserve the original tone, meaning, formatting, and line breaks. Respond with only ' +
              'the translated text — no notes, no quotation marks, no explanations. If the text is ' +
              `already in ${targetLabel}, return it unchanged.`,
          },
          { role: 'user', content: text },
        ],
      }),
    });
  } catch (err) {
    clearTimeout(timeout);
    const reason = err.name === 'AbortError' ? 'Request timed out.' : `Request failed: ${err.message}`;
    return { translation: null, input_tokens: 0, output_tokens: 0, latency_s: (Date.now() - start) / 1000, error: reason };
  }
  clearTimeout(timeout);

  const latency_s = (Date.now() - start) / 1000;
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    return { translation: null, input_tokens: 0, output_tokens: 0, latency_s, error: `HTTP ${res.status}: ${errBody.slice(0, 300)}` };
  }

  const data = await res.json();
  const usage = data.usage || {};
  const translation = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return {
    translation: translation != null ? String(translation).trim() : null,
    input_tokens: usage.prompt_tokens || 0,
    output_tokens: usage.completion_tokens || 0,
    latency_s,
    error: translation ? null : 'Model returned an empty response.',
  };
}

function mockTranslation(text, code, label) {
  // Deterministic, clearly-labeled placeholder so the UI and plumbing can be
  // demoed end-to-end with no API key and no cost.
  const snippet = text.length > 60 ? text.slice(0, 60) + '…' : text;
  return `[DRY RUN — mock ${label} translation, not a real translation]\n${snippet}`;
}

async function translateAll({ text, targetCodes, modelAccessKey, modelId, baseUrl, dryRun }) {
  const jobs = targetCodes.map(async (code) => {
    const lang = LANGUAGE_BY_CODE[code];
    if (dryRun) {
      await new Promise((r) => setTimeout(r, 250 + Math.random() * 400)); // feel "live"
      return {
        code,
        label: lang.label,
        translation: mockTranslation(text, code, lang.label),
        input_tokens: Math.round(text.length / 4),
        output_tokens: Math.round(text.length / 4),
        latency_s: 0.3 + Math.random() * 0.3,
        error: null,
      };
    }
    const r = await translateOne({ modelAccessKey, baseUrl, modelId, text, targetLabel: lang.label });
    return { code, label: lang.label, ...r };
  });
  return Promise.all(jobs);
}

// ---------------------------------------------------------------------------
// Web-page fetch + text extraction (for "translate a whole page" mode)
// ---------------------------------------------------------------------------

// Basic SSRF guard: block requests that resolve to loopback, link-local
// (including the 169.254.169.254 cloud metadata address), private, or
// otherwise non-public IP ranges. Not exhaustive, but covers the common
// cases for a demo app that fetches user-supplied URLs server-side.
function isDisallowedIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 127) return true; // loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a === 0) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true; // loopback
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 unique local
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isDisallowedIp(mapped[1]);
    return false;
  }
  return true; // couldn't classify it — block rather than guess
}

function decodeEntities(s) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘',
    rdquo: '”', ldquo: '“', hellip: '…', copy: '©',
    reg: '®', trade: '™',
  };
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name in named ? named[name] : m));
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).trim() : null;
}

function htmlToText(html) {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer)>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t]+/g, ' ');
  s = s.split('\n').map((line) => line.trim()).join('\n');
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

async function fetchUrlText(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    throw new DemoError('That does not look like a valid URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new DemoError('Only http:// and https:// URLs are supported.');
  }
  if (parsed.hostname === 'localhost' || parsed.hostname.endsWith('.local')) {
    throw new DemoError('That host is not allowed.');
  }

  let addresses;
  try {
    addresses = await dns.promises.lookup(parsed.hostname, { all: true });
  } catch (err) {
    throw new DemoError(`Could not resolve that host: ${err.message}`);
  }
  if (addresses.length === 0 || addresses.some((a) => isDisallowedIp(a.address))) {
    throw new DemoError('That URL resolves to a private or internal address and cannot be fetched.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(parsed.toString(), {
      signal: controller.signal,
      redirect: 'manual', // don't silently follow redirects to a private address
      headers: { 'User-Agent': 'DigitalOcean-Translation-Demo/1.0' },
    });
  } catch (err) {
    clearTimeout(timeout);
    throw new DemoError(err.name === 'AbortError' ? 'Fetching the page timed out.' : `Could not fetch the page: ${err.message}`);
  }
  clearTimeout(timeout);

  if (res.status >= 300 && res.status < 400) {
    throw new DemoError('That URL redirects to another page. Please provide the direct, final URL.');
  }
  if (!res.ok) {
    throw new DemoError(`The page responded with HTTP ${res.status}.`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (!/text\/html|text\/plain|application\/xhtml\+xml/i.test(contentType)) {
    throw new DemoError(`Unsupported content type (${contentType || 'unknown'}). Only HTML or plain-text pages are supported.`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let html = '';
  let total = 0;
  let truncatedFetch = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_URL_FETCH_BYTES) {
      truncatedFetch = true;
      reader.cancel().catch(() => {});
      break;
    }
    html += decoder.decode(value, { stream: true });
  }
  html += decoder.decode();

  const title = extractTitle(html);
  const text = htmlToText(html);
  return { title, text, truncatedFetch, finalUrl: parsed.toString() };
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeJs(s) {
  return JSON.stringify(String(s == null ? '' : s));
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
const PAGE_STYLE = `
  :root {
    --do-blue: #0069ff; --do-blue-dark: #0050c4; --ink: #111827; --muted: #6b7280;
    --border: #e5e7eb; --bg: #f7f8fa; --card: #ffffff;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: var(--bg); color: var(--ink); }
  header { background: #03244d; color: #fff; padding: 24px 28px; }
  header h1 { margin: 0 0 4px 0; font-size: 19px; }
  header p { margin: 0; font-size: 13px; color: #9fb4d6; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 24px; }
  .panel { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; margin-bottom: 20px; }
  textarea { width: 100%; min-height: 150px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 8px; font-family: inherit; font-size: 14px; resize: vertical; }
  .presets { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0 18px 0; }
  .chip-btn { background: #eef4ff; color: #0050c4; border: 1px solid #cfe0ff; border-radius: 999px; padding: 6px 14px; font-size: 12.5px; font-weight: 600; cursor: pointer; }
  .chip-btn:hover { background: #dde9ff; }
  .chip-btn.ghost { background: #fff; color: var(--muted); border-color: var(--border); }
  .langs { display: flex; flex-wrap: wrap; gap: 10px; margin: 6px 0 20px 0; }
  .lang-check { display: inline-flex; align-items: center; gap: 6px; background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 7px 12px; font-size: 13.5px; cursor: pointer; }
  .lang-check input { margin: 0; }
  .char-count { font-size: 12px; color: var(--muted); text-align: right; margin-top: 4px; }
  .or-divider { display: flex; align-items: center; gap: 12px; margin: 22px 0; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }
  .or-divider::before, .or-divider::after { content: ""; flex: 1; border-top: 1px solid var(--border); }
  .url-field-label { font-size: 13.5px; font-weight: 600; display: block; margin-bottom: 6px; }
  .url-row { display: flex; gap: 8px; }
  .url-row input[type="url"] { flex: 1; padding: 11px 14px; border: 1px solid var(--border); border-radius: 8px; font-size: 14px; font-family: inherit; }
  .btn { display: inline-block; background: var(--do-blue); color: #fff; border: none; text-decoration: none; padding: 12px 22px; border-radius: 8px; font-weight: 600; font-size: 14px; cursor: pointer; font-family: inherit; }
  .btn:hover { background: var(--do-blue-dark); }
  .btn:disabled { background: #9fb4d6; cursor: default; }
  .btn.secondary { background: #03244d; }
  .btn.secondary:hover { background: #051d3d; }
  .source-label { font-size: 12.5px; color: var(--muted); margin-bottom: 8px; word-break: break-all; }
  .source-label strong { color: var(--ink); }
  .source-text { max-height: 220px; overflow-y: auto; white-space: pre-wrap; font-size: 13px; line-height: 1.5; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
  .note { font-size: 13px; color: var(--muted); margin-top: 14px; line-height: 1.6; }
  .mode-flag { display: inline-block; font-size: 11px; font-weight: 700; text-transform: uppercase; padding: 3px 9px; border-radius: 999px; background: #fff1e6; color: #b45309; margin-left: 8px; }
  .results-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
  .result-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }
  .result-card .lang-name { font-weight: 700; font-size: 14px; margin-bottom: 8px; color: #03244d; }
  .result-card .translation { font-size: 14px; white-space: pre-wrap; line-height: 1.5; }
  .result-card .meta { font-size: 11.5px; color: var(--muted); margin-top: 10px; }
  .result-card .err { color: #b91c1c; font-size: 13px; }
  .status-line { font-size: 13.5px; color: var(--muted); margin: 4px 0 14px 0; min-height: 18px; }
  footer { text-align: center; font-size: 11px; color: var(--muted); padding: 24px; }
`;

const CLIENT_SCRIPT = `
const PRESETS = ${JSON.stringify(PRESET_EXAMPLES)};

function loadPreset(key) {
  document.getElementById('text').value = PRESETS[key].text;
  updateCharCount();
}
function clearText() {
  document.getElementById('text').value = '';
  updateCharCount();
}
function loadExampleUrl() {
  document.getElementById('pageUrl').value = 'https://en.wikipedia.org/wiki/DigitalOcean';
}
function updateCharCount() {
  const el = document.getElementById('text');
  document.getElementById('charCount').textContent = el.value.length + ' / ' + ${MAX_TEXT_LEN} + ' characters';
}

function selectedLangs() {
  return Array.from(document.querySelectorAll('.lang-check input:checked')).map((c) => c.value);
}

function renderResults(data) {
  const grid = document.getElementById('resultsGrid');
  grid.innerHTML = '';
  for (const r of data.results) {
    const card = document.createElement('div');
    card.className = 'result-card';
    if (r.error) {
      card.innerHTML = '<div class="lang-name">' + r.label + '</div><div class="err">Error: ' + r.error.replace(/</g, '&lt;') + '</div>';
    } else {
      const meta = r.input_tokens + ' in / ' + r.output_tokens + ' out &middot; ' + r.latency_s.toFixed(2) + 's';
      const safeTranslation = (r.translation || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      card.innerHTML = '<div class="lang-name">' + r.label + '</div><div class="translation">' + safeTranslation + '</div><div class="meta">' + meta + '</div>';
    }
    grid.appendChild(card);
  }
}

async function runTranslate() {
  const text = document.getElementById('text').value.trim();
  const langs = selectedLangs();
  const statusEl = document.getElementById('statusLine');
  const btn = document.getElementById('translateBtn');
  const grid = document.getElementById('resultsGrid');

  if (!text) { statusEl.textContent = 'Enter some text first.'; return; }
  if (langs.length === 0) { statusEl.textContent = 'Pick at least one target language.'; return; }

  btn.disabled = true;
  grid.innerHTML = '';
  statusEl.textContent = 'Translating into ' + langs.length + ' language' + (langs.length > 1 ? 's' : '') + '...';

  try {
    const res = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, targetLangs: langs }),
    });
    const data = await res.json();
    if (!res.ok) {
      statusEl.textContent = data.error || ('Request failed with status ' + res.status);
    } else {
      statusEl.textContent = data.dryRun ? 'Done (dry-run / mock translations).' : 'Done.';
      renderResults(data);
    }
  } catch (err) {
    statusEl.textContent = 'Request failed: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

async function runTranslateUrl() {
  const url = document.getElementById('pageUrl').value.trim();
  const langs = selectedLangs();
  const statusEl = document.getElementById('statusLine');
  const btn = document.getElementById('translateUrlBtn');
  const grid = document.getElementById('resultsGrid');
  const sourcePanel = document.getElementById('sourcePanel');

  if (!url) { statusEl.textContent = 'Enter a URL first.'; return; }
  if (langs.length === 0) { statusEl.textContent = 'Pick at least one target language.'; return; }

  btn.disabled = true;
  grid.innerHTML = '';
  sourcePanel.style.display = 'none';
  statusEl.textContent = 'Fetching the page and translating into ' + langs.length + ' language' + (langs.length > 1 ? 's' : '') + '...';

  try {
    const res = await fetch('/api/translate-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, targetLangs: langs }),
    });
    const data = await res.json();
    if (!res.ok) {
      statusEl.textContent = data.error || ('Request failed with status ' + res.status);
    } else {
      let msg = data.dryRun ? 'Done — real page content, mock translations (dry-run mode).' : 'Done.';
      if (data.truncated) msg += ' Page content was truncated for this demo.';
      statusEl.textContent = msg;
      document.getElementById('sourceUrlLabel').innerHTML = '<strong>' + (data.title ? data.title.replace(/</g, '&lt;') + ' — ' : '') + '</strong>' + data.sourceUrl.replace(/</g, '&lt;');
      document.getElementById('sourceTextPreview').textContent = data.extractedText;
      sourcePanel.style.display = 'block';
      renderResults(data);
    }
  } catch (err) {
    statusEl.textContent = 'Request failed: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('text').addEventListener('input', updateCharCount);
  document.getElementById('translateBtn').addEventListener('click', runTranslate);
  document.getElementById('translateUrlBtn').addEventListener('click', runTranslateUrl);
  updateCharCount();
});
`;

function landingPage({ dryRun, hasKey, modelId }) {
  const langChecks = LANGUAGES.map((l) => {
    const checked = DEFAULT_TARGET_CODES.includes(l.code) ? 'checked' : '';
    return `<label class="lang-check"><input type="checkbox" value="${l.code}" ${checked}> ${escapeHtml(l.label)}</label>`;
  }).join('\n');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Multilingual Support / Content Translation Demo</title><style>${PAGE_STYLE}</style></head><body>
<header>
  <h1>Multilingual Support &amp; Content Demo${dryRun ? '<span class="mode-flag">dry run</span>' : ''}</h1>
  <p>DigitalOcean Serverless Inference — real-time translation of support emails and product copy</p>
</header>
<div class="wrap">
  <div class="panel">
    <p style="margin-top:0;">Paste an inbound support email, a product description, or anything else — pick the
    languages you want it in, and get instant side-by-side translations.</p>

    <div class="presets">
      <button type="button" class="chip-btn" onclick="loadPreset('support_email')">Load example: support email</button>
      <button type="button" class="chip-btn" onclick="loadPreset('product_description')">Load example: product description</button>
      <button type="button" class="chip-btn ghost" onclick="clearText()">Clear</button>
    </div>

    <textarea id="text" maxlength="${MAX_TEXT_LEN}" placeholder="Type or paste text in any language..."></textarea>
    <div class="char-count" id="charCount"></div>

    <div class="or-divider">or</div>

    <label class="url-field-label" for="pageUrl">Translate an entire web page</label>
    <div class="url-row">
      <input type="url" id="pageUrl" placeholder="https://example.com/support-article-or-product-page">
      <button type="button" class="chip-btn" onclick="loadExampleUrl()">Load example URL</button>
    </div>
    <div class="field-note">Fetches the page's visible text (title + body) and translates it. Works best on
    simple, server-rendered pages — content that only appears after JavaScript runs in a browser won't be
    picked up.</div>

    <div class="langs">${langChecks}</div>

    <div style="display:flex; gap:10px; flex-wrap:wrap;">
      <button class="btn" id="translateBtn" type="button">Translate text &rarr;</button>
      <button class="btn secondary" id="translateUrlBtn" type="button">Fetch &amp; translate page &rarr;</button>
    </div>
    <div class="status-line" id="statusLine"></div>

    <div class="note">
      ${dryRun
        ? `Running in <strong>dry-run mode</strong>: page fetches are real, but translations are mock (no Inference API calls, no cost). Set <code>DRY_RUN=false</code> and a valid <code>MODEL_ACCESS_KEY</code> to go live.`
        : hasKey
          ? `Running live against your DigitalOcean account using model <code>${escapeHtml(modelId)}</code>. Each translation is a small real usage charge.`
          : `<strong>No MODEL_ACCESS_KEY is configured</strong> — live requests will fail. Set it as an app-level secret, or set DRY_RUN=true to demo with mock data.`}
    </div>
  </div>

  <div class="panel" id="sourcePanel" style="display:none;">
    <div class="source-label">Extracted from: <span id="sourceUrlLabel"></span></div>
    <div class="source-text" id="sourceTextPreview"></div>
  </div>

  <div class="results-grid" id="resultsGrid"></div>
</div>
<footer>Unofficial internal demo. Translations are generated by a DigitalOcean Serverless Inference model and may not be perfect — review before sending to real customers.</footer>
<script>${CLIENT_SCRIPT}</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT, 10) || 8080;
const DRY_RUN = String(process.env.DRY_RUN || '').toLowerCase() === 'true';
const MODEL_ACCESS_KEY = process.env.MODEL_ACCESS_KEY || null;
const MODEL_ID = process.env.MODEL_ID || 'openai-gpt-oss-120b';

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (req.url === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(landingPage({ dryRun: DRY_RUN, hasKey: !!MODEL_ACCESS_KEY, modelId: MODEL_ID }));
      return;
    }

    if (req.url === '/api/translate' && req.method === 'POST') {
      if (!DRY_RUN && !MODEL_ACCESS_KEY) {
        sendJson(res, 500, { error: "MODEL_ACCESS_KEY is not configured and DRY_RUN is not true. Set one of them in the app's environment variables." });
        return;
      }

      let body;
      try {
        body = await readRequestBody(req);
      } catch (err) {
        sendJson(res, 413, { error: 'Request body too large.' });
        return;
      }

      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch (err) {
        sendJson(res, 400, { error: 'Request body must be valid JSON.' });
        return;
      }

      const text = typeof payload.text === 'string' ? payload.text.trim() : '';
      const requestedCodes = Array.isArray(payload.targetLangs) ? payload.targetLangs : [];
      const targetCodes = [...new Set(requestedCodes)].filter((c) => LANGUAGE_BY_CODE[c]);

      if (!text) {
        sendJson(res, 400, { error: 'Field "text" is required.' });
        return;
      }
      if (text.length > MAX_TEXT_LEN) {
        sendJson(res, 400, { error: `Text is too long (max ${MAX_TEXT_LEN} characters).` });
        return;
      }
      if (targetCodes.length === 0) {
        sendJson(res, 400, { error: 'Pick at least one supported target language.' });
        return;
      }
      if (targetCodes.length > MAX_TARGET_LANGS) {
        sendJson(res, 400, { error: `Pick at most ${MAX_TARGET_LANGS} target languages at a time.` });
        return;
      }

      const results = await translateAll({
        text,
        targetCodes,
        modelAccessKey: MODEL_ACCESS_KEY,
        modelId: MODEL_ID,
        baseUrl: BASE_URL,
        dryRun: DRY_RUN,
      });

      sendJson(res, 200, { dryRun: DRY_RUN, model: DRY_RUN ? null : MODEL_ID, results });
      return;
    }

    if (req.url === '/api/translate-url' && req.method === 'POST') {
      if (!DRY_RUN && !MODEL_ACCESS_KEY) {
        sendJson(res, 500, { error: "MODEL_ACCESS_KEY is not configured and DRY_RUN is not true. Set one of them in the app's environment variables." });
        return;
      }

      let body;
      try {
        body = await readRequestBody(req);
      } catch (err) {
        sendJson(res, 413, { error: 'Request body too large.' });
        return;
      }

      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch (err) {
        sendJson(res, 400, { error: 'Request body must be valid JSON.' });
        return;
      }

      const rawUrl = typeof payload.url === 'string' ? payload.url.trim() : '';
      const requestedCodes = Array.isArray(payload.targetLangs) ? payload.targetLangs : [];
      const targetCodes = [...new Set(requestedCodes)].filter((c) => LANGUAGE_BY_CODE[c]);

      if (!rawUrl) {
        sendJson(res, 400, { error: 'Field "url" is required.' });
        return;
      }
      if (targetCodes.length === 0) {
        sendJson(res, 400, { error: 'Pick at least one supported target language.' });
        return;
      }
      if (targetCodes.length > MAX_TARGET_LANGS) {
        sendJson(res, 400, { error: `Pick at most ${MAX_TARGET_LANGS} target languages at a time.` });
        return;
      }

      // Fetching the page itself is a plain HTTP GET, not a billed Inference
      // call — so this runs for real even in DRY_RUN mode, to make the demo
      // feel authentic. Only the translation step below is mocked.
      let extraction;
      try {
        extraction = await fetchUrlText(rawUrl);
      } catch (err) {
        if (err instanceof DemoError) {
          sendJson(res, 400, { error: err.message });
        } else {
          console.error('URL fetch error:', err);
          sendJson(res, 502, { error: 'Could not fetch or read that page.' });
        }
        return;
      }

      let text = extraction.title ? `${extraction.title}\n\n${extraction.text}` : extraction.text;
      text = text.trim();
      let truncated = extraction.truncatedFetch;
      if (text.length > MAX_URL_TEXT_LEN) {
        text = text.slice(0, MAX_URL_TEXT_LEN);
        truncated = true;
      }
      if (!text) {
        sendJson(res, 400, { error: 'Could not find any readable text on that page.' });
        return;
      }

      const results = await translateAll({
        text,
        targetCodes,
        modelAccessKey: MODEL_ACCESS_KEY,
        modelId: MODEL_ID,
        baseUrl: BASE_URL,
        dryRun: DRY_RUN,
      });

      sendJson(res, 200, {
        dryRun: DRY_RUN,
        model: DRY_RUN ? null : MODEL_ID,
        sourceUrl: extraction.finalUrl,
        title: extraction.title,
        extractedText: text,
        truncated,
        results,
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    console.error('Unhandled error:', err);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal error — check app logs.');
  }
});

server.listen(PORT, () => {
  console.log(`Multilingual translation demo listening on :${PORT} (DRY_RUN=${DRY_RUN}, key configured=${!!MODEL_ACCESS_KEY}, model=${MODEL_ID})`);
});
