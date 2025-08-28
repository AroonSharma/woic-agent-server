# Production Hosting Architecture - Vapi Voice AI Platform

## **Current Local Development Setup**
```
User Browser (localhost:5175) 
    ↓ [Vite Dev Server with Proxy]
    ├── /api/* → Next.js Server (localhost:3010) 
    └── /agent → WebSocket Server (localhost:4010)
```

## **Production Hosting Architecture Options**

### **Option 1: Unified Single-Domain Deployment** (Recommended)
```
User Browser (yourdomain.com)
    ↓ [Reverse Proxy/CDN]
    ├── Static Files (/) → Static UI Build (Vite dist/)
    ├── API (/api/*) → Next.js Server (API Container)
    └── WebSocket (/agent) → WebSocket Server (WS Container)
```

**Benefits**: 
- No CORS issues (same domain)
- Simple SSL certificate management
- Clean URL structure

**Hosting Options**:
- **Vercel**: Next.js + static files + serverless functions
- **Railway/Render**: Containers for Next.js + WebSocket
- **AWS/GCP**: Load balancer + containers + CloudFront

### **Option 2: Multi-Domain Deployment**
```
User Browser
    ├── UI: ui.yourdomain.com (Static hosting)
    ├── API: api.yourdomain.com (Next.js server) 
    └── WebSocket: ws.yourdomain.com (WebSocket server)
```

**Requires**: 
- CORS configuration for production domains
- Multiple SSL certificates
- Environment variable: `VITE_API_BASE=https://api.yourdomain.com/api`

## **Key Production Configuration Changes**

### **1. Environment Variables**
```bash
# UI Production (.env.production)
VITE_API_BASE=https://yourdomain.com/api  # or api.yourdomain.com
VITE_SUPABASE_URL=your_production_supabase
VITE_SUPABASE_ANON_KEY=your_production_key

# Backend Production
ALLOWED_ORIGINS=https://yourdomain.com,https://ui.yourdomain.com
SUPABASE_URL=your_production_db
OPENAI_API_KEY=your_production_key
```

### **2. CORS Configuration Updates**
```javascript
// web/next.config.mjs - Production domains
headers: [
  {
    source: '/api/:path*',
    headers: [
      { key: 'Access-Control-Allow-Origin', value: 'https://yourdomain.com' },
      // ... other headers
    ],
  },
]
```

### **3. WebSocket Connection Updates**
```javascript
// UI production WebSocket URL
const wsUrl = process.env.NODE_ENV === 'production' 
  ? 'wss://yourdomain.com/agent' 
  : 'ws://localhost:4010/agent'
```

## **Deployment Flow**

### **Single Domain (Recommended)**
1. **UI Build**: `cd UI && npm run build` → Static files
2. **API Deploy**: Next.js server with API routes
3. **WebSocket Deploy**: Separate process/container for agent-server.ts
4. **Reverse Proxy**: Nginx/CloudFront routes by path

### **Multi-Domain**
1. **UI Deploy**: Static hosting (Vercel, Netlify, S3+CloudFront)
2. **API Deploy**: Server hosting (Railway, Render, AWS ECS)
3. **WebSocket Deploy**: Separate WebSocket hosting
4. **DNS**: Configure subdomains

## **Production Considerations**

### **Scaling**: 
- WebSocket server needs sticky sessions/session affinity
- Connection pool metrics for monitoring
- Database connection pooling

### **Security**:
- HTTPS everywhere (WSS for WebSockets)
- Production API keys in secure environment variables
- Rate limiting on upload endpoints

### **Monitoring**:
- Your existing `/api/metrics` endpoint for connection health
- Error tracking (Sentry, LogRocket)
- Performance monitoring for voice latency

## **Migration from Local to Production**

### **Development → Production Checklist**

#### **UI Configuration**
- [ ] Update `UI/.env.production` with production API URLs
- [ ] Remove Vite proxy dependency (direct API calls in production)
- [ ] Build static assets: `npm run build`
- [ ] Test build locally: `npm run preview`

#### **API Configuration** 
- [ ] Update `web/next.config.mjs` CORS headers for production domains
- [ ] Set production environment variables
- [ ] Configure Supabase production database
- [ ] Test API endpoints with production CORS

#### **WebSocket Configuration**
- [ ] Update WebSocket URL in frontend for production
- [ ] Configure WebSocket server for production domain
- [ ] Test WebSocket connection with WSS (secure WebSocket)
- [ ] Validate connection pool behavior under load

#### **Deployment Infrastructure**
- [ ] Choose hosting option (single vs multi-domain)
- [ ] Set up reverse proxy/load balancer if needed
- [ ] Configure SSL certificates
- [ ] Set up monitoring and error tracking
- [ ] Test end-to-end voice pipeline in production

The current proxy setup makes development smooth, but production gives you flexibility in how you deploy and scale each component independently.