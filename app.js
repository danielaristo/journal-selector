"use strict";

const DATA_URL = "data/scimago_2024.json";
const OPENALEX_URL = "https://api.openalex.org/works";
const OPENALEX_SOURCES_URL = "https://api.openalex.org/sources";
const OPENALEX_PER_PAGE = 100;
const OPENALEX_SOURCES_CHUNK = 50; // ISSNs per batched /sources lookup
// Free OpenAlex API key (openalex.org/settings/api): gives this app its own
// $1/day budget instead of sharing the anonymous per-IP daily pool. It's
// visible in this public client-side source (there's no backend to hide it
// behind) — acceptable here since the key is free, capped, and tied to no
// billing or account data, but it does mean anyone could reuse it.
const OPENALEX_API_KEY = "EFzVGljUdkP62TGAMLu0nN";
const CROSSREF_URL = "https://api.crossref.org/works";
const CROSSREF_ROWS = 100;
// Keep broadening until at least this many journals *matching the current
// filters* show up. Kept modest on purpose: a single quartile can genuinely
// have few candidates in a narrow niche, and pushing for more forces the
// query down to very generic terms (see rankKeywords), diluting relevance
// far more than it's worth for a handful of extra, often off-topic results.
const MIN_MATCHED_JOURNALS = 6;
const MIN_USER_KEYWORDS = 5;
const MAX_USER_KEYWORDS = 8;
// The primary search runs on the abstract's own auto-extracted keywords,
// tried narrowest (most specific) first. The user's mandatory keywords don't
// drive this — they're only used for the by-keyword fallback recommendation
// (see recommendByKeywords) when the primary search comes up thin.
const KEYWORD_STEPS = [10, 9, 8, 7, 6, 5, 4, 3];

// Stopwords (EN + ES) used to extract keywords from the abstract.
const STOPWORDS = new Set(`
  a al algo algunas algunos ante antes como con contra cual cuales cuando de del desde donde
  dos el ella ellas ellos en entre era eres es esa esas ese esos esta estas este esto estos fue
  fueron ha han hasta la las le les lo los mas más me mi mis mismo muy nada ni no nos nosotros o
  os otra otras otro otros para pero poco por porque que quien quienes se sin sobre su sus tambien
  también te tiene tienen todo todos tu tus un una uno unos y ya
  about above after again against all also am an and any are aren as at be because been before
  being below between both but by can cannot could did do does doing down during each few for
  from further had has have having he her here hers herself him himself his how i if in into is
  it its itself just me more most my myself no nor not now of off on once only or other our ours
  ourselves out over own same she should so some such than that the their theirs them themselves
  then there these they this those through to too under until up very was we were what when where
  which while who whom why will with you your yours yourself yourselves this study paper article
  using used based results result show shows shown propose proposed present presents approach
  method methods analysis data model models framework demonstrate demonstrates significant significantly
  research introduction conclusion conclusions findings finding provide provides providing
  investigacion introduccion conclusiones hallazgos resultados
`.trim().split(/\s+/));

let scimagoData = null; // { journals: [...], issnIndex: { issn: idx } }
let dataLoadPromise = null;

function loadData() {
  if (!dataLoadPromise) {
    dataLoadPromise = fetch(DATA_URL)
      .then(r => { if (!r.ok) throw new Error("Could not load the Scimago dataset"); return r.json(); })
      .then(d => { scimagoData = d; return d; });
  }
  return dataLoadPromise;
}

function stripAccents(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Ranks candidate keywords by a score built from frequency plus two bonuses,
// both gated on the word being mentioned more than once (so a one-off long
// word or acronym — often a dataset code, institution name or incidental
// term — can't dominate just by being rare-looking):
//  - a length bonus, since short, generic words ("series", "price", "food")
//    tend to recur more often than specific domain nouns ("agricultural",
//    "forecasting", "wholesale") but are far less useful at narrowing down
//    the field — without this, raw frequency alone crowds domain words out
//    of the top slots even when they're clearly what the abstract is about;
//  - an acronym bonus for ALL-CAPS tokens (ARIMA, SARIMA, MAPE...): rare in
//    general English and strongly disambiguating, though capped rather than
//    dominant, since forecasting-metric acronyms alone are used across many
//    unrelated fields (epidemiology, tourism...) and still need a domain
//    word alongside them to stay on-topic.
// Accents are stripped only for stopword comparison; the original accented
// form is kept for the actual query, since folding accents away hurts
// recall on non-English text.
function rankKeywords(text) {
  const tokenRe = /[A-Za-zÁÉÍÓÚÑÜáéíóúñü]{4,}/g;
  const freq = new Map(); // key: unaccented lowercase form -> { original, count, acronym }
  let m;
  while ((m = tokenRe.exec(text))) {
    const w = m[0];
    const lower = w.toLowerCase();
    const key = stripAccents(lower);
    if (STOPWORDS.has(key)) continue;
    const isAcronym = /^[A-ZÁÉÍÓÚÑÜ]{2,}$/.test(w);
    let entry = freq.get(key);
    if (!entry) { entry = { original: lower, count: 0, acronym: false }; freq.set(key, entry); }
    entry.count += 1;
    if (isAcronym) entry.acronym = true;
  }
  return [...freq.values()]
    .map(e => {
      const repeated = e.count >= 2;
      const lengthBonus = repeated ? Math.floor(e.original.length / 3) : 0;
      const acronymBonus = (e.acronym && repeated) ? 2 : 0;
      return { ...e, score: e.count + lengthBonus + acronymBonus };
    })
    .sort((a, b) => (b.score - a.score) || (b.original.length - a.original.length))
    .map(e => e.original);
}

function normIssn(raw) {
  return (raw || "").replace(/[^0-9Xx]/g, "").toUpperCase();
}

function openAlexAuth() {
  return OPENALEX_API_KEY ? `&api_key=${encodeURIComponent(OPENALEX_API_KEY)}` : "";
}

// Both search functions normalize to the same shape: { source, total, items }
// where each item is { issns, name, score }. That lets the rest of the
// pipeline (aggregation, matching, adaptive broadening) stay agnostic to
// which provider actually answered the query.

async function searchOpenAlex(keywords) {
  const q = keywords.join(" ");
  const url = `${OPENALEX_URL}?search=${encodeURIComponent(q)}&per-page=${OPENALEX_PER_PAGE}` +
    `&select=id,display_name,relevance_score,primary_location${openAlexAuth()}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`OpenAlex returned ${r.status}`);
  const data = await r.json();
  const items = (data.results || []).map(w => {
    const src = w.primary_location && w.primary_location.source;
    const issns = src && (src.issn && src.issn.length ? src.issn : [src.issn_l]).filter(Boolean);
    if (!issns || !issns.length) return null;
    return { issns, name: src.display_name, score: w.relevance_score || 0 };
  }).filter(Boolean);
  return { source: "OpenAlex", total: data.meta ? data.meta.count : items.length, items };
}

// Fallback for when OpenAlex is unreachable or rate-limits us (HTTP 429):
// Crossref's bibliographic search covers much the same ground (it's what
// Verificador Referencias uses as its primary source) and is also free,
// keyless and CORS-enabled. Crossref's public pool allows only ~1 request/sec
// (and rejects a burst with a response that omits CORS headers entirely,
// which shows up in the browser as an opaque "CORS blocked" network error
// rather than a readable 429) — when OpenAlex is down, every adaptive-search
// round fails it instantly and falls through to Crossref, so back-to-back
// rounds can easily outrun that limit without this throttle.
let lastCrossrefCallAt = 0;
const CROSSREF_MIN_INTERVAL_MS = 1100;
async function searchCrossref(keywords) {
  const wait = CROSSREF_MIN_INTERVAL_MS - (Date.now() - lastCrossrefCallAt);
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  lastCrossrefCallAt = Date.now();
  const q = keywords.join(" ");
  const url = `${CROSSREF_URL}?query.bibliographic=${encodeURIComponent(q)}&rows=${CROSSREF_ROWS}` +
    `&filter=type:journal-article&select=container-title,ISSN,score`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Crossref returned ${r.status}`);
  const data = await r.json();
  const msg = data.message || {};
  const items = (msg.items || []).map(w => {
    const issns = w.ISSN || [];
    const name = w["container-title"] && w["container-title"][0];
    if (!issns.length || !name) return null;
    return { issns, name, score: w.score || 0 };
  }).filter(Boolean);
  return { source: "Crossref", total: msg["total-results"] || items.length, items };
}

// Crossref first: its bibliographic search focuses on a work's own title/
// abstract/metadata, while OpenAlex's `search` matches against full text
// (references included when available) — which tends to pull in papers that
// merely *cite* something related rather than being about it, diluting
// relevance for this app's purposes. OpenAlex is still used for the
// homepage/open-access enrichment step below (Crossref has no equivalent
// data) and as a fallback here if Crossref itself is unavailable.
async function searchWorks(keywords) {
  try {
    return await searchCrossref(keywords);
  } catch (err) {
    console.warn("Crossref unavailable, falling back to OpenAlex:", err);
    return await searchOpenAlex(keywords);
  }
}

function hyphenateIssn(issn) {
  return issn.length === 8 ? `${issn.slice(0, 4)}-${issn.slice(4)}` : issn;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Best-effort enrichment: fetches each journal's homepage URL and open-access
// status from OpenAlex's Sources endpoint (batched by ISSN, one HTTP call per
// ~50 journals) and attaches it to the matching item in place. Crossref has
// no equivalent data, so this only runs when OpenAlex itself is reachable;
// any failure (rate limit, network) is swallowed — the result list still
// renders fine without this extra info, just without the website button and
// OA/APC badge.
async function enrichWithOpenAlexSources(items) {
  const issnToItems = new Map(); // hyphenated issn -> [item, ...]
  for (const item of items) {
    for (const issn of item.journal.issn) {
      const h = hyphenateIssn(issn);
      if (!issnToItems.has(h)) issnToItems.set(h, []);
      issnToItems.get(h).push(item);
    }
  }
  const allIssns = [...issnToItems.keys()];
  for (const batch of chunk(allIssns, OPENALEX_SOURCES_CHUNK)) {
    try {
      const url = `${OPENALEX_SOURCES_URL}?filter=${encodeURIComponent("issn:" + batch.join("|"))}` +
        `&per-page=${batch.length}&select=issn,homepage_url,is_oa,is_in_doaj,apc_usd${openAlexAuth()}`;
      const r = await fetch(url);
      if (!r.ok) continue; // skip this batch silently, keep the rest of the results usable
      const data = await r.json();
      for (const src of data.results || []) {
        const targets = (src.issn || []).flatMap(issn => issnToItems.get(issn) || []);
        for (const item of targets) {
          item.homepageUrl = src.homepage_url || null;
          item.isOA = src.is_oa;
          item.isInDoaj = src.is_in_doaj;
          item.apcUsd = src.apc_usd ?? null;
        }
      }
    } catch (err) {
      console.warn("OpenAlex Sources enrichment failed for a batch, skipping:", err);
    }
  }
}

// The search APIs require every keyword to appear somewhere in the work, so
// more keywords = a stricter (AND-like) query. This runs on the abstract's
// own auto-extracted keywords only — the user's mandatory keywords don't
// drive this search, they're reserved for the by-keyword fallback below —
// starting narrow (more precise) and progressively dropping the least
// distinctive keyword, running an actual new search at each step, until
// enough distinct Scopus-indexed journals *matching the user's current
// filters* (quartile, country/publisher...) show up. Widening against the
// filtered count, not the raw matched count, matters because a narrow
// query's candidate pool can easily contain only one journal in, say, Q3 —
// the user would otherwise see "1 result" even though a broader query has
// plenty.
//
// Each step's journals are merged into a running, deduplicated pool rather
// than replacing the previous step's — a query only samples the top ~100
// works from the API, so a broader query can easily surface a *different*
// slice (extra journals a narrower query missed) rather than a strict
// superset of it. Accumulating means every round of widening can only add
// candidates, never lose ones an earlier, more precise round already found.
async function adaptiveSearch(autoKeywords, filters, onStep) {
  const pool = new Map(); // journal object -> { journal, count, scoreSum }
  const rounds = []; // { keywords, source, itemCount }
  let lastData = null;
  let lastKeywords = null;
  let lastUnmatchedCount = 0;
  let lastLength = null;
  for (const n of KEYWORD_STEPS) {
    const keywords = autoKeywords.slice(0, n);
    if (lastLength !== null && keywords.length >= lastLength) continue;
    lastLength = keywords.length;
    if (onStep) onStep(keywords, rounds.length + 1);
    const data = await searchWorks(keywords);
    lastData = data;
    lastKeywords = keywords;
    rounds.push({ keywords, source: data.source, itemCount: data.items.length });
    const agg = aggregateJournals(data.items);
    const { matched, unmatchedCount } = matchScimago(agg);
    lastUnmatchedCount = unmatchedCount;
    for (const item of matched) {
      const existing = pool.get(item.journal);
      if (existing) {
        existing.count += item.count;
        existing.scoreSum += item.scoreSum;
      } else {
        pool.set(item.journal, { ...item });
      }
    }
    const merged = [...pool.values()];
    const filteredCount = merged.filter(item => passesFilters(item, filters)).length;
    if (filteredCount >= MIN_MATCHED_JOURNALS || keywords.length <= 3) break;
  }
  const matched = [...pool.values()].sort((a, b) => (b.scoreSum + b.count) - (a.scoreSum + a.count));
  return { data: lastData, keywords: lastKeywords, matched, unmatchedCount: lastUnmatchedCount, rounds };
}

function aggregateJournals(items) {
  const agg = new Map(); // issn -> { issns, count, scoreSum, name }
  for (const it of items) {
    const issns = it.issns.map(normIssn).filter(Boolean);
    if (!issns.length) continue;
    const key = issns[0];
    if (!agg.has(key)) agg.set(key, { issns, count: 0, scoreSum: 0, name: it.name });
    const entry = agg.get(key);
    entry.count += 1;
    entry.scoreSum += it.score;
  }
  return agg;
}

function matchScimago(agg) {
  const matched = [];
  let unmatchedCount = 0;
  for (const entry of agg.values()) {
    let journal = null;
    for (const issn of entry.issns) {
      const idx = scimagoData.issnIndex[issn];
      if (idx !== undefined) { journal = scimagoData.journals[idx]; break; }
    }
    if (journal) {
      matched.push({ journal, count: entry.count, scoreSum: entry.scoreSum, openAlexName: entry.name });
    } else {
      unmatchedCount += 1;
    }
  }
  matched.sort((a, b) => (b.scoreSum + b.count) - (a.scoreSum + a.count));
  return { matched, unmatchedCount };
}

// How many (type="journal") Scimago records carry each category name —
// cached lazily. Used as a document-frequency measure of how generic a
// category is: an umbrella tag like "Strategy and Management" is carried by
// hundreds of journals across unrelated fields, while a narrow one like
// "Transportation" is far more diagnostic of an actual topic.
let categoryDocFreqCache = null;
function categoryDocFreq() {
  if (categoryDocFreqCache) return categoryDocFreqCache;
  const freq = new Map();
  for (const j of scimagoData.journals) {
    if (j.type !== "journal") continue;
    const seen = new Set();
    for (const c of j.categories) {
      if (seen.has(c.name)) continue;
      seen.add(c.name);
      freq.set(c.name, (freq.get(c.name) || 0) + 1);
    }
  }
  categoryDocFreqCache = freq;
  return freq;
}

// Falls back to the whole (already in-memory) Scimago dataset — no API call
// needed — to recommend journals in the desired quartile by keyword instead
// of by direct topical hit. This is what runs when too few journals in the
// picked quartile(s) came up directly: rather than leaving the user
// empty-handed, inferring a subject area from noisy search results, or
// silently swapping in a different quartile, it matches the given keywords
// (the user's own, mandatory ones, kept exactly as typed — not split into
// individual words, since "vehicle" alone drifts toward automotive
// engineering while "vehicle routing" means something specific in
// operations research) against two things:
//  - Scimago category names, weighted by how rare that category is across
//    the dataset (see categoryDocFreq), so a keyword landing on a narrow,
//    diagnostic category ("Transportation") counts for more than one landing
//    on a broad umbrella shared by hundreds of unrelated journals ("Strategy
//    and Management");
//  - the journal's own title, which is free text and often carries the exact
//    terminology a fixed ~330-category taxonomy can't (e.g. "Cold Chain
//    Logistics"). Weighted by how many titles in the whole dataset contain
//    that exact phrase, so a keyword that happens to match many titles
//    counts for less than one that pins down just a handful.
function recommendByKeywords(keywords, filters) {
  const lowerKws = keywords.map(k => k.toLowerCase().trim()).filter(k => k.length >= 4);
  if (!lowerKws.length) return [];
  const catDocFreq = categoryDocFreq();
  const totalJournals = scimagoData.journals.length;
  const catWeight = new Map(); // category name -> idf, for names containing a keyword
  for (const name of catDocFreq.keys()) {
    const lowerName = name.toLowerCase();
    if (lowerKws.some(k => lowerName.includes(k))) {
      catWeight.set(name, Math.log((totalJournals + 1) / catDocFreq.get(name)));
    }
  }
  // Title document frequency per keyword, computed directly (there are only
  // ever 5-8 keywords, so one extra pass over the dataset is cheap) rather
  // than cached per-word like categoryDocFreq, since the exact phrases vary
  // by search.
  const titleDocFreq = new Map(lowerKws.map(k => [k, 0]));
  for (const j of scimagoData.journals) {
    if (j.type !== "journal") continue;
    const titleLower = j.title.toLowerCase();
    for (const k of lowerKws) {
      if (titleLower.includes(k)) titleDocFreq.set(k, titleDocFreq.get(k) + 1);
    }
  }
  const candidates = [];
  for (const journal of scimagoData.journals) {
    if (journal.type !== "journal") continue;
    if (!journal.quartile || !filters.quartiles.includes(journal.quartile)) continue;
    if (filters.freeText) {
      const hay = `${journal.country || ""} ${journal.publisher || ""}`.toLowerCase();
      if (!hay.includes(filters.freeText)) continue;
    }
    let score = 0, hits = 0;
    for (const c of journal.categories) {
      const w = catWeight.get(c.name);
      if (w) { score += w; hits += 1; }
    }
    const titleLower = journal.title.toLowerCase();
    for (const k of lowerKws) {
      if (!titleLower.includes(k)) continue;
      hits += 1;
      score += Math.log((totalJournals + 1) / (titleDocFreq.get(k) || 1));
    }
    if (hits === 0) continue;
    candidates.push({ journal, count: hits, scoreSum: 0, categoryOverlap: hits, categoryScore: score });
  }
  candidates.sort((a, b) => (b.categoryScore - a.categoryScore) || ((b.journal.sjr || 0) - (a.journal.sjr || 0)));
  return candidates.slice(0, 20);
}

function getFilters() {
  const quartiles = [...document.querySelectorAll(".quartile-check:checked")].map(el => el.value);
  const freeText = document.getElementById("filterText").value.trim().toLowerCase();
  return { quartiles, freeText };
}

function getUserKeywords() {
  const raw = document.getElementById("keywordsInput").value.trim();
  if (!raw) return [];
  return raw.split(/[,;]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
}

function passesFilters(item, filters, { skipQuartile = false } = {}) {
  const j = item.journal;
  if (j.type !== "journal") return false;
  if (!skipQuartile) {
    if (!j.quartile || !filters.quartiles.includes(j.quartile)) return false;
  }
  if (filters.freeText) {
    const hay = `${j.country || ""} ${j.publisher || ""}`.toLowerCase();
    if (!hay.includes(filters.freeText)) return false;
  }
  return true;
}

function quartileClass(q) {
  return q ? `q${q}` : "qN";
}

// Relative topical-affinity score, not a prediction of acceptance odds: the
// best-matching journal in the current result set is set to 100% and every
// other one is scaled against it, using the same (relevance-score + hit
// count) combination already used to rank the list.
function assignMatchScores(items) {
  const maxScore = Math.max(...items.map(i => i.scoreSum + i.count), 1);
  for (const item of items) {
    item.matchPct = Math.max(1, Math.round(((item.scoreSum + item.count) / maxScore) * 100));
  }
}

function accessBadge(item) {
  if (item.apcUsd != null) {
    return `<span class="pill pApc">APC ~$${Math.round(item.apcUsd)} USD</span>`;
  }
  if (item.isOA === true) {
    return `<span class="pill pOA">Open access${item.isInDoaj ? " · DOAJ-listed" : ""}</span>`;
  }
  if (item.isOA === false) {
    return `<span class="pill pN">Subscription / hybrid (check journal)</span>`;
  }
  return "";
}

function renderResults(matched, unmatchedCount, totalConsidered, quartileFallback, fallbackKeywords, blockingFreeText) {
  const wrap = document.getElementById("resultsWrap");
  if (!matched.length) {
    wrap.innerHTML = blockingFreeText
      ? `<div class="empty">Journals matching your topic and quartile were found, but none are published in/by ` +
        `"${escapeHtml(blockingFreeText)}". Clear or broaden the country/publisher filter to see them.</div>`
      : `<div class="empty">No Scopus-indexed journal was found for this abstract at all — try a longer or more specific abstract, or add some keywords.</div>`;
    return;
  }
  const directCount = matched.filter(item => !item.fromKeyword).length;
  const supplementCount = matched.length - directCount;
  const thinDirect = directCount
    ? `Only ${directCount} journal(s) in your selected quartile turned up directly for this topic`
    : `No journal in your selected quartile turned up for this topic`;
  const fallbackNotice = quartileFallback
    ? supplementCount
      ? `<p class="summary" style="color:var(--q3-fg)">⚠️ ${thinDirect} even after broadening the search as far as it goes. ` +
        `The rest here are instead recommended by <strong>keyword</strong> ` +
        `(${escapeHtml((fallbackKeywords || []).join(", "))}) — matched as exact phrases against journal titles and ` +
        `Scimago categories, filtered to your chosen quartile — and marked "keyword hits" instead of a topical ` +
        `match %, since they weren't found via the abstract search itself.</p>`
      : `<p class="summary" style="color:var(--q3-fg)">⚠️ ${thinDirect} even after broadening the search as far as it ` +
        `goes. None of your keyword phrases (${escapeHtml((fallbackKeywords || []).join(", "))}) — matched as exact ` +
        `phrases, not split into individual words — appear verbatim in any journal title or Scimago category in ` +
        `your chosen quartile either, so no extra recommendations could be added here.</p>`
    : "";
  const summary = fallbackNotice + `<p class="summary">${matched.length} matching journal(s)` +
    `${quartileFallback ? "" : " within your filters"} ` +
    `(out of ${totalConsidered} distinct journals found; ${unmatchedCount} are not indexed in Scopus/Scimago).` +
    (quartileFallback ? "" : ` "Match" is topical similarity to your abstract relative to the top result here, not a prediction of acceptance.`) +
    `</p>`;

  const cards = matched.map(item => {
    const j = item.journal;
    const cats = j.categories.slice(0, 6).map(c =>
      `<span>${escapeHtml(c.name)}${c.quartile ? ` (${c.quartile})` : ""}</span>`
    ).join("");
    const badge = accessBadge(item);
    const rightBadge = item.fromKeyword
      ? `<span class="pill pMatch">${item.categoryOverlap} keyword hit${item.categoryOverlap === 1 ? "" : "s"}</span>`
      : `<span class="pill pMatch">${item.matchPct}% match</span><span class="pill pN">${item.count} related</span>`;
    return `
      <div class="jcard">
        <div class="top">
          <h3><a href="${j.scimagoUrl}" target="_blank" rel="noopener">${escapeHtml(j.title)}</a></h3>
          <div class="badges">
            <span class="qbadge ${quartileClass(j.quartile)}">${j.quartile || "n/a"}</span>
            ${rightBadge}
          </div>
        </div>
        <div class="meta">
          <span class="sjr">SJR ${j.sjr != null ? j.sjr.toFixed(3) : "—"}</span> · H-index ${j.hIndex ?? "—"} ·
          ${escapeHtml(j.publisher || "unknown publisher")} · ${escapeHtml(j.country || "unknown country")} ·
          ISSN ${j.issn.join(", ")}
        </div>
        ${badge ? `<div class="access">${badge}</div>` : ""}
        <div class="cats">${cats}</div>
        <div class="actions">
          <a class="btn-sjr" href="${j.scimagoUrl}" target="_blank" rel="noopener">View on Scimago (SJR) ↗</a>
          ${item.homepageUrl ? `<a class="btn-sjr" href="${escapeHtml(item.homepageUrl)}" target="_blank" rel="noopener">Journal website ↗</a>` : ""}
        </div>
      </div>`;
  }).join("");

  wrap.innerHTML = summary + `<div class="results">${cards}</div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function setStatus(msg) {
  document.getElementById("status").textContent = msg;
}

async function runSearch() {
  const text = document.getElementById("abstract").value.trim();
  if (text.split(/\s+/).filter(Boolean).length < 15) {
    setStatus("Paste a more complete abstract (at least ~15 words) for a reliable search.");
    return;
  }
  const userKeywords = getUserKeywords();
  if (userKeywords.length < MIN_USER_KEYWORDS) {
    setStatus(`Add at least ${MIN_USER_KEYWORDS} keywords (comma-separated) — used to power the by-keyword recommendations if the abstract search comes up thin.`);
    return;
  }
  if (userKeywords.length > MAX_USER_KEYWORDS) {
    setStatus(`Please use at most ${MAX_USER_KEYWORDS} keywords — pick your most specific/distinctive ones.`);
    return;
  }
  const btn = document.getElementById("searchBtn");
  btn.disabled = true;
  setStatus("Loading journal dataset...");
  document.getElementById("resultsWrap").innerHTML = "";
  try {
    await loadData();
    const autoKeywords = rankKeywords(text);
    const filters = getFilters();
    const { keywords, matched, unmatchedCount, rounds } = await adaptiveSearch(autoKeywords, filters, (kws, roundNum) => {
      setStatus(`Search ${roundNum}: ${kws.join(", ")}...`);
    });
    let filtered = matched.filter(item => passesFilters(item, filters));
    assignMatchScores(filtered); // only meaningful on the direct topical matches, before any supplementing below
    // If too few journals in the picked quartile(s) came up directly — even
    // after the adaptive search broadened as far as it goes — top up with
    // journals in the *right* quartile recommended by the user's own
    // keywords instead: matched against journal titles and Scimago
    // categories in the full local dataset (no API call needed). A couple of
    // thin, barely-relevant direct hits shouldn't get dressed up as a
    // confident "100% match" just because nothing else showed up — real
    // hits are kept (and shown first) rather than discarded, just topped up.
    const quartileFallback = filtered.length < MIN_MATCHED_JOURNALS && matched.length > 0;
    if (quartileFallback) {
      const already = new Set(filtered.map(item => item.journal));
      const supplement = recommendByKeywords(userKeywords, filters)
        .filter(item => !already.has(item.journal))
        .map(item => ({ ...item, fromKeyword: true }));
      filtered = [...filtered, ...supplement];
    }
    // A country/publisher filter is applied everywhere above (it's part of
    // passesFilters), so it can silently zero out an otherwise-successful
    // search — the generic "nothing found" message would then wrongly blame
    // the abstract/keywords. Check whether dropping just that filter would
    // have found anything, so the empty state can say what's actually wrong.
    let freeTextBlocking = false;
    if (filtered.length === 0 && filters.freeText) {
      const withoutFreeText = { ...filters, freeText: "" };
      freeTextBlocking = matched.some(item => passesFilters(item, withoutFreeText)) ||
        recommendByKeywords(userKeywords, withoutFreeText).length > 0;
    }
    const totalItems = rounds.reduce((sum, r) => sum + r.itemCount, 0);
    const roundsDesc = rounds.map(r => `${r.keywords.length} keywords via ${r.source}`).join(" → ");
    const baseStatus = `${rounds.length} search${rounds.length > 1 ? "es" : ""} run (${roundsDesc}), ` +
      `${totalItems} articles analyzed, last query: ${keywords.join(", ")}.`;
    setStatus(`${baseStatus} Looking up journal websites and open-access info...`);
    await enrichWithOpenAlexSources(filtered);
    setStatus(baseStatus);
    renderResults(filtered, unmatchedCount, matched.length, quartileFallback, userKeywords, freeTextBlocking ? filters.freeText : null);
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

function updateCounter() {
  const text = document.getElementById("abstract").value.trim();
  const n = text ? text.split(/\s+/).filter(Boolean).length : 0;
  document.getElementById("counter").textContent = `${n} words`;
}

document.getElementById("abstract").addEventListener("input", updateCounter);
document.getElementById("searchBtn").addEventListener("click", runSearch);
document.getElementById("clearBtn").addEventListener("click", () => {
  document.getElementById("abstract").value = "";
  document.getElementById("keywordsInput").value = "";
  document.getElementById("filterText").value = "";
  updateCounter();
  document.getElementById("resultsWrap").innerHTML = "";
  setStatus("");
});

// ---- Browse-the-catalog module (no abstract, just filters) ----------------

const BROWSE_MAX_RESULTS = 60;

// Fills the area <select> and the category/country <datalist>s from the
// full local dataset. Called once, after the dataset first loads.
// area -> Set of category names, plus the full set under "" (Any). Scimago
// doesn't publish an explicit category->area mapping, so this is built by
// co-occurrence: whichever categories show up on journals tagged with a
// given area. A multidisciplinary journal can link a category to more than
// one area, which is fine — that category genuinely spans both.
let categoriesByArea = null;
let allCategoriesSorted = null;
let allCountriesSorted = null;

function populateBrowseFilters() {
  const areas = new Set();
  const countries = new Set();
  categoriesByArea = new Map();
  const allCategories = new Set();
  for (const j of scimagoData.journals) {
    if (j.type !== "journal") continue;
    for (const a of j.areas) areas.add(a);
    if (j.country) countries.add(j.country);
    for (const c of j.categories) allCategories.add(c.name);
    // Only single-area journals feed the area->categories map: a
    // multidisciplinary journal (several areas at once) would otherwise
    // link every one of its categories to every one of its areas, quickly
    // drowning each area's list in unrelated categories from its
    // co-tagged siblings.
    if (j.areas.length !== 1) continue;
    const area = j.areas[0];
    if (!categoriesByArea.has(area)) categoriesByArea.set(area, new Set());
    for (const c of j.categories) categoriesByArea.get(area).add(c.name);
  }
  allCategoriesSorted = [...allCategories].sort();
  allCountriesSorted = [...countries].sort();
  const areaSelect = document.getElementById("browseArea");
  for (const a of [...areas].sort()) {
    const opt = document.createElement("option");
    opt.value = a;
    opt.textContent = a;
    areaSelect.appendChild(opt);
  }
  setupAutocomplete(document.getElementById("browseCategory"), currentCategoryOptions);
  setupAutocomplete(document.getElementById("browseCountry"), () => allCountriesSorted);
}

// The category field's own suggestion list, live-narrowed to whichever area
// is currently selected (or the full ~310 when no area is picked).
function currentCategoryOptions() {
  const area = document.getElementById("browseArea").value;
  return area && categoriesByArea.has(area) ? [...categoriesByArea.get(area)].sort() : allCategoriesSorted;
}

// A small self-contained autocomplete dropdown, used in place of a native
// <datalist> — datalist's suggestion filtering and result count are
// inconsistent across browsers (and quite limited in this app's embedded
// preview pane), so results can silently be missing even though the full
// option list is correct. `getOptions` is called fresh on every keystroke so
// the list can depend on other state (e.g. the category list depends on the
// currently selected area).
function setupAutocomplete(inputEl, getOptions) {
  const box = document.createElement("div");
  box.className = "ac-list";
  inputEl.insertAdjacentElement("afterend", box);

  function render() {
    const q = inputEl.value.trim().toLowerCase();
    const all = getOptions();
    const matches = (q ? all.filter(o => o.toLowerCase().includes(q)) : all).slice(0, 50);
    if (!matches.length) {
      box.innerHTML = `<div class="ac-empty">No matches</div>`;
    } else {
      box.innerHTML = matches.map(o => `<div class="ac-item">${escapeHtml(o)}</div>`).join("");
    }
    box.classList.add("on");
  }
  inputEl.addEventListener("input", render);
  inputEl.addEventListener("focus", render);
  inputEl.addEventListener("blur", () => setTimeout(() => box.classList.remove("on"), 150));
  box.addEventListener("mousedown", (e) => {
    const item = e.target.closest(".ac-item");
    if (!item) return;
    inputEl.value = item.textContent;
    box.classList.remove("on");
  });
}

function renderBrowseResults(items, totalMatched) {
  const wrap = document.getElementById("browseResultsWrap");
  if (!items.length) {
    wrap.innerHTML = `<div class="empty">No journal matches these filters.</div>`;
    return;
  }
  const capped = totalMatched > items.length
    ? ` — showing the top ${items.length} by SJR; narrow the filters to see the rest`
    : "";
  const summary = `<p class="summary">${totalMatched} journal(s) match${capped}, sorted by SJR.</p>`;
  const cards = items.map(item => {
    const j = item.journal;
    const cats = j.categories.slice(0, 6).map(c =>
      `<span>${escapeHtml(c.name)}${c.quartile ? ` (${c.quartile})` : ""}</span>`
    ).join("");
    const badge = accessBadge(item);
    return `
      <div class="jcard">
        <div class="top">
          <h3><a href="${j.scimagoUrl}" target="_blank" rel="noopener">${escapeHtml(j.title)}</a></h3>
          <div class="badges">
            <span class="qbadge ${quartileClass(j.quartile)}">${j.quartile}</span>
          </div>
        </div>
        <div class="meta">
          <span class="sjr">SJR ${j.sjr != null ? j.sjr.toFixed(3) : "—"}</span> · H-index ${j.hIndex ?? "—"} ·
          ${escapeHtml(j.publisher || "unknown publisher")} · ${escapeHtml(j.country || "unknown country")} ·
          ISSN ${j.issn.join(", ")}
        </div>
        ${badge ? `<div class="access">${badge}</div>` : ""}
        <div class="cats">${cats}</div>
        <div class="actions">
          <a class="btn-sjr" href="${j.scimagoUrl}" target="_blank" rel="noopener">View on Scimago (SJR) ↗</a>
          ${item.homepageUrl ? `<a class="btn-sjr" href="${escapeHtml(item.homepageUrl)}" target="_blank" rel="noopener">Journal website ↗</a>` : ""}
        </div>
      </div>`;
  }).join("");
  wrap.innerHTML = summary + `<div class="results">${cards}</div>`;
}

async function runBrowse() {
  const btn = document.getElementById("browseBtn");
  const statusEl = document.getElementById("browseStatus");
  btn.disabled = true;
  statusEl.textContent = "Loading journal dataset...";
  document.getElementById("browseResultsWrap").innerHTML = "";
  try {
    await loadData();
    const allMatches = browseJournals();
    const items = allMatches.slice(0, BROWSE_MAX_RESULTS);
    statusEl.textContent = "Looking up journal websites and open-access info...";
    await enrichWithOpenAlexSources(items);
    statusEl.textContent = "";
    renderBrowseResults(items, allMatches.length);
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Error: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

// Same filtering as browseJournals() but returns every match (not just the
// displayed page) so the summary can say how many were found in total.
function browseJournals() {
  const area = document.getElementById("browseArea").value;
  const category = document.getElementById("browseCategory").value.trim().toLowerCase();
  const country = document.getElementById("browseCountry").value.trim().toLowerCase();
  const maxQuartileRank = parseInt(document.getElementById("browseMaxQuartile").value, 10);
  const results = [];
  for (const journal of scimagoData.journals) {
    if (journal.type !== "journal") continue;
    if (!journal.quartile) continue;
    const rank = parseInt(journal.quartile.slice(1), 10);
    if (rank > maxQuartileRank) continue;
    if (area && !journal.areas.includes(area)) continue;
    if (category && !journal.categories.some(c => c.name.toLowerCase().includes(category))) continue;
    if (country && !(journal.country || "").toLowerCase().includes(country)) continue;
    results.push({ journal });
  }
  results.sort((a, b) => (b.journal.sjr || 0) - (a.journal.sjr || 0));
  return results;
}

document.getElementById("browseBtn").addEventListener("click", runBrowse);
document.getElementById("browseClearBtn").addEventListener("click", () => {
  document.getElementById("browseArea").value = "";
  document.getElementById("browseCategory").value = "";
  document.getElementById("browseCountry").value = "";
  document.getElementById("browseMaxQuartile").value = "4";
  document.getElementById("browseResultsWrap").innerHTML = "";
  document.getElementById("browseStatus").textContent = "";
});

// Preload the dataset in the background so the first search is fast.
loadData().then(populateBrowseFilters).catch(() => {});
