# Zor — Zotero 右侧 DeepSeek 侧栏

把 DeepSeek 对话固定在 Zotero 窗口右侧，像 VSCode 里的 AI 侧栏一样常驻。
相比 zotero-gpt 之类，重点解决三件事：**对话历史持久化**、**PDF 划词/全文直接提问**、**固定在窗口边缘不遮挡**。

> A fixed right-side AI sidebar for Zotero, powered by DeepSeek. Chat history is persisted, and you can ask questions about the current PDF selection or a full PDF dropped into the sidebar.

## 功能

- **固定在窗口右侧**：主窗口和 PDF 独立阅读器都贴右边缘，宽度可拖动（280–720px）
- **关闭 / 打开**：右上角 `×` 收起，窗口右边缘中间的蓝色 `Z` 按钮一键展开，状态会记住
- **DeepSeek 对话**：流式输出，支持 `deepseek-flash`（含视觉）、`deepseek-v4-pro`、`deepseek-chat`、`deepseek-reasoner`；思考过程可折叠查看
- **完整历史记录**：会话自动存到本地 JSON，「历史」页可切换、删除、继续对话
- **选中条目上下文**：自动附带当前选中文献的标题、作者、年份、期刊、DOI、标签、摘要
- **PDF 划词提问**：在阅读器里选中文字，侧栏自动显示「PDF 选中：…」，提问优先依据这段文本
- **拖入 PDF / 文本**：把 PDF、txt、md 拖进侧栏，自动提取全文作为对话资料（最多 60 页）
- **图片输入**：Ctrl+V 粘贴截图或拖入图片，配合 `deepseek-flash` 识图
- **跟随 Zotero 主题**：使用 Zotero 自身 CSS 变量，浅色 / 深色自动适配

## 安装

1. 下载 Releases 里的 `zor.xpi`
2. Zotero →「工具 → 插件」→ 右上角齿轮 → **Install Plugin From File…**
3. 选择 `zor.xpi`，重启 Zotero

要求 Zotero 7 及以上（在 Zotero 10.0.7 上开发与测试）。

## 配置

打开侧栏「设置」：

| 项 | 说明 |
| --- | --- |
| API Key | DeepSeek 的 API Key，只保存在本机 Zotero prefs 里 |
| 接口地址 | 默认 `https://api.deepseek.com/v1`，可换成任何 OpenAI 兼容服务 |
| 模型 | 默认 `deepseek-flash`；识图必须用它，复杂推理可用 `deepseek-v4-pro` |
| 温度 | 0–2；`deepseek-reasoner` 与思考模式会忽略该值 |
| 系统提示 | 模型的人设与回答规则 |

填好点「保存」，再点「测试连接」。

## 使用

- **问选中文献**：选中条目直接提问，自动带元数据
- **问 PDF 某段**：在 PDF 里划词 → 侧栏出现「PDF 选中：…」→ 提问
- **问整篇 PDF**：把 PDF 拖进侧栏，出现文件 chip 后提问，可连续追问
- **识图**：截图后 Ctrl+V 粘贴，或把图片拖进来，提问
- **换会话**：「历史」页切换或删除；「＋ 新对话」开新会话

## 数据与隐私

- 对话记录：`<Zotero 数据目录>/zor/chats.json`（设置页底部显示完整路径）
- API Key：保存在 Zotero 的 `extensions.zor.apiKey` 设置里，不写入对话记录
- 图片不写入历史，只随当次请求发送
- 插件本身不向任何第三方发送数据，只有你主动发起的 DeepSeek 请求会携带内容

## 开发

源码在 `src/`，Zotero 可以直接从源码目录加载：

1. 关闭 Zotero
2. 在 Zotero profile 的 `extensions/` 下新建无扩展名文件 `zor@deepseek.local`，内容为 `src` 目录的绝对路径
3. 删除 `prefs.js` 里含 `extensions.lastAppBuildId`、`extensions.lastAppVersion` 的行
4. 启动 Zotero，「工具 → 插件」里应能看到 Zor

### 构建

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

产物在 `dist/zor.xpi`。

### 测试

```bash
node test/run-tests.js
```

离线验证会话存储与恢复、损坏文件兜底、选中文献上下文拼装、消息构造、接口地址规范化、模型参数处理。

## 目录

```
src/
  manifest.json     插件清单
  bootstrap.js      Zotero 插件生命周期入口
  prefs.js          默认设置
  zor.js            侧栏 UI 与交互
  zor.css           样式（使用 Zotero 主题变量）
  zor-api.js        DeepSeek 流式请求
  zor-store.js      对话持久化
  zor-context.js    选中文献 / PDF 选中 / 拖入文件上下文
test/run-tests.js   离线测试
build.ps1           打包成 dist/zor.xpi
```

## 已知限制

- 只挂在主窗口和独立 PDF 阅读器窗口；Zotero 内部其它特殊窗口没有侧栏
- PDF 全文提取最多 60 页、发送时最多 2 万字，超出会截断
- 扫描版 PDF 没有文字层，提取不到文字，需要截图识图
- 一个会话里的图片不写入历史（避免文件过大）

## License

MIT
