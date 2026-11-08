// Tests for the return ticket (src/tickets.ts): a session that released its
// slot at a step boundary keeps a short right to be served at the front of its
// level when it comes back. The module is pure fs; the grant counter and the
// ancestry cache are injected, exactly as the plugin injects them.
// Run: node --test "tests/*.test.ts"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { createReturnTickets } from "../src/tickets.ts"

function setup(options: { ttlMs?: number; grants?: number; rootOf?: (sid: string) => string | undefined } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "turn-lock-tickets-"))
  let now = 1_000_000
  let grants = options.grants ?? 0
  const tickets = createReturnTickets({
    dir,
    ttlMs: options.ttlMs ?? 60_000,
    owner: "test",
    pid: process.pid,
    now: () => now,
    rootOf: options.rootOf,
    readGrants: () => grants,
  })
  return {
    dir,
    tickets,
    advance: (ms: number) => {
      now += ms
    },
    grant: () => {
      grants += 1
    },
    setGrants: (value: number) => {
      grants = value
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test("a written ticket records the release time, the deadline and the grant count", () => {
  const h = setup({ ttlMs: 5_000, grants: 7 })
  try {
    h.tickets.write("ses_a")
    const path = join(h.dir, "ses_a.turn.json")
    assert.equal(existsSync(path), true, "the sidecar exists")
    const raw = JSON.parse(readFileSync(path, "utf8"))
    assert.equal(raw.sid, "ses_a")
    assert.equal(raw.pid, process.pid)
    assert.equal(raw.owner, "test")
    assert.equal(raw.releasedGrants, 7, "the ticket knows how many grants had happened")
    assert.equal(raw.expiresAt - raw.releasedAt, 5_000)

    const ticket = h.tickets.read("ses_a")
    assert.equal(ticket?.sid, "ses_a")
    assert.equal(ticket?.releasedGrants, 7)
  } finally {
    h.cleanup()
  }
})

test("an expired ticket is not a return right and is dropped", () => {
  const h = setup({ ttlMs: 1_000 })
  try {
    h.tickets.write("ses_a")
    h.advance(1_500)
    assert.equal(h.tickets.read("ses_a"), undefined, "an expired ticket reads as nothing")
    assert.equal(existsSync(join(h.dir, "ses_a.turn.json")), false, "and it is cleaned up")
  } finally {
    h.cleanup()
  }
})

test("a ticket written before the expiry field existed is dropped", () => {
  const h = setup()
  try {
    writeFileSync(join(h.dir, "ses_old.turn.json"), JSON.stringify({ sid: "ses_old", pid: process.pid }))
    assert.equal(h.tickets.read("ses_old"), undefined)
    assert.equal(existsSync(join(h.dir, "ses_old.turn.json")), false)
  } finally {
    h.cleanup()
  }
})

test("drop removes the ticket; a second drop is harmless", () => {
  const h = setup()
  try {
    h.tickets.write("ses_a")
    h.tickets.drop("ses_a")
    assert.equal(existsSync(join(h.dir, "ses_a.turn.json")), false)
    h.tickets.drop("ses_a")
  } finally {
    h.cleanup()
  }
})

test("a subagent's ticket lives under its root's name", () => {
  const h = setup({ rootOf: (sid) => (sid === "ses_child" ? "ses_parent" : undefined) })
  try {
    h.tickets.write("ses_child")
    assert.equal(existsSync(join(h.dir, "ses_parent.turn.json")), true, "written under the root")
    assert.equal(existsSync(join(h.dir, "ses_child.turn.json")), false, "not under the child")
    assert.equal(h.tickets.read("ses_child")?.sid, "ses_parent", "the child reads the root's ticket")
    h.tickets.drop("ses_child")
    assert.equal(existsSync(join(h.dir, "ses_parent.turn.json")), false, "dropping from the child drops the root's")
  } finally {
    h.cleanup()
  }
})

test("sweep drops expired tickets and tickets of dead processes, keeps live ones", () => {
  const h = setup({ ttlMs: 10_000 })
  try {
    h.tickets.write("ses_live")
    // a live ticket of another pid
    writeFileSync(
      join(h.dir, "ses_other.turn.json"),
      JSON.stringify({ sid: "ses_other", pid: 4242, releasedAt: 1, expiresAt: 1_000_000 + 10_000, releasedGrants: 0 }),
    )
    // an expired ticket
    writeFileSync(
      join(h.dir, "ses_dead.turn.json"),
      JSON.stringify({ sid: "ses_dead", pid: process.pid, releasedAt: 1, expiresAt: 2, releasedGrants: 0 }),
    )
    // a broken file is not a ticket
    writeFileSync(join(h.dir, "ses_broken.turn.json"), "{not json")

    const removed = h.tickets.sweep((pid) => pid === 4242)
    assert.equal(removed, 2, "the expired and the broken files are removed")
    assert.equal(existsSync(join(h.dir, "ses_live.turn.json")), true)
    assert.equal(existsSync(join(h.dir, "ses_other.turn.json")), true, "a live process keeps its ticket")
    assert.equal(existsSync(join(h.dir, "ses_dead.turn.json")), false)
    assert.equal(existsSync(join(h.dir, "ses_broken.turn.json")), false)

    // Without a liveness oracle, only expiry decides.
    const again = h.tickets.sweep()
    assert.equal(again, 0, "nothing else is swept")
  } finally {
    h.cleanup()
  }
})
