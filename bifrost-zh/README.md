# Bifrost 控制台中文化

不改 Bifrost 本体，不需要 Go。在浏览器里把页面上的英文按词典替换成中文。右下角按钮可以在「中文 / EN」之间切换，选择会记住。

## 两种用法

**1. 通过 nginx 注入（已配好）**

打开 http://127.0.0.1:18082 ，用法和 8080 完全一样，只是多了中文。

- `nginx.conf` 的 18082 端口把 `/__zh/` 指到本目录。
- 返回 HTML 时，nginx 用 `sub_filter` 在 `</head>` 前插入 `<script src="/__zh/zh-bifrost.js">`。
- 18082 用 HTTP/1.1，并且支持 WebSocket，实时日志可以正常推送。
- 18081 仍然保持模拟生产的 HTTP/1.0 配置，专门留给故障测试用，没有改动。

**2. 浏览器用户脚本（不经过 nginx）**

1. 在 Chrome 或 Edge 装 Tampermonkey。
2. 新建脚本，把 `bifrost-zh.user.js` 的全部内容粘进去。
3. 直接访问 http://127.0.0.1:8080 就是中文。

这个文件已经内嵌了词典，不需要额外加载。

## 文件

| 文件 | 作用 |
|---|---|
| `hide-enterprise.js` | 隐藏企业版页面和销售卡片 |
| `zh-bifrost.js` | 翻译脚本：替换文本节点和 placeholder/title/aria-label，用 MutationObserver 跟踪页面更新，提供切换按钮 |
| `dict.json` | 合并后的词典，由 `build.py` 生成 |
| `parts/zh*.json` | 分批翻译的原始结果 |
| `overrides.json` | 手工修正，优先级最高 |
| `build.py` | 合并 parts 和 overrides，生成 `dict.json` 和 `bifrost-zh.user.js` |
| `bifrost-zh.user.js` | Tampermonkey 版，内嵌词典 |

## 隐藏企业版功能

nginx 同时注入了 `hide-enterprise.js`（只在 18082 生效，用户脚本版不包含）。它会隐藏开源版打开后只显示 "enterprise license" 提示的页面，清单是在 v2.4.0 上把菜单路由逐个打开实测出来的，共 28 个：

| 处理方式 | 页面 |
|---|---|
| 整组隐藏 | 告警、护栏、边缘控制、集群、自适应路由 |
| 治理组里隐藏 | 组织架构、用户、业务单元、用户预配（SCIM）、角色与权限、访问配置、项目、审计日志 |
| 模型组里隐藏 | 熔断器 |
| 一并隐藏 | 侧边栏底部的「预约演示」销售卡片 |

另外两点：

- 直接输入这些地址，会自动跳回日志页。
- 右下角「企业功能：已隐藏 / 显示中」按钮可以随时切换。

如果想换一种隐藏方式，或者升级 Bifrost 后有新增的企业页面，改 `hide-enterprise.js` 顶部的 `ENTERPRISE` 和 `GROUPS` 两个列表，然后刷新页面即可。

## 改翻译

1. 发现哪里翻得不对，或者还是英文，就在 `overrides.json` 里加一行 `"英文原文": "中文"`。
2. 运行下面的命令重新生成词典。
3. 刷新页面。不需要重启任何服务。

```bash
cd /Users/summer/Desktop/vibecoding/mlflow-bifrost-mock && .venv/bin/python bifrost-zh/build.py
```

## 限制

- **数据不翻译**：日志内容、模型名、User-Agent 这类数据本来就保持原样。
- **拼接句子可能漏掉**：前端把变量和英文拼在一起的句子，比如 "Deleted 3 keys"，只有写进了 `zh-bifrost.js` 里 `PATTERNS` 的格式才会翻译，其余会保留英文。
- **升级要重做词典**：词典是从 Bifrost v2.4.0 的前端代码里提取的。升级 Bifrost 后，新增的文案会显示英文，需要重新提取并翻译一次。
