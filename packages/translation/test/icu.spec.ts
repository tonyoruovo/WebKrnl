/**
 * The ICU MessageFormat subset and the locale rules (docs/ARCHITECTURE.md §21.2).
 */
import { describe, expect, it } from 'vitest';

import {
  MessageSyntaxError,
  compileCatalog,
  createFormatContext,
  escapeHtml,
  formatMessage,
  parseMessage,
  resolveLocaleChain,
  textDirection,
  canonicalLocale,
} from '../src';

const en = createFormatContext('en');
const format = (source: string, params: Record<string, unknown> = {}, context = en) =>
  formatMessage(parseMessage(source), params, context);

describe('parseMessage', () => {
  it('parses text and arguments into plain data', () => {
    const nodes = parseMessage('Hello, {name}!');
    expect(nodes).toEqual(['Hello, ', { type: 'argument', name: 'name' }, '!']);
    expect(structuredClone(nodes)).toEqual(nodes);
  });

  it('parses number, date and time styles', () => {
    expect(parseMessage('{n, number, percent}')).toEqual([
      { type: 'number', name: 'n', style: 'percent' },
    ]);
    expect(parseMessage('{d, date}')).toEqual([{ type: 'date', name: 'd' }]);
    expect(parseMessage('{d, time, short}')).toEqual([{ type: 'time', name: 'd', style: 'short' }]);
  });

  it('parses plural with offset, exact values and #', () => {
    const [node] = parseMessage(
      '{n, plural, offset:1 =0 {nobody} =1 {you} one {you and # other} other {you and # others}}',
    );
    expect(node).toMatchObject({ type: 'plural', name: 'n', ordinal: false, offset: 1 });
    expect(Object.keys((node as { options: object }).options)).toEqual([
      '=0',
      '=1',
      'one',
      'other',
    ]);
  });

  it('handles apostrophe quoting', () => {
    expect(format("It''s {name}'s turn.", { name: 'Ada' })).toBe("It's Ada's turn.");
    expect(format("Type '{name}' here.")).toBe('Type {name} here.');
    expect(format("{n, plural, other {'#' is # }}", { n: 3 })).toBe('# is 3 ');
  });

  it.each([
    ['Hello, {name', 'Missing "}"'],
    ['Hello }', 'Unmatched "}"'],
    ['{n, plural, one {x}}', 'Missing the "other" option'],
    ['{n, colour}', 'Unknown argument type "colour"'],
    ['{n, select, a {x} a {y} other {z}}', 'Repeated selector "a"'],
    ['{}', 'Expected an argument name'],
  ])('refuses %s', (source, problem) => {
    expect(() => parseMessage(source)).toThrow(MessageSyntaxError);
    expect(() => parseMessage(source)).toThrow(problem);
  });
});

describe('formatMessage', () => {
  it('selects plural categories of the locale, with exact values first', () => {
    const message = '{n, plural, =0 {no messages} one {# message} other {# messages}}';
    expect(format(message, { n: 0 })).toBe('no messages');
    expect(format(message, { n: 1 })).toBe('1 message');
    expect(format(message, { n: 1234 })).toBe('1,234 messages');
    // Polish has 'few' and 'many'; a missing category uses 'other'.
    const pl = createFormatContext('pl');
    const files = '{n, plural, one {# plik} few {# pliki} other {# plików}}';
    expect(format(files, { n: 3 }, pl)).toBe('3 pliki');
    expect(format(files, { n: 5 }, pl)).toBe('5 plików');
  });

  it('uses the offset for categories and #', () => {
    const message =
      '{n, plural, offset:1 =0 {nobody} =1 {only you} one {you and # other} other {you and # others}}';
    expect(format(message, { n: 1 })).toBe('only you');
    expect(format(message, { n: 2 })).toBe('you and 1 other');
    expect(format(message, { n: 4 })).toBe('you and 3 others');
  });

  it('formats ordinals, selects and nested messages', () => {
    const ordinal = '{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}';
    expect([1, 2, 3, 4, 11, 22].map((n) => format(ordinal, { n }))).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '22nd',
    ]);
    const nested =
      '{g, select, female {She has} male {He has} other {They have}} {n, plural, one {# cat} other {# cats}}.';
    expect(format(nested, { g: 'female', n: 1 })).toBe('She has 1 cat.');
    expect(format(nested, { g: 'robot', n: 2 })).toBe('They have 2 cats.');
  });

  it('formats numbers, currencies and dates for the locale', () => {
    const de = createFormatContext('de', { currency: 'EUR' });
    expect(format('{n, number}', { n: 1234.5 }, de)).toBe('1.234,5');
    expect(format('{p, number, currency}', { p: 5 }, de)).toBe('5,00 €');
    expect(format('{p, number, ::currency/JPY}', { p: 500 })).toBe('¥500');
    expect(format('{r, number, percent}', { r: 0.25 })).toBe('25%');
    expect(format('{n, number, integer}', { n: 2.7 })).toBe('3');
    expect(format('{n, number, ::.00}', { n: 2 })).toBe('2.00');
    expect(format('{n, number, ::compact-short}', { n: 12_000 })).toBe('12K');
    const date = new Date(Date.UTC(2026, 9, 5, 12));
    expect(format('{d, date, long}', { d: date }, createFormatContext('en-GB'))).toMatch(
      /5 October 2026/,
    );
  });

  it('escapes parameter values, not the message', () => {
    expect(format('<b>{name}</b>', { name: '<script>' })).toBe('<b>&lt;script&gt;</b>');
    expect(
      formatMessage(
        parseMessage('{name}'),
        { name: '<i>' },
        createFormatContext('en', { escape: false }),
      ),
    ).toBe('<i>');
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('shows a missing parameter as {name}', () => {
    expect(format('Hi, {name}!')).toBe('Hi, {name}!');
  });
});

describe('compileCatalog', () => {
  it('parses each message, and makes a bad one null with its error', () => {
    const result = compileCatalog({ messages: { ok: 'Fine', bad: 'Hi {name', n: 42 as never } });
    expect(result.messages.ok).toEqual(['Fine']);
    expect(result.messages.bad).toBeNull();
    expect(result.errors.map((e) => e.key)).toEqual(['bad', 'n']);
  });
});

describe('the locale rules', () => {
  it('makes the chain from the preferred and supported locales', () => {
    expect(resolveLocaleChain(['fr-CA', 'en'], ['en', 'fr', 'fr-CA'], 'en')).toEqual([
      'fr-CA',
      'fr',
      'en',
    ]);
    expect(resolveLocaleChain(['pt-BR'], ['en', 'pt'], 'en')).toEqual(['pt', 'en']);
    expect(resolveLocaleChain(['de-AT'], ['en', 'de-DE'], 'en')).toEqual(['de-DE', 'en']);
    expect(resolveLocaleChain(['ja', null, 'bad tag'], ['en', 'fr'], 'en')).toEqual(['en']);
    expect(resolveLocaleChain([], ['en-US'], 'en-US')).toEqual(['en-US']);
  });

  it('canonicalizes tags and finds the direction', () => {
    expect(canonicalLocale('EN-us')).toBe('en-US');
    expect(canonicalLocale('not a tag')).toBeNull();
    expect(textDirection('ar-EG')).toBe('rtl');
    expect(textDirection('he')).toBe('rtl');
    expect(textDirection('en')).toBe('ltr');
  });
});
