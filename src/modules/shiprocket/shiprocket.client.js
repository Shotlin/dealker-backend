const BASE_URL = 'https://apiv2.shiprocket.in/v1/external'
const TIMEOUT_MS = 10000

export class ShiprocketError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

/**
 * Thin Shiprocket HTTP client. Tokens are cached in-process per email
 * (Shiprocket tokens live ~10 days); a 401 triggers one re-login.
 */
export class ShiprocketClient {
  constructor(credentials, fetchImpl = globalThis.fetch) {
    this.credentials = credentials
    this.fetch = fetchImpl
    this.token = null
  }

  async #call(path, { method = 'GET', body, token } = {}) {
    const res = await this.fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
    // Shiprocket sometimes answers HTTP 200 with a failure body ({status_code:422, message, errors}).
    const bodyCode = Number(data?.status_code)
    if (!res.ok || (Number.isFinite(bodyCode) && bodyCode >= 400)) {
      const details = data?.errors
        ? ` (${Object.entries(data.errors).map(([k, v]) => `${k}: ${[].concat(v).join(', ')}`).join('; ')})`
        : ''
      throw new ShiprocketError(
        `${data?.message || `Shiprocket responded ${res.status}`}${details}`,
        res.ok ? bodyCode : res.status
      )
    }
    return data
  }

  async login() {
    const data = await this.#call('/auth/login', {
      method: 'POST',
      body: { email: this.credentials.email, password: this.credentials.password },
    })
    if (!data?.token) throw new ShiprocketError('Shiprocket login returned no token', 502)
    this.token = data.token
    return this.token
  }

  async request(path, opts = {}) {
    if (!this.token) await this.login()
    try {
      return await this.#call(path, { ...opts, token: this.token })
    } catch (err) {
      if (err.status !== 401) throw err
      await this.login()
      return this.#call(path, { ...opts, token: this.token })
    }
  }

  /** Pickup addresses configured in the Shiprocket panel (needs the Settings module). */
  async listPickupLocations() {
    const data = await this.request('/settings/company/pickup')
    return data?.data?.shipping_address || []
  }

  /** Quick (hyperlocal) availability + rate between two coordinates. */
  async checkQuick({ pickupPostcode, deliveryPostcode, fromLat, fromLng, toLat, toLng, cod = 0 }) {
    const qs = new URLSearchParams({
      pickup_postcode: String(pickupPostcode),
      delivery_postcode: String(deliveryPostcode),
      cod: String(cod),
      weight: '2',
      is_new_hyperlocal: '1',
      lat_from: String(fromLat),
      long_from: String(fromLng),
      lat_to: String(toLat),
      long_to: String(toLng),
    })
    const data = await this.request(`/courier/serviceability/?${qs}`)
    const list = data?.data?.available_courier_companies || data?.data || []
    return Array.isArray(list) ? list : []
  }

  createQuickOrder(payload) {
    return this.request('/orders/create/adhoc', { method: 'POST', body: payload })
  }

  assignAwb(shipmentId) {
    return this.request('/courier/assign/awb', { method: 'POST', body: { shipment_id: shipmentId } })
  }

  trackShipment(shipmentId) {
    return this.request(`/courier/track/shipment/${shipmentId}`)
  }

  cancelOrders(orderIds) {
    return this.request('/orders/cancel', { method: 'POST', body: { ids: orderIds } })
  }

  async walletBalance() {
    const data = await this.request('/account/details/wallet-balance')
    return data?.data?.balance_amount ?? null
  }
}
