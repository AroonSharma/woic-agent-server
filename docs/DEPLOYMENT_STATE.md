# WOIC Agent Server - Deployment State

## Overview
Standalone WebSocket server for WOIC voice interactions, deployed on Railway.
Separated from main web application to enable external user access.

## Current Status
- **Repository**: https://github.com/AroonSharma/woic-agent-server.git
- **Railway Project**: Connected and deploying
- **Custom Domain**: your.woic.app (configured)
- **Last Deploy**: Railway healthcheck fixes committed
- **Status**: Monitoring deployment progress

## Environment Variables Required

### Railway Production Environment
```bash
# Core API Keys
DEEPGRAM_API_KEY=your_deepgram_key
OPENAI_API_KEY=sk-your_openai_key  
ELEVENLABS_API_KEY=sk_your_elevenlabs_key
VOICE_ID=your_voice_id

# Server Configuration
PORT=8080                    # Railway provides this automatically
LOG_LEVEL=info
TEST_HOOKS_ENABLED=false

# STT Settings
STT_SILENCE_TIMEOUT_MS=2000
DEEPGRAM_UTTERANCE_END_MS=1000  
DEEPGRAM_ENDPOINTING_MS=400

# TTS Settings
TTS_MIN_DURATION_MS=1000
TTS_BARGE_THRESHOLD_WORDS=3
TTS_PROTECTED_PHRASES=true
TTS_SENTENCE_BOUNDARY_PROTECTION=true
TTS_CLAUSE_PROTECTION_MS=800
TTS_CRITICAL_INFO_PROTECTION=true

# Safety Limits
MAX_FRAME_BYTES=262144       # 256KB
MAX_JSON_BYTES=65536         # 64KB  
MAX_AUDIO_FRAMES_PER_SEC=100
```

## API Endpoints

### Health Check
- `GET /healthz` - Health check endpoint for Railway
- Returns: `{"status": "healthy", "timestamp": "..."}`

### WebSocket Connection
- `WS /agent` - Main voice interaction endpoint
- Protocol: WebSocket with binary audio frames + JSON control messages

## Railway Configuration

### railway.json
```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE", 
    "dockerfilePath": "./Dockerfile"
  },
  "deploy": {
    "healthcheckPath": "/healthz",
    "healthcheckTimeout": 300,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 5
  }
}
```

### Dockerfile Optimizations
- Node.js 18 Alpine base image
- Multi-stage build for smaller image
- Non-root user for security
- Proper signal handling for graceful shutdown

## Connection from Web App

The main web application at https://woic.realmonkey.ai connects to this server:

```typescript
// Production WebSocket connection
const wsUrl = 'wss://your.woic.app/agent';

// Development fallback  
const wsUrl = process.env.NODE_ENV === 'development' 
  ? 'ws://localhost:4010/agent'
  : 'wss://your.woic.app/agent';
```

## Architecture Benefits

1. **Scalability**: Agent server can scale independently 
2. **Security**: Isolated API keys and resources
3. **Reliability**: Dedicated infrastructure for voice processing
4. **Performance**: Optimized specifically for real-time audio
5. **Maintenance**: Separate deployment cycles

## Monitoring & Logs

### Railway Dashboard
- Build logs and deployment status
- Real-time application logs
- Resource usage metrics
- Custom domain configuration

### Health Monitoring
- Automatic healthchecks every 30 seconds
- Restart on failure with exponential backoff
- Connection quality metrics

## Recent Changes

### Latest Commit: Railway Fixes
- Fixed healthcheck path from `/health` to `/healthz`
- Added proper Railway PORT environment variable support
- Increased healthcheck timeout to 300 seconds
- Improved error handling for deployment edge cases

## Next Steps

1. ✅ Monitor current Railway deployment
2. ⏳ Verify production deployment success  
3. ⏳ Test WebSocket connection from external network
4. ⏳ Update web app configuration to use your.woic.app
5. ⏳ End-to-end voice functionality testing

---
*Last Updated: 2025-08-27 - Railway healthcheck fixes deployed*