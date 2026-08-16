// Carries the HTTP status so callers can distinguish a transient 503 (a read
// endpoint refusing while a compute/plot job holds the session write lock) from a
// real failure, and retry the former quietly.
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}
