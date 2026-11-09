/** Runs `fn` in a task of its own, once the current task and its microtasks are done:
 * the point at which everything asked for together has been asked for, so it can be
 * batched. `setTimeout(fn, 0)` does the same in a visible tab, but Chrome holds a hidden
 * tab's timers to once a second, and a read made of many batches then takes minutes. */
export function afterThisTask(fn: () => void): void {
  const { port1, port2 } = new MessageChannel();
  port1.onmessage = () => {
    port1.close();
    fn();
  };
  port2.postMessage(null);
}
