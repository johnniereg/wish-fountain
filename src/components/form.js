import React, { useState, useRef, useEffect } from "react"

import "../styles/components/form.scss"

const MAX_WISH_LENGTH = 800
// Slightly over the server's minimum, so a quick wish is never dropped as a bot.
const MIN_FILL_MS = 2100

const MESSAGES = {
  rate_limited: "The fountain needs a moment. Try again in about a minute.",
  rate_limited_long:
    "The fountain has had plenty of wishes from here. Please try again later.",
  stale_form: "Something got stale. Please submit your wish again.",
  too_long: `Wishes can be up to ${MAX_WISH_LENGTH} characters.`,
}
const DEFAULT_MESSAGE = "Your wish didn't make it. Please try again."

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const requestToken = async () => {
  const response = await fetch("/api/wish-token")
  if (!response.ok) throw new Error(`Status ${response.status}`)
  const { token } = await response.json()
  return { value: token, receivedAt: Date.now() }
}

const Form = ({ isVisible, toggleForm, toggleWish }) => {
  const [text, setText] = useState("")
  const [honeypot, setHoneypot] = useState("")
  const [error, setError] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)
  const token = useRef(null)

  const refreshToken = () => {
    token.current = null
    const pending = requestToken().then(fresh => {
      if (token.current === null) token.current = fresh
    })
    return pending.catch(() => {})
  }

  useEffect(() => {
    if (isVisible) refreshToken()
  }, [isVisible])

  const finish = () => {
    setText("")
    setHoneypot("")
    setError("")
    toggleForm(false)
    toggleWish(true)
  }

  const handleSubmit = async e => {
    e.preventDefault()
    if (isSubmitting) return

    if (!text.trim()) {
      finish()
      return
    }

    setIsSubmitting(true)
    setError("")
    try {
      if (!token.current) token.current = await requestToken()
      const { value, receivedAt } = token.current
      await wait(receivedAt + MIN_FILL_MS - Date.now())

      const response = await fetch("/api/wish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, token: value, honeypot }),
      })
      if (response.ok) {
        finish()
        return
      }
      const data = await response.json().catch(() => ({}))
      const retryAfter = Number(response.headers.get("Retry-After"))
      const code =
        data.error === "rate_limited" && retryAfter > 120
          ? "rate_limited_long"
          : data.error
      setError(MESSAGES[code] || DEFAULT_MESSAGE)
      if (data.error === "stale_form") refreshToken()
    } catch {
      setError(DEFAULT_MESSAGE)
    } finally {
      setIsSubmitting(false)
    }
  }

  const classes = isVisible ? "form visible" : "form hidden"

  return (
    <div className={classes}>
      <div className="form__wrapper">
        <form
          className="wish-form"
          name="wish-form"
          method="post"
          onSubmit={handleSubmit}
        >
          <div className="wish-form__extra" aria-hidden="true">
            <label>
              Subject
              <input
                type="text"
                name="wish_subject"
                tabIndex={-1}
                autoComplete="off"
                value={honeypot}
                onChange={e => setHoneypot(e.target.value)}
              />
            </label>
          </div>
          <label htmlFor="wish-text">Toss your wish into the fountain</label>
          <textarea
            id="wish-text"
            name="wish"
            maxLength={MAX_WISH_LENGTH}
            value={text}
            onChange={e => setText(e.target.value)}
          />
          {error && (
            <p className="wish-form__error" role="alert">
              {error}
            </p>
          )}
          <button className="submit" type="submit" disabled={isSubmitting}>
            Submit
          </button>
        </form>
      </div>
    </div>
  )
}

export default Form
