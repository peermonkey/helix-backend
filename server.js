const axios = require('axios');
const express = require('express');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const app = express();
const PORT = process.env.PORT || 3000;

// MongoDB Connection
const MONGODB_URI = 'mongodb://localhost:27017/DataBS';

// Connect to MongoDB - but don't start anything else yet
mongoose.connect(MONGODB_URI, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
})
  .then(() => {
    console.log('Connected to MongoDB');
    // Start the server with proper initialization sequence
    startServer();
  })
  .catch(err => console.error('Failed to connect to MongoDB:', err));

// Configuration
const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
const TIMEFRAMES = [
  '1m', '3m', '5m', '15m', '30m',  // minutes
  '1h', '2h', '4h', '6h', '8h', '12h',  // hours
  '1d', '3d',  // days
  '1w',  // week
  '1M'   // month
];

// Map timeframe to milliseconds
const timeframeToMs = {
  '1m': 60 * 1000,
  '3m': 3 * 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '2h': 2 * 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '8h': 8 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
  '1M': 30 * 24 * 60 * 60 * 1000, // Approximate
};

// Storage for cache and models
const latestCandles = {};
const livePrices = {};
const candleModels = {}; // Store candle models by collection name
const priceModels = {}; // Store price models by symbol

// Initialize data structures
SYMBOLS.forEach(symbol => {
  const symbolKey = symbol.toLowerCase().replace('usdt', '');
  latestCandles[symbol] = {};
  livePrices[symbol] = null;
  
  TIMEFRAMES.forEach(timeframe => {
    latestCandles[symbol][timeframe] = null;
  });
});

// Schema for latest data tracking
const latestDataSchema = new mongoose.Schema({
  type: { type: String, required: true, enum: ['price', 'candle'] },
  symbol: { type: String, required: true },
  timeframe: String, // Only used for candles
  data: mongoose.Schema.Types.Mixed,
  updatedAt: { type: Date, default: Date.now }
});

latestDataSchema.index({ type: 1, symbol: 1, timeframe: 1 }, { unique: true });
const LatestData = mongoose.model('LatestData', latestDataSchema);

// Base schema for live price data (used for timeseries collections)
const priceSchema = new mongoose.Schema({
  symbol: { type: String, required: true },
  open: { type: String, required: true },
  high: { type: String, required: true },
  low: { type: String, required: true },
  close: { type: String, required: true },
  volume: { type: String, required: true },
  trades: { type: Number, required: true },
  time: { type: Date, required: true },
  formattedTime: String,
  periodStart: Date,
  periodEnd: Date
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

// Function to store raw trade data directly
async function storeRawTrade(trade) {
  try {
    const { symbol } = trade;
    const symbolKey = symbol.toLowerCase().replace('usdt', '');
    
    // Get the appropriate model for this symbol
    const PriceModel = priceModels[symbol];
    
    if (!PriceModel) {
      console.error(`No price model found for ${symbol}`);
      return;
    }
    
    // Ensure time is a proper Date object
    const tradeData = {
      ...trade,
      time: new Date(trade.time) // Ensure time is a Date object
    };
    
    // Store in MongoDB without any aggregation or calculations
    const priceDoc = new PriceModel(tradeData);
    await priceDoc.save();
    
    // Update latest price tracker
    await LatestData.findOneAndUpdate(
      { type: 'price', symbol: symbol, timeframe: null },
      { 
        type: 'price',
        symbol: symbol,
        data: tradeData,
        updatedAt: new Date()
      },
      { upsert: true, new: true }
    );
    
    // Log every trade storage 
    console.log(`💾 STORED [TRADE] ${symbol} | Price: ${tradeData.price} | Qty: ${tradeData.quantity} | Time: ${tradeData.formattedTime} | ID: ${tradeData.tradeId}`);
    
  } catch (error) {
    // Only log meaningful errors
    if (error.code !== 11000) { // Skip duplicate key errors
      console.error(`Error storing raw trade for ${trade.symbol}:`, error.message);
    }
  }
}

// Initialize collections and models
async function initializeCollections() {
  try {
    console.log('Starting collections initialization...');
    const db = mongoose.connection.db;
    
    // Check if collections exist
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);
    
    console.log(`📚 Found ${collectionNames.length} existing collections: ${collectionNames.join(', ')}`);
    
    // Create price timeseries collections
    for (const symbol of SYMBOLS) {
      const symbolKey = symbol.toLowerCase().replace('usdt', '');
      const collectionName = `${symbolKey}_prices`;
      
      // Create price collection if it doesn't exist
      if (!collectionNames.includes(collectionName)) {
        await db.createCollection(collectionName, {
          timeseries: {
            timeField: 'time',
            metaField: 'symbol',
            granularity: 'seconds'
          },
          expireAfterSeconds: 60 * 60 * 24 * 30 // 30 days
        });
        console.log(`Created ${collectionName} timeseries collection`);
      }
      
      // Create price schema specific for raw trades
      const rawTradeSchema = new mongoose.Schema({
        symbol: { type: String, required: true },
        price: { type: String, required: true },
        quantity: { type: String, required: true },
        time: { type: Date, required: true },
        formattedTime: String,
        tradeId: { type: Number, required: true },
        isBuyerMaker: Boolean
      });
      
      // Create price model
      priceModels[symbol] = mongoose.model(`${symbolKey}Price`, rawTradeSchema, collectionName);
      
      // Create index on time for better query performance
      await db.collection(collectionName).createIndex(
        { time: -1 },
        { background: true }
      ).catch(err => {
        console.error(`Error creating ${collectionName} index:`, err);
      });
      
      // Create index on tradeId for deduplication
      await db.collection(collectionName).createIndex(
        { tradeId: 1 },
        { background: true }
      ).catch(err => {
        console.error(`Error creating tradeId index for ${collectionName}:`, err);
      });
      
      console.log(`Ensured indexes on ${collectionName} collection`);
    }
    
    // Initialize candle models to avoid errors but don't create any new collections
    console.log('Skipping creation of candle collections as requested');
    for (const symbol of SYMBOLS) {
      const symbolKey = symbol.toLowerCase().replace('usdt', '');
      
      for (const timeframe of TIMEFRAMES) {
        const collectionName = `${symbolKey}_${timeframe}`;
        
        // Only initialize the model if the collection already exists
        if (collectionNames.includes(collectionName)) {
          const model = mongoose.model(
            `${symbolKey}_${timeframe}`, 
            candleSchema, 
            collectionName
          );
          
          // Store model reference for later use (for read operations only)
          candleModels[collectionName] = model;
          console.log(`Initialized existing ${collectionName} model for read-only operations`);
        } else {
          console.log(`Skipping non-existent candle collection: ${collectionName}`);
        }
      }
    }
    
    console.log('All collections initialization complete. Candle storage disabled, only price data will be stored.');
    return true; // Return success
  } catch (error) {
    console.error('Error initializing collections:', error);
    throw error; // Re-throw to be caught by the caller
  }
}

// Function to connect to Binance WebSocket for live price updates
function setupPriceWebSocket() {
  // Create streams for each symbol (lowercase for WS)
  const streams = SYMBOLS.map(symbol => `${symbol.toLowerCase()}@trade`);
  
  // Connect to combined stream
  const wsUrl = `wss://stream.binance.com:9443/stream?streams=${streams.join('/')}`;
  console.log(`Connecting to WebSocket URL: ${wsUrl}`);
  
  const ws = new WebSocket(wsUrl);
  
  console.log('Setting up WebSocket connection for live prices...');
  
  ws.on('open', () => {
    console.log('WebSocket connection established for price streaming');
  });
  
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);
      const stream = message.stream;
      const eventData = message.data;
      
      // Extract symbol from stream name (e.g., btcusdt@trade -> BTCUSDT)
      const symbol = stream.split('@')[0].toUpperCase();
      
      if (eventData.e === 'trade') {
        const currentPrice = parseFloat(eventData.p);
        const previousPrice = livePrices[symbol]?.price ? parseFloat(livePrices[symbol].price) : null;
        
        // Create raw trade object without calculations
        const trade = {
          symbol: symbol,
          price: eventData.p,
          quantity: eventData.q,
          time: new Date(parseInt(eventData.T)),
          formattedTime: new Date(parseInt(eventData.T)).toISOString(),
          tradeId: parseInt(eventData.t),
          isBuyerMaker: eventData.m
        };
        
        // Update in-memory latest price
        livePrices[symbol] = trade;
        
        // Store raw trade in database (no aggregation)
        storeRawTrade(trade);
        
        // Display in console with trend indicator (just for UI, not stored)
        const trend = previousPrice ? (currentPrice > previousPrice ? '↑' : '↓') : '-';
        const trendColor = trend === '↑' ? '\x1b[32m' : trend === '↓' ? '\x1b[31m' : '\x1b[0m';
        process.stdout.write(`\r${symbol}: ${trendColor}${trade.price} ${trend}\x1b[0m | Time: ${trade.formattedTime}`);
      }
    } catch (error) {
      console.error('Error processing WebSocket message:', error.message);
    }
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
    // Attempt to reconnect after a delay
    setTimeout(setupPriceWebSocket, 5000);
  });
  
  ws.on('close', () => {
    console.log('WebSocket connection closed. Reconnecting...');
    // Attempt to reconnect after a delay
    setTimeout(setupPriceWebSocket, 5000);
  });
  
  // Keep-alive ping
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    } else {
      clearInterval(pingInterval);
    }
  }, 10 * 60 * 1000); // Ping every 10 minutes
  
  return ws;
}

// Function to store candle data in its specific collection
async function storeCandle(candle) {
  // Commented out candle storage functionality
  /*
  try {
    // Only store completed candles to avoid partial data
    if (!candle.completed) {
      console.log(`Skipping storage for incomplete ${candle.symbol} ${candle.timeframe} candle`);
      return;
    }
    
    const symbol = candle.symbol;
    const timeframe = candle.timeframe;
    const symbolKey = symbol.toLowerCase().replace('usdt', '');
    const collectionName = `${symbolKey}_${timeframe}`;
    
    // Get the model for this symbol/timeframe
    const CandleModel = candleModels[collectionName];
    
    if (!CandleModel) {
      console.error(`No model found for ${collectionName}`);
      return;
    }
    
    // Use findOneAndUpdate with upsert to avoid duplicates
    const result = await CandleModel.findOneAndUpdate(
      { openTime: candle.openTime },
      candle,
      { upsert: true, new: true }
    );
    
    // Update the latest candle tracker
    await LatestData.findOneAndUpdate(
      { type: 'candle', symbol: candle.symbol, timeframe: candle.timeframe },
      { 
        type: 'candle',
        symbol: candle.symbol,
        timeframe: candle.timeframe,
        data: candle,
        updatedAt: new Date()
      },
      { upsert: true, new: true }
    );
    
    // Detailed logging for candle storage
    console.log(`💾 STORED [CANDLE] ${symbol} ${timeframe} | Open: ${candle.open} | High: ${candle.high} | Low: ${candle.low} | Close: ${candle.close} | Volume: ${candle.volume} | Open Time: ${candle.openTimeFormatted} | Close Time: ${candle.closeTimeFormatted}`);
    
    return result;
  } catch (error) {
    // Only log if not a duplicate key error (11000)
    if (error.code !== 11000) {
      console.error(`Error storing candle in MongoDB:`, error.message);
    }
  }
  */
  console.log(`Candle storage disabled: ${candle.symbol} ${candle.timeframe}`);
  return null;
}

// Function to fetch candle data for a symbol and timeframe
async function fetchCandle(symbol, timeframe, getCompleted = true) {
  try {
    console.log(`Fetching ${getCompleted ? 'completed' : 'current'} candle for ${symbol} ${timeframe}...`);
    
    // If we want a completed candle, fetch 2 - the most recent may be incomplete
    // For the current candle, just fetch 1
    const limit = getCompleted ? 2 : 1;
    
    const response = await axios.get(`https://api.binance.com/api/v3/klines`, {
      params: {
        symbol: symbol,
        interval: timeframe,
        limit: limit
      }
    });
    
    if (response.data && response.data.length > 0) {
      // If we want the completed candle and we have at least 2 candles,
      // use the second-to-last candle (the completed one)
      // Otherwise use the last candle (might be incomplete)
      const candleIndex = (getCompleted && response.data.length >= 2) ? 1 : 0;
      const candle = response.data[response.data.length - 1 - candleIndex];
      
      // Format candle data
      const formattedCandle = {
        symbol,
        timeframe,
        openTime: candle[0],
        openTimeFormatted: new Date(candle[0]).toISOString(),
        open: candle[1],
        high: candle[2],
        low: candle[3],
        close: candle[4],
        volume: candle[5],
        closeTime: candle[6],
        closeTimeFormatted: new Date(candle[6]).toISOString(),
        trades: candle[8],
        completed: getCompleted && response.data.length >= 2, // Only mark as completed if we got a second-to-last candle
        fetchTimestamp: new Date().toISOString()
      };
      
      // Update the candle data in our storage
      latestCandles[symbol][timeframe] = formattedCandle;
      
      // Only log completed candles to avoid cluttering the console
      if (formattedCandle.completed) {
        console.log(`\n${symbol} ${timeframe} COMPLETED CANDLE:`);
        console.log(`Time: ${formattedCandle.openTimeFormatted} -> ${formattedCandle.closeTimeFormatted}`);
        console.log(`OHLC: ${formattedCandle.open}, ${formattedCandle.high}, ${formattedCandle.low}, ${formattedCandle.close}`);
        console.log(`Volume: ${formattedCandle.volume}, Trades: ${formattedCandle.trades}`);
        
        // Commented out: Storage of completed candle in MongoDB
        // storeCandle(formattedCandle);
        console.log(`Candle storage disabled for ${symbol} ${timeframe}`);
      } else {
        console.log(`Received ${symbol} ${timeframe} candle data (may not be completed)`);
      }
      
      return formattedCandle;
    } else {
      console.error(`No candle data returned for ${symbol} ${timeframe}`);
    }
  } catch (error) {
    console.error(`Error fetching ${symbol} ${timeframe} candle:`, error.message);
  }
  
  return null;
}

// Function to get the next candle creation time for a specific timeframe
function getNextCandleTime(timeframe) {
  const now = new Date();
  const ms = timeframeToMs[timeframe];
  
  if (!ms) return null;
  
  // Calculate when the next candle will start
  const currentTimeMs = now.getTime();
  
  // For 1m, we need to find the next minute boundary
  // For 1h, we need to find the next hour boundary, etc.
  const remainder = currentTimeMs % ms;
  const nextCandleTime = new Date(currentTimeMs - remainder + ms);
  
  return nextCandleTime;
}

// Schedule fetching for a specific timeframe
function scheduleTimeframeFetch(symbol, timeframe) {
  const nextCandleTime = getNextCandleTime(timeframe);
  
  if (!nextCandleTime) {
    console.error(`Invalid timeframe: ${timeframe}`);
    return;
  }
  
  const now = new Date();
  const delay = nextCandleTime.getTime() - now.getTime();
  
  // Add a small delay to ensure the candle is closed
  const fetchDelay = delay + 5000; // 5 seconds after candle closes
  
  console.log(`Scheduling fetch for ${symbol} ${timeframe} COMPLETED candle at ${nextCandleTime.toISOString()} (in ${Math.floor(fetchDelay/1000)} seconds)`);
  
  setTimeout(async () => {
    console.log(`🔄 Executing scheduled fetch for ${symbol} ${timeframe} COMPLETED candle`);
    const candle = await fetchCandle(symbol, timeframe, true);
    
    // Commented out candle storage verification
    /*
    // Double check that the candle was properly stored
    if (candle && candle.completed) {
      console.log(`✓ Verified ${symbol} ${timeframe} candle was marked as completed`);
    } else if (candle) {
      console.error(`❌ Error: ${symbol} ${timeframe} candle was not marked as completed`);
      // Force storage with completed flag set to true
      candle.completed = true;
      await storeCandle(candle);
    }
    */
    
    // Reschedule for the next candle
    scheduleTimeframeFetch(symbol, timeframe);
  }, fetchDelay);
}

// Function to schedule all candle fetches
function scheduleAllFetches() {
  SYMBOLS.forEach(symbol => {
    TIMEFRAMES.forEach(timeframe => {
      scheduleTimeframeFetch(symbol, timeframe);
    });
  });
}

// Function to fetch all candle data (initial fetch)
async function fetchAllCandles() {
  console.log('\n📊 Starting initial fetch of candle data...');
  const promises = [];
  const storedCandles = [];
  
  // First fetch completed candles for all symbols and timeframes
  for (const symbol of SYMBOLS) {
    console.log(`\n📈 Fetching candles for ${symbol}...`);
    
    for (const timeframe of TIMEFRAMES) {
      console.log(`  ⏱️ Queueing fetch for ${symbol} ${timeframe} completed candle...`);
      // Explicitly request completed candles (true)
      const promise = fetchCandle(symbol, timeframe, true)
        .then(candle => {
          if (candle && candle.completed) {
            console.log(`  ✓ ${symbol} ${timeframe} candle fetched successfully`);
            // Comment out candle storage
            /*
            const symbolKey = symbol.toLowerCase().replace('usdt', '');
            const collectionName = `${symbolKey}_${timeframe}`;
            
            // Check if model exists
            if (!candleModels[collectionName]) {
              console.error(`❌ Model not found for ${collectionName} - candle cannot be stored`);
              return null;
            }
            
            // Store candle
            return storeCandle(candle).then(() => {
              storedCandles.push(`${symbol}:${timeframe}`);
              console.log(`  ✓ ${symbol} ${timeframe} candle fetched and stored successfully`);
              return candle;
            });
            */
            return candle;
          } else if (candle) {
            console.warn(`⚠️ ${symbol} ${timeframe} candle fetched but not marked as completed`);
            return null;
          } else {
            console.error(`❌ Failed to fetch ${symbol} ${timeframe} candle`);
            return null;
          }
        })
        .catch(err => {
          console.error(`❌ Error processing ${symbol} ${timeframe} candle: ${err.message}`);
          return null;
        });
      
      promises.push(promise);
    }
  }
  
  // Wait for all fetches to complete
  const results = await Promise.allSettled(promises);
  
  // Log summary
  const successCount = results.filter(r => r.status === 'fulfilled' && r.value).length;
  console.log('\n📋 Initial candle fetch summary:');
  console.log(`  ✅ Successfully fetched ${successCount} of ${promises.length} candles`);
  console.log(`  ⏰ Completed at: ${new Date().toISOString()}`);
  console.log(`  ℹ️ Note: Candle storage is disabled`);
  
  return successCount;
}

// API endpoints
// Generic endpoint for candles by symbol and timeframe
app.get('/db/candles/:symbol/:timeframe', async (req, res) => {
  try {
    const { symbol, timeframe } = req.params;
    const { limit = 100, from, to } = req.query;
    
    // Validate symbol and timeframe
    const upperSymbol = symbol.toUpperCase();
    const lowerTimeframe = timeframe.toLowerCase();
    
    if (!SYMBOLS.includes(upperSymbol)) {
      return res.status(400).json({ error: 'Invalid symbol' });
    }
    
    if (!TIMEFRAMES.includes(lowerTimeframe)) {
      return res.status(400).json({ error: 'Invalid timeframe' });
    }
    
    // Get the appropriate model
    const symbolKey = upperSymbol.toLowerCase().replace('usdt', '');
    const collectionName = `${symbolKey}_${lowerTimeframe}`;
    const CandleModel = candleModels[collectionName];
    
    if (!CandleModel) {
      return res.status(500).json({ error: 'Model not found' });
    }
    
    // Build query
    const query = {};
    if (from) query.openTime = { $gte: parseInt(from) };
    if (to) query.openTime = { ...query.openTime, $lte: parseInt(to) };
    
    // Execute query
    const candles = await CandleModel.find(query)
      .sort({ openTime: -1 })
      .limit(parseInt(limit));
      
    res.json(candles);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Latest price endpoint
app.get('/db/latest/price/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    
    // Validate symbol
    if (!SYMBOLS.includes(symbol)) {
      return res.status(400).json({ error: 'Invalid symbol' });
    }
    
    const latestPrice = await LatestData.findOne({ 
      type: 'price', 
      symbol: symbol 
    });
    
    if (latestPrice) {
      res.json(latestPrice.data);
    } else {
      res.status(404).json({ error: 'Latest price not found' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Latest candle endpoint
app.get('/db/latest/candle/:symbol/:timeframe', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const timeframe = req.params.timeframe.toLowerCase();
    
    // Validate inputs
    if (!SYMBOLS.includes(symbol)) {
      return res.status(400).json({ error: 'Invalid symbol' });
    }
    
    if (!TIMEFRAMES.includes(timeframe)) {
      return res.status(400).json({ error: 'Invalid timeframe' });
    }
    
    const latestCandle = await LatestData.findOne({ 
      type: 'candle', 
      symbol: symbol,
      timeframe: timeframe
    });
    
    if (latestCandle) {
      res.json(latestCandle.data);
    } else {
      res.status(404).json({ error: 'Latest candle not found' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Latest candles for a symbol
app.get('/db/latest/candles/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    
    // Validate symbol
    if (!SYMBOLS.includes(symbol)) {
      return res.status(400).json({ error: 'Invalid symbol' });
    }
    
    const latestCandles = await LatestData.find({ 
      type: 'candle', 
      symbol: symbol
    });
    
    if (latestCandles && latestCandles.length > 0) {
      // Convert to object with timeframe as key
      const result = {};
      latestCandles.forEach(item => {
        result[item.timeframe] = item.data;
      });
      res.json(result);
    } else {
      res.status(404).json({ error: 'Latest candles not found' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get price history endpoint
app.get('/db/prices/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const { limit = 100, from, to } = req.query;
    
    // Validate symbol
    if (!SYMBOLS.includes(symbol)) {
      return res.status(400).json({ error: 'Invalid symbol' });
    }
    
    // Get appropriate model
    const symbolKey = symbol.toLowerCase().replace('usdt', '');
    const PriceModel = priceModels[symbol];
    
    if (!PriceModel) {
      return res.status(500).json({ error: 'Model not found' });
    }
    
    // Build query
    const query = { symbol };
    if (from) query.time = { $gte: new Date(parseInt(from)) };
    if (to) query.time = { ...query.time, $lte: new Date(parseInt(to)) };
    
    // Execute query
    const prices = await PriceModel.find(query)
      .sort({ time: -1 })
      .limit(parseInt(limit));
      
    res.json(prices);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// In-memory API endpoints
app.get('/', (req, res) => {
  res.json({ message: 'Binance Crypto Data Server' });
});

app.get('/candles', (req, res) => {
  res.json(latestCandles);
});

app.get('/candles/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  if (latestCandles[symbol]) {
    res.json(latestCandles[symbol]);
  } else {
    res.status(404).json({ error: 'Symbol not found' });
  }
});

app.get('/candles/:symbol/:timeframe', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const timeframe = req.params.timeframe.toLowerCase();
  
  if (latestCandles[symbol] && latestCandles[symbol][timeframe]) {
    res.json(latestCandles[symbol][timeframe]);
  } else {
    res.status(404).json({ error: 'Symbol or timeframe not found' });
  }
});

app.get('/prices', (req, res) => {
  res.json(livePrices);
});

app.get('/prices/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  if (livePrices[symbol]) {
    res.json(livePrices[symbol]);
  } else {
    res.status(404).json({ error: 'Symbol not found' });
  }
});

// Main startup function with proper sequence
async function startServer() {
  try {
    console.log('🚀 Starting server with proper initialization sequence...');
    
    // Step 1: Initialize all collections and models
    console.log('Step 1: Initializing collections and models...');
    await initializeCollections();
    console.log('✅ All collections and models initialized successfully');
    
    // Step 2: Fetch initial candle data
    console.log('Step 2: Performing initial candle fetch...');
    const candlesFetched = await fetchAllCandles();
    console.log(`✅ Initial fetch complete: ${candlesFetched} candles fetched (storage disabled)`);
    
    // Step 3: Schedule future candle fetches
    console.log('Step 3: Scheduling future candle fetches...');
    scheduleAllFetches();
    console.log('✅ All future candle fetches scheduled (storage disabled)');
    
    // Step 4: Start WebSocket connection for live prices
    console.log('Step 4: Starting WebSocket connection for live price data...');
    setupPriceWebSocket();
    console.log('✅ WebSocket connection initiated');
    
    // Step 5: Start Express server
    console.log('Step 5: Starting Express server...');
    app.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
      console.log('🎉 Server fully initialized and running');
      console.log('📝 Note: Candle storage is disabled, only price collections are active');
    });
  } catch (error) {
    console.error('❌ Server initialization failed:', error);
    process.exit(1);
  }
}












