import { SandboxApiError } from "@basetenlabs/sandbox";
import type { TestProject } from "vitest/node";
import {
  E2E_LABELS,
  SHARED_ENVS,
  e2eEnabled,
  sandboxClient,
  uniqueName,
  waitDeployed,
} from "./harness";

declare module "vitest" {
  export interface ProvidedContext {
    /** Name of the sandbox shared by every test file. */
    sandboxName: string;
  }
}

// Creates the sandbox every test file shares, and deletes it after the run.
export default async function setup(project: TestProject): Promise<(() => Promise<void>) | void> {
  if (!e2eEnabled()) return;
  const client = sandboxClient();
  const name = uniqueName();
  project.provide("sandboxName", name);

  // The name is known before creating, so even a partial create is removed.
  // The original error is kept if removing fails too.
  try {
    // TODO: Temporary, to check whether the exec plane's token rejection is
    // specific to the default region.
    await client.create({ name, region: "us-was-1", labels: E2E_LABELS, envs: SHARED_ENVS });
    await waitDeployed(client, name);
  } catch (err) {
    try {
      await client.delete({ name });
    } catch (deleteErr) {
      // A create that never got through leaves nothing to delete.
      if (!(deleteErr instanceof SandboxApiError && deleteErr.status === 404)) {
        console.log(`failed to delete sandbox ${name} after setup failed`, deleteErr);
      }
    }
    throw err;
  }

  // Deleting is checked here, since test files run in parallel and none runs
  // last. A failure here fails the run.
  return async () => {
    if (process.env.BASETEN_E2E_TEST_KEEP_SANDBOX) {
      console.log(`BASETEN_E2E_TEST_KEEP_SANDBOX set; leaving sandbox ${name} in place`);
      return;
    }
    const deleted = await client.delete({ name });
    if (deleted.name !== name || deleted.status !== "DELETING") {
      throw new Error(`deleting sandbox ${name} returned ${deleted.name} as ${deleted.status}`);
    }
  };
}
