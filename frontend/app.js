const API_BASE = window.__API_BASE__ || "";
const TOKEN_KEY = "trackroi_token";
const CSRF_KEY = "trackroi_csrf";

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  csrfToken: localStorage.getItem(CSRF_KEY) || "",
  user: null,
  route: normalizeRoute(location.hash.slice(1) || "dashboard"),
  source: "all",
  routeData: null,
  dataCache: {},
  loading: false,
  sidebarExpanded: localStorage.getItem("trackroi_sidebar_expanded") !== "0",
};

const sidebarIcons = {
  dashboard: iconDashboard(),
  sales: iconSales(),
  funnel: iconFunnel(),
  metrics: iconMetrics(),
  products: iconProducts(),
  connections: iconConnections(),
  settings: iconSettings(),
  logs: iconLogs(),
  logout: iconLogout(),
};

function normalizeRoute(route) {
  const allowed = new Set(["dashboard", "sales", "funnel", "metrics", "products", "connections", "settings", "logs"]);
  return allowed.has(route) ? route : "dashboard";
}

function el(id) {
  return document.getElementById(id);
}

function money(cents) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format((Number(cents) || 0) / 100);
}

function percent(value) {
  if (value == null || Number.isNaN(value)) return "—";
  return `${Number(value).toFixed(1)}%`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function friendlyError(error) {
  const message = error?.message || "";
  if (message === "AUTH_REQUIRED") return "Sessão expirada. Faça login novamente.";
  if (message.includes("Failed to fetch")) return "Não foi possível conectar ao servidor. Tente novamente.";
  return message || "Algo deu errado. Tente novamente.";
}

async function apiFetch(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (state.csrfToken && options.method && options.method !== "GET") {
    headers["X-CSRF-Token"] = state.csrfToken;
  }
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  } catch (networkError) {
    throw new Error("Não foi possível conectar. Verifique sua internet e tente novamente.");
  }
  if (response.status === 401) {
    state.token = "";
    state.csrfToken = "";
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(CSRF_KEY);
    throw new Error("AUTH_REQUIRED");
  }
  const text = await response.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = {};
    }
  }
  if (!response.ok) {
    throw new Error(body.error || `Erro ao processar a solicitação`);
  }
  return body;
}

function setStatus(message, tone = "") {
  const node = el("status-strip");
  if (node) {
    node.hidden = !message;
    node.textContent = message || "";
    node.classList.toggle("is-error", tone === "error");
    node.classList.toggle("is-success", tone === "success");
  }
}

function setLoginError(message) {
  const node = el("login-error");
  node.hidden = !message;
  node.textContent = message || "";
}

function setButtonLoading(button, label) {
  if (!button) return;
  if (label) {
    if (!button.dataset.originalLabel) button.dataset.originalLabel = button.textContent;
    button.disabled = true;
    button.classList.add("is-loading");
    button.textContent = label;
  } else {
    button.disabled = false;
    button.classList.remove("is-loading");
    if (button.dataset.originalLabel) button.textContent = button.dataset.originalLabel;
  }
}

function showLogin() {
  const app = el("app-view");
  if (app) app.hidden = true;
  const login = el("login-view");
  if (login) login.classList.add("visible");
  el("email-input").value = "";
  el("password-input").value = "";
}

function showApp() {
  const app = el("app-view");
  if (app) app.hidden = false;
  const login = el("login-view");
  if (login) login.classList.remove("visible");
  applySidebarState();
  updateSidebarUser();
}

function setRoute(route) {
  state.route = normalizeRoute(route);
  location.hash = `#${state.route}`;
  updateNav();
  renderPage();
}

function updateNav() {
  document.querySelectorAll("[data-route]").forEach((item) => {
    item.classList.toggle("active", item.dataset.route === state.route);
  });
  moveNavIndicator();
}

function moveNavIndicator() {
  const nav = el("nav-links");
  const indicator = el("nav-indicator");
  const active = nav ? nav.querySelector(".nav-item.active") : null;
  if (!nav || !indicator || !active) return;
  indicator.style.height = `${active.offsetHeight}px`;
  indicator.style.transform = `translateY(${active.offsetTop}px)`;
}

function applySidebarState() {
  const app = el("app-view");
  if (!app) return;
  app.classList.toggle("sidebar-collapsed", !state.sidebarExpanded);
  localStorage.setItem("trackroi_sidebar_expanded", state.sidebarExpanded ? "1" : "0");
  window.setTimeout(moveNavIndicator, 360);
  window.setTimeout(moveNavIndicator, 640);
}

function updateSidebarUser() {
  const name = el("sidebar-user-name");
  const role = el("sidebar-user-role");
  const avatar = el("sidebar-avatar");
  if (state.user) {
    if (name) name.textContent = state.user.name || "Usuário";
    if (role) role.textContent = state.user.role === "admin" ? "Administrador" : "Membro";
    if (avatar) avatar.textContent = (state.user.name || "U").charAt(0).toUpperCase();
  }
}

function mountSidebarIcons() {
  document.querySelectorAll(".nav-icon").forEach((node) => {
    const key = node.dataset.icon;
    node.innerHTML = sidebarIcons[key] || "";
  });
  document.querySelectorAll("#nav-links .nav-item").forEach((item, index) => {
    item.style.setProperty("--i", index);
  });
  el("sidebar-toggle").onclick = () => {
    state.sidebarExpanded = !state.sidebarExpanded;
    applySidebarState();
  };
  window.addEventListener("resize", moveNavIndicator);
}

/* ------------------------------------------------------------- Data loading */

const routeFetch = {
  dashboard: () => apiFetch(`/api/dashboard?source=${encodeURIComponent(state.source)}`),
  funnel: () => apiFetch(`/api/dashboard?source=${encodeURIComponent(state.source)}`),
  metrics: () => apiFetch(`/api/dashboard?source=${encodeURIComponent(state.source)}`),
  sales: async () => {
    const sales = await apiFetch("/api/sales");
    return { ok: true, sales: sales.items || [], pagination: sales.pagination };
  },
  products: async () => {
    const products = await apiFetch("/api/products");
    return { ok: true, products: products.items || [] };
  },
  connections: async () => {
    const integrations = await apiFetch("/api/integrations");
    return { ok: true, integrations: integrations.items || [] };
  },
  settings: async () => {
    const settings = await apiFetch("/api/settings");
    return { ok: true, settings: settings.settings || {} };
  },
  logs: async () => {
    const [webhookEvents, auditLogs] = await Promise.all([
      apiFetch("/api/webhook-events"),
      apiFetch("/api/audit-logs"),
    ]);
    return { ok: true, webhookEvents: webhookEvents.items || [], auditLogs: auditLogs.items || [] };
  },
};

async function loadData(route = state.route, { silent = false } = {}) {
  state.route = normalizeRoute(route);
  state.loading = true;
  if (!silent) setStatus("");
  if (!state.dataCache[state.route]) renderPage();
  try {
    const data = await routeFetch[state.route]();
    data._source = state.source;
    state.routeData = data;
    state.dataCache[state.route] = data;
    state.loading = false;
    if (silent && state.route === "dashboard") {
      applyDashboardData(data);
    } else {
      renderPage();
    }
  } catch (error) {
    state.loading = false;
    if (error.message === "AUTH_REQUIRED") {
      stopSSE();
      showLogin();
      return;
    }
    if (silent) {
      setStatus(`Não foi possível atualizar: ${friendlyError(error)}`, "error");
    } else {
      renderErrorPage(friendlyError(error));
    }
  }
}

function renderErrorPage(message) {
  pageTitle(state.route);
  pageControls(state.route);
  const root = el("page-root");
  root.innerHTML = `
    <section class="onboarding">
      <div class="onboarding-orb"></div>
      <h3>Não foi possível carregar</h3>
      <p>${escapeHtml(message)}</p>
      <div class="onboarding-actions">
        <button id="reload-button" type="button" class="btn-primary">Tentar novamente</button>
      </div>
    </section>
  `;
  attachPageHandlers();
}

/* ------------------------------------------------------------- SSE */

let sseSource = null;

function startSSE() {
  stopSSE();
  if (!state.token) return;
  const source = new EventSource(`${API_BASE || ""}/api/events?token=${encodeURIComponent(state.token)}`);
  sseSource = source;
  source.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message && message.type === "data") handleRealtime(message);
  };
  source.onerror = () => {
    /* EventSource reconecta automaticamente */
  };
}

function stopSSE() {
  if (sseSource) {
    sseSource.close();
    sseSource = null;
  }
}

function handleRealtime(message) {
  if (!state.user) return;
  const changed = message.changed || [];
  const relevant = changed.includes(state.route) || (state.route === "dashboard" && changed.some((c) => ["dashboard", "funnel", "metrics", "sales"].includes(c)));
  if (relevant) {
    loadData(state.route, { silent: true });
  }
}

/* ------------------------------------------------------------- Popup connection flow (P1) */

function openConnectPopup(providerId) {
  return new Promise((resolve) => {
    const url = `${API_BASE}/api/integrations/connect/${providerId}?token=${encodeURIComponent(state.token || "")}`;
    const popup = window.open(url, "trackroi_connect", "width=520,height=680");
    if (!popup) {
      resolve({ ok: false, error: "O navegador bloqueou a janela. Permita pop-ups para esta página." });
      return;
    }
    const onMessage = (event) => {
      const payload = event.data;
      if (!payload || payload.type !== "trackroi:oauth") return;
      if (payload.provider !== providerId) return;
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      try {
        popup.close();
      } catch {
        /* popup já fechado */
      }
      resolve({ ok: payload.ok === true, error: payload.error || null, connectedAccount: payload.connectedAccount || null });
    };
    window.addEventListener("message", onMessage);
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      try {
        popup.close();
      } catch {
        /* já fechado */
      }
      resolve({ ok: false, error: "A janela foi fechada antes da conexão terminar." });
    }, 120000);
  });
}

async function connectProvider(providerId, button) {
  setButtonLoading(button, "Verificando…");
  try {
    const health = await apiFetch(`/api/integrations/${providerId}/health`);
    if (!health.configured) {
      setButtonLoading(button, "");
      showConnectMessage(providerId, health.message || "Integração ainda não configurada pelo administrador.", "error");
      return;
    }
    setButtonLoading(button, "Aguardando autorização…");
    const result = await openConnectPopup(providerId);
    setButtonLoading(button, "");
    if (result.ok) {
      showConnectMessage(providerId, result.connectedAccount ? `Conectado como ${result.connectedAccount}.` : "Conexão concluída.", "success");
      await loadData("connections", { silent: true });
    } else {
      showConnectMessage(providerId, result.error || "Não foi possível conectar.", "error");
      await loadData("connections", { silent: true });
    }
  } catch (error) {
    setButtonLoading(button, "");
    showConnectMessage(providerId, friendlyError(error), "error");
  }
}

async function testProvider(providerId, button) {
  setButtonLoading(button, "Testando…");
  try {
    const health = await apiFetch(`/api/integrations/${providerId}/health`);
    setButtonLoading(button, "");
    if (health.configured) {
      showConnectMessage(providerId, "Conexão OK. Pronto para conectar.", "success");
    } else {
      showConnectMessage(providerId, health.message || "Configuração ausente.", "error");
    }
  } catch (error) {
    setButtonLoading(button, "");
    showConnectMessage(providerId, friendlyError(error), "error");
  }
}

function showConnectMessage(providerId, message, tone) {
  const node = document.querySelector(`[data-connect-message="${providerId}"]`);
  if (node) {
    node.hidden = false;
    node.textContent = message;
    node.classList.remove("is-error", "is-success");
    node.classList.add(tone === "error" ? "is-error" : "is-success");
  } else {
    setStatus(message, tone);
  }
}

/* ------------------------------------------------------------- Rendering */

function renderMetricCards(cards) {
  return `
    <section class="cards-grid">
      ${cards
        .map((card) => {
          const toneClass = card.tone === "positive" ? "positive" : card.tone === "negative" ? "negative" : "";
          const hint = card.hint ? `<div class="metric-hint">${escapeHtml(card.hint)}</div>` : "";
          return `
            <article class="metric-card" data-card="${escapeHtml(card.key)}">
              <div class="metric-label">${escapeHtml(card.label)}</div>
              <div class="metric-value ${toneClass}">${escapeHtml(card.value)}</div>
              ${hint}
            </article>
          `;
        })
        .join("")}
    </section>
  `;
}

function applyDashboardData(data) {
  const root = el("page-root");
  if (!root || state.route !== "dashboard") return;
  const cards = data.cards || [];
  const cardNodes = root.querySelectorAll(".metric-card");
  if (cardNodes.length === cards.length && cards.length) {
    cardNodes.forEach((node, index) => {
      const card = cards[index];
      const valueNode = node.querySelector(".metric-value");
      if (valueNode && valueNode.textContent !== card.value) {
        valueNode.textContent = card.value;
        valueNode.classList.toggle("positive", card.tone === "positive");
        valueNode.classList.toggle("negative", card.tone === "negative");
      }
    });
    if (data.funnel) {
      const funnelPanel = root.querySelector("section.panel");
      if (funnelPanel) {
        const subtitle = funnelPanel.querySelector(".panel-subtitle");
        const body = funnelPanel.querySelector(":scope > :not(.panel-header)");
        if (body) {
          const nf = new Intl.NumberFormat("pt-BR");
          const funnelSub = data.funnel.stages?.length
            ? data.funnel.stages.map((stage) => `${nf.format(stage.count)} ${stage.label.toLowerCase()}`).join(" · ")
            : "Cliques, visitas, checkouts e vendas.";
          if (subtitle) subtitle.textContent = funnelSub;
          const holder = document.createElement("div");
          holder.innerHTML = uvFunnelHtml(data.funnel);
          body.replaceWith(holder.firstElementChild);
          animateFunnel(data.funnel.stages);
        }
      }
    }
    setStatus("");
  } else {
    renderPage();
  }
}

function curveThrough(points) {
  if (!points.length) return "";
  let d = `M ${points[0][0].toFixed(1)} ${points[0][1].toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

function uvHalfs(stages, flat) {
  const maxCount = Math.max(...stages.map((stage) => stage.count), 1);
  const maxHalf = 102;
  return stages.map((stage) => {
    if (flat || !stage.count) return 6;
    return Math.max(6, (stage.count / maxCount) * maxHalf);
  });
}

function uvBuildD(halfs) {
  const W = 800;
  const H = 240;
  const pad = 18;
  const cy = H / 2;
  const n = halfs.length;
  const dx = n > 1 ? (W - pad * 2) / (n - 1) : 0;
  const top = halfs.map((h, i) => [pad + i * dx, cy - h]);
  const bottom = halfs.map((h, i) => [pad + i * dx, cy + h]).reverse();
  return curveThrough(top) + ` L ${bottom[0][0].toFixed(1)} ${bottom[0][1].toFixed(1)}` + curveThrough(bottom) + " Z";
}

let uvSeq = 0;
let lastFunnelCounts = null;
let funnelMorphTimer = null;

function uvFunnelHtml(funnel) {
  if (!funnel || !funnel.stages || !funnel.stages.length) {
    return `<div class="empty-state">Nenhum dado ainda. Conecte suas ferramentas para começar.</div>`;
  }
  uvSeq++;
  const stages = funnel.stages;
  const flat = funnel.empty || !stages.some((stage) => stage.count > 0);
  const n = stages.length;
  const W = 800;
  const H = 240;
  const pad = 18;
  const cy = H / 2;
  const dx = n > 1 ? (W - pad * 2) / (n - 1) : 0;
  const xAt = (i) => pad + i * dx;
  const halfs = uvHalfs(stages, flat);
  const id = `uv-grad-${uvSeq}`;
  const glowId = `uv-glow-${uvSeq}`;
  const gradRef = `url(#${id})`;

  const dividers = stages
    .map((_, i) => `<line class="uv-divider" x1="${xAt(i).toFixed(1)}" y1="16" x2="${xAt(i).toFixed(1)}" y2="224" />`)
    .join("");
  const nodes = stages
    .map((_, i) => `<circle class="uv-node" cx="${xAt(i).toFixed(1)}" cy="${cy}" r="3" />`)
    .join("");

  const nf = new Intl.NumberFormat("pt-BR");
  const legendCols = `${(pad / W) * 100}%${stages.map(() => ` ${(dx / W) * 100}%`).join("")} ${(pad / W) * 100}%`;
  const legend = `
    <ol class="uv-legend" style="grid-template-columns:${legendCols}">
      ${stages
        .map((stage, index) => {
          const value = flat ? "—" : nf.format(stage.count);
          const pct =
            flat || stage.conversion == null
              ? "—"
              : `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(stage.conversion)}%`;
          return `
            <li class="uv-item" style="grid-column-start:${index + 2}">
              <span class="uv-name">${escapeHtml(stage.label)}</span>
              <span class="uv-val">${value}</span>
              <span class="uv-pct">${pct}</span>
            </li>
          `;
        })
        .join("")}
    </ol>
  `;

  return `
    <div class="funnel-uv">
      <div class="uv-stage">
        <svg class="uv-svg" viewBox="0 0 800 240" preserveAspectRatio="none" role="img" aria-label="Funil de conversão">
          <defs>
            <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stop-color="#39ff88" />
              <stop offset="1" stop-color="#8a2be2" />
            </linearGradient>
            <filter id="${glowId}" x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="12" result="blur" />
            </filter>
          </defs>
          ${dividers}
          <path class="uv-glow" fill="${gradRef}" filter="url(#${glowId})"></path>
          <path class="uv-main" fill="${gradRef}"></path>
          <path class="uv-edge" stroke="${gradRef}"></path>
          ${nodes}
        </svg>
        ${flat ? `<div class="uv-empty"><p>Nenhum dado ainda. Conecte suas ferramentas e o funil começa a se preencher sozinho.</p></div>` : ""}
      </div>
      ${legend}
    </div>
  `;
}

function animateFunnel(stages) {
  if (!stages || !stages.length) return;
  const target = uvHalfs(stages, stages.every((stage) => stage.count === 0));
  const start = lastFunnelCounts && lastFunnelCounts.length === target.length ? lastFunnelCounts : target.map(() => 0);
  const node = document.querySelector(".funnel-uv");
  if (!node) {
    lastFunnelCounts = target;
    return;
  }
  const main = node.querySelector(".uv-main");
  const glow = node.querySelector(".uv-glow");
  const edge = node.querySelector(".uv-edge");
  const t0 = performance.now();
  const duration = 640;
  if (funnelMorphTimer) cancelAnimationFrame(funnelMorphTimer);
  const step = (now) => {
    const t = Math.min(1, (now - t0) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const halfs = target.map((value, i) => start[i] + (value - start[i]) * eased);
    const d = uvBuildD(halfs);
    if (main) main.setAttribute("d", d);
    if (glow) glow.setAttribute("d", d);
    if (edge) edge.setAttribute("d", d);
    if (t < 1) funnelMorphTimer = requestAnimationFrame(step);
    else lastFunnelCounts = target;
  };
  funnelMorphTimer = requestAnimationFrame(step);
}

function statusPill(status) {
  const map = {
    connected: ["Conectado", "ok"],
    not_connected: ["Não conectado", "off"],
    needs_reconnect: ["Precisa atenção", "warn"],
    configured: ["Configurado", "ok"],
    not_configured: ["Não configurado", "off"],
  };
  const [label, tone] = map[status] || [status || "—", "off"];
  return `<span class="status-pill ${tone}">${escapeHtml(label)}</span>`;
}

function sectionPanel(title, subtitle, body) {
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <div class="panel-title">${escapeHtml(title)}</div>
          ${subtitle ? `<div class="panel-subtitle">${escapeHtml(subtitle)}</div>` : ""}
        </div>
      </div>
      ${body}
    </section>
  `;
}

function tableHtml(headers, rows) {
  if (!rows.length) return `<div class="empty-state">Nenhum dado ainda.</div>`;
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr>
        </thead>
        <tbody>
          ${rows.join("")}
        </tbody>
      </table>
    </div>
  `;
}

function pageControls(route) {
  const controls = el("page-controls");
  if (!controls) return;
  const refresh = `<button id="refresh-button" type="button" class="ghost">Atualizar</button>`;
  const sourceSelect = `
    <label class="select-wrap">
      <span>Tráfego</span>
      <select id="source-filter">
        <option value="all" ${state.source === "all" ? "selected" : ""}>Tudo</option>
        <option value="direct" ${state.source === "direct" ? "selected" : ""}>Direto</option>
        <option value="meta" ${state.source === "meta" ? "selected" : ""}>Meta</option>
      </select>
    </label>
  `;
  const routeControls = {
    dashboard: `${sourceSelect}${refresh}`,
    funnel: `${sourceSelect}${refresh}`,
    sales: refresh,
    metrics: refresh,
    products: `<button id="product-create-button" type="button">Novo produto</button>${refresh}`,
    connections: refresh,
    settings: `<button id="save-settings-button" type="button">Salvar</button>${refresh}`,
    logs: refresh,
  };
  controls.innerHTML = routeControls[route] || refresh;
}

function pageTitle(route) {
  const titles = {
    dashboard: ["Dashboard", "Resumo geral"],
    sales: ["Vendas", "Pedidos e eventos de pagamento"],
    funnel: ["Funil", "Conversão por etapa"],
    metrics: ["Métricas", "Resumo financeiro e operacional"],
    products: ["Produtos", "Catálogo e preços"],
    connections: ["Conexões", "Conecte suas ferramentas"],
    settings: ["Configurações", "Preferências da conta"],
    logs: ["Logs", "Histórico de eventos"],
  };
  const [eyebrow, title] = titles[route];
  el("page-eyebrow").textContent = eyebrow;
  el("page-title").textContent = title;
}

function emptyDashboard() {
  return `
    <section class="onboarding">
      <div class="onboarding-orb"></div>
      <h3>Bem-vindo ao TrackROI</h3>
      <p>Conecte suas ferramentas de anúncios e pagamento e o seu painel começa a se preencher automaticamente.</p>
      <div class="onboarding-actions">
        <a class="btn-primary" href="#connections">Configurar conexões</a>
        <a class="btn-ghost" href="#metrics">Ver métricas</a>
      </div>
    </section>
  `;
}

function dashboardPage(data) {
  const hasData = data && data.empty === false;
  const nf = new Intl.NumberFormat("pt-BR");
  const funnelSub = data.funnel?.stages?.length
    ? data.funnel.stages.map((stage) => `${nf.format(stage.count)} ${stage.label.toLowerCase()}`).join(" · ")
    : "Cliques, visitas, checkouts e vendas.";
  const body = hasData
    ? `
      ${renderMetricCards(data.cards || [])}
      ${sectionPanel("Funil de conversão", funnelSub, uvFunnelHtml(data.funnel))}
    `
    : emptyDashboard();
  return body;
}

function salesTable(items) {
  const rows = items.map((sale) => `
    <tr>
      <td>${escapeHtml(sale.gateway === "perfectpay" ? "Perfect Pay" : sale.gateway)}</td>
      <td><span class="status-pill ${sale.status === "approved" ? "ok" : sale.status === "refunded" || sale.status === "chargeback" ? "warn" : "off"}">${escapeHtml(sale.status)}</span></td>
      <td>${escapeHtml(money(sale.amountCents || 0))}</td>
      <td>${escapeHtml(sale.gatewayTransactionId || "—")}</td>
      <td>${escapeHtml(formatDateTime(sale.createdAt))}</td>
    </tr>
  `);
  return tableHtml(["Pagamento", "Status", "Valor", "Transação", "Data"], rows);
}

function salesPage(data) {
  return sectionPanel("Vendas", "Todas as vendas registradas automaticamente.", salesTable(data.sales || []));
}

function funnelPage(data) {
  const stages = data.funnel?.stages;
  const body = stages && stages.length ? uvFunnelHtml(data.funnel) : uvFunnelHtml({ empty: true, stages: [] });
  return sectionPanel("Funil", "Conversão por etapa, do clique à venda aprovada.", body);
}

function metricsSummary(summary) {
  const items = [
    ["Cliques", summary.clickCount],
    ["Checkouts iniciados", summary.checkoutCount],
    ["Vendas aprovadas", summary.approvedSales],
    ["Pendentes", summary.pendingSales],
    ["AOV (ticket médio)", summary.aov == null ? "—" : money(summary.aov * 100)],
    ["Taxa de conversão", percent(summary.cvr != null ? summary.cvr * 100 : null)],
  ];
  return `
    <div class="info-grid">
      ${items.map(([label, value]) => `<div class="info-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`).join("")}
    </div>
  `;
}

function metricsPage(data) {
  const summary = data.summary || {};
  return `
    ${renderMetricCards(data.cards || [])}
    ${sectionPanel("Resumo detalhado", "Indicadores calculados automaticamente.", metricsSummary(summary))}
  `;
}

function productsPage(data) {
  const rows = (data.products || []).map((product) => `
    <tr>
      <td>${escapeHtml(product.name)}</td>
      <td>${escapeHtml(money(product.priceCents || 0))}</td>
      <td>${formatDateTime(product.createdAt)}</td>
    </tr>
  `);
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <div class="panel-title">Produtos</div>
          <div class="panel-subtitle">Cadastre os produtos do seu catálogo.</div>
        </div>
      </div>
      <form id="product-form" class="inline-form">
        <label><span>Nome</span><input id="product-name" type="text" /></label>
        <label><span>Preço (R$)</span><input id="product-price" type="number" min="0" step="0.01" placeholder="19,90" /></label>
        <button type="submit">Adicionar</button>
      </form>
      ${tableHtml(["Produto", "Preço", "Criado em"], rows)}
    </section>
  `;
}

function connectionCard(item) {
  const connected = item.connected === true;
  const status = connected || item.status === "connected" ? "connected" : item.status || "not_connected";
  const notConfigured = item.configured === false;
  return `
    <article class="connection-card ${connected ? "is-connected" : ""}" data-provider-card="${escapeHtml(item.id)}">
      <div class="connection-card-head">
        <div class="connection-logo">${escapeHtml((item.displayName || item.id).charAt(0))}</div>
        <div class="connection-card-title">
          <div class="connection-name">${escapeHtml(item.displayName || item.id)}</div>
          <div class="connection-desc">${escapeHtml(item.description || "")}</div>
        </div>
        ${statusPill(status)}
      </div>
      <div class="connection-card-body">
        <div class="connection-line">
          ${connected
            ? `Conectado${item.connectedAccount ? ` — ${escapeHtml(item.connectedAccount)}` : ""}.`
            : notConfigured
              ? "Integração ainda não configurada pelo administrador."
              : escapeHtml(item.healthMessage || "Sua ferramenta ainda não está conectada.")}
        </div>
        ${item.lastSyncAt ? `<div class="connection-line muted">Última sincronização: ${escapeHtml(formatDateTime(item.lastSyncAt))}</div>` : ""}
        <div class="connection-message" data-connect-message="${escapeHtml(item.id)}" hidden></div>
        <div class="connection-actions">
          ${notConfigured
            ? `<span class="ghost" disabled>Configuração pendente</span>`
            : `<button type="button" class="btn-primary" data-connect-button="${escapeHtml(item.id)}">${connected ? "Reconectar" : "Conectar"}</button>`}
          <button type="button" class="ghost" data-test-button="${escapeHtml(item.id)}">Testar conexão</button>
        </div>
      </div>
    </article>
  `;
}

function connectionAdvanced(integrations) {
  const byId = (id) => (integrations || []).find((item) => item.id === id) || {};
  const meta = byId("meta");
  const perfectPay = byId("perfectpay");
  return `
    <details class="advanced-section">
      <summary><span class="advanced-title">Configurações avançadas</span><span class="advanced-caret"></span></summary>
      <div class="advanced-body">
        <form id="meta-connection-form" class="stack-form compact-form">
          <div class="form-title">Meta Ads</div>
          <label><span>Status</span>
            <select id="meta-status">
              <option value="not_connected" ${meta.status !== "connected" ? "selected" : ""}>Não conectado</option>
              <option value="connected" ${meta.status === "connected" ? "selected" : ""}>Conectado</option>
              <option value="needs_reconnect" ${meta.status === "needs_reconnect" ? "selected" : ""}>Precisa atenção</option>
            </select>
          </label>
          <label><span>ID da conta de anúncios</span><input id="meta-ad-account-id" type="text" value="${escapeHtml(meta.adAccountId || "")}" placeholder="act_..." /></label>
          <button type="submit" id="meta-save-button">Salvar Meta</button>
        </form>

        <form id="perfectpay-connection-form" class="stack-form compact-form">
          <div class="form-title">Perfect Pay</div>
          <label><span>Status</span>
            <select id="perfectpay-status">
              <option value="not_connected" ${perfectPay.status !== "connected" ? "selected" : ""}>Não conectado</option>
              <option value="connected" ${perfectPay.status === "connected" ? "selected" : ""}>Conectado</option>
              <option value="needs_reconnect" ${perfectPay.status === "needs_reconnect" ? "selected" : ""}>Precisa atenção</option>
            </select>
          </label>
          <label><span>URL de eventos</span><input id="perfectpay-webhook-url" type="text" value="${escapeHtml(perfectPay.webhookUrl || "")}" /></label>
          <label><span>Segredo compartilhado</span><input id="perfectpay-webhook-secret" type="password" value="" placeholder="Novo segredo (opcional)" /></label>
          <button type="submit" id="perfectpay-save-button">Salvar Perfect Pay</button>
        </form>
      </div>
    </details>
  `;
}

function connectionsPage(data) {
  const integrations = data.integrations || [];
  const connectedCount = integrations.filter((item) => item.connected === true).length;
  const total = integrations.length;
  const allDone = connectedCount === total && total > 0;

  const hero = `
    <section class="connections-hero">
      <div class="connections-hero-copy">
        <h3>Conecte suas ferramentas</h3>
        <p>Vincule seus anúncios e sua plataforma de pagamento. Depois de conectar, os dados entram sozinhos — sem trabalho manual.</p>
      </div>
      <div class="connections-progress">
        <div class="progress-steps">
          ${integrations
            .map((item, index) => {
              const done = item.connected === true;
              return `
                ${index > 0 ? `<span class="progress-line ${integrations[index - 1].connected === true ? "done" : ""}"></span>` : ""}
                <span class="progress-step ${done ? "done" : ""}">${done ? "✓" : index + 1}</span>
              `;
            })
            .join("")}
        </div>
        <div class="progress-label">${allDone ? "Tudo pronto!" : `Faltam ${total - connectedCount} conexões`}</div>
      </div>
    </section>
  `;

  const cards = `
    <section class="connections-layout">
      ${integrations.map((item) => connectionCard(item)).join("")}
      ${integrations.length === 0 ? `<div class="empty-state">Nenhuma integração disponível neste momento.</div>` : ""}
    </section>
  `;

  const guide = sectionPanel(
    "Como funciona",
    "Três passos simples para começar.",
    `
    <div class="tutorial-grid">
      <div class="tutorial-card">
        <div class="tutorial-step">1</div>
        <strong>Conecte o Meta Ads</strong>
        <p>Clique em "Conectar" e autorize o acesso na janela que abrir.</p>
      </div>
      <div class="tutorial-card">
        <div class="tutorial-step">2</div>
        <strong>Conecte o Perfect Pay</strong>
        <p>Repita o mesmo processo para receber suas vendas.</p>
      </div>
      <div class="tutorial-card">
        <div class="tutorial-step">3</div>
        <strong>Acompanhe os resultados</strong>
        <p>O dashboard passa a mostrar vendas, investimento e ROAS em tempo real.</p>
      </div>
    </div>
    `
  );

  return `${hero}${cards}${connectionAdvanced(integrations)}${guide}`;
}

function settingsPage(data) {
  const settings = data.settings || {};
  const general = settings.general || {};
  return sectionPanel(
    "Configurações",
    "Preferências da sua conta.",
    `
    <form id="settings-form" class="settings-grid">
      <label><span>Nome da empresa</span><input id="company-name" type="text" value="${escapeHtml(general.companyName || "")}" /></label>
      <label><span>Fuso horário</span><input id="timezone" type="text" value="${escapeHtml(general.timezone || "")}" /></label>
      <label><span>Moeda</span><input id="currency" type="text" value="${escapeHtml(general.currency || "")}" /></label>
      <div class="form-actions"><button type="submit" id="save-settings-submit">Salvar</button><span class="form-status" id="settings-form-status"></span></div>
    </form>
    `
  );
}

function logsPage(data) {
  const webhooks = (data.webhookEvents || []).map((item) => `
    <tr>
      <td>${escapeHtml(formatDateTime(item.receivedAt))}</td>
      <td>${escapeHtml(item.gateway === "perfectpay" ? "Perfect Pay" : item.gateway)}</td>
      <td>${escapeHtml(item.eventType)}</td>
      <td><span class="status-pill ok">${escapeHtml(item.status)}</span></td>
    </tr>
  `);
  const audits = (data.auditLogs || []).map((item) => `
    <tr>
      <td>${escapeHtml(formatDateTime(item.timestamp))}</td>
      <td>${escapeHtml(item.action)}</td>
    </tr>
  `);
  return `
    <div class="chart-grid">
      ${sectionPanel("Eventos recebidos", "Sincronizações das suas ferramentas conectadas.", tableHtml(["Data", "Ferramenta", "Evento", "Status"], webhooks))}
      ${sectionPanel("Atividade da conta", "Ações realizadas no sistema.", tableHtml(["Data", "Ação"], audits))}
    </div>
  `;
}

function renderSkeleton() {
  const cards = Array.from({ length: 6 }, () => `
    <div class="skeleton" style="min-height:132px; display:flex; flex-direction:column; justify-content:space-between; padding:20px 22px;">
      <div class="skeleton-line" style="width:45%;"></div>
      <div class="skeleton-line" style="width:70%; height:26px;"></div>
      <div class="skeleton-line" style="width:30%;"></div>
    </div>
  `).join("");
  const funnel = `
    <div class="skeleton" style="min-height:320px; display:grid; gap:16px; padding:24px;">
      <div class="skeleton-line" style="width:30%; height:16px;"></div>
      <div class="skeleton-line" style="width:55%;"></div>
      <div style="height:150px;"></div>
      <div class="skeleton-line" style="width:80%;"></div>
    </div>
  `;
  return `
    <section class="cards-grid">${cards}</section>
    <section class="panel">${funnel}</section>
  `;
}

const renderers = {
  dashboard: dashboardPage,
  sales: salesPage,
  funnel: funnelPage,
  metrics: metricsPage,
  products: productsPage,
  connections: connectionsPage,
  settings: settingsPage,
  logs: logsPage,
};

function renderPage() {
  const root = el("page-root");
  const data = state.routeData;
  if (state.loading && !data) {
    pageTitle(state.route);
    pageControls(state.route);
    root.innerHTML = renderSkeleton();
    attachPageHandlers();
    return;
  }
  const pageData = data || state.dataCache[state.route] || {};
  state.routeData = pageData;
  pageTitle(state.route);
  pageControls(state.route);
  root.innerHTML = renderers[state.route](pageData);
  if ((state.route === "dashboard" || state.route === "funnel") && pageData.funnel?.stages) {
    animateFunnel(pageData.funnel.stages);
  }
  attachPageHandlers();
}

/* ------------------------------------------------------------- Handlers */

function attachPageHandlers() {
  const refresh = el("refresh-button");
  if (refresh) refresh.onclick = () => loadData(state.route);

  const reload = el("reload-button");
  if (reload) reload.onclick = () => loadData(state.route);

  const source = el("source-filter");
  if (source) {
    source.onchange = () => {
      state.source = source.value;
      state.dataCache.dashboard = null;
      state.dataCache.funnel = null;
      state.dataCache.metrics = null;
      loadData(state.route);
    };
  }

  el("logout-button").onclick = async () => {
    try {
      await apiFetch("/api/auth/logout", { method: "POST", body: "{}" });
    } finally {
      stopSSE();
      state.token = "";
      state.user = null;
      state.csrfToken = "";
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(CSRF_KEY);
      showLogin();
    }
  };

  document.querySelectorAll("[data-connect-button]").forEach((button) => {
    button.onclick = () => connectProvider(button.dataset.connectButton, button);
  });
  document.querySelectorAll("[data-test-button]").forEach((button) => {
    button.onclick = () => testProvider(button.dataset.testButton, button);
  });

  const productForm = el("product-form");
  if (productForm) {
    productForm.onsubmit = async (event) => {
      event.preventDefault();
      const submit = productForm.querySelector("button[type=submit]");
      const name = el("product-name").value.trim();
      const priceInput = el("product-price").value.replace(",", ".");
      const price = Number(priceInput || 0);
      if (!name) return;
      setButtonLoading(submit, "Adicionando…");
      try {
        await apiFetch("/api/products", { method: "POST", body: JSON.stringify({ name, priceCents: Math.round(price * 100) }) });
        await loadData(state.route);
      } catch (error) {
        setStatus(friendlyError(error), "error");
      } finally {
        setButtonLoading(submit, "");
      }
    };
  }

  const metaConnectionForm = el("meta-connection-form");
  if (metaConnectionForm) {
    metaConnectionForm.onsubmit = async (event) => {
      event.preventDefault();
      const submit = el("meta-save-button") || metaConnectionForm.querySelector("button[type=submit]");
      setButtonLoading(submit, "Salvando…");
      try {
        await apiFetch("/api/integrations/meta", {
          method: "PUT",
          body: JSON.stringify({
            status: el("meta-status").value,
            adAccountId: el("meta-ad-account-id").value.trim(),
          }),
        });
        setStatus("Configurações do Meta salvas.", "success");
        await loadData(state.route, { silent: true });
      } catch (error) {
        setStatus(friendlyError(error), "error");
      } finally {
        setButtonLoading(submit, "");
      }
    };
  }

  const perfectPayConnectionForm = el("perfectpay-connection-form");
  if (perfectPayConnectionForm) {
    perfectPayConnectionForm.onsubmit = async (event) => {
      event.preventDefault();
      const submit = el("perfectpay-save-button") || perfectPayConnectionForm.querySelector("button[type=submit]");
      const payload = {
        status: el("perfectpay-status").value,
        webhookUrl: el("perfectpay-webhook-url").value.trim(),
      };
      const secret = el("perfectpay-webhook-secret").value.trim();
      if (secret) payload.webhookSecret = secret;
      setButtonLoading(submit, "Salvando…");
      try {
        await apiFetch("/api/integrations/perfectpay", { method: "PUT", body: JSON.stringify(payload) });
        setStatus("Configurações da Perfect Pay salvas.", "success");
        await loadData(state.route, { silent: true });
      } catch (error) {
        setStatus(friendlyError(error), "error");
      } finally {
        setButtonLoading(submit, "");
      }
    };
  }

  const productCreateButton = el("product-create-button");
  if (productCreateButton) {
    productCreateButton.onclick = () => {
      const form = el("product-form");
      if (form) form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    };
  }

  const settingsForm = el("settings-form");
  if (settingsForm) {
    settingsForm.onsubmit = async (event) => {
      event.preventDefault();
      const submit = el("save-settings-submit");
      const statusNode = el("settings-form-status");
      setButtonLoading(submit, "Salvando…");
      const payload = {
        general: {
          companyName: el("company-name").value.trim(),
          timezone: el("timezone").value.trim(),
          currency: el("currency").value.trim(),
        },
      };
      try {
        await apiFetch("/api/settings", { method: "PUT", body: JSON.stringify(payload) });
        if (statusNode) statusNode.textContent = "Salvo.";
        setStatus("Configurações salvas.", "success");
      } catch (error) {
        if (statusNode) statusNode.textContent = "";
        setStatus(friendlyError(error), "error");
      } finally {
        setButtonLoading(submit, "");
      }
    };
  }

  const saveSettingsButton = el("save-settings-button");
  if (saveSettingsButton) {
    saveSettingsButton.onclick = () => {
      const form = el("settings-form");
      if (form) form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    };
  }
}

/* ------------------------------------------------------------- Auth */

async function login(email, password) {
  const result = await apiFetch("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
    headers: { "Content-Type": "application/json" },
  });
  state.token = result.token;
  state.user = result.user;
  state.csrfToken = result.csrfToken || "";
  localStorage.setItem(TOKEN_KEY, result.token);
  if (state.csrfToken) localStorage.setItem(CSRF_KEY, state.csrfToken);
  showApp();
  startSSE();
  await loadData();
}

async function bootstrap() {
  mountSidebarIcons();
  applySidebarState();

  el("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    setLoginError("");
    const submit = el("login-form").querySelector("button[type=submit]");
    setButtonLoading(submit, "Entrando…");
    try {
      await login(el("email-input").value.trim(), el("password-input").value);
    } catch (error) {
      setLoginError(friendlyError(error));
    } finally {
      setButtonLoading(submit, "");
    }
  });

  window.addEventListener("hashchange", () => {
    const next = normalizeRoute(location.hash.slice(1) || "dashboard");
    if (next === state.route) return;
    state.route = next;
    updateNav();
    loadData(next);
  });

  if (state.token) {
    try {
      const me = await apiFetch("/api/auth/me");
      state.user = me.user;
      state.csrfToken = me.csrfToken || "";
      localStorage.setItem(CSRF_KEY, state.csrfToken);
      showApp();
      startSSE();
      await loadData();
      return;
    } catch {
      state.token = "";
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(CSRF_KEY);
    }
  }

  showLogin();
}

function iconDashboard() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11.5V20h6v-5.5H4Zm10 0V20h6v-8.5h-6ZM4 4v5.5h6V4H4Zm10 0v5.5h6V4h-6Z"/></svg>';
}

function iconSales() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3v2H4v2h3v12h2v-2h5.5a4.5 4.5 0 0 0 0-9H9V7h10V5H9V3H7Zm2 7h5.5a2.5 2.5 0 0 1 0 5H9v-5Z"/></svg>';
}

function iconFunnel() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16l-6 7v5l-4 2v-7L4 5Zm4.8 2L11 10h2l2.2-3H8.8Z"/></svg>';
}

function iconMetrics() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19h16v2H4v-2Zm2-1.5 4-5 3 3 5.5-7 1.6 1.2-7.1 9.3-3-3L7.6 19 6 17.5Z"/></svg>';
}

function iconProducts() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4 7v10l8 4 8-4V7l-8-4Zm0 2.2 5.9 2.9L12 11 6.1 8.1 12 5.2Zm-6 4 5 2.5v6.2l-5-2.5V9.2Zm7 8.7v-6.2l5-2.5v6.2l-5 2.5Z"/></svg>';
}

function iconConnections() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4a4 4 0 0 0-3.7 5.5L12 18.2l8.7-8.7A4 4 0 0 0 17 4a3.9 3.9 0 0 0-3 1.4L12 8.1 10 5.4A3.9 3.9 0 0 0 7 4Zm0 2a2 2 0 0 1 1.6.8L12 11.7l3.4-4.9A2 2 0 0 1 19 7a2 2 0 0 1-.6 1.4L12 14.8 5.6 8.4A2 2 0 0 1 7 6Z"/></svg>';
}

function iconSettings() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2 1.2 2.7 3 .6 1.7 2.4-1.1 2.9 1.1 2.9-1.7 2.4-3 .6L12 22l-1.2-2.7-3-.6-1.7-2.4 1.1-2.9-1.1-2.9 1.7-2.4 3-.6L12 2Zm0 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/></svg>';
}

function iconLogs() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l5 5v13H6V3Zm8 1.5V9h4.5L14 4.5ZM8 12h8v2H8v-2Zm0 4h8v2H8v-2Z"/></svg>';
}

function iconLogout() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4v-2H6V7h4V5Zm4.3 3.3-1.4 1.4 2.3 2.3H8v2h7.2l-2.3 2.3 1.4 1.4L19 12l-4.7-4.7Z"/></svg>';
}

document.addEventListener("DOMContentLoaded", bootstrap);