# WOIC Agent Server - Technical Architecture

## System Overview

The WOIC Agent Server is a high-performance WebSocket server that handles real-time voice interactions through a sophisticated audio processing pipeline.

## Core Components

### 1. WebSocket Server (`src/agent-server.ts`)
- **Framework**: Native Node.js WebSocket server
- **Port**: Railway PORT (production) / 4010 (development)  
- **Protocols**: Binary audio frames + JSON control messages
- **Features**: Connection management, session handling, error recovery

### 2. Audio Processing Pipeline

#### Streaming Orchestrator (`src/streaming-orchestrator.ts`)
- **Purpose**: Coordinates parallel STT → LLM → TTS pipeline
- **Key Features**:
  - Speculative execution (starts LLM on interim STT results)
  - Parallel streaming for ultra-low latency
  - Smart interruption handling
  - Performance metrics collection

#### Voice Activity Detection (`src/webrtc-vad.ts`)
- **Technology**: WebRTC-grade energy + frequency analysis
- **Performance**: <50ms detection latency
- **Features**:
  - Adaptive noise floor adjustment
  - Pre-speech buffering (never miss start of speech)
  - Spectral gating for noise filtering

#### Audio Pipeline (`src/audio-pipeline.ts`)
- **Processing**: Real-time audio format conversion
- **Input**: Raw WebSocket binary frames (PCM16, 16kHz)
- **Features**: Downsampling, energy calculation, buffering strategies

### 3. External Service Integrations

#### Speech-to-Text: Deepgram (`src/deepgram-manager.ts`)
- **Model**: Nova-2 with optimized endpointing
- **Settings**: 300ms wait time, smart punctuation
- **Features**: Interim results, confidence scoring

#### Language Model: OpenAI (`src/agent-config.ts`)
- **Model**: GPT-4o-mini for speed
- **Configuration**: 
  - Temperature: 0 (deterministic)
  - Max tokens: 150 (concise responses)
  - Streaming enabled for first token optimization

#### Text-to-Speech: ElevenLabs (`src/elevenlabs.ts`)  
- **Technology**: Streaming synthesis with optimized latency
- **Settings**: Latency level 2, voice cloning support
- **Features**: Chunk-based streaming, interruption support

### 4. Intelligence Layer

#### Intent Analyzer (`src/intent-analyzer.ts`)
- **Purpose**: Context-aware response optimization
- **Features**:
  - Insurance domain specific intents
  - Suggested responses for common queries
  - Confidence scoring for intent matching

#### Conversation Memory (`src/conversation-memory.ts`)
- **Storage**: In-memory session management
- **Features**:
  - Multi-session support
  - Message history with role tracking
  - Automatic cleanup and limits

## Performance Optimizations

### Latency Reduction
1. **Parallel Streaming**: STT, LLM, and TTS run concurrently
2. **Speculative Execution**: Start LLM on high-confidence interim results
3. **First Token Optimization**: Minimal time to first response
4. **Pre-buffering**: Never miss beginning of speech

### Resource Management
1. **Connection Pooling**: Reuse external API connections
2. **Memory Limits**: Automatic cleanup of old sessions
3. **Rate Limiting**: Per-session audio frame limits
4. **Error Recovery**: Graceful degradation on API failures

### Scalability Features
1. **Stateless Design**: Each WebSocket connection is independent
2. **Horizontal Scaling**: Multiple instances can run in parallel
3. **Health Monitoring**: Built-in healthcheck endpoint
4. **Graceful Shutdown**: Proper cleanup on restart

## Security Measures

### API Key Management
- All keys stored in Railway environment variables
- No hardcoded secrets in source code
- Validation on startup with detailed error messages

### Input Validation  
- Maximum frame size limits (256KB)
- JSON message size limits (64KB)
- Audio frame rate limiting (100/sec per session)

### Network Security
- HTTPS/WSS only in production
- CORS configuration for web app origin
- Request timeout and connection limits

## Data Flow Architecture

```
External User → Web App → Agent Server Pipeline:

1. Audio Capture (Web App)
   ↓
2. WebSocket Connection (wss://your.woic.app/agent)
   ↓  
3. Voice Activity Detection (Instant <50ms)
   ↓
4. Parallel Processing:
   ├── STT (Deepgram) → Intent Analysis
   ├── LLM (OpenAI) → Response Generation  
   └── TTS (ElevenLabs) → Audio Synthesis
   ↓
5. Streaming Response → Web App → User Audio
```

## Monitoring & Observability

### Built-in Metrics
- Pipeline latency breakdown (STT/LLM/TTS)
- Connection count and session duration  
- Audio processing statistics
- Error rates and types

### Railway Integration
- Health check endpoint (`/healthz`)
- Structured logging with correlation IDs
- Resource usage monitoring
- Automatic restart on failure

## Environment Configuration

### Development
```bash
PORT=4010
LOG_LEVEL=debug
TEST_HOOKS_ENABLED=true
```

### Production (Railway)
```bash
PORT=8080  # Provided by Railway
LOG_LEVEL=info
TEST_HOOKS_ENABLED=false
# + All API keys and service configuration
```

## Deployment Pipeline

1. **Source**: GitHub repository with automated builds
2. **Build**: Docker multi-stage build with TypeScript compilation
3. **Deploy**: Railway with healthcheck validation
4. **Monitor**: Real-time logs and metrics via Railway dashboard

---
*Architecture designed for enterprise-scale voice AI applications*