import { QuirrelClient } from "..";
import { run } from "../../api/test/runQuirrel";
import http from "http";
import type { AddressInfo } from "net";
import { getAddress, waitUntil } from "./util";

export function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

test("exclusive (repro #717)", async () => {
  const server = await run("Mock");

  const endpoint = http
    .createServer((req, res) => {
      let body = "";
      req.on("data", (data) => {
        body += data;
      });
      req.on("end", () => {
        quirrel.respondTo(body, req.headers).then(({ status, body }) => {
          res.write(body);
          res.statusCode === status;
          res.end();
        });
      });
    })
    .listen(0);

  const { port } = endpoint.address() as AddressInfo;

  const log: string[] = [];
  const quirrel = new QuirrelClient({
    route: "",
    async handler(payload: number) {
      log.push("started " + payload);
      await sleep(100);
      log.push("finished " + payload);
    },
    config: {
      quirrelBaseUrl: getAddress(server.server),
      encryptionSecret: "4ws8syoOgeQX6WFvXuUneGNwy7QvLxpk",
      applicationBaseUrl: `http://localhost:${port}`,
    },
  });

  const inFiftyMS = new Date(Date.now() + 100);
  for (let i = 0; i < 3; i++) {
    await quirrel.enqueue(i, {
      exclusive: true,
      runAt: inFiftyMS,
    });
  }

  await waitUntil(() => log.length === 6, 1000);
  expect(log).toEqual([
    "started 2",
    "finished 2",

    "started 1",
    "finished 1",

    "started 0",
    "finished 0",
  ]);

  server.teardown();
  endpoint.close();
});
