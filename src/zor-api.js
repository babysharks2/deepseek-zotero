/**
 * ZorAPI — streaming chat against a DeepSeek / OpenAI-compatible endpoint.
 *
 * Uses XMLHttpRequest instead of fetch so that incremental `responseText`
 * keeps working inside the Zotero sandbox (no ReadableStream required).
 */
var ZorAPI = {
  DEFAULT_BASE_URL: "https://api.deepseek.com/v1",
  DEFAULT_MODEL: "deepseek-flash",
  DEFAULT_PROMPT: "你是运行在 Zotero 里的文献助手。回答要准确、简洁、有条理。",
  TIMEOUT: 180000,
  HISTORY_CHAR_BUDGET: 80000,

  config() {
    const get = (name, fallback) => {
      try {
        const value = Zotero.Prefs.get("extensions.zor." + name, true);
        return value === undefined || value === null ? fallback : value;
      }
      catch (e) {
        return fallback;
      }
    };
    const temperature = parseFloat(String(get("temperature", "0.7")));
    return {
      apiKey: String(get("apiKey", "") || "").trim(),
      baseURL: String(get("baseURL", this.DEFAULT_BASE_URL) || this.DEFAULT_BASE_URL).trim().replace(/\/+$/, ""),
      model: String(get("model", this.DEFAULT_MODEL) || this.DEFAULT_MODEL).trim(),
      temperature: Number.isFinite(temperature) ? temperature : 0.7,
      maxTokens: parseInt(get("maxTokens", 0), 10) || 0,
      systemPrompt: String(get("systemPrompt", this.DEFAULT_PROMPT) || this.DEFAULT_PROMPT),
      sendContext: get("sendContext", true) !== false
    };
  },

  isConfigured() {
    const config = this.config();
    return !!config.apiKey && !!config.baseURL && !!config.model;
  },

  endpoint(config) {
    const base = config.baseURL || this.DEFAULT_BASE_URL;
    // Accept both "https://api.deepseek.com" and ".../v1" style bases.
    if (/\/chat\/completions$/.test(base)) {
      return base;
    }
    return base + "/chat/completions";
  },

  currentSessionMessages(session) {
    if (!session) {
      return [];
    }
    return session.messages.filter(m => (m.role === "user" || m.role === "assistant") && m.content);
  },

  buildMessages(session, contextText, images) {
    const config = this.config();
    const system = [config.systemPrompt];
    if (contextText) {
      system.push(contextText);
    }
    const messages = [{ role: "system", content: system.join("\n\n") }];

    const history = this.currentSessionMessages(session);
    let budget = this.HISTORY_CHAR_BUDGET;
    const picked = [];
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      const size = msg.content.length;
      if (picked.length && budget - size < 0) {
        break;
      }
      budget -= size;
      picked.unshift({ role: msg.role, content: msg.content });
    }
    const all = messages.concat(picked);

    // Attach images to the most recent user message as OpenAI-compatible
    // multimodal content blocks (DeepSeek `deepseek-flash` supports this).
    if (images && images.length) {
      for (let i = all.length - 1; i >= 0; i--) {
        if (all[i].role !== "user") {
          continue;
        }
        const parts = [{ type: "text", text: all[i].content }];
        for (const url of images) {
          parts.push({ type: "image_url", image_url: { url, detail: "auto" } });
        }
        all[i] = { role: "user", content: parts };
        break;
      }
    }

    return all;
  },

  payload(messages, stream) {
    const config = this.config();
    const body = {
      model: config.model,
      messages,
      stream: !!stream
    };
    if (!/reasoner/i.test(config.model)) {
      body.temperature = config.temperature;
    }
    if (config.maxTokens > 0) {
      body.max_tokens = config.maxTokens;
    }
    return body;
  },

  _parseError(status, text) {
    let detail = "";
    try {
      const json = JSON.parse(text);
      detail = (json.error && (json.error.message || json.error.type)) || json.message || "";
    }
    catch (e) {
      detail = String(text || "").slice(0, 400);
    }
    const message = detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`;
    return new Error(message);
  },

  /**
   * Start a streaming chat completion.
   * @returns {{abort: Function}}
   */
  stream({ session, contextText, images, onDelta, onReasoning, onStart, onDone, onError }) {
    const config = this.config();
    if (!config.apiKey) {
      const err = new Error("还没有填写 DeepSeek API Key，请到「设置」里填写。");
      setTimeout(() => onError && onError(err), 0);
      return { abort() {} };
    }

    const messages = this.buildMessages(session, contextText, images);
    const xhr = new XMLHttpRequest();
    let closed = false;
    let consumed = 0;
    let gotContent = false;
    const self = this;

    const parser = {
      buffer: "",
      done: false,
      finishReason: null,
      push(chunk) {
        this.buffer += chunk;
        let index;
        while ((index = this.buffer.indexOf("\n")) !== -1) {
          let line = this.buffer.slice(0, index);
          this.buffer = this.buffer.slice(index + 1);
          if (line.endsWith("\r")) {
            line = line.slice(0, -1);
          }
          this.line(line);
        }
      },
      flush() {
        if (this.buffer.trim()) {
          this.line(this.buffer);
        }
        this.buffer = "";
      },
      line(line) {
        if (!line) {
          return;
        }
        let payload;
        if (line.startsWith("data:")) {
          payload = line.slice(5).trim();
        }
        else if (line.startsWith("{")) {
          payload = line.trim();
        }
        else {
          return;
        }
        if (!payload || payload === "[DONE]") {
          if (payload === "[DONE]") {
            this.done = true;
          }
          return;
        }
        let json;
        try {
          json = JSON.parse(payload);
        }
        catch (e) {
          return;
        }
        if (json.error) {
          const message = json.error.message || json.error.type || "接口返回错误";
          self._failed(new Error(message));
          return;
        }
        const choice = json.choices && json.choices[0];
        if (!choice) {
          return;
        }
        if (choice.finish_reason) {
          this.finishReason = choice.finish_reason;
        }
        const delta = choice.delta || choice.message || {};
        if (delta.reasoning_content) {
          onReasoning && onReasoning(delta.reasoning_content);
        }
        if (delta.content) {
          gotContent = true;
          onDelta && onDelta(delta.content);
        }
      }
    };

    const finish = () => {
      if (closed) {
        return;
      }
      closed = true;
      try {
        parser.flush();
      }
      catch (e) {
        Zotero.logError(e);
      }
      if (gotContent || parser.done || parser.finishReason) {
        onDone && onDone({ finishReason: parser.finishReason });
      }
      else {
        onError && onError(new Error("模型没有返回内容（可能是模型名或接口地址不对）。"));
      }
    };

    const fail = (error) => {
      if (closed) {
        return;
      }
      closed = true;
      onError && onError(error);
    };

    self._failed = fail;

    try {
      xhr.open("POST", this.endpoint(config), true);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.setRequestHeader("Authorization", "Bearer " + config.apiKey);
      xhr.setRequestHeader("Accept", "text/event-stream");
      xhr.responseType = "text";
      xhr.timeout = this.TIMEOUT;
    }
    catch (e) {
      setTimeout(() => fail(e), 0);
      return { abort() {} };
    }

    xhr.onprogress = () => {
      if (closed) {
        return;
      }
      const text = xhr.responseText || "";
      if (text.length > consumed) {
        const chunk = text.slice(consumed);
        consumed = text.length;
        try {
          parser.push(chunk);
        }
        catch (e) {
          Zotero.logError(e);
        }
      }
    };

    xhr.onload = () => {
      if (closed) {
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        finish();
      }
      else {
        fail(this._parseError(xhr.status, xhr.responseText || ""));
      }
    };

    xhr.onerror = () => fail(new Error("网络请求失败，请检查接口地址或代理设置。"));
    xhr.ontimeout = () => fail(new Error("请求超时。"));
    xhr.onabort = () => {
      if (!closed) {
        closed = true;
        onDone && onDone({ aborted: true });
      }
    };

    if (onStart) {
      onStart();
    }
    try {
      xhr.send(JSON.stringify(this.payload(messages, true)));
    }
    catch (e) {
      setTimeout(() => fail(e), 0);
    }

    return {
      abort() {
        try {
          if (!closed) {
            closed = true;
            xhr.abort();
          }
        }
        catch (e) {
          Zotero.logError(e);
        }
      }
    };
  },

  /** Non-streaming probe used by the "test connection" button. */
  test() {
    return new Promise((resolve, reject) => {
      const config = this.config();
      if (!config.apiKey) {
        reject(new Error("还没有填写 API Key。"));
        return;
      }
      const xhr = new XMLHttpRequest();
      try {
        xhr.open("POST", this.endpoint(config), true);
        xhr.setRequestHeader("Content-Type", "application/json");
        xhr.setRequestHeader("Authorization", "Bearer " + config.apiKey);
        xhr.timeout = 30000;
      }
      catch (e) {
        reject(e);
        return;
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const json = JSON.parse(xhr.responseText || "{}");
            const model = (json.model || config.model) + "";
            resolve(`连接成功（模型：${model}）`);
          }
          catch (e) {
            resolve("连接成功");
          }
        }
        else {
          reject(this._parseError(xhr.status, xhr.responseText || ""));
        }
      };
      xhr.onerror = () => reject(new Error("网络请求失败，请检查接口地址。"));
      xhr.ontimeout = () => reject(new Error("请求超时。"));
      const messages = [
        { role: "system", content: "Reply with the single word: pong" },
        { role: "user", content: "ping" }
      ];
      xhr.send(JSON.stringify(this.payload(messages, false)));
    });
  }
};
