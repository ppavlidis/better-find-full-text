# Better Find Full Text

A Zotero 7/8/9 plugin that goes further than the built-in "Find Available PDF" to attach full text to your library items.

## Installation

1. Download `better-find-full-text.xpi` from the [latest release](https://github.com/ppavlidis/better-find-full-text/releases/latest)
2. In Zotero: **Tools → Add-ons → gear icon → Install Add-on From File**
3. Select the downloaded `.xpi` file and restart Zotero

## Usage

Select one or more items in your library and right-click. Three menu entries are added:

- **Better Find Full Text** — runs the normal fetch flow
- **Better Find Full Text (force retry)** — deletes known-bad snapshots first, then re-runs (see below)
- **Cancel Better Find Full Text** — interrupts a running batch between items

A non-blocking progress window shows what's happening. When the batch finishes you'll see a summary like `Done: 2 PDFs, 1 snapshot, 1 opened in browser`.

## What it does

For each selected item, the plugin works through a series of strategies in order, stopping as soon as one succeeds:

### 1. Zotero built-in finder
Runs the same lookup as Zotero's built-in "Find Available PDF": tries DOI resolution, Unpaywall (open-access PDFs), the item's URL field, and any custom resolvers you've configured in Zotero preferences. If this succeeds, you get a PDF silently with no further steps.

### 2. Direct PDF check
Fetches the article page and checks whether `citation_pdf_url` — a metadata tag that publishers embed in every article page — resolves to an actual PDF. If you have institutional access (e.g. via a university proxy configured in your browser or Zotero), the PDF downloads automatically. If the URL exists but isn't serving a PDF, the plugin knows the article is paywalled and moves to the next step.

### 3. Paywall handling + Connector workflow
When an article is paywalled, the plugin:

1. Opens the article page in your browser (using the canonical DOI URL so the browser follows the publisher's redirect chain with its own cookies)
2. Shows a non-blocking notification in Zotero: *"N paywalled items opened in browser. If needed, complete your institutional or publisher login, then click the Zotero Connector to save the PDF."*

In your browser, complete any required login (institutional proxy, publisher account, etc.) so you can see the full article, then click the **Zotero Connector** button. This normally creates a duplicate record in Zotero — but the plugin detects it automatically and merges it:

- Attachments (PDF, snapshot) are moved to your existing item
- The duplicate record is silently deleted
- A brief "Merged: 1 attachment added to existing item" notification confirms it worked

You don't need to do anything in Zotero — just click the Connector and the duplicate disappears.

### 4. Web snapshots
For items that aren't journal articles (web pages, blog posts, reports, etc.) and for journal articles where the full article page is actually accessible, the plugin saves a web snapshot. This captures the page content locally in Zotero for offline reading and searching.

The plugin avoids saving useless snapshots — abstract-only pages (LWW `/abstract/`, PubMed, Oxford `/article-abstract/`), JavaScript-rendered shells, and Cloudflare bot-challenge pages are all detected and routed to the browser instead.

### 5. Patents
For patent items:
- **US patents**: attempts a direct PDF download from the USPTO image server
- **All patents**: falls back to a Google Patents snapshot

## Force retry

Use **Better Find Full Text (force retry)** when the normal entry won't make progress on an item. Force does two things the normal entry doesn't:

1. **Clobbers obviously-bad snapshots.** HTML attachments whose URL matches a known abstract-only pattern (LWW `/abstract/`, PubMed, Oxford `/article-abstract/`) or whose content is a Cloudflare challenge page get deleted before the fetch runs. PDFs, user-uploaded files, linked attachments, and real full-text snapshots are left alone.

2. **Bypasses the "already has PDF" skip.** Normally the plugin skips items that already have any valid PDF attached. That's usually correct, but sometimes a non-article PDF is present (supplementary materials, a different chapter, a cover page) and you still want the main article PDF. Force tries anyway.

After the cleanup pass and skip-bypass, the normal fetch flow runs. This can end up adding a second PDF if the item already had one — force is explicit opt-in for that trade-off.

## Cancelling a batch

For long batches, use **Cancel Better Find Full Text** from the context menu. The currently-running item finishes its in-flight work (HTTP request, snapshot verification, etc. — typically a few seconds to ~30s) and then the loop exits. The summary will read `Cancelled at N/M: ...` so you can see where it stopped.

## What to expect

| Item type | Has DOI / URL? | Likely outcome |
|---|---|---|
| Journal article (OA or institutional access) | DOI | PDF downloaded automatically |
| Journal article (paywalled, no access) | DOI | Opened in browser; use Connector to add PDF |
| Journal article (paywalled, you have access) | DOI | Opened in browser; log in, click Connector; PDF auto-merged |
| Web page, report, blog post | URL | Web snapshot saved |
| US patent | Patent number | PDF from USPTO, or Google Patents snapshot |
| Other patent | Patent number | Google Patents snapshot |
| Item with no DOI and no URL | — | Skipped |

## Tips

- **Institutional proxy**: if your university uses a browser-based proxy (e.g. EZproxy), make sure you're logged in before clicking the Connector. The plugin opens the publisher page in your browser, so the proxy needs to be active there.
- **Multiple items**: select as many items as you want. The plugin processes them all, opens all paywalled articles in the browser at once, and shows one combined notification.
- **Existing PDFs**: items that already have a real PDF on disk are skipped automatically. Force retry does not override this — it only cleans up bad snapshots.

## Limitations

Getting full text reliably is an intrinsically hard problem. The plugin does what it can but some items will still fail, usually for one of these reasons:

- **No access**: the article is behind a paywall and neither you nor Unpaywall has a legal route to the PDF. The plugin routes these to the browser via the Connector workflow, but you have to have (or buy, or interlibrary-loan) access.
- **Publisher anti-bot measures**: some publishers (ScienceDirect/Elsevier is notable) serve Cloudflare challenges to Zotero's hidden browser. The plugin detects these and opens the item in your real browser instead, but completing the Connector workflow is then up to you.
- **Metadata gaps**: items without a DOI and without a URL are skipped — the plugin has nowhere to start.
- **Dynamic-rendering sites**: sites that require JavaScript to show content (PubMed, some publisher pages) can't be snapshotted usefully. The plugin recognizes these and routes to the browser.
- **Unusual publishers**: we only know about paywall patterns we've seen. If the plugin saves something useless on a publisher it doesn't recognize, open an issue with the item's DOI and the plugin can be taught the new pattern.

Think of the plugin as a force multiplier for the normal Zotero + Connector workflow, not a guaranteed-success tool. It converts the common cases into one click, and routes the hard cases to a workflow that's one click away from success when you have access.

## Requirements

- Zotero 7.0, 8.x, or 9.x
- [Zotero Connector](https://www.zotero.org/download/connectors) browser extension (for the paywall workflow)
