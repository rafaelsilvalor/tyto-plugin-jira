import { describe, expect, it } from 'vitest';

import { adfUrls, isoUtc } from '../src/columns.js';

const text = (value: string, marks: unknown[] = []) => ({ type: 'text', text: value, marks });
const link = (href: string) => ({ type: 'link', attrs: { href } });

describe('adfUrls', () => {
  it('finds links under nested marks and blocks, and every kind of card, in document order', () => {
    const document = {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    text('bold link', [
                      { type: 'strong' },
                      { type: 'em' },
                      link('https://a.example.com/1'),
                    ]),
                    { type: 'inlineCard', attrs: { url: 'https://b.example.com/2' } },
                  ],
                },
              ],
            },
          ],
        },
        { type: 'blockCard', attrs: { url: 'https://c.example.com/3' } },
        {
          type: 'table',
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  content: [
                    {
                      type: 'embedCard',
                      attrs: { url: 'https://d.example.com/4', layout: 'center' },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(adfUrls(document)).toEqual([
      'https://a.example.com/1',
      'https://b.example.com/2',
      'https://c.example.com/3',
      'https://d.example.com/4',
    ]);
  });

  it('finds URLs written as plain text, without the punctuation after them', () => {
    const document = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            text(
              'Read https://e.example.com/a?b=1, then (http://f.example.com/x). Done: https://e.example.com/a?b=1',
            ),
          ],
        },
      ],
    };
    expect(adfUrls(document)).toEqual(['https://e.example.com/a?b=1', 'http://f.example.com/x']);
  });

  it('keeps the first occurrence only, the mark before the text that spells it', () => {
    const url = 'https://g.example.com/';
    const document = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [text(url, [link(url)]), text('again https://h.example.com/')],
        },
        { type: 'paragraph', content: [text('h', [link('https://h.example.com/')])] },
      ],
    };
    expect(adfUrls(document)).toEqual([url, 'https://h.example.com/']);
  });

  it('answers nothing for no document, and ignores a card or a mark without a URL', () => {
    expect(adfUrls(null)).toEqual([]);
    expect(adfUrls(undefined)).toEqual([]);
    expect(
      adfUrls({
        type: 'doc',
        content: [
          { type: 'blockCard', attrs: { data: {} } },
          text('no url', [{ type: 'link', attrs: {} }]),
        ],
      }),
    ).toEqual([]);
  });
});

describe('isoUtc', () => {
  it.each([
    ['2026-10-01T10:15:30.000-0300', '2026-10-01T13:15:30.000Z'],
    ['2026-10-01T22:00:00.000-03:00', '2026-10-02T01:00:00.000Z'],
    ['2026-10-01T10:15:30.000+0530', '2026-10-01T04:45:30.000Z'],
    ['2026-10-01T10:15:30Z', '2026-10-01T10:15:30.000Z'],
  ])('normalises %s to %s', (written, iso) => {
    expect(isoUtc(written, 'EX-1', 'created')).toEqual({ ok: true, value: iso });
  });

  it('keeps an absent date empty, and refuses one that is not a date', () => {
    expect(isoUtc(null, 'EX-1', 'updated')).toEqual({ ok: true, value: null });
    for (const written of ['2026-10-01', '2026-13-01T10:00:00.000+0000', 42]) {
      const answer = isoUtc(written, 'EX-1', 'updated');
      expect(answer.ok ? undefined : answer.error.code).toBe('E_JIRA_RESPONSE');
    }
  });
});
