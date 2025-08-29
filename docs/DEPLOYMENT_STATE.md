# WOIC Agent Server - Deployment State

## Overview
Standalone WebSocket server for WOIC voice interactions, deployed on Railway.
Separated from main web application to enable external user access.

## Current Status
- **Repository**: https://github.com/AroonSharma/woic-agent-server.git
- **Railway Project**: ✅ FULLY OPERATIONAL
- **Production URL**: https://woic-agent-server-production.up.railway.app
- **WebSocket Endpoint**: wss://woic-agent-server-production.up.railway.app/agent
- **Last Deploy**: Complete voice pipeline fixes deployed (2025-08-29)
- **Status**: ✅ VOICE PIPELINE 100% OPERATIONAL

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
const wsUrl = 'wss://woic-agent-server-production.up.railway.app/agent';

// Development fallback  
const wsUrl = process.env.NODE_ENV === 'development' 
  ? 'ws://localhost:4010/agent'
  : 'wss://woic-agent-server-production.up.railway.app/agent';
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

### Latest Commit: Complete Production Deployment (2025-08-29)
- ✅ Fixed ElevenLabs TTS audio output (removed extra space in API key)
- ✅ Fixed @vapi/types module Docker build issues
- ✅ Resolved Deepgram infinite reconnection API credit drain
- ✅ Fixed Railway health check configuration (PORT environment variable)
- ✅ Removed .env file dependencies for Railway compatibility
- ✅ Added session-aware reconnection logic
- ✅ Complete STT → LLM → TTS pipeline operational

## Completed Deployment

1. ✅ Railway deployment fully operational
2. ✅ Production voice pipeline verified working  
3. ✅ WebSocket connections stable from external networks
4. ✅ Voice processing (STT → LLM → TTS) operational
5. ✅ All API integrations (Deepgram, OpenAI, ElevenLabs) working
6. ✅ User can hear AI voice responses in production

---
*Last Updated: 2025-08-29 - Voice Pipeline 100% Operational on Railway*