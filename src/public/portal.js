/**
 * 客户门户（授权中心）
 * 无构建、无依赖；只调这几个接口：
 *   POST /api/v1/auth/register | /login | /logout
 *   GET  /api/v1/me/overview      （账号 + 授权 + 模块 + 设备）
 *   POST /api/v1/cdks/inspect     （公开：查卡）
 *   POST /api/v1/licenses/activate（bind_device=false：只绑账号，不占席位）
 */

const TOKEN_KEY = "lic_portal_token";
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  customer: null,
  overview: null,
  tab: "licenses",
  inspect: null,
};

/* ============================ 工具 ============================ */

function toast(message, type = "") {
  const root = $("#toast-root");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function fmtDay(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const STATUS = {
  active: ["正常", "badge-ok"],
  expired: ["已到期", "badge-warn"],
  revoked: ["已吊销", "badge-danger"],
  suspended: ["已暂停", "badge-warn"],
  pending: ["未生效", "badge-info"],
};

function statusBadge(s) {
  const [label, cls] = STATUS[s] ?? [s || "未知", ""];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

function initials(name, email) {
  const src = (name || email || "?").trim();
  return esc(src.slice(0, 1).toUpperCase());
}

/* ============================ 请求 ============================ */

function clearSession() {
  state.token = "";
  state.customer = null;
  state.overview = null;
  localStorage.removeItem(TOKEN_KEY);
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

  // 只有「会话失效」才自动登出；登录/改密时密码错也是 401，不能把用户踢出去
  if (res.status === 401 && state.token && payload?.error?.code !== "INVALID_CREDENTIALS") {
    clearSession();
    renderAuth();
    throw new Error(payload?.error?.message || "登录已过期，请重新登录");
  }
  if (!res.ok || payload?.ok === false) {
    const err = new Error(payload?.error?.message || `请求失败（${res.status}）`);
    err.code = payload?.error?.code;
    err.status = res.status;
    throw err;
  }
  return payload?.data;
}

/* ============================ 登录 / 注册 ============================ */

function renderAuth() {
  $("#view-auth").hidden = false;
  $("#view-app").hidden = true;
  $("#header-right").innerHTML = "";
}

function setAuthTab(tab) {
  $$("[data-auth-tab]").forEach((b) => b.classList.toggle("active", b.dataset.authTab === tab));
  $("#form-login").hidden = tab !== "login";
  $("#form-register").hidden = tab !== "register";
  $("#login-error").hidden = true;
  $("#reg-error").hidden = true;
}

function showFormError(id, message) {
  const el = $(id);
  el.textContent = message;
  el.hidden = false;
}

function bindAuth() {
  $$("[data-auth-tab]").forEach((btn) => {
    btn.addEventListener("click", () => setAuthTab(btn.dataset.authTab));
  });

  // 未登录也能查卡
  $("#guest-inspect")?.addEventListener("click", doGuestInspect);
  $("#guest-cdk")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") doGuestInspect();
  });

  $("#form-login").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("#login-error").hidden = true;
    const email = $("#login-email").value.trim();
    const password = $("#login-password").value;
    try {
      const data = await api("POST", "/api/v1/auth/login", { email, password });
      state.token = data.session.token;
      localStorage.setItem(TOKEN_KEY, state.token);
      await enterApp();
    } catch (err) {
      showFormError("#login-error", err.message);
    }
  });

  $("#form-register").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("#reg-error").hidden = true;
    const email = $("#reg-email").value.trim();
    const password = $("#reg-password").value;
    const name = $("#reg-name").value.trim();
    try {
      const data = await api("POST", "/api/v1/auth/register", { email, password, ...(name ? { name } : {}) });
      state.token = data.session.token;
      localStorage.setItem(TOKEN_KEY, state.token);
      toast("注册成功，已为你登录", "ok");
      await enterApp(); // 注册后直接进授权信息
    } catch (err) {
      showFormError("#reg-error", err.message);
    }
  });
}

/* ============================ 主界面 ============================ */

async function enterApp() {
  const data = await api("GET", "/api/v1/me/overview");
  state.customer = data.customer;
  state.overview = data;
  renderApp();
}

function renderApp() {
  $("#view-auth").hidden = true;
  $("#view-app").hidden = false;

  const c = state.customer ?? {};
  const who = c.name || c.email || "客户";
  $("#header-right").innerHTML = `
    <span class="user-chip" title="${esc(c.email ?? "")}">
      <span class="avatar">${initials(c.name, c.email)}</span>
      <span class="name">${esc(who)}</span>
    </span>
    <button class="btn btn-ghost btn-sm" id="logout" type="button">退出</button>`;
  $("#logout").onclick = async () => {
    try {
      await api("POST", "/api/v1/auth/logout");
    } catch {
      /* 退出失败也照样清本地 */
    }
    clearSession();
    renderAuth();
    toast("已退出");
  };

  switchTab(state.tab);
}

function switchTab(tab) {
  state.tab = tab;
  $$("[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("#pane-licenses").hidden = tab !== "licenses";
  $("#pane-activate").hidden = tab !== "activate";
  if (tab === "licenses") renderLicenses();
  else renderActivate();
}

function bindTabs() {
  $$("[data-tab]").forEach((btn) => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));
}

/* ============================ 授权信息 ============================ */

function renderLicenses() {
  const pane = $("#pane-licenses");
  const data = state.overview;
  if (!data) return;

  const c = data.customer ?? {};
  const sum = data.summary ?? {};
  const account = `
    <section class="acct-card">
      <div class="acct-avatar">${initials(c.name, c.email)}</div>
      <div class="acct-info">
        <strong>${esc(c.name || c.email || "客户")}</strong>
        <span>${esc(c.email ?? "")}</span>
        <span class="muted small">注册于 ${fmtDay(c.created_at)}</span>
      </div>
      <div class="acct-stats">
        <div class="acct-stat"><b>${sum.licenses ?? 0}</b><span>授权</span></div>
        <div class="acct-stat"><b>${sum.active_modules ?? 0}</b><span>可用模块</span></div>
        <div class="acct-stat"><b>${sum.expiring_7d ?? 0}</b><span>7 天内到期</span></div>
      </div>
      <button class="btn btn-sm acct-pw" id="btn-password" type="button">修改密码</button>
    </section>`;

  if (!data.licenses.length) {
    pane.innerHTML =
      account +
      `<section class="empty">
         <div class="big">🎟️</div>
         <h3>还没有授权</h3>
         <p class="muted small">拿到激活码后，到「激活新卡」里输入就能开通</p>
         <p style="margin-top:14px"><button class="btn btn-primary" id="go-activate" type="button">去激活</button></p>
       </section>`;
    $("#go-activate").onclick = () => switchTab("activate");
    $("#btn-password")?.addEventListener("click", openPasswordModal);
    return;
  }

  pane.innerHTML = account + `<div class="lic-grid">${data.licenses.map(licenseCard).join("")}</div>`;
  $("#btn-password")?.addEventListener("click", openPasswordModal);
}

function licenseCard(lic) {
  const expiredSoon = lic.status === "active" && lic.days_left !== null && lic.days_left <= 7;
  const daysText =
    lic.status === "active"
      ? lic.days_left === null
        ? "永久"
        : `${lic.days_left} 天`
      : lic.status === "expired"
        ? "已到期"
        : "—";

  const modules = lic.modules.length
    ? `<div class="mod-list">${lic.modules
        .map((m) => {
          const on = m.active;
          const tail = m.max_usages
            ? `<em>${m.used_usages}/${m.max_usages} 次</em>`
            : `<em>${on ? `${m.days_left} 天` : "已到期"}</em>`;
          return `<span class="mod-chip ${on ? "on" : "off"}" title="${esc(m.description ?? "")}">
            <span class="dot"></span>${esc(m.name)}${tail}
          </span>`;
        })
        .join("")}</div>`
    : `<p class="muted small">这条授权没有模块记录</p>`;

  const devices = lic.devices.length
    ? lic.devices
        .map(
          (d) => `<div class="dev-row">
            <span class="dev-icon">💻</span>
            <span class="grow">
              <b>${esc(d.device_name || d.device_id)}</b>
              <span>${esc(d.platform || "未知平台")} · 最后在线 ${fmtTime(d.last_seen_at)}</span>
            </span>
          </div>`,
        )
        .join("")
    : `<p class="muted small">还没有设备登录。客户端第一次启动并登录后会自动占用一个席位。</p>`;

  return `<article class="lic-card">
    <header class="lic-head">
      <div class="lic-title">
        <strong>${esc(lic.product.name)}</strong>
        ${lic.kind === "trial" ? '<span class="badge badge-info">试用</span>' : ""}
        <span class="lic-no">${esc(lic.license_no)}</span>
      </div>
      ${statusBadge(lic.status)}
    </header>

    <div class="lic-meta">
      <div class="meta-item"><span>到期时间</span><b>${fmtDay(lic.expires_at)}</b></div>
      <div class="meta-item ${expiredSoon ? "warn" : ""}"><span>剩余</span><b>${daysText}</b></div>
      <div class="meta-item"><span>设备席位</span><b>${lic.active_devices} / ${lic.seats}</b></div>
      <div class="meta-item"><span>产品编码</span><b class="mono" style="font-size:13px">${esc(lic.product.code)}</b></div>
    </div>

    <div class="mod-block">
      <h4>已开通模块（${lic.modules.filter((m) => m.active).length}/${lic.modules.length} 可用）</h4>
      ${modules}
    </div>

    <div class="dev-block">
      <h4 style="margin:0 0 6px;font-size:12px;font-weight:600;color:var(--muted)">已登录设备</h4>
      ${devices}
    </div>
  </article>`;
}

/* ============================ 修改密码 ============================ */

function openPasswordModal() {
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal">
        <div class="modal-head">
          <h3 style="font-size:15.5px">修改密码</h3>
          <button class="btn btn-ghost btn-sm" data-close type="button">✕</button>
        </div>
        <div class="modal-body">
          <label class="field"><span>原密码</span>
            <input id="pw-current" type="password" autocomplete="current-password" placeholder="当前登录密码" />
          </label>
          <label class="field"><span>新密码（至少 8 位）</span>
            <input id="pw-next" type="password" autocomplete="new-password" placeholder="至少 8 位" />
          </label>
          <label class="field"><span>确认新密码</span>
            <input id="pw-confirm" type="password" autocomplete="new-password" placeholder="再输一次" />
          </label>
          <p class="form-error" id="pw-error" hidden></p>
          <p class="small muted">改完后其它设备上的登录会失效，需要重新登录；当前这台会保持登录。</p>
        </div>
        <div class="modal-foot">
          <button class="btn" data-close type="button">取消</button>
          <button class="btn btn-primary" id="pw-save" type="button">保存</button>
        </div>
      </div>
    </div>`;

  const close = () => {
    root.innerHTML = "";
  };
  const fail = (msg) => {
    const box = $("#pw-error", root);
    box.textContent = msg;
    box.hidden = false;
  };

  $$("[data-close]", root).forEach((b) => (b.onclick = close));
  $("#pw-current", root).focus();

  $("#pw-save", root).onclick = async () => {
    const current = $("#pw-current", root).value;
    const next = $("#pw-next", root).value;
    const confirm = $("#pw-confirm", root).value;
    $("#pw-error", root).hidden = true;

    if (!current) return fail("请先填原密码");
    if (next.length < 8) return fail("新密码至少 8 位");
    if (next === current) return fail("新密码不能和原密码一样");
    if (next !== confirm) return fail("两次输入的新密码不一致");

    const btn = $("#pw-save", root);
    btn.disabled = true;
    btn.textContent = "保存中…";
    try {
      const data = await api("POST", "/api/v1/auth/password", {
        current_password: current,
        new_password: next,
      });
      // 后端会作废其它会话并发一个新的过来，这里接住它，保持当前设备不掉线
      if (data?.token) {
        state.token = data.token;
        localStorage.setItem(TOKEN_KEY, data.token);
      }
      close();
      toast("密码已修改", "ok");
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "保存";
      fail(err.message);
    }
  };
}

/* ============================ 激活 ============================ */

function renderActivate() {
  const pane = $("#pane-activate");
  pane.innerHTML = `
    <section class="act-card">
      <div>
        <h3 style="font-size:15.5px">输入激活码</h3>
        <p class="muted small" style="margin-top:4px">
          先点「查询」看看是什么产品、多少天、几台设备，确认无误再激活。激活后授权会绑到这个账号上。
        </p>
      </div>
      <div class="act-row">
        <input id="cdk-input" placeholder="XXXX-XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false" maxlength="32" />
        <button class="btn btn-primary" id="btn-inspect" type="button">查询</button>
      </div>
      <div id="act-result"></div>
      <p class="muted small">
        网页激活只把激活码绑到账号，不占设备席位；客户端第一次启动登录时会占用一个席位。
      </p>
    </section>`;

  const input = $("#cdk-input");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doInspect();
  });
  $("#btn-inspect").onclick = doInspect;
  if (state.inspect) renderInspect(state.inspect);
}

async function doInspect() {
  const code = $("#cdk-input").value.trim().toUpperCase();
  if (!code) {
    toast("先填激活码", "error");
    return;
  }
  try {
    const data = await api("POST", "/api/v1/cdks/inspect", { cdk: code });
    state.inspect = data;
    renderInspect(data);
  } catch (err) {
    state.inspect = null;
    $("#act-result").innerHTML = `<div class="act-result bad"><b>查不到这张卡</b><span class="small">${esc(err.message)}</span></div>`;
  }
}

function inspectHtml(info, { withActivate = false } = {}) {
  const t = info.usable ? "ok" : "bad";
  const reason = info.usable ? "可以激活" : "这张卡现在不能用";
  return `
    <div class="act-result ${t}">
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap">
        <b>${esc(info.product?.name ?? "未知产品")}</b>
        <span class="badge ${info.usable ? "badge-ok" : "badge-danger"}">${esc(reason)}</span>
      </div>
      <div class="kv-grid">
        <div><span>产品编码</span><b class="mono" style="font-size:13px">${esc(info.product?.code ?? "—")}</b></div>
        <div><span>时长</span><b>${info.days} 天</b></div>
        <div><span>设备席位</span><b>${info.seats} 台</b></div>
        <div><span>兑换截止</span><b>${fmtDay(info.redeem_before)}</b></div>
      </div>
      <div><span class="small muted">包含模块</span>
        <div class="mod-list" style="margin-top:6px">
          ${
            (info.modules ?? [])
              .map((m) => `<span class="mod-chip" title="${esc(m.code)}">${esc(m.name || m.code)}</span>`)
              .join("") || '<span class="small muted">—</span>'
          }
        </div>
      </div>
      ${withActivate && info.usable ? `<button class="btn btn-primary" id="btn-activate" type="button" style="margin-top:4px">确认激活</button>` : ""}
      ${!withActivate && info.usable ? '<p class="small muted">登录后就能直接激活这张卡</p>' : ""}
    </div>`;
}

function renderInspect(info) {
  $("#act-result").innerHTML = inspectHtml(info, { withActivate: true });
  const btn = $("#btn-activate");
  if (btn) btn.onclick = doActivate;
}

/** 登录页下方的查卡：不核销、不需要登录 */
async function doGuestInspect() {
  const code = $("#guest-cdk").value.trim().toUpperCase();
  if (!code) {
    toast("先填激活码", "error");
    return;
  }
  const box = $("#guest-result");
  box.innerHTML = '<p class="small muted">查询中…</p>';
  try {
    const info = await api("POST", "/api/v1/cdks/inspect", { cdk: code });
    box.innerHTML = inspectHtml(info, { withActivate: false });
  } catch (err) {
    box.innerHTML = `<div class="act-result bad"><b>查不到这张卡</b><span class="small">${esc(err.message)}</span></div>`;
  }
}

async function doActivate() {
  const btn = $("#btn-activate");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "激活中…";
  }
  try {
    const data = await api("POST", "/api/v1/licenses/activate", {
      cdk: $("#cdk-input").value.trim().toUpperCase(),
      bind_device: false, // 网页激活不占席位
    });
    state.inspect = null;
    await enterApp();
    switchTab("licenses");
    showLicenseKey(data);
  } catch (err) {
    toast(err.message, "error");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "确认激活";
    }
  }
}

function showLicenseKey(data) {
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="modal-backdrop">
      <div class="modal">
        <div class="modal-head">
          <h3 style="font-size:15.5px">激活成功</h3>
          <button class="btn btn-ghost btn-sm" data-close type="button">✕</button>
        </div>
        <div class="modal-body">
          <p class="small muted">
            ${data.device_bound === false ? "这张卡已绑到你的账号，没有占用设备席位。" : ""}
            把下面的许可证密钥填到客户端里，或者直接用这个账号在客户端登录。
          </p>
          <div class="key-box"><code id="lic-key">${esc(data.license_key)}</code></div>
          <p class="small" style="color:var(--warn)">密钥只显示这一次，请立刻复制保存。</p>
        </div>
        <div class="modal-foot">
          <button class="btn" data-close type="button">关闭</button>
          <button class="btn btn-primary" id="copy-key" type="button">复制密钥</button>
        </div>
      </div>
    </div>`;

  const close = () => {
    root.innerHTML = "";
  };
  $$("[data-close]", root).forEach((b) => (b.onclick = close));
  $("#copy-key", root).onclick = async () => {
    const key = $("#lic-key", root).textContent;
    try {
      await navigator.clipboard.writeText(key);
      toast("已复制", "ok");
    } catch {
      // 非 https 或旧浏览器：退回选中文本
      const range = document.createRange();
      range.selectNodeContents($("#lic-key", root));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      toast("请手动复制选中的密钥", "error");
    }
  };
}

/* ============================ 启动 ============================ */

async function boot() {
  bindAuth();
  bindTabs();
  if (!state.token) {
    renderAuth();
    return;
  }
  try {
    await enterApp();
  } catch {
    renderAuth();
  }
}

void boot();
