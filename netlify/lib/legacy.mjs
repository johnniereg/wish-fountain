// Reads wishes submitted through Netlify Forms before the move to Blobs.
// Runs only on the server, and raw IPs are dropped once the pool is built.
const API = "https://api.netlify.com/api/v1"
const SITE_ID = "94286650-7f42-4876-a795-167e52313b8f"
const FORM_ID = "628bd98d7a3f3700087883c5"
const PAGE_SIZE = 100
const MAX_PAGES = 6
const MAX_WISHES = 300
// Netlify keeps accepting direct posts to the old form, so anything newer than
// the move to Blobs skipped the spam checks and is never shown.
const CUTOFF = Date.parse("2026-11-07T00:00:00Z")
const TOTAL_TIMEOUT_MS = 4000

export const createLegacyReader = ({ apiToken, fetchImpl = fetch }) => {
  if (!apiToken) return async () => []

  return async () => {
    const signal = AbortSignal.timeout(TOTAL_TIMEOUT_MS)
    const wishes = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await fetchImpl(
        `${API}/sites/${SITE_ID}/forms/${FORM_ID}/submissions?per_page=${PAGE_SIZE}&page=${page}`,
        {
          signal,
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
        if (!(Date.parse(submission.created_at) <= CUTOFF)) continue
        wishes.push({
          text: submission.data?.textarea || submission.body || "",
          ip: submission.data?.ip,
        })
      }
      if (submissions.length < PAGE_SIZE || wishes.length >= MAX_WISHES) break
    }
    return wishes
  }
}
