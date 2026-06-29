var BetterFindFullText;

function log(msg) {
	Zotero.debug("Better Find Full Text: " + msg);
}

function install() {
	log("Installed");
}

async function startup({ id, version, rootURI }) {
	log("Starting");
	Services.scriptloader.loadSubScript(rootURI + "better-find-full-text.js");
	BetterFindFullText.init({ id, version, rootURI });
	BetterFindFullText.addToAllWindows();

	// Register the settings pane (Zotero → Settings → Better Find Full Text).
	Zotero.PreferencePanes.register({
		pluginID: id,
		src: rootURI + "content/preferences.xhtml",
		label: "Better Find Full Text",
		image: rootURI + "content/icons/favicon.svg",
	});
}

function onMainWindowLoad({ window }) {
	BetterFindFullText.addToWindow(window);
}

function onMainWindowUnload({ window }) {
	BetterFindFullText.removeFromWindow(window);
}

function shutdown() {
	log("Shutting down");
	BetterFindFullText.removeFromAllWindows();
	BetterFindFullText.destroy();
	BetterFindFullText = undefined;
}

function uninstall() {
	log("Uninstalled");
}
