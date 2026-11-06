import * as React from "react"
import { useState, useEffect } from "react"

import "../styles/components/wishes.scss"

const NO_WISHES = "No one has made a wish... yet..."
const UNAVAILABLE = "The fountain is quiet right now. Try again soon."

const Wishes = ({ isVisible, toggleVisibility }) => {
  const [wish, setWish] = useState("")

  useEffect(() => {
    if (!isVisible) return undefined

    let isCurrent = true
    setWish("")
    fetch("/api/wish")
      .then(response => {
        if (!response.ok) throw new Error(`Status ${response.status}`)
        return response.json()
      })
      .then(data => {
        if (isCurrent) setWish(data.wish || NO_WISHES)
      })
      .catch(() => {
        if (isCurrent) setWish(UNAVAILABLE)
      })

    return () => {
      isCurrent = false
    }
  }, [isVisible])

  return (
    <div className={`wishes ${isVisible ? "visible" : "hidden"}`}>
      <div className="wishes__wrapper">
        <div className="wishes__text">
          <p>{wish}</p>
        </div>
        <button
          className="wishes__close"
          onClick={() => toggleVisibility(false)}
        >
          X
        </button>
      </div>
    </div>
  )
}

export default Wishes
