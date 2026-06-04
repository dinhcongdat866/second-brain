export type Emotion = 'neutral' | 'excited' | 'reflective' | 'personal' | 'technical';

/** Ordered by priority — first match wins. */
const PATTERNS: [Emotion, RegExp][] = [
  ['technical',  /```|`[^`]+`|\b(code|function|algorithm|implement|debug|error|api|type|interface|class|module|deploy|build)\b/i],
  ['personal',   /\b(cảm xúc|buồn|vui|lo lắng|hạnh phúc|nhớ|sad|happy|worried|anxious|feel|emotion|personal|lonely|grateful|miss)\b/i],
  ['excited',    /tuyệt|thú vị|hay quá|tốt quá|\b(great|awesome|excellent|amazing|fantastic|brilliant|perfect)\b|!!+/],
  ['reflective', /\b(suy nghĩ|cân nhắc|băn khoăn|however|tuy nhiên|mặt khác|on the other hand|hmm|perhaps|maybe|consider|reflect)\b/i],
];

/** Keyword-heuristic emotion from the last completed assistant response. */
export function detectEmotion(text: string): Emotion {
  for (const [emotion, pattern] of PATTERNS) {
    if (pattern.test(text)) return emotion;
  }
  return 'neutral';
}
