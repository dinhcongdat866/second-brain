export type Emotion = 'neutral' | 'excited' | 'reflective' | 'personal' | 'technical';

/**
 * Ordered by priority — first match wins.
 *
 * `personal` goes first, ahead of `technical`. The technical pattern is wide by
 * necessity (backticks, "function", "deploy", "error"), and in a software
 * project it appears in almost everything — including the messages that are
 * really about how the work is going. "tôi buồn vì cái function này mãi không
 * chạy" is a person having a bad day, not a debugging question, and the palette
 * should follow the person. Technical is the fallback for the rest.
 *
 * The Vietnamese side used to be much thinner than the English side, so a
 * message like "viết về một cơn phẫn nộ" fell through to neutral while its
 * English equivalent matched. Since the source is now the user's own prompt
 * (see AiCell), the gap showed up as "the colour never changes".
 *
 * \b does not work against Vietnamese diacritics the way it does for ASCII, so
 * the Vietnamese alternatives are matched bare and the word-boundary group is
 * kept for the English ones.
 */
const PATTERNS: [Emotion, RegExp][] = [
  ['personal',   /cảm xúc|buồn|vui|lo lắng|hạnh phúc|nhớ|phẫn nộ|giận|tức giận|cô đơn|mệt mỏi|áp lực|căng thẳng|thất vọng|tổn thương|biết ơn|sợ hãi|chán nản|\b(sad|happy|worried|anxious|feel|feeling|emotion|personal|lonely|grateful|miss|angry|tired|stress|stressed|afraid|hurt)\b/i],
  ['technical',  /```|`[^`]+`|\b(code|function|algorithm|implement|debug|error|api|type|interface|class|module|deploy|build)\b/i],
  ['excited',    /tuyệt|thú vị|hay quá|tốt quá|đỉnh|xịn|phấn khích|mừng quá|\b(great|awesome|excellent|amazing|fantastic|brilliant|perfect)\b|!!+/i],
  ['reflective', /suy nghĩ|cân nhắc|băn khoăn|tuy nhiên|mặt khác|có lẽ|tự hỏi|nhìn lại|ngẫm|đắn đo|\b(however|on the other hand|hmm|perhaps|maybe|consider|reflect|wonder)\b/i],
];

/** Keyword-heuristic emotion from the last completed assistant response. */
export function detectEmotion(text: string): Emotion {
  for (const [emotion, pattern] of PATTERNS) {
    if (pattern.test(text)) return emotion;
  }
  return 'neutral';
}
