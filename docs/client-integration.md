# 客户端接入与离线验签

本文写给**要接入本授权系统的那个程序**（C/C++、C#、Go、Python、Electron…都可以）。
只要满足两件事：能发 HTTP 请求、能用 Ed25519 验签（几乎所有语言的 crypto 库都内置）。

---

## 1. 总体模型

```
┌─────────────┐   ①激活(CDK)   ┌──────────────────┐
│   客户端     │ ─────────────▶ │  授权服务端       │
│             │ ◀───────────── │  (本仓库)        │
│             │  license_key    └──────────────────┘
│             │  license_file(签名)
│  本地保存    │
│  ┌────────────────────────────────────────┐
│  │ ②每次启动：本地用公钥验签 license_file   │  ← 完全离线
│  │   —— 验签通过 + 未过期 + 设备匹配 → 放行 │
│  └────────────────────────────────────────┘
│             │   ③每 24h 心跳  ┌──────────────────┐
│             │ ─────────────▶ │  换一份新的签名文件 │
│             │ ◀───────────── │  （滚动宽限期）     │
└─────────────┘                └──────────────────┘
```

设计要点：

- **服务端不可达时，客户端仍可正常工作**（只要还在离线宽限期内）。
- 服务端吊销/到期后，客户端**最多还能用宽限期那么久**（`OFFLINE_GRACE_DAYS`，默认 7 天）。
- 把公钥**内置进客户端**（不要运行时从服务器拉，否则容易被中间人替换）。

---

## 2. 本地要保存什么

| 数据 | 来源 | 说明 |
| --- | --- | --- |
| `license_key` | 激活/心跳响应 | 心跳凭证，**只在激活时返回一次**，丢了要后台重置 |
| `license_file` | 激活/心跳响应 | 签名字符串，每次心跳覆盖更新 |
| `device_id` | 本地生成 | 稳定设备指纹，见第 6 节 |
| `last_seen_time` | 本地 | 防时间回拨（见第 7 节） |

存放位置建议：程序配置目录下的 `license.json`（Windows `%APPDATA%\<你的软件>\license.json`）。
**不要把 `license_key` 明文硬编码进程序**。

---

## 3. 激活

```http
POST /api/v1/licenses/activate
Content-Type: application/json

{
  "cdk": "Q3GP-2WUW-7RFC-XPY2",
  "device_id": "PC-OFFICE-01",
  "device_name": "办公室主机",
  "platform": "Windows 11",
  "email": "buyer@example.com",
  "password": "BuyerPass123"
}
```

- `cdk`、`device_id` 必填；`email`/`password` 可省略（匿名激活）。
- 成功后把 `license_key`、`license_file` 存到本地。

响应（成功）：

```json
{
  "ok": true,
  "data": {
    "license": { "id": "lic_xx", "license_no": "LIC-2026-00001", "seats": 2,
                 "expires_at": "2027-11-12T08:00:00.000Z", "status": "active", "..." : "..." },
    "license_key": "LK-…",
    "license_file": "eyJ2IjoxLCJraWQiOiJrMSIs….MEUCIQ…",
    "license_payload": { "v": 1, "prd": "app-pro", "mod": ["core","report"], "exp": 1795066840, "…": "…" },
    "offline_expires_at": "2026-11-19T08:00:00.000Z",
    "expires_at": "2027-11-12T08:00:00.000Z",
    "days_left": 365,
    "module_codes": ["core", "report"],
    "heartbeat_interval_hours": 24
  }
}
```

激活前可以先**预检**（不核销）：

```http
POST /api/v1/cdks/inspect
{ "cdk": "Q3GP-2WUW-7RFC-XPY2" }
→ { "usable": true, "status": "unused", "days": 365, "seats": 2, "module_codes": ["core","report"] }
```

---

## 4. 许可证文件格式

```
<base64url(JSON payload)> "." <base64url(Ed25519 签名)>
```

签名的对象就是**左边那段 base64url 字符串本身**（按 UTF-8 字节），不是解码后的 JSON。这样校验时无需重新序列化，避免字段顺序问题。

payload 字段：

| 字段 | 含义 |
| --- | --- |
| `v` | 版本，当前 `1` |
| `kid` | 密钥 ID（换了签名密钥会变） |
| `lic` / `lic_no` | 授权内部 ID / 授权单号 |
| `cus` | 客户 ID |
| `prd` | **产品编码**，客户端应与自身产品编码比对 |
| `mod` | **模块编码数组**，客户端据此判断功能是否授权 |
| `dev` | 设备绑定值 `sha256("dev|" + device_id + "|" + lic)` 的前 32 位 hex |
| `seat` | 席位数 |
| `iat` / `exp` | 签发时间 / **离线有效期**（Unix 秒） |
| `grace_until` | 授权真实到期时间（Unix 秒），仅用于提示 |
| `status` | 签发时的授权状态 |

`exp` 恒等于 `min(授权到期时间, 签发时间 + 离线宽限天数)`。服务端每次心跳都会重新签发。

> **设备绑定怎么校验**：客户端自己算 `sha256("dev|" + device_id + "|" + payload.lic)` 取前 32 位 hex，与 `payload.dev` 比较。

---

## 5. 验签代码

### 5.1 C / C++（OpenSSL 1.1.1+，Linux 与 Windows 通用）

```c
#include <openssl/evp.h>
#include <openssl/pem.h>
#include <string.h>

/* 载入内置公钥（PEM 文本） */
EVP_PKEY *license_load_pubkey(const char *pem_text) {
    BIO *bio = BIO_new_mem_buf(pem_text, -1);
    EVP_PKEY *pk = PEM_read_bio_PUBKEY(bio, NULL, NULL, NULL);
    BIO_free(bio);
    return pk;   /* 用完 EVP_PKEY_free */
}

/* body_b64: 点号左边的 base64url 原文；sig: 解码后的签名字节
   返回 1 = 签名有效，0 = 无效 */
int license_verify(EVP_PKEY *pubkey,
                   const char *body_b64, size_t body_len,
                   const unsigned char *sig, size_t sig_len) {
    EVP_MD_CTX *ctx = EVP_MD_CTX_new();
    int ok = 0;
    /* Ed25519 不需要摘要算法，md 参数传 NULL，一次调用完成验签 */
    if (EVP_DigestVerifyInit(ctx, NULL, NULL, NULL, pubkey) == 1 &&
        EVP_DigestVerify(ctx, sig, sig_len,
                         (const unsigned char *)body_b64, body_len) == 1) {
        ok = 1;
    }
    EVP_MD_CTX_free(ctx);
    return ok;
}
```

`base64url` 解码时注意两点：把 `-`→`+`、`_`→`/`，并按需补 `=` 到 4 的倍数（或直接用 OpenSSL 的 `EVP_DecodeBlock` 手动处理）。

### 5.2 Node.js

```js
const { createPublicKey, verify } = require("node:crypto");

const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----`;

function verifyLicenseFile(file) {
  const dot = file.indexOf(".");
  if (dot <= 0) throw new Error("许可证格式错误");
  const body = file.slice(0, dot);
  const sig = Buffer.from(file.slice(dot + 1), "base64url");

  const ok = verify(null, Buffer.from(body, "utf8"), createPublicKey(PUBLIC_KEY_PEM), sig);
  if (!ok) throw new Error("许可证签名无效");

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (payload.exp * 1000 <= Date.now()) throw new Error("许可证已过期");
  return payload;
}
```

### 5.3 Python

```python
import base64, json, time
from cryptography.hazmat.primitives.serialization import load_pem_public_key
from cryptography.exceptions import InvalidSignature

PUBLIC_KEY_PEM = b"-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"

def b64u_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))

def verify_license_file(license_file: str) -> dict:
    body, sig = license_file.split(".", 1)
    pub = load_pem_public_key(PUBLIC_KEY_PEM)          # Ed25519PublicKey
    try:
        pub.verify(b64u_decode(sig), body.encode("utf-8"))
    except InvalidSignature:
        raise ValueError("许可证签名无效")
    payload = json.loads(b64u_decode(body))
    if payload["exp"] <= int(time.time()):
        raise ValueError("许可证已过期")
    return payload
```

### 5.4 C#（.NET 5+）

```csharp
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

static JsonDocument VerifyLicense(string licenseFile, string publicKeyPem)
{
    int dot = licenseFile.IndexOf('.');
    string body = licenseFile[..dot];
    byte[] sig = Base64UrlDecode(licenseFile[(dot + 1)..]);

    using var pem = new PemReader(new StringReader(publicKeyPem));  // 或直接用 ImportFromPem
    using var ecdsa = ECDsa.Create();   // 注意：Ed25519 需 .NET 8+ 的 Ed25519 API
    // .NET 8+：
    // using var ed = System.Security.Cryptography.Ed25519.Create();
    // if (!ed.VerifyData(Encoding.UTF8.GetBytes(body), sig)) throw ...;

    var payload = JsonDocument.Parse(Base64UrlDecode(body));
    long exp = payload.RootElement.GetProperty("exp").GetInt64();
    if (exp <= DateTimeOffset.UtcNow.ToUnixTimeSeconds()) throw new Exception("许可证已过期");
    return payload;
}
```

> .NET 8 起才有 `Ed25519`。低版本可改用 BouncyCastle（`Ed25519Signer`）或换成 C 示例的 OpenSSL。

---

## 6. 设备指纹（device_id）

要求：**同一台机器稳定、不同机器不同**，且不含隐私敏感原文（先哈希）。

Windows 参考：

```c
// 注册表 HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid
// + 系统盘卷序列号（GetVolumeInformation）
// 拼接后 SHA-256，取 hex 前 32 位作为 device_id
```

Linux：`/etc/machine-id` + 根分区 UUID；macOS：`IOPlatformUUID`。

注意：
- **不要用网卡 MAC**——虚拟网卡/换网络会变。
- 不要用 CPU 序列号（部分机器为空）。
- `device_id` 变化等于换机，会占用新席位；所以计算逻辑要固定并写进版本兼容策略。

---

## 7. 防时间回拨

客户端改系统时间可以绕过 `exp` 检查，建议加一道低成本防线：

```
每次成功启动：
    now = 当前时间
    如果 now + 1天 < 本地记录的 last_seen_time  → 判定时间回拨，拒绝运行（或标记待联网校验）
    last_seen_time = max(last_seen_time, now)
```

`last_seen_time` 与 `license_file` 一起存放，注意不要让它随缓存清理丢失（丢失按首次运行处理即可）。

---

## 8. 心跳与状态处理

按 `heartbeat_interval_hours`（默认 24h）发：

```http
POST /api/v1/licenses/heartbeat
{ "license_key": "LK-…", "device_id": "PC-OFFICE-01" }
```

客户端应当把**网络失败**和**明确的拒绝**区分开：

| 结果 | 处理建议 |
| --- | --- |
| `200` | 用返回的 `license_file` 覆盖本地，更新 `last_seen_time` |
| 网络错误 / 5xx / 超时 | **忽略**，继续按本地许可证离线运行（宽限期内有效） |
| `200` 且 `expired=true` | 仍算成功：账号信息可用，但**所有模块都不可用**。按 `modules[].active` 关掉全部功能，不要退出登录 |
| `200` 且部分模块 `active=false` | 只关掉这些模块对应的功能，其余照常 |
| `403` `LICENSE_REVOKED` | 提示"授权已被撤销"，标记不可恢复 |
| `403` `LICENSE_SUSPENDED` | 提示"授权已暂停"，可周期性重试 |
| `403` `CUSTOMER_DISABLED` | 提示"账号已停用" |
| `404` `DEVICE_NOT_BOUND` | 设备被解绑 → 要求重新激活（到期自动释放的机器，续费后下次心跳会自动复位） |
| `404` `INVALID_LICENSE_KEY` | 密钥失效 → 要求重新激活 |

推荐的整体流程：

```
启动
 └─ 读本地 license.json
     ├─ 没有 → 进入激活界面（输入 CDK）
     └─ 有 license_file
         ├─ 本地验签（公钥 + exp + dev + prd + mod）
         │    ├─ 通过 → 放行，后台异步心跳
         │    └─ 失败/过期 → 尝试同步心跳
         │         ├─ 心跳成功 → 用新文件重新验签 → 通过则放行
         │         └─ 心跳失败（网络问题）→ 提示"需要联网校验"或按策略降级
```

### 加绑新设备（一个授权多台机器）

```http
POST /api/v1/licenses/enroll
{ "license_key": "LK-…", "device_id": "PC-HOME-02", "device_name": "家用笔记本" }
```

席位满了返回 `409 SEAT_LIMIT`，需要先在旧设备上 `POST /api/v1/licenses/release` 或到后台解绑。

### 解绑当前设备（卸载时调用，释放席位）

```http
POST /api/v1/licenses/release
{ "license_key": "LK-…", "device_id": "PC-OFFICE-01" }
```

---

## 9. 功能级授权（按模块放行）

许可证 payload 的 `mod` 是模块编码数组。常见做法：

```c
/* 伪代码 */
if (license_has_module(payload, "report")) {
    enable_report_menu();
} else {
    show_upgrade_hint("报表模块需要授权");
}
```

后台改名模块时注意：`mod` 里放的是**模块编码**（`code`），不是名称；编码一旦签发就不要改（影响已发出的许可证）。

---

## 10. 常见坑

1. **公钥内置**，不要从网络获取（否则可被伪造服务端欺骗）。
2. **验签对象是 base64url 原文**，不是解码后的 JSON —— 重新序列化会导致验签失败。
3. **`license_key` 只返回一次**：激活响应里存好，丢了只能后台重置（重置后旧客户端心跳立刻 404）。
4. **心跳 404/403 不要当成网络错误重试到天荒地老**：按上面的状态表处理。
5. **升级客户端不要改 `device_id` 算法**，否则所有老用户都会被当成换机。
6. **HTTPS**：公网部署请放在 Nginx/Caddy 之后，否则 `license_key` 明文过网。
