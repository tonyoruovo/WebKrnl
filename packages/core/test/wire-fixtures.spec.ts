/**
 * The wire fixtures (fixtures/wire) that backend teams use: every valid one
 * decodes, and every invalid one fails for its stated reason.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { WireProtocolError, decodeWire, encodeWire } from '../src';

const root = fileURLToPath(new URL('../fixtures/wire', import.meta.url));
const load = (dir: string) =>
  readdirSync(join(root, dir)).map((name) => ({
    name,
    ...(JSON.parse(readFileSync(join(root, dir, name), 'utf8')) as {
      description: string;
      reason?: string;
      envelope: unknown;
    }),
  }));

describe('wire fixtures', () => {
  it.each(load('valid'))('$name decodes and encodes again', ({ envelope }) => {
    const decoded = decodeWire(envelope);
    expect(JSON.parse(encodeWire(decoded))).toEqual(envelope);
  });

  it.each(load('invalid'))('$name is refused ($reason)', ({ envelope, reason }) => {
    let error: unknown;
    try {
      decodeWire(envelope);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WireProtocolError);
    const issues = (error as WireProtocolError).issues.map((i) => i.path.join('.'));
    if (reason === 'version') expect((error as Error).message).toContain('version');
    else expect(issues).toContain(reason);
  });
});
