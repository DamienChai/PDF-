/**
 * Module worker entry of the PDF engine. All the logic is in `host.ts`; this file only connects
 * it to the worker's message port.
 */
import { EngineHost, workerEnvironment } from './host';
import type { HostRequest, HostResponse } from './protocol';

// The project compiles against the DOM lib, where `self` is a Window. Only these two members of
// DedicatedWorkerGlobalScope are needed.
interface WorkerScope {
  postMessage(message: HostResponse): void;
  onmessage: ((event: MessageEvent<HostRequest>) => void) | null;
}

const scope = self as unknown as WorkerScope;
const host = new EngineHost(workerEnvironment, (response) => scope.postMessage(response));

scope.onmessage = (event) => host.handle(event.data);
