import * as S from "@effect/schema/Schema";
import * as Effect from "effect/Effect";

import {
  exponentialBackoff,
  fetchEff,
  parseResponseJson,
  RetryError,
  signPayload,
  UploadThingError,
} from "@uploadthing/shared";
import type { ResponseEsque } from "@uploadthing/shared";

import type { MPUResponse, PSPResponse } from "./shared-schemas";
import { PollUploadResponse, UploadedFileData } from "./shared-schemas";

const isValidResponse = (response: ResponseEsque) => {
  if (!response.ok) return false;
  if (response.status >= 400) return false;
  if (!response.headers.has("x-uploadthing-version")) return false;

  return true;
};

export const conditionalDevServer = (
  presigned: MPUResponse | PSPResponse,
  apiKey: string,
) => {
  return Effect.gen(function* () {
    const { file, metadata } = yield* fetchEff(presigned.pollingUrl, {
      headers: { Authorization: presigned.pollingJwt },
    }).pipe(
      Effect.andThen(parseResponseJson),
      Effect.andThen(S.decodeUnknown(PollUploadResponse)),
      Effect.andThen((res) =>
        res.status === "done"
          ? Effect.succeed(res)
          : Effect.fail(new RetryError()),
      ),
      Effect.retry({
        while: (err) => err instanceof RetryError,
        schedule: exponentialBackoff(),
      }),
      Effect.catchTag("RetryError", (e) => Effect.die(e)),
    );

    if (file === undefined) {
      yield* Effect.logError(
        `Failed to simulate callback for file ${presigned.key}`,
      );
      return yield* new UploadThingError({
        code: "UPLOAD_FAILED",
        message: "File took too long to upload",
      });
    }

    let callbackUrl = file.callbackUrl + `?slug=${file.callbackSlug}`;
    if (!callbackUrl.startsWith("http")) callbackUrl = "http://" + callbackUrl;

    yield* Effect.logInfo(
      `SIMULATING FILE UPLOAD WEBHOOK CALLBACK`,
      callbackUrl,
    );

    const payload = JSON.stringify({
      status: "uploaded",
      metadata,
      file: new UploadedFileData({
        url: file.fileUrl,
        key: file.fileKey,
        name: file.fileName,
        size: file.fileSize,
        customId: file.customId,
        type: file.fileType,
      }),
    });

    const signature = yield* Effect.tryPromise({
      try: () => signPayload(payload, apiKey),
      catch: (e) =>
        new UploadThingError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to sign payload",
          cause: e,
        }),
    });

    const callbackResponse = yield* fetchEff(callbackUrl, {
      method: "POST",
      body: payload,
      headers: {
        "Content-Type": "application/json",
        "uploadthing-hook": "callback",
        "x-uploadthing-signature": signature,
      },
    }).pipe(
      Effect.catchTag("FetchError", () =>
        Effect.succeed(new Response(null, { status: 500 })),
      ),
    );

    if (isValidResponse(callbackResponse)) {
      yield* Effect.logInfo(
        "Successfully simulated callback for file",
        presigned.key,
      );
    } else {
      yield* Effect.logError(
        `
Failed to simulate callback for file '${file.fileKey}'. Is your webhook configured correctly?
  - Make sure the URL '${callbackUrl}' is accessible without any authentication. You can verify this by running 'curl -X POST ${callbackUrl}' in your terminal
  - Still facing issues? Read https://docs.uploadthing.com/faq for common issues
`.trim(),
      );
    }
    return file;
  });
};
