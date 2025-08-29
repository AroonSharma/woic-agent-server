# WOIC Agent Server Code Map

## 🎯 Architecture Overview - Standalone WebSocket Voice Processing Service

**Primary Function**: Real-time voice processing WebSocket server for WOIC platform
**Production URL**: wss://woic-agent-server-production.up.railway.app/agent  
**Deployment**: Railway containerized deployment with Docker (Port 8080)

### Top-Level Structure - Agent Server

```
/src/                           # TypeScript source code
├── agent-server.ts             # Main WebSocket server entry point (1,444 lines)
├── agent-config.ts             # Centralized configuration management with API key validation
├── types.ts                    # Local type definitions 
├── packages/types/             # @vapi/types workspace package for schema definitions
├── deepgram-manager.ts         # Speech-to-text WebSocket handling
├── elevenlabs.ts               # Text-to-speech streaming
├── conversation-memory.ts      # Chat history and session management
├── connection-pool.ts          # WebSocket connection lifecycle management
├── audio-pipeline.ts           # Audio processing with VAD integration
├── streaming-orchestrator.ts   # Multi-stream processing coordination
├── intent-analyzer.ts          # User intent detection and classification
└── webrtc-vad.ts              # Voice activity detection

/dist/                          # Compiled JavaScript output
├── agent-server.js             # Production entry point
└── [all compiled .js files]   # Built from TypeScript source

/docs/                          # Agent server documentation
├── ARCHITECTURE.md             # Technical architecture and data flow
├── DEPLOYMENT_STATE.md         # Production deployment status and configuration
└── [documentation files]      # Agent server specific documentation

# Configuration & Build
├── package.json                # Standalone Node.js dependencies
├── tsconfig.json              # TypeScript configuration for Node.js
├── Dockerfile                 # Railway deployment container
├── railway.json               # Railway deployment configuration
└── .env                       # Production environment variables
```

## 🔧 Core Infrastructure

### Main Entry Point
**`src/agent-server.ts`** - WebSocket Server Core (1,444 lines)
- Production WebSocket server on port 4010 (Railway maps to 443)
- HTTP health check endpoint at `/healthz` for Railway monitoring
- Session management with UUID-based session tracking
- Real-time audio processing pipeline integration
- CORS configuration for production domains (woic.app, woic.realmonkey.ai)
- Connection pool integration for scalable WebSocket management

### Configuration Management  
**`src/agent-config.ts`** - Enterprise Configuration System
- Centralized environment variable loading and validation
- API key validation (Deepgram, OpenAI, ElevenLabs format checking)
- Configurable voice processing parameters (STT/TTS timing, barge-in protection)
- Production vs development configuration handling
- Fail-fast startup on invalid configuration

### Type Definitions
**`src/types.ts`** - Local Type System
- Complete replacement for @vapi/types dependency
- WebSocket message interfaces (SessionStart, STTPartial, TTSChunk, etc.)
- Voice processing pipeline types
- Configuration and session management interfaces

## 🎤 Voice Processing Pipeline

### Speech-to-Text
**`src/deepgram-manager.ts`** - STT WebSocket Handling
- Deepgram WebSocket connection management
- Real-time audio streaming from client
- Partial and final transcription handling
- Configurable endpointing and utterance detection
- Error handling and connection recovery

### Text-to-Speech
**`src/elevenlabs.ts`** - TTS Streaming
- ElevenLabs voice synthesis API integration
- Streaming audio generation for low latency
- Voice selection and configuration
- Audio chunk streaming to WebSocket clients
- Barge-in detection and interruption handling

### Conversation Management
**`src/conversation-memory.ts`** - Session Memory
- Chat history persistence per session
- Context management for multi-turn conversations
- Memory cleanup and session termination
- Integration with OpenAI conversation context

### Intent Analysis
**`src/intent-analyzer.ts`** - User Intent Detection
- Natural language understanding for user requests
- Intent classification for conversation flow
- Context-aware response routing
- Integration with conversation memory

## 🔌 Connection Infrastructure

### WebSocket Management
**`src/connection-pool.ts`** - Connection Lifecycle
- Scalable WebSocket connection pooling
- Heartbeat/ping-pong protocol for connection health
- Automatic cleanup of stale connections
- Connection metrics and monitoring
- Graceful disconnect handling

### Audio Processing
**`src/audio-pipeline.ts`** - Real-time Audio
- Audio stream processing from WebSocket clients
- Integration with voice activity detection (VAD)
- Audio format conversion and buffering
- Connection to STT services

### Voice Activity Detection
**`src/webrtc-vad.ts`** - VAD Integration
- Real-time voice activity detection
- Audio stream analysis for speech detection
- Integration with audio pipeline for processing optimization

### Stream Coordination
**`src/streaming-orchestrator.ts`** - Multi-stream Processing
- Coordination between STT, LLM, and TTS streams
- Real-time processing pipeline management
- Error handling across multiple service streams
- Latency optimization for voice interactions

## 🚀 Deployment Architecture

### Railway Deployment
```
Railway Service: woic-agent-server
├── Custom Domain: your.woic.app
├── Port Mapping: 4010 (internal) → 443 (external WSS)
├── Health Check: /healthz endpoint
├── Environment: Production API keys and configuration
└── Build: Dockerfile-based containerized deployment
```

### Production Environment
```env
# Core Configuration
PORT=4010
NODE_ENV=production

# API Keys (Production)
DEEPGRAM_API_KEY=3370086a...
OPENAI_API_KEY=sk-proj-vbzb...
ELEVENLABS_API_KEY=sk_5a063...
VOICE_ID=wbOlq3nIga8HKqcDhASI

# CORS & Security
ALLOWED_ORIGINS=https://woic.app,https://woic.realmonkey.ai,https://your.woic.app

# Voice Processing Optimization
STT_SILENCE_TIMEOUT_MS=2500
TTS_MIN_DURATION_MS=3000
TTS_BARGE_THRESHOLD_WORDS=5
TTS_PROTECTED_PHRASES=true
```

### Integration Points

**Client Connection Flow**:
```
Web App (woic.app) 
    ↓ WebSocket Connection
wss://your.woic.app/agent
    ↓ Audio Processing
STT (Deepgram) → LLM (OpenAI) → TTS (ElevenLabs)
    ↓ Voice Response
Audio Stream → Client
```

**External Service Dependencies**:
- **Deepgram**: Speech-to-text processing via WebSocket API
- **OpenAI**: GPT-4 language model for conversation processing  
- **ElevenLabs**: Voice synthesis for natural speech generation
- **Railway**: Cloud deployment platform with custom domain support

## 📊 Key Performance Features

- ✅ **Real-time Processing**: <100ms WebSocket connection latency
- ✅ **Scalable Connections**: Connection pool supports multiple concurrent sessions
- ✅ **Health Monitoring**: /healthz endpoint for uptime monitoring
- ✅ **Error Recovery**: Automatic reconnection and graceful error handling
- ✅ **Resource Cleanup**: Proper session termination and memory management
- ✅ **Production Ready**: Enterprise configuration and API key management

## 🔗 Integration with WOIC Web App

The agent server operates as a standalone service that integrates with the main WOIC web application:

- **Web App**: https://woic.app (Next.js application)
- **Agent Server**: wss://your.woic.app/agent (WebSocket service)
- **Communication**: WebSocket protocol for real-time voice interactions
- **Authentication**: Session-based authentication via web app
- **Deployment**: Independent Railway services for scalable architecture