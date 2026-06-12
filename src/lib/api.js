export async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'include',
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {}),
    },
    ...options,
  })

  const contentType = response.headers.get('content-type') || ''

  if (!response.ok) {
    let parsedError = ''
    try {
      if (contentType.includes('application/json')) {
        const payload = await response.json()
        parsedError = payload?.error || payload?.message || ''
      } else {
        parsedError = await response.text()
      }
    } catch {
      parsedError = ''
    }

    const normalized = String(parsedError || '').trim().toLowerCase()
    if (response.status === 403 || normalized.includes('request denied')) {
      throw new Error('Upload request was denied by the server. Please retry, and make sure you are using the working app link (with API enabled).')
    }

    throw new Error(parsedError || `Request failed (${response.status})`)
  }

  if (response.status === 204) return null

  if (contentType.includes('application/json')) {
    return response.json()
  }

  throw new Error(
    `API is unavailable on this link (${path}). Please open the app URL that includes backend API support.`
  )
}

export const formatClock = (seconds) => {
  if (!Number.isFinite(seconds)) return '00:00.00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  const centis = Math.floor((seconds - Math.floor(seconds)) * 100)
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centis).padStart(2, '0')}`
}
