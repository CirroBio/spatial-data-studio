// Module worker entry: one request per worker, answered by `handleRequest`.
import { handleRequest, type AnalysisRequest } from './ops';

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (event: MessageEvent<AnalysisRequest>) => {
  handleRequest(event.data, (message, transfer) => self.postMessage(message, transfer));
};
