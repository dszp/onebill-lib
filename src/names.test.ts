import { describe, expect, it } from 'vitest';
import { normalizeName } from './names.js';

describe('normalizeName', () => {
  it('trims and lower-cases', () => {
    expect(normalizeName('  Seat TIER One  ')).toBe('seat tier one');
  });

  it('treats hyphen, en dash, em dash, non-breaking hyphen and minus sign as the same character', () => {
    const forms = [
      'Native Fax - Analog',
      'Native Fax ‐ Analog', // U+2010 hyphen
      'Native Fax ‑ Analog', // U+2011 non-breaking hyphen
      'Native Fax ‒ Analog', // U+2012 figure dash
      'Native Fax – Analog', // U+2013 en dash
      'Native Fax — Analog', // U+2014 em dash
      'Native Fax ― Analog', // U+2015 horizontal bar
      'Native Fax − Analog', // U+2212 minus sign
    ];
    const normalized = forms.map(normalizeName);
    for (const n of normalized) expect(n).toBe('native fax - analog');
  });

  it('collapses a non-breaking space and a doubled space to one plain space', () => {
    expect(normalizeName('Native Fax Analog')).toBe('native fax analog');
    expect(normalizeName('Native Fax  Analog')).toBe('native fax analog');
  });

  it('strips zero-width and other invisible format characters', () => {
    expect(normalizeName('Native Fax​Analog')).toBe(normalizeName('Native FaxAnalog')); // zero-width space
    expect(normalizeName('Native Fax‌Analog')).toBe(normalizeName('Native FaxAnalog')); // zero-width non-joiner
    expect(normalizeName('Native Fax‍Analog')).toBe(normalizeName('Native FaxAnalog')); // zero-width joiner
    expect(normalizeName('Native Fax⁠Analog')).toBe(normalizeName('Native FaxAnalog')); // word joiner
    expect(normalizeName('﻿Native Fax Analog')).toBe(normalizeName('Native Fax Analog')); // BOM / zero-width no-break space
  });

  it('matches the reported bug: an en dash and a doubled space against a plain rule spelling', () => {
    expect(normalizeName('Native Fax – Analog  (requires MP202B Fax ATA)'))
      .toBe(normalizeName('Native Fax - Analog (requires MP202B Fax ATA)'));
  });

  it('matches a name with a trailing zero-width space against the same name without it', () => {
    expect(normalizeName('Native Fax - Analog (requires MP202B Fax ATA)​'))
      .toBe(normalizeName('Native Fax - Analog (requires MP202B Fax ATA)'));
  });

  it('folds NFKC compatibility variants', () => {
    // Full-width hyphen-minus (U+FF0D) folds to ASCII hyphen-minus under NFKC.
    expect(normalizeName('Native Fax－Analog')).toBe('native fax-analog');
  });

  it('treats nullish input as an empty string', () => {
    expect(normalizeName(undefined as unknown as string)).toBe('');
    expect(normalizeName(null as unknown as string)).toBe('');
  });
});
