import { describe, expect, it } from 'vitest';
import { isPlainEnter } from './password-input';

function key(key: string, isComposing = false, keyCode = key === 'Enter' ? 13 : 65) {
  return { key, isComposing, keyCode };
}

describe('isPlainEnter', () => {
  it('is Enter outside of a composition', () => {
    expect(isPlainEnter(key('Enter'))).toBe(true);
  });

  it('is no other key', () => {
    expect(isPlainEnter(key('a'))).toBe(false);
    expect(isPlainEnter(key('Tab', false, 9))).toBe(false);
  });

  it('is not the Enter that confirms what an input method is composing', () => {
    // Chrome and Firefox: the composition is still open.
    expect(isPlainEnter(key('Enter', true, 229))).toBe(false);
    expect(isPlainEnter(key('Enter', true, 13))).toBe(false);
    // WebKit: the composition has ended already, only the key code says what the key was for.
    expect(isPlainEnter(key('Enter', false, 229))).toBe(false);
  });
});
