import { ERROR_CODES, type ErrorCode } from "../errors/codes.js";

export interface TrackerErrorOptions {
  cause?: unknown;
  details?: unknown;
  status?: number;
}

export class TrackerError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;
  readonly status: number | null;

  constructor(
    code: ErrorCode,
    message: string,
    options: TrackerErrorOptions = {},
  ) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "TrackerError";
    this.code = code;
    this.details = options.details ?? null;
    this.status = options.status ?? null;
  }
}

export function toTrackerRequestError(input: {
  error: unknown;
  requestCode?: ErrorCode;
  message?: string;
}): TrackerError {
  if (input.error instanceof TrackerError) {
    return input.error;
  }

  return new TrackerError(
    input.requestCode ?? ERROR_CODES.trackerRequestFailed,
    input.message ??
      "Tracker request failed before a valid response was received.",
    { cause: input.error },
  );
}
