import { Job, JobDTO } from "./job";
import * as config from "./config";
import * as z from "zod";
import type { IsExact, AssertTrue } from "conditional-type-checks";
import Encryptor from "secure-e2ee";
import { symmetric, asymmetric } from "secure-webhooks";
import ms from "ms";
import fetch from "cross-fetch";
import type { IncomingHttpHeaders } from "http";
import pack from "../../package.json";
import * as EnhancedJSON from "./enhanced-json";
import { isValidCronExpression } from "../shared/is-valid-cron";
import { isValidTimezone } from "../shared/repeat";

export { Job };

export interface JobMeta
  extends Pick<JobDTO, "id" | "count" | "exclusive" | "retry"> {
  /**
   * If this is a repeated job, the next repetition will be scheduled for this Date.
   */
  readonly nextRepetition?: Date;
}

export type QuirrelJobHandler<T> = (job: T, meta: JobMeta) => Promise<void>;
export type DefaultJobOptions = Pick<EnqueueJobOptions, "exclusive" | "retry">;

interface CreateQuirrelClientArgs<T> {
  route: string;
  handler: QuirrelJobHandler<T>;
  defaultJobOptions?: DefaultJobOptions;
  config?: {
    /**
     * Recommended way to set this: process.env.QUIRREL_BASE_URL
     */
    applicationBaseUrl?: string;

    /**
     * Overrides URL of the Quirrel Endpoint.
     * @default https://api.quirrel.dev or http://localhost:9181
     * Recommended way to set this: process.env.QUIRREL_API_URL
     */
    quirrelBaseUrl?: string;

    /**
     * Bearer Secret for authenticating with Quirrel.
     * Obtain on quirrel.dev or using the API of a self-hosted instance.
     * Recommended way to set this: process.env.QUIRREL_TOKEN
     */
    token?: string;

    /**
     * Secret used for end-to-end encryption.
     * Needs to be 32 characters long.
     * Recommended way to set this: process.env.QUIRREL_ENCRYPTION_SECRET
     */
    encryptionSecret?: string;

    /**
     * Public key used for verifying signatures.
     * Recommended way to set this: process.env.QUIRREL_SIGNATURE_PUBLIC_KEY
     */
    signaturePublicKey?: string;

    /**
     * Old Secrets that have been rotated out.
     * @see https://docs.quirrel.dev/docs/faq#my-encryption-secret-has-been-leaked-what-now
     * Recommended way to set this: process.env.QUIRREL_OLD_SECRETS
     */
    oldSecrets?: string[];
  };

  fetch?: typeof fetch;
  catchDecryptionErrors?: (error: Error) => void;
}

const vercelMs = z
  .string()
  .regex(
    /^(-?(?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i,
    "Please provide a valid time span, according to https://github.com/vercel/ms"
  );

const timeDuration = (fieldName = "duration") =>
  z.union([
    z.number().min(1, { message: `${fieldName} must be positive` }),
    vercelMs,
  ]);

export const cronExpression = z
  .string()
  .refine(
    isValidCronExpression,
    "Please provide a valid Cron expression. See https://github.com/harrisiirak/cron-parser for reference"
  );

export const timezone = z.string().refine(isValidTimezone);

export const cron = z.union([
  cronExpression,
  z.tuple([cronExpression, timezone]),
]);

const EnqueueJobOptionsSchema = z.object({
  id: z.string().optional(),
  exclusive: z.boolean().optional(),
  override: z.boolean().optional(),
  retry: z.array(timeDuration("retry")).min(1).max(10).optional(),
  delay: timeDuration("delay").optional(),
  runAt: z
    .date()
    .refine((date) => Date.now() <= +date, {
      message: "runAt must not be in the past",
    })
    .optional(),
  repeat: z
    .object({
      every: timeDuration("every").optional(),
      times: z.number().nonnegative().optional(),
      cron: cron.optional(),
    })
    .optional(),
});

type EnqueueJobOptionsSchema = z.TypeOf<typeof EnqueueJobOptionsSchema>;

type EnqueueJobOptionssSchemaMatchesDocs = AssertTrue<
  IsExact<EnqueueJobOptions, EnqueueJobOptionsSchema>
>;

/**
 * @deprecated renamed to EnqueueJobOptions
 */
export type EnqueueJobOpts = EnqueueJobOptions;

export interface EnqueueJobOptions {
  /**
   * Can be used to make a job easier to manage.
   * If there's already a job with the same ID, this job will be trashed.
   * @tutorial https://demo.quirrel.dev/managed
   */
  id?: string;

  /**
   * If set to `true`,
   * no other job (on the same queue)
   * will be executed at the same time.
   */
  exclusive?: boolean;

  /**
   * If a job fails, retry it at along the specified intervals.
   * @example ["5min", "1h", "1d"] // retries it after 5 minutes, 1:05 hours, and 1 day 1:05 hours
   */
  retry?: (number | string)[];

  /**
   * Determines what to do when a job
   * with the same ID already exists.
   * false: do nothing (default)
   * true: replace the job
   */
  override?: boolean;

  /**
   * Will delay the job's execution by the specified amount of milliseconds.
   * Supports human-readable notation as of @see https://github.com/vercel/ms.
   * If used together with `repeat`, this will delay the first job to be executed.
   */
  delay?: number | string;

  /**
   * Schedules the job for execution at the specified timestamp.
   */
  runAt?: Date;

  repeat?: {
    /**
     * Will make the job repeat every X milliseconds.
     * Supports human-readable notation as of @see https://github.com/vercel/ms.
     * If `delay` isn't set, the first repetition will be executed immediately.
     */
    every?: number | string;

    /**
     * Can be used in conjunction with @field every and @field cron
     * to limit the number of executions.
     */
    times?: number;

    /**
     * Schedules the job according to the Cron expression.
     * @see https://github.com/harrisiirak/cron-parser for supported syntax
     * If `delay` isn't set, the first repetition will be executed immediately.
     *
     * To specify the timezone, pass a tuple with the IANA timezone in second place.
     * Defaults to Etc/UTC.
     */
    cron?: string | [string, string];
  };
}

function parseDuration(value: number | string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  if (typeof value === "string") {
    return ms(value);
  }

  return value;
}

function runAtToDelay(value: Date) {
  return +value - Date.now();
}

function getEncryptor(
  encryptionSecret: string | undefined,
  oldSecrets: string[] = []
) {
  if (!encryptionSecret) {
    return undefined;
  }

  return new Encryptor(encryptionSecret, [encryptionSecret, ...oldSecrets]);
}

function getAuthHeaders(
  token: string | undefined
): { Authorization: string } | {} {
  if (!token) {
    return {};
  }

  return { Authorization: `Bearer ${token}` };
}

export class QuirrelClient<T> {
  private handler;
  private route;
  private defaultJobOptions;
  private encryptor;
  private defaultHeaders: Record<string, string>;
  private quirrelBaseUrl;
  private baseUrl;
  private token;
  private fetch;
  private catchDecryptionErrors;
  private signaturePublicKey;

  constructor(args: CreateQuirrelClientArgs<T>) {
    this.handler = args.handler;
    this.defaultJobOptions = args.defaultJobOptions;

    const token = args.config?.token ?? config.getQuirrelToken();
    this.defaultHeaders = {
      ...getAuthHeaders(token),
      "X-QuirrelClient-Version": pack.version,
    };

    const quirrelBaseUrl =
      args.config?.quirrelBaseUrl ?? config.getQuirrelBaseUrl();
    const applicationBaseUrl = config.prefixWithProtocol(
      args.config?.applicationBaseUrl ?? config.getApplicationBaseUrl()!
    );
    this.quirrelBaseUrl = quirrelBaseUrl;
    this.baseUrl =
      quirrelBaseUrl +
      "/queues/" +
      encodeURIComponent(applicationBaseUrl + "/" + args.route);
    this.token = args.config?.token ?? config.getQuirrelToken();
    this.route = args.route;
    this.encryptor = getEncryptor(
      args.config?.encryptionSecret ?? config.getEncryptionSecret(),
      args.config?.oldSecrets ?? config.getOldEncryptionSecrets() ?? undefined
    );
    this.catchDecryptionErrors = args.catchDecryptionErrors;
    this.fetch = args.fetch ?? fetch;
    this.signaturePublicKey =
      args.config?.signaturePublicKey ?? config.getSignaturePublicKey();
  }

  async makeRequest(uri: string, init?: RequestInit) {
    return await this.fetch(this.quirrelBaseUrl + uri, {
      credentials: "omit",
      ...init,
      headers: {
        ...this.defaultHeaders,
        ...init?.headers,
      },
    });
  }

  private async payloadAndOptionsToBody(
    payload: T,
    options: EnqueueJobOptionsSchema
  ) {
    if (typeof payload === "undefined") {
      throw new Error("Passing `undefined` as Payload is not allowed");
    }

    if (options.repeat && options.retry?.length) {
      throw new Error("retry and repeat cannot be used together");
    }

    options = EnqueueJobOptionsSchema.parse(options);

    let delay = parseDuration(options.delay);

    if ("runAt" in options && options.runAt) {
      delay = runAtToDelay(options.runAt);
    }

    if (options.repeat) {
      options.repeat.every = parseDuration(options.repeat?.every);
    }

    let stringifiedBody = EnhancedJSON.stringify(payload);

    if (this.encryptor) {
      stringifiedBody = await this.encryptor.encrypt(stringifiedBody);
    }

    let cron = {};
    if (options.repeat?.cron) {
      if (typeof options.repeat.cron === "string") {
        cron = { cron: options.repeat.cron };
      } else {
        cron = {
          cron: options.repeat.cron[0],
          cronTimezone: options.repeat.cron[1],
        };
      }
    }

    return {
      ...this.defaultJobOptions,
      body: stringifiedBody,
      delay,
      id: options.id,
      repeat: options.repeat
        ? {
            ...options.repeat,
            ...cron,
          }
        : undefined,
      retry: options.retry?.map(parseDuration),
      override: options.override,
    };
  }

  /**
   * Enqueue a job to the specified endpoint.
   * @param options job options
   */
  async enqueue(payload: T, options: EnqueueJobOptions = {}): Promise<Job<T>> {
    const body = await this.payloadAndOptionsToBody(payload, options);

    const res = await this.fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.defaultHeaders,
      },
      credentials: "omit",
      body: JSON.stringify(body),
    });

    if (res.status === 201) {
      return await this.toJob(await res.json());
    }

    throw new Error(`Unexpected response: ${await res.text()}`);
  }

  /**
   * Enqueue multiple jobs
   */
  async enqueueMany(
    jobs: { payload: T; options?: EnqueueJobOptions }[]
  ): Promise<Job<T>[]> {
    const body = await Promise.all(
      jobs.map(({ payload, options = {} }) =>
        this.payloadAndOptionsToBody(payload, options)
      )
    );

    const res = await this.fetch(this.baseUrl + "/batch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.defaultHeaders,
      },
      credentials: "omit",
      body: JSON.stringify(body),
    });

    if (res.status === 201) {
      const response = (await res.json()) as any[];
      return await Promise.all(response.map((job) => this.toJob(job)));
    }

    throw new Error(`Unexpected response: ${await res.text()}`);
  }

  private async decryptAndDecodeBody(body: string): Promise<T> {
    if (this.encryptor) {
      if (this.catchDecryptionErrors) {
        try {
          body = await this.encryptor.decrypt(body);
        } catch (error) {
          this.catchDecryptionErrors(error);
          return body as any;
        }
      } else {
        body = await this.encryptor.decrypt(body);
      }
    }

    return EnhancedJSON.parse(body);
  }

  private async toJob(dto: JobDTO): Promise<Job<T>> {
    return {
      ...dto,
      body: await this.decryptAndDecodeBody(dto.body),
      runAt: new Date(dto.runAt),
      delete: () => this.delete(dto.id),
      invoke: () => this.invoke(dto.id),
    };
  }

  /**
   * Iterate through scheduled jobs.
   * @example
   * for await (const jobs of queue.get()) {
   *   // do smth
   * }
   */
  async *get(): AsyncGenerator<Job<T>[]> {
    let cursor: number | null = 0;

    while (cursor !== null) {
      const res = await this.fetch(this.baseUrl + "?cursor=" + cursor, {
        headers: this.defaultHeaders,
      });

      const json = await res.json();

      const { cursor: newCursor, jobs } = json as {
        cursor: number | null;
        jobs: JobDTO[];
      };

      cursor = newCursor;

      yield await Promise.all(jobs.map((dto) => this.toJob(dto)));
    }
  }

  /**
   * Get a specific job.
   * @returns null if no job was found.
   */
  async getById(id: string): Promise<Job<T> | null> {
    const res = await this.fetch(this.baseUrl + "/" + id, {
      headers: this.defaultHeaders,
    });

    if (res.status === 404) {
      return null;
    }

    if (res.status === 200) {
      return await this.toJob(await res.json());
    }

    throw new Error("Unexpected response: " + (await res.text()));
  }

  /**
   * Schedule a job for immediate execution.
   * @returns false if job could not be found.
   */
  async invoke(id: string): Promise<boolean> {
    const res = await this.fetch(this.baseUrl + "/" + id, {
      method: "POST",
      headers: this.defaultHeaders,
    });

    if (res.status === 404) {
      return false;
    }

    if (res.status === 204) {
      return true;
    }

    throw new Error("Unexpected response: " + (await res.text()));
  }

  /**
   * Delete a job, preventing it from executing.
   * @returns false if job could not be found.
   */
  async delete(id: string): Promise<boolean> {
    const res = await this.fetch(this.baseUrl + "/" + id, {
      method: "DELETE",
      headers: this.defaultHeaders,
    });

    if (res.status === 404) {
      return false;
    }

    if (res.status === 204) {
      return true;
    }

    throw new Error("Unexpected response: " + (await res.text()));
  }

  private isValidSignature(body: string, signature: string): boolean {
    if (this.signaturePublicKey) {
      return asymmetric.verify(body, this.signaturePublicKey, signature);
    } else {
      return symmetric.verify(body, this.token!, signature);
    }
  }

  async respondTo(
    body: string,
    headers: IncomingHttpHeaders
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }> {
    if (process.env.NODE_ENV === "production") {
      const signature = headers["x-quirrel-signature"];
      if (typeof signature !== "string") {
        return {
          status: 401,
          headers: {},
          body: "Signature missing",
        };
      }

      if (!this.isValidSignature(body, signature)) {
        return {
          status: 401,
          headers: {},
          body: "Signature invalid",
        };
      }
    }

    const payload = await this.decryptAndDecodeBody(body);
    const { id, count, retry, nextRepetition, exclusive } = JSON.parse(
      (headers["x-quirrel-meta"] as string) ?? "{}"
    );

    console.log(`Received job to ${this.route}: `, payload);

    try {
      await this.handler(payload, {
        id,
        count,
        retry,
        nextRepetition,
        exclusive,
      });

      return {
        status: 200,
        headers: {},
        body: "OK",
      };
    } catch (error) {
      console.error(error);
      return {
        status: 500,
        headers: {},
        body: String(error),
      };
    }
  }
}
