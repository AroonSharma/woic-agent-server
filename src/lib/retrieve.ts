import { supabaseService } from './supabaseServer';
import { openAIEmbed } from './kb';
import OpenAI from 'openai';

export interface RetrievedChunk {
  chunkId: string;
  sourceId: string;
  agentId: string | null;
  content: string;
  score: number; // 0..1 combined
  details: {
    embedDistance?: number;
    embedSim?: number;
    kwRank?: number;
    rerankScore?: number;
  };
}

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const DEBUG = LOG_LEVEL === 'debug';

export async function embedQuery(query: string): Promise<number[]> {
  if (!query || !query.trim()) throw new Error('query_required');
  const vec = (await openAIEmbed(query)) as number[];
  if (DEBUG) console.log('[embedQuery] Generated embedding:', { dimensions: vec.length });
  return vec;
}

/**
 * AI-powered query rewriting with semantic expansion
 * Replaces hardcoded term matching with dynamic AI-based query expansion
 */
async function rewriteQuery(query: string): Promise<string> {
  const q = String(query || '').trim().toLowerCase();

  // Basic normalization (only generic ASR artifacts, no brand-specific terms)
  const normalized = q
    .replace(/\ba[\. ]?i[\. ]?\b/gi, 'ai')
    .replace(/\bwebsite\s*design(?:ing)?\b/gi, 'website design')
    .trim();

  if (DEBUG) console.log('[rewriteQuery] Normalized query:', { original: query, normalized });

  // Use AI to generate semantic variations for better retrieval
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || !apiKey.startsWith('sk-')) {
      if (DEBUG) console.log('[rewriteQuery] No API key, using normalized query only');
      return normalized;
    }

    const openai = new OpenAI({ apiKey });
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'system',
        content: 'Generate 2-4 semantic variations and related terms for search. Return ONLY comma-separated phrases, no explanations. Focus on: synonyms, phonetically similar words, related concepts, alternative spellings, industry terms. If the word sounds like a name or brand, include similar-sounding variations.'
      }, {
        role: 'user',
        content: `Query: "${normalized}"\n\nConsider: This might be misheard speech-to-text. Include phonetically similar terms.`
      }],
      temperature: 0.4,
      max_tokens: 100
    });

    const aiVariations = response.choices[0]?.message?.content
      ?.split(',')
      .map(s => s.trim().toLowerCase())
      .filter(s => s.length > 2 && s.length < 100) || [];

    // Combine original + AI variations
    const allVariations = [normalized, ...aiVariations];
    const unique = Array.from(new Set(allVariations));
    const combined = unique.slice(0, 5).join(' | '); // Limit to 5 variations

    if (DEBUG) {
      console.log('[rewriteQuery] AI-expanded query:', {
        original: query,
        normalized,
        aiVariations,
        combined
      });
    }

    return combined;
  } catch (err) {
    console.warn('[rewriteQuery] AI expansion failed, using normalized query:', err instanceof Error ? err.message : String(err));
    return normalized;
  }
}

export async function retrieve(query: string, agentId: string | null, topK = 6): Promise<RetrievedChunk[]> {
  const startTime = Date.now();
  const sb = supabaseService();

  console.log('[retrieve] 🔍 Starting retrieval:', {
    query,
    agentId,
    topK,
    timestamp: new Date().toISOString()
  });

  const rewritten = await rewriteQuery(query); // Now async
  const embedding = await embedQuery(query);

  if (DEBUG) {
    console.log('[retrieve] Query prepared:', {
      original: query,
      rewritten: rewritten.substring(0, 200) + (rewritten.length > 200 ? '...' : ''),
      embeddingDimensions: embedding.length
    });
  }

  // Vector search
  let vData: unknown[] | null = null;
  const { data: vTry, error: vErr } = await sb.rpc('f_kb_search_by_embedding', {
    p_agent_id: agentId,
    p_embedding: embedding,
    p_top_k: topK
  });
  if (vErr) {
    console.error('[retrieve] ❌ Vector search failed:', vErr.message);
    vData = [];
  } else {
    vData = vTry as any[];
    console.log('[retrieve] ✅ Vector search results:', {
      count: Array.isArray(vData) ? vData.length : 0,
      agentIdUsed: agentId,
      topDistance: Array.isArray(vData) && vData.length > 0 ? (vData[0] as any).distance : null
    });
  }

  // Keyword search
  const { data: kData, error: kErr } = await sb.rpc('f_kb_search_by_keyword', {
    p_agent_id: agentId,
    p_query: rewritten,
    p_top_k: topK
  });
  if (kErr) {
    console.error('[retrieve] ❌ Keyword search failed:', kErr.message);
    // If both fail, return empty
    if (!vData || vData.length === 0) {
      console.warn('[retrieve] ⚠️ Both vector and keyword search failed, returning empty');
      return [];
    }
  } else {
    console.log('[retrieve] ✅ Keyword search results:', {
      count: Array.isArray(kData) ? kData.length : 0,
      topRank: Array.isArray(kData) && kData.length > 0 ? (kData[0] as any).rank : null
    });
  }

  const v = Array.isArray(vData) ? vData : [];
  const k = Array.isArray(kData) ? kData : [];

  // Last-resort fallback: direct text search if both RPCs yield nothing
  let direct: unknown[] = [];
  if (v.length === 0 && k.length === 0) {
    console.log('[retrieve] 🔄 Both searches empty, trying direct text search fallback...');
    try {
      const { data: d } = await sb
        .from('kb_chunks')
        .select('id, source_id, agent_id, content')
        .eq('agent_id', agentId)
        .textSearch('content', rewritten, { type: 'websearch', config: 'english' })
        .limit(topK);
      if (Array.isArray(d)) {
        direct = d.map((row: any) => ({
          chunk_id: row.id,
          source_id: row.source_id,
          agent_id: row.agent_id,
          content: row.content,
          rank: 0.5,
        }));
        console.log('[retrieve] ✅ Direct search found:', direct.length, 'chunks');
      } else {
        console.log('[retrieve] ⚠️ Direct search returned no results');
      }
    } catch (e: unknown) {
      console.error('[retrieve] ❌ Direct search failed:', e instanceof Error ? e.message : String(e));
    }
  }

  // Prepare normalization
  const maxKw = k.reduce((m: number, r: any) => Math.max(m, Number(r.rank || 0)), 0) || 1;

  const merged = new Map<string, RetrievedChunk>();

  for (const row of v) {
    const chunkId = String((row as any).chunk_id);
    const distance = Number((row as any).distance || 0);
    const sim = 1 / (1 + Math.max(0, distance)); // 0..1 monotonic
    const entry: RetrievedChunk = {
      chunkId,
      sourceId: String((row as any).source_id),
      agentId: (row as any).agent_id ? String((row as any).agent_id) : null,
      content: String((row as any).content || ''),
      score: 0.7 * sim,
      details: { embedDistance: distance, embedSim: sim }
    };
    merged.set(chunkId, entry);
  }

  for (const row of k) {
    const chunkId = String((row as any).chunk_id);
    const kwRank = Number((row as any).rank || 0);
    const kwNorm = Math.max(0, kwRank) / (maxKw || 1);
    const existing = merged.get(chunkId);
    if (existing) {
      existing.score = Math.min(1, existing.score + 0.3 * kwNorm);
      existing.details.kwRank = kwRank;
    } else {
      merged.set(chunkId, {
        chunkId,
        sourceId: String((row as any).source_id),
        agentId: (row as any).agent_id ? String((row as any).agent_id) : null,
        content: String((row as any).content || ''),
        score: 0.3 * kwNorm,
        details: { kwRank }
      });
    }
  }

  // Include direct matches if still empty
  if (merged.size === 0 && direct.length > 0) {
    console.log('[retrieve] Using direct fallback results');
    for (const row of direct) {
      merged.set(String((row as any).chunk_id), {
        chunkId: String((row as any).chunk_id),
        sourceId: String((row as any).source_id),
        agentId: (row as any).agent_id ? String((row as any).agent_id) : null,
        content: String((row as any).content || ''),
        score: 0.4,
        details: { kwRank: Number((row as any).rank || 0) }
      });
    }
  }

  const finalResults = Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const elapsedMs = Date.now() - startTime;

  console.log('[retrieve] 🎯 Final results:', {
    totalChunks: finalResults.length,
    topScores: finalResults.slice(0, 3).map(r => ({
      chunkId: r.chunkId.substring(0, 8) + '...',
      sourceId: r.sourceId.substring(0, 8) + '...',
      score: r.score.toFixed(3),
      preview: r.content.substring(0, 80).replace(/\n/g, ' ') + '...',
      vectorSim: r.details.embedSim?.toFixed(3),
      kwRank: r.details.kwRank?.toFixed(3)
    })),
    elapsedMs
  });

  if (finalResults.length === 0) {
    console.warn('[retrieve] ⚠️ NO RESULTS FOUND - Possible issues:', {
      agentId,
      query,
      checklist: [
        '1. Is agentId correct and matching DB?',
        '2. Are there chunks in kb_chunks for this agent?',
        '3. Do chunks have embeddings?',
        '4. Is the query too specific or using different terminology?'
      ]
    });
  }

  return finalResults;
}
