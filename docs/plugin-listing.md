# 喜鹊插件收录

2026-11-13 核对。项目使用 npm 包 `magpie-claude-zh`，本次申请版本为 `1.1.0`。

## 申请方式

向 [magpie-community/plugins](https://github.com/magpie-community/plugins) 提交修改 `registry.json` 的 Pull Request。条目包含包名、显示名称、图标和中英文简介。本项目属于页面插件，使用 `"kind": "page"`，不填写供应商 `providers`。

保留独立仓库和现有 npm 包名即可申请。外部包不填写 `community: true`；收录后显示自己的作者，社区徽章留给社区维护的包。若要转为社区维护，需要另行贡献到上游 `packages/`，这与独立包收录是两个流程。

现有 GitHub `magpie-plugin` topic 会让项目进入非官方发现列表；它不是人工审核通过标记。

## 我们的申请内容

- 名称：Claude 中文。
- 包名：`magpie-claude-zh`。
- 分类：页面，同时提供状态和资源维护工具。
- 功能：为 Windows 原版 Claude Desktop 的第三方 Gateway 模式加载官方简体或繁体中文，沿用原配置、会话和历史。
- 运行条件：Node.js 22+，喜鹊保持运行。
- 本机操作：首次等待 Claude 正常退出，备份应用设置并开启 `allowDevTools`；后续启动短暂打开开发者工具和本地文件选择框加载语言。
- 实测范围：Claude 4.23118.1.0 简体自动加载通过；繁体在文件框焦点失败后手动重试成功。macOS 自动加载尚未实现。

## 审核准备

上游提供 `scripts/registry.mjs` 校验条目格式，`scripts/check.mjs` 检查插件加载与接口。建议附上公开源码、npm 链接、运行条件、数据读写范围、测试结果和已知问题，便于维护者审阅。公开说明没有承诺固定审核时长，也没有保证通过的分数或下载量门槛。

本次申请条目已使用上游校验器验证，通过格式检查。它代表条目可被读取，最终收录由上游维护者决定。

来源：[上游 README 的 The market](https://github.com/magpie-community/plugins#the-market)、[官方发布与收录文档](https://usemagpie.ai/docs/plugins#publishing)、[条目校验器](https://github.com/magpie-community/plugins/blob/main/scripts/registry.mjs)。
