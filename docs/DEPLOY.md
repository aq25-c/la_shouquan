# 部署手册

面向运维/部署人员的完整操作手册：从裸机到 HTTPS 上线、备份、升级、排障。

> 只想最快跑起来？看 [README 的「快速部署」](../README.md#快速部署)。本文是它的详细版 + 运维部分。

---

## 目录

- [1. 前置条件](#1-前置条件)
- [2. 选择部署方式](#2-选择部署方式)
- [3. 方式 A：Docker Compose（推荐）](#3-方式-adocker-compose推荐)
- [4. 方式 B：docker run](#4-方式-bdocker-run)
- [5. 方式 C：裸机 Node + systemd](#5-方式-c裸机-node--systemd)
- [6. 配置 HTTPS 反向代理](#6-配置-https-反向代理)
- [7. 首次登录与安全加固](#7-首次登录与安全加固)
- [8. 环境变量（部署视角）](#8-环境变量部署视角)
- [9. 数据、备份与恢复](#9-数据备份与恢复)
- [10. 升级与回滚](#10-升级与回滚)
- [11. 迁移与多实例](#11-迁移与多实例)
- [12. 监控与日常巡检](#12-监控与日常巡检)
- [13. 故障排查](#13-故障排查)
- [14. 上线检查清单](#14-上线检查清单)

---

## 1. 前置条件

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| 操作系统 | Linux x86_64 / arm64（推荐 Debian 12、Ubuntu 22.04+、Alpine） | Windows Server 也能跑裸 Node，但不推荐生产 |
| Docker | Docker Engine 20.10+ / Docker Desktop（含 Compose v2） | 用 `docker compose version` 确认是 v2（`docker-compose` v1 已停止维护） |
| 或 Node.js | **≥ 22.18**（推荐 24.x） | 服务端直接用 Node 原生执行 TypeScript，**不需要 npm install、不需要构建** |
| 内存 | ≥ 256 MB 可用 | 实测常驻约 60–80 MB |
| 磁盘 | ≥ 1 GB（数据量很小，主要留给备份） | SQLite 库通常几 MB 到几十 MB |
| 端口 | 一个可对外访问的 HTTP 端口（默认 8080） | 对外请走 HTTPS（第 6 节） |
| 域名（可选） | 建议给授权服务一个独立子域名，如 `license.example.com` | 客户端硬编码地址，换域名意味着老客户端要升级 |

**网络要求**：客户端需要能访问到本服务（激活、心跳）。服务端不需要访问外网。

---

## 2. 选择部署方式

| 方式 | 适合场景 | 需要 |
| --- | --- | --- |
| **A. Docker Compose** | 生产首选，升级最省事 | Docker + Compose v2 |
| B. docker run | 不想写 compose 文件 / 极简 | Docker |
| C. 裸机 Node + systemd | 服务器上没有 Docker，或不信任容器 | Node ≥ 22.18 |

三种方式**数据目录结构完全一致**（`license.db` + `keys.json`），可以互相迁移。

---

## 3. 方式 A：Docker Compose（推荐）

### 3.1 取得代码并准备目录

```bash
# 放到 /opt/license-server（也可放任意目录）
sudo mkdir -p /opt/license-server && cd /opt/license-server
# 把仓库内容放进来（git clone 或解压上传），确认能看到 Dockerfile、docker-compose.yml、src/
ls
# Dockerfile  docker-compose.yml  package.json  src  docs  ...

# 数据目录（容器以 uid 1000 运行，需要可写）
mkdir -p data
sudo chown -R 1000:1000 data
```

### 3.2 创建配置文件

> ⚠️ **`.env` 文件必须存在**：`docker-compose.yml` 里声明了 `env_file: .env`，文件缺失时 Compose 会直接报错退出。

```bash
cp .env.example .env
```

编辑 `.env`，至少改这三项：

```dotenv
ADMIN_EMAIL=admin@yourcompany.com
ADMIN_PASSWORD=换成至少16位的强密码

# 走反向代理（下面第 6 节）时一定要打开，否则限流和审计里的 IP 全是 127.0.0.1
TRUST_PROXY=true

# 只想让本机的 Nginx/Caddy 访问，不直接对外暴露端口时设这个
BIND_ADDR=127.0.0.1
```

其余保持默认即可（默认 7 天离线宽限、24 小时心跳周期）。

### 3.3 构建并启动

```bash
docker compose up -d --build
```

首次会构建镜像（约 1 分钟，无需下载依赖包）。查看日志：

```bash
docker compose logs -f --tail=50
```

正常应该看到：

```
 license-server v1.0.0 已启动
 监听:        http://0.0.0.0:8080
 管理后台:    http://localhost:8080/
 数据库:      /data/license.db
 签名密钥:    kid=k1 (Ed25519)
 离线宽限:    7 天 / 心跳周期 24 小时
 已创建管理员: admin@yourcompany.com
──────────────────────────────────────────────
 客户端验签公钥（内置到客户端即可）:
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA...
-----END PUBLIC KEY-----
```

**把这段公钥保存下来**，后面要交给客户端开发者（第 7.4 节）。

### 3.4 验证部署成功

```bash
# 1) 健康检查
curl -s http://127.0.0.1:8080/healthz
# {"ok":true,"data":{"ok":true,"status":"healthy","time":"..."}}

# 2) 容器健康状态（应显示 healthy，约 30 秒后出现）
docker inspect --format '{{.State.Health.Status}}' license-server

# 3) 管理后台能打开（浏览器）
#    http://<服务器IP>:8080/  →  用 ADMIN_EMAIL / ADMIN_PASSWORD 登录

# 4) 管理员 API 能登录
curl -s -X POST http://127.0.0.1:8080/admin/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@yourcompany.com","password":"你的密码"}'
# {"ok":true,"data":{"admin":{...},"token":"...","expires_at":"..."}}
```

### 3.5 常用运维命令

```bash
docker compose ps                      # 状态
docker compose logs -f --tail=200      # 跟踪日志
docker compose restart                 # 重启
docker compose down                    # 停止并删除容器（数据在 ./data，不受影响）
docker compose up -d --build           # 升级（重建镜像）
docker compose exec license-server sh  # 进容器
docker compose cp license-server:/data/backups ./backups   # 把备份拷出来
```

---

## 4. 方式 B：docker run

不想用 compose 时：

```bash
cd /opt/license-server
docker build -t license-server:1.0.0 .

docker run -d --name license-server \
  --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -v /opt/license-server/data:/data \
  -e ADMIN_EMAIL=admin@yourcompany.com \
  -e ADMIN_PASSWORD='换成强密码' \
  -e TRUST_PROXY=true \
  -e TZ=Asia/Shanghai \
  license-server:1.0.0
```

- `-v` 必须挂：不挂的话容器重建后**授权数据全丢**。
- `-p 127.0.0.1:8080:8080` 只监听本机；如果前面没有反向代理，改成 `-p 8080:8080`。
- 容器内端口固定 8080（`PORT` 环境变量在容器内被 Dockerfile 固定），要换对外端口改宿主侧映射即可。

### 4.1 离线分发镜像

**本仓库不附带预构建镜像**，只有 `Dockerfile`（构建配方）。镜像在你执行构建的那台机器上生成，标签来自 `docker-compose.yml` 的 `image:` 字段：`license-server:1.0.0`。

```bash
# 1) 在一台能上网的机器上构建
docker compose build
docker images | grep license-server
# REPOSITORY        TAG      IMAGE ID       SIZE
# license-server    1.0.0    a1b2c3d4e5f6   ...   ← 体积基本等于 node:24-alpine 基础镜像
#                                             （我们只额外加了约 30 万字节源码）

# 2) 导出成单个压缩包（包含全部层，目标机不再需要基础镜像）
docker save license-server:1.0.0 | gzip -1 > license-server-1.0.0.tar.gz

# 3) 传到目标服务器后导入
gunzip -c license-server-1.0.0.tar.gz | docker load
docker images | grep license-server
```

目标机启动时**不要带 `--build`**，直接用已导入的镜像：

```bash
docker compose up -d          # 不会重新构建，直接使用本地 license-server:1.0.0
```

> 想在目标机本地构建、但它访问不了 Docker Hub：把基础镜像也一起搬过去。
>
> ```bash
> docker pull node:24-alpine
> docker save node:24-alpine | gzip -1 > node-24-alpine.tar.gz
> # 目标机：docker load -i node-24-alpine.tar.gz，然后 docker compose up -d --build
> ```

跨架构（例如 x86 开发机 → arm64 云服务器）：

```bash
docker buildx build --platform linux/arm64 -t license-server:1.0.0 --load .
```

> `--load` 只支持单平台。一次产出多架构镜像需要推到 registry（`--push`）。

私有镜像仓库（Harbor / GHCR / 阿里云 ACR）：

```bash
docker tag license-server:1.0.0 registry.example.com/license/license-server:1.0.0
docker push registry.example.com/license/license-server:1.0.0

# 目标机
docker pull registry.example.com/license/license-server:1.0.0
docker tag  registry.example.com/license/license-server:1.0.0 license-server:1.0.0
```

用私有仓库时，建议把 `docker-compose.yml` 里的 `build:` 段删掉、只留 `image:` 指向仓库地址，避免有人误用 `--build` 把仓库镜像覆盖成本地构建的版本。

**如何确认你手上的镜像就是当前代码**：

```bash
docker image inspect license-server:1.0.0 --format '{{.Created}} {{.Id}}'
docker compose exec license-server node -p "process.env.NODE_ENV"   # production
```

> 要把镜像推送到线上仓库（Docker Hub / GHCR / 阿里云 ACR / 腾讯云 TCR / Harbor），并在服务器上拉取部署、回滚、接 CI，见 **[PUSH-IMAGE.md](PUSH-IMAGE.md)**。


---

## 5. 方式 C：裸机 Node + systemd

### 5.1 安装 Node 并部署代码

```bash
# Node ≥ 22.18（推荐 24）
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v      # 应 ≥ v22.18

# 专用用户 + 目录
sudo useradd --system --create-home --shell /usr/sbin/nologin license
sudo mkdir -p /opt/license-server /var/lib/license-server
sudo cp -r ./src ./package.json /opt/license-server/
sudo chown -R license:license /opt/license-server /var/lib/license-server
chmod 750 /var/lib/license-server
```

> 不需要 `npm install`：本项目零第三方依赖。

### 5.2 环境变量文件

```bash
sudo tee /etc/license-server.env >/dev/null <<'EOF'
PORT=8080
HOST=127.0.0.1
DATA_DIR=/var/lib/license-server
ADMIN_EMAIL=admin@yourcompany.com
ADMIN_PASSWORD=换成至少16位的强密码
OFFLINE_GRACE_DAYS=7
HEARTBEAT_INTERVAL_HOURS=24
TRUST_PROXY=true
TZ=Asia/Shanghai
EOF
sudo chmod 600 /etc/license-server.env
```

> systemd 的 `EnvironmentFile` **不要给值加引号**；特殊字符建议先用 base64 避开（见第 8 节 `SIGNING_PRIVATE_KEY_B64`）。

### 5.3 systemd 服务

```bash
sudo tee /etc/systemd/system/license-server.service >/dev/null <<'EOF'
[Unit]
Description=License Server
Documentation=file:///opt/license-server/README.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=license
Group=license
WorkingDirectory=/opt/license-server
EnvironmentFile=/etc/license-server.env
ExecStart=/usr/bin/node src/server.ts
Restart=always
RestartSec=3

# 安全加固
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/var/lib/license-server

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now license-server
sudo systemctl status license-server --no-pager
```

### 5.4 验证

```bash
curl -s http://127.0.0.1:8080/healthz
journalctl -u license-server -n 50 --no-pager
```

---

## 6. 配置 HTTPS 反向代理

**生产环境请务必上 HTTPS**：否则 `license_key` 明文过网，可被中间人截获。

反代时记得把 `TRUST_PROXY=true` 写进 `.env`（否则限流按反代 IP 算，所有客户端会共享同一个限流桶，审计日志里的 IP 也全是 `127.0.0.1`）。

### 6.1 Nginx（独立子域名，推荐）

```nginx
server {
    listen 80;
    server_name license.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name license.example.com;

    ssl_certificate     /etc/letsencrypt/live/license.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/license.example.com/privkey.pem;

    client_max_body_size 1m;      # 服务端自身上限 256KB，这里放宽一些即可
    access_log /var/log/nginx/license.access.log;
    error_log  /var/log/nginx/license.error.log;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 30s;
    }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
# 证书：certbot --nginx -d license.example.com
```

### 6.2 Caddy（自动 HTTPS，配置最短）

```caddyfile
license.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:8080
}
```

Caddy 会自动申请并续期证书，也会带上 `X-Forwarded-For`。

### 6.3 如果一定要放在子路径（`https://host/license/`）

本系统默认按**站点根路径**设计。放在子路径下时，除了页面本身，**API 路径也要一并反代**（前端管理页用的是绝对路径 `/admin/api/...`，客户端用的是 `/api/v1/...`）：

```nginx
# 页面
location /license/ {
    proxy_pass http://127.0.0.1:8080/;    # 注意结尾的 / ，会剥掉 /license 前缀
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Real-IP $remote_addr;
}
# 管理端 API
location /admin/api/ {
    proxy_pass http://127.0.0.1:8080/admin/api/;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Real-IP $remote_addr;
}
# 客户端 API
location /api/ {
    proxy_pass http://127.0.0.1:8080/api/;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Real-IP $remote_addr;
}
```

> 更省事的做法是直接用独立子域名（6.1/6.2），不必折腾子路径。

---

## 7. 首次登录与安全加固

### 7.1 登录

浏览器打开 `https://license.example.com/`（或 `http://<IP>:8080/`），账号密码为 `.env` 里的 `ADMIN_EMAIL` / `ADMIN_PASSWORD`。

**如果你没设 `ADMIN_PASSWORD`**：系统会随机生成一个，写入数据目录下的 `initial-admin.txt`，并在启动日志提示路径。

```bash
# Docker
docker compose exec license-server cat /data/initial-admin.txt
# 裸机
sudo cat /var/lib/license-server/initial-admin.txt
```

拿到密码登录后，**立刻**在「设置与公钥 → 修改我的密码」里改掉，然后删除该文件：

```bash
docker compose exec license-server rm /data/initial-admin.txt
# 或
sudo rm /var/lib/license-server/initial-admin.txt
```

### 7.2 加固清单

- [ ] 改掉初始密码（或在 `.env` 里用强密码并保证 `.env` 权限 `600`）
- [ ] 删除 `initial-admin.txt`
- [ ] 上 HTTPS（第 6 节），并设 `TRUST_PROXY=true`
- [ ] 只允许反向代理访问后端端口（`BIND_ADDR=127.0.0.1` 或用防火墙只放 80/443）
- [ ] 限制管理后台访问来源（可选：Nginx `allow`/`deny` 只放公司出口 IP）
- [ ] 备份 `data/keys.json`（签名私钥）——**丢了就无法再签发与已有公钥匹配的许可证**
- [ ] 备份 `data/license.db`
- [ ] 别把 `data/` 暴露到 Web 目录、别提交进 Git

### 7.3 只需要一个管理员账号？

默认一个管理员就能用。如需多人协作，在「设置与公钥 → 新增管理员」添加（密码 ≥10 位），所有操作都会记入审计日志。

### 7.4 把公钥交给客户端开发者

签名公钥有三个获取途径，任选其一：

1. **启动日志**（第 3.3 节里打印的那段 PEM）
2. **管理后台**：设置与公钥 → 复制公钥
3. **HTTP 接口**（供构建流程自动化拉取）：
   ```bash
   curl -s https://license.example.com/api/v1/public-key
   ```
4. **直接读文件**：`data/keys.json` 里的 `publicKeyPem` 字段

客户端需要把 PEM **内置进程序**，不要运行时去服务器取（否则容易被伪造服务端绕过）。接入细节见 [client-integration.md](client-integration.md)。

---

## 8. 环境变量（部署视角）

完整对照表见 [.env.example](../.env.example)。部署时**必须关注**的几项：

| 变量 | 部署建议 | 说明 |
| --- | --- | --- |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | 必填 | 仅在**首次启动**（管理员表为空）时生效；之后改这里不会改密码，要用后台改 |
| `DATA_DIR` | 容器内固定 `/data`，裸机用 `/var/lib/license-server` | 数据目录，**必须持久化** |
| `DB_PATH` | 一般不用设 | 想自定义库文件名时用，优先级高于 `DATA_DIR` |
| `TRUST_PROXY` | 有反代就 `true` | 影响真实 IP 获取（限流与审计） |
| `BIND_ADDR` | `127.0.0.1`（有反代时） | 仅 `docker-compose.yml` 使用，控制宿主监听地址 |
| `PORT` | 默认 8080 | 宿主侧映射端口（容器内固定 8080） |
| `OFFLINE_GRACE_DAYS` | 建议 `3`~`14` | 离线宽限：越小越严格，客户端必须更勤联心跳 |
| `HEARTBEAT_INTERVAL_HOURS` | 默认 `24` | 下发给客户端的建议心跳周期 |
| `RATE_LIMIT_PER_MIN` | 默认 `600` | 单 IP 每分钟上限；客户端量大时按需调高 |
| `ADMIN_TOKEN_TTL_HOURS` | 默认 `12` | 后台会话有效期，改完需要重新登录 |
| `SIGNING_PRIVATE_KEY_B64` | 迁移/多实例时用 | PKCS8 PEM 的 base64，见第 11 节 |
| `TZ` | `Asia/Shanghai` | 只影响日志时间显示，数据库内统一存 UTC |

> 改完环境变量需要重启服务生效：`docker compose up -d`（compose 会自动重建容器）或 `sudo systemctl restart license-server`。

---

## 9. 数据、备份与恢复

### 9.1 数据目录内容

```
data/
├── license.db          # 全部业务数据（客户/授权/CDK/设备/审计）
├── license.db-wal      # SQLite WAL 日志（运行时存在，属正常）
├── license.db-shm      # SQLite 共享内存（运行时存在，属正常）
├── keys.json           # ⚠️ Ed25519 签名密钥（公钥+私钥）—— 必须备份，权限 600
├── initial-admin.txt   # 首次启动随机密码（登录后请删除）
└── backups/            # 用备份工具生成的快照
```

**备份这一个目录就等于备份了整个系统**（除环境变量外）。

### 9.2 在线备份（服务不用停）

内置了备份工具，用 SQLite 的 `VACUUM INTO` 生成一致性快照：

```bash
# Docker
docker compose exec license-server node src/tools/backup.ts
# → [backup] 完成 /data/backups/license-2026-11-12T05-48-12-742Z.db
# 拷到宿主
docker compose cp license-server:/data/backups/. ./backups/

# 裸机（在 /opt/license-server 下执行）
sudo -u license DATA_DIR=/var/lib/license-server node src/tools/backup.ts
# 或指定目标文件
sudo -u license DATA_DIR=/var/lib/license-server node src/tools/backup.ts /backup/license-$(date +%F).db
```

工具会自检（表数量、授权数、CDK 数）并拒绝覆盖已存在的目标文件。

### 9.3 冷备份（停服拷贝，最稳）

```bash
docker compose stop
tar czf /backup/license-$(date +%F).tar.gz -C . data
docker compose start
```

> 不要在服务运行时直接 `cp license.db`：WAL 模式下主库文件可能不含最新写入，请用 9.2 的工具或先停服。

### 9.4 恢复

```bash
# 1) 停服
docker compose stop

# 2) 清掉旧库（含 WAL，否则会与恢复的库冲突）
cd data && rm -f license.db license.db-wal license.db-shm

# 3) 放回备份（工具生成的快照可直接改名）
mv /path/to/license-2026-11-12.db license.db
#    或从 tar 包恢复：tar xzf /backup/license-2026-11-12.tar.gz -C .

# 4) 确认 keys.json 一致（若从别处恢复，注意密钥要与客户端内置公钥匹配）
ls -l

# 5) 起服并验证
docker compose start
curl -s http://127.0.0.1:8080/healthz
```

恢复后用后台登录，核对「概览」里的授权数、客户数与备份时刻一致。

### 9.5 备份策略建议

| 项目 | 建议 |
| --- | --- |
| 频率 | 每天一次在线备份（`backup.ts`），保留 14–30 天 |
| 时机 | 低峰期；重要操作（批量生成 CDK、批量续费）后额外备份一次 |
| 异地 | 备份文件同步到别的机器/对象存储（含 `keys.json`，它变化极少，单独存一份即可） |
| 验证 | 每月抽一个备份做一次实际恢复演练（`data/` 目录整体替换到测试环境） |

示例 crontab（宿主机）：

```cron
# 每天 03:30 在线备份并清理 30 天前
30 3 * * * cd /opt/license-server && docker compose exec -T license-server node src/tools/backup.ts >/dev/null && find ./data/backups -name 'license-*.db' -mtime +30 -delete
```

---

## 10. 升级与回滚

### 10.1 升级（Docker Compose）

```bash
cd /opt/license-server

# 1) 先备份（重要）
docker compose exec license-server node src/tools/backup.ts

# 2) 更新代码
git pull            # 或上传新版本覆盖 src/、Dockerfile

# 3) 重建并启动
docker compose up -d --build

# 4) 验证
docker compose ps                       # healthy
curl -s http://127.0.0.1:8080/healthz
docker compose logs --tail=30
```

数据库结构变更会在启动时自动迁移（`PRAGMA user_version`），已有数据不受影响。

### 10.2 回滚

```bash
# 代码回滚
git checkout <上一个版本 tag/commit>
docker compose up -d --build
```

**注意**：数据库迁移是**单向**的（旧代码不认识新结构）。如果新版本改动过表结构，回滚代码后请同时用升级前的备份恢复数据库（9.4 节）。因此**升级前那次备份是必须的**。

裸机部署的升级同理：替换 `/opt/license-server/src` → `sudo systemctl restart license-server`。

---

## 11. 迁移与多实例

### 11.1 换服务器

1. 老机器：`docker compose stop`，打包 `data/`。
2. 新机器：按第 3 节部署（先不启动），把 `data/` 放到位，`chown -R 1000:1000 data`。
3. 启动，验证登录与授权数量。
4. 若要保留原域名，切 DNS 后老机器再停一段时间观察。

**`keys.json` 必须一起迁移**：否则新旧签发的许可证对应不同公钥，客户端全部验签失败。

### 11.2 多实例 / 高可用

**不支持多实例共享同一个 SQLite 文件。** SQLite 是单写者模型，WAL 在 NFS/网络文件系统上不可靠，多个进程同时写会损坏数据。

所以正常情况下就是**单实例部署**：单实例 + SQLite 实测可支撑数千台设备的日心跳，瓶颈通常在心跳请求量而不是数据库。

真需要水平扩展/高可用时，只有一条路：**先把数据层换成 PostgreSQL**（数据访问集中在 `src/store/*.ts`，替换面可控），再在前面挂负载均衡。

#### `SIGNING_PRIVATE_KEY_B64` 的用途：共用签名身份，**不共用数据**

它的作用是让不同部署**签出同一个公钥能验过的许可证**。典型场景：

- **迁移/灾备**：只搬 `license.db` 不搬 `keys.json` 时，用这个变量把私钥注入新机器
- **多实例**（换成 PostgreSQL 之后）：各实例注入同一把私钥，客户端无论连到哪个实例都能验签

> ⚠️ **重点**：两套各自独立的数据目录（各自一个 `license.db`）即使共用同一把签名密钥，**账号、授权、CDK、设备记录也完全互相看不到**，不会自动同步。这样的"双活"没有意义，还会导致同一张 CDK 在两套库里各被核销一次。

另外，全新数据库会**重新创建初始管理员**，密码在新实例自己的 `initial-admin.txt` 里（不是老实例那个）。

导出并注入私钥：

```bash
# 从已有部署导出（PKCS8 私钥 PEM 的 base64，单行）
docker compose exec -T license-server node src/tools/export-key.ts > my-key.b64
# 裸机
sudo -u license DATA_DIR=/var/lib/license-server node src/tools/export-key.ts > my-key.b64
```

把 `my-key.b64` 的内容填进新实例的 `.env`：

```dotenv
SIGNING_PRIVATE_KEY_B64=LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0t...
```

> ⚠️ 这个值的敏感程度等同于服务端私钥，泄露即可伪造任意许可证：只写到 `600` 权限的文件里，不要贴进聊天/工单/日志。

启动时会自动校验私钥/公钥是否配对，不匹配会拒绝启动（避免签出无法验签的许可证）。验证两个实例是否一致：

```bash
curl -s https://instance-a.example.com/api/v1/public-key | grep -A2 'BEGIN PUBLIC KEY'
curl -s https://instance-b.example.com/api/v1/public-key | grep -A2 'BEGIN PUBLIC KEY'
# 两段 PEM 必须逐字符相同
```

---

## 12. 监控与日常巡检

### 12.1 健康检查

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/healthz   # 期望 200
```

Docker 已内置 `HEALTHCHECK`（30 秒一次），容器状态显示 `healthy`。
接入监控系统时用 `/healthz` 做存活探针即可（无需鉴权，不写日志）。

### 12.2 需要盯的指标

| 指标 | 查看方式 | 关注点 |
| --- | --- | --- |
| 有效授权数 / 7 天内到期 | 后台「概览」 | 到期数突增说明续费流程有问题 |
| 未使用 CDK 数 | 后台「概览」 | 库存不足要提前生成 |
| 活跃设备 / 24h 心跳数 | 后台「概览」 | 心跳数远低于设备数 → 客户端联网异常 |
| 异常设备（长时间未心跳） | `GET /admin/api/heartbeat-health` | `HEARTBEAT_STALE_HOURS`（默认 72h） |
| 登录失败 | 后台「审计日志」筛选 `admin.login_failed` / `customer.login_failed` | 集中出现可能是撞库 |
| 429 比例 | 反代日志 | 偏高要调 `RATE_LIMIT_PER_MIN` 或排查客户端重试风暴 |

### 12.3 日志

```bash
docker compose logs -f --tail=200          # Docker
journalctl -u license-server -f            # 裸机
```

每条请求一行：`GET /admin/api/overview 200 3ms`。审计日志（谁改了什么）在数据库里，通过后台「审计日志」页查看。

---

## 13. 故障排查

### 13.1 启动类

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `env file .../.env not found` | `.env` 不存在 | `cp .env.example .env` |
| `Bind for 0.0.0.0:8080 failed: port is already allocated` | 端口被占用 | 改 `.env` 的 `PORT`，或 `ss -lntp \| grep 8080` 找到占用进程 |
| 容器反复重启，日志有 `EACCES` / `EROFS` | `./data` 不可写 | `sudo chown -R 1000:1000 data` |
| 裸机报 `SyntaxError` 或类型相关错误 | Node 版本过低（< 22.18） | `node -v` 确认，升级 Node |
| `签名密钥自检失败` | `SIGNING_PRIVATE_KEY_B64` 与现有 `keys.json` 不匹配 | 清空该变量，或从原部署导出正确的私钥 |
| 升级后「数据全空」 | 数据卷没挂上 | `docker inspect license-server \| grep -A5 Mounts`，确认 `/data` 绑定到宿主的 `./data` |

### 13.2 使用类

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 后台登录返回 401 | 密码错 / 会话过期（默认 12h） | 重新登录；改过密码的话所有旧会话已失效 |
| 登录返回 429 | 登录限流（10 次/分钟/IP） | 等一分钟；或确认真实 IP 是否被反代串成同一个 |
| 客户端心跳 404 `INVALID_LICENSE_KEY` | 该授权的密钥被后台重置过 | 用新 `license_key` 重新激活，或让客户端重新走激活流程 |
| 客户端心跳 404 `DEVICE_NOT_BOUND` | 设备被后台/客户解绑 | 用 CDK 重新激活，或用 `enroll` 加绑 |
| 客户端心跳 403 `LICENSE_EXPIRED` | 授权到期 | 后台续费（建议勾「从当前时间起算」） |
| 客户端心跳 403 `LICENSE_SUSPENDED` / `LICENSE_REVOKED` | 被暂停/吊销 | 恢复状态或重新开通 |
| 客户端验签一直失败 | ① 公钥不是当前服务端的那把 ② `license_file` 被截断/改过 ③ 客户端系统时间异常 | 对比后台「设置与公钥」的 PEM；重新下发文件；检查客户端时间与 NTP |
| 客户端离线用几天后失效 | 离线宽限到了（默认 7 天） | 属预期行为；让客户端联网心跳，或调大 `OFFLINE_GRACE_DAYS` |
| 导出 CSV 在 Excel 里乱码 | 用文本编辑器另存破坏了 BOM | 直接下载导出的文件，不要另存转码 |
| 时间显示差 8 小时 | 容器 `TZ` 不是东八区 | `.env` / compose 里设 `TZ=Asia/Shanghai`（数据库内仍存 UTC，不影响逻辑） |

### 13.3 首尾排除法

不确定是服务端还是客户端问题时，用 curl 复现一遍（能返回 200 就说明服务端没问题）：

```bash
BASE=https://license.example.com
curl -s $BASE/healthz
curl -s $BASE/api/v1/public-key | head -5
curl -s -X POST $BASE/api/v1/licenses/heartbeat \
  -H 'Content-Type: application/json' \
  -d '{"license_key":"LK-xxx","device_id":"PC-001"}'
```

---

## 14. 上线检查清单

**部署**
- [ ] `.env` 已创建，`ADMIN_EMAIL` / `ADMIN_PASSWORD` 已改为强密码，`.env` 权限 `600`
- [ ] `data/` 已创建且 `chown 1000:1000`（Docker）或属主为服务用户（裸机）
- [ ] `docker compose up -d --build` 成功，容器 `healthy`
- [ ] `/healthz` 返回 200
- [ ] 管理后台能登录，概览页正常显示

**安全**
- [ ] HTTPS 已启用，HTTP 自动跳转
- [ ] `TRUST_PROXY=true` 且反代传了 `X-Forwarded-For`（审计里能看到真实 IP）
- [ ] 后端端口只对本机/内网开放
- [ ] 初始密码已修改，`initial-admin.txt` 已删除
- [ ] `data/keys.json` 已单独备份（离线保存一份）

**功能**
- [ ] 建 1 个产品 + 至少 1 个模块
- [ ] 生成 1 个测试 CDK，用 curl 走通「激活 → 心跳」，本地验签通过
- [ ] 后台「概览」数字随之变化；「审计日志」有对应记录
- [ ] 测试一次「延长到期时间」与「吊销」，客户端行为符合预期

**运维**
- [ ] 每日在线备份已配置（cron/systemd timer），并验证过能拷出文件
- [ ] 做过一次恢复演练
- [ ] 监控已接 `/healthz`
- [ ] 客户端已内置当前公钥，且记录了 `kid`（换密钥时用于判断影响范围）

---

## 附：从零到可用的最短路径

```bash
git clone <repo> /opt/license-server && cd /opt/license-server
cp .env.example .env && vi .env                      # 改 ADMIN_PASSWORD
mkdir -p data && sudo chown -R 1000:1000 data
docker compose up -d --build
curl -s http://127.0.0.1:8080/healthz                # 200 即成功
# 浏览器打开 http://<IP>:8080/ 登录，建产品/模块，生成 CDK
```

完整的客户端接入流程见 [client-integration.md](client-integration.md)，接口细节见 [API.md](API.md)。
