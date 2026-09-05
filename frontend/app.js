const API_BASE = window.__API_BASE__ || "";
const TOKEN_KEY = "trackroi_token";

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  csrfToken: localStorage.getItem("trackroi_csrf") || "",
  user: null,
  route: normalizeRoute(location.hash.slice(1) || "dashboard"),
  source: "all",
  data: null,
  loading: false,
  sidebarExpanded: localStorage.getItem("trackroi_sidebar_expanded") !== "0",
};

const sidebarIcons = {
  dashboard: iconDashboard(),
  sales: iconSales(),
  funnel: iconFunnel(),
  metrics: iconMetrics(),
  products: iconProducts(),
  tools: iconTools(),
  connections: iconConnections(),
  settings: iconSettings(),
  logs: iconLogs(),
  logout: iconLogout(),
};

function normalizeRoute(route) {
  const allowed = new Set(["dashboard", "sales", "funnel", "metrics", "products", "tools", "connections", "settings", "logs"]);
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
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
    });
  } catch (networkError) {
    throw new Error("Não foi possível conectar ao backend. Verifique se ele está rodando na porta 4000.");
  }
  if (response.status === 401) {
    state.token = "";
    state.csrfToken = "";
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem("trackroi_csrf");
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
    throw new Error(body.error || `Request failed: ${response.status}`);
  }
  return body;
}

function setStatus(message) {
  const node = el("status-strip");
  if (node) node.textContent = message;
}

function setLoginError(message) {
  const node = el("login-error");
  node.hidden = !message;
  node.textContent = message || "";
}

function setRegisterError(message) {
  const node = el("register-error");
  node.hidden = !message;
  node.textContent = message || "";
}

function showAuthScreen(screen) {
  const loginView = el("login-view");
  const registerView = el("register-view");
  if (loginView) loginView.classList.toggle("visible", screen === "login");
  if (registerView) registerView.classList.toggle("visible", screen === "register");
}

function showLogin() {
  showAuthScreen("login");
  el("app-view").classList.add("locked");
  el("email-input").value = "";
  el("password-input").value = "";
  renderLockedPage();
}

function showRegister() {
  showAuthScreen("register");
  el("register-name").value = "";
  el("register-email").value = "";
  el("register-password").value = "";
  el("register-password-confirm").value = "";
}

function showApp() {
  showAuthScreen("");
  el("app-view").classList.remove("locked");
  applySidebarState();
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
}

function applySidebarState() {
  const app = el("app-view");
  if (!app) return;
  app.classList.toggle("sidebar-collapsed", !state.sidebarExpanded);
  localStorage.setItem("trackroi_sidebar_expanded", state.sidebarExpanded ? "1" : "0");
}

function mountSidebarIcons() {
  document.querySelectorAll(".nav-icon").forEach((node) => {
    const key = node.dataset.icon;
    node.innerHTML = sidebarIcons[key] || "";
  });
}

function renderMetricCards(cards) {
  return `
    <section class="cards-grid">
      ${cards
        .map((card) => {
          const toneClass = card.tone === "positive" ? "positive" : card.tone === "negative" ? "negative" : "";
          return `
            <article class="metric-card">
              <div class="metric-label">${escapeHtml(card.label)}</div>
              <div class="metric-value ${toneClass}">${escapeHtml(card.value)}</div>
            </article>
          `;
        })
        .join("")}
    </section>
  `;
}

function funnelHtml(funnel) {
  if (!funnel || funnel.empty) {
    return `<div class="empty-state">Nenhum dado ainda.</div>`;
  }
  const max = Math.max(...funnel.stages.map((stage) => stage.count), 1);
  return `
    <div class="funnel-chart">
      ${funnel.stages
        .map((stage, index) => {
          const ratio = funnel.stages.length <= 1 ? 0 : index / (funnel.stages.length - 1);
          const hue = 290 - ratio * 80;
          const nextHue = hue - 18;
          const width = Math.max(28, Math.round((stage.count / max) * 100));
          return `
            <div class="funnel-stage">
              <div class="funnel-bar" style="width:${width}%; background: linear-gradient(90deg, hsl(${hue} 78% 56%) 0%, hsl(${nextHue} 82% 48%) 100%);">
                <span>${escapeHtml(stage.label)}</span>
                <span class="funnel-count">${stage.count}</span>
              </div>
              <div class="funnel-meta">
                <span>Conversão vs etapa anterior: ${percent(stage.conversion)}</span>
                <span>vs primeiro estágio: ${percent(stage.firstStageConversion)}</span>
              </div>
            </div>
          `;
        })
        .join("")}
    </div>
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

function integrationCards(integrations) {
  if (!integrations) return "";
  const items = [
    {
      name: "Meta Ads",
      status: integrations.meta.status,
      detail: integrations.meta.connectedAccount || "Nenhuma conta conectada",
      extra: integrations.meta.lastSyncAt ? `Última sincronização: ${integrations.meta.lastSyncAt}` : "Sincronização ainda não configurada",
    },
    {
      name: "Perfect Pay",
      status: integrations.perfectPay.status,
      detail: integrations.perfectPay.webhookUrl,
      extra: integrations.perfectPay.lastReceivedEventAt ? `Último evento: ${integrations.perfectPay.lastReceivedEventAt}` : "Webhook ainda não recebido",
    },
  ];
  return `
    <div class="integration-list">
      ${items
        .map(
          (item) => `
            <article class="integration-card">
              <div class="integration-name">${escapeHtml(item.name)}</div>
              <div class="integration-badge">${escapeHtml(item.status)}</div>
              <div class="panel-line">${escapeHtml(item.detail)}</div>
              <div class="panel-line">${escapeHtml(item.extra)}</div>
            </article>
          `,
        )
        .join("")}
    </div>
  `;
}

function pageControls(route) {
  const controls = el("page-controls");
  if (!controls) return;
  const refresh = `<button id="refresh-button" type="button">Atualizar</button>`;
  const sourceSelect = `
    <label class="select-wrap">
      <span>Fonte</span>
      <select id="source-filter">
        <option value="all" ${state.source === "all" ? "selected" : ""}>Todas</option>
        <option value="direct" ${state.source === "direct" ? "selected" : ""}>Tráfego Direto</option>
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
    tools: refresh,
    connections: refresh,
    settings: `<button id="save-settings-button" type="button">Salvar</button>${refresh}`,
    logs: refresh,
  };
  controls.innerHTML = routeControls[route] || refresh;
}

function integrationConnectUrl(provider) {
  return `${API_BASE}/api/integrations/connect/${provider}?token=${encodeURIComponent(state.token || "")}`;
}

function pageTitle(route) {
  const titles = {
    dashboard: ["Dashboard", "Resumo operacional"],
    sales: ["Vendas", "Pedidos e eventos de pagamento"],
    funnel: ["Funil", "Conversão por etapa"],
    metrics: ["Métricas", "Resumo financeiro e operacional"],
    products: ["Produtos", "Catálogo e preços"],
    tools: ["Ferramentas", "Ações operacionais locais"],
    connections: ["Conexões e Rastreamento", "Meta Ads e Perfect Pay"],
    settings: ["Configurações", "Preferências do sistema"],
    logs: ["Logs", "Webhooks e auditoria"],
  };
  const [eyebrow, title] = titles[route];
  el("page-eyebrow").textContent = eyebrow;
  el("page-title").textContent = title;
}

function dashboardPage(data) {
  return `
    ${renderMetricCards(data.cards)}
    <section class="panel">
      <div class="panel-header">
        <div>
          <div class="panel-title">Funil de conversão</div>
          <div class="panel-subtitle">Dados reais, sem placeholders.</div>
        </div>
      </div>
      ${funnelHtml(data.funnel)}
    </section>
  `;
}

function salesTable(items) {
  const rows = items.map((sale) => `
    <tr>
      <td>${escapeHtml(sale.id)}</td>
      <td>${escapeHtml(sale.status)}</td>
      <td>${escapeHtml(sale.gateway)}</td>
      <td>${escapeHtml(money(sale.amountCents || 0))}</td>
      <td>${escapeHtml(sale.gatewayTransactionId)}</td>
      <td>${escapeHtml(sale.createdAt)}</td>
    </tr>
  `);
  return tableHtml(["ID", "Status", "Gateway", "Valor", "Transação", "Criada em"], rows);
}

function salesPage(data) {
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <div class="panel-title">Vendas</div>
          <div class="panel-subtitle">Somente registros persistidos no backend.</div>
        </div>
      </div>
      ${salesTable(data.sales)}
    </section>
  `;
}

function funnelPage(data) {
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <div class="panel-title">Funil</div>
          <div class="panel-subtitle">Cliques, visitas, checkout e vendas reais.</div>
        </div>
      </div>
      ${funnelHtml(data.funnel)}
    </section>
  `;
}

function metricsPage(data) {
  const summary = data.summary;
  return `
    ${renderMetricCards(data.cards)}
    <section class="panel">
      <div class="panel-header">
        <div>
          <div class="panel-title">Resumo detalhado</div>
          <div class="panel-subtitle">Indicadores derivados do estado atual.</div>
        </div>
      </div>
      <div class="info-grid">
        <div class="info-card"><span>Cliques</span><strong>${summary.clickCount}</strong></div>
        <div class="info-card"><span>Checkouts</span><strong>${summary.checkoutCount}</strong></div>
        <div class="info-card"><span>Vendas aprovadas</span><strong>${summary.approvedSales}</strong></div>
        <div class="info-card"><span>AOV</span><strong>${summary.aov == null ? "—" : money(summary.aov * 100)}</strong></div>
      </div>
    </section>
  `;
}

function productsPage(data) {
  const rows = data.products.map((product) => `
    <tr>
      <td>${escapeHtml(product.id)}</td>
      <td>${escapeHtml(product.name)}</td>
      <td>${escapeHtml(money(product.priceCents || 0))}</td>
      <td>${escapeHtml(product.createdAt)}</td>
    </tr>
  `);
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <div class="panel-title">Produtos</div>
          <div class="panel-subtitle">Cadastro persistido no backend.</div>
        </div>
      </div>
      <form id="product-form" class="inline-form">
        <label><span>Nome</span><input id="product-name" type="text" /></label>
        <label><span>Preço em centavos</span><input id="product-price" type="number" min="0" step="1" /></label>
      </form>
      ${tableHtml(["ID", "Nome", "Preço", "Criado em"], rows)}
    </section>
  `;
}

function toolsPage() {
  return `
    <section class="chart-grid">
      <article class="panel">
        <div class="panel-header"><div><div class="panel-title">Clique manual</div><div class="panel-subtitle">Ferramenta local para testar tracking.</div></div></div>
        <form id="click-form" class="stack-form">
          <label><span>trackroi_click_id</span><input id="click-trackroi" type="text" /></label>
          <label><span>Fonte</span><input id="click-source" type="text" value="direct" /></label>
          <button type="submit">Registrar clique</button>
        </form>
      </article>
      <article class="panel">
        <div class="panel-header"><div><div class="panel-title">Webhook de teste</div><div class="panel-subtitle">Envia um evento local para o backend.</div></div></div>
        <form id="webhook-form" class="stack-form">
          <label><span>Transaction ID</span><input id="webhook-transaction" type="text" /></label>
          <label><span>Event type</span><input id="webhook-event" type="text" value="approved" /></label>
          <label><span>Valor em centavos</span><input id="webhook-amount" type="number" min="0" step="1" /></label>
          <button type="submit">Enviar webhook</button>
        </form>
      </article>
    </section>
    <section class="panel">
      <div class="panel-header"><div><div class="panel-title">Lançar investimento</div><div class="panel-subtitle">Registra spend local para teste do ROAS/ROI.</div></div></div>
      <form id="spend-form" class="stack-form">
        <label><span>Fonte</span><input id="spend-source" type="text" value="meta" /></label>
        <label><span>Valor em centavos</span><input id="spend-amount" type="number" min="0" step="1" /></label>
        <button type="submit">Registrar investimento</button>
      </form>
    </section>
  `;
}

function connectionsPage(data) {
  const meta = data.integrations?.meta || {};
  const perfectPay = data.integrations?.perfectPay || {};
  const metaAuthUrl = "https://www.facebook.com/v22.0/dialog/oauth";
  const metaTokenUrl = "https://graph.facebook.com/v22.0/oauth/access_token";
  const perfectPayLoginUrl = "https://app.perfectpay.com.br/api/auth/login";
  const perfectPayPortalUrl = "https://app.perfectpay.com.br/br/login";
  return `
    <section class="panel connections-hero">
      <div class="panel-header connections-header">
        <div>
          <div class="panel-title title-with-icon">
            <span class="title-icon">${iconGear()}</span>
            <span>Conexões e Rastreamento</span>
          </div>
          <div class="panel-subtitle">Atalhos automáticos e configuração manual lado a lado.</div>
        </div>
        <div class="connections-quick-links">
          <a class="quick-link" href="${integrationConnectUrl("meta")}" target="_blank" rel="noreferrer">
            <span class="quick-link-icon">${iconGear()}</span>
            <span>Conectar Meta Ads</span>
          </a>
          <a class="quick-link" href="${integrationConnectUrl("perfectpay")}" target="_blank" rel="noreferrer">
            <span class="quick-link-icon">${iconGear()}</span>
            <span>Conectar Perfect Pay</span>
          </a>
        </div>
        <div class="connections-links">
          <article class="link-card">
            <div class="shortcut-topline">Meta Ads</div>
            <strong>OAuth real</strong>
            <a href="${metaAuthUrl}" target="_blank" rel="noreferrer">${metaAuthUrl}</a>
            <a href="${metaTokenUrl}" target="_blank" rel="noreferrer">${metaTokenUrl}</a>
          </article>
          <article class="link-card">
            <div class="shortcut-topline">Perfect Pay</div>
            <strong>Login e API</strong>
            <a href="${perfectPayLoginUrl}" target="_blank" rel="noreferrer">${perfectPayLoginUrl}</a>
            <a href="${perfectPayPortalUrl}" target="_blank" rel="noreferrer">${perfectPayPortalUrl}</a>
          </article>
        </div>
      </div>
      <div class="shortcut-grid">
        <article class="shortcut-card">
          <div class="shortcut-topline">Meta Ads</div>
          <strong>Fluxo automático</strong>
          <p>Abre o login da Meta com o backend preparado para receber o callback e salvar o token.</p>
          <a class="shortcut-button" href="${integrationConnectUrl("meta")}" target="_blank" rel="noreferrer">Abrir autorização</a>
        </article>
        <article class="shortcut-card">
          <div class="shortcut-topline">Perfect Pay</div>
          <strong>Token e webhook</strong>
          <p>Abre o helper do backend para validar a conta e conectar a API da Perfect Pay sem remover o setup manual.</p>
          <a class="shortcut-button" href="${integrationConnectUrl("perfectpay")}" target="_blank" rel="noreferrer">Abrir conexão</a>
        </article>
      </div>
    </section>
    <section class="connections-layout">
      <article class="panel">
        <div class="panel-header">
          <div>
            <div class="panel-title">Conexão Meta</div>
            <div class="panel-subtitle">Só o básico para puxar contas e vendas atribuídas.</div>
          </div>
        </div>
        <div class="integration-note">Se preferir, use o atalho automático acima para autenticar pelo backend. O formulário manual continua disponível aqui.</div>
        <form id="meta-connection-form" class="stack-form compact-form">
          <label><span>Status</span>
            <select id="meta-status">
              <option value="not_connected" ${meta.status === "not_connected" ? "selected" : ""}>Não conectado</option>
              <option value="connected" ${meta.status === "connected" ? "selected" : ""}>Conectado</option>
              <option value="needs_reconnect" ${meta.status === "needs_reconnect" ? "selected" : ""}>Precisa reconectar</option>
            </select>
          </label>
          <label><span>Conta de anúncios</span><input id="meta-ad-account-id" type="text" value="${escapeHtml(meta.adAccountId || "")}" placeholder="act_..." /></label>
          <label><span>Token</span><input id="meta-access-token" type="password" value="${escapeHtml(meta.accessToken || "")}" placeholder="Token de acesso" /></label>
          <button type="submit">Salvar Meta</button>
        </form>
      </article>
      <article class="panel">
        <div class="panel-header">
          <div>
            <div class="panel-title">Rastreamento Perfect Pay</div>
            <div class="panel-subtitle">Webhook público e segredo. É só isso para registrar vendas.</div>
          </div>
        </div>
        <div class="integration-note">O atalho automático abre a validação de conta do backend. O webhook continua configurável manualmente.</div>
        <form id="perfectpay-connection-form" class="stack-form compact-form">
          <label><span>Status</span>
            <select id="perfectpay-status">
              <option value="not_connected" ${perfectPay.status === "not_connected" ? "selected" : ""}>Não conectado</option>
              <option value="connected" ${perfectPay.status === "connected" ? "selected" : ""}>Conectado</option>
              <option value="needs_reconnect" ${perfectPay.status === "needs_reconnect" ? "selected" : ""}>Precisa reconectar</option>
            </select>
          </label>
          <label><span>Webhook URL</span><input id="perfectpay-webhook-url" type="text" value="${escapeHtml(perfectPay.webhookUrl || "")}" /></label>
          <label><span>Segredo</span><input id="perfectpay-webhook-secret" type="password" value="${escapeHtml(perfectPay.webhookSecret || "")}" placeholder="Segredo compartilhado" /></label>
          <button type="submit">Salvar Perfect Pay</button>
        </form>
      </article>
    </section>
    <section class="panel">
      <div class="panel-header">
        <div>
          <div class="panel-title">Tutorial rápido</div>
          <div class="panel-subtitle">Como conectar os dois sem complicar.</div>
        </div>
      </div>
      <div class="tutorial-grid">
        <div class="tutorial-card">
          <div class="tutorial-step">1</div>
          <strong>Meta Ads</strong>
          <p>Use o atalho automático para autorizar o app e depois ajuste a conta de anúncios se necessário.</p>
        </div>
        <div class="tutorial-card">
          <div class="tutorial-step">2</div>
          <strong>Perfect Pay</strong>
          <p>Abra o helper do backend, valide a conta e então mantenha o webhook apontado para este sistema.</p>
        </div>
        <div class="tutorial-card">
          <div class="tutorial-step">3</div>
          <strong>Teste</strong>
          <p>Depois de conectar, envie um webhook de teste para conferir se a venda aparece em Vendas e no dashboard.</p>
        </div>
      </div>
    </section>
  `;
}

function settingsPage(data) {
  const settings = data.settings;
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <div class="panel-title">Configurações</div>
          <div class="panel-subtitle">Persistidas no backend local.</div>
        </div>
      </div>
      <form id="settings-form" class="settings-grid">
        <label><span>Nome da empresa</span><input id="company-name" type="text" value="${escapeHtml(settings.general.companyName)}" /></label>
        <label><span>Timezone</span><input id="timezone" type="text" value="${escapeHtml(settings.general.timezone)}" /></label>
        <label><span>Moeda</span><input id="currency" type="text" value="${escapeHtml(settings.general.currency)}" /></label>
        <label><span>Tema</span><input id="theme" type="text" value="${escapeHtml(settings.appearance.theme)}" /></label>
      </form>
    </section>
  `;
}

function logsPage(data) {
  const webhooks = data.webhookEvents.map((item) => `
    <tr>
      <td>${escapeHtml(item.receivedAt)}</td>
      <td>${escapeHtml(item.eventType)}</td>
      <td>${escapeHtml(item.transactionId)}</td>
      <td>${escapeHtml(item.status)}</td>
      <td>${escapeHtml(item.idempotencyKey)}</td>
    </tr>
  `);
  const audits = data.auditLogs.map((item) => `
    <tr>
      <td>${escapeHtml(item.timestamp)}</td>
      <td>${escapeHtml(item.action)}</td>
      <td>${escapeHtml(item.resourceType)}</td>
      <td>${escapeHtml(item.resourceId)}</td>
    </tr>
  `);
  return `
    <section class="chart-grid">
      <article class="panel">
        <div class="panel-header"><div><div class="panel-title">Webhook events</div><div class="panel-subtitle">Payloads recebidos pelo sistema.</div></div></div>
        ${tableHtml(["Quando", "Evento", "Transaction", "Status", "Idempotência"], webhooks)}
      </article>
      <article class="panel">
        <div class="panel-header"><div><div class="panel-title">Audit log</div><div class="panel-subtitle">Ações sensíveis persistidas.</div></div></div>
        ${tableHtml(["Quando", "Ação", "Recurso", "ID"], audits)}
      </article>
    </section>
  `;
}

function renderPage() {
  const root = el("page-root");
  const data = state.data || {};
  pageTitle(state.route);
  pageControls(state.route);

  const renderers = {
    dashboard: dashboardPage,
    sales: salesPage,
    funnel: funnelPage,
    metrics: metricsPage,
    products: productsPage,
    tools: toolsPage,
    connections: connectionsPage,
    settings: settingsPage,
    logs: logsPage,
  };
  root.innerHTML = renderers[state.route](data);
  attachPageHandlers();
}

function renderLockedPage() {
  const root = el("page-root");
  if (!root) return;
  root.innerHTML = `
    <section class="panel locked-panel">
      <div class="panel-header">
        <div>
          <div class="panel-title">Dashboard bloqueado</div>
          <div class="panel-subtitle">Faça login para carregar os dados reais.</div>
        </div>
      </div>
      <div class="empty-state">O dashboard está na mesma tela. O acesso aos dados será liberado após autenticação.</div>
    </section>
  `;
}

function attachPageHandlers() {
  const refresh = el("refresh-button");
  if (refresh) refresh.onclick = loadDataAndRender;

  const source = el("source-filter");
  if (source) {
    source.onchange = () => {
      state.source = source.value;
      loadDataAndRender();
    };
  }

  const logout = el("logout-button");
  if (logout) {
    logout.onclick = async () => {
      try {
        await apiFetch("/api/auth/logout", { method: "POST", body: "{}" });
      } finally {
        stopPolling();
        state.token = "";
        state.user = null;
        state.csrfToken = "";
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem("trackroi_csrf");
        showLogin();
      }
    };
  }

  const productForm = el("product-form");
  if (productForm) {
    productForm.onsubmit = async (event) => {
      event.preventDefault();
      const name = el("product-name").value.trim();
      const priceCents = Number(el("product-price").value || 0);
      if (!name) return;
      await apiFetch("/api/products", { method: "POST", body: JSON.stringify({ name, priceCents }) });
      await loadDataAndRender();
    };
  }

  const metaConnectionForm = el("meta-connection-form");
  if (metaConnectionForm) {
    metaConnectionForm.onsubmit = async (event) => {
      event.preventDefault();
      await apiFetch("/api/integrations/meta", {
        method: "PUT",
        body: JSON.stringify({
          status: el("meta-status").value,
          adAccountId: el("meta-ad-account-id").value.trim(),
          accessToken: el("meta-access-token").value.trim(),
          lastSyncAt: new Date().toISOString(),
        }),
      });
      await loadDataAndRender();
    };
  }

  const perfectPayConnectionForm = el("perfectpay-connection-form");
  if (perfectPayConnectionForm) {
    perfectPayConnectionForm.onsubmit = async (event) => {
      event.preventDefault();
      await apiFetch("/api/integrations/perfectpay", {
        method: "PUT",
        body: JSON.stringify({
          status: el("perfectpay-status").value,
          webhookSecret: el("perfectpay-webhook-secret").value.trim(),
          webhookUrl: el("perfectpay-webhook-url").value.trim(),
          webhookStatus: "configured",
          apiStatus: "configured",
        }),
      });
      await loadDataAndRender();
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
      const payload = {
        general: {
          companyName: el("company-name").value.trim(),
          timezone: el("timezone").value.trim(),
          currency: el("currency").value.trim(),
        },
        appearance: {
          theme: el("theme").value.trim(),
        },
      };
      await apiFetch("/api/settings", { method: "PUT", body: JSON.stringify(payload) });
      await loadDataAndRender();
    };
  }

  const saveSettingsButton = el("save-settings-button");
  if (saveSettingsButton) {
    saveSettingsButton.onclick = () => {
      const form = el("settings-form");
      if (form) form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    };
  }

  const clickForm = el("click-form");
  if (clickForm) {
    clickForm.onsubmit = async (event) => {
      event.preventDefault();
      await apiFetch("/api/dev/click", {
        method: "POST",
        body: JSON.stringify({
          trackroi_click_id: el("click-trackroi").value.trim(),
          source: el("click-source").value.trim(),
        }),
      });
      await loadDataAndRender();
    };
  }

  const webhookForm = el("webhook-form");
  if (webhookForm) {
    webhookForm.onsubmit = async (event) => {
      event.preventDefault();
      await apiFetch("/api/webhooks/perfectpay", {
        method: "POST",
        body: JSON.stringify({
          transaction_id: el("webhook-transaction").value.trim() || `tx_${Date.now()}`,
          event_type: el("webhook-event").value.trim() || "approved",
          amount_cents: Number(el("webhook-amount").value || 0),
          currency: "BRL",
        }),
      });
      await loadDataAndRender();
    };
  }

  const spendForm = el("spend-form");
  if (spendForm) {
    spendForm.onsubmit = async (event) => {
      event.preventDefault();
      await apiFetch("/api/dev/spend", {
        method: "POST",
        body: JSON.stringify({
          source: el("spend-source").value.trim(),
          amountCents: Number(el("spend-amount").value || 0),
        }),
      });
      await loadDataAndRender();
    };
  }
}

async function loadDataAndRender() {
  state.loading = true;
  setStatus("Carregando dados...");
  try {
    const [dashboard, sales, clicks, checkouts, products, settings, integrations, auditLogs, webhookEvents] = await Promise.all([
      apiFetch(`/api/dashboard?source=${encodeURIComponent(state.source)}`),
      apiFetch("/api/sales"),
      apiFetch("/api/clicks"),
      apiFetch("/api/checkouts"),
      apiFetch("/api/products"),
      apiFetch("/api/settings"),
      apiFetch("/api/integrations"),
      apiFetch("/api/audit-logs"),
      apiFetch("/api/webhook-events"),
    ]);

    state.data = {
      ...dashboard,
      sales: sales.items,
      clicks: clicks.items,
      checkouts: checkouts.items,
      products: products.items,
      settings: settings.settings,
      integrations: integrations.items,
      auditLogs: auditLogs.items,
      webhookEvents: webhookEvents.items,
    };
    state.loading = false;
    renderPage();
    setStatus(dashboard.empty ? "Nenhum dado real conectado ainda. O painel está exibindo um estado vazio honesto." : `Dados carregados: ${dashboard.summary.totalSales} vendas e ${dashboard.summary.clickCount} cliques.`);
  } catch (error) {
    state.loading = false;
    if (error.message === "AUTH_REQUIRED") {
      showLogin();
      return;
    }
    setStatus(`Falha ao carregar dados: ${error.message}`);
  }
}

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
  if (state.csrfToken) localStorage.setItem("trackroi_csrf", state.csrfToken);
  showApp();
  startPolling();
  await loadDataAndRender();
}

async function register(name, email, password) {
  const result = await apiFetch("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name, email, password }),
    headers: { "Content-Type": "application/json" },
  });
  state.token = result.token;
  state.user = result.user;
  state.csrfToken = result.csrfToken || "";
  localStorage.setItem(TOKEN_KEY, result.token);
  if (state.csrfToken) localStorage.setItem("trackroi_csrf", state.csrfToken);
  showApp();
  startPolling();
  await loadDataAndRender();
}

let pollingTimer = null;

function startPolling() {
  stopPolling();
  pollingTimer = setInterval(() => {
    if (state.token && state.user && !state.loading) {
      loadDataAndRender();
    }
  }, 30000);
}

function stopPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

async function bootstrap() {
  mountSidebarIcons();
  applySidebarState();

  el("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    setLoginError("");
    try {
      await login(el("email-input").value.trim(), el("password-input").value);
    } catch (error) {
      setLoginError(error.message === "AUTH_REQUIRED" ? "Faça login novamente." : error.message);
    }
  });

  el("register-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    setRegisterError("");
    const name = el("register-name").value.trim();
    const email = el("register-email").value.trim();
    const password = el("register-password").value;
    const confirm = el("register-password-confirm").value;
    if (!name || !email || !password) {
      setRegisterError("Preencha todos os campos.");
      return;
    }
    if (password.length < 6) {
      setRegisterError("A senha deve ter pelo menos 6 caracteres.");
      return;
    }
    if (password !== confirm) {
      setRegisterError("As senhas não coincidem.");
      return;
    }
    try {
      await register(name, email, password);
    } catch (error) {
      setRegisterError(error.message === "AUTH_REQUIRED" ? "Faça login novamente." : error.message);
    }
  });

  el("go-register").addEventListener("click", (event) => {
    event.preventDefault();
    showRegister();
  });

  el("go-login").addEventListener("click", (event) => {
    event.preventDefault();
    showLogin();
  });

  window.addEventListener("hashchange", async () => {
    state.route = normalizeRoute(location.hash.slice(1) || "dashboard");
    updateNav();
    if (state.data) renderPage();
  });

  if (state.token) {
    try {
      const me = await apiFetch("/api/auth/me");
      state.user = me.user;
      state.csrfToken = me.csrfToken || "";
      localStorage.setItem("trackroi_csrf", state.csrfToken);
      showApp();
      startPolling();
      await loadDataAndRender();
      return;
    } catch {
      state.token = "";
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem("trackroi_csrf");
    }
  }

  const sidebarToggle = el("sidebar-toggle");
  if (sidebarToggle) {
    sidebarToggle.addEventListener("click", () => {
      state.sidebarExpanded = !state.sidebarExpanded;
      applySidebarState();
    });
  }

  let hasUsers = true;
  try {
    const status = await apiFetch("/api/auth/status");
    hasUsers = Boolean(status.hasUsers);
  } catch {
    hasUsers = true;
  }

  if (hasUsers) {
    showLogin();
  } else {
    showRegister();
  }
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

function iconTools() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 6.3a5 5 0 0 0-6.7 6.7L4 17v3h3l4-4a5 5 0 0 0 6.7-6.7l-2.8 2.8-2.1-.4-.4-2.1 2.3-2.3Zm-7.5 9.9-1.1 1.1v.7h.7l1.1-1.1-.7-.7Z"/></svg>';
}

function iconConnections() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4a4 4 0 0 0-3.7 5.5L12 18.2l8.7-8.7A4 4 0 0 0 17 4a3.9 3.9 0 0 0-3 1.4L12 8.1 10 5.4A3.9 3.9 0 0 0 7 4Zm0 2a2 2 0 0 1 1.6.8L12 11.7l3.4-4.9A2 2 0 0 1 19 7a2 2 0 0 1-.6 1.4L12 14.8 5.6 8.4A2 2 0 0 1 7 6Z"/></svg>';
}

function iconSettings() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2 1.2 2.7 3 .6 1.7 2.4-1.1 2.9 1.1 2.9-1.7 2.4-3 .6L12 22l-1.2-2.7-3-.6-1.7-2.4 1.1-2.9-1.1-2.9 1.7-2.4 3-.6L12 2Zm0 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/></svg>';
}

function iconGear() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 1.75 1.08 2.42 2.56.5 1.5 2.14-.83 2.52.83 2.51-1.5 2.15-2.56.5L12 16.25l-1.08-2.26-2.56-.5-1.5-2.15.83-2.51-.83-2.52 1.5-2.14 2.56-.5L12 1.75Zm0 5.25a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"/></svg>';
}

function iconLogs() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l5 5v13H6V3Zm8 1.5V9h4.5L14 4.5ZM8 12h8v2H8v-2Zm0 4h8v2H8v-2Z"/></svg>';
}

function iconLogout() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4v-2H6V7h4V5Zm4.3 3.3-1.4 1.4 2.3 2.3H8v2h7.2l-2.3 2.3 1.4 1.4L19 12l-4.7-4.7Z"/></svg>';
}

document.addEventListener("DOMContentLoaded", bootstrap);
