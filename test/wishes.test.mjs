import assert from "node:assert/strict"
import { test } from "node:test"

import {
  handleTokenRequest,
  handleWishRequest,
} from "../netlify/lib/handlers.mjs"
import { createLegacyReader } from "../netlify/lib/legacy.mjs"
import {
  MAX_WISH_LENGTH,
  MIN_FILL_MS,
  parseNetworks,
} from "../netlify/lib/policy.mjs"
import { createWishService } from "../netlify/lib/wishes.mjs"

const SECRET = "test-secret"
const ORIGIN = "https://wishes.example"
const IP = "1.2.3.4"

const createStore = () => {
  const data = new Map()
  return {
    data,
    list: async ({ prefix }) => ({
      blobs: [...data.keys()]
        .filter(key => key.startsWith(prefix))
        .map(key => ({ key })),
    }),
    get: async key => (data.has(key) ? structuredClone(data.get(key)) : null),
    setJSON: async (key, value) => {
      data.set(key, structuredClone(value))
    },
  }
}

const setup = (overrides = {}) => {
  const clock = { time: 10_000_000 }
  const store = createStore()
  const service = createWishService({
    store,
    fetchLegacy: async () => [],
    secret: SECRET,
    phrases: ["forbidden phrase"],
    networks: parseNetworks("9.9.9.0/24"),
    now: () => clock.time,
    random: () => 0,
    ...overrides,
  })
  const wishes = () =>
    [...store.data.keys()].filter(key => key.startsWith("wish/"))

  const submit = async (fields, ip = IP) => {
    const token = service.createToken()
    clock.time += MIN_FILL_MS
    return service.submit({ token, ...fields }, ip)
  }
  return { clock, store, service, wishes, submit }
}

const post = (body, { origin = ORIGIN } = {}) =>
  new Request(`${ORIGIN}/api/wish`, {
    method: "POST",
    headers: origin ? { Origin: origin } : {},
    body: typeof body === "string" ? body : JSON.stringify(body),
  })

test("an accepted wish is stored without the raw IP", async () => {
  const { submit, wishes, store } = setup()
  const result = await submit({ text: "  a real wish  " })
  assert.equal(result.status, 200)
  assert.equal(wishes().length, 1)
  const stored = store.data.get(wishes()[0])
  assert.equal(stored.text, "a real wish")
  assert.doesNotMatch(JSON.stringify([...store.data]), /1\.2\.3\.4/)
})

test("spam signals look like success but store nothing", async () => {
  const cases = [
    { fields: { text: "bot wish", honeypot: "filled" } },
    { fields: { text: "this has a Forbidden  Phrase in it" } },
    { fields: { text: "from a blocked network" }, ip: "9.9.9.9" },
  ]
  for (const { fields, ip } of cases) {
    const { submit, wishes } = setup()
    const result = await submit(fields, ip)
    assert.deepEqual(result, { status: 200, body: { ok: true } })
    assert.equal(wishes().length, 0)
  }
})

test("a submission faster than a person could type is dropped", async () => {
  const { service, wishes } = setup()
  const result = await service.submit(
    { text: "too fast", token: service.createToken() },
    IP
  )
  assert.equal(result.status, 200)
  assert.equal(wishes().length, 0)
})

test("an invalid token asks the client to retry", async () => {
  const { service, wishes } = setup()
  const result = await service.submit({ text: "wish", token: "nope" }, IP)
  assert.equal(result.status, 400)
  assert.equal(result.body.error, "stale_form")
  assert.equal(wishes().length, 0)
})

test("empty and oversized wishes are rejected", async () => {
  const { submit, wishes } = setup()
  assert.equal((await submit({ text: "   " })).body.error, "empty")
  assert.equal((await submit({ text: 123 })).body.error, "empty")
  assert.equal(
    (await submit({ text: "x".repeat(MAX_WISH_LENGTH + 1) })).body.error,
    "too_long"
  )
  assert.equal(wishes().length, 0)
})

test("a wish at the length cap is accepted", async () => {
  const { submit, wishes } = setup()
  assert.equal(
    (await submit({ text: "x".repeat(MAX_WISH_LENGTH) })).status,
    200
  )
  assert.equal(wishes().length, 1)
})

test("rate limits apply per network, and cooldowns expire", async () => {
  const { submit, wishes, clock } = setup()
  assert.equal((await submit({ text: "first wish" })).status, 200)

  const limited = await submit({ text: "second wish" }, "1.2.3.200")
  assert.equal(limited.status, 429)
  assert.ok(limited.retryAfter > 0 && limited.retryAfter <= 60)

  assert.equal((await submit({ text: "someone else" }, "7.7.7.7")).status, 200)

  clock.time += 61_000
  assert.equal((await submit({ text: "second wish" })).status, 200)
  assert.equal(wishes().length, 3)
})

test("a network is capped at five wishes an hour", async () => {
  const { submit, wishes, clock } = setup()
  for (let i = 0; i < 5; i++) {
    assert.equal((await submit({ text: `wish number ${i}` })).status, 200)
    clock.time += 61_000
  }
  assert.equal((await submit({ text: "one too many" })).status, 429)
  assert.equal(wishes().length, 5)
  clock.time += 60 * 60 * 1000
  assert.equal((await submit({ text: "much later" })).status, 200)
})

test("a near-repeat from a new address is dropped", async () => {
  const text =
    "I wish that my cousin would finally win the big lottery this year"
  const { submit, wishes, clock } = setup()
  await submit({ text })
  clock.time += 6 * 60 * 1000
  const result = await submit({ text: `${text}!` }, "7.7.7.7")
  assert.equal(result.status, 200)
  assert.equal(wishes().length, 1)
})

test("randomWish prefers someone else's wish and falls back to any", async () => {
  const { submit, service, clock } = setup()
  assert.equal(await service.randomWish(IP), null)

  await submit({ text: "my own wish" })
  clock.time += 6 * 60 * 1000
  assert.equal(await service.randomWish(IP), "my own wish")

  await submit({ text: "a stranger's wish" }, "7.7.7.7")
  clock.time += 6 * 60 * 1000
  assert.equal(await service.randomWish(IP), "a stranger's wish")
})

test("wishes merge legacy records and filter them", async () => {
  const { service } = setup({
    fetchLegacy: async () => [
      { text: "an old wish", ip: "4.4.4.4" },
      { text: "old forbidden phrase", ip: "4.4.4.5" },
      { text: "old blocked network", ip: "9.9.9.1" },
    ],
  })
  assert.equal(await service.randomWish(IP), "an old wish")
})

test("the pool is served from cache until it goes stale", async () => {
  const { service, store, clock } = setup()
  let lists = 0
  const list = store.list
  store.list = async options => {
    lists++
    return list(options)
  }
  await service.randomWish(IP)
  await service.randomWish(IP)
  clock.time += 2 * 60 * 1000
  await service.randomWish(IP)
  assert.equal(lists, 1)
  clock.time += 4 * 60 * 1000
  await service.randomWish(IP)
  assert.equal(lists, 2)
})

test("a legacy outage keeps the last good pool", async () => {
  let healthy = true
  const { service, clock, store } = setup({
    fetchLegacy: async () => {
      if (!healthy) throw new Error("down")
      return [{ text: "an old wish", ip: "4.4.4.4" }]
    },
  })
  await service.randomWish(IP)
  healthy = false
  clock.time += 6 * 60 * 1000
  assert.equal(await service.randomWish(IP), "an old wish")
  assert.equal(store.data.get("cache/pool").pool.length, 1)
})

test("a legacy outage doesn't freeze the pool", async () => {
  let healthy = true
  const { submit, service, clock, store } = setup({
    fetchLegacy: async () => {
      if (!healthy) throw new Error("down")
      return [{ text: "an old wish", ip: "4.4.4.4" }]
    },
  })
  await service.randomWish(IP)
  healthy = false
  await submit({ text: "a newer wish" }, "7.7.7.7")
  clock.time += 6 * 60 * 1000
  await service.randomWish(IP)
  const texts = store.data.get("cache/pool").pool.map(wish => wish.text)
  assert.deepEqual(texts, ["a newer wish", "an old wish"])
})

test("legacy IPs never reach the snapshot", async () => {
  const { service, store } = setup({
    fetchLegacy: async () => [{ text: "an old wish", ip: "4.4.4.4" }],
  })
  await service.randomWish(IP)
  assert.doesNotMatch(
    JSON.stringify(store.data.get("cache/pool")),
    /4\.4\.4\.4/
  )
})

test("a failed save doesn't use up the rate limit", async () => {
  const { submit, store, wishes } = setup()
  const original = store.setJSON
  store.setJSON = async (key, value) => {
    if (key.startsWith("wish/")) throw new Error("write failed")
    return original(key, value)
  }
  await assert.rejects(submit({ text: "a wish" }))
  store.setJSON = original
  assert.equal((await submit({ text: "a wish" })).status, 200)
  assert.equal(wishes().length, 1)
})

test("a failed snapshot save still serves the wish", async () => {
  const { service, store } = setup({
    fetchLegacy: async () => [{ text: "an old wish", ip: "4.4.4.4" }],
  })
  store.setJSON = async () => {
    throw new Error("write failed")
  }
  assert.equal(await service.randomWish(IP), "an old wish")
})

test("a legacy outage with no snapshot still serves new wishes", async () => {
  const { submit, service, clock } = setup({
    fetchLegacy: async () => {
      throw new Error("down")
    },
  })
  await submit({ text: "a new wish" }, "7.7.7.7")
  clock.time += 6 * 60 * 1000
  assert.equal(await service.randomWish(IP), "a new wish")
})

test("GET returns only wish text, with no personal data", async () => {
  const { service } = setup({
    fetchLegacy: async () => [{ text: "an old wish", ip: "4.4.4.4" }],
  })
  const response = await handleWishRequest(
    new Request(`${ORIGIN}/api/wish`),
    IP,
    () => service
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("cache-control"), "no-store")
  assert.deepEqual(await response.json(), { wish: "an old wish" })
})

test("POST rejects cross-origin and missing origins", async () => {
  const { service, wishes, clock } = setup()
  const token = service.createToken()
  clock.time += MIN_FILL_MS
  for (const origin of ["https://evil.example", null, "not a url"]) {
    const response = await handleWishRequest(
      post({ text: "hi", token }, { origin }),
      IP,
      () => service
    )
    assert.equal(response.status, 403)
  }
  assert.equal(wishes().length, 0)
})

test("POST handles malformed and oversized bodies", async () => {
  const { service } = setup()
  const call = body => handleWishRequest(post(body), IP, () => service)
  assert.equal((await call("{nope")).status, 400)
  assert.equal((await call("null")).status, 400)
  assert.equal((await call("x".repeat(9000))).status, 400)
})

test("POST end to end stores a wish and sets Retry-After when limited", async () => {
  const { service, wishes, clock } = setup()
  const tokenResponse = await handleTokenRequest(
    new Request(`${ORIGIN}/api/wish-token`),
    () => service
  )
  const { token } = await tokenResponse.json()
  clock.time += MIN_FILL_MS
  const send = () =>
    handleWishRequest(post({ text: "a wish", token }), IP, () => service)
  assert.equal((await send()).status, 200)
  assert.equal(wishes().length, 1)
  const limited = await send()
  assert.equal(limited.status, 429)
  assert.ok(Number(limited.headers.get("retry-after")) > 0)
})

test("unsupported methods and missing configuration are handled", async () => {
  const broken = () => {
    throw new Error("WISH_SECRET is not set")
  }
  const url = `${ORIGIN}/api/wish`
  assert.equal(
    (await handleWishRequest(new Request(url, { method: "PUT" }), IP, broken))
      .status,
    405
  )
  assert.equal(
    (await handleWishRequest(new Request(url), IP, broken)).status,
    503
  )
  assert.equal((await handleTokenRequest(new Request(url), broken)).status, 503)
  assert.equal(
    (await handleTokenRequest(new Request(url, { method: "POST" }), broken))
      .status,
    405
  )
})

test("the legacy reader ignores posts made after the move to Blobs", async () => {
  const submission = (created_at, textarea) => ({
    created_at,
    data: { textarea, ip: "1.1.1.1" },
  })
  const read = createLegacyReader({
    apiToken: "t",
    fetchImpl: async () => ({
      ok: true,
      json: async () => [
        submission("2027-01-01T00:00:00.000Z", "direct post"),
        submission(undefined, "no date"),
        submission("2026-01-01T00:00:00.000Z", "real old wish"),
      ],
    }),
  })
  assert.deepEqual(
    (await read()).map(wish => wish.text),
    ["real old wish"]
  )
})

test("the legacy reader skips past newer posts to find older wishes", async () => {
  let calls = 0
  const newer = Array.from({ length: 100 }, () => ({
    created_at: "2027-01-01T00:00:00.000Z",
    data: { textarea: "direct post" },
  }))
  const older = [
    {
      created_at: "2026-01-01T00:00:00.000Z",
      data: { textarea: "real old wish" },
    },
  ]
  const read = createLegacyReader({
    apiToken: "t",
    fetchImpl: async () => ({
      ok: true,
      json: async () => (++calls === 1 ? newer : older),
    }),
  })
  assert.deepEqual(
    (await read()).map(wish => wish.text),
    ["real old wish"]
  )
})

test("the legacy reader stops once it has enough wishes", async () => {
  let calls = 0
  const full = Array.from({ length: 100 }, (_, i) => ({
    created_at: "2026-01-01T00:00:00.000Z",
    data: { textarea: `wish ${i}` },
  }))
  const read = createLegacyReader({
    apiToken: "t",
    fetchImpl: async () => {
      calls++
      return { ok: true, json: async () => full }
    },
  })
  assert.equal((await read()).length, 300)
  assert.equal(calls, 3)
})

test("the legacy reader pages through submissions and reports failures", async () => {
  const requests = []
  const page = count =>
    Array.from({ length: count }, (_, i) => ({
      created_at: "2026-01-01T00:00:00.000Z",
      data: { textarea: `wish ${i}`, ip: "1.1.1.1" },
    }))
  const responses = [page(100), page(2)]
  const read = createLegacyReader({
    apiToken: "t",
    fetchImpl: async (url, options) => {
      requests.push({ url, auth: options.headers.Authorization })
      return { ok: true, json: async () => responses.shift() }
    },
  })
  const wishes = await read()
  assert.equal(wishes.length, 102)
  assert.equal(requests.length, 2)
  assert.match(requests[1].url, /page=2/)
  assert.equal(requests[0].auth, "Bearer t")

  assert.deepEqual(await createLegacyReader({})(), [])

  const failing = createLegacyReader({
    apiToken: "t",
    fetchImpl: async () => ({ ok: false, status: 401 }),
  })
  await assert.rejects(failing, /401/)
})

test("accepted wishes are passed on for notifications", async () => {
  const sent = []
  const { submit } = setup({ notify: async text => sent.push(text) })
  await submit({ text: "  a real wish  " })
  await submit({ text: "bot wish", honeypot: "x" }, "7.7.7.7")
  await submit({ text: "this has a forbidden phrase" }, "8.8.8.8")
  await submit({ text: "too soon" })
  assert.deepEqual(sent, ["a real wish"])
})

test("older wishes are read once and archived", async () => {
  let calls = 0
  const { service, store, clock } = setup({
    fetchLegacy: async () => {
      calls++
      return [{ text: "an old wish", ip: "4.4.4.4" }]
    },
  })
  assert.equal(await service.randomWish(IP), "an old wish")
  clock.time += 6 * 60 * 1000
  assert.equal(await service.randomWish(IP), "an old wish")
  assert.equal(calls, 1)
  assert.doesNotMatch(
    JSON.stringify(store.data.get("legacy/archive")),
    /4\.4\.4\.4/
  )
})

test("an empty legacy read isn't archived", async () => {
  let calls = 0
  const { service, clock, store } = setup({
    fetchLegacy: async () => {
      calls++
      return []
    },
  })
  await service.randomWish(IP)
  clock.time += 6 * 60 * 1000
  await service.randomWish(IP)
  assert.equal(calls, 2)
  assert.equal(store.data.has("legacy/archive"), false)
})
