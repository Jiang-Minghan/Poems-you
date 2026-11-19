# 诗光与你 · 部署包

这是只包含**运行必需文件**的部署包：

```
shiguang-deploy/
├── server.js        # Node 服务、房间状态、SSE
├── package.json     # npm start；无第三方运行依赖
├── public/          # 前端页面、样式、脚本、16 组色卡
├── data/            # 诗库、88 联联句库、名句数据
├── Dockerfile       # 给 Koyeb / Uppcoder 等容器平台
└── render.yaml      # Render 免费 Web Service 的 Blueprint
```

`docs/`、`test/`、`tools/`、`qa/` 和根目录 README 都不在部署包里，它们不影响游戏运行。**不要只上传 `public/`**，因为房间和 SSE 都靠 `server.js`。`data/` 必须带；其中 `data/couplets.json` 是完整联句库，不能漏。

## 本机试跑

需要 Node.js 20 以上。不需要 `npm install`。

```bash
node server.js
# 或
npm start
```

默认地址：`http://127.0.0.1:8787`。换端口：

```bash
PORT=9000 node server.js
```

Windows PowerShell：

```powershell
$env:PORT=9000; node server.js
```

## 上传到公开互联网

这个项目不是纯静态网站，必须运行一个**常驻 Node 进程**。可选：

### 免费方案（先说结论）

- **Render Free**：不需要信用卡，HTTPS，512MB；空闲约 15 分钟后休眠，首次访问会冷启动，休眠会清空内存房间。仓库里已带 `render.yaml`，连接 GitHub 后选 **New → Blueprint** 即可。
- **Wispbyte**：免费 512MB / 1GB 磁盘，24/7 不休眠，不需要信用卡；欧洲节点，要求每两周登录保活；适合小范围朋友局，稳定性和访问速度不如正式云主机。
- **Uppcoder**：免费 2GB 常驻容器、自动 HTTPS、不需要信用卡；免费档每天约 500 CPU 秒，平台较新，长期稳定性需要观察；可用本包的 `Dockerfile`。
- 这些免费方案都不保证永久、不保证数据安全；房间在内存里，重启/休眠就清空。

**国内**：没有可靠的「永久免费 Node 托管」。腾讯云 CloudBase 的免费额度是 serverless/短时函数，不适合本项目的常驻 SSE 和内存房间；阿里云/腾讯云轻量的免费试用通常只有 1–3 个月，之后要付费。国内长期稳定建议买最低配轻量云服务器，或使用国内按量 Web 应用平台（例如帽子云，Node Web 应用约 ¥9.45/月起，新用户有体验金）。

### A. VPS / 云服务器（最直接）

1. 把本文件夹内容上传到服务器，例如 `/opt/shiguang`。
2. 安装 Node.js 20+。
3. 用 systemd / pm2 保持进程常驻，例如：

```ini
[Unit]
Description=shiguang
After=network.target

[Service]
WorkingDirectory=/opt/shiguang
ExecStart=/usr/bin/node /opt/shiguang/server.js
Environment=PORT=8787
Environment=HOST=0.0.0.0
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

4. 前面放 Caddy 或 Nginx 做 HTTPS 反向代理。Caddy 示例：

```caddyfile
your-domain.example {
    reverse_proxy 127.0.0.1:8787 {
        flush_interval -1
    }
}
```

`flush_interval -1` 很重要：SSE 需要不缓冲。Nginx 则要关闭该路径的 `proxy_buffering`，并把读超时调长。代码已经发送 `X-Accel-Buffering: no`，但代理配置仍应确认。

### B. Render / Railway / Fly 等 Node 平台

- 新建 **Web Service**（不要选 Static Site）。
- 根目录指向本文件夹。
- Build Command：留空，或 `npm install`（本包没有运行依赖）。
- Start Command：`npm start`。
- Node 版本选 20+。
- 实例数保持 **1**。房间在内存里；多实例/无粘性会话会丢房间。
- 平台通常会自动注入 `PORT`；`server.js` 已读取 `process.env.PORT`，并默认监听 `0.0.0.0`。
- 平台自带 HTTPS 时，直接用平台域名即可。

### C. 帽子云（国内，按天计费）

1. 在 [dash.maoziyun.com](https://dash.maoziyun.com) 注册；新用户有 ¥20 体验金。
2. 把本文件夹内容放到一个 **Gitee / GitHub / 公开 Git** 仓库（`server.js` 和 `package.json` 在仓库根目录；不要传 zip）。
3. 控制台右上 **新建 → Web 服务**（不要选“静态网站”）。
4. 应用名称填小写字母/数字（4–20 位）；来源选 Gitee 或 GitHub，选择仓库和分支，根目录留空。
5. 构建类型选 **Dockerfile**，Dockerfile 路径填 `./Dockerfile`。这样会使用 Node 20，并暴露 8787 端口。
   - 如果要用 Buildpack：构建命令 `npm install`，启动命令 `node server.js`。
6. 计算资源选 **0.5 核 / 512Mi**；实例数平台固定为 1，正适合本项目的内存房间。
7. 点击部署，等构建完成；默认域名是 `应用名-xxxx.maozi.io`，自带 HTTPS。
8. 打开 `默认域名/api/meta`，应返回包含 `coupletCount: 88`、`paletteCount: 16` 的 JSON。
9. 打开默认域名开房、让朋友加入；不要用临时隧道地址开房。

费用：0.5 核 / 512Mi 约 ¥0.32/天、¥9.45/月；¥20 体验金大约够 63 天。暂停应用会停止 CPU/内存计费（没有持久卷时）；删除应用后不再计费。房间在内存，重启会清空。

### 不适合的方式

- GitHub Pages、Netlify 静态托管、只上传 `public/`：没有 Node 服务，房间、SSE、邀请码都会失效。
- 纯 Serverless Function：进程不常驻，内存房间和长连接 SSE 都不合适。

## 必须知道的运行边界

- 房间、落子、在线状态都在**内存**里；重启 Node 进程会清空所有房间。
- 只支持**单个 Node 实例**。要横向扩容，需要先把房间状态外置。
- 邀请码是「同席的钥匙」，不是账号密码；拿到码的人都能加入。公网部署前建议在反向代理层加基本的请求/连接限流。
- 四位邀请码适合朋友局，不适合当权限边界。
- 没有数据库、账号、持久化和管理后台。
- 当前没有音频/配乐；页面用动效反馈。
- 公网必须用 HTTPS（平台自带或 Caddy/Nginx），否则浏览器和 SSE 体验都会受影响。

## 部署后自检

1. 打开首页，创建房间，记下四位邀请码。
2. 用另一个浏览器/隐身窗口加入，确认双方在线状态同步。
3. 房主出联，朋友猜一联，确认上下两行的三色格和 SSE 实时更新。
4. 让一个人猜中，确认本轮继续、另一个人仍能猜；所有人结束后再揭晓。
5. 刷新页面，确认还能回到原房间（同一浏览器、同一 token）。
6. 手机宽度打开，确认输入、历史、色卡面板可用。
