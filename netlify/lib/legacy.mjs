// Reads wishes submitted through Netlify Forms before the move to Blobs.
// Runs only on the server, and raw IPs are dropped once the pool is built.
const API = "https://api.netlify.com/api/v1"
const SITE_ID = "94286650-7f42-4876-a795-167e52313b8f"
const FORM_ID = "628bd98d7a3f3700087883c5"
const PAGE_SIZE = 100
const MAX_PAGES = 3
const REQUEST_TIMEOUT_MS = 3000

export const createLegacyReader = ({ apiToken, fetchImpl = fetch }) => {
  if (!apiToken) return async () => []

  return async () => {
    const wishes = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await fetchImpl(
        `${API}/sites/${SITE_ID}/forms/${FORM_ID}/submissions?per_page=${PAGE_SIZE}&page=${page}`,
        {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            Authorization: `Bearer ${apiToken}`,
            "User-Agent": "wish-fountain",
          },
        }
      )
      if (!response.ok)
        throw new Error(`Netlify API returned ${response.status}`)
      const submissions = await response.json()
      for (const submission of submissions) {
        wishes.push({
          text: submission.data?.textarea || submission.body || "",
          ip: submission.data?.ip,
        })
      }
      if (submissions.length < PAGE_SIZE) break
    }
    return wishes
  }
}
