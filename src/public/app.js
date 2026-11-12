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
  channels: [],
  pages: {},
};

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
  localStorage.setItem("lic_admin_token", token);
  $("#login-view").hidden = true;
  $("#app-view").hidden = false;
  $("#admin-label").textContent = admin?.email ?? "";
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

/* ============================ 导航 ============================ */

const VIEWS = {
  overview: { title: "概览", subtitle: "授权与 CDK 全局概况", render: renderOverview },
  products: { title: "产品与模块", subtitle: "产品、功能模块维护（CDK 绑定目标）", render: renderProducts },
  cdks: { title: "CDK", subtitle: "批量生成、导出与作废", render: renderCdks },
  channels: { title: "渠道", subtitle: "分销渠道、CDK 归属与营收统计", render: renderChannels },
  licenses: { title: "授权", subtitle: "到期时间、席位、设备与吊销", render: renderLicenses },
  customers: { title: "客户", subtitle: "注册客户与账号状态", render: renderCustomers },
  audit: { title: "审计日志", subtitle: "所有关键操作留痕", render: renderAudit },
  apiDocs: { title: "API 文档", subtitle: "全部接口说明 · 由真实路由表自动生成，不会与实现脱节", render: renderApiDocs },
  settings: { title: "设置与公钥", subtitle: "签名公钥、策略参数、管理员", render: renderSettings },
};

async function navigate(name, keepPage = false) {
  const view = VIEWS[name];
  if (!view) return;
  state.view = name;
  if (!keepPage) state.pages[name] = 1;
  $$("#nav .nav-item, .sidebar-foot .nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === name);
  });
  $("#page-title").textContent = view.title;
  $("#page-subtitle").textContent = view.subtitle;
  const root = $("#view-root");
  root.innerHTML = `<div class="card"><div class="card-body muted">加载中…</div></div>`;
  try {
    await view.render(root);
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
    apiGet("/admin/api/channels"),
  ]);
  state.modules = mods.items;
  state.channels = chans.items;
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
      <div class="stat warn"><div class="stat-label">7 天内到期</div><div class="stat-value">${s.licenses_expiring_7d}</div>
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
                          <td>${esc(l.customer_email ?? l.customer_name ?? "—")}</td>
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
                          <td>${esc(l.customer_email ?? l.customer_name ?? "—")}</td>
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

async function moduleManager(productId) {
  const product = state.products.find((p) => p.id === productId);
  const res = await apiGet(`/admin/api/products/${productId}/modules`);
  const rows = res.items;

  const render = (modal) => {
    $(".modal-body", modal).innerHTML = `
      <div class="note">模块是 CDK 与授权的授权范围单位，客户端通过模块编码判断功能是否可用。</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>模块名称</th><th>编码</th><th>状态</th><th class="right">操作</th></tr></thead>
          <tbody>
            ${
              rows.length
                ? rows
                    .map(
                      (m) => `<tr>
                        <td>${esc(m.name)}</td>
                        <td class="mono">${esc(m.code)}</td>
                        <td>${m.status === "active" ? '<span class="badge badge-ok">启用</span>' : '<span class="badge">停用</span>'}</td>
                        <td class="right"><button class="btn btn-sm" data-rm="${esc(m.id)}" type="button">删除</button></td>
                      </tr>`,
                    )
                    .join("")
                : emptyRow(4, "还没有模块")
            }
          </tbody>
        </table>
      </div>
      <div class="form-grid">
        <label class="field"><span>模块编码</span><input name="code" placeholder="report" /></label>
        <label class="field"><span>模块名称</span><input name="name" placeholder="报表模块" /></label>
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

    $("[data-add]", modal).onclick = async () => {
      const code = $('[name="code"]', modal).value.trim();
      const name = $('[name="name"]', modal).value.trim();
      if (!code || !name) {
        toast("请填写模块编码与名称", "error");
        return;
      }
      try {
        await apiPost(`/admin/api/products/${productId}/modules`, { code, name });
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

/* ============================ 渠道 / 分销 ============================ */

const money = (cents) => `¥${(Number(cents ?? 0) / 100).toFixed(2)}`;
const percent = (ratio) => `${(Number(ratio ?? 0) * 100).toFixed(1)}%`;

function channelOptions(selected = "") {
  const parts = [`<option value="">无（直销）</option>`];
  for (const c of state.channels) {
    if (c.status !== "active" && c.id !== selected) continue;
    parts.push(
      `<option value="${esc(c.id)}" ${c.id === selected ? "selected" : ""}>${esc(c.name)}（${esc(c.code)}）</option>`,
    );
  }
  return parts.join("");
}

async function renderChannels(root) {
  await ensureCatalog();
  const filters = state.channelFilters ?? (state.channelFilters = { q: "", status: "" });
  const query = new URLSearchParams();
  if (filters.q) query.set("q", filters.q);
  if (filters.status) query.set("status", filters.status);

  const res = await apiGet(`/admin/api/channels?${query}`);
  const items = res.items;
  const s = res.summary;

  root.innerHTML = `
    <div class="stat-grid">
      <div class="stat accent">
        <div class="stat-label">渠道数</div>
        <div class="stat-value">${s.channels}</div>
        <div class="stat-hint">启用中 ${s.channels_active} 个</div>
      </div>
      <div class="stat">
        <div class="stat-label">归属渠道的授权</div>
        <div class="stat-value">${s.attributed_licenses}</div>
        <div class="stat-hint">直销（无渠道）${s.unattributed_licenses} 个</div>
      </div>
      <div class="stat">
        <div class="stat-label">累计营收</div>
        <div class="stat-value">${money(s.revenue_total)}</div>
        <div class="stat-hint">近 30 天 ${money(s.revenue_30d)}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>渠道列表</h3>
        <div class="toolbar">
          <select data-f-status>
            <option value="">全部状态</option>
            <option value="active" ${filters.status === "active" ? "selected" : ""}>启用</option>
            <option value="disabled" ${filters.status === "disabled" ? "selected" : ""}>停用</option>
          </select>
          <input data-f-q placeholder="搜索渠道编码 / 名称 / 联系人" value="${esc(filters.q)}" />
          <button class="btn btn-primary btn-sm" data-new type="button">+ 新建渠道</button>
        </div>
      </div>
      <div class="card-body tight">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>渠道</th><th>联系人</th><th>CDK（已核销/总量）</th><th>激活率</th>
                <th>授权</th><th>营收</th><th>最近激活</th><th>状态</th><th class="right">操作</th>
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
                          <td>${money(c.revenue_total)}<div class="muted small">近 30 天 ${money(c.revenue_30d)}</div></td>
                          <td class="nowrap">${c.last_activated_at ? fmtDay(c.last_activated_at) : "—"}</td>
                          <td>${c.status === "active" ? '<span class="badge badge-ok">启用</span>' : '<span class="badge">停用</span>'}</td>
                          <td class="right">
                            <div class="btn-row" style="justify-content:flex-end">
                              <button class="btn btn-sm" data-edit="${esc(c.id)}" type="button">编辑</button>
                              <button class="btn btn-sm" data-toggle="${esc(c.id)}" type="button">${c.status === "active" ? "停用" : "启用"}</button>
                              <button class="btn btn-sm" data-del="${esc(c.id)}" type="button">删除</button>
                            </div>
                          </td>
                        </tr>`,
                      )
                      .join("")
                  : emptyRow(9, "还没有渠道。渠道用于区分分销来源，并统计各渠道的 CDK 与营收")
              }
            </tbody>
          </table>
        </div>
      </div>
    </div>`;

  $("[data-new]", root).onclick = () => channelForm();
  $("[data-f-status]", root).onchange = (e) => {
    filters.status = e.target.value;
    navigate("channels", true);
  };
  $("[data-f-q]", root).onkeydown = (e) => {
    if (e.key === "Enter") {
      filters.q = e.target.value.trim();
      navigate("channels", true);
    }
  };
  $$("[data-edit]", root).forEach((btn) => {
    btn.onclick = () => channelForm(state.channels.find((c) => c.id === btn.dataset.edit));
  });
  $$("[data-toggle]", root).forEach((btn) => {
    btn.onclick = async () => {
      const c = state.channels.find((x) => x.id === btn.dataset.toggle);
      try {
        await apiPatch(`/admin/api/channels/${c.id}`, {
          status: c.status === "active" ? "disabled" : "active",
        });
        toast("已更新", "ok");
        navigate("channels", true);
      } catch (err) {
        toast(err.message, "error");
      }
    };
  });
  $$("[data-del]", root).forEach((btn) => {
    btn.onclick = async () => {
      const c = state.channels.find((x) => x.id === btn.dataset.del);
      if (!(await confirmDialog(`删除渠道「${c.name}」？已有 CDK 或授权的渠道不能删除，只能停用。`, { danger: true, okText: "删除" }))) return;
      try {
        await api("DELETE", `/admin/api/channels/${c.id}`);
        toast("已删除", "ok");
        navigate("channels", true);
      } catch (err) {
        toast(err.message, "error");
      }
    };
  });
}

function channelForm(channel) {
  const isNew = !channel;
  openModal({
    title: isNew ? "新建渠道" : `编辑渠道：${channel.name}`,
    body: `
      <div class="form-grid">
        <label class="field"><span>渠道编码（小写字母 / 数字 / - / _）</span>
          <input name="code" value="${esc(channel?.code ?? "")}" ${isNew ? "" : "disabled"} placeholder="taobao" /></label>
        <label class="field"><span>渠道名称</span><input name="name" value="${esc(channel?.name ?? "")}" placeholder="淘宝旗舰店" /></label>
        <label class="field"><span>联系人</span><input name="contact" value="${esc(channel?.contact ?? "")}" /></label>
        <label class="field"><span>电话</span><input name="phone" value="${esc(channel?.phone ?? "")}" /></label>
        <label class="field"><span>邮箱</span><input name="email" value="${esc(channel?.email ?? "")}" /></label>
        <label class="field full"><span>备注</span><textarea name="note">${esc(channel?.note ?? "")}</textarea></label>
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
          toast("请填写渠道名称", "error");
          return;
        }
        try {
          if (isNew) {
            const code = $('[name="code"]', modal).value.trim();
            if (!code) {
              toast("请填写渠道编码", "error");
              return;
            }
            await apiPost("/admin/api/channels", { ...payload, code });
          } else {
            await apiPatch(`/admin/api/channels/${channel.id}`, payload);
          }
          close();
          toast("已保存", "ok");
          navigate("channels");
        } catch (err) {
          toast(err.message, "error");
        }
      };
    },
  });
}

/* ============================ CDK ============================ */

async function renderCdks(root) {
  await ensureCatalog();
  const pageKey = "cdks";
  const page = state.pages[pageKey] ?? 1;
  const filters = state.cdkFilters ?? (state.cdkFilters = { product_id: "", status: "", q: "", batch_id: "", channel_id: "" });
  const query = new URLSearchParams({ page: String(page), page_size: "20" });
  if (filters.product_id) query.set("product_id", filters.product_id);
  if (filters.status) query.set("status", filters.status);
  if (filters.q) query.set("q", filters.q);
  if (filters.batch_id) query.set("batch_id", filters.batch_id);
  if (filters.channel_id) query.set("channel_id", filters.channel_id);

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
          <label class="field"><span>授权时长（天）</span><input name="days" type="number" min="1" max="3650" value="365" /></label>
          <label class="field"><span>席位数（可绑定设备数）</span><input name="seats" type="number" min="1" max="100" value="1" /></label>
          <label class="field"><span>生成数量</span><input name="count" type="number" min="1" max="5000" value="10" /></label>
          <label class="field"><span>兑换截止时间（可选）</span><input name="redeem_before" type="datetime-local" /></label>
          <label class="field"><span>归属渠道（可选）</span><select name="channel_id">${channelOptions()}</select></label>
          <label class="field"><span>结算单价（元）</span><input name="unit_price" type="number" min="0" step="0.01" value="0" /></label>
          <label class="field"><span>批次备注</span><input name="note" placeholder="例如 2025Q1 渠道批次" /></label>
          <div class="field full"><span>包含模块</span>
            <div class="checkbox-list" data-modules>${moduleCheckboxes(state.products[0]?.id ?? "")}</div>
          </div>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" data-generate type="button">生成并导出</button>
          <span class="muted small">CDK 数量较多时会自动以 CSV 提供下载</span>
        </div>
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
          <select data-f-channel>
            <option value="">全部渠道</option>
            <option value="__none__" ${filters.channel_id === "__none__" ? "selected" : ""}>无渠道（直销）</option>
            ${state.channels.map((c) => `<option value="${esc(c.id)}" ${filters.channel_id === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}
          </select>
          <input data-f-q placeholder="搜索 CDK / 备注 / 客户邮箱" value="${esc(filters.q)}" />
          <button class="btn btn-sm" data-export type="button">导出 CSV</button>
        </div>
      </div>
      <div class="card-body tight">
        <div class="table-wrap">
          <table>
            <thead><tr><th>CDK</th><th>产品</th><th>渠道</th><th>时长</th><th>席位</th><th>状态</th><th>绑定客户</th><th>到期时间</th><th>生成时间</th><th class="right">操作</th></tr></thead>
            <tbody>
              ${
                list.items.length
                  ? list.items
                      .map(
                        (c) => `<tr>
                          <td class="mono"><button class="btn btn-ghost btn-sm" data-copy="${esc(c.code)}" type="button" title="点击复制">${esc(c.code)}</button></td>
                          <td>${esc(c.product_code)}</td>
                          <td>${c.channel_code ? `<span class="badge badge-info">${esc(c.channel_name ?? c.channel_code)}</span>` : '<span class="muted small">直销</span>'}</td>
                          <td>${c.days} 天</td>
                          <td>${c.seats}</td>
                          <td>${statusBadge(CDK_STATUS, c.status)}</td>
                          <td>${esc(c.customer_email ?? "—")}</td>
                          <td class="nowrap">${c.license_expires_at ? `${fmtDay(c.license_expires_at)}<div class="muted small">${relDays(c.license_expires_at)}</div>` : '<span class="muted small">未激活</span>'}</td>
                          <td class="nowrap">${fmtTime(c.created_at)}</td>
                          <td class="right">${c.status === "unused" ? `<button class="btn btn-sm" data-revoke="${esc(c.id)}" type="button">作废</button>` : ""}</td>
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

  $("[data-generate]", root).onclick = async () => {
    const moduleIds = $$("[data-modules] input:checked", root).map((i) => i.value);
    const channelSelect = $('[name="channel_id"]', root);
    const payload = {
      product_id: productSelect.value,
      module_ids: moduleIds,
      days: Number($('[name="days"]', root).value),
      seats: Number($('[name="seats"]', root).value),
      count: Number($('[name="count"]', root).value),
      note: $('[name="note"]', root).value.trim(),
      // 渠道可选；单价按「元」录入，提交时换算成「分」
      channel_id: channelSelect?.value || undefined,
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
  $("[data-f-channel]", root).onchange = (e) => {
    filters.channel_id = e.target.value;
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
          <input data-f-q placeholder="搜索单号 / 客户邮箱" value="${esc(filters.q)}" />
          <button class="btn btn-primary btn-sm" data-new type="button">+ 手动开通</button>
        </div>
      </div>
      <div class="card-body tight">
        <div class="table-wrap">
          <table>
            <thead><tr><th>授权单号</th><th>客户</th><th>产品</th><th>状态</th><th>到期时间</th><th>剩余</th><th>设备</th><th class="right">操作</th></tr></thead>
            <tbody>
              ${
                list.items.length
                  ? list.items
                      .map(
                        (l) => `<tr>
                          <td class="mono">${esc(l.license_no)}</td>
                          <td>${esc(l.customer_email ?? l.customer_name ?? "—")}</td>
                          <td>${esc(l.product_code)}</td>
                          <td>${statusBadge(LICENSE_STATUS, l.eff_status)}</td>
                          <td class="nowrap">${fmtDay(l.expires_at)}</td>
                          <td class="nowrap">${relDays(l.expires_at)}</td>
                          <td>${l.active_devices}/${l.seats}</td>
                          <td class="right"><button class="btn btn-sm" data-license="${esc(l.id)}" type="button">管理</button></td>
                        </tr>`,
                      )
                      .join("")
                  : emptyRow(8, "没有符合条件的授权")
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
      <dt>客户</dt><dd>${esc(data.customer?.email ?? data.customer?.name ?? "—")}</dd>
      <dt>产品</dt><dd>${esc(l.product_name)} <span class="muted mono">${esc(l.product_code)}</span></dd>
      <dt>模块</dt><dd>${data.module_codes.map((c) => `<code>${esc(c)}</code>`).join(" ") || "（无）"}</dd>
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
          <label class="field"><span>离线宽限（天）</span><input name="grace" type="number" min="0" max="365" value="${l.offline_grace_days}" /></label>
          <label class="field"><span>备注</span><input name="note" value="${esc(l.note ?? "")}" /></label>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary btn-sm" data-save type="button">保存调整</button>
          <button class="btn btn-sm" data-extend-30 type="button">+30 天</button>
          <button class="btn btn-sm" data-extend-90 type="button">+90 天</button>
          <button class="btn btn-sm" data-extend-365 type="button">+365 天</button>
          <button class="btn btn-sm" data-extend-custom type="button">自定义延长…</button>
        </div>
        <div class="form-actions">
          <button class="btn btn-sm" data-suspend type="button">${l.status === "suspended" ? "恢复授权" : "暂停授权"}</button>
          <button class="btn btn-sm" data-bind-device type="button">绑定新设备</button>
          <button class="btn btn-sm" data-reset-devices type="button">重置全部设备</button>
          <button class="btn btn-sm" data-rotate type="button">重置许可证密钥</button>
          <button class="btn btn-sm" data-reissue type="button">重新签发许可证文件</button>
          <button class="btn btn-sm btn-danger" data-revoke type="button">吊销授权</button>
        </div>
      </div>
    </div>`;

  openModal({
    title: `授权管理：${l.license_no}`,
    wide: true,
    body,
    footer: `<button class="btn" data-close2 type="button">关闭</button>`,
    onMount(modal, close) {
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

      $("[data-revoke]", modal).onclick = async () => {
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
          <input data-f-q placeholder="搜索邮箱 / 姓名 / 公司 / 电话" value="${esc(filters.q)}" />
          <button class="btn btn-primary btn-sm" data-new-customer type="button">+ 新增客户</button>
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
                            <strong>${esc(c.email ?? c.name ?? "匿名客户")}</strong>
                            ${c.company ? `<div class="muted small">${esc(c.company)}</div>` : ""}
                            ${!c.email ? '<div class="muted small">无登录账号（CDK 匿名激活）</div>' : ""}
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
        <label class="field"><span>登录密码（≥8 位，留空 = 不能登录）</span><input name="password" type="password" autocomplete="new-password" /></label>
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
      <div class="note">该客户有 ${licenses.length} 个授权。调整后客户端下次心跳即可拿到新到期时间（心跳周期 ${state.config?.heartbeat_interval_hours ?? 24} 小时）。</div>
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
    title: `客户：${c.email ?? c.name ?? "匿名客户"}`,
    wide: true,
    body: `
      <div class="form-grid">
        <label class="field"><span>邮箱</span><input value="${esc(c.email ?? "（无）")}" disabled /></label>
        <label class="field"><span>姓名</span><input name="name" value="${esc(c.name ?? "")}" /></label>
        <label class="field"><span>公司</span><input name="company" value="${esc(c.company ?? "")}" /></label>
        <label class="field"><span>电话</span><input name="phone" value="${esc(c.phone ?? "")}" /></label>
        <label class="field full"><span>备注</span><textarea name="note">${esc(c.note ?? "")}</textarea></label>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary btn-sm" data-save type="button">保存</button>
        <button class="btn btn-sm" data-toggle type="button">${c.status === "active" ? "停用账号" : "启用账号"}</button>
        <button class="btn btn-sm" data-reset type="button">重置登录密码</button>
      </div>
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
            .map(
              (c) => `<div class="field"><span>${esc(c.title)}</span><div class="muted small">${inlineCode(c.text)}</div></div>`,
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

async function renderSettings(root) {
  const [key, me, admins, trial, productsRes] = await Promise.all([
    state.signingKey ? Promise.resolve(state.signingKey) : apiGet("/admin/api/signing-key"),
    apiGet("/admin/api/auth/me"),
    apiGet("/admin/api/admins"),
    apiGet("/admin/api/settings/trial"),
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
      <div class="card-head"><h3>试用配置</h3>
        <span class="muted small">试用授权 ${trial.summary.total} 个 · 有效 ${trial.summary.active} 个 · 试用后转正式 ${trial.summary.converted} 个客户</span></div>
      <div class="card-body">
        <div class="form-grid">
          <label class="field"><span>允许客户自助试用</span>
            <select name="trial_enabled">
              <option value="1" ${trial.config.enabled ? "selected" : ""}>开启</option>
              <option value="0" ${!trial.config.enabled ? "selected" : ""}>关闭</option>
            </select></label>
          <label class="field"><span>试用天数</span><input name="trial_days" type="number" min="1" max="365" value="${trial.config.days}" /></label>
          <label class="field"><span>试用席位数</span><input name="trial_seats" type="number" min="1" max="100" value="${trial.config.seats}" /></label>
          <label class="field"><span>每客户可试用次数</span><input name="trial_max" type="number" min="1" max="20" value="${trial.config.max_per_customer}" /></label>
          <label class="field"><span>限定产品（留空 = 任意在售产品）</span>
            <select name="trial_product">
              <option value="">不限定</option>
              ${products.map((p) => `<option value="${esc(p.id)}" ${trial.config.product_id === p.id ? "selected" : ""}>${esc(p.name)}（${esc(p.code)}）</option>`).join("")}
            </select></label>
          <label class="field"><span>离线宽限（天，留空 = 用全局）</span><input name="trial_grace" type="number" min="0" max="365" value="${trial.config.offline_grace_days ?? ""}" /></label>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary btn-sm" data-save-trial type="button">保存试用配置</button>
          <span class="muted small">客户在客户端登录后即可自助开通试用；试用授权同样能在「授权」页延长 / 吊销</span>
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
          <label class="field"><span>新密码（至少 8 位）</span><input name="next" type="password" autocomplete="new-password" /></label>
        </div>
        <div class="form-actions"><button class="btn btn-primary btn-sm" data-change-pw type="button">修改密码</button></div>
      </div>
    </div>`;

  $("[data-copy-key]", root).onclick = () => copyText(key.public_key_pem);

  $("[data-save-trial]", root).onclick = async () => {
    const graceRaw = $('[name="trial_grace"]', root).value.trim();
    const payload = {
      enabled: $('[name="trial_enabled"]', root).value === "1",
      days: Number($('[name="trial_days"]', root).value),
      seats: Number($('[name="trial_seats"]', root).value),
      max_per_customer: Number($('[name="trial_max"]', root).value),
      product_id: $('[name="trial_product"]', root).value || null,
      offline_grace_days: graceRaw === "" ? null : Number(graceRaw),
    };
    try {
      await apiPatch("/admin/api/settings/trial", payload);
      toast("试用配置已保存", "ok");
      navigate("settings", true);
    } catch (err) {
      toast(err.message, "error");
    }
  };

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
}

bindLogin();
bindChrome();
void bootstrapSession();
