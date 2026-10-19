import { RequestSnapshot } from "../interfaces/request-snapshot.interface.js";
import { CompleteTraceEventNode } from "../interfaces/trace-events.interfaces.js";
import { remapKeys } from "./remap-keys.util.js";
import { encodeTrace, RecursiveEncodedTrace } from "./trace.encoder.js";

const ATTRIBUTES_KEY_MAP = {
  method: "m",
  statusCode: "sc",
  originalUrl: "ou",
  defaultOperationId: "dop",
} as const satisfies Record<keyof RequestSnapshot["attributes"], string>;

const SNAPSHOT_KEY_MAP = {
  calledAt: "ct",
  traceId: "ti",
  startTimestamp: "st",
  duration: "d",
  protocol: "p",
  operationId: "op",
  traces: "t",
  attributes: "a",
  tags: "tg",
  error: "e",
  userId: "u",
  request: "rq",
} as const satisfies Record<keyof RequestSnapshot, string>;

export type EncodedAttributes = {
  [K in keyof RequestSnapshot["attributes"] as K extends keyof typeof ATTRIBUTES_KEY_MAP
    ? (typeof ATTRIBUTES_KEY_MAP)[K]
    : never]: RequestSnapshot["attributes"][K];
};

// `t` and `a` hold encoded values, so their types are replaced rather than
// intersected: an intersection would leave `a` claiming both the long-form and
// the short-form keys, and only the long-form ones are ever read back.
export type EncodedRequestSnapshot = Omit<
  {
    [K in keyof RequestSnapshot as K extends keyof typeof SNAPSHOT_KEY_MAP
      ? (typeof SNAPSHOT_KEY_MAP)[K]
      : never]: RequestSnapshot[K];
  },
  "t" | "a"
> & {
  // Never optional, even with no spans to carry: the collector refuses an
  // operation without the array, and the whole batch along with it.
  t: Array<RecursiveEncodedTrace>;
  a?: EncodedAttributes;
};

export class RequestSnapshotEncoder {
  static encode(snapshot: RequestSnapshot): EncodedRequestSnapshot {
    const encoded = remapKeys<RequestSnapshot, EncodedRequestSnapshot>(
      snapshot,
      SNAPSHOT_KEY_MAP,
    );
    encoded.t = (snapshot.traces ?? []).map((trace) =>
      encodeTrace(trace as CompleteTraceEventNode),
    );
    if (snapshot.attributes) {
      encoded.a = remapKeys<
        NonNullable<RequestSnapshot["attributes"]>,
        EncodedAttributes
      >(snapshot.attributes, ATTRIBUTES_KEY_MAP);
    }
    return encoded;
  }
}
