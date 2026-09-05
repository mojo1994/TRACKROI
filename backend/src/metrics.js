function normalizeMoney(cents, currency = "BRL") {
  const value = Number(cents || 0) / 100;
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatNumber(value, digits = 0) {
  if (value == null || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

function ratio(numerator, denominator) {
  if (!denominator) return null;
  return numerator / denominator;
}

function matchSource(item, source) {
  if (!source || source === "all") return true;
  return String(item.source || "").toLowerCase() === source.toLowerCase();
}

function buildDashboard(state, query = {}) {
  const source = query.source || "all";
  const clicks = state.clicks.filter((item) => matchSource(item, source));
  const checkouts = state.checkouts.filter((item) => matchSource(item, source));
  const sales = state.sales.filter((item) => {
    if (source === "all") return true;
    if (source === "direct") return !item.source || item.source === "direct";
    return String(item.source || "").toLowerCase() === source.toLowerCase();
  });
  const spendCents = state.advertisingSpend
    .filter((row) => matchSource(row, source))
    .reduce((sum, row) => sum + Number(row.amountCents || 0), 0);
  const revenueCents = sales.filter((sale) => sale.status === "approved").reduce((sum, sale) => sum + Number(sale.amountCents || 0), 0);
  const refundCents = sales.filter((sale) => sale.status === "refunded" || sale.status === "chargeback").reduce((sum, sale) => sum + Number(sale.amountCents || 0), 0);
  const netRevenueCents = revenueCents - refundCents;
  const profitCents = netRevenueCents - spendCents;
  const approvedSales = sales.filter((sale) => sale.status === "approved").length;
  const pendingSales = sales.filter((sale) => sale.status === "pending").length;
  const totalSales = sales.length;
  const clickCount = clicks.length;
  const checkoutCount = checkouts.length;
  const roas = ratio(netRevenueCents, spendCents);
  const roi = ratio(profitCents, spendCents);
  const cpa = ratio(spendCents / 100, approvedSales);
  const cvr = ratio(approvedSales, clickCount);
  const aov = ratio(revenueCents / 100, approvedSales);
  const funnel = [
    { key: "clicks", label: "Cliques", count: clickCount },
    { key: "pageview", label: "Visita à Página", count: clickCount },
    { key: "checkout", label: "Iniciar Checkout", count: checkoutCount },
    { key: "approved", label: "Venda Aprovada", count: approvedSales },
  ];

  const hasData = clickCount > 0 || checkoutCount > 0 || approvedSales > 0 || spendCents > 0;

  return {
    ok: true,
    empty: !hasData,
    filters: { source },
    summary: {
      spendCents,
      revenueCents,
      netRevenueCents,
      profitCents,
      refundCents,
      roas,
      roi,
      cpa,
      cvr,
      aov,
      approvedSales,
      pendingSales,
      totalSales,
      clickCount,
      checkoutCount,
    },
    cards: [
      { key: "spend", label: "Investimento", value: normalizeMoney(spendCents), tone: "neutral" },
      { key: "revenue", label: "Receita", value: normalizeMoney(revenueCents), tone: "neutral" },
      { key: "profit", label: "Lucro", value: normalizeMoney(profitCents), tone: profitCents >= 0 ? "positive" : "negative" },
      { key: "roas", label: "ROAS", value: roas == null ? "—" : formatNumber(roas, 2), tone: roas != null && roas >= 1 ? "positive" : roas != null ? "negative" : "neutral" },
      { key: "roi", label: "ROI", value: roi == null ? "—" : `${formatNumber(roi * 100, 1)}%`, tone: roi != null && roi >= 0 ? "positive" : roi != null ? "negative" : "neutral" },
      { key: "cpa", label: "CPA", value: cpa == null ? "—" : normalizeMoney(cpa * 100), tone: "neutral" },
    ],
    funnel: {
      empty: !hasData,
      stages: funnel.map((stage, index) => {
        const previous = index === 0 ? stage.count : funnel[index - 1].count;
        const first = funnel[0].count;
        return {
          ...stage,
          previousCount: previous,
          conversion: index === 0 ? 100 : ratio(stage.count, previous) == null ? null : ratio(stage.count, previous) * 100,
          firstStageConversion: index === 0 ? 100 : ratio(stage.count, first) == null ? null : ratio(stage.count, first) * 100,
        };
      }),
    },
    sales: sales.slice().reverse(),
    clicks: clicks.slice().reverse(),
    checkouts: checkouts.slice().reverse(),
    integrations: state.integrations,
    settings: state.settings,
    auditLogs: state.auditLogs.slice().reverse(),
    products: state.products,
  };
}

module.exports = {
  buildDashboard,
  normalizeMoney,
  formatNumber,
  ratio,
};
