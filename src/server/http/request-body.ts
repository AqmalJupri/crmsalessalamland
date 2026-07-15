export type JsonRequestBodyErrorKind =
  | "INVALID_CONTENT_LENGTH"
  | "INVALID_JSON"
  | "PAYLOAD_TOO_LARGE";

export class JsonRequestBodyError extends Error {
  constructor(public readonly kind: JsonRequestBodyErrorKind) {
    super(kind);
    this.name = "JsonRequestBodyError";
  }
}

function assertBodyLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive safe integer.");
  }
}

function assertDeclaredLengthWithinLimit(request: Request, maxBytes: number): void {
  const rawLength = request.headers.get("content-length");
  if (rawLength === null) return;
  if (!/^\d+$/.test(rawLength)) {
    throw new JsonRequestBodyError("INVALID_CONTENT_LENGTH");
  }

  if (BigInt(rawLength) > BigInt(maxBytes)) {
    throw new JsonRequestBodyError("PAYLOAD_TOO_LARGE");
  }
}

export async function readJsonRequestBody(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  assertBodyLimit(maxBytes);
  assertDeclaredLengthWithinLimit(request, maxBytes);

  const reader = request.body?.getReader();
  if (!reader) throw new JsonRequestBodyError("INVALID_JSON");

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new JsonRequestBodyError("PAYLOAD_TOO_LARGE");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof JsonRequestBodyError) throw error;
    throw new JsonRequestBodyError("INVALID_JSON");
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new JsonRequestBodyError("INVALID_JSON");
  }
}
