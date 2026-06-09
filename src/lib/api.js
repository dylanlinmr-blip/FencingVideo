export async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {}),
    },
    ...options,
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || 'Request failed')
  }

  if (response.status === 204) return null
  return response.json()
}

export const formatClock = (seconds) => {
  if (!Number.isFinite(seconds)) return '00:00.00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  const centis = Math.floor((seconds - Math.floor(seconds)) * 100)
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centis).padStart(2, '0')}`
}
