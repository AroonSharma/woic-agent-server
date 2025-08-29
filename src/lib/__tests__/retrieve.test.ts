import { describe, it, expect, vi, beforeEach } from 'vitest';
import { retrieve } from '../retrieve';
import { supabaseService } from '../supabaseServer';

// Mock Supabase
vi.mock('../supabaseServer', () => ({
  supabaseService: vi.fn(() => ({
    rpc: vi.fn(),
  })),
}));

// Mock OpenAI
vi.mock('openai', () => ({
  default: vi.fn(() => ({
    embeddings: {
      create: vi.fn().mockResolvedValue({
        data: [{ embedding: new Array(1536).fill(0.1) }],
      }),
    },
  })),
}));

describe('Knowledge Base Retrieval', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should retrieve chunks for a query', async () => {
    const mockChunks = [
      {
        chunk_id: '1',
        content: 'Test content about AI services',
        similarity: 0.95,
        source_id: 'source-1',
      },
      {
        chunk_id: '2',
        content: 'Web design and development',
        similarity: 0.85,
        source_id: 'source-2',
      },
    ];

    const mockSupabase = supabaseService();
    vi.mocked(mockSupabase.rpc).mockResolvedValue({
      data: mockChunks,
      error: null,
    });

    const results = await retrieve('What services do you offer?', 'agent-123', 5);

    expect(results).toHaveLength(2);
    expect(results[0].content).toBe('Test content about AI services');
    expect(results[0].score).toBeCloseTo(0.95);
    expect(mockSupabase.rpc).toHaveBeenCalledWith('f_kb_search_by_embedding', expect.any(Object));
  });

  it('should handle empty results', async () => {
    const mockSupabase = supabaseService();
    vi.mocked(mockSupabase.rpc).mockResolvedValue({
      data: [],
      error: null,
    });

    const results = await retrieve('Random query', 'agent-123', 5);

    expect(results).toHaveLength(0);
  });

  it('should handle retrieval errors gracefully', async () => {
    const mockSupabase = supabaseService();
    vi.mocked(mockSupabase.rpc).mockResolvedValue({
      data: null,
      error: { message: 'Database error' },
    });

    await expect(retrieve('Query', 'agent-123', 5)).rejects.toThrow('kb_retrieve_failed');
  });

  it('should limit results to topK parameter', async () => {
    const mockChunks = Array.from({ length: 10 }, (_, i) => ({
      chunk_id: `${i}`,
      content: `Content ${i}`,
      similarity: 0.9 - i * 0.05,
      source_id: `source-${i}`,
    }));

    const mockSupabase = supabaseService();
    vi.mocked(mockSupabase.rpc).mockResolvedValue({
      data: mockChunks.slice(0, 3),
      error: null,
    });

    const results = await retrieve('Query', 'agent-123', 3);

    expect(results).toHaveLength(3);
    expect(mockSupabase.rpc).toHaveBeenCalledWith(
      'f_kb_search_by_embedding',
      expect.objectContaining({ p_limit: 3 })
    );
  });
});