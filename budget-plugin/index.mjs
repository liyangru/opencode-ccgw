// OpenCode V2 Promise plugin. This is copied only to the gateway scratch
// location. Session metadata opts in explicitly, preserving native sessions.
export default {
  id: "ccgw-output-budget-v1",
  async setup(ctx) {
    await ctx.session.hook("context", async event => {
      const session = await ctx.session.get({ sessionID: event.sessionID })
      const config = session?.metadata?.ccgw
      if (config?.managed !== true || config.maxOutputTokens === undefined) return
      const requested = config.maxOutputTokens
      if (!Number.isSafeInteger(requested) || requested < 1) throw new Error("Invalid gateway output budget")
      const existing = event.options.maxTokens
      event.options.maxTokens = Number.isFinite(existing) && existing > 0 ? Math.min(existing, requested) : requested
    })
    // The gateway owns bounded retries and model fallback. Suppress the native
    // ten-retry loop only for gateway-managed throwaway sessions.
    await ctx.session.hook("retry", async event => {
      const session = await ctx.session.get({ sessionID: event.sessionID })
      if (session?.metadata?.ccgw?.managed === true) event.decision = { retry: false }
    })
  },
}
