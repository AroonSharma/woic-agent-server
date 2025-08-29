import { supabaseService } from './supabaseServer';
import { openAIEmbed } from './kb';

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
  };
}

export async function embedQuery(query: string): Promise<number[]> {
  if (!query || !query.trim()) throw new Error('query_required');
  const vec = (await openAIEmbed(query)) as number[];
  return vec;
}

function rewriteQuery(query: string): string {
  const q = String(query || '').trim().toLowerCase();
  // Normalize common ASR artifacts and branding
  const map: Array<[RegExp, string]> = [
    [/webdesign/g, 'web design'],
    [/real ?monkey/g, 'realmonkey'],
    [/a[\. ]?i[\. ]?/g, 'ai'],
    [/website\s*designing/g, 'website design'],
  ];
  let out = q;
  for (const [re, rep] of map) out = out.replace(re, rep);
  // Expand to include service terms (generic, no brand hard-coding)
  const expansions: string[] = [];
  if (/ai/.test(out)) expansions.push('artificial intelligence');
  if (/web design/.test(out)) expansions.push('website design');
  // Avoid brand/tenant-specific hardcoding for enterprise readiness
  const uniq = Array.from(new Set([out, ...expansions].filter(Boolean)));
  return uniq.join(' | ');
}

export async function retrieve(query: string, agentId: string | null, topK = 6): Promise<RetrievedChunk[]> {
  const sb = supabaseService();
  const rewritten = rewriteQuery(query);
  const embedding = await embedQuery(query);

  // Vector search
  let vData: unknown[] | null = null;
  const { data: vTry, error: vErr } = await sb.rpc('f_kb_search_by_embedding', {
    p_agent_id: agentId,
    p_embedding: embedding,
    p_top_k: topK
  });
  if (vErr) {
    // Soft-fail vector search; rely on keyword search
    vData = [];
  } else {
    vData = vTry as any[];
  }

  // Keyword search
  const { data: kData, error: kErr } = await sb.rpc('f_kb_search_by_keyword', {
    p_agent_id: agentId,
    p_query: rewritten,
    p_top_k: topK
  });
  if (kErr) {
    // If both fail, return empty
    if (!vData || vData.length === 0) return [];
  }

  const v = Array.isArray(vData) ? vData : [];
  const k = Array.isArray(kData) ? kData : [];

  // Last-resort fallback: direct text search if both RPCs yield nothing
  let direct: unknown[] = [];
  if (v.length === 0 && k.length === 0) {
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
      }
    } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
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

  return Array.from(merged.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
