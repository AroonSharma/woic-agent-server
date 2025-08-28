# Function Explanations - WOIC Agent Server

This document tracks the code files and their functionality, impact, and design decisions for the WOIC Agent Server.

---

## [2025-08-28] Production Agent Server Deployment - Complete Voice Processing System

### Core Server Infrastructure - WebSocket Voice Processing

#### **`src/agent-server.ts` - Main WebSocket Server (1,444 lines)**
**What it does**: Production-ready WebSocket server for real-time voice processing with Railway deployment support
**Key Features**: 
- WebSocket server handling real-time voice connections on production port (Railway's PORT variable)
- HTTP health check endpoint `/healthz` for Railway monitoring and deployment validation
- Session management with UUID-based session tracking and memory management
- Real-time audio processing pipeline integration (STT → LLM → TTS)
- CORS configuration for production domains (woic.app, woic.realmonkey.ai, your.woic.app)
- Connection pool integration for scalable WebSocket connection management
**Production Features**:
- Railway deployment compatibility with dynamic port configuration
- Health monitoring endpoint for uptime tracking
- Proper SSL/WSS handling via Railway proxy
- Session cleanup and resource management for production stability
- Error handling and logging for production debugging

#### **`src/agent-config.ts` - Enterprise Configuration Management**
**What it does**: Centralized production configuration system with API key validation and environment management
**Key Features**:
- Loads and validates all environment variables (API keys, voice processing parameters)
- API key format validation for Deepgram, OpenAI, ElevenLabs with security checks
- Fail-fast startup validation - prevents server start with invalid configuration
- Production vs development configuration handling
- Voice processing parameter configuration (STT/TTS timing, barge-in protection)
**Security Features**:
- API key format validation (Deepgram: 40 hex chars, OpenAI: sk- prefix, ElevenLabs: sk_ prefix)
- Environment variable presence validation with descriptive error messages
- Configuration constants export for backward compatibility
- Centralized configuration loading with comprehensive error handling

#### **`src/types.ts` - Local Type System (Replaces @vapi/types)**
**What it does**: Complete type definitions for WebSocket messages and voice processing pipeline
**Key Features**:
- WebSocket message interfaces (SessionStart, STTPartial, TTSChunk, SessionEnd)
- Voice processing pipeline types and configuration interfaces
- Agent configuration and session management types
- Real-time streaming and audio processing types
**Implementation Benefits**:
- Zero external type dependencies - no package version conflicts
- Complete control over type system evolution
- Optimized for agent server specific use cases
- Reliable builds without external dependency issues

### Voice Processing Pipeline Components

#### **`src/deepgram-manager.ts` - Speech-to-Text WebSocket Handling**
**What it does**: Manages Deepgram WebSocket connections for real-time speech-to-text processing
**Key Features**:
- Real-time audio streaming from WebSocket clients to Deepgram API
- Partial and final transcription handling with configurable parameters
- Endpointing and utterance detection with production-optimized settings
- Connection recovery and error handling for production stability
- Integration with agent server session management
**Production Configuration**:
- Configurable silence timeout (STT_SILENCE_TIMEOUT_MS: 2500ms)
- Utterance end detection (DEEPGRAM_UTTERANCE_END_MS: 2500ms)  
- Endpointing sensitivity (DEEPGRAM_ENDPOINTING_MS: 800ms)

#### **`src/elevenlabs.ts` - Text-to-Speech Streaming**
**What it does**: ElevenLabs voice synthesis integration with streaming audio generation
**Key Features**:
- Real-time voice synthesis with Raju voice (wbOlq3nIga8HKqcDhASI)
- Streaming audio generation for low-latency voice responses
- Audio chunk streaming to WebSocket clients
- Barge-in detection and interruption handling for natural conversations
- Voice selection and configuration management
**Production Optimization**:
- Minimum TTS duration before barge-in (TTS_MIN_DURATION_MS: 3000ms)
- Barge-in threshold words (TTS_BARGE_THRESHOLD_WORDS: 5)
- Protected phrases and sentence boundary protection
- Critical information protection for insurance-specific content

#### **`src/conversation-memory.ts` - Session Memory Management**
**What it does**: Chat history persistence and context management for multi-turn conversations
**Key Features**:
- Per-session conversation history storage and retrieval
- Context management for multi-turn conversations with OpenAI
- Memory cleanup and session termination handling
- Integration with OpenAI conversation context and system prompts
**Session Management**:
- UUID-based session tracking
- Memory efficient conversation storage
- Automatic cleanup on session end
- Context preservation for natural conversation flow

#### **`src/connection-pool.ts` - Scalable WebSocket Management**
**What it does**: WebSocket connection lifecycle management with pooling and health monitoring
**Key Features**:
- Scalable connection pooling for multiple concurrent voice sessions
- Heartbeat/ping-pong protocol for connection health monitoring
- Automatic cleanup of stale connections and resource management
- Connection metrics and monitoring for operational visibility
- Graceful disconnect handling and session cleanup
**Production Benefits**:
- Supports multiple concurrent voice sessions
- Resource efficient connection management
- Health monitoring for production stability
- Automatic recovery from connection failures

### Audio Processing Components

#### **`src/audio-pipeline.ts` - Real-time Audio Processing**
**What it does**: Audio stream processing and integration with voice activity detection
**Key Features**:
- Real-time audio stream processing from WebSocket clients
- Audio format conversion and buffering for optimal processing
- Integration with voice activity detection (VAD) for processing optimization
- Connection to speech-to-text services with proper audio formatting
**Performance Features**:
- Optimized audio stream handling
- Efficient buffering for real-time processing
- Integration with VAD for processing efficiency

#### **`src/webrtc-vad.ts` - Voice Activity Detection**
**What it does**: Real-time voice activity detection for audio processing optimization  
**Key Features**:
- Real-time analysis of audio streams for speech detection
- Audio stream analysis for voice presence detection
- Integration with audio pipeline for processing optimization
- Reduces unnecessary processing during silence periods

#### **`src/streaming-orchestrator.ts` - Multi-Stream Coordination**
**What it does**: Coordination between STT, LLM, and TTS streams for optimal voice processing
**Key Features**:
- Real-time coordination of multiple service streams
- Processing pipeline management for STT → LLM → TTS flow
- Error handling across multiple service streams
- Latency optimization for voice interactions under 2 seconds
**Production Benefits**:
- Optimized processing pipeline coordination
- Error recovery across service boundaries
- Performance optimization for real-time voice processing

#### **`src/intent-analyzer.ts` - User Intent Classification**
**What it does**: Natural language understanding and intent classification for conversation flow
**Key Features**:
- User intent detection and classification for insurance domain
- Context-aware response routing based on detected intent
- Integration with conversation memory for contextual understanding
- Insurance-specific intent recognition (existing customers, new customers, claims, etc.)

---

## Deployment & Configuration Files

### **`package.json` - Standalone Node.js Dependencies**
**What it does**: Defines agent server dependencies and build/run scripts for Railway deployment
**Key Dependencies**:
- Core: Node.js 20, TypeScript, WebSocket libraries
- Voice Processing: @deepgram/sdk, openai, elevenlabs
- Deployment: Production-optimized dependency management
**Scripts**:
- `build`: TypeScript compilation for production
- `start`: Production server startup
- `dev`: Development server with hot reload

### **`tsconfig.json` - Node.js TypeScript Configuration**
**What it does**: TypeScript compilation configuration optimized for Node.js server environment
**Key Configuration**:
- Target ES2022 for Node.js 20 compatibility
- CommonJS module system for Node.js
- Strict type checking enabled
- Source map generation for debugging

### **`Dockerfile` - Railway Deployment Container**
**What it does**: Docker containerization for Railway deployment with optimized build process
**Build Process**:
1. Node.js 20 Alpine base image for minimal footprint
2. Production dependency installation
3. TypeScript compilation
4. Production server startup
**Production Features**:
- Multi-stage build optimization
- Production-only dependencies
- Proper port exposure (4010)
- Optimized for Railway deployment

### **`railway.json` - Railway Configuration**
**What it does**: Railway-specific deployment configuration and health monitoring
**Configuration**:
- Dockerfile-based build process
- Health check endpoint (`/healthz`) configuration
- Port mapping and restart policy
- Production deployment settings

---

## Production Environment Integration

### **Railway Deployment Architecture**
**Infrastructure**:
- **Service**: woic-agent-server deployed on Railway
- **Domain**: your.woic.app with automatic SSL/WSS
- **Repository**: https://github.com/AroonSharma/woic-agent-server
- **Monitoring**: /healthz endpoint for Railway health checks

### **Web App Integration**
**Connection Flow**:
1. Web app (woic.app) loads with production configuration
2. WebSocket connection established to wss://your.woic.app/agent
3. Real-time voice processing via agent server
4. Complete voice pipeline: Audio → STT → LLM → TTS → Audio response

### **API Integration**
**External Services**:
- **Deepgram**: Real-time speech-to-text via WebSocket API
- **OpenAI**: GPT-4 conversation processing with insurance domain knowledge
- **ElevenLabs**: Voice synthesis with Raju voice for consistent branding

---

## File Impact Summary

**High Impact - Core Infrastructure**:
- `src/agent-server.ts`: Main WebSocket server enabling external voice access
- `src/agent-config.ts`: Production configuration management and validation
- `src/types.ts`: Complete type system independence from external packages

**Medium Impact - Voice Processing**:
- `src/deepgram-manager.ts`: Real-time STT processing
- `src/elevenlabs.ts`: Voice synthesis and streaming
- `src/conversation-memory.ts`: Session-based conversation management
- `src/connection-pool.ts`: Scalable WebSocket connection management

**Production Deployment**:
- `Dockerfile`: Railway containerization enabling cloud deployment
- `railway.json`: Railway-specific configuration for health monitoring
- `package.json`: Standalone dependency management
- `tsconfig.json`: Node.js optimized TypeScript compilation

**Performance & Scalability**:
- Connection pooling enables multiple concurrent voice sessions
- Health monitoring provides production operation visibility
- Resource cleanup prevents memory leaks in production
- Optimized voice processing parameters for real-time performance

**Security Enhancements**:
- API key validation prevents invalid configuration deployment
- CORS restrictions to specific production domains
- Production environment variable validation
- Secure configuration management with fail-fast validation