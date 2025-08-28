# Repository Rules for AI Assistants - WOIC Agent Server

You are collaborating on the WOIC Agent Server repository. Before proposing changes or plans:
1) Read and ground yourself in:
   - /docs/SYSTEM_INTEGRATION.md (CRITICAL - defines integration with web app)
   - /docs/ARCHITECTURE.md
   - /docs/CODEMAP.md
   - /docs/CURRENT_WORKING_STATE.md
   - /docs/DECISIONS.md
   - /docs/CHANGELOG.md
   - /docs/FunctionExplanations.md
   - /docs/NEXT_TASKS.md
   
2) Always begin by producing a "Thread Context Snapshot" (<250 tokens) that includes:
   - One-liner of the agent server project
   - Current deployment status
   - Top 3 operational constraints
   - Today's target from /docs/NEXT_TASKS.md

3) When writing code for the agent server:
   - Explain plan first, then provide patch-style diffs
   - Prefer small, reviewable changes focused on WebSocket/voice functionality
   - Test with production WebSocket connections and voice pipeline
   - Call out latency/performance implications for real-time voice processing

4) After completing a task:
   - Output a "Session Log Draft" for pasting into:
     - /docs/CHANGELOG.md (agent server deployment and voice processing changes)
     - /docs/DECISIONS.md (if any architecture or deployment decisions were made)
     - /docs/NEXT_TASKS.md (updated operational and enhancement priorities)

5) If context is missing/outdated about agent server deployment, ask targeted questions referencing the exact doc to update.

## Agent Server Specific Context:
- **Primary Function**: Real-time voice processing WebSocket server
- **Production URL**: wss://your.woic.app/agent
- **Tech Stack**: Node.js, TypeScript, WebSocket, Deepgram STT, OpenAI LLM, ElevenLabs TTS
- **Deployment**: Railway containerized deployment with Docker
- **Integration**: Works with WOIC web application for complete voice AI experience