// Passes accepted wishes on to the old Netlify form, so its email
// notifications and dashboard keep working. Only text is sent, and Forms
// records the function's address rather than the visitor's.
const FORM_NAME = "wish-form"
const TIMEOUT_MS = 3000

export const createNotifier = ({ siteUrl, fetchImpl = fetch }) => {
  if (!siteUrl) return async () => {}

  return async text => {
    try {
      const response = await fetchImpl(new URL("/", siteUrl), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        // The empty honeypot passes Netlify's check. Direct-post bots that
        // fill every field are rejected.
        body: new URLSearchParams({
          "form-name": FORM_NAME,
          "bot-field": "",
          textarea: text,
        }),
        // A redirect would turn this into a GET that silently "succeeds".
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`Forms returned ${response.status}`)
    } catch (error) {
      // The wish is already saved, so a missed email shouldn't fail it.
      console.error("Could not send wish notification:", error.message)
    }
  }
}
