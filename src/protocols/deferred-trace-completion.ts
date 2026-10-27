import type { Logger } from "@nestjs/common";

const reportedCallbacks = new WeakSet<Function>();
const reportedDeferredFailures = new WeakSet<object>();

function describeFailure(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "an unprintable error";
  }
}

function warnSafely(logger: Logger, message: string): void {
  try {
    logger.warn(message);
  } catch {
    // Diagnostics must not become another failure in deferred telemetry.
  }
}

/** A bad identity callback must not prevent the trace from being closed. */
export function getUserIdSafely<TArgs extends unknown[]>(
  callback: ((...args: TArgs) => string | undefined) | undefined,
  args: TArgs,
  receiver: unknown,
  logger: Logger,
  transport: string,
): string | undefined {
  if (!callback) {
    return undefined;
  }
  try {
    return callback.apply(receiver, args);
  } catch (error) {
    if (!reportedCallbacks.has(callback)) {
      reportedCallbacks.add(callback);
      warnSafely(
        logger,
        `"${transport}.getUserId" threw; completing the trace without a user id. Later failures are not reported: ${describeFailure(error)}`,
      );
    }
    return undefined;
  }
}

/** Run deferred completion without ever leaking a rejection from its timer. */
export function deferTraceCompletion(
  completion: () => Promise<void>,
  logger: Logger,
  transport: string,
): void {
  setTimeout(() => {
    void Promise.resolve()
      .then(completion)
      .catch((error: unknown) => {
        if (!reportedDeferredFailures.has(logger)) {
          reportedDeferredFailures.add(logger);
          warnSafely(
            logger,
            `Deferred ${transport} trace completion failed; later failures are not reported: ${describeFailure(error)}`,
          );
        }
      });
  }, 0);
}
