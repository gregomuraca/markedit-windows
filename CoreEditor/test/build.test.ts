import { describe, expect, test } from '@jest/globals';
import fs from 'fs';
import path from 'path';

const readHtml = () => {
  const filePath = path.join(__dirname, '../../dist/index.html');
  return fs.readFileSync(filePath, 'utf-8');
};

describe('Build system', () => {
  test('Windows build has its two panes and a content security policy', () => {
    const html = readHtml();
    expect(html).toContain('id="write-pane"');
    expect(html).toContain('id="read-pane"');
    expect(html).toContain('Content-Security-Policy');
    expect(html).not.toContain('{{EDITOR_CONFIG}}');
  });

  test('Windows assets are packaged locally and exist on disk', () => {
    const html = readHtml();
    const document = new DOMParser().parseFromString(html, 'text/html');
    const assets = [...document.querySelectorAll('script[src],link[rel="stylesheet"]')];
    expect(assets.length).toBeGreaterThanOrEqual(2);
    for (const asset of assets) {
      const url = asset.getAttribute('src') ?? asset.getAttribute('href')!;
      expect(url.startsWith('./assets/')).toBe(true);
      expect(fs.existsSync(path.join(__dirname, '../../dist', url))).toBe(true);
    }
  });
});
