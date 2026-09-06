const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { encryptSecret, decryptSecret, createPasswordRecord, verifyPassword } = require("./crypto");

const DATA_DIR = process.env.TRACKROI_DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "trackroi.db");
const STATE_FILE = path.join(DATA_DIR, "state.json");

let db = null;

function open() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrateSchema();
  migrateStateJson();
  seedAdminIfNeeded();
  ensureMultiDashboard();
  return db;
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

function checkDb() {
  if (!db) open();
  return db;
}

function exec(sql) {
  checkDb().exec(sql);
}

function run(sql, params = []) {
  return checkDb().prepare(sql).run(...params);
}

function get(sql, params = []) {
  return checkDb().prepare(sql).get(...params);
}

function all(sql, params = []) {
  return checkDb().prepare(sql).all(...params);
}

function transaction(fn) {
  const dbSync = checkDb();
  dbSync.exec("BEGIN;");
  try {
    const result = fn();
    dbSync.exec("COMMIT;");
    return result;
  } catch (error) {
    dbSync.exec("ROLLBACK;");
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function migrateSchema() {
  exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'admin',
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS clicks (
      id TEXT PRIMARY KEY,
      trackroi_click_id TEXT,
      source TEXT,
      campaign_id TEXT,
      adset_id TEXT,
      ad_id TEXT,
      landing_page TEXT,
      referrer TEXT,
      fbclid TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_clicks_trackroi_click_id ON clicks(trackroi_click_id);
    CREATE INDEX IF NOT EXISTS idx_clicks_created_at ON clicks(created_at);

    CREATE TABLE IF NOT EXISTS checkouts (
      id TEXT PRIMARY KEY,
      trackroi_click_id TEXT,
      status TEXT NOT NULL DEFAULT 'initiated',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_checkouts_created_at ON checkouts(created_at);

    CREATE TABLE IF NOT EXISTS sales (
      id TEXT PRIMARY KEY,
      gateway TEXT NOT NULL,
      gateway_transaction_id TEXT NOT NULL,
      event_type TEXT,
      status TEXT NOT NULL,
      amount_cents INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'BRL',
      trackroi_click_id TEXT,
      source TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sales_gateway_tx ON sales(gateway, gateway_transaction_id);
    CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(status);
    CREATE INDEX IF NOT EXISTS idx_sales_created_at ON sales(created_at);

    CREATE TABLE IF NOT EXISTS webhook_events (
      id TEXT PRIMARY KEY,
      gateway TEXT NOT NULL,
      transaction_id TEXT,
      event_type TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      received_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'received',
      raw_payload TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_events_received_at ON webhook_events(received_at);

    CREATE TABLE IF NOT EXISTS advertising_spend (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'meta',
      amount_cents INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'BRL',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_spend_created_at ON advertising_spend(created_at);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      actor_user_id TEXT,
      action TEXT NOT NULL,
      resource_type TEXT,
      resource_id TEXT,
      metadata TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp);

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price_cents INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_products_created_at ON products(created_at);

    CREATE TABLE IF NOT EXISTS integrations (
      provider_id TEXT PRIMARY KEY,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS csrf_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_csrf_user ON csrf_tokens(user_id);

    CREATE TABLE IF NOT EXISTS login_attempts (
      ip TEXT PRIMARY KEY,
      first_attempt INTEGER NOT NULL,
      count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS import_runs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      filename TEXT,
      total_rows INTEGER NOT NULL DEFAULT 0,
      imported_spend INTEGER NOT NULL DEFAULT 0,
      imported_clicks INTEGER NOT NULL DEFAULT 0,
      spend_cents INTEGER NOT NULL DEFAULT 0,
      clicks INTEGER NOT NULL DEFAULT 0,
      campaigns INTEGER NOT NULL DEFAULT 0,
      preview TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      error TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_import_runs_created_at ON import_runs(created_at);
  `);

  const clickColumns = checkDb().prepare("PRAGMA table_info(clicks)").all().map((c) => c.name);
  if (!clickColumns.includes("quantity")) {
    exec("ALTER TABLE clicks ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1");
  }
  const saleColumns = checkDb().prepare("PRAGMA table_info(sales)").all().map((c) => c.name);
  if (!saleColumns.includes("quantity")) {
    exec("ALTER TABLE sales ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1");
  }
  migrateDashboardSchema();
}

function migrateDashboardSchema() {
  exec(
    `CREATE TABLE IF NOT EXISTS dashboards (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`
  );
  exec("CREATE INDEX IF NOT EXISTS idx_dashboards_owner ON dashboards(owner_id)");

  const ensureColumn = (tableName) => {
    const cols = checkDb().prepare(`PRAGMA table_info(${tableName})`).all().map((c) => c.name);
    if (!cols.includes("dashboard_id")) {
      exec(`ALTER TABLE ${tableName} ADD COLUMN dashboard_id TEXT NOT NULL DEFAULT ''`);
    }
  };

  for (const table of ["clicks", "checkouts", "sales", "webhook_events", "advertising_spend", "import_runs", "products"]) {
    ensureColumn(table);
  }

  const integrationCols = checkDb().prepare("PRAGMA table_info(integrations)").all().map((c) => c.name);
  if (!integrationCols.includes("dashboard_id")) {
    exec(
      `CREATE TABLE integrations_v2 (
        provider_id TEXT NOT NULL,
        dashboard_id TEXT NOT NULL DEFAULT '',
        data TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (dashboard_id, provider_id)
      )`
    );
    exec(
      `INSERT INTO integrations_v2 (provider_id, dashboard_id, data, updated_at)
       SELECT provider_id, '', data, updated_at FROM integrations`
    );
    exec("DROP TABLE integrations");
    exec("ALTER TABLE integrations_v2 RENAME TO integrations");
  }
}

function ensureMultiDashboard() {
  const flags = { wipeDone: !!get("SELECT 1 FROM settings WHERE key = 'migration_dashboard_v1'") };
  const dashCount = get("SELECT COUNT(*) AS n FROM dashboards").n;
  if (dashCount > 0) return flags;

  const users = all("SELECT id FROM users");
  for (const user of users) {
    const defaultDash = createDashboard({ ownerId: user.id, name: "Operação Principal" });
    run("UPDATE integrations SET dashboard_id = ? WHERE dashboard_id = ''", [defaultDash.id]);
  }

  if (users.length > 0) {
    exec("DELETE FROM advertising_spend");
    exec("DELETE FROM clicks");
    exec("DELETE FROM checkouts");
    exec("DELETE FROM sales");
    exec("DELETE FROM webhook_events");
    exec("DELETE FROM products");
    exec("DELETE FROM import_runs");
  }

  run("INSERT INTO settings (key, value) VALUES ('migration_dashboard_v1', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  flags.wipeDone = true;
  return flags;
}

/* ------------------------------------------------------------- Dashboards */

function listDashboards(ownerId) {
  return all("SELECT * FROM dashboards WHERE owner_id = ? ORDER BY created_at ASC", [String(ownerId || "")]).map(mapDashboard);
}

function getDashboard(id) {
  return get("SELECT * FROM dashboards WHERE id = ?", [String(id || "")]);
}

function countDashboards(ownerId) {
  return get("SELECT COUNT(*) AS n FROM dashboards WHERE owner_id = ?", [String(ownerId || "")]).n;
}

function createDashboard({ ownerId, name }) {
  const row = {
    id: `dash_${crypto.randomUUID()}`,
    ownerId: String(ownerId || ""),
    name: String(name || "").trim() || "Nova operação",
    createdAt: new Date().toISOString(),
  };
  run("INSERT INTO dashboards (id, owner_id, name, created_at) VALUES (?, ?, ?, ?)", [
    row.id,
    row.ownerId,
    row.name,
    row.createdAt,
  ]);
  return getDashboard(row.id);
}

function ensureDefaultDashboard(ownerId) {
  const owned = listDashboards(ownerId);
  if (owned.length > 0) return owned[0];
  return createDashboard({ ownerId, name: "Operação Principal" });
}

function mapDashboard(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    createdAt: row.created_at,
  };
}

function dashboardClause(dashboardId) {
  return { sql: " AND dashboard_id = ?", params: [String(dashboardId || "").trim()] };
}

function migrateStateJson() {
  const userCount = get("SELECT COUNT(*) AS n FROM users").n;
  if (userCount > 0) return;
  if (!fs.existsSync(STATE_FILE)) return;
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!state || typeof state !== "object") return;
    setSettings(state.settings || {});
    upsertIntegration("meta", state.integrations?.meta || {});
    upsertIntegration("perfectpay", state.integrations?.perfectPay || {});
    get("SELECT 1 FROM users LIMIT 1") || seedUsers(state.users || []);
    (state.sessions || []).forEach((s) => insertSession(s));
    (state.clicks || []).forEach((c) => insertClick(c));
    (state.checkouts || []).forEach((c) => insertCheckout(c));
    (state.sales || []).forEach((s) => insertSale(s));
    (state.webhookEvents || []).forEach((e) => insertWebhookEvent(e));
    (state.advertisingSpend || []).forEach((s) => insertSpend(s));
    (state.auditLogs || []).forEach((e) => insertAuditLog(e));
    (state.products || []).forEach((p) => insertProduct(p));
  } catch (error) {
    console.error("[migration] Falha ao importar state.json:", error.message);
  }
}

function seedAdminIfNeeded() {
  const count = get("SELECT COUNT(*) AS n FROM users").n;
  if (count > 0) return;
  const email = String(process.env.ADMIN_EMAIL || "admin@trackroi.local").toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "TrackROI!2026";
  const record = createPasswordRecord(password);
  run(
    "INSERT INTO users (id, name, email, role, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ["user_admin", "Administrador", email, "admin", record.salt, record.hash, new Date().toISOString()]
  );
}

/* ------------------------------------------------------------- Users */

function seedUsers(users) {
  for (const user of users) {
    const record = user.password || createPasswordRecord("changeme");
    run(
      "INSERT OR IGNORE INTO users (id, name, email, role, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [user.id, user.name, user.email, user.role || "admin", record.salt, record.hash, user.createdAt || new Date().toISOString()]
    );
  }
}

function getUserByEmail(email) {
  return get("SELECT * FROM users WHERE email = ?", [String(email || "").trim().toLowerCase()]);
}

function getUserById(id) {
  return get("SELECT * FROM users WHERE id = ?", [id]);
}

function createUser({ name, email, role = "admin", password }) {
  const user = {
    id: `user_${crypto.randomUUID()}`,
    name: String(name || "").trim(),
    email: String(email || "").trim().toLowerCase(),
    role,
    created_at: new Date().toISOString(),
  };
  const record = createPasswordRecord(password);
  run(
    "INSERT INTO users (id, name, email, role, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [user.id, user.name, user.email, user.role, record.salt, record.hash, user.created_at]
  );
  return getUserById(user.id);
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

/* ------------------------------------------------------------- Sessions */

function createSession(userId) {
  const session = {
    id: `session_${crypto.randomUUID()}`,
    token: crypto.randomBytes(24).toString("hex"),
    userId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString(),
  };
  insertSession(session);
  return session;
}

function insertSession(session) {
  run(
    "INSERT OR IGNORE INTO sessions (id, token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
    [session.id, session.token, session.userId, session.createdAt, session.expiresAt]
  );
}

function getUserByToken(token) {
  if (!token) return null;
  const session = get("SELECT * FROM sessions WHERE token = ?", [String(token)]);
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    run("DELETE FROM sessions WHERE token = ?", [String(token)]);
    return null;
  }
  return getUserById(session.user_id);
}

function deleteSession(token) {
  run("DELETE FROM sessions WHERE token = ?", [String(token)]);
}

function pruneExpiredSessions() {
  run("DELETE FROM sessions WHERE expires_at < ?", [new Date().toISOString()]);
}

/* ------------------------------------------------------------- Clicks */

function insertClick(click) {
  const created = click.createdAt || click.created_at || new Date().toISOString();
  run(
    "INSERT OR IGNORE INTO clicks (id, trackroi_click_id, source, campaign_id, adset_id, ad_id, landing_page, referrer, fbclid, quantity, dashboard_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      click.id,
      (click.trackroiClickId ?? click.trackroi_click_id) ?? null,
      click.source || "direct",
      (click.campaignId ?? click.campaign_id) ?? null,
      (click.adsetId ?? click.adset_id) ?? null,
      (click.adId ?? click.ad_id) ?? null,
      (click.landingPage ?? click.landing_page) ?? "/",
      click.referrer ?? null,
      click.fbclid ?? null,
      Number.isFinite(Number(click.quantity)) && Number(click.quantity) > 0 ? Math.round(Number(click.quantity)) : 1,
      String(click.dashboardId ?? click.dashboard_id ?? "").trim(),
      created,
    ]
  );
}

function createClick({ dashboardId, trackroiClickId, source, campaignId, adsetId, adId, landingPage, referrer, fbclid }) {
  const click = {
    id: makeId("cl"),
    trackroiClickId: trackroiClickId || makeId("trk"),
    source: source || "direct",
    campaignId: campaignId || null,
    adsetId: adsetId || null,
    adId: adId || null,
    landingPage: landingPage || "/",
    referrer: referrer || null,
    fbclid: fbclid || null,
    dashboardId: String(dashboardId || "").trim(),
    createdAt: new Date().toISOString(),
  };
  insertClick(click);
  return { ...click, id: click.id };
}

function listClicks(limit, offset, dashboardId) {
  const dc = dashboardClause(dashboardId);
  return all(`SELECT * FROM clicks WHERE 1=1${dc.sql} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...dc.params, limit, offset]).map(mapClick);
}

function mapClick(row) {
  return {
    id: row.id,
    trackroiClickId: row.trackroi_click_id,
    source: row.source,
    campaignId: row.campaign_id,
    adsetId: row.adset_id,
    adId: row.ad_id,
    landingPage: row.landing_page,
    referrer: row.referrer,
    fbclid: row.fbclid,
    quantity: row.quantity || 1,
    dashboardId: row.dashboard_id || "",
    createdAt: row.created_at,
  };
}

function countClicks(dashboardId) {
  const dc = dashboardClause(dashboardId);
  return get(`SELECT COUNT(*) AS n FROM clicks WHERE 1=1${dc.sql}`, dc.params).n;
}

function findClickByTrackroiId(trackroiClickId, dashboardId) {
  const dc = dashboardClause(dashboardId);
  return get(`SELECT * FROM clicks WHERE trackroi_click_id = ?${dc.sql}`, [trackroiClickId, ...dc.params]);
}

function findClickDashboardByTrackroiId(trackroiClickId) {
  const row = get("SELECT dashboard_id FROM clicks WHERE trackroi_click_id = ? LIMIT 1", [String(trackroiClickId || "")]);
  return row ? String(row.dashboard_id || "").trim() : null;
}

/* ------------------------------------------------------------- Checkouts */

function insertCheckout(checkout) {
  run("INSERT OR IGNORE INTO checkouts (id, trackroi_click_id, status, dashboard_id, created_at) VALUES (?, ?, ?, ?, ?)", [
    checkout.id,
    (checkout.trackroiClickId ?? checkout.trackroi_click_id) ?? null,
    checkout.status || "initiated",
    String(checkout.dashboardId ?? checkout.dashboard_id ?? "").trim(),
    checkout.createdAt || checkout.created_at || new Date().toISOString(),
  ]);
}

function createCheckout({ dashboardId, trackroiClickId, status }) {
  const checkout = {
    id: makeId("co"),
    trackroiClickId: trackroiClickId || "",
    status: status || "initiated",
    dashboardId: String(dashboardId || "").trim(),
    createdAt: new Date().toISOString(),
  };
  insertCheckout(checkout);
  return { ...checkout, id: checkout.id };
}

function listCheckouts(limit, offset, dashboardId) {
  const dc = dashboardClause(dashboardId);
  return all(`SELECT * FROM checkouts WHERE 1=1${dc.sql} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...dc.params, limit, offset]).map(mapCheckout);
}

function mapCheckout(row) {
  return {
    id: row.id,
    trackroiClickId: row.trackroi_click_id,
    status: row.status,
    dashboardId: row.dashboard_id || "",
    createdAt: row.created_at,
  };
}

function countCheckouts(dashboardId) {
  const dc = dashboardClause(dashboardId);
  return get(`SELECT COUNT(*) AS n FROM checkouts WHERE 1=1${dc.sql}`, dc.params).n;
}

/* ------------------------------------------------------------- Sales */

function insertSale(sale) {
  run(
    "INSERT OR IGNORE INTO sales (id, gateway, gateway_transaction_id, event_type, status, amount_cents, currency, trackroi_click_id, source, quantity, dashboard_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      sale.id,
      sale.gateway,
      sale.gatewayTransactionId || sale.gateway_transaction_id,
      sale.eventType ?? sale.event_type,
      sale.status,
      sale.amountCents ?? sale.amount_cents ?? 0,
      sale.currency || "BRL",
      (sale.trackroiClickId ?? sale.trackroi_click_id) ?? null,
      sale.source,
      Number.isFinite(Number(sale.quantity)) && Number(sale.quantity) > 0 ? Math.round(Number(sale.quantity)) : 1,
      String(sale.dashboardId ?? sale.dashboard_id ?? "").trim(),
      sale.createdAt || sale.created_at || new Date().toISOString(),
      sale.updatedAt || sale.updated_at || new Date().toISOString(),
    ]
  );
}

function upsertSale(sale) {
  insertSale(sale);
  run(
    `UPDATE sales SET event_type = ?, status = ?, amount_cents = ?, currency = ?, trackroi_click_id = ?, source = ?, updated_at = ?
     WHERE gateway = ? AND gateway_transaction_id = ? AND dashboard_id = ?`,
    [
      sale.eventType || sale.event_type,
      sale.status,
      sale.amountCents ?? sale.amount_cents ?? 0,
      sale.currency || "BRL",
      sale.trackroiClickId || sale.trackroi_click_id,
      sale.source,
      sale.updatedAt || sale.updated_at || new Date().toISOString(),
      sale.gateway,
      sale.gatewayTransactionId || sale.gateway_transaction_id,
      String(sale.dashboardId ?? sale.dashboard_id ?? "").trim(),
    ]
  );
}

function findSaleByTx(gateway, txId, dashboardId) {
  const dc = dashboardClause(dashboardId);
  return get(`SELECT * FROM sales WHERE gateway = ? AND gateway_transaction_id = ?${dc.sql}`, [gateway, txId, ...dc.params]);
}

function listSales(limit, offset, dashboardId) {
  const dc = dashboardClause(dashboardId);
  return all(`SELECT * FROM sales WHERE 1=1${dc.sql} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...dc.params, limit, offset]).map(mapSale);
}

function mapSale(row) {
  return {
    id: row.id,
    gateway: row.gateway,
    gatewayTransactionId: row.gateway_transaction_id,
    eventType: row.event_type,
    status: row.status,
    amountCents: row.amount_cents,
    currency: row.currency,
    trackroiClickId: row.trackroi_click_id,
    source: row.source,
    quantity: row.quantity || 1,
    dashboardId: row.dashboard_id || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function countSales(dashboardId) {
  const dc = dashboardClause(dashboardId);
  return get(`SELECT COUNT(*) AS n FROM sales WHERE 1=1${dc.sql}`, dc.params).n;
}

/* ------------------------------------------------------------- Webhook events */

function insertWebhookEvent(event) {
  const result = run("INSERT OR IGNORE INTO webhook_events (id, gateway, transaction_id, event_type, idempotency_key, received_at, status, dashboard_id, raw_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
    event.id,
    event.gateway,
    event.transactionId || event.transaction_id,
    event.eventType || event.event_type,
    event.idempotencyKey || event.idempotency_key,
    event.receivedAt || event.received_at || new Date().toISOString(),
    event.status || "received",
    String(event.dashboardId ?? event.dashboard_id ?? "").trim(),
    event.rawPayload ? JSON.stringify(event.rawPayload) : null,
  ]);
  return result.changes > 0;
}

function hasWebhookEvent(idempotencyKey, dashboardId) {
  const dc = dashboardClause(dashboardId);
  return !!get(`SELECT 1 FROM webhook_events WHERE idempotency_key = ?${dc.sql}`, [idempotencyKey, ...dc.params]);
}

function listWebhookEvents(limit, offset, dashboardId) {
  const dc = dashboardClause(dashboardId);
  return all(`SELECT * FROM webhook_events WHERE 1=1${dc.sql} ORDER BY received_at DESC LIMIT ? OFFSET ?`, [...dc.params, limit, offset]).map(mapWebhookEvent);
}

function mapWebhookEvent(row) {
  let rawPayload = null;
  try {
    rawPayload = row.raw_payload ? JSON.parse(row.raw_payload) : null;
  } catch {
    rawPayload = null;
  }
  return {
    id: row.id,
    gateway: row.gateway,
    transactionId: row.transaction_id,
    eventType: row.event_type,
    idempotencyKey: row.idempotency_key,
    receivedAt: row.received_at,
    status: row.status,
    dashboardId: row.dashboard_id || "",
    rawPayload,
  };
}

function countWebhookEvents(dashboardId) {
  const dc = dashboardClause(dashboardId);
  return get(`SELECT COUNT(*) AS n FROM webhook_events WHERE 1=1${dc.sql}`, dc.params).n;
}

/* ------------------------------------------------------------- Advertising spend */

function insertSpend(spend) {
  run("INSERT OR IGNORE INTO advertising_spend (id, source, amount_cents, currency, dashboard_id, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
    spend.id,
    spend.source,
    spend.amountCents ?? spend.amount_cents ?? 0,
    spend.currency || "BRL",
    String(spend.dashboardId ?? spend.dashboard_id ?? "").trim(),
    spend.createdAt || spend.created_at || new Date().toISOString(),
  ]);
}

function createSpend({ dashboardId, source, amountCents, currency }) {
  const spend = {
    id: makeId("sp"),
    source: source || "meta",
    amountCents: Number(amountCents) || 0,
    currency: String(currency || "BRL").toUpperCase(),
    dashboardId: String(dashboardId || "").trim(),
    createdAt: new Date().toISOString(),
  };
  insertSpend(spend);
  return { ...spend, id: spend.id };
}

/* ------------------------------------------------------------- Import runs */

function insertImportRun(entry) {
  run(
    `INSERT INTO import_runs (id, type, filename, total_rows, imported_spend, imported_clicks, spend_cents, clicks, campaigns, preview, status, error, dashboard_id, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.id || `imp_${crypto.randomUUID()}`,
      entry.type || "meta",
      entry.filename || null,
      entry.totalRows ?? 0,
      entry.importedSpend ?? 0,
      entry.importedClicks ?? 0,
      entry.spendCents ?? 0,
      entry.clicks ?? 0,
      entry.campaigns ?? 0,
      entry.preview ? JSON.stringify(entry.preview) : null,
      entry.status || "completed",
      entry.error || null,
      String(entry.dashboardId ?? entry.dashboard_id ?? "").trim(),
      entry.createdAt || new Date().toISOString(),
      entry.createdBy || null,
    ]
  );
}

function listImportRuns(limit = 20, dashboardId) {
  const dc = dashboardClause(dashboardId);
  return all(`SELECT * FROM import_runs WHERE 1=1${dc.sql} ORDER BY created_at DESC LIMIT ?`, [...dc.params, limit]).map(mapImportRun);
}

function mapImportRun(row) {
  let preview = null;
  try {
    preview = row.preview ? JSON.parse(row.preview) : null;
  } catch {
    preview = null;
  }
  return {
    id: row.id,
    type: row.type,
    filename: row.filename,
    totalRows: row.total_rows,
    importedSpend: row.imported_spend,
    importedClicks: row.imported_clicks,
    spendCents: row.spend_cents,
    clicks: row.clicks,
    campaigns: row.campaigns,
    preview,
    status: row.status,
    error: row.error,
    dashboardId: row.dashboard_id || "",
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

/* ------------------------------------------------------------- Audit logs */

function insertAuditLog(entry) {
  run("INSERT INTO audit_logs (id, timestamp, actor_user_id, action, resource_type, resource_id, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)", [
    entry.id || `audit_${crypto.randomUUID()}`,
    entry.timestamp || entry.createdAt || new Date().toISOString(),
    entry.actorUserId || entry.actor_user_id || null,
    entry.action,
    entry.resourceType || entry.resource_type || null,
    entry.resourceId || entry.resource_id || null,
    entry.metadata ? JSON.stringify(entry.metadata) : null,
  ]);
}

function appendAuditLog(entry) {
  insertAuditLog(entry);
}

function listAuditLogs(limit, offset, userId) {
  if (userId) {
    return all("SELECT * FROM audit_logs WHERE actor_user_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?", [String(userId), limit, offset]).map(mapAuditLog);
  }
  return all("SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT ? OFFSET ?", [limit, offset]).map(mapAuditLog);
}

function mapAuditLog(row) {
  let metadata = null;
  try {
    metadata = row.metadata ? JSON.parse(row.metadata) : null;
  } catch {
    metadata = null;
  }
  return {
    id: row.id,
    timestamp: row.timestamp,
    actorUserId: row.actor_user_id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    metadata,
  };
}

function countAuditLogs(userId) {
  if (userId) {
    return get("SELECT COUNT(*) AS n FROM audit_logs WHERE actor_user_id = ?", [String(userId)]).n;
  }
  return get("SELECT COUNT(*) AS n FROM audit_logs").n;
}

/* ------------------------------------------------------------- Products */

function insertProduct(product, dashboardId) {
  run("INSERT OR IGNORE INTO products (id, name, price_cents, dashboard_id, created_at) VALUES (?, ?, ?, ?, ?)", [
    product.id,
    product.name,
    product.priceCents ?? product.price_cents ?? 0,
    String(dashboardId ?? product.dashboardId ?? product.dashboard_id ?? "").trim(),
    product.createdAt || product.created_at || new Date().toISOString(),
  ]);
}

function createProduct({ dashboardId, name, priceCents }) {
  const product = {
    id: makeId("pr"),
    name: String(name || "").trim(),
    priceCents: Number(priceCents) || 0,
    dashboardId: String(dashboardId || "").trim(),
    createdAt: new Date().toISOString(),
  };
  insertProduct(product, dashboardId);
  return { ...product, id: product.id };
}

function listProducts(dashboardId) {
  const dc = dashboardClause(dashboardId);
  return all(`SELECT * FROM products WHERE 1=1${dc.sql} ORDER BY created_at DESC`, dc.params).map(mapProduct);
}

function mapProduct(row) {
  return {
    id: row.id,
    name: row.name,
    priceCents: row.price_cents,
    dashboardId: row.dashboard_id || "",
    createdAt: row.created_at,
  };
}

/* ------------------------------------------------------------- Integrations */

function upsertIntegration(providerId, data, dashboardId) {
  run(
    "INSERT INTO integrations (dashboard_id, provider_id, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(dashboard_id, provider_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
    [String(dashboardId || "").trim(), providerId, JSON.stringify(data || {}), new Date().toISOString()]
  );
}

function getIntegration(providerId, dashboardId) {
  const row = get("SELECT data, updated_at FROM integrations WHERE provider_id = ? AND dashboard_id = ?", [providerId, String(dashboardId || "").trim()]);
  if (!row) return { updated_at: null };
  return { ...JSON.parse(row.data || "{}"), updated_at: row.updated_at };
}

function listIntegrations(dashboardId) {
  const dc = dashboardClause(dashboardId);
  return all(`SELECT dashboard_id, provider_id, data, updated_at FROM integrations WHERE 1=1${dc.sql} ORDER BY updated_at DESC`, dc.params).map((row) => ({
    dashboardId: row.dashboard_id || "",
    providerId: row.provider_id,
    ...JSON.parse(row.data || "{}"),
    updated_at: row.updated_at,
  }));
}

function listDashboardsWithIntegration(providerId) {
  return all(
    "SELECT i.dashboard_id, u.id AS owner_id, u.name AS owner_name FROM integrations i JOIN dashboards d ON d.id = i.dashboard_id JOIN users u ON u.id = d.owner_id WHERE i.provider_id = ? AND i.dashboard_id != ''",
    [String(providerId)]
  );
}

function updateIntegrationField(providerId, field, value, dashboardId) {
  const current = getIntegration(providerId, dashboardId);
  current[field] = value;
  upsertIntegration(providerId, current, dashboardId);
  return current;
}

/* ------------------------------------------------------------- Settings */

function settingsKey(dashboardId) {
  return `dash_${String(dashboardId || "").trim() || "global"}`;
}

function setSettings(settings, dashboardId) {
  run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [settingsKey(dashboardId), JSON.stringify(settings || {})]
  );
}

function getSettings(dashboardId) {
  const row = get("SELECT value FROM settings WHERE key = ?", [settingsKey(dashboardId)]);
  if (!row) return {};
  try {
    return JSON.parse(row.value);
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------- CSRF */

function createCsrfToken(userId) {
  const token = crypto.randomBytes(24).toString("hex");
  run("INSERT INTO csrf_tokens (token, user_id, created_at) VALUES (?, ?, ?)", [
    token,
    userId,
    new Date().toISOString(),
  ]);
  return token;
}

function verifyCsrfToken(token, userId) {
  if (!token) return false;
  const row = get("SELECT * FROM csrf_tokens WHERE token = ? AND user_id = ?", [token, userId]);
  if (!row) return false;
  if (Date.now() - new Date(row.created_at).getTime() > 24 * 60 * 60 * 1000) {
    run("DELETE FROM csrf_tokens WHERE token = ?", [token]);
    return false;
  }
  return true;
}

function pruneCsrfTokens() {
  run("DELETE FROM csrf_tokens WHERE created_at < ?", [new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()]);
}

/* ------------------------------------------------------------- Login attempts (persistent) */

function recordLoginAttempt(ip) {
  if (!ip) return;
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const existing = get("SELECT * FROM login_attempts WHERE ip = ?", [ip]);
  if (!existing || now - existing.first_attempt > windowMs) {
    run(
      "INSERT INTO login_attempts (ip, first_attempt, count) VALUES (?, ?, 1) ON CONFLICT(ip) DO UPDATE SET first_attempt = ?, count = 1",
      [ip, now, now]
    );
    return;
  }
  run("UPDATE login_attempts SET count = count + 1 WHERE ip = ?", [ip]);
}

function resetLoginAttempts(ip) {
  if (!ip) return;
  run("DELETE FROM login_attempts WHERE ip = ?", [ip]);
}

function isRateLimited(ip, maxAttempts = 5) {
  if (process.env.ENABLE_LOGIN_RATE_LIMIT === "false") return false;
  const row = get("SELECT * FROM login_attempts WHERE ip = ?", [ip]);
  if (!row) return false;
  if (Date.now() - row.first_attempt > 15 * 60 * 1000) {
    run("DELETE FROM login_attempts WHERE ip = ?", [ip]);
    return false;
  }
  return row.count >= maxAttempts;
}

function pruneLoginAttempts() {
  run("DELETE FROM login_attempts WHERE first_attempt < ?", [Date.now() - 15 * 60 * 1000]);
}

/* ------------------------------------------------------------- Aggregates */

function sourceClause(source) {
  if (!source || source === "all") return { sql: "", params: [] };
  if (source === "direct") {
    return { sql: " AND (source IS NULL OR source = 'direct')", params: [] };
  }
  return { sql: " AND source = ?", params: [String(source).toLowerCase()] };
}

function dailyTrend(source = "all", period = null, dashboardId) {
  const dc = dashboardClause(dashboardId);
  const salesWhere = sourceClause(source);
  const clicksWhere = sourceClause(source);
  const spendWhere = sourceClause(source);
  const pd = period && period.sql ? { sql: period.sql, params: period.params } : { sql: "", params: [] };

  const spendRows = all(
    `SELECT substr(created_at, 1, 10) AS day, COALESCE(SUM(amount_cents), 0) AS amount
     FROM advertising_spend WHERE 1=1${dc.sql}${spendWhere.sql}${pd.sql}
     GROUP BY day`,
    [...dc.params, ...spendWhere.params, ...pd.params]
  );

  const clickRows = all(
    `SELECT substr(created_at, 1, 10) AS day, COALESCE(SUM(quantity), 0) AS count
     FROM clicks WHERE 1=1${dc.sql}${clicksWhere.sql}${pd.sql}
     GROUP BY day`,
    [...dc.params, ...clicksWhere.params, ...pd.params]
  );

  const saleRows = all(
    `SELECT substr(created_at, 1, 10) AS day,
            COALESCE(SUM(CASE WHEN status = 'approved' THEN quantity ELSE 0 END), 0) AS approved,
            COALESCE(SUM(CASE WHEN status = 'approved' THEN amount_cents ELSE 0 END), 0) AS revenue,
            COALESCE(SUM(CASE WHEN status IN ('refunded','chargeback') THEN amount_cents ELSE 0 END), 0) AS refunds
     FROM sales WHERE 1=1${dc.sql}${salesWhere.sql}${pd.sql}
     GROUP BY day`,
    [...dc.params, ...salesWhere.params, ...pd.params]
  );

  const byDay = new Map();
  const init = (day) => {
    if (!byDay.has(day)) {
      byDay.set(day, { date: day, spendCents: 0, clicks: 0, revenueCents: 0, refundCents: 0, profitCents: 0 });
    }
    return byDay.get(day);
  };

  for (const row of spendRows) init(row.day).spendCents = Number(row.amount) || 0;
  for (const row of clickRows) init(row.day).clicks = Number(row.count) || 0;
  for (const row of saleRows) {
    const entry = init(row.day);
    entry.revenueCents = Number(row.revenue) || 0;
    entry.refundCents = Number(row.refunds) || 0;
  }

  const days = [];
  for (const entry of byDay.values()) {
    entry.profitCents = entry.revenueCents - entry.refundCents - entry.spendCents;
    days.push(entry);
  }
  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const withEmptyBuckets = ensureEmptyDays(days, period);
  const totals = withEmptyBuckets.reduce(
    (acc, d) => {
      acc.spendCents += d.spendCents;
      acc.clicks += d.clicks;
      acc.revenueCents += d.revenueCents;
      acc.refundCents += d.refundCents;
      return acc;
    },
    { spendCents: 0, clicks: 0, revenueCents: 0, refundCents: 0 }
  );
  totals.empty = withEmptyBuckets.length === 0 || withEmptyBuckets.every((d) => d.spendCents === 0 && d.clicks === 0 && d.revenueCents === 0);

  return { points: withEmptyBuckets, totals };
}

function ensureEmptyDays(days, period) {
  if (!period || !period.from || !period.to) return days;
  const from = new Date(period.from);
  const to = new Date(period.to);
  const DAY = 86400000;
  const maxPoints = 92;
  const totalDays = Math.min(
    maxPoints,
    Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY))
  );
  const map = new Map(days.map((d) => [d.date, d]));
  const result = [];
  const toIso = (date) => date.toISOString().slice(0, 10);
  const startDay = new Date(from.getTime() + 12 * 60 * 60 * 1000);
  for (let i = 0; i < totalDays; i++) {
    const date = new Date(startDay.getTime() + i * DAY);
    const key = toIso(date);
    const existing = map.get(key);
    if (existing) {
      result.push(existing);
    } else {
      result.push({ date: key, spendCents: 0, clicks: 0, revenueCents: 0, refundCents: 0, profitCents: 0 });
    }
  }
  return result;
}

function dashboardAggregates(source, period = null, dashboardId) {
  const dc = dashboardClause(dashboardId);
  const salesWhere = sourceClause(source);
  const clicksWhere = sourceClause(source);
  const spendWhere = sourceClause(source);
  const pd = period && period.sql ? { sql: period.sql, params: period.params } : { sql: "", params: [] };
  const approved = get(
    `SELECT COALESCE(SUM(quantity), 0) AS count, COALESCE(SUM(amount_cents), 0) AS amount FROM sales WHERE status = 'approved'${dc.sql}${salesWhere.sql}${pd.sql}`,
    [...dc.params, ...salesWhere.params, ...pd.params]
  );
  const refunded = get(
    `SELECT COALESCE(SUM(amount_cents), 0) AS amount FROM sales WHERE status IN ('refunded', 'chargeback')${dc.sql}${salesWhere.sql}${pd.sql}`,
    [...dc.params, ...salesWhere.params, ...pd.params]
  );
  const totalSales = get(`SELECT COALESCE(SUM(quantity), 0) AS n FROM sales WHERE 1=1${dc.sql}${salesWhere.sql}${pd.sql}`, [...dc.params, ...salesWhere.params, ...pd.params]).n;
  const pendingSales = get(`SELECT COALESCE(SUM(quantity), 0) AS n FROM sales WHERE status = 'pending'${dc.sql}${salesWhere.sql}${pd.sql}`, [...dc.params, ...salesWhere.params, ...pd.params]).n;
  const clickCount = get(`SELECT COALESCE(SUM(quantity), 0) AS n FROM clicks WHERE 1=1${dc.sql}${clicksWhere.sql}${pd.sql}`, [...dc.params, ...clicksWhere.params, ...pd.params]).n;
  const checkoutCount = get(`SELECT COUNT(*) AS n FROM checkouts WHERE 1=1${dc.sql}${pd.sql}`, [...dc.params, ...pd.params]).n;
  const spendCents = get(
    `SELECT COALESCE(SUM(amount_cents), 0) AS amount FROM advertising_spend WHERE 1=1${dc.sql}${spendWhere.sql}${pd.sql}`,
    [...dc.params, ...spendWhere.params, ...pd.params]
  ).amount;
  return {
    approvedCount: approved.count,
    approvedRevenueCents: approved.amount,
    refundCents: refunded.amount,
    totalSales,
    pendingSales,
    clickCount,
    checkoutCount,
    spendCents,
  };
}

module.exports = {
  open,
  close,
  getDb: checkDb,
  transaction,
  exec,
  get,
  all,
  run,
  makeId,
  getUserByEmail,
  getUserById,
  createUser,
  publicUser,
  createSession,
  deleteSession,
  getUserByToken,
  pruneExpiredSessions,
  insertClick,
  createClick,
  listClicks,
  countClicks,
  findClickByTrackroiId,
  findClickDashboardByTrackroiId,
  insertCheckout,
  createCheckout,
  listCheckouts,
  countCheckouts,
  insertSale,
  upsertSale,
  findSaleByTx,
  listSales,
  countSales,
  insertWebhookEvent,
  hasWebhookEvent,
  listWebhookEvents,
  countWebhookEvents,
  insertSpend,
  createSpend,
  insertImportRun,
  listImportRuns,
  listDashboards,
  getDashboard,
  countDashboards,
  createDashboard,
  ensureDefaultDashboard,
  insertAuditLog,
  appendAuditLog,
  listAuditLogs,
  countAuditLogs,
  insertProduct,
  createProduct,
  listProducts,
  upsertIntegration,
  getIntegration,
  listIntegrations,
  listDashboardsWithIntegration,
  updateIntegrationField,
  setSettings,
  getSettings,
  createCsrfToken,
  verifyCsrfToken,
  pruneCsrfTokens,
  recordLoginAttempt,
  resetLoginAttempts,
  isRateLimited,
  pruneLoginAttempts,
  dashboardAggregates,
  dailyTrend,
  migrateStateJson,
  seedAdminIfNeeded,
  dbPath: DB_FILE,
};