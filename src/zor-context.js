/**
 * ZorContext — build the "current selection" context that is sent to the model.
 */
var ZorContext = {
  MAX_ITEMS: 5,
  MAX_CHARS: 6000,

  getSelectedItems(win) {
    try {
      const pane = win && win.ZoteroPane;
      if (pane && typeof pane.getSelectedItems === "function") {
        return (pane.getSelectedItems() || []).filter(Boolean);
      }
    }
    catch (e) {
      Zotero.logError(e);
    }
    return [];
  },

  /**
   * In a standalone reader window there is no ZoteroPane, but the window has a
   * `reader` instance that knows which attachment is being viewed.
   */
  getReaderItem(win) {
    try {
      const reader = win && win.reader;
      if (!reader) {
        return null;
      }
      if (reader._item) {
        return reader._item;
      }
      const id = reader.itemID;
      if (id) {
        return Zotero.Items.get(id);
      }
    }
    catch (e) {
      Zotero.logError(e);
    }
    return null;
  },

  /** Items worth describing to the model: regular items and standalone attachments. */
  usefulItems(win) {
    const readerItem = this.getReaderItem(win);
    if (readerItem) {
      let target = readerItem;
      try {
        const parent = readerItem.parentItem
          || (readerItem.parentID ? Zotero.Items.get(readerItem.parentID) : null);
        if (parent) {
          target = parent;
        }
      }
      catch (e) {}
      return [target];
    }

    return this.getSelectedItems(win).filter(item => {
      try {
        if (item.isRegularItem && item.isRegularItem()) {
          return true;
        }
        // A standalone attachment/note can still be described briefly.
        return !item.parentItem;
      }
      catch (e) {
        return false;
      }
    }).slice(0, this.MAX_ITEMS);
  },

  /**
   * Find the reader instance currently in front of the user: either the
   * standalone reader window the sidebar lives in, or the reader tab selected
   * in the main window.
   */
  getActiveReader(win) {
    if (!win) {
      return null;
    }
    try {
      if (win.reader && win.reader.itemID !== undefined) {
        return win.reader;
      }
    }
    catch (e) {}
    try {
      const tabs = win.Zotero_Tabs;
      const selectedID = tabs && tabs.selectedID;
      if (selectedID && Zotero.Reader && typeof Zotero.Reader.getByTabID === "function") {
        const reader = Zotero.Reader.getByTabID(selectedID);
        if (reader) {
          return reader;
        }
      }
    }
    catch (e) {}
    return null;
  },

  /** Text the user has selected inside a PDF/EPUB reader, or "". */
  getReaderSelectionText(win) {
    const reader = this.getActiveReader(win);
    if (!reader) {
      return "";
    }
    try {
      const view = reader._internalReader && reader._internalReader._primaryView;
      const iframeWindow = view && view._iframeWindow;
      if (!iframeWindow) {
        return "";
      }
      const selection = iframeWindow.getSelection();
      if (!selection) {
        return "";
      }
      return (selection.toString() || "").trim();
    }
    catch (e) {
      return "";
    }
  },

  /** Short label for the sidebar chip. */
  summarize(win) {
    const selectionText = this.getReaderSelectionText(win);
    if (selectionText) {
      const short = selectionText.replace(/\s+/g, " ").slice(0, 40);
      return "PDF 选中：" + short + (selectionText.length > 40 ? "…" : "");
    }

    const items = this.usefulItems(win);
    if (!items.length) {
      return "";
    }
    const first = items[0];
    let title = "";
    try {
      title = first.getField("title") || "";
    }
    catch (e) {
      title = "";
    }
    if (!title && first.isAttachment && first.isAttachment()) {
      title = first.attachmentFilename || "附件";
    }
    if (items.length > 1) {
      return `选中：${title} 等 ${items.length} 项`;
    }
    return "选中：" + title;
  },

  _creatorName(creator) {
    if (creator.name) {
      return creator.name;
    }
    const parts = [creator.firstName, creator.lastName].filter(Boolean);
    return parts.join(" ");
  },

  _field(item, name) {
    try {
      const value = item.getField(name);
      return typeof value === "string" ? value.trim() : "";
    }
    catch (e) {
      return "";
    }
  },

  describe(item) {
    const lines = [];
    let typeName = "";
    try {
      typeName = Zotero.ItemTypes.getName(item.itemTypeID);
    }
    catch (e) {
      typeName = "";
    }
    lines.push(`- 类型: ${typeName || "未知"}`);

    const title = this._field(item, "title");
    if (title) {
      lines.push(`- 标题: ${title}`);
    }

    try {
      const creators = (item.getCreators() || []).map(c => this._creatorName(c)).filter(Boolean);
      if (creators.length) {
        lines.push(`- 作者: ${creators.slice(0, 8).join("; ")}`);
      }
    }
    catch (e) {}

    const date = this._field(item, "date");
    if (date) {
      lines.push(`- 日期: ${date}`);
    }

    for (const field of ["publicationTitle", "proceedingsTitle", "bookTitle", "publisher", "conferenceName", "university"]) {
      const value = this._field(item, field);
      if (value) {
        lines.push(`- 出版信息: ${value}`);
        break;
      }
    }

    for (const field of ["volume", "issue", "pages"]) {
      const value = this._field(item, field);
      if (value) {
        lines.push(`- ${field}: ${value}`);
      }
    }

    for (const field of ["DOI", "ISBN", "ISSN", "url"]) {
      const value = this._field(item, field);
      if (value) {
        lines.push(`- ${field}: ${value}`);
      }
    }

    try {
      const tags = (item.getTags() || []).map(t => t.tag).filter(Boolean);
      if (tags.length) {
        lines.push(`- 标签: ${tags.slice(0, 20).join(", ")}`);
      }
    }
    catch (e) {}

    const abstract = this._field(item, "abstractNote");
    if (abstract) {
      lines.push(`- 摘要: ${abstract.replace(/\s+/g, " ").slice(0, 1500)}`);
    }

    const extra = this._field(item, "extra");
    if (extra) {
      lines.push(`- 其他: ${extra.replace(/\s+/g, " ").slice(0, 500)}`);
    }

    return lines.join("\n");
  },

  /**
   * Build the context block for the current window selection.
   * Selected PDF text takes priority; metadata is appended when available.
   * Returns "" when there is neither.
   */
  build(win) {
    const parts = [];

    const selectionText = this.getReaderSelectionText(win);
    if (selectionText) {
      parts.push(
        "用户在 PDF 中选中的文本如下，回答时请优先依据这段文本：\n\"\"\"\n"
        + selectionText.slice(0, this.MAX_CHARS)
        + "\n\"\"\""
      );
    }

    const itemsText = this.buildItems(win);
    if (itemsText) {
      parts.push(itemsText);
    }

    return parts.join("\n\n");
  },

  buildItems(win) {
    const items = this.usefulItems(win);
    if (!items.length) {
      return "";
    }
    const blocks = [];
    let total = 0;
    for (let i = 0; i < items.length; i++) {
      const block = `### 文献 ${i + 1}\n${this.describe(items[i])}`;
      if (total + block.length > this.MAX_CHARS) {
        break;
      }
      blocks.push(block);
      total += block.length;
    }
    if (!blocks.length) {
      return "";
    }
    return "以下是用户在 Zotero 中当前选中的文献元数据：\n\n" + blocks.join("\n\n");
  }
};
