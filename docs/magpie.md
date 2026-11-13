# 插件设置与常见问题

在 magpie 中打开「Claude 中文」。页面分为「语言设置」和「资源维护」两个标签，浏览器工作台也使用同一套页面。

「语言设置」选择简体或繁体，并启用或停用「启动时自动中文」。改动即保存，下次打开 Claude 生效，当前窗口的语言保持原样。「资源维护」查看状态、检查兼容性和导入语言缓存，应用路径与高级操作按需展开。

设置保存在插件自己的状态目录中，两边共用；不写入 Claude 的会话或历史文件。浏览器入口由 `claude_zh_workbench` 工具提供，会话地址仅供自己使用。

使用时保持 magpie 运行，从原来的 Claude 入口打开即可。Claude 4.x 使用 `ion-dist.asar`，插件只读加载；工作台中的「写入语言资源」只适用于旧版未打包目录。

## 查看版本

已安装版本在 magpie 的插件详情中查看。当前公开版本见 [npm](https://www.npmjs.com/package/magpie-claude-zh)，版本说明见 [GitHub Releases](https://github.com/polang233/claude-desktop-zh/releases)。反馈时请附上插件版本、Claude 版本和加载状态。

## 没有出现准备完成通知

先确认 Claude 已通过「文件 → 退出」完全退出；关闭窗口可能只是缩到托盘。Windows 通知也可能被系统通知设置隐藏。

可在 magpie 中通过 `claude_zh_sync_status` 查看状态：`waiting-for-normal-exit` 表示仍在等待退出，`watching` 表示已准备好，`Applied` 表示本次中文已加载。

## 启动时弹出窗口

加载中文时会短暂打开调试窗口和文件选择框。请保持 Claude 在前台，等待它们自动收起；如果停住，保留现场并记录插件状态。

## Claude 更新后没有加载中文

在 magpie 中关闭再启用插件，让它重新检查语言资源和前端路径。仍失败时，请附上 Claude 版本和插件状态反馈。

## macOS 支持

目前只支持只读检查和计划，不修改应用资源或签名，因此不能完成自动汉化。

[安装步骤](first-install.md) · [返回 README](../README.md)
