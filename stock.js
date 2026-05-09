// Vercel Serverless Function - يجلب بيانات الأسهم
// يستخدم Stooq كمصدر أساسي (لا يحظر) و Yahoo كاحتياطي

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  const { symbol, range = '3mo', interval = '1d' } = req.query;

  if (!symbol) {
    return res.status(400).json({ error: 'يجب تحديد رمز السهم' });
  }

  // For intraday timeframes (15m, 1h), Stooq doesn't support, use Yahoo only
  const isIntraday = interval === '15m' || interval === '1h' || interval === '30m';

  // For daily/weekly: Try Stooq first
  if (!isIntraday) {
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

  // Fallback to Yahoo (or primary for intraday)
  try {
    // Adjust range for intraday
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

// =================== STOOQ ===================
async function fetchFromStooq(symbol, interval = '1d') {
  // Convert symbol format for Stooq
  // Apple: AAPL.US
  // Saudi: 1120.SR -> 1120.AB (Stooq uses .AB for Saudi)
  let stooqSymbol = symbol;

  if (symbol.endsWith('.SR')) {
    throw new Error('Saudi stock - using Yahoo');
  } else if (!symbol.includes('.')) {
    stooqSymbol = symbol.toLowerCase() + '.us';
  }

  // Stooq interval: d=daily, w=weekly, m=monthly
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

  // Parse CSV (Date,Open,High,Low,Close,Volume)
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

  // Take last 90 days
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

// =================== YAHOO (FALLBACK) ===================
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
