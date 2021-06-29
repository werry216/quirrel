import delay from "delay";
import { runQuirrel } from "./runQuirrel";
import {
  expectToShowAttachingToQuirrel,
  expectToShowJobTable,
} from "./connection-retry.spec";

let cleanup: (() => Promise<void>)[] = [];

beforeEach(() => {
  cleanup = [];
});

afterEach(async () => {
  await Promise.all(cleanup.map((clean) => clean()));
});

it("allows connecting to non-standard ports", async () => {
  const quirrelServer = await runQuirrel({ port: 8000 });
  cleanup.push(quirrelServer.cleanup);

  await page.goto("http://localhost:1234/pending");

  await expectToShowAttachingToQuirrel();

  await page.click("[data-test-id=open-connection-modal]");
  await page.type("[name=endpoint]", "http://localhost:8000");
  await page.click("button[type=submit]");

  await delay(100);

  await expectToShowJobTable();
});
