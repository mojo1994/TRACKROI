const crypto = require("crypto");

const COLUMN_MAPS = {
  campaignName: [
    "titulo do conjunto de anuncios", "título do conjunto de anúncios",
    "ad set name", "adset name", "conjunto de anuncios", "conjunto de anúncios",
    "nome do conjunto de anuncios", "nome do conjunto de anúncios",
    "campaign name", "titulo da campanha", "título da campanha",
    "nome da campanha", "campanha",
  ],
  adName: [
    "titulo do anuncio", "título do anúncio", "ad name",
    "nome do anuncio", "nome do anúncio", "anuncio", "anúncio",
  ],
  dateStart: [
    "data de inicio", "data de início", "date", "data",
    "periodo de relatorio", "período de relatório", "reporting period",
    "data do relatorio", "data do relatório",
  ],
  amountSpent: [
    "gasto", "valor gasto", "amount spent", "spend", "investimento",
    "custo", "cost", "gastos",
  ],
  reach: ["alcance", "reach", "pessoas alcancadas", "pessoas alcançadas"],
  impressions: ["impressoes", "impressões", "impressions", "imp"],
  linkClicks: [
    "cliques no link", "cliques", "link clicks", "clicks",
    "cliq no link", "clique", "click",
  ],
  ctr: ["ctr", "taxa de cliques", "click-through rate"],
  cpc: ["cpc", "custo por clique", "cost per click", "cost per link click"],
  cpm: ["cpm", "custo por mil", "cost per mille"],
  results: ["resultados", "results", "conversoes", "conversões", "conversions"],
  costPerResult: [
    "custo por resultado", "cost per result",
    "custo por conversao", "custo por conversão",
  ],
  purchases: ["compras", "purchases", "purchase", "vendas"],
  purchaseValue: [
    "valor de compra", "purchase value", "valor das compras",
    "purchase revenue", "receita de compra", "valor",
  ],
  roas: ["roas", "retorno sobre gasto com anuncios"],
};

const MONEY_PATTERN = /^[\s]*R?\$?\s*([\d.,]+)\s*$/;
const NUMBER_PATTERN = /^[\s]*([\d.,]+)\s*$/;

function stripBom(text) {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        cells.push(current);
        current = "";
      } else if (ch === "\r") {
        continue;
      } else {
        current += ch;
      }
    }
  }
  cells.push(current);
  return cells;
}

function parseCsv(content) {
  const text = stripBom(String(content).replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
  const lines = text.split("\n").filter((line) => line.trim());
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const row = {};
    headers.forEach((header, index) => {
      row[header.trim()] = (cells[index] || "").trim();
    });
    rows.push(row);
  }
  return { headers, rows };
}

function normalizeHeader(header) {
  return header
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .trim();
}

function detectColumns(headers) {
  const mapping = {};
  const normalizedHeaders = headers.map((header) => normalizeHeader(header));
  for (const [field, aliases] of Object.entries(COLUMN_MAPS)) {
    const sortedAliases = [...aliases].sort((a, b) => b.length - a.length);
    for (let i = 0; i < normalizedHeaders.length; i++) {
      for (const alias of sortedAliases) {
        if (normalizedHeaders[i].includes(alias)) {
          mapping[field] = headers[i];
          break;
        }
      }
      if (mapping[field]) break;
    }
  }
  return mapping;
}

function parseMoney(value) {
  if (value == null) return 0;
  const str = String(value).trim();
  if (!str) return 0;
  const match = str.match(MONEY_PATTERN);
  let numStr = match ? match[1] : str.match(NUMBER_PATTERN) ? NUMBER_PATTERN.exec(str)[1] : str;
  if (numStr.includes(",") && numStr.includes(".")) {
    if (numStr.lastIndexOf(",") > numStr.lastIndexOf(".")) {
      numStr = numStr.replace(/\./g, "").replace(",", ".");
    } else {
      numStr = numStr.replace(/,/g, "");
    }
  } else if (numStr.includes(",")) {
    numStr = numStr.replace(",", ".");
  }
  const result = parseFloat(numStr);
  return Number.isFinite(result) ? result : 0;
}

function parseNumber(value) {
  if (value == null) return 0;
  const str = String(value).trim().replace(/[.%]/g, "");
  if (!str) return 0;
  let numStr = str;
  if (numStr.includes(",") && numStr.includes(".")) {
    if (numStr.lastIndexOf(",") > numStr.lastIndexOf(".")) {
      numStr = numStr.replace(/\./g, "").replace(",", ".");
    } else {
      numStr = numStr.replace(/,/g, "");
    }
  } else if (numStr.includes(",")) {
    numStr = numStr.replace(",", ".");
  }
  const result = parseFloat(numStr);
  return Number.isFinite(result) ? result : 0;
}

function parseDate(value) {
  if (!value) return null;
  const str = String(value).trim();
  const ddmmyyyy = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (ddmmyyyy) {
    return `${ddmmyyyy[3]}-${ddmmyyyy[2].padStart(2, "0")}-${ddmmyyyy[1].padStart(2, "0")}T00:00:00.000Z`;
  }
  const yyyymmdd = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (yyyymmdd) {
    return `${yyyymmdd[1]}-${yyyymmdd[2].padStart(2, "0")}-${yyyymmdd[3].padStart(2, "0")}T00:00:00.000Z`;
  }
  const dateObj = new Date(str);
  if (!Number.isNaN(dateObj.getTime())) return dateObj.toISOString();
  return null;
}

function transformRow(row, columnMap) {
  const campaignName = columnMap.campaignName ? row[columnMap.campaignName] : null;
  const adName = columnMap.adName ? row[columnMap.adName] : null;
  const dateStart = columnMap.dateStart ? row[columnMap.dateStart] : null;
  const amountSpent = columnMap.amountSpent ? parseMoney(row[columnMap.amountSpent]) : 0;
  const reach = columnMap.reach ? parseNumber(row[columnMap.reach]) : 0;
  const impressions = columnMap.impressions ? parseNumber(row[columnMap.impressions]) : 0;
  const linkClicks = columnMap.linkClicks ? parseNumber(row[columnMap.linkClicks]) : 0;
  const ctr = columnMap.ctr ? parseNumber(row[columnMap.ctr]) : 0;
  const cpc = columnMap.cpc ? parseMoney(row[columnMap.cpc]) : 0;
  const results = columnMap.results ? parseNumber(row[columnMap.results]) : 0;
  const costPerResult = columnMap.costPerResult ? parseMoney(row[columnMap.costPerResult]) : 0;
  const purchases = columnMap.purchases ? parseNumber(row[columnMap.purchases]) : 0;
  const purchaseValue = columnMap.purchaseValue ? parseMoney(row[columnMap.purchaseValue]) : 0;

  return {
    campaignName: campaignName || "Campanha importada",
    adName: adName || "",
    dateStart: parseDate(dateStart),
    amountSpentCents: Math.round(amountSpent * 100),
    reach,
    impressions,
    linkClicks,
    ctr,
    cpcCents: Math.round(cpc * 100),
    results,
    costPerResultCents: Math.round(costPerResult * 100),
    purchases,
    purchaseValueCents: Math.round(purchaseValue * 100),
    source: "meta",
  };
}

function importCsv(content) {
  const { headers, rows } = parseCsv(content);
  if (rows.length === 0) {
    return { ok: false, error: "Nenhum dado encontrado na planilha. Verifique se o arquivo CSV está correto." };
  }
  if (headers.length < 2) {
    return { ok: false, error: "Formato inválido. O arquivo deve ser um CSV com cabeçalhos e dados." };
  }
  const columnMap = detectColumns(headers);
  if (columnMap.adName && columnMap.campaignName && columnMap.adName === columnMap.campaignName) {
    delete columnMap.adName;
  }
  const mappedFields = Object.keys(columnMap);
  if (mappedFields.length === 0) {
    return {
      ok: false,
      error: "Não foi possível identificar colunas da Meta Ads. Colunas encontradas: " + headers.join(", "),
    };
  }
  const spendColumn = columnMap.amountSpent;
  if (!spendColumn) {
    return {
      ok: false,
      error: "Coluna de gasto/investimento não encontrada. Colunas disponíveis: " + headers.join(", "),
    };
  }
  const importId = `imp_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const spendRecords = [];
  const clicksRecords = [];
  const salesRecords = [];
  const seenCampaigns = new Set();
  let totalSpendCents = 0;
  let totalClicks = 0;
  let totalImpressions = 0;
  let totalReach = 0;
  let totalPurchases = 0;
  let totalPurchaseValueCents = 0;
  const nowBase = Date.now();

  for (const row of rows) {
    const transformed = transformRow(row, columnMap);
    if (transformed.amountSpentCents > 0) {
      const createdAt = transformed.dateStart || new Date().toISOString();
      spendRecords.push({
        id: `sp_${nowBase}_${crypto.randomBytes(4).toString("hex")}`,
        source: "meta",
        amountCents: transformed.amountSpentCents,
        currency: "BRL",
        createdAt,
      });
      totalSpendCents += transformed.amountSpentCents;
    }
    if (transformed.linkClicks > 0) {
      const createdAt = transformed.dateStart || new Date().toISOString();
      clicksRecords.push({
        id: `cl_${nowBase}_${crypto.randomBytes(4).toString("hex")}`,
        trackroiClickId: `trk_${crypto.randomBytes(6).toString("hex")}`,
        source: "meta",
        campaignId: transformed.campaignName || null,
        adsetId: transformed.adName || null,
        adId: null,
        landingPage: "/",
        referrer: null,
        fbclid: null,
        quantity: transformed.linkClicks,
        createdAt,
      });
      totalClicks += transformed.linkClicks;
      totalImpressions += transformed.impressions;
      totalReach += transformed.reach;
    }
    if (transformed.purchases > 0) {
      totalPurchases += transformed.purchases;
      totalPurchaseValueCents += transformed.purchaseValueCents;
      const saleValueCents = transformed.purchaseValueCents > 0 ? transformed.purchaseValueCents : Math.round(transformed.purchases * 2990);
      const saleDate = transformed.dateStart || new Date().toISOString();
      salesRecords.push({
        id: `sa_${nowBase}_${crypto.randomBytes(4).toString("hex")}`,
        gateway: "meta",
        gatewayTransactionId: `imp_${importId}_${crypto.randomBytes(4).toString("hex")}`,
        eventType: "approved",
        status: "approved",
        amountCents: saleValueCents,
        currency: "BRL",
        trackroiClickId: null,
        source: "meta",
        quantity: transformed.purchases,
        createdAt: saleDate,
        updatedAt: saleDate,
      });
    }
    seenCampaigns.add(transformed.campaignName);
  }

  return {
    ok: true,
    importId,
    columnMap,
    mappedFields,
    totalRows: rows.length,
    campaigns: Array.from(seenCampaigns),
    stats: {
      totalSpendCents,
      totalClicks,
      totalImpressions,
      totalReach,
      totalPurchases,
      totalPurchaseValueCents,
    },
    spendRecords,
    clicksRecords,
    salesRecords,
    rawHeaders: headers,
  };
}

module.exports = {
  importCsv,
  parseCsv,
  detectColumns,
  parseMoney,
  parseNumber,
  parseDate,
};
