// Wish storage and submission rules, built on an injected blob store.
import { randomUUID } from "node:crypto"
import {
  COOLDOWN_MS,
  MAX_PER_HOUR,
  MAX_WISH_LENGTH,
  buildPool,
  checkToken,
  createToken,
  hashNetwork,
  isBlockedIp,
  isBlockedText,
  isNearDuplicate,
} from "./policy.mjs"

const HOUR_MS = 60 * 60 * 1000
const MEMORY_TTL_MS = 60 * 1000
const SNAPSHOT_TTL_MS = 5 * 60 * 1000
const SNAPSHOT_KEY = "cache/pool"
const MAX_STORED_WISHES = 300
const MAX_TIMESTAMP = 9999999999999

// Zero-padded and inverted, so keys sort newest first.
const wishKey = now =>
  `wish/${String(MAX_TIMESTAMP - now).padStart(13, "0")}-${randomUUID()}`

export const createWishService = ({
  store,
  fetchLegacy,
  secret,
  phrases = [],
  networks = [],
  now = Date.now,
  random = Math.random,
}) => {
  let memory = null

  const readStoredWishes = async () => {
    const { blobs } = await store.list({ prefix: "wish/" })
    const keys = blobs
      .map(blob => blob.key)
      .sort()
      .slice(0, MAX_STORED_WISHES)
    const wishes = []
    for (let i = 0; i < keys.length; i += 25) {
      const batch = keys.slice(i, i + 25)
      const records = await Promise.all(
        batch.map(key => store.get(key, { type: "json" }))
      )
      wishes.push(...records.filter(Boolean))
    }
    return wishes
  }

  // Filters by IP while it's available, then drops it for good.
  const sanitizeLegacy = wishes =>
    wishes
      .filter(wish => !wish.ip || !isBlockedIp(wish.ip, networks))
      .map(wish => ({
        text: wish.text,
        network: wish.ip ? hashNetwork(secret, wish.ip) : null,
      }))

  const rebuildSnapshot = async previous => {
    const stored = await readStoredWishes()
    let legacy
    try {
      legacy = sanitizeLegacy(await fetchLegacy())
    } catch (error) {
      // New wishes must keep appearing, so only the legacy part is reused.
      console.error("Could not read legacy wishes:", error.message)
      legacy = previous?.legacy || []
    }
    const pool = buildPool([...stored, ...legacy], {
      phrases,
      networks,
      secret,
    })
    return { at: now(), pool, legacy }
  }

  const loadPool = async () => {
    const time = now()
    if (memory && time - memory.at < MEMORY_TTL_MS) return memory.pool

    const previous = await store.get(SNAPSHOT_KEY, { type: "json" })
    if (previous && time - previous.at < SNAPSHOT_TTL_MS) {
      memory = { at: time, pool: previous.pool }
      return previous.pool
    }

    const snapshot = await rebuildSnapshot(previous)
    memory = { at: time, pool: snapshot.pool }
    try {
      await store.setJSON(SNAPSHOT_KEY, snapshot)
    } catch (error) {
      // Only a cache: the pool is still good for this request.
      console.error("Could not save wish snapshot:", error.message)
    }
    return snapshot.pool
  }

  const randomWish = async ip => {
    const pool = await loadPool()
    if (!pool.length) return null
    // Prefer someone else's wish: that exchange is the point of the piece.
    const network = hashNetwork(secret, ip)
    const others = pool.filter(wish => wish.network !== network)
    const choices = others.length ? others : pool
    return choices[Math.floor(random() * choices.length)].text
  }

  const readRateLimit = async network => {
    const time = now()
    const record = await store.get(`rate/${network}`, { type: "json" })
    const recent = (record?.at || []).filter(at => time - at < HOUR_MS)
    let waitMs = 0
    if (recent.length) {
      waitMs = Math.max(0, COOLDOWN_MS - (time - Math.max(...recent)))
    }
    if (!waitMs && recent.length >= MAX_PER_HOUR) {
      waitMs = HOUR_MS - (time - Math.min(...recent))
    }
    return { recent, waitMs }
  }

  // A dropped result looks like success, so spammers can't tune against it.
  const dropped = reason => {
    console.log(`Dropped wish submission: ${reason}`)
    return { status: 200, body: { ok: true } }
  }

  const submit = async ({ text, token, honeypot }, ip) => {
    if (honeypot) return dropped("honeypot")

    const wish = typeof text === "string" ? text.trim() : ""
    if (!wish) return { status: 400, body: { error: "empty" } }
    if (wish.length > MAX_WISH_LENGTH) {
      return { status: 400, body: { error: "too_long" } }
    }

    const tokenState = checkToken(secret, token, now())
    if (tokenState === "too_fast") return dropped("too_fast")
    if (tokenState !== "ok")
      return { status: 400, body: { error: "stale_form" } }

    if (isBlockedIp(ip, networks)) return dropped("blocked_network")
    if (isBlockedText(wish, phrases)) return dropped("blocked_text")

    const network = hashNetwork(secret, ip)
    const { recent, waitMs } = await readRateLimit(network)
    if (waitMs > 0) {
      return {
        status: 429,
        body: { error: "rate_limited" },
        retryAfter: Math.ceil(waitMs / 1000),
      }
    }

    const pool = await loadPool()
    if (
      isNearDuplicate(
        wish,
        pool.map(item => item.text)
      )
    ) {
      return dropped("near_duplicate")
    }

    const createdAt = now()
    await store.setJSON(wishKey(createdAt), { text: wish, network, createdAt })
    // Recorded last, so a failed save doesn't count against the visitor.
    await store.setJSON(`rate/${network}`, { at: [...recent, createdAt] })
    return { status: 200, body: { ok: true } }
  }

  return {
    randomWish,
    submit,
    createToken: () => createToken(secret, now()),
  }
}
