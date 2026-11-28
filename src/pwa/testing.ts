/** In-memory stand-ins for browser storage, shared by the unit tests of this folder. */

class MemoryCache {
  private readonly entries = new Map<string, Response>();

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.entries.set(urlOf(request), response);
  }

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    return this.entries.get(urlOf(request))?.clone();
  }

  async delete(request: RequestInfo | URL): Promise<boolean> {
    return this.entries.delete(urlOf(request));
  }

  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
}

function urlOf(request: RequestInfo | URL): string {
  return typeof request === 'string'
    ? request
    : request instanceof URL
      ? request.href
      : request.url;
}

/** The parts of `CacheStorage` the app uses. */
export class MemoryCacheStorage {
  private readonly caches = new Map<string, MemoryCache>();

  async open(name: string): Promise<Cache> {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new MemoryCache();
      this.caches.set(name, cache);
    }
    return cache as unknown as Cache;
  }

  async has(name: string): Promise<boolean> {
    return this.caches.has(name);
  }

  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }

  async keys(): Promise<string[]> {
    return [...this.caches.keys()];
  }
}

export function memoryCacheStorage(): CacheStorage {
  return new MemoryCacheStorage() as unknown as CacheStorage;
}

/** Lets pending promise callbacks and timers of the current turn run. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
