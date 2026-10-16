import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Formatted } from './formatted';

describe('Formatted (spec 006, criterion 8)', () => {
  it('renders the shorthand as elements and never as raw HTML', () => {
    const { container } = render(<Formatted text={'*Migrated* ~three~ two to `orders-db` _soon_ __now__ <b>x</b>\nnext line\n- one\n- two'} />);
    const root = container.querySelector('.fmt')!;
    expect(root.querySelector('strong')!.textContent).toBe('Migrated');
    expect(root.querySelector('s')!.textContent).toBe('three');
    expect(root.querySelector('code')!.textContent).toBe('orders-db');
    expect(root.querySelector('em')!.textContent).toBe('soon');
    expect(root.querySelector('u')!.textContent).toBe('now');
    expect(root.querySelector('b')).toBeNull();
    expect(root.textContent).toContain('<b>x</b>');
    expect(root.querySelectorAll('br')).toHaveLength(1);
    expect([...root.querySelectorAll('.fmt-item')].map((i) => i.textContent)).toEqual(['one', 'two']);
  });

  it('leaves plain text as typed', () => {
    const { container } = render(<Formatted text="snake_case 2*3*4" />);
    expect(container.textContent).toBe('snake_case 2*3*4');
    expect(container.querySelector('strong, em')).toBeNull();
  });
});
