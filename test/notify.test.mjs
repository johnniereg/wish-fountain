import assert from "node:assert/strict"
import { test } from "node:test"

import { createNotifier } from "../netlify/lib/notify.mjs"

test("posts only the wish text to the old form", async () => {
  const calls = []
  const notify = createNotifier({
    siteUrl: "https://wishes.example",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options })
      return { ok: true }
    },
  })
  await notify("a wish & more")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, "https://wishes.example/")
  assert.equal(calls[0].options.method, "POST")
  assert.deepEqual(Object.fromEntries(calls[0].options.body), {
    "form-name": "wish-form",
    textarea: "a wish & more",
  })
})

test("does nothing without a site URL", async () => {
  let called = false
  const notify = createNotifier({
    siteUrl: null,
    fetchImpl: async () => {
      called = true
    },
  })
  await notify("a wish")
  assert.equal(called, false)
})

test("never throws when Forms fails", async () => {
  for (const fetchImpl of [
    async () => ({ ok: false, status: 404 }),
    async () => {
      throw new Error("network down")
    },
  ]) {
    await createNotifier({ siteUrl: "https://wishes.example", fetchImpl })(
      "a wish"
    )
  }
})
