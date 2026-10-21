/** Reports how far a long computation has got: `fraction` in [0, 1], `message` names the step. */
export type Progress = (fraction: number, message: string) => void;

export const silent: Progress = () => {};

/** The part of a parent's progress bar from `from` to `to`, for one step of a pipeline. */
export function stage(progress: Progress, from: number, to: number): Progress {
  return (fraction, message) => progress(from + (to - from) * fraction, message);
}
