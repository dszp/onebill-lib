import { describe, expect, it } from 'vitest';
import {
  hasTaxExemptionCode,
  subscriberDocumentBytes,
  taxExemptionCodesOf,
  taxJurisdictionsOf,
  type Subscriber,
  type SubscriberDocument,
} from './model.js';
import { FAKE_PDF_BASE64, fakeDocument, fakeExemptSubscriber } from './testkit.js';

const sub = (o: Parameters<typeof fakeExemptSubscriber>[0] = {}) =>
  fakeExemptSubscriber(o) as unknown as Subscriber;

describe('taxExemptionCodesOf', () => {
  it('reads through the singular container key to the codes inside', () => {
    // The trap: `taxExemptionCode.code` is the ARRAY, and each element has its own `code` string.
    const codes = taxExemptionCodesOf(sub());
    expect(codes).toHaveLength(1);
    expect(codes[0]!.code).toBe('32');
    expect(codes[0]!.description).toBe('State and Local Sales Tax Exempt');
    // Guard against the one-level-short read, which yields an array where a string is expected.
    expect(typeof codes[0]!.code).toBe('string');
  });

  it('returns every code when an account holds several', () => {
    const codes = taxExemptionCodesOf(
      sub({
        codes: [
          { code: '08', description: 'State Administered State and Local Sales and Use Tax' },
          { code: '32', description: 'State and Local Sales Tax Exempt' },
          { code: '34', description: 'State Use Tax' },
        ],
      }),
    );
    expect(codes.map((c) => c.code)).toEqual(['08', '32', '34']);
  });

  it('accepts a non-numeric code', () => {
    // Codes are vendor vocabulary and are extended per tenant; `TF` has been observed live, so
    // anything that parses or unions these values is wrong.
    expect(taxExemptionCodesOf(sub({ codes: [{ code: 'TF' }] }))[0]!.code).toBe('TF');
  });

  it('tolerates a single code sent unwrapped instead of in an array', () => {
    expect(taxExemptionCodesOf(sub({ unwrapped: true })).map((c) => c.code)).toEqual(['32']);
  });

  it('returns an empty list when the account carries no exemption, which is the common case', () => {
    // The field is ABSENT, not null and not an empty container.
    const plain = sub({ codes: [] });
    expect('taxExemptionCode' in (plain as object)).toBe(false);
    expect(taxExemptionCodesOf(plain)).toEqual([]);
  });

  it('does not throw on a malformed or partial record', () => {
    expect(taxExemptionCodesOf({ accountNumber: 'CLI00000' })).toEqual([]);
    expect(taxExemptionCodesOf({ accountNumber: 'CLI00000', taxExemptionCode: {} })).toEqual([]);
    expect(
      taxExemptionCodesOf({
        accountNumber: 'CLI00000',
        taxExemptionCode: { code: [{ description: 'no code key' }] },
      } as unknown as Subscriber),
    ).toEqual([]);
  });
});

describe('taxJurisdictionsOf', () => {
  it('returns the states the account has addresses in', () => {
    expect(taxJurisdictionsOf(sub({ states: ['IN'] }))).toEqual(['IN']);
  });

  it('returns every state for an account spanning more than one', () => {
    // Which exemption codes an account needs depends on the state, so one state is an assumption
    // rather than a fact.
    expect(taxJurisdictionsOf(sub({ states: ['MI', 'NY'] })).sort()).toEqual(['MI', 'NY']);
  });

  it('de-duplicates repeated states and upper-cases them', () => {
    expect(taxJurisdictionsOf(sub({ states: ['in', 'IN', 'fl'] })).sort()).toEqual(['FL', 'IN']);
  });

  it('returns an empty list rather than throwing when there is no address', () => {
    expect(taxJurisdictionsOf({ accountNumber: 'CLI00000' })).toEqual([]);
  });
});

describe('subscriberDocumentBytes', () => {
  it('decodes a PDF attachment', () => {
    const bytes = subscriberDocumentBytes(fakeDocument() as SubscriberDocument);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
  });

  it('refuses a payload that claims to be a PDF and is not', () => {
    const doc = fakeDocument({ content: btoa('<html>error</html>') }) as SubscriberDocument;
    expect(() => subscriberDocumentBytes(doc)).toThrow(/not a PDF/);
  });

  it('decodes a non-PDF without asserting a format', () => {
    // The upload form accepts more than PDFs; rejecting them here would be wrong.
    const doc = fakeDocument({ contentType: 'PNG', content: btoa('not-a-pdf') }) as SubscriberDocument;
    expect(new TextDecoder().decode(subscriberDocumentBytes(doc))).toBe('not-a-pdf');
  });

  it('throws rather than returning empty bytes when there is no content', () => {
    const doc = { name: 'StateUseTaxExemption', contentType: 'PDF' } as SubscriberDocument;
    expect(() => subscriberDocumentBytes(doc)).toThrow(/has no content/);
  });

  it('names the document in the error, so a sweep says which one failed', () => {
    const doc = { name: 'StateUseTaxExemption' } as SubscriberDocument;
    expect(() => subscriberDocumentBytes(doc)).toThrow(/StateUseTaxExemption/);
  });

  it('round-trips the fixture base64 exactly', () => {
    const doc = fakeDocument() as SubscriberDocument;
    expect(doc.content).toBe(FAKE_PDF_BASE64);
  });
});

describe('the document `type` field is not dependable', () => {
  it('is absent by default in the fixture, matching the current wire shape', () => {
    // Every document uploaded to the live tenant since 2025-05-12 has come back with no `type`,
    // regardless of the type chosen at upload and regardless of visibility. The fixture defaults to
    // that shape so tests are written against what the API actually sends.
    expect('type' in fakeDocument()).toBe(false);
  });

  it('shows why filtering on type loses documents', () => {
    const docs = [
      fakeDocument({ name: 'StateUseTaxExemption' }),                          // recent: no type
      fakeDocument({ name: 'OldContract', type: 'Contract', internal: false }), // older: typed
    ] as SubscriberDocument[];

    expect(docs.filter((d) => d.type === 'Supporting Document')).toHaveLength(0);
    // The exemption certificate is findable by name, and only by name.
    expect(docs.filter((d) => d.name?.includes('TaxExemption'))).toHaveLength(1);
  });
});

describe('hasTaxExemptionCode', () => {
  const three = sub({
    codes: [{ code: '08' }, { code: '32' }, { code: '34', description: 'State Use Tax' }],
  });

  it('finds a code the account carries', () => {
    expect(hasTaxExemptionCode(three, '34')).toBe(true);
    expect(hasTaxExemptionCode(three, '08')).toBe(true);
  });

  it('is false for a code the account does not carry', () => {
    expect(hasTaxExemptionCode(three, '99')).toBe(false);
  });

  it('is false, not throwing, for an account with no exemption at all', () => {
    expect(hasTaxExemptionCode(sub({ codes: [] }), '34')).toBe(false);
  });

  it('rejects an empty code rather than matching everything', () => {
    expect(hasTaxExemptionCode(three, '')).toBe(false);
    expect(hasTaxExemptionCode(three, '   ')).toBe(false);
  });

  it('exists because the list accessor returns objects, not strings', () => {
    // Both of these are the quiet wrong answer this function prevents: neither errors.
    const codes = taxExemptionCodesOf(three);
    expect((codes as unknown as string[]).includes('34')).toBe(false);
    expect(codes.join(',')).toBe('[object Object],[object Object],[object Object]');
    expect(hasTaxExemptionCode(three, '34')).toBe(true);
    expect(codes.map((c) => c.code)).toEqual(['08', '32', '34']);
  });
});
