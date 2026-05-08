// Vercel Serverless Function - يجلب بيانات الأسهم من Yahoo Finance
// يحل مشكلة CORS ويعمل كوسيط بين المتصفح و Yahoo

export default async function handler(req, res) {
  // السماح بالطلبات من أي مصدر (CORS)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');

  const { symbol, range = '3mo', interval = '1d' } = req.query;

  if (!symbol) {
    return res.status(400).json({ error: 'يجب تحديد رمز السهم' });
  }

  try {
    // Yahoo Finance API endpoint
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}&includePrePost=false`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Yahoo Finance returned ${response.status}`);
    }

    const data = await response.json();
    const result = data.chart?.result?.[0];

    if (!result) {
      return res.status(404).json({ error: 'لم يتم العثور على بيانات السهم' });
    }

    // استخراج البيانات بصيغة OHLCV
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

    return res.status(200).json({
      symbol: meta.symbol,
      currency: meta.currency,
      regularMarketPrice: meta.regularMarketPrice,
      previousClose: meta.chartPreviousClose,
      marketState: meta.marketState,
      exchangeName: meta.exchangeName,
      ohlc,
      lastUpdate: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error fetching stock data:', error);
    return res.status(500).json({
      error: 'فشل جلب البيانات',
      details: error.message,
    });
  }
}
