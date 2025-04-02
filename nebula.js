const mongoose = require('mongoose');
const WebSocket = require('ws');

// Configuration
const MONGODB_URI = 'mongodb://localhost:27017/DataBS';
const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
const TIMEFRAMES = [
  '1m', '3m', '5m', '15m', '30m',  // minutes
  '1h', '2h', '4h', '6h', '8h', '12h',  // hours
  '1d', '3d',  // days
  '1w',  // week
  '1M'   // month
];

// WebSocket server for broadcasting helix values
const WS_PORT = 3000;
const wss = new WebSocket.Server({ port: WS_PORT });
const connectedClients = new Set();

// Store models for each collection
const priceModels = {};
const candleModels = {};
let latestDataModel;
let closeTrackerModel;

// For tracking stats
const stats = {
  trades: { total: 0, btc: 0, eth: 0 },
  candles: { total: 0 },
  lastUpdate: Date.now(),
  startTime: Date.now()
};

// For storing latest data
const latestData = {
  prices: {},
  candles: {}
};

// Simple in-memory cache for candle data
const cache = {
  // Store open prices for each symbol and timeframe
  // Structure: { BTCUSDT: { '1m': { open: '45000', openTime: 123456789 }, '3m': {...} }, ETHUSDT: {...} }
  openPrices: {},
  
  // Store latest close prices (current price) for each symbol
  // Structure: { BTCUSDT: '45100', ETHUSDT: '3200' }
  currentPrices: {},
  
  // Track if we need to recalculate
  needsRecalculation: false
};

// Recent activity log
const activityLog = [];
const MAX_LOG_ENTRIES = 10;

// Schema for tracking latest data
const latestDataSchema = new mongoose.Schema({
  type: { type: String, required: true, enum: ['price', 'candle', 'helix'] },
  symbol: { type: String, required: true },
  timeframe: String, // Only used for candles and helix
  data: mongoose.Schema.Types.Mixed,
  updatedAt: { type: Date, default: Date.now }
});

// Base schema for live price data 
const priceSchema = new mongoose.Schema({
  symbol: { type: String, required: true },
  price: { type: String, required: true },
  quantity: { type: String, required: true },
  time: { type: Date, required: true },
  formattedTime: String,
  tradeId: { type: Number, required: true },
  isBuyerMaker: Boolean
});

// Base schema for candlestick data
const candleSchema = new mongoose.Schema({
  symbol: { type: String, required: true },
  openTime: { type: Number, required: true },
  openTimeFormatted: String,
  open: String,
  high: String,
  low: String,
  close: String,
  volume: String,
  closeTime: Number,
  closeTimeFormatted: String,
  trades: Number,
  completed: Boolean,
  fetchTimestamp: String
}, { 
  timestamps: true 
});

// Schema for tracking latest close prices across all timeframes
const closeTrackerSchema = new mongoose.Schema({
  symbol: { type: String, required: true },
  timeframe: { type: String, required: true },
  closePrice: { type: String, required: true },
  closeTime: { type: Number, required: true },
  closeTimeFormatted: String,
  updatedAt: { type: Date, default: Date.now }
});

closeTrackerSchema.index({ symbol: 1, timeframe: 1 }, { unique: true });

// Schema for helix data (BTC delta - ETH delta)
const helixSchema = new mongoose.Schema({
  timeframe: { type: String, required: true },
  btcDelta: { type: Number, required: true },
  ethDelta: { type: Number, required: true },
  helixValue: { type: Number, required: true },
  cumulativeHelixValue: { type: Number, default: 0 },
  time: { type: Date, default: Date.now, required: true },
  interpretation: { type: String },
  lastUpdateTime: { type: Date }
}, { 
  timestamps: true 
});

// Store helix models for each timeframe
const helixModels = {};

// Connect to MongoDB
mongoose.connect(MONGODB_URI, { 
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000
})
.then(() => {
  console.log(`Connected to MongoDB`);
  setupModels();
})
.catch(err => {
  console.error('Failed to connect to MongoDB:', err);
  process.exit(1);
});

// Setup WebSocket server for clients
wss.on('connection', (ws) => {
  logActivity(`New client connected to helix broadcast`);
  connectedClients.add(ws);
  
  // Send welcome message with initial data
  ws.send(JSON.stringify({
    type: 'welcome',
    message: 'Connected to Helix data feed',
    timestamp: new Date().toISOString()
  }));
  
  ws.on('close', () => {
    logActivity(`Client disconnected from helix broadcast`);
    connectedClients.delete(ws);
  });
  
  ws.on('error', (error) => {
    logActivity(`WebSocket client error: ${error.message}`);
    connectedClients.delete(ws);
  });
});

// Broadcast helix data to all connected clients
function broadcastHelixData(helixData) {
  if (connectedClients.size === 0) return;
  
  const message = JSON.stringify({
    type: 'helix_update',
    data: helixData,
    timestamp: new Date().toISOString()
  });
  
  logActivity(`Broadcasting helix data to ${connectedClients.size} clients`);
  
  connectedClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Add a message to the activity log
function logActivity(message) {
  console.log(message);
  activityLog.unshift(message);
  if (activityLog.length > MAX_LOG_ENTRIES) {
    activityLog.pop();
  }
}

// Add debug logging function
function debugLog(message) {
  console.log(`[DEBUG] ${message}`);
}

// Add a safe query function for MongoDB operations
async function safeQuery(operation, fallback = null) {
  try {
    return await operation();
  } catch (err) {
    logActivity(`DB Error: ${err.message}`);
    return fallback;
  }
}

// Initialize cache for a symbol
function initializeSymbolCache(symbol) {
  if (!cache.openPrices[symbol]) {
    cache.openPrices[symbol] = {};
  }
  cache.currentPrices[symbol] = null;
}

// Update open price in cache
function updateOpenPriceCache(symbol, timeframe, open, openTime) {
  if (!cache.openPrices[symbol]) {
    cache.openPrices[symbol] = {};
  }
  
  // If we have a new candle, update the open price
  if (!cache.openPrices[symbol][timeframe] || 
      cache.openPrices[symbol][timeframe].openTime !== openTime) {
    cache.openPrices[symbol][timeframe] = { open, openTime };
    logActivity(`[CACHE] Updated ${symbol} ${timeframe} open price: ${open} for candle at ${new Date(openTime).toLocaleTimeString()}`);
  }
}

// Update current price in cache
function updateCurrentPrice(symbol, price) {
  const oldPrice = cache.currentPrices[symbol];
  cache.currentPrices[symbol] = price;
  
  // Log only if price changed significantly
  if (!oldPrice || Math.abs(parseFloat(price) - parseFloat(oldPrice)) > 0.01) {
    logActivity(`[PRICE] Current ${symbol} price updated: ${price}`);
    // Don't just set a flag - trigger calculations immediately
    performSynchronizedCalculations().catch(err => {
      logActivity(`Error in calculations after price update: ${err.message}`);
    });
  }
}

// Calculate delta between open and current price
function calculateDelta(symbol, timeframe) {
  // Get open price from cache
  if (!cache.openPrices[symbol] || 
      !cache.openPrices[symbol][timeframe] || 
      !cache.openPrices[symbol][timeframe].open ||
      !cache.currentPrices[symbol]) {
    return null;
  }
  
  const openPrice = parseFloat(cache.openPrices[symbol][timeframe].open);
  const currentPrice = parseFloat(cache.currentPrices[symbol]);
  
  if (isNaN(openPrice) || isNaN(currentPrice) || openPrice === 0) {
    return null;
  }
  
  return ((currentPrice - openPrice) / openPrice) * 100;
}

// Store delta in database
async function storeDelta(symbol, timeframe, delta) {
  return safeQuery(() => 
    latestDataModel.findOneAndUpdate(
      { type: 'helix', timeframe, symbol: `${symbol}_delta` },
      {
        type: 'helix',
        timeframe,
        symbol: `${symbol}_delta`,
        data: { delta },
        updatedAt: new Date()
      },
      { upsert: true, new: true }
    )
  );
}

// Calculate and store all deltas
async function calculateAllDeltas() {
  // Skip if we don't have prices for both symbols
  if (!cache.currentPrices.BTCUSDT || !cache.currentPrices.ETHUSDT) {
    logActivity("[CALC] Skipping delta calculation - missing current prices");
    return;
  }

  console.log("\n=== DELTA CALCULATIONS ===");
  console.log(`BTC Current Price: ${cache.currentPrices.BTCUSDT}`);
  console.log(`ETH Current Price: ${cache.currentPrices.ETHUSDT}`);
  
  const results = {
    BTC: {},
    ETH: {}
  };
  
  // Calculate for each symbol and timeframe
  for (const symbol of SYMBOLS) {
    console.log(`\n${symbol} Deltas:`);
    console.log("Timeframe | Open Price | Current Price | Delta (%)");
    console.log("-----------------------------------------------------");
    
    for (const timeframe of TIMEFRAMES) {
      const delta = calculateDelta(symbol, timeframe);
      
      if (delta !== null) {
        // Store in results object
        if (symbol === 'BTCUSDT') {
          results.BTC[timeframe] = delta;
        } else if (symbol === 'ETHUSDT') {
          results.ETH[timeframe] = delta;
        }
        
        // Print calculation details
        const openPrice = cache.openPrices[symbol][timeframe].open;
        const currentPrice = cache.currentPrices[symbol];
        console.log(`${timeframe.padEnd(9)} | ${openPrice.padEnd(10)} | ${currentPrice.padEnd(13)} | ${delta.toFixed(2)}%`);
        
        // Store in database
        await storeDelta(symbol, timeframe, delta);
      } else {
        console.log(`${timeframe.padEnd(9)} | Missing data`);
      }
    }
  }
  
  logActivity(`[DELTA] Calculated all deltas (BTC: ${cache.currentPrices.BTCUSDT}, ETH: ${cache.currentPrices.ETHUSDT})`);
  
  return results;
}

// Calculate helix value for a specific timeframe
async function calculateHelix(timeframe, btcDelta, ethDelta) {
  try {
    // Skip if either delta is null
    if (btcDelta === null || ethDelta === null) {
      return null;
    }
    
    // Calculate helix value
    const helixValue = btcDelta - ethDelta;
    
    // Store in database
    await storeHelixValue(timeframe, btcDelta, ethDelta, helixValue);
    
    return helixValue;
  } catch (err) {
    logActivity(`Error calculating helix for ${timeframe}: ${err.message}`);
    return null;
  }
}

// Calculate all helix values
async function calculateAllHelix(deltaResults) {
  if (!deltaResults) {
    logActivity("[CALC] Skipping helix calculation - no delta results");
    return;
  }
  
  console.log("\n=== HELIX CALCULATIONS ===");
  console.log("Timeframe | BTC Delta (%) | ETH Delta (%) | HELIX Value | Interpretation");
  console.log("---------------------------------------------------------------------------");
  
  const allHelixData = {};
  
  for (const timeframe of TIMEFRAMES) {
    const btcDelta = deltaResults.BTC[timeframe];
    const ethDelta = deltaResults.ETH[timeframe];
    
    if (btcDelta !== undefined && ethDelta !== undefined) {
      const helixValue = await calculateHelix(timeframe, btcDelta, ethDelta);
      
      // Determine interpretation for display
      let interpretation = "Neutral";
      if (helixValue > 1) interpretation = "BTC outperforming";
      else if (helixValue < -1) interpretation = "ETH outperforming";
      
      if (helixValue !== null) {
        // Store in results object for broadcasting
        allHelixData[timeframe] = {
          timeframe,
          btcDelta: btcDelta.toFixed(2),
          ethDelta: ethDelta.toFixed(2),
          helixValue: helixValue.toFixed(2),
          interpretation,
          timestamp: new Date().toISOString()
        };
        
        console.log(`${timeframe.padEnd(9)} | ${btcDelta.toFixed(2)}%`.padEnd(24) + 
                   `| ${ethDelta.toFixed(2)}%`.padEnd(15) + 
                   `| ${helixValue.toFixed(2)}`.padEnd(14) + 
                   `| ${interpretation}`);
        
        logActivity(`[HELIX] ${timeframe}: ${helixValue.toFixed(2)} (BTC: ${btcDelta.toFixed(2)}%, ETH: ${ethDelta.toFixed(2)}%)`);
      }
    } else {
      console.log(`${timeframe.padEnd(9)} | Missing data`);
    }
  }
  
  // Broadcast the helix data to all connected clients
  broadcastHelixData(allHelixData);
}

// Perform synchronized calculation of all metrics
async function performSynchronizedCalculations() {
  console.log("\n========= STARTING CALCULATIONS =========");
  console.log(`Timestamp: ${new Date().toISOString()}`);
  
  try {
    // Step 1: Calculate all deltas
    const deltaResults = await calculateAllDeltas();
    
    // Step 2: Calculate all helix values
    await calculateAllHelix(deltaResults);
    
    console.log("========= CALCULATIONS COMPLETE =========\n");
  } catch (err) {
    logActivity(`Error in synchronized calculations: ${err.message}`);
    console.log(`Error in calculations: ${err.message}`);
    console.log("========= CALCULATIONS FAILED =========\n");
  }
}

// Store helix value in database
async function storeHelixValue(timeframe, btcDelta, ethDelta, helixValue) {
  try {
    // Determine interpretation
    let interpretation = "Neutral";
    if (helixValue > 1) interpretation = "BTC outperforming";
    else if (helixValue < -1) interpretation = "ETH outperforming";
    
    const now = new Date();
    
    // Get the latest helix value for this timeframe
    const latestHelix = await helixModels[timeframe].findOne().sort({ time: -1 }).limit(1);
    
    // Calculate cumulative helix value
    let cumulativeHelixValue = 0;
    let shouldUpdate = true;
    
    if (latestHelix) {
      cumulativeHelixValue = latestHelix.cumulativeHelixValue || 0;
      
      // Check if enough time has passed to add to cumulative value
      if (latestHelix.lastUpdateTime) {
        const timeframeMs = getTimeframeMs(timeframe);
        const timeSinceLastUpdate = now - latestHelix.lastUpdateTime;
        shouldUpdate = timeSinceLastUpdate >= timeframeMs;
      }
    }
    
    // Update cumulative value if enough time has passed
    if (shouldUpdate) {
      cumulativeHelixValue += helixValue;
      logActivity(`Updated cumulative helix for ${timeframe}: ${cumulativeHelixValue.toFixed(2)}`);
    }
    
    // Create helix data object
    const helixData = {
      timeframe,
      btcDelta,
      ethDelta,
      helixValue,
      cumulativeHelixValue,
      time: now,
      interpretation,
      lastUpdateTime: shouldUpdate ? now : (latestHelix?.lastUpdateTime || now)
    };
    
    // Insert into appropriate timeframe collection
    if (helixModels[timeframe]) {
      await helixModels[timeframe].create(helixData);
      
      // Update latest data collection with this helix value
      await latestDataModel.findOneAndUpdate(
        { type: 'helix', timeframe, symbol: 'combined' },
        {
          type: 'helix',
          timeframe,
          symbol: 'combined',
          data: helixData,
          updatedAt: now
        },
        { upsert: true, new: true }
      );
    }
  } catch (err) {
    // Just log the error but don't disrupt the app flow
    logActivity(`Error storing helix value: ${err.message}`);
  }
}

// Get milliseconds for a timeframe
function getTimeframeMs(timeframe) {
  const unit = timeframe.slice(-1);
  const value = parseInt(timeframe.slice(0, -1));
  
  switch (unit) {
    case 'm': return value * 60 * 1000; // minutes
    case 'h': return value * 60 * 60 * 1000; // hours
    case 'd': return value * 24 * 60 * 60 * 1000; // days
    case 'w': return value * 7 * 24 * 60 * 60 * 1000; // weeks
    case 'M': return value * 30 * 24 * 60 * 60 * 1000; // months (approximate)
    default: return 60 * 1000; // default to 1 minute
  }
}

// Store or update close price
async function updateClosePrice(symbol, timeframe, closePrice, closeTime) {
  return safeQuery(() => 
    closeTrackerModel.findOneAndUpdate(
      { symbol, timeframe },
      { 
        symbol,
        timeframe,
        closePrice,
        closeTime,
        closeTimeFormatted: new Date(closeTime).toISOString(),
        updatedAt: new Date()
      },
      { upsert: true, new: true }
    )
  );
}

// Store candle in database
async function storeCandle(symbol, timeframe, candle) {
  try {
    // Format times for readability
    const openTimeFormatted = new Date(candle.openTime).toISOString();
    const closeTimeFormatted = new Date(candle.closeTime).toISOString();
    
    // Create formatted candle object
    const candleData = {
      symbol,
      openTime: candle.openTime,
      openTimeFormatted,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
      closeTime: candle.closeTime,
      closeTimeFormatted,
      trades: candle.trades,
      completed: candle.isClosed,
      fetchTimestamp: new Date().toISOString()
    };
    
    // Store in the appropriate model
    if (candleModels[symbol] && candleModels[symbol][timeframe]) {
      // For incomplete candles, update existing record instead of creating duplicates
      if (!candle.isClosed) {
        await candleModels[symbol][timeframe].findOneAndUpdate(
          { openTime: candle.openTime, symbol, completed: false },
          candleData,
          { upsert: true, new: true }
        );
      } else {
        // For completed candles, create a new record
        await candleModels[symbol][timeframe].create(candleData);
      }
      
      // Always update latestData
      await latestDataModel.findOneAndUpdate(
        { type: 'candle', symbol, timeframe },
        {
          type: 'candle',
          symbol,
          timeframe,
          data: candleData,
          updatedAt: new Date()
        },
        { upsert: true, new: true }
      );
      
      // Update stats
      stats.candles.total++;
      
      return true;
    }
    return false;
  } catch (err) {
    logActivity(`Error storing candle for ${symbol} ${timeframe}: ${err.message}`);
    return false;
  }
}

// Store trade in database
async function storeTrade(symbol, trade) {
  try {
    // Format time for readability
    const formattedTime = new Date(trade.time).toISOString();
    
    // Create formatted trade object
    const tradeData = {
      symbol,
      price: trade.price,
      quantity: trade.quantity,
      time: new Date(trade.time),
      formattedTime,
      tradeId: trade.tradeId,
      isBuyerMaker: trade.isBuyerMaker
    };
    
    // Store in the appropriate model
    if (priceModels[symbol]) {
      await priceModels[symbol].create(tradeData);
      
      // Also update latestData
      await latestDataModel.findOneAndUpdate(
        { type: 'price', symbol },
        {
          type: 'price',
          symbol,
          data: tradeData,
          updatedAt: new Date()
        },
        { upsert: true, new: true }
      );
      
      // Update stats
      stats.trades.total++;
      if (symbol === 'BTCUSDT') stats.trades.btc++;
      if (symbol === 'ETHUSDT') stats.trades.eth++;
      
      return true;
    }
    return false;
        } catch (err) {
    logActivity(`Error storing trade for ${symbol}: ${err.message}`);
    return false;
  }
}

// Handle websocket message for candle data
function handleCandleMessage(symbol, timeframe, message) {
  try {
    const data = JSON.parse(message);
    const kline = data.k;
    
    if (!kline) {
      return;
    }
    
    // Create candle object from websocket data
    const candle = {
      openTime: kline.t,
      open: kline.o,
      high: kline.h,
      low: kline.l,
      close: kline.c,
      volume: kline.v,
      closeTime: kline.T,
      trades: kline.n,
      isClosed: kline.x
    };
    
    // 1. Store open price in cache
    updateOpenPriceCache(symbol, timeframe, candle.open, candle.openTime);
    
    // 2. Update current price with this candle's close price
    // Note: updateCurrentPrice will trigger calculations immediately
    updateCurrentPrice(symbol, candle.close);
    
    // 3. Store candle in database (don't wait for this to complete)
    storeCandle(symbol, timeframe, candle)
      .catch(err => {
        logActivity(`Error storing candle: ${err.message}`);
      });
    
    // 4. Update close price for this timeframe (don't wait for this to complete)
    updateClosePrice(symbol, timeframe, candle.close, candle.closeTime)
      .catch(err => {
        logActivity(`Error updating close price: ${err.message}`);
      });
    
    // Log completed candles
    if (candle.isClosed) {
      logActivity(`[CANDLE] ${symbol} ${timeframe} completed: Open: ${candle.open}, Close: ${candle.close}`);
    }
    
  } catch (err) {
    logActivity(`Error processing ${symbol} ${timeframe} candle message: ${err.message}`);
  }
}

// Handle websocket message for trade data
function handleTradeMessage(symbol, message) {
  try {
    const trade = JSON.parse(message);
    
    if (!trade.p || !trade.q || !trade.T || !trade.a) {
      return;
    }
    
    // Create trade object from websocket data
    const tradeData = {
      price: trade.p,
      quantity: trade.q,
      time: trade.T,
      tradeId: trade.a,
      isBuyerMaker: trade.m
    };
    
    // Update latest data in memory
    latestData.prices[symbol] = tradeData;
    
    // Update live price in cache (most up-to-date price)
    updateCurrentPrice(symbol, tradeData.price);
    
    // Calculate deltas with the new trade price
    if (Math.random() < 0.1) { // Only calculate on 10% of trades to reduce processing
      calculateAllDeltas()
        .catch(err => {
          logActivity(`Error calculating deltas from trade: ${err.message}`);
        });
    }
    
    // Store trade in database (occasionally to reduce DB load)
    if (trade.a % 100 === 0) { // Store only 1% of trades to reduce DB writes
      storeTrade(symbol, tradeData)
        .catch(err => {
          logActivity(`Error storing trade: ${err.message}`);
        });
    }
    
  } catch (err) {
    logActivity(`Error processing ${symbol} trade message: ${err.message}`);
  }
}

// Setup WebSocket connections for each symbol and timeframe
function setupWebSockets() {
  logActivity('Setting up WebSocket connections...');
  
  // Initialize cache for all symbols
  for (const symbol of SYMBOLS) {
    initializeSymbolCache(symbol);
  }
  
  // Create WebSocket connections for candles
  for (const symbol of SYMBOLS) {
    for (const timeframe of TIMEFRAMES) {
      const lowercaseSymbol = symbol.toLowerCase();
      const wsUrl = `wss://stream.binance.com:9443/ws/${lowercaseSymbol}@kline_${timeframe}`;
      
      const ws = new WebSocket(wsUrl);
      
      ws.on('open', () => {
        logActivity(`WebSocket connection opened for ${symbol} ${timeframe} candles`);
      });
      
      ws.on('message', (message) => {
        handleCandleMessage(symbol, timeframe, message);
      });
      
      ws.on('error', (error) => {
        logActivity(`WebSocket error for ${symbol} ${timeframe}: ${error.message}`);
        // Try to reconnect after a delay
        setTimeout(() => {
          logActivity(`Attempting to reconnect ${symbol} ${timeframe} WebSocket...`);
          setupWebSocketForSymbolAndTimeframe(symbol, timeframe);
        }, 5000);
      });
      
      ws.on('close', () => {
        logActivity(`WebSocket connection closed for ${symbol} ${timeframe}`);
        // Try to reconnect after a delay
        setTimeout(() => {
          logActivity(`Attempting to reconnect ${symbol} ${timeframe} WebSocket...`);
          setupWebSocketForSymbolAndTimeframe(symbol, timeframe);
        }, 5000);
      });
    }
    
    // Also connect to trades stream for real-time price updates
    const lowercaseSymbol = symbol.toLowerCase();
    const wsTradeUrl = `wss://stream.binance.com:9443/ws/${lowercaseSymbol}@trade`;
    
    const wsTrade = new WebSocket(wsTradeUrl);
    
    wsTrade.on('open', () => {
      logActivity(`WebSocket connection opened for ${symbol} trades`);
    });
    
    wsTrade.on('message', (message) => {
      handleTradeMessage(symbol, message);
    });
    
    wsTrade.on('error', (error) => {
      logActivity(`WebSocket error for ${symbol} trades: ${error.message}`);
      // Try to reconnect after a delay
      setTimeout(() => {
        logActivity(`Attempting to reconnect ${symbol} trades WebSocket...`);
        setupWebSocketForTrades(symbol);
      }, 5000);
    });
    
    wsTrade.on('close', () => {
      logActivity(`WebSocket connection closed for ${symbol} trades`);
      // Try to reconnect after a delay
      setTimeout(() => {
        logActivity(`Attempting to reconnect ${symbol} trades WebSocket...`);
        setupWebSocketForTrades(symbol);
      }, 5000);
    });
  }
  
  logActivity('All WebSocket connections established');
  logActivity(`WebSocket server for clients started on port ${WS_PORT}`);
}

// Helper function to reconnect a specific symbol and timeframe
function setupWebSocketForSymbolAndTimeframe(symbol, timeframe) {
  const lowercaseSymbol = symbol.toLowerCase();
  const wsUrl = `wss://stream.binance.com:9443/ws/${lowercaseSymbol}@kline_${timeframe}`;
  
  const ws = new WebSocket(wsUrl);
  
  ws.on('open', () => {
    logActivity(`WebSocket reconnected for ${symbol} ${timeframe} candles`);
  });
  
  ws.on('message', (message) => {
    handleCandleMessage(symbol, timeframe, message);
  });
  
  ws.on('error', (error) => {
    logActivity(`WebSocket error for ${symbol} ${timeframe}: ${error.message}`);
    setTimeout(() => setupWebSocketForSymbolAndTimeframe(symbol, timeframe), 5000);
  });
  
  ws.on('close', () => {
    logActivity(`WebSocket connection closed for ${symbol} ${timeframe}`);
    setTimeout(() => setupWebSocketForSymbolAndTimeframe(symbol, timeframe), 5000);
  });
}

// Helper function to reconnect a specific symbol's trade stream
function setupWebSocketForTrades(symbol) {
  const lowercaseSymbol = symbol.toLowerCase();
  const wsTradeUrl = `wss://stream.binance.com:9443/ws/${lowercaseSymbol}@trade`;
  
  const wsTrade = new WebSocket(wsTradeUrl);
  
  wsTrade.on('open', () => {
    logActivity(`WebSocket reconnected for ${symbol} trades`);
  });
  
  wsTrade.on('message', (message) => {
    handleTradeMessage(symbol, message);
  });
  
  wsTrade.on('error', (error) => {
    logActivity(`WebSocket error for ${symbol} trades: ${error.message}`);
    setTimeout(() => setupWebSocketForTrades(symbol), 5000);
  });
  
  wsTrade.on('close', () => {
    logActivity(`WebSocket connection closed for ${symbol} trades`);
    setTimeout(() => setupWebSocketForTrades(symbol), 5000);
  });
}

// Setup mongoose models for each collection
async function setupModels() {
  logActivity(`Setting up models...`);
  
  // Create Latest Data model
  latestDataModel = mongoose.model('LatestData', latestDataSchema);
  
  // Create Close Tracker model
  closeTrackerModel = mongoose.model('CloseTracker', closeTrackerSchema);
  
  // Create helix models for each timeframe
  for (const timeframe of TIMEFRAMES) {
    const collectionName = `helix_${timeframe}`;
    // Create a timeseries collection for each timeframe's helix data
    helixModels[timeframe] = mongoose.model(`Helix_${timeframe}`, helixSchema, collectionName);
  }
  
  // Create price models for each symbol
  for (const symbol of SYMBOLS) {
    const symbolKey = symbol.toLowerCase().replace('usdt', '');
    const collectionName = `${symbolKey}_prices`;
    priceModels[symbol] = mongoose.model(`${symbolKey}Price`, priceSchema, collectionName);
  }
  
  // Create candle models for each symbol and timeframe
  for (const symbol of SYMBOLS) {
    candleModels[symbol] = {};
    const symbolKey = symbol.toLowerCase().replace('usdt', '');
    
    for (const timeframe of TIMEFRAMES) {
      const collectionName = `${symbolKey}_${timeframe}`;
      candleModels[symbol][timeframe] = mongoose.model(
        `${symbolKey}_${timeframe}`, 
        candleSchema, 
        collectionName
      );
    }
  }
  
  logActivity(`All models initialized`);
  
  // Setup WebSocket connections
  setupWebSockets();
  
  logActivity(`Monitoring setup complete - watching for real-time data...`);
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  logActivity(`\nClosing WebSocket server and MongoDB connection...`);
  
  // Close all client connections
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.close(1000, 'Server shutting down');
    }
  });
  
  // Close the WebSocket server
  wss.close(() => {
    logActivity('WebSocket server closed');
    
    // Then close the MongoDB connection
    mongoose.connection.close().then(() => {
      logActivity(`MongoDB connection closed.`);
      process.exit(0);
    });
  });
});

