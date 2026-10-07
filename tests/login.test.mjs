import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLoginEmail, TEAM_USERNAMES } from "../src/lib/login.mjs";

test("team usernames and names with accents resolve to provisioned accounts", () => {
  for (const name of TEAM_USERNAMES)
    assert.equal(resolveLoginEmail(name), `${name}@control-trabajos.invalid`);
  assert.equal(resolveLoginEmail(" Andrés "), "andres@control-trabajos.invalid");
  assert.equal(resolveLoginEmail("NICOLE"), "nicole@control-trabajos.invalid");
});
test("existing email accounts still work and unknown usernames fail clearly", () => {
  assert.equal(resolveLoginEmail(" Person@example.com "), "person@example.com");
  assert.throws(() => resolveLoginEmail("otra"), /usuario del equipo/);
  assert.throws(() => resolveLoginEmail(""), /usuario del equipo/);
});
