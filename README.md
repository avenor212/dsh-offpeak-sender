# 错峰发送 · dsh-offpeak-sender

DeepSeek Harness（DSH）Web 插件：按 **模型 + 日历规则 + 时段** 判断「现在是否峰价」，在峰价时段拦截输入框的发送动作，弹窗让你决定 **算了 / 现在做 / 等等再做**。选「等等再做」的消息进入该会话独有的队列，谷价开始后自动发出。

所有判断只使用本机时钟与本地节假日表，不发起任何模型请求，也不经过 Agent API。

![DSH Web 插件](icon.svg)

## 安装

插件是一个标准 DSH bundle 包：`package.json` 声明 `dsh.bundle.patch`，`cordis.patch.yml` 插入一行 `dsh-offpeak-sender`，Client 半（`client.js`）在 Web 页面里注册 UI，Host 半（`index.js`）是空 `apply`。没有构建步骤，也没有原生依赖。

> 若此前用本地 `link:` 安装过同一插件（包名可能显示为 `@local/offpeak-sender`），请先卸载旧包再装本包：两个实例会先后包装 Composer 的 `sendSession`，后激活者覆盖前者，容易出现重复弹窗或队列行为异常。

### 方式 A：插件管理器（推荐）

在 DSH Web 里打开 **设置 → 插件**（Plugin Manager），选择安装 bundle，target 填：

```
github:qwq20002/dsh-offpeak-sender
```

插件管理器会完成依赖安装、bundle 注册与激活。

### 方式 B：命令行（pnpm）

```powershell
dsh plugin --profile web add github:qwq20002/dsh-offpeak-sender
```

然后在该 profile 的 `package.json` 里把包名加入 bundle 列表，让 patch 参与配置树组装：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-offpeak-sender"]
    }
  }
}
```

重启 `dsh web` 后生效。

### 方式 C：本地目录（改源码时用）

```powershell
git clone https://github.com/qwq20002/dsh-offpeak-sender
dsh plugin --profile web add link:D:\path\to\dsh-offpeak-sender
```

同样把 `dsh-offpeak-sender` 加进 `dsh.profile.bundles`。`link:` 安装是指向源码目录的符号链接，改完刷新页面即可，无需重装。

### 卸载

```powershell
dsh plugin --profile web remove dsh-offpeak-sender
```

并从 `dsh.profile.bundles` 中删掉包名。浏览器里残留的本地数据可用「设置 → 错峰发送 → 清空队列」或在开发者工具里删除 `dsh.offpeak-sender.*` 两个 localStorage 键。

### 安装后自检

- 设置页应出现「错峰发送」分组，标题与设置为中英文；
- 插件列表里该条目的标题 / 描述 / 图标来自本包的 `locale/*.json` 与 `icon.svg`；
- 设置页顶部「运行状态」为绿点，表示发送拦截器已挂上。

## 峰价怎么算

一条规则 = 供应商 + 模型名称 + 日历规则 + 一组时段。发送时命中峰价需要同时满足：

1. 当前会话的模型匹配 `provider` / `model`（都从 Host 的模型目录中选择，也可以选「任意」）；
2. 今天的日历类型匹配规则（默认「法定工作日」）；
3. 当前时间落在该规则的某个时段内。

供应商与模型不再手输：设置页读取 Host 的 `remote.session.modelCatalog()`，供应商下拉列出所有 provider，模型下拉随所选供应商收窄；选「任意」表示不限制。插件在 `inject` 里声明了 `remote.session`，否则访问会报 `cannot get property "remote.session" without inject`。目录读取失败时页面会显示原因并提供「重试」；旧配置里无法识别的供应商/模型仍会作为当前值显示，不会被丢弃。

日历规则也改成了可直接点选的选项（法定工作日 / 法定节假日 / 周末 / 周一至周五 / 每天），每个选项旁有说明；每组下面还会写「今天 11-09 周日 · 周末（不命中该规则）· 此刻 非峰价」，标题区的「套用 DeepSeek 官方峰价」可一键设为 `09:00–12:00`、`14:00–18:00`（官方口径，参考了 dsh-whale-widget 的实现）。

支持的日历规则：

| 规则 | 含义 |
| --- | --- |
| 法定工作日 | 排除法定节假日；调休上班日算工作日（默认） |
| 法定节假日 | 国务院公布的放假日；调休上班日不算 |
| 周末 | 周六、周日，不看节假日 |
| 周一至周五 | 只看星期，不看节假日 |
| 每天 | 与日历无关，等价于纯时段规则 |

时段支持一天多段（如 `08:00-12:00`、`14:00-18:00`），也支持跨零点（`22:00 → 06:00`，归属于开始的那一天）。

## 内置节假日数据

中国大陆，覆盖 **2024–2027 年**，均为国务院办公厅通知原文：

| 年 | 发布 | 春节 | 国庆 | 调休上班日 |
| --- | --- | --- | --- | --- |
| 2024 | 2023-10-25 | 2/10–2/17（8 天） | 10/1–10/7 | 2/4、2/18、4/7、4/28、5/11、9/14、9/29、10/12 |
| 2025 | 2024-11-12 | 1/28–2/4（8 天） | 10/1–10/8（含中秋） | 1/26、2/8、4/27、9/28、10/11 |
| 2026 | 2025-11-04 | 2/15–2/23（9 天） | 10/1–10/7 | 1/4、2/14、2/28、5/9、9/20、10/10 |
| 2027 | 2026-11-05 | 2/5–2/13（9 天） | 10/1–10/7 | 1/31、2/14、5/8、9/26、10/9 |

来源：[2024 年通知](https://www.gov.cn/gongbao/2023/issue_10806/202311/content_6913823.html)、[2025 年通知](https://m.gmw.cn/2024-11/12/content_1303894988.htm)、[2026 年通知](https://app.xinhuanet.com/news/article.html?articleId=8390cfcefd8c22d3158110263a22505c)、[2027 年通知](https://www.gov.cn/zhengce/content/202611/content_7085101.htm)。

设置页底部的「中国大陆节假日数据」可以查看每年天数、编辑任意一年的节假日与调休上班日，或新增未来年份（每行 `YYYY-MM-DD` 或 `YYYY-MM-DD 名称`）。自定义数据优先于内置数据，可随时「恢复内置」。

## 行为

- **拦截点**：普通消息发送（Composer 的 `conversation.sendSession`）；斜杠命令不拦截。
- **三个选择**
  - 算了：不发送，草稿与附件保留在输入框；
  - 现在做：立即发送（原样带上附件与投递模式）；
  - 等等再做：入队，弹窗与队列条都会显示距谷价（当前时段结束）的倒计时。
- **队列**：每个会话独立；保存在浏览器 `localStorage`，刷新页面后恢复。
- **发送策略**（设置页切换）
  - 每轮对话结束后发送下一条（默认）：发一条，等这一轮结束再发下一条；
  - 合并成一条发送：合并排队的纯文本；带附件的消息仍逐条发送。
- **失败处理**：失败行显示红色提示与「重试」；连续失败 3 次后停止自动重试，等你处理。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半：空 `apply`，仅让 bundle 有可挂载的行 |
| `client.js` | 全部实现：日历与时段判断、发送拦截、队列、设置页、弹窗、队列条 |
| `cordis.patch.yml` | 插入 `dsh-offpeak-sender` 行 |
| `locale/*.json` | 插件列表里的标题与描述（en/zh） |
| `icon.svg` | 原创图标 |
| `test/*.test.mjs` | 61 项离线检查（含 6 项激活健壮性） |

本地数据：`dsh.offpeak-sender.config.v1`、`dsh.offpeak-sender.queue.v1`（浏览器 localStorage）。

## 加载失败与自恢复

早期版本在插件激活时就同步调用 `remote.session.modelCatalog()` 拉取模型目录；页面在连接建立之前激活插件时，这个调用会**同步抛错**，导致 `apply` 抛错、插件加载失败、页面卡住。现在改成：

- 模型目录**不在激活路径上加载**：只在打开设置页、或连接重建（`connection/reset`）后加载；
- 目录加载失败只降级为设置页里的原因提示与「重试」，不影响插件其它功能；
- 每个可选步骤（样式、语言包、发送拦截、定时器、目录）单独隔离，失败记录在设置页「运行状态」；
- 4 个 UI 扩展点**最先注册**，任何后续步骤失败都不会让设置页消失；
- `apply` 最外层还有兜底，异常不会再抛给 DSH。

排查时先看设置 → 错峰发送 →「运行状态」：绿点是拦截器已挂上；若出现「加载时有步骤失败」，那一行会写出失败的步骤名与原因。

## 已知边界

- 只拦截普通消息；命令与队列条的手动 Steer 不走这里。
- 节假日数据只到 2027 年；更晚的年份按「周一至周五」退化判断，请到设置页补充。
- 跨零点的时段归属开始日：例如工作日 22:00–06:00，次日凌晨仍按劳动日规则算峰价。
- 判峰价用本机时钟，不校正时区；请让系统时区与计费时区（默认北京时间）一致。
- 旧版本留下的「未改动默认规则」（每天 08:30–00:30）会自动迁移为新的法定工作日规则；手动改过的规则保持原样，只补上「每天」。
- 多标签页同时打开时各页各有一份队列。
- 与其它包装 `conversation.sendSession` 的插件不共存（后激活者覆盖前者）。
- 目前只有中国大陆数据；`region` 字段与 `CALENDARS` 表按地区组织，扩充其他国家只需新增数据表。

## 开发

```powershell
npm install                  # 只有 render 测试需要 React（devDependency）
npm test                     # 一次跑完 61 项离线检查

node test/logic.test.mjs      # 日历、调休、跨零点、时段、序列化
node test/runtime.test.mjs    # 拦截、三种选择、队列发送、重试上限、卸载恢复
node test/render.test.mjs     # 用真实 React 渲染设置页 / 队列条 / 弹窗
node test/copy.test.mjs       # 中英文案完整性与 manifest
node test/robustness.test.mjs # 激活路径健壮性（含 6 项失败隔离）
```

全部为离线检查，不需要启动 DSH、不联网。`render.test.mjs` 从本包的 `node_modules` 解析 React；没有安装时可用 `DSH_REACT_DIR=<含 react 的目录>` 指定，两样都没有会打印 `SKIP` 跳过（CI 里装了 devDependencies，因此不会跳过）。

## 许可

MIT，见 [LICENSE](LICENSE)。
