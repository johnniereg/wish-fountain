import assert from "node:assert/strict"
import { test } from "node:test"

import {
  MAX_PER_NETWORK_IN_POOL,
  MAX_TOKEN_AGE_MS,
  MIN_FILL_MS,
  buildPool,
  checkToken,
  createToken,
  hashNetwork,
  isBlockedIp,
  isBlockedText,
  isNearDuplicate,
  networkOf,
  parseIp,
  parseNetworks,
  parsePhrases,
} from "../netlify/lib/policy.mjs"

const SECRET = "test-secret"

test("parseIp handles IPv4, IPv6 shorthand and rejects junk", () => {
  assert.equal(parseIp("1.2.3.4").bits, 32)
  assert.equal(
    parseIp("2001:db8::1").value,
    parseIp("2001:0db8:0:0:0:0:0:1").value
  )
  assert.equal(parseIp("::1").value, 1n)
  for (const junk of [
    "",
    null,
    "1.2.3",
    "999.1.1.1",
    "1:2",
    "1::2::3",
    "zz::1",
  ]) {
    assert.equal(parseIp(junk), null, String(junk))
  }
})

test("IPv4-mapped IPv6 is treated as IPv4", () => {
  assert.equal(networkOf("::ffff:1.2.3.4"), networkOf("1.2.3.99"))
})

test("networkOf groups by /24 and /64", () => {
  assert.equal(networkOf("1.2.3.4"), networkOf("1.2.3.200"))
  assert.notEqual(networkOf("1.2.3.4"), networkOf("1.2.4.4"))
  assert.equal(
    networkOf("2001:db8:1:2:aaaa::1"),
    networkOf("2001:db8:1:2:bbbb::2")
  )
  assert.notEqual(networkOf("2001:db8:1:2::1"), networkOf("2001:db8:1:3::1"))
  assert.equal(networkOf(undefined), "unknown")
})

test("hashNetwork is keyed, stable and never contains the IP", () => {
  const hash = hashNetwork(SECRET, "1.2.3.4")
  assert.equal(hash, hashNetwork(SECRET, "1.2.3.5"))
  assert.notEqual(hash, hashNetwork("other-secret", "1.2.3.4"))
  assert.doesNotMatch(hash, /1\.2\.3/)
})

test("blocked networks match exactly, unlike a string prefix", () => {
  const networks = parseNetworks("2001:db8:1:500::/64, 5.6.7.0/24, 8.8.8.8")
  assert.equal(isBlockedIp("2001:db8:1:500:abcd::1", networks), true)
  // A string prefix of "2001:db8:1:500" would wrongly match this neighbor.
  assert.equal(isBlockedIp("2001:db8:1:5001::1", networks), false)
  assert.equal(isBlockedIp("5.6.7.200", networks), true)
  assert.equal(isBlockedIp("::ffff:5.6.7.200", networks), true)
  assert.equal(isBlockedIp("5.6.8.1", networks), false)
  assert.equal(isBlockedIp("8.8.8.8", networks), true)
  assert.equal(isBlockedIp("8.8.8.9", networks), false)
  assert.equal(isBlockedIp(undefined, networks), false)
})

test("invalid blocked network entries are skipped", () => {
  assert.equal(parseNetworks("nope, 1.2.3.0/99, 1.2.3.4/8/2, ").length, 0)
  assert.equal(parseNetworks(undefined).length, 0)
})

test("blocked phrases survive case, spacing and commas", () => {
  const phrases = parsePhrases("Spam Phrase|and more, because||")
  assert.deepEqual(phrases, ["spam phrase", "and more, because"])
  assert.equal(isBlockedText("buy  SPAM\n phrase now", phrases), true)
  assert.equal(isBlockedText("AND MORE, BECAUSE reasons", phrases), true)
  assert.equal(isBlockedText("an ordinary wish", phrases), false)
})

test("near duplicates catch light rewording but spare short wishes", () => {
  const original =
    "I wish that my cousin would finally win the big lottery this year"
  const reworded =
    "i wish that my cousin would finally win the big lottery this year!!"
  assert.equal(isNearDuplicate(reworded, [original]), true)
  assert.equal(
    isNearDuplicate("I wish for world peace", ["I wish for world peace"]),
    false
  )
  assert.equal(
    isNearDuplicate(
      "I hope the garden grows tall tomatoes during the long summer",
      [original]
    ),
    false
  )
})

test("tokens enforce signature, minimum fill time and expiry", () => {
  const issued = 1_000_000
  const token = createToken(SECRET, issued)
  assert.equal(checkToken(SECRET, token, issued + MIN_FILL_MS - 1), "too_fast")
  assert.equal(checkToken(SECRET, token, issued + MIN_FILL_MS), "ok")
  assert.equal(
    checkToken(SECRET, token, issued + MAX_TOKEN_AGE_MS + 1),
    "expired"
  )
  assert.equal(
    checkToken("other-secret", token, issued + MIN_FILL_MS),
    "invalid"
  )
  assert.equal(checkToken(SECRET, `${token}0`, issued + MIN_FILL_MS), "invalid")
  assert.equal(checkToken(SECRET, "a.b", issued), "invalid")
  assert.equal(checkToken(SECRET, undefined, issued), "invalid")
})

test("a token's timestamp can't be forged", () => {
  const token = createToken(SECRET, 1_000_000)
  const [, nonce, signature] = token.split(".")
  assert.equal(
    checkToken(SECRET, `1.${nonce}.${signature}`, 1_000_000 + MIN_FILL_MS),
    "invalid"
  )
})

test("buildPool filters blocked items, repeats and over-represented networks", () => {
  const options = {
    phrases: ["forbidden"],
    networks: parseNetworks("9.9.9.0/24"),
    secret: SECRET,
  }
  const flood = Array.from({ length: 6 }, (_, i) => ({
    text: `flood wish ${i}`,
    ip: `1.2.3.${i}`,
  }))
  const pool = buildPool(
    [
      ...flood,
      { text: "something forbidden", ip: "4.4.4.4" },
      { text: "from a blocked network", ip: "9.9.9.9" },
      { text: "   ", ip: "5.5.5.5" },
      { text: "a wish with no address" },
    ],
    options
  )
  const texts = pool.map(wish => wish.text)
  assert.equal(
    texts.filter(t => t.startsWith("flood")).length,
    MAX_PER_NETWORK_IN_POOL
  )
  assert.deepEqual(texts.slice(0, 3), [
    "flood wish 0",
    "flood wish 1",
    "flood wish 2",
  ])
  assert.ok(texts.includes("a wish with no address"))
  assert.ok(!texts.some(t => /forbidden|blocked/.test(t)))
})

test("buildPool never retains raw IPs", () => {
  const pool = buildPool([{ text: "hello there", ip: "1.2.3.4" }], {
    phrases: [],
    networks: [],
    secret: SECRET,
  })
  assert.doesNotMatch(JSON.stringify(pool), /1\.2\.3\.4/)
})
