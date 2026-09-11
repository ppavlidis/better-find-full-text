/* Default preferences. Zotero loads this file from the plugin root at install and
 * registers each pref() call on the default branch.
 *
 * ncbiEmail needs a default even though it is optional and empty. Zotero's
 * preference binding does `elem.value = String(Zotero.Prefs.get(key))`, so a pref
 * with no default reads back as undefined and puts the literal text "undefined" in
 * the text box — which the user would then save and we would send to NCBI. A default
 * of "" makes the field render empty and show its placeholder.
 *
 * itemTimeoutSec is deliberately absent: it is a number input, which silently
 * rejects "undefined" and falls back to empty, and its help text tells the user that
 * blank means the 60-second default. Giving it a default here would prefill 60 and
 * contradict that.
 */
pref("extensions.better-find-full-text.ncbiEmail", "");
