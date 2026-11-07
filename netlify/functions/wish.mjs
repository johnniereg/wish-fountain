import { handleWishRequest } from "../lib/handlers.mjs"
import { getWishService } from "../lib/runtime.mjs"

export default (req, context) =>
  handleWishRequest(
    req,
    context.ip,
    () => getWishService(context),
    context.waitUntil ? promise => context.waitUntil(promise) : undefined
  )

export const config = { path: "/api/wish" }
