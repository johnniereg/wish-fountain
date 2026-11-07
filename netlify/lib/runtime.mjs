// Wires the wish service to Netlify's environment and Blobs.
import { getStore } from "@netlify/blobs"
import { createLegacyReader } from "./legacy.mjs"
import { createNotifier } from "./notify.mjs"
import { parseNetworks, parsePhrases } from "./policy.mjs"
import { createWishService } from "./wishes.mjs"

let service
let serviceStoreName

export const getWishService = context => {
  const secret = process.env.WISH_SECRET
  if (!secret) throw new Error("WISH_SECRET is not set")

  // Keeps deploy previews from writing into the production fountain.
  const isProduction = context?.deploy?.context === "production"
  const storeName = isProduction ? "wishes" : "wishes-preview"

  const siteUrl = context?.site?.url || process.env.URL
  if (isProduction && !siteUrl) {
    console.error("No site URL, so wish notifications are off")
  }

  if (!service || serviceStoreName !== storeName) {
    serviceStoreName = storeName
    service = createWishService({
      store: getStore({ name: storeName, consistency: "strong" }),
      fetchLegacy: createLegacyReader({
        apiToken: process.env.NETLIFY_API_TOKEN,
      }),
      secret,
      phrases: parsePhrases(process.env.WISH_BLOCKED_PHRASES),
      networks: parseNetworks(process.env.WISH_BLOCKED_NETWORKS),
      // Previews would email real people, so only production notifies.
      notify: createNotifier({
        siteUrl: isProduction ? siteUrl : null,
      }),
    })
  }
  return service
}
