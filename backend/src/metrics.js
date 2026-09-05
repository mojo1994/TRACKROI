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

function computeLaborCostCents(finance, period) {
  if (!finance) return 0;
  const perDay = Math.max(0, Number(finance.laborCostPerDay) || 0);
  const monthly = Math.max(0, Number(finance.laborCostMonthly) || 0);
  const days = Math.max(1, Number(period?.days) || 30);
  const dailyPart = perDay * days;
  const monthlyPart = monthly ? monthly * (days / 30) : 0;
  return Math.round((dailyPart + monthlyPart) * 100);
}

function buildDashboardFromAggregates({ aggregates, source = "all", period = null, finance = null }) {
  const {
    approvedCount = 0,
    approvedRevenueCents = 0,
    refundCents = 0,
    totalSales = 0,
    pendingSales = 0,
    clickCount = 0,
    checkoutCount = 0,
    spendCents = 0,
  } = aggregates || {};

  const netRevenueCents = approvedRevenueCents - refundCents;
  const grossProfitCents = netRevenueCents - spendCents;
  const laborCostCents = computeLaborCostCents(finance, period);
  const operatingProfitCents = grossProfitCents - laborCostCents;
  const roas = ratio(netRevenueCents, spendCents);
  const roi = ratio(operatingProfitCents, spendCents);
  const cpa = ratio(spendCents / 100, approvedCount);
  const cvr = ratio(approvedCount, clickCount);
  const aov = ratio(approvedRevenueCents / 100, approvedCount);

  const funnel = [
    { key: "clicks", label: "Cliques", count: clickCount },
    { key: "pageview", label: "Visitas na Página", count: clickCount },
    { key: "checkout", label: "Iniciar Checkout", count: checkoutCount },
    { key: "sales", label: "Vendas Geradas", count: totalSales },
    { key: "approved", label: "Vendas Aprovadas", count: approvedCount },
  ];

  const hideProfit = approvedRevenueCents === 0 && spendCents === 0;
  const hasData = clickCount > 0 || checkoutCount > 0 || approvedCount > 0 || spendCents > 0;

  return {
    ok: true,
    empty: !hasData,
    filters: { source, period: period ? { key: period.key, label: period.label, days: period.days, from: period.from, to: period.to } : null },
    summary: {
      period: period ? { key: period.key, label: period.label, days: period.days, from: period.from, to: period.to } : null,
      finance: {
        adSpendCents: spendCents,
        revenueCents: approvedRevenueCents,
        refundCents,
        grossProfitCents,
        laborCostCents,
        operatingProfitCents,
        laborCostPerDay: Math.max(0, Number(finance?.laborCostPerDay) || 0),
        laborCostMonthly: Math.max(0, Number(finance?.laborCostMonthly) || 0),
        roas,
        roi: hidableRatio(roi, hideProfit),
        cpa,
        cvr,
        aov,
        approved: approvedCount,
        pending: pendingSales,
        total: totalSales,
        clicks: clickCount,
        checkouts: checkoutCount,
        days: period?.days || null,
      },
      spendCents,
      revenueCents: approvedRevenueCents,
      netRevenueCents,
      profitCents: operatingProfitCents,
      grossProfitCents,
      laborCostCents,
      refundCents,
      roas,
      roi: hidableRatio(roi, hideProfit),
      cpa,
      cvr,
      aov,
      approvedSales: approvedCount,
      pendingSales,
      totalSales,
      clickCount,
      checkoutCount,
    },
    cards: [
      { key: "spend", label: "Investimento", value: normalizeMoney(spendCents), tone: "neutral" },
      { key: "revenue", label: "Receita", value: normalizeMoney(approvedRevenueCents), tone: "neutral" },
      { key: "profit", label: "Lucro bruto", value: normalizeMoney(grossProfitCents), tone: grossProfitCents >= 0 ? "positive" : "negative" },
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
  };
}

function hidableRatio(value, hide) {
  if (hide) return null;
  return value == null ? null : value;
}

module.exports = {
  buildDashboardFromAggregates,
  normalizeMoney,
  formatNumber,
  ratio,
};