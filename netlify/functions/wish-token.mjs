import { handleTokenRequest } from "../lib/handlers.mjs"
import { getWishService } from "../lib/runtime.mjs"

export default (req, context) =>
  handleTokenRequest(req, () => getWishService(context))

export const config = { path: "/api/wish-token" }
