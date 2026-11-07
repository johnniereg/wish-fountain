// HTTP layer shared by the Netlify functions.
const MAX_BODY_BYTES = 8 * 1024

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    },
  })

const unavailable = error => {
  console.error("Wish request failed:", error.message)
  return json(503, { error: "unavailable" })
}

const isSameOrigin = req => {
  const origin = req.headers.get("origin")
  if (!origin) return false
  try {
    return new URL(origin).host === new URL(req.url).host
  } catch {
    return false
  }
}

const handleSubmit = async (req, ip, service, defer) => {
  if (!isSameOrigin(req)) return json(403, { error: "forbidden" })

  const raw = await req.text()
  if (raw.length > MAX_BODY_BYTES) return json(400, { error: "too_long" })

  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    return json(400, { error: "bad_request" })
  }
  if (!payload || typeof payload !== "object") {
    return json(400, { error: "bad_request" })
  }

  const result = await service.submit(payload, ip, { defer })
  const headers = result.retryAfter
    ? { "Retry-After": String(result.retryAfter) }
    : {}
  return json(result.status, result.body, headers)
}

export const handleWishRequest = async (req, ip, getService, defer) => {
  if (req.method !== "GET" && req.method !== "POST") {
    return json(405, { error: "method_not_allowed" }, { Allow: "GET, POST" })
  }
  try {
    const service = getService()
    if (req.method === "POST") {
      return await handleSubmit(req, ip, service, defer)
    }
    return json(200, { wish: await service.randomWish(ip) })
  } catch (error) {
    return unavailable(error)
  }
}

export const handleTokenRequest = async (req, getService) => {
  if (req.method !== "GET") {
    return json(405, { error: "method_not_allowed" }, { Allow: "GET" })
  }
  try {
    return json(200, { token: getService().createToken() })
  } catch (error) {
    return unavailable(error)
  }
}
