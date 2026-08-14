/**
 * The aurora palette is chosen by this function, and the thing that makes it
 * feel broken is not a wrong match — it is priority. `technical` is tested
 * first, and its pattern is wide (backticks, "code", "api", "deploy", "error"),
 * so in a software project it swallows almost everything unless the order is
 * deliberate. These tests pin the order down so a later edit to the regexes
 * cannot quietly change which palette wins.
 */
import { describe, it, expect } from 'vitest';
import { detectEmotion } from '../detectEmotion';

describe('detectEmotion', () => {
  it('falls back to neutral for text that matches nothing', () => {
    expect(detectEmotion('hôm nay trời đẹp')).toBe('neutral');
    expect(detectEmotion('')).toBe('neutral');
  });

  it('reads a fenced or inline code block as technical', () => {
    expect(detectEmotion('```ts\nconst a = 1\n```')).toBe('technical');
    expect(detectEmotion('cái `useMoneySync` này chạy sao')).toBe('technical');
  });

  it('matches the technical vocabulary', () => {
    for (const word of ['code', 'function', 'algorithm', 'debug', 'api', 'deploy', 'build']) {
      expect(detectEmotion(`giúp tôi ${word} với`)).toBe('technical');
    }
  });

  it('matches feelings in both languages', () => {
    expect(detectEmotion('tôi thấy hơi lo lắng')).toBe('personal');
    expect(detectEmotion('I feel worried about this')).toBe('personal');
  });

  it('covers the Vietnamese feelings vocabulary, not just the English one', () => {
    // The original list had six Vietnamese words against fifteen English ones,
    // so writing about a feeling in Vietnamese usually fell through to neutral.
    for (const phrase of [
      'viết về một cơn phẫn nộ trong cuộc sống',
      'dạo này tôi mệt mỏi quá',
      'áp lực công việc nhiều',
      'thấy cô đơn',
      'hơi thất vọng',
    ]) {
      expect(detectEmotion(phrase)).toBe('personal');
    }
  });

  it('covers Vietnamese deliberation and enthusiasm too', () => {
    expect(detectEmotion('có lẽ nên nghĩ lại')).toBe('reflective');
    expect(detectEmotion('tôi tự hỏi liệu có nên không')).toBe('reflective');
    expect(detectEmotion('đỉnh thật')).toBe('excited');
  });

  it('matches enthusiasm, including bare exclamation', () => {
    expect(detectEmotion('hay quá')).toBe('excited');
    expect(detectEmotion('that is awesome')).toBe('excited');
    expect(detectEmotion('xong rồi!!')).toBe('excited');
  });

  it('matches deliberation', () => {
    expect(detectEmotion('tuy nhiên tôi vẫn băn khoăn')).toBe('reflective');
    expect(detectEmotion('hmm, perhaps we should consider it')).toBe('reflective');
  });

  it('is case-insensitive', () => {
    expect(detectEmotion('DEBUG this')).toBe('technical');
    expect(detectEmotion('I FEEL fine')).toBe('personal');
  });

  describe('priority — first match wins, personal ahead of technical', () => {
    it('a feelings message that also mentions code reads as personal', () => {
      // The whole reason for the ordering. Technical is wide enough that in a
      // software project it would otherwise swallow every message, including
      // the ones that are about the person rather than the code.
      expect(detectEmotion('tôi buồn vì cái function này mãi không chạy')).toBe('personal');
      expect(detectEmotion('mệt mỏi quá, deploy mãi không xong')).toBe('personal');
    });

    it('still reads a message with no feeling in it as technical', () => {
      expect(detectEmotion('sửa cái function này giúp tôi')).toBe('technical');
    });

    it('personal beats excited and reflective', () => {
      expect(detectEmotion('tôi vui quá, tuyệt vời')).toBe('personal');
    });

    it('technical beats excited and reflective', () => {
      expect(detectEmotion('cái api này hay quá, tuy nhiên phải cân nhắc')).toBe('technical');
    });

    it('excited beats reflective', () => {
      expect(detectEmotion('tuyệt, tuy nhiên vẫn phải cân nhắc')).toBe('excited');
    });
  });
});
