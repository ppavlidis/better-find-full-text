// Better Find Full Text — two complementary features:
//
// ── Fetch (right-click / Tools menu) ─────────────────────────────────────────
//
//   For selected items, in order:
//   1. Zotero built-in  — addAvailableFile(), same as "Find Available PDF".
//   2. Patent fallback  — USPTO direct PDF (US), then Google Patents snapshot.
//   3. Journal fallback — Fetch the page, parse citation_pdf_url, check for
//                         paywall markers. If paywalled: open in Chrome, show
//                         a prompt asking the user to use the Connector button
//                         (the duplicate will be auto-merged — see below).
//   4. Generic fallback — Probe URL/DOI, import PDF if served directly,
//                         otherwise snapshot.
//
// ── Auto-merge duplicates ─────────────────────────────────────────────────────
//
//   Watches for newly-added items. When the Zotero Connector saves an item
//   that already exists in the library (matched by DOI), the plugin waits up
//   to 30 s for the Connector to finish attaching files, then silently moves
//   any new PDF/snapshot attachments to the existing item and deletes the
//   duplicate. A brief progress-window notification confirms the merge.

var BetterFindFullText = {

	PREFS_PREFIX: "extensions.better-find-full-text.",

	PATENT_TYPES:  new Set(["patent"]),

	// For these types, if the built-in finder fails we assume a paywall and
	// prompt the user immediately rather than trying a blind snapshot.
	JOURNAL_TYPES: new Set(["journalArticle", "preprint", "conferencePaper"]),

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	id: null,
	version: null,
	rootURI: null,
	_windows: new Map(),

	// Auto-merge state
	_pendingMerges: new Map(),   // duplicateItemId → { canonicalId, timer }
	_recentlyAdded: new Map(),   // itemId → timestamp (items added in last 2 min)
	_notifierID: null,

	// Batch state — used to let the user cancel a running batch via the
	// context menu. A batch runs inside _onMenuCommand's for-loop and checks
	// _cancelRequested between items.
	_running: false,
	_cancelRequested: false,

	init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		this._registerNotifier();
	},

	destroy() {
		this._unregisterNotifier();
		for (const { timer } of this._pendingMerges.values()) {
			clearTimeout(timer);
		}
		this._pendingMerges.clear();
		this._recentlyAdded.clear();
	},

	addToAllWindows() {
		for (const win of Zotero.getMainWindows()) {
			if (!win.closed) this.addToWindow(win);
		}
	},

	removeFromAllWindows() {
		for (const win of Zotero.getMainWindows()) {
			this.removeFromWindow(win);
		}
	},

	addToWindow(window) {
		if (this._windows.has(window)) return;
		const data = { addedElementIDs: [], listeners: [] };
		this._windows.set(window, data);
		this._addContextMenuItem(window, data);
	},

	removeFromWindow(window) {
		const data = this._windows.get(window);
		if (!data) return;
		const doc = window.document;
		for (const { el, type, fn } of data.listeners) {
			el.removeEventListener(type, fn);
		}
		for (const id of data.addedElementIDs) {
			doc.getElementById(id)?.remove();
		}
		this._windows.delete(window);
	},

	// ── Context menu ──────────────────────────────────────────────────────────

	_addContextMenuItem(window, data) {
		const doc = window.document;
		const menu = doc.getElementById("zotero-itemmenu");
		if (!menu) return;
		const self = this;

		const sep = doc.createXULElement("menuseparator");
		sep.id = "bfft-sep";
		menu.appendChild(sep);
		data.addedElementIDs.push("bfft-sep");

		// Normal entry.
		const item = doc.createXULElement("menuitem");
		item.id = "bfft-menuitem";
		item.setAttribute("label", "Better Find Full Text");
		const handler = () => self._onMenuCommand(window, { force: false });
		item.addEventListener("command", handler);
		data.listeners.push({ el: item, type: "command", fn: handler });
		menu.appendChild(item);
		data.addedElementIDs.push("bfft-menuitem");

		// Force-retry entry: deletes obviously-bad snapshots first, then re-runs.
		// "Obviously-bad" means HTML attachments the plugin itself created from
		// paywall-redirect URLs (LWW /abstract/, PubMed, etc.). Real PDFs and any
		// non-matching attachments are left alone.
		const forceItem = doc.createXULElement("menuitem");
		forceItem.id = "bfft-menuitem-force";
		forceItem.setAttribute("label", "Better Find Full Text (force retry)");
		const forceHandler = () => self._onMenuCommand(window, { force: true });
		forceItem.addEventListener("command", forceHandler);
		data.listeners.push({ el: forceItem, type: "command", fn: forceHandler });
		menu.appendChild(forceItem);
		data.addedElementIDs.push("bfft-menuitem-force");

		// Cancel entry: flips the cancel flag, which the batch loop checks
		// between items. No-op when no batch is running.
		const cancelItem = doc.createXULElement("menuitem");
		cancelItem.id = "bfft-menuitem-cancel";
		cancelItem.setAttribute("label", "Cancel Better Find Full Text");
		const cancelHandler = () => self._requestCancel();
		cancelItem.addEventListener("command", cancelHandler);
		data.listeners.push({ el: cancelItem, type: "command", fn: cancelHandler });
		menu.appendChild(cancelItem);
		data.addedElementIDs.push("bfft-menuitem-cancel");
	},

	_requestCancel() {
		if (!this._running) {
			log("Cancel requested but no batch is running");
			return;
		}
		log("Cancel requested by user");
		this._cancelRequested = true;
	},

	// Clip long item titles so the ProgressWindow doesn't stretch wide enough
	// to fall off-screen. Zotero positions the window in a fixed corner but
	// its width is driven by the content — a 200-char title makes it unusable.
	_trimTitle(s, max = 70) {
		if (!s) return "";
		return s.length <= max ? s : s.slice(0, max - 1) + "…";
	},

	// ── Command handler ───────────────────────────────────────────────────────

	async _onMenuCommand(window, { force = false } = {}) {
		const items = window.ZoteroPane.getSelectedItems()
			.filter(it => !it.isAttachment() && !it.isNote());

		if (!items.length) return;

		if (this._running) {
			log("A batch is already running — ignoring second invocation");
			return;
		}
		this._running = true;
		this._cancelRequested = false;

		const pw = new Zotero.ProgressWindow({ closeOnClick: true });
		pw.changeHeadline(
			`Better Find Full Text${force ? " (force)" : ""}: processing ${items.length} item(s)…`
		);
		pw.show();

		let nPdf = 0, nSnapshot = 0, nSkipped = 0, nFailed = 0, nClobbered = 0;
		let cancelled = false, processed = 0;
		const paywalled = []; // { item, url } — collected for one combined prompt

		try {
		for (let i = 0; i < items.length; i++) {
			if (this._cancelRequested) {
				cancelled = true;
				break;
			}
			const item = items[i];
			pw.changeHeadline(
				`[${i + 1}/${items.length}] ${this._trimTitle(item.getDisplayTitle())}`
			);
			try {
				if (force) {
					nClobbered += await this._clobberBadSnapshots(item);
				}
				const result = await this._fetchItem(item, paywalled, { force });
				if      (result === "pdf")      nPdf++;
				else if (result === "snapshot") nSnapshot++;
				else if (result === "paywall")  {} // handled below
				else                            nSkipped++;
				processed++;
				log(`${result}: "${item.getDisplayTitle()}"`);
			} catch (e) {
				nFailed++;
				processed++;
				log(`Failed for "${item.getDisplayTitle()}": ${e}`);
			}
		}
		} finally {
			this._running = false;
			this._cancelRequested = false;
		}

		// Open all paywalled URLs in the browser and show a persistent (non-modal,
		// non-blocking) progress window. It stays until the user dismisses it so
		// Zotero never steals focus away from the browser.
		if (paywalled.length) {
			for (const { url } of paywalled) Zotero.launchURL(url);
		}

		const parts = [];
		if (nPdf)              parts.push(`${nPdf} PDF${nPdf > 1 ? "s" : ""}`);
		if (nSnapshot)         parts.push(`${nSnapshot} snapshot${nSnapshot > 1 ? "s" : ""}`);
		if (paywalled.length)  parts.push(`${paywalled.length} opened in browser`);
		if (nClobbered)        parts.push(`${nClobbered} bad snapshot${nClobbered > 1 ? "s" : ""} removed`);
		if (nSkipped)          parts.push(`${nSkipped} skipped`);
		if (nFailed)           parts.push(`${nFailed} failed`);

		const headline = cancelled
			? `Cancelled at ${processed}/${items.length}: ${parts.join(", ") || "nothing done"}`
			: `Done: ${parts.join(", ") || "nothing to do"}`;
		pw.changeHeadline(headline);

		if (paywalled.length) {
			const n = paywalled.length;
			pw.addDescription(
				`${n} paywalled item${n > 1 ? "s" : ""} opened in browser.\n` +
				`If needed, complete your institutional or publisher login,\n` +
				`then click the Zotero Connector to save the PDF. Duplicates\n` +
				`will be auto-merged into your existing items.`
			);
		}
		pw.startCloseTimer(paywalled.length ? 12000 : 4000);
	},

	// ── Per-item logic ────────────────────────────────────────────────────────

	// Returns "pdf" | "snapshot" | "skipped" | "paywall"
	// paywalled: array to push { item, url } onto for combined prompt
	// force: bypass the "already has PDF" skip — useful when the existing PDF
	//   is something other than the main article (supplementary materials, a
	//   different chapter, etc.) and the user wants to pull in the full text
	//   alongside it.
	async _fetchItem(item, paywalled, { force = false } = {}) {
		const typeName  = Zotero.ItemTypes.getName(item.itemTypeID);
		const isPatent  = this.PATENT_TYPES.has(typeName);
		const isJournal = this.JOURNAL_TYPES.has(typeName);
		const doi = item.getField("DOI");
		const url = item.getField("url");

		log(`Processing "${item.getDisplayTitle()}" (${typeName}, doi=${doi||"none"}, url=${url||"none"}${force ? ", force" : ""})`);

		// Skip if a real PDF is already on disk, unless force is set. With
		// force we try anyway — if that ends up duplicating an existing PDF,
		// the user opted into that by choosing "force retry".
		if (!force && await this._hasPDF(item)) {
			log(`Already has PDF — skipping`);
			return "skipped";
		}

		// 2. Try Zotero's built-in finder (DOI → Unpaywall → URL → custom resolvers).
		const builtIn = await this._tryBuiltIn(item);
		if (builtIn) return "pdf";

		// 3. Patent-specific fallback.
		if (isPatent) return await this._fetchPatent(item, paywalled);

		// Need at least a URL or DOI to go further.
		const rawUrl = url || (doi ? `https://doi.org/${doi}` : null);
		if (!rawUrl) {
			log(`No URL or DOI — skipping`);
			return "skipped";
		}

		// 4a. Journal articles: fetch the page body and inspect it properly.
		if (isJournal) return await this._fetchJournalArticle(item, paywalled, rawUrl);

		// 4b. Everything else: probe, then try snapshot. Queue for browser if blocked.
		const { resolvedUrl, isPdf, isPaywall } = await this._probeUrl(rawUrl);
		log(`Probe ${rawUrl} → resolved=${resolvedUrl} isPdf=${isPdf} isPaywall=${isPaywall}`);

		if (isPdf) {
			await this._importFile(resolvedUrl, item, "application/pdf");
			return "pdf";
		}

		if (isPaywall) {
			paywalled.push({ item, url: this._browserUrl(item) || resolvedUrl });
			return "paywall";
		}

		try {
			await this._importFile(resolvedUrl, item, "text/html");
			return await this._verifyOrReroute(item, resolvedUrl, paywalled);
		} catch (e) {
			log(`Snapshot import failed (${e}) — queuing for browser`);
			paywalled.push({ item, url: this._browserUrl(item) || resolvedUrl });
			return "paywall";
		}
	},

	// Remove the most recently added attachment (used to clean up a bad import).
	async _removeLastAttachment(item) {
		const ids = item.getAttachments();
		if (!ids.length) return;
		const last = Zotero.Items.get(ids[ids.length - 1]);
		if (last) await last.eraseTx();
	},

	// ── Journal article fetching ─────────────────────────────────────────────
	//
	// Does a real GET to the article page and inspects the HTML body:
	//   1. If the server returns a PDF directly, import it.
	//   2. If the HTML contains a <meta name="citation_pdf_url"> tag, try that
	//      URL — it works automatically when you have institutional proxy access.
	//   3. Check the HTML body for known publisher paywall markers. If found,
	//      open the page in the browser and prompt the user.
	//   4. If none of the above, save the page as a snapshot.

	async _fetchJournalArticle(item, paywalled, rawUrl) {
		let html = "", resolvedUrl = rawUrl;

		try {
			const xhr = await Zotero.HTTP.request("GET", rawUrl, {
				timeout: 20000,
				headers: { Accept: "application/pdf, text/html, */*" },
			});
			resolvedUrl = xhr.responseURL || rawUrl;
			const ct = (xhr.getResponseHeader?.("Content-Type") || "").toLowerCase();

			if (ct.includes("pdf")) {
				log(`Direct PDF response for "${item.getDisplayTitle()}"`);
				await this._importFile(resolvedUrl, item, "application/pdf");
				return "pdf";
			}

			html = xhr.responseText || "";
		} catch (e) {
			log(`GET failed for "${item.getDisplayTitle()}": ${e} — queuing for browser`);
			paywalled.push({ item, url: this._browserUrl(item) || rawUrl });
			return "paywall";
		}

		// URL path tells us a lot. Publishers often redirect paywalled users from
		// the full-text URL to an abstract-only or preview URL. Catching this is
		// more reliable than any HTML body inspection.
		//   LWW (journals.lww.com):    /fulltext/... → /abstract/...
		//   Oxford Academic:           /article/... → /article-abstract/...
		//   NEJM, AMA, and many others follow the same pattern.
		// PubMed is a related case: its URLs are abstract-only by design.
		if (this._isAbstractOnlyUrl(resolvedUrl)) {
			log(`Resolved URL looks abstract-only (${resolvedUrl}) — queuing for browser`);
			paywalled.push({ item, url: this._browserUrl(item) || resolvedUrl });
			return "paywall";
		}

		// citation_pdf_url is the most reliable signal: publishers embed it whenever
		// a PDF exists. HEAD it first — if the server serves PDF we can access it;
		// if it redirects to HTML (login/access page) we know we're paywalled without
		// needing HTML body pattern matching at all.
		const citationPdfUrl = this._extractMetaUrl(html, "citation_pdf_url");
		if (citationPdfUrl) {
			log(`Found citation_pdf_url: ${citationPdfUrl} — checking accessibility`);
			const pdfContentType = await this._headContentType(citationPdfUrl);
			log(`citation_pdf_url HEAD → Content-Type: ${pdfContentType || "(none)"}`);

			if (pdfContentType.includes("pdf")) {
				// Server will serve a real PDF — import it.
				try {
					await this._importFile(citationPdfUrl, item, "application/pdf");
					log(`citation_pdf_url import succeeded`);
					return "pdf";
				} catch (e) {
					log(`citation_pdf_url import failed despite PDF content-type: ${e}`);
					// Fall through to paywall prompt — something is blocking us.
				}
			}

			// citation_pdf_url exists but isn't serving a PDF — this is a paywall.
			// Don't bother with HTML body pattern matching; queue for browser.
			log(`citation_pdf_url not serving PDF — article is paywalled, queuing for browser`);
			paywalled.push({ item, url: this._browserUrl(item) || resolvedUrl });
			return "paywall";
		}

		// No citation_pdf_url at all. Check body for paywall markers.
		const citationHtmlUrl = this._extractMetaUrl(html, "citation_fulltext_html_url");

		// Cheap pre-snapshot check: if our HTTP.request itself got a bot
		// challenge, there's no point trying to snapshot — the hidden browser
		// will get one too (and probably a worse one, since it's a full render).
		if (this._isBotChallenge(html)) {
			log(`Bot challenge detected in initial HTML — queuing for browser`);
			paywalled.push({ item, url: this._browserUrl(item) || resolvedUrl });
			return "paywall";
		}

		if (this._isPaywalledHtml(html)) {
			log(`Paywall markers found in HTML for "${item.getDisplayTitle()}" — queuing for browser`);
			paywalled.push({ item, url: this._browserUrl(item) || resolvedUrl });
			return "paywall";
		}

		// Before snapshotting, make sure the page actually has content to save.
		// Many modern publisher pages (LWW/journals.lww.com, etc.) and SPAs like
		// PubMed hydrate their content via JavaScript. Zotero.HTTP.request returns
		// raw HTML with no JS execution, so a snapshot of that would be an empty
		// shell — cookie banner, nav chrome, and not much else. Treat those as
		// unrenderable and route to the browser where the Connector can do the job.
		if (!this._hasSubstantialContent(html, citationHtmlUrl)) {
			log(`HTML appears to be a JS-rendered shell — queuing for browser`);
			paywalled.push({ item, url: this._browserUrl(item) || resolvedUrl });
			return "paywall";
		}

		// Positive signals — server-rendered full text. Save a snapshot.
		const saveUrl = citationHtmlUrl || resolvedUrl;
		log(`No paywall — saving snapshot of ${saveUrl}`);
		await this._importFile(saveUrl, item, "text/html");
		// The hidden-browser snapshot pass is a separate UA hit that can draw
		// its own Cloudflare challenge even when the initial fetch didn't.
		// Verify the stored file and reroute if it's a challenge page.
		return await this._verifyOrReroute(item, resolvedUrl, paywalled);
	},

	// Returns true if the raw HTML is likely to produce a useful snapshot.
	//
	// Strong positive: publisher provides citation_fulltext_html_url, which is
	// the Highwire/Google Scholar signal for "there is a full HTML version of
	// this article." OA publishers like PLOS, eLife, BMC, and Frontiers set it.
	//
	// Otherwise: look at the amount of real text content. Strip scripts/styles
	// and tags, collapse whitespace, count chars. A proper article body easily
	// runs into the tens of thousands of chars, while JS-rendered shells (the
	// raw HTML of a React SPA like PubMed, or a cookie-gated LWW page) typically
	// have a few hundred to a couple thousand chars of visible text.
	// Delete HTML snapshots that look like paywall leftovers. Used by the
	// "force retry" menu entry to clean up stale attachments saved before the
	// URL-pattern paywall detection was added.
	//
	// Safety: only touches attachments that are (a) HTML, (b) imported_url
	// (i.e., the plugin fetched and stored them), and (c) have a URL matching
	// our abstract-only patterns. This avoids clobbering:
	//   - PDFs (wrong contentType)
	//   - User-uploaded files (linkMode = imported_file)
	//   - Linked URLs or linked files (not imported_url)
	//   - Connector-saved snapshots of real full-text pages (URL won't match)
	async _clobberBadSnapshots(item) {
		// Zotero.Attachments.LINK_MODE_* constants are sometimes undefined in
		// plugin scope; fall back to the raw integer (1 = IMPORTED_URL in the
		// schema). Using ?? so we still prefer the constant when available.
		const IMPORTED_URL = Zotero.Attachments.LINK_MODE_IMPORTED_URL ?? 1;

		let clobbered = 0;
		for (const id of item.getAttachments()) {
			const att = Zotero.Items.get(id);
			if (!att) continue;
			if (att.attachmentContentType !== "text/html") continue;
			if (att.attachmentLinkMode !== IMPORTED_URL) continue;

			const url = att.getField("url") || "";
			let reason = null;
			if (this._isAbstractOnlyUrl(url)) {
				reason = `abstract-only URL: ${url}`;
			} else if (await this._attachmentIsBotChallenge(att)) {
				reason = `bot-challenge page`;
			}
			if (!reason) continue;

			log(`Force: clobbering bad snapshot ${id} (${reason})`);
			try {
				await att.eraseTx();
				clobbered++;
			} catch (e) {
				log(`Failed to clobber snapshot ${id}: ${e}`);
			}
		}
		return clobbered;
	},

	async _attachmentIsBotChallenge(att) {
		const path = att.getFilePath();
		if (!path) return false;
		try {
			const bytes = await IOUtils.read(path, { maxReadSize: 100000 });
			const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
			return this._isBotChallenge(text);
		} catch (e) {
			log(`Could not read attachment ${att.id}: ${e}`);
			return false;
		}
	},

	// Returns true if HTML is a Cloudflare (or similar) bot-challenge page.
	// These pages are what Zotero's hidden browser receives when a publisher
	// site fingerprints the "Zotero/9.0" UA as a bot. If we save the snapshot
	// without checking, the user opens the item later and gets a captcha.
	//
	// Markers are deliberately specific — they should appear only in challenge
	// pages, never in real article HTML (even articles *about* Cloudflare
	// wouldn't typically include these exact tokens in their body).
	_isBotChallenge(html) {
		if (!html) return false;
		const markers = [
			/challenges\.cloudflare\.com/i,
			/cdn-cgi\/challenge-platform/i,
			/__cf_chl_/i,
			/cf-browser-verification/i,
			/cf-chl-widget/i,
			/<title>\s*Just a moment/i,
			/<title>\s*Attention Required/i,
		];
		return markers.some(re => re.test(html));
	},

	// Read the snapshot file the plugin just saved (via HiddenBrowser.snapshot)
	// and check if it's actually a challenge page. If so, delete it and route
	// to the browser. This handles the case where Zotero.HTTP.request got real
	// HTML but the hidden-browser snapshot pass was challenged separately.
	async _verifyOrReroute(item, resolvedUrl, paywalled) {
		const ids = item.getAttachments();
		if (!ids.length) return "snapshot";
		const last = Zotero.Items.get(ids[ids.length - 1]);
		if (!last) return "snapshot";
		if (last.attachmentContentType !== "text/html") return "snapshot";

		const path = last.getFilePath();
		if (!path) return "snapshot";

		try {
			// Read the first ~100KB — plenty to find the markers at the top of
			// the document without slurping the whole file.
			const bytes = await IOUtils.read(path, { maxReadSize: 100000 });
			const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
			if (this._isBotChallenge(text)) {
				log(`Saved snapshot is a bot-challenge page — removing and queuing for browser`);
				await last.eraseTx();
				paywalled.push({ item, url: this._browserUrl(item) || resolvedUrl });
				return "paywall";
			}
		} catch (e) {
			log(`Could not verify snapshot for challenge: ${e}`);
		}
		return "snapshot";
	},

	// URL to hand to the browser when we can't fetch content ourselves.
	//
	// Always prefer the DOI when we have one. Zotero's HTTP stack has its own
	// cookie jar separate from the browser's, so the URL it lands on after
	// following redirects may be a state-specific page — e.g. Wiley's
	// /action/cookieAbsent — that loads a "Cookies disabled" error when opened
	// in the browser. Handing the browser the canonical doi.org URL instead
	// lets it run the full redirect chain with its own cookies, which works.
	_browserUrl(item) {
		const doi = (item.getField("DOI") || "").trim()
			.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
		if (doi) return `https://doi.org/${doi}`;
		return item.getField("url") || null;
	},

	// Returns true if the URL path indicates the page is an abstract-only /
	// preview stub. Pubmed URLs qualify outright (only abstracts, no full text).
	// For other publishers, a final URL containing "/abstract" (but not
	// "/article-abstract-figures" etc. — keep it strict) is the key tell.
	_isAbstractOnlyUrl(url) {
		if (!url) return false;
		// PubMed — the entire site is abstracts
		if (/\bpubmed\.ncbi\.nlm\.nih\.gov\b/i.test(url)) return true;
		// LWW/Wolters Kluwer: /pain/abstract/..., /ajcn/abstract/..., etc.
		if (/\/abstract\/\d/i.test(url)) return true;
		// Oxford Academic (when logged out)
		if (/\/article-abstract\//i.test(url)) return true;
		return false;
	},

	_hasSubstantialContent(html, citationHtmlUrl) {
		if (citationHtmlUrl) return true;

		const text = html
			.replace(/<script[\s\S]*?<\/script>/gi, "")
			.replace(/<style[\s\S]*?<\/style>/gi, "")
			.replace(/<!--[\s\S]*?-->/g, "")
			.replace(/<[^>]+>/g, " ")
			.replace(/&nbsp;/gi, " ")
			.replace(/\s+/g, " ")
			.trim();

		log(`HTML text length (stripped): ${text.length} chars`);
		return text.length >= 3000;
	},

	// Issue a HEAD request and return the Content-Type header value (lowercased),
	// or an empty string on failure. Follows redirects.
	async _headContentType(url) {
		try {
			const xhr = await Zotero.HTTP.request("HEAD", url, {
				timeout: 12000,
				headers: { Accept: "application/pdf, text/html, */*" },
			});
			return (xhr.getResponseHeader?.("Content-Type") || "").toLowerCase();
		} catch (e) {
			log(`HEAD failed for ${url}: ${e}`);
			return "";
		}
	},

	// Extract a URL from a <meta name="..." content="..."> tag.
	_extractMetaUrl(html, name) {
		const re = new RegExp(
			`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']` +
			`|<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`,
			"i"
		);
		const m = html.match(re);
		return m ? (m[1] || m[2]).trim() : null;
	},

	// Returns true if the HTML body contains known publisher paywall markers.
	// Uses specific, low-false-positive patterns rather than generic keywords.
	_isPaywalledHtml(html) {
		const checks = [
			// Generic paywall CSS classes and data attributes
			/class="[^"]*\b(paywall|access-denied|access-required|access-wall|purchase-access|gated-content)\b/i,
			/id="[^"]*\b(paywall|access-denied|purchase-access)\b/i,
			/data-(paywall|access-required|locked)=/i,

			// Springer / Nature / BioMed Central
			/data-test="(access-via-institution|abstract-actions-restricted|access-denied-container|buybox__buy)"/i,
			/class="[^"]*\bc-article-access-provider\b/i,

			// Elsevier / ScienceDirect
			/class="[^"]*\bu-accessBadge\b/i,
			/class="[^"]*\bpdf-download-restrictions\b/i,
			/"paymentRequired"\s*:\s*true/,

			// Wiley
			/class="[^"]*\barticle-access-restricted\b/i,
			/class="[^"]*\bpdf-restricted\b/i,

			// Taylor & Francis
			/class="[^"]*\baccess__options\b/i,

			// SAGE
			/class="[^"]*\baccess-info__text\b/i,

			// American Chemical Society
			/class="[^"]*\bhardbounce\b/i,

			// Oxford Academic
			/class="[^"]*\barticle-top-info-group--locked\b/i,

			// BMJ
			/class="[^"]*\barticle-figures-only__message\b/i,

			// LWW / Wolters Kluwer: distinctive markers on paywalled abstract pages
			/CAPrivacyPolicy\.png/i,                   // "Do Not Sell My Info" button
			/href="[^"]*BuyPPV[^"]*"/i,                // pay-per-view buy link
			/class="[^"]*\bbtn-buy-article\b/i,
			/class="[^"]*\bfull-access\b/i,            // "Full Access" prompt on abstract-only page

			// Generic purchase CTAs inside buttons/links — specific enough to
			// avoid matching text in article bodies
			/class="[^"]*\bbtn[^"]*"[^>]*>\s*(Purchase|Buy|Get Access)\s+(Access|Article|PDF|Now)/i,
			/\bBuy (?:Access|Article|Now|PDF|this Article)\b/i,
		];
		return checks.some(re => re.test(html));
	},

	// ── Zotero built-in ───────────────────────────────────────────────────────

	async _tryBuiltIn(item) {
		try {
			const result = await Zotero.Attachments.addAvailableFile(item);
			if (result) {
				log(`Built-in found a file for "${item.getDisplayTitle()}"`);
				return true;
			}
			log(`Built-in found nothing for "${item.getDisplayTitle()}"`);
		} catch (e) {
			log(`Built-in threw for "${item.getDisplayTitle()}": ${e}`);
		}
		return false;
	},

	// ── Patent fetching ───────────────────────────────────────────────────────

	async _fetchPatent(item, paywalled) {
		const country   = (item.getField("country")      || "").trim().toUpperCase();
		const rawNumber = (item.getField("patentNumber")  || "").trim();

		// US patents: try the USPTO image server for a direct PDF.
		if (country === "US" && rawNumber) {
			const digits = rawNumber.replace(/[^0-9]/g, "");
			if (digits) {
				const usptoUrl = `https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/${digits}`;
				try {
					await this._importFile(usptoUrl, item, "application/pdf");
					return "pdf";
				} catch (e) {
					log(`USPTO PDF failed for ${rawNumber}: ${e}`);
				}
			}
		}

		// Fall back to Google Patents snapshot (all jurisdictions).
		const rawUrl = this._buildGooglePatentsUrl(item) || item.getField("url");
		if (!rawUrl) return "skipped";

		const { resolvedUrl, isPaywall } = await this._probeUrl(rawUrl);
		if (isPaywall) {
			// Patents don't have DOIs; rawUrl is the Google Patents URL, which
			// is fine to hand the browser directly.
			paywalled.push({ item, url: rawUrl });
			return "paywall";
		}
		await this._importFile(resolvedUrl, item, "text/html");
		return "snapshot";
	},

	_buildGooglePatentsUrl(item) {
		const country   = (item.getField("country")     || "").trim().toUpperCase();
		const rawNumber = (item.getField("patentNumber") || "").trim();
		if (!rawNumber) return null;
		const cleaned = rawNumber.replace(/[,\s]/g, "");
		if (/^[A-Z]{2,3}\d/.test(cleaned)) return `https://patents.google.com/patent/${cleaned}`;
		if (!country) return null;
		return `https://patents.google.com/patent/${country}${cleaned}`;
	},

	// ── URL probing ───────────────────────────────────────────────────────────
	//
	// Issues a HEAD request (falls back to GET) to follow redirects and detect
	// content-type and paywall patterns.
	//
	// Returns { resolvedUrl, isPdf, isPaywall }.

	async _probeUrl(url) {
		let resolvedUrl = url;
		let contentType = "";
		let status = 0;

		for (const method of ["HEAD", "GET"]) {
			try {
				const xhr = await Zotero.HTTP.request(method, url, {
					timeout: 15000,
					headers: { Accept: "application/pdf, text/html, */*" },
				});
				resolvedUrl = xhr.responseURL || url;
				contentType = (xhr.getResponseHeader?.("Content-Type") || "").toLowerCase();
				status = xhr.status;
				break;
			} catch (e) {
				if (method === "HEAD") {
					log(`HEAD failed for ${url}, retrying with GET: ${e}`);
					continue;
				}
				log(`Probe failed for ${url}: ${e}`);
			}
		}

		const isPdf = contentType.includes("pdf");
		const isPaywall = !isPdf && (
			status === 401 || status === 403 ||
			/[/?&](login|signin|sign-in|sso|auth|captcha)\b/i.test(resolvedUrl)
		);

		return { resolvedUrl, isPdf, isPaywall };
	},


	// ── Attachment presence check ─────────────────────────────────────────────

	async _hasPDF(item) {
		for (const id of item.getAttachments()) {
			const att = Zotero.Items.get(id);
			if (!att || att.attachmentContentType !== "application/pdf") continue;
			try {
				const path = att.getFilePath();
				if (!path || !(await IOUtils.exists(path))) continue;
				// Verify magic bytes — importFromURL can save HTML with content-type
				// "application/pdf" when a publisher redirects to a login page.
				const bytes = await IOUtils.read(path, { maxReadSize: 5 });
				// %PDF-
				if (bytes[0] === 0x25 && bytes[1] === 0x50 &&
				    bytes[2] === 0x44 && bytes[3] === 0x46) {
					log(`Real PDF confirmed at ${path}`);
					return true;
				}
				log(`File at ${path} has application/pdf content-type but is not a PDF — ignoring`);
			} catch (e) {
				log(`PDF check error for attachment ${att.id}: ${e}`);
			}
		}
		return false;
	},

	// ── Import ────────────────────────────────────────────────────────────────

	async _importFile(url, item, contentType) {
		await Zotero.Attachments.importFromURL({
			url,
			parentItemID: item.id,
			title: item.getField("title") || "Attachment",
			contentType,
		});
	},

	// ── Auto-merge duplicates ─────────────────────────────────────────────────
	//
	// When the Zotero Connector saves an item that already exists in the library
	// (same DOI), we wait up to 30 s for the Connector to finish attaching files,
	// then move those attachments to the existing item and delete the duplicate.

	_registerNotifier() {
		const self = this;
		this._notifierID = Zotero.Notifier.registerObserver(
			{
				notify(event, type, ids) {
					if (type !== "item") return;
					const fn =
						event === "add"    ? () => self._onItemsAdded(ids) :
						event === "modify" ? () => self._onItemsModified(ids) :
						null;
					if (fn) fn().catch(e =>
						Zotero.debug(`Better Find Full Text: notifier error: ${e}`)
					);
				},
			},
			["item"],
			"bfft-merge"
		);
		log("Notifier registered");
	},

	_unregisterNotifier() {
		if (this._notifierID) {
			Zotero.Notifier.unregisterObserver(this._notifierID);
			this._notifierID = null;
		}
	},

	// Called when any items are added. Two cases:
	//   A) New regular item — track it; check for duplicate DOI immediately
	//      (DOI may already be set if Connector sent complete metadata).
	//   B) New attachment whose parent is already a known pending duplicate —
	//      shorten the merge timer so we act as soon as the PDF lands.
	async _onItemsAdded(ids) {
		for (const id of ids) {
			const item = Zotero.Items.get(id);
			if (!item) continue;

			// Case B: attachment added to a tracked duplicate.
			if (item.isAttachment()) {
				const parentId = item.parentID;
				if (parentId && this._pendingMerges.has(parentId)) {
					log(`Attachment ${id} added to pending duplicate ${parentId} — accelerating merge`);
					this._rescheduleMerge(parentId, 5000);
				}
				continue;
			}

			if (!item.isRegularItem()) continue;

			// Case A: track new regular items; DOI may arrive later via modify event.
			this._recentlyAdded.set(id, Date.now());
			this._pruneRecentlyAdded();
			await this._checkForDuplicate(id);
		}
	},

	// Called when items are modified. If a recently-added item just got its DOI
	// set (the Connector fills metadata after the initial add), check for a duplicate.
	async _onItemsModified(ids) {
		for (const id of ids) {
			if (!this._recentlyAdded.has(id)) continue;
			if (this._pendingMerges.has(id)) continue; // already scheduled
			await this._checkForDuplicate(id);
		}
	},

	async _checkForDuplicate(id) {
		const item = Zotero.Items.get(id);
		if (!item?.isRegularItem()) return;

		const doi = this._normalizeDOI(item.getField("DOI"));
		if (!doi) {
			log(`Item ${id} has no DOI yet — will recheck on modify`);
			return;
		}

		const canonical = await this._findCanonicalByDOI(item, doi);
		if (!canonical) {
			log(`Item ${id} (DOI: ${doi}) — no pre-existing duplicate found`);
			return;
		}

		log(`Item ${id} is a duplicate of ${canonical.id} (DOI: ${doi}) — scheduling merge`);
		// Give the Connector 30 s to finish downloading attachments.
		// _onItemsAdded will shorten this to 5 s once the attachment arrives.
		const timer = setTimeout(async () => {
			this._pendingMerges.delete(id);
			this._recentlyAdded.delete(id);
			await this._doMerge(id, canonical.id);
		}, 30000);
		this._pendingMerges.set(id, { canonicalId: canonical.id, timer });
	},

	_rescheduleMerge(duplicateId, delayMs) {
		const pending = this._pendingMerges.get(duplicateId);
		if (!pending) return;
		clearTimeout(pending.timer);
		pending.timer = setTimeout(async () => {
			this._pendingMerges.delete(duplicateId);
			this._recentlyAdded.delete(duplicateId);
			await this._doMerge(duplicateId, pending.canonicalId)
				.catch(e => log(`Merge error: ${e}`));
		}, delayMs);
	},

	// Find an existing item in the same library with the same DOI, older than
	// the given item (i.e., not the item itself, not something added at the same
	// time). Returns the oldest match, or null.
	async _findCanonicalByDOI(newItem, doi) {
		try {
			const s = new Zotero.Search();
			s.libraryID = newItem.libraryID;
			s.addCondition("DOI", "is", doi);
			const ids = await s.search();

			const others = ids
				.filter(id => id !== newItem.id)
				.map(id => Zotero.Items.get(id))
				.filter(it => it?.isRegularItem());

			if (!others.length) return null;
			// Prefer the oldest item (lowest id = added earliest).
			others.sort((a, b) => a.id - b.id);
			return others[0];
		} catch (e) {
			log(`DOI search failed: ${e}`);
			return null;
		}
	},

	_normalizeDOI(doi) {
		if (!doi) return null;
		return doi.trim().toLowerCase().replace(/^https?:\/\/doi\.org\//i, "");
	},

	// Drop entries older than 5 minutes from _recentlyAdded to avoid leaks.
	_pruneRecentlyAdded() {
		const cutoff = Date.now() - 5 * 60 * 1000;
		for (const [id, ts] of this._recentlyAdded) {
			if (ts < cutoff) this._recentlyAdded.delete(id);
		}
	},

	async _doMerge(newItemId, canonicalId) {
		const newItem   = Zotero.Items.get(newItemId);
		const canonical = Zotero.Items.get(canonicalId);
		if (!newItem || !canonical) {
			log(`Merge aborted: item(s) no longer exist`);
			return;
		}

		const attIDs = newItem.getAttachments();
		if (!attIDs.length) {
			log(`No attachments on duplicate ${newItemId} — skipping merge`);
			return;
		}

		log(`Merging ${attIDs.length} attachment(s) from duplicate ${newItemId} → ${canonicalId}`);

		let moved = 0;
		for (const attID of attIDs) {
			const att = Zotero.Items.get(attID);
			if (!att) continue;
			try {
				att.parentID = canonicalId;
				await att.saveTx();
				moved++;
			} catch (e) {
				log(`Failed to move attachment ${attID}: ${e}`);
			}
		}

		if (!moved) {
			log(`No attachments could be moved — leaving duplicate intact`);
			return;
		}

		// Delete the now-empty duplicate.
		try {
			await newItem.eraseTx();
			log(`Deleted duplicate item ${newItemId}`);
		} catch (e) {
			log(`Failed to delete duplicate ${newItemId}: ${e}`);
		}

		// Brief notification.
		const pw = new Zotero.ProgressWindow({ closeOnClick: true });
		pw.changeHeadline(
			`Merged: ${moved} attachment${moved > 1 ? "s" : ""} added to existing item`
		);
		pw.addDescription(canonical.getDisplayTitle().substring(0, 80));
		pw.show();
		pw.startCloseTimer(4000);
	},
};
