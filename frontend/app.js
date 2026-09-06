const API_BASE = window.__API_BASE__ || "";
const TOKEN_KEY = "trackroi_token";
const CSRF_KEY = "trackroi_csrf";

function loadPeriod() {
  try {
    const saved = JSON.parse(localStorage.getItem("trackroi_period") || '{"key":"30d"}');
    if (saved && typeof saved.key === "string") {
      return { key: saved.key, from: typeof saved.from === "string" ? saved.from : "", to: typeof saved.to === "string" ? saved.to : "" };
    }
  } catch {
    /* ignora */
  }
  return { key: "30d", from: "", to: "" };
}

function persistPeriod() {
  localStorage.setItem("trackroi_period", JSON.stringify(state.period));
}

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  csrfToken: localStorage.getItem(CSRF_KEY) || "",
  user: null,
  route: normalizeRoute(location.hash.slice(1) || "dashboard"),
  source: "all",
  period: loadPeriod(),
  routeData: null,
  dataCache: {},
  loading: false,
  settings: null,
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

function pixelErrorMarkup(error) {
  const message = escapeHtml(friendlyError(error));
  const debug = error?.debug;
  if (!debug || (!debug.message && !debug.code)) return `<span>${message}</span>`;
  const lines = [
    debug.message ? `Mensagem: ${escapeHtml(debug.message)}` : null,
    debug.code ? `Código: ${escapeHtml(String(debug.code))}` : null,
    debug.type ? `Tipo: ${escapeHtml(debug.type)}` : null,
    debug.subcode ? `Subcódigo: ${escapeHtml(String(debug.subcode))}` : null,
    debug.fbtrace_id ? `FB Trace: ${escapeHtml(debug.fbtrace_id)}` : null,
  ].filter(Boolean);
  return `
    <span>${message}</span>
    <details class="error-debug"><summary><small>detalhes técnicos</small></summary><small>${lines.join("<br>")}</small></details>
  `;
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
    const error = new Error(body.error || `Erro ao processar a solicitação`);
    if (body.debug && (body.debug.message || body.debug.code)) error.debug = body.debug;
    throw error;
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

/* ------------------------------------------------------------- Notificações */

const NOTIFICATION_ASSET_VERSION = 3;
const notificationAssets = {
  sound: `${API_BASE || ""}/notificacao/notificacao.mp3?v=${NOTIFICATION_ASSET_VERSION}`,
  icon: `${API_BASE || ""}/notificacao/logo.notif.png?v=${NOTIFICATION_ASSET_VERSION}`,
};
let notificationAudio = null;

function notificationsSupported() {
  return typeof Notification !== "undefined" && "Notification" in window;
}

function notificationSoundEnabled() {
  return (state.settings?.notification || {}).sound !== false;
}

function notificationBrowserEnabled() {
  return (state.settings?.notification || {}).browser !== false;
}

async function refreshNotificationSettings() {
  try {
    const result = await apiFetch("/api/settings");
    state.settings = result.settings || {};
  } catch {
    /* settings não disponível ainda */
  }
}

function prepareNotificationSound() {
  try {
    const unlock = new Audio(notificationAssets.sound);
    unlock.volume = 0;
    unlock.muted = true;
    const play = unlock.play();
    if (play && play.catch) play.catch(() => {});
  } catch {
    /* ignora bloqueio de autoplay */
  }
  try {
    const prime = new Image();
    prime.src = notificationAssets.icon;
  } catch {
    /* ignora */
  }
}

function playNotificationSound() {
  if (!notificationSoundEnabled()) return;
  try {
    if (!notificationAudio) notificationAudio = new Audio(notificationAssets.sound);
    notificationAudio.volume = 0.8;
    notificationAudio.currentTime = 0;
    const play = notificationAudio.play();
    if (play && play.catch) play.catch(() => {});
  } catch {
    /* ignora */
  }
}

function showToastNotification({ title, body }) {
  let root = document.getElementById("toast-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "toast-root";
    root.className = "toast-root";
    document.body.appendChild(root);
  }
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `
    <img class="toast-logo" src="${notificationAssets.icon}" alt="" />
    <div class="toast-text">
      <div class="toast-title">${escapeHtml(title)}</div>
      <div class="toast-body">${escapeHtml(body)}</div>
    </div>
  `;
  root.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("visible"));
  setTimeout(() => {
    toast.classList.remove("visible");
    setTimeout(() => toast.remove(), 350);
  }, 5000);
}

function showSaleNotification({ title, body }) {
  showToastNotification({ title, body });
  if (!notificationBrowserEnabled()) return;
  if (!notificationsSupported() || Notification.permission !== "granted") return;
  try {
    const notification = new Notification(title, {
      body,
      icon: notificationAssets.icon,
      badge: notificationAssets.icon,
      tag: `trackroi-${Date.now()}`,
      silent: true,
      renotify: false,
    });
    notification.onclick = () => {
      try {
        window.focus();
        notification.close();
      } catch {
        /* ignora */
      }
    };
    setTimeout(() => {
      try {
        notification.close();
      } catch {
        /* ignora */
      }
    }, 15000);
    playNotificationSound();
  } catch {
    playNotificationSound();
  }
}

function renderNotificationModal() {
  const existing = document.getElementById("notification-modal");
  if (existing) existing.remove();
  const modal = document.createElement("div");
  modal.id = "notification-modal";
  modal.className = "modal-overlay visible";
  modal.innerHTML = `
    <div class="modal-box">
      <img class="modal-logo" src="${notificationAssets.icon}" alt="TrackROI" />
      <h3>Receba alertas de vendas</h3>
      <p>Permita as notificações para ser avisado em tempo real, com som, sempre que uma venda for gerada ou aprovada (como notificação do Windows).</p>
      <div class="modal-actions">
        <button type="button" id="notification-allow" class="btn-primary">Permitir notificações</button>
        <button type="button" id="notification-later" class="btn-secondary">Agora não</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  el("notification-allow").onclick = async () => {
    localStorage.setItem("trackroi_notif_asked", "1");
    const result = await Notification.requestPermission();
    modal.remove();
    if (result === "granted") {
      prepareNotificationSound();
      showSaleNotification({ title: "Venda aprovada", body: "Sua comissão > R$ 0,00 · isso foi um teste de som" });
    } else {
      setStatus("Notificações bloqueadas. Ative nas configurações do seu navegador para receber alertas de vendas.", "error");
    }
  };
  el("notification-later").onclick = () => {
    localStorage.setItem("trackroi_notif_asked", "1");
    modal.remove();
  };
}

function askNotificationPermission() {
  if (!notificationsSupported()) return;
  if (Notification.permission === "granted") {
    prepareNotificationSound();
    showSaleNotification({ title: "Venda aprovada", body: "Sua comissão > R$ 0,00 · isso foi um teste de som" });
    return;
  }
  if (Notification.permission === "denied") {
    setStatus("Notificações bloqueadas. Ative nas configurações do seu navegador para receber alertas de vendas.", "error");
    return;
  }
  const alreadyAsked = localStorage.getItem("trackroi_notif_asked") === "1";
  if (alreadyAsked) return;
  renderNotificationModal();
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
  showAuthForm("login");
  el("email-input").value = "";
  el("password-input").value = "";
  setLoginError("");
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
  if (drawerSetOpen) drawerSetOpen(false);
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

/* --------------------------------------------------- Responsive shell (mobile) */

function debounce(fn, ms = 160) {
  let token = null;
  return (...args) => {
    clearTimeout(token);
    token = setTimeout(() => fn(...args), ms);
  };
}

function prepareResponsiveTables(root = document) {
  root.querySelectorAll(".table-wrap").forEach((wrap) => {
    const table = wrap.querySelector("table");
    if (!table) return;
    const headers = Array.from(table.querySelectorAll("thead th")).map((th) => th.textContent.trim());
    table.querySelectorAll("tbody tr").forEach((row) => {
      row.querySelectorAll("td").forEach((cell, index) => {
        if (headers[index]) cell.setAttribute("data-label", headers[index]);
        const text = (cell.textContent || "").replace(/\s+/g, " ").trim();
        if (text && !cell.hasAttribute("title")) cell.setAttribute("title", text);
      });
    });
  });
}

let drawerSetOpen = null;

function mountResponsiveShell() {
  const app = el("app-view");
  if (!app) return;
  const backdrop = el("drawer-backdrop");
  const menu = el("mobile-menu-button");
  const setOpen = (open) => {
    app.classList.toggle("drawer-open", open);
    if (menu) menu.setAttribute("aria-expanded", open ? "true" : "false");
  };
  drawerSetOpen = setOpen;
  if (menu) {
    menu.onclick = () => setOpen(!app.classList.contains("drawer-open"));
  }
  if (backdrop) backdrop.onclick = () => setOpen(false);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setOpen(false);
  });

  const sidebar = document.querySelector(".sidebar");
  let touchStart = null;
  if (sidebar) {
    sidebar.addEventListener("touchstart", (event) => {
      const point = event.touches && event.touches[0];
      if (point) touchStart = { x: point.clientX, y: point.clientY };
    }, { passive: true });
    sidebar.addEventListener("touchend", (event) => {
      if (!touchStart) return;
      const point = event.changedTouches && event.changedTouches[0];
      if (point) {
        const dx = point.clientX - touchStart.x;
        const dy = point.clientY - touchStart.y;
        if (Math.abs(dy) < Math.abs(dx) && dx < -40) setOpen(false);
      }
      touchStart = null;
    }, { passive: true });
  }

  window.addEventListener("hashchange", () => setOpen(false));
  window.addEventListener("resize", debounce(() => {
    if (window.innerWidth >= 1024) setOpen(false);
  }));
}

/* ------------------------------------------------------------- Data loading */

const routeFetch = {
  dashboard: () => apiFetch(`/api/dashboard?${dashboardQuery()}`),
  funnel: () => apiFetch(`/api/dashboard?${dashboardQuery()}`),
  metrics: () => apiFetch(`/api/dashboard?${dashboardQuery()}`),
  sales: async () => {
    const sales = await apiFetch("/api/sales");
    return { ok: true, sales: sales.items || [], pagination: sales.pagination };
  },
  products: async () => {
    const products = await apiFetch("/api/products");
    return { ok: true, products: products.items || [] };
  },
  connections: async () => {
    const [integrations, imports, pixel] = await Promise.all([
      apiFetch("/api/integrations"),
      apiFetch("/api/imports"),
      apiFetch("/api/pixel"),
    ]);
    return { ok: true, integrations: integrations.items || [], imports: imports.items || [], pixel: pixel.pixel || null };
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
  if (message.notification && message.notification.title) {
    showSaleNotification({ title: message.notification.title, body: message.notification.body });
  }
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
  setButtonLoading(button, "Verificando…");
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

async function syncProvider(providerId, button) {
  setButtonLoading(button, "Sincronizando…");
  try {
    const result = await apiFetch(`/api/integrations/${providerId}/sync`, { method: "POST", body: "{}" });
    setButtonLoading(button, "");
    const days = Number(result.days || 0);
    showConnectMessage(providerId, `Sincronizado ${days} ${days === 1 ? "dia" : "dias"} de ${escapeHtml(result.account || "sua conta")}. Dashboard atualizado.`, "success");
    await loadData("connections", { silent: true });
  } catch (error) {
    setButtonLoading(button, "");
    showConnectMessage(providerId, friendlyError(error), "error");
    await loadData("connections", { silent: true });
  }
}

async function disconnectProvider(providerId, button) {
  const labels = { meta: "Meta Ads", perfectpay: "Perfect Pay" };
  const name = labels[providerId] || providerId;
  if (!window.confirm(`Desconectar ${name}? Os dados importados serão mantidos, mas a conexão será removida.`)) return;
  setButtonLoading(button, "Desconectando…");
  try {
    await apiFetch(`/api/integrations/${providerId}`, { method: "DELETE" });
    setStatus(`${name} desconectado.`, "success");
    await loadData(state.route, { silent: true });
  } catch (error) {
    setStatus(friendlyError(error), "error");
  } finally {
    setButtonLoading(button, "");
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
          const hint = card.hint ? `<div class="metric-hint" title="${escapeHtml(card.hint)}">${escapeHtml(card.hint)}</div>` : "";
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
  const padPct = (pad / W) * 100;
  const innerPct = (100 - padPct * 2) / n;
  const legendCols = `${padPct.toFixed(3)}%${stages.map(() => ` ${innerPct.toFixed(3)}%`).join("")} ${padPct.toFixed(3)}%`;
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

function dashboardQuery() {
  const parts = [`source=${encodeURIComponent(state.source)}`, `period=${encodeURIComponent(state.period.key)}`];
  if (state.period.key === "custom" && state.period.from && state.period.to) {
    parts.push(`from=${encodeURIComponent(state.period.from)}`, `to=${encodeURIComponent(state.period.to)}`);
  }
  return parts.join("&");
}

function clearDashboardCache() {
  state.dataCache.dashboard = null;
  state.dataCache.funnel = null;
  state.dataCache.metrics = null;
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
  const periodSelect = `
    <label class="select-wrap">
      <span>Período</span>
      <select id="period-filter">
        <option value="today" ${state.period.key === "today" ? "selected" : ""}>Hoje</option>
        <option value="yesterday" ${state.period.key === "yesterday" ? "selected" : ""}>Ontem</option>
        <option value="7d" ${state.period.key === "7d" ? "selected" : ""}>Últimos 7 dias</option>
        <option value="30d" ${state.period.key === "30d" ? "selected" : ""}>Últimos 30 dias</option>
        <option value="custom" ${state.period.key === "custom" ? "selected" : ""}>Personalizado</option>
      </select>
    </label>
  `;
  const customDates = state.period.key === "custom"
    ? `
      <label class="select-wrap"><span>De</span><input id="period-from" type="date" value="${escapeHtml(state.period.from || "")}" /></label>
      <label class="select-wrap"><span>Até</span><input id="period-to" type="date" value="${escapeHtml(state.period.to || "")}" /></label>
    `
    : "";
  const routeControls = {
    dashboard: `${periodSelect}${customDates}${sourceSelect}${refresh}`,
    funnel: `${periodSelect}${customDates}${sourceSelect}${refresh}`,
    metrics: `${periodSelect}${customDates}${sourceSelect}${refresh}`,
    sales: refresh,
    products: `<button id="product-create-button" type="button">Novo produto</button>${refresh}`,
    connections: refresh,
    settings: `<button id="save-settings-button" type="button">Salvar</button>${refresh}`,
    logs: refresh,
  };
  controls.innerHTML = routeControls[route] || refresh;
  mobilePageActions(route);
}

function mobilePageActions(route) {
  const actions = el("mobile-page-actions");
  if (!actions) return;
  const refresh = `<button id="mobile-refresh-button" type="button" class="ghost" aria-label="Atualizar">↻</button>`;
  if (route === "settings") {
    actions.innerHTML = `<button id="mobile-save-settings-button" type="button">Salvar</button>`;
  } else if (route === "products") {
    actions.innerHTML = `<button id="mobile-product-create-button" type="button">Novo</button>${refresh}`;
  } else {
    actions.innerHTML = refresh;
  }
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
  const mobileTitle = el("mobile-page-title");
  if (mobileTitle) mobileTitle.textContent = title;
}

function emptyDashboard() {
  return `
    <section class="onboarding">
      <div class="onboarding-orb"></div>
      <h3>Bem-vindo ao TrackROI</h3>
      <p>Importe a planilha exportada do Gerenciador de Anúncios e o seu painel começa a se preencher automaticamente.</p>
      <div class="onboarding-actions">
        <a class="btn-primary" href="#connections">Importar planilha</a>
        <a class="btn-ghost" href="#metrics">Ver métricas</a>
      </div>
    </section>
  `;
}

function dashboardPage(data) {
  const hasData = data && data.empty === false;
  const nf = new Intl.NumberFormat("pt-BR");
  const periodLabel = data.filters?.period?.label ? `${data.filters.period.label} · ` : "";
  const funnelSub = data.funnel?.stages?.length
    ? data.funnel.stages.map((stage) => `${nf.format(stage.count)} ${stage.label.toLowerCase()}`).join(" · ")
    : "Cliques, visitas, checkouts e vendas.";
  const body = hasData
    ? `
      ${renderMetricCards(data.cards || [])}
      ${sectionPanel("Funil de conversão", `${periodLabel}${funnelSub}`, uvFunnelHtml(data.funnel))}
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
  const f = summary.finance || {};
  const nf = new Intl.NumberFormat("pt-BR");
  const pct = (value) => (value == null ? "0,0%" : `${(value * 100).toFixed(1).replace(".", ",")}%`);
  const ratioText = (value) => (value == null ? "0,00" : nf.format(Number(value).toFixed(2)));
  const items = [
    ["Investimento em Ads", money(f.adSpendCents)],
    ["Receita aprovada", money(f.revenueCents)],
    ["Lucro bruto", money(f.grossProfitCents)],
    ["Custos de trabalho", money(f.laborCostCents)],
    ["Lucro operacional", money(f.operatingProfitCents)],
    ["ROAS médio", ratioText(f.roas)],
    ["ROI médio", pct(f.roi)],
    ["CPA médio", money(f.cpa == null ? 0 : f.cpa * 100)],
    ["AOV (ticket médio)", money(f.aov == null ? 0 : f.aov * 100)],
    ["Vendas aprovadas", nf.format(f.approved || 0)],
    ["Pendentes", nf.format(f.pending || 0)],
    ["Cliques", nf.format(f.clicks || 0)],
    ["Checkouts iniciados", nf.format(f.checkouts || 0)],
    ["Taxa de conversão", pct(f.cvr)],
    ["Dias no período", nf.format(f.days || 0)],
  ];
  return `
    <div class="info-grid">
      ${items.map(([label, value]) => `<div class="info-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`).join("")}
    </div>
  `;
}

function metricsPage(data) {
  const summary = data.summary || {};
  const periodLabel = summary.period?.label
    ? `Período: ${summary.period.label} · calculado com dados reais do período`
    : "Indicadores calculados automaticamente.";
  const trend = data.trend || null;
  const hasTrend = Boolean(
    trend &&
      Array.isArray(trend.points) &&
      trend.points.length > 0 &&
      !(trend.totals && trend.totals.empty)
  );
  const evolution = hasTrend
    ? sectionPanel("Evolução no período", "Investimento, receita e lucro por dia — do seu próprio histórico.", trendChartHtml(trend))
    : sectionPanel("Evolução no período", "O gráfico aparece aqui assim que houver dados de investimento, cliques ou vendas.", metricsEmptyStateHtml(data.empty === true));
  return `
    ${renderMetricCards(data.cards || [])}
    ${sectionPanel("Resumo detalhado", periodLabel, metricsSummary(summary))}
    ${evolution}
  `;
}

function shortMoney(cents) {
  const value = Math.round(Number(cents) || 0);
  const nf = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
  if (value >= 1000000) return `R$ ${nf.format(value / 1000000)} mi`;
  if (value >= 1000) return `R$ ${nf.format(value / 1000)} mil`;
  return money(value);
}

function trendChartHtml(trend) {
  const points = trend.points || [];
  const n = points.length;
  const W = 920;
  const H = 260;
  const padL = 10;
  const padR = 10;
  const padT = 14;
  const padB = 26;
  const plotH = H - padT - padB;
  const baseline = H - padB;
  const maxVal = Math.max(...points.map((p) => Math.max(p.spendCents, p.revenueCents, Math.max(0, p.profitCents))), 1);
  const xAt = (i) => (n > 1 ? padL + (i / (n - 1)) * (W - padL - padR) : padL);
  const yAt = (v) => baseline - (Math.max(0, Number(v) || 0) / maxVal) * plotH;

  const spendPts = points.map((p, i) => [xAt(i), yAt(p.spendCents)]);
  const revPts = points.map((p, i) => [xAt(i), yAt(p.revenueCents)]);
  const profitPts = points.map((p, i) => {
    const y = yAt(p.profitCents);
    return [xAt(i), y > baseline ? baseline : y];
  });

  const spendLine = curveThrough(spendPts);
  const revArea = `${revPts[0][0].toFixed(1)} ${baseline} L ${curveThrough(revPts).slice(1)} L ${revPts[n - 1][0].toFixed(1)} ${baseline} Z`;
  const profitArea = `${profitPts[0][0].toFixed(1)} ${baseline} L ${curveThrough(profitPts).slice(1)} L ${profitPts[n - 1][0].toFixed(1)} ${baseline} Z`;

  const fmtDay = (iso) => {
    const date = new Date(`${iso}T12:00:00Z`);
    return Number.isNaN(date.getTime())
      ? iso
      : date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  };
  const firstLabel = fmtDay(points[0].date);
  const midLabel = n > 2 ? fmtDay(points[Math.floor((n - 1) / 2)].date) : "";
  const lastLabel = fmtDay(points[n - 1].date);
  const midX = n > 2 ? (xAt(Math.floor((n - 1) / 2)) + xAt(n - 1)) / 2 : W - padR;

  const smoothAxis = [0, Math.round(maxVal / 2), maxVal];

  const yTicks = smoothAxis
    .map((val, i) => {
      const y = yAt(val);
      if (i > 0 && yAt(smoothAxis[i - 1]) - y < 8) return "";
      return `
        <line class="trend-grid-line" x1="${padL}" y1="${y.toFixed(1)}" x2="${(W - padR).toFixed(1)}" y2="${y.toFixed(1)}" />
        <text class="trend-axis" x="${(W - padR - 4).toFixed(1)}" y="${(y - 5).toFixed(1)}" text-anchor="end">${val > 0 ? shortMoney(val) : "0"}</text>
      `;
    })
    .join("");

  const legend = `
    <ul class="trend-legend">
      <li><span class="trend-swatch green"></span>Receita aprovada</li>
      <li><span class="trend-swatch violet"></span>Investimento</li>
      <li><span class="trend-swatch muted"></span>Lucro</li>
    </ul>
  `;

  const xLabels = `
    <text class="trend-axis trend-axis-label" x="${padL}" y="${(H - 6).toFixed(1)}" text-anchor="start">${firstLabel}</text>
    ${midLabel ? `<text class="trend-axis trend-axis-label" x="${midX.toFixed(1)}" y="${(H - 6).toFixed(1)}" text-anchor="middle">${midLabel}</text>` : ""}
    <text class="trend-axis trend-axis-label" x="${(W - padR).toFixed(1)}" y="${(H - 6).toFixed(1)}" text-anchor="end">${lastLabel}</text>
  `;

  const dots = revPts
    .map(([x, y], i) => `<circle class="trend-dot" style="color:var(--green)" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.4" title="${fmtDay(points[i].date)}: ${money(points[i].revenueCents)}">`)
    .join("");

  const totals = trend.totals || {};
  const totalChips = `
    <div class="trend-totals">
      <span class="trend-total">Investimento<strong>${money(totals.spendCents)}</strong></span>
      <span class="trend-total">Receita aprovada<strong>${money(totals.revenueCents)}</strong></span>
      <span class="trend-total">Lucro bruto<strong>${money(totals.revenueCents - totals.refundCents - totals.spendCents)}</strong></span>
      <span class="trend-total">Cliques<strong>${new Intl.NumberFormat("pt-BR").format(totals.clicks)}</strong></span>
    </div>
  `;

  return `
    ${legend}
    <div class="trend-stage">
      <svg class="trend-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolução de investimento, receita e lucro no período">
        ${yTicks}
        <path class="trend-area-profit" d="${profitArea}" fill="rgba(255,255,255,0.5)" />
        <path class="trend-area" d="${revArea}" fill="var(--green)" />
        <path class="trend-line violet" d="${spendLine}" />
        <path class="trend-line green" d="${curveThrough(revPts)}" />
        <path class="trend-line muted" d="${curveThrough(profitPts)}" stroke-dasharray="4 5" />
        ${dots}
        ${xLabels}
      </svg>
    </div>
    ${totalChips}
  `;
}

function metricsEmptyStateHtml(noData) {
  const copy = noData
    ? "Importe as planilhas do Gerenciador de Anúncios e do seu gateway de pagamento. Assim que os primeiros dados chegarem, o gráfico de evolução (investimento, receita e lucro por dia) aparece aqui automaticamente."
    : "Esse período ainda não tem dados com datas distribuídas. Exporte e importe novamente, ou troque o período acima — o gráfico de evolução se preenche sozinho.";
  return `
    <div class="trend-empty">
      <div class="trend-empty-icon">
        <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 17 8 11l4 4 9-9" />
          <path d="M15 6h6v6" />
        </svg>
      </div>
      <h3>Aguardando dados</h3>
      <p>${copy}</p>
      <div class="trend-empty-actions">
        <a class="btn-primary" href="#connections">Importar planilha</a>
        <button type="button" class="btn-ghost" data-refresh-chart>Atualizar</button>
      </div>
    </div>
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

function connectedSummaryHtml(item) {
  const nf = new Intl.NumberFormat("pt-BR");
  const account = item.connectedAccount || item.adAccountId || "conta conectada";
  const lastSync = item.lastSyncAt ? formatDateTime(item.lastSyncAt) : "—";
  const lastEvent = item.lastReceivedEventAt ? formatDateTime(item.lastReceivedEventAt) : null;
  const failures = Array.isArray(item.errors) && item.errors.length ? item.errors.length : 0;
  const imports = item.importsCount != null ? nf.format(item.importsCount) : null;
  return `
    <div class="conn-summary">
      <div class="conn-health"><span class="conn-health-dot"></span>Conectado e saudável</div>
      <div class="conn-account">${escapeHtml(account)}</div>
      <div class="conn-stats">
        <span>Última sincronização: <b>${escapeHtml(lastSync)}</b></span>
        ${imports ? `<span>Importações: <b>${escapeHtml(imports)}</b></span>` : ""}
        ${lastEvent ? `<span>Último evento: <b>${escapeHtml(lastEvent)}</b></span>` : ""}
        <span>Falhas recentes: <b class="${failures > 0 ? "is-warn" : ""}">${failures}</b></span>
      </div>
    </div>
  `;
}

function pixelCardHtml(pixel) {
  const connected = !!(pixel && pixel.connected);
  const body = connected
    ? `
      <div class="conn-summary">
        <div class="conn-health"><span class="conn-health-dot"></span>Pixel conectado</div>
        <div class="conn-account">Pixel ${escapeHtml(pixel.pixelId)}</div>
        <div class="conn-stats">
          <span>Token: <b>•••• armazenado (somente leitura)</b></span>
          ${pixel.lastTestEventAt ? `<span>Último teste: <b>${escapeHtml(formatDateTime(pixel.lastTestEventAt))}</b></span>` : ""}
          ${pixel.lastSyncAt ? `<span>Última venda enviada: <b>${escapeHtml(formatDateTime(pixel.lastSyncAt))}</b></span>` : ""}
        </div>
      </div>
      <div class="connection-message" data-pixel-message hidden></div>
      <div class="connection-actions">
        <form id="pixel-test-form" class="inline-form compact-form">
          <input id="pixel-test-code" type="text" placeholder="Código de teste (opcional)" autocomplete="off" />
          <button type="submit" class="btn-primary">Testar Pixel</button>
          <span class="import-status" id="pixel-test-status"></span>
        </form>
      </div>
      <div class="connection-actions">
        <button type="button" class="ghost danger" id="pixel-disconnect-button">Desconectar</button>
      </div>
    `
    : `
      <div class="connection-line">Conecte o seu próprio Meta Pixel para enviar cada venda aprovada direto para a API de Conversões — sem depender de OAuth nem de revisão do Facebook.</div>
      <form id="pixel-form" class="stack-form compact-form">
        <label><span>ID do Pixel</span><input id="pixel-id" type="text" placeholder="Ex.: 123456789012345" autocomplete="off" /></label>
        <label><span>Token de acesso do Conversions API</span><input id="pixel-token" type="password" placeholder="Gerado em Gerenciador de Eventos" autocomplete="new-password" /></label>
        <p class="form-hint">Vá em <b>Gerenciador de Eventos → seu Pixel → Configurações → API de Conversões → Gerar token de acesso</b> e cole aqui. A configuração é validada na Meta antes de salvar.</p>
        <div class="connection-actions">
          <button type="submit" class="btn-primary">Conectar Pixel</button>
          <span class="import-status" id="pixel-status"></span>
        </div>
      </form>
      <div class="connection-message" data-pixel-message hidden></div>
    `;
  return `
    <article class="connection-card ${connected ? "is-connected" : ""}">
      <div class="connection-card-head">
        <div class="connection-logo">P</div>
        <div class="connection-card-title">
          <div class="connection-name">Meta Pixel</div>
          <div class="connection-desc">Conversões (CAPI) da sua loja</div>
        </div>
        ${statusPill(connected ? "connected" : "configured")}
      </div>
      <div class="connection-card-body">
        ${body}
      </div>
    </article>
  `;
}

function connectionCard(item) {
  const connected = item.connected === true;
  const status = connected || item.status === "connected" ? "connected" : item.status || "not_connected";
  const notConfigured = item.configured === false;
  const isMeta = item.id === "meta";
  const connectAction = notConfigured
    ? `<span class="ghost" disabled>Configuração pendente</span>`
    : `<button type="button" class="btn-primary" data-connect-button="${escapeHtml(item.id)}">${isMeta ? (connected ? "Reconectar" : "Conectar Meta Ads") : "Configurar webhook"}</button>`;
  const actions = `
      ${connectAction}
      ${isMeta && connected ? `<button type="button" class="ghost" data-sync-button="${escapeHtml(item.id)}">Sincronizar agora</button>` : ""}
      ${connected ? `<button type="button" class="ghost danger" data-disconnect-button="${escapeHtml(item.id)}">Desconectar</button>` : ""}
      <button type="button" class="ghost" data-test-button="${escapeHtml(item.id)}">Testar conexão</button>
    `;
  const body = isMeta
    ? `
      ${connected
        ? connectedSummaryHtml(item)
        : `<div class="connection-line">Conecte sua conta do Facebook em um clique para importar gastos, cliques e campanhas dos seus anúncios automaticamente.</div>`}
      <div class="connection-message" data-connect-message="${escapeHtml(item.id)}" hidden></div>
      <div class="connection-actions">${actions}</div>
      <details class="import-fallback">
        <summary><span class="advanced-title">Importar arquivo CSV manualmente</span><span class="advanced-caret"></span></summary>
        ${importPanelHtml(item)}
      </details>
    `
    : `
      ${connected
        ? connectedSummaryHtml(item)
        : `<div class="connection-line">
            ${notConfigured
              ? "Integração ainda não configurada pelo administrador."
              : escapeHtml(item.healthMessage || "Sua ferramenta ainda não está conectada.")}
          </div>`}
      <div class="connection-message" data-connect-message="${escapeHtml(item.id)}" hidden></div>
      <div class="connection-actions">${actions}</div>
    `;
  return `
    <article class="connection-card ${connected ? "is-connected" : ""} ${isMeta ? "is-import" : ""}" data-provider-card="${escapeHtml(item.id)}">
      <div class="connection-card-head">
        <div class="connection-logo">${escapeHtml((item.displayName || item.id).charAt(0))}</div>
        <div class="connection-card-title">
          <div class="connection-name">${escapeHtml(item.displayName || item.id)}</div>
          <div class="connection-desc">${escapeHtml(item.description || "")}</div>
        </div>
        ${statusPill(connected ? "connected" : "configured")}
      </div>
      <div class="connection-card-body">
        ${body}
      </div>
    </article>
  `;
}

function importPanelHtml(item) {
  return `
    <div class="import-panel" data-import-panel>
      <div class="import-dropzone" data-import-dropzone tabindex="0">
        <input type="file" accept=".csv,text/csv,application/vnd.ms-excel" data-import-file hidden />
        <div class="import-dropzone-inner">
          <div class="import-icon">⬆</div>
          <div class="import-drop-title">Arraste o arquivo CSV ou clique para selecionar</div>
          <div class="import-drop-hint">Planilha exportada do Gerenciador de Anúncios</div>
        </div>
      </div>
      <div class="import-filename" data-import-filename hidden></div>
      <div class="import-preview" data-import-preview hidden></div>
      <div class="connection-actions">
        <button type="button" class="btn-primary" data-import-submit disabled>Importar dados</button>
        <button type="button" class="ghost" data-test-button="${escapeHtml(item.id || "meta")}">Testar importação</button>
        <span class="import-status" data-import-status></span>
      </div>
    </div>
  `;
}

function importsHistoryHtml(imports) {
  if (!imports || !imports.length) {
    return `<div class="empty-state">Nenhuma importação feita ainda.</div>`;
  }
  const rows = imports.map((item) => `
    <tr>
      <td>${escapeHtml(formatDateTime(item.createdAt))}</td>
      <td>${escapeHtml(item.filename || "—")}</td>
      <td>${escapeHtml(item.campaigns)}</td>
      <td>${escapeHtml(money(item.spendCents || 0))}</td>
      <td>${escapeHtml(item.clicks)}</td>
      <td>${escapeHtml(item.totalRows)}</td>
    </tr>
  `);
  return tableHtml(["Data", "Arquivo", "Campanhas", "Gasto", "Cliques", "Linhas"], rows);
}

function connectionAdvanced(integrations) {
  const byId = (id) => (integrations || []).find((item) => item.id === id) || {};
  const perfectPay = byId("perfectpay");
  return `
    <details class="advanced-section">
      <summary><span class="advanced-title">Configurações avançadas</span><span class="advanced-caret"></span></summary>
      <div class="advanced-body">
        <form id="perfectpay-connection-form" class="stack-form compact-form">
          <div class="form-title">Perfect Pay — Webhook de vendas</div>
          <label><span>Status</span>
            <select id="perfectpay-status">
              <option value="not_connected" ${perfectPay.status !== "connected" ? "selected" : ""}>Não conectado</option>
              <option value="connected" ${perfectPay.status === "connected" ? "selected" : ""}>Conectado</option>
              <option value="needs_reconnect" ${perfectPay.status === "needs_reconnect" ? "selected" : ""}>Precisa atenção</option>
            </select>
          </label>
          <label><span>URL de eventos (cadastre na Perfect Pay)</span>
            <div class="webhook-url-row">
              <input id="perfectpay-webhook-url" type="text" value="${escapeHtml(perfectPay.webhookUrl || "")}" readonly />
              <button type="button" class="ghost" id="copy-webhook-url-button">Copiar</button>
            </div>
          </label>
          <label><span>Token do Webhook (recomendado)</span>
            <input id="perfectpay-webhook-token" type="password" placeholder="Token String(32) do webhook no painel da Perfect Pay" value="" />
          </label>
          <label><span>Segredo compartilhado (HMAC, opcional)</span>
            <input id="perfectpay-webhook-secret" type="password" placeholder="Novo segredo (opcional)" value="" />
          </label>
          <p class="form-hint">No painel da Perfect Pay, crie um webhook apontando para a URL acima e ative os eventos de venda (aprovação, pré-checkout etc.). O TrackROI valida o token do postback no recebimento para garantir que ele veio da sua conta.</p>
          <div class="connection-actions">
            <button type="submit" id="perfectpay-save-button">Salvar Perfect Pay</button>
            <button type="button" class="btn-secondary" id="perfectpay-test-button">Testar webhook</button>
            <span class="import-status" id="perfectpay-test-status"></span>
          </div>
        </form>
      </div>
    </details>
  `;
}

function connectionsPage(data) {
  const integrations = data.integrations || [];
  const imports = data.imports || [];
  const connectedCount = integrations.filter((item) => item.connected === true).length;
  const total = integrations.length;
  const allDone = connectedCount === total && total > 0;

  const hero = `
    <section class="connections-hero">
      <div class="connections-hero-copy">
        <h3>Atualize seus dados</h3>
        <p>Conecte sua conta do Facebook em um clique para importar gastos, cliques e campanhas dos seus anúncios automaticamente — ou importe planilhas exportadas do Gerenciador de Anúncios. O TrackROI atualiza o funil, as métricas e o ROI.</p>
      </div>
      <div class="connections-progress">
        <div class="progress-steps">
          ${integrations
            .map((item, index) => {
              const done = item.connected === true;
              const isImport = item.id === "meta";
              return `
                ${index > 0 ? `<span class="progress-line ${integrations[index - 1].connected === true ? "done" : ""}"></span>` : ""}
                <span class="progress-step ${done || isImport ? "done" : ""}">${done || isImport ? "✓" : index + 1}</span>
              `;
            })
            .join("")}
        </div>
        <div class="progress-label">${imports.length > 0 ? `${imports.length} importação(ões) realizada(s)` : `Comece importando a planilha da Meta`}</div>
      </div>
    </section>
  `;

  const cards = `
    <section class="connections-layout">
      ${pixelCardHtml(data.pixel)}
      ${integrations.map((item) => connectionCard(item)).join("")}
      ${integrations.length === 0 ? `<div class="empty-state">Nenhuma integração disponível neste momento.</div>` : ""}
    </section>
  `;

  const history = sectionPanel(
    "Histórico de importações",
    "Planilhas enviadas e os dados reconhecidos em cada uma.",
    importsHistoryHtml(imports)
  );

  const guide = sectionPanel(
    "Como funciona",
    "Três passos simples para começar.",
    `
    <div class="tutorial-grid">
      <div class="tutorial-card">
        <div class="tutorial-step">1</div>
        <strong>Exporte a planilha da Meta</strong>
        <p>No Gerenciador de Anúncios, abra "Resultados" e use Exportar > Formato CSV. Colunas como gasto, cliques no link e campanhas são reconhecidas automaticamente.</p>
      </div>
      <div class="tutorial-card">
        <div class="tutorial-step">2</div>
        <strong>Importe o arquivo</strong>
        <p>Arraste o CSV exportado para a área de importação. O TrackROI identifica os campos e mostra um resumo antes de salvar.</p>
      </div>
      <div class="tutorial-card">
        <div class="tutorial-step">3</div>
        <strong>Acompanhe os resultados</strong>
        <p>Funil, investimento, cliques, vendas e ROI são atualizados automaticamente a partir dos dados importados.</p>
      </div>
    </div>
    `
  );

  return `${hero}${cards}${history}${connectionAdvanced(integrations)}${guide}`;
}

function settingsPage(data) {
  const settings = data.settings || {};
  state.settings = settings;
  const general = settings.general || {};
  const finance = settings.finance || {};
  const notification = settings.notification || {};
  const permissionStatus = notificationsSupported() ? Notification.permission : "unsupported";
  const permissionLabel =
    permissionStatus === "granted"
      ? "Permitido no navegador"
      : permissionStatus === "denied"
        ? "Bloqueado no navegador — libere no site"
        : permissionStatus === "unsupported"
          ? "Navegador não suporta"
          : "Pendente — clique em \"Permitir\"";
  return `
    ${sectionPanel(
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
    )}
    ${sectionPanel(
      "Notificações",
      "Avisos em tempo real com som a cada venda gerada ou aprovada (notificação do Windows no desktop e toast no celular).",
      `
      <div class="settings-grid">
        <label class="switch-row"><span>Som da notificação (mp3)</span><input id="notif-sound" type="checkbox" ${notification.sound === false ? "" : "checked"} /></label>
        <div class="notification-permission-row">
          <span class="status-pill ${permissionStatus === "granted" ? "ok" : ""}">${escapeHtml(permissionLabel)}</span>
        </div>
        <div class="form-actions">
          <button type="button" id="notif-test" class="btn-primary">Testar notificação e som</button>
          <button type="button" id="notif-permission" class="btn-secondary">Permitir no navegador</button>
          <span class="form-status" id="notif-status"></span>
        </div>
      </div>
      `
    )}
    ${sectionPanel(
      "Custos de trabalho",
      "Usados no resumo financeiro. Custo diário é somado por dia no período; o mensal é rateado proporcionalmente aos dias selecionados.",
      `
      <form id="finance-form" class="settings-grid">
        <label><span>Custo de trabalho por dia (R$)</span><input id="labor-cost-day" type="number" min="0" step="0.01" value="${finance.laborCostPerDay != null ? finance.laborCostPerDay : ""}" placeholder="0,00" /></label>
        <label><span>Custo de trabalho por mês (R$)</span><input id="labor-cost-month" type="number" min="0" step="0.01" value="${finance.laborCostMonthly != null ? finance.laborCostMonthly : ""}" placeholder="0,00" /></label>
        <div class="form-actions"><button type="submit">Salvar custos</button><span class="form-status" id="finance-form-status"></span></div>
      </form>
      `
    )}
  `;
}

function parseMoneyInput(value) {
  const num = Number(String(value).replace(",", "."));
  return Number.isFinite(num) && num >= 0 ? num : 0;
}

function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
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
  prepareResponsiveTables(root);
  if ((state.route === "dashboard" || state.route === "funnel") && pageData.funnel?.stages) {
    animateFunnel(pageData.funnel.stages);
  }
  attachPageHandlers();
}

/* ------------------------------------------------------------- Import handlers */

let importSelectedFile = null;

function setupImportHandlers() {
  document.querySelectorAll("[data-import-panel]").forEach((panel) => {
    const dropzone = panel.querySelector("[data-import-dropzone]");
    const fileInput = panel.querySelector("[data-import-file]");
    const submit = panel.querySelector("[data-import-submit]");
    const statusNode = panel.querySelector("[data-import-status]");
    const filenameNode = panel.querySelector("[data-import-filename]");
    const previewNode = panel.querySelector("[data-import-preview]");

    const updateSubmit = () => {
      submit.disabled = !importSelectedFile;
      if (importSelectedFile) {
        filenameNode.hidden = false;
        filenameNode.textContent = `Arquivo selecionado: ${importSelectedFile.name}`;
      } else {
        filenameNode.hidden = true;
      }
    };

    dropzone.addEventListener("click", () => {
      if (!importSelectedFile) fileInput.click();
    });
    dropzone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (!importSelectedFile) fileInput.click();
      }
    });
    dropzone.addEventListener("dragover", (event) => {
      event.preventDefault();
      dropzone.classList.add("is-dragging");
    });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-dragging"));
    dropzone.addEventListener("drop", (event) => {
      event.preventDefault();
      dropzone.classList.remove("is-dragging");
      const file = event.dataTransfer.files && event.dataTransfer.files[0];
      if (file) handleImportFile(file);
    });
    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      if (file) handleImportFile(file);
      fileInput.value = "";
    });

    function handleImportFile(file) {
      importSelectedFile = file;
      updateSubmit();
      statusNode.textContent = "";
      statusNode.className = "import-status";
      if (!/\.(csv|xlsx|xls)$/i.test(file.name)) {
        showImportStatus(statusNode, "Formato não suportado. Exporte a planilha como CSV.", "error");
        importSelectedFile = null;
        updateSubmit();
        return;
      }
      if (/\.(xlsx|xls)$/i.test(file.name)) {
        showImportStatus(statusNode, "Exporte como CSV (Arquivo > Exportar > CSV) para importar.", "error");
        importSelectedFile = null;
        updateSubmit();
        return;
      }
      previewNode.hidden = true;
      previewNode.innerHTML = "";
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const preview = buildImportPreview(reader.result, file.name);
          previewNode.hidden = false;
          previewNode.innerHTML = preview.html;
          prepareResponsiveTables(previewNode);
        } catch (error) {
          showImportStatus(statusNode, error.message || "Não foi possível ler o arquivo.", "error");
        }
      };
      reader.readAsText(file, "utf-8");
    }

    if (submit) {
      submit.onclick = async () => {
        if (!importSelectedFile) return;
        setButtonLoading(submit, "Importando…");
        statusNode.textContent = "Analisando a planilha…";
        statusNode.className = "import-status";
        try {
          const formData = new FormData();
          formData.append("file", importSelectedFile);
          formData.append("mode", "backfill");
          const result = await apiUpload("/api/import/csv", formData);
          const stats = result.stats || {};
          const nf = new Intl.NumberFormat("pt-BR");
          showImportStatus(
            statusNode,
            `Importação concluída: ${nf.format(stats.campaigns.length)} campanhas · ${money(stats.totalSpendCents || 0)} em gasto · ${nf.format(stats.totalClicks)} cliques.`,
            "success"
          );
          importSelectedFile = null;
          updateSubmit();
          previewNode.hidden = true;
          previewNode.innerHTML = "";
          await loadData("connections", { silent: true });
        } catch (error) {
          showImportStatus(statusNode, friendlyError(error), "error");
        } finally {
          setButtonLoading(submit, "");
        }
      };
    }
  });
}

function showImportStatus(node, message, tone) {
  if (!node) return;
  node.textContent = message;
  node.className = "import-status";
  if (tone === "success") node.classList.add("is-success");
  if (tone === "error") node.classList.add("is-error");
}

async function apiUpload(path, formData) {
  const headers = {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (state.csrfToken) headers["X-CSRF-Token"] = state.csrfToken;
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, { method: "POST", headers, body: formData });
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
    throw new Error(body.error || `Erro ao importar a planilha.`);
  }
  return body;
}

function buildImportPreview(content, filename) {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) {
    throw new Error("O arquivo está vazio ou não contém linhas de dados.");
  }
  const headers = lines[0].split(",").map((cell) => cell.replace(/^"|"$/g, "").trim());
  const normHeader = (h) => h.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  const seen = new Set();
  const previewAliases = {
    campaignName: ["titulo do conjunto de anuncios", "conjunto de anuncios", "campaign name", "nome da campanha", "titulo da campanha", "campanha"],
    amountSpent: ["valor gasto", "amount spent", "investimento", "gasto", "spend"],
    linkClicks: ["cliques no link", "link clicks", "cliques"],
    impressions: ["impressoes", "impressions"],
    dateStart: ["periodo de relatorio", "data de inicio", "data do relatorio", "data", "date"],
  };
  Object.keys(previewAliases).forEach((field) => {
    const aliases = [...previewAliases[field]].sort((a, b) => b.length - a.length);
    for (const header of headers) {
      const normalized = normHeader(header);
      if (aliases.some((alias) => normalized.includes(alias))) {
        seen.add(field);
        break;
      }
    }
  });

  const previewHeaders = headers.slice(0, 6);
  const previewRows = lines.slice(1, 4).map((line) => {
    const cells = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') { current += '"'; i++; }
          else inQuotes = false;
        } else current += ch;
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        cells.push(current);
        current = "";
      } else current += ch;
    }
    cells.push(current);
    return cells.slice(0, 6);
  });

  const tags = [
    seen.has("campaignName") ? ["Campanhas", "ok"] : null,
    seen.has("amountSpent") ? ["Gasto", "ok"] : null,
    seen.has("linkClicks") ? ["Cliques no link", "ok"] : null,
    seen.has("impressions") ? ["Impressões", "ok"] : null,
  ].filter(Boolean);

  const table = `
    <div class="table-wrap">
      <table>
        <thead><tr>${previewHeaders.map((h) => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
        <tbody>
          ${previewRows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}
        </tbody>
      </table>
    </div>
  `;
  const badges = tags.length
    ? `<div class="import-tags">${tags.map(([label]) => `<span class="import-tag">✓ ${escapeHtml(label)}</span>`).join("")}</div>`
    : `<div class="import-alert">Nenhuma coluna conhecida encontrada neste arquivo.</div>`;

  return { html: `<div class="import-preview-inner">${badges}${table}</div>` };
}

/* ------------------------------------------------------------- Handlers */

function attachPageHandlers() {
  const refresh = el("refresh-button");
  if (refresh) refresh.onclick = () => loadData(state.route);

  const mobileRefresh = el("mobile-refresh-button");
  if (mobileRefresh) mobileRefresh.onclick = () => loadData(state.route);

  const mobileSave = el("mobile-save-settings-button");
  if (mobileSave) {
    mobileSave.onclick = () => {
      const submit = el("save-settings-submit");
      if (submit) submit.click();
    };
  }

  const mobileNewProduct = el("mobile-product-create-button");
  if (mobileNewProduct) {
    mobileNewProduct.onclick = () => {
      const form = el("product-form");
      if (!form) return;
      form.scrollIntoView({ behavior: "smooth", block: "center" });
      const input = form.querySelector("input");
      if (input) input.focus();
    };
  }

  const reload = el("reload-button");
  if (reload) reload.onclick = () => loadData(state.route);

  document.querySelectorAll("[data-refresh-chart]").forEach((node) => {
    node.onclick = () => loadData(state.route);
  });

  const source = el("source-filter");
  if (source) {
    source.onchange = () => {
      state.source = source.value;
      clearDashboardCache();
      loadData(state.route);
    };
  }

  const periodFilter = el("period-filter");
  if (periodFilter) {
    periodFilter.onchange = () => {
      const key = periodFilter.value;
      state.period.key = key;
      if (key === "custom") {
        if (!state.period.from || !state.period.to) {
          const today = new Date();
          const todayStr = toISODate(today);
          const fromDate = new Date(today);
          fromDate.setDate(fromDate.getDate() - 29);
          state.period.from = state.period.from || toISODate(fromDate);
          state.period.to = state.period.to || todayStr;
        }
        persistPeriod();
        renderPage();
      } else {
        persistPeriod();
        clearDashboardCache();
        loadData(state.route);
      }
    };
  }
  const periodFrom = el("period-from");
  const periodTo = el("period-to");
  if (periodFrom && periodTo) {
    periodFrom.onchange = () => {
      state.period.from = periodFrom.value;
      persistPeriod();
      clearDashboardCache();
      loadData(state.route);
    };
    periodTo.onchange = () => {
      state.period.to = periodTo.value;
      persistPeriod();
      clearDashboardCache();
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
  document.querySelectorAll("[data-sync-button]").forEach((button) => {
    button.onclick = () => syncProvider(button.dataset.syncButton, button);
  });
  document.querySelectorAll("[data-disconnect-button]").forEach((button) => {
    button.onclick = () => disconnectProvider(button.dataset.disconnectButton, button);
  });

  const copyWebhookUrlButton = el("copy-webhook-url-button");
  if (copyWebhookUrlButton) {
    copyWebhookUrlButton.onclick = async () => {
      const input = el("perfectpay-webhook-url");
      if (!input) return;
      try {
        await navigator.clipboard.writeText(input.value);
        setStatus("URL de webhook copiada.", "success");
      } catch {
        input.select();
        document.execCommand("copy");
        setStatus("URL de webhook copiada.", "success");
      }
    };
  }

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

  setupImportHandlers();

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
      const webhookToken = el("perfectpay-webhook-token").value.trim();
      if (secret) payload.webhookSecret = secret;
      if (webhookToken) payload.webhookToken = webhookToken;
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

  const perfectPayTestButton = el("perfectpay-test-button");
  if (perfectPayTestButton) {
    perfectPayTestButton.onclick = async () => {
      const statusNode = el("perfectpay-test-status");
      setButtonLoading(perfectPayTestButton, "Enviando teste…");
      if (statusNode) statusNode.textContent = "";
      try {
        const result = await apiFetch("/api/integrations/perfectpay/test", { method: "POST", body: "{}" });
        if (statusNode) statusNode.textContent = "Enviado — foi criada uma venda de R$ 0,01 como teste no seu painel.";
        setStatus(result.message || "Webhook de teste processado com sucesso.", "success");
        await loadData(state.route, { silent: true });
      } catch (error) {
        const message = friendlyError(error);
        setStatus(message, "error");
        if (statusNode) statusNode.textContent = message;
      } finally {
        setButtonLoading(perfectPayTestButton, "");
      }
    };
  }

const pixelForm = el("pixel-form");
  if (pixelForm) {
    pixelForm.onsubmit = async (event) => {
      event.preventDefault();
      const submit = pixelForm.querySelector("button[type=submit]");
      const statusNode = el("pixel-status");
      setButtonLoading(submit, "Validando na Meta…");
      if (statusNode) statusNode.textContent = "";
      const messageNode = pixelForm.parentElement.querySelector("[data-pixel-message]");
      if (messageNode) {
        messageNode.hidden = true;
        messageNode.classList.remove("is-error");
      }
      try {
        const result = await apiFetch("/api/pixel", {
          method: "PUT",
          body: JSON.stringify({ pixelId: el("pixel-id").value.trim(), accessToken: el("pixel-token").value.trim() }),
        });
        setStatus(result.warning || "Pixel conectado com sucesso.", "success");
        await loadData(state.route, { silent: true });
      } catch (error) {
        const message = friendlyError(error);
        setStatus(message, "error");
        if (messageNode) {
          messageNode.innerHTML = pixelErrorMarkup(error);
          messageNode.classList.add("is-error");
          messageNode.hidden = false;
        }
      } finally {
        setButtonLoading(submit, "");
      }
    };
  }

  const pixelTestForm = el("pixel-test-form");
  if (pixelTestForm) {
    pixelTestForm.onsubmit = async (event) => {
      event.preventDefault();
      const statusNode = el("pixel-test-status");
      if (statusNode) statusNode.textContent = "";
      try {
        const result = await apiFetch("/api/pixel/test", {
          method: "POST",
          body: JSON.stringify({ testEventCode: el("pixel-test-code").value.trim() }),
        });
        if (statusNode) {
          statusNode.textContent = result.eventsReceived > 0
            ? `Enviado ✓ ${result.eventsReceived} evento(s) recebido(s) pela Meta.`
            : `Enviado ✓ (${result.message || "confira em Eventos de Teste"})`;
        }
        await loadData(state.route, { silent: true });
      } catch (error) {
        const message = friendlyError(error);
        if (statusNode) statusNode.innerHTML = pixelErrorMarkup(error);
        setStatus(message, "error");
      }
    };
  }

  const pixelDisconnectButton = el("pixel-disconnect-button");
  if (pixelDisconnectButton) {
    pixelDisconnectButton.onclick = async () => {
      if (!window.confirm("Desconectar o Meta Pixel? As vendas aprovadas deixarão de ser enviadas para a Meta.")) return;
      try {
        await apiFetch("/api/pixel", { method: "DELETE" });
        setStatus("Pixel desconectado.", "success");
        await loadData(state.route, { silent: true });
      } catch (error) {
        setStatus(friendlyError(error), "error");
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

  const notifSoundInput = el("notif-sound");
  if (notifSoundInput) {
    notifSoundInput.onchange = async () => {
      const payload = {
        notification: {
          ...((state.settings?.notification || {})),
          browser: notificationBrowserEnabled(),
          sound: notifSoundInput.checked,
        },
      };
      try {
        await apiFetch("/api/settings", { method: "PUT", body: JSON.stringify(payload) });
        state.settings.notification = payload.notification;
        setStatus(notifSoundInput.checked ? "Som da notificação ativado." : "Som da notificação desativado.", "success");
      } catch (error) {
        setStatus(friendlyError(error), "error");
      }
    };
  }

  const notifTestButton = el("notif-test");
  if (notifTestButton) {
    notifTestButton.onclick = async () => {
      const statusNode = el("notif-status");
      if (statusNode) statusNode.textContent = "";
      prepareNotificationSound();
      if (notificationsSupported() && Notification.permission !== "granted") {
        localStorage.setItem("trackroi_notif_asked", "1");
        const result = await Notification.requestPermission();
        if (result !== "granted") {
          if (statusNode) statusNode.textContent = "Permita as notificações no navegador para ver o teste.";
          return;
        }
      }
      showSaleNotification({ title: "Venda aprovada", body: "Sua comissão > R$ 99,90 · PIX — teste de notificação" });
      if (statusNode) statusNode.textContent = "Teste enviado.";
    };
  }

  const notifPermissionButton = el("notif-permission");
  if (notifPermissionButton) {
    notifPermissionButton.onclick = async () => {
      const statusNode = el("notif-status");
      if (statusNode) statusNode.textContent = "";
      if (!notificationsSupported()) {
        if (statusNode) statusNode.textContent = "Seu navegador não suporta notificações.";
        return;
      }
      localStorage.setItem("trackroi_notif_asked", "1");
      const result = await Notification.requestPermission();
      if (result === "granted") {
        prepareNotificationSound();
        showSaleNotification({ title: "Notificações ativadas", body: "Você receberá alertas de vendas com som." });
        if (statusNode) statusNode.textContent = "Permitido. Recarregue a página se o texto ainda estiver pendente.";
      } else {
        if (statusNode) statusNode.textContent = "Bloqueado. Libere a permissão nas configurações do site no navegador.";
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

  const financeForm = el("finance-form");
  if (financeForm) {
    financeForm.onsubmit = async (event) => {
      event.preventDefault();
      const submit = financeForm.querySelector("button[type=submit]");
      const statusNode = el("finance-form-status");
      setButtonLoading(submit, "Salvando…");
      try {
        await apiFetch("/api/settings", {
          method: "PUT",
          body: JSON.stringify({
            finance: {
              laborCostPerDay: parseMoneyInput(el("labor-cost-day").value),
              laborCostMonthly: parseMoneyInput(el("labor-cost-month").value),
            },
          }),
        });
        if (statusNode) statusNode.textContent = "Salvo.";
        setStatus("Custos de trabalho salvos.", "success");
        clearDashboardCache();
      } catch (error) {
        if (statusNode) statusNode.textContent = "";
        setStatus(friendlyError(error), "error");
      } finally {
        setButtonLoading(submit, "");
      }
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
  await refreshNotificationSettings().catch(() => {});
  prepareNotificationSound();
}

function showAuthForm(which) {
  const loginForm = el("login-form");
  const registerForm = el("register-form");
  if (loginForm) loginForm.hidden = which !== "login";
  if (registerForm) registerForm.hidden = which !== "register";
  const toLogin = el("switch-login");
  const toRegister = el("switch-register");
  if (toLogin) toLogin.hidden = which === "login";
  if (toRegister) toRegister.hidden = which === "register";
  setLoginError("");
  setRegisterError("");
  if (which === "register") {
    el("register-name").value = "";
    el("register-email").value = "";
    el("register-password").value = "";
  }
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
  if (state.csrfToken) localStorage.setItem(CSRF_KEY, state.csrfToken);
  showApp();
  startSSE();
  await loadData();
  await refreshNotificationSettings().catch(() => {});
  askNotificationPermission();
}

async function bootstrap() {
  mountSidebarIcons();
  applySidebarState();
  prepareNotificationSound();
  mountResponsiveShell();

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

  el("register-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    setRegisterError("");
    const submit = el("register-form").querySelector("button[type=submit]");
    const name = el("register-name").value.trim();
    const email = el("register-email").value.trim();
    const password = el("register-password").value;
    if (!name || !email || password.length < 8) {
      setRegisterError("Preencha nome, e-mail e uma senha com pelo menos 8 caracteres.");
      return;
    }
    setButtonLoading(submit, "Criando conta…");
    try {
      await register(name, email, password);
    } catch (error) {
      setRegisterError(friendlyError(error));
    } finally {
      setButtonLoading(submit, "");
    }
  });

  el("switch-register").addEventListener("click", () => showAuthForm("register"));
  el("switch-login").addEventListener("click", () => showAuthForm("login"));

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
      await refreshNotificationSettings().catch(() => {});
      prepareNotificationSound();
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