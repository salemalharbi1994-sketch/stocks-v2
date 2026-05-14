// Vercel Serverless Function - بيانات الأسهم
// السوق السعودي: SAHMK /quote/ (سعر دقيق مرخّص) + Yahoo (تاريخ للرسم)
// السوق الأمريكي: Stooq -> Yahoo
// SAHMK Docs: https://www.sahmk.sa/en/developers/docs

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');

  const { symbol, range = '3mo', interval = '1d' } = req.query;

  if (!symbol) {
    return res.status(400).json({ error: 'يجب تحديد رمز السهم' });
  }

  const isSaudi = symbol.endsWith('.SR');
  const isIntraday = interval === '15m' || interval === '1h' || interval === '30m';
  const SAHMK_KEY = process.env.SAHMK_API_KEY;

  // ============ SAUDI: Yahoo history + SAHMK quote overlay ============
  if (isSaudi) {
    let yahooData = null;
    let yahooRange = range;
    if (interval === '15m') yahooRange = '5d';
    else if (interval === '1h') yahooRange = '1mo';
    else if (interval === '1wk') yahooRange = '2y';

    // 1. Get historical chart from Yahoo
    try {
      yahooData = await fetchFromYahoo(symbol, yahooRange, interval);
    } catch (e) {
      console.log('Yahoo (Saudi) failed:', e.message);
    }

    // 2. Get accurate current price from SAHMK quote (Free tier)
    let sahmkQuote = null;
    if (SAHMK_KEY) {
      try {
        sahmkQuote = await fetchSAHMKQuote(symbol, SAHMK_KEY);
      } catch (e) {
        console.log('SAHMK quote failed:', e.message);
      }
    }

    // 3. Merge: Yahoo chart + SAHMK accurate last price
    if (yahooData) {
      if (sahmkQuote && sahmkQuote.price) {
        // Overwrite the last candle's close with SAHMK accurate price
        const ohlc = yahooData.ohlc;
        if (ohlc.length > 0 && !isIntraday) {
          const last = ohlc[ohlc.length - 1];
          last.close = sahmkQuote.price;
          if (sahmkQuote.high) last.high = Math.max(last.high, sahmkQuote.high);
          if (sahmkQuote.low) last.low = Math.min(last.low, sahmkQuote.low);
          if (sahmkQuote.open) last.open = sahmkQuote.open;
          if (sahmkQuote.volume) last.volume = sahmkQuote.volume;
        }
        return res.status(200).json({
          ...yahooData,
          regularMarketPrice: sahmkQuote.price,
          previousClose: sahmkQuote.previousClose || yahooData.previousClose,
          name: sahmkQuote.nameEn || yahooData.name,
          nameAr: sahmkQuote.nameAr,
          source: 'sahmk+yahoo',
          isDelayed: sahmkQuote.isDelayed,
          interval,
          lastUpdate: new Date().toISOString(),
        });
      }
      // SAHMK unavailable - Yahoo only
      return res.status(200).json({
        ...yahooData,
        source: 'yahoo',
        interval,
        lastUpdate: new Date().toISOString(),
      });
    }

    // Yahoo failed but we have SAHMK quote - return minimal
    if (sahmkQuote && sahmkQuote.price) {
      return res.status(200).json({
        symbol,
        name: sahmkQuote.nameEn,
        nameAr: sahmkQuote.nameAr,
        currency: 'SAR',
        regularMarketPrice: sahmkQuote.price,
        previousClose: sahmkQuote.previousClose,
        marketState: sahmkQuote.isDelayed ? 'DELAYED' : 'REGULAR',
        exchangeName: 'Tadawul',
        isDelayed: sahmkQuote.isDelayed,
        ohlc: [],
        source: 'sahmk',
        warning: 'historical chart unavailable',
        lastUpdate: new Date().toISOString(),
      });
    }

    return res.status(503).json({ error: 'فشل جلب بيانات السهم السعودي' });
  }

  // ============ US: Stooq -> Yahoo ============
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

// =================== SAHMK QUOTE (Free tier) ===================
// GET /quote/{symbol}/  -- مجاني، 100 طلب/يوم، تأخير 15 دقيقة
// Docs: https://www.sahmk.sa/en/developers/docs#stocks
async function fetchSAHMKQuote(symbol, apiKey) {
  const cleanSymbol = symbol.replace('.SR', '');
  const url = `https://app.sahmk.sa/api/v1/quote/${cleanSymbol}/`;

  const response = await fetch(url, {
    headers: {
      'X-API-Key': apiKey,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    if (response.status === 401) throw new Error('SAHMK: API key invalid');
    if (response.status === 429) throw new Error('SAHMK: Rate limit (100/day)');
    if (response.status === 404) throw new Error('SAHMK: Symbol not found');
    throw new Error(`SAHMK returned ${response.status}`);
  }

  const data = await response.json();
  if (data.error) throw new Error(`SAHMK: ${data.error.code}`);
  if (!data.price && data.price !== 0) throw new Error('SAHMK: No price in response');

  return {
    symbol: data.symbol,
    nameAr: data.name,
    nameEn: data.name_en,
    price: parseFloat(data.price),
    change: parseFloat(data.change) || 0,
    changePercent: parseFloat(data.change_percent) || 0,
    open: data.open ? parseFloat(data.open) : null,
    high: data.high ? parseFloat(data.high) : null,
    low: data.low ? parseFloat(data.low) : null,
    previousClose: data.previous_close ? parseFloat(data.previous_close) : null,
    volume: data.volume ? parseInt(data.volume) : null,
    isDelayed: data.is_delayed !== false,
    updatedAt: data.updated_at,
  };
}

// =================== STOOQ (US stocks) ===================
async function fetchFromStooq(symbol, interval = '1d') {
  let stooqSymbol = symbol;
  if (symbol.endsWith('.SR')) {
    throw new Error('Saudi stock - not for Stooq');
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

// =================== YAHOO ===================
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
    name: meta.shortName || meta.longName,
    currency: meta.currency || 'USD',
    regularMarketPrice: meta.regularMarketPrice,
    previousClose: meta.chartPreviousClose,
    marketState: meta.marketState,
    exchangeName: meta.exchangeName,
    ohlc,
  };
}
