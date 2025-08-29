FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy packages directory for @vapi/types
COPY packages ./packages

# Copy TypeScript config and source
COPY tsconfig.json ./
COPY src ./src

# Install TypeScript for build
RUN npm install -g typescript

# Build TypeScript
RUN npm run build

# Expose WebSocket port
EXPOSE 4010

# Start server
CMD ["npm", "start"]