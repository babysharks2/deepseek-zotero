// Zor — bootstrap entry point for Zotero 7/9/10
var Zor;

function log(msg) {
  Zotero.debug("Zor: " + msg);
}

function install() {
  log("Installed");
}

async function startup({ id, version, rootURI }) {
  log(`Starting ${version} from ${rootURI}`);

  const files = ["zor-store.js", "zor-context.js", "zor-api.js", "zor.js"];
  for (const file of files) {
    try {
      Services.scriptloader.loadSubScript(rootURI + file, this);
    }
    catch (e) {
      Zotero.logError(e);
    }
  }

  try {
    await Zor.init({ id, version, rootURI });
  }
  catch (e) {
    Zotero.logError(e);
  }

  try {
    Zotero.Zor = Zor;
    Zor.addToAllWindows();
  }
  catch (e) {
    Zotero.logError(e);
  }
}

function onMainWindowLoad({ window }) {
  try {
    Zor?.addToWindow(window);
  }
  catch (e) {
    Zotero.logError(e);
  }
}

function onMainWindowUnload({ window }) {
  try {
    Zor?.removeFromWindow(window);
  }
  catch (e) {
    Zotero.logError(e);
  }
}

async function shutdown() {
  log("Shutting down");
  try {
    await Zor?.destroy?.();
  }
  catch (e) {
    Zotero.logError(e);
  }
  try {
    delete Zotero.Zor;
  }
  catch (e) {}
  Zor = undefined;
}

function uninstall() {
  log("Uninstalled");
}
