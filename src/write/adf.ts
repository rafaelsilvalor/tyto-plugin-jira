/**
 * Plain text as Atlassian Document Format, the shape Jira Cloud's REST API v3 takes for a
 * comment and a rich-text field: a blank line starts a paragraph, a single line break stays one,
 * and every `http(s)://` address becomes a link to itself. Nothing else is read as markup, so
 * what a cell holds is what the issue shows.
 */
export interface AdfDocument {
  readonly type: 'doc';
  readonly version: 1;
  readonly content: readonly AdfBlock[];
}

interface AdfBlock {
  readonly type: 'paragraph';
  readonly content: readonly AdfInline[];
}

type AdfInline =
  | {
      readonly type: 'text';
      readonly text: string;
      readonly marks?: readonly [{ readonly type: 'link'; readonly attrs: { href: string } }];
    }
  | { readonly type: 'hardBreak' };

const PARAGRAPH_BREAK = /\n[ \t]*\n+/;
const ADDRESS = /https?:\/\/[^\s<>"]+/g;
/** Punctuation that ends a sentence rather than an address: `see https://x.example/a.` */
const TRAILING = /[.,;:!?)\]'"]+$/;

export function textToAdf(text: string): AdfDocument {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(PARAGRAPH_BREAK)
    .map((paragraph) => paragraph.replace(/^\n+|\n+$/g, ''))
    .filter((paragraph) => paragraph.trim() !== '');
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.map((paragraph) => ({
      type: 'paragraph',
      content: paragraph
        .split('\n')
        .flatMap((line, index): AdfInline[] =>
          index === 0 ? linked(line) : [{ type: 'hardBreak' }, ...linked(line)],
        ),
    })),
  };
}

/** One line's text nodes, each address its own node marked as a link. */
function linked(line: string): AdfInline[] {
  const nodes: AdfInline[] = [];
  let from = 0;
  for (const match of line.matchAll(ADDRESS)) {
    const address = match[0].replace(TRAILING, '');
    const start = match.index;
    if (start > from) nodes.push({ type: 'text', text: line.slice(from, start) });
    nodes.push({
      type: 'text',
      text: address,
      marks: [{ type: 'link', attrs: { href: address } }],
    });
    from = start + address.length;
  }
  if (from < line.length) nodes.push({ type: 'text', text: line.slice(from) });
  return nodes;
}
