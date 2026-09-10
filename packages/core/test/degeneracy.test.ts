import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectAgreementCascade,
  detectChatter,
  detectRepetition,
  inspect,
  jaccard,
  trigrams,
} from "../dist/index.js";
import { botMessage, humanMessage } from "./helpers.ts";

const healthy = [
  humanMessage("Can one of you work out why the argo sync is stuck?"),
  botMessage(
    "sre",
    "Pulled the app status. `argocd app get payments-api` reports OutOfSync with a hook stuck in Running. The PreSync job payments-migrate has been alive for 41 minutes, which is past its activeDeadlineSeconds of 600, so something is swallowing the timeout.",
    undefined,
    3,
  ),
  botMessage(
    "dev",
    "That migration image was rebuilt yesterday. Did the entrypoint change? If it forks a child and waits on the wrong pid the job never reports completion and Argo will sit on the hook forever.",
    undefined,
    1,
  ),
  botMessage(
    "sre",
    "Checked the layer history: entrypoint moved from `migrate up` to a shell wrapper. That wrapper does not exec, so PID 1 is bash and the SIGTERM never reaches the migrator. Want me to open a PR pinning the previous digest while we fix the wrapper?",
    undefined,
    2,
  ),
];

const degenerate = [
  humanMessage("what do you two think of the plan"),
  botMessage("alpha", "Yes, exactly, I think that plan is a really strong one."),
  botMessage("beta", "Absolutely, I agree, it is a really strong plan."),
  botMessage("alpha", "Totally, well said, a really strong plan indeed."),
];

test("a healthy technical exchange trips nothing", () => {
  assert.deepEqual(inspect(healthy), { kind: "ok" });
});

test("a degenerate exchange trips within four messages", () => {
  const verdict = inspect(degenerate);
  assert.notEqual(verdict.kind, "ok");
});

test("agreement cascade fires when nothing new is introduced", () => {
  const verdict = detectAgreementCascade(degenerate);
  assert.equal(verdict.kind, "decay");
  assert.equal(verdict.detector, "agreementCascade");
});

test("agreement cascade holds fire when a new entity appears", () => {
  const withSubstance = [
    botMessage("alpha", "Yes, exactly, that plan is strong."),
    botMessage("beta", "Absolutely, though `payments-api` still needs a digest pin."),
    botMessage("alpha", "Agreed, strong plan."),
  ];
  assert.equal(detectAgreementCascade(withSubstance).kind, "ok");
});

test("repetition halts on a near-duplicate restatement", () => {
  const messages = [
    botMessage("alpha", "The deployment is blocked on a stuck PreSync hook in Argo."),
    botMessage("beta", "Something else entirely, about DNS resolution and split horizons."),
    botMessage("alpha", "The deployment is blocked on a stuck PreSync hook in Argo!"),
  ];
  const verdict = detectRepetition(messages);
  assert.equal(verdict.kind, "halt");
  assert.equal(verdict.detector, "repetition");
});

test("chatter fires on short toolless statements and not on questions", () => {
  const chatty = [
    botMessage("alpha", "sounds good to me"),
    botMessage("beta", "nice one"),
    botMessage("alpha", "yeah lovely"),
  ];
  assert.equal(detectChatter(chatty).kind, "decay");

  const asking = [
    botMessage("alpha", "sounds good to me"),
    botMessage("beta", "which cluster though?"),
    botMessage("alpha", "yeah lovely"),
  ];
  assert.equal(detectChatter(asking).kind, "ok");
});

test("chatter ignores short messages that used tools", () => {
  const working = [
    botMessage("alpha", "done", undefined, 2),
    botMessage("beta", "same here", undefined, 1),
    botMessage("alpha", "pushed", undefined, 3),
  ];
  assert.equal(detectChatter(working).kind, "ok");
});

test("a human message breaks the trailing bot run", () => {
  const interrupted = [...degenerate.slice(1), humanMessage("hold on, stop agreeing")];
  assert.deepEqual(inspect(interrupted), { kind: "ok" });
});

test("halt outranks decay when both fire", () => {
  const both = [
    botMessage("alpha", "Yes exactly, the plan is strong and good."),
    botMessage("beta", "Absolutely, the plan is strong and good."),
    botMessage("alpha", "Agreed, the plan is strong and good."),
  ];
  assert.equal(inspect(both).kind, "halt");
});

test("jaccard and trigrams behave at the boundaries", () => {
  assert.equal(jaccard(trigrams(""), trigrams("")), 1);
  assert.equal(jaccard(trigrams("abc"), trigrams("")), 0);
  assert.equal(jaccard(trigrams("hello there"), trigrams("hello there")), 1);
});
