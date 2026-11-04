/**
 * ZorStore — persisted chat history.
 *
 * Layout (JSON, under the Zotero data directory):
 *   <dataDir>/zor/chats.json
 *   {
 *     version: 1,
 *     activeId: "s_...",
 *     sessions: [{
 *       id, title, createdAt, updatedAt,
 *       messages: [{ role, content, reasoning, ts }]
 *     }]
 *   }
 */
var ZorStore = {
  _dir: null,
  _path: null,
  _data: null,
  _saveTimer: null,
  _saving: null,

  MAX_SESSIONS: 200,

  get dir() {
    return this._dir;
  },

  async init() {
    this._dir = PathUtils.join(Zotero.DataDirectory.dir, "zor");
    await IOUtils.makeDirectory(this._dir, { ignoreExisting: true });
    this._path = PathUtils.join(this._dir, "chats.json");
    this._data = await this._read();
    return this._data;
  },

  async _read() {
    try {
      const raw = await IOUtils.readUTF8(this._path);
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.sessions)) {
        return {
          version: 1,
          activeId: parsed.activeId || (parsed.sessions[0] && parsed.sessions[0].id) || null,
          sessions: parsed.sessions.map(s => this._normalizeSession(s))
        };
      }
    }
    catch (e) {
      // Missing or corrupt file: start fresh rather than dying.
      if (!(e instanceof Error) || !/NotFound|No such file|NS_ERROR_FILE_NOT_FOUND/.test(String(e))) {
        Zotero.logError(e);
      }
    }
    return { version: 1, activeId: null, sessions: [] };
  },

  _normalizeSession(s) {
    return {
      id: s.id || this.newId(),
      title: s.title || "未命名对话",
      createdAt: s.createdAt || Date.now(),
      updatedAt: s.updatedAt || s.createdAt || Date.now(),
      messages: Array.isArray(s.messages) ? s.messages.map(m => ({
        role: m.role,
        content: typeof m.content === "string" ? m.content : "",
        reasoning: typeof m.reasoning === "string" ? m.reasoning : "",
        error: typeof m.error === "string" ? m.error : "",
        ts: m.ts || Date.now()
      })) : []
    };
  },

  get sessions() {
    return this._data.sessions;
  },

  get activeId() {
    return this._data.activeId;
  },

  set activeId(id) {
    this._data.activeId = id;
    this.scheduleSave();
  },

  get activeSession() {
    return this.sessions.find(s => s.id === this._data.activeId) || null;
  },

  newId() {
    return "s_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  },

  createSession() {
    const now = Date.now();
    const session = {
      id: this.newId(),
      title: "新对话",
      createdAt: now,
      updatedAt: now,
      messages: []
    };
    this.sessions.unshift(session);
    this._data.activeId = session.id;
    this._trim();
    this.scheduleSave();
    return session;
  },

  deleteSession(id) {
    const idx = this.sessions.findIndex(s => s.id === id);
    if (idx === -1) {
      return;
    }
    this.sessions.splice(idx, 1);
    if (this._data.activeId === id) {
      this._data.activeId = this.sessions[0] ? this.sessions[0].id : null;
    }
    this.scheduleSave();
  },

  clearAll() {
    this._data.sessions = [];
    this._data.activeId = null;
    this.scheduleSave();
  },

  addMessage(session, message) {
    if (!session) {
      return;
    }
    const msg = Object.assign({ ts: Date.now() }, message);
    session.messages.push(msg);
    session.updatedAt = Date.now();
    if (!session.title || session.title === "新对话") {
      const firstUser = session.messages.find(m => m.role === "user");
      if (firstUser && firstUser.content) {
        session.title = firstUser.content.replace(/\s+/g, " ").trim().slice(0, 40) || "新对话";
      }
    }
    // Keep the active session at the top of the list, most recent first.
    const idx = this.sessions.indexOf(session);
    if (idx > 0) {
      this.sessions.splice(idx, 1);
      this.sessions.unshift(session);
    }
    this._trim();
    this.scheduleSave();
    return msg;
  },

  _trim() {
    if (this.sessions.length > this.MAX_SESSIONS) {
      this.sessions.length = this.MAX_SESSIONS;
    }
  },

  scheduleSave() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
    }
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._save().catch(e => Zotero.logError(e));
    }, 250);
  },

  async flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    await this._save();
  },

  async _save() {
    if (!this._path) {
      return;
    }
    // Serialize saves; a save requested while another runs is picked up by the
    // next call after it settles.
    if (this._saving) {
      await this._saving.catch(() => {});
    }
    const work = (async () => {
      const tmp = this._path + ".tmp";
      const payload = JSON.stringify(this._data);
      await IOUtils.writeUTF8(tmp, payload);
      await IOUtils.move(tmp, this._path);
    })();
    this._saving = work;
    try {
      await work;
    }
    finally {
      if (this._saving === work) {
        this._saving = null;
      }
    }
  }
};
