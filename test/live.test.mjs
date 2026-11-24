import assert from "node:assert/strict";
import { test } from "node:test";
import { connect, prepare } from "./support.mjs";

test("actual Codex parallel delegation and parent clarification", { timeout: 190_000 }, async (t) => {
  const local = await prepare("/usr/bin/codex");
  t.after(local.cleanup);
  const bridge = await connect(local.config);
  t.after(bridge.close);
  const first = await bridge.call("spawn", {
    workspace: local.repository, role: "explorer",
    task: "This is a bridge integration test. Before doing anything else, call the ask_parent tool with the question 'What is the test token?'. Wait for its tool response. Then make your final response exactly: RECEIVED followed by the literal token. Use no other tools.",
  });
  const group_id = first.group_id;
  const second = await bridge.call("spawn", {
    group_id, workspace: local.repository, role: "reviewer",
    task: "Read readme.txt in the synthetic repository. Final response: return its first sentence and then the word READY.",
  });
  let cursor = 0;
  let foundQuestion = false;
  for (let attempt = 0; attempt < 10; attempt++) {
    const wait = await bridge.call("wait", { group_id, after: cursor, mode: "all_finished", seconds: 12 });
    cursor = wait.cursor;
    const parent = wait.agents.find((item) => item.agent_id === first.agent_id);
    if (parent.question) {
      foundQuestion = true;
      await bridge.call("send", { group_id, agent_id: parent.agent_id, reply_to: parent.question.id, text: "TIANMU-829" });
    }
    if (wait.reason === "all_finished") {
      const peer = wait.agents.find((item) => item.agent_id === second.agent_id);
      assert.equal(parent.status, "completed", JSON.stringify(wait));
      assert.equal(peer.status, "completed", JSON.stringify(wait));
      assert.equal(foundQuestion, true);
      assert.match(parent.result, /RECEIVED\s+TIANMU-829/);
      assert.match(peer.result, /Initial repository.*READY/s);
      return;
    }
  }
  assert.fail("Codex agents did not complete in time");
});
