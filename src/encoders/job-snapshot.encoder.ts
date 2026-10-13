import { JobSnapshot } from "../interfaces/index.js";
import { CompleteTraceEventNode } from "../interfaces/trace-events.interfaces.js";
import { remapKeys } from "./remap-keys.util.js";
import { encodeTrace, RecursiveEncodedTrace } from "./trace.encoder.js";

const SNAPSHOT_KEY_MAP = {
  id: "i",
  traceId: "ti",
  name: "n",
  queueName: "q",
  status: "s",
  calledAt: "c",
  startTimestamp: "st",
  duration: "d",
  enqueuedAt: "ea",
  waitDuration: "wd",
  attemptsMade: "am",
  maxAttempts: "ma",
  tags: "tg",
  traces: "t",
  error: "e",
} as const satisfies Record<keyof JobSnapshot, string>;

// `t` holds encoded spans, so its type is replaced rather than intersected -
// and never optional, for the same reason as a request's.
export type EncodedJobSnapshot = Omit<
  {
    [K in keyof JobSnapshot as K extends keyof typeof SNAPSHOT_KEY_MAP
      ? (typeof SNAPSHOT_KEY_MAP)[K]
      : never]: JobSnapshot[K];
  },
  "t"
> & {
  t: Array<RecursiveEncodedTrace>;
};

export class JobSnapshotEncoder {
  static encode(snapshot: JobSnapshot): EncodedJobSnapshot {
    const encoded = remapKeys<JobSnapshot, EncodedJobSnapshot>(
      snapshot,
      SNAPSHOT_KEY_MAP,
    );
    encoded.t = (snapshot.traces ?? []).map((trace) =>
      encodeTrace(trace as CompleteTraceEventNode),
    );
    return encoded;
  }
}
