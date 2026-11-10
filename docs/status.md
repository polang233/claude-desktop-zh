# 当前状态

2026-11-10，版本 `1.0.0`。Windows 使用运行时方式加载中文，不写入商店应用目录；Claude 4.x 的 `ion-dist.asar` 已支持。

| 项目 | 验证范围 |
| --- | --- |
| Claude 4.x 简体自动加载 | Magpie `1.0.0`、新进程 `48180` 返回 `Applied`，界面为简体 |
| Claude 4.x 繁体 | 新进程首次自动尝试返回 `FocusChanged`；取消文件框后 `ApplyOnce` 返回 `Applied`，界面为繁体 |
| 语言资源 | 官方简体/繁体基础各匹配 42,171/42,170 条（约 98.8%），动态 51/51 |
| 前端归档 | Windows 商店版 `ion-dist.asar` 文件表、运行时 JS、`en-US` 资源解析通过 |
| Magpie 本地安装 | 依赖固定为本地 `1.0.0` tarball，重启后未被 npm `0.1.1` 覆盖 |
| 旧版资源写入 | 仅适用于未打包旧目录；商店应用明确拒绝写入 |
| macOS | `.app` 发现、`ion-dist.asar` 检查、手动 `runtime-export` 夹具通过；未在 Mac 实机验证，自动注入未实现 |

本轮完整回归 159 项：158 通过、0 失败、1 项文件 symlink 环境跳过。Windows 4.x 自动加载已实测；繁体首次自动尝试仍有文件框焦点瞬态，手动重试成功。macOS 自动启动不在本版本范围内。

证据保存在本地 `.handoff` 和 `.local`，不提交私人路径和语言资源。

历史实机过程见[验证记录](validation.md)和[交接](../HANDOFF.md)。
