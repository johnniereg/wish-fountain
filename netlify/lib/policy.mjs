// Pure spam and privacy rules. No I/O, so everything here is unit-testable.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

export const MAX_WISH_LENGTH = 800
export const MIN_FILL_MS = 2000
export const MAX_TOKEN_AGE_MS = 24 * 60 * 60 * 1000
export const COOLDOWN_MS = 60 * 1000
export const MAX_PER_HOUR = 5
export const MAX_PER_NETWORK_IN_POOL = 3

const DUPLICATE_MIN_LENGTH = 40
const DUPLICATE_MIN_WORDS = 6
const DUPLICATE_THRESHOLD = 0.8

const parseV4 = ip => {
  const parts = ip.split(".")
  if (parts.length !== 4) return null
  let value = 0n
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null
    value = (value << 8n) | BigInt(part)
  }
  return value
}

const parseV6 = input => {
  let ip = input.split("%")[0].toLowerCase()
  const lastColon = ip.lastIndexOf(":")
  if (ip.includes(".")) {
    const v4 = parseV4(ip.slice(lastColon + 1))
    if (v4 === null) return null
    const high = ((v4 >> 16n) & 0xffffn).toString(16)
    const low = (v4 & 0xffffn).toString(16)
    ip = `${ip.slice(0, lastColon + 1)}${high}:${low}`
  }
  const halves = ip.split("::")
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(":") : []
  const tail = halves[1] ? halves[1].split(":") : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const groups = [...head, ...Array(missing).fill("0"), ...tail]
  let value = 0n
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null
    value = (value << 16n) | BigInt(`0x${group}`)
  }
  return value
}

const V4_MAPPED_PREFIX = 0xffffn

/** Parses an address to { bits, value }, unwrapping IPv4-mapped IPv6. Null if invalid. */
export const parseIp = ip => {
  if (typeof ip !== "string" || !ip) return null
  if (!ip.includes(":")) {
    const value = parseV4(ip)
    return value === null ? null : { bits: 32, value }
  }
  const value = parseV6(ip)
  if (value === null) return null
  if (value >> 32n === V4_MAPPED_PREFIX) {
    return { bits: 32, value: value & 0xffffffffn }
  }
  return { bits: 128, value }
}

const hostBits = (bits, prefix) => BigInt(bits - prefix)

/** The network an address belongs to: /24 for IPv4, /64 for IPv6. */
export const networkOf = ip => {
  const parsed = parseIp(ip)
  if (!parsed) return "unknown"
  const prefix = parsed.bits === 32 ? 24 : 64
  const network = parsed.value >> hostBits(parsed.bits, prefix)
  return `${parsed.bits}:${network.toString(16)}`
}

/** A keyed hash of the network, so raw IPs are never stored. */
export const hashNetwork = (secret, ip) =>
  createHmac("sha256", secret)
    .update(`network:${networkOf(ip)}`)
    .digest("hex")
    .slice(0, 32)

/** Parses "a::/64, 1.2.3.0/24, 5.6.7.8" and skips anything invalid. */
export const parseNetworks = raw => {
  const networks = []
  for (const entry of (raw || "").split(",")) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const [address, prefixText, extra] = trimmed.split("/")
    const parsed = parseIp(address)
    const prefix = prefixText === undefined ? parsed?.bits : Number(prefixText)
    const valid =
      parsed &&
      extra === undefined &&
      Number.isInteger(prefix) &&
      prefix >= 0 &&
      prefix <= parsed.bits
    if (!valid) {
      console.warn("Ignoring invalid entry in WISH_BLOCKED_NETWORKS")
      continue
    }
    const shift = hostBits(parsed.bits, prefix)
    networks.push({ bits: parsed.bits, shift, base: parsed.value >> shift })
  }
  return networks
}

export const isBlockedIp = (ip, networks) => {
  const parsed = parseIp(ip)
  if (!parsed) return false
  return networks.some(
    network =>
      network.bits === parsed.bits &&
      parsed.value >> network.shift === network.base
  )
}

export const normalizeText = text =>
  text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()

/** Parses "phrase one|phrase two". Pipes, since phrases can contain commas. */
export const parsePhrases = raw =>
  (raw || "").split("|").map(normalizeText).filter(Boolean)

export const isBlockedText = (text, phrases) => {
  const normalized = normalizeText(text)
  return phrases.some(phrase => normalized.includes(phrase))
}

const wordSet = normalized =>
  new Set(
    normalized
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .split(" ")
      .filter(Boolean)
  )

/** Prepares text for comparison, or null if it's too short to judge fairly. */
const duplicateProfile = text => {
  const normalized = normalizeText(text)
  if (normalized.length < DUPLICATE_MIN_LENGTH) return null
  const words = wordSet(normalized)
  return words.size < DUPLICATE_MIN_WORDS ? null : words
}

const isSimilar = (a, b) => {
  let shared = 0
  for (const word of a) if (b.has(word)) shared++
  return shared / (a.size + b.size - shared) >= DUPLICATE_THRESHOLD
}

/**
 * True when text nearly repeats an existing wish. Short wishes are exempt,
 * since different people can honestly wish for the same simple thing.
 */
export const isNearDuplicate = (text, others) => {
  const profile = duplicateProfile(text)
  if (!profile) return false
  return others.some(other => {
    const otherProfile = duplicateProfile(other)
    return otherProfile !== null && isSimilar(profile, otherProfile)
  })
}

const sign = (secret, payload) =>
  createHmac("sha256", secret).update(`token:${payload}`).digest("hex")

export const createToken = (secret, now) => {
  const payload = `${now}.${randomBytes(9).toString("hex")}`
  return `${payload}.${sign(secret, payload)}`
}

/** Returns "ok", "too_fast", "expired" or "invalid". */
export const checkToken = (secret, token, now) => {
  if (typeof token !== "string") return "invalid"
  const parts = token.split(".")
  if (parts.length !== 3) return "invalid"
  const payload = `${parts[0]}.${parts[1]}`
  const expected = Buffer.from(sign(secret, payload))
  const actual = Buffer.from(parts[2])
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return "invalid"
  }
  const age = now - Number(parts[0])
  if (!Number.isFinite(age)) return "invalid"
  if (age > MAX_TOKEN_AGE_MS) return "expired"
  return age < MIN_FILL_MS ? "too_fast" : "ok"
}

/**
 * Filters candidates, newest first, down to the wishes that may be shown:
 * no blocked content or networks, no near-repeats, and a limit per network.
 */
export const buildPool = (candidates, { phrases, networks, secret }) => {
  const perNetwork = new Map()
  const kept = []
  const keptProfiles = []
  for (const candidate of candidates) {
    const text = (candidate.text || "").trim()
    if (!text || isBlockedText(text, phrases)) continue
    if (candidate.ip && isBlockedIp(candidate.ip, networks)) continue

    const network =
      candidate.network ||
      (candidate.ip ? hashNetwork(secret, candidate.ip) : null)
    if (network && (perNetwork.get(network) || 0) >= MAX_PER_NETWORK_IN_POOL) {
      continue
    }

    const profile = duplicateProfile(text)
    if (profile && keptProfiles.some(other => isSimilar(profile, other)))
      continue

    if (network) perNetwork.set(network, (perNetwork.get(network) || 0) + 1)
    if (profile) keptProfiles.push(profile)
    kept.push({ text, network })
  }
  return kept
}
