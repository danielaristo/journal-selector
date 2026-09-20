# Journal Selector

A web app that suggests Scopus-indexed journals two ways: by topical similarity to a paper's abstract, or by browsing the catalog directly (area, category, country, quartile) with no abstract at all. Filterable by quartile throughout.

## How it works

### Find by abstract

1. The user provides an abstract and, separately, **5–8 mandatory keywords** (comma-separated). The primary search runs on keywords auto-extracted from the abstract itself (stopwords stripped in English/Spanish, ALL-CAPS acronyms like ARIMA or LSTM boosted since they strongly disambiguate the topic) — the user's own keywords do *not* drive this search; they're reserved for the by-keyword fallback (step 5).
2. Queries [Crossref](https://api.crossref.org) (free, no API key, throttled to ~1 req/sec — its public-pool limit) for related work using those keywords, falling back to [OpenAlex](https://api.openalex.org) if Crossref is unreachable. Crossref is tried first because its bibliographic search focuses on a work's own title/abstract/metadata, while OpenAlex's `search` matches against full text (references included when available), which tends to surface papers that merely *cite* something related rather than being about it. The query adaptively broadens until enough Scopus-indexed journals matching the current filters (quartile, etc.) turn up — both APIs require every keyword to co-occur in a work, so a query that's too long/specific can otherwise return nothing.
3. Aggregates the matching works by publication venue and cross-references each one (by ISSN) against the [Scimago Journal Rank 2025](https://www.scimagojr.com) dataset (Scopus-based) to get quartile, SJR, H-index, publisher, country and subject categories.
4. Filters and ranks the candidates by the criteria chosen in the UI (quartile, country/publisher); only `journal`-type sources are shown (conference proceedings and book series are excluded).
5. **If no journal in the selected quartile(s) turns up** even after broadening as far as it goes, falls back to recommending journals in the *right* quartile by keyword instead: the user's own keywords are matched directly against journal titles and Scimago category names across the whole local dataset (no API call needed, no dependency on noisy search results) — a title hit and a rare/specific category hit count for more than a broad, generic one.
6. For the journals actually shown, best-effort enriches each one (batched by ISSN, one extra OpenAlex `/sources` call per ~50 journals — this step always uses OpenAlex specifically, since Crossref has no equivalent data) with its official homepage URL and open-access status (OA, DOAJ-listed, APC in USD when known). Skipped silently if OpenAlex is unavailable, so a result list still renders fine without it, just without the "Journal website" button and the OA/APC badge.
7. Shows a **match %** per journal on direct topical results: the (relevance-score + hit-count) combination already used to rank the list, normalized so the top result in the current filtered view is 100%. It reflects topical similarity to the abstract *within this result set*, not a prediction of acceptance odds — stated as such in the UI. By-keyword fallback results show a "keyword hits" count instead, since they weren't found via the abstract search itself.

### Browse the catalog directly

No abstract or API calls needed for the search itself — it filters the already-loaded Scimago dataset (32,193 journals) in the browser by area (one of Scimago's ~27 broad areas), category (free text, substring-matched against the ~330 specific categories), country and a quartile *ceiling* ("Q1–Q2" means Q1 or Q2, not exactly Q2). Results are sorted by SJR, capped at the top 60, and still get the same homepage/open-access enrichment (step 6 above) and Scimago link as the abstract-search results.

Everything runs **in the browser**, no backend, no accounts — same pattern as [Verificador Referencias](../Verificador%20Referencias).

Because there's no backend, each visitor's browser talks to Crossref/OpenAlex directly from their own IP — OpenAlex's free-tier rate limit is per-IP (unless an API key is configured; see `OPENALEX_API_KEY` in `app.js`, free at openalex.org/settings/api, gives the app its own $1/day budget instead of sharing the anonymous per-IP pool), so one visitor's usage doesn't eat into another's, and a rate-limited or unavailable OpenAlex only costs the homepage/OA enrichment step, not the search itself (which runs on Crossref primarily).

## Important limitation

The quartile shown is **SJR/Scopus** (free, public data). The **Web of Science JCR quartile** (Clarivate) is a paid product; there is no legal free source to reproduce it, so this tool does not offer it. The app states this clearly in the UI.

Note also that Scimago's own export strips accents from journal titles (e.g. "Revista Espanola de..." instead of "Revista Española de..."); that's a limitation of the source data, not of this app's parsing.

## Local usage

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

No dependencies or build step required.

## Updating the journal dataset

The dataset (`data/scimago_2025.json`) is generated by `scripts/prep_scimago.py` from Scimago's annual export (`scimagojr.com/journalrank.php` → download button, CSV format). The site blocks automated downloads, so export it manually from the browser:

```bash
python3 scripts/prep_scimago.py path/to/export.csv data/scimago_2025.json
```

## Structure

- `index.html` — UI.
- `app.js` — keyword extraction, adaptive Crossref/OpenAlex search, the by-area/category/country/quartile catalog browser, Scimago cross-referencing, filters, rendering.
- `data/scimago_2025.json` — preprocessed Scimago dataset (32,193 journals).
- `scripts/prep_scimago.py` — dataset preprocessing/update script.

## Author

Daniel Aristizábal Torres — independent researcher, scientometrics and research integrity.

## License

MIT — see [LICENSE](LICENSE).
