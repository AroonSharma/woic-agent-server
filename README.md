# WOIC Agent Server

WebSocket agent server for voice interactions - production deployment.

## Overview

This is a standalone WebSocket server that powers voice interactions for the WOIC application. It handles:

- **Speech-to-Text**: Deepgram integration for real-time transcription
- **AI Processing**: OpenAI GPT-4 for intelligent responses  
- **Text-to-Speech**: ElevenLabs for natural voice synthesis
- **WebSocket Management**: Real-time bidirectional communication

## Architecture

```
[Client] → wss://agent.woic.app/agent → [Agent Server]
                                      ↓
                           [Deepgram STT] → [OpenAI LLM] → [ElevenLabs TTS]
```

## Deployment

- **Platform**: Railway
- **Domain**: agent.woic.app
- **Port**: 4010 (internal)
- **Health Check**: `/healthz`
- **Metrics**: `/metrics`

## Environment Variables

Required environment variables for production:

```env
AGENT_WS_PORT=4010
DEEPGRAM_API_KEY=your_deepgram_key
OPENAI_API_KEY=your_openai_key
ELEVENLABS_API_KEY=your_elevenlabs_key
VOICE_ID=your_voice_id
LIVEKIT_URL=your_livekit_url
LIVEKIT_API_KEY=your_livekit_key
LIVEKIT_API_SECRET=your_livekit_secret
ALLOWED_ORIGINS=https://woic.realmonkey.ai,https://woic.app
NODE_ENV=production
```

## Development

```bash
npm install
npm run dev    # Development with ts-node
npm run build  # Build for production
npm start      # Run production build
```

## Docker

```bash
docker build -t woic-agent-server .
docker run -p 4010:4010 woic-agent-server
```

---

Generated from the main WOIC repository for standalone deployment.