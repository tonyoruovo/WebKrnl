/**
 * @fileoverview
 * @summary An ICU MessageFormat subset: a parser that makes plain data, and a formatter.
 * @description
 * Implements the message format of docs/ARCHITECTURE.md §21.2. The parser
 * turns a message into an array of nodes (plain data), so a worker can parse
 * a whole catalog and send the result back. The formatter renders the nodes
 * with the parameters and the `Intl` formatters of a locale.
 *
 * ```text
 *   'You have {count, plural, =0 {no messages} one {# message} other {# messages}}.'
 *     --> ['You have ', { type: 'plural', name: 'count', offset: 0, ordinal: false, options: { '=0': [...], one: [...], other: [...] } }, '.']
 *     --> formatMessage(nodes, { count: 3 }, context) --> 'You have 3 messages.'
 *
 *   supported   {name}   {n, number[, integer|percent|currency|::skeleton]}   {d, date|time[, short|medium|long|full]}
 *               {n, plural|selectordinal, [offset:N] =N {...} one {...} other {...}}   # inside plural
 *               {g, select, a {...} other {...}}   nested messages   '' and '{...}' quoting
 *   ```
 *
 * @example
 * Parse and format
 * ```ts
 * const nodes = parseMessage('Hello, {name}!');
 * formatMessage(nodes, { name: 'Ada' }, createFormatContext('en')); // 'Hello, Ada!'
 * ```
 *
 * @author MathAid
 */

/**
 * @summary One node of a parsed message.
 *
 * @description
 * A string is literal text. The other nodes are arguments: `argument`
 * (the value as text), `number`, `date` and `time` (with an optional style),
 * `plural` (with `ordinal` for `selectordinal`), `select`, and `pound` (the
 * number of the nearest `plural`, minus its offset).
 *
 * @example
 * Example 1: An argument
 * ```ts
 * const node: MessageNode = { type: 'argument', name: 'name' };
 * ```
 *
 * @example
 * Example 2: A number with a style
 * ```ts
 * const node: MessageNode = { type: 'number', name: 'ratio', style: 'percent' };
 * ```
 *
 * @public
 */
export type MessageNode =
  string | ArgumentNode | NumberNode | DateNode | PluralNode | SelectNode | PoundNode;

/**
 * @summary An argument shown as text: `{name}`.
 * @public
 */
export interface ArgumentNode {
  /**
   * @summary The kind of node.
   */
  readonly type: 'argument';
  /**
   * @summary The name of the parameter.
   */
  readonly name: string;
}

/**
 * @summary A number argument: `{name, number, style}`.
 * @public
 */
export interface NumberNode {
  /**
   * @summary The kind of node.
   */
  readonly type: 'number';
  /**
   * @summary The name of the parameter.
   */
  readonly name: string;
  /**
   * @summary The style: `integer`, `percent`, `currency`, or a skeleton that starts with `::`.
   */
  readonly style?: string;
}

/**
 * @summary A date or time argument: `{name, date, style}` or `{name, time, style}`.
 * @public
 */
export interface DateNode {
  /**
   * @summary The kind of node.
   */
  readonly type: 'date' | 'time';
  /**
   * @summary The name of the parameter.
   */
  readonly name: string;
  /**
   * @summary The style: `short`, `medium`, `long` or `full`.
   */
  readonly style?: string;
}

/**
 * @summary A plural argument: `{name, plural, ...}` or `{name, selectordinal, ...}`.
 * @public
 */
export interface PluralNode {
  /**
   * @summary The kind of node.
   */
  readonly type: 'plural';
  /**
   * @summary The name of the parameter, a number.
   */
  readonly name: string;
  /**
   * @summary `true` for `selectordinal` (1st, 2nd), `false` for `plural`.
   */
  readonly ordinal: boolean;
  /**
   * @summary The offset: subtracted from the number before the category and `#`.
   */
  readonly offset: number;
  /**
   * @summary The messages, by selector: `=N`, a plural category, and `other`.
   */
  readonly options: Readonly<Record<string, CompiledMessage>>;
}

/**
 * @summary A select argument: `{name, select, ...}`.
 * @public
 */
export interface SelectNode {
  /**
   * @summary The kind of node.
   */
  readonly type: 'select';
  /**
   * @summary The name of the parameter.
   */
  readonly name: string;
  /**
   * @summary The messages, by value, and `other`.
   */
  readonly options: Readonly<Record<string, CompiledMessage>>;
}

/**
 * @summary The number of the nearest plural, minus its offset: `#`.
 * @public
 */
export interface PoundNode {
  /**
   * @summary The kind of node.
   */
  readonly type: 'pound';
}

/**
 * @summary A parsed message: an array of nodes. It is plain data, and can cross a worker boundary.
 * @public
 */
export type CompiledMessage = readonly MessageNode[];

/**
 * @summary The error for a message that is not valid ICU MessageFormat.
 *
 * @example
 * Example 1: A missing brace
 * ```ts
 * parseMessage('Hello, {name'); // throws MessageSyntaxError: Missing "}" at 12.
 * ```
 *
 * @example
 * Example 2: Reading the position
 * ```ts
 * try { parseMessage(text); } catch (error) { if (error instanceof MessageSyntaxError) mark(error.offset); }
 * ```
 *
 * @public
 */
export class MessageSyntaxError extends Error {
  /**
   * @summary The position of the problem in the message, from 0.
   */
  readonly offset: number;

  /**
   * @summary Creates the error.
   * @param {string} problem What is wrong.
   * @param {number} offset The position in the message.
   */
  constructor(problem: string, offset: number) {
    super(`${problem} at ${offset}.`);
    this.name = 'MessageSyntaxError';
    this.offset = offset;
  }
}

const WHITESPACE = /\s/;
const NAME = /[^\s{}#,:='|]/;

/** A recursive descent parser over one message. */
class Parser {
  private at = 0;

  constructor(private readonly source: string) {}

  parse(): MessageNode[] {
    const nodes = this.message(0, false);
    if (this.at < this.source.length) throw new MessageSyntaxError('Unmatched "}"', this.at);
    return nodes;
  }

  /** Text and arguments, until the end or an unmatched `}` (when nested). */
  private message(depth: number, inPlural: boolean): MessageNode[] {
    const nodes: MessageNode[] = [];
    let text = '';
    const flush = () => {
      if (text !== '') nodes.push(text);
      text = '';
    };
    const { source } = this;
    while (this.at < source.length) {
      const char = source[this.at]!;
      if (char === '{') {
        flush();
        nodes.push(this.argument(depth, inPlural));
        continue;
      }
      if (char === '}') {
        if (depth > 0) break;
        throw new MessageSyntaxError('Unmatched "}"', this.at);
      }
      if (char === '#' && inPlural) {
        flush();
        nodes.push({ type: 'pound' });
        this.at++;
        continue;
      }
      if (char === "'") {
        const next = source[this.at + 1];
        if (next === "'") {
          text += "'";
          this.at += 2;
          continue;
        }
        if (next === '{' || next === '}' || next === '|' || (inPlural && next === '#')) {
          // A quoted literal: up to the next lone apostrophe.
          this.at++;
          while (this.at < source.length) {
            if (source[this.at] === "'") {
              if (source[this.at + 1] === "'") {
                text += "'";
                this.at += 2;
                continue;
              }
              this.at++;
              break;
            }
            text += source[this.at++];
          }
          continue;
        }
      }
      text += char;
      this.at++;
    }
    flush();
    return nodes;
  }

  private spaces(): void {
    while (this.at < this.source.length && WHITESPACE.test(this.source[this.at]!)) this.at++;
  }

  private expect(char: string): void {
    this.spaces();
    if (this.source[this.at] !== char) {
      throw new MessageSyntaxError(
        this.at >= this.source.length ? `Missing "${char}"` : `Expected "${char}"`,
        this.at,
      );
    }
    this.at++;
  }

  private word(what: string): string {
    this.spaces();
    const start = this.at;
    while (this.at < this.source.length && NAME.test(this.source[this.at]!)) this.at++;
    if (this.at === start) throw new MessageSyntaxError(`Expected ${what}`, start);
    return this.source.slice(start, this.at);
  }

  /** `{name}`, `{name, type}` or `{name, type, style or options}`. */
  private argument(depth: number, inPlural: boolean): MessageNode {
    this.at++; // {
    const name = this.word('an argument name');
    this.spaces();
    if (this.at >= this.source.length) throw new MessageSyntaxError('Missing "}"', this.at);
    if (this.source[this.at] === '}') {
      this.at++;
      return { type: 'argument', name };
    }
    this.expect(',');
    const typeAt = this.at;
    const type = this.word('an argument type');
    if (type === 'number' || type === 'date' || type === 'time') {
      this.spaces();
      let style: string | undefined;
      if (this.source[this.at] === ',') {
        this.at++;
        const end = this.source.indexOf('}', this.at);
        if (end < 0) throw new MessageSyntaxError('Missing "}"', this.source.length);
        style = this.source.slice(this.at, end).trim();
        this.at = end;
      }
      this.expect('}');
      return style ? { type, name, style } : { type, name };
    }
    if (type === 'plural' || type === 'selectordinal' || type === 'select') {
      this.expect(',');
      let offset = 0;
      const plural = type !== 'select';
      this.spaces();
      if (plural && this.source.startsWith('offset:', this.at)) {
        this.at += 'offset:'.length;
        this.spaces();
        const match = /^\d+/.exec(this.source.slice(this.at));
        if (!match) throw new MessageSyntaxError('Expected a number after "offset:"', this.at);
        offset = Number(match[0]);
        this.at += match[0].length;
      }
      const options: Record<string, CompiledMessage> = {};
      for (;;) {
        this.spaces();
        if (this.source[this.at] === '}') break;
        if (this.at >= this.source.length) throw new MessageSyntaxError('Missing "}"', this.at);
        const selectorAt = this.at;
        let selector: string;
        if (plural && this.source[this.at] === '=') {
          const match = /^=\d+(\.\d+)?/.exec(this.source.slice(this.at));
          if (!match) throw new MessageSyntaxError('Expected a number after "="', this.at);
          selector = match[0];
          this.at += selector.length;
        } else {
          selector = this.word('a selector');
        }
        if (selector in options)
          throw new MessageSyntaxError(`Repeated selector "${selector}"`, selectorAt);
        this.expect('{');
        options[selector] = this.message(depth + 1, plural || inPlural);
        this.expect('}');
      }
      this.at++; // }
      if (!('other' in options)) throw new MessageSyntaxError('Missing the "other" option', typeAt);
      return plural
        ? { type: 'plural', name, ordinal: type === 'selectordinal', offset, options }
        : { type: 'select', name, options };
    }
    throw new MessageSyntaxError(`Unknown argument type "${type}"`, typeAt);
  }
}

/**
 * @summary Parses an ICU message into nodes.
 *
 * @description
 * Text outside arguments is kept as strings. An apostrophe quotes a `{`,
 * `}`, `|` or (in a plural) `#` and the text after it, up to the next
 * apostrophe; two apostrophes make one. A `plural`, `selectordinal` or
 * `select` must have an `other` option.
 *
 * @example
 * Example 1: A plural
 * ```ts
 * parseMessage('{n, plural, one {# item} other {# items}}');
 * ```
 *
 * @example
 * Example 2: Quoting a brace
 * ```ts
 * parseMessage("Use '{name}' as a placeholder."); // ['Use {name} as a placeholder.']
 * ```
 *
 * @param {string} source The message.
 * @returns {CompiledMessage} The nodes.
 * @throws {MessageSyntaxError} When the message is not valid.
 *
 * @public
 */
export function parseMessage(source: string): CompiledMessage {
  return new Parser(source).parse();
}

/**
 * @summary What the formatter needs from a locale: the formatters, and the rules for escaping and currency.
 *
 * @example
 * Example 1: The usual context
 * ```ts
 * const context = createFormatContext('fr-FR', { currency: 'EUR' });
 * ```
 *
 * @example
 * Example 2: Without escaping, for a framework that escapes text itself
 * ```ts
 * const context = createFormatContext('en', { escape: false });
 * ```
 *
 * @public
 */
export interface FormatContext {
  /**
   * @summary The locale of the message.
   */
  readonly locale: string;
  /**
   * @summary Tells if parameter values are HTML-escaped.
   */
  readonly escape: boolean;
  /**
   * @summary The currency of the `currency` number style, for example `EUR`.
   */
  readonly currency: string;
  /**
   * @summary Returns a number formatter for this locale.
   * @param {Intl.NumberFormatOptions} options The options.
   * @returns {Intl.NumberFormat} The formatter (cached).
   */
  number(options: Intl.NumberFormatOptions): Intl.NumberFormat;
  /**
   * @summary Returns a date formatter for this locale.
   * @param {Intl.DateTimeFormatOptions} options The options.
   * @returns {Intl.DateTimeFormat} The formatter (cached).
   */
  date(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat;
  /**
   * @summary Returns the plural rules of this locale.
   * @param {boolean} ordinal `true` for ordinal rules (1st, 2nd), `false` for cardinal rules.
   * @returns {Intl.PluralRules} The rules (cached).
   */
  plural(ordinal: boolean): Intl.PluralRules;
}

/**
 * @summary Makes a format context for a locale, with cached `Intl` formatters.
 *
 * @example
 * Example 1: English
 * ```ts
 * formatMessage(parseMessage('{n, number}'), { n: 1234.5 }, createFormatContext('en')); // '1,234.5'
 * ```
 *
 * @example
 * Example 2: German, with euros
 * ```ts
 * formatMessage(parseMessage('{p, number, currency}'), { p: 5 }, createFormatContext('de', { currency: 'EUR' })); // '5,00 €'
 * ```
 *
 * @param {string} locale The locale.
 * @param {{ escape?: boolean; currency?: string }} [options] Escaping (default `true`) and the currency (default `USD`).
 * @returns {FormatContext} The context.
 *
 * @public
 */
export function createFormatContext(
  locale: string,
  options: { escape?: boolean; currency?: string } = {},
): FormatContext {
  const numbers = new Map<string, Intl.NumberFormat>();
  const dates = new Map<string, Intl.DateTimeFormat>();
  const plurals = new Map<boolean, Intl.PluralRules>();
  const cached = <F>(cache: Map<string, F>, key: object, make: () => F): F => {
    const id = JSON.stringify(key);
    let formatter = cache.get(id);
    if (!formatter) cache.set(id, (formatter = make()));
    return formatter;
  };
  return {
    locale,
    escape: options.escape ?? true,
    currency: options.currency ?? 'USD',
    number: (o) => cached(numbers, o, () => new Intl.NumberFormat(locale, o)),
    date: (o) => cached(dates, o, () => new Intl.DateTimeFormat(locale, o)),
    plural(ordinal) {
      let rules = plurals.get(ordinal);
      if (!rules) {
        rules = new Intl.PluralRules(locale, { type: ordinal ? 'ordinal' : 'cardinal' });
        plurals.set(ordinal, rules);
      }
      return rules;
    },
  };
}

/**
 * @summary Escapes the HTML special characters of a text.
 *
 * @example
 * Example 1: A tag
 * ```ts
 * escapeHtml('<b>'); // '&lt;b&gt;'
 * ```
 *
 * @example
 * Example 2: Quotes
 * ```ts
 * escapeHtml(`"it's"`); // '&quot;it&#39;s&quot;'
 * ```
 *
 * @param {string} text The text.
 * @returns {string} The escaped text.
 *
 * @public
 */
export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
}

/** The options of a `number` style, or a skeleton (`::currency/EUR`, `::percent`, `::compact-short`, `::.00`). */
function numberOptions(style: string | undefined, currency: string): Intl.NumberFormatOptions {
  if (!style) return {};
  if (style === 'integer') return { maximumFractionDigits: 0 };
  if (style === 'percent') return { style: 'percent' };
  if (style === 'currency') return { style: 'currency', currency };
  const options: Intl.NumberFormatOptions = {};
  if (style.startsWith('::')) {
    for (const stem of style.slice(2).trim().split(/\s+/)) {
      if (stem.startsWith('currency/'))
        Object.assign(options, { style: 'currency', currency: stem.slice(9) });
      else if (stem === 'percent') options.style = 'percent';
      else if (stem === 'compact-short')
        Object.assign(options, { notation: 'compact', compactDisplay: 'short' });
      else if (stem === 'compact-long')
        Object.assign(options, { notation: 'compact', compactDisplay: 'long' });
      else if (/^\.0+$/.test(stem)) {
        options.minimumFractionDigits = options.maximumFractionDigits = stem.length - 1;
      } else if (/^\.0*#+$/.test(stem)) {
        options.minimumFractionDigits = stem.indexOf('#') - 1;
        options.maximumFractionDigits = stem.length - 1;
      }
    }
  }
  return options;
}

/** The options of a `date` or `time` style. */
function dateOptions(type: 'date' | 'time', style: string | undefined): Intl.DateTimeFormatOptions {
  const known = style === 'short' || style === 'medium' || style === 'long' || style === 'full';
  const chosen = (
    known ? style : type === 'date' ? 'medium' : 'short'
  ) as Intl.DateTimeFormatOptions['dateStyle'];
  return type === 'date' ? { dateStyle: chosen } : { timeStyle: chosen };
}

/** A value as a date. */
function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(value as string | number);
}

/**
 * @summary Formats a parsed message with parameters.
 *
 * @description
 * A missing parameter renders as `{name}`, so the gap shows and nothing
 * breaks. Numbers in a plain argument use the number format of the locale,
 * and dates use the date format. With `context.escape`, the text of each
 * parameter value is HTML-escaped. The text of the message is not: catalogs
 * are trusted.
 *
 * @example
 * Example 1: A select inside a plural
 * ```ts
 * const nodes = parseMessage('{g, select, female {She has} other {They have}} {n, plural, one {# cat} other {# cats}}.');
 * formatMessage(nodes, { g: 'female', n: 2 }, createFormatContext('en')); // 'She has 2 cats.'
 * ```
 *
 * @example
 * Example 2: An ordinal
 * ```ts
 * formatMessage(parseMessage('{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}'), { n: 22 }, createFormatContext('en')); // '22nd'
 * ```
 *
 * @param {CompiledMessage} message The parsed message.
 * @param {Readonly<Record<string, unknown>>} params The parameters.
 * @param {FormatContext} context The locale and its formatters.
 * @returns {string} The text.
 *
 * @public
 */
export function formatMessage(
  message: CompiledMessage,
  params: Readonly<Record<string, unknown>>,
  context: FormatContext,
): string {
  return render(message, params, context, null);
}

/** Renders nodes; `pound` is the number of the nearest plural, or null. */
function render(
  nodes: CompiledMessage,
  params: Readonly<Record<string, unknown>>,
  context: FormatContext,
  pound: number | null,
): string {
  let out = '';
  const text = (value: string) => (context.escape ? escapeHtml(value) : value);
  for (const node of nodes) {
    if (typeof node === 'string') {
      out += node;
      continue;
    }
    if (node.type === 'pound') {
      out += pound === null ? '#' : context.number({}).format(pound);
      continue;
    }
    if (!(node.name in params)) {
      out += `{${node.name}}`;
      continue;
    }
    const value = params[node.name];
    switch (node.type) {
      case 'argument':
        out +=
          typeof value === 'number' || typeof value === 'bigint'
            ? context.number({}).format(value)
            : value instanceof Date
              ? context.date({}).format(value)
              : text(String(value));
        break;
      case 'number':
        out += context.number(numberOptions(node.style, context.currency)).format(Number(value));
        break;
      case 'date':
      case 'time':
        out += context.date(dateOptions(node.type, node.style)).format(toDate(value));
        break;
      case 'plural': {
        const n = Number(value);
        const exact = node.options[`=${n}`];
        const category = context.plural(node.ordinal).select(n - node.offset);
        const option = exact ?? node.options[category] ?? node.options.other!;
        out += render(option, params, context, n - node.offset);
        break;
      }
      case 'select': {
        const option = node.options[String(value)] ?? node.options.other!;
        out += render(option, params, context, pound);
        break;
      }
    }
  }
  return out;
}
