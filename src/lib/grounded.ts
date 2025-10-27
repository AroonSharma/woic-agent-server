import OpenAI from 'openai';
import { supabaseService } from './supabaseServer';
import { retrieve, type RetrievedChunk } from './retrieve';

export interface GroundedSource {
  sourceId: string;
  title: string;
  url: string | null;
}

export interface GroundedAnswerResult {
  text: string;
  sources: GroundedSource[];
}

function groupBySource(chunks: RetrievedChunk[]): Map<string, RetrievedChunk[]> {
  const map = new Map<string, RetrievedChunk[]>();
  for (const ch of chunks) {
    const arr = map.get(ch.sourceId) || [];
    arr.push(ch);
    map.set(ch.sourceId, arr);
  }
  return map;
}

export async function groundedAnswer(query: string, agentId: string | null, topK = 10): Promise<GroundedAnswerResult> {
  const sb = supabaseService();
  let chunks = await retrieve(query, agentId, topK);

  if (chunks.length === 0) {
    // No KB results → return empty to avoid hallucinating from general model
    return { text: "I don't have enough information for that yet.", sources: [] };
  }

  const bySource = groupBySource(chunks);
  const sourceIds = Array.from(bySource.keys());

  const { data: sourceRows, error: srcErr } = await sb
    .from('kb_sources')
    .select('id, url, meta')
    .in('id', sourceIds);
  if (srcErr) {
    throw new Error(`kb_sources_fetch_failed:${srcErr.message}`);
  }

  // Build context with top chunks per source (limit to avoid prompt bloat)
  const contextPieces: string[] = [];
  const sources: GroundedSource[] = [];

  for (const row of sourceRows || []) {
    const sid = (row as any).id as string;
    const url = (row as any).url as string | null;
    const title = String(((row as any).meta?.title || (url ? new URL(url).hostname : '')) || '');
    // Expand to 3 chunks per source to improve recall
    const topFromSource = (bySource.get(sid) || []).sort((a, b) => b.score - a.score).slice(0, 3);
    for (const item of topFromSource) {
      contextPieces.push(`[Source ${sources.length + 1}] ${title || url || sid}\n${item.content}`);
    }
    sources.push({ sourceId: sid, title, url });
  }

  console.log('[grounded] Personal RAG: Processing', chunks.length, 'chunks through LLM transformation');
  const prompt = buildPrompt(query, contextPieces);
  // For personal RAG, always use LLM to transform KB content into personal, conversational responses
  // Skip direct/extractive answers to ensure personal transformation
  // Debug mode: directly return top chunk content to validate retrieval
  if (String(process.env.KB_ECHO_TOP || 'false') === 'true') {
    const top = chunks[0]?.content?.trim() || '';
    console.log('[grounded] DEBUG MODE: Returning raw chunk content');
    return { text: top, sources };
  }
  console.log('[grounded] Calling LLM with personal prompt for transformation');
  let text = await answerWithLLM(prompt, contextPieces);
  
  // Enforce 240 character limit
  if (text.length > 240) {
    text = text.substring(0, 237) + '...?';
  }
  
  console.log(`[grounded] LLM returned (${text.length} chars):`, text);
  return { text, sources };
}

function normalizeTokens(input: string): string[] {
  const base = String(input || '').toLowerCase().replace(/[^a-z0-9\s]+/g, ' ');
  const raw = base.split(/\s+/).filter(Boolean);
  const out = new Set<string>();

  // Generic token normalization - no hardcoded company-specific terms
  for (const t of raw) {
    out.add(t);

    // Only handle common compound word splitting (generic)
    if (t.length > 8 && /[a-z][A-Z]/.test(t)) {
      // Split camelCase: "webDesign" → "web", "design"
      const parts = t.split(/(?=[A-Z])/);
      parts.forEach(p => out.add(p.toLowerCase()));
    }
  }

  return Array.from(out);
}

function pickDirectAnswer(query: string, chunks: RetrievedChunk[]): string | null {
  const qTokens = normalizeTokens(query);
  let best: { text: string; score: number } | null = null;
  for (const ch of chunks) {
    const t = String(ch.content || '').toLowerCase();
    let score = 0;
    for (const qt of qTokens) {
      if (qt.length < 2) continue;
      if (t.includes(qt)) score += qt.split(' ').length >= 2 ? 2 : 1;
    }
    if (!best || score > best.score) {
      best = { text: ch.content.trim(), score };
    }
  }
  if (best && best.score >= 1) {
    // Return a concise snippet (first 350 chars)
    const snippet = best.text.length > 350 ? best.text.slice(0, 350) + '…' : best.text;
    return snippet;
  }
  return null;
}

function buildExtractiveAnswer(query: string, chunks: RetrievedChunk[]): string | null {
  const q = String(query || '').toLowerCase();
  const keyPhrases = normalizeTokens(query).filter((t) => t.length >= 3);
  const sentences: string[] = [];
  for (const ch of chunks) {
    const text = String(ch.content || '');
    const parts = text.split(/(?<=[\.!?])\s+/g);
    for (const s of parts) {
      const ls = s.toLowerCase();
      // Match either the full query substring or overlapping key phrases
      const phraseHit = q.length >= 8 && ls.includes(q);
      const tokenHits = keyPhrases.reduce((acc, t) => acc + (ls.includes(t) ? 1 : 0), 0);
      if (phraseHit || tokenHits >= 2) {
        sentences.push(s.trim());
        if (sentences.length >= 3) break;
      }
    }
    if (sentences.length >= 3) break;
  }
  if (sentences.length > 0) {
    const joined = sentences.join(' ');
    return joined.length > 420 ? joined.slice(0, 420) + '…' : joined;
  }
  return null;
}

function buildPrompt(query: string, contextPieces: string[]): string {
  const header = [
    'You are a knowledgeable, personable AI assistant speaking as an expert in your field.',
    'Use the information below as YOUR OWN expertise and experience.',
    'Speak personally - say "I", "we", "our".',
    'CRITICAL: Keep response UNDER 240 CHARACTERS (about 40 words).',
    'ALWAYS end with a specific question to engage the user.',
    'Example format: "We specialize in [key service]. I love helping with [benefit]. What specific challenge are you facing?"',
    'Never mention documents or sources.',
    'Be direct, enthusiastic, and conversational.'
  ].join(' ');

  const context = contextPieces.map((p, i) => `Your Expertise Area ${i + 1}:\n${p}`).join('\n\n');
  return `${header}\n\n${context}\n\nUser question: ${query}\n\nRespond in UNDER 240 CHARACTERS with a personal answer + engaging question:`;
}

async function answerWithLLM(prompt: string, _context: string[]): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !apiKey.startsWith('sk-')) {
    throw new Error('openai_key_missing');
  }
  const openai = new OpenAI({ apiKey });
  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are an expert. STRICT RULE: Response must be UNDER 240 CHARACTERS. Always end with a question. Format: Brief answer + engaging question.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.7, // Higher temperature for more conversational, personal responses
    max_tokens: 80, // Strict limit for ~240 characters
  });
  const text = resp.choices?.[0]?.message?.content?.trim() || '';
  return text;
}
