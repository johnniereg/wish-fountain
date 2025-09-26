import React, { useState, useRef, useEffect } from "react"

import "../styles/components/form.scss"

const Form = ({ isVisible, toggleForm, toggleWish }) => {
  const [state, setState] = useState({})
  const [ipAddress, setIpAddress] = useState(null) // State to store the user's IP address
  const textareaRef = useRef(null)

  // Fetch the user's IP address on component mount
  useEffect(() => {
    fetch("https://api64.ipify.org?format=json") // Use ipify to get the IPv6 address
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

  const handleSubmit = e => {
    e.preventDefault()
    const form = e.target

    // Block submissions from the specific IPv6 prefix
    const blockedPrefix = "2604:3d09:1183:500"
    if (ipAddress && ipAddress.startsWith(blockedPrefix)) {
      // Silently ignore the submission
      return
    }

    if (!state.textarea) {
      hide()
      toggleWish(true)
      setState({}) // Clear the state
      if (textareaRef.current) textareaRef.current.value = "" // Clear the textarea
    } else {
      fetch("/", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: encode({
          "form-name": form.getAttribute("name"),
          ...state,
        }),
      })
        .then(() => {
          hide()
          toggleWish(true)
          setState({}) // Clear the state
          if (textareaRef.current) textareaRef.current.value = "" // Clear the textarea
        })
        .catch(error => alert(error))
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
          <button className="submit" type="submit">
            Submit
          </button>
        </form>
      </div>
    </div>
  )
}

export default Form
