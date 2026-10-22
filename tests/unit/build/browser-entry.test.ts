import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as {
  exports: Record<string, Record<string, unknown>>;
};

describe('browser build of the /chain entry (#123)', () => {
  it('exports everything the Node entry does except fromPrivateKey', async () => {
    const node = await import('../../../src/chain/index.js');
    const browser = (await import('../../../src/chain/browser.js')) as Record<string, unknown>;

    expect(typeof node.fromPrivateKey).toBe('function');
    expect(browser).not.toHaveProperty('fromPrivateKey');
    expect(Object.keys(browser).sort()).toEqual(Object.keys(node).filter((k) => k !== 'fromPrivateKey').sort());
  });

  it('package.json resolves the browser condition first, to the browser build', () => {
    const chain = pkg.exports['./chain']!;
    expect(Object.keys(chain)[0]).toBe('browser');
    expect(chain['browser']).toEqual({
      import: { types: './dist/chain/browser.d.ts', default: './dist/chain/browser.js' },
      require: { types: './dist/chain/browser.d.cts', default: './dist/chain/browser.cjs' },
    });
    // Node resolution is unchanged
    expect(chain['import']).toEqual({ types: './dist/chain/index.d.ts', default: './dist/chain/index.js' });
    expect(chain['require']).toEqual({ types: './dist/chain/index.d.cts', default: './dist/chain/index.cjs' });
  });

  it('tsup builds the browser entry', () => {
    expect(readFileSync(`${root}tsup.config.ts`, 'utf8')).toContain("'src/chain/browser.ts'");
  });
});
