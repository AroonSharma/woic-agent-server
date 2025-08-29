// Simple event bus for TTS streaming inside the web app
// Avoids use of global window hooks

export type Unsubscribe = () => void;

type TtsChunkHandler = (chunk: ArrayBuffer) => void;
type TtsCompleteHandler = () => void;

const chunkSubscribers = new Set<TtsChunkHandler>();
const completeSubscribers = new Set<TtsCompleteHandler>();

export function onTtsChunk(handler: TtsChunkHandler): Unsubscribe {
  chunkSubscribers.add(handler);
  return () => { try { chunkSubscribers.delete(handler); } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      } };
}

export function onTtsComplete(handler: TtsCompleteHandler): Unsubscribe {
  completeSubscribers.add(handler);
  return () => { try { completeSubscribers.delete(handler); } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      } };
}

export function emitTtsChunk(chunk: ArrayBuffer): void {
  for (const handler of Array.from(chunkSubscribers)) {
    try { handler(chunk); } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }
  }
}

export function emitTtsComplete(): void {
  for (const handler of Array.from(completeSubscribers)) {
    try { handler(); } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }
  }
}
