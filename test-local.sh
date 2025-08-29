#!/bin/bash

echo "🚀 Starting Railway agent-server locally on port 4030 for testing..."
echo "✅ Working local server remains on port 4010"
echo ""

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

# Check if dist folder exists
if [ ! -d "dist" ]; then
    echo "🔨 Building TypeScript..."
    npm run build
fi

echo ""
echo "🎯 Starting test server on port 4030..."
echo "📝 Logs will appear below:"
echo "================================"

# Run the server
npm start