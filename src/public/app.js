/**
 * 授权管理后台 —— 原生 JS 单页，无构建、无第三方依赖。
 * 所有请求走同源 /admin/api，成功响应形如 { ok: true, data }，失败为 { ok: false, error }。
 */

/* ============================ 基础工具 ============================ */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

function el(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

const pad = (n) => String(n).padStart(2, "0");

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDay(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 客户单元格：姓名优先，邮箱做副行（v2.11：列表显示客户名称） */
function customerCell(name, email, extra = "") {
  const n = name ? String(name).trim() : "";
  const e = email ? String(email).trim() : "";
  const main = n || e || "—";
  const sub = n && e && n !== e ? `<span class="cell-sub">${esc(e)}</span>` : "";
  // 外面包一层：表格转卡片时这一格只算一个 flex item，姓名和邮箱不会被扯到两头
  return `<span class="cell-stack"><span class="cell-main">${esc(main)}</span>${sub}${extra}</span>`;
}

/** 卡类型中文 */
function termText(t) {
  return { hour: "按小时", day: "按天", month: "按月", year: "按年", count: "按次数" }[t] ?? t ?? "—";
}

/** 卡类型计量单位 */
function termUnit(t) {
  return { hour: "小时", day: "天", month: "月", year: "年", count: "次" }[t] ?? "单位";
}

/** 授权的计费展示：时长类给「30 天」，次数类给「3/10（剩 7）」 */
function licenseTermText(l) {
  if (l.term_type === "count") {
    const used = l.used_usages ?? 0;
    const max = l.max_usages ?? 0;
    return `次数 ${used}/${max}（剩 ${Math.max(0, max - used)}）`;
  }
  if (!l.term_type) return "—";
  return `${l.term_value ?? ""} ${termUnit(l.term_type)}`;
}

function relDays(iso) {
  if (!iso) return "—";
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return "—";
  const days = Math.ceil(ms / 86_400_000);
  if (days < 0) return `已过期 ${-days} 天`;
  if (days === 0) return "今天到期";
  return `${days} 天`;
}

/** datetime-local 输入值 ↔ ISO */
function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const LICENSE_STATUS = {
  active: ["有效", "badge-ok"],
  pending: ["未生效", "badge-info"],
  expired: ["已过期", "badge-warn"],
  suspended: ["已暂停", "badge-warn"],
  revoked: ["已吊销", "badge-danger"],
};

const CDK_STATUS = {
  unused: ["未使用", "badge-info"],
  used: ["已使用", "badge-ok"],
  revoked: ["已作废", "badge-danger"],
};

const statusBadge = (map, status) => {
  const [label, cls] = map[status] ?? [status ?? "—", "badge"];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
};

/* ============================ API ============================ */

class ApiError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.code = code;
    this.details = details;
  }
}

const state = {
  token: localStorage.getItem("lic_admin_token") || "",
  admin: null,
  signingKey: null,
  config: null,
  view: "overview",
  products: [],
  modules: [],
  agents: [],
  pages: {},
  /** 当前登录账号的权限（后端下发） */
  permissions: { menus: [], features: [] },
};

/** 员工权限：只显示被授权的菜单 */
function hasMenu(menu) {
  const menus = state.permissions?.menus ?? [];
  return menus.includes(menu) || menus.includes("*");
}

function hasFeature(feature) {
  const feats = state.permissions?.features ?? [];
  return feats.includes(feature) || feats.includes("*");
}

function applyMenuPermissions() {
  $$("#nav .nav-item, .sidebar-foot .nav-item").forEach((btn) => {
    btn.hidden = !hasMenu(btn.dataset.view);
  });
}

/** 第一个有权限的页面（代理只有卡密页） */
function firstAllowedView() {
  const order = ["overview", "cdks", "licenses", "customers", "products", "agents", "staff", "audit", "params", "apiDocs", "settings"];
  return order.find((v) => hasMenu(v)) ?? "overview";
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (res.status === 401) {
    endSession();
    throw new ApiError("UNAUTHORIZED", "登录已过期，请重新登录");
  }
  if (!res.ok || (payload && payload.ok === false)) {
    const err = payload?.error ?? { code: `HTTP_${res.status}`, message: text.slice(0, 200) };
    throw new ApiError(err.code, err.message, err.details);
  }
  return payload?.data ?? null;
}

const apiGet = (path) => api("GET", path);
const apiPost = (path, body) => api("POST", path, body ?? {});
const apiPatch = (path, body) => api("PATCH", path, body ?? {});

/* ============================ UI 组件 ============================ */

function toast(message, type = "") {
  const root = $("#toast-root");
  if (!root) return;
  const node = el(`<div class="toast ${type}">${esc(message)}</div>`);
  root.appendChild(node);
  setTimeout(() => node.remove(), 3800);
}

function openModal({ title, body, footer = "", wide = false, onMount }) {
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true">
        <div class="modal-head">
          <h3>${esc(title)}</h3>
          <button class="btn btn-ghost btn-sm" data-close type="button">✕</button>
        </div>
        <div class="modal-body">${body}</div>
        ${footer ? `<div class="modal-foot">${footer}</div>` : ""}
      </div>
    </div>`;

  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  const close = () => {
    root.innerHTML = "";
    document.removeEventListener("keydown", onKey);
  };
  document.addEventListener("keydown", onKey);
  $("[data-close]", root).addEventListener("click", close);
  $(".modal-backdrop", root).addEventListener("mousedown", (e) => {
    if (e.target.classList.contains("modal-backdrop")) close();
  });
  onMount?.($(".modal", root), close);
  return close;
}

function confirmDialog(message, { danger = false, okText = "确定" } = {}) {
  return new Promise((resolve) => {
    openModal({
      title: "确认操作",
      body: `<p>${esc(message)}</p>`,
      footer: `<button class="btn" data-no type="button">取消</button>
               <button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-yes type="button">${esc(okText)}</button>`,
      onMount(modal, close) {
        $("[data-no]", modal).onclick = () => {
          close();
          resolve(false);
        };
        $("[data-yes]", modal).onclick = () => {
          close();
          resolve(true);
        };
      },
    });
  });
}

function downloadText(filename, text, mime = "text/csv;charset=utf-8") {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制到剪贴板", "ok");
  } catch {
    toast("复制失败，请手动选择文本", "error");
  }
}

function pageNav(key, total, pageSize, onGo) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = state.pages[key] ?? 1;
  const node = el(`
    <div class="pager">
      <span class="muted small">共 ${total} 条 · 第 ${current} / ${pages} 页</span>
      <button class="btn btn-sm" data-prev ${current <= 1 ? "disabled" : ""} type="button">上一页</button>
      <button class="btn btn-sm" data-next ${current >= pages ? "disabled" : ""} type="button">下一页</button>
    </div>`);
  $("[data-prev]", node).onclick = () => {
    state.pages[key] = current - 1;
    onGo();
  };
  $("[data-next]", node).onclick = () => {
    state.pages[key] = current + 1;
    onGo();
  };
  return node;
}

function emptyRow(cols, text = "暂无数据") {
  return `<tr><td colspan="${cols}" class="empty-row">${esc(text)}</td></tr>`;
}

/* ============================ 会话 ============================ */

function startSession(token, admin) {
  state.token = token;
  state.admin = admin;
  state.permissions = admin?.permissions ?? { menus: [], features: [] };
  state.role = admin?.role ?? "owner";
  state.agentId = admin?.agent_id ?? null;
  state.agentName = admin?.agent_name ?? null;
  localStorage.setItem("lic_admin_token", token);
  $("#login-view").hidden = true;
  $("#app-view").hidden = false;
  const who = (admin?.name && String(admin.name).trim()) || admin?.email || "管理员";
  const roleText = admin?.role && admin.role !== "owner" ? (admin.role === "agent" ? "代理" : "员工") : "";
  $("#admin-label").innerHTML =
    `<span class="avatar">${esc(String(who).slice(0, 1).toUpperCase())}</span>` +
    `<span class="name">${esc(who)}${roleText ? ` · ${roleText}` : ""}</span>`;
  $("#admin-label").title = admin?.email ?? String(who);
  applyMenuPermissions();
}

function endSession() {
  state.token = "";
  state.admin = null;
  localStorage.removeItem("lic_admin_token");
  $("#app-view").hidden = true;
  $("#login-view").hidden = false;
  $("#modal-root").innerHTML = "";
}

async function bootstrapSession() {
  if (!state.token) {
    $("#login-view").hidden = false;
    return;
  }
  try {
    const me = await apiGet("/admin/api/auth/me");
    startSession(state.token, me.admin);
    state.signingKey = me.signing_key;
    state.config = me.config;
    await navigate("overview");
  } catch {
    endSession();
  }
}

/** 手机端抽屉导航：开/关都只改 body 上的 class，样式负责动画 */
function closeDrawer() {
  document.body.classList.remove("drawer-open");
}

/**
 * 手机端表格转卡片：把表头文字写进每个单元格的 data-label，
 * 复杂表（有 colspan/rowspan，比如价目表的分组行）保持横向滚动。
 */
function enhanceTables(root) {
  root.querySelectorAll("table").forEach((table) => {
    const heads = $$("thead th", table).map((th) => th.textContent.trim());
    if (!heads.length) return;
    const rows = $$("tbody tr", table);
    const complex = rows.some((tr) => tr.querySelector("td[colspan], td[rowspan]"));
    rows.forEach((tr) => {
      [...tr.children].forEach((td, i) => {
        if (td.colSpan > 1) return;
        if (!td.dataset.label && heads[i]) td.dataset.label = heads[i];
      });
    });
    if (complex) {
      table.closest(".table-wrap")?.classList.add("scroll-x");
    } else {
      table.classList.add("card-table");
    }
  });
}

/* ============================ 导航 ============================ */

const VIEWS = {
  overview: { title: "概览", subtitle: "授权与 CDK 全局概况", render: renderOverview },
  products: { title: "产品与模块", subtitle: "产品、功能模块维护（CDK 绑定目标）", render: renderProducts },
  cdks: { title: "CDK", subtitle: "批量生成、导出与作废", render: renderCdks },
  agents: { title: "代理", subtitle: "分销代理、CDK 归属与营收统计", render: renderAgents },
  licenses: { title: "授权", subtitle: "到期时间、席位、设备与吊销", render: renderLicenses },
  customers: { title: "客户", subtitle: "注册客户与账号状态", render: renderCustomers },
  audit: { title: "审计日志", subtitle: "所有关键操作留痕", render: renderAudit },
  staff: { title: "员工", subtitle: "员工账号、目录权限与软件功能授权", render: renderStaff },
  params: { title: "软件参数", subtitle: "试用策略等软件级参数", render: renderParams },
  apiDocs: { title: "API 文档", subtitle: "全部接口说明 · 由真实路由表自动生成，不会与实现脱节", render: renderApiDocs },
  settings: { title: "设置与公钥", subtitle: "签名公钥、策略参数、管理员", render: renderSettings },
};

async function navigate(name, keepPage = false) {
  const view = VIEWS[name];
  if (!view) return;
  state.view = name;
  if (!keepPage) state.pages[name] = 1;
  closeDrawer();
  $$("#nav .nav-item, .sidebar-foot .nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === name);
  });
  $("#page-title").textContent = view.title;
  $("#page-subtitle").textContent = view.subtitle;
  const root = $("#view-root");
  root.innerHTML = `<div class="card"><div class="card-body muted">加载中…</div></div>`;
  try {
    await view.render(root);
    enhanceTables(root);
  } catch (err) {
    root.innerHTML = `<div class="card"><div class="card-body"><p class="error-text">加载失败：${esc(err.message)}</p></div></div>`;
  }
}

async function ensureCatalog(force = false) {
  if (force || !state.products.length) {
    const res = await apiGet("/admin/api/products");
    state.products = res.items;
  }
  const [mods, chans] = await Promise.all([
    apiGet("/admin/api/modules"),
    // 代理无权读代理列表，这里容错，避免拖垮整个页面
    apiGet("/admin/api/agents").catch(() => ({ items: [] })),
  ]);
  state.modules = mods.items;
  state.agents = chans.items;
}

const productName = (id) => state.products.find((p) => p.id === id)?.name ?? id;
const modulesOf = (productId) => state.modules.filter((m) => m.product_id === productId);

function productOptions(selected = "") {
  return state.products
    .map((p) => `<option value="${esc(p.id)}" ${p.id === selected ? "selected" : ""}>${esc(p.name)} (${esc(p.code)})</option>`)
    .join("");
}

function moduleCheckboxes(productId, checked = []) {
  const list = modulesOf(productId);
  if (!list.length) return `<span class="empty">该产品还没有模块，可先到「产品与模块」添加</span>`;
  return list
    .map(
      (m) => `<label><input type="checkbox" value="${esc(m.id)}" ${checked.includes(m.id) ? "checked" : ""} />
        <span>${esc(m.name)} <span class="muted small">${esc(m.code)}</span></span></label>`,
    )
    .join("");
}

/* ============================ 概览 ============================ */

async function renderOverview(root) {
  const data = await apiGet("/admin/api/overview");
  const s = data.stats;
  state.config = data.config;

  root.innerHTML = `
    <div class="stat-grid">
      <div class="stat accent"><div class="stat-label">有效授权</div><div class="stat-value">${s.licenses_active}</div>
        <div class="stat-hint">累计 ${s.licenses_total} 个授权</div></div>
      <div class="stat${s.licenses_expiring_7d > 0 ? " warn" : ""}"><div class="stat-label">7 天内到期</div><div class="stat-value">${s.licenses_expiring_7d}</div>
        <div class="stat-hint">已过期 ${s.licenses_expired} 个</div></div>
      <div class="stat"><div class="stat-label">未使用 CDK</div><div class="stat-value">${s.cdk_unused}</div>
        <div class="stat-hint">已核销 ${s.cdk_used} 个</div></div>
      <div class="stat"><div class="stat-label">活跃设备</div><div class="stat-value">${s.devices_active}</div>
        <div class="stat-hint">24h 心跳 ${s.heartbeats_24h} 台 · 异常 ${s.stale_devices} 台</div></div>
      <div class="stat"><div class="stat-label">客户</div><div class="stat-value">${s.customers}</div>
        <div class="stat-hint">产品 ${s.products} 个 / 模块 ${s.modules} 个</div></div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>14 天内到期</h3>
        <button class="btn btn-sm" data-goto-licenses type="button">查看全部授权</button>
      </div>
      <div class="card-body tight">
        <div class="table-wrap">
          <table>
            <thead><tr><th>授权单号</th><th>客户</th><th>产品</th><th>到期时间</th><th>剩余</th><th>设备</th><th></th></tr></thead>
            <tbody>
              ${
                data.expiring.length
                  ? data.expiring
                      .map(
                        (l) => `<tr>
                          <td class="mono">${esc(l.license_no)}</td>
                          <td>${customerCell(l.customer_name, l.customer_email)}</td>
                          <td>${esc(l.product_name)}</td>
                          <td class="nowrap">${fmtDay(l.expires_at)}</td>
                          <td><span class="badge badge-warn">${relDays(l.expires_at)}</span></td>
                          <td>${l.active_devices}/${l.seats}</td>
                          <td class="right"><button class="btn btn-sm" data-license="${esc(l.id)}" type="button">详情</button></td>
                        </tr>`,
                      )
                      .join("")
                  : emptyRow(7, "14 天内没有到期的授权")
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>最近开通的授权</h3></div>
      <div class="card-body tight">
        <div class="table-wrap">
          <table>
            <thead><tr><th>授权单号</th><th>客户</th><th>产品</th><th>生效</th><th>到期</th><th>状态</th><th></th></tr></thead>
            <tbody>
              ${
                data.recent_licenses.length
                  ? data.recent_licenses
                      .map(
                        (l) => `<tr>
                          <td class="mono">${esc(l.license_no)}</td>
                          <td>${customerCell(l.customer_name, l.customer_email)}</td>
                          <td>${esc(l.product_code)}</td>
                          <td class="nowrap">${fmtDay(l.starts_at)}</td>
                          <td class="nowrap">${fmtDay(l.expires_at)}</td>
                          <td>${statusBadge(LICENSE_STATUS, l.eff_status)}</td>
                          <td class="right"><button class="btn btn-sm" data-license="${esc(l.id)}" type="button">详情</button></td>
                        </tr>`,
                      )
                      .join("")
                  : emptyRow(7, "还没有授权")
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>`;

  $("[data-goto-licenses]", root).onclick = () => navigate("licenses");
  $$("[data-license]", root).forEach((btn) => {
    btn.onclick = () => openLicenseDetail(btn.dataset.license);
  });
}

/* ============================ 产品与模块 ============================ */

/** 产品级试用配置：未填的项沿用「软件参数」里的全局默认 */
async function productTrialForm(productId) {
  const data = await apiGet(`/admin/api/products/${productId}/trial`);
  const cfg = data.config;
  const g = data.global;
  const product = state.products.find((p) => p.id === productId);
  const globalHint = g.mode === "day" ? `${g.value} 天` : `${g.value} 次`;

  const modal = openModal({
    title: `试用配置：${product?.name ?? ""}`,
    body: `
      <div class="form-grid">
        <label class="field"><span>是否允许试用</span>
          <select name="enabled">
            <option value="1" ${cfg.enabled ? "selected" : ""}>开启</option>
            <option value="0" ${!cfg.enabled ? "selected" : ""}>关闭</option>
          </select></label>
        <label class="field"><span>试用方式</span>
          <select name="mode">
            <option value="day" ${cfg.mode === "day" ? "selected" : ""}>试用几天</option>
            <option value="count" ${cfg.mode === "count" ? "selected" : ""}>试用几次</option>
          </select></label>
        <label class="field"><span>试用量（天 / 次）</span>
          <input name="value" type="number" min="1" max="3650" value="${cfg.value}" /></label>
        <label class="field"><span>试用席位数</span>
          <input name="seats" type="number" min="1" max="100" value="${cfg.seats}" /></label>
        <label class="field"><span>每个客户可试用次数</span>
          <input name="max_per_customer" type="number" min="1" max="20" value="${cfg.max_per_customer}" /></label>
      </div>
      <div class="note">这里只保存本产品的差异项；没改的字段继续跟随「软件参数」的全局默认（当前 ${esc(globalHint)}）。</div>`,
    footer: '<button class="btn btn-primary" data-save type="button">保存</button>',
    onMount: (m) => {
      $("[data-save]", m).onclick = async () => {
        try {
          await apiPatch(`/admin/api/products/${productId}/trial`, {
            enabled: $('[name="enabled"]', m).value === "1",
            mode: $('[name="mode"]', m).value,
            value: Number($('[name="value"]', m).value),
            seats: Number($('[name="seats"]', m).value),
            max_per_customer: Number($('[name="max_per_customer"]', m).value),
          });
          toast("试用配置已保存", "ok");
          $("#modal-root").innerHTML = "";
        } catch (err) {
          toast(err.message, "error");
        }
      };
    },
  });
  return modal;
}

/** 远程变量管理：文本 / 图片（URL 或 data URI）/ JSON，客户端登录后可读 */
async function varManager(productId) {
  const product = state.products.find((p) => p.id === productId);
  const data = await apiGet(`/admin/api/products/${productId}/vars`);
  const items = data.items ?? [];

  openModal({
    title: `远程变量：${product?.name ?? ""}`,
    wide: true,
    body: `
      <div class="note">客户端登录后可通过 <code>GET /api/v1/vars</code> 读取这里配置的变量；<b>未登录无法获取</b>。</div>
      <div class="table-wrap" style="margin-top:10px">
        <table>
          <thead><tr><th>Key</th><th>类型</th><th>值</th><th class="right">操作</th></tr></thead>
          <tbody>
            ${
              items.length
                ? items
                    .map(
                      (v) => `<tr>
                        <td class="mono">${esc(v.key)}</td>
                        <td>${esc(v.kind)}</td>
                        <td class="mono" style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(v.preview)}">${esc(v.preview)}</td>
                        <td class="right"><button class="btn btn-sm" data-del-var="${esc(v.key)}" type="button">删除</button></td>
                      </tr>`,
                    )
                    .join("")
                : emptyRow(4, "还没有配置变量")
            }
          </tbody>
        </table>
      </div>
      <div class="form-grid" style="margin-top:14px">
        <label class="field"><span>Key（字母 / 数字 / _ . -）</span><input name="vkey" placeholder="notice_text" /></label>
        <label class="field"><span>类型</span>
          <select name="vkind">
            <option value="text">文本</option>
            <option value="image">图片（URL 或 data URI）</option>
            <option value="json">JSON</option>
          </select></label>
        <label class="field full"><span>值</span>
          <textarea name="vvalue" rows="4" placeholder="文本内容 / https://example.com/a.png / {&quot;version&quot;:&quot;1.2.0&quot;}"></textarea></label>
        <label class="field full"><span>说明（可选）</span><input name="vdesc" /></label>
      </div>`,
    footer: `<button class="btn" data-close2 type="button">关闭</button><button class="btn btn-primary" data-save type="button">保存变量</button>`,
    onMount(modal, close) {
      $("[data-close2]", modal).onclick = () => {
        close();
        navigate("products", true);
      };
      $("[data-save]", modal).onclick = async () => {
        const key = $("[name=vkey]", modal).value.trim();
        const kind = $("[name=vkind]", modal).value;
        const value = $("[name=vvalue]", modal).value;
        if (!key) {
          toast("请填写 Key", "error");
          return;
        }
        try {
          await apiPost(`/admin/api/products/${productId}/vars`, {
            key,
            kind,
            value,
            description: $("[name=vdesc]", modal).value.trim(),
          });
          toast("已保存", "ok");
          close();
          varManager(productId);
        } catch (err) {
          toast(err.message, "error");
        }
      };
      $$("[data-del-var]", modal).forEach((btn) => {
        btn.onclick = async () => {
          if (!(await confirmDialog(`删除变量 ${btn.dataset.delVar}？`, { danger: true, okText: "删除" }))) return;
          try {
            await api("DELETE", `/admin/api/products/${productId}/vars/${encodeURIComponent(btn.dataset.delVar)}`);
            toast("已删除", "ok");
            close();
            varManager(productId);
          } catch (err) {
            toast(err.message, "error");
          }
        };
      });
    },
  });
}

async function renderProducts(root) {
  await ensureCatalog(true);
  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>产品列表</h3>
        <button class="btn btn-primary btn-sm" data-new-product type="button">+ 新建产品</button>
      </div>
      <div class="card-body tight">
        <div class="table-wrap">
          <table>
            <thead><tr><th>产品</th><th>编码</th><th>模块</th><th>授权</th><th>未用 CDK</th><th>状态</th><th class="right">操作</th></tr></thead>
            <tbody>
              ${
                state.products.length
                  ? state.products
                      .map(
                        (p) => `<tr>
                          <td><strong>${esc(p.name)}</strong>${p.description ? `<div class="muted small">${esc(p.description)}</div>` : ""}</td>
                          <td class="mono">${esc(p.code)}</td>
                          <td>${p.module_count}</td>
                          <td>${p.license_count}（有效 ${p.active_license_count}）</td>
                          <td>${p.cdk_unused_count}</td>
                          <td>${p.status === "active" ? '<span class="badge badge-ok">启用</span>' : '<span class="badge">停用</span>'}</td>
                          <td class="right">
                            <div class="btn-row" style="justify-content:flex-end">
                              <button class="btn btn-sm" data-modules="${esc(p.id)}" type="button">模块</button>
                              <button class="btn btn-sm" data-trial="${esc(p.id)}" type="button">试用</button>
                              <button class="btn btn-sm" data-vars="${esc(p.id)}" type="button">变量</button>
                              <button class="btn btn-sm" data-edit="${esc(p.id)}" type="button">编辑</button>
                              <button class="btn btn-sm" data-toggle="${esc(p.id)}" type="button">${p.status === "active" ? "停用" : "启用"}</button>
                              <button class="btn btn-sm" data-del="${esc(p.id)}" type="button">删除</button>
                            </div>
                          </td>
                        </tr>`,
                      )
                      .join("")
                  : emptyRow(7, "还没有产品，先创建一个（例如 app-pro）")
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>`;

  $("[data-new-product]", root).onclick = () => productForm();
  $$("[data-trial]", root).forEach((btn) => {
    btn.onclick = () => productTrialForm(btn.dataset.trial);
  });
  $$("[data-vars]", root).forEach((btn) => {
    btn.onclick = () => varManager(btn.dataset.vars);
  });
  $$("[data-edit]", root).forEach((btn) => {
    btn.onclick = () => productForm(state.products.find((p) => p.id === btn.dataset.edit));
  });
  $$("[data-modules]", root).forEach((btn) => {
    btn.onclick = () => moduleManager(btn.dataset.modules);
  });
  $$("[data-toggle]", root).forEach((btn) => {
    btn.onclick = async () => {
      const product = state.products.find((p) => p.id === btn.dataset.toggle);
      try {
        await apiPatch(`/admin/api/products/${product.id}`, { status: product.status === "active" ? "disabled" : "active" });
        toast("已更新", "ok");
        navigate("products");
      } catch (err) {
        toast(err.message, "error");
      }
    };
  });
  $$("[data-del]", root).forEach((btn) => {
    btn.onclick = async () => {
      const product = state.products.find((p) => p.id === btn.dataset.del);
      if (!(await confirmDialog(`确定删除产品「${product.name}」？该操作不可恢复。`, { danger: true, okText: "删除" }))) return;
      try {
        await api("DELETE", `/admin/api/products/${product.id}`);
        toast("已删除", "ok");
        navigate("products");
      } catch (err) {
        toast(err.message, "error");
      }
    };
  });
}

function productForm(product) {
  const isNew = !product;
  openModal({
    title: isNew ? "新建产品" : `编辑产品：${product.name}`,
    body: `
      <div class="form-grid">
        <label class="field"><span>产品编码（客户端识别用）</span>
          <input name="code" value="${esc(product?.code ?? "")}" ${isNew ? "" : "disabled"} placeholder="app-pro" /></label>
        <label class="field"><span>产品名称</span><input name="name" value="${esc(product?.name ?? "")}" placeholder="专业版客户端" /></label>
        <label class="field full"><span>描述</span><textarea name="description" placeholder="可选">${esc(product?.description ?? "")}</textarea></label>
      </div>`,
    footer: `<button class="btn" data-cancel type="button">取消</button><button class="btn btn-primary" data-save type="button">保存</button>`,
    onMount(modal, close) {
      $("[data-cancel]", modal).onclick = close;
      $("[data-save]", modal).onclick = async () => {
        const payload = {
          code: $('[name="code"]', modal).value.trim(),
          name: $('[name="name"]', modal).value.trim(),
          description: $('[name="description"]', modal).value.trim(),
        };
        if (!payload.name || (isNew && !payload.code)) {
          toast("请填写编码与名称", "error");
          return;
        }
        try {
          if (isNew) await apiPost("/admin/api/products", payload);
          else await apiPatch(`/admin/api/products/${product.id}`, { name: payload.name, description: payload.description });
          close();
          toast("已保存", "ok");
          navigate("products");
        } catch (err) {
          toast(err.message, "error");
        }
      };
    },
  });
}

/** 模块列表里的试用状态徽标（v12：模块级试用） */
function trialBadge(m) {
  const t = m.trial;
  if (!t || !t.enabled) return '<span class="muted">未开放</span>';
  const unit = t.mode === "count" ? "次" : "天";
  const custom = m.trial_custom ? ' <span class="muted small">自定义</span>' : "";
  return `<span class="badge badge-ok">${esc(String(t.value ?? "-"))} ${unit}</span>${custom}`;
}

async function moduleManager(productId) {
  const product = state.products.find((p) => p.id === productId);
  const res = await apiGet(`/admin/api/products/${productId}/modules`);
  const rows = res.items;

  const render = (modal) => {
    $(".modal-body", modal).innerHTML = `
      <div class="note">模块是 CDK 与授权的授权范围单位，客户端通过模块编码判断功能是否可用。</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>模块名称</th><th>编码</th><th>试用</th><th>状态</th><th class="right">操作</th></tr></thead>
          <tbody>
            ${
              rows.length
                ? rows
                    .map(
                      (m) => `<tr>
                        <td>${esc(m.name)}</td>
                        <td class="mono">${esc(m.code)}</td>
                        <td>${trialBadge(m)}</td>
                        <td>${m.status === "active" ? '<span class="badge badge-ok">启用</span>' : '<span class="badge">停用</span>'}</td>
                        <td class="right">
                          <div class="btn-row" style="justify-content:flex-end">
                            <button class="btn btn-sm" data-trial="${esc(m.id)}" type="button">试用</button>
                            <button class="btn btn-sm" data-rm="${esc(m.id)}" type="button">删除</button>
                          </div>
                        </td>
                      </tr>`,
                    )
                    .join("")
                : emptyRow(5, "还没有模块")
            }
          </tbody>
        </table>
      </div>
      <div class="form-grid">
        <label class="field"><span>模块编码</span><input name="code" placeholder="report" /></label>
        <label class="field"><span>模块名称</span><input name="name" placeholder="报表模块" /></label>
        <label class="field full"><span>模块说明（客户端可经接口读取，用于展示给用户）</span>
          <textarea name="description" rows="2" placeholder="例如：导出 Excel / PDF 报表"></textarea></label>
        <div class="field full"><button class="btn btn-primary btn-sm" data-add type="button">+ 添加模块</button></div>
      </div>`;

    $$("[data-rm]", modal).forEach((btn) => {
      btn.onclick = async () => {
        if (!(await confirmDialog("删除该模块？已签发的授权不受影响，但新 CDK 不能再选它。", { danger: true, okText: "删除" }))) return;
        try {
          await api("DELETE", `/admin/api/modules/${btn.dataset.rm}`);
          const refreshed = await apiGet(`/admin/api/products/${productId}/modules`);
          rows.length = 0;
          rows.push(...refreshed.items);
          render(modal);
          toast("已删除", "ok");
        } catch (err) {
          toast(err.message, "error");
        }
      };
    });

    $$("[data-trial]", modal).forEach((btn) => {
      btn.onclick = () => {
        const m = rows.find((x) => x.id === btn.dataset.trial);
        if (m) renderTrial(modal, m);
      };
    });

    $("[data-add]", modal).onclick = async () => {
      const code = $('[name="code"]', modal).value.trim();
      const name = $('[name="name"]', modal).value.trim();
      const description = $('[name="description"]', modal).value.trim();
      if (!code || !name) {
        toast("请填写模块编码与名称", "error");
        return;
      }
      try {
        await apiPost(`/admin/api/products/${productId}/modules`, { code, name, description });
        const refreshed = await apiGet(`/admin/api/products/${productId}/modules`);
        rows.length = 0;
        rows.push(...refreshed.items);
        render(modal);
        toast("已添加", "ok");
      } catch (err) {
        toast(err.message, "error");
      }
    };
  };

  const renderTrial = (modal, m) => {
    const t = m.trial ?? {};
    $(".modal-body", modal).innerHTML = `
      <div class="note">模块 <b>${esc(m.name)}</b>（<code>${esc(m.code)}</code>）的试用配置。关闭后这个模块不参与客户自助试用。</div>
      <div class="form-grid">
        <label class="field"><span>开放试用</span>
          <select name="t-enabled">
            <option value="1" ${t.enabled ? "selected" : ""}>开放</option>
            <option value="0" ${t.enabled ? "" : "selected"}>不开放</option>
          </select>
        </label>
        <label class="field"><span>试用类型</span>
          <select name="t-mode">
            <option value="day" ${t.mode === "count" ? "" : "selected"}>按天数</option>
            <option value="count" ${t.mode === "count" ? "selected" : ""}>按次数</option>
          </select>
        </label>
        <label class="field"><span>试用数量（天 / 次）</span>
          <input name="t-value" type="number" min="1" value="${esc(String(t.value ?? 14))}" />
        </label>
        <label class="field"><span>每客户可试用次数</span>
          <input name="t-max" type="number" min="0" value="${esc(String(t.max_per_customer ?? 1))}" />
        </label>
      </div>
      <div class="note">席位属于软件 / 授权级（决定同一账号能登录几台设备），模块这里不设。</div>
      <div class="note">${
        m.trial_custom
          ? "当前是这个模块自己的配置。"
          : "当前继承产品级 / 全局配置，保存后会变成模块自定义。"
      }</div>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn btn-primary btn-sm" data-tsave type="button">保存</button>
        <button class="btn btn-sm" data-treset type="button" ${m.trial_custom ? "" : "hidden"}>恢复继承</button>
        <button class="btn btn-sm" data-tback type="button">返回模块列表</button>
      </div>`;

    const refresh = async () => {
      const r = await apiGet(`/admin/api/products/${productId}/modules`);
      rows.length = 0;
      rows.push(...r.items);
      render(modal);
    };

    $("[data-tback]", modal).onclick = () => render(modal);
    $("[data-treset]", modal).onclick = async () => {
      try {
        await api("DELETE", `/admin/api/modules/${m.id}/trial`);
        await refresh();
        toast("已恢复继承产品 / 全局配置", "ok");
      } catch (err) {
        toast(err.message, "error");
      }
    };
    $("[data-tsave]", modal).onclick = async () => {
      const body = {
        enabled: $('[name="t-enabled"]', modal).value === "1",
        mode: $('[name="t-mode"]', modal).value,
        value: Number($('[name="t-value"]', modal).value) || 1,
        max_per_customer: Number($('[name="t-max"]', modal).value),
      };
      try {
        await api("PATCH", `/admin/api/modules/${m.id}/trial`, body);
        await refresh();
        toast("试用配置已保存", "ok");
      } catch (err) {
        toast(err.message, "error");
      }
    };
  };

  openModal({
    title: `模块管理：${product.name}`,
    wide: true,
    body: "",
    footer: `<button class="btn" data-close2 type="button">关闭</button>`,
    onMount(modal, close) {
      render(modal);
      $("[data-close2]", modal).onclick = () => {
        close();
        navigate("products");
      };
    },
  });
}

/* ============================ 代理 / 分销 ============================ */

const money = (cents) => `¥${(Number(cents ?? 0) / 100).toFixed(2)}`;
const percent = (ratio) => `${(Number(ratio ?? 0) * 100).toFixed(1)}%`;

function agentOptions(selected = "") {
  // 代理只能给自己出卡：下拉里只放自己，避免误选到别的代理
  if (state.role === "agent") {
    const id = state.agentId ?? "";
    const name = state.agentName ?? "我的代理";
    return `<option value="${esc(id)}" selected>${esc(name)}（仅自己）</option>`;
  }
  const parts = [`<option value="">无（直销）</option>`];
  for (const c of state.agents) {
    if (c.status !== "active" && c.id !== selected) continue;
    parts.push(
      `<option value="${esc(c.id)}" ${c.id === selected ? "selected" : ""}>${esc(c.name)}（${esc(c.code)}）</option>`,
    );
  }
  return parts.join("");
}

/** 代理单独定价：默认带出全局价，留空表示沿用全局，填了即为覆盖价 */
async function agentPriceForm(agentId) {
  const [globalPrices, ownPrices] = await Promise.all([
    apiGet("/admin/api/prices"),
    apiGet(`/admin/api/prices?agent_id=${encodeURIComponent(agentId)}`),
  ]);
  const own = new Map(ownPrices.items.map((p) => [`${p.product_id}|${p.module_id}|${p.term_type}`, p.unit_price]));

  const rows = globalPrices.items.length
    ? globalPrices.items
        .map((p) => {
          const key = `${p.product_id}|${p.module_id}|${p.term_type}`;
          const val = own.get(key);
          return `<tr>
            <td>${esc(p.product_name)}</td>
            <td>${p.module_name ? esc(p.module_name) : '<span class="muted small">产品默认</span>'}</td>
            <td>${esc(p.term_type)}</td>
            <td>¥${(p.unit_price / 100).toFixed(2)}</td>
            <td><input type="number" step="0.01" min="0" style="width:110px"
                 data-p="${esc(p.product_id)}" data-m="${esc(p.module_id)}" data-t="${esc(p.term_type)}"
                 value="${val === undefined ? "" : (val / 100).toFixed(2)}" placeholder="用全局价" /></td>
          </tr>`;
        })
        .join("")
    : emptyRow(5, "全局还没有配置价格，请先到「软件参数 → 全局默认卡密价格」配置");

  openModal({
    title: "代理单独定价",
    wide: true,
    body: `
      <div class="note">留空 = 沿用「软件参数」里的全局默认价；填了即为该代理的覆盖价。</div>
      <div class="table-wrap" style="margin-top:10px">
        <table>
          <thead><tr><th>产品</th><th>模块</th><th>卡类型</th><th>全局价</th><th>该代理价</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`,
    footer: '<button class="btn btn-primary" data-save type="button">保存</button>',
    onMount: (m) => {
      $("[data-save]", m).onclick = async () => {
        const inputs = $$("[data-p]", m).filter((i) => i.value.trim() !== "");
        try {
          for (const i of inputs) {
            await apiPost("/admin/api/prices", {
              agent_id: agentId,
              product_id: i.dataset.p,
              module_id: i.dataset.m || null,
              term_type: i.dataset.t,
              unit_price: Math.round(Number(i.value) * 100),
            });
          }
          toast(`已保存 ${inputs.length} 条代理价`, "ok");
          $("#modal-root").innerHTML = "";
        } catch (err) {
          toast(err.message, "error");
        }
      };
    },
  });
}

/** 代理登录账号：没有则创建，有则改密码 / 停用 / 调整可售范围 */
async function agentAccountForm(agentId) {
  const [staffRes, agentRes, productsRes] = await Promise.all([
    apiGet("/admin/api/staff?role=agent"),
    apiGet(`/admin/api/agents/${agentId}`),
    apiGet("/admin/api/products"),
  ]);
  const account = staffRes.items.find((s) => s.agent_id === agentId) ?? null;
  const agent = agentRes.agent;
  const products = productsRes.items;
  const pickedProducts = account?.agent_profile?.product_ids ?? [];
  const pickedTerms = account?.agent_profile?.term_types ?? [];

  const scopeBlock = `
    <div class="field full" style="margin-top:14px"><span>可售产品（不勾 = 全部产品）</span>
      <div class="checkbox-list" data-scope-products>
        ${
          products
            .map(
              (p) =>
                `<label><input type="checkbox" value="${esc(p.id)}" ${pickedProducts.includes(p.id) ? "checked" : ""} /><span>${esc(p.name)}</span></label>`,
            )
            .join("") || '<span class="empty">还没有产品</span>'
        }
      </div>
    </div>
    <div class="field full"><span>可售卡类型（不勾 = 全部类型）</span>
      <div class="checkbox-list" data-scope-terms>
        ${[["hour", "按小时"], ["day", "按天"], ["month", "按月"], ["year", "按年"], ["count", "按次数"]]
          .map(
            ([v, label]) =>
              `<label><input type="checkbox" value="${v}" ${pickedTerms.includes(v) ? "checked" : ""} /><span>${label}</span></label>`,
          )
          .join("")}
      </div>
    </div>
    <div class="note">代理只能给这里勾选的产品 / 卡类型出卡，并按「代理定价 → 全局默认价」从账户余额扣费。</div>`;

  const accountBlock = account
    ? `<div class="note">该代理已有登录账号：<strong>${esc(account.email)}</strong>（${account.status === "active" ? "启用" : "停用"}）</div>
       <div class="form-grid" style="margin-top:12px">
         <label class="field"><span>重置密码（留空不改）</span><input name="password" type="password" autocomplete="new-password" /></label>
         <label class="field"><span>账号状态</span>
           <select name="status">
             <option value="active" ${account.status === "active" ? "selected" : ""}>启用</option>
             <option value="disabled" ${account.status !== "active" ? "selected" : ""}>停用</option>
           </select></label>
       </div>`
    : `<div class="note">该代理还没有登录账号。创建后它可登录后台，但只能看自己的卡密与余额。</div>
       <div class="form-grid" style="margin-top:12px">
         <label class="field"><span>登录邮箱</span><input name="email" placeholder="agent@example.com" /></label>
         <label class="field"><span>初始密码（≥6 位）</span><input name="password" type="password" autocomplete="new-password" /></label>
       </div>`;

  openModal({
    title: `代理账号：${agent?.name ?? ""}`,
    wide: true,
    body: `${accountBlock}${scopeBlock}`,
    footer: `<button class="btn btn-primary" data-save type="button">保存</button>
      ${account ? '<button class="btn btn-danger" data-del-account type="button">删除账号</button>' : ""}`,
    onMount: (m) => {
      const collect = () => ({
        product_ids: $$("[data-scope-products] input:checked", m).map((i) => i.value),
        term_types: $$("[data-scope-terms] input:checked", m).map((i) => i.value),
      });

      $("[data-save]", m).onclick = async () => {
        const scope = collect();
        const pwd = $('[name="password"]', m)?.value?.trim() ?? "";
        try {
          if (account) {
            const payload = { ...scope, status: $('[name="status"]', m).value };
            if (pwd) payload.password = pwd;
            await apiPatch(`/admin/api/staff/${account.id}`, payload);
            toast("账号已更新", "ok");
          } else {
            await apiPost("/admin/api/staff", {
              email: $('[name="email"]', m).value.trim(),
              password: $('[name="password"]', m).value,
              role: "agent",
              agent_id: agentId,
              ...scope,
            });
            toast("账号已创建，可用它登录后台", "ok");
          }
          $("#modal-root").innerHTML = "";
          navigate("agents", true);
        } catch (err) {
          toast(err.message, "error");
        }
      };

      const delBtn = $("[data-del-account]", m);
      if (delBtn) {
        delBtn.onclick = async () => {
          if (!(await confirmDialog(`删除账号 ${account.email}？删除后该代理将无法登录后台。`, { danger: true, okText: "删除" }))) {
            return;
          }
          try {
            await api("DELETE", `/admin/api/staff/${account.id}`);
            toast("账号已删除", "ok");
            $("#modal-root").innerHTML = "";
            navigate("agents", true);
          } catch (err) {
            toast(err.message, "error");
          }
        };
      }
    },
  });
}

async function renderAgents(root) {
  await ensureCatalog();
  const filters = state.agentFilters ?? (state.agentFilters = { q: "", status: "" });
  const query = new URLSearchParams();
  if (filters.q) query.set("q", filters.q);
  if (filters.status) query.set("status", filters.status);

  const res = await apiGet(`/admin/api/agents?${query}`);
  const items = res.items;
  const s = res.summary;

  root.innerHTML = `
    <div class="stat-grid">
      <div class="stat accent">
        <div class="stat-label">代理数</div>
        <div class="stat-value">${s.agents}</div>
        <div class="stat-hint">启用中 ${s.agents_active} 个</div>
      </div>
      <div class="stat">
        <div class="stat-label">归属代理的授权</div>
        <div class="stat-value">${s.attributed_licenses}</div>
        <div class="stat-hint">直销（无代理）${s.unattributed_licenses} 个</div>
      </div>
      <div class="stat">
        <div class="stat-label">累计营收</div>
        <div class="stat-value">${money(s.revenue_total)}</div>
        <div class="stat-hint">近 30 天 ${money(s.revenue_30d)}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>代理列表</h3>
        <div class="toolbar">
          <select data-f-status>
            <option value="">全部状态</option>
            <option value="active" ${filters.status === "active" ? "selected" : ""}>启用</option>
            <option value="disabled" ${filters.status === "disabled" ? "selected" : ""}>停用</option>
          </select>
          <input data-f-q placeholder="搜索代理编码 / 名称 / 联系人" value="${esc(filters.q)}" />
          <button class="btn btn-primary btn-sm" data-new type="button">+ 新建代理</button>
        </div>
      </div>
      <div class="card-body tight">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>代理</th><th>联系人</th><th>CDK（已核销/总量）</th><th>激活率</th>
                <th>授权</th><th>账户余额</th><th>最近激活</th><th>状态</th><th class="right">操作</th>
              </tr>
            </thead>
            <tbody>
              ${
                items.length
                  ? items
                      .map(
                        (c) => `<tr>
                          <td><strong>${esc(c.name)}</strong><div class="muted small mono">${esc(c.code)}</div></td>
                          <td>${esc(c.contact ?? "—")}${c.phone ? `<div class="muted small">${esc(c.phone)}</div>` : ""}</td>
                          <td>${c.cdk_used} / ${c.cdk_total}<div class="muted small">未用 ${c.cdk_unused}</div></td>
                          <td>${c.cdk_total > 0 ? percent(c.activation_rate) : "—"}</td>
                          <td>${c.license_total}（有效 ${c.license_active}）<div class="muted small">近 30 天新增 ${c.activated_30d}</div></td>
                          <td>${money(c.balance ?? 0)}<div class="muted small">${(c.balance ?? 0) > 0 ? "可继续生成" : "余额不足"}</div></td>
                          <td class="nowrap">${c.last_activated_at ? fmtDay(c.last_activated_at) : "—"}</td>
                          <td>${c.status === "active" ? '<span class="badge badge-ok">启用</span>' : '<span class="badge">停用</span>'}</td>
                          <td class="right">
                            <div class="btn-row" style="justify-content:flex-end">
                              <button class="btn btn-sm" data-credit="${esc(c.id)}" type="button">充值</button>
                              <button class="btn btn-sm" data-account="${esc(c.id)}" type="button">账号</button>
                              <button class="btn btn-sm" data-pricing="${esc(c.id)}" type="button">定价</button>
                              <button class="btn btn-sm" data-edit="${esc(c.id)}" type="button">编辑</button>
                              <button class="btn btn-sm" data-toggle="${esc(c.id)}" type="button">${c.status === "active" ? "停用" : "启用"}</button>
                              <button class="btn btn-sm" data-del="${esc(c.id)}" type="button">删除</button>
                            </div>
                          </td>
                        </tr>`,
                      )
                      .join("")
                  : emptyRow(9, "还没有代理。代理用于区分分销来源，并统计各代理的 CDK 与激活")
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>`;

  $("[data-new]", root).onclick = () => agentForm();
  $$("[data-account]", root).forEach((btn) => {
    btn.onclick = () => agentAccountForm(btn.dataset.account);
  });
  $$("[data-pricing]", root).forEach((btn) => {
    btn.onclick = () => agentPriceForm(btn.dataset.pricing);
  });
  $("[data-f-status]", root).onchange = (e) => {
    filters.status = e.target.value;
    navigate("agents", true);
  };
  $("[data-f-q]", root).onkeydown = (e) => {
    if (e.key === "Enter") {
      filters.q = e.target.value.trim();
      navigate("agents", true);
    }
  };
  $$("[data-credit]", root).forEach((btn) => {
    btn.onclick = () => agentCreditForm(state.agents.find((c) => c.id === btn.dataset.credit));
  });
  $$("[data-edit]", root).forEach((btn) => {
    btn.onclick = () => agentForm(state.agents.find((c) => c.id === btn.dataset.edit));
  });
  $$("[data-toggle]", root).forEach((btn) => {
    btn.onclick = async () => {
      const c = state.agents.find((x) => x.id === btn.dataset.toggle);
      try {
        await apiPatch(`/admin/api/agents/${c.id}`, {
          status: c.status === "active" ? "disabled" : "active",
        });
        toast("已更新", "ok");
        navigate("agents", true);
      } catch (err) {
        toast(err.message, "error");
      }
    };
  });
  $$("[data-del]", root).forEach((btn) => {
    btn.onclick = async () => {
      const c = state.agents.find((x) => x.id === btn.dataset.del);
      if (!(await confirmDialog(`删除代理「${c.name}」？已有 CDK 或授权的代理不能删除，只能停用。`, { danger: true, okText: "删除" }))) return;
      try {
        await api("DELETE", `/admin/api/agents/${c.id}`);
        toast("已删除", "ok");
        navigate("agents", true);
      } catch (err) {
        toast(err.message, "error");
      }
    };
  });
}

function agentCreditForm(agent) {
  if (!agent) return;
  openModal({
    title: `充值 / 扣减余额：${agent.name}`,
    body: `
      <div class="note">当前账户余额：<strong>${money(agent.balance ?? 0)}</strong>。代理生成卡密时按「单价 × 时长/次数 × 张数」从余额扣费。</div>
      <div class="form-grid">
        <label class="field"><span>金额（元，正数=充值，负数=扣减）</span><input name="amount" type="number" step="0.01" value="100" /></label>
      </div>`,
    footer: `<button class="btn" data-cancel type="button">取消</button><button class="btn btn-primary" data-save type="button">确定</button>`,
    onMount(modal, close) {
      $("[data-cancel]", modal).onclick = close;
      $("[data-save]", modal).onclick = async () => {
        const yuan = Number($('[name="amount"]', modal).value);
        if (!Number.isFinite(yuan) || yuan === 0) {
          toast("请填写非 0 的金额", "error");
          return;
        }
        try {
          const res = await apiPost(`/admin/api/agents/${agent.id}/balance`, { amount: Math.round(yuan * 100) });
          const after = res.agent?.balance ?? res.channel?.balance ?? 0;
          close();
          toast(`已更新，当前余额 ${money(after)}`, "ok");
          navigate("agents", true);
        } catch (err) {
          toast(err.message, "error");
        }
      };
    },
  });
}

function agentForm(agent) {
  const isNew = !agent;
  openModal({
    title: isNew ? "新建代理" : `编辑代理：${agent.name}`,
    body: `
      <div class="form-grid">
        <label class="field"><span>代理编码（小写字母 / 数字 / - / _）</span>
          <input name="code" value="${esc(agent?.code ?? "")}" ${isNew ? "" : "disabled"} placeholder="taobao" /></label>
        <label class="field"><span>代理名称</span><input name="name" value="${esc(agent?.name ?? "")}" placeholder="淘宝旗舰店" /></label>
        <label class="field"><span>联系人</span><input name="contact" value="${esc(agent?.contact ?? "")}" /></label>
        <label class="field"><span>电话</span><input name="phone" value="${esc(agent?.phone ?? "")}" /></label>
        <label class="field"><span>邮箱</span><input name="email" value="${esc(agent?.email ?? "")}" /></label>
        <label class="field full"><span>备注</span><textarea name="note">${esc(agent?.note ?? "")}</textarea></label>
      </div>`,
    footer: `<button class="btn" data-cancel type="button">取消</button><button class="btn btn-primary" data-save type="button">保存</button>`,
    onMount(modal, close) {
      $("[data-cancel]", modal).onclick = close;
      $("[data-save]", modal).onclick = async () => {
        const payload = {
          name: $('[name="name"]', modal).value.trim(),
          contact: $('[name="contact"]', modal).value.trim(),
          phone: $('[name="phone"]', modal).value.trim(),
          email: $('[name="email"]', modal).value.trim(),
          note: $('[name="note"]', modal).value.trim(),
        };
        if (!payload.name) {
          toast("请填写代理名称", "error");
          return;
        }
        try {
          if (isNew) {
            const code = $('[name="code"]', modal).value.trim();
            if (!code) {
              toast("请填写代理编码", "error");
              return;
            }
            await apiPost("/admin/api/agents", { ...payload, code });
          } else {
            await apiPatch(`/admin/api/agents/${agent.id}`, payload);
          }
          close();
          toast("已保存", "ok");
          navigate("agents");
        } catch (err) {
          toast(err.message, "error");
        }
      };
    },
  });
}

/* ============================ CDK ============================ */

/** CDK 详情：未激活的可改模块/兑换期/席位/时长，已激活的只读 */
async function cdkDetail(cdkId) {
  const data = await apiGet(`/admin/api/cdks/${cdkId}`);
  const c = data.cdk;
  const activated = data.activated;
  const productId = data.product?.id ?? c.product_id;
  const allMods = await apiGet(`/admin/api/products/${productId}/modules`).catch(() => ({ items: [] }));
  const mine = new Set((data.modules ?? []).map((m) => m.id));

  const moduleList = allMods.items.length
    ? allMods.items
        .map(
          (m) =>
            `<label><input type="checkbox" value="${esc(m.id)}" ${mine.has(m.id) ? "checked" : ""} ${activated ? "disabled" : ""} /><span>${esc(m.name)}（${esc(m.code)}）</span></label>`,
        )
        .join("")
    : '<span class="empty">该产品还没有模块</span>';

  const statusBadgeHtml =
    c.status === "unused"
      ? '<span class="badge badge-ok">未使用</span>'
      : c.status === "used"
        ? '<span class="badge">已激活</span>'
        : '<span class="badge badge-warn">已作废</span>';

  openModal({
    title: `CDK 详情：${c.code}`,
    wide: true,
    body: `
      <div class="kv">
        <dt>状态</dt><dd>${statusBadgeHtml}</dd>
        <dt>产品</dt><dd>${esc(data.product?.name ?? "—")} <span class="muted mono">${esc(data.product?.code ?? "")}</span></dd>
        <dt>计费</dt><dd>${licenseTermText({ term_type: c.term_type, term_value: c.term_value, max_usages: null, used_usages: 0 })}</dd>
        <dt>席位</dt><dd>${c.seats}</dd>
        <dt>兑换截止</dt><dd>${c.expires_at ? fmtTime(c.expires_at) : "不限"}</dd>
        <dt>绑定客户</dt><dd>${data.customer ? esc(data.customer.email ?? data.customer.name ?? "—") : "—"}</dd>
        <dt>生成时间</dt><dd>${fmtTime(c.created_at)}</dd>
        ${c.revoked_at ? `<dt>作废时间</dt><dd>${fmtTime(c.revoked_at)}${c.revoked_reason ? " · " + esc(c.revoked_reason) : ""}</dd>` : ""}
        ${c.note ? `<dt>备注</dt><dd>${esc(c.note)}</dd>` : ""}
      </div>
      ${
        activated
          ? '<div class="note">该 CDK 已被激活，不能再修改或删除。</div>'
          : `<div class="card"><div class="card-head"><h3>修改（仅未激活可改）</h3></div><div class="card-body">
        <div class="form-grid">
          <label class="field"><span>兑换截止时间（留空 = 不限）</span>
            <input name="exp" type="datetime-local" value="${c.expires_at ? toLocalInput(c.expires_at) : ""}" /></label>
          <label class="field"><span>席位</span><input name="seats" type="number" min="1" max="100" value="${c.seats}" /></label>
          <label class="field"><span>计费类型</span>
            <select name="term">
              ${["hour", "day", "month", "year", "count"]
                .map((t) => `<option value="${t}" ${c.term_type === t ? "selected" : ""}>${termText(t)}</option>`)
                .join("")}
            </select></label>
          <label class="field"><span>数量（时长 / 次数）</span>
            <input name="termValue" type="number" min="1" value="${c.term_value ?? c.days}" /></label>
        </div>
        <div class="field full"><span>包含模块（至少勾选 1 个）</span>
          <div class="checkbox-list" data-mods>${moduleList}</div></div>
        <div class="form-actions"><button class="btn btn-primary btn-sm" data-save type="button">保存修改</button></div>
      </div></div>`
      }`,
    footer: `<button class="btn" data-close2 type="button">关闭</button>${
      activated ? "" : '<button class="btn btn-danger" data-del type="button">删除此 CDK</button>'
    }`,
    onMount(modal, close) {
      $("[data-close2]", modal).onclick = () => {
        close();
        navigate("cdks", true);
      };
      if (activated) return;

      $("[data-save]", modal).onclick = async () => {
        const ids = $$("[data-mods] input:checked", modal).map((i) => i.value);
        if (!ids.length) {
          toast("请至少保留一个模块", "error");
          return;
        }
        const expVal = $('[name="exp"]', modal).value;
        const payload = {
          module_ids: ids,
          seats: Number($('[name="seats"]', modal).value),
          term_type: $('[name="term"]', modal).value,
          term_value: Number($('[name="termValue"]', modal).value),
          expires_at: expVal ? new Date(expVal).toISOString() : null,
        };
        try {
          await apiPatch(`/admin/api/cdks/${cdkId}`, payload);
          toast("已保存", "ok");
          close();
          navigate("cdks", true);
        } catch (err) {
          toast(err.message, "error");
        }
      };

      const delBtn = $("[data-del]", modal);
      if (delBtn) {
        delBtn.onclick = async () => {
          if (!(await confirmDialog(`删除 CDK ${c.code}？删除后不可恢复。`, { danger: true, okText: "删除" }))) return;
          try {
            await api("DELETE", `/admin/api/cdks/${cdkId}`);
            toast("已删除", "ok");
            close();
            navigate("cdks", true);
          } catch (err) {
            toast(err.message, "error");
          }
        };
      }
    },
  });
}

async function renderCdks(root) {
  await ensureCatalog();
  const pageKey = "cdks";
  const page = state.pages[pageKey] ?? 1;
  const filters = state.cdkFilters ?? (state.cdkFilters = { product_id: "", status: "", q: "", batch_id: "", agent_id: "" });
  const query = new URLSearchParams({ page: String(page), page_size: "20" });
  if (filters.product_id) query.set("product_id", filters.product_id);
  if (filters.status) query.set("status", filters.status);
  if (filters.q) query.set("q", filters.q);
  if (filters.batch_id) query.set("batch_id", filters.batch_id);
  if (filters.agent_id) query.set("agent_id", filters.agent_id);

  const [list, batches] = await Promise.all([
    apiGet(`/admin/api/cdks?${query}`),
    apiGet("/admin/api/cdk-batches"),
  ]);

  root.innerHTML = `
    <div class="card">
      <div class="card-head"><h3>批量生成 CDK</h3></div>
      <div class="card-body">
        <div class="form-grid">
          <label class="field"><span>产品</span><select name="product_id">${productOptions(state.products[0]?.id)}</select></label>
          <label class="field"><span>计费方式</span>
            <select name="term_type">
              <option value="day">按天</option>
              <option value="month">按月</option>
              <option value="year">按年</option>
              <option value="hour">按小时</option>
              <option value="count">按次数</option>
            </select></label>
          <label class="field"><span>数量（天 / 月 / 年 / 时 / 次）</span><input name="term_value" type="number" min="1" max="100000" value="365" /></label>
          <label class="field"><span>席位数（可绑定设备数）</span><input name="seats" type="number" min="1" max="100" value="1" /></label>
          <label class="field"><span>生成数量</span><input name="count" type="number" min="1" max="5000" value="10" /></label>
          <label class="field"><span>兑换截止时间（可选）</span><input name="redeem_before" type="datetime-local" /></label>
          <label class="field"><span>归属代理（可选）</span><select name="agent_id">${agentOptions()}</select></label>
          <label class="field"><span>结算单价（元）</span><input name="unit_price" type="number" min="0" step="0.01" value="0" /></label>
          <label class="field"><span>批次备注</span><input name="note" placeholder="例如 2025Q1 代理批次" /></label>
          <div class="field full"><span>包含模块</span>
            <div class="checkbox-list" data-modules>${moduleCheckboxes(state.products[0]?.id ?? "")}</div>
          </div>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" data-generate type="button">生成并导出</button>
          <span class="muted small">CDK 数量较多时会自动以 CSV 提供下载</span>
        </div>
        <div class="note" data-estimate style="margin-top:10px">选好产品 / 卡类型 / 数量后，这里会显示本次费用</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>CDK 列表</h3>
        <div class="toolbar">
          <select data-f-product>
            <option value="">全部产品</option>
            ${state.products.map((p) => `<option value="${esc(p.id)}" ${filters.product_id === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
          </select>
          <select data-f-status>
            ${["", "unused", "used", "revoked"].map((s) => `<option value="${s}" ${filters.status === s ? "selected" : ""}>${s === "" ? "全部状态" : CDK_STATUS[s][0]}</option>`).join("")}
          </select>
          <select data-f-batch>
            <option value="">全部批次</option>
            ${batches.items.map((b) => `<option value="${esc(b.id)}" ${filters.batch_id === b.id ? "selected" : ""}>${fmtDay(b.created_at)} · ${esc(b.product_code)} · ${b.count} 个</option>`).join("")}
          </select>
          <select data-f-agent ${state.role === "agent" ? "hidden" : ""}>
            <option value="">全部代理</option>
            <option value="__none__" ${filters.agent_id === "__none__" ? "selected" : ""}>无代理（直销）</option>
            ${state.agents.map((c) => `<option value="${esc(c.id)}" ${filters.agent_id === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}
          </select>
          <input data-f-q placeholder="搜索 CDK / 备注 / 客户邮箱" value="${esc(filters.q)}" />
          <button class="btn btn-sm" data-export type="button">导出 CSV</button>
        </div>
      </div>
      <div class="card-body tight">
        <div class="table-wrap">
          <table>
            <thead><tr><th>CDK</th><th>产品</th><th>代理</th><th>时长</th><th>席位</th><th>状态</th><th>绑定客户</th><th>到期时间</th><th>生成时间</th><th class="right">操作</th></tr></thead>
            <tbody>
              ${
                list.items.length
                  ? list.items
                      .map(
                        (c) => `<tr>
                          <td class="mono"><button class="btn btn-ghost btn-sm" data-copy="${esc(c.code)}" type="button" title="点击复制">${esc(c.code)}</button></td>
                          <td>${esc(c.product_code)}</td>
                          <td>${c.agent_code ? `<span class="badge badge-info">${esc(c.agent_name ?? c.agent_code)}</span>` : '<span class="muted small">直销</span>'}</td>
                          <td>${c.days} 天</td>
                          <td>${c.seats}</td>
                          <td>${statusBadge(CDK_STATUS, c.status)}</td>
                          <td>${customerCell(c.customer_name, c.customer_email)}</td>
                          <td class="nowrap">${c.license_expires_at ? `${fmtDay(c.license_expires_at)}<div class="muted small">${relDays(c.license_expires_at)}</div>` : '<span class="muted small">未激活</span>'}</td>
                          <td class="nowrap">${fmtTime(c.created_at)}</td>
                          <td class="right">
                            <div class="btn-row" style="justify-content:flex-end">
                              <button class="btn btn-sm" data-cdk-detail="${esc(c.id)}" type="button">详情</button>
                              ${c.status === "unused" ? `<button class="btn btn-sm" data-revoke="${esc(c.id)}" type="button">作废</button>` : ""}
                              ${c.status !== "used" && !c.customer_id ? `<button class="btn btn-sm btn-danger" data-cdk-del="${esc(c.id)}" type="button">删除</button>` : ""}
                            </div>
                          </td>
                        </tr>`,
                      )
                      .join("")
                  : emptyRow(10, "没有符合条件的 CDK")
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>`;

  const productSelect = $('[name="product_id"]', root);
  productSelect.onchange = () => {
    $("[data-modules]", root).innerHTML = moduleCheckboxes(productSelect.value);
  };

  // 实时金额预估：代理生成时显示本次费用与余额，管理员为赠送不扣费
  const estimateBox = $("[data-estimate]", root);
  const refreshEstimate = async () => {
    if (!estimateBox) return;
    const termType = $('[name="term_type"]', root)?.value ?? "day";
    const termValue = Number($('[name="term_value"]', root)?.value ?? 0);
    const count = Number($('[name="count"]', root)?.value ?? 0);
    if (!termValue || !count) {
      estimateBox.className = "note";
      estimateBox.textContent = "请填写数量与张数";
      return;
    }
    try {
      const est = await apiPost("/admin/api/cdks/estimate", {
        product_id: productSelect.value,
        module_ids: $$("[data-modules] input:checked", root).map((i) => i.value),
        term_type: termType,
        term_value: termValue,
        count,
      });
      const yuan = (v) => `¥${(Number(v) / 100).toFixed(2)}`;
      if (!est.payable) {
        estimateBox.className = "note";
        estimateBox.textContent = "管理员生成：属于赠送，不扣代理商余额";
        return;
      }
      if (!est.priced) {
        estimateBox.className = "note warn";
        estimateBox.textContent = "⚠ 该产品 / 卡类型尚未配置价格，无法生成";
        return;
      }
      estimateBox.className = est.sufficient ? "note" : "note warn";
      estimateBox.textContent =
        `本次需 ${yuan(est.total_price)}（单价 ${yuan(est.unit_price)} × ${est.term_value} × ${est.count} 张）` +
        (est.balance !== null ? ` · 当前余额 ${yuan(est.balance)}${est.sufficient ? "" : "（不足）"}` : "");
    } catch {
      estimateBox.className = "note";
      estimateBox.textContent = "估价失败，请检查填写";
    }
  };
  ["term_type", "term_value", "count"].forEach((n) => {
    const el = $(`[name="${n}"]`, root);
    if (el) {
      el.addEventListener("input", refreshEstimate);
      el.addEventListener("change", refreshEstimate);
    }
  });
  refreshEstimate();

  $("[data-generate]", root).onclick = async () => {
    const moduleIds = $$("[data-modules] input:checked", root).map((i) => i.value);
    const agentSelect = $('[name="agent_id"]', root);
    const payload = {
      product_id: productSelect.value,
      module_ids: moduleIds,
      days: Number($('[name="term_value"]', root).value),
      term_type: $('[name="term_type"]', root).value,
      term_value: Number($('[name="term_value"]', root).value),
      seats: Number($('[name="seats"]', root).value),
      count: Number($('[name="count"]', root).value),
      note: $('[name="note"]', root).value.trim(),
      // 代理可选；单价按「元」录入，提交时换算成「分」
      agent_id: agentSelect?.value || undefined,
      unit_price: Math.round(Number($('[name="unit_price"]', root).value || 0) * 100),
    };
    const redeemBefore = $('[name="redeem_before"]', root).value;
    if (redeemBefore) payload.redeem_before = new Date(redeemBefore).toISOString();

    const btn = $("[data-generate]", root);
    btn.disabled = true;
    try {
      const res = await apiPost("/admin/api/cdks/generate", payload);
      showGeneratedCodes(res);
      navigate("cdks", true);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  };

  $("[data-f-product]", root).onchange = (e) => {
    filters.product_id = e.target.value;
    state.pages[pageKey] = 1;
    navigate("cdks", true);
  };
  $("[data-f-status]", root).onchange = (e) => {
    filters.status = e.target.value;
    state.pages[pageKey] = 1;
    navigate("cdks", true);
  };
  $("[data-f-batch]", root).onchange = (e) => {
    filters.batch_id = e.target.value;
    state.pages[pageKey] = 1;
    navigate("cdks", true);
  };
  $("[data-f-agent]", root).onchange = (e) => {
    filters.agent_id = e.target.value;
    state.pages[pageKey] = 1;
    navigate("cdks", true);
  };
  $("[data-f-q]", root).onkeydown = (e) => {
    if (e.key === "Enter") {
      filters.q = e.target.value.trim();
      state.pages[pageKey] = 1;
      navigate("cdks", true);
    }
  };
  $("[data-export]", root).onclick = async () => {
    const params = new URLSearchParams();
    if (filters.batch_id) params.set("batch_id", filters.batch_id);
    if (filters.product_id) params.set("product_id", filters.product_id);
    if (filters.status) params.set("status", filters.status);
    const res = await fetch(`/admin/api/cdks/export?${params}`, {
      headers: { Authorization: `Bearer ${state.token}` },
    });
    if (!res.ok) {
      toast("导出失败", "error");
      return;
    }
    downloadText(`cdks-${Date.now()}.csv`, await res.text());
  };

  $$("[data-copy]", root).forEach((btn) => {
    btn.onclick = () => copyText(btn.dataset.copy);
  });
  $$("[data-cdk-detail]", root).forEach((btn) => {
    btn.onclick = () => cdkDetail(btn.dataset.cdkDetail);
  });
  $$("[data-cdk-del]", root).forEach((btn) => {
    btn.onclick = async () => {
      const code = btn.closest("tr")?.querySelector(".mono")?.textContent?.trim() ?? "";
      if (!(await confirmDialog(`删除 CDK ${code}？删除后不可恢复。`, { danger: true, okText: "删除" }))) return;
      try {
        await api("DELETE", `/admin/api/cdks/${btn.dataset.cdkDel}`);
        toast("已删除", "ok");
        navigate("cdks", true);
      } catch (err) {
        toast(err.message, "error");
      }
    };
  });
  $$("[data-revoke]", root).forEach((btn) => {
    btn.onclick = async () => {
      if (!(await confirmDialog("作废该 CDK？作废后无法再激活。", { danger: true, okText: "作废" }))) return;
      try {
        await apiPost(`/admin/api/cdks/${btn.dataset.revoke}/revoke`, { reason: "后台手动作废" });
        toast("已作废", "ok");
        navigate("cdks", true);
      } catch (err) {
        toast(err.message, "error");
      }
    };
  });

  const pagerHost = el(`<div></div>`);
  pagerHost.appendChild(
    pageNav(pageKey, list.total, 20, () => navigate("cdks", true)),
  );
  $(".card:last-child", root).appendChild(pagerHost.firstElementChild);
}

function showGeneratedCodes(res) {
  openModal({
    title: `已生成 ${res.codes.length} 个 CDK`,
    wide: true,
    body: `
      <div class="note">产品 <strong>${esc(res.product.name)}</strong> · ${res.batch.days} 天 · ${res.batch.seats} 席位<br />
        模块：${res.module_codes.map((c) => `<code>${esc(c)}</code>`).join(" ") || "（无）"}</div>
      <div class="code-block">${res.codes.map(esc).join("\n")}</div>`,
    footer: `<button class="btn" data-copy-all type="button">复制全部</button>
             <button class="btn" data-csv type="button">下载 CSV</button>
             <button class="btn btn-primary" data-ok type="button">完成</button>`,
    onMount(modal, close) {
      $("[data-copy-all]", modal).onclick = () => copyText(res.codes.join("\n"));
      $("[data-csv]", modal).onclick = () => downloadText(`cdks-${res.batch.id}.csv`, res.csv);
      $("[data-ok]", modal).onclick = close;
    },
  });
}

/* ============================ 授权 ============================ */

async function renderLicenses(root) {
  await ensureCatalog();
  const pageKey = "licenses";
  const page = state.pages[pageKey] ?? 1;
  const filters = state.licenseFilters ?? (state.licenseFilters = { status: "", product_id: "", q: "", expiring: "" });
  const query = new URLSearchParams({ page: String(page), page_size: "20" });
  if (filters.status) query.set("status", filters.status);
  if (filters.product_id) query.set("product_id", filters.product_id);
  if (filters.q) query.set("q", filters.q);
  if (filters.expiring) query.set("expiring_within_days", filters.expiring);

  const list = await apiGet(`/admin/api/licenses?${query}`);

  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>授权列表</h3>
        <div class="toolbar">
          <select data-f-status>
            ${["", "active", "expired", "pending", "suspended", "revoked"]
              .map((s) => `<option value="${s}" ${filters.status === s ? "selected" : ""}>${s === "" ? "全部状态" : LICENSE_STATUS[s][0]}</option>`)
              .join("")}
          </select>
          <select data-f-product>
            <option value="">全部产品</option>
            ${state.products.map((p) => `<option value="${esc(p.id)}" ${filters.product_id === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
          </select>
          <select data-f-expiring>
            <option value="">不限到期</option>
            <option value="7" ${filters.expiring === "7" ? "selected" : ""}>7 天内到期</option>
            <option value="30" ${filters.expiring === "30" ? "selected" : ""}>30 天内到期</option>
          </select>
          <input data-f-q placeholder="搜索单号 / 客户邮箱 / 客户名称" value="${esc(filters.q)}" />
          <button class="btn btn-primary btn-sm" data-new type="button">+ 手动开通</button>
        </div>
      </div>
      <div class="card-body tight">
        <div class="table-wrap">
          <table>
            <thead><tr><th>授权单号</th><th>客户</th><th>产品</th><th>计费</th><th>状态</th><th>到期时间</th><th>剩余</th><th>席位</th><th class="right">操作</th></tr></thead>
            <tbody>
              ${
                list.items.length
                  ? list.items
                      .map(
                        (l) => `<tr>
                          <td class="mono">${esc(l.license_no)}</td>
                          <td>${customerCell(l.customer_name, l.customer_email)}</td>
                          <td>${esc(l.product_code)}</td>
                          <td class="nowrap">${licenseTermText(l)}</td>
                          <td>${statusBadge(LICENSE_STATUS, l.eff_status)}</td>
                          <td class="nowrap">${fmtDay(l.expires_at)}</td>
                          <td class="nowrap">${relDays(l.expires_at)}</td>
                          <td>${l.active_devices}/${l.seats}</td>
                          <td class="right"><button class="btn btn-sm" data-license="${esc(l.id)}" type="button">管理</button></td>
                        </tr>`,
                      )
                      .join("")
                  : emptyRow(9, "没有符合条件的授权")
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>`;

  $("[data-f-status]", root).onchange = (e) => {
    filters.status = e.target.value;
    state.pages[pageKey] = 1;
    navigate("licenses", true);
  };
  $("[data-f-product]", root).onchange = (e) => {
    filters.product_id = e.target.value;
    state.pages[pageKey] = 1;
    navigate("licenses", true);
  };
  $("[data-f-expiring]", root).onchange = (e) => {
    filters.expiring = e.target.value;
    state.pages[pageKey] = 1;
    navigate("licenses", true);
  };
  $("[data-f-q]", root).onkeydown = (e) => {
    if (e.key === "Enter") {
      filters.q = e.target.value.trim();
      state.pages[pageKey] = 1;
      navigate("licenses", true);
    }
  };
  $("[data-new]", root).onclick = () => manualLicenseForm();

  $$("[data-license]", root).forEach((btn) => {
    btn.onclick = () => openLicenseDetail(btn.dataset.license);
  });

  const pager = pageNav(pageKey, list.total, 20, () => navigate("licenses", true));
  $(".card", root).appendChild(pager);
}

async function openLicenseDetail(id) {
  const data = await apiGet(`/admin/api/licenses/${id}`);
  const l = data.license;
  const devices = data.devices;

  const body = `
    <div class="kv">
      <dt>授权单号</dt><dd class="mono">${esc(l.license_no)}</dd>
      <dt>状态</dt><dd>${statusBadge(LICENSE_STATUS, l.eff_status)} ${l.kind === "trial" ? '<span class="badge badge-info">试用</span>' : ""} <span class="muted small">来源 ${esc(l.source ?? "cdk")}</span></dd>
      <dt>客户</dt><dd>${customerCell(data.customer?.name, data.customer?.email)}</dd>
      <dt>产品</dt><dd>${esc(l.product_name)} <span class="muted mono">${esc(l.product_code)}</span></dd>
      <dt>模块</dt><dd>${
        (data.modules ?? [])
          .map(
            (m) =>
              `<span class="badge ${m.custom_expiry ? "badge-warn" : "badge-info"}" title="${m.custom_expiry ? "该模块有单独到期时间" : "跟随授权到期"}">${esc(m.name)}${m.expires_at ? " · " + fmtDay(m.expires_at) : ""}</span>`,
          )
          .join(" ") || "（无）"
      }</dd>
      <dt>生效时间</dt><dd>${fmtTime(l.starts_at)}</dd>
      <dt>到期时间</dt><dd>${fmtTime(l.expires_at)} <span class="badge badge-warn">${relDays(l.expires_at)}</span></dd>
      <dt>席位</dt><dd>${l.active_devices} / ${l.seats} 台在用</dd>
      <dt>离线宽限</dt><dd>${l.offline_grace_days} 天</dd>
      <dt>最近心跳</dt><dd>${fmtTime(l.last_heartbeat_at)}</dd>
      <dt>创建时间</dt><dd>${fmtTime(l.created_at)}</dd>
      ${l.note ? `<dt>备注</dt><dd>${esc(l.note)}</dd>` : ""}
    </div>

    <div class="card">
      <div class="card-head"><h3>设备与解绑历史</h3><span class="muted small">共 ${devices.length} 条记录</span></div>
      <div class="card-body tight">
        <div class="table-wrap">
          <table>
            <thead><tr><th>设备标识</th><th>名称</th><th>平台</th><th>状态</th><th>首次绑定</th><th>最近心跳</th><th>解绑时间</th><th></th></tr></thead>
            <tbody>
              ${
                devices.length
                  ? devices
                      .map(
                        (d) => `<tr>
                          <td class="mono">${esc(d.device_id)}</td>
                          <td>${esc(d.device_name ?? "—")}</td>
                          <td>${esc(d.platform ?? "—")}</td>
                          <td>${d.status === "active" ? '<span class="badge badge-ok">在用</span>' : '<span class="badge">已解绑</span>'}</td>
                          <td class="nowrap">${fmtTime(d.first_seen_at)}</td>
                          <td class="nowrap">${fmtTime(d.last_seen_at)}</td>
                          <td class="nowrap">${d.released_at ? fmtTime(d.released_at) : "—"}</td>
                          <td class="right">
                            <div class="btn-row" style="justify-content:flex-end">
                              ${d.status === "active" ? `<button class="btn btn-sm" data-free="${esc(d.device_id)}" type="button">解绑</button>` : `<button class="btn btn-sm" data-rebind="${esc(d.device_id)}" type="button">重新绑定</button>`}
                            </div>
                          </td>
                        </tr>`,
                      )
                      .join("")
                  : emptyRow(8, "客户端还没激活过")
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>调整与操作</h3></div>
      <div class="card-body">
        <div class="form-grid">
          <label class="field"><span>到期时间（直接设定）</span>
            <input name="expires_at" type="datetime-local" value="${toLocalInput(l.expires_at)}" /></label>
          <label class="field"><span>席位数</span><input name="seats" type="number" min="1" max="100" value="${l.seats}" /></label>
          <label class="field"><span>最长离线时间（天，默认取全局 ${state.config?.offline_grace_days ?? 7}）</span>
            <input name="grace" type="number" min="0" max="365" value="${l.offline_grace_days}" /></label>
          <label class="field"><span>备注</span><input name="note" value="${esc(l.note ?? "")}" /></label>
        </div>
        <div class="note">「最长离线时间」决定许可证文件在完全离线时能用多久（仍以本授权的实际到期时间封顶）。保存后点下方「重新签发许可证文件」立即生效，否则客户端下次心跳（${state.config?.heartbeat_interval_hours ?? 24} 小时）后按新值计算。</div>
        <div class="form-actions">
          <button class="btn btn-primary btn-sm" data-save type="button">保存调整</button>
          <button class="btn btn-sm" data-extend-30 type="button">+30 天</button>
          <button class="btn btn-sm" data-extend-90 type="button">+90 天</button>
          <button class="btn btn-sm" data-extend-365 type="button">+365 天</button>
          <button class="btn btn-sm" data-extend-custom type="button">自定义延长…</button>
        </div>
        <div class="form-actions">
          <button class="btn btn-sm" data-suspend type="button">${l.status === "suspended" ? "恢复授权" : "暂停授权"}</button>
          <button class="btn btn-sm" data-edit-modules type="button">编辑模块</button>
          <button class="btn btn-sm" data-bind-device type="button">绑定新设备</button>
          <button class="btn btn-sm" data-reset-devices type="button">重置全部设备</button>
          <button class="btn btn-sm" data-rotate type="button">重置许可证密钥</button>
          <button class="btn btn-sm" data-reissue type="button">重新签发许可证文件</button>
          ${
            l.status === "revoked"
              ? '<button class="btn btn-sm" data-restore type="button">恢复授权</button>'
              : '<button class="btn btn-sm btn-danger" data-revoke type="button">吊销授权</button>'
          }
        </div>
      </div>
    </div>`;

  openModal({
    title: `授权管理：${l.license_no}`,
    wide: true,
    body,
    footer: `<button class="btn" data-close2 type="button">关闭</button>`,
    onMount(modal, close) {
      const editModulesBtn = $("[data-edit-modules]", modal);
      if (editModulesBtn) {
        editModulesBtn.onclick = async () => {
          const mods = await apiGet(`/admin/api/products/${l.product_id}/modules`).catch(() => ({ items: [] }));
          const picked = new Set((data.modules ?? []).map((m) => m.id));
          openModal({
            title: `编辑模块：${l.license_no}`,
            body: `<div class="note">可以勾选或取消，但必须至少保留一个模块；保存后客户端下次心跳/重新签发即可拿到新模块。</div>
              <div class="checkbox-list" data-mods style="margin-top:12px">
                ${
                  mods.items
                    .map(
                      (m) =>
                        `<label><input type="checkbox" value="${esc(m.id)}" ${picked.has(m.id) ? "checked" : ""} /><span>${esc(m.name)}（${esc(m.code)}）</span></label>`,
                    )
                    .join("") || '<span class="empty">该产品还没有模块</span>'
                }
              </div>`,
            footer: `<button class="btn" data-c type="button">取消</button><button class="btn btn-primary" data-ok type="button">保存</button>`,
            onMount(m2, close2) {
              $("[data-c]", m2).onclick = close2;
              $("[data-ok]", m2).onclick = async () => {
                const ids = $$("[data-mods] input:checked", m2).map((i) => i.value);
                if (!ids.length) {
                  toast("请至少保留一个模块", "error");
                  return;
                }
                try {
                  await apiPatch(`/admin/api/licenses/${id}`, { module_ids: ids });
                  toast("模块已更新", "ok");
                  close2();
                  close();
                  navigate("licenses", true);
                } catch (err) {
                  toast(err.message, "error");
                }
              };
            },
          });
        };
      }

      const refresh = async () => {
        close();
        await navigate("licenses", true);
        openLicenseDetail(id);
      };
      const act = async (fn, successMessage) => {
        try {
          await fn();
          toast(successMessage, "ok");
          await refresh();
        } catch (err) {
          toast(err.message, "error");
        }
      };

      $("[data-close2]", modal).onclick = () => {
        close();
        navigate("licenses", true);
      };

      $("[data-save]", modal).onclick = () =>
        act(async () => {
          const payload = {
            seats: Number($('[name="seats"]', modal).value),
            offline_grace_days: Number($('[name="grace"]', modal).value),
            note: $('[name="note"]', modal).value.trim(),
          };
          const dt = $('[name="expires_at"]', modal).value;
          if (dt) payload.expires_at = new Date(dt).toISOString();
          await apiPatch(`/admin/api/licenses/${id}`, payload);
        }, "已保存");

      for (const days of [30, 90, 365]) {
        $(`[data-extend-${days}]`, modal).onclick = () =>
          act(() => apiPost(`/admin/api/licenses/${id}/extend`, { days }), `已延长 ${days} 天`);
      }

      $("[data-extend-custom]", modal).onclick = () => {
        openModal({
          title: "自定义延长",
          body: `<label class="field"><span>延长天数（可为负数，表示缩短）</span>
                   <input name="days" type="number" value="30" /></label>
                 <label class="checkbox-list" style="margin-top:10px"><label><input type="checkbox" name="from_now" />
                   <span>从当前时间起算（已过期授权推荐勾选）</span></label></label>`,
          footer: `<button class="btn" data-c type="button">取消</button><button class="btn btn-primary" data-ok type="button">确定</button>`,
          onMount(m, closeInner) {
            $("[data-c]", m).onclick = closeInner;
            $("[data-ok]", m).onclick = async () => {
              const days = Number($('[name="days"]', m).value);
              const fromNow = $('[name="from_now"]', m).checked;
              closeInner();
              await act(() => apiPost(`/admin/api/licenses/${id}/extend`, { days, from_now: fromNow }), "已更新到期时间");
            };
          },
        });
      };

      $("[data-suspend]", modal).onclick = () =>
        act(
          () => apiPatch(`/admin/api/licenses/${id}`, { status: l.status === "suspended" ? "active" : "suspended" }),
          l.status === "suspended" ? "已恢复" : "已暂停",
        );

      $("[data-reset-devices]", modal).onclick = async () => {
        if (!(await confirmDialog("重置后所有设备都需要重新激活，确定继续？", { danger: true, okText: "重置" }))) return;
        await act(() => apiPost(`/admin/api/licenses/${id}/reset-devices`), "已重置设备");
      };

      $("[data-rotate]", modal).onclick = async () => {
        if (!(await confirmDialog("重置密钥后，客户端本地保存的旧密钥立即失效，需要重新获取。确定继续？", { danger: true, okText: "重置" }))) return;
        try {
          const res = await apiPost(`/admin/api/licenses/${id}/rotate-key`);
          openModal({
            title: "新的许可证密钥",
            body: `<div class="note warn">只显示一次，请立即转交客户，旧密钥已作废。</div>
                   <div class="copy-row"><input readonly value="${esc(res.license_key)}" />
                   <button class="btn btn-sm" data-copy type="button">复制</button></div>`,
            footer: `<button class="btn btn-primary" data-ok type="button">完成</button>`,
            onMount(m, closeInner) {
              $("[data-copy]", m).onclick = () => copyText(res.license_key);
              $("[data-ok]", m).onclick = () => {
                closeInner();
                refresh();
              };
            },
          });
        } catch (err) {
          toast(err.message, "error");
        }
      };

      $("[data-reissue]", modal).onclick = async () => {
        try {
          const res = await apiPost(`/admin/api/licenses/${id}/reissue`);
          openModal({
            title: "重新签发的许可证文件",
            wide: true,
            body: `<div class="note">设备：<code>${esc(res.device_id)}</code> · 离线有效期至 ${fmtTime(res.offline_expires_at)}</div>
                   <div class="code-block">${esc(res.license_file)}</div>`,
            footer: `<button class="btn" data-copy type="button">复制</button><button class="btn btn-primary" data-ok type="button">完成</button>`,
            onMount(m, closeInner) {
              $("[data-copy]", m).onclick = () => copyText(res.license_file);
              $("[data-ok]", m).onclick = closeInner;
            },
          });
        } catch (err) {
          toast(err.message, "error");
        }
      };

      const restoreBtn = $("[data-restore]", modal);
      if (restoreBtn) {
        restoreBtn.onclick = async () => {
          if (!(await confirmDialog("恢复该授权的正常状态？", { okText: "恢复" }))) return;
          await act(async () => {
            await apiPatch(`/admin/api/licenses/${id}`, { status: "active" });
          }, "已恢复");
        };
      }

      const revokeBtn = $("[data-revoke]", modal);
      if (revokeBtn) revokeBtn.onclick = async () => {
        if (!(await confirmDialog("吊销后客户端心跳会立即失败且无法恢复，确定继续？", { danger: true, okText: "吊销" }))) return;
        await act(() => apiPost(`/admin/api/licenses/${id}/revoke`, { reason: "后台手动吊销" }), "已吊销");
      };

      $("[data-bind-device]", modal).onclick = () => {
        openModal({
          title: "绑定新设备",
          body: `
            <div class="note">绑定后到期时间沿用本授权（从首次激活起算），<strong>不会被重置</strong>；若席位已满请先解绑其它设备。</div>
            <div class="form-grid">
              <label class="field"><span>设备标识</span><input name="device_id" placeholder="PC-OFFICE-01" /></label>
              <label class="field"><span>设备名称</span><input name="device_name" placeholder="办公室主机" /></label>
              <label class="field"><span>平台</span><input name="platform" placeholder="Windows 11" /></label>
            </div>`,
          footer: `<button class="btn" data-c type="button">取消</button><button class="btn btn-primary" data-ok type="button">绑定</button>`,
          onMount(m, closeInner) {
            $("[data-c]", m).onclick = closeInner;
            $("[data-ok]", m).onclick = async () => {
              const deviceId = $('[name="device_id"]', m).value.trim();
              if (!deviceId) {
                toast("请填写设备标识", "error");
                return;
              }
              try {
                const res = await apiPost(`/admin/api/licenses/${id}/devices`, {
                  device_id: deviceId,
                  device_name: $('[name="device_name"]', m).value.trim(),
                  platform: $('[name="platform"]', m).value.trim(),
                });
                closeInner();
                toast(`已绑定，到期时间不变：${fmtDay(res.expires_at)}`, "ok");
                await refresh();
              } catch (err) {
                toast(err.message, "error");
              }
            };
          },
        });
      };

      $$("[data-rebind]", modal).forEach((btn) => {
        btn.onclick = async () => {
          const deviceId = btn.dataset.rebind;
          if (!(await confirmDialog(`把设备 ${deviceId} 重新绑定到本授权？到期时间不变。`, { okText: "重新绑定" }))) return;
          try {
            const res = await apiPost(`/admin/api/licenses/${id}/devices`, { device_id: deviceId });
            toast(`已重新绑定，到期时间仍为 ${fmtDay(res.expires_at)}`, "ok");
            await refresh();
          } catch (err) {
            toast(err.message, "error");
          }
        };
      });

      $$("[data-free]", modal).forEach((btn) => {
        btn.onclick = async () => {
          if (!(await confirmDialog(`解绑设备 ${btn.dataset.free}？`, { okText: "解绑" }))) return;
          try {
            await apiPost(
              `/admin/api/licenses/${id}/devices/${encodeURIComponent(btn.dataset.free)}/release`,
            );
            toast("已解绑", "ok");
            await refresh();
          } catch (err) {
            toast(err.message, "error");
          }
        };
      });
    },
  });
}

async function manualLicenseForm() {
  await ensureCatalog();
  openModal({
    title: "手动开通授权（不走 CDK）",
    body: `
      <div class="form-grid">
        <label class="field"><span>产品</span><select name="product_id">${productOptions(state.products[0]?.id)}</select></label>
        <label class="field"><span>客户邮箱（需已注册）</span><input name="email" placeholder="buyer@example.com" /></label>
        <label class="field"><span>授权天数</span><input name="days" type="number" min="1" value="365" /></label>
        <label class="field"><span>席位数</span><input name="seats" type="number" min="1" value="1" /></label>
        <div class="field full"><span>包含模块</span><div class="checkbox-list" data-modules>${moduleCheckboxes(state.products[0]?.id ?? "")}</div></div>
      </div>`,
    footer: `<button class="btn" data-c type="button">取消</button><button class="btn btn-primary" data-ok type="button">开通</button>`,
    onMount(modal, close) {
      const productSelect = $('[name="product_id"]', modal);
      productSelect.onchange = () => {
        $("[data-modules]", modal).innerHTML = moduleCheckboxes(productSelect.value);
      };
      $("[data-c]", modal).onclick = close;
      $("[data-ok]", modal).onclick = async () => {
        const email = $('[name="email"]', modal).value.trim();
        if (!email) {
          toast("请填写客户邮箱", "error");
          return;
        }
        try {
          const res = await apiPost("/admin/api/licenses", {
            product_id: productSelect.value,
            customer_email: email,
            days: Number($('[name="days"]', modal).value),
            seats: Number($('[name="seats"]', modal).value),
            module_ids: $$("[data-modules] input:checked", modal).map((i) => i.value),
          });
          close();
          openModal({
            title: "授权已开通",
            body: `<div class="note warn">许可证密钥只显示一次，请立即转交客户。</div>
                   <div class="copy-row"><input readonly value="${esc(res.license_key)}" />
                   <button class="btn btn-sm" data-copy type="button">复制</button></div>`,
            footer: `<button class="btn btn-primary" data-ok2 type="button">完成</button>`,
            onMount(m, closeInner) {
              $("[data-copy]", m).onclick = () => copyText(res.license_key);
              $("[data-ok2]", m).onclick = () => {
                closeInner();
                navigate("licenses");
              };
            },
          });
        } catch (err) {
          toast(err.message, "error");
        }
      };
    },
  });
}

/* ============================ 客户 ============================ */

async function renderCustomers(root) {
  const pageKey = "customers";
  const page = state.pages[pageKey] ?? 1;
  const filters = state.customerFilters ?? (state.customerFilters = { q: "", status: "" });
  const query = new URLSearchParams({ page: String(page), page_size: "20" });
  if (filters.q) query.set("q", filters.q);
  if (filters.status) query.set("status", filters.status);

  const list = await apiGet(`/admin/api/customers?${query}`);

  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>客户列表</h3>
        <div class="toolbar">
          <select data-f-status>
            <option value="">全部状态</option>
            <option value="active" ${filters.status === "active" ? "selected" : ""}>正常</option>
            <option value="disabled" ${filters.status === "disabled" ? "selected" : ""}>已停用</option>
          </select>
          <input data-f-q placeholder="搜索邮箱 / 姓名 / 公司" value="${esc(filters.q)}" />
          <button class="btn btn-primary btn-sm" data-new-customer type="button" ${state.role === "agent" ? "hidden" : ""}>+ 新增客户</button>
        </div>
      </div>
      <div class="card-body tight">
        <div class="table-wrap">
          <table>
            <thead><tr><th>客户</th><th>授权</th><th>最近到期</th><th>状态</th><th>注册时间</th><th class="right">操作</th></tr></thead>
            <tbody>
              ${
                list.items.length
                  ? list.items
                      .map(
                        (c) => `<tr>
                          <td>
                            ${customerCell(
                              c.name,
                              c.email,
                              c.company ? `<span class="cell-sub">${esc(c.company)}</span>` : "",
                            )}
                            ${!c.email ? '<span class="cell-sub">无登录账号（CDK 匿名激活）</span>' : ""}
                          </td>
                          <td>${c.license_count} 个（有效 ${c.active_license_count}）</td>
                          <td class="nowrap">${fmtDay(c.last_expires_at)}</td>
                          <td>${c.status === "active" ? '<span class="badge badge-ok">正常</span>' : '<span class="badge badge-warn">已停用</span>'}</td>
                          <td class="nowrap">${fmtDay(c.created_at)}</td>
                          <td class="right">
                            <div class="btn-row" style="justify-content:flex-end">
                              <button class="btn btn-sm" data-adj="${esc(c.id)}" type="button">调整到期</button>
                              <button class="btn btn-sm" data-customer="${esc(c.id)}" type="button">详情</button>
                            </div>
                          </td>
                        </tr>`,
                      )
                      .join("")
                  : emptyRow(6, "没有客户")
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>`;

  $("[data-f-status]", root).onchange = (e) => {
    filters.status = e.target.value;
    state.pages[pageKey] = 1;
    navigate("customers", true);
  };
  $("[data-f-q]", root).onkeydown = (e) => {
    if (e.key === "Enter") {
      filters.q = e.target.value.trim();
      state.pages[pageKey] = 1;
      navigate("customers", true);
    }
  };
  $("[data-new-customer]", root).onclick = () => customerForm();
  $$("[data-adj]", root).forEach((btn) => {
    btn.onclick = () => customerExpiryForm(btn.dataset.adj);
  });
  $$("[data-customer]", root).forEach((btn) => {
    btn.onclick = () => openCustomerDetail(btn.dataset.customer);
  });

  $(".card", root).appendChild(pageNav(pageKey, list.total, 20, () => navigate("customers", true)));
}

function customerForm() {
  openModal({
    title: "新增客户",
    body: `
      <div class="form-grid">
        <label class="field"><span>邮箱（用于登录，留空 = 仅后台代管）</span><input name="email" type="email" placeholder="buyer@example.com" /></label>
        <label class="field"><span>登录密码（≥6 位，留空 = 不能登录）</span><input name="password" type="password" autocomplete="new-password" /></label>
        <label class="field"><span>姓名</span><input name="name" placeholder="张三" /></label>
        <label class="field"><span>公司</span><input name="company" /></label>
        <label class="field"><span>电话</span><input name="phone" /></label>
        <label class="field full"><span>备注</span><textarea name="note"></textarea></label>
      </div>
      <div class="note">留空邮箱可创建「匿名客户」，适用于线下客户由你代为开通授权；之后可用「重置密码」或补录邮箱。</div>`,
    footer: `<button class="btn" data-cancel type="button">取消</button><button class="btn btn-primary" data-save type="button">创建</button>`,
    onMount(modal, close) {
      $("[data-cancel]", modal).onclick = close;
      $("[data-save]", modal).onclick = async () => {
        const payload = {
          email: $('[name="email"]', modal).value.trim(),
          password: $('[name="password"]', modal).value,
          name: $('[name="name"]', modal).value.trim(),
          company: $('[name="company"]', modal).value.trim(),
          phone: $('[name="phone"]', modal).value.trim(),
          note: $('[name="note"]', modal).value.trim(),
        };
        if (!payload.email && !payload.name) {
          toast("请至少填写邮箱或姓名", "error");
          return;
        }
        try {
          const res = await apiPost("/admin/api/customers", payload);
          close();
          toast("客户已创建", "ok");
          navigate("customers", true);
          openCustomerDetail(res.customer.id);
        } catch (err) {
          toast(err.message, "error");
        }
      };
    },
  });
}

async function customerExpiryForm(customerId) {
  const data = await apiGet(`/admin/api/customers/${customerId}`);
  const c = data.customer;
  const licenses = data.licenses || [];
  if (!licenses.length) {
    toast("该客户还没有授权，请先在「授权」页手动开通", "error");
    return;
  }

  openModal({
    title: `调整到期：${c.email ?? c.name ?? "客户"}`,
    body: `
      <div class="note">该客户有 ${licenses.length} 个授权。调整后客户端下次心跳即可拿到新到期时间（心跳周期 ${state.config?.heartbeat_interval_hours ?? 24} 小时）。${
        state.role === "agent"
          ? "代理可以缩短、也可以改回，但<b>不能超过 CDK 激活时的实际到期时间</b>（超出部分会被自动限制回原到期时间）。"
          : ""
      }</div>
      <div class="form-grid">
        <label class="field"><span>按天调整（正数延长 / 负数缩短）</span><input name="days" type="number" value="30" /></label>
        <label class="field"><span>或直接设定到期时间</span><input name="expires_at" type="datetime-local" /></label>
      </div>
      <div class="field"><span>作用范围</span>
        <div class="checkbox-list" data-lic>
          ${licenses
            .map(
              (l) => `<label><input type="checkbox" value="${esc(l.id)}" checked />
                <span>${esc(l.license_no)} · ${esc(l.product_code)} · 到期 ${fmtDay(l.expires_at)}${l.kind === "trial" ? " · 试用" : ""}</span></label>`,
            )
            .join("")}
        </div>
      </div>
      <div class="note warn">「按天调整」和「直接设定时间」二选一；填了日期时以日期为准。</div>`,
    footer: `<button class="btn" data-cancel type="button">取消</button><button class="btn btn-primary" data-save type="button">应用</button>`,
    onMount(modal, close) {
      $("[data-cancel]", modal).onclick = close;
      $("[data-save]", modal).onclick = async () => {
        const ids = $$("[data-lic] input:checked", modal).map((i) => i.value);
        if (!ids.length) {
          toast("请至少选择一个授权", "error");
          return;
        }
        const dt = $('[name="expires_at"]', modal).value;
        const payload = { license_ids: ids };
        if (dt) {
          payload.expires_at = new Date(dt).toISOString();
        } else {
          const days = Number($('[name="days"]', modal).value);
          if (!Number.isFinite(days) || days === 0) {
            toast("请填写调整天数，或选择到期时间", "error");
            return;
          }
          payload.days = days;
        }
        try {
          const res = await apiPost(`/admin/api/customers/${customerId}/adjust-expiry`, payload);
          close();
          toast(`已调整 ${res.updated} 个授权`, "ok");
          navigate("customers", true);
        } catch (err) {
          toast(err.message, "error");
        }
      };
    },
  });
}

async function openCustomerDetail(id) {
  const data = await apiGet(`/admin/api/customers/${id}`);
  const c = data.customer;

  openModal({
    title: `客户：${c.name || c.email || "匿名客户"}`,
    wide: true,
    body: `
      <div class="form-grid">
        <label class="field"><span>登录邮箱（可修改，留空 = 不能登录）</span><input name="email" type="email" value="${esc(c.email ?? "")}" placeholder="buyer@example.com" /></label>
        <label class="field"><span>姓名</span><input name="name" value="${esc(c.name ?? "")}" /></label>
        <label class="field"><span>公司</span><input name="company" value="${esc(c.company ?? "")}" /></label>
        <label class="field"><span>电话</span><input name="phone" value="${esc(c.phone ?? "")}" /></label>
        <label class="field full"><span>备注</span><textarea name="note">${esc(c.note ?? "")}</textarea></label>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary btn-sm" data-save type="button">保存</button>
        <button class="btn btn-sm" data-toggle type="button">${c.status === "active" ? "停用账号" : "启用账号"}</button>
        <button class="btn btn-sm" data-reset type="button">重置登录密码</button>
        ${
          state.admin?.role === "owner"
            ? `<button class="btn btn-sm btn-danger" data-purge type="button" ${
                data.purgeable ? "" : 'disabled title="名下还有未过期或未吊销的授权"'
              }>删除客户</button>`
            : ""
        }
      </div>
      ${
        data.purgeable
          ? ""
          : `<div class="note warn">暂不能删除：${data.purge_blocking
              .map((b) => `${b.license_no}（${b.reason}）`)
              .join("；")}</div>`
      }
      <div class="card">
        <div class="card-head"><h3>该客户的授权</h3><span class="muted small">共 ${data.licenses.length} 个</span></div>
        <div class="card-body tight">
          <div class="table-wrap">
            <table>
              <thead><tr><th>单号</th><th>产品</th><th>状态</th><th>到期</th><th>设备</th></tr></thead>
              <tbody>
                ${
                  data.licenses.length
                    ? data.licenses
                        .map(
                          (l) => `<tr>
                            <td class="mono">${esc(l.license_no)}</td>
                            <td>${esc(l.product_code)}</td>
                            <td>${statusBadge(LICENSE_STATUS, l.eff_status)}</td>
                            <td class="nowrap">${fmtDay(l.expires_at)}</td>
                            <td>${l.devices.filter((d) => d.status === "active").length}/${l.seats}</td>
                          </tr>`,
                        )
                        .join("")
                    : emptyRow(5, "暂无授权")
                }
              </tbody>
            </table>
          </div>
        </div>
      </div>`,
    footer: `<button class="btn" data-close2 type="button">关闭</button>`,
    onMount(modal, close) {
      $("[data-close2]", modal).onclick = () => {
        close();
        navigate("customers", true);
      };
      $("[data-save]", modal).onclick = async () => {
        try {
          await apiPatch(`/admin/api/customers/${id}`, {
            email: $('[name="email"]', modal).value.trim(),
            name: $('[name="name"]', modal).value.trim(),
            company: $('[name="company"]', modal).value.trim(),
            phone: $('[name="phone"]', modal).value.trim(),
            note: $('[name="note"]', modal).value.trim(),
          });
          toast("已保存", "ok");
        } catch (err) {
          toast(err.message, "error");
        }
      };
      const purgeBtn = $("[data-purge]", modal);
      if (purgeBtn) {
        purgeBtn.onclick = async () => {
          const licCount = data.licenses.length;
          const devCount = data.licenses.reduce((n, l) => n + l.devices.length, 0);
          const ok = await confirmDialog(
            `将永久删除该客户，以及名下 ${licCount} 个授权、${devCount} 台设备记录和关联的 CDK；删除后无法恢复，只能从审计日志里查快照。确定继续？`,
            { danger: true, okText: "永久删除" },
          );
          if (!ok) return;
          try {
            const r = await api("DELETE", `/admin/api/customers/${id}`);
            toast(
              `已删除：授权 ${r?.licenses ?? licCount} 个、设备 ${r?.devices ?? devCount} 台`,
              "ok",
            );
            close();
            navigate("customers", true);
          } catch (err) {
            toast(err.message, "error");
          }
        };
      }
      $("[data-toggle]", modal).onclick = async () => {
        try {
          await apiPatch(`/admin/api/customers/${id}`, { status: c.status === "active" ? "disabled" : "active" });
          close();
          toast("已更新", "ok");
          navigate("customers", true);
        } catch (err) {
          toast(err.message, "error");
        }
      };
      $("[data-reset]", modal).onclick = async () => {
        if (!(await confirmDialog("重置该客户的登录密码？旧会话会立即失效。", { okText: "重置" }))) return;
        try {
          const res = await apiPost(`/admin/api/customers/${id}/reset-password`);
          openModal({
            title: "新的临时密码",
            body: `<div class="note warn">只显示一次，请转交客户。</div>
                   <div class="copy-row"><input readonly value="${esc(res.password)}" />
                   <button class="btn btn-sm" data-copy type="button">复制</button></div>`,
            footer: `<button class="btn btn-primary" data-ok type="button">完成</button>`,
            onMount(m, closeInner) {
              $("[data-copy]", m).onclick = () => copyText(res.password);
              $("[data-ok]", m).onclick = closeInner;
            },
          });
        } catch (err) {
          toast(err.message, "error");
        }
      };
    },
  });
}

/* ============================ 审计 ============================ */

const AUDIT_LABEL = {
  "admin.login": "管理员登录",
  "admin.logout": "管理员登出",
  "admin.login_failed": "管理员登录失败",
  "admin.password_change": "修改密码",
  "admin.create": "创建管理员",
  "customer.register": "客户注册",
  "customer.login": "客户登录",
  "customer.login_failed": "客户登录失败",
  "customer.update": "更新客户",
  "customer.reset_password": "重置客户密码",
  "product.create": "创建产品",
  "product.update": "更新产品",
  "product.delete": "删除产品",
  "module.create": "创建模块",
  "module.update": "更新模块",
  "module.delete": "删除模块",
  "cdk.generate": "生成 CDK",
  "cdk.revoke": "作废 CDK",
  "license.activate": "CDK 激活",
  "license.create": "手动开通授权",
  "license.update": "更新授权",
  "license.extend": "续费/调整到期",
  "license.revoke": "吊销授权",
  "license.reset_devices": "重置设备",
  "license.rotate_key": "重置许可证密钥",
  "license.reissue": "重新签发许可证",
  "license.release_device": "解绑设备",
  "license.bind_device": "绑定 / 重绑设备",
  "license.trial_start": "开通试用",
  "customer.create": "新增客户",
  "customer.adjust_expiry": "调整客户到期",
  "trial.config_update": "修改试用配置",
};

async function renderAudit(root) {
  const pageKey = "audit";
  const page = state.pages[pageKey] ?? 1;
  const filters = state.auditFilters ?? (state.auditFilters = { q: "" });
  const query = new URLSearchParams({ page: String(page), page_size: "30" });
  if (filters.q) query.set("q", filters.q);

  const list = await apiGet(`/admin/api/audit?${query}`);

  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>审计日志</h3>
        <div class="toolbar"><input data-f-q placeholder="搜索操作者 / 目标 / 详情" value="${esc(filters.q)}" /></div>
      </div>
      <div class="card-body tight">
        <div class="table-wrap">
          <table>
            <thead><tr><th>时间</th><th>动作</th><th>操作者</th><th>目标</th><th>IP</th><th>详情</th></tr></thead>
            <tbody>
              ${
                list.items.length
                  ? list.items
                      .map(
                        (a) => `<tr>
                          <td class="nowrap">${fmtTime(a.at)}</td>
                          <td>${esc(AUDIT_LABEL[a.action] ?? a.action)}</td>
                          <td>${esc(a.actor_label ?? a.actor_type)}</td>
                          <td class="mono small">${esc(a.target_id ?? "—")}</td>
                          <td class="mono small">${esc(a.ip ?? "—")}</td>
                          <td class="muted small">${esc(a.detail ?? "")}</td>
                        </tr>`,
                      )
                      .join("")
                  : emptyRow(6, "暂无日志")
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>`;

  $("[data-f-q]", root).onkeydown = (e) => {
    if (e.key === "Enter") {
      filters.q = e.target.value.trim();
      state.pages[pageKey] = 1;
      navigate("audit", true);
    }
  };
  $(".card", root).appendChild(pageNav(pageKey, list.total, 30, () => navigate("audit", true)));
}

/* ============================ 设置 ============================ */

/* ============================ API 文档 ============================ */

const METHOD_CLASS = { GET: "badge-info", POST: "badge-ok", PATCH: "badge-warn", DELETE: "badge-danger" };
const AUTH_LABEL = { public: "公开", admin: "管理员", customer: "客户登录" };

/** 描述里的 `xxx` 反引号转成 <code> */
function inlineCode(text) {
  return esc(text).replace(/`([^`]+)`/g, "<code>$1</code>");
}

async function renderApiDocs(root) {
  // 用公开端点：文档本身不敏感，也便于与 /docs 页面共用同一份数据
  const docs = await apiGet("/api/v1/docs");
  const base = location.origin;

  const groupsHtml = docs.groups
    .map(
      (g) => `
      <div class="card">
        <div class="card-head"><h3>${esc(g.name)}</h3><span class="muted small">${g.endpoints.length} 个接口</span></div>
        <div class="card-body tight">
          ${g.endpoints
            .map(
              (e) => `
            <details class="api-item" data-search="${esc(
              `${e.method} ${e.path} ${e.title} ${e.desc ?? ""}`.toLowerCase(),
            )}">
              <summary>
                <span class="badge ${METHOD_CLASS[e.method] || ""}">${esc(e.method)}</span>
                <code class="api-path">${esc(e.path)}</code>
                <span class="api-title">${esc(e.title)}</span>
                <span class="badge ${e.auth === "public" ? "" : e.auth === "admin" ? "badge-warn" : "badge-info"}">${esc(
                  AUTH_LABEL[e.auth] || e.auth,
                )}</span>
              </summary>
              <div class="api-body">
                ${e.desc ? `<p>${inlineCode(e.desc)}</p>` : ""}
                ${e.params ? `<div class="kv"><dt>参数</dt><dd>${inlineCode(e.params)}</dd></div>` : ""}
                ${e.notes ? `<div class="note">${inlineCode(e.notes)}</div>` : ""}
                <div class="copy-row">
                  <input readonly value="curl -X ${esc(e.method)} '${esc(base + e.path)}'" />
                  <button class="btn btn-sm" data-copyurl="${esc(base + e.path)}" type="button">复制 URL</button>
                </div>
              </div>
            </details>`,
            )
            .join("")}
        </div>
      </div>`,
    )
    .join("");

  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>接口总览</h3>
        <div class="toolbar">
          <input data-f-q placeholder="搜索路径 / 方法 / 说明" />
          <span class="muted small" data-count>共 ${docs.total} 个接口</span>
        </div>
      </div>
      <div class="card-body">
        <div class="note">
          <strong>Base URL</strong>：<code>${esc(base)}</code> · 客户端接口前缀 <code>/api/v1</code>，管理接口前缀 <code>/admin/api</code>（除登录外都需要管理员 token）。
          路由清单由服务端真实路由表生成，新增接口会自动出现在这里，不会出现"文档写了但没实现"。
        </div>
        <div class="form-grid" style="margin-top:12px">
          ${docs.conventions
            .map((c) =>
              c.codes?.length
                ? `<div class="field"><span>${esc(c.title)}</span><div class="err-list">${c.codes
                    .map((x) => `<code>${esc(x)}</code>`)
                    .join("")}</div></div>`
                : `<div class="field"><span>${esc(c.title)}</span><div class="muted small">${inlineCode(c.text ?? "")}</div></div>`,
            )
            .join("")}
        </div>
        ${
          docs.missing.length
            ? `<div class="note warn" style="margin-top:12px">以下路由缺少说明（补充到 <code>src/api-spec.ts</code> 即可）：<code>${docs.missing
                .map(esc)
                .join("</code>、<code>")}</code></div>`
            : ""
        }
      </div>
    </div>
    ${groupsHtml || `<div class="card"><div class="card-body muted">没有匹配的接口</div></div>`}`;

  // 搜索：只切换显示，不重绘（避免输入框失焦）
  const searchBox = $("[data-f-q]", root);
  const counter = $("[data-count]", root);
  searchBox.oninput = () => {
    const q = searchBox.value.trim().toLowerCase();
    let shown = 0;
    $$(".api-item", root).forEach((el) => {
      const hit = !q || el.dataset.search.includes(q);
      el.hidden = !hit;
      if (hit) shown += 1;
    });
    $$("#view-root .card", root).forEach((card) => {
      if (!$$(".api-item", card).length) return;
      card.hidden = $$(".api-item:not([hidden])", card).length === 0;
    });
    counter.textContent = q ? `命中 ${shown} / ${docs.total}` : `共 ${docs.total} 个接口`;
  };

  $$("[data-copyurl]", root).forEach((btn) => {
    btn.onclick = () => copyText(btn.dataset.copyurl);
  });
}

/* ============================ 员工 ============================ */

async function renderStaff(root) {
  const [list, opt] = await Promise.all([apiGet("/admin/api/staff?role=staff"), apiGet("/admin/api/staff/options")]);
  const isOwner = state.admin?.role === "owner";
  const rows = list.items;

  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>员工</h3>
        <div class="toolbar">
          <span class="muted small">员工按「目录权限 + 软件功能」受限；代理只能看自己的卡密与余额</span>
          ${isOwner ? '<button class="btn btn-primary btn-sm" data-new type="button">+ 新增账号</button>' : ""}
        </div>
      </div>
      <div class="card-body tight">
        <div class="table-wrap">
          <table>
            <thead><tr><th>账号</th><th>角色</th><th>目录权限</th><th>软件功能</th><th>所属代理</th><th>状态</th><th class="right">操作</th></tr></thead>
            <tbody>
              ${
                rows.length
                  ? rows
                      .map(
                        (s) => `<tr>
                          <td><strong>${esc(s.email)}</strong>${s.name ? `<div class="muted small">${esc(s.name)}</div>` : ""}</td>
                          <td>${
                            s.role === "owner"
                              ? '<span class="badge badge-danger">超级管理员</span>'
                              : s.role === "agent"
                                ? '<span class="badge badge-info">代理</span>'
                                : '<span class="badge">员工</span>'
                          }</td>
                          <td class="small">${s.role === "owner" ? "全部" : `${s.permissions.menus.length} 个页面`}</td>
                          <td class="small">${s.role === "owner" ? "全部" : `${s.permissions.features.length} 项功能`}</td>
                          <td>${esc(s.agent_name ?? "—")}</td>
                          <td>${s.status === "active" ? '<span class="badge badge-ok">正常</span>' : '<span class="badge badge-warn">已停用</span>'}</td>
                          <td class="right">${
                            isOwner && s.role !== "owner"
                              ? `<div class="btn-row" style="justify-content:flex-end">
                                   <button class="btn btn-sm" data-edit="${esc(s.id)}" type="button">编辑</button>
                                   <button class="btn btn-sm" data-del="${esc(s.id)}" type="button">删除</button>
                                 </div>`
                              : ""
                          }</td>
                        </tr>`,
                      )
                      .join("")
                  : emptyRow(7, "还没有员工或代理账号")
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>`;

  const newBtn = $("[data-new]", root);
  if (newBtn) newBtn.onclick = () => staffForm(null, opt);
  $$("[data-edit]", root).forEach((b) => {
    b.onclick = () => staffForm(rows.find((x) => x.id === b.dataset.edit), opt);
  });
  $$("[data-del]", root).forEach((b) => {
    b.onclick = async () => {
      if (!(await confirmDialog("删除该账号？其登录会话会立即失效。", { danger: true, okText: "删除" }))) return;
      try {
        await api("DELETE", `/admin/api/staff/${b.dataset.del}`);
        toast("已删除", "ok");
        navigate("staff", true);
      } catch (err) {
        toast(err.message, "error");
      }
    };
  });
}

async function staffForm(staff, opt) {
  await ensureCatalog().catch(() => {});
  const isNew = !staff;
  const role = staff?.role ?? "staff";
  const checkedMenus = staff?.permissions?.menus ?? ["cdks", "licenses"];
  const checkedFeatures = staff?.permissions?.features ?? [];

  openModal({
    title: isNew ? "新增员工 / 代理" : `编辑：${staff.email}`,
    wide: true,
    body: `
      <div class="form-grid">
        <label class="field"><span>邮箱</span><input name="email" value="${esc(staff?.email ?? "")}" ${isNew ? "" : "disabled"} /></label>
        <label class="field"><span>${isNew ? "初始密码（≥6 位）" : "重置密码（留空不改）"}</span><input name="password" type="password" autocomplete="new-password" /></label>
        <label class="field"><span>名称</span><input name="name" value="${esc(staff?.name ?? "")}" /></label>
        <label class="field"><span>角色</span>
          <select name="role" ${isNew ? "" : "disabled"}>
            <option value="staff" selected>员工（按目录权限 + 软件功能授权访问）</option>
          </select></label>
        <div class="field full"><span></span><div class="muted small">代理商账号请到「代理」页创建与配置（余额、可售范围、单独定价）。</div></div>
        <label class="field" data-agent-wrap><span>所属代理（代理必填，余额随卡密扣减）</span>
          <select name="agent_id"></select></label>
        <div class="field full" data-scope-wrap style="margin-top:6px">
          <span>可售产品（不勾 = 全部产品）</span>
          <div class="checkbox-list" data-agent-products>
            ${state.products.map((p) => `<label><input type="checkbox" value="${esc(p.id)}" ${(staff?.agent_profile?.product_ids ?? []).includes(p.id) ? "checked" : ""} /><span>${esc(p.name)}</span></label>`).join("") || '<span class="empty">还没有产品</span>'}
          </div>
        </div>
        <div class="field full" data-scope-wrap>
          <span>可售卡类型（不勾 = 全部类型）</span>
          <div class="checkbox-list" data-agent-terms>
            ${[["hour", "按小时"], ["day", "按天"], ["month", "按月"], ["year", "按年"], ["count", "按次数"]]
              .map(([v, label]) => `<label><input type="checkbox" value="${v}" ${(staff?.agent_profile?.term_types ?? []).includes(v) ? "checked" : ""} /><span>${label}</span></label>`)
              .join("")}
          </div>
        </div>
      </div>
      <div data-perm-wrap style="margin-top:14px">
        <div class="field"><span>目录权限 —— 能看到哪些页面</span>
          <div class="checkbox-list" data-menus>
            ${opt.menus.map((m) => `<label><input type="checkbox" value="${esc(m.id)}" ${checkedMenus.includes(m.id) ? "checked" : ""} /><span>${esc(m.label)}</span></label>`).join("")}
          </div></div>
        <div class="field" style="margin-top:10px"><span>软件功能授权 —— 能执行哪些操作</span>
          <div class="checkbox-list" data-features>
            ${opt.features.map((f) => `<label><input type="checkbox" value="${esc(f.id)}" ${checkedFeatures.includes(f.id) ? "checked" : ""} /><span>${esc(f.label)}</span></label>`).join("")}
          </div></div>
      </div>`,
    footer: `<button class="btn" data-cancel type="button">取消</button><button class="btn btn-primary" data-save type="button">保存</button>`,
    onMount(modal, close) {
      const chSel = $('[name="agent_id"]', modal);
      chSel.innerHTML =
        '<option value="">未绑定</option>' +
        state.agents
          .map(
            (c) =>
              `<option value="${esc(c.id)}" ${staff?.agent_id === c.id ? "selected" : ""}>${esc(c.name)}（余额 ${money(c.balance ?? 0)}）</option>`,
          )
          .join("");

      const roleSel = $('[name="role"]', modal);
      const syncRole = () => {
        const isAgent = roleSel.value === "agent";
        $$("[data-agent-wrap]", modal).forEach((el) => (el.hidden = !isAgent));
        $$("[data-scope-wrap]", modal).forEach((el) => (el.hidden = !isAgent));
        $("[data-perm-wrap]", modal).hidden = isAgent;
      };
      syncRole();
      roleSel.onchange = syncRole;

      $("[data-cancel]", modal).onclick = close;
      $("[data-save]", modal).onclick = async () => {
        const roleVal = roleSel.value;
        const payload = { name: $('[name="name"]', modal).value.trim(), role: roleVal };
        const pw = $('[name="password"]', modal).value;
        if (pw) payload.password = pw;
        if (roleVal === "agent") {
          payload.agent_id = chSel.value;
          payload.product_ids = $$("[data-agent-products] input:checked", modal).map((i) => i.value);
          payload.term_types = $$("[data-agent-terms] input:checked", modal).map((i) => i.value);
        } else {
          payload.menus = $$("[data-menus] input:checked", modal).map((i) => i.value);
          payload.features = $$("[data-features] input:checked", modal).map((i) => i.value);
        }
        try {
          if (isNew) {
            payload.email = $('[name="email"]', modal).value.trim();
            await apiPost("/admin/api/staff", payload);
          } else {
            await apiPatch(`/admin/api/staff/${staff.id}`, payload);
          }
          close();
          toast("已保存", "ok");
          navigate("staff");
        } catch (err) {
          toast(err.message, "error");
        }
      };
    },
  });
}

/* ============================ 软件参数 ============================ */

async function renderParams(root) {
  // 分开 catch，页面能直接说清是哪个接口挂了（此前只有一个笼统的「加载失败」）
  const [productsRes, pricesRes] = await Promise.all([
    apiGet("/admin/api/products").catch((err) => {
      throw new Error(`产品列表加载失败：${err.message}`);
    }),
    apiGet("/admin/api/prices").catch((err) => {
      throw new Error(`价格列表加载失败：${err.message}`);
    }),
  ]);

  root.innerHTML = `
    <div class="card">
      <div class="card-head"><h3>全局默认卡密价格</h3>
        <span class="muted small">模块留空 = 该产品默认价；单价单位：元 / 单位</span></div>
      <div class="card-body">
        <div class="form-grid">
          <label class="field"><span>产品</span>
            <select name="price_product">${productsRes.items.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}</select></label>
          <label class="field"><span>模块（留空=产品默认价）</span>
            <select name="price_module"><option value="">（产品默认价）</option></select></label>
          <label class="field"><span>卡类型</span>
            <select name="price_term">
              <option value="hour">按小时</option><option value="day">按天</option><option value="month">按月</option>
              <option value="year">按年</option><option value="count">按次数</option>
            </select></label>
          <label class="field"><span>单价（元 / 单位）</span>
            <input name="price_unit" type="number" step="0.01" min="0" value="1" /></label>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary btn-sm" data-save-price type="button">保存价格</button>
          <span class="muted small">代理生成卡密时按「单价 × 时长/次数 × 张数」从账户余额扣费</span>
        </div>
        <div class="table-wrap" style="margin-top:12px">
          <table>
            <thead><tr><th>产品 / 模块</th><th>卡类型</th><th>单价</th><th class="right">操作</th></tr></thead>
            <tbody>
              ${
                pricesRes.items.length
                  ? Object.entries(
                      pricesRes.items.reduce((acc, p) => {
                        (acc[p.product_name] ||= []).push(p);
                        return acc;
                      }, {}),
                    )
                      .map(
                        ([productName, rows]) => `
                        <tr class="group-row"><td colspan="4"><strong>${esc(productName)}</strong>
                          <span class="muted small">共 ${rows.length} 条</span></td></tr>
                        ${rows
                          .map(
                            (p) => `<tr>
                              <td style="padding-left:26px">${p.module_name ? esc(p.module_name) : '<span class="muted small">产品默认价（全部模块）</span>'}</td>
                              <td>${termText(p.term_type)}</td>
                              <td>¥${(p.unit_price / 100).toFixed(2)} / ${termUnit(p.term_type)}</td>
                              <td class="right"><button class="btn btn-sm" data-del-price="${esc(p.id)}" type="button">删除</button></td>
                            </tr>`,
                          )
                          .join("")}`,
                      )
                      .join("")
                  : emptyRow(4, "还没有配置价格——代理将无法生成卡密")
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>`;

  // 选产品后联动加载模块（价格卡片的 select 在上面的 HTML 里，这里统一绑定）

  $("[data-save-price]", root)?.addEventListener("click", async () => {
    const productId = $('[name="price_product"]', root).value;
    const moduleId = $('[name="price_module"]', root).value || null;
    const termType = $('[name="price_term"]', root).value;
    const yuan = Number($('[name="price_unit"]', root).value);
    if (!productId || !Number.isFinite(yuan) || yuan < 0) {
      toast("请选择产品并填写单价", "error");
      return;
    }
    try {
      await apiPost("/admin/api/prices", {
        product_id: productId,
        module_id: moduleId,
        term_type: termType,
        unit_price: Math.round(yuan * 100),
      });
      toast("价格已保存", "ok");
      navigate("params", true);
    } catch (err) {
      toast(err.message, "error");
    }
  });

  const priceProduct = $('[name="price_product"]', root);
  const loadPriceModules = async () => {
    if (!priceProduct || !priceProduct.value) return;
    const mods = await apiGet(`/admin/api/products/${priceProduct.value}/modules`).catch(() => ({ items: [] }));
    $('[name="price_module"]', root).innerHTML =
      '<option value="">（产品默认价 · 全部模块）</option>' +
      mods.items.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join("");
  };
  if (priceProduct) {
    priceProduct.onchange = loadPriceModules;
    // 首次进入即加载当前产品的模块，避免"选不到模块"
    await loadPriceModules();
  }

  $$("[data-del-price]", root).forEach((btn) => {
    btn.onclick = async () => {
      if (!(await confirmDialog("删除该价格？", { danger: true, okText: "删除" }))) return;
      try {
        await api("DELETE", `/admin/api/prices/${btn.dataset.delPrice}`);
        toast("已删除", "ok");
        navigate("params", true);
      } catch (err) {
        toast(err.message, "error");
      }
    };
  });

}

async function renderSettings(root) {
  const [key, me, admins, productsRes] = await Promise.all([
    state.signingKey ? Promise.resolve(state.signingKey) : apiGet("/admin/api/signing-key"),
    apiGet("/admin/api/auth/me"),
    apiGet("/admin/api/admins"),
    apiGet("/admin/api/products"),
  ]);
  state.signingKey = key;
  state.config = me.config;
  const products = productsRes.items;

  root.innerHTML = `
    <div class="card">
      <div class="card-head"><h3>客户端验签公钥</h3>
        <button class="btn btn-sm" data-copy-key type="button">复制公钥</button></div>
      <div class="card-body">
        <div class="note">把这段公钥内置到客户端，即可在完全离线的情况下校验许可证文件。更换密钥会导致所有已签发文件失效。</div>
        <div class="code-block">${esc(key.public_key_pem)}</div>
        <div class="kv" style="margin-top:12px">
          <dt>密钥 ID</dt><dd class="mono">${esc(key.kid)}</dd>
          <dt>算法</dt><dd>${esc(key.algorithm)}</dd>
          <dt>Base64 (SPKI)</dt><dd class="mono small">${esc(key.public_key_b64)}</dd>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>策略参数</h3><span class="muted small">修改需改环境变量并重启服务</span></div>
      <div class="card-body">
        <div class="kv">
          <dt>心跳周期</dt><dd>${state.config.heartbeat_interval_hours} 小时（建议值，客户端按此频率续期）</dd>
          <dt>离线宽限</dt><dd>${state.config.offline_grace_days} 天（许可证文件离线可用上限）</dd>
          <dt>心跳异常阈值</dt><dd>${state.config.heartbeat_stale_hours} 小时未心跳视为异常</dd>
        </div>
      </div>
    </div>


    <div class="card">
      <div class="card-head"><h3>管理员</h3>
        <button class="btn btn-sm" data-add-admin type="button">+ 新增管理员</button></div>
      <div class="card-body tight">
        <div class="table-wrap">
          <table>
            <thead><tr><th>邮箱</th><th>名称</th><th>角色</th><th>最近登录</th></tr></thead>
            <tbody>
              ${admins.items
                .map(
                  (a) => `<tr>
                    <td>${esc(a.email)}</td>
                    <td>${esc(a.name ?? "—")}</td>
                    <td><span class="badge">${esc(a.role)}</span></td>
                    <td class="nowrap">${fmtTime(a.last_login_at)}</td>
                  </tr>`,
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h3>修改我的密码</h3></div>
      <div class="card-body">
        <div class="form-grid">
          <label class="field"><span>当前密码</span><input name="current" type="password" autocomplete="current-password" /></label>
          <label class="field"><span>新密码（至少 6 位）</span><input name="next" type="password" autocomplete="new-password" /></label>
        </div>
        <div class="form-actions"><button class="btn btn-primary btn-sm" data-change-pw type="button">修改密码</button></div>
      </div>
    </div>`;

  $("[data-copy-key]", root).onclick = () => copyText(key.public_key_pem);


  $("[data-add-admin]", root).onclick = () => {
    openModal({
      title: "新增管理员",
      body: `<div class="form-grid">
               <label class="field"><span>邮箱</span><input name="email" type="email" /></label>
               <label class="field"><span>名称</span><input name="name" /></label>
               <label class="field full"><span>初始密码（至少 10 位）</span><input name="password" type="password" /></label>
             </div>`,
      footer: `<button class="btn" data-c type="button">取消</button><button class="btn btn-primary" data-ok type="button">创建</button>`,
      onMount(modal, close) {
        $("[data-c]", modal).onclick = close;
        $("[data-ok]", modal).onclick = async () => {
          try {
            await apiPost("/admin/api/admins", {
              email: $('[name="email"]', modal).value.trim(),
              name: $('[name="name"]', modal).value.trim(),
              password: $('[name="password"]', modal).value,
            });
            close();
            toast("已创建", "ok");
            navigate("settings", true);
          } catch (err) {
            toast(err.message, "error");
          }
        };
      },
    });
  };

  $("[data-change-pw]", root).onclick = async () => {
    try {
      await apiPost("/admin/api/auth/password", {
        current_password: $('[name="current"]', root).value,
        new_password: $('[name="next"]', root).value,
      });
      toast("密码已修改，请重新登录", "ok");
      setTimeout(() => endSession(), 1200);
    } catch (err) {
      toast(err.message, "error");
    }
  };
}

/* ============================ 启动 ============================ */

function bindLogin() {
  $("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = $("#login-email").value.trim();
    const password = $("#login-password").value;
    const errorBox = $("#login-error");
    errorBox.hidden = true;
    try {
      const res = await apiPost("/admin/api/auth/login", { email, password });
      startSession(res.token, res.admin);
      state.token = res.token;
      const me = await apiGet("/admin/api/auth/me");
      state.signingKey = me.signing_key;
      state.config = me.config;
      await navigate("overview");
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    }
  });
}

function bindChrome() {
  $$("#nav .nav-item, .sidebar-foot .nav-item").forEach((btn) => {
    btn.addEventListener("click", () => navigate(btn.dataset.view));
  });
  $("#logout-btn").addEventListener("click", async () => {
    try {
      await apiPost("/admin/api/auth/logout");
    } catch {
      /* 忽略 */
    }
    endSession();
  });

  // 手机端抽屉
  $("#nav-toggle")?.addEventListener("click", () => document.body.classList.toggle("drawer-open"));
  $("#drawer-mask")?.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDrawer();
  });
}

/** 登录页的小交互：记住邮箱、密码显示切换 */
function bindLoginExtras() {
  const emailInput = $("#login-email");
  const remember = $("#login-remember");
  const toggle = $("[data-pwd-toggle]");
  const pwd = $("#login-password");

  const saved = localStorage.getItem("lic_admin_email");
  if (saved) emailInput.value = saved;

  toggle?.addEventListener("click", () => {
    const show = pwd.type === "password";
    pwd.type = show ? "text" : "password";
    toggle.textContent = show ? "隐藏" : "显示";
    pwd.focus();
  });

  // 捕获阶段先跑，赶在提交请求之前记下邮箱
  $("#login-form").addEventListener(
    "submit",
    () => {
      const email = emailInput.value.trim();
      if (remember?.checked && email) localStorage.setItem("lic_admin_email", email);
      else localStorage.removeItem("lic_admin_email");
    },
    true,
  );
}

bindLogin();
bindLoginExtras();
bindChrome();
void bootstrapSession();
