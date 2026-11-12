# 镜像发布指南（构建 → 推送到线上）

把 `license-server` 镜像推到线上仓库，并在服务器上拉取部署的完整流程。

> **前提**：镜像构建必须在一台装有 Docker 的机器上完成。当前开发机没有安装 Docker，所以本文的命令需要你在一台有 Docker 的环境里执行（本机装了 Docker Desktop、或者一台 Linux 构建机/CI）。

---

## 目录

- [1. 五分钟快路径](#1-五分钟快路径)
- [2. 手动分步（推荐至少读一遍）](#2-手动分步推荐至少读一遍)
- [3. 各家镜像仓库的登录方式](#3-各家镜像仓库的登录方式)
- [4. 跨架构构建](#4-跨架构构建)
- [5. 线上部署](#5-线上部署)
- [6. 回滚](#6-回滚)
- [7. CI/CD 自动构建推送](#7-cicd-自动构建推送)
- [8. 安全要求](#8-安全要求)
- [9. 常见错误对照表](#9-常见错误对照表)

---

## 1. 五分钟快路径

Windows（PowerShell，在装有 Docker 的机器上、仓库根目录执行）：

```powershell
# 例：推送到阿里云 ACR
.\scripts\push-image.ps1 -Registry registry.cn-hangzhou.aliyuncs.com -Repo myns/license-server -Tag 1.0.0
```

> 第一次用建议先加 `-DryRun` 干跑（**不需要 Docker 也能执行**），确认镜像地址与命令无误：
>
> ```powershell
> .\scripts\push-image.ps1 -Registry ghcr.io -Repo myorg/license-server -Tag 1.0.0 -DryRun
> ```
>
> 常用参数：`-Platform linux/arm64`（跨架构）、`-PushLatest`（追加 latest）、`-SkipLogin`（已登录）、`-SkipBuild`（只推送已有镜像）。

Linux / macOS：

```bash
REGISTRY=registry.cn-hangzhou.aliyuncs.com
REPO=myns/license-server
TAG=1.0.0

docker login $REGISTRY
docker build -t $REGISTRY/$REPO:$TAG .
docker push   $REGISTRY/$REPO:$TAG
```

服务器上：

```bash
docker login $REGISTRY
docker pull $REGISTRY/$REPO:$TAG
```

然后把 `docker-compose.yml` 的 `image:` 改成 `$REGISTRY/$REPO:$TAG`、删掉 `build:` 段，`docker compose up -d`。

---

## 2. 手动分步（推荐至少读一遍）

### 2.1 确认版本号与目标架构

```bash
# 在服务器上执行，确认架构
uname -m          # x86_64 → linux/amd64 ；aarch64/arm64 → linux/arm64

# 在构建机上确认
docker version --format '{{.Server.Os}}/{{.Server.Arch}}'
```

架构不一致会在服务器上启动时报 `exec format error`，详见[第 4 节](#4-跨架构构建)。

### 2.2 构建并打两个标签

```bash
cd /path/to/license-server

REGISTRY=registry.cn-hangzhou.aliyuncs.com     # 换成你的仓库域名
REPO=myns/license-server                       # 换成你的命名空间/仓库名
TAG=1.0.0                                      # 语义化版本，见 2.5

docker build \
  -t license-server:$TAG \
  -t $REGISTRY/$REPO:$TAG \
  .

docker images | grep license-server
```

**为什么打两个标签**：本地标签 `license-server:$TAG` 与 `docker-compose.yml` 的默认值一致，方便本地跑；带仓库前缀的那个才是推上去的。

### 2.3 登录仓库

```bash
docker login $REGISTRY
# 交互输入用户名/密码；CI 环境用 --password-stdin（见第 7 节）
```

各家仓库的登录方式见[第 3 节](#3-各家镜像仓库的登录方式)。

### 2.4 推送并确认

```bash
docker push $REGISTRY/$REPO:$TAG

# 确认推上去的 digest（记下来，部署时可用于精确核对）
docker image inspect $REGISTRY/$REPO:$TAG --format '{{index .RepoDigests 0}}'
# registry.cn-hangzhou.aliyuncs.com/myns/license-server@sha256:xxxx
```

### 2.5 标签策略（别偷懒全用 `latest`）

| 标签 | 用途 |
| --- | --- |
| `1.0.0`（语义化版本） | **生产部署用这个**，可追溯、可回滚 |
| `1.0` / `1` | 可选，表示"1.x 最新" |
| `latest` | 只作为"最新构建"的参考；**不要**用它做生产部署 |
| `sha-<git短哈希>` | 可选，CI 里生成，便于把运行中的镜像对应到某次提交 |

原因：`latest` 是可变的，两台服务器在不同时间 `docker pull :latest` 可能拿到不同镜像，排障时无法确认线上跑的到底是哪份代码。

---

## 3. 各家镜像仓库的登录方式

> 各家控制台里都会直接给出一条可复制的 `docker login` 命令和"完整镜像地址"的格式，**以控制台给出的为准最稳**。下表用于快速对照。

| 仓库 | 镜像地址形态 | 登录 |
| --- | --- | --- |
| Docker Hub | `docker.io/<用户名>/license-server:1.0.0`（可省略 `docker.io/`） | `docker login -u <用户名>` |
| GitHub GHCR | `ghcr.io/<owner>/license-server:1.0.0` | `echo $GITHUB_TOKEN \| docker login ghcr.io -u <用户名> --password-stdin`（token 需 `write:packages` 权限） |
| 阿里云 ACR（个人版） | `registry.cn-hangzhou.aliyuncs.com/<命名空间>/license-server:1.0.0` | `docker login --username=<阿里云账号> registry.cn-hangzhou.aliyuncs.com`（密码为 ACR 的"固定密码"） |
| 阿里云 ACR（企业版） | 控制台给的实例域名 | 同上，域名换成实例域名 |
| 腾讯云 TCR | 个人版 `ccr.ccs.tencentyun.com/<命名空间>/license-server:1.0.0`<br>企业版 `<实例名>.tencentcloudcr.com/...` | `docker login <域名> --username=<账号ID>` |
| 华为云 SWR | `swr.<region>.myhuaweicloud.com/<组织>/license-server:1.0.0` | 控制台给 `docker login` 指令（AK/SK 形式） |
| 自建 Harbor | `harbor.example.com/<项目>/license-server:1.0.0` | `docker login harbor.example.com -u admin` |

**建议**：生产用**私有**仓库（Harbor / ACR 私有命名空间 / GHCR private）。虽然本镜像里不含任何密钥（见第 8 节），但私有仓库能避免泄露版本与依赖信息。

---

## 4. 跨架构构建

服务器是 arm64（鲲鹏、部分云主机、Mac M 系列本机）而构建机是 amd64（或反之）时必须显式指定平台：

```bash
# 构建并直接推到仓库（跨架构时不能 --load，必须 --push 或 --output）
docker buildx create --use --name lic-builder   # 首次需要
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t $REGISTRY/$REPO:1.0.0 \
  --push \
  .
```

要点：

- `--platform` 多平台时**只能 `--push`**（或 `--output type=oci,...`），`--load` 仅支持单平台。
- 多平台构建产物是一个 **manifest list**，服务器 `docker pull` 时会自动挑选匹配自身架构的那份，命令不用改。
- 只想构建单平台省时间：`--platform linux/arm64 --push`。
- 交叉构建比本机构建慢（需要 QEMU 模拟），但基础镜像是 alpine，影响不大。

验证线上拿到的是对的架构：

```bash
docker image inspect $REGISTRY/$REPO:1.0.0 --format '{{.Os}}/{{.Architecture}}'
# linux/arm64
```

---

## 5. 线上部署

### 5.1 服务器准备工作

服务器只需要：Docker + Compose v2。

```bash
sudo mkdir -p /opt/license-server && cd /opt/license-server
# 从仓库拿这两个文件即可（甚至不需要全部源码，因为代码已经在镜像里）
#   docker-compose.yml
#   .env.example → .env
```

> 用镜像部署时服务器上**不需要** `Dockerfile`、`src/`、`package.json`。镜像里已经包含运行所需的全部内容。

### 5.2 ⚠️ 把数据目录迁移过去（关键，最容易踩）

镜像里**不含** `data/` 目录（数据库与签名密钥都在数据卷里）。**新服务器首次启动会生成一把全新的签名密钥**，导致所有客户端验签失败。

所以从旧部署迁移时必须把 `data/` 一起搬过去：

```bash
# 旧机器
docker compose stop
tar czf license-data-$(date +%F).tar.gz -C . data
# 传到新机器 /opt/license-server/ 后
tar xzf license-data-*.tar.gz
sudo chown -R 1000:1000 data
```

这是全新部署（没有老数据）的话跳过这步，直接进 5.3。

### 5.3 修改 docker-compose.yml

把 `image:` 指向仓库地址，并**删掉 `build:` 段**（否则有人执行 `--build` 时会用本地源码覆盖仓库镜像）：

```yaml
services:
  license-server:
    image: registry.cn-hangzhou.aliyuncs.com/myns/license-server:1.0.0
    # build:            ← 删掉
    #   context: .
    #   dockerfile: Dockerfile
    container_name: license-server
    restart: unless-stopped
    ports:
      - "${BIND_ADDR:-0.0.0.0}:${PORT:-8080}:8080"
    env_file:
      - .env
    environment:
      DATA_DIR: /data
      PORT: 8080
    volumes:
      - ./data:/data
    # healthcheck / security_opt / logging 保持不变
```

### 5.4 拉取并启动

```bash
cd /opt/license-server

docker login $REGISTRY            # 私有仓库需要；公有仓库可跳过
docker compose pull
docker compose up -d

# 验证
docker compose ps                                   # STATUS: healthy
curl -s http://127.0.0.1:8080/healthz
docker compose logs --tail=30
```

如果用了 `docker logout` 或 CI 部署，凭据写在 `~/.docker/config.json`；无人值守部署可用 `docker login --password-stdin` 或提前在该机器登录一次。

### 5.5 确认跑的是新镜像

```bash
docker compose images                                     # 看 tag 与 image id
docker image inspect $REGISTRY/$REPO:1.0.0 --format '{{index .RepoDigests 0}}'
curl -s http://127.0.0.1:8080/api/v1/server-info          # 版本号
```

---

## 6. 回滚

镜像部署的回滚非常快，只要旧 tag 还在仓库里：

```bash
cd /opt/license-server
# 把 image: 改回上一个版本，例如 :0.9.0
docker compose pull
docker compose up -d
```

注意：

- **数据库迁移是单向的**。如果新版本改过表结构，只回滚镜像是危险的 —— 请同时用升级前的备份恢复 `data/license.db`（见 [DEPLOY.md 第 9.4 节](DEPLOY.md#94-恢复)）。
- 建议保留最近 3–5 个 tag，不要一上线就把旧 tag 从仓库删掉。

---

## 7. CI/CD 自动构建推送

仓库已内置工作流 **[.github/workflows/publish-image.yml](../.github/workflows/publish-image.yml)**：

```
推 v* tag（或 Actions 页面手动触发）
   └─ job: test      → npm test（21 项端到端测试，不过就不出镜像）
   └─ job: publish   → buildx 构建 → 推送阿里云 ACR 杭州个人版
                        tag: 1.0.0 + sha-abc1234
```

### 7.1 只需要配 2 个 Secret

仓库 Settings → Secrets and variables → Actions → **Secrets**：

| 名称 | 值 |
| --- | --- |
| `ACR_USERNAME` | 阿里云账号全名（如 `xxx@example.com`） |
| `ACR_PASSWORD` | ACR 控制台的**固定密码**（不是阿里云登录密码，这是 401 最常见原因） |

默认推送地址：`registry.cn-hangzhou.aliyuncs.com/myns/license-server:<版本>`。

不想改文件就用 **Variables** 覆盖默认值（可选）：

| Variable | 默认值 | 用途 |
| --- | --- | --- |
| `ACR_REGISTRY` | `registry.cn-hangzhou.aliyuncs.com` | 换地域 / 企业版实例域名 |
| `ACR_REPO` | `myns/license-server` | 你的命名空间/仓库名 |
| `BUILD_PLATFORMS` | `linux/amd64` | 服务器是 ARM 时改 `linux/amd64,linux/arm64` |

> ⚠️ 推送前**必须先在 ACR 控制台创建好仓库** `myns/license-server`（ACR 不会在 push 时自动建仓库，否则报 `denied: requested access to the resource is denied`）。

### 7.2 触发与产物

```bash
# 打 tag 触发（推荐）
git tag v1.0.0 && git push origin v1.0.0
```

产物两个 tag：

- `.../license-server:1.0.0` —— 来自 tag 名（去掉 `v` 前缀），**服务器部署用这个**
- `.../license-server:sha-abc1234` —— 对应提交，便于把线上镜像追溯回某次提交

手动触发（workflow_dispatch）时没有 tag，版本号会自动生成为 `0.0.0-<日期时间>-<sha>`。

### 7.3 服务器拉取

```bash
# 云内网提速：ECS 与 ACR 同地域时把域名换成 VPC 地址（不计公网流量）
docker login --username=<阿里云账号> registry.cn-hangzhou.aliyuncs.com
docker pull registry.cn-hangzhou.aliyuncs.com/myns/license-server:1.0.0
docker compose pull && docker compose up -d
```

### 7.4 如果不用 ACR（GHCR 备选）

只想把镜像放 GitHub 上时，把工作流里的登录取证与 tags 换成：

```yaml
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ghcr.io/${{ github.repository }}:${{ steps.meta.outputs.version }}
```

并把 publish job 的 `permissions` 改为包含 `packages: write`。国内服务器拉 GHCR 通常比 ACR 慢，所以默认方案用 ACR。

### 7.5 几点提醒

- 测试阶段跑在出镜像**之前**；本项目零第三方依赖，CI 里**不需要** `npm install`，所以 job 很快。
- 私有仓库的 Actions 分钟数有限额，多架构构建（QEMU 模拟 arm64）消耗明显更多，非必需就用默认的单架构。
- runner 在境外，推杭州 ACR 属跨境流量，偶发慢或超时是正常现象；频繁失败可改用阿里云云效在境内构建。

---

## 8. 安全要求

**镜像里不含任何秘密**，这是刻意设计的：

- `.dockerignore` 排除了 `data/`（含 `keys.json` 私钥与 `license.db`）、`.env`、`tests/`、`docs/`
- 镜像只包含 `package.json` + `src/`
- 运行时以非 root 用户（uid 1000）运行

所以：**不要把 `.env` 打包进镜像**，环境变量通过 `env_file`/`environment` 在运行时注入；签名私钥与数据库留在数据卷里。

其他建议：

- 私有仓库优先；推送前确认没有误提交 `.env`（`git status`、`.gitignore` 已覆盖）
- 开启镜像扫描（ACR/TCR/Harbor 都自带；或 `docker scout cves`）
- 基础镜像 `node:24-alpine` 建议定期重建以获取安全更新（生命周期短的部署尤其要跟）
- 生产环境**不要**在镜像 tag 上使用 `latest`

---

## 9. 常见错误对照表

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `denied: requested access to the resource is denied` | 未登录 / 账号无该命名空间权限 / 镜像名没带仓库前缀 | `docker login $REGISTRY`；确认用户名下确实有 `myns/license-server` 仓库；确认 `docker push` 用的是完整地址 |
| `unauthorized: authentication required` | 凭据过期或未登录 | 重新 `docker login`；CI 里用 `--password-stdin` |
| `manifest unknown` | 服务器 `pull` 时仓库地址/tag 拼错，或私有仓库未登录 | 用 `docker image inspect` 打印的 `RepoDigests` 核对完整地址 |
| `no matching manifest for linux/arm64/v8` | 只推了 amd64 镜像 | 见[第 4 节](#4-跨架构构建)，用 buildx 构建目标架构或双架构 |
| `exec format error`（容器起不来） | 同上，架构不匹配 | 同上 |
| `toomanyrequests: You have reached your pull rate limit` | Docker Hub 匿名拉取限流 | 登录后拉取，或改用私有仓库/镜像加速 |
| 推送很慢 | 首次推基础镜像层（约 50–80 MB 压缩后） | 正常；后续构建层缓存命中会快很多 |
| 服务器拉了但还是旧版本 | `latest` 被缓存 / 用了同一个 tag 覆盖 | `docker compose pull` 后再 `up -d`；确认 tag 与 digest；生产禁用 `latest` |
| 部署后客户端全部验签失败 | 新服务器生成了新的签名密钥（没迁移 `data/`） | 见 [5.2](#52-️-把数据目录迁移过去关键最容易踩)，把旧的 `data/keys.json` 迁过去 |
| 部署后「授权数据全空」 | 数据卷没挂上 | `docker inspect license-server \| grep -A5 Mounts`；确认 `./data:/data` 与 `DATA_DIR=/data` |

---

## 附：本条流程的验证状态

| 环节 | 验证情况 |
| --- | --- |
| 镜像内容正确性（运行时不依赖 node_modules） | 已验证：仅 `package.json` + `src` 在空目录可独立启动，`/healthz`、静态页、`/api/v1/public-key` 均 200 |
| 镜像不含秘密（`.env` / `data/` / `keys.json`） | 已验证：`.dockerignore` 覆盖，且镜像只 COPY `package.json` 与 `src` |
| `scripts/push-image.ps1` 语法与命令拼接 | 已验证：PowerShell Parser 解析 0 错误；`-DryRun` 输出的构建/推送命令正确（单架构双标签、跨架构 `buildx --platform ... --push`、latest）；无 Docker 时报错明确 |
| `docker build` / `docker push` / `docker pull` 实际执行 | **未验证** —— 当前开发机未安装 Docker。请在构建机上按本文执行一次 |
| 跨架构 `buildx` | **未验证** —— 同上 |

首次真实推送时，建议按[第 5.4 节](#54-拉取并启动)的验证命令逐条确认一遍。

---

## 附：Windows 下编辑脚本的注意事项

`scripts/push-image.ps1` 以 **UTF-8 with BOM** 保存。原因：Windows PowerShell 5.1 会用系统 ANSI 编码解析 `.ps1`，一旦文件是无 BOM 的 UTF-8，脚本里的中文注释就会被解成乱码，进而破坏引号与括号匹配，报出「意外的标记」「字符串缺少终止符」这类看起来像语法错误的提示。

- 用 VSCode 编辑后请确认右下角编码显示为 `UTF-8 with BOM`（可执行 `Set-Content -Encoding utf8BOM` 或保存时选择 "UTF-8 with BOM"）；
- 或者改用 PowerShell 7（`pwsh`）执行，它对无 BOM 的 UTF-8 处理正常。

