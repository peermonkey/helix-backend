# Helix Crypto Analysis System

A complete system for collecting, analyzing, and visualizing cryptocurrency data with a focus on comparative analysis between Bitcoin (BTC) and Ethereum (ETH).

## System Overview

This project consists of three main components:

1. **Data Collection Server (server.js)** - Collects and stores raw cryptocurrency data from Binance
2. **Helix Processing Engine (nebula.js)** - Processes cryptocurrency data and calculates the "Helix" metric
3. **Data Visualization Dashboard (helix-all.html)** - Displays the processed data in an interactive web interface

## Features

- Fetches candle data for BTC/USDT and ETH/USDT trading pairs
- Supports all Binance timeframes (1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 1d, 3d, 1w, 1M)
- Calculates "Helix" values (BTC delta - ETH delta) to identify relative performance
- **Real-time data via WebSockets:**
  - Live trade updates from Binance
  - Live Helix metric updates to the dashboard
- RESTful API endpoints to access collected data
- **Advanced MongoDB Integration:**
  - **TimeSeries Collections** for optimized data storage
  - Automatic data expiration (30-day retention policy for price data)
  - Multiple indexes for efficient querying
  - Dedicated collection for tracking latest data points
- Interactive dashboard with real-time updates

## Component Details

### Data Collection Server (server.js)

The server.js component handles:

- Connecting to MongoDB for data storage
- Establishing WebSocket connections to Binance for real-time price data
- Processing and storing trade data in MongoDB timeseries collections
- Scheduling candle data fetches at appropriate intervals
- Providing REST API endpoints for data access
- Handling automatic reconnection to Binance on connection failures

Key functionality:
- Sets up Express.js server for API endpoints
- Initializes MongoDB collections (timeseries collections for price data)
- Establishes WebSocket connections to Binance for real-time data
- Processes and stores trade data with automatic deduplication
- Schedules candle data fetches with precise timing
- Provides in-memory and database-backed API endpoints

### Helix Processing Engine (nebula.js)

The nebula.js component is responsible for:

- Connecting to MongoDB for data storage
- Setting up WebSocket connections to Binance for real-time price and candle data
- Calculating "Helix" values (BTC delta - ETH delta) across all timeframes
- Providing a WebSocket server for broadcasting Helix data to clients
- Managing caches for efficient calculations
- Storing calculated metrics in MongoDB

Key functionality:
- Calculates percent change deltas for BTC and ETH across all timeframes
- Computes Helix value (BTC delta - ETH delta) to identify relative performance
- Provides interpretation of Helix values (BTC outperforming, ETH outperforming, or neutral)
- Maintains WebSocket server for broadcasting Helix data to connected clients
- Automatically reconnects to Binance on connection failures
- Stores calculation results in MongoDB for historical analysis

### Data Visualization Dashboard (helix-all.html)

The helix-all.html component provides:

- A responsive web interface for displaying Helix data
- Real-time updates via WebSocket connection to the Helix Processing Engine
- Visual indicators of market performance
- Connection status monitoring and logging
- Interactive elements for data exploration

Key features:
- Connects to the Helix WebSocket server for real-time updates
- Displays Helix values across all timeframes with visual indicators
- Shows deltas for BTC and ETH with color-coding for positive/negative performance
- Provides interpretation of the Helix values
- Includes connection status monitoring with automatic reconnection
- Features a real-time log of system activity
- Responsive design that works on desktop and mobile devices

## WebSocket Implementation Details

This system uses WebSockets extensively for real-time data processing:

### Binance WebSocket Connections (Inbound)
- **Trade Streams**: `<symbol>@trade` - Real-time updates of individual trades
  - Used in both server.js and nebula.js to get latest price data
- **Kline/Candle Streams**: `<symbol>@kline_<interval>` - Real-time candle updates
  - Used in nebula.js for calculating deltas across all timeframes

### Helix WebSocket Server (Outbound)
- Implemented in nebula.js using the `ws` package
- Listens on port 3000 for client connections
- Broadcasts Helix data updates to all connected clients
- Handles client connection management (connect, disconnect, errors)
- Sends the following message types:
  - `welcome` - Initial message on client connection
  - `helix_update` - Updated Helix data for all timeframes

### Dashboard WebSocket Client
- Implemented in helix-all.html using the browser's WebSocket API
- Connects to the Helix WebSocket server on localhost:3000
- Processes incoming messages and updates the UI accordingly
- Handles reconnection logic with exponential backoff
- Updates data cards and logs in real-time

## MongoDB Collections

The application uses multiple MongoDB collections in the `DataBS` database:

1. **Price collections** (e.g., `btc_prices`, `eth_prices`) - Store raw trade data
   - Configured as timeseries collections 
   - Automatic 30-day data expiration

2. **Candle collections** (e.g., `btc_1m`, `eth_1h`) - Store candlestick data for each symbol and timeframe

3. **Helix collections** (e.g., `helix_1m`, `helix_1h`) - Store calculated Helix values for each timeframe

4. **LatestData** - Tracks the latest state of prices, candles, and Helix values
   - Used for quick access to the most recent data

## Requirements

- Node.js 14+ 
- MongoDB 5.0+ (for TimeSeries collections support)
- Modern web browser for the dashboard

## Installation

1. Ensure MongoDB 5.0+ is running on localhost:27017 (default)

2. Install dependencies:
```
npm install
```

3. Start the data collection server:
```
node server.js
```

4. Start the Helix processing engine:
```
node nebula.js
```

5. Open helix-all.html in a web browser to view the dashboard

## API Endpoints

The server.js component provides several API endpoints:

### In-Memory Data
- `GET /` - Server information
- `GET /candles` - Get all candle data for all symbols and timeframes
- `GET /candles/:symbol` - Get candle data for a specific symbol (e.g., BTCUSDT)
- `GET /candles/:symbol/:timeframe` - Get candle data for a specific symbol and timeframe (e.g., BTCUSDT/1h)
- `GET /prices` - Get all latest price data for all tracked symbols
- `GET /prices/:symbol` - Get latest price for a specific symbol (e.g., BTCUSDT)

### MongoDB Data
- `GET /db/candles/:symbol/:timeframe` - Query candle data with filters
  - Query params: `limit`, `from` (timestamp), `to` (timestamp)
- `GET /db/prices/:symbol` - Get price history
  - Query params: `limit`, `from`, `to`

### Latest Data Endpoints
- `GET /db/latest/price/:symbol` - Get latest price for a specific symbol
- `GET /db/latest/candle/:symbol/:timeframe` - Get latest completed candle for a specific symbol and timeframe
- `GET /db/latest/candles/:symbol` - Get all latest completed candles for a specific symbol across all timeframes 