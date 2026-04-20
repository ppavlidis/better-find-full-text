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
