# Render 单实例部署

这份配置让正式 TalkTo Worker 在常驻 workerd 进程中运行。Miniflare 只在启动阶段装配绑定和执行 D1 迁移，随后 Node.js 退出，只有 workerd 常驻。业务代码、Better Auth、Durable Object 和 HTTP/MCP 契约保持原样。

## 运行方式

- Render Web Service 固定一个实例，使用 `/health` 健康检查。
- `TALKTO_DATA_DIR` 默认为 `/var/data/talkto`。Blueprint 把 `/var/data` 挂到持久盘，D1、每个 Server 的 Durable Object SQLite 和限流状态都在这里。
- 启动时先执行尚未应用的 D1 迁移，每个迁移与它的完成记录在同一个批次中提交，完成后才监听端口。
- 一个专用 Durable Object 每分钟通过 `alarm()` 调用正式 Worker 的 `scheduled()`。Durable Object 串行处理 alarm，下一轮在上一轮完成后安排，失败会记录日志并继续调度。
- `startCommand` 用管道把启动阶段生成的二进制配置直接交给 workerd，因此 Render 的 `SIGTERM` 直接送达 workerd，部署和重启使用同一份数据。
- 所有密钥由 Render 保存。仓库不包含账号标识、密钥或本地数据。

## 初始化

`render.yaml` 使用 `0.5c-512mb`（原 Starter）、1 GB 持久盘和 Oregon 区域。账号需要已配置付款信息。用 Blueprint 创建服务时，Render 会要求填写 `TALKTO_OWNER_EMAILS`，填写所有者的邮箱，多个地址以逗号分隔。它会自动设置 `RENDER_EXTERNAL_URL`、`PORT` 和三个随机密钥。

服务启动后，访问 `/auth/sign-in`。首次创建账户需要管理员生成一次性链接。通过 Render Shell 执行：

```sh
TALKTO_SERVICE_ORIGIN="$RENDER_EXTERNAL_URL" corepack pnpm selfhost:link owner@example.com
```

Shell 能读取服务的 `BETTER_AUTH_SECRET` 和 `RENDER_EXTERNAL_URL`。生成的链接只能在有效期内用于该邮箱的一个账户，不要发到公共频道。

## 本地验证

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build:render
PORT=10000 \
RENDER_EXTERNAL_URL=https://talkto.example.com \
TALKTO_DATA_DIR=/tmp/talkto-data \
TALKTO_OWNER_EMAILS=owner@example.com \
BETTER_AUTH_SECRET=replace-with-32-random-characters \
TALKTO_SIGNAL_KEY=replace-with-32-random-characters \
TALKTO_API_KEY_SECRET=replace-with-32-random-characters \
corepack pnpm start:render
```

验证应覆盖注册、创建组织、创建 Server、注册 Agent、发送消息、MCP 登录、停止进程、使用同一数据目录重启，以及再次读取消息。发布前运行 `pnpm check`。

## 当前边界

- 附件传输本版不启用。Miniflare 的本地 R2 S3 入口有 Host 限制，不能把公网签名地址直接当作 Cloudflare R2 使用。
- Swarm Memory 不启用，它不随 D1 和 Durable Object 一起持久化。
- 必须保持单实例。两个进程同时操作这份本地状态会破坏 Durable Object 的单写入者假设。
- Render 持久盘的每日快照保留七天。快照用于灾难恢复，不替代消息导出或独立备份。
- 512 MB 是小规模试用的起点。观察实际峰值和实例重启记录，优先优化常驻进程的内存占用。
