import OpenAI from 'openai';

export interface ExtractResult {
  title: string;
  text: string;
  sourceUrl: string;
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function stripHtml(html: string): { title: string; text: string } {
  try {
    const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? decodeEntities(titleMatch[1].trim()) : '';

    // Remove scripts/styles
    let cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, '');
    cleaned = cleaned.replace(/<style[\s\S]*?<\/style>/gi, '');
    // Drop common boilerplate wrappers (nav, footer, header, aside)
    cleaned = cleaned.replace(/<nav[\s\S]*?<\/nav>/gi, '');
    cleaned = cleaned.replace(/<footer[\s\S]*?<\/footer>/gi, '');
    cleaned = cleaned.replace(/<header[\s\S]*?<\/header>/gi, '');
    cleaned = cleaned.replace(/<aside[\s\S]*?<\/aside>/gi, '');
    // Replace breaks/paras with newlines to keep structure
    cleaned = cleaned.replace(/<\/(p|div|li|h\d)>/gi, '\n$&');
    cleaned = cleaned.replace(/<(br|hr)\s*\/?>(\s*)/gi, '\n');
    // Remove all remaining tags
    cleaned = cleaned.replace(/<[^>]+>/g, '');
    // Decode entities and normalize whitespace
    const text = decodeEntities(cleaned).replace(/\u00A0/g, ' ').replace(/[\t\r ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
    return { title, text };
  } catch {
    return { title: '', text: '' };
  }
}

function decodeEntities(input: string): string {
  // Minimal decode for common entities
  return input
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export async function extractReadable(url: string, timeoutMs = 12000): Promise<ExtractResult> {
  if (!isHttpUrl(url)) {
    throw new Error('invalid_url');
  }
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; VapiKB/1.0)'
      },
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`fetch_failed_${res.status}`);
    }
    const html = await res.text();
    const { title, text } = stripHtml(html);
    return { title: title || new URL(url).hostname, text, sourceUrl: url };
  } finally {
    clearTimeout(t);
  }
}

export function chunk(text: string, maxChars = 1200, overlap = 150): string[] {
  const normalized = (text || '').trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  // Try to split on paragraph boundaries first
  const paras = normalized.split(/\n{2,}/g).map((p) => p.trim()).filter(Boolean);
  if (paras.length > 1) {
    let buf = '';
    for (const para of paras) {
      if ((buf + '\n\n' + para).length <= maxChars) {
        buf = buf ? buf + '\n\n' + para : para;
      } else {
        if (buf) chunks.push(buf);
        if (para.length <= maxChars) {
          buf = para;
        } else {
          // Fallback to hard slicing for very long paragraphs
          for (let j = 0; j < para.length; j += maxChars - overlap) {
            chunks.push(para.slice(j, Math.min(para.length, j + maxChars)));
          }
          buf = '';
        }
      }
    }
    if (buf) chunks.push(buf);
  } else {
    // Hard slice fallback
    let i = 0;
    while (i < normalized.length) {
      const end = Math.min(normalized.length, i + maxChars);
      const slice = normalized.slice(i, end);
      chunks.push(slice);
      if (end >= normalized.length) break;
      i = Math.max(0, end - overlap);
    }
  }
  return chunks;
}

export type EmbeddingInput = string | string[];

export async function openAIEmbed(input: EmbeddingInput, model = 'text-embedding-3-small'): Promise<number[] | number[][]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !apiKey.startsWith('sk-')) {
    throw new Error('openai_key_missing');
  }
  const openai = new OpenAI({ apiKey });
  // Ensure array input for API
  const inputs = Array.isArray(input) ? input : [input];
  const resp = await openai.embeddings.create({ model, input: inputs });
  const vectors = resp.data.map((d) => d.embedding as unknown as number[]);
  return Array.isArray(input) ? vectors : vectors[0];
}
