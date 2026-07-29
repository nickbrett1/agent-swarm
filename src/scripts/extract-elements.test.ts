// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EXTRACT_ELEMENTS_SCRIPT } from './extract-elements.js';

describe('EXTRACT_ELEMENTS_SCRIPT', () => {
  let originalGetBoundingClientRect: typeof HTMLElement.prototype.getBoundingClientRect;
  let originalGetComputedStyle: typeof window.getComputedStyle;

  beforeAll(() => {
    originalGetBoundingClientRect = window.HTMLElement.prototype.getBoundingClientRect;
    originalGetComputedStyle = window.getComputedStyle;

    // Default mock to visible elements
    window.HTMLElement.prototype.getBoundingClientRect = function() {
      if (this.hasAttribute('data-hidden')) {
        return { width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0 } as DOMRect;
      }
      return { width: 100, height: 100, top: 0, left: 0, bottom: 100, right: 100 } as DOMRect;
    };

    window.getComputedStyle = function(elt) {
      const style = originalGetComputedStyle(elt);
      if (elt.hasAttribute('data-display-none')) {
        return { ...style, display: 'none' } as CSSStyleDeclaration;
      }
      if (elt.hasAttribute('data-visibility-hidden')) {
        return { ...style, visibility: 'hidden' } as CSSStyleDeclaration;
      }
      if (elt.hasAttribute('data-opacity-zero')) {
        return { ...style, opacity: '0' } as CSSStyleDeclaration;
      }
      return { ...style, display: 'block', visibility: 'visible', opacity: '1' } as CSSStyleDeclaration;
    };
  });

  afterAll(() => {
    window.HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    window.getComputedStyle = originalGetComputedStyle;
  });

  it('should extract basic elements and compute standard XPaths', () => {
    document.body.innerHTML = `
      <button id="btn1">Click me</button>
      <input type="text" placeholder="Enter name" name="username" />
      <a href="/link" role="button">Link as button</a>
    `;
    const result = eval(EXTRACT_ELEMENTS_SCRIPT);

    expect(result).toHaveLength(3);

    expect(result[0]).toEqual({
      tag: 'button',
      type: 'submit',
      text: 'Click me',
      placeholder: '',
      name: 'btn1',
      role: '',
      xpath: '//*[@id="btn1"]'
    });

    expect(result[1]).toEqual({
      tag: 'input',
      type: 'text',
      text: '',
      placeholder: 'Enter name',
      name: 'username',
      role: '',
      xpath: '/html/body/input'
    });

    expect(result[2]).toEqual({
      tag: 'a',
      type: '',
      text: 'Link as button',
      placeholder: '',
      name: '',
      role: 'button',
      xpath: '/html/body/a'
    });
  });

  it('should ignore hidden elements (width/height 0 or CSS hidden)', () => {
    document.body.innerHTML = `
      <button id="btn-hidden" data-hidden="true">Hidden</button>
      <button id="btn-display-none" data-display-none="true">None</button>
      <button id="btn-visibility-hidden" data-visibility-hidden="true">Invisible</button>
      <button id="btn-opacity-zero" data-opacity-zero="true">Transparent</button>
      <button id="btn-visible">Visible</button>
    `;
    const result = eval(EXTRACT_ELEMENTS_SCRIPT);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('btn-visible');
  });

  it('should ignore disabled elements', () => {
    document.body.innerHTML = `
      <button id="btn-disabled" disabled>Disabled natively</button>
      <button id="btn-aria-disabled" aria-disabled="true">Aria disabled</button>
      <button id="btn-class-disabled" class="disabled">Class disabled</button>
      <button id="btn-active">Active</button>
    `;
    const result = eval(EXTRACT_ELEMENTS_SCRIPT);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('btn-active');
  });

  it('should correctly format paths for elements with same-tag siblings', () => {
    document.body.innerHTML = `
      <div>
        <p>Text</p>
        <button id="no-id-1">Btn1</button>
        <button id="no-id-2">Btn2</button>
        <span>Middle</span>
        <button id="no-id-3">Btn3</button>
      </div>
    `;
    // We strip IDs to test the generic xpath generation
    document.getElementById('no-id-1')!.removeAttribute('id');
    document.getElementById('no-id-2')!.removeAttribute('id');
    document.getElementById('no-id-3')!.removeAttribute('id');

    const result = eval(EXTRACT_ELEMENTS_SCRIPT);

    expect(result).toHaveLength(3);
    expect(result[0].xpath).toBe('/html/body/div/button[1]');
    expect(result[1].xpath).toBe('/html/body/div/button[2]');
    expect(result[2].xpath).toBe('/html/body/div/button[3]');
  });

  it('should correctly clean and truncate text', () => {
    document.body.innerHTML = `
      <button id="btn-long">
        This is a very very very very very very very very very very very very very very very long button text
      </button>
      <input type="text" id="input-value" value="Pre-filled value" />
    `;
    const result = eval(EXTRACT_ELEMENTS_SCRIPT);

    expect(result).toHaveLength(2);
    expect(result[0].text.length).toBe(80); // 77 chars + "..."
    expect(result[0].text.endsWith('...')).toBe(true);
    expect(result[1].text).toBe('Pre-filled value');
  });
});