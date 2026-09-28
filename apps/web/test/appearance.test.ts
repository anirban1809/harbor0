import { describe, expect, it } from 'vitest';
import {
  contrastingText,
  normalizeHex,
  paletteTokens,
  parsePalettes,
} from '../lib/appearance-colors';

describe('appearance colors', () => {
  it('accepts short and full hex codes without allowing arbitrary CSS', () => {
    expect(normalizeHex(' #AbC ')).toBe('#aabbcc');
    expect(normalizeHex('#2563EB')).toBe('#2563eb');
    for (const value of [
      '',
      'red',
      '#1234',
      '#abcdef00',
      'url(https://example.test)',
      '#abc; color:red',
    ]) {
      expect(normalizeHex(value)).toBeNull();
    }
  });
  it('recovers valid saved colors and ignores unsupported or corrupt values', () => {
    expect(parsePalettes('{bad json')).toEqual({ light: {}, dark: {} });
    expect(parsePalettes('null')).toEqual({ light: {}, dark: {} });
    expect(
      parsePalettes(
        JSON.stringify({
          light: { primary: '#abc', background: 'red', unknown: '#123456' },
          dark: { primary: '#2563eb', border: 42 },
        }),
      ),
    ).toEqual({ light: { primary: '#aabbcc' }, dark: { primary: '#2563eb' } });
  });
  it('chooses the text color with the stronger contrast', () => {
    expect(contrastingText('#ffffff')).toBe('#000000');
    expect(contrastingText('#000000')).toBe('#ffffff');
    expect(contrastingText('#2563eb')).toBe('#ffffff');
    expect(contrastingText('#ffff00')).toBe('#000000');
  });
  it('derives surface text and companion tokens without overriding untouched defaults', () => {
    expect(paletteTokens({})).toEqual({});
    const accent = paletteTokens({ primary: '#2563eb' });
    expect(accent['primary-foreground']).toBe('#ffffff');
    expect(accent.ring).toBe('#2563eb');
    expect(accent.background).toBeUndefined();
    const surfaces = paletteTokens({
      card: '#ffffff',
      sidebar: '#000000',
      background: '#000000',
      border: '#123456',
    });
    expect(surfaces['card-foreground']).toBe('#000000');
    expect(surfaces['sidebar-foreground']).toBe('#ffffff');
    expect(surfaces.foreground).toBe('#ffffff');
    expect(surfaces.input).toBe('#123456');
    expect(surfaces.popover).toBe('#ffffff');
  });
});
