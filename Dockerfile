# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files and workspace
COPY package*.json ./
COPY packages ./packages

# Install all dependencies (including dev deps for build)
RUN npm install

# Copy TypeScript config and source
COPY tsconfig.json ./
COPY src ./src

# Build @vapi/types package first
RUN cd packages/types && npm run build

# Build main application
RUN npm run build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

# Copy package files and workspace
COPY package*.json ./
COPY packages ./packages

# Install only production dependencies
RUN npm install --only=production

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Expose WebSocket port
EXPOSE 4010

# Start server
CMD ["npm", "start"]