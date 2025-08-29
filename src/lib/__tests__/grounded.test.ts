import { describe, it, expect, vi, beforeEach } from 'vitest';
import { groundedAnswer } from '../grounded';
import * as retrieveModule from '../retrieve';

// Mock the retrieve module
vi.mock('../retrieve', () => ({
  retrieve: vi.fn(),
}));

// Mock OpenAI
vi.mock('openai', () => ({
  default: vi.fn(() => ({
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{
            message: {
              content: 'We specialize in AI solutions and web design! What challenge are you facing?'
            }
          }]
        })
      }
    }
  }))
}));

describe('Grounded Answer (Personal RAG)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return personalized response when KB chunks are found', async () => {
    const mockChunks = [
      {
        id: '1',
        content: 'RealMonkey creates AI-powered solutions and brand identities',
        score: 0.9,
        sourceId: 'source-1',
      },
      {
        id: '2',
        content: 'We offer web design and development services',
        score: 0.85,
        sourceId: 'source-1',
      },
    ];

    vi.mocked(retrieveModule.retrieve).mockResolvedValue(mockChunks);

    const result = await groundedAnswer('What services do you offer?', 'agent-123', 10);

    expect(result.text).toBeTruthy();
    expect(result.text.length).toBeLessThanOrEqual(240);
    expect(result.sources).toHaveLength(1);
    expect(retrieveModule.retrieve).toHaveBeenCalledWith('What services do you offer?', 'agent-123', 10);
  });

  it('should return fallback message when no KB chunks found', async () => {
    vi.mocked(retrieveModule.retrieve).mockResolvedValue([]);

    const result = await groundedAnswer('Random question', 'agent-123', 10);

    expect(result.text).toBe("I don't have enough information for that yet.");
    expect(result.sources).toHaveLength(0);
  });

  it('should enforce 240 character limit on responses', async () => {
    const mockChunks = [{
      id: '1',
      content: 'Test content',
      score: 0.9,
      sourceId: 'source-1',
    }];

    vi.mocked(retrieveModule.retrieve).mockResolvedValue(mockChunks);

    const result = await groundedAnswer('Tell me everything', 'agent-123', 10);

    expect(result.text.length).toBeLessThanOrEqual(240);
  });
});