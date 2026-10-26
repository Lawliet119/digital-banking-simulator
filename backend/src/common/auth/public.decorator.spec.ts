import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY, Public } from './public.decorator';

describe('@Public()', () => {
  it('sets IS_PUBLIC_KEY metadata to true on a method, readable via Reflector', () => {
    class Probe {
      @Public()
      open(): void {
        /* no-op */
      }

      guarded(): void {
        /* no-op */
      }
    }

    const reflector = new Reflector();

    expect(reflector.get(IS_PUBLIC_KEY, Probe.prototype.open)).toBe(true);
    expect(reflector.get(IS_PUBLIC_KEY, Probe.prototype.guarded)).toBeUndefined();
  });

  it('also works on a class, so every route of a controller becomes public', () => {
    @Public()
    class OpenController {
      ping(): void {
        /* no-op */
      }
    }

    const reflector = new Reflector();

    expect(reflector.get(IS_PUBLIC_KEY, OpenController)).toBe(true);
  });
});
