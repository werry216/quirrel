import type { Redis } from "ioredis";
import { POSTQueuesEndpointBody } from "./types/queues/POST/body";
import {
  encodeQueueDescriptor,
  decodeQueueDescriptor,
} from "../shared/http-job";

import * as uuid from "uuid";
import { createOwl, cron } from "../shared/owl";
import type { Job } from "@quirrel/owl";

interface PaginationOpts {
  cursor: number;
  count?: number;
}

interface JobDTO {
  id: string;
  endpoint: string;
  body: string;
  runAt: string;
  repeat?: {
    every?: number;
    times?: number;
    count: number;
    cron?: string;
  };
}

export class JobsRepo {
  protected owl;
  protected producer;

  constructor(redisFactory: () => Redis) {
    this.owl = createOwl(redisFactory);
    this.producer = this.owl.createProducer();
  }

  private static toJobDTO(job: Job<"every" | "cron">): JobDTO {
    const { endpoint } = decodeQueueDescriptor(job.queue);

    return {
      id: job.id,
      endpoint,
      body: job.payload,
      runAt: job.runAt.toISOString(),
      repeat: job.schedule
        ? {
            count: job.count,
            cron: job.schedule?.type === "cron" ? job.schedule.meta : undefined,
            every:
              job.schedule?.type === "every" ? +job.schedule.meta : undefined,
            times: job.schedule.times,
          }
        : undefined,
    };
  }

  public async close() {
    await this.producer.close();
  }

  public async find(
    byTokenId: string,
    endpoint: string,
    { count, cursor }: PaginationOpts
  ) {
    const { newCursor, jobs } = await this.producer.scanQueue(
      encodeQueueDescriptor(byTokenId, endpoint),
      cursor,
      count
    );

    return {
      cursor: newCursor,
      jobs: jobs.map(JobsRepo.toJobDTO),
    };
  }

  public async findByTokenId(
    byTokenId: string,
    { count, cursor }: PaginationOpts
  ) {
    const { newCursor, jobs } = await this.producer.scanQueuePattern(
      encodeQueueDescriptor(byTokenId, "*"),
      cursor,
      count
    );

    return {
      cursor: newCursor,
      jobs: jobs.map(JobsRepo.toJobDTO),
    };
  }

  public async findById(tokenId: string, endpoint: string, id: string) {
    const job = await this.producer.findById(
      encodeQueueDescriptor(tokenId, endpoint),
      id
    );
    return job ? JobsRepo.toJobDTO(job) : undefined;
  }

  public async invoke(tokenId: string, endpoint: string, id: string) {
    return await this.producer.invoke(
      encodeQueueDescriptor(tokenId, endpoint),
      id
    );
  }

  public async delete(tokenId: string, endpoint: string, id: string) {
    return await this.producer.delete(
      encodeQueueDescriptor(tokenId, endpoint),
      id
    );
  }

  public async enqueue(
    tokenId: string,
    endpoint: string,
    {
      body,
      runAt: runAtOption,
      id,
      delay,
      repeat,
      override,
    }: POSTQueuesEndpointBody
  ) {
    if (typeof id === "undefined") {
      id = uuid.v4();
    }

    let runAt: Date | undefined = undefined;

    if (runAtOption) {
      runAt = new Date(runAtOption);
    } else if (delay) {
      runAt = new Date(Date.now() + delay);
    }

    if (repeat?.cron) {
      runAt = cron(runAt ?? new Date(), repeat.cron);
    }

    if (repeat?.every) {
      runAt = new Date();
    }

    if (typeof repeat?.times === "number" && repeat.times < 1) {
      return;
    }

    let schedule_type: "every" | "cron" | undefined = undefined;
    let schedule_meta: string | undefined = undefined;

    if (repeat?.cron) {
      schedule_type = "cron";
      schedule_meta = repeat.cron;
    }

    if (repeat?.every) {
      schedule_type = "every";
      schedule_meta = "" + repeat.every;
    }

    const createdJob = await this.producer.enqueue({
      queue: encodeQueueDescriptor(tokenId, endpoint),
      id,
      payload: body ?? "",
      runAt,
      schedule: schedule_type
        ? {
            type: schedule_type,
            meta: schedule_meta!,
            times: repeat?.times,
          }
        : undefined,
      override,
    });

    return JobsRepo.toJobDTO(createdJob);
  }

  public onEvent(
    requesterTokenId: string,
    cb: (
      event: string,
      job: { endpoint: string; id: string; runAt?: string } | JobDTO
    ) => void
  ) {
    const activity = this.owl.createActivity(
      async (event) => {
        if (event.type === "scheduled") {
          cb(
            "scheduled",
            JobsRepo.toJobDTO(event.job as Job<"every" | "cron">)
          );
          return;
        }

        const { endpoint } = decodeQueueDescriptor(event.queue);

        switch (event.type) {
          case "acknowledged":
            cb("completed", { endpoint, id: event.id });
            break;
          case "requested":
            cb("started", { endpoint, id: event.id });
            break;
          case "invoked":
            cb("invoked", { endpoint, id: event.id });
            break;
          case "rescheduled":
            cb("rescheduled", {
              endpoint,
              id: event.id,
              runAt: event.runAt.toISOString(),
            });
            break;
          case "deleted":
            cb("deleted", { endpoint, id: event.id });
            break;
        }
      },
      {
        queue: encodeQueueDescriptor(requesterTokenId, "*"),
      }
    );

    return () => activity.close();
  }
}
