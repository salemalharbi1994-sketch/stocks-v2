// Vercel Serverless Function - يجلب بيانات الأسهم
// أولوية: SAHMK (للسوق السعودي) -> Stooq -> Yahoo
// SAHMK: مرخّص رسمياً من تداول - بيانات أدق

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  const { symbol, range = '3mo', interval = '1d', source = 'auto' } = req.query;

  if (!symbol) {
    return res.status(400).json({ error: 'يجب تحديد رمز السهم' });
  }

  const isSaudi = symbol.endsWith('.SR');
  const isIntraday = interval === '15m' || interval === '1h' || interval === '30m';
  const SAHMK_KEY = process.env.SAHMK_API_KEY;

  // ============ SAHMK PRIORITY (Saudi stocks only) ============
  if (isSaudi && SAHMK_KEY && source !== 'yahoo' && source !== 'stooq') {
    try {
      const sahmkData = await fetchFromSAHMK(symbol, SAHMK_KEY, interval);
      if (sahmkData && sahmkData.ohlc && sahmkData.ohlc.length >= 30) {
        return res.status(200).json({
          ...sahmkData,
          source: 'sahmk',
          interval,
          lastUpdate: new Date().toISOString(),
        });
      }
    } catch (e) {
      console.log('SAHMK failed:', e.message);
      // Fall through to other sources
    }
  }

  // ============ STOOQ (US daily/weekly) ============
  if (!isIntraday && !isSaudi) {
    try {
      const stooqData = await fetchFromStooq(symbol, interval);
      if (stooqData && stooqData.ohlc && stooqData.ohlc.length >= 30) {
        return res.status(200).json({
          ...stooqData,
          source: 'stooq',
          interval,
          lastUpdate: new Date().toISOString(),
        });
      }
    } catch (e) {
      console.log('Stooq failed:', e.message);
    }
  }

  // ============ YAHOO (Fallback) ============
  try {
    let yahooRange = range;
    if (interval === '15m') yahooRange = '5d';
    else if (interval === '1h') yahooRange = '1mo';
    else if (interval === '1wk') yahooRange = '2y';
    const yahooData = await fetchFromYahoo(symbol, yahooRange, interval);
    if (yahooData) {
      return res.status(200).json({
        ...yahooData,
        source: 'yahoo',
        lastUpdate: new Date().toISOString(),
      });
    }
  } catch (e) {
    console.log('Yahoo failed:', e.message);
  }

  return res.status(503).json({
    error: 'فشل جلب البيانات من جميع المصادر',
    details: 'حاول مرة أخرى بعد قليل',
  });
}

// =================== SAHMK API ===================
// مرخّص من تداول - الأكثر دقة للسوق السعودي
// Docs: https://www.sahmk.sa/en/developers/docs
async function fetchFromSAHMK(symbol, apiKey, interval = '1d') {
  // Convert "2222.SR" -> "2222" for SAHMK
  const cleanSymbol = symbol.replace('.SR', '');

  // SAHMK period mapping
  const sahmkPeriod = interval === '1wk' ? 'weekly'
    : interval === '1mo' ? 'monthly'
    : 'daily';

  // Get historical data
  const url = `https://app.sahmk.sa/api/v1/historical/${cleanSymbol}/?period=${sahmkPeriod}&limit=120`;

  const response = await fetch(url, {
    headers: {
      'X-API-Key': apiKey,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    if (response.status === 401) throw new Error('SAHMK: API key invalid');
    if (response.status === 429) throw new Error('SAHMK: Rate limit exceeded');
    throw new Error(`SAHMK returned ${response.status}`);
  }

  const data = await response.json();

  // Expected: { symbol, name, name_en, data: [...] }
  if (!data || !data.data || !Array.isArray(data.data)) {
    throw new Error('SAHMK: Invalid response format');
  }

  // Map to standard OHLC format
  const ohlc = data.data.map(d => ({
    date: d.date || d.timestamp,
    open: parseFloat(d.open) || parseFloat(d.close),
    high: parseFloat(d.high) || parseFloat(d.close),
    low: parseFloat(d.low) || parseFloat(d.close),
    close: parseFloat(d.close),
    volume: parseInt(d.volume) || 0,
  })).filter(d => !isNaN(d.close));

  // Normalize to oldest first
  ohlc.sort((a, b) => new Date(a.date) - new Date(b.date));

  if (ohlc.length < 30) throw new Error('SAHMK: Insufficient data');

  // Try to get latest quote (more accurate than historical close)
  let lastQuote = null;
  try {
    const quoteUrl = `https://app.sahmk.sa/api/v1/quote/${cleanSymbol}/`;
    const quoteRes = await fetch(quoteUrl, {
      headers: { 'X-API-Key': apiKey },
    });
    if (quoteRes.ok) {
      lastQuote = await quoteRes.json();
    }
  } catch (e) {
    // Use last OHLC close as fallback
  }

  const last = ohlc[ohlc.length - 1];
  const prev = ohlc[ohlc.length - 2];

  return {
    symbol,
    name: data.name_en || data.name,
    nameAr: data.name,
    currency: 'SAR',
    regularMarketPrice: lastQuote?.price || last.close,
    previousClose: prev ? prev.close : last.close,
    marketState: lastQuote?.is_delayed ? 'DELAYED' : 'REGULAR',
    exchangeName: 'Tadawul',
    isDelayed: lastQuote?.is_delayed !== false,
    ohlc,
  };
}

// =================== STOOQ (for US stocks) ===================
async function fetchFromStooq(symbol, interval = '1d') {
  let stooqSymbol = symbol;

  if (symbol.endsWith('.SR')) {
    throw new Error('Saudi stock - using other sources');
  } else if (!symbol.includes('.')) {
    stooqSymbol = symbol.toLowerCase() + '.us';
  }

  const stooqInterval = interval === '1wk' ? 'w' : interval === '1mo' ? 'm' : 'd';
  const url = `https://stooq.com/q/d/l/?s=${stooqSymbol}&i=${stooqInterval}`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });

  if (!response.ok) throw new Error(`Stooq returned ${response.status}`);

  const csv = await response.text();
  if (!csv || csv.length < 100 || csv.includes('Brak danych')) {
    throw new Error('No data from Stooq');
  }

  const lines = csv.trim().split('\n');
  if (lines.length < 31) throw new Error('Insufficient Stooq data');

  const ohlc = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < 5) continue;
    const close = parseFloat(parts[4]);
    if (isNaN(close)) continue;
    ohlc.push({
      date: parts[0],
      open: parseFloat(parts[1]) || close,
      high: parseFloat(parts[2]) || close,
      low: parseFloat(parts[3]) || close,
      close: close,
      volume: parseInt(parts[5]) || 1000000,
    });
  }

  const recent = ohlc.slice(-90);
  const last = recent[recent.length - 1];
  const prev = recent[recent.length - 2];

  return {
    symbol,
    currency: 'USD',
    regularMarketPrice: last.close,
    previousClose: prev.close,
    marketState: 'REGULAR',
    exchangeName: 'Stooq',
    ohlc: recent,
  };
}

// =================== YAHOO (Fallback) ===================
async function fetchFromYahoo(symbol, range, interval = '1d') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}&includePrePost=false`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!response.ok) throw new Error(`Yahoo returned ${response.status}`);

  const data = await response.json();
  const result = data.chart?.result?.[0];
  if (!result) throw new Error('No Yahoo result');

  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const meta = result.meta || {};

  const ohlc = timestamps.map((ts, i) => ({
    date: new Date(ts * 1000).toISOString().split('T')[0],
    open: quote.open?.[i] != null ? +quote.open[i].toFixed(2) : null,
    high: quote.high?.[i] != null ? +quote.high[i].toFixed(2) : null,
    low: quote.low?.[i] != null ? +quote.low[i].toFixed(2) : null,
    close: quote.close?.[i] != null ? +quote.close[i].toFixed(2) : null,
    volume: quote.volume?.[i] || 0,
  })).filter(d => d.close !== null);

  if (ohlc.length < 30) throw new Error('Insufficient Yahoo data');

  return {
    symbol: meta.symbol || symbol,
    currency: meta.currency || 'USD',
    regularMarketPrice: meta.regularMarketPrice,
    previousClose: meta.chartPreviousClose,
    marketState: meta.marketState,
    exchangeName: meta.exchangeName,
    ohlc,
  };
}
