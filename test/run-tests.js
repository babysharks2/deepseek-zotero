/**
 * Offline tests for Zor's pure modules (no Zotero window required).
 * Run: node test/run-tests.js
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const vm = require("vm");
const assert = require("assert");

const root = path.resolve(__dirname, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zor-test-"));
const prefs = new Map();

const Zotero = {
  DataDirectory: { dir: dataDir },
  Prefs: {
    get(key) {
      return prefs.has(key) ? prefs.get(key) : undefined;
    },
    set(key, value) {
      prefs.set(key, value);
    }
  },
  ItemTypes: { getName: () => "journalArticle" },
  logError(error) {
    console.error("[zotero error]", error);
  },
  debug() {}
};

const IOUtils = {
  async makeDirectory(target) {
    await fs.promises.mkdir(target, { recursive: true });
  },
  readUTF8: target => fs.promises.readFile(target, "utf8"),
  writeUTF8: (target, contents) => fs.promises.writeFile(target, contents, "utf8"),
  async move(from, to) {
    await fs.promises.rename(from, to);
  }
};

const PathUtils = { join: (...parts) => path.join(...parts) };

const context = vm.createContext({
  Zotero,
  IOUtils,
  PathUtils,
  console,
  setTimeout,
  clearTimeout,
  Date,
  Math,
  JSON,
  Error,
  Promise
});

function load(file, globalName) {
  const code = fs.readFileSync(path.join(root, "src", file), "utf8");
  vm.runInContext(`${code}\n;globalThis.__${globalName} = ${globalName};`, context, { filename: file });
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

async function main() {
  load("zor-store.js", "ZorStore");
  load("zor-context.js", "ZorContext");
  load("zor-api.js", "ZorAPI");

  const ZorStore = context.__ZorStore;
  const ZorContext = context.__ZorContext;
  const ZorAPI = context.__ZorAPI;

  test("store: starts empty", async () => {
    const data = await ZorStore.init();
    assert.strictEqual(data.sessions.length, 0);
    assert.strictEqual(data.activeId, null);
  });

  test("store: create session and add messages", async () => {
    const session = ZorStore.createSession();
    assert.ok(session.id.startsWith("s_"));
    ZorStore.activeId = session.id;
    ZorStore.addMessage(session, { role: "user", content: "这篇文献讲了什么？" });
    ZorStore.addMessage(session, { role: "assistant", content: "它提出了……", reasoning: "先看摘要" });
    assert.strictEqual(session.messages.length, 2);
    assert.strictEqual(session.title, "这篇文献讲了什么？");
    await ZorStore.flush();
  });

  test("store: reload keeps history", async () => {
    const data = await ZorStore.init();
    assert.strictEqual(data.sessions.length, 1);
    assert.strictEqual(data.sessions[0].messages.length, 2);
    assert.strictEqual(data.sessions[0].messages[1].reasoning, "先看摘要");
    assert.strictEqual(data.activeId, data.sessions[0].id);
  });

  test("store: corrupted file falls back to empty", async () => {
    const file = path.join(dataDir, "zor", "chats.json");
    await fs.promises.writeFile(file, "{not json", "utf8");
    const data = await ZorStore.init();
    assert.strictEqual(data.sessions.length, 0);
  });

  test("store: delete session resets active id", async () => {
    const session = ZorStore.createSession();
    ZorStore.addMessage(session, { role: "user", content: "hi" });
    ZorStore.deleteSession(session.id);
    assert.strictEqual(ZorStore.sessions.length, 0);
    assert.strictEqual(ZorStore.activeId, null);
  });

  test("context: describes a selected item", async () => {
    const item = {
      itemTypeID: 1,
      isRegularItem: () => true,
      getField(name) {
        return {
          title: "Attention Is All You Need",
          date: "2017",
          publicationTitle: "NeurIPS",
          DOI: "10.5555/3295222.3295349",
          abstractNote: "We propose the Transformer."
        }[name] || "";
      },
      getCreators: () => [
        { firstName: "Ashish", lastName: "Vaswani" },
        { name: "Google Brain" }
      ],
      getTags: () => [{ tag: "transformer" }]
    };
    const win = { ZoteroPane: { getSelectedItems: () => [item] } };
    const text = ZorContext.build(win);
    assert.ok(text.includes("Attention Is All You Need"));
    assert.ok(text.includes("Vaswani"));
    assert.ok(text.includes("10.5555/3295222.3295349"));
    assert.strictEqual(ZorContext.summarize(win), "选中：Attention Is All You Need");
  });

  test("api: builds messages with system prompt, context and history", async () => {
    const session = ZorStore.createSession();
    ZorStore.addMessage(session, { role: "user", content: "第一个问题" });
    ZorStore.addMessage(session, { role: "assistant", content: "第一个回答" });
    ZorStore.addMessage(session, { role: "user", content: "第二个问题" });
    const messages = ZorAPI.buildMessages(session, "上下文：某文献");
    assert.strictEqual(messages[0].role, "system");
    assert.ok(messages[0].content.includes("上下文：某文献"));
    assert.strictEqual(messages.length, 4);
    assert.strictEqual(messages[3].content, "第二个问题");
  });

  test("api: endpoint normalizes base urls", async () => {
    const cases = [
      ["https://api.deepseek.com/v1", "https://api.deepseek.com/v1/chat/completions"],
      ["https://api.deepseek.com/v1/", "https://api.deepseek.com/v1/chat/completions"],
      ["https://api.deepseek.com", "https://api.deepseek.com/chat/completions"],
      ["http://127.0.0.1:8080/v1/chat/completions", "http://127.0.0.1:8080/v1/chat/completions"]
    ];
    for (const [base, expected] of cases) {
      prefs.set("extensions.zor.baseURL", base);
      assert.strictEqual(ZorAPI.endpoint(ZorAPI.config()), expected, base);
    }
  });

  test("api: reasoner model drops temperature", async () => {
    prefs.set("extensions.zor.model", "deepseek-reasoner");
    const body = ZorAPI.payload([], true);
    assert.strictEqual(body.temperature, undefined);
    prefs.set("extensions.zor.model", "deepseek-chat");
    const body2 = ZorAPI.payload([], true);
    assert.strictEqual(typeof body2.temperature, "number");
  });

  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    }
    catch (error) {
      failed++;
      console.error(`FAIL ${name}`);
      console.error(error);
    }
  }

  await fs.promises.rm(dataDir, { recursive: true, force: true });
  if (failed) {
    console.error(`\n${failed} test(s) failed`);
    process.exit(1);
  }
  console.log(`\n${tests.length} tests passed`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
