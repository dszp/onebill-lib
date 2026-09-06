/**
 * Normalises a name for COMPARISON only — never for display. Offer, plan and product names typed
 * into OneBill's UI carry inconsistent Unicode for what a person reads as the same words: an en
 * dash or em dash where a hyphen was meant, a non-breaking hyphen, a non-breaking space, doubled
 * spaces, or an invisible character (a zero-width space pasted in from somewhere else) that a naive
 * `.trim().toLowerCase()` treats as a different name entirely.
 *
 * Order matters: strip invisible format characters first (`\p{Cf}` — zero-width space/joiners,
 * word joiner, the BOM used as a zero-width no-break space; none of these carry meaning), then NFKC
 * to fold compatibility variants, then collapse dash variants — hyphen (U+2010) through horizontal
 * bar (U+2015), and the minus sign (U+2212) — to a plain hyphen, then collapse any run of
 * whitespace (JS `\s` already includes the non-breaking space, U+00A0) to one space, then trim and
 * lower-case.
 */
export function normalizeName(s: string): string {
  return String(s ?? '')
    .replace(/\p{Cf}/gu, '')
    .normalize('NFKC')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
