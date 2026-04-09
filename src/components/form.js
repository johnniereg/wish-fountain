import React, { useState, useRef, useEffect } from "react"

import "../styles/components/form.scss"

const BLOCKED_PREFIXES = ["2604:3d09:1183:500"]
const RATE_LIMIT_KEY = "wf_last_submission"
const RATE_LIMIT_MS = 60 * 60 * 1000 // 1 hour

const Form = ({ isVisible, toggleForm, toggleWish }) => {
  const [state, setState] = useState({})
  const [ipAddress, setIpAddress] = useState(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const textareaRef = useRef(null)

  useEffect(() => {
    fetch("https://api64.ipify.org?format=json")
      .then(response => response.json())
      .then(data => setIpAddress(data.ip))
      .catch(error => console.error("Failed to fetch IP address:", error))
  }, [])

  const handleChange = e => {
    setState({ ...state, [e.target.name]: e.target.value })
  }

  const hide = () => {
    toggleForm(false)
  }

  const encode = data => {
    return Object.keys(data)
      .map(key => encodeURIComponent(key) + "=" + encodeURIComponent(data[key]))
      .join("&")
  }

  const isRateLimited = () => {
    try {
      const last = localStorage.getItem(RATE_LIMIT_KEY)
      if (!last) return false
      return Date.now() - parseInt(last, 10) < RATE_LIMIT_MS
    } catch {
      return false
    }
  }

  const recordSubmission = () => {
    try {
      localStorage.setItem(RATE_LIMIT_KEY, Date.now().toString())
    } catch {}
  }

  const handleSubmit = e => {
    e.preventDefault()

    if (isSubmitting) return

    const form = e.target

    if (ipAddress && BLOCKED_PREFIXES.some(prefix => ipAddress.startsWith(prefix))) {
      return
    }

    if (isRateLimited()) {
      return
    }

    if (!state.textarea) {
      hide()
      toggleWish(true)
      setState({})
      if (textareaRef.current) textareaRef.current.value = ""
    } else {
      setIsSubmitting(true)
      fetch("/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: encode({
          "form-name": form.getAttribute("name"),
          ...state,
        }),
      })
        .then(() => {
          recordSubmission()
          hide()
          toggleWish(true)
          setState({})
          if (textareaRef.current) textareaRef.current.value = ""
        })
        .catch(error => {
          setIsSubmitting(false)
          alert(error)
        })
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
          data-netlify="true"
          data-netlify-honeypot="bot-field"
          onSubmit={handleSubmit}
        >
          <input type="hidden" name="wish-form" value="wish" />
          <label htmlFor="text">Toss your wish into the fountain</label>
          <textarea
            name="textarea"
            onChange={handleChange}
            ref={textareaRef}
          />
          <button className="submit" type="submit" disabled={isSubmitting}>
            Submit
          </button>
        </form>
      </div>
    </div>
  )
}

export default Form
