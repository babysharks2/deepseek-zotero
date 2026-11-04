/**
 * Zor — fixed left sidebar chat for Zotero.
 *
 * The UI lives in the main Zotero window, inserted at the far left of
 * #zotero-trees (left of the collections pane), so it stays put while the
 * library, item list and reader keep their own layout.
 */
var Zor = {
  id: null,
  version: null,
  rootURI: null,
  initialized: false,
  windows: new Map(),
  XHTML: "http://www.w3.org/1999/xhtml",
  MIN_WIDTH: 280,
  MAX_WIDTH: 720,

  async init({ id, version, rootURI }) {
    if (this.initialized) {
      return;
    }
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
    await ZorStore.init();
    this._restoreActive();
    this._initWindowWatcher();
    this.initialized = true;
    Zotero.debug(`Zor: initialized ${version}`);
  },

  /**
   * Reader windows (chrome://zotero/content/reader.xhtml) have their own
   * layout and are not part of Zotero.getMainWindows(), so watch the window
   * mediator for them separately.
   */
  _initWindowWatcher() {
    this._wmListener = {
      onOpenWindow: (xulWindow) => {
        const win = xulWindow.docShell.domWindow;
        const onload = () => {
          win.removeEventListener("load", onload, false);
          if (this._isReaderWindow(win)) {
            this.addToReaderWindow(win);
          }
        };
        win.addEventListener("load", onload, false);
      },
      onCloseWindow: (xulWindow) => {
        const win = xulWindow.docShell.domWindow;
        if (this._isReaderWindow(win)) {
          this.removeFromWindow(win);
        }
      }
    };
    try {
      Services.wm.addListener(this._wmListener);
      for (const win of Services.wm.getEnumerator("zotero:reader")) {
        if (!win.document) {
          continue;
        }
        if (win.document.readyState === "complete") {
          this.addToReaderWindow(win);
        }
        else {
          win.addEventListener("load", () => this.addToReaderWindow(win), { once: true });
        }
      }
    }
    catch (e) {
      Zotero.logError(e);
    }
  },

  _isReaderWindow(win) {
    try {
      return win.location.href === "chrome://zotero/content/reader.xhtml";
    }
    catch (e) {
      return false;
    }
  },

  addToReaderWindow(win) {
    if (!win || !win.document || this.windows.has(win)) {
      return;
    }
    const doc = win.document;
    const readerBox = doc.getElementById("zotero-reader");
    if (!readerBox || !readerBox.parentNode) {
      win.addEventListener("load", () => this.addToReaderWindow(win), { once: true });
      return;
    }
    try {
      this._inject(win, doc, readerBox.parentNode);
    }
    catch (e) {
      Zotero.logError(e);
    }
  },

  _restoreActive() {
    if (!ZorStore.activeSession && ZorStore.sessions.length) {
      ZorStore.activeId = ZorStore.sessions[0].id;
    }
  },

  _pref(name, fallback) {
    try {
      const value = Zotero.Prefs.get("extensions.zor." + name, true);
      return value === undefined || value === null ? fallback : value;
    }
    catch (e) {
      return fallback;
    }
  },

  _setPref(name, value) {
    try {
      Zotero.Prefs.set("extensions.zor." + name, value, true);
    }
    catch (e) {
      Zotero.logError(e);
    }
  },

  addToAllWindows() {
    for (const win of Zotero.getMainWindows()) {
      try {
        this.addToWindow(win);
      }
      catch (e) {
        Zotero.logError(e);
      }
    }
  },

  addToWindow(win) {
    if (!win || !win.document || !win.ZoteroPane) {
      return;
    }
    if (this.windows.has(win)) {
      return;
    }
    const doc = win.document;
    // Mount at the top of #browser (outside the tabs deck) so the sidebar stays
    // visible when the user switches to a PDF reader tab or any other tab.
    const mount = doc.getElementById("browser") || doc.getElementById("zotero-trees");
    if (!mount) {
      if (!win.__zorWaitingForLoad) {
        win.__zorWaitingForLoad = true;
        win.addEventListener("load", () => {
          win.__zorWaitingForLoad = false;
          this.addToWindow(win);
        }, { once: true });
      }
      return;
    }

    try {
      this._inject(win, doc, mount);
    }
    catch (e) {
      Zotero.logError(e);
    }
  },

  _linkStylesheet(doc) {
    if (doc.getElementById("zor-stylesheet")) {
      return;
    }
    const link = doc.createElementNS(this.XHTML, "link");
    link.id = "zor-stylesheet";
    link.setAttribute("rel", "stylesheet");
    link.setAttribute("type", "text/css");
    link.setAttribute("href", this.rootURI + "zor.css");
    doc.documentElement.appendChild(link);
  },

  _inject(win, doc, container, before) {
    this._linkStylesheet(doc);

    const sidebar = doc.createElementNS(this.XHTML, "div");
    sidebar.id = "zor-sidebar";
    const width = Math.max(this.MIN_WIDTH, Math.min(this.MAX_WIDTH, parseInt(this._pref("width", 360), 10) || 360));
    sidebar.style.width = width + "px";

    const root = this._el(doc, "div", { id: "zor-root" });
    sidebar.appendChild(root);

    const ctx = {
      win,
      doc,
      container,
      sidebar,
      listeners: [],
      els: {},
      busy: false,
      abort: null,
      stream: null,
      images: [],
      docContext: null,
      closed: false,
      view: "chat"
    };

    this._buildHead(ctx, root);
    this._buildBody(ctx, root);
    this._buildResizer(ctx, sidebar);

    const launcher = this._el(doc, "button", {
      id: "zor-launcher",
      class: "hidden",
      title: "打开 Zor",
      text: "Z"
    });
    launcher.addEventListener("click", () => this.openSidebar(ctx));
    ctx.els.launcher = launcher;

    if (before) {
      container.insertBefore(sidebar, before);
    }
    else {
      container.appendChild(sidebar);
    }
    container.appendChild(launcher);

    this.windows.set(win, ctx);

    this._applyClosed(ctx, this._pref("closed", false) === true);
    this._bindEvents(ctx);
    this.renderAll(ctx);
    this._updateContextChip(ctx);
  },

  _applyClosed(ctx, closed) {
    ctx.closed = !!closed;
    try {
      ctx.sidebar.style.display = closed ? "none" : "";
      if (ctx.els.launcher) {
        ctx.els.launcher.classList.toggle("hidden", !closed);
      }
    }
    catch (e) {
      Zotero.logError(e);
    }
  },

  closeSidebar(ctx) {
    this._setPref("closed", true);
    this._applyClosed(ctx, true);
  },

  openSidebar(ctx) {
    this._setPref("closed", false);
    this._applyClosed(ctx, false);
    this._focusInput(ctx);
  },

  /* ---------------------------------------------------------------- build */

  _el(doc, tag, props, children) {
    const node = doc.createElementNS(this.XHTML, tag);
    if (props) {
      for (const key of Object.keys(props)) {
        const value = props[key];
        if (value === undefined || value === null) {
          continue;
        }
        if (key === "class") {
          node.className = value;
        }
        else if (key === "text") {
          node.textContent = value;
        }
        else if (key === "html") {
          node.innerHTML = value;
        }
        else {
          node.setAttribute(key, value);
        }
      }
    }
    if (children) {
      for (const child of children) {
        if (child) {
          node.appendChild(child);
        }
      }
    }
    return node;
  },

  _buildHead(ctx, root) {
    const doc = ctx.doc;
    const head = this._el(doc, "div", { id: "zor-head" });

    const brand = this._el(doc, "button", { id: "zor-brand", title: "关闭侧栏" });
    brand.appendChild(this._el(doc, "span", { id: "zor-logo", text: "Z" }));
    brand.appendChild(this._el(doc, "span", { id: "zor-title", text: "Zor" }));

    const tabs = this._el(doc, "div", { id: "zor-tabs" });
    const tabEls = {};
    const mkTab = (view, label) => {
      const button = this._el(doc, "button", { class: "zor-tab", "data-view": view, text: label });
      tabEls[view] = button;
      return button;
    };
    tabs.appendChild(mkTab("chat", "对话"));
    tabs.appendChild(mkTab("history", "历史"));
    tabs.appendChild(mkTab("settings", "设置"));

    const close = this._el(doc, "button", {
      id: "zor-close",
      class: "zor-head-btn",
      title: "关闭侧栏（从窗口右侧的 Z 按钮重新打开）",
      text: "×"
    });

    head.appendChild(brand);
    head.appendChild(tabs);
    head.appendChild(close);
    root.appendChild(head);

    ctx.els.head = head;
    ctx.els.brand = brand;
    ctx.els.close = close;
    ctx.els.tabs = tabEls;
  },

  _buildBody(ctx, root) {
    const doc = ctx.doc;
    const body = this._el(doc, "div", { id: "zor-body" });
    root.appendChild(body);
    ctx.els.body = body;

    this._buildChatView(ctx, body);
    this._buildHistoryView(ctx, body);
    this._buildSettingsView(ctx, body);
  },

  _buildChatView(ctx, body) {
    const doc = ctx.doc;
    const view = this._el(doc, "div", { id: "zor-view-chat", class: "zor-view" });

    const contextBar = this._el(doc, "div", { id: "zor-context", class: "zor-context hidden" });
    const messages = this._el(doc, "div", { id: "zor-messages" });
    const composer = this._el(doc, "div", { id: "zor-composer" });

    const input = this._el(doc, "textarea", {
      id: "zor-input",
      rows: "1",
      placeholder: "问点什么…（Enter 发送，Shift+Enter 换行）"
    });

    const toolbar = this._el(doc, "div", { id: "zor-toolbar" });

    const contextWrap = this._el(doc, "label", { class: "zor-check", title: "把当前选中的文献元数据或 PDF 选中文本一起发给模型" });
    const contextCheck = this._el(doc, "input", { type: "checkbox", id: "zor-use-context" });
    contextCheck.checked = this._pref("sendContext", true) !== false;
    contextWrap.appendChild(contextCheck);
    contextWrap.appendChild(this._el(doc, "span", { text: "附上下文" }));

    const status = this._el(doc, "span", { id: "zor-status" });
    const send = this._el(doc, "button", { id: "zor-send", class: "zor-primary", text: "发送" });

    toolbar.appendChild(contextWrap);
    toolbar.appendChild(status);
    toolbar.appendChild(send);

    const imageStrip = this._el(doc, "div", { id: "zor-images", class: "hidden" });
    const fileStrip = this._el(doc, "div", { id: "zor-files", class: "hidden" });

    composer.appendChild(fileStrip);
    composer.appendChild(imageStrip);
    composer.appendChild(input);
    composer.appendChild(toolbar);

    view.appendChild(contextBar);
    view.appendChild(messages);
    view.appendChild(composer);
    body.appendChild(view);

    Object.assign(ctx.els, { viewChat: view, contextBar, messages, input, send, status, imageStrip, fileStrip, composer });
  },

  _buildHistoryView(ctx, body) {
    const doc = ctx.doc;
    const view = this._el(doc, "div", { id: "zor-view-history", class: "zor-view hidden" });

    const head = this._el(doc, "div", { id: "zor-history-head" });
    const newButton = this._el(doc, "button", { id: "zor-new-chat", class: "zor-primary", text: "＋ 新对话" });
    const count = this._el(doc, "span", { id: "zor-history-count", class: "zor-dim" });
    head.appendChild(newButton);
    head.appendChild(count);

    const list = this._el(doc, "div", { id: "zor-history-list" });

    view.appendChild(head);
    view.appendChild(list);
    body.appendChild(view);

    Object.assign(ctx.els, { viewHistory: view, historyList: list, historyCount: count, newChat: newButton });
  },

  _buildSettingsView(ctx, body) {
    const doc = ctx.doc;
    const view = this._el(doc, "div", { id: "zor-view-settings", class: "zor-view hidden" });

    const form = this._el(doc, "div", { id: "zor-settings" });

    const field = (label, control, hint) => {
      const wrap = this._el(doc, "div", { class: "zor-field" });
      wrap.appendChild(this._el(doc, "label", { class: "zor-label", text: label }));
      wrap.appendChild(control);
      if (hint) {
        wrap.appendChild(this._el(doc, "div", { class: "zor-hint", text: hint }));
      }
      return wrap;
    };

    const apiKey = this._el(doc, "input", { type: "password", id: "zor-api-key", autocomplete: "off", spellcheck: "false" });
    const baseURL = this._el(doc, "input", { type: "text", id: "zor-base-url", spellcheck: "false" });
    const model = this._el(doc, "input", { type: "text", id: "zor-model", spellcheck: "false", list: "zor-model-list" });
    const modelList = this._el(doc, "datalist", { id: "zor-model-list" });
    for (const name of ["deepseek-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"]) {
      modelList.appendChild(this._el(doc, "option", { value: name }));
    }

    const temperature = this._el(doc, "input", { type: "range", id: "zor-temperature", min: "0", max: "200", step: "5" });
    const temperatureValue = this._el(doc, "span", { id: "zor-temperature-value", class: "zor-dim" });
    const temperatureRow = this._el(doc, "div", { class: "zor-range-row" }, [temperature, temperatureValue]);

    const systemPrompt = this._el(doc, "textarea", { id: "zor-system-prompt", rows: "4" });

    const actions = this._el(doc, "div", { id: "zor-settings-actions" });
    const save = this._el(doc, "button", { id: "zor-save", class: "zor-primary", text: "保存" });
    const test = this._el(doc, "button", { id: "zor-test", text: "测试连接" });
    const settingsStatus = this._el(doc, "span", { id: "zor-settings-status", class: "zor-dim" });
    actions.appendChild(save);
    actions.appendChild(test);

    const dataInfo = this._el(doc, "div", { id: "zor-data-info" });
    const clear = this._el(doc, "button", { id: "zor-clear-history", class: "zor-danger", text: "清空全部对话" });

    form.appendChild(field("API Key", apiKey, "只保存在本机 Zotero 设置里；留空则无法对话。"));
    form.appendChild(field("接口地址", baseURL, "默认 https://api.deepseek.com/v1，可换成兼容 OpenAI 接口的服务。"));
    form.appendChild(field("模型", model, "识图请用 deepseek-flash；deepseek-v4-pro 适合复杂推理。"));
    form.appendChild(modelList);
    form.appendChild(field("温度", temperatureRow, "0 更严谨，1 更发散。deepseek-reasoner 会忽略该值。"));
    form.appendChild(field("系统提示", systemPrompt));
    form.appendChild(actions);
    form.appendChild(settingsStatus);
    form.appendChild(dataInfo);
    form.appendChild(clear);

    view.appendChild(form);
    body.appendChild(view);

    Object.assign(ctx.els, {
      viewSettings: view, apiKey, baseURL, model, temperature,
      temperatureValue, systemPrompt, settingsStatus, save, test,
      dataInfo, clearHistory: clear
    });

    this._fillSettings(ctx);
  },

  _buildResizer(ctx, sidebar) {
    const resizer = this._el(ctx.doc, "div", { id: "zor-resizer", title: "拖动调整宽度" });
    sidebar.appendChild(resizer);
    ctx.els.resizer = resizer;
  },

  /* ---------------------------------------------------------------- events */

  _bindEvents(ctx) {
    const doc = ctx.doc;
    const on = (target, type, handler, options) => {
      target.addEventListener(type, handler, options);
      ctx.listeners.push([target, type, handler, options]);
    };

    const tabButtons = [ctx.els.tabs.chat, ctx.els.tabs.history, ctx.els.tabs.settings];
    for (const button of tabButtons) {
      on(button, "click", () => this.switchView(ctx, button.getAttribute("data-view")));
    }

    on(ctx.els.brand, "click", () => this.closeSidebar(ctx));
    on(ctx.els.close, "click", () => this.closeSidebar(ctx));
    on(ctx.els.send, "click", () => this.sendOrStop(ctx));
    on(ctx.els.input, "keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.sendOrStop(ctx);
      }
    });
    on(ctx.els.input, "input", () => this._autoGrow(ctx));
    on(ctx.els.input, "focus", () => this._updateContextChip(ctx));

    on(ctx.els.contextBar, "click", () => this._updateContextChip(ctx));

    const useContext = ctx.els.body.querySelector("#zor-use-context");
    if (useContext) {
      on(useContext, "change", () => {
        this._setPref("sendContext", !!useContext.checked);
      });
    }

    on(ctx.els.newChat, "click", () => {
      const session = ZorStore.createSession();
      ZorStore.activeId = session.id;
      this.switchView(ctx, "chat");
      this.renderAll(ctx);
      this._focusInput(ctx);
    });

    on(ctx.els.save, "click", () => this._saveSettings(ctx));
    on(ctx.els.test, "click", () => this._testConnection(ctx));
    on(ctx.els.clearHistory, "click", () => this._clearHistory(ctx));
    on(ctx.els.temperature, "input", () => this._syncTemperatureLabel(ctx));

    on(ctx.els.resizer, "mousedown", (event) => this._startResize(ctx, event));

    on(ctx.els.input, "paste", (event) => this._handlePaste(ctx, event));
    on(ctx.sidebar, "dragover", (event) => {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
    });
    on(ctx.sidebar, "drop", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this._handleDrop(ctx, event);
    });

    // Keep the "current selection" chip fresh without polling hard.
    let refreshTimer = null;
    const scheduleRefresh = () => {
      if (refreshTimer) {
        return;
      }
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        this._updateContextChip(ctx);
      }, 350);
    };
    on(doc, "click", scheduleRefresh, true);
    on(doc, "keyup", scheduleRefresh, true);

    // A PDF text selection happens inside a nested iframe, so window-level
    // events never reach us. Poll lightly (only while the sidebar is visible)
    // and update the chip when the selection changes.
    ctx.lastContextLabel = "";
    ctx.contextInterval = setInterval(() => {
      try {
        if (ctx.closed) {
          return;
        }
        const label = ZorContext.summarize(ctx.win);
        if (label !== ctx.lastContextLabel) {
          ctx.lastContextLabel = label;
          this._renderContextChip(ctx, label);
        }
      }
      catch (e) {}
    }, 1200);
  },

  _teardown(ctx) {
    if (ctx.contextInterval) {
      clearInterval(ctx.contextInterval);
      ctx.contextInterval = null;
    }
    for (const [target, type, handler, options] of ctx.listeners) {
      try {
        target.removeEventListener(type, handler, options);
      }
      catch (e) {}
    }
    ctx.listeners = [];
    try {
      ctx.sidebar.remove();
    }
    catch (e) {}
    try {
      ctx.els.launcher?.remove();
    }
    catch (e) {}
    const link = ctx.doc.getElementById("zor-stylesheet");
    if (link) {
      link.remove();
    }
  },

  removeFromWindow(win) {
    const ctx = this.windows.get(win);
    if (!ctx) {
      return;
    }
    this.windows.delete(win);
    this._teardown(ctx);
  },

  removeFromAllWindows() {
    for (const win of Array.from(this.windows.keys())) {
      this.removeFromWindow(win);
    }
  },

  async destroy() {
    this.removeFromAllWindows();
    if (this._wmListener) {
      try {
        Services.wm.removeListener(this._wmListener);
      }
      catch (e) {}
      this._wmListener = null;
    }
    try {
      await ZorStore?.flush?.();
    }
    catch (e) {
      Zotero.logError(e);
    }
    this.initialized = false;
  },

  /* ---------------------------------------------------------------- layout */

  _autoGrow(ctx) {
    const input = ctx.els.input;
    input.style.height = "auto";
    input.style.height = Math.min(160, input.scrollHeight) + "px";
  },

  _startResize(ctx, event) {
    event.preventDefault();
    const doc = ctx.doc;
    const startX = event.clientX;
    const startWidth = parseInt(ctx.sidebar.style.width, 10) || 360;
    ctx.sidebar.classList.add("zor-resizing");

    const onMove = (moveEvent) => {
      // The sidebar sits on the right edge, so dragging left grows it.
      let width = startWidth - (moveEvent.clientX - startX);
      width = Math.max(this.MIN_WIDTH, Math.min(this.MAX_WIDTH, width));
      ctx.sidebar.style.width = width + "px";
    };
    const onUp = () => {
      doc.removeEventListener("mousemove", onMove);
      doc.removeEventListener("mouseup", onUp);
      ctx.sidebar.classList.remove("zor-resizing");
      const width = parseInt(ctx.sidebar.style.width, 10) || 360;
      this._setPref("width", width);
    };
    doc.addEventListener("mousemove", onMove);
    doc.addEventListener("mouseup", onUp);
  },

  switchView(ctx, view) {
    ctx.view = view;
    ctx.els.viewChat.classList.toggle("hidden", view !== "chat");
    ctx.els.viewHistory.classList.toggle("hidden", view !== "history");
    ctx.els.viewSettings.classList.toggle("hidden", view !== "settings");
    for (const name of ["chat", "history", "settings"]) {
      ctx.els.tabs[name].classList.toggle("active", name === view);
    }
    if (view === "history") {
      this.renderHistory(ctx);
    }
    else if (view === "settings") {
      this._fillSettings(ctx);
    }
    else {
      this.scrollToBottom(ctx);
      this._focusInput(ctx);
    }
  },

  _focusInput(ctx) {
    try {
      ctx.els.input.focus();
    }
    catch (e) {}
  },

  /* ---------------------------------------------------------------- images */

  _handlePaste(ctx, event) {
    const clipboard = event.clipboardData;
    if (!clipboard || !clipboard.items) {
      return;
    }
    let handled = false;
    for (const item of clipboard.items) {
      if (item.type && item.type.indexOf("image/") === 0) {
        const file = item.getAsFile();
        if (file) {
          handled = true;
          this._addImageFromFile(ctx, file);
        }
      }
    }
    if (handled) {
      event.preventDefault();
    }
  },

  _handleDrop(ctx, event) {
    const dataTransfer = event.dataTransfer;
    if (!dataTransfer) {
      return;
    }

    // Items dragged from Zotero's item tree carry their item ids in this
    // custom type, which is far more reliable than reading files.
    try {
      const types = dataTransfer.types ? Array.from(dataTransfer.types) : [];
      if (types.includes("zotero/item")) {
        const raw = dataTransfer.getData("zotero/item");
        if (raw) {
          this._addZoteroItems(ctx, raw);
          return;
        }
      }
    }
    catch (e) {
      Zotero.logError(e);
    }

    const files = dataTransfer.files;
    if (!files || !files.length) {
      return;
    }
    for (const file of files) {
      const name = (file.name || "").toLowerCase();
      if (file.type && file.type.indexOf("image/") === 0) {
        this._addImageFromFile(ctx, file);
      }
      else if (/\.pdf$/.test(name) || file.type === "application/pdf") {
        this._addPdfFromFile(ctx, file);
      }
      else if (/\.(txt|md|markdown|csv|json)$/.test(name) || (file.type && file.type.indexOf("text/") === 0)) {
        this._addTextFromFile(ctx, file);
      }
      else {
        this._setStatus(ctx, "不支持的文件：" + (file.name || "未知"));
      }
    }
  },

  async _addZoteroItems(ctx, raw) {
    try {
      const ids = String(raw).split(",").map(value => parseInt(value, 10)).filter(Boolean);
      if (!ids.length) {
        return;
      }
      this._setStatus(ctx, "正在读取 PDF…");
      for (const id of ids) {
        const item = await Zotero.Items.getAsync(id);
        if (!item) {
          continue;
        }
        const attachment = await this._findPdfAttachment(item);
        if (!attachment) {
          continue;
        }
        const result = await Zotero.PDFWorker.getFullText(attachment.id, 60);
        const text = ((result && result.text) || "").trim();
        if (!text) {
          this._setStatus(ctx, "没有提取到文字（扫描版 PDF 需要 OCR）");
          return;
        }
        const name = attachment.attachmentFilename || "PDF";
        this._applyDocContext(ctx, { name, kind: "pdf", text });
        this._setStatus(ctx, "已读取 PDF（" + Math.round(text.length / 1000) + "k 字）");
        return;
      }
      this._setStatus(ctx, "拖入的条目没有 PDF 附件");
    }
    catch (e) {
      Zotero.logError(e);
      this._setStatus(ctx, "PDF 解析失败：" + this._shortError(e));
    }
  },

  async _findPdfAttachment(item) {
    try {
      if (item.isPDFAttachment && item.isPDFAttachment()) {
        return item;
      }
      if (!(item.isRegularItem && item.isRegularItem())) {
        return null;
      }
      const attachmentIDs = item.getAttachments() || [];
      for (const id of attachmentIDs) {
        const child = await Zotero.Items.getAsync(id);
        if (child && child.isPDFAttachment && child.isPDFAttachment()) {
          return child;
        }
      }
    }
    catch (e) {
      Zotero.logError(e);
    }
    return null;
  },

  _addPdfFromFile(ctx, file) {
    if (file.size > 200 * 1024 * 1024) {
      this._setStatus(ctx, "PDF 太大（上限 200MB）");
      return;
    }
    this._setStatus(ctx, "正在读取 PDF…");

    // Prefer reading through the file path (native buffer, transferable to the
    // PDF worker). Fall back to FileReader when the path isn't exposed.
    const path = file.path || file.mozFullPath || "";
    if (path) {
      IOUtils.read(path)
        .then((data) => this._extractPdfBuffer(ctx, file, new Uint8Array(data).buffer))
        .catch((e) => {
          Zotero.logError(e);
          this._setStatus(ctx, "读取 PDF 失败：" + this._shortError(e));
        });
      return;
    }

    try {
      const reader = new ctx.win.FileReader();
      reader.onload = () => this._extractPdfBuffer(ctx, file, reader.result);
      reader.onerror = () => this._setStatus(ctx, "读取 PDF 失败");
      reader.readAsArrayBuffer(file);
    }
    catch (e) {
      Zotero.logError(e);
      this._setStatus(ctx, "读取 PDF 失败：" + this._shortError(e));
    }
  },

  async _extractPdfBuffer(ctx, file, arrayBuffer) {
    try {
      const worker = Zotero.PDFWorker;
      // `_enqueue` also lazily starts the worker; calling `_query` directly on a
      // cold worker fails because `_worker` is still null.
      const result = await worker._enqueue(() => worker._query(
        "pdf.getFulltext",
        { buf: arrayBuffer, maxPages: 60, password: null },
        [arrayBuffer]
      ));
      const text = ((result && result.text) || "").trim();
      if (!text) {
        this._setStatus(ctx, "没有提取到文字（扫描版 PDF 需要 OCR）");
        return;
      }
      this._applyDocContext(ctx, { name: file.name, kind: "pdf", text });
      this._setStatus(ctx, "已读取 PDF（" + Math.round(text.length / 1000) + "k 字）");
    }
    catch (e) {
      Zotero.logError(e);
      this._setStatus(ctx, "PDF 解析失败：" + this._shortError(e));
    }
  },

  _shortError(error) {
    const message = String((error && (error.message || error.name)) || error || "未知错误");
    return message.slice(0, 60);
  },

  _addTextFromFile(ctx, file) {
    try {
      const reader = new ctx.win.FileReader();
      reader.onload = () => {
        try {
          const text = String(reader.result || "").trim();
          if (!text) {
            this._setStatus(ctx, "文件是空的");
            return;
          }
          this._applyDocContext(ctx, { name: file.name, kind: "text", text });
          this._setStatus(ctx, "已读取文本（" + Math.round(text.length / 1000) + "k 字）");
        }
        catch (e) {
          Zotero.logError(e);
        }
      };
      reader.onerror = () => this._setStatus(ctx, "读取文件失败");
      reader.readAsText(file);
    }
    catch (e) {
      Zotero.logError(e);
      this._setStatus(ctx, "读取文件失败");
    }
  },

  _applyDocContext(ctx, docContext) {
    ctx.docContext = docContext;
    this._renderFiles(ctx);
  },

  _renderFiles(ctx) {
    const strip = ctx.els.fileStrip;
    if (!strip) {
      return;
    }
    strip.textContent = "";
    const docContext = ctx.docContext;
    if (!docContext) {
      strip.classList.add("hidden");
      return;
    }
    strip.classList.remove("hidden");
    const chip = this._el(ctx.doc, "div", { class: "zor-file-chip" });
    chip.appendChild(this._el(ctx.doc, "span", { class: "zor-file-name", text: docContext.name }));
    const length = docContext.text.length;
    const size = length >= 1000 ? Math.round(length / 1000) + "k 字" : length + " 字";
    chip.appendChild(this._el(ctx.doc, "span", { class: "zor-file-meta", text: size }));
    const remove = this._el(ctx.doc, "button", { class: "zor-file-del", title: "移除这份资料", text: "×" });
    remove.addEventListener("click", () => {
      ctx.docContext = null;
      this._renderFiles(ctx);
    });
    chip.appendChild(remove);
    strip.appendChild(chip);
  },

  _addImageFromFile(ctx, file) {
    if (file.size > 20 * 1024 * 1024) {
      this._setStatus(ctx, "图片太大（上限 20MB）");
      return;
    }
    try {
      const reader = new ctx.win.FileReader();
      reader.onload = () => this._addImageData(ctx, reader.result);
      reader.onerror = () => this._setStatus(ctx, "读取图片失败");
      reader.readAsDataURL(file);
    }
    catch (e) {
      Zotero.logError(e);
    }
  },

  async _addImageData(ctx, dataURL) {
    try {
      if (ctx.images.length >= 8) {
        this._setStatus(ctx, "一次最多 8 张图片");
        return;
      }
      const compressed = await this._downscaleImage(ctx, dataURL);
      ctx.images.push(compressed);
      this._renderImages(ctx);
      this._setStatus(ctx, "");
    }
    catch (e) {
      Zotero.logError(e);
      this._setStatus(ctx, "处理图片失败");
    }
  },

  _downscaleImage(ctx, dataURL) {
    return new Promise((resolve) => {
      let img;
      try {
        img = new ctx.win.Image();
      }
      catch (e) {
        resolve(dataURL);
        return;
      }
      img.onload = () => {
        try {
          const maxSide = 1600;
          let width = img.naturalWidth || img.width;
          let height = img.naturalHeight || img.height;
          const scale = Math.min(1, maxSide / Math.max(width, height));
          width = Math.max(1, Math.round(width * scale));
          height = Math.max(1, Math.round(height * scale));
          const canvas = ctx.doc.createElementNS(this.XHTML, "canvas");
          canvas.width = width;
          canvas.height = height;
          const context2d = canvas.getContext("2d");
          context2d.drawImage(img, 0, 0, width, height);
          const out = canvas.toDataURL("image/jpeg", 0.88);
          resolve(out.length < dataURL.length ? out : dataURL);
        }
        catch (e) {
          resolve(dataURL);
        }
      };
      img.onerror = () => resolve(dataURL);
      img.src = dataURL;
    });
  },

  _renderImages(ctx) {
    const strip = ctx.els.imageStrip;
    if (!strip) {
      return;
    }
    strip.textContent = "";
    if (!ctx.images.length) {
      strip.classList.add("hidden");
      return;
    }
    strip.classList.remove("hidden");
    ctx.images.forEach((dataURL, index) => {
      const wrap = this._el(ctx.doc, "div", { class: "zor-thumb" });
      wrap.appendChild(this._el(ctx.doc, "img", { src: dataURL, alt: "" }));
      const remove = this._el(ctx.doc, "button", { class: "zor-thumb-del", title: "移除这张图片", text: "×" });
      remove.addEventListener("click", (event) => {
        event.preventDefault();
        ctx.images.splice(index, 1);
        this._renderImages(ctx);
      });
      wrap.appendChild(remove);
      strip.appendChild(wrap);
    });
  },

  /* ---------------------------------------------------------------- data */

  _activeSession() {
    return ZorStore.activeSession;
  },

  _ensureSession() {
    let session = this._activeSession();
    if (!session) {
      session = ZorStore.createSession();
      ZorStore.activeId = session.id;
    }
    return session;
  },

  _updateContextChip(ctx) {
    if (!ctx.els.contextBar) {
      return;
    }
    let label = "";
    try {
      label = ZorContext.summarize(ctx.win);
    }
    catch (e) {
      label = "";
    }
    this._renderContextChip(ctx, label);
    ctx.lastContextLabel = label;
  },

  _renderContextChip(ctx, label) {
    if (!ctx.els.contextBar) {
      return;
    }
    if (label) {
      ctx.els.contextBar.textContent = label;
      ctx.els.contextBar.classList.remove("hidden");
      ctx.els.contextBar.title = "发送时会附带这段文本/条目元数据；点击刷新";
    }
    else {
      ctx.els.contextBar.classList.add("hidden");
    }
  },

  /* ---------------------------------------------------------------- render */

  renderAll(ctx) {
    this.renderChat(ctx);
    this.renderHistory(ctx);
    this._syncSendButton(ctx);
  },

  renderChat(ctx) {
    const session = this._activeSession();
    const container = ctx.els.messages;
    container.textContent = "";

    if (!session || !session.messages.length) {
      container.appendChild(this._emptyState(ctx));
      return;
    }

    for (const message of session.messages) {
      container.appendChild(this._messageNode(ctx, message));
    }
    this.scrollToBottom(ctx);
  },

  _emptyState(ctx) {
    const doc = ctx.doc;
    const wrap = this._el(doc, "div", { id: "zor-empty" });
    wrap.appendChild(this._el(doc, "div", { class: "zor-empty-title", text: "在 Zotero 里直接问 DeepSeek" }));
    wrap.appendChild(this._el(doc, "div", {
      class: "zor-empty-text",
      text: "选中一条文献再提问，元数据会随问题一起发送。对话会自动保存到本地。"
    }));

    const tips = [
      "这篇文献的主要贡献是什么？",
      "用三句话总结摘要，并指出方法上的局限。",
      "帮我写一条引用这段文献的英文句子。"
    ];
    for (const tip of tips) {
      const button = this._el(doc, "button", { class: "zor-tip", text: tip });
      button.addEventListener("click", () => {
        ctx.els.input.value = tip;
        this._autoGrow(ctx);
        this._focusInput(ctx);
      });
      wrap.appendChild(button);
    }

    if (!ZorAPI.isConfigured()) {
      const warn = this._el(doc, "div", { class: "zor-notice" });
      warn.appendChild(this._el(doc, "span", { text: "还没有配置 API Key。" }));
      const link = this._el(doc, "button", { class: "zor-link", text: "去设置" });
      link.addEventListener("click", () => this.switchView(ctx, "settings"));
      warn.appendChild(link);
      wrap.appendChild(warn);
    }
    return wrap;
  },

  _messageNode(ctx, message) {
    const doc = ctx.doc;
    const isUser = message.role === "user";
    const node = this._el(doc, "div", { class: "zor-msg " + (isUser ? "zor-msg-user" : "zor-msg-assistant") });

    const role = this._el(doc, "div", { class: "zor-msg-role", text: isUser ? "你" : "DeepSeek" });
    node.appendChild(role);

    if (!isUser && message.reasoning) {
      const details = this._el(doc, "details", { class: "zor-reasoning" });
      details.appendChild(this._el(doc, "summary", { text: "思考过程" }));
      details.appendChild(this._el(doc, "div", { class: "zor-reasoning-body", text: message.reasoning }));
      node.appendChild(details);
    }

    const body = this._el(doc, "div", { class: "zor-msg-body" });
    if (isUser) {
      body.textContent = message.content;
    }
    else {
      body.appendChild(this._renderMarkdown(ctx, message.content || ""));
    }
    node.appendChild(body);

    if (!isUser && message.error) {
      node.appendChild(this._el(doc, "div", { class: "zor-error", text: message.error }));
    }
    return node;
  },

  renderHistory(ctx) {
    const list = ctx.els.historyList;
    list.textContent = "";
    const sessions = ZorStore.sessions;
    ctx.els.historyCount.textContent = sessions.length ? `${sessions.length} 个对话` : "暂无对话";

    if (!sessions.length) {
      list.appendChild(this._el(ctx.doc, "div", { class: "zor-empty-text", text: "还没有对话记录。点上面的「新对话」开始。" }));
      return;
    }

    for (const session of sessions) {
      const row = this._el(ctx.doc, "div", {
        class: "zor-history-item" + (session.id === ZorStore.activeId ? " active" : "")
      });

      const main = this._el(ctx.doc, "button", { class: "zor-history-main" });
      main.appendChild(this._el(ctx.doc, "div", { class: "zor-history-title", text: session.title || "未命名对话" }));
      main.appendChild(this._el(ctx.doc, "div", {
        class: "zor-history-meta",
        text: `${this._formatTime(session.updatedAt)} · ${session.messages.length} 条`
      }));
      main.addEventListener("click", () => {
        ZorStore.activeId = session.id;
        this.switchView(ctx, "chat");
        this.renderAll(ctx);
      });

      const del = this._el(ctx.doc, "button", { class: "zor-history-del", title: "删除这个对话", text: "×" });
      del.addEventListener("click", (event) => {
        event.stopPropagation();
        ZorStore.deleteSession(session.id);
        this.renderAll(ctx);
      });

      row.appendChild(main);
      row.appendChild(del);
      list.appendChild(row);
    }
  },

  _formatTime(timestamp) {
    if (!timestamp) {
      return "";
    }
    const date = new Date(timestamp);
    const now = new Date();
    const pad = n => String(n).padStart(2, "0");
    const sameDay = date.toDateString() === now.toDateString();
    if (sameDay) {
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  },

  scrollToBottom(ctx) {
    const container = ctx.els.messages;
    container.scrollTop = container.scrollHeight;
  },

  /* ---------------------------------------------------------------- markdown */

  _renderMarkdown(ctx, text) {
    const doc = ctx.doc;
    const frag = doc.createDocumentFragment();
    const source = String(text).replace(/\r\n/g, "\n");
    const lines = source.split("\n");
    let index = 0;
    let listEl = null;
    let listKind = null;

    const flushList = () => {
      listEl = null;
      listKind = null;
    };

    const isBlockStart = line => /^(#{1,4}\s|```|>\s?|\s*([-*+]|\d+\.)\s)/.test(line);

    while (index < lines.length) {
      const line = lines[index];

      if (/^```/.test(line)) {
        const info = line.replace(/^```/, "").trim();
        const buffer = [];
        index++;
        while (index < lines.length && !/^```/.test(lines[index])) {
          buffer.push(lines[index]);
          index++;
        }
        index++;
        const pre = this._el(doc, "pre", { class: "zor-pre" });
        const code = this._el(doc, "code", { class: info ? "language-" + info : "" });
        code.textContent = buffer.join("\n");
        pre.appendChild(code);
        frag.appendChild(pre);
        flushList();
        continue;
      }

      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        const level = Math.min(heading[1].length + 2, 6);
        const node = this._el(doc, "h" + level);
        this._appendInline(ctx, node, heading[2]);
        frag.appendChild(node);
        flushList();
        index++;
        continue;
      }

      const listItem = line.match(/^\s*([-*+]|\d+\.)\s+(.*)$/);
      if (listItem) {
        const kind = /\d/.test(listItem[1]) ? "ol" : "ul";
        if (!listEl || listKind !== kind) {
          listEl = this._el(doc, kind, { class: "zor-list" });
          listKind = kind;
          frag.appendChild(listEl);
        }
        const item = this._el(doc, "li");
        this._appendInline(ctx, item, listItem[2]);
        listEl.appendChild(item);
        index++;
        continue;
      }

      if (/^>\s?/.test(line)) {
        const quote = this._el(doc, "blockquote", { class: "zor-quote" });
        this._appendInline(ctx, quote, line.replace(/^>\s?/, ""));
        frag.appendChild(quote);
        flushList();
        index++;
        continue;
      }

      if (!line.trim()) {
        flushList();
        index++;
        continue;
      }

      const buffer = [line];
      index++;
      while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
        buffer.push(lines[index]);
        index++;
      }
      const paragraph = this._el(doc, "p");
      this._appendInline(ctx, paragraph, buffer.join("\n"));
      frag.appendChild(paragraph);
      flushList();
    }
    return frag;
  },

  _appendInline(ctx, parent, text) {
    const doc = ctx.doc;
    const pattern = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|https?:\/\/[^\s<]+)/g;
    let last = 0;
    let match;
    const pushText = (value) => {
      if (!value) {
        return;
      }
      const parts = value.split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          parent.appendChild(this._el(doc, "br"));
        }
        if (parts[i]) {
          parent.appendChild(doc.createTextNode(parts[i]));
        }
      }
    };

    while ((match = pattern.exec(text)) !== null) {
      pushText(text.slice(last, match.index));
      last = match.index + match[0].length;
      const token = match[0];

      if (token.startsWith("**")) {
        const strong = this._el(doc, "strong");
        strong.textContent = token.slice(2, -2);
        parent.appendChild(strong);
      }
      else if (token.startsWith("`")) {
        const code = this._el(doc, "code", { class: "zor-inline-code" });
        code.textContent = token.slice(1, -1);
        parent.appendChild(code);
      }
      else if (token.startsWith("[")) {
        const linkMatch = token.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
        if (linkMatch) {
          parent.appendChild(this._link(ctx, linkMatch[1], linkMatch[2]));
        }
        else {
          parent.appendChild(doc.createTextNode(token));
        }
      }
      else if (/^https?:/.test(token)) {
        parent.appendChild(this._link(ctx, token, token));
      }
      else if (token.startsWith("*")) {
        const em = this._el(doc, "em");
        em.textContent = token.slice(1, -1);
        parent.appendChild(em);
      }
    }
    pushText(text.slice(last));
  },

  _link(ctx, label, href) {
    const doc = ctx.doc;
    const anchor = this._el(doc, "a", { href: href, class: "zor-link", text: label });
    anchor.addEventListener("click", (event) => {
      event.preventDefault();
      try {
        Zotero.launchURL(href);
      }
      catch (e) {
        Zotero.logError(e);
      }
    });
    return anchor;
  },

  /* ---------------------------------------------------------------- chat */

  sendOrStop(ctx) {
    if (ctx.busy) {
      this.stop(ctx);
      return;
    }
    this.send(ctx);
  },

  send(ctx) {
    const text = (ctx.els.input.value || "").trim();
    if (!text || ctx.busy) {
      return;
    }
    if (!ZorAPI.isConfigured()) {
      this.switchView(ctx, "settings");
      ctx.els.settingsStatus.textContent = "先填写 API Key 再开始对话。";
      ctx.els.settingsStatus.className = "zor-warn";
      return;
    }

    const session = this._ensureSession();
    ZorStore.addMessage(session, { role: "user", content: text });
    ctx.els.input.value = "";
    this._autoGrow(ctx);
    this.renderChat(ctx);

    const useContext = this._pref("sendContext", true) !== false;
    let contextText = "";
    try {
      contextText = useContext ? ZorContext.build(ctx.win) : "";
    }
    catch (e) {
      Zotero.logError(e);
    }

    if (ctx.docContext && ctx.docContext.text) {
      const docText = ctx.docContext.text.slice(0, 20000);
      contextText += (contextText ? "\n\n" : "")
        + "用户拖入的文档《" + ctx.docContext.name + "》内容如下（可能已截断）：\n\"\"\"\n"
        + docText
        + "\n\"\"\"";
    }

    const placeholder = this._el(ctx.doc, "div", { class: "zor-msg zor-msg-assistant" });
    placeholder.appendChild(this._el(ctx.doc, "div", { class: "zor-msg-role", text: "DeepSeek" }));
    const body = this._el(ctx.doc, "div", { class: "zor-msg-body" });
    const streamText = this._el(ctx.doc, "div", { class: "zor-streaming" });
    body.appendChild(streamText);
    placeholder.appendChild(body);
    ctx.els.messages.appendChild(placeholder);
    this.scrollToBottom(ctx);

    ctx.busy = true;
    ctx.stoppedByUser = false;
    this._setStatus(ctx, "");
    this._syncSendButton(ctx);

    const images = ctx.images.slice();
    ctx.images = [];
    this._renderImages(ctx);

    let content = "";
    let reasoning = "";
    let reasoningNode = null;
    let flushTimer = null;

    const assistant = { role: "assistant", content: "", reasoning: "" };

    const flush = () => {
      flushTimer = null;
      streamText.textContent = content;
      if (reasoning) {
        if (!reasoningNode) {
          reasoningNode = this._el(ctx.doc, "details", { class: "zor-reasoning" });
          reasoningNode.appendChild(this._el(ctx.doc, "summary", { text: "思考过程" }));
          reasoningNode.appendChild(this._el(ctx.doc, "div", { class: "zor-reasoning-body" }));
          placeholder.insertBefore(reasoningNode, body);
        }
        reasoningNode.lastChild.textContent = reasoning;
      }
      this.scrollToBottom(ctx);
    };

    const scheduleFlush = () => {
      if (flushTimer) {
        return;
      }
      flushTimer = setTimeout(flush, 24);
    };

    const finish = ({ error }) => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      const wasStopped = !!ctx.stoppedByUser;
      ctx.stoppedByUser = false;
      ctx.busy = false;
      ctx.abort = null;
      this._syncSendButton(ctx);

      assistant.content = content;
      assistant.reasoning = reasoning;
      if (error) {
        assistant.error = error.message || String(error);
      }

      if (!assistant.content && !assistant.error) {
        placeholder.remove();
        this._setStatus(ctx, wasStopped ? "已停止" : "");
        return;
      }

      try {
        ZorStore.addMessage(session, assistant);
      }
      catch (e) {
        Zotero.logError(e);
      }
      this.renderChat(ctx);
      this.renderHistory(ctx);
      if (error) {
        this._setStatus(ctx, "出错了");
      }
      else if (wasStopped) {
        this._setStatus(ctx, "已停止");
      }
      else {
        this._setStatus(ctx, "");
      }
    };

    ctx.abort = ZorAPI.stream({
      session,
      contextText,
      images,
      onStart: () => {
        this._setStatus(ctx, "思考中…");
      },
      onDelta: (delta) => {
        content += delta;
        scheduleFlush();
      },
      onReasoning: (delta) => {
        reasoning += delta;
        scheduleFlush();
      },
      onDone: () => finish({}),
      onError: (error) => finish({ error })
    });
  },

  stop(ctx) {
    ctx.stoppedByUser = true;
    if (ctx.abort) {
      ctx.abort.abort();
      ctx.abort = null;
    }
    ctx.busy = false;
    this._syncSendButton(ctx);
    this._setStatus(ctx, "已停止");
  },

  _syncSendButton(ctx) {
    ctx.els.send.textContent = ctx.busy ? "停止" : "发送";
    ctx.els.send.classList.toggle("zor-stop", !!ctx.busy);
  },

  _setStatus(ctx, text) {
    ctx.els.status.textContent = text || "";
    ctx.els.status.className = text ? "zor-status-on" : "";
  },

  /* ---------------------------------------------------------------- settings */

  _fillSettings(ctx) {
    const config = ZorAPI.config();
    ctx.els.apiKey.value = config.apiKey;
    ctx.els.baseURL.value = config.baseURL;
    ctx.els.model.value = config.model;
    ctx.els.temperature.value = String(Math.round(Math.max(0, Math.min(2, config.temperature)) * 100));
    ctx.els.systemPrompt.value = config.systemPrompt;
    this._syncTemperatureLabel(ctx);
    ctx.els.dataInfo.textContent = "对话记录保存在：" + (ZorStore.dir || "(未初始化)");
  },

  _syncTemperatureLabel(ctx) {
    const value = (parseInt(ctx.els.temperature.value, 10) || 0) / 100;
    ctx.els.temperatureValue.textContent = value.toFixed(2);
  },

  _saveSettings(ctx) {
    this._setPref("apiKey", ctx.els.apiKey.value.trim());
    this._setPref("baseURL", ctx.els.baseURL.value.trim() || ZorAPI.DEFAULT_BASE_URL);
    this._setPref("model", ctx.els.model.value.trim() || ZorAPI.DEFAULT_MODEL);
    this._setPref("temperature", ((parseInt(ctx.els.temperature.value, 10) || 0) / 100).toFixed(2));
    this._setPref("systemPrompt", ctx.els.systemPrompt.value);
    ctx.els.settingsStatus.textContent = "已保存。";
    ctx.els.settingsStatus.className = "zor-ok";
    this.renderChat(ctx);
  },

  async _testConnection(ctx) {
    ctx.els.settingsStatus.textContent = "正在测试…";
    ctx.els.settingsStatus.className = "zor-dim";
    this._saveSettings(ctx);
    try {
      const message = await ZorAPI.test();
      ctx.els.settingsStatus.textContent = message;
      ctx.els.settingsStatus.className = "zor-ok";
    }
    catch (e) {
      ctx.els.settingsStatus.textContent = "失败：" + (e.message || e);
      ctx.els.settingsStatus.className = "zor-warn";
    }
  },

  async _clearHistory(ctx) {
    const win = ctx.win;
    try {
      const confirmed = Services.prompt.confirm(
        win,
        "清空对话",
        "确定要删除所有对话记录吗？此操作无法撤销。"
      );
      if (!confirmed) {
        return;
      }
    }
    catch (e) {
      Zotero.logError(e);
    }
    ZorStore.clearAll();
    this.renderAll(ctx);
    this._setStatus(ctx, "已清空");
  }
};
