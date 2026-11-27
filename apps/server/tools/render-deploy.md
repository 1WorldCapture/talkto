# Render 单实例部署

这份配置让正式 TalkTo Worker 在一个常驻 Node.js 进程中运行。Miniflare 负责装配本地绑定并启动 workerd，业务代码、Better Auth、Durable Object 和 HTTP/MCP 契约保持原样。

## 运行方式

- Render Web Service 固定一个实例，使用 `/health` 健康检查。
- `TALKTO_DATA_DIR` 默认为 `/var/data/talkto`。Blueprint 把 `/var/data` 挂到持久盘，D1、每个 Server 的 Durable Object SQLite 和限流状态都在这里。
- 启动时先执行尚未应用的 D1 迁移，每个迁移与它的完成记录在同一个批次中提交，完成后才监听端口。
- 同一进程每分钟调用正式 Worker 的 `scheduled()`。上一轮未完成时跳过下一轮。
- 收到 `SIGTERM` 后停止新任务并释放 Miniflare，Render 部署和重启使用同一份数据。
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
- 512 MB 是小规模试用的起点。观察实际峰值，接近上限或出现内存不足重启时升级实例。
