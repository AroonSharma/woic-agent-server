import { supabaseService } from './supabaseServer';
import { extractReadable, chunk, openAIEmbed } from './kb';

export interface UpsertURLResult {
  sourceId: string;
  chunkCount: number;
  title: string;
  url: string;
}

export async function upsertURL(url: string, agentId: string): Promise<UpsertURLResult> {
  if (!agentId || typeof agentId !== 'string') {
    throw new Error('agent_id_required');
  }
  const sb = supabaseService();

  // Resolve agent → project
  const { data: agent, error: agentErr } = await sb
    .from('agents')
    .select('id, project_id')
    .eq('id', agentId)
    .single();
  if (agentErr || !agent) {
    throw new Error('agent_not_found');
  }
  const projectId = (agent as any).project_id as string;

  // Find or create source row (status pending)
  const { data: existing } = await sb
    .from('kb_sources')
    .select('id, status, meta')
    .eq('project_id', projectId)
    .eq('agent_id', agentId)
    .eq('url', url)
    .limit(1);

  let sourceId: string | null = null;

  if (existing && existing.length > 0) {
    sourceId = (existing[0] as any).id as string;
    // Mark reindexing
    await sb.from('kb_sources').update({ status: 'pending', updated_at: new Date().toISOString() }).eq('id', sourceId);
    // Clear old chunks to avoid duplicates
    await sb.from('kb_chunks').delete().eq('source_id', sourceId);
  } else {
    const { data: created, error: createErr } = await sb
      .from('kb_sources')
      .insert({ project_id: projectId, agent_id: agentId, type: 'url', url, status: 'pending', meta: {} })
      .select('id')
      .single();
    if (createErr || !created) {
      throw new Error('source_create_failed');
    }
    sourceId = (created as any).id as string;
  }

  // Fetch + extract + chunk
  const extracted = await extractReadable(url);
  if (!extracted.text || extracted.text.length < 50) {
    await sb.from('kb_sources').update({ status: 'failed', updated_at: new Date().toISOString(), meta: { reason: 'empty_or_too_short' } }).eq('id', sourceId);
    throw new Error('content_empty');
  }
  const chunks = chunk(extracted.text);
  if (chunks.length === 0) {
    await sb.from('kb_sources').update({ status: 'failed', updated_at: new Date().toISOString(), meta: { reason: 'no_chunks' } }).eq('id', sourceId);
    throw new Error('chunking_failed');
  }

  // Embed in one batch
  const embeddings = (await openAIEmbed(chunks)) as number[][];

  // Insert chunks directly (batch insert). PostgREST can cast float array to vector.
  const rows = chunks.map((content, i) => ({
    source_id: sourceId,
    agent_id: agentId,
    content,
    embedding: (embeddings[i] as unknown),
    token_count: null as number | null,
  }));
  const { error: insErr } = await sb.from('kb_chunks').insert(rows);
  if (insErr) {
    await sb.from('kb_sources').update({ status: 'failed', updated_at: new Date().toISOString(), meta: { reason: 'bulk_insert_failed', message: insErr.message } }).eq('id', sourceId);
    throw new Error('bulk_insert_failed');
  }

  // Finalize
  const meta = { title: extracted.title || '', char_count: extracted.text.length, chunk_count: chunks.length };
  await sb
    .from('kb_sources')
    .update({ status: 'indexed', last_indexed_at: new Date().toISOString(), updated_at: new Date().toISOString(), meta })
    .eq('id', sourceId);

  return { sourceId, chunkCount: chunks.length, title: extracted.title, url };
}

export interface UpsertTextResult {
  sourceId: string;
  chunkCount: number;
  title: string;
}

export async function upsertText(
  title: string,
  text: string,
  agentId: string,
  meta: Record<string, any> = {}
): Promise<UpsertTextResult> {
  if (!agentId || typeof agentId !== 'string') {
    throw new Error('agent_id_required');
  }
  const sb = supabaseService();
  const { data: agent, error: agentErr } = await sb
    .from('agents')
    .select('id, project_id')
    .eq('id', agentId)
    .single();
  if (agentErr || !agent) {
    throw new Error('agent_not_found');
  }
  const projectId = (agent as any).project_id as string;

  const { data: created, error: createErr } = await sb
    .from('kb_sources')
    .insert({ project_id: projectId, agent_id: agentId, type: 'text', url: null, status: 'pending', meta: { title, ...meta } })
    .select('id')
    .single();
  if (createErr || !created) {
    throw new Error('source_create_failed');
  }
  const sourceId = (created as any).id as string;

  const chunks = chunk(text);
  if (chunks.length === 0) {
    await sb.from('kb_sources').update({ status: 'failed', updated_at: new Date().toISOString(), meta: { ...meta, reason: 'no_chunks' } }).eq('id', sourceId);
    throw new Error('chunking_failed');
  }
  const embeddings = (await openAIEmbed(chunks)) as number[][];
  const rows = chunks.map((content, i) => ({
    source_id: sourceId,
    agent_id: agentId,
    content,
    embedding: embeddings[i] as unknown,
    token_count: null as number | null,
  }));
  const { error: insErr } = await sb.from('kb_chunks').insert(rows);
  if (insErr) {
    await sb.from('kb_sources').update({ status: 'failed', updated_at: new Date().toISOString(), meta: { ...meta, reason: 'bulk_insert_failed', message: insErr.message } }).eq('id', sourceId);
    throw new Error('bulk_insert_failed');
  }

  await sb
    .from('kb_sources')
    .update({ status: 'indexed', last_indexed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', sourceId);

  return { sourceId, chunkCount: chunks.length, title };
}

export interface UpsertDocumentResult extends UpsertTextResult {
  processingTimeMs?: number;
  sourceType?: string;
}

export async function upsertDocument(
  title: string,
  text: string,
  agentId: string,
  documentMeta: {
    sourceType: string;
    originalFileName: string;
    fileSize: number;
    mimeType: string;
    author?: string;
    pageCount?: number;
    wordCount?: number;
    createdAt?: Date;
    modifiedAt?: Date;
  }
): Promise<UpsertDocumentResult> {
  if (!agentId || typeof agentId !== 'string') {
    throw new Error('agent_id_required');
  }
  const sb = supabaseService();

  // Resolve agent → project
  const { data: agent, error: agentErr } = await sb
    .from('agents')
    .select('id, project_id')
    .eq('id', agentId)
    .single();
  if (agentErr || !agent) {
    throw new Error('agent_not_found');
  }
  const projectId = (agent as any).project_id as string;

  // Enhanced metadata for documents
  const enhancedMeta = {
    title,
    kind: 'document',
    sourceType: documentMeta.sourceType,
    originalFileName: documentMeta.originalFileName,
    fileSize: documentMeta.fileSize,
    mimeType: documentMeta.mimeType,
    author: documentMeta.author,
    pageCount: documentMeta.pageCount,
    wordCount: documentMeta.wordCount,
    uploadedAt: new Date().toISOString(),
    createdAt: documentMeta.createdAt?.toISOString(),
    modifiedAt: documentMeta.modifiedAt?.toISOString()
  };

  // Create source record with document type
  const { data: created, error: createErr } = await sb
    .from('kb_sources')
    .insert({ 
      project_id: projectId, 
      agent_id: agentId, 
      type: 'document', 
      url: null, 
      status: 'pending', 
      meta: enhancedMeta 
    })
    .select('id')
    .single();
  if (createErr || !created) {
    throw new Error('source_create_failed');
  }
  const sourceId = (created as any).id as string;

  // Chunk and embed the document text
  const chunks = chunk(text);
  if (chunks.length === 0) {
    await sb.from('kb_sources').update({ 
      status: 'failed', 
      updated_at: new Date().toISOString(), 
      meta: { ...enhancedMeta, reason: 'no_chunks' } 
    }).eq('id', sourceId);
    throw new Error('chunking_failed');
  }

  const embeddings = (await openAIEmbed(chunks)) as number[][];
  const rows = chunks.map((content, i) => ({
    source_id: sourceId,
    agent_id: agentId,
    content,
    embedding: embeddings[i] as unknown,
    token_count: null as number | null,
  }));

  const { error: insErr } = await sb.from('kb_chunks').insert(rows);
  if (insErr) {
    await sb.from('kb_sources').update({ 
      status: 'failed', 
      updated_at: new Date().toISOString(), 
      meta: { ...enhancedMeta, reason: 'bulk_insert_failed', message: insErr.message } 
    }).eq('id', sourceId);
    throw new Error('bulk_insert_failed');
  }

  // Finalize with enhanced metadata
  const finalMeta = { 
    ...enhancedMeta, 
    char_count: text.length, 
    chunk_count: chunks.length 
  };
  await sb
    .from('kb_sources')
    .update({ 
      status: 'indexed', 
      last_indexed_at: new Date().toISOString(), 
      updated_at: new Date().toISOString(),
      meta: finalMeta
    })
    .eq('id', sourceId);

  return { 
    sourceId, 
    chunkCount: chunks.length, 
    title,
    sourceType: documentMeta.sourceType
  };
}

export async function upsertFAQ(question: string, answer: string, agentId: string): Promise<UpsertTextResult> {
  const qa = `Q: ${question}\n\nA: ${answer}`;
  return upsertText(question, qa, agentId, { kind: 'faq' });
}
