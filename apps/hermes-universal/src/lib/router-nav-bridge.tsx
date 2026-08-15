import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

import { bindNavigate } from './route-nav'

export function RouterNavBridge() {
  const navigate = useNavigate()
  useEffect(() => {
    bindNavigate(navigate)
  }, [navigate])

  return null
}
