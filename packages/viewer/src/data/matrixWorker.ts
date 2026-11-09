// Module worker entry: reads one expression matrix (expressionMatrix.ts).
import { answerMatrixReads } from './expressionMatrix';

declare const self: DedicatedWorkerGlobalScope;

answerMatrixReads(self);
