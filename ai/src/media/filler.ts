/**
 * What whisper writes when it hears nothing.
 *
 * Given silence or half a second of room noise it produces one of a
 * small set of stock phrases — "you", "Thank you.", "[BLANK_AUDIO]" —
 * learnt from the end of its training clips. In a dictated message that
 * would be worse than inserting nothing; in a video transcript it turns
 * the pause between two slides into a sentence nobody said.
 *
 * Shared by the dictation route and the video indexer, which read the
 * same whisper output.
 */
const FILLER = new Set([
  'you', 'thank you', 'thanks for watching', 'thank you for watching',
  'bye', 'okay', 'ok', 'so', 'yeah', 'uh', 'um', '[blank_audio]', '(silence)'
])

/** The text, or '' when it is nothing but filler. */
export function withoutFiller (text: string): string {
  const stripped = text.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
  const words = stripped
    .split(/[.!?\n]+/)
    .map(part => part.trim().toLowerCase().replace(/[.,!?]+$/, ''))
    .filter(part => part.length > 0)

  if (words.length === 0) { return '' }
  // Repetition of one stock phrase is the signature of silence.
  return words.every(part => FILLER.has(part)) ? '' : text
}
