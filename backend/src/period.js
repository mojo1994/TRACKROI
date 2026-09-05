const PERIOD_LABELS = {
  today: "Hoje",
  yesterday: "Ontem",
  "7d": "Últimos 7 dias",
  "30d": "Últimos 30 dias",
  custom: "Período personalizado",
};

const DAY = 86400000;

function resolvePeriod(query = {}) {
  const today = new Date();
  const startToday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const key = String(query.period || "30d").toLowerCase();
  let from;
  let to;
  let label = null;

  if (key === "today") {
    from = startToday;
    to = new Date(startToday.getTime() + DAY);
    label = PERIOD_LABELS.today;
  } else if (key === "yesterday") {
    from = new Date(startToday.getTime() - DAY);
    to = startToday;
    label = PERIOD_LABELS.yesterday;
  } else if (key === "7d") {
    from = new Date(startToday.getTime() - 6 * DAY);
    to = new Date(startToday.getTime() + DAY);
    label = PERIOD_LABELS["7d"];
  } else if (key === "custom") {
    const toParts = String(query.to || query.from || "").split("-");
    const fromParts = String(query.from || query.to || "").split("-");
    if (fromParts.length === 3 && toParts.length === 3) {
      const f = new Date(Date.UTC(Number(fromParts[0]), Number(fromParts[1]) - 1, Number(fromParts[2])));
      const t = new Date(Date.UTC(Number(toParts[0]), Number(toParts[1]) - 1, Number(toParts[2]) + 1));
      if (!Number.isNaN(f.getTime()) && !Number.isNaN(t.getTime()) && f.getTime() < t.getTime()) {
        from = f;
        to = t;
        label = PERIOD_LABELS.custom;
      }
    }
  }
  if (!from || !to) {
    from = new Date(startToday.getTime() - 29 * DAY);
    to = new Date(startToday.getTime() + DAY);
    label = PERIOD_LABELS["30d"];
  }

  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY));
  return {
    key,
    label,
    days,
    from: from.toISOString(),
    to: to.toISOString(),
    sql: " AND created_at >= ? AND created_at < ?",
    params: [from.toISOString(), to.toISOString()],
  };
}

module.exports = {
  resolvePeriod,
  PERIOD_LABELS,
  DAY,
};