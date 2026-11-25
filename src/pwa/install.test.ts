import { describe, expect, it, vi } from 'vitest';
import {
  createInstallController,
  installState,
  isStandalone,
  promptInstall,
  type InstallEnvironment,
} from './install';

class FakeMediaQuery extends EventTarget {
  matches = false;
  set(matches: boolean): void {
    this.matches = matches;
    this.dispatchEvent(new Event('change'));
  }
}

function setup(options: Partial<InstallEnvironment> & { displayMode?: string } = {}) {
  const events = new EventTarget();
  const queries = new Map<string, FakeMediaQuery>();
  const env: InstallEnvironment = {
    events,
    matchMedia: (query) => {
      let media = queries.get(query);
      if (!media) {
        media = new FakeMediaQuery();
        media.matches = query === `(display-mode: ${options.displayMode})`;
        queries.set(query, media);
      }
      return media as unknown as MediaQueryList;
    },
    ...options,
  };
  return { events, queries, controller: createInstallController(env) };
}

function installPromptEvent(outcome: 'accepted' | 'dismissed' | Error) {
  const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
    prompt: ReturnType<typeof vi.fn>;
    userChoice: Promise<{ outcome: string }>;
  };
  event.prompt = vi.fn(async () => {
    if (outcome instanceof Error) throw outcome;
  });
  event.userChoice =
    outcome instanceof Error ? new Promise(() => undefined) : Promise.resolve({ outcome });
  return event;
}

describe('install state', () => {
  it('starts unavailable in a browser tab', () => {
    const { controller } = setup();
    expect(controller.state.value).toBe('unavailable');
    expect(controller.isStandalone()).toBe(false);
  });

  it.each(['standalone', 'window-controls-overlay', 'minimal-ui'])(
    'is installed when displayed as "%s"',
    (displayMode) => {
      const { controller } = setup({ displayMode });
      expect(controller.isStandalone()).toBe(true);
      expect(controller.state.value).toBe('installed');
    },
  );

  it('does not mistake a full-screen browser tab for an installed app', () => {
    const { controller } = setup({ displayMode: 'fullscreen' });
    expect(controller.isStandalone()).toBe(false);
  });

  it('detects iOS home-screen apps and Trusted Web Activities', () => {
    expect(setup({ iosStandalone: true }).controller.state.value).toBe('installed');
    expect(setup({ iosStandalone: false }).controller.state.value).toBe('unavailable');
    expect(setup({ referrer: 'android-app://com.example.twa' }).controller.isStandalone()).toBe(
      true,
    );
    expect(setup({ referrer: 'https://example.com/' }).controller.isStandalone()).toBe(false);
  });

  it('becomes available when the browser offers the prompt and suppresses the default banner', () => {
    const { events, controller } = setup();
    const event = installPromptEvent('accepted');
    events.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(controller.state.value).toBe('available');
  });

  it('becomes installed after acceptance', async () => {
    const { events, controller } = setup();
    const event = installPromptEvent('accepted');
    events.dispatchEvent(event);
    await expect(controller.prompt()).resolves.toBe('accepted');
    expect(event.prompt).toHaveBeenCalledOnce();
    expect(controller.state.value).toBe('installed');
    // The event is spent.
    await expect(controller.prompt()).resolves.toBe('unavailable');
    expect(event.prompt).toHaveBeenCalledOnce();
  });

  it('becomes unavailable after dismissal until the browser offers again', async () => {
    const { events, controller } = setup();
    events.dispatchEvent(installPromptEvent('dismissed'));
    await expect(controller.prompt()).resolves.toBe('dismissed');
    expect(controller.state.value).toBe('unavailable');
    await expect(controller.prompt()).resolves.toBe('unavailable');

    events.dispatchEvent(installPromptEvent('accepted'));
    expect(controller.state.value).toBe('available');
  });

  it('reports unavailable when there is nothing to prompt or the prompt fails', async () => {
    const { events, controller } = setup();
    await expect(controller.prompt()).resolves.toBe('unavailable');
    events.dispatchEvent(installPromptEvent(new DOMException('no gesture', 'NotAllowedError')));
    await expect(controller.prompt()).resolves.toBe('unavailable');
    expect(controller.state.value).toBe('unavailable');
  });

  it('follows appinstalled and display-mode changes', () => {
    const first = setup();
    first.events.dispatchEvent(installPromptEvent('accepted'));
    first.events.dispatchEvent(new Event('appinstalled'));
    expect(first.controller.state.value).toBe('installed');

    const second = setup();
    second.queries.get('(display-mode: standalone)')!.set(true);
    expect(second.controller.state.value).toBe('installed');
    expect(second.controller.isStandalone()).toBe(true);
  });

  it('stays installed when a prompt event arrives inside the installed app', () => {
    const { events, controller } = setup({ displayMode: 'standalone' });
    events.dispatchEvent(installPromptEvent('accepted'));
    expect(controller.state.value).toBe('installed');
  });

  it('notifies signal subscribers', () => {
    const { events, controller } = setup();
    const seen: string[] = [];
    const unsubscribe = controller.state.subscribe((value) => seen.push(value));
    events.dispatchEvent(installPromptEvent('accepted'));
    events.dispatchEvent(new Event('appinstalled'));
    unsubscribe();
    expect(seen).toEqual(['unavailable', 'available', 'installed']);
  });

  it('works without matchMedia and outside a browser', async () => {
    const events = new EventTarget();
    const bare = createInstallController({ events });
    expect(bare.isStandalone()).toBe(false);
    const none = createInstallController(null);
    expect(none.state.value).toBe('unavailable');
    await expect(none.prompt()).resolves.toBe('unavailable');

    // The module-level singleton, imported under Node.
    expect(installState.value).toBe('unavailable');
    expect(isStandalone()).toBe(false);
    await expect(promptInstall()).resolves.toBe('unavailable');
  });
});
